import https from 'https';

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const D1_ID = process.env.CLOUDFLARE_D1_ID || '29f8c89b-41cf-4b7e-906c-a475eb06febc';

export interface D1QueryResult<T = any> {
  results: T[];
  success: boolean;
  meta?: any;
}

export async function queryD1<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!CF_TOKEN || !CF_ACCOUNT) {
      return reject(new Error('Cloudflare API credentials not configured in environment'));
    }

    const postData = JSON.stringify({ sql, params });
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_ID}/query`,
      method: 'POST',
      headers: {
        'User-Agent': 'SaltRelay-Server/1.0',
        'Authorization': `Bearer ${CF_TOKEN.trim()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            return reject(new Error(json.errors?.[0]?.message || 'D1 query failed'));
          }
          const results = json.result?.[0]?.results || [];
          resolve(results as T[]);
        } catch (e: any) {
          reject(new Error(`Failed to parse D1 response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

export async function executeD1(sql: string, params: any[] = []): Promise<{ success: boolean; changes?: number }> {
  return new Promise((resolve, reject) => {
    if (!CF_TOKEN || !CF_ACCOUNT) {
      return reject(new Error('Cloudflare API credentials not configured in environment'));
    }

    const postData = JSON.stringify({ sql, params });
    const req = https.request({
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_ID}/query`,
      method: 'POST',
      headers: {
        'User-Agent': 'SaltRelay-Server/1.0',
        'Authorization': `Bearer ${CF_TOKEN.trim()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) {
            return reject(new Error(json.errors?.[0]?.message || 'D1 execute failed'));
          }
          const meta = json.result?.[0]?.meta;
          resolve({ success: true, changes: meta?.changes });
        } catch (e: any) {
          reject(new Error(`Failed to parse D1 execute response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}
