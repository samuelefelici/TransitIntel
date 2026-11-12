/**
 * Cancellare una categoria di validità, su un database vero (TEST_DATABASE_URL,
 * migrato; in CI come cerbero_app).
 *
 * ps_trip_category_validity non ha la chiave esterna sulla categoria: prima,
 * cancellando una categoria in uso, sulle corse restava una riga che punta a
 * una categoria che non c'è più, e quelle corse non valevano più in nessun
 * giorno. Ora una categoria usata da corse o da unità di progettazione non si
 * cancella, e la risposta dice da quante. Una categoria libera sì, con il suo
 * calendario.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router, { messaggioCategoriaInUso } from "../lib/planning-studio-validity-categories";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e1500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [UTENTE, P1, P2, L1, L2, V1, V2, C1, C2, C3, CAT_CORSE, CAT_UNITA, CAT_LIBERA] = Array.from({ length: 13 }, (_, i) => u(i + 1));

const app = appDiProva(router, utenteDiProva(UTENTE));
const cancella = (id: string) => request(app).delete(`/api/planning-studio/validity-categories/${id}`);
const esiste = async (id: string) =>
  Number((await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_validity_categories WHERE id = ${id}::uuid`)).rows[0].n) === 1;

async function pulisci() {
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id IN (${P1}::uuid, ${P2}::uuid)`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id IN (${P1}::uuid, ${P2}::uuid)`);
  await db.execute(sql`DELETE FROM ps_validity_categories WHERE id IN (${CAT_CORSE}::uuid, ${CAT_UNITA}::uuid, ${CAT_LIBERA}::uuid)`);
}

describe("messaggioCategoriaInUso", () => {
  it("dice da quante corse, in quanti progetti, e da quante unità", () => {
    expect(messaggioCategoriaInUso({ corse: 1, progetti: 1, unita: 0 })).toMatch(/^La categoria è usata da 1 corsa: toglila/);
    expect(messaggioCategoriaInUso({ corse: 12, progetti: 2, unita: 0 })).toMatch(/usata da 12 corse in 2 progetti: toglila/);
    expect(messaggioCategoriaInUso({ corse: 0, progetti: 0, unita: 3 })).toMatch(/usata da 3 unità di progettazione: toglila/);
    expect(messaggioCategoriaInUso({ corse: 5, progetti: 1, unita: 1 })).toMatch(/usata da 5 corse e da 1 unità di progettazione: toglila/);
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("cancellare una categoria di validità (database vero)", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`
      INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P1}::uuid, ${UTENTE}::uuid, 'Categorie 1'), (${P2}::uuid, ${UTENTE}::uuid, 'Categorie 2')`);
    await db.execute(sql`
      INSERT INTO ps_routes (id, project_id, short_name) VALUES (${L1}::uuid, ${P1}::uuid, 'C1'), (${L2}::uuid, ${P2}::uuid, 'C2')`);
    await db.execute(sql`
      INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${V1}::uuid, ${P1}::uuid, ${L1}::uuid, 'a'), (${V2}::uuid, ${P2}::uuid, ${L2}::uuid, 'a')`);
    await db.execute(sql`
      INSERT INTO ps_trips (id, project_id, route_id, variant_id) VALUES
        (${C1}::uuid, ${P1}::uuid, ${L1}::uuid, ${V1}::uuid), (${C2}::uuid, ${P1}::uuid, ${L1}::uuid, ${V1}::uuid),
        (${C3}::uuid, ${P2}::uuid, ${L2}::uuid, ${V2}::uuid)`);
    await db.execute(sql`
      INSERT INTO ps_validity_categories (id, code, name, color) VALUES
        (${CAT_CORSE}::uuid, 'prova_215b_corse', 'Usata dalle corse', '#111111'),
        (${CAT_UNITA}::uuid, 'prova_215b_unita', 'Usata da una unità', '#222222'),
        (${CAT_LIBERA}::uuid, 'prova_215b_libera', 'Non usata', '#333333')`);
    await db.execute(sql`
      INSERT INTO ps_trip_category_validity (trip_id, category_id) VALUES
        (${C1}::uuid, ${CAT_CORSE}::uuid), (${C2}::uuid, ${CAT_CORSE}::uuid), (${C3}::uuid, ${CAT_CORSE}::uuid)`);
    await db.execute(sql`
      INSERT INTO ps_validity_units (project_id, validity_id, name, category_id) VALUES (${P1}::uuid, 'prova-215b', 'Unità di prova', ${CAT_UNITA}::uuid)`);
    await db.execute(sql`
      INSERT INTO ps_validity_category_calendar (project_id, date, category_id) VALUES (${P1}::uuid, '2031-01-07', ${CAT_LIBERA}::uuid)`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("usata da corse: rifiutata, coi numeri e senza i nomi dei progetti", async () => {
    const r = await cancella(CAT_CORSE);
    expect(r.status).toBe(409);
    expect(r.body.inUso).toEqual({ corse: 3, progetti: 2, unita: 0 });
    expect(r.body.error).toMatch(/usata da 3 corse in 2 progetti/);
    expect(JSON.stringify(r.body)).not.toMatch(/Categorie 1|Categorie 2/);
    expect(await esiste(CAT_CORSE)).toBe(true);
    // e le corse hanno ancora la loro categoria: nessuna riga che punta nel vuoto
    const orfane = await db.execute<any>(sql`
      SELECT count(*)::int AS n FROM ps_trip_category_validity v
       WHERE v.trip_id IN (${C1}::uuid, ${C2}::uuid, ${C3}::uuid)
         AND NOT EXISTS (SELECT 1 FROM ps_validity_categories c WHERE c.id = v.category_id)`);
    expect(orfane.rows[0].n).toBe(0);
  });

  it("usata da un'unità di progettazione: rifiutata, e l'unità tiene la sua categoria", async () => {
    const r = await cancella(CAT_UNITA);
    expect(r.status).toBe(409);
    expect(r.body.inUso).toEqual({ corse: 0, progetti: 0, unita: 1 });
    const unita = await db.execute<any>(sql`SELECT category_id FROM ps_validity_units WHERE validity_id = 'prova-215b'`);
    expect(unita.rows[0].category_id).toBe(CAT_UNITA);
  });

  it("libera: si cancella, e il suo calendario con lei", async () => {
    const r = await cancella(CAT_LIBERA);
    expect(r.status).toBe(200);
    expect(await esiste(CAT_LIBERA)).toBe(false);
    const giorni = await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_validity_category_calendar WHERE category_id = ${CAT_LIBERA}::uuid`);
    expect(giorni.rows[0].n).toBe(0);
    // già cancellata (un doppio clic): non è un errore
    expect((await cancella(CAT_LIBERA)).status).toBe(200);
  });

  it("tolta dalle corse, si cancella", async () => {
    await db.execute(sql`DELETE FROM ps_trip_category_validity WHERE category_id = ${CAT_CORSE}::uuid`);
    expect((await cancella(CAT_CORSE)).status).toBe(200);
    expect(await esiste(CAT_CORSE)).toBe(false);
  });

  it("un id che non è un id: 400, senza arrivare al database", async () => {
    expect((await cancella("non-un-id")).status).toBe(400);
  });
});
