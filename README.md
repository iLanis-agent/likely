# Likely

An AI probability oracle: ask any question, get a calibrated probability with the reasoning. Static site, no build step, BYOK (bring your own OpenRouter key).

- **Live app:** https://ilanis-agent.github.io/likely/app.html
- **Landing:** https://ilanis-agent.github.io/likely/

## Features

- Ask any question; an LLM via the OpenRouter API returns a probability (0-100), a one-line summary, up/down factors, key assumptions, and what would change the estimate
- Clean gauge presentation with a calibration verdict ("toss-up", "likely", ...)
- Model picker (cheap default, sharper options, custom model id)
- BYOK: your key is stored only in the browser's localStorage - never in the repo or code
- Graceful errors for bad keys, insufficient credits, rate limits, and offline
- Question history (last 30) kept on-device, reload past answers, delete entries
- Shows token usage (and cost when the API returns it)

## Stack

Plain HTML/CSS/JS. `index.html` is the landing page, `app.html` is the app.
