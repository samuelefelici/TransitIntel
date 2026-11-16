/**
 * Il giornale di esercizio e la conferma degli esiti (tappa 4.5), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Una giornata congelata con quattro corse e la loro proposta, una candidata
 * aggiunta. Si controlla: la conferma di massa, la versione, gli esiti con
 * la causale e i km, l'annullamento (e quando no), le aggiunte, le note,
 * l'annullamento dell'AVM come evento e come indizio della proposta, l'API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import esercizioRouter from "../routes/esercizio";
import { registraEvento, registraCancellazioneAvm, leggiGiornale, RifiutoGiornale, type Richiesta } from "../lib/esercizio-giornale";
import { calcolaProposta } from "../lib/esercizio-proposta";
import { leggiGiornata } from "../lib/esercizio-giornate";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `d4500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OPERATORE = u(1);
const GIORNO = "2026-04-07";
const [C1, C2, C3, C4] = ["g45-c1", "g45-c2", "g45-c3", "g45-c4"];
const AUTORE = { id: OPERATORE };

const evento = (r: Partial<Richiesta> & { tipo: Richiesta["tipo"] }) => registraEvento(GIORNO, { fonte: "movimento", ...r } as Richiesta, AUTORE);
const versione = async () => (await leggiGiornata(GIORNO))!.versione;
const corsa = async (k: string) => (await leggiGiornata(GIORNO))!.elenco.find((c: any) => c.chiave === k) as any;

describe.runIf(!!process.env.TEST_DATABASE_URL)("il giornale di esercizio, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_eventi WHERE giorno = ${GIORNO}::date`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = ${GIORNO}::date`);
    await db.execute(sql`DELETE FROM users WHERE id = ${OPERATORE}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (${OPERATORE}::uuid, 'giornale@prova.local', 'x', 'user', 'Ufficio movimento di prova')`);
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, turni, proposta)
      VALUES (${GIORNO}::date, 'congelata', 4, '2026-04-06 12:00+02', '2026-04-07 03:00+02', '{}'::jsonb, '{"caronte": true}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, linea, partenza, km_prog, proposta, prove) VALUES
      (${GIORNO}::date, ${C1}, '101', '1', '07:00:00', 12.5, 'effettuata_avm', '{"vetture": ["301"]}'::jsonb),
      (${GIORNO}::date, ${C2}, '102', '1', '08:00:00', 12.5, 'continuita', '{"vetture": []}'::jsonb),
      (${GIORNO}::date, ${C3}, '103', '2', '09:00:00', 8.0, 'non_rilevata', '{"vetture": []}'::jsonb),
      (${GIORNO}::date, ${C4}, '104', '2', '10:00:00', 8.0, 'da_verificare', '{"vetture": ["302", "303"]}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_aggiunte_proposte (giorno, chiave_avm, journey_ref, linea, numero, partenza, vetture, osservazioni)
      VALUES (${GIORNO}::date, 'g45-fuori', 'g45-fuori', '130', '489160', '13:05', '{304}', 3)`);
  });
  afterAll(pulisci);

  it("la conferma di massa delle proposte: effettuate, km programmati, vettura dall'AVM; la versione sale", async () => {
    expect(await versione()).toBe(0);
    const r = await evento({ tipo: "conferma", versione: 0, proposte: ["effettuata_avm", "continuita"] });
    expect(r).toMatchObject({ versione: 1, corse: 2 });
    expect(await corsa(C1)).toMatchObject({ esito: "effettuata", kmEff: 12.5, vettura: "301" });
    expect(await corsa(C2)).toMatchObject({ esito: "effettuata", kmEff: 12.5, vettura: null });
    expect((await corsa(C2)).confermataIl).not.toBeNull();
    // chi ha visto la versione di prima riceve 409
    await expect(evento({ tipo: "esito", versione: 0, chiavi: [C3], esito: "effettuata" })).rejects.toMatchObject({ status: 409 });
  });

  it("un esito: soppressa con la causale, km zero; causale sconosciuta o corsa di un altro giorno no", async () => {
    await expect(evento({ tipo: "esito", versione: 1, chiavi: [C3], esito: "soppressa", causale: "INVENTATA" })).rejects.toMatchObject({ status: 400, message: "Causale sconosciuta" });
    await expect(evento({ tipo: "esito", versione: 1, chiavi: [C3, "altra"], esito: "effettuata" })).rejects.toMatchObject({ status: 400 });
    const r = await evento({ tipo: "esito", versione: 1, chiavi: [C3], esito: "soppressa", causale: "GUASTO_MEZZO", nota: "Guasto all'uscita" });
    expect(r.versione).toBe(2);
    expect(await corsa(C3)).toMatchObject({ esito: "soppressa", kmEff: 0, causale: "GUASTO_MEZZO", nota: "Guasto all'uscita" });
  });

  it("l'annullamento rimette le corse com'erano, una volta sola; non se dopo le stesse corse sono cambiate", async () => {
    const giornale = await leggiGiornale(GIORNO);
    const conferma = giornale.find((e) => e.tipo === "conferma")!;
    // la conferma ha toccato C1 e C2; dopo è cambiata solo C3: si annulla
    const a = await evento({ tipo: "annullamento", versione: 2, evento: conferma.id });
    expect(a.versione).toBe(3);
    expect(await corsa(C1)).toMatchObject({ esito: null, kmEff: null, confermataIl: null });
    await expect(evento({ tipo: "annullamento", versione: 3, evento: conferma.id })).rejects.toMatchObject({ status: 409, message: "Evento già annullato" });
    // C4: due esiti di fila, il primo non si annulla finché c'è il secondo
    const primo = await evento({ tipo: "esito", versione: 3, chiavi: [C4], esito: "effettuata" });
    const secondo = await evento({ tipo: "esito", versione: 4, chiavi: [C4], esito: "da_verificare" });
    await expect(evento({ tipo: "annullamento", versione: 5, evento: primo.evento })).rejects.toMatchObject({ status: 409 });
    await evento({ tipo: "annullamento", versione: 5, evento: secondo.evento });
    expect((await corsa(C4)).esito).toBe("effettuata");
    await evento({ tipo: "annullamento", versione: 6, evento: primo.evento });
    expect((await corsa(C4)).esito).toBeNull();
  });

  it("un'aggiunta dalla candidata dell'AVM, una volta sola; annullata sparisce", async () => {
    const v = await versione();
    const r = await evento({ tipo: "aggiunta", versione: v, tipoAggiunta: "bis", linea: "130", partenza: "13:05", candidata: "g45-fuori", kmEff: 9.5 });
    const aggiunta = (await leggiGiornata(GIORNO))!.elenco.find((c: any) => c.origine === "aggiunta") as any;
    expect(aggiunta).toMatchObject({ tipoAggiunta: "bis", esito: "effettuata", numero: "489160", vettura: "304", kmEff: 9.5, partenza: "13:05:00" });
    await expect(evento({ tipo: "aggiunta", versione: v + 1, tipoAggiunta: "bis", linea: "130", partenza: "13:05", candidata: "g45-fuori" }))
      .rejects.toMatchObject({ status: 409, message: "Questa candidata è già stata aggiunta" });
    await evento({ tipo: "annullamento", versione: v + 1, evento: r.evento });
    expect((await leggiGiornata(GIORNO))!.elenco.some((c: any) => c.origine === "aggiunta")).toBe(false);
  });

  it("una nota non cambia la versione; il giornale dice chi, quando, cosa", async () => {
    const v = await versione();
    expect((await evento({ tipo: "nota", versione: v, nota: "Deviazione per lavori", chiavi: [C3] })).versione).toBe(v);
    const giornale = await leggiGiornale(GIORNO);
    expect(giornale[0]).toMatchObject({ tipo: "nota", autore: "Ufficio movimento di prova", fonte: "movimento", corse: 1, dati: { nota: "Deviazione per lavori" } });
    // lo stato «prima» resta nel database ma non si manda alla pagina
    expect(giornale.find((e) => e.tipo === "conferma")!.dati).not.toHaveProperty("prima");
    expect(giornale.find((e) => e.tipo === "conferma")!.annullatoDa).not.toBeNull();
  });

  it("l'annullamento dell'AVM: un evento del sistema una volta per corsa, e un indizio di soppressione nella proposta", async () => {
    const quando = new Date(`${GIORNO}T10:00:00Z`);
    expect(await registraCancellazioneAvm({ tripId: C2, journeyRef: "j-c2", vehicleRef: "301" }, quando)).toBe(true);
    expect(await registraCancellazioneAvm({ tripId: C2, journeyRef: "j-c2", vehicleRef: "301" }, quando)).toBe(false);
    // una giornata che non c'è: niente, e nessun errore
    expect(await registraCancellazioneAvm({ tripId: C2, journeyRef: null, vehicleRef: null }, new Date("2030-01-01T10:00:00Z"))).toBe(false);
    const ev = (await leggiGiornale(GIORNO)).find((e) => e.tipo === "cancellazione_avm")!;
    expect(ev).toMatchObject({ fonte: "avm", autore: null, esempi: [C2] });
    await calcolaProposta(GIORNO);
    expect(await corsa(C2)).toMatchObject({ proposta: "soppressione_indizio", prove: { motivo: "annullata dall'AVM" } });
  });

  it("dall'API: la giornata col giornale e le causali; gli eventi; un token di servizio non scrive", async () => {
    const op = appDiProva(esercizioRouter, utenteDiProva(OPERATORE, [], "user", { ruoli: ["centrale_operativa"] }));
    const g = await request(op).get(`/api/esercizio/giornate/${GIORNO}`);
    expect(g.status).toBe(200);
    expect(g.body.causali.map((c: any) => c.codice)).toContain("SCIOPERO");
    expect(g.body.giornale.length).toBeGreaterThan(5);
    const v = g.body.versione;
    const r = await request(op).post(`/api/esercizio/giornate/${GIORNO}/eventi`).send({ tipo: "esito", versione: v, chiavi: [C1], esito: "effettuata" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await request(op).post(`/api/esercizio/giornate/${GIORNO}/eventi`).send({ tipo: "esito", versione: v, chiavi: [C1], esito: "effettuata" })).status).toBe(409);
    expect((await request(op).post(`/api/esercizio/giornate/${GIORNO}/eventi`).send({ tipo: "esito", versione: v + 1, chiavi: [C1], esito: "soppressa" })).status).toBe(400);
    expect((await request(op).post(`/api/esercizio/giornate/2026-04-31/eventi`).send({})).status).toBe(400);
    // un token di servizio (Argos) legge ma non scrive
    const servizio = express();
    servizio.use(express.json());
    servizio.use((req: any, _res, next) => { req.user = utenteDiProva(OPERATORE, [], "user", { ruoli: ["centrale_operativa"] }); req.authVia = "argos"; req.log = { error() {} }; next(); });
    servizio.use("/api", esercizioRouter);
    expect((await request(servizio).get(`/api/esercizio/giornate/${GIORNO}`)).status).toBe(200);
    expect((await request(servizio).post(`/api/esercizio/giornate/${GIORNO}/eventi`).send({ tipo: "nota", versione: 0, nota: "x" })).status).toBe(403);
  });

  it("una giornata non cominciata non ha giornale", async () => {
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse) VALUES ('2026-04-08', 'preparata', 0) ON CONFLICT DO NOTHING`);
    try {
      await expect(registraEvento("2026-04-08", { tipo: "nota", versione: 0, fonte: "movimento", chiavi: [], nota: "x" }, AUTORE)).rejects.toBeInstanceOf(RifiutoGiornale);
    } finally {
      await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = '2026-04-08'`);
    }
  });
});
