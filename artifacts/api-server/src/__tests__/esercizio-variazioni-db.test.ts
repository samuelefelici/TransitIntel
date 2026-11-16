/**
 * Le variazioni decise in anticipo (tappa 4.10, migrazione 0031), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Una giornata passata e congelata (dove le variazioni si applicano) e una
 * futura (dove si scrivono e si annullano). Le corse della passata:
 *   k1  linea 1, 08:30, da decidere       → soppressa dalla variazione (fascia 08–10)
 *   k2  linea 1, 09:15, già effettuata     → non si tocca, era decisa
 *   k3  linea 2, 08:30, da decidere        → altra linea; in fascia garantita
 *   k4  linea 3, 13:00, senza proposta     → fuori fascia: la presunzione la salta
 *   k5  linea 3, 07:00, senza proposta     → in fascia: presunta
 *   k6  linea 3, 14:00, non rilevata       → fuori fascia: la presunzione la salta
 * Lo sciopero ha la fascia garantita 06:00–09:00.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import esercizioRouter from "../routes/esercizio";
import { annullaVariazione, creaVariazione, elencoVariazioni, corseInSciopero } from "../lib/esercizio-variazioni";
import { applicaVariazioni, giornateConVariazioni } from "../lib/esercizio-variazioni-applica";
import { registraEvento } from "../lib/esercizio-giornale";
import { giornataOggi } from "../lib/service-day";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const OPERATORE = "d4a00000-0000-4000-8000-000000000001";
const PASSATA = "2026-09-01";
const piuGiorni = (g: string, n: number) => { const d = new Date(`${g}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const FUTURA = piuGiorni(giornataOggi(), 10);

describe.runIf(!!process.env.TEST_DATABASE_URL)("le variazioni decise in anticipo, sul database", () => {
  const corsa = async (k: string) => righe(await db.execute(sql`
    SELECT esito, causale, confermata_da::text AS da FROM esercizio_corse WHERE giorno = ${PASSATA}::date AND chiave = ${k}`))[0];
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_variazioni WHERE giorno IN (${PASSATA}::date, ${FUTURA}::date)`);
    await db.execute(sql`DELETE FROM esercizio_eventi WHERE giorno = ${PASSATA}::date`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = ${PASSATA}::date`);
    await db.execute(sql`DELETE FROM users WHERE id = ${OPERATORE}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (${OPERATORE}::uuid, 'variazioni@prova.local', 'x', 'user', 'Movimento di prova')`);
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, turni) VALUES (${PASSATA}::date, 'congelata', 6, now(), now(), '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, linea, partenza, origine, km_prog, proposta, esito, km_eff, confermata_il) VALUES
      (${PASSATA}::date, 'k1', '1', '1', '08:30:00', 'programmata', 10, 'non_rilevata', NULL, NULL, NULL),
      (${PASSATA}::date, 'k2', '2', '1', '09:15:00', 'programmata', 10, 'effettuata_avm', 'effettuata', 10, now()),
      (${PASSATA}::date, 'k3', '3', '2', '08:30:00', 'programmata', 10, NULL, NULL, NULL, NULL),
      (${PASSATA}::date, 'k4', '4', '3', '13:00:00', 'programmata', 10, NULL, NULL, NULL, NULL),
      (${PASSATA}::date, 'k5', '5', '3', '07:00:00', 'programmata', 10, NULL, NULL, NULL, NULL),
      (${PASSATA}::date, 'k6', '6', '3', '14:00:00', 'programmata', 10, 'non_rilevata', NULL, NULL, NULL)`);
  });
  afterAll(pulisci);

  it("si scrive per un giorno futuro, si vede con chi l'ha scritta, si annulla una volta sola", async () => {
    const { id } = await creaVariazione({ tipo: "soppressione", giorno: FUTURA, linee: ["1"], numeri: [], dalle: "08:00", alle: "10:00", causale: "MANIFESTAZIONE", nota: "Corteo" }, { id: OPERATORE });
    const [v] = (await elencoVariazioni(FUTURA, FUTURA)).filter((x) => x.id === id);
    expect(v).toMatchObject({ stato: "in_attesa", annullabile: true, creataDa: "Movimento di prova", causale: "MANIFESTAZIONE", corse: null, nota: "Corteo" });
    await annullaVariazione(id, { id: OPERATORE });
    const [a] = (await elencoVariazioni(FUTURA, FUTURA)).filter((x) => x.id === id);
    expect(a).toMatchObject({ stato: "annullata", annullabile: false, annullataDa: "Movimento di prova" });
    await expect(annullaVariazione(id, { id: OPERATORE })).rejects.toMatchObject({ status: 409 });
    // il passato no, e una causale che non c'è no
    await expect(creaVariazione({ tipo: "sciopero", giorno: PASSATA, linee: [], fasce: [{ dalle: "06:00", alle: "09:00" }], causale: "SCIOPERO" }, { id: OPERATORE }))
      .rejects.toMatchObject({ status: 400 });
    await expect(creaVariazione({ tipo: "soppressione", giorno: FUTURA, linee: ["1"], numeri: [], causale: "NON_ESISTE" }, { id: OPERATORE }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("alla giornata cominciata: la soppressione diventa esito nel giornale a nome di chi l'ha scritta; lo sciopero si segna", async () => {
    /* scritte «il giorno prima» (oggi = PASSATA - 1), applicate a giornata congelata */
    const vigilia = piuGiorni(PASSATA, -1);
    const s = await creaVariazione({ tipo: "soppressione", giorno: PASSATA, linee: ["1"], numeri: [], dalle: "08:00", alle: "10:00", causale: "MANIFESTAZIONE" }, { id: OPERATORE }, vigilia);
    const sc = await creaVariazione({ tipo: "sciopero", giorno: PASSATA, linee: [], fasce: [{ dalle: "06:00", alle: "09:00" }], causale: "SCIOPERO" }, { id: OPERATORE }, vigilia);
    expect(s.giornataCominciata).toBe(true);
    expect(await giornateConVariazioni()).toContain(PASSATA);
    const r = await applicaVariazioni(PASSATA);
    expect(r).toEqual([{ id: s.id, tipo: "soppressione", corse: 1 }, { id: sc.id, tipo: "sciopero", corse: 3 }]);
    expect(await corsa("k1")).toEqual({ esito: "soppressa", causale: "MANIFESTAZIONE", da: OPERATORE });
    expect((await corsa("k2")).esito).toBe("effettuata");
    expect((await corsa("k3")).esito).toBeNull();
    const ev = righe(await db.execute(sql`SELECT tipo, chiavi, autore::text AS autore, (dati->>'variazione')::int AS variazione FROM esercizio_eventi WHERE giorno = ${PASSATA}::date`));
    expect(ev).toEqual([{ tipo: "esito", chiavi: ["k1"], autore: OPERATORE, variazione: s.id }]);
    const elenco = await elencoVariazioni(PASSATA, PASSATA);
    expect(elenco.map((x) => [x.id, x.stato, x.corse, x.annullabile])).toEqual([[s.id, "applicata", 1, false], [sc.id, "applicata", 3, false]]);
    // una seconda volta non fa niente; applicata non si annulla
    expect(await applicaVariazioni(PASSATA)).toEqual([]);
    await expect(annullaVariazione(s.id, { id: OPERATORE })).rejects.toMatchObject({ status: 409 });
  });

  it("lo sciopero: le corse fuori fascia; la presunzione di effettuazione le salta", async () => {
    expect([...(await corseInSciopero(db, PASSATA))].sort()).toEqual(["k2", "k4", "k6"]);
    const versione = Number(righe(await db.execute(sql`SELECT versione FROM esercizio_giornate WHERE giorno = ${PASSATA}::date`))[0].versione);
    const r = await registraEvento(PASSATA, { tipo: "conferma", versione, fonte: "movimento", proposte: ["non_rilevata"] }, { id: OPERATORE });
    expect(r.corse).toBe(2);
    expect((await corsa("k3")).esito).toBe("presunta");
    expect((await corsa("k5")).esito).toBe("presunta");
    expect((await corsa("k4")).esito).toBeNull();
    expect((await corsa("k6")).esito).toBeNull();
  });

  it("due applicazioni insieme: un solo evento", async () => {
    await db.execute(sql`UPDATE esercizio_corse SET esito = NULL, km_eff = NULL, causale = NULL, confermata_da = NULL, confermata_il = NULL
                          WHERE giorno = ${PASSATA}::date AND chiave = 'k4'`);
    const v = await creaVariazione({ tipo: "soppressione", giorno: PASSATA, linee: [], numeri: ["4"], causale: "SCIOPERO" }, { id: OPERATORE }, piuGiorni(PASSATA, -1));
    const [a, b] = await Promise.all([applicaVariazioni(PASSATA), applicaVariazioni(PASSATA)]);
    expect([...a, ...b].filter((x) => x.id === v.id && !x.errore)).toHaveLength(1);
    const n = righe(await db.execute(sql`SELECT count(*)::int AS n FROM esercizio_eventi WHERE giorno = ${PASSATA}::date AND (dati->>'variazione')::bigint = ${v.id}`))[0].n;
    expect(n).toBe(1);
    expect((await corsa("k4")).esito).toBe("soppressa");
  });

  it("dall'API: l'elenco; un token di servizio non scrive; il passato e le richieste sbagliate sono 400", async () => {
    const persona = appDiProva(esercizioRouter, utenteDiProva(OPERATORE, [], "user", { ruoli: ["pianificatore"] }));
    const l = await request(persona).get(`/api/esercizio/variazioni?dal=${PASSATA}&al=${PASSATA}`);
    expect(l.status).toBe(200);
    expect(l.body.variazioni.length).toBeGreaterThanOrEqual(3);
    expect((await request(persona).post("/api/esercizio/variazioni").send({ tipo: "sciopero", giorno: PASSATA, fasce: [{ dalle: "06:00", alle: "09:00" }] })).status).toBe(400);
    expect((await request(persona).post("/api/esercizio/variazioni").send({ tipo: "soppressione", giorno: FUTURA, causale: "SCIOPERO" })).status).toBe(400);
    const nuova = await request(persona).post("/api/esercizio/variazioni").send({ tipo: "sciopero", giorno: FUTURA, fasce: [{ dalle: "06:00", alle: "09:00" }, { dalle: "12:00", alle: "15:00" }], nota: "Sciopero nazionale di 24 ore" });
    expect(nuova.status).toBe(201);
    expect(nuova.body).toEqual({ id: expect.any(Number), applicata: null });
    expect((await request(persona).post(`/api/esercizio/variazioni/${nuova.body.id}/annullamento`)).status).toBe(200);
    const servizio = express_con_servizio();
    expect((await request(servizio).post("/api/esercizio/variazioni").send({ tipo: "sciopero", giorno: FUTURA, fasce: [{ dalle: "06:00", alle: "09:00" }] })).status).toBe(403);
  });
});

/** Un'app col token di servizio (Argos): legge ma non scrive. */
function express_con_servizio() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = utenteDiProva("d4a00000-0000-4000-8000-000000000002", [], "user", { ruoli: ["pianificatore"] });
    req.authVia = "argos"; req.log = { error() {} }; next();
  });
  app.use("/api", esercizioRouter);
  return app;
}
