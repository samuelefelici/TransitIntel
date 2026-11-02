/**
 * Il lanciatore unico di Python: tutti i calcoli (turni macchina e guida,
 * VCSP, misti, strumenti, relazione, coincidenze, rotazioni) passano da qui,
 * sia dentro l'API sia nel lavoratore (src/lavoratore.ts).
 *
 * - Si lancia solo uno degli script dell'elenco, dentro SCRIPTS_DIR: anche una
 *   riga di coda.lavori manomessa non fa girare codice arbitrario.
 * - Python riceve solo l'ambiente che gli serve, mai i segreti dell'API
 *   (JWT_SECRET, DATABASE_URL, CERBERO_CHIAVE_MFA, CRON_SECRET, chiavi SIRI e
 *   FleetCare…): PATH e PYTHONPATH (OR-Tools sta in .python_packages), lingua,
 *   cartelle; il token di Mapbox, il proxy e i certificati solo alla relazione,
 *   che scarica le mappe.
 * - JSON su stdin (con la protezione dall'EPIPE), stdout decodificato in UTF-8
 *   senza spezzare i caratteri, con un tetto; di stderr si tengono l'inizio e
 *   la fine; le righe PROGRESS| si leggono con un parser solo.
 * - Timeout duro e stop: SIGINT (gli script si fermano in ordine), poi SIGKILL
 *   dopo 5 secondi se il processo non è ancora uscito.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SCRIPTS_DIR } from "../scripts-dir";

export const SCRIPT_CONSENTITI = Object.freeze([
  "coincidence_analysis.py",
  "crew_misto.py",
  "crew_scheduler_v4.py",
  "crew_tools.py",
  "report_builder.py",
  "rotazione_riposi.py",
  "vcsp_orchestrator.py",
  "vehicle_scheduler_cpsat.py",
] as const);
export type ScriptConsentito = (typeof SCRIPT_CONSENTITI)[number];

export function scriptConsentito(nome: unknown): nome is ScriptConsentito {
  return typeof nome === "string" && (SCRIPT_CONSENTITI as readonly string[]).includes(nome);
}

/** Il percorso dello script, solo se è nell'elenco (niente cartelle, niente «..»). */
export function percorsoScript(nome: string, cartella: string = SCRIPTS_DIR): string {
  if (!scriptConsentito(nome)) throw new Error(`script Python non consentito: ${String(nome).slice(0, 80)}`);
  return path.join(cartella, nome);
}

const AMBIENTE_SEMPRE = [
  "PATH", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "PYTHONUTF8",
  "LANG", "LANGUAGE", "HOME", "TMPDIR", "TZ",
];
const AMBIENTE_RETE = [
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
];
const AMBIENTE_PER_SCRIPT: Partial<Record<ScriptConsentito, readonly string[]>> = {
  // le mappe statiche della relazione (report_charts.py)
  "report_builder.py": ["MAPBOX_ACCESS_TOKEN", "MAPBOX_TOKEN", ...AMBIENTE_RETE],
};

/** L'ambiente di un processo Python: solo le variabili dell'elenco, se ci sono. */
export function ambientePython(script: ScriptConsentito, sorgente: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const ammesse = new Set([...AMBIENTE_SEMPRE, ...(AMBIENTE_PER_SCRIPT[script] ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(sorgente)) {
    if (v === undefined) continue;
    if (ammesse.has(k) || k.startsWith("LC_")) env[k] = v;
  }
  return env;
}

export interface Progresso {
  phase: string;
  percentage: number;
  detail: string;
  extra?: Record<string, unknown>;
  timestamp: number;
}

/** Una riga `PROGRESS|fase|percentuale|dettaglio|extra_json` (extra facoltativo). */
export function leggiProgresso(riga: string, adesso: number = Date.now()): Progresso | null {
  if (!riga.startsWith("PROGRESS|")) return null;
  const parti = riga.split("|");
  if (parti.length < 4) return null;
  const pct = parseFloat(parti[2]);
  const p: Progresso = {
    phase: parti[1],
    percentage: Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0)),
    detail: parti[3],
    timestamp: adesso,
  };
  if (parti[4]) {
    try { const extra = JSON.parse(parti.slice(4).join("|")); if (extra && typeof extra === "object") p.extra = extra; }
    catch { /* extra non valido: si ignora */ }
  }
  return p;
}

export type MotivoUscita = "uscito" | "timeout" | "fermato" | "tetto" | "avvio";

export interface EsitoProcesso {
  /** codice d'uscita (null se ucciso da un segnale) */
  codice: number | null;
  segnaleUscita: NodeJS.Signals | null;
  /** perché è finito: da solo, per il timeout, per lo stop, per il tetto dello stdout, o non è partito */
  motivo: MotivoUscita;
  stdout: string;
  /** i primi e gli ultimi caratteri di stderr */
  stderrTesta: string;
  stderrCoda: string;
  erroreAvvio?: string;
}

export interface OpzioniProcesso {
  comando: string;
  argomenti: string[];
  env: NodeJS.ProcessEnv;
  /** scritto su stdin come JSON */
  ingresso?: unknown;
  /** dopo quanto si ferma comunque (SIGINT, poi SIGKILL) */
  timeoutMs?: number;
  /** abort = stop richiesto (SIGINT, poi SIGKILL) */
  segnale?: AbortSignal;
  /** quanti caratteri di stdout al massimo (oltre: SIGKILL) */
  tettoStdout?: number;
  suRigaStderr?: (riga: string) => void;
  suProgresso?: (p: Progresso) => void;
  /** solo per i test: quanto aspettare fra SIGINT e SIGKILL */
  attesaKillMs?: number;
  /** il pid, appena partito (per i test e per il log) */
  suAvvio?: (pid: number | undefined) => void;
}

const TESTA = 4_096;
const CODA = 16_384;
const TETTO_STDOUT = 256 * 1024 * 1024;

/** Un processo con JSON su stdin: il cuore di eseguiPython, separato per poterlo provare. */
export function eseguiProcesso(o: OpzioniProcesso): Promise<EsitoProcesso> {
  return new Promise((resolve) => {
    let motivo: MotivoUscita = "uscito";
    let uscito = false;
    let finito = false;
    let stdout = "";
    let stderrTesta = "";
    let stderrCoda = "";
    let rigaParziale = "";
    let sforato = false;
    let timerTimeout: NodeJS.Timeout | undefined;
    let timerKill: NodeJS.Timeout | undefined;
    const decoOut = new StringDecoder("utf8");
    const decoErr = new StringDecoder("utf8");
    const tetto = o.tettoStdout ?? TETTO_STDOUT;

    const py = spawn(o.comando, o.argomenti, { stdio: ["pipe", "pipe", "pipe"], env: o.env });

    const chiudi = (esito: Omit<EsitoProcesso, "stdout" | "stderrTesta" | "stderrCoda">) => {
      if (finito) return;
      finito = true;
      if (timerTimeout) clearTimeout(timerTimeout);
      if (timerKill) clearTimeout(timerKill);
      o.segnale?.removeEventListener("abort", suAbort);
      resolve({ ...esito, stdout, stderrTesta, stderrCoda });
    };
    const termina = (perche: MotivoUscita, subito = false) => {
      if (uscito) return;
      if (motivo === "uscito") motivo = perche;
      if (subito) { py.kill("SIGKILL"); return; }
      py.kill("SIGINT");
      timerKill ??= setTimeout(() => { if (!uscito) py.kill("SIGKILL"); }, o.attesaKillMs ?? 5_000);
    };
    const suAbort = () => termina("fermato");

    const righeStderr = (testo: string) => {
      if (stderrTesta.length < TESTA) stderrTesta += testo.slice(0, TESTA - stderrTesta.length);
      stderrCoda = (stderrCoda + testo).slice(-CODA);
      if (!o.suRigaStderr && !o.suProgresso) return;
      const righe = (rigaParziale + testo).split("\n");
      rigaParziale = righe.pop() ?? "";
      for (const r of righe) riga(r);
    };
    const riga = (r: string) => {
      const t = r.replace(/\r$/, "");
      if (!t) return;
      const p = o.suProgresso ? leggiProgresso(t) : null;
      if (p) o.suProgresso!(p);
      else o.suRigaStderr?.(t);
    };

    py.on("spawn", () => o.suAvvio?.(py.pid));
    py.stdout.on("data", (d: Buffer) => {
      if (sforato) return;
      stdout += decoOut.write(d);
      if (stdout.length > tetto) { sforato = true; stdout = ""; termina("tetto", true); }
    });
    py.stderr.on("data", (d: Buffer) => righeStderr(decoErr.write(d)));
    py.on("error", (err) => {
      uscito = true;
      chiudi({ codice: null, segnaleUscita: null, motivo: "avvio", erroreAvvio: err.message });
    });
    py.on("exit", () => { uscito = true; });
    py.on("close", (codice, segnaleUscita) => {
      uscito = true;
      if (!sforato) stdout += decoOut.end();
      righeStderr(decoErr.end());
      if (rigaParziale) { riga(rigaParziale); rigaParziale = ""; }
      chiudi({ codice, segnaleUscita, motivo });
    });

    if (o.timeoutMs && o.timeoutMs > 0) timerTimeout = setTimeout(() => termina("timeout"), o.timeoutMs);
    if (o.segnale) {
      if (o.segnale.aborted) suAbort();
      else o.segnale.addEventListener("abort", suAbort, { once: true });
    }

    py.stdin.on("error", () => { /* EPIPE: il processo ha chiuso prima di leggere tutto */ });
    py.stdin.end(o.ingresso === undefined ? undefined : JSON.stringify(o.ingresso));
  });
}

export interface OpzioniPython extends Omit<OpzioniProcesso, "comando" | "argomenti" | "env"> {
  script: ScriptConsentito;
  argv?: string[];
}

/** Lancia uno degli script consentiti con l'ambiente ristretto. */
export function eseguiPython(o: OpzioniPython): Promise<EsitoProcesso> {
  const { script, argv = [], ...resto } = o;
  return eseguiProcesso({
    ...resto,
    comando: "python3",
    argomenti: [percorsoScript(script), ...argv.map(String)],
    env: ambientePython(script),
  });
}

/** Lo stdout come JSON, o un errore con il messaggio pronto. */
export function jsonDallUscita(esito: EsitoProcesso): { ok: true; valore: any } | { ok: false; errore: string } {
  try { return { ok: true, valore: JSON.parse(esito.stdout) }; }
  catch (e: any) { return { ok: false, errore: e?.message ?? String(e) }; }
}

/** Descrizione breve di un'uscita non riuscita (per i log e i messaggi). */
export function descriviUscita(esito: EsitoProcesso): string {
  switch (esito.motivo) {
    case "avvio": return `Errore avvio Python: ${esito.erroreAvvio ?? "sconosciuto"}`;
    case "timeout": return "tempo massimo superato";
    case "fermato": return "fermato";
    case "tetto": return "uscita troppo grande";
    default: return `Python exit code ${esito.codice ?? esito.segnaleUscita}`;
  }
}
