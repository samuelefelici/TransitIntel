/**
 * La codifica dei turni guida come dato dell'azienda (tappa 6.25), su un
 * database vero (TEST_DATABASE_URL, migrato; in CI come cerbero_app).
 *
 * Prima il solver dei turni guida prendeva la lettera dall'iniziale del nome
 * del deposito e divideva mattino e pomeriggio a mezzogiorno. Ora la sigla è
 * del deposito (depots.sigla) e l'ora del pomeriggio dell'azienda
 * (azienda.turni_guida_pomeriggio_da); il solver le riceve in
 * config.codiciTurni (codificaTurniGuida).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import depotsRouter, { siglaDeposito } from "../routes/depots";
import { codificaTurniGuida, dimenticaAzienda, salvaAzienda } from "../lib/azienda";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const app = request(appDiProva(depotsRouter, utenteDiProva("e6250000-0000-4000-8000-000000000001", [], "admin")));
const AZIENDA = {
  ragioneSociale: "Trasporti Esempio S.r.l.", nome: "Esempio", sito: null, telefono: null, gtfsAgencyId: "esempio",
  citta: "Pesaro", regione: null, centroLat: 43.91, centroLng: 12.91, zoom: 11, provinciaIstat: null,
  netexCodiceLocale: null, netexFornitore: null, netexPrefisso: null, netexPrefissoCodici: null, netexCodiceRete: null,
  tariffeRiferimento: null, turniGuidaPomeriggioDa: 840, avmMatricolaCifre: null,
};

describe("la sigla di un deposito", () => {
  it("da 1 a 3 lettere o cifre, in maiuscolo; vuota vuol dire l'iniziale del nome", () => {
    expect(siglaDeposito(" an ")).toBe("AN");
    expect(siglaDeposito("C1")).toBe("C1");
    expect(siglaDeposito("")).toBeNull();
    expect(siglaDeposito(null)).toBeNull();
    for (const no of ["ABCD", "A-B", "à", 3]) expect(siglaDeposito(no), String(no)).toBeUndefined();
  });
});

describe.runIf(!!process.env.TEST_DATABASE_URL)("la codifica dei turni guida, sul database", () => {
  let aziendaPrima: any[] = [];
  const creati: string[] = [];
  beforeAll(async () => {
    aziendaPrima = (await db.execute<any>(sql`SELECT to_jsonb(a) AS riga FROM azienda a`)).rows.map((r) => r.riga);
    await db.execute(sql`DELETE FROM azienda`);
    dimenticaAzienda();
  });
  afterAll(async () => {
    for (const id of creati) await db.execute(sql`DELETE FROM depots WHERE id = ${id}::uuid`);
    await db.execute(sql`DELETE FROM azienda`);
    for (const r of aziendaPrima) await db.execute(sql`INSERT INTO azienda SELECT * FROM jsonb_populate_record(NULL::azienda, ${JSON.stringify(r)}::jsonb)`);
    dimenticaAzienda();
    await pool.end();
  });

  it("un'installazione senza azienda: una sola numerazione, e le iniziali", async () => {
    const c = await codificaTurniGuida();
    expect(c.pomeriggioDaMin).toBeNull();
  });

  it("le sigle dei depositi si scrivono dalle rotte dei depositi e arrivano al solver", async () => {
    const nord = await app.post("/api/depots").send({ name: "Deposito Nord", sigla: "n" });
    expect(nord.status).toBe(201);
    expect(nord.body.sigla).toBe("N");
    creati.push(nord.body.id);
    const nuovo = await app.post("/api/depots").send({ name: "Deposito Nuovo" });
    expect(nuovo.status).toBe(201);
    expect(nuovo.body.sigla).toBeNull();
    creati.push(nuovo.body.id);
    expect((await app.post("/api/depots").send({ name: "Altro", sigla: "ABCD" })).status).toBe(400);

    expect((await app.put(`/api/depots/${nuovo.body.id}`).send({ sigla: "nv" })).body.sigla).toBe("NV");
    expect((await app.put(`/api/depots/${nuovo.body.id}`).send({ sigla: "N V" })).status).toBe(400);
    const c = await codificaTurniGuida();
    expect(c.sigle[nord.body.id]).toBe("N");
    expect(c.sigle[nuovo.body.id]).toBe("NV");

    /* tolta la sigla, il deposito torna all'iniziale del nome: il solver non la riceve */
    expect((await app.put(`/api/depots/${nuovo.body.id}`).send({ sigla: "" })).body.sigla).toBeNull();
    expect((await codificaTurniGuida()).sigle[nuovo.body.id]).toBeUndefined();
    /* una PUT che non parla della sigla la lascia com'è */
    expect((await app.put(`/api/depots/${nord.body.id}`).send({ notes: "cancello sul retro" })).body.sigla).toBe("N");
  });

  it("l'ora del pomeriggio è quella salvata per l'azienda", async () => {
    await salvaAzienda(AZIENDA as any, null);
    expect((await codificaTurniGuida()).pomeriggioDaMin).toBe(840);
    /* il vincolo della tabella: un minuto del giorno */
    const err = await db.execute(sql`UPDATE azienda SET turni_guida_pomeriggio_da = 1440`).then(() => null, (e: any) => String(e?.code ?? e?.cause?.code));
    expect(err).toBe("23514");
    const sigla = await db.execute(sql`UPDATE depots SET sigla = 'ab' WHERE id = ${creati[0]}::uuid`).then(() => null, (e: any) => String(e?.code ?? e?.cause?.code));
    expect(sigla).toBe("23514");
  });
});
