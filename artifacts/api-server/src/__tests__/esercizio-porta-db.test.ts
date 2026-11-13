/**
 * La porta unica del programma in esercizio (PR 3.2, migrazione 0019), su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app).
 *
 * Le tre porte di prima passano tutte da lib/esercizio-porta.ts: «Metti in
 * esercizio» di Planning Studio, il giro delle attivazioni programmate e
 * «Attiva» nella pagina GTFS. Dopo ognuna c'è un solo feed acceso, ed è anche
 * quello di default; nello storico c'è un solo periodo aperto, il suo, con chi
 * ha attivato. Due attivazioni insieme si mettono in fila. Mettere in esercizio
 * da Planning Studio vuole anche la scrittura su «Pubblicazione degli orari».
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Router } from "express";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { conContesto } from "@workspace/db/contesto";
import { sql } from "drizzle-orm";
import pianificazione, { processPendingActivations } from "../lib/planning-studio";
import caricamento from "../routes/gtfs-upload";
import { mettiInEsercizio, AttivazioneRifiutata } from "../lib/esercizio-porta";
import { cancellaProgetto } from "../lib/progetto-copie";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import type { AuthUser } from "../lib/auth";

const u = (n: number) => `d3200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, PIAN, SOLO_RETE] = [u(1), u(2), u(3)];
const PROGETTO = u(10);
const [F_MAIOR, F_ALTRO, F_VECCHIO, F_PRONTO] = [u(20), u(21), u(22), u(23)];
const [FERMATA_1, FERMATA_2, LINEA, PERCORSO, CALENDARIO, CORSA] = [u(30), u(31), u(32), u(33), u(34), u(35)];

const tutte = Router();
tutte.use(pianificazione);
tutte.use(caricamento);
const pianificatore = utenteDiProva(PIAN, [], "user", { ruoli: ["pianificatore"] });
/* modifica la rete ma la pubblicazione degli orari la legge soltanto */
const soloRete: AuthUser = (() => {
  const x = utenteDiProva(SOLO_RETE, [], "user", { ruoli: ["pianificatore"] });
  return { ...x, diritti: { ...x.diritti, pubblicazione_orari: "L" } };
})();
const app = {
  admin: appDiProva(tutte, utenteDiProva(ADMIN, [], "admin")),
  pianificatore: appDiProva(tutte, pianificatore),
  soloRete: appDiProva(tutte, soloRete),
};

const nostriFeed = sql`(SELECT id FROM gtfs_feeds WHERE id IN (${F_MAIOR}::uuid, ${F_ALTRO}::uuid, ${F_VECCHIO}::uuid, ${F_PRONTO}::uuid)
                        OR owner_user_id IN (${ADMIN}::uuid, ${PIAN}::uuid, ${SOLO_RETE}::uuid))`;

/** Lo stato del programma in esercizio, per i nostri feed. */
async function stato() {
  const accesi = (await db.execute<any>(sql`SELECT id FROM gtfs_feeds WHERE is_active`)).rows.map((r: any) => r.id);
  const diDefault = (await db.execute<any>(sql`SELECT id FROM gtfs_feeds WHERE is_default`)).rows.map((r: any) => r.id);
  const aperti = (await db.execute<any>(sql`
    SELECT feed_id, project_id, user_id, via FROM ps_activation_log WHERE deactivated_at IS NULL`)).rows;
  return { accesi, diDefault, aperti };
}

async function feed(id: string, nome: string, o: { acceso?: boolean; proprietario?: string; caricato?: string } = {}) {
  await db.execute(sql`
    INSERT INTO gtfs_feeds (id, filename, owner_user_id, is_active, is_default, uploaded_at)
    VALUES (${id}::uuid, ${nome}, ${o.proprietario ?? ADMIN}::uuid, ${!!o.acceso}, ${!!o.acceso}, ${o.caricato ?? "2026-01-01"}::timestamptz)`);
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("la porta unica del programma in esercizio, sul database", () => {
  const pulisci = async () => {
    // le versioni pubblicate nate dalle messe in esercizio (PR 3.3)
    const versioni = await db.execute<any>(sql`SELECT id FROM ps_projects WHERE versione_del_feed IS NOT NULL AND name LIKE 'Porta unica%'`);
    for (const v of versioni.rows) await db.transaction((tx) => cancellaProgetto(tx, v.id));
    // anche i periodi dei nostri feed già cancellati (il test ne cancella uno)
    await db.execute(sql`DELETE FROM ps_activation_log WHERE feed_id IN ${nostriFeed} OR project_id = ${PROGETTO}::uuid
                           OR feed_id IN (${F_MAIOR}::uuid, ${F_ALTRO}::uuid, ${F_VECCHIO}::uuid, ${F_PRONTO}::uuid)`);
    await db.execute(sql`DELETE FROM ps_pending_activations WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_stop_times WHERE trip_id = ${CORSA}::uuid`);
    await db.execute(sql`DELETE FROM ps_trips WHERE project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM stop_clusters WHERE source_ps_project_id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM ps_projects WHERE id = ${PROGETTO}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id IN ${nostriFeed}`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN}::uuid, ${PIAN}::uuid, ${SOLO_RETE}::uuid)`);
  };

  beforeAll(async () => {
    await pulisci();
    // il database di prova non deve avere un programma in esercizio d'altri: lo cambieremmo
    const altri = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds WHERE is_active`)).rows[0].n;
    if (altri > 0) throw new Error("esercizio-porta-db.test.ts vuole un database senza un feed in esercizio");
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role) VALUES
      (${ADMIN}::uuid, 'porta-admin@prova.local', 'x', 'admin'),
      (${PIAN}::uuid, 'porta-pian@prova.local', 'x', 'user'),
      (${SOLO_RETE}::uuid, 'porta-rete@prova.local', 'x', 'user')`);
    // due feed accesi, di due proprietari, come li lasciava la porta di Planning Studio: la 0019 non lo permette più
    await feed(F_MAIOR, "porta-maior.zip", { acceso: true, caricato: "2026-02-01" });
    await feed(F_ALTRO, "porta-altro.zip", { proprietario: PIAN, caricato: "2026-03-01" });
    await feed(F_VECCHIO, "porta-vecchio.zip", { caricato: "2025-06-01" });
    await db.execute(sql`INSERT INTO ps_activation_log (feed_id, via) VALUES (${F_MAIOR}::uuid, 'prova')`);
    // un progetto piccolo, da mettere in esercizio
    await db.execute(sql`INSERT INTO ps_projects (id, owner_user_id, name) VALUES (${PROGETTO}::uuid, ${PIAN}::uuid, 'Porta unica')`);
    await db.execute(sql`INSERT INTO ps_project_members (project_id, user_id, role) VALUES (${PROGETTO}::uuid, ${SOLO_RETE}::uuid, 'editor')`);
    await db.execute(sql`INSERT INTO ps_stops (id, project_id, name, lat, lon) VALUES
      (${FERMATA_1}::uuid, ${PROGETTO}::uuid, 'Stazione', 43.6075, 13.4977), (${FERMATA_2}::uuid, ${PROGETTO}::uuid, 'Torrette', 43.6040, 13.4510)`);
    await db.execute(sql`INSERT INTO ps_routes (id, project_id, short_name) VALUES (${LINEA}::uuid, ${PROGETTO}::uuid, '1')`);
    await db.execute(sql`INSERT INTO ps_route_variants (id, project_id, route_id, name) VALUES (${PERCORSO}::uuid, ${PROGETTO}::uuid, ${LINEA}::uuid, 'Andata')`);
    await db.execute(sql`INSERT INTO ps_calendars (id, project_id, code, name, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
                         VALUES (${CALENDARIO}::uuid, ${PROGETTO}::uuid, 'FER', 'Feriale', true, true, true, true, true, false, false, '2026-09-14', '2027-06-10')`);
    await db.execute(sql`INSERT INTO ps_trips (id, project_id, route_id, variant_id, calendar_id) VALUES
      (${CORSA}::uuid, ${PROGETTO}::uuid, ${LINEA}::uuid, ${PERCORSO}::uuid, ${CALENDARIO}::uuid)`);
    await db.execute(sql`INSERT INTO ps_stop_times (trip_id, stop_seq, stop_id, arrival_time, departure_time) VALUES
      (${CORSA}::uuid, 1, ${FERMATA_1}::uuid, '07:00:00', '07:00:00'), (${CORSA}::uuid, 2, ${FERMATA_2}::uuid, '07:20:00', '07:20:00')`);
  });
  afterAll(async () => { await pulisci(); await pool.end(); });

  it("la porta: un feed acceso e di default, un periodo aperto con chi e da dove", async () => {
    const esito = await conContesto({ attore: ADMIN, via: "api" },
      () => db.transaction((tx) => mettiInEsercizio(tx, { feedId: F_ALTRO, utenteId: ADMIN })));
    expect(esito).toEqual({ precedente: F_MAIOR, giaInEsercizio: false });
    const s = await stato();
    expect(s.accesi).toEqual([F_ALTRO]);
    expect(s.diDefault).toEqual([F_ALTRO]);
    expect(s.aperti).toEqual([{ feed_id: F_ALTRO, project_id: null, user_id: ADMIN, via: "api" }]);
    const chiuso = (await db.execute<any>(sql`SELECT deactivated_at IS NOT NULL AS chiuso FROM ps_activation_log WHERE feed_id = ${F_MAIOR}::uuid`)).rows;
    expect(chiuso).toEqual([{ chiuso: true }]);
  });

  it("rimettere in esercizio il feed che c'è già non cambia niente", async () => {
    const prima = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_activation_log`)).rows[0].n;
    const esito = await db.transaction((tx) => mettiInEsercizio(tx, { feedId: F_ALTRO, utenteId: ADMIN }));
    expect(esito).toEqual({ precedente: null, giaInEsercizio: true });
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_activation_log`)).rows[0].n).toBe(prima);
  });

  it("un feed che non c'è: rifiutata, e niente cambia", async () => {
    await expect(db.transaction((tx) => mettiInEsercizio(tx, { feedId: u(99), utenteId: ADMIN }))).rejects.toBeInstanceOf(AttivazioneRifiutata);
    expect((await stato()).accesi).toEqual([F_ALTRO]);
    const r = await request(app.admin).post(`/api/gtfs/feeds/${u(99)}/activate`);
    expect(r.status).toBe(404);
    expect((await stato()).accesi).toEqual([F_ALTRO]);
  });

  it("due attivazioni insieme si mettono in fila: alla fine un feed acceso e il suo periodo aperto", async () => {
    for (let giro = 0; giro < 5; giro++) {
      await Promise.all([F_MAIOR, F_VECCHIO, F_ALTRO].map((f) =>
        db.transaction((tx) => mettiInEsercizio(tx, { feedId: f, utenteId: ADMIN }))));
      const s = await stato();
      expect(s.accesi).toHaveLength(1);
      expect(s.diDefault).toEqual(s.accesi);
      expect(s.aperti.map((a: any) => a.feed_id)).toEqual(s.accesi);
    }
  });

  it("«Attiva» nella pagina GTFS passa dalla porta: storico scritto, senza progetto; il feed archiviato torna in esercizio", async () => {
    await db.execute(sql`UPDATE gtfs_feeds SET archived_at = now() WHERE id = ${F_VECCHIO}::uuid`);
    const r = await request(app.admin).post(`/api/gtfs/feeds/${F_VECCHIO}/activate`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await stato();
    expect(s.accesi).toEqual([F_VECCHIO]);
    expect(s.aperti).toEqual([expect.objectContaining({ feed_id: F_VECCHIO, project_id: null, user_id: ADMIN })]);
    const v = (await db.execute<any>(sql`SELECT archived_at FROM gtfs_feeds WHERE id = ${F_VECCHIO}::uuid`)).rows[0];
    expect(v.archived_at).toBeNull();
    // e resta solo dell'amministratore
    expect((await request(app.pianificatore).post(`/api/gtfs/feeds/${F_MAIOR}/activate`)).status).toBe(403);
  });

  it("Metti in esercizio senza la scrittura sulla pubblicazione degli orari: 403, e niente si materializza", async () => {
    const feedPrima = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds`)).rows[0].n;
    const r = await request(app.soloRete).post(`/api/planning-studio/projects/${PROGETTO}/activate`).send({});
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ solaLettura: true });
    expect(r.body.error).toContain("Pubblicazione degli orari");
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM gtfs_feeds`)).rows[0].n).toBe(feedPrima);
    expect((await request(app.soloRete).delete(`/api/planning-studio/projects/${PROGETTO}/activations/pending`)).status).toBe(403);
  });

  it("Metti in esercizio da Planning Studio: il feed del progetto è il solo acceso, lo storico ha progetto e persona", async () => {
    const r = await request(app.pianificatore).post(`/api/planning-studio/projects/${PROGETTO}/activate`).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const nuovo: string = r.body.feedId;
    const s = await stato();
    expect(s.accesi).toEqual([nuovo]);
    expect(s.aperti).toEqual([expect.objectContaining({ feed_id: nuovo, project_id: PROGETTO, user_id: PIAN })]);
    const p = (await db.execute<any>(sql`SELECT materialized_feed_id FROM ps_projects WHERE id = ${PROGETTO}::uuid`)).rows[0];
    expect(p.materialized_feed_id).toBe(nuovo);
    // il feed che c'era prima (non del progetto) è spento, ma non archiviato: non era del progetto
    const vecchio = (await db.execute<any>(sql`SELECT is_active, archived_at FROM gtfs_feeds WHERE id = ${F_VECCHIO}::uuid`)).rows[0];
    expect(vecchio).toEqual({ is_active: false, archived_at: null });

    // una seconda volta: il feed di prima del progetto si archivia
    const ancora = await request(app.pianificatore).post(`/api/planning-studio/projects/${PROGETTO}/activate`).send({});
    expect(ancora.status, JSON.stringify(ancora.body)).toBe(200);
    const precedente = (await db.execute<any>(sql`SELECT is_active, archived_at IS NOT NULL AS archiviato FROM gtfs_feeds WHERE id = ${nuovo}::uuid`)).rows[0];
    expect(precedente).toEqual({ is_active: false, archiviato: true });
    expect((await stato()).accesi).toEqual([ancora.body.feedId]);
  });

  it("l'attivazione programmata, alla decorrenza: tutto in una transazione, dalla porta", async () => {
    const primaDelProgetto = (await db.execute<any>(sql`SELECT materialized_feed_id FROM ps_projects WHERE id = ${PROGETTO}::uuid`)).rows[0].materialized_feed_id;
    await feed(F_PRONTO, `ps-${PROGETTO.slice(0, 8)}-pronto.synthetic`, { proprietario: PIAN, caricato: "2026-04-01" });
    await db.execute(sql`INSERT INTO ps_pending_activations (project_id, feed_id, user_id, effective_from, via)
                         VALUES (${PROGETTO}::uuid, ${F_PRONTO}::uuid, ${PIAN}::uuid, CURRENT_DATE, 'api')`);
    await processPendingActivations();
    const s = await stato();
    expect(s.accesi).toEqual([F_PRONTO]);
    expect(s.aperti).toEqual([expect.objectContaining({ feed_id: F_PRONTO, project_id: PROGETTO, user_id: PIAN, via: "timer:attivazioni" })]);
    expect((await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_pending_activations WHERE project_id = ${PROGETTO}::uuid`)).rows[0].n).toBe(0);
    const prima = (await db.execute<any>(sql`SELECT is_active, archived_at IS NOT NULL AS archiviato FROM gtfs_feeds WHERE id = ${primaDelProgetto}::uuid`)).rows[0];
    expect(prima).toEqual({ is_active: false, archiviato: true });
  });

  it("cancellare il feed in esercizio: solo l'amministratore, forzando; lo storico chiude il periodo", async () => {
    expect((await request(app.pianificatore).delete(`/api/gtfs/feeds/${F_PRONTO}?forza=1`)).status).toBe(403);
    expect((await stato()).accesi).toEqual([F_PRONTO]);
    const r = await request(app.admin).delete(`/api/gtfs/feeds/${F_PRONTO}?forza=1`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = await stato();
    expect(s.accesi).toEqual([]);
    expect(s.aperti).toEqual([]);
    const periodo = (await db.execute<any>(sql`SELECT deactivated_at IS NOT NULL AS chiuso FROM ps_activation_log WHERE feed_id = ${F_PRONTO}::uuid`)).rows;
    expect(periodo).toEqual([{ chiuso: true }]);
  });

  it("cancellare il progetto non porta via lo storico", async () => {
    const prima = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM ps_activation_log WHERE project_id = ${PROGETTO}::uuid`)).rows[0].n;
    expect(prima).toBeGreaterThanOrEqual(3);
    const r = await request(app.pianificatore).delete(`/api/planning-studio/projects/${PROGETTO}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const restano = (await db.execute<any>(sql`
      SELECT count(*)::int AS n FROM ps_activation_log WHERE project_id IS NULL AND feed_id IN ${nostriFeed}`)).rows[0].n;
    expect(restano).toBeGreaterThanOrEqual(prima);
  });
});
