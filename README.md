---
title: HuggingMes Hermes WebUI
emoji: 🪽
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7861
pinned: true
license: mit
---

Run your own AI agent with a chat interface on Hugging Face Spaces — for free.

> **This is not original work.** It combines three great open-source projects into one easy-to-deploy package:
> - [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research — the AI brain
> - [Hermes WebUI](https://github.com/nesquena/hermes-webui) by @nesquena — the chat interface
> - [HuggingMes](https://github.com/somratpro/HuggingMes) by @somratpro — the Hugging Face wrapper

All credit goes to the original creators. This repo just wires them together.

---

## Quick Setup (5 minutes)

### 1. Duplicate the Space

[![Duplicate this Space](https://huggingface.co/datasets/huggingface/badges/resolve/main/duplicate-this-space-xl.svg)](https://huggingface.co/spaces/Zrk16/hermes-webui?duplicate=true)

Click badge, name Space → pick **CPU Basic (Free)** → keep public (else `.hf.space` URLs break).

### 2. Add Your Secrets

**Bypass mode active** — no login password needed. Only thing required is an LLM key.

Go to **Settings → Variables and secrets**:

| Secret | What It's For | How to Get It |
|--------|---------------|---------------|
| `LLM_API_KEY` | AI provider key (required) | OpenRouter / Anthropic / OpenAI / etc. |
| `LLM_MODEL` | Which model to call | e.g. `openrouter/anthropic/claude-sonnet-4` |
| `HF_TOKEN` *(optional)* | Persists chats across restarts | [Tokens page](https://huggingface.co/settings/tokens) → write scope |
| `CLOUDFLARE_WORKERS_TOKEN` *(optional)* | Keep-alive + Telegram proxy | [Cloudflare tokens](https://dash.cloudflare.com/profile/api-tokens) → **Edit Cloudflare Workers** template |

### 3. Add an AI Provider

Your agent needs an AI model to talk to. Add one of these API keys as a secret (or configure later in the dashboard):

| Secret | Provider |
|--------|----------|
| `OPENAI_API_KEY` | OpenAI (GPT models) |
| `ANTHROPIC_API_KEY` | Anthropic (Claude models) |
| `MOONSHOT_API_KEY` | Moonshot / Kimi |

Or configure manually later at `/hm/app/config` inside your Space.

### 4. Start It Up

Hit **Restart this Space** in Hugging Face. Wait 5–8 minutes for the first build.

When you see this in the Logs tab, you're ready:
```
HuggingMes + Hermes WebUI router listening on 0.0.0.0:7861
```

Open your Space URL (`https://your-name.hf.space`) in a **new tab**, submit any string at the login screen, and start chatting.
Open Hermes Dashboard from here (`https://f4b404-hermes.hf.space/hm/app`)


> **Pro tip:** Bookmark the direct `*.hf.space` URL — it works better on mobile than the Hugging Face embed.

---

## What You Get

| URL | What It Is |
|-----|------------|
| `/` | **Chat UI** — main interface for talking to your agent |
| `/hm` | Status dashboard — see what's running |
| `/hm/app/` | Settings — add AI models, set up cron jobs, manage profiles |
| `/v1/*` | API endpoint — connect other apps to your agent |
| `/telegram` | Telegram bot (if you added `TELEGRAM_BOT_TOKEN`) |

---

## Your Data Is Safe

When `HF_TOKEN` is set:
- All your chats, files, settings, and agent memory are backed up to a **private** Hugging Face Dataset every 10 minutes
- If the Space restarts, everything comes back exactly as you left it

---

## Common Issues

| Problem | Fix |
|---------|-----|
| Login keeps looping | Open the Space URL in a new tab (Hugging Face iframe blocks cookies) |
| Space goes to sleep after a few hours | Make sure `CLOUDFLARE_WORKERS_TOKEN` is set |
| Agent doesn't reply to questions | Check that you added an AI provider API key |
| Dashboard shows blank pages | Hard-refresh and clear service workers in browser dev tools |

---

## Want It on Your Phone?

Use the same (`https://your-name.hf.space`) url in android and then you can install it as Progressive Web App(PWA) or just use the same url on any browser for normal chat using the web.

---

# 🔧 Advanced Setup & Technical Details

> **Skip this section if you just want to chat.** The steps above are enough to get started. This part is for developers, power users, and anyone who wants to customize or understand the internals.

## Optional Secrets (Power Users)

| Secret | What It Does |
|--------|--------------|
| `CLOUDFLARE_ACCOUNT_ID` | Explicit Cloudflare account ID if you have multiple |
| `TELEGRAM_BOT_TOKEN` | Enables the Telegram bridge so you can chat with Hermes from Telegram |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated numeric Telegram user IDs allowed to use the bot |
| `PRIMARY_UI` | Set to `dashboard` to make `/` show the HuggingMes status page instead of the chat UI. Default is `webui`. |
| `SYNC_INTERVAL` | Backup cadence in seconds (default 600, range 60–86400) |
| `HERMES_AGENT_VERSION` | Pin the upstream Hermes Agent base image to a specific tag for reproducibility (default `latest`) |
| `BACKUP_DATASET_NAME` | Name of the private HF Dataset used for persistence (default `huggingmes-backup`) |

## Configure LLM Provider via Config Editor

If you prefer not to add API keys as HF Secrets, you can configure providers directly in Hermes after the Space starts:

1. Open `/hm/app/config` in your Space
2. Add your provider under the `llm` section:

```yaml
llm:
  openai:
    api_key: "${OPENAI_API_KEY}"
  anthropic:
    api_key: "${ANTHROPIC_API_KEY}"
  moonshot:
    api_key: "${MOONSHOT_API_KEY}"
    base_url: "https://api.moonshot.cn/v1"
```

If you set the API keys as HF Secrets, you can reference them with `${VAR_NAME}` as shown above. Hermes supports many providers — see the [Hermes Agent docs](https://github.com/NousResearch/hermes-agent) for the full list.

## Using the API from Code

Your Space exposes an OpenAI-compatible API at `/v1/*`. Bearer is the ephemeral `API_SERVER_KEY` minted by `start.sh` at boot — grab it from the Logs tab (or set `GATEWAY_TOKEN` to pin it).

```shell
curl https://<you>-<name>.hf.space/v1/chat/completions \
  -H "Authorization: Bearer $API_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hermes",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<you>-<name>.hf.space/v1",
    api_key="<your API_SERVER_KEY>",
)
resp = client.chat.completions.create(
    model="hermes",
    messages=[{"role": "user", "content": "hello"}],
)
```

## Adding MCP Servers

MCP (Model Context Protocol) servers extend your agent's capabilities. Add them via the config editor at `/hm/app/config`:

```yaml
mcp:
  servers:
    fetch:
      command: uvx
      args: ["mcp-server-fetch"]
    filesystem:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/opt/data/workspace"]
```

`uvx` and `npx` are pre-installed in the image.

## Persistence Details

When `HF_TOKEN` is set:

*   **On boot**, the Space downloads the latest snapshot from your private HF Dataset and restores it into `/opt/data/`.
*   **Every `SYNC_INTERVAL` seconds** (default 600), it detects state changes and uploads a new snapshot.
*   **On graceful shutdown** (SIGTERM), it does one final sync before exit.

What gets backed up: chat sessions, agent memory, workspace files, profiles, skills, cron jobs, Hermes config. The dataset is private to your HF account.

## Architecture

Single port (7861) Node.js router fronts multiple backends:

```
HF Space port 7861
        │
        ▼
   health-server.js  (router + auth + status page)
        │
        ├─► /                  → Hermes WebUI         (127.0.0.1:8787)
        ├─► /hm                → HuggingMes status    (in-process)
        ├─► /hm/app/*          → Hermes dashboard     (127.0.0.1:9119)  [SPA-rewritten]
        ├─► /v1/*              → Hermes gateway API   (127.0.0.1:8642)  [bearer auth]
        ├─► /telegram          → Telegram webhook     (127.0.0.1:8765)
        └─► /health, /status   → in-process JSON
```

`start.sh` boots Hermes Agent's gateway + dashboard + WebUI as subprocesses, then the router on top. `hermes-sync.py` runs the periodic HF Dataset upload loop. Cloudflare and Telegram setup runs once at boot if their respective secrets are set.

## Local Testing

```shell
git clone https://github.com/F4bC0d3/huggingmes-hermes-webui.git
cd huggingmes-hermes-webui
cp .env.example .env
# edit .env with LLM_API_KEY + LLM_MODEL (GATEWAY_TOKEN optional; bypass mode is on)
docker build -t huggingmes-hermes-webui .
docker run --rm -p 7861:7861 --env-file .env huggingmes-hermes-webui
# open http://localhost:7861
```

## Extended Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| Build fails on `nousresearch/hermes-agent:latest` | Set `HERMES_AGENT_VERSION` to a specific tag and restart |
| Container Running but `/` returns 502 | Hermes WebUI didn't bind. Check Logs tab for `webui.log` output — usually missing/wrong provider API key or LLM config |
| `/v1/*` returns 401 | Need `Authorization: Bearer <API_SERVER_KEY>` header — grab the ephemeral key from the Logs tab, or set `GATEWAY_TOKEN` to pin it |
| `/api/status` 404s in logs | Cosmetic — old browser tab polling. Ignored. |
| Login loops on `/login` | Browser embedded in HF iframe blocks cookies. Open the Space in a new tab. |
| Dashboard pages blank or 404 on refresh | Should be fixed by the SPA rewriter in health-server.js. Hard-refresh and unregister service worker if cached: DevTools → Application → Service Workers → Unregister |
| Space sleeps after a few hours | Free tier limitation. Add `CLOUDFLARE_WORKERS_TOKEN` to provision a keep-alive cron worker |
| Telegram bot doesn't respond | HF Spaces blocks `api.telegram.org` egress. Add `CLOUDFLARE_WORKERS_TOKEN` to auto-provision an outbound proxy |
| Two Spaces overwriting each other's backup | Set different `BACKUP_DATASET_NAME` on each |
| Agent responds but cannot answer questions | No LLM provider configured. Add provider API keys and restart, or configure via `/hm/app/config` |

## Credits

*   **[Nous Research](https://nousresearch.com/)** for **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** — the agent runtime, the persistent memory system, the multi-provider LLM routing, the cron and skills systems. None of this exists without their work.
*   **[@nesquena](https://github.com/nesquena)** for **[Hermes WebUI](https://github.com/nesquena/hermes-webui)** — the chat interface you actually see and use. Three-panel layout, SSE streaming, slash commands, profile management, theme system, mobile responsive design — all theirs.
*   **[@somratpro](https://github.com/somratpro)** for **[HuggingMes](https://github.com/somratpro/HuggingMes)** — the HF Space packaging, the HF Dataset backup engine (`hermes-sync.py`), the Cloudflare proxy and keepalive setup, the Telegram integration, and the gateway auth wrapper.

This repo's only contribution is the integration layer: a Node.js router that fronts both UIs on a single HF Space port, a bypass-mode login (any string mints a session) with an ephemeral `API_SERVER_KEY` for `/v1`, and minor tweaks to `start.sh` to launch hermes-webui alongside the existing HuggingMes processes. If you find this useful, star the upstream projects.

## License

MIT — same as all upstream projects.
