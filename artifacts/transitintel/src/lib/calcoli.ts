/**
 * «I miei calcoli»: i calcoli in coda di chi è entrato (GET /api/lavori),
 * con le parole per mostrarli e il link per riaprirli. Senza React: la pagina
 * (pages/calcoli.tsx) e l'indicatore (components/calcoli/IndicatoreCalcoli.tsx)
 * leggono da qui, e i test lo provano con un fetch finto.
 */
import { getApiBase } from "@/lib/api";

export type StatoCalcolo = "queued" | "running" | "completed" | "failed" | "stopped";
export type AmbitoCalcolo = "turni-guida" | "turni-macchina" | "giro-agente" | "materializzazione";

/** Una riga di GET /api/lavori (api-server/src/routes/lavori.ts, vistaLavoro). */
export interface Calcolo {
  jobId: string;
  tipo: string;
  ambito: AmbitoCalcolo | null;
  status: StatoCalcolo;
  /** stop chiesto, il calcolo non si è ancora fermato */
  stopping: boolean;
  corsia: "veloce" | "lunga";
  progress: { phase?: string; percentage?: number; detail?: string } | null;
  httpStatus: number | null;
  error: string | null;
  errorType: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  dettagli: {
    scenarioId?: string; scenarioName?: string; date?: string; mode?: string;
    projectId?: string; psProjectId?: string; schedulingProjectId?: string; budgetSec?: number;
  };
}

export interface Rete {
  fetch?: typeof fetch;
  base?: string;
}
const reteDi = (r: Rete = {}) => ({ f: r.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), base: r.base ?? getApiBase() });

/** Il messaggio d'errore di una risposta non andata: quello del server, se c'è. */
export async function erroreDi(res: Response): Promise<string> {
  const corpo = await res.json().catch(() => null);
  return (corpo && typeof corpo.error === "string" && corpo.error) || `Errore ${res.status}`;
}

/** Gli ultimi calcoli di chi è entrato, i più recenti prima. */
export async function elencoCalcoli(n = 20, rete?: Rete): Promise<Calcolo[]> {
  const { f, base } = reteDi(rete);
  const res = await f(`${base}/api/lavori?n=${n}`);
  if (!res.ok) throw new Error(await erroreDi(res));
  const corpo = await res.json();
  return Array.isArray(corpo?.lavori) ? corpo.lavori : [];
}

/** Ferma un proprio calcolo: «stopped» se era in coda, «stopping» se girava. */
export async function fermaCalcolo(jobId: string, rete?: Rete): Promise<"stopped" | "stopping"> {
  const { f, base } = reteDi(rete);
  const res = await f(`${base}/api/lavori/${encodeURIComponent(jobId)}/stop`, { method: "POST" });
  if (!res.ok) throw new Error(await erroreDi(res));
  const corpo = await res.json();
  return corpo?.status === "stopped" ? "stopped" : "stopping";
}

export const vivo = (c: Pick<Calcolo, "status">) => c.status === "queued" || c.status === "running";

const MODI: Record<string, string> = { cpsat: "CP-SAT", vcsp: "VCSP integrato", greedy: "Euristica" };

/** Come si chiama il calcolo, per chi lo legge. */
export function etichetta(c: Calcolo): string {
  const d = c.dettagli ?? {};
  switch (c.ambito) {
    case "turni-macchina": return `Turni macchina · ${MODI[d.mode ?? ""] ?? "ottimizzazione"}`;
    case "turni-guida": return d.scenarioName ? `Turni guida · ${d.scenarioName}` : "Turni guida";
    case "giro-agente": return `Giro di Argos · ${MODI[d.mode ?? ""] ?? "turni"}`;
    case "materializzazione": return "Sincronizzazione con Planning Studio";
    default: return "Calcolo";
  }
}

/** La data di esercizio del calcolo (AAAAMMGG o AAAA-MM-GG) in forma leggibile, se c'è. */
export function dataEsercizio(c: Calcolo): string | null {
  const d = String(c.dettagli?.date ?? "").replace(/-/g, "");
  if (!/^\d{8}$/.test(d)) return null;
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
}

/** Lo stato, in parole. */
export function statoLeggibile(c: Calcolo): string {
  if (c.stopping) return "In fermata";
  switch (c.status) {
    case "queued": return "In coda";
    case "running": return "In corso";
    case "completed": return "Finito";
    case "stopped": return "Fermato";
    case "failed": return c.errorType === "scaduto" ? "Oltre il tempo massimo" : c.errorType === "interrotto" ? "Interrotto" : "Non riuscito";
  }
}

/** La percentuale di avanzamento (0-100), se il calcolo la dice. */
export function percentuale(c: Calcolo): number | null {
  const p = Number(c.progress?.percentage);
  return Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : null;
}

/** Quanto è durato (o dura, se è vivo): «45 s», «3 min 12 s», «1 h 05 min». */
export function durata(c: Calcolo, adesso = Date.now()): string | null {
  const inizio = c.startedAt ?? (vivo(c) ? null : c.createdAt);
  if (!inizio) return null;
  const fine = c.finishedAt ?? (vivo(c) ? adesso : c.updatedAt);
  const s = Math.max(0, Math.round((fine - inizio) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * Dove si riapre il calcolo, se si sa: il wizard della Fucina per i turni
 * macchina (riprende da sé il calcolo ricordato), l'area turni guida per i
 * turni guida, la pagina del progetto per una sincronizzazione, il quadro
 * d'esercizio per un giro di Argos.
 */
export function linkDi(c: Calcolo): string | null {
  const d = c.dettagli ?? {};
  switch (c.ambito) {
    case "turni-macchina": return d.projectId ? `/fucina/${d.projectId}/pipeline${d.mode === "vcsp" ? "?mode=vcsp" : ""}` : null;
    case "turni-guida": return d.projectId && d.scenarioId ? `/fucina/${d.projectId}/drivers/${d.scenarioId}` : null;
    case "materializzazione": return d.schedulingProjectId ? `/fucina/${d.schedulingProjectId}` : null;
    case "giro-agente": return d.psProjectId ? `/fucina/esercizio/${d.psProjectId}` : null;
    default: return null;
  }
}

/**
 * Il link «Apri» di un calcolo: per i turni macchina e i turni guida porta con
 * sé il calcolo (?calcolo=<id>), così la pagina apre proprio quello, anche da
 * un altro computer; per gli altri è il link della pagina.
 */
export function apriDi(c: Calcolo): string | null {
  const l = linkDi(c);
  if (!l || (c.ambito !== "turni-macchina" && c.ambito !== "turni-guida")) return l;
  return `${l}${l.includes("?") ? "&" : "?"}calcolo=${encodeURIComponent(c.jobId)}`;
}

/**
 * I calcoli che fra due letture sono passati da vivi a finiti: l'indicatore
 * li annuncia. Un calcolo mai visto vivo non si annuncia (era già finito, o è
 * finito fra due letture senza che l'indicatore lo vedesse partire: lo si
 * vede comunque nell'elenco).
 */
export function appenaFiniti(prima: readonly Calcolo[], dopo: readonly Calcolo[]): Calcolo[] {
  const viviPrima = new Set(prima.filter(vivo).map(c => c.jobId));
  return dopo.filter(c => !vivo(c) && viviPrima.has(c.jobId));
}
