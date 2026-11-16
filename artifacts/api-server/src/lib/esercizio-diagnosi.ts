/**
 * La diagnosi di una giornata di esercizio (tappa 4, primo passo del servizio
 * del giorno; analisi, «Tappe in PR piccole», PR 1). Sola lettura.
 *
 * Prima di congelare il programmato di ogni giornata servono dei numeri,
 * per decidere due cose ancora aperte:
 *   - la chiave della corsa fra programma e AVM (per id, per codice, per
 *     numero di corsa);
 *   - che cosa fa fede come programmato: il feed in esercizio o i turni
 *     pubblicati, e quanto divergono.
 *
 * Per la giornata D (taglio alle 03:00, lib/service-day.ts) dice:
 *   - il programma e il feed in esercizio all'inizio di D, dallo storico delle
 *     attivazioni (non il feed acceso oggi: il passato non si ricalcola sul
 *     presente);
 *   - il feed su cui l'AVM aggancia oggi, e se è lo stesso;
 *   - le corse programmate in D (la regola GTFS: settimana nel periodo, meno
 *     le date tolte, più quelle aggiunte, come l'aggancio e la copertura);
 *   - quante si collegano alle prove dell'AVM di D (coppie di codici e
 *     passaggi): per id, per codice stabile, per numero di corsa;
 *   - i numeri di corsa ripetuti nel giorno e i viaggi dell'AVM che non si
 *     riconducono a nessuna corsa del programma;
 *   - le corse senza geometria e i km del giorno dalla geometria;
 *   - i turni pubblicati di D: se ci sono, se sono del programma in
 *     esercizio, se superati, e quante corse restano fuori dalle UDP.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { inizioDi } from "./service-day";
import { codiceCorsaDi } from "./siri-vm";
import { lunghezzaDellaGeometria } from "./km-programmati";

const ESEMPI = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const righe = (r: any): any[] => r?.rows ?? r ?? [];
const lista = (xs: unknown[]) => sql`(SELECT jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;
const tabellaMancante = (e: any) => ["42P01", "3F000"].includes(e?.cause?.code ?? e?.code);
const pct = (n: number, tot: number) => (tot > 0 ? Math.round((n / tot) * 1000) / 10 : null);

export interface CorsaDelGiorno {
  tripId: string;
  routeId: string | null;
  linea: string | null;
  shapeId: string | null;
  partenza: string | null;
  /** il codice stabile di Planning Studio, se la corsa ne viene */
  codice: string | null;
  /** il numero di corsa: l'ultima parte del codice (o del trip_id) */
  numero: string;
}

/** Il programma (progetto e feed) in esercizio all'inizio della giornata. */
export async function programmaAllInizio(giorno: string) {
  const r = righe(await db.execute(sql`
    SELECT l.feed_id::text AS feed_id, l.project_id::text AS project_id, l.via,
           l.activated_at, f.filename, p.name AS progetto
      FROM ps_activation_log l
      LEFT JOIN gtfs_feeds f ON f.id = l.feed_id
      LEFT JOIN ps_projects p ON p.id = l.project_id
     WHERE l.activated_at <= ${inizioDi(giorno)}
       AND (l.deactivated_at IS NULL OR l.deactivated_at > ${inizioDi(giorno)})
     ORDER BY l.activated_at DESC LIMIT 1`));
  const x = r[0];
  return x ? {
    feedId: x.feed_id as string, progettoId: (x.project_id as string | null) ?? null, progetto: x.progetto ?? null,
    file: x.filename ?? null, via: x.via ?? null, attivatoIl: x.activated_at ? new Date(x.activated_at).toISOString() : null,
  } : null;
}

/**
 * Le corse di un feed che circolano nel giorno: settimana del calendario nel
 * periodo, meno le date tolte, più quelle aggiunte (la regola dell'aggancio,
 * siri-ingest, e della copertura, operations).
 */
export async function corseDelFeedNelGiorno(feedId: string, giorno: string): Promise<CorsaDelGiorno[]> {
  const ymd = giorno.replace(/-/g, "");
  const r = righe(await db.execute(sql`
    WITH attivi AS (
      SELECT c.service_id FROM gtfs_calendar c
       WHERE c.feed_id = ${feedId}::uuid AND c.start_date <= ${ymd} AND c.end_date >= ${ymd}
         AND CASE EXTRACT(ISODOW FROM ${giorno}::date)::int
               WHEN 1 THEN c.monday    WHEN 2 THEN c.tuesday WHEN 3 THEN c.wednesday
               WHEN 4 THEN c.thursday  WHEN 5 THEN c.friday  WHEN 6 THEN c.saturday
               ELSE c.sunday END = 1
         AND NOT EXISTS (SELECT 1 FROM gtfs_calendar_dates x
                          WHERE x.feed_id = c.feed_id AND x.service_id = c.service_id
                            AND x.date = ${ymd} AND x.exception_type = 2)
      UNION
      SELECT a.service_id FROM gtfs_calendar_dates a
       WHERE a.feed_id = ${feedId}::uuid AND a.date = ${ymd} AND a.exception_type = 1
    )
    SELECT t.trip_id, t.route_id, t.shape_id, r.route_short_name,
           (SELECT min(st.departure_time) FROM gtfs_stop_times st
             WHERE st.feed_id = t.feed_id AND st.trip_id = t.trip_id) AS partenza
      FROM gtfs_trips t
      JOIN attivi a ON a.service_id = t.service_id
      LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
     WHERE t.feed_id = ${feedId}::uuid
     ORDER BY t.trip_id`));
  /* il codice stabile: le corse dei feed di Planning Studio hanno per trip_id l'id della corsa */
  const ids = r.map(x => String(x.trip_id)).filter(id => UUID.test(id));
  const codici = new Map<string, string>();
  if (ids.length) {
    for (const x of righe(await db.execute(sql`
      SELECT id::text AS id, codice FROM ps_trips WHERE id::text IN ${lista(ids)}`))) codici.set(x.id, x.codice);
  }
  return r.map(x => {
    const tripId = String(x.trip_id), codice = codici.get(tripId) ?? null;
    return {
      tripId, routeId: x.route_id ?? null, linea: x.route_short_name ?? null, shapeId: x.shape_id ?? null,
      partenza: x.partenza ?? null, codice, numero: codiceCorsaDi(codice ?? tripId),
    };
  });
}

/** Le prove dell'AVM della giornata: coppie di codici e corse con passaggi. Null se Caronte non c'è. */
async function proveDelGiorno(giorno: string) {
  try {
    const viaggi = righe(await db.execute(sql`
      SELECT journey_ref, COALESCE(trip_id, '') AS trip_id, matched_by, course_ref, line_ref, avm_departure
        FROM caronte.journey_codes WHERE day = ${giorno}::date`));
    const passaggi = righe(await db.execute(sql`
      SELECT DISTINCT trip_id FROM caronte.stop_transits
       WHERE actual_ts >= ${inizioDi(giorno)} AND actual_ts < ${inizioDi(sql`${giorno}::date + 1`)}
         AND trip_id IS NOT NULL AND trip_id <> ''`)).map(x => String(x.trip_id));
    return { viaggi, passaggi };
  } catch (e) {
    if (tabellaMancante(e)) return null;
    throw e;
  }
}

export async function diagnosiDelGiorno(giorno: string, feedAvmOggi: string | null) {
  const avvisi: string[] = [];
  const confini = righe(await db.execute(sql`
    SELECT ${inizioDi(giorno)} AS inizio, ${inizioDi(sql`${giorno}::date + 1`)} AS fine`))[0];
  const programma = await programmaAllInizio(giorno);
  if (!programma) avvisi.push("Nello storico delle attivazioni nessun programma era in esercizio all'inizio della giornata: le corse si contano sul feed dell'AVM.");
  const feedId = programma?.feedId ?? feedAvmOggi;
  const feedAvmFile = feedAvmOggi
    ? righe(await db.execute(sql`SELECT filename FROM gtfs_feeds WHERE id = ${feedAvmOggi}::uuid`))[0]?.filename ?? null
    : null;
  if (programma && feedAvmOggi && programma.feedId !== feedAvmOggi) {
    avvisi.push("L'AVM oggi aggancia un feed diverso dal programma in esercizio in quella giornata: le prove si collegano per codice o numero, non per id.");
  }

  const corse = feedId ? await corseDelFeedNelGiorno(feedId, giorno) : [];
  if (feedId && corse.length === 0) avvisi.push("Il calendario del feed non ha corse in questa giornata.");

  /* numeri di corsa ripetuti nel giorno: per numero non si possono agganciare */
  const perNumero = new Map<string, CorsaDelGiorno[]>();
  for (const c of corse) perNumero.set(c.numero, [...(perNumero.get(c.numero) ?? []), c]);
  const ripetuti = [...perNumero].filter(([, l]) => l.length > 1);

  /* collegamento con le prove dell'AVM */
  const prove = await proveDelGiorno(giorno);
  let collegamento: any = null, viaggiAvm: any = null;
  if (prove) {
    const tripAvm = new Set([...prove.viaggi.map(v => String(v.trip_id)).filter(Boolean), ...prove.passaggi]);
    const numeriAvm = new Set(prove.viaggi.map(v => String(v.course_ref ?? "")).filter(Boolean));
    let id = 0, codice = 0, numero = 0, almenoUno = 0;
    for (const c of corse) {
      const a = tripAvm.has(c.tripId), b = !!c.codice && tripAvm.has(c.codice);
      const n = numeriAvm.has(c.numero) && (perNumero.get(c.numero)?.length ?? 0) === 1;
      if (a) id++;
      if (b) codice++;
      if (n) numero++;
      if (a || b || n) almenoUno++;
    }
    collegamento = {
      corse: corse.length,
      perId: id, perCodice: codice, perNumero: numero, almenoUno,
      quota: { perId: pct(id, corse.length), perCodice: pct(codice, corse.length), perNumero: pct(numero, corse.length), almenoUno: pct(almenoUno, corse.length) },
    };
    /* i viaggi dell'AVM che non si riconducono a nessuna corsa del programma */
    const ids = new Set(corse.map(c => c.tripId)), cod = new Set(corse.map(c => c.codice).filter(Boolean) as string[]);
    const num = new Set(corse.map(c => c.numero));
    const perModo: Record<string, number> = {};
    for (const v of prove.viaggi) { const k = v.matched_by ?? (v.trip_id ? "id" : "nessuno"); perModo[k] = (perModo[k] ?? 0) + 1; }
    const fuori = prove.viaggi.filter(v => {
      const t = String(v.trip_id ?? "");
      return !(t && (ids.has(t) || cod.has(t))) && !(v.course_ref && num.has(String(v.course_ref)));
    });
    viaggiAvm = {
      viaggi: new Set(prove.viaggi.map(v => v.journey_ref)).size,
      agganciati: prove.viaggi.filter(v => v.trip_id).length,
      perModo,
      corseConPassaggi: prove.passaggi.length,
      nonRiconducibili: fuori.length,
      esempi: fuori.slice(0, ESEMPI).map(v => ({ linea: v.line_ref ?? null, partenza: v.avm_departure ?? null, numero: v.course_ref ?? null })),
    };
    if (prove.viaggi.length === 0 && prove.passaggi.length === 0) avvisi.push("Nessuna prova dell'AVM in questa giornata.");
  } else {
    avvisi.push("Le tabelle dell'AVM (schema caronte) non ci sono: il collegamento con le prove non si calcola.");
  }

  /* geometria e km del giorno */
  let geometria: any = null;
  if (feedId) {
    const lunghezze = new Map<string, number>();
    for (const x of righe(await db.execute(sql`SELECT shape_id, geojson FROM gtfs_shapes WHERE feed_id = ${feedId}::uuid`))) {
      lunghezze.set(String(x.shape_id), lunghezzaDellaGeometria(x.geojson));
    }
    const senza = corse.filter(c => !c.shapeId || !(lunghezze.get(c.shapeId)! > 0));
    const metri = corse.reduce((s, c) => s + (c.shapeId ? lunghezze.get(c.shapeId) ?? 0 : 0), 0);
    const analisi = righe(await db.execute(sql`
      SELECT total_km_day FROM gtfs_feed_analysis WHERE feed_id = ${feedId}::uuid ORDER BY computed_at DESC NULLS LAST LIMIT 1`))[0];
    geometria = {
      senzaGeometria: senza.length,
      esempi: senza.slice(0, ESEMPI).map(c => ({ trip: c.codice ?? c.tripId, linea: c.linea, partenza: c.partenza })),
      kmGiorno: Math.round(metri / 100) / 10,
      kmAnalisiFeed: analisi?.total_km_day != null ? Number(analisi.total_km_day) : null,
    };
  }

  /* turni pubblicati della giornata */
  const pubblicati = righe(await db.execute(sql`
    SELECT p.udp_id::text AS udp, p.ps_project_id::text AS progetto, u.trip_ids,
           d.superseded_by IS NOT NULL AS dss_superato, d.stale_since IS NOT NULL AS dss_dati_superati,
           s.superseded_by IS NOT NULL AS vss_superato
      FROM roster_turni_pubblicati p
      JOIN driver_shift_scenarios d ON d.id = p.dss_id
      JOIN service_program_scenarios s ON s.id = p.vss_id
      LEFT JOIN ps_validity_units u ON u.id = p.udp_id
     WHERE p.day = ${giorno}::date AND p.sostituita_da IS NULL`));
  let turni: any = { pubblicato: false };
  if (pubblicati.length) {
    const tripUdp = new Set<string>();
    for (const p of pubblicati) for (const t of Array.isArray(p.trip_ids) ? p.trip_ids : []) tripUdp.add(String(t));
    const codiciUdp = new Set<string>();
    const idsUdp = [...tripUdp].filter(id => UUID.test(id));
    if (idsUdp.length) {
      for (const x of righe(await db.execute(sql`SELECT codice FROM ps_trips WHERE id::text IN ${lista(idsUdp)}`))) codiciUdp.add(x.codice);
    }
    const fuori = corse.filter(c => !tripUdp.has(c.tripId) && !(c.codice && codiciUdp.has(c.codice)));
    turni = {
      pubblicato: true,
      udp: pubblicati.length,
      altroProgramma: programma?.progettoId ? pubblicati.filter(p => p.progetto && p.progetto !== programma.progettoId).length : null,
      turniGuidaSuperati: pubblicati.filter(p => p.dss_superato).length,
      turniGuidaSuDatiCambiati: pubblicati.filter(p => p.dss_dati_superati).length,
      turniMacchinaSuperati: pubblicati.filter(p => p.vss_superato).length,
      corseFuoriDalleUdp: fuori.length,
      esempi: fuori.slice(0, ESEMPI).map(c => ({ trip: c.codice ?? c.tripId, linea: c.linea, partenza: c.partenza })),
    };
    if (turni.altroProgramma) avvisi.push("Una parte dei turni pubblicati è di un programma diverso da quello in esercizio.");
  }

  return {
    giorno,
    inizio: new Date(confini.inizio).toISOString(),
    fine: new Date(confini.fine).toISOString(),
    programma,
    feedAvm: feedAvmOggi ? { feedId: feedAvmOggi, file: feedAvmFile, ugualeAlProgramma: programma ? programma.feedId === feedAvmOggi : null } : null,
    corseProgrammate: corse.length,
    numeriRipetuti: {
      quanti: ripetuti.length,
      esempi: ripetuti.slice(0, ESEMPI).map(([n, l]) => ({ numero: n, corse: l.length, linee: [...new Set(l.map(c => c.linea))] })),
    },
    collegamento,
    viaggiAvm,
    geometria,
    turni,
    avvisi,
  };
}
