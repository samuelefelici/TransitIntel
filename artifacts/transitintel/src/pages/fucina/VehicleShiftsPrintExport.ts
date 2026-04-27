/**
 * VehicleShiftsPrintExport — esporta lo scenario come stampa A4/A3 con un turno macchina per colonna.
 *
 * Apre una nuova finestra con HTML formattato per la stampa, auto-trigger di window.print().
 * Layout: griglia di colonne, una per turno; ogni colonna mostra le corse in ordine cronologico
 * con orario, linea, headsign, stop di partenza/arrivo, km vuoto e flag downsize.
 */
import type { ServiceProgramResult, VehicleShift, ShiftTripEntry } from "@/pages/optimizer-route/types";
import { VEHICLE_SHORT, ROUTE_PALETTE } from "@/pages/optimizer-route/constants";

const escape = (s: string | undefined | null) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));

const minToHHMM = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

function buildRouteColorMap(shifts: VehicleShift[]): Map<string, string> {
  const ids = new Set<string>();
  for (const s of shifts) for (const t of s.trips) if (t.routeId) ids.add(t.routeId);
  const map = new Map<string, string>();
  let i = 0;
  for (const id of ids) {
    map.set(id, ROUTE_PALETTE[i % ROUTE_PALETTE.length]);
    i++;
  }
  return map;
}

/** Durata in minuti tra due tempi (per "fermo in deposito" o sosta capolinea). */
const fmtDur = (m: number) => {
  if (m <= 0) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h${String(mm).padStart(2, "0")}` : `${mm}′`;
};

interface SyntheticEntry {
  kind: "pullout" | "depot_idle" | "terminal_idle" | "pullin";
  departureMin: number;
  arrivalMin: number;
  fromName?: string;
  toName?: string;
}

/** Costruisce la sequenza completa di righe per un turno: include uscita deposito,
 * fermi in deposito tra rientri, soste al capolinea, e rientro finale. */
function buildShiftRows(shift: VehicleShift): Array<ShiftTripEntry | SyntheticEntry> {
  const trips = shift.trips.slice().sort((a, b) => a.departureMin - b.departureMin);
  const out: Array<ShiftTripEntry | SyntheticEntry> = [];

  // Pull-out iniziale
  const firstTrip = trips.find(t => t.type === "trip");
  if (firstTrip) {
    out.push({
      kind: "pullout",
      departureMin: Math.max(0, firstTrip.departureMin - 10),
      arrivalMin: firstTrip.departureMin,
      fromName: "Deposito",
      toName: firstTrip.firstStopName || "—",
    });
  }

  for (let i = 0; i < trips.length; i++) {
    const e = trips[i];
    out.push(e);
    // Sosta al capolinea (gap > 5 min tra trip consecutivi senza deadhead/depot in mezzo)
    if (e.type === "trip" && i + 1 < trips.length) {
      const next = trips[i + 1];
      const gap = next.departureMin - e.arrivalMin;
      if (next.type === "trip" && gap >= 5) {
        out.push({
          kind: "terminal_idle",
          departureMin: e.arrivalMin,
          arrivalMin: next.departureMin,
          fromName: e.lastStopName || "Capolinea",
          toName: next.firstStopName || "Capolinea",
        });
      } else if (next.type === "depot") {
        // sostituisco il rendering depot con due righe: rientro + sosta in deposito + uscita
        // (gestito dal type === "depot" sotto)
      }
    }
  }

  // Pull-in finale
  const lastTripIdx = [...trips].reverse().findIndex(t => t.type === "trip");
  if (lastTripIdx >= 0) {
    const lastTrip = trips[trips.length - 1 - lastTripIdx];
    if (lastTrip.type === "trip") {
      out.push({
        kind: "pullin",
        departureMin: lastTrip.arrivalMin,
        arrivalMin: lastTrip.arrivalMin + 10,
        fromName: lastTrip.lastStopName || "—",
        toName: "Deposito",
      });
    }
  }

  return out.sort((a, b) => a.departureMin - b.departureMin);
}

function entryRowHtml(
  entry: ShiftTripEntry | SyntheticEntry,
  routeColor: string,
): string {
  // Synthetic: pull-out, pull-in, terminal_idle
  if ("kind" in entry) {
    if (entry.kind === "pullout") {
      return `<tr class="depot pullout">
        <td class="line">🏁</td>
        <td class="time">${minToHHMM(entry.departureMin)}</td>
        <td class="stop">${escape(entry.fromName || "Deposito")}</td>
        <td class="path"><em>Uscita deposito → capolinea</em></td>
        <td class="stop">${escape(entry.toName || "")}</td>
        <td class="time">${minToHHMM(entry.arrivalMin)}</td>
      </tr>`;
    }
    if (entry.kind === "pullin") {
      return `<tr class="depot pullin">
        <td class="line">🏠</td>
        <td class="time">${minToHHMM(entry.departureMin)}</td>
        <td class="stop">${escape(entry.fromName || "")}</td>
        <td class="path"><strong>RIENTRO IN DEPOSITO</strong></td>
        <td class="stop">${escape(entry.toName || "Deposito")}</td>
        <td class="time">${minToHHMM(entry.arrivalMin)}</td>
      </tr>`;
    }
    if (entry.kind === "terminal_idle") {
      const dur = entry.arrivalMin - entry.departureMin;
      return `<tr class="idle">
        <td class="line">⏸</td>
        <td class="time">${minToHHMM(entry.departureMin)}</td>
        <td class="stop" colspan="3"><em>Sosta al capolinea — ${fmtDur(dur)} a ${escape(entry.fromName || "")}</em></td>
        <td class="time">${minToHHMM(entry.arrivalMin)}</td>
      </tr>`;
    }
    return "";
  }

  // Real entries
  if (entry.type === "deadhead") {
    return `<tr class="dh">
      <td class="line">↝</td>
      <td class="time">${minToHHMM(entry.departureMin)}</td>
      <td class="stop">—</td>
      <td class="path"><em>Trasferimento a vuoto · ${entry.deadheadKm ?? 0} km</em></td>
      <td class="stop">—</td>
      <td class="time">${minToHHMM(entry.arrivalMin)}</td>
    </tr>`;
  }
  if (entry.type === "depot") {
    const dur = entry.arrivalMin - entry.departureMin;
    return `<tr class="depot midret">
      <td class="line">🏠</td>
      <td class="time">${minToHHMM(entry.departureMin)}</td>
      <td class="stop">—</td>
      <td class="path"><strong>Rientro in deposito</strong> · fermo ${fmtDur(dur)}</td>
      <td class="stop">Deposito</td>
      <td class="time">${minToHHMM(entry.arrivalMin)}</td>
    </tr>`;
  }
  // trip — colonne richieste: Linea, Ora partenza, Cap. partenza, percorso, Cap. arrivo, Ora arrivo
  const downsize = entry.downsized ? ` <span class="warn">⚠</span>` : "";
  const path = entry.headsign
    ? escape(entry.headsign)
    : (entry.firstStopName && entry.lastStopName
      ? `${escape(entry.firstStopName)} → ${escape(entry.lastStopName)}`
      : "");
  const meta = [
    entry.stopCount ? `${entry.stopCount} ferm.` : null,
    entry.durationMin ? fmtDur(entry.durationMin) : null,
  ].filter(Boolean).join(" · ");
  return `<tr class="trip">
    <td class="line"><span class="badge" style="background:${routeColor}">${escape(entry.routeName)}</span>${downsize}</td>
    <td class="time">${minToHHMM(entry.departureMin)}</td>
    <td class="stop">${escape(entry.firstStopName || "")}</td>
    <td class="path">${path}${meta ? `<div class="metasub">${meta}</div>` : ""}</td>
    <td class="stop">${escape(entry.lastStopName || "")}</td>
    <td class="time">${minToHHMM(entry.arrivalMin)}</td>
  </tr>`;
}

function analyzeShift(shift: VehicleShift) {
  const trips = shift.trips.filter(t => t.type === "trip");
  const startMin = trips.length ? Math.min(...trips.map(t => t.departureMin)) : 0;
  const endMin = trips.length ? Math.max(...trips.map(t => t.arrivalMin)) : 0;
  const serviceMin = trips.reduce((s, t) => s + (t.durationMin ?? (t.arrivalMin - t.departureMin)), 0);
  const totMin = endMin - startMin + 10; // include rientro
  const idleMin = Math.max(0, totMin - serviceMin - shift.totalDeadheadMin);
  const routes = new Set(trips.map(t => t.routeId));
  return {
    label: shift.vehicleId,
    vehicleType: shift.vehicleType,
    tripsCount: trips.length,
    startMin: Math.max(0, startMin - 10),
    endMin: endMin + 10,
    totMin,
    serviceMin,
    deadheadMin: shift.totalDeadheadMin,
    deadheadKm: shift.totalDeadheadKm,
    idleMin,
    depotReturns: shift.depotReturns,
    downsizedTrips: shift.downsizedTrips,
    distinctRoutes: routes.size,
    efficiency: totMin > 0 ? serviceMin / totMin : 0,
  };
}

function shiftColumnHtml(shift: VehicleShift, customLabel: string | undefined, routeColors: Map<string, string>): string {
  const an = analyzeShift(shift);
  const rows = buildShiftRows(shift)
    .map(e => entryRowHtml(e, "routeId" in e && e.routeId ? (routeColors.get(e.routeId) || "#666") : "#666"))
    .join("\n");

  const label = customLabel || shift.vehicleId;
  const vType = VEHICLE_SHORT[shift.vehicleType] || shift.vehicleType;

  return `<section class="shift">
    <header>
      <h2>${escape(label)}</h2>
      <div class="meta">
        <span class="vtype">${escape(vType)}</span>
        <span>${an.tripsCount} corse</span>
        <span>${minToHHMM(an.startMin)}–${minToHHMM(an.endMin)}</span>
        <span>(${fmtDur(an.totMin)})</span>
      </div>
    </header>
    <table>
      <thead>
        <tr>
          <th>Linea</th>
          <th>Ora P.</th>
          <th>Cap. Partenza</th>
          <th>Percorso</th>
          <th>Cap. Arrivo</th>
          <th>Ora A.</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <footer class="shift-analysis">
      <div><strong>Servizio:</strong> ${fmtDur(an.serviceMin)}</div>
      <div><strong>Vuoto:</strong> ${fmtDur(an.deadheadMin)} (${an.deadheadKm.toFixed(1)} km)</div>
      <div><strong>Sosta:</strong> ${fmtDur(an.idleMin)}</div>
      <div><strong>Rientri dep.:</strong> ${an.depotReturns}</div>
      <div><strong>Linee:</strong> ${an.distinctRoutes}</div>
      <div><strong>Efficienza:</strong> ${(an.efficiency * 100).toFixed(0)}%</div>
      ${an.downsizedTrips ? `<div class="warn-line">⚠ ${an.downsizedTrips} corse su mezzo ridotto</div>` : ""}
    </footer>
  </section>`;
}

/** Sezione "Analisi globale dello scenario" — KPI aggregati + breakdown. */
function buildGlobalAnalysisHtml(result: ServiceProgramResult): string {
  const shifts = result.shifts;
  const summary = result.summary;
  const totVehicles = shifts.length;
  const byType: Record<string, number> = {};
  let totIdle = 0;
  let totDepotReturns = 0;
  let totDownsized = 0;
  const routeCounts: Record<string, { name: string; count: number }> = {};
  const analyses = shifts.map(analyzeShift);
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    byType[s.vehicleType] = (byType[s.vehicleType] || 0) + 1;
    totIdle += analyses[i].idleMin;
    totDepotReturns += s.depotReturns;
    totDownsized += s.downsizedTrips;
    for (const t of s.trips) {
      if (t.type !== "trip") continue;
      if (!routeCounts[t.routeId]) routeCounts[t.routeId] = { name: t.routeName, count: 0 };
      routeCounts[t.routeId].count += 1;
    }
  }
  const totService = analyses.reduce((s, a) => s + a.serviceMin, 0);
  const totDeadhead = analyses.reduce((s, a) => s + a.deadheadMin, 0);
  const totAvgEff = analyses.length ? analyses.reduce((s, a) => s + a.efficiency, 0) / analyses.length : 0;
  const topRoutes = Object.entries(routeCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);
  // distribuzione nastro
  const durations = analyses.map(a => a.totMin).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const min = durations[0] ?? 0;
  const max = durations[durations.length - 1] ?? 0;

  return `<section class="analysis">
    <h2>📊 Analisi dello scenario</h2>
    <div class="grid-kpi">
      <div class="kpi"><div class="lbl">Veicoli totali</div><div class="val">${totVehicles}</div></div>
      <div class="kpi"><div class="lbl">Corse erogate</div><div class="val">${summary?.totalTrips ?? "—"}</div></div>
      <div class="kpi"><div class="lbl">Ore servizio</div><div class="val">${(totService / 60).toFixed(1)}h</div></div>
      <div class="kpi"><div class="lbl">Ore vuoto</div><div class="val">${(totDeadhead / 60).toFixed(1)}h</div></div>
      <div class="kpi"><div class="lbl">Ore sosta</div><div class="val">${(totIdle / 60).toFixed(1)}h</div></div>
      <div class="kpi"><div class="lbl">Km vuoto</div><div class="val">${summary?.totalDeadheadKm?.toFixed(0) ?? "—"}</div></div>
      <div class="kpi"><div class="lbl">Rientri dep.</div><div class="val">${totDepotReturns}</div></div>
      <div class="kpi"><div class="lbl">Efficienza media</div><div class="val">${(totAvgEff * 100).toFixed(0)}%</div></div>
    </div>

    <div class="two-col">
      <div>
        <h3>Composizione flotta</h3>
        <table class="mini">
          <thead><tr><th>Tipo</th><th>Veicoli</th><th>%</th></tr></thead>
          <tbody>
            ${Object.entries(byType).map(([k, v]) =>
              `<tr><td>${escape(VEHICLE_SHORT[k as keyof typeof VEHICLE_SHORT] || k)}</td><td>${v}</td><td>${((v / totVehicles) * 100).toFixed(0)}%</td></tr>`
            ).join("")}
          </tbody>
        </table>
        <h3>Distribuzione durate turno</h3>
        <table class="mini">
          <tbody>
            <tr><td>Più corto</td><td><strong>${fmtDur(min)}</strong></td></tr>
            <tr><td>Mediana</td><td><strong>${fmtDur(median)}</strong></td></tr>
            <tr><td>Più lungo</td><td><strong>${fmtDur(max)}</strong></td></tr>
          </tbody>
        </table>
      </div>
      <div>
        <h3>Linee più servite</h3>
        <table class="mini">
          <thead><tr><th>Linea</th><th>Corse</th></tr></thead>
          <tbody>
            ${topRoutes.map(([_id, r]) =>
              `<tr><td>${escape(r.name)}</td><td>${r.count}</td></tr>`
            ).join("")}
          </tbody>
        </table>
        ${result.costs ? `
          <h3>Costi giornalieri stimati</h3>
          <table class="mini">
            <tbody>
              <tr><td>Veicoli (fisso)</td><td>€ ${result.costs.vehicleFixedCost?.toFixed(0) ?? "—"}</td></tr>
              <tr><td>Veicoli (km servizio)</td><td>€ ${result.costs.vehicleServiceKmCost?.toFixed(0) ?? "—"}</td></tr>
              <tr><td>Veicoli (km vuoto)</td><td>€ ${result.costs.vehicleDeadheadKmCost?.toFixed(0) ?? "—"}</td></tr>
              <tr><td>Rientri deposito</td><td>€ ${result.costs.depotReturnCost?.toFixed(0) ?? "—"}</td></tr>
              <tr class="totale"><td><strong>TOTALE</strong></td><td><strong>€ ${result.costs.totalDailyCost?.toFixed(0) ?? "—"}</strong></td></tr>
            </tbody>
          </table>
        ` : ""}
        ${totDownsized > 0 ? `<div class="warn-block">⚠ <strong>${totDownsized}</strong> corse erogate con mezzo di taglia inferiore al richiesto.</div>` : ""}
      </div>
    </div>

    <p class="note">Note: efficienza = ore servizio / nastro totale (incluso pull-out e rientro). Il fermo in deposito tra rientri e ripresa è
    contabilizzato come ore di sosta. I rientri intermedi sono evidenziati nella colonna del turno.</p>
  </section>`;
}

export interface PrintOptions {
  /** Colonne per pagina (default 3) */
  columnsPerPage?: number;
  /** Etichette custom per turno (vehicleId → label) */
  customLabels?: Record<string, string>;
  /** Nome scenario da mostrare in header */
  scenarioName?: string;
  /** Orientamento (default landscape) */
  orientation?: "portrait" | "landscape";
}

export function exportScenarioToPrint(result: ServiceProgramResult, opts: PrintOptions = {}) {
  const { columnsPerPage = 3, customLabels = {}, scenarioName, orientation = "landscape" } = opts;
  const routeColors = buildRouteColorMap(result.shifts);

  const sortedShifts = result.shifts
    .slice()
    .sort((a, b) => {
      const aMin = a.trips.length ? Math.min(...a.trips.map(t => t.departureMin)) : 0;
      const bMin = b.trips.length ? Math.min(...b.trips.map(t => t.departureMin)) : 0;
      return aMin - bMin;
    });

  const cols = sortedShifts.map(s => shiftColumnHtml(s, customLabels[s.vehicleId], routeColors)).join("\n");

  const summary = result.summary;
  const date = summary?.date || new Date().toISOString().slice(0, 10);
  const title = scenarioName?.trim() || `Scenario turni macchina ${date}`;

  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>${escape(title)}</title>
  <style>
    @page { size: A4 ${orientation}; margin: 10mm 8mm 12mm 8mm; }
    /* Forza la stampa dei colori di sfondo anche nel salvataggio PDF */
    html, body, * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #111;
      font-size: 8.5pt;
      line-height: 1.25;
      padding: 0 4mm;
    }
    header.doc {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 2px solid #111;
      padding-bottom: 6px;
      margin-bottom: 12px;
    }
    header.doc h1 { font-size: 14pt; margin: 0; }
    header.doc .summary {
      text-align: right;
      font-size: 9pt;
      color: #444;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(${columnsPerPage}, minmax(0, 1fr));
      gap: 6px;
      width: 100%;
    }
    section.shift {
      page-break-inside: avoid;
      break-inside: avoid;
      border: 1px solid #999;
      border-radius: 4px;
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
      background: #fff;
    }
    section.shift header {
      background: #f3f4f6;
      padding: 6px 8px;
      border-bottom: 1px solid #999;
    }
    section.shift header h2 {
      margin: 0;
      font-size: 10.5pt;
      font-weight: 700;
    }
    section.shift header .meta {
      display: flex;
      gap: 8px;
      font-size: 8pt;
      color: #555;
      margin-top: 2px;
      flex-wrap: wrap;
    }
    section.shift header .vtype {
      background: #2563eb;
      color: #fff;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    th, td {
      text-align: left;
      padding: 2px 4px;
      vertical-align: top;
    }
    th {
      background: #fafafa;
      font-size: 6.5pt;
      text-transform: uppercase;
      color: #666;
      font-weight: 600;
      border-bottom: 1px solid #ccc;
    }
    tr {
      border-bottom: 1px dashed #e5e7eb;
    }
    tr.dh td {
      background: #fafafa;
      color: #888;
      font-style: italic;
    }
    tr.idle td {
      background: #fffbeb;
      color: #78716c;
      font-style: italic;
      font-size: 8pt;
    }
    tr.depot td {
      background: #ecfeff;
      color: #155e75;
      font-weight: 600;
    }
    tr.depot.midret td {
      background: #fef3c7;
      color: #92400e;
    }
    tr.depot.pullin td {
      background: #cffafe;
      color: #0e7490;
      border-top: 2px solid #0891b2;
    }
    tr.depot.pullout td {
      background: #f0fdf4;
      color: #166534;
      border-bottom: 2px solid #16a34a;
    }
    td.time {
      font-family: "SFMono-Regular", "Menlo", monospace;
      font-size: 7.5pt;
      white-space: nowrap;
      width: 36px;
      font-weight: 600;
    }
    td.line { width: 44px; }
    td.stop {
      font-size: 7.5pt;
      width: auto;
      word-break: break-word;
    }
    td.path {
      font-size: 7pt;
      color: #444;
      word-break: break-word;
    }
    td.path .metasub {
      color: #888;
      font-size: 6.5pt;
      margin-top: 1px;
    }
    section.shift footer.shift-analysis {
      background: #f9fafb;
      border-top: 1px solid #d1d5db;
      padding: 5px 8px;
      font-size: 7.5pt;
      color: #374151;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 2px 10px;
    }
    section.shift footer.shift-analysis .warn-line {
      grid-column: 1 / -1;
      color: #92400e;
      font-weight: 600;
    }
    section.analysis {
      page-break-before: always;
      break-before: page;
      margin-top: 14px;
    }
    section.analysis h2 {
      font-size: 14pt;
      margin: 0 0 8px;
      border-bottom: 2px solid #111;
      padding-bottom: 4px;
    }
    section.analysis h3 {
      font-size: 10pt;
      margin: 10px 0 4px;
      color: #1f2937;
    }
    section.analysis .grid-kpi {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      margin-bottom: 12px;
    }
    section.analysis .kpi {
      border: 1px solid #d1d5db;
      border-radius: 4px;
      padding: 6px 8px;
      background: #f9fafb;
    }
    section.analysis .kpi .lbl {
      font-size: 7.5pt;
      color: #6b7280;
      text-transform: uppercase;
    }
    section.analysis .kpi .val {
      font-size: 14pt;
      font-weight: 700;
      color: #111;
      font-family: "SFMono-Regular", "Menlo", monospace;
    }
    section.analysis .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    section.analysis table.mini {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
    }
    section.analysis table.mini td,
    section.analysis table.mini th {
      border: 1px solid #e5e7eb;
      padding: 3px 6px;
      font-size: 8.5pt;
    }
    section.analysis table.mini th {
      background: #f3f4f6;
      text-align: left;
    }
    section.analysis table.mini tr.totale td {
      background: #fef3c7;
    }
    section.analysis .warn-block {
      background: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 6px 10px;
      margin-top: 8px;
      font-size: 9pt;
      color: #78350f;
    }
    section.analysis .note {
      font-size: 8pt;
      color: #6b7280;
      margin-top: 14px;
      font-style: italic;
    }
    .badge {
      display: inline-block;
      color: #fff;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 700;
      font-size: 8.5pt;
    }
    .head {
      font-size: 8pt;
      color: #555;
      margin-top: 1px;
    }
    .stops {
      font-size: 8pt;
    }
    .meta {
      font-size: 7.5pt;
      color: #777;
    }
    .warn {
      display: inline-block;
      background: #fef3c7;
      color: #92400e;
      padding: 1px 4px;
      border-radius: 2px;
      font-size: 7.5pt;
      font-weight: 600;
    }
    .footer {
      position: fixed;
      bottom: 4mm;
      left: 0; right: 0;
      text-align: center;
      font-size: 7.5pt;
      color: #999;
    }
    @media print {
      .no-print { display: none !important; }
      body { padding: 0 !important; font-size: 8pt; }
      .grid {
        display: grid !important;
        grid-template-columns: repeat(${columnsPerPage}, minmax(0, 1fr)) !important;
        gap: 5px !important;
      }
      section.shift {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      section.analysis {
        page-break-before: always !important;
        break-before: page !important;
      }
      header.doc { margin-bottom: 8px; padding-bottom: 4px; }
    }
    .toolbar {
      position: sticky; top: 0;
      background: #fff;
      padding: 8px 0;
      border-bottom: 1px solid #ddd;
      margin-bottom: 12px;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .toolbar button {
      background: #2563eb;
      color: #fff;
      border: none;
      padding: 6px 14px;
      font-size: 10pt;
      border-radius: 4px;
      cursor: pointer;
    }
    .toolbar button.secondary {
      background: #6b7280;
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <button onclick="window.print()">🖨️ Stampa</button>
    <button class="secondary" onclick="window.close()">Chiudi</button>
  </div>

  <header class="doc">
    <div>
      <h1>${escape(title)}</h1>
      <div style="font-size:8pt;color:#666;margin-top:2px;">Data servizio: ${escape(date)}</div>
    </div>
    <div class="summary">
      <div><strong>${result.shifts.length}</strong> turni macchina</div>
      <div>${summary?.totalTrips ?? result.shifts.reduce((s, v) => s + v.tripCount, 0)} corse · ${summary?.totalServiceHours?.toFixed(1) ?? "—"} h servizio</div>
      <div>${summary?.totalDeadheadKm?.toFixed(0) ?? "—"} km vuoto · efficienza ${summary?.efficiency ? (summary.efficiency * 100).toFixed(0) + "%" : "—"}</div>
    </div>
  </header>

  <div class="grid">
    ${cols}
  </div>

  ${buildGlobalAnalysisHtml(result)}

  <div class="footer">Generato da TransitIntel · ${new Date().toLocaleString("it-IT")}</div>

  <script>
    // Auto-apri il dialog di stampa appena la pagina è pronta
    window.addEventListener("load", () => {
      setTimeout(() => window.print(), 400);
    });
  </script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=1200,height=800");
  if (!w) {
    alert("Il browser ha bloccato la finestra di stampa. Abilita i popup e riprova.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
