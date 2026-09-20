# Likely

Ask any question about the future, get a calibrated probability back.

**Live:** https://ilanis-agent.github.io/likely/ (redirects to the worker) - https://likely.ilanis-likely.workers.dev/

## Architecture (v2)

- **Frontend + API:** a single Cloudflare Worker serves the web app at `/` and three JSON endpoints: `POST /api/ask`, `POST /api/history`, `POST /api/costs`.
- **Model:** jev only (`~typesafe/jev-latest`, the TypeSafe Decisions API on OpenRouter), hardcoded server-side. No model picker, no BYOK - the OpenRouter key is a Worker secret (`OPENROUTER_KEY`).
- **Access control:** passphrase gate checked server-side against the `APP_PASSPHRASE` secret (constant-time compare). Nothing works without it - every endpoint returns 401.
- **Storage:** Cloudflare D1 (`likely-db`, table `asks`) holds every question, the full answer breakdown, input tokens, and per-request cost from OpenRouter `usage.cost`.
- **Cost view:** the app shows spend per request and running totals by day.
- The question is sent as a 4-part battery: likelihood (noul), forecaster confidence (score), main driver (choice), and personal influence (noul). Replies render as a gauge plus confidence / driver / influence chips.

GitHub Pages (`index.html`, `app.html`) now just redirects to the worker.

## v1 (legacy)

The original static BYOK version lived fully in the browser (OpenRouter key in localStorage, direct `chat/completions` calls, localStorage history). Replaced by v2 on 2026-09-20.
