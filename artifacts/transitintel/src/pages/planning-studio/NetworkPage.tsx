/**
 * PlannerStudio — Network Inspector.
 *
 * Vista relazionale a 3 colonne stile Finder:
 *   [ Tab Linee/Fermate ]  [ Dettaglio entità + relazioni ]  [ Drill-in entità collegata ]
 *
 * Permette di esplorare la rete navigando: Linea → Percorso → Fermata,
 * Fermata → Linea → Percorso, ecc. con dati aggregati lato server.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Network, Bus, MapPin, Search, ChevronRight, Loader2,
  Calendar as CalendarIcon, Building2, Layers, Hash, Info, Route as RouteIcon,
  ArrowLeftRight, Activity,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes, type PsRoute,
  listPsStops, type PsStop,
  getPsRouteDetail, type PsRouteDetail,
  getPsVariantDetail, type PsVariantDetail,
  getPsStopDetail, type PsStopDetail,
} from "@/lib/planning-studio-api";

type Tab = "routes" | "stops";
type Selection =
  | { kind: "route"; id: string }
  | { kind: "stop"; id: string }
  | null;
type Drill =
  | { kind: "variant"; id: string }
  | { kind: "stop"; id: string }
  | { kind: "route"; id: string }
  | null;

const ROUTE_TYPE_LABEL: Record<number, string> = {
  0: "Tram", 1: "Metro", 2: "Treno", 3: "Bus",
  4: "Ferry", 5: "Funivia", 6: "Funicolare", 7: "Cabinovia",
};

function fmtDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

export default function PlanningStudioNetworkPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });
  const routesQ = useQuery({
    queryKey: ["ps", projectId, "routes"],
    queryFn: () => listPsRoutes(projectId),
    enabled: !!projectId,
  });
  const stopsQ = useQuery({
    queryKey: ["ps", projectId, "stops"],
    queryFn: () => listPsStops(projectId),
    enabled: !!projectId,
  });

  const [tab, setTab] = useState<Tab>("routes");
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection>(null);
  const [drill, setDrill] = useState<Drill>(null);

  // reset drill quando cambia selection
  useEffect(() => { setDrill(null); }, [selection?.kind, (selection as any)?.id]);

  const filteredRoutes = useMemo(() => {
    const list = routesQ.data ?? [];
    if (!search) return list;
    const s = search.toLowerCase();
    return list.filter(r =>
      r.shortName.toLowerCase().includes(s) ||
      (r.longName ?? "").toLowerCase().includes(s),
    );
  }, [routesQ.data, search]);

  const filteredStops = useMemo(() => {
    const list = stopsQ.data ?? [];
    if (!search) return list.slice(0, 500);
    const s = search.toLowerCase();
    return list.filter(st =>
      st.name.toLowerCase().includes(s) ||
      (st.code ?? "").toLowerCase().includes(s),
    ).slice(0, 500);
  }, [stopsQ.data, search]);

  const project = projectQ.data;

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <Network className="w-5 h-5 text-violet-400" />
          <h1 className="font-semibold text-sm">Inspector di rete</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name}
          </span>
        )}
      </div>

      {/* 3 colonne */}
      <div className="flex-1 flex overflow-hidden">
        {/* Col 1 — Lista */}
        <aside className="w-[320px] border-r border-slate-800 flex flex-col bg-slate-950">
          {/* Tab switcher */}
          <div className="flex border-b border-slate-800">
            <button
              onClick={() => { setTab("routes"); setSelection(null); }}
              className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 ${
                tab === "routes"
                  ? "text-violet-300 border-b-2 border-violet-400 bg-slate-900/40"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Bus className="w-3.5 h-3.5" /> Linee
              {routesQ.data && <span className="text-[10px] text-slate-600">({routesQ.data.length})</span>}
            </button>
            <button
              onClick={() => { setTab("stops"); setSelection(null); }}
              className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 ${
                tab === "stops"
                  ? "text-violet-300 border-b-2 border-violet-400 bg-slate-900/40"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <MapPin className="w-3.5 h-3.5" /> Fermate
              {stopsQ.data && <span className="text-[10px] text-slate-600">({stopsQ.data.length})</span>}
            </button>
          </div>

          {/* Search */}
          <div className="p-2 border-b border-slate-800">
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder={tab === "routes" ? "Cerca linea…" : "Cerca fermata…"}
                className="w-full pl-7 pr-2 py-1.5 rounded bg-slate-900 border border-slate-800 text-xs"
              />
            </div>
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-auto">
            {tab === "routes" && (
              <RoutesList
                routes={filteredRoutes}
                selectedId={selection?.kind === "route" ? selection.id : null}
                onSelect={id => setSelection({ kind: "route", id })}
              />
            )}
            {tab === "stops" && (
              <StopsList
                stops={filteredStops}
                selectedId={selection?.kind === "stop" ? selection.id : null}
                onSelect={id => setSelection({ kind: "stop", id })}
              />
            )}
          </div>
          {tab === "stops" && (stopsQ.data?.length ?? 0) > 500 && !search && (
            <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-600">
              Mostrate prime 500 — usa la ricerca
            </div>
          )}
        </aside>

        {/* Col 2 — Dettaglio entità selezionata */}
        <section className="flex-1 overflow-auto bg-slate-950 border-r border-slate-800">
          {!selection && (
            <Empty>
              <Info className="w-6 h-6 mb-2" />
              Seleziona una linea o una fermata per vederne i dettagli.
            </Empty>
          )}
          {selection?.kind === "route" && (
            <RouteDetailPanel
              projectId={projectId} routeId={selection.id}
              onDrillVariant={id => setDrill({ kind: "variant", id })}
              onDrillStop={id => setDrill({ kind: "stop", id })}
              activeDrill={drill}
            />
          )}
          {selection?.kind === "stop" && (
            <StopDetailPanel
              projectId={projectId} stopId={selection.id}
              onDrillVariant={id => setDrill({ kind: "variant", id })}
              onDrillRoute={id => setDrill({ kind: "route", id })}
              activeDrill={drill}
            />
          )}
        </section>

        {/* Col 3 — Drill-in */}
        <section className="w-[420px] overflow-auto bg-slate-950">
          {!drill && (
            <Empty>
              <ChevronRight className="w-6 h-6 mb-2" />
              Clicca su un percorso, fermata o linea collegata per esplorare.
            </Empty>
          )}
          {drill?.kind === "variant" && (
            <VariantDetailPanel
              projectId={projectId} variantId={drill.id}
              onJumpToRoute={(rid) => { setSelection({ kind: "route", id: rid }); setDrill(null); }}
              onJumpToStop={(sid) => { setSelection({ kind: "stop", id: sid }); setDrill(null); }}
            />
          )}
          {drill?.kind === "stop" && (
            <StopMiniPanel
              projectId={projectId} stopId={drill.id}
              onJump={() => { setTab("stops"); setSelection({ kind: "stop", id: drill.id }); setDrill(null); }}
            />
          )}
          {drill?.kind === "route" && (
            <RouteMiniPanel
              projectId={projectId} routeId={drill.id}
              onJump={() => { setTab("routes"); setSelection({ kind: "route", id: drill.id }); setDrill(null); }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/* ─── Lista linee ─── */
function RoutesList({ routes, selectedId, onSelect }: {
  routes: PsRoute[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  if (routes.length === 0) return <Empty small>Nessuna linea.</Empty>;
  return (
    <ul>
      {routes.map(r => (
        <li key={r.id}>
          <button
            onClick={() => onSelect(r.id)}
            className={`w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900 flex items-center gap-2 ${
              selectedId === r.id ? "bg-violet-500/10 border-l-2 border-l-violet-400" : ""
            }`}
          >
            <span
              className="w-7 h-7 shrink-0 rounded flex items-center justify-center text-[11px] font-bold"
              style={{
                backgroundColor: r.color ? `#${r.color}` : "#475569",
                color: r.textColor ? `#${r.textColor}` : "#fff",
              }}
            >
              {r.shortName}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-slate-200 truncate">{r.longName || r.shortName}</div>
              <div className="text-[10px] text-slate-500">
                {ROUTE_TYPE_LABEL[r.routeType] ?? "—"} · {r.variantCount ?? 0} percorsi
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ─── Lista fermate ─── */
function StopsList({ stops, selectedId, onSelect }: {
  stops: PsStop[]; selectedId: string | null; onSelect: (id: string) => void;
}) {
  if (stops.length === 0) return <Empty small>Nessuna fermata.</Empty>;
  return (
    <ul>
      {stops.map(s => (
        <li key={s.id}>
          <button
            onClick={() => onSelect(s.id)}
            className={`w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900 flex items-center gap-2 ${
              selectedId === s.id ? "bg-violet-500/10 border-l-2 border-l-violet-400" : ""
            }`}
          >
            <MapPin className="w-3.5 h-3.5 text-slate-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-200 truncate">{s.name}</div>
              <div className="text-[10px] text-slate-500 font-mono">
                {s.code || s.id.slice(0, 8)}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ─── Dettaglio linea ─── */
function RouteDetailPanel({ projectId, routeId, onDrillVariant, onDrillStop, activeDrill }: {
  projectId: string; routeId: string;
  onDrillVariant: (id: string) => void; onDrillStop: (id: string) => void;
  activeDrill: Drill;
}) {
  const q = useQuery({
    queryKey: ["ps", projectId, "route-detail", routeId],
    queryFn: () => getPsRouteDetail(projectId, routeId),
  });
  if (q.isLoading) return <LoadingPanel />;
  if (q.isError || !q.data) return <Empty>Errore caricamento</Empty>;
  const d: PsRouteDetail = q.data;
  const r = d.route;

  return (
    <div className="p-5 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 pb-4 border-b border-slate-800">
        <div
          className="w-12 h-12 shrink-0 rounded-lg flex items-center justify-center text-base font-bold"
          style={{
            backgroundColor: r.color ? `#${r.color}` : "#475569",
            color: r.textColor ? `#${r.textColor}` : "#fff",
          }}
        >
          {r.shortName}
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold">{r.longName || r.shortName}</h2>
          <div className="text-xs text-slate-500 mt-0.5">
            {ROUTE_TYPE_LABEL[r.routeType] ?? "—"}
            {r.code && <> · <Hash className="w-3 h-3 inline" />{r.code}</>}
          </div>
          {r.description && <p className="text-xs text-slate-400 mt-2">{r.description}</p>}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2">
        <Stat icon={<RouteIcon className="w-3.5 h-3.5" />} label="Percorsi" value={d.variants.length} />
        <Stat icon={<MapPin className="w-3.5 h-3.5" />} label="Fermate" value={d.stops.length} />
        <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Corse tot." value={d.tripCount} />
        <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Attive" value={d.activeCount}
          tone={d.activeCount === d.tripCount ? "ok" : "warn"} />
      </div>

      {/* Agency */}
      <Section title="Azienda esercente" icon={<Building2 className="w-3.5 h-3.5" />}>
        <div className="text-xs text-slate-300">
          {d.agency.name || <span className="text-slate-600">Non specificata</span>}
        </div>
        {d.agency.url && <div className="text-[10px] text-slate-500 mt-0.5">{d.agency.url}</div>}
        {d.agency.timezone && <div className="text-[10px] text-slate-500">Fuso: {d.agency.timezone}</div>}
      </Section>

      {/* Validità */}
      <Section title="Validità" icon={<CalendarIcon className="w-3.5 h-3.5" />}>
        <div className="text-xs text-slate-300">
          {d.validity.from || d.validity.to ? (
            <>{fmtDate(d.validity.from)} → {fmtDate(d.validity.to)}</>
          ) : (
            <span className="text-slate-600">Non definita (dipende dai calendari)</span>
          )}
        </div>
      </Section>

      {/* Percorsi */}
      <Section title={`Percorsi (${d.variants.length})`} icon={<RouteIcon className="w-3.5 h-3.5" />}>
        <ul className="space-y-1">
          {d.variants.map(v => {
            const isActive = activeDrill?.kind === "variant" && activeDrill.id === v.id;
            return (
              <li key={v.id}>
                <button
                  onClick={() => onDrillVariant(v.id)}
                  className={`w-full text-left p-2 rounded hover:bg-slate-900 flex items-center gap-2 ${
                    isActive ? "bg-violet-500/10 ring-1 ring-violet-400/40" : "bg-slate-900/40"
                  }`}
                >
                  <ArrowLeftRight className="w-3.5 h-3.5 text-slate-600 shrink-0"
                    style={{ transform: v.direction === 1 ? "scaleX(-1)" : undefined }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-200 truncate">
                      {v.name}
                      {v.isDefault && <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-cyan-500/20 text-cyan-300">DEFAULT</span>}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {v.stopCount} fermate · {v.tripCount} corse
                      {!v.hasShape && <span className="text-amber-500"> · no shape</span>}
                    </div>
                  </div>
                  <ChevronRight className="w-3 h-3 text-slate-600" />
                </button>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* Fermate aggregate */}
      <Section title={`Fermate uniche servite (${d.stops.length})`} icon={<MapPin className="w-3.5 h-3.5" />}>
        <div className="max-h-[300px] overflow-auto -mx-1">
          <ul className="space-y-0.5">
            {d.stops.map(s => (
              <li key={s.id}>
                <button
                  onClick={() => onDrillStop(s.id)}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-slate-900 flex items-center gap-2 text-xs"
                >
                  <MapPin className="w-3 h-3 text-slate-600 shrink-0" />
                  <span className="flex-1 truncate text-slate-300">{s.name}</span>
                  <span className="text-[10px] text-slate-600">{s.variantCount}p</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </div>
  );
}

/* ─── Dettaglio fermata ─── */
function StopDetailPanel({ projectId, stopId, onDrillVariant, onDrillRoute, activeDrill }: {
  projectId: string; stopId: string;
  onDrillVariant: (id: string) => void; onDrillRoute: (id: string) => void;
  activeDrill: Drill;
}) {
  const q = useQuery({
    queryKey: ["ps", projectId, "stop-detail", stopId],
    queryFn: () => getPsStopDetail(projectId, stopId),
  });
  if (q.isLoading) return <LoadingPanel />;
  if (q.isError || !q.data) return <Empty>Errore caricamento</Empty>;
  const d: PsStopDetail = q.data;
  const s = d.stop;

  return (
    <div className="p-5 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 pb-4 border-b border-slate-800">
        <div className="w-12 h-12 rounded-lg bg-emerald-500/20 flex items-center justify-center">
          <MapPin className="w-6 h-6 text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold truncate">{s.name}</h2>
          <div className="text-xs text-slate-500 mt-0.5 font-mono">
            {s.code && <>{s.code} · </>}{s.id.slice(0, 8)}…
          </div>
          <div className="text-[10px] text-slate-500 mt-1">
            {s.lat.toFixed(6)}, {s.lon.toFixed(6)}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat icon={<Bus className="w-3.5 h-3.5" />} label="Linee" value={d.routes.length} />
        <Stat icon={<RouteIcon className="w-3.5 h-3.5" />} label="Percorsi" value={d.routes.reduce((a, r) => a + r.variants.length, 0)} />
        <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Corse" value={d.totalTripCount} />
      </div>

      {/* Cluster */}
      {d.cluster && (
        <Section title="Nodo di appartenenza" icon={<Layers className="w-3.5 h-3.5" />}>
          <div className="text-xs text-slate-300">
            {d.cluster.name}
            {d.cluster.kind === "interchange" && (
              <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                PUNTO DI CAMBIO
              </span>
            )}
          </div>
        </Section>
      )}

      {/* Linee che la toccano */}
      <Section title={`Linee che transitano (${d.routes.length})`} icon={<Bus className="w-3.5 h-3.5" />}>
        {d.routes.length === 0 && <div className="text-xs text-slate-600">Nessuna linea.</div>}
        <ul className="space-y-2">
          {d.routes.map(r => (
            <li key={r.id} className="bg-slate-900/40 rounded p-2">
              <button
                onClick={() => onDrillRoute(r.id)}
                className="w-full flex items-center gap-2 mb-1.5 hover:bg-slate-800 -m-1 p-1 rounded"
              >
                <span
                  className="w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-bold"
                  style={{
                    backgroundColor: r.color ? `#${r.color}` : "#475569",
                    color: r.textColor ? `#${r.textColor}` : "#fff",
                  }}
                >
                  {r.shortName}
                </span>
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-xs text-slate-200 truncate">{r.longName || r.shortName}</div>
                  <div className="text-[10px] text-slate-500">{r.totalTrips} corse totali</div>
                </div>
                <ChevronRight className="w-3 h-3 text-slate-600" />
              </button>
              <ul className="ml-9 space-y-0.5">
                {r.variants.map(v => {
                  const isActive = activeDrill?.kind === "variant" && activeDrill.id === v.id;
                  return (
                    <li key={v.id}>
                      <button
                        onClick={() => onDrillVariant(v.id)}
                        className={`w-full text-left px-2 py-1 rounded hover:bg-slate-800 flex items-center gap-1.5 text-[11px] ${
                          isActive ? "bg-violet-500/10 ring-1 ring-violet-400/40" : ""
                        }`}
                      >
                        <ArrowLeftRight className="w-3 h-3 text-slate-600"
                          style={{ transform: v.direction === 1 ? "scaleX(-1)" : undefined }} />
                        <span className="flex-1 text-slate-300 truncate">{v.name}</span>
                        <span className="text-[10px] text-slate-500">{v.tripCount}c</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      {/* Dati base */}
      <Section title="Dati fermata" icon={<Info className="w-3.5 h-3.5" />}>
        <dl className="text-xs space-y-1">
          <Field label="Tipo">{s.locationType === 0 ? "Fermata" : s.locationType === 1 ? "Stazione" : "Altro"}</Field>
          {s.platformCode && <Field label="Banchina">{s.platformCode}</Field>}
          {s.zoneId && <Field label="Zona tariffaria">{s.zoneId}</Field>}
          <Field label="Accessibilità">
            {s.wheelchairBoarding === 1 ? "Sì" : s.wheelchairBoarding === 2 ? "No" : "Sconosciuta"}
          </Field>
          {s.description && <Field label="Note">{s.description}</Field>}
        </dl>
      </Section>
    </div>
  );
}

/* ─── Drill: dettaglio percorso (variant) ─── */
function VariantDetailPanel({ projectId, variantId, onJumpToRoute, onJumpToStop }: {
  projectId: string; variantId: string;
  onJumpToRoute: (rid: string) => void;
  onJumpToStop: (sid: string) => void;
}) {
  const q = useQuery({
    queryKey: ["ps", projectId, "variant-detail", variantId],
    queryFn: () => getPsVariantDetail(projectId, variantId),
  });
  if (q.isLoading) return <LoadingPanel />;
  if (q.isError || !q.data) return <Empty>Errore</Empty>;
  const d: PsVariantDetail = q.data;
  const r = d.route;

  return (
    <div className="p-4 space-y-4">
      <div className="pb-3 border-b border-slate-800">
        <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-2">Percorso</div>
        <button
          onClick={() => onJumpToRoute(r.id)}
          className="flex items-center gap-2 mb-2 hover:bg-slate-900 -m-1 p-1 rounded"
        >
          <span
            className="w-6 h-6 rounded text-[10px] font-bold flex items-center justify-center"
            style={{
              backgroundColor: r.color ? `#${r.color}` : "#475569",
              color: r.textColor ? `#${r.textColor}` : "#fff",
            }}
          >
            {r.shortName}
          </span>
          <span className="text-xs text-slate-400 truncate">{r.longName || r.shortName}</span>
        </button>
        <h3 className="text-sm font-semibold">{d.variant.name}</h3>
        {d.variant.headsign && <div className="text-xs text-slate-500">→ {d.variant.headsign}</div>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat icon={<MapPin className="w-3.5 h-3.5" />} label="Fermate" value={d.stops.length} />
        <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Corse" value={d.trips.total} />
        <Stat icon={<RouteIcon className="w-3.5 h-3.5" />} label="Lunghezza"
          value={d.shape?.distanceM ? `${(d.shape.distanceM / 1000).toFixed(1)}km` : "—"} />
      </div>

      <Section title="Sequenza fermate" icon={<MapPin className="w-3.5 h-3.5" />}>
        <ol className="space-y-0.5">
          {d.stops.map(s => (
            <li key={`${s.seq}-${s.stopId}`}>
              <button
                onClick={() => onJumpToStop(s.stopId)}
                className="w-full text-left px-2 py-1 rounded hover:bg-slate-900 flex items-center gap-2 text-xs"
              >
                <span className="w-5 text-[10px] text-slate-600 font-mono text-right">{s.seq}</span>
                <span className="flex-1 truncate text-slate-300">{s.name}</span>
                {s.timepoint === 1 && <span className="text-[9px] text-amber-400">⏱</span>}
              </button>
            </li>
          ))}
        </ol>
      </Section>

      {d.trips.sample.length > 0 && (
        <Section title={`Corse (${d.trips.total})`} icon={<Activity className="w-3.5 h-3.5" />}>
          <div className="max-h-[200px] overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="text-slate-500">
                <tr><th className="text-left p-1">Partenza</th><th className="text-left p-1">Cal.</th><th className="text-left p-1">Validità</th></tr>
              </thead>
              <tbody>
                {d.trips.sample.map(t => (
                  <tr key={t.id} className={`border-t border-slate-900 ${!t.isActive ? "opacity-50" : ""}`}>
                    <td className="p-1 font-mono text-slate-300">{t.firstDeparture?.slice(0, 5) ?? "—"}</td>
                    <td className="p-1 text-slate-500">{t.calendarCode || "—"}</td>
                    <td className="p-1 text-slate-500 text-[10px]">
                      {t.validFrom || t.validTo ? `${fmtDate(t.validFrom)}→${fmtDate(t.validTo)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.trips.total > d.trips.sample.length && (
              <div className="text-[10px] text-slate-600 text-center mt-2">
                ({d.trips.total - d.trips.sample.length} altre…)
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ─── Mini-panels per drill semplici ─── */
function StopMiniPanel({ projectId, stopId, onJump }: {
  projectId: string; stopId: string; onJump: () => void;
}) {
  const q = useQuery({
    queryKey: ["ps", projectId, "stop-detail", stopId],
    queryFn: () => getPsStopDetail(projectId, stopId),
  });
  if (q.isLoading) return <LoadingPanel />;
  if (!q.data) return <Empty>Errore</Empty>;
  const s = q.data.stop;
  return (
    <div className="p-4 space-y-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">Fermata</div>
      <h3 className="text-sm font-semibold">{s.name}</h3>
      <div className="text-xs text-slate-500 font-mono">{s.code || s.id.slice(0, 8)}</div>
      <div className="grid grid-cols-2 gap-2">
        <Stat icon={<Bus className="w-3.5 h-3.5" />} label="Linee" value={q.data.routes.length} />
        <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Corse" value={q.data.totalTripCount} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {q.data.routes.map(r => (
          <span key={r.id}
            className="px-2 py-0.5 rounded text-[10px] font-bold"
            style={{
              backgroundColor: r.color ? `#${r.color}` : "#475569",
              color: r.textColor ? `#${r.textColor}` : "#fff",
            }}
          >{r.shortName}</span>
        ))}
      </div>
      <button onClick={onJump}
        className="w-full px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-xs">
        Apri fermata
      </button>
    </div>
  );
}
function RouteMiniPanel({ projectId, routeId, onJump }: {
  projectId: string; routeId: string; onJump: () => void;
}) {
  const q = useQuery({
    queryKey: ["ps", projectId, "route-detail", routeId],
    queryFn: () => getPsRouteDetail(projectId, routeId),
  });
  if (q.isLoading) return <LoadingPanel />;
  if (!q.data) return <Empty>Errore</Empty>;
  const d = q.data;
  return (
    <div className="p-4 space-y-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">Linea</div>
      <div className="flex items-center gap-2">
        <span className="w-9 h-9 rounded text-sm font-bold flex items-center justify-center"
          style={{
            backgroundColor: d.route.color ? `#${d.route.color}` : "#475569",
            color: d.route.textColor ? `#${d.route.textColor}` : "#fff",
          }}>{d.route.shortName}</span>
        <h3 className="text-sm font-semibold flex-1">{d.route.longName || d.route.shortName}</h3>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat icon={<RouteIcon className="w-3.5 h-3.5" />} label="Percorsi" value={d.variants.length} />
        <Stat icon={<MapPin className="w-3.5 h-3.5" />} label="Fermate" value={d.stops.length} />
        <Stat icon={<Activity className="w-3.5 h-3.5" />} label="Corse" value={d.tripCount} />
      </div>
      <div className="text-xs text-slate-400">
        Esercente: {d.agency.name || "—"}
      </div>
      <button onClick={onJump}
        className="w-full px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-500 text-white text-xs">
        Apri linea
      </button>
    </div>
  );
}

/* ─── Atomi UI ─── */
function Section({ title, icon, children }: {
  title: string; icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-500 mb-2">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}
function Stat({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: number | string;
  tone?: "ok" | "warn";
}) {
  const valueColor = tone === "warn" ? "text-amber-300" : tone === "ok" ? "text-emerald-300" : "text-slate-100";
  return (
    <div className="bg-slate-900/50 rounded p-2 border border-slate-800">
      <div className="flex items-center gap-1 text-[10px] text-slate-500 uppercase">
        {icon}<span>{label}</span>
      </div>
      <div className={`text-sm font-semibold mt-0.5 ${valueColor}`}>{value}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500 w-24 shrink-0">{label}</dt>
      <dd className="text-slate-300 flex-1">{children}</dd>
    </div>
  );
}
function Empty({ children, small }: { children: React.ReactNode; small?: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center text-slate-600 ${
      small ? "p-6 text-xs" : "h-full p-8 text-sm"
    }`}>
      {children}
    </div>
  );
}
function LoadingPanel() {
  return (
    <div className="flex items-center justify-center h-full text-slate-500">
      <Loader2 className="w-5 h-5 animate-spin" />
    </div>
  );
}
