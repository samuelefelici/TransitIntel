/**
 * Zonizzazione — export HTML/PDF dei km sviluppati per comune.
 *
 * Genera un documento stampabile (una finestra separata con CSS `@page`, come
 * `fares-polimetriche-export.ts`) pensato per essere allegato ai corrispettivi
 * chilometrici dovuti agli enti locali. L'obiettivo è rendere TRASPARENTE il
 * calcolo: per ogni comune si mostrano i km/anno ripartiti per
 *   • linea       (route del progetto)
 *   • calendario aziendale (ps_calendars: pattern settimanale + validità)
 *   • giorno della settimana (lun…dom)
 * più una pagina di metodologia che spiega da dove vengono i numeri.
 *
 * Struttura del PDF:
 *   1. Copertina         — agenzia, progetto, anno, totali chiave
 *   2. Metodologia       — come si calcolano i km per comune
 *   3. Calendari aziendali — definizione (pattern, validità, giorni attivi)
 *   4. Riepilogo comuni  — tabella comune → km/anno (+ % sul totale)
 *   5. Totali di rete    — km/anno per calendario e per giorno settimana
 *   6. Dettaglio comune  — per ogni comune: linee + ripartizione cal/giorni
 *
 * Il calcolo è fatto dal backend (`POST /planning-studio/:id/zones/compute`):
 * qui non si ricalcola nulla, si formatta soltanto.
 */

/* ─── Tipi (specchio del payload backend arricchito) ─── */
export interface CalendarKm {
  calendarId: string;
  code: string | null;
  name: string;
  kmYear: number;
  runsYear: number;
}
export interface WeekdayKm {
  dow: string; // monday…sunday
  kmYear: number;
  runsYear: number;
}
export interface ZoneRouteKm {
  routeId: string;
  shortName: string;
  color: string | null;
  kmYear: number;
  runsYear: number;
  kmPerRun: number;
  byCalendar?: CalendarKm[];
  byWeekday?: WeekdayKm[];
}
export interface ZoneKm {
  zoneId: string;
  name: string;
  istatCode: string | null;
  totalKmYear: number;
  byRoute: ZoneRouteKm[];
}
export interface CalendarDef {
  id: string;
  code: string | null;
  name: string;
  weekdays: Record<string, boolean> | null;
  startDate: string | null;
  endDate: string | null;
  activeDays: number;
  runsYear: number;
  kmYear: number;
}
export interface ZonizzazioneResult {
  year: number;
  zones: ZoneKm[];
  unassignedKm: number;
  calendars?: CalendarDef[];
  totals?: { byCalendar: CalendarKm[]; byWeekday: WeekdayKm[] };
  meta?: { zoneCount: number; variantCount: number; tripCount: number };
}
export interface ZonizzazioneExportOpts {
  year: number;
  projectName?: string;
  agencyName?: string;
}

/* ─── Helpers ─── */

const escapeHtml = (s: string | number | null | undefined): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));

const fmtKm = (v: number): string =>
  (isFinite(v) ? v : 0).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const fmtInt = (v: number): string =>
  (isFinite(v) ? Math.round(v) : 0).toLocaleString("it-IT");

const fmtPct = (v: number): string =>
  (isFinite(v) ? v : 0).toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";

/** Colore linea GTFS → hex valido su fondo chiaro (fallback verde acqua). */
function lineColor(c: string | null | undefined): string {
  const FALLBACK = "#0f766e";
  if (!c) return FALLBACK;
  const hex = c.replace("#", "").trim();
  if ((hex.length !== 3 && hex.length !== 6) || !/^[0-9a-fA-F]+$/.test(hex)) return FALLBACK;
  const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.9) return FALLBACK; // bianco/quasi-bianco: invisibile
  return "#" + full.toLowerCase();
}

const DOW_SEQ = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DOW_SHORT: Record<string, string> = {
  monday: "Lun", tuesday: "Mar", wednesday: "Mer", thursday: "Gio",
  friday: "Ven", saturday: "Sab", sunday: "Dom",
};
const DOW_FULL: Record<string, string> = {
  monday: "Lunedì", tuesday: "Martedì", wednesday: "Mercoledì", thursday: "Giovedì",
  friday: "Venerdì", saturday: "Sabato", sunday: "Domenica",
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
};

/* ─── Aggregazioni a livello comune (somma delle linee) ─── */

function comuneByCalendar(zone: ZoneKm): CalendarKm[] {
  const acc = new Map<string, CalendarKm>();
  for (const r of zone.byRoute) {
    for (const c of r.byCalendar ?? []) {
      const e = acc.get(c.calendarId) ?? { calendarId: c.calendarId, code: c.code, name: c.name, kmYear: 0, runsYear: 0 };
      e.kmYear += c.kmYear; e.runsYear += c.runsYear;
      acc.set(c.calendarId, e);
    }
  }
  return Array.from(acc.values())
    .map((e) => ({ ...e, kmYear: Math.round(e.kmYear * 10) / 10 }))
    .sort((a, b) => b.kmYear - a.kmYear);
}

function comuneByWeekday(zone: ZoneKm): WeekdayKm[] {
  const acc = new Map<string, WeekdayKm>();
  for (const r of zone.byRoute) {
    for (const w of r.byWeekday ?? []) {
      const e = acc.get(w.dow) ?? { dow: w.dow, kmYear: 0, runsYear: 0 };
      e.kmYear += w.kmYear; e.runsYear += w.runsYear;
      acc.set(w.dow, e);
    }
  }
  return DOW_SEQ
    .map((dow) => acc.get(dow) ?? { dow, kmYear: 0, runsYear: 0 })
    .map((e) => ({ ...e, kmYear: Math.round(e.kmYear * 10) / 10 }));
}

/* ─── Sezioni HTML ─── */

function renderCover(result: ZonizzazioneResult, opts: ZonizzazioneExportOpts, grandTotal: number, genDate: string): string {
  const comuni = result.zones.length;
  const linee = new Set<string>();
  for (const z of result.zones) for (const r of z.byRoute) linee.add(r.routeId);
  const calCount = (result.calendars ?? []).filter((c) => c.kmYear > 0 || c.runsYear > 0).length;

  return `
    <section class="page cover">
      <div class="cover-brand">
        <span class="brand-mark">CERBERO</span>
        <span class="brand-sub">Network Engine</span>
      </div>
      <div class="cover-top">
        <div class="cover-kicker">Corrispettivi chilometrici · Documento tecnico</div>
        <h1 class="cover-title">Zonizzazione — Km sviluppati per comune</h1>
        <div class="cover-subtitle">Percorrenza annua del servizio ripartita per comune, linea, calendario aziendale e giorno della settimana</div>
      </div>

      <div class="cover-meta">
        <div class="cm-row"><span class="cm-label">Agenzia</span><span class="cm-value">${escapeHtml(opts.agencyName || "—")}</span></div>
        <div class="cm-row"><span class="cm-label">Progetto</span><span class="cm-value">${escapeHtml(opts.projectName || "—")}</span></div>
        <div class="cm-row"><span class="cm-label">Anno di riferimento</span><span class="cm-value">${escapeHtml(result.year)}</span></div>
        <div class="cm-row"><span class="cm-label">Data emissione</span><span class="cm-value">${escapeHtml(genDate)}</span></div>
      </div>

      <div class="cover-kpis">
        <div class="ck-card"><div class="ck-num">${fmtKm(grandTotal)}</div><div class="ck-lbl">Km/anno totali nei comuni</div></div>
        <div class="ck-card"><div class="ck-num">${fmtInt(comuni)}</div><div class="ck-lbl">Comuni interessati</div></div>
        <div class="ck-card"><div class="ck-num">${fmtInt(linee.size)}</div><div class="ck-lbl">Linee</div></div>
        <div class="ck-card"><div class="ck-num">${fmtInt(calCount)}</div><div class="ck-lbl">Calendari aziendali</div></div>
      </div>

      <div class="cover-note">
        I km sono calcolati intersecando la geometria di ogni linea con i confini amministrativi dei comuni e
        moltiplicando i km all'interno di ciascun comune per il numero di corse annue effettivamente circolanti
        (derivate da calendari aziendali, eccezioni e validità delle corse). Il dettaglio del metodo è nella pagina
        seguente.
      </div>

      <div class="cover-foot">
        <div>${escapeHtml(opts.agencyName || "")} · Generato con <strong>Cerbero Network Engine</strong></div>
        <div>${escapeHtml(genDate)}</div>
      </div>
    </section>`;
}

function renderMethodology(result: ZonizzazioneResult): string {
  return `
    <section class="page">
      <h2 class="sec-title">Metodologia di calcolo</h2>
      <p class="lead">
        Ogni valore in km/anno è il prodotto di due grandezze indipendenti: <strong>quanti km di percorso
        ricadono dentro il comune</strong> e <strong>quante volte quel percorso viene effettuato in un anno</strong>.
      </p>

      <ol class="method">
        <li>
          <strong>Geometria delle linee.</strong> Per ogni variante di percorso del progetto si usa la shape
          (sequenza di punti geografici). La lunghezza totale è la somma delle distanze <em>haversine</em> tra
          punti consecutivi.
        </li>
        <li>
          <strong>Km dentro ogni comune.</strong> La linea viene intersecata con il confine di ciascun comune
          (poligono ISTAT). Con un pre-filtro sui bounding box e un test punto-in-poligono (ray casting) si
          ottiene la porzione di percorso interna al comune: <code>km_dentro(linea, comune)</code>. I tratti
          che non ricadono in nessun comune caricato confluiscono in «Km fuori da ogni comune».
        </li>
        <li>
          <strong>Corse/anno per linea.</strong> Da ogni corsa (trip) si ricava l'insieme dei giorni di
          circolazione nell'anno: pattern settimanale del <em>calendario aziendale</em> (lun…dom) intersecato
          con il periodo di validità del calendario e con l'anno, poi corretto dalle eccezioni di calendario
          (giorni aggiunti/rimossi) e dalla validità della singola corsa. Il numero di corse/anno della linea è
          la somma dei giorni di circolazione delle sue corse.
        </li>
        <li>
          <strong>Km/anno per comune.</strong> Per ogni coppia (linea, comune):
          <div class="formula">km/anno = km_dentro(linea, comune) × corse/anno(linea)</div>
          Il totale del comune è la somma su tutte le linee che lo attraversano.
        </li>
        <li>
          <strong>Ripartizioni.</strong> Lo stesso insieme di giorni di circolazione viene ripartito per
          <strong>calendario aziendale</strong> e per <strong>giorno della settimana</strong>: sono due
          partizioni esatte, quindi la somma dei km per calendario e la somma dei km per giorno coincidono
          entrambe con i km/anno della linea nel comune. Questo permette di verificare i totali da più angolazioni.
        </li>
      </ol>

      <div class="method-params">
        <span>Zone (confini) caricate: <strong>${fmtInt(result.meta?.zoneCount ?? 0)}</strong></span>
        <span>Varianti di percorso: <strong>${fmtInt(result.meta?.variantCount ?? 0)}</strong></span>
        <span>Corse (trip) attive: <strong>${fmtInt(result.meta?.tripCount ?? 0)}</strong></span>
      </div>
    </section>`;
}

function renderCalendars(result: ZonizzazioneResult): string {
  const cals = (result.calendars ?? []).filter((c) => c.id !== "__nocal__");
  const noCal = (result.calendars ?? []).find((c) => c.id === "__nocal__");
  if (cals.length === 0 && !noCal) return "";

  const dowHead = DOW_SEQ.map((d) => `<th class="dow-h">${DOW_SHORT[d]}</th>`).join("");
  const rows = cals.map((c) => {
    const dows = DOW_SEQ.map((d) => {
      const on = c.weekdays?.[d];
      return `<td class="dow-c ${on ? "on" : "off"}">${on ? "●" : "·"}</td>`;
    }).join("");
    return `
      <tr>
        <td class="cal-name"><strong>${escapeHtml(c.name)}</strong>${c.code ? `<span class="cal-code">${escapeHtml(c.code)}</span>` : ""}</td>
        ${dows}
        <td class="num">${fmtDate(c.startDate)} – ${fmtDate(c.endDate)}</td>
        <td class="num">${fmtInt(c.activeDays)}</td>
        <td class="num">${fmtInt(c.runsYear)}</td>
        <td class="num strong">${fmtKm(c.kmYear)}</td>
      </tr>`;
  }).join("");
  const noCalRow = noCal ? `
      <tr class="nocal">
        <td class="cal-name"><strong>${escapeHtml(noCal.name)}</strong></td>
        ${DOW_SEQ.map(() => `<td class="dow-c off">·</td>`).join("")}
        <td class="num">—</td><td class="num">—</td>
        <td class="num">${fmtInt(noCal.runsYear)}</td>
        <td class="num strong">${fmtKm(noCal.kmYear)}</td>
      </tr>` : "";

  return `
    <section class="page">
      <h2 class="sec-title">Calendari aziendali</h2>
      <p class="lead">Ogni calendario definisce i giorni della settimana in cui il servizio circola e il periodo
        di validità. «Giorni attivi» sono i giorni di calendario nell'anno (già al netto delle eccezioni di calendario).</p>
      <table class="grid cal-table">
        <thead>
          <tr>
            <th class="left">Calendario</th>
            ${dowHead}
            <th>Validità</th>
            <th>Giorni attivi</th>
            <th>Corse/anno</th>
            <th>Km/anno</th>
          </tr>
        </thead>
        <tbody>${rows}${noCalRow}</tbody>
      </table>
    </section>`;
}

function renderSummary(result: ZonizzazioneResult, grandTotal: number): string {
  const rows = result.zones.map((z, i) => {
    const pct = grandTotal > 0 ? (z.totalKmYear / grandTotal) * 100 : 0;
    return `
      <tr>
        <td class="rank">${i + 1}</td>
        <td class="left"><strong>${escapeHtml(z.name)}</strong></td>
        <td class="mono">${escapeHtml(z.istatCode || "—")}</td>
        <td class="num strong">${fmtKm(z.totalKmYear)}</td>
        <td class="num">${fmtInt(z.byRoute.length)}</td>
        <td class="bar-cell">
          <div class="bar"><div class="bar-fill" style="width:${Math.max(1, Math.min(100, pct)).toFixed(1)}%"></div></div>
          <span class="bar-lbl">${fmtPct(pct)}</span>
        </td>
      </tr>`;
  }).join("");

  return `
    <section class="page">
      <h2 class="sec-title">Riepilogo km per comune · ${escapeHtml(result.year)}</h2>
      <table class="grid summary-table">
        <thead>
          <tr>
            <th>#</th><th class="left">Comune</th><th>ISTAT</th>
            <th>Km/anno</th><th>Linee</th><th class="left">Quota</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="tot">
            <td></td><td class="left">Totale nei comuni</td><td></td>
            <td class="num strong">${fmtKm(grandTotal)}</td><td></td><td></td>
          </tr>
          <tr class="tot muted">
            <td></td><td class="left">Km fuori da ogni comune</td><td></td>
            <td class="num">${fmtKm(result.unassignedKm)}</td><td></td><td></td>
          </tr>
        </tfoot>
      </table>
    </section>`;
}

function renderNetworkTotals(result: ZonizzazioneResult, grandTotal: number): string {
  const byCal = result.totals?.byCalendar ?? [];
  const byDow = result.totals?.byWeekday ?? [];
  if (byCal.length === 0 && byDow.length === 0) return "";

  const maxCal = Math.max(1, ...byCal.map((c) => c.kmYear));
  const calRows = byCal.map((c) => {
    const pct = grandTotal > 0 ? (c.kmYear / grandTotal) * 100 : 0;
    return `
      <tr>
        <td class="left"><strong>${escapeHtml(c.name)}</strong>${c.code ? `<span class="cal-code">${escapeHtml(c.code)}</span>` : ""}</td>
        <td class="num">${fmtInt(c.runsYear)}</td>
        <td class="num strong">${fmtKm(c.kmYear)}</td>
        <td class="bar-cell">
          <div class="bar"><div class="bar-fill" style="width:${Math.max(1, (c.kmYear / maxCal) * 100).toFixed(1)}%"></div></div>
          <span class="bar-lbl">${fmtPct(pct)}</span>
        </td>
      </tr>`;
  }).join("");

  const maxDow = Math.max(1, ...byDow.map((d) => d.kmYear));
  const totDow = byDow.reduce((s, d) => s + d.kmYear, 0);
  const dowRows = byDow.map((d) => {
    const pct = totDow > 0 ? (d.kmYear / totDow) * 100 : 0;
    return `
      <tr>
        <td class="left"><strong>${DOW_FULL[d.dow] ?? d.dow}</strong></td>
        <td class="num">${fmtInt(d.runsYear)}</td>
        <td class="num strong">${fmtKm(d.kmYear)}</td>
        <td class="bar-cell">
          <div class="bar"><div class="bar-fill dow" style="width:${Math.max(1, (d.kmYear / maxDow) * 100).toFixed(1)}%"></div></div>
          <span class="bar-lbl">${fmtPct(pct)}</span>
        </td>
      </tr>`;
  }).join("");

  return `
    <section class="page">
      <h2 class="sec-title">Totali di rete per calendario e per giorno</h2>
      <p class="lead">Km/anno sviluppati <strong>dentro i comuni</strong>, ripartiti per calendario aziendale e per
        giorno della settimana. Sono ripartizioni dello stesso totale (${fmtKm(grandTotal)} km/anno).</p>

      <h3 class="sub-title">Per calendario aziendale</h3>
      <table class="grid">
        <thead><tr><th class="left">Calendario</th><th>Corse/anno</th><th>Km/anno</th><th class="left">Quota</th></tr></thead>
        <tbody>${calRows}</tbody>
      </table>

      <h3 class="sub-title">Per giorno della settimana</h3>
      <table class="grid">
        <thead><tr><th class="left">Giorno</th><th>Corse/anno</th><th>Km/anno</th><th class="left">Quota</th></tr></thead>
        <tbody>${dowRows}</tbody>
      </table>
    </section>`;
}

function renderZoneDetail(zone: ZoneKm, year: number): string {
  const byCal = comuneByCalendar(zone);
  const byDow = comuneByWeekday(zone);
  const maxDow = Math.max(1, ...byDow.map((d) => d.kmYear));

  // Tabella linee: km/anno, corse/anno, km/corsa + ripartizione calendario inline
  const lineRows = zone.byRoute.map((r) => {
    const col = lineColor(r.color);
    const calInline = (r.byCalendar ?? []).length > 0
      ? `<div class="line-cal">${(r.byCalendar ?? [])
          .map((c) => `<span class="ci"><span class="ci-name">${escapeHtml(c.name)}</span> ${fmtKm(c.kmYear)}</span>`)
          .join("<span class='ci-sep'>·</span>")}</div>`
      : "";
    return `
      <tr>
        <td class="left">
          <span class="line-pill" style="background:${col}">${escapeHtml(r.shortName)}</span>
          ${calInline}
        </td>
        <td class="num strong">${fmtKm(r.kmYear)}</td>
        <td class="num">${fmtInt(r.runsYear)}</td>
        <td class="num">${fmtKm(r.kmPerRun)}</td>
      </tr>`;
  }).join("");

  const calRows = byCal.map((c) => `
      <tr>
        <td class="left">${escapeHtml(c.name)}</td>
        <td class="num">${fmtInt(c.runsYear)}</td>
        <td class="num strong">${fmtKm(c.kmYear)}</td>
      </tr>`).join("");

  const dowRows = byDow.map((d) => `
      <tr>
        <td class="left">${DOW_FULL[d.dow] ?? d.dow}</td>
        <td class="num">${fmtInt(d.runsYear)}</td>
        <td class="num strong">${fmtKm(d.kmYear)}</td>
        <td class="bar-cell narrow">
          <div class="bar sm"><div class="bar-fill dow" style="width:${Math.max(1, (d.kmYear / maxDow) * 100).toFixed(1)}%"></div></div>
        </td>
      </tr>`).join("");

  return `
    <section class="zone-block">
      <header class="zone-head">
        <div class="zh-name">${escapeHtml(zone.name)}${zone.istatCode ? `<span class="zh-istat">ISTAT ${escapeHtml(zone.istatCode)}</span>` : ""}</div>
        <div class="zh-km"><span class="zh-num">${fmtKm(zone.totalKmYear)}</span> km/anno ${escapeHtml(year)}</div>
      </header>

      <div class="zone-tables">
        <div class="zt zt-lines">
          <div class="zt-title">Per linea</div>
          <table class="grid slim">
            <thead><tr><th class="left">Linea</th><th>Km/anno</th><th>Corse/anno</th><th>Km/corsa</th></tr></thead>
            <tbody>${lineRows}</tbody>
          </table>
        </div>

        <div class="zt-split">
          <div class="zt">
            <div class="zt-title">Per calendario aziendale</div>
            <table class="grid slim">
              <thead><tr><th class="left">Calendario</th><th>Corse</th><th>Km/anno</th></tr></thead>
              <tbody>${calRows || `<tr><td colspan="3" class="empty">—</td></tr>`}</tbody>
            </table>
          </div>
          <div class="zt">
            <div class="zt-title">Per giorno della settimana</div>
            <table class="grid slim">
              <thead><tr><th class="left">Giorno</th><th>Corse</th><th>Km/anno</th><th></th></tr></thead>
              <tbody>${dowRows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </section>`;
}

/* ─── CSS di stampa ─── */

const STYLES = `
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#0e7490; --accent-soft:#ecfeff; --bg:#ffffff; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:#f1f5f9; color:var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .doc { max-width: 210mm; margin: 0 auto; }
  .page { background: var(--bg); padding: 16mm 14mm; margin: 8mm auto; box-shadow: 0 1px 6px rgba(0,0,0,.12); border-radius: 4px; }
  .zone-block { background: var(--bg); padding: 8mm 14mm; margin: 4mm auto; box-shadow: 0 1px 6px rgba(0,0,0,.12); border-radius:4px; break-inside: avoid; page-break-inside: avoid; }

  /* Toolbar (nascosta in stampa) */
  .toolbar { position: sticky; top:0; z-index:10; display:flex; gap:10px; align-items:center; justify-content:center; padding:10px; background:#0f172a; color:#fff; }
  .toolbar button { font-size:13px; font-weight:600; padding:8px 16px; border-radius:6px; border:0; cursor:pointer; }
  .btn-print { background:#06b6d4; color:#03222b; }
  .btn-close { background:#334155; color:#e2e8f0; }
  .toolbar .hint { font-size:11px; color:#94a3b8; }

  /* Copertina */
  .cover { min-height: 250mm; display:flex; flex-direction:column; }
  .cover-brand { display:flex; align-items:baseline; gap:10px; margin-bottom:14mm; }
  .brand-mark { font-size:22px; font-weight:900; letter-spacing:.22em; color:var(--accent); }
  .brand-sub { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.18em; color:var(--muted); }
  .cover-top { border-bottom: 3px solid var(--accent); padding-bottom: 10mm; }
  .cover-kicker { text-transform:uppercase; letter-spacing:.14em; font-size:11px; color:var(--accent); font-weight:700; }
  .cover-title { font-size:30px; line-height:1.15; margin:8px 0 6px; font-weight:800; }
  .cover-subtitle { font-size:14px; color:var(--muted); max-width: 150mm; }
  .cover-meta { margin: 12mm 0; display:grid; grid-template-columns: 1fr 1fr; gap: 4mm 12mm; }
  .cm-row { display:flex; flex-direction:column; border-left:3px solid var(--line); padding-left:10px; }
  .cm-label { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .cm-value { font-size:15px; font-weight:600; }
  .cover-kpis { display:grid; grid-template-columns: repeat(4, 1fr); gap: 6mm; margin: 6mm 0; }
  .ck-card { background:var(--accent-soft); border:1px solid #cffafe; border-radius:8px; padding:14px 12px; text-align:center; }
  .ck-num { font-size:20px; font-weight:800; color:var(--accent); }
  .ck-lbl { font-size:10px; color:var(--muted); margin-top:4px; line-height:1.25; }
  .cover-note { font-size:12px; color:#475569; line-height:1.55; background:#f8fafc; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-top:auto; }
  .cover-foot { display:flex; justify-content:space-between; font-size:10px; color:var(--muted); border-top:1px solid var(--line); margin-top:8mm; padding-top:4mm; }

  /* Titoli */
  .sec-title { font-size:19px; font-weight:800; margin:0 0 4mm; padding-bottom:3mm; border-bottom:2px solid var(--accent); }
  .sub-title { font-size:14px; font-weight:700; margin:6mm 0 2mm; color:#334155; }
  .lead { font-size:12.5px; color:#475569; line-height:1.55; margin:0 0 5mm; }

  /* Metodologia */
  ol.method { padding-left: 18px; }
  ol.method li { font-size:12px; line-height:1.55; margin-bottom: 3mm; }
  .formula { margin:4px 0; padding:8px 12px; background:var(--accent-soft); border-left:3px solid var(--accent); border-radius:4px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:12px; color:#0e5566; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size:11.5px; background:#f1f5f9; padding:1px 5px; border-radius:3px; }
  .method-params { display:flex; gap:16px; flex-wrap:wrap; margin-top:6mm; font-size:11px; color:var(--muted); border-top:1px solid var(--line); padding-top:4mm; }

  /* Tabelle */
  table.grid { width:100%; border-collapse: collapse; font-size:11.5px; }
  table.grid th { background:#f1f5f9; color:#334155; font-weight:700; text-align:right; padding:6px 8px; border-bottom:2px solid #cbd5e1; font-size:10.5px; text-transform:uppercase; letter-spacing:.03em; }
  table.grid th.left, table.grid td.left { text-align:left; }
  table.grid td { padding:5px 8px; border-bottom:1px solid var(--line); text-align:right; vertical-align: middle; }
  table.grid td.num, table.grid td.mono { font-variant-numeric: tabular-nums; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  table.grid td.strong { font-weight:700; color:#0f172a; }
  table.grid tfoot td { border-top:2px solid #cbd5e1; font-weight:700; padding-top:7px; }
  table.grid tfoot .muted td { color:var(--muted); font-weight:600; border-top:1px solid var(--line); }
  table.grid .rank { color:var(--muted); font-size:10px; text-align:center; }
  table.grid.slim th { padding:4px 6px; font-size:9.5px; }
  table.grid.slim td { padding:3px 6px; font-size:10.5px; }
  .empty { text-align:center; color:var(--muted); }

  /* Barre */
  .bar-cell { width: 34%; }
  .bar-cell.narrow { width: 40px; }
  .bar { position:relative; height:9px; background:#eef2f7; border-radius:5px; overflow:hidden; display:inline-block; width: calc(100% - 44px); vertical-align:middle; }
  .bar.sm { height:7px; width:100%; }
  .bar-fill { position:absolute; left:0; top:0; bottom:0; background:linear-gradient(90deg,#0891b2,#22d3ee); border-radius:5px; }
  .bar-fill.dow { background:linear-gradient(90deg,#7c3aed,#a78bfa); }
  .bar-lbl { font-size:10px; color:var(--muted); font-variant-numeric: tabular-nums; margin-left:6px; }

  /* Calendari */
  .cal-table th.dow-h, .cal-table td.dow-c { text-align:center; width:24px; padding-left:2px; padding-right:2px; }
  td.dow-c.on { color:#059669; font-weight:800; }
  td.dow-c.off { color:#cbd5e1; }
  .cal-name .cal-code, .cal-code { display:inline-block; margin-left:6px; font-size:9px; color:var(--muted); background:#f1f5f9; padding:1px 5px; border-radius:3px; font-family: ui-monospace, monospace; }
  tr.nocal td { color:var(--muted); font-style:italic; }

  /* Blocco comune */
  .zone-head { display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid #cbd5e1; padding-bottom:3mm; margin-bottom:3mm; }
  .zh-name { font-size:16px; font-weight:800; }
  .zh-istat { font-size:10px; font-weight:600; color:var(--muted); margin-left:8px; font-family: ui-monospace, monospace; }
  .zh-km { font-size:11px; color:var(--muted); }
  .zh-num { font-size:17px; font-weight:800; color:var(--accent); }
  .zone-tables { display:flex; flex-direction:column; gap:4mm; }
  .zt-title { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:#475569; margin-bottom:1.5mm; }
  .zt-split { display:grid; grid-template-columns: 1fr 1.1fr; gap: 8mm; }
  .line-pill { display:inline-block; color:#fff; font-weight:800; font-size:10px; padding:2px 7px; border-radius:4px; }
  .line-cal { margin-top:2px; font-size:9px; color:var(--muted); line-height:1.4; }
  .line-cal .ci-name { color:#475569; }
  .line-cal .ci-sep { margin:0 4px; color:#cbd5e1; }

  /* Stampa */
  @media print {
    html, body { background:#fff; }
    .toolbar { display:none !important; }
    .page { box-shadow:none; margin:0; border-radius:0; padding:14mm 12mm; page-break-after: always; }
    .zone-block { box-shadow:none; margin:0 0 6mm; padding:0; }
    .zone-detail-page { page-break-before: always; }
  }
  @page { size: A4 portrait; margin: 0; }
`;

/* ─── Entry point ─── */

export function exportZonizzazioneHtml(result: ZonizzazioneResult, opts: ZonizzazioneExportOpts): void {
  const grandTotal = result.zones.reduce((s, z) => s + z.totalKmYear, 0);
  const genDate = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });

  // Dettaglio: una pagina di apertura con titolo, poi i blocchi comune a cascata
  // (ogni blocco non si spezza internamente grazie a break-inside: avoid).
  const detailHtml = `
    <section class="page zone-detail-page">
      <h2 class="sec-title">Dettaglio per comune · ${escapeHtml(result.year)}</h2>
      <p class="lead">Per ogni comune: km/anno per linea (con ripartizione per calendario sotto il nome della linea) e
        totali del comune per calendario aziendale e per giorno della settimana.</p>
    </section>
    ${result.zones.map((z) => renderZoneDetail(z, result.year)).join("")}
  `;

  const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Zonizzazione — Km per comune ${escapeHtml(result.year)}${opts.projectName ? ` · ${escapeHtml(opts.projectName)}` : ""}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-print" onclick="window.print()">🖨️ Stampa / Salva PDF</button>
    <button class="btn-close" onclick="window.close()">Chiudi</button>
    <span class="hint">Nella finestra di stampa scegli «Salva come PDF» e formato A4.</span>
  </div>
  <div class="doc">
    ${renderCover(result, opts, grandTotal, genDate)}
    ${renderMethodology(result)}
    ${renderCalendars(result)}
    ${renderSummary(result, grandTotal)}
    ${renderNetworkTotals(result, grandTotal)}
    ${detailHtml}
  </div>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    alert("Il browser ha bloccato l'apertura della finestra di stampa. Consenti i popup per questo sito e riprova.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
}
