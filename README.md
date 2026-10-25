# Salt Relay — Unified Social Publishing Dashboard

Salt Relay is an automated, mobile-first social media scheduling, media distribution, and publishing pipeline for Victor (**MOTIONSALT**). It delivers compatible multi-media assets across **7 social networks** (TikTok, YouTube, Threads, Instagram, X, Telegram, and Pinterest) through Zernio API keys, leveraging serverless Cloudflare Workers, D1 database storage, and GitHub Actions with release asset rotation.

---

## 1. Live Deployments & Infrastructure

- **Web Dashboard (Cloudflare Pages):** [https://salt-relay.pages.dev](https://salt-relay.pages.dev)
- **API & Cron Orchestrator (Cloudflare Worker):** [https://salt-relay-api.motionssalt.workers.dev](https://salt-relay-api.motionssalt.workers.dev)
- **Database (Cloudflare D1):** `salt-relay-db` (`29f8c89b-41cf-4b7e-906c-a475eb06febc`)
- **Cron Trigger:** `*/5 * * * *` (polls due jobs in D1 every 5 minutes and runs the 15-minute Watchdog)
- **Media Transcoding Pipeline:** GitHub Actions workflow (`.github/workflows/process-media.yml`)
- **Temporary Media Storage:** Rotating GitHub Releases (`media-001`, `media-002`, etc.)

---

## 2. Pipeline Stages & Troubleshooting Guide

Salt Relay writes stage-by-stage events to `job_events` and `execution_logs` in Cloudflare D1. Every job transition is visible in the UI under **Job History & Destinations** -> Click any job to inspect the **Event Timeline** and direct **Run Log** link.

### Where to Look When a Job Stalls or Fails

1. **Job Details & Run Log Link**: Click the job in the dashboard history. If a GitHub Actions transcode run was initiated, a direct **"View Run Log"** link points straight to the specific GitHub Actions execution (`https://github.com/motionssalt/salt-relay/actions/runs/<id>`).
2. **Job Event Timeline**: In the job drawer, scroll down to the **Event Timeline**. Each step logs timestamp, stage, and details (e.g., `dispatched`, `watchdog_extended`, `transcoded`, `publishing`, `dest_published`, `dest_failed`).
3. **Late Callback Acceptance**: If a job was marked failed due to a temporary watchdog timeout while a long run was still progressing, the Worker automatically accepts the signed late callback when the runner finishes, recovers the job, and proceeds with publishing to unfulfilled destinations.
4. **Idempotent Retry**: If any destinations failed (e.g. rate limit, expired API key, network blip), click the **"Retry"** button on the job card or detail view. Only unfulfilled destinations are dispatched; already-published platforms are never duplicated.

### Stage Reference

| Stage | What Happens | Where to Look If Stalled |
| :--- | :--- | :--- |
| `created` | Post record and per-destination tracking rows inserted into D1. | Check `/api/jobs` and `job_destinations` in D1. |
| `dispatching` / `dispatched` | Worker calls GitHub Actions `workflow_dispatch` on `process-media.yml`, captures workflow run ID & URL. | Verify Worker has valid `GITHUB_PAT` secret with `repo`+`workflow` scopes. |
| `transcoding` | GitHub Actions runner downloads media (Drive / direct link) and transcodes via static FFmpeg binary. | Click "View Run Log" in the job details to inspect real-time transcode progress. |
| `uploaded` | Runner uploads transcoded media to temporary GitHub Release asset (`media-001`) with HTTP verification. | GitHub repository **Releases** tab (`media-001`). Runner verifies asset presence via API. |
| `publishing` | Runner posts signed HMAC webhook to `/api/callback/media-processed`, Worker starts Zernio dispatch. | Check `CALLBACK_SECRET` match between Worker & Actions. Check Zernio API response in `job_events`. |
| `published` / `partially_published` | Zernio confirms publication to social platforms. External IDs & URLs recorded. | View Destination Breakdown in the dashboard or click external post links. |
| `failed` | Error recorded with exact failure reason from platform or transcode runner. | Check error banner; click "Retry" to re-attempt unfulfilled destinations safely. |
| `watchdog_extended` | Watchdog inspected GitHub Actions run, confirmed it is actively `queued` or `in_progress`, and extended the deadline. | Normal behavior for longer media files. The hard limit is 45 minutes. |
| `watchdog_timeout` | Run exceeded 45-minute hard limit or orphan job had no activity for > 30 minutes. | Check the GitHub run link on the job card to see if runner stalled. |
| `cancelled` | Operator explicitly cancelled the job. Cancelled jobs are permanently sealed and never auto-resurrect. | Marked by operator action in dashboard. |

---

## 3. Supported Platforms & Capabilities

Platform capabilities are declared in `capabilities.json` and evaluated automatically at dispatch time:

| Platform | Supported Media | Carousels | Caption Limit | Stories |
| :--- | :--- | :--- | :--- | :--- |
| **TikTok** | Video (MP4/MOV, 9:16) | 1 video | 2,200 chars | Supported |
| **YouTube** | Video (MP4/MOV/WebM) | 1 video | 5,000 chars | Not Supported |
| **Instagram** | Images & Videos (Mixed) | Up to 10 items | 2,200 chars | Supported |
| **Threads** | Images & Videos (Mixed) | Up to 10 items | 500 chars | Not Supported |
| **X (Twitter)** | Images (up to 4) OR 1 Video | 4 images / 1 video | 280 chars | Not Supported |
| **Telegram** | Images & Videos (Mixed) | Up to 10 items | 1,024 chars | Supported |
| **Pinterest** | Images or Video | 1-5 items | 500 chars | Supported |

---

## 4. Setup & Secrets

### Cloudflare Worker & Actions Secrets
Set the following secrets in Cloudflare Worker / GitHub Actions (never commit plain secrets):
- `DASHBOARD_PASSWORD`: Secure 24+ character password for operator dashboard access.
- `DASHBOARD_PASSWORD_HASH`: *(Optional)* PBKDF2 hash (`pbkdf2:100000:<salt_hex>:<hash_hex>`) for zero plaintext secrets at rest.
- `SESSION_SECRET`: Secret token used for signing session cookies and tokens.
- `ENCRYPTION_KEY`: Secret string used for AES-256-GCM key encryption of Zernio API keys at rest.
- `CALLBACK_SECRET`: Secret token for webhook HMAC verification between GitHub Actions and Worker.
- `GITHUB_PAT`: GitHub personal access token with `repo` and `workflow` scopes for Actions dispatch and Release asset streaming.
- `GOOGLE_DRIVE_API_KEY`: *(Optional)* Fallback for Google Drive public folder scraping.

### Security Architecture
1. **Zero Client Secrets:** The dashboard client bundle never contains passwords or API keys. The password field always starts empty.
2. **HttpOnly Cookies & Constant-Time Auth:** Operator sessions use signed `HttpOnly`, `Secure`, `SameSite=Strict` cookies or bearer tokens verified in constant time.
3. **Brute-Force Rate Limiting:** 5 failed login attempts trigger an automatic 15-minute lockout tracked in D1 (`auth_lockouts`).
4. **CORS Isolation:** Wildcard CORS is removed; requests are restricted to authorized origins (`salt-relay.pages.dev` and local dev).
5. **Private Media Proxy:** Release assets in private repositories are streamed to Zernio through the Worker proxy (`/api/public/media/:jobId/:assetName`), ensuring $0 cost and zero exposure.

### Local Development
```bash
npm install
npm run dev # Launches full-stack server on http://localhost:3000
```

---

## 5. Resuming from BUILD_STATE.json

Salt Relay maintains complete progress in `BUILD_STATE.json` at the repository root. An agent or developer can inspect:
- `phase`: Current build phase (`fix_pass_1_complete` / `awaiting_ui_refinement`).
- `tasks`: Completed vs blocked tasks.
- `cleanup`: Phase A audit log of all deleted, untouched, and blocked items.
- `resources`: Cloudflare and GitHub resource IDs and live URLs.
