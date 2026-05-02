// ═══════════════════════════════════════════════════════════
// TAB TELEMACO — Auto-assegnazione fermate ai Nodi Tariffari
// Pipeline 4 layer + catalogo ufficiale ATMA + audit override
// ═══════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import {
  ShieldCheck, Loader2, CheckCircle2, AlertTriangle, Layers, Database,
  Search, Trash2, Plus, MoveRight, FileWarning, History, Download, Upload, Play,
} from "lucide-react";

// ───────────── tipi ─────────────

interface OfficialNode {
  id: string;
  officialCode: string;
  officialName: string;
  centroidLat: number | null;
  centroidLon: number | null;
  aliases: string[] | null;
  source: string | null;
  notes: string | null;
}

interface RunRow {
  id: string;
  status: string;
  totalStops: number | null;
  assignedByLayer: Record<string, number> | null;
  clustersBefore: number | null;
  clustersAfter: number | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  params: Record<string, any> | null;
}

interface ReportData {
  totalStops: number;
  assignedStops: number;
  orphans: number;
  coveragePercent: number;
  lowConfidence: number;
  byLayer: Array<{ assignment_layer: string | null; cnt: number }>;
  bySource: Array<{ assignment_source: string | null; cnt: number }>;
  readyForTelemaco: boolean;
}

interface AssignmentRow {
  stopId: string;
  stopName: string;
  stopLat: number | null;
  stopLon: number | null;
  clusterId: string;
  clusterName: string;
  assignmentLayer: string | null;
  assignmentConfidence: number | null;
  assignmentSource: string | null;
}

interface OverrideRow {
  id: string;
  stopId: string;
  fromClusterId: string | null;
  toClusterId: string;
  reason: string | null;
  actor: string | null;
  createdAt: string;
}

const LAYER_META: Record<string, { label: string; color: string }> = {
  official_catalog: { label: "Catalogo ATMA", color: "emerald" },
  exact_name:       { label: "Nome esatto",   color: "sky" },
  token_proximity:  { label: "Token + dist",  color: "violet" },
  dbscan:           { label: "DBSCAN geo",    color: "amber" },
  singleton:        { label: "Singleton",     color: "rose" },
  manual_override:  { label: "Override",      color: "fuchsia" },
};

// ───────────── componente principale ─────────────

export default function FaresTelemacoTab() {
  const { toast } = useToast();
  const [view, setView] = useState<"dashboard" | "catalog" | "review" | "audit">("dashboard");

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="border-fuchsia-500/20 bg-gradient-to-br from-fuchsia-500/5 to-transparent">
        <CardContent className="pt-4">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 mt-0.5 text-fuchsia-400 shrink-0" />
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                Telemaco Compliance — Auto-assegnazione fermate ai Nodi Tariffari
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-fuchsia-500/40 text-fuchsia-300">NEW</Badge>
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Garantisce che <strong className="text-fuchsia-300">ogni fermata fisica</strong> sia associata a un nodo
                tariffario, requisito di conformità Telemaco. Pipeline a 4 layer con confidence decrescente:
                Catalogo Ufficiale → Match Esatto → Token+Prossimità → DBSCAN → Singleton (fallback).
              </p>
              <p className="text-[11px] text-muted-foreground/80 italic pt-1">
                Modalità additiva: non modifica cluster definiti manualmente. Override tracciati in audit log.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* View switcher */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit flex-wrap">
        {([
          ["dashboard", "Pipeline & Report", Play],
          ["catalog",   "Catalogo Ufficiale", Database],
          ["review",    "Review Manuale", FileWarning],
          ["audit",     "Audit Override", History],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setView(key)}
            className={`relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              view === key
                ? "text-foreground bg-background/80 border border-border/50 shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            }`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {view === "dashboard" && <DashboardView toast={toast} />}
      {view === "catalog"   && <CatalogView toast={toast} />}
      {view === "review"    && <ReviewView toast={toast} />}
      {view === "audit"     && <AuditView toast={toast} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// VIEW: Dashboard (run pipeline + ultimo report)
// ═══════════════════════════════════════════════════════════

function DashboardView({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);

  // params pipeline v2 (Urban Hub + K-Means addensamenti). I controlli "token"
  // e "singleton" sono nascosti perché disattivati di default in v2 (vedi
  // fares-node-assignment.ts). Restano nel codice come stato per riattivazione futura.
  // `kmeansK = 0` → auto-stima dal backend in base all'estensione geografica.
  const [kmeansK, setKmeansK] = useState(0);
  // const [tokenRadiusM, setTokenRadiusM] = useState(500);
  // const [enableSingleton, setEnableSingleton] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [r, rep] = await Promise.all([
        apiFetch<{ runs: RunRow[] }>("/api/fares/node-assignment/runs").catch(() => ({ runs: [] })),
        apiFetch<ReportData>("/api/fares/node-assignment/report").catch(() => null),
      ]);
      setRuns(r.runs ?? []);
      setReport(rep);
    } catch { /* noop */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const runPipeline = async () => {
    setBusy(true);
    try {
      // Pipeline v2: solo Urban Hub + K-Means addensamenti. Tutti gli altri
      // layer (catalog, exact, token, dbscan, singleton) sono dormienti e
      // devono restare OFF per evitare cluster sovrapposti o esplosione del
      // numero di partizioni. Lo step k-means usa la STESSA logica del
      // bottone "auto-generate spatial" già in fares.ts.
      const res = await apiFetch<any>("/api/fares/node-assignment/run", {
        method: "POST",
        body: JSON.stringify({
          useUrbanHub: true,
          useKmeans: true,
          useOfficialCatalog: false,
          useExactName: false,
          useToken: false,
          useDbscan: false,
          useSingleton: false,
          kmeansK: kmeansK > 0 ? kmeansK : 0,  // 0 = auto-stima
        }),
      });
      toast({
        title: "Pipeline Telemaco completata",
        description: `${res.totalStops ?? "?"} fermate · ${res.clustersAfter ?? "?"} cluster · ${res.durationMs ?? "?"} ms`,
      });
      await refresh();
    } catch (e: any) {
      toast({ title: "Errore pipeline", description: e.message, variant: "destructive" });
    }
    setBusy(false);
  };

  const lastRun = runs[0];
  const coveragePct = report?.coveragePercent ?? 0;
  const assigned = report?.assignedStops ?? 0;
  const clustersCount = lastRun?.clustersAfter ?? null;

  return (
    <div className="space-y-4">
      {/* Parametri + bottone run */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Play className="w-4 h-4" /> Esegui Pipeline Telemaco
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            Modello v2 a 2 step: <strong>Step 1</strong> Urban Hub (servizi urbani → 1 nodo per città) ·
            <strong> Step 2</strong> Addensamenti k-means sulle fermate non-urbane
            (stessa logica del bottone "Auto-genera cluster spaziali") ·
            <strong> Step 3</strong> assegnazione manuale delle fermate orfane.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[11px] text-muted-foreground">Numero cluster (K)</label>
              <Input
                type="number" step="1" min="0" max="50"
                value={kmeansK}
                onChange={e => setKmeansK(Number(e.target.value))}
                className="h-8 text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1">0 = stima automatica (~ 1 cluster ogni 8×8 km)</p>
            </div>
          </div>
          <Button onClick={runPipeline} disabled={busy} className="w-full md:w-auto">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            <span className="ml-1.5">Esegui pipeline (Urban + Addensamenti)</span>
          </Button>
        </CardContent>
      </Card>

      {/* Report ultimo run */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Copertura</p>
            <p className="text-2xl font-bold text-emerald-400">{coveragePct}%</p>
            <p className="text-[11px] text-muted-foreground">
              {assigned} / {report?.totalStops ?? 0} fermate
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Cluster generati</p>
            <p className="text-2xl font-bold">{clustersCount ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Fermate orfane</p>
            <p className={`text-2xl font-bold ${(report?.orphans ?? 0) > 0 ? "text-rose-400" : "text-emerald-400"}`}>
              {report?.orphans ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Ultimo run</p>
            {lastRun ? (
              <>
                <div className="flex items-center gap-1.5">
                  {lastRun.status === "success" && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                  {lastRun.status === "error"   && <AlertTriangle className="w-4 h-4 text-rose-400" />}
                  {lastRun.status === "running" && <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />}
                  <span className="text-sm font-medium capitalize">{lastRun.status}</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {new Date(lastRun.startedAt).toLocaleString("it-IT")}
                  {lastRun.durationMs && ` · ${lastRun.durationMs} ms`}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Mai eseguita</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Breakdown layer */}
      {report && Array.isArray(report.byLayer) && report.byLayer.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Layers className="w-4 h-4" /> Distribuzione per Layer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {report.byLayer.map((row) => {
                const layer = row.assignment_layer ?? "unknown";
                const count = Number(row.cnt ?? 0);
                const meta = LAYER_META[layer] ?? { label: layer, color: "slate" };
                const pct = assigned > 0 ? Math.round((count / assigned) * 100) : 0;
                return (
                  <div key={layer}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full bg-${meta.color}-400`} />
                        {meta.label}
                      </span>
                      <span className="text-muted-foreground">
                        {count} fermate · {pct}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
                      <div
                        className={`h-full bg-${meta.color}-400 transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Storico run */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="w-4 h-4" /> Storico Esecuzioni
          </CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nessuna esecuzione registrata.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground border-b border-border/30">
                  <tr>
                    <th className="text-left py-1.5 px-2">Quando</th>
                    <th className="text-left py-1.5 px-2">Status</th>
                    <th className="text-right py-1.5 px-2">Fermate</th>
                    <th className="text-right py-1.5 px-2">Cluster</th>
                    <th className="text-right py-1.5 px-2">Durata</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 10).map(r => (
                    <tr key={r.id} className="border-b border-border/10 hover:bg-white/5">
                      <td className="py-1.5 px-2">{new Date(r.startedAt).toLocaleString("it-IT")}</td>
                      <td className="py-1.5 px-2 capitalize">{r.status}</td>
                      <td className="py-1.5 px-2 text-right">{r.totalStops ?? "—"}</td>
                      <td className="py-1.5 px-2 text-right">{r.clustersAfter ?? "—"}</td>
                      <td className="py-1.5 px-2 text-right">{r.durationMs ? `${r.durationMs} ms` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// VIEW: Catalogo nodi ufficiali
// ═══════════════════════════════════════════════════════════

function CatalogView({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [nodes, setNodes] = useState<OfficialNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [newNode, setNewNode] = useState({ officialCode: "", officialName: "", lat: "", lon: "", aliases: "" });

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<{ nodes: OfficialNode[] }>("/api/fares/official-nodes");
      setNodes(res.nodes ?? []);
    } catch { setNodes([]); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const importAtma = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<any>("/api/fares/official-nodes/import-atma-2013", { method: "POST" });
      toast({ title: "Catalogo ATMA 2013 importato", description: `${res.inserted}/${res.totalNodes} nodi` });
      await refresh();
    } catch (e: any) {
      toast({ title: "Errore import", description: e.message, variant: "destructive" });
    }
    setBusy(false);
  };

  const addNode = async () => {
    if (!newNode.officialCode.trim() || !newNode.officialName.trim()) {
      toast({ title: "Codice e nome sono obbligatori", variant: "destructive" });
      return;
    }
    try {
      await apiFetch("/api/fares/official-nodes", {
        method: "POST",
        body: JSON.stringify({
          officialCode: newNode.officialCode.trim(),
          officialName: newNode.officialName.trim(),
          centroidLat: newNode.lat ? Number(newNode.lat) : null,
          centroidLon: newNode.lon ? Number(newNode.lon) : null,
          aliases: newNode.aliases.split(",").map(s => s.trim()).filter(Boolean),
          source: "manual",
        }),
      });
      toast({ title: "Nodo aggiunto" });
      setNewNode({ officialCode: "", officialName: "", lat: "", lon: "", aliases: "" });
      setShowAdd(false);
      await refresh();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const deleteNode = async (id: string) => {
    if (!confirm("Eliminare questo nodo dal catalogo?")) return;
    try {
      await apiFetch(`/api/fares/official-nodes/${id}`, { method: "DELETE" });
      toast({ title: "Nodo eliminato" });
      await refresh();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return nodes;
    const q = search.toLowerCase();
    return nodes.filter(n =>
      n.officialCode.toLowerCase().includes(q) ||
      n.officialName.toLowerCase().includes(q) ||
      (n.aliases ?? []).some(a => a.toLowerCase().includes(q)),
    );
  }, [nodes, search]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Database className="w-4 h-4" /> Catalogo Nodi Tariffari Ufficiali
            <Badge variant="outline" className="text-[10px]">{nodes.length}</Badge>
          </span>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={importAtma} disabled={busy}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              <span className="ml-1.5">Import ATMA 2013</span>
            </Button>
            <Button size="sm" onClick={() => setShowAdd(s => !s)}>
              <Plus className="w-3 h-3" /> <span className="ml-1.5">Nuovo nodo</span>
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {showAdd && (
          <div className="p-3 rounded-lg bg-muted/30 border border-border/30 space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Input placeholder="Codice (es. JESI)" value={newNode.officialCode}
                onChange={e => setNewNode(n => ({ ...n, officialCode: e.target.value }))} className="h-8 text-xs" />
              <Input placeholder="Nome (es. Jesi)" value={newNode.officialName}
                onChange={e => setNewNode(n => ({ ...n, officialName: e.target.value }))} className="h-8 text-xs" />
              <Input placeholder="Lat" value={newNode.lat}
                onChange={e => setNewNode(n => ({ ...n, lat: e.target.value }))} className="h-8 text-xs" />
              <Input placeholder="Lon" value={newNode.lon}
                onChange={e => setNewNode(n => ({ ...n, lon: e.target.value }))} className="h-8 text-xs" />
              <Input placeholder="Alias (separati da ,)" value={newNode.aliases}
                onChange={e => setNewNode(n => ({ ...n, aliases: e.target.value }))} className="h-8 text-xs" />
            </div>
            <div className="flex gap-1.5 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Annulla</Button>
              <Button size="sm" onClick={addNode}>Salva</Button>
            </div>
          </div>
        )}

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Cerca per codice, nome, alias..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-8 text-xs pl-7"
          />
        </div>

        <div className="overflow-x-auto max-h-[500px]">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b border-border/30 sticky top-0 bg-background">
              <tr>
                <th className="text-left py-1.5 px-2">Codice</th>
                <th className="text-left py-1.5 px-2">Nome</th>
                <th className="text-left py-1.5 px-2">Coordinate</th>
                <th className="text-left py-1.5 px-2">Alias</th>
                <th className="text-left py-1.5 px-2">Source</th>
                <th className="text-right py-1.5 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(n => (
                <tr key={n.id} className="border-b border-border/10 hover:bg-white/5">
                  <td className="py-1.5 px-2 font-mono">{n.officialCode}</td>
                  <td className="py-1.5 px-2 font-medium">{n.officialName}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">
                    {n.centroidLat != null && n.centroidLon != null
                      ? `${n.centroidLat.toFixed(4)}, ${n.centroidLon.toFixed(4)}`
                      : "—"}
                  </td>
                  <td className="py-1.5 px-2 text-muted-foreground truncate max-w-[200px]">
                    {(n.aliases ?? []).join(", ") || "—"}
                  </td>
                  <td className="py-1.5 px-2">
                    <Badge variant="outline" className="text-[10px]">{n.source ?? "—"}</Badge>
                  </td>
                  <td className="py-1.5 px-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => deleteNode(n.id)}>
                      <Trash2 className="w-3 h-3 text-rose-400" />
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground">
                    {nodes.length === 0
                      ? "Catalogo vuoto. Importa ATMA 2013 o aggiungi manualmente."
                      : "Nessun risultato per la ricerca."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// VIEW: Review manuale (low-confidence + ambiguous + orphans)
// ═══════════════════════════════════════════════════════════

function ReviewView({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [tab, setTab] = useState<"low" | "ambiguous" | "orphans">("low");
  const [rows, setRows] = useState<AssignmentRow[]>([]);
  const [clusters, setClusters] = useState<{ clusterId: string; clusterName: string }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetCluster, setTargetCluster] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setSelected(new Set());
    try {
      const endpoint =
        tab === "low" ? "/api/fares/node-assignment/low-confidence" :
        tab === "ambiguous" ? "/api/fares/node-assignment/ambiguous" :
        "/api/fares/node-assignment/orphans";
      const res = await apiFetch<{ rows: AssignmentRow[] }>(endpoint);
      setRows(res.rows ?? []);
    } catch { setRows([]); }
    try {
      const c = await apiFetch<any[]>("/api/fares/zone-clusters");
      setClusters(Array.isArray(c) ? c.map((x: any) => ({
        clusterId: x.clusterId ?? x.cluster_id,
        clusterName: x.clusterName ?? x.cluster_name ?? x.clusterId ?? x.cluster_id,
      })) : []);
    } catch { setClusters([]); }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const toggle = (stopId: string) => {
    setSelected(s => {
      const ns = new Set(s);
      if (ns.has(stopId)) ns.delete(stopId); else ns.add(stopId);
      return ns;
    });
  };

  const bulkMove = async () => {
    if (!targetCluster || selected.size === 0) {
      toast({ title: "Seleziona fermate e cluster destinazione", variant: "destructive" });
      return;
    }
    try {
      const res = await apiFetch<any>("/api/fares/stop-assignment/bulk-move", {
        method: "POST",
        body: JSON.stringify({
          stopIds: Array.from(selected),
          toClusterId: targetCluster,
          reason: reason.trim() || null,
        }),
      });
      toast({ title: "Spostamento completato", description: `${res.moved ?? selected.size} fermate spostate` });
      setSelected(new Set());
      setReason("");
      await load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit">
        {([
          ["low", "Bassa confidence", AlertTriangle],
          ["ambiguous", "Ambigui", FileWarning],
          ["orphans", "Orfani", AlertTriangle],
        ] as const).map(([k, l, Ic]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium ${
              tab === k ? "text-foreground bg-background/80 border border-border/50" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Ic className="w-3 h-3" /> {l}
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-end">
              <div>
                <label className="text-[11px] text-muted-foreground">{selected.size} fermate selezionate · Cluster destinazione</label>
                <select
                  className="w-full text-xs px-2 py-1.5 rounded-md bg-background border border-border/50"
                  value={targetCluster}
                  onChange={e => setTargetCluster(e.target.value)}
                >
                  <option value="">— seleziona cluster —</option>
                  {clusters.map(c => (
                    <option key={c.clusterId} value={c.clusterId}>{c.clusterName}</option>
                  ))}
                </select>
              </div>
              <Input
                placeholder="Motivazione (opzionale)"
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="h-8 text-xs"
              />
              <Button size="sm" onClick={bulkMove} disabled={!targetCluster}>
                <MoveRight className="w-3.5 h-3.5 mr-1.5" /> Sposta {selected.size} fermate
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-3">
          <div className="overflow-x-auto max-h-[600px]">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b border-border/30 sticky top-0 bg-background">
                <tr>
                  <th className="w-8"></th>
                  <th className="text-left py-1.5 px-2">Stop ID</th>
                  <th className="text-left py-1.5 px-2">Nome fermata</th>
                  <th className="text-left py-1.5 px-2">Cluster attuale</th>
                  <th className="text-left py-1.5 px-2">Layer</th>
                  <th className="text-right py-1.5 px-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const meta = r.assignmentLayer ? LAYER_META[r.assignmentLayer] : null;
                  return (
                    <tr key={r.stopId} className="border-b border-border/10 hover:bg-white/5">
                      <td className="px-2">
                        <input
                          type="checkbox"
                          checked={selected.has(r.stopId)}
                          onChange={() => toggle(r.stopId)}
                        />
                      </td>
                      <td className="py-1.5 px-2 font-mono text-muted-foreground">{r.stopId}</td>
                      <td className="py-1.5 px-2 font-medium">{r.stopName}</td>
                      <td className="py-1.5 px-2">{r.clusterName || "—"}</td>
                      <td className="py-1.5 px-2">
                        {meta ? (
                          <Badge variant="outline" className={`text-[10px] border-${meta.color}-500/40 text-${meta.color}-300`}>
                            {meta.label}
                          </Badge>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 px-2 text-right">
                        {r.assignmentConfidence != null ? (
                          <span className={r.assignmentConfidence < 50 ? "text-rose-400 font-medium" : ""}>
                            {r.assignmentConfidence}
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      Nessuna fermata in questa categoria. ✓
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// VIEW: Audit log overrides
// ═══════════════════════════════════════════════════════════

function AuditView({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ overrides: OverrideRow[] }>("/api/fares/stop-assignment/overrides");
      setOverrides(res.overrides ?? []);
    } catch { setOverrides([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const revert = async (id: string) => {
    if (!confirm("Annullare questo override e ripristinare l'assegnazione precedente?")) return;
    try {
      await apiFetch(`/api/fares/stop-assignment/revert/${id}`, { method: "POST" });
      toast({ title: "Override annullato" });
      await load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <History className="w-4 h-4" /> Audit Log Override Manuali
          <Badge variant="outline" className="text-[10px]">{overrides.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b border-border/30 sticky top-0 bg-background">
              <tr>
                <th className="text-left py-1.5 px-2">Quando</th>
                <th className="text-left py-1.5 px-2">Stop ID</th>
                <th className="text-left py-1.5 px-2">Da cluster</th>
                <th className="text-left py-1.5 px-2">A cluster</th>
                <th className="text-left py-1.5 px-2">Motivazione</th>
                <th className="text-left py-1.5 px-2">Actor</th>
                <th className="text-right py-1.5 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {overrides.map(o => (
                <tr key={o.id} className="border-b border-border/10 hover:bg-white/5">
                  <td className="py-1.5 px-2">{new Date(o.createdAt).toLocaleString("it-IT")}</td>
                  <td className="py-1.5 px-2 font-mono">{o.stopId}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{o.fromClusterId ?? "—"}</td>
                  <td className="py-1.5 px-2 font-medium">{o.toClusterId}</td>
                  <td className="py-1.5 px-2">{o.reason ?? "—"}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{o.actor ?? "—"}</td>
                  <td className="py-1.5 px-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => revert(o.id)}>
                      <Upload className="w-3 h-3 rotate-180" />
                      <span className="ml-1">Revert</span>
                    </Button>
                  </td>
                </tr>
              ))}
              {overrides.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-muted-foreground">
                    Nessun override registrato.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
