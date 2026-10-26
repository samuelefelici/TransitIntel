// Regole pure del runner delle migrazioni (lib/db/scripts/migra.mjs), senza
// database: così si provano con vitest.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Schema e tabella di tracciamento. MAI il default di drizzle
 * (`drizzle.__drizzle_migrations`): lo usa FleetCare sullo stesso database, e
 * drizzle guarda solo il `created_at` dell'ultima riga, quindi i due prodotti
 * si salterebbero le migrazioni a vicenda.
 */
export const TRACCIAMENTO = Object.freeze({ migrationsSchema: "cerbero_migrazioni", migrationsTable: "__drizzle_migrations" });

/** Chiave del lucchetto consultivo: diversa da quella dell'anagrafica (7_331_015). */
export const CHIAVE_LUCCHETTO = 7_331_100;

/** Il diario con l'impronta di ogni file, calcolata come la calcola drizzle (sha256 del testo). */
export function leggiDiario(cartella) {
  const diario = JSON.parse(readFileSync(path.join(cartella, "meta/_journal.json"), "utf8"));
  return diario.entries.map((e) => {
    const testo = readFileSync(path.join(cartella, `${e.tag}.sql`), "utf8");
    return { ...e, impronta: createHash("sha256").update(testo).digest("hex") };
  });
}

/**
 * Confronta il diario con le righe già applicate ({hash, created_at}).
 * - Una migrazione applicata il cui file è cambiato: errore (le migrazioni
 *   rilasciate non si toccano; se serve, se ne scrive una nuova).
 * - Una voce del diario non applicata ma più vecchia dell'ultima applicata:
 *   errore. drizzle guarda solo l'ultimo created_at e la salterebbe in
 *   silenzio (succede con un'immagine costruita da un ramo rimasto indietro).
 * - Righe applicate che il diario non conosce: è il codice N-1 durante un
 *   deploy a rotazione o un ritorno all'immagine precedente. Si avvisa e si
 *   prosegue, perché le migrazioni devono restare compatibili all'indietro.
 */
export function controllaApplicate(diario, applicate) {
  const perQuando = new Map(diario.map((e) => [Number(e.when), e]));
  const quandoApplicate = new Set(applicate.map((r) => Number(r.created_at)));
  const ultima = Math.max(0, ...quandoApplicate);
  const errori = [];
  const sconosciute = [];
  for (const r of applicate) {
    const e = perQuando.get(Number(r.created_at));
    if (!e) sconosciute.push(Number(r.created_at));
    else if (e.impronta !== r.hash) errori.push(`${e.tag}: il file è cambiato dopo essere stato applicato`);
  }
  for (const e of diario) {
    if (Number(e.when) < ultima && !quandoApplicate.has(Number(e.when))) {
      errori.push(`${e.tag}: non è applicata ma è più vecchia dell'ultima applicata, e drizzle la salterebbe. Dalle un \`when\` più recente dell'ultima applicata`);
    }
  }
  return { errori, sconosciute };
}

/** L'errore da mostrare nel log: quello di Postgres, che drizzle tiene in `cause`, non il testo SQL. */
export function descriviErrore(err) {
  const c = err?.cause ?? err;
  const parti = [c?.message ?? String(c)];
  if (c?.code) parti.push(`(codice ${c.code})`);
  if (c?.detail) parti.push(`— ${c.detail}`);
  if (c?.hint) parti.push(`— suggerimento: ${c.hint}`);
  const query = typeof err?.query === "string" ? err.query.replace(/\s+/g, " ").trim() : "";
  return { motivo: parti.join(" "), query: query ? query.slice(0, 240) + (query.length > 240 ? "…" : "") : "" };
}

/** Le voci del diario che drizzle applicherà: quelle più recenti dell'ultima riga. */
export function daApplicare(diario, applicate) {
  const ultima = Math.max(0, ...applicate.map((r) => Number(r.created_at)));
  return diario.filter((e) => Number(e.when) > ultima);
}

/**
 * Errori per cui ha senso riprovare: lucchetto non ottenuto entro lock_timeout,
 * oppure due GRANT/REVOKE sulla stessa tabella nello stesso istante (Postgres
 * risponde «tuple concurrently updated», codice XX000). Il migrator di drizzle
 * avvolge l'errore di pg (DrizzleQueryError): il codice sta in `cause`.
 */
export function ritentabile(err) {
  const e = err?.code ? err : err?.cause;
  if (e?.code === "55P03") return true;
  return e?.code === "XX000" && /tuple concurrently updated/.test(String(e?.message));
}
