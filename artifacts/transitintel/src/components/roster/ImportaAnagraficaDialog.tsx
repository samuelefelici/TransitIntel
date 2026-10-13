/**
 * Import dell'anagrafica da Excel o CSV, in tre passi:
 *   1. il file: Cerbero riconosce le colonne (anche quelle del gestionale,
 *      come Id_dipendente, Codice_Deposito, Gruppo_Ferie, NumeroPatente…);
 *   2. le scelte che il file non dice da sé: la colonna della matricola, a
 *      quale deposito corrisponde ogni valore, quali categorie sono
 *      conducenti (il gestionale esporta anche officina e uffici), la data
 *      a cui valgono le ferie residue;
 *   3. la prova, che mostra riga per riga che cosa succederebbe senza
 *      scrivere niente, e poi l'applicazione, che è tutto o niente.
 * Una cella vuota non cancella mai un dato già presente.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X, Upload, Loader2, FlaskConical, Check, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { apiFetch } from "@/lib/api";
import {
  ESCLUDI, ETICHETTE_CAMPI, STATI_RIGA, chiave, formattaOrario, oggiRoma, trovaDeposito,
  type AnalisiImport, type Categoria, type Deposito, type RapportoImport, type StatoRiga,
} from "@/lib/anagrafica-api";

const SEL = "px-2 py-1 rounded-md bg-slate-950 border border-slate-700 text-slate-100 text-[11px] focus:border-violet-500 focus:outline-none";
const NUOVA = "__nuova__";

const ETICHETTE_COLONNA: Record<string, string> = {
  matricola: "Matricola", cognome: "Cognome", nome: "Nome", nominativo: "Cognome e nome", cf: "Codice fiscale",
  dataNascita: "Data di nascita", dataAssunzione: "Data di assunzione", dataFineServizio: "Fine servizio",
  deposito: "Deposito", categoria: "Categoria", orario: "Orario settimanale", rotazioneRiposi: "Rotazione riposi",
  scaglioneRiposi: "Scaglione riposi", scaglioneFerie: "Scaglione ferie", rotazioneTurniGruppo: "Rotazione turni",
  rotazioneTurniPosizione: "Posizione turni", inquadramento: "Inquadramento", parametro: "Parametro",
  ferieAnnue: "Ferie annue", ferieResidue: "Ferie residue", ferieResidueAl: "Residuo ferie al",
  residenza: "Residenza", indirizzo: "Indirizzo", cap: "CAP", citta: "Città", prov: "Provincia", telefono: "Telefono",
  patente: "Categorie patente", patenteNumero: "Numero patente", cqcNumero: "Numero CQC",
  patenteValidita: "Scadenza patente", cqcValidita: "Scadenza CQC",
  visitaFerrovieData: "Visita ferrovie (data)", visitaFerrovieValidita: "Visita ferrovie (scadenza)", visitaFerrovieEsito: "Visita ferrovie (esito)",
  visitaMedicoCompetenteData: "Visita medico competente (data)", visitaMedicoCompetenteValidita: "Visita medico competente (scadenza)",
  visitaMedicoCompetenteEsito: "Visita medico competente (esito)", note: "Note",
};

export default function ImportaAnagraficaDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const fileRef = useRef<File | null>(null);
  const [analisi, setAnalisi] = useState<AnalisiImport | null>(null);
  const [nomeFile, setNomeFile] = useState("");
  const [depScelti, setDepScelti] = useState<Record<string, string>>({});
  const [catScelte, setCatScelte] = useState<Record<string, string>>({});
  const [ferieAl, setFerieAl] = useState("");
  const [ferieUnita, setFerieUnita] = useState<"giorni" | "ore">("giorni");
  const [decorrenza, setDecorrenza] = useState(oggiRoma());
  const [creaNuovi, setCreaNuovi] = useState(true);
  const [aggiornaEsistenti, setAggiornaEsistenti] = useState(true);
  const [disattivaCessati, setDisattivaCessati] = useState(false);
  const [collega, setCollega] = useState<Record<string, string>>({});
  const [creaComunque, setCreaComunque] = useState<number[]>([]);
  const [rapporto, setRapporto] = useState<RapportoImport | null>(null);
  const [filtroStato, setFiltroStato] = useState<StatoRiga | null>(null);

  const depositi = useQuery({ queryKey: ["roster", "depositi"], queryFn: () => apiFetch<{ depositi: Deposito[] }>("/api/roster/depositi").then(r => r.depositi) });
  const categorie = useQuery({ queryKey: ["roster", "categorie"], queryFn: () => apiFetch<{ categorie: Categoria[] }>("/api/roster/categorie").then(r => r.categorie) });

  const leggi = useMutation({
    mutationFn: async (colonnaChiave?: number) => {
      const file = fileRef.current;
      if (!file) throw new Error("Scegli un file");
      const fd = new FormData();
      fd.append("file", file);
      if (colonnaChiave !== undefined) fd.append("colonnaChiave", String(colonnaChiave));
      return apiFetch<{ analisi: AnalisiImport; nomeFile: string }>("/api/roster/anagrafica/import/leggi", { method: "POST", body: fd });
    },
    onSuccess: (r) => {
      setAnalisi(r.analisi);
      setNomeFile(r.nomeFile);
      setRapporto(null);
      /* i depositi che il catalogo riconosce da sé partono già abbinati */
      const dep: Record<string, string> = {};
      for (const d of r.analisi.depositi) {
        const t = trovaDeposito(d.valore, depositi.data ?? []);
        if (t) dep[d.valore] = t.codice;
      }
      setDepScelti(dep);
      const cat: Record<string, string> = {};
      for (const k of r.analisi.categorie) {
        const t = (categorie.data ?? []).find(c => chiave(c.nome) === chiave(k.valore) || c.alias.some(a => chiave(a) === chiave(k.valore)));
        if (t) cat[k.valore] = t.nome;
      }
      setCatScelte(cat);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scelte = () => ({
    depositi: depScelti,
    categorie: Object.fromEntries(Object.entries(catScelte).map(([k, v]) => [k, v === NUOVA ? k : v])),
    creaNuovi, aggiornaEsistenti, disattivaCessati, collega, creaComunque,
    ferieAl: ferieAl || null, ferieUnita, decorrenza, nomeFile,
  });

  const prova = useMutation({
    mutationFn: () => apiFetch<{ rapporto: RapportoImport }>("/api/roster/anagrafica/import/prova", {
      method: "POST", body: JSON.stringify({ righe: analisi!.righe, scelte: scelte() }),
    }),
    onSuccess: (r) => { setRapporto(r.rapporto); setFiltroStato(r.rapporto.conteggi.errore ? "errore" : null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const applica = useMutation({
    mutationFn: () => apiFetch<{ rapporto: RapportoImport }>("/api/roster/anagrafica/import/applica", {
      method: "POST", body: JSON.stringify({ righe: analisi!.righe, scelte: scelte() }),
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["roster"] });
      const c = r.rapporto.conteggi;
      toast.success(`Import fatto: ${c.nuovo} nuovi, ${c.aggiorna} aggiornati, ${c.invariato} invariati`);
      if (r.rapporto.daRigenerare.length) toast.warning("Alcune rotazioni riposi sono cambiate: rigenera i riposi dal roster");
      onClose();
    },
    onError: (e: any) => {
      if (e?.body?.rapporto) setRapporto(e.body.rapporto);
      toast.error(e?.message ?? "Import non riuscito");
    },
  });

  const candidate = analisi?.colonne.filter(c => c.candidataChiave) ?? [];
  const chiaveScelta = analisi?.colonne.find(c => c.campo === "matricola");
  const ignorate = analisi?.colonne.filter(c => !c.campo && c.intestazione) ?? [];
  const mancaDataFerie = !!analisi?.statistiche.ferieResidue && !analisi.haDataResiduo && !ferieAl;
  const depDaScegliere = (analisi?.depositi ?? []).filter(d => !depScelti[d.valore]).length;
  const catDaScegliere = (analisi?.categorie ?? []).filter(d => !catScelte[d.valore]).length;
  const righeRapporto = useMemo(() => (rapporto?.righe ?? []).filter(r => !filtroStato || r.stato === filtroStato), [rapporto, filtroStato]);
  const invalidaProva = () => setRapporto(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="import-titolo"
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col text-slate-100">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-800">
          <FileSpreadsheet className="w-4 h-4 text-violet-300" />
          <div id="import-titolo" className="text-sm font-semibold">Importa l'anagrafica</div>
          {nomeFile && <span className="text-[11px] text-slate-400">{nomeFile}</span>}
          <button onClick={onClose} aria-label="Chiudi l'import" className="ml-auto p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5 text-[12px]">
          {/* 1. Il file */}
          <section className="space-y-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80">1 · Il file</h4>
            <p className="text-slate-400 leading-relaxed">
              Un .xlsx o un .csv con una riga di intestazioni. Va bene l'esportazione della tabella dei dipendenti del gestionale:
              le colonne si riconoscono dal nome (Matricola o Id_dipendente, Cognome, Nome, Deposito o Id_residenza, Qualifica,
              Gruppo_Ferie, ID_Parametro, NumeroPatente, scadenze, telefoni, indirizzo…). Le celle vuote non cancellano niente.
            </p>
            <div className="flex items-center gap-2">
              <input id="import-file" type="file" accept=".xlsx,.csv" className="text-[11px] file:mr-2 file:px-2.5 file:py-1 file:rounded-md file:border-0 file:bg-slate-800 file:text-slate-200"
                onChange={e => { fileRef.current = e.target.files?.[0] ?? null; setAnalisi(null); setRapporto(null); }} />
              <button onClick={() => leggi.mutate(undefined)} disabled={leggi.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 text-white text-xs hover:bg-violet-500 disabled:opacity-50">
                {leggi.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Leggi
              </button>
            </div>
          </section>

          {analisi && (
            <>
              <section className="space-y-2">
                <p className="text-slate-300">
                  {analisi.righe.length} righe dalla riga {analisi.rigaIntestazioni + 1}; intestazioni alla riga {analisi.rigaIntestazioni}.
                  {analisi.righe.some(r => r.errori.length) && <span className="text-rose-300"> {analisi.righe.filter(r => r.errori.length).length} righe con valori illeggibili (si vedono nella prova).</span>}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {analisi.colonne.filter(c => c.campo).map(c => (
                    <span key={c.indice} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-200 border border-emerald-500/20">
                      {c.intestazione} → {ETICHETTE_COLONNA[c.campo!] ?? c.campo}
                    </span>
                  ))}
                  {ignorate.map(c => (
                    <span key={c.indice} className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-500" title="Colonna non riconosciuta o doppia: ignorata">
                      {c.intestazione}
                    </span>
                  ))}
                </div>
                {candidate.length > 1 && (
                  <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg border border-amber-500/30 bg-amber-500/10">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-300" />
                    <span className="text-amber-100">Più colonne possono essere la matricola. Quale usa l'azienda (la stessa delle presenze)?</span>
                    {candidate.map(c => (
                      <label key={c.indice} className="inline-flex items-center gap-1">
                        <input type="radio" name="colonna-chiave" checked={chiaveScelta?.indice === c.indice}
                          onChange={() => leggi.mutate(c.indice)} className="accent-violet-500" /> {c.intestazione}
                      </label>
                    ))}
                  </div>
                )}
              </section>

              {/* 2. Le scelte */}
              <section className="space-y-3">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80">2 · Le scelte</h4>
                {analisi.depositi.length > 0 && (
                  <div>
                    <div className="text-slate-400 mb-1">Depositi del file {depDaScegliere > 0 && <span className="text-amber-300">· {depDaScegliere} da abbinare</span>}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                      {analisi.depositi.map(d => (
                        <label key={d.valore} className="flex items-center gap-2">
                          <span className="w-40 truncate font-mono" title={d.valore}>{d.valore}</span>
                          <span className="w-12 text-right text-slate-500 tabular-nums">{d.righe}</span>
                          <select className={SEL} value={depScelti[d.valore] ?? ""} onChange={e => { setDepScelti(p => ({ ...p, [d.valore]: e.target.value })); invalidaProva(); }}>
                            <option value="">— da abbinare —</option>
                            {(depositi.data ?? []).map(x => <option key={x.codice} value={x.codice}>{x.nome}</option>)}
                            <option value={ESCLUDI}>Escludi queste righe</option>
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {analisi.categorie.length > 0 && (
                  <div>
                    <div className="text-slate-400 mb-1">
                      Categorie, qualifiche o mansioni del file: quali sono conducenti? {catDaScegliere > 0 && <span className="text-amber-300">· {catDaScegliere} da decidere</span>}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                      {analisi.categorie.map(k => (
                        <label key={k.valore} className="flex items-center gap-2">
                          <span className="w-40 truncate" title={k.valore}>{k.valore}</span>
                          <span className="w-12 text-right text-slate-500 tabular-nums">{k.righe}</span>
                          <select className={SEL} value={catScelte[k.valore] ?? ""} onChange={e => { setCatScelte(p => ({ ...p, [k.valore]: e.target.value })); invalidaProva(); }}>
                            <option value="">— da decidere —</option>
                            {(categorie.data ?? []).map(c => <option key={c.codice} value={c.nome}>{c.nome}</option>)}
                            <option value={NUOVA}>Nuova categoria «{k.valore}»</option>
                            <option value={ESCLUDI}>Escludi (non è un conducente)</option>
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {(analisi.statistiche.ferieAnnue || analisi.statistiche.ferieResidue) && (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-slate-400">Ferie:</span>
                    {(["ferieAnnue", "ferieResidue"] as const).map(k => analisi.statistiche[k] && (
                      <span key={k} className="text-slate-300 tabular-nums">
                        {k === "ferieAnnue" ? "annue" : "residue"} da {analisi.statistiche[k]!.min} a {analisi.statistiche[k]!.max} (mediana {analisi.statistiche[k]!.mediana})
                      </span>
                    ))}
                    <label className="inline-flex items-center gap-1.5">in
                      <select className={SEL} value={ferieUnita} onChange={e => { setFerieUnita(e.target.value as "giorni" | "ore"); invalidaProva(); }}>
                        <option value="giorni">giorni</option>
                        <option value="ore">ore</option>
                      </select>
                    </label>
                    {analisi.statistiche.ferieResidue && !analisi.haDataResiduo && (
                      <label className="inline-flex items-center gap-1.5">
                        residuo aggiornato al
                        <input type="date" className={SEL} value={ferieAl} onChange={e => { setFerieAl(e.target.value); invalidaProva(); }} />
                        {!ferieAl && <span className="text-amber-300">obbligatorio</span>}
                      </label>
                    )}
                  </div>
                )}
                {analisi.statistiche.orarioSettimanaleMin && (
                  <p className="text-slate-400 tabular-nums">
                    Orario settimanale: da {formattaOrario(analisi.statistiche.orarioSettimanaleMin.min)} a {formattaOrario(analisi.statistiche.orarioSettimanaleMin.max)}
                    {" "}(mediana {formattaOrario(analisi.statistiche.orarioSettimanaleMin.mediana)}): se non torna, l'unità del file è diversa.
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-4">
                  <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={creaNuovi} onChange={e => { setCreaNuovi(e.target.checked); invalidaProva(); }} className="accent-violet-500" /> crea i conducenti nuovi</label>
                  <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={aggiornaEsistenti} onChange={e => { setAggiornaEsistenti(e.target.checked); invalidaProva(); }} className="accent-violet-500" /> aggiorna quelli che ci sono</label>
                  <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={disattivaCessati} onChange={e => { setDisattivaCessati(e.target.checked); invalidaProva(); }} className="accent-violet-500" /> metti fuori servizio i cessati</label>
                  <label className="inline-flex items-center gap-1.5">deposito, categoria e orario cambiano dal
                    <input type="date" className={SEL} value={decorrenza} onChange={e => { setDecorrenza(e.target.value); invalidaProva(); }} />
                  </label>
                </div>
                <button onClick={() => prova.mutate()} disabled={prova.isPending || mancaDataFerie}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-violet-500/40 text-violet-200 hover:bg-violet-500/10 text-xs disabled:opacity-50">
                  {prova.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />} Prova (non scrive niente)
                </button>
              </section>
            </>
          )}

          {/* 3. Il rapporto */}
          {rapporto && (
            <section className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80">3 · Che cosa succede</h4>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setFiltroStato(null)} aria-pressed={filtroStato === null}
                  className={`px-2.5 py-1 rounded-full border text-[11px] ${filtroStato === null ? "border-violet-400/50 bg-violet-500/15" : "border-slate-700"}`}>
                  Tutte <span className="tabular-nums opacity-70">{rapporto.righe.length}</span>
                </button>
                {(Object.keys(STATI_RIGA) as StatoRiga[]).filter(s => rapporto.conteggi[s] > 0).map(s => (
                  <button key={s} onClick={() => setFiltroStato(filtroStato === s ? null : s)} aria-pressed={filtroStato === s}
                    className={`px-2.5 py-1 rounded-full border text-[11px] ${filtroStato === s ? "border-violet-400/50 bg-violet-500/15" : "border-slate-700"}`}
                    style={{ color: STATI_RIGA[s].colore }}>
                    {STATI_RIGA[s].testo} <span className="tabular-nums opacity-80">{rapporto.conteggi[s]}</span>
                  </button>
                ))}
              </div>
              {rapporto.conteggi.errore > 0 && (
                <p className="text-rose-300 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Con righe in errore l'import non scrive niente: correggi il file o le scelte e riprova.</p>
              )}
              <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-[340px]">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-950/60 text-slate-400 sticky top-0">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 text-right font-medium">Riga</th>
                      <th scope="col" className="px-2 py-1.5 text-left font-medium">Matricola</th>
                      <th scope="col" className="px-2 py-1.5 text-left font-medium">Cognome e nome</th>
                      <th scope="col" className="px-2 py-1.5 text-left font-medium">Esito</th>
                      <th scope="col" className="px-2 py-1.5 text-left font-medium">Campi</th>
                      <th scope="col" className="px-2 py-1.5 text-left font-medium">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {righeRapporto.slice(0, 500).map(r => (
                      <tr key={r.n} className="border-t border-slate-800 align-top">
                        <td className="px-2 py-1 text-right tabular-nums text-slate-500">{r.n}</td>
                        <td className="px-2 py-1 font-mono">{r.matricola ?? "—"}</td>
                        <td className="px-2 py-1">{r.nominativo || "—"}</td>
                        <td className="px-2 py-1" style={{ color: STATI_RIGA[r.stato].colore }}>{STATI_RIGA[r.stato].singolare}</td>
                        <td className="px-2 py-1 text-slate-400">{r.campi.map(c => ETICHETTE_CAMPI[c] ?? c).join(", ")}</td>
                        <td className="px-2 py-1 text-slate-300">
                          {r.messaggi.join(" · ")}
                          {r.stato === "possibile" && r.simile && (
                            <span className="ml-2 inline-flex gap-1">
                              <button onClick={() => { setCollega(p => ({ ...p, [r.n]: r.simile!.id })); setCreaComunque(p => p.filter(x => x !== r.n)); invalidaProva(); }}
                                className="px-1.5 rounded border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10">è lui: collega</button>
                              <button onClick={() => { setCreaComunque(p => [...p, r.n]); setCollega(p => { const q = { ...p }; delete q[r.n]; return q; }); invalidaProva(); }}
                                className="px-1.5 rounded border border-slate-600 hover:bg-slate-800">è un altro: crea</button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {righeRapporto.length > 500 && <p className="text-slate-500">Le prime 500 righe: filtra per esito per vedere le altre.</p>}
              {rapporto.conteggi.possibile > 0 && (
                <p className="text-amber-200">{rapporto.conteggi.possibile} righe somigliano a conducenti già presenti: finché non scegli, non si creano.</p>
              )}
            </section>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-800">
          <span className="text-[10px] text-slate-500">Se cambi una scelta, rifai la prova prima di applicare.</span>
          <button onClick={onClose} className="ml-auto px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Chiudi</button>
          <button onClick={() => { if (confirm(`Applicare l'import? ${rapporto?.conteggi.nuovo ?? 0} nuovi, ${rapporto?.conteggi.aggiorna ?? 0} da aggiornare.`)) applica.mutate(); }}
            disabled={!rapporto || rapporto.conteggi.errore > 0 || applica.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
            {applica.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Applica
          </button>
        </div>
      </div>
    </div>
  );
}
