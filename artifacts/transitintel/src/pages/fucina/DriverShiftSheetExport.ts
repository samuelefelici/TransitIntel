/**
 * DriverShiftSheetExport — FOGLIO TURNO: una pagina A4 per ogni turno guida,
 * con il disegno a schede di Shift Manager (whiteboard, apps/turni-guida).
 *
 *  ┌──────────────────────────────────────────────────────────────┐
 *  │ A108                               NASTRO       14:59 – 21:03 │
 *  │ ANCONA (INTERO) (FESTIVO)          PRESENTAZIONE        14:59 │
 *  │                                    CORSE                   14 │
 *  │                                    VETTURA               10 M │
 *  │━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
 *  │ Programma                           in vigore dal 29/11/2026 │
 *  │   Pre_Turno  14:59 Deposito di Ancona                5'  15:04│
 *  │ ┃ (30)  15:20 ○──── 16' ────▶ 15:36                    [30A] │
 *  │ ┃ TM U012 Ospedale Regionale       Piazza U.Bassi            │
 *  │ ┃ [10 M]  fermata 15:24 · fermata 15:29 · … (al massimo 4)   │
 *  │ ──────────────────────── SOSTA 25' ───────────────────────── │
 *  │ COMPETENZE  Nastro 06:04 · Lavoro 05:49                      │
 *  │ NOTE  (A) …                                                  │
 *  └──────────────────────────────────────────────────────────────┘
 *
 * I passaggi alle fermate intermedie arrivano dal caricatore opzionale
 * (POST /planning-studio/projects/:id/stop-times/bulk); senza, la scheda
 * mostra solo partenza e arrivo. Delle fermate se ne stampano poche (le
 * fermate orario, al massimo `maxStops`): vedi pickStops. La finestra si
 * apre SUBITO (i popup bloccati nascono dalle aperture dopo un'attesa) e si
 * riempie a dati pronti; ogni foglio si adatta da solo a una pagina.
 */
import type {
  DriverShiftsResult,
  DriverShiftData,
  HandoverInfo,
  Ripresa,
  RipresaTrip,
} from "@/pages/fucina/turni-guida/types";
import { TYPE_LABELS } from "@/pages/fucina/turni-guida/constants";
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
  /** fermate intermedie stampate al massimo per corsa (default 4; 0 = nessuna) */
  maxStops?: number;
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

/* ── HTML: il foglio a schede di Shift Manager ───────────────
 *
 * Il disegno è quello della vista «card» di Shift Manager (whiteboard,
 * apps/turni-guida: cards.js e card.css), così il foglio che esce da
 * Cerbero e quello che esce dallo strumento dei turni pubblicati si
 * leggono allo stesso modo: accento per tipo di giorno, corse in schede
 * con la tratta in evidenza, voci di servizio in righe leggere, una
 * pagina A4 per turno. In più, rispetto a Shift Manager: la dimensione
 * della vettura su ogni corsa (e in testata) e le sole fermate principali
 * del percorso. */

/** Accento del foglio per tipo di giorno, come in Shift Manager. */
const ACCENTO: Record<string, string> = {
  FERIALE: "#D97706",   // ambra
  SABATO: "#059669",    // verde
  FESTIVO: "#DC2626",   // rosso
};
const ACCENTO_NEUTRO = "#475569";

/** Colori delle lettere delle note, nell'ordine di Shift Manager. */
const PALETTE_NOTE = [
  "#FF0000", "#0070C0", "#00B050", "#000000", "#FF00FF",
  "#7030A0", "#FF6600", "#00B0F0", "#92D050", "#BF9000",
];
const COLORE_VIOLAZIONE = "#B91C1C";

/** Fermate intermedie stampate al massimo per corsa (default). */
export const MAX_FERMATE_DEFAULT = 4;

/** Etichette dei tipi di mezzo: il conducente deve sapere che cosa guida,
 *  non solo la matricola. Su un percorso da pollicino un 10 metri non
 *  passa, e chi va in servizio non può scoprirlo in strada. */
const VEHICLE_SHORT: Record<string, string> = {
  autosnodato: "Snodato 18 m",
  filobus: "Filobus",
  "12m": "12 m",
  "10m": "10 m",
  pollicino: "Pollicino",
};

export function vehicleLabel(vt?: string | null): string {
  if (!vt) return "";
  return VEHICLE_SHORT[vt] || vt;
}

/**
 * Le fermate da stampare sotto una corsa: non tutte. Prima le fermate
 * orario (timepoint = 1) quando il percorso le distingue, poi al massimo
 * `max`, distribuite lungo il percorso (la prima e l'ultima sono già i
 * capolinea della scheda). Un percorso urbano ha venti fermate: stamparle
 * tutte riempie il foglio di righe che nessuno legge.
 */
export function pickStops(stops: StopPassage[] | undefined, max = MAX_FERMATE_DEFAULT): StopPassage[] {
  const mid = (stops ?? []).slice(1, -1).filter(s => s.time && s.stopName);
  if (max <= 0 || mid.length === 0) return [];
  const orario = mid.filter(s => s.timepoint === 1);
  const candidati = orario.length > 0 && orario.length < mid.length ? orario : mid;
  if (candidati.length <= max) return candidati;
  // `max` fermate equidistanti, nell'ordine del percorso
  const out: StopPassage[] = [];
  for (let k = 1; k <= max; k += 1) {
    const i = Math.round((k * (candidati.length + 1)) / (max + 1)) - 1;
    const s = candidati[Math.min(candidati.length - 1, Math.max(0, i))];
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

function durataTesto(min: number): string {
  return min > 0 ? `${min}'` : "";
}

function tripCardHtml(t: RipresaTrip, rip: Ripresa, stops: StopPassage[] | undefined, maxStops: number,
                      colori: Record<string, string>, marker?: string): string {
  const dur = durataTesto(Math.max(0, t.arrivalMin - t.departureMin));
  const mezzo = vehicleLabel(t.vehicleType || rip.vehicleType);
  const tappe = pickStops(stops, maxStops)
    .map(s => `<span class="tappa"><span class="t-luogo">${esc(s.stopName)}</span><span class="t-ora">${esc(hhmmFromTime(s.time))}</span></span>`)
    .join("");
  const meta = [
    t.variantCode ? `<span class="ameli">${esc(t.variantCode)}</span>` : "",
    marker ? `<span class="nota-b" style="--nota:${colori[marker] || "#000"}">${esc(marker)}</span>` : "",
  ].filter(Boolean).join("");
  return `
<div class="card corsa">
  <div class="tratta">
    <div class="c-linea">
      <span class="linea">${esc(t.routeName || "—")}</span>
      ${t.vehicleId || mezzo
    ? `<span class="tm">${t.vehicleId ? `TM ${esc(t.vehicleId)}` : ""}${mezzo ? `<span class="mezzo">${esc(mezzo)}</span>` : ""}</span>`
    : ""}
    </div>
    <div class="capo">
      <div class="ora">${esc(hhmmFromTime(t.departureTime) || hhmm(t.departureMin))}</div>
      <div class="luogo">${esc(t.firstStopName || "—")}</div>
    </div>
    <div class="binario">
      <span class="pallino"></span><span class="linea-b"></span>
      ${dur ? `<span class="durata">${esc(dur)}</span>` : ""}
      <span class="linea-b"></span><span class="freccia"></span>
    </div>
    <div class="capo capo-arr">
      <div class="ora">${esc(hhmmFromTime(t.arrivalTime) || hhmm(t.arrivalMin))}</div>
      <div class="luogo">${esc(t.lastStopName || "—")}</div>
    </div>
    ${meta ? `<div class="c-meta">${meta}</div>` : ""}
  </div>
  ${tappe ? `<div class="tappe">${tappe}</div>` : ""}
</div>`;
}

function rigaServizio(label: string, startMin: number, from: string, to: string | undefined, minutes: number,
                      endMin: number | null, marker?: string, colori: Record<string, string> = {}): string {
  const dur = durataTesto(minutes);
  return `
<div class="servizio${label === "Cambio" ? " cambio" : ""}">
  <span class="v-et">${esc(label)}</span>
  <span class="v-ora">${hhmm(startMin)}</span>
  <span class="v-luogo">${esc(from)}</span>
  ${to && to !== from ? `<span class="v-freccia">&rarr;</span><span class="v-luogo">${esc(to)}</span>` : ""}
  <span class="c-spazio"></span>
  ${marker ? `<span class="nota-b" style="--nota:${colori[marker] || "#000"}">${esc(marker)}</span>` : ""}
  ${dur ? `<span class="v-durata">${esc(dur)}</span>` : ""}
  ${endMin !== null ? `<span class="v-ora">${hhmm(endMin)}</span>` : ""}
</div>`;
}

function rowHtml(r: SheetRow, ripDi: Map<string, Ripresa>, stopsByTrip: Record<string, StopPassage[]>,
                 maxStops: number, colori: Record<string, string>): string {
  switch (r.kind) {
    case "trip":
      return tripCardHtml(r.trip, ripDi.get(r.trip.tripId) ?? ({} as Ripresa), stopsByTrip[r.trip.tripId], maxStops, colori, r.marker);
    case "line":
      return rigaServizio(r.label, r.startMin, r.from, r.to, r.minutes, r.endMin);
    case "sosta":
      return `<div class="pausa"><span>Sosta ${r.minutes}'</span></div>`;
    case "interruzione":
      return `<div class="interruzione"><span>Interruzione ${hhmm(r.startMin)} – ${hhmm(r.endMin)}</span></div>`;
    case "cambio":
      return rigaServizio("Cambio", r.startMin, r.text, undefined, 0, null, r.marker, colori);
  }
}

/** I tipi di mezzo del turno, nell'ordine in cui li si guida. */
function mezziDelTurno(shift: DriverShiftData): string[] {
  const out: string[] = [];
  for (const rip of shift.riprese) {
    for (const t of rip.trips) {
      const m = vehicleLabel(t.vehicleType || rip.vehicleType);
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}

function sheetHtml(shift: DriverShiftData, result: DriverShiftsResult, opts: SheetPrintOptions,
                   stopsByTrip: Record<string, StopPassage[]>): string {
  const depot = (shift.residenzaName || opts.depotName || "").trim() || "—";
  const dayType = (opts.dayTypeLabel || dayTypeFromDate(result.date) || "").toUpperCase();
  const accento = ACCENTO[dayType] || ACCENTO_NEUTRO;
  const notes: SheetNote[] = [];
  const rows = buildRows(shift, depot, opts.sostaMin ?? 15, notes);
  for (const v of shift.bdsValidation?.violations ?? []) notes.push({ marker: "!", text: v });
  const colori: Record<string, string> = {};
  notes.forEach((n, i) => { colori[n.marker] = n.marker === "!" ? COLORE_VIOLAZIONE : PALETTE_NOTE[i % PALETTE_NOTE.length]; });

  const ripDi = new Map<string, Ripresa>();
  for (const rip of shift.riprese) for (const t of rip.trips) ripDi.set(t.tripId, rip);
  const maxStops = opts.maxStops ?? MAX_FERMATE_DEFAULT;
  const nTrips = shift.riprese.reduce((n, r) => n + (r.trips?.length ?? 0), 0);
  const mezzi = mezziDelTurno(shift);
  const program = (opts.scenarioName || result.scenarioName || "").trim();
  const validFrom = opts.validFrom || itDate(result.date);
  const tipo = (TYPE_LABELS[shift.type] ?? shift.type) || "";
  const competenze = [
    `Nastro ${durHM(shift.nastroMin)}`,
    `Lavoro ${durHM(shift.workMin)}`,
    shift.interruptionMin ? `Interruzione ${durHM(shift.interruptionMin)}` : "",
  ].filter(Boolean).join(" · ");

  return `
<article class="foglio-card" data-turno="${esc(shift.driverId)}" style="--accento:${accento}">
 <div class="k-contenuto adattabile" data-fluida="1">
  <header class="k-testata">
    <div class="k-sx">
      <div class="k-codice">${esc(shift.driverId)}</div>
      <div class="k-sotto">
        <span class="k-dep">${esc(depot.toUpperCase())}</span>
        ${tipo ? `<span class="k-pill">${esc(tipo)}</span>` : ""}
        ${dayType ? `<span class="k-pill k-fascia">${esc(dayType)}</span>` : ""}
      </div>
    </div>
    <div class="k-dx">
      <div class="k-dati">
        <div><span>Nastro</span><b>${esc(shift.nastroStart)} – ${esc(shift.nastroEnd)}</b></div>
        <div><span>Presentazione</span><b>${esc(shift.nastroStart)}</b></div>
        <div><span>Corse</span><b>${nTrips}</b></div>
        ${mezzi.length ? `<div><span>Vettura</span><b>${esc(mezzi.join(" · "))}</b></div>` : ""}
      </div>
    </div>
  </header>

  <div class="k-validita">
    <span>${esc(program)}</span>
    ${validFrom ? `<span>in vigore dal <b>${esc(validFrom)}</b></span>` : ""}
  </div>

  <div class="k-corpo">${rows.map(r => rowHtml(r, ripDi, stopsByTrip, maxStops, colori)).join("\n")}</div>

  <div class="k-comp"><span>Competenze</span><span>${esc(competenze)}</span></div>
  ${notes.length ? `<div class="k-note"><div class="k-note-t">Note</div>${notes.map(n => `
    <div class="nota-r"><span class="nota-b" style="--nota:${colori[n.marker] || "#000"}">${esc(n.marker)}</span><span>${esc(n.text)}</span></div>`).join("")}</div>` : ""}
 </div>
</article>`;
}

/* Lo stile delle schede di Shift Manager (card.css), con le aggiunte per la
 * vettura. Le misure sono per l'A4 verticale: una scheda non si spezza mai
 * a cavallo di due pagine. */
const CSS = `
  @page { size: A4 portrait; margin: 0; }
  html, body, * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: #334155; padding: 20px 0; }
  .toolbar { position: sticky; top: 0; z-index: 2; background: #fff; padding: 8px 12px; margin: -20px 0 20px; border-bottom: 1px solid #ddd;
    display: flex; gap: 8px; justify-content: flex-end; font-family: 'Segoe UI', system-ui, sans-serif; }
  .toolbar button { background: #0f172a; color: #fff; border: none; padding: 6px 14px; font-size: 10pt; border-radius: 6px; cursor: pointer; }
  .toolbar button.secondary { background: #64748b; }

  .k-contenuto { transform-origin: top left; display: flow-root; }
  .foglio-card {
    --testo: #0F172A; --tenue: #64748B; --bordo: #CBD5E1; --contorno: #64748B; --fondo: #F8FAFC;
    width: 210mm; min-height: 297mm; padding: 12mm 10mm; margin: 0 auto 18px;
    background: #fff; color: var(--testo); font-family: 'Segoe UI', system-ui, sans-serif;
    box-shadow: 0 6px 26px rgba(0,0,0,.35); border-radius: 3px;
  }

  .k-testata { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    padding-bottom: 12px; border-bottom: 3px solid var(--accento); }
  .k-codice { font-size: 40pt; font-weight: 800; line-height: .95; letter-spacing: -1px; }
  .k-sotto { display: flex; align-items: center; gap: 7px; margin-top: 7px; flex-wrap: wrap; }
  .k-dep { font-size: 13pt; font-weight: 700; color: var(--tenue); }
  .k-pill { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; padding: 3px 9px;
    border-radius: 999px; background: var(--fondo); border: 1px solid var(--bordo); color: var(--tenue); }
  .k-fascia { background: color-mix(in srgb, var(--accento) 12%, #fff); border-color: color-mix(in srgb, var(--accento) 45%, #fff); color: var(--accento); }
  .k-dx { display: flex; align-items: flex-start; gap: 16px; }
  .k-dati { text-align: right; display: flex; flex-direction: column; gap: 3px; }
  .k-dati div { display: flex; align-items: baseline; justify-content: flex-end; gap: 8px; }
  .k-dati span { font-size: 8pt; text-transform: uppercase; letter-spacing: .7px; color: var(--tenue); }
  .k-dati b { font-size: 12pt; font-variant-numeric: tabular-nums; }
  .k-validita { display: flex; justify-content: space-between; gap: 12px; font-size: 9pt; color: var(--tenue); padding: 7px 2px 0; }

  .k-corpo { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }

  .card { border: 1.5px solid var(--contorno); border-left: 5px solid var(--accento); border-radius: 0 12px 12px 0;
    background: #fff; padding: 9px 13px 10px; break-inside: avoid; page-break-inside: avoid; }
  .c-spazio { flex: 1; }
  .c-linea { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; flex: none; }
  .c-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
  .linea { font-size: 17pt; font-weight: 800; letter-spacing: -.3px; padding: 2px 12px; border-radius: 9px;
    background: color-mix(in srgb, var(--accento) 14%, #fff); color: var(--accento);
    border: 1px solid color-mix(in srgb, var(--accento) 35%, #fff); }
  .tm { font-size: 8pt; font-weight: 700; color: var(--tenue); letter-spacing: .5px; white-space: nowrap;
    display: flex; align-items: center; gap: 5px; }
  /* la dimensione della vettura, accanto alla matricola: si legge senza
     cercarla (nero pieno, riquadrata) e non allunga la scheda */
  .mezzo { font-size: 8pt; font-weight: 800; color: var(--testo); text-transform: uppercase; letter-spacing: .3px;
    border: 1.2px solid var(--testo); border-radius: 4px; padding: 0 4px; line-height: 1.25; }
  .ameli { font-size: 9pt; font-weight: 700; color: color-mix(in srgb, var(--accento) 70%, #000);
    background: color-mix(in srgb, var(--accento) 10%, #fff); border: 1px solid color-mix(in srgb, var(--accento) 30%, #fff);
    border-radius: 6px; padding: 2px 8px; }
  .nota-b { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex: none;
    border-radius: 6px; font-size: 9pt; font-weight: 800; color: #fff; background: var(--nota); }

  .tratta { display: flex; align-items: center; gap: 11px; }
  .capo { min-width: 0; flex: 0 1 auto; }
  .capo-arr { text-align: right; }
  .capo .ora { font-size: 20pt; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
  .capo .luogo { font-size: 11pt; font-weight: 600; color: var(--testo); margin-top: 2px; line-height: 1.2; }
  .binario { flex: 1; display: flex; align-items: center; gap: 5px; min-width: 60px; }
  .pallino { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--accento); flex: none; }
  .linea-b { flex: 1; height: 2px; background: var(--bordo); border-radius: 1px; }
  .freccia { width: 0; height: 0; flex: none; border-left: 7px solid var(--accento);
    border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
  .durata { font-size: 8pt; font-weight: 700; color: var(--tenue); background: var(--fondo); border-radius: 999px;
    padding: 1px 8px; white-space: nowrap; }

  .tappe { margin-top: 7px; padding-top: 7px; border-top: 1px dashed var(--bordo); display: flex; flex-wrap: wrap; gap: 3px 12px; }
  .tappa { font-size: 8.5pt; color: var(--tenue); white-space: nowrap; }
  .t-luogo { margin-right: 4px; }
  .t-ora { font-weight: 700; color: var(--testo); font-variant-numeric: tabular-nums; }

  .servizio { display: flex; align-items: center; gap: 9px; padding: 4px 13px 4px 18px; font-size: 9.5pt;
    color: var(--tenue); break-inside: avoid; }
  .servizio.cambio { background: #FFFBEB; border-radius: 6px; }
  .v-et { font-weight: 700; font-style: italic; min-width: 92px; }
  .v-ora { font-weight: 700; color: var(--testo); font-variant-numeric: tabular-nums; }
  .v-freccia { color: var(--tenue); }
  .v-durata { font-size: 8pt; font-weight: 700; color: var(--tenue); background: #fff; border: 1px solid var(--bordo);
    border-radius: 999px; padding: 1px 8px; }

  .pausa { display: flex; align-items: center; gap: 10px; padding: 1px 0; color: var(--tenue); }
  .pausa::before, .pausa::after { content: ''; flex: 1; height: 1px; background: var(--bordo); }
  .pausa span { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .interruzione { display: flex; align-items: center; gap: 10px; margin: 5px 0 0; color: #B45309; }
  .interruzione::before, .interruzione::after { content: ''; flex: 1; height: 2px;
    background: repeating-linear-gradient(90deg, #FCD34D 0 7px, transparent 7px 14px); }
  .interruzione span { font-size: 9pt; font-weight: 800; text-transform: uppercase; letter-spacing: 1.4px; }

  .k-comp { margin-top: 14px; padding-top: 9px; border-top: 1px solid var(--bordo); font-size: 9.5pt; color: var(--tenue); }
  .k-comp span { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; margin-right: 9px; }
  .k-note { margin-top: 11px; }
  .k-note-t { font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .7px; color: var(--tenue); margin-bottom: 5px; }
  .nota-r { display: flex; align-items: flex-start; gap: 8px; font-size: 10pt; margin-bottom: 4px; line-height: 1.35; }

  /* densità: quando il turno non sta in una pagina si comprime prima ciò
     che conta meno (tappe, spaziature), tenendo grandi orari e linea */
  .d-media .card { padding: 6px 11px 7px; }
  .d-media .k-corpo { gap: 4px; margin-top: 8px; }
  .d-media .linea { font-size: 15pt; padding: 1px 10px; }
  .d-media .capo .ora { font-size: 18pt; }
  .d-media .capo .luogo { font-size: 10.5pt; }
  .d-media .tappe { margin-top: 5px; padding-top: 5px; gap: 2px 9px; }
  .d-media .tappa { font-size: 8pt; }
  .d-media .k-codice { font-size: 34pt; }
  .d-media .k-testata { padding-bottom: 9px; }
  .d-media .servizio { padding: 2px 11px 2px 16px; font-size: 9pt; }
  .d-compatta .card { padding: 4px 9px 5px; border-radius: 0 10px 10px 0; }
  .d-compatta .k-corpo { gap: 3px; margin-top: 6px; }
  .d-compatta .linea { font-size: 14pt; padding: 1px 9px; border-radius: 7px; }
  .d-compatta .capo .ora { font-size: 16pt; }
  .d-compatta .capo .luogo { font-size: 10pt; margin-top: 1px; }
  .d-compatta .tappe { margin-top: 4px; padding-top: 4px; gap: 1px 8px; }
  .d-compatta .tappa { font-size: 7.5pt; }
  .d-compatta .k-codice { font-size: 30pt; }
  .d-compatta .k-sotto { margin-top: 4px; }
  .d-compatta .k-testata { padding-bottom: 7px; }
  .d-compatta .k-validita { padding-top: 4px; font-size: 8pt; }
  .d-compatta .servizio { padding: 1px 9px 1px 14px; font-size: 8.5pt; }
  .d-compatta .k-comp { margin-top: 9px; padding-top: 6px; font-size: 8.5pt; }
  .d-compatta .k-note { margin-top: 7px; }
  .d-compatta .nota-r { font-size: 9pt; margin-bottom: 2px; }

  @media print {
    body { background: #fff; padding: 0; }
    .no-print { display: none !important; }
    .foglio-card { box-shadow: none; margin: 0; border-radius: 0; break-after: page; page-break-after: always; }
    .foglio-card:last-of-type { break-after: auto; page-break-after: auto; }
  }
`;

/* Adattamento a una pagina A4, come fit.js di Shift Manager: si misura il
 * contenuto reso e, se non entra, si prova ogni densità e lo zoom più
 * grande che entra; si tiene la combinazione con l'orario più grande. */
const FIT_SCRIPT = `
(function () {
  var MM = 96 / 25.4, ZOOM_MINIMO = 0.5, PASSI = 10, SICUREZZA = 1;
  var DENSITA = [{ classe: '', ora: 20 }, { classe: 'd-media', ora: 18 }, { classe: 'd-compatta', ora: 16 }];
  function adatta(a) {
    var wrap = a.querySelector('.adattabile'); if (!wrap) return;
    var cs = getComputedStyle(a);
    var paginaH = 297 * MM;
    var dispW = 210 * MM - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var dispH = paginaH - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - SICUREZZA;
    function applica(z, classe) {
      DENSITA.forEach(function (d) { if (d.classe) a.classList.toggle(d.classe, d.classe === classe); });
      wrap.style.width = (dispW / z) + 'px'; wrap.style.zoom = String(z);
      return wrap.getBoundingClientRect().height;
    }
    function sfora() { return a.getBoundingClientRect().height > paginaH + 0.5; }
    function zoomNecessario(classe) {
      var entra = 1, h = applica(entra, classe);
      if (h <= dispH) return { z: entra, h: h };
      var eccede = entra;
      for (var i = 0; i < PASSI && h > dispH; i++) {
        eccede = entra;
        var nuovo = Math.max(ZOOM_MINIMO, entra * (dispH / h) * 0.995);
        if (nuovo === entra) break;
        entra = nuovo; h = applica(entra, classe);
      }
      if (h > dispH) return { z: entra, h: h };
      for (var j = 0; j < PASSI && eccede - entra > 0.002; j++) {
        var meta = (entra + eccede) / 2, hm = applica(meta, classe);
        if (hm <= dispH) { entra = meta; h = hm; } else { eccede = meta; }
      }
      h = applica(entra, classe);
      return { z: entra, h: h };
    }
    var scelta = null;
    DENSITA.forEach(function (d) {
      var r = zoomNecessario(d.classe), resa = d.ora * r.z;
      if (r.h <= dispH && (!scelta || resa > scelta.resa)) scelta = { classe: d.classe, z: r.z, resa: resa };
    });
    if (!scelta) { var u = DENSITA[DENSITA.length - 1]; scelta = { classe: u.classe, z: zoomNecessario(u.classe).z }; }
    var z = scelta.z; applica(z, scelta.classe);
    for (var k = 0; k < PASSI && sfora() && z > ZOOM_MINIMO; k++) { z = Math.max(ZOOM_MINIMO, z * 0.99); applica(z, scelta.classe); }
  }
  window.adattaFogli = function () { document.querySelectorAll('.foglio-card').forEach(adatta); };
})();
`;

/** Il documento dei fogli turno, una pagina per turno (puro: niente finestra). */
export function driverShiftSheetsHtml(result: DriverShiftsResult, opts: SheetPrintOptions = {},
                                      stopsByTrip: Record<string, StopPassage[]> = {},
                                      { autoPrint = true }: { autoPrint?: boolean } = {}): string {
  const shifts = result.driverShifts.slice().sort((a, b) => (a.nastroStartMin ?? 0) - (b.nastroStartMin ?? 0) || a.driverId.localeCompare(b.driverId));
  const title = (opts.scenarioName || result.scenarioName || "Fogli turno").trim();
  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)} · fogli turno</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="toolbar no-print">
    <span style="margin-right:auto;color:#475569;font-size:9pt;align-self:center">${shifts.length} fogli turno · ${esc(title)}</span>
    <button onclick="window.print()">Stampa</button>
    <button class="secondary" onclick="window.close()">Chiudi</button>
  </div>
  ${shifts.map(s => sheetHtml(s, result, opts, stopsByTrip)).join("\n")}
  <script>${FIT_SCRIPT}</script>
  <script>
    window.addEventListener("load", function () {
      var pronti = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      pronti.then(function () {
        window.adattaFogli();
        ${autoPrint ? "setTimeout(function () { window.print(); }, 300);" : ""}
      });
    });
  </script>
</body>
</html>`;
}

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

  let stopsByTrip: Record<string, StopPassage[]> = {};
  if (opts.loadStopTimes) {
    try {
      const ids = Array.from(new Set(result.driverShifts.flatMap(s => s.riprese.flatMap(r => r.trips.map(t => t.tripId))).filter(Boolean)));
      stopsByTrip = await opts.loadStopTimes(ids);
    } catch {
      stopsByTrip = {};
    }
  }
  w.document.open();
  w.document.write(driverShiftSheetsHtml(result, opts, stopsByTrip));
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
