/**
 * IntermodalAdvisor — Pannello di analisi intermodale post-ottimizzazione
 *
 * Riceve i VehicleShift già ottimizzati e chiama
 * POST /api/intermodal-optimizer/analyze.
 * Mostra in un dialog: hub scoperti, coincidenze treno/nave/aereo + bus
 * (con tempo a piedi), e consigli operativi.
 */
import React, { useState, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Train, Ship, Plane, Bus, Footprints, Loader2, RefreshCw,
  AlertTriangle, CheckCircle2, Clock, Network, Lightbulb, MapPin,
  Download, ArrowRight, Edit3,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { getApiBase } from "@/lib/api";
import type { VehicleShift } from "@/pages/optimizer-route/types";

/* ─── Types from backend ─── */
type HubType = "railway" | "port" | "airport" | "bus_terminal";
type ExtHubType = HubType | "bus_other";

interface HubPoi {
  id: string;
  name: string | null;
  category: string;
  lat: number;
  lng: number;
  distM: number;
  walkMin: number;
}

interface DiscoveredHub {
  id: string;
  name: string;
  type: HubType;
  lat: number;
  lng: number;
  description: string;
  platformWalkMinutes: number;
  weeklyDepartures?: { destination: string; times: string[] }[][];
  weeklyArrivals?: { origin: string; times: string[] }[][];
  typicalDepartures: { destination: string; times: string[] }[];
  typicalArrivals: { origin: string; times: string[] }[];
  source: "curated" | "gtfs-auto";
  pois?: HubPoi[];
  nearestTripM?: number;
}

interface CoincidenceMatch {
  shiftId: string;
  vehicleType?: string;
  tripId: string;
  routeId: string;
  routeName?: string;
  hubId: string;
  hubName: string;
  hubType: ExtHubType;
  priorityClass?: "rail" | "air" | "port" | "bus_terminal" | "bus_other";
  mode: "arrive_at_hub" | "depart_from_hub";
  busTime: string;
  trainTime: string;
  trainLabel: string;
  walkMin: number;
  bufferMin: number;
  status: "optimal" | "tight" | "long" | "missed";
}

interface Advisory {
  id: string;
  severity: "info" | "warning" | "critical";
  hubId: string;
  hubName: string;
  shiftId?: string;
  tripId?: string;
  title: string;
  description: string;
  suggestion: string;
  proposedShiftMin?: number;
  changeType?: "shift_departure" | "shift_arrival" | "add_trip" | "none";
  originalTime?: string;
  proposedTime?: string;
}

interface ProposedChange {
  shiftId: string;
  tripId: string;
  routeName?: string;
  hubName: string;
  changeType: "shift_departure" | "shift_arrival" | "add_trip";
  shiftMin: number;
  originalTime: string;
  proposedTime: string;
  reason: string;
  severity: "info" | "warning" | "critical";
}

interface AnalyzeResponse {
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } | null;
  date: string;
  dayOfWeek: number;
  hubs: DiscoveredHub[];
  hubsAnalyzed: number;
  hubsDiscarded?: number;
  hubSource?: "zones" | "auto";
  schedulesSynced: number;
  coincidences: CoincidenceMatch[];
  advisories: Advisory[];
  proposedChanges: ProposedChange[];
  metrics: {
    totalTripsAnalyzed: number;
    tripsNearHub: number;
    optimalConnections: number;
    tightConnections: number;
    longWaits: number;
    missedConnections: number;
    busExtraConnections?: number;
    poisReached?: number;
  };
}

/* ─── Helpers UI ─── */
const HUB_ICON: Record<ExtHubType, React.ReactNode> = {
  railway: <Train className="w-4 h-4" />,
  port: <Ship className="w-4 h-4" />,
  airport: <Plane className="w-4 h-4" />,
  bus_terminal: <Bus className="w-4 h-4" />,
  bus_other: <Bus className="w-4 h-4" />,
};

const POI_ICON: Record<string, string> = {
  office: "🏢",
  hospital: "🏥",
  school: "🎓",
  industrial: "🏭",
  leisure: "🎭",
  shopping: "🛍️",
};

const STATUS_COLOR: Record<CoincidenceMatch["status"], string> = {
  optimal: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  tight: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  long: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  missed: "text-rose-400 border-rose-500/30 bg-rose-500/10",
};

const STATUS_LABEL: Record<CoincidenceMatch["status"], string> = {
  optimal: "Ottimale",
  tight: "Stretta",
  long: "Lunga attesa",
  missed: "Persa",
};

const SEVERITY_COLOR: Record<Advisory["severity"], string> = {
  info: "border-sky-500/30 bg-sky-500/5 text-sky-300",
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-300",
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

const SEVERITY_ICON: Record<Advisory["severity"], React.ReactNode> = {
  info: <Lightbulb className="w-4 h-4" />,
  warning: <AlertTriangle className="w-4 h-4" />,
  critical: <AlertTriangle className="w-4 h-4" />,
};

const DAY_LABELS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

function minutesToTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}

/* ─── Main component ─── */
export default function IntermodalAdvisor({
  shifts,
  date,
  trigger,
  onApplyScenario,
}: {
  shifts: VehicleShift[];
  date?: string; // YYYYMMDD
  trigger?: React.ReactNode;
  /** Callback invocata quando l'utente applica lo scenario alternativo */
  onApplyScenario?: (modifiedShifts: VehicleShift[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AnalyzeResponse | null>(null);
  const [syncSchedules, setSyncSchedules] = useState(true);
  const [includeExtraurban, setIncludeExtraurban] = useState(true);
  const [tab, setTab] = useState<"summary" | "hubs" | "coincidences" | "advisories" | "changes" | "scenario">("summary");

  // ── Scenario alternativo (changes applicati) ──
  const [scenarioLoading, setScenarioLoading] = useState(false);
  const [scenarioData, setScenarioData] = useState<AnalyzeResponse | null>(null);
  const [scenarioShifts, setScenarioShifts] = useState<VehicleShift[] | null>(null);

  // ── Progress bar fasi (animazione client-side) ──
  const PHASES = useMemo(() => [
    { key: "discover", label: "Scopro hub di intermodalità (stazioni, porti, aeroporti)", weightMs: 1500 },
    { key: "filter",   label: "Filtro hub fuori dall'area servita", weightMs: 600 },
    { key: "sync",     label: "Sincronizzo orari treni reali (RFI/ViaggiaTreno)", weightMs: 8000 },
    { key: "trains",   label: "Calcolo coincidenze treno → priorità massima", weightMs: 1200 },
    { key: "buses",    label: "Cerco coincidenze con altre linee bus GTFS", weightMs: 2500 },
    { key: "pois",     label: "Identifico POI raggiungibili dagli hub", weightMs: 1500 },
    { key: "advise",   label: "Genero consigli operativi e modifiche orari", weightMs: 600 },
  ], []);
  const [phaseIdx, setPhaseIdx] = useState(0);
  const [progress, setProgress] = useState(0);

  const runAnalysis = useCallback(async () => {
    setLoading(true);
    setPhaseIdx(0);
    setProgress(0);

    // Animazione progress: avanza tra le fasi in base ai pesi (skip "sync" se non attivo)
    const phases = PHASES.filter(p => p.key !== "sync" || syncSchedules);
    const totalWeight = phases.reduce((s, p) => s + p.weightMs, 0);
    const startedAt = Date.now();
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const elapsed = Date.now() - startedAt;
      let cumul = 0;
      let idx = 0;
      for (let i = 0; i < phases.length; i++) {
        if (elapsed < cumul + phases[i].weightMs) { idx = i; break; }
        cumul += phases[i].weightMs;
        idx = i;
      }
      // mappa l'indice locale all'indice originale di PHASES
      const realIdx = PHASES.findIndex(p => p.key === phases[idx].key);
      setPhaseIdx(realIdx);
      // progress 0..95% (l'ultimo 5% si completa al ricevimento risposta)
      const pct = Math.min(95, Math.round((elapsed / totalWeight) * 95));
      setProgress(pct);
      if (elapsed < totalWeight * 1.5) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/intermodal-optimizer/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shifts,
          date,
          syncSchedules,
          includeExtraurban,
          includeOtherBusRoutes: true,
          includePois: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AnalyzeResponse;
      setData(json);
      setProgress(100);
      // reset scenario quando rifacciamo analisi base
      setScenarioData(null);
      setScenarioShifts(null);
      toast.success("Analisi intermodale completata", {
        description: `${json.hubsAnalyzed} hub · ${json.coincidences.length} coincidenze · ${json.metrics.busExtraConnections ?? 0} bus extra · ${json.metrics.poisReached ?? 0} POI`,
      });
    } catch (err: any) {
      toast.error("Errore analisi intermodale", { description: err.message });
    } finally {
      stopped = true;
      setLoading(false);
    }
  }, [shifts, date, syncSchedules, includeExtraurban, PHASES]);

  /** Applica i proposedChanges agli shifts originali producendo uno scenario alternativo */
  const buildScenarioShifts = useCallback((origShifts: VehicleShift[], changes: ProposedChange[]): VehicleShift[] => {
    // Mappa tripId -> delta minuti totale (sommiamo se più change colpiscono stessa corsa)
    const deltaByTrip = new Map<string, number>();
    for (const ch of changes) {
      if (ch.changeType === "add_trip") continue; // non implementato lato client
      deltaByTrip.set(ch.tripId, (deltaByTrip.get(ch.tripId) ?? 0) + ch.shiftMin);
    }
    if (deltaByTrip.size === 0) return origShifts;

    return origShifts.map(sh => {
      let touched = false;
      const newTrips = sh.trips.map(t => {
        const d = deltaByTrip.get(t.tripId);
        if (!d || t.type !== "trip") return t;
        touched = true;
        return {
          ...t,
          departureMin: t.departureMin + d,
          arrivalMin: t.arrivalMin + d,
          departureTime: minutesToTime(t.departureMin + d),
          arrivalTime: minutesToTime(t.arrivalMin + d),
        };
      });
      if (!touched) return sh;
      const startMin = Math.min(...newTrips.map(t => t.departureMin));
      const endMin = Math.max(...newTrips.map(t => t.arrivalMin));
      return {
        ...sh,
        trips: newTrips,
        startMin,
        endMin,
        firstOut: startMin,
        lastIn: endMin,
        shiftDuration: endMin - startMin,
      };
    });
  }, []);

  /** Genera lo scenario: applica changes -> ricalcola analisi sui nuovi shifts */
  const runScenario = useCallback(async () => {
    if (!data || data.proposedChanges.length === 0) return;
    setScenarioLoading(true);
    try {
      const modified = buildScenarioShifts(shifts, data.proposedChanges);
      setScenarioShifts(modified);
      const base = getApiBase();
      const res = await fetch(`${base}/api/intermodal-optimizer/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shifts: modified,
          date,
          syncSchedules: false, // evitiamo nuova sincronizzazione lenta
          includeExtraurban,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AnalyzeResponse;
      setScenarioData(json);
      setTab("scenario");
      toast.success("Scenario alternativo generato", {
        description: `${json.metrics.optimalConnections} ottimali (era ${data.metrics.optimalConnections}) · ${json.metrics.missedConnections} perse (era ${data.metrics.missedConnections})`,
      });
    } catch (err: any) {
      toast.error("Errore generazione scenario", { description: err.message });
    } finally {
      setScenarioLoading(false);
    }
  }, [data, shifts, date, includeExtraurban, buildScenarioShifts]);

  const applyScenario = useCallback(() => {
    if (!scenarioShifts) return;
    onApplyScenario?.(scenarioShifts);
    toast.success("Scenario intermodale applicato", {
      description: "I turni sono stati aggiornati nell'area di lavoro.",
    });
    setOpen(false);
  }, [scenarioShifts, onApplyScenario]);

  const advisoriesBySeverity = useMemo(() => {
    if (!data) return { critical: [] as Advisory[], warning: [] as Advisory[], info: [] as Advisory[] };
    return {
      critical: data.advisories.filter(a => a.severity === "critical"),
      warning: data.advisories.filter(a => a.severity === "warning"),
      info: data.advisories.filter(a => a.severity === "info"),
    };
  }, [data]);

  const coincidencesByHub = useMemo(() => {
    if (!data) return new Map<string, CoincidenceMatch[]>();
    const m = new Map<string, CoincidenceMatch[]>();
    for (const c of data.coincidences) {
      if (!m.has(c.hubId)) m.set(c.hubId, []);
      m.get(c.hubId)!.push(c);
    }
    return m;
  }, [data]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            size="sm"
            variant="outline"
            className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
          >
            <Network className="w-3.5 h-3.5 mr-1.5" />
            Analisi Intermodale
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-5xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Network className="w-5 h-5 text-cyan-400" />
            Analisi Intermodale dei Turni Macchina
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Scopre automaticamente stazioni / porti / aeroporti vicini ai capolinea delle corse
            ottimizzate e calcola le coincidenze considerando il tempo a piedi.
          </p>
        </DialogHeader>

        {/* ── ATTENZIONE: questa analisi MODIFICA gli orari ── */}
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200 leading-relaxed">
            <strong className="text-amber-300">Attenzione:</strong> i consigli intermodali possono richiedere
            di <strong>spostare gli orari di partenza/arrivo delle corse già ottimizzate</strong>.
            Le modifiche non vengono applicate automaticamente: vengono solo proposte nel tab{" "}
            <strong>Modifiche</strong>. Decidi tu se accettarle (manualmente nel Gantt o esportando il CSV).
            Spostare una corsa può cambiare i deadhead, i fabbisogni veicoli e impattare altre coincidenze
            urbane: rivedi sempre l'impatto prima di confermare.
          </div>
        </div>

        {/* ── Controls ── */}
        <div className="flex items-center gap-4 flex-wrap py-2 border-b border-border/30">
          <div className="flex items-center gap-2">
            <Switch id="sync" checked={syncSchedules} onCheckedChange={setSyncSchedules} />
            <Label htmlFor="sync" className="text-xs cursor-pointer">
              Acquisisci orari automaticamente (ViaggiaTreno + GTFS) e salva sulle zone
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="extraurb" checked={includeExtraurban} onCheckedChange={setIncludeExtraurban} />
            <Label htmlFor="extraurb" className="text-xs cursor-pointer">
              Includi linee extraurbane (buffer 3 km)
            </Label>
          </div>

          <Button
            size="sm"
            onClick={runAnalysis}
            disabled={loading || shifts.length === 0}
            className="bg-cyan-600 hover:bg-cyan-700 text-white ml-auto"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            {data ? "Riesegui" : "Avvia analisi"}
          </Button>
        </div>

        {/* ── Empty state ── */}
        {!data && !loading && (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <Network className="w-10 h-10 opacity-30" />
            <p className="text-sm">Premi <strong>Avvia analisi</strong> per scoprire le coincidenze.</p>
            <p className="text-xs max-w-md text-center opacity-70">
              L'analisi userà i {shifts.length} turni macchina correntemente caricati.
              Per orari treni in tempo reale dalla rete RFI attiva la sincronizzazione (può richiedere alcuni secondi per ogni stazione scoperta).
            </p>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-10 gap-4 px-6">
            <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
            <div className="w-full max-w-md">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-cyan-200 font-medium">{PHASES[phaseIdx]?.label ?? "Analisi…"}</span>
                <span className="text-[10px] font-mono text-muted-foreground">{progress}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted/30 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-3 grid grid-cols-1 gap-1">
                {PHASES.map((p, i) => {
                  if (p.key === "sync" && !syncSchedules) return null;
                  const done = i < phaseIdx;
                  const active = i === phaseIdx;
                  return (
                    <div key={p.key} className={`text-[10px] flex items-center gap-1.5 ${
                      done ? "text-emerald-400/80" : active ? "text-cyan-300" : "text-muted-foreground/50"
                    }`}>
                      {done ? <CheckCircle2 className="w-3 h-3" /> :
                       active ? <Loader2 className="w-3 h-3 animate-spin" /> :
                       <Clock className="w-3 h-3 opacity-40" />}
                      <span>{p.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {data && !loading && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="flex-1 flex flex-col overflow-hidden">
            <TabsList className="self-start">
              <TabsTrigger value="summary">Riepilogo</TabsTrigger>
              <TabsTrigger value="hubs">Hub <Badge variant="outline" className="ml-1.5 text-[9px]">{data.hubs.length}</Badge></TabsTrigger>
              <TabsTrigger value="coincidences">Coincidenze <Badge variant="outline" className="ml-1.5 text-[9px]">{data.coincidences.length}</Badge></TabsTrigger>
              <TabsTrigger value="advisories">
                Consigli
                {data.advisories.length > 0 && (
                  <Badge variant="outline" className="ml-1.5 text-[9px] border-amber-500/40 text-amber-400">
                    {data.advisories.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="changes">
                Modifiche orari
                {data.proposedChanges.length > 0 && (
                  <Badge variant="outline" className="ml-1.5 text-[9px] border-rose-500/40 text-rose-400">
                    {data.proposedChanges.length}
                  </Badge>
                )}
              </TabsTrigger>
              {data.proposedChanges.length > 0 && (
                <TabsTrigger value="scenario">
                  Scenario alternativo
                  {scenarioData && (
                    <Badge variant="outline" className="ml-1.5 text-[9px] border-emerald-500/40 text-emerald-400">
                      pronto
                    </Badge>
                  )}
                </TabsTrigger>
              )}
            </TabsList>

            {/* ── SUMMARY ── */}
            <TabsContent value="summary" className="flex-1 overflow-y-auto pt-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <MetricCard
                  label="Hub analizzati"
                  value={data.hubsAnalyzed}
                  sub={
                    data.hubSource === "zones"
                      ? "Zone Coincidenza curate"
                      : data.hubsDiscarded
                        ? `${data.hubsDiscarded} scartati (fuori area)`
                        : "Auto-discovery GTFS"
                  }
                  icon={<MapPin className="w-3 h-3" />}
                />
                <MetricCard label="Corse vicino hub" value={data.metrics.tripsNearHub} sub={`/ ${data.metrics.totalTripsAnalyzed} totali`} icon={<Bus className="w-3 h-3" />} />
                <MetricCard label="Orari treni sync." value={data.schedulesSynced} icon={<Train className="w-3 h-3" />} />
                <MetricCard label="POI raggiungibili" value={data.metrics.poisReached ?? 0} color="#a78bfa" icon={<MapPin className="w-3 h-3" />} />
                <MetricCard label="Coincidenze ottimali" value={data.metrics.optimalConnections} color="#34d399" icon={<CheckCircle2 className="w-3 h-3" />} />
                <MetricCard label="Strette" value={data.metrics.tightConnections} color="#f59e0b" icon={<Clock className="w-3 h-3" />} />
                <MetricCard label="Perse" value={data.metrics.missedConnections} color="#fb7185" icon={<AlertTriangle className="w-3 h-3" />} />
                <MetricCard label="Bus extra (altre linee)" value={data.metrics.busExtraConnections ?? 0} color="#60a5fa" icon={<Bus className="w-3 h-3" />} />
              </div>

              {/* breakdown coincidenze treno vs altri */}
              {(() => {
                const trains = data.coincidences.filter(c => c.priorityClass === "rail");
                const tOpt = trains.filter(c => c.status === "optimal").length;
                const tMis = trains.filter(c => c.status === "missed").length;
                if (trains.length === 0) return null;
                return (
                  <div className="mt-3 p-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-cyan-300 mb-1">
                      <Train className="w-4 h-4" />
                      Treni — priorità massima
                    </div>
                    <p className="text-xs text-cyan-200/80">
                      <strong>{trains.length}</strong> coincidenze totali con treni: <strong>{tOpt}</strong> ottimali, <strong>{tMis}</strong> perse.
                      {tMis > 0 && <span className="text-rose-300"> Verifica subito le perse nel tab Consigli.</span>}
                    </p>
                  </div>
                );
              })()}

              <div className="mt-4 p-3 rounded-lg bg-muted/20 border border-border/30 text-xs text-muted-foreground">
                <strong className="text-foreground">Giorno analizzato:</strong> {DAY_LABELS[data.dayOfWeek]} {data.date}
                {data.bbox && (
                  <> · <strong className="text-foreground">Area:</strong> {data.bbox.minLat.toFixed(3)}–{data.bbox.maxLat.toFixed(3)} N, {data.bbox.minLng.toFixed(3)}–{data.bbox.maxLng.toFixed(3)} E</>
                )}
              </div>

              {advisoriesBySeverity.critical.length > 0 && (
                <div className="mt-3 p-3 rounded-lg border border-rose-500/30 bg-rose-500/5">
                  <div className="flex items-center gap-2 text-sm font-semibold text-rose-300 mb-1">
                    <AlertTriangle className="w-4 h-4" />
                    {advisoriesBySeverity.critical.length} criticità rilevate
                  </div>
                  <p className="text-xs text-rose-300/80">
                    Coincidenze impossibili o treni persi. Vai al tab <em>Consigli</em> per i dettagli operativi.
                  </p>
                </div>
              )}
            </TabsContent>

            {/* ── HUBS ── */}
            <TabsContent value="hubs" className="flex-1 overflow-y-auto pt-2 space-y-2">
              {data.hubs.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Nessun hub trovato nell'area servita.
                </p>
              )}
              {data.hubs.map(h => {
                const matches = coincidencesByHub.get(h.id) || [];
                const opt = matches.filter(c => c.status === "optimal").length;
                return (
                  <div key={h.id} className="rounded-lg border border-border/30 bg-muted/10 p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={h.type === "railway" ? "text-cyan-400" : "text-muted-foreground"}>{HUB_ICON[h.type]}</span>
                      <span className="font-medium text-sm">{h.name}</span>
                      <Badge variant="outline" className="text-[9px]">{h.type}</Badge>
                      {h.source === "gtfs-auto" && <Badge variant="outline" className="text-[9px] border-amber-500/30 text-amber-400">auto</Badge>}
                      {typeof h.nearestTripM === "number" && (
                        <Badge variant="outline" className="text-[9px] border-emerald-500/30 text-emerald-400">
                          {(h.nearestTripM / 1000).toFixed(1)} km da capolinea
                        </Badge>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        <Footprints className="w-3 h-3 inline mr-0.5" />
                        {h.platformWalkMinutes} min binario
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{h.description}</p>
                    <div className="flex items-center gap-3 mt-2 text-[10px]">
                      <span className="text-emerald-400">✓ {opt} coincidenze ottimali</span>
                      <span className="text-muted-foreground">· {matches.length} totali analizzate</span>
                      {h.weeklyDepartures && (
                        <span className="ml-auto text-muted-foreground">
                          {h.weeklyDepartures.reduce((s, d) => s + d.reduce((ss, x) => ss + x.times.length, 0), 0)} treni/settimana
                        </span>
                      )}
                    </div>

                    {/* POI raggiungibili */}
                    {h.pois && h.pois.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/20">
                        <div className="text-[10px] uppercase text-violet-300 mb-1 flex items-center gap-1">
                          <MapPin className="w-2.5 h-2.5" />
                          Dove vanno le persone — {h.pois.length} POI raggiungibili a piedi
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {h.pois.slice(0, 12).map(p => (
                            <Badge
                              key={p.id}
                              variant="outline"
                              className="text-[9px] border-violet-500/30 text-violet-200 bg-violet-500/5"
                              title={`${p.name ?? p.category} · ${p.distM}m · ${p.walkMin.toFixed(0)} min a piedi`}
                            >
                              {POI_ICON[p.category] ?? "📍"} {(p.name ?? p.category).slice(0, 22)}
                              <span className="ml-1 opacity-60">{p.walkMin.toFixed(0)}′</span>
                            </Badge>
                          ))}
                          {h.pois.length > 12 && (
                            <span className="text-[9px] text-muted-foreground self-center">
                              +{h.pois.length - 12} altri
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </TabsContent>

            {/* ── COINCIDENCES ── */}
            <TabsContent value="coincidences" className="flex-1 overflow-y-auto pt-2">
              {data.coincidences.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Nessuna coincidenza individuata. Prova ad attivare la sincronizzazione orari treni reali.
                </p>
              ) : (
                <div className="space-y-1">
                  {data.coincidences
                    .sort((a, b) => {
                      // Priorità modale prima (treno > aereo > nave > bus terminal > altri bus)
                      const prioOrder: Record<string, number> = { rail: 0, air: 1, port: 2, bus_terminal: 3, bus_other: 4 };
                      const pa = prioOrder[a.priorityClass ?? "bus_other"] ?? 9;
                      const pb = prioOrder[b.priorityClass ?? "bus_other"] ?? 9;
                      if (pa !== pb) return pa - pb;
                      // Poi per gravità: missed > tight > optimal > long
                      const order = { missed: 0, tight: 1, optimal: 2, long: 3 };
                      return order[a.status] - order[b.status];
                    })
                    .map((c, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: Math.min(i * 0.005, 0.3) }}
                        className={`text-xs rounded border px-2.5 py-1.5 flex items-center gap-2 ${STATUS_COLOR[c.status]}`}
                      >
                        <span>{HUB_ICON[c.hubType]}</span>
                        <span className="font-medium truncate max-w-[180px]">{c.hubName}</span>
                        {c.priorityClass === "rail" && (
                          <Badge variant="outline" className="text-[9px] border-cyan-500/40 text-cyan-300 shrink-0">PRIORITÀ</Badge>
                        )}
                        {c.priorityClass === "bus_other" && (
                          <Badge variant="outline" className="text-[9px] border-sky-500/40 text-sky-300 shrink-0">bus extra</Badge>
                        )}
                        <Badge variant="outline" className="text-[9px] border-current/30 text-current shrink-0">
                          {STATUS_LABEL[c.status]}
                        </Badge>

                        {c.mode === "arrive_at_hub" ? (
                          <>
                            <span className="opacity-70 shrink-0">Bus arriva</span>
                            <span className="font-mono">{c.busTime}</span>
                            <Footprints className="w-3 h-3 opacity-60" />
                            <span className="opacity-60">{c.walkMin}′</span>
                            <span className="opacity-70 shrink-0">→ Treno {c.trainLabel}</span>
                            <span className="font-mono">{c.trainTime}</span>
                          </>
                        ) : (
                          <>
                            <span className="opacity-70 shrink-0">Treno {c.trainLabel}</span>
                            <span className="font-mono">{c.trainTime}</span>
                            <Footprints className="w-3 h-3 opacity-60" />
                            <span className="opacity-60">{c.walkMin}′</span>
                            <span className="opacity-70 shrink-0">→ Bus parte</span>
                            <span className="font-mono">{c.busTime}</span>
                          </>
                        )}

                        <span className="ml-auto font-mono opacity-80 shrink-0">
                          {c.bufferMin >= 0 ? "+" : ""}{c.bufferMin.toFixed(0)}′
                        </span>
                        <span className="text-[9px] opacity-50 truncate max-w-[100px]">{c.routeName ?? c.routeId}</span>
                      </motion.div>
                    ))}
                </div>
              )}
            </TabsContent>

            {/* ── ADVISORIES ── */}
            <TabsContent value="advisories" className="flex-1 overflow-y-auto pt-2 space-y-2">
              {data.advisories.length === 0 ? (
                <div className="text-center py-12">
                  <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400/60 mb-2" />
                  <p className="text-sm text-emerald-400">Tutto ok! Nessun problema rilevato.</p>
                </div>
              ) : (
                <>
                  {(["critical", "warning", "info"] as const).map(sev => {
                    const list = advisoriesBySeverity[sev];
                    if (list.length === 0) return null;
                    return (
                      <div key={sev} className="space-y-1.5">
                        {list.map(adv => (
                          <div key={adv.id} className={`rounded-lg border px-3 py-2 ${SEVERITY_COLOR[sev]}`}>
                            <div className="flex items-start gap-2 mb-1">
                              <div className="shrink-0 mt-0.5">{SEVERITY_ICON[sev]}</div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold">{adv.title}</div>
                                <div className="text-[11px] opacity-90 mt-0.5">{adv.description}</div>
                                <div className="text-[11px] mt-1.5 px-2 py-1 rounded bg-black/20 border border-current/20">
                                  <strong>💡 Consiglio:</strong> {adv.suggestion}
                                </div>
                                <div className="flex items-center gap-2 mt-1.5 text-[9px] opacity-60">
                                  <MapPin className="w-2.5 h-2.5" />
                                  {adv.hubName}
                                  {adv.shiftId && <> · Turno <span className="font-mono">{adv.shiftId}</span></>}
                                  {adv.tripId && <> · Corsa <span className="font-mono">{adv.tripId}</span></>}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </>
              )}
            </TabsContent>

            {/* ── PROPOSED CHANGES ── */}
            <TabsContent value="changes" className="flex-1 overflow-y-auto pt-2">
              {data.proposedChanges.length === 0 ? (
                <div className="text-center py-12">
                  <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400/60 mb-2" />
                  <p className="text-sm text-emerald-400">Nessuna modifica orari proposta.</p>
                  <p className="text-xs text-muted-foreground mt-1">Gli orari attuali sono già allineati con le coincidenze rilevate.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                    <div className="text-[11px] text-amber-200">
                      <strong>{data.proposedChanges.length} modifich{data.proposedChanges.length === 1 ? "a" : "e"} suggerit{data.proposedChanges.length === 1 ? "a" : "e"}.</strong>{" "}
                      Le modifiche NON sono applicate. Genera lo scenario alternativo per vedere pro/contro, oppure esporta il CSV.
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-amber-500/50 text-amber-300 hover:bg-amber-500/10"
                        onClick={() => exportChangesCsv(data.proposedChanges, data.date)}
                      >
                        <Download className="w-3.5 h-3.5 mr-1.5" />
                        Esporta CSV
                      </Button>
                      <Button
                        size="sm"
                        onClick={runScenario}
                        disabled={scenarioLoading}
                        className="bg-cyan-600 hover:bg-cyan-700 text-white"
                      >
                        {scenarioLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Network className="w-3.5 h-3.5 mr-1.5" />}
                        Genera scenario alternativo
                      </Button>
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-border/30">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/30 text-[10px] uppercase text-muted-foreground">
                        <tr>
                          <th className="text-left px-2 py-1.5">Sev.</th>
                          <th className="text-left px-2 py-1.5">Turno</th>
                          <th className="text-left px-2 py-1.5">Corsa</th>
                          <th className="text-left px-2 py-1.5">Linea</th>
                          <th className="text-left px-2 py-1.5">Hub</th>
                          <th className="text-left px-2 py-1.5">Tipo</th>
                          <th className="text-center px-2 py-1.5">Da</th>
                          <th className="text-center px-2 py-1.5">A</th>
                          <th className="text-right px-2 py-1.5">Δ min</th>
                          <th className="text-left px-2 py-1.5">Motivo</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.proposedChanges
                          .sort((a, b) => {
                            const ord = { critical: 0, warning: 1, info: 2 };
                            return ord[a.severity] - ord[b.severity];
                          })
                          .map((ch, i) => (
                            <tr key={i} className="border-t border-border/20 hover:bg-muted/10">
                              <td className="px-2 py-1.5">
                                <span className={`inline-block w-2 h-2 rounded-full ${
                                  ch.severity === "critical" ? "bg-rose-400" :
                                  ch.severity === "warning" ? "bg-amber-400" : "bg-sky-400"
                                }`} />
                              </td>
                              <td className="px-2 py-1.5 font-mono text-[10px]">{ch.shiftId}</td>
                              <td className="px-2 py-1.5 font-mono text-[10px]">{ch.tripId}</td>
                              <td className="px-2 py-1.5">{ch.routeName ?? "—"}</td>
                              <td className="px-2 py-1.5">{ch.hubName}</td>
                              <td className="px-2 py-1.5">
                                <Badge variant="outline" className="text-[9px]">
                                  <Edit3 className="w-2.5 h-2.5 mr-1" />
                                  {ch.changeType === "shift_departure" ? "partenza" :
                                   ch.changeType === "shift_arrival" ? "arrivo" : "nuova corsa"}
                                </Badge>
                              </td>
                              <td className="px-2 py-1.5 text-center font-mono text-rose-300">{ch.originalTime}</td>
                              <td className="px-2 py-1.5 text-center font-mono">
                                <span className="inline-flex items-center gap-1 text-emerald-300">
                                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                                  {ch.proposedTime}
                                </span>
                              </td>
                              <td className={`px-2 py-1.5 text-right font-mono font-bold ${
                                ch.shiftMin > 0 ? "text-emerald-400" : ch.shiftMin < 0 ? "text-rose-400" : "text-muted-foreground"
                              }`}>
                                {ch.shiftMin > 0 ? `+${ch.shiftMin}` : ch.shiftMin}
                              </td>
                              <td className="px-2 py-1.5 text-[10px] text-muted-foreground max-w-[260px]">{ch.reason}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </TabsContent>

            {/* ── SCENARIO ALTERNATIVO (confronto pro/contro) ── */}
            <TabsContent value="scenario" className="flex-1 overflow-y-auto pt-2 space-y-3">
              {!scenarioData ? (
                <div className="text-center py-12 space-y-3">
                  <Network className="w-10 h-10 mx-auto text-cyan-400/60" />
                  <p className="text-sm">Genera lo scenario alternativo per vedere il confronto.</p>
                  <Button
                    size="sm"
                    onClick={runScenario}
                    disabled={scenarioLoading || data.proposedChanges.length === 0}
                    className="bg-cyan-600 hover:bg-cyan-700 text-white"
                  >
                    {scenarioLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Network className="w-3.5 h-3.5 mr-1.5" />}
                    Genera scenario alternativo
                  </Button>
                </div>
              ) : (
                <ScenarioComparison
                  original={data}
                  scenario={scenarioData}
                  originalShifts={shifts}
                  scenarioShifts={scenarioShifts ?? []}
                  onApply={onApplyScenario ? applyScenario : undefined}
                  onDiscard={() => {
                    setScenarioData(null);
                    setScenarioShifts(null);
                    setTab("changes");
                    toast.info("Scenario scartato");
                  }}
                />
              )}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MetricCard({ label, value, sub, color, icon }: {
  label: string; value: number | string; sub?: string; color?: string; icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/30 bg-muted/10 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
        {icon} {label}
      </div>
      <div className="text-xl font-bold font-mono" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-[9px] text-muted-foreground/70">{sub}</div>}
    </div>
  );
}

function exportChangesCsv(changes: ProposedChange[], date: string) {
  const header = ["severity", "shiftId", "tripId", "routeName", "hubName", "changeType", "originalTime", "proposedTime", "shiftMin", "reason"];
  const rows = changes.map(c => [
    c.severity, c.shiftId, c.tripId, c.routeName ?? "", c.hubName,
    c.changeType, c.originalTime, c.proposedTime, c.shiftMin.toString(), c.reason,
  ]);
  const csv = [header, ...rows]
    .map(r => r.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `intermodal-changes-${date}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ─── Scenario comparison panel ─── */
function ScenarioComparison({
  original,
  scenario,
  originalShifts,
  scenarioShifts,
  onApply,
  onDiscard,
}: {
  original: AnalyzeResponse;
  scenario: AnalyzeResponse;
  originalShifts: VehicleShift[];
  scenarioShifts: VehicleShift[];
  onApply?: () => void;
  onDiscard: () => void;
}) {
  // ── Calcolo metriche di confronto ──
  const dOptimal = scenario.metrics.optimalConnections - original.metrics.optimalConnections;
  const dTight = scenario.metrics.tightConnections - original.metrics.tightConnections;
  const dMissed = scenario.metrics.missedConnections - original.metrics.missedConnections;
  const dLong = scenario.metrics.longWaits - original.metrics.longWaits;
  const dCritical =
    scenario.advisories.filter(a => a.severity === "critical").length -
    original.advisories.filter(a => a.severity === "critical").length;

  const sumDeadhead = (shifts: VehicleShift[]) =>
    shifts.reduce((s, sh) => s + (sh.totalDeadheadMin ?? 0), 0);
  const sumDuration = (shifts: VehicleShift[]) =>
    shifts.reduce((s, sh) => s + (sh.shiftDuration ?? sh.endMin - sh.startMin), 0);

  const dDeadhead = sumDeadhead(scenarioShifts) - sumDeadhead(originalShifts);
  const dDuration = sumDuration(scenarioShifts) - sumDuration(originalShifts);
  const tripsTouched = new Set(
    original.proposedChanges.filter(c => c.changeType !== "add_trip").map(c => c.tripId)
  ).size;

  // pro = miglioramenti, contro = peggioramenti / costi
  const pros: { label: string; value: string }[] = [];
  const cons: { label: string; value: string }[] = [];

  if (dOptimal > 0) pros.push({ label: "Coincidenze ottimali in più", value: `+${dOptimal}` });
  else if (dOptimal < 0) cons.push({ label: "Coincidenze ottimali in meno", value: `${dOptimal}` });

  if (dMissed < 0) pros.push({ label: "Coincidenze perse evitate", value: `${dMissed}` });
  else if (dMissed > 0) cons.push({ label: "Coincidenze perse aggiuntive", value: `+${dMissed}` });

  if (dTight < 0) pros.push({ label: "Coincidenze strette risolte", value: `${dTight}` });
  else if (dTight > 0) cons.push({ label: "Coincidenze strette in più", value: `+${dTight}` });

  if (dLong < 0) pros.push({ label: "Lunghe attese ridotte", value: `${dLong}` });
  else if (dLong > 0) cons.push({ label: "Lunghe attese aggiunte", value: `+${dLong}` });

  if (dCritical < 0) pros.push({ label: "Criticità risolte", value: `${dCritical}` });
  else if (dCritical > 0) cons.push({ label: "Nuove criticità", value: `+${dCritical}` });

  if (dDeadhead > 0) cons.push({ label: "Deadhead totale", value: `+${dDeadhead} min` });
  else if (dDeadhead < 0) pros.push({ label: "Deadhead ridotto", value: `${dDeadhead} min` });

  if (dDuration > 0) cons.push({ label: "Durata turni complessiva", value: `+${dDuration} min` });
  else if (dDuration < 0) pros.push({ label: "Durata turni ridotta", value: `${dDuration} min` });

  if (tripsTouched > 0) cons.push({ label: "Corse spostate", value: `${tripsTouched}` });

  const verdict =
    pros.length > cons.length
      ? { tone: "good", text: "Lo scenario migliora la qualità delle coincidenze." }
      : pros.length === cons.length
      ? { tone: "neutral", text: "Lo scenario è bilanciato: pesa i trade-off." }
      : { tone: "bad", text: "Lo scenario peggiora più aspetti di quanti ne migliori." };

  return (
    <>
      {/* ── Metriche side-by-side ── */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border/40 bg-muted/10 p-3">
          <div className="text-[10px] uppercase text-muted-foreground mb-2">Originale</div>
          <ScenarioMetrics m={original.metrics} crit={original.advisories.filter(a => a.severity === "critical").length} deadhead={sumDeadhead(originalShifts)} duration={sumDuration(originalShifts)} />
        </div>
        <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/5 p-3">
          <div className="text-[10px] uppercase text-cyan-300 mb-2">Scenario alternativo</div>
          <ScenarioMetrics m={scenario.metrics} crit={scenario.advisories.filter(a => a.severity === "critical").length} deadhead={sumDeadhead(scenarioShifts)} duration={sumDuration(scenarioShifts)} />
        </div>
      </div>

      {/* ── Verdetto ── */}
      <div className={`rounded-lg border px-3 py-2 text-sm ${
        verdict.tone === "good" ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300" :
        verdict.tone === "bad" ? "border-rose-500/40 bg-rose-500/5 text-rose-300" :
        "border-sky-500/40 bg-sky-500/5 text-sky-300"
      }`}>
        <strong>Valutazione:</strong> {verdict.text}
      </div>

      {/* ── Pro / Contro ── */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-300 mb-2">
            <CheckCircle2 className="w-4 h-4" /> Pro ({pros.length})
          </div>
          {pros.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Nessun vantaggio rilevato.</p>
          ) : (
            <ul className="space-y-1">
              {pros.map((p, i) => (
                <li key={i} className="flex items-center justify-between text-xs">
                  <span className="text-emerald-200">{p.label}</span>
                  <span className="font-mono font-bold text-emerald-300">{p.value}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-rose-300 mb-2">
            <AlertTriangle className="w-4 h-4" /> Contro ({cons.length})
          </div>
          {cons.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">Nessuno svantaggio rilevato.</p>
          ) : (
            <ul className="space-y-1">
              {cons.map((c, i) => (
                <li key={i} className="flex items-center justify-between text-xs">
                  <span className="text-rose-200">{c.label}</span>
                  <span className="font-mono font-bold text-rose-300">{c.value}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Azioni ── */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/30">
        <Button size="sm" variant="outline" onClick={onDiscard}>
          Mantieni originale
        </Button>
        <Button
          size="sm"
          disabled={!onApply}
          onClick={onApply}
          className="bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
          title={onApply ? "Applica le modifiche orarie ai turni" : "Apri da Area di lavoro per poter applicare lo scenario"}
        >
          <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
          Applica scenario intermodale
        </Button>
      </div>
    </>
  );
}

function ScenarioMetrics({
  m, crit, deadhead, duration,
}: {
  m: AnalyzeResponse["metrics"];
  crit: number;
  deadhead: number;
  duration: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5 text-xs">
      <Stat label="Ottimali" value={m.optimalConnections} color="text-emerald-300" />
      <Stat label="Strette" value={m.tightConnections} color="text-amber-300" />
      <Stat label="Lunghe attese" value={m.longWaits} color="text-sky-300" />
      <Stat label="Perse" value={m.missedConnections} color="text-rose-300" />
      <Stat label="Criticità" value={crit} color="text-rose-300" />
      <Stat label="Deadhead" value={`${deadhead}m`} color="text-foreground" />
      <Stat label="Durata turni" value={`${duration}m`} color="text-foreground" />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="flex items-center justify-between px-2 py-1 rounded bg-black/20">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={`font-mono font-bold text-sm ${color}`}>{value}</span>
    </div>
  );
}
