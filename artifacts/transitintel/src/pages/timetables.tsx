/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI — dal programma di esercizio del progetto Planning Studio
 * ───────────────────────────────────────────────────────────────────────────
 * Si sceglie il PROGETTO + le LINEE + i DAY-TYPE (es. "Feriale Scuole Aperte"),
 * e il sistema genera:
 *  - Orari per il pubblico: orario generale per linea × day-type (A4 orizz.);
 *  - Quadri di palina: per ogni fermata delle linee scelte, tutte le linee che
 *    vi passano (A4 verticale, una fermata per pagina).
 * Dati e validità vengono dalle tabelle ps_* del progetto (ps_trip_day_validity).
 * La stampa apre una finestra con HTML standalone + window.print().
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRight, Loader2, MapPin, Printer, Search, SignpostBig,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

/* ─── Tipi (allineati a /api/planning-studio/:projectId/timetables/*) ─── */

interface StopSearchItem {
  stopId: string; stopName: string; stopCode: string | null;
  lat: number; lon: number; routes: string[];
}

interface StopTimetable {
  feedId: string;
  dayTypeId?: string | null;
  dayTypeName?: string | null;
  validityNote?: string | null;
  stop: { stopId: string; stopName: string; stopCode: string | null };
  lines: Array<{
    routeId: string; shortName: string | null; longName: string | null; color: string | null;
    headsigns: string[]; total: number;
    byHour: Array<{ hour: number; departures: Array<{ minute: number; headsignIdx: number }> }>;
  }>;
}

interface RouteTimetable {
  feedId: string;
  directionId: number | null;
  dayTypeId?: string | null;
  dayTypeName?: string | null;
  validityNote?: string | null;
  route: { routeId: string; shortName: string | null; longName: string | null; color: string | null };
  stops: Array<{ stopId: string; stopName: string }>;
  trips: Array<{ tripId: string; headsign: string | null; directionId: number | null; times: (string | null)[] }>;
}

interface PsRoute {
  routeId: string; routeShortName: string | null; routeLongName: string | null; routeColor: string | null;
}
interface PsProject { id: string; name: string }
interface PsDayType { id: string; code: string; name: string; color: string }

const DEFAULT_PROJECT_ID = "722e651e-42e9-4284-8483-21fe15d30caf";

/* ─── Helpers stampa ─── */

function lineColor(c: string | null | undefined): string {
  if (!c) return "#0f172a";
  return c.startsWith("#") ? c : `#${c}`;
}

function openPrintWindow(html: string) {
  const w = window.open("", "_blank");
  if (!w) { toast.error("Popup bloccata dal browser: consenti i popup per stampare"); return; }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* l'utente stampa dal menu */ } }, 400);
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRINT_BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; background: #fff; }
  .page { page-break-after: always; padding: 10mm 12mm; }
  .page:last-child { page-break-after: auto; }
  header.doc { display: flex; align-items: center; gap: 10px; border-bottom: 3px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
  header.doc .pill { color: #fff; font-weight: 800; border-radius: 8px; padding: 4px 12px; font-size: 22px; }
  header.doc h1 { font-size: 20px; line-height: 1.15; }
  header.doc .day { margin-left: auto; text-align: right; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  footer.doc { margin-top: 8px; border-top: 1px solid #999; padding-top: 4px; font-size: 9px; color: #555; display: flex; justify-content: space-between; }
`;

/* ── Quadro di palina (A4 verticale) ── */

const STOP_POSTER_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 portrait; margin: 8mm; }
  .line { margin-bottom: 9px; break-inside: avoid; }
  .l-head { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px 6px 0 0; }
  .l-pill { color: #fff; font-weight: 800; border-radius: 6px; padding: 2px 10px; font-size: 16px; min-width: 44px; text-align: center; }
  .l-info { flex: 1; min-width: 0; }
  .l-name { font-size: 11px; font-weight: 600; }
  .legend { font-size: 9.5px; color: #333; }
  .legend span { margin-right: 10px; }
  .l-count { font-size: 9px; color: #555; white-space: nowrap; }
  table.hours { width: 100%; border-collapse: collapse; }
  table.hours th { width: 34px; background: #111; color: #fff; font-size: 13px; font-weight: 800; text-align: center; border: 1px solid #444; padding: 2px; }
  table.hours td { border: 1px solid #bbb; padding: 2px 6px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  table.hours .m { display: inline-block; margin-right: 7px; font-weight: 600; }
  table.hours sup { font-size: 8px; font-weight: 700; }
`;

function stopPosterPage(data: StopTimetable): string {
  const gen = new Date().toLocaleString("it-IT");
  const dayLbl = data.dayTypeName ?? "Tutte le corse";
  const linesHtml = data.lines.map((l) => {
    const col = lineColor(l.color);
    const multiDest = l.headsigns.filter((h) => h).length > 1;
    const legend = multiDest
      ? `<div class="legend">${l.headsigns.map((h, i) =>
          h ? `<span><b>${String.fromCharCode(97 + i)}</b> → ${esc(h)}</span>` : "").join(" ")}</div>`
      : (l.headsigns[0] ? `<div class="legend">→ ${esc(l.headsigns[0])}</div>` : "");
    const rows = l.byHour.map((h) => `
      <tr>
        <th>${String(h.hour).padStart(2, "0")}</th>
        <td>${h.departures.map((d) =>
          `<span class="m">${String(d.minute).padStart(2, "0")}${multiDest && l.headsigns[d.headsignIdx] ? `<sup>${String.fromCharCode(97 + d.headsignIdx)}</sup>` : ""}</span>`
        ).join(" ")}</td>
      </tr>`).join("");
    return `
      <section class="line">
        <div class="l-head" style="background:${col}1a; border-left: 6px solid ${col}">
          <span class="l-pill" style="background:${col}">${esc(l.shortName ?? "?")}</span>
          <div class="l-info">
            <p class="l-name">${esc(l.longName ?? "")}</p>
            ${legend}
          </div>
          <span class="l-count">${l.total} partenze</span>
        </div>
        <table class="hours"><tbody>${rows}</tbody></table>
      </section>`;
  }).join("");

  return `
  <section class="page">
    <header class="doc">
      <div class="pill" style="background:#111">🚏</div>
      <h1>${esc(data.stop.stopName)}${data.stop.stopCode ? ` <small style="color:#666;font-size:12px">(${esc(data.stop.stopCode)})</small>` : ""}</h1>
      <div class="day">${esc(dayLbl)}<br><small style="font-weight:400">Orari di partenza</small></div>
    </header>
    ${linesHtml || "<p style='padding:20px;color:#666'>Nessuna partenza per il day-type selezionato.</p>"}
    <footer class="doc"><span>TransitIntel · quadro orario di fermata</span><span>Generato il ${gen}</span></footer>
  </section>`;
}

function buildStopPosterHtml(data: StopTimetable): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Quadro orario · ${esc(data.stop.stopName)}</title>
  <style>${STOP_POSTER_CSS}</style></head><body>${stopPosterPage(data)}</body></html>`;
}

function buildCombinedStopPostersHtml(list: StopTimetable[]): string {
  const body = list.filter((d) => d.lines.length > 0).map(stopPosterPage).join("");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Quadri di palina</title>
  <style>${STOP_POSTER_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna partenza per la selezione.</p>"}</body></html>`;
}

/* ── Orario generale di linea (A4 orizzontale, paginato) ── */

const ROUTE_TT_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 landscape; margin: 8mm; }
  table.tt { width: 100%; border-collapse: collapse; }
  table.tt th, table.tt td { border: 1px solid #999; font-size: 9.5px; padding: 2px 4px; text-align: center; font-variant-numeric: tabular-nums; }
  table.tt th.stop { text-align: left; background: #f1f1f1; font-weight: 600; max-width: 52mm; min-width: 38mm; }
  table.tt th.stop.head { background: #111; color: #fff; }
  table.tt th.trip { background: #111; color: #fff; }
  table.tt th.trip .hs { font-size: 7.5px; font-weight: 600; max-width: 18mm; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  table.tt tbody tr:nth-child(even) td { background: #fafafa; }
  table.tt td { font-weight: 600; }
`;

function routeTimetablePages(data: RouteTimetable): string {
  const gen = new Date().toLocaleString("it-IT");
  const col = lineColor(data.route.color);
  const PER_PAGE = 14;
  const chunks: RouteTimetable["trips"][] = [];
  for (let i = 0; i < data.trips.length; i += PER_PAGE) chunks.push(data.trips.slice(i, i + PER_PAGE));
  if (chunks.length === 0) chunks.push([]);

  const dirLabel = data.directionId == null ? "Andata + Ritorno" : data.directionId === 0 ? "Andata" : "Ritorno";
  const dayLbl = data.dayTypeName ?? "Tutte le corse";

  return chunks.map((chunk, pi) => {
    const headRow = chunk.map((t) => `<th class="trip"><div class="hs">${esc(t.headsign ?? "")}</div></th>`).join("");
    const bodyRows = data.stops.map((s, si) => `
      <tr>
        <th class="stop">${esc(s.stopName)}</th>
        ${chunk.map((t) => `<td>${t.times[si] ?? "·"}</td>`).join("")}
      </tr>`).join("");
    return `
    <section class="page">
      <header class="doc">
        <div class="pill" style="background:${col}">${esc(data.route.shortName ?? "?")}</div>
        <h1>${esc(data.route.longName ?? "Orario di linea")}</h1>
        <div class="day">${esc(dayLbl)} · ${dirLabel}${chunks.length > 1 ? `<br><small style="font-weight:400">pagina ${pi + 1}/${chunks.length}</small>` : ""}</div>
      </header>
      <table class="tt">
        <thead><tr><th class="stop head">Fermata</th>${headRow}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <footer class="doc"><span>TransitIntel · orario generale linea ${esc(data.route.shortName ?? "")}</span><span>Generato il ${gen}</span></footer>
    </section>`;
  }).join("");
}

function buildCombinedRouteTimetableHtml(docs: RouteTimetable[]): string {
  const body = docs.filter((d) => d.trips.length > 0).map(routeTimetablePages).join("");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Orari per il pubblico</title>
  <style>${ROUTE_TT_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna corsa per la selezione.</p>"}</body></html>`;
}

/* ─── Pagina ─── */

export default function TimetablesPage() {
  const [tab, setTab] = useState<"stop" | "route">("route");

  // progetto Planning Studio (sorgente del programma di esercizio)
  const [projectId, setProjectId] = useState<string>(DEFAULT_PROJECT_ID);

  // day-type selezionati (validità): multi per "orario di linea", singolo per "fermata"
  const [routeDayTypeIds, setRouteDayTypeIds] = useState<string[]>([]);
  const [stopDayTypeId, setStopDayTypeId] = useState<string>("");

  // quadro di fermata
  const [stopQuery, setStopQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<StopSearchItem | null>(null);

  // orario di linea
  const [directionId, setDirectionId] = useState<string>("all");
  const [selectedRouteIds, setSelectedRouteIds] = useState<string[]>([]);
  const [routeSearch, setRouteSearch] = useState("");
  const [printing, setPrinting] = useState(false);

  const ptt = `/api/planning-studio/${encodeURIComponent(projectId)}/timetables`;

  const projectsQ = useQuery({
    queryKey: ["pstt", "ps-projects"],
    queryFn: () => apiFetch<any>("/api/planning-studio/projects"),
    staleTime: 5 * 60 * 1000,
  });
  const projects: PsProject[] = useMemo(() => {
    const d: any = projectsQ.data;
    const list = Array.isArray(d) ? d : (d?.projects ?? []);
    return list.map((p: any) => ({ id: p.id, name: p.name ?? p.id }));
  }, [projectsQ.data]);
  useEffect(() => {
    if (projects.length && !projects.some((p) => p.id === projectId)) {
      setProjectId(projects.find((p) => p.id === DEFAULT_PROJECT_ID)?.id ?? projects[0].id);
    }
  }, [projects, projectId]);

  const dayTypesQ = useQuery({
    queryKey: ["pstt", "day-types", projectId],
    queryFn: () => apiFetch<{ dayTypes: PsDayType[] }>(`/api/planning-studio/projects/${encodeURIComponent(projectId)}/day-types`),
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000,
  });
  const dayTypes: PsDayType[] = useMemo(() => dayTypesQ.data?.dayTypes ?? [], [dayTypesQ.data]);

  // default: appena arrivano i day-type, seleziona "feriale" (o il primo)
  useEffect(() => {
    if (!dayTypes.length) return;
    const fallback = dayTypes.find((d) => d.code === "feriale")?.id ?? dayTypes[0].id;
    setRouteDayTypeIds((prev) => prev.filter((id) => dayTypes.some((d) => d.id === id)).length
      ? prev.filter((id) => dayTypes.some((d) => d.id === id)) : [fallback]);
    setStopDayTypeId((prev) => (dayTypes.some((d) => d.id === prev) ? prev : fallback));
  }, [dayTypes]);

  const stopSearchQ = useQuery({
    queryKey: ["pstt", "stop-search", projectId, stopQuery],
    queryFn: () => apiFetch<{ stops: StopSearchItem[] }>(`${ptt}/stops/search?q=${encodeURIComponent(stopQuery)}`),
    enabled: tab === "stop" && !!projectId && stopQuery.trim().length >= 2,
  });

  const stopTtQ = useQuery({
    queryKey: ["pstt", "stop", projectId, selectedStop?.stopId, stopDayTypeId],
    queryFn: () => apiFetch<StopTimetable>(`${ptt}/stop/${encodeURIComponent(selectedStop!.stopId)}?dayTypeId=${encodeURIComponent(stopDayTypeId)}`),
    enabled: tab === "stop" && !!projectId && !!selectedStop && !!stopDayTypeId,
  });

  const routesQ = useQuery({
    queryKey: ["pstt", "routes", projectId],
    queryFn: () => apiFetch<{ routes: PsRoute[] }>(`${ptt}/routes`),
    enabled: tab === "route" && !!projectId,
    staleTime: 5 * 60 * 1000,
  });

  const sortedRoutes = useMemo(() => {
    const list = routesQ.data?.routes ?? [];
    return [...list].sort((a, b) =>
      String(a.routeShortName ?? "").localeCompare(String(b.routeShortName ?? ""), "it", { numeric: true }));
  }, [routesQ.data]);

  const filteredRoutes = useMemo(() => {
    const q = routeSearch.trim().toLowerCase();
    if (!q) return sortedRoutes;
    return sortedRoutes.filter((r) => `${r.routeShortName ?? ""} ${r.routeLongName ?? ""}`.toLowerCase().includes(q));
  }, [sortedRoutes, routeSearch]);

  function toggleRoute(id: string) {
    setSelectedRouteIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function toggleRouteDayType(id: string) {
    setRouteDayTypeIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function selectedIdsOrdered(): string[] {
    return sortedRoutes.filter((r) => selectedRouteIds.includes(r.routeId)).map((r) => r.routeId);
  }

  async function printPublic() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    if (!routeDayTypeIds.length) { toast.error("Seleziona almeno un day-type"); return; }
    setPrinting(true);
    try {
      const docs: RouteTimetable[] = [];
      for (const rid of ids) {
        for (const dt of routeDayTypeIds) {
          const url = `${ptt}/route/${encodeURIComponent(rid)}?dayTypeId=${encodeURIComponent(dt)}`
            + (directionId !== "all" ? `&directionId=${directionId}` : "");
          docs.push(await apiFetch<RouteTimetable>(url));
        }
      }
      if (!docs.some((x) => x.trips.length > 0)) { toast.error("Nessuna corsa per la selezione"); return; }
      openPrintWindow(buildCombinedRouteTimetableHtml(docs));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
  }

  async function printPaline() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    if (!routeDayTypeIds.length) { toast.error("Seleziona almeno un day-type"); return; }
    setPrinting(true);
    try {
      const rs = await apiFetch<{ stops: Array<{ stopId: string; stopName: string; stopCode: string | null }> }>(
        `${ptt}/route-stops?routeIds=${ids.map(encodeURIComponent).join(",")}`,
      );
      const stops = rs.stops ?? [];
      if (!stops.length) { toast.error("Nessuna fermata per le linee selezionate"); return; }
      const docs: StopTimetable[] = [];
      for (const s of stops) {
        for (const dt of routeDayTypeIds) {
          const url = `${ptt}/stop/${encodeURIComponent(s.stopId)}?dayTypeId=${encodeURIComponent(dt)}`;
          docs.push(await apiFetch<StopTimetable>(url));
        }
      }
      if (!docs.some((x) => x.lines.length > 0)) { toast.error("Nessuna partenza per la selezione"); return; }
      openPrintWindow(buildCombinedStopPostersHtml(docs));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg">
          <Printer className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Stampa Orari</h1>
          <p className="text-xs text-muted-foreground">
            Quadri di palina e orari generali di linea dal programma di esercizio del progetto Planning Studio
          </p>
        </div>
      </div>

      {/* Tab */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg overflow-hidden border border-border/60">
          <button
            onClick={() => setTab("route")}
            className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === "route" ? "bg-sky-500/20 text-sky-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
          >
            <ArrowLeftRight className="w-4 h-4" /> Orario di linea
          </button>
          <button
            onClick={() => setTab("stop")}
            className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === "stop" ? "bg-sky-500/20 text-sky-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
          >
            <SignpostBig className="w-4 h-4" /> Quadro di fermata
          </button>
        </div>
      </div>

      {/* Progetto (sorgente) */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5">
        <span className="text-xs font-medium text-muted-foreground">Programma di esercizio</span>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-sky-500/60 max-w-72"
          title="Progetto Planning Studio (sorgente dati e validità)"
        >
          {projects.length === 0 && <option value={projectId}>Progetto predefinito</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {dayTypesQ.isLoading && <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> day-type…</span>}
        <span className="text-[10px] text-muted-foreground ml-auto">Validità per day-type da Planning Studio → Validità</span>
      </div>

      {/* ── Tab: orario di linea ── */}
      {tab === "route" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">Day-type</span>
            <div className="flex flex-wrap rounded-lg overflow-hidden border border-border/60">
              {dayTypes.map((d) => (
                <button
                  key={d.id}
                  onClick={() => toggleRouteDayType(d.id)}
                  className={`px-3 py-2 text-xs transition-colors ${routeDayTypeIds.includes(d.id) ? "bg-emerald-500/20 text-emerald-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
                >
                  {d.name}
                </button>
              ))}
              {dayTypes.length === 0 && <span className="px-3 py-2 text-xs text-muted-foreground">Nessun day-type</span>}
            </div>
            <select
              value={directionId}
              onChange={(e) => setDirectionId(e.target.value)}
              className="px-3 py-2 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            >
              <option value="all">Andata + Ritorno</option>
              <option value="0">Andata</option>
              <option value="1">Ritorno</option>
            </select>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={printPaline}
                disabled={printing || selectedRouteIds.length === 0 || routeDayTypeIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-sky-500/60 text-sky-300 hover:bg-sky-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Quadro di palina per ogni fermata delle linee selezionate"
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <SignpostBig className="w-4 h-4" />}
                Stampa quadri palina
              </button>
              <button
                onClick={printPublic}
                disabled={printing || selectedRouteIds.length === 0 || routeDayTypeIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                Stampa orari pubblico{selectedRouteIds.length ? ` (${selectedRouteIds.length})` : ""}
              </button>
            </div>
          </div>

          {/* Selezione linee */}
          <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground" />
              <input
                value={routeSearch}
                onChange={(e) => setRouteSearch(e.target.value)}
                placeholder="Filtra linee…"
                className="flex-1 bg-transparent text-sm outline-none"
              />
              <button onClick={() => setSelectedRouteIds(filteredRoutes.map((r) => r.routeId))} className="text-[11px] text-sky-400 hover:underline">Seleziona tutte</button>
              <button onClick={() => setSelectedRouteIds([])} className="text-[11px] text-muted-foreground hover:underline">Deseleziona</button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-border/30">
              {routesQ.isLoading && (
                <div className="p-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico linee…</div>
              )}
              {!routesQ.isLoading && filteredRoutes.length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">Nessuna linea nel progetto.</div>
              )}
              {filteredRoutes.map((r) => (
                <label key={r.routeId} className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 cursor-pointer">
                  <input type="checkbox" checked={selectedRouteIds.includes(r.routeId)} onChange={() => toggleRoute(r.routeId)} className="accent-sky-500" />
                  <span className="px-2 py-0.5 rounded text-white text-xs font-bold shrink-0" style={{ backgroundColor: lineColor(r.routeColor) }}>{r.routeShortName ?? "?"}</span>
                  <span className="text-sm truncate">{r.routeLongName ?? r.routeId}</span>
                </label>
              ))}
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Documento unico: una sezione per ogni linea × day-type selezionato. «Stampa quadri palina» genera invece il quadro di ogni fermata delle linee scelte (con tutte le linee che vi passano). Output → salva in PDF dal dialogo di stampa.
          </p>
        </div>
      )}

      {/* ── Tab: quadro di fermata ── */}
      {tab === "stop" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">Day-type</span>
            <select
              value={stopDayTypeId}
              onChange={(e) => setStopDayTypeId(e.target.value)}
              className="px-3 py-2 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            >
              {dayTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={stopQuery}
              onChange={(e) => { setStopQuery(e.target.value); setSelectedStop(null); }}
              placeholder="Cerca fermata per nome (min 2 caratteri)…"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            />
          </div>

          {!selectedStop && stopQuery.trim().length >= 2 && (
            <div className="rounded-lg border border-border/60 divide-y divide-border/40 max-h-72 overflow-y-auto">
              {stopSearchQ.isLoading && <div className="p-3 text-xs text-muted-foreground">Ricerca…</div>}
              {stopSearchQ.data?.stops.length === 0 && <div className="p-3 text-xs text-muted-foreground">Nessuna fermata trovata.</div>}
              {stopSearchQ.data?.stops.map((s) => (
                <button
                  key={s.stopId}
                  onClick={() => setSelectedStop(s)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-3"
                >
                  <MapPin className="w-4 h-4 text-sky-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{s.stopName}</span>
                    <span className="block text-[10px] text-muted-foreground truncate">linee: {s.routes.slice(0, 10).join(", ") || "—"}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {selectedStop && (
            <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
              <div className="px-4 py-3 border-b border-border/50 flex items-center gap-3">
                <MapPin className="w-4 h-4 text-sky-400" />
                <span className="font-semibold text-sm flex-1">{selectedStop.stopName}</span>
                <button
                  onClick={() => { if (stopTtQ.data) openPrintWindow(buildStopPosterHtml(stopTtQ.data)); }}
                  disabled={!stopTtQ.data}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" /> Stampa quadro
                </button>
              </div>
              <div className="p-4 space-y-3">
                {stopTtQ.isLoading && <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico orari…</div>}
                {stopTtQ.data?.lines.length === 0 && (
                  <div className="text-xs text-muted-foreground">Nessuna partenza da questa fermata per il day-type scelto.</div>
                )}
                {stopTtQ.data?.lines.map((l) => (
                  <div key={l.routeId} className="rounded-lg border border-border/40 overflow-hidden">
                    <div className="px-3 py-1.5 flex items-center gap-2" style={{ backgroundColor: `${lineColor(l.color)}22`, borderLeft: `4px solid ${lineColor(l.color)}` }}>
                      <span className="px-2 py-0.5 rounded text-white text-xs font-bold" style={{ backgroundColor: lineColor(l.color) }}>{l.shortName ?? "?"}</span>
                      <span className="text-xs text-muted-foreground truncate flex-1">{l.longName}</span>
                      <span className="text-[10px] text-muted-foreground">{l.total} partenze</span>
                    </div>
                    <div className="p-2 grid gap-0.5" style={{ gridTemplateColumns: "2.5rem 1fr" }}>
                      {l.byHour.map((h) => (
                        <div key={h.hour} className="contents">
                          <span className="text-xs font-bold font-mono bg-white/5 rounded px-1.5 py-0.5 text-center">{String(h.hour).padStart(2, "0")}</span>
                          <span className="text-xs font-mono px-2 py-0.5">
                            {h.departures.map((d, i) => (
                              <span key={i} className="mr-2">
                                {String(d.minute).padStart(2, "0")}
                                {l.headsigns.filter(Boolean).length > 1 && l.headsigns[d.headsignIdx] && (
                                  <sup className="text-[8px] text-sky-400">{String.fromCharCode(97 + d.headsignIdx)}</sup>
                                )}
                              </span>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
