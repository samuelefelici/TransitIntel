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
function schematicInnerSvg(
  lines: SchemLine[], W: number, H: number, M: number,
  opts?: { nameSize?: number; nodesOnly?: boolean; cityNodes?: Array<{ name: string; lat: number; lon: number }>; basemap?: boolean; labelMode?: NetNodeLabels },
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
    const pts = l.stops.map((s) => ({ k: keyOf(s), p: (() => { const e = node.get(keyOf(s))!; return P(e.lon, e.lat); })() }));
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
    if (!d) { const e0 = node.get(keyOf(l.stops[0]))!; const p0 = P(e0.lon, e0.lat); d = `${p0.x.toFixed(1)},${p0.y.toFixed(1)}`; }
    return `<polyline points="${d}" fill="none" stroke="${lineColor(l.color)}" stroke-width="${strokeW.toFixed(1)}" stroke-linejoin="round" stroke-linecap="round"${dashFor(l.style)} opacity="0.92"/>`;
  }).join("");

  // nodi + nomi
  let dots = "", names = "", idx = 0;
  for (const e of node.values()) {
    const { x, y } = P(e.lon, e.lat);
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

const POSTER_CSS = `
  ${PRINT_BASE_CSS}
  @page { size: A4 landscape; margin: 8mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .poster { display: grid; grid-template-columns: 30% 70%; gap: 12px; align-items: start; }
  .col h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #555; margin: 4px 0 8px; }
  .diagram { }
  /* matrice orari: righe = fermate, colonne = corse (orario di partenza) */
  .daygrp { margin-bottom: 10px; break-inside: avoid; }
  /* intestazioni NEUTRE (grigio scuro), non del colore della linea */
  .daygrp h4 { font-size: 11px; font-weight: 800; color: #fff; background: #334155; padding: 3px 8px; border-radius: 4px; margin: 0 0 3px; letter-spacing: .03em; }
  table.mx { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  table.mx th, table.mx td { border: 1px solid #bbb; font-size: 9px; padding: 1px 3px; text-align: center; font-variant-numeric: tabular-nums; }
  table.mx th.stop { text-align: left; background: #f1f1f1; font-weight: 700; max-width: 46mm; min-width: 30mm; }
  table.mx th.stop.head { background: #334155; color: #fff; }
  table.mx th.stop.term { background: #e2e8f0; }
  table.mx thead th { background: #475569; color: #fff; font-weight: 800; }
  table.mx thead th sup { font-size: 7px; font-weight: 800; }
  table.mx tbody tr:nth-child(even) td { background: #fafafa; }
  table.mx td.term { font-weight: 700; }
  /* marcature sabato (fuso nel gruppo Feriale): colonna evidenziata */
  table.mx thead tr th.exclsat { background: #f59e0b; color: #111; }
  table.mx tbody tr td.exclsat { background: #fde68a; }
  table.mx thead tr th.solosat { background: #06b6d4; color: #111; }
  table.mx tbody tr td.solosat { background: #a5f3fc; }
  .legend { font-size: 8.5px; color: #444; margin: 1px 0 4px; display: flex; gap: 12px; align-items: center; }
  .legend .sw { display: inline-block; width: 9px; height: 9px; border: 1px solid #999; margin-right: 3px; vertical-align: -1px; }
`;

interface PosterDir {
  dirLabel: string;
  nodes: Array<{ name: string; term: boolean }>;   // righe = TUTTE le fermate, in ordine
  // colonne = corse; cells[i] = transito al nodo i; flag = marcatura sabato;
  // notes = testi nota (a chiamata, escluso venerdì…) → simbolo + legenda
  days: Array<{ name: string; trips: Array<{ dep: string; cells: string[]; flag?: "exclsat" | "solosat"; notes?: string[] }> }>;
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

  // Registro NOTE a livello di linea: ogni testo-nota distinto → simbolo (a,b,c…),
  // così la stessa nota ha lo stesso simbolo in tutte le tabelle e la legenda è unica.
  const noteSym = new Map<string, string>();
  const SYM = "abcdefghijklmnopqrstuvwxyz";
  for (const dir of line.directions) for (const day of dir.days) for (const t of day.trips)
    for (const n of (t.notes ?? [])) if (!noteSym.has(n)) noteSym.set(n, SYM[noteSym.size] ?? "*");
  const supOf = (t: { notes?: string[] }) => {
    const s = (t.notes ?? []).map((n) => noteSym.get(n)).filter(Boolean).join("");
    return s ? `<sup>${s}</sup>` : "";
  };

  // MATRICE: righe = TUTTE le fermate, colonne = corse (orario di partenza), valori = transito.
  const dirsHtml = line.directions.map((dir) =>
    dir.days.map((day) => {
      if (!day.trips.length) return "";
      const chunks: Array<typeof day.trips> = [];
      for (let i = 0; i < day.trips.length; i += PER) chunks.push(day.trips.slice(i, i + PER));
      const tables = chunks.map((ch) => {
        const head = `<tr><th class="stop head">Fermata</th>${ch.map((t) => `<th class="${t.flag ?? ""}">${esc(t.dep)}${supOf(t)}</th>`).join("")}</tr>`;
        const rows = dir.nodes.map((nd, i) =>
          `<tr><th class="stop${nd.term ? " term" : ""}">${esc(nd.name)}</th>${ch.map((t) => `<td class="${[nd.term ? "term" : "", t.flag ?? ""].filter(Boolean).join(" ")}">${t.cells[i] || "·"}</td>`).join("")}</tr>`).join("");
        return `<table class="mx"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
      }).join("");
      const legends: string[] = [];
      if (day.trips.some((t) => t.flag === "exclsat")) legends.push(`<span><span class="sw" style="background:#fde68a"></span>Escluso il sabato</span>`);
      if (day.trips.some((t) => t.flag === "solosat")) legends.push(`<span><span class="sw" style="background:#a5f3fc"></span>Solo il sabato</span>`);
      // note usate in questo gruppo → simbolo = testo
      const usedNotes = new Set<string>();
      for (const t of day.trips) for (const n of (t.notes ?? [])) usedNotes.add(n);
      for (const n of usedNotes) legends.push(`<span><b>${noteSym.get(n)}</b> = ${esc(n)}</span>`);
      const legend = legends.length ? `<div class="legend">${legends.join("")}</div>` : "";
      return `<div class="daygrp"><h4>${esc(dir.dirLabel)} · ${esc(day.name)} · ${day.trips.length} corse</h4>${tables}${legend}</div>`;
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

function buildNetworkMapHtml(data: NetworkData, nodesOnly = false, cityBg = false, mapBg = false, logoUrl = "", lineStyles: Record<string, NetLineStyle> = {}, nodeLabels: NetNodeLabels = "logical", rotate = 0): string {
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

  const W = 1000, H = 1414, M = 42;            // margine interno ridotto → mappa più ampia
  const legendH = lines.length * 18 + 10;
  const Hd = H - legendH - 12;                 // altezza area schema (sopra la legenda)
  const rot = (((Math.round(rotate / 90) * 90) % 360) + 360) % 360; // 0/90/180/270
  const swap = rot === 90 || rot === 270;
  const dW = swap ? Hd : W, dH = swap ? W : Hd; // dimensioni con cui disegnare lo schema
  const svgInner = schematicInnerSvg(
    lines.map((l) => ({ color: l.color, stops: l.stops, style: lineStyles[l.routeId] ?? "solid" })),
    dW, dH, M, { nameSize: 9, nodesOnly, cityNodes: cityBg ? data.cityNodes : undefined, basemap: mapBg, labelMode: nodeLabels },
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
      <div class="t"><h1>Mappa di Rete</h1><div class="sub">Schema linee · interscambi e nodi principali</div><div class="powered">Powered by Cerbero</div></div>
      <div class="meta"><div><b>${lines.length}</b> linee · <b>${interCount}</b> interscambi</div><div>Generato ${gen}</div></div>
    </div>`;
  const footer = `<div class="brandfoot">
      ${logoUrl ? `<img src="${logoUrl}" alt="logo" />` : ""}
      <span class="powered">Powered by Cerbero Analytics</span>
      <span style="margin-left:auto">Mappa schematica octolineare · interscambi cerchiati</span>
    </div>`;

  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Cerbero Analytics — Mappa di Rete</title>
  <style>
    ${PRINT_BASE_CSS}
    @page{size:A4 portrait;margin:8mm}
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
  const [printing, setPrinting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareDays, setShareDays] = useState<number>(7); // durata link condiviso (0 = senza scadenza)
  // dialog post-creazione del link Mappa Orari (URL + QR da stampare)
  const [mapShare, setMapShare] = useState<{ url: string; expiresAt: string | null; qr: string | null; linesCount: number } | null>(null);
  // gestione link Mappa Orari esistenti (i QR alle paline NON si ristampano:
  // stesso token = stesso QR, si aggiorna il contenuto)
  const [manageOpen, setManageOpen] = useState(false);
  // Dominio dell'app: funziona SEMPRE (un dominio custom richiederebbe DNS
  // configurato — se sbagliato, i QR stampati nascerebbero morti).
  const publicBase = window.location.origin.replace(/\/+$/, "");

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

  // Stampa "locandine di linea": una locandina per linea × direzione.
  // Righe = TUTTE le fermate della linea; gruppi per VALIDITÀ dal calendario
  // aziendale di Planner Studio: per ogni macro-categoria (es. Scuole aperte)
  // → "Feriale" (con il SABATO fuso: le corse feriali non effettuate il sabato
  // sono evidenziate "Escluso il sabato", quelle solo del sabato "Solo il
  // sabato") e "Festivo"; gli eventuali day-type custom restano gruppi propri.
  async function printPosters() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    const dirs = directionId === "all" ? ["0", "1"] : [directionId];
    const dtByCode = new Map(dayTypes.map((d) => [d.code, d]));
    setPrinting(true);
    try {
      const lines: PosterLine[] = [];
      for (const rid of ids) {
        let route: RouteTimetable["route"] | null = null;
        let pathStops: RouteTimetable["pathStops"]; let cityNodes: RouteTimetable["cityNodes"];
        const directions: PosterDir[] = [];
        for (const dir of dirs) {
          // UNA chiamata per direzione, SENZA filtro day-type: tutte le corse
          // attive con la loro validità (dayTypeCodes + categoryIds).
          const rt = await apiFetch<RouteTimetable>(`${ptt}/route/${encodeURIComponent(rid)}?directionId=${dir}`);
          if (!route) { route = rt.route; pathStops = rt.pathStops; cityNodes = rt.cityNodes; }
          if (!rt.trips.length) continue;

          // righe = TUTTE le fermate della matrice master (in ordine di percorso)
          const nodes = rt.stops.map((s, i) => ({
            name: s.stopName, term: i === 0 || i === rt.stops.length - 1,
          }));

          // colonna per corsa: transiti a tutte le fermate + NOTE automatiche
          const WD_IT = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
          const cols = rt.trips.map((t) => {
            const cells = t.times.map((v) => (v ? v.slice(0, 5) : ""));
            const dep = cells.find((c) => c) ?? "";
            const dayCodes = new Set(t.dayTypeCodes ?? []);
            // note: "a chiamata" + giorni feriali esclusi (es. non il venerdì)
            const notes: string[] = [];
            if (t.onDemand) notes.push("Su prenotazione (a chiamata)");
            if (Array.isArray(t.weekdays) && dayCodes.has("feriale")) {
              const excl: string[] = [];
              for (let i = 0; i < 5; i++) if (t.weekdays[i] === false) excl.push(WD_IT[i]);
              if (excl.length && excl.length < 5) notes.push(`Escluso il ${excl.join(", ")}`);
            }
            return {
              dep, cells, sort: hhmmToMin(dep) ?? 9999,
              dayCodes, catIds: (t.categoryIds ?? []), notes,
            };
          }).filter((c) => c.cells.some((x) => x));

          // sezioni per macro-categoria (calendario aziendale); se il progetto
          // non usa le categorie → un'unica sezione senza prefisso
          const cats: Array<{ id: string | null; name: string }> = (rt.categories?.length)
            ? rt.categories.map((c) => ({ id: c.id, name: c.name }))
            : [{ id: null, name: "" }];
          if (rt.categories?.length && cols.some((c) => c.catIds.length === 0)) {
            cats.push({ id: "__none", name: "Senza categoria" });
          }

          const days: PosterDir["days"] = [];
          const pushGroup = (name: string, trips: Array<{ dep: string; cells: string[]; flag?: "exclsat" | "solosat"; notes?: string[]; sort: number }>) => {
            if (!trips.length) return;
            // CONTROLLO RIPETIZIONI: colonne identiche (stessi transiti, stessa
            // marcatura e stesse note) collassate in una sola
            const seen = new Set<string>();
            const unique = trips
              .sort((a, b) => a.sort - b.sort)
              .filter((t) => {
                const k = `${t.flag ?? ""}|${(t.notes ?? []).join(",")}|${t.cells.join("|")}`;
                if (seen.has(k)) return false;
                seen.add(k); return true;
              })
              .map(({ sort: _s, ...t }) => t);
            days.push({ name, trips: unique });
          };

          for (const cat of cats) {
            const inCat = cols.filter((c) =>
              cat.id === null ? true : cat.id === "__none" ? c.catIds.length === 0 : c.catIds.includes(cat.id));
            if (!inCat.length) continue;
            const pfx = cat.name ? `${cat.name} · ` : "";
            // FERIALE con sabato fuso
            pushGroup(`${pfx}Feriale`, inCat
              .filter((c) => c.dayCodes.has("feriale") || c.dayCodes.has("sabato"))
              .map((c) => ({
                dep: c.dep, cells: c.cells, sort: c.sort, notes: c.notes,
                flag: c.dayCodes.has("feriale") && !c.dayCodes.has("sabato") ? "exclsat" as const
                  : !c.dayCodes.has("feriale") && c.dayCodes.has("sabato") ? "solosat" as const : undefined,
              })));
            // FESTIVO
            pushGroup(`${pfx}Festivo`, inCat
              .filter((c) => c.dayCodes.has("festivo"))
              .map((c) => ({ dep: c.dep, cells: c.cells, sort: c.sort, notes: c.notes })));
            // eventuali day-type CUSTOM del progetto (tutte le altre validità)
            const customCodes = [...new Set(inCat.flatMap((c) => [...c.dayCodes]))]
              .filter((code) => code !== "feriale" && code !== "sabato" && code !== "festivo").sort();
            for (const code of customCodes) {
              pushGroup(`${pfx}${dtByCode.get(code)?.name ?? code}`, inCat
                .filter((c) => c.dayCodes.has(code))
                .map((c) => ({ dep: c.dep, cells: c.cells, sort: c.sort, notes: c.notes })));
            }
            // CONTROLLO DATI: corse senza alcuna validità giorno → gruppo dedicato
            pushGroup(`${pfx}⚠ Senza validità giorno`, inCat
              .filter((c) => c.dayCodes.size === 0)
              .map((c) => ({ dep: c.dep, cells: c.cells, sort: c.sort, notes: c.notes })));
          }

          directions.push({ dirLabel: dir === "0" ? "Andata" : "Ritorno", nodes, days });
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
      const logoUrl = `${window.location.origin}/logo.png`;
      openPrintWindow(buildNetworkMapHtml(data2, nodesOnly, cityBg, mapBg, logoUrl, lineStyles, nodeLabels, mapRotate));
    } catch (e: any) {
      toast.error(e?.message ?? "Errore durante la stampa");
    } finally { setPrinting(false); }
  }

  // Crea un link pubblico condivisibile della Mappa di Rete (selezione linee a video).
  async function shareNetwork() {
    const ids = selectedIdsOrdered();
    if (!ids.length) { toast.error("Seleziona almeno una linea"); return; }
    setSharing(true);
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
    } finally { setSharing(false); }
  }

  // Link pubblico MAPPA ORARI per i passeggeri: giorno → linea → mappa →
  // fermata → orari (con corse a chiamata). Linee selezionate = solo quelle
  // nel link; nessuna selezione = TUTTE. Il dialog mostra URL + QR da
  // stampare alle paline, con la durata scelta nella tendina "Link:".
  async function shareTimetableMap() {
    setSharing(true);
    try {
      const ids = selectedIdsOrdered();
      const r = await apiFetch<{ token: string; expiresAt: string | null }>(`/api/planning-studio/${encodeURIComponent(projectId)}/timetable-map-share`, {
        method: "POST", body: JSON.stringify({ routeIds: ids, expiresInDays: shareDays }),
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
    } finally { setSharing(false); }
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

  async function patchShare(tokenStr: string, patch: { routeIds?: string[]; expiresInDays?: number }, okMsg: string) {
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
            <label className="flex items-center gap-2 text-xs text-muted-foreground select-none" title="Quali nomi mostrare sui nodi: solo i nodi logici (le altre fermate restano un pallino) o tutte le fermate">
              <span>Nomi</span>
              <select
                value={nodeLabels}
                onChange={(e) => setNodeLabels(e.target.value as NetNodeLabels)}
                className="px-2 py-1 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-sky-500/60 cursor-pointer"
              >
                <option value="logical">Solo nodi logici</option>
                <option value="all">Tutte le fermate</option>
              </select>
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
              <select
                value={mapRotate}
                onChange={(e) => setMapRotate(Number(e.target.value))}
                className="px-2 py-2.5 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-fuchsia-500/60 cursor-pointer"
                title="Ruota la mappa di rete in stampa (per adattarla meglio al foglio)"
              >
                <option value={0}>Rotazione: 0°</option>
                <option value={90}>Rotazione: 90°</option>
                <option value={180}>Rotazione: 180°</option>
                <option value={270}>Rotazione: 270°</option>
              </select>
              <button
                onClick={printNetwork}
                disabled={printing || selectedRouteIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-fuchsia-500/60 text-fuchsia-300 hover:bg-fuchsia-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Mappa di rete: linee selezionate con gli interscambi (fermate condivise). Più evidente con 2+ linee."
              >
                {printing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                Mappa rete
              </button>
              <select
                value={shareDays}
                onChange={(e) => setShareDays(Number(e.target.value))}
                className="px-2 py-2.5 rounded-lg bg-card border border-border/60 text-xs outline-none focus:border-fuchsia-500/60"
                title="Durata del link condiviso"
              >
                <option value={1}>Link: 24 ore</option>
                <option value={7}>Link: 7 giorni</option>
                <option value={30}>Link: 30 giorni</option>
                <option value={90}>Link: 90 giorni</option>
                <option value={180}>Link: 6 mesi</option>
                <option value={365}>Link: 1 anno</option>
                <option value={0}>Link: sempre online</option>
              </select>
              <button
                onClick={shareNetwork}
                disabled={sharing || selectedRouteIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-fuchsia-500/60 text-fuchsia-300 hover:bg-fuchsia-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Crea un link pubblico della Mappa di Rete (l'utente sceglie le linee da vedere)"
              >
                {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                Condividi
              </button>
              <button
                onClick={shareTimetableMap}
                disabled={sharing}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-cyan-500/60 text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Crea un link pubblico MAPPA ORARI: l'utente sceglie la linea, vede percorsi e fermate sulla mappa e, toccando una fermata, gli orari di transito con le corse a chiamata. Linee selezionate = solo quelle; nessuna selezione = tutte."
              >
                {sharing ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPinned className="w-4 h-4" />}
                Mappa orari
              </button>
              <button
                onClick={() => setManageOpen(true)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border/60 text-muted-foreground hover:text-cyan-300 hover:border-cyan-500/40 text-sm font-medium transition-colors"
                title="Link Mappa Orari già creati: aggiorna le linee incluse o la scadenza SENZA cambiare il QR stampato, riscarica i QR, revoca."
              >
                <QrCode className="w-4 h-4" />
                Gestisci link
              </button>
              <button
                onClick={printPosters}
                disabled={printing || selectedRouteIds.length === 0}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-indigo-500/60 text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50 text-sm font-medium transition-colors"
                title="Locandina per direzione: tutte le fermate come righe; validità dal calendario aziendale (per macro-categoria: Feriale con sabato fuso + Festivo). Le corse feriali non effettuate il sabato sono evidenziate."
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
