/**
 * Polimetriche — Area di lavoro (Fares Engine).
 *
 * Flusso:
 *   1. Import ZIP GTFS dedicato (isolato dal feed di Bigliettazione).
 *   2. Estrazione percorsi univoci, categorizzati per LINEA extraurbana
 *      (codice che inizia con una lettera).
 *   3. Area di lavoro: selezioni linea → percorso → direzione; vedi la
 *      polilinea (fermate + distanze) e la POLIMETRICA generata in automatico
 *      come banda di tratte colorate (ogni 6 km una nuova tratta). L'utente
 *      può allargare/restringere le tratte (partizioni contigue, non
 *      sovrapponibili) spostando i confini sulle fermate.
 *   4. Salva → DB delle polimetriche; si procede una linea/percorso alla volta.
 */
import React from "react";
import { getApiBase } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Upload, FileArchive, Trash2, Route as RouteIcon, MapPin, Ruler, Save,
  ChevronRight, ChevronDown, Scissors, ArrowLeftRight, Check, Loader2,
  RefreshCw, ArrowRight, ListChecks, X, Milestone, ArrowUp, ArrowDown, Layers,
  Download, GripHorizontal, Filter,
} from "lucide-react";

const API = () => getApiBase();
const SEGMENT_KM = 6; // ogni 6 km → nuova tratta

/* ── Palette tratte (ordine richiesto: 1→9) ──────────────────── */
const TRATTA_PALETTE = [
  "#38bdf8", // 1 Azzurro
  "#ef4444", // 2 Rosso
  "#22c55e", // 3 Verde
  "#eab308", // 4 Giallo
  "#2563eb", // 5 Blu
  "#8b4513", // 6 Marrone
  "#ec4899", // 7 Rosa
  "#9ca3af", // 8 Grigio
  "#8b5cf6", // 9 Viola
];
const trattaColor = (i: number) => TRATTA_PALETTE[i % TRATTA_PALETTE.length];

/**
 * Banda chilometrica (1-based) di una posizione km: ogni 6 km = una tratta.
 * km 0 → 1 ; (0,6] → 1 ; (6,12] → 2 ; … ; (24,30] → 5 ; (36,42] → 7.
 * Serve a far "saltare" il numero di tratta quando tra due fermate ci sono
 * più di 6 km (es. km30 = fine tratta 5, km40 = tratta 7, non 6).
 */
const bandOf = (km: number): number => (km <= 1e-6 ? 1 : Math.ceil(km / SEGMENT_KM));

/* ── Tipi ─────────────────────────────────────────────────────── */
interface ImportSummary {
  id: string; filename: string; agencyName: string | null;
  lineCount: number; percorsoCount: number; createdAt: string;
}
interface PercorsoMeta {
  variantId: string; routeId: string; directionId: number | null;
  tripCount: number;
  firstStopName: string; lastStopName: string; stopCount: number;
  totalKm: number; distanceMethod: "shape" | "haversine";
  savedAB: boolean; savedBA: boolean;
}
interface LineMeta { lineCode: string; lineName: string; routeIds: string[]; percorsi: PercorsoMeta[]; }
interface ImportTree {
  id: string; filename: string; agencyName: string | null;
  lineCount: number; percorsoCount: number; lines: LineMeta[];
}
interface PStop { stopId: string; stopName: string; lat: number; lon: number; km: number; distPrev: number; }
interface PercorsoDetail {
  lineCode: string; lineName: string;
  variantId: string; routeId: string; routeIds: string[];
  directionId: number | null;
  tripCount: number; firstStopName: string; lastStopName: string;
  stopCount: number; totalKm: number; distanceMethod: "shape" | "haversine";
  stops: PStop[]; shape: [number, number][] | null;
}

const dirLabel = (d: number | null): string => d === 0 ? "Andata" : d === 1 ? "Ritorno" : "—";
interface Tratta {
  index: number; number: number; label: string; color: string; nodeName: string;
  fromStopIdx: number; toStopIdx: number;
  fromStopName: string; toStopName: string;
  fromKm: number; toKm: number; km: number; stopCount: number;
}

const fmtKm = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/* ── Genera confini automatici: nuova tratta quando cambia la banda 6 km ─── */
function autoBoundaries(stops: PStop[]): number[] {
  const b: number[] = [];
  if (stops.length < 2) return b;
  for (let i = 1; i < stops.length; i++) {
    // confine alla prima fermata la cui banda 6km differisce dalla precedente
    if (bandOf(stops[i].km) !== bandOf(stops[i - 1].km)) b.push(i);
  }
  return b;
}

/* ── Costruisce le tratte a partire dai confini ─────────────────── */
function buildTratte(stops: PStop[], boundaries: number[], nodeNames?: Record<number, string>): Tratta[] {
  const bounds = [...new Set(boundaries)].filter(i => i > 0 && i < stops.length).sort((a, b) => a - b);
  const starts = [0, ...bounds];
  const tratte: Tratta[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : stops.length - 1;
    const fromKm = stops[from].km;
    const toKm = stops[to].km;
    // numero di tratta = banda 6km della fermata d'inizio (può saltare su gap >6km)
    const number = bandOf(fromKm);
    tratte.push({
      index: k,
      number,
      label: `Tratta ${number}`,
      color: trattaColor(number - 1),
      nodeName: nodeNames?.[k] ?? "",
      fromStopIdx: from,
      toStopIdx: to,
      fromStopName: stops[from].stopName,
      toStopName: stops[to].stopName,
      fromKm, toKm, km: Math.round((toKm - fromKm) * 100) / 100,
      stopCount: to - from + 1,
    });
  }
  return tratte;
}

/** tratta-index per ogni fermata (la fermata i appartiene alla tratta che la contiene). */
function stopTrattaMap(stops: PStop[], boundaries: number[]): number[] {
  const bounds = [...new Set(boundaries)].filter(i => i > 0 && i < stops.length).sort((a, b) => a - b);
  const map: number[] = [];
  let t = 0, bi = 0;
  for (let i = 0; i < stops.length; i++) {
    if (bi < bounds.length && i === bounds[bi]) { t++; bi++; }
    map.push(t);
  }
  return map;
}

/* ════════════════════════════════════════════════════════════════
 *  PAGINA
 * ════════════════════════════════════════════════════════════════ */
export default function FaresPolimetrichePage() {
  const { toast } = useToast();
  const [imports, setImports] = React.useState<ImportSummary[]>([]);
  const [importId, setImportId] = React.useState<string | null>(null);
  const [tree, setTree] = React.useState<ImportTree | null>(null);
  const [loadingTree, setLoadingTree] = React.useState(false);

  const [sel, setSel] = React.useState<{ lineCode: string; routeId: string; variantId: string } | null>(null);
  const [detail, setDetail] = React.useState<PercorsoDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = React.useState(false);

  // larghezza ridimensionabile della sidebar linee
  const [railWidth, setRailWidth] = React.useState(300);
  const startRailDrag = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(640, Math.max(200, startW + (ev.clientX - startX)));
      setRailWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [railWidth]);

  const refetchImports = React.useCallback(() => {
    fetch(`${API()}/api/fares/polimetriche/imports`)
      .then(r => r.ok ? r.json() : [])
      .then((d) => setImports(Array.isArray(d) ? d : []))
      .catch(() => setImports([]));
  }, []);
  React.useEffect(() => { refetchImports(); }, [refetchImports]);

  const loadTree = React.useCallback((id: string) => {
    setLoadingTree(true);
    fetch(`${API()}/api/fares/polimetriche/imports/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then((d: ImportTree) => setTree(d))
      .catch(() => { toast({ title: "Errore", description: "Import non caricabile", variant: "destructive" }); setTree(null); })
      .finally(() => setLoadingTree(false));
  }, [toast]);

  React.useEffect(() => {
    if (importId) loadTree(importId); else { setTree(null); setSel(null); setDetail(null); }
  }, [importId, loadTree]);

  const loadDetail = React.useCallback((routeId: string, variantId: string) => {
    if (!importId) return;
    setLoadingDetail(true);
    fetch(`${API()}/api/fares/polimetriche/imports/${importId}/percorso?routeId=${encodeURIComponent(routeId)}&variantId=${encodeURIComponent(variantId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then((d: PercorsoDetail) => setDetail(d))
      .catch(() => { toast({ title: "Errore", description: "Percorso non caricabile", variant: "destructive" }); setDetail(null); })
      .finally(() => setLoadingDetail(false));
  }, [importId, toast]);

  React.useEffect(() => {
    if (sel) loadDetail(sel.routeId, sel.variantId); else setDetail(null);
  }, [sel, loadDetail]);

  // flat list dei percorsi per "procedi una ad una"
  const flatPercorsi = React.useMemo(() => {
    if (!tree) return [] as { lineCode: string; routeId: string; variantId: string; meta: PercorsoMeta }[];
    const out: { lineCode: string; routeId: string; variantId: string; meta: PercorsoMeta }[] = [];
    for (const l of tree.lines) for (const p of l.percorsi) out.push({ lineCode: l.lineCode, routeId: p.routeId, variantId: p.variantId, meta: p });
    return out;
  }, [tree]);

  const savedCount = flatPercorsi.filter(p => p.meta.savedAB || p.meta.savedBA).length;

  const gotoNext = React.useCallback(() => {
    if (!sel || flatPercorsi.length === 0) return;
    const idx = flatPercorsi.findIndex(p => p.routeId === sel.routeId && p.variantId === sel.variantId);
    // prossimo non salvato dopo l'indice corrente, altrimenti il successivo qualsiasi
    let next = flatPercorsi.slice(idx + 1).find(p => !p.meta.savedAB && !p.meta.savedBA)
      || flatPercorsi.find(p => !p.meta.savedAB && !p.meta.savedBA)
      || flatPercorsi[(idx + 1) % flatPercorsi.length];
    if (next) setSel({ lineCode: next.lineCode, routeId: next.routeId, variantId: next.variantId });
  }, [sel, flatPercorsi]);

  // elimina (pulisci) percorsi dall'elenco — aggiornamento OTTIMISTICO:
  // non ricarico l'albero (evita lo spinner che smonta la rail e perde la
  // posizione/scroll), rimuovo localmente e persisto in background.
  const deletePercorsi = React.useCallback((items: { routeId: string; variantId: string }[]) => {
    if (!importId || items.length === 0) return;
    const keys = new Set(items.map(i => `${i.routeId}::${i.variantId}`));
    setTree(prev => prev ? {
      ...prev,
      lines: prev.lines
        .map(l => ({ ...l, percorsi: l.percorsi.filter(p => !keys.has(`${p.routeId}::${p.variantId}`)) }))
        .filter(l => l.percorsi.length > 0),
    } : prev);
    if (sel && keys.has(`${sel.routeId}::${sel.variantId}`)) { setSel(null); setDetail(null); }
    fetch(`${API()}/api/fares/polimetriche/imports/${importId}/percorsi/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
    })
      .then(r => { if (!r.ok) throw new Error(); })
      .catch(() => { toast({ title: "Errore", description: "Eliminazione non riuscita, ricarico", variant: "destructive" }); loadTree(importId); });
  }, [importId, sel, loadTree, toast]);
  const deletePercorso = React.useCallback((routeId: string, variantId: string) =>
    deletePercorsi([{ routeId, variantId }]), [deletePercorsi]);

  // export "a gradoni" (matrice triangolare) di tutte le polimetriche salvate
  const [exporting, setExporting] = React.useState(false);
  const exportGradoni = React.useCallback(async () => {
    if (!importId) return;
    setExporting(true);
    try {
      const rows = await fetch(`${API()}/api/fares/polimetriche/saved?importId=${importId}`).then(r => r.ok ? r.json() : []);
      if (!Array.isArray(rows) || rows.length === 0) {
        toast({ title: "Nessuna polimetrica", description: "Salva almeno una polimetrica prima di esportare.", variant: "destructive" });
        return;
      }
      openGradoniExport(rows, tree?.agencyName ?? null, tree?.filename ?? "");
    } catch {
      toast({ title: "Errore", description: "Export non riuscito", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }, [importId, tree, toast]);

  /* ── Schermata import ──────────────────────────────────────── */
  if (!importId) {
    return (
      <ImportScreen
        imports={imports}
        onImported={(id) => { refetchImports(); setImportId(id); }}
        onSelect={setImportId}
        onDelete={(id) => {
          fetch(`${API()}/api/fares/polimetriche/imports/${id}`, { method: "DELETE" })
            .then(() => refetchImports());
        }}
        toast={toast}
      />
    );
  }

  /* ── Workspace ─────────────────────────────────────────────── */
  return (
    <div className="h-full flex flex-col text-emerald-50">
      {/* Header import */}
      <div className="flex items-center gap-3 px-1 pb-3 mb-3 border-b border-emerald-900/40">
        <Milestone className="w-5 h-5 text-emerald-400" />
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-emerald-200 leading-tight">Polimetriche — Area di lavoro</h1>
          <p className="text-[11px] text-emerald-400/60 font-mono truncate">
            {tree?.agencyName ? `${tree.agencyName} · ` : ""}{tree?.filename} · {tree?.lineCount ?? 0} linee · {tree?.percorsoCount ?? 0} percorsi
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-emerald-300/70 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <ListChecks className="w-3.5 h-3.5" /> {savedCount}/{flatPercorsi.length} salvati
          </span>
          <button
            onClick={exportGradoni}
            disabled={exporting || savedCount === 0}
            title="Esporta tutte le polimetriche salvate come matrice triangolare a gradoni"
            className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40 transition-colors flex items-center gap-1.5"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Esporta a gradoni
          </button>
          <button
            onClick={() => { setImportId(null); setSel(null); setDetail(null); }}
            className="text-[12px] px-3 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 transition-colors"
          >
            Cambia import
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Rail linee (ridimensionabile) */}
        <div style={{ width: railWidth }} className="shrink-0 min-h-0 rounded-xl border border-emerald-900/40 bg-emerald-950/30 overflow-hidden flex flex-col">
          <div className="px-3 py-2 border-b border-emerald-900/40 text-[11px] font-semibold uppercase tracking-wider text-emerald-400/60 flex items-center gap-2">
            <Layers className="w-3.5 h-3.5" /> Linee extraurbane
          </div>
          {loadingTree ? (
            <div className="flex-1 flex items-center justify-center text-emerald-400/50"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : (
            <LinesRail lines={tree?.lines || []} sel={sel} onSelect={setSel} onDeletePercorso={deletePercorso} onDeleteMany={deletePercorsi} />
          )}
        </div>

        {/* Splitter trascinabile */}
        <div
          onPointerDown={startRailDrag}
          title="Trascina per ridimensionare la sidebar"
          className="group/split w-2 mx-1 shrink-0 cursor-col-resize rounded flex items-center justify-center hover:bg-emerald-500/15 transition-colors"
        >
          <span className="w-[3px] h-10 rounded-full bg-emerald-800/50 group-hover/split:bg-emerald-400/60 transition-colors" />
        </div>

        {/* Workspace percorso */}
        <div className="flex-1 min-w-0 min-h-0 rounded-xl border border-emerald-900/40 bg-emerald-950/20 overflow-hidden">
          {!sel ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-emerald-400/50 gap-3 px-6">
              <RouteIcon className="w-10 h-10 opacity-40" />
              <p className="text-sm">Seleziona una linea e un percorso a sinistra<br />per generare e modificare la polimetrica.</p>
            </div>
          ) : loadingDetail || !detail ? (
            <div className="h-full flex items-center justify-center text-emerald-400/50"><Loader2 className="w-6 h-6 animate-spin" /></div>
          ) : (
            <Workspace
              key={`${detail.routeId}:${detail.variantId}`}
              importId={importId}
              detail={detail}
              savedAB={sel ? (tree?.lines.flatMap(l => l.percorsi).find(p => p.routeId === sel.routeId && p.variantId === sel.variantId)?.savedAB ?? false) : false}
              savedBA={sel ? (tree?.lines.flatMap(l => l.percorsi).find(p => p.routeId === sel.routeId && p.variantId === sel.variantId)?.savedBA ?? false) : false}
              onSaved={() => { if (importId) loadTree(importId); }}
              onNext={gotoNext}
              toast={toast}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
 *  Schermata import
 * ════════════════════════════════════════════════════════════════ */
function ImportScreen({ imports, onImported, onSelect, onDelete, toast }: {
  imports: ImportSummary[];
  onImported: (id: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [uploading, setUploading] = React.useState(false);
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const doUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast({ title: "File non valido", description: "Carica uno ZIP GTFS.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(`${API()}/api/fares/polimetriche/import`, { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || "Import fallito");
      toast({ title: "Import completato", description: `${d.lineCount} linee extraurbane · ${d.percorsoCount} percorsi` });
      onImported(d.importId);
    } catch (e: any) {
      toast({ title: "Errore import", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="h-full max-w-3xl mx-auto flex flex-col gap-6 py-4">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 mb-3">
          <Milestone className="w-7 h-7 text-emerald-400" />
        </div>
        <h1 className="text-2xl font-black text-emerald-200">Polimetriche</h1>
        <p className="text-sm text-emerald-300/60 mt-1 max-w-md mx-auto">
          Area di lavoro per costruire le polimetriche a tratte. Inizia importando uno ZIP GTFS:
          il sistema estrae tutti i percorsi delle linee extraurbane.
        </p>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) doUpload(f); }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-all ${
          drag ? "border-emerald-400 bg-emerald-500/10" : "border-emerald-700/50 bg-emerald-950/30 hover:border-emerald-600 hover:bg-emerald-500/5"
        }`}
      >
        <input ref={inputRef} type="file" accept=".zip" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = ""; }} />
        {uploading ? (
          <div className="flex flex-col items-center gap-2 text-emerald-300">
            <Loader2 className="w-8 h-8 animate-spin" />
            <span className="text-sm">Estrazione percorsi in corso…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-emerald-300/80">
            <Upload className="w-8 h-8 text-emerald-400" />
            <span className="text-sm font-medium">Trascina qui lo ZIP GTFS o clicca per selezionarlo</span>
            <span className="text-[11px] text-emerald-400/50">Step 1 · max 150 MB · vengono tenute solo le linee con codice che inizia per lettera</span>
          </div>
        )}
      </div>

      {/* Import esistenti */}
      {imports.length > 0 && (
        <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/30 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-emerald-900/40 text-[11px] font-semibold uppercase tracking-wider text-emerald-400/60">
            Import esistenti
          </div>
          <div className="divide-y divide-emerald-900/30">
            {imports.map((im) => (
              <div key={im.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-emerald-500/5 transition-colors">
                <FileArchive className="w-4 h-4 text-emerald-500/60 shrink-0" />
                <button onClick={() => onSelect(im.id)} className="flex-1 min-w-0 text-left">
                  <p className="text-sm text-emerald-100 truncate">{im.filename}</p>
                  <p className="text-[11px] text-emerald-400/50 font-mono">
                    {im.agencyName ? `${im.agencyName} · ` : ""}{im.lineCount} linee · {im.percorsoCount} percorsi · {new Date(im.createdAt).toLocaleString("it-IT")}
                  </p>
                </button>
                <button onClick={() => onSelect(im.id)}
                  className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 transition-colors flex items-center gap-1">
                  Apri <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => onDelete(im.id)} title="Elimina import"
                  className="p-1.5 rounded-lg text-emerald-400/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
 *  Rail linee → percorsi
 * ════════════════════════════════════════════════════════════════ */
function LinesRail({ lines, sel, onSelect, onDeletePercorso, onDeleteMany }: {
  lines: LineMeta[];
  sel: { lineCode: string; routeId: string; variantId: string } | null;
  onSelect: (s: { lineCode: string; routeId: string; variantId: string }) => void;
  onDeletePercorso: (routeId: string, variantId: string) => void;
  onDeleteMany: (items: { routeId: string; variantId: string }[]) => void;
}) {
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(sel ? [sel.lineCode] : []));
  React.useEffect(() => { if (sel) setOpen(prev => new Set(prev).add(sel.lineCode)); }, [sel]);
  const toggle = (code: string) => setOpen(prev => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n; });

  const [dirFilter, setDirFilter] = React.useState<"all" | "0" | "1">("all");
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null); // `${routeId}:${variantId}`
  const [marked, setMarked] = React.useState<Set<string>>(new Set()); // multi-selezione `${routeId}::${variantId}`
  const [confirmBulk, setConfirmBulk] = React.useState(false);
  const mk = (routeId: string, variantId: string) => `${routeId}::${variantId}`;
  const toggleMark = (routeId: string, variantId: string) =>
    setMarked(prev => { const n = new Set(prev); const k = mk(routeId, variantId); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const bulkDelete = () => {
    if (!confirmBulk) { setConfirmBulk(true); setTimeout(() => setConfirmBulk(false), 3000); return; }
    const items = [...marked].map(k => { const [routeId, variantId] = k.split("::"); return { routeId, variantId }; });
    onDeleteMany(items);
    setMarked(new Set());
    setConfirmBulk(false);
  };

  // applica filtro direzione
  const filteredLines = React.useMemo(() => {
    if (dirFilter === "all") return lines;
    const want = parseInt(dirFilter, 10);
    return lines
      .map(l => ({ ...l, percorsi: l.percorsi.filter(p => p.directionId === want) }))
      .filter(l => l.percorsi.length > 0);
  }, [lines, dirFilter]);

  const FILTERS: { key: "all" | "0" | "1"; label: string }[] = [
    { key: "all", label: "Tutti" }, { key: "0", label: "Andata" }, { key: "1", label: "Ritorno" },
  ];

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {/* Filtro direzione */}
      <div className="px-2 pb-2 flex items-center gap-1">
        <Filter className="w-3 h-3 text-emerald-400/40 shrink-0 ml-1 mr-0.5" />
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setDirFilter(f.key)}
            className={`text-[10px] px-2 py-1 rounded-md transition-colors ${
              dirFilter === f.key ? "bg-emerald-500/25 text-emerald-100" : "text-emerald-400/60 hover:bg-emerald-500/10"
            }`}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Barra multi-selezione */}
      {marked.size > 0 && (
        <div className="mx-2 mb-2 px-2 py-1.5 rounded-lg bg-emerald-900/40 border border-emerald-700/50 flex items-center gap-2">
          <span className="text-[11px] text-emerald-200 flex-1">{marked.size} selezionati</span>
          <button onClick={bulkDelete}
            className={`text-[11px] px-2 py-1 rounded flex items-center gap-1 transition-colors ${
              confirmBulk ? "bg-red-500/30 text-red-200" : "bg-red-500/15 text-red-300 hover:bg-red-500/25"
            }`}>
            <Trash2 className="w-3 h-3" /> {confirmBulk ? "Conferma" : "Elimina"}
          </button>
          <button onClick={() => { setMarked(new Set()); setConfirmBulk(false); }}
            className="text-[11px] px-2 py-1 rounded text-emerald-400/70 hover:bg-emerald-500/10">Annulla</button>
        </div>
      )}

      {filteredLines.map((l) => {
        const isOpen = open.has(l.lineCode);
        const lineSaved = l.percorsi.filter(p => p.savedAB || p.savedBA).length;
        return (
          <div key={l.lineCode}>
            <button onClick={() => toggle(l.lineCode)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-emerald-500/5 transition-colors text-left">
              <ChevronDown className={`w-3.5 h-3.5 text-emerald-400/50 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
              <span className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-1.5 rounded bg-emerald-500/15 text-emerald-200 text-[12px] font-bold shrink-0">
                {l.lineCode}
              </span>
              <span className="flex-1 min-w-0 text-[12px] text-emerald-200/80 truncate">{l.lineName || "—"}</span>
              <span className="text-[10px] text-emerald-400/40 font-mono shrink-0">{lineSaved}/{l.percorsi.length}</span>
            </button>
            {isOpen && (
              <div className="pl-7 pr-2 pb-1 space-y-0.5">
                {l.percorsi.map((p) => {
                  const active = sel?.routeId === p.routeId && sel?.variantId === p.variantId;
                  const done = p.savedAB || p.savedBA;
                  const key = `${p.routeId}:${p.variantId}`;
                  const confirming = confirmDel === key;
                  return (
                    <div key={key}
                      className={`group/p flex items-start gap-1 px-2 py-1.5 rounded-lg transition-colors ${
                        active ? "bg-emerald-500/20 text-emerald-100" : "text-emerald-300/70 hover:bg-emerald-500/8"
                      }`}>
                      <input
                        type="checkbox"
                        checked={marked.has(mk(p.routeId, p.variantId))}
                        onChange={(e) => { e.stopPropagation(); toggleMark(p.routeId, p.variantId); }}
                        title="Seleziona per eliminazione multipla"
                        className="mt-1 shrink-0 accent-emerald-500 cursor-pointer"
                      />
                      <button onClick={() => onSelect({ lineCode: l.lineCode, routeId: p.routeId, variantId: p.variantId })}
                        className="flex items-start gap-2 flex-1 min-w-0 text-left">
                        {done
                          ? <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                          : <RouteIcon className="w-3.5 h-3.5 text-emerald-500/40 shrink-0 mt-0.5" />}
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] leading-tight truncate">{p.firstStopName} → {p.lastStopName}</p>
                          <p className="text-[9px] text-emerald-400/40 font-mono flex items-center gap-1">
                            {p.directionId != null && (
                              <span className="px-1 rounded bg-emerald-500/15 text-emerald-300/80">{dirLabel(p.directionId)}</span>
                            )}
                            {p.stopCount} ferm · {fmtKm(p.totalKm)} km · {p.tripCount} corse
                          </p>
                        </div>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirming) { onDeletePercorso(p.routeId, p.variantId); setConfirmDel(null); }
                          else { setConfirmDel(key); setTimeout(() => setConfirmDel(prev => prev === key ? null : prev), 3000); }
                        }}
                        title={confirming ? "Conferma eliminazione" : "Elimina percorso dall'elenco"}
                        className={`shrink-0 p-1 rounded transition-all ${
                          confirming
                            ? "text-red-300 bg-red-500/25 opacity-100"
                            : "text-emerald-400/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover/p:opacity-100"
                        }`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {filteredLines.length === 0 && (
        <p className="px-3 py-4 text-[12px] text-emerald-400/40 italic">
          {lines.length === 0 ? "Nessuna linea extraurbana in questo import." : "Nessun percorso per il filtro selezionato."}
        </p>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
 *  Workspace di un percorso
 * ════════════════════════════════════════════════════════════════ */
function Workspace({ importId, detail, savedAB, savedBA, onSaved, onNext, toast }: {
  importId: string;
  detail: PercorsoDetail;
  savedAB: boolean; savedBA: boolean;
  onSaved: () => void;
  onNext: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [direction, setDirection] = React.useState<"AB" | "BA">("AB");

  // fermate nell'orientamento corrente (BA = invertito con km ricalcolato dall'altro capo)
  const stops = React.useMemo<PStop[]>(() => {
    if (direction === "AB") return detail.stops;
    const total = detail.totalKm;
    const rev = [...detail.stops].reverse();
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    return rev.map((s, i) => ({
      ...s,
      km: r3(total - s.km),
      // distPrev = km nuovo[i] - km nuovo[i-1] = rev[i-1].km - rev[i].km
      distPrev: i === 0 ? 0 : r3(rev[i - 1].km - rev[i].km),
    }));
  }, [detail, direction]);

  // boundaries: ricalcola auto al cambio percorso/direzione (carica salvato se presente)
  const [boundaries, setBoundaries] = React.useState<number[]>([]);
  const [nodeNames, setNodeNames] = React.useState<Record<number, string>>({}); // nodo tariffario per tratta (per indice)
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [loadedSaved, setLoadedSaved] = React.useState(false);

  React.useEffect(() => {
    // prova a caricare una polimetrica salvata per questo percorso+direzione
    let cancelled = false;
    setLoadedSaved(false);
    fetch(`${API()}/api/fares/polimetriche/saved?importId=${importId}`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: any[]) => {
        if (cancelled) return;
        const match = rows.find(x => x.routeId === detail.routeId && x.variantId === detail.variantId && x.direction === direction);
        if (match && Array.isArray(match.boundaries)) {
          setBoundaries(match.boundaries.filter((i: number) => i > 0 && i < stops.length));
          setName(match.name || "");
          // ripristina i nomi-nodo dalle tratte salvate (per indice)
          const nn: Record<number, string> = {};
          if (Array.isArray(match.tratte)) for (const t of match.tratte) if (t?.nodeName) nn[t.index] = t.nodeName;
          setNodeNames(nn);
        } else {
          setBoundaries(autoBoundaries(stops));
          setName("");
          setNodeNames({});
        }
        setLoadedSaved(true);
      })
      .catch(() => { if (!cancelled) { setBoundaries(autoBoundaries(stops)); setNodeNames({}); setLoadedSaved(true); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId, detail.routeId, detail.variantId, direction]);

  const tratte = React.useMemo(() => buildTratte(stops, boundaries, nodeNames), [stops, boundaries, nodeNames]);
  const trattaOf = React.useMemo(() => stopTrattaMap(stops, boundaries), [stops, boundaries]);
  // numero (banda 6km) per indice-gruppo: usato per colore/etichetta delle tratte
  const groupNumbers = React.useMemo(() => {
    const arr: number[] = [];
    for (const t of tratte) arr[t.index] = t.number;
    return arr;
  }, [tratte]);

  const moveBoundary = (i: number, dir: -1 | 1) => {
    const ni = i + dir;
    if (ni <= 0 || ni >= stops.length) return;
    setBoundaries(prev => {
      if (prev.includes(ni)) return prev; // non collassare due confini
      return prev.map(x => x === i ? ni : x).sort((a, b) => a - b);
    });
  };

  const save = async (advance: boolean) => {
    setSaving(true);
    try {
      const stopsPayload = stops.map((s, i) => ({ ...s, tratta: trattaOf[i] }));
      const body = {
        importId, routeId: detail.routeId, lineCode: detail.lineCode, lineName: detail.lineName,
        variantId: detail.variantId, direction,
        name: name || `${detail.lineCode} · ${stops[0].stopName} → ${stops[stops.length - 1].stopName}`,
        totalKm: stops[stops.length - 1]?.km ?? 0,
        boundaries, tratte, stops: stopsPayload,
      };
      const r = await fetch(`${API()}/api/fares/polimetriche/saved`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json())?.error || "Salvataggio fallito");
      toast({ title: "Polimetrica salvata", description: `${tratte.length} tratte · ${fmtKm(body.totalKm)} km` });
      onSaved();
      if (advance) onNext();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const savedThis = direction === "AB" ? savedAB : savedBA;

  return (
    <div className="h-full flex flex-col">
      {/* Header percorso */}
      <div className="px-4 py-3 border-b border-emerald-900/40 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center justify-center h-7 px-2 rounded bg-emerald-500/20 text-emerald-100 text-sm font-bold">{detail.lineCode}</span>
        <div className="min-w-0">
          <p className="text-sm text-emerald-100 font-medium leading-tight truncate">
            {stops[0]?.stopName} <ArrowRight className="w-3.5 h-3.5 inline mx-0.5 text-emerald-400/60" /> {stops[stops.length - 1]?.stopName}
          </p>
          <p className="text-[10px] text-emerald-400/50 font-mono flex items-center gap-1.5 flex-wrap">
            {detail.directionId != null && (
              <span className="px-1 rounded bg-emerald-500/15 text-emerald-300/80">verso GTFS: {dirLabel(detail.directionId)}</span>
            )}
            {detail.stopCount} fermate · {fmtKm(stops[stops.length - 1]?.km ?? 0)} km · {detail.tripCount} corse · km via {detail.distanceMethod === "shape" ? "shape GTFS" : "haversine"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Orientamento polimetrica: stesso percorso, diretto o invertito */}
          <button onClick={() => setDirection(d => d === "AB" ? "BA" : "AB")}
            title="Costruisci la polimetrica per lo stesso percorso in senso diretto (Andata) o invertito (Ritorno). Si salvano separatamente."
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-200 hover:bg-emerald-500/10 transition-colors">
            <ArrowLeftRight className="w-3.5 h-3.5" /> {direction === "AB" ? "Andata (diretto)" : "Ritorno (invertito)"}
          </button>
          {savedThis && (
            <span className="text-[11px] px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
              <Check className="w-3 h-3" /> salvata
            </span>
          )}
        </div>
      </div>

      {/* Toolbar tratte */}
      <div className="px-4 py-2 border-b border-emerald-900/30 flex flex-wrap items-center gap-2 bg-emerald-950/30">
        <span className="text-[11px] text-emerald-400/60 font-semibold uppercase tracking-wider flex items-center gap-1.5">
          <Ruler className="w-3.5 h-3.5" /> Polimetrica · {tratte.length} tratte
        </span>
        <button onClick={() => { setBoundaries(autoBoundaries(stops)); setNodeNames({}); }}
          className="text-[11px] px-2 py-1 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 flex items-center gap-1">
          <RefreshCw className="w-3 h-3" /> Rigenera ogni {SEGMENT_KM} km
        </button>
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Nome polimetrica (opzionale)"
          className="text-[12px] px-2.5 py-1.5 rounded-lg bg-emerald-950/50 border border-emerald-800/50 text-emerald-100 placeholder:text-emerald-500/40 focus:outline-none focus:border-emerald-500/60 w-56"
        />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => save(false)} disabled={saving}
            className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50 flex items-center gap-1.5 transition-colors">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salva
          </button>
          <button onClick={() => save(true)} disabled={saving}
            className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-500 text-emerald-950 font-semibold hover:bg-emerald-400 disabled:opacity-50 flex items-center gap-1.5 transition-colors">
            Salva e prossimo <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Corpo: tratte summary + preview + strip */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-0">
        {/* Strip diagram (polilinea + banda tratte editabile) */}
        <div className="min-h-0 overflow-y-auto p-4">
          {!loadedSaved ? (
            <div className="flex items-center justify-center py-10 text-emerald-400/40"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : (
            <StripDiagram stops={stops} boundaries={boundaries} trattaOf={trattaOf}
              groupNumbers={groupNumbers} nodeNames={nodeNames} onSetBoundaries={setBoundaries}
              onSetNodeName={(idx, val) => setNodeNames(prev => ({ ...prev, [idx]: val }))} />
          )}
        </div>

        {/* Pannello laterale: preview geografica + elenco tratte */}
        <div className="min-h-0 overflow-y-auto border-l border-emerald-900/40 bg-emerald-950/20 p-3 space-y-3">
          <RoutePreviewSvg stops={stops} shape={direction === "AB" ? detail.shape : (detail.shape ? [...detail.shape].reverse() : null)} trattaOf={trattaOf} groupNumbers={groupNumbers} />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/50 mb-1.5">Tratte</p>
            <div className="space-y-1.5">
              {tratte.map((t) => (
                <div key={t.index} className="px-2 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-900/40">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: t.color }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-emerald-100 font-medium leading-tight">{t.label}</p>
                      <p className="text-[9px] text-emerald-400/50 font-mono truncate">
                        {fmtKm(t.km)} km · {t.stopCount} ferm · {fmtKm(t.fromKm)}→{fmtKm(t.toKm)}
                      </p>
                    </div>
                    {t.index > 0 && (
                      <div className="flex flex-col shrink-0">
                        <button title="Sposta confine indietro" onClick={() => moveBoundary(t.fromStopIdx, -1)}
                          className="p-0.5 text-emerald-400/50 hover:text-emerald-200"><ArrowUp className="w-3 h-3" /></button>
                        <button title="Sposta confine avanti" onClick={() => moveBoundary(t.fromStopIdx, 1)}
                          className="p-0.5 text-emerald-400/50 hover:text-emerald-200"><ArrowDown className="w-3 h-3" /></button>
                      </div>
                    )}
                  </div>
                  {/* Nodo tariffario (modificabile nello strip a sinistra) */}
                  {nodeNames[t.index] && (
                    <p className="mt-1 text-[10px] text-emerald-300/80 truncate" style={{ borderLeft: `3px solid ${t.color}`, paddingLeft: 6 }}>
                      🏷 {nodeNames[t.index]}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
 *  Strip diagram — elenco fermate con banda tratte e confini editabili
 * ════════════════════════════════════════════════════════════════ */
function StripDiagram({ stops, boundaries, trattaOf, groupNumbers, nodeNames, onSetBoundaries, onSetNodeName }: {
  stops: PStop[]; boundaries: number[]; trattaOf: number[];
  groupNumbers: number[];
  nodeNames: Record<number, string>;
  onSetBoundaries: (b: number[]) => void;
  onSetNodeName: (idx: number, val: string) => void;
}) {
  const numOf = (gi: number) => groupNumbers[gi] ?? gi + 1;
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const dragRef = React.useRef<number | null>(null);          // confine in trascinamento (valore corrente)
  const boundsRef = React.useRef<number[]>(boundaries);       // copia autorevole durante il drag
  const [activeDrag, setActiveDrag] = React.useState<number | null>(null);
  // mantieni boundsRef allineato ai props quando NON stai trascinando
  if (dragRef.current == null) boundsRef.current = boundaries;

  const createBoundary = (i: number) => {
    if (i <= 0 || i >= stops.length) return;
    onSetBoundaries([...new Set([...boundaries, i])].sort((a, b) => a - b));
  };
  const removeBoundary = (i: number) => onSetBoundaries(boundaries.filter(x => x !== i));

  // drag: listener globali, attivi solo quando dragRef != null
  React.useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cur = dragRef.current;
      if (cur == null) return;
      e.preventDefault();
      // gap più vicino (1..n-1) confrontando con il bordo superiore della riga
      let best = -1, bestD = Infinity;
      for (let g = 1; g < stops.length; g++) {
        const el = rowRefs.current[g];
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        const d = Math.abs(e.clientY - top);
        if (d < bestD) { bestD = d; best = g; }
      }
      if (best < 0) return;
      // non superare i confini adiacenti (partizioni: niente sovrapposizioni)
      const others = boundsRef.current.filter(b => b !== cur);
      const prev = others.filter(b => b < cur).reduce((m, b) => Math.max(m, b), 0);
      const nextArr = others.filter(b => b > cur);
      const next = nextArr.length ? Math.min(...nextArr) : stops.length;
      let g = Math.min(Math.max(best, prev + 1), next - 1);
      if (g < 1) g = 1; if (g > stops.length - 1) g = stops.length - 1;
      if (g === cur) return;
      const updated = [...others, g].sort((a, b) => a - b);
      boundsRef.current = updated;
      dragRef.current = g;
      setActiveDrag(g);
      onSetBoundaries(updated);
    };
    const onUp = () => { dragRef.current = null; setActiveDrag(null); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [stops.length, onSetBoundaries]);

  const startDrag = (i: number) => { dragRef.current = i; setActiveDrag(i); };

  return (
    <div className="max-w-2xl select-none">
      {stops.map((s, i) => {
        const tIdx = trattaOf[i];
        const tNum = numOf(tIdx);
        const color = trattaColor(tNum - 1);
        const isBoundary = boundaries.includes(i);
        const isFirstOfTratta = i === 0 || trattaOf[i - 1] !== tIdx;
        return (
          <div key={`${s.stopId}-${i}`} ref={(el) => { rowRefs.current[i] = el; }}>
            {/* Confine tra fermata i-1 e i */}
            {i > 0 && (
              isBoundary ? (
                <div className={`flex items-center gap-2 h-6 -my-px rounded ${activeDrag === i ? "bg-emerald-500/10" : ""}`}>
                  <span className="w-[3px] self-stretch shrink-0 bg-transparent" />
                  <div
                    onPointerDown={(e) => { e.preventDefault(); startDrag(i); }}
                    title="Trascina per spostare il confine di tratta"
                    className="flex-1 flex items-center gap-1.5 cursor-grab active:cursor-grabbing text-[9px] font-medium"
                    style={{ color }}
                  >
                    <span className="flex-1 border-t-2 border-dashed" style={{ borderColor: color }} />
                    <GripHorizontal className="w-3.5 h-3.5" />
                    <span className="uppercase tracking-wide">confine · trascina</span>
                    <span className="flex-1 border-t-2 border-dashed" style={{ borderColor: color }} />
                  </div>
                  <button onClick={() => removeBoundary(i)} title="Unisci alla tratta precedente"
                    className="shrink-0 p-0.5 rounded text-emerald-400/50 hover:text-red-400 hover:bg-red-500/10">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button onClick={() => createBoundary(i)} title="Dividi: inizia una nuova tratta qui"
                  className="group/divider w-full flex items-center gap-2 h-4 -my-px">
                  <span className="w-[3px] self-stretch shrink-0" style={{ background: color }} />
                  <span className="flex-1 flex items-center gap-2 text-[9px] text-emerald-500/0 group-hover/divider:text-emerald-400/70 transition-opacity">
                    <span className="flex-1 border-t border-dashed border-emerald-700/0 group-hover/divider:border-emerald-600/50" />
                    <span className="flex items-center gap-1 opacity-0 group-hover/divider:opacity-100"><Scissors className="w-2.5 h-2.5" /> dividi qui</span>
                    <span className="flex-1 border-t border-dashed border-emerald-700/0 group-hover/divider:border-emerald-600/50" />
                  </span>
                </button>
              )
            )}
            {/* Header tratta: etichetta + NODO TARIFFARIO (editabile) */}
            {isFirstOfTratta && (
              <div className="flex items-center gap-2 mt-2 mb-1">
                <span className="w-[3px] self-stretch shrink-0" style={{ background: color }} />
                <span className="text-[10px] px-1.5 py-1 rounded font-bold shrink-0" style={{ background: `${color}22`, color }}>T{tNum}</span>
                <input
                  value={nodeNames[tIdx] ?? ""}
                  onChange={(e) => onSetNodeName(tIdx, e.target.value)}
                  placeholder="Nome nodo tariffario…"
                  className="flex-1 min-w-0 text-[12px] px-2 py-1 rounded bg-emerald-950/60 border text-emerald-100 placeholder:text-emerald-500/40 focus:outline-none focus:border-emerald-400/70"
                  style={{ borderColor: `${color}66`, borderLeftWidth: 3, borderLeftColor: color }}
                />
              </div>
            )}
            {/* Fermata */}
            <div className="flex items-stretch gap-2">
              <span className="w-[3px] shrink-0" style={{ background: color }} />
              <div className="flex items-center gap-3 flex-1 py-1.5">
                <span className="relative flex items-center justify-center shrink-0">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 0 2px rgba(0,0,0,0.3)` }} />
                </span>
                <span className="text-[10px] text-emerald-500/40 font-mono w-6 text-right shrink-0">{i + 1}</span>
                <span className="flex-1 min-w-0 text-[13px] text-emerald-100 truncate">{s.stopName}</span>
                <span className="text-[10px] text-emerald-300/70 font-mono w-16 text-right shrink-0">{fmtKm(s.km)} km</span>
                <span className="text-[10px] text-emerald-400/40 font-mono w-16 text-right shrink-0">
                  {i > 0 ? `+${fmtKm(s.distPrev)}` : "—"}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
 *  Preview geografica SVG (no token mapbox) — polilinea colorata per tratta
 * ════════════════════════════════════════════════════════════════ */
function RoutePreviewSvg({ stops, shape, trattaOf, groupNumbers }: {
  stops: PStop[]; shape: [number, number][] | null; trattaOf: number[]; groupNumbers: number[];
}) {
  const colorOf = (gi: number) => trattaColor((groupNumbers[gi] ?? gi + 1) - 1);
  const W = 256, H = 200, pad = 10;
  const pts = React.useMemo(() => stops.map(s => ({ x: s.lon, y: s.lat })), [stops]);
  const all = shape && shape.length > 1 ? shape.map(([lon, lat]) => ({ x: lon, y: lat })) : pts;
  if (all.length < 2) return null;
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1e-6, spanY = maxY - minY || 1e-6;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
  const tx = (x: number) => ox + (x - minX) * scale;
  const ty = (y: number) => H - (oy + (y - minY) * scale); // flip Y (lat su)

  return (
    <div className="rounded-lg border border-emerald-900/40 bg-black/30 overflow-hidden">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/50 px-2 pt-1.5">Polilinea</p>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
        {/* shape di contesto */}
        {shape && shape.length > 1 && (
          <polyline points={shape.map(([lon, lat]) => `${tx(lon)},${ty(lat)}`).join(" ")}
            fill="none" stroke="#34d39933" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {/* segmenti fermata→fermata colorati per tratta */}
        {stops.slice(1).map((s, i) => {
          const a = stops[i], b = s;
          return <line key={i} x1={tx(a.lon)} y1={ty(a.lat)} x2={tx(b.lon)} y2={ty(b.lat)}
            stroke={colorOf(trattaOf[i + 1])} strokeWidth={2} strokeLinecap="round" />;
        })}
        {/* fermate */}
        {stops.map((s, i) => (
          <circle key={i} cx={tx(s.lon)} cy={ty(s.lat)} r={i === 0 || i === stops.length - 1 ? 3.2 : 1.8}
            fill={colorOf(trattaOf[i])} stroke="#000" strokeWidth={0.5} />
        ))}
      </svg>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════
 *  Export "a gradoni" — matrice triangolare delle polimetriche salvate
 * ════════════════════════════════════════════════════════════════ */
interface SavedPolimetrica {
  id: string; routeId: string; lineCode: string | null; lineName: string | null;
  variantId: string; direction: string; name: string | null;
  totalKm: number | null; stopCount: number | null; trattaCount: number | null;
  stops: { stopName: string; km: number; tratta: number }[] | null;
  tratte: { index: number; number?: number; nodeName?: string; label?: string; km?: number; fromStopName?: string; toStopName?: string }[] | null;
}

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

/** colore cella in base al numero di tratte (più tratte = più scuro). */
function gradoniCellColor(v: number, maxV: number): { bg: string; fg: string } {
  const t = maxV <= 1 ? 0 : (v - 1) / (maxV - 1);
  const L = Math.round(88 - t * 45); // 88% → 43%
  return { bg: `hsl(152,55%,${L}%)`, fg: L < 60 ? "#ffffff" : "#064e3b" };
}

function renderGradoniTable(p: SavedPolimetrica): string {
  // Matrice triangolare NODO TARIFFARIO × NODO TARIFFARIO (compatta) + colonna
  // laterale con tutte le fermate colorate per tratta (come nell'area di lavoro).
  const tratte = (p.tratte || []).slice().sort((a, b) => a.index - b.index);
  const stops = p.stops || [];
  if (tratte.length < 1) return `<p class="empty">Nessuna tratta definita.</p>`;
  const N = tratte.length;
  const numberOf = (i: number) => tratte[i].number ?? i + 1;       // numero banda 6km
  const colorOf = (i: number) => trattaColor(numberOf(i) - 1);
  const nodeLabel = (i: number) => (tratte[i].nodeName || "").trim() || `Tratta ${numberOf(i)}`;
  const maxV = numberOf(N - 1) - numberOf(0) + 1;

  // ── Matrice a gradoni (nodo × nodo) ──
  let rows = "";
  for (let r = 0; r < N; r++) {
    let cells = "";
    for (let c = 0; c < r; c++) {
      const v = numberOf(r) - numberOf(c) + 1; // n. tratte tra nodo c e nodo r
      const { bg, fg } = gradoniCellColor(v, maxV);
      cells += `<td class="v" style="background:${bg};color:${fg}">${v}</td>`;
    }
    cells += `<td class="name"><span class="dot" style="background:${colorOf(r)}"></span>T${numberOf(r)} · ${esc(nodeLabel(r))}</td>`;
    rows += `<tr>${cells}</tr>`;
  }

  // ── Colonna fermate colorate per tratta ──
  let stopRows = "";
  let prevG = -1;
  for (const s of stops) {
    const gi = s.tratta;
    if (gi !== prevG) {
      const lbl = gi >= 0 && gi < N ? `T${numberOf(gi)} · ${esc(nodeLabel(gi))}` : `Tratta`;
      stopRows += `<div class="grp" style="border-left-color:${gi >= 0 && gi < N ? colorOf(gi) : "#ccc"}">${lbl}</div>`;
      prevG = gi;
    }
    const col = gi >= 0 && gi < N ? colorOf(gi) : "#ccc";
    stopRows += `<div class="st"><span class="d" style="background:${col}"></span><span class="nm">${esc(s.stopName)}</span><span class="km">${fmtKm(s.km)}</span></div>`;
  }

  const dirLbl = p.direction === "BA" ? "Ritorno (invertito)" : "Andata (diretto)";
  const first = stops[0]?.stopName ?? nodeLabel(0);
  const last = stops[stops.length - 1]?.stopName ?? nodeLabel(N - 1);
  return `
    <section class="poli">
      <h2>${esc(p.lineCode || "")} — ${esc(p.name || `${first} → ${last}`)}</h2>
      <p class="meta">${dirLbl} · ${fmtKm(p.totalKm ?? 0)} km · ${N} nodi tariffari${stops.length ? ` · ${stops.length} fermate` : ""}
        <span class="hint">— valore cella = numero di tratte tra i due nodi (fascia).</span></p>
      <div class="cols">
        <table class="grad"><tbody>${rows}</tbody></table>
        <div class="stoplist">${stopRows}</div>
      </div>
    </section>`;
}

function openGradoniExport(rows: SavedPolimetrica[], agencyName: string | null, filename: string) {
  // ordina per linea/codice
  const sorted = [...rows].sort((a, b) =>
    (a.lineCode || "").localeCompare(b.lineCode || "", "it", { numeric: true }) ||
    (a.direction || "").localeCompare(b.direction || ""));
  const body = sorted.map(renderGradoniTable).join("\n");
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8">
<title>Polimetriche a gradoni${agencyName ? " — " + esc(agencyName) : ""}</title>
<style>
  @page{size:A3 landscape;margin:10mm}
  /* forza la stampa degli sfondi colorati (gradoni, pallini, banda tratte) */
  *{-webkit-print-color-adjust:exact !important;print-color-adjust:exact !important;color-adjust:exact !important}
  :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;padding:24px;color:#0f172a;background:#f8fafc}
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px;border-bottom:2px solid #10b981;padding-bottom:10px}
  header h1{font-size:16px;margin:0;color:#065f46}
  header .sub{font-size:11px;color:#475569;margin-top:2px}
  button.print{background:#10b981;color:#053b2c;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
  section.poli{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin-bottom:14px;break-inside:avoid;page-break-inside:avoid}
  section.poli h2{font-size:14px;margin:0 0 2px;color:#0f172a}
  .meta{font-size:10px;color:#64748b;margin:0 0 8px}
  .meta .hint{color:#94a3b8}
  .cols{display:flex;gap:24px;align-items:flex-start}
  table.grad{border-collapse:collapse;font-size:11px;flex:0 0 auto}
  table.grad td{border:1px solid #e2e8f0;text-align:center;height:18px;min-width:18px;padding:0 3px}
  table.grad td.v{font-variant-numeric:tabular-nums;font-weight:700}
  table.grad td.name{text-align:left;white-space:nowrap;padding:0 7px;font-weight:600;background:#fff;border-left:2px solid #cbd5e1}
  .name .dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:middle}
  /* colonna fermate colorate per tratta (A3 orizzontale → 3 colonne) */
  .stoplist{flex:1 1 auto;min-width:0;columns:3;column-gap:24px;font-size:10px}
  .stoplist .grp{break-inside:avoid;font-weight:700;color:#0f172a;background:#f1f5f9;border-left:3px solid #ccc;padding:2px 6px;margin:4px 0 2px}
  .stoplist .st{display:flex;align-items:center;gap:5px;padding:1px 2px;break-inside:avoid}
  .stoplist .st .d{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
  .stoplist .st .nm{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .stoplist .st .km{color:#94a3b8;font-variant-numeric:tabular-nums;flex:0 0 auto}
  .empty{color:#94a3b8;font-style:italic}
  @media print{body{background:#fff;padding:0}button.print{display:none}header{position:static}}
</style></head>
<body>
  <header>
    <div>
      <h1>Polimetriche a gradoni${agencyName ? " · " + esc(agencyName) : ""}</h1>
      <div class="sub">${esc(filename || "")} · ${sorted.length} polimetriche · generato il ${new Date().toLocaleString("it-IT")}</div>
    </div>
    <button class="print" onclick="window.print()">Stampa / Salva PDF</button>
  </header>
  ${body || '<p class="empty">Nessuna polimetrica.</p>'}
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
