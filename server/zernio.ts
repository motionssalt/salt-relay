import https from 'https';

const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

export interface ZernioAccount {
  id: string;
  platform: string; // 'tiktok' | 'youtube' | 'threads' | 'instagram' | 'twitter' | 'telegram' | 'pinterest'
  name: string;
  username: string;
  avatar_url?: string;
  is_active?: boolean;
}

export interface PublishResult {
  success: boolean;
  external_post_id?: string;
  external_post_url?: string;
  error?: string;
  raw_response?: any;
}

export async function fetchZernioAccounts(apiKey: string): Promise<{ success: boolean; accounts: ZernioAccount[]; error?: string }> {
  return new Promise((resolve) => {
    const req = https.request(`${ZERNIO_BASE_URL}/accounts`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'User-Agent': 'SaltRelay-Publisher/1.0',
        'Accept': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            const rawList = Array.isArray(data) ? data : (data.accounts || data.data || []);
            const accounts: ZernioAccount[] = rawList.map((item: any) => ({
              id: item.id || item.accountId || item.account_id || String(item._id || Math.random()),
              platform: (item.platform || item.network || 'unknown').toLowerCase(),
              name: item.name || item.displayName || item.username || 'Social Account',
              username: item.username || item.handle || item.name || '',
              avatar_url: item.avatarUrl || item.avatar_url || item.picture || item.profileImage || null
            }));
            resolve({ success: true, accounts });
          } else {
            resolve({
              success: false,
              accounts: [],
              error: data.message || data.error || `HTTP ${res.statusCode}: Zernio accounts fetch failed`
            });
          }
        } catch (e: any) {
          resolve({ success: false, accounts: [], error: `Invalid JSON from Zernio: ${e.message}` });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, accounts: [], error: err.message });
    });

    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ success: false, accounts: [], error: 'Zernio API request timed out' });
    });

    req.end();
  });
}

export async function publishToZernio(apiKey: string, payload: {
  content: string;
  mediaItems?: Array<{ url: string; type: 'video' | 'image' }>;
  mediaUrls?: string[];
  platforms: Array<{ platform: string; accountId: string }>;
  publishNow?: boolean;
  scheduledAt?: string;
  story?: boolean;
}): Promise<PublishResult> {
  return new Promise((resolve) => {
    // Ensure media items format complies with Zernio API specs
    const normalizedPayload: any = {
      content: payload.content,
      platforms: payload.platforms,
      publishNow: payload.publishNow ?? true,
      story: payload.story ?? false
    };

    if (payload.scheduledAt) {
      normalizedPayload.scheduledAt = payload.scheduledAt;
    }

    if (payload.mediaItems && payload.mediaItems.length > 0) {
      normalizedPayload.mediaItems = payload.mediaItems;
    } else if (payload.mediaUrls && payload.mediaUrls.length > 0) {
      normalizedPayload.mediaItems = payload.mediaUrls.map(u => ({
        url: u,
        type: /\.(mp4|mov|webm)$/i.test(u) ? 'video' : 'image'
      }));
    }

    const bodyData = JSON.stringify(normalizedPayload);
    const req = https.request(`${ZERNIO_BASE_URL}/posts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyData),
        'User-Agent': 'SaltRelay-Publisher/1.0',
        'Accept': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body || '{}');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              success: true,
              external_post_id: json.id || json.postId || json.data?.id,
              external_post_url: json.url || json.postUrl || json.data?.url,
              raw_response: json
            });
          } else {
            resolve({
              success: false,
              error: json.message || json.error || `Zernio publish error (HTTP ${res.statusCode})`,
              raw_response: json
            });
          }
        } catch (e: any) {
          resolve({
            success: false,
            error: `Failed to parse Zernio response: ${e.message}`,
            raw_response: body
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    req.setTimeout(25000, () => {
      req.destroy();
      resolve({ success: false, error: 'Zernio publish call timed out' });
    });

    req.write(bodyData);
    req.end();
  });
}
