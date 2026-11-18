/**
 * La transcodifica delle paline dell'AVM come dato dell'azienda (tappa 6.20),
 * su un database vero (TEST_DATABASE_URL, migrato: in CI il job
 * migrazioni-postgres).
 *
 * Prima era un file dentro il codice; ora è la tabella transcodifica_paline,
 * che l'amministratore sostituisce per intero importando un CSV
 * (PUT /api/siri/fermate/transcodifica). Qui: l'import, o tutto o niente; chi
 * può farlo; le correzioni dell'operatore che restano sopra la tabella nuova;
 * e quello che la pagina legge (GET /api/siri/fermate/abbinamenti).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/siri";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { dimenticaTranscodifica, leggiBaseTranscodifica } from "../lib/transcodifica-paline";
import { transcodificaEffettiva } from "../lib/stop-aliases";
import { invalidaOverrides } from "../lib/stop-alias-overrides";

const ADMIN = "c6200000-0000-0000-0000-000000000001";
const UTENTE = "c6200000-0000-0000-0000-000000000002";
const admin = appDiProva(router, utenteDiProva(ADMIN, [], "admin"));
const operatore = appDiProva(router, utenteDiProva(UTENTE, ["centrale"]));

const CSV = `mizar_ref,stop_id,nome
1122,20045,ANCONA (Via Marconi Gas)
200,20001,"Piazza Cavour, lato mare"
461,20928,OSIMO (Capolinea)
5102,new_CT,FABRIANO (Via Dante)
200,99999,doppione
`;

const righe = async () => ((await db.execute<any>(sql`
  SELECT palina, stop_id, codice_file, nome, ordine, importata_da::text AS da FROM transcodifica_paline ORDER BY ordine`)) as any).rows;

describe.runIf(!!process.env.TEST_DATABASE_URL)("la transcodifica delle paline, sul database", () => {
  let prima: any[] = [];

  beforeAll(async () => {
    /* una copia di quello che c'è (vuota in CI): si rimette alla fine */
    prima = await righe();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name)
      VALUES (${ADMIN}::uuid, 'ammin-6.20@prova.local', 'x', 'admin', 'Ada Paline') ON CONFLICT (id) DO NOTHING`);
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM transcodifica_paline`);
    await db.execute(sql`DELETE FROM caronte.stop_alias_overrides WHERE mizar_ref IN ('461', '777')`);
    dimenticaTranscodifica();
    invalidaOverrides();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM transcodifica_paline`);
    await db.execute(sql`DELETE FROM caronte.stop_alias_overrides WHERE mizar_ref IN ('461', '777')`);
    for (const r of prima) {
      await db.execute(sql`INSERT INTO transcodifica_paline (palina, stop_id, codice_file, nome, ordine)
        VALUES (${r.palina}, ${r.stop_id}, ${r.codice_file}, ${r.nome}, ${r.ordine})`);
    }
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
    await pool.end();
  });

  it("l'amministratore importa: le righe nell'ordine, la palina senza codice a parte, il doppione fuori", async () => {
    const r = await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: CSV });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ righe: 4, conFermata: 3, senzaFermata: 1, doppie: 1 });
    expect(await righe()).toEqual([
      { palina: "1122", stop_id: "20045", codice_file: null, nome: "ANCONA (Via Marconi Gas)", ordine: 1, da: ADMIN },
      { palina: "200", stop_id: "20001", codice_file: null, nome: "Piazza Cavour, lato mare", ordine: 2, da: ADMIN },
      { palina: "461", stop_id: "20928", codice_file: null, nome: "OSIMO (Capolinea)", ordine: 3, da: ADMIN },
      { palina: "5102", stop_id: null, codice_file: "new_CT", nome: "FABRIANO (Via Dante)", ordine: 4, da: ADMIN },
    ]);
    const base = await leggiBaseTranscodifica(true);
    expect(base.righe.map((x) => [x.mizarRef, x.stopId, x.fonte])).toEqual([["1122", "20045", "azienda"], ["200", "20001", "azienda"], ["461", "20928", "azienda"]]);
    expect(base.scartate).toEqual([{ mizarRef: "5102", nome: "FABRIANO (Via Dante)", stopIdGrezzo: "new_CT", fonte: "azienda" }]);
    expect(base.importataDa).toBe("Ada Paline");
    expect(base.errore).toBeNull();
  });

  it("un import sostituisce tutta la tabella; le correzioni dell'operatore restano sopra", async () => {
    await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: CSV }).expect(200);
    await db.execute(sql`INSERT INTO caronte.stop_alias_overrides (mizar_ref, stop_id, nota, updated_by)
      VALUES ('461', '20999', 'banchina spostata', 'op@prova.local'), ('777', '20777', 'palina nuova', 'op@prova.local')`);
    invalidaOverrides();
    const r = await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: "461,20928,OSIMO\n300,20300,ALTRA\n" });
    expect(r.status).toBe(200);
    expect((await righe()).map((x: any) => x.palina)).toEqual(["461", "300"]);
    const t = await transcodificaEffettiva(true);
    expect(Object.fromEntries(t.righe.map((x) => [x.mizarRef, [x.stopId, x.fonte]]))).toEqual({
      "461": ["20999", "manuale"], "300": ["20300", "azienda"], "777": ["20777", "manuale"],
    });
  });

  it("un CSV che non va non tocca la tabella: 400, e il motivo con la riga", async () => {
    await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: CSV }).expect(200);
    const r = await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: "1,2,A\nuno due,3,B\n" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/riga 2: il codice palina «uno due» non va/);
    expect(await righe()).toHaveLength(4);
    expect((await request(admin).put("/api/siri/fermate/transcodifica").send({})).status).toBe(400);
    expect((await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: "mizar_ref,stop_id,nome\n" })).status).toBe(400);
    expect(await righe()).toHaveLength(4);
  });

  it("chi non è amministratore non importa: 403, e la tabella resta", async () => {
    const r = await request(operatore).put("/api/siri/fermate/transcodifica").send({ csv: CSV });
    expect(r.status).toBe(403);
    expect(await righe()).toHaveLength(0);
  });

  it("la pagina legge la tabella dell'azienda, con quando e chi l'ha importata", async () => {
    const vuota = await request(admin).get("/api/siri/fermate/abbinamenti");
    expect(vuota.status).toBe(200);
    expect(vuota.body.errore).toMatch(/vuota/);
    await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: CSV }).expect(200);
    const r = await request(admin).get("/api/siri/fermate/abbinamenti");
    expect(r.status).toBe(200);
    expect(r.body.errore).toBeNull();
    expect(r.body.importataDa).toBe("Ada Paline");
    expect(Date.parse(r.body.importataIl)).toBeGreaterThan(Date.now() - 60_000);
    expect(r.body.righe.map((x: any) => [x.mizarRef, x.fonte, x.stato])).toEqual(expect.arrayContaining([
      ["1122", "azienda", expect.any(String)], ["5102", "azienda", "senza_codice"],
    ]));
    /* l'esportazione si reimporta così com'è */
    const csv = await request(admin).get("/api/siri/fermate/transcodifica?formato=csv");
    expect(csv.status).toBe(200);
    expect(csv.text).toMatch(/^﻿mizar_ref,stop_id,nome,fonte,nota,utente/);
    const di = await request(admin).put("/api/siri/fermate/transcodifica").send({ csv: csv.text });
    expect(di.status).toBe(200);
    expect(di.body).toMatchObject({ righe: 4, conFermata: 3, senzaFermata: 1 });
  });
});
