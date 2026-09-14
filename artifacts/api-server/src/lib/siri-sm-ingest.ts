/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PREVISIONI ALLE PROSSIME FERMATE — il ciclo StopMonitoring
 * ───────────────────────────────────────────────────────────────────────────
 * Il VehicleMonitoring dice dove sta il mezzo e quale corsa fa; non dice mai
 * quando passerà. Lo StopMonitoring di Mizar lo dice, ma per FERMATA: si
 * chiede una fermata e si ricevono i passaggi delle ore successive, con la
 * previsione per i mezzi seguiti.
 *
 * Il ciclo mette insieme le due cose. A ogni giro, per ogni mezzo seguito
 * con una corsa agganciata, si prendono le sue prossime fermate nel feed, si
 * traducono nel codice palina di Mizar con la transcodifica, si chiedono
 * allo StopMonitoring — in una richiesta sola quando il server accetta
 * GetMultipleStopMonitoring, una per fermata altrimenti — e si tengono le
 * previsioni che riguardano le corse attive. Il resto della risposta è
 * orario puro, che abbiamo già.
 *
 * Le previsioni finiscono in una tabella loro (stop-predictions-store): mai
 * in stop_transits, da cui i tempi di percorrenza prendono i numeri.
 *
 * Ciclo minimo dichiarato dal server: un minuto. Qui non si scende sotto.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { postSoap, type SiriEndpointConfig, type GtfsIndex } from "./siri-vm";
import { buildMultipleStopMonitoringRequest, buildStopMonitoringRequest, endpointGemelli } from "./siri-sonda";
import { parseStopMonitoringResponse, unisciVisite, secondiGtfs, secondiLocali, type VisitaFermata } from "./siri-fermata";
import { caricaTranscodifica } from "./stop-aliases";
import { registraPrevisioni, type PrevisioneFermata } from "./stop-predictions-store";

/** Un mezzo seguito con una corsa agganciata, come esce dall'ingestione. */
export interface CorsaAttiva {
  vehicleRef: string;
  tripId: string;
  /** il codice palina della fermata corrente/prossima secondo l'AVM */
  fermataCorrenteRef: string | null;
  /** la stessa, tradotta nel feed (o null) */
  fermataCorrenteId: string | null;
}

export interface FermataProgrammata { stopId: string; seq: number; scheduled: string }

/** Quante fermate avanti si guarda per ogni mezzo. */
export const PROSSIME_FERMATE = 3;
/** Tetto alle fermate chieste per giro: oltre, si chiede troppo per troppo poco. */
export const MAX_FERMATE_PER_GIRO = 60;
/** Il server dichiara PT1M: non si chiede più spesso. */
export const CICLO_MIN_MS = 60_000;

/**
 * Le prossime K fermate di una corsa. Si parte dalla fermata corrente
 * dichiarata dall'AVM se è nella sequenza; altrimenti dalla prima fermata
 * il cui orario programmato non è passato da più di due minuti. Le fermate
 * già passate non servono: lo StopMonitoring non le riporta.
 */
export function prossimeFermate(
  sequenza: FermataProgrammata[], fermataCorrenteId: string | null, oraLocaleSec: number, k = PROSSIME_FERMATE,
): FermataProgrammata[] {
  if (!sequenza.length) return [];
  let da = fermataCorrenteId ? sequenza.findIndex(s => s.stopId === fermataCorrenteId) : -1;
  if (da < 0) {
    da = sequenza.findIndex(s => {
      const t = secondiGtfs(s.scheduled);
      return t != null && t >= oraLocaleSec - 120;
    });
    if (da < 0) return [];
  }
  return sequenza.slice(da, da + k);
}

/**
 * Da una risposta StopMonitoring alle previsioni per le corse attive.
 * Si tiene solo ciò che ha un orario PREVISTO e riguarda una corsa che
 * stiamo seguendo: il resto è l'orario, che abbiamo già dal feed.
 */
export function previsioniDaVisite(
  visite: VisitaFermata[],
  attive: CorsaAttiva[],
  tripByCode: Map<string, string> | undefined,
  aliasFermate: Map<string, string>,
): PrevisioneFermata[] {
  const perTrip = new Map(attive.map(a => [a.tripId, a]));
  const out: PrevisioneFermata[] = [];
  for (const v of unisciVisite(visite)) {
    const expected = v.expectedDeparture ?? v.expectedArrival;
    if (!expected || !v.courseOfJourneyRef) continue;
    const tripId = tripByCode?.get(v.courseOfJourneyRef.trim());
    if (!tripId) continue;
    const attiva = perTrip.get(tripId);
    if (!attiva) continue;
    const ref = (v.stopPointRef ?? v.monitoringRef ?? "").trim();
    const stopId = aliasFermate.get(ref);
    if (!stopId) continue;
    out.push({
      tripId, stopId, mizarRef: ref,
      vehicleRef: v.vehicleRef ?? attiva.vehicleRef,
      lineRef: v.lineRef,
      aimedTs: v.aimedDeparture ?? v.aimedArrival,
      expectedTs: expected,
      stato: v.departureStatus ?? v.arrivalStatus,
      recordedAt: v.statico ? null : v.recordedAt,
    });
  }
  return out;
}

/* ── Il ciclo ────────────────────────────────────────────────────────────── */

export interface EsitoPrevisioni {
  alle: string;
  saltato: string | null;
  mezziSeguiti: number;
  fermateChieste: number;
  richieste: number;
  modalita: "multipla" | "singola" | null;
  visite: number;
  previsioni: number;
  registrate: number;
  errore: string | null;
}

let ultimoCiclo = 0;
let ultimoEsito: EsitoPrevisioni | null = null;
/* Se GetMultipleStopMonitoring risponde con un Fault si passa alle richieste
 * singole e non si riprova per un'ora: il server non cambia idea a ogni giro. */
let multiplaNonDisponibileFinoA = 0;
const sequenze = new Map<string, { feedId: string; fermate: FermataProgrammata[] }>();

export function esitoPrevisioni(): EsitoPrevisioni | null { return ultimoEsito; }

async function sequenzaDi(feedId: string, tripId: string): Promise<FermataProgrammata[]> {
  const c = sequenze.get(tripId);
  if (c && c.feedId === feedId) return c.fermate;
  const r = await db.execute<any>(sql`
    SELECT stop_id, stop_sequence, COALESCE(departure_time, arrival_time) AS t
      FROM gtfs_stop_times
     WHERE feed_id = ${feedId}::uuid AND trip_id = ${tripId}
     ORDER BY stop_sequence`);
  const fermate: FermataProgrammata[] = ((r as any).rows ?? []).map((x: any) => ({
    stopId: String(x.stop_id), seq: Number(x.stop_sequence ?? 0), scheduled: String(x.t ?? ""),
  }));
  if (sequenze.size > 2000) sequenze.clear();
  sequenze.set(tripId, { feedId, fermate });
  return fermate;
}

/**
 * Un giro di previsioni. Non lancia mai: un errore qui non deve fermare
 * l'ingestione del VehicleMonitoring, che è la cosa principale.
 */
export async function aggiornaPrevisioni(
  cfg: SiriEndpointConfig, index: GtfsIndex, attive: CorsaAttiva[], giorno: string,
  opts: { forza?: boolean; now?: number } = {},
): Promise<EsitoPrevisioni> {
  const now = opts.now ?? Date.now();
  const esito: EsitoPrevisioni = {
    alle: new Date(now).toISOString(), saltato: null, mezziSeguiti: attive.length,
    fermateChieste: 0, richieste: 0, modalita: null, visite: 0, previsioni: 0, registrate: 0, errore: null,
  };
  if (!opts.forza && now - ultimoCiclo < CICLO_MIN_MS) {
    esito.saltato = "ciclo minimo di un minuto non ancora trascorso";
    return esito;
  }
  if (!attive.length) { esito.saltato = "nessun mezzo seguito con una corsa agganciata"; ultimoEsito = esito; return esito; }

  const smUrl = process.env.SIRI_SM_URL
    || endpointGemelli(cfg.url).find(g => g.servizio === "StopMonitoring")?.url;
  if (!smUrl) { esito.saltato = "indirizzo dello StopMonitoring sconosciuto (SIRI_SM_URL)"; ultimoEsito = esito; return esito; }
  const alias = index.stopByAlias;
  if (!alias || !alias.size) { esito.saltato = "transcodifica delle paline non caricata"; ultimoEsito = esito; return esito; }

  ultimoCiclo = now;
  try {
    /* stop_id del feed → codice palina di Mizar: l'inverso della transcodifica. */
    const inverso = new Map<string, string>();
    for (const r of caricaTranscodifica().righe) if (!inverso.has(r.stopId)) inverso.set(r.stopId, r.mizarRef);

    const oraSec = secondiLocali(new Date(now), index.timeZone);
    const refs = new Set<string>();
    for (const a of attive) {
      const seq = await sequenzaDi(index.feedId, a.tripId);
      for (const f of prossimeFermate(seq, a.fermataCorrenteId, oraSec)) {
        const ref = inverso.get(f.stopId);
        if (ref) refs.add(ref);
      }
      if (refs.size >= MAX_FERMATE_PER_GIRO) break;
    }
    const daChiedere = [...refs].slice(0, MAX_FERMATE_PER_GIRO);
    esito.fermateChieste = daChiedere.length;
    if (!daChiedere.length) { esito.saltato = "nessuna prossima fermata con codice Mizar"; ultimoEsito = esito; return esito; }

    const smCfg = { ...cfg, url: smUrl };
    let visite: VisitaFermata[] = [];
    const modo = (process.env.SIRI_SM_MODE || "").toLowerCase();
    const provaMultipla = modo !== "single" && now >= multiplaNonDisponibileFinoA;

    if (provaMultipla) {
      const r = await postSoap(smCfg, "GetMultipleStopMonitoring",
        buildMultipleStopMonitoringRequest(cfg.requestorRef, daChiedere, "PT1H", 30));
      esito.richieste = 1;
      const parsed = parseStopMonitoringResponse(r.xml);
      if (!parsed.failed && (parsed.visite.length > 0 || r.ok)) {
        esito.modalita = "multipla";
        visite = parsed.visite;
      } else {
        multiplaNonDisponibileFinoA = now + 60 * 60 * 1000;
        console.warn("[siri] GetMultipleStopMonitoring non disponibile, passo alle richieste singole:", parsed.errorText ?? `HTTP ${r.status}`);
      }
    }
    if (esito.modalita !== "multipla") {
      esito.modalita = "singola";
      /* A gruppi di cinque, per non bombardare il server. */
      for (let i = 0; i < daChiedere.length; i += 5) {
        const gruppo = daChiedere.slice(i, i + 5);
        const risposte = await Promise.all(gruppo.map(ref =>
          postSoap(smCfg, "GetStopMonitoring", buildStopMonitoringRequest(cfg.requestorRef, ref, "PT1H", 30))
            .then(r => parseStopMonitoringResponse(r.xml))
            .catch(e => ({ failed: true, errorText: String(e?.message ?? e), visite: [] as VisitaFermata[] }))));
        esito.richieste += gruppo.length;
        for (const p of risposte) { if (!p.failed) visite.push(...p.visite); else esito.errore = esito.errore ?? (p as any).errorText ?? null; }
      }
    }
    esito.visite = visite.length;

    const previsioni = previsioniDaVisite(visite, attive, index.tripByCode, alias);
    esito.previsioni = previsioni.length;
    esito.registrate = await registraPrevisioni(giorno, previsioni);
  } catch (e: any) {
    esito.errore = e?.message ?? String(e);
    console.warn("[siri] previsioni alle fermate: giro fallito:", esito.errore);
  }
  ultimoEsito = esito;
  return esito;
}

/** Per i collaudi. */
export function resetPrevisioni(): void { ultimoCiclo = 0; ultimoEsito = null; multiplaNonDisponibileFinoA = 0; sequenze.clear(); }
