/**
 * I turni nel programmato (tappa 4.3; analisi, «Tappe in PR piccole», PR 4;
 * migrazione 0026).
 *
 * L'istantanea della giornata (4.2) dice quali corse sono programmate; qui si
 * aggiunge chi le porta. Per ogni corsa: il turno macchina, il turno guida e
 * il deposito, presi dai turni pubblicati della giornata (il canale del
 * roster) com'erano all'inizio della giornata. Il canale tiene lo storico
 * (ogni riga sa da quale pubblicazione nasce e da quale è sostituita), quindi
 * anche una giornata passata si ricostruisce com'era alle 03:00, non com'è
 * oggi. I turni guida e i turni macchina pubblicati non si sovrascrivono
 * (PR 3.6: chi li salva ne crea una versione nuova), quindi il loro
 * risultato è quello di allora.
 *
 * Ogni turni guida pubblicato punta ai turni macchina su cui è calcolato
 * (vss_id): pubblicando i turni guida si pubblicano anche i turni macchina.
 * Dai turni si prendono solo l'appartenenza delle corse e i vuoti, mai i km
 * in linea (quelli vengono dalla geometria, 3.5).
 *
 * Le corse dei turni si riconoscono nel programmato per id del feed (la
 * chiave), altrimenti per codice stabile della corsa (3.1): così reggono
 * anche turni calcolati su un feed precedente dello stesso programma.
 *
 * La funzione che collega (`collegaTurni`) è pura e ha i suoi test; la
 * lettura dal database (`leggiTurni`) prende il canale all'istante, i turni
 * macchina, le corse dei turni guida, le corse scoperte del calcolo, i codici.
 */
import { sql } from "drizzle-orm";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESEMPI = 8;

/** Il lucchetto del canale: lo stesso di roster-pubblicazione-db (CHIAVE_CANALE). */
export const CHIAVE_CANALE = 712_340_101;

/* ── I dati ──────────────────────────────────────────────────────────────── */

export interface CorsaDaCollegare { chiave: string; codice: string | null; linea: string | null; partenza: string | null }

export interface RigaDelCanale {
  udpId: string; udpNome: string | null; dssId: string; dssNome: string | null; vssId: string; vssNome: string | null;
  progettoId: string | null;
  dssSuperato: boolean; dssDatiSuperati: boolean; vssSuperato: boolean;
  /** il deposito dei turni macchina, se ne hanno uno solo (service_program_scenarios.depot_id) */
  depositoId: string | null; deposito: string | null;
}

export interface VoceTurnoMacchina {
  tipo: string; tripId: string | null; partenza: number | null; arrivo: number | null;
  km: number | null; da: string | null; a: string | null; lato: string | null;
}

export interface TurnoMacchinaLetto {
  vssId: string; codice: string; tipoMezzo: string | null;
  depositoId: string | null; deposito: string | null;
  /** totalDeadheadKm del turno: comprende anche i rientri in deposito, che non hanno km sulla voce */
  kmVuoto: number | null; inizio: number | null; fine: number | null;
  voci: VoceTurnoMacchina[];
}

export interface CorsaDiTurnoGuida { dssId: string; codice: string; tripId: string; vettura: string | null }

export interface LetturaTurni {
  istante: string;
  canale: RigaDelCanale[];
  turniMacchina: TurnoMacchinaLetto[];
  corseGuida: CorsaDiTurnoGuida[];
  /** per turni macchina: le corse che il calcolo ha lasciato scoperte (result.unassigned) */
  scoperteDelCalcolo: Map<string, string[]>;
  /** per turni macchina: summary.totalDeadheadKm salvato */
  kmRiepilogo: Map<string, number | null>;
  /** per UDP: le corse di oggi dell'UDP; null se l'UDP non c'è più */
  corseUdp: Map<string, string[] | null>;
  /** codice stabile delle corse di Planning Studio citate dai turni o dalle UDP */
  codiceDi: Map<string, string>;
}

export interface TurniDellaCorsa {
  udpId: string | null; dssId: string | null; vssId: string | null;
  turnoMacchina: string | null; turnoGuida: string | null; deposito: string | null; depositoId: string | null;
}

export interface RigaTurnoMacchina {
  vssId: string; turnoMacchina: string; dssId: string | null; udpId: string | null; udpNome: string | null;
  deposito: string | null; depositoId: string | null; tipoMezzo: string | null;
  uscita: string | null; rientro: string | null; corse: number; corseNelGiorno: number;
  kmVuotoProg: number;
  vuoti: Array<{ tipo: string; da: string | null; a: string | null; partenza: string | null; arrivo: string | null; km: number | null }>;
}

export type MotivoScoperta = "fuori_udp" | "scoperta_nel_calcolo" | "non_nel_calcolo" | "nessun_turno_pubblicato";

export interface RiepilogoTurni {
  istante: string;
  pubblicato: boolean;
  udp: Array<{
    udpId: string; udpNome: string | null; dssId: string; dssNome: string | null; vssId: string; vssNome: string | null;
    progettoId: string | null; dssSuperato: boolean; dssDatiSuperati: boolean; vssSuperato: boolean;
  }>;
  /** UDP pubblicate di un programma diverso da quello in esercizio; null senza programma */
  altroProgramma: number | null;
  corse: number;
  conTurnoMacchina: number;
  conTurnoGuida: number;
  scoperte: {
    senzaTurnoMacchina: number;
    fuoriUdp: number | null;
    scoperteNelCalcolo: number;
    nonNelCalcolo: number;
    senzaTurnoGuida: number;
    esempi: Array<{ trip: string; linea: string | null; partenza: string | null; motivo: MotivoScoperta | "senza_turno_guida" }>;
  };
  turniMacchina: number;
  turniGuida: number;
  corseDeiTurniFuoriProgramma: { quante: number; esempi: string[] };
  doppie: { macchina: number; guida: number };
  vettureDiverse: number;
  codiciRipetuti: number;
  kmVuoto: { turni: number; riepilogo: number | null };
}

export interface EsitoCollegamento {
  perCorsa: Map<string, TurniDellaCorsa>;
  turniMacchina: RigaTurnoMacchina[];
  riepilogo: RiepilogoTurni;
  avvisi: string[];
}

/* ── Il collegamento (puro) ──────────────────────────────────────────────── */

/** Minuti dalla mezzanotte in «HH:MM», anche oltre le 24:00. */
export function orario(min: number | null | undefined): string | null {
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0) return null;
  const m = Math.round(min);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const numero = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

function tipoVuoto(v: VoceTurnoMacchina): string {
  if (v.lato === "out") return "uscita";
  if (v.lato === "in") return "rientro";
  return v.tipo === "depot" ? "deposito" : "trasferimento";
}

/**
 * Collega le corse della giornata ai turni pubblicati. `progettoId`: il
 * programma in esercizio all'inizio della giornata (null se nessuno).
 */
export function collegaTurni(corse: CorsaDaCollegare[], l: LetturaTurni, progettoId: string | null): EsitoCollegamento {
  const perChiave = new Map(corse.map((c) => [c.chiave, c]));
  const contaCodici = new Map<string, number>();
  for (const c of corse) if (c.codice) contaCodici.set(c.codice, (contaCodici.get(c.codice) ?? 0) + 1);
  const perCodice = new Map(corse.filter((c) => c.codice && contaCodici.get(c.codice) === 1).map((c) => [c.codice!, c]));
  /** la corsa del programmato per un id dei turni: per chiave, altrimenti per codice stabile */
  const trova = (tripId: string | null | undefined): CorsaDaCollegare | null => {
    if (!tripId) return null;
    const c = perChiave.get(tripId);
    if (c) return c;
    const codice = l.codiceDi.get(tripId);
    return codice ? perCodice.get(codice) ?? null : null;
  };

  const perCorsa = new Map<string, TurniDellaCorsa>();
  const vuota = (): TurniDellaCorsa => ({ udpId: null, dssId: null, vssId: null, turnoMacchina: null, turnoGuida: null, deposito: null, depositoId: null });
  const di = (chiave: string) => { let t = perCorsa.get(chiave); if (!t) { t = vuota(); perCorsa.set(chiave, t); } return t; };

  /* ogni turni macchina una volta sola, con l'UDP e i turni guida della prima riga che lo pubblica */
  const rigaDelVss = new Map<string, RigaDelCanale>();
  for (const r of l.canale) if (!rigaDelVss.has(r.vssId)) rigaDelVss.set(r.vssId, r);

  const turniMacchina: RigaTurnoMacchina[] = [];
  const fuoriProgramma = new Set<string>();
  let doppieMacchina = 0, codiciRipetuti = 0;
  for (const [vssId, riga] of rigaDelVss) {
    const visti = new Map<string, number>();
    for (const t of l.turniMacchina.filter((x) => x.vssId === vssId)) {
      /* un codice ripetuto nello stesso calcolo non deve far perdere un turno */
      const n = (visti.get(t.codice) ?? 0) + 1;
      visti.set(t.codice, n);
      if (n > 1) codiciRipetuti++;
      const codice = n > 1 ? `${t.codice}#${n}` : t.codice;
      const depositoId = t.depositoId ?? riga.depositoId;
      const deposito = t.deposito ?? (t.depositoId ? null : riga.deposito);
      let corseDelTurno = 0, nelGiorno = 0;
      for (const v of t.voci) {
        if (v.tipo !== "trip" || !v.tripId) continue;
        corseDelTurno++;
        const c = trova(v.tripId);
        if (!c) { fuoriProgramma.add(v.tripId); continue; }
        nelGiorno++;
        const x = di(c.chiave);
        if (x.turnoMacchina != null) { doppieMacchina++; continue; }
        Object.assign(x, { udpId: riga.udpId, vssId, turnoMacchina: codice, deposito, depositoId });
      }
      const tempi = t.voci.flatMap((v) => [v.partenza, v.arrivo]).filter((m): m is number => m != null);
      turniMacchina.push({
        vssId, turnoMacchina: codice, dssId: riga.dssId, udpId: riga.udpId, udpNome: riga.udpNome,
        deposito, depositoId, tipoMezzo: t.tipoMezzo,
        uscita: orario(tempi.length ? Math.min(...tempi) : t.inizio),
        rientro: orario(tempi.length ? Math.max(...tempi) : t.fine),
        corse: corseDelTurno, corseNelGiorno: nelGiorno,
        kmVuotoProg: Math.max(0, t.kmVuoto ?? t.voci.reduce((s, v) => s + (v.km ?? 0), 0)),
        vuoti: t.voci.filter((v) => v.tipo === "deadhead" || v.tipo === "depot").map((v) => ({
          tipo: tipoVuoto(v), da: v.da, a: v.a, partenza: orario(v.partenza), arrivo: orario(v.arrivo), km: v.km,
        })),
      });
    }
  }

  /* i turni guida: ogni corsa con il suo, dai turni guida pubblicati */
  const dssPubblicati = new Map(l.canale.map((r) => [r.dssId, r]));
  const codiciGuida = new Set<string>();
  let doppieGuida = 0, vettureDiverse = 0;
  for (const g of l.corseGuida) {
    const riga = dssPubblicati.get(g.dssId);
    if (!riga) continue;
    codiciGuida.add(`${g.dssId}|${g.codice}`);
    const c = trova(g.tripId);
    if (!c) { fuoriProgramma.add(g.tripId); continue; }
    const x = di(c.chiave);
    if (x.turnoGuida != null) { if (x.turnoGuida !== g.codice || x.dssId !== g.dssId) doppieGuida++; continue; }
    x.turnoGuida = g.codice;
    x.dssId = g.dssId;
    x.udpId ??= riga.udpId;
    if (g.vettura && x.turnoMacchina && x.vssId === riga.vssId && g.vettura !== x.turnoMacchina.replace(/#\d+$/, "")) vettureDiverse++;
  }

  /* le corse senza turno macchina, e perché */
  const scoperteCalcolo = new Set<string>();
  for (const [vssId, ids] of l.scoperteDelCalcolo) {
    if (!rigaDelVss.has(vssId)) continue;
    for (const id of ids) { const c = trova(id); if (c) scoperteCalcolo.add(c.chiave); }
  }
  const udpPubblicate = [...new Set(l.canale.map((r) => r.udpId))];
  const udpNote = udpPubblicate.length > 0 && udpPubblicate.every((u) => Array.isArray(l.corseUdp.get(u)));
  const nelleUdp = new Set<string>();
  if (udpNote) for (const u of udpPubblicate) for (const id of l.corseUdp.get(u) ?? []) { const c = trova(id); if (c) nelleUdp.add(c.chiave); }
  const pubblicato = l.canale.length > 0;
  const motivo = (c: CorsaDaCollegare): MotivoScoperta => {
    if (!pubblicato) return "nessun_turno_pubblicato";
    if (scoperteCalcolo.has(c.chiave)) return "scoperta_nel_calcolo";
    if (udpNote && !nelleUdp.has(c.chiave)) return "fuori_udp";
    return "non_nel_calcolo";
  };
  const senzaMacchina = corse.filter((c) => !perCorsa.get(c.chiave)?.turnoMacchina);
  const motivi = senzaMacchina.map((c) => ({ c, m: motivo(c) }));
  const senzaGuida = corse.filter((c) => perCorsa.get(c.chiave)?.turnoMacchina && !perCorsa.get(c.chiave)?.turnoGuida);
  const quanti = (m: MotivoScoperta) => motivi.filter((x) => x.m === m).length;

  const kmTurni = Math.round(turniMacchina.reduce((s, t) => s + t.kmVuotoProg, 0) * 10) / 10;
  const kmSalvati = [...rigaDelVss.keys()].map((id) => l.kmRiepilogo.get(id) ?? null);
  const kmRiepilogo = kmSalvati.length && kmSalvati.every((k) => k != null)
    ? Math.round(kmSalvati.reduce((s, k) => s + k!, 0) * 10) / 10 : null;

  const riepilogo: RiepilogoTurni = {
    istante: l.istante,
    pubblicato,
    udp: l.canale.map((r) => ({
      udpId: r.udpId, udpNome: r.udpNome, dssId: r.dssId, dssNome: r.dssNome, vssId: r.vssId, vssNome: r.vssNome,
      progettoId: r.progettoId, dssSuperato: r.dssSuperato, dssDatiSuperati: r.dssDatiSuperati, vssSuperato: r.vssSuperato,
    })),
    altroProgramma: progettoId ? l.canale.filter((r) => r.progettoId && r.progettoId !== progettoId).length : null,
    corse: corse.length,
    conTurnoMacchina: corse.length - senzaMacchina.length,
    conTurnoGuida: corse.filter((c) => perCorsa.get(c.chiave)?.turnoGuida).length,
    scoperte: {
      senzaTurnoMacchina: senzaMacchina.length,
      fuoriUdp: pubblicato && udpNote ? quanti("fuori_udp") : null,
      scoperteNelCalcolo: quanti("scoperta_nel_calcolo"),
      nonNelCalcolo: quanti("non_nel_calcolo"),
      senzaTurnoGuida: senzaGuida.length,
      esempi: pubblicato
        ? [...motivi.map(({ c, m }) => ({ trip: c.codice ?? c.chiave, linea: c.linea, partenza: c.partenza, motivo: m as RiepilogoTurni["scoperte"]["esempi"][number]["motivo"] })),
           ...senzaGuida.map((c) => ({ trip: c.codice ?? c.chiave, linea: c.linea, partenza: c.partenza, motivo: "senza_turno_guida" as const }))].slice(0, ESEMPI)
        : [],
    },
    turniMacchina: turniMacchina.length,
    turniGuida: codiciGuida.size,
    corseDeiTurniFuoriProgramma: { quante: fuoriProgramma.size, esempi: [...fuoriProgramma].slice(0, ESEMPI) },
    doppie: { macchina: doppieMacchina, guida: doppieGuida },
    vettureDiverse,
    codiciRipetuti,
    kmVuoto: { turni: kmTurni, riepilogo: kmRiepilogo },
  };
  return { perCorsa, turniMacchina, riepilogo, avvisi: avvisiDei(riepilogo, turniMacchina.length) };
}

/** Gli avvisi della giornata, in parole. */
function avvisiDei(r: RiepilogoTurni, turni: number): string[] {
  const a: string[] = [];
  if (!r.pubblicato) {
    if (r.corse > 0) a.push("Nessun turno pubblicato per la giornata: le corse non hanno turno macchina né turno guida.");
    return a;
  }
  const s = r.scoperte;
  if (s.senzaTurnoMacchina) {
    const parti = [
      s.fuoriUdp ? `${s.fuoriUdp} fuori dalle UDP pubblicate` : null,
      s.scoperteNelCalcolo ? `${s.scoperteNelCalcolo} lasciate scoperte dal calcolo dei turni macchina` : null,
      s.nonNelCalcolo ? `${s.nonNelCalcolo} non comprese nel calcolo` : null,
    ].filter(Boolean);
    a.push(`${s.senzaTurnoMacchina} corse senza turno macchina${parti.length ? ` (${parti.join(", ")})` : ""}.`);
  }
  if (s.senzaTurnoGuida) a.push(`${s.senzaTurnoGuida} corse con il turno macchina ma senza turno guida.`);
  const dss = r.udp.filter((u) => u.dssSuperato).length;
  if (dss) a.push(`I turni guida pubblicati di ${dss} UDP hanno una versione più nuova, non pubblicata.`);
  const dati = r.udp.filter((u) => u.dssDatiSuperati).length;
  if (dati) a.push(`I turni guida pubblicati di ${dati} UDP sono calcolati su dati poi cambiati (corse o orari).`);
  const vss = r.udp.filter((u) => u.vssSuperato).length;
  if (vss) a.push(`I turni macchina pubblicati di ${vss} UDP hanno una versione più nuova, non pubblicata.`);
  if (r.altroProgramma) a.push(`I turni pubblicati di ${r.altroProgramma} UDP sono di un programma diverso da quello in esercizio.`);
  if (r.corseDeiTurniFuoriProgramma.quante) a.push(`${r.corseDeiTurniFuoriProgramma.quante} corse dei turni pubblicati non sono nel programmato della giornata.`);
  if (r.doppie.macchina) a.push(`${r.doppie.macchina} corse in più di un turno macchina pubblicato: vale il primo.`);
  if (r.doppie.guida) a.push(`${r.doppie.guida} corse in più di un turno guida pubblicato: vale il primo.`);
  if (r.vettureDiverse) a.push(`${r.vettureDiverse} corse hanno nel turno guida una vettura diversa dal loro turno macchina.`);
  if (r.codiciRipetuti) a.push(`${r.codiciRipetuti} turni macchina con un codice ripetuto nello stesso calcolo: si distinguono con #2, #3…`);
  /* i km salvati sono arrotondati al decimo per turno: si tollera mezzo decimo a turno */
  if (r.kmVuoto.riepilogo != null && Math.abs(r.kmVuoto.turni - r.kmVuoto.riepilogo) > 0.05 * (turni + 1)) {
    a.push(`I km a vuoto dei turni macchina (${r.kmVuoto.turni}) non tornano col riepilogo salvato del calcolo (${r.kmVuoto.riepilogo}).`);
  }
  return a;
}

/* ── La lettura dal database ─────────────────────────────────────────────── */

const lista = (xs: string[]) => sql`(SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb) x)`;
const arrayDi = (campo: ReturnType<typeof sql>) => sql`CASE WHEN jsonb_typeof(${campo}) = 'array' THEN ${campo} ELSE '[]'::jsonb END`;

/**
 * Quello che serve a collegare i turni della giornata, letto all'istante
 * `istante` (un'espressione SQL timestamptz): il canale com'era allora e i
 * turni che pubblicava. Prende il lucchetto del canale condiviso: una
 * pubblicazione in corso finisce prima, e la si vede.
 */
export async function leggiTurni(ex: any, giorno: string, istante: ReturnType<typeof sql>, corse: CorsaDaCollegare[]): Promise<LetturaTurni> {
  await ex.execute(sql`SELECT pg_advisory_xact_lock_shared(${CHIAVE_CANALE})`);
  const quando = righe(await ex.execute(sql`SELECT (${istante})::timestamptz AS t`))[0]?.t;
  const t = new Date(quando).toISOString();
  const canale: RigaDelCanale[] = righe(await ex.execute(sql`
    SELECT r.udp_id::text AS udp, r.udp_nome, r.dss_id::text AS dss, r.dss_nome, r.vss_id::text AS vss, s.name AS vss_nome,
           r.ps_project_id::text AS progetto,
           d.superseded_by IS NOT NULL AS dss_superato, d.stale_since IS NOT NULL AS dss_dati,
           s.superseded_by IS NOT NULL AS vss_superato, s.depot_id::text AS deposito_id, dp.name AS deposito
      FROM roster_turni_pubblicati r
      JOIN roster_pubblicazioni p ON p.id = r.pubblicazione_id
      LEFT JOIN roster_pubblicazioni q ON q.id = r.sostituita_da
      JOIN driver_shift_scenarios d ON d.id = r.dss_id
      JOIN service_program_scenarios s ON s.id = r.vss_id
      LEFT JOIN depots dp ON dp.id = s.depot_id
     WHERE r.day = ${giorno}::date AND p.creata_il <= ${t}::timestamptz
       AND (q.id IS NULL OR q.creata_il > ${t}::timestamptz)
     ORDER BY r.udp_nome NULLS LAST, r.udp_id`)).map((x) => ({
    udpId: x.udp, udpNome: x.udp_nome ?? null, dssId: x.dss, dssNome: x.dss_nome ?? null, vssId: x.vss, vssNome: x.vss_nome ?? null,
    progettoId: x.progetto ?? null, dssSuperato: !!x.dss_superato, dssDatiSuperati: !!x.dss_dati, vssSuperato: !!x.vss_superato,
    depositoId: x.deposito_id ?? null, deposito: x.deposito ?? null,
  }));
  const vuota: LetturaTurni = {
    istante: t, canale, turniMacchina: [], corseGuida: [], scoperteDelCalcolo: new Map(), kmRiepilogo: new Map(), corseUdp: new Map(), codiceDi: new Map(),
  };
  if (!canale.length) return vuota;

  const vss = [...new Set(canale.map((r) => r.vssId))];
  const dss = [...new Set(canale.map((r) => r.dssId))];
  const udp = [...new Set(canale.map((r) => r.udpId))];

  /* i turni macchina, dal JSON del risultato: solo i campi che servono */
  const turniMacchina: TurnoMacchinaLetto[] = righe(await ex.execute(sql`
    SELECT v.id::text AS vss, COALESCE(NULLIF(sh.s->>'vehicleId', ''), 'M' || sh.n) AS codice, sh.s->>'vehicleType' AS mezzo,
           COALESCE(sh.s->>'residenzaDepotId', sh.s->'depotOut'->>'id') AS deposito_id,
           COALESCE(sh.s->>'residenzaName', sh.s->'depotOut'->>'name') AS deposito,
           sh.s->'totalDeadheadKm' AS km, sh.s->'startMin' AS inizio, sh.s->'endMin' AS fine,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     't', e->>'type', 'id', e->>'tripId', 'p', e->'departureMin', 'a', e->'arrivalMin', 'km', e->'deadheadKm',
                     'da', e->>'firstStopName', 'al', e->>'lastStopName', 'l', e->>'depotLeg') ORDER BY k), '[]'::jsonb)
              FROM jsonb_array_elements(${arrayDi(sql`sh.s->'trips'`)}) WITH ORDINALITY AS x(e, k)) AS voci
      FROM service_program_scenarios v
      CROSS JOIN LATERAL jsonb_array_elements(${arrayDi(sql`v.result->'shifts'`)}) WITH ORDINALITY AS sh(s, n)
     WHERE v.id IN ${lista(vss)}
     ORDER BY v.id, sh.n`)).map((x) => ({
    vssId: x.vss, codice: String(x.codice), tipoMezzo: x.mezzo ?? null,
    depositoId: x.deposito_id && UUID.test(x.deposito_id) ? x.deposito_id : null, deposito: x.deposito ?? null,
    kmVuoto: numero(x.km), inizio: numero(x.inizio), fine: numero(x.fine),
    voci: (Array.isArray(x.voci) ? x.voci : []).map((v: any) => ({
      tipo: String(v.t ?? "trip"), tripId: v.id ? String(v.id) : null, partenza: numero(v.p), arrivo: numero(v.a),
      km: numero(v.km), da: v.da ?? null, a: v.al ?? null, lato: v.l ?? null,
    })),
  }));

  const scoperteDelCalcolo = new Map<string, string[]>();
  const kmRiepilogo = new Map<string, number | null>();
  for (const x of righe(await ex.execute(sql`
    SELECT v.id::text AS vss, v.result->'summary'->'totalDeadheadKm' AS km,
           (SELECT COALESCE(jsonb_agg(u->>'tripId'), '[]'::jsonb)
              FROM jsonb_array_elements(${arrayDi(sql`v.result->'unassigned'`)}) u WHERE COALESCE(u->>'tripId', '') <> '') AS scoperte
      FROM service_program_scenarios v WHERE v.id IN ${lista(vss)}`))) {
    scoperteDelCalcolo.set(x.vss, Array.isArray(x.scoperte) ? x.scoperte.map(String) : []);
    kmRiepilogo.set(x.vss, numero(x.km));
  }

  /* le corse dei turni guida, con la vettura (il turno macchina) su cui le fanno */
  const corseGuida: CorsaDiTurnoGuida[] = righe(await ex.execute(sql`
    SELECT d.id::text AS dss, COALESCE(a.e->>'driverId', a.e->>'dutyId', a.e->>'id', 'T' || a.n) AS codice,
           t->>'tripId' AS trip, t->>'vehicleId' AS vettura
      FROM driver_shift_scenarios d
      CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(d.result->'driverShifts') = 'array' THEN d.result->'driverShifts'
                  WHEN jsonb_typeof(d.result->'duties') = 'array' THEN d.result->'duties'
                  ELSE '[]'::jsonb END) WITH ORDINALITY AS a(e, n)
      CROSS JOIN LATERAL jsonb_array_elements(${arrayDi(sql`a.e->'riprese'`)}) r
      CROSS JOIN LATERAL jsonb_array_elements(${arrayDi(sql`r->'trips'`)}) t
     WHERE d.id IN ${lista(dss)} AND COALESCE(t->>'type', 'trip') = 'trip' AND COALESCE(t->>'tripId', '') <> ''
     ORDER BY d.id, a.n`)).map((x) => ({ dssId: x.dss, codice: String(x.codice), tripId: String(x.trip), vettura: x.vettura ?? null }));

  /* le corse delle UDP di oggi (null se l'UDP non c'è più: ricalcolata o cancellata) */
  const corseUdp = new Map<string, string[] | null>(udp.map((u) => [u, null]));
  for (const x of righe(await ex.execute(sql`SELECT id::text, trip_ids FROM ps_validity_units WHERE id IN ${lista(udp)}`))) {
    corseUdp.set(x.id, Array.isArray(x.trip_ids) ? x.trip_ids.map(String) : []);
  }

  /* il codice stabile delle corse di Planning Studio citate e non riconosciute per chiave */
  const chiavi = new Set(corse.map((c) => c.chiave));
  const daCercare = new Set<string>();
  const cita = (id: string | null | undefined) => { if (id && !chiavi.has(id) && UUID.test(id)) daCercare.add(id); };
  for (const tm of turniMacchina) for (const v of tm.voci) if (v.tipo === "trip") cita(v.tripId);
  for (const g of corseGuida) cita(g.tripId);
  for (const ids of scoperteDelCalcolo.values()) ids.forEach(cita);
  for (const ids of corseUdp.values()) (ids ?? []).forEach(cita);
  const codiceDi = new Map<string, string>();
  if (daCercare.size) {
    for (const x of righe(await ex.execute(sql`SELECT id::text, codice FROM ps_trips WHERE id IN ${lista([...daCercare])}`))) {
      if (x.codice) codiceDi.set(x.id, String(x.codice));
    }
  }
  return { istante: t, canale, turniMacchina, corseGuida, scoperteDelCalcolo, kmRiepilogo, corseUdp, codiceDi };
}

/**
 * Scrive i turni della giornata (dentro la transazione di chi prepara):
 * i turni macchina e il riepilogo. I turni di ogni corsa li scrive chi
 * inserisce o aggiorna le corse.
 */
export async function scriviTurniMacchina(ex: any, giorno: string, e: EsitoCollegamento): Promise<void> {
  await ex.execute(sql`DELETE FROM esercizio_turni_macchina WHERE giorno = ${giorno}::date`);
  for (let i = 0; i < e.turniMacchina.length; i += 300) {
    const blocco = e.turniMacchina.slice(i, i + 300);
    await ex.execute(sql`
      INSERT INTO esercizio_turni_macchina (giorno, vss_id, turno_macchina, dss_id, udp_id, udp_nome, deposito, deposito_id,
                                            tipo_mezzo, uscita, rientro, corse, corse_nel_giorno, km_vuoto_prog, vuoti)
      SELECT ${giorno}::date, x.vss_id, x.turno_macchina, x.dss_id, x.udp_id, x.udp_nome, x.deposito, x.deposito_id,
             x.tipo_mezzo, x.uscita, x.rientro, x.corse, x.corse_nel_giorno, x.km_vuoto_prog, COALESCE(x.vuoti, '[]'::jsonb)
        FROM jsonb_to_recordset(${JSON.stringify(blocco.map((t) => ({
          vss_id: t.vssId, turno_macchina: t.turnoMacchina, dss_id: t.dssId, udp_id: t.udpId, udp_nome: t.udpNome,
          deposito: t.deposito, deposito_id: t.depositoId, tipo_mezzo: t.tipoMezzo, uscita: t.uscita, rientro: t.rientro,
          corse: t.corse, corse_nel_giorno: t.corseNelGiorno, km_vuoto_prog: Math.round(t.kmVuotoProg * 1000) / 1000, vuoti: t.vuoti,
        })))}::jsonb) AS x(vss_id uuid, turno_macchina text, dss_id uuid, udp_id uuid, udp_nome text, deposito text, deposito_id uuid,
                           tipo_mezzo text, uscita text, rientro text, corse integer, corse_nel_giorno integer,
                           km_vuoto_prog numeric, vuoti jsonb)`);
  }
}
