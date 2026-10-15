/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RIPOSI E SOVRAPPOSIZIONI — la parte che legge il database
 * ───────────────────────────────────────────────────────────────────────────
 * Le regole stanno in roster-normativa.ts. Qui si mettono insieme i turni di
 * un conducente: le assegnazioni (roster_assignments), gli orari di ogni
 * turno (lo snapshot salvato con l'assegnazione, o il turno nel DSS) e se il
 * turno è urbano o extraurbano.
 *
 * Urbano o extraurbano si decide per DSS, in quest'ordine:
 *   1. il tipo scelto sull'Unità di Progettazione del DSS
 *      (DSS → programma di esercizio → progetto di scheduling → UDP);
 *   2. la proposta fatta dalle linee delle corse dell'UDP;
 *   3. il «Tipo di servizio» scelto in Fucina quando si sono calcolati i
 *      turni («misto» vale extraurbano, come fa già lo scheduler);
 *   4. nessuno: il turno conta come extraurbano, con l'avviso.
 *
 * Chi assegna dentro una transazione prepara prima, con `db`, quello che gli
 * serve (preparaControllo): orari e tipi dei turni intorno al giorno. Dentro
 * la transazione si legge solo quello che nel frattempo è cambiato, con la
 * transazione stessa e in un savepoint (Lettore): niente altre connessioni
 * prese dal pool mentre si tengono i blocchi, e una tabella che su
 * un'installazione non c'è non rovina la transazione.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { righe, type Ex } from "./anagrafica-store";
import { eServizio, serviziDelleUdp, type Servizio, type ServizioUdp } from "./udp-servizio";
import {
  chiaveTurno, intervalloDaSnapshot, intervalloTurno, istante, violazioniDeiTurni,
  type ServizioDa, type TurnoNelTempo, type Violazione,
} from "./roster-normativa";

const dbEx = db as unknown as Ex;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Come si legge: con `db`, o dentro una transazione in un savepoint. */
export type Lettore = <T>(f: (ex: Ex) => Promise<T>) => Promise<T>;
export const conDb: Lettore = f => f(dbEx);

/** «Quella tabella o colonna qui non c'è» (installazione senza Planning Studio, colonne aggiunte al primo uso). */
function manca(e: any): boolean {
  const codice = e?.cause?.code ?? e?.code;
  return codice === "42P01" || codice === "42703";
}

/** Un array di testo per Postgres come un solo parametro: {"a","b"}. */
function arrayTesto(xs: string[]): string {
  return `{${xs.map(x => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/** Giorno YYYY-MM-DD spostato di n giorni. */
export function piuGiorni(giorno: string, n: number): string {
  return new Date(Date.parse(`${giorno}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/* ── Colonne che possono mancare ─────────────────────────────────────────── */

/* I moduli di scheduling aggiungono colonne al primo uso (project_id, config):
   si guarda quali ci sono, e si ricontrolla ogni tanto. */
let colonneNote: { quando: number; mappa: Map<string, Set<string>> } | null = null;
async function colonne(leggi: Lettore): Promise<Map<string, Set<string>>> {
  if (colonneNote && Date.now() - colonneNote.quando < 60_000) return colonneNote.mappa;
  const r = righe(await leggi(ex => ex.execute(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN ('driver_shift_scenarios', 'service_program_scenarios', 'scheduling_projects')`)));
  const mappa = new Map<string, Set<string>>();
  for (const x of r) {
    const s = mappa.get(x.table_name) ?? new Set<string>();
    s.add(x.column_name);
    mappa.set(x.table_name, s);
  }
  colonneNote = { quando: Date.now(), mappa };
  return mappa;
}

/* ── Urbano o extraurbano, per DSS ───────────────────────────────────────── */

export interface ServizioDss { servizio: Servizio | null; da: ServizioDa; udp: string | null }

const dichiarato = (v: unknown): Servizio | null =>
  v === "misto" ? "extraurbano" : eServizio(v) ? v : null;

export async function serviziDeiDss(dssIds: string[], leggi: Lettore = conDb): Promise<Map<string, ServizioDss>> {
  const ids = [...new Set(dssIds.filter(id => UUID.test(id)))];
  const out = new Map<string, ServizioDss>(ids.map(id => [id, { servizio: null, da: null, udp: null }]));
  if (!ids.length) return out;
  const col = await colonne(leggi);
  const d = col.get("driver_shift_scenarios") ?? new Set<string>();
  const s = col.get("service_program_scenarios") ?? new Set<string>();
  const sp = col.get("scheduling_projects") ?? new Set<string>();
  if (!d.has("id")) return out;
  const conS = s.has("id") && d.has("service_program_scenario_id");
  /* solo le chiavi che servono, mai la riga intera: il risultato di un DSS pesa megabyte */
  const nullo = sql`NULL::text`;
  const progetto: SQL | null = d.has("project_id") && conS && s.has("project_id") ? sql`COALESCE(d.project_id, s.project_id)`
    : d.has("project_id") ? sql`d.project_id`
      : conS && s.has("project_id") ? sql`s.project_id` : null;
  const conSp = progetto !== null && sp.has("id") && sp.has("validity_unit_id");
  let dss: any[] = [];
  try {
    dss = righe(await leggi(ex => ex.execute(sql`
      SELECT d.id::text AS dss_id,
             ${d.has("config") ? sql`d.config->'bds'->>'serviceType'` : nullo} AS dss_bds,
             ${d.has("config") ? sql`d.config->'crewConfig'->'bds'->>'serviceType'` : nullo} AS dss_crew,
             ${conS && s.has("input") ? sql`s.input->>'serviceType'` : nullo} AS sps_input,
             ${conS && s.has("config") ? sql`s.config->>'serviceType'` : nullo} AS sps_config,
             ${conSp ? sql`sp.validity_unit_id::text` : nullo} AS udp_id
        FROM driver_shift_scenarios d
        ${conS ? sql`LEFT JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id` : sql``}
        ${conSp ? sql`LEFT JOIN scheduling_projects sp ON sp.id = ${progetto}` : sql``}
       WHERE d.id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})`)));
  } catch (e) {
    if (!manca(e)) throw e;
    colonneNote = null;
    return out;
  }
  let udp = new Map<string, ServizioUdp>();
  try { udp = await leggi(ex => serviziDelleUdp(ex, dss.map(x => x.udp_id).filter(Boolean))); }
  catch (e) { if (!manca(e)) throw e; }
  for (const x of dss) {
    const u = x.udp_id ? udp.get(x.udp_id) : undefined;
    const fucina = dichiarato(x.dss_bds) ?? dichiarato(x.dss_crew) ?? dichiarato(x.sps_input) ?? dichiarato(x.sps_config);
    out.set(x.dss_id,
      u?.scelto ? { servizio: u.scelto, da: "udp", udp: u.nome }
        : u?.proposto ? { servizio: u.proposto, da: "linee", udp: u.nome }
          : fucina ? { servizio: fucina, da: "fucina", udp: u?.nome ?? null }
            : { servizio: null, da: null, udp: u?.nome ?? null });
  }
  return out;
}

/* ── Orari dei turni ─────────────────────────────────────────────────────── */

/**
 * I turni del DSS con questi codici, presi dal JSON del risultato senza
 * scaricarlo tutto: la chiave è dss|codice. Il codice è quello del roster
 * (driverId, dutyId, id, o T<posizione>).
 */
export async function turniDelDss(coppie: Array<{ dssId: string; codice: string }>, leggi: Lettore = conDb): Promise<Map<string, any>> {
  const perDss = new Map<string, Set<string>>();
  for (const c of coppie) {
    if (!UUID.test(c.dssId)) continue;
    const s = perDss.get(c.dssId) ?? new Set<string>();
    s.add(c.codice);
    perDss.set(c.dssId, s);
  }
  const out = new Map<string, any>();
  for (const [dssId, codici] of perDss) {
    try {
      const r = righe(await leggi(ex => ex.execute(sql`
        SELECT x.codice, x.turno
          FROM driver_shift_scenarios d
          CROSS JOIN LATERAL (
            SELECT COALESCE(e->>'driverId', e->>'dutyId', e->>'id', 'T' || n) AS codice, e AS turno
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(d.result->'driverShifts') = 'array' THEN d.result->'driverShifts'
                          WHEN jsonb_typeof(d.result->'duties') = 'array' THEN d.result->'duties'
                          ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, n)) x
         WHERE d.id = ${dssId}::uuid AND x.codice = ANY(${arrayTesto([...codici])}::text[])`)));
      for (const x of r) out.set(`${dssId}|${x.codice}`, x.turno);
    } catch (e) { if (!manca(e)) throw e; }
  }
  return out;
}

/** Lo snapshot da salvare con una nuova assegnazione: orari come stringhe e in minuti. */
export function snapshotDa(turno: any): Record<string, unknown> | null {
  if (!turno) return null;
  const intervallo = intervalloTurno(turno);
  return {
    start: turno.nastroStart ?? turno.startTime ?? null,
    end: turno.nastroEnd ?? turno.endTime ?? null,
    startMin: intervallo?.inizio ?? null,
    endMin: intervallo?.fine ?? null,
  };
}

/* ── Turni dei conducenti ────────────────────────────────────────────────── */

export interface RigaTurno {
  id: string | null;
  driver_id: string;
  day: string;
  dss_id: string;
  duty_code: string;
  snapshot: any;
  forzatura?: any;
}

/**
 * Le assegnazioni di questi conducenti fra due giorni compresi. Non contano
 * quelle «da riassegnare»: il giorno è pubblicato ma il loro turno non più
 * (roster-pubblicazione.ts); stanno lì per essere sostituite. Nei giorni
 * passati contano sempre: quel lavoro è stato fatto.
 */
export async function assegnazioniDei(ex: Ex, conducenti: string[], dal: string, al: string): Promise<RigaTurno[]> {
  const ids = [...new Set(conducenti.filter(id => UUID.test(id)))];
  if (!ids.length) return [];
  return righe(await ex.execute(sql`
    SELECT a.id::text, a.driver_id::text, a.day::text AS day, a.dss_id::text, a.duty_code, a.snapshot, a.forzatura
      FROM roster_assignments a
     WHERE a.driver_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
       AND a.day BETWEEN ${dal}::date AND ${al}::date
       AND (a.day < (now() AT TIME ZONE 'Europe/Rome')::date
            OR NOT EXISTS (SELECT 1 FROM roster_turni_pubblicati p WHERE p.day = a.day AND p.sostituita_da IS NULL)
            OR EXISTS (SELECT 1 FROM roster_turni_pubblicati p WHERE p.day = a.day AND p.dss_id = a.dss_id AND p.sostituita_da IS NULL))`))
    .map(x => ({ ...x, day: String(x.day).slice(0, 10) }));
}

/** Solo i minuti salvati nello snapshot (le assegnazioni nuove li hanno). */
function minutiSnapshot(s: any): { inizio: number; fine: number } | null {
  if (!s || typeof s.startMin !== "number" || typeof s.endMin !== "number") return null;
  return intervalloDaSnapshot({ startMin: s.startMin, endMin: s.endMin });
}

/** Orari dei turni (dss|codice → turno del DSS, null se non c'è) e tipi dei DSS già letti. */
export interface Preparato { orari: Map<string, any>; servizi: Map<string, ServizioDss> }
export const nuovoPreparato = (): Preparato => ({ orari: new Map(), servizi: new Map() });

/** Legge quello che manca a `p` per queste righe: orari dei turni senza minuti nello snapshot, tipi dei DSS. */
async function completa(p: Preparato, righeTurni: RigaTurno[], leggi: Lettore, extra: Array<{ dssId: string; codice: string }> = []): Promise<void> {
  const orariMancanti = [
    ...righeTurni.filter(r => minutiSnapshot(r.snapshot) === null).map(r => ({ dssId: r.dss_id, codice: r.duty_code })),
    ...extra,
  ].filter(c => !p.orari.has(`${c.dssId}|${c.codice}`));
  if (orariMancanti.length) {
    const letti = await turniDelDss(orariMancanti, leggi);
    for (const c of orariMancanti) p.orari.set(`${c.dssId}|${c.codice}`, letti.get(`${c.dssId}|${c.codice}`) ?? null);
  }
  const dssMancanti = [...new Set([...righeTurni.map(r => r.dss_id), ...extra.map(c => c.dssId)])].filter(id => !p.servizi.has(id));
  if (dssMancanti.length) {
    for (const [id, s] of await serviziDeiDss(dssMancanti, leggi)) p.servizi.set(id, s);
  }
}

/**
 * Da righe di assegnazione a turni nel tempo: orari dallo snapshot in minuti,
 * altrimenti dal DSS, altrimenti dalle stringhe dello snapshot. Un turno di
 * cui non si sa l'orario non si controlla.
 */
export async function turniNelTempo(righeTurni: RigaTurno[], p: Preparato = nuovoPreparato(), leggi: Lettore = conDb): Promise<TurnoNelTempo[]> {
  await completa(p, righeTurni, leggi);
  const out: TurnoNelTempo[] = [];
  for (const r of righeTurni) {
    const intervallo = minutiSnapshot(r.snapshot)
      ?? intervalloTurno(p.orari.get(`${r.dss_id}|${r.duty_code}`))
      ?? intervalloDaSnapshot(r.snapshot);
    if (!intervallo) continue;
    const s = p.servizi.get(r.dss_id);
    out.push({
      chiave: chiaveTurno(r.dss_id, r.day, r.duty_code),
      assegnazioneId: r.id,
      conducenteId: r.driver_id,
      giorno: r.day,
      codice: r.duty_code,
      dssId: r.dss_id,
      inizio: istante(r.day, intervallo.inizio),
      fine: istante(r.day, intervallo.fine),
      servizio: s?.servizio ?? null,
      servizioDa: s?.da ?? null,
      coppieForzate: Array.isArray(r.forzatura?.coppie) ? r.forzatura.coppie.filter((x: unknown) => typeof x === "string") : [],
    });
  }
  return out;
}

/* ── I controlli ─────────────────────────────────────────────────────────── */

/** Un turno che cambia conducente o che arriva: dove va a finire. */
export interface Cambio {
  /** l'assegnazione che si sposta; null per un turno nuovo */
  id: string | null;
  driverId: string;
  day: string;
  dssId: string;
  dutyCode: string;
  snapshot: any;
}

/* due giorni prima e dopo: un turno arriva a ~27h e il riposo a 9h */
const MARGINE_GIORNI = 2;

const finestra = (giorni: string[]) => {
  const g = [...giorni].sort();
  return { dal: piuGiorni(g[0]!, -MARGINE_GIORNI), al: piuGiorni(g[g.length - 1]!, MARGINE_GIORNI) };
};

/**
 * Prima della transazione, con `db`: le assegnazioni intorno ai giorni, i
 * loro orari e tipi, e quelli dei turni che arrivano. Dentro la transazione
 * si rileggono le assegnazioni sotto blocco e si legge solo il nuovo.
 */
export async function preparaControllo(conducenti: string[], giorni: string[], turni: Array<{ dssId: string; codice: string }>): Promise<Preparato> {
  const p = nuovoPreparato();
  if (!giorni.length) return p;
  const { dal, al } = finestra(giorni);
  await completa(p, await assegnazioniDei(dbEx, conducenti, dal, al), conDb, turni);
  return p;
}

/**
 * Le violazioni che questi cambi creano, sui conducenti che ricevono i turni.
 * Si leggono le assegnazioni intorno ai giorni dei cambi con `ex` (la
 * transazione, dopo aver bloccato i conducenti), si applicano i cambi e si
 * tengono solo le violazioni in cui c'è almeno un turno cambiato: quelle che
 * c'erano già non sono colpa di questo cambio.
 */
export async function violazioniDeiCambi(ex: Ex, cambi: Cambio[], p: Preparato, leggi: Lettore): Promise<Violazione[]> {
  if (!cambi.length) return [];
  const { dal, al } = finestra(cambi.map(c => c.day));
  const righeEsistenti = await assegnazioniDei(ex, cambi.map(c => c.driverId), dal, al);
  const cambiate = new Set(cambi.map(c => chiaveTurno(c.dssId, c.day, c.dutyCode)));
  const spostate = new Set(cambi.map(c => c.id).filter(Boolean));
  const righeDopo: RigaTurno[] = [
    ...righeEsistenti.filter(r => !spostate.has(r.id) && !cambiate.has(chiaveTurno(r.dss_id, r.day, r.duty_code))),
    /* un turno che cambia conducente non porta con sé le forzature di prima */
    ...cambi.map(c => ({ id: c.id, driver_id: c.driverId, day: c.day, dss_id: c.dssId, duty_code: c.dutyCode, snapshot: c.snapshot, forzatura: null })),
  ];
  return violazioniDeiTurni(await turniNelTempo(righeDopo, p, leggi))
    .filter(v => v.turni.some(t => cambiate.has(t.chiave)));
}

/**
 * Le violazioni da mostrare sul tabellone: quelle dei conducenti visibili in
 * cui almeno un turno cade nei giorni visibili.
 */
export async function violazioniDelTabellone(conducenti: string[], dal: string, al: string): Promise<Violazione[]> {
  const righeTurni = await assegnazioniDei(dbEx, conducenti, piuGiorni(dal, -MARGINE_GIORNI), piuGiorni(al, MARGINE_GIORNI));
  return violazioniDeiTurni(await turniNelTempo(righeTurni))
    .filter(v => v.turni.some(t => t.giorno >= dal && t.giorno <= al));
}

/** Il segno lasciato su un'assegnazione forzata: chi, quando, quali regole e quali coppie di turni. */
export function forzaturaDa(userId: string | null, violazioni: Violazione[]) {
  return {
    da: userId,
    il: new Date().toISOString(),
    regole: [...new Set(violazioni.map(v => v.regola))],
    testi: violazioni.map(v => v.testo),
    coppie: violazioni.map(v => v.chiave),
  };
}
