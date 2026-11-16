/**
 * Chiusura e blocco del consuntivo (tappa 4.6), su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Maggio 2026, due giornate. Si controlla: la presunzione delle non rilevate,
 * che cosa blocca la chiusura, il riepilogo congelato, il blocco delle
 * scritture, la riapertura col motivo (e richiudere dà lo stesso
 * riepilogo), il mese che si chiude solo con tutte le giornate chiuse e che
 * blocca la riapertura dei suoi giorni, chi può fare cosa dall'API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import esercizioRouter from "../routes/esercizio";
import adminRouter from "../routes/admin";
import { registraEvento, type Richiesta } from "../lib/esercizio-giornale";
import { chiudiGiornata, riapriGiornata, chiudiMese, riapriMese, statoDelMese, chiusuraDellaGiornata } from "../lib/esercizio-chiusura";
import { calcolaProposta } from "../lib/esercizio-proposta";
import { preparaGiornata, leggiGiornata } from "../lib/esercizio-giornate";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAPO = u(1);
const G1 = "2026-05-05", G2 = "2026-05-06", FUTURA = "2033-01-04", MESE = "2026-05";
const GIORNI = [G1, G2, FUTURA];

const evento = (giorno: string, r: Partial<Richiesta> & { tipo: Richiesta["tipo"] }) => registraEvento(giorno, { fonte: "movimento", ...r } as Richiesta, { id: CAPO });
const versione = async (g: string) => (await leggiGiornata(g))!.versione;

describe.runIf(!!process.env.TEST_DATABASE_URL)("chiusura e blocco del consuntivo, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_mesi WHERE mese = ${`${MESE}-01`}::date`);
    await db.execute(sql`DELETE FROM esercizio_eventi WHERE giorno IN (SELECT jsonb_array_elements_text(${JSON.stringify(GIORNI)}::jsonb)::date)`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (SELECT jsonb_array_elements_text(${JSON.stringify(GIORNI)}::jsonb)::date)`);
    await db.execute(sql`DELETE FROM users WHERE id = ${CAPO}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (${CAPO}::uuid, 'chiusura@prova.local', 'x', 'user', 'Amministrazione di prova')`);
    for (const g of GIORNI) {
      await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, turni)
        VALUES (${g}::date, 'congelata', 0, now() - interval '1 day', now(), '{}'::jsonb)`);
    }
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, linea, partenza, km_prog, proposta) VALUES
      (${G1}::date, 'g46-a', '1', '1', '07:00:00', 10, 'effettuata_avm'),
      (${G1}::date, 'g46-b', '2', '1', '08:00:00', 10, 'non_rilevata'),
      (${G1}::date, 'g46-c', '3', '2', '09:00:00', 6, NULL),
      (${G1}::date, 'g46-d', '4', '2', '10:00:00', 6, 'parziale'),
      (${G2}::date, 'g46-e', '5', '1', '07:00:00', 10, 'non_rilevata')`);
  });
  afterAll(pulisci);

  let primoRiepilogo: any;

  it("la presunzione delle non rilevate; poi la chiusura vuole tutte le corse decise e le parziali coi km", async () => {
    await expect(chiudiGiornata(G1, 0, CAPO)).rejects.toMatchObject({ status: 409, message: "Non si chiude: 4 corse da decidere" });
    await evento(G1, { tipo: "conferma", versione: 0, proposte: ["effettuata_avm"] });
    const p = await evento(G1, { tipo: "conferma", versione: 1, proposte: ["non_rilevata"] });
    expect(p.corse).toBe(2);
    const g = (await leggiGiornata(G1))!;
    expect(g.elenco.map((c: any) => [c.chiave, c.esito, c.kmEff])).toEqual([
      ["g46-a", "effettuata", 10], ["g46-b", "presunta", 10], ["g46-c", "presunta", 6], ["g46-d", null, null]]);
    await evento(G1, { tipo: "esito", versione: 2, chiavi: ["g46-d"], esito: "parziale", causale: "GUASTO_MEZZO" });
    await expect(chiudiGiornata(G1, 3, CAPO)).rejects.toMatchObject({ status: 409, message: "Non si chiude: 1 parziali senza i km fatti" });
    await evento(G1, { tipo: "esito", versione: 3, chiavi: ["g46-d"], esito: "parziale", causale: "GUASTO_MEZZO", kmEff: 2.5 });
    expect((await chiusuraDellaGiornata(G1))!.perché).toBeNull();
  });

  it("chiusa: il riepilogo si congela, ogni scrittura risponde 409", async () => {
    await expect(chiudiGiornata(G1, 3, CAPO)).rejects.toMatchObject({ status: 409 }); // versione vecchia
    const c = await chiudiGiornata(G1, 4, CAPO);
    primoRiepilogo = c.riepilogo;
    expect(c.riepilogo).toMatchObject({
      corse: { programmate: 4, aggiunte: 0, effettuate: 1, presunte: 2, parziali: 1, soppresse: 0 },
      km: { programmati: 32, effettivi: 28.5, persi: 3.5, aggiunti: 0 },
      perCausale: [{ causale: "GUASTO_MEZZO", descrizione: "Guasto del mezzo", imputabile: true, corse: 1, kmPersi: 3.5 }],
    });
    expect(c.riepilogo.perLinea.map((l: any) => [l.linea, l.programmate, l.kmEffettivi])).toEqual([["1", 2, 20], ["2", 2, 8.5]]);
    expect((await chiusuraDellaGiornata(G1))).toMatchObject({ chiusa: true, chiusaDa: "Amministrazione di prova" });
    await expect(evento(G1, { tipo: "nota", versione: 5, nota: "dopo" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^Giornata chiusa/) });
    await expect(calcolaProposta(G1)).rejects.toMatchObject({ status: 409 });
    expect(await preparaGiornata(G1)).toMatchObject({ giaCongelata: true, turniCompletati: false });
    await expect(chiudiGiornata(G1, 5, CAPO)).rejects.toMatchObject({ status: 409, message: "Giornata già chiusa" });
  });

  it("una giornata non ancora finita non si chiude", async () => {
    await expect(chiudiGiornata(FUTURA, 0, CAPO)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/non è ancora finita/) });
  });

  it("riaperta col motivo dall'amministratore, e richiusa senza modifiche: lo stesso riepilogo", async () => {
    await expect(riapriGiornata(G1, "no", CAPO)).rejects.toMatchObject({ status: 400 });
    const r = await riapriGiornata(G1, "Corsa 4 da ricontrollare con il deposito", CAPO);
    expect(r.stato).toBe("congelata");
    const c = await chiudiGiornata(G1, r.versione, CAPO);
    expect(c.riepilogo).toEqual(primoRiepilogo);
    const tipi = (await db.execute(sql`SELECT tipo, dati->>'nota' AS nota FROM esercizio_eventi WHERE giorno = ${G1}::date AND tipo IN ('chiusura', 'riapertura') ORDER BY id`) as any).rows;
    expect(tipi).toEqual([
      { tipo: "chiusura", nota: null }, { tipo: "riapertura", nota: "Corsa 4 da ricontrollare con il deposito" }, { tipo: "chiusura", nota: null }]);
  });

  it("il mese si chiude solo con tutte le giornate chiuse; chiuso, blocca la riapertura dei suoi giorni", async () => {
    await expect(chiudiMese(MESE, CAPO)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/1 giornate ancora aperte \(2026-05-06\)/) });
    await evento(G2, { tipo: "conferma", versione: 0, proposte: ["non_rilevata"] });
    await chiudiGiornata(G2, await versione(G2), CAPO);
    const m = await chiudiMese(MESE, CAPO);
    expect(m.riepilogo).toMatchObject({ corse: { programmate: 5, presunte: 3 }, giorni: { delMese: 31, chiusi: 2 } });
    expect(m.riepilogo.giorni.mancanti).toHaveLength(29);
    expect(await statoDelMese(MESE)).toMatchObject({ stato: "chiuso", chiuse: 2, aperte: [], storia: [{ azione: "chiusura", da: "Amministrazione di prova" }] });
    await expect(riapriGiornata(G1, "Serve una correzione", CAPO)).rejects.toMatchObject({ status: 409, message: "Il mese è chiuso: riapri prima il mese" });
    await expect(chiudiMese(MESE, CAPO)).rejects.toMatchObject({ status: 409, message: "Mese già chiuso" });
    await riapriMese(MESE, "Correzione chiesta dall'ente", CAPO);
    expect(await statoDelMese(MESE)).toMatchObject({ stato: "aperto", storia: [{ azione: "chiusura" }, { azione: "riapertura", motivo: "Correzione chiesta dall'ente" }] });
    expect((await riapriGiornata(G1, "Serve una correzione", CAPO)).stato).toBe("congelata");
  });

  it("dall'API: chiude chi ha il ruolo Amministrazione, non la Centrale; riaprire e il mese sono dell'amministratore", async () => {
    const centrale = appDiProva(esercizioRouter, utenteDiProva(CAPO, [], "user", { ruoli: ["centrale_operativa"] }));
    const amministrazione = appDiProva(esercizioRouter, utenteDiProva(CAPO, [], "user", { ruoli: ["amministrazione"] }));
    const v = await versione(G1);
    expect((await request(centrale).post(`/api/esercizio/giornate/${G1}/chiusura`).send({ versione: v })).status).toBe(403);
    const ok = await request(amministrazione).post(`/api/esercizio/giornate/${G1}/chiusura`).send({ versione: v });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const g = await request(centrale).get(`/api/esercizio/giornate/${G1}`);
    expect(g.body.chiusura).toMatchObject({ chiusa: true, meseChiuso: false });
    expect((await request(centrale).get(`/api/esercizio/mesi/${MESE}`)).body).toMatchObject({ mese: MESE, chiuse: 2 });
    expect((await request(centrale).get(`/api/esercizio/mesi/2026-13`)).status).toBe(400);
    // le rotte dell'amministratore: requireAdmin
    const nonAdmin = appDiProva(adminRouter, utenteDiProva(CAPO, [], "user", { ruoli: ["amministrazione"] }));
    expect((await request(nonAdmin).post(`/api/admin/esercizio/giornate/${G1}/riapertura`).send({ motivo: "Prova di permessi" })).status).toBe(403);
    const admin = appDiProva(adminRouter, utenteDiProva(CAPO, [], "admin"));
    expect((await request(admin).post(`/api/admin/esercizio/giornate/${G1}/riapertura`).send({ motivo: "x" })).status).toBe(400);
    expect((await request(admin).post(`/api/admin/esercizio/giornate/${G1}/riapertura`).send({ motivo: "Prova dall'API" })).status).toBe(200);
    expect((await request(admin).post(`/api/admin/esercizio/mesi/${MESE}/chiusura`)).status).toBe(409);
  });
});
