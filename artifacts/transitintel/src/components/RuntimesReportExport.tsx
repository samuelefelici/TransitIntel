/* ═══════════════════════════════════════════════════════════════
 *  RuntimesReportExport — Cerbero Analytics
 *  Report HTML stampabile dei tempi di percorrenza per linea e corsa.
 *  Per ogni corsa mostra i tempi effettivi (mediana sui giorni) E i
 *  tempi "traslati" rispetto alla partenza effettiva dal capolinea,
 *  che costituiscono l'orario corretto da riportare nel programma.
 *  Powered by Cerbero Analytics · logo della pagina principale.
 * ═══════════════════════════════════════════════════════════════ */
import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface ExportStop {
  seq: number;
  stopId: string;
  stopName: string | null;
  scheduledSec: number | null;
  schedOffsetSec: number | null;
  obsOffsetSec: number | null;
  medianDelaySec: number | null;
  samples: number;
  stopped: boolean;       // il mezzo si è fermato (sosta rilevata dal GPS)
  stoppedRuns: number;
  proposedSec: number | null;
  arcSchedSec: number | null;
  arcObsSec: number | null;
  arcDeltaSec: number | null;
}
interface ExportTrip {
  tripId: string;
  headsign: string | null;
  directionId: number | null;
  runs: number;
  startSchedSec: number | null;
  coveredStops: number;
  totalStops: number;
  totalSchedSec: number | null;
  totalObsSec: number | null;
  totalDeltaSec: number | null;
  stops: ExportStop[];
}
interface ExportRoute {
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  routeColor: string | null;
  trips: ExportTrip[];
}
interface ExportResp {
  caronteAvailable: boolean;
  days: number;
  routeId: string | null;
  generatedAt: string;
  routes: ExportRoute[];
}

/* ─── helpers ─── */
function clock(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function dur(sec: number | null): string {
  if (sec == null) return "—";
  const a = Math.abs(sec);
  return `${Math.floor(a / 60)}'${String(a % 60).padStart(2, "0")}"`;
}
function signed(sec: number | null): string {
  if (sec == null) return "—";
  return `${sec > 0 ? "+" : sec < 0 ? "−" : ""}${dur(sec)}`;
}
function deltaCls(sec: number | null): string {
  if (sec == null) return "";
  if (sec > 120) return "neg";
  if (sec > 30) return "warn";
  if (sec < -90) return "fast";
  return "ok";
}
function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function dirLabel(d: number | null): string {
  return d === 1 ? "Ritorno" : d === 0 ? "Andata" : "—";
}

// Colore della tratta in base allo scarto reale−programmato
function arcColor(sec: number | null): string {
  if (sec == null) return "#cbd5e1";
  if (sec > 60) return "#dc2626";   // ritardo forte
  if (sec > 20) return "#f59e0b";   // ritardo
  if (sec < -60) return "#0284c7";  // anticipo forte
  if (sec < -20) return "#38bdf8";  // anticipo
  return "#059669";                 // in orario
}

// Profilo della corsa: per ogni fermata calcola effettivo (tipico = programmato
// + ritardo mediano), scarto e "come dovrebbe essere" (effettivo riportato alla
// partenza programmata: si anticipano tutti i transiti del ritardo di partenza).
interface ProfStop {
  seq: number; stopName: string | null; stopId: string;
  scheduledSec: number | null;
  effettivoSec: number | null;
  scartoSec: number | null;
  comeDovrebbeSec: number | null;
  arcDeltaSec: number | null;
  fatta: boolean;
  imputed: boolean;
}

function buildProfile(t: ExportTrip): ProfStop[] {
  const ss = t.stops;
  // ritardo di partenza = scarto della prima fermata rilevata (capolinea)
  const firstObs = ss.find((s) => s.samples > 0 && s.medianDelaySec != null);
  const depDelay = firstObs?.medianDelaySec ?? 0;

  const prof: ProfStop[] = ss.map((s) => {
    // FATTA = il mezzo si è fermato (sosta GPS). I tempi (effettivo/scarto)
    // restano basati sui transiti, segnali distinti.
    const fatta = s.stopped === true;
    const hasTransit = s.samples > 0 && s.medianDelaySec != null;
    const effettivoSec = hasTransit && s.scheduledSec != null ? s.scheduledSec + (s.medianDelaySec as number) : null;
    return {
      seq: s.seq, stopName: s.stopName, stopId: s.stopId,
      scheduledSec: s.scheduledSec,
      effettivoSec,
      scartoSec: hasTransit ? s.medianDelaySec : null,
      comeDovrebbeSec: effettivoSec != null ? effettivoSec - depDelay : null,
      arcDeltaSec: null,
      fatta, imputed: false,
    };
  });

  // capolinea d'arrivo: se il GPS non lo registra, stima = penultima + percorrenza programmata
  if (prof.length >= 2) {
    const last = prof[prof.length - 1], pen = prof[prof.length - 2];
    if (last.effettivoSec == null && pen.effettivoSec != null && last.scheduledSec != null && pen.scheduledSec != null && last.scheduledSec >= pen.scheduledSec) {
      last.effettivoSec = pen.effettivoSec + (last.scheduledSec - pen.scheduledSec);
      last.scartoSec = last.effettivoSec - last.scheduledSec;
      last.comeDovrebbeSec = last.effettivoSec - depDelay;
      last.imputed = true;
    }
  }

  // scarto sull'arco (percorrenza reale − programmata) per colorare il disegno
  for (let i = 1; i < prof.length; i++) {
    const cur = prof[i], prev = prof[i - 1];
    if (cur.comeDovrebbeSec != null && prev.comeDovrebbeSec != null && cur.scheduledSec != null && prev.scheduledSec != null) {
      cur.arcDeltaSec = (cur.comeDovrebbeSec - prev.comeDovrebbeSec) - (cur.scheduledSec - prev.scheduledSec);
    }
  }
  return prof;
}

// Diagramma a linea colorata: tratte colorate per scarto, pallini = fermate fatte
function buildDiagramSVG(prof: ProfStop[]): string {
  const n = prof.length;
  if (n < 2) return "";
  const W = 1000, mX = 40, y = 34, r = 5;
  const usable = W - 2 * mX;
  const x = (i: number) => mX + (usable * i) / (n - 1);
  const pc = "-webkit-print-color-adjust:exact;print-color-adjust:exact";

  let body = `<rect x="0" y="0" width="${W}" height="58" fill="#fff"/>`;
  for (let i = 1; i < n; i++) {
    const c = arcColor(prof[i].arcDeltaSec);
    body += `<line x1="${x(i - 1).toFixed(1)}" y1="${y}" x2="${x(i).toFixed(1)}" y2="${y}" stroke="${c}" stroke-width="8" stroke-linecap="round" style="${pc}"/>`;
    if (prof[i].arcDeltaSec != null && Math.abs(prof[i].arcDeltaSec!) >= 30) {
      body += `<text x="${((x(i - 1) + x(i)) / 2).toFixed(1)}" y="${y - 11}" text-anchor="middle" font-size="9" font-weight="700" fill="${c}">${signed(prof[i].arcDeltaSec)}</text>`;
    }
  }
  for (let i = 0; i < n; i++) {
    const s = prof[i];
    if (s.fatta) {
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y}" r="${r}" fill="#059669" stroke="#fff" stroke-width="1.6" style="${pc}"/>`;
    } else if (s.imputed) {
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y}" r="${r}" fill="#f59e0b" stroke="#fff" stroke-width="1.6" stroke-dasharray="2 1.5" style="${pc}"/>`;
    } else {
      body += `<circle cx="${x(i).toFixed(1)}" cy="${y}" r="${r - 0.5}" fill="#fff" stroke="#dc2626" stroke-width="1.8" stroke-dasharray="2 1.5" style="${pc}"/>`;
    }
  }
  const first = esc((prof[0].stopName ?? prof[0].stopId ?? "").slice(0, 28));
  const last = esc((prof[n - 1].stopName ?? prof[n - 1].stopId ?? "").slice(0, 28));
  body += `<text x="${x(0).toFixed(1)}" y="${y + 18}" text-anchor="start" font-size="9" fill="#475569">${first}</text>`;
  body += `<text x="${x(n - 1).toFixed(1)}" y="${y + 18}" text-anchor="end" font-size="9" fill="#475569">${last}</text>`;
  return `<svg viewBox="0 0 ${W} 58" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;margin:2px 0 8px;${pc}">${body}</svg>`;
}

function buildHTML(data: ExportResp, logoUrl: string, periodLabel: string): string {
  const today = new Date().toLocaleString("it-IT", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const nRoutes = data.routes.length;
  const nTrips = data.routes.reduce((s, r) => s + r.trips.length, 0);

  const routeSections = data.routes.map((r) => {
    const color = r.routeColor ? `#${String(r.routeColor).replace(/^#/, "")}` : "#1f2937";
    const tripBlocks = r.trips.map((t) => {
      const prof = buildProfile(t);
      const fatte = prof.filter((s) => s.fatta || s.imputed).length;
      const rows = prof.map((s) => {
        const stato = s.fatta
          ? `<span class="ok" title="il mezzo si è fermato">●</span>`
          : s.imputed
            ? `<span class="warn" title="capolinea stimato">◐</span>`
            : `<span class="neg" title="non si è fermato">○</span>`;
        return `
        <tr>
          <td class="num">${s.seq}</td>
          <td class="cstato">${stato}</td>
          <td>${esc(s.stopName ?? s.stopId)}</td>
          <td class="num">${clock(s.scheduledSec)}</td>
          <td class="num">${clock(s.effettivoSec)}</td>
          <td class="num ${deltaCls(s.scartoSec)}">${signed(s.scartoSec)}</td>
          <td class="num proposed">${clock(s.comeDovrebbeSec)}</td>
        </tr>`;
      }).join("");
      return `
        <div class="trip">
          <div class="trip-head">
            <span class="trip-time">${clock(t.startSchedSec)}</span>
            <span class="trip-dir">${dirLabel(t.directionId)}${t.headsign ? ` → ${esc(t.headsign)}` : ""}</span>
            <span class="trip-meta">${fatte}/${prof.length} fermate fatte · durata reale ${dur(t.totalObsSec)}
              (programmata ${dur(t.totalSchedSec)}, <span class="${deltaCls(t.totalDeltaSec)}">${signed(t.totalDeltaSec)}</span>) · ${t.runs} giorni</span>
          </div>
          ${buildDiagramSVG(prof)}
          <table>
            <thead><tr>
              <th class="num">#</th><th class="cstato">Fatta</th><th>Fermata</th>
              <th class="num">Programmato</th><th class="num">Effettivo</th>
              <th class="num">Scarto</th><th class="num">Come dovrebbe essere</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join("");

    return `
      <section class="route">
        <h2><span class="line-badge" style="background:${color}">${esc(r.routeShortName ?? r.routeId ?? "?")}</span>
          ${esc(r.routeLongName ?? "")}<span class="route-count">${r.trips.length} corse</span></h2>
        ${tripBlocks}
      </section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8" />
<title>Cerbero Analytics — Tempi di Percorrenza</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#fff; color:#111;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; font-size:11px; line-height:1.45; }
  .page { max-width:1080px; margin:0 auto; padding:28px 36px; }
  .hero { background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%); color:#fff;
    padding:22px 28px; border-radius:14px; margin-bottom:24px; display:flex; align-items:center; gap:20px; }
  .hero img { height:52px; width:auto; filter:drop-shadow(0 0 8px rgba(56,189,248,.5)); }
  .hero .t h1 { margin:0 0 3px; font-size:20px; font-weight:700; }
  .hero .t .sub { font-size:12px; opacity:.85; }
  .hero .meta { margin-left:auto; text-align:right; font-size:10px; opacity:.9; line-height:1.7; }
  .hero .meta b { font-weight:700; }
  section.route { margin-bottom:26px; page-break-inside:auto; }
  h2 { font-size:14px; font-weight:700; margin:0 0 10px; color:#0f172a; display:flex; align-items:center; gap:10px;
    border-bottom:2px solid #e2e8f0; padding-bottom:6px; }
  .line-badge { color:#fff; font-size:11px; font-weight:700; padding:3px 8px; border-radius:5px; }
  .route-count { margin-left:auto; font-size:10px; font-weight:500; color:#64748b; }
  .trip { margin:0 0 14px; page-break-inside:avoid; }
  .trip-head { display:flex; align-items:baseline; gap:10px; margin:8px 0 4px; padding:4px 8px;
    background:#f1f5f9; border-radius:6px; }
  .trip-time { font-weight:700; font-size:12px; font-variant-numeric:tabular-nums; color:#0f172a; }
  .trip-dir { font-weight:600; color:#334155; }
  .trip-meta { margin-left:auto; font-size:9px; color:#64748b; }
  table { width:100%; border-collapse:collapse; font-size:9.5px; }
  th { background:#f8fafc; color:#475569; text-align:left; padding:4px 6px; border-bottom:1px solid #cbd5e1;
    font-size:8.5px; text-transform:uppercase; letter-spacing:.2px; font-weight:600; }
  td { padding:3px 6px; border-bottom:1px solid #f1f5f9; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.strong { font-weight:700; }
  td.muted, .muted { color:#94a3b8; }
  td.proposed { font-weight:700; color:#0369a1; background:#f0f9ff; }
  .ok { color:#059669; } .warn { color:#d97706; } .neg { color:#dc2626; font-weight:700; } .fast { color:#0284c7; }
  .footer { margin-top:28px; padding-top:14px; border-top:1px solid #e2e8f0;
    display:flex; align-items:center; gap:10px; font-size:9px; color:#94a3b8; }
  .footer img { height:20px; opacity:.8; }
  .footer .powered { font-weight:700; color:#475569; letter-spacing:.3px; }
  .legend { font-size:9px; color:#64748b; margin:0 0 16px; }
  td.cstato, th.cstato { text-align:center; width:34px; }
  td.cstato span { font-size:11px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  @media print { .page { padding:14px 18px; } .hero,.proposed { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    section.route { page-break-inside:auto; } .trip { page-break-inside:avoid; } }
</style></head>
<body><div class="page">
  <div class="hero">
    <img src="${logoUrl}" alt="logo" />
    <div class="t">
      <h1>Tempi di Percorrenza</h1>
      <div class="sub">Analisi automatica per linea e corsa dai transiti AVM · tempi effettivi e orari corretti proposti</div>
    </div>
    <div class="meta">
      <div><b>Periodo</b> ${esc(periodLabel)}</div>
      <div><b>${nRoutes}</b> linee · <b>${nTrips}</b> corse</div>
      <div>Generato ${today}</div>
    </div>
  </div>
  <p class="legend">
    <b>Fatta</b> = il mezzo si è fermato (sosta rilevata dal GPS): <span class="ok">●</span> fermato · <span class="warn">◐</span> capolinea stimato · <span class="neg">○</span> non fermato.
    <b>Effettivo</b> = orario tipico reale (programmato + ritardo mediano). <b>Scarto</b> = effettivo − programmato.
    <b>Come dovrebbe essere</b> = effettivo riportato alla partenza programmata (si anticipano tutti i transiti del ritardo di partenza),
    cioè i tempi reali di percorrenza con la stessa ora di partenza.
    Nel disegno la <b>linea</b> è colorata per scarto di percorrenza (<span class="neg">rosso</span> più lento,
    <span class="fast">azzurro</span> più veloce, <span class="ok">verde</span> in orario) e i <b>pallini</b> indicano le fermate fatte.
  </p>
  ${routeSections || '<p style="text-align:center;color:#94a3b8;padding:40px">Nessun dato nel periodo selezionato.</p>'}
  <div class="footer">
    <img src="${logoUrl}" alt="logo" />
    <span class="powered">Powered by Cerbero Analytics</span>
    <span style="margin-left:auto">Report generato automaticamente dai transiti AVM · ${today}</span>
  </div>
</div>
<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},500);});</script>
</body></html>`;
}

export interface RuntimesReportExportProps {
  days: number;
  routeId?: string;
  hourFrom?: number | null;
  hourTo?: number | null;
  periodLabel: string;
  className?: string;
}

export function RuntimesReportExport({ days, routeId, hourFrom, hourTo, periodLabel, className }: RuntimesReportExportProps) {
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (routeId) qs.set("routeId", routeId);
      if (hourFrom != null && hourTo != null) { qs.set("hourFrom", String(hourFrom)); qs.set("hourTo", String(hourTo)); }
      const data = await apiFetch<ExportResp>(`/api/operations/runtimes/export?${qs.toString()}`);
      if (!data.caronteAvailable || data.routes.length === 0) {
        alert("Nessun dato di percorrenza nel periodo selezionato.");
        return;
      }
      const logoUrl = `${window.location.origin}/logo.png`;
      const html = buildHTML(data, logoUrl, periodLabel);
      const win = window.open("", "_blank", "width=1100,height=860");
      if (!win) { alert("Popup bloccato dal browser. Abilita i popup e riprova."); return; }
      win.document.open();
      win.document.write(html);
      win.document.close();
    } catch (e: any) {
      alert(`Errore nell'esportazione: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={loading}
      className={className ??
        "flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-gradient-to-r from-sky-600 to-indigo-600 text-white hover:from-sky-700 hover:to-indigo-700 transition-colors disabled:opacity-40"}
      title="Report PDF dei tempi di percorrenza per linea e corsa — Powered by Cerbero Analytics"
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileDown className="w-3.5 h-3.5" />}
      Report Cerbero Analytics
    </button>
  );
}

export default RuntimesReportExport;
