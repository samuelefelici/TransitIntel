/* ═══════════════════════════════════════════════════════════════
 *  SchedulingReportExport
 *  Genera un report HTML stampabile (PDF tramite browser) che
 *  documenta tutto il processo di Scheduling Engine eseguito:
 *  Programma di Esercizio → Turni Macchina → Turni Guida.
 *
 *  Usage:
 *    <ExportReportButton
 *       result={driverShiftsResult}
 *       config={operatorConfig}
 *       solverMode="cpsat"
 *       scenarioName="Feriale invernale"
 *       date="2026-04-18"
 *    />
 * ═══════════════════════════════════════════════════════════════ */

import React from "react";
import { FileDown } from "lucide-react";
import type { DriverShiftsResult } from "@/pages/driver-shifts/types";
import type { OperatorConfig } from "@/hooks/use-crew-optimization";

/* ─── helpers ─── */
const fmt = (n: number | undefined | null, d = 0) =>
  n == null ? "–" : n.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtEur = (n: number | undefined | null) => (n == null ? "–" : `€ ${fmt(n, 0)}`);
const fmtPct = (n: number | undefined | null, d = 1) => (n == null ? "–" : `${fmt(n, d)}%`);
const fmtHHmm = (mins?: number) => {
  if (mins == null) return "–";
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${h}h ${String(m).padStart(2, "0")}`;
};
const intensityLabel = (i?: number) => {
  switch (i) {
    case 1: return "Rapido (~90s · 14 scenari)";
    case 2: return "Standard (~4 min · 24 scenari)";
    case 3: return "Aggressivo (~8 min · 36 scenari)";
    case 4: return "Estremo (~15 min · 48 scenari)";
    default: return `Personalizzato (${i})`;
  }
};

/* ─── Render del report HTML ─── */
function buildReportHTML(args: {
  result: DriverShiftsResult;
  config: OperatorConfig;
  solverMode: "greedy" | "cpsat";
  scenarioName?: string;
  date?: string;
  vehicleScenario?: any;
}): string {
  const { result, config, solverMode, scenarioName, date, vehicleScenario } = args;
  const r = result;
  const summary = r.summary;
  const oa = r.optimizationAnalysis;
  const scenarios = r.scenarios ?? [];

  // ── Vehicle scheduling data (turni macchina) ──
  const vsRow = vehicleScenario ?? {};
  const vsResult = vsRow.result ?? {};
  const vehicleShifts: any[] = Array.isArray(vsResult.shifts) ? vsResult.shifts : [];
  const vsSummary = vsResult.summary ?? {};
  const vsCosts = vsResult.costs ?? {};
  const vsScore = vsResult.score ?? {};
  const vsAdvisories: any[] = Array.isArray(vsResult.advisories) ? vsResult.advisories : [];
  const vsOptAnalysis = vsResult.optimizationAnalysis;
  const vsScenarioRanking: any[] = Array.isArray(vsResult.scenarioRanking) ? vsResult.scenarioRanking : [];

  // ── Intermodalità: link tra turni macchina e turni guida ──
  const driversPerVehicle = new Map<string, Set<string>>();
  const vehiclesPerDriver = new Map<string, Set<string>>();
  for (const ds of r.driverShifts) {
    const driverId = ds.driverId;
    if (!vehiclesPerDriver.has(driverId)) vehiclesPerDriver.set(driverId, new Set());
    for (const rip of (ds.riprese ?? [])) {
      for (const vId of (rip.vehicleIds ?? [])) {
        vehiclesPerDriver.get(driverId)!.add(vId);
        if (!driversPerVehicle.has(vId)) driversPerVehicle.set(vId, new Set());
        driversPerVehicle.get(vId)!.add(driverId);
      }
    }
  }
  const intermodal = {
    nVehicles: driversPerVehicle.size,
    nDrivers: vehiclesPerDriver.size,
    driversPerVehAvg: driversPerVehicle.size > 0
      ? Array.from(driversPerVehicle.values()).reduce((s, set) => s + set.size, 0) / driversPerVehicle.size
      : 0,
    vehPerDriverAvg: vehiclesPerDriver.size > 0
      ? Array.from(vehiclesPerDriver.values()).reduce((s, set) => s + set.size, 0) / vehiclesPerDriver.size
      : 0,
    multiVehicleDrivers: Array.from(vehiclesPerDriver.values()).filter(set => set.size > 1).length,
    multiDriverVehicles: Array.from(driversPerVehicle.values()).filter(set => set.size > 1).length,
    totalHandovers: r.driverShifts.reduce(
      (s, ds) => s + (ds.handovers?.filter(h => h.role === "outgoing").length ?? 0), 0),
    intraTripCambi: summary.totalIntraCambi ?? 0,
    interTripCambi: summary.totalInterCambi ?? summary.totalCambi,
  };

  const bestScenario = scenarios.find(s => s.isBest) ?? scenarios[0];
  const polish = scenarios.find(s => s.isPolish);
  void bestScenario; void polish; // (riservati per estensioni future)

  const totalDuties = summary.totalDriverShifts;
  const bds = (config as any).bds ?? {};
  const shiftRules = bds.shiftRules ?? {};

  // Conformità BDS aggregata
  const withBds = r.driverShifts.filter(s => s.bdsValidation);
  const bdsConformi = withBds.filter(s => s.bdsValidation!.valid).length;
  const bdsPct = withBds.length > 0 ? Math.round((bdsConformi / withBds.length) * 100) : 0;

  // Distribuzione carico
  const works = r.driverShifts.map(s => s.workMin);
  const minWork = works.length ? Math.min(...works) : 0;
  const maxWork = works.length ? Math.max(...works) : 0;
  const avgWork = works.length ? works.reduce((a, b) => a + b, 0) / works.length : 0;

  const today = new Date().toLocaleString("it-IT", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  /* ─── HTML ─── */
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8" />
<title>Scheduling Engine — Report di Ottimizzazione</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 11px; line-height: 1.5; }
  .page { max-width: 920px; margin: 0 auto; padding: 32px 40px; }

  /* Header */
  .hero {
    background: linear-gradient(135deg, #f97316 0%, #dc2626 100%);
    color: #fff; padding: 28px 32px; border-radius: 12px; margin-bottom: 28px;
  }
  .hero h1 { margin: 0 0 4px; font-size: 22px; font-weight: 700; }
  .hero .sub { font-size: 12px; opacity: 0.9; margin-bottom: 16px; }
  .hero .meta { display: flex; gap: 24px; font-size: 11px; opacity: 0.95; flex-wrap: wrap; }
  .hero .meta strong { display: block; font-size: 9px; text-transform: uppercase;
    letter-spacing: 0.5px; opacity: 0.75; margin-bottom: 2px; font-weight: 600; }

  /* Section */
  section { margin-bottom: 28px; page-break-inside: avoid; }
  h2 {
    font-size: 14px; font-weight: 700; margin: 0 0 12px; color: #c2410c;
    padding-bottom: 6px; border-bottom: 2px solid #fed7aa;
    display: flex; align-items: center; gap: 8px;
  }
  h2 .num { background: #f97316; color: #fff; width: 22px; height: 22px;
    border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700; }
  h3 { font-size: 12px; font-weight: 700; margin: 16px 0 8px; color: #1f2937; }
  p { margin: 0 0 8px; }

  /* KPI grid */
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
  .kpi {
    background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 10px 12px;
  }
  .kpi .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
    color: #9a3412; font-weight: 600; margin-bottom: 4px; }
  .kpi .val { font-size: 18px; font-weight: 700; color: #111; line-height: 1; }
  .kpi .sub { font-size: 9px; color: #6b7280; margin-top: 3px; }

  /* Tabelle */
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 10px; }
  th { background: #fef3c7; color: #92400e; text-align: left; padding: 6px 8px;
    border-bottom: 1px solid #fcd34d; font-weight: 600; font-size: 9px;
    text-transform: uppercase; letter-spacing: 0.3px; }
  td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tr:hover td { background: #fafafa; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }

  /* Pipeline boxes */
  .pipeline { display: grid; grid-template-columns: 1fr 24px 1fr 24px 1fr; align-items: stretch; gap: 0; margin: 16px 0; }
  .pipeline .step {
    background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;
  }
  .pipeline .arrow { display: flex; align-items: center; justify-content: center;
    color: #f97316; font-size: 16px; font-weight: 700; }
  .pipeline .step .num {
    background: #f97316; color: #fff; width: 20px; height: 20px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; margin-right: 6px;
  }
  .pipeline .step .title { font-size: 11px; font-weight: 700; color: #1f2937; margin-bottom: 6px; }
  .pipeline .step .desc { font-size: 9px; color: #4b5563; line-height: 1.4; }

  /* Badge */
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px;
    font-size: 9px; font-weight: 600; }
  .badge.ok { background: #d1fae5; color: #065f46; }
  .badge.warn { background: #fef3c7; color: #92400e; }
  .badge.err { background: #fee2e2; color: #991b1b; }
  .badge.info { background: #dbeafe; color: #1e40af; }
  .badge.fire { background: linear-gradient(135deg, #f97316, #dc2626); color: #fff; }

  /* Callout */
  .callout {
    background: #fff7ed; border-left: 3px solid #f97316;
    padding: 10px 14px; border-radius: 4px; margin: 10px 0;
  }
  .callout .lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px;
    color: #c2410c; font-weight: 600; margin-bottom: 3px; }

  /* 2-col config grid */
  .cfg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cfg-block { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; }
  .cfg-block dt { font-size: 9px; text-transform: uppercase; color: #6b7280; font-weight: 600; }
  .cfg-block dd { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: #111; }

  /* Footer */
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb;
    font-size: 9px; color: #9ca3af; text-align: center; }

  /* Print */
  @media print {
    .page { padding: 16px 20px; }
    .hero { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    section { page-break-inside: avoid; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- HERO -->
  <div class="hero">
    <h1>🔥 Scheduling Engine — Report di Ottimizzazione</h1>
    <div class="sub">Pipeline completa: Programma di Esercizio → Turni Macchina → Turni Guida</div>
    <div class="meta">
      <div><strong>Scenario</strong>${escapeHtml(scenarioName ?? r.scenarioName ?? "—")}</div>
      <div><strong>Data servizio</strong>${escapeHtml(date ?? r.date ?? "—")}</div>
      <div><strong>Solver</strong>${solverMode === "cpsat" ? "CP-SAT (multi-scenario)" : "Greedy"}</div>
      <div><strong>Generato</strong>${today}</div>
    </div>
  </div>

  <!-- 1. EXECUTIVE SUMMARY -->
  <section>
    <h2><span class="num">1</span> Riepilogo esecutivo</h2>
    <p>L'ottimizzazione ha generato
    ${vehicleShifts.length > 0 ? `<strong>${vehicleShifts.length} turni macchina</strong> e ` : ""}
    <strong>${totalDuties} turni guida</strong>
    con <strong>${fmtPct(bdsPct, 0)}</strong> di conformità normativa BDS
    e un costo giornaliero stimato di <strong>${fmtEur((vsCosts.totalDailyCost ?? 0) + (summary.totalDailyCost ?? 0))}</strong>
    (turni macchina ${fmtEur(vsCosts.totalDailyCost)} + turni guida ${fmtEur(summary.totalDailyCost)}).</p>

    <h3 style="margin-top:14px">🚌 Turni macchina</h3>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Veicoli</div>
        <div class="val">${vehicleShifts.length || (vsSummary.totalVehicles ?? "—")}</div>
        <div class="sub">${vsSummary.totalTrips ? `${vsSummary.totalTrips} corse servite` : ""}</div>
      </div>
      <div class="kpi">
        <div class="label">Ore servizio</div>
        <div class="val">${vsSummary.totalServiceHours != null ? `${vsSummary.totalServiceHours}h` : "—"}</div>
        <div class="sub">vuoti: ${vsSummary.totalDeadheadHours != null ? `${vsSummary.totalDeadheadHours}h` : "—"}</div>
      </div>
      <div class="kpi">
        <div class="label">Km a vuoto</div>
        <div class="val">${vsSummary.totalDeadheadKm != null ? `${fmt(vsSummary.totalDeadheadKm, 0)} km` : "—"}</div>
        <div class="sub">${vsSummary.depotReturns != null ? `${vsSummary.depotReturns} rientri depot` : ""}</div>
      </div>
      <div class="kpi">
        <div class="label">Efficienza</div>
        <div class="val">${vsSummary.efficiency != null ? `${vsSummary.efficiency}%` : "—"}</div>
        <div class="sub">servizio / (servizio + vuoto)</div>
      </div>
    </div>

    <h3 style="margin-top:14px">👤 Turni guida</h3>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Autisti</div>
        <div class="val">${totalDuties}</div>
        <div class="sub">${summary.byType.intero}I · ${summary.byType.semiunico}SU · ${summary.byType.spezzato}SP${summary.byType.supplemento ? ` · ${summary.byType.supplemento}Sup` : ""}</div>
      </div>
      <div class="kpi">
        <div class="label">Ore Lavoro</div>
        <div class="val">${summary.totalWorkHours}h</div>
        <div class="sub">media ${fmtHHmm(summary.avgWorkMin)}/turno</div>
      </div>
      <div class="kpi">
        <div class="label">Ore Nastro</div>
        <div class="val">${summary.totalNastroHours}h</div>
        <div class="sub">media ${fmtHHmm(summary.avgNastroMin)}/turno</div>
      </div>
      <div class="kpi">
        <div class="label">Costo giornata</div>
        <div class="val">${fmtEur(summary.totalDailyCost)}</div>
        <div class="sub">${summary.efficiency?.costPerDriver ? `€${Math.round(summary.efficiency.costPerDriver)}/autista` : "—"}</div>
      </div>
      <div class="kpi">
        <div class="label">Semiunici</div>
        <div class="val">${fmtPct(summary.semiunicoPct)}</div>
        <div class="sub">limite ≤ 12% · ${summary.semiunicoPct <= 12 ? "<span class='badge ok'>OK</span>" : "<span class='badge err'>oltre</span>"}</div>
      </div>
      <div class="kpi">
        <div class="label">Spezzati</div>
        <div class="val">${fmtPct(summary.spezzatoPct)}</div>
        <div class="sub">limite ≤ 13% · ${summary.spezzatoPct <= 13 ? "<span class='badge ok'>OK</span>" : "<span class='badge err'>oltre</span>"}</div>
      </div>
      <div class="kpi">
        <div class="label">Cambi in linea</div>
        <div class="val">${summary.totalCambi}</div>
        <div class="sub">${summary.totalInterCambi != null ? `${summary.totalInterCambi} inter${summary.totalIntraCambi ? ` + ${summary.totalIntraCambi} intra` : ""}` : ""}</div>
      </div>
      <div class="kpi">
        <div class="label">Conformità BDS</div>
        <div class="val">${bdsPct}%</div>
        <div class="sub">${bdsConformi}/${withBds.length} turni conformi</div>
      </div>
    </div>
  </section>

  <!-- 2. PIPELINE -->
  <section>
    <h2><span class="num">2</span> Pipeline di ottimizzazione</h2>
    <p>Processo end-to-end ispirato agli ottimizzatori professionali (Maior · GIRO HASTUS):
    portfolio multi-scenario con strategie alternative + polish phase finale.</p>
    <div class="pipeline">
      <div class="step">
        <div class="title"><span class="num">1</span>Programma di Esercizio</div>
        <div class="desc">Lista corse pianificate con orari, capolinea, tipo veicolo richiesto.</div>
      </div>
      <div class="arrow">→</div>
      <div class="step">
        <div class="title"><span class="num">2</span>Turni Macchina</div>
        <div class="desc">CP-SAT su 8 strategie (balanced, monolinea, min_deadhead, …).
        Output: blocchi veicolo con vuoti e rientri deposito.</div>
      </div>
      <div class="arrow">→</div>
      <div class="step">
        <div class="title"><span class="num">3</span>Turni Guida</div>
        <div class="desc">CP-SAT multi-scenario con vincoli BDS (RD 131, CE 561, pasto, riprese).
        Polish phase finale.</div>
      </div>
    </div>
  </section>

  <!-- 3. CONFIGURAZIONE -->
  <section>
    <h2><span class="num">3</span> Configurazione utilizzata</h2>
    <div class="cfg-grid">
      <div class="cfg-block">
        <h3 style="margin-top:0">⚙️ Solver</h3>
        <dl>
          <dt>Modalità</dt><dd>${solverMode === "cpsat" ? "CP-SAT (Google OR-Tools)" : "Greedy"}</dd>
          <dt>Intensità</dt><dd>${intensityLabel(config.solverIntensity)}</dd>
          <dt>Cluster di cambio attivi</dt><dd>${r.clusters.length}</dd>
          <dt>Auto aziendali</dt><dd>${r.companyCars}</dd>
        </dl>
      </div>
      <div class="cfg-block">
        <h3 style="margin-top:0">⚖️ Pesi obiettivo</h3>
        <dl>
          ${renderWeights(config)}
        </dl>
      </div>
    </div>

    ${shiftRules && Object.keys(shiftRules).length > 0 ? `
    <h3>📜 Limiti turni guida (RD 131/1938)</h3>
    <table>
      <thead><tr>
        <th>Tipo</th><th class="num">Nastro max</th><th class="num">Lavoro max</th>
        <th class="num">Interruzione min</th><th class="num">Interruzione max</th>
      </tr></thead>
      <tbody>
        ${["intero", "semiunico", "spezzato", "supplemento"].map(k => {
          const sr = shiftRules[k] ?? {};
          return `<tr>
            <td><strong>${cap(k)}</strong></td>
            <td class="num">${sr.maxNastro != null ? fmtHHmm(sr.maxNastro) : "—"}</td>
            <td class="num">${sr.maxLavoro != null ? fmtHHmm(sr.maxLavoro) : "—"}</td>
            <td class="num">${sr.intMin != null ? fmtHHmm(sr.intMin) : "—"}</td>
            <td class="num">${sr.intMax != null && sr.intMax < 999 ? fmtHHmm(sr.intMax) : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>` : ""}

    ${renderBdsBlock(bds)}
  </section>

  <!-- 4. TURNI MACCHINA -->
  ${vehicleShifts.length > 0 ? `
  <section>
    <h2><span class="num">4</span> Turni Macchina — analisi dettagliata</h2>
    <p>Il <strong>Vehicle Scheduling Problem</strong> ha assegnato le ${vsSummary.totalTrips ?? "—"} corse a
    <strong>${vehicleShifts.length} veicoli</strong>${vsSummary.byType ? ` (${formatVehicleTypes(vsSummary.byType)})` : ""},
    con ${vsSummary.efficiency != null ? `efficienza <strong>${vsSummary.efficiency}%</strong>` : "efficienza calcolata"}.</p>

    <h3>📈 Composizione flotta</h3>
    <table>
      <thead><tr>
        <th>Veicolo</th><th>Tipo</th><th>Categoria</th>
        <th class="num">Corse</th><th class="num">Servizio</th>
        <th class="num">Vuoto</th><th class="num">Km vuoto</th>
        <th class="num">Rientri</th><th>Operativo</th>
      </tr></thead>
      <tbody>
        ${vehicleShifts.slice(0, 25).map(vs => `<tr>
          <td><strong>${escapeHtml(vs.vehicleId)}</strong></td>
          <td><span class="badge info">${escapeHtml(vs.vehicleType ?? "—")}</span></td>
          <td>${escapeHtml(vs.category ?? "—")}</td>
          <td class="num">${vs.tripCount ?? vs.trips?.length ?? "—"}</td>
          <td class="num">${fmtHHmm(vs.totalServiceMin)}</td>
          <td class="num">${fmtHHmm(vs.totalDeadheadMin)}</td>
          <td class="num">${vs.totalDeadheadKm != null ? fmt(vs.totalDeadheadKm, 1) : "—"}</td>
          <td class="num">${vs.depotReturns ?? 0}</td>
          <td>${minToHHmm(vs.startMin)} → ${minToHHmm(vs.endMin)}</td>
        </tr>`).join("")}
        ${vehicleShifts.length > 25 ? `<tr><td colspan="9" style="text-align:center;font-style:italic;color:#9ca3af">… ${vehicleShifts.length - 25} altri veicoli (vedi piattaforma)</td></tr>` : ""}
      </tbody>
    </table>

    ${vsCosts && Object.keys(vsCosts).length > 0 ? `
    <h3>💰 Composizione costi turni macchina</h3>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Costo totale</div>
        <div class="val">${fmtEur(vsCosts.totalDailyCost)}</div>
        <div class="sub">€/giorno</div>
      </div>
      <div class="kpi">
        <div class="label">Costo fisso veicoli</div>
        <div class="val">${fmtEur(vsCosts.fixedCost)}</div>
        <div class="sub">${vehicleShifts.length} mezzi</div>
      </div>
      <div class="kpi">
        <div class="label">Costo km a vuoto</div>
        <div class="val">${fmtEur(vsCosts.deadheadCost)}</div>
        <div class="sub">${fmt(vsSummary.totalDeadheadKm, 0)} km</div>
      </div>
      <div class="kpi">
        <div class="label">Score qualità</div>
        <div class="val">${vsScore.total != null ? fmt(vsScore.total) : "—"}</div>
        <div class="sub">${vsScore.grade ?? ""}</div>
      </div>
    </div>` : ""}

    ${vsOptAnalysis ? `
    <h3>🧠 Multi-scenario CP-SAT (turni macchina)</h3>
    <div class="callout">
      <div class="lbl">★ Strategia vincente</div>
      <strong style="font-size:13px">${escapeHtml(vsOptAnalysis.bestStrategyLabel ?? vsOptAnalysis.bestStrategy ?? "—")}</strong>
      ${vsOptAnalysis.bestStrategyDesc ? `<br><span style="color:#6b7280">${escapeHtml(vsOptAnalysis.bestStrategyDesc)}</span>` : ""}
    </div>
    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Scenari eseguiti</div>
        <div class="val">${vsOptAnalysis.nScenariosRun ?? "—"}/${vsOptAnalysis.nScenariosRequested ?? "—"}</div>
        <div class="sub">${vsOptAnalysis.strategiesExplored ?? 0}/${vsOptAnalysis.totalStrategiesAvailable ?? 0} strategie</div>
      </div>
      <div class="kpi">
        <div class="label">Risparmio vs greedy</div>
        <div class="val">${vsOptAnalysis.savingsEur != null ? fmtEur(vsOptAnalysis.savingsEur) : "—"}</div>
        <div class="sub">${vsOptAnalysis.savingsPct != null ? `${fmt(vsOptAnalysis.savingsPct, 1)}% migliore` : ""}</div>
      </div>
      <div class="kpi">
        <div class="label">Polish phase</div>
        <div class="val">${vsOptAnalysis.polishImproved ? "🪄 +" + fmtPct(vsOptAnalysis.polishDeltaPct, 2) : "—"}</div>
        <div class="sub">${vsOptAnalysis.polishElapsedSec ? `${Math.round(vsOptAnalysis.polishElapsedSec)}s` : ""}</div>
      </div>
      <div class="kpi">
        <div class="label">Tempo totale</div>
        <div class="val">${vsOptAnalysis.totalElapsedSec ? `${Math.round(vsOptAnalysis.totalElapsedSec)}s` : "—"}</div>
        <div class="sub">budget ${vsOptAnalysis.timeBudgetSec ?? "—"}s</div>
      </div>
    </div>` : ""}

    ${vsScenarioRanking.length > 0 ? `
    <h3>📊 Top scenari turni macchina</h3>
    <table>
      <thead><tr>
        <th>#</th><th>Strategia</th><th class="num">Veicoli</th>
        <th class="num">Costo</th><th class="num">Km vuoto</th><th class="num">Tempo</th>
      </tr></thead>
      <tbody>
        ${vsScenarioRanking.slice(0, 10).map((s: any, i: number) => `<tr${s.isBest ? " style='background:#fff7ed'" : ""}>
          <td><strong>${i + 1}</strong> ${s.isBest ? "<span class='badge fire'>★ BEST</span>" : s.isPolish ? "<span class='badge warn'>🪄</span>" : ""}</td>
          <td>${escapeHtml(s.strategyLabel ?? s.strategy ?? "—")}</td>
          <td class="num">${s.vehicles ?? "—"}</td>
          <td class="num">${s.costEur != null ? fmtEur(s.costEur) : "—"}</td>
          <td class="num">${s.deadheadKm != null ? `${fmt(s.deadheadKm, 0)} km` : "—"}</td>
          <td class="num">${s.elapsedSec != null ? `${fmt(s.elapsedSec, 1)}s` : "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : ""}

    ${vsAdvisories.length > 0 ? `
    <h3>💡 Advisor — suggerimenti operativi</h3>
    ${vsAdvisories.slice(0, 5).map(a => `
      <div class="callout" style="background:${a.severity === "critical" ? "#fee2e2" : a.severity === "warning" ? "#fef3c7" : "#dbeafe"};border-left-color:${a.severity === "critical" ? "#dc2626" : a.severity === "warning" ? "#f59e0b" : "#3b82f6"}">
        <div class="lbl" style="color:${a.severity === "critical" ? "#991b1b" : a.severity === "warning" ? "#92400e" : "#1e40af"}">
          ${a.severity?.toUpperCase()} · ${escapeHtml(a.category ?? "")}
        </div>
        <strong>${escapeHtml(a.title)}</strong>
        ${a.description ? `<br><span style="font-size:10px">${escapeHtml(a.description)}</span>` : ""}
        ${a.impact ? `<br><span style="font-size:10px;color:#059669"><strong>${escapeHtml(a.impact)}</strong></span>` : ""}
      </div>
    `).join("")}` : ""}
  </section>` : ""}

  <!-- 5. INTERMODALITÀ -->
  <section>
    <h2><span class="num">5</span> Intermodalità — Turni Macchina ↔ Turni Guida</h2>
    <p>Indicatori di accoppiamento tra le due ottimizzazioni: come si distribuiscono gli autisti
    sui veicoli e viceversa.</p>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Veicoli serviti</div>
        <div class="val">${intermodal.nVehicles}</div>
        <div class="sub">da ${intermodal.nDrivers} autisti</div>
      </div>
      <div class="kpi">
        <div class="label">Autisti / veicolo</div>
        <div class="val">${fmt(intermodal.driversPerVehAvg, 2)}</div>
        <div class="sub">media (max 1 = nessun cambio)</div>
      </div>
      <div class="kpi">
        <div class="label">Veicoli / autista</div>
        <div class="val">${fmt(intermodal.vehPerDriverAvg, 2)}</div>
        <div class="sub">multi-veicolo: ${intermodal.multiVehicleDrivers}</div>
      </div>
      <div class="kpi">
        <div class="label">Cambi totali</div>
        <div class="val">${summary.totalCambi}</div>
        <div class="sub">${intermodal.totalHandovers} con auto aziendale</div>
      </div>
      <div class="kpi">
        <div class="label">Cambi inter-corsa</div>
        <div class="val">${intermodal.interTripCambi}</div>
        <div class="sub">al capolinea (preferenza)</div>
      </div>
      <div class="kpi">
        <div class="label">Cambi intra-corsa</div>
        <div class="val">${intermodal.intraTripCambi}</div>
        <div class="sub">in fermata intermedia</div>
      </div>
      <div class="kpi">
        <div class="label">Auto aziendali</div>
        <div class="val">${summary.companyCarsUsed}/${r.companyCars}</div>
        <div class="sub">trasf. deposito ↔ cluster</div>
      </div>
      <div class="kpi">
        <div class="label">Cluster di cambio</div>
        <div class="val">${r.clusters.length}</div>
        <div class="sub">attivi nello scenario</div>
      </div>
    </div>

    ${r.clusters.length > 0 ? `
    <h3>🔄 Cluster di cambio attivi</h3>
    <table>
      <thead><tr><th>Cluster</th><th class="num">Trasf. deposito (min)</th></tr></thead>
      <tbody>
        ${r.clusters.map(c => `<tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td class="num">${c.transferMin} min</td>
        </tr>`).join("")}
      </tbody>
    </table>` : ""}

    ${intermodal.multiVehicleDrivers > 0 ? `
    <div class="callout">
      <div class="lbl">📌 Insight intermodale</div>
      <strong>${intermodal.multiVehicleDrivers}</strong> autisti operano su più di un veicolo durante il turno
      (cambio bus mediante auto aziendale o handover al capolinea).
      <strong>${intermodal.multiDriverVehicles}</strong> veicoli vengono guidati da più autisti nella giornata.
      Questo riduce il numero di mezzi necessari ma richiede coordinamento operativo nei punti di cambio.
    </div>` : ""}
  </section>

  <!-- 6. ANALISI ALGORITMO -->
  ${oa ? `
  <section>
    <h2><span class="num">6</span> Come ha ragionato l'algoritmo (turni guida)</h2>
    <div class="callout">
      <div class="lbl">★ Strategia vincente</div>
      <strong style="font-size:13px">${escapeHtml(oa.bestStrategyLabel ?? oa.bestStrategy)}</strong>
      ${oa.bestStrategyDesc ? `<br><span style="color:#6b7280">${escapeHtml(oa.bestStrategyDesc)}</span>` : ""}
    </div>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="label">Scenari eseguiti</div>
        <div class="val">${oa.nScenariosRun}/${oa.nScenariosRequested}</div>
        <div class="sub">${oa.nFeasible} fattibili · ${oa.nInfeasible} no</div>
      </div>
      <div class="kpi">
        <div class="label">Strategie esplorate</div>
        <div class="val">${oa.strategiesExplored}/${oa.totalStrategiesAvailable}</div>
        <div class="sub">portfolio diversificato</div>
      </div>
      <div class="kpi">
        <div class="label">Spread costi</div>
        <div class="val">${fmtPct(oa.scoreSpreadPct)}</div>
        <div class="sub">tra miglior/peggior scenario</div>
      </div>
      <div class="kpi">
        <div class="label">Tempo totale</div>
        <div class="val">${Math.round(oa.totalElapsedSec)}s</div>
        <div class="sub">budget ${oa.timeBudgetSec}s</div>
      </div>
    </div>

    ${oa.polishImproved ? `
    <div class="callout" style="background:#fef3c7;border-left-color:#eab308">
      <div class="lbl">🪄 Polish phase ha migliorato la soluzione</div>
      Guadagno: <strong>${fmtPct(oa.polishDeltaPct, 2)}</strong>
      (${fmt(Math.abs(oa.polishDeltaScore))} punti score)
      in ${Math.round(oa.polishElapsedSec)}s addizionali.
    </div>` : ""}

    <h3>📊 Performance per strategia</h3>
    <table>
      <thead><tr>
        <th>Strategia</th><th class="num">Run</th><th class="num">Miglior costo</th>
        <th class="num">Turni</th><th>Esito</th>
      </tr></thead>
      <tbody>
        ${(oa.strategySummary ?? []).map(s => `<tr>
          <td><strong>${escapeHtml(s.label)}</strong>
            ${s.desc ? `<br><span style="font-size:9px;color:#9ca3af">${escapeHtml(s.desc)}</span>` : ""}</td>
          <td class="num">${s.nRuns}</td>
          <td class="num">${s.bestCost != null ? fmtEur(s.bestCost) : fmt(s.bestScore)}</td>
          <td class="num">${s.bestDuties ?? "—"}</td>
          <td>${s.isWinner ? "<span class='badge fire'>★ VINCITORE</span>" : "<span class='badge info'>esplorato</span>"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <!-- 7. CLASSIFICA SCENARI -->
  ${scenarios.length > 0 ? `
  <section>
    <h2><span class="num">7</span> Classifica completa scenari (turni guida)</h2>
    <p>Top ${Math.min(15, scenarios.length)} scenari ordinati per score
    (su ${scenarios.length} eseguiti).</p>
    <table>
      <thead><tr>
        <th>#</th><th>Strategia</th><th class="num">Turni</th>
        <th class="num">Costo</th><th class="num">Lav. tot.</th>
        <th class="num">BDS viol.</th><th class="num">Score</th>
        <th class="num">Tempo</th>
      </tr></thead>
      <tbody>
        ${scenarios.slice(0, 15).map((s, i) => {
          const winner = s.isBest ? "<span class='badge fire'>★ BEST</span>" :
                         s.isPolish ? "<span class='badge warn'>🪄 polish</span>" : "";
          return `<tr${s.isBest ? " style='background:#fff7ed'" : ""}>
            <td><strong>${i + 1}</strong> ${winner}</td>
            <td>${escapeHtml(s.params?.strategyLabel ?? s.params?.strategy ?? "balanced")}</td>
            <td class="num">${s.duties ?? "—"}</td>
            <td class="num">${s.totalCost != null ? fmtEur(s.totalCost) : "—"}</td>
            <td class="num">${s.totalWorkH != null ? `${fmt(s.totalWorkH, 1)}h` : "—"}</td>
            <td class="num">${(s.bdsViolations ?? 0) === 0 ?
              "<span class='badge ok'>0</span>" :
              `<span class='badge err'>${s.bdsViolations}</span>`}</td>
            <td class="num">${fmt(s.score)}</td>
            <td class="num">${s.elapsed.toFixed(1)}s</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <!-- 8. DISTRIBUZIONE -->
  <section>
    <h2><span class="num">8</span> Distribuzione turni e carico lavoro</h2>
    <div class="cfg-grid">
      <div>
        <h3 style="margin-top:0">Tipologia turni</h3>
        <table>
          <thead><tr><th>Tipo</th><th class="num">Numero</th><th class="num">Quota</th><th>Limite</th></tr></thead>
          <tbody>
            ${(["intero", "semiunico", "spezzato", "supplemento"] as const).map(t => {
              const n = summary.byType[t] ?? 0;
              const pct = totalDuties > 0 ? (n / totalDuties * 100) : 0;
              const lim = t === "semiunico" ? "≤ 12%" : t === "spezzato" ? "≤ 13%" : "—";
              return `<tr>
                <td><strong>${cap(t)}</strong></td>
                <td class="num">${n}</td>
                <td class="num">${fmtPct(pct)}</td>
                <td>${lim}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div>
        <h3 style="margin-top:0">Carico lavoro autisti</h3>
        <table>
          <tbody>
            <tr><td><strong>Lavoro medio</strong></td><td class="num">${fmtHHmm(avgWork)}</td></tr>
            <tr><td><strong>Lavoro minimo</strong></td><td class="num">${fmtHHmm(minWork)}</td></tr>
            <tr><td><strong>Lavoro massimo</strong></td><td class="num">${fmtHHmm(maxWork)}</td></tr>
            <tr><td><strong>Spread</strong></td><td class="num">${fmtHHmm(maxWork - minWork)}</td></tr>
            <tr><td><strong>Auto aziendali usate</strong></td><td class="num">${summary.companyCarsUsed}/${r.companyCars}</td></tr>
            <tr><td><strong>Cambi in linea totali</strong></td><td class="num">${summary.totalCambi}</td></tr>
            ${r.unassignedBlocks > 0 ?
              `<tr><td><strong style="color:#dc2626">Blocchi non assegnati</strong></td>
              <td class="num"><span class="badge err">${r.unassignedBlocks}</span></td></tr>` : ""}
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- 9. CONFORMITÀ BDS -->
  ${withBds.length > 0 ? `
  <section>
    <h2><span class="num">9</span> Verifica normativa BDS</h2>
    <p>Conformità per ognuno dei 5 controlli normativi (RD 131/1938 + CE 561/2006).</p>
    <table>
      <thead><tr>
        <th>Controllo</th><th class="num">Conformi</th><th class="num">Totale</th>
        <th class="num">%</th><th>Esito</th>
      </tr></thead>
      <tbody>
        ${(["cee561", "intervalloPasto", "staccoMinimo", "nastro", "riprese"] as const).map(k => {
          const ok = withBds.filter(s => s.bdsValidation![k] === true).length;
          const pct = Math.round(ok / withBds.length * 100);
          const labels: Record<string, string> = {
            cee561: "CE 561/2006 (guida continuativa)",
            intervalloPasto: "Intervallo pasto",
            staccoMinimo: "Stacco minimo tra turni",
            nastro: "Nastro entro limite",
            riprese: "Numero riprese",
          };
          return `<tr>
            <td><strong>${labels[k]}</strong></td>
            <td class="num">${ok}</td>
            <td class="num">${withBds.length}</td>
            <td class="num">${pct}%</td>
            <td>${pct >= 95 ? "<span class='badge ok'>OK</span>" :
                  pct >= 80 ? "<span class='badge warn'>attenzione</span>" :
                  "<span class='badge err'>critico</span>"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </section>` : ""}

  <!-- 10. LISTA TURNI -->
  <section>
    <h2><span class="num">10</span> Dettaglio turni guida (${r.driverShifts.length})</h2>
    <table>
      <thead><tr>
        <th>Autista</th><th>Tipo</th><th>Inizio</th><th>Fine</th>
        <th class="num">Nastro</th><th class="num">Lavoro</th>
        <th class="num">Cambi</th><th class="num">Costo</th><th>BDS</th>
      </tr></thead>
      <tbody>
        ${r.driverShifts.map(s => `<tr>
          <td><strong>${escapeHtml(s.driverId)}</strong></td>
          <td><span class="badge info">${cap(s.type)}</span></td>
          <td>${escapeHtml((s.nastroStart ?? "").slice(0, 5))}</td>
          <td>${escapeHtml((s.nastroEnd ?? "").slice(0, 5))}</td>
          <td class="num">${fmtHHmm(s.nastroMin)}</td>
          <td class="num">${fmtHHmm(s.workMin)}</td>
          <td class="num">${s.cambiCount}</td>
          <td class="num">${s.costEuro != null ? fmtEur(s.costEuro) : "—"}</td>
          <td>${!s.bdsValidation ? "—" :
              s.bdsValidation.valid ?
                "<span class='badge ok'>✓</span>" :
                `<span class='badge err'>${s.bdsValidation.violations.length} viol.</span>`}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </section>

  <!-- FOOTER -->
  <div class="footer">
    Documento generato da <strong>TransitIntel — Scheduling Engine</strong> · ${today}<br>
    Conerobus S.p.A. · Solver: Google OR-Tools CP-SAT · Algoritmi: vehicle_scheduler_cpsat v2 · crew_scheduler_v4
  </div>

</div>

<script>
  // Auto-print on load (with small delay to ensure rendering)
  window.addEventListener("load", function() {
    setTimeout(function() { window.print(); }, 400);
  });
</script>
</body>
</html>`;
}

/* ─── helpers HTML ─── */
function escapeHtml(s: string | undefined | null): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function minToHHmm(mins?: number): string {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function formatVehicleTypes(byType: Record<string, number>): string {
  return Object.entries(byType)
    .filter(([_, n]) => n && n > 0)
    .map(([t, n]) => `${n} ${t}`)
    .join(", ");
}
function renderWeights(config: OperatorConfig): string {
  const w = (config as any).weights ?? {};
  const labels: Record<string, string> = {
    cost: "Costo", balance: "Bilanciamento", supplementi: "Anti-supplementi",
    spezzati: "Anti-spezzati", transfer: "Anti-trasferimenti",
    drivers: "Anti-autisti", quality: "Qualità",
  };
  const entries = Object.entries(labels)
    .filter(([k]) => w[k] != null)
    .map(([k, v]) => `<dt>${v}</dt><dd>${w[k]}</dd>`)
    .join("");
  return entries || "<dt>Pesi</dt><dd>default</dd>";
}
function renderBdsBlock(bds: any): string {
  if (!bds || Object.keys(bds).length === 0) return "";
  const sections: string[] = [];
  if (bds.rd131) {
    sections.push(`<tr>
      <td><strong>RD 131/1938</strong></td>
      <td>${bds.rd131.attivo ? "<span class='badge ok'>attivo</span>" : "<span class='badge warn'>off</span>"}</td>
      <td>guida cont. max ${fmtHHmm(bds.rd131.maxGuidaContinuativa)} · sosta ${bds.rd131.sostaMinima}min</td>
    </tr>`);
  }
  if (bds.pasto) {
    sections.push(`<tr>
      <td><strong>Intervallo pasto</strong></td>
      <td>${bds.pasto.attivo ? "<span class='badge ok'>attivo</span>" : "<span class='badge warn'>off</span>"}</td>
      <td>sosta min ${bds.pasto.pranzoSostaMinima}min</td>
    </tr>`);
  }
  if (bds.cee561) {
    sections.push(`<tr>
      <td><strong>CE 561/2006</strong></td>
      <td>${bds.cee561.attivo ? "<span class='badge ok'>attivo</span>" : "<span class='badge warn'>off</span>"}</td>
      <td>—</td>
    </tr>`);
  }
  if (sections.length === 0) return "";
  return `<h3>⚖️ Normativa BDS</h3>
    <table><tbody>${sections.join("")}</tbody></table>`;
}

/* ─── Componente Pulsante ─── */
export interface ExportReportButtonProps {
  result: DriverShiftsResult | null;
  config: OperatorConfig;
  solverMode: "greedy" | "cpsat";
  scenarioName?: string;
  date?: string;
  /** Vehicle scheduling row from `/api/service-program/scenarios/:id` (with `result.shifts`, `result.summary`, …). */
  vehicleScenario?: any;
  className?: string;
}

export function ExportReportButton({
  result, config, solverMode, scenarioName, date, vehicleScenario, className,
}: ExportReportButtonProps) {
  const handleExport = () => {
    if (!result) {
      alert("⚠️ Nessun risultato da esportare. Genera prima i turni guida.");
      return;
    }
    const html = buildReportHTML({ result, config, solverMode, scenarioName, date, vehicleScenario });
    const win = window.open("", "_blank", "width=1024,height=820");
    if (!win) {
      alert("❌ Popup bloccato dal browser. Abilita i popup e riprova.");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  return (
    <button
      onClick={handleExport}
      disabled={!result}
      className={
        className ??
        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gradient-to-r from-orange-600 to-red-600 text-white hover:from-orange-700 hover:to-red-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      }
      title="Esporta report PDF dell'analisi completa (turni macchina + turni guida + intermodalità)"
    >
      <FileDown className="w-3.5 h-3.5" /> Esporta Report
    </button>
  );
}

export default ExportReportButton;
