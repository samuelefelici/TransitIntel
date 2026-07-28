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
import { gtfsStops, gtfsStopTimes, gtfsTrips, gtfsRoutes, pointsOfInterest } from "@workspace/db/schema";
import { sql, inArray, and } from "drizzle-orm";
import { haversineKm, timeToMinutes, minToTime, walkMinutes } from "../lib/geo-utils";
import {
  resolveScope, parseDayKind, activeServiceIds, municipalityBbox,
  discoverHubs, feedWhere, type DayKind,
} from "./intermodal";

const router: IRouter = Router();

/* ── Poli e finestre ──────────────────────────────────────────────────── */
export type GeneratorKind = "stazione" | "aeroporto" | "scuola" | "lavoro";

const POI_CATEGORY_OF: Record<string, GeneratorKind> = {
  school: "scuola",
  office: "lavoro",
  industrial: "lavoro",
  hospital: "lavoro", // grande polo di occupazione oltre che servizio
};

/** Finestra oraria in minuti dalla mezzanotte. */
interface Window { label: string; from: number; to: number }

/** Finestre di default: sovrascrivibili da querystring (orari aziendali/scolastici). */
interface WindowConfig {
  scuolaIngresso: Window; scuolaUscita: Window;
  lavoroIngresso: Window; lavoroUscita: Window;
}
const DEFAULT_WINDOWS: WindowConfig = {
  scuolaIngresso: { label: "ingresso scuole", from: 7 * 60, to: 8 * 60 + 15 },
  scuolaUscita:   { label: "uscita scuole",   from: 12 * 60 + 45, to: 14 * 60 + 30 },
  lavoroIngresso: { label: "ingresso lavoro", from: 7 * 60, to: 9 * 60 },
  lavoroUscita:   { label: "uscita lavoro",   from: 16 * 60 + 30, to: 19 * 60 },
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
    const { feedId, psProjectId } = await resolveScope(req);
    if (!feedId) { res.status(404).json({ error: "Nessuna rete disponibile per questo progetto" }); return; }

    const day: DayKind = parseDayKind(req.query.day);
    const serviceIds = await activeServiceIds(feedId, day);
    const maxWalkKm = Math.min(3, Math.max(0.1, parseFloat(req.query.radius as string) || 0.5));
    const windows = readWindows(req.query);
    const municipality = (req.query.municipality as string | undefined)?.trim() || null;
    const bbox = municipality ? await municipalityBbox(municipality) : null;

    const routeIdsParam = (req.query.routeIds as string | undefined)?.trim();
    const routeFilter: Set<string> | null = routeIdsParam
      ? new Set(routeIdsParam.split(",").map(s => s.trim()).filter(Boolean))
      : null;

    /* 1. Poli: hub (stazioni/aeroporti) + POI (scuole/lavoro) ─────────── */
    const generators: Generator[] = [];

    const hubs = await discoverHubs({ bbox, municipality, feedId });
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
        scope: { psProjectId, feedId, day, maxWalkKm },
        generators: [], byKind: {}, byRoute: [], summary: emptySummary(),
        note: "Nessun polo attrattore trovato nell'area: importa i POI (scuole, uffici, industrie) o allarga l'ambito.",
      });
      return;
    }

    /* 2. Fermate della rete ──────────────────────────────────────────── */
    const stops = await db.select({
      stopId: gtfsStops.stopId, stopName: gtfsStops.stopName,
      lat: gtfsStops.stopLat, lng: gtfsStops.stopLon,
    }).from(gtfsStops).where(feedWhere(gtfsStops.feedId, feedId));

    // Fermate vicine per ciascun polo (una passata sola sulle fermate)
    const nearByGenerator = new Map<string, NearStop[]>();
    const usedStopIds = new Set<string>();
    for (const g of generators) {
      const near: NearStop[] = [];
      for (const s of stops) {
        const sLat = typeof s.lat === "string" ? parseFloat(s.lat) : s.lat;
        const sLng = typeof s.lng === "string" ? parseFloat(s.lng) : s.lng;
        if (sLat == null || sLng == null || !isFinite(sLat) || !isFinite(sLng)) continue;
        const d = haversineKm(g.lat, g.lng, sLat, sLng);
        if (d > maxWalkKm) continue;
        near.push({ stopId: s.stopId, stopName: s.stopName || s.stopId, distKm: +d.toFixed(3), walkMin: walkMinutes(d) });
        usedStopIds.add(s.stopId);
      }
      near.sort((a, b) => a.distKm - b.distKm);
      nearByGenerator.set(g.id, near.slice(0, 12));
    }

    /* 3. Passaggi alle fermate utili, filtrati per giorno e linee ────── */
    const stopIdArr = [...usedStopIds];
    type Passage = { stopId: string; tripId: string; time: number };
    const passages: Passage[] = [];
    for (let i = 0; i < stopIdArr.length; i += 500) {
      const batch = stopIdArr.slice(i, i + 500);
      if (batch.length === 0) continue;
      const rows = await db.select({
        stopId: gtfsStopTimes.stopId, tripId: gtfsStopTimes.tripId,
        departureTime: gtfsStopTimes.departureTime, arrivalTime: gtfsStopTimes.arrivalTime,
      }).from(gtfsStopTimes)
        .where(and(feedWhere(gtfsStopTimes.feedId, feedId),
          sql`${gtfsStopTimes.stopId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`));
      for (const r of rows) {
        const t = r.departureTime || r.arrivalTime;
        if (!t) continue;
        passages.push({ stopId: r.stopId, tripId: r.tripId, time: timeToMinutes(t) });
      }
    }

    // trip → route + service, per filtrare linee e calendario
    const tripIds = [...new Set(passages.map(p => p.tripId))];
    const tripRoute = new Map<string, string>();
    const tripService = new Map<string, string>();
    for (let i = 0; i < tripIds.length; i += 500) {
      const batch = tripIds.slice(i, i + 500);
      if (batch.length === 0) continue;
      const rows = await db.select({
        tripId: gtfsTrips.tripId, routeId: gtfsTrips.routeId, serviceId: gtfsTrips.serviceId,
      }).from(gtfsTrips)
        .where(and(feedWhere(gtfsTrips.feedId, feedId),
          sql`${gtfsTrips.tripId} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`));
      for (const r of rows) {
        tripRoute.set(r.tripId, r.routeId);
        if (r.serviceId) tripService.set(r.tripId, r.serviceId);
      }
    }

    const validPassages = passages.filter(p => {
      const rid = tripRoute.get(p.tripId);
      if (!rid) return false;
      if (routeFilter && !routeFilter.has(rid)) return false;
      if (serviceIds) {
        const svc = tripService.get(p.tripId);
        if (!svc || !serviceIds.has(svc)) return false;
      }
      return true;
    });

    // Nome linea leggibile
    const routeRows = await db.select({
      routeId: gtfsRoutes.routeId, shortName: gtfsRoutes.routeShortName, longName: gtfsRoutes.routeLongName,
    }).from(gtfsRoutes).where(feedWhere(gtfsRoutes.feedId, feedId));
    const routeLabel = new Map<string, string>();
    for (const r of routeRows) routeLabel.set(r.routeId, r.shortName || r.longName || r.routeId);

    // Indice: fermata → passaggi
    const byStop = new Map<string, Passage[]>();
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
          windows: [], span: null, routes: [],
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
          windows: [], span: null, routes: [],
        });
        continue;
      }

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
        const status: GeneratorCoverage["status"] =
          span.hoursCovered >= 10 ? "servito" : span.hoursCovered >= 5 ? "parziale" : "non-servito";
        coverage.push({
          generator: g, nearStops: near, status,
          reason: status === "servito"
            ? `Servizio ampio: ${span.trips} passaggi su ${span.hoursCovered} ore diverse (${span.firstTime}–${span.lastTime}).`
            : status === "parziale"
              ? `Servizio limitato a ${span.hoursCovered} ore (${span.firstTime}–${span.lastTime}): fasce scoperte per chi arriva o riparte fuori da quell'arco.`
              : `Solo ${span.trips} passaggi in ${span.hoursCovered} ore: il polo è di fatto scoperto.`,
          windows: [], span, routes: routesHere,
        });
        continue;
      }

      // Scuole e lavoro: due finestre rigide
      const [wIn, wOut] = g.kind === "scuola"
        ? [windows.scuolaIngresso, windows.scuolaUscita]
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
        windows: [vIn, vOut], span: null, routes: routesHere,
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

    const summary = {
      totale: coverage.length,
      servito: coverage.filter(c => c.status === "servito").length,
      parziale: coverage.filter(c => c.status === "parziale").length,
      nonServito: coverage.filter(c => c.status === "non-servito").length,
      lineeValutate: routeFilter ? routeFilter.size : routeLabel.size,
    };

    res.json({
      scope: { psProjectId, feedId, day, maxWalkKm, calendarApplied: serviceIds !== null },
      windows: {
        scuolaIngresso: fmtWindow(windows.scuolaIngresso), scuolaUscita: fmtWindow(windows.scuolaUscita),
        lavoroIngresso: fmtWindow(windows.lavoroIngresso), lavoroUscita: fmtWindow(windows.lavoroUscita),
      },
      // I poli scoperti prima: sono quelli su cui si interviene
      generators: coverage.sort((a, b) => {
        const rank = { "non-servito": 0, parziale: 1, servito: 2 } as const;
        return rank[a.status] - rank[b.status] || a.generator.name.localeCompare(b.generator.name);
      }),
      byKind, byRoute, summary,
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
    const { feedId, psProjectId } = await resolveScope(req);
    if (!feedId) { res.json({ lines: [], scope: { psProjectId, feedId: null } }); return; }

    const day: DayKind = parseDayKind(req.query.day);
    const serviceIds = await activeServiceIds(feedId, day);

    const routes = await db.select({
      routeId: gtfsRoutes.routeId,
      shortName: gtfsRoutes.routeShortName,
      longName: gtfsRoutes.routeLongName,
      color: gtfsRoutes.routeColor,
    }).from(gtfsRoutes).where(feedWhere(gtfsRoutes.feedId, feedId));

    // Corse per linea nel giorno scelto: una linea con 0 corse quel giorno va
    // mostrata come tale, non nascosta — è un'informazione utile di per sé.
    const trips = await db.select({
      routeId: gtfsTrips.routeId, tripId: gtfsTrips.tripId, serviceId: gtfsTrips.serviceId,
    }).from(gtfsTrips).where(feedWhere(gtfsTrips.feedId, feedId));

    const countByRoute = new Map<string, number>();
    for (const t of trips) {
      if (serviceIds && (!t.serviceId || !serviceIds.has(t.serviceId))) continue;
      countByRoute.set(t.routeId, (countByRoute.get(t.routeId) ?? 0) + 1);
    }

    const lines = routes.map(r => ({
      routeId: r.routeId,
      label: r.shortName || r.longName || r.routeId,
      longName: r.longName ?? null,
      color: r.color ? (r.color.startsWith("#") ? r.color : `#${r.color}`) : null,
      trips: countByRoute.get(r.routeId) ?? 0,
    })).sort((a, b) =>
      a.label.localeCompare(b.label, "it", { numeric: true, sensitivity: "base" }));

    res.json({ lines, scope: { psProjectId, feedId, day, calendarApplied: serviceIds !== null } });
  } catch (err: any) {
    req.log?.error?.(err, "intermodal lines");
    res.status(500).json({ error: "Errore nel caricamento delle linee", detail: err?.message });
  }
});

const fmtWindow = (w: Window) => ({ label: w.label, from: minToTime(w.from), to: minToTime(w.to) });
const emptySummary = () => ({ totale: 0, servito: 0, parziale: 0, nonServito: 0, lineeValutate: 0 });

export default router;
