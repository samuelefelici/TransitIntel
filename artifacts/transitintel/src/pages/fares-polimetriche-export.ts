/**
 * FaresPolimetricheExport — esporta le polimetriche tariffarie come stampa A4/A3.
 *
 * Una "polimetrica" è la matrice triangolare origine-destinazione delle tariffe:
 * per ogni coppia (zona_partenza, zona_arrivo) all'interno di una rete tariffaria,
 * mostra il prezzo del biglietto. È il tariffario classico extraurbano italiano.
 *
 * Il report si costruisce a partire dai file CSV già generati da `GenerateTab`
 * (areas.txt, stop_areas.txt, fare_products.txt, fare_leg_rules.txt) ed è
 * pensato per essere aperto in nuova finestra, stampato direttamente o
 * esportato in PDF tramite la stampa del browser ("Salva come PDF").
 *
 * Layout per rete tariffaria (1 sezione = 1 network):
 *  ┌──────────────────────────────────────────────┐
 *  │  EXTRAURBANO · 24 zone · 12 fasce            │
 *  │  Matrice O/D: 552 tariffe                    │
 *  ├──────────────────────────────────────────────┤
 *  │  KPI: min 1.30€ · max 8.50€ · media 4.20€    │
 *  │  Composizione: 8% F1 · 12% F2 · 18% F3 ...   │
 *  ├──────────────────────────────────────────────┤
 *  │  Heatmap matrice OD                          │
 *  │            Z1   Z2   Z3   Z4   ...           │
 *  │       Z1   1.30 1.30 1.50 1.80                │
 *  │       Z2   ─    1.30 1.30 1.50                │
 *  │       Z3   ─    ─    1.30 1.30                │
 *  │       ...                                     │
 *  └──────────────────────────────────────────────┘
 */

/* ──────────────────────────────────────────────────────────
 * Tipi
 * ──────────────────────────────────────────────────────── */

export interface PolimetricheInput {
  /** mappa filename → contenuto CSV (esattamente result.files di GenerateTab) */
  files: Record<string, string>;
  /** metodo di zonizzazione scelto dall'utente (per il sottotitolo) */
  zoningMethod?: "shape" | "direct" | "dominant" | "cluster";
  /** data servizio o data corrente */
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
  from_timeframe_group_id?: string;
  to_timeframe_group_id?: string;
}

/* ──────────────────────────────────────────────────────────
 * Helpers di parsing CSV minimale (no quote escape complesso —
 * il generatore Fares V2 emette CSV semplici)
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

/** CSV split che rispetta virgolette doppie. */
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

const fmtMoney = (n: number, currency = "EUR"): string => {
  if (!isFinite(n)) return "—";
  const sym = currency === "EUR" ? "€" : currency;
  return `${n.toFixed(2)} ${sym}`;
};

const fmtMoneyShort = (n: number): string => {
  if (!isFinite(n)) return "—";
  return n.toFixed(2);
};

/* ──────────────────────────────────────────────────────────
 * Costruzione modello dati interno
 * ──────────────────────────────────────────────────────── */

interface NetworkMatrix {
  networkId: string;
  networkLabel: string;
  areas: { id: string; name: string; stopsCount: number }[];
  /** matrix[fromIdx][toIdx] = { amount, currency, productName, productId } | null */
  matrix: (CellData | null)[][];
  /** statistiche aggregate */
  stats: {
    totalRules: number;
    distinctPrices: number;
    minPrice: number;
    maxPrice: number;
    avgPrice: number;
    /** distribuzione fasce: [productName, count, amount, share%] */
    bands: { name: string; count: number; amount: number; share: number; color: string }[];
  };
}

interface CellData {
  amount: number;
  currency: string;
  productName: string;
  productId: string;
}

/** Etichette leggibili per i network_id più comuni in Marche. */
const NETWORK_LABELS: Record<string, string> = {
  urbano_ancona: "Urbano Ancona",
  urbano_jesi: "Urbano Jesi",
  urbano_falconara: "Urbano Falconara",
  urbano_senigallia: "Urbano Senigallia",
  urbano_castelfidardo: "Urbano Castelfidardo",
  urbano_sassoferrato: "Urbano Sassoferrato",
  extraurbano: "Extraurbano",
};

const ZONING_LABELS: Record<string, string> = {
  shape: "Proiezione su shape GTFS",
  direct: "Distanza Haversine diretta",
  dominant: "Percorso dominante",
  cluster: "Cluster territoriali",
};

/** Palette gradiente verde→giallo→rosso per heatmap (10 stop). */
const HEAT_PALETTE = [
  "#0f766e", "#15803d", "#65a30d", "#a3a300", "#ca8a04",
  "#d97706", "#ea580c", "#dc2626", "#b91c1c", "#7f1d1d",
];

/** Palette per le fasce di prezzo (max ~14 fasce distinte). */
const BAND_PALETTE = [
  "#10b981", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6",
  "#a855f7", "#ec4899", "#f43f5e", "#f97316", "#f59e0b",
  "#eab308", "#84cc16", "#22c55e", "#14b8a6",
];

function buildModel(input: PolimetricheInput): NetworkMatrix[] {
  const areas = parseCsv(input.files["areas.txt"]) as unknown as AreaRow[];
  const stopAreas = parseCsv(input.files["stop_areas.txt"]) as unknown as StopAreaRow[];
  const products = parseCsv(input.files["fare_products.txt"]) as unknown as FareProductRow[];
  const legRules = parseCsv(input.files["fare_leg_rules.txt"]) as unknown as FareLegRuleRow[];

  if (legRules.length === 0) return [];

  // Mappe lookup
  const areaMap = new Map(areas.map(a => [a.area_id, a]));
  const productMap = new Map(products.map(p => [p.fare_product_id, p]));
  const stopsByArea = new Map<string, number>();
  for (const sa of stopAreas) {
    stopsByArea.set(sa.area_id, (stopsByArea.get(sa.area_id) ?? 0) + 1);
  }

  // Raggruppa per network_id
  const byNetwork = new Map<string, FareLegRuleRow[]>();
  for (const r of legRules) {
    const nid = r.network_id || "(global)";
    if (!byNetwork.has(nid)) byNetwork.set(nid, []);
    byNetwork.get(nid)!.push(r);
  }

  const result: NetworkMatrix[] = [];

  for (const [networkId, rules] of byNetwork) {
    // Aree distinte presenti in queste regole
    const areaIds = new Set<string>();
    for (const r of rules) {
      if (r.from_area_id) areaIds.add(r.from_area_id);
      if (r.to_area_id) areaIds.add(r.to_area_id);
    }
    const areaArr = Array.from(areaIds).map(id => {
      const a = areaMap.get(id);
      return {
        id,
        name: a?.area_name || id,
        stopsCount: stopsByArea.get(id) ?? 0,
      };
    });
    // Ordina alfanumericamente in modo "naturale"
    areaArr.sort((a, b) => naturalSort(a.name, b.name));
    const idxMap = new Map(areaArr.map((a, i) => [a.id, i]));

    const N = areaArr.length;
    const matrix: (CellData | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));

    // Statistiche
    const productCount = new Map<string, number>(); // productId → count
    const productAmount = new Map<string, number>();

    for (const r of rules) {
      const i = idxMap.get(r.from_area_id);
      const j = idxMap.get(r.to_area_id);
      if (i === undefined || j === undefined) continue;
      const p = productMap.get(r.fare_product_id);
      if (!p) continue;
      const amount = parseFloat(p.amount);
      if (!isFinite(amount)) continue;
      // Tieni solo la regola "principale" (senza timeframe) se esistono varianti
      const existing = matrix[i][j];
      if (existing && (r.from_timeframe_group_id || r.to_timeframe_group_id)) continue;
      matrix[i][j] = {
        amount,
        currency: p.currency || "EUR",
        productName: p.fare_product_name || p.fare_product_id,
        productId: p.fare_product_id,
      };
      productCount.set(p.fare_product_id, (productCount.get(p.fare_product_id) ?? 0) + 1);
      productAmount.set(p.fare_product_id, amount);
    }

    // KPI
    const allCells = matrix.flat().filter((c): c is CellData => c !== null);
    const amounts = allCells.map(c => c.amount);
    const minPrice = amounts.length ? Math.min(...amounts) : 0;
    const maxPrice = amounts.length ? Math.max(...amounts) : 0;
    const avgPrice = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
    const totalRules = allCells.length;

    // Composizione fasce
    const bandsRaw = Array.from(productCount.entries())
      .map(([pid, count]) => ({
        productId: pid,
        name: productMap.get(pid)?.fare_product_name || pid,
        amount: productAmount.get(pid) ?? 0,
        count,
      }))
      .sort((a, b) => a.amount - b.amount);
    const bands = bandsRaw.map((b, i) => ({
      name: b.name,
      count: b.count,
      amount: b.amount,
      share: totalRules > 0 ? (b.count / totalRules) * 100 : 0,
      color: BAND_PALETTE[i % BAND_PALETTE.length],
    }));

    result.push({
      networkId,
      networkLabel: NETWORK_LABELS[networkId] || networkId,
      areas: areaArr,
      matrix,
      stats: {
        totalRules,
        distinctPrices: bands.length,
        minPrice,
        maxPrice,
        avgPrice,
        bands,
      },
    });
  }

  // Ordina: extraurbano in fondo, urbani prima alfabeticamente
  result.sort((a, b) => {
    if (a.networkId === "extraurbano") return 1;
    if (b.networkId === "extraurbano") return -1;
    return a.networkLabel.localeCompare(b.networkLabel);
  });

  return result;
}

/** Ordinamento naturale (Z1, Z2, Z10 invece di Z1, Z10, Z2). */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/* ──────────────────────────────────────────────────────────
 * Mappa prezzo → colore heatmap
 * ──────────────────────────────────────────────────────── */

function priceColor(amount: number, min: number, max: number): string {
  if (max <= min) return HEAT_PALETTE[0];
  const t = (amount - min) / (max - min); // 0..1
  const idx = Math.min(HEAT_PALETTE.length - 1, Math.max(0, Math.floor(t * HEAT_PALETTE.length)));
  return HEAT_PALETTE[idx];
}

/* ──────────────────────────────────────────────────────────
 * Rendering HTML
 * ──────────────────────────────────────────────────────── */

function renderNetworkSection(net: NetworkMatrix): string {
  const N = net.areas.length;
  if (N === 0) {
    return `<section class="network-section"><h2>${escape(net.networkLabel)}</h2><p class="empty">Nessuna regola tariffaria.</p></section>`;
  }

  // Decide larghezza cella in base al numero di zone (più zone → più piccole)
  const cellSize =
    N <= 8 ? 56 :
    N <= 12 ? 48 :
    N <= 18 ? 38 :
    N <= 25 ? 30 :
    N <= 35 ? 24 :
    20;

  // Header colonne (rotato per matrici grandi)
  const rotateHeaders = N > 12;

  const colHeaders = net.areas.map(a => `
    <th class="zone-col" style="width:${cellSize}px;min-width:${cellSize}px">
      <div class="${rotateHeaders ? "rot" : ""}" title="${escape(a.name)} · ${a.stopsCount} fermate">${escape(a.name)}</div>
    </th>`).join("");

  const rows = net.areas.map((rowArea, i) => {
    const cells = net.areas.map((_, j) => {
      const cell = net.matrix[i][j];
      if (!cell) {
        return `<td class="cell empty" style="width:${cellSize}px;height:${cellSize}px"></td>`;
      }
      const bg = priceColor(cell.amount, net.stats.minPrice, net.stats.maxPrice);
      const t = net.stats.maxPrice > net.stats.minPrice
        ? (cell.amount - net.stats.minPrice) / (net.stats.maxPrice - net.stats.minPrice)
        : 0;
      const textColor = t > 0.55 ? "#fff" : "#1f2937";
      const tip = `${rowArea.name} → ${net.areas[j].name} · ${cell.productName} · ${fmtMoney(cell.amount, cell.currency)}`;
      return `<td class="cell" style="background:${bg};color:${textColor};width:${cellSize}px;height:${cellSize}px" title="${escape(tip)}">${fmtMoneyShort(cell.amount)}</td>`;
    }).join("");
    return `<tr><th class="zone-row" title="${escape(rowArea.name)} · ${rowArea.stopsCount} fermate">${escape(rowArea.name)}</th>${cells}</tr>`;
  }).join("");

  // Composizione fasce — barre orizzontali
  const bandsBar = net.stats.bands.map(b => `
    <div class="band-row">
      <div class="band-swatch" style="background:${b.color}"></div>
      <div class="band-label">${escape(b.name)}</div>
      <div class="band-amount">${fmtMoney(b.amount)}</div>
      <div class="band-bar-wrap">
        <div class="band-bar" style="width:${b.share.toFixed(1)}%;background:${b.color}"></div>
      </div>
      <div class="band-share">${b.share.toFixed(1)}%</div>
      <div class="band-count">${b.count}</div>
    </div>
  `).join("");

  // Legenda gradiente prezzo
  const legendStops = HEAT_PALETTE.map((c, i) => {
    const stop = (i / (HEAT_PALETTE.length - 1)) * 100;
    return `${c} ${stop.toFixed(0)}%`;
  }).join(", ");

  return `
  <section class="network-section">
    <header class="net-header">
      <div class="net-title">
        <h2>${escape(net.networkLabel)}</h2>
        <span class="net-pill">${net.areas.length} zone · ${net.stats.totalRules} tariffe · ${net.stats.distinctPrices} fasce</span>
      </div>
      <div class="kpi-strip">
        <div class="kpi"><span class="kpi-label">Min</span><span class="kpi-value">${fmtMoney(net.stats.minPrice)}</span></div>
        <div class="kpi"><span class="kpi-label">Media</span><span class="kpi-value">${fmtMoney(net.stats.avgPrice)}</span></div>
        <div class="kpi"><span class="kpi-label">Max</span><span class="kpi-value">${fmtMoney(net.stats.maxPrice)}</span></div>
        <div class="kpi"><span class="kpi-label">Δ Range</span><span class="kpi-value">${fmtMoney(net.stats.maxPrice - net.stats.minPrice)}</span></div>
      </div>
    </header>

    <div class="bands-panel">
      <div class="bands-title">Composizione fasce tariffarie</div>
      ${bandsBar}
    </div>

    <div class="matrix-wrap">
      <div class="matrix-axis-label axis-from">▼ Origine</div>
      <div class="matrix-axis-label axis-to">▶ Destinazione</div>
      <table class="matrix">
        <thead>
          <tr>
            <th class="corner"></th>
            ${colHeaders}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="legend">
      <span class="legend-text">Scala prezzo</span>
      <div class="legend-bar" style="background:linear-gradient(to right, ${legendStops})"></div>
      <span class="legend-min">${fmtMoney(net.stats.minPrice)}</span>
      <span class="legend-max">${fmtMoney(net.stats.maxPrice)}</span>
    </div>
  </section>`;
}

function renderGlobalSummary(networks: NetworkMatrix[]): string {
  const totalRules = networks.reduce((a, n) => a + n.stats.totalRules, 0);
  const totalAreas = networks.reduce((a, n) => a + n.areas.length, 0);
  const allAmounts = networks.flatMap(n => n.matrix.flat().filter((c): c is CellData => !!c).map(c => c.amount));
  const globalMin = allAmounts.length ? Math.min(...allAmounts) : 0;
  const globalMax = allAmounts.length ? Math.max(...allAmounts) : 0;
  const globalAvg = allAmounts.length ? allAmounts.reduce((a, b) => a + b, 0) / allAmounts.length : 0;

  const netRows = networks.map(n => {
    const widthPct = totalRules > 0 ? (n.stats.totalRules / totalRules) * 100 : 0;
    return `
      <tr>
        <td class="net-name">${escape(n.networkLabel)}</td>
        <td class="num">${n.areas.length}</td>
        <td class="num">${n.stats.totalRules}</td>
        <td class="num">${n.stats.distinctPrices}</td>
        <td class="num">${fmtMoney(n.stats.minPrice)}</td>
        <td class="num">${fmtMoney(n.stats.avgPrice)}</td>
        <td class="num">${fmtMoney(n.stats.maxPrice)}</td>
        <td class="bar-cell">
          <div class="mini-bar-wrap"><div class="mini-bar" style="width:${widthPct.toFixed(1)}%"></div></div>
          <span class="mini-bar-label">${widthPct.toFixed(1)}%</span>
        </td>
      </tr>`;
  }).join("");

  return `
  <section class="global-summary">
    <h2>Riepilogo Globale Polimetriche</h2>
    <div class="global-kpi-grid">
      <div class="global-kpi"><div class="g-label">Reti tariffarie</div><div class="g-value">${networks.length}</div></div>
      <div class="global-kpi"><div class="g-label">Zone totali</div><div class="g-value">${totalAreas}</div></div>
      <div class="global-kpi"><div class="g-label">Tariffe totali</div><div class="g-value">${totalRules}</div></div>
      <div class="global-kpi"><div class="g-label">Prezzo min</div><div class="g-value">${fmtMoney(globalMin)}</div></div>
      <div class="global-kpi"><div class="g-label">Prezzo medio</div><div class="g-value">${fmtMoney(globalAvg)}</div></div>
      <div class="global-kpi"><div class="g-label">Prezzo max</div><div class="g-value">${fmtMoney(globalMax)}</div></div>
    </div>

    <table class="summary-table">
      <thead>
        <tr>
          <th>Rete</th><th>Zone</th><th>Tariffe</th><th>Fasce</th>
          <th>Min</th><th>Media</th><th>Max</th><th>Quota tariffe</th>
        </tr>
      </thead>
      <tbody>${netRows}</tbody>
    </table>
  </section>`;
}

/* ──────────────────────────────────────────────────────────
 * Entry point: apre nuova finestra con il documento
 * ──────────────────────────────────────────────────────── */

export function exportPolimetricheToPrint(input: PolimetricheInput): void {
  const networks = buildModel(input);
  if (networks.length === 0) {
    alert("Nessuna regola tariffaria trovata. Genera prima le tariffe (\"Genera Anteprima Tariffe\").");
    return;
  }

  const dateStr = input.date || new Date().toLocaleDateString("it-IT");
  const zoningLabel = input.zoningMethod ? (ZONING_LABELS[input.zoningMethod] || input.zoningMethod) : "—";
  const agency = input.agencyName || "TransitIntel";

  const sections = networks.map(renderNetworkSection).join("\n");
  const summary = renderGlobalSummary(networks);

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Polimetriche Tariffarie · ${escape(dateStr)}</title>
  <style>
    @page { size: A4 landscape; margin: 12mm; }
    @media print {
      .no-print { display: none !important; }
      body { background: #fff !important; }
      .network-section { page-break-inside: avoid; page-break-after: always; }
      .global-summary { page-break-before: always; }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
      background: #f3f4f6;
      color: #1f2937;
      font-size: 9pt;
    }

    /* Toolbar */
    .toolbar {
      position: sticky; top: 0; z-index: 100;
      background: #1f2937; color: #fff;
      padding: 10px 16px;
      display: flex; align-items: center; gap: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .toolbar h1 { font-size: 13pt; margin: 0; flex: 1; font-weight: 600; }
    .toolbar button {
      background: #10b981; color: #fff; border: none;
      padding: 6px 14px; border-radius: 4px; cursor: pointer;
      font-size: 10pt; font-weight: 500;
    }
    .toolbar button.secondary { background: #6b7280; }
    .toolbar button:hover { filter: brightness(1.1); }

    /* Document container */
    .doc-wrap { padding: 18px 24px; max-width: 1400px; margin: 0 auto; }

    /* Cover header */
    .cover {
      background: linear-gradient(135deg, #064e3b 0%, #047857 50%, #10b981 100%);
      color: #fff;
      padding: 24px 28px;
      border-radius: 8px;
      margin-bottom: 22px;
      box-shadow: 0 4px 16px rgba(16,185,129,0.25);
      display: flex; align-items: center; justify-content: space-between;
    }
    .cover .title-block h1 {
      font-size: 22pt; margin: 0; letter-spacing: -0.5px; font-weight: 700;
    }
    .cover .title-block .sub {
      margin-top: 4px; font-size: 10pt; opacity: 0.9; font-weight: 400;
    }
    .cover .meta {
      text-align: right; font-size: 9pt; line-height: 1.6;
    }
    .cover .meta strong { font-size: 10pt; }
    .cover .meta-pill {
      display: inline-block; background: rgba(255,255,255,0.18);
      padding: 4px 10px; border-radius: 12px; margin-top: 6px;
      font-family: "SF Mono", Menlo, monospace; font-size: 8pt;
    }

    /* Network section */
    .network-section {
      background: #fff;
      border-radius: 8px;
      padding: 18px 22px;
      margin-bottom: 22px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      border: 1px solid #e5e7eb;
    }
    .net-header {
      display: flex; align-items: flex-start; justify-content: space-between;
      margin-bottom: 14px; padding-bottom: 10px;
      border-bottom: 2px solid #f3f4f6;
    }
    .net-title h2 {
      font-size: 16pt; margin: 0; color: #047857; font-weight: 700;
    }
    .net-pill {
      display: inline-block; margin-top: 4px;
      background: #ecfdf5; color: #047857;
      padding: 3px 10px; border-radius: 10px;
      font-size: 8pt; font-weight: 500;
    }
    .kpi-strip { display: flex; gap: 14px; }
    .kpi {
      display: flex; flex-direction: column; align-items: center;
      padding: 6px 12px; background: #f9fafb;
      border: 1px solid #e5e7eb; border-radius: 6px;
      min-width: 64px;
    }
    .kpi-label {
      font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px;
      color: #6b7280; font-weight: 600;
    }
    .kpi-value {
      font-size: 11pt; font-weight: 700; color: #111827;
      font-family: "SF Mono", Menlo, monospace;
    }

    /* Bands panel */
    .bands-panel {
      background: #fafafa; border-radius: 6px;
      padding: 10px 14px; margin-bottom: 16px;
      border: 1px solid #e5e7eb;
    }
    .bands-title {
      font-size: 8pt; text-transform: uppercase; letter-spacing: 0.6px;
      color: #6b7280; font-weight: 600; margin-bottom: 8px;
    }
    .band-row {
      display: grid;
      grid-template-columns: 14px 1fr 60px 200px 50px 36px;
      gap: 10px; align-items: center;
      padding: 3px 0; font-size: 8.5pt;
    }
    .band-swatch { width: 12px; height: 12px; border-radius: 3px; }
    .band-label { color: #1f2937; font-weight: 500; }
    .band-amount { font-family: "SF Mono", Menlo, monospace; color: #047857; font-weight: 600; }
    .band-bar-wrap {
      height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;
    }
    .band-bar { height: 100%; transition: none; }
    .band-share { font-family: "SF Mono", Menlo, monospace; color: #6b7280; text-align: right; }
    .band-count { font-family: "SF Mono", Menlo, monospace; color: #9ca3af; text-align: right; font-size: 8pt; }

    /* Matrix */
    .matrix-wrap {
      position: relative;
      overflow: auto;
      padding: 26px 0 4px 26px;
    }
    .matrix-axis-label {
      position: absolute;
      font-size: 7.5pt; text-transform: uppercase;
      letter-spacing: 0.6px; color: #6b7280; font-weight: 700;
    }
    .axis-from { top: 8px; left: 4px; }
    .axis-to   { top: 8px; left: 90px; }

    table.matrix {
      border-collapse: separate;
      border-spacing: 1px;
      background: #f3f4f6;
      border-radius: 4px;
    }
    table.matrix th, table.matrix td {
      padding: 0; margin: 0;
      text-align: center; vertical-align: middle;
      font-size: 8pt; font-family: "SF Mono", Menlo, monospace;
    }
    table.matrix th.corner {
      background: #f9fafb; min-width: 70px; width: 70px;
    }
    table.matrix th.zone-col {
      background: #f9fafb;
      font-weight: 600; color: #374151;
      vertical-align: bottom; height: 60px;
      padding: 2px;
    }
    table.matrix th.zone-col .rot {
      writing-mode: vertical-rl; transform: rotate(180deg);
      white-space: nowrap; padding: 4px 0;
      font-size: 7.5pt;
    }
    table.matrix th.zone-row {
      background: #f9fafb; font-weight: 600; color: #374151;
      text-align: right; padding: 0 8px;
      min-width: 70px; max-width: 70px;
      font-size: 8pt; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis;
    }
    table.matrix td.cell {
      font-weight: 600; font-size: 8pt;
      transition: none;
    }
    table.matrix td.cell.empty {
      background: #f3f4f6;
    }
    table.matrix td.cell.empty::after {
      content: "·"; color: #d1d5db;
    }

    /* Legend */
    .legend {
      display: flex; align-items: center; gap: 10px;
      margin-top: 12px; padding: 8px 12px;
      background: #fafafa; border: 1px solid #e5e7eb; border-radius: 6px;
      font-size: 8pt; color: #6b7280;
    }
    .legend-text { font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .legend-bar {
      flex: 1; height: 10px; border-radius: 5px;
      max-width: 360px;
    }
    .legend-min, .legend-max {
      font-family: "SF Mono", Menlo, monospace; font-weight: 600; color: #1f2937;
    }

    /* Global summary */
    .global-summary {
      background: #fff; border-radius: 8px;
      padding: 22px 26px; margin-top: 8px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .global-summary h2 {
      font-size: 16pt; color: #047857; margin: 0 0 16px;
      font-weight: 700;
    }
    .global-kpi-grid {
      display: grid; grid-template-columns: repeat(6, 1fr);
      gap: 10px; margin-bottom: 18px;
    }
    .global-kpi {
      background: linear-gradient(135deg, #ecfdf5, #d1fae5);
      border: 1px solid #a7f3d0; border-radius: 6px;
      padding: 10px 12px; text-align: center;
    }
    .global-kpi .g-label {
      font-size: 7.5pt; color: #047857; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .global-kpi .g-value {
      font-size: 14pt; font-weight: 700; color: #064e3b;
      font-family: "SF Mono", Menlo, monospace; margin-top: 2px;
    }
    table.summary-table {
      width: 100%; border-collapse: collapse;
      font-size: 9pt;
    }
    table.summary-table th {
      text-align: left; padding: 8px 10px;
      background: #f3f4f6; color: #374151; font-weight: 600;
      border-bottom: 2px solid #e5e7eb;
      font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5px;
    }
    table.summary-table td {
      padding: 8px 10px; border-bottom: 1px solid #f3f4f6;
    }
    table.summary-table td.num {
      text-align: right; font-family: "SF Mono", Menlo, monospace;
    }
    table.summary-table td.net-name { font-weight: 600; color: #047857; }
    .mini-bar-wrap {
      display: inline-block; width: 120px; height: 8px;
      background: #e5e7eb; border-radius: 4px; overflow: hidden;
      vertical-align: middle; margin-right: 6px;
    }
    .mini-bar { height: 100%; background: linear-gradient(to right, #10b981, #047857); }
    .mini-bar-label {
      font-family: "SF Mono", Menlo, monospace;
      font-size: 8pt; color: #6b7280; vertical-align: middle;
    }

    .empty {
      color: #9ca3af; font-style: italic; text-align: center; padding: 12px 0;
    }

    .footer {
      text-align: center; font-size: 7.5pt; color: #9ca3af;
      margin-top: 16px; padding: 12px;
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <h1>📊 Polimetriche Tariffarie · ${escape(dateStr)}</h1>
    <button onclick="window.print()">🖨️ Stampa / Salva PDF</button>
    <button class="secondary" onclick="window.close()">Chiudi</button>
  </div>

  <div class="doc-wrap">
    <header class="cover">
      <div class="title-block">
        <h1>Polimetriche Tariffarie</h1>
        <div class="sub">${escape(agency)} · Matrice Origine/Destinazione delle tariffe per rete</div>
      </div>
      <div class="meta">
        <strong>${networks.length} reti tariffarie</strong><br>
        ${networks.reduce((a, n) => a + n.areas.length, 0)} zone · ${networks.reduce((a, n) => a + n.stats.totalRules, 0)} tariffe<br>
        <span class="meta-pill">Metodo: ${escape(zoningLabel)}</span><br>
        <span class="meta-pill">${escape(dateStr)}</span>
      </div>
    </header>

    ${sections}

    ${summary}

    <div class="footer">
      Generato da TransitIntel · Fares Engine · ${new Date().toLocaleString("it-IT")}<br>
      Conforme GTFS Fares V2 · I prezzi indicati sono quelli associati alle fare_leg_rules generate.
    </div>
  </div>

  <script>
    // Auto-apri dialog di stampa dopo breve delay (solo se l'utente non è già intervenuto)
    // Disabilitato di default: l'utente clicca "Stampa" quando è pronto.
  </script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=1400,height=900");
  if (!w) {
    alert("Il browser ha bloccato la finestra di stampa. Abilita i popup e riprova.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
