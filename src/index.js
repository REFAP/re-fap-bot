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
function extractPayloadFromText(txt) {
  const m = String(txt || "").match(/<PAYLOAD>([\s\S]*?)<\/PAYLOAD>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function stripPayloadBlock(txt) {
  return String(txt || "").replace(/<PAYLOAD>[\s\S]*?<\/PAYLOAD>/g, "").trim();
}

// perf réseau
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

// app
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

// utils
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

// mode “détails” via mot-clé
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
// ===== PROMPTS MÉTIER =====
const SYSTEM_PROMPT = `Tu es un mécano expérimenté ET pédagogue.
Objectif en 2 temps :
(1) Diagnostic initial pertinent et compréhensible, avec collecte d'infos utiles.
(2) Proposer ensuite un passage chez un pro (CTA) seulement quand c'est pertinent.

Règles :
- Langue : français clair, ton pro et rassurant.
- Toujours répondre en 4 blocs quand tu donnes un avis :
  1) Diagnostic probable (1–2 lignes, top 1–3 causes)
  2) Vérifs prioritaires (3–5 puces, accessibles si possible)
  3) Actions immédiates (3–5 puces : sécurité, éviter dégâts, roulage si FAP pertinent)
  4) Quand passer à la valise (1–2 lignes)

- Ne JAMAIS pousser un CTA avant d'avoir :
  (a) expliqué simplement le pourquoi,
  (b) posé 1–2 questions d'exploration,
  (c) tenté de collecter des infos lead utiles si l'utilisateur est réceptif.

- Collecte lead discrète (si l'utilisateur est ok) :
  marque, modèle, année/moteur, kilométrage, type d’usage (trajets courts/longs), code postal, code défaut éventuel.

- Bascule CTA uniquement si :
  - confiance ≥ 0.65 sur l'hypothèse principale OU symptômes “rouges”,
  - au moins marque+modèle+année OU immatriculation, ET code postal OU moyen de rappel.

- CTA : reste pédagogique, explique la valeur (“confirmation rapide au diag valise, limiter les dégâts, devis clair”).
  Propose 1–2 choix max (RDV, être rappelé, nettoyage FAP si pertinent).

- Si l'utilisateur demande des "détails" (#details), développe davantage sans blabla inutile.
- Si hors-scope (non auto), recadre gentiment.`;

const PAYLOAD_INSTRUCTION = `FORMAT DE SORTIE (uniquement pour les réponses non-stream) :
Après ta réponse en 4 blocs, ajoute un bloc balisé EXACTEMENT ainsi :
<PAYLOAD>{
  "confidence": 0.0,
  "probable_causes": [],
  "next_questions": [],
  "lead_missing": ["brand","model","year","engine","mileage_km","postal_code","contact"],
  "cta": {
    "show": false,
    "items": [
      // Exemples quand pertinent :
      // {"type":"booking","label":"Prendre RDV diagnostic","url":"/rdv"},
      // {"type":"callback","label":"Être rappelé","url":"/rappel"},
      // {"type":"product","label":"Nettoyage FAP hors véhicule","url":"/nettoyage-fap"}
    ]
  }
}</PAYLOAD>
Contraintes :
- confidence ∈ [0,1]
- next_questions : 1 à 3 questions utiles (courtes)
- Si tu estimes que CTA est pertinent selon les règles, mets "cta.show": true et propose 1–2 items max.
- Ne mets PAS d'autres champs dans le JSON.`;


// health
app.get("/healthz", (_req, res) =>
  res.json({ status:"ok", model: OPENAI_MODEL, branch: process.env.RENDER_GIT_BRANCH || null })
);

// non-stream (aucun param non supporté)
app.all("/api/diagnose", async (req, res) => {
  const promptRaw = pickPrompt(req);
  if (!promptRaw) return res.status(400).json({ error:"MISSING_PROMPT" });

  const { detailed, prompt } = detectDetailModeAndClean(promptRaw);
  try {
    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role:"system", content: SYSTEM_PROMPT },
        { role:"user", content: prompt }
      ]
    });
    const text = chat.choices?.[0]?.message?.content?.trim() || "";
    res.json({ text, mode: detailed ? "detailed" : "concise" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// stream (aucun param non supporté)
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
// --- Compat anciens endpoints admin -> redirige vers /api/diagnose ---
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

// static
app.use(express.static(path.join(__dirname, "public")));

// start
app.listen(PORT, () => console.log(`🚀 Server up on :${PORT}`));
