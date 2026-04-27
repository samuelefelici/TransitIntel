/**
 * DriverShiftsPrintExport — esporta i turni guida come stampa A4/A3
 * con un turno per colonna, sulla falsariga di VehicleShiftsPrintExport.
 *
 * Layout per colonna (1 turno guida):
 *  ┌────────────────────────────────────────┐
 *  │  Driver-001 · INTERO                   │
 *  │  06:30 → 14:15  (7h45 nastro · 6h30 lav)│
 *  ├────────────────────────────────────────┤
 *  │  RIPRESA 1  06:30→14:15                │
 *  │  ─ Pre-turno     06:30  10′            │
 *  │  ─ Trasf.→ A     06:40  15′            │
 *  │  ─ 12 corse      06:55→13:30           │
 *  │     · L1 06:55→07:30 ferm A → ferm B   │
 *  │     · L1 07:35→08:10 ferm B → ferm A   │
 *  │     · …                                │
 *  │  ─ ↜ Rientro     13:30→14:15           │
 *  │                                        │
 *  │  ─ Cambi in linea: L1@08:30 ←→ V12     │
 *  ├────────────────────────────────────────┤
 *  │  KPI: Lav 6h30 · Vuoto 25′ · Idle 0′   │
 *  │  Cambi 1 · Veicoli V8,V12              │
 *  │  Conformità BDS: ✅ (CEE 561, pasto..)  │
 *  └────────────────────────────────────────┘
 *
 * Pagina finale: analisi globale (composizione tipi, distribuzione,
 * top linee, costi, conformità BDS aggregata).
 */
import type {
  DriverShiftsResult,
  DriverShiftData,
  Ripresa,
  RipresaTrip,
} from "@/pages/driver-shifts/types";
import {
  TYPE_LABELS,
  TYPE_COLORS,
  formatDuration,
} from "@/pages/driver-shifts/constants";

const escape = (s: string | undefined | null) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));

const minToHHMM = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

const fmtDur = (m: number) => {
  if (m <= 0) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h${String(mm).padStart(2, "0")}` : `${mm}′`;
};

/* ── Costruzione righe per ogni ripresa ──────────────────── */

interface SyntheticRow {
  kind: "preTurno" | "transfer" | "transferBack" | "cambio" | "interruption";
  startMin: number;
  endMin: number;
  label: string;
  detail?: string;
}

type RipresaRow =
  | { kind: "trip"; trip: RipresaTrip }
  | SyntheticRow;

function buildRipresaRows(rip: Ripresa): RipresaRow[] {
  const rows: RipresaRow[] = [];
  if (rip.preTurnoMin > 0) {
    rows.push({
      kind: "preTurno",
      startMin: rip.startMin,
      endMin: rip.startMin + rip.preTurnoMin,
      label: "Pre-turno",
      detail: `${rip.preTurnoMin}′`,
    });
  }
  if (rip.transferMin > 0) {
    const tStart = rip.startMin + rip.preTurnoMin;
    rows.push({
      kind: "transfer",
      startMin: tStart,
      endMin: tStart + rip.transferMin,
      label: `Trasf. ↝ ${rip.transferToStop || rip.transferToCluster || "capolinea"}`,
      detail: `${rip.transferMin}′ (${rip.transferType})`,
    });
  }
  for (const t of rip.trips) {
    rows.push({ kind: "trip", trip: t });
  }
  if ((rip.transferBackMin || 0) > 0) {
    const tbStart = rip.endMin - rip.transferBackMin;
    rows.push({
      kind: "transferBack",
      startMin: tbStart,
      endMin: rip.endMin,
      label: `Rientro ↜ ${rip.lastStop || "deposito"}`,
      detail: `${rip.transferBackMin}′ (${rip.transferBackType})`,
    });
  }
  return rows.sort((a, b) => {
    const aS = a.kind === "trip" ? a.trip.departureMin : a.startMin;
    const bS = b.kind === "trip" ? b.trip.departureMin : b.startMin;
    return aS - bS;
  });
}

function ripresaRowHtml(row: RipresaRow): string {
  if (row.kind === "trip") {
    const t = row.trip;
    return `<tr class="trip">
      <td class="line">${escape(t.routeName || t.routeId)}</td>
      <td class="time">${escape(t.departureTime || minToHHMM(t.departureMin))}</td>
      <td class="stop">${escape(t.firstStopName || "—")}</td>
      <td class="path">${escape(t.headsign || "")}${t.vehicleId ? `<span class="veh"> · ${escape(t.vehicleId)}</span>` : ""}</td>
      <td class="stop">${escape(t.lastStopName || "—")}</td>
      <td class="time">${escape(t.arrivalTime || minToHHMM(t.arrivalMin))}</td>
    </tr>`;
  }
  // Synthetic rows
  const cls = row.kind;
  const icon = row.kind === "preTurno" ? "🔧"
    : row.kind === "transfer" ? "↝"
    : row.kind === "transferBack" ? "↜"
    : row.kind === "interruption" ? "☕"
    : "↹";
  return `<tr class="synthetic ${cls}">
    <td class="line">${icon}</td>
    <td class="time">${minToHHMM(row.startMin)}</td>
    <td class="stop" colspan="3"><em>${escape(row.label)}${row.detail ? ` <span class="detail">${escape(row.detail)}</span>` : ""}</em></td>
    <td class="time">${minToHHMM(row.endMin)}</td>
  </tr>`;
}

/* ── Colonna singola turno guida ─────────────────────────── */

function shiftColumnHtml(shift: DriverShiftData): string {
  const typeColor = TYPE_COLORS[shift.type];
  const typeLabel = TYPE_LABELS[shift.type];
  const allVehicles = Array.from(new Set(shift.riprese.flatMap(r => r.vehicleIds))).join(", ");
  const allClusters = Array.from(new Set(shift.riprese.map(r => r.transferToCluster).filter(Boolean))).join(", ");

  const ripreseHtml = shift.riprese.map((rip, idx) => {
    const rows = buildRipresaRows(rip).map(ripresaRowHtml).join("\n");
    return `
      <div class="ripresa">
        <div class="ripresa-head">
          <strong>Ripresa ${idx + 1}</strong>
          <span class="ripresa-time">${escape(rip.startTime)} → ${escape(rip.endTime)}</span>
          <span class="ripresa-meta">lav ${formatDuration(rip.workMin)} · ${rip.trips.length} corse · ${rip.vehicleIds.join(",")}</span>
        </div>
        <table class="trips">
          <thead>
            <tr>
              <th>Linea</th>
              <th>Ora P.</th>
              <th>Da</th>
              <th>Percorso</th>
              <th>A</th>
              <th>Ora A.</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${rip.cambi?.length ? `
          <div class="cambi">
            <strong>Cambi in linea:</strong>
            ${rip.cambi.map(c => `<span class="cambio">@${escape(c.atTime)} <code>${escape(c.fromVehicle)}→${escape(c.toVehicle)}</code> (${escape(c.clusterName)})</span>`).join(" · ")}
          </div>
        ` : ""}
      </div>
    `;
  }).join(`<div class="interruption">⏸ Interruzione: ${escape(shift.interruption || "")} (${formatDuration(shift.interruptionMin || 0)})</div>`);

  // BDS validation badge
  const bdsBadge = shift.bdsValidation
    ? (shift.bdsValidation.valid
        ? `<span class="bds ok" title="Conforme">✅ BDS</span>`
        : `<span class="bds ko" title="${escape(shift.bdsValidation.violations.join(' · '))}">⚠ BDS ${shift.bdsValidation.violations.length}</span>`)
    : "";

  return `<section class="shift" style="--type-color:${typeColor};">
    <header>
      <h2>${escape(shift.driverId)}</h2>
      <div class="meta">
        <span class="type-badge">${escape(typeLabel)}</span>
        <span>${escape(shift.nastroStart)}–${escape(shift.nastroEnd)}</span>
        <span>(${escape(shift.nastro)})</span>
        ${bdsBadge}
      </div>
    </header>

    <div class="content">
      ${ripreseHtml}
    </div>

    <footer class="shift-analysis">
      <div><strong>Lavoro:</strong> ${escape(shift.work)}</div>
      <div><strong>Nastro:</strong> ${escape(shift.nastro)}</div>
      ${shift.interruptionMin ? `<div><strong>Interruzione:</strong> ${formatDuration(shift.interruptionMin)}</div>` : ""}
      ${shift.preTurnoMin ? `<div><strong>Pre-turno:</strong> ${shift.preTurnoMin}′</div>` : ""}
      ${shift.transferMin || shift.transferBackMin ? `<div><strong>Transfer:</strong> ${shift.transferMin || 0}′ + ${shift.transferBackMin || 0}′</div>` : ""}
      ${shift.cambiCount ? `<div><strong>Cambi:</strong> ${shift.cambiCount}</div>` : ""}
      <div><strong>Veicoli:</strong> ${escape(allVehicles)}</div>
      ${allClusters ? `<div><strong>Cluster:</strong> ${escape(allClusters)}</div>` : ""}
      ${shift.costEuro != null ? `<div><strong>Costo:</strong> €${shift.costEuro.toFixed(0)}</div>` : ""}
      ${shift.workCalculation ? `
        <div class="calc">
          <strong>Calcolo (BDS):</strong>
          <span>netto ${fmtDur(shift.workCalculation.lavoroNetto)}</span>
          <span>· conv. ${fmtDur(shift.workCalculation.lavoroConvenzionale)}</span>
          <span>· guida ${fmtDur(shift.workCalculation.driving)}</span>
          ${shift.workCalculation.idleAtTerminal ? `<span>· idle ${fmtDur(shift.workCalculation.idleAtTerminal)}</span>` : ""}
        </div>
      ` : ""}
    </footer>
  </section>`;
}

/* ── Analisi globale ─────────────────────────────────────── */

function buildGlobalAnalysisHtml(result: DriverShiftsResult): string {
  const shifts = result.driverShifts;
  const summary = result.summary;
  const n = shifts.length;

  // Top linee per numero corse coperte
  const routeCounts: Record<string, { name: string; count: number }> = {};
  for (const s of shifts) for (const r of s.riprese) for (const t of r.trips) {
    if (!routeCounts[t.routeId]) routeCounts[t.routeId] = { name: t.routeName, count: 0 };
    routeCounts[t.routeId].count += 1;
  }
  const topRoutes = Object.entries(routeCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);

  // Distribuzione nastri
  const nastri = shifts.map(s => s.nastroMin).sort((a, b) => a - b);
  const median = nastri.length ? nastri[Math.floor(nastri.length / 2)] : 0;
  const minN = nastri[0] ?? 0;
  const maxN = nastri[nastri.length - 1] ?? 0;

  // BDS
  const withBds = shifts.filter(s => s.bdsValidation);
  const conformi = withBds.filter(s => s.bdsValidation!.valid).length;
  const bdsPct = withBds.length ? Math.round((conformi / withBds.length) * 100) : null;

  // Cambi in linea
  const totalCambi = shifts.reduce((acc, s) => acc + (s.cambiCount || 0), 0);

  // Costi
  const costBreakdown = summary.costBreakdown || result.costAnalysis?.breakdown;

  return `<section class="analysis">
    <h2>📊 Analisi turni guida</h2>
    <div class="grid-kpi">
      <div class="kpi"><div class="lbl">Autisti</div><div class="val">${summary.totalDriverShifts}</div></div>
      <div class="kpi"><div class="lbl">Ore lavoro</div><div class="val">${summary.totalWorkHours.toFixed(1)}h</div></div>
      <div class="kpi"><div class="lbl">Ore nastro</div><div class="val">${summary.totalNastroHours.toFixed(1)}h</div></div>
      <div class="kpi"><div class="lbl">Semiunici</div><div class="val">${summary.semiunicoPct}%</div></div>
      <div class="kpi"><div class="lbl">Spezzati</div><div class="val">${summary.spezzatoPct}%</div></div>
      <div class="kpi"><div class="lbl">Cambi linea</div><div class="val">${summary.totalCambi || totalCambi}</div></div>
      <div class="kpi"><div class="lbl">Auto aziendali</div><div class="val">${summary.companyCarsUsed}/${result.companyCars}</div></div>
      ${bdsPct !== null ? `<div class="kpi ${bdsPct >= 90 ? 'ok' : bdsPct >= 70 ? 'warn' : 'ko'}"><div class="lbl">Conformità BDS</div><div class="val">${bdsPct}%</div></div>` : ""}
      ${result.unassignedBlocks > 0 ? `<div class="kpi ko"><div class="lbl">Non assegnati</div><div class="val">${result.unassignedBlocks}</div></div>` : ""}
    </div>

    <div class="two-col">
      <div>
        <h3>Composizione per tipo</h3>
        <table class="mini">
          <thead><tr><th>Tipo</th><th>N</th><th>%</th></tr></thead>
          <tbody>
            ${(Object.keys(summary.byType) as Array<keyof typeof summary.byType>).map(k => {
              const v = (summary.byType as any)[k] as number;
              if (!v) return "";
              return `<tr><td>${escape(TYPE_LABELS[k] || String(k))}</td><td>${v}</td><td>${((v / n) * 100).toFixed(0)}%</td></tr>`;
            }).join("")}
          </tbody>
        </table>
        <h3>Distribuzione nastro</h3>
        <table class="mini">
          <tbody>
            <tr><td>Più corto</td><td><strong>${fmtDur(minN)}</strong></td></tr>
            <tr><td>Mediana</td><td><strong>${fmtDur(median)}</strong></td></tr>
            <tr><td>Più lungo</td><td><strong>${fmtDur(maxN)}</strong></td></tr>
            <tr><td>Media lavoro</td><td><strong>${fmtDur(summary.avgWorkMin)}</strong></td></tr>
            <tr><td>Media nastro</td><td><strong>${fmtDur(summary.avgNastroMin)}</strong></td></tr>
          </tbody>
        </table>
      </div>
      <div>
        <h3>Linee più presidiate</h3>
        <table class="mini">
          <thead><tr><th>Linea</th><th>Corse</th></tr></thead>
          <tbody>
            ${topRoutes.map(([_id, r]) =>
              `<tr><td>${escape(r.name)}</td><td>${r.count}</td></tr>`
            ).join("")}
          </tbody>
        </table>
        ${summary.totalDailyCost != null && summary.totalDailyCost > 0 ? `
          <h3>Costi giornalieri</h3>
          <table class="mini">
            <tbody>
              ${costBreakdown ? Object.entries(costBreakdown).map(([k, v]) =>
                `<tr><td>${escape(k)}</td><td>€ ${(v as number).toFixed(0)}</td></tr>`
              ).join("") : ""}
              <tr class="totale"><td><strong>TOTALE</strong></td><td><strong>€ ${summary.totalDailyCost.toFixed(0)}</strong></td></tr>
              ${summary.efficiency?.costPerDriver ? `<tr><td>per autista</td><td>€ ${summary.efficiency.costPerDriver.toFixed(0)}</td></tr>` : ""}
            </tbody>
          </table>
        ` : ""}
        ${withBds.length ? `
          <h3>Violazioni BDS</h3>
          <table class="mini">
            <tbody>
              ${(() => {
                const violCount: Record<string, number> = {};
                for (const s of withBds) {
                  if (s.bdsValidation!.valid) continue;
                  for (const v of s.bdsValidation!.violations) {
                    const key = v.split(":")[0].slice(0, 50);
                    violCount[key] = (violCount[key] || 0) + 1;
                  }
                }
                return Object.entries(violCount).sort((a, b) => b[1] - a[1]).slice(0, 6)
                  .map(([k, v]) => `<tr><td>${escape(k)}</td><td>${v}</td></tr>`).join("")
                  || "<tr><td colspan='2'><em>Nessuna violazione</em></td></tr>";
              })()}
            </tbody>
          </table>
        ` : ""}
      </div>
    </div>

    ${result.optimizationAnalysis ? `
      <h3>🧠 Ottimizzazione CP-SAT</h3>
      <div class="opt-meta">
        <span><strong>Strategia vincente:</strong> ${escape(result.optimizationAnalysis.bestStrategyLabel || result.optimizationAnalysis.bestStrategy)}</span>
        <span><strong>Score:</strong> ${result.optimizationAnalysis.bestScore.toFixed(0)}</span>
        <span><strong>Scenari:</strong> ${result.optimizationAnalysis.nFeasible}/${result.optimizationAnalysis.nScenariosRun} fattibili</span>
        <span><strong>Tempo totale:</strong> ${result.optimizationAnalysis.totalElapsedSec.toFixed(0)}s</span>
        ${result.optimizationAnalysis.polishImproved ? `<span class="ok"><strong>Polish:</strong> +${result.optimizationAnalysis.polishDeltaPct.toFixed(1)}%</span>` : ""}
      </div>
    ` : ""}

    <p class="note">
      Note: <em>nastro</em> = tempo totale dall'inizio al fine turno; <em>lavoro</em> = tempo retribuito (esclude interruzione &gt; 1h);
      <em>cambi in linea</em> = passaggi di vettura senza tornare in deposito; la <em>conformità BDS</em> verifica regole CEE 561, intervallo pasto,
      stacco minimo, durata nastro e numero riprese.
    </p>
  </section>`;
}

/* ── Export entrypoint ───────────────────────────────────── */

export interface DriverPrintOptions {
  /** Colonne per pagina (default 2 — i turni guida sono più larghi) */
  columnsPerPage?: number;
  /** Etichette custom (driverId → label) */
  customLabels?: Record<string, string>;
  /** Nome scenario in header */
  scenarioName?: string;
  /** Orientamento (default landscape) */
  orientation?: "portrait" | "landscape";
}

export function exportDriverShiftsToPrint(result: DriverShiftsResult, opts: DriverPrintOptions = {}) {
  const { columnsPerPage = 2, scenarioName, orientation = "landscape" } = opts;

  const sortedShifts = result.driverShifts.slice().sort((a, b) => a.nastroStartMin - b.nastroStartMin);
  const cols = sortedShifts.map(shiftColumnHtml).join("\n");

  const date = result.date || new Date().toISOString().slice(0, 10);
  const title = scenarioName?.trim() || result.scenarioName || `Scenario turni guida ${date}`;

  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>${escape(title)}</title>
  <style>
    @page { size: A4 ${orientation}; margin: 10mm 8mm 12mm 8mm; }
    html, body, * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #111;
      font-size: 8pt;
      line-height: 1.3;
      padding: 0 4mm;
    }
    header.doc {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 2px solid #6b21a8;
      padding-bottom: 6px;
      margin-bottom: 12px;
    }
    header.doc h1 { font-size: 14pt; margin: 0; color: #581c87; }
    header.doc .summary {
      text-align: right;
      font-size: 9pt;
      color: #444;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(${columnsPerPage}, minmax(0, 1fr));
      gap: 8px;
      width: 100%;
    }
    section.shift {
      page-break-inside: avoid;
      break-inside: avoid;
      border: 1px solid #999;
      border-left: 4px solid var(--type-color, #6b21a8);
      border-radius: 4px;
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
      background: #fff;
    }
    section.shift header {
      background: #f3e8ff;
      padding: 6px 8px;
      border-bottom: 1px solid #c4b5fd;
    }
    section.shift header h2 {
      margin: 0 0 2px 0;
      font-size: 10.5pt;
      font-weight: 700;
      color: var(--type-color, #581c87);
    }
    section.shift header .meta {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      font-size: 8pt;
      color: #555;
      align-items: center;
    }
    .type-badge {
      background: var(--type-color, #6b21a8);
      color: white;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .bds.ok { color: #047857; font-weight: 600; }
    .bds.ko { color: #b91c1c; font-weight: 600; }

    section.shift .content { padding: 4px 6px; }

    .ripresa { margin-bottom: 6px; }
    .ripresa-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
      background: #faf5ff;
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 8pt;
      margin-bottom: 2px;
    }
    .ripresa-head strong { color: #581c87; }
    .ripresa-head .ripresa-time { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    .ripresa-head .ripresa-meta { color: #777; font-size: 7.5pt; }

    table.trips {
      width: 100%;
      border-collapse: collapse;
      font-size: 7.5pt;
    }
    table.trips th {
      background: #ede9fe;
      color: #4c1d95;
      font-weight: 600;
      padding: 2px 4px;
      text-align: left;
      border-bottom: 1px solid #c4b5fd;
    }
    table.trips td {
      padding: 2px 4px;
      border-bottom: 1px dotted #e5e7eb;
      vertical-align: top;
    }
    table.trips td.line { font-weight: 600; color: #4c1d95; white-space: nowrap; }
    table.trips td.time { font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space: nowrap; }
    table.trips td.stop { color: #555; max-width: 110px; overflow: hidden; text-overflow: ellipsis; }
    table.trips td.path { color: #777; font-size: 7pt; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
    table.trips td.path .veh { color: #9ca3af; font-style: italic; }

    table.trips tr.synthetic td { background: #fffbeb; color: #92400e; font-style: italic; }
    table.trips tr.synthetic td .detail { color: #78716c; font-size: 7pt; margin-left: 4px; }
    table.trips tr.synthetic.preTurno td,
    table.trips tr.synthetic.transferBack td { background: #f0fdf4; color: #166534; }
    table.trips tr.synthetic.transfer td { background: #eff6ff; color: #1e40af; }
    table.trips tr.synthetic.interruption td { background: #f3f4f6; color: #4b5563; }

    .cambi {
      margin-top: 3px;
      padding: 3px 6px;
      background: #fff7ed;
      border-left: 2px solid #fb923c;
      font-size: 7.5pt;
      color: #9a3412;
    }
    .cambi code { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #fed7aa; padding: 0 3px; border-radius: 2px; }

    .interruption {
      margin: 4px 0;
      padding: 3px 6px;
      background: #fef3c7;
      border: 1px dashed #d97706;
      border-radius: 3px;
      font-size: 7.5pt;
      color: #92400e;
      font-weight: 600;
      text-align: center;
    }

    section.shift footer.shift-analysis {
      border-top: 1px solid #e5e7eb;
      padding: 4px 6px;
      background: #fafafa;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      font-size: 7.5pt;
      color: #444;
    }
    section.shift footer.shift-analysis strong { color: #581c87; }
    section.shift footer.shift-analysis .calc {
      width: 100%;
      margin-top: 2px;
      padding-top: 2px;
      border-top: 1px dotted #e5e7eb;
      color: #6b7280;
      font-size: 7pt;
    }
    section.shift footer.shift-analysis .calc span { margin-right: 4px; }

    /* Analisi globale */
    section.analysis {
      page-break-before: always;
      break-before: page;
      padding-top: 8px;
    }
    section.analysis h2 { color: #581c87; border-bottom: 2px solid #c4b5fd; padding-bottom: 4px; }
    section.analysis h3 { color: #6b21a8; margin-top: 12px; margin-bottom: 4px; font-size: 10pt; }
    .grid-kpi {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin: 8px 0;
    }
    .kpi {
      border: 1px solid #c4b5fd;
      background: #faf5ff;
      border-radius: 4px;
      padding: 6px 8px;
      text-align: center;
    }
    .kpi.ok { background: #f0fdf4; border-color: #86efac; }
    .kpi.warn { background: #fffbeb; border-color: #fcd34d; }
    .kpi.ko { background: #fef2f2; border-color: #fca5a5; }
    .kpi .lbl { font-size: 7.5pt; color: #6b7280; text-transform: uppercase; letter-spacing: 0.4px; }
    .kpi .val { font-size: 14pt; font-weight: 700; color: #4c1d95; margin-top: 2px; }
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 8px;
    }
    table.mini { width: 100%; border-collapse: collapse; font-size: 8pt; }
    table.mini th { background: #ede9fe; color: #4c1d95; padding: 3px 6px; text-align: left; border-bottom: 1px solid #c4b5fd; }
    table.mini td { padding: 2px 6px; border-bottom: 1px dotted #e5e7eb; }
    table.mini tr.totale td { border-top: 2px solid #6b21a8; padding-top: 4px; }
    .opt-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      padding: 6px 10px;
      background: #faf5ff;
      border-left: 3px solid #6b21a8;
      border-radius: 3px;
      font-size: 8.5pt;
      margin-top: 4px;
    }
    .opt-meta .ok { color: #047857; }
    .note { font-size: 7.5pt; color: #6b7280; font-style: italic; margin-top: 8px; }

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
      body { padding: 0 !important; font-size: 7.5pt; }
      .grid {
        display: grid !important;
        grid-template-columns: repeat(${columnsPerPage}, minmax(0, 1fr)) !important;
        gap: 6px !important;
      }
      section.shift {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
      section.analysis {
        page-break-before: always !important;
        break-before: page !important;
      }
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
      background: #6b21a8;
      color: #fff;
      border: none;
      padding: 6px 14px;
      font-size: 10pt;
      border-radius: 4px;
      cursor: pointer;
    }
    .toolbar button.secondary { background: #6b7280; }
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
      <div><strong>${result.driverShifts.length}</strong> turni guida</div>
      <div>${result.summary.totalWorkHours.toFixed(1)}h lavoro · ${result.summary.totalNastroHours.toFixed(1)}h nastro</div>
      <div>${result.summary.byType.intero || 0} interi · ${result.summary.byType.semiunico || 0} semi · ${result.summary.byType.spezzato || 0} spez</div>
    </div>
  </header>

  <div class="grid">
    ${cols}
  </div>

  ${buildGlobalAnalysisHtml(result)}

  <div class="footer">Generato da TransitIntel · ${new Date().toLocaleString("it-IT")}</div>

  <script>
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

/* ── Export CSV (riga = corsa) ───────────────────────────── */

export function exportDriverShiftsToCsv(result: DriverShiftsResult): string {
  const rows: string[][] = [];
  rows.push([
    "driverId", "type", "nastroStart", "nastroEnd", "nastroMin", "workMin",
    "interruptionMin", "preTurnoMin", "transferMin", "transferBackMin", "cambiCount",
    "ripresaIdx", "ripresaStart", "ripresaEnd", "ripresaWorkMin",
    "tripId", "routeId", "routeName", "headsign",
    "departureTime", "arrivalTime", "firstStopName", "lastStopName",
    "vehicleId", "vehicleType",
    "bdsValid", "bdsViolations", "costEuro",
  ]);
  for (const s of result.driverShifts) {
    s.riprese.forEach((rip, ri) => {
      if (rip.trips.length === 0) {
        rows.push([
          s.driverId, s.type, s.nastroStart, s.nastroEnd, String(s.nastroMin), String(s.workMin),
          String(s.interruptionMin), String(s.preTurnoMin), String(s.transferMin), String(s.transferBackMin), String(s.cambiCount),
          String(ri + 1), rip.startTime, rip.endTime, String(rip.workMin),
          "", "", "", "", "", "", "", "", "", "",
          s.bdsValidation ? (s.bdsValidation.valid ? "1" : "0") : "",
          s.bdsValidation ? s.bdsValidation.violations.join(" | ") : "",
          s.costEuro != null ? String(s.costEuro.toFixed(2)) : "",
        ]);
        return;
      }
      for (const t of rip.trips) {
        rows.push([
          s.driverId, s.type, s.nastroStart, s.nastroEnd, String(s.nastroMin), String(s.workMin),
          String(s.interruptionMin), String(s.preTurnoMin), String(s.transferMin), String(s.transferBackMin), String(s.cambiCount),
          String(ri + 1), rip.startTime, rip.endTime, String(rip.workMin),
          t.tripId, t.routeId, t.routeName, t.headsign || "",
          t.departureTime, t.arrivalTime, t.firstStopName || "", t.lastStopName || "",
          t.vehicleId || "", t.vehicleType || "",
          s.bdsValidation ? (s.bdsValidation.valid ? "1" : "0") : "",
          s.bdsValidation ? s.bdsValidation.violations.join(" | ") : "",
          s.costEuro != null ? String(s.costEuro.toFixed(2)) : "",
        ]);
      }
    });
  }
  return rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
}

/** Trigger download di un file (browser-side helper) */
export function triggerDownload(content: string, filename: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
