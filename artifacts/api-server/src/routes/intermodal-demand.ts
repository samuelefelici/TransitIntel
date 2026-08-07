/* ═══════════════════════════════════════════════════════════════════════
 *  COPERTURA DELLA DOMANDA — le nostre linee servono i poli attrattori?
 *
 *  La sezione Intermodale nasceva come analisi hub-centrica: "quali bus
 *  coincidono con i treni". La domanda vera del pianificatore è l'opposto
 *  e più larga: le linee e le corse che ho costruito nel progetto
 *  soddisfano le esigenze di trasporto verso i poli che le generano?
 *
 *  Quattro famiglie di poli:
 *    ▸ STAZIONI   — nodi ferroviari (da discovery hub)
 *    ▸ AEROPORTI  — scali (da discovery hub)
 *    ▸ SCUOLE     — POI category "school"
 *    ▸ LAVORO     — POI "office" / "industrial" / "hospital"
 *
 *  Stazioni e aeroporti hanno domanda distribuita sull'arco della giornata:
 *  si valuta l'ampiezza del servizio (prima/ultima corsa, ore coperte).
 *  Scuole e luoghi di lavoro hanno invece DUE finestre rigide — entrata e
 *  uscita — ed è lì che un orario si rivela adeguato o no: dieci corse a
 *  metà mattina non portano nessuno a scuola alle 8.
 *
 *  Ogni polo riceve un verdetto motivato, e ogni linea il conto dei poli
 *  che serve: così si vede subito quale linea sta reggendo la domanda e
 *  quale no.
 * ═══════════════════════════════════════════════════════════════════════ */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { pointsOfInterest } from "@workspace/db/schema";
import { inArray, sql } from "drizzle-orm";
import { haversineKm, minToTime, walkMinutes } from "../lib/geo-utils";
import { municipalityBbox, discoverHubs } from "./intermodal";
import {
  resolveSource, parseDayKind, loadStops, loadRoutes, loadActiveTrips, loadPassages,
  loadValidities, loadDayTypes, projectBbox, type DayKind, type Source,
} from "./intermodal-source";

const router: IRouter = Router();

/* ── Poli e finestre ──────────────────────────────────────────────────── */
export type GeneratorKind = "stazione" | "aeroporto" | "scuola" | "lavoro" | "ospedale";

/* L'ospedale era conteggiato sotto "lavoro" e quindi non si trovava come
 * categoria: è un polo a sé, e con un profilo di domanda diverso — non ha
 * due punte come un ufficio, ma visite, degenze e turni del personale
 * distribuiti sull'arco della giornata, comprese le prime ore. */
const POI_CATEGORY_OF: Record<string, GeneratorKind> = {
  school: "scuola",
  office: "lavoro",
  industrial: "lavoro",
  hospital: "ospedale",
  clinic: "ospedale",
  doctors: "ospedale",
};

/** Finestra oraria in minuti dalla mezzanotte. */
interface Window { label: string; from: number; to: number }

/** Finestre di default: sovrascrivibili da querystring (orari aziendali/scolastici). */
interface WindowConfig {
  scuolaIngresso: Window; scuolaUscita: Window;
  lavoroIngresso: Window; lavoroUscita: Window;
  /* L'ospedale ha il cambio turno del personale (mattina presto e
   * pomeriggio) e la fascia visite/ambulatori: sono momenti diversi da
   * quelli di un ufficio. */
  ospedaleTurni: Window; ospedaleVisite: Window;
}
const DEFAULT_WINDOWS: WindowConfig = {
  scuolaIngresso: { label: "ingresso scuole", from: 7 * 60, to: 8 * 60 + 15 },
  scuolaUscita:   { label: "uscita scuole",   from: 12 * 60 + 45, to: 14 * 60 + 30 },
  lavoroIngresso: { label: "ingresso lavoro", from: 7 * 60, to: 9 * 60 },
  lavoroUscita:   { label: "uscita lavoro",   from: 16 * 60 + 30, to: 19 * 60 },
  ospedaleTurni:  { label: "cambio turno",    from: 5 * 60 + 30,  to: 7 * 60 + 30 },
  ospedaleVisite: { label: "visite e ambulatori", from: 8 * 60,   to: 13 * 60 },
};

function parseHHMM(v: unknown, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? ""));
  if (!m) return fallback;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 30 || mm > 59) return fallback;
  return h * 60 + mm;
}

function readWindows(q: any): WindowConfig {
  const d = DEFAULT_WINDOWS;
  return {
    scuolaIngresso: { ...d.scuolaIngresso, from: parseHHMM(q.scuolaIngressoDa, d.scuolaIngresso.from), to: parseHHMM(q.scuolaIngressoA, d.scuolaIngresso.to) },
    scuolaUscita:   { ...d.scuolaUscita,   from: parseHHMM(q.scuolaUscitaDa, d.scuolaUscita.from),     to: parseHHMM(q.scuolaUscitaA, d.scuolaUscita.to) },
    lavoroIngresso: { ...d.lavoroIngresso, from: parseHHMM(q.lavoroIngressoDa, d.lavoroIngresso.from), to: parseHHMM(q.lavoroIngressoA, d.lavoroIngresso.to) },
    lavoroUscita:   { ...d.lavoroUscita,   from: parseHHMM(q.lavoroUscitaDa, d.lavoroUscita.from),     to: parseHHMM(q.lavoroUscitaA, d.lavoroUscita.to) },
    ospedaleTurni:  { ...d.ospedaleTurni,  from: parseHHMM(q.ospedaleTurniDa, d.ospedaleTurni.from),   to: parseHHMM(q.ospedaleTurniA, d.ospedaleTurni.to) },
    ospedaleVisite: { ...d.ospedaleVisite, from: parseHHMM(q.ospedaleVisiteDa, d.ospedaleVisite.from), to: parseHHMM(q.ospedaleVisiteA, d.ospedaleVisite.to) },
  };
}

/** Un passaggio utile al polo: orario alla fermata + minuti a piedi da lì. */
export interface PoleItem { time: number; walkMin: number; routeId: string }

/* Chi va a scuola o al lavoro deve ESSERE al polo entro la fine della
 * finestra: conta l'orario del bus PIÙ il cammino. Chi torna deve invece
 * trovare il bus DOPO essere uscito: conta l'orario del bus MENO il
 * cammino necessario a raggiungere la fermata. Invertire i due segni è
 * l'errore che fa sembrare coperta una fascia che non lo è. */
export function tripsForEntry(items: PoleItem[], w: { from: number; to: number }): PoleItem[] {
  return items.filter(i => {
    const arrivoAlPolo = i.time + i.walkMin;
    return arrivoAlPolo <= w.to && arrivoAlPolo >= w.from - 60;
  });
}
export function tripsForExit(items: PoleItem[], w: { from: number; to: number }): PoleItem[] {
  return items.filter(i => {
    const partenzaRaggiungibile = i.time - i.walkMin;
    return partenzaRaggiungibile >= w.from && partenzaRaggiungibile <= w.to + 30;
  });
}

/* ── Analisi dell'ORARIO, non solo del "quante corse" ─────────────────
 * Sapere che a un polo passano 40 corse non dice se il servizio è usabile:
 * 40 corse tutte fra le 6 e le 9 lasciano scoperto il resto del giorno.
 * Qui si guarda come sono DISTRIBUITE: fascia oraria per fascia oraria,
 * intervallo tipico fra una corsa e l'altra, e soprattutto il buco più
 * lungo — che è quello che l'utente subisce davvero. */
export interface ScheduleShape {
  trips: number;
  firstTime: string | null;
  lastTime: string | null;
  /** conteggio per ora del giorno (0..23) */
  hourly: number[];
  hoursCovered: number;
  /** intervallo mediano fra corse consecutive (min) */
  medianHeadwayMin: number | null;
  /** buco più lungo nell'arco di servizio, con quando inizia */
  maxGapMin: number | null;
  maxGapFrom: string | null;
  /** ore, entro l'arco di servizio, senza alcuna corsa */
  emptyHoursInSpan: number;
}

export function scheduleShape(times: number[]): ScheduleShape {
  const empty: ScheduleShape = {
    trips: 0, firstTime: null, lastTime: null, hourly: new Array(24).fill(0),
    hoursCovered: 0, medianHeadwayMin: null, maxGapMin: null, maxGapFrom: null,
    emptyHoursInSpan: 0,
  };
  if (times.length === 0) return empty;

  const sorted = [...times].sort((a, b) => a - b);
  const hourly = new Array(24).fill(0);
  for (const t of sorted) hourly[Math.floor(t / 60) % 24]++;

  const gaps: number[] = [];
  let maxGap = 0, maxGapAt = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    gaps.push(g);
    if (g > maxGap) { maxGap = g; maxGapAt = sorted[i - 1]; }
  }
  const median = gaps.length > 0
    ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
    : null;

  const firstH = Math.floor(sorted[0] / 60), lastH = Math.floor(sorted[sorted.length - 1] / 60);
  let emptyInSpan = 0;
  for (let h = firstH; h <= lastH; h++) if ((hourly[h % 24] ?? 0) === 0) emptyInSpan++;

  return {
    trips: sorted.length,
    firstTime: minToTime(sorted[0]),
    lastTime: minToTime(sorted[sorted.length - 1]),
    hourly,
    hoursCovered: hourly.filter(n => n > 0).length,
    medianHeadwayMin: median,
    maxGapMin: gaps.length > 0 ? maxGap : null,
    maxGapFrom: gaps.length > 0 ? minToTime(maxGapAt) : null,
    emptyHoursInSpan: emptyInSpan,
  };
}

/* ── Strutture ────────────────────────────────────────────────────────── */
interface Generator {
  id: string; kind: GeneratorKind; name: string;
  lat: number; lng: number;
  /** categoria POI originale, per distinguere scuola/ufficio/ospedale in UI */
  detail?: string;
}

interface NearStop { stopId: string; stopName: string; distKm: number; walkMin: number }

interface WindowVerdict {
  label: string; from: string; to: string;
  /** corse utili: in ingresso arrivano in tempo, in uscita ripartono dopo */
  trips: number;
  firstTime: string | null;
  lastTime: string | null;
  routes: string[];
  ok: boolean;
}

interface GeneratorCoverage {
  generator: Generator;
  nearStops: NearStop[];
  /** verdetto complessivo del polo */
  status: "servito" | "parziale" | "non-servito";
  reason: string;
  /** finestre valutate (vuoto per stazioni/aeroporti: domanda distribuita) */
  windows: WindowVerdict[];
  /** ampiezza del servizio: usata per stazioni e aeroporti */
  span: { trips: number; firstTime: string | null; lastTime: string | null; hoursCovered: number } | null;
  /** come è distribuito l'orario a questo polo (per OGNI famiglia di polo) */
  schedule: ScheduleShape;
  routes: string[];
}

/* ── Endpoint ─────────────────────────────────────────────────────────── */
/**
 * GET /api/intermodal/demand-coverage
 *   psProjectId  progetto Planner Studio (rete valutata)
 *   routeIds     CSV delle linee da valutare (vuoto = tutte quelle del feed)
 *   day          feriale | sabato | festivo
 *   radius       distanza massima a piedi dal polo (km, default 0.5)
 *   municipality codice ISTAT per restringere l'area
 *   + orari finestre: scuolaIngressoDa/A, scuolaUscitaDa/A, lavoroIngressoDa/A, lavoroUscitaDa/A
 */
router.get("/intermodal/demand-coverage", async (req: any, res: any) => {
  try {
    const src: Source = await resolveSource(req);
    if (src.kind === "gtfs" && !src.feedId) {
      res.status(404).json({ error: "Nessuna rete disponibile" }); return;
    }
    const day: DayKind = parseDayKind(req.query.day);
    /* Validità esplicita: più precisa del giorno-tipo, perché su uno stesso
     * giorno insistono più validità (scolastico, estivo, festivo…) e
     * sommarle darebbe un orario che non esiste in nessun periodo. */
    const calendarId = String(req.query.calendarId ?? "").trim() || null;
    /* Giorno-tipo AZIENDALE (Lu-Ve scuole chiuse, sabato estivo…): è il modo
     * in cui l'azienda ragiona sull'orario, e vince sul giorno astratto. */
    const categoryId = String(req.query.categoryId ?? "").trim() || null;
    const activeTrips = await loadActiveTrips(src, day, calendarId, categoryId);
    const maxWalkKm = Math.min(3, Math.max(0.1, parseFloat(req.query.radius as string) || 0.5));
    const windows = readWindows(req.query);
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;
    /* Area di riferimento: il comune scelto, altrimenti l'impronta della rete
     * del progetto. Senza, i poli venivano presi da tutta la provincia (anche
     * a decine di km) e "servito %" crollava a zero. */
    const bbox = municipality ? await municipalityBbox(municipality) : await projectBbox(src);

    const routeIdsParam = (req.query.routeIds as string | undefined)?.trim();
    const routeFilter: Set<string> | null = routeIdsParam
      ? new Set(routeIdsParam.split(",").map(s => s.trim()).filter(Boolean))
      : null;

    /* 1. Poli: hub (stazioni/aeroporti) + POI (scuole/lavoro) ─────────── */
    const generators: Generator[] = [];

    const hubs = await discoverHubs({ bbox, municipality, feedId: src.feedId, psProjectId: src.psProjectId });
    for (const h of hubs) {
      if (h.type !== "railway" && h.type !== "airport") continue;
      generators.push({
        id: h.id, kind: h.type === "railway" ? "stazione" : "aeroporto",
        name: h.name, lat: h.lat, lng: h.lng,
      });
    }

    const poiRows = await db.select({
      id: pointsOfInterest.id, name: pointsOfInterest.name,
      category: pointsOfInterest.category,
      lat: pointsOfInterest.lat, lng: pointsOfInterest.lng,
    }).from(pointsOfInterest)
      .where(inArray(pointsOfInterest.category, Object.keys(POI_CATEGORY_OF)))
      .limit(8000);
    for (const p of poiRows) {
      const kind = POI_CATEGORY_OF[p.category];
      if (!kind) continue;
      if (bbox && (p.lat < bbox.minLat || p.lat > bbox.maxLat || p.lng < bbox.minLng || p.lng > bbox.maxLng)) continue;
      generators.push({
        id: `poi-${p.id}`, kind, name: p.name || p.category,
        lat: p.lat, lng: p.lng, detail: p.category,
      });
    }

    if (generators.length === 0) {
      res.json({
        scope: { psProjectId: src.psProjectId, feedId: src.feedId, source: src.kind, day, maxWalkKm },
        generators: [], byKind: {}, byRoute: [], summary: emptySummary(),
        note: "Nessun polo attrattore trovato nell'area: importa i POI (scuole, uffici, industrie) o allarga l'ambito.",
      });
      return;
    }

    /* 2. Fermate della rete ──────────────────────────────────────────── */
    const stops = await loadStops(src);

    // Fermate vicine per ciascun polo (una passata sola sulle fermate)
    const nearByGenerator = new Map<string, NearStop[]>();
    const usedStopIds = new Set<string>();
    for (const g of generators) {
      const near: NearStop[] = [];
      for (const st of stops) {
        const d = haversineKm(g.lat, g.lng, st.lat, st.lng);
        if (d > maxWalkKm) continue;
        near.push({ stopId: st.stopId, stopName: st.stopName, distKm: +d.toFixed(3), walkMin: walkMinutes(d) });
        usedStopIds.add(st.stopId);
      }
      near.sort((a, b) => a.distKm - b.distKm);
      nearByGenerator.set(g.id, near.slice(0, 12));
    }

    /* 3. Passaggi alle fermate utili ─────────────────────────────────
     * loadPassages tiene già solo le corse circolanti nel giorno scelto
     * (activeTrips) e restituisce la linea di ciascuna: qui resta da
     * applicare l'eventuale filtro sulle linee selezionate. */
    const stopIdArr = [...usedStopIds];
    const passages = await loadPassages(src, stopIdArr, activeTrips);
    const validPassages = routeFilter
      ? passages.filter(p => routeFilter.has(p.routeId))
      : passages;

    const tripRoute = new Map<string, string>();
    for (const p of passages) tripRoute.set(p.tripId, p.routeId);

    // Nome linea leggibile
    const routeRows = await loadRoutes(src);
    const routeLabel = new Map<string, string>();
    for (const r of routeRows) routeLabel.set(r.routeId, r.shortName || r.longName || "linea");

    // Indice: fermata → passaggi
    const byStop = new Map<string, typeof validPassages>();
    for (const p of validPassages) {
      const arr = byStop.get(p.stopId);
      if (arr) arr.push(p); else byStop.set(p.stopId, [p]);
    }

    /* 4. Verdetto per polo ───────────────────────────────────────────── */
    const coverage: GeneratorCoverage[] = [];
    for (const g of generators) {
      const near = nearByGenerator.get(g.id) ?? [];
      if (near.length === 0) {
        coverage.push({
          generator: g, nearStops: [], status: "non-servito",
          reason: `Nessuna fermata entro ${Math.round(maxWalkKm * 1000)} m: il polo non è raggiungibile a piedi da nessuna corsa.`,
          windows: [], span: null, schedule: scheduleShape([]), routes: [],
        });
        continue;
      }

      /* Passaggi utili al polo. Una stessa corsa può toccare PIÙ fermate
       * vicine allo stesso polo: va contata una volta sola, con l'accesso
       * migliore (cammino minimo), altrimenti il numero di corse per fascia
       * risulta gonfiato tante volte quante sono le fermate vicine. */
      const bestByTrip = new Map<string, PoleItem>();
      for (const ns of near) {
        for (const p of byStop.get(ns.stopId) ?? []) {
          const prev = bestByTrip.get(p.tripId);
          if (!prev || ns.walkMin < prev.walkMin) {
            bestByTrip.set(p.tripId, { time: p.time, walkMin: ns.walkMin, routeId: tripRoute.get(p.tripId)! });
          }
        }
      }
      const items: PoleItem[] = [...bestByTrip.values()];
      const routesHere = [...new Set(items.map(i => routeLabel.get(i.routeId) ?? i.routeId))].sort();

      if (items.length === 0) {
        coverage.push({
          generator: g, nearStops: near, status: "non-servito",
          reason: near.length > 0
            ? `Ci sono ${near.length} fermate vicine, ma nessuna corsa vi transita nel giorno ${day}.`
            : "Nessuna corsa.",
          windows: [], span: null, schedule: scheduleShape([]), routes: [],
        });
        continue;
      }

      const shape = scheduleShape(items.map(i => i.time));

      if (g.kind === "stazione" || g.kind === "aeroporto") {
        // Domanda distribuita: conta l'ampiezza del servizio
        const times = items.map(i => i.time).sort((a, b) => a - b);
        const hours = new Set(times.map(t => Math.floor(t / 60)));
        const span = {
          trips: times.length,
          firstTime: minToTime(times[0]),
          lastTime: minToTime(times[times.length - 1]),
          hoursCovered: hours.size,
        };
        /* Non basta contare le ore coperte: un servizio con 12 ore coperte
         * ma un buco di tre ore a metà giornata non è "servito". Il buco
         * più lungo entra nel verdetto. */
        const bigGap = (shape.maxGapMin ?? 0) >= 120;
        const status: GeneratorCoverage["status"] =
          span.hoursCovered >= 10 && !bigGap ? "servito"
            : span.hoursCovered >= 5 ? "parziale" : "non-servito";
        coverage.push({
          generator: g, nearStops: near, status,
          reason: status === "servito"
            ? `Servizio ampio: ${span.trips} passaggi su ${span.hoursCovered} ore diverse (${span.firstTime}–${span.lastTime})`
              + (shape.medianHeadwayMin != null ? `, un bus ogni ~${shape.medianHeadwayMin} min.` : ".")
            : status === "parziale"
              ? (bigGap && shape.maxGapMin != null
                  ? `Buco di ${Math.round(shape.maxGapMin / 60 * 10) / 10} h dalle ${shape.maxGapFrom}: chi arriva in quella fascia non trova il bus (${span.firstTime}–${span.lastTime}).`
                  : `Servizio limitato a ${span.hoursCovered} ore (${span.firstTime}–${span.lastTime}): fasce scoperte per chi arriva o riparte fuori da quell'arco.`)
              : `Solo ${span.trips} passaggi in ${span.hoursCovered} ore: il polo è di fatto scoperto.`,
          windows: [], span, schedule: shape, routes: routesHere,
        });
        continue;
      }

      // Scuole e lavoro: due finestre rigide
      const [wIn, wOut] = g.kind === "scuola"
        ? [windows.scuolaIngresso, windows.scuolaUscita]
        : g.kind === "ospedale"
          ? [windows.ospedaleTurni, windows.ospedaleVisite]
          : [windows.lavoroIngresso, windows.lavoroUscita];

      const inTrips = tripsForEntry(items, wIn);
      const outTrips = tripsForExit(items, wOut);

      const mk = (w: Window, list: PoleItem[]): WindowVerdict => {
        const times = list.map(i => i.time).sort((a, b) => a - b);
        return {
          label: w.label, from: minToTime(w.from), to: minToTime(w.to),
          trips: times.length,
          firstTime: times.length ? minToTime(times[0]) : null,
          lastTime: times.length ? minToTime(times[times.length - 1]) : null,
          routes: [...new Set(list.map(i => routeLabel.get(i.routeId) ?? i.routeId))].sort(),
          ok: times.length > 0,
        };
      };
      const vIn = mk(wIn, inTrips), vOut = mk(wOut, outTrips);
      const status: GeneratorCoverage["status"] =
        vIn.ok && vOut.ok ? "servito" : (vIn.ok || vOut.ok) ? "parziale" : "non-servito";

      coverage.push({
        generator: g, nearStops: near, status,
        reason: status === "servito"
          ? `Coperte entrambe le fasce: ${vIn.trips} corse per l'${wIn.label}, ${vOut.trips} per l'${wOut.label}.`
          : status === "parziale"
            ? (vIn.ok
                ? `Coperto solo l'${wIn.label} (${vIn.trips} corse): chi deve rientrare nella fascia ${vOut.from}–${vOut.to} non ha corse.`
                : `Coperta solo l'${wOut.label} (${vOut.trips} corse): nessuna corsa porta al polo entro le ${vIn.to}.`)
            : `Ci sono corse nell'arco della giornata, ma nessuna nelle due fasce che contano (${vIn.from}–${vIn.to} e ${vOut.from}–${vOut.to}).`,
        windows: [vIn, vOut], span: null, schedule: shape, routes: routesHere,
      });
    }

    /* 5. Aggregati: per famiglia di polo e per linea ─────────────────── */
    const byKind: Record<string, { totale: number; servito: number; parziale: number; nonServito: number }> = {};
    for (const c of coverage) {
      const k = c.generator.kind;
      byKind[k] ??= { totale: 0, servito: 0, parziale: 0, nonServito: 0 };
      byKind[k].totale++;
      if (c.status === "servito") byKind[k].servito++;
      else if (c.status === "parziale") byKind[k].parziale++;
      else byKind[k].nonServito++;
    }

    const routeAgg = new Map<string, { route: string; poli: number; perKind: Record<string, number> }>();
    for (const c of coverage) {
      if (c.status === "non-servito") continue;
      for (const r of c.routes) {
        const e = routeAgg.get(r) ?? { route: r, poli: 0, perKind: {} };
        e.poli++;
        e.perKind[c.generator.kind] = (e.perKind[c.generator.kind] ?? 0) + 1;
        routeAgg.set(r, e);
      }
    }
    const byRoute = [...routeAgg.values()].sort((a, b) => b.poli - a.poli);

    /* Analisi dell'orario per LINEA: quante corse, in che arco, con quale
     * intervallo e quale buco più lungo. È la lettura che manca quando si
     * guarda solo la copertura dei poli. */
    const timesByRoute = new Map<string, number[]>();
    for (const p of validPassages) {
      const arr = timesByRoute.get(p.routeId);
      if (arr) arr.push(p.time); else timesByRoute.set(p.routeId, [p.time]);
    }
    const schedules = [...timesByRoute.entries()]
      .map(([routeId, times]) => ({
        routeId,
        route: routeLabel.get(routeId) ?? routeId,
        ...scheduleShape(times),
      }))
      .sort((a, b) => b.trips - a.trips);

    /* ── Indicatori di rete ──────────────────────────────────────────
     * Non basta l'elenco dei poli: servono le misure che dicono se
     * l'orario regge nel suo insieme, e dove intervenire per primo. */
    const tuttiTempi = validPassages.map(p => p.time);
    const reteShape = scheduleShape(tuttiTempi);

    /* ── LINEA DEL TEMPO DELLA DOMANDA ───────────────────────────────
     * Tutti i dati territoriali tradotti in un'unica lingua: eventi di
     * domanda nel tempo. Ogni polo contribuisce nelle SUE finestre
     * (ingresso/uscita scuole, turni/visite ospedale, punte lavoro);
     * ogni treno in partenza/arrivo è un evento all'ora sua. Messa
     * accanto alle corse per ora, dice DOVE l'offerta manca la domanda:
     * è il confronto che guida la pianificazione, non il conteggio. */
    const zeros = () => new Array(24).fill(0) as number[];
    const perKind: Record<"scuola" | "lavoro" | "ospedale" | "treni", number[]> = {
      scuola: zeros(), lavoro: zeros(), ospedale: zeros(), treni: zeros(),
    };
    const addWindow = (arr: number[], w: Window) => {
      const h0 = Math.floor(w.from / 60), h1 = Math.floor(Math.max(w.from, w.to - 1) / 60);
      for (let h = h0; h <= h1 && h < 24; h++) arr[h] += 1;
    };
    for (const c of coverage) {
      const k = c.generator.kind;
      if (k === "scuola") { addWindow(perKind.scuola, windows.scuolaIngresso); addWindow(perKind.scuola, windows.scuolaUscita); }
      else if (k === "lavoro") { addWindow(perKind.lavoro, windows.lavoroIngresso); addWindow(perKind.lavoro, windows.lavoroUscita); }
      else if (k === "ospedale") { addWindow(perKind.ospedale, windows.ospedaleTurni); addWindow(perKind.ospedale, windows.ospedaleVisite); }
    }
    // Treni/voli: ogni partenza o arrivo è domanda di adduzione/distribuzione
    for (const h of hubs) {
      if (h.type !== "railway" && h.type !== "airport") continue;
      for (const dep of h.typicalDepartures) for (const t of dep.times) {
        const hh = parseInt(t.slice(0, 2), 10);
        if (Number.isFinite(hh) && hh >= 0 && hh < 24) perKind.treni[hh] += 1;
      }
      for (const arr of h.typicalArrivals) for (const t of arr.times) {
        const hh = parseInt(t.slice(0, 2), 10);
        if (Number.isFinite(hh) && hh >= 0 && hh < 24) perKind.treni[hh] += 1;
      }
    }
    const demandHourly = zeros();
    for (const arr of Object.values(perKind)) for (let h = 0; h < 24; h++) demandHourly[h] += arr[h];
    // Ore critiche: c'è domanda ma NESSUNA corsa (diurne: 5-23)
    const oreCritiche: Array<{ hour: number; demand: number; service: number }> = [];
    for (let h = 5; h <= 23; h++) {
      if (demandHourly[h] > 0 && (reteShape.hourly[h] ?? 0) === 0) {
        oreCritiche.push({ hour: h, demand: demandHourly[h], service: 0 });
      }
    }
    const timeline = { demandHourly, serviceHourly: reteShape.hourly, perKind, oreCritiche };

    // Fascia di punta e di morbida: dove si concentra e dove manca il servizio
    const oraPiuServita = reteShape.hourly.indexOf(Math.max(...reteShape.hourly));
    const oreScoperte = reteShape.hourly
      .map((n, h) => ({ h, n }))
      .filter(x => x.n === 0 && x.h >= 6 && x.h <= 21)
      .map(x => x.h);

    // Accessibilità: quanto è lontano in media un polo dalla fermata più vicina
    const distanze = coverage
      .filter(c => c.nearStops.length > 0)
      .map(c => c.nearStops[0].walkMin);
    const camminoMedio = distanze.length > 0
      ? Math.round(distanze.reduce((a, b) => a + b, 0) / distanze.length) : null;
    const poliIrraggiungibili = coverage.filter(c => c.nearStops.length === 0).length;

    /* Criticità in ordine di gravità: prima chi non ha proprio fermate,
     * poi chi ha fermate ma nessuna corsa utile, poi chi è coperto a metà.
     * È l'ordine in cui un pianificatore mette mano al problema. */
    const criticita = coverage
      .filter(c => c.status !== "servito")
      .map(c => {
        const gravita = c.nearStops.length === 0 ? 3
          : (c.schedule?.trips ?? 0) === 0 ? 2
          : c.status === "non-servito" ? 1 : 0;
        const azione = c.nearStops.length === 0
          ? "Nessuna fermata a distanza pedonale: serve avvicinare un percorso o istituire una fermata."
          : (c.schedule?.trips ?? 0) === 0
            ? "Le fermate ci sono ma nessuna corsa vi transita in questo giorno-tipo: estendere una linea esistente."
            : c.windows.some(w => !w.ok)
              ? `Fascia scoperta (${c.windows.filter(w => !w.ok).map(w => w.label).join(", ")}): spostare o aggiungere corse in quella finestra.`
              : (c.schedule?.maxGapMin ?? 0) >= 120
                ? `Buco di ${Math.round((c.schedule!.maxGapMin! / 60) * 10) / 10} h dalle ${c.schedule!.maxGapFrom}: inserire una corsa intermedia.`
                : "Servizio limitato: valutare un potenziamento.";
        return {
          polo: c.generator.name, famiglia: c.generator.kind,
          stato: c.status, gravita, motivo: c.reason, azione,
          lat: c.generator.lat, lng: c.generator.lng,
        };
      })
      .sort((a, b) => b.gravita - a.gravita || a.polo.localeCompare(b.polo));

    const summary = {
      totale: coverage.length,
      servito: coverage.filter(c => c.status === "servito").length,
      parziale: coverage.filter(c => c.status === "parziale").length,
      nonServito: coverage.filter(c => c.status === "non-servito").length,
      lineeValutate: routeFilter ? routeFilter.size : routeLabel.size,
    };

    res.json({
      scope: {
        psProjectId: src.psProjectId, feedId: src.feedId,
        // "ps" = dati vivi del progetto; "gtfs" = feed (uso fuori progetto)
        source: src.kind, day, calendarId, categoryId, maxWalkKm,
        calendarApplied: activeTrips.size > 0,
      },
      windows: {
        scuolaIngresso: fmtWindow(windows.scuolaIngresso), scuolaUscita: fmtWindow(windows.scuolaUscita),
        lavoroIngresso: fmtWindow(windows.lavoroIngresso), lavoroUscita: fmtWindow(windows.lavoroUscita),
        ospedaleTurni: fmtWindow(windows.ospedaleTurni), ospedaleVisite: fmtWindow(windows.ospedaleVisite),
      },
      // I poli scoperti prima: sono quelli su cui si interviene
      generators: coverage.sort((a, b) => {
        const rank = { "non-servito": 0, parziale: 1, servito: 2 } as const;
        return rank[a.status] - rank[b.status] || a.generator.name.localeCompare(b.generator.name);
      }),
      byKind, byRoute, summary,
      // Domanda e offerta sulla stessa linea del tempo (per ora del giorno)
      timeline,
      // Come è fatto l'orario, linea per linea
      schedules,
      // Lettura d'insieme della rete
      rete: {
        ...reteShape,
        oraPiuServita: oraPiuServita >= 0 ? `${String(oraPiuServita).padStart(2, "0")}:00` : null,
        oreScoperteDiurne: oreScoperte.map(h => `${String(h).padStart(2, "0")}:00`),
        camminoMedioMin: camminoMedio,
        poliIrraggiungibili,
      },
      // Che cosa fare, in ordine di gravità
      criticita: criticita.slice(0, 40),
    });
  } catch (err: any) {
    req.log?.error?.(err, "demand-coverage");
    res.status(500).json({ error: "Errore nel calcolo della copertura", detail: err?.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 *  GET /api/intermodal/lines — le linee della rete del progetto
 *
 *  Serve al selettore: l'analisi si fa SULLE LINEE SCELTE, quindi l'elenco
 *  deve venire dalla stessa rete e dallo stesso giorno-tipo dell'analisi,
 *  altrimenti si potrebbe selezionare una linea che quel giorno non circola.
 * ═══════════════════════════════════════════════════════════════════════ */
router.get("/intermodal/lines", async (req: any, res: any) => {
  try {
    const src: Source = await resolveSource(req);
    if (src.kind === "gtfs" && !src.feedId) { res.json({ lines: [], scope: { psProjectId: null, feedId: null } }); return; }

    const day: DayKind = parseDayKind(req.query.day);
    const calendarId = String(req.query.calendarId ?? "").trim() || null;
    const categoryId = String(req.query.categoryId ?? "").trim() || null;
    const routes = await loadRoutes(src);
    const activeTrips = await loadActiveTrips(src, day, calendarId, categoryId);

    // Corse per linea nel giorno scelto: una linea con 0 corse quel giorno va
    // mostrata come tale, non nascosta — è un'informazione utile di per sé.
    const countByRoute = new Map<string, number>();
    for (const routeId of activeTrips.values()) {
      countByRoute.set(routeId, (countByRoute.get(routeId) ?? 0) + 1);
    }

    const lines = routes.map(r => ({
      routeId: r.routeId,
      label: r.shortName || r.longName || "linea",
      longName: r.longName ?? null,
      color: r.color ? (r.color.startsWith("#") ? r.color : `#${r.color}`) : null,
      trips: countByRoute.get(r.routeId) ?? 0,
    })).sort((a, b) =>
      a.label.localeCompare(b.label, "it", { numeric: true, sensitivity: "base" }));

    res.json({
      lines,
      scope: { psProjectId: src.psProjectId, feedId: src.feedId, source: src.kind, day, calendarId },
    });
  } catch (err: any) {
    req.log?.error?.(err, "intermodal lines");
    res.status(500).json({ error: "Errore nel caricamento delle linee", detail: err?.message });
  }
});

/* GET /api/intermodal/day-types — i giorni-tipo del CALENDARIO AZIENDALE
 * (Lu-Ve scuole aperte/chiuse, sabato, festivo…), con quante corse e
 * quanti giorni dell'anno ricadono in ciascuno. */
router.get("/intermodal/day-types", async (req: any, res: any) => {
  try {
    const src = await resolveSource(req);
    const dayTypes = await loadDayTypes(src);
    /* Il giorno-tipo di OGGI secondo il calendario aziendale: è il default
     * naturale dell'analisi — senza, si partiva dal "feriale" generico che
     * somma validità diverse e non corrisponde a nessun orario reale. */
    let todayId: string | null = null;
    if (src.kind === "ps") {
      try {
        const r = await db.execute<any>(sql`
          SELECT cc.category_id::text AS id
            FROM ps_validity_category_calendar cc
            JOIN ps_validity_categories c ON c.id = cc.category_id
           WHERE cc.date = CURRENT_DATE
             AND (c.project_id = ${src.psProjectId}::uuid OR c.project_id IS NULL)
           LIMIT 1`);
        todayId = ((r as any).rows?.[0]?.id as string | undefined) ?? null;
        if (todayId && !dayTypes.some(d => d.id === todayId)) todayId = null;
      } catch { /* progetti senza calendario per categorie */ }
    }
    res.json({
      dayTypes,
      todayId,
      scope: { psProjectId: src.psProjectId, source: src.kind },
      note: dayTypes.length === 0
        ? "Nessuna categoria nel calendario aziendale: si usa il giorno-tipo generico."
        : undefined,
    });
  } catch (err: any) {
    req.log?.error?.(err, "intermodal day-types");
    res.status(500).json({ error: "Errore nel caricamento dei giorni-tipo", detail: err?.message });
  }
});

/* GET /api/intermodal/validities — le validità del progetto.
 * Servono al selettore: l'analisi si fa su UNA validità, non su un
 * giorno-tipo astratto. */
router.get("/intermodal/validities", async (req: any, res: any) => {
  try {
    const src = await resolveSource(req);
    const validities = await loadValidities(src);
    res.json({
      validities,
      scope: { psProjectId: src.psProjectId, source: src.kind },
      // Fuori da un progetto le validità non esistono: resta il giorno-tipo
      note: src.kind === "gtfs" ? "Le validità sono disponibili solo dentro un progetto Planner Studio." : undefined,
    });
  } catch (err: any) {
    req.log?.error?.(err, "intermodal validities");
    res.status(500).json({ error: "Errore nel caricamento delle validità", detail: err?.message });
  }
});

const fmtWindow = (w: Window) => ({ label: w.label, from: minToTime(w.from), to: minToTime(w.to) });
const emptySummary = () => ({ totale: 0, servito: 0, parziale: 0, nonServito: 0, lineeValutate: 0 });

export default router;
