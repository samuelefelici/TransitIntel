/**
 * Le pulizie del lavoratore (lib/lavori/pulizie.ts).
 * - Senza database: ogni colonna che punta a un feed (feed_id, *_feed_id nel
 *   catalogo atteso) è o un uso (il feed non è orfano) o una riga del feed
 *   stesso. Una colonna nuova non classificata fa fallire il test.
 * - Sul database (TEST_DATABASE_URL, migrato): quali feed sintetici sono
 *   orfani, il tetto per giro, i calcoli delle tariffe appesi, il lucchetto.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import {
  USI_DEL_FEED, RIGHE_DEL_FEED, chiudiRunAppesi, feedOrfani, cancellaFeedOrfani, eseguiPulizie,
} from "../lib/lavori/pulizie";
import { nomeCaricato } from "../lib/materializzazione/usi-feed";

const CATALOGO = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../lib/db/migrations/meta/catalogo.json", import.meta.url)), "utf8"));

describe("le pulizie conoscono ogni colonna che punta a un feed", () => {
  it("ogni feed_id / *_feed_id del catalogo è un uso o una riga del feed", () => {
    const note = new Set(USI_DEL_FEED.map(([t, c]) => `${t}.${c}`).concat(RIGHE_DEL_FEED.map(t => `${t}.feed_id`)));
    const colonne: string[] = [];
    for (const [tabella, cols] of Object.entries<Record<string, string>>(CATALOGO.tabelle)) {
      if (!tabella.startsWith("public.") || tabella === "public.gtfs_feeds") continue;
      for (const c of Object.keys(cols)) if (c === "feed_id" || c.endsWith("_feed_id")) colonne.push(`${tabella.slice(7)}.${c}`);
    }
    expect(colonne.length).toBeGreaterThan(30);
    expect(colonne.filter(c => !note.has(c))).toEqual([]);
    // e niente di inventato: ogni voce esiste nel catalogo
    expect([...note].filter(n => !colonne.includes(n))).toEqual([]);
  });

  it("un GTFS caricato col nome di un feed sintetico prende «.zip»: le pulizie non lo scambiano", () => {
    expect(nomeCaricato("ps-rete-2026.synthetic")).toBe("ps-rete-2026.synthetic.zip");
    expect(nomeCaricato("orari.zip")).toBe("orari.zip");
    expect(nomeCaricato("PS-rete.SYNTHETIC")).toBe("PS-rete.SYNTHETIC");
  });
});

/* le pulizie del test toccano solo i feed ps-pul… (e i run dei loro feed): il database di prova può avere altri dati */
const MIEI = { filename: "ps-pul%" };

const U = "30000000-0000-0000-0000-000000000001";
const log = { righe: [] as any[], info(...a: any[]) { this.righe.push(["info", ...a]); }, warn(...a: any[]) { this.righe.push(["warn", ...a]); }, error(...a: any[]) { this.righe.push(["error", ...a]); } };

async function feed(nome: string, giorni: number, extra: { attivo?: boolean; default?: boolean; archiviato?: boolean } = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO gtfs_feeds (filename, is_active, is_default, archived_at, uploaded_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END, now() - make_interval(days => $5)) RETURNING id`,
    [nome, !!extra.attivo, !!extra.default, !!extra.archiviato, giorni]);
  const id = r.rows[0].id;
  await pool.query(
    `INSERT INTO gtfs_stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, wheelchair_boarding) VALUES ($1, 'S1', 'Piazza', 43.6, 13.5, 2)`, [id]);
  return id;
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("le pulizie, sul database", () => {
  const pulisci = async () => {
    await pool.query("DELETE FROM scheduling_projects WHERE owner_user_id = $1", [U]);
    await pool.query("DELETE FROM planning_pois WHERE name = 'POI di prova pulizie'");
    await pool.query("DELETE FROM coda.lavori WHERE metadati->>'prova' = 'pulizie'");
    await pool.query("DELETE FROM gtfs_feeds WHERE filename LIKE 'ps-pul%' OR filename IN ('pulizie-vero.zip', 'pulizie-esercizio.zip')");
    await pool.query("DELETE FROM users WHERE id = $1", [U]);
  };
  beforeEach(async () => {
    await pulisci();
    log.righe.length = 0;
    await pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, 'pulizie@prova.local', 'x')", [U]);
    // il feed in esercizio: senza, le pulizie non cancellano niente (l'API ripiegherebbe sull'ultimo caricato)
    await pool.query("INSERT INTO gtfs_feeds (filename, is_active, uploaded_at) VALUES ('pulizie-esercizio.zip', true, now() - interval '60 days')");
  });
  afterAll(pulisci);

  it("orfano solo il feed sintetico vecchio che nessuno usa; la cancellazione porta via le sue righe", async () => {
    const orfano = await feed("ps-pul00001.synthetic", 3);
    await feed("ps-pul00002.synthetic", 1); // troppo giovane
    // il feed in esercizio è uno solo (0019, PR 3.2): qui è un sintetico, al posto di «pulizie-esercizio.zip»
    await pool.query("UPDATE gtfs_feeds SET is_active = false WHERE filename = 'pulizie-esercizio.zip'");
    await feed("ps-pul00003.synthetic", 3, { attivo: true });
    await feed("ps-pul00004.synthetic", 3, { default: true });
    await feed("ps-pul00005.synthetic", 3, { archiviato: true }); // un esercizio sostituito: resta
    await feed("pulizie-vero.zip", 30); // un GTFS caricato a mano: mai
    const delProgetto = await feed("ps-pul00006.synthetic", 3);
    await pool.query("INSERT INTO scheduling_projects (owner_user_id, name, feed_id) VALUES ($1, 'Progetto', $2)", [U, delProgetto]);
    const conPoi = await feed("ps-pul00007.synthetic", 3);
    await pool.query("INSERT INTO planning_pois (feed_id, name, category, lat, lng) VALUES ($1, 'POI di prova pulizie', 'scuola', 43.6, 13.5)", [conPoi]);

    const trovati = (await feedOrfani(pool as any, 2, 5, MIEI)).map(f => f.id);
    expect(trovati).toEqual([orfano]);

    const c = await pool.connect();
    const cancellati = await cancellaFeedOrfani(c as any, log, 2, 5, MIEI).finally(() => c.release());
    expect(cancellati).toContain(orfano);
    expect(cancellati).not.toContain(delProgetto);
    expect((await pool.query("SELECT count(*)::int AS n FROM gtfs_stops WHERE feed_id = $1", [orfano])).rows[0].n).toBe(0);
    const restano = (await pool.query("SELECT filename FROM gtfs_feeds WHERE filename LIKE 'ps-pul%' OR filename = 'pulizie-vero.zip' ORDER BY 1")).rows.map(r => r.filename);
    expect(restano).toEqual([
      "ps-pul00002.synthetic", "ps-pul00003.synthetic", "ps-pul00004.synthetic", "ps-pul00005.synthetic",
      "ps-pul00006.synthetic", "ps-pul00007.synthetic", "pulizie-vero.zip",
    ]);
    expect(log.righe.some(r => r[0] === "info" && r[1]?.feedId === orfano)).toBe(true);
  });

  it("al più 5 feed a giro, i più vecchi prima", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await feed(`ps-pul1000${i}.synthetic`, 10 - i));
    const c = await pool.connect();
    try {
      expect(await cancellaFeedOrfani(c as any, log, 2, 5, MIEI)).toEqual(ids.slice(0, 5));
      expect(await cancellaFeedOrfani(c as any, log, 2, 5, MIEI)).toEqual(ids.slice(5));
    } finally { c.release(); }
  });

  it("i calcoli delle tariffe «running» da oltre 24 ore diventano «error»; gli altri no", async () => {
    const f = await feed("pulizie-vero.zip", 30);
    const run = async (tabella: string, ore: number, stato = "running") =>
      (await pool.query(`INSERT INTO ${tabella} (feed_id, status, started_at) VALUES ($1, $2, now() - make_interval(hours => $3)) RETURNING id`, [f, stato, ore])).rows[0].id;
    const vecchio = await run("gtfs_fare_od_matrix_runs", 25);
    const recente = await run("gtfs_fare_od_matrix_runs", 1);
    const nodi = await run("gtfs_fare_node_assignment_runs", 48);
    const finito = await run("gtfs_fare_node_assignment_runs", 48, "success");
    // un filtro sul nome che non prende questo feed non chiude niente
    expect(await chiudiRunAppesi(pool as any, 24, MIEI)).toEqual({ odMinima: 0, assegnazioneNodi: 0 });
    expect(await chiudiRunAppesi(pool as any, 24, { feedIds: [f] })).toEqual({ odMinima: 1, assegnazioneNodi: 1 });
    const stato = async (t: string, id: string) => (await pool.query(`SELECT status, error_message, finished_at FROM ${t} WHERE id = $1`, [id])).rows[0];
    expect(await stato("gtfs_fare_od_matrix_runs", vecchio)).toMatchObject({ status: "error", error_message: expect.stringContaining("rilancialo") });
    expect((await stato("gtfs_fare_od_matrix_runs", vecchio)).finished_at).not.toBeNull();
    expect((await stato("gtfs_fare_od_matrix_runs", recente)).status).toBe("running");
    expect((await stato("gtfs_fare_node_assignment_runs", nodi)).status).toBe("error");
    expect((await stato("gtfs_fare_node_assignment_runs", finito)).status).toBe("success");
  });

  it("non è orfano un feed letto da un calcolo vivo in coda, né uno di uno scenario dei turni; i parametri economici non contano", async () => {
    const letto = await feed("ps-pul30001.synthetic", 5);
    const scenario = await feed("ps-pul30002.synthetic", 5);
    const conParametri = await feed("ps-pul30003.synthetic", 5);
    await pool.query(`INSERT INTO coda.lavori (tipo, versione, corsia, richiesta, metadati, timeout_sec)
                      VALUES ('ottimizza_veicoli', 1, 'veloce', $1, '{"prova":"pulizie"}', 60)`, [JSON.stringify({ mode: "cpsat", feedId: letto })]);
    await pool.query(`INSERT INTO service_program_scenarios (name, date, input, result, feed_id) VALUES ('Turni pulizie', '20261104', '{}', '{}', $1)`, [scenario]);
    // la scheda «Pianificazione» li crea già leggendo: non tengono in vita il feed
    await pool.query("INSERT INTO gtfs_feed_economic_params (feed_id) VALUES ($1)", [conParametri]);
    try {
      expect((await feedOrfani(pool as any, 2, 5, MIEI)).map(f => f.id)).toEqual([conParametri]);
      await pool.query("UPDATE coda.lavori SET stato = 'completato', finito_il = now() WHERE metadati->>'prova' = 'pulizie'");
      expect((await feedOrfani(pool as any, 2, 5, MIEI)).map(f => f.id).sort()).toEqual([conParametri, letto].sort());
    } finally {
      await pool.query("DELETE FROM service_program_scenarios WHERE name = 'Turni pulizie'");
    }
  });

  it("senza un feed in esercizio non si cancella niente", async () => {
    await feed("ps-pul40001.synthetic", 5);
    expect((await feedOrfani(pool as any, 2, 5, MIEI)).length).toBe(1);
    // in una transazione annullata: gli altri test sullo stesso database non vedono niente
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("UPDATE gtfs_feeds SET is_active = false WHERE is_active");
      expect(await feedOrfani(c as any, 2, 5, MIEI)).toEqual([]);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("un giro alla volta: col lucchetto preso da un altro processo si salta", async () => {
    const altro = await pool.connect();
    try {
      await altro.query("SELECT pg_advisory_lock(hashtextextended('cerbero:pulizie', 0))");
      expect(await eseguiPulizie(log, MIEI)).toEqual({ saltato: true });
      await altro.query("SELECT pg_advisory_unlock(hashtextextended('cerbero:pulizie', 0))");
      const orfano = await feed("ps-pul20000.synthetic", 5);
      const r = await eseguiPulizie(log, MIEI);
      expect(r.saltato).toBe(false);
      expect(r.feedCancellati).toContain(orfano);
    } finally { altro.release(); }
  });
});
