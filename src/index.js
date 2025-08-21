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
  organization: process.env.OPENAI_ORG_ID || undefined, // facultatif
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
// Garde les connexions HTTP/HTTPS ouvertes → latence ↓
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

// ======== APP ========
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
// POST texte brut toléré
app.use(express.text({ type: "text/*", limit: "1mb" }));

// Ne PAS compresser le SSE, sinon certaines stacks reset la connexion
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
  if (Date.now() > exp) {
    _cache.delete(k);
    return null;
  }
  return value;
}
function cacheSet(k, v, ttlMs = 10 * 60 * 1000) {
  _cache.set(k, { value: v, exp: Date.now() + ttlMs });
}
function norm(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ======== UTILS SSE ========
function sseWrite(res, payload) {
  res.write(`data:${JSON.stringify(payload)}\n\n`);
}
function sseHeartbeat(res) {
  res.write(`:hb ${Date.now()}\n\n`);
} // commentaire SSE

// ======== HEALTHCHECK ========
app.get("/healthz", async (_req, res) => {
  const payload = { status: "ok", uptime: process.uptime(), port: PORT };
  if (!pool) return res.status(200).json({ ...payload, db: "configured", db_ok: false });
  try {
    await pool.query("select 1");
    return res.status(200).json({ ...payload, db: "configured", db_ok: true });
  } catch {
    return res.status(200).json({ ...payload, db: "configured", db_ok: false });
  }
});

// ======== STATIC ========
app.use(express.static(path.join(__dirname, "public")));

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

// ======== HELPERS PARSING MESSAGES (tolérant) ========
function parseMessages(req) {
  // 1) JSON { messages: [...] }
  if (req.is("application/json") && Array.isArray(req.body?.messages)) {
    return req.body.messages;
  }
  // 2) GET ?q=...
  const q = (req.query?.q ?? "").toString().trim();
  if (q) {
    return [
      { role: "system", content: "Tu es un mécano expérimenté. Réponds en français, clair et direct." },
      { role: "user", content: q },
    ];
  }
  // 3) POST texte brut
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
  res.setHeader("X-Accel-Buffering", "no");
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
// POST (JSON ou texte) + GET (?q=...) → même logique.
app.post("/api/diagnose/stream", handleDiagnoseStream);
app.get("/api/diagnose/stream", handleDiagnoseStream);

async function handleDiagnoseStream(req, res) {
  // Headers SSE
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Heartbeat pour garder la connexion ouverte (Render/Proxies)
  const hb = setInterval(() => sseHeartbeat(res), 15_000);
  req.on("close", () => clearInterval(hb));

  try {
    const messages = parseMessages(req);
    if (!messages.length) {
      sseWrite(res, { error: "MISSING_MESSAGES" });
      clearInterval(hb);
      return res.end();
    }

    // --- Cache: clé = messages normalisés ---
    const cacheKey = norm(JSON.stringify(messages));
    const cacheTtl = Number(process.env.STREAM_CACHE_TTL_MS || 10 * 60 * 1000);

    // Hit cache → rejouer immédiatement (UX rapide)
    const cached = cacheGet(cacheKey);
    if (cached) {
      replayTextAsSSE(cached, res);
      clearInterval(hb);
      return res.end();
    }

    // --- Timeout dur sur l’appel modèle ---
    const timeoutMs = Number(process.env.STREAM_TIMEOUT_MS || 20_000);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort("TIMEOUT"), timeoutMs);

    // ========= Tentative 1 : STREAM côté OpenAI =========
    let fullText = "";
    try {
      const stream = await openai.chat.completions.create(
        {
          model: OPENAI_MODEL,
          stream: true,
          // ⚠️ ne pas envoyer "temperature" (certains modèles n'acceptent que la valeur par défaut)
          messages,
        },
        { signal: ac.signal }
      );

      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content || "";
        if (delta) {
          fullText += delta;
          sseWrite(res, { delta });
        }
      }
    } catch (err) {
      // Si on a une erreur de vérification org / 4xx → fallback non-stream
      const msg = (err && err.message) ? String(err.message) : String(err);
      const isOrgVerify =
        /must be verified to stream this model/i.test(msg) ||
        /organization.*verified/i.test(msg);
      const is4xx = /status\s*code\s*4\d\d/i.test(msg) || /400|401|403|404/.test(msg);

      if (isOrgVerify || is4xx) {
        // ========= Fallback : NON-STREAM côté OpenAI, re-stream côté serveur =========
        const resp = await openai.chat.completions.create(
          {
            model: OPENAI_MODEL,
            messages,
            // pas de temperature
          },
          { signal: ac.signal }
        );
        fullText = resp.choices?.[0]?.message?.content?.trim() || "";
        replayTextAsSSE(fullText, res);
      } else {
        throw err; // autres erreurs → gestion générique
      }
    } finally {
      clearTimeout(to);
    }

    // Cache
    if (fullText && fullText.trim()) {
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
}

// Découpe un texte et le renvoie en plusieurs events SSE
function replayTextAsSSE(text, res) {
  if (!text) return;
  const CHUNK = 400; // taille raisonnable
  for (let i = 0; i < text.length; i += CHUNK) {
    sseWrite(res, { delta: text.slice(i, i + CHUNK) });
  }
}

// ======== ROOT ========
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Re-FAP Bot</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.5; padding: 28px; }
    h1 { font-size: 2.2rem; margin-bottom: 0.2rem; }
    a { color: #2b6cb0; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { margin-top: 0.6rem; }
  </style>
</head>
<body>
  <h1>Re-FAP Bot</h1>
  <p>Service OK. Outils utiles :</p>
  <ul>
    <li><a href="/healthz">/healthz</a></li>
    <li><a href="/stream.html">/stream.html</a> (page de test, si présente)</li>
  </ul>
</body>
</html>`);
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

  app.listen(PORT, () => {
    console.log(`🚀 Server up on :${PORT}`);
  });
})();
