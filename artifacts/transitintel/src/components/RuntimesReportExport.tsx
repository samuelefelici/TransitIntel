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

function buildHTML(data: ExportResp, logoUrl: string, periodLabel: string): string {
  const today = new Date().toLocaleString("it-IT", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const nRoutes = data.routes.length;
  const nTrips = data.routes.reduce((s, r) => s + r.trips.length, 0);

  const routeSections = data.routes.map((r) => {
    const color = r.routeColor ? `#${String(r.routeColor).replace(/^#/, "")}` : "#1f2937";
    const tripBlocks = r.trips.map((t) => {
      const rows = t.stops.map((s, i) => `
        <tr>
          <td class="num">${s.seq}</td>
          <td>${esc(s.stopName ?? s.stopId)}</td>
          <td class="num">${clock(s.scheduledSec)}</td>
          <td class="num">${dur(s.schedOffsetSec)}</td>
          <td class="num strong">${dur(s.obsOffsetSec)}</td>
          <td class="num ${deltaCls(s.obsOffsetSec != null && s.schedOffsetSec != null ? s.obsOffsetSec - s.schedOffsetSec : null)}">
            ${signed(s.obsOffsetSec != null && s.schedOffsetSec != null ? s.obsOffsetSec - s.schedOffsetSec : null)}</td>
          <td class="num">${i === 0 ? "—" : dur(s.arcSchedSec)}</td>
          <td class="num">${i === 0 ? "—" : dur(s.arcObsSec)}</td>
          <td class="num ${deltaCls(s.arcDeltaSec)}">${i === 0 ? "—" : signed(s.arcDeltaSec)}</td>
          <td class="num ${deltaCls(s.medianDelaySec)}">${signed(s.medianDelaySec)}</td>
          <td class="num proposed">${clock(s.proposedSec)}</td>
          <td class="num muted">${s.samples || "—"}</td>
        </tr>`).join("");
      return `
        <div class="trip">
          <div class="trip-head">
            <span class="trip-time">${clock(t.startSchedSec)}</span>
            <span class="trip-dir">${dirLabel(t.directionId)}${t.headsign ? ` → ${esc(t.headsign)}` : ""}</span>
            <span class="trip-meta">${t.runs} giornate · copertura ${t.coveredStops}/${t.totalStops} ·
              prog ${dur(t.totalSchedSec)} · reale ${dur(t.totalObsSec)}
              <span class="${deltaCls(t.totalDeltaSec)}">(${signed(t.totalDeltaSec)})</span></span>
          </div>
          <table>
            <thead><tr>
              <th class="num">#</th><th>Fermata</th>
              <th class="num">Orario prog</th><th class="num">Cum. prog</th>
              <th class="num">Cum. reale</th><th class="num">Δ cum</th>
              <th class="num">Arco prog</th><th class="num">Arco reale</th><th class="num">Δ arco</th>
              <th class="num">Ritardo med</th><th class="num">Orario corretto</th><th class="num">Camp.</th>
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
    <b>Cum. prog/reale</b> = tempo dalla partenza (capolinea) · <b>Cum. reale</b> traslato sulla partenza effettiva ·
    <b>Δ</b> scarto reale−programmato (<span class="neg">rosso</span> più lento, <span class="fast">azzurro</span> più veloce) ·
    <b>Orario corretto</b> = partenza programmata + tempo reale traslato (proposta di ritaratura).
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
