/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL DIARIO DELL'AVM — la raccolta
 * ───────────────────────────────────────────────────────────────────────────
 * Una riga per (giornata, matricola), aggiornata a campione mentre il poller
 * gira. Non conserva le singole letture: di una settimana di osservazione
 * servono i CONTEGGI — quante volte ha parlato, quante volte si è localizzata,
 * quante volte era su una corsa — e conservare mezzo milione di righe per
 * ricavarne trecentosessantotto sarebbe un magazzino, non una misura.
 *
 * ── Perché a campione e non a ogni giro ──
 *
 * Il poller legge ogni trenta secondi circa. Aggiornare trecentosessantotto
 * righe due volte al minuto vuol dire riscrivere ogni riga duemila volte al
 * giorno per rispondere a domande che si accontentano di molto meno: una corsa
 * dura decine di minuti, e per sapere che c'è stata basta un campione ogni due
 * minuti. Si scrive quindi al massimo una volta ogni CAMPIONE_MS, e i
 * contatori vanno letti come "campioni", non come "letture dell'AVM".
 *
 * Come le altre raccolte accessorie: la tabella si crea da sé al primo
 * bisogno, e se il database non la concede il diario si spegne senza fermare
 * il giro di ingestione. Un'analisi mancata non vale una corsa persa.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { RigaDiario } from "./avm-diario.js";
import type { SiriVehicle } from "./siri-vm.js";

/** Una lettura sola di una vettura, già ridotta ai quattro anelli. */
export interface LetturaVettura {
  vehicleRef: string;
  /** l'apparato stava parlando col centro in questo momento */
  fresca: boolean;
  monitorata: boolean;
  /** posizione presente E fresca: una posizione vecchia non è una posizione */
  posizione: boolean;
  /** codice della corsa in servizio, se ce n'è una */
  corsa: string | null;
  linea: string | null;
  /** "GPS" (antenna) o "GPRS" (rete), come lo dice l'AVM */
  errore: string | null;
  inRimessa: boolean;
  contatto: Date | null;
}

/**
 * Oltre questo tempo dall'ultimo contatto l'apparato non sta parlando: la
 * posizione che porta con sé è l'ultima nota, non dove si trova adesso.
 * Quindici minuti coprono un giro in galleria senza perdonare un apparato
 * spento.
 */
const FRESCA_SEC = 15 * 60;

/** Un campione ogni due minuti: una corsa dura molto di più. */
const CAMPIONE_MS = 120_000;

let ultimoCampione = 0;
let pronto: Promise<boolean> | null = null;
let ultimoErrore: string | null = null;
let campioniScritti = 0;

export function erroreDiario(): string | null { return ultimoErrore; }
export function campioniDiario(): number { return campioniScritti; }

/** Riduce una VehicleActivity ai quattro anelli del diario. */
export function letturaDa(v: SiriVehicle, now = Date.now()): LetturaVettura | null {
  if (!v.vehicleRef) return null;
  const eta = v.recordedAt ? (now - v.recordedAt.getTime()) / 1000 : null;
  const fresca = eta != null && eta <= FRESCA_SEC;
  /* Stessa regola della Sala Operativa: un mezzo "fuori linea" con un codice
   * corsa residuo non è in servizio, e contarlo qui darebbe un parco diverso
   * da quello che la stessa applicazione mostra due schede più in là. */
  const inServizio = !!v.journeyRef && !v.inDepot && !v.withoutService && !v.outOfService;
  return {
    vehicleRef: v.vehicleRef,
    fresca,
    monitorata: v.monitored === true,
    posizione: fresca && v.lat != null && v.lon != null,
    corsa: inServizio ? (v.journeyRef ?? null) : null,
    linea: v.publishedLineName ?? v.lineRef ?? null,
    errore: v.monitoringError ?? null,
    inRimessa: v.inDepot === true,
    contatto: v.recordedAt ?? null,
  };
}

async function crea(): Promise<boolean> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.avm_diario (
        day date NOT NULL,
        vehicle_ref text NOT NULL,
        /* campioni, non letture dell'AVM: v. CAMPIONE_MS */
        letture integer NOT NULL DEFAULT 0,
        letture_fresche integer NOT NULL DEFAULT 0,
        letture_monitorata integer NOT NULL DEFAULT 0,
        letture_posizione integer NOT NULL DEFAULT 0,
        letture_corsa integer NOT NULL DEFAULT 0,
        letture_errore_gps integer NOT NULL DEFAULT 0,
        letture_errore_gprs integer NOT NULL DEFAULT 0,
        letture_rimessa integer NOT NULL DEFAULT 0,
        primo_contatto timestamptz,
        ultimo_contatto timestamptz,
        linee text[] NOT NULL DEFAULT '{}',
        corse text[] NOT NULL DEFAULT '{}',
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_seen timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (day, vehicle_ref))`);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_caronte_avm_diario_day
        ON caronte.avm_diario(day)`);
    ultimoErrore = null;
    return true;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] diario dell'AVM non attivo:", ultimoErrore);
    return false;
  }
}

function assicura(): Promise<boolean> {
  if (!pronto) {
    pronto = crea().then(ok => { if (!ok) pronto = null; return ok; })
      .catch(() => { pronto = null; return false; });
  }
  return pronto;
}

/** ARRAY['a','b']::text[] con i valori come parametri, mai interpolati. */
function arrayLetterale(valori: Array<string | null>) {
  const puliti = [...new Set(valori.filter((x): x is string => !!x))].slice(0, 8);
  if (!puliti.length) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(puliti.map(x => sql`${x}`), sql`, `)}]::text[]`;
}

/**
 * Registra un campione. Torna quante righe ha toccato: zero se il campione è
 * stato saltato perché troppo vicino al precedente, o se la tabella non c'è.
 */
export async function registraCampione(
  giorno: string, letture: LetturaVettura[], now = Date.now(),
): Promise<number> {
  if (!letture.length) return 0;
  if (now - ultimoCampione < CAMPIONE_MS) return 0;
  if (!(await assicura())) return 0;
  ultimoCampione = now;

  /* Una riga per matricola anche se l'AVM la ripete: l'ultima vince, come
   * ovunque nel connettore. */
  const per = new Map<string, LetturaVettura>();
  for (const l of letture) per.set(l.vehicleRef, l);

  try {
    const righe = [...per.values()].map(l => sql`(
      ${giorno}::date, ${l.vehicleRef},
      1,
      ${l.fresca ? 1 : 0}, ${l.monitorata ? 1 : 0}, ${l.posizione ? 1 : 0},
      ${l.corsa ? 1 : 0},
      ${l.errore === "GPS" ? 1 : 0}, ${l.errore === "GPRS" ? 1 : 0},
      ${l.inRimessa ? 1 : 0},
      ${l.contatto ? l.contatto.toISOString() : null}::timestamptz,
      ${l.contatto ? l.contatto.toISOString() : null}::timestamptz,
      ${arrayLetterale([l.linea])}, ${arrayLetterale([l.corsa])})`);

    await db.execute(sql`
      INSERT INTO caronte.avm_diario
        (day, vehicle_ref, letture, letture_fresche, letture_monitorata,
         letture_posizione, letture_corsa, letture_errore_gps, letture_errore_gprs,
         letture_rimessa, primo_contatto, ultimo_contatto, linee, corse)
      VALUES ${sql.join(righe, sql`, `)}
      ON CONFLICT (day, vehicle_ref) DO UPDATE SET
        letture            = caronte.avm_diario.letture + 1,
        letture_fresche    = caronte.avm_diario.letture_fresche + EXCLUDED.letture_fresche,
        letture_monitorata = caronte.avm_diario.letture_monitorata + EXCLUDED.letture_monitorata,
        letture_posizione  = caronte.avm_diario.letture_posizione + EXCLUDED.letture_posizione,
        letture_corsa      = caronte.avm_diario.letture_corsa + EXCLUDED.letture_corsa,
        letture_errore_gps = caronte.avm_diario.letture_errore_gps + EXCLUDED.letture_errore_gps,
        letture_errore_gprs= caronte.avm_diario.letture_errore_gprs + EXCLUDED.letture_errore_gprs,
        letture_rimessa    = caronte.avm_diario.letture_rimessa + EXCLUDED.letture_rimessa,
        primo_contatto     = LEAST(caronte.avm_diario.primo_contatto,
                                   COALESCE(EXCLUDED.primo_contatto, caronte.avm_diario.primo_contatto)),
        ultimo_contatto    = GREATEST(caronte.avm_diario.ultimo_contatto,
                                      COALESCE(EXCLUDED.ultimo_contatto, caronte.avm_diario.ultimo_contatto)),
        /* COALESCE obbligatorio: array_agg su un insieme vuoto torna NULL, e
         * la colonna è NOT NULL. Il taglio a otto tiene la riga leggibile: le
         * linee di una vettura in un giorno sono poche, e se sono tante il
         * dato interessante è che sono tante, non quali. */
        linee = COALESCE((SELECT array_agg(DISTINCT x)
                            FROM unnest(caronte.avm_diario.linee || EXCLUDED.linee) AS x
                           WHERE x IS NOT NULL), '{}')::text[],
        corse = COALESCE((SELECT array_agg(DISTINCT x)
                            FROM unnest(caronte.avm_diario.corse || EXCLUDED.corse) AS x
                           WHERE x IS NOT NULL), '{}')::text[],
        last_seen = now()`);
    campioniScritti++;
    ultimoErrore = null;
    return per.size;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] diario dell'AVM, campione non scritto:", ultimoErrore);
    return 0;
  }
}

/** Le righe del diario dal giorno indicato (compreso) a oggi. */
export async function leggiDiario(daGiorno: string): Promise<RigaDiario[]> {
  if (!(await assicura())) return [];
  try {
    const r = await db.execute<any>(sql`
      SELECT to_char(day, 'YYYY-MM-DD')                    AS giorno,
             vehicle_ref, letture, letture_fresche, letture_monitorata,
             letture_posizione, letture_corsa, letture_errore_gps,
             letture_errore_gprs, letture_rimessa,
             primo_contatto, ultimo_contatto, linee, corse
        FROM caronte.avm_diario
       WHERE day >= ${daGiorno}::date
       ORDER BY day, vehicle_ref
       LIMIT 20000`);
    return ((r as any).rows ?? []).map((x: any): RigaDiario => ({
      giorno: String(x.giorno),
      vehicleRef: String(x.vehicle_ref),
      letture: Number(x.letture ?? 0),
      lettureFresche: Number(x.letture_fresche ?? 0),
      lettureMonitorata: Number(x.letture_monitorata ?? 0),
      letturePosizione: Number(x.letture_posizione ?? 0),
      lettureCorsa: Number(x.letture_corsa ?? 0),
      lettureErroreGps: Number(x.letture_errore_gps ?? 0),
      lettureErroreGprs: Number(x.letture_errore_gprs ?? 0),
      lettureInRimessa: Number(x.letture_rimessa ?? 0),
      primoContatto: x.primo_contatto ? new Date(x.primo_contatto).toISOString() : null,
      ultimoContatto: x.ultimo_contatto ? new Date(x.ultimo_contatto).toISOString() : null,
      linee: Array.isArray(x.linee) ? x.linee.map(String) : [],
      corse: Array.isArray(x.corse) ? x.corse.map(String) : [],
    }));
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return [];
  }
}
