/**
 * Salt Relay Media Processing Runner
 * Executes inside GitHub Actions:
 * 1. Downloads direct media URLs and expands public Google Drive folders
 * 2. Transcodes videos via FFmpeg (H.264 / AAC) and optimizes images
 * 3. Uploads assets to rotating GitHub Releases (media-001, media-002...) with verification
 * 4. Sends signed callback webhook back to Salt Relay Worker with exponential backoff
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// ENVIRONMENT & FAIL-FAST VALIDATION (F1)
// -----------------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const REPO = process.env.GITHUB_REPOSITORY || 'motionssalt/salt-relay';
const JOB_ID = process.env.JOB_ID;
const MEDIA_JSON = process.env.MEDIA_JSON || '[]';
const CALLBACK_URL = process.env.CALLBACK_URL;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;

console.log('=== Salt Relay Media Processing Pipeline ===');
console.log(`Repo: ${REPO}`);
console.log(`Job ID: ${JOB_ID || '(missing)'}`);
console.log(`Callback URL: ${CALLBACK_URL || '(missing)'}`);
console.log(`Callback Secret Configured: ${CALLBACK_SECRET ? 'YES' : 'NO'}`);
console.log(`GitHub Token Configured: ${GITHUB_TOKEN ? 'YES' : 'NO'}`);

// Validate required environment variables at startup before performing work
const missingEnv = [];
if (!JOB_ID) missingEnv.push('JOB_ID');
if (!CALLBACK_URL) missingEnv.push('CALLBACK_URL');
if (!CALLBACK_SECRET) missingEnv.push('CALLBACK_SECRET');
if (!GITHUB_TOKEN) missingEnv.push('GITHUB_TOKEN');

if (missingEnv.length > 0) {
  const errMsg = `Startup validation failed. Missing required environment variables: ${missingEnv.join(', ')}`;
  console.error(`[FATAL STARTUP ERROR] ${errMsg}`);
  if (JOB_ID && CALLBACK_URL && CALLBACK_SECRET) {
    sendCallback({
      job_id: JOB_ID,
      status: 'failed',
      stage: 'startup_validation',
      error: errMsg
    }).catch(e => console.error('Failed to send startup error callback:', e.message))
      .finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
}

const WORK_DIR = path.join('/tmp', 'salt-relay', JOB_ID);
fs.mkdirSync(WORK_DIR, { recursive: true });

// -----------------------------------------------------------------------------
// DOWNLOAD HELPERS
// -----------------------------------------------------------------------------
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'SaltRelay-Processor/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// Scrape public Google Drive folder page to extract downloadable file links
async function scrapeDriveFolder(folderUrl) {
  const match = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) return [];
  const folderId = match[1];

  return new Promise((resolve) => {
    https.get(`https://drive.google.com/drive/folders/${folderId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const fileIds = new Set();
        const fileMatchRegex = /(?:file\/d\/|id=)([a-zA-Z0-9_-]{25,})/g;
        let m;
        while ((m = fileMatchRegex.exec(body)) !== null) {
          if (m[1] !== folderId) fileIds.add(m[1]);
        }

        const files = Array.from(fileIds).map((id, idx) => ({
          name: `drive_file_${idx + 1}`,
          url: `https://drive.google.com/uc?export=download&id=${id}&confirm=t`,
          source_type: 'drive'
        }));
        resolve(files);
      });
    }).on('error', () => resolve([]));
  });
}

// -----------------------------------------------------------------------------
// GITHUB RELEASES API HELPERS
// -----------------------------------------------------------------------------
async function githubApi(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'SaltRelay-Actions/2.0',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(data && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {})
      }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(resp || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode, data: resp });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getOrCreateRelease() {
  console.log(`[Release] Listing releases in ${REPO}...`);
  const releasesRes = await githubApi(`/repos/${REPO}/releases?per_page=20`);
  if (releasesRes.status !== 200) {
    throw new Error(`Failed to list releases (HTTP ${releasesRes.status}): ${JSON.stringify(releasesRes.data)}`);
  }
  const releases = Array.isArray(releasesRes.data) ? releasesRes.data : [];

  let currentRelease = releases.find(r => r.tag_name && r.tag_name.startsWith('media-'));
  if (!currentRelease) {
    console.log('[Release] No media-* release found. Creating media-001...');
    const create = await githubApi(`/repos/${REPO}/releases`, 'POST', {
      tag_name: 'media-001',
      name: 'Salt Relay Temporary Media Storage — media-001',
      body: 'Automated media storage release for Salt Relay.',
      draft: false,
      prerelease: true
    });
    if (create.status !== 201) {
      throw new Error(`Failed to create release media-001 (HTTP ${create.status}): ${JSON.stringify(create.data)}`);
    }
    currentRelease = create.data;
  } else if ((currentRelease.assets || []).length >= 50) {
    const num = parseInt(currentRelease.tag_name.replace('media-', ''), 10) || 1;
    const nextTag = `media-${String(num + 1).padStart(3, '0')}`;
    console.log(`[Release] Release ${currentRelease.tag_name} has reached 50 assets. Rotating to ${nextTag}...`);
    const create = await githubApi(`/repos/${REPO}/releases`, 'POST', {
      tag_name: nextTag,
      name: `Salt Relay Temporary Media Storage — ${nextTag}`,
      body: 'Automated media storage release for Salt Relay.',
      draft: false,
      prerelease: true
    });
    if (create.status !== 201) {
      throw new Error(`Failed to rotate to release ${nextTag} (HTTP ${create.status}): ${JSON.stringify(create.data)}`);
    }
    currentRelease = create.data;
  }

  console.log(`[Release] Active release confirmed: ${currentRelease.tag_name} (ID: ${currentRelease.id})`);
  return currentRelease;
}

async function uploadReleaseAsset(uploadUrlTemplate, filePath, fileName, releaseId) {
  // If an asset with the same name already exists on this release, delete it first to avoid 422 conflict
  try {
    const existingAssetsRes = await githubApi(`/repos/${REPO}/releases/${releaseId}/assets`);
    if (Array.isArray(existingAssetsRes.data)) {
      const match = existingAssetsRes.data.find(a => a.name === fileName);
      if (match) {
        console.log(`[Release] Removing previous existing asset ${fileName} (ID: ${match.id}) to allow clean overwrite...`);
        await githubApi(`/repos/${REPO}/releases/assets/${match.id}`, 'DELETE');
      }
    }
  } catch (cleanErr) {
    console.warn(`[Release] Pre-upload asset check warning: ${cleanErr.message}`);
  }

  const uploadUrl = uploadUrlTemplate.split('{')[0] + `?name=${encodeURIComponent(fileName)}`;
  const u = new URL(uploadUrl);
  const fileData = fs.readFileSync(filePath);
  const fileSize = fileData.length;

  console.log(`[Release] Uploading ${fileName} (${fileSize} bytes) to GitHub Releases...`);

  const uploadResult = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'SaltRelay-Actions/2.0',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize
      }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(resp);
        } catch {
          parsed = { raw: resp };
        }

        if (res.statusCode === 201) {
          resolve({ status: res.statusCode, asset: parsed });
        } else {
          reject(new Error(`GitHub Release upload failed with HTTP ${res.statusCode}: ${resp.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });

  const asset = uploadResult.asset;
  console.log(`[Release] Asset uploaded successfully. Asset ID: ${asset.id}, Name: ${asset.name}, Size: ${asset.size} bytes`);

  // Verify asset presence and size via GitHub API
  const verifyRes = await githubApi(`/repos/${REPO}/releases/assets/${asset.id}`);
  if (verifyRes.status !== 200 || !verifyRes.data.id) {
    throw new Error(`Verification of uploaded asset ID ${asset.id} failed (HTTP ${verifyRes.status})`);
  }
  console.log(`[Release] Confirmed asset exists on release. Browser download URL: ${verifyRes.data.browser_download_url}`);

  return verifyRes.data;
}

// -----------------------------------------------------------------------------
// SIGNED CALLBACK WITH EXPONENTIAL BACKOFF (F1)
// -----------------------------------------------------------------------------
async function sendCallback(payload, maxAttempts = 5) {
  if (!CALLBACK_URL) {
    console.error('[Callback] No CALLBACK_URL provided, skipping callback.');
    return { error: 'No CALLBACK_URL' };
  }
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', CALLBACK_SECRET).update(body).digest('hex');
  const u = new URL(CALLBACK_URL);
  const client = u.protocol === 'https:' ? https : http;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Callback] Sending callback (attempt ${attempt}/${maxAttempts}) to ${u.origin}${u.pathname}...`);
      const result = await new Promise((resolve, reject) => {
        const req = client.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Callback-Signature': signature,
            'User-Agent': 'SaltRelay-WebhookClient/2.0'
          },
          timeout: 15000
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[Callback] Webhook accepted with HTTP ${res.statusCode}: ${d.slice(0, 200)}`);
              resolve({ status: res.statusCode, data: d });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
            }
          });
        });
        req.on('timeout', () => {
          req.destroy(new Error('Request timed out after 15000ms'));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      return result;
    } catch (err) {
      console.warn(`[Callback] Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`[Callback] Retrying callback in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[Callback] All ${maxAttempts} attempts to send callback failed.`);
        throw new Error(`Failed to deliver callback after ${maxAttempts} attempts: ${err.message}`);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION PIPELINE
// -----------------------------------------------------------------------------
async function main() {
  console.log(`[Pipeline] Starting media processing for Job: ${JOB_ID}`);
  let rawItems = [];
  try {
    rawItems = JSON.parse(MEDIA_JSON);
  } catch (e) {
    console.error('Invalid MEDIA_JSON:', e.message);
  }

  // Expand sources
  const mediaSources = [];
  for (const item of rawItems) {
    const url = typeof item === 'string' ? item : item.url;
    if (url.includes('drive.google.com/drive/folders/')) {
      console.log(`[Source] Expanding Google Drive public folder: ${url}`);
      const driveFiles = await scrapeDriveFolder(url);
      console.log(`[Source] Found ${driveFiles.length} files in Drive folder.`);
      mediaSources.push(...driveFiles);
    } else if (url.includes('drive.google.com/file/d/')) {
      const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      const fileId = match ? match[1] : null;
      if (fileId) {
        console.log(`[Source] Expanding Google Drive single file: ${fileId}`);
        mediaSources.push({
          url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`,
          source_type: 'drive',
          name: `drive_${fileId}.mp4`
        });
      }
    } else {
      mediaSources.push({
        url,
        source_type: 'direct',
        name: path.basename(url.split('?')[0]) || 'media_asset'
      });
    }
  }

  const release = await getOrCreateRelease();

  const processedMedia = [];

  for (let i = 0; i < mediaSources.length; i++) {
    const src = mediaSources[i];
    const rawDest = path.join(WORK_DIR, `raw_${i}_${src.name}`);
    try {
      console.log(`[Download] Downloading asset ${i + 1}/${mediaSources.length}: ${src.url}`);
      await downloadFile(src.url, rawDest);
      console.log(`[Download] Download completed for asset ${i + 1}.`);

      // Probe media info
      let probe;
      try {
        const probeOut = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${rawDest}"`, { encoding: 'utf8' });
        probe = JSON.parse(probeOut);
      } catch (e) {
        throw new Error(`Media probe failed: ${e.message}`);
      }

      const isVideo = (probe.streams || []).some(s => s.codec_type === 'video' && s.duration > 0);
      const videoStream = (probe.streams || []).find(s => s.codec_type === 'video');
      const width = videoStream ? videoStream.width : null;
      const height = videoStream ? videoStream.height : null;
      const duration = probe.format?.duration ? parseFloat(probe.format.duration) : null;

      let processedFile;
      let finalFileName;
      let fileType;
      let mimeType;

      if (isVideo) {
        fileType = 'video';
        mimeType = 'video/mp4';
        finalFileName = `${JOB_ID}_video_${i}.mp4`;
        processedFile = path.join(WORK_DIR, finalFileName);

        console.log(`[Transcode] Transcoding video via FFmpeg to ${finalFileName}...`);
        execSync(`ffmpeg -y -i "${rawDest}" -c:v libx264 -preset fast -crf 22 -vf "scale='min(1080,iw)':-2" -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "${processedFile}"`, { stdio: 'inherit' });
        console.log(`[Transcode] Video transcoding completed for ${finalFileName}.`);
      } else {
        fileType = 'image';
        mimeType = 'image/jpeg';
        finalFileName = `${JOB_ID}_image_${i}.jpg`;
        processedFile = path.join(WORK_DIR, finalFileName);

        console.log(`[Optimize] Optimizing image via FFmpeg to ${finalFileName}...`);
        execSync(`ffmpeg -y -i "${rawDest}" -q:v 2 "${processedFile}"`, { stdio: 'inherit' });
        console.log(`[Optimize] Image optimization completed for ${finalFileName}.`);
      }

      const stat = fs.statSync(processedFile);
      const asset = await uploadReleaseAsset(release.upload_url, processedFile, finalFileName, release.id);

      const downloadUrl = asset.browser_download_url || `https://github.com/${REPO}/releases/download/${release.tag_name}/${encodeURIComponent(finalFileName)}`;

      processedMedia.push({
        source_url: src.url,
        source_type: src.source_type,
        file_type: fileType,
        mime_type: mimeType,
        filename: finalFileName,
        file_size: stat.size,
        width,
        height,
        duration_sec: duration,
        release_tag: release.tag_name,
        asset_id: asset.id,
        asset_name: finalFileName,
        asset_download_url: downloadUrl,
        status: 'processed'
      });
      console.log(`[Stage Success] Asset ${i + 1}/${mediaSources.length} processed and verified on release.`);
    } catch (err) {
      console.error(`[Stage Error] Error processing media item ${i}:`, err.message);
      processedMedia.push({
        source_url: src.url,
        source_type: src.source_type,
        file_type: 'unknown',
        status: 'failed',
        error: err.message
      });
    }
  }

  const processedCount = processedMedia.filter(m => m.status === 'processed').length;
  const failedCount = processedMedia.filter(m => m.status === 'failed').length;

  const resultPayload = {
    job_id: JOB_ID,
    status: processedCount > 0 ? 'success' : 'failed',
    release_tag: release.tag_name,
    processed_count: processedCount,
    failed_count: failedCount,
    media: processedMedia,
    error: processedCount === 0 && failedCount > 0 ? 'All media items failed processing' : null
  };

  console.log(`[Pipeline] Finished processing. Total processed: ${processedCount}, Failed: ${failedCount}. Sending signed callback...`);
  await sendCallback(resultPayload);
  console.log('[Pipeline Success] Pipeline finished successfully and callback delivered.');
}

// -----------------------------------------------------------------------------
// CATCH-ALL ERROR HANDLER WITH FAILURE CALLBACK (F1)
// -----------------------------------------------------------------------------
main().catch(async (err) => {
  console.error('[FATAL PIPELINE ERROR]', err.message || err);
  if (JOB_ID && CALLBACK_URL && CALLBACK_SECRET) {
    console.log('[FATAL PIPELINE ERROR] Sending failure callback to Worker...');
    try {
      await sendCallback({
        job_id: JOB_ID,
        status: 'failed',
        stage: 'pipeline_fatal_error',
        error: err.message || String(err)
      });
      console.log('[FATAL PIPELINE ERROR] Failure callback sent successfully.');
    } catch (cbErr) {
      console.error('[FATAL PIPELINE ERROR] Failed to send failure callback:', cbErr.message);
    }
  }
  process.exit(1);
});
