/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PERSONALE — l'elenco dei conducenti e lo scadenziario
 * ───────────────────────────────────────────────────────────────────────────
 * Due viste sullo stesso elenco:
 *   · Elenco: ricerca, filtri (deposito, categoria, documenti), una riga per
 *     conducente con i dati che servono a vestire i turni; un clic apre la
 *     scheda;
 *   · Scadenziario: una riga per documento scaduto, in scadenza nei prossimi
 *     90 giorni, senza data o con una visita non idonea.
 *
 * Chi ha il permesso «Personale» vede anche contatti, busta paga e ferie, e
 * può importare da Excel; chi ha solo lo Scheduling vede i dati operativi.
 * Indirizzi: ?vista=scadenze e ?conducente=<id> aprono vista e scheda.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "wouter";
import {
  IdCard, Search, Plus, Upload, Download, AlertTriangle, CalendarClock, ListChecks, ArrowUpDown, Users, FlaskConical,
} from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import {
  DOCUMENTI, ETICHETTE_MOTIVO, ORDINE_STATI, STATI, ddmmyyyy, formattaOrario, nominativo, oggiRoma, scadenzeDi, statoPeggiore,
  type Conducente, type Deposito, type StatoScadenza,
} from "@/lib/anagrafica-api";
import DriverEditDialog from "@/components/roster/DriverEditDialog";
import ImportaAnagraficaDialog from "@/components/roster/ImportaAnagraficaDialog";
import { AbilitazioneBadges } from "@/components/roster/abilitazioni";

type Vista = "elenco" | "scadenze";
type FiltroDocumenti = "tutti" | "da_guardare" | "scaduti";
type Ordine = "nome" | "matricola" | "deposito" | "documenti";

function parametri(): URLSearchParams {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}

function aggiornaIndirizzo(chiave: string, valore: string | null) {
  try {
    const url = new URL(window.location.href);
    if (valore) url.searchParams.set(chiave, valore);
    else url.searchParams.delete(chiave);
    window.history.replaceState(null, "", url.toString());
  } catch { /* niente history: pazienza */ }
}

export default function AnagraficaPage() {
  const { hasPermission } = useAuth();
  const personale = hasPermission("personale");
  const qc = useQueryClient();
  const [vista, setVista] = useState<Vista>(() => (parametri().get("vista") === "scadenze" ? "scadenze" : "elenco"));
  const [scheda, setScheda] = useState<string | "nuovo" | null>(() => parametri().get("conducente"));
  const [importa, setImporta] = useState(false);
  const [cerca, setCerca] = useState("");
  const [deposito, setDeposito] = useState<string | null>(null);
  const [categoria, setCategoria] = useState("");
  const [documenti, setDocumenti] = useState<FiltroDocumenti>("tutti");
  const [ancheFuori, setAncheFuori] = useState(false);
  const [ancheFittizi, setAncheFittizi] = useState(false);
  const [ordine, setOrdine] = useState<Ordine>("nome");
  const oggi = oggiRoma();

  const q = useQuery({
    queryKey: ["roster", "drivers", "anagrafica", ancheFuori],
    queryFn: () => apiFetch<{ drivers: Conducente[]; sensibili: boolean; avvisi?: string[] }>(`/api/roster/drivers?foto=0${ancheFuori ? "&tutti=1" : ""}`),
  });
  const depositi = useQuery({ queryKey: ["roster", "depositi"], queryFn: () => apiFetch<{ depositi: Deposito[] }>("/api/roster/depositi").then(r => r.depositi) });

  const tutti = q.data?.drivers ?? [];
  const sensibili = !!q.data?.sensibili;
  const base = useMemo(() => tutti.filter(c => ancheFittizi || !c.isFictitious), [tutti, ancheFittizi]);
  const conScadenze = useMemo(() => base.map(c => ({ c, voci: c.isActive ? scadenzeDi(c, oggi) : [] })), [base, oggi]);
  const elencoDepositi = (depositi.data ?? []).map(d => d.nome);

  const perDeposito = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of base) m.set(c.residenzaServizio ?? "", (m.get(c.residenzaServizio ?? "") ?? 0) + 1);
    return m;
  }, [base]);
  const fuoriElenco = [...perDeposito.keys()].filter(k => k && depositi.data && !elencoDepositi.includes(k));
  const categorie = useMemo(() => [...new Set(base.map(c => c.categoria).filter(Boolean) as string[])].sort(), [base]);

  const visibili = useMemo(() => {
    const t = cerca.trim().toLowerCase();
    const out = conScadenze.filter(({ c, voci }) => {
      if (deposito !== null && (c.residenzaServizio ?? "") !== deposito) return false;
      if (categoria && c.categoria !== categoria) return false;
      const p = voci.length ? statoPeggiore(voci) : "ok";
      if (documenti === "scaduti" && p !== "scaduta" && p !== "non_idoneo") return false;
      if (documenti === "da_guardare" && (p === "ok" || p === "entro_90")) return false;
      if (t) {
        const testo = `${c.matricola ?? ""} ${c.cognome ?? ""} ${c.nome ?? ""} ${c.name}`.toLowerCase();
        if (!testo.includes(t)) return false;
      }
      return true;
    });
    const cmp = (a: string, b: string) => a.localeCompare(b, "it", { numeric: true });
    /* i vuoti in fondo (un segnaposto come «~» finisce invece in cima con localeCompare) */
    const cmpVuotiInFondo = (a: string | null, b: string | null) => (a === null) !== (b === null) ? (a === null ? 1 : -1) : a === null ? 0 : cmp(a, b!);
    out.sort((x, y) => {
      if (ordine === "matricola") return cmpVuotiInFondo(x.c.matricola, y.c.matricola);
      if (ordine === "deposito") return cmpVuotiInFondo(x.c.residenzaServizio, y.c.residenzaServizio) || cmp(nominativo(x.c), nominativo(y.c));
      if (ordine === "documenti") {
        return ORDINE_STATI.indexOf(x.voci.length ? statoPeggiore(x.voci) : "ok") - ORDINE_STATI.indexOf(y.voci.length ? statoPeggiore(y.voci) : "ok")
          || cmp(nominativo(x.c), nominativo(y.c));
      }
      return cmp(nominativo(x.c), nominativo(y.c));
    });
    return out;
  }, [conScadenze, cerca, deposito, categoria, documenti, ordine]);

  const scadenze = useMemo(() => visibili
    .flatMap(({ c, voci }) => voci.filter(v => v.stato !== "ok").map(v => ({ c, v })))
    .sort((a, b) => ORDINE_STATI.indexOf(a.v.stato) - ORDINE_STATI.indexOf(b.v.stato)
      || (a.v.scadenza ?? "9999").localeCompare(b.v.scadenza ?? "9999")), [visibili]);

  /* contano quello che c'è nella tabella sotto: gli stessi filtri */
  const conteggiStati = useMemo(() => {
    const m: Record<StatoScadenza, number> = { non_idoneo: 0, scaduta: 0, entro_30: 0, entro_60: 0, entro_90: 0, mancante: 0, ok: 0 };
    for (const { voci } of visibili) for (const v of voci) m[v.stato]++;
    return m;
  }, [visibili]);

  /* conducenti di prova: ritratto, depositi diversi, rotazioni riposi miste coi riposi già generati */
  const prova = useMutation({
    mutationFn: () => apiFetch<{ created: number; riposi: number }>("/api/roster/drivers/seed", { method: "POST", body: JSON.stringify({ count: 30 }) }),
    onSuccess: (r) => {
      toast.success(`${r.created} conducenti di prova creati, con ${r.riposi} riposi già sul tabellone`);
      setAncheFittizi(true);
      qc.invalidateQueries({ queryKey: ["roster"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scegliVista = (v: Vista) => { setVista(v); aggiornaIndirizzo("vista", v === "scadenze" ? "scadenze" : null); };
  const apri = (id: string | "nuovo" | null) => { setScheda(id); aggiornaIndirizzo("conducente", id && id !== "nuovo" ? id : null); };
  const esporta = (formato: "xlsx" | "csv") => `${getApiBase()}/api/roster/anagrafica/esporta?formato=${formato}${ancheFuori ? "&tutti=1" : ""}`;

  const intestazione = (o: Ordine, testo: string) => (
    <th scope="col" className="px-2 py-2 text-left font-medium" aria-sort={ordine === o ? "ascending" : "none"}>
      <button onClick={() => setOrdine(o)} className={`inline-flex items-center gap-1 hover:text-foreground ${ordine === o ? "text-foreground" : ""}`}>
        {testo} <ArrowUpDown className="w-3 h-3 opacity-60" />
      </button>
    </th>
  );

  return (
    <div className="max-w-7xl mx-auto space-y-4 pb-8">
      <header className="flex flex-wrap items-start gap-3">
        <div className="p-2 rounded-xl bg-white/5 border border-border/60"><IdCard className="w-5 h-5 text-violet-300" /></div>
        <div className="flex-1 min-w-[260px]">
          <h1 className="text-lg font-semibold leading-tight">Anagrafica del personale</h1>
          <p className="text-[12px] text-muted-foreground leading-relaxed max-w-2xl">
            I conducenti che il roster veste: deposito, categoria, orario, rotazioni, documenti
            {sensibili ? ", e i dati personali, di busta paga e delle ferie." : ". I dati personali si vedono con il permesso «Personale»."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/roster" className="px-2.5 py-1.5 rounded-lg text-[11px] border border-border/40 hover:bg-white/5 inline-flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Roster
          </Link>
          <button onClick={() => { if (confirm("Creare 30 conducenti di prova (fittizi, senza matricola) con foto, depositi diversi e rotazioni riposi?")) prova.mutate(); }}
            disabled={prova.isPending}
            className="px-2.5 py-1.5 rounded-lg text-[11px] border border-border/40 hover:bg-white/5 inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Conducenti fittizi per provare il roster: si riconoscono dall'etichetta «fittizio» e si tolgono dalla scheda">
            <FlaskConical className="w-3.5 h-3.5" /> Conducenti di prova
          </button>
          {personale && (
            <>
              <button onClick={() => setImporta(true)} className="px-2.5 py-1.5 rounded-lg text-[11px] border border-border/40 hover:bg-white/5 inline-flex items-center gap-1.5">
                <Upload className="w-3.5 h-3.5" /> Importa da Excel
              </button>
              <button onClick={() => apri("nuovo")} className="px-2.5 py-1.5 rounded-lg text-[11px] bg-violet-600 hover:bg-violet-500 text-white inline-flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Nuovo conducente
              </button>
            </>
          )}
          <a href={esporta("xlsx")} className="px-2.5 py-1.5 rounded-lg text-[11px] border border-sky-500/30 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 inline-flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> Excel
          </a>
          <a href={esporta("csv")} className="px-2.5 py-1.5 rounded-lg text-[11px] border border-border/40 hover:bg-white/5 inline-flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5" /> CSV
          </a>
        </div>
      </header>

      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit" role="tablist" aria-label="Viste dell'anagrafica">
        {([["elenco", "Elenco", <ListChecks key="e" className="w-3.5 h-3.5" />], ["scadenze", "Scadenziario", <CalendarClock key="s" className="w-3.5 h-3.5" />]] as const).map(([id, testo, icona]) => (
          <button key={id} role="tab" aria-selected={vista === id} onClick={() => scegliVista(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${vista === id ? "bg-background/80 border border-border/50 text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-white/5"}`}>
            {icona}{testo}
            {id === "scadenze" && conteggiStati.scaduta + conteggiStati.non_idoneo > 0 && (
              <span className="text-[10px] px-1.5 rounded-full bg-rose-500/20 text-rose-300 tabular-nums">{conteggiStati.scaduta + conteggiStati.non_idoneo}</span>
            )}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <p className="p-10 text-center text-xs text-muted-foreground">Carico l'anagrafica…</p>
      ) : q.isError ? (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[11px] text-red-200" role="alert">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> L'anagrafica non si è potuta leggere: {(q.error as Error).message}
        </div>
      ) : (
        <>
          {(q.data?.avvisi ?? []).map(a => (
            <div key={a} className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-100" role="status">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Da sistemare nell'anagrafica: {a}.</span>
            </div>
          ))}

          {/* Filtri */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button onClick={() => setDeposito(null)} aria-pressed={deposito === null}
              className={`px-2.5 py-1 rounded-full text-[11px] border ${deposito === null ? "border-violet-400/50 bg-violet-500/15 text-violet-100" : "border-border/40 text-muted-foreground hover:bg-white/5"}`}>
              Tutti <span className="tabular-nums opacity-70">{base.length}</span>
            </button>
            {[...elencoDepositi, ...fuoriElenco, ...(perDeposito.has("") ? [""] : [])].map(d => (
              <button key={d || "nessuno"} onClick={() => setDeposito(deposito === d ? null : d)} aria-pressed={deposito === d}
                className={`px-2.5 py-1 rounded-full text-[11px] border ${deposito === d ? "border-violet-400/50 bg-violet-500/15 text-violet-100" : "border-border/40 text-muted-foreground hover:bg-white/5"} ${fuoriElenco.includes(d) ? "border-dashed" : ""}`}
                title={fuoriElenco.includes(d) ? "Deposito fuori dall'elenco dei 7: correggilo dalla scheda" : undefined}>
                {d || "senza deposito"} <span className="tabular-nums opacity-70">{perDeposito.get(d) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <label className="relative">
              <span className="sr-only">Cerca</span>
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={cerca} onChange={e => setCerca(e.target.value)} placeholder="matricola, cognome o nome"
                className="pl-7 pr-2 py-1.5 rounded-lg bg-white/[0.03] border border-border/40 w-56 focus:outline-none focus:border-violet-500/60" />
            </label>
            <label className="inline-flex items-center gap-1.5">
              Categoria
              <select value={categoria} onChange={e => setCategoria(e.target.value)} className="px-2 py-1 rounded-lg bg-white/[0.03] border border-border/40">
                <option value="">tutte</option>
                {categorie.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5">
              Documenti
              <select value={documenti} onChange={e => setDocumenti(e.target.value as FiltroDocumenti)} className="px-2 py-1 rounded-lg bg-white/[0.03] border border-border/40">
                <option value="tutti">tutti</option>
                <option value="da_guardare">da guardare (entro 60 giorni, scaduti, senza data)</option>
                <option value="scaduti">scaduti o non idonei</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={ancheFuori} onChange={e => setAncheFuori(e.target.checked)} className="accent-violet-500" /> anche fuori servizio
            </label>
            <label className="inline-flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={ancheFittizi} onChange={e => setAncheFittizi(e.target.checked)} className="accent-violet-500" /> anche i fittizi
            </label>
            <span className="ml-auto text-muted-foreground tabular-nums">{visibili.length} su {base.length}</span>
          </div>

          {base.length === 0 ? (
            <div className="p-10 text-center text-xs text-muted-foreground space-y-2">
              <p>L'anagrafica è vuota.</p>
              {personale && <p>Si riempie con «Importa da Excel» (l'export dei dipendenti del gestionale va bene) o un conducente alla volta.</p>}
            </div>
          ) : vista === "elenco" ? (
            <div className="overflow-x-auto rounded-xl border border-border/40">
              <table className="w-full text-[11px]">
                <thead className="bg-white/[0.03] text-muted-foreground">
                  <tr>
                    {intestazione("matricola", "Matricola")}
                    {intestazione("nome", "Cognome e nome")}
                    {intestazione("deposito", "Deposito")}
                    <th scope="col" className="px-2 py-2 text-left font-medium">Categoria</th>
                    <th scope="col" className="px-2 py-2 text-left font-medium">Servizio</th>
                    <th scope="col" className="px-2 py-2 text-right font-medium">Orario</th>
                    <th scope="col" className="px-2 py-2 text-left font-medium">Riposi</th>
                    <th scope="col" className="px-2 py-2 text-left font-medium">Turni</th>
                    <th scope="col" className="px-2 py-2 text-left font-medium">Ferie</th>
                    {sensibili && <th scope="col" className="px-2 py-2 text-right font-medium">Param.</th>}
                    {sensibili && <th scope="col" className="px-2 py-2 text-right font-medium">Ferie residue</th>}
                    <th scope="col" className="px-2 py-2 text-left font-medium">Cellulare</th>
                    {intestazione("documenti", "Documenti")}
                  </tr>
                </thead>
                <tbody>
                  {visibili.map(({ c, voci }) => {
                    const p = voci.length ? statoPeggiore(voci) : null;
                    const daGuardare = voci.filter(v => v.stato !== "ok" && v.stato !== "entro_90");
                    return (
                      <tr key={c.id} onClick={() => apri(c.id)} className={`border-t border-border/30 cursor-pointer hover:bg-white/[0.04] ${c.isActive ? "" : "opacity-50"}`}>
                        <td className="px-2 py-1.5 font-mono tabular-nums">{c.matricola ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-2 py-1.5">
                          <button className="text-left hover:underline focus-visible:underline" onClick={e => { e.stopPropagation(); apri(c.id); }}>
                            {nominativo(c)}
                          </button>
                          {c.isFictitious && <span className="ml-1.5 text-[9px] px-1 rounded bg-slate-800 text-slate-400">fittizio</span>}
                          {!c.isActive && <span className="ml-1.5 text-[9px] px-1 rounded bg-rose-500/15 text-rose-300">fuori servizio</span>}
                          <span className="ml-1.5 align-middle"><AbilitazioneBadges keys={c.abilitazioni} size={10} /></span>
                        </td>
                        <td className={`px-2 py-1.5 ${c.residenzaServizio && depositi.data && !elencoDepositi.includes(c.residenzaServizio) ? "text-amber-300" : ""}`}>{c.residenzaServizio ?? "—"}</td>
                        <td className="px-2 py-1.5">{c.categoria ?? "—"}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {c.dataAssunzione && <span className="text-muted-foreground tabular-nums">dal {ddmmyyyy(c.dataAssunzione)}</span>}
                          {c.dataFineServizio && (() => {
                            /* l'uscita annunciata: entro 6 mesi in evidenza, già passata in rosso */
                            const g = Math.round((Date.parse(`${c.dataFineServizio}T00:00:00Z`) - Date.parse(`${oggi}T00:00:00Z`)) / 86_400_000);
                            const motivo = c.motivoCessazione ? ` · ${ETICHETTE_MOTIVO[c.motivoCessazione].toLowerCase()}` : "";
                            const stile = g < 0 ? "bg-rose-500/15 text-rose-300" : g <= 183 ? "bg-amber-500/15 text-amber-200" : "bg-white/5 text-muted-foreground";
                            return (
                              <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded tabular-nums ${stile}`}>
                                {g < 0 ? "uscito il" : "esce il"} {ddmmyyyy(c.dataFineServizio)}{motivo}
                              </span>
                            );
                          })()}
                          {!c.dataAssunzione && !c.dataFineServizio && <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formattaOrario(c.orarioSettimanaleMin) || "—"}</td>
                        <td className="px-2 py-1.5">
                          {c.rotazioneRiposi ? <span title={c.rotazioneRiposi.nome}>scagl. {c.rotazioneRiposi.scaglione}</span> : "—"}
                          {c.rotazioniRiposi > 1 && <span className="ml-1 text-amber-300" title="In più rotazioni riposi"><AlertTriangle className="w-3 h-3 inline" /></span>}
                        </td>
                        <td className="px-2 py-1.5">{c.rotazioneTurni ? `${c.rotazioneTurni.gruppo}${c.rotazioneTurni.posizione ? ` · ${c.rotazioneTurni.posizione}` : ""}` : "—"}</td>
                        <td className="px-2 py-1.5">{c.scaglioneFerie ?? "—"}</td>
                        {sensibili && <td className="px-2 py-1.5 text-right tabular-nums">{c.parametro ?? "—"}</td>}
                        {sensibili && (
                          <td className="px-2 py-1.5 text-right tabular-nums" title={c.ferieResidueAl ? `al ${ddmmyyyy(c.ferieResidueAl)}` : undefined}>
                            {c.ferieResidue ?? "—"}{c.ferieResidue != null && c.ferieUnita === "ore" ? " h" : ""}
                          </td>
                        )}
                        <td className="px-2 py-1.5 tabular-nums">{c.cellulare ?? "—"}</td>
                        <td className="px-2 py-1.5">
                          {p && (
                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: STATI[p].colore, background: STATI[p].fondo }}
                              title={daGuardare.map(v => `${DOCUMENTI[v.documento]}: ${STATI[v.stato].testo}${v.scadenza ? ` (${ddmmyyyy(v.scadenza)})` : ""}`).join("\n") || "Tutto in regola"}>
                              {STATI[p].testo}{daGuardare.length > 1 ? ` · ${daGuardare.length}` : ""}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {ORDINE_STATI.filter(s => s !== "ok").map(s => (
                  <div key={s} className="px-3 py-2 rounded-lg border border-border/40" style={{ background: STATI[s].fondo }}>
                    <div className="text-[10px]" style={{ color: STATI[s].colore }}>{STATI[s].testo}</div>
                    <div className="font-mono text-lg tabular-nums">{conteggiStati[s]}</div>
                  </div>
                ))}
              </div>
              {scadenze.length === 0 ? (
                <p className="p-8 text-center text-xs text-muted-foreground">Nessun documento da guardare nei prossimi 90 giorni con questi filtri.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border/40">
                  <table className="w-full text-[11px]">
                    <thead className="bg-white/[0.03] text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Stato</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Documento</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Scadenza</th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">Giorni</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Matricola</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Cognome e nome</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Deposito</th>
                        <th scope="col" className="px-2 py-2 text-left font-medium">Cellulare</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scadenze.map(({ c, v }) => (
                        <tr key={`${c.id}-${v.documento}`} onClick={() => apri(c.id)} className="border-t border-border/30 cursor-pointer hover:bg-white/[0.04]">
                          <td className="px-2 py-1.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: STATI[v.stato].colore, background: STATI[v.stato].fondo }}>{STATI[v.stato].testo}</span>
                          </td>
                          <td className="px-2 py-1.5">{DOCUMENTI[v.documento]}</td>
                          <td className="px-2 py-1.5 tabular-nums">{ddmmyyyy(v.scadenza) || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{v.giorni ?? "—"}</td>
                          <td className="px-2 py-1.5 font-mono">{c.matricola ?? "—"}</td>
                          <td className="px-2 py-1.5">
                            <button className="text-left hover:underline" onClick={e => { e.stopPropagation(); apri(c.id); }}>{nominativo(c)}</button>
                          </td>
                          <td className="px-2 py-1.5">{c.residenzaServizio ?? "—"}</td>
                          <td className="px-2 py-1.5 tabular-nums">{c.cellulare ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[10px] text-muted-foreground">
                Contano patente, CQC, visita ferrovie e visita del medico competente. «Non idoneo» vale anche per «temporaneamente non idoneo» e prevale sulla data.
              </p>
            </>
          )}
        </>
      )}

      {scheda && <DriverEditDialog driverId={scheda === "nuovo" ? null : scheda} onClose={() => apri(null)} />}
      {importa && <ImportaAnagraficaDialog onClose={() => setImporta(false)} />}
    </div>
  );
}
