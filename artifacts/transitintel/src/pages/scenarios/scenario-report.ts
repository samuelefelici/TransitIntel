/**
 * Report analisi linea (Scenari) — HTML/PDF stampabile, autonomo.
 *
 * Due modalità:
 *   • exportScenarioReport   — analisi approfondita di UNA linea
 *   • exportComparisonReport — confronto tra due linee
 *
 * Segue il modello degli altri report (finestra separata → window.print(),
 * CSS @page A4, logo embeddato come data-URI). I grafici sono SVG/CSS fatti a
 * mano (recharts non è disponibile in una finestra separata). La mappa è
 * vettoriale offline (nessuna chiave): percorso + fermate proiettati in SVG.
 */

/* ─── Helpers formattazione ─── */
const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fInt = (v: number): string => (isFinite(v) ? Math.round(v) : 0).toLocaleString("it-IT");
const fKm = (v: number): string => (isFinite(v) ? v : 0).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fPct = (v: number): string => (isFinite(v) ? Math.round(v * 10) / 10 : 0).toLocaleString("it-IT", { maximumFractionDigits: 1 }) + "%";
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** Colore valido su fondo chiaro (fallback violetto brand). */
function safeColor(c: string | null | undefined, fallback = "#7c3aed"): string {
  if (!c) return fallback;
  const hex = c.replace("#", "").trim();
  if ((hex.length !== 3 && hex.length !== 6) || !/^[0-9a-fA-F]+$/.test(hex)) return fallback;
  const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  if ((0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.9) return fallback;
  return "#" + full.toLowerCase();
}

const POI_CATEGORY_IT: Record<string, string> = {
  hospital: "Sanità", school: "Scuole", shopping: "Commercio", industrial: "Industria",
  leisure: "Tempo libero", office: "Uffici", transit: "Nodi trasporto", workplace: "Luoghi di lavoro",
  worship: "Culto", elderly: "Anziani/RSA", parking: "Parcheggi", tourism: "Turismo",
};
const poiLabel = (k: string) => POI_CATEGORY_IT[k] ?? k;

async function fetchLogoDataUri(): Promise<string | null> {
  try {
    const res = await fetch("/planningstudio.png");
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

/* ─── Estrazione geometria dallo scenario (FeatureCollection) ─── */
interface MapLayer { lines: number[][][]; stops: number[][]; color: string; }
function layerFromGeojson(geojson: any, color: string): MapLayer {
  const lines: number[][][] = [];
  const stops: number[][] = [];
  for (const f of (geojson?.features ?? [])) {
    const g = f?.geometry; if (!g) continue;
    if (g.type === "LineString") lines.push(g.coordinates);
    else if (g.type === "MultiLineString") for (const l of g.coordinates) lines.push(l);
    else if (g.type === "Point") stops.push(g.coordinates);
  }
  return { lines, stops, color };
}

/** Mappa vettoriale SVG (offline): proiezione equirettangolare con correzione lat. */
function buildMapSvg(layers: MapLayer[], W = 980, H = 560): string {
  const pts: number[][] = [];
  for (const ly of layers) { for (const l of ly.lines) for (const p of l) pts.push(p); for (const s of ly.stops) pts.push(s); }
  if (pts.length < 2) return `<div class="map-empty">Geometria del percorso non disponibile.</div>`;
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [x, y] of pts) { if (x < minLng) minLng = x; if (x > maxLng) maxLng = x; if (y < minLat) minLat = y; if (y > maxLat) maxLat = y; }
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180) || 1;
  const pad = 26;
  let spanX = (maxLng - minLng) * kx || 1e-6;
  let spanY = (maxLat - minLat) || 1e-6;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const usedW = spanX * scale, usedH = spanY * scale;
  const offX = (W - usedW) / 2, offY = (H - usedH) / 2;
  const px = (lng: number) => offX + (lng - minLng) * kx * scale;
  const py = (lat: number) => H - offY - (lat - minLat) * scale;

  let body = "";
  for (const ly of layers) {
    for (const l of ly.lines) {
      const d = l.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(" ");
      body += `<polyline points="${d}" fill="none" stroke="${ly.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" style="print-color-adjust:exact" />`;
    }
    for (const s of ly.stops) {
      body += `<circle cx="${px(s[0]).toFixed(1)}" cy="${py(s[1]).toFixed(1)}" r="3.6" fill="#fff" stroke="${ly.color}" stroke-width="2" style="print-color-adjust:exact" />`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" class="map-svg" preserveAspectRatio="xMidYMid meet">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#f8fafc" />
    ${body}
  </svg>`;
}

/* ─── Grafici SVG/CSS ─── */
function donut(pct: number, label: string, color = "#3b82f6"): string {
  const p = clamp(pct); const r = 52, c = 2 * Math.PI * r, on = (p / 100) * c;
  return `<svg viewBox="0 0 140 140" class="donut">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="16" />
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"
      stroke-dasharray="${on.toFixed(1)} ${(c - on).toFixed(1)}" transform="rotate(-90 70 70)" style="print-color-adjust:exact" />
    <text x="70" y="66" text-anchor="middle" class="donut-num">${fPct(p)}</text>
    <text x="70" y="88" text-anchor="middle" class="donut-lbl">${esc(label)}</text>
  </svg>`;
}

/** Lista di barre orizzontali: [{label, value, max, sub?}] */
function barList(rows: Array<{ label: string; value: number; max: number; sub?: string; color?: string }>): string {
  return `<div class="bars">${rows.map((r) => {
    const w = clamp(r.max > 0 ? (r.value / r.max) * 100 : 0);
    return `<div class="bar-row"><div class="bar-lab">${esc(r.label)}</div>
      <div class="bar"><div class="bar-fill" style="width:${w.toFixed(1)}%;${r.color ? `background:${r.color}` : ""}"></div></div>
      <div class="bar-val">${esc(r.sub ?? fInt(r.value))}</div></div>`;
  }).join("")}</div>`;
}

/** Barra a segmenti (modal split). segs=[{label,value,color}] */
function stackBar(segs: Array<{ label: string; value: number; color: string }>): string {
  const tot = segs.reduce((s, x) => s + x.value, 0) || 1;
  const bar = segs.map((s) => `<div class="stack-seg" style="width:${((s.value / tot) * 100).toFixed(2)}%;background:${s.color};print-color-adjust:exact" title="${esc(s.label)}"></div>`).join("");
  const leg = segs.map((s) => `<span class="leg"><i style="background:${s.color}"></i>${esc(s.label)} <b>${fInt(s.value)}</b> (${fPct((s.value / tot) * 100)})</span>`).join("");
  return `<div class="stack-bar">${bar}</div><div class="stack-leg">${leg}</div>`;
}

/** Radar (confronto): assi normalizzati 0-100, una serie per scenario. */
function radarSvg(axes: string[], series: Array<{ name: string; color: string; values: number[] }>, S = 320): string {
  const cx = S / 2, cy = S / 2, R = S / 2 - 46, n = axes.length;
  const ang = (i: number) => (-Math.PI / 2) + (i * 2 * Math.PI) / n;
  const pt = (i: number, r: number) => [cx + Math.cos(ang(i)) * r, cy + Math.sin(ang(i)) * r];
  let grid = "";
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    const d = axes.map((_, i) => pt(i, R * ring).map((v) => v.toFixed(1)).join(",")).join(" ");
    grid += `<polygon points="${d}" fill="none" stroke="#e2e8f0" stroke-width="1" />`;
  }
  let spokes = "", labels = "";
  axes.forEach((a, i) => {
    const [x, y] = pt(i, R);
    spokes += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />`;
    const [lx, ly] = pt(i, R + 18);
    const anchor = Math.abs(lx - cx) < 8 ? "middle" : lx > cx ? "start" : "end";
    labels += `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}" class="radar-ax">${esc(a)}</text>`;
  });
  const polys = series.map((s) => {
    const d = s.values.map((v, i) => pt(i, R * (clamp(v) / 100)).map((x) => x.toFixed(1)).join(",")).join(" ");
    return `<polygon points="${d}" fill="${s.color}" fill-opacity="0.16" stroke="${s.color}" stroke-width="2" style="print-color-adjust:exact" />`;
  }).join("");
  return `<svg viewBox="0 0 ${S} ${S}" class="radar">${grid}${spokes}${polys}${labels}</svg>`;
}

/** Proiezione equirettangolare condivisa (route + isocrone). */
function makeProjection(pts: number[][], W: number, H: number, pad: number) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [x, y] of pts) { if (x < minLng) minLng = x; if (x > maxLng) maxLng = x; if (y < minLat) minLat = y; if (y > maxLat) maxLat = y; }
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180) || 1;
  const spanX = (maxLng - minLng) * kx || 1e-6;
  const spanY = (maxLat - minLat) || 1e-6;
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
  return {
    px: (lng: number) => offX + (lng - minLng) * kx * scale,
    py: (lat: number) => H - offY - (lat - minLat) * scale,
  };
}
function ringPath(ring: number[][], px: (n: number) => number, py: (n: number) => number): string {
  if (!ring || ring.length < 3) return "";
  return "M" + ring.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join("L") + "Z";
}
function geomPaths(geom: any, px: (n: number) => number, py: (n: number) => number): string {
  if (!geom) return "";
  if (geom.type === "Polygon") return ringPath(geom.coordinates?.[0] ?? [], px, py);
  if (geom.type === "MultiPolygon") return (geom.coordinates ?? []).map((p: any) => ringPath(p?.[0] ?? [], px, py)).join(" ");
  return "";
}

/** Mappa con isocrone disegnate (fasce a piedi) + percorso + fermate. */
const ISO_COLORS = ["#1d4ed8", "#3b82f6", "#93c5fd", "#bfdbfe"];
function buildIsoMap(layer: MapLayer, isoBands: any[], W = 980, H = 560): string {
  const pts: number[][] = [];
  for (const l of layer.lines) for (const p of l) pts.push(p);
  for (const s of layer.stops) pts.push(s);
  for (const b of isoBands || []) for (const g of (b.geometries || [])) {
    const rings = g?.type === "Polygon" ? [g.coordinates?.[0]] : g?.type === "MultiPolygon" ? (g.coordinates || []).map((p: any) => p?.[0]) : [];
    for (const r of rings) for (const p of (r || [])) pts.push(p);
  }
  if (pts.length < 2) return `<div class="map-empty">Geometria non disponibile.</div>`;
  const { px, py } = makeProjection(pts, W, H, 28);
  let body = "";
  // fasce dalla più esterna (minuti maggiori) alla più interna
  const ordered = [...(isoBands || [])].sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  ordered.forEach((b, idx) => {
    const col = ISO_COLORS[Math.min(ISO_COLORS.length - 1, idx)];
    const d = (b.geometries || []).map((g: any) => geomPaths(g, px, py)).filter(Boolean).join(" ");
    if (d) body += `<path d="${d}" fill="${col}" fill-opacity="0.28" stroke="${col}" stroke-opacity="0.5" stroke-width="1" style="print-color-adjust:exact" />`;
  });
  for (const l of layer.lines) {
    const d = l.map(([x, y]) => `${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(" ");
    body += `<polyline points="${d}" fill="none" stroke="${layer.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" style="print-color-adjust:exact" />`;
  }
  for (const s of layer.stops) body += `<circle cx="${px(s[0]).toFixed(1)}" cy="${py(s[1]).toFixed(1)}" r="3.4" fill="#fff" stroke="${layer.color}" stroke-width="2" style="print-color-adjust:exact" />`;
  return `<svg viewBox="0 0 ${W} ${H}" class="map-svg" preserveAspectRatio="xMidYMid meet"><rect width="${W}" height="${H}" fill="#f8fafc" />${body}</svg>`;
}

/** Diagramma linea stile "mappa metro": fermate come nodi lungo una linea. */
function metroDiagram(stops: any[], color: string): string {
  if (!stops || stops.length < 2) return `<div class="map-empty">Elenco fermate non disponibile.</div>`;
  const W = 980, y = 66, padX = 46;
  const total = stops[stops.length - 1].cumKm || (stops.length - 1);
  const xOf = (s: any, i: number) => padX + (total > 0 ? (s.cumKm / total) : (i / (stops.length - 1))) * (W - 2 * padX);
  const x0 = xOf(stops[0], 0), x1 = xOf(stops[stops.length - 1], stops.length - 1);
  let nodes = "";
  stops.forEach((s, i) => {
    const x = xOf(s, i);
    if (s.poiNear) nodes += `<text x="${x.toFixed(1)}" y="${y - 16}" text-anchor="middle" class="metro-poi">${fInt(s.poiNear)}</text>`;
    nodes += `<circle cx="${x.toFixed(1)}" cy="${y}" r="6" fill="#fff" stroke="${color}" stroke-width="3" style="print-color-adjust:exact" />`;
    nodes += `<text x="${x.toFixed(1)}" y="${y + 20}" transform="rotate(55 ${x.toFixed(1)} ${y + 20})" class="metro-name">${esc(s.name)}</text>`;
    nodes += `<text x="${x.toFixed(1)}" y="${y - 26}" text-anchor="middle" class="metro-km">${fKm(s.cumKm)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} 190" class="metro" preserveAspectRatio="xMidYMid meet">
    <line x1="${x0.toFixed(1)}" y1="${y}" x2="${x1.toFixed(1)}" y2="${y}" stroke="${color}" stroke-width="6" stroke-linecap="round" style="print-color-adjust:exact" />
    ${nodes}
    <text x="${padX}" y="180" class="metro-cap">▲ POI entro il raggio · km progressivi sopra i nodi</text>
  </svg>`;
}

/** Curva di copertura: popolazione (%) entro soglie di distanza. */
function coverageCurveSvg(points: any[]): string {
  if (!points || points.length < 2) return "";
  const W = 620, H = 210, L = 46, B = 30, T = 12, R = 14;
  const iw = W - L - R, ih = H - T - B;
  const n = points.length;
  const x = (i: number) => L + (i / (n - 1)) * iw;
  const y = (pct: number) => T + ih - (clamp(pct) / 100) * ih;
  let grid = "", xlab = "";
  for (const g of [0, 25, 50, 75, 100]) grid += `<line x1="${L}" y1="${y(g).toFixed(1)}" x2="${W - R}" y2="${y(g).toFixed(1)}" stroke="#eef2f7" /><text x="${L - 6}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end" class="ax">${g}%</text>`;
  points.forEach((p, i) => { xlab += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="ax">${p.m}</text>`; });
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
  const area = `M${x(0).toFixed(1)},${y(0).toFixed(1)} L` + line + ` L${x(n - 1).toFixed(1)},${y(0).toFixed(1)} Z`;
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.pct).toFixed(1)}" r="3" fill="#3b82f6" />`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="curve">${grid}
    <path d="${area}" fill="#3b82f6" fill-opacity="0.12" />
    <polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2.5" />${dots}
    <text x="${(L + iw / 2).toFixed(0)}" y="${H}" text-anchor="middle" class="ax">Distanza dalla linea (m)</text></svg>`;
}

/** Curva di copertura con più serie sovrapposte (confronto). */
function coverageCurveMultiSvg(series: Array<{ color: string; points: any[] }>): string {
  const valid = series.filter((s) => s.points && s.points.length > 1);
  if (!valid.length) return "";
  const W = 620, H = 210, L = 46, B = 30, T = 12, R = 14;
  const iw = W - L - R, ih = H - T - B;
  const n = valid[0].points.length;
  const x = (i: number) => L + (i / (n - 1)) * iw;
  const y = (pct: number) => T + ih - (clamp(pct) / 100) * ih;
  let grid = "";
  for (const g of [0, 25, 50, 75, 100]) grid += `<line x1="${L}" y1="${y(g).toFixed(1)}" x2="${W - R}" y2="${y(g).toFixed(1)}" stroke="#eef2f7" /><text x="${L - 6}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end" class="ax">${g}%</text>`;
  let xlab = "";
  valid[0].points.forEach((p: any, i: number) => { xlab += `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="ax">${p.m}</text>`; });
  const lines = valid.map((s) => {
    const pts = s.points.map((p: any, i: number) => `${x(i).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
    const dots = s.points.map((p: any, i: number) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.pct).toFixed(1)}" r="2.6" fill="${s.color}" />`).join("");
    return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2.5" style="print-color-adjust:exact" />${dots}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="curve">${grid}${xlab}${lines}
    <text x="${(L + iw / 2).toFixed(0)}" y="${H}" text-anchor="middle" class="ax">Distanza dalla linea (m)</text></svg>`;
}

/* ─── Score breakdown (replica formula backend 35/30/20/15) ─── */
function scoreBreakdown(a: any): Array<{ label: string; value: number; weight: number; color: string }> {
  const popPct = a?.populationCoverage?.percent ?? 0;
  const poiPct = a?.poiCoverage?.percent ?? 0;
  const sd = a?.stopDistribution;
  const popScore = clamp(popPct * 1.3);
  const poiScore = clamp(poiPct * 1.3);
  let distScore = 60;
  if (sd) distScore = clamp(100 - Math.min(40, (sd.gapsOver1km || 0) * 5) - Math.min(20, ((sd.stopsWithin300m || 0) / ((sd.stopsWithin300m || 0) + (sd.gapsOver1km || 0) + 10)) * 15));
  const effScore = clamp(((a?.efficiencyMetrics?.popPerKm ?? 0) / 500) * 100);
  return [
    { label: "Popolazione", value: popScore, weight: 35, color: "#3b82f6" },
    { label: "POI", value: poiScore, weight: 30, color: "#8b5cf6" },
    { label: "Distribuzione", value: distScore, weight: 20, color: "#0891b2" },
    { label: "Efficienza", value: effScore, weight: 15, color: "#059669" },
  ];
}
function scoreBreakdownHtml(a: any): string {
  return `<div class="bars">${scoreBreakdown(a).map((s) => `<div class="bar-row">
    <div class="bar-lab">${esc(s.label)} <span class="wgt">${s.weight}%</span></div>
    <div class="bar"><div class="bar-fill" style="width:${clamp(s.value).toFixed(1)}%;background:${s.color};print-color-adjust:exact"></div></div>
    <div class="bar-val">${Math.round(s.value)}/100</div></div>`).join("")}</div>`;
}

/* ─── KPI card ─── */
function kpi(num: string, lbl: string, tone: "violet" | "cyan" | "amber" | "emerald"): string {
  return `<div class="ck-card ck-${tone}"><div class="ck-num">${esc(num)}</div><div class="ck-lbl">${esc(lbl)}</div></div>`;
}

/* ─── Sezioni SINGOLA ─── */
function scoreColor(v: number) { return v >= 70 ? "#059669" : v >= 40 ? "#d97706" : "#dc2626"; }

function singleSummary(a: any): string {
  const name = a?.scenario?.name ?? "Linea";
  const km = a?.totalLengthKm ?? 0;
  const stops = a?.stops?.length ?? 0;
  const popPct = a?.populationCoverage?.percent ?? 0;
  const poiPct = a?.poiCoverage?.percent ?? 0;
  const comuni = a?.comuniDetails?.length ?? 0;
  const score = a?.accessibilityScore ?? 0;
  const eff = a?.efficiencyMetrics?.popPerKm ?? 0;
  return `Il percorso <b>${esc(name)}</b> sviluppa <b>${fKm(km)} km</b> con <b>${fInt(stops)} fermate</b>, attraversando
    <b>${fInt(comuni)}</b> comun${comuni === 1 ? "e" : "i"}. Copre circa il <b>${fPct(popPct)}</b> della popolazione di riferimento
    e il <b>${fPct(poiPct)}</b> dei punti di interesse nell'area, servendo in media <b>${fInt(eff)}</b> abitanti per km.
    Il punteggio di accessibilità complessivo è <b>${Math.round(score)}/100</b>.`;
}

/** Sezione isocrone completa: mappa fasce + tabella cumulativa/incrementale + barre. */
function isoSectionHtml(iso: any, layer: MapLayer): string {
  if (!iso || !iso.available) {
    return `<p class="hint">Accessibilità a tempo di percorrenza non disponibile${iso?.reason ? ` (${esc(iso.reason)})` : ""}.
      L'analisi di copertura usa il catchment a raggio. Configura una chiave OpenRouteService o Mapbox per abilitare le isocrone.</p>`;
  }
  const bands = [...(iso.bands ?? [])].sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
  const hasGeom = bands.some((b: any) => (b.geometries || []).length);
  const map = hasGeom ? `<div class="map-wrap">${buildIsoMap(layer, bands)}</div>
    <div class="map-legend">${bands.map((b: any, i: number) => `<span><i style="background:${ISO_COLORS[Math.min(ISO_COLORS.length - 1, bands.length - 1 - i)]}"></i>${b.minutes} min</span>`).join("")}<span><i style="background:${layer.color}"></i>Percorso</span></div>` : "";
  const maxPop = Math.max(1, ...bands.map((b: any) => b.population || 0));
  let prev = 0;
  const rows = bands.map((b: any) => {
    const inc = Math.max(0, (b.population || 0) - prev); prev = b.population || 0;
    return `<tr><td class="left strong">${esc(b.minutes)} min a piedi</td>
      <td class="num">${fInt(b.population)}</td><td class="num">+${fInt(inc)}</td>
      <td class="num">${fInt(b.sections)}</td><td class="num">${fInt(b.poiTotal)}</td></tr>`;
  }).join("");
  return `${map}
    <div class="sub-title">Popolazione raggiungibile a piedi (cumulativa)</div>
    ${barList(bands.map((b: any) => ({ label: `${b.minutes} min`, value: b.population || 0, max: maxPop, sub: fInt(b.population || 0), color: "#2563eb" })))}
    <table class="grid">
      <thead><tr><th class="left">Isocrona</th><th>Popolazione</th><th>In più</th><th>Sezioni</th><th>POI</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="hint">Isocrone a piedi (rete pedonale reale) su ${fInt(iso.pointsWithData ?? iso.sampledPoints ?? 0)} fermate campione${iso.partial ? " · calcolo parziale, rigenera per completare la cache" : ""}.
      "In più" = popolazione aggiuntiva rispetto alla fascia precedente.</p>`;
}

/** Diagramma metro + tabella per fermata. */
function metroSectionHtml(stopsEnriched: any[], color: string): string {
  if (!stopsEnriched || stopsEnriched.length < 2) return `<p class="hint">Dettaglio fermate non disponibile.</p>`;
  const rows = stopsEnriched.map((s: any, i: number) => {
    const cats = Object.entries(s.poiByCat || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 3).map(([k, v]: any) => `${poiLabel(k)} ${v}`).join(", ");
    return `<tr><td class="rank">${i + 1}</td><td class="left strong">${esc(s.name)}</td>
      <td class="num">${fKm(s.cumKm)}</td><td class="left">${esc(s.comune ?? "—")}</td>
      <td class="num">${fInt(s.poiNear || 0)}</td><td class="left small">${esc(cats || "—")}</td></tr>`;
  }).join("");
  return `<div class="map-wrap metro-wrap">${metroDiagram(stopsEnriched, color)}</div>
    <table class="grid slim">
      <thead><tr><th>#</th><th class="left">Fermata</th><th>km</th><th class="left">Comune</th><th>POI vicini</th><th class="left">Principali POI</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
}

/** Curva di copertura + tabella soglie. */
function coverageCurveHtml(curve: any[]): string {
  if (!curve || !curve.length) return "";
  const cells = curve.map((p: any) => `<td class="num">${fPct(p.pct)}</td>`).join("");
  const pops = curve.map((p: any) => `<td class="num">${fInt(p.pop)}</td>`).join("");
  const heads = curve.map((p: any) => `<th>${p.m} m</th>`).join("");
  return `<div style="display:flex;justify-content:center">${coverageCurveSvg(curve)}</div>
    <table class="grid slim"><thead><tr><th class="left">Distanza</th>${heads}</tr></thead>
      <tbody><tr><td class="left strong">Popolazione</td>${pops}</tr><tr><td class="left strong">% sul bacino</td>${cells}</tr></tbody></table>
    <p class="hint">Popolazione (sezioni ISTAT) entro la distanza indicata dalla linea o da una fermata.</p>`;
}

function demandHtml(d: any): string {
  if (!d) return `<p class="hint">Dati di domanda (matrice pendolarismo ISTAT) non disponibili per i comuni serviti. Esegui l'import della matrice pendolarismo per abilitare questa sezione.</p>`;
  const thirdCard = d.hasModeData
    ? kpi(fPct(d.busSharePct || 0), "Quota già su bus", "emerald")
    : kpi(fInt(d.estimatedTplDaily || 0), "Domanda TPL captabile (stima)", "emerald");
  const kpis = `<div class="kpi-row4">
      ${kpi(fInt(d.totalFlow || 0), "Spostamenti sistematici/giorno (comuni serviti)", "violet")}
      ${kpi(fInt(d.intraCorridorFlow || 0), "Interni al corridoio", "cyan")}
      ${thirdCard}
      ${kpi(fInt(d.workFlow || 0) + " / " + fInt(d.studyFlow || 0), "Lavoro / studio", "amber")}
    </div>`;
  let body: string;
  if (d.hasModeData) {
    const segs = [
      { label: "Bus", value: d.busFlow || 0, color: "#059669" },
      { label: "Auto", value: d.carFlow || 0, color: "#dc2626" },
      { label: "Treno", value: d.trainFlow || 0, color: "#0891b2" },
      { label: "Bici/piedi", value: d.activeFlow || 0, color: "#f59e0b" },
      { label: "Altro", value: Math.max(0, (d.totalFlow || 0) - (d.busFlow || 0) - (d.carFlow || 0) - (d.trainFlow || 0) - (d.activeFlow || 0)), color: "#94a3b8" },
    ].filter((s) => s.value > 0);
    body = `<div class="sub-title">Ripartizione modale attuale</div>${stackBar(segs)}
      <p class="hint">Una quota bus bassa a fronte di flussi elevati indica potenziale di spostamento modale.</p>`;
  } else {
    body = `<p class="hint">La matrice del pendolarismo ISTAT (2011) non riporta il <b>modo di trasporto</b>: la ripartizione modale
      non è disponibile. La <b>domanda TPL captabile</b> stima applica una quota indicativa del ${fInt(d.tplSharePct || 10)}% ai
      flussi sistematici interni al corridoio.</p>`;
  }
  return `${kpis}${body}
    <p class="hint">Fonte: matrice del pendolarismo ISTAT sui comuni attraversati (spostamenti casa-lavoro/studio).</p>`;
}

function trafficHtml(t: any): string {
  if (!t || !t.available) return `<p class="hint">Dati di traffico non disponibili per il corridoio${t?.reason ? ` (${esc(t.reason)})` : ""}.</p>`;
  const congTone = t.avgCongestionPct >= 40 ? "amber" : t.avgCongestionPct >= 25 ? "amber" : "emerald";
  return `<div class="kpi-row4">
      ${kpi(fPct(t.avgCongestionPct || 0), "Congestione media", congTone)}
      ${kpi(fInt(t.avgSpeedKmh || 0) + " km/h", "Velocità reale (flusso libero " + fInt(t.avgFreeflowKmh || 0) + ")", "cyan")}
      ${kpi(fPct(t.slowdownPct || 0), "Rallentamento vs libero", "violet")}
      ${kpi(fInt(t.busSpeedUrbanKmh || 0) + "–" + fInt(t.busSpeedExtraKmh || 0) + " km/h", "Velocità commerciale bus stimata", "emerald")}
    </div>
    <div class="sub-title">Tempo di percorrenza stimato e criticità</div>
    <div class="tiles">
      <div class="tile"><div class="tile-n">${fInt(t.runtimeUrbanMin || 0)}′</div><div class="tile-l">Percorrenza (urbano)</div></div>
      <div class="tile"><div class="tile-n">${fInt(t.runtimeExtraMin || 0)}′</div><div class="tile-l">Percorrenza (extraurbano)</div></div>
      <div class="tile"><div class="tile-n">${fInt(t.congestedSegments || 0)}</div><div class="tile-l">Tratti congestionati</div></div>
      <div class="tile"><div class="tile-n">${fPct(t.maxCongestionPct || 0)}</div><div class="tile-l">Congestione di picco</div></div>
    </div>
    <p class="hint">Stima su ${fInt(t.matchedPoints || 0)}/${fInt(t.sampledPoints || 0)} punti del percorso con rilievo TomTom (ultimi 30 giorni).
      Velocità commerciale bus stimata dalla velocità stradale con fattori 0,36 (urbano) / 0,56 (extraurbano).</p>`;
}

/* ─── STYLES ─── */
const STYLES = `
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#7c3aed; --cyan:#0891b2; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:#eef2f7; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .doc { max-width:210mm; margin:0 auto; }
  .page { background:#fff; padding:14mm; margin:8mm auto; box-shadow:0 1px 6px rgba(0,0,0,.12); border-radius:4px; }
  .toolbar { position:sticky; top:0; z-index:10; display:flex; gap:10px; align-items:center; justify-content:center; padding:10px; background:#1e1b4b; color:#fff; }
  .toolbar button { font-size:13px; font-weight:600; padding:8px 16px; border-radius:6px; border:0; cursor:pointer; }
  .btn-print { background:linear-gradient(135deg,#8b5cf6,#06b6d4); color:#fff; } .btn-close { background:#334155; color:#e2e8f0; }
  .toolbar .hint2 { font-size:11px; color:#a5b4fc; }
  .cover-hero { display:flex; align-items:center; gap:6mm; border-bottom:3px solid; border-image:linear-gradient(90deg,var(--accent),var(--cyan)) 1; padding-bottom:8mm; margin-bottom:8mm; }
  .brand-logo { width:120px; height:120px; object-fit:contain; }
  .brand-mark { font-size:11px; font-weight:800; letter-spacing:.24em; text-transform:uppercase; color:#475569; }
  .cover-kicker { text-transform:uppercase; letter-spacing:.14em; font-size:11px; color:var(--accent); font-weight:700; margin-top:4px; }
  .cover-title { font-size:28px; line-height:1.12; margin:6px 0 4px; font-weight:800; }
  .cover-sub { font-size:12.5px; color:var(--muted); }
  .cover-kpis, .kpi-row4 { display:grid; grid-template-columns:repeat(4,1fr); gap:5mm; margin:6mm 0; }
  .ck-card { border-radius:10px; padding:14px 12px; text-align:center; border:1px solid; }
  .ck-violet { background:#f5f3ff; border-color:#ddd6fe; } .ck-violet .ck-num { color:#7c3aed; }
  .ck-cyan { background:#ecfeff; border-color:#a5f3fc; } .ck-cyan .ck-num { color:#0891b2; }
  .ck-amber { background:#fffbeb; border-color:#fde68a; } .ck-amber .ck-num { color:#d97706; }
  .ck-emerald { background:#ecfdf5; border-color:#a7f3d0; } .ck-emerald .ck-num { color:#059669; }
  .ck-num { font-size:20px; font-weight:800; } .ck-lbl { font-size:10px; color:var(--muted); margin-top:4px; line-height:1.25; }
  .meta-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:4mm 12mm; margin:4mm 0; }
  .cm { border-left:3px solid var(--accent); padding-left:10px; } .cm-l { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); } .cm-v { font-size:14px; font-weight:600; }
  .note { font-size:12px; color:#475569; line-height:1.55; background:#f8fafc; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-top:4mm; }
  .sec-title { font-size:18px; font-weight:800; margin:0 0 4mm; padding-bottom:3mm; border-bottom:3px solid; border-image:linear-gradient(90deg,var(--accent),var(--cyan)) 1; }
  .sub-title { font-size:13px; font-weight:700; margin:5mm 0 2mm; color:#334155; }
  .lead { font-size:12.5px; color:#334155; line-height:1.6; margin:0 0 4mm; }
  .hint { font-size:10.5px; color:var(--muted); margin-top:3mm; line-height:1.5; }
  .map-wrap { border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#f8fafc; }
  .map-svg { width:100%; height:auto; display:block; } .map-empty { padding:20mm; text-align:center; color:var(--muted); font-size:12px; }
  .map-legend { display:flex; gap:16px; flex-wrap:wrap; margin-top:2mm; font-size:11px; color:#475569; } .map-legend i { display:inline-block; width:16px; height:4px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  .grid2 { display:grid; grid-template-columns:150px 1fr; gap:6mm; align-items:center; }
  .cols2 { display:grid; grid-template-columns:1fr 1fr; gap:8mm; }
  .donut { width:150px; height:150px; } .donut-num { font-size:24px; font-weight:800; fill:#0f172a; } .donut-lbl { font-size:9px; fill:#64748b; text-transform:uppercase; letter-spacing:.05em; }
  .bars { display:flex; flex-direction:column; gap:5px; }
  .bar-row { display:grid; grid-template-columns:130px 1fr 74px; gap:8px; align-items:center; font-size:11px; }
  .bar-lab { color:#334155; } .bar-lab .wgt { color:var(--muted); font-size:9.5px; }
  .bar { position:relative; height:9px; background:#eef2f7; border-radius:5px; overflow:hidden; }
  .bar-fill { position:absolute; left:0; top:0; bottom:0; background:linear-gradient(90deg,#7c3aed,#a78bfa); border-radius:5px; }
  .bar-val { text-align:right; font-variant-numeric:tabular-nums; color:#475569; font-size:10.5px; }
  .stack-bar { display:flex; height:18px; border-radius:9px; overflow:hidden; margin:2mm 0; box-shadow:inset 0 0 0 1px rgba(0,0,0,.06); }
  .stack-seg { height:100%; } .stack-leg { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:10.5px; color:#475569; } .stack-leg .leg i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:4px; }
  .radar { width:320px; height:320px; } .radar-ax { font-size:9.5px; fill:#475569; font-weight:600; }
  .tiles { display:grid; grid-template-columns:repeat(4,1fr); gap:4mm; }
  .tile { border:1px solid var(--line); border-radius:8px; padding:10px; text-align:center; } .tile-n { font-size:17px; font-weight:800; } .tile-l { font-size:9.5px; color:var(--muted); margin-top:3px; }
  table.grid { width:100%; border-collapse:collapse; font-size:11.5px; margin-top:2mm; }
  table.grid th { background:#f1f5f9; color:#334155; font-weight:700; text-align:right; padding:6px 8px; border-bottom:2px solid #cbd5e1; font-size:10px; text-transform:uppercase; letter-spacing:.03em; }
  table.grid th.left, table.grid td.left { text-align:left; } table.grid td { padding:5px 8px; border-bottom:1px solid var(--line); text-align:right; }
  table.grid td.num { font-variant-numeric:tabular-nums; } table.grid td.strong { font-weight:700; }
  table.grid.slim th { padding:4px 6px; font-size:9px; } table.grid.slim td { padding:3px 6px; font-size:10px; }
  table.grid td.rank { text-align:center; color:var(--muted); font-weight:700; } table.grid td.small { font-size:9.5px; color:#475569; }
  .metro { width:100%; height:auto; display:block; } .metro-wrap { padding:4mm 2mm 2mm; }
  .metro-name { font-size:9px; fill:#334155; text-anchor:start; } .metro-poi { font-size:9px; fill:#7c3aed; font-weight:800; } .metro-km { font-size:8px; fill:#94a3b8; } .metro-cap { font-size:8.5px; fill:#94a3b8; }
  .curve { width:620px; max-width:100%; height:auto; } .ax { font-size:9px; fill:#94a3b8; }
  .win { background:#ecfdf5; } .win-badge { color:#059669; font-weight:800; }
  .sug { font-size:12px; line-height:1.55; padding:7px 12px; border-left:3px solid var(--accent); background:#f8fafc; border-radius:0 6px 6px 0; margin-bottom:5px; }
  .sug.warn { border-color:#d97706; background:#fffbeb; } .sug.ind { border-color:#cbd5e1; margin-left:14px; font-size:11px; color:#475569; }
  .badge-score { display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:800; padding:4px 12px; border-radius:99px; color:#fff; }
  @media print { html,body { background:#fff; } .toolbar { display:none !important; } .page { box-shadow:none; margin:0; border-radius:0; page-break-after:always; } }
  @page { size:A4 portrait; margin:0; }
`;

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${esc(title)}</title><style>${STYLES}</style></head>
<body>
  <div class="toolbar">
    <button class="btn-print" onclick="window.print()">🖨️ Stampa / Salva PDF</button>
    <button class="btn-close" onclick="window.close()">Chiudi</button>
    <span class="hint2">Scegli «Salva come PDF», A4, con sfondi attivi.</span>
  </div>
  <div class="doc">${bodyHtml}</div>
</body></html>`;
}

/** Apre una finestra vuota SUBITO (nel gesto utente) per evitare il popup-block. */
export function openReportWindow(): Window | null {
  const win = window.open("", "_blank");
  if (win) win.document.write(`<p style="font-family:sans-serif;padding:24px;color:#475569">Generazione report…</p>`);
  else alert("Il browser ha bloccato la finestra. Consenti i popup per questo sito e riprova.");
  return win;
}

/* ═══════════════ REPORT SINGOLA LINEA ═══════════════ */
export async function exportScenarioReport(win: Window | null, analysis: any, geojson: any, opts: { agencyName?: string; radius?: number } = {}): Promise<void> {
  if (!win) return;
  const logo = await fetchLogoDataUri();
  const a = analysis;
  const color = safeColor(a?.scenario?.color);
  const name = a?.scenario?.name ?? "Linea";
  const genDate = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
  const agency = opts.agencyName ?? "Conerobus · Trasporto Pubblico Locale";
  const radius = opts.radius ?? a?.poiCoverage?.radius ?? 0.5;

  const comuni = a?.comuniDetails ?? [];
  const maxPop = Math.max(1, ...comuni.map((c: any) => c.totalPop || 0));
  const poiCat = a?.poiCoverage?.byCategory ?? {};
  const sd = a?.stopDistribution;
  const gap = a?.gapAnalysis ?? {};
  const score = a?.accessibilityScore ?? 0;

  const map = buildMapSvg([layerFromGeojson(geojson, color)]);

  const cover = `<section class="page">
    <div class="cover-hero">
      ${logo ? `<img class="brand-logo" src="${logo}" alt="" />` : ""}
      <div><div class="brand-mark">Network Engine · Analisi di Rete</div>
        <div class="cover-kicker">Report analisi linea</div>
        <div class="cover-title">${esc(name)}</div>
        <div class="cover-sub">${esc(agency)}</div></div>
    </div>
    <div class="cover-kpis">
      ${kpi(fKm(a?.totalLengthKm ?? 0) + " km", "Lunghezza percorso", "violet")}
      ${kpi(fInt(a?.stops?.length ?? 0), "Fermate", "cyan")}
      ${kpi(Math.round(score) + "/100", "Accessibilità", "emerald")}
      ${kpi(fPct(a?.populationCoverage?.percent ?? 0), "Popolazione coperta", "amber")}
    </div>
    <div class="meta-row">
      <div class="cm"><div class="cm-l">Data</div><div class="cm-v">${esc(genDate)}</div></div>
      <div class="cm"><div class="cm-l">Raggio catchment</div><div class="cm-v">${fInt(radius * 1000)} m</div></div>
      <div class="cm"><div class="cm-l">Comuni serviti</div><div class="cm-v">${fInt(comuni.length)}</div></div>
    </div>
    <div class="sub-title">Mappa del percorso</div>
    <div class="map-wrap">${map}</div>
    <div class="map-legend"><span><i style="background:${color}"></i>Percorso</span><span>○ Fermate</span></div>
    <p class="note">${singleSummary(a)}</p>
  </section>`;

  const layer = layerFromGeojson(geojson, color);
  const stopsEnriched = a?.stopsEnriched ?? [];
  const curve = a?.coverageCurve ?? [];

  const metroSec = `<section class="page">
    <h2 class="sec-title">Diagramma di linea e fermate</h2>
    <p class="lead">Schema della linea con le <b>${fInt(stopsEnriched.length || a?.stops?.length || 0)} fermate</b> in sequenza (km progressivi) e i punti di interesse serviti da ciascuna.</p>
    ${metroSectionHtml(stopsEnriched, color)}
  </section>`;

  const isoSec = `<section class="page">
    <h2 class="sec-title">Accessibilità a piedi (isocrone)</h2>
    <p class="lead">Aree raggiungibili a piedi dalle fermate entro 5, 10 e 15 minuti (rete pedonale reale) e popolazione che vi risiede.</p>
    ${isoSectionHtml(a?.accessibilityIso, layer)}
  </section>`;

  const scoreSec = `<section class="page">
    <h2 class="sec-title">Accessibilità e composizione del punteggio</h2>
    <p class="lead">Il punteggio (0–100) combina copertura di popolazione (35%), POI (30%), qualità della distribuzione delle
      fermate (20%) ed efficienza (15%).</p>
    <div style="margin-bottom:5mm"><span class="badge-score" style="background:${scoreColor(score)};print-color-adjust:exact">${Math.round(score)}/100</span></div>
    ${scoreBreakdownHtml(a)}
    <div class="sub-title">Indicatori di efficienza</div>
    <div class="tiles">
      <div class="tile"><div class="tile-n">${fInt(a?.efficiencyMetrics?.popPerKm ?? 0)}</div><div class="tile-l">Abitanti serviti/km</div></div>
      <div class="tile"><div class="tile-n">${(a?.efficiencyMetrics?.poiPerKm ?? 0)}</div><div class="tile-l">POI/km</div></div>
      <div class="tile"><div class="tile-n">${(a?.efficiencyMetrics?.stopsPerKm ?? 0)}</div><div class="tile-l">Fermate/km</div></div>
      <div class="tile"><div class="tile-n">${(a?.efficiencyMetrics?.costIndex ?? 0)}</div><div class="tile-l">% pop / 10 km</div></div>
    </div>
  </section>`;

  const coverageSec = `<section class="page">
    <h2 class="sec-title">Copertura della popolazione</h2>
    <div class="grid2">
      ${donut(a?.populationCoverage?.percent ?? 0, "Popolazione", "#3b82f6")}
      <div>
        <div class="lead" style="margin:0 0 3mm">Su una base di <b>${fInt(a?.populationCoverage?.totalPop ?? 0)}</b> abitanti nei ${fInt(comuni.length)} comuni serviti,
          il percorso ne raggiunge circa <b>${fInt(a?.populationCoverage?.coveredPop ?? 0)}</b> entro ${fInt(radius * 1000)} m.</div>
        <div class="kpi-row4" style="grid-template-columns:1fr 1fr">
          ${kpi(fInt(a?.populationCoverage?.coveredPop ?? 0), "Abitanti coperti", "cyan")}
          ${kpi(fInt(a?.poiCoverage?.covered ?? 0) + "/" + fInt(a?.poiCoverage?.total ?? 0), "POI coperti", "violet")}
        </div>
      </div>
    </div>
    ${curve.length ? `<div class="sub-title">Curva di copertura (popolazione entro distanza)</div>${coverageCurveHtml(curve)}` : ""}
  </section>`;

  const comuniSec = `<section class="page">
    <h2 class="sec-title">Dettaglio per comune e per categoria POI</h2>
    <div class="sub-title">Popolazione e copertura per comune</div>
    <table class="grid slim"><thead><tr><th class="left">Comune</th><th>Popolazione</th><th>Coperta</th><th>%</th><th>Sezioni</th><th>POI</th></tr></thead>
      <tbody>${comuni.map((c: any) => `<tr><td class="left strong">${esc(c.name)}</td><td class="num">${fInt(c.totalPop || 0)}</td><td class="num">${fInt(c.coveredPop || 0)}</td><td class="num">${fPct(c.percent || 0)}</td><td class="num">${fInt(c.coveredSections || 0)}/${fInt(c.totalSections || 0)}</td><td class="num">${fInt(c.poiCovered || 0)}/${fInt(c.poiTotal || 0)}</td></tr>`).join("")}</tbody></table>
    <div class="sub-title">Copertura POI per categoria</div>
    ${barList(Object.entries(poiCat).map(([k, v]: any) => ({ label: poiLabel(k), value: v.covered || 0, max: Math.max(1, v.total || 0), sub: `${v.covered}/${v.total}`, color: "#8b5cf6" })).sort((x, y) => (y.value / (y.max || 1)) - (x.value / (x.max || 1))))}
  </section>`;

  const stopsSec = `<section class="page">
    <h2 class="sec-title">Distribuzione delle fermate</h2>
    ${sd ? `<div class="tiles">
      <div class="tile"><div class="tile-n">${fInt((sd.avgInterStopKm || 0) * 1000)} m</div><div class="tile-l">Interdistanza media</div></div>
      <div class="tile"><div class="tile-n">${fInt((sd.medianInterStopKm || 0) * 1000)} m</div><div class="tile-l">Mediana</div></div>
      <div class="tile"><div class="tile-n">${fInt(sd.gapsOver1km || 0)}</div><div class="tile-l">Tratti &gt; 1 km senza fermate</div></div>
      <div class="tile"><div class="tile-n">${fInt(sd.stopsWithin300m || 0)}</div><div class="tile-l">Coppie troppo vicine</div></div>
    </div>` : `<p class="hint">Dati di spaziatura non disponibili (poche fermate).</p>`}
    <div class="sub-title">Criticità di copertura</div>
    ${(gap.underservedComuni?.length ? `<div class="lead" style="margin:0 0 2mm">Comuni sotto-serviti (&lt; 30%):</div>${barList(gap.underservedComuni.map((c: any) => ({ label: c.name, value: c.coveragePercent || 0, max: 100, sub: fPct(c.coveragePercent || 0), color: "#dc2626" })))}` : `<p class="hint">Nessun comune sotto-servito rilevato.</p>`)}
    ${(gap.uncoveredPoi?.length ? `<div class="sub-title">POI critici non coperti (più vicini)</div>
      <table class="grid"><thead><tr><th class="left">Categoria</th><th class="left">Nome</th><th>Distanza</th></tr></thead>
      <tbody>${gap.uncoveredPoi.slice(0, 10).map((p: any) => `<tr><td class="left">${esc(poiLabel(p.category))}</td><td class="left">${esc(p.name || "—")}</td><td class="num">${fInt((p.distKm || 0) * 1000)} m</td></tr>`).join("")}</tbody></table>` : "")}
  </section>`;

  const trafficSec = `<section class="page">
    <h2 class="sec-title">Traffico sul corridoio</h2>
    <p class="lead">Impatto del traffico stradale reale (rilievi TomTom) lungo il percorso: congestione, velocità e stima
      della velocità commerciale del bus.</p>
    ${trafficHtml(a?.corridorTraffic)}
  </section>`;

  const demandSec = `<section class="page">
    <h2 class="sec-title">Domanda di mobilità sul corridoio</h2>
    ${demandHtml(a?.demand)}
  </section>`;

  const body = cover + metroSec + isoSec + coverageSec + comuniSec + scoreSec + stopsSec + trafficSec + demandSec;
  win.document.open();
  win.document.write(shell(`Report linea · ${name}`, body));
  win.document.close();
}

/* ═══════════════ REPORT CONFRONTO ═══════════════ */
export async function exportComparisonReport(
  win: Window | null,
  compare: any,
  scenarios: Array<{ name: string; color: string; geojson: any; deep?: any }>,
  opts: { agencyName?: string } = {},
): Promise<void> {
  if (!win) return;
  const logo = await fetchLogoDataUri();
  const genDate = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
  const agency = opts.agencyName ?? "Conerobus · Trasporto Pubblico Locale";
  const sc = compare?.scenarios ?? [];
  const A = sc[0], B = sc[1];
  const cA = safeColor(A?.color, "#3b82f6"), cB = safeColor(B?.color, "#8b5cf6");
  const better = (A?.accessibilityScore ?? 0) >= (B?.accessibilityScore ?? 0) ? A : B;

  const map = buildMapSvg(scenarios.map((s, i) => layerFromGeojson(s.geojson, safeColor(s.color, i === 0 ? "#3b82f6" : "#8b5cf6"))));

  const radar = radarSvg(
    ["POI %", "Pop. %", "Access.", "Efficienza", "Fermate", "Comuni"],
    [A, B].filter(Boolean).map((s: any, i: number) => ({
      name: s.name, color: i === 0 ? cA : cB,
      values: [
        s.poiCoverage?.percent ?? 0,
        s.populationCoverage?.percent ?? 0,
        s.accessibilityScore ?? 0,
        clamp((s.efficiency?.popPerKm ?? 0) / 5),
        clamp((s.stopsCount ?? 0) / Math.max(1, Math.max(A?.stopsCount ?? 0, B?.stopsCount ?? 0)) * 100),
        clamp((s.comuniDetails?.length ?? 0) / Math.max(1, Math.max(A?.comuniDetails?.length ?? 0, B?.comuniDetails?.length ?? 0)) * 100),
      ],
    })),
  );

  const metricRow = (label: string, va: string, vb: string, aWin: boolean) =>
    `<tr><td class="left strong">${esc(label)}</td><td class="num ${aWin ? "win" : ""}">${esc(va)}${aWin ? ' <span class="win-badge">✓</span>' : ""}</td><td class="num ${!aWin ? "win" : ""}">${esc(vb)}${!aWin ? ' <span class="win-badge">✓</span>' : ""}</td></tr>`;

  const cmpTable = A && B ? `<table class="grid">
    <thead><tr><th class="left">Metrica</th><th>${esc(A.name)}</th><th>${esc(B.name)}</th></tr></thead>
    <tbody>
      ${metricRow("Accessibilità /100", String(Math.round(A.accessibilityScore || 0)), String(Math.round(B.accessibilityScore || 0)), (A.accessibilityScore || 0) >= (B.accessibilityScore || 0))}
      ${metricRow("Lunghezza (km)", fKm(A.totalLengthKm || 0), fKm(B.totalLengthKm || 0), (A.totalLengthKm || 0) <= (B.totalLengthKm || 0))}
      ${metricRow("Fermate", fInt(A.stopsCount || 0), fInt(B.stopsCount || 0), (A.stopsCount || 0) >= (B.stopsCount || 0))}
      ${metricRow("Popolazione coperta", fPct(A.populationCoverage?.percent || 0), fPct(B.populationCoverage?.percent || 0), (A.populationCoverage?.percent || 0) >= (B.populationCoverage?.percent || 0))}
      ${metricRow("POI coperti", fPct(A.poiCoverage?.percent || 0), fPct(B.poiCoverage?.percent || 0), (A.poiCoverage?.percent || 0) >= (B.poiCoverage?.percent || 0))}
      ${metricRow("Abitanti/km", fInt(A.efficiency?.popPerKm || 0), fInt(B.efficiency?.popPerKm || 0), (A.efficiency?.popPerKm || 0) >= (B.efficiency?.popPerKm || 0))}
    </tbody></table>` : `<p class="hint">Servono due scenari per il confronto.</p>`;

  const suggestions = (compare?.suggestions ?? []).map((s: string) => {
    const warn = s.startsWith("⚠️") || s.startsWith("🚨");
    const ind = s.startsWith("  →") || s.startsWith("→");
    return `<div class="sug ${warn ? "warn" : ""} ${ind ? "ind" : ""}">${esc(s)}</div>`;
  }).join("");

  // Domanda a confronto (se deep passato)
  const demandCmp = scenarios.some((s) => s.deep?.demand) ? `<section class="page">
    <h2 class="sec-title">Domanda di mobilità a confronto</h2>
    <div class="cols2">
      ${scenarios.slice(0, 2).map((s, i) => `<div>
        <div class="sub-title" style="color:${i === 0 ? cA : cB}">${esc(s.name)}</div>
        ${demandHtml(s.deep?.demand)}
      </div>`).join("")}
    </div>
  </section>` : "";

  const cover = `<section class="page">
    <div class="cover-hero">
      ${logo ? `<img class="brand-logo" src="${logo}" alt="" />` : ""}
      <div><div class="brand-mark">Network Engine · Analisi di Rete</div>
        <div class="cover-kicker">Report confronto percorsi</div>
        <div class="cover-title">${esc(A?.name ?? "A")} <span style="color:#94a3b8">vs</span> ${esc(B?.name ?? "B")}</div>
        <div class="cover-sub">${esc(agency)} · ${esc(genDate)}</div></div>
    </div>
    <div class="map-wrap">${map}</div>
    <div class="map-legend">
      <span><i style="background:${cA}"></i>${esc(A?.name ?? "A")}</span>
      <span><i style="background:${cB}"></i>${esc(B?.name ?? "B")}</span></div>
    ${better ? `<p class="note">In base al punteggio complessivo di accessibilità, il percorso più performante è
      <b>${esc(better.name)}</b> (${Math.round(better.accessibilityScore || 0)}/100). Il confronto dettagliato segue nelle pagine successive.</p>` : ""}
  </section>`;

  const cmpSec = `<section class="page">
    <h2 class="sec-title">Confronto metriche</h2>
    ${cmpTable}
    <div class="sub-title">Profilo comparato</div>
    <div style="display:flex; justify-content:center">${radar}</div>
    <div class="map-legend" style="justify-content:center">
      <span><i style="background:${cA}"></i>${esc(A?.name ?? "A")}</span>
      <span><i style="background:${cB}"></i>${esc(B?.name ?? "B")}</span></div>
  </section>`;

  const sugSec = suggestions ? `<section class="page">
    <h2 class="sec-title">Analisi e raccomandazioni</h2>
    ${suggestions}
  </section>` : "";

  // Dati ricchi per scenario (dal /deep passato dal frontend)
  const dA = scenarios[0]?.deep, dB = scenarios[1]?.deep;
  const layers = scenarios.slice(0, 2).map((s, i) => layerFromGeojson(s.geojson, safeColor(s.color, i === 0 ? cA : cB)));

  // Diagrammi di linea (metro) a confronto
  const metroCmp = (dA?.stopsEnriched?.length || dB?.stopsEnriched?.length) ? `<section class="page">
    <h2 class="sec-title">Diagrammi di linea a confronto</h2>
    ${scenarios.slice(0, 2).map((s, i) => `<div class="sub-title" style="color:${i === 0 ? cA : cB}">${esc(s.name)} · ${fInt(s.deep?.stopsEnriched?.length || 0)} fermate</div>
      <div class="map-wrap metro-wrap">${metroDiagram(s.deep?.stopsEnriched || [], i === 0 ? cA : cB)}</div>`).join("")}
  </section>` : "";

  // Isocrone a confronto: mappe affiancate + tabella pop per banda
  const isoA = dA?.accessibilityIso, isoB = dB?.accessibilityIso;
  const isoAvail = isoA?.available || isoB?.available;
  const minutesSet = Array.from(new Set([...(isoA?.bands || []), ...(isoB?.bands || [])].map((b: any) => b.minutes))).sort((a: number, b: number) => a - b);
  const popAt = (iso: any, m: number) => (iso?.bands || []).find((b: any) => b.minutes === m)?.population ?? null;
  const isoCmp = isoAvail ? `<section class="page">
    <h2 class="sec-title">Accessibilità a piedi a confronto</h2>
    <div class="cols2">
      ${scenarios.slice(0, 2).map((s, i) => {
        const iso = s.deep?.accessibilityIso;
        return `<div><div class="sub-title" style="color:${i === 0 ? cA : cB}">${esc(s.name)}</div>
          ${iso?.available && (iso.bands || []).some((b: any) => (b.geometries || []).length)
            ? `<div class="map-wrap">${buildIsoMap(layers[i], [...(iso.bands || [])].sort((x: any, y: any) => x.minutes - y.minutes))}</div>`
            : `<p class="hint">Isocrone non disponibili.</p>`}</div>`;
      }).join("")}
    </div>
    <div class="sub-title">Popolazione raggiungibile a piedi</div>
    <table class="grid"><thead><tr><th class="left">Isocrona</th><th>${esc(A?.name ?? "A")}</th><th>${esc(B?.name ?? "B")}</th><th>Δ</th></tr></thead>
      <tbody>${minutesSet.map((m: number) => { const pa = popAt(isoA, m), pb = popAt(isoB, m); return `<tr><td class="left strong">${m} min a piedi</td><td class="num">${pa != null ? fInt(pa) : "—"}</td><td class="num">${pb != null ? fInt(pb) : "—"}</td><td class="num">${pa != null && pb != null ? (pa - pb >= 0 ? "+" : "") + fInt(pa - pb) : "—"}</td></tr>`; }).join("")}</tbody></table>
  </section>` : "";

  // Copertura popolazione: curve sovrapposte
  const coverageCmp = (dA?.coverageCurve?.length || dB?.coverageCurve?.length) ? `<section class="page">
    <h2 class="sec-title">Curva di copertura a confronto</h2>
    <p class="lead">Popolazione (%) raggiunta al crescere della distanza dalla linea, per i due percorsi.</p>
    <div style="display:flex;justify-content:center">${coverageCurveMultiSvg([
      { color: cA, points: dA?.coverageCurve || [] }, { color: cB, points: dB?.coverageCurve || [] },
    ])}</div>
    <div class="map-legend" style="justify-content:center">
      <span><i style="background:${cA}"></i>${esc(A?.name ?? "A")}</span>
      <span><i style="background:${cB}"></i>${esc(B?.name ?? "B")}</span></div>
  </section>` : "";

  // Traffico a confronto
  const trafficCmp = (dA?.corridorTraffic || dB?.corridorTraffic) ? `<section class="page">
    <h2 class="sec-title">Traffico sul corridoio a confronto</h2>
    <div class="cols2">
      ${scenarios.slice(0, 2).map((s, i) => `<div><div class="sub-title" style="color:${i === 0 ? cA : cB}">${esc(s.name)}</div>${trafficHtml(s.deep?.corridorTraffic)}</div>`).join("")}
    </div>
  </section>` : "";

  const body = cover + cmpSec + metroCmp + isoCmp + coverageCmp + trafficCmp + demandCmp + sugSec;
  win.document.open();
  win.document.write(shell(`Confronto · ${A?.name ?? ""} vs ${B?.name ?? ""}`, body));
  win.document.close();
}
