/**
 * La proposta dall'AVM (tappa 4.4; analisi, «Proposta automatica dall'AVM»,
 * PR 5; migrazione 0027).
 *
 * Per ogni corsa programmata di una giornata congelata, l'esito che le prove
 * dell'AVM suggeriscono, con le prove accanto. È una proposta: decide una
 * persona (giornale e conferma, tappa successiva). Una corsa senza prove
 * resta «non rilevata» e non diventa mai «soppressa» da sola: l'AVM vede
 * una parte delle corse (16,7% in un giorno di ottobre), e dall'assenza di
 * prove non si deduce l'assenza della corsa.
 *
 * La corsa dell'AVM si riconosce nel programmato (decisione presa coi numeri
 * della diagnosi di ottobre: per id 517, per numero 508, per codice 0):
 *   1. per id del feed (la chiave della corsa);
 *   2. per codice stabile (3.1), quando l'AVM aggancia un altro feed dello
 *      stesso programma;
 *   3. per numero di corsa, solo se unico nella giornata.
 *
 * Le proposte, nell'ordine in cui si provano:
 *   - effettuata_avm: una sola vettura, e prima e ultima fermata osservate,
 *     oppure una quota di fermate osservate ≥ S1;
 *   - parziale: partenza osservata, ultima fermata osservata ad almeno S2
 *     fermate dalla fine, e la vettura che passa a un'altra corsa prima
 *     dell'arrivo programmato o non si vede più (fuori servizio);
 *   - continuita: nessuna prova contraria, e la stessa vettura effettua la
 *     corsa precedente e la successiva dello stesso turno macchina;
 *   - da_verificare: qualche prova, ma non basta (più vetture, poche
 *     fermate, solo il viaggio dichiarato senza passaggi);
 *   - soppressione_indizio: nessuna prova, e la corsa annullata dall'AVM
 *     (dalla 4.5) o il suo turno guida senza conducente nel roster;
 *   - non_rilevata: nessuna prova.
 * Le soglie sono la decisione aperta 6: qui i valori di partenza, scritti nel
 * riepilogo di ogni proposta.
 *
 * I viaggi dell'AVM che non si riconducono a nessuna corsa del programmato
 * diventano candidate corse aggiunte.
 *
 * Solo le righe di SIRI (source = 'siri'): il sistema AVM scrive le proprie
 * nelle stesse tabelle, con altri codici.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { FUSO_ESERCIZIO, inizioDi } from "./service-day";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lista = (xs: string[]) => sql`(SELECT x::uuid FROM jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb) x)`;

/** Le soglie (decisione aperta 6): valori di partenza. */
export const SOGLIE = {
  /** S1: quota di fermate osservate per dire «effettuata» */
  quotaFermate: 0.7,
  /** S2: fermate mancanti in fondo per l'indizio di parziale */
  fermateMancanti: 3,
  /** la partenza è osservata se si vede una delle prime fermate (0 = solo il capolinea) */
  partenzaEntro: 1,
  /** dopo l'arrivo programmato, quanto si aspetta la vettura su un'altra corsa (s) */
  marginePassaggio: 300,
} as const;
export type Soglie = { [K in keyof typeof SOGLIE]: number };

export const PROPOSTE = ["effettuata_avm", "parziale", "continuita", "da_verificare", "soppressione_indizio", "non_rilevata"] as const;
export type Proposta = typeof PROPOSTE[number];
export type Modo = "id" | "codice" | "numero";

export interface CorsaDaProporre {
  chiave: string; codice: string | null; numero: string; linea: string | null;
  partenza: string | null; arrivo: string | null;
  vssId: string | null; turnoMacchina: string | null; dssId: string | null; turnoGuida: string | null;
  /** le fermate programmate, in ordine */
  fermate: Array<{ seq: number; stopId: string }>;
}
/** Un passaggio a una fermata; sec = secondi dalla mezzanotte della giornata (oltre 86400 dopo la mezzanotte). */
export interface TransitoAvm { trip: string; stopId: string; seq: number | null; sec: number; vettura: string | null }
export interface ViaggioAvm {
  journeyRef: string; trip: string | null; vettura: string | null; linea: string | null; numero: string | null;
  partenza: string | null; destinazione: string | null; osservazioni: number;
}
export interface DatiProposta {
  corse: CorsaDaProporre[];
  transiti: TransitoAvm[];
  viaggi: ViaggioAvm[];
  /** codice stabile delle corse di Planning Studio citate dall'AVM per id */
  codiceDi: Map<string, string>;
  /** «dss|turno guida» senza conducente nel roster; null se il roster non dice niente per la giornata */
  turniGuidaScoperti: Set<string> | null;
  /** le corse che l'AVM ha annullato (eventi del giornale, 4.5) */
  cancellate?: Set<string>;
}

export interface ProveCorsa {
  modo: Modo | null;
  trip: string[];
  programmate: number;
  osservate: number;
  /** posizione (da 1) della prima e dell'ultima fermata osservata */
  prima: number | null;
  ultima: number | null;
  vetture: string[];
  partenzaReale: string | null;
  /** secondi, positivo = in ritardo */
  ritardoPartenza: number | null;
  dichiarata: boolean;
  motivo?: string;
  continuita?: { prima: string; dopo: string; vettura: string };
}
export interface AggiuntaProposta {
  chiaveAvm: string; journeyRef: string | null; trip: string | null; linea: string | null; numero: string | null;
  partenza: string | null; destinazione: string | null; vetture: string[]; transiti: number; osservazioni: number;
}
export interface RiepilogoProposta {
  soglie: Soglie;
  corse: number;
  perProposta: Record<Proposta, number>;
  perModo: Record<Modo, number>;
  conProve: number;
  /** quota di corse con passaggi alle fermate */
  copertura: number | null;
  transiti: number;
  transitiRiconosciuti: number;
  viaggi: number;
  viaggiRiconosciuti: number;
  aggiunte: number;
  rosterLetto: boolean;
}
export interface EsitoProposta {
  perCorsa: Map<string, { proposta: Proposta; prove: ProveCorsa }>;
  aggiunte: AggiuntaProposta[];
  riepilogo: RiepilogoProposta;
}

/* ── Orari ───────────────────────────────────────────────────────────────── */

/** «HH:MM[:SS]» in secondi, anche oltre le 24. */
export function secondi(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : null;
}
/** Secondi in «HH:MM:SS», anche oltre le 24. */
export function orarioDi(s: number | null): string | null {
  if (s == null || !Number.isFinite(s) || s < 0) return null;
  const x = Math.round(s);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(x / 3600))}:${p(Math.floor((x % 3600) / 60))}:${p(x % 60)}`;
}

/* ── La proposta (pura) ──────────────────────────────────────────────────── */

const MODI: Modo[] = ["id", "codice", "numero"];
const migliore = (a: Modo | null, b: Modo): Modo => (a == null || MODI.indexOf(b) < MODI.indexOf(a) ? b : a);

export function proponi(d: DatiProposta, soglie: Soglie = SOGLIE): EsitoProposta {
  const perChiave = new Map(d.corse.map((c) => [c.chiave, c]));
  const unici = <K extends "codice" | "numero">(k: K) => {
    const n = new Map<string, number>();
    for (const c of d.corse) { const v = c[k]; if (v) n.set(v, (n.get(v) ?? 0) + 1); }
    return new Map(d.corse.filter((c) => c[k] && n.get(c[k]!) === 1).map((c) => [c[k]!, c]));
  };
  const perCodice = unici("codice"), perNumero = unici("numero");
  /** la corsa di un id dell'AVM: per chiave, poi per codice stabile */
  const perTrip = new Map<string, { c: CorsaDaProporre; modo: Modo } | null>();
  const risolvi = (t: string) => {
    if (perTrip.has(t)) return perTrip.get(t)!;
    const c = perChiave.get(t);
    const r = c ? { c, modo: "id" as Modo }
      : (() => { const k = perCodice.get(d.codiceDi.get(t) ?? t); return k ? { c: k, modo: "codice" as Modo } : null; })();
    perTrip.set(t, r);
    return r;
  };

  interface Raccolta { modo: Modo | null; trip: Set<string>; transiti: TransitoAvm[]; viaggi: ViaggioAvm[] }
  const raccolta = new Map<string, Raccolta>();
  const di = (k: string) => { let r = raccolta.get(k); if (!r) { r = { modo: null, trip: new Set(), transiti: [], viaggi: [] }; raccolta.set(k, r); } return r; };

  /* i viaggi dichiarati: per id o codice; altrimenti per numero, che vale anche per i loro passaggi */
  const viaggiFuori: ViaggioAvm[] = [];
  let viaggiRiconosciuti = 0;
  for (const v of d.viaggi) {
    let r = v.trip ? risolvi(v.trip) : null;
    if (!r && v.numero && perNumero.has(v.numero)) {
      r = { c: perNumero.get(v.numero)!, modo: "numero" };
      if (v.trip && !perTrip.get(v.trip)) perTrip.set(v.trip, r);
    }
    if (!r) { viaggiFuori.push(v); continue; }
    viaggiRiconosciuti++;
    const x = di(r.c.chiave);
    x.modo = migliore(x.modo, r.modo);
    if (v.trip) x.trip.add(v.trip);
    x.viaggi.push(v);
  }
  /* i passaggi alle fermate */
  const transitiFuori = new Map<string, TransitoAvm[]>();
  let transitiRiconosciuti = 0;
  for (const t of d.transiti) {
    const r = risolvi(t.trip);
    if (!r) { const l = transitiFuori.get(t.trip); if (l) l.push(t); else transitiFuori.set(t.trip, [t]); continue; }
    transitiRiconosciuti++;
    const x = di(r.c.chiave);
    x.modo = migliore(x.modo, r.modo);
    x.trip.add(t.trip);
    x.transiti.push(t);
  }

  /* la giornata di ogni vettura, per dire se è passata a un'altra corsa o è uscita di servizio */
  const giornataVettura = new Map<string, Array<{ sec: number; corsa: string | null }>>();
  for (const t of d.transiti) {
    if (!t.vettura) continue;
    const r = risolvi(t.trip);
    const voce = { sec: t.sec, corsa: r?.c.chiave ?? null };
    const l = giornataVettura.get(t.vettura);
    if (l) l.push(voce); else giornataVettura.set(t.vettura, [voce]);
  }

  const perCorsa = new Map<string, { proposta: Proposta; prove: ProveCorsa }>();
  for (const c of d.corse) {
    const x = raccolta.get(c.chiave);
    const n = c.fermate.length;
    const perSeq = new Map(c.fermate.map((f, i) => [f.seq, i]));
    const perFermata = new Map<string, number[]>();
    c.fermate.forEach((f, i) => { const l = perFermata.get(f.stopId); if (l) l.push(i); else perFermata.set(f.stopId, [i]); });
    const visti = new Map<number, number>();
    const vettureFermate = new Set<string>();
    for (const t of x?.transiti ?? []) {
      let i = t.seq != null ? perSeq.get(t.seq) : undefined;
      if (i == null || c.fermate[i]!.stopId !== t.stopId) {
        /* un altro feed numera diverso: vale la fermata, se è una sola nella corsa */
        const l = perFermata.get(t.stopId);
        i = l && l.length === 1 ? l[0] : undefined;
      }
      if (i == null) continue;
      visti.set(i, Math.min(visti.get(i) ?? Infinity, t.sec));
      if (t.vettura) vettureFermate.add(t.vettura);
    }
    const vetture = new Set([...vettureFermate, ...(x?.viaggi ?? []).map((v) => v.vettura).filter((v): v is string => !!v)]);
    const pos = [...visti.keys()];
    const prima = pos.length ? Math.min(...pos) : null, ultima = pos.length ? Math.max(...pos) : null;
    const partenzaReale = visti.has(0) ? visti.get(0)! : null;
    const prog = secondi(c.partenza);
    const prove: ProveCorsa = {
      modo: x?.modo ?? null, trip: [...(x?.trip ?? [])], programmate: n, osservate: visti.size,
      prima: prima == null ? null : prima + 1, ultima: ultima == null ? null : ultima + 1, vetture: [...vetture].sort(),
      partenzaReale: orarioDi(partenzaReale), ritardoPartenza: partenzaReale != null && prog != null ? Math.round(partenzaReale - prog) : null,
      dichiarata: (x?.viaggi.length ?? 0) > 0,
    };
    let proposta: Proposta;
    if (visti.size > 0) {
      const unaVettura = vettureFermate.size <= 1;
      const completa = prima === 0 && ultima === n - 1;
      if (unaVettura && n > 0 && (completa || visti.size / n >= soglie.quotaFermate)) proposta = "effettuata_avm";
      else if (unaVettura && n > 0 && prima! <= soglie.partenzaEntro && n - 1 - ultima! >= soglie.fermateMancanti
        && passaAltrove(c, [...vettureFermate][0], Math.max(...visti.values()), giornataVettura, soglie)) {
        proposta = "parziale";
        prove.motivo = "partenza osservata, fine non osservata, e la vettura passa altrove";
      } else {
        proposta = "da_verificare";
        prove.motivo = !unaVettura ? "più vetture sulla stessa corsa" : "fermate osservate non sufficienti";
      }
    } else if (d.cancellate?.has(c.chiave)) {
      proposta = "soppressione_indizio";
      prove.motivo = "annullata dall'AVM";
    } else if (prove.dichiarata) {
      proposta = "da_verificare";
      prove.motivo = "viaggio dichiarato dall'AVM, senza passaggi alle fermate";
    } else if (d.turniGuidaScoperti && c.dssId && c.turnoGuida && d.turniGuidaScoperti.has(`${c.dssId}|${c.turnoGuida}`)) {
      proposta = "soppressione_indizio";
      prove.motivo = "turno guida senza conducente nel roster";
    } else {
      proposta = "non_rilevata";
    }
    perCorsa.set(c.chiave, { proposta, prove });
  }

  /* continuità: la stessa vettura sulla corsa precedente e sulla successiva del turno macchina */
  const perTurno = new Map<string, CorsaDaProporre[]>();
  for (const c of d.corse) {
    if (!c.vssId || !c.turnoMacchina) continue;
    const k = `${c.vssId}|${c.turnoMacchina}`;
    const l = perTurno.get(k);
    if (l) l.push(c); else perTurno.set(k, [c]);
  }
  const vetturaEffettuata = (c: CorsaDaProporre | undefined) => {
    const p = c && perCorsa.get(c.chiave);
    return p && p.proposta === "effettuata_avm" && p.prove.vetture.length === 1 ? p.prove.vetture[0]! : null;
  };
  const cambi: Array<[string, { proposta: Proposta; prove: ProveCorsa }]> = [];
  for (const l of perTurno.values()) {
    l.sort((a, b) => (secondi(a.partenza) ?? 0) - (secondi(b.partenza) ?? 0));
    l.forEach((c, i) => {
      const p = perCorsa.get(c.chiave)!;
      if (!["non_rilevata", "soppressione_indizio", "da_verificare"].includes(p.proposta)) return;
      const prima = vetturaEffettuata(l[i - 1]), dopo = vetturaEffettuata(l[i + 1]);
      if (!prima || prima !== dopo) return;
      /* nessuna prova contraria: le vetture viste sulla corsa, se ce ne sono, sono quella */
      if (p.prove.vetture.some((v) => v !== prima)) return;
      cambi.push([c.chiave, { proposta: "continuita", prove: { ...p.prove, motivo: undefined, continuita: { prima: l[i - 1]!.chiave, dopo: l[i + 1]!.chiave, vettura: prima } } }]);
    });
  }
  for (const [k, v] of cambi) perCorsa.set(k, v);

  /* le candidate aggiunte: viaggi e passaggi che non si riconducono al programmato */
  const aggiunte = new Map<string, AggiuntaProposta>();
  for (const v of viaggiFuori) {
    const a = aggiunte.get(v.journeyRef);
    if (a) {
      a.osservazioni += v.osservazioni;
      if (v.vettura && !a.vetture.includes(v.vettura)) a.vetture.push(v.vettura);
      continue;
    }
    aggiunte.set(v.journeyRef, {
      chiaveAvm: v.journeyRef, journeyRef: v.journeyRef, trip: v.trip || null, linea: v.linea, numero: v.numero,
      partenza: v.partenza, destinazione: v.destinazione, vetture: v.vettura ? [v.vettura] : [], transiti: 0, osservazioni: v.osservazioni,
    });
  }
  const perTripAggiunta = new Map([...aggiunte.values()].filter((a) => a.trip).map((a) => [a.trip!, a]));
  for (const [trip, ts] of transitiFuori) {
    const vetture = [...new Set(ts.map((t) => t.vettura).filter((v): v is string => !!v))].sort();
    const a = perTripAggiunta.get(trip);
    if (a) { a.transiti += ts.length; for (const v of vetture) if (!a.vetture.includes(v)) a.vetture.push(v); continue; }
    aggiunte.set(`trip:${trip}`, {
      chiaveAvm: `trip:${trip}`, journeyRef: null, trip, linea: null, numero: null,
      partenza: orarioDi(Math.min(...ts.map((t) => t.sec)))?.slice(0, 5) ?? null, destinazione: null, vetture, transiti: ts.length, osservazioni: 0,
    });
  }

  const perProposta = Object.fromEntries(PROPOSTE.map((p) => [p, 0])) as Record<Proposta, number>;
  const perModo: Record<Modo, number> = { id: 0, codice: 0, numero: 0 };
  let conProve = 0;
  for (const { proposta, prove } of perCorsa.values()) {
    perProposta[proposta]++;
    if (prove.modo) perModo[prove.modo]++;
    if (prove.osservate > 0) conProve++;
  }
  return {
    perCorsa,
    aggiunte: [...aggiunte.values()].sort((a, b) => (a.partenza ?? "").localeCompare(b.partenza ?? "") || a.chiaveAvm.localeCompare(b.chiaveAvm)),
    riepilogo: {
      soglie: { ...soglie }, corse: d.corse.length, perProposta, perModo, conProve,
      copertura: d.corse.length ? Math.round((conProve / d.corse.length) * 1000) / 10 : null,
      transiti: d.transiti.length, transitiRiconosciuti, viaggi: d.viaggi.length, viaggiRiconosciuti,
      aggiunte: aggiunte.size, rosterLetto: d.turniGuidaScoperti != null,
    },
  };
}

/** Dopo l'ultima fermata osservata la vettura passa a un'altra corsa prima dell'arrivo programmato, o non si vede più. */
function passaAltrove(c: CorsaDaProporre, vettura: string | undefined, ultimoSec: number,
  giornate: Map<string, Array<{ sec: number; corsa: string | null }>>, soglie: Soglie): boolean {
  if (!vettura) return false;
  const dopo = (giornate.get(vettura) ?? []).filter((x) => x.sec > ultimoSec && x.corsa !== c.chiave);
  if (!dopo.length) return true;
  const arrivo = secondi(c.arrivo);
  if (arrivo == null) return false;
  return dopo.some((x) => x.sec <= arrivo + soglie.marginePassaggio);
}

/* ── La lettura e la scrittura ───────────────────────────────────────────── */

export class RifiutoProposta extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const tabellaMancante = (e: any) => ["42P01", "3F000", "42703"].includes(e?.cause?.code ?? e?.code);

/**
 * Calcola (o rifà) la proposta di una giornata congelata e la scrive.
 * Definitiva dopo le 04:00 del giorno dopo, quando i passaggi tardivi sono
 * arrivati; prima è una vista viva. Lo stesso lucchetto di chi prepara la
 * giornata. Senza le tabelle dell'AVM non propone niente e lo dice.
 */
export async function calcolaProposta(giorno: string, soglie: Soglie = SOGLIE) {
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cerbero:giornata:${giorno}`}))`);
    const g = righe(await ex.execute(sql`
      SELECT stato, feed_id::text AS feed, now() >= ${inizioDi(sql`${giorno}::date + 1`)} + interval '1 hour' AS definitiva
        FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
    if (!g) throw new RifiutoProposta(404, "Giornata non ancora preparata");
    if (g.stato === "chiusa") throw new RifiutoProposta(409, "Giornata chiusa: la proposta non si rifà più");
    if (g.stato !== "congelata") throw new RifiutoProposta(409, "La proposta si fa sulle giornate cominciate (congelate)");

    const corse: CorsaDaProporre[] = righe(await ex.execute(sql`
      SELECT chiave, codice, numero, linea, partenza, arrivo, vss_id::text AS vss, turno_macchina, dss_id::text AS dss, turno_guida
        FROM esercizio_corse WHERE giorno = ${giorno}::date`)).map((c) => ({
      chiave: c.chiave, codice: c.codice ?? null, numero: c.numero, linea: c.linea ?? null, partenza: c.partenza ?? null, arrivo: c.arrivo ?? null,
      vssId: c.vss ?? null, turnoMacchina: c.turno_macchina ?? null, dssId: c.dss ?? null, turnoGuida: c.turno_guida ?? null, fermate: [],
    }));
    /* le fermate programmate, dal feed congelato della giornata */
    if (g.feed && corse.length) {
      const perChiave = new Map(corse.map((c) => [c.chiave, c]));
      for (const f of righe(await ex.execute(sql`
        SELECT trip_id, stop_sequence AS seq, stop_id FROM gtfs_stop_times
         WHERE feed_id = ${g.feed}::uuid AND trip_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(corse.map((c) => c.chiave))}::jsonb))
         ORDER BY trip_id, stop_sequence`))) {
        perChiave.get(f.trip_id)?.fermate.push({ seq: Number(f.seq), stopId: String(f.stop_id) });
      }
    }

    /* le prove dell'AVM della giornata, solo SIRI; in un savepoint: senza tabelle non si rovina la transazione */
    let prove: { transiti: TransitoAvm[]; viaggi: ViaggioAvm[]; sorgente: string } | null = null;
    try {
      prove = await ex.transaction(async (sp: any) => {
        const conSorgente = !!righe(await sp.execute(sql`
          SELECT 1 FROM information_schema.columns WHERE table_schema = 'caronte' AND table_name = 'stop_transits' AND column_name = 'source'`)).length;
        const transiti: TransitoAvm[] = righe(await sp.execute(sql`
          SELECT st.trip_id, st.stop_id, st.stop_seq, st.vehicle_id,
                 EXTRACT(EPOCH FROM ((st.actual_ts AT TIME ZONE ${FUSO_ESERCIZIO}) - ${giorno}::date::timestamp))::int AS sec
            FROM caronte.stop_transits st
           WHERE st.actual_ts >= ${inizioDi(giorno)} AND st.actual_ts < ${inizioDi(sql`${giorno}::date + 1`)}
             AND st.trip_id IS NOT NULL AND st.trip_id <> ''
             ${conSorgente ? sql`AND st.source = 'siri'` : sql``}`)).map((t) => ({
          trip: String(t.trip_id), stopId: String(t.stop_id), seq: t.stop_seq == null ? null : Number(t.stop_seq), sec: Number(t.sec), vettura: t.vehicle_id ?? null,
        }));
        const viaggi: ViaggioAvm[] = righe(await sp.execute(sql`
          SELECT journey_ref, trip_id, vehicle_ref, COALESCE(published_line_name, line_ref) AS linea, course_ref, avm_departure, avm_destination, observations
            FROM caronte.journey_codes WHERE day = ${giorno}::date`)).map((v) => ({
          journeyRef: String(v.journey_ref), trip: v.trip_id || null, vettura: v.vehicle_ref ?? null, linea: v.linea ?? null,
          numero: v.course_ref ?? null, partenza: v.avm_departure ?? null, destinazione: v.avm_destination ?? null, osservazioni: Number(v.observations ?? 0),
        }));
        return { transiti, viaggi, sorgente: conSorgente ? "siri" : "tutte" };
      });
    } catch (e) {
      if (!tabellaMancante(e)) throw e;
    }
    if (!prove) {
      const riepilogo = { caronte: false, calcolataIl: new Date().toISOString(), definitiva: false };
      await ex.execute(sql`UPDATE esercizio_giornate SET proposta = ${JSON.stringify(riepilogo)}::jsonb WHERE giorno = ${giorno}::date`);
      return riepilogo;
    }

    /* il codice stabile degli id dell'AVM che non sono chiavi del programmato */
    const chiavi = new Set(corse.map((c) => c.chiave));
    const daCercare = [...new Set([...prove.transiti.map((t) => t.trip), ...prove.viaggi.map((v) => v.trip ?? "")])]
      .filter((t) => t && !chiavi.has(t) && UUID.test(t));
    const codiceDi = new Map<string, string>();
    if (daCercare.length) {
      for (const x of righe(await ex.execute(sql`SELECT id::text, codice FROM ps_trips WHERE id IN ${lista(daCercare)}`))) if (x.codice) codiceDi.set(x.id, x.codice);
    }
    /* i turni guida senza conducente: solo dove il roster dice qualcosa per quei turni guida in quel giorno */
    let turniGuidaScoperti: Set<string> | null = null;
    const dss = [...new Set(corse.map((c) => c.dssId).filter((x): x is string => !!x))];
    if (dss.length) {
      const assegnati = righe(await ex.execute(sql`
        SELECT dss_id::text AS dss, duty_code FROM roster_assignments WHERE day = ${giorno}::date AND dss_id IN ${lista(dss)}`));
      const conRoster = new Set(assegnati.map((a) => a.dss));
      if (conRoster.size) {
        const fatti = new Set(assegnati.map((a) => `${a.dss}|${a.duty_code}`));
        turniGuidaScoperti = new Set(corse.filter((c) => c.dssId && c.turnoGuida && conRoster.has(c.dssId) && !fatti.has(`${c.dssId}|${c.turnoGuida}`))
          .map((c) => `${c.dssId}|${c.turnoGuida}`));
      }
    }

    /* le corse annullate dall'AVM, dal giornale (4.5) */
    const cancellate = new Set<string>(righe(await ex.execute(sql`
      SELECT DISTINCT unnest(chiavi) AS chiave FROM esercizio_eventi WHERE giorno = ${giorno}::date AND tipo = 'cancellazione_avm'`)).map((x) => String(x.chiave)));
    const e = proponi({ corse, transiti: prove.transiti, viaggi: prove.viaggi, codiceDi, turniGuidaScoperti, cancellate }, soglie);
    const daScrivere = corse.map((c) => ({ chiave: c.chiave, proposta: e.perCorsa.get(c.chiave)!.proposta, prove: e.perCorsa.get(c.chiave)!.prove }));
    for (let i = 0; i < daScrivere.length; i += 500) {
      await ex.execute(sql`
        UPDATE esercizio_corse c SET proposta = x.proposta, prove = x.prove
          FROM jsonb_to_recordset(${JSON.stringify(daScrivere.slice(i, i + 500))}::jsonb) AS x(chiave text, proposta text, prove jsonb)
         WHERE c.giorno = ${giorno}::date AND c.chiave = x.chiave`);
    }
    await ex.execute(sql`DELETE FROM esercizio_aggiunte_proposte WHERE giorno = ${giorno}::date`);
    for (let i = 0; i < e.aggiunte.length; i += 500) {
      await ex.execute(sql`
        INSERT INTO esercizio_aggiunte_proposte (giorno, chiave_avm, journey_ref, trip_id_avm, linea, numero, partenza, destinazione, vetture, transiti, osservazioni)
        SELECT ${giorno}::date, x.chiave_avm, x.journey_ref, x.trip_id_avm, x.linea, x.numero, x.partenza, x.destinazione,
               ARRAY(SELECT jsonb_array_elements_text(x.vetture)), x.transiti, x.osservazioni
          FROM jsonb_to_recordset(${JSON.stringify(e.aggiunte.slice(i, i + 500).map((a) => ({
            chiave_avm: a.chiaveAvm, journey_ref: a.journeyRef, trip_id_avm: a.trip, linea: a.linea, numero: a.numero, partenza: a.partenza,
            destinazione: a.destinazione, vetture: a.vetture, transiti: a.transiti, osservazioni: a.osservazioni,
          })))}::jsonb) AS x(chiave_avm text, journey_ref text, trip_id_avm text, linea text, numero text, partenza text,
                             destinazione text, vetture jsonb, transiti integer, osservazioni integer)`);
    }
    const riepilogo = { caronte: true, sorgente: prove.sorgente, calcolataIl: new Date().toISOString(), definitiva: !!g.definitiva, ...e.riepilogo };
    await ex.execute(sql`UPDATE esercizio_giornate SET proposta = ${JSON.stringify(riepilogo)}::jsonb WHERE giorno = ${giorno}::date`);
    return riepilogo;
  });
}

/**
 * Le giornate la cui proposta va fatta in modo definitivo: congelate, degli
 * ultimi giorni, passate le 04:00 del giorno dopo, e non ancora definitive.
 */
export async function giornateDaProporre(oggi: string, giorniIndietro = 3): Promise<string[]> {
  return righe(await db.execute(sql`
    SELECT giorno::text AS g FROM esercizio_giornate
     WHERE stato = 'congelata' AND giorno >= ${oggi}::date - ${giorniIndietro}::int AND giorno < ${oggi}::date
       AND now() >= ${inizioDi(sql`giorno + 1`)} + interval '1 hour'
       AND COALESCE((proposta->>'definitiva')::boolean, false) = false
     ORDER BY giorno`)).map((x) => String(x.g).slice(0, 10));
}

/** Le candidate aggiunte di una giornata. */
export async function aggiunteDellaGiornata(giorno: string) {
  return righe(await db.execute(sql`
    SELECT chiave_avm, journey_ref, trip_id_avm, linea, numero, partenza, destinazione, vetture, transiti, osservazioni
      FROM esercizio_aggiunte_proposte WHERE giorno = ${giorno}::date ORDER BY partenza NULLS LAST, chiave_avm`)).map((a) => ({
    chiaveAvm: a.chiave_avm, journeyRef: a.journey_ref ?? null, trip: a.trip_id_avm ?? null, linea: a.linea ?? null, numero: a.numero ?? null,
    partenza: a.partenza ?? null, destinazione: a.destinazione ?? null, vetture: Array.isArray(a.vetture) ? a.vetture : [],
    transiti: Number(a.transiti), osservazioni: Number(a.osservazioni),
  }));
}
