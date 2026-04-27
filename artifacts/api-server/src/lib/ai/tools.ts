/**
 * Tool definitions per il Copilot.
 *
 * Approccio: ogni tool fa internal HTTP fetch ai propri endpoint REST
 * (così non duplichiamo logica e cogliamo middlewares/validazioni esistenti).
 *
 * Per query semplici (count, list paginati) usa direttamente Drizzle.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@workspace/db";
import {
  busStops,
  busRoutes,
  gtfsRoutes,
  gtfsStops,
  pointsOfInterest,
  censusSections,
  scenarios,
  trafficSnapshots,
} from "@workspace/db/schema";
import { sql, ilike, eq } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────
// Internal HTTP helper — chiama gli endpoint sul nostro stesso server
// ─────────────────────────────────────────────────────────────
const INTERNAL_BASE =
  process.env.INTERNAL_API_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;

async function internalGet(path: string): Promise<any> {
  const r = await fetch(`${INTERNAL_BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

async function internalPost(path: string, body: any): Promise<any> {
  const r = await fetch(`${INTERNAL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`POST ${path} → ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

// ─────────────────────────────────────────────────────────────
// TOOL DEFINITIONS (Anthropic schema)
// ─────────────────────────────────────────────────────────────
export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "list_routes",
    description:
      "Elenca le linee di bus presenti nel feed GTFS. Filtra opzionalmente per nome/short_name (LIKE case-insensitive) o per network (urbano_ancona, urbano_jesi, urbano_senigallia, urbano_falconara, urbano_castelfidardo, extraurbano). Restituisce id, short_name, long_name, network, route_color.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Sottostringa nel nome o short_name (opzionale)" },
        network: { type: "string", description: "Filtra per network (opzionale)" },
        limit: { type: "number", description: "Max righe (default 30)" },
      },
    },
  },
  {
    name: "search_stops",
    description:
      "Cerca fermate GTFS per nome (LIKE case-insensitive) o nelle vicinanze di un punto (lat/lon + raggio in metri). Restituisce id, name, lat, lon, distanza in metri se geo-search.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sottostringa nel nome fermata" },
        lat: { type: "number" },
        lon: { type: "number" },
        radius_m: { type: "number", description: "Raggio in metri se ricerca per coord (default 500)" },
        limit: { type: "number", description: "Max righe (default 25)" },
      },
    },
  },
  {
    name: "get_routes_serving_area",
    description:
      "Trova le linee che servono una determinata città/area. Cerca fermate il cui nome contiene la stringa, poi risale alle linee che le servono. Esempio: 'Senigallia', 'Numana', 'stazione Ancona'.",
    input_schema: {
      type: "object",
      properties: {
        area_name: { type: "string", description: "Nome città o zona" },
        max_routes: { type: "number", description: "Max linee restituite (default 30)" },
      },
      required: ["area_name"],
    },
  },
  {
    name: "get_network_stats",
    description:
      "Restituisce statistiche aggregate del sistema di trasporto: numero fermate, linee, viaggi/trip, popolazione totale coperta, POI totali, sezioni censuarie. Utile come overview iniziale.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_underserved_zones",
    description:
      "Restituisce le zone ad alta domanda con bassa o nulla copertura di trasporto pubblico. Usa l'analisi domanda/offerta del sistema.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max zone (default 20)" },
      },
    },
  },
  {
    name: "get_coverage_stats",
    description:
      "Statistiche di copertura: % popolazione raggiunta dalle fermate, numero sezioni coperte, popolazione totale.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_traffic_stats",
    description:
      "Statistiche aggregate sul traffico TomTom: velocità media, congestione, snapshot più recenti, top segmenti congestionati.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_pois",
    description:
      "Restituisce POI (Punti di Interesse OSM) per categoria. Categorie disponibili: school, hospital, shopping, transit, industrial, leisure, office. Restituisce conteggi e top esempi.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Categoria POI (opzionale, se vuoto restituisce tutte)" },
        limit: { type: "number", description: "Max POI (default 50)" },
      },
    },
  },
  {
    name: "list_scenarios",
    description:
      "Elenca gli scenari di servizio salvati nel sistema (id, nome, status, descrizione, data creazione).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "simulate_fare",
    description:
      "Simula il prezzo del biglietto per una specifica linea di bus, dato lo stop di origine, lo stop di destinazione e la data. Restituisce tariffa, fascia, network, importo.",
    input_schema: {
      type: "object",
      properties: {
        route_id: { type: "string", description: "GTFS route_id" },
        from_stop_id: { type: "string", description: "GTFS stop_id origine" },
        to_stop_id: { type: "string", description: "GTFS stop_id destinazione" },
        date: { type: "string", description: "Data YYYYMMDD (opzionale, default oggi)" },
      },
      required: ["route_id", "from_stop_id", "to_stop_id"],
    },
  },
  {
    name: "plan_journey",
    description:
      "Pianifica un viaggio multi-bus tra due punti geografici (lat/lon). Restituisce alternative ordinate per tempo/prezzo, ognuna con le sue legs (a piedi + bus + cambi). Include cambio bus se necessario.",
    input_schema: {
      type: "object",
      properties: {
        origin_lat: { type: "number" },
        origin_lon: { type: "number" },
        dest_lat: { type: "number" },
        dest_lon: { type: "number" },
        date: { type: "string", description: "Data YYYYMMDD (default oggi)" },
        time: { type: "string", description: "Ora minima partenza HH:MM (default ora corrente)" },
        max_results: { type: "number", description: "Max alternative (default 5)" },
      },
      required: ["origin_lat", "origin_lon", "dest_lat", "dest_lon"],
    },
  },

  // ───────── TOOL UI (azioni grafiche, non leggono dati) ─────────
  {
    name: "ui_navigate",
    description:
      "AZIONE UI: naviga l'utente verso una pagina dell'app. Usalo quando un'analisi è più chiara su una pagina specifica (es: zone scoperte → /territory; linee → /network; mappa traffico → /traffic). Sempre PRIMA di highlight/focus_map. Path validi: /dashboard, /traffic, /territory, /network, /data, /scenarios, /intermodal, /trip-planner, /fares, /fucina, /optimization.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path dell'app (es. /territory)" },
        reason: { type: "string", description: "Breve motivo (mostrato nella chat)" },
      },
      required: ["path"],
    },
  },
  {
    name: "ui_focus_map",
    description:
      "AZIONE UI: centra la mappa visibile su lat/lng con uno zoom. Usalo dopo ui_navigate, quando vuoi mostrare un'area specifica all'utente. Zoom: 9=provincia, 12=città, 15=quartiere, 17=fermata.",
    input_schema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        zoom: { type: "number", description: "Livello zoom 8-18 (default 13)" },
        label: { type: "string", description: "Etichetta opzionale (es. 'Senigallia centro')" },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "ui_highlight",
    description:
      "AZIONE UI: lancia un TENTACOLO neon che evidenzia un elemento dell'interfaccia. Il tentacolo è una curva animata che parte dall'avatar di Virgilio e si avvolge sull'elemento. Usalo per attirare l'attenzione su una linea, fermata, zona, voce di menu o KPI menzionati nella risposta. Puoi chiamarlo PIÙ VOLTE per evidenziare più elementi insieme. ID supportati: 'route:<routeId>', 'stop:<stopId>', 'zone:<zoneId>', 'nav:<page>' (es. nav:territory), 'kpi:<key>' (es. kpi:coverage).",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "ID logico dell'elemento (es. route:42, nav:territory)" },
        label: { type: "string", description: "Tooltip mostrato sul tentacolo" },
        color: { type: "string", enum: ["emerald", "amber", "rose", "cyan"], description: "Colore tentacolo (default emerald)" },
      },
      required: ["target"],
    },
  },
  {
    name: "ui_plan_trip",
    description:
      "AZIONE UI: pilota la pagina /trip-planner. Naviga, riempie i campi origine/destinazione/data/ora e clicca CALCOLA. Usalo quando l'utente chiede di simulare un viaggio (es. 'voglio andare da X a Y'). Devi passare lat/lon di entrambi i punti (puoi usare prima search_stops o coordinate note). NON chiamare ui_navigate prima: ci pensa questo tool. Dopo l'esecuzione il pannello risultati comparirà animato.",
    input_schema: {
      type: "object",
      properties: {
        origin_lat: { type: "number" },
        origin_lon: { type: "number" },
        origin_label: { type: "string", description: "Etichetta umana origine (es. 'Stazione Ancona')" },
        dest_lat: { type: "number" },
        dest_lon: { type: "number" },
        dest_label: { type: "string", description: "Etichetta umana destinazione" },
        date: { type: "string", description: "Data YYYYMMDD (default oggi)" },
        time: { type: "string", description: "Ora HH:MM (default 08:00)" },
        allow_transfers: { type: "boolean", description: "Considera cambi bus (default true)" },
      },
      required: ["origin_lat", "origin_lon", "dest_lat", "dest_lon"],
    },
  },
  {
    name: "ui_fucina_wizard",
    description:
      "AZIONE UI: pilota la pagina /fucina (Scheduling Engine). Permette di avviare il wizard guidato per creare turni macchina/autista. Sub-azioni:\n" +
      "- action='start': naviga a /fucina, salta lo splash, posiziona allo step 0 (Dati GTFS).\n" +
      "- action='goto_step': vai allo step N (0=GTFS, 1=Vetture, 2=Deposito, 3=Cluster, 4=Fuori Linea, 5=Ottimizzazione, 6=Area Lavoro). Usa SOLO step già completati o successivo immediato.\n" +
      "- action='highlight_field': lancia un tentacolo neon su un campo specifico (vedi field_id).\n" +
      "Usa questo tool quando l'utente chiede 'aiutami a creare turni', 'costruisci un servizio', 'vorrei programmare un autista' ecc. Poi guida l'utente con domande nella chat (1 alla volta).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "goto_step", "highlight_field"] },
        step: { type: "number", description: "Step 0-6 (per goto_step)" },
        field_id: { type: "string", description: "ID del campo (per highlight_field), es. 'fucina:gtfs-date', 'fucina:routes-table', 'fucina:depot-list', 'fucina:run-optimizer'" },
        label: { type: "string", description: "Etichetta tooltip tentacolo" },
      },
      required: ["action"],
    },
  },
];

// Set helper per riconoscere i tool UI
export const UI_TOOL_NAMES = new Set([
  "ui_navigate",
  "ui_focus_map",
  "ui_highlight",
  "ui_plan_trip",
  "ui_fucina_wizard",
]);

// ─────────────────────────────────────────────────────────────
// TOOL EXECUTION
// ─────────────────────────────────────────────────────────────
export async function executeTool(
  name: string,
  input: Record<string, any>,
): Promise<any> {
  switch (name) {
    case "list_routes": {
      const limit = Math.min(input.limit || 30, 200);
      const conds: any[] = [];
      if (input.search) {
        const s = `%${input.search}%`;
        conds.push(sql`(${gtfsRoutes.routeShortName} ILIKE ${s} OR ${gtfsRoutes.routeLongName} ILIKE ${s})`);
      }
      const where = conds.length ? sql.join(conds, sql` AND `) : sql`TRUE`;
      const rows = await db.execute(sql`
        SELECT route_id, route_short_name, route_long_name, route_color, route_text_color
        FROM gtfs_routes
        WHERE ${where}
        ORDER BY route_short_name
        LIMIT ${limit}
      `);
      return { count: rows.rows.length, routes: rows.rows };
    }

    case "search_stops": {
      const limit = Math.min(input.limit || 25, 100);
      if (input.lat && input.lon) {
        const radius = input.radius_m || 500;
        const rows = await db.execute(sql`
          SELECT stop_id, stop_name, stop_lat, stop_lon,
            (6371000 * acos(
              LEAST(1, GREATEST(-1,
                cos(radians(${input.lat})) * cos(radians(stop_lat)) *
                cos(radians(stop_lon) - radians(${input.lon})) +
                sin(radians(${input.lat})) * sin(radians(stop_lat))
              ))
            ))::int AS distance_m
          FROM gtfs_stops
          WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL
          ORDER BY distance_m ASC
          LIMIT ${limit}
        `);
        const filtered = (rows.rows as any[]).filter(r => r.distance_m <= radius);
        return { count: filtered.length, stops: filtered };
      }
      if (input.name) {
        const rows = await db
          .select({
            stop_id: gtfsStops.stopId,
            stop_name: gtfsStops.stopName,
            stop_lat: gtfsStops.stopLat,
            stop_lon: gtfsStops.stopLon,
          })
          .from(gtfsStops)
          .where(ilike(gtfsStops.stopName, `%${input.name}%`))
          .limit(limit);
        return { count: rows.length, stops: rows };
      }
      return { error: "Specifica 'name' oppure 'lat'+'lon'" };
    }

    case "get_routes_serving_area": {
      const limit = Math.min(input.max_routes || 30, 100);
      const rows = await db.execute(sql`
        SELECT DISTINCT r.route_id, r.route_short_name, r.route_long_name, r.route_color
        FROM gtfs_routes r
        JOIN gtfs_trips t ON t.route_id = r.route_id
        JOIN gtfs_stop_times st ON st.trip_id = t.trip_id
        JOIN gtfs_stops s ON s.stop_id = st.stop_id
        WHERE s.stop_name ILIKE ${`%${input.area_name}%`}
        ORDER BY r.route_short_name
        LIMIT ${limit}
      `);
      return {
        area: input.area_name,
        count: rows.rows.length,
        routes: rows.rows,
      };
    }

    case "get_network_stats": {
      const [stops] = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM gtfs_stops`)).rows as any;
      const [routes] = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM gtfs_routes`)).rows as any;
      const [trips] = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM gtfs_trips`)).rows as any;
      const [pop] = (await db.execute(sql`SELECT COALESCE(SUM(population),0)::int AS p, COUNT(*)::int AS sec FROM census_sections`)).rows as any;
      const [poi] = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM points_of_interest`)).rows as any;
      const [busStopsCount] = (await db.execute(sql`SELECT COUNT(*)::int AS c FROM bus_stops`)).rows as any;
      return {
        gtfs_stops: stops?.c ?? 0,
        gtfs_routes: routes?.c ?? 0,
        gtfs_trips: trips?.c ?? 0,
        custom_bus_stops: busStopsCount?.c ?? 0,
        population_total: pop?.p ?? 0,
        census_sections: pop?.sec ?? 0,
        pois_total: poi?.c ?? 0,
      };
    }

    case "get_underserved_zones": {
      const limit = input.limit || 20;
      try {
        const data = await internalGet(`/api/analysis/underserved?limit=${limit}`);
        return data;
      } catch (e: any) {
        return { error: e.message };
      }
    }

    case "get_coverage_stats": {
      try {
        return await internalGet("/api/analysis/coverage");
      } catch (e: any) {
        return { error: e.message };
      }
    }

    case "get_traffic_stats": {
      try {
        return await internalGet("/api/traffic/stats");
      } catch (e: any) {
        return { error: e.message };
      }
    }

    case "get_pois": {
      const limit = Math.min(input.limit || 50, 200);
      const cat = input.category;
      const counts = await db.execute(sql`
        SELECT category, COUNT(*)::int AS c
        FROM points_of_interest
        ${cat ? sql`WHERE category = ${cat}` : sql``}
        GROUP BY category
        ORDER BY c DESC
      `);
      const sample = await db.execute(sql`
        SELECT name, category, lat, lng
        FROM points_of_interest
        ${cat ? sql`WHERE category = ${cat}` : sql``}
        LIMIT ${limit}
      `);
      return {
        by_category: counts.rows,
        sample: sample.rows,
      };
    }

    case "list_scenarios": {
      const rows = await db.select().from(scenarios).limit(50);
      return { count: rows.length, scenarios: rows };
    }

    case "simulate_fare": {
      const date = input.date || new Date().toISOString().slice(0, 10).replace(/-/g, "");
      try {
        return await internalPost("/api/fares/simulate", {
          routeId: input.route_id,
          fromStopId: input.from_stop_id,
          toStopId: input.to_stop_id,
          date,
        });
      } catch (e: any) {
        return { error: e.message };
      }
    }

    case "plan_journey": {
      const date = input.date || new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const time = input.time || new Date().toTimeString().slice(0, 5);
      try {
        return await internalPost("/api/fares/journey-plan", {
          originLat: input.origin_lat,
          originLon: input.origin_lon,
          destLat: input.dest_lat,
          destLon: input.dest_lon,
          date,
          time,
          maxResults: input.max_results || 5,
        });
      } catch (e: any) {
        return { error: e.message };
      }
    }

    // ───── TOOL UI: solo conferma al modello, l'effetto è frontend ─────
    case "ui_navigate":
      return { ok: true, action: "navigate", path: input.path, reason: input.reason };

    case "ui_focus_map":
      return { ok: true, action: "focus_map", lat: input.lat, lng: input.lng, zoom: input.zoom ?? 13, label: input.label };

    case "ui_highlight":
      return { ok: true, action: "highlight", target: input.target, label: input.label, color: input.color || "emerald" };

    case "ui_plan_trip":
      return {
        ok: true,
        action: "plan_trip",
        origin: { lat: input.origin_lat, lon: input.origin_lon, label: input.origin_label },
        dest: { lat: input.dest_lat, lon: input.dest_lon, label: input.dest_label },
        date: input.date,
        time: input.time,
        allow_transfers: input.allow_transfers,
      };

    case "ui_fucina_wizard":
      return {
        ok: true,
        action: "fucina_wizard",
        sub_action: input.action,
        step: input.step,
        field_id: input.field_id,
        label: input.label,
      };

    default:
      return { error: `Tool sconosciuto: ${name}` };
  }
}
