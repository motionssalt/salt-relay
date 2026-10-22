-- Migration: 0001_initial.sql for Salt Relay (Cloudflare D1)

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  masked_key TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL, -- tiktok, youtube, threads, instagram, twitter, telegram, pinterest
  platform_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT,
  key_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT,
  last_synced_at TEXT NOT NULL,
  UNIQUE(platform, platform_account_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  caption TEXT NOT NULL,
  hashtags TEXT NOT NULL DEFAULT '',
  raw_links_json TEXT NOT NULL, -- array of user input links (direct or drive)
  publish_mode TEXT NOT NULL, -- 'now', 'queue', 'schedule'
  status TEXT NOT NULL, -- 'pending', 'processing', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'
  story_enabled INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  published_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_media (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'direct' or 'drive'
  file_type TEXT NOT NULL, -- 'image' or 'video'
  filename TEXT,
  mime_type TEXT,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  release_tag TEXT,
  asset_name TEXT,
  asset_download_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processed', 'failed'
  error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_destinations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  post_type TEXT NOT NULL DEFAULT 'feed', -- 'feed' or 'story'
  media_group_id TEXT, -- references grouped assets for this destination
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'publishing', 'published', 'skipped', 'failed'
  external_post_id TEXT,
  external_post_url TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_settings (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  posts_per_day INTEGER NOT NULL DEFAULT 3,
  daily_times_json TEXT NOT NULL DEFAULT '["09:00","14:00","19:00"]',
  posts_per_week INTEGER NOT NULL DEFAULT 0,
  weekday_times_json TEXT NOT NULL DEFAULT '{"mon":["10:00"],"wed":["10:00"],"fri":["10:00"]}',
  posts_per_month INTEGER NOT NULL DEFAULT 0,
  monthly_times_json TEXT NOT NULL DEFAULT '{"1":["12:00"],"15":["12:00"]}',
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  tag_name TEXT NOT NULL UNIQUE,
  asset_count INTEGER NOT NULL DEFAULT 0,
  max_assets INTEGER NOT NULL DEFAULT 50,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  level TEXT NOT NULL DEFAULT 'info', -- 'info', 'warn', 'error'
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_at ON jobs(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_job_destinations_job ON job_destinations(job_id);
CREATE INDEX IF NOT EXISTS idx_job_destinations_status ON job_destinations(status);
CREATE INDEX IF NOT EXISTS idx_job_media_job ON job_media(job_id);

-- Default queue setting initialization
INSERT OR IGNORE INTO queue_settings (id, posts_per_day, daily_times_json, timezone, is_active, updated_at)
VALUES ('singleton', 3, '["09:00","14:00","19:00"]', 'Africa/Lagos', 1, datetime('now'));

-- Default active release
INSERT OR IGNORE INTO releases (id, tag_name, asset_count, max_assets, is_active, created_at)
VALUES ('rel_001', 'media-001', 0, 50, 1, datetime('now'));
