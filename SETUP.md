# Hermes WebUI — Setup

Personal HuggingFace Spaces gateway. Single public port (7861) fronts the Hermes WebUI, the dashboard SPA, the `/v1` OpenAI-compat gateway, and `/hmd` passthrough.

> **Bypass mode active.** `health-server.js` accepts any submitted token and mints a session cookie. Do not deploy this elsewhere without re-enabling `timingSafeEqualString` in `isAuthorized()` and `handleLogin`.

---

## 1. One-click HF Space deploy

[![Duplicate this Space](https://huggingface.co/datasets/huggingface/badges/resolve/main/duplicate-this-space-lg.svg)](https://huggingface.co/spaces/Zrk16/hermes-webui?duplicate=true)

Click → pick **CPU Basic (Free)** → keep public. The duplicate flow prompts for the secrets below; you only need the first two.

| Secret | Required? | What it does |
|---|---|---|
| `LLM_API_KEY` | yes | provider key (OpenRouter / OpenAI / Anthropic / etc.) |
| `LLM_MODEL` | yes | e.g. `openrouter/anthropic/claude-sonnet-4` |
| `HF_TOKEN` | optional | persists chats to a private HF Dataset every 10 min |
| `CLOUDFLARE_WORKERS_TOKEN` | optional | keep-alive + Telegram proxy |

No `GATEWAY_TOKEN` needed. `start.sh` mints an ephemeral `API_SERVER_KEY` at boot for `/v1` bearer auth.

After secrets save → **Restart Space** → wait 5–8 min for first build. Open the `*.hf.space` URL in a **new tab**, submit any string at the login screen.

---

## 2. Local run

### Prereqs
- Node.js 20+
- Python 3.11+ with `uv` (`pip install uv`)
- `hermes-webui` binary on PATH (or set `HERMES_WEBUI_BIN`)

### `.env`
```bash
LLM_API_KEY=sk-...
LLM_MODEL=openrouter/anthropic/claude-sonnet-4
# All else optional. start.sh defaults the rest.
```

### Start
```bash
chmod +x start.sh
./start.sh
```

Open `http://localhost:7861`. Submit any string at login.

---

## 3. Architecture

```
public :7861  ──►  health-server.js  ──┬─►  :WEBUI_PORT      (hermes-webui)
                                       ├─►  :GATEWAY_PORT    (/v1/*)
                                       ├─►  :DASHBOARD_PORT  (/hm/app, /hmd)
                                       └─►  /assets, /api    (referer-routed)
```

- **WebSocket upgrades** routed by path prefix: `/v1` → gateway, `/hmd` & `/hm/app` → dashboard, everything else → WebUI with prefix stripped.
- **Sessions** signed via HMAC of the active token (autogen or `GATEWAY_TOKEN` if set). Cookie still issued so downstream services see a consistent session.

---

## 4. Reverting the bypass

In `health-server.js`:
- `isAuthorized(req)` — restore the cookie HMAC check.
- `handleLogin` — restore `timingSafeEqualString(submittedToken, GATEWAY_TOKEN)` and the 401 branch.

Search for `// bypass` to find both call sites.

---

## 5. Cheatsheet

```bash
node health-server.js                    # router only
./start.sh                               # full stack
npm run build                            # dashboard SPA build
uv run uvicorn server:app --port 8000    # gateway dev loop
```
