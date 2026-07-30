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
