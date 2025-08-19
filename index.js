// DEBUG côté serveur (masque sources/ragError si false)
const DEBUG = process.env.DEBUG === "1" || process.env.NODE_ENV !== "production";

// index.js — Re-FAP bot: diag → routage (garages partenaires / Carter-Cash), Re-FAP CTA, RAG Supabase, leads
import dotenv from "dotenv";
dotenv.config({ path: process.env.DOTENV_PATH || ".env" });

import express from "express";
import pg from "pg";
import "pgvector/pg";
import OpenAI from "openai";

const { Pool } = pg;

// ---------- Boot logs ----------
console.log(`[BOOT] file=${new URL(import.meta.url).pathname}`);
console.log(`[BOOT] cwd=${process.cwd()}`);

// ---------- DB config ----------
function pgConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
  }
  const need = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
  const miss = need.filter((k) => !process.env[k]);
  if (miss.length) {
    console.error("❌ DB env manquantes:", miss.join(", "));
    process.exit(1);
  }
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
  };
}
const pool = new Pool(pgConfig());

async function initDB() {
  const c = await pool.connect();
  try {
    await c.query("create extension if not exists vector");
    const info = await c.query("select current_database() db");
    console.log("✅ PostgreSQL OK | DB:", info.rows[0].db);
  } finally {
    c.release();
  }
}

// ---------- Helpers ----------
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}
function pickFallbackCTA(msg) {
  const t = (msg || "").toLowerCase();
  const hasFap = /\bfap\b/.test(t) || t.includes("filtre à particules") || t.includes("filtre a particules");
  if (hasFap && process.env.CTA_FAP) return { id:"fallback_fap", type: "fap", label: "Prendre RDV FAP", url: process.env.CTA_FAP };
  if (process.env.CTA_GENERIC) return { id:"fallback_generic", type: "generic", label: "Trouver un garage", url: process.env.CTA_GENERIC };
  return null;
}

// Nettoyage réponse modèle
function sanitizeReply(s = "") {
  return String(s)
    .replace(/https?:\/\/\S+/gi, "[utilise le **bouton ci-dessous**]") // pas d'URL
    .replace(/\bIdgarages\b/gi, "nos garages partenaires") // neutralise la marque
    .replace(/(^|\n)\s*(CTA|Call ?to ?action)\s*(principal|secondaire)?\s*:\s?.*?(?=\n|$)/gi, "")
    .replace(/\bCTA\s*(principal|secondaire)\b/gi, "")
    .replace(/\bbouton\s*(principal|secondaire)\b/gi, "bouton")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- RAG ----------
const RAG = {
  schema: "bot",
  table: "case_technique",
  embedCol: "embedding",
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
  topK: Number(process.env.RAG_TOPK || 5),
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openaiKey = process.env.OPENAI_API_KEY || process.env.CLÉ_API_OPENAI;
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

const textLikeNames = ["text","texte","content","body","chunk","description","details","symptome","symptômes","probleme","solution","reponse","réponse","title","titre","hint","note"];
const cacheTextCols = new Map();
async function getTextColumns(schema, table) {
  const key = `${schema}.${table}`;
  if (cacheTextCols.has(key)) return cacheTextCols.get(key);
  const { rows } = await pool.query(
    `select column_name, data_type
     from information_schema.columns
     where table_schema = $1 and table_name = $2`,
    [schema, table]
  );
  const cols = rows
    .filter(r => r.data_type.includes("text") || r.data_type.includes("character"))
    .map(r => r.column_name);
  cols.sort((a,b) => {
    const pa = textLikeNames.some(n => a.toLowerCase().includes(n)) ? -1 : 0;
    const pb = textLikeNames.some(n => b.toLowerCase().includes(n)) ? -1 : 0;
    return pa - pb || a.localeCompare(b);
  });
  const picked = cols.slice(0, 6);
  cacheTextCols.set(key, picked);
  return picked;
}
async function ragSearch(question) {
  const textCols = await getTextColumns(RAG.schema, RAG.table);
  const selectSql = textCols.length ? ", " + textCols.map(c => `e."${c}" as "${c}"`).join(", ") : "";

  const embResp = await withTimeout(
    openai.embeddings.create({ model: RAG.embeddingModel, input: question }),
    15000
  );
  const embedding = embResp.data[0].embedding;

  const sql = `
    select e.ctid as _rid ${selectSql}
    from ${RAG.schema}."${RAG.table}" e
    order by e."${RAG.embedCol}" <-> $1
    limit $2
  `;
  const { rows } = await pool.query(sql, [embedding, RAG.topK]);

  const sources = rows.map((row) => {
    const textParts = textCols.map(c => row[c]).filter(v => typeof v === "string" && v.trim().length).slice(0, 3);
    return { id: row._rid, preview: textParts.join(" | ").slice(0, 300) };
  });
  return { sources, usedCols: textCols };
}

// ===== Decision rules (CTAs) =====
const LINKS = {
  idgaragesDiag:
    process.env.CTA_IDGARAGES_DIAG ||
    "https://www.idgarages.com/fr-fr/prestations/diagnostic-electronique?utm_source=re-fap&utm_medium=partenariat&utm_campaign=diagnostic-electronique&ept-publisher=re-fap&ept-name=re-fap-diagnostic-electronique",
  refapInfos: process.env.CTA_REFAP || "https://auto.re-fap.fr",
  carterCash: process.env.CTA_CARTER_CASH || "https://www.carter-cash.com/magasins/",
  rappel: process.env.CTA_RAPPEL || "mailto:contact@re-fap.fr?subject=Rappel%20Re-FAP%20bot"
};

const CTA_LIBRARY = {
  idgarages: { id: "idgarages", label: "Diag rapide près de chez moi", url: LINKS.idgaragesDiag },
  refap:     { id: "refap",     label: "Nettoyage FAP Re-FAP — infos & tarifs", url: LINKS.refapInfos },
  carter:    { id: "carter",    label: "Apporter mon FAP (Carter-Cash)",       url: LINKS.carterCash },
  rappel:    { id: "rappel",    label: "Être rappelé rapidement",               url: LINKS.rappel }
};

// Motifs simples (signaux)
const PATTERNS = {
  nonDrivable: /(démarre pas|ne ?d[eé]marre pas|impossible de d[eé]marrer|ne roule pas|ne peut pas rouler|à l'arrêt complet|cal[ea]|s'arr[eê]te|stall)/i,
  powerLoss: /(plus de puissance|perte de puissance|mode d[eé]grad[eé]|bride|limp)/i,
  fapLight: /(voyant\s*fap|filtre\s*(à|a)\s*particules)/i,
  engineLight: /(voyant (moteur|orange)|check engine)/i,
  regenFailed: /(r[eé]g[ée]n[ée]r(ation|er) (rat[ée]e?|ne se fait pas|impossible)|autoroute.*(inutile|sans effet))/i,
  fapRemoved: /(fap.*(d[eé]mont[ée]|\bretir[eé]\b)|d[eé]mont[ée].*fap)/i,
  diy: /(je peux d[eé]monter|je sais d[eé]monter|je le fais moi[- ]m[eê]me|bricoleur)/i,
  smokeBlack: /(fum[eé]e noire)/i,
  smokeBlue: /(fum[eé]e bleue)/i,
  smokeWhite: /(fum[eé]e blanche)/i,
  shortTrips: /(petits trajets|trajets courts|ville uniquement)/i,
  adblue: /\badblue\b/i,
  egr: /\begr\b/i,
  fapCodes: /\b(P2002|P242F|P244A|P2463|P2452|P2453)\b/i
};

function extractSignals(text = "") {
  const t = (text || "").toLowerCase();
  return {
    nonDrivable: PATTERNS.nonDrivable.test(t),
    powerLoss: PATTERNS.powerLoss.test(t),
    fapLight: PATTERNS.fapLight.test(t),
    engineLight: PATTERNS.engineLight.test(t),
    regenFailed: PATTERNS.regenFailed.test(t),
    fapRemoved: PATTERNS.fapRemoved.test(t),
    diy: PATTERNS.diy.test(t),
    smokeBlack: PATTERNS.smokeBlack.test(t),
    smokeBlue: PATTERNS.smokeBlue.test(t),
    smokeWhite: PATTERNS.smokeWhite.test(t),
    shortTrips: PATTERNS.shortTrips.test(t),
    adblue: PATTERNS.adblue.test(t),
    egr: PATTERNS.egr.test(t),
    fapCodeHit: !!(t.match(PATTERNS.fapCodes))
  };
}

/** Décide 1 CTA principal + 1 secondaire max */
function decideCTAs(sig) {
  const reasons = [];

  if (sig.fapRemoved || sig.diy) {
    reasons.push("FAP déjà démonté / client bricoleur → dépôt FAP chez Carter-Cash");
    return { primary: CTA_LIBRARY.carter, secondary: CTA_LIBRARY.refap, reasons };
  }

  if (sig.nonDrivable) {
    reasons.push("Non roulable / calage → confirmation en garage requise");
    return { primary: CTA_LIBRARY.idgarages, secondary: CTA_LIBRARY.refap, reasons };
  }

  if (sig.fapLight || sig.fapCodeHit || sig.regenFailed) {
    reasons.push("Indices FAP (voyant/codes/régénération) → confirmation + prise en charge complète");
    return { primary: CTA_LIBRARY.idgarages, secondary: CTA_LIBRARY.refap, reasons };
  }

  if (sig.adblue || sig.egr || sig.smokeBlack || sig.smokeBlue || sig.smokeWhite || sig.powerLoss) {
    reasons.push("Symptômes variables (AdBlue/EGR/fumées/puissance) → diag d’abord");
    return { primary: CTA_LIBRARY.idgarages, secondary: CTA_LIBRARY.refap, reasons };
  }

  reasons.push("Cas générique → diag le plus utile pour commencer");
  return { primary: CTA_LIBRARY.idgarages, secondary: CTA_LIBRARY.rappel, reasons };
}

// ---------- Conversation Re-FAP ----------
const sessions = new Map();
const REQUIRED_FOR_OFFER = ["vehicle","driving","symptoms"];

const SLOT_ORDER = [
  "vehicle","mileage","driving","lights","symptoms","codes","adblue",
  "urgency","canRemove","postcode","plate","contactName","phone"
];
const SLOT_QUESTION = {
  vehicle: "Quel véhicule exactement (marque, modèle, année, motorisation) ?",
  mileage: "Quel kilométrage approximatif ?",
  driving: "Tu fais surtout des petits trajets/ville, ou de l’autoroute régulièrement ?",
  lights: "Quels voyants/messages s’affichent (FAP, moteur, AdBlue, ‘risque colmatage’, etc.) ?",
  symptoms: "Quels symptômes observes-tu (perte de puissance, mode dégradé, fumée, conso en hausse) ?",
  codes: "As-tu des codes défaut OBD (si tu as passé une valise) ?",
  adblue: "Le voyant AdBlue est-il allumé (ou un message lié) ?",
  urgency: "Tu peux encore rouler sans risque, ou la voiture est quasi immobilisée ?",
  canRemove: "Tu peux démonter ton FAP toi-même (oui/non) ?",
  postcode: "Quel est ton code postal ?",
  plate: "Quelle est l’immatriculation (format AA-123-AA) ?",
  contactName: "Un prénom/nom pour te rappeler ?",
  phone: "Ton numéro pour qu’on te rappelle rapidement ?"
};

function softExtractSlots(text) {
  const t = (text||"").toLowerCase();
  const slots = {};
  if (/\b(fap|dpf|filtre (?:a|à) particules|risque colmatage)\b/.test(t))
    slots.symptoms = (slots.symptoms||"") + " mention FAP";
  if (/adblue/.test(t)) slots.adblue = "oui";
  if (/mode d[eé]grad[eé]|perte de puissance|plus de puissance|pas de puissance/.test(t)) {
    slots.symptoms = (slots.symptoms||"") + " perte puissance/mode dégradé";
    slots.severe = "oui";
  }
  if (/ne peux pas r[eé]g[eé]n[eé]rer|impossible de r[eé]g[eé]n[eé]rer/.test(t)) slots.severe = "oui";

  const mCp = t.match(/\b\d{5}\b/); if (mCp) slots.postcode = mCp[0];
  const mPlate = t.match(/\b[A-Z]{2}-\d{3}-[A-Z]{2}\b/i); if (mPlate) slots.plate = mPlate[0].toUpperCase();

  if (/je peux|je sais.*d[eé]monter|moi.*d[eé]monter/.test(t)) slots.canRemove = "oui";
  if (/je ne peux pas|je ne sais pas/.test(t)) slots.canRemove = "non";

  return slots;
}
function nextMissingSlot(slots){ for (const k of SLOT_ORDER) if (!slots[k]?.trim?.()) return k; return null; }
function readyForOffer(slots){ return REQUIRED_FOR_OFFER.every(k => slots[k]?.trim?.()); }

function fapScore(slots){
  let s=0;
  const txt = `${slots.lights||""} ${slots.symptoms||""} ${slots.driving||""}`.toLowerCase();
  if (/(fap|dpf|risque colmatage|filtre (?:a|à) particules)/.test(txt)) s+=30;
  if (/(petits trajets|ville|trajets courts|moteur froid)/.test(txt)) s+=20;
  if (/(perte.*puissance|plus.*puissance|pas.*puissance|mode.*d[eé]grad[eé]|fum[eé]e)/.test(txt)) s+=30;
  if (/adblue/.test(txt)) s+=15;
  if (/(autoroute régulière|longs trajets)/.test(txt) && !/(perte.*puissance|mode.*d[eé]grad[eé])/.test(txt)) s-=20;
  s = Math.max(0,Math.min(100,s));
  return s;
}

const IDGARAGES_URL = process.env.CTA_IDGARAGES ||
  "https://www.idgarages.com/fr-fr/prestations/diagnostic-electronique?utm_source=re-fap&utm_medium=partenariat&utm_campaign=diagnostic-electronique&ept-publisher=re-fap&ept-name=re-fap-diagnostic-electronique";
const RE_FAP_URL = process.env.CTA_RE_FAP || "https://auto.re-fap.fr";

async function decideRouting(slots){
  const score = fapScore(slots);
  const severe = (slots.severe === "oui") ||
                 /perte.*puissance|plus.*puissance|pas.*puissance|mode.*d[eé]grad[eé]/i.test(slots.symptoms||"");

  const res = { score, route: "generic", ctas: [], needs: [] };

  if (severe && score >= 40) {
    res.route = "partner_garage";
    if (!slots.postcode) res.needs.push("postcode");
    if (!slots.plate)    res.needs.push("plate");
    res.ctas.push({
      id:"cta_diag",
      type: "fap",
      label: "Devis diag près de chez moi",
      url: IDGARAGES_URL,
      hint: "Renseigne ton immatriculation et ton code postal pour obtenir des devis immédiats."
    });
    res.ctas.push({ id:"cta_refap", type:"info", label:"Nettoyage FAP Re-FAP — infos & tarifs", url: RE_FAP_URL });
    res.ctas.push({ id:"cta_rappel", type:"callback", label:"Être rappelé rapidement", url:"#lead" });
    return res;
  }

  if (score >= 60){
    if ((slots.canRemove||"").toLowerCase().startsWith("o")){
      res.route = "self_remove_cc";
      res.ctas.push({
        id:"cta_carter",
        type: "fap",
        label: "Trouver un Carter-Cash près de chez moi",
        url: "https://www.carter-cash.com/magasins/",
        hint: "Apporte ton FAP démonté : ils proposent le nettoyage Re-FAP."
      });
    } else {
      res.route = "partner_garage";
      if (!slots.postcode) res.needs.push("postcode");
      if (!slots.plate)    res.needs.push("plate");
      res.ctas.push({
        id:"cta_diag",
        type: "fap",
        label: "Devis diag près de chez moi",
        url: IDGARAGES_URL,
        hint: "Renseigne ton immatriculation et ton code postal pour obtenir des devis immédiats."
      });
    }
  } else if (score >= 40){
    res.route = "likely_but_uncertain";
    res.ctas.push({
      id:"cta_diag",
      type: "fap",
      label: "Devis diag près de chez moi",
      url: IDGARAGES_URL,
      hint: "Renseigne ton immatriculation et ton code postal pour obtenir des devis."
    });
  } else {
    res.route = "generic";
    const url = process.env.CTA_GENERIC || IDGARAGES_URL;
    res.ctas.push({ id:"cta_generic", type: "generic", label: "Trouver un garage", url });
  }

  res.ctas.push({ id:"cta_refap", type:"info", label:"Nettoyage FAP Re-FAP — infos & tarifs", url: RE_FAP_URL });
  res.ctas.push({ id:"cta_rappel", type:"callback", label:"Être rappelé rapidement", url:"#lead" });
  return res;
}

// ==== Prompt système global Re-FAP (base) ====
const BASE_SYS = `
Tu es **Re-FAP Bot**, mécano pragmatique et rassurant.

Objectifs (dans cet ordre):
1) Trier vite en 2–3 pistes probables, éviter les dépenses au hasard.
2) Si l'incertitude est élevée, proposer d'abord un **diagnostic rapide** (lecture OBD, pression différentielle FAP, niveau d’additif Eolys quand présent) via le **bouton ci-dessous**.
3) Si FAP probable ou confirmé: mettre en avant le **Nettoyage FAP Re-FAP** (solution reconnue, efficace, économique, pas de remplacement).
4) Si le FAP est **déjà démonté** ou si l’utilisateur **peut démonter**: proposer **Carter-Cash** (ils réalisent le nettoyage Re-FAP).
5) Ne JAMAIS recommander la suppression/défap (illégal). 

Règles de style:
- Clair, concret, sans jargon inutile. Ton aimable et direct.
- **Jamais d’URL ni de nom de plateforme** dans tes messages (tu dis “utilise le **bouton ci-dessous**”).
- Toujours structurer ta réponse avec:
  • un **récap en 1 ligne** (contexte utilisateur),
  • **1 action concrète** maintenant,
  • **au plus 1 question de relance** pertinente,
  • (les boutons sont gérés par le serveur, ne les nomme pas, dis juste “utilise le **bouton ci-dessous**”).
- Écrire **“bouton”** (pas “bonton”).

Cas fréquents:
- “Ça cale / ne démarre pas / pas de puissance” **sans voyant**: FAP souvent **peu probable**. Pistes moteur: capteur PMH, pression rail/basse pression, filtre GO, injecteur en fuite, EGR bloquée ouverte, etc. Toujours proposer un **diag rapide** d’abord.
- Ambiguïté sur présence FAP (ex. 206 1.6 HDi 90 vs 110): **valider l’équipement FAP** et l’éventuel système d’additif (Eolys).
- Si FAP confirmé plus tard: dire d’**exiger un nettoyage Re-FAP** au garage.

Mention légale implicite:
“Le chatbot peut se tromper; un contrôle réel s’impose avant intervention.”
`.trim();

function personaPrompt(slots, stage, route, score){
  return [
    BASE_SYS,
    "",
    "Contexte diagnostic (pour toi, ne pas tout répéter mot à mot) :",
    `• Slots: ${JSON.stringify(slots)}`,
    `• Score FAP: ${score}/100`,
    `• Route prévue: ${route}`,
    "",
    (stage === "offer")
      ? "Mode: **CONSEIL** — Donne le diagnostic probable (avec prudence), l’étape atelier utile, mets en avant le nettoyage Re-FAP si pertinent, et oriente via le **bouton** adapté. Pas d’URL, pas de marque; dis juste “utilise le **bouton ci-dessous**”. Pose **au plus une** question de relance."
      : "Mode: **DIAG** — Pose **une seule** question utile et courte pour faire avancer le tri (ex: véhicule exact, voyants/codes, symptômes clés). Si la situation paraît sérieuse ou incertaine, propose le **bouton** de diagnostic. Pas d’URL, pas de marque; dis juste “utilise le **bouton ci-dessous**”."
  ].join("\n");
}

// ---------- Express ----------
const app = express();
app.use(express.json());
app.set("db", pool);
app.locals.ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

// Logger
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

// Health
app.get("/healthz", (_req, res) => res.json({ status: "ok", uptime: process.uptime(), port: Number(process.env.PORT || 3000) }));
app.get("/readyz", async (_req, res) => {
  try { await pool.query("select 1"); res.json({ db: "ok" }); }
  catch (e) { res.status(500).json({ db: "down", error: e.message }); }
});

// Base API
app.get("/api/hello", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req,res) => res.json({
  ctaFap: process.env.CTA_FAP || null,
  ctaGeneric: process.env.CTA_GENERIC || null,
  ctaIdgarages: IDGARAGES_URL,
  ctaRefap: RE_FAP_URL
}));

// ---------- Chat ----------
app.post("/api/chat", async (req, res) => {
  try {
    // Mode mock simple
    if (req.query.mock === "1") {
      return res.json({
        sessionId: req.body?.sessionId || `${Date.now()}-${Math.random()}`,
        reply: "D’accord, on commence simple : peux-tu préciser si un **voyant moteur** ou un **message d’erreur** s’affiche ? Sinon, utilise le **bouton ci-dessous** pour un **diagnostic rapide** près de chez toi.",
        stage: "diag",
        next: "lights",
        ctas: [
          { id:"cta_diag", label:"Devis diag près de chez moi", url: IDGARAGES_URL },
          { id:"cta_refap", label:"Nettoyage FAP Re-FAP — infos & tarifs", url: RE_FAP_URL },
          { id:"cta_rappel", label:"Être rappelé rapidement", url:"#lead" }
        ]
      });
    }

    const { message, sessionId: inSessionId } = req.body || {};
    if (!message || typeof message !== "string") return res.status(400).json({ error: "message (string) requis" });

    let sessionId = inSessionId || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    if (!sessions.has(sessionId)) sessions.set(sessionId, { slots: {}, mode: "diag", history: [] });
    const sess = sessions.get(sessionId);

    Object.assign(sess.slots, softExtractSlots(message));

    // RAG (optionnel)
    let sources = [], context = "", ragError = null;
    if (openai) {
      try {
        await pool.query(`select 1 from information_schema.tables where table_schema=$1 and table_name=$2`, [RAG.schema, RAG.table]);
        const r = await ragSearch(message);
        sources = r.sources;
        if (sources.length) context = sources.map((s,i)=>`Source ${i+1}: ${s.preview}`).join("\n");
      } catch (e) { ragError = e.message || String(e); }
    }

    const stage = readyForOffer(sess.slots) ? "offer" : "diag";
    const routing = await decideRouting(sess.slots);
    const system = personaPrompt(sess.slots, stage, routing.route, routing.score);

    const user = stage === "diag"
      ? `Question utilisateur: ${message}\n${context ? `Contexte interne:\n${context}\n` : ""}Action: Pose UNE question utile (${SLOT_ORDER.join(", ")}) puis oriente si nécessaire via les **boutons** (diag près de chez moi / Carter-Cash / Re-FAP). Ne mets pas de lien.`
      : `Question utilisateur: ${message}\n${context ? `Contexte interne:\n${context}\n` : ""}Action: Donne le diagnostic probable + ce qui sera fait en atelier. Mets en avant le nettoyage Re-FAP. Propose le bon **bouton** (${routing.route}). Sans URL.`;

    let text;
    if (openai) {
      const input = [
        { role: "system", content: system },
        ...sess.history.slice(-4),
        { role: "user", content: user }
      ];
      const resp = await withTimeout(openai.responses.create({ model: OPENAI_MODEL, input }), 20000);
      text =
        resp.output_text ??
        (Array.isArray(resp.output) && resp.output[0]?.content?.[0]?.text?.value) ??
        (resp.choices?.[0]?.message?.content?.[0]?.text ?? resp.choices?.[0]?.message?.content) ??
        "Réponse indisponible.";
    } else {
      text = stage === "diag"
        ? "OK. Donne-moi le modèle exact et tes symptômes (voyants, perte de puissance, etc.). Si c’est sérieux, utilise le **bouton** pour un diagnostic près de chez toi et regarde l’option **Nettoyage Re-FAP**."
        : "Je te recommande un passage FAP (lecture défauts, pression diff., additif). Utilise les **boutons** ci-dessous pour avancer (diag près de chez toi / Re-FAP).";
    }

    const clean = sanitizeReply(text);

    // Mémorise l’historique
    sess.history.push({ role: "user", content: message });
    sess.history.push({ role: "assistant", content: clean });

    // prochaine question
    let next = null;
    if (stage === "diag") next = nextMissingSlot(sess.slots);
    else if (routing.route === "partner_garage" && routing.needs.length) next = routing.needs[0];

    // CTA
    const ctasArr = (routing?.ctas || []).filter(Boolean);
    const payload = {
      sessionId,
      reply: String(clean ?? text ?? "").trim(),
      stage: stage ?? null,
      next: next ?? null,
      ctas: ctasArr.slice(0, 3),
      cta: ctasArr[0] || pickFallbackCTA(message),
    };

    // Debug only
    if (DEBUG) {
      if (Array.isArray(sources) && sources.length) payload.sources = sources;
      if (routing?.reasons?.length) payload.decision = { reasons: routing.reasons };
      if (ragError) {
        const s = String(ragError);
        payload.ragError = s.length > 180 ? s.slice(0, 180) + "…" : s;
      }
    } else {
      payload.sources = [];
      payload.ragError = null;
    }

    return res.json(payload);

  } catch (e) {
    console.error("CHAT error:", e);
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------- Lead (rappel rapide) ----------
app.post("/api/lead", async (req, res) => {
  try {
    const { sessionId, name, phone, email, vehicle, postcode, message } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: "name et phone requis" });
    // Table optionnelle bot.leads
    try {
      const { rows } = await pool.query(
        `insert into bot.leads (session_id, name, phone, email, vehicle, postcode, message)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, created_at`,
        [sessionId||null, name, phone, email||null, vehicle||null, postcode||null, message||null]
      );
      return res.json({ ok:true, leadId: rows[0].id, created_at: rows[0].created_at });
    } catch {
      // si la table n'existe pas: ne bloque pas l'UX
      return res.json({ ok:true });
    }
  } catch (e) {
    console.error("LEAD error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Metrics (CTA clicks) ----------
app.post("/api/metrics", async (req, res) => {
  try {
    const { event, id, url, sessionId } = req.body || {};
    console.log("metrics:", { event, id, url, sessionId });
    // Option DB :
    // await pool.query(
    //   `insert into bot.metrics(event, cta_id, url, session_id) values ($1,$2,$3,$4)`,
    //   [event||null, id||null, url||null, sessionId||null]
    // );
    res.json({ ok: true });
  } catch (e) {
    console.error("metrics error:", e);
    res.status(204).end();
  }
});

// ---------- Admin ----------
if (!app.locals.__adminMounted) {
  app.locals.__adminMounted = true;

  const requireAdmin = (req, res, next) => {
    const token = app.locals.ADMIN_TOKEN;
    if (!token) return res.status(500).json({ error: "ADMIN_TOKEN manquant" });
    const headerOK = (req.headers.authorization || "") === `Bearer ${token}`;
    const queryOK = (req.query?.token || "") === token;
    if (!headerOK && !queryOK) return res.status(401).json({ error: "unauthorized" });
    next();
  };

  app.get("/api/admin/guess", requireAdmin, async (_req, res) => {
    try {
      const { rows: vectorColumns } = await pool.query(`
        select n.nspname as schema, c.relname as table, a.attname as column
        from pg_attribute a
        join pg_class c on c.oid=a.attrelid
        join pg_namespace n on n.oid=c.relnamespace
        where a.atttypid::regtype::text = 'vector'
          and n.nspname not in ('pg_catalog','information_schema')
        order by 1,2,3
      `);
      const { rows: logLikeTables } = await pool.query(`
        select n.nspname||'.'||c.relname as name
        from pg_class c
        join pg_namespace n on n.oid=c.relnamespace
        where c.relkind='r'
          and n.nspname not in ('pg_catalog','information_schema')
          and (c.relname ~* '(chat|message|conversation).*log'
               or c.relname ~* '^(chat|message|conversation)s?$'
               or c.relname ~* 'log')
        order by 1
      `);
      res.json({ vectorColumns, logLikeTables });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/admin/schema", requireAdmin, async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        with tbls as (
          select n.nspname as schema, c.relname as table, c.oid
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema')
        ),
        cols as (
          select n.nspname as schema, c.relname as table, a.attname as column,
                 pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
                 a.attnotnull as notnull
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
          where a.attnum>0 and not a.attisdropped and c.relkind='r'
            and n.nspname not in ('pg_catalog','information_schema')
          order by a.attnum
        )
        select t.schema, t.table,
               json_agg(json_build_object('column', c.column, 'type', c.type, 'notnull', c.notnull)
                        order by c.column) as columns
        from tbls t join cols c on c.schema=t.schema and c.table=t.table
        group by 1,2 order by 1,2
      `);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/admin/rag/diagnose", requireAdmin, async (_req, res) => {
    try {
      const who = await pool.query("select current_user, current_setting('search_path') as search_path");
      const exists = await pool.query(
        `select exists(select 1 from information_schema.tables where table_schema=$1 and table_name=$2) as ok`,
        [RAG.schema, RAG.table]
      );
      let probe = null, error = null;
      try {
        const dims = RAG.embeddingModel.includes("small") ? 1536 : 3072;
        const v = Array(dims).fill(0);
        await pool.query(`select 1 from ${RAG.schema}."${RAG.table}" order by "${RAG.embedCol}" <-> $1 limit 1`, [v]);
        probe = "ok";
      } catch (e) { error = e.message; }
      res.json({ who: who.rows[0], exists: exists.rows[0].ok, probe, error });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log("🔐 Admin endpoints montés (/api/admin/guess, /api/admin/schema, /api/admin/rag/diagnose)");
}

// ---------- UI ----------
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Re-FAP assistant</title>
<style>
  :root{
    --bg:#0b1220; --card:#0f172a; --ink:#e5ecff; --muted:#94a3b8;
    --accent:#3b82f6; --accent-2:#22d3ee;
    --bubble-left:#111a30; --bubble-right:#0e223f; --surface:#0c1429;
  }
  :root.light{
    --bg:#f6f7fb; --card:#ffffff; --ink:#0b1220; --muted:#546478;
    --accent:#2563eb; --accent-2:#0ea5e9;
    --bubble-left:#eef3ff; --bubble-right:#eaf1ff; --surface:#fff;
  }
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial}
  .wrap{max-width:980px;margin:0 auto;padding:18px}
  .card{background:var(--card);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);padding:18px}
  .hdr{display:flex;gap:12px;align-items:center}
  .logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700}
  .title{font-size:20px;font-weight:700}
  .sub{font-size:13px;color:var(--muted)}
  .chips{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
  .chip{background:#0e1a33;border:1px solid rgba(255,255,255,.08);padding:8px 12px;border-radius:999px;font-size:13px;cursor:pointer}
  .is-hidden{display:none}

  .thread{margin-top:16px;height:48vh;min-height:320px;max-height:55vh;overflow:auto;padding-right:6px}
  .b{display:flex;margin:10px 0}
  .b.l{justify-content:flex-start}
  .b.r{justify-content:flex-end}
  .bubble{max-width:76%;padding:12px 14px;border-radius:14px;white-space:pre-wrap;line-height:1.45}
  .bubble.l{background:var(--bubble-left);border:1px solid rgba(255,255,255,.06)}
  .bubble.r{background:var(--bubble-right);border:1px solid rgba(255,255,255,.06)}
  .typing{display:inline-flex;align-items:center;gap:.35rem}
  .dot{width:.45rem;height:.45rem;background:#9fb6ff;border-radius:50%;animation:blink 1s infinite}
  .dot:nth-child(2){animation-delay:.15s}
  .dot:nth-child(3){animation-delay:.3s}
  @keyframes blink {0%,80%,100%{opacity:.25}40%{opacity:1}}

  .ctaBar{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
  .cta{display:inline-block;padding:.65rem .95rem;border-radius:10px;text-decoration:none;background:var(--accent);color:#fff;font-weight:600}
  .cta.secondary{background:#0b2655}
  .cta:focus{outline:2px solid var(--accent-2);outline-offset:2px}

  .composer{display:flex;gap:10px;margin-top:14px}
  .in{flex:1;background:var(--surface);border:1px solid rgba(255,255,255,.08);color:var(--ink);border-radius:12px;padding:.8rem .9rem}
  .btn{background:var(--accent);color:#fff;border:0;border-radius:12px;padding:.8rem 1rem;cursor:pointer}
  .btn:disabled{opacity:.6;cursor:wait}
  .btn.ghost{background:#1e263a;color:#fff}

  .small{font-size:.85rem;color:var(--muted);margin-top:12px}
  a.small{color:var(--muted)}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="hdr">
      <div class="logo">FAP</div>
      <div>
        <div class="title">Re-FAP assistant</div>
        <div class="sub">Diagnostic clair → bonne action au meilleur prix.</div>
      </div>
    </div>

    <div id="chips" class="chips">
      <div class="chip" data-q="Voyant FAP allumé">Voyant FAP allumé</div>
      <div class="chip" data-q="Perte de puissance">Perte de puissance</div>
      <div class="chip" data-q="Fumée noire">Fumée noire</div>
      <div class="chip" data-q="Code P2002">Code P2002</div>
    </div>

    <div id="thread" class="thread" aria-live="polite" aria-label="Fil de conversation"></div>

    <div id="ctas" class="ctaBar"></div>

    <div class="composer">
      <input id="msg" class="in" placeholder="Décris ton symptôme (ex: voyant moteur + perte de puissance)..." />
      <button class="btn" id="send">Envoyer</button>
      <button class="btn ghost" id="mock">Mock</button>
    </div>

    <div class="small">Re-FAP Chatbot peut commettre des erreurs. Il est recommandé de vérifier les informations importantes. <a href="#" class="small">Voir les préférences en matière de cookies</a>.</div>
  </div>
</div>

<script>
const $ = (s)=>document.querySelector(s);
const thread = $("#thread");
const dyn = $("#ctas");
const chips = $("#chips");
const input = $("#msg");
const btnSend = $("#send");
const btnMock = $("#mock");

let sessionId = localStorage.getItem('rf_session') || null;
let sending = false;
let stickToBottom = true;

thread.addEventListener("scroll", ()=>{
  const nearBottom = (thread.scrollHeight - thread.scrollTop - thread.clientHeight) < 60;
  stickToBottom = nearBottom;
});
function scrollEnd(){ if (stickToBottom) thread.scrollTop = thread.scrollHeight; }

function bubbleUser(text){
  const row = document.createElement("div"); row.className="b r";
  const b = document.createElement("div"); b.className="bubble r"; b.textContent = text;
  row.appendChild(b); thread.appendChild(row); scrollEnd();
}
function bubbleBot(text){
  const row = document.createElement("div"); row.className="b l";
  const b = document.createElement("div"); b.className="bubble l"; b.textContent = text;
  row.appendChild(b); thread.appendChild(row); scrollEnd();
}
function showTyping(){
  const row = document.createElement("div"); row.className="b l"; row.id="__typing";
  const b = document.createElement("div"); b.className="bubble l";
  b.innerHTML = 'Re-FAP réfléchit&nbsp;<span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
  row.appendChild(b); thread.appendChild(row); scrollEnd();
}
function hideTyping(){
  const t = document.getElementById("__typing"); if (t) t.remove();
}
function addCTA(cta){
  const a = document.createElement("a");
  a.href = cta.url; a.target = cta.url?.startsWith("#") ? "_self" : "_blank";
  a.className = "cta";
  a.textContent = cta.label || "Continuer";
  a.addEventListener("click", (e)=>{
    if (cta.url === "#lead") { e.preventDefault(); openLead(); return; }
    try {
      const payload = JSON.stringify({ event:"cta_click", id: cta.id || null, url: cta.url || null, sessionId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/metrics", new Blob([payload], { type:"application/json" }));
      } else {
        fetch("/api/metrics", { method:"POST", headers:{ "Content-Type":"application/json" }, body: payload });
      }
    } catch(_){}
  });
  dyn.appendChild(a);
  if (cta.hint) {
    const small = document.createElement("div"); small.className="small"; small.textContent = cta.hint; dyn.appendChild(small);
  }
}

async function send(mock){
  if (sending) return;
  const message = input.value.trim();
  if(!message){ input.focus(); return; }

  sending = true;
  btnSend.disabled = true; btnMock.disabled = true;

  bubbleUser(message);
  input.value = "";
  showTyping();

  if (chips && !chips.classList.contains('is-hidden')) chips.classList.add('is-hidden');

  try {
    const url = mock ? "/api/chat?mock=1" : "/api/chat";
    const body = { message }; if (sessionId) body.sessionId = sessionId;

    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (data.sessionId) { sessionId = data.sessionId; localStorage.setItem('rf_session', sessionId); }

    hideTyping();
    bubbleBot(data.reply || JSON.stringify(data, null, 2));

    // CTA
    dyn.replaceChildren();
    const list = (data.ctas && data.ctas.length) ? data.ctas : (data.cta ? [data.cta] : []);
    list.forEach(addCTA);

  } catch(e){
    hideTyping();
    bubbleBot("Erreur: " + e.message);
  } finally {
    sending = false;
    btnSend.disabled = false; btnMock.disabled = false;
    input.focus();
  }
}

// Chips
chips?.addEventListener("click",(e)=>{
  const c = e.target.closest(".chip");
  if (!c) return;
  input.value = c.getAttribute("data-q") || c.textContent.trim();
  send(false);
});

// Raccourcis
input.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ e.preventDefault(); send(false); } });
window.addEventListener("keydown",(e)=>{
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==="k"){ e.preventDefault(); input.focus(); }
});

// Boutons
btnSend.addEventListener("click", ()=>send(false));
btnMock.addEventListener("click", ()=>send(true));

// Thème clair via ?theme=light
if (new URLSearchParams(location.search).get('theme') === 'light') {
  document.documentElement.classList.add('light');
}

// Lead modal (ultra light)
function openLead(){
  const name = prompt("Prénom / Nom ?");
  if (!name) return;
  const phone = prompt("Téléphone ?");
  if (!phone) return;
  fetch("/api/lead", { method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ sessionId, name, phone })
  }).then(()=> bubbleBot("Merci ! On vous rappelle rapidement."));
}
</script>
</body>
</html>`);
});

// 404 JSON
app.use((req, res) => res.status(404).json({ error: "Not Found", url: req.url }));

// Start
const PORT = Number(process.env.PORT || 3000);
const server = app.listen(PORT, async () => {
  await initDB();
  console.log(`🚀 Server up on :${PORT}`);
});

// Shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await pool.end();
  server.close(() => process.exit(0));
});
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
