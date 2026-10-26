/**
 * Salt Relay Cloudflare Worker API & Orchestration Engine
 * Deployed to Cloudflare Workers as `salt-relay-api`
 * Binds: D1 Database `DB`, Cron Trigger (every 5 minutes)
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

export type SourceKind = 'direct_url' | 'drive_file' | 'drive_folder';

export interface ValidatedSource {
  position: number;
  source_url: string;
  source_kind: SourceKind;
}

const LEGACY_NO_SOURCES_MESSAGE =
  "This job's original media links were not saved, so it cannot be retried. Create a new post.";

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

function scrubSecrets(text: string, env: Env): string {
  let out = String(text || '');
  const candidates = [
    env.GITHUB_PAT,
    env.CALLBACK_SECRET,
    env.ENCRYPTION_KEY,
    env.DASHBOARD_PASSWORD,
    env.SESSION_SECRET
  ].filter((s): s is string => Boolean(s && s.trim().length >= 6));
  for (const sec of candidates) {
    out = out.split(sec.trim()).join('[REDACTED]');
  }
  out = out.replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_PAT]');
  out = out.replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED_PAT]');
  return out;
}

// -----------------------------------------------------------------------------
// CRYPTO & AUTH UTILITIES (Constant-time, Salted Hashing, Session Cookies)
// -----------------------------------------------------------------------------
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(candidate: string, env: Env): boolean {
  if (!candidate || typeof candidate !== 'string') return false;

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

  if (env.DASHBOARD_PASSWORD) {
    return constantTimeCompare(candidate.trim(), env.DASHBOARD_PASSWORD.trim());
  }

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
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
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
  const authHeader = request.headers.get('Authorization');
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  const customHeader = request.headers.get('X-Session-Token');
  if (customHeader) return customHeader.trim();

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
      lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
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
async function logJobEvent(
  db: D1Database,
  jobId: string,
  stage: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  details?: any
): Promise<void> {
  const now = new Date().toISOString();
  const eventId = `evt_${crypto.randomUUID().slice(0, 10)}`;
  const detailsStr = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;

  try {
    await db.prepare(
      `INSERT INTO job_events (id, job_id, stage, level, message, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(eventId, jobId, stage, level, message, detailsStr, now).run();
  } catch (e) {
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
// SOURCE VALIDATION, IMMUTABLE PERSISTENCE & SCHEDULE HELPERS (F5 & F6)
// -----------------------------------------------------------------------------
export function classifySourceUrl(rawUrl: string): { valid: boolean; kind?: SourceKind; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: `Malformed URL syntax '${rawUrl}'. Must start with https:// or http://.` };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: `Unsupported protocol '${parsed.protocol}' in '${rawUrl}'. Only https:// and http:// URLs are supported.` };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.') && host !== 'localhost' && host !== '127.0.0.1') {
    return { valid: false, reason: `Invalid hostname '${parsed.hostname}' in '${rawUrl}'.` };
  }

  if (host === 'drive.google.com' || host.endsWith('.drive.google.com') || host === 'drive.usercontent.google.com') {
    const full = parsed.toString();
    if (full.includes('/folders/')) {
      const folderMatch = full.match(/\/folders\/([a-zA-Z0-9_-]{8,})/);
      if (!folderMatch) {
        return {
          valid: false,
          reason: `Google Drive folder link '${rawUrl}' is missing a valid folder ID (expected https://drive.google.com/drive/folders/<ID>).`
        };
      }
      return { valid: true, kind: 'drive_folder' };
    }

    const fileMatch = full.match(/(?:\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]{8,})/);
    if (fileMatch) {
      return { valid: true, kind: 'drive_file' };
    }

    return {
      valid: false,
      reason: `Google Drive URL '${rawUrl}' does not contain a specific file ID or folder ID. Share a public folder (/drive/folders/<ID>) or file (/file/d/<ID>) link.`
    };
  }

  return { valid: true, kind: 'direct_url' };
}

export function validateSubmittedSources(rawInput: unknown): {
  valid: boolean;
  sources: ValidatedSource[];
  error?: string;
  field?: string;
  stage?: string;
} {
  const arr = Array.isArray(rawInput) ? rawInput : [];
  const trimmedList = arr
    .map(item => (typeof item === 'string' ? item.trim() : (item && typeof (item as any).url === 'string' ? (item as any).url.trim() : '')))
    .filter(s => s.length > 0);

  if (trimmedList.length === 0) {
    return {
      valid: false,
      sources: [],
      stage: 'create_validation',
      field: 'links',
      error: 'Validation failed [stage: create_validation, field: links]: At least one media source link (direct image/video URL or public Google Drive file/folder link) is required.'
    };
  }

  const validated: ValidatedSource[] = [];
  for (let i = 0; i < trimmedList.length; i++) {
    const url = trimmedList[i];
    const check = classifySourceUrl(url);
    if (!check.valid || !check.kind) {
      return {
        valid: false,
        sources: [],
        stage: 'create_validation',
        field: `links[${i}]`,
        error: `Validation failed [stage: create_validation, field: links[${i}]]: ${check.reason}`
      };
    }
    validated.push({
      position: i,
      source_url: url,
      source_kind: check.kind
    });
  }

  return { valid: true, sources: validated };
}

async function ensureJobSourcesTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS job_sources (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        source_url TEXT NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'direct_url',
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      )`
    ).run();
  } catch (e) {
    console.warn('ensureJobSourcesTable warning:', e);
  }
}

async function saveImmutableJobSources(
  db: D1Database,
  jobId: string,
  sources: ValidatedSource[],
  createdAt: string
): Promise<void> {
  await ensureJobSourcesTable(db);
  for (const src of sources) {
    await db.prepare(
      `INSERT OR IGNORE INTO job_sources (id, job_id, position, source_url, source_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(`src_${jobId}_${src.position}`, jobId, src.position, src.source_url, src.source_kind, createdAt).run();
  }
}

async function resolveOrRecoverJobSources(
  db: D1Database,
  job: any
): Promise<{ sources: ValidatedSource[]; recovered: boolean }> {
  await ensureJobSourcesTable(db);

  // 1. Primary source of truth: immutable job_sources rows
  try {
    const rowsRes = await db.prepare(
      'SELECT position, source_url, source_kind FROM job_sources WHERE job_id = ? ORDER BY position ASC'
    ).bind(job.id).all<any>();
    const rows = rowsRes.results || [];
    if (rows.length > 0) {
      return {
        sources: rows.map((r, idx) => ({
          position: typeof r.position === 'number' ? r.position : idx,
          source_url: r.source_url,
          source_kind: (r.source_kind || 'direct_url') as SourceKind
        })),
        recovered: false
      };
    }
  } catch (e) {
    console.warn('Error reading job_sources:', e);
  }

  // 2. Fallback & recovery from jobs.sources_json or jobs.raw_links_json
  const candidates: string[] = [];
  for (const colVal of [job.sources_json, job.raw_links_json]) {
    if (typeof colVal === 'string' && colVal.trim().length > 0) {
      try {
        const parsed = JSON.parse(colVal);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const u = typeof item === 'string' ? item.trim() : (item?.url || '').trim();
            if (u) candidates.push(u);
          }
        }
      } catch {}
    }
    if (candidates.length > 0) break;
  }

  // 3. Secondary legacy recovery: inspect job_events or execution_logs details_json
  if (candidates.length === 0) {
    try {
      const logsRes = await db.prepare(
        `SELECT details_json FROM execution_logs WHERE job_id = ? AND details_json IS NOT NULL ORDER BY created_at ASC`
      ).bind(job.id).all<any>();
      for (const row of (logsRes.results || [])) {
        try {
          const d = JSON.parse(row.details_json);
          const list = d?.links || d?.sources;
          if (Array.isArray(list) && list.length > 0) {
            for (const u of list) {
              if (typeof u === 'string' && u.trim()) candidates.push(u.trim());
            }
            if (candidates.length > 0) break;
          }
        } catch {}
      }
    } catch {}
  }

  if (candidates.length === 0) {
    return { sources: [], recovered: false };
  }

  const check = validateSubmittedSources(candidates);
  if (!check.valid || check.sources.length === 0) {
    return { sources: [], recovered: false };
  }

  // Persist recovered sources immutably into job_sources & jobs.sources_json
  const now = new Date().toISOString();
  await saveImmutableJobSources(db, job.id, check.sources, job.created_at || now);
  try {
    await db.prepare('UPDATE jobs SET sources_json = ? WHERE id = ?')
      .bind(JSON.stringify(check.sources.map(s => s.source_url)), job.id)
      .run();
  } catch {}

  return { sources: check.sources, recovered: true };
}

export function normalizeScheduleToUtcIso(rawSchedule: string | undefined | null, timezone = 'Africa/Lagos'): {
  valid: boolean;
  iso: string | null;
  error?: string;
} {
  if (!rawSchedule || typeof rawSchedule !== 'string' || !rawSchedule.trim()) {
    return { valid: false, iso: null, error: 'Scheduled date/time is missing.' };
  }

  const trimmed = rawSchedule.trim();

  // Already carries explicit UTC Z or numeric offset
  if (/Z$/i.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const dt = new Date(trimmed);
    if (Number.isNaN(dt.getTime())) {
      return { valid: false, iso: null, error: `Invalid scheduled_at timestamp '${trimmed}'.` };
    }
    return { valid: true, iso: dt.toISOString() };
  }

  // Naive datetime-local format YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    const fallbackDt = new Date(trimmed);
    if (!Number.isNaN(fallbackDt.getTime())) {
      return { valid: true, iso: fallbackDt.toISOString() };
    }
    return { valid: false, iso: null, error: `Invalid scheduled_at format '${trimmed}' (expected ISO-8601 or YYYY-MM-DDTHH:mm).` };
  }

  const [, yStr, moStr, dStr, hStr, miStr, sStr] = m;
  const year = Number(yStr);
  const month = Number(moStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(miStr);
  const second = Number(sStr || '0');

  if (timezone === 'Africa/Lagos') {
    // Africa/Lagos is UTC+01:00 year-round (WAT, no DST)
    const utcMs = Date.UTC(year, month - 1, day, hour - 1, minute, second);
    return { valid: true, iso: new Date(utcMs).toISOString() };
  }

  try {
    const approxUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(approxUtc);
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    const tzAsUtc = Date.UTC(map.year, (map.month || 1) - 1, map.day || 1, (map.hour || 0) % 24, map.minute || 0, map.second || 0);
    const offsetMs = tzAsUtc - approxUtc.getTime();
    return { valid: true, iso: new Date(approxUtc.getTime() - offsetMs).toISOString() };
  } catch {
    const utcMs = Date.UTC(year, month - 1, day, hour - 1, minute, second);
    return { valid: true, iso: new Date(utcMs).toISOString() };
  }
}

async function calculateNextQueueSlotD1(db: D1Database): Promise<string> {
  let dailyTimes = ['09:00', '14:00', '19:00'];
  let timezone = 'Africa/Lagos';

  try {
    const cfg = await db.prepare('SELECT * FROM queue_settings WHERE id = ?').bind('singleton').first<any>();
    if (cfg) {
      timezone = cfg.timezone || 'Africa/Lagos';
      const parsed = JSON.parse(cfg.daily_times_json || '["09:00","14:00","19:00"]');
      if (Array.isArray(parsed) && parsed.length > 0) {
        dailyTimes = parsed.slice().sort();
      }
    }
  } catch {}

  const scheduledRes = await db.prepare(
    `SELECT scheduled_at FROM jobs WHERE status IN ('scheduled', 'pending', 'processing') AND scheduled_at IS NOT NULL`
  ).all<{ scheduled_at: string }>();
  const occupied = new Set((scheduledRes.results || []).map(r => r.scheduled_at));

  const now = new Date();
  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const candidateDay = new Date(now.getTime() + dayOffset * 86400000);
    const datePart = candidateDay.toISOString().split('T')[0];
    for (const t of dailyTimes) {
      const normalized = normalizeScheduleToUtcIso(`${datePart}T${t}`, timezone);
      if (normalized.valid && normalized.iso) {
        if (new Date(normalized.iso).getTime() > now.getTime() + 5 * 60 * 1000 && !occupied.has(normalized.iso)) {
          return normalized.iso;
        }
      }
    }
  }

  return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
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
  } catch {
    const legacyKey = crypto.createHash('sha256').update('salt-relay-master-encryption-key-victor-2026').digest();
    const legacyDecipher = crypto.createDecipheriv('aes-256-gcm', legacyKey, iv);
    legacyDecipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    let decrypted = legacyDecipher.update(ciphertext, 'hex', 'utf8');
    decrypted += legacyDecipher.final('utf8');
    return decrypted;
  }
}

// -----------------------------------------------------------------------------
// ZERNIO & SOCIAL DISPATCH HELPERS
// -----------------------------------------------------------------------------
async function fetchZernioAccounts(apiKey: string): Promise<{ success: boolean; accounts: any[]; error?: string }> {
  try {
    const res = await fetch('https://zernio.com/api/v1/accounts', {
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'User-Agent': 'SaltRelay-Publisher/2.1',
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
        'User-Agent': 'SaltRelay-Publisher/2.1',
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
    return { success: false, error: json.message || json.error || `Zernio publish error HTTP ${res.status}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// -----------------------------------------------------------------------------
// GITHUB ACTIONS ORCHESTRATION & RELEASE VERIFICATION ENGINE
// -----------------------------------------------------------------------------
async function dispatchMediaWorkflow(
  env: Env,
  jobId: string,
  sourceLinks: string[],
  attemptNumber = 1
): Promise<{ success: boolean; http_status?: number; run_id?: string | null; run_url?: string | null; error?: string }> {
  const nowIso = new Date().toISOString();

  if (!env.GITHUB_PAT) {
    const errorMsg = 'Stage [dispatch]: GITHUB_PAT secret is not configured in Cloudflare Worker.';
    await env.DB.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .bind('failed', errorMsg, nowIso, jobId).run();
    await env.DB.prepare(
      `UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('pending', 'publishing')`
    ).bind(errorMsg, nowIso, jobId).run();
    await logJobEvent(env.DB, jobId, 'dispatch_failed', 'error', errorMsg, { attempt: attemptNumber });
    return { success: false, error: errorMsg };
  }

  if (!Array.isArray(sourceLinks) || sourceLinks.length === 0) {
    const errorMsg = 'Stage [dispatch] (field: links): Cannot dispatch workflow with 0 media source links.';
    await env.DB.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .bind('failed', errorMsg, nowIso, jobId).run();
    await logJobEvent(env.DB, jobId, 'dispatch_failed', 'error', errorMsg, { attempt: attemptNumber });
    return { success: false, error: errorMsg };
  }

  const owner = env.GITHUB_OWNER || 'motionssalt';
  const repo = env.GITHUB_REPO || 'salt-relay';
  const callbackUrl = 'https://salt-relay-api.motionssalt.workers.dev/api/callback/media-processed';
  const callbackSecret = env.CALLBACK_SECRET || '';
  const dispatchStartedMs = Date.now();

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/process-media.yml/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'SaltRelay-Worker/2.1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          job_id: jobId,
          media_json: JSON.stringify(sourceLinks),
          callback_url: callbackUrl,
          callback_secret: callbackSecret,
          attempt_number: String(attemptNumber)
        }
      })
    });

    if (res.status === 204 || (res.status >= 200 && res.status < 300)) {
      let runId: string | null = null;
      let runUrl: string | null = null;

      // Poll briefly to capture the newly created workflow run ID & URL accurately
      const waitStepsMs = [250, 1200, 1800];
      for (const waitMs of waitStepsMs) {
        try {
          await new Promise(r => setTimeout(r, waitMs));
          const runsRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/actions/workflows/process-media.yml/runs?event=workflow_dispatch&per_page=5`,
            {
              headers: {
                'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'SaltRelay-Worker/2.1'
              }
            }
          );
          if (runsRes.ok) {
            const runsData = await runsRes.json() as any;
            const runs = Array.isArray(runsData.workflow_runs) ? runsData.workflow_runs : [];
            const matchingRun = runs.find((r: any) => {
              if (!r || !r.id) return false;
              const createdMs = r.created_at ? new Date(r.created_at).getTime() : dispatchStartedMs;
              return createdMs >= dispatchStartedMs - 15000;
            });
            if (matchingRun) {
              runId = String(matchingRun.id);
              runUrl = matchingRun.html_url || `https://github.com/${owner}/${repo}/actions/runs/${runId}`;
              await env.DB.prepare(
                'UPDATE jobs SET workflow_run_id = ?, workflow_run_url = ?, updated_at = ? WHERE id = ?'
              ).bind(runId, runUrl, new Date().toISOString(), jobId).run();
              break;
            }
          }
        } catch (findErr: any) {
          console.warn('Workflow run lookup attempt warning:', findErr.message);
        }
      }

      await logJobEvent(
        env.DB,
        jobId,
        'dispatched',
        'info',
        runUrl
          ? `Attempt #${attemptNumber}: GitHub Actions workflow dispatched (HTTP ${res.status}). Run #${runId} active.`
          : `Attempt #${attemptNumber}: GitHub Actions workflow dispatched (HTTP ${res.status}).`,
        {
          http_status: res.status,
          attempt: attemptNumber,
          source_count: sourceLinks.length,
          run_id: runId,
          run_url: runUrl
        }
      );

      return { success: true, http_status: res.status, run_id: runId, run_url: runUrl };
    }

    const rawErrText = scrubSecrets(await res.text(), env).slice(0, 500);
    const errorMsg = `Stage [dispatch]: GitHub Actions workflow dispatch failed with HTTP ${res.status} — ${rawErrText || 'empty error response'}`;
    const failTime = new Date().toISOString();

    await env.DB.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .bind('failed', errorMsg, failTime, jobId).run();
    await env.DB.prepare(
      `UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('pending', 'publishing')`
    ).bind(errorMsg, failTime, jobId).run();
    await logJobEvent(env.DB, jobId, 'dispatch_failed', 'error', errorMsg, {
      http_status: res.status,
      attempt: attemptNumber,
      source_count: sourceLinks.length,
      github_response: rawErrText
    });

    return { success: false, http_status: res.status, error: errorMsg };
  } catch (err: any) {
    const cleanErr = scrubSecrets(err.message || String(err), env);
    const errorMsg = `Stage [dispatch]: Network error calling GitHub Actions dispatch API — ${cleanErr}`;
    const failTime = new Date().toISOString();

    await env.DB.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .bind('failed', errorMsg, failTime, jobId).run();
    await env.DB.prepare(
      `UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('pending', 'publishing')`
    ).bind(errorMsg, failTime, jobId).run();
    await logJobEvent(env.DB, jobId, 'dispatch_failed', 'error', errorMsg, {
      attempt: attemptNumber,
      source_count: sourceLinks.length
    });

    return { success: false, error: errorMsg };
  }
}

async function verifyExistingReleaseAssets(
  env: Env,
  jobId: string
): Promise<{ reusable: boolean; count: number; reason: string }> {
  if (!env.GITHUB_PAT) {
    return { reusable: false, count: 0, reason: 'GITHUB_PAT unavailable for release verification' };
  }

  const mediaRes = await env.DB.prepare(
    'SELECT * FROM job_media WHERE job_id = ? ORDER BY created_at ASC'
  ).bind(jobId).all<any>();
  const rows = mediaRes.results || [];

  if (rows.length === 0) {
    return { reusable: false, count: 0, reason: 'No processed media rows exist yet for this job' };
  }

  if (rows.some(r => r.status !== 'processed' || !r.release_tag || !r.asset_name || !r.file_size)) {
    return { reusable: false, count: 0, reason: 'Existing media rows are incomplete or failed' };
  }

  const owner = env.GITHUB_OWNER || 'motionssalt';
  const repo = env.GITHUB_REPO || 'salt-relay';
  const releaseCache = new Map<string, any[]>();

  for (const row of rows) {
    const tag = String(row.release_tag);
    if (!releaseCache.has(tag)) {
      try {
        const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
          headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'SaltRelay-Worker/2.1'
          }
        });
        if (!relRes.ok) {
          return { reusable: false, count: 0, reason: `Release tag '${tag}' lookup returned HTTP ${relRes.status}` };
        }
        const relData = await relRes.json() as any;
        releaseCache.set(tag, Array.isArray(relData.assets) ? relData.assets : []);
      } catch (err: any) {
        return { reusable: false, count: 0, reason: `Release lookup error: ${err.message}` };
      }
    }

    const assets = releaseCache.get(tag) || [];
    const match = assets.find((a: any) =>
      (row.asset_id && String(a.id) === String(row.asset_id)) || a.name === row.asset_name
    );

    if (!match) {
      return { reusable: false, count: 0, reason: `Asset '${row.asset_name}' is no longer present on release '${tag}'` };
    }

    if (Number(match.size) !== Number(row.file_size)) {
      return {
        reusable: false,
        count: 0,
        reason: `Asset '${row.asset_name}' size mismatch (recorded ${row.file_size} vs release ${match.size})`
      };
    }

    if (row.sha256 && typeof match.digest === 'string' && match.digest.startsWith('sha256:')) {
      const remoteHex = match.digest.slice('sha256:'.length).toLowerCase();
      if (remoteHex !== String(row.sha256).toLowerCase()) {
        return {
          reusable: false,
          count: 0,
          reason: `Asset '${row.asset_name}' SHA-256 hash mismatch on release '${tag}'`
        };
      }
    }
  }

  return { reusable: true, count: rows.length, reason: 'All processed release assets verified present with matching size/hash' };
}

async function cleanupJobReleaseAssets(env: Env, jobId: string): Promise<void> {
  if (!env.GITHUB_PAT) return;
  const owner = env.GITHUB_OWNER || 'motionssalt';
  const repo = env.GITHUB_REPO || 'salt-relay';

  try {
    const mediaRes = await env.DB.prepare(
      `SELECT id, release_tag, asset_id, asset_name FROM job_media WHERE job_id = ? AND release_tag IS NOT NULL`
    ).bind(jobId).all<any>();
    const rows = mediaRes.results || [];
    for (const row of rows) {
      let targetAssetId = row.asset_id ? String(row.asset_id) : null;
      if (!targetAssetId && row.release_tag && row.asset_name) {
        const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(row.release_tag)}`, {
          headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'SaltRelay-Worker/2.1'
          }
        });
        if (relRes.ok) {
          const relData = await relRes.json() as any;
          const found = (relData.assets || []).find((a: any) => a.name === row.asset_name);
          if (found?.id) targetAssetId = String(found.id);
        }
      }
      if (targetAssetId) {
        await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${targetAssetId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'SaltRelay-Worker/2.1'
          }
        });
      }
    }
  } catch (err) {
    console.warn(`[Cleanup] Non-fatal warning cleaning release assets for ${jobId}:`, err);
  }
}

// -----------------------------------------------------------------------------
// FULL PUBLICATION EXECUTION ENGINE (Per-destination tracking, idempotency, retry)
// -----------------------------------------------------------------------------
async function executePublicationStep(env: Env, jobId: string): Promise<void> {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
  if (!job) return;

  if (job.status === 'cancelled') {
    console.log(`[Publication] Job ${jobId} was cancelled by operator. Aborting publication.`);
    return;
  }

  const now = new Date().toISOString();
  const mediaAssetsRes = await env.DB.prepare('SELECT * FROM job_media WHERE job_id = ? AND status = ?').bind(jobId, 'processed').all<any>();
  const mediaAssets = mediaAssetsRes.results || [];

  // Guard: NEVER publish caption+hashtags without processed media!
  if (mediaAssets.length === 0) {
    const errMsg =
      'Stage [publishing] (field: media): Cannot publish to social accounts because 0 processed media assets are available for this job. Use Retry to run media processing from the saved source links.';
    await env.DB.prepare('UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
      .bind('failed', errMsg, now, jobId).run();
    await env.DB.prepare(
      `UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ?
       WHERE job_id = ? AND status IN ('pending', 'publishing')`
    ).bind(errMsg, now, jobId).run();
    await logJobEvent(env.DB, jobId, 'failed', 'error', errMsg);
    return;
  }

  await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').bind('publishing', now, jobId).run();
  await logJobEvent(env.DB, jobId, 'publishing', 'info', `Commencing social platform publication via Zernio (${mediaAssets.length} processed media item(s)).`);

  const destinationsRes = await env.DB.prepare(
    `SELECT jd.*, a.platform_account_id, a.key_id
     FROM job_destinations jd
     JOIN accounts a ON jd.account_id = a.id
     WHERE jd.job_id = ? AND jd.status IN ('pending', 'failed')`
  ).bind(jobId).all<any>();
  const destinations = destinationsRes.results || [];

  if (destinations.length === 0) {
    await env.DB.prepare('UPDATE jobs SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?').bind('published', now, jobId).run();
    await logJobEvent(env.DB, jobId, 'published', 'info', 'All target destinations were already published or skipped.');
    return;
  }

  const mediaItems: Array<{ url: string; type: 'video' | 'image' }> = mediaAssets.map(m => {
    let url = m.asset_download_url || m.source_url;
    if (m.asset_name && url && url.includes('github.com')) {
      url = `https://salt-relay-api.motionssalt.workers.dev/api/public/media/${jobId}/${encodeURIComponent(m.asset_name)}`;
    }
    return {
      url,
      type: m.file_type === 'video' ? 'video' : 'image'
    };
  });

  // Safe Dry-Run Verification Mode: verifies pipeline end-to-end right up to Zernio without live social posting
  if (Number(job.dry_run) === 1) {
    const finishIso = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE job_destinations SET status = 'skipped', error_message = 'Dry-run verification: skipped live Zernio publish call', updated_at = ?
       WHERE job_id = ? AND status IN ('pending', 'publishing', 'failed')`
    ).bind(finishIso, jobId).run();
    await env.DB.prepare(
      `UPDATE jobs SET status = 'published', error_message = NULL, published_at = ?, updated_at = ? WHERE id = ?`
    ).bind(finishIso, finishIso, jobId).run();
    await logJobEvent(
      env.DB,
      jobId,
      'dry_run_verified',
      'info',
      `Dry-run pipeline verification complete: ${mediaItems.length} processed media URL(s) verified ready for ${destinations.length} destination(s). Live Zernio publish skipped.`,
      { media_items: mediaItems, destinations_checked: destinations.length }
    );
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
  const platformsCaps = (capabilitiesConfig as any).platforms || {};

  for (const dest of destinations) {
    const cap = platformsCaps[dest.platform];
    const attemptTime = new Date().toISOString();

    if (dest.post_type === 'story' && cap && cap.story_support === false) {
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'skipped', error_message = ?, updated_at = ? WHERE id = ?`
      ).bind(`Platform ${dest.platform} does not support Story publishing`, attemptTime, dest.id).run();
      continue;
    }

    // Filter media items compatible with this platform if specified
    const supportedTypes: string[] | undefined = cap?.supported_media;
    const eligibleMedia = Array.isArray(supportedTypes) && supportedTypes.length > 0
      ? mediaItems.filter(mi => supportedTypes.includes(mi.type))
      : mediaItems;

    if (eligibleMedia.length === 0) {
      const skipMsg = `Skipped ${dest.platform} (${dest.post_type}): platform supports [${(supportedTypes || []).join(', ')}] only, no matching media in job.`;
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'skipped', error_message = ?, updated_at = ? WHERE id = ?`
      ).bind(skipMsg, attemptTime, dest.id).run();
      await logJobEvent(env.DB, jobId, 'dest_skipped', 'warn', skipMsg);
      continue;
    }

    const apiKey = keyMap.get(dest.key_id);
    if (!apiKey) {
      const errMsg = `Stage [publishing] (${dest.platform} ${dest.post_type}): Active decrypted Zernio API key not found`;
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(errMsg, attemptTime, attemptTime, dest.id).run();
      await logJobEvent(env.DB, jobId, 'dest_failed', 'error', errMsg);
      continue;
    }

    try {
      const zPayload: any = {
        content: cap?.caption_limit ? fullContent.slice(0, cap.caption_limit) : fullContent,
        mediaItems: eligibleMedia,
        platforms: [{ platform: dest.platform, accountId: dest.platform_account_id }],
        publishNow: true,
        story: dest.post_type === 'story'
      };

      const pubRes = await publishToZernio(apiKey, zPayload);

      if (pubRes.success) {
        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'published', external_post_id = ?, external_post_url = ?, error_message = NULL, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ?`
        ).bind(pubRes.external_post_id || null, pubRes.external_post_url || null, attemptTime, attemptTime, dest.id).run();
        await logJobEvent(
          env.DB,
          jobId,
          'dest_published',
          'info',
          `Successfully published to ${dest.platform} (${dest.post_type}). External ID: ${pubRes.external_post_id || 'ok'}`
        );
      } else {
        const errMsg = pubRes.error || 'Zernio publishing error';
        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
           WHERE id = ?`
        ).bind(errMsg, attemptTime, attemptTime, dest.id).run();
        await logJobEvent(env.DB, jobId, 'dest_failed', 'error', `Failed to publish to ${dest.platform} (${dest.post_type}): ${errMsg}`);
      }
    } catch (publishErr: any) {
      const errMsg = publishErr.message || 'Network error during Zernio publish';
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(errMsg, attemptTime, attemptTime, dest.id).run();
      await logJobEvent(env.DB, jobId, 'dest_failed', 'error', `Exception publishing to ${dest.platform} (${dest.post_type}): ${errMsg}`);
    }
  }

  // Recompute aggregate status across ALL destinations of this job so earlier published destinations are never forgotten
  const allDestsRes = await env.DB.prepare(
    'SELECT platform, post_type, status, error_message FROM job_destinations WHERE job_id = ?'
  ).bind(jobId).all<any>();
  const allDests = allDestsRes.results || [];

  const publishedCount = allDests.filter(d => d.status === 'published').length;
  const failedDests = allDests.filter(d => d.status === 'failed');
  const failedCount = failedDests.length;
  const skippedCount = allDests.filter(d => d.status === 'skipped').length;

  let finalStatus = 'published';
  let summaryError: string | null = null;

  if (publishedCount === 0 && failedCount > 0) {
    finalStatus = 'failed';
    const firstReason = failedDests[0]?.error_message || 'Unknown error';
    summaryError = `Stage [publishing]: Publication failed across all ${failedCount} destination(s) — ${firstReason}`;
  } else if (publishedCount > 0 && failedCount > 0) {
    finalStatus = 'partially_published';
    const firstReason = failedDests[0]?.error_message || 'Unknown error';
    summaryError = `Partial success (${publishedCount} published, ${failedCount} failed): ${firstReason}`;
  } else if (publishedCount === 0 && failedCount === 0) {
    finalStatus = skippedCount > 0 ? 'published' : 'failed';
    if (finalStatus === 'failed') summaryError = 'Stage [publishing]: No active destinations were configured for this job.';
  }

  const finishedTime = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE jobs SET status = ?, error_message = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
  ).bind(finalStatus, summaryError, finalStatus === 'published' ? finishedTime : null, finishedTime, jobId).run();

  await logJobEvent(
    env.DB,
    jobId,
    finalStatus,
    finalStatus === 'failed' ? 'error' : 'info',
    `Publication cycle concluded with status: ${finalStatus}. Published: ${publishedCount}, Failed: ${failedCount}, Skipped: ${skippedCount}`
  );

  // Delete temporary GitHub Release assets ONLY after all dependent destinations have completed (0 failed/pending)
  if (finalStatus === 'published' && failedCount === 0) {
    await cleanupJobReleaseAssets(env, jobId);
  }
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
    if (path.startsWith('/api/public/media/') && (request.method === 'GET' || request.method === 'HEAD')) {
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

      if (media.source_type === 'direct' && media.asset_download_url && !media.asset_download_url.includes('github.com')) {
        return Response.redirect(media.asset_download_url, 302);
      }

      if (env.GITHUB_PAT) {
        const owner = env.GITHUB_OWNER || 'motionssalt';
        const repo = env.GITHUB_REPO || 'salt-relay';
        const tag = media.release_tag || 'media-001';

        try {
          let targetAssetId = media.asset_id ? String(media.asset_id) : null;

          if (!targetAssetId) {
            const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
              headers: {
                'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'SaltRelay-Worker/2.1'
              }
            });
            const relData = await relRes.json().catch(() => ({})) as any;
            const targetAsset = (relData.assets || []).find((a: any) => a.name === assetName);
            if (targetAsset?.id) targetAssetId = String(targetAsset.id);
          }

          if (targetAssetId) {
            const assetRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${targetAssetId}`, {
              headers: {
                'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
                'Accept': 'application/octet-stream',
                'User-Agent': 'SaltRelay-Worker/2.1'
              },
              redirect: 'manual'
            });

            if (assetRes.status >= 300 && assetRes.status < 400) {
              const redirectLocation = assetRes.headers.get('Location');
              if (redirectLocation) {
                return Response.redirect(redirectLocation, 302);
              }
            }

            const contentType = media.file_type === 'video' ? 'video/mp4' : 'image/jpeg';
            return new Response(request.method === 'HEAD' ? null : assetRes.body, {
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

      if (media.asset_download_url && !media.asset_download_url.includes('github.com')) {
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

      const job = await env.DB.prepare('SELECT id, status, error_message, attempt_count FROM jobs WHERE id = ?').bind(jobId).first<any>();
      if (!job) {
        return jsonResponse({ error: 'Job not found' }, 404, {}, request);
      }

      // 1. Refuse to resurrect cancelled jobs
      if (job.status === 'cancelled') {
        console.warn(`[Callback] Job ${jobId} was cancelled by operator. Ignoring callback and not resurrecting.`);
        await logJobEvent(env.DB, jobId, 'callback_ignored', 'warn', 'Callback received for cancelled job; discarded.');
        return jsonResponse({ success: false, message: 'Job was cancelled by operator' }, 200, {}, request);
      }

      const now = new Date().toISOString();

      // 2. Accept late signed callbacks for jobs previously failed by watchdog (F1)
      if (job.status === 'failed') {
        console.log(`[Callback] Valid signed late callback arrived for failed job ${jobId}. Resuming publication.`);
        await logJobEvent(
          env.DB,
          jobId,
          'late_callback_accepted',
          'info',
          'Late signed callback accepted. Resuming unfulfilled destinations.'
        );
        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'pending', error_message = NULL, updated_at = ?
           WHERE job_id = ? AND status = 'failed'`
        ).bind(now, jobId).run();
      }

      // 3. Handle pipeline failure reported from GitHub Actions runner
      if (body.status === 'failed' || (body.failed_count > 0 && body.processed_count === 0) || (Array.isArray(body.media) && body.media.filter((m: any) => m.status === 'processed').length === 0 && body.status !== 'success')) {
        const failureReason = body.error || `Stage [${body.stage || 'media_processing'}]: Media processing failed in GitHub Actions.`;
        await env.DB.prepare(
          `UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`
        ).bind(failureReason, now, jobId).run();

        await env.DB.prepare(
          `UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ?
           WHERE job_id = ? AND status IN ('pending', 'publishing')`
        ).bind(failureReason, now, jobId).run();

        await logJobEvent(env.DB, jobId, 'transcode_failed', 'error', failureReason, {
          stage: body.stage || 'media_processing',
          attempt: body.attempt || job.attempt_count || 1,
          error: failureReason
        });

        return jsonResponse({ success: true, message: 'Pipeline failure recorded' }, 200, {}, request);
      }

      // 4. Replace processed media rows for this job cleanly (never mutating immutable job_sources!)
      const mediaList = Array.isArray(body.media) ? body.media : [];
      await env.DB.prepare('DELETE FROM job_media WHERE job_id = ?').bind(jobId).run();

      for (const m of mediaList) {
        await env.DB.prepare(
          `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, mime_type, file_size, width, height, duration_sec, release_tag, asset_id, asset_name, asset_download_url, sha256, status, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          body.release_tag || m.release_tag || null,
          m.asset_id ? String(m.asset_id) : null,
          m.asset_name || m.filename || null,
          m.asset_download_url || null,
          m.sha256 || null,
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
        `GitHub Actions processing completed. ${body.processed_count || mediaList.filter((m: any) => m.status === 'processed').length} media asset(s) verified on release ${body.release_tag || 'media-001'}.`,
        { release_tag: body.release_tag, attempt: body.attempt || job.attempt_count || 1 }
      );

      ctx.waitUntil(executePublicationStep(env, jobId));

      return jsonResponse({ success: true, message: 'Media recorded, publication initiated' }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // CRON & DISPATCH TRIGGER (Authenticated with GITHUB_PAT)
    // -------------------------------------------------------------------------
    if (path === '/api/public/trigger-scheduled' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (env.GITHUB_PAT && constantTimeCompare(token, env.GITHUB_PAT.trim())) {
        await this.scheduled({ scheduledTime: Date.now(), cron: 'manual' }, env, ctx);
        return jsonResponse({ success: true, message: 'Scheduled cron & watchdog execution concluded' }, 200, {}, request);
      }
      return jsonResponse({ error: 'Unauthorized' }, 401, {}, request);
    }

    if (path.startsWith('/api/public/dispatch-job/') && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (env.GITHUB_PAT && constantTimeCompare(token, env.GITHUB_PAT.trim())) {
        const jobId = path.replace('/api/public/dispatch-job/', '');
        const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
        if (!job) return jsonResponse({ error: 'Job not found' }, 404, {}, request);
        const { sources } = await resolveOrRecoverJobSources(env.DB, job);
        if (sources.length === 0) {
          return jsonResponse({ error: LEGACY_NO_SOURCES_MESSAGE }, 400, {}, request);
        }
        await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
          .bind('processing', new Date().toISOString(), jobId).run();
        const dispatchRes = await dispatchMediaWorkflow(env, jobId, sources.map(s => s.source_url), Number(job.attempt_count) || 1);
        return jsonResponse(dispatchRes, dispatchRes.success ? 200 : 502, {}, request);
      }
      return jsonResponse({ error: 'Unauthorized' }, 401, {}, request);
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
      const { results = [] } = await env.DB.prepare(
        'SELECT * FROM accounts ORDER BY platform ASC, name ASC'
      ).all();

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
    // DRIVE & LINK INSPECTION (Supports folders & single file links with real checks)
    // -------------------------------------------------------------------------
    if (path === '/api/drive/inspect' && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as any;
      const targetUrl = (body.url || '').trim();
      if (!targetUrl) return jsonResponse({ error: 'Field [url]: Media source URL is required for inspection.' }, 400, {}, request);

      const check = classifySourceUrl(targetUrl);
      if (!check.valid || !check.kind) {
        return jsonResponse({ success: false, files: [], error: check.reason }, 400, {}, request);
      }

      if (check.kind === 'drive_folder') {
        const match = targetUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
        const folderId = match ? match[1] : null;
        try {
          const embedResp = await fetch(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' }
          });
          const embedHtml = await embedResp.text();
          if (embedHtml.includes('accounts.google.com/ServiceLogin')) {
            return jsonResponse({
              success: false,
              files: [],
              error: `Google Drive folder '${targetUrl}' is private. Set sharing to 'Anyone with the link'.`
            }, 200, {}, request);
          }

          const fileIds = new Set<string>();
          const entryRegex = /(?:\/file\/d\/|id="entry-)([a-zA-Z0-9_-]{20,})/g;
          let m;
          while ((m = entryRegex.exec(embedHtml)) !== null) {
            if (m[1] !== folderId) fileIds.add(m[1]);
          }

          if (fileIds.size === 0) {
            const resp = await fetch(`https://drive.google.com/drive/folders/${folderId}`, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const html = await resp.text();
            const fallbackRegex = /(?:\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]{25,45})/g;
            while ((m = fallbackRegex.exec(html)) !== null) {
              if (m[1] !== folderId && !m[1].includes('google')) fileIds.add(m[1]);
            }
          }

          const files = Array.from(fileIds).slice(0, 50).map((id, idx) => ({
            url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
            source_type: 'drive',
            name: `drive_asset_${idx + 1}`,
            file_type: 'video',
            accessible: true
          }));
          return jsonResponse({ success: true, files }, 200, {}, request);
        } catch (err: any) {
          return jsonResponse({ success: false, files: [], error: err.message }, 200, {}, request);
        }
      } else if (check.kind === 'drive_file') {
        const match = targetUrl.match(/(?:\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]+)/);
        const fileId = match ? match[1] : null;
        const dlUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
        let accessible = true;
        let fileType = 'video';
        try {
          const headRes = await fetch(dlUrl, { method: 'HEAD' });
          const ct = (headRes.headers.get('content-type') || '').toLowerCase();
          if (headRes.status === 404 || headRes.status === 401 || headRes.status === 403) accessible = false;
          if (ct.startsWith('image/')) fileType = 'image';
        } catch {}
        return jsonResponse({
          success: accessible,
          files: accessible ? [{
            url: dlUrl,
            source_type: 'drive',
            name: `drive_file_${fileId || 'asset'}`,
            file_type: fileType,
            accessible
          }] : [],
          error: accessible ? undefined : `Google Drive file '${targetUrl}' is not publicly accessible.`
        }, 200, {}, request);
      } else {
        const isVideo = /\.(mp4|mov|webm|m4v)$/i.test(targetUrl.split('?')[0]);
        let accessible = true;
        let detectedType = isVideo ? 'video' : 'image';
        try {
          const headRes = await fetch(targetUrl, { method: 'HEAD' });
          if (headRes.status === 404 || headRes.status === 401 || headRes.status === 403) accessible = false;
          const ct = (headRes.headers.get('content-type') || '').toLowerCase();
          if (ct.startsWith('video/')) detectedType = 'video';
          else if (ct.startsWith('image/')) detectedType = 'image';
        } catch {}
        return jsonResponse({
          success: accessible,
          files: accessible ? [{
            url: targetUrl,
            source_type: 'direct',
            name: targetUrl.split('?')[0].split('/').pop() || 'media_asset',
            file_type: detectedType,
            accessible
          }] : [],
          error: accessible ? undefined : `Direct URL '${targetUrl}' returned inaccessible HTTP status.`
        }, 200, {}, request);
      }
    }

    // -------------------------------------------------------------------------
    // JOBS LIST & DETAILS
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
      const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
      if (!job) return jsonResponse({ error: 'Job not found' }, 404, {}, request);

      const { sources } = await resolveOrRecoverJobSources(env.DB, job);
      const mediaRes = await env.DB.prepare('SELECT * FROM job_media WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all();
      const destRes = await env.DB.prepare('SELECT * FROM job_destinations WHERE job_id = ? ORDER BY platform ASC').bind(jobId).all();
      const logsRes = await env.DB.prepare('SELECT * FROM execution_logs WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all();

      let events: any[] = [];
      try {
        const eventsRes = await env.DB.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all();
        events = eventsRes.results || [];
      } catch {}

      return jsonResponse({
        job: {
          ...job,
          attempt_count: Number(job.attempt_count) || 1,
          sources_json: job.sources_json || JSON.stringify(sources.map(s => s.source_url))
        },
        sources,
        media: mediaRes.results || [],
        destinations: destRes.results || [],
        logs: logsRes.results || [],
        events
      }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // CREATE POST (F5: Strict source validation, immutable storage, immediate/accurate dispatch)
    // -------------------------------------------------------------------------
    if (path === '/api/jobs' && request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as any;
      const {
        caption = '',
        hashtags = '',
        publish_mode = 'now',
        scheduled_at,
        timezone = 'Africa/Lagos',
        story_enabled = false,
        selected_destinations = [],
        dry_run = false
      } = body;

      const submittedLinks = body.links ?? body.sources ?? body.media_links ?? [];
      const sourceValidation = validateSubmittedSources(submittedLinks);

      if (!sourceValidation.valid) {
        return jsonResponse({
          error: sourceValidation.error,
          stage: sourceValidation.stage || 'create_validation',
          field: sourceValidation.field || 'links'
        }, 400, {}, request);
      }

      if (!['now', 'queue', 'schedule'].includes(publish_mode)) {
        return jsonResponse({
          error: `Validation failed [stage: create_validation, field: publish_mode]: Unsupported publish_mode '${publish_mode}'.`,
          stage: 'create_validation',
          field: 'publish_mode'
        }, 400, {}, request);
      }

      let finalSchedule: string | null = null;
      let shouldDispatchImmediately = publish_mode === 'now';

      if (publish_mode === 'schedule') {
        const norm = normalizeScheduleToUtcIso(scheduled_at, timezone);
        if (!norm.valid || !norm.iso) {
          return jsonResponse({
            error: `Validation failed [stage: create_validation, field: scheduled_at]: ${norm.error || 'A valid scheduled_at date/time is required when publish_mode is schedule.'}`,
            stage: 'create_validation',
            field: 'scheduled_at'
          }, 400, {}, request);
        }
        finalSchedule = norm.iso;
        // If scheduled time is already due (or within 30s), dispatch immediately instead of stalling!
        if (new Date(finalSchedule).getTime() <= Date.now() + 30 * 1000) {
          shouldDispatchImmediately = true;
        }
      } else if (publish_mode === 'queue') {
        finalSchedule = await calculateNextQueueSlotD1(env.DB);
      }

      const accRes = await env.DB.prepare('SELECT * FROM accounts WHERE is_active = 1').all<any>();
      const allAccs = accRes.results || [];
      const targets = Array.isArray(selected_destinations) && selected_destinations.length > 0
        ? allAccs.filter((a: any) => selected_destinations.includes(a.id))
        : allAccs;

      if (targets.length === 0) {
        return jsonResponse({
          error: 'Validation failed [stage: create_validation, field: selected_destinations]: At least one connected active social destination account is required.',
          stage: 'create_validation',
          field: 'selected_destinations'
        }, 400, {}, request);
      }

      const jobId = `job_${crypto.randomUUID().slice(0, 10)}`;
      const now = new Date().toISOString();
      const cleanLinks = sourceValidation.sources.map(s => s.source_url);
      const sourcesJsonStr = JSON.stringify(cleanLinks);
      const initialStatus = shouldDispatchImmediately ? 'processing' : 'scheduled';
      const isDryRun = dry_run === true || dry_run === 1 ? 1 : 0;

      await env.DB.prepare(
        `INSERT INTO jobs (id, caption, hashtags, raw_links_json, sources_json, publish_mode, status, story_enabled, scheduled_at, timezone, attempt_count, dry_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(
        jobId,
        String(caption || '').trim(),
        String(hashtags || '').trim(),
        sourcesJsonStr,
        sourcesJsonStr,
        publish_mode,
        initialStatus,
        story_enabled ? 1 : 0,
        finalSchedule,
        timezone,
        isDryRun,
        now,
        now
      ).run();

      // Persist immutable normalized rows in job_sources
      await saveImmutableJobSources(env.DB, jobId, sourceValidation.sources, now);

      await logJobEvent(
        env.DB,
        jobId,
        'created',
        'info',
        `Job created with publish_mode: ${publish_mode} and ${cleanLinks.length} immutable media source link(s)${isDryRun ? ' [DRY RUN]' : ''}.`,
        {
          publish_mode,
          scheduled_at: finalSchedule,
          source_count: cleanLinks.length,
          sources: sourceValidation.sources,
          dry_run: Boolean(isDryRun)
        }
      );

      // Insert destination rows (respecting story_support capability)
      const platformsCaps = (capabilitiesConfig as any).platforms || {};
      for (const acc of targets) {
        const idempotency = crypto.createHash('sha256').update(`${jobId}:${acc.id}:feed`).digest('hex').slice(0, 32);
        await env.DB.prepare(
          `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'feed', ?, 'pending', ?, ?)`
        ).bind(`dest_${crypto.randomUUID().slice(0, 8)}`, jobId, acc.id, acc.platform, idempotency, now, now).run();

        if (story_enabled) {
          const cap = platformsCaps[acc.platform];
          const storySupported = !cap || cap.story_support !== false;
          const storyIdempotency = crypto.createHash('sha256').update(`${jobId}:${acc.id}:story`).digest('hex').slice(0, 32);
          await env.DB.prepare(
            `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, error_message, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'story', ?, ?, ?, ?, ?)`
          ).bind(
            `dest_story_${crypto.randomUUID().slice(0, 8)}`,
            jobId,
            acc.id,
            acc.platform,
            storyIdempotency,
            storySupported ? 'pending' : 'skipped',
            storySupported ? null : `Platform ${acc.platform} does not support Stories`,
            now,
            now
          ).run();
        }
      }

      if (shouldDispatchImmediately) {
        await logJobEvent(
          env.DB,
          jobId,
          'dispatching',
          'info',
          `Attempt #1: Triggering GitHub Actions media workflow (process-media.yml) for ${cleanLinks.length} source link(s).`,
          { attempt: 1, sources: cleanLinks }
        );

        const dispatchRes = await dispatchMediaWorkflow(env, jobId, cleanLinks, 1);

        if (!dispatchRes.success) {
          return jsonResponse({
            success: false,
            job_id: jobId,
            publish_mode,
            status: 'failed',
            stage: 'dispatch',
            error: dispatchRes.error
          }, 502, {}, request);
        }

        return jsonResponse({
          success: true,
          job_id: jobId,
          publish_mode,
          status: 'processing',
          scheduled_at: finalSchedule,
          workflow_run_id: dispatchRes.run_id || null,
          workflow_run_url: dispatchRes.run_url || null
        }, 200, {}, request);
      }

      return jsonResponse({
        success: true,
        job_id: jobId,
        publish_mode,
        status: 'scheduled',
        scheduled_at: finalSchedule
      }, 200, {}, request);
    }

    // -------------------------------------------------------------------------
    // RETRY ACTION (F6: Rebuilds from immutable original sources, smart asset reuse, idempotent)
    // -------------------------------------------------------------------------
    if (path.endsWith('/retry') && request.method === 'POST') {
      const jobId = path.replace('/api/jobs/', '').replace('/retry', '');
      const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first<any>();
      if (!job) return jsonResponse({ error: 'Job not found' }, 404, {}, request);

      if (job.status === 'cancelled') {
        return jsonResponse({ error: 'Cancelled jobs cannot be retried. Create a new post if needed.' }, 400, {}, request);
      }

      if (job.status === 'processing' || job.status === 'publishing') {
        return jsonResponse({ error: `Job is already actively ${job.status}.` }, 409, {}, request);
      }

      const unfulfilled = await env.DB.prepare(
        `SELECT count(*) as count FROM job_destinations WHERE job_id = ? AND status IN ('pending', 'failed')`
      ).bind(jobId).first<{ count: number }>();

      if (!unfulfilled || unfulfilled.count === 0) {
        return jsonResponse({ error: 'All destinations are already published or skipped. Nothing to retry.' }, 400, {}, request);
      }

      // Resolve immutable original sources (with automatic legacy backfill if recoverable)
      const { sources, recovered } = await resolveOrRecoverJobSources(env.DB, job);
      if (sources.length === 0) {
        await logJobEvent(env.DB, jobId, 'retry_blocked', 'error', LEGACY_NO_SOURCES_MESSAGE);
        return jsonResponse({
          error: LEGACY_NO_SOURCES_MESSAGE,
          stage: 'retry_validation',
          field: 'links'
        }, 400, {}, request);
      }

      const sourceUrls = sources.map(s => s.source_url);
      const newAttempt = (Number(job.attempt_count) || 1) + 1;
      const now = new Date().toISOString();

      // Reset ONLY failed destinations back to pending (never touch published or skipped destinations -> strict idempotency!)
      await env.DB.prepare(
        `UPDATE job_destinations SET status = 'pending', error_message = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'failed'`
      ).bind(now, jobId).run();

      // F6.2: Check if valid processed release assets already exist on GitHub Release (size + hash verified)
      const assetCheck = await verifyExistingReleaseAssets(env, jobId);

      if (assetCheck.reusable) {
        await env.DB.prepare(
          `UPDATE jobs SET status = 'publishing', attempt_count = ?, error_message = NULL, updated_at = ? WHERE id = ?`
        ).bind(newAttempt, now, jobId).run();

        await logJobEvent(
          env.DB,
          jobId,
          'retried',
          'info',
          `Attempt #${newAttempt}: Verified ${assetCheck.count} processed release asset(s) (size/hash matched); skipping reprocessing and retrying ${unfulfilled.count} unfulfilled destination(s).`,
          { attempt: newAttempt, mode: 'reused_verified_assets', verified_assets: assetCheck.count, recovered_sources: recovered }
        );

        ctx.waitUntil(executePublicationStep(env, jobId));

        return jsonResponse({
          success: true,
          attempt: newAttempt,
          mode: 'reused_verified_assets',
          message: `Attempt #${newAttempt}: Verified ${assetCheck.count} existing release asset(s); retrying ${unfulfilled.count} destination(s).`
        }, 200, {}, request);
      }

      // Otherwise re-run processing from immutable original sources
      await env.DB.prepare('DELETE FROM job_media WHERE job_id = ?').bind(jobId).run();
      await env.DB.prepare(
        `UPDATE jobs SET status = 'processing', attempt_count = ?, error_message = NULL, workflow_run_id = NULL, workflow_run_url = NULL, updated_at = ? WHERE id = ?`
      ).bind(newAttempt, now, jobId).run();

      await logJobEvent(
        env.DB,
        jobId,
        'retried',
        'info',
        `Attempt #${newAttempt}: Re-dispatching media processing workflow from ${sourceUrls.length} saved source link(s) for ${unfulfilled.count} unfulfilled destination(s).`,
        {
          attempt: newAttempt,
          mode: 're_dispatched_workflow',
          sources: sourceUrls,
          recovered_sources: recovered,
          reuse_skipped_reason: assetCheck.reason
        }
      );

      const dispatchRes = await dispatchMediaWorkflow(env, jobId, sourceUrls, newAttempt);

      if (!dispatchRes.success) {
        return jsonResponse({
          success: false,
          attempt: newAttempt,
          stage: 'dispatch',
          error: dispatchRes.error
        }, 502, {}, request);
      }

      return jsonResponse({
        success: true,
        attempt: newAttempt,
        mode: 're_dispatched_workflow',
        workflow_run_id: dispatchRes.run_id || null,
        workflow_run_url: dispatchRes.run_url || null,
        message: `Attempt #${newAttempt}: Dispatched GitHub Actions media workflow (${sourceUrls.length} source link(s)) for ${unfulfilled.count} destination(s).`
      }, 200, {}, request);
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
      const configRow = await env.DB.prepare('SELECT * FROM queue_settings WHERE id = "singleton"').first<any>();
      const queuedJobs = await env.DB.prepare(
        `SELECT * FROM jobs WHERE status IN ('scheduled', 'pending', 'processing') ORDER BY scheduled_at ASC, created_at ASC`
      ).all();

      let dailyTimes = ['09:00', '14:00', '19:00'];
      try {
        if (configRow?.daily_times_json) dailyTimes = JSON.parse(configRow.daily_times_json);
      } catch {}

      const nextSlot = await calculateNextQueueSlotD1(env.DB);
      return jsonResponse({
        config: configRow
          ? { ...configRow, daily_times: dailyTimes, is_active: configRow.is_active === 1 }
          : { posts_per_day: 3, daily_times: ['09:00', '14:00', '19:00'], timezone: 'Africa/Lagos', is_active: true },
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
  // CRON TRIGGER & INTELLIGENT WATCHDOG HANDLER (Every 5 minutes)
  // ---------------------------------------------------------------------------
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();
    console.log(`[Watchdog & Cron] Heartbeat triggered at ${nowIso}`);

    // 1. INTELLIGENT WATCHDOG: Track real GitHub Actions run state instead of blind timer (F3)
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const activeJobs = await env.DB.prepare(
        `SELECT id, status, caption, created_at, updated_at, workflow_run_id, workflow_run_url, attempt_count FROM jobs
         WHERE status IN ('pending', 'processing')
           AND updated_at <= ?
         LIMIT 10`
      ).bind(tenMinutesAgo).all<any>();

      for (const job of (activeJobs.results || [])) {
        const createdAtMs = new Date(job.created_at).getTime();
        const elapsedMinutes = Math.floor((Date.now() - createdAtMs) / (60 * 1000));
        const owner = env.GITHUB_OWNER || 'motionssalt';
        const repo = env.GITHUB_REPO || 'salt-relay';

        if (job.workflow_run_id && env.GITHUB_PAT) {
          try {
            const runRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs/${job.workflow_run_id}`, {
              headers: {
                'Authorization': `Bearer ${env.GITHUB_PAT.trim()}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'SaltRelay-Worker/2.1'
              }
            });

            if (runRes.ok) {
              const runData = await runRes.json() as any;
              const runStatus = runData.status;
              const runConclusion = runData.conclusion;
              const runUrl = runData.html_url || job.workflow_run_url;

              if (runStatus === 'queued' || runStatus === 'in_progress') {
                if (elapsedMinutes < 45) {
                  await env.DB.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`).bind(nowIso, job.id).run();
                  await logJobEvent(
                    env.DB,
                    job.id,
                    'watchdog_extended',
                    'info',
                    `Workflow run #${job.workflow_run_id} is currently ${runStatus} in GitHub Actions (${elapsedMinutes}m elapsed). Deadline extended.`,
                    { run_url: runUrl, elapsed_minutes: elapsedMinutes }
                  );
                  continue;
                } else {
                  const reason = `Stage [transcoding]: GitHub Actions run #${job.workflow_run_id} exceeded 45-minute hard limit. Inspect run: ${runUrl}`;
                  await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
                    .bind(reason, nowIso, job.id).run();
                  await env.DB.prepare(`UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'publishing')`)
                    .bind('Terminated due to 45m hard timeout', nowIso, job.id).run();
                  await logJobEvent(env.DB, job.id, 'watchdog_timeout', 'error', reason, { run_url: runUrl });
                  continue;
                }
              }

              if (runStatus === 'completed') {
                if (runConclusion === 'failure' || runConclusion === 'timed_out') {
                  const reason = `Stage [transcoding]: GitHub Actions run #${job.workflow_run_id} failed (${runConclusion}). Inspect run log: ${runUrl}`;
                  await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
                    .bind(reason, nowIso, job.id).run();
                  await env.DB.prepare(`UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'publishing')`)
                    .bind(`Media transcode failed in GitHub Actions: ${runConclusion}`, nowIso, job.id).run();
                  await logJobEvent(env.DB, job.id, 'transcode_failed', 'error', reason, { run_url: runUrl, conclusion: runConclusion });
                  continue;
                } else if (runConclusion === 'cancelled') {
                  const reason = `Stage [transcoding]: GitHub Actions run #${job.workflow_run_id} was cancelled. Inspect run: ${runUrl}`;
                  await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
                    .bind(reason, nowIso, job.id).run();
                  await logJobEvent(env.DB, job.id, 'transcode_cancelled', 'warn', reason, { run_url: runUrl });
                  continue;
                } else if (runConclusion === 'success') {
                  const runUpdated = new Date(runData.updated_at || runData.created_at).getTime();
                  const sinceRunEndMin = Math.floor((Date.now() - runUpdated) / (60 * 1000));
                  if (sinceRunEndMin >= 3) {
                    const reason = `Stage [callback]: GitHub Actions run #${job.workflow_run_id} succeeded, but signed callback was never received by Worker. Inspect run: ${runUrl}. Retry available.`;
                    await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
                      .bind(reason, nowIso, job.id).run();
                    await env.DB.prepare(`UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'publishing')`)
                      .bind('Callback never received from GitHub Actions', nowIso, job.id).run();
                    await logJobEvent(env.DB, job.id, 'callback_missing', 'error', reason, { run_url: runUrl });
                    continue;
                  }
                }
              }
            }
          } catch (ghCheckErr: any) {
            console.warn(`[Watchdog] Error querying GitHub run #${job.workflow_run_id}:`, ghCheckErr.message);
          }
        }

        if (elapsedMinutes >= 30) {
          const reason = `Stage [${job.status}]: Watchdog timeout — job remained in '${job.status}' for ${elapsedMinutes} minutes without an active workflow run.`;
          await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
            .bind(reason, nowIso, job.id).run();
          await env.DB.prepare(`UPDATE job_destinations SET status = 'failed', error_message = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'publishing')`)
            .bind('Terminated due to 30m watchdog timeout', nowIso, job.id).run();
          await logJobEvent(env.DB, job.id, 'watchdog_timeout', 'error', reason);
        }
      }

      const stuckPublishing = await env.DB.prepare(
        `SELECT id, status, updated_at FROM jobs WHERE status = 'publishing' AND updated_at <= ? LIMIT 5`
      ).bind(new Date(Date.now() - 20 * 60 * 1000).toISOString()).all<any>();

      for (const job of (stuckPublishing.results || [])) {
        const reason = `Stage [publishing]: Publication timeout — job remained in 'publishing' status for over 20 minutes.`;
        await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
          .bind(reason, nowIso, job.id).run();
        await logJobEvent(env.DB, job.id, 'publishing_timeout', 'error', reason);
      }
    } catch (watchdogErr) {
      console.error('[Watchdog] Error running timeout checks:', watchdogErr);
    }

    // 2. CRON DISPATCH: Activate due scheduled jobs from immutable job_sources
    try {
      const { results } = await env.DB.prepare(
        `SELECT * FROM jobs
         WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
         ORDER BY scheduled_at ASC LIMIT 5`
      ).bind(nowIso).all<any>();

      for (const job of (results || [])) {
        console.log(`[Cron Trigger] Activating due scheduled job: ${job.id}`);
        const { sources } = await resolveOrRecoverJobSources(env.DB, job);
        if (sources.length === 0) {
          const reason = `Stage [scheduled_dispatch] (field: links): Scheduled job ${job.id} has no saved media source links and cannot dispatch.`;
          await env.DB.prepare(`UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
            .bind(reason, nowIso, job.id).run();
          await logJobEvent(env.DB, job.id, 'dispatch_failed', 'error', reason);
          continue;
        }

        const sourceUrls = sources.map(s => s.source_url);
        const attemptNum = Number(job.attempt_count) || 1;
        await env.DB.prepare(`UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ?`)
          .bind(nowIso, job.id).run();
        await logJobEvent(
          env.DB,
          job.id,
          'scheduled_trigger',
          'info',
          `Scheduled job due; dispatching GitHub Actions media workflow for ${sourceUrls.length} source link(s).`,
          { attempt: attemptNum, sources: sourceUrls }
        );

        ctx.waitUntil(dispatchMediaWorkflow(env, job.id, sourceUrls, attemptNum));
      }
    } catch (cronErr) {
      console.error('[Cron Trigger] Error running scheduled jobs:', cronErr);
    }
  }
};
