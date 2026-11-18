/**
 * I nodi di scambio dell'azienda sul database (tappa 6.16, tabella
 * nodi_scambio): lettura con la memoria di un minuto, e le scritture
 * dell'amministratore. Le regole stanno in lib/nodi-scambio.ts.
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  hubDellAnalisi, comeHub, MASSIMO_NODI, MASSIMO_ORARI_PER_RIGA, MASSIMO_RIGHE_ORARI, orariInOrdine, orarioNormale, TIPI_NODO,
  type HubDelNodo, type NodoDiScambio, type TipoNodo,
} from "./nodi-scambio";

const righe = (r: any): any[] => r?.rows ?? r ?? [];

const corse = (v: unknown): NodoDiScambio["arrivi"] =>
  (Array.isArray(v) ? v : []).filter((c: any) => c && typeof c.luogo === "string" && Array.isArray(c.orari))
    .map((c: any) => ({ luogo: c.luogo, orari: c.orari.map(String) }));

const nodoDa = (r: any): NodoDiScambio => ({
  nodo: String(r.nodo), nome: String(r.nome), tipo: r.tipo as TipoNodo, lat: Number(r.lat), lng: Number(r.lng),
  fermateGtfs: Array.isArray(r.fermate_gtfs) ? r.fermate_gtfs.map(String) : [],
  minutiAPiedi: Number(r.minuti_a_piedi ?? 0), descrizione: String(r.descrizione ?? ""),
  arrivi: corse(r.arrivi), partenze: corse(r.partenze), ordine: Number(r.ordine ?? 0),
});

const COLONNE = sql`nodo, nome, tipo, lat, lng, fermate_gtfs, minuti_a_piedi, descrizione, arrivi, partenze, ordine`;

/* ── Lettura, con la memoria di un minuto ─────────────────────────────────── */

const DURATA_MS = 60_000;
let inMemoria: { nodi: NodoDiScambio[]; lettoIl: number } | null = null;

/** I nodi in ordine. Se il database non risponde vale l'ultima lettura; senza, l'errore sale. */
export async function leggiNodi(): Promise<NodoDiScambio[]> {
  if (inMemoria && Date.now() - inMemoria.lettoIl < DURATA_MS) return inMemoria.nodi;
  try {
    const nodi = righe(await db.execute(sql`SELECT ${COLONNE} FROM nodi_scambio ORDER BY ordine, nodo`)).map(nodoDa);
    inMemoria = { nodi, lettoIl: Date.now() };
    return nodi;
  } catch (e) {
    if (inMemoria) return inMemoria.nodi;
    throw e;
  }
}

/** Fa rileggere i nodi alla prossima richiesta (dopo un salvataggio, e nei test). */
export function dimenticaNodi(): void { inMemoria = null; }

/** Tutti i nodi, come hub: le zone di coincidenza, l'ottimizzatore, il confronto fra programmi. */
export async function hubDeiNodi(): Promise<HubDelNodo[]> { return (await leggiNodi()).map(comeHub); }

/** I nodi che l'analisi intermodale considera (stazioni, porti, aeroporti), come hub. */
export async function hubDellAnalisiIntermodale(): Promise<HubDelNodo[]> { return hubDellAnalisi(await leggiNodi()); }

/* ── L'amministratore ─────────────────────────────────────────────────────── */

export class RifiutoNodi extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const SENZA_CONTROLLO = /^[^\u0000-\u001f\u007f]*$/;
const testo = (max: number, min = 1) => z.string().transform((s) => s.trim()).pipe(
  z.string().min(min, "non può essere vuoto").max(max, `al più ${max} caratteri`).regex(SENZA_CONTROLLO, "senza caratteri di controllo"));

const Orario = z.string().transform((s, ctx) => {
  const o = orarioNormale(s);
  if (!o) { ctx.addIssue({ code: "custom", message: `«${s}» non è un orario: si scrive HH:MM, da 00:00 a 47:59` }); return z.NEVER; }
  return o;
});
const Riga = z.object({
  luogo: testo(80).pipe(z.string().regex(/^[^:]*$/, "il luogo non può contenere i due punti")),
  orari: z.array(Orario).min(1, "ogni riga ha almeno un orario").max(MASSIMO_ORARI_PER_RIGA, `al più ${MASSIMO_ORARI_PER_RIGA} orari per riga`)
    .transform(orariInOrdine),
}).strict();
const Righe = z.array(Riga).max(MASSIMO_RIGHE_ORARI, `al più ${MASSIMO_RIGHE_ORARI} righe`).default([]);

export const IDENTIFICATIVO_NODO = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Un nodo da salvare. L'identificativo si scrive solo creandolo: è quello che le zone di coincidenza ricordano. */
export const DatiNodo = z.object({
  nome: testo(120),
  tipo: z.enum(TIPI_NODO),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  fermateGtfs: z.array(z.string().trim().min(1).max(64).regex(/^[^\s,;]+$/, "un codice di fermata è senza spazi, virgole e punti e virgola"))
    .max(50, "al più 50 fermate").default([]).transform((f) => [...new Set(f)]),
  minutiAPiedi: z.number().int().min(0).max(60).default(2),
  descrizione: testo(300, 0).default(""),
  arrivi: Righe,
  partenze: Righe,
  ordine: z.number().int().min(0).max(99_999).default(0),
}).strict();
export const NuovoNodo = DatiNodo.extend({
  nodo: z.string().trim().regex(IDENTIFICATIVO_NODO, "identificativo: da 2 a 40 fra lettere minuscole, cifre e trattini, come «stazione-centrale»")
    .refine((n) => !/^(gtfs|synthetic)-/.test(n), "identificativo: «gtfs-» e «synthetic-» sono dei nodi che l'analisi trova da sola"),
}).strict();

export interface NodoConZone extends NodoDiScambio {
  /** le zone di coincidenza che ricordano questo nodo: prendono da lui gli orari, se non hanno i loro */
  zone: number;
}

/** L'elenco per la pagina dell'amministratore, senza memoria. */
export async function elencoNodi(): Promise<{ nodi: NodoConZone[]; massimo: number }> {
  dimenticaNodi();
  const nodi = await leggiNodi();
  const zone = new Map(righe(await db.execute(sql`
    SELECT hub_id, count(*)::int AS n FROM coincidence_zones GROUP BY hub_id`)).map((r) => [String(r.hub_id), Number(r.n)]));
  return { nodi: nodi.map((n) => ({ ...n, zone: zone.get(n.nodo) ?? 0 })), massimo: MASSIMO_NODI };
}

/**
 * Un elenco di testi come letterale di array di Postgres, in un parametro solo
 * (drizzle spargerebbe un array JS in tanti parametri). I codici delle fermate
 * non hanno spazi, virgole né punti e virgola (la validazione); virgolette e
 * barre si proteggono lo stesso.
 */
const arrayDiTesti = (v: readonly string[]) => `{${v.map((x) => `"${x.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(",")}}`;

const valori = (n: z.infer<typeof DatiNodo>) => sql`
  ${n.nome}::text, ${n.tipo}::text, ${n.lat}::float8, ${n.lng}::float8, ${arrayDiTesti(n.fermateGtfs)}::text[], ${n.minutiAPiedi}::smallint,
  ${n.descrizione}::text, ${JSON.stringify(n.arrivi)}::jsonb, ${JSON.stringify(n.partenze)}::jsonb, ${n.ordine}::integer`;

export async function creaNodo(n: z.infer<typeof NuovoNodo>): Promise<NodoDiScambio> {
  try {
    const r = righe(await db.execute(sql`
      INSERT INTO nodi_scambio (nodo, nome, tipo, lat, lng, fermate_gtfs, minuti_a_piedi, descrizione, arrivi, partenze, ordine)
      SELECT ${n.nodo}::text, ${valori(n)}
       WHERE (SELECT count(*) FROM nodi_scambio) < ${MASSIMO_NODI}::integer
      RETURNING ${COLONNE}`));
    if (!r.length) throw new RifiutoNodi(409, `I nodi sono già ${MASSIMO_NODI}, il massimo`);
    dimenticaNodi();
    return nodoDa(r[0]);
  } catch (e) {
    const pg = (e as any)?.cause ?? e;
    if (pg?.code === "23505") throw new RifiutoNodi(409, `C'è già un nodo «${n.nodo}»`);
    throw e;
  }
}

export async function modificaNodo(nodo: string, n: z.infer<typeof DatiNodo>): Promise<NodoDiScambio> {
  const r = righe(await db.execute(sql`
    UPDATE nodi_scambio
       SET (nome, tipo, lat, lng, fermate_gtfs, minuti_a_piedi, descrizione, arrivi, partenze, ordine) = (${valori(n)}),
           aggiornato_il = now()
     WHERE nodo = ${nodo}
    RETURNING ${COLONNE}`));
  if (!r.length) throw new RifiutoNodi(404, "Nodo non trovato");
  dimenticaNodi();
  return nodoDa(r[0]);
}

/**
 * Toglie un nodo. Le zone di coincidenza che lo ricordano restano com'erano
 * (nome, posizione e fermate sono loro): perdono solo gli orari di riserva,
 * se non ne hanno di loro.
 */
export async function cancellaNodo(nodo: string): Promise<void> {
  const r = righe(await db.execute(sql`DELETE FROM nodi_scambio WHERE nodo = ${nodo} RETURNING nodo`));
  if (!r.length) throw new RifiutoNodi(404, "Nodo non trovato");
  dimenticaNodi();
}
