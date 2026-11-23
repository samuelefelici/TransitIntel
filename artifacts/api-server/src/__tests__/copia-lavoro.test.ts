/**
 * Il lavoro della copia del database (tappa 7.23), senza database: la
 * configurazione dall'ambiente, quando è ora della copia della notte, e una
 * copia intera con un pg_dump e un pg_restore finti (script) e lo storage
 * finto: si cifra, si carica, si riscarica uguale, e la copia decifrata con
 * la chiave privata è quella di pg_dump. Il pg_dump finto scrive nella copia
 * il suo ambiente: dentro non c'è nessun segreto dell'app.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decifraFile } from "../../../../lib/db/scripts/copia-cifrata.mjs";
import { dovuta, faiCopia, leggiConfig, nomeCopia, VARIABILI, type ConfigCopia } from "../lib/lavori/copia";
import { ambienteS3, storageFinto, type StorageFinto } from "./helpers/storage-finto";

let s: StorageFinto;
let privata: KeyObject;
let pemPubblica = "";
let cartella = "";

beforeAll(async () => {
  s = await storageFinto();
  const k = generateKeyPairSync("rsa", { modulusLength: 3072 });
  privata = k.privateKey;
  pemPubblica = String(k.publicKey.export({ type: "spki", format: "pem" }));
  cartella = await mkdtemp(path.join(os.tmpdir(), "copia-lavoro-test-"));
  // pg_dump finto: scrive nel --file gli argomenti e l'ambiente che riceve
  await writeFile(path.join(cartella, "pg_dump"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 17.99"; exit 0; fi
for a in "$@"; do case "$a" in --file=*) f="\${a#--file=}";; esac; done
{ echo "PGDMP-finto"; printf '%s\\n' "$@"; env; } > "$f"
`);
  // pg_restore finto: l'elenco di una copia con due tabelle
  await writeFile(path.join(cartella, "pg_restore"), `#!/bin/sh
grep -q PGDMP-finto "$2" || { echo "pg_restore: error: input file is not a valid archive" >&2; exit 1; }
printf ';\\n; Archive created at 2026-11-23\\n;\\n215; 1259 16390 TABLE public users cerbero_owner\\n4000; 0 16390 TABLE DATA public users cerbero_owner\\n4001; 0 16400 TABLE DATA registro modifiche cerbero_registro\\n'
`);
  // un pg_dump che fallisce, come col server più nuovo del client
  await writeFile(path.join(cartella, "pg_dump_rotto"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.4"; exit 0; fi
echo "pg_dump: error: aborting because of server version mismatch" >&2; exit 1
`);
  for (const f of ["pg_dump", "pg_restore", "pg_dump_rotto"]) await chmod(path.join(cartella, f), 0o755);
});
afterAll(async () => {
  await s.chiudi();
  if (cartella) await rm(cartella, { recursive: true, force: true });
});

const ambiente = () => ({
  BACKUP_DATABASE_URL: "postgres://cerbero_backup:pw%40segreta@127.0.0.1:5432/cerbero?sslmode=disable",
  BACKUP_CHIAVE_PUBBLICA: pemPubblica,
  ...ambienteS3(s),
  BACKUP_PG_DUMP: path.join(cartella, "pg_dump"),
  BACKUP_PG_RESTORE: path.join(cartella, "pg_restore"),
});
const pronta = (env: Record<string, string | undefined> = ambiente()): ConfigCopia => {
  const l = leggiConfig(env);
  if (l.stato !== "pronta") throw new Error(`configurazione non pronta: ${JSON.stringify(l)}`);
  return l.config;
};

describe("la configurazione dall'ambiente del lavoratore", () => {
  it("senza variabili è spenta; con una parte sola dice che cosa manca", () => {
    expect(leggiConfig({})).toEqual({ stato: "spenta" });
    expect(leggiConfig({ BACKUP_S3_BUCKET: "x" })).toEqual({ stato: "incompleta", motivo: expect.stringMatching(/^mancano BACKUP_DATABASE_URL, BACKUP_CHIAVE_PUBBLICA,/) });
    expect(VARIABILI).toHaveLength(7);
  });
  it("entra solo come cerbero_backup; chiave e ora controllate", () => {
    const e = ambiente();
    expect(leggiConfig({ ...e, BACKUP_DATABASE_URL: "postgres://postgres:x@db/cerbero" }))
      .toEqual({ stato: "incompleta", motivo: "BACKUP_DATABASE_URL deve entrare come cerbero_backup" });
    expect(leggiConfig({ ...e, BACKUP_DATABASE_URL: "mysql://cerbero_backup:x@db/c" })).toMatchObject({ stato: "incompleta" });
    expect(leggiConfig({ ...e, BACKUP_CHIAVE_PUBBLICA: "abc" })).toMatchObject({ stato: "incompleta", motivo: expect.stringMatching(/^BACKUP_CHIAVE_PUBBLICA: /) });
    expect(leggiConfig({ ...e, BACKUP_ORA: "25" })).toMatchObject({ stato: "incompleta", motivo: expect.stringMatching(/BACKUP_ORA/) });
    expect(leggiConfig({ ...e, BACKUP_S3_ENDPOINT: "ftp://x" })).toMatchObject({ stato: "incompleta" });
  });
  it("pronta: la password fuori dall'indirizzo, l'ora di default alle 3", () => {
    const c = pronta();
    expect(c.url).toBe("postgres://cerbero_backup@127.0.0.1:5432/cerbero?sslmode=disable");
    expect(c.password).toBe("pw@segreta");
    expect(c.ora).toBe(3);
    expect(c.segreti).toContain("pw@segreta");
    expect(pronta({ ...ambiente(), BACKUP_ORA: "0" }).ora).toBe(0);
  });
});

describe("quando è ora della copia della notte", () => {
  const notte = { oraPassata: true, fatte: 0, fallite: 0, minutiDallUltima: null };
  it("dopo l'ora, se oggi non ce n'è una riuscita o in corso", () => {
    expect(dovuta(notte)).toBe(true);
    expect(dovuta({ ...notte, oraPassata: false })).toBe(false);
    expect(dovuta({ ...notte, fatte: 1 })).toBe(false);
  });
  it("dopo una non riuscita aspetta un'ora; dopo tre si ferma fino a domani", () => {
    expect(dovuta({ ...notte, fallite: 1, minutiDallUltima: 30 })).toBe(false);
    expect(dovuta({ ...notte, fallite: 1, minutiDallUltima: 61 })).toBe(true);
    expect(dovuta({ ...notte, fallite: 3, minutiDallUltima: 600 })).toBe(false);
  });
  it("il nome della copia: prefisso, data e ora UTC", () => {
    expect(nomeCopia("cerbero/", new Date("2026-11-23T02:05:09.123Z"))).toBe("cerbero/cerbero-2026-11-23T02-05-09Z.dump.enc");
  });
});

describe("una copia intera, con pg_dump e pg_restore finti", () => {
  it("cifrata, caricata, riscaricata uguale; decifrata è quella di pg_dump", async () => {
    const quando = new Date("2026-11-23T02:00:00Z");
    const prima = (await readdir(os.tmpdir())).filter((f) => f.startsWith("cerbero-copia-"));
    const e = await faiCopia(pronta(), quando);
    expect(e).toMatchObject({ oggetto: "cerbero/cerbero-2026-11-23T02-00-00Z.dump.enc", voci: 3, tabelle: 2, versione: "pg_dump (PostgreSQL) 17.99" });
    const caricata = s.oggetti.get(e.oggetto)!;
    expect(caricata.length).toBe(e.byte);
    expect(s.richieste.filter((r) => r.percorso.endsWith("2026-11-23T02-00-00Z.dump.enc")).map((r) => r.metodo)).toEqual(["PUT", "GET"]);
    // i file temporanei (anche quello in chiaro) non restano
    expect((await readdir(os.tmpdir())).filter((f) => f.startsWith("cerbero-copia-"))).toEqual(prima);

    await writeFile(path.join(cartella, "giu.enc"), caricata);
    await decifraFile(path.join(cartella, "giu.enc"), path.join(cartella, "giu.dump"), privata);
    const testo = await readFile(path.join(cartella, "giu.dump"), "utf8");
    expect(testo.startsWith("PGDMP-finto\n")).toBe(true);
    // gli schemi di Cerbero, e solo quelli; l'indirizzo senza password
    expect(testo).toContain("--schema=public\n--schema=caronte\n--schema=coda\n--schema=registro\n--schema=cerbero_migrazioni\n");
    expect(testo).not.toContain("fleetcare");
    expect(testo).toContain("--dbname=postgres://cerbero_backup@127.0.0.1:5432/cerbero?sslmode=disable\n");
    expect(testo).toContain("PGPASSWORD=pw@segreta\n");
    expect(testo).toContain("PGAPPNAME=cerbero-copia\n");
    // nessun'altra variabile dell'app: né lo storage, né il database dell'app, né altri segreti
    for (const v of ["BACKUP_S3_SECRET_KEY", "DATABASE_URL", "JWT_SECRET", "BACKUP_CHIAVE_PUBBLICA", "segreto-di-prova-1234"]) {
      expect(testo, v).not.toContain(v);
    }
  });

  it("pg_dump che fallisce: l'errore lo dice, e nello storage non va niente", async () => {
    const quanti = s.oggetti.size;
    await expect(faiCopia({ ...pronta(), pgDump: path.join(cartella, "pg_dump_rotto") }, new Date("2026-11-24T02:00:00Z")))
      .rejects.toThrow(/pg_dump_rotto uscito con 1: pg_dump: error: aborting because of server version mismatch/);
    await expect(faiCopia({ ...pronta(), pgDump: path.join(cartella, "non-ce") }, new Date("2026-11-24T02:00:00Z")))
      .rejects.toThrow(/non parte \(ENOENT\)/);
    expect(s.oggetti.size).toBe(quanti);
  });

  it("una copia che nello storage non è quella caricata: errore", async () => {
    s.rovinaProssimaLettura = Buffer.from("altro");
    await expect(faiCopia(pronta(), new Date("2026-11-25T02:00:00Z"))).rejects.toThrow(/la copia riscaricata non è quella caricata/);
  });

  it("uno storage che rifiuta le credenziali: errore col codice, senza il segreto", async () => {
    const c = pronta();
    const err = await faiCopia({ ...c, s3: { ...c.s3, segreto: "un-altro-segreto" } }, new Date("2026-11-26T02:00:00Z")).catch((e) => e);
    expect(String(err.message)).toMatch(/403 \(SignatureDoesNotMatch\) a PUT/);
    expect(String(err.message)).not.toContain("un-altro-segreto");
  });
});
