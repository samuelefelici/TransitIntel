/**
 * La copia del database fuori dal server (tappa 7.23): la firma delle
 * richieste S3 sugli esempi pubblicati da AWS, la cifratura (andata e
 * ritorno, alterazioni, chiave sbagliata o debole) e le tre operazioni sullo
 * storage contro uno storage finto che controlla firma e SHA-256 del corpo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import {
  HASH_VUOTO, MAGIA, carica, chiavePrivata, chiavePubblica, cifratore, configS3, contatore, decifraFile, elenca, firma,
  leggiIntestazione, scaricaInFile, senzaSegreti, urlOggetto,
} from "../../../../lib/db/scripts/copia-cifrata.mjs";
import { storageFinto, type StorageFinto } from "./helpers/storage-finto";

const AWS = { accesso: "AKIAIOSFODNN7EXAMPLE", segreto: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", regione: "us-east-1", quando: new Date("2013-05-24T00:00:00Z") }; // scan-ok: le credenziali d'esempio pubblicate da AWS nella documentazione di Signature Version 4

describe("la firma delle richieste S3 (Signature Version 4), sugli esempi di AWS", () => {
  it("GET di un oggetto con Range", () => {
    const f = firma({ metodo: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", intestazioni: { Range: "bytes=0-9" }, hashCorpo: HASH_VUOTO, ...AWS });
    expect(f.firma).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(f.intestazioni.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " // scan-ok: esempio pubblicato da AWS
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });
  it("PUT di un oggetto con un carattere da codificare nel nome", () => {
    const corpo = createHash("sha256").update("Welcome to Amazon S3.").digest("hex");
    const f = firma({ metodo: "PUT", url: "https://examplebucket.s3.amazonaws.com/test$file.text",
      intestazioni: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, hashCorpo: corpo, ...AWS });
    expect(f.firma).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    expect(f.percorso).toBe("/test%24file.text");
  });
  it("GET dell'elenco con i parametri, e di una sottorisorsa senza valore", () => {
    expect(firma({ metodo: "GET", url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", hashCorpo: HASH_VUOTO, ...AWS }).firma)
      .toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
    expect(firma({ metodo: "GET", url: "https://examplebucket.s3.amazonaws.com/?lifecycle", hashCorpo: HASH_VUOTO, ...AWS }).firma)
      .toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });
});

let pubblica: KeyObject;
let privata: KeyObject;
let altra: KeyObject;
let pemPubblica = "";
let pemPrivata = "";
let cartella = "";

beforeAll(async () => {
  const k = generateKeyPairSync("rsa", { modulusLength: 3072 });
  pubblica = k.publicKey;
  privata = k.privateKey;
  altra = generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey;
  pemPubblica = String(pubblica.export({ type: "spki", format: "pem" }));
  pemPrivata = String(privata.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "frase di prova" }));
  cartella = await mkdtemp(path.join(os.tmpdir(), "copia-cifrata-test-"));
});
afterAll(async () => { if (cartella) await rm(cartella, { recursive: true, force: true }); });

async function cifraFile(da: string, a: string, chiave: KeyObject) {
  const c = contatore();
  await pipeline(createReadStream(da), cifratore(chiave), c, createWriteStream(a));
  return c.risultato();
}

describe("le chiavi", () => {
  it("la pubblica si legge come PEM, con «\\n» scritti, o in base64; RSA di almeno 3072 bit", () => {
    expect(chiavePubblica(pemPubblica).asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(() => chiavePubblica(pemPubblica.replace(/\n/g, "\\n"))).not.toThrow();
    expect(() => chiavePubblica(Buffer.from(pemPubblica).toString("base64"))).not.toThrow();
    const debole = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
    expect(() => chiavePubblica(String(debole))).toThrow(/2048 bit: ne servono almeno 3072/);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" });
    expect(() => chiavePubblica(String(ec))).toThrow(/serve una chiave RSA/);
    expect(() => chiavePubblica("non è una chiave")).toThrow(/non si legge/);
    expect(() => chiavePubblica("")).toThrow(/manca/);
  });
  it("la privata protetta si apre solo con la frase", () => {
    expect(() => chiavePrivata(pemPrivata, "frase sbagliata")).toThrow(/frase sbagliata o mancante/);
    expect(chiavePrivata(pemPrivata, "frase di prova").asymmetricKeyType).toBe("rsa");
  });
});

describe("cifrare e decifrare", () => {
  it("andata e ritorno: gli stessi byte; l'intestazione dice il formato, e niente in chiaro", async () => {
    const dati = Buffer.concat([randomBytes(700_000), Buffer.from("PGDMP riga in chiaro riconoscibile")]);
    await writeFile(path.join(cartella, "a.dump"), dati);
    const { byte, sha256 } = await cifraFile(path.join(cartella, "a.dump"), path.join(cartella, "a.enc"), pubblica);
    const cifrata = await readFile(path.join(cartella, "a.enc"));
    expect(byte).toBe(cifrata.length);
    expect(sha256).toBe(createHash("sha256").update(cifrata).digest("hex"));
    expect(cifrata.subarray(0, MAGIA.length).equals(MAGIA)).toBe(true);
    expect(cifrata.includes(Buffer.from("riga in chiaro riconoscibile"))).toBe(false);
    // 16 + 32 + 2 + 384 (RSA 3072) + 12 di intestazione, 16 di tag
    expect(leggiIntestazione(cifrata).lunghezza).toBe(446);
    expect(cifrata.length).toBe(dati.length + 446 + 16);
    await decifraFile(path.join(cartella, "a.enc"), path.join(cartella, "a.di-nuovo"), chiavePrivata(pemPrivata, "frase di prova"));
    expect((await readFile(path.join(cartella, "a.di-nuovo"))).equals(dati)).toBe(true);
  });

  it("un file vuoto si cifra e si decifra", async () => {
    await writeFile(path.join(cartella, "v.dump"), Buffer.alloc(0));
    await cifraFile(path.join(cartella, "v.dump"), path.join(cartella, "v.enc"), pubblica);
    await decifraFile(path.join(cartella, "v.enc"), path.join(cartella, "v.di-nuovo"), privata);
    expect((await stat(path.join(cartella, "v.di-nuovo"))).size).toBe(0);
  });

  it("un byte cambiato nei dati, nell'intestazione o nel tag: errore, e niente file decifrato", async () => {
    const originale = await readFile(path.join(cartella, "a.enc"));
    for (const [nome, posizione] of [["dati", 300_000], ["intestazione (IV)", 440], ["tag", originale.length - 3]] as const) {
      const rotta = Buffer.from(originale);
      rotta[posizione] ^= 0x01;
      await writeFile(path.join(cartella, "rotta.enc"), rotta);
      await expect(decifraFile(path.join(cartella, "rotta.enc"), path.join(cartella, "rotta.dump"), privata), nome)
        .rejects.toThrow(/alterata o è incompleta/);
      expect(existsSync(path.join(cartella, "rotta.dump")), nome).toBe(false);
    }
    // troncata
    await writeFile(path.join(cartella, "corta.enc"), originale.subarray(0, originale.length - 1000));
    await expect(decifraFile(path.join(cartella, "corta.enc"), path.join(cartella, "corta.dump"), privata)).rejects.toThrow(/alterata o è incompleta/);
    // un altro file
    await writeFile(path.join(cartella, "altro.enc"), Buffer.from("PGDMP non cifrato"));
    await expect(decifraFile(path.join(cartella, "altro.enc"), path.join(cartella, "altro.dump"), privata)).rejects.toThrow(/non è una copia di Cerbero/);
  });

  it("con un'altra chiave privata: lo dice l'impronta, prima di provare", async () => {
    await expect(decifraFile(path.join(cartella, "a.enc"), path.join(cartella, "x.dump"), altra)).rejects.toThrow(/non è quella con cui è stata cifrata/);
  });

  it("due copie degli stessi dati sono diverse (chiave dei dati e IV nuovi ogni volta)", async () => {
    await cifraFile(path.join(cartella, "a.dump"), path.join(cartella, "b.enc"), pubblica);
    const [a, b] = await Promise.all([readFile(path.join(cartella, "a.enc")), readFile(path.join(cartella, "b.enc"))]);
    expect(a.length).toBe(b.length);
    expect(a.equals(b)).toBe(false);
  });
});

describe("la configurazione dello storage", () => {
  const base = {
    BACKUP_S3_ENDPOINT: "https://fsn1.esempio-storage.test", BACKUP_S3_REGIONE: "fsn1", BACKUP_S3_BUCKET: "copie-azienda",
    BACKUP_S3_ACCESS_KEY: "chiave", BACKUP_S3_SECRET_KEY: "segreto",
  };
  it("dice che cosa manca, e rifiuta indirizzi e nomi sbagliati", () => {
    expect(configS3({}).mancano).toHaveLength(5);
    expect(configS3({ ...base, BACKUP_S3_SECRET_KEY: " " }).mancano).toEqual(["BACKUP_S3_SECRET_KEY"]);
    expect(configS3({ ...base, BACKUP_S3_ENDPOINT: "http://storage.esempio.test" }).errore).toMatch(/https/);
    expect(configS3({ ...base, BACKUP_S3_ENDPOINT: "https://utente:pw@storage.esempio.test" }).errore).toMatch(/senza credenziali/);
    expect(configS3({ ...base, BACKUP_S3_ENDPOINT: "https://storage.esempio.test/bucket" }).errore).toMatch(/senza credenziali, percorso/);
    expect(configS3({ ...base, BACKUP_S3_BUCKET: "Bucket_Sbagliato" }).errore).toMatch(/bucket/);
    expect(configS3({ ...base, BACKUP_S3_PREFISSO: "../fuori" }).errore).toMatch(/PREFISSO/);
    expect(configS3({ ...base, BACKUP_S3_STILE: "altro" }).errore).toMatch(/STILE/);
  });
  it("prefisso con la barra in fondo; indirizzo per percorso o virtuale", () => {
    const c = configS3({ ...base, BACKUP_S3_PREFISSO: "notte" }).config!;
    expect(c.prefisso).toBe("notte/");
    expect(urlOggetto(c, "notte/a b.enc")).toBe("https://fsn1.esempio-storage.test/copie-azienda/notte/a%20b.enc");
    expect(urlOggetto({ ...c, stile: "virtuale" }, "notte/x.enc")).toBe("https://copie-azienda.fsn1.esempio-storage.test/notte/x.enc");
    expect(configS3(base).config!.prefisso).toBe("cerbero/");
  });
  it("i segreti non finiscono nei messaggi", () => {
    expect(senzaSegreti("connessione a postgres://cerbero_backup:pw123@db:5432/x fallita", ["pw123"])) // scan-ok: indirizzo finto, il test controlla che la password sparisca
      .toBe("connessione a postgres://***@db:5432/x fallita");
    expect(senzaSegreti("errore con segreto-lungo dentro", ["segreto-lungo"])).toBe("errore con *** dentro");
  });
});

describe("lo storage, contro uno storage finto che controlla firma e SHA-256", () => {
  let s: StorageFinto;
  beforeAll(async () => { s = await storageFinto(); });
  afterAll(async () => { await s.chiudi(); });

  it("carica, elenca, scarica: gli stessi byte", async () => {
    const file = path.join(cartella, "a.enc");
    const conto = { byte: (await stat(file)).size, sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
    await carica(s.config, "cerbero/prova-1.dump.enc", file, conto);
    expect(s.richieste.at(-1)).toMatchObject({ metodo: "PUT", firmaValida: true, hashValido: true });
    const elenco = await elenca(s.config);
    expect(elenco.map((o) => o.chiave)).toContain("cerbero/prova-1.dump.enc");
    expect(elenco.find((o) => o.chiave === "cerbero/prova-1.dump.enc")?.byte).toBe(conto.byte);
    const giu = await scaricaInFile(s.config, "cerbero/prova-1.dump.enc", path.join(cartella, "giu.enc"));
    expect(giu).toEqual(conto);
  });

  it("uno SHA-256 che non torna, una firma sbagliata, un oggetto che non c'è: l'errore col codice", async () => {
    const file = path.join(cartella, "a.enc");
    await expect(carica(s.config, "cerbero/rotta.enc", file, { byte: (await stat(file)).size, sha256: HASH_VUOTO }))
      .rejects.toThrow(/400 \(XAmzContentSHA256Mismatch\)/);
    await expect(scaricaInFile({ ...s.config, segreto: "altro" }, "cerbero/prova-1.dump.enc", path.join(cartella, "no.enc")))
      .rejects.toThrow(/403 \(SignatureDoesNotMatch\)/);
    await expect(scaricaInFile(s.config, "cerbero/non-ce.enc", path.join(cartella, "no.enc"))).rejects.toThrow(/404 \(NoSuchKey\)/);
  });
});
