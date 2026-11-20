/**
 * La polimetrica della bigliettazione nella pagina Polimetriche (tappa 6.34a).
 *
 * La polimetrica che sta nel sistema di bigliettazione invecchia: qui la si
 * carica (due CSV) e si dice a quale linea dell'import corrisponde ogni sua
 * linea. Cerbero propone, chi lavora alle tariffe conferma, cambia o esclude.
 * Di una linea abbinata si apre il confronto punto per punto (ConfrontoLinea).
 *
 * API: /api/fares/polimetriche/ufficiale (routes/fares-polimetriche-ufficiale.ts).
 * I conti in lib/polimetrica-ufficiale.ts.
 */
import React from "react";
import { Check, ChevronDown, FileText, GitCompareArrows, Loader2, Search, Trash2, Upload, Wand2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAzienda } from "@/hooks/use-azienda";
import { useToast } from "@/hooks/use-toast";
import type { FasciaKm } from "@/lib/fasce-km";
import { ConfrontoLinea, type NodiDaApplicare } from "./ConfrontoLinea";
import {
  conDecisioni, conteggi, decisioniDalleProposte, ETICHETTE_FILTRO, filtrate, riassuntoCaricamento, senzaCorrispondenza,
  statoDellaLinea, testoProposta, vociPerLinea,
  type Decisione, type Filtro, type LineaUfficiale, type StatoUfficiale,
} from "@/lib/polimetrica-ufficiale";

/* i valori della tendina: vuoto = da abbinare, «esclusa», oppure «linea:» e il codice (un codice non si confonde con le altre due) */
const ESCLUSA = "esclusa";
const DI_LINEA = "linea:";
const FILTRI: Filtro[] = ["tutte", "da_abbinare", "abbinata", "esclusa"];

const COLONNE = [
  ["Punti tariffari", "linea, percorso, direzione, ordine, codice, nome, nodo, km",
    "Una riga per punto tariffario di ogni linea, nell'ordine, col km progressivo. «nodo» è il nodo tariffario a cui la località fa capo; vuoto se è lei stessa."],
  ["Polimetrica", "linea, percorso, direzione, da, a, km, tariffario, fascia, forzata",
    "Una riga per coppia di nodi. «forzata» vale vero se la riga è stata scritta a mano invece che calcolata dai km."],
] as const;

export function PolimetricaUfficiale({ importId, fasce, onUsaNodi }: {
  importId: string;
  /** le fasce chilometriche dell'azienda: servono al confronto per la fascia nuova */
  fasce: readonly FasciaKm[];
  /** porta nell'area di lavoro di un percorso i nodi fatti coi punti della bigliettazione */
  onUsaNodi: (n: NodiDaApplicare) => void;
}) {
  const { toast } = useToast();
  const azienda = useAzienda();
  const sistema = (azienda.bigliettazioneSistema ?? "").trim();

  const [stato, setStato] = React.useState<StatoUfficiale | null>(null);
  const [errore, setErrore] = React.useState<string | null>(null);
  const [filtro, setFiltro] = React.useState<Filtro>("da_abbinare");
  const [cerca, setCerca] = React.useState("");
  const [filePunti, setFilePunti] = React.useState<File | null>(null);
  const [fileRighe, setFileRighe] = React.useState<File | null>(null);
  const [svuotate, setSvuotate] = React.useState(0); // cambia dopo un caricamento: le due caselle dei file tornano vuote
  const [caricando, setCaricando] = React.useState(false);
  const [salvando, setSalvando] = React.useState(false);
  const [lineaAperta, setLineaAperta] = React.useState<string | null>(null); // la linea di cui si guarda il confronto

  const leggi = React.useCallback(async () => {
    try {
      setStato(await apiFetch<StatoUfficiale>(`/api/fares/polimetriche/ufficiale?importId=${encodeURIComponent(importId)}`));
      setErrore(null);
    } catch (e: any) {
      setErrore(e?.message || "Polimetrica della bigliettazione non leggibile");
    }
  }, [importId]);
  React.useEffect(() => { void leggi(); }, [leggi]);

  const carica = async () => {
    if (!filePunti || !fileRighe) return;
    if (stato?.caricamento && !window.confirm("Sostituire la polimetrica già caricata? Gli abbinamenti delle linee restano.")) return;
    setCaricando(true);
    try {
      const corpo = new FormData();
      corpo.append("punti", filePunti);
      corpo.append("polimetrica", fileRighe);
      const r = await apiFetch<{ punti: number; righe: number; linee: number; puntiSenzaKm: number }>("/api/fares/polimetriche/ufficiale", { method: "POST", body: corpo });
      toast({
        title: "Polimetrica caricata",
        description: `${r.linee} linee, ${r.punti.toLocaleString("it-IT")} punti e ${r.righe.toLocaleString("it-IT")} righe${r.puntiSenzaKm ? ` (${r.puntiSenzaKm} punti senza km lasciati fuori)` : ""}`,
      });
      setFilePunti(null); setFileRighe(null); setSvuotate((n) => n + 1);
      await leggi();
    } catch (e: any) {
      toast({ title: "Caricamento non riuscito", description: e?.message || "Errore", variant: "destructive" });
    } finally {
      setCaricando(false);
    }
  };

  const togli = async () => {
    if (!window.confirm("Togliere la polimetrica caricata? Gli abbinamenti delle linee restano, per il prossimo caricamento.")) return;
    try {
      await apiFetch("/api/fares/polimetriche/ufficiale", { method: "DELETE" });
      await leggi();
    } catch (e: any) {
      toast({ title: "Non riuscito", description: e?.message || "Errore", variant: "destructive" });
    }
  };

  /* le decisioni si vedono subito; se l'API le rifiuta si rilegge */
  const decidi = async (decisioni: Decisione[]) => {
    if (!stato || decisioni.length === 0) return;
    const linee = conDecisioni(stato.linee, decisioni);
    setStato({ ...stato, linee, senzaUfficiale: senzaCorrispondenza(linee, stato.lineeAzienda) });
    setSalvando(true);
    try {
      await apiFetch("/api/fares/polimetriche/ufficiale/abbinamenti", { method: "PUT", body: JSON.stringify({ importId, abbinamenti: decisioni }) });
    } catch (e: any) {
      toast({ title: "Abbinamento non salvato", description: e?.message || "Errore", variant: "destructive" });
      await leggi();
    } finally {
      setSalvando(false);
    }
  };

  if (lineaAperta) {
    return <ConfrontoLinea importId={importId} linea={lineaAperta} fasce={fasce} onUsaNodi={onUsaNodi} onIndietro={() => setLineaAperta(null)} />;
  }
  if (errore) return <p role="alert" className="p-6 text-sm text-red-300">{errore}</p>;
  if (!stato) return <div className="h-full flex items-center justify-center text-emerald-400/50"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  const c = conteggi(stato.linee);
  const visibili = filtrate(stato.linee, filtro, cerca);
  const proposte = decisioniDalleProposte(stato.linee);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 text-emerald-50">
      <div>
        <h2 className="text-base font-bold text-emerald-200">Polimetrica della bigliettazione{sistema ? ` · ${sistema}` : ""}</h2>
        <p className="text-[12px] text-emerald-300/70 max-w-3xl">
          La polimetrica che sta nel sistema di bigliettazione, per confrontarla con quella generata qui. Si carica da due file CSV; poi
          a ogni sua linea si abbina la linea di questo import a cui corrisponde.
        </p>
      </div>

      {/* ── Caricamento ── */}
      <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/30 p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="w-4 h-4 text-emerald-400/70" />
          <p className="text-[12px] text-emerald-100">
            {stato.caricamento ? riassuntoCaricamento(stato.caricamento) : "Nessuna polimetrica caricata."}
          </p>
          {stato.caricamento && (
            <button type="button" onClick={togli}
              className="ml-auto text-[11px] px-2 py-1 rounded-lg border border-red-500/30 text-red-300/80 hover:bg-red-500/10 flex items-center gap-1">
              <Trash2 className="w-3 h-3" /> Togli
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SceltaFile key={`punti-${svuotate}`} id="polim-ufficiale-punti" etichetta="Punti tariffari (CSV)" file={filePunti} onFile={setFilePunti} />
          <SceltaFile key={`righe-${svuotate}`} id="polim-ufficiale-righe" etichetta="Polimetrica (CSV)" file={fileRighe} onFile={setFileRighe} />
          <button type="button" onClick={carica} disabled={!filePunti || !fileRighe || caricando}
            className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500 text-emerald-950 font-semibold hover:bg-emerald-400 disabled:opacity-40 flex items-center gap-1.5">
            {caricando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            {stato.caricamento ? "Sostituisci" : "Carica"}
          </button>
        </div>
        <details className="text-[11px] text-emerald-300/70">
          <summary className="cursor-pointer select-none flex items-center gap-1 w-fit hover:text-emerald-200">
            <ChevronDown className="w-3 h-3" /> Come sono fatti i due file
          </summary>
          <div className="mt-2 space-y-2 max-w-3xl">
            {COLONNE.map(([nome, colonne, nota]) => (
              <div key={nome}>
                <p className="text-emerald-100 font-medium">{nome}</p>
                <p className="font-mono text-emerald-300/90">{colonne}</p>
                <p>{nota}</p>
              </div>
            ))}
            <p>Con l'intestazione; le colonne in qualunque ordine, quelle in più si ignorano. Separatore virgola o punto e virgola. Solo rete e tariffe: nessun dato di persone.</p>
          </div>
        </details>
      </section>

      {/* ── Linee ── */}
      {stato.linee.length > 0 && (
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Filtra le linee" className="flex gap-1">
              {FILTRI.map((f) => (
                <button key={f} type="button" onClick={() => setFiltro(f)} aria-pressed={filtro === f}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${filtro === f ? "bg-emerald-500/25 border-emerald-400/50 text-emerald-50" : "border-emerald-800/50 text-emerald-300/70 hover:bg-emerald-500/10"}`}>
                  {ETICHETTE_FILTRO[f]} <span className="tabular-nums opacity-70">{c[f]}</span>
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-950/50 border border-emerald-800/50 focus-within:border-emerald-500/60">
              <Search className="w-3 h-3 text-emerald-400/60" />
              <input id="polim-ufficiale-cerca" value={cerca} onChange={(e) => setCerca(e.target.value)} placeholder="Cerca una linea o un capolinea"
                aria-label="Cerca una linea o un capolinea"
                className="bg-transparent text-[12px] text-emerald-100 placeholder:text-emerald-500/40 focus:outline-none w-52" />
            </label>
            {salvando && <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400/60" aria-label="Salvo" />}
            <button type="button" onClick={() => decidi(proposte)} disabled={proposte.length === 0 || salvando}
              title="Abbina ogni linea ancora da abbinare alla linea che Cerbero propone. Le altre restano come sono."
              className="ml-auto text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40 flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5" /> Accetta le {proposte.length} proposte
            </button>
          </div>

          <div className="rounded-xl border border-emerald-900/40 overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="text-[10px] uppercase tracking-wider text-emerald-400/60 bg-emerald-950/40">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Linea</th>
                  <th className="text-left font-semibold px-3 py-2">Percorso</th>
                  <th className="text-right font-semibold px-3 py-2">Punti</th>
                  <th className="text-right font-semibold px-3 py-2">Righe</th>
                  <th className="text-left font-semibold px-3 py-2">Linea dell'azienda</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-900/30">
                {visibili.map((l) => <RigaLinea key={l.linea} linea={l} stato={stato} onDecidi={decidi} onConfronta={setLineaAperta} />)}
                {visibili.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-4 text-emerald-400/50 italic">Nessuna linea per questo filtro.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Le linee dell'import senza corrispondenza ── */}
      {stato.caricamento && stato.senzaUfficiale.length > 0 && (
        <section className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 p-3">
          <p className="text-[12px] text-emerald-100 font-medium">
            {stato.senzaUfficiale.length} linee di questo import senza una linea della bigliettazione
          </p>
          <p className="text-[11px] text-emerald-300/60 mb-2">Finché nessuna linea della bigliettazione è abbinata a loro, sono linee da creare là.</p>
          <div className="flex flex-wrap gap-1.5">
            {stato.senzaUfficiale.map((x) => (
              <span key={x.codice} title={x.nome} className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-800/40 text-emerald-200 font-mono">{x.codice}</span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SceltaFile({ id, etichetta, file, onFile }: { id: string; etichetta: string; file: File | null; onFile: (f: File | null) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-emerald-300/70">{etichetta}</label>
      <input id={id} type="file" accept=".csv,text/csv"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        className="text-[11px] text-emerald-200 file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-emerald-500/20 file:text-emerald-100 file:text-[11px] hover:file:bg-emerald-500/30 w-64" />
      {file && <span className="text-[10px] text-emerald-400/60 truncate max-w-64">{file.name} · {Math.max(1, Math.round(file.size / 1024)).toLocaleString("it-IT")} kB</span>}
    </div>
  );
}

function RigaLinea({ linea: l, stato, onDecidi, onConfronta }: {
  linea: LineaUfficiale; stato: StatoUfficiale; onDecidi: (d: Decisione[]) => void; onConfronta: (linea: string) => void;
}) {
  const s = statoDellaLinea(l);
  const voci = React.useMemo(() => vociPerLinea(l, stato.lineeAzienda), [l, stato.lineeAzienda]);
  const candidate = voci.filter((v) => v.candidata), altre = voci.filter((v) => !v.candidata);
  const scelta = (valore: string) => onDecidi([{
    lineaUfficiale: l.linea,
    linea: valore.startsWith(DI_LINEA) ? valore.slice(DI_LINEA.length) : null,
    esclusa: valore === ESCLUSA,
  }]);
  return (
    <tr className={s === "esclusa" ? "opacity-60" : ""}>
      <td className="px-3 py-1.5 font-mono font-semibold text-emerald-100 whitespace-nowrap">{l.linea}</td>
      <td className="px-3 py-1.5 text-emerald-200/90">
        {l.da ? <>{l.da} <span className="text-emerald-400/50">→</span> {l.a}</> : <span className="text-emerald-400/40 italic">senza punti tariffari</span>}
        {l.percorsi > 2 && <span className="ml-1.5 text-[10px] text-emerald-400/50">{l.percorsi} percorsi</span>}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-200/80">{l.punti}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-emerald-200/80 whitespace-nowrap">
        {l.righe}{l.forzate > 0 && <span className="ml-1 text-[10px] text-amber-300/80" title="Righe scritte a mano nella bigliettazione">{l.forzate} forzate</span>}
      </td>
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-2">
          <select aria-label={`Linea dell'azienda per la linea ${l.linea}`}
            value={s === "esclusa" ? ESCLUSA : l.abbinata != null ? DI_LINEA + l.abbinata : ""} onChange={(e) => scelta(e.target.value)}
            className={`text-[12px] px-2 py-1 rounded-lg bg-emerald-950/60 border text-emerald-100 focus:outline-none focus:border-emerald-400/70 max-w-72 ${s === "da_abbinare" ? "border-amber-500/40" : "border-emerald-800/50"}`}>
            <option value="">— da abbinare —</option>
            <option value={ESCLUSA}>Esclusa dal confronto</option>
            {candidate.length > 0 && (
              <optgroup label="Dove si ritrovano i suoi punti">
                {candidate.map((v) => <option key={v.codice} value={DI_LINEA + v.codice}>{v.etichetta}</option>)}
              </optgroup>
            )}
            <optgroup label={candidate.length > 0 ? "Le altre linee" : "Le linee dell'import"}>
              {altre.map((v) => <option key={v.codice} value={DI_LINEA + v.codice}>{v.etichetta}</option>)}
            </optgroup>
          </select>
          {s === "da_abbinare" && l.proposta != null && (
            <button type="button" onClick={() => onDecidi([{ lineaUfficiale: l.linea, linea: l.proposta, esclusa: false }])}
              title={`Abbina alla linea ${l.proposta}: ${testoProposta(l)}`}
              className="text-[11px] px-2 py-1 rounded-lg border border-emerald-600/50 text-emerald-200 hover:bg-emerald-500/15 flex items-center gap-1 whitespace-nowrap">
              <Check className="w-3 h-3" /> {l.proposta} <span className="text-emerald-400/60">· {testoProposta(l)}</span>
            </button>
          )}
          {s === "abbinata" && (
            <button type="button" onClick={() => onConfronta(l.linea)}
              title={`Confronta la linea ${l.linea} con la linea ${l.abbinata}: i punti sulle fermate, i km e le fasce`}
              className="text-[11px] px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 flex items-center gap-1 whitespace-nowrap">
              <GitCompareArrows className="w-3 h-3" /> Confronta
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
