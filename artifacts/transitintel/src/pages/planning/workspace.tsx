/**
 * PlannerStudio — Workspace scenario (3 tab placeholder: Mappa / Orari / Analisi)
 */
import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  ArrowLeft, Loader2, AlertTriangle, Layers, Map as MapIcon,
  Clock, BarChart3, Edit3, Construction,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import UnifiedAnalysisTab from "@/components/planning/UnifiedAnalysisTab";
import { PlanningFiltersProvider } from "@/components/planning/PlanningFiltersContext";

interface Scenario {
  id: string;
  name: string;
  description: string | null;
  baselineFeedId: string;
  mode: "single" | "ab";
  status: string;
  summary: { editsCount?: number; routesAffected?: number } | null;
  createdAt: string;
  updatedAt: string;
}

interface BaselineFeed {
  id: string;
  filename: string;
  agencyName: string | null;
  routesCount: number | null;
  stopsCount: number | null;
  tripsCount: number | null;
}

interface ScenarioEdit {
  id: string;
  editType: string;
  targetType: string;
  targetId: string | null;
  appliedAt: string;
}

type Tab = "map" | "timetable" | "analysis";

export default function PlanningWorkspacePage() {
  const [, params] = useRoute("/planning/:scenarioId/workspace");
  const scenarioId = params?.scenarioId;

  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [baselineFeed, setBaselineFeed] = useState<BaselineFeed | null>(null);
  const [recentEdits, setRecentEdits] = useState<ScenarioEdit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("map");

  useEffect(() => {
    if (!scenarioId) return;
    apiFetch<{
      scenario: Scenario;
      baselineFeed: BaselineFeed | null;
      recentEdits: ScenarioEdit[];
    }>(`/api/planning/scenarios/${scenarioId}`)
      .then((d) => {
        setScenario(d.scenario);
        setBaselineFeed(d.baselineFeed);
        setRecentEdits(d.recentEdits || []);
      })
      .catch((e) => setError(e?.message || "Errore caricamento scenario"))
      .finally(() => setLoading(false));
  }, [scenarioId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !scenario) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Link href="/planning">
          <a className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
            <ArrowLeft className="w-4 h-4" /> Torna ai scenari
          </a>
        </Link>
        <div className="flex items-center gap-3 p-4 bg-destructive/10 text-destructive rounded-lg">
          <AlertTriangle className="w-5 h-5" />
          <span>{error || "Scenario non trovato"}</span>
        </div>
      </div>
    );
  }

  return (
    <PlanningFiltersProvider>
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="border-b border-border bg-card px-6 py-3">
        <Link href="/planning">
          <a className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-1">
            <ArrowLeft className="w-3 h-3" /> Scenari
          </a>
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-primary/10 rounded-md">
              <Layers className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">{scenario.name}</h1>
              <p className="text-xs text-muted-foreground">
                {baselineFeed?.filename || "—"} · {baselineFeed?.agencyName || "—"} ·{" "}
                {baselineFeed?.routesCount ?? 0} linee · {baselineFeed?.stopsCount ?? 0} fermate
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`px-2 py-0.5 rounded-full ${
                scenario.mode === "ab"
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {scenario.mode === "ab" ? "A/B Comparison" : "Single"}
            </span>
            <span
              className={`px-2 py-0.5 rounded-full ${
                scenario.status === "draft"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-green-100 text-green-700"
              }`}
            >
              {scenario.status}
            </span>
            <span className="text-muted-foreground">
              {scenario.summary?.editsCount ?? 0} modifiche
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border bg-card px-6">
        <div className="flex gap-1">
          {[
            { id: "map" as Tab, label: "Mappa A/B", icon: MapIcon },
            { id: "timetable" as Tab, label: "Orari (TTD)", icon: Clock },
            { id: "analysis" as Tab, label: "Analisi", icon: BarChart3 },
          ].map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm border-b-2 transition ${
                  active
                    ? "border-primary text-primary font-medium"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto bg-background">
        {tab === "map" && <MapTabPlaceholder />}
        {tab === "timetable" && <TimetableTabPlaceholder />}
        {tab === "analysis" && (
          <div className="p-6 max-w-7xl mx-auto">
            {/* Scheda unica: Copertura & Domanda + Pianificazione & Costi */}
            <UnifiedAnalysisTab feedId={scenario?.baselineFeedId ?? null} />
          </div>
        )}
      </div>

      {/* Sidebar destra: edits recenti */}
      {recentEdits.length > 0 && (
        <div className="border-t border-border bg-card px-6 py-2 text-xs text-muted-foreground">
          <span className="font-medium">Ultime modifiche:</span> {recentEdits.length} eventi
        </div>
      )}
    </div>
    </PlanningFiltersProvider>
  );
}

/* ────────────────────────── placeholders ────────────────────────── */

function MapTabPlaceholder() {
  return (
    <PlaceholderCard
      icon={MapIcon}
      title="Editor mappa A/B"
      desc="Mappa interattiva con layer baseline (azzurro) vs scenario (arancio), swipe e drawer di modifica linee/fermate."
      next={[
        "Layer Mapbox baseline + scenario con shapes/stops GTFS",
        "RouteEditDrawer (modifica frequenze, sposta fermate)",
        "StopEditDrawer (sposta, rimuovi, aggiungi fermata)",
        "Edit log persistente + undo",
      ]}
    />
  );
}

function TimetableTabPlaceholder() {
  return (
    <PlaceholderCard
      icon={Clock}
      title="Time-Distance Diagram"
      desc="Grafico TTD interattivo per visualizzare tutti i viaggi di una linea: posizione fermate (Y) vs orari (X), con confronto A/B."
      next={[
        "Selezione linea da analizzare",
        "Render SVG/Canvas dei viaggi baseline + scenario",
        "Tooltip per viaggio (corsa, conducente, deposito)",
        "Edit drag-and-drop di frequenze",
      ]}
    />
  );
}

function AnalysisTabPlaceholder() {
  return (
    <PlaceholderCard
      icon={BarChart3}
      title="Analisi & KPI"
      desc="Quattro moduli di analisi quantitativa con confronto delta baseline vs scenario."
      next={[
        "Copertura del servizio (km/h, frequenze, isocrone)",
        "Domanda vs offerta (validazioni vs posti offerti)",
        "Utilità trip (% riempimento, sovrapposizioni)",
        "Impatto economico (ricavi / costi vettura-km / driver-h)",
      ]}
    />
  );
}

function PlaceholderCard({
  icon: Icon,
  title,
  desc,
  next,
}: {
  icon: any;
  title: string;
  desc: string;
  next: string[];
}) {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="border-2 border-dashed border-border rounded-lg p-8 text-center bg-card">
        <div className="inline-flex p-3 bg-primary/10 rounded-full mb-3">
          <Icon className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-xl font-semibold mb-2">{title}</h2>
        <p className="text-sm text-muted-foreground mb-6 max-w-xl mx-auto">{desc}</p>

        <div className="text-left bg-muted/50 rounded-md p-4 max-w-xl mx-auto">
          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            <Construction className="w-3.5 h-3.5" />
            Roadmap layer 2/3
          </div>
          <ul className="text-sm space-y-1.5">
            {next.map((n, i) => (
              <li key={i} className="flex items-start gap-2">
                <Edit3 className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
