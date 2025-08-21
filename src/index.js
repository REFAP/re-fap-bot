// src/index.js
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

// ======== CONFIG ========
const PORT = Number(process.env.PORT || 3000);

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
});
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// DB (facultatif)
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

// ⚠️ Pas de json() global → on prend tout en texte brut et on parse nous-mêmes.
//   Ça élimine les “Bad Request” d’Express si le JSON n’est pas exactement comme il aime.
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Ne PAS compresser le SSE
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
function cacheGet(k) {
  const h = _cache.get(k);
  if (!h) return null;
  const { value, exp } = h;
  if (Date.now() > exp) { _cache.delete(k); return null; }
  return value;
}
function cacheSet(k, v, ttlMs = 10 * 60 * 1000) { _cache.set(k, { value: v, exp: Date.now() + ttlMs }); }
function norm(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }

// ======== UTILS ========
function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function pickPrompt(req) {
  // 1) GET ?prompt
  if (req.query?.prompt) return String(req.query.prompt);

  // 2) POST/TEXT: JSON ou texte brut
  if (typeof req.body === "string" && req.body.length) {
    const maybe = tryParseJSON(req.body);
    if (maybe && typeof maybe === "object" && typeof maybe.prompt === "string") return maybe.prompt;
    // sinon on prend le texte brut directement
    return req.body;
  }

  // 3) application/x-www-form-urlencoded
  if (req.body && typeof req.body === "object" && req.body.prompt) return String(req.body.prompt);

  return "";
}

function pickMessages(req) {
  // Accepte:
  //  - GET ?q=...
  //  - POST body texte brut: {"messages":[...]} ou juste le texte
  //  - POST form urlencoded (rare)
  const q = (req.query?.q ?? "").toString().trim();
  if (q) {
    return [
      { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
      { role: "user", content: q },
    ];
  }

  if (typeof req.body === "string" && req.body.length) {
    const maybe = tryParseJSON(req.body);
    if (maybe && Array.isArray(maybe.messages)) return maybe.messages;
    // si c'est juste du texte on en fait un prompt
    return [
      { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
      { role: "user", content: req.body.trim() },
    ];
  }

  if (req.body && Array.isArray(req.body.messages)) return req.body.messages;

  return [];
}

function sseWrite(res, payload) { res.write(`data:${JSON.stringify(payload)}\n\n`); }
function sseHeartbeat(res) { res.write(`:hb ${Date.now()}\n\n`); }

// ======== HEALTH ========
app.get("/healthz", async (_req, res) => {
  const base = { status: "ok", uptime: process.uptime(), port: PORT, db: pool ? "configuré" : "non_configuré" };
  if (!pool) return res.json({ ...base, db_ok: false });
  try { await pool.query("select 1"); res.json({ ...base, db_ok: true }); }
  catch { res.json({ ...base, db_ok: false }); }
});

// ======== STATIC + LANDING ========
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8">
<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:32px}a{color:#06c}</style>
<h1>Re-FAP Bot</h1>
<p>Service OK. Outils utiles :</p>
<ul>
  <li><a href="/healthz">/healthz</a></li>
  <li><a href="/stream.html">/stream.html</a></li>
  <li><a href="/chat.html">/chat.html</a></li>
</ul>`);
});

// ======== ADMIN (stubs utiles) ========
app.get("/api/admin/guess", (_req, res) => {
  res.json({ ok: true, model: OPENAI_MODEL, db: Boolean(pool), time: new Date().toISOString() });
});

app.get("/api/admin/schema", async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "DB not configured" });
  try {
    const q = `
      select table_schema, table_name
      from information_schema.tables
      where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')
      order by table_schema, table_name;
    `;
    const { rows } = await pool.query(q);
    res.json({ tables: rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ======== DIAGNOSE (non-stream, robuste) ========
app.all("/api/diagnose", async (req, res) => {
  const prompt = pickPrompt(req);
  if (!prompt) return res.status(400).json({ error: "MISSING_PROMPT", hint: 'POST texte brut {"prompt":"..."} ou GET ?prompt=...' });

  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
        { role: "user", content: prompt },
      ],
    });
    const text = chat.choices?.[0]?.message?.content?.trim() || "";
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e?.message ? String(e.message) : String(e) });
  }
});

// ======== ADMIN DIAGNOSE (alias non-stream) ========
app.all(["/api/admin/rag/diagnose", "/api/admin/diagnose"], async (req, res) => {
  const prompt = pickPrompt(req);
  if (!prompt) return res.status(400).json({ error: "MISSING_PROMPT" });

  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
        { role: "user", content: prompt },
      ],
    });
    const text = chat.choices?.[0]?.message?.content?.trim() || "";
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e?.message ? String(e.message) : String(e) });
  }
});

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
    if (i >= 5) { sseWrite(res, { done: true }); clearInterval(iv); res.end(); }
  }, 400);

  req.on("close", () => clearInterval(iv));
});

// ======== DIAGNOSE (SSE) ========
async function handleDiagnoseStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const hb = setInterval(() => sseHeartbeat(res), 15_000);
  req.on("close", () => clearInterval(hb));

  try {
    const messages = pickMessages(req);
    if (!messages.length) { sseWrite(res, { error: "MISSING_MESSAGES" }); clearInterval(hb); return res.end(); }

    const cacheKey = norm(JSON.stringify(messages));
    const cacheTtl = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);

    const cached = cacheGet(cacheKey);
    if (cached) {
      if (cached.length <= 400) sseWrite(res, { delta: cached });
      else { const mid = Math.floor(cached.length / 2); sseWrite(res, { delta: cached.slice(0, mid) }); sseWrite(res, { delta: cached.slice(mid) }); }
      sseWrite(res, { done: true }); clearInterval(hb); return res.end();
    }

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort("TIMEOUT"), Number(process.env.STREAM_TIMEOUT_MS || 15_000));

    const stream = await openai.chat.completions.create(
      { model: OPENAI_MODEL, stream: true, messages },
      { signal: ac.signal }
    );

    let fullText = "";
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || "";
      if (delta) { fullText += delta; sseWrite(res, { delta }); }
    }

    clearTimeout(to);
    if (fullText.trim()) cacheSet(cacheKey, fullText, cacheTtl);

    sseWrite(res, { done: true });
    clearInterval(hb);
    res.end();
  } catch (e) {
    sseWrite(res, { error: e?.message ? String(e.message) : String(e) });
    clearInterval(hb);
    res.end();
  }
}
app.post("/api/diagnose/stream", handleDiagnoseStream);
app.get("/api/diagnose/stream", handleDiagnoseStream);

// ======== START ========
(async () => {
  if (pool) {
    try {
      const { rows } = await pool.query("select current_database() as db, current_user as user");
      const db = rows?.[0]?.db || "postgres";
      const usr = rows?.[0]?.user || "unknown";
      const host = (() => { try { const u = new URL(DATABASE_URL); return `${u.hostname}:${u.port || 5432}`; } catch { return "db"; } })();
      console.log(`✅ PostgreSQL OK | DB: ${db} | host: ${host} | user: ${usr}`);
    } catch (e) {
      console.warn("⚠️  PostgreSQL init warning:", e.message || e);
    }
  }

  app.listen(PORT, () => { console.log(`🚀 Server up on :${PORT}`); });
})();
