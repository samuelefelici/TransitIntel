/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONTROLLO SETTIMANALE AVM — chi ha ripreso a localizzarsi, chi ha smesso
 * ───────────────────────────────────────────────────────────────────────────
 * Mentre l'officina e Mizar rimettono a posto gli apparati, la domanda di
 * ogni lunedì è un confronto: rispetto alla settimana prima, quali vetture
 * hanno ripreso a localizzarsi e quali hanno smesso? Questa vista risponde
 * settimana per settimana, con la prova accanto (le 14 giornate e le 8
 * settimane di ogni vettura) e l'esito degli interventi chiusi in FleetCare.
 *
 * Le settimane chiuse arrivano dall'archivio, congelate com'erano il lunedì
 * dopo; la settimana in corso è calcolata adesso ed è provvisoria. Il foglio
 * Excel esporta il perimetro che si sta guardando.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Download, Archive, AlertTriangle, Search, Wrench,
  TrendingDown, TrendingUp, CircleSlash, Sparkles, LogOut, HelpCircle, Check,
} from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";

/* ── I tipi, come li manda l'API (lib/avm-controllo.ts) ─────────────────── */

type Categoria = "fermata" | "ripresa" | "guasta" | "nuova" | "uscita" | "funziona" | "non_giudicabile";
type EsitoIntervento =
  | "riuscito" | "gia_funzionava" | "senza_effetto" | "peggiorato" | "ricaduta"
  | "senza_confronto" | "da_verificare" | "non_nel_flusso";
type StatoOfficina = "in_servizio" | "riserva" | "in_officina" | "dismesso";

interface Sintesi {
  lunedi: string;
  stato: "F" | "P" | "M" | "A" | ".";
  giornateOsservate: number;
  conContatto: number;
  conPosizione: number;
  conCorsa: number;
  conErroreGps: number;
}

interface Intervento {
  matricola: string;
  fonte: string;
  riferimento: string;
  chiusaIl: string;
  descrizione: string | null;
  giornoChiusura: string;
  esitoAvm: EsitoIntervento;
  giorniPrima: number;
  posizionePrima: number;
  giorniDopo: number;
  posizioneDopo: number;
  primaPosizioneDopo: string | null;
}

interface Vettura {
  vehicleRef: string;
  codice: string | null;
  azienda: string;
  mezzo: string | null;
  categoria: Categoria;
  settimana: Sintesi;
  prima: Sintesi | null;
  dal: string | null;
  ultimaPosizione: string | null;
  giorniSenzaPosizione: number | null;
  giorni: string;
  storia: string;
  officina: { targa: string; deposito: string | null; stato: StatoOfficina } | null;
  esclusa: { motivo: "fuori_parco" | "dismesso" | "in_officina" | "gia_segnalata"; testo: string } | null;
  interventi: Intervento[];
  nota: string;
}

interface Settimana {
  lunedi: string;
  domenica: string;
  giornateOsservate: number;
  giornateParziali: number;
  giornateSenzaDati: number;
  giornateFuture: number;
}

interface Resp {
  configured: boolean;
  archiviato: boolean;
  ultimaChiusa: string;
  settimanaCorrente: string;
  erroreArchivio: string | null;
  versione: number;
  generatoIl: string;
  settimana: Settimana & { chiusa: boolean };
  precedente: Settimana;
  giornate: string[];
  settimane: Settimana[];
  conteggi: Record<Categoria, number>;
  vetture: Vettura[];
  interventi: Intervento[];
  nota: string;
  officina?: { disponibile: boolean; motivo: string | null; tenant: string | null; lettoAlle: string; mezzi: number } | null;
  fonteInterventi?: { disponibile: boolean; motivo: string | null } | null;
  error?: string;
}

interface RespArchivio {
  settimane: Array<{
    lunedi: string; generatoIl: string; versione: number;
    conteggi: Partial<Record<Categoria, number>>;
    /* solo Conerobus, escluse fuori parco e dismesse; assente se l'API è più vecchia della pagina */
    conteggiConerobus?: Partial<Record<Categoria, number>>;
  }>;
  errore: string | null;
}

/* ── I colori: gli stessi del diario e del foglio Excel ─────────────────── */

const CATEGORIE: Record<Categoria, { titolo: string; breve: string; colore: string; fondo: string; icona: React.ElementType; perche: string }> = {
  fermata: { titolo: "Ha smesso di localizzarsi", breve: "Si è fermata", colore: "#f87171", fondo: "rgba(248,113,113,0.12)", icona: TrendingDown,
    perche: "si localizzava la settimana prima, ora no" },
  ripresa: { titolo: "Ha ripreso a localizzarsi", breve: "Ripresa", colore: "#34d399", fondo: "rgba(52,211,153,0.12)", icona: TrendingUp,
    perche: "non si localizzava, ora sì" },
  guasta: { titolo: "Ancora non si localizza", breve: "Ancora guasta", colore: "#fb923c", fondo: "rgba(251,146,60,0.12)", icona: Wrench,
    perche: "né la settimana prima né ora" },
  nuova: { titolo: "Nuova nel flusso", breve: "Nuova", colore: "#c084fc", fondo: "rgba(192,132,252,0.12)", icona: Sparkles,
    perche: "compare per la prima volta" },
  uscita: { titolo: "Uscita dal flusso", breve: "Uscita", colore: "#94a3b8", fondo: "rgba(148,163,184,0.12)", icona: LogOut,
    perche: "il flusso non la elenca più" },
  funziona: { titolo: "Funziona", breve: "Funziona", colore: "#7dd3fc", fondo: "rgba(125,211,252,0.12)", icona: Check,
    perche: "si localizza prima e ora" },
  non_giudicabile: { titolo: "Non giudicabile", breve: "Non giudicabile", colore: "#71717a", fondo: "rgba(113,113,122,0.12)", icona: HelpCircle,
    perche: "troppo poche giornate, o niente da confrontare" },
};
const ORDINE: Categoria[] = ["fermata", "ripresa", "guasta", "nuova", "uscita", "funziona", "non_giudicabile"];

const GIORNO: Record<string, { colore: string | null; testo: string }> = {
  S: { colore: "#34d399", testo: "in servizio" },
  T: { colore: "#7dd3fc", testo: "si localizza" },
  C: { colore: "#fbbf24", testo: "parla, senza posizione" },
  M: { colore: "#3f3f46", testo: "nessun contatto" },
  "-": { colore: null, testo: "non elencata" },
  ".": { colore: null, testo: "giornata non contata" },
  " ": { colore: null, testo: "non ancora finita" },
};
const SETTIMANA: Record<string, { colore: string | null; testo: string }> = {
  F: { colore: "#34d399", testo: "si è localizzata" },
  P: { colore: "#fbbf24", testo: "ha parlato, mai localizzata" },
  M: { colore: "#3f3f46", testo: "nessun contatto" },
  A: { colore: null, testo: "non elencata" },
  ".": { colore: null, testo: "meno di 3 giornate contate" },
};
const ESITI: Record<EsitoIntervento, { testo: string; colore: string }> = {
  riuscito: { testo: "Riuscito", colore: "#34d399" },
  gia_funzionava: { testo: "Si localizzava già", colore: "#7dd3fc" },
  senza_effetto: { testo: "Senza effetto", colore: "#f87171" },
  peggiorato: { testo: "Prima sì, dopo no", colore: "#fb923c" },
  ricaduta: { testo: "Ricaduta", colore: "#f87171" },
  senza_confronto: { testo: "Dopo si localizza (senza confronto)", colore: "#a7f3d0" },
  da_verificare: { testo: "Da verificare", colore: "#fbbf24" },
  non_nel_flusso: { testo: "Non nel flusso SIRI", colore: "#a1a1aa" },
};

/* La frase di sintesi sul perimetro scelto, con le stesse parole del server
   (notaGenerale in api-server/src/lib/avm-controllo.ts): così la frase e le
   schede contano le stesse vetture. */
const FRASE: Record<Categoria, [string, string]> = {
  fermata: ["ha smesso di localizzarsi", "hanno smesso di localizzarsi"],
  ripresa: ["ha ripreso a localizzarsi", "hanno ripreso a localizzarsi"],
  guasta: ["ancora non si localizza", "ancora non si localizzano"],
  nuova: ["è nuova nel flusso", "sono nuove nel flusso"],
  uscita: ["è uscita dal flusso", "sono uscite dal flusso"],
  funziona: ["funziona", "funzionano"],
  non_giudicabile: ["non si può giudicare", "non si possono giudicare"],
};
const GIORNATE_MINIME = 3;

function fraseDiSintesi(s: Settimana & { chiusa: boolean }, c: Record<Categoria, number>, totale: number): string {
  const periodo = `dal ${ddmm(s.lunedi)} al ${ddmm(s.domenica)}`;
  if (s.giornateOsservate === 0) {
    return s.chiusa
      ? `Nessuna giornata con abbastanza raccolta ${periodo}: la settimana non si può giudicare.`
      : `La settimana ${periodo} non ha ancora giornate finite con abbastanza raccolta.`;
  }
  const voci = ORDINE.filter(k => c[k] > 0).map(k => `${c[k]} ${FRASE[k][c[k] === 1 ? 0 : 1]}`);
  let frase = `${totale} ${totale === 1 ? "vettura" : "vetture"} ${periodo}`
    + `${s.chiusa ? "" : " (settimana in corso, risultato provvisorio)"}: ${voci.join(", ")}.`;
  const possibili = 7 - s.giornateFuture;
  if (s.giornateOsservate < GIORNATE_MINIME) {
    frase += ` Solo ${s.giornateOsservate} ${s.giornateOsservate === 1 ? "giornata contata" : "giornate contate"}: `
      + `ne servono almeno ${GIORNATE_MINIME} per giudicare.`;
  } else if (s.giornateOsservate < possibili) {
    frase += ` Giornate contate: ${s.giornateOsservate} su ${possibili} (le altre senza raccolta sufficiente).`;
  }
  return frase;
}

const isConerobus = (ref: string) => /^\d{1,4}$/.test(ref);

function ddmm(g: string | null): string {
  if (!g) return "";
  const [, m, d] = g.split("-");
  return `${d}/${m}`;
}
function ddmmyyyy(g: string | null): string {
  return g ? g.slice(0, 10).split("-").reverse().join("/") : "";
}
function spostaGiorni(g: string, n: number): string {
  return new Date(new Date(`${g}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/* L'ultima settimana chiusa vista da qui, quando il server non ha risposto:
   serve solo da àncora per navigare. La giornata di esercizio finisce alle 03:00. */
function ultimaChiusaLocale(): string {
  const t = new Date(Date.now() - 3 * 3_600_000);
  const oggi = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  return spostaGiorni(oggi, -((t.getDay() + 6) % 7) - 7);
}
function dataOra(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Un quadratino della striscia: pieno col colore, a contorno se non elencata, un punto se non contata. */
function Quadratino({ ch, mappa, titolo, alto = "h-4" }: {
  ch: string; mappa: Record<string, { colore: string | null; testo: string }>; titolo: string; alto?: string;
}) {
  const voce = mappa[ch] ?? { colore: null, testo: ch };
  if (voce.colore) {
    return <span title={`${titolo}: ${voce.testo}`} className={`w-2.5 ${alto} rounded-[2px] shrink-0`}
      style={{ background: voce.colore, opacity: ch === "M" ? 0.55 : 0.9 }} />;
  }
  if (ch === "-" || ch === "A") {
    return <span title={`${titolo}: ${voce.testo}`} className={`w-2.5 ${alto} rounded-[2px] shrink-0 border border-border/50`} />;
  }
  return (
    <span title={`${titolo}: ${voce.testo}`} className={`w-2.5 ${alto} shrink-0 flex items-center justify-center`}>
      {ch === "." && <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />}
    </span>
  );
}

export default function ControlloAvm() {
  const [lunedi, setLunedi] = useState<string | null>(null);
  const [soloConerobus, setSoloConerobus] = useState(true);
  const [soloParcoOfficina, setSoloParcoOfficina] = useState(true);
  const [filtro, setFiltro] = useState<Categoria | null>(null);
  const [cerca, setCerca] = useState("");

  const q = useQuery({
    queryKey: ["controllo-avm", lunedi],
    queryFn: () => apiFetch<Resp>(`/api/siri/parco/controllo${lunedi ? `?settimana=${lunedi}` : ""}`),
    staleTime: 5 * 60 * 1000,
  });
  const archivio = useQuery({
    queryKey: ["controllo-avm-archivio"],
    queryFn: () => apiFetch<RespArchivio>("/api/siri/parco/controllo/archivio"),
    staleTime: 10 * 60 * 1000,
  });
  const d = q.data;
  const officinaAttiva = !!d?.officina?.disponibile;

  /* Il perimetro si applica PRIMA dei conteggi: le schede e l'andamento
     contano quello che si sta guardando, come nel diario. */
  const perimetro = useMemo(
    () => (d?.vetture ?? []).filter(v =>
      (!soloConerobus || isConerobus(v.vehicleRef))
      && (!officinaAttiva || !soloParcoOfficina || !v.esclusa)),
    [d, soloConerobus, soloParcoOfficina, officinaAttiva],
  );
  const conteggi = useMemo(() => {
    const c = Object.fromEntries(ORDINE.map(k => [k, 0])) as Record<Categoria, number>;
    for (const v of perimetro) c[v.categoria]++;
    return c;
  }, [perimetro]);
  const andamento = useMemo(() => (d?.settimane ?? []).map((s, i) => {
    const n = { F: 0, P: 0, M: 0, A: 0 };
    for (const v of perimetro) {
      const ch = v.storia[i];
      if (ch === "F" || ch === "P" || ch === "M" || ch === "A") n[ch]++;
    }
    return { ...s, ...n };
  }), [d, perimetro]);
  const visibili = useMemo(() => {
    const term = cerca.trim().toLowerCase();
    return perimetro.filter(v =>
      (!filtro || v.categoria === filtro)
      && (!term || v.vehicleRef.toLowerCase().includes(term)
        || (v.codice ?? "").toLowerCase().includes(term)
        || (v.mezzo ?? "").toLowerCase().includes(term)
        || (v.officina?.targa ?? "").toLowerCase().includes(term)));
  }, [perimetro, filtro, cerca]);
  const interventi = useMemo(() => {
    const refs = new Set(perimetro.map(v => v.vehicleRef));
    /* quelli su vetture che il flusso non elenca non hanno una riga da filtrare: restano */
    return (d?.interventi ?? []).filter(i => refs.has(i.matricola) || i.esitoAvm === "non_nel_flusso");
  }, [d, perimetro]);

  if (q.isLoading) {
    return <div className="p-12 text-center text-xs text-muted-foreground">Calcolo il controllo della settimana…</div>;
  }
  if (q.error || d?.error || !d) {
    /* Anche con un errore si deve poter cambiare settimana o tornare all'ultima chiusa. */
    const ancora = lunedi ?? ultimaChiusaLocale();
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLunedi(spostaGiorni(ancora, -7))}
            className="p-1.5 rounded-lg border border-border/40 bg-white/[0.02] hover:bg-white/5 text-muted-foreground"
            aria-label="Settimana precedente"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <span className="px-2 text-[12px] tabular-nums">Settimana del {ddmmyyyy(ancora)}</span>
          <button
            onClick={() => setLunedi(spostaGiorni(ancora, 7))}
            className="p-1.5 rounded-lg border border-border/40 bg-white/[0.02] hover:bg-white/5 text-muted-foreground"
            aria-label="Settimana successiva"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setLunedi(null); void q.refetch(); }}
            className="px-2.5 py-1 rounded-lg text-[11px] border border-border/40 bg-white/[0.02] hover:bg-white/5"
          >
            {lunedi ? "Torna all'ultima settimana chiusa" : "Riprova"}
          </button>
        </div>
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[11px] text-red-200 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Il controllo non si è potuto leggere: {d?.error ?? (q.error as Error)?.message ?? "nessuna risposta"}</span>
        </div>
      </div>
    );
  }

  const settimanaMostrata = d.settimana.lunedi;
  const prossima = spostaGiorni(settimanaMostrata, 7);
  const parametri = new URLSearchParams({ settimana: settimanaMostrata });
  if (soloConerobus) parametri.set("perimetro", "conerobus");
  if (officinaAttiva && soloParcoOfficina) parametri.set("officina", "1");
  const maxAndamento = Math.max(1, ...andamento.map(a => a.F + a.P + a.M + a.A));

  return (
    <div className="space-y-5">
      {/* ── Testata: la settimana, come è stata calcolata, gli export ──────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setLunedi(spostaGiorni(settimanaMostrata, -7)); setFiltro(null); }}
            className="p-1.5 rounded-lg border border-border/40 bg-white/[0.02] hover:bg-white/5 text-muted-foreground"
            aria-label="Settimana precedente"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <div className="px-3 py-1 text-[12px] font-medium tabular-nums">
            Settimana {ddmm(d.settimana.lunedi)} – {ddmmyyyy(d.settimana.domenica)}
          </div>
          <button
            onClick={() => { setLunedi(prossima); setFiltro(null); }}
            disabled={prossima > d.settimanaCorrente}
            className="p-1.5 rounded-lg border border-border/40 bg-white/[0.02] hover:bg-white/5 text-muted-foreground disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Settimana successiva"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <span className={`px-2 py-0.5 rounded-md text-[10px] border ${d.settimana.chiusa
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          : "border-amber-500/30 bg-amber-500/10 text-amber-200"}`}>
          {d.settimana.chiusa ? "settimana chiusa" : "settimana in corso: provvisoria"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {d.archiviato ? `archiviata il ${dataOra(d.generatoIl)}` : `calcolata il ${dataOra(d.generatoIl)}`}
        </span>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" id="controllo-solo-conerobus" checked={soloConerobus}
            onChange={e => setSoloConerobus(e.target.checked)} />
          solo Conerobus
        </label>
        {officinaAttiva && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
            title="Toglie le vetture che il parco dell'officina non ha più o dà per dismesse">
            <input type="checkbox" id="controllo-solo-parco-officina" checked={soloParcoOfficina}
              onChange={e => setSoloParcoOfficina(e.target.checked)} />
            solo parco officina
          </label>
        )}
        <a
          href={`${getApiBase()}/api/siri/parco/controllo?${parametri.toString()}&formato=xlsx`}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-200 transition-colors"
        >
          <Download className="w-3 h-3" /> Controllo settimanale (Excel)
        </a>
        <a
          href={`${getApiBase()}/api/siri/parco/controllo?${parametri.toString()}&formato=csv`}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 border border-border/60 transition-colors"
          title="Solo i dati, senza colori: per chi li deve incrociare"
        >
          <Download className="w-3 h-3" /> CSV
        </a>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground max-w-3xl">
        {fraseDiSintesi(d.settimana, conteggi, perimetro.length)}
      </p>

      {d.settimana.giornateOsservate < GIORNATE_MINIME && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{d.settimana.chiusa
            ? `Questa settimana ha ${d.settimana.giornateOsservate} giornate con abbastanza raccolta: il connettore `
              + "è stato fermo, e le vetture non si possono giudicare."
            : `Servono almeno ${GIORNATE_MINIME} giornate finite con abbastanza raccolta per giudicare la settimana: `
              + `per ora sono ${d.settimana.giornateOsservate}. Il confronto si legge dal giovedì mattina.`}</span>
        </div>
      )}

      {/* ── Le categorie: che cosa è cambiato ───────────────────────────── */}
      <section className="grid gap-2 grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
        {ORDINE.map(cat => {
          const c = CATEGORIE[cat];
          const attivo = filtro === cat;
          const Icona = c.icona;
          return (
            <button
              key={cat}
              onClick={() => setFiltro(f => (f === cat ? null : cat))}
              aria-pressed={attivo}
              className="text-left rounded-xl p-3 space-y-1 border transition-colors"
              style={{ background: c.fondo, borderColor: attivo ? c.colore : "rgba(255,255,255,0.08)" }}
            >
              <div className="flex items-center gap-1.5">
                <Icona className="w-3.5 h-3.5" style={{ color: c.colore }} />
                <span className="text-[11px] font-medium" style={{ color: c.colore }}>{c.breve}</span>
              </div>
              <div className="font-mono text-xl tabular-nums" style={{ color: c.colore }}>{conteggi[cat]}</div>
              <p className="text-[10px] text-muted-foreground leading-snug">{c.perche}</p>
            </button>
          );
        })}
      </section>

      {/* ── L'andamento delle ultime settimane ──────────────────────────── */}
      <section className="rounded-xl border border-border/50 bg-white/[0.02] p-4 space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[12px] font-medium">Le ultime {andamento.length} settimane</h3>
          <span className="text-[10px] text-muted-foreground">
            quante vetture del perimetro si sono localizzate, settimana per settimana
          </span>
        </div>
        <div className="flex items-end gap-2 h-24">
          {andamento.map(a => {
            const tot = a.F + a.P + a.M + a.A;
            return (
              <button
                key={a.lunedi}
                onClick={() => { setLunedi(a.lunedi); setFiltro(null); }}
                className="flex-1 flex flex-col justify-end min-w-0 h-full rounded-sm focus-visible:ring-1 focus-visible:ring-sky-400"
                title={a.giornateOsservate === 0
                  ? `${ddmm(a.lunedi)}: settimana senza raccolta`
                  : `${ddmm(a.lunedi)} – ${ddmm(a.domenica)}: si localizzano ${a.F}, parlano soltanto ${a.P}, mute ${a.M}`
                    + `${a.A ? `, non elencate ${a.A}` : ""} · ${a.giornateOsservate} giornate contate`}
                aria-label={`Apri la settimana del ${ddmm(a.lunedi)}`}
                style={{ opacity: a.giornateOsservate === 0 ? 0.3 : a.lunedi === settimanaMostrata ? 1 : 0.75 }}
              >
                {a.giornateOsservate > 0 && tot > 0 && ([["M", a.M], ["P", a.P], ["F", a.F]] as Array<[string, number]>).map(([k, n]) =>
                  n > 0 ? <div key={k} style={{ height: `${(n / maxAndamento) * 100}%`, background: SETTIMANA[k].colore ?? undefined, opacity: k === "M" ? 0.5 : 0.85 }} /> : null)}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {andamento.map(a => (
            <span key={a.lunedi} className={`flex-1 text-center text-[9px] font-mono min-w-0 truncate ${a.lunedi === settimanaMostrata ? "text-foreground" : "text-muted-foreground"}`}>
              {ddmm(a.lunedi)}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          {(["F", "P", "M"] as const).map(k => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: SETTIMANA[k].colore ?? undefined }} /> {SETTIMANA[k].testo}
            </span>
          ))}
        </div>
      </section>

      {/* ── Gli interventi chiusi in FleetCare ─────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-[12px] font-medium flex items-center gap-1.5">
          <Wrench className="w-3.5 h-3.5 text-amber-300" /> Interventi AVM chiusi
          <span className="text-[10px] font-normal text-muted-foreground">
            dall'officina (FleetCare), con quello che l'apparato ha fatto dopo
          </span>
        </h3>
        {d.fonteInterventi && !d.fonteInterventi.disponibile ? (
          <p className="text-[10px] text-muted-foreground leading-relaxed">{d.fonteInterventi.motivo}</p>
        ) : interventi.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">Nessun intervento AVM chiuso nelle settimane guardate, nel perimetro scelto.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/50">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/40">
                  <th className="px-3 py-2 font-medium">Vettura</th>
                  <th className="px-3 py-2 font-medium">Intervento</th>
                  <th className="px-3 py-2 font-medium">Chiuso il</th>
                  <th className="px-3 py-2 font-medium">Esito sull'apparato</th>
                  <th className="px-3 py-2 font-medium text-right">Prima</th>
                  <th className="px-3 py-2 font-medium text-right">Dopo</th>
                  <th className="px-3 py-2 font-medium">Descrizione</th>
                </tr>
              </thead>
              <tbody>
                {interventi.map(i => (
                  <tr key={`${i.matricola}-${i.riferimento}`} className="border-b border-border/20 last:border-0">
                    <td className="px-3 py-1.5 font-mono">{i.matricola}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{i.riferimento} <span className="font-sans text-[10px]">({i.fonte})</span></td>
                    <td className="px-3 py-1.5 tabular-nums">{ddmmyyyy(i.giornoChiusura)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: ESITI[i.esitoAvm].colore }}>
                      {ESITI[i.esitoAvm].testo}
                      {i.primaPosizioneDopo && <span className="text-muted-foreground"> · dal {ddmm(i.primaPosizioneDopo)}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground" title="giornate con posizione su giornate contate, nella settimana prima della chiusura">
                      {i.posizionePrima}/{i.giorniPrima}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground" title="giornate con posizione su giornate contate, dopo la chiusura">
                      {i.posizioneDopo}/{i.giorniDopo}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground max-w-[320px] truncate" title={i.descrizione ?? undefined}>{i.descrizione ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.officina && !d.officina.disponibile && (
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Parco dell'officina non disponibile: {d.officina.motivo}
          </p>
        )}
      </section>

      {/* ── Le vetture ─────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[12px] font-medium">
            {filtro ? CATEGORIE[filtro].titolo : "Tutte le vetture"}
            <span className="ml-1.5 font-mono text-muted-foreground">{visibili.length}</span>
          </h3>
          {filtro && (
            <button onClick={() => setFiltro(null)} className="text-[10px] text-sky-300 hover:underline">mostra tutte</button>
          )}
          <div className="ml-auto relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              id="controllo-cerca"
              aria-label="Cerca per matricola, targa o mezzo"
              value={cerca}
              onChange={e => setCerca(e.target.value)}
              placeholder="matricola, targa o mezzo"
              className="pl-7 pr-2 py-1 w-48 rounded-lg text-[11px] bg-white/[0.03] border border-border/40 focus:border-border outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border/50">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border/40">
                <th className="px-3 py-2 font-medium">Vettura</th>
                <th className="px-3 py-2 font-medium">Categoria</th>
                <th className="px-3 py-2 font-medium">
                  <span title={`${ddmm(d.giornate[0])} – ${ddmm(d.giornate[6])} | ${ddmm(d.giornate[7])} – ${ddmm(d.giornate[13])}`}>
                    Giornate: prima | questa
                  </span>
                </th>
                <th className="px-3 py-2 font-medium">Settimane</th>
                <th className="px-3 py-2 font-medium">Dal</th>
                <th className="px-3 py-2 font-medium">Nota</th>
              </tr>
            </thead>
            <tbody>
              {visibili.map(v => {
                const c = CATEGORIE[v.categoria];
                return (
                  <tr key={v.vehicleRef} className="border-b border-border/20 last:border-0 hover:bg-white/[0.02] align-top">
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="font-mono">{v.vehicleRef}</span>
                      {v.codice && v.codice !== v.vehicleRef && <span className="ml-1.5 text-[10px] text-muted-foreground">{v.codice}</span>}
                      <span className="block text-[10px] text-muted-foreground/80 truncate max-w-[220px]" title={v.mezzo ?? undefined}>
                        {v.mezzo ?? v.azienda}
                      </span>
                      {(v.esclusa || v.officina) && (
                        <span className="block text-[10px] text-muted-foreground/70 truncate max-w-[220px]">
                          {v.esclusa
                            ? <span style={{ color: "#94a3b8" }}>{v.esclusa.motivo === "fuori_parco" ? "fuori parco" : "dismessa"}</span>
                            : v.officina && <>
                              {v.officina.stato === "in_officina" && <span className="text-amber-300">in officina · </span>}
                              {v.officina.targa}{v.officina.deposito ? ` · ${v.officina.deposito}` : ""}
                            </>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded-md text-[10px]" style={{ color: c.colore, background: c.fondo }}>{c.breve}</span>
                      {v.interventi.length > 0 && (
                        <span className="block mt-1 text-[10px]" style={{ color: ESITI[v.interventi[v.interventi.length - 1].esitoAvm].colore }}
                          title={v.interventi.map(i => `${i.riferimento} chiuso il ${ddmmyyyy(i.giornoChiusura)}: ${ESITI[i.esitoAvm].testo}`).join("\n")}>
                          <Wrench className="inline w-2.5 h-2.5 mr-0.5" />
                          {ESITI[v.interventi[v.interventi.length - 1].esitoAvm].testo}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-0.5">
                        {[...v.giorni].map((ch, i) => (
                          <React.Fragment key={i}>
                            {i === 7 && <span className="w-1.5 shrink-0" />}
                            <Quadratino ch={ch} mappa={GIORNO} titolo={ddmm(d.giornate[i])} />
                          </React.Fragment>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-0.5">
                        {[...v.storia].map((ch, i) => (
                          <Quadratino key={i} ch={ch} mappa={SETTIMANA} titolo={`settimana del ${ddmm(d.settimane[i]?.lunedi ?? null)}`} alto="h-3" />
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground">{ddmm(v.dal)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground leading-snug min-w-[280px] max-w-[520px]">{v.nota}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibili.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
              {d.vetture.length === 0
                ? "Il diario non ha ancora giornate per questa settimana."
                : "Nessuna vettura con questi criteri."}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          {(["S", "T", "C", "M"] as const).map(k => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: GIORNO[k].colore ?? undefined }} /> {GIORNO[k].testo}
            </span>
          ))}
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm border border-border/50" /> non elencata</span>
          <span className="flex items-center gap-1.5"><span className="w-1 h-1 rounded-full bg-muted-foreground/40" /> giornata non contata</span>
        </div>
      </section>

      {/* ── L'archivio ─────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h3 className="text-[12px] font-medium flex items-center gap-1.5">
          <Archive className="w-3.5 h-3.5 text-sky-300" /> Controlli archiviati
          <span className="text-[10px] font-normal text-muted-foreground">
            uno per settimana chiusa, calcolato da solo il lunedì dopo
          </span>
        </h3>
        {archivio.isLoading ? (
          <p className="text-[10px] text-muted-foreground">Leggo l'archivio…</p>
        ) : archivio.isError ? (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
            <CircleSlash className="w-3 h-3" /> Archivio non raggiungibile: {(archivio.error as Error)?.message}
          </p>
        ) : archivio.data?.errore ? (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
            <CircleSlash className="w-3 h-3" /> Archivio non disponibile: {archivio.data.errore}
          </p>
        ) : (archivio.data?.settimane ?? []).length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            Nessun controllo archiviato ancora: il primo si scrive da solo al prossimo giro orario dopo la chiusura di una settimana.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {archivio.data!.settimane.map(s => {
              /* le pastiglie contano il perimetro di base (solo Conerobus, parco officina) */
              const n = s.conteggiConerobus ?? s.conteggi;
              return (
              <button
                key={s.lunedi}
                onClick={() => { setLunedi(s.lunedi); setFiltro(null); }}
                aria-pressed={s.lunedi === settimanaMostrata}
                className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${s.lunedi === settimanaMostrata
                  ? "bg-white/10 border-border text-foreground"
                  : "bg-white/[0.02] border-border/40 text-muted-foreground hover:bg-white/5"}`}
                title={`archiviato il ${dataOra(s.generatoIl)} · Conerobus del parco: `
                  + `${n.fermata ?? 0} si sono fermate, ${n.ripresa ?? 0} hanno ripreso`}
              >
                <span className="tabular-nums">{ddmm(s.lunedi)}</span>
                <span className="ml-1.5 font-mono" style={{ color: CATEGORIE.fermata.colore }}>−{n.fermata ?? 0}</span>
                <span className="ml-1 font-mono" style={{ color: CATEGORIE.ripresa.colore }}>+{n.ripresa ?? 0}</span>
              </button>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
