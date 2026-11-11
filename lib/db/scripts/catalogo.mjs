#!/usr/bin/env node
// Catalogo normalizzato degli schemi di Cerbero (public, caronte, coda): tabelle e
// colonne, vincoli, indici, viste, sequenze. Serve a confrontare due database
// senza dipendere dall'ordine delle colonne né dai nomi dei proprietari.
// Descrive solo quello che è di Cerbero: restano fuori le tabelle di ESCLUSE e
// gli oggetti delle estensioni (PostGIS in produzione).
//   DATABASE_URL=… node lib/db/scripts/catalogo.mjs > catalogo.json
//   node lib/db/scripts/catalogo.mjs --confronta a.json b.json
import { readFileSync } from "node:fs";
import pg from "pg";
import { ESCLUSE } from "./baseline.mjs";

const SCHEMI = ["public", "caronte", "coda"];

// Una relazione è di un'estensione se pg_depend la lega a lei con deptype = 'e'
// (la stessa condizione di ruoli-regole.mjs, che quelle relazioni non le sposta
// mai). `rel` è l'alias di pg_class: per colonne, vincoli e indici quello della
// tabella, perché da soli non sono membri di niente e seguono lei.
const diEstensione = (rel) => `EXISTS (SELECT 1 FROM pg_depend e
                    WHERE e.classid = 'pg_class'::regclass AND e.objid = ${rel}.oid AND e.deptype = 'e')`;

/** Legge il catalogo da un client `pg` già connesso. */
export async function leggiCatalogo(client) {
  const q = async (sql) => (await client.query(sql, [SCHEMI])).rows;

  const colonne = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, a.attname AS colonna,
           format_type(a.atttypid, a.atttypmod) AS tipo, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS predefinito, a.attidentity AS identita, a.attgenerated AS generata,
           ${diEstensione("c")} AS estensione
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = ANY($1) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped`);
  const vincoli = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, k.conname AS nome, k.contype AS tipo,
           pg_get_constraintdef(k.oid) AS definizione, ${diEstensione("c")} AS estensione
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND k.contype <> 'n'`);
  const indici = await q(`
    SELECT n.nspname AS schema, t.relname AS tabella, i.relname AS nome, pg_get_indexdef(i.oid) AS definizione,
           ${diEstensione("t")} AS estensione
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = ANY($1)`);
  const viste = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, pg_get_viewdef(c.oid, true) AS definizione,
           ${diEstensione("c")} AS estensione
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1) AND c.relkind IN ('v','m')`);
  const sequenze = await q(`
    SELECT n.nspname AS schema, c.relname AS tabella, format_type(s.seqtypid, NULL) AS tipo,
           s.seqstart::text AS inizio, s.seqincrement::text AS passo, ${diEstensione("c")} AS estensione
      FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1)`);
  return catalogoDalleRighe({ colonne, vincoli, indici, viste, sequenze });
}

/**
 * Il catalogo dalle righe lette (puro). Restano fuori quello che non è di
 * Cerbero: le tabelle di ESCLUSE e le relazioni di un'estensione (`estensione`),
 * con le loro colonne, i loro vincoli e i loro indici. In produzione PostGIS
 * mette in public spatial_ref_sys, con la sua chiave e un CHECK, e le viste
 * geography_columns e geometry_columns; lo schema atteso (meta/catalogo.json)
 * nasce da un database senza estensioni, e il confronto le dava per differenze.
 */
export function catalogoDalleRighe({ colonne = [], vincoli = [], indici = [], viste = [], sequenze = [] }) {
  const escluse = new Set(ESCLUSE);
  const nostra = (r) => !r.estensione;
  const ok = (r) => nostra(r) && !escluse.has(`${r.schema}.${r.tabella}`);

  const cat = { tabelle: {}, vincoli: {}, indici: {}, viste: {}, sequenze: {} };
  for (const r of colonne.filter(ok)) {
    const t = (cat.tabelle[`${r.schema}.${r.tabella}`] ??= {});
    t[r.colonna] = [r.tipo, r.not_null ? "not null" : "null", r.predefinito ?? "", r.identita || "", r.generata || ""].join(" | ");
  }
  for (const r of vincoli.filter(ok)) cat.vincoli[`${r.schema}.${r.tabella}.${r.nome}`] = r.definizione;
  for (const r of indici.filter(ok)) cat.indici[`${r.schema}.${r.nome}`] = r.definizione;
  for (const r of viste.filter(nostra)) cat.viste[`${r.schema}.${r.tabella}`] = r.definizione.trim();
  for (const r of sequenze.filter(nostra)) cat.sequenze[`${r.schema}.${r.tabella}`] = `${r.tipo} da ${r.inizio} passo ${r.passo}`;
  return ordina(cat);
}

function ordina(x) {
  if (Array.isArray(x) || x === null || typeof x !== "object") return x;
  return Object.fromEntries(Object.keys(x).sort().map((k) => [k, ordina(x[k])]));
}

/** Differenze fra due cataloghi: [{dove, chiave, a, b}], vuoto se uguali. */
export function confronta(a, b) {
  const diff = [];
  for (const sezione of Object.keys({ ...a, ...b })) {
    const sa = a[sezione] ?? {}, sb = b[sezione] ?? {};
    for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const va = sa[k], vb = sb[k];
      if (sezione === "tabelle" && va && vb) {
        for (const c of new Set([...Object.keys(va), ...Object.keys(vb)])) {
          if (va[c] !== vb[c]) diff.push({ dove: sezione, chiave: `${k}.${c}`, a: va[c] ?? null, b: vb[c] ?? null });
        }
      } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
        diff.push({ dove: sezione, chiave: k, a: va ?? null, b: vb ?? null });
      }
    }
  }
  return diff;
}

/**
 * Una differenza come la stampa --confronta. Una tabella presente da una parte
 * sola porta in `a` o in `b` l'oggetto delle sue colonne: se ne scrivono i nomi
 * (interpolato in una stringa sarebbe «[object Object]»).
 */
export function descriviDifferenza(d) {
  const valore = (v) => {
    if (v === null || v === undefined) return "—";
    if (typeof v !== "object") return String(v);
    const colonne = Object.keys(v);
    if (!colonne.length) return "tabella senza colonne";
    return `tabella con ${colonne.length === 1 ? "una colonna" : `${colonne.length} colonne`}: ${colonne.join(", ")}`;
  };
  return `${d.dove}  ${d.chiave}\n   a: ${valore(d.a)}\n   b: ${valore(d.b)}`;
}

const avviatoDaRiga = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (avviatoDaRiga) {
  if (process.argv[2] === "--confronta") {
    const [a, b] = process.argv.slice(3).map((f) => JSON.parse(readFileSync(f, "utf8")));
    const diff = confronta(a, b);
    for (const d of diff) console.log(descriviDifferenza(d));
    console.error(diff.length ? `${diff.length} differenze` : "cataloghi uguali");
    process.exit(diff.length ? 1 : 0);
  }
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL_NO_VERIFY === "1" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    process.stdout.write(JSON.stringify(await leggiCatalogo(client), null, 1) + "\n");
  } finally {
    await client.end();
  }
}
