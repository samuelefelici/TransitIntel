/* ═══════════════════════════════════════════════════════════════════════
 *  CONTESTO DI PROGETTO PER ARGOS — tutto quello che l'agente può leggere
 *
 *  Argos è un servizio esterno: riceve solo l'id del progetto e finora
 *  doveva indovinare cosa contenesse. Qui gli si dà una lettura completa
 *  e già interpretata del progetto, CARTOGRAFIA COMPRESA — posizioni di
 *  fermate, nodi, depositi, poli attrattori, geometrie dei percorsi e
 *  riquadro dell'area servita — così può rispondere a domande spaziali
 *  ("quali fermate sono lontane dalla stazione?", "dove non arriva la
 *  linea 3?") e non solo tabellari.
 *
 *  Il payload è potenzialmente grande: ?include= sceglie le sezioni e
 *  ogni elenco è limitato, con il conteggio reale sempre dichiarato in
 *  modo che l'agente sappia quando sta guardando un campione e non
 *  scambi un troncamento per l'insieme completo.
 * ═══════════════════════════════════════════════════════════════════════ */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { haversineKm } from "../lib/geo-utils";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** Accesso al progetto: owner, membro, oppure progetto pubblicato in esercizio.
 *  Stessa regola delle altre rotte Argos. */
async function hasProjectAccess(projectId: string, userId: string): Promise<boolean> {
  const r = await db.execute<any>(sql`
    SELECT p.id
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (
         p.owner_user_id = ${userId}::uuid
         OR pm.user_id IS NOT NULL
         OR (p.materialized_feed_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM gtfs_feeds gf
                          WHERE gf.id = p.materialized_feed_id AND gf.is_active = true))
       )
     LIMIT 1`);
  return (((r as any).rows ?? []).length > 0);
}

/** Elenco troncato che dichiara sempre quanto è il totale vero. */
function capped<T>(rows: T[], limit: number): { total: number; shown: number; truncated: boolean; items: T[] } {
  return {
    total: rows.length,
    shown: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    items: rows.slice(0, limit),
  };
}

const SECTIONS = [
  "progetto", "rete", "cartografia", "validita", "orari",
  "infrastruttura", "poli", "zone",
] as const;
type Section = typeof SECTIONS[number];

/**
 * GET /api/ai/argos/context?projectId=…&include=rete,cartografia&limit=…
 *
 * Senza `include` restituisce tutte le sezioni. `limit` (default 300)
 * limita ogni elenco.
 */
router.get("/ai/argos/context", async (req: any, res: any) => {
  const projectId = String(req.query.projectId ?? "").trim();
  if (!UUID_RE.test(projectId)) {
    res.status(400).json({ error: "projectId non valido" });
    return;
  }
  const limit = Math.min(2000, Math.max(10, Number(req.query.limit) || 300));
  const wanted = String(req.query.include ?? "").trim();
  const include: Set<Section> = wanted
    ? new Set(wanted.split(",").map(s => s.trim()).filter(Boolean) as Section[])
    : new Set(SECTIONS);

  /* Questo endpoint espone il progetto INTERO: va protetto come le altre
   * rotte di progetto, non basta essere autenticati. */
  const userId = (req.user?.id ?? req.user?.userId) as string | undefined;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const ok = await hasProjectAccess(projectId, userId).catch(() => false);
  if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }

  try {
    const proj = await db.execute<any>(sql`
      SELECT id::text AS id, name, description, created_at, updated_at,
             source_feed_id::text AS source_feed_id,
             materialized_feed_id::text AS materialized_feed_id, materialized_at
        FROM ps_projects WHERE id = ${projectId}::uuid`);
    const p = (proj as any).rows?.[0];
    if (!p) { res.status(404).json({ error: "Progetto non trovato" }); return; }

    const out: Record<string, any> = {
      generatoIl: new Date().toISOString(),
      note: "Dati vivi del progetto (tabelle ps_*), non uno snapshot GTFS.",
      /* Il progetto dice cosa c'è nella rete, non cosa c'è INTORNO: per
       * quello ci sono le rotte territorio (Mapbox mediato dal server). */
      territorio: {
        descrizione: "Dati cartografici sul territorio attorno a un punto",
        capacita: "/api/ai/argos/territory",
      },
    };

    if (include.has("progetto")) {
      out.progetto = {
        id: p.id, nome: p.name, descrizione: p.description ?? null,
        creatoIl: p.created_at, aggiornatoIl: p.updated_at,
        materializzatoIl: p.materialized_at ?? null,
        /* Se il progetto è stato modificato dopo l'ultima materializzazione,
         * l'esercizio pubblicato NON riflette il lavoro in corso: è una cosa
         * che l'agente deve poter dire. */
        esercizioAllineato: p.materialized_at
          ? new Date(p.updated_at) <= new Date(p.materialized_at)
          : false,
      };
    }

    /* ── Rete: linee, varianti, fermate ── */
    if (include.has("rete") || include.has("cartografia")) {
      const routes = ((await db.execute<any>(sql`
        SELECT r.id::text AS id, r.code, r.short_name, r.long_name, r.color, r.route_type,
               (SELECT count(*) FROM ps_route_variants v WHERE v.route_id = r.id)::int AS varianti,
               (SELECT count(*) FROM ps_trips t WHERE t.route_id = r.id)::int AS corse
          FROM ps_routes r WHERE r.project_id = ${projectId}::uuid
         ORDER BY r.code NULLS LAST, r.short_name`)) as any).rows ?? [];

      const stops = ((await db.execute<any>(sql`
        SELECT id::text AS id, code, name, lat, lon
          FROM ps_stops WHERE project_id = ${projectId}::uuid ORDER BY name`)) as any).rows ?? [];

      if (include.has("rete")) {
        out.rete = {
          linee: capped(routes.map((r: any) => ({
            id: r.id, codice: r.code ?? r.short_name, nome: r.long_name ?? null,
            colore: r.color ?? null, varianti: r.varianti, corse: r.corse,
          })), limit),
          fermate: capped(stops.map((s: any) => ({
            id: s.id, codice: s.code ?? null, nome: s.name,
            lat: Number(s.lat), lon: Number(s.lon),
          })), limit),
        };
      }

      /* ── Cartografia: posizioni e geometrie ── */
      if (include.has("cartografia")) {
        const lats = stops.map((s: any) => Number(s.lat)).filter(Number.isFinite);
        const lons = stops.map((s: any) => Number(s.lon)).filter(Number.isFinite);
        const bbox = lats.length > 0 ? {
          minLat: Math.min(...lats), maxLat: Math.max(...lats),
          minLon: Math.min(...lons), maxLon: Math.max(...lons),
        } : null;

        const shapes = ((await db.execute<any>(sql`
          SELECT s.geometry, s.distance_m, v.route_id::text AS route_id, v.name AS variante,
                 r.code, r.short_name
            FROM ps_shapes s
            JOIN ps_route_variants v ON v.id = s.variant_id
            JOIN ps_routes r ON r.id = v.route_id
           WHERE s.project_id = ${projectId}::uuid`)) as any).rows ?? [];

        out.cartografia = {
          areaServita: bbox,
          centro: bbox ? {
            lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2,
          } : null,
          estensioneKm: bbox
            ? +haversineKm(bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon).toFixed(1)
            : null,
          /* Le geometrie complete sarebbero enormi: si dà l'estremo, la
           * lunghezza e un tracciato semplificato, che basta per ragionare
           * su dove passa una linea senza trasferire migliaia di vertici. */
          percorsi: capped(shapes.map((sh: any) => {
            const coords: number[][] = sh.geometry?.coordinates
              ?? sh.geometry?.geometry?.coordinates ?? [];
            const step = Math.max(1, Math.ceil(coords.length / 40));
            return {
              linea: sh.code ?? sh.short_name, variante: sh.variante,
              lunghezzaKm: sh.distance_m != null ? +(Number(sh.distance_m) / 1000).toFixed(2) : null,
              vertici: coords.length,
              tracciatoSemplificato: coords.filter((_: any, i: number) => i % step === 0)
                .map((c: number[]) => [+Number(c[0]).toFixed(5), +Number(c[1]).toFixed(5)]),
            };
          }), Math.min(limit, 80)),
        };
      }
    }

    /* ── Validità ── */
    if (include.has("validita")) {
      const cal = ((await db.execute<any>(sql`
        SELECT c.id::text AS id, c.code, c.name,
               c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday,
               c.start_date::text AS start_date, c.end_date::text AS end_date,
               (SELECT count(*) FROM ps_trips t WHERE t.calendar_id = c.id)::int AS corse
          FROM ps_calendars c WHERE c.project_id = ${projectId}::uuid ORDER BY c.code`)) as any).rows ?? [];
      const GIORNI = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
      out.validita = capped(cal.map((c: any) => ({
        id: c.id, codice: c.code, nome: c.name ?? null,
        giorni: [c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday]
          .map((on: boolean, i: number) => (on ? GIORNI[i] : null)).filter(Boolean),
        dal: c.start_date, al: c.end_date, corse: Number(c.corse ?? 0),
      })), limit);
    }

    /* ── Orari: come è distribuito il servizio ── */
    if (include.has("orari")) {
      const rows = ((await db.execute<any>(sql`
        SELECT r.code, r.short_name, t.calendar_id::text AS calendar_id,
               min(st.departure_time) AS prima, max(st.departure_time) AS ultima,
               count(DISTINCT t.id)::int AS corse
          FROM ps_trips t
          JOIN ps_routes r ON r.id = t.route_id
          LEFT JOIN ps_stop_times st ON st.trip_id = t.id
         WHERE t.project_id = ${projectId}::uuid
         GROUP BY r.code, r.short_name, t.calendar_id`)) as any).rows ?? [];
      out.orari = {
        perLineaEValidita: capped(rows.map((r: any) => ({
          linea: r.code ?? r.short_name, validitaId: r.calendar_id,
          corse: Number(r.corse ?? 0),
          primaPartenza: r.prima ?? null, ultimaPartenza: r.ultima ?? null,
        })), limit),
      };
    }

    /* ── Infrastruttura: nodi, depositi, archi fuorilinea (con posizioni) ── */
    if (include.has("infrastruttura")) {
      const nodi = ((await db.execute<any>(sql`
        SELECT c.id::text AS id, c.name, c.kind, c.center_lat, c.center_lon, c.radius_m,
               (SELECT count(*) FROM ps_stops s WHERE s.cluster_id = c.id)::int AS fermate
          FROM ps_stop_clusters c WHERE c.project_id = ${projectId}::uuid`)) as any).rows ?? [];

      let depositi: any[] = [];
      try {
        depositi = ((await db.execute<any>(sql`
          SELECT id::text AS id, name, lat, lon, capacity, ps_project_id::text AS scope
            FROM depots
           WHERE ps_project_id IS NULL OR ps_project_id = ${projectId}::uuid`)) as any).rows ?? [];
      } catch { /* colonna scope assente su DB legacy */ }

      let archi: any[] = [];
      try {
        archi = ((await db.execute<any>(sql`
          SELECT from_name, to_name, from_lat, from_lon, to_lat, to_lon,
                 road_km, travel_min, custom_km, custom_min, source
            FROM deadhead_arcs
           WHERE ps_project_id IS NULL OR ps_project_id = ${projectId}::uuid`)) as any).rows ?? [];
      } catch { /* tabella assente */ }

      out.infrastruttura = {
        nodi: capped(nodi.map((n: any) => ({
          id: n.id, nome: n.name, tipo: n.kind, fermate: n.fermate,
          lat: n.center_lat != null ? Number(n.center_lat) : null,
          lon: n.center_lon != null ? Number(n.center_lon) : null,
          raggioM: n.radius_m ?? null,
        })), limit),
        depositi: capped(depositi.map((d: any) => ({
          id: d.id, nome: d.name, lat: Number(d.lat), lon: Number(d.lon),
          capacita: d.capacity ?? null,
          ambito: d.scope ? "solo questo progetto" : "globale",
        })), limit),
        archiFuorilinea: capped(archi.map((a: any) => ({
          da: a.from_name, a: a.to_name,
          daLat: Number(a.from_lat), daLon: Number(a.from_lon),
          aLat: Number(a.to_lat), aLon: Number(a.to_lon),
          km: a.custom_km ?? a.road_km, minuti: a.custom_min ?? a.travel_min,
          // Un valore curato a mano è una decisione del pianificatore, non una stima
          curatoAMano: a.custom_min != null || a.custom_km != null || a.source === "manual",
        })), limit),
      };
    }

    /* ── Poli attrattori con posizione ── */
    if (include.has("poli")) {
      const pois = ((await db.execute<any>(sql`
        SELECT id::text AS id, name, category, lat, lng
          FROM points_of_interest
         WHERE category IN ('school','office','industrial','hospital')`)) as any).rows ?? [];
      out.poli = capped(pois.map((x: any) => ({
        id: x.id, nome: x.name ?? x.category, categoria: x.category,
        famiglia: x.category === "school" ? "scuola" : "lavoro",
        lat: Number(x.lat), lon: Number(x.lng),
      })), limit);
    }

    /* ── Zone vietate del progetto ── */
    if (include.has("zone")) {
      let zone: any[] = [];
      try {
        zone = ((await db.execute<any>(sql`
          SELECT id::text AS id, name, active, polygon
            FROM ps_no_go_zones WHERE project_id = ${projectId}::uuid`)) as any).rows ?? [];
      } catch { /* tabella assente */ }
      out.zone = { zoneVietate: capped(zone.map((z: any) => ({
        id: z.id, nome: z.name, attiva: !!z.active,
        vertici: Array.isArray(z.polygon) ? z.polygon.length : null,
      })), limit) };
    }

    res.json(out);
  } catch (err: any) {
    req.log?.error?.(err, "argos context");
    res.status(500).json({ error: "Errore nel contesto di progetto", detail: err?.message });
  }
});

export default router;
