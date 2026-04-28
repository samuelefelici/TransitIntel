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
 * Modello prezzi
 *
 * Per riprodurre la polimetrica corretta serve distinguere il pricing
 * delle reti URBANE (tariffa flat su tutta la rete) da quello
 * EXTRAURBANO (prezzo = f(Δkm) con fasce chilometriche).
 *
 *   • Urbano:    prezzo costante = biglietto base 60 min della città.
 *                Si individua il prodotto col `network_id` della rete e
 *                il prezzo minimo (o nome contenente "60 min").
 *   • Extraurbano: prodotti `extra_fascia_${N}` con name "Extraurbano X-Y km"
 *                Si parsano i breakpoints km dal nome e si costruisce una
 *                funzione  Δkm → prezzo. Δkm = |km_destinazione - km_origine|
 *                lungo lo stesso percorso (km progressivi della linea).
 * ──────────────────────────────────────────────────────── */

interface PriceModel {
  /** mappa areaId → nome leggibile (con codice corto Z1, Z2, …) */
  areas: Map<string, { id: string; name: string; code: string }>;
  /** prodotti tariffari */
  products: Map<string, { id: string; name: string; amount: number; currency: string; networkId?: string }>;
  /** mappa stopId → areaId (dal CSV stop_areas.txt) */
  stopToArea: Map<string, string>;
  /** Tariffa flat per network urbano (network_id → prezzo €) */
  urbanFlatByNetwork: Map<string, { amount: number; productId: string; productName: string }>;
  /** Bands extraurbano ordinate per kmFrom crescente */
  extraBands: { fascia: number; kmFrom: number; kmTo: number; price: number; productId: string }[];
  /** range prezzi globale (per la scala globale; ogni linea avrà però la propria scala locale) */
  minPrice: number;
  maxPrice: number;
}

interface FareProductRowExt extends FareProductRow {
  network_id?: string;
}

function buildPriceModel(files: Record<string, string>): PriceModel {
  const areasRows = parseCsv(files["areas.txt"]) as unknown as AreaRow[];
  const stopAreasRows = parseCsv(files["stop_areas.txt"]) as unknown as StopAreaRow[];
  const productsRows = parseCsv(files["fare_products.txt"]) as unknown as FareProductRowExt[];

  // Aree con codice corto Z1, Z2…
  const areas = new Map<string, { id: string; name: string; code: string }>();
  areasRows.forEach((a, i) => {
    areas.set(a.area_id, { id: a.area_id, name: a.area_name || a.area_id, code: `Z${i + 1}` });
  });

  // Prodotti
  const products = new Map<string, { id: string; name: string; amount: number; currency: string; networkId?: string }>();
  productsRows.forEach(p => {
    products.set(p.fare_product_id, {
      id: p.fare_product_id,
      name: p.fare_product_name || p.fare_product_id,
      amount: parseFloat(p.amount) || 0,
      currency: p.currency || "EUR",
      networkId: (p as FareProductRowExt).network_id,
    });
  });

  // Stop → area
  const stopToArea = new Map<string, string>();
  stopAreasRows.forEach(sa => stopToArea.set(sa.stop_id, sa.area_id));

  // ─── Tariffe extraurbano: parsa "Extraurbano X-Y km" dai prodotti ──
  const extraBands: PriceModel["extraBands"] = [];
  for (const [pid, p] of products) {
    if (!/^extra_fascia_/i.test(pid)) continue;
    const m = p.name.match(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)\s*km/i);
    if (!m) continue;
    const fasciaMatch = pid.match(/extra_fascia_(\d+)/i);
    extraBands.push({
      fascia: fasciaMatch ? parseInt(fasciaMatch[1], 10) : extraBands.length + 1,
      kmFrom: parseFloat(m[1].replace(",", ".")),
      kmTo: parseFloat(m[2].replace(",", ".")),
      price: p.amount,
      productId: pid,
    });
  }
  extraBands.sort((a, b) => a.kmFrom - b.kmFrom);

  // ─── Tariffa flat per ogni rete urbana ──
  // Strategia: per ogni network_id che inizia con "urbano_", scegli il
  // biglietto "base" = single 60min (id contenente _60min) altrimenti il
  // prodotto col prezzo minimo della rete.
  const urbanFlatByNetwork = new Map<string, { amount: number; productId: string; productName: string }>();
  const productsByNet = new Map<string, FareProductRowExt[]>();
  productsRows.forEach(p => {
    const nid = (p as FareProductRowExt).network_id;
    if (!nid || !/^urbano_/i.test(nid)) return;
    if (!productsByNet.has(nid)) productsByNet.set(nid, []);
    productsByNet.get(nid)!.push(p);
  });
  for (const [nid, prods] of productsByNet) {
    // priorità: id contenente "_60min" o nome con "60 min"
    let chosen = prods.find(p => /_60min/i.test(p.fare_product_id) || /60\s*min/i.test(p.fare_product_name));
    if (!chosen) {
      // fallback: prezzo minimo > 0
      chosen = prods
        .map(p => ({ p, amt: parseFloat(p.amount) || 0 }))
        .filter(x => x.amt > 0)
        .sort((a, b) => a.amt - b.amt)
        .map(x => x.p)[0];
    }
    if (chosen) {
      urbanFlatByNetwork.set(nid, {
        amount: parseFloat(chosen.amount) || 0,
        productId: chosen.fare_product_id,
        productName: chosen.fare_product_name,
      });
    }
  }

  // Range globale (per la legenda di copertina)
  let minPrice = Infinity, maxPrice = -Infinity;
  for (const v of urbanFlatByNetwork.values()) {
    if (v.amount < minPrice) minPrice = v.amount;
    if (v.amount > maxPrice) maxPrice = v.amount;
  }
  for (const b of extraBands) {
    if (b.price < minPrice) minPrice = b.price;
    if (b.price > maxPrice) maxPrice = b.price;
  }
  if (!isFinite(minPrice)) { minPrice = 0; maxPrice = 0; }

  return { areas, products, stopToArea, urbanFlatByNetwork, extraBands, minPrice, maxPrice };
}

/** Ritorna la fascia tariffaria extraurbana per una distanza in km. */
function bandForDeltaKm(deltaKm: number, bands: PriceModel["extraBands"]): PriceModel["extraBands"][number] | null {
  if (bands.length === 0) return null;
  const d = Math.max(0, deltaKm);
  // Convenzione: kmFrom < d ≤ kmTo (la fascia 1 copre d=0 perché 0 ≤ 6)
  for (const b of bands) {
    if (d <= b.kmTo + 1e-9) return b;
  }
  // Se eccede l'ultima fascia, usa l'ultima (cap)
  return bands[bands.length - 1];
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
 * Risolve il prezzo del biglietto ordinario tra due fermate della linea.
 *
 *  • Per le reti URBANE è una tariffa flat (biglietto base 60 min),
 *    indipendente dalle due fermate.
 *  • Per l'EXTRAURBANO il prezzo dipende dalla distanza in km tra
 *    le due fermate sullo stesso percorso (km progressivi):
 *        Δkm = |km_destinazione - km_origine|
 *        prezzo = price(fascia in cui ricade Δkm)
 *
 * Ritorna anche la fascia (per evidenziarla nel rendering).
 */
function lookupPriceBetweenStops(
  fromStop: RouteStop, toStop: RouteStop,
  network: string, model: PriceModel
): { price: number; fascia: number | null; deltaKm: number } | null {
  const deltaKm = Math.abs(toStop.progressiveKm - fromStop.progressiveKm);

  // Urbano → flat
  if (/^urbano_/i.test(network)) {
    const flat = model.urbanFlatByNetwork.get(network);
    if (!flat) return null;
    return { price: flat.amount, fascia: null, deltaKm };
  }

  // Extraurbano (e qualsiasi altra rete a fasce km)
  const band = bandForDeltaKm(deltaKm, model.extraBands);
  if (!band) return null;
  return { price: band.price, fascia: band.fascia, deltaKm };
}

/**
 * Normalizza il colore della linea proveniente da GTFS (`route_color`).
 * Rifiuta valori vuoti, malformati e bianchi/quasi-bianchi (luminanza > .85)
 * che renderebbero invisibile la pill su sfondo bianco.
 */
function normalizeLineColor(c: string | null | undefined): string {
  const FALLBACK = "#0f766e";
  if (!c) return FALLBACK;
  const hex = c.replace("#", "").trim();
  if (hex.length !== 3 && hex.length !== 6) return FALLBACK;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return FALLBACK;
  const full = hex.length === 3 ? hex.split("").map(ch => ch + ch).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.85) return FALLBACK;
  return "#" + full.toLowerCase();
}

/**
 * Palette di colori distinguibili per le zone tariffarie di una linea.
 * Restituisce un colore stabile per indice di gruppo (rotazione HSL ~goldena).
 * Tinte pastello a media saturazione, leggibili come fascia di sfondo tenue
 * e come bordo pieno di separazione.
 */
const ZONE_PALETTE = [
  "#0ea5e9", // sky
  "#a855f7", // purple
  "#ec4899", // pink
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#6366f1", // indigo
  "#14b8a6", // teal
  "#eab308", // yellow
  "#8b5cf6", // violet
];
function groupColor(idx: number): string {
  return ZONE_PALETTE[idx % ZONE_PALETTE.length];
}
/** Versione tenue (pastello chiaro) del colore zona, per background di intestazioni. */
function groupColorSoft(idx: number): string {
  // hex → rgba(.., .18) per fascia di sfondo molto leggera
  const hex = groupColor(idx).replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.16)`;
}

/**
 * Genera abbreviazione nome fermata per intestazione di colonna ruotata.
 * Rimuove parentesi/dettagli e applica un troncamento solo se serve.
 */
function shortStopLabel(name: string, max = 60): string {
  let s = name.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}

/**
/**
 * Densità della matrice in funzione del numero di fermate.
 * Layout: triangolo rettangolo con angolo in basso-sinistra. Le intestazioni
 * di colonna sono solo numeri (in fondo); i nomi completi delle fermate
 * vivono sulla colonna sinistra (spazio orizzontale generoso, A3 landscape).
 */
function densityForStops(n: number): {
  cellSize: number;
  cellFont: number;
  headerFont: number;
  nameWidth: number;
  scale: "L" | "M" | "S" | "XS" | "XXS";
} {
  // A3 landscape ~ 400mm utili in larghezza → ~1500px @ 96dpi
  if (n <= 20) return { cellSize: 42, cellFont: 13, headerFont: 13, nameWidth: 320, scale: "L"   };
  if (n <= 30) return { cellSize: 32, cellFont: 11, headerFont: 12, nameWidth: 290, scale: "M"   };
  if (n <= 45) return { cellSize: 24, cellFont: 9,  headerFont: 11, nameWidth: 260, scale: "S"   };
  if (n <= 60) return { cellSize: 19, cellFont: 8,  headerFont: 10, nameWidth: 230, scale: "XS"  };
  return            { cellSize: 14, cellFont: 7,  headerFont: 9,  nameWidth: 200, scale: "XXS" };
}

/**
 * Polimetrica triangolare classica.
 *
 * Layout: triangolo rettangolo con angolo di 90° in BASSO-SINISTRA.
 *   • Colonna sinistra: numero progressivo + nome completo + km/zona
 *     (qui c'è tutto lo spazio orizzontale che serve)
 *   • Riga inferiore: solo numeri (1, 2, 3 …) per identificare la colonna
 *   • Triangolo prezzi sotto la diagonale: cella (i, j) con j < i
 *     mostra la tariffa fra la fermata di partenza i e quella di arrivo j
 *   • La metà sopra la diagonale resta volutamente vuota (la matrice è
 *     simmetrica)
 *
 * I confini di zona sono evidenziati con righe tratteggiate leggere
 * (niente colori invadenti).
 */
function renderStopMatrix(sheet: RouteSheet, model: PriceModel): string {
  const stops = sheet.stops;
  if (stops.length < 2) return `<div class="empty">Linea con meno di 2 fermate, polimetrica non applicabile.</div>`;
  const network = sheet.networkId || "";
  const isUrban = /^urbano_/i.test(network);
  const d = densityForStops(stops.length);

  // Pre-calcola la matrice di prezzi (con metadati fascia/Δkm)
  // matrix[i][j] è valida solo per j < i (triangolo inferiore)
  type Cell = { price: number; fascia: number | null; deltaKm: number } | null;
  const matrix: Cell[][] = stops.map((from, i) =>
    stops.map((to, j) => {
      if (j >= i) return null; // solo triangolo inferiore stretto
      return lookupPriceBetweenStops(from, to, network, model);
    })
  );

  // Range LOCALE alla linea (per heatmap significativa anche per linee corte)
  let lMin = Infinity, lMax = -Infinity;
  for (const row of matrix) for (const c of row) {
    if (c && isFinite(c.price)) { if (c.price < lMin) lMin = c.price; if (c.price > lMax) lMax = c.price; }
  }
  if (!isFinite(lMin)) { lMin = 0; lMax = 0; }

  // ─── Raggruppamento visivo per zona tariffaria ──
  // Solo per disegnare le righe tratteggiate dove cambia la zona.
  const stopGroup: string[] = stops.map(s => {
    if (isUrban) return network;
    const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
    return aid || "noarea";
  });
  const isGroupBoundary = (i: number) => i > 0 && stopGroup[i] !== stopGroup[i - 1];

  // ─── Righe (una per fermata) ──
  const rows = stops.map((from, i) => {
    const aid = from.currentAreaId || from.suggestedAreaId || model.stopToArea.get(from.stopId);
    const code = aid ? (model.areas.get(aid)?.code ?? "") : "";
    const rowBoundary = isGroupBoundary(i) ? " gboundary-t" : "";

    // Celle prezzo per j = 0 … i-1 (sotto la diagonale)
    const priceCells = stops.slice(0, i).map((to, j) => {
      const c = matrix[i][j];
      const colBoundary = isGroupBoundary(j) ? " gboundary-l" : "";
      if (c == null) return `<td class="na${colBoundary}" title="N/D">–</td>`;
      const bg = priceColor(c.price, lMin, lMax);
      const tip = `${escape(from.stopName)} → ${escape(to.stopName)} : € ${fmtMoney(c.price)}` +
                  (c.fascia ? ` · F${c.fascia} (${c.deltaKm.toFixed(1)} km)` : "");
      return `<td class="cell${colBoundary}" style="background:${bg}" title="${tip}">${fmtMoney(c.price)}</td>`;
    }).join("");

    // Cella diagonale (j = i): marker
    const diagBoundary = isGroupBoundary(i) ? " gboundary-l" : "";
    const diagCell = `<td class="diag${diagBoundary}">■</td>`;

    // Celle vuote SOPRA la diagonale (j = i+1 … N-1) — tengono il grid stabile
    const emptyAfter = stops.slice(i + 1).map((_, k) => {
      const colJ = i + 1 + k;
      const cb = isGroupBoundary(colJ) ? " gboundary-l" : "";
      return `<td class="above-diag${cb}"></td>`;
    }).join("");

    return `
      <tr class="${rowBoundary}">
        <th class="rn-num">${i + 1}</th>
        <th class="rn-name">
          <div class="rn-text" title="${escape(from.stopName)}">${escape(from.stopName)}</div>
          <div class="rn-meta">${from.progressiveKm.toFixed(1)} km${code ? ` · <span class="rn-zone">${escape(code)}</span>` : ""}</div>
        </th>
        ${priceCells}
        ${diagCell}
        ${emptyAfter}
      </tr>
    `;
  }).join("");

  // Riga finale con i numeri di colonna (lettura veloce: prezzo fra riga i e colonna j)
  const colNumberRow = `
    <tr class="cnum-row">
      <th class="rn-num"></th>
      <th class="rn-name cnum-label">↓ riga = partenza · ↑ colonna = arrivo (n° fermata)</th>
      ${stops.map((_, j) => {
        const cb = isGroupBoundary(j) ? " gboundary-l" : "";
        return `<th class="cn-num${cb}">${j + 1}</th>`;
      }).join("")}
    </tr>
  `;

  // ─── Banner descrittivo del modo tariffario ──
  const modeBanner = isUrban
    ? (() => {
        const flat = model.urbanFlatByNetwork.get(network);
        if (!flat) return `<div class="mode-banner urban">Rete urbana: tariffa flat (prodotto non identificato)</div>`;
        return `
          <div class="mode-banner urban">
            <div class="mb-icon">🎫</div>
            <div class="mb-text">
              <strong>Tariffa urbana flat</strong> · ogni biglietto sulla rete costa
              <span class="mb-price">€ ${fmtMoney(flat.amount)}</span>
              <span class="mb-sub">— ${escape(flat.productName)}</span>
            </div>
          </div>`;
      })()
    : (() => {
        const bands = model.extraBands;
        if (bands.length === 0) return `<div class="mode-banner extra">Rete extraurbana ma nessuna fascia tariffaria identificata.</div>`;
        const cells = bands.map(b => `
          <div class="band-chip">
            <div class="bc-fascia">F${b.fascia}</div>
            <div class="bc-km">${b.kmFrom.toFixed(0)}–${b.kmTo.toFixed(0)} km</div>
            <div class="bc-price">€ ${fmtMoney(b.price)}</div>
          </div>
        `).join("");
        return `
          <div class="mode-banner extra">
            <div class="mb-icon">📏</div>
            <div class="mb-text">
              <strong>Tariffa extraurbana a fasce chilometriche</strong>
              <span class="mb-sub">prezzo = f(distanza tra le fermate); fasce regionali (DGR Marche n. 1036/2022)</span>
            </div>
            <div class="bands-strip">${cells}</div>
          </div>`;
      })();

  // ─── Legenda colori ──
  const steps = 5;
  const legendCells = Array.from({ length: steps }, (_, i) => {
    const v = lMin + (lMax - lMin) * (i / Math.max(1, (steps - 1)));
    return `<div class="lg-cell" style="background:${priceColor(v, lMin, lMax)}">${fmtMoney(v)}</div>`;
  }).join("");

  return `
    ${modeBanner}
    <div class="matrix-wrap density-${d.scale}"
         style="--cs:${d.cellSize}px;--cf:${d.cellFont}px;--hf:${d.headerFont}px;--nw:${d.nameWidth}px">
      <table class="matrix">
        <colgroup>
          <col class="cg-num">
          <col class="cg-name">
          ${stops.map(() => `<col class="cg-cell">`).join("")}
        </colgroup>
        <tbody>
          ${rows}
          ${colNumberRow}
        </tbody>
      </table>

      <div class="matrix-legend">
        <div class="lg-title">Scala prezzi (€)</div>
        <div class="lg-bar">${legendCells}</div>
        <div class="lg-hint">${isUrban ? "rete urbana: tariffa flat (matrice volutamente uniforme)" : "colore proporzionale al prezzo; tratteggio = cambio di zona tariffaria"}</div>
      </div>
    </div>
  `;
}

function renderRoutePage(sheet: RouteSheet, model: PriceModel, idx: number, total: number): string {
  const networkLabel = sheet.networkId ? (NETWORK_LABEL[sheet.networkId] || sheet.networkId) : "—";
  const lineColor = normalizeLineColor(sheet.routeColor);
  const stopCount = sheet.stops.length;
  const zoneCount = sheet.routeAreas.length;
  const tariffePossibili = stopCount > 0 ? Math.round(stopCount * (stopCount - 1) / 2) : 0;

  // Legenda zone compatta — colori coerenti con la matrice (palette per indice gruppo)
  const zoneLegend = sheet.routeAreas.map((a, idx) => {
    const stopsInZone = sheet.stops.filter(s => {
      const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
      return aid === a.id;
    });
    const kmStart = stopsInZone[0]?.progressiveKm ?? 0;
    const kmEnd = stopsInZone[stopsInZone.length - 1]?.progressiveKm ?? 0;
    const zc = groupColor(idx);
    return `
      <div class="zone-item" style="border-left:4px solid ${zc};background:${groupColorSoft(idx)}">
        <div class="zbadge" style="background:${zc}">${escape(a.code)}</div>
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

  /* La cover resta A4 portrait, le pagine linea sono A3 landscape */
  @page { size: A3 landscape; margin: 10mm; }
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
  .page.route { width: 420mm; min-height: 297mm; padding: 10mm 12mm; margin: 16px auto; }

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

  /* ─── Matrice fermata × fermata (triangolo basso-sx) ─── */
  .matrix-wrap { display: flex; flex-direction: column; gap: 6px; }
  table.matrix {
    border-collapse: separate; border-spacing: 0;
    table-layout: fixed;
    margin: 0 auto;
  }
  /* Larghezze colonne */
  table.matrix col.cg-num  { width: 28px; }
  table.matrix col.cg-name { width: var(--nw); }
  table.matrix col.cg-cell { width: var(--cs); }

  /* Default celle */
  table.matrix th, table.matrix td {
    border: 1px solid #e5e7eb;
    height: var(--cs);
    padding: 0; text-align: center; vertical-align: middle;
    font-variant-numeric: tabular-nums;
    font-size: var(--cf);
  }

  /* Colonna numero progressivo (leftmost) */
  table.matrix th.rn-num {
    background: var(--line-color); color: white;
    font-weight: 700; font-size: var(--hf);
    border-color: var(--line-color);
  }

  /* Colonna nome fermata (sinistra, larga) */
  table.matrix th.rn-name {
    background: #f8fafc;
    text-align: left;
    padding: 3px 8px;
    line-height: 1.15;
    font-weight: 600;
    color: #1e293b;
  }
  table.matrix th.rn-name .rn-text {
    font-size: var(--hf);
    font-weight: 700;
    color: #0f172a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  table.matrix th.rn-name .rn-meta {
    font-size: calc(var(--hf) - 2px);
    color: #64748b;
    font-weight: 500;
    margin-top: 1px;
  }
  table.matrix th.rn-name .rn-zone {
    background: var(--line-color); color: white;
    padding: 0 5px; border-radius: 3px;
    font-weight: 700; font-size: calc(var(--hf) - 3px);
    margin-left: 2px;
  }

  /* Celle prezzo (sotto la diagonale) */
  table.matrix td.cell {
    font-weight: 600; color: #0f172a;
  }
  /* Diagonale */
  table.matrix td.diag {
    background: #1e293b; color: white;
    font-size: calc(var(--cf) - 2px);
  }
  /* Sopra la diagonale: visivamente vuoto */
  table.matrix td.above-diag {
    background: transparent;
    border-color: transparent;
  }
  table.matrix td.na {
    background: #fafafa; color: #cbd5e1;
  }

  /* Riga numeri colonna (in fondo) */
  table.matrix tr.cnum-row th {
    height: calc(var(--cs) * 0.85);
    border-top: 2px solid #cbd5e1;
  }
  table.matrix tr.cnum-row th.cn-num {
    background: var(--line-color); color: white;
    font-weight: 700; font-size: var(--hf);
    border-color: var(--line-color);
  }
  table.matrix tr.cnum-row th.cnum-label {
    background: #f1f5f9;
    text-align: right;
    padding-right: 8px;
    color: #64748b;
    font-weight: 500;
    font-size: calc(var(--hf) - 2px);
    font-style: italic;
  }

  /* densità XS/XXS: nascondi km in metadati riga per stare in pagina */
  .density-XS table.matrix th.rn-name .rn-meta,
  .density-XXS table.matrix th.rn-name .rn-meta { display: none; }

  /* ─── Confini di zona: righe TRATTEGGIATE leggere (no colori invadenti) ─── */
  table.matrix .gboundary-l { border-left: 1.5px dashed #94a3b8 !important; }
  table.matrix tr.gboundary-t > * { border-top: 1.5px dashed #94a3b8 !important; }
  /* Anche sulle celle vuote sopra la diagonale, mantieni il tratteggio visibile */
  table.matrix td.above-diag.gboundary-l { border-left: 1.5px dashed #cbd5e1 !important; }
  table.matrix tr.gboundary-t > td.above-diag { border-top: 1.5px dashed #cbd5e1 !important; }

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

  /* ─── Banner modo tariffario ─── */
  .mode-banner {
    display: flex; align-items: center; gap: 12px;
    padding: 8px 12px; border-radius: 8px;
    margin-bottom: 6px;
    border: 1px solid;
  }
  .mode-banner.urban  { background: #eff6ff; border-color: #bfdbfe; color: #1e40af; }
  .mode-banner.extra  { background: #fef3c7; border-color: #fcd34d; color: #92400e; }
  .mb-icon { font-size: 22px; flex-shrink: 0; }
  .mb-text { flex: 1; font-size: 11px; line-height: 1.4; }
  .mb-text strong { font-size: 12px; }
  .mb-text .mb-price { font-weight: 800; font-size: 14px; margin: 0 4px; }
  .mb-text .mb-sub { color: inherit; opacity: .75; font-size: 10px; }
  .bands-strip { display: flex; gap: 4px; flex-wrap: wrap; max-width: 60%; }
  .band-chip {
    background: white; border: 1px solid #fcd34d; border-radius: 5px;
    padding: 3px 6px; text-align: center;
    display: flex; flex-direction: column; gap: 1px;
    min-width: 48px;
  }
  .bc-fascia { font-size: 9px; font-weight: 700; color: #92400e; }
  .bc-km { font-size: 8px; color: #78716c; }
  .bc-price { font-size: 10px; font-weight: 700; color: #b45309; font-variant-numeric: tabular-nums; }
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
