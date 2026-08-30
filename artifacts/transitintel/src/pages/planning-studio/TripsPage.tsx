/**
 * PlannerStudio — Gestione Corse (Trips Manager).
 *
 * Schema vista:
 *   - filtri top: Linea / Variante / Calendario / Solo attive
 *   - tabella corse con colonne: orari, calendario, validità, label, attivo, azioni
 *   - selezione multi-row per operazioni bulk (calendar, validità, attivo)
 *   - drawer dx per dettaglio corsa: validità individuale + eccezioni date
 *
 * Le corse vengono modificate con PATCH per singola riga (validità, label,
 * isActive) o in bulk via /trips/bulk-update.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import TripCountBadge from "@/components/planning-studio/TripCountBadge";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import ConfirmDialog, { type ConfirmRequest } from "@/components/planning-studio/ConfirmDialog";
import {
  ArrowLeft, Bus, Filter, Trash2, X, Loader2, Check, Calendar as CalendarIcon,
  Power, PowerOff, CalendarPlus, CalendarMinus, Save, Eye, EyeOff, Timer, Plus,
  Pencil, Copy, Merge, Wand2, Printer,
} from "lucide-react";
import {
  getPsProject,
  listPsRoutes, type PsRoute,
  listPsVariants, type PsVariant,
  listPsCalendars, type PsCalendar,
  listPsTrips, deletePsTrip, updatePsTrip, bulkUpdatePsTrips, bulkDeletePsTrips, prototypeMissingPsTrips, splitPsTripByCategories, type PsTrip,
  getPsStopTimes, setPsStopTimes, type PsStopTime,
  batchCreatePsTrips, type PsBatchTripInput,
  mergePsTwins, type MergeTwinsResult,
  getPsCorseKm, type PsCorseKm,
  getPsVariant, type PsVariantStop,
  listPsTripExceptions, addPsTripException, deletePsTripException, type PsTripException,
} from "@/lib/planning-studio-api";
import { listPsDayTypes, postPsValidityBulk, getPsTripValidity, getPsTripsValidityBulk, type PsDayType } from "@/lib/planning-studio-validity-api";
import { listPsValidityCategories, type PsValidityCategory } from "@/lib/planning-studio-validity-units-api";
import CategoryChips from "@/components/planning-studio/CategoryChips";
import OperationalEditWarning from "@/components/planning-studio/OperationalEditWarning";
import TripTransitsEditor from "@/components/planning-studio/TripTransitsEditor";
import { useArgosFresh } from "@/hooks/useArgosFresh";

/** Distanze progressive (m) tra le fermate di una variante: shape_dist se
 * monotona, altrimenti cumulata haversine. */
function cumDistsOf(vStops: PsVariantStop[]): number[] {
  const sdt = vStops.map(st => st.shapeDistTraveled);
  const ok = vStops.length >= 2 &&
    sdt.every(d => d != null && Number.isFinite(d)) &&
    sdt.every((d, i) => i === 0 || (d as number) >= (sdt[i - 1] as number)) &&
    (sdt[sdt.length - 1] as number) > 0;
  if (ok) { const base = sdt[0] as number; return sdt.map(d => (d as number) - base); }
  const out = [0];
  for (let i = 1; i < vStops.length; i++) {
    const a2 = vStops[i - 1], b2 = vStops[i];
    const R = 6371000, dLat = (b2.lat - a2.lat) * Math.PI / 180, dLon = (b2.lon - a2.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a2.lat * Math.PI / 180) * Math.cos(b2.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    out.push(out[i - 1] + 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
  }
  return out;
}

/* ─── Ordinamento della tabella corse ───────────────────────────────────────
 * Ogni intestazione è un pulsante: 1° clic crescente, 2° decrescente, 3° torna
 * all'ordine naturale (partenza, poi nome). */
type TripSortKey =
  | "partenza" | "linea" | "headsign" | "giorni" | "categorie"
  | "periodo" | "etichetta" | "chiamata" | "stato";
type TripSort = { key: TripSortKey; dir: "asc" | "desc" } | null;

/** Intestazione ordinabile: etichetta + freccia dello stato corrente. */
function SortTh({ label, sortKey, sort, onToggle, title, align = "left", className = "" }: {
  label: string;
  sortKey: TripSortKey;
  sort: TripSort;
  onToggle: (k: TripSortKey) => void;
  title?: string;
  align?: "left" | "center";
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const arrow = active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕";
  return (
    <th className={`p-2 ${align === "center" ? "text-center" : "text-left"} ${className}`}>
      <button
        onClick={() => onToggle(sortKey)}
        title={`${title ? `${title}\n\n` : ""}Clic per ordinare: crescente → decrescente → ordine naturale`}
        className={`inline-flex items-center gap-1 rounded px-1 -mx-1 py-0.5 transition-colors hover:text-amber-300 ${
          active ? "text-amber-300 font-semibold" : "text-inherit"
        }`}
      >
        {label}
        <span className={active ? "text-[9px]" : "text-[9px] text-slate-600"}>{arrow}</span>
      </button>
    </th>
  );
}

function fmtTime(t?: string | null) {
  if (!t) return "—";
  return t.length >= 5 ? t.slice(0, 5) : t;
}
/** true se la categoria è un PERIODO di scuole chiuse (Estivo/Inverno…). */
function isChiuseSub(code?: string | null): boolean {
  return !!code && code.startsWith("scuole_chiuse_");
}
function fmtDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}
/* ─── Giorni di validità L…D: helper condivisi tra riga tabella e drawer ─── */
const WD_LABELS_ROW = ["L", "M", "M", "G", "V", "S", "D"];
const WD_NAMES = ["Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato", "Domenica"];
const wdTypicalCode = (i: number) => (i <= 4 ? "feriale" : i === 5 ? "sabato" : "festivo");
/** Pattern settimanale L…D di un calendario (per il fallback della maschera).
 *  Usa `effectiveWeekdays` se presente (deduce i giorni dai calendar_dates per i
 *  calendari senza flag settimanali), altrimenti i flag monday…sunday. */
function calWeekdays(c: PsCalendar | undefined | null): boolean[] | null {
  if (!c) return null;
  if (Array.isArray(c.effectiveWeekdays) && c.effectiveWeekdays.length === 7) return c.effectiveWeekdays.map(Boolean);
  return [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday];
}
/** Maschera settimanale EFFETTIVA della corsa:
 *  1) `attributes.weekdays` esplicita, se presente; altrimenti
 *  2) il pattern del calendario collegato (`fallback`, es. dopo import GTFS);
 *  3) tutti i giorni attivi.
 *  Così i bollini "Giorni validità" si accendono in base ai giorni reali di
 *  circolazione anche prima di toccare la Matrice di validità. */
function wdMaskOf(trip: PsTrip, fallback?: boolean[] | null): boolean[] {
  const w = (trip.attributes as any)?.weekdays;
  if (Array.isArray(w) && w.length === 7) return w.map((x: any) => x !== false);
  if (fallback && fallback.length === 7) return fallback.map(Boolean);
  return [true, true, true, true, true, true, true];
}
/** Classifica i tipi giorno per prefisso: feriale/FER, sabato/SAB, festivo/FES|DOM. */
function classifyDayTypes(dayTypes: PsDayType[]): Record<string, PsDayType> {
  const m: Record<string, PsDayType> = {};
  for (const dt of dayTypes) {
    const c = `${dt.code || dt.name || ""}`.toLowerCase();
    if (/^fer/.test(c) && !m.feriale) m.feriale = dt;
    else if (/^sab/.test(c) && !m.sabato) m.sabato = dt;
    else if (/^fes|^dom/.test(c) && !m.festivo) m.festivo = dt;
  }
  return m;
}

/* Conversioni orario GTFS (consentono >24:00 per corse dopo mezzanotte) */
function genToSec(t: string): number {
  const q = t.split(":").map(Number);
  return (q[0] || 0) * 3600 + (q[1] || 0) * 60 + (q[2] || 0);
}
function genSecToHms(x: number): string {
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), sec = Math.round(x % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/* ─── Stampa: elenco corse per linea → codice percorso ─────────────────────
 * Costruisce l'HTML stampabile con, per ogni corsa: partenza, giorni di
 * validità (pallini verdi L…D), categorie del calendario aziendale e "a
 * chiamata". Raggruppa per linea e per variante (codice percorso). */
function buildCorseListHtml(p: {
  projectName: string;
  routes: PsRoute[];                 // linee scelte (ordinate)
  trips: PsTrip[];                   // corse reali (no prototipi) delle linee scelte
  variantById: Map<string, PsVariant>;
  dayValidity: Record<string, Record<string, boolean>>;
  categoriesByTrip: Record<string, string[]>;
  catById: Map<string, PsValidityCategory>;
  dtKinds: Record<string, PsDayType>;
  calWdById: Map<string, boolean[]>;
  km?: PsCorseKm | null;
  rate?: number;                     // corrispettivo €/km (0/undefined = nascondi ricavi)
}): string {
  const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const dayOn = (t: PsTrip, i: number): boolean => {
    // Stessa semantica della validità EFFETTIVA (come rowDayOn in tabella):
    // con la matrice presente il calendario non è un veto e i tipi-giorno
    // senza riga NON circolano; la maschera esplicita resta un veto reale.
    const dvRaw = p.dayValidity[t.id];
    const dv = dvRaw && Object.keys(dvRaw).length > 0 ? dvRaw : null;
    const w = (t.attributes as any)?.weekdays;
    const mask = (Array.isArray(w) && w.length === 7)
      ? w.map((x: any) => x !== false)
      : dv ? [true, true, true, true, true, true, true]
      : wdMaskOf(t, t.calendarId ? p.calWdById.get(t.calendarId) : null);
    if (!mask[i]) return false;
    if (!dv) return true;
    const dt = p.dtKinds[wdTypicalCode(i)];
    if (!dt) return true;
    return dv[dt.id] === true;
  };
  const dotsHtml = (t: PsTrip) => WD_LABELS_ROW
    .map((l, i) => `<span class="dot ${dayOn(t, i) ? "on" : ""}">${l}</span>`).join("");
  // categorie: raggruppa i periodi di scuole chiuse sotto un'unica voce
  const catsHtml = (t: PsTrip) => {
    const ids = p.categoriesByTrip[t.id] ?? [];
    if (ids.length === 0) return `<span class="muted">tutte</span>`;
    const cats = ids.map(id => p.catById.get(id)).filter(Boolean) as PsValidityCategory[];
    const chiuse = cats.filter(c => isChiuseSub(c.code));
    const others = cats.filter(c => !isChiuseSub(c.code) && c.code !== "scuole_chiuse");
    const chip = (name: string, color?: string | null) => {
      const col = color || "#64748b";
      return `<span class="cat" style="border-color:${col}; background:${col}22">${name}</span>`;
    };
    const parts: string[] = others.map(c => chip(esc(c.name), c.color));
    if (chiuse.length) {
      // una card "Scuole Chiuse" con i periodi, ognuno col suo colore
      const inner = chiuse.map(c => `<span class="per" style="color:${c.color || "#f59e0b"}">${esc(c.name)}</span>`).join(", ");
      parts.push(`<span class="cat chiuse" style="border-color:#f59e0b; background:#f59e0b18">Scuole Chiuse <em>(${inner})</em></span>`);
    }
    return parts.join(" ");
  };
  const fmtDep = (t: PsTrip) => (t.firstDeparture ? String(t.firstDeparture).slice(0, 5) : "—");

  // raggruppa: route → variant → corse (ordinate per partenza)
  const routesSorted = [...p.routes].sort((a, b) => a.shortName.localeCompare(b.shortName, "it", { numeric: true }));
  let body = "";
  for (const r of routesSorted) {
    const rTrips = p.trips.filter(t => t.routeId === r.id);
    if (rTrips.length === 0) continue;
    const rColor = r.color || "#334155";
    body += `<section class="line"><h2 style="border-left:6px solid ${rColor}; padding-left:8px"><span class="swatch" style="background:${rColor}"></span>Linea ${esc(r.shortName)}${r.longName ? ` · ${esc(r.longName)}` : ""} <span class="count">${rTrips.length} corse</span></h2>`;
    // varianti presenti in queste corse
    const varIds = [...new Set(rTrips.map(t => t.variantId))];
    const vars = varIds.map(id => p.variantById.get(id)).filter(Boolean) as PsVariant[];
    vars.sort((a, b) => String(a.code || a.name).localeCompare(String(b.code || b.name), "it", { numeric: true }));
    for (const v of vars) {
      const vTrips = rTrips.filter(t => t.variantId === v.id)
        .sort((a, b) => (a.firstDeparture || "").localeCompare(b.firstDeparture || ""));
      const arrow = v.direction === 1 ? "←" : "→";
      const code = v.code ? `${esc(v.code)} · ` : "";
      body += `<h3>${code}${esc(v.name)} <span class="dir">${arrow}</span> <span class="count">${vTrips.length}</span></h3>`;
      body += `<table><thead><tr><th class="c-dep">Partenza</th><th class="c-days">Giorni di validità</th><th class="c-cat">Categorie validità</th><th class="c-dem">A chiamata</th></tr></thead><tbody>`;
      for (const t of vTrips) {
        body += `<tr><td class="c-dep">${fmtDep(t)}</td><td class="c-days"><span class="dots">${dotsHtml(t)}</span></td><td class="c-cat">${catsHtml(t)}</td><td class="c-dem">${t.attributes?.onDemand ? "📞 Sì" : "—"}</td></tr>`;
      }
      body += `</tbody></table>`;
    }
    body += `</section>`;
  }

  // Riepilogo km/anno per linea × categoria (dal calendario aziendale)
  let kmSection = "";
  if (p.km && p.km.hasCalendar && p.km.lines.length) {
    const km = p.km;
    const rate = p.rate && p.rate > 0 ? p.rate : 0;
    const fmtKm = (v?: number) => (v == null || v === 0) ? `<span class="muted">—</span>` : v.toLocaleString("it-IT", { maximumFractionDigits: 1 });
    const fmtEur = (v?: number) => (v == null || v === 0) ? `<span class="muted">—</span>` : `€ ${v.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const cats = km.categories;
    const nCols = cats.length + 2;
    const period = (km.from && km.to) ? ` · ${km.from} → ${km.to}` : "";
    const catHead = cats.map(c => `<th style="background:${(c.color || "#64748b")}22">${esc(c.name)}</th>`).join("");
    const lineLabel = (l: { shortName: string; longName: string | null; color: string | null }) =>
      `<td class="l"><span class="swatch" style="background:${l.color || "#334155"}"></span>${esc(l.shortName)}${l.longName ? ` · ${esc(l.longName)}` : ""}</td>`;
    // righe km programmati per linea
    const progRows = km.lines.map(l => `<tr>${lineLabel(l)}${cats.map(c => `<td>${fmtKm(l.kmByCategory[c.code])}</td>`).join("")}<td class="tot">${fmtKm(l.kmTotal)}</td></tr>`).join("");
    // sezione "potenziali a chiamata" (solo se presenti)
    let odRows = "";
    if (km.hasOnDemand) {
      const odLines = km.lines.filter(l => l.onDemandTotal > 0);
      odRows = `<tr class="grp"><td class="l" colspan="${nCols}">📞 Potenziali km a chiamata (servizio erogato su richiesta)</td></tr>`
        + odLines.map(l => `<tr class="od">${lineLabel(l)}${cats.map(c => `<td>${fmtKm(l.onDemandByCategory[c.code])}</td>`).join("")}<td class="tot">${fmtKm(l.onDemandTotal)}</td></tr>`).join("")
        + `<tr class="sum od"><td class="l">Totale a chiamata</td>${cats.map(c => `<td>${fmtKm(km.onDemandTotalsByCategory[c.code])}</td>`).join("")}<td class="tot">${fmtKm(km.onDemandGrandTotal)}</td></tr>`;
    }
    const kmTable = `<div class="scroll"><table class="km"><thead><tr><th class="l">Linea</th>${catHead}<th class="tot">Totale</th></tr></thead>
      <tbody>${progRows}
      <tr class="sum"><td class="l">Totale programmato</td>${cats.map(c => `<td>${fmtKm(km.totalsByCategory[c.code])}</td>`).join("")}<td class="tot">${fmtKm(km.grandTotal)}</td></tr>
      ${odRows}</tbody></table></div>`;
    // ricavi: km × corrispettivo €/km, per categoria e totale
    let eurTable = "";
    if (rate > 0) {
      const eurRow = (label: string, byCat: Record<string, number>, tot: number, cls = "") =>
        `<tr class="${cls}"><td class="l">${label}</td>${cats.map(c => `<td>${fmtEur((byCat[c.code] || 0) * rate)}</td>`).join("")}<td class="tot">${fmtEur(tot * rate)}</td></tr>`;
      const odTot = km.onDemandTotalsByCategory ?? {};
      const combByCat: Record<string, number> = {};
      for (const c of cats) combByCat[c.code] = (km.totalsByCategory[c.code] || 0) + (odTot[c.code] || 0);
      const combTot = km.grandTotal + (km.onDemandGrandTotal || 0);
      eurTable = `<h3 class="eurh">Corrispettivo · € ${rate.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/km</h3>
        <div class="scroll"><table class="km eur"><thead><tr><th class="l">Voce</th>${catHead}<th class="tot">Totale</th></tr></thead>
        <tbody>
        ${eurRow("Programmato", km.totalsByCategory, km.grandTotal)}
        ${km.hasOnDemand ? eurRow("A chiamata (potenziale)", km.onDemandTotalsByCategory, km.onDemandGrandTotal, "od") : ""}
        ${km.hasOnDemand ? eurRow("Totale potenziale", combByCat, combTot, "sum") : ""}
        </tbody></table></div>`;
    }
    kmSection = `<section class="kmsum"><h2>Riepilogo km/anno${period}</h2>
      ${kmTable}
      ${eurTable}
      <p class="note">Km/anno stimati dal calendario aziendale${period}, contando i giorni di circolazione di ogni corsa (esclusi i prototipi; senza limitare al «Periodo» di validità della corsa).${km.hasOnDemand ? " I km a chiamata sono <strong>potenziali</strong>: conteggiati come se la corsa circolasse ogni giorno utile, ma erogati solo su richiesta." : ""}${rate > 0 ? " Il corrispettivo applica la tariffa €/km indicata sull'intero chilometraggio." : ""}</p>
    </section>`;
  }

  const now = new Date();
  const dateStr = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Elenco corse — ${esc(p.projectName)}</title>
<style>
  /* forza la stampa dei colori di sfondo (bollini verdi, chip categoria,
     intestazioni colorate): i browser altrimenti li omettono per default */
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #111827; margin: 18px; font-size: 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: baseline; }
  header h1 { font-size: 18px; margin: 0; }
  header .meta { color: #6b7280; font-size: 11px; }
  section.line { margin-bottom: 18px; break-inside: avoid; }
  h2 { font-size: 15px; margin: 14px 0 6px; border-bottom: 1px solid #d1d5db; padding-bottom: 3px; }
  h3 { font-size: 12.5px; margin: 10px 0 4px; color: #374151; }
  h3 .dir { color: #9ca3af; } .count { color: #9ca3af; font-weight: 400; font-size: 11px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 6px; }
  th, td { border: 1px solid #e5e7eb; padding: 3px 6px; text-align: left; vertical-align: middle; }
  th { background: #f3f4f6; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; color: #374151; }
  .c-dep { width: 70px; font-variant-numeric: tabular-nums; font-weight: 600; }
  .c-days { width: 190px; } .c-dem { width: 80px; text-align: center; }
  .dots { display: inline-flex; gap: 2px; }
  .dot { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%;
         background: #e5e7eb; color: #9ca3af; font-size: 9px; font-weight: 700; }
  .dot.on { background: #16a34a; color: #fff; }
  .cat { display: inline-block; border: 1px solid #cbd5e1; border-radius: 4px; padding: 1px 5px; font-size: 10px; margin: 1px 2px 1px 0; }
  .cat.chiuse em { font-style: normal; } .cat .per { font-weight: 600; }
  .muted { color: #9ca3af; }
  .swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  h2 .swatch { width: 10px; height: 10px; }
  section.kmsum { margin-bottom: 20px; break-inside: avoid; }
  .scroll { overflow-x: auto; }
  table.km td, table.km th { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.km td.l, table.km th.l { text-align: left; }
  table.km td.tot, table.km th.tot { font-weight: 700; background: #f9fafb; }
  table.km tr.sum td { font-weight: 700; background: #eef2ff; border-top: 2px solid #94a3b8; }
  table.km tr.grp td { text-align: left; background: #fff7ed; color: #9a3412; font-weight: 600; font-size: 10.5px; border-top: 2px solid #fdba74; }
  table.km tr.od td { color: #b45309; }
  table.km tr.sum.od td { background: #fff7ed; border-top: 1px solid #fdba74; color: #9a3412; }
  table.km.eur td.tot, table.km.eur tr.sum td { color: #065f46; }
  .kmsum h3.eurh { font-size: 12.5px; margin: 12px 0 4px; color: #065f46; }
  .note { color: #6b7280; font-size: 10px; margin: 2px 0 0; }
  @media print {
    body { margin: 0; }
    @page { margin: 12mm; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
</style></head><body>
<header><h1>Elenco corse</h1><div class="meta">${esc(p.projectName)} · ${dateStr} · ${p.routes.length} linee · ${p.trips.length} corse</div></header>
${kmSection}
${body || '<p class="muted">Nessuna corsa da stampare.</p>'}
</body></html>`;
}

export default function PlanningStudioTripsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  // Regia in diretta: corse appena toccate da Argos (righe evidenziate);
  // il rifetch dei dati lo fa ArgosLiveBridge invalidando le chiavi ["ps"].
  const argosFresh = useArgosFresh();

  /* ─── Queries ─── */
  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });
  const routesQ = useQuery({
    queryKey: ["ps", projectId, "routes"],
    queryFn: () => listPsRoutes(projectId),
    enabled: !!projectId,
  });
  const calendarsQ = useQuery({
    queryKey: ["ps", projectId, "calendars"],
    queryFn: () => listPsCalendars(projectId),
    enabled: !!projectId,
  });

  /* ─── Filtri ─── */
  const [routeId, setRouteId] = useState<string>("");
  const [variantId, setVariantId] = useState<string>("");
  // Filtro per CLASSE del Calendario Aziendale, a CASCATA: macrocategoria
  // (Scuole Aperte / Scuole Chiuse / Festività / Senza categoria) → periodo
  // (solo per Scuole Chiuse: Epifania, Estivo…) → tipo di giorno. Tre select
  // corti al posto di un albero piatto eterno.
  const [macroFilter, setMacroFilter] = useState<string>("");   // ''|aperte|chiuse|fest|none
  const [periodFilter, setPeriodFilter] = useState<string>(""); // id periodo chiuso | 'umbrella' | ''
  const [dayFilter, setDayFilter] = useState<string>("");       // ''|feriale|sabato|festivo
  const [onlyActive, setOnlyActive] = useState(false);

  // varianti dipendenti dalla route selezionata
  const variantsQ = useQuery({
    queryKey: ["ps", projectId, "variants", routeId],
    queryFn: () => listPsVariants(projectId, routeId),
    enabled: !!projectId && !!routeId,
  });
  // reset variant quando cambia route
  useEffect(() => { setVariantId(""); }, [routeId]);

  // Validità del CALENDARIO AZIENDALE (categorie globali: Scuole Aperte/Chiuse,
  // Festività…): servono al filtro a cascata qui sotto e alle azioni bulk.
  const categoriesQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
    enabled: true,
    staleTime: 60_000,
  });

  /* ─── Trips ─── */
  // La cascata si traduce così: il periodo filtra server-side (categoryId);
  // «Scuole Chiuse · tutti i periodi» e «Senza categoria» client-side sulle
  // categorie embedded; il tipo di giorno client-side sui dayTypeCodes.
  const classSel = useMemo(() => {
    const cats = categoriesQ.data ?? [];
    const idOf = (code: string) => cats.find(c => c.code === code)?.id ?? "";
    let catId = ""; let chiuseAny = false; let none = false;
    if (macroFilter === "aperte") catId = idOf("scuole_aperte");
    else if (macroFilter === "fest") catId = idOf("festivita");
    else if (macroFilter === "none") none = true;
    else if (macroFilter === "chiuse") {
      if (periodFilter === "umbrella") catId = idOf("scuole_chiuse");
      else if (periodFilter) catId = periodFilter;
      else chiuseAny = true;
    }
    // i giorni rossi sono comunque festivo: il taglio per giorno lì non ha senso
    return { catId, dayCode: macroFilter === "fest" ? "" : dayFilter, none, chiuseAny };
  }, [macroFilter, periodFilter, dayFilter, categoriesQ.data]);
  const tripsQ = useQuery({
    queryKey: ["ps", projectId, "trips", routeId, variantId, macroFilter, periodFilter],
    queryFn: () => listPsTrips(projectId, {
      routeId: routeId || undefined,
      variantId: variantId || undefined,
      categoryId: classSel.catId || undefined,
    }),
    enabled: !!projectId,
  });

  // first stop time per ogni trip → orario di partenza (per ordinamento e display)
  // Strategia: caricamento lazy via getPsStopTimes solo se filtrato a una variante
  // (altrimenti sarebbe pesante). Mostriamo il primo arrivo solo se variantId è set.
  const [firstTimes, setFirstTimes] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setFirstTimes({});
    if (!variantId || !tripsQ.data) return;
    const trips = tripsQ.data;
    let cancelled = false;
    (async () => {
      const acc: Record<string, string | null> = {};
      // batch sequenziale (limitiamo per non DDoS)
      for (const t of trips.slice(0, 200)) {
        if (cancelled) return;
        try {
          const sts = await getPsStopTimes(projectId, t.id);
          acc[t.id] = sts.length > 0 ? sts[0].departureTime : null;
        } catch { acc[t.id] = null; }
      }
      if (!cancelled) setFirstTimes(acc);
    })();
    return () => { cancelled = true; };
  }, [projectId, variantId, tripsQ.data]);

  const filteredTrips = useMemo(() => {
    let trips = tripsQ.data ?? [];
    // route/variant/periodo sono filtrati server-side (tripsQ); qui restano
    // "solo attive", il tipo di giorno della classe e il caso "senza categoria".
    if (onlyActive) trips = trips.filter(t => t.isActive);
    if (classSel.none) trips = trips.filter(t => (t.categories ?? []).length === 0);
    if (classSel.chiuseAny) trips = trips.filter(t => (t.categories ?? []).some(c => c.code?.startsWith("scuole_chiuse")));
    if (classSel.dayCode) trips = trips.filter(t => t.dayTypeCodes?.includes(classSel.dayCode));
    // ordina per orario partenza se disponibile (firstDeparture arriva già
    // dalla lista; firstTimes resta come fallback lazy), poi shortName/headsign
    return [...trips].sort((a, b) => {
      const ta = a.firstDeparture ?? firstTimes[a.id], tb = b.firstDeparture ?? firstTimes[b.id];
      if (ta && tb) return ta.localeCompare(tb);
      if (ta) return -1;
      if (tb) return 1;
      return (a.shortName || a.headsign || "").localeCompare(b.shortName || b.headsign || "");
    });
  }, [tripsQ.data, onlyActive, firstTimes, classSel]);

  /* ─── Ordinamento per colonna (clic sull'intestazione) ───
   * null = ordine naturale (partenza, poi nome): il terzo clic ci torna. */
  const [sort, setSort] = useState<TripSort>(null);
  const toggleSort = (key: TripSortKey) => setSort(cur =>
    !cur || cur.key !== key ? { key, dir: "asc" }
      : cur.dir === "asc" ? { key, dir: "desc" }
        : null);

  /* ─── Selezione bulk ─── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Selezione a blocco (Shift+clic), modello «gestore file»: l'ANCORA è
   * l'ultima spunta senza Shift e la BASE è com'era la selezione in quel
   * momento. Ogni Shift+clic ridisegna il blocco ancora→riga sopra la base:
   * così il blocco si allarga e si restringe muovendo il secondo estremo,
   * senza mai perdere le spunte fatte prima. */
  const selAnchorRef = useRef<number | null>(null);
  const selBaseRef = useRef<Set<string>>(new Set());
  function toggleSel(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  /** Spunta di riga: con SHIFT seleziona il BLOCCO dall'ancora a qui (nell'ordine
   * MOSTRATO, ordinamento per colonna compreso), altrimenti spunta singola. */
  function selectRowAt(idx: number, id: string, shift: boolean, rows: PsTrip[]) {
    const anchor = selAnchorRef.current;
    if (shift && anchor != null && anchor < rows.length) {
      const [a, b] = anchor <= idx ? [anchor, idx] : [idx, anchor];
      // base + blocco: ri-cliccando più su o più giù il blocco si ridisegna
      // (niente accumulo di righe rimaste indietro dal tentativo precedente).
      const next = new Set(selBaseRef.current);
      for (const t of rows.slice(a, b + 1)) next.add(t.id);
      setSelected(next);
      return; // l'ancora NON si sposta: si aggiusta solo il secondo estremo
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
    selAnchorRef.current = idx;
    selBaseRef.current = next; // da qui parte il prossimo blocco
  }
  function toggleAll() {
    selAnchorRef.current = null;
    selBaseRef.current = new Set();
    if (selected.size === filteredTrips.length) setSelected(new Set());
    else setSelected(new Set(filteredTrips.map(t => t.id)));
  }
  useEffect(() => {
    setSelected(new Set());
    selAnchorRef.current = null;
    selBaseRef.current = new Set();
  }, [routeId, variantId, macroFilter, periodFilter, dayFilter, onlyActive]);
  // Cambiando ordinamento gli indici di riga cambiano significato: l'ancora
  // vecchia produrrebbe un blocco a caso, quindi si riparte dalla prossima spunta.
  useEffect(() => { selAnchorRef.current = null; selBaseRef.current = new Set(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort]);

  const [newOpen, setNewOpen] = useState(false);
  const [newStart, setNewStart] = useState("07:00");
  const [newSpeed, setNewSpeed] = useState("18");   // km/h commerciale
  const [newDwell, setNewDwell] = useState("0");    // secondi di sosta per fermata
  const [newCalendarId, setNewCalendarId] = useState("");
  const [newDayTypeIds, setNewDayTypeIds] = useState<Set<string>>(new Set());
  const [newBusy, setNewBusy] = useState(false);

  /* ─── F1 · Corsa PROTOTIPO: grafo della linea con tempi per ARCO
   * (auto-calcolati e sovrascrivibili) e SOSTA per fermata. ─── */
  const newVariantQ = useQuery({
    queryKey: ["ps", projectId, "variant-proto", variantId],
    queryFn: () => getPsVariant(projectId, variantId),
    enabled: !!projectId && !!variantId,
    staleTime: 30_000,
  });
  const [newArcMin, setNewArcMin] = useState<number[]>([]);   // minuti per arco (editabili)
  const [newDwellS, setNewDwellS] = useState<number[]>([]);   // sosta in secondi per fermata

  /** Ricalcola i tempi d'arco dai km e dalla velocità di default. */
  function recalcArcDefaults(vStops: PsVariantStop[], speedKmh: number, dwellSec: number) {
    const cum = cumDistsOf(vStops);
    const mps = Math.max(1, speedKmh) * 1000 / 3600;
    const arcs: number[] = [];
    for (let i = 0; i < vStops.length - 1; i++) {
      const sec = (cum[i + 1] - cum[i]) / mps;
      arcs.push(Math.max(0.5, Math.round((sec / 60) * 10) / 10)); // ≥ 30s, precisione 0.1 min
    }
    setNewArcMin(arcs);
    setNewDwellS(vStops.map((_, i) => (i === 0 || i === vStops.length - 1 ? 0 : dwellSec)));
  }
  // Inizializza il grafo all'apertura del dialog (o al cambio variante)
  useEffect(() => {
    if (!newOpen) return;
    const vStops = newVariantQ.data?.stops ?? [];
    if (vStops.length < 2) return;
    if (newArcMin.length !== vStops.length - 1) {
      recalcArcDefaults(vStops, Number(newSpeed) || 18, Math.max(0, Math.round(Number(newDwell) || 0)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOpen, newVariantQ.data]);
  useEffect(() => { setNewArcMin([]); setNewDwellS([]); }, [variantId]);

  // Orari live del prototipo (arrivo/partenza per fermata)
  const protoTimes = useMemo(() => {
    const vStops = newVariantQ.data?.stops ?? [];
    if (vStops.length < 2 || newArcMin.length !== vStops.length - 1) return null;
    const start = genToSec(newStart + ":00");
    const arr: number[] = [start], dep: number[] = [start];
    for (let i = 1; i < vStops.length; i++) {
      arr.push(dep[i - 1] + Math.round((newArcMin[i - 1] || 0) * 60));
      dep.push(i === vStops.length - 1 ? arr[i] : arr[i] + Math.max(0, Math.round(newDwellS[i] || 0)));
    }
    return { arr, dep, totalMin: Math.round((arr[arr.length - 1] - start) / 60) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newVariantQ.data, newArcMin, newDwellS, newStart]);

  /* ─── Nuova corsa (la PRIMA della variante): orari calcolati da distanza
   * e velocità commerciale, poi diventa il template per la zona «Percorrenze».
   * Imposta anche i GIORNI di validità (trip-row-set nella matrice). ─── */
  const dayTypesQ = useQuery({
    queryKey: ["ps", projectId, "day-types"],
    queryFn: () => listPsDayTypes(projectId),
    enabled: !!projectId, // servono anche alle azioni bulk (proroga giorni)
  });
  const [newCategoryIds, setNewCategoryIds] = useState<Set<string>>(new Set());
  // preseleziona "feriale" alla prima apertura
  useEffect(() => {
    if (!newOpen || !dayTypesQ.data || newDayTypeIds.size > 0) return;
    const fer = dayTypesQ.data.find(d => d.code === "feriale");
    if (fer) setNewDayTypeIds(new Set([fer.id]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOpen, dayTypesQ.data]);

  async function runCreateFirstTrip() {
    if (!routeId || !variantId) { toast.error("Seleziona linea e variante"); return; }
    const vStops: PsVariantStop[] = newVariantQ.data?.stops ?? [];
    if (vStops.length < 2) { toast.error("La variante ha meno di 2 fermate: completa prima il percorso nell'editor"); return; }
    if (!protoTimes) { toast.error("Tempi del grafo non pronti"); return; }
    setNewBusy(true);
    try {
      // CORSA MADRE: il calcolatore definisce gli orari REALI di transito (all'ora
      // di partenza scelta). Il prototipo è ora pronto da moltiplicare con
      // «Percorrenze». Non genera km e resta escluso dalle UDP finché è
      // prototipo, ma NON è più una Corsa ZERO senza orario.
      const stopTimes = vStops.map((st, i) => ({
        stopId: st.stopId,
        arrivalTime: genSecToHms(protoTimes.arr[i]),
        departureTime: genSecToHms(protoTimes.dep[i]),
        timepoint: st.timepoint ?? 1,
      }));
      // Se la variante ha GIÀ un prototipo (Corsa ZERO creata da «Prototipi
      // mancanti»), lo si PROMUOVE in place a Corsa MADRE — niente doppioni.
      const existingProto = (tripsQ.data ?? []).find(t => t.variantId === variantId && t.attributes?.prototype);
      let tripId: string | undefined;
      if (existingProto) {
        await setPsStopTimes(projectId, existingProto.id, stopTimes.map(s => ({ stopId: s.stopId, arrivalTime: s.arrivalTime, departureTime: s.departureTime })));
        await updatePsTrip(projectId, existingProto.id, { calendarId: newCalendarId || null, attributesMerge: { prototype: true, prototypeReady: true } });
        tripId = existingProto.id;
      } else {
        const r = await batchCreatePsTrips(projectId, [{
          routeId, variantId,
          calendarId: newCalendarId || null,
          headsign: null, direction: 0,
          attributes: { prototype: true, prototypeReady: true }, // Corsa MADRE
          stopTimes,
        }]);
        tripId = r.tripIds?.[0];
      }
      // Giorni di validità (matrice): best-effort, non blocca la creazione.
      if (tripId) {
        try {
          if (newDayTypeIds.size > 0) {
            await postPsValidityBulk(projectId, { op: "trip-row-set", tripId, dayTypeIds: [...newDayTypeIds], isValid: true });
          }
          if (newCategoryIds.size > 0) {
            await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [tripId], categoryIds: [...newCategoryIds] });
          }
        } catch {
          toast.warning("Corsa creata, ma validità non impostate del tutto", { description: "Completa dalla Matrice di validità." });
        }
      }
      toast.success("✅ Corsa MADRE pronta", {
        description: `${vStops.length} fermate · giro ${protoTimes.totalMin} min · partenza ${newStart}. Ora moltiplicala nella zona «Percorrenze».`,
        duration: 8000,
      });
      setNewOpen(false);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    } catch (e: any) {
      toast.error("Creazione corsa fallita", { description: e?.message });
    } finally { setNewBusy(false); }
  }

  /* ─── Mutations ─── */
  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<PsTrip> & { attributesMerge?: Record<string, any> } }) =>
      updatePsTrip(projectId, id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] }),
    onError: (e: any) => toast.error(e?.message || "Errore aggiornamento"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deletePsTrip(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success("Corsa eliminata");
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });
  const bulkMut = useMutation({
    mutationFn: ({ patch }: { patch: any }) => bulkUpdatePsTrips(projectId, Array.from(selected), patch),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success(`${r.count} corse aggiornate`);
      setSelected(new Set());
    },
    onError: (e: any) => toast.error(e?.message || "Errore bulk"),
  });
  // Eliminazione in blocco delle corse selezionate (doppia conferma via modal)
  const [bulkDelOpen, setBulkDelOpen] = useState(false);
  const [bulkDelArmed, setBulkDelArmed] = useState(false);
  useEffect(() => { if (!bulkDelOpen) setBulkDelArmed(false); }, [bulkDelOpen]);
  const bulkDeleteMut = useMutation({
    mutationFn: () => bulkDeletePsTrips(projectId, Array.from(selected)),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      toast.success(`🗑 ${r.count} corse eliminate`);
      setSelected(new Set());
      setBulkDelOpen(false);
    },
    onError: (e: any) => toast.error(e?.message || "Errore eliminazione"),
  });

  /* ─── Prototipi automatici per i percorsi senza corse ───
   * Crea una Corsa ZERO per ogni variante con ≥2 fermate e nessuna corsa, così
   * si può ripartire dalla zona «Percorrenze». Se è filtrata una singola variante
   * agisce solo su quella; altrimenti su tutto il progetto. */
  const protoMissingMut = useMutation({
    mutationFn: () => prototypeMissingPsTrips(projectId, variantId ? { variantIds: [variantId] } : {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      if (r.created === 0) {
        toast.info("Nessun prototipo creato", { description: "Tutti i percorsi (con ≥2 fermate) hanno già almeno una corsa." });
      } else {
        toast.success(`✅ ${r.created} prototipi creati`, {
          description: "Una Corsa ZERO per ogni percorso che era senza corse. Ora crea le corse reali dalla zona «Percorrenze».",
          duration: 8000,
        });
      }
    },
    onError: (e: any) => toast.error("Creazione prototipi fallita", { description: e?.message }),
  });

  /* ─── Giorni + categorie di TUTTE le corse visibili (colonne di riga) ─── */
  const tripsValQ = useQuery({
    queryKey: ["ps", projectId, "trips", "validity-bulk", filteredTrips.map(t => t.id).join(",")],
    queryFn: () => getPsTripsValidityBulk(projectId, filteredTrips.map(t => t.id)),
    enabled: filteredTrips.length > 0,
    staleTime: 15_000,
  });
  const dtKinds = useMemo(() => classifyDayTypes(dayTypesQ.data ?? []), [dayTypesQ.data]);
  const catById = useMemo(() => {
    const m = new Map<string, PsValidityCategory>();
    for (const c of categoriesQ.data ?? []) m.set(c.id, c);
    return m;
  }, [categoriesQ.data]);
  /** calendarId → pattern settimanale L…D (fallback per la maschera corsa). */
  const calWdById = useMemo(() => {
    const m = new Map<string, boolean[]>();
    for (const c of calendarsQ.data ?? []) m.set(c.id, calWeekdays(c)!);
    return m;
  }, [calendarsQ.data]);
  const rowMask = (trip: PsTrip): boolean[] =>
    wdMaskOf(trip, trip.calendarId ? calWdById.get(trip.calendarId) : null);
  /** Righe di matrice della corsa (null se la matrice non la conosce). */
  const matrixOf = (tripId: string): Record<string, boolean> | null => {
    const dv = tripsValQ.data?.dayValidity?.[tripId];
    return dv && Object.keys(dv).length > 0 ? dv : null;
  };
  /** Maschera settimanale di PARTENZA (display e staging): la esplicita è un
   *  veto reale e vince; con la MATRICE presente il pattern del calendario
   *  NON è un veto (la validità effettiva e la materializzazione lo ignorano:
   *  un template feriale non deve spegnere la D di corse bollinate festivo)
   *  → tutti i giorni aperti, decide la matrice; senza matrice, il ripiego
   *  calendario di sempre. */
  const rowSeedMask = (trip: PsTrip): boolean[] => {
    const w = (trip.attributes as any)?.weekdays;
    if (Array.isArray(w) && w.length === 7) return w.map((x: any) => x !== false);
    if (matrixOf(trip.id)) return [true, true, true, true, true, true, true];
    return rowMask(trip);
  };
  /** Il giorno i è attivo per la corsa? Stessa semantica della validità
   *  EFFETTIVA (isTripActiveOnDate): con la matrice presente, un tipo-giorno
   *  SENZA riga valida NON circola (prima `!== false` lo mostrava acceso —
   *  e il calendario del template spegneva giorni che la matrice accendeva:
   *  è il caso «non vedo la D» visto in produzione sulle festive generate). */
  function rowDayOn(trip: PsTrip, i: number): boolean {
    const p = pendingOps.get(trip.id);
    const mask = p?.weekdays ?? rowSeedMask(trip);
    if (!mask[i]) return false;                       // veto esplicito (o ripiego senza matrice)
    const dv = matrixOf(trip.id);
    if (!dv) return true;                             // nessuna riga in Matrice → circolazione settimanale
    const dt = dtKinds[wdTypicalCode(i)];
    if (!dt) return true;                             // tipo-giorno non classificabile → circola
    if (p?.dayTypeOn?.includes(dt.id)) return true;   // riaccensione in sospeso
    return dv[dt.id] === true;                        // assente o false = NON valido (come l'effettiva)
  }
  /* ─── MODIFICHE STAGED (pattern del TTD): le modifiche inline della tabella
   * (pillole giorni, etichetta, a chiamata, attiva) NON partono più come PATCH
   * immediati — si accumulano qui e si applicano con "Salva modifiche", con
   * "Annulla" per scartarle. Le azioni strutturali (crea/elimina/copia/genera)
   * e il drawer di dettaglio restano immediati. ─── */
  interface PendingTripEdit {
    serviceLabel?: string | null;
    isActive?: boolean;
    onDemand?: boolean;
    weekdays?: boolean[];
    /** day-type da riaccendere in matrice (trip-row-set) al salvataggio */
    dayTypeOn?: string[];
  }
  const [pendingOps, setPendingOps] = useState<Map<string, PendingTripEdit>>(new Map());
  const [savingOps, setSavingOps] = useState(false);
  const pend = (tripId: string) => pendingOps.get(tripId);
  const stage = (tripId: string, patch: Partial<PendingTripEdit>) =>
    setPendingOps(prev => {
      const next = new Map(prev);
      const cur = next.get(tripId) ?? {};
      const merged: PendingTripEdit = { ...cur, ...patch };
      if (patch.dayTypeOn) merged.dayTypeOn = [...new Set([...(cur.dayTypeOn ?? []), ...patch.dayTypeOn])];
      next.set(tripId, merged);
      return next;
    });
  // Valori EFFETTIVI mostrati in tabella: salvato + modifica in sospeso
  const effServiceLabel = (t: PsTrip) => {
    const p = pend(t.id);
    return p && p.serviceLabel !== undefined ? p.serviceLabel : (t.serviceLabel ?? null);
  };
  const effActive = (t: PsTrip) => pend(t.id)?.isActive ?? t.isActive;
  const effOnDemand = (t: PsTrip) => pend(t.id)?.onDemand ?? !!t.attributes?.onDemand;


  async function saveAllPending() {
    if (pendingOps.size === 0 || savingOps) return;
    setSavingOps(true);
    let ok = 0, ko = 0;
    for (const [tripId, p] of pendingOps) {
      try {
        if (p.dayTypeOn?.length) {
          await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [tripId], dayTypeIds: p.dayTypeOn, isValid: true });
        }
        const patch: any = {};
        if (p.serviceLabel !== undefined) patch.serviceLabel = p.serviceLabel;
        if (p.isActive !== undefined) patch.isActive = p.isActive;
        const am: Record<string, any> = {};
        if (p.onDemand !== undefined) am.onDemand = p.onDemand;
        if (p.weekdays !== undefined) am.weekdays = p.weekdays;
        if (Object.keys(am).length > 0) patch.attributesMerge = am;
        if (Object.keys(patch).length > 0) await updatePsTrip(projectId, tripId, patch);
        ok++;
      } catch { ko++; }
    }
    setPendingOps(new Map());
    setSavingOps(false);
    qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
    qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
    if (ko === 0) toast.success(`${ok} cors${ok === 1 ? "a aggiornata" : "e aggiornate"}`);
    else toast.warning(`${ok} corse aggiornate · ${ko} errori`, { description: "Ricontrolla le righe non salvate." });
  }

  /** Toggle di un giorno dalla riga: SOLO staging, nessuna scrittura. */
  function toggleRowWeekday(trip: PsTrip, i: number) {
    if (!tripsValQ.data || !dayTypesQ.data) return;
    const p = pend(trip.id);
    const mask = p?.weekdays ?? rowSeedMask(trip);
    const newWd = [...mask];
    const patch: Partial<PendingTripEdit> = {};
    if (rowDayOn(trip, i)) {
      newWd[i] = false; // spegni SOLO questo giorno
    } else {
      newWd[i] = true;
      const dt = dtKinds[wdTypicalCode(i)];
      const dv = tripsValQ.data.dayValidity?.[trip.id] ?? {};
      const alreadyStaged = p?.dayTypeOn?.includes(dt?.id ?? "") ?? false;
      if (dt && !dv[dt.id] && !alreadyStaged) {
        for (let j = 0; j < 7; j++) {
          if (j !== i && wdTypicalCode(j) === wdTypicalCode(i) && !rowDayOn(trip, j)) newWd[j] = false;
        }
        patch.dayTypeOn = [dt.id];
      }
    }
    patch.weekdays = newWd;
    stage(trip.id, patch);
  }

  /* ─── Drawer dettaglio corsa ─── */
  const [detailTripId, setDetailTripId] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const detailTrip = useMemo(
    () => filteredTrips.find(t => t.id === detailTripId) ?? null,
    [detailTripId, filteredTrips],
  );
  const [copyTripId, setCopyTripId] = useState<string | null>(null);
  const copyTrip = useMemo(
    () => filteredTrips.find(t => t.id === copyTripId) ?? null,
    [copyTripId, filteredTrips],
  );
  /* Unifica corse gemelle: anteprima (dryRun) + applica */
  const [mergePreview, setMergePreview] = useState<MergeTwinsResult | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  async function openMergePreview() {
    setMergeBusy(true);
    try {
      const r = await mergePsTwins(projectId, { dryRun: true, routeId: routeId || undefined });
      if (r.removed === 0) { toast.info("Nessuna corsa gemella", { description: "Non ci sono corse identiche (stesso percorso, orari e headsign) da unificare." }); return; }
      setMergePreview(r);
    } catch (e: any) { toast.error("Errore anteprima", { description: e?.message }); }
    finally { setMergeBusy(false); }
  }
  async function applyMerge() {
    setMergeBusy(true);
    try {
      const r = await mergePsTwins(projectId, { dryRun: false, routeId: routeId || undefined });
      toast.success("Corse gemelle unificate", { description: `${r.removed} corse fuse · ${r.tripsAfter} corse totali` });
      setMergePreview(null);
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "calendars"] });
    } catch (e: any) { toast.error("Errore unificazione", { description: e?.message }); }
    finally { setMergeBusy(false); }
  }

  /* ─── Stampa elenco corse ─── */
  const [printOpen, setPrintOpen] = useState(false);
  const [printSel, setPrintSel] = useState<Set<string>>(new Set());
  const [printBusy, setPrintBusy] = useState(false);
  const [printRate, setPrintRate] = useState("");   // corrispettivo €/km
  async function runPrintCorse() {
    const routeIds = [...printSel];
    if (routeIds.length === 0) { toast.error("Seleziona almeno una linea"); return; }
    setPrintBusy(true);
    try {
      const allTrips = await listPsTrips(projectId);
      const trips = allTrips.filter(t => routeIds.includes(t.routeId) && !t.attributes?.prototype && (!onlyActive || t.isActive));
      if (trips.length === 0) { toast.info("Nessuna corsa da stampare per le linee scelte"); return; }
      const [val, km] = await Promise.all([
        getPsTripsValidityBulk(projectId, trips.map(t => t.id)),
        getPsCorseKm(projectId, routeIds).catch(() => null),
      ]);
      const variantById = new Map<string, PsVariant>();
      const vlists = await Promise.all(routeIds.map(rid => listPsVariants(projectId, rid).catch(() => [] as PsVariant[])));
      for (const vs of vlists) for (const v of vs) variantById.set(v.id, v);
      const selRoutes = (routesQ.data ?? []).filter(r => routeIds.includes(r.id));
      const calWd = new Map<string, boolean[]>();
      for (const c of calendarsQ.data ?? []) { const m = calWeekdays(c); if (m) calWd.set(c.id, m); }
      const html = buildCorseListHtml({
        projectName: projectQ.data?.name ?? "Planner Studio",
        routes: selRoutes, trips, variantById,
        dayValidity: val.dayValidity ?? {}, categoriesByTrip: val.categories ?? {},
        catById, dtKinds, calWdById: calWd, km,
        rate: Number(String(printRate).replace(",", ".")) || 0,
      });
      const w = window.open("", "_blank");
      if (!w) { toast.error("Consenti i popup per stampare"); return; }
      w.document.write(html); w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* utente stampa a mano */ } }, 400);
      setPrintOpen(false);
    } catch (e: any) { toast.error("Stampa non riuscita", { description: e?.message }); }
    finally { setPrintBusy(false); }
  }

  /* ─── Render ─── */
  const project = projectQ.data;
  const routes = routesQ.data ?? [];
  const variants = variantsQ.data ?? [];

  /* ─── Righe ORDINATE per la colonna scelta ───
   * Ordina i valori EFFETTIVI (quelli mostrati, modifiche in sospeso comprese)
   * e lascia in fondo i vuoti in entrambi i versi: le corse senza orario o
   * senza periodo non devono coprire quelle buone in cima. Confronto naturale
   * (numerico) sui nomi linea, così 2 < 10 < 44 e non "10" < "2".
   * Senza colonna scelta resta l'ordine naturale di filteredTrips. */
  const sortedTrips = useMemo(() => {
    if (!sort) return filteredTrips;
    const dir = sort.dir === "asc" ? 1 : -1;
    const catsOf = (t: PsTrip) => (tripsValQ.data?.categories?.[t.id] ?? [])
      .map(cid => catById.get(cid)?.name ?? "").filter(Boolean).sort().join(", ");
    /** Chiave di confronto della colonna: stringa, numero o null (= vuoto). */
    const keyOf = (t: PsTrip): string | number | null => {
      switch (sort.key) {
        case "partenza": return t.firstDeparture ?? firstTimes[t.id] ?? null;
        case "linea": {
          const r = routes.find(x => x.id === t.routeId);
          const v = variants.find(x => x.id === t.variantId);
          return `${r?.shortName ?? ""} ${v?.code ?? ""} ${v?.name ?? ""}`.trim() || null;
        }
        case "headsign": return t.headsign || variants.find(v => v.id === t.variantId)?.headsign || null;
        case "giorni": return WD_LABELS_ROW.reduce((n, _l, i) => n + (rowDayOn(t, i) ? 1 : 0), 0);
        case "categorie": return catsOf(t) || null;
        case "periodo": return t.validFrom || t.validTo || null;
        case "etichetta": return effServiceLabel(t) || null;
        case "chiamata": return effOnDemand(t) ? 0 : 1;   // a chiamata prima in asc
        case "stato": return effActive(t) ? 0 : 1;        // attive prima in asc
        default: return null;
      }
    };
    return [...filteredTrips]
      .map((t, i) => ({ t, i, k: keyOf(t) }))
      .sort((a, b) => {
        // I vuoti restano in fondo in ENTRAMBI i versi: le corse senza orario
        // o senza periodo non devono coprire quelle buone quando si inverte.
        if (a.k === null && b.k === null) return a.i - b.i;
        if (a.k === null) return 1;
        if (b.k === null) return -1;
        const c = typeof a.k === "number" && typeof b.k === "number"
          ? a.k - b.k
          : String(a.k).localeCompare(String(b.k), "it", { numeric: true, sensitivity: "base" });
        return c !== 0 ? c * dir : a.i - b.i; // parità: ordine naturale, sort stabile
      })
      .map(x => x.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTrips, sort, firstTimes, routes, variants, tripsValQ.data, catById, pendingOps]);
  const calendars = calendarsQ.data ?? [];

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-slate-950 text-slate-100">
      {project?.isOperational && (
        <div className="px-3 pt-3"><OperationalEditWarning isOperational projectName={project?.name} /></div>
      )}
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <Bus className="w-5 h-5 text-amber-400" />
          <h1 className="font-semibold text-sm">Corse</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name} ·{" "}
            <span className="text-slate-400">
              {filteredTrips.length} corse {tripsQ.data && filteredTrips.length !== tripsQ.data.length && `(di ${tripsQ.data.length})`}
            </span>
          </span>
        )}
        <span className="ml-2"><TripCountBadge projectId={projectId} /></span>
      </div>
      <PsProjectNav projectId={projectId} active="trips" />
      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />

      {/* Barra modifiche in sospeso (pattern del TTD): niente si scrive finché
          non premi Salva; Annulla scarta tutto. */}
      {pendingOps.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-sky-500/40 bg-slate-900/95 backdrop-blur shadow-2xl shadow-sky-950/40">
          <span className="text-xs text-sky-200 font-medium">
            {pendingOps.size} cors{pendingOps.size === 1 ? "a" : "e"} con modifiche non salvate
          </span>
          <button
            onClick={() => setPendingOps(new Map())}
            disabled={savingOps}
            className="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            ↶ Annulla
          </button>
          <button
            onClick={() => void saveAllPending()}
            disabled={savingOps}
            className="text-xs font-semibold px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white flex items-center gap-1.5 disabled:opacity-60"
          >
            {savingOps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Salva modifiche
          </button>
        </div>
      )}

      {/* Filtri (flex-wrap: con le azioni bulk attive va a capo invece di uscire dallo schermo) */}
      <div className="min-h-12 border-b border-slate-800 bg-slate-900/40 px-4 py-1.5 flex items-center gap-3 text-xs flex-wrap">
        <Filter className="w-3.5 h-3.5 text-slate-500" />
        <select
          value={routeId} onChange={e => setRouteId(e.target.value)}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[160px]"
        >
          <option value="">Tutte le linee</option>
          {routes.map(r => (
            <option key={r.id} value={r.id}>{r.shortName} {r.longName ? `· ${r.longName}` : ""}</option>
          ))}
        </select>

        <select
          value={variantId} onChange={e => setVariantId(e.target.value)}
          disabled={!routeId}
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 min-w-[160px] disabled:opacity-40"
        >
          <option value="">Tutte le varianti</option>
          {variants.map(v => (
            <option key={v.id} value={v.id}>{(v as any).code ? `${(v as any).code} · ` : ""}{v.name} ({v.direction === 0 ? "→" : "←"})</option>
          ))}
        </select>

        {/* Filtro a CASCATA per classe del Calendario Aziendale:
            macrocategoria → periodo (solo Scuole Chiuse) → tipo di giorno. */}
        <select
          value={macroFilter}
          onChange={e => { setMacroFilter(e.target.value); setPeriodFilter(""); }}
          title="Macrocategoria del Calendario Aziendale"
          className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700"
        >
          <option value="">Tutte le classi (Cal. Aziendale)</option>
          <option value="aperte">Scuole Aperte</option>
          <option value="chiuse">Scuole Chiuse</option>
          <option value="fest">Festività (giorni rossi)</option>
          <option value="none">Senza categoria (vale in ogni periodo)</option>
        </select>
        {macroFilter === "chiuse" && (
          <select
            value={periodFilter} onChange={e => setPeriodFilter(e.target.value)}
            title="Periodo di scuole chiuse"
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700"
          >
            <option value="">Tutti i periodi</option>
            {[...(categoriesQ.data ?? [])]
              .filter(c => c.code?.startsWith("scuole_chiuse_"))
              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "it"))
              .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="umbrella">Ombrello (corse valide in ogni periodo chiuso)</option>
          </select>
        )}
        {macroFilter !== "fest" && (
          <select
            value={dayFilter} onChange={e => setDayFilter(e.target.value)}
            title="Tipo di giorno (bollini di validità)"
            className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700"
          >
            <option value="">Tutti i giorni</option>
            <option value="feriale">Feriale</option>
            <option value="sabato">Sabato</option>
            <option value="festivo">Domenica e festivi</option>
          </select>
        )}

        <label className="flex items-center gap-1.5 text-slate-400">
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)}
            className="accent-amber-500" />
          Solo attive
        </label>

        <button
          onClick={() => {
            if (!variantId) { toast.info("Seleziona linea e variante", { description: "La corsa si crea sul percorso (variante) scelto." }); return; }
            setNewOpen(true);
          }}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
          title="Crea la prima corsa della variante: orari alle fermate calcolati da distanza e velocità commerciale"
        >
          <Plus className="w-3.5 h-3.5" /> Nuova corsa
        </button>
        {/* La cadenza e i tempi dal traffico vivono nella zona PERCORRENZE:
            questo link ci arriva con linea/variante (e template spuntato)
            già preselezionati. */}
        <Link href={(() => {
          const q = new URLSearchParams();
          if (routeId) q.set("route", routeId);
          if (variantId) q.set("variant", variantId);
          if (selected.size > 0) {
            const sel = filteredTrips.filter(t => selected.has(t.id));
            const tpl = sel.find(t => t.attributes?.prototype) ?? (sel.length === 1 ? sel[0] : null);
            if (tpl) q.set("template", tpl.id);
          } else {
            const proto = filteredTrips.find(t => t.attributes?.prototype);
            if (proto) q.set("template", proto.id);
          }
          const qs = q.toString();
          return `/planning-studio/${projectId}/percorrenze${qs ? `?${qs}` : ""}`;
        })()}>
          <button
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 text-white hover:bg-amber-500 transition-colors"
            title="Apre la zona Percorrenze: genera la cadenza da una corsa base o ricalcola le percorrenze dai dati di traffico"
          >
            <Timer className="w-3.5 h-3.5" /> Percorrenze / cadenza
          </button>
        </Link>
        <button
          onClick={openMergePreview}
          disabled={mergeBusy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 text-slate-100 hover:bg-slate-600 transition-colors disabled:opacity-50"
          title="Unifica le corse gemelle (stessa variante, stessi orari a tutte le fermate, stesso headsign) in una sola corsa con validità unione. Anteprima prima di applicare."
        >
          {mergeBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Merge className="w-3.5 h-3.5" />} Unifica gemelle
        </button>
        <button
          onClick={() => setConfirmReq({
            title: "Creare i prototipi mancanti (Corsa ZERO)?",
            variant: "primary",
            message: (
              <>
                Ambito: <b>{variantId ? "il percorso selezionato" : "TUTTI i percorsi del progetto"}</b> senza corse.
                Per ognuno viene creata una corsa senza orario reale, con i tempi di percorrenza
                calcolati dalle distanze — il template per la zona «Percorrenze».
              </>
            ),
            confirmLabel: "Crea prototipi",
            onConfirm: () => { protoMissingMut.mutate(); },
          })}
          disabled={protoMissingMut.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
          title="Crea una Corsa ZERO (prototipo) per ogni percorso senza corse: utile quando hai i percorsi ma non le corse (es. GTFS importato e corse cancellate). Poi genera le corse reali dalla zona «Percorrenze»."
        >
          {protoMissingMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />} Prototipi mancanti
        </button>
        <button
          onClick={() => { setPrintSel(new Set((routesQ.data ?? []).map(r => r.id))); setPrintOpen(true); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 text-slate-100 hover:bg-slate-600 transition-colors"
          title="Stampa l'elenco delle corse delle linee scelte: diviso per linea e codice percorso, con giorni di validità, categorie e a chiamata."
        >
          <Printer className="w-3.5 h-3.5" /> Stampa elenco
        </button>

        <div className="flex-1" />

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-amber-500/10 border border-amber-500/30">
            <span className="text-amber-300 font-medium">{selected.size} selezionate</span>
            <span className="text-[10px] text-amber-200/60" title="Spunta una corsa, poi tieni SHIFT e spunta un'altra riga: tutte quelle in mezzo (nell'ordine mostrato) entrano nella selezione. Ri-cliccando con SHIFT più su o più giù il blocco si ridisegna, senza perdere le spunte fatte prima.">
              Shift+clic = blocco
            </span>
            <button
              onClick={() => bulkMut.mutate({ patch: { isActive: true } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1"
              title="Attiva selezionate"
            >
              <Power className="w-3 h-3" /> Attiva
            </button>
            <button
              onClick={() => bulkMut.mutate({ patch: { isActive: false } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white flex items-center gap-1"
              title="Disattiva selezionate"
            >
              <PowerOff className="w-3 h-3" /> Disattiva
            </button>
            {selected.size === 1 && (
              <button
                onClick={() => setCopyTripId([...selected][0])}
                disabled={bulkMut.isPending}
                className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white flex items-center gap-1"
                title="Crea una copia della corsa: scegli orario di partenza, periodo, giorni e categorie"
              >
                <Copy className="w-3 h-3" /> Crea copia
              </button>
            )}
            <BulkValiditySetter
              onApply={(vf, vt) => bulkMut.mutate({ patch: { validFrom: vf || null, validTo: vt || null } })}
              disabled={bulkMut.isPending}
            />
            <BulkDaysCatsSetter
              dayTypes={dayTypesQ.data ?? []}
              categories={categoriesQ.data ?? []}
              disabled={bulkMut.isPending}
              onApplyDays={async (dayTypeIds, isValid) => {
                try {
                  await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [...selected], dayTypeIds, isValid });
                  toast.success(isValid ? "Giorni aggiunti alle corse selezionate" : "Giorni tolti dalle corse selezionate");
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
                } catch (e: any) { toast.error("Errore", { description: e?.message }); }
              }}
              onApplyCats={async (categoryIds, mode) => {
                try {
                  await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [...selected], categoryIds, mode });
                  toast.success(mode === "add" ? "Categorie aggiunte (proroga)" : "Categorie sostituite");
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
                  qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
                } catch (e: any) { toast.error("Errore", { description: e?.message }); }
              }}
            />
            <button
              onClick={() => bulkMut.mutate({ patch: { attributesMerge: { onDemand: true } } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white flex items-center gap-1"
              title="Segna le corse selezionate come A CHIAMATA (su prenotazione)"
            >
              📞 A chiamata
            </button>
            <button
              onClick={() => bulkMut.mutate({ patch: { attributesMerge: { onDemand: false } } })}
              disabled={bulkMut.isPending}
              className="px-2 py-1 rounded border border-purple-500/40 text-purple-300 hover:bg-purple-500/10 flex items-center gap-1"
              title="Rendi ordinarie le corse selezionate (toglie A chiamata)"
            >
              ordinaria
            </button>
            <button
              onClick={() => setBulkDelOpen(true)}
              disabled={bulkDeleteMut.isPending}
              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white flex items-center gap-1"
              title="Elimina le corse selezionate"
            >
              <Trash2 className="w-3 h-3" /> Elimina
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="p-1 rounded hover:bg-slate-700 text-slate-400"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Tabella */}
      <div className="flex-1 overflow-auto">
        {tripsQ.isLoading && (
          <div className="p-6 text-slate-500 text-sm flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Caricamento corse…
          </div>
        )}
        {!tripsQ.isLoading && filteredTrips.length === 0 && (
          <div className="p-12 text-center text-slate-500 text-sm">
            {variantId
              ? <>Nessuna corsa per questa variante. <strong>Creane una con «➕ Nuova corsa»</strong> (orari calcolati automaticamente), poi moltiplicala con «⏱ Percorrenze / cadenza» e imposta i giorni nella Matrice di validità.</>
              : <>Nessuna corsa trovata con i filtri attuali. Seleziona una linea e una variante per creare corse.</>}
          </div>
        )}
        {filteredTrips.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 border-b border-slate-800 z-10">
              <tr className="text-slate-400">
                <th className="p-2 w-8 text-left">
                  <input type="checkbox"
                    checked={selected.size === filteredTrips.length && filteredTrips.length > 0}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < filteredTrips.length; }}
                    onChange={toggleAll}
                    className="accent-amber-500" />
                </th>
                <SortTh label="Partenza" sortKey="partenza" sort={sort} onToggle={toggleSort} />
                <SortTh label="Linea / Variante" sortKey="linea" sort={sort} onToggle={toggleSort}
                  title="Ordina per linea, poi codice percorso e nome variante (2 prima di 10)" />
                <SortTh label="Headsign" sortKey="headsign" sort={sort} onToggle={toggleSort} />
                <SortTh label="Giorni validità" sortKey="giorni" sort={sort} onToggle={toggleSort}
                  title="Giorni della settimana in cui la corsa è valida: clic sul giorno per accendere/spegnere. L'ordinamento usa il NUMERO di giorni attivi" />
                <SortTh label="Categorie" sortKey="categorie" sort={sort} onToggle={toggleSort}
                  title="Categorie del calendario aziendale attive sulla corsa (nessuna = vale sempre)" />
                <SortTh label="Periodo" sortKey="periodo" sort={sort} onToggle={toggleSort}
                  title="Periodo di esistenza della corsa (vuoto = illimitata, resta in fondo)" />
                <SortTh label="Etichetta" sortKey="etichetta" sort={sort} onToggle={toggleSort} />
                <SortTh label="A chiam." sortKey="chiamata" sort={sort} onToggle={toggleSort} align="center" className="w-16"
                  title="Corsa effettuata solo su prenotazione (servizio a chiamata / DRT)" />
                <SortTh label="Stato" sortKey="stato" sort={sort} onToggle={toggleSort} align="center" className="w-16"
                  title="Attiva o disattivata" />
                <th className="p-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {sortedTrips.map((t, rowIdx) => {
                const route = routes.find(r => r.id === t.routeId);
                const variant = variants.find(v => v.id === t.variantId);
                const isSel = selected.has(t.id);
                const tripCats = tripsValQ.data?.categories?.[t.id] ?? [];
                return (
                  <tr key={t.id} className={`border-b border-slate-800/60 hover:bg-slate-900/50 ${
                    isSel ? "bg-amber-500/5" : ""
                  } ${t.attributes?.prototype ? (t.attributes?.prototypeReady ? "bg-violet-500/10" : "bg-amber-500/10") : ""} ${!effActive(t) ? "opacity-50" : ""} ${
                    pendingOps.has(t.id) ? "ring-1 ring-inset ring-sky-500/40 bg-sky-500/5" : ""
                  } ${
                    // Regia in diretta: la corsa è stata appena toccata da Argos
                    argosFresh.trips.has(t.id) ? "ring-1 ring-inset ring-violet-400/60 bg-violet-500/10 animate-pulse" : ""
                  }`}>
                    <td className="p-2">
                      {/* onClick (non onChange): serve il tasto SHIFT dell'evento
                          per la selezione a blocco. */}
                      <input type="checkbox" checked={isSel} readOnly
                        onClick={(e) => selectRowAt(rowIdx, t.id, e.shiftKey, sortedTrips)}
                        title="Clic = spunta la corsa · Shift+clic = seleziona il blocco dall'ultima spunta fino a qui (ri-clicca più su o più giù per aggiustarlo)"
                        className="accent-amber-500 cursor-pointer" />
                    </td>
                    <td className="p-2 font-mono text-slate-300">
                      {t.attributes?.prototype ? (
                        t.attributes?.prototypeReady ? (
                          <span
                            title="CORSA MADRE: prototipo con orari reali, pronto da moltiplicare nella zona «Percorrenze». Non genera km e NON entra nelle UDP."
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-500/20 border border-violet-500/50 text-violet-300 text-[10px] font-bold not-italic">
                            ★ MADRE
                          </span>
                        ) : (
                          <span
                            title="CORSA ZERO (prototipo): nessun orario, solo tempi per arco, durata e validità. Inserisci i transiti alle fermate per promuoverla a Corsa MADRE."
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/50 text-amber-300 text-[10px] font-bold not-italic">
                            ⚠ ZERO
                          </span>
                        )
                      ) : fmtTime(t.firstDeparture ?? firstTimes[t.id])}
                    </td>
                    <td className="p-2">
                      <div className="font-medium text-slate-200">{route?.shortName || "?"}</div>
                      <div className="text-[10px] text-slate-500">
                        {/* Il CODICE PERCORSO della variante viaggia con la corsa */}
                        {variant?.code && <span className="font-bold text-violet-300">{variant.code}</span>}
                        {variant?.code ? " · " : ""}{variant?.name || ""}
                      </div>
                    </td>
                    <td className="p-2 text-slate-300">{t.headsign || variant?.headsign || "—"}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-[3px]">
                        {WD_LABELS_ROW.map((l, i) => {
                          const on = rowDayOn(t, i);
                          return (
                            <button key={i}
                              onClick={() => toggleRowWeekday(t, i)}
                              disabled={tripsValQ.isLoading}
                              title={`${WD_NAMES[i]} — ${on ? "attivo (clic per spegnere)" : "spento (clic per accendere)"}`}
                              className={`w-[18px] h-[18px] rounded-full text-[9px] font-bold border leading-none transition-colors disabled:opacity-50 ${
                                on
                                  ? "bg-emerald-500/25 border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/40"
                                  : "bg-slate-800 border-slate-700 text-slate-600 hover:bg-slate-700"
                              }`}>
                              {l}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-2">
                      {tripCats.length === 0
                        ? <span className="px-1.5 py-0.5 rounded text-[9px] border border-slate-700 text-slate-500 whitespace-nowrap"
                            title="Nessuna categoria: la corsa vale in ogni periodo del calendario aziendale">tutti i periodi</span>
                        : (() => {
                            // UN badge per OGNI categoria della corsa, coi colori
                            // dell'anagrafica del calendario aziendale (ombrello
                            // «Scuole Chiuse» compreso: prima veniva nascosto).
                            const cats = (tripCats.map(cid => catById.get(cid)).filter(Boolean) as PsValidityCategory[])
                              .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, "it"));
                            return (
                              <div className="flex flex-wrap items-center gap-1 max-w-[190px]">
                                {cats.map(c => (
                                  <span key={c.id} title={c.name}
                                    className="px-1.5 py-0.5 rounded text-[9px] font-medium border whitespace-nowrap"
                                    style={{ borderColor: c.color || "#3b82f6", background: `${c.color || "#3b82f6"}22` }}>
                                    {c.name.length > 14 ? c.name.slice(0, 13) + "…" : c.name}
                                  </span>
                                ))}
                              </div>
                            );
                          })()}
                    </td>
                    <td className="p-2 text-slate-400">
                      {t.validFrom || t.validTo
                        ? <span className="whitespace-nowrap">{fmtDate(t.validFrom)} → {fmtDate(t.validTo)}</span>
                        : <span className="text-slate-600">illimitato</span>}
                    </td>
                    <td className="p-2">
                      <input
                        key={`${t.id}:${effServiceLabel(t) ?? ""}`}
                        defaultValue={effServiceLabel(t) || ""}
                        onBlur={(e) => {
                          if (e.target.value !== (effServiceLabel(t) || "")) {
                            stage(t.id, { serviceLabel: e.target.value || null });
                          }
                        }}
                        placeholder="—"
                        className="w-full bg-transparent text-slate-300 text-xs px-1.5 py-0.5 rounded hover:bg-slate-800 focus:bg-slate-800 outline-none border border-transparent focus:border-slate-700"
                      />
                    </td>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        checked={effOnDemand(t)}
                        onChange={e => stage(t.id, { onDemand: e.target.checked })}
                        title={effOnDemand(t) ? "Corsa A CHIAMATA (clic per renderla ordinaria)" : "Segna come corsa a chiamata"}
                        className="accent-purple-500 cursor-pointer"
                      />
                      {effOnDemand(t) && <span className="block text-[9px] text-purple-300 leading-none mt-0.5">📞</span>}
                    </td>
                    <td className="p-2 text-center">
                      <button
                        onClick={() => stage(t.id, { isActive: !effActive(t) })}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                          effActive(t)
                            ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                            : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                        }`}
                      >
                        {effActive(t) ? "ATTIVA" : "OFF"}
                      </button>
                    </td>
                    <td className="p-2 text-right">
                      <button
                        onClick={() => setDetailTripId(t.id)}
                        className="p-1 rounded text-cyan-400 hover:bg-cyan-500/10"
                        title="Modifica corsa: giorni, validità, categorie, eccezioni, copia"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setConfirmReq({
                          title: "Eliminare questa corsa?",
                          message: (
                            <>
                              {t.shortName ? <><b>{t.shortName}</b> · </> : null}
                              {t.firstDeparture ? <>partenza <b>{t.firstDeparture.slice(0, 5)}</b> · </> : null}
                              {t.headsign ?? "senza destinazione"}
                            </>
                          ),
                          confirmLabel: "Elimina",
                          onConfirm: () => { deleteMut.mutate(t.id); },
                        })}
                        className="p-1 rounded text-rose-400 hover:bg-rose-500/10"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Drawer dettaglio (validità + eccezioni) */}
      {detailTrip && (
        <TripDetailDrawer
          projectId={projectId}
          trip={detailTrip}
          onClose={() => setDetailTripId(null)}
          onChange={() => qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] })}
          onRequestCopy={() => { setCopyTripId(detailTrip.id); setDetailTripId(null); }}
          onToggleActive={() => updateMut.mutate({ id: detailTrip.id, patch: { isActive: !detailTrip.isActive } })}
          onDelete={() => setConfirmReq({
            title: "Eliminare questa corsa?",
            message: (
              <>
                {detailTrip.shortName ? <><b>{detailTrip.shortName}</b> · </> : null}
                {detailTrip.firstDeparture ? <>partenza <b>{detailTrip.firstDeparture.slice(0, 5)}</b> · </> : null}
                {detailTrip.headsign ?? "senza destinazione"}
              </>
            ),
            confirmLabel: "Elimina",
            onConfirm: () => { deleteMut.mutate(detailTrip.id); setDetailTripId(null); },
          })}
        />
      )}
      {/* ─── Dialog: Stampa elenco corse — scelta linee ─── */}
      {printOpen && (() => {
        const routesList = [...(routesQ.data ?? [])].sort((a, b) => a.shortName.localeCompare(b.shortName, "it", { numeric: true }));
        const allSel = routesList.length > 0 && routesList.every(r => printSel.has(r.id));
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !printBusy && setPrintOpen(false)}>
            <div className="w-full max-w-md mx-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2"><Printer className="w-4 h-4 text-slate-300" /> Stampa elenco corse</h3>
                <button onClick={() => !printBusy && setPrintOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
              </div>
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
                <span className="text-xs text-slate-400"><strong className="text-slate-200">{printSel.size}</strong> di {routesList.length} linee</span>
                <button onClick={() => setPrintSel(allSel ? new Set() : new Set(routesList.map(r => r.id)))}
                  className="text-[11px] px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">
                  {allSel ? "Deseleziona tutte" : "Seleziona tutte"}
                </button>
              </div>
              <div className="flex-1 overflow-auto divide-y divide-slate-800/60">
                {routesList.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-500">Nessuna linea nel progetto.</div>}
                {routesList.map(r => {
                  const sel = printSel.has(r.id);
                  return (
                    <label key={r.id} className={`flex items-center gap-3 px-4 py-2 cursor-pointer ${sel ? "bg-slate-800/40" : "hover:bg-slate-900/60"}`}>
                      <input type="checkbox" checked={sel} className="accent-emerald-500 shrink-0"
                        onChange={() => setPrintSel(prev => { const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })} />
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color || "#64748b" }} />
                      <span className="font-semibold text-slate-100 min-w-[2.5rem] shrink-0">{r.shortName}</span>
                      <span className="text-xs text-slate-400 truncate flex-1">{r.longName || ""}</span>
                    </label>
                  );
                })}
              </div>
              <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)} className="accent-amber-500" />
                    Solo corse attive
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400" title="Corrispettivo chilometrico: calcola l'incasso per categoria e totale">
                    Corrispettivo €/km
                    <input type="text" inputMode="decimal" value={printRate} onChange={e => setPrintRate(e.target.value.replace(/[^\d.,]/g, ""))}
                      placeholder="es. 2,50" className="w-20 px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-100 text-[11px] tabular-nums" />
                  </label>
                </div>
                <button onClick={runPrintCorse} disabled={printBusy || printSel.size === 0}
                  className="px-4 py-2 rounded-lg bg-slate-200 hover:bg-white text-slate-900 text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2">
                  {printBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                  {printBusy ? "Preparo…" : `Stampa ${printSel.size} ${printSel.size === 1 ? "linea" : "linee"}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {/* ─── Dialog: anteprima Unifica corse gemelle ─── */}
      {mergePreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !mergeBusy && setMergePreview(null)}>
          <div className="w-full max-w-2xl mx-4 rounded-xl border border-slate-600 bg-slate-950 shadow-2xl max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Merge className="w-4 h-4 text-cyan-400" /> Unifica corse gemelle — anteprima
              </h3>
              <button onClick={() => !mergeBusy && setMergePreview(null)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="px-4 py-3 border-b border-slate-800 text-xs text-slate-300">
              Sto per fondere <b className="text-cyan-300">{mergePreview.groups.length}</b> gruppi di corse identiche:
              <b className="text-cyan-300"> {mergePreview.tripsBefore}</b> corse →
              <b className="text-emerald-300"> {mergePreview.tripsAfter}</b> ({mergePreview.removed} rimosse).
              Ogni corsa fusa prende la <b>validità unione</b>, un <b>calendario-unione</b> (i giorni sommati) e l'<b>unione delle categorie</b> del calendario aziendale. Reversibile ri-generando/re-importando.
            </div>
            <div className="flex-1 overflow-auto p-2">
              <table className="w-full text-[11px]">
                <thead className="text-slate-500">
                  <tr><th className="p-1.5 text-left">Partenza</th><th className="p-1.5 text-left">Headsign</th><th className="p-1.5 text-center">Corse</th><th className="p-1.5 text-left">Giorni risultanti</th><th className="p-1.5 text-left">Categorie unione</th><th className="p-1.5 text-left">Periodo</th></tr>
                </thead>
                <tbody>
                  {mergePreview.groups.map((g, i) => (
                    <tr key={i} className="border-t border-slate-800/60">
                      <td className="p-1.5 font-mono text-slate-200">{g.departure || "—"}</td>
                      <td className="p-1.5 text-slate-400 truncate max-w-[160px]">{g.headsign || "—"}</td>
                      <td className="p-1.5 text-center"><span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">{g.count} → 1</span></td>
                      <td className="p-1.5 text-emerald-300 font-medium">{g.unionWeekdaysLabel || (g.anyCal ? "—" : "(nessun calendario)")}</td>
                      <td className="p-1.5">
                        {(g.unionCategories ?? []).length === 0
                          ? <span className="text-slate-600">tutte</span>
                          : <div className="flex flex-wrap gap-1">
                              {(g.unionCategories ?? []).map(c => (
                                <span key={c.code} title={c.name}
                                  className="px-1 py-0.5 rounded text-[9px] font-medium border whitespace-nowrap"
                                  style={{ borderColor: c.color || "#3b82f6", background: `${c.color || "#3b82f6"}22` }}>
                                  {c.name.length > 12 ? c.name.slice(0, 11) + "…" : c.name}
                                </span>
                              ))}
                            </div>}
                      </td>
                      <td className="p-1.5 text-slate-500 font-mono">{g.unionStart ? `${g.unionStart.slice(5)}→${(g.unionEnd ?? "").slice(5)}` : "illimitato"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800">
              <button onClick={() => !mergeBusy && setMergePreview(null)} className="px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs">Annulla</button>
              <button onClick={applyMerge} disabled={mergeBusy}
                className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50">
                {mergeBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Merge className="w-3.5 h-3.5" />} Unifica {mergePreview.removed} corse
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Dialog: Crea copia corsa (orario, periodo, giorni, categorie) ─── */}
      {copyTrip && (
        <CopyTripDialog
          projectId={projectId}
          trip={copyTrip}
          dayTypes={dayTypesQ.data ?? []}
          categories={categoriesQ.data ?? []}
          onClose={() => setCopyTripId(null)}
          onDone={() => {
            setCopyTripId(null); setSelected(new Set());
            qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
            qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
          }}
        />
      )}

      {/* ─── Dialog: Nuova corsa (la prima della variante) ─── */}
      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !newBusy && setNewOpen(false)}>
          <div className="w-full max-w-2xl mx-4 rounded-xl border border-emerald-500/30 bg-slate-950 shadow-2xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Plus className="w-4 h-4 text-emerald-400" /> Nuova corsa — calcolo orari (Corsa MADRE)
              </h3>
              <button onClick={() => !newBusy && setNewOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <p className="text-[11px] text-slate-400">
                Definisci gli <strong>orari di transito</strong> del percorso: i tempi per <strong>arco</strong> sono calcolati
                automaticamente (dai km e dalla velocità di default) e <strong>sovrascrivibili</strong>; su ogni fermata
                imposti la <strong>sosta</strong>. Al salvataggio la corsa diventa una <strong>Corsa MADRE</strong> (se il
                percorso aveva una Corsa ZERO, viene promossa senza doppioni), pronta da moltiplicare nella zona «Percorrenze».
              </p>
              <div className="grid grid-cols-4 gap-2 items-end">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Partenza</label>
                  <input type="time" value={newStart} onChange={e => setNewStart(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1" title="Usata per il calcolo automatico dei tempi d'arco">Vel. default (km/h)</label>
                  <input type="number" min={3} max={80} value={newSpeed} onChange={e => setNewSpeed(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Sosta default (s)</label>
                  <input type="number" min={0} max={300} value={newDwell} onChange={e => setNewDwell(e.target.value)}
                    className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs" />
                </div>
                <button
                  onClick={() => {
                    const vs = newVariantQ.data?.stops ?? [];
                    if (vs.length >= 2) recalcArcDefaults(vs, Number(newSpeed) || 18, Math.max(0, Math.round(Number(newDwell) || 0)));
                  }}
                  className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:bg-slate-700"
                  title="Ricalcola tutti gli archi e le soste dai valori di default (sovrascrive le modifiche manuali)">
                  ↻ Ricalcola grafo
                </button>
              </div>

              {/* ── Grafo della linea: nodi (fermate+sosta) e archi (tempo) ── */}
              {newVariantQ.isLoading && <p className="text-[11px] text-slate-500">Caricamento percorso…</p>}
              {(newVariantQ.data?.stops?.length ?? 0) >= 2 && protoTimes && (() => {
                const vs = newVariantQ.data!.stops;
                const cum = cumDistsOf(vs);
                return (
                  <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/40 p-2 space-y-0">
                    {vs.map((st, i) => (
                      <div key={`${st.stopId}-${i}`}>
                        <div className="flex items-center gap-2 py-1">
                          <span className={`w-3 h-3 rounded-full shrink-0 border-2 ${i === 0 || i === vs.length - 1 ? "bg-emerald-400 border-emerald-200" : "bg-slate-700 border-slate-500"}`} />
                          <span className="text-xs flex-1 truncate" title={st.stopName}>
                            <span className="text-slate-500 font-mono">{i + 1}.</span> {st.stopName}
                          </span>
                          <span className="text-[10px] font-mono text-emerald-300/90 shrink-0 tabular-nums">
                            {genSecToHms(protoTimes.arr[i]).slice(0, 5)}
                            {protoTimes.dep[i] !== protoTimes.arr[i] && <span className="text-slate-500"> →{genSecToHms(protoTimes.dep[i]).slice(0, 5)}</span>}
                          </span>
                          {i > 0 && i < vs.length - 1 ? (
                            <span className="flex items-center gap-1 shrink-0">
                              <input type="number" min={0} max={600} value={newDwellS[i] ?? 0}
                                onChange={e => setNewDwellS(prev => prev.map((x, k) => (k === i ? Math.max(0, Number(e.target.value) || 0) : x)))}
                                className="w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-[10px] text-right" />
                              <span className="text-[9px] text-slate-500 w-10">s sosta</span>
                            </span>
                          ) : <span className="w-[100px] shrink-0" />}
                        </div>
                        {i < vs.length - 1 && (
                          <div className="flex items-center gap-2 py-0.5">
                            <span className="w-0.5 h-5 bg-gradient-to-b from-slate-500 to-slate-700 ml-[5px] shrink-0 rounded" />
                            <span className="text-[9px] text-slate-500 flex-1 pl-1">↓ {((cum[i + 1] - cum[i]) / 1000).toFixed(2)} km</span>
                            <input type="number" min={0} step={0.5} value={newArcMin[i] ?? 0}
                              onChange={e => setNewArcMin(prev => prev.map((x, k) => (k === i ? Math.max(0, Number(e.target.value) || 0) : x)))}
                              className="w-16 px-1 py-0.5 rounded bg-slate-950 border border-amber-600/60 text-[10px] text-right text-amber-200 font-mono" />
                            <span className="text-[9px] text-slate-500 w-24 shrink-0">min percorrenza</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })()}
              {protoTimes && (
                <p className="text-[10px] text-emerald-300">
                  Giro completo: <strong>{protoTimes.totalMin} min</strong> · arrivo capolinea <strong className="font-mono">{genSecToHms(protoTimes.arr[protoTimes.arr.length - 1]).slice(0, 5)}</strong>
                </p>
              )}
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Giorni di circolazione (calendario)</label>
                <select value={newCalendarId} onChange={e => setNewCalendarId(e.target.value)}
                  className="w-full px-2 py-1.5 rounded bg-slate-900 border border-slate-700 text-xs">
                  <option value="">— nessun calendario —</option>
                  {calendars.map(c => <option key={c.id} value={c.id}>{c.code} {c.name ? `· ${c.name}` : ""}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (calendario aziendale) — anche più di una</label>
                {categoriesQ.isLoading && <p className="text-[11px] text-slate-500">Caricamento validità…</p>}
                {!categoriesQ.isLoading && (
                  <CategoryChips categories={categoriesQ.data ?? []} selected={newCategoryIds} onChange={setNewCategoryIds}
                    emptyHint="Nessuna validità definita nel Calendario aziendale." />
                )}
                <p className="text-[10px] text-slate-500 mt-1">Se ne selezioni ≥1, la corsa vale SOLO nei giorni di quei periodi (es. Scuole Aperte). Nessuna = vale in tutti i periodi.</p>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Validità (tipi giorno — matrice)</label>
                {dayTypesQ.isLoading && <p className="text-[11px] text-slate-500">Caricamento tipi giorno…</p>}
                <div className="flex flex-wrap gap-2">
                  {(dayTypesQ.data ?? []).map(dt => (
                    <label key={dt.id} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded border cursor-pointer select-none"
                      style={{ borderColor: newDayTypeIds.has(dt.id) ? (dt.color || "#10b981") : "#334155", background: newDayTypeIds.has(dt.id) ? `${dt.color || "#10b981"}22` : "transparent" }}>
                      <input type="checkbox" className="hidden" checked={newDayTypeIds.has(dt.id)}
                        onChange={() => setNewDayTypeIds(prev => { const n = new Set(prev); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })} />
                      {dt.name}
                    </label>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 mt-1">I bollini verdi nella Matrice di validità si accendono su questi giorni.</p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setNewOpen(false)} disabled={newBusy}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button onClick={runCreateFirstTrip} disabled={newBusy}
                className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
                {newBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Salva orari → Corsa MADRE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Dialog: elimina corse selezionate (doppia conferma) ─── */}
      {bulkDelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !bulkDeleteMut.isPending && setBulkDelOpen(false)}>
          <div className="w-full max-w-sm mx-4 rounded-xl border border-rose-500/40 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-rose-300 flex items-center gap-2">
                <Trash2 className="w-4 h-4" /> Elimina {selected.size} corse
              </h3>
              <button onClick={() => !bulkDeleteMut.isPending && setBulkDelOpen(false)} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <p className="text-slate-300">
                Stai per eliminare <strong className="text-rose-300">{selected.size} corse</strong> in modo <strong>definitivo</strong>.
              </p>
              <p className="text-[11px] text-slate-500">
                Vengono rimossi anche gli orari alle fermate, la riga nella Matrice di validità, le eccezioni e le categorie di calendario aziendale collegate. L'azione non è annullabile.
              </p>
              <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer select-none rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                <input type="checkbox" checked={bulkDelArmed} onChange={e => setBulkDelArmed(e.target.checked)} className="accent-rose-500" />
                Confermo di voler eliminare queste {selected.size} corse
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800 bg-black/30">
              <button onClick={() => setBulkDelOpen(false)} disabled={bulkDeleteMut.isPending}
                className="text-xs px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40">Annulla</button>
              <button onClick={() => bulkDeleteMut.mutate()} disabled={!bulkDelArmed || bulkDeleteMut.isPending}
                className="text-xs px-3 py-1.5 rounded bg-rose-600 text-white hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                {bulkDeleteMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Elimina definitivamente
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

/* ─── Bulk validity setter (popover-ish) ─── */
function BulkValiditySetter({ onApply, disabled }: {
  onApply: (vf: string, vt: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [vf, setVf] = useState("");
  const [vt, setVt] = useState("");
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Periodo di esistenza della corsa nel calendario (es. orario estivo)"
        className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1"
      >
        <CalendarIcon className="w-3 h-3" /> Periodo
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-3 z-20 w-72 space-y-2">
          <p className="text-[11px] text-slate-300 font-medium">Periodo di validità della corsa</p>
          <p className="text-[10px] text-slate-400 leading-snug">
            La corsa circola SOLO tra queste due date (poi valgono comunque giorni e
            categorie della Matrice). Serve per orari stagionali: es. una corsa estiva
            dal 15/06 al 10/09. Se lasci vuoto, la corsa non ha limiti di periodo.
          </p>
          <div className="flex items-center gap-2">
            <input type="date" value={vf} onChange={e => setVf(e.target.value)}
              className="px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs flex-1" />
            <span className="text-slate-500">→</span>
            <input type="date" value={vt} onChange={e => setVt(e.target.value)}
              className="px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-xs flex-1" />
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={() => { onApply("", ""); setOpen(false); }}
              title="Toglie il periodo: la corsa torna valida senza limiti di date"
              className="px-2 py-1 rounded border border-slate-600 text-slate-300 hover:bg-slate-700 text-[11px]"
            >
              Illimitata
            </button>
            <button
              onClick={() => { onApply(vf, vt); setOpen(false); }}
              className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] inline-flex items-center gap-1"
            >
              <Check className="w-3 h-3" /> Applica
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Bulk: proroga GIORNI (tipi giorno) e CATEGORIE (calendario aziendale) ───
 * Per estendere corse esistenti: es. nate "feriale · scuole chiuse", prorogate
 * anche a "sabato" o ad altre categorie SENZA rifarle. */
/** Picker categorie del calendario aziendale con RAGGRUPPAMENTO: i periodi di
 *  scuole chiuse (codice `scuole_chiuse_<periodo>`: Estivo, Inverno Natale,
 *  Pasqua…) sono annidati sotto un'intestazione "Scuole Chiuse" che fa da
 *  seleziona-tutti. Il codice "scuole_chiuse" nudo NON è assegnabile: non ha
 *  date proprie (ogni giorno di scuola chiusa appartiene a un periodo), quindi
 *  è solo il contenitore. Così si evita la ridondanza «Scuole Chiuse + Estivo»
 *  in un elenco piatto. */

function BulkDaysCatsSetter({ dayTypes, categories, disabled, onApplyDays, onApplyCats }: {
  dayTypes: PsDayType[];
  categories: PsValidityCategory[];
  disabled?: boolean;
  onApplyDays: (dayTypeIds: string[], isValid: boolean) => Promise<void>;
  onApplyCats: (categoryIds: string[], mode: "add" | "replace") => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [dayIds, setDayIds] = useState<Set<string>>(new Set());
  const [catIds, setCatIds] = useState<Set<string>>(new Set());
  const [catMode, setCatMode] = useState<"add" | "replace">("add");
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Proroga/estendi le corse selezionate: aggiungi o togli giorni (feriale, sabato, festivo) e categorie del calendario aziendale (scuole aperte/chiuse…)"
        className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white flex items-center gap-1"
      >
        <CalendarIcon className="w-3 h-3" /> Giorni/Categorie
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-700 rounded p-3 z-20 w-80 space-y-3">
          <div>
            <p className="text-[11px] text-slate-300 font-medium mb-1">Giorni (tipi giorno)</p>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {dayTypes.map(dt => (
                <label key={dt.id} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border cursor-pointer select-none"
                  style={{ borderColor: dayIds.has(dt.id) ? (dt.color || "#10b981") : "#334155", background: dayIds.has(dt.id) ? `${dt.color || "#10b981"}22` : "transparent" }}>
                  <input type="checkbox" className="hidden" checked={dayIds.has(dt.id)}
                    onChange={() => setDayIds(prev => { const n = new Set(prev); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })} />
                  {dt.name}
                </label>
              ))}
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={async () => { if (dayIds.size === 0) return; await onApplyDays([...dayIds], true); setOpen(false); }}
                disabled={dayIds.size === 0}
                title="Le corse selezionate diventano valide ANCHE in questi giorni (quelli già attivi restano)"
                className="flex-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] disabled:opacity-40"
              >
                ➕ Aggiungi giorni
              </button>
              <button
                onClick={async () => { if (dayIds.size === 0) return; await onApplyDays([...dayIds], false); setOpen(false); }}
                disabled={dayIds.size === 0}
                title="Le corse selezionate NON valgono più in questi giorni (gli altri restano)"
                className="flex-1 px-2 py-1 rounded border border-rose-500/50 text-rose-300 hover:bg-rose-500/10 text-[11px] disabled:opacity-40"
              >
                ➖ Togli giorni
              </button>
            </div>
          </div>
          <div className="border-t border-slate-700 pt-2">
            <p className="text-[11px] text-slate-300 font-medium mb-1">Categorie (calendario aziendale)</p>
            <div className="mb-1.5">
              <CategoryChips categories={categories} selected={catIds} onChange={setCatIds} />
            </div>
            <div className="flex items-center gap-2 mb-1.5 text-[10px] text-slate-400">
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="catmode" checked={catMode === "add"} onChange={() => setCatMode("add")} className="accent-emerald-500" />
                Aggiungi alle esistenti (proroga)
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="catmode" checked={catMode === "replace"} onChange={() => setCatMode("replace")} className="accent-amber-500" />
                Sostituisci
              </label>
            </div>
            <button
              onClick={async () => { await onApplyCats([...catIds], catMode); setOpen(false); }}
              disabled={catMode === "add" && catIds.size === 0}
              title={catMode === "replace" && catIds.size === 0 ? "Sostituisci con nessuna categoria = la corsa vale in ogni periodo del calendario aziendale" : undefined}
              className="w-full px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] disabled:opacity-40"
            >
              Applica categorie {catMode === "replace" && catIds.size === 0 ? "(nessun vincolo)" : ""}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Dialog: crea una copia della corsa (orario, periodo, giorni, categorie) ─── */
function CopyTripDialog({ projectId, trip, dayTypes, categories, onClose, onDone }: {
  projectId: string;
  trip: PsTrip;
  dayTypes: PsDayType[];
  categories: PsValidityCategory[];
  onClose: () => void;
  onDone: () => void;
}) {
  const stQ = useQuery({
    queryKey: ["ps", projectId, "trip-stop-times", trip.id],
    queryFn: () => getPsStopTimes(projectId, trip.id),
  });
  const baseDep = stQ.data?.[0]?.departureTime ?? null;
  const [dep, setDep] = useState("");
  useEffect(() => { if (baseDep) setDep(baseDep.slice(0, 5)); }, [baseDep]);
  const [vf, setVf] = useState(trip.validFrom || "");
  const [vt, setVt] = useState(trip.validTo || "");
  const [dtIds, setDtIds] = useState<Set<string>>(new Set());
  const [catIds, setCatIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const dtKinds = useMemo(() => classifyDayTypes(dayTypes), [dayTypes]);

  async function create() {
    const sts = stQ.data ?? [];
    if (sts.length < 2) { toast.error("La corsa non ha orari da copiare"); return; }
    const target = dep.trim();
    if (!/^\d{1,2}:\d{2}$/.test(target)) { toast.error("Orario di partenza non valido (HH:MM)"); return; }
    setBusy(true);
    try {
      // trasla l'intera corsa così la prima partenza = orario scelto
      const shift = genToSec(`${target}:00`) - genToSec(sts[0].departureTime);
      const stopTimes = sts.map(st => ({
        stopId: st.stopId,
        arrivalTime: genSecToHms(genToSec(st.arrivalTime) + shift),
        departureTime: genSecToHms(genToSec(st.departureTime) + shift),
        timepoint: st.timepoint,
      }));
      // maschera settimanale dai giorni scelti (così i bollini sono coerenti)
      const weekdays = dtIds.size > 0
        ? Array.from({ length: 7 }, (_, i) => { const dt = dtKinds[wdTypicalCode(i)]; return !!dt && dtIds.has(dt.id); })
        : undefined;
      const res = await batchCreatePsTrips(projectId, [{
        routeId: trip.routeId, variantId: trip.variantId,
        calendarId: trip.calendarId ?? null,
        headsign: trip.headsign ?? null, shortName: trip.shortName ?? null,
        direction: trip.direction, serviceLabel: trip.serviceLabel ?? null,
        ...(weekdays ? { attributes: { weekdays } } : {}),
        stopTimes,
      } as PsBatchTripInput]);
      const newId = res.tripIds?.[0];
      if (!newId) throw new Error("creazione copia non riuscita");
      if (vf || vt) await updatePsTrip(projectId, newId, { validFrom: vf || null, validTo: vt || null });
      if (dtIds.size > 0) await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [newId], dayTypeIds: [...dtIds], isValid: true });
      if (catIds.size > 0) await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [newId], categoryIds: [...catIds], mode: "replace" });
      toast.success("Copia creata", { description: `Partenza ${target}${vf || vt ? ` · ${vf || "…"}→${vt || "…"}` : ""}` });
      onDone();
    } catch (e: any) {
      toast.error("Errore nella copia", { description: e?.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-lg mx-4 rounded-xl border border-cyan-500/30 bg-slate-950 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
            <Copy className="w-4 h-4 text-cyan-400" /> Crea copia della corsa
          </h3>
          <button onClick={() => !busy && onClose()} className="text-slate-500 hover:text-slate-200"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-4 text-sm">
          <div className="text-[11px] text-slate-500">
            Da: <span className="text-slate-300">{trip.headsign || trip.shortName || trip.id.slice(0, 8)}</span>
            {baseDep && <> · partenza originale <span className="font-mono text-slate-300">{baseDep.slice(0, 5)}</span></>}
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Ora di partenza della copia</label>
            <input type="time" value={dep} onChange={e => setDep(e.target.value)}
              className="w-40 px-2 py-1.5 rounded bg-slate-800 border border-slate-700 font-mono" />
            <p className="text-[10px] text-slate-500 mt-1">Tutta la corsa viene traslata così la prima partenza è questa.</p>
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Periodo — da</label>
              <input type="date" value={vf} onChange={e => setVf(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700" />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Periodo — a</label>
              <input type="date" value={vt} onChange={e => setVt(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Giorni di validità</label>
            <div className="flex flex-wrap gap-1.5">
              {dayTypes.map(dt => {
                const on = dtIds.has(dt.id);
                return (
                  <button key={dt.id} type="button"
                    onClick={() => setDtIds(s => { const n = new Set(s); n.has(dt.id) ? n.delete(dt.id) : n.add(dt.id); return n; })}
                    className={`text-[11px] px-2 py-1 rounded border ${on ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300" : "bg-slate-800 border-slate-700 text-slate-400"}`}>
                    {dt.name}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-slate-500 mt-1">Nessuno = eredita i giorni della corsa originale.</p>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-slate-500 mb-1">Categorie (calendario aziendale)</label>
            <div className="flex flex-wrap gap-1.5">
              <CategoryChips categories={categories} selected={catIds} onChange={setCatIds} />
            </div>
            <p className="text-[10px] text-slate-500 mt-1">Nessuna = vale in ogni periodo.</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800">
          <button onClick={() => !busy && onClose()} className="px-3 py-1.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs">Annulla</button>
          <button onClick={create} disabled={busy || stQ.isLoading}
            className="px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />} Crea copia
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Editor tabellare dei transiti alle fermate di una corsa (corse reali) ─── */
/* L'editor dei transiti (con cascata a valle e undo) è il componente
 * condiviso TripTransitsEditor, usato anche dalla zona Percorrenze. */

/* ─── Drawer dettaglio corsa con validità + eccezioni ─── */
function TripDetailDrawer({ projectId, trip, onClose, onChange, onRequestCopy, onToggleActive, onDelete }: {
  projectId: string;
  trip: PsTrip;
  onClose: () => void;
  onChange: () => void;
  onRequestCopy: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const exQ = useQuery({
    queryKey: ["ps", projectId, "trip-exceptions", trip.id],
    queryFn: () => listPsTripExceptions(projectId, trip.id),
  });

  const [vf, setVf] = useState(trip.validFrom || "");
  const [vt, setVt] = useState(trip.validTo || "");
  useEffect(() => {
    setVf(trip.validFrom || "");
    setVt(trip.validTo || "");
  }, [trip.id]);

  /* ─── Giorni validità (L…D), categorie e A chiamata ───
   * I 7 giorni combinano: validità del TIPO GIORNO (feriale/sabato/festivo)
   * + maschera per-corsa attributes.weekdays. Spegnere il giovedì di una
   * corsa feriale spegne SOLO il giovedì; accendere un giorno di un tipo
   * spento accende il tipo e preserva lo stato degli altri giorni. Tutto
   * si riflette sulla Matrice di validità (stessa regola condivisa). */
  const dayTypesDrawerQ = useQuery({
    queryKey: ["ps", projectId, "day-types"],
    queryFn: () => listPsDayTypes(projectId),
  });
  const categoriesDrawerQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
    staleTime: 60_000,
  });
  const tripValQ = useQuery({
    queryKey: ["ps", projectId, "trip-validity", trip.id],
    queryFn: () => getPsTripValidity(projectId, trip.id),
  });
  const calendarsDrawerQ = useQuery({
    queryKey: ["ps", projectId, "calendars"],
    queryFn: () => listPsCalendars(projectId),
    staleTime: 60_000,
  });
  const [wdBusy, setWdBusy] = useState(false);
  // Sdoppia per validità: split della corsa in due (una per le validità scelte)
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitSel, setSplitSel] = useState<Set<string>>(new Set());
  const [splitBusy, setSplitBusy] = useState(false);
  async function doSplit() {
    if (splitSel.size === 0) return;
    setSplitBusy(true);
    try {
      const r = await splitPsTripByCategories(projectId, trip.id, [...splitSel]);
      toast.success("Corsa sdoppiata", {
        description: `Creata una corsa separata per le validità scelte (stesso orario). Ora spostala nel TTD a un altro orario.`,
        duration: 8000,
      });
      setSplitOpen(false); setSplitSel(new Set());
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-validity", trip.id] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
      onChange();
    } catch (e: any) { toast.error("Sdoppiamento non riuscito", { description: e?.message }); }
    finally { setSplitBusy(false); }
  }
  const WD_LABELS = WD_LABELS_ROW;
  // Fallback: pattern del calendario collegato (per corse importate da GTFS
  // senza maschera esplicita), così i bollini riflettono la circolazione reale.
  const calMask = useMemo(
    () => calWeekdays((calendarsDrawerQ.data ?? []).find(c => c.id === trip.calendarId)),
    [calendarsDrawerQ.data, trip.calendarId],
  );
  const wdMask: boolean[] = wdMaskOf(trip, calMask);
  const typicalCode = wdTypicalCode;
  const dtByCode = useMemo(() => classifyDayTypes(dayTypesDrawerQ.data ?? []), [dayTypesDrawerQ.data]);
  const dayValidity = tripValQ.data?.dayValidity ?? {};
  const dayOn = (i: number): boolean => {
    if (!wdMask[i]) return false;                      // la corsa non circola quel giorno
    // Nessuna riga in Matrice di validità → mostra la circolazione settimanale.
    if (!dayValidity || Object.keys(dayValidity).length === 0) return true;
    const dt = dtByCode[typicalCode(i)];
    if (!dt) return true;                              // tipo-giorno non classificabile → circola
    return dayValidity[dt.id] !== false;               // spento SOLO se esplicitamente non valido
  };
  async function toggleWeekday(i: number) {
    if (wdBusy || !dayTypesDrawerQ.data || !tripValQ.data) return;
    setWdBusy(true);
    try {
      const newWd = [...wdMask];
      if (dayOn(i)) {
        newWd[i] = false; // spegni SOLO questo giorno
      } else {
        newWd[i] = true;
        const dt = dtByCode[typicalCode(i)];
        if (dt && !dayValidity[dt.id]) {
          // il tipo giorno era spento: accendilo, preservando lo stato
          // (spento) degli altri giorni dello stesso tipo
          for (let j = 0; j < 7; j++) {
            if (j !== i && typicalCode(j) === typicalCode(i) && !dayOn(j)) newWd[j] = false;
          }
          await postPsValidityBulk(projectId, { op: "trip-row-set", tripIds: [trip.id], dayTypeIds: [dt.id], isValid: true });
        }
      }
      await updatePsTrip(projectId, trip.id, { attributesMerge: { weekdays: newWd } });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-validity", trip.id] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
      onChange();
    } catch (e: any) {
      toast.error("Errore aggiornamento giorni", { description: e?.message });
    } finally { setWdBusy(false); }
  }
  async function applyCategories(nextIds: string[]) {
    if (wdBusy || !tripValQ.data) return;
    setWdBusy(true);
    try {
      await postPsValidityBulk(projectId, { op: "trip-categories-set", tripIds: [trip.id], categoryIds: nextIds, mode: "replace" });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-validity", trip.id] });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "validity"] });
      onChange();
    } catch (e: any) {
      toast.error("Errore categorie", { description: e?.message });
    } finally { setWdBusy(false); }
  }
  async function toggleOnDemand() {
    if (wdBusy) return;
    setWdBusy(true);
    try {
      await updatePsTrip(projectId, trip.id, { attributesMerge: { onDemand: !trip.attributes?.onDemand } });
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trips"] });
      onChange();
    } catch (e: any) {
      toast.error("Errore", { description: e?.message });
    } finally { setWdBusy(false); }
  }

  const saveValidity = useMutation({
    mutationFn: () => updatePsTrip(projectId, trip.id, {
      validFrom: vf || null, validTo: vt || null,
    }),
    onSuccess: () => {
      toast.success("Validità aggiornata");
      onChange();
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });

  const [newDate, setNewDate] = useState("");
  const [newType, setNewType] = useState<1 | 2>(2);
  const [newReason, setNewReason] = useState("");
  const addExc = useMutation({
    mutationFn: () => addPsTripException(projectId, trip.id, {
      date: newDate, exceptionType: newType, reason: newReason || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-exceptions", trip.id] });
      setNewDate(""); setNewReason("");
      toast.success("Eccezione aggiunta");
    },
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });
  const delExc = useMutation({
    mutationFn: (date: string) => deletePsTripException(projectId, trip.id, date),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ps", projectId, "trip-exceptions", trip.id] }),
    onError: (e: any) => toast.error(e?.message || "Errore"),
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[420px] h-full bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl">
        <div className="p-4 border-b border-slate-800 flex items-center gap-2">
          <Pencil className="w-4 h-4 text-cyan-400" />
          <h3 className="font-semibold text-sm">Modifica corsa</h3>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Azioni rapide (stessi strumenti della barra in alto, per la corsa) */}
        <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-1.5">
          <button onClick={onRequestCopy}
            className="px-2 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs flex items-center gap-1"
            title="Crea una copia: scegli orario, periodo, giorni e categorie">
            <Copy className="w-3 h-3" /> Crea copia
          </button>
          <button onClick={onToggleActive}
            className={`px-2 py-1 rounded text-xs flex items-center gap-1 ${trip.isActive ? "bg-slate-700 hover:bg-slate-600 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"}`}
            title={trip.isActive ? "Disattiva la corsa" : "Attiva la corsa"}>
            {trip.isActive ? <><PowerOff className="w-3 h-3" /> Disattiva</> : <><Power className="w-3 h-3" /> Attiva</>}
          </button>
          <div className="flex-1" />
          <button onClick={onDelete}
            className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-xs flex items-center gap-1"
            title="Elimina la corsa">
            <Trash2 className="w-3 h-3" /> Elimina
          </button>
        </div>

        <div className="p-4 border-b border-slate-800 space-y-1 text-xs">
          <div className="text-slate-400">{trip.headsign || trip.shortName || "—"}</div>
          <div className="text-slate-600 font-mono">{trip.id.slice(0, 8)}…</div>
          {!!trip.attributes?.prototype && !trip.attributes?.prototypeReady && (
            <div className="mt-2 rounded border border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200 leading-snug">
              ⚠ <strong>CORSA ZERO (prototipo)</strong> — nessun orario di partenza/arrivo:
              contiene solo i tempi per arco, la durata del giro e la validità.
              Per darle gli orari usa <strong>«Nuova corsa»</strong> (il calcolatore automatico):
              diventerà una <strong>Corsa MADRE</strong>, pronta da moltiplicare nella zona «Percorrenze».
            </div>
          )}
          {!!trip.attributes?.prototype && !!trip.attributes?.prototypeReady && (
            <div className="mt-2 rounded border border-violet-500/50 bg-violet-500/10 px-2.5 py-2 text-[11px] text-violet-200 leading-snug">
              ★ <strong>CORSA MADRE</strong> — prototipo con orari reali. Non genera km e NON entra
              nelle Unità di Progettazione: aspetta solo di essere moltiplicata con
              <strong> «Percorrenze»</strong>, che la userà come template e poi la rimuoverà.
            </div>
          )}
        </div>

        {/* Validità */}
        <div className="p-4 border-b border-slate-800 space-y-2">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Validità corsa</div>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-[10px] text-slate-500 block">Da</label>
              <input type="date" value={vf} onChange={e => setVf(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-slate-500 block">A</label>
              <input type="date" value={vt} onChange={e => setVt(e.target.value)}
                className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
            </div>
            <button
              onClick={() => saveValidity.mutate()}
              disabled={saveValidity.isPending}
              className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs flex items-center gap-1"
            >
              {saveValidity.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Salva
            </button>
          </div>
          <p className="text-[10px] text-slate-500 leading-tight">
            Restringe il periodo di attività della corsa rispetto al calendario.
            Vuoto = nessun limite.
          </p>
        </div>

        {/* Transiti alle fermate (editor tabellare) — solo per le corse reali.
            I prototipi ricevono gli orari dal calcolatore di «Nuova corsa». */}
        {!trip.attributes?.prototype && (
          <TripTransitsEditor projectId={projectId} tripId={trip.id} onSaved={onChange} />
        )}

        {/* Giorni validità (L…D) + categorie + a chiamata */}
        <div className="p-4 border-b border-slate-800 space-y-3">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Giorni di validità</div>
          {tripValQ.isLoading ? (
            <div className="text-[11px] text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> caricamento…</div>
          ) : (
            <div className="flex items-center gap-1.5">
              {WD_LABELS.map((l, i) => {
                const on = dayOn(i);
                return (
                  <button key={i} onClick={() => toggleWeekday(i)} disabled={wdBusy}
                    title={`${["Lunedì","Martedì","Mercoledì","Giovedì","Venerdì","Sabato","Domenica"][i]} — ${on ? "attivo (clic per spegnere)" : "spento (clic per accendere)"}`}
                    className={`w-8 h-8 rounded-full text-xs font-bold border transition-colors disabled:opacity-50 ${
                      on
                        ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/30"
                        : "bg-slate-800 border-slate-700 text-slate-500 hover:bg-slate-700"
                    }`}>
                    {l}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-slate-500 leading-tight">
            Accendi/spegni i singoli giorni: es. corsa feriale (L–V) senza il giovedì.
            La modifica si riflette subito sulla <strong>Matrice di validità</strong>.
          </p>

          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide pt-1">Categorie calendario aziendale</div>
          <CategoryChips
            categories={categoriesDrawerQ.data ?? []}
            selected={new Set(tripValQ.data?.categoryIds ?? [])}
            disabled={wdBusy || tripValQ.isLoading}
            onChange={(next) => applyCategories([...next])}
          />
          <p className="text-[10px] text-slate-500 leading-tight">
            Nessuna categoria accesa = la corsa vale in ogni periodo; con ≥1 accese vale SOLO nei giorni di quelle categorie.
          </p>

          {(tripValQ.data?.categoryIds?.length ?? 0) >= 2 && (
            <div className="pt-1">
              {!splitOpen ? (
                <button onClick={() => { setSplitOpen(true); setSplitSel(new Set()); }}
                  title="Spacca la corsa in due: una nuova corsa (stesso orario) prende le validità scelte, l'originale tiene le altre. Serve per spostare l'orario solo in una validità."
                  className="text-[11px] px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 inline-flex items-center gap-1">
                  <Copy className="w-3 h-3" /> Sdoppia per validità
                </button>
              ) : (
                <div className="space-y-2 rounded border border-amber-500/30 bg-amber-500/5 p-2">
                  <p className="text-[11px] text-amber-200 leading-tight">
                    Scegli le validità da <strong>spostare su una nuova corsa</strong> (stesso orario): l'originale resta con le altre.
                    Poi sposti la nuova corsa nel TTD a un altro orario, in modo indipendente.
                  </p>
                  <CategoryChips
                    categories={(categoriesDrawerQ.data ?? []).filter(c => (tripValQ.data?.categoryIds ?? []).includes(c.id))}
                    selected={splitSel} onChange={setSplitSel} />
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => { setSplitOpen(false); setSplitSel(new Set()); }} disabled={splitBusy}
                      className="text-[11px] px-2 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
                    <button onClick={doSplit}
                      disabled={splitBusy || splitSel.size === 0 || splitSel.size >= (tripValQ.data?.categoryIds?.length ?? 0)}
                      title={splitSel.size >= (tripValQ.data?.categoryIds?.length ?? 0) ? "Non puoi spostare TUTTE le validità: lasciane almeno una sull'originale" : undefined}
                      className="text-[11px] px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40 inline-flex items-center gap-1">
                      {splitBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />} Sdoppia
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 pt-1 cursor-pointer select-none text-xs text-slate-200">
            <input type="checkbox" checked={!!trip.attributes?.onDemand} onChange={toggleOnDemand} disabled={wdBusy}
              className="accent-purple-500" />
            📞 Corsa a chiamata (su prenotazione)
          </label>
        </div>

        {/* Eccezioni */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-800 space-y-2">
            <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Eccezioni date</div>
            <div className="flex gap-1.5 items-end">
              <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
              <select value={newType} onChange={e => setNewType(Number(e.target.value) as 1 | 2)}
                className="px-1.5 py-1.5 rounded bg-slate-800 text-xs border border-slate-700">
                <option value={2}>Sopprimi</option>
                <option value={1}>Aggiungi</option>
              </select>
              <button
                onClick={() => { if (newDate) addExc.mutate(); }}
                disabled={!newDate || addExc.isPending}
                className="px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs"
              >
                <Check className="w-3 h-3" />
              </button>
            </div>
            <input type="text" value={newReason} onChange={e => setNewReason(e.target.value)}
              placeholder="Motivo (opz.)"
              className="w-full px-2 py-1.5 rounded bg-slate-800 text-xs border border-slate-700" />
          </div>

          <div className="flex-1 overflow-auto">
            {(exQ.data ?? []).length === 0 && (
              <div className="p-6 text-center text-slate-600 text-xs">Nessuna eccezione.</div>
            )}
            {(exQ.data ?? []).map(e => (
              <div key={e.date} className="px-3 py-2 border-b border-slate-800 flex items-center gap-2 text-xs">
                {e.exceptionType === 1
                  ? <CalendarPlus className="w-3.5 h-3.5 text-emerald-400" />
                  : <CalendarMinus className="w-3.5 h-3.5 text-rose-400" />
                }
                <div className="flex-1">
                  <div className="font-medium text-slate-300">{fmtDate(e.date)}</div>
                  {e.reason && <div className="text-[10px] text-slate-500">{e.reason}</div>}
                </div>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                  e.exceptionType === 1 ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
                }`}>
                  {e.exceptionType === 1 ? "AGGIUNTA" : "SOPPR."}
                </span>
                <button onClick={() => delExc.mutate(e.date)}
                  className="p-1 rounded text-rose-400 hover:bg-rose-500/10">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

    </div>
  );
}
