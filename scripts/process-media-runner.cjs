/**
 * Salt Relay Media Processing Runner
 * Executes inside GitHub Actions:
 * 1. Fails fast at startup if any required environment variable or source list is missing
 * 2. Expands public Google Drive folders (embeddedfolderview + folder fallback) and single Drive files, and downloads direct URLs
 * 3. Transcodes videos via FFmpeg (H.264 / AAC) and optimizes images
 * 4. Uploads assets to rotating GitHub Releases (media-001, media-002...) with API & size/SHA-256 verification
 * 5. Sends HMAC-SHA256 signed callback webhook to Salt Relay Worker with 5x exponential backoff (plus fatal failure callback)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// ENVIRONMENT & FAIL-FAST STARTUP VALIDATION (F1 & F5)
// -----------------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const REPO = process.env.GITHUB_REPOSITORY || 'motionssalt/salt-relay';
const JOB_ID = (process.env.JOB_ID || '').trim();
const MEDIA_JSON = process.env.MEDIA_JSON || '';
const CALLBACK_URL = (process.env.CALLBACK_URL || '').trim();
const CALLBACK_SECRET = (process.env.CALLBACK_SECRET || '').trim();
const ATTEMPT_NUMBER = parseInt(process.env.ATTEMPT_NUMBER || '1', 10) || 1;

console.log('=== Salt Relay Media Processing Pipeline ===');
console.log(`Repo: ${REPO}`);
console.log(`Job ID: ${JOB_ID || '(missing)'}`);
console.log(`Attempt: #${ATTEMPT_NUMBER}`);
console.log(`Callback URL: ${CALLBACK_URL || '(missing)'}`);
console.log(`Callback Secret Configured: ${CALLBACK_SECRET ? 'YES' : 'NO'}`);
console.log(`GitHub Token Configured: ${GITHUB_TOKEN ? 'YES' : 'NO'}`);

// Signed callback helper declared early so startup validation can also notify Worker
async function sendCallback(payload, maxAttempts = 5) {
  if (!CALLBACK_URL || !CALLBACK_SECRET) {
    console.error('[Callback] Missing CALLBACK_URL or CALLBACK_SECRET, cannot send callback.');
    return { error: 'Missing CALLBACK_URL or CALLBACK_SECRET' };
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
            'User-Agent': 'SaltRelay-WebhookClient/2.1'
          },
          timeout: 15000
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[Stage Success] Callback accepted with HTTP ${res.statusCode}: ${d.slice(0, 200)}`);
              resolve({ status: res.statusCode, data: d });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
            }
          });
        });
        req.on('timeout', () => {
          req.destroy(new Error('Callback request timed out after 15000ms'));
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

const missingEnv = [];
if (!JOB_ID) missingEnv.push('JOB_ID');
if (!CALLBACK_URL) missingEnv.push('CALLBACK_URL');
if (!CALLBACK_SECRET) missingEnv.push('CALLBACK_SECRET');
if (!GITHUB_TOKEN) missingEnv.push('GITHUB_TOKEN');
if (!MEDIA_JSON.trim()) missingEnv.push('MEDIA_JSON');

if (missingEnv.length > 0) {
  const errMsg = `Startup validation failed. Missing required environment variables: ${missingEnv.join(', ')}`;
  console.error(`[FATAL STARTUP ERROR] ${errMsg}`);
  if (JOB_ID && CALLBACK_URL && CALLBACK_SECRET) {
    sendCallback({
      job_id: JOB_ID,
      attempt: ATTEMPT_NUMBER,
      status: 'failed',
      stage: 'startup_validation',
      error: errMsg
    }).catch(e => console.error('Failed to send startup error callback:', e.message))
      .finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
}

let parsedInitialSources = [];
try {
  const parsed = JSON.parse(MEDIA_JSON);
  if (Array.isArray(parsed)) {
    parsedInitialSources = parsed
      .map(item => (typeof item === 'string' ? item.trim() : (item && item.url ? String(item.url).trim() : '')))
      .filter(Boolean);
  }
} catch (parseErr) {
  const errMsg = `Startup validation failed [stage: startup_validation, field: MEDIA_JSON]: Invalid JSON (${parseErr.message})`;
  console.error(`[FATAL STARTUP ERROR] ${errMsg}`);
  sendCallback({
    job_id: JOB_ID,
    attempt: ATTEMPT_NUMBER,
    status: 'failed',
    stage: 'startup_validation',
    error: errMsg
  }).catch(() => {}).finally(() => process.exit(1));
}

if (parsedInitialSources.length === 0) {
  const errMsg = 'Startup validation failed [stage: startup_validation, field: MEDIA_JSON]: No media source URLs were provided to the workflow.';
  console.error(`[FATAL STARTUP ERROR] ${errMsg}`);
  sendCallback({
    job_id: JOB_ID,
    attempt: ATTEMPT_NUMBER,
    status: 'failed',
    stage: 'startup_validation',
    error: errMsg
  }).catch(() => {}).finally(() => process.exit(1));
}

const WORK_DIR = path.join('/tmp', 'salt-relay', JOB_ID);
fs.mkdirSync(WORK_DIR, { recursive: true });

// -----------------------------------------------------------------------------
// HTTP & GOOGLE DRIVE HELPERS
// -----------------------------------------------------------------------------
function fetchTextWithRedirects(targetUrl, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error(`Too many redirects fetching ${targetUrl}`));
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 20000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, u).toString();
        return fetchTextWithRedirects(nextUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, finalUrl: targetUrl }));
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${targetUrl}`)));
    req.on('error', reject);
  });
}

async function downloadRawUrl(targetUrl, destPath, maxRedirects = 8) {
  if (maxRedirects < 0) throw new Error(`Too many redirects downloading ${targetUrl}`);
  const u = new URL(targetUrl);
  const client = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(u, {
      headers: { 'User-Agent': 'SaltRelay-Processor/2.1' },
      timeout: 120000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, u).toString();
        return downloadRawUrl(nextUrl, destPath, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve({ contentType: res.headers['content-type'] || '' }));
      });
      file.on('error', err => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Download timed out for ${targetUrl}`));
    });
    req.on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function downloadFile(url, destPath) {
  await downloadRawUrl(url, destPath);

  // Check if Google Drive returned an HTML virus-scan interstitial or sign-in page instead of media bytes
  const stat = fs.statSync(destPath);
  if (stat.size > 0 && stat.size < 256 * 1024) {
    const headBuf = Buffer.alloc(Math.min(4096, stat.size));
    const fd = fs.openSync(destPath, 'r');
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    fs.closeSync(fd);
    const headStr = headBuf.toString('utf8').trimStart();

    if (/^(<!doctype html|<html)/i.test(headStr)) {
      const fullHtml = fs.readFileSync(destPath, 'utf8');
      const idMatch = fullHtml.match(/name="id"\s+value="([^"]+)"/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      const uuidMatch = fullHtml.match(/name="uuid"\s+value="([^"]+)"/);
      if (idMatch && uuidMatch) {
        const confirmUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(idMatch[1])}&export=download&confirm=t&uuid=${encodeURIComponent(uuidMatch[1])}`;
        console.log('[Download] Handling Google Drive large-file confirmation token...');
        await downloadRawUrl(confirmUrl, destPath);
      } else {
        throw new Error(`Source URL '${url}' returned an HTML page instead of a media file (ensure the link is direct or Google Drive sharing is set to 'Anyone with the link').`);
      }
    }
  }
  return destPath;
}

function extractDriveFolderId(folderUrl) {
  const m = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/) || folderUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function extractDriveFileId(fileUrl) {
  const m = fileUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || fileUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Expand public Google Drive folder via static embeddedfolderview first, then folder HTML fallback
async function scrapeDriveFolder(folderUrl) {
  const folderId = extractDriveFolderId(folderUrl);
  if (!folderId) {
    throw new Error(`Invalid Google Drive folder URL '${folderUrl}': missing folder ID.`);
  }

  const fileIds = new Set();

  // Primary: embeddedfolderview renders clean static HTML links for public folders
  try {
    const embedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
    const embedRes = await fetchTextWithRedirects(embedUrl);
    if (embedRes.status === 200 && embedRes.body) {
      if (embedRes.body.includes('accounts.google.com/ServiceLogin')) {
        throw new Error(`Google Drive folder '${folderUrl}' is private (redirects to Google Sign-In). Set sharing to 'Anyone with the link'.`);
      }
      const entryRegex = /(?:\/file\/d\/|id="entry-)([a-zA-Z0-9_-]{20,})/g;
      let m;
      while ((m = entryRegex.exec(embedRes.body)) !== null) {
        if (m[1] !== folderId) fileIds.add(m[1]);
      }
    }
  } catch (err) {
    if (err.message.includes('private')) throw err;
    console.warn(`[Source] embeddedfolderview lookup warning for ${folderId}: ${err.message}`);
  }

  // Fallback: main Drive folder page
  if (fileIds.size === 0) {
    const folderRes = await fetchTextWithRedirects(`https://drive.google.com/drive/folders/${folderId}`);
    if (folderRes.status === 404) {
      throw new Error(`Google Drive folder '${folderUrl}' returned HTTP 404 (not found).`);
    }
    if (folderRes.status === 401 || folderRes.status === 403 || folderRes.body.includes('accounts.google.com/ServiceLogin')) {
      throw new Error(`Google Drive folder '${folderUrl}' is not publicly accessible (HTTP ${folderRes.status}). Set sharing to 'Anyone with the link'.`);
    }
    const regexes = [
      /(?:\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,45})/g,
      /\["([a-zA-Z0-9_-]{28,36})",\["/g
    ];
    for (const rx of regexes) {
      let m;
      while ((m = rx.exec(folderRes.body)) !== null) {
        const candidate = m[1];
        if (candidate !== folderId && !candidate.startsWith('drive') && !candidate.includes('google')) {
          fileIds.add(candidate);
        }
      }
    }
  }

  return Array.from(fileIds).slice(0, 50).map((id, idx) => ({
    name: `drive_${id.slice(0, 10)}_${idx + 1}`,
    url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    original_source_url: folderUrl,
    source_type: 'drive'
  }));
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
        'User-Agent': 'SaltRelay-Actions/2.1',
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
        } catch {
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

  const mediaReleases = releases
    .filter(r => r.tag_name && /^media-\d+$/.test(r.tag_name))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name));

  let currentRelease = mediaReleases[0];
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

  console.log(`[Stage Success] Active release confirmed: ${currentRelease.tag_name} (ID: ${currentRelease.id})`);
  return currentRelease;
}

async function uploadReleaseAsset(uploadUrlTemplate, filePath, fileName, releaseId) {
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
  const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');

  console.log(`[Release] Uploading ${fileName} (${fileSize} bytes, sha256=${sha256.slice(0, 12)}...) to GitHub Releases...`);

  const uploadResult = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'SaltRelay-Actions/2.1',
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
  console.log(`[Release] Upload HTTP 201 confirmed. Asset ID: ${asset.id}, Name: ${asset.name}, Size: ${asset.size} bytes`);

  const verifyRes = await githubApi(`/repos/${REPO}/releases/assets/${asset.id}`);
  if (verifyRes.status !== 200 || !verifyRes.data || !verifyRes.data.id) {
    throw new Error(`Verification of uploaded asset ID ${asset.id} failed (HTTP ${verifyRes.status})`);
  }
  if (Number(verifyRes.data.size) !== fileSize) {
    throw new Error(`Uploaded asset size mismatch: local=${fileSize} vs remote=${verifyRes.data.size}`);
  }
  console.log(`[Stage Success] Confirmed asset present on release via API. Asset ID: ${verifyRes.data.id}, Size: ${verifyRes.data.size}, Download URL: ${verifyRes.data.browser_download_url}`);

  return { asset: verifyRes.data, sha256 };
}

function detectIsVideo(probe) {
  const streams = probe.streams || [];
  const formatName = String(probe.format?.format_name || '').toLowerCase();
  if (formatName.includes('image2') || formatName.endsWith('_pipe')) {
    return false;
  }
  const hasAudio = streams.some(s => s.codec_type === 'audio');
  if (hasAudio) return true;

  const videoStream = streams.find(s => s.codec_type === 'video');
  if (!videoStream) return false;

  const stillCodecs = new Set(['mjpeg', 'png', 'webp', 'bmp', 'tiff', 'ppm']);
  const codec = String(videoStream.codec_name || '').toLowerCase();
  if (!stillCodecs.has(codec)) {
    return true;
  }
  const dur = parseFloat(videoStream.duration || probe.format?.duration || '0');
  const frames = parseInt(videoStream.nb_frames || '0', 10);
  return dur > 0.5 || frames > 1;
}

// -----------------------------------------------------------------------------
// MAIN EXECUTION PIPELINE
// -----------------------------------------------------------------------------
async function main() {
  console.log(`[Pipeline] Starting media processing for Job: ${JOB_ID} (Attempt #${ATTEMPT_NUMBER}) with ${parsedInitialSources.length} submitted source link(s).`);

  const mediaSources = [];
  const expansionErrors = [];

  for (const url of parsedInitialSources) {
    try {
      if (url.includes('drive.google.com/drive/folders/')) {
        console.log(`[Source] Expanding Google Drive public folder: ${url}`);
        const driveFiles = await scrapeDriveFolder(url);
        console.log(`[Stage Success] Discovered ${driveFiles.length} file(s) in Google Drive folder: ${url}`);
        if (driveFiles.length === 0) {
          expansionErrors.push(`Google Drive folder '${url}' contained 0 discoverable public media files.`);
        } else {
          mediaSources.push(...driveFiles);
        }
      } else if (url.includes('drive.google.com/file/d/') || url.includes('drive.google.com/uc') || url.includes('drive.usercontent.google.com')) {
        const fileId = extractDriveFileId(url);
        if (!fileId) {
          throw new Error(`Could not extract file ID from Google Drive link '${url}'`);
        }
        console.log(`[Source] Expanding Google Drive single file: ${fileId}`);
        mediaSources.push({
          url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
          original_source_url: url,
          source_type: 'drive',
          name: `drive_${fileId}`
        });
      } else {
        const cleanBase = path.basename(url.split('?')[0]).replace(/[^a-zA-Z0-9._-]/g, '_') || 'media_asset';
        mediaSources.push({
          url,
          original_source_url: url,
          source_type: 'direct',
          name: cleanBase
        });
      }
    } catch (srcErr) {
      console.error(`[Source Error] Failed expanding source '${url}': ${srcErr.message}`);
      expansionErrors.push(`Source '${url}': ${srcErr.message}`);
    }
  }

  if (mediaSources.length === 0) {
    throw new Error(`Stage [source_expansion]: No downloadable media files found across ${parsedInitialSources.length} source link(s). ${expansionErrors.join(' | ')}`);
  }

  const release = await getOrCreateRelease();
  const processedMedia = [];

  for (let i = 0; i < mediaSources.length; i++) {
    const src = mediaSources[i];
    const safeName = String(src.name || `item_${i}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const rawDest = path.join(WORK_DIR, `raw_${i}_${safeName}`);
    try {
      console.log(`[Download] Downloading asset ${i + 1}/${mediaSources.length}: ${src.url}`);
      await downloadFile(src.url, rawDest);
      const rawStat = fs.statSync(rawDest);
      console.log(`[Stage Success] Download completed for asset ${i + 1} (${rawStat.size} bytes).`);

      let probe;
      try {
        const probeOut = execSync(`ffprobe -v quiet -print_format json -show_format -show_streams "${rawDest}"`, { encoding: 'utf8' });
        probe = JSON.parse(probeOut);
      } catch (e) {
        throw new Error(`Media probe failed for '${src.original_source_url || src.url}': ${e.message}`);
      }

      const isVideo = detectIsVideo(probe);
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
        execSync(
          `ffmpeg -y -i "${rawDest}" -c:v libx264 -preset fast -crf 22 -vf "scale='min(1080,iw)':-2" -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "${processedFile}"`,
          { stdio: 'inherit' }
        );
        console.log(`[Stage Success] Video transcoding completed for ${finalFileName}.`);
      } else {
        fileType = 'image';
        mimeType = 'image/jpeg';
        finalFileName = `${JOB_ID}_image_${i}.jpg`;
        processedFile = path.join(WORK_DIR, finalFileName);

        console.log(`[Optimize] Optimizing image via FFmpeg to ${finalFileName}...`);
        execSync(`ffmpeg -y -i "${rawDest}" -frames:v 1 -q:v 2 "${processedFile}"`, { stdio: 'inherit' });
        console.log(`[Stage Success] Image optimization completed for ${finalFileName}.`);
      }

      const stat = fs.statSync(processedFile);
      const { asset, sha256 } = await uploadReleaseAsset(release.upload_url, processedFile, finalFileName, release.id);
      const downloadUrl = asset.browser_download_url || `https://github.com/${REPO}/releases/download/${release.tag_name}/${encodeURIComponent(finalFileName)}`;

      processedMedia.push({
        source_url: src.original_source_url || src.url,
        source_type: src.source_type,
        file_type: fileType,
        mime_type: mimeType,
        filename: finalFileName,
        file_size: stat.size,
        sha256,
        width,
        height,
        duration_sec: duration,
        release_tag: release.tag_name,
        asset_id: String(asset.id),
        asset_name: finalFileName,
        asset_download_url: downloadUrl,
        status: 'processed'
      });
      console.log(`[Stage Success] Asset ${i + 1}/${mediaSources.length} processed, uploaded, and verified on release ${release.tag_name}.`);
    } catch (err) {
      console.error(`[Stage Error] Error processing media item ${i + 1} (${src.original_source_url || src.url}):`, err.message);
      processedMedia.push({
        source_url: src.original_source_url || src.url,
        source_type: src.source_type,
        file_type: 'unknown',
        status: 'failed',
        error: `Stage [media_processing] source '${src.original_source_url || src.url}': ${err.message}`
      });
    }
  }

  const processedCount = processedMedia.filter(m => m.status === 'processed').length;
  const failedItems = processedMedia.filter(m => m.status === 'failed');
  const failedCount = failedItems.length;

  const resultPayload = {
    job_id: JOB_ID,
    attempt: ATTEMPT_NUMBER,
    status: processedCount > 0 ? 'success' : 'failed',
    stage: processedCount > 0 ? 'transcoded' : 'media_processing',
    release_tag: release.tag_name,
    processed_count: processedCount,
    failed_count: failedCount,
    media: processedMedia,
    error: processedCount === 0 && failedCount > 0
      ? failedItems.map(f => f.error).join(' | ')
      : null
  };

  console.log(`[Pipeline] Finished processing. Processed: ${processedCount}, Failed: ${failedCount}. Sending signed callback...`);
  await sendCallback(resultPayload);
  console.log('[Pipeline Success] Pipeline finished successfully and signed callback delivered.');

  if (processedCount === 0) {
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// CATCH-ALL ERROR HANDLER WITH BEST-EFFORT FAILURE CALLBACK (F1)
// -----------------------------------------------------------------------------
main().catch(async (err) => {
  console.error('[FATAL PIPELINE ERROR]', err.message || err);
  if (JOB_ID && CALLBACK_URL && CALLBACK_SECRET) {
    console.log('[FATAL PIPELINE ERROR] Sending failure callback to Worker...');
    try {
      await sendCallback({
        job_id: JOB_ID,
        attempt: ATTEMPT_NUMBER,
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
