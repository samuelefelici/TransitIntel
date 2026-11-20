/**
 * La polimetrica della bigliettazione, su un database vero (tappa 6.34a,
 * migrazione 0055; TEST_DATABASE_URL, in CI come cerbero_app).
 *
 * Si carica da due CSV, o tutti e due o niente; un caricamento nuovo
 * sostituisce il vecchio e lascia gli abbinamenti. Per ogni linea della
 * bigliettazione l'API propone la linea dell'import a cui corrisponde, e chi
 * lavora alle tariffe la conferma, la cambia o la esclude.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import router from "../routes/fares-polimetriche-ufficiale";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const CHI = "e6340000-0000-4000-8000-000000000001";
const IMPORT = "e6340000-0000-4000-8000-0000000000a1";
const tariffe = request(appDiProva(router, utenteDiProva(CHI, ["fares"])));

const PUNTI = `linea,percorso,direzione,ordine,codice,nome,nodo,km
d,0,1,1,3001,Borgo Alto,,0
d,0,1,2,3002,Ponte Nuovo,3900,5.1
d,0,1,3,3003,Molino,,6
d,0,2,1,3003,Molino,,0
d,0,2,2,3001,Borgo Alto,,6
900,0,1,1,x1,Fornace,,0
900,0,1,2,x2,Castello,,4
900,0,1,3,x3,Torre,,9.5
900,0,1,4,x4,Senza km,,
`;
const RIGHE = `linea,percorso,direzione,da,a,km,tariffario,fascia,forzata
D,0,1,3001,3900,5.100,EXT,1,false
D,0,1,3001,3003,6.000,EXT,1,false
D,0,1,3900,3003,0.900,EXT,3,true
900,0,1,x1,x3,9.5,EXT,2,false
SPEC,0,1,a,b,0,VUOTA,0,true
`;

/* un import della pagina Polimetriche con due linee: D (stessi codici dei punti) e V1 (stessi nomi) */
const fermata = (stopId: string, stopName: string) => ({ stopId, stopName, lat: 0, lon: 0, km: 0, distPrev: 0 });
const PAYLOAD = {
  agencyName: "Azienda di prova",
  lines: [
    { lineCode: "D", lineName: "Borgo Alto - Molino", routeIds: ["D"], percorsi: [{ variantId: "a", routeId: "D", stops: [fermata("3001", "Borgo Alto (capolinea)"), fermata("3002", "Ponte Nuovo"), fermata("3003", "Molino (bivio)")] }] },
    { lineCode: "V1", lineName: "Valle", routeIds: ["V1"], percorsi: [{ variantId: "b", routeId: "V1", stops: [fermata("5001", "Fornace"), fermata("5002", "Castello (piazza)"), fermata("5003", "Torre")] }] },
    { lineCode: "K", lineName: "Costa", routeIds: ["K"], percorsi: [{ variantId: "c", routeId: "K", stops: [fermata("6001", "Porto")] }] },
  ],
};

const carica = (punti: string, righe: string) => tariffe.post("/api/fares/polimetriche/ufficiale")
  .attach("punti", Buffer.from(punti), "punti tariffari.csv").attach("polimetrica", Buffer.from(righe), "polimetrica.csv");
const conta = async () => (await db.execute<any>(sql`
  SELECT (SELECT count(*) FROM polim_ufficiale_punti)::int AS punti, (SELECT count(*) FROM polim_ufficiale_righe)::int AS righe,
         (SELECT count(*) FROM polim_ufficiale_caricamento)::int AS caricamenti, (SELECT count(*) FROM polim_abbinamenti_linee)::int AS abbinamenti`)).rows[0];
const leggi = async () => (await tariffe.get(`/api/fares/polimetriche/ufficiale?importId=${IMPORT}`)).body;
const abbina = (abbinamenti: unknown[], importId: string = IMPORT) => tariffe.put("/api/fares/polimetriche/ufficiale/abbinamenti").send({ importId, abbinamenti });

describe.runIf(!!process.env.TEST_DATABASE_URL)("la polimetrica della bigliettazione, sul database", () => {
  const prima: Record<string, unknown[]> = {};
  const TABELLE = ["polim_ufficiale_punti", "polim_ufficiale_righe", "polim_ufficiale_caricamento", "polim_abbinamenti_linee"] as const;

  beforeAll(async () => {
    /* una copia di quello che c'è (vuoto in CI): si rimette alla fine */
    for (const t of TABELLE) {
      prima[t] = (await db.execute<any>(sql`SELECT to_jsonb(x) AS riga FROM ${sql.identifier(t)} x`)).rows.map((r) => r.riga);
      await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    }
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name)
      VALUES (${CHI}::uuid, 'tariffe-6.34@prova.local', 'x', 'user', 'Tea Tariffe') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO polim_imports (id, filename, agency_name, line_count, percorso_count, payload)
      VALUES (${IMPORT}::uuid, 'prova-6.34.zip', 'Azienda di prova', 3, 3, ${JSON.stringify(PAYLOAD)}::jsonb) ON CONFLICT (id) DO NOTHING`);
  });

  afterAll(async () => {
    for (const t of TABELLE) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
      for (const riga of prima[t] ?? []) {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(riga)}::jsonb)`);
      }
    }
    await db.execute(sql`DELETE FROM polim_imports WHERE id = ${IMPORT}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${CHI}::uuid`);
    await pool.end();
  });

  it("all'inizio non c'è niente: nessun caricamento, nessuna linea; le linee dell'import sono tutte senza corrispondenza", async () => {
    const r = await leggi();
    expect(r.caricamento).toBeNull();
    expect(r.linee).toEqual([]);
    expect(r.lineeAzienda).toEqual([{ codice: "D", nome: "Borgo Alto - Molino" }, { codice: "K", nome: "Costa" }, { codice: "V1", nome: "Valle" }]);
    expect(r.senzaUfficiale.map((l: any) => l.codice)).toEqual(["D", "K", "V1"]);
  });

  it("un file che non va ferma il caricamento e dice perché; non entra niente", async () => {
    const senza = await tariffe.post("/api/fares/polimetriche/ufficiale").attach("punti", Buffer.from(PUNTI), "p.csv");
    expect([senza.status, senza.body.error]).toEqual([400, "Servono due file CSV: i punti tariffari (campo «punti») e la polimetrica (campo «polimetrica»)."]);
    const storto = await carica(PUNTI, RIGHE.replace("EXT,2,false", "EXT,due,false"));
    expect([storto.status, storto.body.error]).toEqual([400, "Il file della polimetrica non va: riga 5: la fascia «due» non è un numero intero fra 0 e 999"]);
    const colonne = await carica("linea,ordine\nD,1\n", RIGHE);
    expect(colonne.status).toBe(400);
    expect(colonne.body.error).toMatch(/^Il file dei punti tariffari non va: mancano le colonne «percorso», «direzione», «codice», «km»/);
    expect(await conta()).toEqual({ punti: 0, righe: 0, caricamenti: 0, abbinamenti: 0 });
  });

  it("carica i due file: i punti coi loro km, le righe, chi e quando", async () => {
    const r = await carica(PUNTI, RIGHE);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ punti: 8, righe: 5, linee: 3, puntiSenzaKm: 1 });
    expect(await conta()).toEqual({ punti: 8, righe: 5, caricamenti: 1, abbinamenti: 0 });
    expect((await db.execute<any>(sql`SELECT linea, percorso, direzione, ordine, codice, nome, nodo, km::float8 AS km FROM polim_ufficiale_punti WHERE linea = 'D' AND direzione = '1' ORDER BY ordine`)).rows).toEqual([
      { linea: "D", percorso: "0", direzione: "1", ordine: 1, codice: "3001", nome: "Borgo Alto", nodo: null, km: 0 },
      { linea: "D", percorso: "0", direzione: "1", ordine: 2, codice: "3002", nome: "Ponte Nuovo", nodo: "3900", km: 5.1 },
      { linea: "D", percorso: "0", direzione: "1", ordine: 3, codice: "3003", nome: "Molino", nodo: null, km: 6 },
    ]);
    const c = (await leggi()).caricamento;
    expect(c).toMatchObject({ caricataDa: "Tea Tariffe", filePunti: "punti tariffari.csv", fileRighe: "polimetrica.csv", punti: 8, righe: 5 });
    expect(Date.now() - new Date(c.caricataIl).getTime()).toBeLessThan(60_000);
  });

  it("delle linee dice percorsi, punti, capolinea, righe e forzature; e propone la linea dell'import", async () => {
    const r = await leggi();
    expect(r.linee).toEqual([
      { linea: "900", percorsi: 1, punti: 3, da: "Fornace", a: "Torre", righe: 1, forzate: 0, tariffari: ["EXT"], abbinata: null, esclusa: false,
        candidate: [{ linea: "V1", trovati: 3 }], proposta: "V1", motivo: "punti" },
      { linea: "D", percorsi: 2, punti: 3, da: "Borgo Alto", a: "Molino", righe: 3, forzate: 1, tariffari: ["EXT"], abbinata: null, esclusa: false,
        candidate: [{ linea: "D", trovati: 3 }], proposta: "D", motivo: "codice" },
      /* una linea che ha solo righe (un servizio speciale): nessun punto, nessuna proposta */
      { linea: "SPEC", percorsi: 0, punti: 0, da: null, a: null, righe: 1, forzate: 1, tariffari: ["VUOTA"], abbinata: null, esclusa: false,
        candidate: [], proposta: null, motivo: null },
    ]);
    /* senza import non ci sono proposte */
    const senza = (await tariffe.get("/api/fares/polimetriche/ufficiale")).body;
    expect(senza.linee.map((l: any) => [l.linea, l.proposta])).toEqual([["900", null], ["D", null], ["SPEC", null]]);
    expect(senza.lineeAzienda).toEqual([]);
  });

  it("salva le decisioni: abbinata, esclusa, e di nuovo da abbinare", async () => {
    const r = await abbina([{ lineaUfficiale: "d", linea: "D", esclusa: false }, { lineaUfficiale: "900", linea: "V1", esclusa: false }, { lineaUfficiale: "SPEC", linea: null, esclusa: true }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await db.execute<any>(sql`SELECT linea_ufficiale, linea, esclusa, deciso_da::text AS da FROM polim_abbinamenti_linee ORDER BY 1`)).rows).toEqual([
      { linea_ufficiale: "900", linea: "V1", esclusa: false, da: CHI },
      { linea_ufficiale: "D", linea: "D", esclusa: false, da: CHI },
      { linea_ufficiale: "SPEC", linea: null, esclusa: true, da: CHI },
    ]);
    let letto = await leggi();
    expect(letto.linee.map((l: any) => [l.linea, l.abbinata, l.esclusa])).toEqual([["900", "V1", false], ["D", "D", false], ["SPEC", null, true]]);
    /* la linea K dell'import resta senza una linea della bigliettazione: è da creare là */
    expect(letto.senzaUfficiale).toEqual([{ codice: "K", nome: "Costa" }]);
    /* la 900 torna da abbinare, la SPEC diventa una linea */
    expect((await abbina([{ lineaUfficiale: "900", linea: null, esclusa: false }, { lineaUfficiale: "SPEC", linea: "K", esclusa: false }])).status).toBe(200);
    letto = await leggi();
    expect(letto.linee.map((l: any) => [l.linea, l.abbinata, l.esclusa])).toEqual([["900", null, false], ["D", "D", false], ["SPEC", "K", false]]);
    expect(letto.senzaUfficiale.map((l: any) => l.codice)).toEqual(["V1"]);
  });

  it("rifiuta una decisione che non sta in piedi, e non cambia niente", async () => {
    const prima = await conta();
    for (const [corpo, stato, errore] of [
      [[{ lineaUfficiale: "D", linea: "V1", esclusa: true }], 400, "Una linea è abbinata oppure esclusa, non tutte e due"],
      [[{ lineaUfficiale: "NONC'È", linea: "D", esclusa: false }], 400, "La linea «NONC'È» non è nella polimetrica caricata"],
      [[{ lineaUfficiale: "D", linea: "ZZ", esclusa: false }], 400, "La linea «ZZ» non è fra le linee dell'import"],
      [[{ lineaUfficiale: "D", linea: "D" }], 400, "Richiesta non valida: per ogni linea servono lineaUfficiale, linea (o null) ed esclusa"],
      [[{ lineaUfficiale: "D", linea: "D", esclusa: false, altro: 1 }], 400, "Richiesta non valida: per ogni linea servono lineaUfficiale, linea (o null) ed esclusa"],
      [[], 400, "Richiesta non valida: per ogni linea servono lineaUfficiale, linea (o null) ed esclusa"],
    ] as [unknown[], number, string][]) {
      const r = await abbina(corpo);
      expect([r.status, r.body.error], JSON.stringify(corpo)).toEqual([stato, errore]);
    }
    expect((await abbina([{ lineaUfficiale: "D", linea: "D", esclusa: false }], "e6340000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await abbina([{ lineaUfficiale: "D", linea: "D", esclusa: false }], "non-un-uuid")).status).toBe(400);
    expect((await tariffe.get("/api/fares/polimetriche/ufficiale?importId=x")).status).toBe(400);
    expect((await tariffe.get("/api/fares/polimetriche/ufficiale?importId=e6340000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect(await conta()).toEqual(prima);
  });

  it("un caricamento nuovo sostituisce il vecchio; gli abbinamenti restano", async () => {
    const r = await carica("linea;percorso;direzione;ordine;codice;nome;nodo;km\nD;0;1;1;3001;Borgo Alto;;0\nD;0;1;2;3003;Molino;;6,5\n",
      "linea;percorso;direzione;da;a;km;tariffario;fascia;forzata\nD;0;1;3001;3003;6,5;EXT;2;0\n");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ punti: 2, righe: 1, linee: 1, puntiSenzaKm: 0 });
    expect(await conta()).toEqual({ punti: 2, righe: 1, caricamenti: 1, abbinamenti: 2 });
    const letto = await leggi();
    expect(letto.linee.map((l: any) => [l.linea, l.punti, l.righe, l.abbinata])).toEqual([["D", 2, 1, "D"]]);
    expect((await db.execute<any>(sql`SELECT km::float8 AS km FROM polim_ufficiale_punti WHERE ordine = 2`)).rows).toEqual([{ km: 6.5 }]);
  });

  it("si toglie: restano solo gli abbinamenti, per il prossimo caricamento", async () => {
    expect((await tariffe.delete("/api/fares/polimetriche/ufficiale")).status).toBe(200);
    expect(await conta()).toEqual({ punti: 0, righe: 0, caricamenti: 0, abbinamenti: 2 });
    const letto = await leggi();
    expect([letto.caricamento, letto.linee]).toEqual([null, []]);
  });

  it("legge chi ha le tariffe; scrive chi può scriverle", () => {
    const tariffista = { admin: false, diritti: utenteDiProva(CHI, ["fares"]).diritti };
    const altro = { admin: false, diritti: utenteDiProva(CHI, ["roster"]).diritti };
    expect(decidi(tariffista, "GET", "/fares/polimetriche/ufficiale")).toEqual({ passa: true });
    expect(decidi(tariffista, "POST", "/fares/polimetriche/ufficiale")).toEqual({ passa: true });
    expect(decidi(tariffista, "PUT", "/fares/polimetriche/ufficiale/abbinamenti")).toEqual({ passa: true });
    for (const [m, p] of [["GET", "/fares/polimetriche/ufficiale"], ["POST", "/fares/polimetriche/ufficiale"], ["DELETE", "/fares/polimetriche/ufficiale"], ["PUT", "/fares/polimetriche/ufficiale/abbinamenti"]]) {
      expect(decidi(altro, m!, p!).passa, `${m} ${p}`).toBe(false);
    }
  });
});
