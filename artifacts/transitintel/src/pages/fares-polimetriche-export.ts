/**
 * FaresPolimetricheExport — esporta le polimetriche tariffarie in formato
 * "una linea per foglio A4 verticale", stile classico italiano (DGR Marche /
 * concessioni TPL): per ogni linea (route) viene generata una pagina con
 * intestazione, elenco fermate ordinate per percorrenza progressiva,
 * polimetrica triangolare tra zone tariffarie e legenda fasce.
 *
 * Pagina tipica:
 *
 *  ┌──────────────────────────────────────────────────────────┐
 *  │  TARIFFARIO TPL · Conerobus · 10/2025                    │
 *  │  Linea 100 — Ancona Stazione ↔ Senigallia                │
 *  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
 *  │  │ 28.4 km  │ │ 42 ferm. │ │  6 zone  │ │ 8 fasce  │     │
 *  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
 *  ├──────────────────────────────────────────────────────────┤
 *  │  ELENCO FERMATE                                          │
 *  │  1. Ancona Stazione FS    km   0.00   Z1                 │
 *  │  2. Ancona P.zza Cavour   km   1.20   Z1                 │
 *  │  3. Falconara …           km   8.40   Z2                 │
 *  │  …                                                       │
 *  ├──────────────────────────────────────────────────────────┤
 *  │  POLIMETRICA TARIFFARIA (€)                              │
 *  │           Z1   Z2   Z3   Z4   Z5   Z6                    │
 *  │      Z1  1.30 1.30 1.50 1.80 2.20 2.60                   │
 *  │      Z2   ─   1.30 1.30 1.50 1.80 2.20                   │
 *  │      Z3   ─    ─   1.30 1.30 1.50 1.80                   │
 *  │      …                                                   │
 *  └──────────────────────────────────────────────────────────┘
 *
 * I dati vengono recuperati combinando:
 *  • i CSV generati (areas.txt, stop_areas.txt, fare_products.txt,
 *    fare_leg_rules.txt) → matrice prezzi per zona × zona
 *  • API `/api/fares/route-networks` → elenco linee con assegnazione network
 *  • API `/api/fares/route-stops/:routeId` → fermate ordinate con km
 */

import { apiFetch } from "@/lib/api";

/* ──────────────────────────────────────────────────────────
 * Tipi
 * ──────────────────────────────────────────────────────── */

export interface PolimetricheInput {
  /** mappa filename → contenuto CSV (esattamente result.files di GenerateTab) */
  files: Record<string, string>;
  /** metodo di zonizzazione scelto (per il sottotitolo) */
  zoningMethod?: "shape" | "direct" | "dominant" | "cluster";
  /** data servizio o data corrente (it-IT) */
  date?: string;
  /** nome agenzia / titolo personalizzato */
  agencyName?: string;
}

interface AreaRow { area_id: string; area_name: string; }
interface StopAreaRow { area_id: string; stop_id: string; }
interface FareProductRow {
  fare_product_id: string;
  fare_product_name: string;
  amount: string;
  currency: string;
}
interface FareLegRuleRow {
  leg_group_id?: string;
  network_id: string;
  from_area_id: string;
  to_area_id: string;
  fare_product_id: string;
}
interface RouteNetworkRow {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  routeColor: string | null;
  networkId: string | null;
  defaultNetworkId: string | null;
}
interface RouteStop {
  stopId: string;
  stopName: string;
  progressiveKm: number;
  currentAreaId: string | null;
  currentAreaName: string | null;
  suggestedAreaId: string | null;
  suggestedFascia: string | null;
}

/* ──────────────────────────────────────────────────────────
 * Helpers di parsing CSV minimale
 * ──────────────────────────────────────────────────────── */

function parseCsv(text: string | undefined): Record<string, string>[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h.trim()] = (cells[i] ?? "").trim(); });
    return obj;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === "," && !inQuote) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const escape = (s: string | undefined | null): string =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));

const fmtMoney = (n: number): string => isFinite(n) ? n.toFixed(2) : "—";

/* ──────────────────────────────────────────────────────────
 * Costruzione modello prezzi (rete → matrice zona×zona)
 * ──────────────────────────────────────────────────────── */

interface PriceModel {
  /** mappa areaId → nome leggibile (con codice corto Z1, Z2, …) */
  areas: Map<string, { id: string; name: string; code: string }>;
  /** prodotti tariffari */
  products: Map<string, { id: string; name: string; amount: number; currency: string }>;
  /** prodotto "ordinario" (biglietto base) per ogni network */
  ordinaryProductByNetwork: Map<string, string>;
  /** mappa stopId → areaId */
  stopToArea: Map<string, string>;
  /** matrice prezzi:  network|fromArea|toArea → amount (prodotto ordinario) */
  prices: Map<string, number>;
  /** range prezzi globale */
  minPrice: number;
  maxPrice: number;
}

function buildPriceModel(files: Record<string, string>): PriceModel {
  const areasRows = parseCsv(files["areas.txt"]) as unknown as AreaRow[];
  const stopAreasRows = parseCsv(files["stop_areas.txt"]) as unknown as StopAreaRow[];
  const productsRows = parseCsv(files["fare_products.txt"]) as unknown as FareProductRow[];
  const legRulesRows = parseCsv(files["fare_leg_rules.txt"]) as unknown as FareLegRuleRow[];

  // Aree con codice corto Z1, Z2…
  const areas = new Map<string, { id: string; name: string; code: string }>();
  areasRows.forEach((a, i) => {
    areas.set(a.area_id, { id: a.area_id, name: a.area_name || a.area_id, code: `Z${i + 1}` });
  });

  // Prodotti
  const products = new Map<string, { id: string; name: string; amount: number; currency: string }>();
  productsRows.forEach(p => {
    products.set(p.fare_product_id, {
      id: p.fare_product_id,
      name: p.fare_product_name || p.fare_product_id,
      amount: parseFloat(p.amount) || 0,
      currency: p.currency || "EUR",
    });
  });

  // Stop → area
  const stopToArea = new Map<string, string>();
  stopAreasRows.forEach(sa => stopToArea.set(sa.stop_id, sa.area_id));

  // Per ogni network, scegli il prodotto "ordinario" come quello più frequente nelle leg rules
  // (fallback: il prodotto con id contenente "ordinario" o "B" o quello con prezzo minimo)
  const productCountByNetwork = new Map<string, Map<string, number>>();
  legRulesRows.forEach(r => {
    if (!productCountByNetwork.has(r.network_id)) productCountByNetwork.set(r.network_id, new Map());
    const m = productCountByNetwork.get(r.network_id)!;
    m.set(r.fare_product_id, (m.get(r.fare_product_id) || 0) + 1);
  });
  const ordinaryProductByNetwork = new Map<string, string>();
  for (const [net, counts] of productCountByNetwork) {
    // priorità: id che contiene "ordinario" o "_B_" o termina con "_B"
    let chosen: string | null = null;
    for (const pid of counts.keys()) {
      if (/ordinario|biglietto/i.test(products.get(pid)?.name || "") || /(_B$|_B_)/i.test(pid)) {
        chosen = pid; break;
      }
    }
    if (!chosen) {
      // fallback: il più frequente
      chosen = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    ordinaryProductByNetwork.set(net, chosen);
  }

  // Matrice prezzi (solo per il prodotto ordinario di ciascuna rete)
  const prices = new Map<string, number>();
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  legRulesRows.forEach(r => {
    if (ordinaryProductByNetwork.get(r.network_id) !== r.fare_product_id) return;
    const p = products.get(r.fare_product_id);
    if (!p) return;
    const key = `${r.network_id}|${r.from_area_id}|${r.to_area_id}`;
    prices.set(key, p.amount);
    if (p.amount < minPrice) minPrice = p.amount;
    if (p.amount > maxPrice) maxPrice = p.amount;
  });
  if (!isFinite(minPrice)) { minPrice = 0; maxPrice = 0; }

  return { areas, products, ordinaryProductByNetwork, stopToArea, prices, minPrice, maxPrice };
}

/* ──────────────────────────────────────────────────────────
 * Estrazione dati per linea
 * ──────────────────────────────────────────────────────── */

interface RouteSheet {
  routeId: string;
  shortName: string;
  longName: string;
  routeColor: string | null;
  networkId: string | null;
  capolineaA: string;
  capolineaB: string;
  totalKm: number;
  stops: RouteStop[];
  /** aree coinvolte da questa linea, nell'ordine di prima comparsa lungo il percorso */
  routeAreas: { id: string; code: string; name: string; firstKm: number }[];
}

async function fetchRouteSheet(route: RouteNetworkRow, model: PriceModel): Promise<RouteSheet | null> {
  let stops: RouteStop[];
  try {
    stops = await apiFetch<RouteStop[]>(`/api/fares/route-stops/${encodeURIComponent(route.routeId)}`);
  } catch {
    return null;
  }
  if (!stops || stops.length === 0) return null;
  stops = [...stops].sort((a, b) => a.progressiveKm - b.progressiveKm);

  // Aree coinvolte: prendi `currentAreaId` (se presente) altrimenti `suggestedAreaId`,
  // altrimenti dal mapping CSV stop_areas (model.stopToArea)
  const areaSeen = new Map<string, { firstKm: number }>();
  for (const s of stops) {
    const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId) || null;
    if (aid && !areaSeen.has(aid)) areaSeen.set(aid, { firstKm: s.progressiveKm });
  }
  const routeAreas = [...areaSeen.entries()]
    .map(([id, { firstKm }]) => {
      const meta = model.areas.get(id);
      return {
        id,
        code: meta?.code ?? id,
        name: meta?.name ?? id,
        firstKm,
      };
    })
    .sort((a, b) => a.firstKm - b.firstKm);

  const totalKm = stops[stops.length - 1]?.progressiveKm ?? 0;
  const shortName = (route.shortName || route.routeId).trim();
  const longName = (route.longName || "").trim();
  const capolineaA = stops[0]?.stopName ?? "—";
  const capolineaB = stops[stops.length - 1]?.stopName ?? "—";

  return {
    routeId: route.routeId,
    shortName,
    longName,
    routeColor: route.routeColor,
    networkId: route.networkId || route.defaultNetworkId || null,
    capolineaA,
    capolineaB,
    totalKm,
    stops,
    routeAreas,
  };
}

/* ──────────────────────────────────────────────────────────
 * Rendering HTML
 * ──────────────────────────────────────────────────────── */

const NETWORK_LABEL: Record<string, string> = {
  urbano_ancona: "Urbano Ancona",
  urbano_jesi: "Urbano Jesi",
  urbano_senigallia: "Urbano Senigallia",
  urbano_fabriano: "Urbano Fabriano",
  urbano_osimo: "Urbano Osimo",
  urbano_castelfidardo: "Urbano Castelfidardo",
  urbano_sassoferrato: "Urbano Sassoferrato",
  extraurbano: "Extraurbano",
};

const ZONING_LABEL: Record<string, string> = {
  shape: "Proiezione su Shape",
  direct: "Distanza diretta",
  dominant: "Percorso dominante",
  cluster: "Cluster geografici",
};

function renderCoverPage(opts: {
  agencyName: string;
  date: string;
  zoningMethod?: string;
  routeCount: number;
  productCount: number;
  areaCount: number;
  minPrice: number;
  maxPrice: number;
}): string {
  return `
    <section class="page cover">
      <div class="cover-top">
        <div class="brand">${escape(opts.agencyName)}</div>
        <div class="cover-date">${escape(opts.date)}</div>
      </div>
      <div class="cover-center">
        <div class="cover-eyebrow">Tariffario TPL · Documento ufficiale</div>
        <h1 class="cover-title">Polimetriche tariffarie</h1>
        <div class="cover-subtitle">Matrice tariffaria origine→destinazione per linea</div>
      </div>
      <div class="cover-stats">
        <div class="kpi"><div class="kpi-num">${opts.routeCount}</div><div class="kpi-lbl">linee</div></div>
        <div class="kpi"><div class="kpi-num">${opts.areaCount}</div><div class="kpi-lbl">zone</div></div>
        <div class="kpi"><div class="kpi-num">${opts.productCount}</div><div class="kpi-lbl">prodotti</div></div>
        <div class="kpi"><div class="kpi-num">${fmtMoney(opts.minPrice)}–${fmtMoney(opts.maxPrice)}€</div><div class="kpi-lbl">range prezzi</div></div>
      </div>
      <div class="cover-foot">
        <div><strong>Metodo zonizzazione:</strong> ${escape(opts.zoningMethod ? (ZONING_LABEL[opts.zoningMethod] || opts.zoningMethod) : "—")}</div>
        <div><strong>Standard:</strong> GTFS Fares V2 · DGR Marche n. 1036/2022</div>
      </div>
    </section>
  `;
}

/**
 * Gradiente "termico" verde→giallo→arancio→rosso, leggibile su carta.
 * Si interpola linearmente in HSL passando per 4 stop.
 */
function priceColor(amount: number, min: number, max: number): string {
  if (max <= min || !isFinite(amount)) return "#ecfdf5";
  const t = Math.max(0, Math.min(1, (amount - min) / (max - min)));
  // 4 stops: verde acqua → giallo paglia → arancio → rosso mattone
  const stops = [
    { t: 0.0,  h: 152, s: 65, l: 90 }, // verde tenue
    { t: 0.33, h: 75,  s: 75, l: 80 }, // lime/giallo
    { t: 0.66, h: 32,  s: 90, l: 70 }, // arancio
    { t: 1.0,  h: 0,   s: 75, l: 60 }, // rosso mattone
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const k = hi.t === lo.t ? 0 : (t - lo.t) / (hi.t - lo.t);
  const h = Math.round(lo.h + (hi.h - lo.h) * k);
  const s = Math.round(lo.s + (hi.s - lo.s) * k);
  const l = Math.round(lo.l + (hi.l - lo.l) * k);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * Risolve il prezzo del biglietto ordinario tra due fermate della linea
 * passando per le rispettive zone tariffarie.
 */
function lookupPriceBetweenStops(
  fromStop: RouteStop, toStop: RouteStop,
  network: string, model: PriceModel
): number | null {
  const fromArea = fromStop.currentAreaId || fromStop.suggestedAreaId || model.stopToArea.get(fromStop.stopId);
  const toArea   = toStop.currentAreaId   || toStop.suggestedAreaId   || model.stopToArea.get(toStop.stopId);
  if (!fromArea || !toArea) return null;
  const direct = model.prices.get(`${network}|${fromArea}|${toArea}`);
  if (direct != null) return direct;
  const reverse = model.prices.get(`${network}|${toArea}|${fromArea}`);
  return reverse ?? null;
}

/**
 * Genera abbreviazione nome fermata per intestazione di colonna ruotata.
 * Tronca a max 28 caratteri, rimuove parentesi/dettagli.
 */
function shortStopLabel(name: string, max = 28): string {
  let s = name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

/**
 * Densità della matrice in funzione del numero di fermate.
 * Restituisce dimensioni in px utilizzate sia in screen che in print.
 */
function densityForStops(n: number): {
  cellSize: number;
  cellFont: number;
  headerHeight: number;
  headerFont: number;
  nameWidth: number;
  scale: "L" | "M" | "S" | "XS" | "XXS";
} {
  if (n <= 20) return { cellSize: 26, cellFont: 10, headerHeight: 110, headerFont: 9,  nameWidth: 150, scale: "L"   };
  if (n <= 30) return { cellSize: 22, cellFont: 9,  headerHeight: 105, headerFont: 8,  nameWidth: 135, scale: "M"   };
  if (n <= 45) return { cellSize: 16, cellFont: 7,  headerHeight: 95,  headerFont: 7,  nameWidth: 115, scale: "S"   };
  if (n <= 60) return { cellSize: 13, cellFont: 6,  headerHeight: 90,  headerFont: 6,  nameWidth: 100, scale: "XS"  };
  return            { cellSize: 10, cellFont: 5,  headerHeight: 80,  headerFont: 5,  nameWidth: 88,  scale: "XXS" };
}

/**
 * Tabella triangolare fermata×fermata. Le intestazioni colonna sono testo
 * verticale (rotato 90°). La cella (i, j) con i ≤ j mostra il prezzo tra
 * la fermata i (riga) e la fermata j (colonna). Le celle sotto la diagonale
 * sono lasciate vuote (la matrice è simmetrica).
 */
function renderStopMatrix(sheet: RouteSheet, model: PriceModel): string {
  const stops = sheet.stops;
  if (stops.length < 2) return `<div class="empty">Linea con meno di 2 fermate, polimetrica non applicabile.</div>`;
  const network = sheet.networkId || "";
  const d = densityForStops(stops.length);

  // Pre-calcola la matrice di prezzi per estrarre min/max LOCALI di questa linea
  // (così il gradiente è significativo anche se la rete ha range più ampio)
  const matrix: (number | null)[][] = stops.map((from, i) =>
    stops.map((to, j) => {
      if (j < i) return null;
      if (i === j) return null;
      return lookupPriceBetweenStops(from, to, network, model);
    })
  );
  let lMin = Infinity, lMax = -Infinity;
  for (const row of matrix) for (const v of row) {
    if (v != null && isFinite(v)) { if (v < lMin) lMin = v; if (v > lMax) lMax = v; }
  }
  if (!isFinite(lMin)) { lMin = 0; lMax = 0; }

  const headerCells = stops.map((s, j) => {
    const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
    const code = aid ? (model.areas.get(aid)?.code ?? "") : "";
    return `
      <th class="hcol">
        <div class="hcol-wrap">
          <div class="hcol-text">${j + 1}. ${escape(shortStopLabel(s.stopName))}${code ? ` <span class="zhint">[${escape(code)}]</span>` : ""}</div>
        </div>
      </th>
    `;
  }).join("");

  const rows = stops.map((from, i) => {
    const aid = from.currentAreaId || from.suggestedAreaId || model.stopToArea.get(from.stopId);
    const code = aid ? (model.areas.get(aid)?.code ?? "") : "";
    const cells = stops.map((_to, j) => {
      if (j < i) return `<td class="below"></td>`;
      if (i === j) return `<td class="diag">■</td>`;
      const price = matrix[i][j];
      if (price == null) return `<td class="na" title="N/D">–</td>`;
      const bg = priceColor(price, lMin, lMax);
      return `<td class="cell" style="background:${bg}" title="${escape(from.stopName)} → ${escape(stops[j].stopName)} : € ${fmtMoney(price)}">${fmtMoney(price)}</td>`;
    }).join("");
    return `
      <tr>
        <th class="rname">
          <div class="rname-num">${i + 1}</div>
          <div class="rname-text">${escape(shortStopLabel(from.stopName, 32))}</div>
          <div class="rname-km">${from.progressiveKm.toFixed(1)} km</div>
          ${code ? `<div class="rname-zone">${escape(code)}</div>` : `<div class="rname-zone na">—</div>`}
        </th>
        ${cells}
      </tr>
    `;
  }).join("");

  // Legenda colori (5 step)
  const steps = 5;
  const legendCells = Array.from({ length: steps }, (_, i) => {
    const v = lMin + (lMax - lMin) * (i / (steps - 1));
    return `<div class="lg-cell" style="background:${priceColor(v, lMin, lMax)}">${fmtMoney(v)}</div>`;
  }).join("");

  return `
    <div class="matrix-wrap density-${d.scale}"
         style="--cs:${d.cellSize}px;--cf:${d.cellFont}px;--hh:${d.headerHeight}px;--hf:${d.headerFont}px;--nw:${d.nameWidth}px">
      <table class="matrix">
        <thead>
          <tr>
            <th class="corner">Da \\ A</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="matrix-legend">
        <div class="lg-title">Scala prezzi (€)</div>
        <div class="lg-bar">${legendCells}</div>
        <div class="lg-hint">colore proporzionale al prezzo del biglietto ordinario tra le due fermate</div>
      </div>
    </div>
  `;
}

function renderRoutePage(sheet: RouteSheet, model: PriceModel, idx: number, total: number): string {
  const networkLabel = sheet.networkId ? (NETWORK_LABEL[sheet.networkId] || sheet.networkId) : "—";
  const lineColor = sheet.routeColor && sheet.routeColor !== "" ? `#${sheet.routeColor}` : "#0f766e";
  const stopCount = sheet.stops.length;
  const zoneCount = sheet.routeAreas.length;
  const tariffePossibili = stopCount > 0 ? Math.round(stopCount * (stopCount - 1) / 2) : 0;

  // Legenda zone compatta
  const zoneLegend = sheet.routeAreas.map(a => {
    const stopsInZone = sheet.stops.filter(s => {
      const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
      return aid === a.id;
    });
    const kmStart = stopsInZone[0]?.progressiveKm ?? 0;
    const kmEnd = stopsInZone[stopsInZone.length - 1]?.progressiveKm ?? 0;
    return `
      <div class="zone-item">
        <div class="zbadge" style="background:${lineColor}">${escape(a.code)}</div>
        <div class="zinfo">
          <div class="zname">${escape(a.name)}</div>
          <div class="zrange">${kmStart.toFixed(1)} – ${kmEnd.toFixed(1)} km · ${stopsInZone.length} ferm.</div>
        </div>
      </div>
    `;
  }).join("");

  return `
    <section class="page route" style="--line-color:${lineColor}">
      <header class="r-head">
        <div class="r-head-left">
          <div class="r-line-pill" style="background:${lineColor}">${escape(sheet.shortName)}</div>
          <div class="r-titles">
            <div class="r-title">${escape(sheet.capolineaA)} <span class="arrow">↔</span> ${escape(sheet.capolineaB)}</div>
            ${sheet.longName ? `<div class="r-subtitle">${escape(sheet.longName)}</div>` : ""}
          </div>
        </div>
        <div class="r-head-right">
          <div class="r-network">${escape(networkLabel)}</div>
          <div class="r-pageno">pag. ${idx} / ${total}</div>
        </div>
      </header>

      <div class="r-kpis">
        <div class="r-kpi"><div class="rk-num">${sheet.totalKm.toFixed(1)}</div><div class="rk-lbl">km totali</div></div>
        <div class="r-kpi"><div class="rk-num">${stopCount}</div><div class="rk-lbl">fermate</div></div>
        <div class="r-kpi"><div class="rk-num">${zoneCount}</div><div class="rk-lbl">zone tariffarie</div></div>
        <div class="r-kpi"><div class="rk-num">${tariffePossibili}</div><div class="rk-lbl">tariffe O/D</div></div>
      </div>

      <h3 class="r-section-title">
        Polimetrica fermata × fermata
        <span class="hint">prezzo del biglietto ordinario (€) all'incrocio tra fermata di partenza e di arrivo</span>
      </h3>

      ${renderStopMatrix(sheet, model)}

      ${zoneCount > 0 ? `
        <h3 class="r-section-title legend-title">Zone tariffarie della linea</h3>
        <div class="zones-legend">${zoneLegend}</div>
      ` : ""}

      <footer class="r-foot">
        <div>Linea <strong>${escape(sheet.shortName)}</strong> · ${escape(sheet.routeId)}</div>
        <div>GTFS Fares V2 · ${escape(networkLabel)}</div>
      </footer>
    </section>
  `;
}

const STYLES = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", system-ui, sans-serif;
    color: #1f2937;
    background: #f3f4f6;
    -webkit-font-smoothing: antialiased;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 20px;
    background: #0f172a; color: white;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  .toolbar h1 { margin: 0; font-size: 14px; font-weight: 600; }
  .toolbar button {
    background: #10b981; color: white; border: 0;
    padding: 8px 16px; border-radius: 6px; font-weight: 600;
    cursor: pointer; font-size: 13px;
  }
  .toolbar button:hover { background: #059669; }

  /* La cover resta portrait, le pagine linea sono landscape */
  @page { size: A4 landscape; margin: 8mm; }
  @page :first { size: A4 portrait; margin: 12mm; }

  @media print {
    body { background: white; }
    .toolbar { display: none; }
    .page { box-shadow: none !important; margin: 0 !important; }
  }

  .page {
    background: white;
    box-shadow: 0 4px 20px rgba(0,0,0,.08);
    page-break-after: always;
    display: flex; flex-direction: column;
  }
  .page:last-child { page-break-after: auto; }

  .page.cover { width: 210mm; min-height: 297mm; padding: 14mm 12mm; margin: 16px auto; }
  .page.route { width: 297mm; min-height: 210mm; padding: 8mm 10mm; margin: 16px auto; }

  /* ─── Cover ─────────────────────── */
  .cover { justify-content: space-between; }
  .cover-top {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 3px solid #0f766e; padding-bottom: 14px;
  }
  .brand { font-size: 16px; font-weight: 700; color: #0f766e; letter-spacing: .5px; text-transform: uppercase; }
  .cover-date { font-size: 13px; color: #64748b; }
  .cover-center { text-align: center; padding: 40mm 0; }
  .cover-eyebrow { font-size: 12px; letter-spacing: 3px; text-transform: uppercase; color: #64748b; margin-bottom: 16px; }
  .cover-title { font-size: 56px; font-weight: 800; margin: 0 0 12px; color: #0f172a; letter-spacing: -1px; }
  .cover-subtitle { font-size: 18px; color: #475569; }
  .cover-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 30px 0; }
  .cover-stats .kpi {
    border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px;
    text-align: center; background: linear-gradient(180deg, #f8fafc, #ffffff);
  }
  .cover-stats .kpi-num { font-size: 26px; font-weight: 800; color: #0f766e; }
  .cover-stats .kpi-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-top: 4px; }
  .cover-foot { font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 14px; display: flex; justify-content: space-between; }

  /* ─── Pagina linea (landscape) ─── */
  .route { gap: 6px; }
  .r-head {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 2px solid var(--line-color); padding-bottom: 6px;
  }
  .r-head-left { display: flex; align-items: center; gap: 12px; }
  .r-line-pill {
    color: white; font-weight: 800; font-size: 18px;
    padding: 6px 14px; border-radius: 8px; min-width: 56px; text-align: center;
    letter-spacing: .5px; box-shadow: 0 2px 6px rgba(0,0,0,.15);
  }
  .r-titles { display: flex; flex-direction: column; gap: 1px; }
  .r-title { font-size: 16px; font-weight: 700; color: #0f172a; }
  .r-title .arrow { color: var(--line-color); margin: 0 6px; font-weight: 400; }
  .r-subtitle { font-size: 10px; color: #64748b; }
  .r-head-right { text-align: right; }
  .r-network {
    background: var(--line-color); color: white;
    padding: 3px 9px; border-radius: 4px; font-size: 10px;
    font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
  }
  .r-pageno { font-size: 9px; color: #64748b; margin-top: 3px; }

  .r-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 4px 0; }
  .r-kpi {
    border: 1px solid #e5e7eb; border-radius: 6px;
    padding: 4px 8px; text-align: center;
    background: linear-gradient(180deg, #f8fafc, #ffffff);
  }
  .rk-num { font-size: 14px; font-weight: 700; color: var(--line-color); }
  .rk-lbl { font-size: 8px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }

  .r-section-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px;
    color: var(--line-color); font-weight: 700;
    border-bottom: 1px solid #e5e7eb; padding-bottom: 3px;
    margin: 6px 0 4px;
  }
  .r-section-title .hint {
    color: #94a3b8; font-weight: 400; text-transform: none;
    letter-spacing: 0; font-size: 9px; margin-left: 6px;
  }
  .legend-title { margin-top: 8px; }

  /* ─── Matrice fermata × fermata ─── */
  .matrix-wrap { display: flex; flex-direction: column; gap: 6px; }
  table.matrix {
    border-collapse: separate; border-spacing: 0;
    table-layout: fixed;
    margin: 0 auto;
  }
  table.matrix th, table.matrix td {
    border: 1px solid #e5e7eb;
    width: var(--cs); height: var(--cs);
    min-width: var(--cs); max-width: var(--cs);
    padding: 0; text-align: center; vertical-align: middle;
    font-variant-numeric: tabular-nums;
    font-size: var(--cf);
  }
  table.matrix th.corner {
    width: var(--nw); min-width: var(--nw); max-width: var(--nw);
    height: var(--hh); min-height: var(--hh);
    background: var(--line-color); color: white;
    font-weight: 700; font-size: 9px;
    border-color: var(--line-color);
  }
  table.matrix th.hcol {
    height: var(--hh); min-height: var(--hh);
    background: #f8fafc;
    vertical-align: bottom;
    padding: 0;
  }
  table.matrix th.hcol .hcol-wrap {
    width: var(--cs); height: var(--hh);
    display: flex; align-items: flex-end; justify-content: center;
    overflow: hidden;
  }
  table.matrix th.hcol .hcol-text {
    transform: rotate(-65deg); transform-origin: bottom center;
    white-space: nowrap;
    font-size: var(--hf); font-weight: 600;
    color: #1e293b;
    line-height: 1;
    padding-bottom: calc(var(--cs) / 2);
  }
  table.matrix th.hcol .zhint { color: var(--line-color); font-weight: 700; }

  table.matrix th.rname {
    width: var(--nw); min-width: var(--nw); max-width: var(--nw);
    background: #f8fafc;
    text-align: left;
    padding: 2px 6px;
    font-size: var(--hf);
    font-weight: 600; color: #1e293b;
    line-height: 1.15;
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: 4px; align-items: center;
  }
  table.matrix th.rname .rname-num {
    color: #94a3b8; font-weight: 500;
    font-variant-numeric: tabular-nums;
    min-width: 18px; text-align: right;
  }
  table.matrix th.rname .rname-text {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  table.matrix th.rname .rname-km {
    font-size: calc(var(--hf) - 1px); color: #64748b; font-weight: 500;
    white-space: nowrap;
  }
  table.matrix th.rname .rname-zone {
    background: var(--line-color); color: white;
    font-weight: 700; font-size: calc(var(--hf) - 1px);
    padding: 1px 4px; border-radius: 3px;
    min-width: 18px; text-align: center;
  }
  table.matrix th.rname .rname-zone.na { background: #cbd5e1; }

  table.matrix td.cell {
    font-weight: 600; color: #0f172a;
  }
  table.matrix td.diag {
    background: #1e293b; color: white;
    font-size: calc(var(--cf) - 2px);
  }
  table.matrix td.below {
    background: repeating-linear-gradient(45deg, #f8fafc 0 4px, #f1f5f9 4px 8px);
    border-color: #f1f5f9;
  }
  table.matrix td.na {
    background: #fafafa; color: #cbd5e1;
  }

  /* densità XS/XXS: nascondi km nelle intestazioni di riga per stare in pagina */
  .density-XS table.matrix th.rname .rname-km,
  .density-XXS table.matrix th.rname .rname-km { display: none; }

  /* ─── Legenda colori ─── */
  .matrix-legend {
    display: flex; align-items: center; justify-content: center;
    gap: 12px; margin-top: 8px;
    font-size: 9px; color: #475569;
  }
  .lg-title { font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: #1e293b; }
  .lg-bar { display: flex; gap: 2px; }
  .lg-cell {
    min-width: 48px; padding: 4px 8px;
    text-align: center; font-weight: 700; font-size: 10px;
    color: #0f172a; border: 1px solid #e5e7eb; border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }
  .lg-hint { color: #94a3b8; font-style: italic; }

  /* ─── Legenda zone ─── */
  .zones-legend {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 4px;
  }
  .zone-item {
    display: flex; gap: 6px; align-items: center;
    padding: 3px 6px; border: 1px solid #e5e7eb; border-radius: 5px;
    background: #fafafa;
  }
  .zbadge {
    color: white; width: 22px; height: 22px; border-radius: 5px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 10px; flex-shrink: 0;
  }
  .zinfo { flex: 1; min-width: 0; }
  .zname {
    font-size: 9px; font-weight: 600; color: #1f2937;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .zrange { font-size: 8px; color: #64748b; }

  .empty {
    color: #94a3b8; font-style: italic; padding: 16px;
    text-align: center; border: 1px dashed #cbd5e1; border-radius: 6px;
  }

  .r-foot {
    display: flex; justify-content: space-between;
    border-top: 1px solid #e5e7eb; padding-top: 4px; margin-top: auto;
    font-size: 8px; color: #94a3b8;
  }
`;

/* ──────────────────────────────────────────────────────────
 * Entry point
 * ──────────────────────────────────────────────────────── */

export async function exportPolimetricheToPrint(input: PolimetricheInput): Promise<void> {
  const agencyName = input.agencyName || "Conerobus · Trasporto Pubblico Locale";
  const date = input.date || new Date().toLocaleDateString("it-IT");

  // Apri subito una finestra di "loading" per non incorrere nel blocco popup post-await
  const win = window.open("", "_blank", "width=1100,height=850");
  if (!win) {
    alert("Abilita i popup per aprire il report polimetriche.");
    return;
  }
  win.document.write(`
    <!doctype html><html><head><title>Polimetriche — caricamento…</title>
    <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;color:#475569}
    .l{text-align:center}.s{display:inline-block;width:40px;height:40px;border:3px solid #cbd5e1;border-top-color:#0f766e;border-radius:50%;animation:r 1s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}</style></head>
    <body><div class="l"><div class="s"></div><p>Costruzione polimetriche tariffarie…</p></div></body></html>
  `);

  try {
    // 1) Costruisci modello prezzi dai CSV
    const model = buildPriceModel(input.files);

    // 2) Recupera elenco linee
    const routes = await apiFetch<RouteNetworkRow[]>("/api/fares/route-networks");
    if (!routes || routes.length === 0) {
      win.document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#dc2626">Nessuna linea trovata. Verifica che il feed GTFS sia caricato.</div>`;
      return;
    }

    // 3) Per ciascuna linea recupera fermate + km in parallelo (con concurrency limit)
    const sheets: RouteSheet[] = [];
    const CONCURRENCY = 6;
    let cursor = 0;
    async function worker() {
      while (cursor < routes.length) {
        const idx = cursor++;
        const r = routes[idx];
        const sheet = await fetchRouteSheet(r, model);
        if (sheet && sheet.stops.length >= 2) sheets.push(sheet);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // 4) Ordina: prima per network, poi per shortName naturale
    sheets.sort((a, b) => {
      const na = a.networkId || "zzz";
      const nb = b.networkId || "zzz";
      if (na !== nb) return na.localeCompare(nb);
      return a.shortName.localeCompare(b.shortName, "it", { numeric: true });
    });

    // 5) Render
    const productCount = model.products.size;
    const areaCount = model.areas.size;
    const cover = renderCoverPage({
      agencyName, date,
      zoningMethod: input.zoningMethod,
      routeCount: sheets.length,
      productCount,
      areaCount,
      minPrice: model.minPrice,
      maxPrice: model.maxPrice,
    });
    const pages = sheets.map((s, i) => renderRoutePage(s, model, i + 1, sheets.length)).join("");

    const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>Polimetriche tariffarie — ${escape(agencyName)} — ${escape(date)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="toolbar">
    <h1>📊 Polimetriche tariffarie · ${escape(agencyName)} · ${sheets.length} linee</h1>
    <div>
      <button onclick="window.print()">🖨️ Stampa / Salva PDF</button>
    </div>
  </div>
  ${cover}
  ${pages}
</body>
</html>`;

    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err: any) {
    win.document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#dc2626">
      <h2>Errore generazione polimetriche</h2>
      <pre style="white-space:pre-wrap">${escape(err?.message || String(err))}</pre>
    </div>`;
  }
}
