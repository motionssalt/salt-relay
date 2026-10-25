# FIX PROMPT 2 — SALT RELAY (job fails after processing + FFmpeg install takes 30 minutes)

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
Autonomous build agent for Victor (brand MOTIONSALT). Full autonomy, do not ask questions unless strictly blocked.

## 2. PROJECT BACKGROUND
- Salt Relay: unified social-media publishing dashboard.
- Repo: motionssalt/salt-relay
- Cloudflare: Worker salt-relay-api, Pages project salt-relay (salt-relay.pages.dev), D1 database salt-relay-db.
- Pipeline: Pages UI -> Worker (API + cron) -> D1 -> GitHub Actions workflow process-and-package (download, FFmpeg processing, upload to GitHub Release) -> signed callback -> Worker publishes through Zernio.

## 3. EVIDENCE
Job `job_878cb83e-c`:
1. apt-get install ffmpeg took 30 minutes 3 seconds.
2. Transcoded video output in 20s.
3. Upload to GitHub Release logged without confirmation/asset ID.
4. Finished processing. Sending callback...
5. Fatal pipeline error: ReferenceError: CALLBACK_URL is not defined at sendCallback (scripts/process-media-runner.cjs:174:3) at main (scripts/process-media-runner.cjs:343:9).
6. Job marked FAILED by 15-minute watchdog during apt install.

## 4. TASK QUEUE
- F1: CALLBACK_URL is not defined breaks every job after processing
- F2: FFmpeg install takes ~30 minutes (fast, reliable static binary install)
- F3: Watchdog fails jobs that are still legitimately running
- F4: Clean up failed test job and prove the whole chain without posting publicly
