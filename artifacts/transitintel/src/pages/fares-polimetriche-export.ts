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

function priceColor(amount: number, min: number, max: number): string {
  if (max <= min) return "#fff7ed";
  const t = (amount - min) / (max - min);
  // gradiente caldo: avorio → ambra → arancio scuro
  const r = Math.round(255 - t * 50);
  const g = Math.round(247 - t * 130);
  const b = Math.round(237 - t * 200);
  return `rgb(${r}, ${g}, ${b})`;
}

function renderPolimetricaTable(sheet: RouteSheet, model: PriceModel): string {
  const areas = sheet.routeAreas;
  if (areas.length === 0) {
    return `<div class="empty">Nessuna zona tariffaria assegnata a questa linea.</div>`;
  }
  const network = sheet.networkId || "";

  const header = `
    <tr>
      <th class="corner">Da \\ A</th>
      ${areas.map(a => `<th class="zh"><div class="zcode">${escape(a.code)}</div></th>`).join("")}
    </tr>
  `;

  const rows = areas.map((from, i) => {
    const cells = areas.map((to, j) => {
      if (j < i) return `<td class="empty-cell">─</td>`;
      const key = `${network}|${from.id}|${to.id}`;
      const price = model.prices.get(key);
      if (price == null) {
        // simmetrico
        const altKey = `${network}|${to.id}|${from.id}`;
        const alt = model.prices.get(altKey);
        if (alt == null) return `<td class="empty-cell">·</td>`;
        return `<td class="price" style="background:${priceColor(alt, model.minPrice, model.maxPrice)}">${fmtMoney(alt)}</td>`;
      }
      return `<td class="price" style="background:${priceColor(price, model.minPrice, model.maxPrice)}">${fmtMoney(price)}</td>`;
    }).join("");
    return `
      <tr>
        <th class="rh"><div class="zcode">${escape(from.code)}</div></th>
        ${cells}
      </tr>
    `;
  }).join("");

  return `
    <table class="polimetrica">
      <thead>${header}</thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderRoutePage(sheet: RouteSheet, model: PriceModel, idx: number, total: number): string {
  const networkLabel = sheet.networkId ? (NETWORK_LABEL[sheet.networkId] || sheet.networkId) : "—";
  const lineColor = sheet.routeColor && sheet.routeColor !== "" ? `#${sheet.routeColor}` : "#0f766e";
  const stopCount = sheet.stops.length;
  const zoneCount = sheet.routeAreas.length;

  // 2 colonne fermate
  const half = Math.ceil(sheet.stops.length / 2);
  const leftCol = sheet.stops.slice(0, half);
  const rightCol = sheet.stops.slice(half);

  const renderStopRow = (s: RouteStop, n: number) => {
    const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
    const code = aid ? (model.areas.get(aid)?.code ?? "—") : "—";
    return `
      <tr>
        <td class="num">${n}</td>
        <td class="sname">${escape(s.stopName)}</td>
        <td class="km">${s.progressiveKm.toFixed(1)}</td>
        <td class="zn">${escape(code)}</td>
      </tr>
    `;
  };

  // Legenda zone (codice + range km approssimativo + nome)
  const zoneLegend = sheet.routeAreas.map(a => {
    const stopsInZone = sheet.stops.filter(s => {
      const aid = s.currentAreaId || s.suggestedAreaId || model.stopToArea.get(s.stopId);
      return aid === a.id;
    });
    const kmStart = stopsInZone[0]?.progressiveKm ?? 0;
    const kmEnd = stopsInZone[stopsInZone.length - 1]?.progressiveKm ?? 0;
    return `
      <div class="zone-item">
        <div class="zbadge">${escape(a.code)}</div>
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
          <div class="r-pageno">${idx} / ${total}</div>
        </div>
      </header>

      <div class="r-kpis">
        <div class="r-kpi"><div class="rk-num">${sheet.totalKm.toFixed(1)}</div><div class="rk-lbl">km totali</div></div>
        <div class="r-kpi"><div class="rk-num">${stopCount}</div><div class="rk-lbl">fermate</div></div>
        <div class="r-kpi"><div class="rk-num">${zoneCount}</div><div class="rk-lbl">zone tariffarie</div></div>
        <div class="r-kpi"><div class="rk-num">${zoneCount > 0 ? Math.round(zoneCount * (zoneCount + 1) / 2) : 0}</div><div class="rk-lbl">tariffe OD</div></div>
      </div>

      <div class="r-body">
        <div class="r-col-stops">
          <h3 class="r-section-title">Elenco fermate</h3>
          <div class="stops-grid">
            <table class="stops">
              <thead><tr><th>#</th><th>Fermata</th><th>km</th><th>Zona</th></tr></thead>
              <tbody>${leftCol.map((s, i) => renderStopRow(s, i + 1)).join("")}</tbody>
            </table>
            <table class="stops">
              <thead><tr><th>#</th><th>Fermata</th><th>km</th><th>Zona</th></tr></thead>
              <tbody>${rightCol.map((s, i) => renderStopRow(s, i + 1 + half)).join("")}</tbody>
            </table>
          </div>
        </div>

        <div class="r-col-poli">
          <h3 class="r-section-title">Polimetrica tariffaria <span class="hint">prezzo biglietto ordinario · €</span></h3>
          ${renderPolimetricaTable(sheet, model)}

          <h3 class="r-section-title legend-title">Legenda zone</h3>
          <div class="zones-legend">${zoneLegend}</div>
        </div>
      </div>

      <footer class="r-foot">
        <div>Linea <strong>${escape(sheet.shortName)}</strong> · ${escape(sheet.routeId)}</div>
        <div>Sorgente: GTFS Fares V2 · ${escape(networkLabel)}</div>
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
    background: #1f2937; color: white;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  .toolbar h1 { margin: 0; font-size: 14px; font-weight: 600; }
  .toolbar button {
    background: #10b981; color: white; border: 0;
    padding: 8px 16px; border-radius: 6px; font-weight: 600;
    cursor: pointer; font-size: 13px;
  }
  .toolbar button:hover { background: #059669; }

  @page { size: A4 portrait; margin: 12mm; }
  @media print {
    body { background: white; }
    .toolbar { display: none; }
    .page { box-shadow: none !important; margin: 0 !important; }
  }

  .page {
    width: 210mm;
    min-height: 297mm;
    margin: 16px auto;
    padding: 14mm 12mm;
    background: white;
    box-shadow: 0 4px 20px rgba(0,0,0,.08);
    page-break-after: always;
    display: flex; flex-direction: column;
  }
  .page:last-child { page-break-after: auto; }

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

  /* ─── Pagina linea ─────────────── */
  .route { gap: 10px; }
  .r-head {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 2px solid var(--line-color); padding-bottom: 10px;
  }
  .r-head-left { display: flex; align-items: center; gap: 14px; }
  .r-line-pill {
    color: white; font-weight: 800; font-size: 22px;
    padding: 8px 16px; border-radius: 8px; min-width: 64px; text-align: center;
    letter-spacing: .5px; box-shadow: 0 2px 6px rgba(0,0,0,.15);
  }
  .r-titles { display: flex; flex-direction: column; gap: 2px; }
  .r-title { font-size: 18px; font-weight: 700; color: #0f172a; }
  .r-title .arrow { color: var(--line-color); margin: 0 6px; font-weight: 400; }
  .r-subtitle { font-size: 11px; color: #64748b; }
  .r-head-right { text-align: right; }
  .r-network {
    background: var(--line-color); color: white;
    padding: 4px 10px; border-radius: 4px; font-size: 11px;
    font-weight: 600; text-transform: uppercase; letter-spacing: .5px;
  }
  .r-pageno { font-size: 10px; color: #64748b; margin-top: 4px; }

  .r-kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 8px 0 4px; }
  .r-kpi {
    border: 1px solid #e5e7eb; border-radius: 8px;
    padding: 8px 10px; text-align: center;
    background: linear-gradient(180deg, #f8fafc, #ffffff);
  }
  .rk-num { font-size: 18px; font-weight: 700; color: var(--line-color); }
  .rk-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; margin-top: 2px; }

  .r-body { display: grid; grid-template-columns: 1fr 1.1fr; gap: 12px; flex: 1; align-content: start; }

  .r-section-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px;
    color: var(--line-color); font-weight: 700;
    border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; margin: 6px 0;
  }
  .r-section-title .hint { color: #94a3b8; font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 9px; margin-left: 6px; }
  .legend-title { margin-top: 14px; }

  .stops-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  table.stops { width: 100%; border-collapse: collapse; font-size: 9px; }
  table.stops thead th {
    background: #f1f5f9; color: #475569; font-weight: 600;
    padding: 4px 4px; text-align: left; border-bottom: 1px solid #cbd5e1;
    font-size: 8px; text-transform: uppercase; letter-spacing: .5px;
  }
  table.stops td { padding: 2px 4px; border-bottom: 1px dotted #e5e7eb; }
  table.stops td.num { color: #94a3b8; width: 16px; text-align: right; font-variant-numeric: tabular-nums; }
  table.stops td.sname { color: #1f2937; }
  table.stops td.km { text-align: right; font-variant-numeric: tabular-nums; color: #475569; width: 32px; }
  table.stops td.zn { text-align: center; font-weight: 700; color: var(--line-color); width: 22px; }

  table.polimetrica { border-collapse: collapse; font-size: 10px; width: 100%; }
  table.polimetrica th, table.polimetrica td {
    border: 1px solid #d1d5db; padding: 4px 2px; text-align: center;
    min-width: 32px; height: 24px;
  }
  table.polimetrica th.corner {
    background: var(--line-color); color: white; font-weight: 700; font-size: 9px;
  }
  table.polimetrica th.zh, table.polimetrica th.rh {
    background: #f8fafc; color: #0f172a; font-weight: 700;
  }
  table.polimetrica .zcode { font-size: 11px; }
  table.polimetrica td.price {
    font-variant-numeric: tabular-nums; font-weight: 600; color: #1f2937;
  }
  table.polimetrica td.empty-cell { color: #cbd5e1; background: #fafafa; }

  .zones-legend { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .zone-item { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border: 1px solid #e5e7eb; border-radius: 6px; background: #fafafa; }
  .zbadge {
    background: var(--line-color); color: white;
    width: 28px; height: 28px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 11px; flex-shrink: 0;
  }
  .zinfo { flex: 1; min-width: 0; }
  .zname { font-size: 10px; font-weight: 600; color: #1f2937; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .zrange { font-size: 9px; color: #64748b; }

  .empty { color: #94a3b8; font-style: italic; padding: 20px; text-align: center; border: 1px dashed #cbd5e1; border-radius: 6px; }

  .r-foot {
    display: flex; justify-content: space-between;
    border-top: 1px solid #e5e7eb; padding-top: 8px; margin-top: auto;
    font-size: 9px; color: #94a3b8;
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
