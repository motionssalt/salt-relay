/**
 * Salt Relay Cloudflare Worker API & Orchestration Engine
 * Deployed to Cloudflare Workers as `salt-relay-api`
 * Binds: D1 Database `DB`, Cron Trigger `* /5 * * * *`
 */

import crypto from 'node:crypto';
import capabilitiesConfig from '../capabilities.json';

interface D1Result<T = any> {
  results?: T[];
  success?: boolean;
  meta?: any;
}

interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  all<T = any>(): Promise<D1Result<T>>;
  run<T = any>(): Promise<D1Result<T>>;
  first<T = any>(colName?: string): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export interface Env {
  DB: D1Database;
  DASHBOARD_PASSWORD?: string;
  DASHBOARD_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
  CALLBACK_SECRET?: string;
  GITHUB_PAT?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  APP_URL?: string;
}

// -----------------------------------------------------------------------------
// CORS & HEADERS
// -----------------------------------------------------------------------------
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/salt-relay\.pages\.dev$/,
  /^https:\/\/[a-z0-9-]+\.salt-relay\.pages\.dev$/,
  /^http:\/\/localhost:(3000|5173)$/,
  /^http:\/\/127\.0\.0\.1:(3000|5173)$/,
  /^https:\/\/[a-z0-9-]+\.run\.app$/
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isAllowed = ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
  const allowOrigin = isAllowed ? origin : 'https://salt-relay.pages.dev';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token, X-Callback-Signature, Cookie',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

function jsonResponse(data: any, status = 200, extraHeaders: Record<string, string> = {}, request?: Request) {
  const cors = request ? getCorsHeaders(request) : {
    'Access-Control-Allow-Origin': 'https://salt-relay.pages.dev',
    'Access-Control-Allow-Credentials': 'true'
  };

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
      ...extraHeaders
    }
  });
}

// -----------------------------------------------------------------------------
// CRYPTO & AUTH UTILITIES (Constant-time, Salted Hashing, Session Cookies)
// -----------------------------------------------------------------------------
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Perform dummy comparison to mitigate timing attacks
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(candidate: string, env: Env): boolean {
  if (!candidate || typeof candidate !== 'string') return false;

  // 1. If PBKDF2 hash is configured in Worker secrets: format "pbkdf2:100000:<salt_hex>:<hash_hex>"
  if (env.DASHBOARD_PASSWORD_HASH) {
    const parts = env.DASHBOARD_PASSWORD_HASH.split(':');
    if (parts.length === 4 && parts[0] === 'pbkdf2') {
      const iterations = parseInt(parts[1], 10);
      const salt = Buffer.from(parts[2], 'hex');
      const expectedHash = parts[3];
      const derived = crypto.pbkdf2Sync(candidate, salt, iterations, 32, 'sha256').toString('hex');
      return constantTimeCompare(derived, expectedHash);
    }
  }

  // 2. If plain secret is configured in Worker secrets
  if (env.DASHBOARD_PASSWORD) {
    return constantTimeCompare(candidate.trim(), env.DASHBOARD_PASSWORD.trim());
  }

  // Never fall back to a hardcoded password. If not configured, reject.
  return false;
}

function getSigningSecret(env: Env): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.DASHBOARD_PASSWORD_HASH) return env.DASHBOARD_PASSWORD_HASH;
  if (env.DASHBOARD_PASSWORD) {
    return crypto.createHash('sha256').update(`${env.DASHBOARD_PASSWORD}:salt-relay-session-key-v1`).digest('hex');
  }
  return 'unconfigured-session-secret-fallback-locked';
}

function createSignedSessionToken(env: Env): string {
  const payload = {
    sub: 'operator',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 30 days
    nonce: crypto.randomBytes(8).toString('hex')
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', getSigningSecret(env)).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function verifySessionToken(token: string, env: Env): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', getSigningSecret(env)).update(payloadB64).digest('base64url');
  if (!constantTimeCompare(signature, expectedSig)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return false;
    }
    return payload.sub === 'operator';
  } catch {
    return false;
  }
}

function extractSessionToken(request: Request): string {
  // 1. Authorization: Bearer <token>
  const authHeader = request.headers.get('Authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  // 2. X-Session-Token header
  const customHeader = request.headers.get('X-Session-Token');
  if (customHeader) return customHeader.trim();

  // 3. HttpOnly Cookie: salt_relay_session=<token>
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/salt_relay_session=([a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  return '';
}

// -----------------------------------------------------------------------------
// BRUTE-FORCE RATE LIMITING (Tracked in D1 auth_lockouts)
// -----------------------------------------------------------------------------
async function checkAuthRateLimit(db: D1Database, ip: string): Promise<{ locked: boolean; waitMinutes?: number }> {
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS auth_lockouts (
        ip TEXT PRIMARY KEY,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_attempt_at TEXT NOT NULL
      )`
    ).run();

    const row = await db.prepare('SELECT failed_attempts, locked_until FROM auth_lockouts WHERE ip = ?').bind(ip).first<any>();
    if (row && row.locked_until) {
      const lockTime = new Date(row.locked_until).getTime();
      const diffMs = lockTime - Date.now();
      if (diffMs > 0) {
        return { locked: true, waitMinutes: Math.ceil(diffMs / 60000) };
      }
    }
    return { locked: false };
  } catch (err) {
    console.warn('Rate limit check error:', err);
    return { locked: false };
  }
}

async function recordFailedAuthAttempt(db: D1Database, ip: string): Promise<void> {
  try {
    const now = new Date().toISOString();
    const row = await db.prepare('SELECT failed_attempts FROM auth_lockouts WHERE ip = ?').bind(ip).first<any>();
    const current = (row?.failed_attempts || 0) + 1;
    let lockedUntil: string | null = null;
    if (current >= 5) {
      lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15-minute lockout
    }

    await db.prepare(
      `INSERT INTO auth_lockouts (ip, failed_attempts, locked_until, last_attempt_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET
         failed_attempts = excluded.failed_attempts,
         locked_until = excluded.locked_until,
         last_attempt_at = excluded.last_attempt_at`
    ).bind(ip, current, lockedUntil, now).run();
  } catch (err) {
    console.warn('Record failed attempt error:', err);
  }
}

async function resetAuthRateLimit(db: D1Database, ip: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM auth_lockouts WHERE ip = ?').bind(ip).run();
  } catch (err) {
    console.warn('Reset rate limit error:', err);
  }
}

// -----------------------------------------------------------------------------
// EVENT LOGGING (job_events & execution_logs)
// -----------------------------------------------------------------------------
async function logJobEvent(db: D1Database, jobId: string, stage: string, level: 'info' | 'warn' | 'error', message: string, details?: any): Promise<void> {
  const now = new Date().toISOString();
  const eventId = `evt_${crypto.randomUUID().slice(0, 10)}`;
  const detailsStr = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;

  try {
    await db.prepare(
      `INSERT INTO job_events (id, job_id, stage, level, message, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(eventId, jobId, stage, level, message, detailsStr, now).run();
  } catch (e) {
    // If table doesn't exist yet, fallback gracefully
    console.warn('Failed to insert job_events row:', e);
  }

  try {
    await db.prepare(
      `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(`log_${crypto.randomUUID().slice(0, 8)}`, jobId, level, `[${stage}] ${message}`, detailsStr, now).run();
  } catch (e) {
    console.warn('Failed to insert execution_logs row:', e);
  }
}

// -----------------------------------------------------------------------------
// AES-256-GCM KEY ENCRYPTION WITH ROTATION RESILIENCE
// -----------------------------------------------------------------------------
function getMasterKey(env: Env): Buffer {
  const secret = env.ENCRYPTION_KEY || 'unconfigured-encryption-key-locked';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptApiKey(plaintext: string, env: Env): { encrypted: string; iv: string; masked: string } {
  const iv = crypto.randomBytes(12);
  const key = getMasterKey(env);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  const finalEncrypted = `${encrypted}:${authTag}`;

  const trimmed = plaintext.trim();
  const masked = trimmed.length > 8
    ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
    : '****';

  return {
    encrypted: finalEncrypted,
    iv: iv.toString('hex'),
    masked
  };
}

function decryptApiKey(encryptedData: string, ivHex: string, env: Env): string {
  const [ciphertext, authTagHex] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = getMasterKey(env);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err: any) {
    // Fallback rotation decryption attempt using historical key if changed
    const legacyKey = crypto.createHash('sha256').update('salt-relay-master-encryption-key-victor-2026').digest();
    const legacyDecipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
    legacyDecipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = legacyDecipher.update(ciphertext, 'hex', 'utf8');
    decrypted += legacyDecipher.final('utf8');
    return decrypted;
  }
}

// -----------------------------------------------------------------------------
// ZERNIO & SOCIAL DISPATCH HELPERS (Current Zernio API Specification)
// -----------------------------------------------------------------------------
async function fetchZernioAccounts(apiKey: string): Promise<{ success: boolean; accounts: any[]; error?: string }> {
  try {
    const res = await fetch('https://zernio.com/api/v1/accounts', {
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'User-Agent': 'SaltRelay-Publisher/1.0',
        'Accept': 'application/json'
      }
    });
    const data = await res.json().catch(() => ({})) as any;
    if (res.ok) {
      const rawList = Array.isArray(data) ? data : (data.accounts || data.data || []);
      const accounts = rawList.map((item: any) => ({
        id: item.id || item.accountId || item.account_id || String(item._id || Math.random()),
        platform: (item.platform || item.network || 'unknown').toLowerCase(),
        name: item.name || item.displayName || item.username || 'Social Account',
        username: item.username || item.handle || item.name || '',
        avatar_url: item.avatarUrl || item.avatar_url || item.picture || item.profileImage || null
      }));
      return { success: true, accounts };
    }
    return { success: false, accounts: [], error: data.message || data.error || `HTTP ${res.status}` };
  } catch (err: any) {
    return { success: false, accounts: [], error: err.message };
  }
}

async function publishToZernio(apiKey: string, payload: {
  content: string;
  mediaItems?: Array<{ url: string; type: 'video' | 'image' }>;
  platforms: Array<{ platform: string; accountId: string }>;
  publishNow?: boolean;
  scheduledAt?: string;
  story?: boolean;
}): Promise<{ success: boolean; external_post_id?: string; external_post_url?: string; error?: string }> {
  try {
    const res = await fetch('https://zernio.com/api/v1/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SaltRelay-Publisher/1.0',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const json = await res.json().catch(() => ({})) as any;
    if (res.ok) {
      return {
        success: true,
        external_post_id: json.id || json.postId || json.data?.id,
        external_post_url: json.url || json.postUrl || json.data?.url
      };
    }
    return { success: false, error: json.message || json.error || `Zernio publish error ${res.status}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// -----------------------------------------------------------------------------
// GITHUB ACTIONS ORCHESTRATION ENGINE
// -----------------------------------------------------------------------------
async function dispatchMediaWorkflow(env: Env, jobId: string, rawLinks: string[]): Promise<{ success: boolean; error?: string }> {
  if (!env.GITHUB_PAT) {
    return { success: false, error: 'GITHUB_PAT secret not configured in Worker' };
  }

  const owner = env.GITHUB_OWNER || 'motionssalt';
  const repo = env.GITHUB_REPO || 'salt-relay';
  const callbackUrl = 'https://salt-relay-api.motionssalt.workers.dev/api/callback/media-processed';
  const callbackSecret = env.CALLBACK_SECRET || 'salt-relay-shared-secret';

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/process-media.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'SaltRelay-Worker/1.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          job_id: jobId,
          media_json: JSON.stringify(rawLinks),
          callback_url: callbackUrl,
          callback_secret: callbackSecret
        }
      })
    });

    if (res.status === 204 || (res.status >= 200 && res.status < 300)) {
      await logJobEvent(env.DB, jobId, 'dispatched', 'info', 'GitHub Actions media processing workflow dispatched successfully.');
      return { success: true };
    }

    const text = await res.text();
    const errorMsg = `GitHub dispatch returned HTTP ${res.status}: ${text}`;
    await logJobEvent(env.DB, jobId, 'dispatch_failed', 'error', errorMsg);
    return { success: false, error: errorMsg };
  } catch (err: any) {
    const errorMsg = `GitHub dispatch network error: ${err.message}`;
    await logJobEvent(env.DB, jobId, 'dispatch_failed', 'error', errorMsg);
    return { success: false, error: errorMsg };
  }
}

// -----------------------------------------------------------------------------
// FULL PUBLICATION EXECUTION ENGINE (Per-destination tracking, idempotency, retry)
// -----------------------------------------------------------------------------
async function executePublicationStep(env: Env, jobId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind('publishing', now, jobId).run();
  await logJobEvent(env.DB, jobId, 'publishing', 'info', 'Commencing social platform publication via Zernio.');

  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
  if (!job) return;

  const mediaAssetsRes = await env.DB.prepare('SELECT * FROM job_media WHERE job_id = ? AND status = ?').bind(jobId, 'processed').all<any>();
  const mediaAssets = mediaAssetsRes.results || [];

  const destinationsRes = await env.DB.prepare(
    `SELECT jd.*, a.platform_account_id, a.key_id
     FROM job_destinations jd
     JOIN accounts a ON jd.account_id = a.id
     WHERE jd.job_id = ? AND jd.status IN ('pending', 'failed')`
  ).bind(jobId).all<any>();
  const destinations = destinationsRes.results || [];

  if (destinations.length === 0) {
    await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind('published', now, jobId).run();
    await logJobEvent(env.DB, jobId, 'published', 'info', 'All destinations were already processed.');
    return;
  }

  const keysRes = await env.DB.prepare('SELECT id, encrypted_key, iv FROM api_keys WHERE is_active = 1').all<any>();
  const keyMap = new Map((keysRes.results || []).map(k => {
    try {
      return [k.id, decryptApiKey(k.encrypted_key, k.iv, env)];
    } catch {
      return [k.id, null];
    }
  }));

  const fullContent = [job.caption, job.hashtags].filter(Boolean).join('\n\n').trim();

  // Prepare media items for Zernio
  const mediaItems: Array<{ url: string; type: 'video' | 'image' }> = mediaAssets.map(m => {
    let url = m.asset_download_url || m.source_url;
    // If it's a GitHub release asset from private repo, route through Worker's public media proxy
    if (m.asset_name && url.includes('github.com')) {
      url = `https://salt-relay-api.motionssalt.workers.dev/api/public/media/${jobId}/${encodeURIComponent(m.asset_name)}`;
    }
    return {
      url,
      type: m.file_type === 'video' ? 'video' : 'image'
    };
  });

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (const dest of destinations) {
    const apiKey = keyMap.get(dest.key_id);
    const attemptTime = new Date().toISOString();

    if (!apiKey) {
      failCount++;
      const errMsg = 'Active decrypted Zernio API key not found';
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(errMsg, attemptTime, attemptTime, dest.id).run();
      await logJobEvent(env.DB, jobId, 'dest_failed', 'error', `Destination ${dest.platform} (${dest.post_type}) failed: ${errMsg}`);
      continue;
    }

    try {
      const zPayload: any = {
        content: fullContent,
        platforms: [{ platform: dest.platform, accountId: dest.platform_account_id }],
        publishNow: true,
        story: dest.post_type === 'story'
      };

      if (mediaItems.length > 0) {
        zPayload.mediaItems = mediaItems;
      }

      const pubRes = await publishToZernio(apiKey, zPayload);

      if (pubRes.success) {
        successCount++;
        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'published', external_post_id = ?, external_post_url = ?, error_message = NULL, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ?`
        ).bind(pubRes.external_post_id || null, pubRes.external_post_url || null, attemptTime, attemptTime, dest.id).run();
        await logJobEvent(env.DB, jobId, 'dest_published', 'info', `Successfully published to ${dest.platform} (${dest.post_type}). External ID: ${pubRes.external_post_id || 'ok'}`);
      } else {
        failCount++;
        const errMsg = pubRes.error || 'Zernio publishing error';
        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ?`
        ).bind(errMsg, attemptTime, attemptTime, dest.id).run();
        await logJobEvent(env.DB, jobId, 'dest_failed', 'error', `Failed to publish to ${dest.platform} (${dest.post_type}): ${errMsg}`);
      }
    } catch (publishErr: any) {
      failCount++;
      const errMsg = publishErr.message || 'Network error during publish';
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(errMsg, attemptTime, attemptTime, dest.id).run();
      await logJobEvent(env.DB, jobId, 'dest_failed', 'error', `Exception publishing to ${dest.platform}: ${errMsg}`);
    }
  }

  // Determine overall job status
  let finalStatus = 'published';
  let summaryError: string | null = null;

  if (successCount === 0 && failCount > 0) {
    finalStatus = 'failed';
    summaryError = `Publication failed across all ${failCount} destination(s).`;
  } else if (successCount > 0 && failCount > 0) {
    finalStatus = 'partially_published';
    summaryError = `Partial success: ${successCount} published, ${failCount} failed.`;
  } else if (successCount === 0 && failCount === 0) {
    finalStatus = skippedCount > 0 ? 'published' : 'failed';
    if (finalStatus === 'failed') summaryError = 'No destinations were dispatched.';
  }

  const finishedTime = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs SET status = ?, error_message = ?, published_at = ?, updated_at = ? WHERE id = ?`
  ).bind(finalStatus, summaryError, finalStatus === 'published' ? finishedTime : null, finishedTime, jobId).run();

  await logJobEvent(
    env.DB,
    jobId,
    finalStatus,
    finalStatus === 'failed' ? 'error' : 'info',
    `Publication cycle concluded with status: ${finalStatus}. Successes: ${successCount}, Failures: ${failCount}, Skipped: ${skippedCount}`
  );
}

// -----------------------------------------------------------------------------
// WORKER REQUEST HANDLER
// -----------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const corsHeaders = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (public)
    if (path === '/' || path === '/health') {
      return jsonResponse({
        service: 'salt-relay-api',
        status: 'operational',
        time: new Date().toISOString()
      }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // PUBLIC STREAMING MEDIA PROXY (Allows Zernio to fetch release assets from private repo)
    // -------------------------------------------------------------------------
    if (path.startsWith('/api/public/media/') && request.method === 'GET') {
      const parts = path.replace('/api/public/media/', '').split('/');
      const jobId = parts[0];
      const assetName = decodeURIComponent(parts.slice(1).join('/'));

      if (!jobId || !assetName) {
        return jsonResponse({ error: 'Job ID and asset name required' }, 400, {}, request);
      }

      const media = await env.DB.prepare(
        'SELECT * FROM job_media WHERE job_id = ? AND (asset_name = ? OR filename = ?)'
      ).bind(jobId, assetName, assetName).first<any>();

      if (!media) {
        return jsonResponse({ error: 'Media asset not found' }, 404, {}, request);
      }

      // If direct media url that is publicly available, redirect
      if (media.source_type === 'direct' && media.asset_download_url && !media.asset_download_url.includes('github.com')) {
        return Response.redirect(media.asset_download_url, 302);
      }

      // If GitHub release asset: fetch using Worker's GITHUB_PAT
      if (env.GITHUB_PAT) {
        const owner = env.GITHUB_OWNER || 'motionssalt';
        const repo = env.GITHUB_REPO || 'salt-relay';
        const tag = media.release_tag || 'media-001';

        try {
          const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
            headers: {
              'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'SaltRelay-Worker/1.0'
            }
          });
          const relData = await relRes.json().catch(() => ({})) as any;
          const targetAsset = (relData.assets || []).find((a: any) => a.name === assetName);

          if (targetAsset && targetAsset.id) {
            const assetRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${targetAsset.id}`, {
              headers: {
                'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
                'Accept': 'application/octet-stream',
                'User-Agent': 'SaltRelay-Worker/1.0'
              },
              redirect: 'follow'
            });

            const contentType = media.file_type === 'video' ? 'video/mp4' : 'image/jpeg';
            return new Response(assetRes.body, {
              status: assetRes.status,
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400',
                ...corsHeaders
              }
            });
          }
        } catch (e: any) {
          console.warn('Media proxy fetch failed:', e);
        }
      }

      if (media.asset_download_url) {
        return Response.redirect(media.asset_download_url, 302);
      }
      return jsonResponse({ error: 'Asset download unavailable' }, 404, {}, request);
    }

    // -------------------------------------------------------------------------
    // AUTH LOGIN (Strict rate limit, constant-time compare, HttpOnly cookie)
    // -------------------------------------------------------------------------
    if (path === '/api/auth/login' && request.method === 'POST') {
      const clientIp = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'operator_ip';
      const rateLimit = await checkAuthRateLimit(env.DB, clientIp);

      if (rateLimit.locked) {
        return jsonResponse(
          { error: `Too many failed login attempts. Locked for ${rateLimit.waitMinutes || 15} minute(s).` },
          429,
          {},
          request
        );
      }

      const body = await request.json().catch(() => ({})) as any;
      const candidatePassword = (body.password || '').trim();

      if (candidatePassword && verifyPassword(candidatePassword, env)) {
        await resetAuthRateLimit(env.DB, clientIp);
        const token = createSignedSessionToken(env);
        const cookie = `salt_relay_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;

        return jsonResponse(
          { success: true, token },
          200,
          { 'Set-Cookie': cookie },
          request
        );
      }

      await recordFailedAuthAttempt(env.DB, clientIp);
      return jsonResponse({ error: 'Invalid dashboard password.' }, 401, {}, request);
    }

    // -------------------------------------------------------------------------
    // AUTH CHECK & LOGOUT
    // -------------------------------------------------------------------------
    if (path === '/api/auth/check' && request.method === 'GET') {
      const token = extractSessionToken(request);
      const valid = verifySessionToken(token, env);
      return jsonResponse({ authenticated: valid }, 200, {}, request);
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      const clearCookie = 'salt_relay_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
      return jsonResponse({ success: true }, 200, { 'Set-Cookie': clearCookie }, request);
    }

    // -------------------------------------------------------------------------
    // WEBHOOK CALLBACK FROM GITHUB ACTIONS (HMAC verification required)
    // -------------------------------------------------------------------------
    if (path === '/api/callback/media-processed' && request.method === 'POST') {
      const signature = request.headers.get('x-callback-signature');
      const rawBody = await request.text();

      if (env.CALLBACK_SECRET) {
        const expectedSig = crypto.createHmac('sha256', env.CALLBACK_SECRET.trim()).update(rawBody).digest('hex');
        if (!signature || !constantTimeCompare(signature, expectedSig)) {
          return jsonResponse({ error: 'Unauthorized callback signature' }, 401, {}, request);
        }
      }

      let body: any = {};
      try {
        body = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: 'Invalid JSON payload' }, 400, {}, request);
      }

      const jobId = body.job_id;
      if (!jobId) return jsonResponse({ error: 'job_id required' }, 400, {}, request);

      const now = new Date().toISOString();
      const mediaList = body.media || [];

      for (const m of mediaList) {
        await env.DB.prepare(
          `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, mime_type, file_size, width, height, duration_sec, release_tag, asset_name, asset_download_url, status, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          `m_${crypto.randomUUID().slice(0, 8)}`,
          jobId,
          m.source_url,
          m.source_type || 'direct',
          m.file_type || 'image',
          m.filename || 'asset',
          m.mime_type || null,
          m.file_size || null,
          m.width || null,
          m.height || null,
          m.duration_sec || null,
          body.release_tag || null,
          m.asset_name || null,
          m.asset_download_url || null,
          m.status || 'processed',
          m.error || null,
          now
        ).run();
      }

      await logJobEvent(
        env.DB,
        jobId,
        'transcoded',
        'info',
        `GitHub Actions processing completed. ${body.processed_count || mediaList.length} media asset(s) ready.`,
        { release_tag: body.release_tag }
      );

      // Trigger immediate publication for this job
      ctx.waitUntil(executePublicationStep(env, jobId));

      return jsonResponse({ success: true, message: 'Media recorded, publication initiated' }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // AUTH GUARD: ALL SUBSEQUENT /api ROUTES STRICTLY REQUIRE AUTHENTICATION
    // -------------------------------------------------------------------------
    const sessionToken = extractSessionToken(request);
    if (!verifySessionToken(sessionToken, env)) {
      return jsonResponse({ error: 'Unauthorized. Please sign in with dashboard password.' }, 401, {}, request);
    }

    // -------------------------------------------------------------------------
    // API KEYS
    // -------------------------------------------------------------------------
    if (path === '/api/keys' && request.method === 'GET') {
      const { results = [] } = await env.DB.prepare(
        'SELECT id, label, masked_key, is_active, created_at FROM api_keys ORDER BY created_at DESC'
      ).all();

      const countsRes = await env.DB.prepare(
        'SELECT key_id, count(*) as count FROM accounts GROUP BY key_id'
      ).all<{ key_id: string; count: number }>();

      const countMap = new Map((countsRes.results || []).map(a => [a.key_id, a.count]));

      const formatted = results.map(k => ({
        ...k,
        is_active: (k as any).is_active === 1,
        connected_accounts_count: countMap.get((k as any).id) || 0
      }));

      return jsonResponse({ keys: formatted }, 200, {}, request);
    }

    if (path === '/api/keys' && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as any;
      const { label, key } = body;
      if (!label || !key) {
        return jsonResponse({ error: 'Label and API key are required' }, 400, {}, request);
      }

      const { encrypted, iv, masked } = encryptApiKey(key.trim(), env);
      const id = `key_${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO api_keys (id, label, encrypted_key, iv, masked_key, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(id, label.trim(), encrypted, iv, masked, now, now).run();

      return jsonResponse({ success: true, key: { id, label: label.trim(), masked_key: masked, is_active: true } }, 200, {}, request);
    }

    if (path.startsWith('/api/keys/') && request.method === 'DELETE') {
      const keyId = path.replace('/api/keys/', '');
      await env.DB.prepare('DELETE FROM accounts WHERE key_id = ?').bind(keyId).run();
      await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(keyId).run();
      return jsonResponse({ success: true }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // ACCOUNTS
    // -------------------------------------------------------------------------
    if (path === '/api/accounts' && request.method === 'GET') {
      const { results = [] } = await env.DB.prepare('SELECT * FROM accounts ORDER BY platform ASC, name ASC').all();
      const keysRes = await env.DB.prepare('SELECT id, label FROM api_keys').all<{ id: string; label: string }>();
      const keyMap = new Map((keysRes.results || []).map(k => [k.id, k.label]));

      const formatted = results.map(a => ({
        ...a,
        is_active: (a as any).is_active === 1,
        key_label: keyMap.get((a as any).key_id) || 'Unknown Key'
      }));

      return jsonResponse({ accounts: formatted }, 200, {}, request);
    }

    if (path === '/api/accounts/sync' && request.method === 'POST') {
      const keysRes = await env.DB.prepare(
        'SELECT id, label, encrypted_key, iv FROM api_keys WHERE is_active = 1'
      ).all<any>();

      const keys = keysRes.results || [];
      if (keys.length === 0) {
        return jsonResponse({ error: 'No active Zernio API keys configured. Please add a key first.' }, 400, {}, request);
      }

      let totalSynced = 0;
      const errors: any[] = [];

      for (const k of keys) {
        try {
          const decrypted = decryptApiKey(k.encrypted_key, k.iv, env);
          const zRes = await fetchZernioAccounts(decrypted);
          if (!zRes.success) {
            errors.push({ key_label: k.label, error: zRes.error });
            continue;
          }
          const now = new Date().toISOString();
          for (const acc of zRes.accounts) {
            totalSynced++;
            const accDbId = `acc_${acc.platform}_${acc.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            await env.DB.prepare(
              `INSERT INTO accounts (id, platform, platform_account_id, name, username, avatar_url, key_id, is_active, last_synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
               ON CONFLICT(platform, platform_account_id) DO UPDATE SET
                 name = excluded.name,
                 username = excluded.username,
                 avatar_url = excluded.avatar_url,
                 key_id = excluded.key_id,
                 last_synced_at = excluded.last_synced_at`
            ).bind(accDbId, acc.platform, acc.id, acc.name, acc.username, acc.avatar_url || null, k.id, now).run();
          }
        } catch (e: any) {
          errors.push({ key_label: k.label, error: e.message });
        }
      }

      return jsonResponse({
        success: true,
        total_accounts_synced: totalSynced,
        errors: errors.length > 0 ? errors : undefined
      }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // CAPABILITIES
    // -------------------------------------------------------------------------
    if (path === '/api/capabilities' && request.method === 'GET') {
      return jsonResponse({ platforms: (capabilitiesConfig as any).platforms || capabilitiesConfig }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // DRIVE & LINK INSPECTION (Supports folders & single file links)
    // -------------------------------------------------------------------------
    if (path === '/api/drive/inspect' && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as any;
      const targetUrl = (body.url || '').trim();
      if (!targetUrl) return jsonResponse({ error: 'URL required' }, 400, {}, request);

      // Public Google Drive Folder
      if (targetUrl.includes('drive.google.com/drive/folders/')) {
        const match = targetUrl.match(/folders\/([a-zA-Z0-9_-]+)/);
        const folderId = match ? match[1] : null;
        try {
          const resp = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
          const html = await resp.text();
          const fileIds = new Set<string>();
          const simpleRegex = /([a-zA-Z0-9_-]{28,33})/g;
          let m;
          while ((m = simpleRegex.exec(html)) !== null) {
            const candidate = m[1];
            if (candidate !== folderId && !candidate.startsWith('drive') && !candidate.includes('google')) {
              fileIds.add(candidate);
            }
          }
          const files = Array.from(fileIds).slice(0, 50).map((id, idx) => ({
            url: `https://drive.google.com/uc?export=download&id=${id}&confirm=t`,
            source_type: 'drive',
            name: `drive_asset_${idx + 1}`,
            file_type: 'unknown',
            accessible: true
          }));
          return jsonResponse({ success: true, files }, 200, {}, request);
        } catch (err: any) {
          return jsonResponse({ success: false, files: [], error: err.message }, 200, {}, request);
        }
      } else if (targetUrl.includes('drive.google.com/file/d/')) {
        // Public Google Drive single file link
        const match = targetUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        const fileId = match ? match[1] : null;
        return jsonResponse({
          success: true,
          files: [{
            url: `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
            source_type: 'drive',
            name: `drive_file_${fileId || 'asset'}`,
            file_type: 'unknown',
            accessible: true
          }]
        }, 200, {}, request);
      } else {
        // Direct media URL
        const isVideo = /\.(mp4|mov|webm)$/i.test(targetUrl);
        return jsonResponse({
          success: true,
          files: [{
            url: targetUrl,
            source_type: 'direct',
            name: targetUrl.split('?')[0].split('/').pop() || 'media_asset',
            file_type: isVideo ? 'video' : 'image',
            accessible: true
          }]
        }, 200, {}, request);
      }
    }

    // -------------------------------------------------------------------------
    // JOBS
    // -------------------------------------------------------------------------
    if (path === '/api/jobs' && request.method === 'GET') {
      const status = url.searchParams.get('status');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      let query = 'SELECT * FROM jobs';
      const params: any[] = [];
      if (status && status !== 'all') {
        query += ' WHERE status = ?';
        params.push(status);
      }
      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const stmt = env.DB.prepare(query);
      const { results = [] } = await (params.length > 1 ? stmt.bind(params[0], params[1]) : stmt.bind(params[0])).all();
      return jsonResponse({ jobs: results }, 200, {}, request);
    }

    if (path.startsWith('/api/jobs/') && request.method === 'GET' && !path.endsWith('/retry') && !path.endsWith('/cancel')) {
      const jobId = path.replace('/api/jobs/', '');
      const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
      if (!job) return jsonResponse({ error: 'Job not found' }, 404, {}, request);

      const mediaRes = await env.DB.prepare('SELECT * FROM job_media WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all();
      const destRes = await env.DB.prepare('SELECT * FROM job_destinations WHERE job_id = ? ORDER BY platform ASC').bind(jobId).all();
      const logsRes = await env.DB.prepare('SELECT * FROM execution_logs WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all();

      let events: any[] = [];
      try {
        const eventsRes = await env.DB.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all();
        events = eventsRes.results || [];
      } catch {}

      return jsonResponse({
        job,
        media: mediaRes.results || [],
        destinations: destRes.results || [],
        logs: logsRes.results || [],
        events
      }, 200, {}, request);
    }

    // CREATE POST
    if (path === '/api/jobs' && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as any;
      const {
        caption = '',
        hashtags = '',
        links = [],
        publish_mode = 'now',
        scheduled_at,
        story_enabled = false,
        selected_destinations = []
      } = body;

      const cleanLinks = Array.isArray(links) ? links.filter((l: string) => typeof l === 'string' && l.trim().length > 0) : [];

      if (!caption.trim() && cleanLinks.length === 0) {
        return jsonResponse({ error: 'Caption or media links are required' }, 400, {}, request);
      }

      const jobId = `job_${crypto.randomUUID().slice(0, 10)}`;
      const now = new Date().toISOString();

      let finalSchedule = scheduled_at || null;
      let initialStatus = 'pending';

      if (publish_mode === 'queue' || publish_mode === 'schedule') {
        initialStatus = 'scheduled';
        if (publish_mode === 'queue' && !finalSchedule) {
          const d = new Date(Date.now() + 60 * 60 * 1000); // Default next slot +1 hour
          finalSchedule = d.toISOString();
        }
      }

      await env.DB.prepare(
        `INSERT INTO jobs (id, caption, hashtags, raw_links_json, publish_mode, status, story_enabled, scheduled_at, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Africa/Lagos', ?, ?)`
      ).bind(jobId, caption.trim(), hashtags.trim(), JSON.stringify(cleanLinks), publish_mode, initialStatus, story_enabled ? 1 : 0, finalSchedule, now, now).run();

      await logJobEvent(env.DB, jobId, 'created', 'info', `Job created with publish_mode: ${publish_mode}`);

      // Insert Destinations
      const accRes = await env.DB.prepare('SELECT * FROM accounts WHERE is_active = 1').all<any>();
      const allAccs = accRes.results || [];
      const targets = selected_destinations.length > 0
        ? allAccs.filter((a: any) => selected_destinations.includes(a.id))
        : allAccs;

      for (const acc of targets) {
        const idempotency = crypto.createHash('sha256').update(`${jobId}:${acc.id}:feed`).digest('hex').slice(0, 32);
        await env.DB.prepare(
          `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'feed', ?, 'pending', ?, ?)`
        ).bind(`dest_${crypto.randomUUID().slice(0, 8)}`, jobId, acc.id, acc.platform, idempotency, now, now).run();

        if (story_enabled) {
          const storyIdempotency = crypto.createHash('sha256').update(`${jobId}:${acc.id}:story`).digest('hex').slice(0, 32);
          await env.DB.prepare(
            `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'story', ?, 'pending', ?, ?)`
          ).bind(`dest_story_${crypto.randomUUID().slice(0, 8)}`, jobId, acc.id, acc.platform, storyIdempotency, now, now).run();
        }
      }

      // If publish now: initiate processing / publication pipeline immediately
      if (publish_mode === 'now') {
        const hasDrive = cleanLinks.some((l: string) => l.includes('drive.google.com'));

        if (cleanLinks.length === 0) {
          // Text-only job: direct publication
          ctx.waitUntil(executePublicationStep(env, jobId));
        } else if (hasDrive || env.GITHUB_PAT) {
          // Dispatch GitHub Actions workflow for Drive downloads & FFmpeg transcoding
          await env.DB.prepare(`UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ?`).bind(now, jobId).run();
          await logJobEvent(env.DB, jobId, 'dispatching', 'info', 'Triggering media transcode pipeline in GitHub Actions.');

          ctx.waitUntil((async () => {
            const dispatchRes = await dispatchMediaWorkflow(env, jobId, cleanLinks);
            if (!dispatchRes.success) {
              // If dispatch fails, record the error and attempt direct links fallback
              console.warn(`Dispatch failed for ${jobId}: ${dispatchRes.error}`);
              for (let i = 0; i < cleanLinks.length; i++) {
                const l = cleanLinks[i];
                const isVid = /\.(mp4|mov|webm)$/i.test(l);
                await env.DB.prepare(
                  `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, asset_download_url, status, created_at)
                   VALUES (?, ?, ?, 'direct', ?, ?, ?, 'processed', ?)`
                ).bind(`m_${jobId}_${i}`, jobId, l, isVid ? 'video' : 'image', `media_${i}`, l, new Date().toISOString()).run();
              }
              await executePublicationStep(env, jobId);
            }
          })());
        } else {
          // Direct links fallback without Actions
          for (let i = 0; i < cleanLinks.length; i++) {
            const l = cleanLinks[i];
            const isVid = /\.(mp4|mov|webm)$/i.test(l);
            await env.DB.prepare(
              `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, asset_download_url, status, created_at)
               VALUES (?, ?, ?, 'direct', ?, ?, ?, 'processed', ?)`
            ).bind(`m_${jobId}_${i}`, jobId, l, isVid ? 'video' : 'image', `media_${i}`, l, now).run();
          }
          ctx.waitUntil(executePublicationStep(env, jobId));
        }
      }

      return jsonResponse({
        success: true,
        job_id: jobId,
        publish_mode,
        status: initialStatus,
        scheduled_at: finalSchedule
      }, 200, {}, request);
    }

    // RETRY ACTION (Idempotent: only retries failed or pending destinations)
    if (path.endsWith('/retry') && request.method === 'POST') {
      const jobId = path.replace('/api/jobs/', '').replace('/retry', '');
      const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
      if (!job) return jsonResponse({ error: 'Job not found' }, 404, {}, request);

      const unfulfilled = await env.DB.prepare(
        `SELECT count(*) as count FROM job_destinations WHERE job_id = ? AND status IN ('pending', 'failed')`
      ).bind(jobId).first<{ count: number }>();

      if (!unfulfilled || unfulfilled.count === 0) {
        return jsonResponse({ error: 'All destinations are already published or skipped. Nothing to retry.' }, 400, {}, request);
      }

      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE jobs SET status = 'publishing', error_message = NULL, updated_at = ? WHERE id = ?`)
        .bind(now, jobId).run();
      await logJobEvent(env.DB, jobId, 'retried', 'info', 'Operator initiated idempotent retry for unfulfilled destinations.');

      ctx.waitUntil(executePublicationStep(env, jobId));

      return jsonResponse({ success: true, message: `Retry initiated for ${unfulfilled.count} destination(s).` }, 200, {}, request);
    }

    // CANCEL ACTION
    if (path.endsWith('/cancel') && request.method === 'POST') {
      const jobId = path.replace('/api/jobs/', '').replace('/cancel', '');
      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE jobs SET status = 'cancelled', error_message = 'Cancelled by operator', updated_at = ? WHERE id = ?`)
        .bind(now, jobId).run();
      await logJobEvent(env.DB, jobId, 'cancelled', 'warn', 'Job cancelled by operator.');
      return jsonResponse({ success: true }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // QUEUE
    // -------------------------------------------------------------------------
    if (path === '/api/queue' && request.method === 'GET') {
      const config = await env.DB.prepare('SELECT * FROM queue_settings WHERE id = "singleton"').first();
      const queuedJobs = await env.DB.prepare(
        `SELECT * FROM jobs WHERE status IN ('scheduled', 'pending', 'processing') ORDER BY scheduled_at ASC, created_at ASC`
      ).all();

      const nextSlot = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      return jsonResponse({
        config: config || { posts_per_day: 3, daily_times_json: '["09:00","14:00","19:00"]', timezone: 'Africa/Lagos' },
        queued_jobs: queuedJobs.results || [],
        next_available_slot: nextSlot
      }, 200, {}, request);
    }

    if (path === '/api/queue/settings' && request.method === 'PUT') {
      const body = await request.json().catch(() => ({})) as any;
      const { posts_per_day = 3, daily_times = ['09:00', '14:00', '19:00'], timezone = 'Africa/Lagos', is_active = true } = body;
      await env.DB.prepare(
        `UPDATE queue_settings SET
           posts_per_day = ?,
           daily_times_json = ?,
           timezone = ?,
           is_active = ?,
           updated_at = ?
         WHERE id = 'singleton'`
      ).bind(posts_per_day, JSON.stringify(daily_times), timezone, is_active ? 1 : 0, new Date().toISOString()).run();
      return jsonResponse({ success: true }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // SYSTEM STATUS
    // -------------------------------------------------------------------------
    if (path === '/api/system/status' && request.method === 'GET') {
      const jobCount = await env.DB.prepare('SELECT count(*) as count FROM jobs').first<{ count: number }>();
      const accCount = await env.DB.prepare('SELECT count(*) as count FROM accounts WHERE is_active = 1').first<{ count: number }>();
      const keyCount = await env.DB.prepare('SELECT count(*) as count FROM api_keys WHERE is_active = 1').first<{ count: number }>();
      const relCount = await env.DB.prepare('SELECT tag_name FROM releases WHERE is_active = 1').first<{ tag_name: string }>();

      return jsonResponse({
        status: 'operational',
        d1_connected: true,
        active_keys: keyCount?.count || 0,
        connected_accounts: accCount?.count || 0,
        total_jobs: jobCount?.count || 0,
        active_release: relCount?.tag_name || 'media-001',
        timezone: 'Africa/Lagos',
        worker_url: 'https://salt-relay-api.motionssalt.workers.dev',
        pages_url: 'https://salt-relay.pages.dev'
      }, 200, {}, request);
    }

    return jsonResponse({ error: 'Endpoint not found' }, 404, {}, request);
  },

  // ---------------------------------------------------------------------------
  // CRON TRIGGER & WATCHDOG HANDLER (Every 5 minutes)
  // ---------------------------------------------------------------------------
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    console.log(`[Watchdog & Cron] Heartbeat triggered at ${nowIso}`);

    // 1. WATCHDOG: Find jobs stuck in pending/processing/publishing for > 15 minutes
    try {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const stuckJobs = await env.DB.prepare(
        `SELECT id, status, updated_at FROM jobs
         WHERE status IN ('pending', 'processing', 'publishing')
           AND updated_at <= ?
         LIMIT 10`
      ).bind(fifteenMinutesAgo).all<any>();

      for (const job of (stuckJobs.results || [])) {
        console.warn(`[Watchdog] Terminating stuck job: ${job.id} (Status: ${job.status}, Updated: ${job.updated_at})`);
        const reason = `Watchdog timeout: job remained in '${job.status}' stage for over 15 minutes without progress.`;

        await env.DB.prepare(
          `UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`
        ).bind(reason, nowIso, job.id).run();

        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ?
           WHERE job_id = ? AND status IN ('pending', 'publishing')`
        ).bind('Terminated due to pipeline timeout', nowIso, job.id).run();

        await logJobEvent(env.DB, job.id, 'watchdog_timeout', 'error', reason);
      }
    } catch (watchdogErr) {
      console.error('[Watchdog] Error running timeout checks:', watchdogErr);
    }

    // 2. CRON DISPATCH: Activate due scheduled jobs
    try {
      // Fix ISO string comparison bug: pass ISO parameter instead of datetime('now')
      const { results } = await env.DB.prepare(
        `SELECT id, caption, raw_links_json, story_enabled FROM jobs
         WHERE status = 'scheduled' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC LIMIT 5`
      ).bind(nowIso).all();

      for (const job of (results || []) as any[]) {
        console.log(`[Cron Trigger] Activating due scheduled job: ${job.id}`);
        await env.DB.prepare(`UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ?`)
          .bind(nowIso, job.id)
          .run();

        await logJobEvent(env.DB, job.id, 'scheduled_trigger', 'info', 'Scheduled job triggered via Cloudflare Cron Trigger.');

        let links: string[] = [];
        try {
          links = JSON.parse(job.raw_links_json || '[]');
        } catch {}

        if (links.length > 0 && (links.some((l: string) => l.includes('drive.google.com')) || env.GITHUB_PAT)) {
          ctx.waitUntil(dispatchMediaWorkflow(env, job.id, links));
        } else {
          ctx.waitUntil(executePublicationStep(env, job.id));
        }
      }
    } catch (cronErr) {
      console.error('[Cron Trigger] Error running scheduled jobs:', cronErr);
    }
  }
};
