// embed_cases.js — génère les embeddings pour bot.case_technique
import 'dotenv/config';
import { Pool } from 'pg';
import OpenAI from 'openai';

// --- Connexion Postgres : URL OU champs séparés
const usePgFields = !!(process.env.PGHOST || process.env.PGUSER || process.env.PGPASSWORD);
const pool = usePgFields
  ? new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 6543),
      database: process.env.PGDATABASE || 'postgres',
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD,
      ssl: { rejectUnauthorized: false }
    })
  : new Pool({
      connectionString: process.env.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false }
    });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Colonne = vector(1536) -> modèle 1536 dims
const EMB_MODEL = process.env.EMB_MODEL || 'text-embedding-3-small';

async function main() {
  const { rows } = await pool.query(
    `select id, categorie, titre, symptomes, codes_obd, diag_etapes, solutions
     from bot.case_technique
     where embedding is null
     limit 500`
  );

  if (rows.length === 0) {
    console.log('Rien à vectoriser : tous les embeddings sont déjà présents.');
    await pool.end();
    return;
  }

  for (const r of rows) {
    const text = [
      r.categorie, r.titre,
      (r.symptomes || []).join(', '),
      (r.codes_obd || []).join(', '),
      (r.diag_etapes || []).join(' | '),
      (r.solutions || []).join(' | ')
    ].filter(Boolean).join('\n');

    // 1) Génère l'embedding
    const resp = await openai.embeddings.create({ model: EMB_MODEL, input: text });
    const vec = resp.data[0].embedding;

    // 2) Convertit en littéral pgvector: "[v1,v2,...]" (ET le caste en ::vector)
    const vecStr = `[${vec.join(',')}]`;

    // 3) Met à jour la colonne vector correctement
    await pool.query(
      `update bot.case_technique
         set embedding = $1::vector
       where id = $2`,
      [vecStr, r.id]
    );

    console.log('Embedded:', r.titre);
  }

  await pool.end();
  console.log('OK: embeddings générés');
}

main().catch(err => {
  console.error('ERREUR embeddings:', err.message || err);
  process.exit(1);
});
