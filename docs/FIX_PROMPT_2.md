# FIX PROMPT 2 — SALT RELAY (callback failure after processing, slow FFmpeg install, media sources lost: new posts never start and Retry sends no media)

## STEP 0: CREDENTIALS (read first)
```
GITHUB_PAT = [CONFIGURED_IN_ACTIONS_SECRET]
CLOUDFLARE_API_TOKEN  = [CONFIGURED_IN_WORKER_SECRET]
CLOUDFLARE_ACCOUNT_ID = 5dc9710ac37c9ce333dce2434ce4343b
# Project-specific values already stored as secrets in GitHub Actions / the Worker (read them there, do not ask for them):
# CALLBACK_SECRET, ENCRYPTION_KEY, dashboard password hash/secret
```

---

## 1. ROLE AND AUTONOMY
Autonomous build agent with FULL AUTONOMY. Do not stop to ask Victor anything unless the work genuinely cannot continue. Record assumptions in `BUILD_STATE.json` -> `decisions`.

## 2. PROJECT BACKGROUND
- **Salt Relay** is Victor's (brand MOTIONSALT) unified social-media publishing dashboard.
- Repo: `motionssalt/salt-relay` (private). Cloudflare: Worker `salt-relay-api`, Pages project `salt-relay` (`salt-relay.pages.dev`), D1 database `salt-relay-db`.
- Pipeline: Pages UI -> Worker (API + cron) -> D1 -> GitHub Actions workflow `process-and-package` (download, FFmpeg processing, upload to GitHub Release) -> signed callback -> Worker publishes through Zernio. Release assets are deleted only after all dependent publications are confirmed.

## 3. EVIDENCE (2026-10-22 run, job `job_878cb83e-c`)
1. FFmpeg install via apt pulled 99 packages and took 30m 3s.
2. Video encoded cleanly in ~20s, uploaded to release without confirmation log.
3. Crashed with `ReferenceError: CALLBACK_URL is not defined at sendCallback (scripts/process-media-runner.cjs:174:3)`.
4. Watchdog killed the job at ~15m during the slow apt install.

## 3B. NEW EVIDENCE (reported by Victor on 2026-10-26)
- **Symptom A, Retry sends no media:** when a video job fails and Victor taps **Retry** in History, the retried job contains only the caption and the hashtags. No media files are attached to it, so it fails again every single time.
- **Symptom B, new posts never start:** when Victor creates a brand-new post and then opens the repo's GitHub **Actions** tab, **no workflow run appears at all** (nothing is dispatched). The job then fails with a message saying media files are required for the project.

## 9. TASK QUEUE
- **F1:** `CALLBACK_URL is not defined` breaks every job after processing (verify release upload, retries, failure callback, late callback acceptance).
- **F2:** FFmpeg install takes ~30 minutes (cached static binary <1m, encoders verified, apt fallback, Node 24 actions).
- **F3:** Watchdog fails jobs that are still legitimately running (track real GitHub Actions run status, clear reasons, run link in UI).
- **F4:** Clean up failed test job `job_878cb83e-c` orphan asset and dry-run verify whole chain + public media reachability + README troubleshooting.
- **F5:** New posts never dispatch the workflow and fail with "media files required" (persist immutable original sources via remote D1 migration, validate source links at creation, normalize schedule timezones & dispatch immediately when due/now, fail specifically with real GitHub errors).
- **F6:** Retry sends only caption and hashtags, never the media (rebuild Retry from immutable original sources, smart verified release asset reuse by size/hash, idempotent destination retry, legacy job guard & recovery backfill, show saved source links & attempt number in job detail UI).
