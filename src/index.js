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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
});

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
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
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
- Ne JAMAIS pousser un CTA avant d'avoir expliqué, posé 1–2 questions et tenté de collecter des infos lead (si l'utilisateur est réceptif).
- Collecte lead discrète : marque, modèle, année/moteur, km, usage, CP, codes OBD si connus.
- Bascule CTA si confiance ≥ 0.65 OU symptômes “rouges”, ET lead minimal (marque+modèle+année ou immat, + CP ou moyen de rappel).
- Si l'utilisateur demande des "détails" (#details), développe davantage sans blabla.`;

const PAYLOAD_INSTRUCTION = `FORMAT DE SORTIE (uniquement pour les réponses non-stream) :
Après ta réponse en 4 blocs, ajoute EXACTEMENT :
<PAYLOAD>{
  "confidence": 0.0,
  "probable_causes": [],
  "next_questions": [],
  "lead_missing": ["brand","model","year","engine","mileage_km","postal_code","contact"],
  "cta": { "show": false, "items": [] }
}</PAYLOAD>
Contraintes :
- confidence ∈ [0,1]
- next_questions : 1 à 3 questions courtes
- Si CTA pertinent selon les règles, "cta.show": true et propose 1–2 items (booking/callback/produit).
- N’ajoute pas d’autres champs dans le JSON.`;

// ---------- Health ----------
app.get("/healthz", (_req, res) =>
  res.json({ status:"ok", model: OPENAI_MODEL, branch: process.env.RENDER_GIT_BRANCH || null })
);

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
    res.json({ text, mode: "concise", legacy: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 Server up on :${PORT}`));
