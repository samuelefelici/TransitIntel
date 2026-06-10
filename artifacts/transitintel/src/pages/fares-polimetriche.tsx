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
} from "lucide-react";

const API = () => getApiBase();
const SEGMENT_KM = 6; // ogni 6 km → nuova tratta

/* ── Palette tratte (colori distinti, ciclica) ───────────────── */
const TRATTA_PALETTE = [
  "#10b981", "#f59e0b", "#3b82f6", "#ef4444", "#a855f7", "#14b8a6",
  "#ec4899", "#84cc16", "#f97316", "#06b6d4", "#8b5cf6", "#eab308",
  "#22c55e", "#e11d48", "#0ea5e9", "#d946ef",
];
const trattaColor = (i: number) => TRATTA_PALETTE[i % TRATTA_PALETTE.length];

/* ── Tipi ─────────────────────────────────────────────────────── */
interface ImportSummary {
  id: string; filename: string; agencyName: string | null;
  lineCount: number; percorsoCount: number; createdAt: string;
}
interface PercorsoMeta {
  variantId: string; routeId: string; direction: string;
  tripCount: number; forwardCount: number; reverseCount: number;
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
  tripCount: number; firstStopName: string; lastStopName: string;
  stopCount: number; totalKm: number; distanceMethod: "shape" | "haversine";
  stops: PStop[]; shape: [number, number][] | null;
}
interface Tratta {
  index: number; label: string; color: string;
  fromStopIdx: number; toStopIdx: number;
  fromStopName: string; toStopName: string;
  fromKm: number; toKm: number; km: number; stopCount: number;
}

const fmtKm = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/* ── Genera confini automatici ogni 6 km (snap alle fermate) ───── */
function autoBoundaries(stops: PStop[]): number[] {
  const b: number[] = [];
  if (stops.length < 2) return b;
  let target = SEGMENT_KM;
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].km >= target) {
      b.push(i);
      // avanza il target oltre il km corrente (gestisce salti > 6km)
      while (target <= stops[i].km) target += SEGMENT_KM;
    }
  }
  return b;
}

/* ── Costruisce le tratte a partire dai confini ─────────────────── */
function buildTratte(stops: PStop[], boundaries: number[]): Tratta[] {
  const bounds = [...new Set(boundaries)].filter(i => i > 0 && i < stops.length).sort((a, b) => a - b);
  const starts = [0, ...bounds];
  const tratte: Tratta[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : stops.length - 1;
    const fromKm = stops[from].km;
    const toKm = stops[to].km;
    tratte.push({
      index: k,
      label: `Tratta ${k + 1}`,
      color: trattaColor(k),
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
            onClick={() => { setImportId(null); setSel(null); setDetail(null); }}
            className="text-[12px] px-3 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-300/80 hover:bg-emerald-500/10 transition-colors"
          >
            Cambia import
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* Rail linee */}
        <div className="min-h-0 rounded-xl border border-emerald-900/40 bg-emerald-950/30 overflow-hidden flex flex-col">
          <div className="px-3 py-2 border-b border-emerald-900/40 text-[11px] font-semibold uppercase tracking-wider text-emerald-400/60 flex items-center gap-2">
            <Layers className="w-3.5 h-3.5" /> Linee extraurbane
          </div>
          {loadingTree ? (
            <div className="flex-1 flex items-center justify-center text-emerald-400/50"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : (
            <LinesRail lines={tree?.lines || []} sel={sel} onSelect={setSel} />
          )}
        </div>

        {/* Workspace percorso */}
        <div className="min-h-0 rounded-xl border border-emerald-900/40 bg-emerald-950/20 overflow-hidden">
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
function LinesRail({ lines, sel, onSelect }: {
  lines: LineMeta[];
  sel: { lineCode: string; routeId: string; variantId: string } | null;
  onSelect: (s: { lineCode: string; routeId: string; variantId: string }) => void;
}) {
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(sel ? [sel.lineCode] : []));
  React.useEffect(() => { if (sel) setOpen(prev => new Set(prev).add(sel.lineCode)); }, [sel]);
  const toggle = (code: string) => setOpen(prev => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n; });

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {lines.map((l) => {
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
                  return (
                    <button key={`${p.routeId}:${p.variantId}`}
                      onClick={() => onSelect({ lineCode: l.lineCode, routeId: p.routeId, variantId: p.variantId })}
                      className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                        active ? "bg-emerald-500/20 text-emerald-100" : "text-emerald-300/70 hover:bg-emerald-500/8"
                      }`}>
                      {done
                        ? <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                        : <RouteIcon className="w-3.5 h-3.5 text-emerald-500/40 shrink-0 mt-0.5" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] leading-tight truncate">{p.firstStopName} → {p.lastStopName}</p>
                        <p className="text-[9px] text-emerald-400/40 font-mono">
                          {p.stopCount} ferm · {fmtKm(p.totalKm)} km · {p.tripCount} corse
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {lines.length === 0 && (
        <p className="px-3 py-4 text-[12px] text-emerald-400/40 italic">Nessuna linea extraurbana in questo import.</p>
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
        } else {
          setBoundaries(autoBoundaries(stops));
          setName("");
        }
        setLoadedSaved(true);
      })
      .catch(() => { if (!cancelled) { setBoundaries(autoBoundaries(stops)); setLoadedSaved(true); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importId, detail.routeId, detail.variantId, direction]);

  const tratte = React.useMemo(() => buildTratte(stops, boundaries), [stops, boundaries]);
  const trattaOf = React.useMemo(() => stopTrattaMap(stops, boundaries), [stops, boundaries]);

  const toggleBoundary = (i: number) => {
    if (i <= 0 || i >= stops.length) return;
    setBoundaries(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i].sort((a, b) => a - b));
  };
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
          <p className="text-[10px] text-emerald-400/50 font-mono">
            {detail.stopCount} fermate · {fmtKm(stops[stops.length - 1]?.km ?? 0)} km · {detail.tripCount} corse · km via {detail.distanceMethod === "shape" ? "shape GTFS" : "haversine"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Direzione */}
          <button onClick={() => setDirection(d => d === "AB" ? "BA" : "AB")}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-lg border border-emerald-700/50 text-emerald-200 hover:bg-emerald-500/10 transition-colors">
            <ArrowLeftRight className="w-3.5 h-3.5" /> {direction === "AB" ? "Andata" : "Ritorno"}
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
        <button onClick={() => setBoundaries(autoBoundaries(stops))}
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
              onToggleBoundary={toggleBoundary} />
          )}
        </div>

        {/* Pannello laterale: preview geografica + elenco tratte */}
        <div className="min-h-0 overflow-y-auto border-l border-emerald-900/40 bg-emerald-950/20 p-3 space-y-3">
          <RoutePreviewSvg stops={stops} shape={direction === "AB" ? detail.shape : (detail.shape ? [...detail.shape].reverse() : null)} trattaOf={trattaOf} />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400/50 mb-1.5">Tratte</p>
            <div className="space-y-1">
              {tratte.map((t) => (
                <div key={t.index} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-900/40">
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
function StripDiagram({ stops, boundaries, trattaOf, onToggleBoundary }: {
  stops: PStop[]; boundaries: number[]; trattaOf: number[];
  onToggleBoundary: (i: number) => void;
}) {
  return (
    <div className="max-w-2xl">
      {stops.map((s, i) => {
        const tIdx = trattaOf[i];
        const color = trattaColor(tIdx);
        const isBoundary = boundaries.includes(i);
        const isFirstOfTratta = i === 0 || trattaOf[i - 1] !== tIdx;
        return (
          <div key={`${s.stopId}-${i}`}>
            {/* Divisore confine tra fermata i-1 e i */}
            {i > 0 && (
              <button
                onClick={() => onToggleBoundary(i)}
                title={isBoundary ? "Unisci alla tratta precedente" : "Inizia una nuova tratta qui"}
                className="group/divider w-full flex items-center gap-2 h-5 -my-px"
              >
                {/* tratto verticale colorato continua */}
                <span className="w-[3px] self-stretch shrink-0" style={{ background: isBoundary ? "transparent" : color }} />
                <span className={`flex-1 flex items-center gap-2 text-[9px] transition-opacity ${
                  isBoundary ? "text-emerald-300" : "text-emerald-500/0 group-hover/divider:text-emerald-400/70"
                }`}>
                  <span className="flex-1 border-t border-dashed border-emerald-700/0 group-hover/divider:border-emerald-600/50" />
                  {isBoundary
                    ? <span className="flex items-center gap-1"><Scissors className="w-2.5 h-2.5" /> nuova tratta · unisci</span>
                    : <span className="flex items-center gap-1 opacity-0 group-hover/divider:opacity-100"><Scissors className="w-2.5 h-2.5" /> dividi qui</span>}
                  <span className="flex-1 border-t border-dashed border-emerald-700/0 group-hover/divider:border-emerald-600/50" />
                </span>
              </button>
            )}
            {/* Fermata */}
            <div className="flex items-stretch gap-2">
              {/* banda colore tratta */}
              <span className="w-[3px] shrink-0" style={{ background: color }} />
              <div className="flex items-center gap-3 flex-1 py-1.5">
                <span className="relative flex items-center justify-center shrink-0">
                  <span className="w-2.5 h-2.5 rounded-full ring-2" style={{ background: color, boxShadow: `0 0 0 2px rgba(0,0,0,0.3)` }} />
                </span>
                <span className="text-[10px] text-emerald-500/40 font-mono w-6 text-right shrink-0">{i + 1}</span>
                <span className="flex-1 min-w-0 text-[13px] text-emerald-100 truncate">{s.stopName}</span>
                {isFirstOfTratta && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0 font-semibold" style={{ background: `${color}22`, color }}>
                    T{tIdx + 1}
                  </span>
                )}
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
function RoutePreviewSvg({ stops, shape, trattaOf }: {
  stops: PStop[]; shape: [number, number][] | null; trattaOf: number[];
}) {
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
          const color = trattaColor(trattaOf[i + 1]);
          return <line key={i} x1={tx(a.lon)} y1={ty(a.lat)} x2={tx(b.lon)} y2={ty(b.lat)}
            stroke={color} strokeWidth={2} strokeLinecap="round" />;
        })}
        {/* fermate */}
        {stops.map((s, i) => (
          <circle key={i} cx={tx(s.lon)} cy={ty(s.lat)} r={i === 0 || i === stops.length - 1 ? 3.2 : 1.8}
            fill={trattaColor(trattaOf[i])} stroke="#000" strokeWidth={0.5} />
        ))}
      </svg>
    </div>
  );
}
