/**
 * Gli allegati della chat di Argos: i file che l'utente aggiunge al prossimo
 * messaggio di una conversazione salvata (graffetta, trascinamento, incolla).
 *
 * Un file si carica subito (Argos lo legge: testo, e le immagini come le vede
 * il modello) e diventa una pillola: in caricamento, pronto, oppure rifiutato
 * col perché (formato, dimensione, dati di persone). Al messaggio partono gli
 * id di quelli pronti; poi la lista si svuota: restano nella conversazione e
 * Argos li ritrova da sé.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, Image as ImageIcon, Loader2, Paperclip, Sheet, X } from "lucide-react";
import {
  caricaAllegato, estensioneDi, FORMATI_ARGOS, MAX_ALLEGATI_TURNO, MAX_ALLEGATO_MB, peso, perchéNonAllegabile, togliAllegato,
} from "@/lib/argos-console";

export interface AllegatoInCorso {
  chiave: string;
  nome: string;
  byte: number;
  stato: "carico" | "pronto" | "errore";
  avanzamento: number;
  id?: string;
  errore?: string;
}

/** Ciò che resta accanto al messaggio inviato (e nella storia). */
export interface AllegatoMessaggio { nome: string; formato: string; byte: number }

const IMMAGINI = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif"]);
const TABELLE = new Set([".xlsx", ".xlsm", ".ods", ".csv", ".tsv"]);

export function useAllegati(conversazione: string | null) {
  const [lista, setLista] = useState<AllegatoInCorso[]>([]);
  const ref = useRef<AllegatoInCorso[]>([]);
  const aggiorna = useCallback((f: (l: AllegatoInCorso[]) => AllegatoInCorso[]) => {
    ref.current = f(ref.current);
    setLista(ref.current);
  }, []);
  const cambia = useCallback((chiave: string, patch: Partial<AllegatoInCorso>) => {
    aggiorna(l => l.map(x => (x.chiave === chiave ? { ...x, ...patch } : x)));
  }, [aggiorna]);

  // un'altra conversazione: si riparte da capo
  useEffect(() => { aggiorna(() => []); }, [conversazione, aggiorna]);

  const aggiungi = useCallback((files: Iterable<File>) => {
    if (!conversazione) return;
    for (const f of files) {
      const chiave = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const attivi = ref.current.filter(x => x.stato !== "errore").length;
      const perché = perchéNonAllegabile(f.name, f.size)
        ?? (attivi >= MAX_ALLEGATI_TURNO ? `al più ${MAX_ALLEGATI_TURNO} file per messaggio` : null);
      aggiorna(l => [...l, { chiave, nome: f.name, byte: f.size, stato: perché ? "errore" : "carico", avanzamento: 0,
                              ...(perché ? { errore: perché } : {}) }]);
      if (perché) continue;
      caricaAllegato(conversazione, f, fr => cambia(chiave, { avanzamento: fr }))
        .then(a => {
          // tolto mentre caricava: lo si toglie anche da Argos
          if (!ref.current.some(x => x.chiave === chiave)) { void togliAllegato(conversazione, a.id).catch(() => {}); return; }
          cambia(chiave, { stato: "pronto", id: a.id, avanzamento: 1 });
        })
        .catch((e: unknown) => cambia(chiave, { stato: "errore", errore: e instanceof Error ? e.message : String(e) }));
    }
  }, [conversazione, aggiorna, cambia]);

  const togli = useCallback((chiave: string) => {
    const voce = ref.current.find(x => x.chiave === chiave);
    aggiorna(l => l.filter(x => x.chiave !== chiave));
    if (voce?.id && conversazione) void togliAllegato(conversazione, voce.id).catch(() => {});
  }, [conversazione, aggiorna]);

  /** Al messaggio: gli id dei pronti e i dati da mostrare; la lista si svuota. */
  const consegna = useCallback((): { ids: string[]; meta: AllegatoMessaggio[] } => {
    const pronti = ref.current.filter(x => x.stato === "pronto" && x.id);
    aggiorna(() => []);
    return {
      ids: pronti.map(x => x.id!),
      meta: pronti.map(x => ({ nome: x.nome, formato: estensioneDi(x.nome).slice(1), byte: x.byte })),
    };
  }, [aggiorna]);

  return {
    lista,
    aggiungi,
    togli,
    consegna,
    pronti: lista.filter(x => x.stato === "pronto").length,
    inCaricamento: lista.some(x => x.stato === "carico"),
  };
}

function Icona({ nome }: { nome: string }) {
  const ext = estensioneDi(nome);
  if (IMMAGINI.has(ext)) return <ImageIcon className="h-3 w-3 shrink-0" aria-hidden />;
  if (TABELLE.has(ext)) return <Sheet className="h-3 w-3 shrink-0" aria-hidden />;
  return <FileText className="h-3 w-3 shrink-0" aria-hidden />;
}

/** Le pillole sopra la casella di scrittura. */
export function PilloleAllegati({ lista, onTogli }: { lista: AllegatoInCorso[]; onTogli: (chiave: string) => void }) {
  if (!lista.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5" aria-label="File allegati al prossimo messaggio">
      {lista.map(a => (
        <span key={a.chiave} title={a.errore ?? `${a.nome} · ${peso(a.byte)}`}
          className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[10.5px] ${
            a.stato === "errore" ? "border-rose-400/40 bg-rose-500/10 text-rose-200"
              : a.stato === "pronto" ? "border-violet-400/40 bg-violet-500/10 text-violet-100"
                : "border-white/10 bg-zinc-900/70 text-zinc-300"}`}>
          {a.stato === "carico" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="in caricamento" />
            : a.stato === "errore" ? <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> : <Icona nome={a.nome} />}
          <span className="max-w-[14rem] truncate font-medium">{a.nome}</span>
          <span className="shrink-0 tabular-nums text-zinc-500">
            {a.stato === "carico" ? `${Math.round(a.avanzamento * 100)}%` : a.stato === "errore" ? "" : peso(a.byte)}
          </span>
          {a.stato === "errore" && <span className="max-w-[18rem] truncate">{a.errore}</span>}
          <button type="button" onClick={() => onTogli(a.chiave)} aria-label={`Togli ${a.nome}`}
            className="shrink-0 rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** La graffetta: apre la scelta dei file. */
export function BottoneAllega({ onFile, disabled }: { onFile: (f: FileList) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => input.current?.click()}
        title={`Allega file (PDF, Word, Excel, PowerPoint, LibreOffice, CSV, immagini…; fino a ${MAX_ALLEGATO_MB} MB, ${MAX_ALLEGATI_TURNO} per messaggio). Niente dati di persone.`}
        aria-label="Allega file"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-400/25 bg-zinc-900/80 text-violet-300 transition hover:border-violet-400/60 hover:bg-violet-500/10 disabled:opacity-40">
        <Paperclip className="h-4 w-4" />
      </button>
      <input ref={input} type="file" multiple hidden accept={FORMATI_ARGOS.join(",")}
        onChange={e => { if (e.target.files?.length) onFile(e.target.files); e.target.value = ""; }} />
    </>
  );
}

/** Gli allegati accanto a un messaggio inviato (anche nella storia). */
export function AllegatiMessaggio({ allegati }: { allegati: AllegatoMessaggio[] }) {
  if (!allegati.length) return null;
  return (
    <div className="mb-1 flex flex-wrap justify-end gap-1">
      {allegati.map((a, i) => (
        <span key={`${a.nome}-${i}`} title={`${a.nome} · ${peso(a.byte)}`}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-violet-400/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-200">
          <Icona nome={a.nome} />
          <span className="max-w-[12rem] truncate">{a.nome}</span>
        </span>
      ))}
    </div>
  );
}
