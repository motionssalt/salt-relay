-- Migration: 0004_immutable_job_sources_and_attempts.sql
-- Persists immutable original media source links at job creation, tracks retry attempt numbers,
-- supports dry-run verification without live social posts, and stores release asset IDs & SHA-256 digests for safe reuse.

CREATE TABLE IF NOT EXISTS job_sources (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  source_url TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'direct_url', -- 'direct_url', 'drive_file', 'drive_folder'
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_sources_job ON job_sources(job_id, position);

ALTER TABLE jobs ADD COLUMN sources_json TEXT;
ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;

ALTER TABLE job_media ADD COLUMN asset_id TEXT;
ALTER TABLE job_media ADD COLUMN sha256 TEXT;

-- Backfill sources_json from historical raw_links_json where non-empty links exist
UPDATE jobs
SET sources_json = raw_links_json
WHERE sources_json IS NULL
  AND raw_links_json IS NOT NULL
  AND raw_links_json != ''
  AND raw_links_json != '[]';
