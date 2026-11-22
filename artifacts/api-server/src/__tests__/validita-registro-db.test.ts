/**
 * La validità delle corse e il registro delle modifiche (tappa 7.18), sul
 * database (TEST_DATABASE_URL; in CI come cerbero_app, col registro acceso).
 *
 * - L'import dai calendari scrive la matrice corsa × giorno-tipo e le date a
 *   insiemi, in una transazione: nel registro è di chi l'ha lanciato.
 * - Il ricalcolo delle categorie che parte dalla lista delle corse (una
 *   lettura) è del sistema: nessun attore, via «sistema:categorie», la stessa
 *   richiesta che l'ha avviato.
 *
 * Se il registro è spento (in locale, di solito) le verifiche sul registro si
 * saltano; quelle sui dati no.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { contestoDb } from "@workspace/db/contesto";
import { sql } from "drizzle-orm";
import { runValidityAutoImportFromCalendars, ensureCategoriesFresh } from "../lib/planning-studio-validity";
import { leggiRegistro, statoRegistro, Parametri } from "../lib/registro-modifiche";

const u = (n: number) => `e7d00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [UTENTE, P, LINEA, VARIANTE, CAL, T1, T2, T3] = Array.from({ length: 8 }, (_, i) => u(i + 1));
const CORSE = [T1, T2, T3];
/* l'anno in corso: il ricalcolo delle categorie classifica le date a partire da lì */
const ANNO = new Date().getUTCFullYear();
const [INIZIO, FINE, IN_MENO] = [`${ANNO}-03-01`, `${ANNO}-03-31`, `${ANNO}-03-06`];

async function pulisci() {
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
}

async function righeDelRegistro(corsa: string, tabella: string, richiesta: string) {
  const pagina = await leggiRegistro(Parametri.parse({ ambitoTipo: "corsa", ambitoId: corsa, tabella }));
  if ("errore" in pagina) throw new Error(pagina.errore);
  return pagina.righe.filter((r) => r.richiesta === richiesta);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("la validità delle corse e il registro, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await contestoDb.run({ attore: UTENTE, via: "api", richiesta: "r-prepara-7-18" }, async () => {
      await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${UTENTE}::uuid, 'validita@prova.local', 'x', 'admin')`);
      await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${UTENTE}::uuid, 'Validità 7.18')`);
      await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${P}::uuid, '1')`);
      await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${VARIANTE}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Andata')`);
      /* un calendario di tutti i giorni, marzo, con una data in meno */
      await db.execute(sql`INSERT INTO ps_calendars (id, project_id, code, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
                           VALUES (${CAL}::uuid, ${P}::uuid, 'TUTTI', true, true, true, true, true, true, true, ${INIZIO}::date, ${FINE}::date)`);
      await db.execute(sql`INSERT INTO ps_calendar_dates (calendar_id, date, exception_type) VALUES (${CAL}::uuid, ${IN_MENO}::date, 2)`);
      for (const t of CORSE) {
        await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id) VALUES (${t}::uuid, ${P}::uuid, ${LINEA}::uuid, ${VARIANTE}::uuid, ${CAL}::uuid)`);
      }
    });
  });
  afterAll(pulisci);

  it("l'import dai calendari scrive la matrice e le date, a insiemi, di chi l'ha lanciato", async () => {
    const esito = await contestoDb.run({ attore: UTENTE, via: "api", richiesta: "r-import-7-18" },
      () => runValidityAutoImportFromCalendars(P));
    /* tre corse × tre giorni-tipo (feriale, sabato, festivo); una data per corsa */
    expect(esito.summary.validityUpserts).toBe(9);
    expect(esito.summary.exceptionInserts).toBe(3);
    const matrice = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ps_trip_day_validity WHERE trip_id IN (${T1}::uuid, ${T2}::uuid, ${T3}::uuid) AND is_valid`);
    expect(matrice.rows[0].n).toBe(9);
    const date = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ps_trip_exceptions WHERE trip_id IN (${T1}::uuid, ${T2}::uuid, ${T3}::uuid) AND date = ${IN_MENO}::date AND exception_type = 2`);
    expect(date.rows[0].n).toBe(3);

    if (!(await statoRegistro()).attivo) return;
    const righe = await righeDelRegistro(T1, "public.ps_trip_day_validity", "r-import-7-18");
    expect(righe.length).toBeGreaterThan(0);
    expect(righe.every((r) => r.attore?.id === UTENTE && r.via === "api")).toBe(true);
  });

  it("il ricalcolo che parte dalla lista delle corse è del sistema, con la richiesta che l'ha avviato", async () => {
    /* una corsa cambiata dopo l'ultimo ricalcolo: la lista delle corse la ricalcola */
    await db.execute(sql`UPDATE ps_calendar_profiles SET categories_synced_at = now() - interval '1 hour' WHERE project_id = ${P}::uuid`);
    await contestoDb.run({ attore: UTENTE, via: "api", richiesta: "r-modifica-7-18" },
      () => db.execute(sql`UPDATE ps_trips SET updated_at = now() WHERE id = ${T1}::uuid`));
    await contestoDb.run({ attore: UTENTE, via: "api", richiesta: "r-lista-7-18" }, () => ensureCategoriesFresh(P));

    const categorie = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ps_trip_category_validity WHERE trip_id = ${T1}::uuid`);
    expect(categorie.rows[0].n).toBeGreaterThan(0);

    if (!(await statoRegistro()).attivo) return;
    const righe = await righeDelRegistro(T1, "public.ps_trip_category_validity", "r-lista-7-18");
    expect(righe.length).toBeGreaterThan(0);
    expect(righe.every((r) => r.attore === null && r.via === "sistema:categorie")).toBe(true);
  });
});
