// La copia del database fuori dal server (tappa 7.23): il formato cifrato, la
// firma delle richieste allo storage S3 e le tre operazioni sullo storage
// (carica, scarica, elenca). Senza dipendenze: solo node:crypto, node:http e
// node:https. La usano il lavoratore (artifacts/api-server/src/lib/lavori/
// copia.ts), che cifra e carica ogni notte, e ripristina-copia.mjs, che sul
// computer di chi ha la chiave privata scarica, decifra e ripristina.
//
// Cifratura «a busta», con le primitive standard di node:crypto:
// - ogni copia ha una sua chiave dei dati, casuale (32 byte), e un IV casuale
//   (12 byte): AES-256-GCM, cifratura autenticata;
// - la chiave dei dati si cifra con la chiave PUBBLICA RSA dell'azienda
//   (OAEP con SHA-256, almeno 3072 bit come chiedono le linee guida ACN).
//   Il server ha solo la pubblica: chi entra nel server, o nello storage, non
//   legge le copie. La privata resta a chi deve poter ripristinare.
//
// Il file:
//   MAGIA (16 byte, "CERBERO-COPIA-1\n")
//   impronta della chiave pubblica (32 byte, SHA-256 della SPKI DER)
//   lunghezza della chiave dei dati cifrata (2 byte, big endian)
//   chiave dei dati cifrata (RSA-OAEP)
//   IV (12 byte)
//   dati cifrati (AES-256-GCM, con tutta l'intestazione come dati associati)
//   tag (16 byte)
// L'intestazione entra nel tag: cambiarne un byte rende la copia illeggibile,
// come cambiare un byte dei dati.
import {
  constants, createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey,
  privateDecrypt, publicEncrypt, randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAGIA = Buffer.from("CERBERO-COPIA-1\n", "latin1");
export const BIT_MINIMI = 3072;
const LUNGO_IMPRONTA = 32;
const LUNGO_IV = 12;
const LUNGO_TAG = 16;

// ── le chiavi ──

/** Il testo di una chiave PEM come lo si scrive in una variabile: anche con «\n» letterali, o in base64. */
function testoPem(testo) {
  let t = String(testo ?? "").trim().replace(/\\n/g, "\n");
  if (t && !t.startsWith("-----BEGIN")) t = Buffer.from(t, "base64").toString("utf8").trim();
  return t;
}

/** La chiave pubblica RSA di almeno 3072 bit, o un errore che dice che cosa non va. */
export function chiavePubblica(testo) {
  const t = testoPem(testo);
  if (!t) throw new Error("manca la chiave pubblica");
  let k;
  try {
    k = createPublicKey(t);
  } catch {
    throw new Error("la chiave pubblica non si legge: serve il testo PEM («-----BEGIN PUBLIC KEY-----…»)");
  }
  return controllaRsa(k);
}

/** La chiave privata (con la frase, se è protetta). */
export function chiavePrivata(testo, frase) {
  const t = testoPem(testo);
  try {
    return controllaRsa(createPrivateKey(frase ? { key: t, passphrase: frase } : t));
  } catch (err) {
    if (/passphrase|decrypt|bad decrypt/i.test(String(err?.message))) throw new Error("la chiave privata non si apre: frase sbagliata o mancante");
    if (err?.message?.startsWith("la chiave")) throw err;
    throw new Error("la chiave privata non si legge: serve il file PEM creato con la chiave pubblica");
  }
}

function controllaRsa(k) {
  if (k.asymmetricKeyType !== "rsa") throw new Error(`la chiave è ${k.asymmetricKeyType}: serve una chiave RSA`);
  const bit = k.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bit < BIT_MINIMI) throw new Error(`la chiave RSA ha ${bit} bit: ne servono almeno ${BIT_MINIMI}`);
  return k;
}

/** L'impronta di una chiave (pubblica o privata): SHA-256 della chiave pubblica in SPKI DER. */
export function impronta(chiave) {
  const pubblica = chiave.type === "public" ? chiave : createPublicKey(chiave);
  return createHash("sha256").update(pubblica.export({ type: "spki", format: "der" })).digest();
}

// ── cifrare e decifrare ──

function intestazione(pubblica) {
  const chiaveDati = randomBytes(32);
  const iv = randomBytes(LUNGO_IV);
  const busta = publicEncrypt({ key: pubblica, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, chiaveDati);
  const lungo = Buffer.alloc(2);
  lungo.writeUInt16BE(busta.length);
  return { testa: Buffer.concat([MAGIA, impronta(pubblica), lungo, busta, iv]), chiaveDati, iv };
}

/** Un flusso che cifra quello che riceve: prima l'intestazione, poi i dati cifrati, in fondo il tag. */
export function cifratore(pubblica) {
  const { testa, chiaveDati, iv } = intestazione(pubblica);
  const c = createCipheriv("aes-256-gcm", chiaveDati, iv);
  c.setAAD(testa);
  chiaveDati.fill(0);
  let partita = false;
  return new Transform({
    transform(pezzo, _codifica, fatto) {
      if (!partita) { this.push(testa); partita = true; }
      fatto(null, c.update(pezzo));
    },
    flush(fatto) {
      if (!partita) this.push(testa);
      const resto = c.final();
      if (resto.length) this.push(resto);
      this.push(c.getAuthTag());
      fatto();
    },
  });
}

/** Legge l'intestazione dai primi byte di una copia (almeno 16 + 32 + 2 + busta + 12). */
export function leggiIntestazione(primi) {
  if (primi.length < MAGIA.length + LUNGO_IMPRONTA + 2 || !primi.subarray(0, MAGIA.length).equals(MAGIA)) {
    throw new Error("non è una copia di Cerbero (l'inizio del file non è quello atteso)");
  }
  const lungo = primi.readUInt16BE(MAGIA.length + LUNGO_IMPRONTA);
  const fine = MAGIA.length + LUNGO_IMPRONTA + 2 + lungo + LUNGO_IV;
  if (lungo < 256 || lungo > 2048 || primi.length < fine) throw new Error("l'intestazione della copia è rovinata");
  const inizioBusta = MAGIA.length + LUNGO_IMPRONTA + 2;
  return {
    lunghezza: fine,
    impronta: primi.subarray(MAGIA.length, MAGIA.length + LUNGO_IMPRONTA),
    busta: primi.subarray(inizioBusta, inizioBusta + lungo),
    iv: primi.subarray(inizioBusta + lungo, fine),
    testa: primi.subarray(0, fine),
  };
}

/**
 * Decifra il file `da` in `a` con la chiave privata. Il tag sta in fondo: si
 * legge prima, poi i dati in flusso. Se la copia è stata cambiata, o è
 * incompleta, il file decifrato si cancella e l'errore lo dice.
 */
export async function decifraFile(da, a, privata) {
  const fh = await fsp.open(da, "r");
  let testa;
  let tag;
  let dimensione;
  try {
    dimensione = (await fh.stat()).size;
    const primi = Buffer.alloc(Math.min(dimensione, 4096));
    await fh.read(primi, 0, primi.length, 0);
    testa = leggiIntestazione(primi);
    if (dimensione < testa.lunghezza + LUNGO_TAG) throw new Error("la copia è incompleta");
    tag = Buffer.alloc(LUNGO_TAG);
    await fh.read(tag, 0, LUNGO_TAG, dimensione - LUNGO_TAG);
  } finally {
    await fh.close();
  }
  if (!testa.impronta.equals(impronta(privata))) {
    throw new Error("la chiave privata non è quella con cui è stata cifrata la copia (le impronte non coincidono)");
  }
  let chiaveDati;
  try {
    chiaveDati = privateDecrypt({ key: privata, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, testa.busta);
  } catch {
    throw new Error("la chiave dei dati non si apre: copia rovinata o chiave sbagliata");
  }
  const d = createDecipheriv("aes-256-gcm", chiaveDati, testa.iv);
  d.setAAD(testa.testa);
  d.setAuthTag(tag);
  chiaveDati.fill(0);
  try {
    // createReadStream: `end` è compreso; una copia di zero byte non ha dati fra intestazione e tag
    const dati = dimensione - LUNGO_TAG > testa.lunghezza
      ? createReadStream(da, { start: testa.lunghezza, end: dimensione - LUNGO_TAG - 1 }) : Readable.from([]);
    await pipeline(dati, d, createWriteStream(a, { mode: 0o600 }));
  } catch (err) {
    await fsp.rm(a, { force: true });
    if (/auth|unable to authenticate/i.test(String(err?.message))) throw new Error("la copia è stata alterata o è incompleta: il controllo di integrità non torna");
    throw err;
  }
}

/** Un flusso che lascia passare i dati e ne conta byte e SHA-256. */
export function contatore() {
  const h = createHash("sha256");
  let byte = 0;
  const t = new Transform({
    transform(pezzo, _codifica, fatto) {
      h.update(pezzo);
      byte += pezzo.length;
      fatto(null, pezzo);
    },
  });
  t.risultato = () => ({ byte, sha256: h.digest("hex") });
  return t;
}

// ── la firma delle richieste S3 (AWS Signature Version 4) ──

const sha256hex = (x) => createHash("sha256").update(x).digest("hex");
const hmac = (k, x) => createHmac("sha256", k).update(x).digest();
/** SHA-256 del corpo vuoto. */
export const HASH_VUOTO = sha256hex("");
/** RFC 3986: tutto tranne A-Z a-z 0-9 - _ . ~ */
const codifica = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Firma una richiesta S3. `url` col percorso già scritto (si ricodifica
 * segmento per segmento, come vuole S3: senza doppia codifica), le
 * `intestazioni` da firmare oltre a host e x-amz-*. Restituisce il percorso
 * da usare nella richiesta (con la query) e le intestazioni da mandare.
 */
export function firma({ metodo, url, intestazioni = {}, hashCorpo, accesso, segreto, regione, servizio = "s3", quando = new Date() }) {
  const u = new URL(url);
  const amz = quando.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const giorno = amz.slice(0, 8);
  const percorso = u.pathname.split("/").map((s) => codifica(decodeURIComponent(s))).join("/") || "/";
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [codifica(k), codifica(v)])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const h = {};
  for (const [k, v] of Object.entries(intestazioni)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  h.host = u.host;
  h["x-amz-date"] = amz;
  h["x-amz-content-sha256"] = hashCorpo;
  const nomi = Object.keys(h).sort();
  const firmate = nomi.join(";");
  const canonica = [metodo, percorso, query, nomi.map((n) => `${n}:${h[n]}\n`).join(""), firmate, hashCorpo].join("\n");
  const ambito = `${giorno}/${regione}/${servizio}/aws4_request`;
  const daFirmare = ["AWS4-HMAC-SHA256", amz, ambito, sha256hex(canonica)].join("\n");
  const chiave = hmac(hmac(hmac(hmac(`AWS4${segreto}`, giorno), regione), servizio), "aws4_request");
  const firmata = createHmac("sha256", chiave).update(daFirmare).digest("hex");
  return {
    percorso: query ? `${percorso}?${query}` : percorso,
    intestazioni: { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accesso}/${ambito}, SignedHeaders=${firmate}, Signature=${firmata}` },
    canonica,
    firma: firmata,
  };
}

// ── lo storage ──

/** Le variabili dello storage, uguali per il lavoratore e per lo script di ripristino. */
export const VARIABILI_S3 = Object.freeze(["BACKUP_S3_ENDPOINT", "BACKUP_S3_REGIONE", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY"]);

/** La configurazione dello storage dall'ambiente, o l'elenco di quello che manca. */
export function configS3(env = process.env) {
  const mancano = VARIABILI_S3.filter((v) => !String(env[v] ?? "").trim());
  if (mancano.length) return { mancano };
  let endpoint;
  try {
    endpoint = new URL(String(env.BACKUP_S3_ENDPOINT).trim());
  } catch {
    return { mancano: [], errore: "BACKUP_S3_ENDPOINT non è un indirizzo (per esempio https://fsn1.your-objectstorage.com)" };
  }
  // in chiaro solo verso questo computer (le prove); altrove HTTPS
  const locale = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && locale)) {
    return { mancano: [], errore: "BACKUP_S3_ENDPOINT deve cominciare con https://" };
  }
  if (endpoint.username || endpoint.password || (endpoint.pathname !== "/" && endpoint.pathname !== "") || endpoint.search) {
    return { mancano: [], errore: "BACKUP_S3_ENDPOINT è solo l'indirizzo del servizio, senza credenziali, percorso o parametri" };
  }
  const bucket = String(env.BACKUP_S3_BUCKET).trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return { mancano: [], errore: "BACKUP_S3_BUCKET non è un nome di bucket valido" };
  let prefisso = String(env.BACKUP_S3_PREFISSO ?? "cerbero/").trim();
  if (prefisso && !prefisso.endsWith("/")) prefisso += "/";
  if (prefisso.startsWith("/") || /[^A-Za-z0-9/_.-]/.test(prefisso) || prefisso.includes("..")) {
    return { mancano: [], errore: "BACKUP_S3_PREFISSO può avere solo lettere, cifre, / _ . -" };
  }
  const stile = String(env.BACKUP_S3_STILE ?? "percorso").trim();
  if (!["percorso", "virtuale"].includes(stile)) return { mancano: [], errore: "BACKUP_S3_STILE è «percorso» o «virtuale»" };
  return {
    mancano: [],
    config: {
      endpoint: endpoint.origin, regione: String(env.BACKUP_S3_REGIONE).trim(), bucket, prefisso, stile,
      accesso: String(env.BACKUP_S3_ACCESS_KEY).trim(), segreto: String(env.BACKUP_S3_SECRET_KEY).trim(),
    },
  };
}

/** L'indirizzo di un oggetto (o del bucket, senza chiave), nello stile scelto. */
export function urlOggetto(cfg, chiave = "", query = "") {
  const e = new URL(cfg.endpoint);
  const k = chiave.split("/").map(codifica).join("/");
  const base = cfg.stile === "virtuale" ? `${e.protocol}//${cfg.bucket}.${e.host}/${k}` : `${e.origin}/${cfg.bucket}/${k}`;
  return query ? `${base}?${query}` : base;
}

const MAX_ERRORE = 4096;

/** Una richiesta firmata. Restituisce la risposta (da leggere) se lo stato è 2xx, altrimenti un errore col codice di S3. */
function richiesta(cfg, metodo, url, { corpo = null, lunghezza = 0, hashCorpo = HASH_VUOTO, intestazioni = {}, attesaMs = 10 * 60_000 } = {}) {
  const f = firma({ metodo, url, intestazioni, hashCorpo, accesso: cfg.accesso, segreto: cfg.segreto, regione: cfg.regione });
  const u = new URL(url);
  const modulo = u.protocol === "https:" ? https : http;
  return new Promise((risolvi, rifiuta) => {
    const r = modulo.request({
      method: metodo, hostname: u.hostname, port: u.port || undefined, path: f.percorso,
      headers: { ...f.intestazioni, ...(corpo ? { "content-length": String(lunghezza) } : {}) },
    }, (risposta) => {
      if (risposta.statusCode >= 200 && risposta.statusCode < 300) return risolvi(risposta);
      const pezzi = [];
      let letti = 0;
      risposta.on("data", (p) => { if (letti < MAX_ERRORE) { pezzi.push(p); letti += p.length; } });
      risposta.on("end", () => {
        const testo = Buffer.concat(pezzi).toString("utf8").slice(0, MAX_ERRORE);
        const codice = /<Code>([^<]{1,100})<\/Code>/.exec(testo)?.[1];
        const err = new Error(`lo storage ha risposto ${risposta.statusCode}${codice ? ` (${codice})` : ""} a ${metodo}`);
        err.stato = risposta.statusCode;
        err.codice = codice ?? null;
        rifiuta(err);
      });
      risposta.on("error", rifiuta);
    });
    r.setTimeout(attesaMs, () => r.destroy(new Error(`lo storage non risponde da ${Math.round(attesaMs / 1000)} secondi`)));
    r.on("error", (err) => rifiuta(err?.message?.startsWith("lo storage") ? err : new Error(`storage non raggiungibile: ${err?.code ?? err?.message}`)));
    if (corpo) {
      corpo.on("error", (err) => r.destroy(err));
      corpo.pipe(r);
    } else {
      r.end();
    }
  });
}

const svuota = (risposta) => new Promise((ok) => { risposta.resume(); risposta.on("end", ok); risposta.on("error", ok); });

/** Carica un file. Lo storage controlla lo SHA-256 del corpo (è nella firma). */
export async function carica(cfg, chiave, file, { sha256, byte }) {
  const risposta = await richiesta(cfg, "PUT", urlOggetto(cfg, chiave), {
    corpo: createReadStream(file), lunghezza: byte, hashCorpo: sha256,
    intestazioni: { "content-type": "application/octet-stream", "x-amz-meta-sha256": sha256 },
  });
  await svuota(risposta);
}

/** Lo scaricamento di un oggetto, come flusso. */
export function scarica(cfg, chiave) {
  return richiesta(cfg, "GET", urlOggetto(cfg, chiave));
}

/** Gli oggetti sotto un prefisso (ListObjectsV2), i più recenti per ultimi; al più `massimo`. */
export async function elenca(cfg, prefisso = cfg.prefisso, massimo = 1000) {
  const oggetti = [];
  let continua = null;
  do {
    const q = new URLSearchParams({ "list-type": "2", prefix: prefisso, "max-keys": "1000" });
    if (continua) q.set("continuation-token", continua);
    const risposta = await richiesta(cfg, "GET", urlOggetto(cfg, "", q.toString()));
    const pezzi = [];
    for await (const p of risposta) pezzi.push(p);
    const xml = Buffer.concat(pezzi).toString("utf8");
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const campo = (n) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(m[1])?.[1] ?? null;
      const testo = (s) => s?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      oggetti.push({ chiave: testo(campo("Key")), byte: Number(campo("Size") ?? 0), data: campo("LastModified") });
    }
    continua = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? testoOppureNull(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1]) : null;
  } while (continua && oggetti.length < massimo);
  return oggetti.sort((a, b) => String(a.data).localeCompare(String(b.data))).slice(-massimo);
}
const testoOppureNull = (s) => (s ? s : null);

/** Scarica un oggetto in un file, contando byte e SHA-256. */
export async function scaricaInFile(cfg, chiave, file) {
  const conta = contatore();
  await pipeline(await scarica(cfg, chiave), conta, createWriteStream(file, { mode: 0o600 }));
  return conta.risultato();
}

/** Toglie le credenziali da un testo (un messaggio d'errore) prima di salvarlo o scriverlo nel log. */
export function senzaSegreti(testo, segreti = []) {
  let t = String(testo ?? "").replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@");
  for (const s of segreti) if (s && String(s).length >= 4) t = t.split(String(s)).join("***");
  return t;
}
