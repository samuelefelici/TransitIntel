/**
 * L'Intermodale su un database vero (TEST_DATABASE_URL, migrato: in CI il job
 * migrazioni-postgres). GET /intermodal/hubs, /analyze e /pois rispondevano
 * sempre 500 fuori da un progetto: la ricerca degli hub chiedeva
 * gtfs_stops.location_type, una colonna che non esiste (42703), e con un feed
 * caricato /analyze confrontava i giorni di gtfs_calendar (interi) con `true`
 * (42883). Qui le tre rotte girano sullo schema delle migrazioni, sui due
 * rami: un feed GTFS e un progetto di Planning Studio.
 *
 * Diversi passaggi dell'Intermodale inghiottono gli errori («tabella
 * assente»): una colonna sbagliata lì darebbe una risposta 200 con dati in
 * meno. Per questo si registra ogni query che Postgres rifiuta, e alla fine
 * non deve essercene nessuna.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/intermodal";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const UTENTE = "c1000000-0000-0000-0000-000000000001";
const UTENTE_SEMPLICE = "c1000000-0000-0000-0000-000000000002";
const FEED = "c1000000-0000-0000-0000-0000000000f1";
const PROG = "c1000000-0000-0000-0000-0000000000a1";
const P_STAZIONE = "c1000000-0000-0000-0000-0000000000a2";
const P_VICINA = "c1000000-0000-0000-0000-0000000000a3";
const P_LINEA = "c1000000-0000-0000-0000-0000000000a4";
const P_VARIANTE = "c1000000-0000-0000-0000-0000000000a5";
const P_CAL_FERIALE = "c1000000-0000-0000-0000-0000000000a6";
const P_CAL_SABATO = "c1000000-0000-0000-0000-0000000000a7";
const P_CORSA_FERIALE = "c1000000-0000-0000-0000-0000000000a8";
const P_CORSA_SABATO = "c1000000-0000-0000-0000-0000000000a9";
const P_GIORNO_TIPO = "c1000000-0000-0000-0000-0000000000aa";
const POI_UFFICI = "c1000000-0000-0000-0000-0000000000b1";
const POI_PARCO = "c1000000-0000-0000-0000-0000000000b2";
const POI_STAZIONE = "c1000000-0000-0000-0000-0000000000b3";
const POI_UFFICI_PROGETTO = "c1000000-0000-0000-0000-0000000000b4";
/* un comune che non esiste: il suo riquadro tiene fuori gli hub cablati di Ancona */
const COMUNE = "999990";

/* admin: sceglie il feed con ?feedId= senza esserne il proprietario */
const app = appDiProva(router, utenteDiProva(UTENTE, [], "admin"));
const get = (percorso: string) => request(app).get(`/api/intermodal/${percorso}`);
/* chi non amministra: il feed si sceglie con il filtro per proprietario, progetti e condivisioni */
const appSemplice = appDiProva(router, utenteDiProva(UTENTE_SEMPLICE));

describe.runIf(!!process.env.TEST_DATABASE_URL)("l'Intermodale, sul database", () => {
  const rifiutate: string[] = [];

  const pulisci = async () => {
    /* prima le righe che una chiave esterna RESTRICT terrebbe ferme */
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id IN (${P_CORSA_FERIALE}::uuid, ${P_CORSA_SABATO}::uuid)`);
    await db.execute(sql`DELETE FROM ps_day_calendar WHERE project_id = ${PROG}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${PROG}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${PROG}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${FEED}::uuid`);
    await db.execute(sql`DELETE FROM points_of_interest
                          WHERE id IN (${POI_UFFICI}::uuid, ${POI_PARCO}::uuid, ${POI_STAZIONE}::uuid, ${POI_UFFICI_PROGETTO}::uuid)`);
    await db.execute(sql`DELETE FROM census_sections WHERE istat_code = ${COMUNE + "000001"}`);
  };

  beforeAll(async () => {
    await pulisci();

    /* ── Un feed GTFS: una stazione (dal nome), una fermata a 110 m, una lontana ── */
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename) VALUES (${FEED}::uuid, 'intermodale-prova.zip')`);
    await db.execute(sql`
      INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon)
      VALUES (${FEED}::uuid, 'S-STAZ', 'STAZIONE FS PROVA', 45.0000, 9.0000),
             (${FEED}::uuid, 'S-VIC',  'Via Roma 1',        45.0010, 9.0000),
             (${FEED}::uuid, 'S-LONT', 'Via Lontana',       45.1000, 9.0000)
    `);
    await db.execute(sql`
      INSERT INTO gtfs_routes (feed_id, route_id, route_short_name, route_long_name, route_color)
      VALUES (${FEED}::uuid, 'R1', '7', 'Stazione - Ospedale', '#0055aa')
    `);
    await db.execute(sql`
      INSERT INTO gtfs_calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
      VALUES (${FEED}::uuid, 'FER', 1, 1, 1, 1, 1, 0, 0, '20260101', '20261231'),
             (${FEED}::uuid, 'SAB', 0, 0, 0, 0, 0, 1, 0, '20260101', '20261231')
    `);
    await db.execute(sql`
      INSERT INTO gtfs_trips (feed_id, trip_id, route_id, service_id)
      VALUES (${FEED}::uuid, 'T-FER', 'R1', 'FER'), (${FEED}::uuid, 'T-SAB', 'R1', 'SAB')
    `);
    await db.execute(sql`
      INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_time, departure_time)
      VALUES (${FEED}::uuid, 'T-FER', 'S-STAZ', 1, '08:00:00', '08:00:00'),
             (${FEED}::uuid, 'T-FER', 'S-VIC',  2, '08:05:00', '08:05:00'),
             (${FEED}::uuid, 'T-FER', 'S-LONT', 3, '08:30:00', '08:30:00'),
             (${FEED}::uuid, 'T-SAB', 'S-STAZ', 1, '09:00:00', '09:00:00'),
             (${FEED}::uuid, 'T-SAB', 'S-LONT', 2, '09:30:00', '09:30:00')
    `);
    await db.execute(sql`
      INSERT INTO census_sections (istat_code, centroid_lat, centroid_lng) VALUES (${COMUNE + "000001"}, 45.0000, 9.0000)
    `);
    /* la stazione dai POI è a 2 km da quella del feed: un hub a sé */
    await db.execute(sql`
      INSERT INTO points_of_interest (id, name, category, lat, lng, properties)
      VALUES (${POI_UFFICI}::uuid, 'Uffici di prova', 'office', 45.0020, 9.0000, '{}'::jsonb),
             (${POI_PARCO}::uuid, 'Parco di prova', 'leisure', 45.0030, 9.0000, '{}'::jsonb),
             (${POI_STAZIONE}::uuid, 'Stazione di Prova Nord', 'transit', 45.0180, 9.0000,
              '{"types": ["train_station"], "place_id": "prova-nord"}'::jsonb),
             (${POI_UFFICI_PROGETTO}::uuid, 'Uffici del progetto', 'office', 45.5020, 9.5000, '{}'::jsonb)
    `);

    /* ── Un progetto: la stazione lo è per location_type, non per il nome ── */
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${PROG}::uuid, ${UTENTE}::uuid, 'Intermodale di prova')`);
    await db.execute(sql`
      INSERT INTO ps_stops (id, project_id, code, name, lat, lon, location_type)
      VALUES (${P_STAZIONE}::uuid, ${PROG}::uuid, '30001', 'Piazza Rosselli', 45.5000, 9.5000, 1),
             (${P_VICINA}::uuid,   ${PROG}::uuid, '30002', 'Via Marsala',     45.5010, 9.5000, 0)
    `);
    await db.execute(sql`
      INSERT INTO ps_routes (id, project_id, code, short_name, long_name, color)
      VALUES (${P_LINEA}::uuid, ${PROG}::uuid, '12', '12', 'Rosselli - Ospedale', '#aa5500')
    `);
    await db.execute(sql`
      INSERT INTO ps_route_variants (id, project_id, route_id, name)
      VALUES (${P_VARIANTE}::uuid, ${PROG}::uuid, ${P_LINEA}::uuid, 'Andata')
    `);
    await db.execute(sql`
      INSERT INTO ps_calendars (id, project_id, code, monday, tuesday, wednesday, thursday, friday, saturday, start_date, end_date)
      VALUES (${P_CAL_FERIALE}::uuid, ${PROG}::uuid, 'FER', true, true, true, true, true, false, '2026-01-01', '2026-12-31'),
             (${P_CAL_SABATO}::uuid,  ${PROG}::uuid, 'SAB', false, false, false, false, false, true, '2026-01-01', '2026-12-31')
    `);
    await db.execute(sql`
      INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id)
      VALUES (${P_CORSA_FERIALE}::uuid, ${PROG}::uuid, ${P_LINEA}::uuid, ${P_VARIANTE}::uuid, ${P_CAL_FERIALE}::uuid),
             (${P_CORSA_SABATO}::uuid,  ${PROG}::uuid, ${P_LINEA}::uuid, ${P_VARIANTE}::uuid, ${P_CAL_SABATO}::uuid)
    `);
    await db.execute(sql`
      INSERT INTO ps_stop_times (trip_id, stop_id, stop_seq, arrival_time, departure_time)
      VALUES (${P_CORSA_FERIALE}::uuid, ${P_STAZIONE}::uuid, 1, '07:00:00', '07:00:00'),
             (${P_CORSA_FERIALE}::uuid, ${P_VICINA}::uuid,   2, '07:03:00', '07:03:00'),
             (${P_CORSA_SABATO}::uuid,  ${P_STAZIONE}::uuid, 1, '10:00:00', '10:00:00')
    `);
    await db.execute(sql`
      INSERT INTO ps_day_types (id, project_id, code, name, color)
      VALUES (${P_GIORNO_TIPO}::uuid, ${PROG}::uuid, 'prova', 'Giorno di prova', '#888888')
    `);
    await db.execute(sql`
      INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
      VALUES (${P_CORSA_FERIALE}::uuid, ${P_GIORNO_TIPO}::uuid, true)
    `);
    /* l'11/11 ha un giorno-tipo: per quella data si legge anche la matrice corsa × giorno-tipo
     * (le corse qui hanno un calendario, che decide comunque) */
    await db.execute(sql`
      INSERT INTO ps_day_calendar (project_id, date, day_type_id) VALUES (${PROG}::uuid, '2026-11-11', ${P_GIORNO_TIPO}::uuid)
    `);

    /* senza chiave la ricerca degli hub non chiede le stazioni a Google Places */
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    /* da qui in poi: ogni query rifiutata da Postgres, anche se chi la lancia la inghiotte */
    const vera = pool.query.bind(pool) as (...a: unknown[]) => unknown;
    vi.spyOn(pool, "query").mockImplementation(((...a: unknown[]) => {
      const esito = vera(...a);
      if (esito instanceof Promise) esito.catch((e: { code?: string; message?: string }) => rifiutate.push(`${e?.code}: ${e?.message}`));
      return esito;
    }) as never);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await pulisci();
  });

  const hubDi = (corpo: any, nome: string) => (corpo.hubs as any[]).find(h => h.hub.name === nome);
  const orari = (hub: any) => (hub.busLines as any[]).map(l => ({ linea: l.routeShortName, orari: l.times }));

  it.each(["hubs", "analyze", "pois"])("senza parametri: %s risponde 200, a chi amministra e a chi no", async (rotta) => {
    const r = await get(rotta);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const semplice = await request(appSemplice).get(`/api/intermodal/${rotta}`);
    expect(semplice.status, JSON.stringify(semplice.body)).toBe(200);
  });

  describe("fuori da un progetto, su un feed", () => {
    it("hubs: la stazione riconosciuta dal nome e quella dei POI, nel riquadro del comune", async () => {
      const r = await get(`hubs?feedId=${FEED}&municipality=${COMUNE}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      /* prima quella del feed, poi quella dei POI: l'ordine in cui la ricerca le trova */
      expect((r.body as any[]).map(h => ({ name: h.name, type: h.type, source: h.source })))
        .toEqual([
          { name: "STAZIONE FS PROVA", type: "railway", source: "gtfs-auto" },
          { name: "Stazione di Prova Nord", type: "railway", source: "gtfs-auto" },
        ]);
    });

    it("hubs con routeIds e con bbox: 200, con la stazione servita dalla linea", async () => {
      const perLinea = await get(`hubs?feedId=${FEED}&municipality=${COMUNE}&routeIds=R1`);
      expect(perLinea.status, JSON.stringify(perLinea.body)).toBe(200);
      expect((perLinea.body as any[]).map(h => h.name)).toContain("STAZIONE FS PROVA");
      const perRiquadro = await get(`hubs?feedId=${FEED}&bbox=44.99,8.99,45.01,9.01`);
      expect(perRiquadro.status, JSON.stringify(perRiquadro.body)).toBe(200);
      expect((perRiquadro.body as any[]).map(h => h.name)).toEqual(["STAZIONE FS PROVA"]);
    });

    it("analyze: fermate vicine e passaggi del giorno scelto (feriale, poi sabato)", async () => {
      const r = await get(`analyze?feedId=${FEED}&municipality=${COMUNE}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.scope).toMatchObject({ source: "gtfs", feedId: FEED, day: "feriale", tripsBeforeCalendar: 1 });
      const stazione = hubDi(r.body, "STAZIONE FS PROVA");
      expect(stazione.isServed).toBe(true);
      expect((stazione.nearbyStops as any[]).map(s => s.stopId)).toEqual(["S-STAZ", "S-VIC"]);
      expect(orari(stazione)).toEqual([{ linea: "7", orari: ["08:00:00", "08:05:00"] }]);

      const sabato = await get(`analyze?feedId=${FEED}&municipality=${COMUNE}&day=sabato&routeIds=R1`);
      expect(sabato.status, JSON.stringify(sabato.body)).toBe(200);
      expect(orari(hubDi(sabato.body, "STAZIONE FS PROVA"))).toEqual([{ linea: "7", orari: ["09:00:00"] }]);
    });

    it("pois: i poli di lavoro attorno alla stazione", async () => {
      const r = await get(`pois?feedId=${FEED}&municipality=${COMUNE}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const stazione = (r.body.hubPois as any[]).find(h => h.hubName === "STAZIONE FS PROVA");
      expect((stazione.pois as any[]).map(p => p.name)).toEqual(["Uffici di prova"]);
      expect(r.body.summary.hubCount).toBe(2);
    });
  });

  describe("dentro un progetto di Planning Studio", () => {
    it("hubs: location_type = 1 fa una stazione anche se il nome non lo dice", async () => {
      const r = await get(`hubs?psProjectId=${PROG}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((r.body as any[]).map(h => ({ name: h.name, type: h.type })))
        .toEqual([{ name: "Piazza Rosselli", type: "railway" }]);
    });

    it("analyze: le corse del giorno, di una validità, di un giorno-tipo e di una data", async () => {
      const feriale = [{ linea: "12", orari: ["07:00:00", "07:03:00"] }];
      const sabato = [{ linea: "12", orari: ["10:00:00"] }];
      const casi: Array<[string, typeof feriale]> = [
        ["", feriale],
        ["&day=sabato", sabato],
        [`&calendarId=${P_CAL_SABATO}`, sabato],
        [`&categoryId=${P_GIORNO_TIPO}`, feriale],
        ["&categoryId=date:2026-11-11", feriale], // un mercoledì
        ["&categoryId=date:2026-11-14", sabato],
      ];
      for (const [parametri, attesi] of casi) {
        const r = await get(`analyze?psProjectId=${PROG}${parametri}`);
        expect(r.status, `${parametri} ${JSON.stringify(r.body)}`).toBe(200);
        expect(r.body.scope).toMatchObject({ source: "ps", psProjectId: PROG });
        const stazione = hubDi(r.body, "Piazza Rosselli");
        expect((stazione.nearbyStops as any[]).map(s => s.stopId), parametri).toEqual([P_STAZIONE, P_VICINA]);
        expect(orari(stazione), parametri).toEqual(attesi);
      }
    });

    it("pois: confinati all'area del progetto", async () => {
      const r = await get(`pois?psProjectId=${PROG}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((r.body.hubPois as any[]).map(h => ({ hub: h.hubName, poli: (h.pois as any[]).map(p => p.name) })))
        .toEqual([{ hub: "Piazza Rosselli", poli: ["Uffici del progetto"] }]);
    });
  });

  it("nessuna query rifiutata da Postgres, nemmeno fra quelle il cui errore viene inghiottito", () => {
    expect(rifiutate).toEqual([]);
  });
});
