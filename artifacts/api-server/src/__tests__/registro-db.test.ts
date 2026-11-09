/* Il registro delle modifiche sul database vero (TEST_DATABASE_URL: in CI
 * come cerbero_app, migrato fino alla 0006). Il lavoratore chiama la
 * manutenzione e la verifica come cerbero_app: passano, non danno problemi, e
 * due chiamate insieme non si pestano. Il registro l'app non lo legge e non
 * lo cambia. */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { manutieniRegistro } from "../lib/lavori/registro";

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
    for (const sql of ["SELECT count(*) FROM registro.modifiche", "DELETE FROM registro.modifiche", "TRUNCATE registro.modifiche",
      "UPDATE registro.impostazioni SET attivo = true, base_giuridica = 'x'"]) {
      await expect(pool.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });
});
