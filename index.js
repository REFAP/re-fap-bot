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

// ======== PERF RESEAU ========
// Garde les connexions HTTP/HTTPS ouvertes → latence ↓
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

// ======== APP ========
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(compression());

// ======== MINI-CACHE TTL (mémoire) ========
const _cache = new Map();
function cacheGet(k) {
  const h = _cache.get(k);
  if (!h) return null;
  const { value, exp } = h;
  if (Date.now() > exp) { _cache.delete(k); return null; }
  return value;
}
function cacheSet(k, v, ttlMs = 10 * 60 * 1000) { // 10 min
  _cache.set(k, { value: v, exp: Date.now() + ttlMs });
}
function norm(s) { return (s || "").trim().toLowerCase().replace(/\s+/g, " "); }

// ======== UTILS SSE ========
function sseWrite(res, payload) { res.write(`data:${JSON.stringify(payload)}\n\n`); }
function sseHeartbeat(res) { res.write(`:hb ${Date.now()}\n\n`); } // commentaire SSE

// ======== HEALTHCHECK ========
app.get("/healthz", async (_req, res) => {
  const payload = { status: "ok", uptime: process.uptime(), port: PORT };
  if (!pool) return res.status(200).json(payload);
  try {
    await pool.query("select 1");
    return res.status(200).json(payload);
  } catch {
    return res.status(503).json({ status: "db_error" });
  }
});

// ======== STATIC (optionnel) ========
// Servez votre front si présent (public/index.html)
// app.use(express.static(path.join(__dirname, "public")));

// ======== ADMIN (stubs utiles) ========
app.get("/api/admin/guess", (_req, res) => {
  res.json({
    ok: true,
    model: OPENAI_MODEL,
    db: Boolean(pool),
    time: new Date().toISOString(),
  });
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

app.post("/api/admin/rag/diagnose", async (req, res) => {
  // Point d’entrée “diagnose” non stream (debug RAG)
  const { prompt = "Diagnostic rapide FAP : résume les étapes de contrôle.", temperature = 0.2 } = req.body || {};
  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature,
      messages: [
        { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
        { role: "user", content: prompt },
      ],
    });
    const text = chat.choices?.[0]?.message?.content?.trim() || "";
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ======== STREAMING DIAGNOSE (SSE) ========
app.post("/api/diagnose/stream", async (req, res) => {
  // Headers SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Heartbeat pour garder la connexion ouverte (Render/Proxies)
  const hb = setInterval(() => sseHeartbeat(res), 15_000);
  req.on("close", () => clearInterval(hb));

  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];

    // --- Cache: clé = messages normalisés ---
    const cacheKey = norm(JSON.stringify(messages));
    const cacheTtl = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);

    // Hit cache → rejouer immédiatement (UX rapide)
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (cached.length <= 400) {
        sseWrite(res, { delta: cached });
      } else {
        const mid = Math.floor(cached.length / 2);
        sseWrite(res, { delta: cached.slice(0, mid) });
        sseWrite(res, { delta: cached.slice(mid) });
      }
      sseWrite(res, { done: true });
      clearInterval(hb);
      return res.end();
    }

    // --- Timeout dur sur l’appel modèle ---
    const timeoutMs = Number(process.env.STREAM_TIMEOUT_MS || 15_000);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort("TIMEOUT"), timeoutMs);

    // Appel OpenAI en stream
    const stream = await openai.chat.completions.create(
      {
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.2,
        messages,
      },
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

    if (fullText && fullText.trim().length > 0) {
      cacheSet(cacheKey, fullText, cacheTtl);
    }

    sseWrite(res, { done: true });
    clearInterval(hb);
    return res.end();
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    sseWrite(res, { error: msg });
    clearInterval(hb);
    return res.end();
  }
});

// ======== ROOT ========
app.get("/", (_req, res) => {
  res.type("text").send("Re-FAP Bot up. Try /healthz");
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
        } catch { return "db"; }
      })();
      console.log(`✅ PostgreSQL OK | DB: ${db} | host: ${host} | user: ${usr}`);
    } catch (e) {
      console.warn("⚠️  PostgreSQL init warning:", e.message || e);
    }
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server up on :${PORT}`);
  });
})();
