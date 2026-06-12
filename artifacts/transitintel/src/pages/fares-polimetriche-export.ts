/**
 * FaresPolimetricheExport — esporta le polimetriche tariffarie in formato
 * "una linea per foglio A4 verticale", stile classico italiano (DGR Marche /
 * concessioni TPL): per ogni linea (route) viene generata una pagina con
 * intestazione, elenco fermate ordinate per percorrenza progressiva,
 * polimetrica triangolare tra zone tariffarie e legenda fasce.
 *
 * Pagina tipica (vista classica per zone):
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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MODALITÀ "POLIMETRICHE PER CLUSTER" (export usato dal tab Cluster Tariffari)
 * ─────────────────────────────────────────────────────────────────────────
 * Modello dati ed evoluzione del processo:
 *
 *  1. PROBLEMA INIZIALE
 *     Inizialmente per ogni linea generavamo UNA sola polimetrica cluster×cluster
 *     "unendo" tutti i trip della linea. Funzionava finché esisteva un trip che
 *     copriva l'intero percorso. Sulla linea B di Conerobus invece esistono
 *     trip strutturalmente diversi che NON si fondono in un percorso unico
 *     (51 fermate Ancona→Marina, 41 fermate Ancona→Montemarciano S.Pietro),
 *     quindi qualsiasi "union merge" produceva una linea sbagliata che
 *     terminava arbitrariamente a Marina o saltava Montemarciano.
 *
 *  2. SOLUZIONE — UNA PAGINA PER VARIANTE DI PERCORSO
 *     Backend: nuovo endpoint `/api/fares/min-od/route-variants/:routeId`
 *     (vedi `artifacts/api-server/src/routes/fares-min-od.ts`) che raggruppa
 *     i trip per SIGNATURE CANONICA `min(fwd_stop_ids, rev_stop_ids)`,
 *     unificando così automaticamente andata e ritorno (variante A↔B).
 *     Per ogni variante ritorna stops ordinati con km cumulato, cluster di
 *     appartenenza, capolinea, tripCount, e mappa stopsByZone.
 *
 *  3. RENDER — A3 PAESAGGIO, MATRICE FERMATA × FERMATA
 *     Frontend: `renderRouteVariantPage(...)` produce per OGNI variante una
 *     pagina A3 landscape con:
 *       • header con codice linea, capolinea, n. corse, km, n. fermate
 *       • legenda dei nodi tariffari attraversati (chip colorati)
 *       • chips delle fasce tariffarie applicate
 *       • polimetrica triangolare FERMATA × FERMATA (non più cluster×cluster):
 *         il prezzo della cella (i,j) è `priceForHops(|c_i − c_j| + 1)` dove
 *         c_i / c_j sono gli indici di cluster delle due fermate lungo la
 *         variante (modello "tratte per nodo" + cap a `hopBands.length`)
 *       • BARRA COLORE LATERALE 6px sulla colonna nome che cambia ad ogni
 *         transizione di cluster, in modo da rendere visivamente immediato
 *         "qui cambio nodo tariffario"
 *       • BORDI NERI sulle celle della matrice quando la coppia (i,j)
 *         attraversa un confine di cluster (`gboundary-t/l`, 2px #1e293b)
 *
 *  4. ORCHESTRAZIONE — `buildClustersHtml()`
 *     Carica in parallelo:
 *       • `loadClustersFull()`     — fermate per cluster + colore + mappa
 *       • `loadRouteVariants()`    — varianti di tutte le linee
 *       • `loadHopBands()`         — fasce tariffarie extra_fascia_*
 *     Genera la cover (logo, mappa SVG dei cluster, totali, fasce) e poi
 *     emette UNA pagina A3 per OGNI variante di OGNI linea, con paginazione
 *     coerente (`pag X / Y`).
 *
 *  5. CONDIVISIONE — `createPolimetricheClustersShareLink()`
 *     Costruisce l'HTML autonomo (logo embeddato come data-URI in CSS,
 *     iniettato UNA SOLA VOLTA per evitare crescita lineare del payload),
 *     POSTa su `/api/fares/polimetriche/snapshots` e ritorna `{ id, url }`
 *     pubblico. Il limite di payload del backend è 200MB (express.json) con
 *     guardia applicativa a 180MB sull'HTML grezzo.
 *
 *  6. PERFORMANCE / PAYLOAD
 *     L'HTML autonomo include solo:
 *       • CSS unico (`STYLES + CLUSTER_EXTRA_STYLES`)
 *       • logo embedded una volta (`img.cover-logo, img.r-brand-logo
 *         { content: url(...) }`)
 *       • markup ripetuto per N varianti (≈ N pagine A3)
 *     Su feed densi (≈ 200 varianti totali) il payload può raggiungere
 *     decine di MB. Se necessario in futuro, abilitare gzip lato client
 *     (`pako.gzip` → base64) e decompressione lato server.
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
  const zoningLabel = opts.zoningMethod ? (ZONING_LABEL[opts.zoningMethod] || opts.zoningMethod) : "—";
  return `
    <section class="page cover">
      <div class="cover-hero">
        <div class="cover-hero-bg"></div>
        <div class="cover-hero-content">
          <img class="cover-logo" src="/faresengine.png" alt="Fares Engine" />
          <div class="cover-product">Fares Engine</div>
          <div class="cover-kicker">Tariffario TPL · Documento ufficiale</div>
          <h1 class="cover-title">Polimetriche tariffarie</h1>
          <div class="cover-subtitle">Matrice origine → destinazione del biglietto ordinario, una pagina per linea</div>
        </div>
      </div>

      <div class="cover-meta">
        <div class="cm-row">
          <span class="cm-label">Agenzia</span>
          <span class="cm-value">${escape(opts.agencyName)}</span>
        </div>
        <div class="cm-row">
          <span class="cm-label">Data emissione</span>
          <span class="cm-value">${escape(opts.date)}</span>
        </div>
        <div class="cm-row">
          <span class="cm-label">Metodo zonizzazione</span>
          <span class="cm-value">${escape(zoningLabel)}</span>
        </div>
        <div class="cm-row">
          <span class="cm-label">Standard</span>
          <span class="cm-value">GTFS Fares V2 · DGR Marche n. 1036/2022</span>
        </div>
      </div>

      <div class="cover-kpis">
        <div class="ck-card">
          <div class="ck-num">${opts.routeCount}</div>
          <div class="ck-lbl">Linee</div>
        </div>
        <div class="ck-card">
          <div class="ck-num">${opts.areaCount}</div>
          <div class="ck-lbl">Zone tariffarie</div>
        </div>
        <div class="ck-card">
          <div class="ck-num">${opts.productCount}</div>
          <div class="ck-lbl">Prodotti tariffari</div>
        </div>
        <div class="ck-card ck-card-range">
          <div class="ck-num">€&thinsp;${fmtMoney(opts.minPrice)} – ${fmtMoney(opts.maxPrice)}</div>
          <div class="ck-lbl">Range prezzi</div>
        </div>
      </div>

      <div class="cover-toc-hint">
        Le pagine successive contengono una polimetrica per linea, in formato A3 orizzontale,
        con colore proporzionale al prezzo del biglietto e nomi delle fermate lungo l'ipotenusa.
      </div>

      <div class="cover-foot">
        <div class="cf-left">© ${new Date().getFullYear()} ${escape(opts.agencyName)} · Generato con Fares Engine</div>
        <div class="cf-right">${escape(opts.date)}</div>
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
  diagNameHeight: number;
  scale: "L" | "M" | "S" | "XS" | "XXS";
} {
  // A3 landscape: ~400mm utili in larghezza → ~1500px @ 96dpi.
  // Vincolo: 28 (rn-num) + nameWidth + N * cellSize ≤ ~1480px
  // diagNameHeight = altezza spacer in alto + spazio in cui può sforare il nome verticale
  if (n <= 20) return { cellSize: 38, cellFont: 13, headerFont: 13, nameWidth: 280, diagNameHeight: 200, scale: "L"   };
  if (n <= 30) return { cellSize: 30, cellFont: 11, headerFont: 12, nameWidth: 250, diagNameHeight: 180, scale: "M"   };
  if (n <= 45) return { cellSize: 22, cellFont: 9,  headerFont: 11, nameWidth: 220, diagNameHeight: 160, scale: "S"   };
  if (n <= 60) return { cellSize: 17, cellFont: 8,  headerFont: 10, nameWidth: 190, diagNameHeight: 140, scale: "XS"  };
  return            { cellSize: 12, cellFont: 7,  headerFont: 9,  nameWidth: 160, diagNameHeight: 120, scale: "XXS" };
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
  const lineColor = normalizeLineColor(sheet.routeColor);

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

  // ─── Mapping fermata → zona → indice nella legenda zone (per colore) ──
  // Allinea i colori della diagonale + badge numero a quelli della legenda zone in fondo.
  const areaIndexById = new Map<string, number>();
  sheet.routeAreas.forEach((a, idx) => areaIndexById.set(a.id, idx));
  const stopAreaIdx: number[] = stops.map(s => {
    const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
    if (!aid) return -1;
    return areaIndexById.get(aid) ?? -1;
  });
  const stopColor = (i: number): string => {
    if (stopAreaIdx[i] < 0) return lineColor;
    return groupColor(stopAreaIdx[i]);
  };

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
    const zc = stopColor(i);

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

    // Cella diagonale (j = i): tassello colorato zona con numero + nome verticale
    const diagBoundary = isGroupBoundary(i) ? " gboundary-l" : "";
    const diagCell = `
      <td class="diag${diagBoundary}" style="background:${zc}" title="${escape(from.stopName)}">
        <div class="diag-num">${i + 1}</div>
        <div class="diag-name">${escape(from.stopName)}</div>
      </td>`;

    // Celle vuote SOPRA la diagonale (j = i+1 … N-1) — tengono il grid stabile
    const emptyAfter = stops.slice(i + 1).map((_, k) => {
      const colJ = i + 1 + k;
      const cb = isGroupBoundary(colJ) ? " gboundary-l" : "";
      return `<td class="above-diag${cb}"></td>`;
    }).join("");

    return `
      <tr class="${rowBoundary}">
        <th class="rn-num" style="background:${zc}">${i + 1}</th>
        <th class="rn-name">
          <div class="rn-text" title="${escape(from.stopName)}">${escape(from.stopName)}</div>
          <div class="rn-meta">${from.progressiveKm.toFixed(1)} km${code ? ` · <span class="rn-zone" style="background:${zc}">${escape(code)}</span>` : ""}</div>
        </th>
        ${priceCells}
        ${diagCell}
        ${emptyAfter}
      </tr>
    `;
  }).join("");

  // ─── Banner descrittivo del modo tariffario ──
  const modeBanner = isUrban
    ? (() => {
        const flat = model.urbanFlatByNetwork.get(network);
        if (!flat) return `<div class="mode-banner urban">Rete urbana: tariffa flat (prodotto non identificato)</div>`;
        return `
          <div class="mode-banner urban">
            <span class="mb-icon">🎫</span>
            <span class="mb-text"><strong>Tariffa urbana flat</strong> · ${escape(flat.productName)} · <span class="mb-price">€ ${fmtMoney(flat.amount)}</span></span>
          </div>`;
      })()
    : (() => {
        const bands = model.extraBands;
        if (bands.length === 0) return `<div class="bands-block empty-block">Rete extraurbana: nessuna fascia tariffaria identificata.</div>`;
        const cards = bands.map(b => `
          <div class="band-card" title="Fascia ${b.fascia}: da ${b.kmFrom.toFixed(0)} a ${b.kmTo.toFixed(0)} km">
            <div class="bc-fascia">F${b.fascia}</div>
            <div class="bc-km">${b.kmFrom.toFixed(0)}–${b.kmTo.toFixed(0)}</div>
            <div class="bc-price">€${fmtMoney(b.price)}</div>
          </div>
        `).join("");
        return `
          <div class="bands-block">
            <div class="bb-head">
              <span class="bb-title">Tariffe extraurbane a fasce km</span>
              <span class="bb-sub">DGR Marche 1036/2022 · prezzo = f(distanza tra le fermate)</span>
            </div>
            <div class="bb-cards">${cards}</div>
          </div>`;
      })();

  // ─── Legenda colori prezzi ──
  const steps = 5;
  const legendCells = Array.from({ length: steps }, (_, i) => {
    const v = lMin + (lMax - lMin) * (i / Math.max(1, (steps - 1)));
    return `<div class="lg-cell" style="background:${priceColor(v, lMin, lMax)}">${fmtMoney(v)}</div>`;
  }).join("");

  // Spacer thead alto = spazio verticale per il nome diagonale del primo stop.
  // Per stop k>0 il nome può estendersi anche nei `above-diag` superiori; per k=0
  // serve invece un margine extra in cima alla tabella.
  return `
    ${modeBanner}
    <div class="matrix-wrap density-${d.scale}"
         style="--cs:${d.cellSize}px;--cf:${d.cellFont}px;--hf:${d.headerFont}px;--nw:${d.nameWidth}px;--dnh:${d.diagNameHeight}px">
      <table class="matrix">
        <colgroup>
          <col class="cg-num">
          <col class="cg-name">
          ${stops.map(() => `<col class="cg-cell">`).join("")}
        </colgroup>
        <thead>
          <tr class="diag-spacer">
            <th colspan="${stops.length + 2}" class="ds-cell"></th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <div class="matrix-legend">
        <div class="lg-title">Scala prezzi (€)</div>
        <div class="lg-bar">${legendCells}</div>
        <div class="lg-hint">${isUrban ? "rete urbana: tariffa flat (matrice volutamente uniforme)" : "colore proporzionale al prezzo · tratteggio = cambio di zona · diagonale colorata per zona"}</div>
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
          <div class="r-head-meta">
            <div class="r-network">${escape(networkLabel)}</div>
            <div class="r-pageno">pag. ${idx} / ${total}</div>
          </div>
          <img class="r-brand-logo" src="/faresengine.png" alt="Fares Engine" />
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

/* ──────────────────────────────────────────────────────────
 * VERSIONE SEMPLIFICATA — Polimetrica per nodi tariffari
 *
 * Invece della matrice fermata × fermata, costruisce una matrice
 * (più piccola e leggibile) zona × zona, con etichette tariffarie
 * T1, T2, … al posto del prezzo in €. La legenda T1 → € appare in
 * fondo alla pagina.
 * ──────────────────────────────────────────────────────── */

interface TariffMap {
  /** Mappa "prezzo arrotondato (cents)" → label T<n> */
  byCents: Map<number, string>;
  /** Lista ordinata per costruire la legenda */
  list: { label: string; price: number }[];
}

function buildTariffMap(model: PriceModel): TariffMap {
  const cents = new Set<number>();
  for (const v of model.urbanFlatByNetwork.values()) {
    if (v.amount > 0) cents.add(Math.round(v.amount * 100));
  }
  for (const b of model.extraBands) {
    if (b.price > 0) cents.add(Math.round(b.price * 100));
  }
  const sorted = [...cents].sort((a, b) => a - b);
  const byCents = new Map<number, string>();
  const list: { label: string; price: number }[] = [];
  sorted.forEach((c, i) => {
    const label = `T${i + 1}`;
    byCents.set(c, label);
    list.push({ label, price: c / 100 });
  });
  return { byCents, list };
}

function tariffLabelFor(price: number, tariffs: TariffMap): string {
  const c = Math.round(price * 100);
  return tariffs.byCents.get(c) ?? "—";
}

/* ──────────────────────────────────────────────────────────
 * Naming dei nodi tariffari basato sui nomi delle fermate
 * ──────────────────────────────────────────────────────── */

/** Ripulisce un nome fermata da parentesi/codici: "PIAZZA DEL POPOLO (cap.)" → "Piazza del Popolo" */
function cleanStopName(raw: string): string {
  let s = (raw || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  // Title case soft: prima lettera di ogni parola maiuscola se tutto upper
  if (s && s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/\b([a-zàèéìòù])/g, (m) => m.toUpperCase());
    // ma riporta minuscole le congiunzioni/articoli
    s = s.replace(/\b(Di|Del|Della|Dei|Degli|Delle|Da|Al|Allo|Alla|E|Il|La|Lo|I|Gli|Le|In|Su|Sul|Sulla)\b/g, (m) => m.toLowerCase());
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

/**
 * Trova il prefisso comune (a livello di parole intere) tra una lista di nomi.
 * Ritorna stringa vuota se troppo corto o se è solo una parola tipo "Via"/"Piazza".
 */
function commonPrefix(names: string[]): string {
  if (names.length < 2) return "";
  const tokenized = names.map(n => n.split(/\s+/));
  const minLen = Math.min(...tokenized.map(t => t.length));
  const out: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const w = tokenized[0][i];
    if (tokenized.every(t => t[i].toLowerCase() === w.toLowerCase())) {
      out.push(w);
    } else break;
  }
  if (out.length === 0) return "";
  // Scarta prefissi banali di una parola se è un toponimo generico
  const trivial = new Set(["via", "viale", "corso", "piazza", "largo", "strada", "stazione", "fermata"]);
  if (out.length === 1 && trivial.has(out[0].toLowerCase())) return "";
  // Lunghezza minima sensata
  const joined = out.join(" ");
  if (joined.length < 4) return "";
  return joined;
}

interface ZoneNaming {
  /** Nome principale della zona (derivato dalle fermate) */
  primary: string;
  /** Lista nomi fermate (ordinate per km), già puliti */
  stops: string[];
}

function buildZoneNamings(sheet: RouteSheet, model: PriceModel): Map<string, ZoneNaming> {
  const out = new Map<string, ZoneNaming>();
  for (const z of sheet.routeAreas) {
    const inZone = sheet.stops
      .filter(s => {
        const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
        return aid === z.id;
      })
      .sort((a, b) => a.progressiveKm - b.progressiveKm);
    const stopNames = inZone.map(s => cleanStopName(s.stopName));
    let primary: string;
    if (stopNames.length === 0) {
      primary = z.name;
    } else if (stopNames.length === 1) {
      primary = stopNames[0];
    } else if (stopNames.length === 2) {
      const cp = commonPrefix(stopNames);
      primary = cp || `${stopNames[0]} · ${stopNames[1]}`;
    } else {
      const cp = commonPrefix(stopNames);
      primary = cp || `${stopNames[0]} → ${stopNames[stopNames.length - 1]}`;
    }
    out.set(z.id, { primary, stops: stopNames });
  }
  return out;
}

/** Ritorna km medio (centro) di una zona lungo la linea */
function zoneCenterKm(zoneId: string, sheet: RouteSheet, model: PriceModel): number {
  const inZone = sheet.stops.filter(s => {
    const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
    return aid === zoneId;
  });
  if (inZone.length === 0) return 0;
  return inZone.reduce((a, s) => a + s.progressiveKm, 0) / inZone.length;
}

function renderZoneMatrix(sheet: RouteSheet, model: PriceModel, tariffs: TariffMap): string {
  const zones = sheet.routeAreas;
  if (zones.length < 2) {
    return `<div class="empty">Linea con una sola zona tariffaria (${zones.length}): polimetrica per zone non significativa.</div>`;
  }
  const network = sheet.networkId || "";
  const isUrban = /^urbano_/i.test(network);
  const lineColor = normalizeLineColor(sheet.routeColor);

  // km medio per ogni zona (per il calcolo Δkm tra zone in extraurbano)
  const zoneKm = zones.map(z => zoneCenterKm(z.id, sheet, model));

  // Naming derivato dalle fermate
  const namings = buildZoneNamings(sheet, model);
  const labelOf = (zid: string) => namings.get(zid)?.primary ?? "";
  const stopsOf = (zid: string) => namings.get(zid)?.stops ?? [];

  // Densità: zone sono molte meno delle fermate, quindi cellule più grandi
  const n = zones.length;
  const cellSize = n <= 6 ? 56 : n <= 10 ? 48 : n <= 16 ? 40 : 34;
  const cellFont = n <= 6 ? 16 : n <= 10 ? 14 : n <= 16 ? 12 : 11;
  const headerFont = cellFont + 1;
  const nameWidth = 240;
  const diagNameHeight = 110;

  // Matrice: lookup prezzo zona-zona
  type ZCell = { price: number; label: string; fascia: number | null; deltaKm: number } | null;
  const matrix: ZCell[][] = zones.map((from, i) =>
    zones.map((to, j) => {
      if (j >= i) return null;
      let price: number, fascia: number | null = null, deltaKm = 0;
      if (isUrban) {
        const flat = model.urbanFlatByNetwork.get(network);
        if (!flat) return null;
        price = flat.amount;
      } else {
        deltaKm = Math.abs(zoneKm[i] - zoneKm[j]);
        const band = bandForDeltaKm(deltaKm, model.extraBands);
        if (!band) return null;
        price = band.price;
        fascia = band.fascia;
      }
      return { price, label: tariffLabelFor(price, tariffs), fascia, deltaKm };
    })
  );

  // Range tariffe per heatmap colore (sul prezzo, ma mostriamo Tn)
  let lMin = Infinity, lMax = -Infinity;
  for (const row of matrix) for (const c of row) {
    if (c) { if (c.price < lMin) lMin = c.price; if (c.price > lMax) lMax = c.price; }
  }
  if (!isFinite(lMin)) { lMin = 0; lMax = 0; }

  const rows = zones.map((from, i) => {
    const zc = groupColor(i);
    const fromLabel = labelOf(from.id) || from.name;
    const fromStops = stopsOf(from.id);
    const priceCells = zones.slice(0, i).map((to, j) => {
      const c = matrix[i][j];
      if (c == null) return `<td class="na" title="N/D">–</td>`;
      const bg = priceColor(c.price, lMin, lMax);
      const toLabel = labelOf(to.id) || to.name;
      const tip = `${escape(fromLabel)} → ${escape(toLabel)} : ${c.label} (€ ${fmtMoney(c.price)})` +
                  (c.fascia ? ` · F${c.fascia} (${c.deltaKm.toFixed(1)} km)` : "");
      return `<td class="cell tariff-cell" style="background:${bg}" title="${tip}">${escape(c.label)}</td>`;
    }).join("");

    const diagCell = `
      <td class="diag" style="background:${zc}" title="${escape(fromLabel)}${fromStops.length > 1 ? ` (${fromStops.length} fermate)` : ""}">
        <div class="diag-num">${i + 1}</div>
        <div class="diag-name">${escape(fromLabel)}</div>
      </td>`;

    const emptyAfter = zones.slice(i + 1).map(() => `<td class="above-diag"></td>`).join("");

    // Lista fermate in piccolo (max 4 visibili, poi "+N")
    const stopsPreview = fromStops.length > 0 ? (() => {
      const max = 4;
      const shown = fromStops.slice(0, max).map(n => escape(n)).join(" · ");
      const extra = fromStops.length > max ? ` <span class="rn-more">+${fromStops.length - max}</span>` : "";
      return `<div class="rn-stops" title="${escape(fromStops.join(' · '))}">${shown}${extra}</div>`;
    })() : "";

    return `
      <tr>
        <th class="rn-num" style="background:${zc}">${escape(from.code)}</th>
        <th class="rn-name">
          <div class="rn-text" title="${escape(fromLabel)}">${escape(fromLabel)}</div>
          ${stopsPreview}
          <div class="rn-meta">~ ${zoneKm[i].toFixed(1)} km · ${fromStops.length} ferm. · ${escape(from.code)}</div>
        </th>
        ${priceCells}
        ${diagCell}
        ${emptyAfter}
      </tr>
    `;
  }).join("");

  // Legenda tariffe T1 → €
  const tariffLegend = tariffs.list.map(t => {
    const bg = priceColor(t.price, lMin, lMax);
    return `
      <div class="tariff-item">
        <div class="tariff-pill" style="background:${bg}">${escape(t.label)}</div>
        <div class="tariff-price">€ ${fmtMoney(t.price)}</div>
      </div>`;
  }).join("");

  const modeBanner = isUrban
    ? (() => {
        const flat = model.urbanFlatByNetwork.get(network);
        const lbl = flat ? tariffLabelFor(flat.amount, tariffs) : "—";
        return `<div class="mode-banner urban">
          <span class="mb-icon">🎫</span>
          <span class="mb-text"><strong>Tariffa urbana flat</strong> · una sola tariffa <strong>${escape(lbl)}</strong>${flat ? ` · € ${fmtMoney(flat.amount)}` : ""}</span>
        </div>`;
      })()
    : `<div class="mode-banner extra">
        <span class="mb-icon">🗺️</span>
        <span class="mb-text"><strong>Rete extraurbana a fasce</strong> · prezzo determinato dalla distanza tra i nodi tariffari (centri zona)</span>
      </div>`;

  return `
    ${modeBanner}
    <div class="matrix-wrap density-L"
         style="--cs:${cellSize}px;--cf:${cellFont}px;--hf:${headerFont}px;--nw:${nameWidth}px;--dnh:${diagNameHeight}px">
      <table class="matrix">
        <colgroup>
          <col class="cg-num">
          <col class="cg-name">
          ${zones.map(() => `<col class="cg-cell">`).join("")}
        </colgroup>
        <thead>
          <tr class="diag-spacer">
            <th colspan="${zones.length + 2}" class="ds-cell"></th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>

      <div class="tariff-legend">
        <div class="tl-title">Legenda tariffe</div>
        <div class="tl-grid">${tariffLegend}</div>
        <div class="tl-hint">T1 = tariffa più bassa · Tn = più alta · colore proporzionale al prezzo</div>
      </div>
    </div>
  `;
}

function renderRoutePageZones(sheet: RouteSheet, model: PriceModel, tariffs: TariffMap, idx: number, total: number): string {
  const networkLabel = sheet.networkId ? (NETWORK_LABEL[sheet.networkId] || sheet.networkId) : "—";
  const lineColor = normalizeLineColor(sheet.routeColor);
  const zoneCount = sheet.routeAreas.length;
  const stopCount = sheet.stops.length;
  const tariffePossibili = zoneCount > 1 ? Math.round(zoneCount * (zoneCount - 1) / 2) : 0;

  const namings = buildZoneNamings(sheet, model);
  const zoneLegend = sheet.routeAreas.map((a, i) => {
    const stopsInZone = sheet.stops.filter(s => {
      const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
      return aid === a.id;
    });
    const kmStart = stopsInZone[0]?.progressiveKm ?? 0;
    const kmEnd = stopsInZone[stopsInZone.length - 1]?.progressiveKm ?? 0;
    const zc = groupColor(i);
    const naming = namings.get(a.id);
    const primary = naming?.primary ?? a.name;
    const stopList = naming?.stops ?? [];
    const stopsHtml = stopList.length > 0
      ? `<div class="zstops" title="${escape(stopList.join(' · '))}">${stopList.map(n => escape(n)).join(" · ")}</div>`
      : "";
    return `
      <div class="zone-item" style="border-left:4px solid ${zc};background:${groupColorSoft(i)}">
        <div class="zbadge" style="background:${zc}">${escape(a.code)}</div>
        <div class="zinfo">
          <div class="zname">${escape(primary)}</div>
          ${stopsHtml}
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
            ${sheet.longName ? `<div class="r-subtitle">${escape(sheet.longName)} · <em>vista semplificata per nodi</em></div>` : `<div class="r-subtitle"><em>vista semplificata per nodi tariffari</em></div>`}
          </div>
        </div>
        <div class="r-head-right">
          <div class="r-head-meta">
            <div class="r-network">${escape(networkLabel)}</div>
            <div class="r-pageno">pag. ${idx} / ${total}</div>
          </div>
          <img class="r-brand-logo" src="/faresengine.png" alt="Fares Engine" />
        </div>
      </header>

      <div class="r-kpis">
        <div class="r-kpi"><div class="rk-num">${sheet.totalKm.toFixed(1)}</div><div class="rk-lbl">km totali</div></div>
        <div class="r-kpi"><div class="rk-num">${zoneCount}</div><div class="rk-lbl">nodi tariffari</div></div>
        <div class="r-kpi"><div class="rk-num">${stopCount}</div><div class="rk-lbl">fermate raggruppate</div></div>
        <div class="r-kpi"><div class="rk-num">${tariffePossibili}</div><div class="rk-lbl">coppie O/D zone</div></div>
      </div>

      <h3 class="r-section-title">
        Polimetrica zona × zona
        <span class="hint">tariffa applicata tra nodi tariffari · etichetta T<sub>n</sub> = livello tariffa (legenda in fondo)</span>
      </h3>

      ${renderZoneMatrix(sheet, model, tariffs)}

      ${zoneCount > 0 ? `
        <h3 class="r-section-title legend-title">Nodi tariffari (raggruppano le fermate)</h3>
        <div class="zones-legend">${zoneLegend}</div>
      ` : ""}

      <footer class="r-foot">
        <div>Linea <strong>${escape(sheet.shortName)}</strong> · ${escape(sheet.routeId)}</div>
        <div>GTFS Fares V2 · ${escape(networkLabel)} · vista per nodi</div>
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
  .page.cover { padding: 0; overflow: hidden; }
  .cover { display: flex; flex-direction: column; }

  /* Hero a tutta larghezza */
  .cover-hero {
    position: relative;
    background: linear-gradient(135deg, #0f766e 0%, #134e4a 50%, #0f172a 100%);
    color: white;
    padding: 22mm 18mm 18mm;
    overflow: hidden;
  }
  .cover-hero-bg {
    position: absolute; inset: 0;
    background:
      radial-gradient(circle at 80% 20%, rgba(16, 185, 129, .25), transparent 50%),
      radial-gradient(circle at 10% 90%, rgba(14, 165, 233, .18), transparent 55%);
    pointer-events: none;
  }
  .cover-hero-content { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 4px; }
  .cover-logo {
    height: 56px; width: auto;
    margin-bottom: 14px;
    filter: brightness(0) invert(1);
    object-fit: contain;
  }
  .cover-product {
    font-size: 13px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 4px;
    color: #5eead4;
    margin-bottom: 18px;
  }
  .cover-kicker {
    font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
    color: rgba(255,255,255,.6);
    margin-bottom: 8px;
  }
  .cover-title {
    font-size: 52px; font-weight: 800; margin: 0 0 10px;
    letter-spacing: -1.5px; line-height: 1.05;
    color: white;
  }
  .cover-subtitle {
    font-size: 15px; color: rgba(255,255,255,.85);
    max-width: 130mm; line-height: 1.4;
  }

  /* Sezione meta (definition list) */
  .cover-meta {
    padding: 12mm 18mm 6mm;
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px;
  }
  .cover-meta .cm-row {
    display: flex; flex-direction: column; gap: 2px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e2e8f0;
  }
  .cover-meta .cm-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 1.5px;
    color: #94a3b8; font-weight: 600;
  }
  .cover-meta .cm-value {
    font-size: 13px; color: #0f172a; font-weight: 600;
  }

  /* KPI cards */
  .cover-kpis {
    padding: 6mm 18mm;
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
  }
  .cover-kpis .ck-card {
    border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 12px;
    text-align: center;
    background: linear-gradient(180deg, #ffffff, #f8fafc);
    box-shadow: 0 1px 3px rgba(15, 23, 42, .04);
  }
  .cover-kpis .ck-card-range { grid-column: span 1; }
  .cover-kpis .ck-num {
    font-size: 26px; font-weight: 800; color: #0f766e;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .cover-kpis .ck-card-range .ck-num { font-size: 18px; }
  .cover-kpis .ck-lbl {
    font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
    color: #64748b; margin-top: 6px; font-weight: 600;
  }

  .cover-toc-hint {
    margin: 4mm 18mm 0;
    padding: 10px 14px;
    background: #f0fdfa;
    border-left: 3px solid #14b8a6;
    border-radius: 4px;
    font-size: 11px;
    color: #134e4a;
    line-height: 1.5;
  }

  .cover-foot {
    margin-top: auto;
    padding: 8mm 18mm;
    border-top: 1px solid #e2e8f0;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 10px; color: #94a3b8;
  }
  .cover-foot .cf-right { font-variant-numeric: tabular-nums; }

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
  .r-head-right {
    display: flex; align-items: center; gap: 10px;
    text-align: right;
  }
  .r-head-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .r-brand-logo {
    height: 36px; width: auto;
    object-fit: contain;
    flex-shrink: 0;
    opacity: .95;
  }
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
    /* lascia overflow visibile per i nomi diagonali rotati */
    overflow: visible;
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

  /* Spacer in cima: dà spazio al nome verticale del primo stop diagonale */
  table.matrix thead tr.diag-spacer th.ds-cell {
    height: var(--dnh);
    border: 0;
    background: transparent;
    padding: 0;
  }

  /* Colonna numero progressivo (leftmost) — colorata con la zona */
  table.matrix th.rn-num {
    background: var(--line-color); /* fallback se non c'è zona */
    color: white;
    font-weight: 800; font-size: var(--hf);
    border: 1px solid rgba(0,0,0,.08);
  }

  /* Colonna nome fermata (sinistra, larga) */
  table.matrix th.rn-name {
    background: #f8fafc;
    text-align: left;
    padding: 3px 8px;
    line-height: 1.15;
    font-weight: 600;
    color: #1e293b;
    overflow: hidden;
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
  /* Lista delle fermate del nodo, riga sotto il nome principale */
  table.matrix th.rn-name .rn-stops {
    font-size: calc(var(--hf) - 3px);
    color: #475569;
    font-weight: 400;
    line-height: 1.2;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-style: italic;
  }
  table.matrix th.rn-name .rn-stops .rn-more {
    color: #94a3b8;
    font-weight: 600;
    font-style: normal;
  }
  table.matrix th.rn-name .rn-zone {
    color: white;
    padding: 0 5px; border-radius: 3px;
    font-weight: 700; font-size: calc(var(--hf) - 3px);
    margin-left: 2px;
  }

  /* Celle prezzo (sotto la diagonale) */
  table.matrix td.cell {
    font-weight: 600; color: #0f172a;
  }

  /* DIAGONALE: tassello colorato per zona, numero in basso, nome verticale che
     si estende verso l'alto sforando nelle celle above-diag superiori. */
  table.matrix td.diag {
    position: relative;
    overflow: visible;
    vertical-align: bottom;
    background: var(--line-color);
    border: 1px solid rgba(0,0,0,.12);
  }
  table.matrix td.diag .diag-num {
    height: var(--cs);
    line-height: var(--cs);
    color: white;
    font-weight: 800;
    font-size: calc(var(--cf) + 1px);
    text-shadow: 0 1px 1px rgba(0,0,0,.25);
  }
  table.matrix td.diag .diag-name {
    position: absolute;
    /* Ancorato POCO OLTRE l'angolo top-right della cella diagonale, in modo
       da staccarsi visibilmente dal quadratino col numero. Il testo parte da lì
       e sale verso destra a 45° dentro il triangolo bianco sopra la diagonale. */
    bottom: calc(var(--cs) + 12px);
    left: calc(var(--cs) + 16px);
    height: 1em;
    line-height: 1em;
    transform: rotate(-45deg);
    transform-origin: bottom left;
    text-align: left;
    padding-left: 0;
    font-size: calc(var(--hf) - 2px);
    font-weight: 600;
    color: #0f172a;
    white-space: nowrap;
    overflow: visible;
    pointer-events: none;
    z-index: 2;
  }

  /* Sopra la diagonale: visivamente vuoto (lascia spazio ai nomi rotati) */
  table.matrix td.above-diag {
    background: transparent;
    border-color: transparent;
  }
  table.matrix td.na {
    background: #fafafa; color: #cbd5e1;
  }

  /* densità XS/XXS: nascondi km in metadati riga per stare in pagina */
  .density-XS table.matrix th.rn-name .rn-meta,
  .density-XXS table.matrix th.rn-name .rn-meta { display: none; }

  /* ─── Confini di zona: righe TRATTEGGIATE leggere (no colori invadenti) ─── */
  table.matrix .gboundary-l { border-left: 1.5px dashed #94a3b8 !important; }
  table.matrix tr.gboundary-t > * { border-top: 1.5px dashed #94a3b8 !important; }
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
  .zstops {
    font-size: 7.5px; color: #64748b; font-style: italic;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-top: 1px;
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

  /* ─── Banner modo tariffario URBANO (riga unica, lineare) ─── */
  .mode-banner {
    display: flex; align-items: center; gap: 10px;
    padding: 5px 10px; border-radius: 6px;
    margin-bottom: 6px;
    border: 1px solid;
    font-size: 10px;
    line-height: 1.3;
  }
  .mode-banner.urban { background: #eff6ff; border-color: #bfdbfe; color: #1e40af; }
  .mb-icon { font-size: 13px; flex-shrink: 0; }
  .mb-text { flex-shrink: 0; }
  .mb-text strong { font-size: 11px; }
  .mb-text .mb-price { font-weight: 800; font-size: 12px; margin-left: 2px; }

  /* ─── Blocco fasce extraurbane (titolo + griglia di mini-card) ─── */
  .bands-block {
    margin-bottom: 6px;
    padding: 4px 6px 6px;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    background: #fafbfc;
  }
  .bands-block.empty-block {
    color: #94a3b8; font-style: italic; font-size: 10px; padding: 8px;
  }
  .bands-block .bb-head {
    display: flex; align-items: baseline; gap: 8px;
    padding: 0 2px 4px;
    border-bottom: 1px solid #eef2f6;
    margin-bottom: 4px;
  }
  .bands-block .bb-title {
    font-size: 10px; font-weight: 700; color: #1e293b;
    text-transform: uppercase; letter-spacing: .5px;
  }
  .bands-block .bb-sub {
    font-size: 9px; color: #94a3b8; font-style: italic;
  }
  .bands-block .bb-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(54px, 1fr));
    gap: 3px;
  }
  .bands-block .band-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    padding: 3px 4px;
    text-align: center;
    display: flex; flex-direction: column; gap: 0;
    line-height: 1.1;
  }
  .bands-block .band-card .bc-fascia {
    font-size: 9px; font-weight: 800; color: #92400e;
    letter-spacing: .3px;
  }
  .bands-block .band-card .bc-km {
    font-size: 8px; color: #64748b;
    font-variant-numeric: tabular-nums;
  }
  .bands-block .band-card .bc-price {
    font-size: 10px; font-weight: 800; color: #0f172a;
    font-variant-numeric: tabular-nums;
    margin-top: 1px;
  }

  /* ─── Vista semplificata: tariffa label nelle celle + legenda T1..Tn ─── */
  td.cell.tariff-cell {
    font-weight: 800;
    letter-spacing: 0.3px;
    color: #0f172a;
  }
  .tariff-legend {
    margin-top: 14px;
    padding: 12px 14px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
  }
  .tariff-legend .tl-title {
    font-size: 11px; font-weight: 800; text-transform: uppercase;
    letter-spacing: 0.6px; color: #475569; margin-bottom: 8px;
  }
  .tariff-legend .tl-grid {
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .tariff-legend .tariff-item {
    display: flex; align-items: center; gap: 6px;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 4px 8px 4px 4px;
  }
  .tariff-legend .tariff-pill {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 32px; height: 24px;
    padding: 0 6px;
    border-radius: 6px;
    font-size: 11px; font-weight: 800;
    color: #0f172a;
  }
  .tariff-legend .tariff-price {
    font-size: 12px; font-weight: 700; color: #0f172a;
    font-variant-numeric: tabular-nums;
  }
  .tariff-legend .tl-hint {
    font-size: 9px; color: #64748b; margin-top: 6px;
  }
  .mode-banner.extra {
    background: linear-gradient(90deg, #ecfdf5, #d1fae5);
    border-color: #6ee7b7;
    color: #065f46;
  }
`;

/* ──────────────────────────────────────────────────────────
 * Entry point
 * ──────────────────────────────────────────────────────── */

/**
 * Carica il logo `/faresengine.png` dall'origine corrente e lo converte
 * in data URI base64 così l'HTML resta auto-contenuto anche quando
 * viene servito da un'origine diversa (es. backend Render per i link
 * condivisibili).
 */
async function loadLogoDataUri(): Promise<string | null> {
  try {
    const res = await fetch("/faresengine.png");
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface PolimetricheBuildResult {
  html: string;
  agencyName: string;
  date: string;
  routeCount: number;
  productCount: number;
  areaCount: number;
  zoningMethod?: PolimetricheInput["zoningMethod"];
}

/**
 * Costruisce l'HTML completo (auto-contenuto: CSS inline, dati embedded)
 * delle polimetriche, SENZA aprire alcuna finestra. Riutilizzato sia
 * dall'export verso `window.print()` sia dalla creazione di link condivisibili.
 *
 * @param mode "stops" (default) → matrice fermata×fermata col prezzo in €
 *             "zones" → matrice nodo×nodo con etichette T1, T2, …
 */
export async function buildPolimetricheHtml(
  input: PolimetricheInput,
  mode: "stops" | "zones" = "stops",
): Promise<PolimetricheBuildResult> {
  const agencyName = input.agencyName || "Conerobus · Trasporto Pubblico Locale";
  const date = input.date || new Date().toLocaleDateString("it-IT");

  // 1) Costruisci modello prezzi dai CSV
  const model = buildPriceModel(input.files);
  const tariffs = buildTariffMap(model);

  // 2) Recupera elenco linee
  const routes = await apiFetch<RouteNetworkRow[]>("/api/fares/route-networks");
  if (!routes || routes.length === 0) {
    throw new Error("Nessuna linea trovata. Verifica che il feed GTFS sia caricato.");
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
  const pages = mode === "zones"
    ? sheets.map((s, i) => renderRoutePageZones(s, model, tariffs, i + 1, sheets.length)).join("")
    : sheets.map((s, i) => renderRoutePage(s, model, i + 1, sheets.length)).join("");

  const titleSuffix = mode === "zones" ? " — vista per nodi tariffari" : "";
  const headerSuffix = mode === "zones" ? " · per nodi" : "";

  // Carica il logo come data URI in modo che l'HTML sia auto-contenuto
  // (necessario per i link condivisibili serviti dal backend).
  // IMPORTANTE: lo iniettiamo UNA SOLA VOLTA dentro <style> via `content: url(...)`,
  // altrimenti — se lo duplicassimo in ogni <img src="..."> — il payload
  // crescerebbe linearmente col numero di linee (cover + N pagine) e potrebbe
  // superare i limiti del backend (request entity too large).
  const logoDataUri = await loadLogoDataUri();
  const logoCss = logoDataUri
    ? `\nimg.cover-logo, img.r-brand-logo { content: url("${logoDataUri}"); }\n`
    : "";

  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>Polimetriche tariffarie${titleSuffix} — ${escape(agencyName)} — ${escape(date)}</title>
  <style>${STYLES}${logoCss}</style>
</head>
<body>
  <div class="toolbar">
    <h1>📊 Polimetriche tariffarie${headerSuffix} · ${escape(agencyName)} · ${sheets.length} linee</h1>
    <div>
      <button onclick="window.print()">🖨️ Stampa / Salva PDF</button>
    </div>
  </div>
  ${cover}
  ${pages}
</body>
</html>`;

  return {
    html,
    agencyName,
    date,
    routeCount: sheets.length,
    productCount,
    areaCount,
    zoningMethod: input.zoningMethod,
  };
}

export async function exportPolimetricheToPrint(input: PolimetricheInput): Promise<void> {
  return openPolimetricheWindow(input, "stops");
}

/**
 * Variante semplificata: matrice nodo × nodo con etichette T1, T2, …
 */
export async function exportPolimetricheZonesToPrint(input: PolimetricheInput): Promise<void> {
  return openPolimetricheWindow(input, "zones");
}

async function openPolimetricheWindow(input: PolimetricheInput, mode: "stops" | "zones"): Promise<void> {
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
    <body><div class="l"><div class="s"></div><p>Costruzione polimetriche tariffarie${mode === "zones" ? " (per nodi)" : ""}…</p></div></body></html>
  `);

  try {
    const { html } = await buildPolimetricheHtml(input, mode);
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

/**
 * Genera un link pubblico condivisibile alle polimetriche tariffarie.
 * Costruisce l'HTML autonomo, lo salva sul backend e ritorna `{ id, url }`.
 */
export async function createPolimetricheShareLink(input: PolimetricheInput): Promise<{
  id: string;
  url: string;
  routeCount: number;
}> {
  return createShareLinkInternal(input, "stops", "Polimetriche");
}

/**
 * Variante semplificata: link condivisibile alla vista per nodi tariffari.
 */
export async function createPolimetricheZonesShareLink(input: PolimetricheInput): Promise<{
  id: string;
  url: string;
  routeCount: number;
}> {
  return createShareLinkInternal(input, "zones", "Polimetriche per nodi");
}

async function createShareLinkInternal(
  input: PolimetricheInput,
  mode: "stops" | "zones",
  titlePrefix: string,
): Promise<{ id: string; url: string; routeCount: number }> {
  const built = await buildPolimetricheHtml(input, mode);
  const res = await apiFetch<{ id: string; url: string; createdAt: string }>(
    "/api/fares/polimetriche/snapshots",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html: built.html,
        title: `${titlePrefix} · ${built.agencyName} · ${built.date}`,
        agencyName: built.agencyName,
        zoningMethod: built.zoningMethod,
        routeCount: built.routeCount,
        productCount: built.productCount,
        areaCount: built.areaCount,
        meta: { date: built.date, mode },
      }),
    },
  );
  return { id: res.id, url: res.url, routeCount: built.routeCount };
}

/* ══════════════════════════════════════════════════════════════
 * MIN-OD — Polimetriche con tariffa minima dal grafo di rete
 * Per ogni linea, costruisce la matrice zona×zona usando i prezzi
 * della matrice OD globale (Dijkstra all-pairs sui cluster).
 * ════════════════════════════════════════════════════════════ */

interface MinOdRoutePolimetrica {
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  totalKm: number;
  stops: { stopId: string; stopName: string; kmFromStart: number; clusterId: string | null; clusterName: string | null }[];
  zones: { clusterId: string; clusterName: string; label: string }[];
  /** Per ogni cluster (key = clusterId), elenco fermate della linea in quel nodo, in ordine di percorrenza. */
  stopsByZone?: Record<string, { stopId: string; stopName: string }[]>;
  matrix: (number | null)[][];
  kmMatrix: (number | null)[][];
  fasciaMatrix: (number | null)[][];
}

/* ───────────────────────────────────────────────────────────────────────
   VARIANTI DI PERCORSO (nuovo modello)
   Una linea può avere N varianti di percorso (es. linea B = Ancona↔Marina,
   Ancona↔Montemarciano, ecc.). A↔B viene unificata in una sola variante.
   Per ogni variante stampiamo una polimetrica fermata × fermata con barra
   colore laterale = nodo tariffario.
   ─────────────────────────────────────────────────────────────────────── */
interface RouteVariant {
  variantId: string;
  order: number;
  tripCount: number;
  forwardCount: number;
  reverseCount: number;
  firstStopName: string;
  lastStopName: string;
  totalKm: number;
  stops: { stopId: string; stopName: string; kmFromStart: number; clusterId: string | null; clusterName: string | null }[];
  zones: { clusterId: string; clusterName: string; label: string }[];
  stopsByZone: Record<string, { stopId: string; stopName: string }[]>;
}
interface RouteVariantsResp {
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  variantCount: number;
  tripCountTotal: number;
  variants: RouteVariant[];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderMinOdRoutePage(p: MinOdRoutePolimetrica, agencyName: string, date: string, mode: "stops" | "zones" = "stops"): string {
  const N = p.zones.length;
  if (N === 0) {
    return `<section class="page"><h2>${escapeHtml(p.routeShortName ?? p.routeId)}</h2><p class="empty">Nessun cluster sul percorso dominante.</p></section>`;
  }

  const headerCols = p.zones.map(z => `<th>${escapeHtml(z.label)}<span class="zname-h">${escapeHtml(z.clusterName)}</span></th>`).join("");
  const rows = p.zones.map((z, i) => {
    const cells = p.zones.map((_, j) => {
      if (j < i) return `<td class="empty">—</td>`;
      const price = p.matrix[i][j];
      const km = p.kmMatrix[i][j];
      const fa = p.fasciaMatrix[i][j];
      if (price === null) return `<td class="empty">·</td>`;
      const tip = km !== null ? ` title="${km.toFixed(1)} km · F${fa ?? "?"}"` : "";
      return `<td${tip}><strong>€${price.toFixed(2)}</strong>${km !== null ? `<span class="km">${km.toFixed(1)}km</span>` : ""}</td>`;
    }).join("");
    return `<tr><th class="row-h">${escapeHtml(z.label)} <span class="zname">${escapeHtml(z.clusterName)}</span></th>${cells}</tr>`;
  }).join("");

  const title = p.routeShortName ? `Linea ${escapeHtml(p.routeShortName)}` : escapeHtml(p.routeId);
  const subtitle = p.routeLongName ? escapeHtml(p.routeLongName) : "";
  const legend = `<p class="legend">
    <strong>Metodo Min-OD:</strong> per ogni coppia di nodi della linea, il prezzo è il <em>cammino minimo in km</em>
    nella rete tariffaria intera (Dijkstra sui cluster). Se un'altra linea collega gli stessi nodi con percorso più
    corto, viene applicata la sua fascia DGR Marche. Replica logica polimetriche storiche ATMA/Conerobus 2013.
  </p>`;

  // ── Modalità "zones" (NODI) — solo polimetrica grande, no elenco fermate ──
  if (mode === "zones") {
    return `
<section class="page page-zones">
  <header class="page-h">
    <div>
      <h2>${title}</h2>
      ${subtitle ? `<p class="sub">${subtitle}</p>` : ""}
    </div>
    <div class="meta">
      <span><strong>${p.totalKm.toFixed(1)}</strong> km</span>
      <span><strong>${N}</strong> nodi tariffari</span>
    </div>
  </header>

  <h3>Polimetrica nodo × nodo (€) — tariffa minima via grafo</h3>
  <table class="poli poli-big">
    <thead><tr><th></th>${headerCols}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${legend}

  <footer class="foot">${escapeHtml(agencyName)} · ${escapeHtml(date)} · ${escapeHtml(p.routeId)} · ${N}×${N} nodi</footer>
</section>`;
  }

  // ── Modalità "stops" (default) — elenco fermate + matrice ──
  const stopRows = p.stops.map((s, i) => {
    const zone = p.zones.find(z => z.clusterId === s.clusterId);
    return `<tr>
      <td class="num">${i + 1}</td>
      <td>${escapeHtml(s.stopName)}</td>
      <td class="num">${s.kmFromStart.toFixed(2)}</td>
      <td class="zone">${zone ? `<span class="badge">${zone.label}</span>` : `<span class="muted">—</span>`}</td>
    </tr>`;
  }).join("");

  return `
<section class="page">
  <header class="page-h">
    <div>
      <h2>${title}</h2>
      ${subtitle ? `<p class="sub">${subtitle}</p>` : ""}
    </div>
    <div class="meta">
      <span><strong>${p.totalKm.toFixed(1)}</strong> km</span>
      <span><strong>${p.stops.length}</strong> ferm.</span>
      <span><strong>${N}</strong> zone</span>
    </div>
  </header>

  <div class="two-col">
    <div class="col-left">
      <h3>Elenco fermate</h3>
      <table class="stops">
        <thead><tr><th>#</th><th>Fermata</th><th>km</th><th>Zona</th></tr></thead>
        <tbody>${stopRows}</tbody>
      </table>
    </div>
    <div class="col-right">
      <h3>Polimetrica zonale (€) — tariffa minima via grafo</h3>
      <table class="poli">
        <thead><tr><th></th>${headerCols}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${legend}
    </div>
  </div>

  <footer class="foot">${escapeHtml(agencyName)} · ${escapeHtml(date)} · ${escapeHtml(p.routeId)}</footer>
</section>`;
}

function renderMinOdHtml(routes: MinOdRoutePolimetrica[], agencyName: string, date: string, mode: "stops" | "zones" = "stops"): string {
  const pages = routes.map(r => renderMinOdRoutePage(r, agencyName, date, mode)).join("\n");
  const subtitle = mode === "zones" ? "Vista per nodi tariffari" : "Vista per fermate";
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Polimetriche Min-OD · ${escapeHtml(agencyName)} · ${escapeHtml(date)}</title>
<style>
  @page { size: A3 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; background: #f4f4f5; }
  .page { background: #fff; padding: 14mm; margin: 8mm auto; max-width: 410mm; min-height: 270mm; page-break-after: always; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .page:last-child { page-break-after: auto; }
  .page-h { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #6366f1; padding-bottom: 6px; margin-bottom: 12px; }
  .page-h h2 { margin: 0; font-size: 20pt; color: #312e81; }
  .page-h .sub { margin: 2px 0 0; font-size: 10pt; color: #555; }
  .page-h .meta { display: flex; gap: 14px; font-size: 10pt; color: #444; }
  .page-h .meta strong { color: #312e81; font-size: 12pt; }
  .two-col { display: grid; grid-template-columns: 35% 65%; gap: 14px; }
  h3 { font-size: 11pt; margin: 0 0 6px; color: #4338ca; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  table.stops th, table.stops td { padding: 2px 5px; border-bottom: 1px solid #e5e5e5; text-align: left; }
  table.stops th { background: #eef2ff; font-weight: 600; color: #4338ca; }
  table.stops .num { text-align: right; font-variant-numeric: tabular-nums; width: 14%; }
  table.stops .zone { width: 14%; text-align: center; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; background: #e0e7ff; color: #3730a3; font-weight: 600; font-size: 7.5pt; }
  .muted { color: #aaa; }
  table.poli th, table.poli td { border: 1px solid #e5e5e5; padding: 3px 4px; text-align: center; vertical-align: middle; font-variant-numeric: tabular-nums; }
  table.poli thead th { background: #312e81; color: #fff; font-weight: 600; }
  table.poli thead .zname-h { display: block; font-weight: 400; font-size: 6.5pt; color: #c7d2fe; margin-top: 1px; }
  table.poli .row-h { background: #eef2ff; font-weight: 600; text-align: left; padding: 3px 6px; color: #312e81; }
  table.poli .row-h .zname { font-weight: 400; color: #555; font-size: 7.5pt; display: block; }
  table.poli td { background: #fff; font-size: 8pt; }
  table.poli td strong { color: #312e81; }
  table.poli td .km { display: block; font-size: 6.5pt; color: #888; }
  table.poli td.empty { color: #ccc; background: #fafafa; }
  table.poli-big { font-size: 10pt; }
  table.poli-big th, table.poli-big td { padding: 6px 8px; }
  table.poli-big td strong { font-size: 11pt; }
  .legend { font-size: 8pt; color: #666; margin-top: 8px; padding: 6px 8px; background: #eef2ff; border-left: 3px solid #6366f1; border-radius: 0 4px 4px 0; }
  .legend strong { color: #4338ca; }
  .foot { margin-top: 14px; padding-top: 6px; border-top: 1px solid #e5e5e5; font-size: 7.5pt; color: #999; text-align: center; }
  .empty { color: #999; font-style: italic; }
  @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; } }
</style>
</head>
<body>
<header style="text-align:center; padding: 12mm 8mm 4mm; font-family: -apple-system, sans-serif;">
  <h1 style="margin:0; color:#312e81; font-size:18pt;">Polimetriche Tariffarie · Metodo Min-OD (Grafo di Rete)</h1>
  <p style="margin:4px 0 0; color:#555;">${escapeHtml(subtitle)} · ${escapeHtml(agencyName)} · ${escapeHtml(date)} · ${routes.length} linee</p>
</header>
${pages}
</body>
</html>`;
}

async function loadMinOdRoutes(): Promise<MinOdRoutePolimetrica[]> {
  const allRoutes = await apiFetch<RouteNetworkRow[]>("/api/fares/route-networks");
  const extra = allRoutes.filter(r => (r.networkId ?? r.defaultNetworkId) === "extraurbano");
  const out: MinOdRoutePolimetrica[] = [];
  for (const r of extra) {
    try {
      const data = await apiFetch<MinOdRoutePolimetrica>(`/api/fares/min-od/route-polimetrica/${encodeURIComponent(r.routeId)}`);
      if (data && data.zones && data.zones.length > 0) out.push(data);
    } catch { /* salta linea senza dati */ }
  }
  // ordina per shortName
  out.sort((a, b) => (a.routeShortName ?? a.routeId).localeCompare(b.routeShortName ?? b.routeId, "it", { numeric: true }));
  return out;
}

/** Carica TUTTE le varianti di percorso di tutte le linee extraurbane. */
async function loadRouteVariants(): Promise<RouteVariantsResp[]> {
  const allRoutes = await apiFetch<RouteNetworkRow[]>("/api/fares/route-networks");
  const extra = allRoutes.filter(r => (r.networkId ?? r.defaultNetworkId) === "extraurbano");
  const out: RouteVariantsResp[] = [];
  for (const r of extra) {
    try {
      const data = await apiFetch<RouteVariantsResp>(`/api/fares/min-od/route-variants/${encodeURIComponent(r.routeId)}`);
      if (data && data.variants && data.variants.length > 0) out.push(data);
    } catch { /* salta */ }
  }
  out.sort((a, b) => (a.routeShortName ?? a.routeId).localeCompare(b.routeShortName ?? b.routeId, "it", { numeric: true }));
  return out;
}

/**
 * Esporta in PDF (via finestra di stampa) le polimetriche di tutte le linee
 * extraurbane usando i prezzi Min-OD (cammino minimo nella rete).
 * NON richiede CSV generati — interroga direttamente la matrice OD del backend.
 */
export async function exportPolimetricheMinOdToPrint(opts?: { agencyName?: string; date?: string; mode?: "stops" | "zones" }): Promise<void> {
  const agencyName = opts?.agencyName ?? "Conerobus";
  const date = opts?.date ?? new Date().toLocaleDateString("it-IT");
  const mode = opts?.mode ?? "stops";
  const routes = await loadMinOdRoutes();
  if (routes.length === 0) {
    throw new Error("Nessuna linea con dati Min-OD: lancia prima 'Costruisci grafo' e 'Calcola matrice OD' nel tab Zone Extraurbane.");
  }
  const html = renderMinOdHtml(routes, agencyName, date, mode);
  const w = window.open("", "_blank");
  if (!w) throw new Error("Popup bloccato dal browser");
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* noop */ } }, 600);
}

/** Variante "per nodi" — solo matrice nodo×nodo, senza elenco fermate. */
export async function exportPolimetricheMinOdNodesToPrint(opts?: { agencyName?: string; date?: string }): Promise<void> {
  return exportPolimetricheMinOdToPrint({ ...opts, mode: "zones" });
}

/**
 * Crea un link condivisibile per le polimetriche Min-OD.
 */
export async function createPolimetricheMinOdShareLink(opts?: { agencyName?: string; date?: string; mode?: "stops" | "zones" }): Promise<{
  id: string;
  url: string;
  routeCount: number;
}> {
  const agencyName = opts?.agencyName ?? "Conerobus";
  const date = opts?.date ?? new Date().toLocaleDateString("it-IT");
  const mode = opts?.mode ?? "stops";
  const routes = await loadMinOdRoutes();
  if (routes.length === 0) {
    throw new Error("Nessuna linea con dati Min-OD: lancia prima 'Costruisci grafo' e 'Calcola matrice OD'.");
  }
  const html = renderMinOdHtml(routes, agencyName, date, mode);
  const titleSuffix = mode === "zones" ? " (nodi)" : "";
  const res = await apiFetch<{ id: string; url: string; createdAt: string }>(
    "/api/fares/polimetriche/snapshots",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        html,
        title: `Polimetriche Min-OD${titleSuffix} · ${agencyName} · ${date}`,
        agencyName,
        zoningMethod: mode === "zones" ? "min_od_nodes" : "min_od",
        routeCount: routes.length,
        productCount: 0,
        areaCount: routes.reduce((acc, r) => acc + r.zones.length, 0),
        meta: { date, mode: mode === "zones" ? "min_od_nodes" : "min_od" },
      }),
    },
  );
  return { id: res.id, url: res.url, routeCount: routes.length };
}

/** Variante "per nodi" — share link della sola matrice nodo×nodo. */
export async function createPolimetricheMinOdNodesShareLink(opts?: { agencyName?: string; date?: string }) {
  return createPolimetricheMinOdShareLink({ ...opts, mode: "zones" });
}

/* ══════════════════════════════════════════════════════════════
 * CLUSTER NARRATIVI — Polimetriche basate sui cluster generati
 * dalla pipeline Telemaco (DBSCAN→k-means + assorbimento Step 1.5).
 *
 * Stesso layout "a scaletta" delle polimetriche storiche:
 *  • cover page con logo Fares Engine + KPI + spiegazione metodologia
 *  • per ogni linea: matrice triangolare CLUSTER × CLUSTER
 *  • diagonale colorata = nome cluster + elenco fermate della linea
 *    che ricadono in quel cluster (NON tutte le fermate del cluster)
 * ════════════════════════════════════════════════════════════ */

interface ClusterFullForExport {
  clusterId: string;
  clusterName: string;
  centroidLat: number;
  centroidLon: number;
  color: string;
  stops: { stopId: string; stopName: string; lat: number; lon: number }[];
}

/** Convex hull con monotone chain. Input: [lon, lat][]. */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Espande leggermente un poligono dal centroide (effetto buffer in unità lon/lat). */
function expandPolygon(poly: [number, number][], factor: number): [number, number][] {
  if (poly.length === 0) return poly;
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

/** Path SVG smussato (curve di Bezier sui midpoint). */
function smoothPolygonPath(pts: [number, number][]): string {
  if (pts.length < 3) {
    return pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(" ") + " Z";
  }
  const mids: [number, number][] = pts.map((p, i) => {
    const n = pts[(i + 1) % pts.length];
    return [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2];
  });
  let d = `M ${mids[0][0]} ${mids[0][1]}`;
  for (let i = 0; i < pts.length; i++) {
    const ctrl = pts[(i + 1) % pts.length];
    const next = mids[(i + 1) % mids.length];
    d += ` Q ${ctrl[0]} ${ctrl[1]}, ${next[0]} ${next[1]}`;
  }
  d += " Z";
  return d;
}

/** SVG mappa con cluster come "regioni" arrotondate colorate. */
function buildClustersMapSvg(clusters: ClusterFullForExport[]): string {
  const all: [number, number][] = [];
  for (const c of clusters) for (const s of c.stops) all.push([s.lon, s.lat]);
  if (all.length < 3) {
    return `<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" text-anchor="middle" fill="#888" font-family="sans-serif">Mappa non disponibile</text></svg>`;
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of all) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const padX = (maxX - minX) * 0.05;
  const padY = (maxY - minY) * 0.05;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;

  const W = 1100, H = 700;
  const sx = (x: number) => ((x - minX) / (maxX - minX)) * W;
  const sy = (y: number) => H - ((y - minY) / (maxY - minY)) * H;

  const layers: string[] = [];
  layers.push(`<rect width="${W}" height="${H}" fill="#fafbff"/>`);
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * W;
    layers.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#eef2ff" stroke-width="1"/>`);
    const y = (i / 10) * H;
    layers.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#eef2ff" stroke-width="1"/>`);
  }

  for (const c of clusters) {
    if (c.stops.length === 0) continue;
    const pts: [number, number][] = c.stops.map(s => [s.lon, s.lat]);
    let hull = convexHull(pts);
    if (hull.length < 3) {
      const cx = sx(c.centroidLon), cy = sy(c.centroidLat);
      layers.push(`<circle cx="${cx}" cy="${cy}" r="22" fill="${c.color}" fill-opacity="0.25" stroke="${c.color}" stroke-width="2"/>`);
    } else {
      hull = expandPolygon(hull, 1.18);
      const screen = hull.map(([x, y]) => [sx(x), sy(y)] as [number, number]);
      const path = smoothPolygonPath(screen);
      layers.push(`<path d="${path}" fill="${c.color}" fill-opacity="0.22" stroke="${c.color}" stroke-width="2.2" stroke-linejoin="round"/>`);
    }
    const cx = sx(c.centroidLon), cy = sy(c.centroidLat);
    const label = c.clusterName;
    const wPx = Math.max(70, label.length * 6.6);
    layers.push(`<g>
      <circle cx="${cx}" cy="${cy}" r="4" fill="${c.color}" stroke="#fff" stroke-width="1.5"/>
      <rect x="${cx - wPx / 2}" y="${cy - 26}" width="${wPx}" height="18" rx="9" ry="9" fill="${c.color}" fill-opacity="0.95"/>
      <text x="${cx}" y="${cy - 13}" text-anchor="middle" font-size="11" font-family="-apple-system, sans-serif" font-weight="600" fill="#fff">${escape(label)}</text>
    </g>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" style="width:100%; height:auto; max-height:520px; border-radius:18px; background:#fafbff;">${layers.join("")}</svg>`;
}

async function loadClustersFull(): Promise<ClusterFullForExport[]> {
  const raw = await apiFetch<any[]>("/api/fares/zone-clusters/full");
  return (raw || [])
    .filter(c => c && c.stops && c.stops.length > 0)
    .map(c => ({
      clusterId: c.clusterId,
      clusterName: c.clusterName ?? c.clusterId,
      centroidLat: Number(c.centroidLat ?? 0),
      centroidLon: Number(c.centroidLon ?? 0),
      color: c.color ?? "#6366f1",
      stops: (c.stops || []).map((s: any) => ({
        stopId: s.stopId,
        stopName: s.stopName,
        lat: Number(s.lat ?? s.stopLat ?? 0),
        lon: Number(s.lon ?? s.stopLon ?? 0),
      })).filter((s: any) => Number.isFinite(s.lat) && Number.isFinite(s.lon)),
    }));
}

/** Cover page custom per cluster (riusa stile .cover di STYLES + logo). */
function renderClusterCoverPage(opts: {
  agencyName: string;
  date: string;
  routeCount: number;
  clusterCount: number;
  totalStops: number;
  mapSvg: string;
  hopBands?: { fascia: number; price: number }[];
}): string {
  return `
    <section class="page cover">
      <div class="cover-hero">
        <div class="cover-hero-bg"></div>
        <div class="cover-hero-content">
          <img class="cover-logo" src="/faresengine.png" alt="Fares Engine" />
          <div class="cover-product">Fares Engine</div>
          <div class="cover-kicker">Tariffario TPL · Documento ufficiale</div>
          <h1 class="cover-title">Polimetriche per Cluster</h1>
          <div class="cover-subtitle">Matrice O/D nodo tariffario × nodo tariffario · una pagina per linea, basata sui cluster Telemaco</div>
        </div>
      </div>

      <div class="cover-meta">
        <div class="cm-row"><span class="cm-label">Agenzia</span><span class="cm-value">${escape(opts.agencyName)}</span></div>
        <div class="cm-row"><span class="cm-label">Data emissione</span><span class="cm-value">${escape(opts.date)}</span></div>
        <div class="cm-row"><span class="cm-label">Metodo zonizzazione</span><span class="cm-value">Pipeline Telemaco v2 (DBSCAN → k-means + assorbimento Hub)</span></div>
        <div class="cm-row"><span class="cm-label">Standard</span><span class="cm-value">GTFS Fares V2 · DGR Marche n. 1036/2022 · Min-OD via Dijkstra</span></div>
      </div>

      <div class="cover-kpis">
        <div class="ck-card"><div class="ck-num">${opts.routeCount}</div><div class="ck-lbl">Linee analizzate</div></div>
        <div class="ck-card"><div class="ck-num">${opts.clusterCount}</div><div class="ck-lbl">Cluster generati</div></div>
        <div class="ck-card"><div class="ck-num">${opts.totalStops.toLocaleString("it-IT")}</div><div class="ck-lbl">Fermate aggregate</div></div>
        <div class="ck-card ck-card-range"><div class="ck-num">Telemaco v2</div><div class="ck-lbl">Pipeline attiva</div></div>
      </div>

      <h2 class="cover-h2">Come abbiamo ottenuto questi dati</h2>
      <ol class="cover-method">
        <li><strong>Classificazione fermate</strong> — distinzione fra urbane (Hub Ancona, Jesi, Falconara, Senigallia, Osimo) ed extraurbane in base ai network GTFS.</li>
        <li><strong>Step 1 · DBSCAN</strong> — raggruppamento iniziale per prossimità geografica (eps configurabile, min_samples per evitare cluster troppo piccoli).</li>
        <li><strong>Step 1.5 · Assorbimento Hub urbani</strong> — fermate extraurbane che ricadono dentro un hub urbano vengono fuse al cluster urbano (evita doppi conteggi al capolinea).</li>
        <li><strong>Step 2 · k-means refinement</strong> — separazione di cluster troppo eterogenei mantenendo coesione spaziale.</li>
        <li><strong>Naming</strong> — ogni cluster eredita il nome del comune dominante (o della frazione più popolosa) toccato dalle proprie fermate.</li>
        <li><strong>Matrice OD min-cost</strong> — Dijkstra all-pairs sui centroidi dei cluster usando la rete GTFS reale; il prezzo di ogni coppia è la tariffa DGR Marche corrispondente alla fascia chilometrica più breve disponibile fra qualsiasi linea che le collega.</li>
        <li><strong>Polimetrica per linea</strong> — viene proiettata la sequenza dei cluster toccati lungo il percorso dominante; la matrice riportata è quella effettivamente applicabile dal SBE.</li>
      </ol>

      <h2 class="cover-h2 cover-h2-map">Mappa dei cluster · regioni di nodo tariffario</h2>
      <div class="cover-mapnote">Ogni "regione" colorata rappresenta l'inviluppo (convex hull smussato) di tutte le fermate appartenenti a un cluster. La pillola colorata indica il centroide e il nome del nodo tariffario.</div>
      <div class="cover-map">${opts.mapSvg}</div>

      ${opts.hopBands && opts.hopBands.length > 0 ? `
        <h2 class="cover-h2">Tariffario per tratte — fonte: Prodotti &amp; Supporti</h2>
        <div class="cover-mapnote">Una tariffa per ogni "tratta" percorsa fra nodi tariffari. <strong>Stesso nodo</strong> di partenza e arrivo = tratta 1 (F1). <strong>Nodo successivo</strong> = tratta 2 (F2). Esempio: da Z1 a Z3 = 3 tratte = F3.</div>
        <table class="hop-bands-table">
          <thead>
            <tr><th>Fascia</th><th>Tratte (nodi attraversati)</th><th>Tariffa (€)</th></tr>
          </thead>
          <tbody>
            ${opts.hopBands.map(b => {
              const isLast = b.fascia === opts.hopBands!.length;
              const desc = b.fascia === 1
                ? "stesso nodo (1 tratta)"
                : `${b.fascia} tratte${isLast ? " (e oltre)" : ""}`;
              return `
              <tr>
                <td><span class="hb-pill">F${b.fascia}</span></td>
                <td>${desc}</td>
                <td class="hb-price">€ ${fmtMoney(b.price)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      ` : ""}

      <div class="cover-foot">
        <div class="cf-left">© ${new Date().getFullYear()} ${escape(opts.agencyName)} · Generato con Fares Engine</div>
        <div class="cf-right">${escape(opts.date)}</div>
      </div>
    </section>
  `;
}

/**
 * Pagina linea — matrice triangolare CLUSTER × CLUSTER stile scaletta.
 * La diagonale mostra il nome cluster + elenco fermate-della-linea che vi ricadono.
 */
function renderClusterRoutePage(
  p: MinOdRoutePolimetrica,
  clustersIndex: Map<string, ClusterFullForExport>,
  hopBands: { fascia: number; price: number }[],
  _agencyName: string,
  _date: string,
  idx: number,
  total: number,
): string {
  const N = p.zones.length;
  if (N === 0) {
    return `
      <section class="page route" style="--line-color:#94a3b8">
        <header class="r-head">
          <div class="r-head-left">
            <div class="r-line-pill" style="background:#94a3b8">${escape(p.routeShortName ?? p.routeId)}</div>
            <div class="r-titles">
              <div class="r-title">${escape(p.routeLongName ?? p.routeId)}</div>
            </div>
          </div>
          <div class="r-head-right">
            <div class="r-head-meta"><div class="r-pageno">pag. ${idx + 1} / ${total + 1}</div></div>
            <img class="r-brand-logo" src="/faresengine.png" alt="Fares Engine" />
          </div>
        </header>
        <div class="empty">Nessun cluster sul percorso di questa linea.</div>
      </section>
    `;
  }

  const lineColor = clustersIndex.get(p.zones[0].clusterId)?.color ?? "#6366f1";
  const capolineaA = p.stops[0]?.stopName ?? p.zones[0].clusterName;
  const capolineaB = p.stops[p.stops.length - 1]?.stopName ?? p.zones[N - 1].clusterName;

  // ─── Modello "tratte per nodo" ────────────────────────────────────
  // Convenzione operatore:
  //   • partenza e arrivo nello STESSO nodo = tratta 1 (F1)
  //   • partenza nel nodo X, arrivo nel nodo successivo = tratta 2 (F2)
  //   • in generale: tratta = |i - j| + 1
  // La diagonale (stesso cluster) è quindi "casa" → F1, ma nella matrice
  // triangolare visibile (j < i) parte sempre da almeno F2.
  const trattaAt = (i: number, j: number): number => {
    const t = Math.abs(i - j) + 1;
    return Math.max(1, Math.min(hopBands.length, t));
  };
  const priceAt = (i: number, j: number): number | null => {
    const t = trattaAt(i, j);
    return priceForHops(t, hopBands);
  };

  // Range tariffe usate effettivamente da questa linea
  let lMin = Infinity, lMax = -Infinity;
  let priceCount = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < i; j++) {
      const v = priceAt(i, j);
      if (v != null) {
        priceCount++;
        if (v < lMin) lMin = v;
        if (v > lMax) lMax = v;
      }
    }
  }
  if (!isFinite(lMin)) { lMin = 0; lMax = 0; }

  // Densità in funzione del numero di nodi (riuso scaling)
  const d = densityForStops(N);

  // ─── Righe (una per cluster) ── matrice triangolare, NIENTE km, NIENTE chip fermate
  const rows = p.zones.map((z, i) => {
    const cColor = clustersIndex.get(z.clusterId)?.color ?? groupColor(i);
    // Fermate di QUESTA linea che ricadono in QUESTO nodo tariffario
    const zoneStops: { stopId: string; stopName: string }[] =
      p.stopsByZone?.[z.clusterId]
      ?? p.stops.filter(s => s.clusterId === z.clusterId).map(s => ({ stopId: s.stopId, stopName: s.stopName }));

    // Triangolo inferiore j < i: solo il prezzo (numero pulito)
    const priceCells = p.zones.slice(0, i).map((zj, j) => {
      const price = priceAt(i, j);
      const fa = trattaAt(i, j);
      const tratte = Math.abs(i - j) + 1;
      if (price == null) {
        return `<td class="cell na" title="${escape(z.clusterName)} → ${escape(zj.clusterName)}">–</td>`;
      }
      const bg = lMax > lMin ? priceColor(price, lMin, lMax) : "#eef2ff";
      const tip = `${escape(z.clusterName)} → ${escape(zj.clusterName)} · ${tratte} ${tratte === 1 ? "tratta" : "tratte"} · F${fa} · € ${fmtMoney(price)}`;
      return `<td class="cell cl-cell" style="background:${bg}" title="${tip}">${fmtMoney(price)}</td>`;
    }).join("");

    // Diagonale: prezzo F1 (Ancona→Ancona) + nome cluster obliquo verso l'alto-destra
    const diagPrice = priceForHops(1, hopBands);
    const diagPriceTxt = diagPrice != null ? fmtMoney(diagPrice) : "—";
    const diagBg = lMax > lMin && diagPrice != null ? priceColor(diagPrice, lMin, lMax) : cColor;
    const diagCell = `
      <td class="diag cl-diag" style="background:${diagBg}; --diag-bar:${cColor}" title="${escape(z.clusterName)} → ${escape(z.clusterName)} · 1 tratta · F1${diagPrice != null ? ` · € ${fmtMoney(diagPrice)}` : ""}">
        <div class="diag-num">${diagPriceTxt}</div>
        <div class="diag-name">${escape(z.clusterName)}</div>
      </td>`;

    // Celle vuote sopra la diagonale (allineamento triangolo)
    const emptyAfter = p.zones.slice(i + 1).map(() => `<td class="above-diag"></td>`).join("");

    return `
      <tr>
        <th class="rn-num" style="background:${cColor}">${escape(z.label)}</th>
        <th class="rn-name rn-name-cluster">
          <div class="rn-text" title="${escape(z.clusterName)}">${escape(z.clusterName)}</div>
          ${zoneStops.length ? `
            <div class="rn-stops-label">${zoneStops.length} ${zoneStops.length === 1 ? "fermata" : "fermate"} su questa linea</div>
            <ul class="rn-stops-list">
              ${zoneStops.map(s => `<li title="${escape(s.stopName)}">${escape(s.stopName)}</li>`).join("")}
            </ul>
          ` : ""}
        </th>
        ${priceCells}
        ${diagCell}
        ${emptyAfter}
      </tr>
    `;
  }).join("");

  // Legenda colori prezzi
  const steps = 5;
  const legendCells = lMax > lMin
    ? Array.from({ length: steps }, (_, k) => {
        const v = lMin + (lMax - lMin) * (k / (steps - 1));
        return `<div class="lg-cell" style="background:${priceColor(v, lMin, lMax)}">€ ${fmtMoney(v)}</div>`;
      }).join("")
    : `<div class="lg-cell" style="background:#eef2ff">€ ${fmtMoney(lMin)}</div>`;

  const lineStopsTotal = p.stops.length;
  const tariffePossibili = N > 1 ? Math.round(N * (N - 1) / 2) : 0;
  const minPriceTxt = priceCount > 0 ? `€ ${fmtMoney(lMin)}` : "—";
  const maxPriceTxt = priceCount > 0 ? `€ ${fmtMoney(lMax)}` : "—";

  return `
    <section class="page route" style="--line-color:${lineColor}">
      <header class="r-head">
        <div class="r-head-left">
          <div class="r-line-pill" style="background:${lineColor}">${escape(p.routeShortName ?? p.routeId)}</div>
          <div class="r-titles">
            <div class="r-title">${escape(capolineaA)} <span class="arrow">↔</span> ${escape(capolineaB)}</div>
            ${p.routeLongName ? `<div class="r-subtitle">${escape(p.routeLongName)}</div>` : ""}
          </div>
        </div>
        <div class="r-head-right">
          <div class="r-head-meta">
            <div class="r-network">Polimetrica per nodi tariffari · cluster Telemaco</div>
            <div class="r-pageno">pag. ${idx + 1} / ${total + 1}</div>
          </div>
          <img class="r-brand-logo" src="/faresengine.png" alt="Fares Engine" />
        </div>
      </header>

      <div class="r-kpis">
        <div class="r-kpi"><div class="rk-num">${N}</div><div class="rk-lbl">nodi tariffari</div></div>
        <div class="r-kpi"><div class="rk-num">${lineStopsTotal}</div><div class="rk-lbl">fermate servite</div></div>
        <div class="r-kpi"><div class="rk-num">${tariffePossibili}</div><div class="rk-lbl">coppie O/D</div></div>
        <div class="r-kpi"><div class="rk-num">${minPriceTxt} – ${maxPriceTxt}</div><div class="rk-lbl">range tariffe</div></div>
      </div>

      <div class="cl-bigliettazione">
        <div class="clb-title">Come è divisa la linea · zone tariffarie in ordine di percorso</div>
        <div class="clb-help">Il biglietto si calcola contando quante zone attraversi: <b>resti nella stessa zona</b> = il prezzo più basso. <b>Cambi una zona</b> = sali alla fascia successiva.</div>
        <div class="clb-seq">
          ${p.zones.map((z, k) => {
            const c = clustersIndex.get(z.clusterId)?.color ?? groupColor(k);
            return `<span class="clb-node">
              <span class="clb-code" style="background:${c}">${escape(z.label)}</span>
              <span class="clb-name">${escape(z.clusterName)}</span>
            </span>${k < p.zones.length - 1 ? `<span class="clb-arrow">→</span>` : ""}`;
          }).join("")}
        </div>
      </div>

      <div class="cl-fares-applied">
        <div class="clf-title">Quanto costa · ${Math.min(N, hopBands.length)} ${Math.min(N, hopBands.length) === 1 ? "fascia" : "fasce"} usate da questa linea</div>
        <div class="clf-help">Esempio pratico: ${
          N >= 2
            ? `da <b>${escape(p.zones[0].clusterName)}</b> a <b>${escape(p.zones[1].clusterName)}</b> attraversi 2 zone, paghi <b>F2 = € ${fmtMoney(priceForHops(2, hopBands) ?? 0)}</b>.`
            : `tutta la linea sta in <b>${escape(p.zones[0].clusterName)}</b>, paghi sempre <b>F1 = € ${fmtMoney(priceForHops(1, hopBands) ?? 0)}</b>.`
        }</div>
        <div class="clf-bar">
          ${Array.from({ length: Math.min(N, hopBands.length) }, (_, k) => {
            const fa = k + 1;
            const price = priceForHops(fa, hopBands);
            const desc =
              fa === 1 ? "stessa zona"
              : fa === 2 ? "2 zone (1 cambio)"
              : `${fa} zone (${fa - 1} cambi)`;
            return `<div class="clf-chip">
              <div class="clf-chip-fa">F${fa}</div>
              <div class="clf-chip-price">€ ${fmtMoney(price ?? 0)}</div>
              <div class="clf-chip-desc">${desc}</div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <h3 class="r-section-title">
        Tabella dei prezzi · zona di partenza × zona di arrivo
        <span class="hint">Trova la zona da cui parti sulla riga, poi vai fino alla zona di arrivo nella colonna: il numero è il prezzo del biglietto in euro. Le caselle sulla diagonale colorata sono i viaggi <b>dentro la stessa zona</b> (prezzo minimo F1).</span>
      </h3>

      <div class="matrix-wrap density-${d.scale}"
           style="--cs:${Math.max(d.cellSize, 56)}px;--cf:${Math.max(d.cellFont, 10)}px;--hf:${d.headerFont}px;--nw:${Math.max(d.nameWidth, 220)}px;--dnh:${d.diagNameHeight}px">
        <table class="matrix">
          <colgroup>
            <col class="cg-num">
            <col class="cg-name">
            ${p.zones.map(() => `<col class="cg-cell">`).join("")}
          </colgroup>
          <thead>
            <tr class="diag-spacer"><th colspan="${N + 2}" class="ds-cell"></th></tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>

        <div class="matrix-legend">
          <div class="lg-title">Tariffe per numero di tratte (nodi attraversati)</div>
          <div class="lg-bar">${legendCells}</div>
          <div class="lg-hint">Diagonale = nodo tariffario (F1, stesso cluster) · F2 = nodo successivo · F3 = 2 nodi più in là · … · Tariffe da Prodotti &amp; Supporti</div>
        </div>
      </div>

      <footer class="r-foot">
        <div>Linea <strong>${escape(p.routeShortName ?? p.routeId)}</strong> · ${escape(p.routeId)}</div>
        <div>${N} nodi · ${lineStopsTotal} fermate · max ${N} tratte = F${Math.min(hopBands.length, N)}</div>
      </footer>
    </section>
  `;
}

/* ════════════════════════════════════════════════════════════════════
   POLIMETRICA PER VARIANTE DI PERCORSO (formato A3 paesaggio)
   Una pagina per ogni variante della linea. Matrice triangolare
   fermata × fermata. Prezzo cella = priceForHops(|cluster_i - cluster_j| + 1)
   con cluster_k = indice del cluster di stop_k nella sequenza zones[].
   Barra colore laterale a sinistra di ogni nome fermata = colore cluster.
   ════════════════════════════════════════════════════════════════════ */
function renderRouteVariantPage(
  routeShortName: string | null,
  routeId: string,
  routeLongName: string | null,
  variant: RouteVariant,
  variantIdx: number,
  variantTotal: number,
  clustersIndex: Map<string, ClusterFullForExport>,
  hopBands: { fascia: number; price: number }[],
  pageNo: number,
  pageTotal: number,
): string {
  const stops = variant.stops;
  const N = stops.length;
  const Z = variant.zones.length;
  if (N < 2) {
    return `<section class="page route a3" style="--line-color:#94a3b8">
      <header class="r-head"><div class="r-head-left"><div class="r-line-pill" style="background:#94a3b8">${escape(routeShortName ?? routeId)}</div></div></header>
      <div class="empty">Variante con meno di 2 fermate.</div></section>`;
  }

  const lineColor = clustersIndex.get(variant.zones[0]?.clusterId ?? "")?.color ?? "#6366f1";
  const clusterColorOf = (clusterId: string | null, fallbackIdx: number): string => {
    if (!clusterId) return "#cbd5e1";
    const c = clustersIndex.get(clusterId);
    return c?.color ?? groupColor(fallbackIdx);
  };

  // Indice del cluster di ogni stop nella sequenza zones[] (per calcolare il prezzo)
  const zoneIdxOfClusterId = new Map<string, number>();
  variant.zones.forEach((z, i) => zoneIdxOfClusterId.set(z.clusterId, i));
  const zoneIdxOfStop: number[] = stops.map(s => {
    if (!s.clusterId) return -1;
    return zoneIdxOfClusterId.get(s.clusterId) ?? -1;
  });
  const colorOfStop: string[] = stops.map((s, i) => clusterColorOf(s.clusterId, zoneIdxOfStop[i] >= 0 ? zoneIdxOfStop[i] : i));

  const trattaBetweenStops = (i: number, j: number): number => {
    const zi = zoneIdxOfStop[i];
    const zj = zoneIdxOfStop[j];
    if (zi < 0 || zj < 0) return 1;
    const t = Math.abs(zi - zj) + 1;
    return Math.max(1, Math.min(hopBands.length, t));
  };
  const priceBetween = (i: number, j: number): number | null => {
    const t = trattaBetweenStops(i, j);
    return priceForHops(t, hopBands);
  };

  // range prezzi locali alla variante
  let lMin = Infinity, lMax = -Infinity;
  for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) {
    const v = priceBetween(i, j);
    if (v != null) { if (v < lMin) lMin = v; if (v > lMax) lMax = v; }
  }
  if (!isFinite(lMin)) { lMin = 0; lMax = 0; }

  // boundary visivo dove cambia il cluster
  const isClusterBoundary = (i: number) => i > 0 && stops[i].clusterId !== stops[i - 1].clusterId;

  // ─── righe ──
  const rows = stops.map((from, i) => {
    const cColor = colorOfStop[i];
    const rowBoundary = isClusterBoundary(i) ? " gboundary-t" : "";
    const zoneLabel = from.clusterId ? (variant.zones[zoneIdxOfStop[i]]?.label ?? "") : "";

    const priceCells = stops.slice(0, i).map((to, j) => {
      const colBoundary = isClusterBoundary(j) ? " gboundary-l" : "";
      const price = priceBetween(i, j);
      const fa = trattaBetweenStops(i, j);
      if (price == null) return `<td class="cell na${colBoundary}">–</td>`;
      const bg = lMax > lMin ? priceColor(price, lMin, lMax) : "#eef2ff";
      const tip = `${escape(from.stopName)} → ${escape(to.stopName)} · F${fa} · € ${fmtMoney(price)}`;
      return `<td class="cell${colBoundary}" style="background:${bg}" title="${tip}">${fmtMoney(price)}</td>`;
    }).join("");

    const diagBoundary = isClusterBoundary(i) ? " gboundary-l" : "";
    const diagCell = `<td class="diag${diagBoundary}" style="background:${cColor}" title="${escape(from.stopName)}">
      <div class="diag-num">${i + 1}</div>
      <div class="diag-name">${escape(from.stopName)}</div>
    </td>`;

    const emptyAfter = stops.slice(i + 1).map((_, k) => {
      const colJ = i + 1 + k;
      const cb = isClusterBoundary(colJ) ? " gboundary-l" : "";
      return `<td class="above-diag${cb}"></td>`;
    }).join("");

    return `
      <tr class="${rowBoundary}">
        <th class="rn-num" style="background:${cColor}">${i + 1}</th>
        <th class="rn-name v-rn-name">
          <span class="v-color-bar" style="background:${cColor}"></span>
          <div class="v-name-block">
            <div class="rn-text" title="${escape(from.stopName)}">${escape(from.stopName)}</div>
            <div class="rn-meta">
              ${zoneLabel ? `<span class="v-zone-pill" style="background:${cColor}">${escape(zoneLabel)}</span>` : ""}
              <span class="v-from-name">${escape(from.clusterName ?? "—")}</span>
              <span class="v-km">${from.kmFromStart.toFixed(1)} km</span>
            </div>
          </div>
        </th>
        ${priceCells}
        ${diagCell}
        ${emptyAfter}
      </tr>
    `;
  }).join("");

  // densità: con A3 paesaggio possiamo essere più generosi
  const cellSize = N <= 25 ? 36 : N <= 40 ? 28 : N <= 55 ? 22 : 18;
  const cellFont = N <= 25 ? 9 : N <= 40 ? 8 : N <= 55 ? 7 : 6;
  const headerFont = N <= 40 ? 9 : 8;
  const nameWidth = N <= 25 ? 240 : N <= 40 ? 200 : 170;
  const diagNameHeight = N <= 25 ? 200 : N <= 40 ? 180 : 160;

  // legenda cluster di questa variante
  const clusterLegend = variant.zones.map((z, k) => {
    const c = clustersIndex.get(z.clusterId)?.color ?? groupColor(k);
    const stopsCount = variant.stopsByZone[z.clusterId]?.length ?? 0;
    return `<div class="vc-chip"><span class="vc-dot" style="background:${c}"></span>
      <span class="vc-code" style="background:${c}">${escape(z.label)}</span>
      <span class="vc-name">${escape(z.clusterName)}</span>
      <span class="vc-meta">${stopsCount} ferm.</span>
    </div>`;
  }).join("");

  // chip fasce in uso
  const fasceInUso = Math.min(Z, hopBands.length);
  const fasceChips = Array.from({ length: fasceInUso }, (_, k) => {
    const fa = k + 1;
    const price = priceForHops(fa, hopBands);
    const desc = fa === 1 ? "stessa zona" : fa === 2 ? "2 zone (1 cambio)" : `${fa} zone (${fa - 1} cambi)`;
    return `<div class="clf-chip">
      <div class="clf-chip-fa">F${fa}</div>
      <div class="clf-chip-price">€ ${fmtMoney(price ?? 0)}</div>
      <div class="clf-chip-desc">${desc}</div>
    </div>`;
  }).join("");

  return `
    <section class="page route a3" style="--line-color:${lineColor}">
      <header class="r-head">
        <div class="r-head-left">
          <div class="r-line-pill" style="background:${lineColor}">${escape(routeShortName ?? routeId)}</div>
          <div class="r-titles">
            <div class="r-title">${escape(variant.firstStopName)} <span class="arrow">↔</span> ${escape(variant.lastStopName)}</div>
            <div class="r-subtitle">Variante ${variantIdx + 1} di ${variantTotal} · ${variant.tripCount} corse · ${N} fermate · ${variant.totalKm.toFixed(1)} km</div>
          </div>
        </div>
        <div class="r-head-right">
          <div class="r-head-meta">
            <div class="r-network">${escape(routeLongName ?? "")}</div>
            <div class="r-pageno">pag. ${pageNo} / ${pageTotal}</div>
          </div>
          <img class="r-brand-logo" src="/faresengine.png" alt="Fares Engine" />
        </div>
      </header>

      <div class="v-cluster-legend">
        <div class="v-leg-title">Zone tariffarie attraversate · ${Z} ${Z === 1 ? "zona" : "zone"}</div>
        <div class="v-leg-bar">${clusterLegend}</div>
        <div class="v-leg-help">La striscia colorata accanto a ogni fermata indica la zona tariffaria. <b>Quando il colore cambia, sali di una fascia.</b></div>
      </div>

      <div class="cl-fares-applied">
        <div class="clf-title">Tariffe applicate · ${fasceInUso} ${fasceInUso === 1 ? "fascia" : "fasce"}</div>
        <div class="clf-help">Per leggere la tabella: trova la fermata di <b>partenza</b> sulla riga (i nomi sono a sinistra) e segui fino alla colonna della fermata di <b>arrivo</b>. Il numero nella casella è il prezzo del biglietto in euro.</div>
        <div class="clf-bar">${fasceChips}</div>
      </div>

      <div class="matrix-wrap variant-matrix" style="--cs:${cellSize}px;--cf:${cellFont}px;--hf:${headerFont}px;--nw:${nameWidth}px;--dnh:${diagNameHeight}px">
        <table class="matrix">
          <colgroup>
            <col class="col-num" />
            <col class="col-name" />
            ${stops.map(() => `<col class="col-cell" />`).join("")}
          </colgroup>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <footer class="r-foot">
        <div>Linea <strong>${escape(routeShortName ?? routeId)}</strong> · variante ${variantIdx + 1}/${variantTotal} · ${variant.tripCount} corse</div>
        <div>${N} fermate · ${Z} zone tariffarie · max F${Math.min(hopBands.length, Z)}</div>
      </footer>
    </section>
  `;
}

/** Stili extra per la vista cluster (cover map, metodologia, celle prezzo leggibili). */
const CLUSTER_EXTRA_STYLES = `
  /* ════════ FORMATO A3 PAESAGGIO PER VARIANTI ════════ */
  @page :first { size: A4; }
  .page.a3 { width: 420mm; min-height: 287mm; padding: 12mm 14mm; }
  @media print {
    .page.a3 { page: a3land; }
    @page a3land { size: A3 landscape; margin: 8mm; }
  }

  /* Legenda zone tariffarie attraversate dalla variante */
  .v-cluster-legend {
    margin: 8px 0 10px;
    padding: 10px 14px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-left: 3px solid var(--line-color, #475569);
    border-radius: 4px;
  }
  .v-cluster-legend .v-leg-title {
    font-size: 8pt; font-weight: 700; color: #64748b;
    text-transform: uppercase; letter-spacing: 1.2px;
    margin-bottom: 8px;
  }
  .v-cluster-legend .v-leg-bar {
    display: flex; flex-wrap: wrap; gap: 8px;
    margin-bottom: 6px;
  }
  .v-cluster-legend .vc-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 3px;
    font-size: 9.5pt;
  }
  .v-cluster-legend .vc-dot { width: 14px; height: 14px; border-radius: 2px; }
  .v-cluster-legend .vc-code {
    display: inline-block; padding: 2px 6px; border-radius: 2px;
    color: #fff; font-weight: 700; font-size: 8.5pt;
  }
  .v-cluster-legend .vc-name { color: #0f172a; font-weight: 600; }
  .v-cluster-legend .vc-meta { color: #64748b; font-size: 8.5pt; }
  .v-cluster-legend .v-leg-help {
    font-size: 9pt; color: #334155; line-height: 1.4;
  }
  .v-cluster-legend .v-leg-help b { color: #0f172a; }

  /* Cella nome fermata con barra colore laterale verticale */
  .matrix .v-rn-name {
    padding: 0 !important;
    position: relative;
    vertical-align: middle;
  }
  .matrix .v-rn-name .v-color-bar {
    display: inline-block;
    width: 6px;
    align-self: stretch;
    flex-shrink: 0;
  }
  .matrix .v-rn-name {
    display: flex !important;
    align-items: stretch;
  }
  .matrix .v-rn-name .v-name-block {
    flex: 1;
    padding: 4px 8px;
    min-width: 0;
  }
  .matrix .v-rn-name .v-name-block .rn-text {
    font-weight: 600;
    color: #0f172a;
    font-size: 9pt;
    line-height: 1.2;
    white-space: normal;
    word-break: break-word;
  }
  .matrix .v-rn-name .v-name-block .rn-meta {
    font-size: 7pt;
    color: #64748b;
    margin-top: 2px;
    display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  }
  .matrix .v-rn-name .v-name-block .v-zone-pill {
    display: inline-block; padding: 1px 6px; border-radius: 2px;
    color: #fff; font-weight: 700; font-size: 7pt; letter-spacing: 0.3px;
  }
  .matrix .v-rn-name .v-name-block .v-from-name { font-weight: 500; color: #475569; }
  .matrix .v-rn-name .v-name-block .v-km { color: #94a3b8; font-variant-numeric: tabular-nums; }

  /* Bordo netto dove cambia il cluster */
  .matrix tr.gboundary-t > th,
  .matrix tr.gboundary-t > td { border-top: 2px solid #1e293b !important; }
  .matrix td.gboundary-l,
  .matrix th.gboundary-l { border-left: 2px solid #1e293b !important; }

  /* Numerazione fermata sulla prima colonna (cell numerica) */
  .matrix .variant-matrix .rn-num,
  .matrix.variant-matrix .rn-num { color: #fff; font-weight: 700; }

  .cover-h2 { font-size: 14pt; color: #1e1b4b; margin: 16px 0 6px; padding-left: 10px; border-left: 4px solid #6366f1; border-radius: 2px; }
  .cover-h2-map { margin-top: 14px; }
  .cover-method { margin: 0 0 14px 22px; padding: 0; font-size: 10pt; color: #334155; line-height: 1.5; }
  .cover-method li { margin-bottom: 3px; }
  .cover-method strong { color: #1e1b4b; }
  .cover-mapnote { font-size: 9.5pt; color: #64748b; margin: 0 0 6px; font-style: italic; }
  .cover-map { border-radius: 14px; overflow: hidden; border: 1px solid #e2e8f0; background: #fafbff; padding: 6px; }

  /* Celle prezzo cluster — solo numero, grande e leggibile */
  .matrix td.cl-cell {
    font-weight: 700 !important;
    color: #0f172a !important;
    text-shadow: 0 1px 0 rgba(255,255,255,0.65);
    letter-spacing: -0.2px;
    font-size: calc(var(--cf) * 1.15) !important;
    font-variant-numeric: tabular-nums;
  }
  .matrix td.cell.na {
    color: #94a3b8 !important;
    background: #f8fafc !important;
    font-weight: 500;
    font-style: italic;
  }

  /* Diagonale cluster — prezzo F1 al centro (come una cella normale) +
     barra colore cluster a sinistra come "tag" identificativo del nodo */
  table.matrix td.diag.cl-diag {
    background: var(--cell-bg, #fff);
    border-left: 6px solid var(--diag-bar) !important;
  }
  table.matrix td.diag.cl-diag .diag-num {
    color: #0f172a !important;
    font-weight: 800;
    font-size: calc(var(--cf) * 1.15) !important;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 0 rgba(255,255,255,0.55);
    height: var(--cs);
    line-height: var(--cs);
  }
  /* Nome cluster obliquo: nero con halo bianco per restare leggibile su qualsiasi sfondo */
  table.matrix td.diag .diag-name {
    color: #0f172a !important;
    text-shadow: 0 0 3px rgba(255,255,255,0.85), 0 1px 0 rgba(255,255,255,0.6);
    font-weight: 700;
  }
  /* Colonna sinistra cluster — codice + nome cluster (no km) */
  .rn-name-cluster .rn-text {
    font-weight: 600;
    color: #1e1b4b;
    font-size: calc(var(--hf) * 1.0);
    line-height: 1.2;
  }

  /* ════════════════════════════════════════════════════════════════════
     ENTERPRISE STYLES — palette sobria, bordi sottili, niente decorazioni
     ════════════════════════════════════════════════════════════════════ */

  /* Sequenza nodi tariffari */
  .cl-bigliettazione {
    margin: 8px 0 8px;
    padding: 10px 14px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-left: 3px solid var(--line-color, #475569);
    border-radius: 4px;
  }
  .cl-bigliettazione .clb-title {
    font-size: 8pt;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    margin-bottom: 8px;
  }
  .cl-bigliettazione .clb-help {
    font-size: 9pt;
    color: #334155;
    line-height: 1.45;
    margin: 0 0 10px;
  }
  .cl-bigliettazione .clb-help b {
    color: #0f172a;
    font-weight: 700;
  }
  .cl-bigliettazione .clb-seq {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 2px;
    font-size: 10pt;
  }
  .cl-bigliettazione .clb-node {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px 3px 4px;
    background: #f8fafc;
    border-radius: 3px;
    border: 1px solid #e2e8f0;
    font-weight: 500;
    color: #0f172a;
  }
  .cl-bigliettazione .clb-code {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 2px;
    color: #fff;
    font-weight: 700;
    font-size: 9pt;
    letter-spacing: 0.3px;
    font-variant-numeric: tabular-nums;
  }
  .cl-bigliettazione .clb-arrow {
    color: #94a3b8;
    font-weight: 600;
    font-size: 11pt;
    margin: 0 4px;
  }

  /* Tariffe applicate — chip sobrie */
  .cl-fares-applied {
    margin: 0 0 14px;
    padding: 10px 14px;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-left: 3px solid #475569;
    border-radius: 4px;
  }
  .cl-fares-applied .clf-title {
    font-size: 8pt;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    margin-bottom: 8px;
  }
  .cl-fares-applied .clf-help {
    font-size: 9pt;
    color: #334155;
    line-height: 1.45;
    margin: 0 0 10px;
  }
  .cl-fares-applied .clf-help b {
    color: #0f172a;
    font-weight: 700;
  }
  .cl-fares-applied .clf-bar {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .cl-fares-applied .clf-chip {
    flex: 1 1 100px;
    min-width: 100px;
    padding: 6px 10px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 3px;
    text-align: left;
    display: flex; flex-direction: column; gap: 1px;
  }
  .cl-fares-applied .clf-chip-fa {
    align-self: flex-start;
    padding: 1px 6px;
    border-radius: 2px;
    background: #1e293b;
    color: #fff;
    font-weight: 700;
    font-size: 8pt;
    letter-spacing: 0.4px;
    margin-bottom: 2px;
  }
  .cl-fares-applied .clf-chip-price {
    font-size: 13pt;
    font-weight: 700;
    color: #0f172a;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .cl-fares-applied .clf-chip-desc {
    font-size: 7.5pt;
    color: #64748b;
    font-weight: 400;
  }

  /* Fermate sotto il nome cluster — lista verticale, una per riga */
  .matrix .rn-name-cluster {
    vertical-align: top;
    padding-top: 8px !important;
    padding-bottom: 8px !important;
  }
  .matrix .rn-name-cluster .rn-text {
    font-weight: 700;
    color: #0f172a;
    font-size: 10pt;
    line-height: 1.2;
    margin-bottom: 4px;
  }
  .matrix .rn-name-cluster .rn-stops-label {
    font-size: 6.5pt;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
    margin: 4px 0 2px;
  }
  .matrix .rn-name-cluster .rn-stops-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 7pt;
    line-height: 1.35;
    color: #475569;
    font-weight: 400;
  }
  .matrix .rn-name-cluster .rn-stops-list li {
    padding: 1px 0 1px 8px;
    position: relative;
    border-left: 2px solid #e2e8f0;
    margin-left: 2px;
    white-space: normal;
    word-break: break-word;
  }
  .matrix .rn-name-cluster .rn-stops-list li::before {
    content: "";
    position: absolute;
    left: -3px; top: 6px;
    width: 4px; height: 4px;
    background: #cbd5e1;
    border-radius: 50%;
  }

  /* Tabella tariffario fasce nella cover */
  .hop-bands-table { width: 100%; border-collapse: collapse; margin: 6px 0 14px; font-size: 11pt; }
  .hop-bands-table th, .hop-bands-table td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; }
  .hop-bands-table th { background: #eef2ff; color: #3730a3; font-weight: 700; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.5px; }
  .hop-bands-table .hb-pill { display: inline-block; padding: 3px 10px; border-radius: 999px; background: #6366f1; color: #fff; font-weight: 700; font-size: 10pt; }
  .hop-bands-table .hb-price { font-weight: 800; color: #1e1b4b; font-variant-numeric: tabular-nums; font-size: 12pt; text-align: right; }

`;

interface ClustersExportOpts {
  agencyName?: string;
  date?: string;
  routeIds?: string[];
}

/**
 * Carica i prodotti tariffari dal backend e ne estrae l'elenco delle fasciIe
 * extraurbane (`extra_fascia_N`). Una fascia = 1 scatto = 1 passaggio fra cluster.
 *
 * Convenzione adottata:
 *   • numero di salti = |i - j| sulla sequenza dei nodi tariffari della linea
 *   • prezzo(salti) = hopBands[salti - 1].price   (cap all'ultima fascia)
 *   • salti = 0 (stesso cluster) → fascia 1
 */
async function loadHopBands(): Promise<{ fascia: number; price: number; productName: string; productId: string }[]> {
  const products = await apiFetch<any[]>("/api/fares/products");
  const bands: { fascia: number; price: number; productName: string; productId: string }[] = [];
  for (const p of products || []) {
    const pid = String(p.fareProductId ?? p.fare_product_id ?? "");
    const m = pid.match(/^extra_fascia_(\d+)$/i);
    if (!m) continue;
    bands.push({
      fascia: parseInt(m[1], 10),
      price: Number(p.amount ?? 0),
      productName: String(p.fareProductName ?? p.fare_product_name ?? pid),
      productId: pid,
    });
  }
  bands.sort((a, b) => a.fascia - b.fascia);
  return bands;
}

/** Prezzo per un certo numero di salti tra nodi tariffari. */
function priceForHops(hops: number, bands: { fascia: number; price: number }[]): number | null {
  if (bands.length === 0) return null;
  const idx = Math.max(0, Math.min(bands.length - 1, hops - 1));
  return bands[idx].price;
}

async function buildClustersHtml(opts: ClustersExportOpts): Promise<{
  html: string;
  agencyName: string;
  date: string;
  routeCount: number;
  clusterCount: number;
}> {
  const agencyName = opts.agencyName ?? "Conerobus · Trasporto Pubblico Locale";
  const date = opts.date ?? new Date().toLocaleDateString("it-IT");

  const [clusters, routesVariantsAll, hopBands] = await Promise.all([
    loadClustersFull(),
    loadRouteVariants(),
    loadHopBands(),
  ]);
  if (clusters.length === 0) {
    throw new Error("Nessun cluster trovato. Genera prima i cluster dal tab 'Cluster Tariffari'.");
  }
  const routeIdsFilter = (opts.routeIds ?? []).map((x) => String(x).trim()).filter(Boolean);
  const routeIdsSet = routeIdsFilter.length > 0 ? new Set(routeIdsFilter) : null;
  const routesVariants = routeIdsSet
    ? routesVariantsAll.filter((rv) => routeIdsSet.has(rv.routeId))
    : routesVariantsAll;

  if (routesVariants.length === 0) {
    throw new Error("Nessuna linea con varianti di percorso. Verifica che il GTFS sia caricato e contenga linee extraurbane.");
  }
  if (hopBands.length === 0) {
    throw new Error("Nessun prodotto extra_fascia_* trovato. Vai su 'Prodotti & Supporti' e clicca 'Genera tariffe extraurbane'.");
  }

  const clustersIndex = new Map<string, ClusterFullForExport>();
  for (const c of clusters) clustersIndex.set(c.clusterId, c);

  const totalStops = clusters.reduce((s, c) => s + c.stops.length, 0);
  const totalVariants = routesVariants.reduce((s, r) => s + r.variants.length, 0);
  const mapSvg = buildClustersMapSvg(clusters);

  const cover = renderClusterCoverPage({
    agencyName, date,
    routeCount: routesVariants.length,
    clusterCount: clusters.length,
    totalStops,
    mapSvg,
    hopBands,
  });

  // Pre-conta totale pagine: cover + 1 pagina per variante
  const totalPages = 1 + totalVariants;
  let pageCounter = 1; // cover = pag 1
  const pages = routesVariants.map(rv =>
    rv.variants.map((v, vi) => {
      pageCounter++;
      return renderRouteVariantPage(
        rv.routeShortName, rv.routeId, rv.routeLongName,
        v, vi, rv.variants.length,
        clustersIndex, hopBands,
        pageCounter, totalPages,
      );
    }).join("\n")
  ).join("\n");

  // Logo embedded (riusa l'helper esistente)
  const logoDataUri = await loadLogoDataUri();
  const logoCss = logoDataUri
    ? `\nimg.cover-logo, img.r-brand-logo { content: url("${logoDataUri}"); }\n`
    : "";

  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <title>Polimetriche per Cluster — ${escape(agencyName)} — ${escape(date)}</title>
  <style>${STYLES}${CLUSTER_EXTRA_STYLES}${logoCss}</style>
</head>
<body>
  <div class="toolbar">
    <h1>📊 Polimetriche per Cluster · ${escape(agencyName)} · ${routesVariants.length} linee · ${totalVariants} varianti · ${clusters.length} cluster</h1>
    <div><button onclick="window.print()">🖨️ Stampa / Salva PDF</button></div>
  </div>
  ${cover}
  ${pages}
</body>
</html>`;

  return { html, agencyName, date, routeCount: routesVariants.length, clusterCount: clusters.length };
}

/**
 * Esporta in PDF (via finestra di stampa) le polimetriche basate sui cluster Telemaco.
 * Cover con logo Fares Engine + mappa SVG, poi una pagina per linea con la matrice
 * cluster × cluster a scaletta. La diagonale mostra solo le fermate della linea.
 */
export async function exportPolimetricheClustersToPrint(opts?: ClustersExportOpts): Promise<void> {
  // Apri subito la finestra (per non incorrere nel blocco popup post-await)
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) {
    alert("Abilita i popup per aprire il report polimetriche cluster.");
    return;
  }
  win.document.write(`
    <!doctype html><html><head><title>Polimetriche Cluster — caricamento…</title>
    <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f4f6;color:#475569}
    .l{text-align:center}.s{display:inline-block;width:40px;height:40px;border:3px solid #cbd5e1;border-top-color:#6366f1;border-radius:50%;animation:r 1s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}</style></head>
    <body><div class="l"><div class="s"></div><p>Costruzione polimetriche per cluster…</p></div></body></html>
  `);
  try {
    const { html } = await buildClustersHtml(opts ?? {});
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err: any) {
    win.document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#dc2626">
      <h2>Errore generazione polimetriche cluster</h2>
      <pre style="white-space:pre-wrap">${escape(err?.message || String(err))}</pre>
    </div>`;
  }
}

/** Crea un link condivisibile alle polimetriche per cluster. */
export async function createPolimetricheClustersShareLink(opts?: ClustersExportOpts): Promise<{
  id: string;
  url: string;
  routeCount: number;
  clusterCount: number;
}> {
  const built = await buildClustersHtml(opts ?? {});

  // L'HTML cluster include una pagina A3 per ogni variante di percorso e
  // può raggiungere decine di MB. Lo comprimiamo lato client con gzip
  // (CompressionStream nativo) e lo inviamo in base64. Sul backend
  // Render free questo evita 502 da OOM nel parsing JSON gigante.
  const htmlGzipB64 = await gzipToBase64(built.html);

  const res = await apiFetch<{ id: string; url: string; createdAt: string }>(
    "/api/fares/polimetriche/snapshots",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        htmlGzipB64,
        title: `Polimetriche Cluster · ${built.agencyName} · ${built.date}`,
        agencyName: built.agencyName,
        zoningMethod: "clusters_telemaco",
        routeCount: built.routeCount,
        productCount: 0,
        areaCount: built.clusterCount,
        meta: { date: built.date, mode: "clusters", clusterCount: built.clusterCount },
      }),
    },
  );
  return { id: res.id, url: res.url, routeCount: built.routeCount, clusterCount: built.clusterCount };
}

/**
 * Comprime una stringa con gzip via CompressionStream API (nativo browser),
 * ritorna il risultato in base64 (sicuro per JSON).
 */
async function gzipToBase64(text: string): Promise<string> {
  // CompressionStream è disponibile in tutti i browser evergreen.
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  // Conversione binaria → base64 a chunk per non saturare lo stack.
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000; // 32KB
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any);
  }
  return btoa(binary);
}

