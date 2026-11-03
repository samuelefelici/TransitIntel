/**
 * «I miei calcoli»: gli ultimi calcoli lanciati da chi è entrato (turni
 * macchina, turni guida, sincronizzazioni con Planning Studio, giri di Argos).
 * Girano nel lavoratore e continuano anche a pagina chiusa: da qui si vede a
 * che punto sono, si riaprono e si fermano. Dati da GET /api/lavori.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Cpu, Loader2, ExternalLink, Square, CheckCircle2, AlertTriangle, Clock, CircleSlash } from "lucide-react";
import { toast } from "sonner";
import { useCalcoli } from "@/hooks/use-calcoli";
import {
  etichetta, statoLeggibile, percentuale, durata, apriDi, dataEsercizio, vivo, type Calcolo,
} from "@/lib/calcoli";

const TONI: Record<Calcolo["status"], string> = {
  queued: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  running: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  completed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  failed: "border-red-500/40 bg-red-500/10 text-red-200",
  stopped: "border-zinc-500/40 bg-zinc-500/10 text-zinc-300",
};

function IconaStato({ c }: { c: Calcolo }) {
  if (c.status === "running") return <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />;
  if (c.status === "queued") return <Clock className="w-3.5 h-3.5" aria-hidden />;
  if (c.status === "completed") return <CheckCircle2 className="w-3.5 h-3.5" aria-hidden />;
  if (c.status === "stopped") return <CircleSlash className="w-3.5 h-3.5" aria-hidden />;
  return <AlertTriangle className="w-3.5 h-3.5" aria-hidden />;
}

const ora = (ms: number) => new Date(ms).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function RigaCalcolo({ c, onFerma }: { c: Calcolo; onFerma: (id: string) => Promise<void> }) {
  const [fermando, setFermando] = useState(false);
  // fermare non si annulla: il primo clic chiede conferma, il secondo ferma (entro 5 secondi)
  const [conferma, setConferma] = useState(false);
  useEffect(() => {
    if (!conferma) return;
    const t = setTimeout(() => setConferma(false), 5000);
    return () => clearTimeout(t);
  }, [conferma]);
  const nome = etichetta(c);
  const p = percentuale(c);
  const apri = apriDi(c);
  const giorno = dataEsercizio(c);
  const d = durata(c);
  return (
    <li className="rounded-xl border border-border/50 bg-card/60 p-4 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-semibold text-sm text-foreground">{nome}</span>
        {giorno && <span className="text-xs text-muted-foreground tabular-nums">esercizio del {giorno}</span>}
        <span className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONI[c.status]}`}>
          <IconaStato c={c} /> {statoLeggibile(c)}
        </span>
      </div>

      {vivo(c) && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-muted/30 overflow-hidden" role="progressbar" aria-label={`Avanzamento: ${nome}`}
            aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={c.status === "running" ? (p ?? undefined) : undefined}
            aria-valuetext={c.status === "queued" ? "In coda" : p != null ? `${p}%` : "In corso"}>
            <div className={`h-full rounded-full ${c.status === "queued" ? "bg-amber-400/60" : "bg-sky-400"} transition-[width] duration-500`}
              style={{ width: `${c.status === "queued" ? 4 : (p ?? 8)}%` }} />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {c.status === "queued" ? "In coda: parte appena si libera il calcolatore" : (c.progress?.detail || "In corso")}
            {p != null && c.status === "running" ? ` · ${p}%` : ""}
          </div>
        </div>
      )}

      {c.error && !vivo(c) && <p className="text-xs text-red-300/90">{c.error}</p>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
        <span>Lanciato il {ora(c.createdAt)}</span>
        {d && <span>{vivo(c) ? "da" : "durata"} {d}</span>}
        <span className="ml-auto flex items-center gap-2">
          {vivo(c) && !c.stopping && (
            <button
              type="button"
              onClick={async () => {
                if (!conferma) { setConferma(true); return; }
                setConferma(false);
                setFermando(true);
                try { await onFerma(c.jobId); }
                finally { setFermando(false); }
              }}
              disabled={fermando}
              aria-label={conferma ? `Conferma: ferma ${nome}` : `Ferma ${nome}`}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border disabled:opacity-50 ${conferma
                ? "border-red-500 bg-red-500/20 text-red-100 hover:bg-red-500/30"
                : "border-red-500/40 text-red-300 hover:bg-red-500/10"}`}
            >
              {fermando ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden /> : <Square className="w-3 h-3" aria-hidden />}
              {conferma ? "Sicuro? Ferma" : "Ferma"}
            </button>
          )}
          {apri && (
            <Link href={apri} aria-label={`Apri ${nome}`} className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border/60 text-foreground hover:bg-muted/40">
              <ExternalLink className="w-3 h-3" aria-hidden /> Apri
            </Link>
          )}
        </span>
      </div>
    </li>
  );
}

export default function CalcoliPage() {
  const { calcoli, isLoading, isError, error, ferma } = useCalcoli();
  const viviN = calcoli.filter(vivo).length;
  const onFerma = async (id: string) => {
    try {
      const esito = await ferma(id);
      toast.success(esito === "stopped" ? "Calcolo tolto dalla coda" : "Stop chiesto: il calcolo si ferma fra qualche secondo");
    } catch (e: any) {
      toast.error("Stop non riuscito", { description: e?.message });
    }
  };
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-xl font-bold flex items-center gap-2"><Cpu className="w-5 h-5 text-primary" aria-hidden /> I miei calcoli</h1>
        <p className="text-sm text-muted-foreground max-w-prose">
          Turni macchina, turni guida, sincronizzazioni con Planning Studio e giri di Argos che hai lanciato.
          Girano sul server e continuano anche se chiudi la pagina: da qui li ritrovi, li riapri o li fermi.
          {viviN > 0 ? ` In questo momento ne hai ${viviN === 1 ? "uno" : viviN} in corso.` : ""}
        </p>
      </header>

      {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Carico i calcoli…</div>}
      {isError && <p className="text-sm text-red-300">Non riesco a leggere i calcoli: {(error as Error)?.message}</p>}
      {!isLoading && !isError && calcoli.length === 0 && (
        <p className="text-sm text-muted-foreground rounded-xl border border-dashed border-border/60 p-6 text-center">
          Nessun calcolo negli ultimi 30 giorni. Quando ottimizzi turni macchina o turni guida, li trovi qui.
        </p>
      )}
      {calcoli.length > 0 && (
        <ul className="space-y-3">
          {calcoli.map(c => <RigaCalcolo key={c.jobId} c={c} onFerma={onFerma} />)}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">
        Si vedono gli ultimi 20 calcoli. I risultati restano disponibili 7 giorni, l'elenco 30.
      </p>
    </div>
  );
}
