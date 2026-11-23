/**
 * I punti di riposo dei turni guida (tappa 7.22), sul database
 * (TEST_DATABASE_URL; in CI come cerbero_app): le rotte dell'amministratore,
 * le fermate che il feed in esercizio non conosce, e i punti nel formato del
 * calcolo, prima dei nodi di sosta del progetto.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { loadRestPointsForScenario } from "../lib/dati-solver";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e7a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, UTENTE, FEED] = [u(1), u(2), u(3)];
const PREFISSO = "Riposo 7.22";
const admin = request(appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin")));
const utente = request(appDiProva(adminRouter, utenteDiProva(UTENTE, ["scheduling"], "user")));

async function pulisci() {
  await db.execute(sql`DELETE FROM punti_riposo WHERE nome LIKE ${`${PREFISSO}%`}`);
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${FEED}::uuid`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("i punti di riposo dei turni guida, sul database", () => {
  let id = "";

  beforeAll(async () => {
    await pulisci();
    /* il feed in esercizio più recente di tutti: è quello con cui si controllano le fermate */
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active, uploaded_at) VALUES (${FEED}::uuid, 'riposo-7-22.zip', true, '2099-02-01T00:00:00Z')`);
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${FEED}::uuid, 'R1', 'Capolinea Monte', 40 + 1 / 1000.0, 10 + 1 / 1000.0)`);
  });
  afterAll(pulisci);

  it("solo l'amministratore", async () => {
    expect((await utente.get("/api/admin/punti-riposo")).status).toBe(403);
    expect((await utente.post("/api/admin/punti-riposo").send({ nome: `${PREFISSO} x`, fermate: ["A"] })).status).toBe(403);
  });

  it("si crea un punto: le fermate senza doppioni, e quelle che il feed non conosce si vedono", async () => {
    const r = await admin.post("/api/admin/punti-riposo")
      .send({ nome: `  ${PREFISSO} Monte  `, conServizi: false, fermate: ["Capolinea Monte", "capolinea monte ", "Capolinea Montte"], nota: "piazzale" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.punto).toMatchObject({ nome: `${PREFISSO} Monte`, conServizi: false, fermate: ["Capolinea Monte", "Capolinea Montte"], nota: "piazzale" });
    id = r.body.punto.id;

    const elenco = await admin.get("/api/admin/punti-riposo");
    expect(elenco.status).toBe(200);
    expect(elenco.body.feed).toBe(FEED);
    const mio = elenco.body.punti.find((p: any) => p.id === id);
    expect(mio.fermateNonTrovate).toEqual(["Capolinea Montte"]);
  });

  it("un nome già usato, valori sbagliati, un id che non c'è", async () => {
    expect((await admin.post("/api/admin/punti-riposo").send({ nome: `${PREFISSO} Monte`, fermate: ["A"] })).status).toBe(409);
    expect((await admin.post("/api/admin/punti-riposo").send({ nome: "", fermate: [] })).status).toBe(400);
    expect((await admin.post("/api/admin/punti-riposo").send({ nome: `${PREFISSO} y`, fermate: ["A"], altro: 1 })).status).toBe(400);
    expect((await admin.put(`/api/admin/punti-riposo/${u(99)}`).send({ nome: `${PREFISSO} z`, fermate: ["A"] })).status).toBe(404);
    expect((await admin.delete("/api/admin/punti-riposo/non-un-id")).status).toBe(404);
  });

  it("si cambia, e il calcolo dei turni guida lo riceve prima dei nodi di sosta del progetto", async () => {
    const r = await admin.put(`/api/admin/punti-riposo/${id}`)
      .send({ nome: `${PREFISSO} Monte`, conServizi: true, fermate: ["Capolinea Monte"], nota: "" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.punto).toMatchObject({ conServizi: true, fermate: ["Capolinea Monte"] });

    /* senza progetto collegato, i punti dell'azienda valgono lo stesso */
    const perIlCalcolo = await loadRestPointsForScenario(null);
    expect(perIlCalcolo.find((p) => p.id === id)).toEqual({
      id, name: `${PREFISSO} Monte`, hasFacilities: true, stopIds: [], stopNames: ["Capolinea Monte"],
    });
  });

  it("si toglie", async () => {
    expect((await admin.delete(`/api/admin/punti-riposo/${id}`)).status).toBe(200);
    expect((await admin.delete(`/api/admin/punti-riposo/${id}`)).status).toBe(404);
    expect((await loadRestPointsForScenario(null)).some((p) => p.id === id)).toBe(false);
  });
});
