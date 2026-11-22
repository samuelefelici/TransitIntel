/**
 * Riposi nel roster per i turni guida calcolati col profilo «misto» (tappa
 * 7.10), su un database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Il riposo minimo fra due turni è 8 ore solo se sono urbani tutti e due,
 * altrimenti 9. Un DSS calcolato col profilo misto dice nel risultato con che
 * regole è fatto ogni turno (driverShifts[].regole): ora vale quella, invece
 * di «tutto il DSS è extraurbano». Un DSS misto calcolato prima della 7.9,
 * senza la categoria dei turni, resta extraurbano.
 *
 * Un conducente finisce un turno alle 22:30 e attacca il giorno dopo alle
 * 07:00: 8h30 di riposo, che bastano solo fra due turni urbani.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { serviziDeiDss, turniNelTempo, type RigaTurno } from "../lib/roster-normativa-db";
import { violazioniDeiTurni } from "../lib/roster-normativa";

const u = (n: number) => `e7a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [VSS, MISTO, VECCHIO, CONDUCENTE] = [u(1), u(2), u(3), u(4)];
const turno = (driverId: string, regole?: string) => ({ driverId, nastroStart: "07:00", nastroEnd: "13:00", ...(regole ? { regole } : {}) });
const MISTO_RISULTATO = { driverShifts: [turno("M001", "urbano"), turno("M002", "urbano"), turno("M100", "extraurbano")] };
const VECCHIO_RISULTATO = { driverShifts: [turno("M001"), turno("M002")] };

const riga = (dss: string, day: string, duty: string, inizio: number, fine: number): RigaTurno =>
  ({ id: null, driver_id: CONDUCENTE, day, dss_id: dss, duty_code: duty, snapshot: { startMin: inizio, endMin: fine } });
/* sera del 1° (14:30–22:30), mattina del 2 (07:00–13:00) */
const coppia = (dss: string, primo: string, secondo: string) =>
  [riga(dss, "2032-08-01", primo, 870, 1350), riga(dss, "2032-08-02", secondo, 420, 780)];

async function pulisci() {
  await db.execute(sql`DELETE FROM driver_shift_scenarios WHERE id IN (${MISTO}::uuid, ${VECCHIO}::uuid)`);
  await db.execute(sql`DELETE FROM service_program_scenarios WHERE id = ${VSS}::uuid`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("riposi per turno nei calcoli misti, sul database", () => {
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO service_program_scenarios (id, name, date, input, result) VALUES (${VSS}::uuid, 'Turni macchina 7.10', '20320801', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO driver_shift_scenarios (id, service_program_scenario_id, name, config, result) VALUES
      (${MISTO}::uuid, ${VSS}::uuid, 'Turni guida misti 7.10', ${JSON.stringify({ bds: { serviceType: "misto" } })}::jsonb, ${JSON.stringify(MISTO_RISULTATO)}::jsonb),
      (${VECCHIO}::uuid, ${VSS}::uuid, 'Turni guida misti di prima', ${JSON.stringify({ bds: { serviceType: "misto" } })}::jsonb, ${JSON.stringify(VECCHIO_RISULTATO)}::jsonb)`);
  });
  afterAll(pulisci);

  it("il DSS misto porta la categoria di ogni turno; quello di prima no", async () => {
    const s = await serviziDeiDss([MISTO, VECCHIO]);
    const misto = s.get(MISTO)!;
    expect(misto.servizio).toBe("extraurbano");
    expect(misto.da).toBe("fucina");
    expect([...misto.perTurno!.entries()].sort()).toEqual([["M001", "urbano"], ["M002", "urbano"], ["M100", "extraurbano"]]);
    expect(s.get(VECCHIO)!.perTurno).toBeUndefined();
  });

  it("due turni urbani di un calcolo misto: 8h30 di riposo bastano", async () => {
    const turni = await turniNelTempo(coppia(MISTO, "M001", "M002"));
    expect(turni.map((t) => t.servizio)).toEqual(["urbano", "urbano"]);
    expect(violazioniDeiTurni(turni)).toEqual([]);
  });

  it("se uno dei due è extraurbano ne servono 9", async () => {
    const turni = await turniNelTempo(coppia(MISTO, "M100", "M002"));
    expect(turni.map((t) => t.servizio)).toEqual(["extraurbano", "urbano"]);
    const v = violazioniDeiTurni(turni);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ regola: "riposo", minuti: 510, minimo: 540 });
  });

  it("un calcolo misto di prima, senza la categoria dei turni, resta extraurbano", async () => {
    const turni = await turniNelTempo(coppia(VECCHIO, "M001", "M002"));
    expect(turni.map((t) => t.servizio)).toEqual(["extraurbano", "extraurbano"]);
    expect(violazioniDeiTurni(turni)).toHaveLength(1);
  });
});
