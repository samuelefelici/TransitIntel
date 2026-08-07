/**
 * INTERMODALE — export dei dati.
 *
 * Fino a ora la sezione non permetteva di portare fuori nulla: né una
 * tabella per lavorarci, né un documento da consegnare. Qui i due formati
 * che servono a un pianificatore, riusando i pattern già in casa:
 *   • CSV (separatore ";", convenzione IT) per fogli di calcolo;
 *   • report HTML stampabile in PDF (finestra separata + window.print),
 *     come planning-studio/zonizzazione-export.ts.
 * Nessun ricalcolo: si formatta ciò che /demand-coverage ha già prodotto.
 */
import type { DemandCoverageResult, GeneratorKind } from "./DemandCoverage";
import type { AnalysisResult } from "./types";

const KIND_IT: Record<GeneratorKind, string> = {
  stazione: "Stazione", aeroporto: "Aeroporto", scuola: "Scuola",
  lavoro: "Area di lavoro", ospedale: "Sanità",
};
const STATUS_IT: Record<string, string> = {
  "servito": "Servito", "parziale": "Parziale", "non-servito": "Non servito",
};

/* ── CSV: quoting corretto (niente replace ingenui che si rompono su ; e a-capo) ── */
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows: (string | number | null)[][]): string {
  // BOM per farlo aprire bene a Excel in italiano
  return "﻿" + rows.map(r => r.map(csvCell).join(";")).join("\r\n");
}
function download(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** CSV: un polo per riga, con la fermata più vicina e i numeri d'orario. */
export function exportCoverageCsv(data: DemandCoverageResult): void {
  const rows: (string | number | null)[][] = [[
    "Polo", "Famiglia", "Dettaglio", "Stato", "Motivo",
    "Fermate vicine", "Fermata più vicina", "Cammino min",
    "Corse", "Servizio dalle", "alle", "Intervallo tipico min", "Buco max h", "Buco dalle",
    "Linee", "Lat", "Lon",
  ]];
  for (const g of data.generators) {
    const near = g.nearStops[0];
    const sc = g.schedule;
    rows.push([
      g.generator.name, KIND_IT[g.generator.kind] ?? g.generator.kind,
      g.generator.detail ?? "", STATUS_IT[g.status] ?? g.status, g.reason,
      g.nearStops.length, near?.stopName ?? "", near?.walkMin ?? "",
      sc?.trips ?? 0, sc?.firstTime ?? "", sc?.lastTime ?? "",
      sc?.medianHeadwayMin ?? "", sc?.maxGapMin != null ? Math.round(sc.maxGapMin / 6) / 10 : "", sc?.maxGapFrom ?? "",
      g.routes.join(" "), g.generator.lat, g.generator.lng,
    ]);
  }
  download(toCsv(rows), `intermodale_copertura_${stamp()}.csv`, "text/csv;charset=utf-8");
}

/** CSV: l'orario per linea (arco, corse, intervallo, buco). */
export function exportSchedulesCsv(data: DemandCoverageResult): void {
  const rows: (string | number | null)[][] = [[
    "Linea", "Corse", "Prima", "Ultima", "Ore coperte", "Intervallo tipico min", "Buco max h", "Buco dalle",
  ]];
  for (const s of data.schedules ?? []) {
    rows.push([
      s.route, s.trips, s.firstTime ?? "", s.lastTime ?? "", s.hoursCovered,
      s.medianHeadwayMin ?? "", s.maxGapMin != null ? Math.round(s.maxGapMin / 6) / 10 : "", s.maxGapFrom ?? "",
    ]);
  }
  download(toCsv(rows), `intermodale_orari_linea_${stamp()}.csv`, "text/csv;charset=utf-8");
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** Report HTML stampabile: verdetto, criticità, tabella poli, orario per linea. */
export function openCoverageReport(data: DemandCoverageResult, projectName?: string): void {
  const s = data.summary, r = data.rete;
  const pct = s.totale > 0 ? Math.round(s.servito / s.totale * 100) : 0;
  const bigGap = (r?.maxGapMin ?? 0) >= 120;
  const livello = pct >= 75 && !bigGap ? "Rete adeguata" : pct >= 45 ? "Rete da rinforzare" : "Copertura insufficiente";
  const col = pct >= 75 && !bigGap ? "#059669" : pct >= 45 ? "#d97706" : "#dc2626";

  const critRows = (data.criticita ?? []).map(c => `
    <tr><td><b>${esc(c.polo)}</b></td><td>${esc(KIND_IT[c.famiglia] ?? c.famiglia)}</td>
    <td class="st">${esc(STATUS_IT[c.stato] ?? c.stato)}</td><td>${esc(c.azione)}</td></tr>`).join("");

  const poliRows = data.generators.map(g => {
    const sc = g.schedule;
    return `<tr>
      <td><b>${esc(g.generator.name)}</b></td>
      <td>${esc(KIND_IT[g.generator.kind] ?? g.generator.kind)}</td>
      <td class="st st-${g.status}">${esc(STATUS_IT[g.status] ?? g.status)}</td>
      <td class="n">${g.nearStops[0]?.walkMin ?? "—"}′</td>
      <td class="n">${sc?.trips ?? 0}</td>
      <td class="n">${sc?.firstTime ?? "—"}–${sc?.lastTime ?? "—"}</td>
      <td class="n">${sc?.medianHeadwayMin != null ? sc.medianHeadwayMin + "′" : "—"}</td>
      <td>${esc(g.routes.join(", "))}</td>
    </tr>`;
  }).join("");

  const schedRows = (data.schedules ?? []).map(sc => `<tr>
    <td><b>${esc(sc.route)}</b></td><td class="n">${sc.trips}</td>
    <td class="n">${sc.firstTime ?? "—"}–${sc.lastTime ?? "—"}</td>
    <td class="n">${sc.medianHeadwayMin != null ? sc.medianHeadwayMin + "′" : "—"}</td>
    <td class="n">${sc.maxGapMin != null ? (Math.round(sc.maxGapMin / 6) / 10) + " h" : "—"}${sc.maxGapFrom ? " dalle " + sc.maxGapFrom : ""}</td>
  </tr>`).join("");

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Intermodale — Copertura della domanda</title><style>
  * { box-sizing: border-box; } body { font-family: -apple-system, system-ui, sans-serif; color: #1e293b; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .sub { color: #64748b; font-size: 12px; margin-bottom: 20px; }
  .verdict { border-left: 4px solid ${col}; background: #f8fafc; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; }
  .verdict .lv { font-size: 16px; font-weight: 700; color: ${col}; }
  .verdict p { margin: 4px 0 0; font-size: 13px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #475569; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; color: #64748b; font-weight: 600; border-bottom: 1px solid #cbd5e1; padding: 4px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .st { font-weight: 600; } .st-servito { color: #059669; } .st-parziale { color: #d97706; } .st-non-servito { color: #dc2626; }
  .btn { position: fixed; top: 16px; right: 16px; padding: 8px 14px; background: #0f172a; color: #fff; border: 0; border-radius: 6px; font-size: 13px; cursor: pointer; }
  @media print { .btn { display: none; } body { padding: 0; } @page { size: A4 portrait; margin: 16mm; } }
  </style></head><body>
  <button class="btn" onclick="window.print()">🖨️ Stampa / Salva PDF</button>
  <h1>Copertura della domanda — Intermodale</h1>
  <div class="sub">${esc(projectName ? projectName + " · " : "")}Periodo: ${esc(data.scope.day)} · ${s.lineeValutate} linee valutate · generato il ${new Date().toLocaleDateString("it-IT")}</div>
  <div class="verdict">
    <div class="lv">${livello} — ${pct}% dei poli serviti</div>
    <p>${s.servito} serviti, ${s.parziale} parziali, ${s.nonServito} scoperti su ${s.totale} poli${r && r.medianHeadwayMin != null ? ` · un bus ogni ~${r.medianHeadwayMin}′` : ""}${bigGap ? ` · buco fino a ${Math.round(r!.maxGapMin! / 6) / 10} h dalle ${r!.maxGapFrom}` : ""}.</p>
  </div>
  ${critRows ? `<h2>Dove intervenire (${data.criticita!.length})</h2>
  <table><thead><tr><th>Polo</th><th>Famiglia</th><th>Stato</th><th>Azione consigliata</th></tr></thead><tbody>${critRows}</tbody></table>` : ""}
  <h2>Poli attrattori (${data.generators.length})</h2>
  <table><thead><tr><th>Polo</th><th>Famiglia</th><th>Stato</th><th class="n">Cammino</th><th class="n">Corse</th><th class="n">Servizio</th><th class="n">Intervallo</th><th>Linee</th></tr></thead><tbody>${poliRows}</tbody></table>
  ${schedRows ? `<h2>Orario per linea (${data.schedules!.length})</h2>
  <table><thead><tr><th>Linea</th><th class="n">Corse</th><th class="n">Servizio</th><th class="n">Intervallo</th><th class="n">Buco max</th></tr></thead><tbody>${schedRows}</tbody></table>` : ""}
  </body></html>`;

  const win = window.open("", "_blank");
  if (!win) { alert("Consenti i popup per aprire il report."); return; }
  win.document.write(html);
  win.document.close();
}

/* ═══════════════════════════════════════════════════════════════════════
 *  REPORT COMPLETO — un documento unico con grafici e tutti i dettagli:
 *  quadro, timeline domanda↔offerta (grafico stampabile), criticità,
 *  poli, orario per linea e coincidenze treno↔corsa per stazione.
 * ═══════════════════════════════════════════════════════════════════════ */
export function openFullReport(
  data: DemandCoverageResult,
  analysis: AnalysisResult | null,
  opts?: { projectName?: string; periodoLabel?: string; ambitoLabel?: string },
): void {
  const s = data.summary, r = data.rete;
  const pct = s.totale > 0 ? Math.round(s.servito / s.totale * 100) : 0;
  const col = pct >= 75 ? "#059669" : pct >= 45 ? "#d97706" : "#dc2626";

  /* ── Grafico timeline: domanda impilata sopra, corse sotto ── */
  const tl = data.timeline;
  let timelineHtml = "";
  if (tl && tl.demandHourly.some(n => n > 0)) {
    const maxD = Math.max(...tl.demandHourly, 1);
    const maxS = Math.max(...tl.serviceHourly, 1);
    const KC: Record<string, string> = { treni: "#0891b2", scuola: "#d97706", ospedale: "#dc2626", lavoro: "#059669" };
    const cols = Array.from({ length: 24 }, (_, h) => {
      const critical = tl.oreCritiche.some(c => c.hour === h);
      const segs = (["treni", "scuola", "ospedale", "lavoro"] as const)
        .map(k => ({ k, v: tl.perKind[k]?.[h] ?? 0 })).filter(p => p.v > 0)
        .map(p => `<div style="height:${Math.max(2, (p.v / maxD) * 58)}px;background:${KC[p.k]}"></div>`)
        .join("");
      const sv = tl.serviceHourly[h] ?? 0;
      return `<div class="tlcol${critical ? " crit" : ""}" title="${String(h).padStart(2, "0")}:00">
        <div class="tlup">${segs}</div>
        <div class="tldn"><div style="height:${Math.max(sv > 0 ? 6 : 1, (sv / maxS) * 26)}px;background:#94a3b8"></div></div>
      </div>`;
    }).join("");
    timelineHtml = `
    <h2>Domanda ↔ offerta per ora</h2>
    <div class="tl">${cols}</div>
    <div class="tlaxis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
    <div class="tlleg">
      <span><i style="background:#0891b2"></i>treni</span><span><i style="background:#d97706"></i>scuole</span>
      <span><i style="background:#dc2626"></i>sanità</span><span><i style="background:#059669"></i>lavoro</span>
      <span><i style="background:#94a3b8"></i>corse del progetto</span>
      <span><i style="background:#fff;border:1px solid #dc2626"></i>fascia scoperta</span>
    </div>
    ${tl.oreCritiche.length > 0
      ? `<p class="warn">⚠ Domanda senza corse alle ${tl.oreCritiche.map(c => `${String(c.hour).padStart(2, "0")}:00`).join(", ")}.</p>`
      : `<p class="okline">Ogni fascia con domanda ha almeno una corsa.</p>`}`;
  }

  const critRows = (data.criticita ?? []).map(c => `
    <tr><td><b>${esc(c.polo)}</b></td><td>${esc(KIND_IT[c.famiglia] ?? c.famiglia)}</td>
    <td class="st st-${c.stato}">${esc(STATUS_IT[c.stato] ?? c.stato)}</td><td>${esc(c.azione)}</td></tr>`).join("");

  const poliRows = data.generators.map(g => {
    const sc = g.schedule;
    return `<tr>
      <td><b>${esc(g.generator.name)}</b></td>
      <td>${esc(KIND_IT[g.generator.kind] ?? g.generator.kind)}</td>
      <td class="st st-${g.status}">${esc(STATUS_IT[g.status] ?? g.status)}</td>
      <td class="n">${g.nearStops[0]?.walkMin ?? "—"}′</td>
      <td class="n">${sc?.trips ?? 0}</td>
      <td class="n">${sc?.firstTime ?? "—"}–${sc?.lastTime ?? "—"}</td>
      <td>${esc(g.routes.join(", "))}</td>
    </tr>`;
  }).join("");

  const schedRows = (data.schedules ?? []).map(sc => `<tr>
    <td><b>${esc(sc.route)}</b></td><td class="n">${sc.trips}</td>
    <td class="n">${sc.firstTime ?? "—"}–${sc.lastTime ?? "—"}</td>
    <td class="n">${sc.medianHeadwayMin != null ? sc.medianHeadwayMin + "′" : "—"}</td>
    <td class="n">${sc.maxGapMin != null ? (Math.round(sc.maxGapMin / 6) / 10) + " h" : "—"}${sc.maxGapFrom ? " dalle " + sc.maxGapFrom : ""}</td>
  </tr>`).join("");

  /* ── Coincidenze treno↔corsa per stazione, nei due versi ── */
  const ARR_ESITO: Record<string, [string, string]> = {
    "ok": ["OK", "st-servito"], "long-wait": ["Attesa lunga", "st-parziale"],
    "just-missed": ["Perso", "st-non-servito"], "no-bus": ["Scoperto", "st-non-servito"],
  };
  let coincHtml = "";
  if (analysis) {
    for (const h of analysis.hubs) {
      const arr = h.arrivalConnections ?? [];
      const dep = h.departureConnections ?? [];
      if (arr.length === 0 && dep.length === 0) continue;
      const arrRows = [...arr].sort((a, b) => a.arrivalTime.localeCompare(b.arrivalTime)).map(ac => {
        const [lab, cls] = ARR_ESITO[ac.status] ?? ["—", ""];
        return `<tr><td class="n">${esc(ac.arrivalTime)}</td><td>${esc(ac.origin)}</td>
        <td>${ac.firstBus ? `[${esc(ac.firstBus.routeShortName)}] ${esc(ac.firstBus.departureTime)}` : "—"}</td>
        <td class="n">${ac.firstBus ? ac.firstBus.waitMin + "′" : "—"}</td>
        <td class="st ${cls}">${lab}</td></tr>`;
      }).join("");
      const depRows = [...dep].sort((a, b) => a.departureTime.localeCompare(b.departureTime)).map(dc => {
        const [lab, cls] = dc.bestBusArrival
          ? ((dc.waitMinutes ?? 99) < 10 ? ["Stretto", "st-parziale"] : ["OK", "st-servito"])
          : dc.missedBy != null ? ["Perso", "st-non-servito"] : ["Scoperto", "st-non-servito"];
        return `<tr><td class="n">${esc(dc.departureTime)}</td><td>${esc(dc.destination)}</td>
        <td>${dc.bestBusArrival ? `[${esc(dc.bestBusRoute ?? "")}] arr. ${esc(dc.bestBusArrival)}` : "—"}</td>
        <td class="n">${dc.waitMinutes != null ? dc.waitMinutes + "′" : dc.missedBy != null ? "−" + dc.missedBy + "′" : "—"}</td>
        <td class="st ${cls}">${lab}</td></tr>`;
      }).join("");
      coincHtml += `<h3>${esc(h.hub.name)}</h3>`;
      if (arrRows) coincHtml += `<p class="small">Treno in arrivo → tua corsa</p>
        <table><thead><tr><th class="n">Treno</th><th>Da</th><th>Tua corsa</th><th class="n">Attesa</th><th>Esito</th></tr></thead><tbody>${arrRows}</tbody></table>`;
      if (depRows) coincHtml += `<p class="small">Tua corsa → treno in partenza</p>
        <table><thead><tr><th class="n">Treno</th><th>Per</th><th>Tua corsa</th><th class="n">Margine</th><th>Esito</th></tr></thead><tbody>${depRows}</tbody></table>`;
    }
  }

  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Intermodale — Report completo</title><style>
  * { box-sizing: border-box; } body { font-family: -apple-system, system-ui, sans-serif; color: #1e293b; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .sub { color: #64748b; font-size: 12px; margin-bottom: 20px; }
  .verdict { border-left: 4px solid ${col}; background: #f8fafc; padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; }
  .verdict .lv { font-size: 16px; font-weight: 700; color: ${col}; }
  .verdict p { margin: 4px 0 0; font-size: 13px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #475569; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin: 24px 0 8px; }
  h3 { font-size: 12px; margin: 14px 0 2px; }
  .small { font-size: 10px; color: #64748b; margin: 4px 0 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; page-break-inside: auto; }
  th { text-align: left; color: #64748b; font-weight: 600; border-bottom: 1px solid #cbd5e1; padding: 4px 6px; }
  td { padding: 3px 6px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .st { font-weight: 600; } .st-servito { color: #059669; } .st-parziale { color: #d97706; } .st-non-servito { color: #dc2626; }
  .tl { display: flex; gap: 2px; align-items: flex-end; }
  .tlcol { flex: 1; } .tlcol.crit { outline: 1px solid #dc2626; outline-offset: 1px; border-radius: 2px; }
  .tlup { display: flex; flex-direction: column; justify-content: flex-end; height: 60px; }
  .tldn { height: 28px; border-top: 1px solid #cbd5e1; }
  .tlaxis { display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .tlleg { display: flex; gap: 12px; font-size: 10px; color: #475569; margin-top: 6px; flex-wrap: wrap; }
  .tlleg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 3px; vertical-align: -1px; }
  .warn { font-size: 11px; color: #dc2626; } .okline { font-size: 11px; color: #059669; }
  .btn { position: fixed; top: 16px; right: 16px; padding: 8px 14px; background: #0f172a; color: #fff; border: 0; border-radius: 6px; font-size: 13px; cursor: pointer; }
  @media print { .btn { display: none; } body { padding: 0; } @page { size: A4 portrait; margin: 14mm; } }
  </style></head><body>
  <button class="btn" onclick="window.print()">🖨️ Stampa / Salva PDF</button>
  <h1>Report intermodale completo</h1>
  <div class="sub">${esc(opts?.projectName ? opts.projectName + " · " : "")}${esc(opts?.periodoLabel ?? data.scope.day)}${opts?.ambitoLabel ? " · " + esc(opts.ambitoLabel) : ""} · ${s.lineeValutate} linee valutate · generato il ${new Date().toLocaleDateString("it-IT")} · dati ${data.scope.source === "gtfs" ? "da feed GTFS" : "della rete di progetto (live)"}</div>
  <div class="verdict">
    <div class="lv">${pct}% dei poli serviti</div>
    <p>${s.servito} serviti, ${s.parziale} parziali, ${s.nonServito} scoperti su ${s.totale} poli${r ? ` · ${r.trips} corse ${r.firstTime ?? ""}–${r.lastTime ?? ""}` : ""}${r && r.medianHeadwayMin != null ? ` · un bus ogni ~${r.medianHeadwayMin}′` : ""}${analysis ? ` · coincidenze in arrivo coperte: ${analysis.summary.arrivalCoveragePercent}%` : ""}.</p>
  </div>
  ${timelineHtml}
  ${critRows ? `<h2>Dove intervenire (${data.criticita!.length})</h2>
  <table><thead><tr><th>Polo</th><th>Famiglia</th><th>Stato</th><th>Azione consigliata</th></tr></thead><tbody>${critRows}</tbody></table>` : ""}
  ${coincHtml ? `<h2>Coincidenze treno ↔ corsa per stazione</h2>${coincHtml}` : ""}
  ${schedRows ? `<h2>Orario per linea (${data.schedules!.length})</h2>
  <table><thead><tr><th>Linea</th><th class="n">Corse</th><th class="n">Servizio</th><th class="n">Intervallo</th><th class="n">Buco max</th></tr></thead><tbody>${schedRows}</tbody></table>` : ""}
  <h2>Poli attrattori (${data.generators.length})</h2>
  <table><thead><tr><th>Polo</th><th>Famiglia</th><th>Stato</th><th class="n">Cammino</th><th class="n">Passaggi</th><th class="n">Servizio</th><th>Linee</th></tr></thead><tbody>${poliRows}</tbody></table>
  </body></html>`;

  const win = window.open("", "_blank");
  if (!win) { alert("Consenti i popup per aprire il report."); return; }
  win.document.write(html);
  win.document.close();
}
