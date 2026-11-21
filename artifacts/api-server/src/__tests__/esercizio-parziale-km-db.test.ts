/**
 * Una corsa segnata parziale senza i km scritti prende i km fatti dalle prove
 * dell'AVM (PR 7.4): la parte di percorso fino all'ultima fermata vista,
 * misurata lungo le fermate della corsa nel feed congelato della giornata.
 * Prima restava senza km e la giornata non si chiudeva, anche se il campo
 * diceva «da calcolare». Senza prove resta senza km, come prima.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { registraEvento, type Richiesta } from "../lib/esercizio-giornale";

const CAPO = "f7400000-0000-4000-8000-000000000001";
const FEED = "f7400000-0000-4000-8000-0000000000fe";
const G = "2026-05-12";

const evento = (r: Partial<Richiesta> & { tipo: Richiesta["tipo"] }) =>
  registraEvento(G, { fonte: "movimento", ...r } as Richiesta, { id: CAPO });
const km = async (chiave: string) =>
  (await db.execute<any>(sql`SELECT km_eff::float AS k FROM esercizio_corse WHERE giorno = ${G}::date AND chiave = ${chiave}`)).rows[0].k;

describe.runIf(!!process.env.TEST_DATABASE_URL)("i km fatti di una parziale, dalle prove dell'AVM", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_eventi WHERE giorno = ${G}::date`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno = ${G}::date`);
    await db.execute(sql`DELETE FROM gtfs_stop_times WHERE feed_id = ${FEED}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_stops WHERE feed_id = ${FEED}::uuid`);
    await db.execute(sql`DELETE FROM gtfs_feeds WHERE id = ${FEED}::uuid`);
    await db.execute(sql`DELETE FROM users WHERE id = ${CAPO}::uuid`);
  };

  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES (${CAPO}::uuid, 'parziale@prova.local', 'x', 'user', 'Movimento di prova')`);
    await db.execute(sql`INSERT INTO gtfs_feeds (id, filename) VALUES (${FEED}::uuid, 'parziale-di-prova.zip')`);
    // tre fermate sullo stesso meridiano: la seconda a un terzo della strada, la terza in fondo
    await db.execute(sql`INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon) VALUES
      (${FEED}::uuid, 'A', 'Capolinea', 45, 9), (${FEED}::uuid, 'B', 'Mezzo', 45 + 1 / 100.0, 9), (${FEED}::uuid, 'C', 'Fondo', 45 + 3 / 100.0, 9)`);
    await db.execute(sql`INSERT INTO gtfs_stop_times (feed_id, trip_id, stop_id, stop_sequence) VALUES
      (${FEED}::uuid, 'c1', 'A', 1), (${FEED}::uuid, 'c1', 'B', 2), (${FEED}::uuid, 'c1', 'C', 3),
      (${FEED}::uuid, 'c2', 'A', 1), (${FEED}::uuid, 'c2', 'B', 2), (${FEED}::uuid, 'c2', 'C', 3)`);
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, turni, feed_id)
      VALUES (${G}::date, 'congelata', 2, now() - interval '1 day', now(), '{}'::jsonb, ${FEED}::uuid)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, linea, partenza, km_prog, proposta, prove) VALUES
      (${G}::date, 'c1', '1', '1', '07:00:00', 9, 'parziale', '{"prima": 1, "ultima": 2, "programmate": 3}'::jsonb),
      (${G}::date, 'c2', '2', '1', '08:00:00', 9, NULL, NULL)`);
  });
  afterAll(pulisci);

  it("senza km scritti: la parte fino all'ultima fermata vista, sui km programmati", async () => {
    await evento({ tipo: "esito", versione: 0, chiavi: ["c1"], esito: "parziale", causale: "GUASTO_MEZZO" });
    expect(await km("c1")).toBeCloseTo(3, 2); // un terzo di 9 km
  });

  it("i km scritti valgono loro; senza prove dell'AVM restano da scrivere", async () => {
    await evento({ tipo: "esito", versione: 1, chiavi: ["c1"], esito: "parziale", causale: "GUASTO_MEZZO", kmEff: 5 });
    expect(await km("c1")).toBe(5);
    await evento({ tipo: "esito", versione: 2, chiavi: ["c2"], esito: "parziale", causale: "GUASTO_MEZZO" });
    expect(await km("c2")).toBeNull();
  });
});
