import https from 'https';

const GH_PAT = process.env.GITHUB_PAT || '';
const GH_OWNER = process.env.GITHUB_OWNER || 'motionssalt';
const GH_REPO = process.env.GITHUB_REPO || 'salt-relay';

export async function githubApiCall<T = any>(endpoint: string, method = 'GET', body: any = null): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    if (!GH_PAT) {
      return reject(new Error('GITHUB_PAT environment secret is not configured'));
    }

    const postData = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'User-Agent': 'SaltRelay-Server/1.0',
        'Authorization': `Bearer ${GH_PAT.trim()}`,
        'Accept': 'application/vnd.github.v3+json',
        ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, res => {
      let resp = '';
      res.on('data', chunk => resp += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 200, data: JSON.parse(resp || '{}') });
        } catch (e) {
          resolve({ status: res.statusCode || 200, data: resp as any });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

export async function dispatchMediaWorkflow(jobId: string, mediaJson: string, callbackUrl: string, callbackSecret: string) {
  return githubApiCall(
    `/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/process-media.yml/dispatches`,
    'POST',
    {
      ref: 'main',
      inputs: {
        job_id: jobId,
        media_json: mediaJson,
        callback_url: callbackUrl,
        callback_secret: callbackSecret
      }
    }
  );
}

export async function deleteReleaseAsset(assetName: string, releaseTag: string): Promise<boolean> {
  try {
    const relRes = await githubApiCall<any>(`/repos/${GH_OWNER}/${GH_REPO}/releases/tags/${releaseTag}`);
    if (!relRes.data || !relRes.data.assets) return false;

    const asset = relRes.data.assets.find((a: any) => a.name === assetName);
    if (!asset) return false;

    const delRes = await githubApiCall(`/repos/${GH_OWNER}/${GH_REPO}/releases/assets/${asset.id}`, 'DELETE');
    return delRes.status === 204;
  } catch (e) {
    console.warn(`Failed to delete release asset ${assetName}:`, e);
    return false;
  }
}
