// bot.js — router API minimal garanti (Express 5, ESM)
import { Router } from "express";
import OpenAI from "openai";

const router = Router();

// Sanity
router.get("/diag/test", (_req, res) =>
  res.json({ ok: true, msg: "diag test", time: new Date().toISOString() })
);

// DB ping (nécessite app.set('db', pool) dans index.js)
router.get("/db/ping", async (req, res) => {
  const pool = req.app.get("db");
  if (!pool) return res.status(500).json({ db: "missing" });
  try {
    const r = await pool.query("select 1 as x");
    res.json({ db: "ok", x: r.rows[0].x });
  } catch (e) {
    res.status(500).json({ db: "down", error: e.message });
  }
});

// Chat minimal
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const openaiKey = process.env.OPENAI_API_KEY || process.env.CLÉ_API_OPENAI;
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

router.post("/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string")
      return res.status(400).json({ error: "message (string) requis" });
    if (!openai)
      return res.status(503).json({ error: "OPENAI_API_KEY manquant" });

    const r = await openai.responses.create({
      model: OPENAI_MODEL,
      input: `Réponds comme un mécano expérimenté, franc et concis. Question: ${message}`,
    });

    const text =
      r.output_text ??
      (Array.isArray(r.output) && r.output[0]?.content?.[0]?.text?.value) ??
      (r.choices?.[0]?.message?.content?.[0]?.text ??
        r.choices?.[0]?.message?.content) ??
      "Réponse indisponible.";
    res.json({ reply: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
