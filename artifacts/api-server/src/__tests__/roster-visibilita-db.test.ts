/**
 * I depositi che una persona vede, su un database vero (TEST_DATABASE_URL,
 * migrato; in CI come cerbero_app). PR 2.14d, migrazione 0016.
 *
 * Quattro conducenti fittizi: Jesi, Ancona, Osimo e uno senza deposito.
 *   capo      vede Jesi e Ancona, modifica Jesi
 *   lettore   vede Jesi, non modifica niente
 *   hr        scrive il «Personale», vede solo Jesi
 *   libero    nessun limite (com'era prima)
 * Chi ha un limite non riceve i conducenti degli altri depositi da nessuna
 * rotta, e per lui sono come se non ci fossero; i turni che hanno preso
 * risultano occupati, senza dire da chi.
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

const u = (n: number) => `e14d0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [CAPO, LETTORE, HR, LIBERO, ADMIN, JESI, ANCONA, OSIMO, SENZA, DSS] = Array.from({ length: 10 }, (_, i) => u(i + 1));
const GIORNO = "2031-05-12";

const router = Router();
router.use(anagraficaRouter);
router.use(rosterRouter);
router.use(rotazioniRouter);

const capo = request(appDiProva(router, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["jesi"], depositiVisibili: ["jesi", "ancona"] })));
const lettore = request(appDiProva(router, utenteDiProva(LETTORE, [], "user", { ruoli: ["capo_deposito"], depositiVisibili: ["jesi"] })));
const hr = request(appDiProva(router, utenteDiProva(HR, [], "user", { ruoli: ["amministrazione", "capo_deposito"], depositiVisibili: ["jesi"], depositi: ["jesi"] })));
const libero = request(appDiProva(router, utenteDiProva(LIBERO, [], "user", { ruoli: ["capo_deposito"] })));
const admin = request(appDiProva(router, utenteDiProva(ADMIN, [], "admin", { depositi: ["jesi"], depositiVisibili: ["jesi"] })));

const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const uno = async (q: ReturnType<typeof sql>) => (await righe(q))[0];
const nomi = (r: { body: { drivers?: Array<{ name: string }> } }) => (r.body.drivers ?? []).map(d => d.name).filter(n => n.startsWith("Prova214d")).sort();

async function pulisci() {
  await db.execute(sql`DELETE FROM roster_rotazioni_riposi WHERE name LIKE 'Prova 2.14d%'`);
  await db.execute(sql`DELETE FROM roster_drivers WHERE id IN (${JESI}::uuid, ${ANCONA}::uuid, ${OSIMO}::uuid, ${SENZA}::uuid) OR name LIKE 'Prova214d%'`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("i depositi che una persona vede (database vero)", () => {
  beforeAll(async () => {
    /* la prima richiesta prepara l'anagrafica (catalogo dei depositi compreso) */
    expect((await libero.get("/api/roster/depositi")).status).toBe(200);
    await pulisci();
    await db.execute(sql`
      INSERT INTO roster_drivers (id, name, is_fictitious, is_active, residenza_servizio, versione, updated_at) VALUES
        (${JESI}::uuid, 'Prova214d Jesi', true, true, 'Jesi', 0, now()),
        (${ANCONA}::uuid, 'Prova214d Ancona', true, true, 'Ancona', 0, now()),
        (${OSIMO}::uuid, 'Prova214d Osimo', true, true, 'Osimo', 0, now()),
        (${SENZA}::uuid, 'Prova214d Senza', true, true, NULL, 0, now())`);
    await db.execute(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code) VALUES
        (${JESI}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'T-JESI'), (${OSIMO}::uuid, ${GIORNO}::date, ${DSS}::uuid, 'T-OSIMO')`);
    await db.execute(sql`
      INSERT INTO roster_entries (driver_id, day, category, code) VALUES
        (${ANCONA}::uuid, ${GIORNO}::date, 'assenza', 'ASS'), (${OSIMO}::uuid, ${GIORNO}::date, 'assenza', 'ASS')`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("l'elenco dei conducenti: solo quelli dei depositi che vede", async () => {
    expect(nomi(await capo.get("/api/roster/drivers"))).toEqual(["Prova214d Ancona", "Prova214d Jesi"]);
    expect(nomi(await lettore.get("/api/roster/drivers"))).toEqual(["Prova214d Jesi"]);
    expect(nomi(await hr.get("/api/roster/drivers"))).toEqual(["Prova214d Jesi"]);
    // chi non ha limiti e l'amministratore (anche se gliene scrivono) li vedono tutti, come prima
    expect(nomi(await libero.get("/api/roster/drivers"))).toEqual(["Prova214d Ancona", "Prova214d Jesi", "Prova214d Osimo", "Prova214d Senza"]);
    expect(nomi(await admin.get("/api/roster/drivers"))).toHaveLength(4);
  });

  it("la scheda di un conducente che non vede: 404, come se non ci fosse", async () => {
    expect((await capo.get(`/api/roster/drivers/${JESI}`)).status).toBe(200);
    expect((await capo.get(`/api/roster/drivers/${ANCONA}`)).status).toBe(200);
    for (const nascosto of [OSIMO, SENZA]) {
      const r = await capo.get(`/api/roster/drivers/${nascosto}`);
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/Osimo|Prova214d/);
    }
    expect((await lettore.get(`/api/roster/drivers/${ANCONA}`)).status).toBe(404);
    expect((await libero.get(`/api/roster/drivers/${SENZA}`)).status).toBe(200);
  });

  it("i depositi e i gruppi turni che riceve sono solo quelli che vede", async () => {
    const codici = async (chi: typeof capo) => ((await chi.get("/api/roster/depositi")).body.depositi as Array<{ codice: string }>).map(d => d.codice).sort();
    expect(await codici(capo)).toEqual(["ancona", "jesi"]);
    expect(await codici(lettore)).toEqual(["jesi"]);
    expect((await codici(libero)).length).toBeGreaterThan(2);
    const gruppi = (await capo.get("/api/roster/gruppi-turni")).body.gruppi as Array<{ depositoCodice: string }>;
    expect(gruppi.every(g => ["jesi", "ancona"].includes(g.depositoCodice))).toBe(true);
  });

  it("il tabellone: righe, turni e voci solo dei suoi; i turni degli altri risultano occupati, senza dire da chi", async () => {
    const t = (await capo.get(`/api/roster/board?from=${GIORNO}&days=1`)).body;
    expect((t.drivers as Array<{ id: string }>).map(d => d.id).filter(id => id.startsWith("e14d0000")).sort()).toEqual([JESI, ANCONA].sort());
    expect((t.assignments as Array<{ driverId: string; dutyCode: string }>).filter(a => a.dutyCode.startsWith("T-")).map(a => a.dutyCode)).toEqual(["T-JESI"]);
    expect(t.occupatiDaAltri).toEqual([{ day: GIORNO, dutyCode: "T-OSIMO", dssId: DSS }]);
    expect((t.entries as Array<{ driverId: string }>).map(e => e.driverId).filter(id => id.startsWith("e14d0000"))).toEqual([ANCONA]);
    // in tutta la risposta non c'è traccia del conducente che non vede
    expect(JSON.stringify(t)).not.toContain(OSIMO);
    expect(JSON.stringify(t)).not.toMatch(/Prova214d (Osimo|Senza)/);
    // chi non ha limiti riceve tutto, e nessun turno «occupato da altri»
    const tutti = (await libero.get(`/api/roster/board?from=${GIORNO}&days=1`)).body;
    expect((tutti.assignments as Array<{ dutyCode: string }>).filter(a => a.dutyCode.startsWith("T-")).map(a => a.dutyCode).sort()).toEqual(["T-JESI", "T-OSIMO"]);
    expect(tutti.occupatiDaAltri).toEqual([]);
  });

  const voce = (chi: typeof capo, driverId: string, code = "R") =>
    chi.post("/api/roster/entries").send({ driverId, day: "2031-05-13", category: "assenza", code });

  it("le scritture: modifica i suoi, vede soltanto gli altri visibili, e di quelli che non vede non sa niente", async () => {
    expect((await voce(capo, JESI)).status).toBe(201);
    const soloVisto = await voce(capo, ANCONA);
    expect(soloVisto.status).toBe(403);
    expect(soloVisto.body).toEqual({ error: "Sola lettura: il conducente è del deposito «Ancona», e tu scrivi solo sui conducenti di Jesi", solaLettura: true });
    const nascosto = await voce(capo, OSIMO);
    expect(nascosto.status).toBe(403);
    expect(nascosto.body.solaLettura).toBe(true);
    // il rifiuto non dice di che deposito è il conducente che non vede
    expect(nascosto.body.error).toBe("Sola lettura: uno dei conducenti non è di un deposito che vedi");
    expect((await voce(capo, SENZA)).body.error).toBe("Sola lettura: uno dei conducenti non è di un deposito che vedi");
    // chi vede e non modifica niente
    const lettura = await voce(lettore, JESI);
    expect(lettura.status).toBe(403);
    expect(lettura.body.error).toBe("Sola lettura: il conducente è del deposito «Jesi», e tu non modifichi i conducenti di nessun deposito");
    expect((await uno(sql`SELECT count(*)::int AS n FROM roster_entries WHERE day = '2031-05-13' AND driver_id IN (${ANCONA}::uuid, ${OSIMO}::uuid, ${SENZA}::uuid)`)).n).toBe(0);
  });

  it("un turno preso da un conducente che non vede non glielo porta via", async () => {
    const r = await capo.post("/api/roster/assignments").send({ driverId: JESI, day: GIORNO, dssId: DSS, dutyCode: "T-OSIMO" });
    expect(r.status).not.toBe(200);
    expect(r.status).not.toBe(201);
    expect((await uno(sql`SELECT driver_id::text AS d FROM roster_assignments WHERE dss_id = ${DSS}::uuid AND duty_code = 'T-OSIMO' AND day = ${GIORNO}::date`)).d).toBe(OSIMO);
    const t = await uno(sql`SELECT id::text FROM roster_assignments WHERE driver_id = ${OSIMO}::uuid AND day = ${GIORNO}::date`);
    expect((await capo.delete(`/api/roster/assignments/${t.id}`)).status).toBe(403);
  });

  it("chi scrive il «Personale» e vede solo Jesi: le schede degli altri depositi non ci sono, e non ci sposta nessuno", async () => {
    expect((await hr.patch(`/api/roster/drivers/${JESI}`).send({ note: "prova" })).status).toBe(200);
    for (const nascosto of [ANCONA, OSIMO, SENZA]) {
      expect((await hr.patch(`/api/roster/drivers/${nascosto}`).send({ note: "prova" })).status, nascosto).toBe(404);
      expect((await hr.get(`/api/roster/drivers/${nascosto}/history`)).status, nascosto).toBe(404);
      expect((await hr.delete(`/api/roster/drivers/${nascosto}`)).status, nascosto).toBe(404);
      expect((await hr.post(`/api/roster/drivers/${nascosto}/riattiva`)).status, nascosto).toBe(404);
      expect((await hr.post(`/api/roster/drivers/${nascosto}/history`).send({ kind: "categoria", value: "Autista", eventDate: "2031-01-01" })).status, nascosto).toBe(404);
    }
    expect((await uno(sql`SELECT is_active FROM roster_drivers WHERE id = ${OSIMO}::uuid`)).is_active).toBe(true);
    // spostare un suo conducente in un deposito che non vede, o crearne uno lì o senza deposito: no
    const sposta = await hr.patch(`/api/roster/drivers/${JESI}`).send({ residenzaServizio: "Osimo" });
    expect(sposta.status).toBe(403);
    expect(sposta.body.error).toBe("Sola lettura: il deposito va scelto fra quelli che vedi");
    expect((await hr.post(`/api/roster/drivers/${JESI}/history`).send({ kind: "deposito", value: "Osimo", eventDate: "2031-01-01" })).status).toBe(403);
    const crea = (deposito: string | null) => hr.post("/api/roster/drivers").send({ isFictitious: true, cognome: "Prova214d", nome: "Nuovo", ...(deposito ? { residenzaServizio: deposito } : {}) });
    expect((await crea("Osimo")).status).toBe(403);
    expect((await crea(null)).status).toBe(403);
    expect((await crea("Jesi")).status).toBe(201);
    expect((await uno(sql`SELECT residenza_servizio FROM roster_drivers WHERE id = ${JESI}::uuid`)).residenza_servizio).toBe("Jesi");
    // l'import tocca tutti i depositi: chi ne vede solo alcuni non lo fa
    for (const passo of ["prova", "applica"]) {
      const r = await hr.post(`/api/roster/anagrafica/import/${passo}`).send({});
      expect(r.status, passo).toBe(403);
      expect(r.body.solaLettura).toBe(true);
    }
  });

  it("l'esportazione porta solo i conducenti che vede", async () => {
    await db.execute(sql`UPDATE roster_drivers SET is_fictitious = false WHERE id IN (${JESI}::uuid, ${OSIMO}::uuid)`);
    try {
      const csv = (await hr.get("/api/roster/anagrafica/esporta?formato=csv")).text;
      expect(csv).toContain("Prova214d Jesi");
      expect(csv).not.toContain("Prova214d Osimo");
      expect((await libero.get("/api/roster/anagrafica/esporta?formato=csv")).text).toContain("Prova214d Osimo");
    } finally {
      await db.execute(sql`UPDATE roster_drivers SET is_fictitious = true WHERE id IN (${JESI}::uuid, ${OSIMO}::uuid)`);
    }
  });

  it("le rotazioni dei riposi: riceve solo i suoi, e salvando non toglie quelli che non vede", async () => {
    const settimana = ["R", null, null, null, null, null, "R"];
    const rot = (await libero.post("/api/roster/rotazioni-riposi").send({ name: "Prova 2.14d", pattern: [settimana, settimana] })).body.id as string;
    const assegna = (chi: typeof capo, elenco: Array<[string, number]>) =>
      chi.put(`/api/roster/rotazioni-riposi/${rot}/assegnazioni`).send({ assignments: elenco.map(([driverId, weekIndex]) => ({ driverId, weekIndex })) });
    expect((await assegna(libero, [[JESI, 0], [ANCONA, 1], [OSIMO, 1]])).status).toBe(200);

    const viste = (await capo.get(`/api/roster/rotazioni-riposi/${rot}/assegnazioni`)).body.assegnazioni as Array<{ driverId: string; weekIndex: number }>;
    expect(viste.map(a => a.driverId).sort()).toEqual([JESI, ANCONA].sort());
    // la pagina rimanda quello che ha ricevuto, con il suo conducente spostato di scaglione
    expect((await assegna(capo, [[JESI, 1], [ANCONA, 1]])).status).toBe(200);
    const ora = await righe(sql`SELECT driver_id::text AS d, week_index AS w FROM roster_rotazione_assegnazioni WHERE rotazione_id = ${rot}::uuid ORDER BY driver_id`);
    expect(ora).toEqual([{ d: JESI, w: 1 }, { d: ANCONA, w: 1 }, { d: OSIMO, w: 1 }]);
    // metterci un conducente che non vede, o cancellare la rotazione che ne ha: no
    const no = await assegna(capo, [[JESI, 1], [ANCONA, 1], [SENZA, 0]]);
    expect(no.status).toBe(403);
    expect(no.body.error).toBe("Sola lettura: uno dei conducenti non è di un deposito che vedi");
    expect((await capo.delete(`/api/roster/rotazioni-riposi/${rot}`)).status).toBe(403);
    // i riposi si generano per i suoi; di quelli fuori conta solo quelli che vede
    const gen = await capo.post(`/api/roster/rotazioni-riposi/${rot}/genera-riposi`).send({ startDate: "2031-06-02", days: 14 });
    expect(gen.status).toBe(200);
    expect(gen.body.drivers).toBe(1);
    expect((await uno(sql`SELECT count(*)::int AS n FROM roster_entries WHERE source = ${`rotazione:${rot}`} AND driver_id IN (${ANCONA}::uuid, ${OSIMO}::uuid)`)).n).toBe(0);
    expect((await libero.delete(`/api/roster/rotazioni-riposi/${rot}`)).status).toBe(200);
  });
});
