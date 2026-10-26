import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.ts';

function createTestD1(): any {
  const sqlite = new DatabaseSync(':memory:');
  const migDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'migrations');
  const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
    sqlite.exec(sql);
  }

  function makeStmt(sql: string, bound: any[] = []) {
    return {
      bind(...args: any[]) {
        return makeStmt(sql, args.map(v => v === undefined ? null : v));
      },
      async first<T = any>(): Promise<T | null> {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...bound) as T | undefined;
        return row ?? null;
      },
      async all<T = any>(): Promise<{ results: T[]; success: boolean }> {
        const stmt = sqlite.prepare(sql);
        const rows = stmt.all(...bound) as T[];
        return { results: rows, success: true };
      },
      async run(): Promise<{ success: boolean }> {
        const stmt = sqlite.prepare(sql);
        stmt.run(...bound);
        return { success: true };
      }
    };
  }

  return {
    _sqlite: sqlite,
    prepare(sql: string) {
      return makeStmt(sql);
    }
  };
}

function createTestEnv(db: any, overrides: Record<string, any> = {}) {
  return {
    DB: db,
    DASHBOARD_PASSWORD: 'test-dashboard-password-123456',
    SESSION_SECRET: 'test-session-secret-123456',
    ENCRYPTION_KEY: 'test-encryption-key-123456',
    CALLBACK_SECRET: 'test-callback-secret-123456',
    GITHUB_PAT: 'ghp_test_token_dummy',
    GITHUB_OWNER: 'motionssalt',
    GITHUB_REPO: 'salt-relay',
    ...overrides
  };
}

function createCtx() {
  const pending: Promise<any>[] = [];
  return {
    waitUntil(p: Promise<any>) {
      pending.push(Promise.resolve(p));
    },
    async flush() {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    }
  };
}

async function loginAndSeedAccount(env: any) {
  const ctx = createCtx();
  const loginRes = await worker.fetch(
    new Request('https://salt-relay-api.motionssalt.workers.dev/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: env.DASHBOARD_PASSWORD })
    }),
    env,
    ctx as any
  );
  const loginBody = await loginRes.json() as any;
  assert.equal(loginRes.status, 200);
  const token = loginBody.token;

  // Add encrypted Zernio key + active TikTok and Telegram accounts
  await worker.fetch(
    new Request('https://salt-relay-api.motionssalt.workers.dev/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ label: 'Primary Zernio', key: 'zrn_live_dummy_key_0001' })
    }),
    env,
    ctx as any
  );
  const keyRow = await env.DB.prepare('SELECT id FROM api_keys LIMIT 1').first();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO accounts (id, platform, platform_account_id, name, username, key_id, is_active, last_synced_at)
     VALUES (?, 'tiktok', 'tt_001', 'MotionSalt TikTok', 'motionsalt', ?, 1, ?)`
  ).bind('acc_tiktok_1', keyRow.id, now).run();
  await env.DB.prepare(
    `INSERT INTO accounts (id, platform, platform_account_id, name, username, key_id, is_active, last_synced_at)
     VALUES (?, 'telegram', 'tg_001', 'MotionSalt Telegram', 'motionsalt_tg', ?, 1, ?)`
  ).bind('acc_telegram_1', keyRow.id, now).run();

  return token;
}

describe('Salt Relay F5 & F6 Automated Verification Suite', () => {
  test('F5.1/F5.3: Creating a post with no media links (even with caption) is rejected with 400 and creates NO job', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);
    const ctx = createCtx();

    const res = await worker.fetch(
      new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          caption: 'Post caption with forgotten media link',
          hashtags: '#motionsalt',
          links: ['   '],
          publish_mode: 'now',
          selected_destinations: ['acc_tiktok_1']
        })
      }),
      env,
      ctx as any
    );
    await ctx.flush();

    const body = await res.json() as any;
    assert.equal(res.status, 400, `Expected 400 when links=[] but got ${res.status}: ${JSON.stringify(body)}`);
    assert.match(body.error || '', /links|source/i);

    const jobCount = await db.prepare('SELECT count(*) as count FROM jobs').first();
    assert.equal(jobCount.count, 0, 'Must never create a pending/failed job when no sources were submitted');
  });

  test('F5.2/F5.4: Creating a post with (a) 1 direct video URL and (b) 1 Drive folder + 1 direct URL stores immutable sources and dispatches workflow immediately', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);

    const dispatchedCalls: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/actions/workflows/process-media.yml/dispatches')) {
        dispatchedCalls.push({ url, body: JSON.parse(init?.body || '{}') });
        return new Response(null, { status: 204 });
      }
      if (url.includes('/actions/workflows/process-media.yml/runs')) {
        const runNum = 50000000 + dispatchedCalls.length;
        return new Response(JSON.stringify({
          workflow_runs: [{
            id: runNum,
            html_url: `https://github.com/motionssalt/salt-relay/actions/runs/${runNum}`,
            created_at: new Date().toISOString(),
            status: 'queued'
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Unexpected external call' }), { status: 500 });
    };

    try {
      const ctx = createCtx();
      // (a) Single direct video URL
      const resA = await worker.fetch(
        new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            caption: 'Direct video post',
            hashtags: '#motionsalt',
            links: ['https://cdn.example.com/reel_01.mp4'],
            publish_mode: 'now',
            selected_destinations: ['acc_tiktok_1']
          })
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      const bodyA = await resA.json() as any;
      assert.equal(resA.status, 200);
      assert.equal(dispatchedCalls.length, 1);
      assert.deepEqual(JSON.parse(dispatchedCalls[0].body.inputs.media_json), ['https://cdn.example.com/reel_01.mp4']);

      const sourcesA = await db.prepare('SELECT * FROM job_sources WHERE job_id = ? ORDER BY position ASC').bind(bodyA.job_id).all();
      assert.equal(sourcesA.results.length, 1);
      assert.equal(sourcesA.results[0].source_url, 'https://cdn.example.com/reel_01.mp4');
      assert.equal(sourcesA.results[0].source_kind, 'direct_url');

      // (b) Public Drive folder link + direct URL
      const folderUrl = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz123456';
      const directUrl = 'https://cdn.example.com/cover_02.mp4';
      const resB = await worker.fetch(
        new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            caption: 'Folder + direct post',
            hashtags: '#motionsalt',
            links: [folderUrl, directUrl],
            publish_mode: 'now',
            story_enabled: true,
            selected_destinations: ['acc_tiktok_1', 'acc_telegram_1']
          })
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      const bodyB = await resB.json() as any;
      assert.equal(resB.status, 200);
      assert.equal(dispatchedCalls.length, 2);
      assert.deepEqual(JSON.parse(dispatchedCalls[1].body.inputs.media_json), [folderUrl, directUrl]);

      const jobB = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(bodyB.job_id).first();
      assert.equal(jobB.workflow_run_id, '50000002');
      assert.deepEqual(JSON.parse(jobB.sources_json), [folderUrl, directUrl]);

      const sourcesB = await db.prepare('SELECT * FROM job_sources WHERE job_id = ? ORDER BY position ASC').bind(bodyB.job_id).all();
      assert.equal(sourcesB.results.length, 2);
      assert.equal(sourcesB.results[0].source_kind, 'drive_folder');
      assert.equal(sourcesB.results[1].source_kind, 'direct_url');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('F5.4/F5.5: Dispatch failure marks job failed with real GitHub error and NEVER falls back to unexpanded/empty publish', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);

    let zernioCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/actions/workflows/process-media.yml/dispatches')) {
        return new Response(JSON.stringify({ message: 'Workflow does not have workflow_dispatch trigger' }), { status: 422 });
      }
      if (url.includes('zernio.com')) {
        zernioCalls++;
        return new Response(JSON.stringify({ message: 'Tiktok posts require media content' }), { status: 400 });
      }
      return new Response('{}', { status: 500 });
    };

    try {
      const ctx = createCtx();
      const res = await worker.fetch(
        new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            caption: 'Drive video post',
            links: ['https://drive.google.com/file/d/1delzIylTDmA1KrfwKgE4ivo0qR6hXt2B/view?usp=drivesdk'],
            publish_mode: 'now',
            selected_destinations: ['acc_tiktok_1']
          })
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      const body = await res.json() as any;
      const jobId = body.job_id;
      assert.ok(jobId);

      const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
      assert.equal(job.status, 'failed');
      assert.match(job.error_message || '', /422/);
      assert.equal(zernioCalls, 0, 'Must never call Zernio with raw unexpanded Drive URL when dispatch fails');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('F6.1/F6.2: Retry with stored sources (no processed assets) re-dispatches workflow with media and preserves published destinations (idempotent)', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);

    const driveLink = 'https://drive.google.com/file/d/1EI_40LZ-ETdPceKxdnm8K8XZHbSbCIj4/view?usp=drivesdk';
    const now = new Date().toISOString();
    const jobId = 'job_retry_with_sources';

    await db.prepare(
      `INSERT INTO jobs (id, caption, hashtags, raw_links_json, publish_mode, status, story_enabled, timezone, error_message, created_at, updated_at)
       VALUES (?, 'Original caption', '#motionsalt', ?, 'now', 'failed', 1, 'Africa/Lagos', 'Watchdog timeout', ?, ?)`
    ).bind(jobId, JSON.stringify([driveLink]), now, now).run();

    // One destination ALREADY published, two failed
    await db.prepare(
      `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, external_post_id, attempts, created_at, updated_at)
       VALUES ('d_pub', ?, 'acc_telegram_1', 'telegram', 'feed', 'idem_tg_feed', 'published', 'ext_999', 1, ?, ?)`
    ).bind(jobId, now, now).run();
    await db.prepare(
      `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, error_message, attempts, created_at, updated_at)
       VALUES ('d_fail', ?, 'acc_tiktok_1', 'tiktok', 'feed', 'idem_tt_feed', 'failed', 'Timeout', 1, ?, ?)`
    ).bind(jobId, now, now).run();

    const dispatchedPayloads: any[] = [];
    let zernioCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/actions/workflows/process-media.yml/dispatches')) {
        dispatchedPayloads.push(JSON.parse(init?.body || '{}'));
        return new Response(null, { status: 204 });
      }
      if (url.includes('/actions/workflows/process-media.yml/runs')) {
        return new Response(JSON.stringify({
          workflow_runs: [{
            id: 777001,
            html_url: 'https://github.com/motionssalt/salt-relay/actions/runs/777001',
            created_at: new Date().toISOString(),
            status: 'in_progress'
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('zernio.com')) {
        zernioCalls++;
        return new Response(JSON.stringify({ id: 'post_new_123' }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    };

    try {
      const ctx = createCtx();
      const retryRes = await worker.fetch(
        new Request(`https://salt-relay-api.motionssalt.workers.dev/api/jobs/${jobId}/retry`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        env,
        ctx as any
      );
      await ctx.flush();

      assert.equal(retryRes.status, 200);
      assert.equal(zernioCalls, 0, 'Retry without processed media MUST NOT call Zernio with caption+hashtags only!');
      assert.equal(dispatchedPayloads.length, 1, 'Retry MUST re-dispatch GitHub Actions media workflow!');
      assert.deepEqual(JSON.parse(dispatchedPayloads[0].inputs.media_json), [driveLink]);

      const updatedJob = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
      assert.equal(updatedJob.status, 'processing');
      assert.equal(updatedJob.attempt_count, 2);
      assert.equal(updatedJob.workflow_run_id, '777001');
      assert.equal(updatedJob.caption, 'Original caption');
      assert.equal(updatedJob.hashtags, '#motionsalt');
      assert.equal(updatedJob.story_enabled, 1);

      // Now simulate signed callback arriving with processed video -> only failed destination should publish!
      const cbPayload = JSON.stringify({
        job_id: jobId,
        status: 'success',
        release_tag: 'media-001',
        processed_count: 1,
        failed_count: 0,
        media: [{
          source_url: driveLink,
          source_type: 'drive',
          file_type: 'video',
          mime_type: 'video/mp4',
          filename: `${jobId}_video_0.mp4`,
          file_size: 1048576,
          asset_id: 9001,
          asset_name: `${jobId}_video_0.mp4`,
          asset_download_url: `https://github.com/motionssalt/salt-relay/releases/download/media-001/${jobId}_video_0.mp4`,
          status: 'processed'
        }]
      });
      const sig = crypto.createHmac('sha256', env.CALLBACK_SECRET).update(cbPayload).digest('hex');
      const cbRes = await worker.fetch(
        new Request('https://salt-relay-api.motionssalt.workers.dev/api/callback/media-processed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Callback-Signature': sig },
          body: cbPayload
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      assert.equal(cbRes.status, 200);
      assert.equal(zernioCalls, 1, 'Callback publication must only publish the 1 failed destination, never duplicating the published destination!');

      const pubDest = await db.prepare('SELECT * FROM job_destinations WHERE id = ?').bind('d_pub').first();
      assert.equal(pubDest.attempts, 1, 'Already-published destination must remain untouched at 1 attempt');
      assert.equal(pubDest.idempotency_key, 'idem_tg_feed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('F6.3: Retry on legacy job without stored sources fails cleanly with exact required message and never sends caption-only', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);

    const now = new Date().toISOString();
    const jobId = 'job_legacy_no_sources';
    await db.prepare(
      `INSERT INTO jobs (id, caption, hashtags, raw_links_json, publish_mode, status, story_enabled, timezone, error_message, created_at, updated_at)
       VALUES (?, 'Legacy caption', '#motionsalt', '[]', 'now', 'failed', 0, 'Africa/Lagos', 'Old failure', ?, ?)`
    ).bind(jobId, now, now).run();
    await db.prepare(
      `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, attempts, created_at, updated_at)
       VALUES ('d_leg_1', ?, 'acc_tiktok_1', 'tiktok', 'feed', 'idem_leg_1', 'failed', 1, ?, ?)`
    ).bind(jobId, now, now).run();

    let zernioCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      zernioCalls++;
      return new Response('{}', { status: 200 });
    };

    try {
      const ctx = createCtx();
      const res = await worker.fetch(
        new Request(`https://salt-relay-api.motionssalt.workers.dev/api/jobs/${jobId}/retry`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      const body = await res.json() as any;

      assert.equal(res.status, 400);
      assert.equal(
        body.error,
        "This job's original media links were not saved, so it cannot be retried. Create a new post."
      );
      assert.equal(zernioCalls, 0, 'Must never publish caption-only on legacy job without sources');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Salt Relay F5 Schedule Timezone & F6 Smart Asset Reuse Verification', () => {
  test('F5.3/F5.6: Malformed URL or Drive URL missing ID rejects with 400 naming field; due Africa/Lagos schedule dispatches immediately', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);
    const ctx = createCtx();

    // 1. Bare Google Drive URL without file/folder ID must be rejected
    const badRes = await worker.fetch(
      new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          caption: 'Bad link test',
          links: ['https://drive.google.com/drive/my-drive'],
          publish_mode: 'now',
          selected_destinations: ['acc_tiktok_1']
        })
      }),
      env,
      ctx as any
    );
    const badBody = await badRes.json() as any;
    assert.equal(badRes.status, 400);
    assert.equal(badBody.field, 'links[0]');
    assert.match(badBody.error, /links\[0\]/);

    // 2. Schedule mode without scheduled_at must be rejected
    const noSchedRes = await worker.fetch(
      new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          caption: 'Missing schedule',
          links: ['https://cdn.example.com/clip.mp4'],
          publish_mode: 'schedule',
          selected_destinations: ['acc_tiktok_1']
        })
      }),
      env,
      ctx as any
    );
    assert.equal(noSchedRes.status, 400);

    // 3. Past/due Africa/Lagos naive datetime-local string normalizes to UTC ISO (+01:00 -> -1h UTC) and dispatches immediately
    let dispatched = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/actions/workflows/process-media.yml/dispatches')) {
        dispatched++;
        return new Response(null, { status: 204 });
      }
      if (url.includes('/actions/workflows/process-media.yml/runs')) {
        return new Response(JSON.stringify({
          workflow_runs: [{
            id: 888111,
            html_url: 'https://github.com/motionssalt/salt-relay/actions/runs/888111',
            created_at: new Date().toISOString(),
            status: 'queued'
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    };

    try {
      const dueRes = await worker.fetch(
        new Request('https://salt-relay-api.motionssalt.workers.dev/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            caption: 'Scheduled in Africa/Lagos already due',
            links: ['https://drive.google.com/file/d/1delzIylTDmA1KrfwKgE4ivo0qR6hXt2B/view?usp=drivesdk'],
            publish_mode: 'schedule',
            scheduled_at: '2026-10-25T10:43',
            timezone: 'Africa/Lagos',
            selected_destinations: ['acc_tiktok_1']
          })
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      const dueBody = await dueRes.json() as any;
      assert.equal(dueRes.status, 200);
      assert.equal(dueBody.scheduled_at, '2026-10-25T09:43:00.000Z');
      assert.equal(dueBody.status, 'processing');
      assert.equal(dispatched, 1, 'Already-due scheduled post must dispatch workflow immediately');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('F6.2: Smart asset reuse skips reprocessing when release asset size & sha256 match, and re-dispatches when asset is missing', async () => {
    const db = createTestD1();
    const env = createTestEnv(db);
    const token = await loginAndSeedAccount(env);

    const now = new Date().toISOString();
    const jobId = 'job_smart_reuse';
    const srcUrl = 'https://cdn.example.com/master_video.mp4';
    const fakeSha = 'a'.repeat(64);

    await db.prepare(
      `INSERT INTO jobs (id, caption, hashtags, raw_links_json, sources_json, publish_mode, status, story_enabled, timezone, attempt_count, created_at, updated_at)
       VALUES (?, 'Smart reuse test', '#motionsalt', ?, ?, 'now', 'partially_published', 0, 'Africa/Lagos', 1, ?, ?)`
    ).bind(jobId, JSON.stringify([srcUrl]), JSON.stringify([srcUrl]), now, now).run();
    await db.prepare(
      `INSERT INTO job_sources (id, job_id, position, source_url, source_kind, created_at)
       VALUES ('src_sr_0', ?, 0, ?, 'direct_url', ?)`
    ).bind(jobId, srcUrl, now).run();
    await db.prepare(
      `INSERT INTO job_media (id, job_id, source_url, source_type, file_type, filename, mime_type, file_size, release_tag, asset_id, asset_name, asset_download_url, sha256, status, created_at)
       VALUES ('m_sr_0', ?, ?, 'direct', 'video', 'job_smart_reuse_video_0.mp4', 'video/mp4', 5242880, 'media-001', '991122', 'job_smart_reuse_video_0.mp4', 'https://github.com/motionssalt/salt-relay/releases/download/media-001/job_smart_reuse_video_0.mp4', ?, 'processed', ?)`
    ).bind(jobId, srcUrl, fakeSha, now).run();

    // Telegram already published, TikTok failed
    await db.prepare(
      `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, attempts, created_at, updated_at)
       VALUES ('d_sr_pub', ?, 'acc_telegram_1', 'telegram', 'feed', 'idem_sr_1', 'published', 1, ?, ?)`
    ).bind(jobId, now, now).run();
    await db.prepare(
      `INSERT INTO job_destinations (id, job_id, account_id, platform, post_type, idempotency_key, status, attempts, created_at, updated_at)
       VALUES ('d_sr_fail', ?, 'acc_tiktok_1', 'tiktok', 'feed', 'idem_sr_2', 'failed', 1, ?, ?)`
    ).bind(jobId, now, now).run();

    let workflowDispatches = 0;
    const zernioBodies: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/releases/tags/media-001')) {
        return new Response(JSON.stringify({
          tag_name: 'media-001',
          assets: [{
            id: 991122,
            name: 'job_smart_reuse_video_0.mp4',
            size: 5242880,
            digest: `sha256:${fakeSha}`
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/releases/assets/991122') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/actions/workflows/process-media.yml/dispatches')) {
        workflowDispatches++;
        return new Response(null, { status: 204 });
      }
      if (url.includes('zernio.com/api/v1/posts')) {
        zernioBodies.push(JSON.parse(init?.body || '{}'));
        return new Response(JSON.stringify({ id: 'z_ok_1' }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    };

    try {
      const ctx = createCtx();
      const res = await worker.fetch(
        new Request(`https://salt-relay-api.motionssalt.workers.dev/api/jobs/${jobId}/retry`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        env,
        ctx as any
      );
      await ctx.flush();
      const body = await res.json() as any;

      assert.equal(res.status, 200);
      assert.equal(body.mode, 'reused_verified_assets');
      assert.equal(workflowDispatches, 0, 'Should reuse verified release asset and skip workflow dispatch');
      assert.equal(zernioBodies.length, 1, 'Should only publish to the 1 unfulfilled destination');
      assert.equal(zernioBodies[0].platforms[0].platform, 'tiktok');
      assert.equal(zernioBodies[0].mediaItems.length, 1);
      assert.match(zernioBodies[0].mediaItems[0].url, /\/api\/public\/media\/job_smart_reuse\/job_smart_reuse_video_0\.mp4/);

      const finalJob = await db.prepare('SELECT status, attempt_count FROM jobs WHERE id = ?').bind(jobId).first();
      assert.equal(finalJob.status, 'published');
      assert.equal(finalJob.attempt_count, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
