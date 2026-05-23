"use strict";

/**
 * HuggingMes + Hermes WebUI — single-port router on HF Space port 7861.
 *
 * Routes:
 *   /login                -> HuggingMes login (password = GATEWAY_TOKEN)
 *   /health /status       -> JSON health (unauthenticated — for HF probes + keepalive)
 *   /hm  /hm/*            -> HuggingMes status page + app (auth-gated)
 *   /hmd /hmd/*           -> Hermes dashboard passthrough for off-Space
 *                            workspaces (no router auth — dashboard's own
 *                            session token gates writes; opt-in by URL)
 *   /dashboard            -> redirect to /hm
 *   /v1  /v1/*            -> Hermes gateway (bearer auth; HTML => login redirect)
 *   /telegram  /telegram/*-> Telegram webhook (unauthenticated; Telegram needs to reach it)
 *   everything else       -> Hermes WebUI (nesquena/hermes-webui) as the primary UI
 *                           WebUI handles its own login at /login-... no, wait: WebUI
 *                           also exposes /login. We keep HuggingMes' login at /login
 *                           so the shared GATEWAY_TOKEN gates both.
 *
 * Based on github.com/somratpro/HuggingMes with added WebUI routing as the
 * primary UI.
 */

const http = require("http");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const WEBUI_PORT = Number(process.env.HERMES_WEBUI_PORT || 8787);
const GATEWAY_HOST = "127.0.0.1";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || "";
const HM_PREFIX = "/hm";
// Dashboard passthrough for off-Space workspaces (e.g. hermes-workspace
// running on a laptop). Anything under /hmd/* is forwarded directly to the
// internal dashboard with no router-level auth — the dashboard's own
// ephemeral session token is the only gate. This is intentional: the
// workspace scrapes that token from /hmd/ and then sends it as the bearer
// on /hmd/api/* requests, exactly mirroring the dashboard's normal flow.
//
// Implication: anyone who can reach this Space's URL can call the dashboard
// API (sessions, skills, config). If you don't need remote workspace access,
// don't share the Space URL or set up an upstream auth layer.
const HMD_PREFIX = "/hmd";
const LOGIN_PATH = "/hm/login";
const SESSION_COOKIE = "huggingmes_session";
const PRIMARY_UI = (process.env.PRIMARY_UI || "webui").toLowerCase();

const SYNC_STATUS_FILE = "/tmp/huggingmes-sync-status.json";
const CLOUDFLARE_KEEPALIVE_STATUS_FILE =
  "/tmp/huggingmes-cloudflare-keepalive-status.json";

/* ── Port probing + auth ──────────────────────────────────────────── */

function canConnect(port, host = GATEWAY_HOST, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readJson(path, fallback = null) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function timingSafeEqualString(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function expectedSessionValue() {
  if (!API_SERVER_KEY) return "";
  return crypto
    .createHmac("sha256", API_SERVER_KEY)
    .update("huggingmes-session-v1")
    .digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const item of header.split(";")) {
    const sep = item.indexOf("=");
    if (sep < 0) continue;
    const name = item.slice(0, sep).trim();
    const value = item.slice(sep + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function buildSessionCookie(req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(expectedSessionValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : "";
}

function isAuthorized(req) {
  return true;
}

function sanitizeNext(value, fallback = "/") {
  if (!value || typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

function loginUrl(nextPath) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(nextPath))}`;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* ── Login page ───────────────────────────────────────────────────── */

function renderLoginPage(nextPath, errorMessage = "") {
  const safeNext = sanitizeNext(nextPath, "/");
  const errorHtml = errorMessage
    ? `<div class="hm-error">${escapeHtml(errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HERMES // AUTH</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg:#0B0C0E; --surface:#13151A; --hairline:#23262D;
      --text:#E8E6E1; --dim:#6B6E76; --signal:#FF6A1A; --ok:#7EE787; --warn:#F5C518;
      --mono:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans:'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
    }
    * { box-sizing:border-box; }
    html, body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font-family:var(--sans); }
    body { display:grid; grid-template-rows:auto 1fr auto; }
    .hm-strip { display:flex; gap:24px; padding:10px 20px; border-bottom:1px solid var(--hairline); font-family:var(--mono); font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--dim); }
    .hm-strip b { color:var(--text); font-weight:500; }
    .hm-strip .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--warn); margin-right:6px; vertical-align:middle; animation:pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }
    main { display:grid; place-items:center; padding:40px 20px; }
    .hm-card { width:min(440px, 100%); border:1px solid var(--hairline); background:var(--surface); padding:28px; border-radius:2px; }
    .hm-eyebrow { font-family:var(--mono); font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--dim); margin:0 0 6px; }
    h1 { margin:0 0 4px; font-size:24px; font-weight:500; letter-spacing:-0.01em; }
    .hm-sub { margin:0 0 24px; color:var(--dim); font-size:13px; line-height:1.55; }
    .hm-sub code { font-family:var(--mono); color:var(--text); font-size:12px; }
    .hm-sub a { color:var(--signal); text-decoration:none; border-bottom:1px solid transparent; }
    .hm-sub a:hover { border-color:var(--signal); }
    label { display:block; font-family:var(--mono); font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--dim); margin-bottom:8px; }
    input { width:100%; min-height:42px; border:0; border-bottom:1px solid var(--hairline); background:transparent; color:var(--text); padding:0 2px; font-family:var(--mono); font-size:14px; transition:border-color 140ms cubic-bezier(0.22,1,0.36,1); }
    input:focus { outline:none; border-bottom-color:var(--signal); }
    button { width:100%; min-height:42px; margin-top:20px; border:1px solid var(--signal); border-radius:2px; color:var(--bg); background:var(--signal); font-family:var(--mono); font-size:12px; letter-spacing:0.08em; text-transform:uppercase; font-weight:500; cursor:pointer; transition:opacity 140ms; }
    button:hover { opacity:.85; }
    .hm-error { border:1px solid var(--signal); background:rgba(255,106,26,.06); color:var(--text); padding:10px 12px; margin-bottom:16px; font-family:var(--mono); font-size:12px; border-radius:2px; }
    footer { padding:12px 20px; border-top:1px solid var(--hairline); font-family:var(--mono); font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:var(--dim); display:flex; justify-content:space-between; }
  </style>
</head>
<body>
  <div class="hm-strip">
    <span><span class="dot"></span>auth.required</span>
    <span>session · <b>none</b></span>
    <span>endpoint · <b>${escapeHtml(LOGIN_PATH)}</b></span>
    <span>next · <b>${escapeHtml(safeNext)}</b></span>
  </div>
  <main>
    <div class="hm-card">
      <p class="hm-eyebrow">// gateway</p>
      <h1>Hermes Console</h1>
      <p class="hm-sub">Submit any string to mint a session. Bypass mode active — token equality not enforced. Chat UI lives at <a href="/">/</a>.</p>
      ${errorHtml}
      <form method="post" action="${LOGIN_PATH}">
        <input type="hidden" name="next" value="${escapeHtml(safeNext)}" />
        <label for="token">access · token</label>
        <input id="token" name="token" type="password" autocomplete="current-password" autofocus />
        <button type="submit">Authenticate →</button>
      </form>
    </div>
  </main>
  <footer>
    <span>hermes · v1</span>
    <span>0x${Math.random().toString(16).slice(2,10)}</span>
  </footer>
</body>
</html>`;
}

async function handleLogin(req, res, parsed) {
  const nextPath = sanitizeNext(parsed.searchParams.get("next") || "/", "/");

  if (!API_SERVER_KEY) {
    redirect(res, nextPath);
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderLoginPage(nextPath));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const submittedToken = params.get("token") || "";
    const submittedNext = sanitizeNext(params.get("next") || nextPath, "/");

    void submittedToken;

    res.writeHead(302, {
      location: submittedNext,
      "set-cookie": buildSessionCookie(req),
      "cache-control": "no-store",
    });
    res.end();
  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(error.message || "Invalid login request.");
  }
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  const parsed = new URL(req.url, "http://localhost");
  redirect(res, loginUrl(`${parsed.pathname}${parsed.search}`));
  return false;
}

/* ── Upstream proxy ────────────────────────────────────────────────── */

function proxyRequest(
  req,
  res,
  targetPort,
  rewritePath = (path) => path,
  headerOverrides = {},
) {
  const parsed = new URL(req.url, "http://localhost");
  const targetPath = rewritePath(parsed.pathname) + parsed.search;
  const headers = {
    ...req.headers,
    ...headerOverrides,
    host: `${GATEWAY_HOST}:${targetPort}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
  };

  const proxy = http.request(
    {
      hostname: GATEWAY_HOST,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  proxy.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  req.pipe(proxy);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { location });
  res.end();
}

/* ── Dashboard SPA proxy with HTML rewriting ──────────────────────────
 *
 * The Hermes dashboard is a Vite React app built for root-path deployment.
 * Its HTML hardcodes window.__HERMES_BASE_PATH__="" and absolute src/href
 * paths like /assets/index-XXX.js. Under /hm/app, React's router wouldn't
 * know its basename and client-side routes (/config, /sessions, etc.) 404
 * on refresh.
 *
 * This proxy:
 *   - serves the dashboard's index.html for any non-asset /hm/app/* path
 *     (SPA fallback, so /config, /profiles etc. work on direct load)
 *   - rewrites the returned HTML so React router uses /hm/app as its
 *     basename and absolute asset paths get prefixed with /hm/app
 */
function proxyDashboard(req, res) {
  const parsed = new URL(req.url, "http://localhost");
  const inner = parsed.pathname.replace(`${HM_PREFIX}/app`, "") || "/";

  const isAssetLike =
    inner.startsWith("/assets/") ||
    inner.startsWith("/api/") ||
    inner.startsWith("/dashboard-plugins/") ||
    inner.startsWith("/ds-assets/") ||
    /\.[a-z0-9]{1,6}$/i.test(inner);

  // SPA routes → serve index.html; everything else → forward as-is.
  const targetPath =
    (isAssetLike || inner === "/" ? inner : "/") + parsed.search;

  const headers = {
    ...req.headers,
    host: `${GATEWAY_HOST}:${DASHBOARD_PORT}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
    // Disable upstream compression so we can rewrite text responses.
    "accept-encoding": "identity",
  };

  const upstream = http.request(
    {
      hostname: GATEWAY_HOST,
      port: DASHBOARD_PORT,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upRes) => {
      const contentType = String(upRes.headers["content-type"] || "");
      const shouldRewrite =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml");

      if (!shouldRewrite) {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        return;
      }

      const chunks = [];
      upRes.on("data", (chunk) => chunks.push(chunk));
      upRes.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");

        // Tell the React router its basename.
        body = body.replace(
          /window\.__HERMES_BASE_PATH__\s*=\s*"[^"]*"/g,
          `window.__HERMES_BASE_PATH__="${HM_PREFIX}/app"`,
        );

        // Prefix absolute asset URLs so they stay under /hm/app.
        const prefix = `${HM_PREFIX}/app`;
        body = body.replace(
          /\b(src|href)="\/(?!\/|http)([^"]*)"/g,
          (match, attr, rest) => {
            if (
              ("/" + rest).startsWith(prefix + "/") ||
              "/" + rest === prefix
            ) {
              return match;
            }
            return `${attr}="${prefix}/${rest}"`;
          },
        );

        const buf = Buffer.from(body, "utf8");
        const outHeaders = { ...upRes.headers };
        delete outHeaders["content-length"];
        delete outHeaders["transfer-encoding"];
        delete outHeaders["content-encoding"];
        outHeaders["content-length"] = String(buf.length);

        res.writeHead(upRes.statusCode || 502, outHeaders);
        res.end(buf);
      });
      upRes.on("error", () => {
        try {
          res.writeHead(502);
          res.end();
        } catch {}
      });
    },
  );

  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  req.pipe(upstream);
}

/* ── Status JSON + HuggingMes status page ─────────────────────────── */

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function statusPayload() {
  const gateway = await canConnect(GATEWAY_PORT);
  const dashboard = await canConnect(DASHBOARD_PORT);
  const webui = await canConnect(WEBUI_PORT);
  const telegramWebhook =
    !!process.env.TELEGRAM_WEBHOOK_URL &&
    (await canConnect(TELEGRAM_WEBHOOK_PORT));
  const sync = readJson(
    SYNC_STATUS_FILE,
    process.env.HF_TOKEN
      ? { status: "configured", message: "Backup enabled; waiting for first sync." }
      : { status: "disabled", message: "HF_TOKEN is not configured." },
  );

  return {
    ok: gateway && webui,
    uptime: formatUptime(Date.now() - startTime),
    startedAt: new Date(startTime).toISOString(),
    gateway,
    dashboard,
    webui,
    authConfigured: !!API_SERVER_KEY,
    primaryUi: PRIMARY_UI,
    ports: {
      public: PORT,
      gateway: GATEWAY_PORT,
      dashboard: DASHBOARD_PORT,
      webui: WEBUI_PORT,
      telegramWebhook: TELEGRAM_WEBHOOK_PORT,
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      webhook: !!process.env.TELEGRAM_WEBHOOK_URL,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
      webhookListening: telegramWebhook,
      proxy: process.env.CLOUDFLARE_PROXY_URL || "",
    },
    model:
      process.env.MODEL_FOR_CONFIG ||
      process.env.HERMES_MODEL ||
      process.env.LLM_MODEL ||
      "",
    provider:
      process.env.PROVIDER_FOR_CONFIG ||
      process.env.HERMES_INFERENCE_PROVIDER ||
      "auto",
    backup: sync,
    keepalive: readJson(CLOUDFLARE_KEEPALIVE_STATUS_FILE, null),
  };
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function valueOrUnset(value, fallback = "Not set") {
  return value
    ? escapeHtml(value)
    : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function renderTile({ title, value, detail = "", tone = "neutral", meta = "" }) {
  return `<article class="tile ${tone}">
    <div class="tile-head">
      <span class="tile-title">${escapeHtml(title)}</span>
      <span class="tile-dot"></span>
    </div>
    <div class="tile-value">${value}</div>
    ${detail ? `<div class="tile-detail">${detail}</div>` : ""}
    ${meta ? `<div class="tile-meta">${meta}</div>` : ""}
  </article>`;
}

function renderStatusPage(data) {
  const syncStatus = String(data.backup?.status || "unknown");
  const syncTone = ["success", "restored", "synced", "configured"].includes(syncStatus)
    ? "ok"
    : syncStatus === "disabled"
      ? "warn"
      : "neutral";
  const telegramTone = data.telegram.configured
    ? data.telegram.webhookListening || !data.telegram.webhook
      ? "ok"
      : "warn"
    : "warn";
  const keepaliveConfigured = data.keepalive?.configured === true;
  const keepaliveStatus = String(
    data.keepalive?.status ||
      (process.env.CLOUDFLARE_WORKERS_TOKEN ? "pending" : "not configured"),
  );
  const keepAliveTone = keepaliveConfigured
    ? "ok"
    : process.env.CLOUDFLARE_WORKERS_TOKEN
      ? "warn"
      : "neutral";
  const telegramDetail = data.telegram.configured
    ? `${data.telegram.webhook ? "Webhook" : "Polling"}${data.telegram.proxy ? " via CF proxy" : ""}`
    : "Not configured";
  const backupDetail = data.backup?.message
    ? escapeHtml(data.backup.message)
    : "No status yet";
  const keepAliveDetail = keepaliveConfigured
    ? `Pinging <code>${escapeHtml(data.keepalive.targetUrl || "/health")}</code>`
    : keepaliveStatus === "error" && data.keepalive?.message
      ? escapeHtml(data.keepalive.message)
      : process.env.CLOUDFLARE_WORKERS_TOKEN
        ? "Worker pending or failed"
        : "Not configured";

  const tiles = [
    renderTile({
      title: "WebUI",
      value: toneBadge(data.webui ? "Online" : "Offline", data.webui ? "ok" : "off"),
      detail: data.webui ? `Port ${data.ports.webui}` : "Unreachable",
      tone: data.webui ? "ok" : "off",
    }),
    renderTile({
      title: "Gateway",
      value: toneBadge(data.gateway ? "Online" : "Offline", data.gateway ? "ok" : "off"),
      detail: data.gateway ? `API on port ${data.ports.gateway}` : "Unreachable",
      tone: data.gateway ? "ok" : "off",
      meta: data.authConfigured ? "Protected" : "Unprotected",
    }),
    renderTile({
      title: "Model",
      value: `<code>${valueOrUnset(data.model)}</code>`,
      detail: `Provider: ${valueOrUnset(data.provider || "auto")}`,
      tone: data.model ? "ok" : "warn",
    }),
    renderTile({
      title: "Runtime",
      value: escapeHtml(data.uptime),
      detail: `Port ${data.ports.public}`,
      tone: "neutral",
    }),
    renderTile({
      title: "Telegram",
      value: toneBadge(data.telegram.configured ? "Configured" : "Disabled", telegramTone),
      detail: telegramDetail,
      tone: telegramTone,
    }),
    renderTile({
      title: "Backup",
      value: toneBadge(syncStatus.toUpperCase(), syncTone),
      detail: backupDetail,
      tone: syncTone,
      meta: data.backup?.timestamp
        ? `<span class="local-time" data-iso="${data.backup.timestamp}"></span>`
        : "",
    }),
    renderTile({
      title: "Keep Awake",
      value: toneBadge(
        keepaliveConfigured ? "CF Cron" : keepaliveStatus.toUpperCase(),
        keepAliveTone,
      ),
      detail: keepAliveDetail,
      tone: keepAliveTone,
    }),
  ].join("");

  const modelLabel = data.model || "—";
  const providerLabel = data.provider || "auto";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HERMES // STATUS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme:dark; --bg:#0B0C0E; --panel:#13151A; --line:#23262D; --text:#E8E6E1; --muted:#6B6E78; --soft:#9AA0AB; --signal:#FF6A1A; --good:#7EE787; --warn:#F2B53C; --bad:#FF5C5C; --mono:'JetBrains Mono',ui-monospace,monospace; --sans:'Space Grotesk',ui-sans-serif,system-ui,sans-serif; }
    *{box-sizing:border-box;}
    body{margin:0;min-height:100vh;font-family:var(--sans);background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;}
    .telemetry{position:sticky;top:0;z-index:10;display:flex;gap:24px;align-items:center;padding:10px 20px;background:rgba(11,12,14,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;overflow-x:auto;white-space:nowrap;}
    .telemetry .seg{display:inline-flex;align-items:center;gap:8px;}
    .telemetry .k{color:var(--muted);}
    .telemetry .v{color:var(--text);}
    .telemetry .dot{width:6px;height:6px;border-radius:50%;background:var(--good);box-shadow:0 0 0 0 rgba(126,231,135,.6);animation:pulse 2s ease-out infinite;}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(126,231,135,.55);}70%{box-shadow:0 0 0 8px rgba(126,231,135,0);}100%{box-shadow:0 0 0 0 rgba(126,231,135,0);}}
    main{width:min(960px,calc(100% - 32px));margin:0 auto;padding:48px 0 64px;}
    header{margin-bottom:32px;}
    .eyebrow{font-family:var(--mono);font-size:11px;color:var(--signal);text-transform:uppercase;letter-spacing:.14em;margin-bottom:14px;}
    h1{margin:0;font-size:2.2rem;font-weight:600;letter-spacing:-0.02em;}
    h1 .accent{color:var(--signal);}
    .subtitle{margin-top:10px;color:var(--soft);font-family:var(--mono);font-size:12px;letter-spacing:.04em;max-width:560px;}
    .row{display:flex;gap:8px;margin:28px 0 32px;flex-wrap:wrap;}
    .hero-action{flex:1 1 220px;min-height:48px;display:flex;align-items:center;justify-content:center;gap:10px;border-radius:2px;background:var(--signal);color:#0B0C0E;text-decoration:none;font-family:var(--mono);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.1em;transition:transform 140ms cubic-bezier(0.22,1,0.36,1),background 140ms ease;}
    .hero-action:hover{transform:translateY(-1px);background:#FF7A30;}
    .hero-action.secondary{background:transparent;color:var(--text);border:1px solid var(--line);}
    .hero-action.secondary:hover{border-color:var(--signal);color:var(--signal);background:transparent;}
    .overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);}
    .tile{background:var(--panel);padding:20px;min-height:128px;display:flex;flex-direction:column;gap:10px;position:relative;}
    .tile-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}
    .tile-title{font-family:var(--mono);color:var(--muted);font-size:10px;letter-spacing:.16em;text-transform:uppercase;}
    .tile-dot{width:6px;height:6px;border-radius:50%;background:var(--line);}
    .tile.ok .tile-dot{background:var(--good);}
    .tile.warn .tile-dot{background:var(--warn);}
    .tile.off .tile-dot{background:var(--bad);}
    .tile-value{font-size:1.15rem;font-weight:500;overflow-wrap:anywhere;letter-spacing:-0.01em;}
    .tile-detail{color:var(--soft);font-family:var(--mono);font-size:11px;line-height:1.5;}
    .tile-meta{color:var(--muted);font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-top:auto;}
    code{background:#0B0C0E;border:1px solid var(--line);border-radius:2px;padding:2px 6px;color:var(--text);font-family:var(--mono);font-size:.85em;}
    .badge{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:2px;padding:4px 8px;font-family:var(--mono);font-size:10px;font-weight:500;line-height:1;text-transform:uppercase;letter-spacing:.1em;}
    .badge.ok{color:var(--good);border-color:rgba(126,231,135,.4);}
    .badge.warn{color:var(--warn);border-color:rgba(242,181,60,.4);}
    .badge.off{color:var(--bad);border-color:rgba(255,92,92,.4);}
    .badge.neutral{color:var(--soft);}
    .muted{color:var(--muted);}
    footer{margin-top:32px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;}
    footer a{color:var(--soft);text-decoration:none;}
    footer a:hover{color:var(--signal);}
    @media (max-width:700px){.overview{grid-template-columns:1fr;}h1{font-size:1.6rem;}}
  </style>
</head>
<body>
  <div class="telemetry">
    <span class="seg"><span class="dot"></span><span class="k">link</span><span class="v">online</span></span>
    <span class="seg"><span class="k">model</span><span class="v">${escapeHtml(modelLabel)}</span></span>
    <span class="seg"><span class="k">provider</span><span class="v">${escapeHtml(providerLabel)}</span></span>
    <span class="seg"><span class="k">uptime</span><span class="v">${escapeHtml(data.uptime)}</span></span>
    <span class="seg"><span class="k">port</span><span class="v">${data.ports.public}</span></span>
    <span class="seg"><span class="k">mode</span><span class="v" style="color:var(--signal)">bypass</span></span>
  </div>
  <main>
    <header>
      <div class="eyebrow">// HERMES.STATUS — REV.04</div>
      <h1>Hermes<span class="accent">/</span>HuggingMes router</h1>
      <div class="subtitle">Self-hosted agent gateway on HF Spaces. Token validation disabled — any session string mints a cookie. Telemetry refreshed on load.</div>
    </header>
    <div class="row">
      <a class="hero-action" href="/" target="_blank" rel="noopener">Launch WebUI →</a>
      <a class="hero-action secondary" href="${HM_PREFIX}/app/" target="_blank" rel="noopener">Open Dashboard</a>
    </div>
    <section class="overview">
      ${tiles}
    </section>
    <footer>
      <span>Built on <a href="https://github.com/somratpro/HuggingMes">HuggingMes</a> + <a href="https://github.com/nesquena/hermes-webui">hermes-webui</a></span>
      <span>SESSION ${Math.random().toString(16).slice(2,10).toUpperCase()}</span>
    </footer>
  </main>
  <script>
    document.querySelectorAll('.local-time').forEach(el => {
      const date = new Date(el.getAttribute('data-iso'));
      if (!isNaN(date)) el.textContent = 'At ' + date.toLocaleTimeString();
    });
  </script>
</body>
</html>`;
}

/* ── Server ───────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  // 1. /hm/login — HuggingMes admin login (cookie-based, gates /hm/*).
  //    hermes-webui handles its own /login at the catch-all below.
  if (path === LOGIN_PATH) {
    await handleLogin(req, res, parsed);
    return;
  }

  // 2. /health — unauthenticated; HF Spaces probes + Cloudflare keepalive.
  if (path === "/health") {
    const data = await statusPayload();
    res.writeHead(data.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: data.ok,
        gateway: data.gateway,
        webui: data.webui,
        uptime: data.uptime,
      }),
    );
    return;
  }

  // 3. /status — unauthenticated JSON status dump.
  if (path === "/status" || path === "/api/status") {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // 4. /telegram — webhook endpoint; no auth (Telegram can't do our cookie).
  if (path === "/telegram" || path.startsWith("/telegram/")) {
    proxyRequest(req, res, TELEGRAM_WEBHOOK_PORT);
    return;
  }

  // 5. /v1/* — Hermes gateway OpenAI-compatible API.
  if (path === "/v1" || path.startsWith("/v1/")) {
    if (!isAuthorized(req)) {
      if (wantsHtml(req)) {
        redirect(res, loginUrl(`${path}${parsed.search}`));
        return;
      }
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: "unauthorized",
          message: "Use Authorization: Bearer <GATEWAY_TOKEN>.",
        }),
      );
      return;
    }
    const upstreamHeaders =
      getBearerToken(req) || !API_SERVER_KEY
        ? {}
        : { authorization: `Bearer ${API_SERVER_KEY}` };
    proxyRequest(req, res, GATEWAY_PORT, (p) => p, upstreamHeaders);
    return;
  }

  // 6. /hm — HuggingMes status page.
  if (path === HM_PREFIX || path === `${HM_PREFIX}/`) {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(data));
    return;
  }

  // /hmd/* — Off-Space dashboard passthrough.
  //
  // Forwards verbatim to the internal Hermes dashboard on DASHBOARD_PORT,
  // including its /api/* endpoints, /assets/*, root HTML (which carries the
  // ephemeral session token), and WebSocket upgrades. Workspace clients
  // (e.g. hermes-workspace) point HERMES_DASHBOARD_URL at
  //   https://<space>/hmd
  // and the workspace's own scrape-the-token-from-root-HTML logic just
  // works because /hmd/ returns the unmodified dashboard index.
  //
  // SECURITY: this prefix has no router-level auth on purpose — the
  // dashboard's own session token gates writes. If you need an extra layer,
  // wrap your Space behind a Cloudflare Access policy or remove this
  // handler.
  if (path === HMD_PREFIX || path.startsWith(`${HMD_PREFIX}/`)) {
    proxyRequest(req, res, DASHBOARD_PORT, (p) => p.replace(HMD_PREFIX, "") || "/");
    return;
  }

  // /hm/app/* -> Hermes dashboard (SPA with HTML rewriting for base path)
  if (path === `${HM_PREFIX}/app` || path.startsWith(`${HM_PREFIX}/app/`)) {
    if (!requireAuth(req, res)) return;
    proxyDashboard(req, res);
    return;
  }

  // /hm/status -> JSON
  if (path === `${HM_PREFIX}/status`) {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  // Legacy /dashboard -> /hm
  if (path === "/dashboard" || path === "/dashboard/") {
    redirect(res, `${HM_PREFIX}${parsed.search}`);
    return;
  }

  // Root-path dashboard routes (config, env, providers, etc.) that users
  // type or bookmark without the /hm/app prefix. Redirect them there.
  const dashboardRootRoutes = new Set([
    "/config",
    "/env",
    "/models",
    "/providers",
    "/profiles",
    "/sessions",
    "/skills",
    "/cron",
    "/analytics",
    "/logs",
    "/plugins",
    "/chat",
    "/docs",
  ]);
  if (dashboardRootRoutes.has(path) || [...dashboardRootRoutes].some((r) => path.startsWith(r + "/"))) {
    redirect(res, `${HM_PREFIX}/app${path}${parsed.search}`);
    return;
  }

  // 6b. Root-path requests whose Referer came from /hm/app/* must go to
  //     the dashboard, not WebUI. This covers:
  //       - Absolute assets    (/assets/*, /ds-assets/*, /dashboard-plugins/*)
  //       - API calls          (/api/*) when dashboard code uses absolute paths
  //       - Favicon            (/favicon.ico)
  //       - WebSocket upgrades from dashboard pages
  //       - File downloads     (any extensioned path referenced by dashboard)
  //     Both the Hermes dashboard AND hermes-webui use /api/* internally,
  //     so the Referer is the only reliable way to disambiguate.
  const refererPath = (() => {
    const ref = String(req.headers.referer || "");
    if (!ref) return "";
    try {
      return new URL(ref).pathname;
    } catch {
      return "";
    }
  })();
  const refererIsDashboard = refererPath.startsWith(`${HM_PREFIX}/app`);

  if (refererIsDashboard) {
    // Anything with a Referer from the dashboard goes to the dashboard,
    // *except* requests that explicitly start with /webui (escape hatch).
    if (!path.startsWith("/webui")) {
      if (!requireAuth(req, res)) return;
      // Assets must NOT get the SPA fallback; pass them through as-is.
      const parsed2 = new URL(req.url, "http://localhost");
      const looksLikeAsset =
        path.startsWith("/assets/") ||
        path.startsWith("/ds-assets/") ||
        path.startsWith("/dashboard-plugins/") ||
        path.startsWith("/api/") ||
        path === "/favicon.ico" ||
        /\.[a-z0-9]{1,6}$/i.test(path);
      if (looksLikeAsset) {
        proxyRequest(req, res, DASHBOARD_PORT);
      } else {
        // Unlikely: a dashboard-referrer request for a non-asset, non-/hm
        // path. Treat as a dashboard sub-route.
        proxyDashboard(req, res);
      }
      return;
    }
  }

  // 6c. /api/* routes — these are WebUI API calls when Referer isn't the
  //     dashboard. Fall through to the catch-all below.
  //
  // Exception: hermes-workspace probes for the *legacy* enhanced-fork chat
  // endpoint at POST /api/sessions/<id>/chat/stream. Without this rule the
  // request falls through to WebUI's catch-all, which doesn't 404 it
  // cleanly, so the workspace's detector sets `enhancedChat=true`, sends
  // chat there at runtime, and the UI surfaces a generic "Authentication
  // error". Returning an explicit 404 here makes the workspace fall back
  // to the OpenAI-compatible /v1/chat/completions path on the gateway —
  // which is the only chat surface this Space actually exposes.
  //
  // Anything the dashboard or WebUI legitimately need under /api/sessions/
  // already has a more specific match above (referer check / /hmd
  // passthrough), so this only fires for cross-origin probes.
  if (
    /^\/api\/sessions\/[^/]+\/chat\/stream\/?$/.test(path) &&
    !refererIsDashboard
  ) {
    res.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: "not_found",
        message:
          "Legacy enhanced-fork chat stream is not exposed by this Space. Use /v1/chat/completions.",
      }),
    );
    return;
  }

  // 7. Anything else -> Hermes WebUI (primary UI) OR HuggingMes status page.
  //    WebUI handles its own auth internally via HERMES_WEBUI_PASSWORD.
  if (PRIMARY_UI === "dashboard" && path === "/") {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(data));
    return;
  }

  // Catch-all -> WebUI. Don't gate at the router level: WebUI has its own
  // password login. GATEWAY_TOKEN *is* the WebUI password (start.sh sets
  // HERMES_WEBUI_PASSWORD=$GATEWAY_TOKEN).
  proxyRequest(req, res, WEBUI_PORT);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HuggingMes + Hermes WebUI router listening on 0.0.0.0:${PORT}`);
});

/* ── WebSocket upgrade handling ─────────────────────────────────────
 *
 * Both the Hermes dashboard and hermes-webui can open WebSocket
 * connections for live updates. Route the upgrade to the correct
 * upstream based on path prefix + referer, same as HTTP requests.
 */
server.on("upgrade", (req, clientSocket, head) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  let targetPort = WEBUI_PORT;
  let targetPath = req.url;

  const refererPath = (() => {
    const ref = String(req.headers.referer || "");
    if (!ref) return "";
    try {
      return new URL(ref).pathname;
    } catch {
      return "";
    }
  })();
  const refererIsDashboard = refererPath.startsWith(`${HM_PREFIX}/app`);

  if (path === "/v1" || path.startsWith("/v1/")) {
    targetPort = GATEWAY_PORT;
  } else if (path === HMD_PREFIX || path.startsWith(`${HMD_PREFIX}/`)) {
    // Off-Space dashboard passthrough (mirrors the HTTP /hmd handler).
    targetPort = DASHBOARD_PORT;
    targetPath = path.replace(HMD_PREFIX, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  } else if (path === `${HM_PREFIX}/app` || path.startsWith(`${HM_PREFIX}/app/`)) {
    targetPort = DASHBOARD_PORT;
    targetPath = path.replace(`${HM_PREFIX}/app`, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  } else if (refererIsDashboard && !path.startsWith("/webui")) {
    targetPort = DASHBOARD_PORT;
  } else if (path.startsWith("/webui/") || path === "/webui") {
    targetPort = WEBUI_PORT;
    targetPath = path.replace(/^\/webui/, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  }

  const upstream = net.createConnection(targetPort, GATEWAY_HOST, () => {
    // Forward the HTTP upgrade handshake verbatim
    const headerLines = [
      `${req.method} ${targetPath} HTTP/1.1`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headerLines.push(`${name}: ${v}`);
      } else {
        headerLines.push(`${name}: ${value}`);
      }
    }
    headerLines.push("", "");
    upstream.write(headerLines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => {
    try {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    } catch {}
  });
  clientSocket.on("error", () => {
    try {
      upstream.destroy();
    } catch {}
  });
});
