/**
 * Le tariffe nel GTFS consegnabile, su un database vero (tappa 6.37;
 * TEST_DATABASE_URL, in CI come cerbero_app).
 *
 * Un programma di Planning Studio inventato con una linea extraurbana, le
 * fasce, una categoria, un supporto, un titolo, e una polimetrica salvata su
 * un'altra fotografia dello stesso percorso. Le tariffe del GTFS prendono i
 * nodi dalla polimetrica salvata; l'impronta delle tariffe cambia con un
 * prezzo e con una polimetrica.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { improntaDelleTariffe, tariffeDelGtfs } from "../lib/gtfs-tariffe";
import type { Gtfs } from "../lib/gtfs-verifica";

const CHI = "e6370000-0000-4000-8000-000000000001";
const PROGETTO = "e6370000-0000-4000-8000-0000000000b1";
const LINEA = "e6370000-0000-4000-8000-0000000000c1";
const VA = "e6370000-0000-4000-8000-0000000000d1";
const FOTO = "e6370000-0000-4000-8000-0000000000a1";
const FERMATE = ["e6370000-0000-4000-8000-0000000000f1", "e6370000-0000-4000-8000-0000000000f2", "e6370000-0000-4000-8000-0000000000f3", "e6370000-0000-4000-8000-0000000000f4"];
const CODICI = ["7001", "7002", "7003", "7004"];
const NOMI = ["Borgo Alto", "Ponte Nuovo", "Lago", "Fornace"];
/* le fermate su un parallelo, a centesimi di grado: circa 0, 3,1, 7,9 e 11 km */
const LAT = 45, LON = 9;
const CENTESIMI = [0, 4, 10, 14];

/* il GTFS degli orari, quanto basta: la linea e le fermate */
const ORARI: Gtfs = {
  "routes.txt": { colonne: ["route_id", "route_short_name"], righe: [{ route_id: "T37", route_short_name: "T37" }] },
  "stops.txt": { colonne: ["stop_id"], righe: CODICI.map((stop_id) => ({ stop_id })) },
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("le tariffe del GTFS, sul database", () => {
  const prima: Record<string, unknown[]> = {};
  /* le tabelle dell'azienda che il test riempie: si mettono da parte e si rimettono */
  const TABELLE = ["titoli_catalogo", "fasce_km", "supporti_catalogo", "categorie_catalogo"] as const;

  beforeAll(async () => {
    for (const t of TABELLE) prima[t] = (await db.execute<any>(sql`SELECT to_jsonb(x) AS riga FROM ${sql.identifier(t)} x`)).rows.map((r) => r.riga);
    for (const t of TABELLE) await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    await db.execute(sql`INSERT INTO fasce_km (fascia, km_da, km_a, prezzo) VALUES (1, 0, 6, 1.35), (2, 6, 12, 1.85), (3, 12, 30, 2.5)`);
    await db.execute(sql`INSERT INTO categorie_catalogo (categoria, nome, predefinita, ordine) VALUES ('ordinario', 'Ordinaria', true, 1)`);
    await db.execute(sql`INSERT INTO supporti_catalogo (supporto, nome, tipo, ordine) VALUES ('carta', 'Biglietto di carta', 1, 1)`);
    await db.execute(sql`INSERT INTO titoli_catalogo (titolo, nome, rete, tipo, categoria, prezzo, fascia, ordine)
      VALUES ('extra_mens_2', 'Abbonamento mensile', 'extraurbano', 'abbonamento_mensile', 'ordinario', 40, 2, 1)`);

    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (${CHI}::uuid, 'tariffe-6.37@prova.local', 'x', 'user', 'Prova 6.37') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${PROGETTO}::uuid, ${CHI}::uuid, 'Programma di prova 6.37')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name, long_name, codice) VALUES (${LINEA}::uuid, ${PROGETTO}::uuid, 'T37', 'Borgo Alto - Fornace', 'T37')`);
    for (let i = 0; i < 4; i++) {
      await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon, codice) VALUES (${FERMATE[i]}::uuid, ${PROGETTO}::uuid, ${NOMI[i]}, ${LAT}, ${LON + CENTESIMI[i]! / 100}, ${CODICI[i]})`);
    }
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name, direction) VALUES (${VA}::uuid, ${PROGETTO}::uuid, ${LINEA}::uuid, 'Andata', 0)`);
    for (let i = 0; i < 4; i++) await db.execute(sql`INSERT INTO ps_variant_stops (variant_id, seq, stop_id) VALUES (${VA}::uuid, ${i + 1}, ${FERMATE[i]}::uuid)`);
    await db.execute(sql`INSERT INTO ps_trips (project_id, route_id, variant_id) VALUES (${PROGETTO}::uuid, ${LINEA}::uuid, ${VA}::uuid)`);

    /* una polimetrica salvata su un'altra fotografia dello stesso percorso: due nodi, Borgo e Lago */
    await db.execute(sql`INSERT INTO polim_imports (id, filename, line_count, percorso_count, payload) VALUES (${FOTO}::uuid, 'prova-6.37.zip', 1, 1, '{"lines": []}'::jsonb)`);
    await db.execute(sql`INSERT INTO polim_polimetriche (import_id, route_id, line_code, variant_id, direction, name, boundaries, tratte, stops)
      VALUES (${FOTO}::uuid, 'T37', 'T37', 'vecchia', 'AB', 'T37', '[2]'::jsonb,
        ${JSON.stringify([{ index: 0, nodeName: "Borgo" }, { index: 1, nodeName: "Lago e Fornace" }])}::jsonb,
        ${JSON.stringify(CODICI.map((stopId) => ({ stopId })))}::jsonb)`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM polim_imports WHERE id = ${FOTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_variant_stops WHERE variant_id = ${VA}::uuid`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${CHI}::uuid`);
    for (const t of TABELLE) await db.execute(sql`DELETE FROM ${sql.identifier(t)}`);
    for (const t of [...TABELLE].reverse()) {
      for (const riga of prima[t] ?? []) {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} SELECT * FROM jsonb_populate_record(NULL::${sql.identifier(t)}, ${JSON.stringify(riga)}::jsonb)`);
      }
    }
    await pool.end();
  });

  it("i file: titoli, fasce, la rete della linea, i nodi dalla polimetrica salvata", async () => {
    const t = await tariffeDelGtfs(PROGETTO, ORARI);
    expect(t.conteggi).toMatchObject({ linee: 1, percorsi: 1, salvati: 1, nodi: 2 });
    expect(t.file["fare_products.txt"]!.righe.map((r) => [r.fare_product_id, r.amount])).toEqual([
      ["extra_mens_2", "40.00"], ["extra_fascia_1", "1.35"], ["extra_fascia_2", "1.85"], ["extra_fascia_3", "2.50"],
    ]);
    expect(t.file["route_networks.txt"]!.righe).toEqual([{ network_id: "extraurbano:T37", route_id: "T37" }]);
    expect(t.file["areas.txt"]!.righe).toEqual([
      { area_id: "extraurbano:T37:7001", area_name: "Borgo (linea T37)" }, { area_id: "extraurbano:T37:7003", area_name: "Lago e Fornace (linea T37)" },
    ]);
    expect(t.file["stop_areas.txt"]!.righe.map((r) => [r.stop_id, r.area_id])).toEqual([
      ["7001", "extraurbano:T37:7001"], ["7002", "extraurbano:T37:7001"], ["7003", "extraurbano:T37:7003"], ["7004", "extraurbano:T37:7003"],
    ]);
    /* da Borgo a Lago: circa 7,9 km, la fascia 2 */
    const regola = t.file["fare_leg_rules.txt"]!.righe.find((r) => r.from_area_id === "extraurbano:T37:7001" && r.to_area_id === "extraurbano:T37:7003");
    expect(regola?.fare_product_id).toBe("extra_fascia_2");
    expect(t.avvisi.map((a) => a.codice)).not.toContain("percorsi_senza_polimetrica");
  });

  it("l'impronta delle tariffe cambia con un prezzo e con una polimetrica", async () => {
    const a = await improntaDelleTariffe();
    expect(await improntaDelleTariffe()).toBe(a);
    await db.execute(sql`UPDATE fasce_km SET prezzo = 1.40 WHERE fascia = 1`);
    const b = await improntaDelleTariffe();
    expect(b).not.toBe(a);
    await db.execute(sql`UPDATE polim_polimetriche SET name = 'T37 rivista', updated_at = now() + interval '1 second' WHERE import_id = ${FOTO}::uuid`);
    expect(await improntaDelleTariffe()).not.toBe(b);
  });

  it("un programma che non c'è: nessuna tariffa extraurbana, i titoli sì", async () => {
    const t = await tariffeDelGtfs("e6370000-0000-4000-8000-0000000000ff", ORARI);
    expect(t.conteggi).toMatchObject({ linee: 0, nodi: 0 });
    expect(t.file["fare_products.txt"]!.righe.length).toBe(4);
    expect(t.avvisi.map((a) => a.codice)).toContain("linea_senza_polimetrica");
  });
});
