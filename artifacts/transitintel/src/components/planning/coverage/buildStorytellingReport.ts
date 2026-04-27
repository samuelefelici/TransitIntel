/**
 * buildStorytellingReport — report HTML narrativo per stakeholder non tecnici.
 * Linguaggio semplice, vietato l'uso di gergo: "buffer", "isocrona", "gravity model",
 * "gtfs", "headway", "shape", "service_id".
 */

const BANNED_WORDS = ["buffer", "isocrona", "gravity model", "gtfs", "headway", "shape", "service_id"];

export function checkBannedWords(html: string): string[] {
  const lower = html.toLowerCase();
  return BANNED_WORDS.filter((w) => lower.includes(w));
}

type Findings = {
  populationCoverage: number;
  poiCoverage: number;
  uncoveredPopulation: number;
  totalPopulation: number;
  unservedPoisCount: number;
  costPerInhabitant: number;
  costDay: number;
  dayLabel: string;
  seasonLabel: string;
  alignmentIndex?: number | null;
  routeContribution?: number | null;
  populationLost?: number | null;
  filteredRoutes?: string[];
};

export type StorytellingInput = {
  feedName: string;
  findings: Findings;
  mapMain?: string | null;       // dataURL screenshot principale
  mapGaps?: string | null;       // dataURL screenshot zone scoperte
  radarSvg?: string | null;      // SVG radar inline (opzionale)
  topUnservedPois: { name: string; categoryLabel: string; distanceM: number }[];
  topInterventions: { title: string; rationale: string; expectedImpact: string }[];
  hourlyHighlights?: { underHours: number[]; overHours: number[] };
};

const fmtNum = (n: number, d = 0) =>
  new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(n);
const fmtEur = (n: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

export function buildStorytellingReport(input: StorytellingInput): string {
  const f = input.findings;
  const today = new Date().toLocaleDateString("it-IT");

  const coverageTone =
    f.populationCoverage >= 70 ? "good" : f.populationCoverage >= 40 ? "warn" : "bad";

  const headline =
    f.populationCoverage >= 70
      ? `Il trasporto pubblico raggiunge a piedi <strong>${f.populationCoverage}%</strong> dei cittadini: una buona base.`
      : f.populationCoverage >= 40
      ? `Il trasporto pubblico raggiunge a piedi <strong>${f.populationCoverage}%</strong> dei cittadini: ci sono margini di miglioramento.`
      : `Il trasporto pubblico raggiunge a piedi solo <strong>${f.populationCoverage}%</strong> dei cittadini: ampie zone restano scoperte.`;

  const alignmentText =
    f.alignmentIndex == null
      ? ""
      : f.alignmentIndex >= 70
      ? `<p>Le corse sono <strong>ben distribuite nell'arco della giornata</strong>: l'offerta segue da vicino quando i cittadini si muovono di più (indice di allineamento <strong>${f.alignmentIndex}/100</strong>).</p>`
      : f.alignmentIndex >= 50
      ? `<p>L'orario delle corse <strong>è solo parzialmente in linea con i momenti di maggior bisogno</strong> (indice <strong>${f.alignmentIndex}/100</strong>): vale la pena rivedere alcune fasce orarie.</p>`
      : `<p>L'orario delle corse <strong>non segue bene i momenti di maggior bisogno</strong> della giornata (indice <strong>${f.alignmentIndex}/100</strong>): pochi mezzi quando servono di più, troppi quando la richiesta è bassa.</p>`;

  const hourlyText = (() => {
    if (!input.hourlyHighlights) return "";
    const u = input.hourlyHighlights.underHours;
    const o = input.hourlyHighlights.overHours;
    if (u.length === 0 && o.length === 0) return "";
    const parts: string[] = [];
    if (u.length > 0) parts.push(`In queste ore i cittadini hanno bisogno del bus ma le corse scarseggiano: <strong>${u.map((h) => `${h}:00`).join(", ")}</strong>`);
    if (o.length > 0) parts.push(`Qui invece girano molti mezzi anche se la domanda è limitata: <strong>${o.map((h) => `${h}:00`).join(", ")}</strong>`);
    return `<p>${parts.join(". ")}.</p>`;
  })();

  const lineText = (() => {
    if (f.routeContribution == null || !f.filteredRoutes?.length) return "";
    const lines = f.filteredRoutes.length <= 3 ? f.filteredRoutes.join(", ") : `${f.filteredRoutes.slice(0, 3).join(", ")} e altre ${f.filteredRoutes.length - 3}`;
    if (f.routeContribution >= 60) {
      return `<p>Le linee selezionate (<strong>${lines}</strong>) servono territorio in larga parte esclusivo: ${f.routeContribution}% della copertura totale dipende da loro. Senza queste linee, circa <strong>${fmtNum(f.populationLost ?? 0)} abitanti</strong> resterebbero senza servizio.</p>`;
    } else if (f.routeContribution >= 30) {
      return `<p>Le linee selezionate (<strong>${lines}</strong>) contribuiscono per il <strong>${f.routeContribution}%</strong> alla copertura totale, con sovrapposizione parziale ad altre linee.</p>`;
    } else {
      return `<p>Le linee selezionate (<strong>${lines}</strong>) aggiungono solo il <strong>${f.routeContribution}%</strong> di copertura esclusiva: il loro percorso è già in gran parte servito da altre linee.</p>`;
    }
  })();

  const interventionsHtml = input.topInterventions.length === 0
    ? `<div class="callout">Nessun intervento prioritario emerso dall'analisi: il servizio appare già allineato ai bisogni.</div>`
    : input.topInterventions.slice(0, 5).map((i, idx) => `
        <div class="intervention">
          <div class="intervention-num">${idx + 1}</div>
          <div>
            <div class="intervention-title">${esc(i.title)}</div>
            <div class="intervention-why"><em>Perché:</em> ${esc(i.rationale)}</div>
            <div class="intervention-impact"><em>Impatto atteso:</em> ${esc(i.expectedImpact)}</div>
          </div>
        </div>`).join("");

  const unservedHtml = input.topUnservedPois.length === 0
    ? ""
    : `<h3>Luoghi importanti non raggiunti dal servizio</h3>
       <ul class="poi-list">
         ${input.topUnservedPois.slice(0, 8).map((p) => `<li><strong>${esc(p.name)}</strong> <span class="muted">(${esc(p.categoryLabel)})</span> — fermata più vicina a ${fmtNum(p.distanceM)} m</li>`).join("")}
       </ul>`;

  const html = `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><title>Il trasporto pubblico nella tua città — ${esc(input.feedName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, "Times New Roman", serif; margin: 0 auto; padding: 32px 40px; color: #1a202c; line-height: 1.6; max-width: 820px; background: #fafaf7; }
  h1 { font-size: 30px; margin: 0 0 4px; color: #1a202c; font-weight: 700; line-height: 1.2; }
  h2 { font-size: 22px; margin: 36px 0 12px; color: #1a202c; border-bottom: 1px solid #cbd5e0; padding-bottom: 6px; }
  h3 { font-size: 16px; margin: 20px 0 8px; color: #2d3748; }
  .meta { font-size: 13px; color: #718096; margin-bottom: 24px; font-family: -apple-system, sans-serif; }
  .headline { font-size: 18px; line-height: 1.5; padding: 16px 20px; border-left: 5px solid #3182ce; background: #ebf8ff; border-radius: 4px; margin: 16px 0 24px; }
  .headline.good { border-color: #38a169; background: #f0fff4; }
  .headline.warn { border-color: #d69e2e; background: #fffff0; }
  .headline.bad  { border-color: #e53e3e; background: #fff5f5; }
  .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
  .kpi { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px; text-align: center; }
  .kpi-num { font-size: 26px; font-weight: 700; color: #2d3748; font-family: -apple-system, sans-serif; }
  .kpi-lbl { font-size: 11px; color: #718096; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px; font-family: -apple-system, sans-serif; }
  .map-wrap { margin: 16px 0; border: 1px solid #cbd5e0; border-radius: 6px; overflow: hidden; background: #1a202c; }
  .map-wrap img { display: block; width: 100%; height: auto; }
  .map-caption { font-size: 12px; color: #718096; padding: 6px 10px; background: #fff; border-top: 1px solid #e2e8f0; font-family: -apple-system, sans-serif; }
  .intervention { display: flex; gap: 14px; padding: 14px 16px; margin: 10px 0; background: #fff; border: 1px solid #e2e8f0; border-radius: 6px; }
  .intervention-num { flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; background: #3182ce; color: #fff; font-weight: 700; display: flex; align-items: center; justify-content: center; font-family: -apple-system, sans-serif; }
  .intervention-title { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
  .intervention-why, .intervention-impact { font-size: 13px; color: #4a5568; margin-top: 3px; }
  .poi-list { padding-left: 20px; }
  .poi-list li { margin: 4px 0; font-size: 14px; }
  .muted { color: #718096; font-size: 12px; }
  .callout { background: #f0fff4; border-left: 4px solid #38a169; padding: 12px 16px; margin: 12px 0; font-style: italic; }
  .footer-note { margin-top: 40px; padding-top: 16px; border-top: 1px solid #cbd5e0; font-size: 11px; color: #a0aec0; font-family: -apple-system, sans-serif; }
  .toolbar { position: sticky; top: 0; background: #fafaf7; padding: 8px 0; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; z-index: 10; }
  .btn { display: inline-block; padding: 6px 14px; background: #3182ce; color: #fff; border: 0; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: -apple-system, sans-serif; }
  @media print {
    .toolbar { display: none; }
    body { padding: 12mm 18mm; max-width: none; background: #fff; }
    .intervention, .map-wrap { page-break-inside: avoid; }
  }
</style>
</head><body>

<div class="toolbar">
  <button class="btn" onclick="window.print()">🖨 Stampa / Salva PDF</button>
  <span style="margin-left:12px; font-size:11px; color:#718096;">Generato ${today}</span>
</div>

<h1>Il trasporto pubblico nella tua città</h1>
<div class="meta">${esc(input.feedName)} — analisi di ${esc(f.dayLabel.toLowerCase())} (${esc(f.seasonLabel.toLowerCase())})</div>

<div class="headline ${coverageTone}">${headline}</div>

<h2>In sintesi</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="kpi-num">${f.populationCoverage}%</div><div class="kpi-lbl">cittadini raggiunti a piedi</div></div>
  <div class="kpi"><div class="kpi-num">${f.poiCoverage}%</div><div class="kpi-lbl">luoghi importanti serviti</div></div>
  <div class="kpi"><div class="kpi-num">${fmtEur(f.costPerInhabitant)}</div><div class="kpi-lbl">costo per cittadino al giorno</div></div>
</div>

<p>Su una popolazione totale di <strong>${fmtNum(f.totalPopulation)} abitanti</strong>, oggi il servizio raggiunge a piedi (5–10 minuti dalla fermata) circa <strong>${fmtNum(f.totalPopulation - f.uncoveredPopulation)} persone</strong>. Restano fuori <strong>${fmtNum(f.uncoveredPopulation)} abitanti</strong> che vivono in zone non servite da fermate attive.</p>

${input.mapMain ? `
<div class="map-wrap">
  <img src="${input.mapMain}" alt="Mappa della copertura del servizio"/>
  <div class="map-caption">Le aree colorate in verde indicano dove i cittadini possono raggiungere una fermata a piedi. Le linee colorate sono i percorsi delle corse.</div>
</div>` : ""}

${alignmentText}
${hourlyText}
${lineText}

${input.mapGaps ? `
<h2>Le zone scoperte</h2>
<p>I punti rossi e arancioni sulla mappa indicano i quartieri dove vivono persone ma non c'è una fermata raggiungibile a piedi. Le dimensioni del punto sono proporzionali al numero di abitanti coinvolti.</p>
<div class="map-wrap">
  <img src="${input.mapGaps}" alt="Mappa delle zone non servite"/>
  <div class="map-caption">Più scuro il colore, più la zona è lontana da una fermata. Più grande il cerchio, più persone coinvolte.</div>
</div>` : ""}

${unservedHtml}

<h2>Cosa si può fare</h2>
<p>Sulla base dei dati analizzati, ecco gli interventi più utili in ordine di priorità:</p>
${interventionsHtml}

<div class="footer-note">
  Questa analisi è stata generata automaticamente incrociando i dati del servizio di trasporto pubblico locale con i dati di popolazione (sezioni censuarie ISTAT) e i luoghi pubblici di interesse della città. I valori sono stime basate sulla rete attuale e non sostituiscono un'analisi di pianificazione di dettaglio.
</div>

<script>setTimeout(() => window.focus(), 100);</script>
</body></html>`;

  return html;
}

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
}
