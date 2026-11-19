/**
 * Le reti dell'azienda e le regole delle linee (tappa 6.7, migrazione 0040),
 * su un database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * L'amministratore crea, cambia e toglie le reti urbane e scrive le regole;
 * quello che salva entra in vigore subito, e la classificazione delle linee
 * lo segue. Una rete in uso non si toglie; l'extraurbano c'è sempre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { dimenticaAzienda, leggiAzienda } from "../lib/azienda";
import { classifyRoute, corrispettivoSuiVuoti, idRetiUrbane, impostaReti, RETI_NEUTRE, retiInVigore, reteUrbana, servizioDellaLinea } from "../lib/reti-linee";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const admin = request(appDiProva(adminRouter, utenteDiProva("e6700000-0000-4000-8000-000000000001", [], "admin")));
const utente = request(appDiProva(adminRouter, utenteDiProva("e6700000-0000-4000-8000-000000000002", ["fares"])));
const F = "e6700000-0000-4000-8000-0000000000f1";
const P = "e6700000-0000-4000-8000-0000000000a1";
const ADMIN = "e6700000-0000-4000-8000-000000000001";

async function pulisciProve() {
  await db.execute(sql`DELETE FROM gtfs_route_networks WHERE feed_id = ${F}::uuid`);
  await db.execute(sql`DELETE FROM gtfs_fare_networks WHERE feed_id = ${F}::uuid`);
  await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${F}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("le reti dell'azienda, sul database", () => {
  let retiDiPrima: unknown[] = [];
  let regoleDiPrima: unknown[] = [];

  beforeAll(async () => {
    retiDiPrima = (await db.execute<any>(sql`SELECT to_jsonb(r) AS riga FROM reti r`)).rows.map((r) => r.riga);
    regoleDiPrima = (await db.execute<any>(sql`SELECT to_jsonb(g) AS riga FROM reti_regole g`)).rows.map((r) => r.riga);
    await pulisciProve();
    /* si parte come un'installazione nuova: il solo extraurbano, nessuna regola */
    await db.execute(sql`DELETE FROM reti WHERE rete <> 'extraurbano'`);
    await db.execute(sql`UPDATE reti SET nome = 'Extraurbano', colore = '#f59e0b', ordine = 1, corrispettivo_km = NULL, corrispettivo_su_vuoti = false
                          WHERE rete = 'extraurbano'`);
    dimenticaAzienda();
  });

  afterAll(async () => {
    await pulisciProve();
    await db.execute(sql`DELETE FROM reti_regole`);
    await db.execute(sql`DELETE FROM reti`);
    for (const riga of retiDiPrima) {
      await db.execute(sql`INSERT INTO reti SELECT * FROM jsonb_populate_record(NULL::reti, ${JSON.stringify(riga)}::jsonb)`);
    }
    for (const riga of regoleDiPrima) {
      await db.execute(sql`INSERT INTO reti_regole SELECT * FROM jsonb_populate_record(NULL::reti_regole, ${JSON.stringify(riga)}::jsonb)`);
    }
    dimenticaAzienda();
    impostaReti(RETI_NEUTRE);
    await pool.end();
  });

  it("un'installazione nuova ha il solo extraurbano: ogni linea è extraurbana", async () => {
    const r = await admin.get("/api/admin/reti");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reti.map((x: any) => [x.rete, x.tipo, x.nome])).toEqual([["extraurbano", "extraurbano", "Extraurbano"]]);
    expect(r.body.regole).toEqual([]);
    expect([r.body.massimoRetiUrbane, r.body.massimoRegole]).toEqual([8, 100]);
    await leggiAzienda();
    expect(idRetiUrbane()).toEqual([]);
    expect(servizioDellaLinea("41")).toBe("extraurbano");
  });

  it("le legge e le scrive solo l'amministratore", async () => {
    expect((await utente.get("/api/admin/reti")).status).toBe(403);
    expect((await utente.post("/api/admin/reti").send({ luogo: "Pesaro", sigla: "PS" })).status).toBe(403);
    expect((await utente.put("/api/admin/reti/regole").send({ regole: [] })).status).toBe(403);
    expect((await utente.delete("/api/admin/reti/urbano_pesaro")).status).toBe(403);
  });

  it("crea una rete urbana: identificativo, zona e codice li ricava il programma, ed entra in vigore subito", async () => {
    const r = await admin.post("/api/admin/reti").send({ luogo: "Pesaro", sigla: "ps" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.rete).toMatchObject({
      rete: "urbano_pesaro", tipo: "urbano", nome: "Urbano di Pesaro", luogo: "Pesaro", sigla: "PS",
      zona: "pesaro_urban", codice: 2, colore: "#3b82f6", ordine: 2,
    });
    expect(reteUrbana("urbano_pesaro")).toMatchObject({ zona: "pesaro_urban", codice: 2, codiceMisto: 12 });

    const fano = await admin.post("/api/admin/reti").send({ luogo: "Fano Città", nome: "Rete di Fano", sigla: "FA", colore: "#112233", ordine: 5 });
    expect(fano.status, JSON.stringify(fano.body)).toBe(201);
    expect(fano.body.rete).toMatchObject({ rete: "urbano_fano_citta", zona: "fano_citta_urban", nome: "Rete di Fano", codice: 3, colore: "#112233", ordine: 5 });
    expect(idRetiUrbane()).toEqual(["urbano_pesaro", "urbano_fano_citta"]);
  });

  it("rifiuta una rete già scritta, una sigla già presa e i valori storti, dicendo quale", async () => {
    const stessa = await admin.post("/api/admin/reti").send({ luogo: "pesaro", sigla: "PE" });
    expect([stessa.status, stessa.body.error]).toEqual([409, "C'è già una rete urbana di pesaro"]);
    const sigla = await admin.post("/api/admin/reti").send({ luogo: "Urbino", sigla: "PS" });
    expect([sigla.status, sigla.body.error]).toEqual([409, "La sigla PS è già della rete «Urbano di Pesaro»"]);
    for (const [corpo, campo] of [
      [{ luogo: "", sigla: "UR" }, /luogo/], [{ luogo: "Urbino", sigla: "TROPPA" }, /sigla/], [{ luogo: "Urbino", sigla: "UR", colore: "rosso" }, /colore/],
      [{ luogo: "Urbino", sigla: "UR", rete: "urbano_x" }, /rete/], [{ luogo: "...", sigla: "UR" }, /luogo/],
      /* il nome e il luogo finiscono nei file del GTFS: niente virgolette, virgole, a capo o segni di minore e maggiore */
      [{ luogo: 'Urbino "alta"', sigla: "UR" }, /luogo: solo lettere/], [{ luogo: "Urbino", sigla: "UR", nome: "Urbano, di Urbino" }, /nome: solo lettere/],
      [{ luogo: "Urbino\nx", sigla: "UR" }, /luogo: solo lettere/], [{ luogo: "Urbino", sigla: "UR", nome: "<b>Urbino</b>" }, /nome: solo lettere/],
    ] as const) {
      const r = await admin.post("/api/admin/reti").send(corpo);
      expect(r.status, JSON.stringify(corpo)).toBe(400);
      expect(r.body.error, JSON.stringify(corpo)).toMatch(campo);
    }
    expect(idRetiUrbane()).toEqual(["urbano_pesaro", "urbano_fano_citta"]);
  });

  it("cambia nome, luogo, sigla, colore e ordine; l'identificativo, la zona e il codice restano", async () => {
    const r = await admin.put("/api/admin/reti/urbano_fano_citta").send({ nome: "Urbano di Fano", luogo: "Fano", sigla: "FN", colore: "#8B5CF6", ordine: 3 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rete).toMatchObject({ rete: "urbano_fano_citta", zona: "fano_citta_urban", codice: 3, nome: "Urbano di Fano", luogo: "Fano", sigla: "FN", colore: "#8b5cf6", ordine: 3 });
    expect(reteUrbana("urbano_fano_citta")).toMatchObject({ luogo: "Fano", sigla: "FN" });
    const presa = await admin.put("/api/admin/reti/urbano_fano_citta").send({ sigla: "PS" });
    expect(presa.status).toBe(409);
    expect((await admin.put("/api/admin/reti/urbano_nessuna").send({ nome: "X" })).status).toBe(404);
    expect((await admin.put("/api/admin/reti/urbano_fano_citta").send({ codice: 9 })).status).toBe(400);
  });

  it("dell'extraurbano si cambiano il nome, il colore e l'ordine, non il resto", async () => {
    const r = await admin.put("/api/admin/reti/extraurbano").send({ nome: "Extraurbano Provincia di Pesaro e Urbino", ordine: 9 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(retiInVigore().reti.at(-1)).toMatchObject({ rete: "extraurbano", nome: "Extraurbano Provincia di Pesaro e Urbino" });
    const no = await admin.put("/api/admin/reti/extraurbano").send({ sigla: "EX" });
    expect([no.status, no.body.error]).toEqual([400, "L'extraurbano non ha un luogo né una sigla: si cambiano il nome, il colore, l'ordine e il corrispettivo"]);
    const via = await admin.delete("/api/admin/reti/extraurbano");
    expect([via.status, via.body.error]).toEqual([409, "L'extraurbano c'è sempre: non si toglie"]);
  });

  it("il corrispettivo €/km e la spunta dei km a vuoto (tappa 6.29): si salvano, vanno in vigore, null li toglie", async () => {
    expect(retiInVigore().reti.find((r) => r.rete === "extraurbano")).toMatchObject({ corrispettivoKm: null, corrispettivoSuVuoti: false });
    expect(corrispettivoSuiVuoti("A")).toBe(0);
    const r = await admin.put("/api/admin/reti/extraurbano").send({ corrispettivoKm: 1.84, corrispettivoSuVuoti: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rete).toMatchObject({ corrispettivoKm: 1.84, corrispettivoSuVuoti: true });
    expect(corrispettivoSuiVuoti("A")).toBe(1.84);
    /* una modifica che non parla del corrispettivo lo lascia com'è */
    expect((await admin.put("/api/admin/reti/extraurbano").send({ ordine: 8 })).body.rete).toMatchObject({ corrispettivoKm: 1.84, corrispettivoSuVuoti: true });
    /* senza la spunta, sui vuoti non si incassa: costano per intero */
    await admin.put("/api/admin/reti/extraurbano").send({ corrispettivoSuVuoti: false });
    expect(corrispettivoSuiVuoti("A")).toBe(0);
    const fano = await admin.put("/api/admin/reti/urbano_fano_citta").send({ corrispettivoKm: 1.69 });
    expect(fano.body.rete).toMatchObject({ corrispettivoKm: 1.69, corrispettivoSuVuoti: false });
    const [riga] = (await db.execute<any>(sql`SELECT corrispettivo_km::text AS km, corrispettivo_su_vuoti AS vuoti FROM reti WHERE rete = 'urbano_fano_citta'`)).rows;
    expect(riga).toEqual({ km: "1.69", vuoti: false });
    for (const no of [1.234, -1, 100, "2,6"]) {
      const x = await admin.put("/api/admin/reti/urbano_fano_citta").send({ corrispettivoKm: no });
      expect(x.status, String(no)).toBe(400);
    }
    expect((await admin.put("/api/admin/reti/urbano_fano_citta").send({ corrispettivoKm: null })).body.rete).toMatchObject({ corrispettivoKm: null });
    /* anche il database rifiuta un valore fuori misura */
    const err = await db.execute(sql`UPDATE reti SET corrispettivo_km = 100 WHERE rete = 'extraurbano'`).then(() => null, (e: any) => String(e?.code ?? e?.cause?.code));
    expect(err).toBe("23514");
    await admin.put("/api/admin/reti/extraurbano").send({ corrispettivoKm: null });
  });

  const REGOLE = [
    { tipo: "inizia", valore: "pe", rete: "urbano_pesaro" },
    { tipo: "uguale", valore: "9X", rete: "extraurbano" },
    { tipo: "inizia_con_cifra", rete: "urbano_fano_citta" },
    { tipo: "inizia_poi_cifra", valore: "F", rete: "urbano_fano_citta" },
  ];

  it("salva le regole in ordine, e la classificazione delle linee le segue subito", async () => {
    const r = await admin.put("/api/admin/reti/regole").send({ regole: REGOLE });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.regole).toEqual([
      { tipo: "inizia", valore: "PE", rete: "urbano_pesaro" },
      { tipo: "uguale", valore: "9X", rete: "extraurbano" },
      { tipo: "inizia_con_cifra", valore: null, rete: "urbano_fano_citta" },
      { tipo: "inizia_poi_cifra", valore: "F", rete: "urbano_fano_citta" },
    ]);
    expect(["PE1", "pe 2", "9X", "9", "F3", "FA", "A"].map((l) => classifyRoute(l)))
      .toEqual(["urbano_pesaro", "urbano_pesaro", "extraurbano", "urbano_fano_citta", "urbano_fano_citta", "extraurbano", "extraurbano"]);
    expect([servizioDellaLinea("9"), servizioDellaLinea("9X")]).toEqual(["urbano", "extraurbano"]);
    const righe = (await db.execute<any>(sql`SELECT ordine, tipo, valore, rete FROM reti_regole ORDER BY ordine`)).rows;
    expect(righe.map((g) => g.ordine)).toEqual([1, 2, 3, 4]);
    /* un altro processo le trova al giro dopo: qui si rilegge l'azienda */
    impostaReti(RETI_NEUTRE);
    dimenticaAzienda();
    await leggiAzienda();
    expect(classifyRoute("PE1")).toBe("urbano_pesaro");
  });

  it("rifiuta le regole che non stanno in piedi, dicendo quale", async () => {
    for (const [regole, motivo] of [
      [[{ tipo: "inizia", rete: "urbano_pesaro" }], "regola 1: manca il valore"],
      [[{ tipo: "inizia_con_cifra", valore: "9", rete: "urbano_pesaro" }], "regola 1: questo tipo di regola non ha un valore"],
      [[{ tipo: "uguale", valore: "A", rete: "urbano_altrove" }], "regola 1: la rete «urbano_altrove» non c'è"],
      [[{ tipo: "uguale", valore: "A", rete: "extraurbano" }, { tipo: "uguale", valore: "a", rete: "urbano_pesaro" }], "regola 2: è scritta due volte (è A); vale solo la prima"],
    ] as const) {
      const r = await admin.put("/api/admin/reti/regole").send({ regole });
      expect([r.status, r.body.error], motivo).toEqual([400, motivo]);
    }
    for (const regole of [[{ tipo: "somiglia", valore: "A", rete: "extraurbano" }], [{ tipo: "uguale", valore: "A;DROP", rete: "extraurbano" }], [{ tipo: "uguale", valore: "TREDICICARATT", rete: "extraurbano" }]]) {
      expect((await admin.put("/api/admin/reti/regole").send({ regole })).status, JSON.stringify(regole)).toBe(400);
    }
    expect((await admin.put("/api/admin/reti/regole").send({ regole: Array.from({ length: 101 }, (_, i) => ({ tipo: "uguale", valore: `L${i}`, rete: "extraurbano" })) })).status).toBe(400);
    /* niente è cambiato */
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM reti_regole`)).rows[0].n).toBe(4);
  });

  it("l'anteprima dice quali linee cambierebbero rete, senza scrivere niente", async () => {
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'reti@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Programma reti 6.7')`);
    for (const linea of ["PE7", "9", "9X", "F3", "ZQ1"]) {
      await db.execute(sql`INSERT INTO ps_routes (project_id, short_name) VALUES (${P}::uuid, ${linea})`);
    }
    /* proposta: le linee che cominciano con una cifra diventano di Pesaro, e nasce una regola per ZQ */
    const proposte = [
      { tipo: "inizia", valore: "PE", rete: "urbano_pesaro" },
      { tipo: "inizia_con_cifra", rete: "urbano_pesaro" },
      { tipo: "inizia", valore: "ZQ", rete: "urbano_fano_citta" },
    ];
    const r = await admin.post("/api/admin/reti/regole/anteprima").send({ regole: proposte });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(["esercizio", "planning"]).toContain(r.body.fonte);
    const mie = new Set(["PE7", "9", "9X", "F3", "ZQ1"]);
    if (r.body.fonte === "planning") {
      expect(r.body.cambiano.filter((c: any) => mie.has(c.linea))).toEqual([
        { linea: "9", da: "urbano_fano_citta", a: "urbano_pesaro", cambiaServizio: false },
        { linea: "9X", da: "extraurbano", a: "urbano_pesaro", cambiaServizio: true },
        { linea: "F3", da: "urbano_fano_citta", a: "extraurbano", cambiaServizio: true },
        { linea: "ZQ1", da: "extraurbano", a: "urbano_fano_citta", cambiaServizio: true },
      ]);
      expect(r.body.linee).toBeGreaterThanOrEqual(5);
    }
    /* le regole in vigore sono quelle di prima */
    expect(classifyRoute("9")).toBe("urbano_fano_citta");
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM reti_regole`)).rows[0].n).toBe(4);
    const storta = await admin.post("/api/admin/reti/regole/anteprima").send({ regole: [{ tipo: "inizia", rete: "urbano_pesaro" }] });
    expect([storta.status, storta.body.error]).toEqual([400, "regola 1: manca il valore"]);
  });

  it("una rete in uso non si toglie, e il motivo dice chi la usa", async () => {
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename, is_active) VALUES (${F}::uuid, 'reti-6.7.synthetic', false)`);
    await db.execute(sql`INSERT INTO gtfs_route_networks (feed_id, route_id, network_id) VALUES (${F}::uuid, 'L1', 'urbano_pesaro'), (${F}::uuid, 'L2', 'urbano_pesaro')`);
    await db.execute(sql`INSERT INTO gtfs_fare_networks (feed_id, network_id, network_name) VALUES (${F}::uuid, 'urbano_fano_citta', 'Urbano di Fano')`);
    const elenco = await admin.get("/api/admin/reti");
    expect(elenco.body.reti.find((x: any) => x.rete === "urbano_pesaro").uso).toEqual({ linee: 2, titoli: 0, catalogo: 0, zone: 0, regoleTariffarie: 0, regole: 1 });
    const r = await admin.delete("/api/admin/reti/urbano_pesaro");
    expect([r.status, r.body.error]).toEqual([409, "La rete «Urbano di Pesaro» è in uso (2 linee assegnate): prima sposta o togli chi la usa, dalla pagina Tariffe e dal catalogo dei titoli"]);
    expect(reteUrbana("urbano_pesaro")).not.toBeNull();
  });

  it("una rete libera si toglie con le sue regole: le altre regole restano in fila, e le sue linee tornano extraurbane", async () => {
    const r = await admin.delete("/api/admin/reti/urbano_fano_citta");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ok: true, regoleTolte: 2 });
    expect(idRetiUrbane()).toEqual(["urbano_pesaro"]);
    expect((await db.execute<any>(sql`SELECT ordine, tipo, valore, rete FROM reti_regole ORDER BY ordine`)).rows).toEqual([
      { ordine: 1, tipo: "inizia", valore: "PE", rete: "urbano_pesaro" },
      { ordine: 2, tipo: "uguale", valore: "9X", rete: "extraurbano" },
    ]);
    expect([classifyRoute("9"), classifyRoute("F3"), classifyRoute("PE1")]).toEqual(["extraurbano", "extraurbano", "urbano_pesaro"]);
    /* la sua voce nell'elenco delle reti del feed se n'è andata con lei */
    expect((await db.execute(sql`SELECT 1 FROM gtfs_fare_networks WHERE network_id = 'urbano_fano_citta'`)).rows).toEqual([]);
    expect((await admin.delete("/api/admin/reti/urbano_fano_citta")).status).toBe(404);
  });

  it("le reti urbane sono al più otto: la nona si rifiuta, e un codice liberato si riusa", async () => {
    const luoghi = ["Urbino", "Gabicce", "Cattolica", "Mondolfo", "Fossombrone", "Cagli", "Pergola"];
    for (const [i, luogo] of luoghi.entries()) {
      const r = await admin.post("/api/admin/reti").send({ luogo, sigla: `U${i}` });
      expect(r.status, `${luogo}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    /* Pesaro ha il 2; il 3 era di Fano, tolta: l'ha ripreso la prima rete nuova */
    expect([reteUrbana("urbano_urbino")!.codice, reteUrbana("urbano_pergola")!.codice]).toEqual([3, 9]);
    expect(new Set(idRetiUrbane().map((x) => reteUrbana(x)!.codice)).size).toBe(8);
    const nona = await admin.post("/api/admin/reti").send({ luogo: "Sassocorvaro", sigla: "SC" });
    expect(nona.status).toBe(409);
    expect(nona.body.error).toMatch(/già 8, il massimo/);
  });

  it("anche il database rifiuta un nome o un luogo con virgolette o virgole", async () => {
    for (const [colonna, valore] of [["nome", 'Urbano "x"'], ["nome", "Urbano, x"], ["luogo", "Pe<saro"], ["luogo", "Pe;saro"]] as const) {
      await expect(db.execute(sql`UPDATE reti SET ${sql.identifier(colonna)} = ${valore} WHERE rete = 'urbano_pesaro'`), `${colonna}: ${valore}`).rejects.toThrow();
    }
  });

  it("ogni modifica resta nel registro, coi valori", async () => {
    const stato = (await db.execute<any>(sql`SELECT registro.stato() AS st`)).rows[0].st;
    expect(stato.tabelle.map((t: any) => t.tabella ?? t)).toEqual(expect.arrayContaining(["public.reti", "public.reti_regole"]));
  });
});
