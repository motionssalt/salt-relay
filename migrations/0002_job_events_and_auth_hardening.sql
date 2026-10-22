-- Migration: 0002_job_events_and_auth_hardening.sql
-- Adds stage-based job event tracking and brute-force login rate limiting / lockout

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  stage TEXT NOT NULL, -- 'created', 'dispatching', 'dispatched', 'transcoding', 'uploaded', 'publishing', 'published', 'failed', 'retried', 'watchdog_timeout', 'cancelled'
  level TEXT NOT NULL DEFAULT 'info', -- 'info', 'warn', 'error'
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_lockouts (
  ip TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_attempt_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_stage ON job_events(stage);
CREATE INDEX IF NOT EXISTS idx_job_events_created ON job_events(created_at);
