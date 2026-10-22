import express from 'express';
import { createServer as createViteServer } from 'vite';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { queryD1, executeD1 } from './server/db.ts';
import { encryptApiKey, decryptApiKey } from './server/crypto.ts';
import { fetchZernioAccounts, publishToZernio } from './server/zernio.ts';
import { checkDirectLink, parseDriveFolder } from './server/drive.ts';
import { loadCapabilities, planJobDestinations } from './server/distribution.ts';
import { dispatchMediaWorkflow, deleteReleaseAsset } from './server/github.ts';
import { getQueueConfig, calculateNextQueueSlot } from './server/queue.ts';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DASHBOARD_PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH || '';
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || '';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// In-memory sessions & failed login attempts
const activeSessions = new Set<string>();
const failedLoginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(candidate: string): boolean {
  if (!candidate) return false;
  if (DASHBOARD_PASSWORD_HASH) {
    const parts = DASHBOARD_PASSWORD_HASH.split(':');
    if (parts.length === 4 && parts[0] === 'pbkdf2') {
      const iterations = parseInt(parts[1], 10);
      const salt = Buffer.from(parts[2], 'hex');
      const expected = parts[3];
      const derived = crypto.pbkdf2Sync(candidate, salt, iterations, 32, 'sha256').toString('hex');
      return constantTimeCompare(derived, expected);
    }
  }
  if (DASHBOARD_PASSWORD) {
    return constantTimeCompare(candidate.trim(), DASHBOARD_PASSWORD.trim());
  }
  return false;
}

app.use(express.json());

// Helper auth middleware
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/salt_relay_session=([a-zA-Z0-9_-]+)/);
  const token = req.headers.authorization?.replace('Bearer ', '') ||
    (req.headers['x-session-token'] as string) ||
    (cookieMatch ? cookieMatch[1] : '');

  if (token && activeSessions.has(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please sign in with dashboard password.' });
}

// -----------------------------------------------------------------------------
// AUTH ROUTES
// -----------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attemptInfo = failedLoginAttempts.get(clientIp);

  if (attemptInfo && attemptInfo.lockedUntil > now) {
    const remainingMin = Math.ceil((attemptInfo.lockedUntil - now) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Locked for ${remainingMin} minute(s).` });
  }

  const { password } = req.body;
  if (!password || !verifyPassword(password)) {
    const current = (attemptInfo?.count || 0) + 1;
    let lockedUntil = 0;
    if (current >= 5) {
      lockedUntil = now + 15 * 60 * 1000;
    }
    failedLoginAttempts.set(clientIp, { count: current, lockedUntil });
    return res.status(401).json({ error: 'Invalid dashboard password.' });
  }

  failedLoginAttempts.delete(clientIp);
  const sessionToken = crypto.randomBytes(32).toString('hex');
  activeSessions.add(sessionToken);

  res.setHeader('Set-Cookie', `salt_relay_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
  res.json({ success: true, token: sessionToken });
});

app.get('/api/auth/check', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/salt_relay_session=([a-zA-Z0-9_-]+)/);
  const token = req.headers.authorization?.replace('Bearer ', '') ||
    (req.headers['x-session-token'] as string) ||
    (cookieMatch ? cookieMatch[1] : '');

  res.json({ authenticated: token ? activeSessions.has(token) : false });
});

app.post('/api/auth/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/salt_relay_session=([a-zA-Z0-9_-]+)/);
  const token = req.headers.authorization?.replace('Bearer ', '') ||
    (req.headers['x-session-token'] as string) ||
    (cookieMatch ? cookieMatch[1] : '');

  if (token) activeSessions.delete(token);
  res.setHeader('Set-Cookie', `salt_relay_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ success: true });
});

// -----------------------------------------------------------------------------
// API KEYS ROUTES
// -----------------------------------------------------------------------------
app.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const keys = await queryD1<{
      id: string;
      label: string;
      masked_key: string;
      is_active: number;
      created_at: string;
    }>('SELECT id, label, masked_key, is_active, created_at FROM api_keys ORDER BY created_at DESC');

    const accountsCount = await queryD1<{ key_id: string; count: number }>(
      'SELECT key_id, count(*) as count FROM accounts GROUP BY key_id'
    );
    const countMap = new Map(accountsCount.map(a => [a.key_id, a.count]));

    const result = keys.map(k => ({
      ...k,
      is_active: k.is_active === 1,
      connected_accounts_count: countMap.get(k.id) || 0
    }));

    res.json({ keys: result });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/keys', requireAuth, async (req, res) => {
  try {
    const { label, key } = req.body;
    if (!label || !key) {
      return res.status(400).json({ error: 'Label and API key are required' });
    }

    const { encrypted, iv, masked } = encryptApiKey(key.trim());
    const id = `key_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    await executeD1(
      `INSERT INTO api_keys (id, label, encrypted_key, iv, masked_key, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, label.trim(), encrypted, iv, masked, now, now]
    );

    res.json({ success: true, key: { id, label: label.trim(), masked_key: masked, is_active: true } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await executeD1('DELETE FROM accounts WHERE key_id = ?', [id]);
    await executeD1('DELETE FROM api_keys WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// ACCOUNTS ROUTES
// -----------------------------------------------------------------------------
app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await queryD1<{
      id: string;
      platform: string;
      platform_account_id: string;
      name: string;
      username: string;
      avatar_url: string;
      key_id: string;
      is_active: number;
      last_synced_at: string;
    }>('SELECT * FROM accounts ORDER BY platform ASC, name ASC');

    const keys = await queryD1<{ id: string; label: string }>('SELECT id, label FROM api_keys');
    const keyMap = new Map(keys.map(k => [k.id, k.label]));

    const formatted = accounts.map(a => ({
      ...a,
      is_active: a.is_active === 1,
      key_label: keyMap.get(a.key_id) || 'Unknown Key'
    }));

    res.json({ accounts: formatted });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/sync', requireAuth, async (req, res) => {
  try {
    const keys = await queryD1<{
      id: string;
      label: string;
      encrypted_key: string;
      iv: string;
    }>('SELECT id, label, encrypted_key, iv FROM api_keys WHERE is_active = 1');

    if (keys.length === 0) {
      return res.status(400).json({ error: 'No active Zernio API keys configured. Please add a key first.' });
    }

    let totalDiscovered = 0;
    const errors: Array<{ key_label: string; error: string }> = [];

    for (const k of keys) {
      try {
        const decryptedKey = decryptApiKey(k.encrypted_key, k.iv);
        const fetchRes = await fetchZernioAccounts(decryptedKey);

        if (!fetchRes.success) {
          errors.push({ key_label: k.label, error: fetchRes.error || 'Sync failed' });
          continue;
        }

        const now = new Date().toISOString();
        for (const acc of fetchRes.accounts) {
          totalDiscovered++;
          const accountDbId = `acc_${acc.platform}_${acc.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

          await executeD1(
            `INSERT INTO accounts (id, platform, platform_account_id, name, username, avatar_url, key_id, is_active, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(platform, platform_account_id) DO UPDATE SET
               name = excluded.name,
               username = excluded.username,
               avatar_url = excluded.avatar_url,
               key_id = excluded.key_id,
               last_synced_at = excluded.last_synced_at`,
            [accountDbId, acc.platform, acc.id, acc.name, acc.username, acc.avatar_url || null, k.id, now]
          );
        }
      } catch (err: any) {
        errors.push({ key_label: k.label, error: err.message });
      }
    }

    res.json({
      success: true,
      total_accounts_synced: totalDiscovered,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// CAPABILITIES & DRIVE INSPECTION
// -----------------------------------------------------------------------------
app.get('/api/capabilities', requireAuth, (req, res) => {
  const caps = loadCapabilities();
  res.json({ platforms: caps });
});

app.post('/api/drive/inspect', requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    if (url.includes('drive.google.com/drive/folders/')) {
      const driveResult = await parseDriveFolder(url, process.env.GOOGLE_DRIVE_API_KEY);
      return res.json(driveResult);
    } else if (url.includes('drive.google.com/file/d/')) {
      const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      const fileId = match ? match[1] : null;
      return res.json({
        success: true,
        files: [{
          url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`,
          source_type: 'drive',
          name: `drive_file_${fileId || 'asset'}`,
          file_type: 'unknown',
          accessible: true
        }]
      });
    } else {
      const direct = await checkDirectLink(url);
      return res.json({ success: direct.accessible, files: [direct] });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// JOBS & PUBLISHING ROUTES
// -----------------------------------------------------------------------------
app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const { status, limit = '50' } = req.query;
    let sql = 'SELECT * FROM jobs';
    const params: any[] = [];

    if (status && status !== 'all') {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(parseInt(limit as string, 10));

    const jobs = await queryD1<any>(sql, params);
    res.json({ jobs });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const jobs = await queryD1<any>('SELECT * FROM jobs WHERE id = ?', [id]);
    if (!jobs || jobs.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobs[0];
    const media = await queryD1<any>('SELECT * FROM job_media WHERE job_id = ? ORDER BY created_at ASC', [id]);
    const destinations = await queryD1<any>('SELECT * FROM job_destinations WHERE job_id = ? ORDER BY platform ASC', [id]);
    const logs = await queryD1<any>('SELECT * FROM execution_logs WHERE job_id = ? ORDER BY created_at ASC', [id]);

    res.json({
      job,
      media,
      destinations,
      logs
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    const {
      caption,
      hashtags = '',
      links = [],
      publish_mode = 'now', // 'now', 'queue', 'schedule'
      scheduled_at,
      story_enabled = false,
      selected_destinations = [] // array of account ids
    } = req.body;

    if (!caption && links.length === 0) {
      return res.status(400).json({ error: 'Caption or media links are required' });
    }

    const jobId = `job_${crypto.randomUUID().slice(0, 10)}`;
    const now = new Date().toISOString();

    let finalSchedule = scheduled_at || null;
    let initialStatus = 'pending';

    if (publish_mode === 'queue') {
      finalSchedule = await calculateNextQueueSlot();
      initialStatus = 'scheduled';
    } else if (publish_mode === 'schedule') {
      initialStatus = 'scheduled';
    }

    await executeD1(
      `INSERT INTO jobs (id, caption, hashtags, raw_links_json, publish_mode, status, story_enabled, scheduled_at, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Africa/Lagos', ?, ?)`,
      [jobId, caption.trim(), hashtags.trim(), JSON.stringify(links), publish_mode, initialStatus, story_enabled ? 1 : 0, finalSchedule, now, now]
    );

    // Fetch destination account objects
    let accounts: any[] = [];
    if (selected_destinations.length > 0) {
      const placeholders = selected_destinations.map(() => '?').join(',');
      accounts = await queryD1<any>(`SELECT * FROM accounts WHERE id IN (${placeholders})`, selected_destinations);
    } else {
      accounts = await queryD1<any>('SELECT * FROM accounts WHERE is_active = 1');
    }

    // Insert pending job_destinations
    for (const acc of accounts) {
      const idempotency = crypto.createHash('sha256')
        .update(`${jobId}:${acc.id}:init`)
        .digest('hex').slice(0, 32);

      await executeD1(
        `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'feed', ?, 'pending', ?, ?)`,
        [`dest_${crypto.randomUUID().slice(0, 8)}`, jobId, acc.id, acc.platform, idempotency, now, now]
      );

      if (story_enabled) {
        const storyIdempotency = crypto.createHash('sha256')
          .update(`${jobId}:${acc.id}:story:init`)
          .digest('hex').slice(0, 32);

        await executeD1(
          `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'story', ?, 'pending', ?, ?)`,
          [`dest_story_${crypto.randomUUID().slice(0, 8)}`, jobId, acc.id, acc.platform, storyIdempotency, now, now]
        );
      }
    }

    // If "Publish Now", initiate processing pipeline immediately
    if (publish_mode === 'now') {
      triggerJobProcessing(jobId, links).catch(err => {
        console.error(`Error triggering processing for job ${jobId}:`, err);
      });
    }

    res.json({
      success: true,
      job_id: jobId,
      publish_mode,
      status: initialStatus,
      scheduled_at: finalSchedule
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger media workflow or direct publication
async function triggerJobProcessing(jobId: string, rawLinks: string[]) {
  const now = new Date().toISOString();
  await executeD1('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?', ['processing', now, jobId]);

  await executeD1(
    `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
     VALUES (?, ?, 'info', 'Initiating media processing workflow', ?, ?)`,
    [`log_${crypto.randomUUID().slice(0, 8)}`, jobId, JSON.stringify({ links: rawLinks }), now]
  );

  if (rawLinks.length === 0) {
    // Text-only job, directly publish
    await executePublicationStep(jobId);
    return;
  }

  // Dispatch GitHub Actions workflow
  const callbackUrl = `${APP_URL}/api/callback/media-processed`;
  try {
    const dispatch = await dispatchMediaWorkflow(jobId, JSON.stringify(rawLinks), callbackUrl, CALLBACK_SECRET);
    if (dispatch.status >= 200 && dispatch.status < 300) {
      await executeD1(
        `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
         VALUES (?, ?, 'info', 'GitHub Actions media processing workflow dispatched', null, ?)`,
        [`log_${crypto.randomUUID().slice(0, 8)}`, jobId, new Date().toISOString()]
      );
    } else {
      throw new Error(`Workflow dispatch returned HTTP ${dispatch.status}: ${JSON.stringify(dispatch.data)}`);
    }
  } catch (err: any) {
    // If GitHub actions dispatch is unavailable, fall back to direct links publication
    console.warn(`GitHub Actions dispatch error for job ${jobId}, proceeding with direct links:`, err.message);
    await executeD1(
      `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
       VALUES (?, ?, 'warn', 'GitHub Actions unavailable, processing directly with links', ?, ?)`,
      [`log_${crypto.randomUUID().slice(0, 8)}`, jobId, JSON.stringify({ error: err.message }), new Date().toISOString()]
    );

    // Save direct links into job_media
    for (let i = 0; i < rawLinks.length; i++) {
      const url = rawLinks[i];
      const mediaId = `media_${jobId}_${i}`;
      const isVideo = /\.(mp4|mov|webm)$/i.test(url);
      await executeD1(
        `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, asset_download_url, status, created_at)
         VALUES (?, ?, ?, 'direct', ?, ?, ?, 'processed', ?)`,
        [mediaId, jobId, url, isVideo ? 'video' : 'image', `direct_media_${i}`, url, new Date().toISOString()]
      );
    }

    await executePublicationStep(jobId);
  }
}

// -----------------------------------------------------------------------------
// WEBHOOK CALLBACK ROUTE (FROM GITHUB ACTIONS)
// -----------------------------------------------------------------------------
app.post('/api/callback/media-processed', async (req, res) => {
  try {
    const signature = req.headers['x-callback-signature'] as string;
    const bodyText = JSON.stringify(req.body);
    const expectedSig = crypto.createHmac('sha256', CALLBACK_SECRET).update(bodyText).digest('hex');

    if (signature && signature !== expectedSig) {
      return res.status(403).json({ error: 'Invalid callback signature' });
    }

    const { job_id, release_tag, media = [] } = req.body;
    if (!job_id) return res.status(400).json({ error: 'job_id required' });

    const now = new Date().toISOString();

    for (const m of media) {
      const mediaId = `media_${job_id}_${crypto.randomUUID().slice(0, 6)}`;
      await executeD1(
        `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, mime_type, file_size, width, height, duration_sec, release_tag, asset_name, asset_download_url, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mediaId,
          job_id,
          m.source_url,
          m.source_type || 'direct',
          m.file_type || 'image',
          m.filename || 'asset',
          m.mime_type || null,
          m.file_size || null,
          m.width || null,
          m.height || null,
          m.duration_sec || null,
          release_tag || null,
          m.asset_name || null,
          m.asset_download_url || null,
          m.status || 'processed',
          m.error || null,
          now
        ]
      );
    }

    await executeD1(
      `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
       VALUES (?, ?, 'info', 'GitHub Actions media processing completed', ?, ?)`,
      [`log_${crypto.randomUUID().slice(0, 8)}`, job_id, JSON.stringify({ count: media.length, release_tag }), now]
    );

    // Trigger immediate publication for this job
    executePublicationStep(job_id).catch(err => {
      console.error(`Publication step error for ${job_id}:`, err);
    });

    res.json({ success: true, message: 'Callback received and publication started' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// PUBLICATION DISTRIBUTION ENGINE
// -----------------------------------------------------------------------------
async function executePublicationStep(jobId: string) {
  const now = new Date().toISOString();
  await executeD1('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?', ['publishing', now, jobId]);

  const jobs = await queryD1<any>('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!jobs || jobs.length === 0) return;
  const job = jobs[0];

  const mediaAssets = await queryD1<any>('SELECT * FROM job_media WHERE job_id = ? AND status = ?', [jobId, 'processed']);
  const destinations = await queryD1<any>(
    `SELECT jd.id as destination_db_id, jd.account_id, jd.platform, jd.post_type, jd.status, a.platform_account_id, a.key_id
     FROM job_destinations jd
     JOIN accounts a ON jd.account_id = a.id
     WHERE jd.job_id = ? AND jd.status IN ('pending', 'failed')`,
    [jobId]
  );

  const keys = await queryD1<any>('SELECT id, encrypted_key, iv FROM api_keys WHERE is_active = 1');
  const keyMap = new Map(keys.map(k => [k.id, decryptApiKey(k.encrypted_key, k.iv)]));

  const plannedPosts = planJobDestinations(
    jobId,
    job.caption,
    job.hashtags,
    mediaAssets,
    destinations.map(d => ({
      id: d.account_id,
      platform: d.platform,
      platform_account_id: d.platform_account_id,
      key_id: d.key_id
    })),
    job.story_enabled === 1
  );

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  for (const plan of plannedPosts) {
    if (plan.status === 'skipped') {
      skippedCount++;
      await executeD1(
        `UPDATE job_destinations SET status = 'skipped', error_message = ?, updated_at = ?
         WHERE job_id = ? AND account_id = ? AND post_type = ?`,
        [plan.skip_reason || 'Skipped per platform capability matrix', new Date().toISOString(), jobId, plan.account_id, plan.post_type]
      );
      continue;
    }

    const apiKey = keyMap.get(plan.key_id);
    if (!apiKey) {
      failCount++;
      await executeD1(
        `UPDATE job_destinations SET status = 'failed', error_message = 'Active Zernio API key not found for destination', updated_at = ?
         WHERE job_id = ? AND account_id = ? AND post_type = ?`,
        [new Date().toISOString(), jobId, plan.account_id, plan.post_type]
      );
      continue;
    }

    const destObj = destinations.find(d => d.account_id === plan.account_id && d.post_type === plan.post_type);
    const platformAccountId = destObj?.platform_account_id || plan.account_id;

    try {
      const pubRes = await publishToZernio(apiKey, {
        content: plan.caption,
        mediaUrls: plan.media_urls.length > 0 ? plan.media_urls : undefined,
        platforms: [{ platform: plan.platform, accountId: platformAccountId }],
        publishNow: true,
        story: plan.post_type === 'story'
      });

      const attemptTime = new Date().toISOString();
      if (pubRes.success) {
        successCount++;
        await executeD1(
          `UPDATE job_destinations SET status = 'published', external_post_id = ?, external_post_url = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND account_id = ? AND post_type = ?`,
          [pubRes.external_post_id || null, pubRes.external_post_url || null, attemptTime, attemptTime, jobId, plan.account_id, plan.post_type]
        );
      } else {
        failCount++;
        await executeD1(
          `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND account_id = ? AND post_type = ?`,
          [pubRes.error || 'Unknown publish error', attemptTime, attemptTime, jobId, plan.account_id, plan.post_type]
        );
      }
    } catch (publishErr: any) {
      failCount++;
      await executeD1(
        `UPDATE job_destinations SET status = 'failed', error_message = ?, attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
         WHERE job_id = ? AND account_id = ? AND post_type = ?`,
        [publishErr.message, new Date().toISOString(), new Date().toISOString(), jobId, plan.account_id, plan.post_type]
      );
    }
  }

  // Determine overall job status
  let finalStatus = 'published';
  if (successCount === 0 && failCount > 0) {
    finalStatus = 'failed';
  } else if (successCount > 0 && failCount > 0) {
    finalStatus = 'partially_published';
  } else if (successCount === 0 && failCount === 0) {
    finalStatus = skippedCount > 0 ? 'published' : 'failed';
  }

  const finishedTime = new Date().toISOString();
  await executeD1(
    `UPDATE jobs SET status = ?, published_at = ?, updated_at = ? WHERE id = ?`,
    [finalStatus, finishedTime, finishedTime, jobId]
  );

  await executeD1(
    `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
     VALUES (?, ?, 'info', 'Publication execution completed', ?, ?)`,
    [`log_${crypto.randomUUID().slice(0, 8)}`, jobId, JSON.stringify({ successCount, failCount, skippedCount, finalStatus }), finishedTime]
  );

  // Storage cleanup rule: Only delete release assets after ALL dependent destinations are confirmed published
  if (finalStatus === 'published') {
    cleanupJobReleaseAssets(jobId).catch(err => {
      console.warn(`Asset cleanup notice for job ${jobId}:`, err.message);
    });
  }
}

async function cleanupJobReleaseAssets(jobId: string) {
  // Check if any other job is still using these media assets
  const mediaList = await queryD1<any>('SELECT asset_name, release_tag FROM job_media WHERE job_id = ? AND asset_name IS NOT NULL', [jobId]);
  for (const m of mediaList) {
    if (m.asset_name && m.release_tag) {
      await deleteReleaseAsset(m.asset_name, m.release_tag);
    }
  }
  await executeD1(
    `INSERT INTO execution_logs (id, job_id, level, message, details_json, created_at)
     VALUES (?, ?, 'info', 'Temporary release media assets purged after confirmed publication', null, ?)`,
    [`log_${crypto.randomUUID().slice(0, 8)}`, jobId, new Date().toISOString()]
  );
}

// Retry failed destinations route
app.post('/api/jobs/:id/retry', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    executePublicationStep(id).catch(err => {
      console.error(`Retry execution error for ${id}:`, err);
    });
    res.json({ success: true, message: 'Retry initiated for failed destinations' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel job route
app.post('/api/jobs/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await executeD1(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// QUEUE ROUTES
// -----------------------------------------------------------------------------
app.get('/api/queue', requireAuth, async (req, res) => {
  try {
    const config = await getQueueConfig();
    const queuedJobs = await queryD1<any>(
      `SELECT * FROM jobs WHERE status IN ('scheduled', 'pending', 'processing') ORDER BY scheduled_at ASC, created_at ASC`
    );
    const nextSlot = await calculateNextQueueSlot();

    res.json({
      config,
      queued_jobs: queuedJobs,
      next_available_slot: nextSlot
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/queue/settings', requireAuth, async (req, res) => {
  try {
    const { posts_per_day = 3, daily_times = ['09:00', '14:00', '19:00'], timezone = 'Africa/Lagos', is_active = true } = req.body;
    await executeD1(
      `UPDATE queue_settings SET
         posts_per_day = ?,
         daily_times_json = ?,
         timezone = ?,
         is_active = ?,
         updated_at = ?
       WHERE id = 'singleton'`,
      [posts_per_day, JSON.stringify(daily_times), timezone, is_active ? 1 : 0, new Date().toISOString()]
    );
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// SYSTEM STATUS ROUTE
// -----------------------------------------------------------------------------
app.get('/api/system/status', requireAuth, async (req, res) => {
  try {
    const d1Check = await queryD1('SELECT count(*) as count FROM jobs');
    const keyCheck = await queryD1('SELECT count(*) as count FROM api_keys WHERE is_active = 1');
    const accCheck = await queryD1('SELECT count(*) as count FROM accounts WHERE is_active = 1');
    const relCheck = await queryD1('SELECT * FROM releases WHERE is_active = 1');

    res.json({
      status: 'operational',
      d1_connected: true,
      active_keys: keyCheck[0]?.count || 0,
      connected_accounts: accCheck[0]?.count || 0,
      total_jobs: d1Check[0]?.count || 0,
      active_release: relCheck[0]?.tag_name || 'media-001',
      timezone: 'Africa/Lagos',
      worker_url: 'https://salt-relay-api.motionssalt.workers.dev',
      pages_url: 'https://salt-relay.pages.dev'
    });
  } catch (e: any) {
    res.status(500).json({ status: 'degraded', error: e.message });
  }
});

// -----------------------------------------------------------------------------
// VITE INTEGRATION FOR DEVELOPMENT
// -----------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Salt Relay server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start Salt Relay server:', err);
});
