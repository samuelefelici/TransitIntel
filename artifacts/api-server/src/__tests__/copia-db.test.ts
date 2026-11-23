/**
 * La copia del database fuori dal server (tappa 7.23), sul database
 * (TEST_DATABASE_URL; in CI come cerbero_app): le rotte dell'amministratore,
 * la copia chiesta a mano, quella della notte con i suoi tentativi, quella
 * rimasta a metà. La copia vera e propria qui è finta (`fai`): quella con
 * pg_dump è in copia-lavoro.test.ts con strumenti finti, e in fondo con
 * quelli veri quando ci sono (TEST_PG_DUMP, TEST_PG_RESTORE e
 * TEST_BACKUP_DATABASE_URL di cerbero_backup).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pool, PoolConContesto } from "@workspace/db";
import adminRouter from "../routes/admin";
import { decifraFile } from "../../../../lib/db/scripts/copia-cifrata.mjs";
import { faiCopia, nonLeggibili, passaggioCopie, leggiConfig, type ConfigCopia, type EsitoCopia, type StatoConfig } from "../lib/lavori/copia";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { ambienteS3, storageFinto, type StorageFinto } from "./helpers/storage-finto";

const u = (n: number) => `e7b00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, UTENTE] = [u(1), u(2)];
const admin = request(appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin")));
const utente = request(appDiProva(adminRouter, utenteDiProva(UTENTE, ["scheduling"], "user")));
const log = { info() {}, warn() {}, error() {} };

const chiave = generateKeyPairSync("rsa", { modulusLength: 3072 });
const PRONTA = {
  stato: "pronta",
  config: { url: "postgres://cerbero_backup@x/y", password: "pw-segreta", chiave: chiave.publicKey, ora: 3, pgDump: "pg_dump", pgRestore: "pg_restore",
    segreti: ["pw-segreta"], s3: { endpoint: "http://127.0.0.1:1", regione: "r", bucket: "b", prefisso: "cerbero/", stile: "percorso", accesso: "a", segreto: "s" } },
} as StatoConfig;
const finta = (esito: Partial<EsitoCopia> = {}) =>
  async (_c: ConfigCopia, quando: Date, saltare: { schema: string; nome: string }[] = []): Promise<EsitoCopia> => ({
    oggetto: `cerbero/prova-${quando.toISOString()}.dump.enc`, byte: 1234, sha256: "a".repeat(64), voci: 10, tabelle: 4, versione: "pg_dump 17",
    escluse: saltare.map((r) => `${r.schema}.${r.nome}`), ...esito,
  });
const rotta = async (): Promise<EsitoCopia> => { throw new Error("storage non raggiungibile: ECONNREFUSED (segreto pw-segreta)"); };
const righe = async () => (await pool.query("SELECT stato, chiesta_da, errore, oggetto FROM backup_copie ORDER BY creata_il, iniziata_il")).rows;
const svuota = () => pool.query("DELETE FROM backup_copie");

describe.runIf(!!process.env.TEST_DATABASE_URL)("le copie del database, sul database", () => {
  beforeAll(async () => {
    await svuota();
    await pool.query("DELETE FROM users WHERE id = $1", [ADMIN]);
    await pool.query("INSERT INTO users (id, email, password_hash, full_name, role) VALUES ($1, 'copie-7-23@prova.test', 'x', 'Amministratrice di prova', 'admin')", [ADMIN]);
  });
  afterAll(async () => {
    await svuota();
    await pool.query("DELETE FROM users WHERE id = $1", [ADMIN]);
  });

  it("le rotte sono solo dell'amministratore", async () => {
    expect((await utente.get("/api/admin/copie")).status).toBe(403);
    expect((await utente.post("/api/admin/copie").send({})).status).toBe(403);
    const r = await admin.get("/api/admin/copie");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ copie: [], ultimaRiuscita: null });
  });

  it("una copia chiesta senza la configurazione nel lavoratore: non riuscita, col motivo", async () => {
    const r = await admin.post("/api/admin/copie").send({});
    expect(r.status).toBe(202);
    // una seconda mentre la prima aspetta: no
    expect((await admin.post("/api/admin/copie").send({})).status).toBe(409);
    expect(await passaggioCopie(log, { stato: "spenta" }, new Date())).toBe("spenta");
    const [c] = await righe();
    expect(c.stato).toBe("fallita");
    expect(c.errore).toMatch(/non è impostata nel lavoratore: mancano le variabili BACKUP_DATABASE_URL/);
    await svuota();
  });

  it("una copia chiesta, col lavoratore impostato: riuscita, e la pagina la vede", async () => {
    await admin.post("/api/admin/copie").send({});
    expect(await passaggioCopie(log, PRONTA, new Date("2099-01-10T10:00:00Z"), finta())).toBe("riuscita");
    const r = await admin.get("/api/admin/copie");
    expect(r.body.copie).toHaveLength(1);
    expect(r.body.copie[0]).toMatchObject({ stato: "riuscita", byte: 1234, tabelle: 4, versione: "pg_dump 17", chiestaDa: "Amministratrice di prova" });
    expect(r.body.ultimaRiuscita.id).toBe(r.body.copie[0].id);
    await svuota();
  });

  it("la copia della notte: dopo l'ora di Roma, una al giorno", async () => {
    // 01:30 a Roma (inverno, UTC+1): troppo presto
    expect(await passaggioCopie(log, PRONTA, new Date("2099-01-15T00:30:00Z"), finta())).toBe("niente da fare");
    // 03:05 a Roma
    expect(await passaggioCopie(log, PRONTA, new Date("2099-01-15T02:05:00Z"), finta())).toBe("riuscita");
    // più tardi lo stesso giorno: già fatta
    expect(await passaggioCopie(log, PRONTA, new Date("2099-01-15T20:00:00Z"), finta())).toBe("niente da fare");
    // il giorno dopo
    expect(await passaggioCopie(log, PRONTA, new Date("2099-01-16T02:01:00Z"), finta())).toBe("riuscita");
    expect((await righe()).map((r) => [r.stato, r.chiesta_da])).toEqual([["riuscita", null], ["riuscita", null]]);
    await svuota();
  });

  it("non riuscita: si riprova dopo un'ora, al più tre volte; l'errore senza segreti", async () => {
    expect(await passaggioCopie(log, PRONTA, new Date("2099-02-01T02:01:00Z"), rotta)).toBe("fallita");
    expect(await passaggioCopie(log, PRONTA, new Date("2099-02-01T02:31:00Z"), rotta)).toBe("niente da fare");
    expect(await passaggioCopie(log, PRONTA, new Date("2099-02-01T03:02:00Z"), rotta)).toBe("fallita");
    expect(await passaggioCopie(log, PRONTA, new Date("2099-02-01T04:03:00Z"), rotta)).toBe("fallita");
    expect(await passaggioCopie(log, PRONTA, new Date("2099-02-01T09:00:00Z"), rotta)).toBe("niente da fare");
    const r = await righe();
    expect(r.map((x) => x.stato)).toEqual(["fallita", "fallita", "fallita"]);
    expect(r[0].errore).toBe("storage non raggiungibile: ECONNREFUSED (segreto ***)");
    // una chiesta a mano invece si fa
    await admin.post("/api/admin/copie").send({});
    expect(await passaggioCopie(log, PRONTA, new Date("2099-02-01T09:01:00Z"), finta())).toBe("riuscita");
    await svuota();
  });

  it.runIf(!!process.env.TEST_DATABASE_MIGRATOR_URL)("una tabella che cerbero_backup non legge (un avanzo di un superutente) si salta, e l'esito lo dice", async () => {
    const migratore = new PoolConContesto({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 1 });
    try {
      await migratore.query("DROP TABLE IF EXISTS public.copia_avanzo_723; CREATE TABLE public.copia_avanzo_723 (x int)");
      expect((await nonLeggibili()).map((r) => `${r.schema}.${r.nome}`)).toContain("public.copia_avanzo_723");
      await admin.post("/api/admin/copie").send({});
      expect(await passaggioCopie(log, PRONTA, new Date("2099-04-01T10:00:00Z"), finta())).toBe("riuscita");
      const r = await admin.get("/api/admin/copie");
      expect(r.body.copie[0].escluse).toContain("public.copia_avanzo_723");
    } finally {
      await migratore.query("DROP TABLE IF EXISTS public.copia_avanzo_723");
      await migratore.end();
    }
    await svuota();
  });

  it("una copia rimasta in corso (lavoratore fermato) diventa interrotta dopo tre ore; due insieme no", async () => {
    await pool.query("INSERT INTO backup_copie (stato, creata_il, iniziata_il) VALUES ('in_corso', '2099-03-01T02:00:00Z', '2099-03-01T02:00:00Z')");
    // un'altra intanto aspetta: l'indice unico ne tiene una in corso alla volta
    await admin.post("/api/admin/copie").send({});
    expect(await passaggioCopie(log, PRONTA, new Date("2099-03-01T03:00:00Z"), finta())).toBe("già in corso");
    expect(await passaggioCopie(log, PRONTA, new Date("2099-03-01T05:30:00Z"), finta())).toBe("riuscita");
    const r = await righe();
    expect(r.map((x) => x.stato).sort()).toEqual(["interrotta", "riuscita"]);
    expect(r.find((x) => x.stato === "interrotta").errore).toMatch(/fermato durante la copia/);
    await svuota();
  });
});

/*
 * Con gli strumenti veri: pg_dump e pg_restore della versione del server, e
 * l'indirizzo di cerbero_backup con una password (il migratore crea il ruolo
 * NOLOGIN: la password e l'accesso li dà chi prova). Si decifra e si guarda
 * l'elenco: ci sono il registro e le migrazioni, e solo gli schemi di Cerbero.
 */
describe.runIf(!!(process.env.TEST_DATABASE_URL && process.env.TEST_PG_DUMP && process.env.TEST_PG_RESTORE && process.env.TEST_BACKUP_DATABASE_URL))(
  "una copia vera del database di prova", () => {
    let s: StorageFinto;
    let cartella = "";
    beforeAll(async () => {
      s = await storageFinto();
      cartella = await mkdtemp(path.join(os.tmpdir(), "copia-vera-"));
    });
    afterAll(async () => {
      await s?.chiudi();
      if (cartella) await rm(cartella, { recursive: true, force: true });
    });

    it("pg_dump come cerbero_backup, cifrata, caricata, riscaricata; decifrata si legge", async () => {
      const l = leggiConfig({
        BACKUP_DATABASE_URL: process.env.TEST_BACKUP_DATABASE_URL,
        BACKUP_CHIAVE_PUBBLICA: String(chiave.publicKey.export({ type: "spki", format: "pem" })),
        BACKUP_PG_DUMP: process.env.TEST_PG_DUMP, BACKUP_PG_RESTORE: process.env.TEST_PG_RESTORE,
        ...ambienteS3(s),
      });
      expect(l.stato).toBe("pronta");
      if (l.stato !== "pronta") return;
      const migratore = process.env.TEST_DATABASE_MIGRATOR_URL
        ? new PoolConContesto({ connectionString: process.env.TEST_DATABASE_MIGRATOR_URL, max: 1 }) : null;
      await migratore?.query("DROP TABLE IF EXISTS public.copia_avanzo_723; CREATE TABLE public.copia_avanzo_723 (x int)");
      let e: EsitoCopia;
      try {
        e = await faiCopia(l.config, new Date(), await nonLeggibili());
      } finally {
        await migratore?.query("DROP TABLE IF EXISTS public.copia_avanzo_723");
        await migratore?.end();
      }
      expect(e.tabelle).toBeGreaterThan(100);
      if (migratore) expect(e.escluse).toContain("public.copia_avanzo_723");
      await writeFile(path.join(cartella, "c.enc"), s.oggetti.get(e.oggetto)!);
      await decifraFile(path.join(cartella, "c.enc"), path.join(cartella, "c.dump"), chiave.privateKey);
      const elenco = execFileSync(process.env.TEST_PG_RESTORE!, ["--list", path.join(cartella, "c.dump")], { encoding: "utf8" });
      // il registro (le partizioni del mese), le migrazioni, gli utenti
      expect(elenco).toMatch(/ TABLE DATA registro modifiche_\d{4}_\d{2} /);
      expect(elenco).toMatch(/ TABLE DATA cerbero_migrazioni __drizzle_migrations /);
      expect(elenco).toMatch(/ TABLE DATA public users /);
      // solo gli schemi di Cerbero
      const schemi = new Set([...elenco.matchAll(/^\d+; \d+ \d+ SCHEMA - (\S+) /gm)].map((m) => m[1]));
      expect([...schemi].sort()).toEqual(["caronte", "cerbero_migrazioni", "coda", "public", "registro"]);
      expect(elenco).not.toMatch(/copia_avanzo_723/);
    }, 120_000);
  });
