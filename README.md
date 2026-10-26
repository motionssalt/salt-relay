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

1. **Saved Source Links & Attempt Number**: Click any job in History to inspect **Saved Source Links (`job_sources`)** and the active **Attempt #N** badge. Original media links (direct image/video URLs or public Google Drive file/folder links) are stored immutably at creation time and are never overwritten by processing steps.
2. **Job Details & Run Log Link**: Every dispatched GitHub Actions transcode run records its exact run ID and exposes a direct **"Run Log" / "View Run Log"** link (`https://github.com/motionssalt/salt-relay/actions/runs/<id>`) both on the job card and inside the detail drawer.
3. **Job Event Timeline**: Scroll down to the **Event Timeline** in the job detail modal to see timestamped stage transitions (`created`, `dispatching`, `dispatched`, `watchdog_extended`, `transcoded`, `publishing`, `retried`, `dest_published`, `dest_failed`).
4. **Smart Media-Aware & Idempotent Retry**:
   - **Verified Release Asset Reuse**: When tapping **Retry** on a `failed` or `partially_published` job, the Worker first checks GitHub Release `media-001` to verify whether all processed assets still exist with matching byte size and SHA-256 digest (`job_media.sha256`). If verified, it skips FFmpeg reprocessing and retries unfulfilled destinations immediately.
   - **Automatic Re-Dispatch from Immutable Sources**: If release assets were not yet uploaded or were cleaned up, Retry automatically increments `attempt_count` and dispatches a fresh `process-media.yml` workflow run from the saved `job_sources` links.
   - **Strict Per-Destination Idempotency**: Destinations already marked `published` or `skipped` are never re-sent; zero-media caption-only fallbacks are blocked at both creation and publication stages.
   - **Legacy Job Guard**: If an older job genuinely has no saved media links anywhere, Retry refuses immediately with `"This job's original media links were not saved, so it cannot be retried. Create a new post."`
5. **Late Callback Acceptance**: If a job was marked failed due to a temporary watchdog timeout while a long run was still progressing, the Worker automatically accepts the signed HMAC late callback when the runner finishes, recovers unfulfilled destinations, and completes publication.

### Stage Reference

| Stage | What Happens | Where to Look If Stalled |
| :--- | :--- | :--- |
| `create_validation` | Validates at least 1 valid `http(s)` direct media URL or Google Drive file/folder URL with ID, plus schedule UTC normalization. | Composer error banner / `POST /api/jobs` HTTP 400 `stage` + `field` response. |
| `created` | Job, immutable `job_sources` rows (`sources_json`), and per-destination rows inserted into D1. | Check `/api/jobs/:id` -> `sources` & `job_destinations` in D1. |
| `dispatching` / `dispatched` | Worker calls GitHub Actions `workflow_dispatch` on `process-media.yml` (immediately for `now` or due schedules) and records run ID & URL. | Verify Worker has valid `GITHUB_PAT` secret with `repo`+`workflow` scopes; inspect `dispatch_failed` event if HTTP != 204. |
| `transcoding` | GitHub Actions runner expands Drive folders/files, downloads media, and transcodes via cached static FFmpeg binary (`libx264` + `aac`). | Click **"Run Log"** on the job card or detail modal to inspect real-time FFmpeg progress. |
| `transcoded` | Runner uploads transcoded media to GitHub Release (`media-001`), verifies HTTP 201 + asset size + SHA-256, and sends signed HMAC callback. | GitHub repository **Releases** tab (`media-001`) and `job_media` table in D1. |
| `publishing` | Worker guards against 0-media payloads and dispatches media URLs via `/api/public/media/:jobId/:assetName` (302 signed CDN redirect) to Zernio. | Check `CALLBACK_SECRET` match between Worker & Actions; inspect Zernio API status in `job_events`. |
| `retried` | Operator triggered Retry (`Attempt #N`): either reused size/SHA-256-verified release assets or re-dispatched `process-media.yml` from `job_sources`. | Job detail modal (`Attempt #N`, `Event Timeline`, and `View Run Log`). |
| `published` / `partially_published` | Zernio confirms publication. Temporary release assets on `media-001` are deleted only once all non-skipped destinations are `published`. | View Target Destinations breakdown or click external post links. |
| `failed` | Specific stage & error message recorded from validation, GitHub dispatch, FFmpeg runner, or Zernio platform API. | Check red Execution Error banner; tap **Retry** to re-run unfulfilled destinations with media. |
| `watchdog_extended` | Cron watchdog queried GitHub Actions API, confirmed the run is actively `queued` or `in_progress`, and extended deadline (up to 45m hard cap). | Normal for large multi-video Drive folders. |
| `watchdog_timeout` | Run exceeded 45-minute hard cap or runner failed/cancelled without callback. | Click **"Run Log"** on the job card to inspect the GitHub Actions failure step. |
| `cancelled` | Operator explicitly cancelled the job. Cancelled jobs are permanently sealed and never auto-resurrect on late callbacks. | Marked by operator action in dashboard. |

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
