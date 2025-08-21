// src/index.js
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

// ---------- BOOT ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log(`[BOOT] file=${__filename}`);
console.log(`[BOOT] cwd=${process.cwd()}`);

const PORT = Number(process.env.PORT || 3000);

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
});
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------- DB (facultatif) ----------
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

// ---------- perf réseau ----------
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

// ---------- APP ----------
const app = express();
app.use(cors());

// ne compresse pas le SSE
app.use(
  compression({
    filter: (req, res) => {
      const a = req.headers["accept"] || "";
      const c = req.headers["content-type"] || "";
      if (a.includes("text/event-stream") || c.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  })
);

// JSON tolérant
function safeJson(limit = "1mb") {
  const parser = express.json({ limit, strict: false, type: ["application/json", "application/*+json"] });
  return (req, res, next) => {
    parser(req, res, (err) => {
      if (err) {
        req._json_error = String(err.message || err);
        req.body = undefined;
      }
      next();
    });
  };
}
app.use(safeJson());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: "text/*", limit: "1mb" }));

// ---------- mini-cache ----------
const _cache = new Map();
const cacheGet = (k) => {
  const h = _cache.get(k);
  if (!h) return null;
  if (Date.now() > h.exp) { _cache.delete(k); return null; }
  return h.value;
};
const cacheSet = (k, v, ttlMs = 10 * 60 * 1000) => _cache.set(k, { value: v, exp: Date.now() + ttlMs });
const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

// ---------- utils SSE ----------
const sseWrite = (res, payload) => res.write(`data:${JSON.stringify(payload)}\n\n`);
const sseHeartbeat = (res) => res.write(`:hb ${Date.now()}\n\n`);

// ---------- health ----------
app.get("/healthz", async (_req, res) => {
  const base = { status: "ok", uptime: process.uptime(), port: PORT, db: pool ? "configuré" : "non_configuré" };
  if (!pool) return res.json({ ...base, db_ok: false });
  try { await pool.query("select 1"); res.json({ ...base, db_ok: true }); }
  catch { res.json({ ...base, db_ok: false }); }
});

// ---------- statiques + landing ----------
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

// ---------- admin stubs ----------
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
      order by table_schema, table_name;`;
    const { rows } = await pool.query(q);
    res.json({ tables: rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- helpers prompt/messages ----------
function parsePrompt(req) {
  if (req?.body && typeof req.body === "object" && req.body.prompt) return String(req.body.prompt);
  if (typeof req.body === "string" && req.body.trim()) return req.body.trim();
  if (req.query?.prompt) return String(req.query.prompt);
  return "";
}
function parseMessages(req) {
  const q = (req.query?.q ?? "").toString().trim();
  if (req.is("application/json") && Array.isArray(req.body?.messages)) return req.body.messages;
  if (q) return [
    { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
    { role: "user", content: q },
  ];
  if (typeof req.body === "string" && req.body.trim()) return [
    { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
    { role: "user", content: req.body.trim() },
  ];
  return [];
}

// ---------- ADMIN DIAGNOSE (non-stream) ----------
const adminDiagnose = async (req, res) => {
  const prompt = parsePrompt(req);
  if (!prompt) return res.status(400).json({ error: "MISSING_PROMPT", note: 'Envoyez {"prompt":"..."} ou ?prompt=...' });
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
};
app.all(["/api/admin/rag/diagnose", "/api/admin/diagnose"], adminDiagnose);

// ---------- DIAGNOSE (non-stream, pour le front) ----------
app.all("/api/diagnose", async (req, res) => {
  const prompt = parsePrompt(req);
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

// ---------- DEBUG SSE ----------
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

// ---------- DIAGNOSE SSE ----------
async function handleDiagnoseStream(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const hb = setInterval(() => sseHeartbeat(res), 15_000);
  req.on("close", () => clearInterval(hb));

  try {
    const messages = parseMessages(req);
    if (!messages.length) { sseWrite(res, { error: "MISSING_MESSAGES" }); clearInterval(hb); return res.end(); }

    const cacheKey = norm(JSON.stringify(messages));
    const cached = cacheGet(cacheKey);
    const cacheTtl = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);
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

// ---------- START ----------
(async () => {
  if (pool) {
    try {
      const { rows } = await pool.query("select current_database() as db, current_user as user");
      const db = rows?.[0]?.db || "postgres";
      const usr = rows?.[0]?.user || "unknown";
      const host = (() => {
        try { const u = new URL(DATABASE_URL); return `${u.hostname}:${u.port || 5432}`; }
        catch { return "db"; }
      })();
      console.log(`✅ PostgreSQL OK | DB: ${db} | host: ${host} | user: ${usr}`);
    } catch (e) {
      console.warn("⚠️  PostgreSQL init warning:", e.message || e);
    }
  }
  app.listen(PORT, () => console.log(`🚀 Server up on :${PORT}`));
})();
