/**
 * I km per vettura e per giorno per FleetCare (tappa 4.8, migrazione 0030),
 * su un database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Due giornate di luglio 2026: una chiusa, una solo congelata (fuori). Nella
 * chiusa:
 *   - turno macchina T1, una sola vettura (301): due corse con la vettura,
 *     una presunta senza vettura (presa dal turno), i suoi vuoti;
 *   - turno macchina T2, due vetture nello stesso giorno (302 e 303): la
 *     corsa senza vettura e i vuoti non si attribuiscono;
 *   - una parziale (km fatti), una soppressa (niente), una aggiunta con la
 *     vettura 301 (contata).
 * I numeri attesi sono fatti a mano.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { LETTORI } from "../../../../lib/db/scripts/ruoli-regole.mjs";

const [G1, G2] = ["2026-07-07", "2026-07-08"];
const VSS = "d4800000-0000-4000-8000-000000000001";
const righe = (r: any): any[] => r?.rows ?? r ?? [];

describe.runIf(!!process.env.TEST_DATABASE_URL)("i km per vettura e per giorno, sul database", () => {
  const pulisci = () => db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (${G1}::date, ${G2}::date)`);
  const km = async (da: string, a: string) =>
    righe(await db.execute(sql`SELECT giorno::text, vettura, corse, km_servizio::float8 AS servizio, km_dal_turno::float8 AS dal_turno,
                                      km_vuoto::float8 AS vuoto
                                 FROM public.esercizio_km_per_vettura(${da}::date, ${a}::date)`));

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, chiusa_il, riepilogo, turni) VALUES
      (${G1}::date, 'chiusa', 0, now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
      (${G2}::date, 'congelata', 0, now(), now(), NULL, NULL, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_turni_macchina (giorno, vss_id, turno_macchina, corse, corse_nel_giorno, km_vuoto_prog) VALUES
      (${G1}::date, ${VSS}::uuid, 'T1', 4, 4, 5.5), (${G1}::date, ${VSS}::uuid, 'T2', 3, 3, 4)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, vss_id, turno_macchina, origine, tipo_aggiunta, esito, km_prog, km_eff, vettura, causale, confermata_il) VALUES
      (${G1}::date, 'k-1', '1', ${VSS}::uuid, 'T1', 'programmata', NULL, 'effettuata', 10, 10, '301', NULL, now()),
      (${G1}::date, 'k-2', '2', ${VSS}::uuid, 'T1', 'programmata', NULL, 'effettuata', 10, 10, ' 301 ', NULL, now()),
      (${G1}::date, 'k-3', '3', ${VSS}::uuid, 'T1', 'programmata', NULL, 'presunta', 8, 8, NULL, NULL, now()),
      (${G1}::date, 'k-4', '4', ${VSS}::uuid, 'T1', 'programmata', NULL, 'soppressa', 8, 0, NULL, 'GUASTO_MEZZO', now()),
      (${G1}::date, 'k-5', '5', ${VSS}::uuid, 'T2', 'programmata', NULL, 'effettuata', 6, 6, '302', NULL, now()),
      (${G1}::date, 'k-6', '6', ${VSS}::uuid, 'T2', 'programmata', NULL, 'parziale', 6, 2.5, '303', 'GUASTO_MEZZO', now()),
      (${G1}::date, 'k-7', '7', ${VSS}::uuid, 'T2', 'programmata', NULL, 'presunta', 6, 6, NULL, NULL, now()),
      (${G1}::date, 'agg:k-8', 'agg', NULL, NULL, 'aggiunta', 'bis', 'effettuata', NULL, 3, '301', NULL, now()),
      (${G2}::date, 'k-9', '9', ${VSS}::uuid, 'T1', 'programmata', NULL, 'effettuata', 10, 10, '301', NULL, now())`);
  });
  afterAll(pulisci);

  it("per vettura: i km con la vettura, quelli presi dal turno con una sola vettura, i vuoti; solo le giornate chiuse", async () => {
    expect(await km("2026-07-01", "2026-07-31")).toEqual([
      // k-1, k-2 (spazi tolti), l'aggiunta: 23; k-3 dal turno T1: 8; i vuoti di T1: 5,5
      { giorno: G1, vettura: "301", corse: 4, servizio: 23, dal_turno: 8, vuoto: 5.5 },
      // T2 ha due vetture: la presunta k-7 e i vuoti di T2 restano fuori
      { giorno: G1, vettura: "302", corse: 1, servizio: 6, dal_turno: 0, vuoto: 0 },
      { giorno: G1, vettura: "303", corse: 1, servizio: 2.5, dal_turno: 0, vuoto: 0 },
    ]);
  });

  it("riaprire la giornata la toglie; il periodo si controlla", async () => {
    expect(await km(G2, G2)).toEqual([]);
    await expect(db.execute(sql`SELECT * FROM public.esercizio_km_per_vettura(${"2026-07-31"}::date, ${"2026-07-01"}::date)`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "22023" }) });
    await expect(db.execute(sql`SELECT * FROM public.esercizio_km_per_vettura(${"2025-01-01"}::date, ${"2026-07-01"}::date)`))
      .rejects.toMatchObject({ cause: expect.objectContaining({ code: "22023" }) });
    await db.execute(sql`UPDATE esercizio_giornate SET stato = 'congelata', chiusa_il = NULL, riepilogo = NULL WHERE giorno = ${G1}::date`);
    expect(await km("2026-07-01", "2026-07-31")).toEqual([]);
  });

  it("FleetCare legge solo le colonne che servono alla funzione: niente turno guida né conducente", () => {
    const l = LETTORI.fleetcare_legge_cerbero!;
    expect(l["public.esercizio_corse"]).toEqual(["giorno", "vss_id", "turno_macchina", "vettura", "km_eff", "esito"]);
    for (const colonne of Object.values(l)) for (const c of colonne) expect(c).not.toMatch(/guida|conducente|autista|matricola_pers/);
  });
});
