/**
 * Salt Relay Media Processing Runner
 * Executes inside GitHub Actions:
 * 1. Downloads direct media URLs and expands public Google Drive folders
 * 2. Transcodes videos via FFmpeg and optimizes images
 * 3. Uploads assets to rotating GitHub Releases
 * 4. Sends signed callback webhook back to Salt Relay Worker
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
const REPO = process.env.GITHUB_REPOSITORY || 'motionssalt/salt-relay';
const JOB_ID = process.env.JOB_ID;
const MEDIA_JSON = process.env.MEDIA_JSON || '[]';
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
if (!CALLBACK_SECRET) {
  console.warn('Warning: CALLBACK_SECRET is not configured in process environment');
}

const WORK_DIR = path.join('/tmp', 'salt-relay', JOB_ID || 'test');
fs.mkdirSync(WORK_DIR, { recursive: true });

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
        // Match patterns like /file/d/[id] or data-id="[id]" or id:[id]
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

async function githubApi(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'SaltRelay-Actions',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(data && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {})
      }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(resp || '{}') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getOrCreateRelease() {
  const releasesRes = await githubApi(`/repos/${REPO}/releases?per_page=20`);
  const releases = Array.isArray(releasesRes.data) ? releasesRes.data : [];
  
  // Find current active release starting with media-
  let currentRelease = releases.find(r => r.tag_name && r.tag_name.startsWith('media-'));
  if (!currentRelease) {
    const create = await githubApi(`/repos/${REPO}/releases`, 'POST', {
      tag_name: 'media-001',
      name: 'Salt Relay Temporary Media Storage — media-001',
      body: 'Automated media storage release for Salt Relay.',
      draft: false,
      prerelease: true
    });
    currentRelease = create.data;
  } else if ((currentRelease.assets || []).length >= 50) {
    // Rotate to next tag
    const num = parseInt(currentRelease.tag_name.replace('media-', ''), 10) || 1;
    const nextTag = `media-${String(num + 1).padStart(3, '0')}`;
    const create = await githubApi(`/repos/${REPO}/releases`, 'POST', {
      tag_name: nextTag,
      name: `Salt Relay Temporary Media Storage — ${nextTag}`,
      body: 'Automated media storage release for Salt Relay.',
      draft: false,
      prerelease: true
    });
    currentRelease = create.data;
  }
  
  return currentRelease;
}

async function uploadReleaseAsset(uploadUrlTemplate, filePath, fileName) {
  const uploadUrl = uploadUrlTemplate.split('{')[0] + `?name=${encodeURIComponent(fileName)}`;
  const u = new URL(uploadUrl);
  const fileData = fs.readFileSync(filePath);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'SaltRelay-Actions',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileData.length
      }
    }, res => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(resp));
        } catch (e) {
          resolve({ error: resp });
        }
      });
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}

async function sendCallback(payload) {
  if (!CALLBACK_URL) {
    console.log('No CALLBACK_URL provided, skipping webhook.');
    return;
  }
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', CALLBACK_SECRET).update(body).digest('hex');
  const u = new URL(CALLBACK_URL);
  const client = u.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Callback-Signature': signature,
        'User-Agent': 'SaltRelay-WebhookClient/1.0'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`Callback sent, status: ${res.statusCode}`);
        resolve({ status: res.statusCode, data: d });
      });
    });
    req.on('error', (e) => {
      console.error('Callback error:', e.message);
      resolve({ error: e.message });
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`Starting media processing for Job: ${JOB_ID}`);
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
      console.log(`Expanding Google Drive public folder: ${url}`);
      const driveFiles = await scrapeDriveFolder(url);
      console.log(`Found ${driveFiles.length} files in Drive folder.`);
      mediaSources.push(...driveFiles);
    } else if (url.includes('drive.google.com/file/d/')) {
      const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      const fileId = match ? match[1] : null;
      if (fileId) {
        console.log(`Expanding Google Drive single file: ${fileId}`);
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
  console.log(`Target release: ${release.tag_name} (${release.id})`);

  const processedMedia = [];

  for (let i = 0; i < mediaSources.length; i++) {
    const src = mediaSources[i];
    const rawDest = path.join(WORK_DIR, `raw_${i}_${src.name}`);
    try {
      console.log(`Downloading asset ${i + 1}/${mediaSources.length}: ${src.url}`);
      await downloadFile(src.url, rawDest);

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

        console.log(`Transcoding video via FFmpeg to ${finalFileName}...`);
        // Normalize video: H.264 high profile, AAC 128k audio, faststart, max 1080p
        execSync(`ffmpeg -y -i "${rawDest}" -c:v libx264 -preset fast -crf 22 -vf "scale='min(1080,iw)':-2" -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "${processedFile}"`, { stdio: 'inherit' });
      } else {
        fileType = 'image';
        mimeType = 'image/jpeg';
        finalFileName = `${JOB_ID}_image_${i}.jpg`;
        processedFile = path.join(WORK_DIR, finalFileName);

        console.log(`Optimizing image via FFmpeg to ${finalFileName}...`);
        execSync(`ffmpeg -y -i "${rawDest}" -q:v 2 "${processedFile}"`, { stdio: 'inherit' });
      }

      const stat = fs.statSync(processedFile);
      console.log(`Uploading ${finalFileName} (${stat.size} bytes) to GitHub Release...`);
      const asset = await uploadReleaseAsset(release.upload_url, processedFile, finalFileName);

      const downloadUrl = `https://github.com/${REPO}/releases/download/${release.tag_name}/${encodeURIComponent(finalFileName)}`;

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
        asset_name: finalFileName,
        asset_download_url: downloadUrl,
        status: 'processed'
      });
    } catch (err) {
      console.error(`Error processing media item ${i}:`, err.message);
      processedMedia.push({
        source_url: src.url,
        source_type: src.source_type,
        file_type: 'unknown',
        status: 'failed',
        error: err.message
      });
    }
  }

  const resultPayload = {
    job_id: JOB_ID,
    release_tag: release.tag_name,
    processed_count: processedMedia.filter(m => m.status === 'processed').length,
    failed_count: processedMedia.filter(m => m.status === 'failed').length,
    media: processedMedia
  };

  console.log('Finished processing. Sending callback...');
  await sendCallback(resultPayload);
  console.log('Pipeline finished successfully.');
}

main().catch(err => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
