// La password dell'utente dell'app (cerbero_app) e il suo URL, per
// `ruoli.mjs --imposta-password`. Funzioni pure, senza database: le prova
// artifacts/api-server/src/__tests__/ruoli-regole.test.ts.
//
// Perché un comando invece di `\password` e di un URL scritto a mano: al primo
// rilascio l'URL composto a mano ha avuto due volte la password sbagliata o
// fuori posto, e il deploy è fallito. Qui la password nasce, va al database e
// finisce nell'URL nello stesso passo, e l'URL si prova prima di stamparlo.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/** Le iterazioni di PBKDF2 che PostgreSQL usa per SCRAM-SHA-256 (scram_iterations). */
export const GIRI_SCRAM = 4096;

/**
 * Una password nuova: 192 bit dal generatore del sistema, scritti con cifre e
 * lettere da «a» a «f». Niente che in un URL vada codificato (@ : / # %) né
 * che Coolify legga come nome di un'altra variabile ($).
 */
export function nuovaPassword() {
  return randomBytes(24).toString("hex");
}

/**
 * L'impronta SCRAM-SHA-256 di una password, nella forma che PostgreSQL salva
 * in pg_authid (RFC 5802 e 7677): con questa in `ALTER ROLE … PASSWORD` al
 * database non arriva la password, come con `\password` di psql.
 *
 * Solo caratteri ASCII visibili: per gli altri PostgreSQL normalizza la
 * password (SASLprep) prima di calcolare, e un'impronta calcolata senza non
 * farebbe entrare.
 */
export function improntaScram(password, sale = randomBytes(16), giri = GIRI_SCRAM) {
  if (typeof password !== "string" || !/^[\x21-\x7e]{8,}$/.test(password)) {
    throw new Error("la password deve avere almeno 8 caratteri ASCII visibili, senza spazi");
  }
  // un sale vuoto o che non è un Buffer darebbe un'impronta che PostgreSQL salva ma con cui non si entra
  if (!Buffer.isBuffer(sale) || sale.length < 16) throw new Error("il sale deve essere un Buffer di almeno 16 byte");
  if (!Number.isInteger(giri) || giri < GIRI_SCRAM) throw new Error(`le iterazioni devono essere almeno ${GIRI_SCRAM}`);
  const salata = pbkdf2Sync(password, sale, giri, 32, "sha256");
  const firma = (testo) => createHmac("sha256", salata).update(testo).digest();
  const chiaveSalvata = createHash("sha256").update(firma("Client Key")).digest();
  return `SCRAM-SHA-256$${giri}:${sale.toString("base64")}$${chiaveSalvata.toString("base64")}:${firma("Server Key").toString("base64")}`;
}

/**
 * L'URL dell'app: quello del migratore con l'utente e la password cambiati.
 * Host, porta, database e parametri restano quelli, così non si riscrive
 * niente a mano.
 */
export function urlDellApp(urlDelMigratore, utente, password) {
  let u;
  try {
    u = new URL(urlDelMigratore);
  } catch {
    throw new Error("l'URL del migratore non si legge come URL");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("l'URL del migratore non comincia con postgres:// o postgresql://");
  // senza host (un socket locale) l'URL non porta utente e password
  if (!u.hostname) throw new Error("l'URL del migratore non ha un host: l'URL dell'app va scritto a mano");
  u.username = utente;
  u.password = password;
  return u.toString();
}
