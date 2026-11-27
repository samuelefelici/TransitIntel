/**
 * Acquisire i tempi reali nel programma, su un database vero
 * (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Una linea A↔B: l'andata ha 17′ in orario e le ultime domeniche i bus ne
 * hanno fatti 20; il ritorno parte da B 3′ dopo l'arrivo. Il ritorno ha i
 * tempi giusti. Una corsa del feriale e un prototipo non c'entrano.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { calcolaAcquisizione, scriviAcquisizione, leggiParametri } from "../lib/percorrenze-acquisizione-db";
import { tipoDelGiorno } from "../lib/percorrenze-reali";
import { giornataOggi } from "../lib/service-day";

const u = (n: number) => `d4800000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADMIN = u(1), P = u(2), L = u(3), VA = u(4), VR = u(5), SA = u(6), SB = u(7);
const DT = u(8), DT_FER = u(9);
const TA = u(20), TR = u(21), TX = u(22), TP = u(23);

/** le ultime sei giornate festive prima di oggi */
const festivi = (() => {
  const out: string[] = [];
  let t = new Date(`${giornataOggi()}T12:00:00Z`).getTime() - 86_400_000;
  while (out.length < 6) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (tipoDelGiorno(d) === "festivo") out.push(d);
    t -= 86_400_000;
  }
  return out;
})();

const par = (x: Record<string, unknown>) => {
  const r = leggiParametri({ dayTypeId: DT, ripiego: "nessuno", ...x });
  if (!r.ok) throw new Error(r.errore);
  return r.p;
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("acquisire i tempi reali, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM caronte.stop_transits WHERE stop_id LIKE 'acq-%'`);
    await db.execute(sql`DELETE FROM ps_trip_day_validity WHERE trip_id IN (${TA}::uuid, ${TR}::uuid, ${TX}::uuid, ${TP}::uuid)`);
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id IN (${TA}::uuid, ${TR}::uuid, ${TX}::uuid, ${TP}::uuid)`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_stops WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_routes WHERE project_id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM ps_day_types WHERE id IN (${DT}::uuid, ${DT_FER}::uuid)`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${P}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${ADMIN}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES (${ADMIN}::uuid, 'acquisizione@prova.local', 'x', 'admin')`);
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${P}::uuid, ${ADMIN}::uuid, 'Acquisizione tempi reali')`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${L}::uuid, ${P}::uuid, '2')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name, direction) VALUES
      (${VA}::uuid, ${P}::uuid, ${L}::uuid, 'Andata', 0), (${VR}::uuid, ${P}::uuid, ${L}::uuid, 'Ritorno', 1)`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon, gtfs_id) VALUES
      (${SA}::uuid, ${P}::uuid, 'Cavour', 43.6167, 13.518, 'acq-A'), (${SB}::uuid, ${P}::uuid, 'Madonnetta', 43.60, 13.50, 'acq-B')`);
    await db.execute(sql`INSERT INTO ps_day_types (id, project_id, code, name, color) VALUES
      (${DT}::uuid, ${P}::uuid, 'festivo', 'Festivo', '#ef4444'), (${DT_FER}::uuid, ${P}::uuid, 'feriale', 'Feriale', '#3b82f6')`);
    for (const [t, v, attr] of [[TA, VA, "{}"], [TR, VR, "{}"], [TX, VA, "{}"], [TP, VA, '{"prototype": true}']] as const) {
      await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, attributes) VALUES
        (${t}::uuid, ${P}::uuid, ${L}::uuid, ${v}::uuid, ${attr}::jsonb)`);
    }
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
      (${TA}::uuid, 1, ${SA}::uuid, '08:00:00', '08:00:00'), (${TA}::uuid, 2, ${SB}::uuid, '08:17:00', '08:17:00'),
      (${TR}::uuid, 1, ${SB}::uuid, '08:20:00', '08:20:00'), (${TR}::uuid, 2, ${SA}::uuid, '08:37:00', '08:37:00'),
      (${TX}::uuid, 1, ${SA}::uuid, '07:00:00', '07:00:00'), (${TX}::uuid, 2, ${SB}::uuid, '07:17:00', '07:17:00'),
      (${TP}::uuid, 1, ${SA}::uuid, '00:00:00', '00:00:00'), (${TP}::uuid, 2, ${SB}::uuid, '00:10:00', '00:10:00')`);
    await db.execute(sql`INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid) VALUES
      (${TA}::uuid, ${DT}::uuid, true), (${TR}::uuid, ${DT}::uuid, true), (${TP}::uuid, ${DT}::uuid, true),
      (${TX}::uuid, ${DT_FER}::uuid, true)`);
    // le domeniche: A→B 20′ alle 8, B→A 17′
    for (const [i, d] of festivi.entries()) {
      const v = `acq-v${i}`;
      await db.execute(sql`INSERT INTO caronte.stop_transits (trip_id, route_id, vehicle_id, stop_id, stop_seq, actual_ts, source) VALUES
        ('acq-T1', 'acq-L', ${v}, 'acq-A', 1, (${d}::date + time '08:00') AT TIME ZONE 'Europe/Rome', 'siri'),
        ('acq-T1', 'acq-L', ${v}, 'acq-B', 2, (${d}::date + time '08:20') AT TIME ZONE 'Europe/Rome', 'siri'),
        ('acq-T2', 'acq-L', ${v}, 'acq-B', 1, (${d}::date + time '08:21') AT TIME ZONE 'Europe/Rome', 'siri'),
        ('acq-T2', 'acq-L', ${v}, 'acq-A', 2, (${d}::date + time '08:38') AT TIME ZONE 'Europe/Rome', 'siri')`);
    }
  });
  afterAll(pulisci);

  it("un percorso: l'andata prende i 20′ dell'ora 8, la sosta a Madonnetta sparisce e lo dice", async () => {
    const e = await calcolaAcquisizione(P, par({ ambito: "percorso", variantId: VA }), null);
    if (!e.ok) throw new Error(e.errore);
    expect(e.a.osservazione).toMatchObject({ tipoGiorno: "festivo", disponibile: true, coppieDaFeriale: 0 });
    // né la corsa del feriale né il prototipo
    expect(e.a.corse.map(c => c.tripId)).toEqual([TA]);
    expect(e.a.corse[0]).toMatchObject({
      linea: "2", partenza: "08:00", arrivoAttuale: "08:17", arrivoNuovo: "08:20", variazioneMin: 3,
      cambia: true, fonti: { ora: 1, programmato: 0 },
      prima: { sostaMin: 3, prossimaPartenza: "08:20" },
      dopo: { sostaMin: 0, giudizio: "insufficiente" },
    });
  });

  it("tutte le linee: anche il ritorno, che ha già i tempi giusti", async () => {
    const e = await calcolaAcquisizione(P, par({ ambito: "linee" }), null);
    if (!e.ok) throw new Error(e.errore);
    expect(e.a.corse.map(c => [c.tripId, c.cambia])).toEqual([[TA, true], [TR, false]]);
    expect(e.a.riepilogo).toMatchObject({ corse: 2, cambiano: 1, saltate: 0 });
  });

  it("una corsa che quel giorno non circola, o di un altro progetto: rifiutata", async () => {
    const e = await calcolaAcquisizione(P, par({ ambito: "corsa", tripIds: [TX] }), null);
    expect(e).toMatchObject({ ok: false, stato: 400, errore: expect.stringMatching(/non circola/) });
    const f = await calcolaAcquisizione(P, par({ ambito: "corsa", tripIds: [u(99)] }), null);
    expect(f).toMatchObject({ ok: false, stato: 404 });
  });

  it("scrive solo le corse scelte dell'ambito, solo le fermate che cambiano", async () => {
    const e = await calcolaAcquisizione(P, par({ ambito: "linee" }), null);
    if (!e.ok) throw new Error(e.errore);
    const w = await scriviAcquisizione(e.a, [TA, TR, TX]);
    expect(w).toEqual({ corse: 1, fermate: 1, nonNellAmbito: 1, senzaModifiche: 1, saltate: 0 });
    const r = await db.execute<any>(sql`
      SELECT trip_id::text AS t, stop_seq, arrival_time, departure_time FROM ps_stop_times
       WHERE trip_id IN (${TA}::uuid, ${TX}::uuid) ORDER BY trip_id, stop_seq`);
    expect(r.rows.map((x: any) => [x.t, x.stop_seq, x.arrival_time, x.departure_time])).toEqual([
      [TA, 1, "08:00:00", "08:00:00"], [TA, 2, "08:20:00", "08:20:00"],
      [TX, 1, "07:00:00", "07:00:00"], [TX, 2, "07:17:00", "07:17:00"],
    ]);
    // rifatto il calcolo, non cambia più niente: ripetibile
    const ancora = await calcolaAcquisizione(P, par({ ambito: "percorso", variantId: VA }), null);
    if (!ancora.ok) throw new Error(ancora.errore);
    expect(ancora.a.corse[0]).toMatchObject({ cambia: false, arrivoAttuale: "08:20" });
  });
});
