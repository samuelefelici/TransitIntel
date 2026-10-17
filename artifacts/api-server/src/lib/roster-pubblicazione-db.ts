/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PUBBLICAZIONE DEI TURNI NEL ROSTER — la parte che legge e scrive il database
 * ───────────────────────────────────────────────────────────────────────────
 * Le regole stanno in roster-pubblicazione.ts. Qui:
 *   - le tabelle: il registro delle pubblicazioni, il canale (una riga per
 *     giorno e UDP, con lo storico delle righe sostituite) e i riassunti dei
 *     turni di ogni DSS (orari, residenza, firma), letti una volta sola dal
 *     JSON del risultato, che pesa megabyte;
 *   - l'anteprima, la pubblicazione, il ritiro di un periodo, il registro.
 *
 * Un solo lucchetto per il canale (CHIAVE_CANALE): la pubblicazione lo prende
 * esclusivo, chi assegna, scambia o toglie un turno lo prende condiviso.
 * Così una pubblicazione non si mescola mai a un'assegnazione a metà.
 * Il lavoro pesante (riassunti, firme, piano) si fa prima, fuori dalla
 * transazione; dentro solo controlli e scritture.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { oggiRoma, righe, type Ex } from "./anagrafica-store";
import { forzataLaCoppia, intervalloTurno } from "./roster-normativa";
import { violazioniDelTabellone, piuGiorni } from "./roster-normativa-db";
import { codiceTurno, turniDelRisultato, turnoRoster, type TurnoRoster } from "./roster-turni";
import {
  doppieCoperture, firmaTurno, giorniDelPeriodo, normData, pianoCanale, ricollega, rimappaCoppie,
  type DaRicollegare, type MotivoRestano, type RigaCanale, type TurnoPubblicabile, type UdpConDate,
} from "./roster-pubblicazione";

const dbEx = db as unknown as Ex;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inLista = (ids: string[]) => sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);

/** Il lucchetto del canale (pg_advisory_xact_lock). */
export const CHIAVE_CANALE = 712_340_101;
export const bloccoCanaleCondiviso = (ex: Ex) => ex.execute(sql`SELECT pg_advisory_xact_lock_shared(${CHIAVE_CANALE})`);
const bloccoCanaleEsclusivo = (ex: Ex) => ex.execute(sql`SELECT pg_advisory_xact_lock(${CHIAVE_CANALE})`);

/** Errore con stato HTTP e dati per il client. */
export class RifiutoPubblicazione extends Error {
  constructor(public status: number, messaggio: string, public extra: Record<string, unknown> = {}) { super(messaggio); }
}

/* ── Tabelle ─────────────────────────────────────────────────────────────── */

let pronto: Promise<void> | null = null;
export function assicuraPubblicazione(): Promise<void> {
  if (!pronto) pronto = crea().catch(e => { pronto = null; throw e; });
  return pronto;
}

async function crea(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_pubblicazioni (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo text NOT NULL DEFAULT 'pubblica' CHECK (tipo IN ('pubblica', 'ritira')),
      ps_project_id uuid,
      programma text,
      dal date NOT NULL,
      al date NOT NULL,
      scelte jsonb NOT NULL DEFAULT '{}'::jsonb,
      prima jsonb NOT NULL DEFAULT '[]'::jsonb,
      riepilogo jsonb NOT NULL DEFAULT '{}'::jsonb,
      nota text,
      creata_da uuid,
      creata_il timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_roster_pubblicazioni_il ON roster_pubblicazioni(creata_il DESC)`);
  /* il canale: una riga per giorno e UDP; le righe sostituite restano, con chi le ha sostituite.
     Un DSS pubblicato non si cancella (RESTRICT): neanche in cascata dal suo turni macchina. */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_turni_pubblicati (
      id bigserial PRIMARY KEY,
      day date NOT NULL,
      udp_id uuid NOT NULL,
      dss_id uuid NOT NULL REFERENCES driver_shift_scenarios(id) ON DELETE RESTRICT,
      ps_project_id uuid,
      udp_nome text,
      dss_nome text,
      pubblicazione_id uuid NOT NULL REFERENCES roster_pubblicazioni(id),
      sostituita_da uuid REFERENCES roster_pubblicazioni(id)
    )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_roster_turni_pubblicati_attivi ON roster_turni_pubblicati(day, udp_id) WHERE sostituita_da IS NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_roster_turni_pubblicati_dss ON roster_turni_pubblicati(dss_id, day) WHERE sostituita_da IS NULL`);
  /* i riassunti dei turni di un DSS: si rifanno se la riga del DSS cambia (xmin) */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_dss_riassunti (
      dss_id uuid PRIMARY KEY REFERENCES driver_shift_scenarios(id) ON DELETE CASCADE,
      impronta text NOT NULL,
      codici_doppi text[] NOT NULL DEFAULT '{}',
      turni integer NOT NULL DEFAULT 0,
      fatto_il timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS roster_turni_dss (
      dss_id uuid NOT NULL REFERENCES driver_shift_scenarios(id) ON DELETE CASCADE,
      codice text NOT NULL,
      ordine integer NOT NULL,
      riassunto jsonb NOT NULL,
      firma text,
      corse jsonb NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (dss_id, codice)
    )`);
  /* ricollegamenti: da quale turno veniva un'assegnazione spostata da una ripubblicazione.
     ALTER solo se manca: anche con IF NOT EXISTS prende la tabella in esclusiva */
  const c = await db.execute<any>(sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'roster_assignments' AND column_name = 'ricollegamenti'`);
  if (!righe(c).length) await db.execute(sql`ALTER TABLE roster_assignments ADD COLUMN IF NOT EXISTS ricollegamenti jsonb`);
}

/* ── Riassunti dei turni di un DSS ───────────────────────────────────────── */

export interface TurnoRiassunto extends Omit<TurnoRoster, "segments"> {
  inizio: number | null;
  fine: number | null;
  firma: string | null;
  corse: string[];
}
/** `impronta`: la versione della riga del DSS (xmin) da cui viene il riassunto. */
export interface RiassuntoDss { dssId: string; impronta: string; turni: TurnoRiassunto[]; codiciDoppi: string[] }

/**
 * I turni di questi DSS, riassunti (senza le tratte). Si leggono dalla tabella
 * dei riassunti; un DSS che non c'è o la cui riga è cambiata da allora (xmin)
 * si rilegge dal JSON e si riscrive, uno alla volta.
 */
export async function riassuntiDei(dssIds: string[]): Promise<Map<string, RiassuntoDss>> {
  const ids = [...new Set(dssIds.filter(id => UUID.test(id)))];
  const out = new Map<string, RiassuntoDss>();
  if (!ids.length) return out;
  const stato = righe(await dbEx.execute(sql`
    SELECT d.id::text AS id, d.xmin::text AS ora, r.impronta, r.codici_doppi
      FROM driver_shift_scenarios d
      LEFT JOIN roster_dss_riassunti r ON r.dss_id = d.id
     WHERE d.id IN (${inLista(ids)})`));
  const daRifare = stato.filter(x => x.impronta !== x.ora).map(x => String(x.id));
  for (const id of daRifare) await rifaiRiassunto(id);
  const doppi = new Map<string, string[]>(stato.map(x => [String(x.id), x.codici_doppi ?? []]));
  const impronte = new Map<string, string>(stato.map(x => [String(x.id), String(x.ora)]));
  if (daRifare.length) {
    for (const x of righe(await dbEx.execute(sql`SELECT dss_id::text AS id, impronta, codici_doppi FROM roster_dss_riassunti WHERE dss_id IN (${inLista(daRifare)})`))) {
      doppi.set(String(x.id), x.codici_doppi ?? []);
      impronte.set(String(x.id), String(x.impronta));
    }
  }
  const presenti = stato.map(x => String(x.id));
  for (const id of presenti) out.set(id, { dssId: id, impronta: impronte.get(id) ?? "", turni: [], codiciDoppi: doppi.get(id) ?? [] });
  if (!presenti.length) return out;
  for (const r of righe(await dbEx.execute(sql`
    SELECT dss_id::text AS dss, codice, riassunto, firma, corse
      FROM roster_turni_dss WHERE dss_id IN (${inLista(presenti)}) ORDER BY dss_id, ordine`))) {
    out.get(String(r.dss))?.turni.push({ ...(r.riassunto ?? {}), code: r.codice, firma: r.firma ?? null, corse: Array.isArray(r.corse) ? r.corse : [] });
  }
  return out;
}

/** Il lucchetto di un riassunto: due richieste che rifanno lo stesso DSS si mettono in fila. */
const CHIAVE_RIASSUNTI = 712_340_102;

async function rifaiRiassunto(dssId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ex = tx as unknown as Ex;
    await ex.execute(sql`SELECT pg_advisory_xact_lock(${CHIAVE_RIASSUNTI}, hashtext(${dssId}))`);
    /* letto dopo il lucchetto: se intanto l'ha rifatto un altro, per questa versione, non c'è niente da fare */
    const r = righe(await ex.execute(sql`
      SELECT d.xmin::text AS impronta, d.result, r.impronta AS fatta
        FROM driver_shift_scenarios d LEFT JOIN roster_dss_riassunti r ON r.dss_id = d.id
       WHERE d.id = ${dssId}::uuid`))[0];
    if (!r || r.fatta === r.impronta) return;
    const lista = turniDelRisultato(r.result);
    const visti = new Map<string, number>();
    const turni = lista.map((d, i) => {
      const { segments: _s, ...t } = turnoRoster(d, i);
      const f = firmaTurno(d);
      const intervallo = intervalloTurno(d);
      visti.set(t.code, (visti.get(t.code) ?? 0) + 1);
      return { ordine: i, codice: codiceTurno(d, i), riassunto: { ...t, inizio: intervallo?.inizio ?? null, fine: intervallo?.fine ?? null }, firma: f.firma, corse: f.corse };
    });
    const doppi = [...visti].filter(([, n]) => n > 1).map(([c]) => c);
    await ex.execute(sql`DELETE FROM roster_turni_dss WHERE dss_id = ${dssId}::uuid`);
    /* con codici doppi si tiene il primo: il DSS comunque non si pubblica */
    const unici = turni.filter((t, i) => turni.findIndex(x => x.codice === t.codice) === i);
    for (let i = 0; i < unici.length; i += 200) {
      const blocco = unici.slice(i, i + 200);
      await ex.execute(sql`
        INSERT INTO roster_turni_dss (dss_id, codice, ordine, riassunto, firma, corse)
        VALUES ${sql.join(blocco.map(t => sql`(${dssId}::uuid, ${t.codice}, ${t.ordine}, ${JSON.stringify(t.riassunto)}::jsonb, ${t.firma}, ${JSON.stringify(t.corse)}::jsonb)`), sql`, `)}
        ON CONFLICT (dss_id, codice) DO UPDATE SET ordine = EXCLUDED.ordine, riassunto = EXCLUDED.riassunto, firma = EXCLUDED.firma, corse = EXCLUDED.corse`);
    }
    await ex.execute(sql`
      INSERT INTO roster_dss_riassunti (dss_id, impronta, codici_doppi, turni)
      VALUES (${dssId}::uuid, ${r.impronta}, ${`{${doppi.map(c => `"${c.replace(/["\\]/g, "")}"`).join(",")}}`}::text[], ${turni.length})
      ON CONFLICT (dss_id) DO UPDATE SET impronta = EXCLUDED.impronta, codici_doppi = EXCLUDED.codici_doppi, turni = EXCLUDED.turni, fatto_il = now()`);
  });
}

/** Lo snapshot di un turno (come lo salva l'assegnazione) dal suo riassunto. */
export const snapshotDaRiassunto = (t: TurnoRiassunto) => ({ start: t.start, end: t.end, startMin: t.inizio, endMin: t.fine });

/* ── Il canale ───────────────────────────────────────────────────────────── */

export interface RigaAttiva extends RigaCanale { pubblicazioneId: string }

/** Le righe attive del canale fra due giorni compresi. */
export async function canale(ex: Ex, dal: string, al: string): Promise<RigaAttiva[]> {
  return righe(await ex.execute(sql`
    SELECT day::text AS day, udp_id::text, dss_id::text, ps_project_id::text, udp_nome, dss_nome, pubblicazione_id::text
      FROM roster_turni_pubblicati
     WHERE sostituita_da IS NULL AND day BETWEEN ${dal}::date AND ${al}::date
     ORDER BY day, udp_nome, udp_id`)).map(x => ({
    day: String(x.day).slice(0, 10), udpId: x.udp_id, dssId: x.dss_id, psProjectId: x.ps_project_id ?? null,
    udpNome: x.udp_nome ?? null, dssNome: x.dss_nome ?? null, pubblicazioneId: x.pubblicazione_id,
  }));
}

/** Pubblicato quel giorno? `nessuno`: il giorno non ha nessuna riga nel canale. */
export async function statoNelCanale(ex: Ex, day: string, dssId: string): Promise<"pubblicato" | "non_pubblicato" | "giorno_vuoto"> {
  const r = righe(await ex.execute(sql`
    SELECT bool_or(dss_id = ${dssId}::uuid) AS questo, count(*)::int AS n
      FROM roster_turni_pubblicati WHERE sostituita_da IS NULL AND day = ${day}::date`))[0];
  if (!r || Number(r.n) === 0) return "giorno_vuoto";
  return r.questo ? "pubblicato" : "non_pubblicato";
}

/* ── Programmi, UDP e turni guida che si possono pubblicare ──────────────── */

export interface Programma { id: string; nome: string; inEsercizio: boolean; udp: number; ultimaPubblicazione: string | null }

/** I programmi (progetti Planning Studio) che l'utente vede: suoi, condivisi, o quello in esercizio. */
export async function programmi(userId: string, admin: boolean, soloId?: string): Promise<Programma[]> {
  try {
    return righe(await dbEx.execute(sql`
      SELECT p.id::text, p.name,
             (p.materialized_feed_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM gtfs_feeds gf WHERE gf.id = p.materialized_feed_id AND gf.is_active = true)) AS in_esercizio,
             (SELECT count(*)::int FROM ps_validity_units u WHERE u.project_id = p.id) AS udp,
             (SELECT max(creata_il) FROM roster_pubblicazioni rp WHERE rp.ps_project_id = p.id) AS ultima
        FROM ps_projects p
       WHERE (${soloId ?? null}::uuid IS NULL OR p.id = ${soloId ?? null}::uuid)
         AND (${admin} OR p.owner_user_id = ${userId}::uuid
              OR EXISTS (SELECT 1 FROM ps_project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${userId}::uuid)
              OR (p.materialized_feed_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM gtfs_feeds gf WHERE gf.id = p.materialized_feed_id AND gf.is_active = true)))
       ORDER BY in_esercizio DESC, ultima DESC NULLS LAST, p.name`)).map(x => ({
      id: x.id, nome: x.name, inEsercizio: !!x.in_esercizio, udp: Number(x.udp ?? 0),
      ultimaPubblicazione: x.ultima ? new Date(x.ultima).toISOString() : null,
    }));
  } catch (e: any) {
    if ((e?.cause?.code ?? e?.code) === "42P01") return [];
    throw e;
  }
}

/** Le UDP di un programma, con le date in formato YYYY-MM-DD. */
export async function udpDelProgramma(psProjectId: string): Promise<Array<UdpConDate & { servizio: string | null; corse: string[] }>> {
  try {
    return righe(await dbEx.execute(sql`
      SELECT u.id::text, u.name, u.representative_dates AS date, to_jsonb(u)->>'service_type' AS servizio, u.trip_ids
        FROM ps_validity_units u WHERE u.project_id = ${psProjectId}::uuid ORDER BY u.day_count DESC, u.name`)).map(x => ({
      id: x.id, nome: x.name,
      date: [...new Set<string>((Array.isArray(x.date) ? x.date : []).map(normData).filter((d: string | null): d is string => !!d))].sort(),
      servizio: x.servizio ?? null,
      corse: Array.isArray(x.trip_ids) ? x.trip_ids.map(String) : [],
    }));
  } catch (e: any) {
    if ((e?.cause?.code ?? e?.code) === "42P01") return [];
    throw e;
  }
}

export interface Candidato {
  dssId: string; nome: string; versione: number; inEsercizio: boolean;
  superatoDa: string | null; datiSuperati: boolean; turni: number; creatoIl: string; progetto: string;
}

/** I turni guida di ogni UDP: quelli dei suoi progetti di scheduling. */
export async function candidatiDelleUdp(udpIds: string[]): Promise<Map<string, Candidato[]>> {
  const out = new Map<string, Candidato[]>(udpIds.map(id => [id, []]));
  const ids = udpIds.filter(id => UUID.test(id));
  if (!ids.length) return out;
  const r = righe(await dbEx.execute(sql`
    SELECT sp.validity_unit_id::text AS udp_id, sp.name AS progetto,
           d.id::text, d.name, d.created_at, COALESCE(d.is_operational, false) AS op,
           COALESCE(d.version, 1) AS versione, d.superseded_by::text AS superato_da, d.stale_since,
           jsonb_array_length(COALESCE(d.result->'driverShifts', d.result->'duties', '[]'::jsonb)) AS turni
      FROM driver_shift_scenarios d
      JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
      JOIN scheduling_projects sp ON sp.id = COALESCE(d.project_id, s.project_id)
     WHERE sp.validity_unit_id IN (${inLista(ids)})
     ORDER BY op DESC, versione DESC, d.created_at DESC`));
  for (const x of r) out.get(x.udp_id)?.push(candidatoDa(x));
  return out;
}

const candidatoDa = (x: any): Candidato => ({
  dssId: x.id, nome: x.name, versione: Number(x.versione), inEsercizio: !!x.op, superatoDa: x.superato_da ?? null,
  datiSuperati: !!x.stale_since, turni: Number(x.turni ?? 0), creatoIl: new Date(x.created_at).toISOString(), progetto: x.progetto,
});

/**
 * DSS già pubblicati per un'UDP che non risultano più fra i suoi (il progetto
 * di scheduling è stato cancellato o spostato): restano una scelta valida,
 * così la pubblicazione in corso si può tenere o allungare.
 */
async function candidatiGiaPubblicati(mancanti: Array<{ udpId: string; dssId: string }>): Promise<Array<{ udpId: string; c: Candidato }>> {
  const ids = [...new Set(mancanti.map(m => m.dssId))];
  if (!ids.length) return [];
  const r = righe(await dbEx.execute(sql`
    SELECT d.id::text, d.name, d.created_at, COALESCE(d.is_operational, false) AS op,
           COALESCE(d.version, 1) AS versione, d.superseded_by::text AS superato_da, d.stale_since,
           jsonb_array_length(COALESCE(d.result->'driverShifts', d.result->'duties', '[]'::jsonb)) AS turni
      FROM driver_shift_scenarios d WHERE d.id IN (${inLista(ids)})`));
  const perId = new Map(r.map(x => [String(x.id), x]));
  return mancanti.flatMap(m => {
    const x = perId.get(m.dssId);
    return x ? [{ udpId: m.udpId, c: candidatoDa({ ...x, progetto: "già pubblicato" }) }] : [];
  });
}

/* ── Le assegnazioni toccate ─────────────────────────────────────────────── */

interface AssegnazionePeriodo { id: string; driverId: string; day: string; dssId: string; codice: string; forzatura: any; snapshot: any }

async function assegnazioniNeiGiorni(ex: Ex, dal: string, al: string, lucchetto = false): Promise<AssegnazionePeriodo[]> {
  return righe(await ex.execute(sql`
    SELECT id::text, driver_id::text, day::text AS day, dss_id::text, duty_code, forzatura, snapshot
      FROM roster_assignments WHERE day BETWEEN ${dal}::date AND ${al}::date
     ORDER BY id ${lucchetto ? sql`FOR UPDATE` : sql``}`)).map(x => ({
    id: x.id, driverId: x.driver_id, day: String(x.day).slice(0, 10), dssId: x.dss_id, codice: x.duty_code,
    forzatura: x.forzatura, snapshot: x.snapshot,
  }));
}

/**
 * Il gettone dell'anteprima: se fra anteprima e pubblicazione cambia qualcosa
 * di ciò che l'anteprima ha mostrato, si richiede. Conta il canale, le
 * assegnazioni, il piano (giorni toccati e righe nuove, quindi date e scelte
 * delle UDP) e la versione di ogni turni guida letto.
 */
function gettone(attuali: RigaCanale[], assegnazioni: AssegnazionePeriodo[], piano: ReturnType<typeof pianoCanale>, riassunti: Map<string, RiassuntoDss>): string {
  const h = createHash("sha256");
  for (const r of attuali) h.update(`c:${r.day}|${r.udpId}|${r.dssId}\n`);
  for (const a of [...assegnazioni].sort((x, y) => x.id.localeCompare(y.id))) h.update(`a:${a.id}|${a.day}|${a.dssId}|${a.codice}|${a.driverId}\n`);
  h.update(`t:${piano.giorniToccati.join(",")}\n`);
  for (const r of piano.nuove) h.update(`n:${r.day}|${r.udpId}|${r.dssId}\n`);
  for (const [id, r] of [...riassunti].sort((x, y) => x[0].localeCompare(y[0]))) h.update(`v:${id}|${r.impronta}\n`);
  return h.digest("hex").slice(0, 24);
}

/* ── Anteprima ───────────────────────────────────────────────────────────── */

export interface Richiesta {
  psProjectId: string;
  dal: string;
  al: string;
  /** per UDP: il DSS da pubblicare, null per lasciarla fuori; assente = la proposta */
  scelte?: Record<string, string | null>;
}

const MAX_GIORNI = 366;

/** Una data vera (il 30 febbraio no: Date.parse lo fa diventare il 2 marzo). */
const dataVera = (d: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d && d >= "2000-01-01" && d <= "2099-12-31";
};

function controllaPeriodo(dal: string, al: string): void {
  if (!dataVera(dal) || !dataVera(al)) {
    throw new RifiutoPubblicazione(400, "Periodo non valido: dal e al nel formato AAAA-MM-GG");
  }
  if (al < dal) throw new RifiutoPubblicazione(400, "Il periodo finisce prima di cominciare");
  if (giorniDelPeriodo(dal, al).length > MAX_GIORNI) throw new RifiutoPubblicazione(400, `Si pubblica al massimo un anno (${MAX_GIORNI} giorni) per volta`);
}

/** Tutto quello che serve per decidere e per pubblicare, calcolato fuori dalla transazione. */
async function prepara(req: Richiesta, userId: string, admin: boolean) {
  controllaPeriodo(req.dal, req.al);
  if (!UUID.test(String(req.psProjectId ?? ""))) throw new RifiutoPubblicazione(400, "Programma non valido");
  const [programma] = await programmi(userId, admin, req.psProjectId);
  if (!programma) throw new RifiutoPubblicazione(404, "Programma non trovato, o non visibile");
  const udp = await udpDelProgramma(req.psProjectId);
  const candidati = await candidatiDelleUdp(udp.map(u => u.id));
  const attuali = await canale(dbEx, req.dal, req.al);
  const assegnazioni = await assegnazioniNeiGiorni(dbEx, req.dal, req.al);
  const periodo = new Set(giorniDelPeriodo(req.dal, req.al));
  /* un DSS già pubblicato per un'UDP resta fra i suoi candidati anche se non ne risulta più */
  const mancanti = udp.flatMap(u => [...new Set(attuali.filter(r => r.udpId === u.id).map(r => r.dssId))]
    .filter(d => !(candidati.get(u.id) ?? []).some(c => c.dssId === d)).map(dssId => ({ udpId: u.id, dssId })));
  for (const { udpId, c } of await candidatiGiaPubblicati(mancanti)) candidati.get(udpId)?.push(c);
  /* l'UDP di ogni turni guida: serve a ricollegare i turni senza corse */
  const udpDelDss = new Map<string, string>();
  for (const [udpId, l] of candidati) for (const c of l) if (!udpDelDss.has(c.dssId)) udpDelDss.set(c.dssId, udpId);

  /* la proposta per ogni UDP: quello già pubblicato (se uno solo), poi quello in
     esercizio (se uno solo), poi quello che le assegnazioni del periodo già usano */
  const proposte: Record<string, string | null> = {};
  const avvisi: Record<string, string[]> = {};
  for (const u of udp) {
    const c = candidati.get(u.id) ?? [];
    const lista: string[] = [];
    const pubblicati = [...new Set(attuali.filter(r => r.udpId === u.id).map(r => r.dssId))];
    const inEsercizio = c.filter(x => x.inEsercizio);
    const usati = new Map<string, number>();
    for (const a of assegnazioni) if (c.some(x => x.dssId === a.dssId)) usati.set(a.dssId, (usati.get(a.dssId) ?? 0) + 1);
    const piuUsato = [...usati].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    proposte[u.id] = pubblicati.length === 1 ? pubblicati[0]!
      : inEsercizio.length === 1 ? inEsercizio[0]!.dssId
        : piuUsato;
    if (!c.length) lista.push("nessun turno guida calcolato per questa UDP");
    else if (!pubblicati.length && inEsercizio.length > 1) lista.push("più turni guida in esercizio: scegli quale pubblicare");
    else if (!pubblicati.length && !inEsercizio.length && !piuUsato) lista.push("nessun turno guida in esercizio: scegli quale pubblicare");
    if (pubblicati.length > 1) lista.push("nel periodo sono pubblicati turni guida diversi in giorni diversi: scegli quale vale per tutto il periodo");
    if (!u.date.some(d => periodo.has(d))) lista.push("nessuna data di questa UDP cade nel periodo: ricalcola le UDP in Planning Studio sul periodo");
    avvisi[u.id] = lista;
  }
  const scelte: Record<string, string | null> = {};
  for (const u of udp) scelte[u.id] = req.scelte && u.id in req.scelte ? req.scelte[u.id] ?? null : proposte[u.id] ?? null;

  /* scelte valide: UDP del programma, DSS fra quelli dell'UDP */
  for (const [udpId, dssId] of Object.entries(req.scelte ?? {})) {
    if (!udp.some(u => u.id === udpId)) throw new RifiutoPubblicazione(400, "Un'UDP scelta non è di questo programma");
    if (dssId && !(candidati.get(udpId) ?? []).some(c => c.dssId === dssId)) {
      throw new RifiutoPubblicazione(400, "Un turno guida scelto non appartiene alla sua UDP");
    }
  }
  const dssScelti = [...new Set(Object.values(scelte).filter((x): x is string => !!x))];
  const dssDelleAssegnazioni = [...new Set(assegnazioni.map(a => a.dssId))];
  const riassunti = await riassuntiDei([...dssScelti, ...dssDelleAssegnazioni]);
  const nomiDss: Record<string, string | null> = {};
  for (const l of candidati.values()) for (const c of l) nomiDss[c.dssId] = c.nome;
  for (const u of udp) {
    const d = scelte[u.id];
    if (!d) continue;
    const r = riassunti.get(d);
    if (!r || !r.turni.length) avvisi[u.id]!.push("i turni guida scelti non hanno turni");
    if (r?.codiciDoppi.length) avvisi[u.id]!.push(`i turni guida scelti hanno codici ripetuti (${r.codiciDoppi.slice(0, 3).join(", ")}): non si possono pubblicare`);
    const c = (candidati.get(u.id) ?? []).find(x => x.dssId === d);
    if (c?.superatoDa) avvisi[u.id]!.push("di questi turni guida c'è una versione più nuova");
    if (c?.datiSuperati) avvisi[u.id]!.push("turni guida calcolati su dati poi cambiati (corse o orari)");
  }

  const piano = pianoCanale({ psProjectId: req.psProjectId, udp, scelte, dal: req.dal, al: req.al, attuali, nomiDss });
  return { programma, udp, candidati, attuali, assegnazioni, proposte, scelte, avvisi, riassunti, piano, nomiDss, udpDelDss };
}

/**
 * Il ricollegamento delle assegnazioni dei giorni toccati, dato un piano.
 * Anche nei giorni passati: un turno uguale è lo stesso lavoro, e il canale
 * deve tornare con le assegnazioni.
 */
function simulaRicollegamento(
  piano: ReturnType<typeof pianoCanale>, assegnazioni: AssegnazionePeriodo[],
  riassunti: Map<string, RiassuntoDss>, udpDelDss: Map<string, string>,
) {
  const toccati = new Set(piano.giorniToccati);
  const dopo = new Map<string, Array<{ udpId: string; dssId: string }>>();
  for (const r of piano.nuove) {
    const l = dopo.get(r.day) ?? [];
    l.push({ udpId: r.udpId, dssId: r.dssId });
    dopo.set(r.day, l);
  }
  const udpPrima = new Map(piano.tolte.map(r => [`${r.day}|${r.dssId}`, r.udpId]));
  const firme = new Map<string, Map<string, string | null>>();
  for (const [id, r] of riassunti) firme.set(id, new Map(r.turni.map(t => [t.code, t.firma])));
  const turni = new Map<string, TurnoPubblicabile[]>();
  for (const [id, r] of riassunti) turni.set(id, r.turni.map(t => ({ dssId: id, codice: t.code, firma: t.firma })));
  const occupati = new Set<string>();
  const daRicollegare: DaRicollegare[] = [];
  for (const a of assegnazioni) {
    if (!toccati.has(a.day)) continue;
    const resta = (dopo.get(a.day) ?? []).some(x => x.dssId === a.dssId);
    if (resta) { occupati.add(`${a.dssId}|${a.day}|${a.codice}`); continue; }
    daRicollegare.push({
      id: a.id, day: a.day, dssId: a.dssId, codice: a.codice,
      firma: firme.get(a.dssId)?.get(a.codice) ?? null,
      /* l'UDP in cui era pubblicato; se il giorno non lo era, quella del suo turni guida */
      udpPrima: udpPrima.get(`${a.day}|${a.dssId}`) ?? udpDelDss.get(a.dssId) ?? null,
    });
  }
  const esito = ricollega({ assegnazioni: daRicollegare, pubblicati: dopo, turni, occupati });
  return { esito, restanoDove: occupati.size };
}

export async function anteprima(req: Richiesta, userId: string, admin: boolean) {
  const p = await prepara(req, userId, admin);
  const oggi = oggiRoma();
  const sim = simulaRicollegamento(p.piano, p.assegnazioni, p.riassunti, p.udpDelDss);
  const periodo = giorniDelPeriodo(req.dal, req.al);
  const dentro = new Set(periodo);
  const dopoPerGiorno = new Map<string, string[]>();
  for (const r of p.piano.nuove) dopoPerGiorno.set(r.day, [...(dopoPerGiorno.get(r.day) ?? []), r.dssId]);
  const corseDiDss = new Map<string, string[][]>();
  for (const [id, r] of p.riassunti) corseDiDss.set(id, r.turni.map(t => t.corse));
  const doppie = doppieCoperture(dopoPerGiorno, corseDiDss).map(d => ({ ...d, dss: d.dss.map(id => p.nomiDss[id] ?? id) }));
  const altriProgrammi = new Map<string, Set<string>>();
  for (const r of p.piano.tolte) {
    if (r.psProjectId === req.psProjectId) continue;
    const k = r.psProjectId ?? "—";
    altriProgrammi.set(k, new Set([...(altriProgrammi.get(k) ?? []), r.day]));
  }
  const nomiProgrammi = new Map((await programmi(userId, true)).map(x => [x.id, x.nome]));
  const assegnazioniToccate = p.assegnazioni.filter(a => p.piano.giorniToccati.includes(a.day));
  return {
    programma: p.programma,
    periodo: { dal: req.dal, al: req.al, giorni: periodo.length },
    udp: p.udp.map(u => ({
      id: u.id, nome: u.nome, servizio: u.servizio,
      giorni: u.date.filter(d => dentro.has(d)),
      candidati: p.candidati.get(u.id) ?? [],
      proposta: p.proposte[u.id] ?? null,
      scelta: p.scelte[u.id] ?? null,
      pubblicatoOra: [...new Set(p.attuali.filter(r => r.udpId === u.id).map(r => r.dssId))].map(id => ({
        dssId: id, nome: p.nomiDss[id] ?? p.attuali.find(r => r.dssId === id)?.dssNome ?? null,
        giorni: p.attuali.filter(r => r.udpId === u.id && r.dssId === id).length,
      })),
      avvisi: p.avvisi[u.id] ?? [],
    })),
    giorniToccati: p.piano.giorniToccati,
    giorniSenzaUdp: p.piano.giorniSenzaUdp,
    giorniSenzaUdpPubblicati: p.piano.giorniSenzaUdpPubblicati,
    giorniPassati: p.piano.giorniToccati.filter(d => d < oggi),
    altriProgrammi: [...altriProgrammi].map(([id, giorni]) => ({ nome: nomiProgrammi.get(id) ?? "un altro programma", giorni: giorni.size })),
    doppie,
    impatto: {
      assegnazioni: assegnazioniToccate.length,
      restanoDove: sim.restanoDove,
      ricollegate: sim.esito.spostamenti.length,
      daRiassegnare: sim.esito.restano.length,
      motivi: conta(sim.esito.restano.map(r => r.motivo)),
    },
    gettone: gettone(p.attuali, p.assegnazioni, p.piano, p.riassunti),
  };
}

const conta = <T extends string>(xs: T[]): Record<string, number> =>
  xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {} as Record<string, number>);

/* ── Pubblicazione ───────────────────────────────────────────────────────── */

export interface Pubblicazione extends Richiesta {
  scelte: Record<string, string | null>;
  gettone: string;
  /** i giorni passati si pubblicano solo dicendolo: le loro assegnazioni non si spostano */
  passato?: boolean;
  nota?: string | null;
}

export async function pubblica(req: Pubblicazione, userId: string | null, via: string | null, admin: boolean) {
  const p = await prepara(req, userId ?? "00000000-0000-0000-0000-000000000000", admin);
  const oggi = oggiRoma();
  if (!p.piano.giorniToccati.length) {
    throw new RifiutoPubblicazione(400, "Niente da pubblicare: nessuna UDP scelta ha date nel periodo");
  }
  for (const u of p.udp) {
    const d = p.scelte[u.id];
    if (!d || !u.date.some(x => p.piano.giorniToccati.includes(x))) continue;
    const r = p.riassunti.get(d);
    if (!r || !r.turni.length) throw new RifiutoPubblicazione(400, `«${u.nome}»: i turni guida scelti non hanno turni`);
    if (r.codiciDoppi.length) throw new RifiutoPubblicazione(400, `«${u.nome}»: i turni guida scelti hanno codici ripetuti (${r.codiciDoppi.slice(0, 3).join(", ")})`);
  }
  const passati = p.piano.giorniToccati.filter(d => d < oggi);
  if (passati.length && !req.passato) {
    throw new RifiutoPubblicazione(409, `Il periodo comprende ${passati.length} giorni già passati: conferma per pubblicarli`, { passati: passati.length });
  }

  const esito = await db.transaction(async (tx) => {
    const ex = tx as unknown as Ex;
    await bloccoCanaleEsclusivo(ex);
    /* i conducenti coinvolti, poi le loro assegnazioni: lo stesso ordine di chi assegna */
    const finestraDal = piuGiorni(req.dal, -2), finestraAl = piuGiorni(req.al, 2);
    const conducenti = righe(await ex.execute(sql`
      SELECT DISTINCT driver_id::text AS id FROM roster_assignments WHERE day BETWEEN ${req.dal}::date AND ${req.al}::date`)).map(x => x.id);
    if (conducenti.length) {
      await ex.execute(sql`SELECT id FROM roster_drivers WHERE id IN (${inLista(conducenti)}) ORDER BY id FOR NO KEY UPDATE`);
    }
    const attuali = await canale(ex, req.dal, req.al);
    const assegnazioni = await assegnazioniNeiGiorni(ex, req.dal, req.al, true);
    /* i turni guida letti (scelti e delle assegnazioni): fermi fino alla fine, e com'erano quando
       si sono riassunti. FOR SHARE ferma chi li salva sul posto o li cancella. */
    const letti = [...p.riassunti.keys()].sort();
    if (letti.length) {
      const ora = new Map(righe(await ex.execute(sql`
        SELECT id::text, xmin::text AS v FROM driver_shift_scenarios WHERE id IN (${inLista(letti)}) ORDER BY id FOR SHARE`)).map(x => [String(x.id), String(x.v)]));
      if (letti.some(id => ora.get(id) !== p.riassunti.get(id)!.impronta)) {
        throw new RifiutoPubblicazione(409, "Nel frattempo un turni guida è stato salvato o cancellato: guarda di nuovo l'anteprima", { cambiato: true });
      }
    }
    const piano = pianoCanale({ psProjectId: req.psProjectId, udp: p.udp, scelte: p.scelte, dal: req.dal, al: req.al, attuali, nomiDss: p.nomiDss });
    if (gettone(attuali, assegnazioni, piano, p.riassunti) !== req.gettone) {
      throw new RifiutoPubblicazione(409, "Nel frattempo il canale, le assegnazioni o le UDP sono cambiati: guarda di nuovo l'anteprima", { cambiato: true });
    }
    const sim = simulaRicollegamento(piano, assegnazioni, p.riassunti, p.udpDelDss);

    const pub = righe(await ex.execute(sql`
      INSERT INTO roster_pubblicazioni (tipo, ps_project_id, programma, dal, al, scelte, prima, nota, creata_da)
      VALUES ('pubblica', ${req.psProjectId}::uuid, ${p.programma.nome}, ${req.dal}::date, ${req.al}::date,
              ${JSON.stringify(p.scelte)}::jsonb,
              ${JSON.stringify(piano.tolte.map(r => ({ d: r.day, u: r.udpId, s: r.dssId, p: r.psProjectId })))}::jsonb,
              ${req.nota ?? null}, ${userId}::uuid)
      RETURNING id::text, creata_il`))[0]!;
    await ex.execute(sql`
      UPDATE roster_turni_pubblicati SET sostituita_da = ${pub.id}::uuid
       WHERE sostituita_da IS NULL AND day IN (${sql.join(piano.giorniToccati.map(d => sql`${d}::date`), sql`, `)})`);
    for (let i = 0; i < piano.nuove.length; i += 500) {
      await ex.execute(sql`
        INSERT INTO roster_turni_pubblicati (day, udp_id, dss_id, ps_project_id, udp_nome, dss_nome, pubblicazione_id)
        VALUES ${sql.join(piano.nuove.slice(i, i + 500).map(r => sql`(${r.day}::date, ${r.udpId}::uuid, ${r.dssId}::uuid, ${r.psProjectId}::uuid, ${r.udpNome ?? null}, ${r.dssNome ?? null}, ${pub.id}::uuid)`), sql`, `)}`);
    }

    /* il ricollegamento: le assegnazioni passano al turno uguale, con lo storico di dove erano */
    const mappa = new Map<string, string>();
    const perId = new Map(assegnazioni.map(a => [a.id, a]));
    const turnoDi = (dss: string, codice: string) => p.riassunti.get(dss)?.turni.find(t => t.code === codice);
    const spostate = sim.esito.spostamenti.map(s => {
      const a = perId.get(s.id)!;
      const t = turnoDi(s.dssId, s.codice);
      mappa.set(`${s.daDss}|${s.day}|${s.daCodice}`, `${s.dssId}|${s.day}|${s.codice}`);
      return {
        id: s.id, dss: s.dssId, codice: s.codice,
        snapshot: t ? snapshotDaRiassunto(t) : null,
        storia: { pubblicazione: pub.id, il: new Date().toISOString(), prima: { dssId: a.dssId, codice: a.codice, snapshot: a.snapshot ?? null } },
      };
    });
    for (let i = 0; i < spostate.length; i += 300) {
      const blocco = spostate.slice(i, i + 300);
      await ex.execute(sql`
        UPDATE roster_assignments a
           SET dss_id = v.dss::uuid, duty_code = v.codice, snapshot = v.snapshot::jsonb,
               ricollegamenti = COALESCE(a.ricollegamenti, '[]'::jsonb) || jsonb_build_array(v.storia::jsonb)
          FROM (VALUES ${sql.join(blocco.map(x => sql`(${x.id}, ${x.dss}, ${x.codice}, ${x.snapshot ? JSON.stringify(x.snapshot) : null}, ${JSON.stringify(x.storia)})`), sql`, `)})
               AS v(id, dss, codice, snapshot, storia)
         WHERE a.id = v.id::uuid`);
    }
    /* le forzature seguono i turni spostati, anche su assegnazioni fuori dal periodo */
    let forzatureRiscritte = 0;
    if (mappa.size) {
      const coinvolti = [...new Set(sim.esito.spostamenti.map(s => perId.get(s.id)!.driverId))];
      const conForzatura = righe(await ex.execute(sql`
        SELECT id::text, forzatura FROM roster_assignments
         WHERE driver_id IN (${inLista(coinvolti)}) AND day BETWEEN ${finestraDal}::date AND ${finestraAl}::date
           AND forzatura IS NOT NULL AND jsonb_typeof(forzatura->'coppie') = 'array'`));
      for (const r of conForzatura) {
        const prima: string[] = r.forzatura.coppie.filter((x: unknown) => typeof x === "string");
        const dopo = rimappaCoppie(prima, mappa);
        if (dopo.join("\n") === prima.join("\n")) continue;
        forzatureRiscritte++;
        await ex.execute(sql`UPDATE roster_assignments SET forzatura = jsonb_set(forzatura, '{coppie}', ${JSON.stringify(dopo)}::jsonb) WHERE id = ${r.id}::uuid`);
      }
    }
    const riepilogo = {
      giorni: piano.giorniToccati.length,
      righe: piano.nuove.length,
      sostituite: piano.tolte.length,
      giorniSenzaUdp: piano.giorniSenzaUdp.length,
      ricollegate: sim.esito.spostamenti.length,
      daRiassegnare: sim.esito.restano.length,
      motivi: conta(sim.esito.restano.map(r => r.motivo)),
      forzatureRiscritte,
    };
    /* lo storico di ogni spostamento sta sull'assegnazione (ricollegamenti); nel registro, chi e quando */
    await ex.execute(sql`UPDATE roster_pubblicazioni SET riepilogo = ${JSON.stringify({ ...riepilogo, via })}::jsonb WHERE id = ${pub.id}::uuid`);
    return { id: pub.id as string, riepilogo, spostate: sim.esito.spostamenti, restano: sim.esito.restano, conducenti };
  });

  /* fuori dalla transazione: le violazioni nuove delle assegnazioni ricollegate (riposi, sovrapposizioni) */
  let nuoveViolazioni: string[] = [];
  if (esito.spostate.length) {
    try {
      const spostate = new Set(esito.spostate.map(s => s.id));
      const v = await violazioniDelTabellone(esito.conducenti, req.dal, req.al);
      nuoveViolazioni = v.filter(x => x.turni.some(t => t.assegnazioneId && spostate.has(t.assegnazioneId)) && !forzataLaCoppia(x)).map(x => x.testo);
    } catch { /* il controllo non blocca la pubblicazione, già fatta */ }
  }
  return { id: esito.id, riepilogo: { ...esito.riepilogo, nuoveViolazioni: nuoveViolazioni.length }, nuoveViolazioni: nuoveViolazioni.slice(0, 20), daRiassegnare: esito.restano };
}

/* ── Ritiro di un periodo ────────────────────────────────────────────────── */

export async function ritira(p: { dal: string; al: string; psProjectId?: string | null; udpIds?: string[] | null; passato?: boolean; nota?: string | null },
  userId: string | null, admin: boolean) {
  controllaPeriodo(p.dal, p.al);
  /* un filtro storto non si allarga mai a tutto: si rifiuta */
  if (p.psProjectId && !UUID.test(p.psProjectId)) throw new RifiutoPubblicazione(400, "Programma non valido");
  if (p.udpIds != null && (!Array.isArray(p.udpIds) || !p.udpIds.length || p.udpIds.some(id => !UUID.test(String(id))))) {
    throw new RifiutoPubblicazione(400, "UDP da ritirare non valide");
  }
  const oggi = oggiRoma();
  if (p.dal < oggi && !p.passato) throw new RifiutoPubblicazione(409, "Il periodo comprende giorni già passati: conferma per ritirarli", { passati: true });
  if (p.psProjectId && !(await programmi(userId ?? "", admin, p.psProjectId)).length) throw new RifiutoPubblicazione(404, "Programma non trovato, o non visibile");
  const udp = p.udpIds ?? [];
  return db.transaction(async (tx) => {
    const ex = tx as unknown as Ex;
    await bloccoCanaleEsclusivo(ex);
    const filtro = sql`sostituita_da IS NULL AND day BETWEEN ${p.dal}::date AND ${p.al}::date
      ${p.psProjectId ? sql`AND ps_project_id = ${p.psProjectId}::uuid` : sql``}
      ${udp.length ? sql`AND udp_id IN (${inLista(udp)})` : sql``}`;
    const tolte = righe(await ex.execute(sql`SELECT day::text AS day, udp_id::text, dss_id::text, ps_project_id::text FROM roster_turni_pubblicati WHERE ${filtro}`));
    if (!tolte.length) throw new RifiutoPubblicazione(400, "Nel periodo non c'è niente di pubblicato da ritirare");
    const pub = righe(await ex.execute(sql`
      INSERT INTO roster_pubblicazioni (tipo, ps_project_id, programma, dal, al, scelte, prima, riepilogo, nota, creata_da)
      VALUES ('ritira', ${p.psProjectId ?? null}::uuid,
              (SELECT name FROM ps_projects WHERE id = ${p.psProjectId ?? null}::uuid),
              ${p.dal}::date, ${p.al}::date, ${JSON.stringify({ udp })}::jsonb,
              ${JSON.stringify(tolte.map(r => ({ d: String(r.day).slice(0, 10), u: r.udp_id, s: r.dss_id, p: r.ps_project_id })))}::jsonb,
              ${JSON.stringify({ righe: tolte.length, giorni: new Set(tolte.map(r => String(r.day))).size })}::jsonb,
              ${p.nota ?? null}, ${userId}::uuid)
      RETURNING id::text`))[0]!;
    await ex.execute(sql`UPDATE roster_turni_pubblicati SET sostituita_da = ${pub.id}::uuid WHERE ${filtro}`);
    return { id: pub.id as string, righe: tolte.length, giorni: new Set(tolte.map(r => String(r.day))).size };
  });
}

/* ── Registro ────────────────────────────────────────────────────────────── */

export async function registro(limite = 50) {
  return righe(await dbEx.execute(sql`
    SELECT p.id::text, p.tipo, p.ps_project_id::text, p.programma, p.dal::text AS dal, p.al::text AS al,
           p.riepilogo, p.nota, p.creata_il, u.email AS autore
      FROM roster_pubblicazioni p LEFT JOIN users u ON u.id = p.creata_da
     ORDER BY p.creata_il DESC LIMIT ${limite}`)).map(x => ({
    id: x.id, tipo: x.tipo, psProjectId: x.ps_project_id, programma: x.programma,
    dal: String(x.dal).slice(0, 10), al: String(x.al).slice(0, 10), riepilogo: x.riepilogo ?? {}, nota: x.nota ?? null,
    creataIl: new Date(x.creata_il).toISOString(), autore: x.autore ?? null,
  }));
}

/**
 * Quanto il roster usa questi turni guida (o quelli di un turni macchina):
 * assegnazioni e giorni pubblicati, anche passati. Un DSS usato non si
 * cancella e non si sovrascrive: lo storico del roster deve restare leggibile.
 */
export async function usiNelRoster(p: { dssIds?: string[]; spsId?: string }, ex: Ex = dbEx): Promise<{ assegnazioni: number; giorniPubblicati: number }> {
  /* dentro una transazione la tabella che manca non la deve rovinare: si legge in un savepoint */
  const leggi = (q: ReturnType<typeof sql>) => ex === dbEx
    ? ex.execute(q)
    : (ex as any).transaction((sp: Ex) => sp.execute(q));
  const conta = async (q: ReturnType<typeof sql>) => {
    try { return Number(righe(await leggi(q))[0]?.n ?? 0); }
    catch (e: any) { if ((e?.cause?.code ?? e?.code) === "42P01") return 0; throw e; }
  };
  const dss = p.spsId && UUID.test(p.spsId)
    ? sql`SELECT id FROM driver_shift_scenarios WHERE service_program_scenario_id = ${p.spsId}::uuid`
    : (p.dssIds ?? []).filter(id => UUID.test(id)).length
      ? sql`SELECT unnest(ARRAY[${sql.join((p.dssIds ?? []).filter(id => UUID.test(id)).map(id => sql`${id}::uuid`), sql`, `)}])`
      : null;
  if (!dss) return { assegnazioni: 0, giorniPubblicati: 0 };
  return {
    assegnazioni: await conta(sql`SELECT count(*)::int AS n FROM roster_assignments WHERE dss_id IN (${dss})`),
    giorniPubblicati: await conta(sql`SELECT count(*)::int AS n FROM roster_turni_pubblicati WHERE dss_id IN (${dss})`),
  };
}

/** Il messaggio del 409 quando qualcuno prova a cancellare turni usati dal roster; null se non sono usati. */
export function messaggioUsi(u: { assegnazioni: number; giorniPubblicati: number }, cosa: string): string | null {
  if (u.giorniPubblicati) return `${cosa}: turni guida pubblicati nel roster (${u.giorniPubblicati} giorni, anche passati). Non si cancellano: lo storico del roster li usa.`;
  if (u.assegnazioni) return `${cosa}: turni guida assegnati nel roster (${u.assegnazioni} assegnazioni). Non si cancellano: lo storico del roster li usa.`;
  return null;
}

/** Quante righe del canale (attive) usano questi DSS: un DSS pubblicato non si cancella. */
export async function giorniPubblicatiDei(dssIds: string[]): Promise<number> {
  const ids = dssIds.filter(id => UUID.test(id));
  if (!ids.length) return 0;
  try {
    return Number(righe(await dbEx.execute(sql`
      SELECT count(*)::int AS n FROM roster_turni_pubblicati WHERE dss_id IN (${inLista(ids)})`))[0]?.n ?? 0);
  } catch (e: any) {
    if ((e?.cause?.code ?? e?.code) === "42P01") return 0;
    throw e;
  }
}

export type { MotivoRestano };
