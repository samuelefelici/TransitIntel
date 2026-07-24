/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI — dal programma di esercizio del progetto Planning Studio
 * ───────────────────────────────────────────────────────────────────────────
 * Si sceglie il PROGETTO + le LINEE + i DAY-TYPE (es. "Feriale Scuole Aperte"),
 * e il sistema genera:
 *  - Orari per il pubblico: orario generale per linea × day-type (A4 orizz.);
 *  - Quadri di palina: per ogni fermata delle linee scelte, tutte le linee che
 *    vi passano (A4 verticale, una fermata per pagina).
 * Dati e validità vengono dalle tabelle ps_* del progetto (ps_trip_day_validity).
 * La stampa apre una finestra con HTML standalone + window.print().
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRight, Link2, Loader2, Map as MapIcon, MapPin, MapPinned, Printer, QrCode, Search, Share2, SignpostBig,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { listPsValidityCategories } from "@/lib/planning-studio-validity-units-api";
import NetworkMap3D, { type NetLineStyle, type NetNodeLabels } from "@/components/NetworkMap3D";

const MAPBOX_TOKEN: string = (import.meta as any).env?.VITE_MAPBOX_TOKEN || "";

/* ─── Tipi (allineati a /api/planning-studio/:projectId/timetables/*) ─── */

interface StopSearchItem {
  stopId: string; stopName: string; stopCode: string | null;
  lat: number; lon: number; routes: string[];
}

interface StopTimetable {
  feedId: string;
  dayTypeId?: string | null;
  dayTypeName?: string | null;
  validityNote?: string | null;
  stop: { stopId: string; stopName: string; stopCode: string | null };
  lines: Array<{
    routeId: string; shortName: string | null; longName: string | null; color: string | null;
    headsigns: string[]; total: number;
    byHour: Array<{ hour: number; departures: Array<{ minute: number; headsignIdx: number }> }>;
  }>;
}

interface RouteTimetable {
  feedId: string;
  directionId: number | null;
  dayTypeId?: string | null;
  dayTypeName?: string | null;
  validityNote?: string | null;
  route: { routeId: string; shortName: string | null; longName: string | null; color: string | null };
  stops: Array<{
    stopId: string; stopName: string; lat?: number | null; lon?: number | null;
    clusterId?: string | null; clusterName?: string | null;
    clusterLogical?: boolean; clusterLat?: number | null; clusterLon?: number | null;
  }>;
  // percorso per il DISEGNO = variante più esercitata (gli orari usano tutte le corse)
  pathStops?: Array<{
    stopId: string; stopName: string; lat?: number | null; lon?: number | null;
    clusterId?: string | null; clusterName?: string | null;
    clusterLogical?: boolean; clusterLat?: number | null; clusterLon?: number | null;
  }>;
  cityNodes?: Array<{ name: string; lat: number; lon: number }>;
  /** macro-categorie del calendario aziendale usate dalle corse (es. Scuole aperte) */
  categories?: Array<{ id: string; code: string; name: string; color: string | null }>;
  trips: Array<{
    tripId: string; headsign: string | null; directionId: number | null; times: (string | null)[];
    /** validità dal calendario aziendale PS: day-type (feriale/sabato/festivo/…) e categorie */
    dayTypeCodes?: string[]; categoryIds?: string[];
    /** corsa a chiamata (su prenotazione) e maschera settimanale L…D (per le note) */
    onDemand?: boolean; weekdays?: boolean[] | null;
  }>;
}

interface PsRoute {
  routeId: string; routeShortName: string | null; routeLongName: string | null; routeColor: string | null;
}
interface PsProject { id: string; name: string }
interface PsDayType { id: string; code: string; name: string; color: string }

const DEFAULT_PROJECT_ID = "722e651e-42e9-4284-8483-21fe15d30caf";

/* ─── Helpers stampa ─── */

function lineColor(c: string | null | undefined): string {
  if (!c) return "#0f172a";
  return c.startsWith("#") ? c : `#${c}`;
}

function openPrintWindow(html: string) {
  const w = window.open("", "_blank");
  if (!w) { toast.error("Popup bloccata dal browser: consenti i popup per stampare"); return; }
  fillPrintWindow(w, html);
}

/** Apre SUBITO una finestra di stampa (dentro il gesto di click, così il
 *  browser non la blocca dopo gli await). Va poi riempita con fillPrintWindow
 *  quando i dati sono pronti, o chiusa in caso di errore/vuoto. */
function openPendingPrintWindow(): Window | null {
  const w = window.open("", "_blank");
  if (!w) { toast.error("Popup bloccata dal browser: consenti i popup per stampare"); return null; }
  w.document.write('<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Generazione orari…</title></head><body style="font-family:Arial,sans-serif;padding:2rem;color:#334155">Generazione orari in corso…</body></html>');
  return w;
}

/** Scrive l'HTML finale in una finestra già aperta e lancia la stampa. */
function fillPrintWindow(w: Window, html: string) {
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { try { w.print(); } catch { /* l'utente stampa dal menu */ } }, 400);
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PRINT_BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111; background: #fff; }
  .page { page-break-after: always; padding: 10mm 12mm; }
  .page:last-child { page-break-after: auto; }
  header.doc { display: flex; align-items: center; gap: 10px; border-bottom: 3px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
  header.doc .pill { color: #fff; font-weight: 800; border-radius: 8px; padding: 4px 12px; font-size: 22px; }
  header.doc h1 { font-size: 20px; line-height: 1.15; }
  header.doc .day { margin-left: auto; text-align: right; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  footer.doc { margin-top: 8px; border-top: 1px solid #999; padding-top: 4px; font-size: 9px; color: #555; display: flex; justify-content: space-between; }
`;

/* ── Quadro di palina (A4 verticale) ── */

const STOP_POSTER_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 portrait; margin: 8mm; }
  .line { margin-bottom: 9px; break-inside: avoid; }
  .l-head { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 6px 6px 0 0; }
  .l-pill { color: #fff; font-weight: 800; border-radius: 6px; padding: 2px 10px; font-size: 16px; min-width: 44px; text-align: center; }
  .l-info { flex: 1; min-width: 0; }
  .l-name { font-size: 11px; font-weight: 600; }
  .legend { font-size: 9.5px; color: #333; }
  .legend span { margin-right: 10px; }
  .l-count { font-size: 9px; color: #555; white-space: nowrap; }
  table.hours { width: 100%; border-collapse: collapse; }
  table.hours th { width: 34px; background: #111; color: #fff; font-size: 13px; font-weight: 800; text-align: center; border: 1px solid #444; padding: 2px; }
  table.hours td { border: 1px solid #bbb; padding: 2px 6px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  table.hours .m { display: inline-block; margin-right: 7px; font-weight: 600; }
  table.hours sup { font-size: 8px; font-weight: 700; }
`;

function stopPosterPage(data: StopTimetable): string {
  const gen = new Date().toLocaleString("it-IT");
  const dayLbl = data.dayTypeName ?? "Tutte le corse";
  const linesHtml = data.lines.map((l) => {
    const col = lineColor(l.color);
    const multiDest = l.headsigns.filter((h) => h).length > 1;
    const legend = multiDest
      ? `<div class="legend">${l.headsigns.map((h, i) =>
          h ? `<span><b>${String.fromCharCode(97 + i)}</b> → ${esc(h)}</span>` : "").join(" ")}</div>`
      : (l.headsigns[0] ? `<div class="legend">→ ${esc(l.headsigns[0])}</div>` : "");
    const rows = l.byHour.map((h) => `
      <tr>
        <th>${String(h.hour).padStart(2, "0")}</th>
        <td>${h.departures.map((d) =>
          `<span class="m">${String(d.minute).padStart(2, "0")}${multiDest && l.headsigns[d.headsignIdx] ? `<sup>${String.fromCharCode(97 + d.headsignIdx)}</sup>` : ""}</span>`
        ).join(" ")}</td>
      </tr>`).join("");
    return `
      <section class="line">
        <div class="l-head" style="background:${col}1a; border-left: 6px solid ${col}">
          <span class="l-pill" style="background:${col}">${esc(l.shortName ?? "?")}</span>
          <div class="l-info">
            <p class="l-name">${esc(l.longName ?? "")}</p>
            ${legend}
          </div>
          <span class="l-count">${l.total} partenze</span>
        </div>
        <table class="hours"><tbody>${rows}</tbody></table>
      </section>`;
  }).join("");

  return `
  <section class="page">
    <header class="doc">
      <div class="pill" style="background:#111">🚏</div>
      <h1>${esc(data.stop.stopName)}${data.stop.stopCode ? ` <small style="color:#666;font-size:12px">(${esc(data.stop.stopCode)})</small>` : ""}</h1>
      <div class="day">${esc(dayLbl)}<br><small style="font-weight:400">Orari di partenza</small></div>
    </header>
    ${linesHtml || "<p style='padding:20px;color:#666'>Nessuna partenza per il day-type selezionato.</p>"}
    <footer class="doc"><span>TransitIntel · quadro orario di fermata</span><span>Generato il ${gen}</span></footer>
  </section>`;
}

function buildStopPosterHtml(data: StopTimetable): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Quadro orario · ${esc(data.stop.stopName)}</title>
  <style>${STOP_POSTER_CSS}</style></head><body>${stopPosterPage(data)}</body></html>`;
}

function buildCombinedStopPostersHtml(list: StopTimetable[]): string {
  const body = list.filter((d) => d.lines.length > 0).map(stopPosterPage).join("");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Quadri di palina</title>
  <style>${STOP_POSTER_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna partenza per la selezione.</p>"}</body></html>`;
}

/* ── QUADRO DI PALINA COMPLETO (A4 vert.) — tutte le linee × categorie ────────
 * Per fermata (uno o più fogli A4): due sezioni SCUOLE APERTE / CHIUSE; dentro
 * ciascuna una tabellina per linea (righe = ora, colonne Feriale/Sabato/Festivo,
 * celle = minuti). Intestazione = ID + nome fermata; footer fisso Cerbero. */
interface PalDep { time: string; headsignIdx: number; onDemand: boolean; days: string[]; cats: string[] }
interface PalLine { routeId: string; shortName: string | null; longName: string | null; color: string | null; headsigns: string[]; departures: PalDep[] }
interface PalStop { stop: { stopId: string; stopName: string; stopCode: string | null }; categories: Array<{ code: string; name: string }>; lines: PalLine[] }

const PAL_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 landscape; margin: 8mm 8mm 12mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .palhead { display: flex; align-items: center; gap: 12px; border-bottom: 3px solid #0f172a; padding-bottom: 6px; margin-bottom: 8px; }
  .palhead .cerbero-h { height: 34px; width: auto; }
  .palhead h1 { font-size: 22px; line-height: 1.1; }
  .palhead .pid { font-size: 11px; color: #475569; font-weight: 700; letter-spacing: .04em; }
  .palcat { margin-bottom: 8px; }
  .cath { font-size: 13px; font-weight: 800; color: #fff; background: #0e7490; padding: 3px 10px; border-radius: 4px; margin: 6px 0 5px; letter-spacing: .04em; break-after: avoid; }
  .palgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px 10px; align-items: start; }
  .palline { break-inside: avoid; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; }
  .palline .lh { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-left: 5px solid #0f172a; background: #f8fafc; }
  .palline .lp { color: #fff; font-weight: 800; border-radius: 5px; padding: 1px 8px; font-size: 13px; min-width: 30px; text-align: center; }
  .palline .hsleg { font-size: 8.5px; color: #334155; }
  .palline .hsleg span { margin-right: 6px; }
  table.pal { width: 100%; border-collapse: collapse; }
  table.pal th, table.pal td { border: 1px solid #e2e8f0; font-size: 9px; padding: 1px 3px; text-align: left; font-variant-numeric: tabular-nums; }
  table.pal thead th { background: #334155; color: #fff; text-align: center; font-weight: 800; }
  table.pal th.h { width: 22px; text-align: center; background: #f1f5f9; font-weight: 800; color: #0f172a; }
  table.pal tbody tr:nth-child(even) td { background: #fafafa; }
  table.pal td { font-weight: 600; }
  table.pal sup { font-size: 7px; font-weight: 800; color: #b45309; }
  table.pal .od { color: #6d28d9; font-weight: 800; margin-left: 1px; }
  .pal-note { font-size: 8.5px; color: #475569; margin-top: 4px; }
  .brandfix { position: fixed; left: 8mm; right: 8mm; bottom: 4mm; display: flex; align-items: center; justify-content: space-between; font-size: 7px; color: #64748b; }
  .brandfix .pw { display: flex; align-items: center; gap: 4px; }
  .brandfix .pw b { color: #1d4ed8; font-weight: 800; }
  .cerbero { height: 15px; width: auto; display: inline-block; vertical-align: middle; }
`;

const PAL_DAYS: Array<[string, string]> = [["feriale", "Feriale"], ["sabato", "Sabato"], ["festivo", "Festivo"]];

/** Tabellina di UNA linea dentro UNA categoria: righe=ora, colonne=giorni presenti. */
function palLineTable(line: PalLine, catCode: string): string {
  const deps = line.departures.filter((d) => d.cats.includes(catCode));
  if (!deps.length) return "";
  const present = PAL_DAYS.filter(([k]) => deps.some((d) => d.days.includes(k)));
  const multiDest = line.headsigns.filter((h) => h).length > 1;
  const grid = new Map<number, Record<string, Array<{ m: number; od: boolean; hs: number }>>>();
  for (const d of deps) {
    const mm = /^(\d{1,2}):(\d{2})/.exec(d.time); if (!mm) continue;
    const h = Number(mm[1]) % 24, m = Number(mm[2]);
    for (const [k] of present) {
      if (!d.days.includes(k)) continue;
      if (!grid.has(h)) grid.set(h, {});
      const g = grid.get(h)!;
      (g[k] ??= []).push({ m, od: d.onDemand, hs: d.headsignIdx });
    }
  }
  const hours = [...grid.keys()].sort((a, b) => a - b);
  const cell = (arr?: Array<{ m: number; od: boolean; hs: number }>) => !arr ? "·"
    : arr.sort((a, b) => a.m - b.m).map((x) =>
        `${String(x.m).padStart(2, "0")}${multiDest && line.headsigns[x.hs] ? `<sup>${String.fromCharCode(97 + x.hs)}</sup>` : ""}${x.od ? `<span class="od">☎</span>` : ""}`).join(" ");
  const head = `<tr><th class="h">ora</th>${present.map(([, lbl]) => `<th>${lbl}</th>`).join("")}</tr>`;
  const rows = hours.map((h) =>
    `<tr><th class="h">${String(h).padStart(2, "0")}</th>${present.map(([k]) => `<td>${cell(grid.get(h)![k])}</td>`).join("")}</tr>`).join("");
  const legend = multiDest
    ? `<div class="hsleg">${line.headsigns.map((h, i) => h ? `<span><b>${String.fromCharCode(97 + i)}</b> → ${esc(h)}</span>` : "").join("")}</div>`
    : (line.headsigns[0] ? `<div class="hsleg">→ ${esc(line.headsigns[0])}</div>` : "");
  const col = lineColor(line.color);
  return `<div class="palline"><div class="lh" style="border-color:${col}"><span class="lp" style="background:${col}">${esc(line.shortName ?? "?")}</span>${legend}</div><table class="pal"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function palStopPage(data: PalStop, logo?: string | null): string {
  const secs = data.categories.map((cat) => {
    const tables = data.lines.map((l) => palLineTable(l, cat.code)).filter(Boolean).join("");
    if (!tables) return "";
    return `<div class="palcat"><div class="cath">${esc(cat.name)}</div><div class="palgrid">${tables}</div></div>`;
  }).filter(Boolean).join("");
  const anyOd = data.lines.some((l) => l.departures.some((d) => d.onDemand));
  const idLabel = data.stop.stopCode ? `ID ${esc(data.stop.stopCode)}` : `ID ${esc(data.stop.stopId)}`;
  return `
  <section class="page">
    <header class="palhead">
      ${logo ? `<img class="cerbero-h" src="${logo}" alt="Cerbero" />` : ""}
      <div><h1>${esc(data.stop.stopName)}</h1><div class="pid">Fermata · ${idLabel}</div></div>
    </header>
    ${secs || "<p style='padding:12px;color:#666'>Nessuna corsa transita da questa fermata.</p>"}
    ${anyOd ? `<div class="pal-note"><span class="od" style="color:#6d28d9;font-weight:800">☎</span> = corsa a chiamata (su prenotazione)</div>` : ""}
  </section>`;
}

function buildStopPostersHtml(stops: PalStop[], logo?: string | null): string {
  const has = (s: PalStop) => s.lines.some((l) => l.departures.length > 0);
  const body = stops.filter(has).map((s) => palStopPage(s, logo)).join("");
  const gen = new Date().toLocaleString("it-IT");
  const brandLogo = logo ? `<img class="cerbero" src="${logo}" alt="Cerbero" />` : CERBERO_LOGO;
  const brand = `<div class="brandfix"><span>Generato il ${gen}</span><span class="pw">${brandLogo}<span>powered by <b>Cerbero Analytics</b></span></span></div>`;
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Quadri di palina</title>
  <style>${PAL_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna partenza per la selezione.</p>"}${brand}</body></html>`;
}

/* ── ORARIO SETTIMANALE per CALENDARIO (una tabella unica per linea) ──
 * Tutte le corse della categoria (Scuole Aperte / Chiuse) in un'unica tabella
 * Lun→Dom; ogni corsa con validità particolare porta un apice-nota (a chiamata,
 * escluso sabato/domenica…) spiegato nella legenda. */
interface WeekTimetable {
  route: { routeId: string; shortName: string | null; longName: string | null; color: string | null };
  directionId: number | null;
  category: { code: string; name: string };
  repDates: (string | null)[];
  stops: Array<{ stopId: string; stopName: string }>;
  trips: Array<{ tripId: string; headsign: string | null; directionId: number | null; times: (string | null)[]; onDemand: boolean; days: boolean[] }>;
}


/* ── Helper orari + schematizzazione linea/rete (condivisa da mappa e stampe) ── */

function hhmmToMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? (Number(m[1]) % 48) * 60 + Number(m[2]) : null;
}
function fmtMin(n: number): string {
  const h = Math.floor(n / 60) % 24, m = ((n % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ── Schematizzazione octolineare (stile metro) condivisa locandina + mappa rete ──
 * Ogni segmento è "snappato" a multipli di 45°, ma ancorato alla geografia
 * (lunghezza = proiezione sulla direzione snappata) così le linee restano nella
 * loro zona e gli interscambi cadono vicini. Tutte le fermate hanno il nome. */

interface SchemStop {
  stopId: string; name: string; lat: number; lon: number;
  clusterId?: string | null; clusterName?: string | null;
  clusterLogical?: boolean; clusterLat?: number | null; clusterLon?: number | null;
}
interface SchemLine { color: string | null; stops: SchemStop[]; style?: NetLineStyle }

/** Riduce la sequenza fermate ai NODI LOGICI (cluster con isLogical):
 *  ogni fermata in un cluster logico → quel nodo (centroide), corse consecutive
 *  nello stesso nodo collassate; le fermate non-nodo restano solo se capolinea. */
function collapseToLogicalNodes(stops: SchemStop[]): SchemStop[] {
  const out: SchemStop[] = [];
  let lastKey: string | null = null;
  stops.forEach((s, i) => {
    const term = i === 0 || i === stops.length - 1;
    let key: string | null = null;
    let node: SchemStop = s;
    if (s.clusterLogical && s.clusterId) {
      key = `c:${s.clusterId}`;
      node = {
        stopId: s.clusterId, name: s.clusterName || s.name,
        lat: s.clusterLat ?? s.lat, lon: s.clusterLon ?? s.lon,
        clusterId: s.clusterId, clusterName: s.clusterName || s.name,
        clusterLogical: true, clusterLat: s.clusterLat ?? s.lat, clusterLon: s.clusterLon ?? s.lon,
      };
    } else if (term) {
      key = `s:${s.stopId}`;
    } else {
      return; // fermata intermedia non-nodo → eliminata
    }
    if (key !== lastKey) { out.push(node); lastKey = key; }
  });
  return out.length >= 2 ? out : stops; // se troppo ridotta, torna alle fermate piene
}

/** Connettore "a gomito" octolineare tra due punti a posizione fissa (preserva
 *  gli estremi → i nodi condivisi convergono). Tratto assiale + diagonale 45°. */
function elbow(ax: number, ay: number, bx: number, by: number): Array<{ x: number; y: number }> {
  const dx = bx - ax, dy = by - ay;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  if (adx < 1 || ady < 1 || Math.abs(adx - ady) < 1) return [{ x: bx, y: by }]; // già assiale/diagonale
  const bend = adx >= ady
    ? { x: bx - sx * ady, y: ay }   // orizzontale poi 45°
    : { x: ax, y: by - sy * adx };  // verticale poi 45°
  return [bend, { x: bx, y: by }];
}

interface SchemNode { lon: number; lat: number; n: number; name: string; lines: Set<number>; logical: boolean }

/** Layer di tile cartografiche (CARTO Positron light, senza etichette) per una
 *  bbox geografica, in Web Mercator. Ritorna { tiles, P } dove P proietta lon/lat
 *  nello spazio schermo allineato alle tile. */
function mercatorTiles(
  pts: Array<{ lon: number; lat: number }>, W: number, H: number, M: number,
): { tiles: string; P: (lon: number, lat: number) => { x: number; y: number } } {
  const rad = (d: number) => (d * Math.PI) / 180;
  const mX = (lon: number) => (lon + 180) / 360;
  const mY = (lat: number) => (1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2;

  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (const p of pts) { const x = mX(p.lon), y = mY(p.lat); if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; }
  // padding 10% attorno alla rete
  const padX = (mxx - mnx) * 0.1 || 1e-4, padY = (mxy - mny) * 0.1 || 1e-4;
  mnx -= padX; mxx += padX; mny -= padY; mxy += padY;
  const spanX = (mxx - mnx) || 1e-9, spanY = (mxy - mny) || 1e-9;
  const cw = W - 2 * M, ch = H - 2 * M;

  let z = Math.floor(Math.log2(Math.min(cw / (spanX * 256), ch / (spanY * 256))));
  z = Math.max(1, Math.min(18, isFinite(z) ? z : 1));
  const wpx = 256 * Math.pow(2, z);
  const bpw = spanX * wpx, bph = spanY * wpx;
  const k = Math.min(cw / bpw, ch / bph);
  const minPxX = mnx * wpx, minPxY = mny * wpx;
  const leftPad = M + (cw - bpw * k) / 2, topPad = M + (ch - bph * k) / 2;
  const P = (lon: number, lat: number) => ({ x: (mX(lon) * wpx - minPxX) * k + leftPad, y: (mY(lat) * wpx - minPxY) * k + topPad });

  const tsz = 256 * k;
  const maxTile = Math.pow(2, z) - 1;
  const txMin = Math.floor(minPxX / 256), txMax = Math.floor((minPxX + bpw) / 256);
  const tyMin = Math.floor(minPxY / 256), tyMax = Math.floor((minPxY + bph) / 256);
  let imgs = "";
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      if (tx < 0 || ty < 0 || tx > maxTile || ty > maxTile) continue;
      const sx = (tx * 256 - minPxX) * k + leftPad, sy = (ty * 256 - minPxY) * k + topPad;
      // Mapbox Outdoors: cartografia sintetica con rilievo (monti/salite-discese),
      // acqua azzurra, verde e nomi delle località. @2x per nitidezza in stampa.
      const url = MAPBOX_TOKEN
        ? `https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/256/${z}/${tx}/${ty}@2x?access_token=${MAPBOX_TOKEN}`
        : `https://a.basemaps.cartocdn.com/light_nolabels/${z}/${tx}/${ty}.png`;
      imgs += `<image href="${url}" xlink:href="${url}" x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${(tsz + 0.5).toFixed(1)}" height="${(tsz + 0.5).toFixed(1)}" preserveAspectRatio="none"/>`;
    }
  }
  const attrib = MAPBOX_TOKEN ? "© Mapbox · © OpenStreetMap" : "© OpenStreetMap · © CARTO";
  const tiles = `<g opacity="${MAPBOX_TOKEN ? "0.7" : "0.6"}">${imgs}</g>`
    + `<text x="${(W - 4).toFixed(0)}" y="${(H - 3).toFixed(0)}" text-anchor="end" font-size="7" fill="#9aa">${attrib}</text>`;
  return { tiles, P };
}

/** Markup interno <svg> (senza wrapper): linee octolineari che CONVERGONO nei
 *  nodi condivisi, fermate con nome, sfondo punti città e (opz.) cartografia. */
/**
 * Layout "METROPOLITANA": deforma le posizioni dei nodi (partendo da quelle
 * geografiche) fino a una mappa schematica in stile metro — come le mappe
 * TPL cittadine: tratte snappate a 45°/90°, lunghezze quasi uniformi
 * (indipendenti dai km reali), nodi mai sovrapposti. La geografia resta
 * riconoscibile perché il rilassamento parte dal disegno reale e lo deforma
 * localmente, senza stravolgere l'ordine relativo dei quartieri.
 * Muta `pos` in place. Deterministico (niente random).
 */
function metroLayout(
  pos: Map<string, { x: number; y: number }>,
  edges: Array<[string, string]>,
  W: number, H: number, M: number,
  paths: string[][] = [],
  minorEdge: boolean[] = [],
): void {
  if (pos.size < 2 || edges.length === 0) return;
  const rawLens = edges
    .map(([a, b]) => { const A = pos.get(a)!, B = pos.get(b)!; return Math.hypot(B.x - A.x, B.y - A.y); });
  const sorted = rawLens.filter((l) => l > 1e-6).sort((x, y) => x - y);
  const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 40;
  // PROPORZIONE LOGARITMICA: lunghezza target per arco calcolata UNA volta
  // dalle lunghezze GEOGRAFICHE originali. Sopra la mediana la crescita è
  // logaritmica (una tratta 10× più lunga occupa ~2× sulla mappa, cap 2.1×):
  // le diramazioni extraurbane chilometriche non espandono più lo schema e il
  // centro resta leggibile. Sotto la mediana quasi-uniforme (mai < 0.62×).
  // NB: target FISSI, non ricalcolati dalla lunghezza corrente — altrimenti il
  // rilassamento collasserebbe tutte le tratte all'uniformità totale,
  // perdendo ogni proporzione.
  const targetLen = edges.map((_, i) => {
    const r = (rawLens[i] || med) / med;
    let L = r <= 1
      ? med * Math.max(0.55, 0.72 + 0.18 * r)
      : med * Math.min(1.6, 1 + Math.log(r) * 0.45);
    // CATENE di fermate minori (entrambi gli estremi non-nodo, grado ≤ 2):
    // spaziatura più fitta, come nel riferimento — le diramazioni con tante
    // fermate intermedie si ACCORCIANO, i nodi importanti respirano.
    if (minorEdge[i]) L *= 0.8;
    return L;
  });
  const ITER = 160;
  const keys = [...pos.keys()];
  const minD = Math.max(10, med * 0.35);       // distanza minima tra nodi (leggibilità)
  for (let it = 0; it < ITER; it++) {
    const damp = 0.22 * (1 - it / ITER) + 0.06; // rilassamento decrescente → converge stabile
    const disp = new Map<string, { x: number; y: number; n: number }>();
    const add = (k: string, dx: number, dy: number) => {
      const d = disp.get(k) ?? { x: 0, y: 0, n: 0 };
      d.x += dx; d.y += dy; d.n += 1; disp.set(k, d);
    };
    for (let ei = 0; ei < edges.length; ei++) {
      const [a, b] = edges[ei];
      const A = pos.get(a)!, B = pos.get(b)!;
      const dx = B.x - A.x, dy = B.y - A.y;
      const snap = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const L = targetLen[ei];
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      const tx = Math.cos(snap) * L / 2, ty = Math.sin(snap) * L / 2;
      add(a, mx - tx - A.x, my - ty - A.y);
      add(b, mx + tx - B.x, my + ty - B.y);
    }
    // COLLINEARITÀ (il tratto distintivo delle mappe metro vere): le fermate
    // consecutive devono giacere su LUNGHI RETTIFILI, con poche pieghe nette.
    // Ogni nodo interno con svolta DOLCE (< ~34°) viene tirato sulla retta tra
    // i suoi vicini → le micro-svolte da snap indipendente si appiattiscono,
    // sopravvivono solo le pieghe geografiche vere (≥ 45°).
    for (const path of paths) {
      for (let i = 1; i < path.length - 1; i++) {
        const A = pos.get(path[i - 1])!, B = pos.get(path[i])!, C = pos.get(path[i + 1])!;
        const a1 = Math.atan2(B.y - A.y, B.x - A.x);
        const a2 = Math.atan2(C.y - B.y, C.x - B.x);
        let dAng = Math.abs(a2 - a1);
        if (dAng > Math.PI) dAng = 2 * Math.PI - dAng;
        if (dAng < (Math.PI / 4) * 0.75) {
          // proiezione sulla retta OCTOLINEARE più vicina alla congiungente
          // A→C (non sulla congiungente qualsiasi): così il rettifilo nasce
          // già squadrato e non litiga con lo snap a 45° degli archi.
          const acx = C.x - A.x, acy = C.y - A.y;
          const sAng = Math.round(Math.atan2(acy, acx) / (Math.PI / 4)) * (Math.PI / 4);
          const ux = Math.cos(sAng), uy = Math.sin(sAng);
          const mx = (A.x + C.x) / 2, my = (A.y + C.y) / 2;
          const t = (B.x - mx) * ux + (B.y - my) * uy;
          const px = mx + ux * t, py = my + uy * t;
          // peso > 1: la collinearità DOMINA sullo snap per-arco, così anche
          // le svolte ambigue (~25-30°) si risolvono in rettifilo netto invece
          // di restare a metà strada (tiro alla fune tra le due forze)
          add(path[i], (px - B.x) * 1.6, (py - B.y) * 1.6);
        }
      }
    }
    // repulsione leggera: due nodi troppo vicini si respingono
    for (let i = 0; i < keys.length; i++) {
      const A = pos.get(keys[i])!;
      for (let j = i + 1; j < keys.length; j++) {
        const B = pos.get(keys[j])!;
        const dx = B.x - A.x, dy = B.y - A.y;
        const d = Math.hypot(dx, dy);
        if (d > 1e-6 && d < minD) {
          const push = (minD - d) * 0.25, ux = dx / d, uy = dy / d;
          add(keys[i], -ux * push, -uy * push);
          add(keys[j], ux * push, uy * push);
        }
      }
    }
    for (const [k, d] of disp) {
      const p = pos.get(k)!;
      p.x += (d.x / d.n) * damp * 2;
      p.y += (d.y / d.n) * damp * 2;
    }
  }
  // refit centrato nel riquadro di disegno (aspect preservato)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const xr = (maxX - minX) || 1e-6, yr = (maxY - minY) || 1e-6;
  const s = Math.min((W - 2 * M) / xr, (H - 2 * M) / yr);
  const ox = M + ((W - 2 * M) - xr * s) / 2, oy = M + ((H - 2 * M) - yr * s) / 2;
  for (const p of pos.values()) { p.x = ox + (p.x - minX) * s; p.y = oy + (p.y - minY) * s; }
}

function schematicInnerSvg(
  lines: SchemLine[], W: number, H: number, M: number,
  opts?: { nameSize?: number; nodesOnly?: boolean; cityNodes?: Array<{ name: string; lat: number; lon: number }>; basemap?: boolean; labelMode?: NetNodeLabels; metro?: boolean },
): string {
  const nameSize = opts?.nameSize ?? 8;
  // Stile tratto PER-LINEA: continuo (default), tratteggiato o puntinato. I
  // valori sono in unità SVG; per i puntini ci affidiamo al linecap "round".
  const dashFor = (style: NetLineStyle | undefined): string =>
    style === "dashed" ? ' stroke-dasharray="16 10"'
      : style === "dotted" ? ' stroke-dasharray="0.5 13"'
      : "";
  // Etichette: "all" mostra il nome di ogni fermata; "logical" mostra solo i nomi
  // dei nodi logici (le altre fermate restano un semplice pallino).
  const labelMode: NetNodeLabels = opts?.labelMode ?? "all";
  const src = opts?.nodesOnly
    ? lines.map((l) => ({ color: l.color, style: l.style, stops: collapseToLogicalNodes(l.stops) }))
    : lines;
  const usable = src.filter((l) => l.stops.length > 0);
  if (!usable.length) return "";

  // FUSIONE FERMATE GEMELLE (solo stile metro): andata e ritorno fermano
  // spesso su LATI OPPOSTI della strada in due fermate fisiche distinte → la
  // mappa le disegnava come due nodi e due assi paralleli, raddoppiando ogni
  // corridoio. Nelle mappe metro vere le due direzioni sono UN solo asse con
  // UN pallino. Union-find sulle fermate: stesso cluster, stesso nome
  // (normalizzato) entro 250 m, o distanza < 80 m → stesso nodo. La posizione
  // del nodo fuso è la media delle occorrenze (già gestita a valle): il
  // pallino cade in mezzeria strada.
  let mergeOf: Map<string, string> | null = null;
  if (opts?.metro) {
    const stopsById = new Map<string, SchemStop>();
    for (const l of usable) for (const s of l.stops) if (!stopsById.has(s.stopId)) stopsById.set(s.stopId, s);
    const ids = [...stopsById.keys()];
    const parent = new Map<string, string>(ids.map((i) => [i, i]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const norm = (n: string) => (n || "").toLowerCase().replace(/[^a-z0-9à-ù]+/g, " ").trim();
    const distM = (a: SchemStop, b: SchemStop) => {
      const kx = 111320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
      return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * 110540);
    };
    for (let i = 0; i < ids.length; i++) {
      const A = stopsById.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const B = stopsById.get(ids[j])!;
        const d = distM(A, B);
        const sameCluster = !!A.clusterId && A.clusterId === B.clusterId;
        if (sameCluster || d < 80 || (d < 250 && norm(A.name) === norm(B.name))) union(ids[i], ids[j]);
      }
    }
    mergeOf = new Map(ids.map((i) => [i, find(i)]));
  }

  // CHIAVE NODO: per le fermate di un nodo logico (cluster isLogical) si usa il
  // cluster + il suo centroide → linee diverse che toccano lo stesso nodo logico
  // CONVERGONO nello stesso punto, anche senza "Solo nodi logici".
  const keyOf = (s: SchemStop) => (s.clusterLogical && s.clusterId)
    ? `c:${s.clusterId}`
    : (mergeOf ? `m:${mergeOf.get(s.stopId) ?? s.stopId}` : `s:${s.stopId}`);
  const posOf = (s: SchemStop) => (s.clusterLogical)
    ? { lon: s.clusterLon ?? s.lon, lat: s.clusterLat ?? s.lat, name: s.clusterName || s.name, logical: true }
    : { lon: s.lon, lat: s.lat, name: s.name, logical: false };

  // posizione geografica CANONICA per nodo (media occorrenze, lon/lat grezzi)
  const node = new Map<string, SchemNode>();
  usable.forEach((l, li) => l.stops.forEach((s) => {
    const k = keyOf(s); const p = posOf(s);
    let e = node.get(k);
    if (!e) { e = { lon: 0, lat: 0, n: 0, name: p.name, lines: new Set<number>(), logical: p.logical }; node.set(k, e); }
    e.lon += p.lon; e.lat += p.lat; e.n += 1; e.lines.add(li); if (p.logical) e.logical = true;
  }));
  for (const e of node.values()) { e.lon /= e.n; e.lat /= e.n; }

  const cityNodes = (opts?.cityNodes ?? []).map((c) => ({ name: c.name, lon: c.lon, lat: c.lat }));
  const geoPts = [...[...node.values()].map((e) => ({ lon: e.lon, lat: e.lat })), ...cityNodes.map((c) => ({ lon: c.lon, lat: c.lat }))];

  // Proiezione: Web Mercator + tile cartografiche (se basemap), altrimenti
  // equirettangolare scalata a riempire la pagina.
  let P: (lon: number, lat: number) => { x: number; y: number };
  let tilesLayer = "";
  // in stile METRO niente cartografia/città: la geografia è deformata,
  // qualunque sfondo reale risulterebbe fuorviante
  if (opts?.basemap && !opts?.metro && geoPts.length) {
    const mt = mercatorTiles(geoPts, W, H, M);
    P = mt.P; tilesLayer = mt.tiles;
  } else {
    const meanLat = geoPts.reduce((s, p) => s + p.lat, 0) / (geoPts.length || 1);
    const cosLat = Math.cos((meanLat * Math.PI) / 180) || 1;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of geoPts) { const x = p.lon * cosLat; if (x < minX) minX = x; if (x > maxX) maxX = x; if (p.lat < minY) minY = p.lat; if (p.lat > maxY) maxY = p.lat; }
    const xr = (maxX - minX) || 1e-6, yr = (maxY - minY) || 1e-6;
    P = (lon: number, lat: number) => ({ x: M + ((lon * cosLat - minX) / xr) * (W - 2 * M), y: M + (1 - (lat - minY) / yr) * (H - 2 * M) });
  }

  // Posizione FINALE di ogni nodo: geografica proiettata, oppure — in stile
  // metro — schematizzata (45°/90°, lunghezze uniformi) da metroLayout.
  const pos = new Map<string, { x: number; y: number }>();
  for (const [k, e] of node) pos.set(k, P(e.lon, e.lat));
  if (opts?.metro) {
    const eKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const seenE = new Set<string>();
    const edges: Array<[string, string]> = [];
    const paths: string[][] = [];
    usable.forEach((l) => {
      const path: string[] = [];
      for (const s of l.stops) {
        const k = keyOf(s);
        if (path[path.length - 1] !== k) path.push(k);
      }
      if (path.length >= 2) paths.push(path);
      for (let i = 1; i < path.length; i++) {
        const pk = eKey(path[i - 1], path[i]);
        if (!seenE.has(pk)) { seenE.add(pk); edges.push([path[i - 1], path[i]]); }
      }
    });
    // grado di ogni nodo nel grafo (per riconoscere le catene di fermate minori)
    const degree = new Map<string, number>();
    for (const [a, b] of edges) {
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const isMinor = (k: string) => !(node.get(k)?.logical) && (degree.get(k) ?? 0) <= 2;
    const minorEdge = edges.map(([a, b]) => isMinor(a) && isMinor(b));
    metroLayout(pos, edges, W, H, M, paths, minorEdge);
  }

  // sfondo città (leggero, grigio) — salta i punti che coincidono con un nodo disegnato
  const drawnPos = new Set([...node.values()].map((e) => `${e.lon.toFixed(5)},${e.lat.toFixed(5)}`));
  const bg = opts?.metro ? "" : cityNodes
    .filter((c) => !drawnPos.has(`${c.lon.toFixed(5)},${c.lat.toFixed(5)}`))
    .map((c) => {
      const { x, y } = P(c.lon, c.lat);
      return `<g opacity="0.5"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#94a3b8"/>`
        + `<text x="${(x + 5).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="${(nameSize - 0.5).toFixed(1)}" fill="#64748b">${esc(c.name)}</text></g>`;
    }).join("");

  // Spessore tratto calibrato sul numero di linee disegnate: con poche linee il
  // tratto resta pieno (7), con tante si assottiglia per non impastare la mappa.
  const nLines = usable.length;

  // Corridoi condivisi: per ogni COPPIA di nodi consecutivi registriamo quali
  // linee la percorrono. Dove più linee si sovrappongono le AFFIANCHIAMO (offset
  // perpendicolare) invece di disegnarle una sopra l'altra, così si distinguono.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairLines = new Map<string, number[]>();
  usable.forEach((l, li) => {
    for (let i = 1; i < l.stops.length; i++) {
      const ka = keyOf(l.stops[i - 1]), kb = keyOf(l.stops[i]);
      if (ka === kb) continue;
      const pk = pairKey(ka, kb);
      const arr = pairLines.get(pk) ?? [];
      if (!arr.includes(li)) { arr.push(li); pairLines.set(pk, arr); }
    }
  });
  let maxOverlap = 1;
  for (const arr of pairLines.values()) if (arr.length > maxOverlap) maxOverlap = arr.length;

  // con corridoi condivisi si assottiglia il tratto per fare spazio all'affiancamento
  const baseW = Math.max(2.4, Math.min(7, 7 - (nLines - 3) * 0.42));
  const strokeW = maxOverlap > 1 ? Math.max(2.0, Math.min(baseW, 4.2)) : baseW;
  const gap = Math.max(2.6, strokeW * 0.95); // distanza tra due linee affiancate

  // polilinee: estremi sui nodi (convergenza) + gomiti octolineari tra nodi,
  // con offset perpendicolare per le linee che condividono lo stesso corridoio.
  const polys = usable.map((l, li) => {
    const pts = l.stops.map((s) => ({ k: keyOf(s), p: pos.get(keyOf(s))! }));
    if (!pts.length) return "";
    let d = "";
    let prevEnd: { x: number; y: number } | null = null;
    for (let i = 1; i < pts.length; i++) {
      const A = pts[i - 1].p, B = pts[i].p;
      if (pts[i - 1].k === pts[i].k) continue; // stesso nodo → nessun tratto
      const arr = pairLines.get(pairKey(pts[i - 1].k, pts[i].k)) ?? [li];
      const rank = arr.indexOf(li);
      const off = (rank - (arr.length - 1) / 2) * gap; // 0 se linea unica sul corridoio
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
      const ox = (-dy / len) * off, oy = (dx / len) * off;
      const A2 = { x: A.x + ox, y: A.y + oy }, B2 = { x: B.x + ox, y: B.y + oy };
      if (!d) { d = `${A2.x.toFixed(1)},${A2.y.toFixed(1)}`; }
      else if (prevEnd && (Math.abs(prevEnd.x - A2.x) > 0.1 || Math.abs(prevEnd.y - A2.y) > 0.1)) {
        d += ` ${A2.x.toFixed(1)},${A2.y.toFixed(1)}`; // raccordo al nuovo offset sul nodo condiviso
      }
      for (const e of elbow(A2.x, A2.y, B2.x, B2.y)) d += ` ${e.x.toFixed(1)},${e.y.toFixed(1)}`;
      prevEnd = B2;
    }
    if (!d) { const p0 = pos.get(keyOf(l.stops[0]))!; d = `${p0.x.toFixed(1)},${p0.y.toFixed(1)}`; }
    return `<polyline points="${d}" fill="none" stroke="${lineColor(l.color)}" stroke-width="${strokeW.toFixed(1)}" stroke-linejoin="round" stroke-linecap="round"${dashFor(l.style)} opacity="0.92"/>`;
  }).join("");

  // nodi + nomi
  let dots = "", names = "", idx = 0;
  for (const [k, e] of node) {
    const { x, y } = pos.get(k)!;
    // SOLO i nodi logici (cluster isLogical) sono "maggiori": le fermate dove
    // passano più linee NON vengono ingrandite solo per questo motivo.
    const major = e.logical;
    // In modalità "logical" mostriamo il nome solo per i nodi logici: le altre
    // fermate restano un pallino senza etichetta (meno caos).
    const showName = e.logical || labelMode === "all";
    if (major) {
      // Raggio del cluster proporzionale al numero di linee che vi transitano:
      // cluster con più linee = cerchio più grande, con una sola = più piccolo.
      // Tenuto compatto per non coprire la mappa.
      const nl = e.lines.size;
      const r = Math.min(7.5, 3 + (nl - 1) * 1.3);
      const sw = nl >= 2 ? 2 : 1.5;
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#fff" stroke="#111" stroke-width="${sw}"/>`;
      if (showName) names += `<text x="${(x + r + 3).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="${nameSize + 1.5}" font-weight="800" fill="#111" stroke="#fff" stroke-width="0.6" paint-order="stroke">${esc(e.name)}</text>`;
    } else {
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.1" fill="#fff" stroke="#111" stroke-width="1.2"/>`;
      if (showName) {
        const up = idx % 2 === 0;
        names += `<text x="${(x + 5).toFixed(1)}" y="${(y + (up ? -5 : 9)).toFixed(1)}" font-size="${nameSize}" fill="#333" stroke="#fff" stroke-width="0.5" paint-order="stroke">${esc(e.name)}</text>`;
      }
    }
    idx++;
  }
  return tilesLayer + bg + polys + dots + names;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * STAMPA ORARI UNICA (A4 orizzontale) — per CALENDARIO aziendale
 * ───────────────────────────────────────────────────────────────────────────
 * Un solo documento per linea, a partire dal calendario scelto (Scuole Aperte /
 * Chiuse). Sorgente dati = validità reale Lun→Dom di quel periodo (endpoint
 * /week). Contenuto:
 *   1. intestazione: linea + descrizione + badge del calendario;
 *   2. mappa metropolitana ORIZZONTALE della linea (striscia a tutta larghezza);
 *   3. orari divisi per Andata e Ritorno, TUTTE le corse in un'unica tabella per
 *      direzione. Per ogni corsa: striscia L…D (giorni di effettuazione), colore
 *      colonna + legenda per «a chiamata» (viola) e «validità particolare»
 *      (ambra, giorni limitati). Le corse FESTIVE/domenicali stanno in una
 *      SEZIONE ROSSA separata, per non mischiarle col servizio feriale.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Iniziali compatte dei giorni feriali (Lun-Sab) per le note in colonna. */
const WD_INI = ["L", "Ma", "Me", "G", "V", "S"];

/** Restrizione di validità di una corsa (mostrata come iniziali colorate +
 *  descrizione in legenda): `excl` = esclusi alcuni giorni (iniziali rosse),
 *  `only` = circola solo in alcuni giorni (iniziali verdi). */
interface UniRestr { kind: "excl" | "only"; idxs: number[]; desc: string }
/** Corsa nella vista unica: orari + eventuale restrizione + a chiamata. */
interface UniTrip { dep: string; cells: string[]; onDemand: boolean; restr: UniRestr | null }
interface UniDir {
  dirLabel: string;
  stops: Array<{ name: string; term: boolean }>;
  regular: UniTrip[];  // servizio Lun-Sab
  festive: UniTrip[];  // servizio festivo/domenica → sezione rossa separata
}
interface LineTTDoc {
  route: RouteTimetable["route"];
  mapStops: Array<{ name: string; term: boolean }>;
  category: { code: string; name: string };
  directions: UniDir[];
}

/** Marchio Cerbero: tre teste di cane stilizzate (blu) — logo del footer stampa. */
const cerbHead = (cx: number, cy: number) =>
  `<path d="M${cx - 9} ${cy - 3} L${cx - 11} ${cy - 13} L${cx - 2} ${cy - 8} Z"/>`
  + `<path d="M${cx + 9} ${cy - 3} L${cx + 11} ${cy - 13} L${cx + 2} ${cy - 8} Z"/>`
  + `<circle cx="${cx}" cy="${cy}" r="8"/>`
  + `<path d="M${cx - 4} ${cy + 5} L${cx + 4} ${cy + 5} L${cx + 2} ${cy + 12} L${cx - 2} ${cy + 12} Z"/>`;
const CERBERO_LOGO = `<svg class="cerbero" viewBox="0 0 66 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g fill="#1d4ed8">${cerbHead(15, 18)}${cerbHead(51, 18)}${cerbHead(33, 13)}</g></svg>`;

const LINE_TT_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 landscape; margin: 8mm 8mm 12mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header.doc h1 .desc { font-weight: 400; font-size: 15px; color: #334155; }
  .cal-badge { display: inline-block; background: #0e7490; color: #fff; font-size: 11px; font-weight: 800; border-radius: 6px; padding: 2px 10px; }
  .linemap { border: 1px solid #e2e8f0; border-radius: 8px; padding: 4px 10px 0; margin: 6px 0 10px; background: #fff; break-inside: avoid; }
  .dirgrp { margin-bottom: 10px; }
  .dirh { font-size: 13px; font-weight: 800; color: #0f172a; margin: 8px 0 4px; display: flex; align-items: center; gap: 8px; break-after: avoid; }
  .dirh .arrow { display: inline-block; width: 16px; height: 8px; border-radius: 2px; }
  .festh { font-size: 11px; font-weight: 800; color: #fff; background: #dc2626; padding: 2px 10px; border-radius: 4px; margin: 4px 0 3px; display: inline-block; break-after: avoid; }
  table.ltt { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  table.ltt th, table.ltt td { border: 1px solid #cbd5e1; font-size: 9px; padding: 1px 3px; text-align: center; font-variant-numeric: tabular-nums; }
  table.ltt th.stop { text-align: left; background: #f1f5f9; font-weight: 700; max-width: 54mm; min-width: 34mm; }
  table.ltt th.stop.head { background: #0f172a; color: #fff; }
  table.ltt th.stop.term { background: #e2e8f0; }
  table.ltt td.term { font-weight: 800; }
  table.ltt th.trip { color: #fff; font-weight: 800; vertical-align: top; background: #334155; }
  table.ltt th.trip.fe { background: #dc2626; }               /* colonna festiva/domenica */
  table.ltt th.trip .dep { font-size: 10px; }
  /* marcatori COMPATTI: ☎ a chiamata (viola), iniziali giorni rosse (escluso)
     o verdi (solo) — la descrizione completa è in legenda */
  table.ltt th.trip .marks { margin-top: 1px; font-size: 8.5px; font-weight: 800; letter-spacing: .5px; line-height: 1; }
  table.ltt th.trip .marks .tel { color: #c4b5fd; font-size: 10px; }
  table.ltt th.trip .marks .excl { color: #fca5a5; }
  table.ltt th.trip .marks .only { color: #86efac; }
  table.ltt td.fe { background: #fef2f2; }
  table.ltt tbody tr:nth-child(even) td { background: #fafafa; }
  table.ltt tbody tr:nth-child(even) td.fe { background: #fde8e8; }
  .ltt-legend { margin-top: 6px; font-size: 9px; color: #222; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .ltt-legend .lg-lbl { font-weight: 800; }
  .ltt-legend .sw { display: inline-block; width: 11px; height: 11px; border: 1px solid #94a3b8; margin-right: 4px; vertical-align: -2px; border-radius: 2px; }
  .ltt-legend .sw.fe { background: #dc2626; }
  .ltt-legend .k-tel { color: #6d28d9; font-weight: 800; }
  .ltt-legend .k-excl { color: #dc2626; font-weight: 800; }
  .ltt-legend .k-only { color: #16a34a; font-weight: 800; }
  /* marchio ripetuto su OGNI foglio (footer fisso, molto piccolo) */
  .brandfix { position: fixed; left: 8mm; right: 8mm; bottom: 4mm; display: flex; align-items: center; justify-content: space-between; font-size: 7px; color: #64748b; }
  .brandfix .pw { display: flex; align-items: center; gap: 4px; }
  .brandfix .pw b { color: #1d4ed8; font-weight: 800; }
  .cerbero { height: 15px; width: auto; display: inline-block; vertical-align: middle; }
`;

/** Striscia di linea ORIZZONTALE (stile diagramma metro): fermate equidistanti
 *  su un asse, capolinea in evidenza, nomi a 45°. Usa tutta la larghezza del
 *  foglio ed è il modo più leggibile di rappresentare UNA linea. */
function lineStripSvg(stops: Array<{ name: string; term: boolean }>, color: string | null): string {
  const col = lineColor(color);
  const n = stops.length;
  if (n < 2) return "";
  const W = 1200, padX = 40;
  const usable = W - padX * 2;
  const gap = usable / (n - 1);
  const fs = Math.max(7, Math.min(11, gap * 0.5));
  const maxName = Math.max(...stops.map((s) => s.name.length));
  const nameH = Math.min(220, Math.max(60, maxName * fs * 0.52));
  const axisY = 22;
  const H = axisY + nameH + 14;
  const x = (i: number) => padX + i * gap;
  const line = `<line x1="${x(0).toFixed(1)}" y1="${axisY}" x2="${x(n - 1).toFixed(1)}" y2="${axisY}" stroke="${col}" stroke-width="6" stroke-linecap="round"/>`;
  const dots = stops.map((s, i) => {
    const r = s.term ? 6.5 : 3.4;
    return `<circle cx="${x(i).toFixed(1)}" cy="${axisY}" r="${r}" fill="#fff" stroke="${col}" stroke-width="${s.term ? 3 : 2}"/>`;
  }).join("");
  const ny = axisY + 12;
  const names = stops.map((s, i) =>
    `<text x="${x(i).toFixed(1)}" y="${ny}" transform="rotate(45 ${x(i).toFixed(1)} ${ny})" font-size="${fs.toFixed(1)}" font-weight="${s.term ? 800 : 400}" fill="#111" text-anchor="start">${esc(s.name)}</text>`,
  ).join("");
  return `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" width="100%" style="display:block; max-height:70mm">${line}${dots}${names}</svg>`;
}

function lineTimetableDoc(doc: LineTTDoc): string {
  const col = lineColor(doc.route.color);

  const map = doc.mapStops.length >= 2
    ? `<div class="linemap">${lineStripSvg(doc.mapStops, doc.route.color)}</div>` : "";

  const PER = 20; // corse per tabella (larghezza foglio)
  // Intestazione COMPATTA: solo l'orario + marcatori (☎ a chiamata, iniziali
  // rosse=giorni esclusi, verdi=unici giorni). Le descrizioni stanno in legenda.
  const renderTables = (stops: UniDir["stops"], trips: UniTrip[], fe: boolean) => {
    const chunks: UniTrip[][] = [];
    for (let i = 0; i < trips.length; i += PER) chunks.push(trips.slice(i, i + PER));
    return chunks.map((ch) => {
      const head = `<tr><th class="stop head">Fermata</th>${ch.map((t) => {
        const marks: string[] = [];
        if (t.onDemand) marks.push(`<span class="tel">☎</span>`);
        if (!fe && t.restr) {
          const cl = t.restr.kind === "excl" ? "excl" : "only";
          marks.push(`<span class="${cl}">${t.restr.idxs.map((i) => WD_INI[i]).join(" ")}</span>`);
        }
        const m = marks.length ? `<div class="marks">${marks.join(" ")}</div>` : "";
        return `<th class="trip${fe ? " fe" : ""}"><div class="dep">${esc(t.dep)}</div>${m}</th>`;
      }).join("")}</tr>`;
      const rows = stops.map((s, i) =>
        `<tr><th class="stop${s.term ? " term" : ""}">${esc(s.name)}</th>${ch.map((t) =>
          `<td class="${fe ? "fe" : ""}${s.term ? " term" : ""}">${t.cells[i] || "·"}</td>`).join("")}</tr>`).join("");
      return `<table class="ltt"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
    }).join("");
  };

  const dirBlocks = doc.directions.map((dir) => {
    const parts: string[] = [];
    if (dir.regular.length) parts.push(renderTables(dir.stops, dir.regular, false));
    if (dir.festive.length) {
      parts.push(`<div class="festh">Corse festive / domenicali</div>${renderTables(dir.stops, dir.festive, true)}`);
    }
    if (!parts.length) return "";
    const nTot = dir.regular.length + dir.festive.length;
    return `<div class="dirgrp"><h3 class="dirh"><span class="arrow" style="background:${col}"></span>${esc(dir.dirLabel)} · ${nTot} corse</h3>${parts.join("")}</div>`;
  }).join("");

  // legenda: descrizioni delle note (iniziali colorate) + a chiamata + festive
  let anyOd = false, anyFe = false;
  const restrs = new Map<string, UniRestr>(); // desc → restr (deduplicato)
  for (const d of doc.directions) {
    for (const t of d.regular) { if (t.onDemand) anyOd = true; if (t.restr) restrs.set(t.restr.desc, t.restr); }
    if (d.festive.length) anyFe = true;
    for (const t of d.festive) if (t.onDemand) anyOd = true;
  }
  const legItems: string[] = [];
  legItems.push(`<span>Senza note = corsa feriale (Lun-Sab)</span>`);
  // prima gli "esclusi" (rosso), poi i "solo" (verde)
  const restrList = [...restrs.values()].sort((a, b) =>
    a.kind === b.kind ? a.desc.localeCompare(b.desc) : (a.kind === "excl" ? -1 : 1));
  for (const r of restrList) {
    const cl = r.kind === "excl" ? "k-excl" : "k-only";
    legItems.push(`<span><span class="${cl}">${r.idxs.map((i) => WD_INI[i]).join(" ")}</span> = ${esc(r.desc)}</span>`);
  }
  if (anyOd) legItems.push(`<span><span class="k-tel">☎</span> = a chiamata (su prenotazione)</span>`);
  if (anyFe) legItems.push(`<span><span class="sw fe"></span>Corse festive / domenicali (colonne rosse)</span>`);
  const legend = `<div class="ltt-legend"><span class="lg-lbl">Legenda:</span>${legItems.join("")}</div>`;

  const desc = doc.route.longName ? ` — <span class="desc">${esc(doc.route.longName)}</span>` : "";
  return `
  <section class="page">
    <header class="doc" style="border-color:${col}">
      <div class="pill" style="background:${col}">${esc(doc.route.shortName ?? "?")}</div>
      <h1>Linea ${esc(doc.route.shortName ?? "")}${desc}</h1>
      <div class="day"><span class="cal-badge">${esc(doc.category.name)}</span><br><small style="font-weight:400">Lun→Dom · Andata/Ritorno</small></div>
    </header>
    ${map}
    ${dirBlocks || "<p style='padding:12px;color:#666'>Nessuna corsa per il calendario selezionato.</p>"}
    ${legend}
  </section>`;
}

/** Logo Cerbero (public/logo.png) rimpicciolito in un data URI, così è sempre
 *  presente nella stampa (niente dipendenze di rete/origine). Cache in-memory;
 *  se il caricamento fallisce si ripiega sul marchio SVG disegnato. */
let _cerberoLogo: string | null | undefined;
async function cerberoLogoDataUrl(): Promise<string | null> {
  if (_cerberoLogo !== undefined) return _cerberoLogo;
  try {
    _cerberoLogo = await new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const maxW = 300;
        const scale = Math.min(1, maxW / (img.naturalWidth || maxW));
        const w = Math.max(1, Math.round((img.naturalWidth || maxW) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || maxW) * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) { reject(new Error("no canvas ctx")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("logo load failed"));
      img.src = `${import.meta.env.BASE_URL}logo.png`;
    });
  } catch { _cerberoLogo = null; }
  return _cerberoLogo;
}

function buildLineTimetableHtml(docs: LineTTDoc[], logoDataUrl?: string | null): string {
  const has = (d: LineTTDoc) => d.directions.some((x) => x.regular.length > 0 || x.festive.length > 0);
  const body = docs.filter(has).map(lineTimetableDoc).join("");
  const gen = new Date().toLocaleString("it-IT");
  const logo = logoDataUrl ? `<img class="cerbero" src="${logoDataUrl}" alt="Cerbero" />` : CERBERO_LOGO;
  // marchio ripetuto su OGNI foglio (footer fisso, molto piccolo)
  const brand = `<div class="brandfix"><span>Generato il ${gen}</span><span class="pw">${logo}<span>powered by <b>Cerbero Analytics</b></span></span></div>`;
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Orari di linea</title>
  <style>${LINE_TT_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna corsa per la selezione.</p>"}${brand}</body></html>`;
}

/* ── Mappa di rete (SVG): linee selezionate + interscambi (fermate condivise) ── */

interface NetworkLine {
  routeId: string; shortName: string | null; longName: string | null; color: string | null;
  stops: Array<{
    stopId: string; name: string; lat: number; lon: number;
    clusterId?: string | null; clusterName?: string | null;
    clusterLogical?: boolean; clusterLat?: number | null; clusterLon?: number | null;
  }>;
}
interface NetworkData { projectId: string; lines: NetworkLine[]; cityNodes?: Array<{ name: string; lat: number; lon: number }> }

function buildNetworkMapHtml(data: NetworkData, nodesOnly = false, cityBg = false, mapBg = false, logoUrl = "", lineStyles: Record<string, NetLineStyle> = {}, nodeLabels: NetNodeLabels = "logical", rotate = 0, metro = false): string {
  const lines = (data.lines ?? []).filter((l) => l.stops.length > 0);
  const gen = new Date().toLocaleString("it-IT");
  if (!lines.length) {
    return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Mappa rete</title></head>
    <body><p style="padding:20mm;font-family:Arial">Nessuna geometria fermate per le linee selezionate.</p></body></html>`;
  }

  // interscambi (per il conteggio nell'header): stopId servito da ≥2 linee
  const byStop = new Map<string, Set<string>>();
  for (const l of lines) for (const s of l.stops) {
    if (!byStop.has(s.stopId)) byStop.set(s.stopId, new Set());
    byStop.get(s.stopId)!.add(l.routeId);
  }
  const interCount = [...byStop.values()].filter((r) => r.size >= 2).length;

  // Stile METRO su A3 ORIZZONTALE (come le mappe TPL da parete, rif. Jesi):
  // molto più spazio in larghezza per rettifili e etichette. Geografica: A4
  // verticale invariato.
  const W = metro ? 1414 : 1000, H = metro ? 1000 : 1414, M = 42; // margine interno ridotto → mappa più ampia
  const legendH = lines.length * 18 + 10;
  const Hd = H - legendH - 12;                 // altezza area schema (sopra la legenda)
  const rot = (((Math.round(rotate / 90) * 90) % 360) + 360) % 360; // 0/90/180/270
  const swap = rot === 90 || rot === 270;
  const dW = swap ? Hd : W, dH = swap ? W : Hd; // dimensioni con cui disegnare lo schema
  const svgInner = schematicInnerSvg(
    lines.map((l) => ({ color: l.color, stops: l.stops, style: lineStyles[l.routeId] ?? "solid" })),
    dW, dH, M, { nameSize: 9, nodesOnly, cityNodes: cityBg ? data.cityNodes : undefined, basemap: mapBg, labelMode: nodeLabels, metro },
  );
  // Rotazione della mappa in stampa: ruota il contenuto attorno al proprio centro
  // e lo ricentra nell'area schema (legenda ed header restano fissi e leggibili).
  const svgBody = rot === 0
    ? svgInner
    : `<g transform="translate(${(W / 2).toFixed(1)},${(Hd / 2).toFixed(1)}) rotate(${rot}) translate(${(-dW / 2).toFixed(1)},${(-dH / 2).toFixed(1)})">${svgInner}</g>`;
  const legendRows = lines.map((l, i) =>
    `<g transform="translate(0,${i * 18})"><rect width="14" height="9" rx="2" fill="${lineColor(l.color)}"/>`
    + `<text x="20" y="8" font-size="9.5" fill="#111"><tspan font-weight="800">${esc(l.shortName ?? "?")}</tspan> ${esc(l.longName ?? "")}</text></g>`).join("");

  const hero = `<div class="hero">
      ${logoUrl ? `<img src="${logoUrl}" alt="logo" />` : ""}
      <div class="t"><h1>${metro ? "Mappa di Rete — stile Metropolitana" : "Mappa di Rete"}</h1><div class="sub">${metro ? "Schema geometrico 45°/90° · distanze non in scala" : "Schema linee · interscambi e nodi principali"}</div><div class="powered">Powered by Cerbero</div></div>
      <div class="meta"><div><b>${lines.length}</b> linee · <b>${interCount}</b> interscambi</div><div>Generato ${gen}</div></div>
    </div>`;
  const footer = `<div class="brandfoot">
      ${logoUrl ? `<img src="${logoUrl}" alt="logo" />` : ""}
      <span class="powered">Powered by Cerbero Analytics</span>
      <span style="margin-left:auto">${metro ? "Mappa metropolitana schematica · le distanze non sono in scala" : "Mappa schematica octolineare · interscambi cerchiati"}</span>
    </div>`;

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Cerbero Analytics — Mappa di Rete</title>
  <style>
    ${PRINT_BASE_CSS}
    @page{size:${metro ? "A3 landscape" : "A4 portrait"};margin:8mm}
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .hero { color:#0f172a; padding:1px 2px 4px; border-bottom:1px solid #e2e8f0; margin-bottom:3px; display:flex; align-items:center; gap:10px; }
    .hero img { height:30px; width:auto; }
    .hero .t h1 { margin:0; font-size:13px; font-weight:800; }
    .hero .t .sub { font-size:8px; color:#64748b; }
    .hero .t .powered { font-size:7px; font-weight:800; color:#475569; letter-spacing:.3px; margin-top:0; }
    .hero .meta { margin-left:auto; text-align:right; font-size:8px; color:#475569; line-height:1.5; }
    .brandfoot { margin-top:3px; padding-top:3px; border-top:1px solid #e2e8f0; display:flex; align-items:center; gap:8px; font-size:7.5px; color:#94a3b8; }
    .brandfoot img { height:12px; opacity:.85; }
    .brandfoot .powered { font-weight:800; color:#475569; letter-spacing:.3px; }
  </style></head>
  <body><section class="page">
    ${hero}
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="100%">
      ${svgBody}
      <g transform="translate(${M}, ${H - legendH})">
        <rect x="-8" y="-8" width="${W - 2 * M + 16}" height="${legendH}" fill="#ffffffcc" stroke="#ddd"/>
        ${legendRows}
      </g>
    </svg>
    ${footer}
  </section></body></html>`;
}

/* ─── Pagina ─── */

export default function TimetablesPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"stop" | "route">("route");

  // progetto Planning Studio (sorgente del programma di esercizio)
  const [projectId, setProjectId] = useState<string>(DEFAULT_PROJECT_ID);

  // day-type selezionati (validità): multi per "orario di linea", singolo per "fermata"
  const [routeDayTypeIds, setRouteDayTypeIds] = useState<string[]>([]);
  const [stopDayTypeId, setStopDayTypeId] = useState<string>("");

  // quadro di fermata
  const [stopQuery, setStopQuery] = useState("");
  const [selectedStop, setSelectedStop] = useState<StopSearchItem | null>(null);

  // orario di linea
  const [directionId, setDirectionId] = useState<string>("all");
  const [selectedRouteIds, setSelectedRouteIds] = useState<string[]>([]);
  const [routeSearch, setRouteSearch] = useState("");
  // Un'unica azione alla volta: `busy` = id dell'azione in corso (o null).
  // Fix: prima `printing`/`sharing` erano condivisi → TUTTI i pulsanti
  // giravano insieme; ora lo spinner appare solo sul pulsante cliccato.
  const [busy, setBusy] = useState<string | null>(null);
  const anyBusy = busy !== null;
  const [shareDays, setShareDays] = useState<number>(7); // durata link condiviso (0 = senza scadenza)
  // dialog post-creazione del link Mappa Orari (URL + QR da stampare)
  const [mapShare, setMapShare] = useState<{ url: string; expiresAt: string | null; qr: string | null; linesCount: number } | null>(null);
  // gestione link Mappa Orari esistenti (i QR alle paline NON si ristampano:
  // stesso token = stesso QR, si aggiorna il contenuto)
  const [manageOpen, setManageOpen] = useState(false);
  // Dominio dei link orari, in ordine di precedenza:
  //   1. env RUNTIME del server (TIMETABLE_MAP_DOMAIN) via API — nessun flag
  //      "build variable", basta impostarla sull'app e riavviare;
  //   2. env di build Vite (VITE_TIMETABLE_MAP_DOMAIN), legacy;
  //   3. dominio dell'app (funziona sempre).
  const mapDomainQ = useQuery({
    queryKey: ["settings", "timetable-map-domain"],
    queryFn: () => apiFetch<{ domain: string | null }>(`/api/settings/timetable-map-domain`),
    staleTime: 5 * 60 * 1000,
  });
  const publicBase = (mapDomainQ.data?.domain
    || import.meta.env.VITE_TIMETABLE_MAP_DOMAIN
    || window.location.origin).replace(/\/+$/, "");

  const mapSharesQ = useQuery({
    queryKey: ["timetable-map-shares", projectId],
    queryFn: () => apiFetch<{ shares: Array<{ token: string; title: string | null; routeIds: string[]; createdAt: string; expiresAt: string | null }> }>(
      `/api/planning-studio/${encodeURIComponent(projectId)}/timetable-map-shares`),
    enabled: manageOpen && !!projectId,
  });
  const [nodesOnly, setNodesOnly] = useState(false); // schema solo nodi logici
  const [cityBg, setCityBg] = useState(true);          // sfondo schematico punti città
  const [mapBg, setMapBg] = useState(true);            // cartografia di sfondo (tile) sulla mappa rete
  const [show3d, setShow3d] = useState(false);         // anteprima mappa 3D interattiva
  const [lineStyles, setLineStyles] = useState<Record<string, NetLineStyle>>({}); // stile tratto PER-LINEA (mappa rete + 3D)
  const [nodeLabels, setNodeLabels] = useState<NetNodeLabels>("logical"); // nomi: solo nodi logici (default) o tutte le fermate
  // stile mappa rete: geografica (posizioni reali) o METROPOLITANA (schema
  // geometrico 45°/90° con distanze uniformi, stile mappa TPL cittadina)
  const [netStyle, setNetStyle] = useState<"geo" | "metro">("geo");
  const [mapRotate, setMapRotate] = useState(0);       // rotazione mappa rete in stampa (0/90/180/270)
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({}); // colore linee (override locale + persistito)

  const effColor = (routeId: string, fallback: string | null | undefined): string | null => colorOverrides[routeId] ?? fallback ?? null;
  function setRouteColor(routeId: string, color: string) {
    setColorOverrides((prev) => ({ ...prev, [routeId]: color }));
    apiFetch(`/api/planning-studio/projects/${encodeURIComponent(projectId)}/routes/${encodeURIComponent(routeId)}`, {
      method: "PATCH", body: JSON.stringify({ color }),
    }).catch(() => { /* l'override locale resta applicato anche se il salvataggio fallisce */ });
  }

  const effStyle = (routeId: string): NetLineStyle => lineStyles[routeId] ?? "solid";
  function setRouteStyle(routeId: string, style: NetLineStyle) {
    setLineStyles((prev) => ({ ...prev, [routeId]: style }));
  }

  const ptt = `/api/planning-studio/${encodeURIComponent(projectId)}/timetables`;

  const projectsQ = useQuery({
    queryKey: ["pstt", "ps-projects"],
    queryFn: () => apiFetch<any>("/api/planning-studio/projects"),
    staleTime: 5 * 60 * 1000,
  });
  const projects: PsProject[] = useMemo(() => {
    const d: any = projectsQ.data;
    const list = Array.isArray(d) ? d : (d?.projects ?? []);
    return list.map((p: any) => ({ id: p.id, name: p.name ?? p.id }));
  }, [projectsQ.data]);
  useEffect(() => {
    if (projects.length && !projects.some((p) => p.id === projectId)) {
      setProjectId(projects.find((p) => p.id === DEFAULT_PROJECT_ID)?.id ?? projects[0].id);
    }
  }, [projects, projectId]);

  const dayTypesQ = useQuery({
    queryKey: ["pstt", "day-types", projectId],
    // endpoint di STAMPA (lettura aperta come routes/route): evita il 404
    // "project not found" del router validità su progetti non di proprietà.
    queryFn: () => apiFetch<{ dayTypes: PsDayType[] }>(`${ptt}/day-types`),
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000,
  });
  const dayTypes: PsDayType[] = useMemo(() => dayTypesQ.data?.dayTypes ?? [], [dayTypesQ.data]);

  // CATEGORIE del calendario aziendale (Scuole Aperte / Chiuse / …) per la
  // stampa settimanale unica. Elenco globale, ma solo quelle rilevanti in UI.
  const categoriesQ = useQuery({
    queryKey: ["ps-validity-categories"],
    queryFn: () => listPsValidityCategories(),
    staleTime: 5 * 60 * 1000,
  });
  // Solo le macro-categorie "periodo" utili per la stampa: scuole_aperte,
  // scuole_chiuse (ombrello, non i singoli slug), festivita.
  const weekCategories = useMemo(
    () => (categoriesQ.data ?? []).filter((c) => ["scuole_aperte", "scuole_chiuse"].includes(c.code)),
    [categoriesQ.data],
  );
  const [weekCategory, setWeekCategory] = useState<string>("scuole_aperte");
  useEffect(() => {
    if (weekCategories.length && !weekCategories.some((c) => c.code === weekCategory)) {
      setWeekCategory(weekCategories[0].code);
    }
  }, [weekCategories, weekCategory]);

  // default: appena arrivano i day-type, seleziona "feriale" (o il primo)
  useEffect(() => {
    if (!dayTypes.length) return;
    const fallback = dayTypes.find((d) => d.code === "feriale")?.id ?? dayTypes[0].id;
    setRouteDayTypeIds((prev) => prev.filter((id) => dayTypes.some((d) => d.id === id)).length
      ? prev.filter((id) => dayTypes.some((d) => d.id === id)) : [fallback]);
    setStopDayTypeId((prev) => (dayTypes.some((d) => d.id === prev) ? prev : fallback));
  }, [dayTypes]);

  const stopSearchQ = useQuery({
    queryKey: ["pstt", "stop-search", projectId, stopQuery],
    queryFn: () => apiFetch<{ stops: StopSearchItem[] }>(`${ptt}/stops/search?q=${encodeURIComponent(stopQuery)}`),
    enabled: tab === "stop" && !!projectId && stopQuery.trim().length >= 2,
  });

  const stopTtQ = useQuery({
    queryKey: ["pstt", "stop", projectId, selectedStop?.stopId, stopDayTypeId],
    queryFn: () => apiFetch<StopTimetable>(`${ptt}/stop/${encodeURIComponent(selectedStop!.stopId)}?dayTypeId=${encodeURIComponent(stopDayTypeId)}`),
    enabled: tab === "stop" && !!projectId && !!selectedStop && !!stopDayTypeId,
  });

  const routesQ = useQuery({
    queryKey: ["pstt", "routes", projectId],
    queryFn: () => apiFetch<{ routes: PsRoute[] }>(`${ptt}/routes`),
    enabled: tab === "route" && !!projectId,
    staleTime: 5 * 60 * 1000,
  });

  const sortedRoutes = useMemo(() => {
    const list = routesQ.data?.routes ?? [];
    return [...list].sort((a, b) =>
      String(a.routeShortName ?? "").localeCompare(String(b.routeShortName ?? ""), "it", { numeric: true }));
  }, [routesQ.data]);

  // codice linea per id: mostra QUALI linee include ogni link in Gestisci link
  const routeCodeById = useMemo(
    () => new Map((routesQ.data?.routes ?? []).map((r) => [r.routeId, r.routeShortName ?? "?"])),
    [routesQ.data],
  );

  const filteredRoutes = useMemo(() => {
    const q = routeSearch.trim().toLowerCase();
    if (!q) return sortedRoutes;
    return sortedRoutes.filter((r) => `${r.routeShortName ?? ""} ${r.routeLongName ?? ""}`.toLowerCase().includes(q));
  }, [sortedRoutes, routeSearch]);

  function toggleRoute(id: string) {
    setSelectedRouteIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function toggleRouteDayType(id: string) {
    setRouteDayTypeIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }
  function selectedIdsOrdered(): string[] {
    return sortedRoutes.filter((r) => selectedRouteIds.includes(r.routeId)).map((r) => r.routeId);
  }

  // STAMPA ORARI (unica): si sceglie il calendario aziendale (Scuole Aperte /
  // Chiuse) e si generano gli orari di TUTTE le corse con la validità Lun→Dom.
  // Per ogni corsa: colore colonna + striscia L…D + badge dicono se è a chiamata
  // o valida solo in certi giorni; le corse festive (domenicali) finiscono in
  // una sezione ROSSA separata per non mischiarle.
  //
  // Sorgente = endpoint /route (SEMPRE affidabile: tutte le corse con day-type,
  // maschera weekdays, categorie e a chiamata). Giorni Lun→Dom e filtro per
  // calendario si calcolano qui: così la stampa funziona anche quando il
  // calendario categorie del progetto non è configurato (il /week tornava vuoto).
  async function printLine() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    const dirs = directionId === "all" ? ["0", "1"] : [directionId];
    const catName = weekCategories.find((c) => c.code === weekCategory)?.name
      ?? (weekCategory === "scuole_chiuse" ? "Scuole Chiuse" : "Scuole Aperte");
    const WD_FULL = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
    // Apri SUBITO la finestra (dentro il click) così non viene bloccata dopo i fetch.
    const win = openPendingPrintWindow();
    if (!win) return;
    setBusy("line");
    try {
      const docs: LineTTDoc[] = [];
      for (const rid of ids) {
        let route: RouteTimetable["route"] | null = null;
        let mapStops: LineTTDoc["mapStops"] = [];   // fermate della prima direzione con corse (pruned)
        let mapFallback: LineTTDoc["mapStops"] = []; // ripiego se nessuna direzione ha corse
        const directions: UniDir[] = [];
        for (const dir of dirs) {
          const rt = await apiFetch<RouteTimetable>(`${ptt}/route/${encodeURIComponent(rid)}?directionId=${dir}`);
          if (!route) route = { ...rt.route, color: effColor(rt.route.routeId, rt.route.color) };
          if (!mapFallback.length && rt.stops.length >= 2) {
            mapFallback = rt.stops.map((s, i) => ({ name: s.stopName, term: i === 0 || i === rt.stops.length - 1 }));
          }
          if (!rt.trips.length) continue;
          const stops = rt.stops.map((s, i) => ({ name: s.stopName, term: i === 0 || i === rt.stops.length - 1 }));

          // Filtro per CALENDARIO: se il progetto usa le categorie, tieni solo le
          // corse della categoria scelta (ombrello per scuole_chiuse). Le corse
          // senza categoria valgono sempre. Se il progetto non usa categorie,
          // mostra tutto (il calendario è solo un'etichetta).
          const cats = rt.categories ?? [];
          const useCats = cats.length > 0;
          const selIds = new Set(
            cats.filter((c) => weekCategory === "scuole_chiuse"
              ? c.code.startsWith("scuole_chiuse") : c.code === weekCategory).map((c) => c.id),
          );
          const inCategory = (t: RouteTimetable["trips"][number]) => {
            if (!useCats) return true;
            const tc = t.categoryIds ?? [];
            return tc.length === 0 || tc.some((id) => selIds.has(id));
          };

          const built = rt.trips.filter(inCategory).map((t) => {
            const cells = t.times.map((v) => (v ? v.slice(0, 5) : ""));
            const dep = cells.find((c) => c) ?? "";
            // giorni Lun→Dom: maschera weekdays se presente; altrimenti dai
            // bollini day-type (feriale→Lun-Ven, sabato→Sab, festivo→Dom);
            // se non c'è alcun segnale la corsa è considerata giornaliera.
            let days: boolean[];
            if (Array.isArray(t.weekdays) && t.weekdays.length === 7) {
              days = t.weekdays.map((x) => x !== false);
            } else {
              const codes = new Set(t.dayTypeCodes ?? []);
              days = codes.size === 0
                ? [true, true, true, true, true, true, true]
                : [codes.has("feriale"), codes.has("feriale"), codes.has("feriale"), codes.has("feriale"), codes.has("feriale"), codes.has("sabato"), codes.has("festivo")];
            }
            return { dep, cells, onDemand: !!t.onDemand, days, sort: hhmmToMin(dep) ?? 9999 };
          }).filter((c) => c.cells.some((x) => x));

          // RESTRIZIONE sul FERIALE (Lun-Sab = normalità → nessuna nota):
          // se manca qualche giorno ma i più ci sono → "Escluso il <giorno>"
          // (iniziali rosse); se ne circola solo qualcuno → "Circola solo il
          // <giorni>" (iniziali verdi). Descrizione completa in legenda.
          const lunSabRestr = (days: boolean[]): UniRestr | null => {
            const on = [0, 1, 2, 3, 4, 5].filter((i) => days[i]);
            const off = [0, 1, 2, 3, 4, 5].filter((i) => !days[i]);
            if (on.length === 6 || on.length === 0) return null;
            const fmt = (idx: number[]) => idx.map((i) => WD_FULL[i]).join(", ");
            return off.length < on.length
              ? { kind: "excl", idxs: off, desc: `Escluso il ${fmt(off)}` }
              : { kind: "only", idxs: on, desc: `Circola solo il ${fmt(on)}` };
          };

          // regular = circola almeno un giorno Lun-Sab; festive = circola la
          // domenica. Una corsa Lun-Dom compare in ENTRAMBE (nel festivo mostra
          // il servizio domenicale), come richiesto.
          const dedup = (arr: typeof built, forFestive: boolean): UniTrip[] => {
            const seen = new Set<string>();
            return arr
              .sort((a, b) => a.sort - b.sort)
              .map((x) => ({ dep: x.dep, cells: x.cells, onDemand: x.onDemand, restr: forFestive ? null : lunSabRestr(x.days) }))
              .filter((u) => {
                const k = `${u.onDemand ? "od" : ""}|${u.restr?.desc ?? ""}|${u.cells.join("|")}`;
                if (seen.has(k)) return false;
                seen.add(k); return true;
              });
          };
          const regular = dedup(built.filter((x) => x.days.slice(0, 6).some(Boolean)), false);
          const festive = dedup(built.filter((x) => x.days[6]), true);

          // Rimuovi le FERMATE senza alcun transito in NESSUNA corsa (né feriale
          // né festiva): righe tutte vuote = solo ingombro. Poi allinea le celle
          // di ogni corsa e ricalcola i capolinea sulle fermate rimaste.
          const allT = [...regular, ...festive];
          const keep = stops.map((_, i) => allT.some((t) => t.cells[i]));
          const keptStops = stops
            .filter((_, i) => keep[i])
            .map((s, i, arr) => ({ name: s.name, term: i === 0 || i === arr.length - 1 }));
          const prune = (t: UniTrip): UniTrip => ({ ...t, cells: t.cells.filter((_, i) => keep[i]) });
          if (!mapStops.length && keptStops.length >= 2) mapStops = keptStops;

          directions.push({
            dirLabel: dir === "0" ? "Andata" : "Ritorno",
            stops: keptStops,
            regular: regular.map(prune),
            festive: festive.map(prune),
          });
        }
        if (route) docs.push({ route, mapStops: mapStops.length ? mapStops : mapFallback, category: { code: weekCategory, name: catName }, directions });
      }
      if (!docs.some((d) => d.directions.some((x) => x.regular.length > 0 || x.festive.length > 0))) {
        win.close();
        toast.error("Nessuna corsa per la selezione", {
          description: "Le linee selezionate non hanno corse per questa direzione/calendario.",
        });
        return;
      }
      const logo = await cerberoLogoDataUrl();
      fillPrintWindow(win, buildLineTimetableHtml(docs, logo));
    } catch (e: any) {
      win.close();
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setBusy(null); }
  }

  // QUADRO DI PALINA: selezioni le linee → si ricavano TUTTE le loro fermate e
  // per ciascuna si INCROCIANO tutte le linee che vi transitano, con gli orari
  // di TUTTE le categorie di calendario (Scuole Aperte/Chiuse) e tipi di giorno.
  // Un foglio A4 per fermata (o più), intestazione = ID + nome fermata.
  async function printPaline() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    const win = openPendingPrintWindow();
    if (!win) return;
    setBusy("paline");
    try {
      const rs = await apiFetch<{ stops: Array<{ stopId: string; stopName: string; stopCode: string | null }> }>(
        `${ptt}/route-stops?routeIds=${ids.map(encodeURIComponent).join(",")}`,
      );
      const stops = rs.stops ?? [];
      if (!stops.length) { win.close(); toast.error("Nessuna fermata per le linee selezionate"); return; }
      const docs: PalStop[] = [];
      for (const s of stops) {
        const full = await apiFetch<PalStop>(`${ptt}/stop/${encodeURIComponent(s.stopId)}/full`);
        // applica l'eventuale colore operatore personalizzato alle linee
        full.lines = full.lines.map((l) => ({ ...l, color: effColor(l.routeId, l.color) }));
        docs.push(full);
      }
      if (!docs.some((x) => x.lines.some((l) => l.departures.length))) { win.close(); toast.error("Nessuna partenza per la selezione"); return; }
      const logo = await cerberoLogoDataUrl();
      fillPrintWindow(win, buildStopPostersHtml(docs, logo));
    } catch (e: any) {
      win.close();
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setBusy(null); }
  }

  // Stampa "mappa di rete": linee selezionate sovrapposte, interscambi cerchiati.
  async function printNetwork() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    setBusy("network");
    try {
      const data = await apiFetch<NetworkData>(`${ptt}/network?routeIds=${ids.map(encodeURIComponent).join(",")}`);
      if (!data.lines?.some((l) => l.stops.length > 0)) { toast.error("Nessuna geometria fermate per le linee selezionate"); return; }
      const data2 = { ...data, lines: (data.lines ?? []).map((l) => ({ ...l, color: effColor(l.routeId, l.color) })) };
      const logoUrl = `${window.location.origin}/logo.png`;
      openPrintWindow(buildNetworkMapHtml(data2, nodesOnly, cityBg, mapBg, logoUrl, lineStyles, nodeLabels, mapRotate, netStyle === "metro"));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setBusy(null); }
  }

  // Crea un link pubblico condivisibile della Mappa di Rete (selezione linee a video).
  async function shareNetwork() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    setBusy("shareNet");
    try {
      const r = await apiFetch<{ token: string; expiresAt: string | null }>(`/api/planning-studio/${encodeURIComponent(projectId)}/network-share`, {
        method: "POST", body: JSON.stringify({ routeIds: ids, expiresInDays: shareDays }),
      });
      const url = `${window.location.origin}/m/${r.token}`;
      const scad = r.expiresAt ? ` (scade il ${new Date(r.expiresAt).toLocaleDateString("it-IT")})` : " (senza scadenza)";
      try { await navigator.clipboard.writeText(url); toast.success(`Link copiato${scad}`); }
      catch { toast.success(`Link creato${scad}`); }
      window.open(url, "_blank");
    } catch (e: any) {
      toast.error(e?.message ?? "Errore nella creazione del link");
    } finally { setBusy(null); }
  }

  // Link pubblico MAPPA ORARI per i passeggeri: giorno → linea → mappa →
  // fermata → orari (con corse a chiamata). Linee selezionate = solo quelle
  // nel link; nessuna selezione = TUTTE. Il dialog mostra URL + QR da
  // stampare alle paline, con la durata scelta nella tendina "Link:".
  async function shareTimetableMap() {
    const ids = selectedIdsOrdered();
    // Nome del link: con più link attivi sullo stesso progetto (es. "Linee
    // urbane" e "Linee scolastiche" su selezioni diverse) serve riconoscerli
    // in Gestisci link. Annulla = creazione annullata.
    const suggested = ids.length > 0
      ? ids.map((id) => routeCodeById.get(id) ?? "").filter(Boolean).slice(0, 4).join(", ") + (ids.length > 4 ? "…" : "")
      : "Tutte le linee";
    const title = prompt("Nome del link (ti aiuta a riconoscerlo in \"Gestisci link\"):", suggested);
    if (title === null) return;
    setBusy("shareMap");
    try {
      const r = await apiFetch<{ token: string; expiresAt: string | null }>(`/api/planning-studio/${encodeURIComponent(projectId)}/timetable-map-share`, {
        method: "POST", body: JSON.stringify({ routeIds: ids, expiresInDays: shareDays, title: title.trim() || undefined }),
      });
      const url = `${publicBase}/o/${r.token}`;
      try { await navigator.clipboard.writeText(url); } catch { /* clipboard opzionale */ }
      let qr: string | null = null;
      try {
        const QRCode = (await import("qrcode")).default;
        qr = await QRCode.toDataURL(url, { width: 480, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } });
      } catch { /* QR opzionale: il dialog mostra comunque l'URL */ }
      setMapShare({ url, expiresAt: r.expiresAt, qr, linesCount: ids.length });
      qc.invalidateQueries({ queryKey: ["timetable-map-shares", projectId] });
      toast.success("Link Mappa Orari creato e copiato", {
        description: r.expiresAt
          ? `Online fino a ${new Date(r.expiresAt).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`
          : "Sempre online (nessuna scadenza)",
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Errore nella creazione del link");
    } finally { setBusy(null); }
  }

  /* ── Gestione link Mappa Orari esistenti ──
   * Il QR codifica SOLO l'URL: finché il token resta lo stesso, il QR
   * stampato alle paline continua a funzionare. Qui si aggiorna il
   * CONTENUTO del link (linee incluse, scadenza) senza cambiare il QR. */
  function shareUrl(tokenStr: string): string { return `${publicBase}/o/${tokenStr}`; }

  async function downloadQr(tokenStr: string) {
    try {
      const QRCode = (await import("qrcode")).default;
      const dataUrl = await QRCode.toDataURL(shareUrl(tokenStr), { width: 480, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } });
      const a = document.createElement("a");
      a.href = dataUrl; a.download = `mappa-orari-qr-${tokenStr.slice(0, 6)}.png`; a.click();
    } catch (e: any) { toast.error(e?.message ?? "Errore generazione QR"); }
  }

  async function patchShare(tokenStr: string, patch: { routeIds?: string[]; expiresInDays?: number; title?: string }, okMsg: string) {
    try {
      await apiFetch(`/api/planning-studio/${encodeURIComponent(projectId)}/timetable-map-shares/${tokenStr}`, {
        method: "PATCH", body: JSON.stringify(patch),
      });
      toast.success(okMsg, { description: "Il QR e il link restano gli stessi." });
      qc.invalidateQueries({ queryKey: ["timetable-map-shares", projectId] });
    } catch (e: any) { toast.error(e?.message ?? "Aggiornamento fallito"); }
  }

  async function revokeShare(tokenStr: string) {
    if (!confirm("Revocare questo link? Il QR stampato smetterà di funzionare. L'operazione non è annullabile.")) return;
    try {
      await apiFetch(`/api/planning-studio/${encodeURIComponent(projectId)}/timetable-map-shares/${tokenStr}`, { method: "DELETE" });
      toast.success("Link revocato");
      qc.invalidateQueries({ queryKey: ["timetable-map-shares", projectId] });
    } catch (e: any) { toast.error(e?.message ?? "Revoca fallita"); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg">
          <Printer className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Stampa Orari</h1>
          <p className="text-xs text-muted-foreground">
            Quadri di palina e orari generali di linea dal programma di esercizio del progetto Planning Studio
          </p>
        </div>
      </div>

      {/* Tab */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg overflow-hidden border border-border/60">
          <button
            onClick={() => setTab("route")}
            className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === "route" ? "bg-sky-500/20 text-sky-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
          >
            <ArrowLeftRight className="w-4 h-4" /> Orario di linea
          </button>
          <button
            onClick={() => setTab("stop")}
            className={`px-4 py-2 text-sm flex items-center gap-2 transition-colors ${tab === "stop" ? "bg-sky-500/20 text-sky-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
          >
            <SignpostBig className="w-4 h-4" /> Quadro di fermata
          </button>
        </div>
      </div>

      {/* Progetto (sorgente) */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5">
        <span className="text-xs font-medium text-muted-foreground">Programma di esercizio</span>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-sky-500/60 max-w-72"
          title="Progetto Planning Studio (sorgente dati e validità)"
        >
          {projects.length === 0 && <option value={projectId}>Progetto predefinito</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {dayTypesQ.isLoading && <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> day-type…</span>}
        <span className="text-[10px] text-muted-foreground ml-auto">Validità per day-type da Planning Studio → Validità</span>
      </div>

      {/* ── Tab: orario di linea ── */}
      {tab === "route" && (
        <div className="space-y-4">
          {/* ══ Azioni raggruppate per intento ══ */}
          <div className="grid gap-3 lg:grid-cols-3">

            {/* GRUPPO 1 — ORARI (stampa PDF) */}
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/[0.04] p-3 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-sky-300"><Printer className="w-4 h-4" /> Orari (stampa PDF)</div>
              {/* calendario aziendale + direzione: pilotano la stampa orari unica */}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={weekCategory}
                  onChange={(e) => setWeekCategory(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-card border border-sky-500/50 text-xs outline-none focus:border-sky-500"
                  title="Calendario aziendale: gli orari usano i giorni reali di questo periodo (Scuole Aperte / Chiuse). Le corse festive vengono messe in una sezione a parte."
                >
                  {weekCategories.length === 0 && <option value="scuole_aperte">Scuole Aperte</option>}
                  {weekCategories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select>
                <select
                  value={directionId}
                  onChange={(e) => setDirectionId(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-sky-500/60"
                  title="Direzioni incluse nella stampa."
                >
                  <option value="all">Andata + Ritorno</option>
                  <option value="0">Solo Andata</option>
                  <option value="1">Solo Ritorno</option>
                </select>
              </div>
              {/* STAMPA ORARI UNICA: calendario → mappa linea + orari Lun→Dom */}
              <button onClick={printLine}
                disabled={anyBusy || selectedRouteIds.length === 0}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
                title="Un documento per linea nel calendario scelto: nome + descrizione, mappa della linea, e gli orari di TUTTE le corse (Andata/Ritorno) con la validità reale Lun→Dom. Colori e legenda segnalano corse a chiamata e con validità particolare; le corse festive stanno in una sezione rossa a parte.">
                {busy === "line" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                Stampa orari{selectedRouteIds.length ? ` (${selectedRouteIds.length})` : ""}
              </button>
              <p className="text-[10px] text-muted-foreground">Un foglio per linea: mappa + orari Andata/Ritorno con validità Lun→Dom del calendario scelto. A chiamata e giorni limitati per colore; corse festive in una sezione rossa separata.</p>

              {/* Quadri di palina: un foglio A4 per fermata, tutte le linee × calendari */}
              <div className="pt-2 border-t border-border/40 space-y-2">
                <div className="flex items-center gap-2 text-[11px] font-semibold text-sky-200"><SignpostBig className="w-3.5 h-3.5" /> Quadri di palina</div>
                <button onClick={printPaline}
                  disabled={anyBusy || selectedRouteIds.length === 0}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sky-500/60 text-sky-300 hover:bg-sky-500/10 disabled:opacity-50 text-xs font-medium transition-colors"
                  title="Un foglio A4 per ogni fermata delle linee selezionate: incrocia TUTTE le linee che vi transitano, con gli orari di tutte le categorie di calendario (Scuole Aperte/Chiuse) e i tipi di giorno.">
                  {busy === "paline" ? <Loader2 className="w-4 h-4 animate-spin" /> : <SignpostBig className="w-4 h-4" />}
                  Quadri palina{selectedRouteIds.length ? ` (${selectedRouteIds.length} linee)` : ""}
                </button>
                <p className="text-[10px] text-muted-foreground">Genera automaticamente tutte le fermate delle linee scelte, incrociando le altre linee che vi passano. Un foglio A4 per fermata.</p>
              </div>
            </div>

            {/* GRUPPO 2 — MAPPA DI RETE */}
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.04] p-3 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-indigo-300"><MapIcon className="w-4 h-4" /> Mappa di rete</div>
              <div className="flex flex-wrap gap-2">
                <button onClick={printNetwork}
                  disabled={anyBusy || selectedRouteIds.length === 0}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg border border-fuchsia-500/60 text-fuchsia-300 hover:bg-fuchsia-500/10 disabled:opacity-50 text-xs font-medium transition-colors"
                  title="Mappa di rete: linee selezionate con gli interscambi. Stile e opzioni qui sotto.">
                  {busy === "network" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                  Stampa mappa rete
                </button>
                <button onClick={() => setShow3d((v) => !v)}
                  disabled={selectedRouteIds.length === 0}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border disabled:opacity-50 text-xs font-medium transition-colors ${show3d ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300" : "border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/10"}`}
                  title="Anteprima mappa 3D interattiva (edifici + terreno) — non per la stampa.">
                  <MapIcon className="w-4 h-4" /> Anteprima 3D
                </button>
              </div>
              {/* opzioni di disegno della mappa di rete */}
              <div className="pt-1 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
                <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Riduce lo schema ai soli nodi logici (cluster)">
                  <input type="checkbox" checked={nodesOnly} onChange={(e) => setNodesOnly(e.target.checked)} className="accent-fuchsia-500" /> Solo nodi logici
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Sfondo con i punti principali della città">
                  <input type="checkbox" checked={cityBg} onChange={(e) => setCityBg(e.target.checked)} className="accent-slate-400" /> Sfondo città
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Cartografia di sfondo — SOLO mappa rete">
                  <input type="checkbox" checked={mapBg} onChange={(e) => setMapBg(e.target.checked)} className="accent-emerald-400" /> Cartografia (mappa rete)
                </label>
                <label className="flex items-center gap-1.5 select-none" title="Nomi mostrati sui nodi della mappa rete">
                  <span>Nomi</span>
                  <select value={nodeLabels} onChange={(e) => setNodeLabels(e.target.value as NetNodeLabels)}
                    className="px-1.5 py-1 rounded bg-card border border-border/60 text-[11px] outline-none focus:border-sky-500/60 cursor-pointer">
                    <option value="logical">Solo nodi logici</option>
                    <option value="all">Tutte le fermate</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 select-none col-span-2" title="Stile e rotazione della MAPPA RETE in stampa">
                  <select value={netStyle} onChange={(e) => setNetStyle(e.target.value as "geo" | "metro")}
                    className="px-2 py-1 rounded bg-card border border-border/60 text-[11px] outline-none focus:border-fuchsia-500/60 cursor-pointer">
                    <option value="geo">Mappa: Geografica</option>
                    <option value="metro">Mappa: Metropolitana (A3)</option>
                  </select>
                  <select value={mapRotate} onChange={(e) => setMapRotate(Number(e.target.value))}
                    className="px-2 py-1 rounded bg-card border border-border/60 text-[11px] outline-none focus:border-fuchsia-500/60 cursor-pointer">
                    <option value={0}>Rotazione 0°</option>
                    <option value={90}>90°</option>
                    <option value={180}>180°</option>
                    <option value={270}>270°</option>
                  </select>
                </label>
              </div>
            </div>

            {/* GRUPPO 3 — CONDIVISIONE ONLINE (link / QR) */}
            <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/[0.04] p-3 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-bold text-cyan-300"><Link2 className="w-4 h-4" /> Condivisione online</div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>Durata link</span>
                <select value={shareDays} onChange={(e) => setShareDays(Number(e.target.value))}
                  className="flex-1 px-2 py-1.5 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-cyan-500/60">
                  <option value={1}>24 ore</option>
                  <option value={7}>7 giorni</option>
                  <option value={30}>30 giorni</option>
                  <option value={90}>90 giorni</option>
                  <option value={180}>6 mesi</option>
                  <option value={365}>1 anno</option>
                  <option value={0}>Sempre online</option>
                </select>
              </label>
              <div className="flex flex-col gap-2">
                <button onClick={shareTimetableMap}
                  disabled={anyBusy}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-600/90 hover:bg-cyan-600 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                  title="Link pubblico MAPPA ORARI per i passeggeri (giorno → linea → mappa → fermata → orari). Linee selezionate = solo quelle; nessuna selezione = tutte.">
                  {busy === "shareMap" ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPinned className="w-4 h-4" />}
                  Crea link Mappa Orari
                </button>
                <div className="flex gap-2">
                  <button onClick={shareNetwork}
                    disabled={anyBusy || selectedRouteIds.length === 0}
                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50 text-xs font-medium transition-colors"
                    title="Link pubblico della Mappa di Rete (l'utente sceglie le linee da vedere). Richiede almeno una linea selezionata.">
                    {busy === "shareNet" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                    Link mappa rete
                  </button>
                  <button onClick={() => setManageOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/60 text-muted-foreground hover:text-cyan-300 hover:border-cyan-500/40 text-xs font-medium transition-colors"
                    title="Link Mappa Orari già creati: aggiorna linee/scadenza SENZA cambiare il QR stampato, riscarica i QR, revoca.">
                    <QrCode className="w-4 h-4" /> Gestisci
                  </button>
                </div>
              </div>
            </div>

          </div>

          {/* Selezione linee */}
          <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Search className="w-4 h-4 text-muted-foreground" />
              <input
                value={routeSearch}
                onChange={(e) => setRouteSearch(e.target.value)}
                placeholder="Filtra linee…"
                className="flex-1 bg-transparent text-sm outline-none"
              />
              <button onClick={() => setSelectedRouteIds(filteredRoutes.map((r) => r.routeId))} className="text-[11px] text-sky-400 hover:underline">Seleziona tutte</button>
              <button onClick={() => setSelectedRouteIds([])} className="text-[11px] text-muted-foreground hover:underline">Deseleziona</button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-border/30">
              {routesQ.isLoading && (
                <div className="p-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico linee…</div>
              )}
              {!routesQ.isLoading && filteredRoutes.length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">Nessuna linea nel progetto.</div>
              )}
              {filteredRoutes.map((r) => (
                <div key={r.routeId} className="flex items-center gap-2 px-3 py-2 hover:bg-white/5">
                  <input type="checkbox" checked={selectedRouteIds.includes(r.routeId)} onChange={() => toggleRoute(r.routeId)} className="accent-sky-500 cursor-pointer" />
                  <input
                    type="color"
                    value={lineColor(effColor(r.routeId, r.routeColor))}
                    onChange={(e) => setRouteColor(r.routeId, e.target.value)}
                    title="Colore linea"
                    className="w-6 h-6 rounded cursor-pointer bg-transparent border border-border/40 p-0 shrink-0"
                  />
                  <span className="px-2 py-0.5 rounded text-white text-xs font-bold shrink-0" style={{ backgroundColor: lineColor(effColor(r.routeId, r.routeColor)) }}>{r.routeShortName ?? "?"}</span>
                  <span className="text-sm truncate flex-1 cursor-pointer" onClick={() => toggleRoute(r.routeId)}>{r.routeLongName ?? r.routeId}</span>
                  <select
                    value={effStyle(r.routeId)}
                    onChange={(e) => setRouteStyle(r.routeId, e.target.value as NetLineStyle)}
                    title="Stile del tratto di questa linea (Mappa rete + Mappa 3D)"
                    className="shrink-0 px-1.5 py-1 rounded bg-card border border-border/40 text-[11px] outline-none focus:border-sky-500/60 cursor-pointer"
                  >
                    <option value="solid">Continua</option>
                    <option value="dashed">Tratteggiata</option>
                    <option value="dotted">Puntinata</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          {show3d && (
            <NetworkMap3D projectId={projectId} routeIds={sortedRoutes.filter((r) => selectedRouteIds.includes(r.routeId)).map((r) => r.routeId)} colorOverrides={colorOverrides} lineStyles={lineStyles} nodeLabels={nodeLabels} />
          )}

          <p className="text-[11px] text-muted-foreground">
            Documento unico: una sezione per ogni linea × day-type selezionato. «Stampa quadri palina» genera invece il quadro di ogni fermata delle linee scelte (con tutte le linee che vi passano). «Mappa 3D» è un'anteprima interattiva (edifici + terreno), non per la stampa. Output → salva in PDF dal dialogo di stampa.
          </p>
        </div>
      )}

      {/* ── Tab: quadro di fermata ── */}
      {tab === "stop" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">Day-type</span>
            <select
              value={stopDayTypeId}
              onChange={(e) => setStopDayTypeId(e.target.value)}
              className="px-3 py-2 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            >
              {dayTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={stopQuery}
              onChange={(e) => { setStopQuery(e.target.value); setSelectedStop(null); }}
              placeholder="Cerca fermata per nome (min 2 caratteri)…"
              className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            />
          </div>

          {!selectedStop && stopQuery.trim().length >= 2 && (
            <div className="rounded-lg border border-border/60 divide-y divide-border/40 max-h-72 overflow-y-auto">
              {stopSearchQ.isLoading && <div className="p-3 text-xs text-muted-foreground">Ricerca…</div>}
              {stopSearchQ.data?.stops.length === 0 && <div className="p-3 text-xs text-muted-foreground">Nessuna fermata trovata.</div>}
              {stopSearchQ.data?.stops.map((s) => (
                <button
                  key={s.stopId}
                  onClick={() => setSelectedStop(s)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-3"
                >
                  <MapPin className="w-4 h-4 text-sky-400 shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{s.stopName}</span>
                    <span className="block text-[10px] text-muted-foreground truncate">linee: {s.routes.slice(0, 10).join(", ") || "—"}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {selectedStop && (
            <div className="rounded-xl border border-border/60 bg-card/60 overflow-hidden">
              <div className="px-4 py-3 border-b border-border/50 flex items-center gap-3">
                <MapPin className="w-4 h-4 text-sky-400" />
                <span className="font-semibold text-sm flex-1">{selectedStop.stopName}</span>
                <button
                  onClick={() => { if (stopTtQ.data) openPrintWindow(buildStopPosterHtml(stopTtQ.data)); }}
                  disabled={!stopTtQ.data}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-xs font-medium transition-colors"
                >
                  <Printer className="w-3.5 h-3.5" /> Stampa quadro
                </button>
              </div>
              <div className="p-4 space-y-3">
                {stopTtQ.isLoading && <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carico orari…</div>}
                {stopTtQ.data?.lines.length === 0 && (
                  <div className="text-xs text-muted-foreground">Nessuna partenza da questa fermata per il day-type scelto.</div>
                )}
                {stopTtQ.data?.lines.map((l) => (
                  <div key={l.routeId} className="rounded-lg border border-border/40 overflow-hidden">
                    <div className="px-3 py-1.5 flex items-center gap-2" style={{ backgroundColor: `${lineColor(l.color)}22`, borderLeft: `4px solid ${lineColor(l.color)}` }}>
                      <span className="px-2 py-0.5 rounded text-white text-xs font-bold" style={{ backgroundColor: lineColor(l.color) }}>{l.shortName ?? "?"}</span>
                      <span className="text-xs text-muted-foreground truncate flex-1">{l.longName}</span>
                      <span className="text-[10px] text-muted-foreground">{l.total} partenze</span>
                    </div>
                    <div className="p-2 grid gap-0.5" style={{ gridTemplateColumns: "2.5rem 1fr" }}>
                      {l.byHour.map((h) => (
                        <div key={h.hour} className="contents">
                          <span className="text-xs font-bold font-mono bg-white/5 rounded px-1.5 py-0.5 text-center">{String(h.hour).padStart(2, "0")}</span>
                          <span className="text-xs font-mono px-2 py-0.5">
                            {h.departures.map((d, i) => (
                              <span key={i} className="mr-2">
                                {String(d.minute).padStart(2, "0")}
                                {l.headsigns.filter(Boolean).length > 1 && l.headsigns[d.headsignIdx] && (
                                  <sup className="text-[8px] text-sky-400">{String.fromCharCode(97 + d.headsignIdx)}</sup>
                                )}
                              </span>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Dialog GESTIONE link Mappa Orari: aggiorna senza cambiare QR ── */}
      {manageOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setManageOpen(false)}>
          <div className="w-full max-w-2xl mx-4 rounded-2xl border border-cyan-500/30 bg-zinc-950 shadow-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 shrink-0">
              <div className="flex items-center gap-2">
                <QrCode className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Link Mappa Orari — gestione</h3>
              </div>
              <button onClick={() => setManageOpen(false)} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
            </div>
            <div className="p-4 space-y-4 overflow-y-auto">
              <p className="text-[11px] text-zinc-400">
                Il QR codifica solo l'indirizzo: <b className="text-zinc-200">finché il link resta lo stesso, il QR stampato alle
                paline continua a funzionare</b>. Da qui aggiorni cosa mostra (linee incluse) e per quanto resta online,
                senza ristampare nulla.
              </p>
              <p className="text-[10px] text-zinc-500">
                Dominio dei link: <span className="font-mono text-zinc-400">{publicBase}</span>
                {(mapDomainQ.data?.domain || import.meta.env.VITE_TIMETABLE_MAP_DOMAIN)
                  ? " (dedicato, da variabile d'ambiente)"
                  : " — per un dominio dedicato imposta TIMETABLE_MAP_DOMAIN come normale variabile d'ambiente dell'app (niente flag di build) e riavvia. Il dominio deve puntare all'app."}
              </p>

              {/* Elenco link creati */}
              {mapSharesQ.isLoading && <p className="text-xs text-zinc-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico i link…</p>}
              {mapSharesQ.data && mapSharesQ.data.shares.length === 0 && (
                <p className="text-xs text-zinc-500">Nessun link creato per questo progetto. Usa "Mappa orari" per crearne uno.</p>
              )}
              {(mapSharesQ.data?.shares ?? []).map((s) => {
                const expired = s.expiresAt ? new Date(s.expiresAt).getTime() < Date.now() : false;
                return (
                  <div key={s.token} className={`rounded-xl border p-3 space-y-2 ${expired ? "border-rose-500/40 bg-rose-500/5" : "border-zinc-800 bg-zinc-900/40"}`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-zinc-200">
                        {s.title || (s.routeIds.length > 0 ? `${s.routeIds.length} linee` : "Tutte le linee")}
                      </span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${
                        expired
                          ? "border-rose-500/50 text-rose-300"
                          : s.expiresAt ? "border-amber-500/40 text-amber-300" : "border-emerald-500/40 text-emerald-300"
                      }`}>
                        {expired
                          ? "SCADUTO"
                          : s.expiresAt
                            ? `online fino al ${new Date(s.expiresAt).toLocaleDateString("it-IT")}`
                            : "sempre online"}
                      </span>
                      <span className="text-[10px] text-zinc-500 ml-auto">
                        creato il {new Date(s.createdAt).toLocaleDateString("it-IT")}
                      </span>
                    </div>
                    {s.routeIds.length > 0 && (
                      <p className="text-[10px] text-zinc-400">
                        Linee: <span className="font-mono text-zinc-300">
                          {s.routeIds.map((id) => routeCodeById.get(id) ?? "?").join(", ")}
                        </span>
                      </p>
                    )}
                    <p className="text-[10px] font-mono text-zinc-500 truncate">{shareUrl(s.token)}</p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button onClick={async () => { try { await navigator.clipboard.writeText(shareUrl(s.token)); toast.success("Link copiato"); } catch { /* noop */ } }}
                        className="px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-cyan-500/40 hover:text-cyan-300 text-[11px] font-semibold">
                        Copia link
                      </button>
                      <button onClick={() => downloadQr(s.token)}
                        className="px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-cyan-500/40 hover:text-cyan-300 text-[11px] font-semibold">
                        Scarica QR
                      </button>
                      <button onClick={() => window.open(shareUrl(s.token), "_blank")}
                        className="px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-cyan-500/40 hover:text-cyan-300 text-[11px] font-semibold">
                        Apri
                      </button>
                      <button
                        onClick={() => patchShare(s.token, { routeIds: selectedIdsOrdered() },
                          selectedRouteIds.length > 0 ? `Linee del link aggiornate (${selectedRouteIds.length})` : "Link aggiornato: tutte le linee")}
                        title="Sostituisce le linee incluse nel link con la selezione corrente a video (nessuna selezione = tutte). Il QR resta lo stesso."
                        className="px-2.5 py-1.5 rounded-lg border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10 text-[11px] font-semibold">
                        Aggiorna con selezione
                      </button>
                      <button
                        onClick={() => patchShare(s.token, { expiresInDays: shareDays },
                          shareDays > 0 ? `Validità rinnovata: ${shareDays} giorni da oggi` : "Link reso SEMPRE online")}
                        title={`Rinnova la validità secondo la tendina "Link:" (${shareDays > 0 ? `${shareDays} giorni da oggi` : "sempre online"}). Utile anche per riattivare un link scaduto.`}
                        className="px-2.5 py-1.5 rounded-lg border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 text-[11px] font-semibold">
                        Rinnova validità
                      </button>
                      <button
                        onClick={() => {
                          const nn = prompt("Nuovo nome del link:", s.title ?? "");
                          if (nn !== null) void patchShare(s.token, { title: nn.trim() }, "Link rinominato");
                        }}
                        className="px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:border-cyan-500/40 hover:text-cyan-300 text-[11px] font-semibold">
                        Rinomina
                      </button>
                      <button onClick={() => revokeShare(s.token)}
                        className="px-2.5 py-1.5 rounded-lg border border-rose-500/40 text-rose-300 hover:bg-rose-500/10 text-[11px] font-semibold ml-auto">
                        Revoca
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Dialog link MAPPA ORARI: URL + QR da stampare alle paline ── */}
      {mapShare && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setMapShare(null)}>
          <div className="w-full max-w-md mx-4 rounded-2xl border border-cyan-500/30 bg-zinc-950 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <MapPinned className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Mappa Orari per i passeggeri</h3>
              </div>
              <button onClick={() => setMapShare(null)} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none">×</button>
            </div>
            <div className="p-4 space-y-3">
              {/* Banner VALIDITÀ ben visibile: quando smette di funzionare il link */}
              {mapShare.expiresAt ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
                  <p className="text-xs font-bold text-amber-300">
                    ⏳ Questo link resterà online fino a{" "}
                    {new Date(mapShare.expiresAt).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  </p>
                  <p className="text-[11px] text-amber-200/80 mt-0.5">
                    Dopo quella data il QR e il link smettono di funzionare. Per una durata diversa,
                    cambia la tendina "Link:" e premi di nuovo "Mappa orari".
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5">
                  <p className="text-xs font-bold text-emerald-300">♾️ Questo link resterà online per sempre</p>
                  <p className="text-[11px] text-emerald-200/80 mt-0.5">
                    Nessuna scadenza: ideale per il QR stampato alle paline. Gli orari mostrati
                    sono sempre quelli correnti del progetto.
                  </p>
                </div>
              )}
              <p className="text-[11px] text-zinc-400">
                {mapShare.linesCount > 0 ? `${mapShare.linesCount} linee incluse nel link` : "Tutte le linee del progetto incluse nel link"}.
              </p>
              <div className="flex items-center gap-2">
                <input readOnly value={mapShare.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 px-2.5 py-2 text-xs font-mono rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-200 outline-none" />
                <button
                  onClick={async () => { try { await navigator.clipboard.writeText(mapShare.url); toast.success("Link copiato"); } catch { /* noop */ } }}
                  className="px-3 py-2 rounded-lg border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10 text-xs font-semibold">
                  Copia
                </button>
              </div>
              {mapShare.qr && (
                <div className="flex items-center gap-4">
                  <img src={mapShare.qr} alt="QR code Mappa Orari" className="w-36 h-36 rounded-lg bg-white p-1.5" />
                  <div className="space-y-2 text-[11px] text-zinc-400">
                    <p>Stampa il QR alle <b className="text-zinc-200">paline</b> o sulle locandine: il passeggero lo inquadra e apre la mappa dal telefono.</p>
                    <a href={mapShare.qr} download="mappa-orari-qr.png"
                      className="inline-block px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:border-cyan-500/50 hover:text-cyan-300 font-semibold">
                      Scarica QR (PNG)
                    </a>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => window.open(mapShare.url, "_blank")}
                  className="px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold">
                  Apri anteprima
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
