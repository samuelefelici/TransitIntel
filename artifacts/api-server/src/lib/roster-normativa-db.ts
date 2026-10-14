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
 * Le letture di DSS e UDP usano `db` e non la transazione di chi chiama: non
 * servono blocchi, e una tabella che su un'installazione non c'è (niente
 * Planning Studio) farebbe fallire tutta la transazione.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { righe, type Ex } from "./anagrafica-store";
import { eServizio, serviziDelleUdp, type Servizio, type ServizioUdp } from "./udp-servizio";
import {
  chiaveTurno, giornoEpoca, intervalloDaSnapshot, intervalloTurno, MINUTI_GIORNO, violazioniDeiTurni,
  type ServizioDa, type TurnoNelTempo, type Violazione,
} from "./roster-normativa";

const dbEx = db as unknown as Ex;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un array di testo per Postgres come un solo parametro: {"a","b"}. */
function arrayTesto(xs: string[]): string {
  return `{${xs.map(x => `"${x.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/** Giorno YYYY-MM-DD spostato di n giorni. */
export function piuGiorni(giorno: string, n: number): string {
  return new Date(Date.parse(`${giorno}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/* ── Urbano o extraurbano, per DSS ───────────────────────────────────────── */

export interface ServizioDss { servizio: Servizio | null; da: ServizioDa; udp: string | null }

const dichiarato = (v: unknown): Servizio | null =>
  v === "misto" ? "extraurbano" : eServizio(v) ? v : null;

export async function serviziDeiDss(dssIds: string[]): Promise<Map<string, ServizioDss>> {
  const ids = [...new Set(dssIds.filter(id => UUID.test(id)))];
  const out = new Map<string, ServizioDss>(ids.map(id => [id, { servizio: null, da: null, udp: null }]));
  if (!ids.length) return out;
  const lista = sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
  /* to_jsonb(riga) legge colonne che su qualche installazione possono mancare */
  const campi = sql`
    d.id::text AS dss_id,
    to_jsonb(d)->'config'->'bds'->>'serviceType' AS dss_bds,
    to_jsonb(d)->'config'->'crewConfig'->'bds'->>'serviceType' AS dss_crew,
    to_jsonb(s)->'input'->>'serviceType' AS sps_input,
    to_jsonb(s)->'config'->>'serviceType' AS sps_config`;
  let dss: any[] = [];
  try {
    dss = righe(await dbEx.execute(sql`
      SELECT ${campi}, to_jsonb(sp)->>'validity_unit_id' AS udp_id
        FROM driver_shift_scenarios d
        LEFT JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
        LEFT JOIN scheduling_projects sp
               ON sp.id::text = COALESCE(to_jsonb(d)->>'project_id', to_jsonb(s)->>'project_id')
       WHERE d.id IN (${lista})`));
  } catch {
    /* senza i progetti di scheduling resta quello che si è scelto in Fucina */
    try {
      dss = righe(await dbEx.execute(sql`
        SELECT ${campi}, NULL::text AS udp_id
          FROM driver_shift_scenarios d
          LEFT JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
         WHERE d.id IN (${lista})`));
    } catch { return out; }
  }
  let udp = new Map<string, ServizioUdp>();
  try { udp = await serviziDelleUdp(dbEx, dss.map(x => x.udp_id).filter(Boolean)); } catch { /* niente Planning Studio */ }
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
export async function turniDelDss(coppie: Array<{ dssId: string; codice: string }>): Promise<Map<string, any>> {
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
      const r = righe(await dbEx.execute(sql`
        SELECT x.codice, x.turno
          FROM driver_shift_scenarios d
          CROSS JOIN LATERAL (
            SELECT COALESCE(e->>'driverId', e->>'dutyId', e->>'id', 'T' || n) AS codice, e AS turno
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(d.result->'driverShifts') = 'array' THEN d.result->'driverShifts'
                          WHEN jsonb_typeof(d.result->'duties') = 'array' THEN d.result->'duties'
                          ELSE '[]'::jsonb END) WITH ORDINALITY AS t(e, n)) x
         WHERE d.id = ${dssId}::uuid AND x.codice = ANY(${arrayTesto([...codici])}::text[])`));
      for (const x of r) out.set(`${dssId}|${x.codice}`, x.turno);
    } catch { /* DSS illeggibile: quei turni non si controllano */ }
  }
  return out;
}

/** Lo snapshot da salvare con una nuova assegnazione: orari come stringhe e in minuti. */
export async function snapshotDelTurno(dssId: string, codice: string): Promise<Record<string, unknown> | null> {
  const turno = (await turniDelDss([{ dssId, codice }])).get(`${dssId}|${codice}`);
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

/** Le assegnazioni di questi conducenti fra due giorni compresi. */
export async function assegnazioniDei(ex: Ex, conducenti: string[], dal: string, al: string): Promise<RigaTurno[]> {
  const ids = [...new Set(conducenti.filter(id => UUID.test(id)))];
  if (!ids.length) return [];
  return righe(await ex.execute(sql`
    SELECT id::text, driver_id::text, day::text AS day, dss_id::text, duty_code, snapshot, forzatura
      FROM roster_assignments
     WHERE driver_id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
       AND day BETWEEN ${dal}::date AND ${al}::date`))
    .map(x => ({ ...x, day: String(x.day).slice(0, 10) }));
}

/**
 * Da righe di assegnazione a turni nel tempo: orari dallo snapshot in minuti,
 * altrimenti dal DSS, altrimenti dalle stringhe dello snapshot. Un turno di
 * cui non si sa l'orario non si controlla.
 */
export async function turniNelTempo(righeTurni: RigaTurno[]): Promise<TurnoNelTempo[]> {
  const mancanti = righeTurni.filter(r => minutiSnapshot(r.snapshot) === null)
    .map(r => ({ dssId: r.dss_id, codice: r.duty_code }));
  const [dalDss, servizi] = await Promise.all([
    mancanti.length ? turniDelDss(mancanti) : Promise.resolve(new Map<string, any>()),
    serviziDeiDss(righeTurni.map(r => r.dss_id)),
  ]);
  const out: TurnoNelTempo[] = [];
  for (const r of righeTurni) {
    const intervallo = minutiSnapshot(r.snapshot)
      ?? intervalloTurno(dalDss.get(`${r.dss_id}|${r.duty_code}`))
      ?? intervalloDaSnapshot(r.snapshot);
    if (!intervallo) continue;
    const base = giornoEpoca(r.day) * MINUTI_GIORNO;
    const s = servizi.get(r.dss_id);
    out.push({
      chiave: chiaveTurno(r.dss_id, r.day, r.duty_code),
      assegnazioneId: r.id,
      conducenteId: r.driver_id,
      giorno: r.day,
      codice: r.duty_code,
      dssId: r.dss_id,
      inizio: base + intervallo.inizio,
      fine: base + intervallo.fine,
      servizio: s?.servizio ?? null,
      servizioDa: s?.da ?? null,
      forzato: !!r.forzatura,
    });
  }
  return out;
}

/** Solo i minuti salvati nello snapshot (le assegnazioni nuove li hanno). */
function minutiSnapshot(s: any): { inizio: number; fine: number } | null {
  if (!s || typeof s.startMin !== "number" || typeof s.endMin !== "number") return null;
  return intervalloDaSnapshot({ startMin: s.startMin, endMin: s.endMin });
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

/**
 * Le violazioni che questi cambi creano, sui conducenti che ricevono i turni.
 * Si leggono le assegnazioni intorno ai giorni dei cambi con `ex` (la
 * transazione, dopo aver bloccato i conducenti), si applicano i cambi e si
 * tengono solo le violazioni in cui c'è almeno un turno cambiato: quelle che
 * c'erano già non sono colpa di questo cambio.
 */
export async function violazioniDeiCambi(ex: Ex, cambi: Cambio[]): Promise<Violazione[]> {
  if (!cambi.length) return [];
  const giorni = cambi.map(c => c.day).sort();
  const righeEsistenti = await assegnazioniDei(ex, cambi.map(c => c.driverId),
    piuGiorni(giorni[0]!, -MARGINE_GIORNI), piuGiorni(giorni[giorni.length - 1]!, MARGINE_GIORNI));
  const cambiate = new Set(cambi.map(c => chiaveTurno(c.dssId, c.day, c.dutyCode)));
  const spostate = new Set(cambi.map(c => c.id).filter(Boolean));
  const righeDopo: RigaTurno[] = [
    ...righeEsistenti.filter(r => !spostate.has(r.id) && !cambiate.has(chiaveTurno(r.dss_id, r.day, r.duty_code))),
    ...cambi.map(c => ({ id: c.id, driver_id: c.driverId, day: c.day, dss_id: c.dssId, duty_code: c.dutyCode, snapshot: c.snapshot, forzatura: null })),
  ];
  return violazioniDeiTurni(await turniNelTempo(righeDopo))
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

/** Il segno lasciato su un'assegnazione forzata: chi, quando, cosa. */
export function forzaturaDa(userId: string | null, violazioni: Violazione[]) {
  return {
    da: userId,
    il: new Date().toISOString(),
    regole: [...new Set(violazioni.map(v => v.regola))],
    testi: violazioni.map(v => v.testo),
  };
}
