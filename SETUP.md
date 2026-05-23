# Hermes WebUI — Setup

Personal HuggingFace Spaces gateway. Routes a single public port (7861) to multiple internal services: the Hermes WebUI, the dashboard SPA, the `/v1` OpenAI-compat gateway, and `/hmd` passthrough.

> **Bypass mode active.** `health-server.js` accepts any submitted token and mints a session cookie. Do not deploy this elsewhere without re-enabling `timingSafeEqualString` in `isAuthorized()` and `handleLogin`.

---

## 1. Local run

### Prereqs
- Node.js 20+
- Python 3.11+ with `uv` (`pip install uv`)
- `hermes-webui` binary on PATH (or set `HERMES_WEBUI_BIN`)

### Env vars (`.env`)
```bash
GATEWAY_TOKEN=anything          # bypassed but still required by start.sh
GATEWAY_PORT=8000               # internal /v1 gateway
DASHBOARD_PORT=5173             # Vite dashboard
WEBUI_PORT=8787                 # hermes-webui
PUBLIC_PORT=7861                # the only exposed port
HERMES_WEBUI_PASSWORD=$GATEWAY_TOKEN

# Provider keys (set at least one)
NVIDIA_API_KEY=...
OPENROUTER_API_KEY=...

# Routing
MODEL=nvidia_nim/meta/llama-3.1-70b-instruct
```

### Start
```bash
chmod +x start.sh
./start.sh
```

Open `http://localhost:7861`. Submit any string at the login screen.

---

## 2. HuggingFace Space deploy

1. Create a new **Docker** Space.
2. Push this repo to the Space remote:
   ```bash
   git remote add hf https://huggingface.co/spaces/<you>/hermes-webui
   git push hf main
   ```
3. In Space **Settings → Variables and secrets**, set:
   - `GATEWAY_TOKEN` (any string — bypassed)
   - `NVIDIA_API_KEY` and/or `OPENROUTER_API_KEY`
   - `MODEL`, `MODEL_OPUS`, `MODEL_SONNET`, `MODEL_HAIKU` as desired
4. Space exposes port `7861` (already set in `start.sh`).

---

## 3. Architecture

```
public :7861  ──►  health-server.js  ──┬─►  :WEBUI_PORT      (hermes-webui)
                                       ├─►  :GATEWAY_PORT    (/v1/*)
                                       ├─►  :DASHBOARD_PORT  (/hm/app, /hmd)
                                       └─►  /assets, /api    (referer-routed)
```

- **WebSocket upgrades** routed by path prefix: `/v1` → gateway, `/hmd` & `/hm/app` → dashboard, everything else → WebUI with prefix stripped.
- **Sessions** signed via HMAC of `GATEWAY_TOKEN` (cookie still issued so downstream services see a consistent session).

---

## 4. Reverting the bypass

In `health-server.js`:

- `isAuthorized(req)` — restore the cookie HMAC check.
- `handleLogin` — restore the `timingSafeEqualString(submittedToken, GATEWAY_TOKEN)` guard and the "Invalid token" 401 branch.

Search for `// bypass` comments to find both call sites.

---

## 5. Commands cheatsheet

```bash
node health-server.js          # router only
./start.sh                     # full stack
npm run build                  # dashboard SPA build (if editing /hm/app)
uv run uvicorn server:app --port 8000   # gateway dev loop
```
