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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------- OpenAI ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
});

// ---------- PostgreSQL (optionnel) ----------
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
if (!DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL manquant : les endpoints /api/leads/* répondent 503.");
} else {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
    ssl: DATABASE_URL.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  // Création table minimale si absente
  (async () => {
    try {
      await pool.query(`
        create table if not exists leads (
          id bigserial primary key,
          created_at timestamptz default now(),
          session_id text,
          brand text,
          model text,
          engine text,
          year text,
          dtc text,
          notes text,
          postal_code text,
          source text,
          contact_name text,
          contact_phone text,
          contact_email text
        );
        create index if not exists leads_created_at_idx on leads(created_at);
      `);
      console.log("✅ DB prête (table leads).");
    } catch (e) {
      console.warn("⚠️  DB init error:", e?.message || e);
    }
  })();
}

// ---------- Helpers payload ----------
function extractPayloadFromText(txt) {
  const m = String(txt || "").match(/<PAYLOAD>([\s\S]*?)<\/PAYLOAD>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function stripPayloadBlock(txt) {
  return String(txt || "").replace(/<PAYLOAD>[\s\S]*?<\/PAYLOAD>/g, "").trim();
}

// ---------- Perf réseau ----------
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.text({ type: "*/*", limit: "1mb" }));    // parsing tolérant
app.use(express.urlencoded({ extended: true }));
app.use(compression({
  filter: (req, res) => {
    const accept = req.headers["accept"] || "";
    const ctype = req.headers["content-type"] || "";
    if (accept.includes("text/event-stream") || ctype.includes("text/event-stream")) return false;
    return compression.filter(req, res);
  },
}));

// ---------- Utils ----------
function tryParseJSON(str){ try { return JSON.parse(str); } catch { return null; } }
function pickPrompt(req){
  if (req.query?.prompt) return String(req.query.prompt);
  if (req.query?.q) return String(req.query.q);
  if (typeof req.body === "string" && req.body.length){
    const maybe = tryParseJSON(req.body);
    if (maybe?.prompt) return String(maybe.prompt);
    return req.body;
  }
  if (req.body?.prompt) return String(req.body.prompt);
  return "";
}
function sseWrite(res, payload){ res.write(`data:${JSON.stringify(payload)}\n\n`); }
function sseHeartbeat(res){ res.write(`:hb ${Date.now()}\n\n`); }

// ---------- Mode “détails” ----------
const DETAIL_KEYWORDS = ["détails","détaillé","detail","complet","approfondi","long","full","#details"];
function detectDetailModeAndClean(promptRaw){
  const raw = String(promptRaw || "");
  const low = raw.toLowerCase();
  const detailed = DETAIL_KEYWORDS.some(k => low.includes(k));
  if (!detailed) return { detailed:false, prompt: raw.trim() };
  let cleaned = raw;
  for (const k of DETAIL_KEYWORDS) cleaned = cleaned.replace(new RegExp(k, "ig"), "");
  return { detailed:true, prompt: cleaned.trim() };
}

// ---------- Prompts métier ----------
const SYSTEM_PROMPT = `Tu es un mécano expérimenté ET pédagogue.
Objectif en 2 temps :
(1) Diagnostic initial pertinent et compréhensible, avec collecte d'infos utiles.
(2) Proposer ensuite un passage chez un pro (CTA) seulement quand c'est pertinent.

Règles :
- Français clair, ton pro et rassurant.
- Toujours répondre en 4 blocs :
  1) Diagnostic probable (1–2 lignes, top 1–3 causes)
  2) Vérifs prioritaires (3–5 puces, accessibles si possible)
  3) Actions immédiates (3–5 puces)
  4) Quand passer à la valise (1–2 lignes)

- Si le message utilisateur contient une section commençant par "Contexte véhicule",
  considère ces éléments (marque, modèle, année/moteur, kilométrage, type d’usage, code postal,
  codes OBD/DTC, observations) comme DÉJÀ FOURNIS : ne les redemande pas, ne les re-formule pas
  longuement ; pose uniquement les questions qui manquent et sont utiles au diagnostic.

- Ne JAMAIS pousser un CTA avant d'avoir expliqué, posé 1–2 questions utiles et tenté de collecter
  des infos lead (si l'utilisateur est réceptif).
- Collecte lead discrète : marque, modèle, année/moteur, km, usage, CP, codes OBD si connus.
- Bascule CTA si confiance ≥ 0.65 OU symptômes “rouges”, ET lead minimal (marque+modèle+année ou immat, + CP ou moyen de rappel).
- Si l'utilisateur demande des "détails" (#details), développe davantage sans blabla.`;

// ---------- Health ----------
app.get("/healthz", (_req, res) =>
  res.json({ status:"ok", model: OPENAI_MODEL, branch: process.env.RENDER_GIT_BRANCH || null, db: !!pool })
);

// ---------- Leads intake (facultatif) ----------
app.post("/api/leads/intake", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DB_NOT_CONFIGURED" });
  const body = typeof req.body === "string" ? tryParseJSON(req.body) || {} : (req.body || {});
  const {
    session_id = null,
    brand = null, model = null, engine = null, year = null,
    dtc = null, notes = null, postal_code = null, source = "chat"
  } = body;
  try {
    const { rows } = await pool.query(
      `insert into leads (session_id, brand, model, engine, year, dtc, notes, postal_code, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id, created_at`,
      [session_id, brand, model, engine, year, dtc, notes, postal_code, source]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Leads callback (facultatif) ----------
app.post("/api/leads/callback", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DB_NOT_CONFIGURED" });
  const body = typeof req.body === "string" ? tryParseJSON(req.body) || {} : (req.body || {});
  const {
    session_id = null, contact_name = null, contact_phone = null, contact_email = null, source = "callback"
  } = body;
  try {
    const { rows } = await pool.query(
      `insert into leads (session_id, contact_name, contact_phone, contact_email, source)
       values ($1,$2,$3,$4,$5)
       returning id, created_at`,
      [session_id, contact_name, contact_phone, contact_email, source]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Diagnose (non-stream) -> { text, payload } ----------
app.all("/api/diagnose", async (req, res) => {
  const promptRaw = pickPrompt(req);
  if (!promptRaw) return res.status(400).json({ error: "MISSING_PROMPT" });

  const userPrompt = String(promptRaw);

  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: PAYLOAD_INSTRUCTION }, // contrat JSON non-stream
        { role: "user", content: userPrompt }
      ]
    });

    const raw = chat.choices?.[0]?.message?.content || "";
    const payload = extractPayloadFromText(raw) || {
      confidence: null,
      probable_causes: [],
      next_questions: [
        "Marque, modèle, année/moteur ?",
        "Kilométrage et type d’usage (courts/longs) ?",
        "Ton code postal pour proposer un garage proche ?"
      ],
      lead_missing: ["brand","model","year","engine","mileage_km","postal_code","contact"],
      cta: { show: false, items: [] }
    };	
    const text = stripPayloadBlock(raw);

    res.json({ text: text.trim(), payload, mode: "concise" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Diagnose (stream) : texte seul ----------
async function handleDiagnoseStream(req, res){
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const hb = setInterval(() => sseHeartbeat(res), 15_000);
  req.on("close", () => clearInterval(hb));

  try {
    const promptRaw = pickPrompt(req);
    if (!promptRaw){ sseWrite(res, { error:"MISSING_PROMPT" }); return res.end(); }

    const { detailed, prompt } = detectDetailModeAndClean(promptRaw);

    const stream = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      stream: true,
      messages: [
        { role:"system", content: SYSTEM_PROMPT },
        { role:"user", content: prompt }
      ]
    });

    for await (const chunk of stream){
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) sseWrite(res, { delta });
    }
    sseWrite(res, { done:true, mode: detailed ? "detailed" : "concise" });
    clearInterval(hb);
    res.end();
  } catch (e) {
    sseWrite(res, { error: String(e.message || e) });
    clearInterval(hb);
    res.end();
  }
}
app.get("/api/diagnose/stream", handleDiagnoseStream);
app.post("/api/diagnose/stream", handleDiagnoseStream);

// ---------- Compat anciens endpoints admin ----------
app.all(["/api/admin/rag/diagnose", "/api/admin/diagnose"], async (req, res) => {
  const promptRaw = (req.query?.prompt || req.query?.q || (typeof req.body === "string" ? req.body : req.body?.prompt) || "").toString();
  if (!promptRaw) return res.status(400).json({ error: "MISSING_PROMPT" });

  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: promptRaw.trim() }
      ]
    });
    const text = chat.choices?.[0]?.message?.content?.trim() || "";
    // Heuristique simple : si le texte évoque des cas courants sérieux → CTA on
function hasAny(s, arr){ s = (s||"").toLowerCase(); return arr.some(k => s.includes(k)); }
const suggestCTA =
  (payload.confidence ?? 0) >= 0.65 ||
  hasAny(text, ["mode dégradé","p024","p0299","p030","p0401","p0420","p242f","p2463","p2452","p244c","capteur pression différentiel","fap","egr"]);

if (suggestCTA) {
  payload.cta = payload.cta || {};
  payload.cta.show = true;
  payload.cta.items = payload.cta.items?.length ? payload.cta.items : [
    { type: "booking",  label: "Prendre RDV diagnostic",           url: "/rdv" },
    { type: "callback", label: "Être rappelé par un conseiller",   url: "/rappel" }
  ];
}

res.json({ text, mode: "concise", legacy: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 Server up on :${PORT}`));
