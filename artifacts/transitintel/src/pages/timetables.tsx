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
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeftRight, Loader2, Map as MapIcon, MapPin, Printer, Search, Share2, SignpostBig,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import NetworkMap3D from "@/components/NetworkMap3D";

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
  trips: Array<{ tripId: string; headsign: string | null; directionId: number | null; times: (string | null)[] }>;
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

/* ── Orario generale di linea (A4 orizzontale, paginato) ── */

const ROUTE_TT_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 landscape; margin: 8mm; }
  table.tt { width: 100%; border-collapse: collapse; }
  table.tt th, table.tt td { border: 1px solid #999; font-size: 9.5px; padding: 2px 4px; text-align: center; font-variant-numeric: tabular-nums; }
  table.tt th.stop { text-align: left; background: #f1f1f1; font-weight: 600; max-width: 52mm; min-width: 38mm; }
  table.tt th.stop.head { background: #111; color: #fff; }
  table.tt th.trip { background: #111; color: #fff; }
  table.tt th.trip .hs { font-size: 7.5px; font-weight: 600; max-width: 18mm; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  table.tt tbody tr:nth-child(even) td { background: #fafafa; }
  table.tt td { font-weight: 600; }
`;

function routeTimetablePages(data: RouteTimetable): string {
  const gen = new Date().toLocaleString("it-IT");
  const col = lineColor(data.route.color);
  const PER_PAGE = 14;
  const chunks: RouteTimetable["trips"][] = [];
  for (let i = 0; i < data.trips.length; i += PER_PAGE) chunks.push(data.trips.slice(i, i + PER_PAGE));
  if (chunks.length === 0) chunks.push([]);

  const dirLabel = data.directionId == null ? "Andata + Ritorno" : data.directionId === 0 ? "Andata" : "Ritorno";
  const dayLbl = data.dayTypeName ?? "Tutte le corse";

  return chunks.map((chunk, pi) => {
    const headRow = chunk.map((t) => `<th class="trip"><div class="hs">${esc(t.headsign ?? "")}</div></th>`).join("");
    const bodyRows = data.stops.map((s, si) => `
      <tr>
        <th class="stop">${esc(s.stopName)}</th>
        ${chunk.map((t) => `<td>${t.times[si] ?? "·"}</td>`).join("")}
      </tr>`).join("");
    return `
    <section class="page">
      <header class="doc">
        <div class="pill" style="background:${col}">${esc(data.route.shortName ?? "?")}</div>
        <h1>${esc(data.route.longName ?? "Orario di linea")}</h1>
        <div class="day">${esc(dayLbl)} · ${dirLabel}${chunks.length > 1 ? `<br><small style="font-weight:400">pagina ${pi + 1}/${chunks.length}</small>` : ""}</div>
      </header>
      <table class="tt">
        <thead><tr><th class="stop head">Fermata</th>${headRow}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
      <footer class="doc"><span>TransitIntel · orario generale linea ${esc(data.route.shortName ?? "")}</span><span>Generato il ${gen}</span></footer>
    </section>`;
  }).join("");
}

function buildCombinedRouteTimetableHtml(docs: RouteTimetable[]): string {
  const body = docs.filter((d) => d.trips.length > 0).map(routeTimetablePages).join("");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Orari per il pubblico</title>
  <style>${ROUTE_TT_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna corsa per la selezione.</p>"}</body></html>`;
}

/* ── Locandina di linea (A4 verticale): percorso stilizzato + partenze cadenzate ── */

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
interface SchemLine { color: string | null; stops: SchemStop[] }

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
function schematicInnerSvg(
  lines: SchemLine[], W: number, H: number, M: number,
  opts?: { nameSize?: number; nodesOnly?: boolean; cityNodes?: Array<{ name: string; lat: number; lon: number }>; basemap?: boolean },
): string {
  const nameSize = opts?.nameSize ?? 8;
  const src = opts?.nodesOnly
    ? lines.map((l) => ({ color: l.color, stops: collapseToLogicalNodes(l.stops) }))
    : lines;
  const usable = src.filter((l) => l.stops.length > 0);
  if (!usable.length) return "";

  // CHIAVE NODO: per le fermate di un nodo logico (cluster isLogical) si usa il
  // cluster + il suo centroide → linee diverse che toccano lo stesso nodo logico
  // CONVERGONO nello stesso punto, anche senza "Solo nodi logici".
  const keyOf = (s: SchemStop) => (s.clusterLogical && s.clusterId) ? `c:${s.clusterId}` : `s:${s.stopId}`;
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
  if (opts?.basemap && geoPts.length) {
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

  // sfondo città (leggero, grigio) — salta i punti che coincidono con un nodo disegnato
  const drawnPos = new Set([...node.values()].map((e) => `${e.lon.toFixed(5)},${e.lat.toFixed(5)}`));
  const bg = cityNodes
    .filter((c) => !drawnPos.has(`${c.lon.toFixed(5)},${c.lat.toFixed(5)}`))
    .map((c) => {
      const { x, y } = P(c.lon, c.lat);
      return `<g opacity="0.5"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#94a3b8"/>`
        + `<text x="${(x + 5).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="${(nameSize - 0.5).toFixed(1)}" fill="#64748b">${esc(c.name)}</text></g>`;
    }).join("");

  // polilinee: estremi sui nodi (convergenza) + gomiti octolineari tra nodi
  const polys = usable.map((l) => {
    const sp = l.stops.map((s) => { const e = node.get(keyOf(s))!; return P(e.lon, e.lat); });
    if (!sp.length) return "";
    let d = `${sp[0].x.toFixed(1)},${sp[0].y.toFixed(1)}`;
    for (let i = 1; i < sp.length; i++) {
      for (const e of elbow(sp[i - 1].x, sp[i - 1].y, sp[i].x, sp[i].y)) d += ` ${e.x.toFixed(1)},${e.y.toFixed(1)}`;
    }
    return `<polyline points="${d}" fill="none" stroke="${lineColor(l.color)}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity="0.92"/>`;
  }).join("");

  // nodi + nomi
  let dots = "", names = "", idx = 0;
  for (const e of node.values()) {
    const { x, y } = P(e.lon, e.lat);
    const major = e.logical || e.lines.size >= 2; // nodo logico o interscambio → evidenziato
    if (major) {
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#fff" stroke="#111" stroke-width="3"/>`;
      names += `<text x="${(x + 10).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="${nameSize + 1.5}" font-weight="800" fill="#111" stroke="#fff" stroke-width="0.6" paint-order="stroke">${esc(e.name)}</text>`;
    } else {
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="#fff" stroke="#111" stroke-width="1.6"/>`;
      const up = idx % 2 === 0;
      names += `<text x="${(x + 6).toFixed(1)}" y="${(y + (up ? -5 : 9)).toFixed(1)}" font-size="${nameSize}" fill="#333" stroke="#fff" stroke-width="0.5" paint-order="stroke">${esc(e.name)}</text>`;
    }
    idx++;
  }
  return tilesLayer + bg + polys + dots + names;
}

const POSTER_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 landscape; margin: 8mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .poster { display: grid; grid-template-columns: 30% 70%; gap: 12px; align-items: start; }
  .col h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin: 4px 0 8px; }
  .diagram { }
  /* matrice orari: righe = fermate, colonne = corse (orario di partenza) */
  .daygrp { margin-bottom: 10px; break-inside: avoid; }
  .daygrp h4 { font-size: 11px; font-weight: 800; color: #fff; background: var(--c); padding: 3px 8px; border-radius: 4px; margin: 0 0 3px; letter-spacing: .03em; }
  table.mx { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  table.mx th, table.mx td { border: 1px solid #bbb; font-size: 9px; padding: 1px 3px; text-align: center; font-variant-numeric: tabular-nums; }
  table.mx th.stop { text-align: left; background: #f1f1f1; font-weight: 700; max-width: 46mm; min-width: 30mm; }
  table.mx th.stop.head { background: #111; color: #fff; }
  table.mx th.stop.term { background: #e2e8f0; }
  table.mx thead th { background: var(--c); color: #fff; font-weight: 800; }
  table.mx tbody tr:nth-child(even) td { background: #fafafa; }
  table.mx td.term { font-weight: 700; }
`;

interface PosterDir {
  dirLabel: string;
  nodes: Array<{ name: string; term: boolean }>;   // righe = fermate principali, in ordine
  days: Array<{ name: string; trips: Array<{ dep: string; cells: string[] }> }>; // colonne = corse; cells[i] = transito al nodo i
}
interface PosterLine {
  route: RouteTimetable["route"];
  pathStops?: RouteTimetable["pathStops"];
  cityNodes?: RouteTimetable["cityNodes"];
  directions: PosterDir[];
}

function linePosterPage(line: PosterLine, nodesOnly = false, cityBg = false): string {
  const col = lineColor(line.route.color);
  const gen = new Date().toLocaleString("it-IT");
  const PER = 16; // corse (colonne) per blocco

  // PERCORSO (immagine invariata): variante più esercitata, schema octolineare.
  const schemStops: SchemStop[] = (line.pathStops ?? [])
    .filter((s) => s.lat != null && s.lon != null)
    .map((s) => ({
      stopId: s.stopId, name: s.stopName, lat: s.lat as number, lon: s.lon as number,
      clusterId: s.clusterId, clusterName: s.clusterName, clusterLogical: s.clusterLogical,
      clusterLat: s.clusterLat, clusterLon: s.clusterLon,
    }));
  const percorso = schemStops.length >= 2
    ? `<svg viewBox="0 0 460 1020" width="100%" style="max-height:185mm">${schematicInnerSvg([{ color: line.route.color, stops: schemStops }], 460, 1020, 52, { nameSize: 8, nodesOnly, cityNodes: cityBg ? line.cityNodes : undefined })}</svg>`
    : "<div class='diagram'></div>";

  // MATRICE: righe = fermate, colonne = corse (orario di partenza), valori = transito.
  const dirsHtml = line.directions.map((dir) =>
    dir.days.map((day) => {
      if (!day.trips.length) return `<div class="daygrp"><h4>${esc(dir.dirLabel)} · ${esc(day.name)}</h4><p style="font-size:10px;color:#666">Nessuna corsa.</p></div>`;
      const chunks: Array<typeof day.trips> = [];
      for (let i = 0; i < day.trips.length; i += PER) chunks.push(day.trips.slice(i, i + PER));
      const tables = chunks.map((ch) => {
        const head = `<tr><th class="stop head">Fermata</th>${ch.map((t) => `<th>${esc(t.dep)}</th>`).join("")}</tr>`;
        const rows = dir.nodes.map((nd, i) =>
          `<tr><th class="stop${nd.term ? " term" : ""}">${esc(nd.name)}</th>${ch.map((t) => `<td class="${nd.term ? "term" : ""}">${t.cells[i] || "·"}</td>`).join("")}</tr>`).join("");
        return `<table class="mx"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
      }).join("");
      return `<div class="daygrp"><h4>${esc(dir.dirLabel)} · ${esc(day.name)} · ${day.trips.length} corse</h4>${tables}</div>`;
    }).join(""),
  ).join("");

  return `
  <section class="page" style="--c:${col}">
    <header class="doc" style="border-color:${col}">
      <div class="pill" style="background:${col}">${esc(line.route.shortName ?? "?")}</div>
      <h1>${esc(line.route.longName ?? "Linea")}</h1>
      <div class="day">Orari al pubblico</div>
    </header>
    <div class="poster">
      <div class="col">
        <h2>Percorso</h2>
        ${percorso}
      </div>
      <div class="col">
        <h2>Orari (transito alle fermate)</h2>
        ${dirsHtml || "<p style='font-size:11px;color:#666'>Nessuna corsa per la selezione.</p>"}
      </div>
    </div>
    <footer class="doc"><span>TransitIntel · linea ${esc(line.route.shortName ?? "")} · colonne = corse, valori = orario di transito</span><span>Generato il ${gen}</span></footer>
  </section>`;
}

function buildCombinedLinePostersHtml(lines: PosterLine[], nodesOnly = false, cityBg = false): string {
  const hasTimes = (l: PosterLine) => l.directions.some((dir) => dir.days.some((d) => d.trips.length > 0));
  const body = lines.filter(hasTimes).map((l) => linePosterPage(l, nodesOnly, cityBg)).join("");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
  <title>Locandine di linea</title>
  <style>${POSTER_CSS}</style></head><body>${body || "<p style='padding:20mm'>Nessuna corsa per la selezione.</p>"}</body></html>`;
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

function buildNetworkMapHtml(data: NetworkData, nodesOnly = false, cityBg = false, mapBg = false): string {
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

  const W = 1000, H = 1414, M = 90;
  const legendH = lines.length * 20 + 12;
  const svgBody = schematicInnerSvg(
    lines.map((l) => ({ color: l.color, stops: l.stops })),
    W, H - legendH - 16, M, { nameSize: 9, nodesOnly, cityNodes: cityBg ? data.cityNodes : undefined, basemap: mapBg },
  );
  const legendRows = lines.map((l, i) =>
    `<g transform="translate(0,${i * 20})"><rect width="16" height="10" rx="2" fill="${lineColor(l.color)}"/>`
    + `<text x="22" y="9" font-size="11" fill="#111"><tspan font-weight="800">${esc(l.shortName ?? "?")}</tspan> ${esc(l.longName ?? "")}</text></g>`).join("");

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Mappa di rete</title>
  <style>${PRINT_BASE_CSS} @page{size:A4 portrait;margin:8mm} *{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head>
  <body><section class="page">
    <header class="doc"><div class="pill" style="background:#111">🗺️</div><h1>Mappa di rete · schema linee</h1>
      <div class="day">${interCount} interscambi</div></header>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="100%">
      ${svgBody}
      <g transform="translate(${M}, ${H - legendH})">
        <rect x="-8" y="-8" width="${W - 2 * M + 16}" height="${legendH}" fill="#ffffffcc" stroke="#ddd"/>
        ${legendRows}
      </g>
    </svg>
    <footer class="doc"><span>TransitIntel · mappa schematica (octolineare) · interscambi cerchiati</span><span>Generato il ${gen}</span></footer>
  </section></body></html>`;
}

/* ─── Pagina ─── */

export default function TimetablesPage() {
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
  const [printing, setPrinting] = useState(false);
  const [nodesOnly, setNodesOnly] = useState(false); // schema solo nodi logici
  const [cityBg, setCityBg] = useState(true);          // sfondo schematico punti città
  const [mapBg, setMapBg] = useState(true);            // cartografia di sfondo (tile) sulla mappa rete
  const [show3d, setShow3d] = useState(false);         // anteprima mappa 3D interattiva
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>({}); // colore linee (override locale + persistito)

  const effColor = (routeId: string, fallback: string | null | undefined): string | null => colorOverrides[routeId] ?? fallback ?? null;
  function setRouteColor(routeId: string, color: string) {
    setColorOverrides((prev) => ({ ...prev, [routeId]: color }));
    apiFetch(`/api/planning-studio/projects/${encodeURIComponent(projectId)}/routes/${encodeURIComponent(routeId)}`, {
      method: "PATCH", body: JSON.stringify({ color }),
    }).catch(() => { /* l'override locale resta applicato anche se il salvataggio fallisce */ });
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
    queryFn: () => apiFetch<{ dayTypes: PsDayType[] }>(`/api/planning-studio/projects/${encodeURIComponent(projectId)}/day-types`),
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000,
  });
  const dayTypes: PsDayType[] = useMemo(() => dayTypesQ.data?.dayTypes ?? [], [dayTypesQ.data]);

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

  async function printPublic() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    if (!routeDayTypeIds.length) { toast.error("Seleziona almeno un day-type"); return; }
    setPrinting(true);
    try {
      const docs: RouteTimetable[] = [];
      for (const rid of ids) {
        for (const dt of routeDayTypeIds) {
          const url = `${ptt}/route/${encodeURIComponent(rid)}?dayTypeId=${encodeURIComponent(dt)}`
            + (directionId !== "all" ? `&directionId=${directionId}` : "");
          docs.push(await apiFetch<RouteTimetable>(url));
        }
      }
      if (!docs.some((x) => x.trips.length > 0)) { toast.error("Nessuna corsa per la selezione"); return; }
      openPrintWindow(buildCombinedRouteTimetableHtml(docs));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
  }

  async function printPaline() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    if (!routeDayTypeIds.length) { toast.error("Seleziona almeno un day-type"); return; }
    setPrinting(true);
    try {
      const rs = await apiFetch<{ stops: Array<{ stopId: string; stopName: string; stopCode: string | null }> }>(
        `${ptt}/route-stops?routeIds=${ids.map(encodeURIComponent).join(",")}`,
      );
      const stops = rs.stops ?? [];
      if (!stops.length) { toast.error("Nessuna fermata per le linee selezionate"); return; }
      const docs: StopTimetable[] = [];
      for (const s of stops) {
        for (const dt of routeDayTypeIds) {
          const url = `${ptt}/stop/${encodeURIComponent(s.stopId)}?dayTypeId=${encodeURIComponent(dt)}`;
          docs.push(await apiFetch<StopTimetable>(url));
        }
      }
      if (!docs.some((x) => x.lines.length > 0)) { toast.error("Nessuna partenza per la selezione"); return; }
      openPrintWindow(buildCombinedStopPostersHtml(docs));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
  }

  // Stampa "locandine di linea": una locandina per linea × direzione, con le
  // PARTENZE di TUTTE le corse divise per tipo di giorno (colonne).
  async function printPosters() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    if (!routeDayTypeIds.length) { toast.error("Seleziona almeno un day-type"); return; }
    const dirs = directionId === "all" ? ["0", "1"] : [directionId];
    const dtName = new Map(dayTypes.map((d) => [d.id, d.name]));
    setPrinting(true);
    try {
      const lines: PosterLine[] = [];
      for (const rid of ids) {
        let route: RouteTimetable["route"] | null = null;
        let pathStops: RouteTimetable["pathStops"]; let cityNodes: RouteTimetable["cityNodes"];
        const directions: PosterDir[] = [];
        for (const dir of dirs) {
          // scarico la linea per ogni tipo di giorno (stessa direzione)
          const rts: RouteTimetable[] = [];
          for (const dt of routeDayTypeIds) {
            const rt = await apiFetch<RouteTimetable>(`${ptt}/route/${encodeURIComponent(rid)}?dayTypeId=${encodeURIComponent(dt)}&directionId=${dir}`);
            rts.push(rt);
            if (!route) { route = rt.route; pathStops = rt.pathStops; cityNodes = rt.cityNodes; }
          }
          if (!rts.length) continue;
          // nodi principali (in ordine): cluster logici + capilinea, dal giorno con più fermate
          const base = rts.reduce((a, b) => (b.stops.length > a.stops.length ? b : a), rts[0]);
          const seen = new Set<string>();
          const nodeKeys: Array<{ key: string; name: string; kind: "cluster" | "stop"; ref: string; term: boolean }> = [];
          base.stops.forEach((s, i) => {
            const term = i === 0 || i === base.stops.length - 1;
            if (s.clusterLogical && s.clusterId) {
              const k = `c:${s.clusterId}`;
              if (!seen.has(k)) { seen.add(k); nodeKeys.push({ key: k, name: s.clusterName || s.stopName, kind: "cluster", ref: s.clusterId, term }); }
            } else if (term) {
              const k = `s:${s.stopId}`;
              if (!seen.has(k)) { seen.add(k); nodeKeys.push({ key: k, name: s.stopName, kind: "stop", ref: s.stopId, term: true }); }
            }
          });
          const days = rts.map((rt, di) => {
            const idxByStop = new Map<string, number>();
            const idxByCluster = new Map<string, number[]>();
            rt.stops.forEach((s, i) => {
              idxByStop.set(s.stopId, i);
              if (s.clusterId) { const a = idxByCluster.get(s.clusterId) ?? []; a.push(i); idxByCluster.set(s.clusterId, a); }
            });
            const idxsOf = (nk: typeof nodeKeys[number]) =>
              nk.kind === "cluster" ? (idxByCluster.get(nk.ref) ?? []) : (idxByStop.has(nk.ref) ? [idxByStop.get(nk.ref)!] : []);
            // una colonna per corsa: transito a ciascun nodo + orario di partenza
            const trips = rt.trips.map((t) => {
              const cells = nodeKeys.map((nk) => {
                for (const i of idxsOf(nk)) { const v = t.times[i]; if (v) return v.slice(0, 5); }
                return "";
              });
              const depIdx = cells.findIndex((c) => c);
              return { dep: depIdx >= 0 ? cells[depIdx] : "", cells, sort: hhmmToMin(cells.find((c) => c)) ?? 9999 };
            })
              .filter((t) => t.cells.some((c) => c))
              .sort((a, b) => a.sort - b.sort)
              .map(({ sort: _s, ...t }) => t);
            return { name: rt.dayTypeName ?? dtName.get(routeDayTypeIds[di]) ?? "—", trips };
          });
          directions.push({
            dirLabel: dir === "0" ? "Andata" : "Ritorno",
            nodes: nodeKeys.map((n) => ({ name: n.name, term: n.term })),
            days,
          });
        }
        if (route) lines.push({ route: { ...route, color: effColor(route.routeId, route.color) }, pathStops, cityNodes, directions });
      }
      const anyTimes = lines.some((l) => l.directions.some((d) => d.days.some((dd) => dd.trips.length > 0)));
      if (!anyTimes) { toast.error("Nessuna corsa per la selezione"); return; }
      openPrintWindow(buildCombinedLinePostersHtml(lines, nodesOnly, cityBg));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
  }

  // Stampa "mappa di rete": linee selezionate sovrapposte, interscambi cerchiati.
  async function printNetwork() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    setPrinting(true);
    try {
      const data = await apiFetch<NetworkData>(`${ptt}/network?routeIds=${ids.map(encodeURIComponent).join(",")}`);
      if (!data.lines?.some((l) => l.stops.length > 0)) { toast.error("Nessuna geometria fermate per le linee selezionate"); return; }
      const data2 = { ...data, lines: (data.lines ?? []).map((l) => ({ ...l, color: effColor(l.routeId, l.color) })) };
      openPrintWindow(buildNetworkMapHtml(data2, nodesOnly, cityBg, mapBg));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
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
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-muted-foreground">Day-type</span>
            <div className="flex flex-wrap rounded-lg overflow-hidden border border-border/60">
              {dayTypes.map((d) => (
                <button
                  key={d.id}
                  onClick={() => toggleRouteDayType(d.id)}
                  className={`px-3 py-2 text-xs transition-colors ${routeDayTypeIds.includes(d.id) ? "bg-emerald-500/20 text-emerald-300 font-medium" : "hover:bg-white/5 text-muted-foreground"}`}
                >
                  {d.name}
                </button>
              ))}
              {dayTypes.length === 0 && <span className="px-3 py-2 text-xs text-muted-foreground">Nessun day-type</span>}
            </div>
            <select
              value={directionId}
              onChange={(e) => setDirectionId(e.target.value)}
              className="px-3 py-2 rounded-lg bg-card border border-border/60 text-sm outline-none focus:border-sky-500/60"
            >
              <option value="all">Andata + Ritorno</option>
              <option value="0">Andata</option>
              <option value="1">Ritorno</option>
            </select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none" title="Riduce lo schema ai soli nodi logici definiti nel Planning Studio (cluster)">
              <input type="checkbox" checked={nodesOnly} onChange={(e) => setNodesOnly(e.target.checked)} className="accent-fuchsia-500" />
              Solo nodi logici
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none" title="Sfondo schematico leggero con i punti principali (nodi logici della città)">
              <input type="checkbox" checked={cityBg} onChange={(e) => setCityBg(e.target.checked)} className="accent-slate-400" />
              Sfondo città
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none" title="Cartografia di sfondo (mappa stilizzata leggera) solo nella Mappa rete">
              <input type="checkbox" checked={mapBg} onChange={(e) => setMapBg(e.target.checked)} className="accent-emerald-400" />
              Cartografia (mappa rete)
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setShow3d((v) => !v)}
                disabled={selectedRouteIds.length === 0}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border disabled:opacity-50 text-sm font-medium transition-colors ${show3d ? "bg-emerald-500/20 border-emerald-500/60 text-emerald-300" : "border-emerald-500/60 text-emerald-300 hover:bg-emerald-500/10"}`}
                title="Anteprima mappa 3D interattiva (edifici + terreno) delle linee selezionate"
              >
                <MapIcon className="w-4 h-4" /> Mappa 3D
              </button>
              <button
                onClick={printNetwork}
                disabled={printing || selectedRouteIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-fuchsia-500/60 text-fuchsia-300 hover:bg-fuchsia-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Mappa di rete: linee selezionate con gli interscambi (fermate condivise). Più evidente con 2+ linee."
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                Mappa rete
              </button>
              <button
                onClick={printPosters}
                disabled={printing || selectedRouteIds.length === 0 || routeDayTypeIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-indigo-500/60 text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Locandina: percorso stilizzato + partenze cadenzate, per direzione"
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapIcon className="w-4 h-4" />}
                Stampa locandine
              </button>
              <button
                onClick={printPaline}
                disabled={printing || selectedRouteIds.length === 0 || routeDayTypeIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-sky-500/60 text-sky-300 hover:bg-sky-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Quadro di palina per ogni fermata delle linee selezionate"
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <SignpostBig className="w-4 h-4" />}
                Stampa quadri palina
              </button>
              <button
                onClick={printPublic}
                disabled={printing || selectedRouteIds.length === 0 || routeDayTypeIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500/90 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
                Stampa orari pubblico{selectedRouteIds.length ? ` (${selectedRouteIds.length})` : ""}
              </button>
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
                </div>
              ))}
            </div>
          </div>

          {show3d && (
            <NetworkMap3D projectId={projectId} routeIds={sortedRoutes.filter((r) => selectedRouteIds.includes(r.routeId)).map((r) => r.routeId)} colorOverrides={colorOverrides} />
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
    </div>
  );
}
