-- Migration: 0003_workflow_run_tracking.sql
-- Adds columns to track GitHub Actions workflow execution runs for intelligent watchdog

ALTER TABLE jobs ADD COLUMN workflow_run_id TEXT;
ALTER TABLE jobs ADD COLUMN workflow_run_url TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_workflow_run ON jobs(workflow_run_id);
