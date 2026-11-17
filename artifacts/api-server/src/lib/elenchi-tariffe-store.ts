/**
 * Gli elenchi di partenza delle tariffe e l'agenzia dei GTFS nel database
 * (migrazione 0043): leggerli, salvarli (rotte /api/admin/elenchi-tariffe) e
 * copiarli in un feed dalla pagina Tariffe. Le regole stanno in
 * lib/elenchi-tariffe.ts.
 */
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  aliasDaTesto, erroriCategorie, erroriSupporti, MASSIMO_CATEGORIE, MASSIMO_SUPPORTI,
  type AgenziaGtfs, type CategoriaCatalogo, type NodoCatalogo, type SupportoCatalogo,
} from "./elenchi-tariffe";

export class RifiutoElenchi extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

type Ex = Pick<typeof db, "execute">;

/* ── Lettura ──────────────────────────────────────────────────────────────── */

export async function categorieCatalogo(ex: Ex = db): Promise<CategoriaCatalogo[]> {
  const r = await ex.execute<any>(sql`SELECT categoria, nome, predefinita, url FROM categorie_catalogo ORDER BY ordine, categoria`);
  return r.rows.map((x) => ({ categoria: String(x.categoria), nome: String(x.nome), predefinita: x.predefinita === true, url: x.url ?? null }));
}

export async function supportiCatalogo(ex: Ex = db): Promise<SupportoCatalogo[]> {
  const r = await ex.execute<any>(sql`SELECT supporto, nome, tipo FROM supporti_catalogo ORDER BY ordine, supporto`);
  return r.rows.map((x) => ({ supporto: String(x.supporto), nome: String(x.nome), tipo: Number(x.tipo) }));
}

/** I nodi tariffari dell'azienda: li copia in un feed la scheda dei nodi della pagina Tariffe. */
export async function nodiCatalogo(ex: Ex = db): Promise<NodoCatalogo[]> {
  const r = await ex.execute<any>(sql`SELECT codice, nome, lat, lon, alias FROM nodi_catalogo ORDER BY ordine, codice`);
  return r.rows.map((x) => ({
    codice: String(x.codice), nome: String(x.nome),
    lat: x.lat == null ? null : Number(x.lat), lon: x.lon == null ? null : Number(x.lon),
    alias: aliasDaTesto(x.alias),
  }));
}

/** L'agenzia dei GTFS, se l'azienda ne ha una a parte. */
export async function agenziaGtfs(ex: Ex = db): Promise<AgenziaGtfs | null> {
  const r = await ex.execute<any>(sql`SELECT agency_id, nome, sito, telefono, email, tariffe_url FROM agenzia_gtfs LIMIT 1`);
  const x = r.rows[0];
  if (!x) return null;
  return {
    agencyId: String(x.agency_id), nome: String(x.nome), sito: String(x.sito),
    telefono: x.telefono ?? null, email: x.email ?? null, tariffeUrl: x.tariffe_url ?? null,
  };
}

export interface ElenchiTariffe {
  categorie: CategoriaCatalogo[];
  supporti: SupportoCatalogo[];
  agenzia: AgenziaGtfs | null;
}

export async function elenchiTariffe(): Promise<ElenchiTariffe> {
  const [categorie, supporti, agenzia] = await Promise.all([categorieCatalogo(), supportiCatalogo(), agenziaGtfs()]);
  return { categorie, supporti, agenzia };
}

/* ── Quello che l'amministratore può salvare ──────────────────────────────── */

/* gli stessi limiti dei vincoli delle tabelle: qui si dice in chiaro che cosa non va */
const ID = (cosa: string) => z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, `${cosa}: lettere minuscole, cifre e trattini bassi, da 2 a 40`);
const NOME = z.string().trim().min(1, "il nome non può essere vuoto").max(120, "il nome ha al più 120 caratteri")
  .regex(/^[^\u0000-\u001f\u007f"]*$/, "il nome non può contenere virgolette né caratteri di controllo");
const URL_HTTP = z.string().trim().regex(/^https?:\/\/[^\s",<>]{1,200}$/, "l'indirizzo comincia con http:// o https://, senza spazi né virgole");
const facoltativo = <T extends z.ZodTypeAny>(tipo: T) =>
  z.preprocess((v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : v), tipo.nullable());

export const Categorie = z.object({
  categorie: z.array(z.object({
    categoria: ID("identificativo della categoria"),
    nome: NOME,
    predefinita: z.boolean(),
    url: facoltativo(URL_HTTP),
  }).strict()).max(MASSIMO_CATEGORIE, `al più ${MASSIMO_CATEGORIE} categorie`),
}).strict();

export const Supporti = z.object({
  supporti: z.array(z.object({
    supporto: ID("identificativo del supporto"),
    nome: NOME,
    tipo: z.number().int().min(0, "il tipo va da 0 a 4").max(4, "il tipo va da 0 a 4"),
  }).strict()).max(MASSIMO_SUPPORTI, `al più ${MASSIMO_SUPPORTI} supporti`),
}).strict();

export const Agenzia = z.object({
  agencyId: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/, "identificativo: solo lettere, cifre e . _ - (al più 40)"),
  nome: NOME,
  sito: URL_HTTP,
  telefono: facoltativo(z.string().trim().regex(/^[0-9+() ./-]{3,40}$/, "telefono: solo cifre, spazi e + ( ) . / -")),
  email: facoltativo(z.string().trim().regex(/^[^\s",<>@]{1,64}@[^\s",<>@]{1,190}$/, "l'indirizzo di posta non è valido")),
  tariffeUrl: facoltativo(URL_HTTP),
}).strict();

/** Il primo messaggio di una validazione fallita, con la riga dell'elenco se c'è. */
export function erroreElenco(e: z.ZodError): string {
  const estranei = e.issues.filter((i) => i.code === "unrecognized_keys").flatMap((i: any) => (i.keys as string[]).map((k) => String(k).slice(0, 40)));
  if (estranei.length) return `Campo non previsto: ${estranei.slice(0, 5).join(", ")}`;
  const i = e.issues[0];
  if (!i) return "Richiesta non valida";
  const riga = typeof i.path[1] === "number" ? `Riga ${i.path[1] + 1}: ` : "";
  return `${riga}${i.message}`;
}

/* ── Salvataggio: l'elenco intero, toccando solo le righe che cambiano ────── */

/** «Non è fra questi»: la colonna è un pezzo di SQL scritto qui, l'elenco passa come un solo parametro, in JSON. */
const nonFra = (colonna: SQL, valori: readonly string[]) =>
  sql`NOT (${colonna} IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify(valori)}::jsonb)))`;
const chiuso = (tx: Ex) => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:elenchi-tariffe'))`);
const ordine = (i: number) => (i + 1) * 10;

export async function salvaCategorie(d: z.infer<typeof Categorie>): Promise<CategoriaCatalogo[]> {
  const lista: CategoriaCatalogo[] = d.categorie.map((c) => ({ categoria: c.categoria, nome: c.nome, predefinita: c.predefinita, url: c.url ?? null }));
  const errori = erroriCategorie(lista);
  if (errori.length) throw new RifiutoElenchi(400, errori[0]!);
  const restano = lista.map((c) => c.categoria);
  await db.transaction(async (tx) => {
    await chiuso(tx);
    /* una categoria che il catalogo dei titoli usa non si toglie: quei titoli resterebbero senza */
    const usate = await tx.execute<any>(sql`
      SELECT c.categoria, count(*)::int AS titoli
        FROM categorie_catalogo c JOIN titoli_catalogo t ON t.categoria = c.categoria
       WHERE ${nonFra(sql`c.categoria`, restano)}
       GROUP BY c.categoria ORDER BY c.categoria LIMIT 1`);
    const u = usate.rows[0];
    if (u) {
      throw new RifiutoElenchi(409, `La categoria «${u.categoria}» è di ${Number(u.titoli) === 1 ? "un titolo" : `${u.titoli} titoli`} del catalogo: prima cambia la categoria di quei titoli.`);
    }
    await tx.execute(sql`DELETE FROM categorie_catalogo WHERE ${nonFra(sql`categoria`, restano)}`);
    /* la predefinita è al più una: prima la perde quella di prima, poi la prende la nuova */
    const predefinita = lista.find((c) => c.predefinita)?.categoria ?? "";
    await tx.execute(sql`UPDATE categorie_catalogo SET predefinita = false WHERE predefinita AND categoria <> ${predefinita}`);
    for (const [i, c] of lista.entries()) {
      await tx.execute(sql`
        INSERT INTO categorie_catalogo (categoria, nome, predefinita, url, ordine)
        VALUES (${c.categoria}, ${c.nome}, ${c.predefinita}, ${c.url}, ${ordine(i)})
        ON CONFLICT (categoria) DO UPDATE SET nome = excluded.nome, predefinita = excluded.predefinita, url = excluded.url, ordine = excluded.ordine
         WHERE (categorie_catalogo.nome, categorie_catalogo.predefinita, categorie_catalogo.url, categorie_catalogo.ordine)
               IS DISTINCT FROM (excluded.nome, excluded.predefinita, excluded.url, excluded.ordine)`);
    }
  });
  return lista;
}

export async function salvaSupporti(d: z.infer<typeof Supporti>): Promise<SupportoCatalogo[]> {
  const lista: SupportoCatalogo[] = d.supporti.map((s) => ({ supporto: s.supporto, nome: s.nome, tipo: s.tipo }));
  const errori = erroriSupporti(lista);
  if (errori.length) throw new RifiutoElenchi(400, errori[0]!);
  const restano = lista.map((s) => s.supporto);
  await db.transaction(async (tx) => {
    await chiuso(tx);
    await tx.execute(sql`DELETE FROM supporti_catalogo WHERE ${nonFra(sql`supporto`, restano)}`);
    for (const [i, s] of lista.entries()) {
      await tx.execute(sql`
        INSERT INTO supporti_catalogo (supporto, nome, tipo, ordine) VALUES (${s.supporto}, ${s.nome}, ${s.tipo}, ${ordine(i)})
        ON CONFLICT (supporto) DO UPDATE SET nome = excluded.nome, tipo = excluded.tipo, ordine = excluded.ordine
         WHERE (supporti_catalogo.nome, supporti_catalogo.tipo, supporti_catalogo.ordine) IS DISTINCT FROM (excluded.nome, excluded.tipo, excluded.ordine)`);
    }
  });
  return lista;
}

export async function salvaAgenzia(d: z.infer<typeof Agenzia>): Promise<AgenziaGtfs> {
  const a: AgenziaGtfs = { agencyId: d.agencyId, nome: d.nome, sito: d.sito, telefono: d.telefono ?? null, email: d.email ?? null, tariffeUrl: d.tariffeUrl ?? null };
  await db.execute(sql`
    INSERT INTO agenzia_gtfs (unica, agency_id, nome, sito, telefono, email, tariffe_url)
    VALUES (true, ${a.agencyId}, ${a.nome}, ${a.sito}, ${a.telefono}, ${a.email}, ${a.tariffeUrl})
    ON CONFLICT (unica) DO UPDATE SET agency_id = excluded.agency_id, nome = excluded.nome, sito = excluded.sito,
      telefono = excluded.telefono, email = excluded.email, tariffe_url = excluded.tariffe_url, aggiornata_il = now()
     WHERE (agenzia_gtfs.agency_id, agenzia_gtfs.nome, agenzia_gtfs.sito, agenzia_gtfs.telefono, agenzia_gtfs.email, agenzia_gtfs.tariffe_url)
           IS DISTINCT FROM (excluded.agency_id, excluded.nome, excluded.sito, excluded.telefono, excluded.email, excluded.tariffe_url)`);
  return a;
}

/** Toglie l'agenzia a parte: da qui nei GTFS delle tariffe figura l'azienda. */
export async function togliAgenzia(): Promise<void> {
  await db.execute(sql`DELETE FROM agenzia_gtfs`);
}

/* ── Copia in un feed, dalla pagina Tariffe ───────────────────────────────── */

/**
 * Le categorie dell'azienda nel feed: quelle che mancano si aggiungono, quelle
 * che ci sono già riprendono nome, pagina e predefinita dell'elenco. Le
 * categorie che il feed ha in più restano.
 */
export async function copiaCategorie(feedId: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO gtfs_rider_categories (feed_id, rider_category_id, rider_category_name, is_default, eligibility_url)
    SELECT ${feedId}::uuid, c.categoria, c.nome, c.predefinita, c.url FROM categorie_catalogo c
    ON CONFLICT (feed_id, rider_category_id) DO UPDATE
       SET rider_category_name = excluded.rider_category_name, is_default = excluded.is_default,
           eligibility_url = excluded.eligibility_url, updated_at = now()`);
  return r.rowCount ?? 0;
}

/** I supporti dell'azienda nel feed, allo stesso modo: chi è spento nel feed resta spento. */
export async function copiaSupporti(feedId: string): Promise<number> {
  const r = await db.execute(sql`
    INSERT INTO gtfs_fare_media (feed_id, fare_media_id, fare_media_name, fare_media_type)
    SELECT ${feedId}::uuid, s.supporto, s.nome, s.tipo FROM supporti_catalogo s
    ON CONFLICT (feed_id, fare_media_id) DO UPDATE
       SET fare_media_name = excluded.fare_media_name, fare_media_type = excluded.fare_media_type, updated_at = now()`);
  return r.rowCount ?? 0;
}
