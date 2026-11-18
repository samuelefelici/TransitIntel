/**
 * Il parco dell'azienda nel canale dell'AVM come dato dell'azienda (tappa
 * 6.21), su un database vero (TEST_DATABASE_URL, migrato: in CI il job
 * migrazioni-postgres).
 *
 * Prima l'anagrafica dei mezzi, i prefissi delle consorziate e le eccezioni
 * erano scritti nel codice (lib/parco-anagrafica.ts); ora stanno in tre
 * tabelle che l'amministratore scrive da Amministrazione › Azienda. Qui: le
 * rotte, chi può usarle, l'import tutto o niente, e che le regole in memoria
 * (quelle che usano diario, stato del parco e report) seguano subito.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/admin";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { codiceDaSiri, identitaVettura, siriDaCodice, impostaParco, PARCO_NEUTRO } from "../lib/parco-anagrafica";
import { dimenticaAzienda, leggiAzienda } from "../lib/azienda";
import { impostaRegolaVetture, REGOLA_NEUTRA } from "../lib/vetture-azienda";

const ADMIN = "c6210000-0000-0000-0000-000000000001";
const admin = appDiProva(router, utenteDiProva(ADMIN, [], "admin"));
const operatore = appDiProva(router, utenteDiProva("c6210000-0000-0000-0000-000000000002", ["centrale"]));

const EXPORT = "Codice veicolo\tDescrizione veicolo\n263\tUrbano =11<15m BredaMenarinibus M240 GNC\nXY007\tInterurbano =11<15m Iveco Crossway\nXY007\tdoppione\nQZ001\tUrbano <7,5m Altro\n";

/* La regola delle vetture dell'azienda (fino a quattro cifre) è un altro dato, la riga dell'azienda
 * (tappa 6.5): ogni rilettura la rimette com'è nel database di prova, quindi la si dichiara prima di guardare. */
const regola = () => impostaRegolaVetture({ cifre: 4, nome: "Prova" });

const tabelle = async () => ((await db.execute<any>(sql`
  SELECT (SELECT count(*) FROM parco_vetture)::int AS v, (SELECT count(*) FROM parco_consorziate)::int AS c,
         (SELECT count(*) FROM parco_eccezioni)::int AS e`)) as any).rows[0];

describe.runIf(!!process.env.TEST_DATABASE_URL)("il parco dell'azienda, sul database", () => {
  let prima: { v: any[]; c: any[]; e: any[] } = { v: [], c: [], e: [] };

  beforeAll(async () => {
    /* una copia di quello che c'è (vuoto in CI): si rimette alla fine */
    prima = {
      v: ((await db.execute<any>(sql`SELECT codice, descrizione, ordine FROM parco_vetture`)) as any).rows,
      c: ((await db.execute<any>(sql`SELECT prefisso, sigle, a_progressivo, ordine FROM parco_consorziate`)) as any).rows,
      e: ((await db.execute<any>(sql`SELECT siri_ref, codice, nota FROM parco_eccezioni`)) as any).rows,
    };
    await db.execute(sql`DELETE FROM parco_vetture`);
    await db.execute(sql`DELETE FROM parco_consorziate`);
    await db.execute(sql`DELETE FROM parco_eccezioni`);
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name)
      VALUES (${ADMIN}::uuid, 'ammin-6.21@prova.local', 'x', 'admin', 'Ada Parco') ON CONFLICT (id) DO NOTHING`);
    impostaRegolaVetture({ cifre: 4, nome: "Prova" });
    dimenticaAzienda();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM parco_vetture`);
    await db.execute(sql`DELETE FROM parco_consorziate`);
    await db.execute(sql`DELETE FROM parco_eccezioni`);
    for (const r of prima.v) await db.execute(sql`INSERT INTO parco_vetture (codice, descrizione, ordine) VALUES (${r.codice}, ${r.descrizione}, ${r.ordine})`);
    for (const r of prima.c) await db.execute(sql`INSERT INTO parco_consorziate (prefisso, sigle, a_progressivo, ordine) VALUES (${r.prefisso}, ${`{${r.sigle.join(",")}}`}::text[], ${r.a_progressivo}, ${r.ordine})`);
    for (const r of prima.e) await db.execute(sql`INSERT INTO parco_eccezioni (siri_ref, codice, nota) VALUES (${r.siri_ref}, ${r.codice}, ${r.nota})`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
    impostaParco(PARCO_NEUTRO);
    impostaRegolaVetture(REGOLA_NEUTRA);
    dimenticaAzienda();
    await pool.end();
  });

  it("chi non è amministratore non legge e non scrive", async () => {
    expect((await request(operatore).get("/api/admin/parco")).status).toBe(403);
    expect((await request(operatore).put("/api/admin/parco/vetture").send({ testo: EXPORT })).status).toBe(403);
    expect((await request(operatore).put("/api/admin/parco/consorziate").send({ consorziate: [], eccezioni: [] })).status).toBe(403);
    expect(await tabelle()).toEqual({ v: 0, c: 0, e: 0 });
  });

  it("l'import dell'anagrafica: intestazione saltata, doppione fuori, chi e quando", async () => {
    const r = await request(admin).put("/api/admin/parco/vetture").send({ testo: EXPORT });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ importate: 3, doppie: 1, vetture: 3, importataDa: "Ada Parco" });
    expect(r.body.sigleSenzaPrefisso).toEqual(["QZ", "XY"]);
    const tsv = await request(admin).get("/api/admin/parco/vetture.tsv");
    expect(tsv.status).toBe(200);
    expect(tsv.text).toBe("Codice veicolo\tDescrizione veicolo\r\n263\tUrbano =11<15m BredaMenarinibus M240 GNC\r\nXY007\tInterurbano =11<15m Iveco Crossway\r\nQZ001\tUrbano <7,5m Altro\r\n");
    /* le regole in memoria seguono subito: la vettura dell'azienda ha la sua descrizione */
    regola();
    expect(identitaVettura("263")).toEqual({ codice: "263", azienda: "Prova", mezzo: "Urbano =11<15m BredaMenarinibus M240 GNC" });
  });

  it("un export che non va non tocca l'anagrafica", async () => {
    const r = await request(admin).put("/api/admin/parco/vetture").send({ testo: "263\tA\nuno due\tB\n" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/riga 2: il codice «uno due» non va/);
    expect((await tabelle()).v).toBe(3);
    expect((await request(admin).put("/api/admin/parco/vetture").send({})).status).toBe(400);
  });

  it("prefissi ed eccezioni: si salvano insieme e le pagine dell'AVM li usano subito", async () => {
    const r = await request(admin).put("/api/admin/parco/consorziate").send({
      consorziate: [{ prefisso: "21", sigle: ["xy"], aProgressivo: true }, { prefisso: "25", sigle: ["QZ"], aProgressivo: false }],
      eccezioni: [{ siriRef: "25009", codice: "qz001", nota: "abbinata a mano" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.consorziate).toEqual([{ prefisso: "21", sigle: ["XY"], aProgressivo: true }, { prefisso: "25", sigle: ["QZ"], aProgressivo: false }]);
    expect(r.body.eccezioni).toEqual([{ siriRef: "25009", codice: "QZ001", nota: "abbinata a mano" }]);
    expect(r.body.sigleSenzaPrefisso).toEqual([]);
    regola();
    expect(codiceDaSiri("21007")).toBe("XY007");
    expect(identitaVettura("21007")).toEqual({ codice: "XY007", azienda: "XY", mezzo: "Interurbano =11<15m Iveco Crossway" });
    expect(codiceDaSiri("25009")).toBe("QZ001");
    expect(siriDaCodice("QZ001")).toBe("25009");
    expect(codiceDaSiri("25001")).toBeNull();
    /* e restano così anche dopo una lettura dal database (al minuto dopo, o in un altro processo) */
    dimenticaAzienda();
    await leggiAzienda();
    regola();
    expect(codiceDaSiri("21007")).toBe("XY007");
  });

  it("regole che non vanno: 400 con la riga, e niente cambia", async () => {
    const r = await request(admin).put("/api/admin/parco/consorziate").send({
      consorziate: [{ prefisso: "21", sigle: ["XY"], aProgressivo: true }, { prefisso: "22", sigle: ["XY"], aProgressivo: true }, { prefisso: "2", sigle: [], aProgressivo: true }],
      eccezioni: [{ siriRef: "abc", codice: "X", nota: "" }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Prefissi, riga 2 \(sigle\): la sigla XY è già del prefisso 21/);
    expect(r.body.error).toMatch(/Prefissi, riga 3 \(prefisso\): due cifre/);
    expect((await request(admin).put("/api/admin/parco/consorziate").send({ consorziate: [], eccezioni: [], altro: 1 })).status).toBe(400);
    expect(await tabelle()).toMatchObject({ c: 2, e: 1 });
  });
});
