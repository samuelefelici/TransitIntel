/**
 * I calcoli dei turni macchina della Fucina (CP-SAT e VCSP) in coda: si
 * lanciano con ?asincrono=1 e si seguono leggendo
 * GET /api/service-program/lavori/:jobId, così la pagina può chiudersi o
 * ricaricarsi senza fermarli. Riaprendo, il contesto del wizard (data, linee,
 * depositi, impostazioni) si ricostruisce dalla richiesta che il server tiene
 * con il calcolo. Senza React: si prova con un fetch finto.
 */
import { erroreDi, annunciaAvvio, type Rete } from "@/lib/calcoli";
import { getApiBase } from "@/lib/api";

export type ModoVeicoli = "cpsat" | "vcsp";

export interface StatoCalcoloVeicoli {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  mode: string | null;
  progress: { phase?: string; percentage?: number; detail?: string } | null;
  createdAt: number;
  updatedAt: number;
  /** a calcolo finito: il codice e il corpo della risposta di sempre */
  httpStatus?: number;
  result?: any;
  /** con ?richiesta=1: il corpo con cui è stato lanciato */
  request?: Record<string, any> | null;
}

/** Il calcolo non c'è più (oltre 30 giorni, o di un altro utente). */
export class CalcoloSparito extends Error {
  constructor() { super("Il calcolo non è più disponibile sul server: rilancialo."); }
}
/** Fermato (dall'utente, o al deploy perché nessuno lo aspettava). */
export class CalcoloFermato extends Error {
  constructor() { super("Calcolo fermato prima della fine."); }
}

const reteDi = (r: Rete = {}) => ({ f: r.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), base: r.base ?? getApiBase() });
const FINITI = new Set(["completed", "failed", "stopped"]);

/**
 * Lancia il calcolo in coda: il jobId, oppure l'errore immediato del server
 * (400, 404, 429, 503). Con LAVORI_VEICOLI_IN_CODA=0 (ritorno indietro) l'API
 * calcola dentro di sé e risponde 200 col risultato: lo si restituisce così.
 */
export async function avviaCalcoloVeicoli(modo: ModoVeicoli, corpo: unknown, rete?: Rete): Promise<{ jobId: string } | { risultato: any }> {
  const { f, base } = reteDi(rete);
  const res = await f(`${base}/api/service-program/${modo}?asincrono=1`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
  });
  if (res.status === 200) return { risultato: await res.json() };
  if (res.status !== 202) throw new Error(await erroreDi(res));
  const { jobId } = await res.json();
  if (typeof jobId !== "string") throw new Error("Il server non ha restituito il calcolo");
  annunciaAvvio();
  return { jobId };
}

/** Lo stato del calcolo; null se non c'è più (404 dell'API). Un errore di rete lancia. */
export async function leggiCalcoloVeicoli(jobId: string, o: { richiesta?: boolean } = {}, rete?: Rete): Promise<StatoCalcoloVeicoli | null> {
  const { f, base } = reteDi(rete);
  const res = await f(`${base}/api/service-program/lavori/${encodeURIComponent(jobId)}${o.richiesta ? "?richiesta=1" : ""}`);
  if (res.status === 404) {
    // il 404 dell'API è JSON con «error»; quello di un proxy durante un riavvio no (transitorio)
    const corpo = await res.json().catch(() => null);
    if (corpo && typeof corpo.error === "string") return null;
    throw new Error("Server non raggiungibile");
  }
  if (!res.ok) throw new Error(await erroreDi(res));
  return res.json();
}

/** Ferma il calcolo (stop esplicito: uscire dalla pagina non lo ferma più). */
export async function fermaCalcoloVeicoli(jobId: string, rete?: Rete): Promise<void> {
  const { f, base } = reteDi(rete);
  const res = await f(`${base}/api/service-program/lavori/${encodeURIComponent(jobId)}/stop`, { method: "POST" });
  // 400: era già finito; va bene lo stesso
  if (!res.ok && res.status !== 400) throw new Error(await erroreDi(res));
}

/** L'esito di un calcolo finito: il risultato (come la risposta sincrona di prima) o l'errore. */
export function esitoDi(st: StatoCalcoloVeicoli): any {
  if (st.status === "stopped") throw new CalcoloFermato();
  if (st.status === "completed" && st.httpStatus === 200) return st.result;
  const r = st.result;
  throw new Error((r && typeof r.error === "string" && r.error) || (r && typeof r.message === "string" && r.message)
    || (st.httpStatus ? `Errore ${st.httpStatus}` : "Calcolo non riuscito"));
}

const dorme = (ms: number, segnale?: AbortSignal) => new Promise<void>((ok) => {
  if (segnale?.aborted) return ok();
  const t = setTimeout(ok, ms);
  segnale?.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true });
});

/**
 * Segue il calcolo fino alla fine e ne restituisce il risultato (o lancia
 * l'errore, CalcoloFermato, CalcoloSparito). `segnale` smette di seguirlo
 * (la pagina se ne va): il calcolo continua sul server. Gli errori di rete
 * si riprovano: durante un deploy l'API sparisce per qualche secondo.
 */
export async function seguiCalcoloVeicoli(jobId: string, o: {
  segnale?: AbortSignal;
  onStato?: (st: StatoCalcoloVeicoli) => void;
  intervalloMs?: number;
  rete?: Rete;
} = {}): Promise<any> {
  const passo = o.intervalloMs ?? 2000;
  for (;;) {
    if (o.segnale?.aborted) throw new DOMException("Non più seguito", "AbortError");
    let st: StatoCalcoloVeicoli | null;
    try {
      st = await leggiCalcoloVeicoli(jobId, {}, o.rete);
    } catch {
      await dorme(passo, o.segnale);
      continue;
    }
    if (!st) throw new CalcoloSparito();
    o.onStato?.(st);
    if (FINITI.has(st.status)) return esitoDi(st);
    await dorme(passo, o.segnale);
  }
}

/* ── Il contesto del wizard dalla richiesta ─────────────────────────── */

/** Come VehicleAssignment di pages/fucina.tsx (stessa forma). */
export interface AssegnazioneVetture {
  selectedDate: string;
  selectedRoutes: Map<string, any>;
  forcedRoutes: Set<string>;
  tripVehicleOverrides: Map<string, any>;
  excludedTripIds?: Set<string>;
}

/** Le impostazioni del solutore dello step «Ottimizzazione», come le ha mandate la Fucina. */
export interface ImpostazioniSolutore {
  solverMode: ModoVeicoli;
  solverIntensity?: string;
  serviceType?: "urbano" | "extraurbano" | "misto";
  robustness?: "off" | "media" | "alta";
  normativa?: Record<string, any>;
  vehicleCosts?: Record<string, any>;
  vspAdvanced?: Record<string, any>;
  vcspRounds?: number;
  crewTimeLimit?: number;
  vcspProbe?: boolean;
  crewConfig?: Record<string, any>;
}

export interface ContestoCalcolo {
  assegnazione: AssegnazioneVetture;
  depositi: Array<{ id: string; maxVehicles: number | null; fleet?: Record<string, number> }>;
  pipelineMode: "classic" | "vcsp";
  impostazioni: ImpostazioniSolutore;
}

/**
 * Il contesto del wizard dalla richiesta con cui la Fucina ha lanciato il
 * calcolo (OptimizerStep, bodyPayload): l'inverso di quel corpo. null se la
 * richiesta non c'è più (oltre 7 giorni) o non ha la forma attesa.
 */
export function contestoDaRichiesta(modo: string | null, corpo: Record<string, any> | null | undefined): ContestoCalcolo | null {
  if (!corpo || typeof corpo !== "object" || typeof corpo.date !== "string" || !Array.isArray(corpo.routes)) return null;
  const solverMode: ModoVeicoli = modo === "vcsp" ? "vcsp" : "cpsat";
  const linee = corpo.routes.filter((r: any) => r && typeof r.routeId === "string");
  const sost = corpo.tripVehicleOverrides && typeof corpo.tripVehicleOverrides === "object" ? corpo.tripVehicleOverrides : {};
  const esclusi = Array.isArray(corpo.excludedTripIds) ? corpo.excludedTripIds.map(String) : [];
  const vcsp = corpo.vcsp && typeof corpo.vcsp === "object" ? corpo.vcsp : null;
  const crew = corpo.crewConfig && typeof corpo.crewConfig === "object" ? corpo.crewConfig : undefined;
  return {
    assegnazione: {
      selectedDate: corpo.date,
      selectedRoutes: new Map(linee.map((r: any) => [r.routeId, r.vehicleType])),
      forcedRoutes: new Set(linee.filter((r: any) => r.forced).map((r: any) => r.routeId)),
      tripVehicleOverrides: new Map(Object.entries(sost)),
      ...(esclusi.length ? { excludedTripIds: new Set(esclusi) } : {}),
    },
    depositi: Array.isArray(corpo.depots) ? corpo.depots.filter((d: any) => d && typeof d.id === "string") : [],
    pipelineMode: solverMode === "vcsp" ? "vcsp" : "classic",
    impostazioni: {
      solverMode,
      ...(typeof corpo.solverIntensity === "string" ? { solverIntensity: corpo.solverIntensity } : {}),
      ...(["urbano", "extraurbano", "misto"].includes(corpo.serviceType) ? { serviceType: corpo.serviceType } : {}),
      robustness: corpo.robustness === "media" || corpo.robustness === "alta" ? corpo.robustness : "off",
      ...(corpo.vspNormativa && typeof corpo.vspNormativa === "object" ? { normativa: corpo.vspNormativa } : {}),
      ...(corpo.vehicleCosts && typeof corpo.vehicleCosts === "object" ? { vehicleCosts: corpo.vehicleCosts } : {}),
      ...(corpo.vspAdvanced && typeof corpo.vspAdvanced === "object" ? { vspAdvanced: corpo.vspAdvanced } : {}),
      ...(vcsp && typeof vcsp.rounds === "number" ? { vcspRounds: vcsp.rounds } : {}),
      ...(vcsp && typeof vcsp.crewTimeLimit === "number" ? { crewTimeLimit: vcsp.crewTimeLimit } : {}),
      ...(vcsp && typeof vcsp.probes === "number" ? { vcspProbe: vcsp.probes > 0 } : {}),
      ...(crew ? { crewConfig: crew } : {}),
    },
  };
}
