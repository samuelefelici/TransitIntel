/**
 * Le variazioni decise in anticipo (tappa 4.10; migrazione 0031).
 *
 * Una giornata si ricostruisce fino al suo inizio e il giornale si scrive
 * solo da lì: quello che si sa prima sta qui, per giorno.
 *
 *   soppressione  le corse da sopprimere: di alcune linee e/o con certi
 *                 numeri di corsa, eventualmente in una fascia oraria sulla
 *                 partenza. Al congelamento diventano esiti «soppressa» del
 *                 giornale, a nome di chi le ha scritte
 *                 (lib/esercizio-variazioni-applica.ts);
 *   sciopero      le fasce garantite (e le linee, se non tutte). Le corse
 *                 che partono fuori fascia non si sopprimono in anticipo (non
 *                 si sa chi aderirà): la proposta dall'AVM le dà come
 *                 «soppressione probabile» invece che «non rilevate», e la
 *                 presunzione di effettuazione non le tocca.
 *
 * Fasce sulla partenza, [dalle, alle): una corsa che parte alle 09:00 con la
 * fascia 06:00–09:00 è fuori. Gli orari possono andare oltre le 24, come nel
 * GTFS. Una corsa senza orario di partenza non è mai toccata.
 *
 * Una variazione si annulla, con chi e quando, finché la giornata non è
 * cominciata e la variazione non è applicata; dopo si corregge nel giornale.
 * Le scrive una persona: i token di servizio leggono e basta (routes).
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { giornataOggi, inizioDi } from "./service-day";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
/* «HH:MM[:SS]» in secondi, anche oltre le 24 (come in lib/esercizio-proposta.ts, che importa da qui) */
const secondi = (t: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : null;
};
const testo = (max: number) => z.string().trim().min(1).max(max);
/** HH:MM, anche oltre le 24 (fino alle 27:59, la fine della giornata di esercizio). */
const ORA = z.string().trim().regex(/^([01]?\d|2[0-7]):[0-5]\d$/, "orario HH:MM");
const GIORNO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "giorno AAAA-MM-GG");
/** Al più quanti giorni avanti si scrive una variazione. */
export const GIORNI_AVANTI = 400;

export const VARIAZIONE = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("soppressione"), giorno: GIORNO,
    linee: z.array(testo(40)).max(200).default([]), numeri: z.array(testo(40)).max(2000).default([]),
    dalle: ORA.optional(), alle: ORA.optional(), causale: testo(30), nota: testo(500).optional(),
  }).strict(),
  z.object({
    tipo: z.literal("sciopero"), giorno: GIORNO,
    linee: z.array(testo(40)).max(200).default([]),
    fasce: z.array(z.object({ dalle: ORA, alle: ORA }).strict()).min(1).max(6),
    causale: testo(30).default("SCIOPERO"), nota: testo(500).optional(),
  }).strict(),
]);
export type Variazione = z.infer<typeof VARIAZIONE>;

export class RifiutoVariazione extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const prima = (dalle: string, alle: string) => secondi(dalle)! < secondi(alle)!;

/** La variazione, o il primo errore in parole. */
export function leggiVariazione(corpo: unknown): { variazione: Variazione } | { errore: string } {
  const r = VARIAZIONE.safeParse(corpo);
  if (!r.success) {
    const p = r.error.issues[0];
    return { errore: `${p?.path.join(".") || "variazione"}: ${p?.message ?? "non valida"}` };
  }
  const v = r.data;
  if (Number.isNaN(Date.parse(`${v.giorno}T12:00:00Z`)) || new Date(`${v.giorno}T12:00:00Z`).toISOString().slice(0, 10) !== v.giorno) {
    return { errore: "giorno: una data vera" };
  }
  if (v.tipo === "soppressione") {
    /* una giornata intera soppressa per sbaglio è un danno: servono linee o numeri */
    if (!v.linee.length && !v.numeri.length) return { errore: "Una soppressione dice le linee o i numeri di corsa" };
    if ((v.dalle == null) !== (v.alle == null)) return { errore: "La fascia vuole dalle e alle" };
    if (v.dalle && v.alle && !prima(v.dalle, v.alle)) return { errore: "La fascia: dalle viene prima di alle" };
  } else if (v.fasce.some((f) => !prima(f.dalle, f.alle))) {
    return { errore: "Ogni fascia garantita: dalle viene prima di alle" };
  }
  return { variazione: v };
}

/* ── Quali corse tocca (puro) ────────────────────────────────────────────── */

export interface RegolaVariazione {
  tipo: "soppressione" | "sciopero";
  linee: string[]; numeri: string[];
  dalle: string | null; alle: string | null;
  fasce: Array<{ dalle: string; alle: string }> | null;
}
export interface CorsaPerVariazione { chiave: string; linea: string | null; numero: string; partenza: string | null; origine: string }

const dentro = (s: number, dalle: string, alle: string) => s >= secondi(dalle)! && s < secondi(alle)!;

/**
 * Vero se la variazione tocca la corsa: per una soppressione, la corsa da
 * sopprimere; per uno sciopero, la corsa che parte fuori dalle fasce garantite.
 * Solo le corse del programmato: le aggiunte sono decise nel giornale.
 */
export function toccata(v: RegolaVariazione, c: CorsaPerVariazione): boolean {
  if (c.origine !== "programmata") return false;
  const linea = (c.linea ?? "").trim();
  if (v.linee.length && !v.linee.includes(linea)) return false;
  const s = secondi(c.partenza);
  if (v.tipo === "soppressione") {
    if (v.numeri.length && !v.numeri.includes(String(c.numero).trim())) return false;
    if (v.dalle && v.alle) return s != null && dentro(s, v.dalle, v.alle);
    return true;
  }
  return s != null && !(v.fasce ?? []).some((f) => dentro(s, f.dalle, f.alle));
}

/* ── Dal database ────────────────────────────────────────────────────────── */

const regola = (x: any): RegolaVariazione => ({
  tipo: x.tipo, linee: x.linee ?? [], numeri: x.numeri ?? [], dalle: x.dalle ?? null, alle: x.alle ?? null,
  fasce: Array.isArray(x.fasce) ? x.fasce : null,
});

/** Le corse della giornata, per le regole delle variazioni (ex: una transazione o db). */
export async function corsePerVariazioni(ex: any, giorno: string, soloDaDecidere = false): Promise<CorsaPerVariazione[]> {
  return righe(await ex.execute(sql`
    SELECT chiave, linea, numero, partenza, origine FROM esercizio_corse
     WHERE giorno = ${giorno}::date ${soloDaDecidere ? sql`AND esito IS NULL` : sql``}`)).map((c) => ({
    chiave: String(c.chiave), linea: c.linea ?? null, numero: String(c.numero), partenza: c.partenza ?? null, origine: String(c.origine),
  }));
}

/**
 * Le corse della giornata che partono fuori dalle fasce garantite di uno
 * sciopero (non annullato). Vuoto se quel giorno non c'è sciopero.
 */
export async function corseInSciopero(ex: any, giorno: string): Promise<Set<string>> {
  const scioperi = righe(await ex.execute(sql`
    SELECT tipo, linee, numeri, dalle, alle, fasce FROM esercizio_variazioni
     WHERE giorno = ${giorno}::date AND tipo = 'sciopero' AND annullata_il IS NULL`)).map(regola);
  if (!scioperi.length) return new Set();
  const corse = await corsePerVariazioni(ex, giorno);
  return new Set(corse.filter((c) => scioperi.some((v) => toccata(v, c))).map((c) => c.chiave));
}

/** Le variazioni da `dal` ad `al`, con chi le ha scritte, lo stato e le corse (toccate o, se la giornata c'è, previste). */
export async function elencoVariazioni(dal: string, al: string) {
  const v = righe(await db.execute(sql`
    SELECT v.id, v.giorno::text AS giorno, v.tipo, v.linee, v.numeri, v.dalle, v.alle, v.fasce, v.causale, k.descrizione AS causale_descrizione,
           v.nota, COALESCE(c.full_name, c.email) AS creata_da, v.creata_il, COALESCE(a.full_name, a.email) AS annullata_da, v.annullata_il,
           v.applicata_il, v.evento, v.corse, g.stato AS stato_giornata, now() < ${inizioDi(sql`v.giorno`)} AS prima_dell_inizio
      FROM esercizio_variazioni v
      LEFT JOIN esercizio_causali k ON k.codice = v.causale
      LEFT JOIN users c ON c.id = v.creata_da
      LEFT JOIN users a ON a.id = v.annullata_da
      LEFT JOIN esercizio_giornate g ON g.giorno = v.giorno
     WHERE v.giorno BETWEEN ${dal}::date AND ${al}::date
     ORDER BY v.giorno, v.id`));
  /* le corse previste, per le variazioni in attesa di una giornata già preparata */
  const corseDi = new Map<string, CorsaPerVariazione[]>();
  for (const x of v) {
    if (x.applicata_il || x.annullata_il || !x.stato_giornata || corseDi.has(x.giorno)) continue;
    corseDi.set(x.giorno, await corsePerVariazioni(db, x.giorno));
  }
  return v.map((x) => {
    const stato = x.annullata_il ? "annullata" : x.applicata_il ? "applicata" : "in_attesa";
    const corse = corseDi.get(x.giorno);
    return {
      id: Number(x.id), giorno: String(x.giorno).slice(0, 10), tipo: x.tipo as "soppressione" | "sciopero",
      linee: x.linee ?? [], numeri: x.numeri ?? [], dalle: x.dalle ?? null, alle: x.alle ?? null, fasce: x.fasce ?? null,
      causale: x.causale, causaleDescrizione: x.causale_descrizione ?? null, nota: x.nota ?? null,
      creataDa: x.creata_da ?? null, creataIl: new Date(x.creata_il).toISOString(),
      annullataDa: x.annullata_da ?? null, annullataIl: x.annullata_il ? new Date(x.annullata_il).toISOString() : null,
      applicataIl: x.applicata_il ? new Date(x.applicata_il).toISOString() : null, evento: x.evento == null ? null : Number(x.evento),
      stato,
      /* applicata: le corse toccate; in attesa con la giornata preparata: quelle che toccherebbe oggi */
      corse: x.corse != null ? Number(x.corse) : stato === "in_attesa" && corse ? corse.filter((c) => toccata(regola(x), c)).length : null,
      annullabile: stato === "in_attesa" && !!x.prima_dell_inizio,
    };
  });
}

/** Scrive una variazione. Non la applica: lo fa chi chiama, se la giornata è già cominciata. */
export async function creaVariazione(v: Variazione, autore: { id: string | null }, oggi: string = giornataOggi()) {
  const limite = new Date(`${oggi}T12:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() + GIORNI_AVANTI);
  if (v.giorno < oggi) throw new RifiutoVariazione(400, "Una variazione si scrive per oggi o per i giorni che vengono: il passato si corregge nel giornale");
  if (v.giorno > limite.toISOString().slice(0, 10)) throw new RifiutoVariazione(400, `Al più ${GIORNI_AVANTI} giorni avanti`);
  return db.transaction(async (tx) => {
    const ex = tx as any;
    const c = righe(await ex.execute(sql`SELECT attiva FROM esercizio_causali WHERE codice = ${v.causale}`))[0];
    if (!c) throw new RifiutoVariazione(400, "Causale sconosciuta");
    if (!c.attiva) throw new RifiutoVariazione(400, "Causale non più attiva");
    const g = righe(await ex.execute(sql`SELECT stato FROM esercizio_giornate WHERE giorno = ${v.giorno}::date`))[0];
    if (g?.stato === "chiusa") throw new RifiutoVariazione(409, "Giornata chiusa: non si scrive più");
    const r = righe(await ex.execute(sql`
      INSERT INTO esercizio_variazioni (giorno, tipo, linee, numeri, dalle, alle, fasce, causale, nota, creata_da)
      VALUES (${v.giorno}::date, ${v.tipo},
              ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(v.linee)}::jsonb))::text[],
              ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(v.tipo === "soppressione" ? v.numeri : [])}::jsonb))::text[],
              ${v.tipo === "soppressione" ? v.dalle ?? null : null}, ${v.tipo === "soppressione" ? v.alle ?? null : null},
              ${v.tipo === "sciopero" ? JSON.stringify(v.fasce) : null}::jsonb,
              ${v.causale}, ${v.nota ?? null}, ${autore.id}::uuid)
      RETURNING id`))[0];
    return { id: Number(r.id), giornataCominciata: g?.stato === "congelata" };
  });
}

/** Annulla una variazione in attesa, prima che la sua giornata cominci. */
export async function annullaVariazione(id: number, autore: { id: string | null }) {
  return db.transaction(async (tx) => {
    const ex = tx as any;
    const v = righe(await ex.execute(sql`
      SELECT annullata_il, applicata_il, now() < ${inizioDi(sql`giorno`)} AS prima_dell_inizio
        FROM esercizio_variazioni WHERE id = ${id} FOR UPDATE`))[0];
    if (!v) throw new RifiutoVariazione(404, "Variazione non trovata");
    if (v.annullata_il) throw new RifiutoVariazione(409, "Variazione già annullata");
    if (v.applicata_il || !v.prima_dell_inizio) {
      throw new RifiutoVariazione(409, "La giornata è cominciata: la variazione non si annulla più, si corregge nel giornale");
    }
    await ex.execute(sql`UPDATE esercizio_variazioni SET annullata_il = now(), annullata_da = ${autore.id}::uuid WHERE id = ${id}`);
    return { id };
  });
}
