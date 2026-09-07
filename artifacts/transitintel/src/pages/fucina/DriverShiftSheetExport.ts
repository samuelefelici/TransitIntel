/**
 * DriverShiftSheetExport — FOGLIO TURNO: una pagina A4 per ogni turno guida,
 * nel formato del foglio aziendale.
 *
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │ A098                                   NASTRO 07:58 – 13:36  │
 *  │ ANCONA  [INTERO] [SABATO]              PRESENTAZIONE 07:58   │
 *  │                                        CORSE 5               │
 *  │ Programma                       in vigore dal 19/09/2026     │
 *  │ Pre_Turno   07:58 Deposito di Ancona            12′  08:10   │
 *  │ Fuorilinea  08:10 Deposito → Piazza Cavour      10′  08:20   │
 *  │ ┃ 46      08:20 Piazza Cavour  ──51′──▶  09:11 Piazza Cavour │
 *  │ ┃ TM 1066   fermata 08:24 · fermata 08:29 · …          [46A] │
 *  │ ─────────────────────── SOSTA 25′ ───────────────────────── │
 *  │ …                                                            │
 *  │ Fuorilinea  13:26 Piazza Cavour → Deposito       10′  13:36  │
 *  │ COMPETENZE  NASTRO 05:38  LAVORO 05:38                       │
 *  │ NOTE  [A] …                                                  │
 *  └──────────────────────────────────────────────────────────────┘
 *
 * I passaggi alle fermate intermedie arrivano dal caricatore opzionale
 * (POST /planning-studio/projects/:id/stop-times/bulk); senza, la scheda
 * mostra solo partenza e arrivo. La finestra si apre SUBITO (i popup
 * bloccati nascono dalle aperture dopo un'attesa) e si riempie a dati pronti.
 */
import type {
  DriverShiftsResult,
  DriverShiftData,
  HandoverInfo,
  Ripresa,
  RipresaTrip,
} from "@/pages/driver-shifts/types";
import { TYPE_LABELS } from "@/pages/driver-shifts/constants";
import { ripresaServiceBounds } from "./DriverShiftsPrintExport";

export interface StopPassage {
  stopName: string;
  /** HH:MM (o HH:MM:SS) */
  time: string;
  timepoint?: number | null;
}

export interface SheetPrintOptions {
  /** nome del programma (riga sotto l'intestazione) */
  scenarioName?: string;
  /** etichetta del giorno-tipo (SABATO, FESTIVO…); senza, dedotta dalla data */
  dayTypeLabel?: string;
  /** «in vigore dal» (default: data di esercizio) */
  validFrom?: string;
  /** deposito da stampare quando il turno non porta la residenza */
  depotName?: string;
  /** passaggi alle fermate intermedie per corsa */
  loadStopTimes?: (tripIds: string[]) => Promise<Record<string, StopPassage[]>>;
  /** sosta al capolinea da cui stampare il separatore SOSTA (default 15′) */
  sostaMin?: number;
}

const esc = (s: string | number | undefined | null) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));

const hhmm = (m: number) => {
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};
const hhmmFromTime = (t: string) => (t ? t.slice(0, 5) : "");
const durHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const itDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || "");
};
const dayTypeFromDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const wd = d.getDay();
  return wd === 0 ? "FESTIVO" : wd === 6 ? "SABATO" : "FERIALE";
};

/* ── Righe del foglio ──────────────────────────────────────── */

type SheetRow =
  | { kind: "trip"; trip: RipresaTrip; marker?: string }
  | { kind: "line"; label: string; startMin: number; from: string; to?: string; minutes: number; endMin: number }
  | { kind: "sosta"; minutes: number; startMin: number }
  | { kind: "interruzione"; startMin: number; endMin: number }
  | { kind: "cambio"; startMin: number; text: string; marker?: string };

interface SheetNote { marker: string; text: string }

function pickHandovers(rip: Ripresa, all: HandoverInfo[], used: Set<HandoverInfo>): HandoverInfo[] {
  const { start, end } = ripresaServiceBounds(rip);
  const vehicles = new Set(rip.vehicleIds ?? []);
  const out: HandoverInfo[] = [];
  for (const h of all) {
    if (used.has(h)) continue;
    const taken = typeof h.takenMin === "number" ? h.takenMin : h.atMin;
    const sameBus = vehicles.size === 0 || vehicles.has(h.vehicleId);
    const atStart = h.role === "incoming" && Math.abs(taken - start) <= 1;
    const atEnd = h.role === "outgoing" && Math.abs(h.atMin - end) <= 1;
    const inside = h.atMin >= start && h.atMin <= end;
    if (sameBus && (atStart || atEnd || inside)) { out.push(h); used.add(h); }
  }
  return out;
}

function buildRows(shift: DriverShiftData, depot: string, sostaMin: number, notes: SheetNote[]): SheetRow[] {
  const rows: SheetRow[] = [];
  const used = new Set<HandoverInfo>();
  const markerFor = (text: string) => {
    const marker = String.fromCharCode(65 + (notes.length % 26));
    notes.push({ marker, text });
    return marker;
  };
  shift.riprese.forEach((rip, idx) => {
    const { start: svcStart, end: svcEnd } = ripresaServiceBounds(rip);
    if (idx > 0) {
      const prev = shift.riprese[idx - 1];
      const prevEnd = ripresaServiceBounds(prev).end + (prev.transferBackMin || 0);
      const thisStart = svcStart - (rip.transferMin || 0) - (rip.preTurnoMin || 0);
      rows.push({ kind: "interruzione", startMin: prevEnd, endMin: thisStart });
    }
    const handovers = pickHandovers(rip, shift.handovers ?? [], used);
    const trips = rip.trips.slice().sort((a, b) => a.departureMin - b.departureMin);
    const dh = (rip.deadheads ?? []).slice().sort((a, b) => a.departureMin - b.departureMin);
    const pullout = dh.find(d => d.kind === "pullout" || d.kind === "depot_out");
    const byCar = (rip.transferMin || 0) > 0;

    // Pre-turno: in deposito (12′, poi l'uscita col bus) o prima dell'auto (5′)
    if (rip.preTurnoMin > 0) {
      const ptStart = svcStart - (rip.transferMin || 0) - rip.preTurnoMin;
      const where = byCar || !pullout ? `Deposito di ${depot}` : (pullout.fromStop || `Deposito di ${depot}`);
      rows.push({ kind: "line", label: "Pre_Turno", startMin: ptStart, from: where, minutes: rip.preTurnoMin, endMin: ptStart + rip.preTurnoMin });
    }
    if (byCar) {
      rows.push({ kind: "line", label: "Trasferimento", startMin: svcStart - rip.transferMin, from: `Deposito di ${depot}`,
        to: rip.transferToStop || rip.transferToCluster || "nodo", minutes: rip.transferMin, endMin: svcStart });
    }
    for (const d of dh) {
      rows.push({ kind: "line", label: "Fuorilinea", startMin: d.departureMin, from: d.fromStop, to: d.toStop,
        minutes: d.minutes || Math.max(0, d.arrivalMin - d.departureMin), endMin: d.arrivalMin });
    }
    for (const h of handovers) {
      const taken = typeof h.takenMin === "number" ? h.takenMin : h.atMin;
      const t = h.role === "outgoing" ? h.atMin : taken;
      // la riga porta già l'orario: il testo senza il prefisso «HH:MM · »
      const text = (h.description || h.label || "").replace(/^\d{1,2}:\d{2}\s*·\s*/, "");
      rows.push({ kind: "cambio", startMin: t, text, marker: markerFor(`${hhmm(t)} · ${text}${h.detail ? ` ${h.detail}` : ""}`) });
    }
    trips.forEach((t, i) => {
      if (i > 0) {
        const gap = t.departureMin - trips[i - 1].arrivalMin;
        if (gap >= sostaMin) rows.push({ kind: "sosta", minutes: gap, startMin: trips[i - 1].arrivalMin });
      }
      rows.push({ kind: "trip", trip: t });
    });
    if ((rip.transferBackMin || 0) > 0) {
      rows.push({ kind: "line", label: "Rientro", startMin: svcEnd, from: rip.lastStop || "nodo", to: `Deposito di ${depot}`,
        minutes: rip.transferBackMin, endMin: svcEnd + rip.transferBackMin });
    }
  });
  const key = (r: SheetRow) => {
    switch (r.kind) {
      case "trip": return [r.trip.departureMin, 2];
      case "sosta": return [r.startMin, 1];
      case "cambio": return [r.startMin, /\blascia\b/i.test(r.text) ? 3 : 0];
      case "interruzione": return [r.startMin, 1];
      default: return [r.startMin, 1];
    }
  };
  return rows.sort((a, b) => { const ka = key(a), kb = key(b); return (ka[0] - kb[0]) || (ka[1] - kb[1]); });
}

/* ── HTML ─────────────────────────────────────────────────── */

/** Etichette brevi dei tipi di mezzo: il conducente deve sapere che cosa
 *  guida, non solo la matricola. Su un percorso da pollicino un 10 metri non
 *  passa, e chi va in servizio non puo' scoprirlo in strada. */
const VEHICLE_SHORT: Record<string, string> = {
  autosnodato: "Snodato",
  filobus: "Filobus",
  "12m": "12 m",
  "10m": "10 m",
  pollicino: "Pollicino",
};

function vehicleLabel(vt?: string | null): string {
  if (!vt) return "";
  return VEHICLE_SHORT[vt] || vt;
}

function tripCardHtml(t: RipresaTrip, stops: StopPassage[] | undefined, marker?: string): string {
  const dur = Math.max(0, t.arrivalMin - t.departureMin);
  const mid = (stops ?? []).slice(1, -1);
  const withTp = mid.filter(s => s.timepoint === 1 || s.timepoint === undefined || s.timepoint === null);
  const shown = (withTp.length ? withTp : mid).filter(s => s.time);
  const stopsHtml = shown.length
    ? `<div class="stops">${shown.map(s => `<span class="st">${esc(s.stopName)} <b>${esc(hhmmFromTime(s.time))}</b></span>`).join("")}</div>`
    : "";
  return `<div class="trip">
    <div class="trip-head">
      <div class="badge-col"><div class="line-badge">${esc(t.routeName || "—")}</div><div class="tm">TM ${esc(t.vehicleId || "—")}${t.vehicleType ? ` · ${esc(vehicleLabel(t.vehicleType))}` : ""}</div></div>
      <div class="dep"><div class="big">${esc(t.departureTime || hhmm(t.departureMin))}</div><div class="stop">${esc(t.firstStopName || "—")}</div></div>
      <div class="arrow"><span class="dot"></span><span class="rule"></span><span class="dur">${dur}′</span><span class="rule"></span><span class="tri"></span></div>
      <div class="arr"><div class="big">${esc(t.arrivalTime || hhmm(t.arrivalMin))}</div><div class="stop">${esc(t.lastStopName || "—")}</div></div>
      <div class="var-col">${t.variantCode ? `<span class="chip">${esc(t.variantCode)}</span>` : ""}${marker ? `<span class="marker">${esc(marker)}</span>` : ""}</div>
    </div>
    ${stopsHtml}
  </div>`;
}

function rowHtml(r: SheetRow, stopsByTrip: Record<string, StopPassage[]>): string {
  switch (r.kind) {
    case "trip":
      return tripCardHtml(r.trip, stopsByTrip[r.trip.tripId], r.marker);
    case "line":
      return `<div class="row"><span class="lbl">${esc(r.label)}</span><span class="t">${hhmm(r.startMin)}</span><span class="txt">${esc(r.from)}${r.to ? ` <span class="arr-sym">→</span> ${esc(r.to)}` : ""}</span><span class="chip">${r.minutes}′</span><span class="t end">${hhmm(r.endMin)}</span></div>`;
    case "sosta":
      return `<div class="sep"><span>SOSTA ${r.minutes}′</span></div>`;
    case "interruzione":
      return `<div class="sep strong"><span>INTERRUZIONE ${hhmm(r.startMin)} – ${hhmm(r.endMin)}</span></div>`;
    case "cambio":
      return `<div class="row cambio"><span class="lbl">Cambio</span><span class="t">${hhmm(r.startMin)}</span><span class="txt">${esc(r.text)}</span>${r.marker ? `<span class="marker">${esc(r.marker)}</span>` : ""}</div>`;
  }
}

function sheetHtml(shift: DriverShiftData, result: DriverShiftsResult, opts: SheetPrintOptions, stopsByTrip: Record<string, StopPassage[]>): string {
  const depot = (shift.residenzaName || opts.depotName || "").trim() || "—";
  const dayType = (opts.dayTypeLabel || dayTypeFromDate(result.date) || "").toUpperCase();
  const notes: SheetNote[] = [];
  const rows = buildRows(shift, depot, opts.sostaMin ?? 15, notes);
  const nTrips = shift.riprese.reduce((n, r) => n + (r.trips?.length ?? 0), 0);
  for (const v of shift.bdsValidation?.violations ?? []) notes.push({ marker: "!", text: v });
  const program = (opts.scenarioName || result.scenarioName || "").trim();
  const validFrom = opts.validFrom || itDate(result.date);
  return `<section class="sheet">
    <header class="head">
      <div class="left">
        <h1>${esc(shift.driverId)}</h1>
        <div class="sub"><span class="depot">${esc(depot.toUpperCase())}</span><span class="chip outline">${esc(TYPE_LABELS[shift.type] ?? shift.type).toUpperCase()}</span>${dayType ? `<span class="chip green">${esc(dayType)}</span>` : ""}</div>
      </div>
      <div class="right">
        <div><span class="k">NASTRO</span><b>${esc(shift.nastroStart)} – ${esc(shift.nastroEnd)}</b></div>
        <div><span class="k">PRESENTAZIONE</span><b>${esc(shift.nastroStart)}</b></div>
        <div><span class="k">CORSE</span><b>${nTrips}</b></div>
      </div>
    </header>
    <div class="program"><span>${esc(program)}</span><span>in vigore dal <b>${esc(validFrom)}</b></span></div>
    <div class="body">
      ${rows.map(r => rowHtml(r, stopsByTrip)).join("\n")}
    </div>
    <footer>
      <div class="comp"><span class="k">COMPETENZE</span><span class="k">NASTRO</span><b>${durHM(shift.nastroMin)}</b><span class="k">LAVORO</span><b>${durHM(shift.workMin)}</b>${shift.interruptionMin ? `<span class="k">INTERRUZIONE</span><b>${durHM(shift.interruptionMin)}</b>` : ""}</div>
      <div class="notes"><span class="k">NOTE</span>${notes.length ? notes.map(n => `<div class="note"><span class="marker">${esc(n.marker)}</span>${esc(n.text)}</div>`).join("") : `<div class="note muted">—</div>`}</div>
    </footer>
  </section>`;
}

const CSS = `
  @page { size: A4 portrait; margin: 10mm 10mm 12mm 10mm; }
  html, body, * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2937; font-size: 9pt; line-height: 1.3; background: #fff; }
  .toolbar { position: sticky; top: 0; background: #fff; padding: 8px 10px; border-bottom: 1px solid #ddd; display: flex; gap: 8px; justify-content: flex-end; }
  .toolbar button { background: #0f766e; color: #fff; border: none; padding: 6px 14px; font-size: 10pt; border-radius: 4px; cursor: pointer; }
  .toolbar button.secondary { background: #6b7280; }
  section.sheet { page-break-after: always; break-after: page; padding: 4mm 2mm 0 2mm; }
  section.sheet:last-of-type { page-break-after: auto; break-after: auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f766e; padding-bottom: 6px; }
  .head h1 { margin: 0; font-size: 30pt; font-weight: 800; letter-spacing: -0.5px; color: #111827; line-height: 1; }
  .head .sub { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .head .depot { font-weight: 700; color: #475569; font-size: 11pt; }
  .head .right { text-align: right; font-size: 9pt; color: #475569; }
  .head .right div { margin-bottom: 3px; }
  .head .right .k { margin-right: 8px; letter-spacing: 0.5px; font-size: 7.5pt; }
  .head .right b { font-size: 11pt; color: #111827; }
  .chip { display: inline-block; border: 1px solid #cbd5e1; border-radius: 999px; padding: 1px 8px; font-size: 7.5pt; font-weight: 600; color: #475569; background: #f8fafc; white-space: nowrap; }
  .chip.green { background: #dcfce7; border-color: #86efac; color: #166534; }
  .chip.outline { background: #fff; }
  .program { display: flex; justify-content: space-between; color: #64748b; font-size: 8.5pt; padding: 4px 0 6px 0; }
  .row { display: grid; grid-template-columns: 78px 44px 1fr 44px 44px; align-items: center; gap: 8px; padding: 4px 6px; }
  .row .lbl { font-style: italic; font-weight: 700; color: #475569; }
  .row .t { font-weight: 700; }
  .row .t.end { text-align: right; }
  .row .txt { color: #334155; }
  .row .arr-sym { color: #94a3b8; }
  .row .chip { justify-self: end; }
  .row.cambio { grid-template-columns: 78px 44px 1fr auto; background: #fffbeb; border-radius: 4px; }
  .trip { border: 1px solid #94a3b8; border-left: 4px solid #0f766e; border-radius: 6px; padding: 6px 8px; margin: 4px 0; page-break-inside: avoid; break-inside: avoid; }
  .trip-head { display: grid; grid-template-columns: 64px 150px 1fr 150px 56px; align-items: center; gap: 8px; }
  .badge-col { text-align: center; }
  .line-badge { display: inline-block; min-width: 44px; padding: 4px 6px; border: 1px solid #86efac; border-radius: 6px; background: #dcfce7; color: #166534; font-weight: 800; font-size: 14pt; }
  .tm { font-size: 7pt; color: #64748b; margin-top: 2px; font-weight: 600; }
  .dep .big, .arr .big { font-size: 16pt; font-weight: 800; color: #111827; line-height: 1.05; }
  .dep .stop, .arr .stop { font-size: 9pt; font-weight: 600; color: #1f2937; }
  .arr { text-align: right; }
  .arrow { display: flex; align-items: center; gap: 4px; color: #0f766e; }
  .arrow .rule { flex: 1; height: 0; border-top: 1px solid #0f766e; }
  .arrow .dot { width: 6px; height: 6px; border: 1px solid #0f766e; border-radius: 50%; background: #fff; }
  .arrow .tri { width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 6px solid #0f766e; }
  .arrow .dur { font-size: 7.5pt; color: #475569; background: #f1f5f9; border-radius: 999px; padding: 0 6px; }
  .var-col { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .stops { margin-top: 5px; padding-top: 4px; border-top: 1px dashed #e2e8f0; font-size: 7.5pt; color: #475569; display: flex; flex-wrap: wrap; gap: 2px 12px; }
  .stops .st b { color: #111827; }
  .sep { display: flex; align-items: center; gap: 8px; color: #64748b; font-size: 7.5pt; font-weight: 700; letter-spacing: 1px; margin: 4px 0; }
  .sep::before, .sep::after { content: ""; flex: 1; border-top: 1px dashed #cbd5e1; }
  .sep.strong { color: #b45309; }
  .sep.strong::before, .sep.strong::after { border-top: 2px solid #f59e0b; }
  .marker { display: inline-block; min-width: 16px; height: 16px; line-height: 16px; text-align: center; background: #dc2626; color: #fff; border-radius: 4px; font-size: 8pt; font-weight: 800; }
  footer { border-top: 1px solid #94a3b8; margin-top: 8px; padding-top: 6px; font-size: 8pt; }
  footer .k { font-size: 7pt; letter-spacing: 1px; color: #475569; font-weight: 700; margin-right: 6px; }
  footer .comp b { margin-right: 14px; }
  footer .notes { margin-top: 6px; }
  footer .note { display: flex; gap: 8px; align-items: flex-start; margin-top: 3px; }
  footer .note.muted { color: #94a3b8; }
  @media print { .no-print { display: none !important; } }
`;

/** Apre la stampa: una pagina per turno. Ritorna quando la finestra è scritta. */
export async function exportDriverShiftSheetsToPrint(result: DriverShiftsResult, opts: SheetPrintOptions = {}): Promise<void> {
  const w = window.open("", "_blank", "width=1000,height=900");
  if (!w) {
    alert("Il browser ha bloccato la finestra di stampa. Abilita i popup e riprova.");
    return;
  }
  w.document.open();
  w.document.write(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Fogli turno</title></head><body style="font-family:sans-serif;padding:24px;color:#475569">Preparazione dei fogli turno…</body></html>`);
  w.document.close();

  const shifts = result.driverShifts.slice().sort((a, b) => (a.nastroStartMin ?? 0) - (b.nastroStartMin ?? 0) || a.driverId.localeCompare(b.driverId));
  let stopsByTrip: Record<string, StopPassage[]> = {};
  if (opts.loadStopTimes) {
    try {
      const ids = Array.from(new Set(shifts.flatMap(s => s.riprese.flatMap(r => r.trips.map(t => t.tripId))).filter(Boolean)));
      stopsByTrip = await opts.loadStopTimes(ids);
    } catch {
      stopsByTrip = {};
    }
  }
  const title = (opts.scenarioName || result.scenarioName || "Fogli turno").trim();
  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)} · fogli turno</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="toolbar no-print">
    <span style="margin-right:auto;color:#475569;font-size:9pt;align-self:center">${shifts.length} fogli turno · ${esc(title)}</span>
    <button onclick="window.print()">🖨️ Stampa</button>
    <button class="secondary" onclick="window.close()">Chiudi</button>
  </div>
  ${shifts.map(s => sheetHtml(s, result, opts, stopsByTrip)).join("\n")}
  <script>window.addEventListener("load", () => { setTimeout(() => window.print(), 400); });</script>
</body>
</html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Caricatore dei passaggi alle fermate dal Planning Studio (bulk). */
export function stopTimesLoaderFor(apiBase: string, projectId: string) {
  return async (tripIds: string[]): Promise<Record<string, StopPassage[]>> => {
    const out: Record<string, StopPassage[]> = {};
    for (let i = 0; i < tripIds.length; i += 500) {
      const chunk = tripIds.slice(i, i + 500);
      const r = await fetch(`${apiBase}/api/planning-studio/projects/${encodeURIComponent(projectId)}/stop-times/bulk`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripIds: chunk }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const by = (data?.stopTimesByTrip ?? {}) as Record<string, any[]>;
      for (const [tid, list] of Object.entries(by)) {
        out[tid] = (list ?? []).map((st: any) => ({
          stopName: String(st.stopName ?? ""),
          time: String(st.departureTime ?? st.arrivalTime ?? ""),
          timepoint: st.timepoint ?? null,
        }));
      }
    }
    return out;
  };
}
