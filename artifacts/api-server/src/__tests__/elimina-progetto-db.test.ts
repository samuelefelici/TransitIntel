/**
 * La cancellazione di un progetto di Planning Studio su un database vero
 * (TEST_DATABASE_URL, migrato; in CI come cerbero_app).
 *
 * L'handler cercava nel catalogo le tabelle con una chiave verso ps_projects e
 * le svuotava con SQL scritto come testo, riprovando dopo un errore dentro la
 * stessa transazione (che in Postgres, dopo un errore, è annullata). Ora
 * l'ordine è fisso e scritto nel codice. Qui un progetto con una riga in OGNI
 * tabella di Planning Studio che ne porta i dati: dopo la cancellazione non ne
 * resta nessuna, il progetto accanto e i dati globali non si toccano, e una
 * chiave esterna che blocca dà un 409 che dice quale tabella, senza cancellare
 * niente.
 *
 * Orari e fermate dei percorsi puntano alle fermate con ON DELETE RESTRICT, e
 * la cascata dal progetto controlla quel vincolo in un momento che dipende
 * dall'ordine in cui sono nati i vincoli: su un database creato dalle
 * migrazioni quell'ordine è in parte favorevole per caso, in produzione è
 * quello della sua storia. L'ultima prova (da migratore, con
 * TEST_DATABASE_MIGRATOR_URL, in una transazione annullata) fa rinascere i
 * vincoli nell'ordine sfavorevole: la sola cascata si ferma, l'ordine fisso no.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool, PoolConContesto } from "@workspace/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import router, { cancellaProgetto } from "../lib/planning-studio";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const UTENTE = "e1000000-0000-4000-8000-000000000001";
const COLLEGA = "e1000000-0000-4000-8000-000000000002";
const ESTRANEO = "e1000000-0000-4000-8000-000000000003";
const TG_GLOBALE = "e1000000-0000-4000-8000-000000000010";
const CAT = "e1000000-0000-4000-8000-000000000011";
/** L'id n-esimo del progetto k: i progetti di prova non condividono nessun id. */
const u = (k: number, n: number) => `e1000000-0000-4000-8000-${String(k).padStart(4, "0")}${String(n).padStart(8, "0")}`;

/* Le tabelle di Planning Studio con i dati di UN progetto: il seme qui sotto ne
 * riempie ognuna. Le altre ps_* sono di tutti (cache dei percorsi su strada,
 * categorie di validità). Una tabella ps_* nuova va in uno dei due elenchi: se
 * è di un progetto, va anche nel seme, e la cancellazione la deve svuotare. */
const DEL_PROGETTO = [
  "ps_activation_log", "ps_argos_messages", "ps_argos_watches", "ps_calendar_dates", "ps_calendar_profiles",
  "ps_calendars", "ps_day_calendar", "ps_day_types", "ps_network_shares", "ps_no_go_zones",
  "ps_pending_activations", "ps_project_activity_log", "ps_project_members", "ps_projects", "ps_route_variants",
  "ps_routes", "ps_service_periods", "ps_shapes", "ps_stop_clusters", "ps_stop_times", "ps_stops",
  "ps_timetable_map_shares", "ps_trip_category_validity", "ps_trip_day_validity", "ps_trip_exceptions", "ps_trips",
  "ps_validity_category_calendar", "ps_validity_units", "ps_variant_stops",
];
const DI_TUTTI = ["ps_route_snap_cache", "ps_route_snap_multi_cache", "ps_validity_categories"];

const ids = (k: number) => ({
  p: u(k, 1), nodo: u(k, 10), f1: u(k, 11), f2: u(k, 12), linea: u(k, 20), percorso: u(k, 21),
  cal: u(k, 30), tg: u(k, 31), c1: u(k, 40), c2: u(k, 41), feed: u(k, 50),
});

/** Chi esegue l'SQL: l'app (db) o, nell'ultima prova, il migratore dentro la sua transazione. */
type Esecutore = { execute: (q: any) => Promise<any> };

/** Un progetto con una riga in ogni tabella di DEL_PROGETTO. */
async function semina(k: number, nome: string, ex: Esecutore = db): Promise<ReturnType<typeof ids>> {
  const i = ids(k);
  await ex.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${i.p}::uuid, ${UTENTE}::uuid, ${nome})`);
  await ex.execute(sql`INSERT INTO ps_project_members (project_id, user_id, role, added_by) VALUES (${i.p}::uuid, ${COLLEGA}::uuid, 'editor', ${UTENTE}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_project_activity_log (project_id, user_id, action) VALUES (${i.p}::uuid, ${UTENTE}::uuid, 'ps.project.create')`);
  await ex.execute(sql`INSERT INTO ps_stop_clusters (id, project_id, code, name, kind) VALUES (${i.nodo}::uuid, ${i.p}::uuid, 'N1', 'Stazione', 'interchange')`);
  // F1 sta in un nodo; F2 ha F1 come stazione madre
  await ex.execute(sql`INSERT INTO ps_stops (id, project_id, code, name, lat, lon, cluster_id, parent_station) VALUES
                       (${i.f1}::uuid, ${i.p}::uuid, 'F1', 'Stazione', 43.61, 13.51, ${i.nodo}::uuid, NULL),
                       (${i.f2}::uuid, ${i.p}::uuid, 'F2', 'Via Roma', 43.62, 13.52, NULL, ${i.f1}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${i.linea}::uuid, ${i.p}::uuid, '1')`);
  await ex.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${i.percorso}::uuid, ${i.p}::uuid, ${i.linea}::uuid, 'Andata')`);
  await ex.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES (${i.percorso}::uuid, 1, ${i.f1}::uuid), (${i.percorso}::uuid, 2, ${i.f2}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_shapes (project_id, variant_id, geometry) VALUES (${i.p}::uuid, ${i.percorso}::uuid, '[[13.51,43.61],[13.52,43.62]]')`);
  await ex.execute(sql`INSERT INTO ps_calendars (id, project_id, code, start_date, end_date) VALUES (${i.cal}::uuid, ${i.p}::uuid, 'FER', '2026-09-15', '2027-06-10')`);
  await ex.execute(sql`INSERT INTO ps_calendar_dates (calendar_id, date) VALUES (${i.cal}::uuid, '2026-12-08')`);
  await ex.execute(sql`INSERT INTO ps_day_types (id, project_id, code, name, color) VALUES (${i.tg}::uuid, ${i.p}::uuid, 'MERC', 'Mercato', '#aa5500')`);
  // C1 ha un calendario, C2 no
  await ex.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id, short_name) VALUES
                       (${i.c1}::uuid, ${i.p}::uuid, ${i.linea}::uuid, ${i.percorso}::uuid, ${i.cal}::uuid, 'C1'),
                       (${i.c2}::uuid, ${i.p}::uuid, ${i.linea}::uuid, ${i.percorso}::uuid, NULL, 'C2')`);
  await ex.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
                       (${i.c1}::uuid, 1, ${i.f1}::uuid, '07:00:00', '07:00:00'), (${i.c1}::uuid, 2, ${i.f2}::uuid, '07:10:00', '07:10:00'),
                       (${i.c2}::uuid, 1, ${i.f1}::uuid, '08:00:00', '08:00:00'), (${i.c2}::uuid, 2, ${i.f2}::uuid, '08:10:00', '08:10:00')`);
  await ex.execute(sql`INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid) VALUES
                       (${i.c1}::uuid, ${i.tg}::uuid, true), (${i.c2}::uuid, ${TG_GLOBALE}::uuid, true)`);
  await ex.execute(sql`INSERT INTO ps_trip_category_validity (trip_id, category_id) VALUES (${i.c1}::uuid, ${CAT}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_trip_exceptions (trip_id, date) VALUES (${i.c2}::uuid, '2026-12-24')`);
  await ex.execute(sql`INSERT INTO ps_no_go_zones (project_id, name, polygon, active) VALUES (${i.p}::uuid, 'Centro', '[[13.5,43.6],[13.6,43.6],[13.5,43.7]]', true)`);
  await ex.execute(sql`INSERT INTO ps_service_periods (project_id, code, name, start_date, end_date, is_default) VALUES (${i.p}::uuid, 'INV', 'Invernale', '2026-09-15', '2027-06-10', true)`);
  await ex.execute(sql`INSERT INTO ps_calendar_profiles (project_id, extra_holidays) VALUES (${i.p}::uuid, '["2027-05-04"]')`);
  // i giorni del calendario puntano ai tipi di giorno senza cascata: uno del progetto, uno globale
  await ex.execute(sql`INSERT INTO ps_day_calendar (project_id, date, day_type_id, source) VALUES
                       (${i.p}::uuid, '2026-12-01', ${i.tg}::uuid, 'manuale'), (${i.p}::uuid, '2026-12-02', ${TG_GLOBALE}::uuid, 'manuale')`);
  await ex.execute(sql`INSERT INTO ps_validity_category_calendar (project_id, date, category_id) VALUES (${i.p}::uuid, '2026-12-03', ${CAT}::uuid)`);
  // un'unità di progettazione sul tipo di giorno del progetto, con le sue corse
  await ex.execute(sql`INSERT INTO ps_validity_units (project_id, validity_id, name, day_type_id, category_id, trip_ids, trip_count)
                       VALUES (${i.p}::uuid, 'MERC', 'Mercato', ${i.tg}::uuid, ${CAT}::uuid, ${JSON.stringify([i.c1])}::jsonb, 1)`);
  await ex.execute(sql`INSERT INTO ps_pending_activations (project_id, feed_id, effective_from, user_id) VALUES (${i.p}::uuid, ${i.feed}::uuid, '2027-01-01', ${UTENTE}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_activation_log (project_id, feed_id, user_id) VALUES (${i.p}::uuid, ${i.feed}::uuid, ${UTENTE}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_argos_messages (project_id, user_id, role, content) VALUES (${i.p}::uuid, ${UTENTE}::uuid, 'user', 'quante corse ha la linea 1?')`);
  // le tre senza chiave verso ps_projects: la cascata non le vede
  await ex.execute(sql`INSERT INTO ps_argos_watches (project_id, user_id) VALUES (${i.p}::uuid, ${UTENTE}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_network_shares (token, project_id, created_by) VALUES (${`ci-elimina-${k}-rete`}, ${i.p}::uuid, ${UTENTE}::uuid)`);
  await ex.execute(sql`INSERT INTO ps_timetable_map_shares (token, project_id, created_by) VALUES (${`ci-elimina-${k}-orari`}, ${i.p}::uuid, ${UTENTE}::uuid)`);
  return i;
}

/** In quali tabelle dell'app c'è ancora una riga con uno di questi id, in una
 *  colonna uuid qualunque: «tabella.colonna» → quante righe. Vuoto = nessuna. */
async function doveRestano(cercati: string[], ex: Esecutore = db): Promise<Record<string, number>> {
  const colonne = (await ex.execute(sql`
    SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c
      FROM information_schema.columns c
      JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
     WHERE c.table_schema IN ('public', 'caronte', 'coda') AND x.table_type = 'BASE TABLE' AND c.data_type = 'uuid'
     ORDER BY 1, 2, 3`)).rows;
  // la scansione guarda davvero tutto lo schema, non due tabelle
  expect(colonne.length).toBeGreaterThan(100);
  const conte = colonne.map((k: any) => sql`
    SELECT ${`${k.t}.${k.c}`}::text AS dove, count(*)::int AS n
      FROM ${sql.identifier(k.s)}.${sql.identifier(k.t)} WHERE ${sql.identifier(k.c)} IN (SELECT id FROM cercati)`);
  const r = await ex.execute(sql`
    WITH cercati AS (SELECT unnest(${`{${cercati.join(",")}}`}::uuid[]) AS id)
    SELECT dove, n FROM (${sql.join(conte, sql` UNION ALL `)}) q WHERE n > 0 ORDER BY dove`);
  return Object.fromEntries(r.rows.map((x: any) => [x.dove, x.n]));
}
const tabelle = (dove: Record<string, number>) => [...new Set(Object.keys(dove).map((k) => k.split(".")[0]!))].sort();

describe.runIf(!!process.env.TEST_DATABASE_URL)("cancellazione di un progetto di Planning Studio, sul database", () => {
  const app = appDiProva(router, utenteDiProva(UTENTE));
  const pulisci = async () => {
    const miei = sql`(SELECT id FROM ps_projects WHERE owner_user_id = ${UTENTE}::uuid)`;
    // prima corse e percorsi: orari e fermate dei percorsi puntano alle fermate senza cascata
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id IN ${miei}`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id IN ${miei}`);
    // le tre senza chiave verso ps_projects: per id, perché restano anche se il progetto non c'è più
    for (const t of ["ps_argos_watches", "ps_network_shares", "ps_timetable_map_shares"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE project_id::text LIKE 'e1000000-0000-4000-8000-%'`);
    }
    await db.execute(sql`DELETE FROM ps_projects WHERE owner_user_id = ${UTENTE}::uuid`);
    await db.execute(sql`DELETE FROM ps_day_types WHERE id = ${TG_GLOBALE}::uuid`);
    await db.execute(sql`DELETE FROM ps_validity_categories WHERE id = ${CAT}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO ps_day_types (id, project_id, code, name, color) VALUES (${TG_GLOBALE}::uuid, NULL, 'CI_ELIMINA', 'Globale di prova', '#000000')`);
    await db.execute(sql`INSERT INTO ps_validity_categories (id, code, name, color) VALUES (${CAT}::uuid, 'CI_ELIMINA', 'Categoria di prova', '#111111')`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("ogni tabella ps_* del database è di un progetto o di tutti: nessuna resta fuori dalla prova", async () => {
    const nelDatabase = (await db.execute<any>(sql`
      SELECT c.relname AS t FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'ps\_%' ORDER BY 1`)).rows.map((r: any) => r.t);
    expect(nelDatabase).toEqual([...DEL_PROGETTO, ...DI_TUTTI].sort());
  });

  it("un progetto con corse, orari, percorsi, zone vietate, membri e unità: 200, e non ne resta una riga", async () => {
    const i = await semina(1, "Da cancellare");
    const accanto = await semina(2, "Resta");
    const suoi = Object.values(i);
    // prima: il seme ha messo righe in tutte le tabelle di un progetto
    expect(tabelle(await doveRestano(suoi))).toEqual(DEL_PROGETTO);
    const accantoPrima = await doveRestano(Object.values(accanto));

    const r = await request(app).delete(`/api/planning-studio/projects/${i.p}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true });

    expect(await doveRestano(suoi)).toEqual({});
    // le condivisioni pubbliche si cercano per token: sparite anche quelle
    const link = (await db.execute<any>(sql`
      SELECT (SELECT count(*)::int FROM ps_network_shares WHERE token = 'ci-elimina-1-rete') AS rete,
             (SELECT count(*)::int FROM ps_timetable_map_shares WHERE token = 'ci-elimina-1-orari') AS orari`)).rows[0];
    expect(link).toEqual({ rete: 0, orari: 0 });
    // il progetto accanto è com'era, riga per riga; i dati di tutti restano
    expect(await doveRestano(Object.values(accanto))).toEqual(accantoPrima);
    const globali = (await db.execute<any>(sql`
      SELECT (SELECT count(*)::int FROM ps_day_types WHERE id = ${TG_GLOBALE}::uuid) AS tipo_giorno,
             (SELECT count(*)::int FROM ps_validity_categories WHERE id = ${CAT}::uuid) AS categoria`)).rows[0];
    expect(globali).toEqual({ tipo_giorno: 1, categoria: 1 });
    // cancellato davvero: la seconda volta non c'è più
    expect((await request(app).delete(`/api/planning-studio/projects/${i.p}`)).status).toBe(404);
  });

  it("una chiave esterna che blocca: 409 che dice quale tabella, e del progetto non si cancella niente", async () => {
    const i = await semina(3, "Bloccato");
    const altro = ids(2);
    // una corsa del progetto accanto ferma a una fermata di questo: ps_stop_times.stop_id è ON DELETE RESTRICT
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
                         VALUES (${altro.c1}::uuid, 3, ${i.f2}::uuid, '07:20:00', '07:20:00')`);
    const prima = await doveRestano(Object.values(i));

    const r = await request(app).delete(`/api/planning-studio/projects/${i.p}`);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toContain('dati collegati in "ps_stop_times"');
    expect(r.body.error).toContain("ps_stop_times_stop_id_fkey");
    // le corse e i percorsi si cancellano PRIMA del progetto: l'errore arriva dopo, e annulla anche quelli
    expect(await doveRestano(Object.values(i))).toEqual(prima);

    // tolta la riga che blocca, si cancella
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${altro.c1}::uuid AND stop_id = ${i.f2}::uuid`);
    const dopo = await request(app).delete(`/api/planning-studio/projects/${i.p}`);
    expect(dopo.status, JSON.stringify(dopo.body)).toBe(200);
    expect(await doveRestano(Object.values(i))).toEqual({});
  });

  it("chi non vede il progetto: 404, e non sparisce niente", async () => {
    const accanto = ids(2);
    const prima = await doveRestano(Object.values(accanto));
    const estraneo = appDiProva(router, utenteDiProva(ESTRANEO));
    expect((await request(estraneo).delete(`/api/planning-studio/projects/${accanto.p}`)).status).toBe(404);
    expect(await doveRestano(Object.values(accanto))).toEqual(prima);
  });

  it.runIf(!!process.env.TEST_DATABASE_MIGRATOR_URL)("l'ordine non dipende da come sono nati i vincoli: nell'ordine sfavorevole la sola cascata si ferma, cancellaProgetto no", async () => {
    const migratore = new PoolConContesto({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 1 });
    const c = await migratore.connect();
    const ex = drizzle(c);
    try {
      await c.query("BEGIN");
      // Da migratore, in una transazione annullata (l'app non può, e lo schema
      // non cambia): la chiave verso il progetto di queste quattro rinasce, in
      // quest'ordine. La cascata ora toglie fermate e tipi di giorno PRIMA di
      // linee, percorsi, corse e giorni del calendario: i vincoli sulle fermate
      // si controllano con orari e fermate dei percorsi ancora lì. Quello sui
      // tipi di giorno no (cancellaProgetto non ha un passo per lui): giorni e
      // tipi sono figli diretti del progetto, e il controllo viene dopo.
      for (const t of ["ps_routes", "ps_route_variants", "ps_trips", "ps_day_calendar"]) {
        await c.query(`ALTER TABLE public.${t} DROP CONSTRAINT ${t}_project_id_fkey`);
        await c.query(`ALTER TABLE public.${t} ADD CONSTRAINT ${t}_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.ps_projects(id) ON DELETE CASCADE`);
      }
      const i = await semina(4, "Ordine sfavorevole", ex);
      expect(tabelle(await doveRestano(Object.values(i), ex))).toEqual(DEL_PROGETTO);
      // la sola DELETE del progetto: la ferma una delle due chiavi verso le fermate
      await c.query("SAVEPOINT sola_cascata");
      await expect(c.query("DELETE FROM public.ps_projects WHERE id = $1", [i.p])).rejects.toMatchObject({
        code: "23503", constraint: expect.stringMatching(/^ps_(stop_times|variant_stops)_stop_id_fkey$/),
      });
      await c.query("ROLLBACK TO SAVEPOINT sola_cascata");

      await cancellaProgetto(ex, i.p);
      expect(await doveRestano(Object.values(i), ex)).toEqual({});
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
      await migratore.end();
    }
  });
});
