// index.js
// ======== BOOT ========
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

import express from "express";
import compression from "compression";
import cors from "cors";
import OpenAI from "openai";
import { Pool } from "pg";

// --- Boot logs courts (pas de secrets) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log(`[BOOT] file=${__filename}`);
console.log(`[BOOT] cwd=${process.cwd()}`);

// ======== CONFIG / ENV ========
const PORT = Number(process.env.PORT || 3000);

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
});
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// DB
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
if (!DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL manquant. Les routes DB avanceront en mode dégradé.");
} else {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    ssl: DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
}

// ======== PERF RÉSEAU ========
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

// ======== APP ========
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/*", limit: "1mb" }));

// Ne pas compresser le SSE
app.use(
  compression({
    filter: (req, res) => {
      const accept = req.headers["accept"] || "";
      const ctype = req.headers["content-type"] || "";
      if (accept.includes("text/event-stream") || ctype.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  })
);

// ======== MINI-CACHE TTL (mémoire) ========
const _cache = new Map();
const cacheGet = (k) => {
  const h = _cache.get(k);
  if (!h) return null;
  const { value, exp } = h;
  if (Date.now() > exp) {
    _cache.delete(k);
    return null;
  }
  return value;
};
const cacheSet = (k, v, ttlMs = 10 * 60 * 1000) => _cache.set(k, { value: v, exp: Date.now() + ttlMs });
const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// ======== UTILS SSE ========
const sseWrite = (res, payload) => res.write(`data:${JSON.stringify(payload)}\n\n`);
const sseHeartbeat = (res) => res.write(`:hb ${Date.now()}\n\n`);

// ======== HEALTHCHECK ========
app.get("/healthz", async (_req, res) => {
  const payload = { status: "ok", uptime: process.uptime(), port: PORT };
  if (!pool) return res.status(200).json({ ...payload, db: "not_configured", db_ok: false });
  try {
    await pool.query("select 1");
    return res.status(200).json({ ...payload, db: "configured", db_ok: true });
  } catch {
    return res.status(200).json({ ...payload, db: "configured", db_ok: false });
  }
});

// ======== STATIC ========
app.use(express.static(path.join(__dirname, "public")));

// ======== ADMIN (stubs) ========
app.get("/api/admin/guess", (_req, res) => {
  res.json({ ok: true, model: OPENAI_MODEL, db: Boolean(pool), time: new Date().toISOString() });
});

// ======== HELPERS PARSING ========
function parseMessages(req) {
  if (req.is("application/json") && Array.isArray(req.body?.messages)) return req.body.messages;
  const q = (req.query?.q ?? "").toString().trim();
  if (q) {
    return [
      { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
      { role: "user", content: q },
    ];
  }
  if (typeof req.body === "string" && req.body.trim()) {
    return [
      { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
      { role: "user", content: req.body.trim() },
    ];
  }
  return [];
}

// ======== DEBUG: STREAM SANS OPENAI ========
app.get("/debug/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let i = 0;
  const iv = setInterval(() => {
    i += 1;
    sseWrite(res, { delta: `tick-${i}` });
    if (i >= 5) {
      sseWrite(res, { done: true });
      clearInterval(iv);
      res.end();
    }
  }, 400);

  req.on("close", () => clearInterval(iv));
});

// ======== STREAMING DIAGNOSE (SSE) ========
async function handleDiagnoseStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const hb = setInterval(() => sseHeartbeat(res), 15_000);
  req.on("close", () => clearInterval(hb));

  try {
    const messages = parseMessages(req);
    if (!messages.length) {
      sseWrite(res, { error: "MISSING_MESSAGES" });
      clearInterval(hb);
      return res.end();
    }

    const cacheKey = norm(JSON.stringify(messages));
    const cacheTtl = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (cached.length <= 400) sseWrite(res, { delta: cached });
      else {
        const mid = Math.floor(cached.length / 2);
        sseWrite(res, { delta: cached.slice(0, mid) });
        sseWrite(res, { delta: cached.slice(mid) });
      }
      sseWrite(res, { done: true });
      clearInterval(hb);
      return res.end();
    }

    // Timeout dur
    const timeoutMs = Number(process.env.STREAM_TIMEOUT_MS || 15_000);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort("TIMEOUT"), timeoutMs);

    // 👉 Pas de "temperature" envoyé (certains modèles n’acceptent que la valeur par défaut)
    const stream = await openai.chat.completions.create(
      { model: OPENAI_MODEL, stream: true, messages },
      { signal: ac.signal }
    );

    let fullText = "";
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) {
        fullText += delta;
        sseWrite(res, { delta });
      }
    }

    clearTimeout(to);
    if (fullText && fullText.trim()) cacheSet(cacheKey, fullText, cacheTtl);

    sseWrite(res, { done: true });
    clearInterval(hb);
    res.end();
  } catch (e) {
    sseWrite(res, { error: String(e?.message || e) });
    clearInterval(hb);
    res.end();
  }
}
app.post("/api/diagnose/stream", handleDiagnoseStream);
app.get("/api/diagnose/stream", handleDiagnoseStream);

// ======== ROOT (landing page) ========
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr"><meta charset="utf-8"/>
<title>Re-FAP bot</title>
<body style="font-family:system-ui;margin:2rem;line-height:1.5">
  <h1>Re-FAP Bot</h1>
  <p>Service OK. Outils utiles :</p>
  <ul>
    <li><a href="/healthz">/healthz</a></li>
    <li><a href="/stream.html">/stream.html</a> (page de test, si présente)</li>
  </ul>
</body></html>`);
});

// ======== START ========
(async () => {
  if (pool) {
    try {
      const { rows } = await pool.query("select current_database() as db, current_user as user");
      const db = rows?.[0]?.db || "postgres";
      const usr = rows?.[0]?.user || "unknown";
      const host = (() => {
        try {
          const u = new URL(DATABASE_URL);
          return `${u.hostname}:${u.port || 5432}`;
        } catch {
          return "db";
        }
      })();
      console.log(`✅ PostgreSQL OK | DB: ${db} | host: ${host} | user: ${usr}`);
    } catch (e) {
      console.warn("⚠️  PostgreSQL init warning:", e.message || e);
    }
  }
  app.listen(PORT, () => console.log(`🚀 Server up on :${PORT}`));
})();
