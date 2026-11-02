/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANDAMENTO AVM — come va il parco da quando lo si osserva, e che cosa fare
 * ───────────────────────────────────────────────────────────────────────────
 * Mentre si sistemano gli apparati, questa vista risponde a tre domande:
 *   · quante vetture si localizzano, settimana per settimana, dall'inizio;
 *   · su quali intervenire (da riparare, da verificare: guasta o alienata?);
 *   · che cosa chiedere a Mizar: togliere le vetture che l'officina non ha
 *     più, aggiungere quelle nuove. Le richieste si segnano qui, e Cerbero le
 *     chiude da solo quando il flusso SIRI mostra la vettura sparita o comparsa.
 *
 * I conti li fa il server (api-server/src/lib/avm-storia.ts) con la stessa
 * regola del controllo settimanale; la pagina sceglie solo il perimetro.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, Download, Search, Wrench, Trash2, PlusCircle, HelpCircle, Hourglass, Copy,
  CheckSquare, X, Send,
} from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";
import { Quadratino, SETTIMANA } from "@/components/avm/strisce";
import {
  andamentoPerimetro, conteggiAzioni, ddmm, eConerobus, fraseAndamento, selezionabile,
  tipoDellaSelezione, type Azione, type SettimanaStoria,
} from "@/lib/storia-avm";

/* ── I tipi, come li manda l'API (GET /api/siri/parco/storia) ───────────── */

type StatoOfficina = "in_servizio" | "riserva" | "in_officina" | "dismesso";
type EsitoIntervento =
  | "riuscito" | "gia_funzionava" | "senza_effetto" | "peggiorato" | "ricaduta"
  | "senza_confronto" | "da_verificare" | "non_nel_flusso";

interface Richiesta {
  id: string;
  vehicleRef: string;
  tipo: "togliere" | "aggiungere";
  richiestaIl: string;
  nota: string | null;
  creataIl: string;
  creataDa: string | null;
  esito: "fatta" | "annullata" | null;
  chiusaIl: string | null;
  chiusaDa: string | null;
  automatica: boolean;
  giorniAttesa: number;
  ricomparsaIl: string | null;
  sollecitare: boolean;
}

interface Vettura {
  vehicleRef: string;
  codice: string | null;
  azienda: string;
  mezzo: string | null;
  storia: string;
  primoGiorno: string | null;
  ultimoGiorno: string | null;
  inSiri: boolean;
  ultimaPosizione: string | null;
  ultimoContatto: string | null;
  settimaneSenzaPosizione: number | null;
  senzaPosizioneDal: string | null;
  settimaneSilenzio: number;
  officina: {
    targa: string; deposito: string | null; modello: string | null; stato: StatoOfficina;
    segnalazioneAvm: { numero: string } | null;
  } | null;
  esclusa: { motivo: "fuori_parco" | "dismesso"; testo: string } | null;
  ultimoIntervento: { riferimento: string; giornoChiusura: string; esitoAvm: EsitoIntervento } | null;
  interventi: number;
  azione: Azione;
  instabile: boolean;
  perche: string;
  richiesta: Richiesta | null;
}

interface TestoMizar { oggetto: string; testo: string; matricole: string[] }

interface Resp {
  generatoIl: string;
  oggi: string;
  inizio: string;
  ultimaChiusa: string;
  settimane: SettimanaStoria[];
  vetture: Vettura[];
  richieste: Richiesta[];
  testiMizar: { togliere: TestoMizar | null; aggiungere: TestoMizar | null };
  officina: { disponibile: boolean; motivo: string | null; tenant: string | null; lettoAlle: string; mezzi: number };
  fonteInterventi: { disponibile: boolean; motivo: string | null };
  soglie: { settimaneSilenzioAlienata: number; giorniSollecitoMizar: number; settimaneInstabilita: number };
  errore: string | null;
}

/* ── I colori: gli stessi del foglio Excel (avm-storia-xlsx.ts) ─────────── */

const AZIONI: Record<Azione, { titolo: string; breve: string; colore: string; fondo: string }> = {
  da_riparare: { titolo: "Da riparare", breve: "Da riparare", colore: "#fb923c", fondo: "rgba(251,146,60,0.12)" },
  da_togliere_da_siri: { titolo: "Da togliere da SIRI", breve: "Da togliere", colore: "#f87171", fondo: "rgba(248,113,113,0.12)" },
  da_aggiungere_a_siri: { titolo: "Da aggiungere a SIRI", breve: "Da aggiungere", colore: "#c084fc", fondo: "rgba(192,132,252,0.12)" },
  da_verificare_alienata: { titolo: "Da verificare: guasta o alienata?", breve: "Da verificare", colore: "#fbbf24", fondo: "rgba(251,191,36,0.12)" },
  instabile: { titolo: "Instabili", breve: "Instabile", colore: "#fde68a", fondo: "rgba(253,230,138,0.10)" },
  riparata: { titolo: "Riparate", breve: "Riparata", colore: "#34d399", fondo: "rgba(52,211,153,0.12)" },
  funziona: { titolo: "Funzionano", breve: "Funziona", colore: "#7dd3fc", fondo: "rgba(125,211,252,0.12)" },
  non_giudicabile: { titolo: "Non giudicabili", breve: "Non giudicabile", colore: "#a1a1aa", fondo: "rgba(161,161,170,0.12)" },
  gia_tolta: { titolo: "Già tolte dal flusso", breve: "Già tolta", colore: "#94a3b8", fondo: "rgba(148,163,184,0.10)" },
};
const SCHEDE: Azione[] = ["da_riparare", "da_togliere_da_siri", "da_aggiungere_a_siri", "da_verificare_alienata"];
const PASTIGLIE: Azione[] = ["instabile", "riparata", "funziona", "non_giudicabile", "gia_tolta"];

const ESITI: Record<EsitoIntervento, { testo: string; colore: string }> = {
  riuscito: { testo: "Riuscito", colore: "#34d399" },
  gia_funzionava: { testo: "Si localizzava già", colore: "#7dd3fc" },
  senza_effetto: { testo: "Senza effetto", colore: "#f87171" },
  peggiorato: { testo: "Prima sì, dopo no", colore: "#fb923c" },
  ricaduta: { testo: "Ricaduta", colore: "#f87171" },
  senza_confronto: { testo: "Dopo si localizza", colore: "#a7f3d0" },
  da_verificare: { testo: "Da verificare", colore: "#fbbf24" },
  non_nel_flusso: { testo: "Non nel flusso SIRI", colore: "#a1a1aa" },
};

const ETICHETTA_STATO: Record<StatoOfficina, string> = {
  in_servizio: "in servizio", riserva: "di riserva", in_officina: "in officina", dismesso: "dismessa",
};

function ddmmyyyy(g: string | null): string {
  return g ? g.slice(0, 10).split("-").reverse().join("/") : "";
}
function dataOra(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statoRichiesta(r: Richiesta): { testo: string; colore: string } {
  if (r.esito == null) {
    return r.sollecitare
      ? { testo: `in attesa da ${r.giorniAttesa} giorni: da sollecitare`, colore: "#f87171" }
      : { testo: r.giorniAttesa === 0 ? "in attesa, inviata oggi" : `in attesa da ${r.giorniAttesa} ${r.giorniAttesa === 1 ? "giorno" : "giorni"}`, colore: "#fbbf24" };
  }
  if (r.esito === "annullata") return { testo: `annullata il ${ddmm(r.chiusaIl)}`, colore: "#a1a1aa" };
  if (r.ricomparsaIl) return { testo: `fatta il ${ddmm(r.chiusaIl)}, ma ricomparsa il ${ddmm(r.ricomparsaIl)}`, colore: "#fb923c" };
  return {
    testo: `fatta il ${ddmm(r.chiusaIl)}${r.automatica ? " — verificata da Cerbero" : r.chiusaDa ? ` — segnata da ${r.chiusaDa}` : ""}`,
    colore: "#34d399",
  };
}

export default function StoriaAvm() {
  const qc = useQueryClient();
  const [soloConerobus, setSoloConerobus] = useState(true);
  const [senzaAlienate, setSenzaAlienate] = useState(true);
  const [filtro, setFiltro] = useState<Azione | null>(null);
  const [cerca, setCerca] = useState("");
  const [selezione, setSelezione] = useState<Set<string>>(new Set());
  const [inviataIl, setInviataIl] = useState<string>("");
  const [nota, setNota] = useState("");

  const q = useQuery({
    queryKey: ["storia-avm"],
    queryFn: () => apiFetch<Resp>("/api/siri/parco/storia"),
    staleTime: 5 * 60 * 1000,
  });
  const d = q.data;
  const officinaAttiva = !!d?.officina.disponibile;

  /* Il perimetro: solo Conerobus vale per tutta la pagina; senza fuori parco e dismesse solo per l'andamento,
     perché le vetture da togliere da SIRI sono proprio quelle. */
  const perimetro = useMemo(
    () => (d?.vetture ?? []).filter(v => !soloConerobus || eConerobus(v.vehicleRef)),
    [d, soloConerobus],
  );
  const andamento = useMemo(() => andamentoPerimetro(d?.settimane ?? [],
    perimetro.filter(v => !(officinaAttiva && senzaAlienate && v.esclusa))), [d, perimetro, officinaAttiva, senzaAlienate]);
  const conteggi = useMemo(() => conteggiAzioni(perimetro), [perimetro]);
  const richieste = useMemo(
    () => (d?.richieste ?? []).filter(r => !soloConerobus || eConerobus(r.vehicleRef)),
    [d, soloConerobus],
  );
  const aperte = richieste.filter(r => r.esito == null);
  const giaChieste = (a: Azione) => perimetro.filter(v => v.azione === a && v.richiesta != null && v.richiesta.esito == null).length;
  const visibili = useMemo(() => {
    const term = cerca.trim().toLowerCase();
    return perimetro.filter(v =>
      (!filtro || v.azione === filtro)
      && (!term || v.vehicleRef.toLowerCase().includes(term)
        || (v.codice ?? "").toLowerCase().includes(term)
        || (v.mezzo ?? "").toLowerCase().includes(term)
        || (v.officina?.targa ?? "").toLowerCase().includes(term)));
  }, [perimetro, filtro, cerca]);
  const selezionate = perimetro.filter(v => selezione.has(v.vehicleRef));
  const tipoSelezione = tipoDellaSelezione(selezionate);

  const segna = useMutation({
    mutationFn: (corpo: { tipo: "togliere" | "aggiungere"; matricole: string[]; richiestaIl?: string; nota?: string }) =>
      apiFetch<{ create: string[]; giaAperte: string[] }>("/api/siri/parco/richieste", { method: "POST", body: JSON.stringify(corpo) }),
    onSuccess: (r) => {
      toast.success(`${r.create.length} ${r.create.length === 1 ? "richiesta segnata" : "richieste segnate"}`, {
        description: r.giaAperte.length ? `Già aperte, non duplicate: ${r.giaAperte.join(", ")}.` : undefined,
      });
      setSelezione(new Set());
      setNota("");
      void qc.invalidateQueries({ queryKey: ["storia-avm"] });
    },
    onError: (e: Error) => toast.error("Richieste non segnate", { description: e.message }),
  });
  const chiudi = useMutation({
    mutationFn: (corpo: { ids: string[]; esito: "annullata" | "fatta" }) =>
      apiFetch<{ chiuse: string[] }>("/api/siri/parco/richieste/chiudi", { method: "POST", body: JSON.stringify(corpo) }),
    onSuccess: (_r, corpo) => {
      toast.success(corpo.esito === "annullata" ? "Richiesta annullata" : "Richiesta segnata come fatta");
      void qc.invalidateQueries({ queryKey: ["storia-avm"] });
    },
    onError: (e: Error) => toast.error("Richiesta non chiusa", { description: e.message }),
  });

  const copia = async (t: TestoMizar) => {
    try {
      await navigator.clipboard.writeText(`${t.oggetto}\n\n${t.testo}`);
      toast.success("Testo copiato", { description: "Incollalo nella mail a Mizar." });
    } catch {
      toast.error("Copia non riuscita", { description: "Seleziona il testo e copialo a mano." });
    }
  };
  const seleziona = (refs: string[], azione: Azione) => {
    setSelezione(new Set(refs.filter(r => perimetro.some(v => v.vehicleRef === r && selezionabile(v)))));
    setFiltro(azione);
  };
  const alterna = (ref: string) => setSelezione(s => {
    const n = new Set(s);
    if (n.has(ref)) n.delete(ref); else n.add(ref);
    return n;
  });

  if (q.isLoading) {
    return <div className="p-12 text-center text-xs text-muted-foreground">Calcolo l'andamento dall'inizio dei dati…</div>;
  }
  if (q.error || !d) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[11px] text-red-200 leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>L'andamento non si è potuto leggere: {(q.error as Error)?.message ?? "nessuna risposta"}.{" "}
          <button onClick={() => void q.refetch()} className="underline">Riprova</button></span>
      </div>
    );
  }

  const parametri = new URLSearchParams({ formato: "xlsx" });
  if (soloConerobus) parametri.set("perimetro", "conerobus");
  if (officinaAttiva && senzaAlienate) parametri.set("officina", "1");
  const maxAndamento = Math.max(1, ...andamento.map(a => a.F + a.P + a.M + a.A));
  const daRiparareLunghe = perimetro.filter(v => v.azione === "da_riparare"
    && (v.settimaneSenzaPosizione ?? 0) >= d.soglie.settimaneSilenzioAlienata).length;
  const piuVecchia = aperte.reduce((m, r) => Math.max(m, r.giorniAttesa), 0);
  const oggi = d.oggi;

  return (
    <div className="space-y-5">
      {/* ── Testata ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[12px] font-medium tabular-nums">
          Dal {ddmmyyyy(d.settimane[0]?.lunedi ?? d.inizio)} · {d.settimane.length} settimane
        </span>
        <span className="text-[10px] text-muted-foreground">calcolato il {dataOra(d.generatoIl)}</span>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" id="storia-solo-conerobus" checked={soloConerobus}
            onChange={e => { setSoloConerobus(e.target.checked); setSelezione(new Set()); }} />
          solo Conerobus
        </label>
        {officinaAttiva && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
            title="Nell'andamento non contano le vetture che l'officina oggi non ha più o dà dismesse">
            <input type="checkbox" id="storia-senza-alienate" checked={senzaAlienate}
              onChange={e => setSenzaAlienate(e.target.checked)} />
            andamento senza fuori parco e dismesse
          </label>
        )}
        <span className="text-[10px] text-muted-foreground">
          {officinaAttiva ? `FleetCare letto alle ${dataOra(d.officina.lettoAlle)}` : ""}
        </span>
        <a
          href={`${getApiBase()}/api/siri/parco/storia?${parametri.toString()}`}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-200 transition-colors"
        >
          <Download className="w-3 h-3" /> Andamento (Excel)
        </a>
      </div>

      {!officinaAttiva && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Parco dell'officina non disponibile: {d.officina.motivo} Senza FleetCare non si sa quali vetture sono
            alienate o nuove: le liste da togliere, da aggiungere e da verificare restano vuote, e fra le vetture
            da riparare possono esserci mezzi che non ci sono più.</span>
        </div>
      )}
      {d.errore && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[11px] text-red-200 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Lettura incompleta: {d.errore}</span>
        </div>
      )}

      {/* ── Che cosa c'è da fare ──────────────────────────────────────── */}
      <section className="grid gap-2 grid-cols-2 lg:grid-cols-5">
        {SCHEDE.map(a => {
          const c = AZIONI[a];
          const attivo = filtro === a;
          const Icona = a === "da_riparare" ? Wrench : a === "da_togliere_da_siri" ? Trash2 : a === "da_aggiungere_a_siri" ? PlusCircle : HelpCircle;
          const sotto = a === "da_riparare"
            ? (daRiparareLunghe ? `${daRiparareLunghe} da più di ${d.soglie.settimaneSilenzioAlienata} settimane` : "non si localizzano nell'ultima settimana")
            : a === "da_verificare_alienata"
              ? "mute da settimane, in servizio per l'officina"
              : giaChieste(a) === 1 ? "1 già chiesta a Mizar" : `${giaChieste(a)} già chieste a Mizar`;
          return (
            <button
              key={a}
              onClick={() => setFiltro(f => (f === a ? null : a))}
              aria-pressed={attivo}
              className="text-left rounded-xl p-3 space-y-1 border transition-colors"
              style={{ background: c.fondo, borderColor: attivo ? c.colore : "rgba(255,255,255,0.08)" }}
            >
              <div className="flex items-center gap-1.5">
                <Icona className="w-3.5 h-3.5" style={{ color: c.colore }} />
                <span className="text-[11px] font-medium" style={{ color: c.colore }}>{c.titolo}</span>
              </div>
              <div className="font-mono text-xl tabular-nums" style={{ color: c.colore }}>{conteggi[a]}</div>
              <p className="text-[10px] text-muted-foreground leading-snug">{sotto}</p>
            </button>
          );
        })}
        <a href="#richieste-mizar" className="rounded-xl p-3 space-y-1 border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04] transition-colors">
          <div className="flex items-center gap-1.5">
            <Hourglass className="w-3.5 h-3.5 text-sky-300" />
            <span className="text-[11px] font-medium text-sky-300">In attesa da Mizar</span>
          </div>
          <div className="font-mono text-xl tabular-nums text-sky-300">{aperte.length}</div>
          <p className={`text-[10px] leading-snug ${piuVecchia > d.soglie.giorniSollecitoMizar ? "text-red-300" : "text-muted-foreground"}`}>
            {!aperte.length ? "nessuna richiesta aperta"
              : piuVecchia === 0 ? "inviate oggi"
                : `la più vecchia da ${piuVecchia} ${piuVecchia === 1 ? "giorno" : "giorni"}`}
          </p>
        </a>
      </section>
      <div className="flex flex-wrap gap-1.5">
        {PASTIGLIE.map(a => (
          <button
            key={a}
            onClick={() => setFiltro(f => (f === a ? null : a))}
            aria-pressed={filtro === a}
            className="px-2.5 py-1 rounded-lg text-[11px] border transition-colors"
            style={{ color: AZIONI[a].colore, background: AZIONI[a].fondo, borderColor: filtro === a ? AZIONI[a].colore : "transparent" }}
          >
            {AZIONI[a].titolo} <span className="font-mono ml-1">{conteggi[a]}</span>
          </button>
        ))}
      </div>

      {/* ── L'andamento ───────────────────────────────────────────────── */}
      <section className="rounded-xl border border-border/50 bg-white/[0.02] p-4 space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[12px] font-medium">Settimana per settimana</h3>
          <span className="text-[10px] text-muted-foreground">
            quante vetture si sono localizzate almeno un giorno; il perimetro è il parco di oggi
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground max-w-3xl">{fraseAndamento(andamento)}</p>
        <div className="flex items-end gap-1 h-28" role="img" aria-label="Andamento settimanale: barre per settimana">
          {andamento.map(a => {
            const tot = a.F + a.P + a.M + a.A;
            return (
              <div
                key={a.lunedi}
                className="flex-1 flex flex-col justify-end min-w-0 h-full"
                title={a.giornateContate === 0
                  ? `${ddmm(a.lunedi)}: settimana senza raccolta`
                  : `${ddmm(a.lunedi)} – ${ddmm(a.domenica)}${a.chiusa ? "" : " (in corso)"}: si localizzano ${a.F} su ${tot}`
                    + ` (${tot ? Math.round((100 * a.F) / tot) : 0}%), parlano soltanto ${a.P}, mute ${a.M}`
                    + `${a.A ? `, non elencate ${a.A}` : ""} · ${a.giornateContate} giornate contate`}
                style={{ opacity: a.giornateContate === 0 ? 0.25 : a.chiusa ? 0.9 : 0.45 }}
              >
                {a.giornateContate > 0 && tot > 0 && ([["A", a.A], ["M", a.M], ["P", a.P], ["F", a.F]] as Array<[string, number]>).map(([k, n]) =>
                  n > 0 ? (
                    <div key={k} style={{
                      height: `${(n / maxAndamento) * 100}%`,
                      background: k === "A" ? "transparent" : SETTIMANA[k].colore ?? undefined,
                      border: k === "A" ? "1px solid rgba(255,255,255,0.15)" : undefined,
                      opacity: k === "M" ? 0.5 : 1,
                    }} />
                  ) : null)}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          {andamento.map((a, i) => (
            <span key={a.lunedi} className="flex-1 text-center text-[9px] font-mono min-w-0 truncate text-muted-foreground">
              {i % 4 === 0 || i === andamento.length - 1 ? ddmm(a.lunedi) : ""}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          {(["F", "P", "M"] as const).map(k => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: SETTIMANA[k].colore ?? undefined }} /> {SETTIMANA[k].testo}
            </span>
          ))}
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm border border-white/20" /> non elencata</span>
          <span>l'ultima barra, più chiara, è la settimana in corso</span>
        </div>
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">I numeri settimana per settimana</summary>
          <div className="overflow-x-auto mt-2">
            <table className="text-[11px] tabular-nums">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-4 py-1 font-medium">Settimana</th>
                  <th className="pr-4 py-1 font-medium text-right">Giornate</th>
                  <th className="pr-4 py-1 font-medium text-right">Si localizzano</th>
                  <th className="pr-4 py-1 font-medium text-right">Parlano</th>
                  <th className="pr-4 py-1 font-medium text-right">Mute</th>
                  <th className="pr-4 py-1 font-medium text-right">Non elencate</th>
                  <th className="pr-4 py-1 font-medium text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {andamento.map(a => {
                  const tot = a.F + a.P + a.M + a.A;
                  return (
                    <tr key={a.lunedi}>
                      <td className="pr-4 py-0.5">{ddmm(a.lunedi)} – {ddmm(a.domenica)}{a.chiusa ? "" : " (in corso)"}</td>
                      <td className="pr-4 py-0.5 text-right">{a.giornateContate}</td>
                      <td className="pr-4 py-0.5 text-right">{a.F}</td>
                      <td className="pr-4 py-0.5 text-right">{a.P}</td>
                      <td className="pr-4 py-0.5 text-right">{a.M}</td>
                      <td className="pr-4 py-0.5 text-right">{a.A}</td>
                      <td className="pr-4 py-0.5 text-right">{tot ? `${Math.round((100 * a.F) / tot)}%` : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      {/* ── Le richieste a Mizar ─────────────────────────────────────── */}
      <section id="richieste-mizar" className="space-y-3 scroll-mt-4">
        <h3 className="text-[12px] font-medium flex items-center gap-1.5">
          <Send className="w-3.5 h-3.5 text-sky-300" /> Richieste a Mizar
          <span className="text-[10px] font-normal text-muted-foreground">
            togliere le vetture che l'officina non ha più, aggiungere quelle nuove; si chiudono da sole quando il flusso SIRI cambia
          </span>
        </h3>
        <div className="grid gap-2 md:grid-cols-2">
          {([["togliere", d.testiMizar.togliere, "da_togliere_da_siri"], ["aggiungere", d.testiMizar.aggiungere, "da_aggiungere_a_siri"]] as const)
            .map(([tipo, t, azione]) => (
              <div key={tipo} className="rounded-xl border border-border/50 bg-white/[0.02] p-3 space-y-2">
                <div className="text-[11px] font-medium" style={{ color: AZIONI[azione].colore }}>
                  {tipo === "togliere" ? "Da togliere dall'anagrafica del centro" : "Da censire al centro"}
                </div>
                {t ? (
                  <>
                    <p className="text-[11px] font-medium">{t.oggetto}</p>
                    <p className="text-[10px] text-muted-foreground whitespace-pre-line leading-relaxed max-h-28 overflow-y-auto">{t.testo}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => void copia(t)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 border border-border/60">
                        <Copy className="w-3 h-3" /> Copia testo
                      </button>
                      <button onClick={() => seleziona(t.matricole, azione)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 border border-border/60">
                        <CheckSquare className="w-3 h-3" /> {t.matricole.length === 1 ? "Seleziona la vettura" : `Seleziona le ${t.matricole.length} vetture`}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    {officinaAttiva ? "Niente da chiedere: nessuna vettura, o hanno già una richiesta aperta." : "Serve il parco dell'officina."}
                  </p>
                )}
              </div>
            ))}
        </div>
        {richieste.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border/50">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border/40">
                  <th className="px-3 py-2 font-medium">Vettura</th>
                  <th className="px-3 py-2 font-medium">Richiesta</th>
                  <th className="px-3 py-2 font-medium">Inviata il</th>
                  <th className="px-3 py-2 font-medium">Stato</th>
                  <th className="px-3 py-2 font-medium">Segnata da</th>
                  <th className="px-3 py-2 font-medium">Nota</th>
                  <th className="px-3 py-2 font-medium"><span className="sr-only">Azioni</span></th>
                </tr>
              </thead>
              <tbody>
                {richieste.map(r => {
                  const s = statoRichiesta(r);
                  return (
                    <tr key={r.id} className="border-b border-border/20 last:border-0">
                      <td className="px-3 py-1.5 font-mono">{r.vehicleRef}</td>
                      <td className="px-3 py-1.5">{r.tipo === "togliere" ? "Togliere da SIRI" : "Aggiungere a SIRI"}</td>
                      <td className="px-3 py-1.5 tabular-nums">{ddmmyyyy(r.richiestaIl)}</td>
                      <td className="px-3 py-1.5" style={{ color: s.colore }}>{s.testo}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.creataDa ?? "—"}</td>
                      <td className="px-3 py-1.5 text-muted-foreground max-w-[240px] truncate" title={r.nota ?? undefined}>{r.nota ?? ""}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap text-right">
                        {r.esito == null && (
                          <span className="inline-flex gap-1">
                            <button
                              onClick={() => chiudi.mutate({ ids: [r.id], esito: "fatta" })}
                              disabled={chiudi.isPending}
                              className="px-2 py-0.5 rounded-md text-[10px] border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40"
                              title="Mizar l'ha fatta ma Cerbero non lo vede (per esempio ha cambiato numero alla vettura)"
                            >
                              Segna fatta
                            </button>
                            <button
                              onClick={() => chiudi.mutate({ ids: [r.id], esito: "annullata" })}
                              disabled={chiudi.isPending}
                              className="px-2 py-0.5 rounded-md text-[10px] border border-border/60 text-muted-foreground hover:bg-white/5 disabled:opacity-40"
                            >
                              Annulla
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Le vetture ───────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[12px] font-medium">
            {filtro ? AZIONI[filtro].titolo : "Tutte le vetture"}
            <span className="ml-1.5 font-mono text-muted-foreground">{visibili.length}</span>
          </h3>
          {filtro && (
            <button onClick={() => setFiltro(null)} className="text-[10px] text-sky-300 hover:underline">mostra tutte</button>
          )}
          <div className="ml-auto relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              id="storia-cerca"
              aria-label="Cerca per matricola, targa o mezzo"
              value={cerca}
              onChange={e => setCerca(e.target.value)}
              placeholder="matricola, targa o mezzo"
              className="pl-7 pr-2 py-1 w-48 rounded-lg text-[11px] bg-white/[0.03] border border-border/40 focus:border-border outline-none"
            />
          </div>
        </div>

        {selezione.size > 0 && (
          <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl border border-sky-500/40 bg-background/95 backdrop-blur text-[11px]">
            <span className="font-medium">{selezione.size} {selezione.size === 1 ? "vettura selezionata" : "vetture selezionate"}</span>
            {tipoSelezione ? (
              <>
                <span className="text-muted-foreground">— richiesta di {tipoSelezione} inviata il</span>
                <input
                  type="date" id="storia-inviata-il" aria-label="Data di invio della richiesta"
                  value={inviataIl || oggi} max={oggi}
                  onChange={e => setInviataIl(e.target.value)}
                  className="px-2 py-0.5 rounded-md bg-white/[0.03] border border-border/40 text-[11px]"
                />
                <input
                  id="storia-nota" aria-label="Nota della richiesta" maxLength={500}
                  value={nota} onChange={e => setNota(e.target.value)} placeholder="nota (facoltativa)"
                  className="px-2 py-0.5 w-56 rounded-md bg-white/[0.03] border border-border/40 text-[11px]"
                />
                <button
                  onClick={() => segna.mutate({
                    tipo: tipoSelezione, matricole: [...selezione], richiestaIl: inviataIl || oggi, nota: nota.trim() || undefined,
                  })}
                  disabled={segna.isPending}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-500/50 text-sky-100 disabled:opacity-40"
                >
                  <Send className="w-3 h-3" /> Segna richiesta inviata
                </button>
              </>
            ) : (
              <span className="text-amber-200">Seleziona solo vetture da togliere, oppure solo vetture da aggiungere: sono due richieste diverse.</span>
            )}
            <button onClick={() => setSelezione(new Set())} className="ml-auto flex items-center gap-1 text-muted-foreground hover:text-foreground">
              <X className="w-3 h-3" /> Annulla selezione
            </button>
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-border/50">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border/40">
                <th className="px-2 py-2 font-medium"><span className="sr-only">Seleziona</span></th>
                <th className="px-3 py-2 font-medium">Vettura</th>
                <th className="px-3 py-2 font-medium">Azione</th>
                <th className="px-3 py-2 font-medium">Settimane</th>
                <th className="px-3 py-2 font-medium text-right" title="settimane chiuse di fila senza posizione">Senza pos.</th>
                <th className="px-3 py-2 font-medium">Ultima posizione</th>
                <th className="px-3 py-2 font-medium">Ultimo intervento</th>
                <th className="px-3 py-2 font-medium">Perché</th>
              </tr>
            </thead>
            <tbody>
              {visibili.map(v => {
                const c = AZIONI[v.azione];
                const puo = selezionabile(v);
                return (
                  <tr key={v.vehicleRef} className="border-b border-border/20 last:border-0 hover:bg-white/[0.02] align-top">
                    <td className="px-2 py-1.5">
                      {puo && (
                        <input
                          type="checkbox" id={`storia-sel-${v.vehicleRef}`}
                          aria-label={`Seleziona la vettura ${v.vehicleRef}`}
                          checked={selezione.has(v.vehicleRef)} onChange={() => alterna(v.vehicleRef)}
                        />
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="font-mono">{v.vehicleRef}</span>
                      {v.codice && v.codice !== v.vehicleRef && <span className="ml-1.5 text-[10px] text-muted-foreground">{v.codice}</span>}
                      <span className="block text-[10px] text-muted-foreground/80 truncate max-w-[200px]" title={v.mezzo ?? undefined}>
                        {v.mezzo ?? v.azienda}
                      </span>
                      {(v.esclusa || v.officina) && (
                        <span className="block text-[10px] text-muted-foreground/70 truncate max-w-[200px]">
                          {v.esclusa
                            ? <span style={{ color: "#94a3b8" }}>{v.esclusa.motivo === "fuori_parco" ? "fuori parco" : "dismessa"}</span>
                            : v.officina && <>
                              {v.officina.stato !== "in_servizio" && <span className="text-amber-300">{ETICHETTA_STATO[v.officina.stato]} · </span>}
                              {v.officina.targa}{v.officina.deposito ? ` · ${v.officina.deposito}` : ""}
                            </>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded-md text-[10px]" style={{ color: c.colore, background: c.fondo }}>{c.breve}</span>
                      {v.instabile && <span className="block mt-1 text-[10px] text-amber-200">instabile</span>}
                      {v.officina?.segnalazioneAvm && <span className="block mt-1 text-[10px] text-muted-foreground">segnalata {v.officina.segnalazioneAvm.numero}</span>}
                      {v.richiesta && (
                        <span className="block mt-1 text-[10px]" style={{ color: statoRichiesta(v.richiesta).colore }}>
                          Mizar: {statoRichiesta(v.richiesta).testo}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-0.5">
                        {[...v.storia].map((ch, i) => (
                          <Quadratino key={i} ch={ch} mappa={SETTIMANA} titolo={`settimana del ${ddmm(d.settimane[i]?.lunedi ?? null)}`} alto="h-3" />
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">{v.settimaneSenzaPosizione || ""}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground">{ddmmyyyy(v.ultimaPosizione) || "mai"}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {v.ultimoIntervento ? (
                        <span style={{ color: ESITI[v.ultimoIntervento.esitoAvm].colore }}
                          title={`${v.ultimoIntervento.riferimento} chiuso il ${ddmmyyyy(v.ultimoIntervento.giornoChiusura)}`}>
                          <Wrench className="inline w-2.5 h-2.5 mr-0.5" />{ESITI[v.ultimoIntervento.esitoAvm].testo}
                          <span className="text-muted-foreground"> · {ddmm(v.ultimoIntervento.giornoChiusura)}</span>
                        </span>
                      ) : <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground leading-snug min-w-[280px] max-w-[520px]">{v.perche}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibili.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
              {d.vetture.length === 0 ? "Il diario dell'AVM non ha ancora giornate." : "Nessuna vettura con questi criteri."}
            </div>
          )}
        </div>
        {d.fonteInterventi && !d.fonteInterventi.disponibile && (
          <p className="text-[10px] text-muted-foreground leading-relaxed">{d.fonteInterventi.motivo}</p>
        )}
      </section>
    </div>
  );
}
