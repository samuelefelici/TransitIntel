/**
 * La scheda del conducente — anagrafica completa, condivisa dal tabellone
 * del roster e dalla pagina Anagrafica personale.
 *
 * Come salva: manda SOLO i campi cambiati, più la `versione` letta. Se
 * qualcun altro ha salvato nel frattempo il server risponde 409 e la scheda
 * chiede di ricaricare, invece di riscrivere valori vecchi. Deposito,
 * categoria, orario, visite e scadenze finiscono nello storico con la data
 * di decorrenza (oggi, o quella scelta): lo storico si allunga da solo.
 *
 * Chi vede che cosa: senza il permesso «Personale» la scheda di una persona
 * vera è in sola lettura e mostra solo i dati operativi; i conducenti
 * fittizi si possono modificare nei campi operativi.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2, X, Save, Camera, Trash2, Plus, History, CalendarDays, AlertTriangle, RotateCcw, UserX, UserCheck, Lock,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import {
  ETICHETTE_CAMPI, ETICHETTE_ESITO, ETICHETTE_STORICO, GIORNI, PARAMETRI, ddmmyyyy, formattaOrario, leggiOrarioInput,
  oggiRoma, scadenzeDi, STATI,
  type Categoria, type Conducente, type Deposito, type EsitoScrittura, type EsitoVisita, type GruppoTurni,
  type RigaStorico, type Rotazione,
} from "@/lib/anagrafica-api";
import { ABILITAZIONI, type AbilitazioneKey } from "./abilitazioni";
import { MiniGrid } from "./RotazioniRiposi";
import { useDialogo } from "./useDialogo";

/** Il conducente come lo usa il tabellone: è lo stesso oggetto dell'API. */
export type RosterDriver = Conducente;

const TEXT = "w-full px-2 py-1.5 text-sm rounded-md bg-slate-950 border border-slate-700 text-slate-100 focus:border-violet-500 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500 disabled:opacity-60 disabled:cursor-not-allowed";
const LABEL = "block text-[11px] font-medium text-slate-400 mb-0.5";
const SEZIONE = "text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2 flex items-center gap-1.5";

/** I campi del modulo, come stringhe (gli input le vogliono così). */
interface Modulo {
  matricola: string; cognome: string; nome: string; cf: string; dataNascita: string;
  residenzaServizio: string; categoria: string; orario: string;
  rotazioneId: string; scaglione: string; scaglioneFerie: string; gruppoTurni: string; posizioneTurni: string;
  abilitazioni: string[]; dataFineServizio: string;
  cellulare: string; telefono: string; residenzaAnagrafica: string;
  dataAssunzione: string; inquadramento: string; parametro: string;
  ferieAnnue: string; ferieResidue: string; ferieResidueAl: string; ferieUnita: "giorni" | "ore";
  patente: string; patenteNumero: string; cqcNumero: string; patenteValidita: string; cqcValidita: string;
  visitaFerrovieData: string; visitaFerrovieValidita: string; visitaFerrovieEsito: string;
  visitaMedicoCompetenteData: string; visitaMedicoCompetenteValidita: string; visitaMedicoCompetenteEsito: string;
  note: string; photoUrl: string;
}

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function daConducente(c: Conducente | null): Modulo {
  return {
    matricola: s(c?.matricola), cognome: s(c?.cognome), nome: s(c?.nome), cf: s(c?.cf), dataNascita: s(c?.dataNascita),
    residenzaServizio: s(c?.residenzaServizio), categoria: s(c?.categoria), orario: formattaOrario(c?.orarioSettimanaleMin),
    rotazioneId: s(c?.rotazioneRiposi?.id), scaglione: s(c?.rotazioneRiposi?.scaglione),
    scaglioneFerie: s(c?.scaglioneFerie), gruppoTurni: s(c?.rotazioneTurni?.gruppo), posizioneTurni: s(c?.rotazioneTurni?.posizione),
    abilitazioni: c?.abilitazioni ?? [], dataFineServizio: s(c?.dataFineServizio),
    cellulare: s(c?.cellulare), telefono: s(c?.telefono), residenzaAnagrafica: s(c?.residenzaAnagrafica),
    dataAssunzione: s(c?.dataAssunzione), inquadramento: s(c?.inquadramento), parametro: s(c?.parametro),
    ferieAnnue: s(c?.ferieAnnue), ferieResidue: s(c?.ferieResidue), ferieResidueAl: s(c?.ferieResidueAl),
    ferieUnita: c?.ferieUnita ?? "giorni",
    patente: s(c?.patente), patenteNumero: s(c?.patenteNumero), cqcNumero: s(c?.cqcNumero),
    patenteValidita: s(c?.patenteValidita), cqcValidita: s(c?.cqcValidita),
    visitaFerrovieData: s(c?.visitaFerrovieData), visitaFerrovieValidita: s(c?.visitaFerrovieValidita), visitaFerrovieEsito: s(c?.visitaFerrovieEsito),
    visitaMedicoCompetenteData: s(c?.visitaMedicoCompetenteData), visitaMedicoCompetenteValidita: s(c?.visitaMedicoCompetenteValidita),
    visitaMedicoCompetenteEsito: s(c?.visitaMedicoCompetenteEsito),
    note: s(c?.note), photoUrl: s(c?.photoUrl),
  };
}

/** I campi cambiati, nel formato dell'API. `errori` raccoglie quelli che non si leggono già qui. */
function corpoCambiato(prima: Modulo, ora: Modulo, errori: Record<string, string>, forzaRotazione = false): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  const vuotoNull = (v: string) => (v.trim() === "" ? null : v.trim());
  const semplici: Array<keyof Modulo> = [
    "matricola", "cognome", "nome", "cf", "dataNascita", "residenzaServizio", "categoria", "scaglioneFerie", "dataFineServizio",
    "cellulare", "telefono", "residenzaAnagrafica", "dataAssunzione", "inquadramento", "patente", "patenteNumero", "cqcNumero",
    "patenteValidita", "cqcValidita", "visitaFerrovieData", "visitaFerrovieValidita", "visitaFerrovieEsito",
    "visitaMedicoCompetenteData", "visitaMedicoCompetenteValidita", "visitaMedicoCompetenteEsito", "note", "photoUrl",
  ];
  for (const k of semplici) if (prima[k] !== ora[k]) b[k] = vuotoNull(String(ora[k]));
  if (prima.orario !== ora.orario) {
    const m = leggiOrarioInput(ora.orario);
    if (Number.isNaN(m)) errori.orarioSettimanaleMin = "scrivi per esempio 38:30";
    else b.orarioSettimanaleMin = m;
  }
  if (prima.parametro !== ora.parametro) b.parametro = ora.parametro ? Number(ora.parametro) : null;
  if (prima.ferieAnnue !== ora.ferieAnnue) b.ferieAnnue = vuotoNull(ora.ferieAnnue.replace(",", "."));
  if (prima.ferieResidue !== ora.ferieResidue || prima.ferieResidueAl !== ora.ferieResidueAl) {
    b.ferieResidue = vuotoNull(ora.ferieResidue.replace(",", "."));
    b.ferieResidueAl = vuotoNull(ora.ferieResidueAl);
  }
  if (prima.ferieUnita !== ora.ferieUnita) b.ferieUnita = ora.ferieUnita;
  if ([...prima.abilitazioni].sort().join() !== [...ora.abilitazioni].sort().join()) b.abilitazioni = ora.abilitazioni;
  /* forzaRotazione: il conducente è in più rotazioni; mandare quella scelta toglie le altre */
  if (forzaRotazione || prima.rotazioneId !== ora.rotazioneId || prima.scaglione !== ora.scaglione) {
    if (!ora.rotazioneId) b.rotazioneRiposi = null;
    else if (!ora.scaglione) errori.rotazioneRiposi = "manca lo scaglione";
    else b.rotazioneRiposi = { id: ora.rotazioneId, scaglione: Number(ora.scaglione) };
  }
  if (prima.gruppoTurni !== ora.gruppoTurni || prima.posizioneTurni !== ora.posizioneTurni) {
    b.rotazioneTurni = ora.gruppoTurni.trim() ? { gruppo: ora.gruppoTurni.trim(), posizione: ora.posizioneTurni ? Number(ora.posizioneTurni) : null } : null;
  }
  return b;
}

/** Ridimensiona un'immagine a max 256px e la restituisce come data-URI JPEG. */
async function ridimensiona(file: File, max = 256): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const scala = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scala);
  canvas.height = Math.round(img.height * scala);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function Campo({ id, label, errore, children, largo }: {
  id: string; label: string; errore?: string; children: React.ReactNode; largo?: boolean;
}) {
  return (
    <div className={largo ? "col-span-2 md:col-span-3" : undefined}>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children}
      {errore && <p className="mt-0.5 text-[10px] text-rose-400" role="alert">{errore}</p>}
    </div>
  );
}

export default function DriverEditDialog({ driverId, onClose, fittizio = false }: {
  /** null = nuovo conducente */
  driverId: string | null;
  onClose: () => void;
  /** un nuovo conducente fittizio (dal tabellone, per chi non ha «Personale») */
  fittizio?: boolean;
}) {
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const personale = hasPermission("personale");
  const [id, setId] = useState<string | null>(driverId);
  const titoloId = "scheda-conducente-titolo";

  const q = useQuery({
    queryKey: ["roster", "driver", id],
    queryFn: () => apiFetch<{ conducente: Conducente; sensibili: boolean }>(`/api/roster/drivers/${id}`),
    enabled: !!id,
    staleTime: 0,
  });
  const depositi = useQuery({ queryKey: ["roster", "depositi"], queryFn: () => apiFetch<{ depositi: Deposito[] }>("/api/roster/depositi").then(r => r.depositi) });
  const categorie = useQuery({ queryKey: ["roster", "categorie"], queryFn: () => apiFetch<{ categorie: Categoria[] }>("/api/roster/categorie").then(r => r.categorie) });
  const gruppi = useQuery({ queryKey: ["roster", "gruppi-turni"], queryFn: () => apiFetch<{ gruppi: GruppoTurni[] }>("/api/roster/gruppi-turni").then(r => r.gruppi) });
  const rotazioni = useQuery({ queryKey: ["roster", "rotazioni-riposi"], queryFn: () => apiFetch<{ rotazioni: Rotazione[] }>("/api/roster/rotazioni-riposi").then(r => r.rotazioni) });

  const c = q.data?.conducente ?? null;
  const sensibili = id ? !!q.data?.sensibili : personale;
  const eFittizio = c ? c.isFictitious : fittizio;
  const puoScrivere = personale || (eFittizio && hasPermission("scheduling"));

  const [iniziale, setIniziale] = useState<Modulo>(() => daConducente(null));
  const [f, setF] = useState<Modulo>(() => daConducente(null));
  const [decorrenza, setDecorrenza] = useState("");
  const [errori, setErrori] = useState<Record<string, string>>({});
  const [conflitto, setConflitto] = useState<string | null>(null);
  const [cqcDiverso, setCqcDiverso] = useState(false);
  const sporco = useMemo(() => JSON.stringify(iniziale) !== JSON.stringify(f), [iniziale, f]);

  /* il modulo si riallinea al server quando arriva una versione nuova, ma
   * non sotto le mani di chi sta scrivendo: lì ci pensa il 409 */
  const versioneVista = useRef<number | null>(null);
  useEffect(() => {
    if (!c || (sporco && versioneVista.current !== null)) return;
    if (versioneVista.current === c.versione) return;
    versioneVista.current = c.versione;
    const m = daConducente(c);
    setIniziale(m);
    setF(m);
    setCqcDiverso(!!c.cqcNumero && c.cqcNumero !== c.patenteNumero);
    setConflitto(null);
  }, [c, sporco]);

  /* il numero del CQC segue quello della patente, finché non si dice che è diverso */
  const set = <K extends keyof Modulo>(k: K, v: Modulo[K]) => setF(p => ({
    ...p, [k]: v, ...(k === "patenteNumero" && !cqcDiversoRef.current ? { cqcNumero: v as string } : {}),
  }));
  const cqcDiversoRef = useRef(false);
  cqcDiversoRef.current = cqcDiverso;
  const primoCampo = useRef<HTMLInputElement>(null);
  const finestra = useRef<HTMLDivElement>(null);
  const doppie = (c?.rotazioniRiposi ?? 0) > 1 && !!f.rotazioneId;

  const salva = useMutation({
    mutationFn: async () => {
      const err: Record<string, string> = {};
      const corpo = corpoCambiato(id ? iniziale : daConducente(null), f, err, doppie);
      if (Object.keys(err).length) { setErrori(err); throw new Error("Controlla i campi segnati"); }
      /* la decorrenza vale per deposito, categoria e orario: solo se uno dei tre cambia */
      if (decorrenza && cambiaStorico) corpo.decorrenza = decorrenza;
      if (!id) {
        if (eFittizio) corpo.isFictitious = true;
        return apiFetch<EsitoScrittura>("/api/roster/drivers", { method: "POST", body: JSON.stringify(corpo) });
      }
      if (Object.keys(corpo).filter(k => k !== "decorrenza").length === 0) return null;
      /* la versione su cui è stato costruito il modulo, non l'ultima letta:
       * se nel frattempo la scheda è cambiata, il server deve dire 409 */
      return apiFetch<EsitoScrittura>(`/api/roster/drivers/${id}`, {
        method: "PATCH", body: JSON.stringify({ ...corpo, versione: versioneVista.current ?? c?.versione }),
      });
    },
    onSuccess: (r) => {
      setErrori({});
      setConflitto(null);
      if (!r) { toast.info("Niente da salvare"); return; }
      qc.invalidateQueries({ queryKey: ["roster"] });
      for (const a of r.avvisi) toast.info(a);
      if (r.daRigenerare.length) toast.warning("La rotazione riposi è cambiata: rigenera i riposi da «Algoritmi → Assegna cadenze → Riposi»");
      if (r.conducente) {
        versioneVista.current = null; // accetta la versione appena salvata
        if (!id) setId(r.conducente.id);
        qc.setQueryData(["roster", "driver", r.conducente.id], { conducente: r.conducente, sensibili });
        const m = daConducente(r.conducente);
        setIniziale(m);
        setF(m);
        versioneVista.current = r.conducente.versione;
      }
      toast.success(id ? "Scheda salvata" : "Conducente creato");
      setDecorrenza("");
    },
    onError: (e: any) => {
      if (e?.body?.campi) setErrori(e.body.campi);
      if (e?.status === 409) setConflitto(e.message);
      toast.error(e?.message ?? "Salvataggio non riuscito");
    },
  });

  const disattiva = useMutation({
    mutationFn: () => apiFetch<{ turniLiberati: number }>(`/api/roster/drivers/${id}`, { method: "DELETE" }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["roster"] });
      toast.success(r.turniLiberati ? `Fuori servizio: ${r.turniLiberati} turni da oggi in poi tornano scoperti` : "Fuori servizio");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const riattiva = useMutation({
    mutationFn: () => apiFetch<EsitoScrittura>(`/api/roster/drivers/${id}/riattiva`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["roster"] }); versioneVista.current = null; toast.success("Di nuovo in servizio"); },
    onError: (e: Error) => toast.error(e.message),
  });

  /* Chiudi, X ed Esc passano tutti da qui: con modifiche non salvate si chiede */
  const chiudi = () => {
    if (salva.isPending) return;
    if (sporco && !confirm("Chiudere senza salvare le modifiche?")) return;
    onClose();
  };
  useDialogo(finestra, chiudi);
  /* a scheda caricata il focus va sul primo campo che si può scrivere */
  const caricata = !id || q.isSuccess;
  useEffect(() => {
    if (!caricata) return;
    const el = finestra.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
    (el ?? finestra.current)?.focus();
  }, [caricata]);

  const fotoRef = useRef<HTMLInputElement>(null);
  const [caricaFoto, setCaricaFoto] = useState(false);
  const scegliFoto = async (file: File | undefined) => {
    if (!file) return;
    setCaricaFoto(true);
    try { set("photoUrl", await ridimensiona(file)); }
    catch { toast.error("Immagine non valida"); }
    finally { setCaricaFoto(false); }
  };

  const dep = (depositi.data ?? []).find(d => d.nome === f.residenzaServizio);
  const fuoriElenco = !!f.residenzaServizio && depositi.data && !dep;
  const gruppiDelDeposito = (gruppi.data ?? []).filter(g => g.depositoCodice === dep?.codice);
  const rotScelta = (rotazioni.data ?? []).find(r => r.id === f.rotazioneId);
  const iniziali = ((f.cognome || c?.name || "?").trim().slice(0, 2) || "?").toUpperCase();
  const ro = !puoScrivere;
  const cambiaStorico = iniziale.residenzaServizio !== f.residenzaServizio || iniziale.categoria !== f.categoria || iniziale.orario !== f.orario;
  const daSalvare = sporco || doppie;
  const oggi = oggiRoma();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div ref={finestra} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titoloId}
        className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col text-slate-100 focus:outline-none">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-slate-800">
          <div id={titoloId} className="text-sm font-semibold">
            {!id ? (eFittizio ? "Nuovo conducente fittizio" : "Nuovo conducente") : c ? [c.cognome, c.nome].filter(Boolean).join(" ") || c.name : "Conducente"}
          </div>
          {c?.matricola && <span className="text-[11px] font-mono text-slate-400">matr. {c.matricola}</span>}
          {eFittizio && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">fittizio</span>}
          {c && !c.isActive && <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">non più in servizio</span>}
          {ro && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> sola lettura</span>}
          <button onClick={chiudi} aria-label="Chiudi la scheda" className="ml-auto p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 focus-visible:ring-1 focus-visible:ring-violet-500">
            <X className="h-4 w-4" />
          </button>
        </div>

        {id && q.isLoading ? (
          <div className="p-12 text-center text-xs text-slate-400"><Loader2 className="w-4 h-4 animate-spin inline mr-1.5" /> Carico la scheda…</div>
        ) : id && q.isError ? (
          <div className="p-12 text-center text-xs text-rose-300">La scheda non si è potuta leggere: {(q.error as Error).message}</div>
        ) : (
          <div className="flex-1 overflow-auto p-5 space-y-5">
            {conflitto && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-100" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span className="flex-1">{conflitto}</span>
                {id && (
                  <button onClick={() => { versioneVista.current = null; setErrori({}); setConflitto(null); void q.refetch().then(r => { if (r.data) { const m = daConducente(r.data.conducente); setIniziale(m); setF(m); versioneVista.current = r.data.conducente.versione; } }); }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-400/40 hover:bg-amber-500/10">
                    <RotateCcw className="w-3 h-3" /> Ricarica (perdi le modifiche)
                  </button>
                )}
              </div>
            )}

            {/* Identità */}
            <section className="flex gap-4">
              <div className="shrink-0">
                <button type="button" disabled={ro} onClick={() => fotoRef.current?.click()} aria-label="Carica la foto"
                  className="relative w-24 h-24 rounded-xl overflow-hidden border border-slate-700 bg-slate-950 flex items-center justify-center group disabled:cursor-default">
                  {f.photoUrl ? <img src={f.photoUrl} alt="" className="w-full h-full object-cover" /> : <span className="text-2xl font-bold text-slate-600">{iniziali}</span>}
                  {!ro && (
                    <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      {caricaFoto ? <Loader2 className="w-5 h-5 animate-spin text-white" /> : <Camera className="w-5 h-5 text-white" />}
                    </span>
                  )}
                </button>
                {f.photoUrl && !ro && (
                  <button onClick={() => set("photoUrl", "")} className="mt-1 w-full text-[10px] text-slate-500 hover:text-rose-400 inline-flex items-center justify-center gap-1">
                    <Trash2 className="w-3 h-3" /> Rimuovi
                  </button>
                )}
                <input ref={fotoRef} type="file" accept="image/*" className="hidden" onChange={e => { void scegliFoto(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
              <div className="flex-1 grid grid-cols-2 md:grid-cols-3 gap-3">
                <Campo id="ana-matricola" label="Matricola" errore={errori.matricola}>
                  <input id="ana-matricola" ref={primoCampo} className={TEXT} disabled={ro || !sensibili} value={f.matricola} onChange={e => set("matricola", e.target.value)} />
                </Campo>
                <Campo id="ana-cognome" label="Cognome" errore={errori.cognome}>
                  <input id="ana-cognome" className={TEXT} disabled={ro} value={f.cognome} onChange={e => set("cognome", e.target.value)} />
                </Campo>
                <Campo id="ana-nome" label="Nome" errore={errori.nome}>
                  <input id="ana-nome" className={TEXT} disabled={ro} value={f.nome} onChange={e => set("nome", e.target.value)} />
                </Campo>
                {sensibili && (
                  <>
                    <Campo id="ana-cf" label="Codice fiscale" errore={errori.cf}>
                      <input id="ana-cf" className={`${TEXT} font-mono uppercase`} disabled={ro} value={f.cf} onChange={e => set("cf", e.target.value)} />
                    </Campo>
                    <Campo id="ana-nascita" label="Data di nascita" errore={errori.dataNascita}>
                      <input id="ana-nascita" type="date" className={TEXT} disabled={ro} value={f.dataNascita} onChange={e => set("dataNascita", e.target.value)} />
                    </Campo>
                  </>
                )}
                <Campo id="ana-cell" label="Cellulare" errore={errori.cellulare}>
                  <input id="ana-cell" type="tel" className={TEXT} disabled={ro} value={f.cellulare} onChange={e => set("cellulare", e.target.value)} />
                </Campo>
              </div>
            </section>

            {/* Servizio */}
            <section>
              <h4 className={SEZIONE}>Deposito e servizio</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <Campo id="ana-deposito" label="Deposito di appartenenza" errore={errori.residenzaServizio}>
                  <select id="ana-deposito" className={TEXT} disabled={ro} value={f.residenzaServizio} onChange={e => set("residenzaServizio", e.target.value)}>
                    <option value="">—</option>
                    {fuoriElenco && <option value={f.residenzaServizio}>{f.residenzaServizio} (non in elenco)</option>}
                    {(depositi.data ?? []).map(d => <option key={d.codice} value={d.nome}>{d.nome} · gruppo {d.gruppo}</option>)}
                  </select>
                </Campo>
                <Campo id="ana-categoria" label="Categoria conducente" errore={errori.categoria}>
                  <input id="ana-categoria" list="ana-categorie" className={TEXT} disabled={ro} value={f.categoria} onChange={e => set("categoria", e.target.value)} />
                  <datalist id="ana-categorie">{(categorie.data ?? []).map(k => <option key={k.codice} value={k.nome} />)}</datalist>
                </Campo>
                <Campo id="ana-orario" label="Orario settimanale (ore:minuti)" errore={errori.orarioSettimanaleMin}>
                  <input id="ana-orario" inputMode="numeric" placeholder="38:30" className={`${TEXT} tabular-nums`} disabled={ro} value={f.orario} onChange={e => set("orario", e.target.value)} />
                </Campo>
                {cambiaStorico && !ro && id && (
                  <Campo id="ana-decorrenza" label="Le variazioni valgono dal" errore={errori.decorrenza} largo>
                    <div className="flex items-center gap-2">
                      <input id="ana-decorrenza" type="date" className={`${TEXT} max-w-[180px]`} value={decorrenza} onChange={e => setDecorrenza(e.target.value)} />
                      <span className="text-[10px] text-slate-500">vuoto = da oggi. Deposito, categoria e orario finiscono nello storico con questa data; una data futura è una variazione programmata.</span>
                    </div>
                  </Campo>
                )}
                {dep && iniziale.residenzaServizio && iniziale.residenzaServizio !== f.residenzaServizio && (
                  <p className="col-span-2 md:col-span-3 text-[10px] text-amber-300/90">
                    Cambiando deposito il gruppo della rotazione turni si toglie; se cambia anche il gruppo dei riposi (A/B) si toglie la rotazione riposi.
                  </p>
                )}
              </div>
            </section>

            {/* Rotazioni */}
            <section>
              <h4 className={SEZIONE}><CalendarDays className="w-3.5 h-3.5" /> Rotazioni e scaglioni</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Campo id="ana-rotazione" label="Rotazione riposi" errore={errori.rotazioneRiposi}>
                  <select id="ana-rotazione" className={TEXT} disabled={ro} value={f.rotazioneId}
                    onChange={e => { set("rotazioneId", e.target.value); if (!e.target.value) set("scaglione", ""); }}>
                    <option value="">nessuna</option>
                    {(rotazioni.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name} ({r.weeks} sett.)</option>)}
                  </select>
                </Campo>
                <Campo id="ana-scaglione" label="Scaglione riposi">
                  <input id="ana-scaglione" type="number" min={1} max={rotScelta?.weeks ?? 99} className={TEXT} disabled={ro || !f.rotazioneId}
                    value={f.scaglione} onChange={e => set("scaglione", e.target.value)} />
                </Campo>
                <Campo id="ana-gruppo-turni" label="Rotazione turni: gruppo" errore={errori.rotazioneTurni}>
                  <input id="ana-gruppo-turni" list="ana-gruppi" className={`${TEXT} uppercase`} disabled={ro || !dep} placeholder={dep ? "es. AN-E" : "prima il deposito"}
                    value={f.gruppoTurni} onChange={e => set("gruppoTurni", e.target.value)} />
                  <datalist id="ana-gruppi">{gruppiDelDeposito.map(g => <option key={g.id} value={g.nome}>{g.conducenti} conducenti</option>)}</datalist>
                </Campo>
                <Campo id="ana-posizione" label="Posizione nel gruppo">
                  <input id="ana-posizione" type="number" min={1} className={TEXT} disabled={ro || !f.gruppoTurni.trim()} value={f.posizioneTurni} onChange={e => set("posizioneTurni", e.target.value)} />
                </Campo>
                <Campo id="ana-scaglione-ferie" label="Scaglione ferie">
                  <input id="ana-scaglione-ferie" className={TEXT} disabled={ro} value={f.scaglioneFerie} onChange={e => set("scaglioneFerie", e.target.value)} />
                </Campo>
                {dep && (
                  <p className="col-span-1 md:col-span-3 self-end text-[10px] text-slate-500">
                    {dep.nome}: turni a rotazione {dep.cadenzaTurni === "settimanale" ? "settimanale" : "quindicinale (1–15 / 16–fine mese)"}, riposi del gruppo {dep.gruppo}
                    {dep.gruppo === "A" ? " (domeniche)" : " (11 scaglioni)"}.
                  </p>
                )}
              </div>
              {(c?.rotazioniRiposi ?? 0) > 1 && (
                <p className="mt-2 text-[11px] text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> Questo conducente è in {c!.rotazioniRiposi} rotazioni riposi: con «Salva» resta solo quella scelta qui, le altre e i loro riposi futuri si tolgono.
                </p>
              )}
              {rotScelta && f.scaglione && (
                <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div className="flex items-center gap-2 mb-1.5 text-[11px]">
                    <span className="font-semibold">{rotScelta.name}</span>
                    {c?.rotazioneRiposi && c.rotazioneRiposi.id === f.rotazioneId && String(c.rotazioneRiposi.scaglione) === f.scaglione && c.rotazioneRiposi.settimanaCorrente && (
                      <span className="text-slate-400">questa settimana riposa: {c.rotazioneRiposi.settimanaCorrente.map((x, i) => (x ? GIORNI[i] : null)).filter(Boolean).join(", ") || "nessun giorno"}</span>
                    )}
                  </div>
                  <MiniGrid grid={rotScelta.pattern} highlight={Number(f.scaglione) - 1} />
                </div>
              )}
            </section>

            {/* Abilitazioni */}
            <section>
              <h4 className={SEZIONE}>Abilitazioni</h4>
              <div className="flex flex-wrap gap-2">
                {ABILITAZIONI.map(a => {
                  const on = f.abilitazioni.includes(a.key);
                  const Icon = a.icon;
                  return (
                    <button key={a.key} type="button" disabled={ro} aria-pressed={on}
                      onClick={() => set("abilitazioni", on ? f.abilitazioni.filter(x => x !== a.key) : [...f.abilitazioni, a.key as AbilitazioneKey])}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors disabled:cursor-default ${on ? "border-transparent text-white" : "border-slate-700 text-slate-400 hover:border-slate-500"}`}
                      style={on ? { background: a.color } : undefined}>
                      <Icon className="w-3.5 h-3.5" /> {a.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Documenti e visite */}
            <section>
              <h4 className={SEZIONE}>Documenti e visite</h4>
              {c && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {scadenzeDi(c, oggi).map(v => (
                    <span key={v.documento} className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: STATI[v.stato].colore, background: STATI[v.stato].fondo }}>
                      {ETICHETTE_STORICO[v.documento]}: {STATI[v.stato].testo}{v.scadenza ? ` · ${ddmmyyyy(v.scadenza)}` : ""}
                    </span>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Campo id="ana-patente" label="Patente (categorie)">
                  <input id="ana-patente" className={TEXT} disabled={ro} placeholder="es. D, DE" value={f.patente} onChange={e => set("patente", e.target.value)} />
                </Campo>
                {sensibili && (
                  <Campo id="ana-patente-numero" label="Numero patente (= CQC)" errore={errori.patenteNumero}>
                    <input id="ana-patente-numero" className={`${TEXT} font-mono uppercase`} disabled={ro} value={f.patenteNumero} onChange={e => set("patenteNumero", e.target.value)} />
                  </Campo>
                )}
                <Campo id="ana-patente-scad" label="Scadenza patente" errore={errori.patenteValidita}>
                  <input id="ana-patente-scad" type="date" className={TEXT} disabled={ro} value={f.patenteValidita} onChange={e => set("patenteValidita", e.target.value)} />
                </Campo>
                <Campo id="ana-cqc-scad" label="Scadenza CQC" errore={errori.cqcValidita}>
                  <input id="ana-cqc-scad" type="date" className={TEXT} disabled={ro} value={f.cqcValidita} onChange={e => set("cqcValidita", e.target.value)} />
                </Campo>
                {sensibili && (
                  <div className="col-span-2 md:col-span-4 -mt-1">
                    <label className="inline-flex items-center gap-1.5 text-[10px] text-slate-400">
                      <input type="checkbox" disabled={ro} checked={cqcDiverso}
                        onChange={e => { setCqcDiverso(e.target.checked); if (!e.target.checked) set("cqcNumero", f.patenteNumero); }} className="accent-violet-500" />
                      il CQC ha un numero diverso dalla patente (vecchia carta separata)
                    </label>
                    {cqcDiverso && (
                      <input aria-label="Numero CQC" className={`${TEXT} font-mono uppercase mt-1 max-w-[220px]`} disabled={ro} value={f.cqcNumero} onChange={e => set("cqcNumero", e.target.value)} />
                    )}
                  </div>
                )}
                {(["visitaFerrovie", "visitaMedicoCompetente"] as const).map(v => (
                  <div key={v} className="col-span-2 grid grid-cols-3 gap-2 rounded-lg border border-slate-800 p-2">
                    <div className="col-span-3 text-[10px] uppercase tracking-wide text-slate-500">{v === "visitaFerrovie" ? "Visita ferrovie (idoneità)" : "Visita medico competente"}</div>
                    {sensibili && (
                      <Campo id={`ana-${v}-data`} label="Data visita" errore={errori[`${v}Data`]}>
                        <input id={`ana-${v}-data`} type="date" className={TEXT} disabled={ro} value={f[`${v}Data`]} onChange={e => set(`${v}Data`, e.target.value)} />
                      </Campo>
                    )}
                    <Campo id={`ana-${v}-scad`} label="Scadenza" errore={errori[`${v}Validita`]}>
                      <input id={`ana-${v}-scad`} type="date" className={TEXT} disabled={ro} value={f[`${v}Validita`]} onChange={e => set(`${v}Validita`, e.target.value)} />
                    </Campo>
                    {sensibili && (
                      <Campo id={`ana-${v}-esito`} label="Esito" errore={errori[`${v}Esito`]}>
                        <select id={`ana-${v}-esito`} className={TEXT} disabled={ro} value={f[`${v}Esito`]} onChange={e => set(`${v}Esito`, e.target.value)}>
                          <option value="">—</option>
                          {(Object.keys(ETICHETTE_ESITO) as EsitoVisita[]).map(k => <option key={k} value={k}>{ETICHETTE_ESITO[k]}</option>)}
                        </select>
                      </Campo>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {sensibili && (
              <>
                <section>
                  <h4 className={SEZIONE}>Contatti e residenza</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <Campo id="ana-tel" label="Telefono" errore={errori.telefono}>
                      <input id="ana-tel" type="tel" className={TEXT} disabled={ro} value={f.telefono} onChange={e => set("telefono", e.target.value)} />
                    </Campo>
                    <div className="col-span-2">
                      <Campo id="ana-residenza" label="Dove abita (via, CAP, comune)" errore={errori.residenzaAnagrafica}>
                        <input id="ana-residenza" className={TEXT} disabled={ro} value={f.residenzaAnagrafica} onChange={e => set("residenzaAnagrafica", e.target.value)} />
                      </Campo>
                    </div>
                  </div>
                </section>

                <section>
                  <h4 className={SEZIONE}>Rapporto e busta paga</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Campo id="ana-assunzione" label="Data di assunzione" errore={errori.dataAssunzione}>
                      <input id="ana-assunzione" type="date" className={TEXT} disabled={ro} value={f.dataAssunzione} onChange={e => set("dataAssunzione", e.target.value)} />
                    </Campo>
                    <Campo id="ana-fine" label="In servizio fino al" errore={errori.dataFineServizio}>
                      <input id="ana-fine" type="date" className={TEXT} disabled={ro} value={f.dataFineServizio} onChange={e => set("dataFineServizio", e.target.value)} />
                    </Campo>
                    <Campo id="ana-inquadramento" label="Inquadramento" errore={errori.inquadramento}>
                      <input id="ana-inquadramento" className={TEXT} disabled={ro} value={f.inquadramento} onChange={e => set("inquadramento", e.target.value)} />
                    </Campo>
                    <Campo id="ana-parametro" label="Parametro" errore={errori.parametro}>
                      <select id="ana-parametro" className={TEXT} disabled={ro} value={f.parametro} onChange={e => set("parametro", e.target.value)}>
                        <option value="">—</option>
                        {PARAMETRI.map(p => <option key={p} value={p}>{p}</option>)}
                      </select>
                    </Campo>
                    <Campo id="ana-ferie-annue" label={`Ferie maturate in un anno (${f.ferieUnita})`} errore={errori.ferieAnnue}>
                      <input id="ana-ferie-annue" inputMode="decimal" className={`${TEXT} tabular-nums`} disabled={ro} value={f.ferieAnnue} onChange={e => set("ferieAnnue", e.target.value)} />
                    </Campo>
                    <Campo id="ana-ferie-residue" label={`Ferie residue (${f.ferieUnita})`} errore={errori.ferieResidue}>
                      <input id="ana-ferie-residue" inputMode="decimal" className={`${TEXT} tabular-nums`} disabled={ro} value={f.ferieResidue} onChange={e => set("ferieResidue", e.target.value)} />
                    </Campo>
                    <Campo id="ana-ferie-al" label="Residuo aggiornato al" errore={errori.ferieResidueAl}>
                      <input id="ana-ferie-al" type="date" className={TEXT} disabled={ro} value={f.ferieResidueAl} onChange={e => set("ferieResidueAl", e.target.value)} />
                    </Campo>
                    <Campo id="ana-ferie-unita" label="Le ferie si contano in">
                      <select id="ana-ferie-unita" className={TEXT} disabled={ro} value={f.ferieUnita} onChange={e => set("ferieUnita", e.target.value as "giorni" | "ore")}>
                        <option value="giorni">giorni</option>
                        <option value="ore">ore</option>
                      </select>
                    </Campo>
                  </div>
                </section>

                <Campo id="ana-note" label="Note" errore={errori.note}>
                  <textarea id="ana-note" className={TEXT} rows={2} disabled={ro} value={f.note} onChange={e => set("note", e.target.value)} />
                </Campo>
              </>
            )}

            {!sensibili && !eFittizio && (
              <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" /> Contatti, residenza, busta paga, ferie e date delle visite si vedono con il permesso «Personale».
              </p>
            )}

            {id && sensibili && <Storico driverId={id} depositi={depositi.data ?? []} />}
          </div>
        )}

        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-800">
          {id && c && puoScrivere && (c.isActive ? (
            <button onClick={() => { if (confirm(`${[c.cognome, c.nome].filter(Boolean).join(" ") || c.name} esce dal servizio: i turni assegnati da oggi in poi tornano scoperti e le rotazioni si tolgono. Procedere?`)) disattiva.mutate(); }}
              disabled={disattiva.isPending} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50">
              <UserX className="h-3.5 w-3.5" /> Fuori servizio
            </button>
          ) : personale && (
            <button onClick={() => riattiva.mutate()} disabled={riattiva.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50">
              <UserCheck className="h-3.5 w-3.5" /> Di nuovo in servizio
            </button>
          ))}
          {daSalvare && !ro && (
            <span className="text-[10px] text-slate-500">
              modifiche non salvate: {(() => { const e: Record<string, string> = {}; return Object.keys(corpoCambiato(iniziale, f, e, doppie)).map(k => ETICHETTE_CAMPI[k] ?? k).join(", "); })()}
            </span>
          )}
          <button onClick={chiudi} className="ml-auto px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Chiudi</button>
          {!ro && (
            <button onClick={() => salva.mutate()} disabled={salva.isPending || (!!id && !daSalvare) || (!f.cognome.trim() && !f.nome.trim())}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50">
              {salva.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salva
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Storico ─────────────────────────────────────────────────────────────── */

function Storico({ driverId, depositi }: { driverId: string; depositi: Deposito[] }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState("deposito");
  const [value, setValue] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const q = useQuery({
    queryKey: ["roster", "history", driverId],
    queryFn: () => apiFetch<{ history: RigaStorico[]; oggi: string }>(`/api/roster/drivers/${driverId}/history`),
  });
  const aggiorna = () => {
    qc.invalidateQueries({ queryKey: ["roster", "history", driverId] });
    qc.invalidateQueries({ queryKey: ["roster", "driver", driverId] });
    qc.invalidateQueries({ queryKey: ["roster", "drivers"] });
    qc.invalidateQueries({ queryKey: ["roster", "board"] });
  };
  const aggiungi = useMutation({
    mutationFn: () => apiFetch(`/api/roster/drivers/${driverId}/history`, {
      method: "POST", body: JSON.stringify({ kind, value: value || null, eventDate: eventDate || null, expiryDate: expiryDate || null }),
    }),
    onSuccess: () => { setValue(""); setEventDate(""); setExpiryDate(""); aggiorna(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancella = useMutation({
    mutationFn: (hid: string) => apiFetch(`/api/roster/history/${hid}`, { method: "DELETE" }),
    onSuccess: aggiorna,
    onError: (e: Error) => toast.error(e.message),
  });

  const conScadenza = ["visita_ferrovie", "visita_medico_competente", "patente", "cqc"].includes(kind);
  const serveValore = ["deposito", "categoria", "orario_lavoro"].includes(kind);
  const righe = q.data?.history ?? [];
  const oggi = q.data?.oggi ?? oggiRoma();

  return (
    <section className="border-t border-slate-800 pt-4">
      <h4 className={SEZIONE}><History className="w-3.5 h-3.5" /> Storico</h4>
      <p className="text-[10px] text-slate-500 mb-2">
        La scheda lo allunga da sola a ogni cambio. Qui si aggiungono le variazioni con una data diversa (passate o programmate).
        Vale la riga più recente già in vigore.
      </p>
      <div className="flex flex-wrap items-end gap-2 mb-3 p-2.5 rounded-lg border border-slate-800 bg-slate-950/50">
        <div>
          <label htmlFor="sto-tipo" className={LABEL}>Tipo</label>
          <select id="sto-tipo" className={TEXT} value={kind} onChange={e => { setKind(e.target.value); setValue(""); }}>
            {Object.entries(ETICHETTE_STORICO).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[140px]">
          <label htmlFor="sto-valore" className={LABEL}>
            {kind === "deposito" ? "Deposito" : kind === "categoria" ? "Categoria" : kind === "orario_lavoro" ? "Orario (es. 38:30)" : kind.startsWith("visita") ? "Esito" : "Dettaglio"}
          </label>
          {kind === "deposito" ? (
            <select id="sto-valore" className={TEXT} value={value} onChange={e => setValue(e.target.value)}>
              <option value="">—</option>
              {depositi.map(d => <option key={d.codice} value={d.nome}>{d.nome}</option>)}
            </select>
          ) : kind.startsWith("visita") ? (
            <select id="sto-valore" className={TEXT} value={value} onChange={e => setValue(e.target.value)}>
              <option value="">—</option>
              {(Object.keys(ETICHETTE_ESITO) as EsitoVisita[]).map(k => <option key={k} value={k}>{ETICHETTE_ESITO[k]}</option>)}
            </select>
          ) : (
            <input id="sto-valore" className={TEXT} value={value} onChange={e => setValue(e.target.value)} />
          )}
        </div>
        <div>
          <label htmlFor="sto-data" className={LABEL}>{kind.startsWith("visita") ? "Data visita *" : "Dal *"}</label>
          <input id="sto-data" type="date" className={TEXT} value={eventDate} onChange={e => setEventDate(e.target.value)} />
        </div>
        {conScadenza && (
          <div>
            <label htmlFor="sto-scad" className={LABEL}>Scadenza</label>
            <input id="sto-scad" type="date" className={TEXT} value={expiryDate} onChange={e => setExpiryDate(e.target.value)} />
          </div>
        )}
        <button onClick={() => aggiungi.mutate()} disabled={aggiungi.isPending || !eventDate || (serveValore && !value)}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-violet-600 text-white text-xs hover:bg-violet-500 disabled:opacity-50">
          {aggiungi.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Aggiungi
        </button>
      </div>
      {q.isLoading ? (
        <p className="text-[11px] text-slate-500"><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" /> Carico lo storico…</p>
      ) : righe.length === 0 ? (
        <p className="text-[11px] text-slate-600 italic">Nessuna variazione registrata.</p>
      ) : (
        <ul className="space-y-1">
          {righe.map(h => {
            const futura = !!h.eventDate && h.eventDate > oggi;
            const valore = h.kind.startsWith("visita") && h.value ? ETICHETTE_ESITO[h.value as EsitoVisita] ?? h.value : h.value;
            return (
              <li key={h.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950/40 text-xs">
                <span className="font-mono text-[10px] text-slate-500 w-20 shrink-0">{h.eventDate ? ddmmyyyy(h.eventDate) : "iniziale"}</span>
                <span className="text-[10px] uppercase tracking-wide text-violet-300/70 w-36 shrink-0">{ETICHETTE_STORICO[h.kind] ?? h.kind}</span>
                <span className="text-slate-200 flex-1 min-w-0 truncate">{valore ?? "—"}</span>
                {futura && <span className="text-[10px] px-1.5 rounded bg-sky-500/15 text-sky-300 shrink-0">programmata</span>}
                {h.expiryDate && <span className="text-[10px] text-amber-400/80 shrink-0">scad. {ddmmyyyy(h.expiryDate)}</span>}
                {h.note && <span className="text-[10px] text-slate-600 truncate max-w-[140px]" title={h.note}>{h.note}</span>}
                <button onClick={() => { if (confirm("Cancellare questa riga dello storico?")) cancella.mutate(h.id); }}
                  aria-label="Cancella la riga" className="p-1 rounded text-slate-600 hover:text-rose-400 shrink-0">
                  <Trash2 className="w-3 h-3" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
