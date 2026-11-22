/**
 * Gli orari alle fermate nel registro, col prima e il dopo (tappa 7.20), sul
 * database (TEST_DATABASE_URL; in CI come cerbero_app, col registro acceso).
 *
 * L'app salva gli orari di una corsa cancellando tutto e reinserendo. Dalla
 * 0066 il registro confronta, a fine transazione, ogni fermata com'era
 * all'inizio con com'è alla fine e scrive una riga per fermata cambiata
 * davvero, coi valori di prima e di dopo. Le fermate reinserite uguali non
 * lasciano niente; una corsa nuova, una cascata (cancellare la corsa) e le
 * transazioni grandi (oltre 2000 righe) restano col solo riepilogo.
 *
 * Se il registro è spento (in locale, di solito) il test non verifica niente.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { contestoDb } from "@workspace/db/contesto";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { leggiRegistro, statoRegistro, Parametri } from "../lib/registro-modifiche";

const u = (n: number) => `e7f00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [UTENTE, P, LINEA, VARIANTE, CORSA, ALTRA, FERMATA] = Array.from({ length: 7 }, (_, i) => u(i + 1));
const FERMATE = 10;
/* il registro conserva le righe delle esecuzioni precedenti: richieste nuove ogni volta */
const ESECUZIONE = randomUUID().slice(0, 8);
const r = (nome: string) => `r-orari-${nome}-${ESECUZIONE}`;
let attivo = false;

async function pulisci() {
  await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
  await db.execute(sql`DELETE FROM users WHERE id = ${UTENTE}::uuid`);
}

/** Gli orari della corsa riscritti come fa l'app: tutto via, poi reinseriti con «cambia» applicato. */
async function riscrivi(richiesta: string, corsa: string, cambia: (seq: number) => [string, string] | null) {
  await contestoDb.run({ attore: UTENTE, via: "api", richiesta }, () => db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${corsa}::uuid`);
    for (let seq = 1; seq <= FERMATE; seq++) {
      const orari = cambia(seq);
      if (!orari) continue;
      await tx.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
                           VALUES (${corsa}::uuid, ${seq}, ${FERMATA}::uuid, ${orari[0]}, ${orari[1]})`);
    }
  }));
}

const orario = (seq: number) => `08:${String(seq * 2).padStart(2, "0")}:00`;

async function righe(corsa: string, richiesta: string) {
  const pagina = await leggiRegistro(Parametri.parse({ ambitoTipo: "corsa", ambitoId: corsa, tabella: "public.ps_stop_times" }));
  if ("errore" in pagina) throw new Error(pagina.errore);
  return pagina.righe.filter((r) => r.richiesta === richiesta);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("gli orari alle fermate nel registro, col prima e il dopo", () => {
  beforeAll(async () => {
    await pulisci();
    attivo = (await statoRegistro()).attivo;
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${UTENTE}::uuid, 'orari@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${UTENTE}::uuid, 'Orari 7.20')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${P}::uuid, '1')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${VARIANTE}::uuid, ${P}::uuid, ${LINEA}::uuid, 'Andata')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES (${FERMATA}::uuid, ${P}::uuid, 'Piazza', 40 + 1 / 10.0, 10 + 1 / 10.0)`);
    for (const t of [CORSA, ALTRA]) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id) VALUES (${t}::uuid, ${P}::uuid, ${LINEA}::uuid, ${VARIANTE}::uuid)`);
    }
    await riscrivi(r("prima"), CORSA, (seq) => [orario(seq), orario(seq)]);
    await riscrivi(r("prima-altra"), ALTRA, (seq) => [orario(seq), orario(seq)]);
  });
  afterAll(pulisci);

  it("gli orari di una corsa nuova restano nel solo riepilogo", async () => {
    if (!attivo) return;
    const lette = await righe(CORSA, r("prima"));
    expect(lette.filter((r) => !r.riepilogo)).toEqual([]);
    expect(lette.some((r) => r.riepilogo && r.operazione === "INSERT" && r.righe === FERMATE)).toBe(true);
  });

  it("riscrivere tutti gli orari lascia una riga per fermata cambiata, col prima e il dopo", async () => {
    /* la fermata 3 parte un minuto dopo, la 10 non c'è più; le altre uguali */
    await riscrivi(r("cambio"), CORSA, (seq) => (seq === 10 ? null : seq === 3 ? [orario(3), "08:07:00"] : [orario(seq), orario(seq)]));
    if (!attivo) return;
    const lette = await righe(CORSA, r("cambio"));
    const singole = lette.filter((r) => !r.riepilogo);
    expect(singole.map((r) => [r.operazione, (r.chiave as any)?.stop_seq]).sort()).toEqual([["DELETE", 10], ["UPDATE", 3]]);
    const cambio = singole.find((r) => r.operazione === "UPDATE")!;
    expect(cambio.campi).toEqual(["departure_time"]);
    expect(cambio.prima).toEqual({ departure_time: orario(3) });
    expect(cambio.dopo).toEqual({ departure_time: "08:07:00" });
    expect(cambio.attore?.id).toBe(UTENTE);
    const tolta = singole.find((r) => r.operazione === "DELETE")!;
    expect(tolta.prima).toMatchObject({ arrival_time: orario(10), departure_time: orario(10) });
    /* il riepilogo resta: dice quante righe sono state riscritte */
    expect(lette.some((r) => r.riepilogo && r.operazione === "DELETE" && r.righe === FERMATE)).toBe(true);
  });

  it("riscrivere gli orari uguali non lascia righe per fermata", async () => {
    await riscrivi(r("uguali"), CORSA, (seq) => (seq === 10 ? null : seq === 3 ? [orario(3), "08:07:00"] : [orario(seq), orario(seq)]));
    if (!attivo) return;
    expect((await righe(CORSA, r("uguali"))).filter((r) => !r.riepilogo)).toEqual([]);
  });

  it("oltre 2000 righe in una transazione resta il solo riepilogo", async () => {
    await contestoDb.run({ attore: UTENTE, via: "api", richiesta: r("tante") }, () => db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${CORSA}::uuid`);
      await tx.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
                           SELECT ${CORSA}::uuid, g, ${FERMATA}::uuid, '09:00:00', '09:00:00' FROM generate_series(1, 2100) AS g`);
    }));
    if (!attivo) return;
    const lette = await righe(CORSA, r("tante"));
    expect(lette.filter((x) => !x.riepilogo)).toEqual([]);
    expect(lette.some((x) => x.riepilogo && x.operazione === "INSERT" && x.righe === 2100)).toBe(true);
  });

  it("cancellare una corsa non elenca le sue fermate: resta il riepilogo della cascata", async () => {
    /* attesa dentro il contesto: la query di drizzle parte solo quando la si attende */
    await contestoDb.run({ attore: UTENTE, via: "api", richiesta: r("cascata") }, async () => {
      await db.execute(sql`DELETE FROM ps_trips WHERE id = ${ALTRA}::uuid`);
    });
    if (!attivo) return;
    const lette = await righe(ALTRA, r("cascata"));
    expect(lette.filter((r) => !r.riepilogo)).toEqual([]);
    expect(lette.some((r) => r.riepilogo && r.aCascata)).toBe(true);
  });
});
