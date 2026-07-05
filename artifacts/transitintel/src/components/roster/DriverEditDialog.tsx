/**
 * Anagrafica conducente — crea/modifica un operatore del Roster con i dati
 * completi: anagrafica, lavoro, foto, abilitazioni, documenti/scadenze
 * (patente, CQC, visita ferrovie, visita medico competente) e STORICO
 * (depositi, categoria, visite) con le rispettive date.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, X, Save, Camera, Trash2, Plus, History, UserRound, CalendarDays } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { ABILITAZIONI, type AbilitazioneKey } from "./abilitazioni";
import { MiniGrid } from "./RotazioniRiposi";

export interface RosterDriver {
  id: string; name: string; badge: string | null; isFictitious: boolean;
  matricola: string | null; cognome: string | null; nome: string | null;
  cf: string | null; cellulare: string | null;
  residenzaAnagrafica: string | null; residenzaServizio: string | null;
  oreSettimanali: number | null; categoria: string | null;
  dataNascita: string | null; dataAssunzione: string | null; dataFineServizio: string | null;
  patente: string | null; patenteValidita: string | null;
  cqcNumero: string | null; cqcValidita: string | null;
  visitaMedicaValidita: string | null; note: string | null;
  photoUrl: string | null;
  abilitazioni: string[];
  visitaFerrovieValidita: string | null;
  visitaMedicoCompetenteValidita: string | null;
}

interface HistoryEntry {
  id: string; driverId: string; kind: string; value: string | null;
  eventDate: string | null; expiryDate: string | null; note: string | null; createdAt: string;
}

type Form = Partial<RosterDriver>;

const TEXT = "w-full px-2 py-1.5 text-sm rounded-md bg-slate-950 border border-slate-700 text-slate-100 focus:border-violet-500 focus:outline-none";
const LABEL = "block text-[11px] font-medium text-slate-400 mb-0.5";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className={LABEL}>{label}</span>{children}</label>;
}

const HISTORY_KINDS: Array<{ key: string; label: string }> = [
  { key: "deposito", label: "Deposito" },
  { key: "categoria", label: "Categoria conducente" },
  { key: "orario_lavoro", label: "Orario di lavoro" },
  { key: "visita_ferrovie", label: "Visita ferrovie" },
  { key: "visita_medico_competente", label: "Visita medico competente" },
  { key: "patente", label: "Patente" },
  { key: "cqc", label: "CQC" },
];
const kindLabel = (k: string) => HISTORY_KINDS.find((h) => h.key === k)?.label ?? k;
/** kind che rappresentano una scadenza (data visita + validità). */
const KIND_HAS_EXPIRY = new Set(["visita_ferrovie", "visita_medico_competente", "patente", "cqc"]);
/** kind mostrati nel riepilogo "Situazione attuale". */
const CURRENT_KINDS = ["deposito", "categoria", "orario_lavoro", "visita_ferrovie", "visita_medico_competente"];

/** Ridimensiona un'immagine lato client a max 256px e ritorna un data-URI JPEG. */
async function resizeImage(file: File, max = 256): Promise<string> {
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
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.82);
}

export default function DriverEditDialog({ driver, onClose }: { driver: RosterDriver | null; onClose: () => void }) {
  const qc = useQueryClient();
  // dopo la creazione restiamo aperti in modifica, per inserire subito lo storico
  const [liveDriver, setLiveDriver] = useState<RosterDriver | null>(driver);
  const isEdit = !!liveDriver;
  const [f, setF] = useState<Form>(driver ?? { abilitazioni: [] });
  const set = (k: keyof RosterDriver, v: any) => setF((p) => ({ ...p, [k]: v }));
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const abil = (f.abilitazioni ?? []) as string[];
  const toggleAbil = (k: AbilitazioneKey) =>
    set("abilitazioni", abil.includes(k) ? abil.filter((x) => x !== k) : [...abil, k]);

  const onPickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploadingPhoto(true);
    try { set("photoUrl", await resizeImage(file)); }
    catch { toast.error("Immagine non valida"); }
    finally { setUploadingPhoto(false); }
  };

  const saveMut = useMutation({
    mutationFn: () => {
      // deposito/categoria/orario/visite sono gestiti dallo Storico (sincronizzati
      // dal backend): NON rimandarli qui, o sovrascriverebbero il valore attuale.
      const { categoria, oreSettimanali, residenzaServizio,
        visitaFerrovieValidita, visitaMedicoCompetenteValidita, ...body } = f;
      void categoria; void oreSettimanali; void residenzaServizio;
      void visitaFerrovieValidita; void visitaMedicoCompetenteValidita;
      return isEdit
        ? apiFetch<RosterDriver>(`/api/roster/drivers/${liveDriver!.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : apiFetch<RosterDriver>(`/api/roster/drivers`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["roster"] });
      if (isEdit) { toast.success("Conducente aggiornato"); onClose(); }
      else {
        // creato: resta aperto in modifica per aggiungere subito lo storico
        toast.success("Conducente creato — ora aggiungi lo storico (deposito, categoria, orario, visite)");
        setLiveDriver(saved);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canSave = !!((f.cognome ?? "").trim() || (f.nome ?? "").trim() || (f.name ?? "").trim());
  const initials = ((f.cognome ?? f.name ?? "?").trim().slice(0, 2) || "?").toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col text-slate-100">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800">
          <div className="text-sm font-semibold">{isEdit ? "Modifica conducente" : "Nuovo conducente"}</div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-5">
          {/* Foto + anagrafica */}
          <section className="flex gap-4">
            <div className="shrink-0">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="relative w-24 h-24 rounded-xl overflow-hidden border border-slate-700 bg-slate-950 flex items-center justify-center group"
                title="Carica foto"
              >
                {f.photoUrl
                  ? <img src={f.photoUrl} alt="foto" className="w-full h-full object-cover" />
                  : <span className="text-2xl font-bold text-slate-600">{initials}</span>}
                <span className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  {uploadingPhoto ? <Loader2 className="w-5 h-5 animate-spin text-white" /> : <Camera className="w-5 h-5 text-white" />}
                </span>
              </button>
              {f.photoUrl && (
                <button onClick={() => set("photoUrl", null)} className="mt-1 w-full text-[10px] text-slate-500 hover:text-rose-400 inline-flex items-center justify-center gap-1">
                  <Trash2 className="w-3 h-3" /> Rimuovi
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { onPickPhoto(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
            <div className="flex-1 grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Matricola"><input className={TEXT} value={f.matricola ?? ""} onChange={(e) => set("matricola", e.target.value)} /></Field>
              <Field label="Cognome"><input className={TEXT} value={f.cognome ?? ""} onChange={(e) => set("cognome", e.target.value)} /></Field>
              <Field label="Nome"><input className={TEXT} value={f.nome ?? ""} onChange={(e) => set("nome", e.target.value)} /></Field>
              <Field label="Codice fiscale"><input className={TEXT} value={f.cf ?? ""} onChange={(e) => set("cf", e.target.value)} /></Field>
              <Field label="Data di nascita"><input type="date" className={TEXT} value={f.dataNascita ?? ""} onChange={(e) => set("dataNascita", e.target.value)} /></Field>
              <Field label="Cellulare"><input className={TEXT} value={f.cellulare ?? ""} onChange={(e) => set("cellulare", e.target.value)} /></Field>
            </div>
          </section>

          {/* Abilitazioni */}
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Abilitazioni</h4>
            <div className="flex flex-wrap gap-2">
              {ABILITAZIONI.map((a) => {
                const on = abil.includes(a.key);
                const Icon = a.icon;
                return (
                  <button key={a.key} type="button" onClick={() => toggleAbil(a.key)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                      on ? "border-transparent text-white" : "border-slate-700 text-slate-400 hover:border-slate-500"
                    }`}
                    style={on ? { background: a.color } : undefined}
                  >
                    <Icon className="w-3.5 h-3.5" /> {a.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Residenza & rapporto</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Residenza anagrafica"><input className={TEXT} value={f.residenzaAnagrafica ?? ""} onChange={(e) => set("residenzaAnagrafica", e.target.value)} /></Field>
              <Field label="Data assunzione"><input type="date" className={TEXT} value={f.dataAssunzione ?? ""} onChange={(e) => set("dataAssunzione", e.target.value)} /></Field>
              <Field label="Data fine servizio"><input type="date" className={TEXT} value={f.dataFineServizio ?? ""} onChange={(e) => set("dataFineServizio", e.target.value)} /></Field>
            </div>
            <p className="text-[10px] text-slate-500 mt-1.5">Deposito, categoria conducente e orario di lavoro si gestiscono dallo <b>Storico</b> (in fondo), sempre con la data di inizio.</p>
          </section>

          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2">Patente & CQC</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Field label="Patente (categorie)"><input className={TEXT} value={f.patente ?? ""} onChange={(e) => set("patente", e.target.value)} placeholder="es. D, DE" /></Field>
              <Field label="Patente · validità"><input type="date" className={TEXT} value={f.patenteValidita ?? ""} onChange={(e) => set("patenteValidita", e.target.value)} /></Field>
              <div />
              <Field label="CQC · numero"><input className={TEXT} value={f.cqcNumero ?? ""} onChange={(e) => set("cqcNumero", e.target.value)} /></Field>
              <Field label="CQC · validità"><input type="date" className={TEXT} value={f.cqcValidita ?? ""} onChange={(e) => set("cqcValidita", e.target.value)} /></Field>
            </div>
          </section>

          <Field label="Note"><textarea className={TEXT} rows={2} value={f.note ?? ""} onChange={(e) => set("note", e.target.value)} /></Field>

          {/* Cadenze assegnate (rotazioni riposi) — solo in modifica */}
          {isEdit && <CadenzeSection driverId={liveDriver!.id} />}

          {/* Storico — solo in modifica (serve l'id del conducente) */}
          {isEdit
            ? <HistorySection driverId={liveDriver!.id} />
            : <p className="text-[11px] text-slate-500 italic border-t border-slate-800 pt-3">Salva il conducente per poter inserire lo <b>storico</b> (deposito, categoria, orario di lavoro, visite) con le rispettive date di inizio.</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Chiudi</button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={!canSave || saveMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salva
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Cadenze assegnate (rotazioni riposi) ─── */
interface Cadenza {
  rotazioneId: string; name: string; weeks: number;
  scaglione: number; pattern: (string | null)[][];
}
function CadenzeSection({ driverId }: { driverId: string }) {
  const cadQ = useQuery({
    queryKey: ["roster", "cadenze", driverId],
    queryFn: () => apiFetch<{ cadenze: Cadenza[] }>(`/api/roster/drivers/${driverId}/cadenze`).then((r) => r.cadenze),
  });
  const cadenze = cadQ.data ?? [];
  return (
    <section className="border-t border-slate-800 pt-4">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2 flex items-center gap-1.5">
        <CalendarDays className="w-3.5 h-3.5" /> Cadenze — rotazioni riposi assegnate
      </h4>
      {cadQ.isLoading ? (
        <p className="text-[11px] text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico le cadenze…</p>
      ) : cadenze.length === 0 ? (
        <p className="text-[11px] text-slate-600 italic">Nessuna cadenza assegnata. Si assegna da «Rotazioni → Assegna rotazioni».</p>
      ) : (
        <div className="space-y-2">
          {cadenze.map((c) => (
            <div key={c.rotazioneId} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-semibold text-sm">{c.name}</span>
                <span className="text-[11px] text-slate-500">{c.weeks} settimane</span>
                <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300">parte dallo scaglione {c.scaglione + 1}</span>
              </div>
              <MiniGrid grid={c.pattern} highlight={c.scaglione} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ─── Storico conducente (depositi, categoria, visite) ─── */
function HistorySection({ driverId }: { driverId: string }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState("deposito");
  const [value, setValue] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  const histQ = useQuery({
    queryKey: ["roster", "history", driverId],
    queryFn: () => apiFetch<{ history: HistoryEntry[] }>(`/api/roster/drivers/${driverId}/history`).then((r) => r.history),
  });

  const addMut = useMutation({
    mutationFn: () => apiFetch(`/api/roster/drivers/${driverId}/history`, {
      method: "POST", body: JSON.stringify({ kind, value: value || null, eventDate: eventDate || null, expiryDate: expiryDate || null }),
    }),
    onSuccess: () => { setValue(""); setEventDate(""); setExpiryDate(""); qc.invalidateQueries({ queryKey: ["roster", "history", driverId] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (hid: string) => apiFetch(`/api/roster/history/${hid}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roster", "history", driverId] }),
  });

  const history = histQ.data ?? [];
  const usesExpiry = KIND_HAS_EXPIRY.has(kind);
  const needsValue = kind === "deposito" || kind === "categoria" || kind === "orario_lavoro";
  const valueLabel = kind === "deposito" ? "Deposito" : kind === "categoria" ? "Categoria"
    : kind === "orario_lavoro" ? "Orario (es. 38h / Part-time)" : "Dettaglio (opz.)";
  // situazione attuale = ultima voce per ciascun tipo
  const current: Record<string, HistoryEntry | undefined> = {};
  for (const h of history) if (!current[h.kind]) current[h.kind] = h; // history è già ordinato desc per data

  return (
    <section>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300/80 mb-2 flex items-center gap-1.5">
        <History className="w-3.5 h-3.5" /> Storico — deposito, categoria, orario di lavoro, visite
      </h4>

      {/* Situazione attuale (dall'ultima voce di ogni tipo) */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
        {CURRENT_KINDS.map((k) => {
          const c = current[k];
          const val = c ? (KIND_HAS_EXPIRY.has(k) ? (c.expiryDate ? `scad. ${c.expiryDate}` : c.eventDate) : c.value) : null;
          return (
            <div key={k} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5">
              <div className="text-[9px] uppercase tracking-wide text-slate-500">{kindLabel(k)}</div>
              <div className={`text-xs font-medium ${val ? "text-slate-100" : "text-slate-600"}`}>{val ?? "—"}</div>
              {c?.eventDate && <div className="text-[9px] text-slate-600 font-mono">dal {c.eventDate}</div>}
            </div>
          );
        })}
      </div>

      {/* form aggiunta — la DATA DI INIZIO è obbligatoria */}
      <div className="flex flex-wrap items-end gap-2 mb-3 p-2.5 rounded-lg border border-slate-800 bg-slate-950/50">
        <label className="block"><span className={LABEL}>Tipo</span>
          <select className={TEXT} value={kind} onChange={(e) => setKind(e.target.value)}>
            {HISTORY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </label>
        <label className="block flex-1 min-w-[120px]"><span className={LABEL}>{valueLabel}</span>
          <input className={TEXT} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "deposito" ? "es. Ancona" : ""} />
        </label>
        <label className="block"><span className={LABEL}>Data inizio *</span>
          <input type="date" className={TEXT} value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </label>
        {usesExpiry && (
          <label className="block"><span className={LABEL}>Scadenza</span>
            <input type="date" className={TEXT} value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
          </label>
        )}
        <button
          onClick={() => addMut.mutate()}
          disabled={addMut.isPending || !eventDate || (needsValue && !value)}
          title={!eventDate ? "La data di inizio è obbligatoria" : undefined}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-violet-600 text-white text-xs hover:bg-violet-500 disabled:opacity-50"
        >
          {addMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Aggiungi
        </button>
      </div>

      {/* timeline */}
      {histQ.isLoading ? (
        <p className="text-[11px] text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico lo storico…</p>
      ) : history.length === 0 ? (
        <p className="text-[11px] text-slate-600 italic">Nessun evento registrato.</p>
      ) : (
        <div className="space-y-1">
          {history.map((h) => (
            <div key={h.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950/40 text-xs">
              <span className="font-mono text-[10px] text-slate-500 w-20 shrink-0">{h.eventDate ?? "—"}</span>
              <span className="text-[10px] uppercase tracking-wide text-violet-300/70 w-40 shrink-0">{kindLabel(h.kind)}</span>
              <span className="text-slate-200 flex-1 min-w-0 truncate">{h.value ?? "—"}</span>
              {h.expiryDate && <span className="text-[10px] text-amber-400/80 shrink-0">scad. {h.expiryDate}</span>}
              <button onClick={() => delMut.mutate(h.id)} className="p-1 rounded text-slate-600 hover:text-rose-400 shrink-0"><Trash2 className="w-3 h-3" /></button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-slate-600 mt-1.5 flex items-center gap-1"><UserRound className="w-3 h-3" /> Lo storico si salva subito, indipendentemente dal tasto «Salva».</p>
    </section>
  );
}
