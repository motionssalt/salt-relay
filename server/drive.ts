import https from 'https';
import http from 'http';

export interface DiscoveredMedia {
  url: string;
  source_type: 'direct' | 'drive';
  name: string;
  file_type?: 'image' | 'video' | 'unknown';
  mime_type?: string;
  accessible: boolean;
  error?: string;
}

export async function checkDirectLink(url: string): Promise<DiscoveredMedia> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request(url, { method: 'HEAD', headers: { 'User-Agent': 'SaltRelay-Validator/1.0' } }, (res) => {
        const contentType = res.headers['content-type'] || '';
        let fileType: 'image' | 'video' | 'unknown' = 'unknown';
        if (contentType.startsWith('image/')) fileType = 'image';
        if (contentType.startsWith('video/')) fileType = 'video';

        // Check common extension fallback if content-type is generic octet-stream
        const pathname = u.pathname.toLowerCase();
        if (fileType === 'unknown') {
          if (/\.(jpg|jpeg|png|webp|gif)$/.test(pathname)) fileType = 'image';
          if (/\.(mp4|mov|webm|m4v)$/.test(pathname)) fileType = 'video';
        }

        const accessible = res.statusCode ? (res.statusCode >= 200 && res.statusCode < 400) : false;
        resolve({
          url,
          source_type: 'direct',
          name: u.pathname.split('/').pop() || 'media_asset',
          file_type: fileType,
          mime_type: contentType,
          accessible,
          error: accessible ? undefined : `HTTP ${res.statusCode}`
        });
      });
      req.on('error', (e) => {
        resolve({
          url,
          source_type: 'direct',
          name: 'direct_media',
          file_type: 'unknown',
          accessible: false,
          error: e.message
        });
      });
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({
          url,
          source_type: 'direct',
          name: 'direct_media',
          file_type: 'unknown',
          accessible: false,
          error: 'Connection timed out'
        });
      });
      req.end();
    } catch (e: any) {
      resolve({
        url,
        source_type: 'direct',
        name: 'invalid_url',
        file_type: 'unknown',
        accessible: false,
        error: e.message
      });
    }
  });
}

export async function parseDriveFolder(folderUrl: string, apiKey?: string): Promise<{ success: boolean; files: DiscoveredMedia[]; error?: string }> {
  const match = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    return { success: false, files: [], error: 'Invalid Google Drive folder URL format' };
  }
  const folderId = match[1];

  // If Drive API key provided, attempt official Drive API v3
  if (apiKey) {
    try {
      const apiUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&key=${apiKey}&fields=files(id,name,mimeType,size)`;
      const resData = await new Promise<any>((resolve, reject) => {
        https.get(apiUrl, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve(JSON.parse(body || '{}')));
        }).on('error', reject);
      });

      if (resData.files && Array.isArray(resData.files)) {
        const files: DiscoveredMedia[] = resData.files.map((f: any) => {
          const isVideo = f.mimeType?.startsWith('video/');
          const isImage = f.mimeType?.startsWith('image/');
          return {
            url: `https://drive.google.com/uc?export=download&id=${f.id}`,
            source_type: 'drive',
            name: f.name || `file_${f.id}`,
            file_type: isVideo ? 'video' : (isImage ? 'image' : 'unknown'),
            mime_type: f.mimeType,
            accessible: true
          };
        });
        return { success: true, files };
      }
    } catch (e: any) {
      console.warn('Drive API fallback failed, falling back to public page scraper:', e.message);
    }
  }

  // Scrape public Drive folder page
  return new Promise((resolve) => {
    https.get(`https://drive.google.com/drive/folders/${folderId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const fileIds = new Set<string>();
        // Match patterns like /file/d/[id] or data-id="[id]" or id:[id]
        const fileRegex = /(?:file\/d\/|data-id="|\["id",")( [a-zA-Z0-9_-]{25,} )/g;
        const simpleRegex = /([a-zA-Z0-9_-]{28,33})/g;
        let m;
        while ((m = simpleRegex.exec(body)) !== null) {
          const candidate = m[1];
          if (candidate !== folderId && !candidate.startsWith('drive') && !candidate.includes('google')) {
            fileIds.add(candidate);
          }
        }

        const files: DiscoveredMedia[] = Array.from(fileIds).slice(0, 50).map((id, idx) => ({
          url: `https://drive.google.com/uc?export=download&id=${id}&confirm=t`,
          source_type: 'drive',
          name: `drive_asset_${idx + 1}`,
          file_type: 'unknown',
          accessible: true
        }));

        if (files.length === 0) {
          // If public folder is empty or protected
          resolve({
            success: true,
            files: [],
            error: 'No public files could be extracted. Ensure folder sharing is set to "Anyone with the link can view".'
          });
        } else {
          resolve({ success: true, files });
        }
      });
    }).on('error', (err) => {
      resolve({ success: false, files: [], error: err.message });
    });
  });
}
