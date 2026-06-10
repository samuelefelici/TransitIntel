/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI — quadri di fermata e orari generali di linea
 * ───────────────────────────────────────────────────────────────────────────
 * Output cartacei del programma di esercizio operativo (feed attivo):
 *  - Quadro di fermata: per ogni linea che ferma, griglia ore × minuti con
 *    rimando alla destinazione (formato palina classico, A4 verticale).
 *  - Orario generale di linea: fermate × corse (A4/A3 orizzontale, spezzato
 *    automaticamente su più pagine oltre le 14 corse).
 * La stampa apre una finestra con HTML standalone + window.print(), come
 * l'export delle polimetriche.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRight, Bus, Clock, Loader2, MapPin, Printer, Search, SignpostBig,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

/* ─── Tipi (allineati a /api/timetables/*) ─── */

type DayType = "weekday" | "saturday" | "sunday";
const DAY_LABEL: Record<DayType, string> = {
  weekday: "Feriale", saturday: "Sabato", sunday: "Domenica e festivi",
};

interface StopSearchItem {
  stopId: string; stopName: string; stopCode: string | null;
  lat: number; lon: number; routes: string[];
}

interface StopTimetable {
  feedId: string;
  dayType: DayType;
  stop: { stopId: string; stopName: string; stopCode: string | null };
  lines: Array<{
    routeId: string; shortName: string | null; longName: string | null; color: string | null;
    headsigns: string[]; total: number;
    byHour: Array<{ hour: number; departures: Array<{ minute: number; headsignIdx: number }> }>;
  }>;
}

interface RouteTimetable {
  feedId: string;
  dayType: DayType;
  directionId: number | null;
  route: { routeId: string; shortName: string | null; longName: string | null; color: string | null };
  stops: Array<{ stopId: string; stopName: string }>;
  trips: Array<{ tripId: string; headsign: string | null; directionId: number | null; times: (string | null)[] }>;
}

interface GtfsRoute {
  routeId: string; routeShortName: string | null; routeLongName: string | null; routeColor: string | null;
}

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

/** HTML standalone del quadro di fermata (A4 verticale). */
function buildStopPosterHtml(data: StopTimetable): string {
  const gen = new Date().toLocaleString("it-IT");
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

  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Quadro orario · ${esc(data.stop.stopName)}</title>
  <style>
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
  </style></head><body>
  <section class="page">
    <header class="doc">
      <div class="pill" style="background:#111">🚏</div>
      <h1>${esc(data.stop.stopName)}${data.stop.stopCode ? ` <small style="color:#666;font-size:12px">(${esc(data.stop.stopCode)})</small>` : ""}</h1>
      <div class="day">${DAY_LABEL[data.dayType]}<br><small style="font-weight:400">Orari di partenza</small></div>
    </header>
    ${linesHtml || "<p style='padding:20px;color:#666'>Nessuna partenza per il tipo di giorno selezionato.</p>"}
    <footer class="doc"><span>TransitIntel · quadro orario di fermata</span><span>Generato il ${gen}</span></footer>
  </section>
  </body></html>`;
}

/** HTML standalone dell'orario generale di linea (orizzontale, paginato). */
function buildRouteTimetableHtml(data: RouteTimetable): string {
  const gen = new Date().toLocaleString("it-IT");
  const col = lineColor(data.route.color);
  const PER_PAGE = 14;
  const chunks: RouteTimetable["trips"][] = [];
  for (let i = 0; i < data.trips.length; i += PER_PAGE) chunks.push(data.trips.slice(i, i + PER_PAGE));
  if (chunks.length === 0) chunks.push([]);

  const dirLabel = data.directionId == null ? "Andata + Ritorno" : data.directionId === 0 ? "Andata" : "Ritorno";

  const pages = chunks.map((chunk, pi) => {
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
        <div class="day">${DAY_LABEL[data.dayType]} · ${dirLabel}${chunks.length > 1 ? `<br><small style="font-weight:400">pagina ${pi + 1}/${chunks.length}</small>` : ""}</div>
      </header>
      <table class="tt">
        <thead><tr><th class="stop head">Fermata</th>${headRow}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <footer class="doc"><span>TransitIntel · orario generale linea ${esc(data.route.shortName ?? "")}</span><span>Generato il ${gen}</span></footer>
    </section>`;
  }).join("");

  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Orario linea ${esc(data.route.shortName ?? "")}</title>
  <style>
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
  </style></head><body>${pages}</body></html>`;
}

/* ─── Pagina ─── */

export default function TimetablesPage() {
  const [tab, setTab] = useState<"stop" | "route">("stop");
  const [dayType, setDayType] = useState<DayType>("weekday");

  // quadro di fermata
  const [stopQuery, setStopQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<StopSearchItem | null>(null);

  // orario di linea
  const [selectedRouteId, setSelectedRouteId] = useState<string>("");
  const [directionId, setDirectionId] = useState<string>("all"); // all | 0 | 1

  const stopSearchQ = useQuery({
    queryKey: ["timetables", "stop-search", stopQuery],
    queryFn: () => apiFetch<{ stops: StopSearchItem[] }>(`/api/timetables/stops/search?q=${encodeURIComponent(stopQuery)}`),
    enabled: tab === "stop" && stopQuery.trim().length >= 2,
  });

  const stopTtQ = useQuery({
    queryKey: ["timetables", "stop", selectedStop?.stopId, dayType],
    queryFn: () => apiFetch<StopTimetable>(`/api/timetables/stop/${encodeURIComponent(selectedStop!.stopId)}?dayType=${dayType}`),
    enabled: tab === "stop" && !!selectedStop,
  });

  const routesQ = useQuery({
    queryKey: ["timetables", "routes"],
    queryFn: () => apiFetch<{ data: GtfsRoute[] }>("/api/gtfs/routes"),
    enabled: tab === "route",
    staleTime: 5 * 60 * 1000,
  });

  const routeTtQ = useQuery({
    queryKey: ["timetables", "route", selectedRouteId, dayType, directionId],
    queryFn: () => apiFetch<RouteTimetable>(
      `/api/timetables/route/${encodeURIComponent(selectedRouteId)}?dayType=${dayType}${directionId !== "all" ? `&directionId=${directionId}` : ""}`,
    ),
    enabled: tab === "route" && !!selectedRouteId,
  });

  const sortedRoutes = useMemo(() => {
    const list = routesQ.data?.data ?? [];
    return [...list].sort((a, b) =>
      String(a.routeShortName ?? "").localeCompare(String(b.routeShortName ?? ""), "it", { numeric: true }));
  }, [routesQ.data]);

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
            Quadri di fermata e orari generali di linea dal programma di esercizio operativo (feed attivo)
          </p>
        </div>
      </div>

      {/* Tab + day type */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg overflow-hidden border border-border/60">
          <button
            onClick={() => setTab("stop")}
            className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === "stop" ? "bg-sky-500/20 text-sky-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
          >
            <SignpostBig className="w-4 h-4" /> Quadro di fermata
          </button>
          <button
            onClick={() => setTab("route")}
            className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === "route" ? "bg-sky-500/20 text-sky-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
          >
            <ArrowLeftRight className="w-4 h-4" /> Orario di linea
          </button>
        </div>

        <div className="flex rounded-lg overflow-hidden border border-border/60 ml-auto">
          {(Object.keys(DAY_LABEL) as DayType[]).map((d) => (
            <button
              key={d}
              onClick={() => setDayType(d)}
              className={`px-3 py-2 text-xs transition-colors ${dayType === d ? "bg-emerald-500/20 text-emerald-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
            >
              {DAY_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab: quadro di fermata ── */}
      {tab === "stop" && (
        <div className="space-y-4">
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
                    <span className="block text-[10px] text-muted-foreground truncate">
                      linee: {s.routes.slice(0, 10).join(", ") || "—"}
                    </span>
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
                  onClick={() => {
                    if (!stopTtQ.data) return;
                    openPrintWindow(buildStopPosterHtml(stopTtQ.data));
                  }}
                  disabled={!stopTtQ.data}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" /> Stampa quadro
                </button>
              </div>

              <div className="p-4 space-y-3">
                {stopTtQ.isLoading && <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico orari…</div>}
                {stopTtQ.data?.lines.length === 0 && (
                  <div className="text-xs text-muted-foreground">Nessuna partenza per «{DAY_LABEL[dayType]}» da questa fermata.</div>
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
                    {l.headsigns.filter(Boolean).length > 1 && (
                      <div className="px-3 pb-2 text-[10px] text-muted-foreground">
                        {l.headsigns.map((h, i) => h && <span key={i} className="mr-3"><b className="text-sky-400">{String.fromCharCode(97 + i)}</b> → {h}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: orario di linea ── */}
      {tab === "route" && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={selectedRouteId}
              onChange={(e) => setSelectedRouteId(e.target.value)}
              className="flex-1 min-w-56 px-3 py-2.5 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            >
              <option value="">— Scegli la linea —</option>
              {sortedRoutes.map((r) => (
                <option key={r.routeId} value={r.routeId}>
                  {r.routeShortName ?? r.routeId} · {r.routeLongName ?? ""}
                </option>
              ))}
            </select>
            <select
              value={directionId}
              onChange={(e) => setDirectionId(e.target.value)}
              className="px-3 py-2.5 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            >
              <option value="all">Andata + Ritorno</option>
              <option value="0">Andata</option>
              <option value="1">Ritorno</option>
            </select>
            <button
              onClick={() => {
                if (!routeTtQ.data) return;
                openPrintWindow(buildRouteTimetableHtml(routeTtQ.data));
              }}
              disabled={!routeTtQ.data || routeTtQ.data.trips.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              <Printer className="w-4 h-4" /> Stampa orario
            </button>
          </div>

          {routeTtQ.isLoading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Costruisco l'orario…
            </div>
          )}

          {routeTtQ.data && routeTtQ.data.trips.length === 0 && (
            <div className="text-xs text-muted-foreground py-8 text-center">
              Nessuna corsa per «{DAY_LABEL[dayType]}» su questa linea/direzione.
            </div>
          )}

          {routeTtQ.data && routeTtQ.data.trips.length > 0 && (
            <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
              <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2 text-xs text-muted-foreground">
                <Bus className="w-4 h-4 text-sky-400" />
                <span className="px-2 py-0.5 rounded text-white font-bold" style={{ backgroundColor: lineColor(routeTtQ.data.route.color) }}>
                  {routeTtQ.data.route.shortName}
                </span>
                <span className="truncate">{routeTtQ.data.route.longName}</span>
                <span className="ml-auto flex items-center gap-1"><Clock className="w-3 h-3" /> {routeTtQ.data.trips.length} corse · {routeTtQ.data.stops.length} fermate</span>
              </div>
              <div className="overflow-auto max-h-[60vh]">
                <table className="text-[11px] border-collapse min-w-full">
                  <thead className="sticky top-0 bg-background z-10">
                    <tr>
                      <th className="text-left px-2 py-1.5 border-b border-border/50 sticky left-0 bg-background min-w-44">Fermata</th>
                      {routeTtQ.data.trips.map((t) => (
                        <th key={t.tripId} className="px-1.5 py-1.5 border-b border-border/50 font-medium text-muted-foreground max-w-20 truncate" title={t.headsign ?? ""}>
                          {t.headsign ? t.headsign.slice(0, 10) : "·"}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {routeTtQ.data.stops.map((s, si) => (
                      <tr key={s.stopId} className="odd:bg-white/[0.02]">
                        <td className="px-2 py-1 border-b border-border/20 sticky left-0 bg-background truncate max-w-56" title={s.stopName}>{s.stopName}</td>
                        {routeTtQ.data!.trips.map((t) => (
                          <td key={t.tripId} className="px-1.5 py-1 border-b border-border/20 text-center font-mono">
                            {t.times[si] ?? <span className="text-muted-foreground/40">·</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
