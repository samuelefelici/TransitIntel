/**
 * Il limite per deposito sulla scrittura del roster, su un database vero
 * (TEST_DATABASE_URL, migrato; in CI come cerbero_app). PR 2.14c.
 *
 * Tre conducenti fittizi: uno di Jesi, uno di Ancona, uno senza deposito.
 * Chi ha «Jesi» fra i suoi depositi scrive solo sul primo: voci, turni,
 * rotazioni dei riposi, riposi generati, conducenti fittizi. Chi non ha
 * depositi scrive su tutti, come prima; l'amministratore sempre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Router } from "express";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import anagraficaRouter from "../routes/anagrafica";
import rosterRouter from "../routes/roster";
import rotazioniRouter from "../lib/roster-rotazioni";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e1400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [CAPO, LIBERO, ADMIN, JESI, ANCONA, SENZA, DSS] = Array.from({ length: 7 }, (_, i) => u(i + 1));
const GIORNO = "2031-03-10";

/* i tre router del roster, nell'ordine in cui li monta l'API (routes/index.ts) */
const router = Router();
router.use(anagraficaRouter);
router.use(rosterRouter);
router.use(rotazioniRouter);

const capo = request(appDiProva(router, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["jesi"] })));
const libero = request(appDiProva(router, utenteDiProva(LIBERO, [], "user", { ruoli: ["capo_deposito"] })));
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin", { depositi: ["jesi"] })));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const uno = async (q: ReturnType<typeof sql>) => (await righe(q))[0];
const voci = async (id: string) => Number((await uno(sql`SELECT count(*)::int AS n FROM roster_entries WHERE driver_id = ${id}::uuid`)).n);

async function pulisci() {
  await db.execute(sql`DELETE FROM roster_rotazioni_riposi WHERE name LIKE 'Prova 2.14c%'`);
  await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${JESI}::uuid, ${ANCONA}::uuid, ${SENZA}::uuid) OR name LIKE 'Prova214c%'`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("il limite per deposito sul roster (database vero)", () => {
  beforeAll(async () => {
    /* la prima richiesta prepara l'anagrafica (catalogo dei depositi compreso) */
    const dep = await libero.get("/api/roster/depositi");
    expect(dep.status).toBe(200);
    await pulisci();
    await db.execute(sql`
      INSERT INTO roster_drivers (id, name, is_fictitious, is_active, residenza_servizio, versione, updated_at) VALUES
        (${JESI}::uuid, 'Prova214c Jesi', true, true, 'Jesi', 0, now()),
        (${ANCONA}::uuid, 'Prova214c Ancona', true, true, 'Ancona', 0, now()),
        (${SENZA}::uuid, 'Prova214c Senza', true, true, NULL, 0, now())`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  const voce = (chi: typeof capo, driverId: string, code = "ASS") =>
    chi.post("/api/roster/entries").send({ driverId, day: GIORNO, category: "assenza", code });

  it("le voci: solo sui conducenti dei propri depositi", async () => {
    expect((await voce(capo, JESI)).status).toBe(201);
    const fuori = await voce(capo, ANCONA);
    expect(fuori.status).toBe(403);
    expect(fuori.body.solaLettura).toBe(true);
    expect(fuori.body.error).toBe("Sola lettura: il conducente è del deposito «Ancona», e tu scrivi solo sui conducenti di Jesi");
    // il rifiuto nomina i depositi, mai il conducente
    expect(JSON.stringify(fuori.body)).not.toMatch(/Prova214c/);
    const senza = await voce(capo, SENZA);
    expect(senza.status).toBe(403);
    expect(senza.body.error).toMatch(/il conducente non ha un deposito/);
    expect(await voci(ANCONA)).toBe(0);
    expect(await voci(SENZA)).toBe(0);
  });

  it("chi non ha depositi scrive su tutti, come prima; l'amministratore anche se gliene scrivono", async () => {
    expect((await voce(libero, ANCONA)).status).toBe(201);
    expect((await voce(libero, SENZA)).status).toBe(201);
    expect((await voce(admin, ANCONA, "R")).status).toBe(201);
  });

  it("togliere una voce o un turno di un altro deposito: rifiutato, e la riga resta", async () => {
    const v = await uno(sql`SELECT id::text FROM roster_entries WHERE driver_id = ${ANCONA}::uuid AND code = 'ASS'`);
    const r = await capo.delete(`/api/roster/entries/${v.id}`);
    expect(r.status).toBe(403);
    expect(r.body.solaLettura).toBe(true);
    expect(await voci(ANCONA)).toBe(2);
    const t = await uno(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code) VALUES (${ANCONA}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'T-ANCONA')
      RETURNING id::text`);
    const rt = await capo.delete(`/api/roster/assignments/${t.id}`);
    expect(rt.status).toBe(403);
    expect(rt.body.solaLettura).toBe(true);
    expect((await uno(sql`SELECT count(*)::int AS n FROM roster_assignments WHERE id = ${t.id}::uuid`)).n).toBe(1);
    // dei propri sì
    const mia = await uno(sql`SELECT id::text FROM roster_entries WHERE driver_id = ${JESI}::uuid`);
    expect((await capo.delete(`/api/roster/entries/${mia.id}`)).status).toBe(200);
    const tj = await uno(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code) VALUES (${JESI}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'T-JESI')
      RETURNING id::text`);
    expect((await capo.delete(`/api/roster/assignments/${tj.id}`)).status).toBe(200);
    // chi non ha limiti toglie anche quello di Ancona
    expect((await libero.delete(`/api/roster/assignments/${t.id}`)).status).toBe(200);
  });

  it("le rotazioni dei riposi: si cambia solo l'assegnazione dei propri conducenti", async () => {
    const settimana = ["R", null, null, null, null, null, "R"];
    const creata = await capo.post("/api/roster/rotazioni-riposi").send({ name: "Prova 2.14c", pattern: [settimana, settimana] });
    expect(creata.status).toBe(201);
    const rot = creata.body.id as string;
    const assegna = (chi: typeof capo, elenco: Array<[string, number]>) =>
      chi.put(`/api/roster/rotazioni-riposi/${rot}/assegnazioni`).send({ assignments: elenco.map(([driverId, weekIndex]) => ({ driverId, weekIndex })) });

    // aggiungere un conducente di Ancona: no
    const no = await assegna(capo, [[JESI, 0], [ANCONA, 1]]);
    expect(no.status).toBe(403);
    expect(no.body.solaLettura).toBe(true);
    expect(no.body.error).toMatch(/deposito «Ancona»/);
    // il proprio sì
    expect((await assegna(capo, [[JESI, 0]])).status).toBe(200);
    // quello di Ancona lo mette chi non ha limiti
    expect((await assegna(libero, [[JESI, 0], [ANCONA, 1]])).status).toBe(200);
    // la pagina rimanda l'elenco intero: Ancona dov'era non è un cambio, Jesi spostato sì ed è permesso
    expect((await assegna(capo, [[JESI, 1], [ANCONA, 1]])).status).toBe(200);
    // spostare o togliere quello di Ancona: no, e resta dov'era
    expect((await assegna(capo, [[JESI, 1], [ANCONA, 0]])).status).toBe(403);
    expect((await assegna(capo, [[JESI, 1]])).status).toBe(403);
    const ora = await righe(sql`SELECT driver_id::text, week_index FROM roster_rotazione_assegnazioni WHERE rotazione_id = ${rot}::uuid ORDER BY driver_id`);
    expect(ora).toEqual([{ driver_id: JESI, week_index: 1 }, { driver_id: ANCONA, week_index: 1 }]);

    // i riposi si generano solo per i propri, e la risposta dice quanti restano fuori
    const primaAncona = await voci(ANCONA);
    const gen = await capo.post(`/api/roster/rotazioni-riposi/${rot}/genera-riposi`).send({ startDate: "2031-04-07", days: 14 });
    expect(gen.status).toBe(200);
    expect(gen.body.drivers).toBe(1);
    expect(gen.body.fuoriDeposito).toBeGreaterThanOrEqual(2);
    expect(await voci(JESI)).toBeGreaterThan(0);
    expect(await voci(ANCONA)).toBe(primaAncona);
    expect((await uno(sql`SELECT count(*)::int AS n FROM roster_entries WHERE driver_id = ${ANCONA}::uuid AND source = ${`rotazione:${rot}`}`)).n).toBe(0);

    // cancellare una rotazione che ha conducenti di altri depositi: no
    const via = await capo.delete(`/api/roster/rotazioni-riposi/${rot}`);
    expect(via.status).toBe(403);
    expect(via.body.solaLettura).toBe(true);
    expect((await uno(sql`SELECT count(*)::int AS n FROM roster_rotazioni_riposi WHERE id = ${rot}::uuid`)).n).toBe(1);
    expect((await libero.delete(`/api/roster/rotazioni-riposi/${rot}`)).status).toBe(200);
  });

  it("i conducenti fittizi: si creano, si spostano e si disattivano solo nei propri depositi", async () => {
    const crea = (chi: typeof capo, deposito: string | null) =>
      chi.post("/api/roster/drivers").send({ isFictitious: true, cognome: "Prova214c", nome: "Nuovo", ...(deposito ? { residenzaServizio: deposito } : {}) });
    const quanti = async () => Number((await uno(sql`SELECT count(*)::int AS n FROM roster_drivers WHERE name LIKE 'Prova214c Nuovo%'`)).n);

    const fuori = await crea(capo, "Ancona");
    expect(fuori.status).toBe(403);
    expect(fuori.body.solaLettura).toBe(true);
    // senza deposito nemmeno: resterebbe un conducente che nessun capo deposito può toccare
    expect((await crea(capo, null)).status).toBe(403);
    expect(await quanti()).toBe(0);

    const mio = await crea(capo, "Jesi");
    expect(mio.status).toBe(201);
    const id = mio.body.conducente.id as string;
    expect(await quanti()).toBe(1);

    // spostarlo ad Ancona: no, e resta a Jesi
    const sposta = await capo.patch(`/api/roster/drivers/${id}`).send({ residenzaServizio: "Ancona" });
    expect(sposta.status).toBe(403);
    expect((await uno(sql`SELECT residenza_servizio FROM roster_drivers WHERE id = ${id}::uuid`)).residenza_servizio).toBe("Jesi");
    // modificare o disattivare quello di Ancona: no
    expect((await capo.patch(`/api/roster/drivers/${ANCONA}`).send({ nome: "Altro" })).status).toBe(403);
    expect((await capo.delete(`/api/roster/drivers/${ANCONA}`)).status).toBe(403);
    expect((await uno(sql`SELECT is_active FROM roster_drivers WHERE id = ${ANCONA}::uuid`)).is_active).toBe(true);
    // il proprio sì
    expect((await capo.patch(`/api/roster/drivers/${id}`).send({ nome: "Cambiato" })).status).toBe(200);
    expect((await capo.delete(`/api/roster/drivers/${id}`)).status).toBe(200);
  });

  it("leggere resta com'era: il tabellone degli altri depositi si vede", async () => {
    const r = await capo.get("/api/roster/drivers");
    expect(r.status).toBe(200);
    const nomi = (r.body.drivers as Array<{ name: string }>).map(d => d.name);
    expect(nomi).toEqual(expect.arrayContaining(["Prova214c Jesi", "Prova214c Ancona", "Prova214c Senza"]));
  });
});
