/* Il registro delle modifiche sul database vero (TEST_DATABASE_URL: in CI
 * come cerbero_app, migrato fino alla 0007). Il lavoratore chiama la
 * manutenzione e la verifica come cerbero_app: passano, non danno problemi, e
 * due chiamate insieme non si pestano. Il registro l'app non lo legge dalle
 * tabelle e non lo cambia: lo legge con registro.leggi() (PR 2.11). Dove il
 * registro è acceso (in CI lo è), una transazione vera dell'app, col suo
 * contesto: i riepiloghi nascono al COMMIT, sommati, con chi l'ha fatta. */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { pool, db, contestoDb, conContesto } from "@workspace/db";
import { manutieniRegistro } from "../lib/lavori/registro";
import { leggiRegistro, statoRegistro, Parametri } from "../lib/registro-modifiche";

const log = { info() {}, warn() {}, error() {} };

describe.runIf(!!process.env.TEST_DATABASE_URL)("il registro delle modifiche, dal lavoratore", () => {
  afterAll(async () => { await pool.end(); });

  it("manutenzione e verifica passano come l'app, due volte e anche insieme", async () => {
    const a = await manutieniRegistro(log);
    expect(a.saltato).toBe(false);
    expect(a.problemi).toEqual([]);
    const [b, c] = await Promise.all([manutieniRegistro(log), manutieniRegistro(log)]);
    expect([b, c].every((e) => e.problemi.length === 0)).toBe(true);
  });

  it("l'app non legge, non cambia e non svuota il registro, e non lo accende", async () => {
    for (const q of ["SELECT count(*) FROM registro.modifiche", "DELETE FROM registro.modifiche", "TRUNCATE registro.modifiche",
      "UPDATE registro.impostazioni SET attivo = true, base_giuridica = 'x'",
      // 0007: né le consultazioni, né i parziali, né le funzioni interne
      "SELECT count(*) FROM registro.letture", "DELETE FROM registro.letture", "SELECT count(*) FROM registro.parziali",
      "SELECT count(*) FROM registro.impostazioni", "SELECT registro.somma(pg_current_xact_id())"]) {
      await expect(pool.query(q), q).rejects.toThrow(/permission denied/);
    }
  });

  it("lo legge con leggi() e ne chiede lo stato; i filtri per persona li rifiuta anche il database", async () => {
    const stato = await statoRegistro();
    expect(stato.tabelle.length).toBeGreaterThanOrEqual(29);
    expect(stato.tabelle.find((t) => t.tabella === "public.ps_stop_times")).toMatchObject({ riepilogoSempre: true, conValori: false });
    const pagina = await leggiRegistro(Parametri.parse({ limite: "5" }));
    expect("errore" in pagina).toBe(false);
    await expect(pool.query(`SELECT * FROM registro.leggi('{"attore": "x"}', 5, 0)`)).rejects.toThrow(/non si legge per persona/);
    await expect(pool.query(`SELECT * FROM registro.leggi('{"ambito_tipo": "utente", "ambito_id": "x"}', 5, 0)`)).rejects.toThrow(/non è una persona/);
    await expect(pool.query("SELECT * FROM registro.leggi('{}', 201, 0)")).rejects.toThrow(/da 1 a 200/);
  });

  it("una transazione dell'app: gli orari di una corsa danno un riepilogo al COMMIT, con chi l'ha fatta", async (ctx) => {
    if (!(await statoRegistro()).attivo) { ctx.skip(); return; }
    const u = randomUUID(), progetto = randomUUID(), linea = randomUUID(), variante = randomUUID(), corsa = randomUUID();
    const fermate = Array.from({ length: 12 }, () => randomUUID());
    await contestoDb.run({ attore: u, via: "api", richiesta: `r-${corsa}` }, async () => {
      await db.execute(sql`INSERT INTO users (id, email, password_hash, full_name) VALUES (${u}::uuid, ${`reg-${u}@prova.local`}, 'x', 'Registro Prova')`);
      await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${progetto}::uuid, ${u}::uuid, 'Registro, orari')`);
      await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${linea}::uuid, ${progetto}::uuid, 'R')`);
      await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${variante}::uuid, ${progetto}::uuid, ${linea}::uuid, 'A')`);
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id) VALUES (${corsa}::uuid, ${progetto}::uuid, ${linea}::uuid, ${variante}::uuid)`);
      // le fermate in blocco, col modo «riepilogo» attorno alla transazione (come POST …/stops/bulk)
      await conContesto({ registro: "riepilogo" }, () => db.transaction(async (tx) => {
        for (const [i, id] of fermate.entries()) {
          await tx.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES (${id}::uuid, ${progetto}::uuid, ${`F${i}`}, 43.6, 13.5)`);
        }
      }));
      // gli orari come PUT …/trips/:id/stop-times: cancella tutto, poi una riga per fermata
      await db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${corsa}::uuid`);
        for (const [i, id] of fermate.entries()) {
          await tx.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time)
                               VALUES (${corsa}::uuid, ${i + 1}, ${id}::uuid, '07:00:00', '07:00:30')`);
        }
      });
      // una transazione annullata non lascia niente, nemmeno parziali
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE ps_stop_times SET arrival_time = '08:00:00' WHERE trip_id = ${corsa}::uuid AND stop_seq = 1`);
        throw new Error("annulla");
      }).catch(() => {});
    });
    const pagina = await leggiRegistro(Parametri.parse({ ambitoTipo: "corsa", ambitoId: corsa }));
    if ("errore" in pagina) throw new Error(pagina.errore);
    expect(pagina.righe).toHaveLength(1);
    expect(pagina.righe[0]).toMatchObject({
      tabella: "public.ps_stop_times", operazione: "INSERT", riepilogo: true, righe: 12, prima: null, dopo: null, chiave: null,
      attore: { id: u, nome: "Registro Prova" }, via: "api", ruoloDb: "cerbero_app", richiesta: `r-${corsa}`,
      ambito: { tipo: "corsa", id: corsa },
    });
    expect(pagina.righe[0]!.campione).toHaveLength(12);
    const delProgetto = await leggiRegistro(Parametri.parse({ ambitoTipo: "progetto_ps", ambitoId: progetto, tabella: "public.ps_stops" }));
    if ("errore" in delProgetto) throw new Error(delProgetto.errore);
    expect(delProgetto.righe).toHaveLength(1);
    expect(delProgetto.righe[0]).toMatchObject({ operazione: "INSERT", riepilogo: true, righe: 12, ambito: { nome: "Registro, orari" } });
    // pulizia, come fa l'app (gli orari prima delle fermate); l'utente resta fuori dal registro delle prove successive
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${corsa}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${progetto}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${u}::uuid`);
  });
});
