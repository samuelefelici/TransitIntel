/**
 * Auth — modulo unico per gestione utenti, login, JWT, middleware.
 *
 * Bootstrap idempotente: alla prima richiesta crea la tabella `users`. A
 * tabella vuota crea un solo amministratore dalle variabili d'ambiente
 * CERBERO_ADMIN_EMAIL e CERBERO_ADMIN_PASSWORD (lib/password-regole.ts):
 * nessuna password è scritta nel codice.
 *
 * Nessuna modifica a Drizzle schema: usiamo db.execute(sql\`...\`) come
 * già fatto per `fares_polimetriche_snapshots`.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";
import { loginLimiter } from "../middlewares/rate-limit";
import { decidiPrimoAdmin, ePasswordPubblicata, erroreNuovaPassword, PASSWORD_PUBBLICATE } from "./password-regole";
import { normalizzaPermessi, PERMESSI_NUOVO_UTENTE, type Permission } from "./permessi";
import { datiProvaAttivi } from "./dati-prova";
import { idChiave } from "./mfa-cifratura";
import { chiaveEmail, limitazione, mfaObbligatoria, percorsoConsentitoLimitato, percorsoVietatoAiServizi, type Limitazione } from "./accesso-regole";
import {
  azzeraTentativiPassword, azzeraTuttiITentativiPassword, controllaChiaveMfa, forsePulisciAccessi, prenotaTentativoPassword,
  provaCodice, pulisciAccessi,
} from "./accesso-db";

/* ────────────────────────────────────────────────────────────
 * Tipi
 * ──────────────────────────────────────────────────────────── */
/* i permessi per utente (i moduli del menu) e le loro regole: lib/permessi.ts */
export type { Permission };
export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "user";
  permissions: Record<Permission, boolean>;
  /** Ruolo dentro il modulo FleetCare (gli admin sono sempre fleet_admin). */
  fleetcareRole: string;
  active: boolean;
}

/** Ruoli validi nel modulo FleetCare (enum fleetcare.profile_role lato FleetCare). */
export const FLEETCARE_ROLES = [
  "driver",
  "mechanic",
  "workshop_manager",
  "admin_finance",
  "fleet_admin",
] as const;

/** Lo stato dell'accesso, per il client e per i controlli delle rotte. */
export interface Accesso {
  limitato: Limitazione;
  mfaAttiva: boolean;
  mfaObbligatoria: boolean;
  passwordDaCambiare: boolean;
  /** la sessione è entrata con un codice di recupero (telefono perso): può rifare la verifica */
  recupero: boolean;
  /** i codici di recupero sono di una chiave che non è più quella attuale: vanno rifatti */
  codiciDaRifare: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** il token è stato emesso per un servizio che agisce per conto dell'utente (es. "argos") */
      authVia?: string;
      /** la sessione: versione (si revoca alzandola), se è passata dalla verifica in due
       *  passaggi, quando è cominciata (at, secondi: scade 12 ore dopo), quando si è data
       *  la password l'ultima volta (pw), se è entrata con un codice di recupero */
      sessione?: { sv: number; mfa: boolean; at?: number; pw?: number; rec?: boolean };
      /** sessione «limitata»: password provvisoria da cambiare o verifica da attivare */
      accesso?: Accesso;
    }
  }
}

/* ────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────── */
// Fail-closed: in produzione il secret DEVE essere impostato, altrimenti i
// token sarebbero firmati con una costante pubblica del repo (forgiabili).
const JWT_SECRET = process.env.JWT_SECRET
  || (process.env.NODE_ENV === "production"
        ? (() => { throw new Error("JWT_SECRET obbligatorio in produzione"); })()
        : "dev-only-cerbero123-in-production-please");
const JWT_COOKIE = "ti_auth";
/* una sessione dura un turno di lavoro: dopo 12 ore si rientra (con la verifica, se attiva) */
const SESSIONE_ORE = 12;
export const BCRYPT_ROUNDS = 12;
/* il biglietto fra password e codice: vale 5 minuti e solo per /auth/login/mfa */
const AUD_MFA = "cerbero-mfa";

/* ────────────────────────────────────────────────────────────
 * Bootstrap tabella + primo amministratore
 * ──────────────────────────────────────────────────────────── */
let bootstrapped = false;
let preparazione: Promise<void> | null = null;
/** Una sola preparazione anche se arrivano tante richieste insieme all'avvio; se fallisce, la prossima riprova. */
function ensureUsersTable(): Promise<void> {
  if (bootstrapped) return Promise.resolve();
  preparazione ??= preparaUtenti().then(
    () => {
      bootstrapped = true;
      void disattivaPasswordPubblicate("altri").catch((e: any) => console.error("[auth] controllo password pubblicate:", e?.message || e));
      void controllaChiaveMfa().catch((e: any) => console.error("[auth] controllo chiave della verifica:", e?.message || e));
    },
    (e: any) => { console.error("[auth] bootstrap users error:", e?.message || e); preparazione = null; },
  );
  return preparazione;
}

/** Le righe con la stessa email (maiuscole o spazi diversi, da prima): vince quella attiva più vecchia, sempre la stessa. */
const ORDINE_STESSA_EMAIL = sql`active DESC, created_at ASC, id ASC`;

async function preparaUtenti(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      full_name text,
      role text NOT NULL DEFAULT 'user',
      permissions jsonb NOT NULL DEFAULT '{"analytics":false,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false,"personale":false,"roster":false}'::jsonb,
      active boolean NOT NULL DEFAULT true,
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

  /* Accesso sicuro (migrations/2026-10_accesso_sicuro.sql). ALTER solo se la colonna
   * manca: anche con IF NOT EXISTS prende la tabella in esclusiva. sessione_versione
   * parte da 1: i token di prima (senza versione) valgono 0 e non entrano più. */
  const colonne = new Set(((await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users'`)) as any).rows.map((x: any) => String(x.column_name)));
  const nuove: Array<[string, string]> = [
    ["sessione_versione", "integer NOT NULL DEFAULT 1"],
    /* i browser riconosciuti (cookie del dispositivo): sale solo quando vanno dimenticati
     * (cambio password, «esci ovunque», password provvisoria, disattivazione) */
    ["dispositivi_versione", "integer NOT NULL DEFAULT 1"],
    ["password_cambiata_il", "timestamptz"],
    ["deve_cambiare_password", "boolean NOT NULL DEFAULT false"],
    /* la password di adesso non è una di quelle pubblicate dal vecchio codice */
    ["password_controllata", "boolean NOT NULL DEFAULT false"],
    ["mfa_attiva", "boolean NOT NULL DEFAULT false"],
    ["mfa_segreto", "text"],
    ["mfa_recupero", "jsonb"],
    /* con quale chiave sono fatte le impronte dei codici di recupero (mfa-cifratura idChiave) */
    ["mfa_recupero_chiave", "text"],
    ["mfa_ultimo_passo", "bigint"],
    ["mfa_errori", "integer NOT NULL DEFAULT 0"],
    ["mfa_bloccata_fino", "timestamptz"],
  ];
  for (const [nome, tipo] of nuove) {
    if (!colonne.has(nome)) await db.execute(sql.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${nome} ${tipo}`));
  }
  /* il registro degli accessi: chi, quando, da dove, com'è andata (12 mesi) */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS accessi_log (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      user_id uuid,
      email text,
      esito text NOT NULL,
      ip text,
      user_agent text
    )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_accessi_log_ts ON accessi_log(ts DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_accessi_log_user ON accessi_log(user_id, ts DESC)`);
  /* le serie di tentativi sbagliati: per email e indirizzo, e per l'account (ip = '*') */
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS accessi_tentativi (
      chiave text NOT NULL,
      ip text NOT NULL,
      errori integer NOT NULL DEFAULT 0,
      inizio timestamptz,
      ultimo timestamptz NOT NULL DEFAULT now(),
      bloccato_fino timestamptz,
      PRIMARY KEY (chiave, ip)
    )`);
  await pulisciAccessi();
  /* un'email, un utente: maiuscole e spazi non contano. Se ci sono già doppioni l'indice
   * non si crea (lo dice il log) e il login prende sempre la stessa riga */
  const indice = await db.execute<any>(sql`
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_email_normale_uq'`);
  if (!(indice as any).rows?.length) {
    try { await db.execute(sql`CREATE UNIQUE INDEX users_email_normale_uq ON users (lower(trim(email)))`); }
    catch (e: any) { console.warn("[auth] ci sono utenti con la stessa email scritta in modi diversi (maiuscole, spazi): unificali da Gestione Utenti.", e?.message || e); }
  }

  // Backfill idempotente: assicura che ogni utente abbia la chiave "network"
  // (default true, così chi aveva già accesso a "scheduling" mantiene tutto).
  await db.execute(sql`
    UPDATE users
       SET permissions = permissions || '{"network":true}'::jsonb
     WHERE NOT (permissions ? 'network')
  `);

  // Rete e orari porta con sé i Turni: il server lo imponeva solo al salvataggio, e
  // chi è stato salvato prima (o ha ricevuto network dal backfill qui sopra) poteva
  // avere network senza scheduling. Si allinea il dato alla regola, una volta sola.
  await db.execute(sql`
    UPDATE users
       SET permissions = permissions || '{"scheduling":true}'::jsonb
     WHERE coalesce((permissions->>'network')::boolean, false)
       AND NOT coalesce((permissions->>'scheduling')::boolean, false)
  `);

  // FleetCare (modulo Cerbero di gestione flotta): abilitazione ESPLICITA,
  // quindi default false — gli admin bypassano comunque (requirePermission).
  await db.execute(sql`
    UPDATE users
       SET permissions = permissions || '{"fleetcare":false}'::jsonb
     WHERE NOT (permissions ? 'fleetcare')
  `);
  // Ruolo che l'utente avrà DENTRO FleetCare quando entra via SSO.
  await db.execute(sql`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS fleetcare_role text NOT NULL DEFAULT 'driver'
  `);

  // Centrale Operativa (Mappa live + AVM): modulo ad attivazione esplicita,
  // default false per i NUOVI utenti. Chi esiste già eredita il valore di
  // "analytics", perché fino a oggi Mappa e AVM vivevano sotto quel permesso:
  // il rilascio del modulo non deve togliere a nessuno una pagina che vedeva.
  await db.execute(sql`
    UPDATE users
       SET permissions = permissions
           || jsonb_build_object('centrale', coalesce((permissions->>'analytics')::boolean, true))
     WHERE NOT (permissions ? 'centrale')
  `);

  // Anagrafica del personale: dati personali e di busta paga, quindi
  // attivazione ESPLICITA. Nessun utente esistente la riceve da sé.
  await db.execute(sql`
    UPDATE users
       SET permissions = permissions || '{"personale":false}'::jsonb
     WHERE NOT (permissions ? 'personale')
  `);

  // Roster: fino a oggi stava sotto «scheduling». Chi esiste già eredita
  // quel valore, così il rilascio non toglie a nessuno il roster che usava;
  // poi l'admin lo toglie a chi non ci lavora. I nuovi utenti partono senza.
  await db.execute(sql`
    UPDATE users
       SET permissions = permissions
           || jsonb_build_object('roster', coalesce((permissions->>'scheduling')::boolean, true))
     WHERE NOT (permissions ? 'roster')
  `);

  /* gli admin con una password pubblicata si disattivano subito (sono pochi, e il
     recupero qui sotto deve sapere se ne resta uno); gli altri dopo, in background */
  await disattivaPasswordPubblicate("admin");

  const cnt = await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
  const nAdmin = ((cnt as any).rows?.[0] ?? (cnt as any)[0])?.n ?? 0;
  const primo = decidiPrimoAdmin(nAdmin, process.env);
  if (primo.tipo === "crea") {
    /* se l'email c'è già (per esempio l'admin appena disattivato, anche scritta con
     * le maiuscole) si rimette in piedi la stessa riga con cui si entra */
    const hash = await bcrypt.hash(primo.password, BCRYPT_ROUNDS);
    const rimesso = await db.execute<any>(sql`
      UPDATE users SET
        password_hash = ${hash}, role = 'admin', active = true, deve_cambiare_password = true, password_controllata = true,
        mfa_attiva = false, mfa_segreto = NULL, mfa_recupero = NULL, mfa_recupero_chiave = NULL, mfa_ultimo_passo = NULL,
        mfa_errori = 0, mfa_bloccata_fino = NULL, sessione_versione = sessione_versione + 1
       WHERE id = (SELECT id FROM users WHERE lower(trim(email)) = ${primo.email} ORDER BY ${ORDINE_STESSA_EMAIL} LIMIT 1)
      RETURNING id`);
    if (!(rimesso as any).rows?.length) {
      /* ON CONFLICT copre due avvii insieme */
      await db.execute(sql`
        INSERT INTO users (email, password_hash, full_name, role, permissions, active, deve_cambiare_password, password_controllata)
        VALUES (
          ${primo.email}, ${hash}, 'Amministratore', 'admin',
          '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":true,"personale":false,"roster":true}'::jsonb,
          true, true, true
        )
        ON CONFLICT DO NOTHING`);
    }
    await azzeraTuttiITentativiPassword(primo.email);
    /* «creato» con un admin già esistente vuol dire un'email scritta diversa: lo si legge qui */
    const come = (rimesso as any).rows?.length ? "rimesso in piedi" : "creato (nessun utente aveva questa email)";
    /* con RIPRISTINA ancora impostata, il prossimo riavvio rifà tutto e la password scelta al primo accesso si perde */
    const poi = process.env.CERBERO_ADMIN_RIPRISTINA === "1"
      ? "poi togli CERBERO_ADMIN_EMAIL, CERBERO_ADMIN_PASSWORD e CERBERO_ADMIN_RIPRISTINA e riavvia: finché c'è CERBERO_ADMIN_RIPRISTINA=1, a ogni riavvio la password torna quella della variabile e la verifica si toglie"
      : "poi togli CERBERO_ADMIN_EMAIL e CERBERO_ADMIN_PASSWORD";
    console.warn(`[auth] amministratore ${primo.email} ${come} da CERBERO_ADMIN_*: entra con la password della variabile e cambiala; ${poi}`);
  } else if (primo.tipo === "avviso") {
    console.warn(`[auth] ${primo.messaggio}`);
  }
}
void ensureUsersTable();

/**
 * Disattiva gli account attivi che usano ancora una delle password che il
 * vecchio codice pubblicava in chiaro (PASSWORD_PUBBLICATE). Disattivare
 * chiude anche le sessioni già aperte: requireAuth controlla active. L'admin
 * li riattiva impostando una password nuova. Ogni password si controlla una
 * volta sola: quelle date con le regole nuove (12 caratteri) non possono
 * essere pubblicate, le altre si segnano come controllate.
 */
async function disattivaPasswordPubblicate(quali: "admin" | "altri"): Promise<void> {
  const r = await db.execute(sql`
    SELECT id, email, password_hash FROM users
     WHERE active AND NOT password_controllata AND ${quali === "admin" ? sql`role = 'admin'` : sql`role <> 'admin'`}`);
  const righe: any[] = (r as any).rows ?? [];
  const bruciati: Array<{ id: string; email: string }> = [];
  for (const u of righe) {
    let bruciato = false;
    for (const p of PASSWORD_PUBBLICATE) {
      if (await bcrypt.compare(p, u.password_hash)) { bruciato = true; break; }
    }
    if (bruciato) bruciati.push({ id: u.id, email: u.email });
    /* se intanto la password è cambiata, la riga resta da controllare */
    else await db.execute(sql`UPDATE users SET password_controllata = true WHERE id = ${u.id}::uuid AND password_hash = ${u.password_hash}`);
  }
  if (!bruciati.length) return;
  await db.execute(sql`UPDATE users SET active = false WHERE id IN (${sql.join(bruciati.map(b => sql`${b.id}::uuid`), sql`, `)})`);
  console.warn(`[auth] disattivati ${bruciati.length} account con una password pubblicata nel vecchio codice: ${bruciati.map(b => b.email).join(", ")}. Riattivali da Gestione Utenti con una password nuova.`);
}

/* ────────────────────────────────────────────────────────────
 * Helpers JWT/cookie
 * ──────────────────────────────────────────────────────────── */
/**
 * Il cookie della sessione. Il token dice chi è, la versione della sessione,
 * se è passata dalla verifica, quando è cominciata (`at`, in secondi), quando
 * si è data la password l'ultima volta (`pw`) e se è entrata con un codice di
 * recupero. Scade 12 ore dopo `at`, sempre: riemettere il cookie (cambio
 * password, «esci ovunque»…) non allunga la sessione, e un token rubato non
 * si rinnova all'infinito. `pw` serve solo a non richiedere la password a chi
 * l'ha appena data.
 */
export function emettiSessione(res: Response, userId: string, s: { sv: number; mfa: boolean; at?: number; pw?: number; rec?: boolean }): void {
  const ora = Math.floor(Date.now() / 1000);
  const at = s.at ?? ora;
  const scade = at + SESSIONE_ORE * 3600;
  const token = jwt.sign(
    { sub: userId, sv: s.sv, at, pw: s.pw ?? at, ...(s.mfa ? { mfa: true } : {}), ...(s.rec ? { rec: true } : {}), exp: scade },
    JWT_SECRET,
  );
  setAuthCookie(res, token, scade * 1000 - Date.now());
}

/* ─── Il browser da cui la persona è già entrata ───
 * Dopo un accesso riuscito il browser riceve un cookie firmato (OWASP «device
 * cookie») con un suo id e, per al più 5 persone entrate da lì, un'impronta
 * legata all'utente e a users.dispositivi_versione, con la data dell'accesso
 * che l'ha data (niente email nel cookie). Da quel browser gli errori di
 * password fanno una serie sua e il blocco per account non vale: chi prova da
 * tanti indirizzi non tiene fuori il titolare. Cambio password, «esci
 * ovunque», password provvisoria e disattivazione alzano dispositivi_versione:
 * gli altri browser non sono più riconosciuti. La verifica in due passaggi
 * (attivarla, toglierla, rifarla) e il ripristino dell'admin no: il solito
 * computer resta riconosciuto, anche sotto attacco. Ogni impronta vale 180
 * giorni dall'accesso che l'ha data, anche se il cookie si riscrive per altri. */
const COOKIE_DISPOSITIVO = "ti_disp";
const AUD_DISPOSITIVO = "cerbero-dispositivo";
const GIORNI_DISPOSITIVO = 180;
const MS_DISPOSITIVO = GIORNI_DISPOSITIVO * 24 * 3600 * 1000;
const segno = (testo: string) => createHmac("sha256", JWT_SECRET).update(testo).digest("base64url").slice(0, 16);
/** [chi: impronta dell'utente, versione: impronta di utente+versione della sessione, quando: ms] */
type Impronta = [string, string, number];

function leggiDispositivo(req: Request): { n: string; e: Impronta[] } | null {
  const t = (req as any).cookies?.[COOKIE_DISPOSITIVO];
  if (typeof t !== "string") return null;
  try {
    const d = jwt.verify(t, JWT_SECRET, { audience: AUD_DISPOSITIVO }) as any;
    if (typeof d.n === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(d.n) && Array.isArray(d.e)) {
      const e = (d.e as unknown[]).filter((x): x is Impronta =>
        Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string" && typeof x[2] === "number"
        && Date.now() - x[2] < MS_DISPOSITIVO);
      return { n: d.n, e };
    }
  } catch { /* scaduto o non nostro */ }
  return null;
}

/** L'id del browser, se da qui questo utente è entrato dopo l'ultima volta che i browser sono stati dimenticati; altrimenti null. */
export function dispositivoPer(req: Request, utente: { id: string; dv: number } | null): string | null {
  if (!utente) return null;
  const d = leggiDispositivo(req);
  const v = segno(`dispositivo|${utente.id}|${utente.dv}`);
  return d && d.e.some(x => x[1] === v) ? d.n : null;
}

/** Accesso riuscito (o browser dimenticati da qui): il browser si ricorda di questo utente. */
export function ricordaDispositivo(req: Request, res: Response, userId: string, dv: number): void {
  const d = leggiDispositivo(req);
  const chi = segno(`dispositivo-utente|${userId}`);
  const nuova: Impronta = [chi, segno(`dispositivo|${userId}|${dv}`), Date.now()];
  const e: Impronta[] = [nuova, ...(d?.e ?? []).filter(x => x[0] !== chi)].slice(0, 5);
  const token = jwt.sign(
    { n: d?.n ?? randomBytes(16).toString("base64url"), e },
    JWT_SECRET,
    /* il cookie dura quanto l'impronta più recente; le altre scadono alla loro data (leggiDispositivo) */
    { audience: AUD_DISPOSITIVO, expiresIn: `${GIORNI_DISPOSITIVO}d` },
  );
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(COOKIE_DISPOSITIVO, token, {
    httpOnly: true, secure: isProd, sameSite: isProd ? "none" : "lax",
    maxAge: MS_DISPOSITIVO, path: "/",
  });
}

/** Il biglietto fra la password e il codice: non apre niente se non /auth/login/mfa. */
function firmaBiglietto(userId: string, sv: number): string {
  return jwt.sign({ sub: userId, sv }, JWT_SECRET, { expiresIn: "5m", audience: AUD_MFA });
}
function leggiBiglietto(b: unknown): { sub: string; sv: number } | null {
  if (typeof b !== "string") return null;
  try {
    const d = jwt.verify(b, JWT_SECRET, { audience: AUD_MFA }) as any;
    return typeof d.sub === "string" ? { sub: d.sub, sv: Number(d.sv ?? 0) } : null;
  } catch { return null; }
}

/** Token a BREVE scadenza per chiamate server-to-server on-behalf-of-user.
 * Usato dal proxy Argos: Argos lo rigira agli endpoint /api/ai/argos/* e
 * /api/intermodal/* come Bearer, così il controllo accessi per-utente resta
 * valido ma il token vive solo per la durata di una risposta. */
export function mintShortLivedUserToken(userId: string, sessione?: { sv: number; mfa: boolean }): string {
  /* "via": chi usa questo token è un servizio esterno (Argos, e dietro un
   * modello linguistico), non la persona: non vede i dati personali. Porta la
   * stessa versione della sessione da cui nasce: si revoca con lei. */
  return jwt.sign({ sub: userId, via: "argos", sv: sessione?.sv ?? 0, ...(sessione?.mfa ? { mfa: true } : {}) }, JWT_SECRET, { expiresIn: "10m" });
}
/**
 * Lo stesso token per Argos, per un lavoro che parte senza una richiesta
 * (le sorveglianze periodiche): la versione della sessione e la verifica si
 * leggono dall'utente, così il token vale finché l'utente non revoca le sessioni.
 */
export async function mintTokenServizio(userId: string): Promise<string> {
  const u = await loadUserById(userId);
  if (!u || !u.user.active) throw new Error("L'utente non è attivo");
  /* chi deve ancora mettersi in regola non manda avanti Argos: il token verrebbe rifiutato */
  const a = accessoDi(u, { mfa: u.mfaAttiva });
  if (a.limitato === "password") throw new Error("L'utente deve prima cambiare la password provvisoria");
  if (a.limitato === "mfa") throw new Error("L'utente deve prima attivare la verifica in due passaggi");
  return mintShortLivedUserToken(userId, { sv: u.sv, mfa: u.mfaAttiva });
}
function verifyToken(token: string): { sub: string; via?: string; sv: number; mfa: boolean; at?: number; pw?: number; rec: boolean } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; via?: unknown; sv?: unknown; mfa?: unknown; aud?: unknown; at?: unknown; pw?: unknown; rec?: unknown };
    /* un biglietto della verifica (o altro con un destinatario) non è una sessione */
    if (decoded.aud !== undefined) return null;
    return {
      sub: decoded.sub, via: typeof decoded.via === "string" ? decoded.via : undefined,
      sv: typeof decoded.sv === "number" ? decoded.sv : 0, mfa: decoded.mfa === true,
      at: typeof decoded.at === "number" ? decoded.at : undefined,
      pw: typeof decoded.pw === "number" ? decoded.pw : undefined, rec: decoded.rec === true,
    };
  } catch { return null; }
}
function setAuthCookie(res: Response, token: string, maxAgeMs: number) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(JWT_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax", // none + secure per cross-site (Vercel ↔ Render)
    maxAge: Math.max(0, Math.min(maxAgeMs, SESSIONE_ORE * 60 * 60 * 1000)),
    path: "/",
  });
}
function clearAuthCookie(res: Response) {
  const isProd = process.env.NODE_ENV === "production";
  res.clearCookie(JWT_COOKIE, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  });
}

interface UtenteCaricato { user: AuthUser; sv: number; mfaAttiva: boolean; deveCambiarePassword: boolean; codiciChiave: string | null }

async function loadUserById(id: string): Promise<UtenteCaricato | null> {
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active,
           sessione_versione, mfa_attiva, deve_cambiare_password, mfa_recupero_chiave
      FROM users WHERE id = ${id}::uuid LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) return null;
  return {
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      permissions: row.permissions ?? { ...PERMESSI_NUOVO_UTENTE },
      fleetcareRole: row.fleetcare_role ?? "driver",
      active: row.active,
    },
    sv: Number(row.sessione_versione ?? 0),
    mfaAttiva: !!row.mfa_attiva,
    deveCambiarePassword: !!row.deve_cambiare_password,
    codiciChiave: row.mfa_recupero_chiave ?? null,
  };
}

/** Lo stato dell'accesso di un utente caricato, con la sessione che sta usando. */
function accessoDi(u: UtenteCaricato, sessione: { mfa: boolean; rec?: boolean }): Accesso & { rifiuta: boolean } {
  const lim = limitazione({ ...u.user, deveCambiarePassword: u.deveCambiarePassword, mfaAttiva: u.mfaAttiva }, sessione);
  return {
    limitato: lim === "rifiuta" ? null : lim,
    rifiuta: lim === "rifiuta",
    mfaAttiva: u.mfaAttiva,
    mfaObbligatoria: mfaObbligatoria(u.user),
    passwordDaCambiare: u.deveCambiarePassword,
    recupero: !!sessione.rec && u.mfaAttiva,
    codiciDaRifare: u.mfaAttiva && !!u.codiciChiave && u.codiciChiave !== idChiave(),
  };
}

/* ────────────────────────────────────────────────────────────
 * Middleware
 * ──────────────────────────────────────────────────────────── */
export const requireAuth: RequestHandler = async (req, res, next) => {
  await ensureUsersTable();
  const token = (req as any).cookies?.[JWT_COOKIE]
    || (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null);
  if (!token) { res.status(401).json({ error: "Non autenticato" }); return; }
  const verificato = verifyToken(token);
  if (!verificato) { res.status(401).json({ error: "Sessione non valida" }); return; }
  /* un servizio che agisce per conto della persona (Argos) non tocca il suo accesso */
  if (verificato.via && percorsoVietatoAiServizi(req.path)) { res.status(403).json({ error: "Non disponibile da questo canale" }); return; }
  const u = await loadUserById(verificato.sub);
  if (!u || !u.user.active) { res.status(401).json({ error: "Utente non attivo" }); return; }
  /* la versione sale al cambio password, al reset della verifica, a «esci ovunque»:
   * i token di prima non valgono più */
  if (verificato.sv !== u.sv) { res.status(401).json({ error: "Sessione scaduta: entra di nuovo" }); return; }
  const accesso = accessoDi(u, verificato);
  if (accesso.rifiuta) { res.status(401).json({ error: "Serve il codice di verifica: entra di nuovo" }); return; }
  req.user = u.user;
  req.authVia = verificato.via;
  req.sessione = { sv: u.sv, mfa: verificato.mfa, at: verificato.at, pw: verificato.pw, rec: verificato.rec };
  req.accesso = {
    limitato: accesso.limitato, mfaAttiva: accesso.mfaAttiva, mfaObbligatoria: accesso.mfaObbligatoria,
    passwordDaCambiare: accesso.passwordDaCambiare, recupero: accesso.recupero && !verificato.via,
    codiciDaRifare: accesso.codiciDaRifare,
  };
  /* sessione limitata: solo le rotte per mettersi in regola */
  if (accesso.limitato && !percorsoConsentitoLimitato(req.path)) {
    res.status(403).json({
      error: accesso.limitato === "password"
        ? "Prima cambia la password provvisoria"
        : "Prima attiva la verifica in due passaggi (Sicurezza dell'account)",
      accessoLimitato: accesso.limitato,
    });
    return;
  }
  next();
};

/** Una riga nel registro degli accessi; non blocca mai la richiesta. */
export async function registraAccesso(req: Request, voce: { userId?: string | null; email?: string | null; esito: string }): Promise<void> {
  forsePulisciAccessi();
  try {
    await db.execute(sql`
      INSERT INTO accessi_log (user_id, email, esito, ip, user_agent)
      VALUES (${voce.userId ?? null}::uuid, ${voce.email ?? null}, ${voce.esito},
              ${req.ip ?? null}, ${String(req.headers["user-agent"] ?? "").slice(0, 300) || null})`);
  } catch (e: any) {
    console.error("[auth] registro accessi:", e?.message || e);
  }
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  if (req.user.role !== "admin") { res.status(403).json({ error: "Solo admin" }); return; }
  /* l'amministrazione la fa la persona, non un servizio per conto suo */
  if (req.authVia) { res.status(403).json({ error: "Le funzioni di amministrazione non sono disponibili da questo canale" }); return; }
  next();
};

export function requirePermission(p: Permission): RequestHandler {
  return (req, res, next) => {
    if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
    /* i dati personali non passano a un servizio che agisce per conto dell'utente */
    if (p === "personale" && req.authVia) { res.status(403).json({ error: "Dati del personale non disponibili da questo canale" }); return; }
    if (req.user.role === "admin") { next(); return; }
    if (req.user.permissions?.[p]) { next(); return; }
    res.status(403).json({ error: `Manca il permesso: ${p}` });
  };
}

/**
 * Chi può vedere e scrivere i dati personali dell'anagrafica (contatti,
 * residenza, paghe, ferie, visite): admin o permesso «personale», e mai
 * attraverso un token emesso per Argos.
 */
export function vedeDatiPersonali(req: { user?: AuthUser; authVia?: string }): boolean {
  if (!req.user || req.authVia) return false;
  return req.user.role === "admin" || !!req.user.permissions?.personale;
}

/**
 * I codici sanitari delle voci del roster (malattia, infortunio, 104): admin
 * o permesso «roster», e mai attraverso un token emesso per Argos. Chi non
 * li vede legge un'assenza generica (lib/roster-voci.ts).
 */
export function vedeCodiciSanitari(req: { user?: AuthUser; authVia?: string }): boolean {
  if (!req.user || req.authVia) return false;
  return req.user.role === "admin" || !!req.user.permissions?.roster;
}

export function haPermesso(req: { user?: AuthUser }, p: Permission): boolean {
  if (!req.user) return false;
  return req.user.role === "admin" || !!req.user.permissions?.[p];
}

/**
 * Mappa prefisso-URL → dominio di permesso. È l'ENFORCEMENT RBAC centrale: i
 * router sono montati senza prefisso (i path vivono dentro), quindi un singolo
 * middleware path-aware è più sicuro di N prepend (che bloccherebbero anche i
 * path non pertinenti). Ordine: le voci più specifiche PRIMA (es. /planning-studio
 * prima di /planning). Prefisso non mappato ⇒ solo-autenticato.
 */
const PERMISSION_BY_PREFIX: Array<[string, Permission | Permission[]]> = [
  // scheduling (turni, ottimizzatori, roster, depositi, coincidenze)
  ["/service-program", "scheduling"], ["/driver-shifts", "scheduling"],
  ["/driver-schedules", "scheduling"], ["/vehicle-schedules", "scheduling"],
  // La pubblicazione dei turni guida è dello Scheduling (chi fa i turni li
  // manda al roster); le sorgenti dei turni servono anche ai Misti.
  ["/roster/pubblicazioni", "scheduling"],
  ["/roster/duty-sources", ["scheduling", "roster"]],
  // Anagrafica del personale: chi ha «personale» deve poterla leggere e
  // scrivere anche senza «roster», e chi ha «roster» legge i dati
  // operativi (la mascheratura e le scritture si decidono nel singolo
  // handler). Queste voci stanno PRIMA di "/roster", che altrimenti vince.
  ["/roster/anagrafica/import", "personale"],
  ["/roster/anagrafica", ["roster", "personale"]],
  ["/roster/drivers", ["roster", "personale"]],
  ["/roster/history", "personale"],
  ["/roster/depositi", ["roster", "personale"]],
  ["/roster/categorie", ["roster", "personale"]],
  ["/roster/gruppi-turni", ["roster", "personale"]],
  ["/roster/rotazioni-riposi", ["roster", "personale"]],
  // il roster (tabellone, assegnazioni, voci, calendario, tratte dei turni)
  ["/roster", "roster"], ["/scheduling", "scheduling"],
  ["/service-db", "scheduling"],
  ["/deadheads", "scheduling"],
  // Depositi e archi fuorilinea sono infrastruttura di PROGETTO: si gestiscono
  // in Planner Studio (permesso network) e servono alla pipeline Scheduling
  // (permesso scheduling). Basta uno dei due.
  ["/deadhead-arcs", ["scheduling", "network"]], ["/depots", ["scheduling", "network"]],
  ["/coincidence-zones", ["scheduling", "network"]],
  // network (Planner Studio, rete, zonizzazione)
  // L'intermodale è una sezione del Planner Studio: stava sotto "analytics"
  // mentre la rotta frontend è gated su "network", così chi aveva solo
  // network vedeva la pagina e prendeva 403 su ogni chiamata, e chi aveva
  // solo analytics veniva rimbalzato alla dashboard.
  ["/planning-studio", "network"], ["/zones", "network"],
  // I nodi sono l'infrastruttura condivisa per eccellenza: il Planner Studio
  // li disegna, lo Scheduling Engine li usa come punti di cambio vettura.
  ["/clusters", ["network", "scheduling"]],
  ["/intermodal", "network"],
  // fares
  ["/fares", "fares"],
  // Centrale Operativa (Mappa live + AVM). Il parco letto da SIRI serve solo
  // alle due pagine del modulo; il resto di /siri (fermate Mizar, diagnostica)
  // resta solo-autenticato perché lo usa la scheda Dati.
  ["/siri/parco", "centrale"],
  // /operations è condiviso: la Mappa legge /live, /punctuality, /anomalie,
  // /vehicles; i Tempi di percorrenza (analytics) leggono /runtimes,
  // /copertura, e /trips lo leggono entrambi. Basta uno dei due permessi.
  ["/operations", ["centrale", "analytics"]],
  // analytics (analisi, territorio, gtfs, orari, intermodale)
  ["/analysis", "analytics"], ["/territory", "analytics"], ["/gtfs", "analytics"],
  ["/traffic", "analytics"], ["/poi", "analytics"], ["/population", "analytics"],
  ["/timetables", "analytics"], ["/planning", "analytics"],
  ["/scenarios", "analytics"], ["/weather", "analytics"],
  ["/calendar-presets", "analytics"], ["/settings", "analytics"],
];

/**
 * Letture che servono a più moduli, oltre a quello che possiede i dati: solo
 * GET e HEAD, con il percorso esatto. Si guardano prima della mappa qui sopra.
 * Senza, spegnere Analisi (analytics) lascerebbe la Fucina senza feed e
 * fermate, le Tariffe senza linee e confini, la Stampa Orari col dominio dei
 * QR sbagliato, e chi fa i turni senza la scelta del programma. Le scritture
 * restano al modulo che possiede i dati.
 */
const LETTURE_CONDIVISE: Array<[string | RegExp, Permission[]]> = [
  // feed e fermate: Fucina (scelta della data), fuorilinea, editor dei turni guida, zone di coincidenza
  ["/gtfs/feeds", ["analytics", "scheduling", "network"]],
  ["/gtfs/stops/all", ["analytics", "scheduling", "network"]],
  // la mappa delle Tariffe: linee, forme, fermate per linea, confini dei comuni
  ["/gtfs/routes", ["analytics", "fares"]],
  ["/gtfs/shapes/geojson", ["analytics", "fares"]],
  ["/gtfs/route-stop-ids", ["analytics", "fares"]],
  ["/territory/comuni-boundaries", ["analytics", "fares"]],
  // parametri letti dai motori dei turni e dalla Stampa Orari (il dominio dei QR)
  ["/settings/company-cars", ["analytics", "scheduling", "network"]],
  ["/settings/timetable-map-domain", ["analytics", "network"]],
  // le linee per i Tempi osservati (Esercizio)
  ["/timetables/routes", ["analytics", "centrale"]],
  // Rete e orari: confronto fra programmi; Analisi: elenco delle zone per le ipotesi di linea
  ["/planning/compare", ["analytics", "network"]],
  ["/coincidence-zones", ["scheduling", "network", "analytics"]],
  // Turni: la scelta del programma e l'unità di validità nel Quadro d'esercizio
  ["/planning-studio/projects", ["network", "scheduling"]],
  [/^\/planning-studio\/projects\/[0-9a-f-]{36}$/, ["network", "scheduling"]],
  [/^\/planning-studio\/projects\/[0-9a-f-]{36}\/validity-units\/[0-9a-f-]{36}\/detail$/, ["network", "scheduling"]],
];

/** Il permesso che apre questa lettura condivisa, se è una di quelle. */
export function letturaCondivisa(metodo: string, path: string): Permission[] | null {
  if (metodo !== "GET" && metodo !== "HEAD") return null;
  const p = path.toLowerCase();
  const voce = LETTURE_CONDIVISE.find(([chi]) => typeof chi === "string" ? p === chi : chi.test(p));
  return voce ? voce[1] : null;
}

export const requirePermissionByPath: RequestHandler = (req, res, next) => {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  if (req.user.role === "admin") { next(); return; }
  /* Express confronta i percorsi senza badare alle maiuscole: /Roster/drivers
   * arriva allo stesso handler di /roster/drivers. Il confronto qui deve fare
   * lo stesso, altrimenti basta una maiuscola per saltare il controllo. */
  const path = req.path.toLowerCase();
  const condivisa = letturaCondivisa(req.method, path);
  if (condivisa?.some(pp => req.user!.permissions?.[pp])) { next(); return; }
  for (const [prefix, perm] of PERMISSION_BY_PREFIX) {
    if (path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?")) {
      const needed = Array.isArray(perm) ? perm : [perm];
      if (needed.some(pp => req.user!.permissions?.[pp])) { next(); return; }
      res.status(403).json({ error: `Manca il permesso: ${needed.join(" o ")}` });
      return;
    }
  }
  next(); // prefisso non mappato: basta l'autenticazione
};

/* ────────────────────────────────────────────────────────────
 * Router /api/auth/* + /api/admin/users/*
 * ──────────────────────────────────────────────────────────── */
const router: IRouter = Router();

// POST /api/auth/login { email, password }
/* hash fittizi per chi non esiste e per pareggiare gli hash vecchi: il login
 * costa lo stesso tempo, e il tempo di risposta non dice quali email ci sono */
const HASH_FITTIZI = new Map<number, Promise<string>>();
function hashFittizio(costo: number): Promise<string> {
  let h = HASH_FITTIZI.get(costo);
  if (!h) { h = bcrypt.hash("nessuno-ha-questa-password", costo); HASH_FITTIZI.set(costo, h); }
  return h;
}

/**
 * Il confronto della password costa sempre come un hash di costo
 * BCRYPT_ROUNDS. Per un hash di prima, più leggero (costo r), si aggiungono
 * confronti fittizi di costo r, r+1, …, R-1: 2^r + 2^r + … + 2^(R-1) = 2^R.
 * Senza, chi esiste risponderebbe più in fretta di chi non esiste finché
 * tutti gli hash non sono rifatti.
 */
async function confrontaPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) { await bcrypt.compare(password, await hashFittizio(BCRYPT_ROUNDS)); return false; }
  const ok = await bcrypt.compare(password, hash);
  let costo = BCRYPT_ROUNDS;
  try { costo = bcrypt.getRounds(hash); } catch { /* hash strano: niente pareggio */ }
  for (let c = costo; c < BCRYPT_ROUNDS; c++) await bcrypt.compare(password, await hashFittizio(c));
  return ok;
}

/** L'indirizzo di chi prova: IPv4 intero, IPv6 per sottorete (/56), come il limitatore. */
let avvisatoIndirizzoInterno = false;
export function indirizzoDi(req: Request): string {
  const ip = req.ip ?? "";
  /* in produzione un indirizzo interno vuol dire che i proxy davanti all'API non sono
   * quelli di CERBERO_TRUST_PROXY: tutti avrebbero lo stesso indirizzo (DEPLOY.md) */
  if (!avvisatoIndirizzoInterno && process.env.NODE_ENV === "production" && indirizzoInterno(ip)) {
    avvisatoIndirizzoInterno = true;
    console.warn(`[auth] l'indirizzo dei client risulta interno (${ip}): controlla CERBERO_TRUST_PROXY, altrimenti il blocco per indirizzo vale per tutti insieme`);
  }
  return ipKeyGenerator(ip) || "?";
}
function indirizzoInterno(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4);
  return ip === "::1" || /^f[cd]/i.test(ip);
}

/** 429 per un blocco. Per quello dell'account non si dice quando finisce: servirebbe solo a chi lo tiene. */
export function rispostaBloccato(res: Response, fino: Date, che: "password" | "account" | "codici"): void {
  const minuti = Math.max(1, Math.ceil((fino.getTime() - Date.now()) / 60_000));
  res.status(429).json({
    error: che === "password"
      ? `Troppi tentativi sbagliati: riprova fra ${minuti} minuti, o chiedi all'amministratore di sbloccare l'account.`
      : che === "account"
        ? "Troppi tentativi sbagliati su questo account: riprova più tardi, o chiedi all'amministratore. Dai browser che hai già usato per entrare il blocco non vale."
        : `Troppi codici sbagliati: riprova fra ${minuti} minuti, o chiedi all'amministratore di sbloccare l'account.`,
  });
}

/** Entra davvero: cookie della sessione e del browser, ultimo accesso, registro. */
async function apriSessione(req: Request, res: Response, row: any, s: { mfa: boolean; rec?: boolean }): Promise<void> {
  await db.execute(sql`UPDATE users SET last_login_at = now() WHERE id = ${row.id}::uuid`);
  emettiSessione(res, row.id, { sv: Number(row.sessione_versione ?? 0), mfa: s.mfa, rec: s.rec });
  ricordaDispositivo(req, res, row.id, Number(row.dispositivi_versione ?? 1));
  await registraAccesso(req, { userId: row.id, email: row.email, esito: s.mfa ? "ok_con_verifica" : "ok" });
  const u = await loadUserById(row.id);
  res.json({
    user: u!.user,
    datiProva: datiProvaAttivi(),
    accesso: u ? (({ rifiuta: _r, ...a }) => a)(accessoDi(u, s)) : null,
  });
}

router.post("/auth/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await ensureUsersTable();
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email e password obbligatori" });
    return;
  }
  const chiave = chiaveEmail(email);
  const ip = indirizzoDi(req);
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active, password_hash,
           sessione_versione, dispositivi_versione, mfa_attiva, password_controllata
      FROM users WHERE lower(trim(email)) = ${chiave} ORDER BY ${ORDINE_STESSA_EMAIL} LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  /* il tentativo si conta prima del confronto, che è lento: per indirizzo e per
   * account (o per il browser, se da qui si è già entrati), e anche per le email
   * che non esistono (la risposta è la stessa) */
  const dispositivo = dispositivoPer(req, row ? { id: row.id, dv: Number(row.dispositivi_versione ?? 1) } : null);
  const prenotato = await prenotaTentativoPassword(chiave, ip, dispositivo);
  if (!prenotato.ok) {
    await registraAccesso(req, { userId: row?.id ?? null, email: row?.email ?? chiave, esito: prenotato.account ? "bloccato_account" : "bloccato" });
    rispostaBloccato(res, prenotato.fino, prenotato.account ? "account" : "password"); return;
  }
  // async: non blocca l'event loop durante l'hashing bcrypt (una login lenta
  // non deve congelare tutte le altre richieste).
  const ok = await confrontaPassword(password, row?.password_hash ?? null);
  if (!row) {
    await registraAccesso(req, { email: chiave, esito: "utente_sconosciuto" });
    res.status(401).json({ error: "Credenziali non valide" }); return;
  }
  if (!ok) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "password_errata" });
    res.status(401).json({ error: "Credenziali non valide" }); return;
  }
  /* password giusta: le serie di errori della password si chiudono (i codici hanno la loro) */
  await azzeraTentativiPassword(chiave, ip, dispositivo);
  if (!row.active) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "utente_inattivo" });
    res.status(401).json({ error: "Credenziali non valide" }); return;
  }
  /* password giusta ma pubblicata dal vecchio codice: l'account si chiude qui */
  if (ePasswordPubblicata(password)) {
    await db.execute(sql`UPDATE users SET active = false WHERE id = ${row.id}::uuid`);
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "password_pubblicata" });
    console.warn(`[auth] disattivato ${row.email}: ha provato a entrare con una password pubblicata nel vecchio codice`);
    res.status(403).json({ error: "Questa password era pubblica: l'account è stato disattivato. Chiedi all'amministratore di riattivarlo con una password nuova." });
    return;
  }
  /* hash di prima, più leggero: si rifà col costo di adesso, ora che la password c'è;
   * e la password, che non è una di quelle pubblicate, non si ricontrolla all'avvio */
  const rifai = bcrypt.getRounds(row.password_hash) < BCRYPT_ROUNDS;
  if (rifai || !row.password_controllata) {
    await db.execute(sql`
      UPDATE users SET password_controllata = true
             ${rifai ? sql`, password_hash = ${await bcrypt.hash(password, BCRYPT_ROUNDS)}` : sql``}
       WHERE id = ${row.id}::uuid AND password_hash = ${row.password_hash}`);
  }
  /* verifica in due passaggi attiva: niente sessione, un biglietto per il codice */
  if (row.mfa_attiva) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "codice_richiesto" });
    res.json({ mfaRichiesta: true, biglietto: firmaBiglietto(row.id, Number(row.sessione_versione ?? 0)) });
    return;
  }
  await apriSessione(req, res, row, { mfa: false });
});

// POST /api/auth/login/mfa { biglietto, codice } oppure { biglietto, recupero }
router.post("/auth/login/mfa", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await ensureUsersTable();
  const b = leggiBiglietto(req.body?.biglietto);
  if (!b) { res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return; }
  const r = await db.execute(sql`
    SELECT id, email, active, sessione_versione, dispositivi_versione, mfa_attiva FROM users WHERE id = ${b.sub}::uuid LIMIT 1`);
  const row: any = (r as any).rows?.[0];
  if (!row || !row.active || !row.mfa_attiva || Number(row.sessione_versione ?? 0) !== b.sv) {
    res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return;
  }
  const { codice, recupero } = req.body ?? {};
  const esito = await provaCodice(row.id, { codice, recupero }, { recupero: true, conta: true });
  switch (esito.esito) {
    case "bloccato":
      await registraAccesso(req, { userId: row.id, email: row.email, esito: "codici_bloccati" });
      rispostaBloccato(res, esito.fino, "codici"); return;
    case "illeggibile":
      await registraAccesso(req, { userId: row.id, email: row.email, esito: "segreto_illeggibile" });
      res.status(503).json({ error: "La verifica in due passaggi non è disponibile in questo momento: avvisa l'amministratore." }); return;
    case "riusato":
      res.status(401).json({ error: "Codice già usato: aspetta il prossimo" }); return;
    case "manca":
      res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return;
    case "errato":
      await registraAccesso(req, { userId: row.id, email: row.email, esito: esito.recupero ? "recupero_errato" : "codice_errato" });
      res.status(401).json({ error: esito.recupero ? "Codice di recupero non valido" : "Codice non valido" }); return;
  }
  if (esito.recupero) await registraAccesso(req, { userId: row.id, email: row.email, esito: "recupero_usato" });
  await apriSessione(req, res, { ...row, sessione_versione: b.sv }, { mfa: true, rec: esito.recupero });
});

// POST /api/auth/logout
router.post("/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/auth/me", requireAuth, (req, res) => {
  /* datiProva: se questa installazione permette i conducenti fittizi (lib/dati-prova.ts);
   * accesso: sessione limitata (password provvisoria, verifica da attivare) e stato della verifica */
  res.json({ user: req.user, datiProva: datiProvaAttivi(), accesso: req.accesso ?? null });
});

/* ─── SSO verso FleetCare (modulo Cerbero di gestione flotta) ───
 *
 * FleetCare è un'app separata (stesso database, schema `fleetcare`): chi ha un
 * account Cerbero ci entra SOLO da qui (FleetCare migrazione 0088). Il flusso:
 *   1. l'utente (già entrato in Cerbero, sessione completa) clicca "FleetCare"
 *      in sidebar, o apre <cerbero>/fleetcare dal pulsante «Entra con Cerbero»
 *   2. il frontend chiama questo endpoint (POST: da un altro sito non si può,
 *      la richiesta porta l'Origin e il CORS la ferma) → biglietto firmato con
 *      il segreto condiviso FLEETCARE_SSO_SECRET: 60 secondi, una volta sola (jti)
 *   3. il browser va a <FLEETCARE_URL>/api/auth/sso?token=…
 *   4. FleetCare verifica il biglietto, usa il jti, rilegge l'utente nel database
 *      e crea la SUA sessione; poi la ricontrolla ogni ~30 s (versione della
 *      sessione, account attivo, permesso, ruolo, verifica in due passaggi).
 *
 * Le sessioni limitate e i token di Argos non arrivano qui (requireAuth).
 */

/**
 * Chi entra in FleetCare e con quale ruolo: gli admin sempre, come fleet_admin;
 * gli altri con il permesso «fleetcare» e il ruolo scelto in Gestione Utenti.
 * Lo stesso calcolo è in FleetCare (fleetcare.cerbero_stato_utente, migrazione
 * 0088): se cambia qui, va cambiato anche là.
 */
export function accessoFleetCare(user: Pick<AuthUser, "role" | "permissions" | "fleetcareRole">): { abilitato: boolean; ruolo: string } {
  return {
    abilitato: user.role === "admin" || !!user.permissions?.fleetcare,
    ruolo: user.role === "admin" ? "fleet_admin" : user.fleetcareRole || "driver",
  };
}

/**
 * Il biglietto per FleetCare: chi è (sub), la versione della sua sessione
 * (sv: FleetCare chiude la propria quando cambia), quando è cominciata la
 * sessione Cerbero (at: quella di FleetCare non dura oltre le sue 12 ore) e un
 * jti che FleetCare accetta una volta sola. email, name e fleetcareRole restano
 * per il FleetCare di prima, durante il rilascio: quello nuovo li rilegge dal
 * database.
 */
export function firmaAccessoFleetCare(
  user: Pick<AuthUser, "id" | "email" | "fullName" | "role" | "permissions" | "fleetcareRole">,
  sessione: { sv: number; at?: number },
  secret: string,
): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.fullName ?? undefined,
      fleetcareRole: accessoFleetCare(user).ruolo,
      sv: sessione.sv,
      ...(typeof sessione.at === "number" ? { at: sessione.at } : {}),
    },
    secret,
    { expiresIn: "60s", issuer: "cerbero", audience: "fleetcare", jwtid: randomUUID() },
  );
}

/**
 * Dove tornare in FleetCare dopo l'ingresso (?da=, dal pulsante «Entra con
 * Cerbero» di una pagina chiesta prima del login): solo un percorso /fleet…,
 * mai un altro sito. FleetCare lo ricontrolla comunque (ritornoDopoIlLogin).
 */
export function ritornoFleetCare(da: unknown): string | null {
  if (typeof da !== "string" || da.length > 2000) return null;
  if (!/^\/fleet(?:[/?#]|$)/.test(da) || da.includes("//") || da.includes("\\")) return null;
  return da;
}

router.post("/auth/fleetcare-sso", requireAuth, async (req, res): Promise<void> => {
  const user = req.user!;
  if (!accessoFleetCare(user).abilitato) {
    res.status(403).json({ error: "Non sei abilitato a FleetCare: chiedi all'amministratore." });
    return;
  }
  const secret = process.env.FLEETCARE_SSO_SECRET;
  const fleetcareUrl = (process.env.FLEETCARE_URL || "").replace(/\/+$/, "");
  if (!secret || !fleetcareUrl) {
    res.status(503).json({
      error: "SSO FleetCare non configurato (FLEETCARE_SSO_SECRET / FLEETCARE_URL mancanti).",
    });
    return;
  }
  const token = firmaAccessoFleetCare(user, { sv: req.sessione!.sv, at: req.sessione?.at }, secret);
  /* il biglietto emesso, non l'ingresso: quello lo decide FleetCare */
  await registraAccesso(req, { userId: user.id, email: user.email, esito: "biglietto_fleetcare" });
  const da = ritornoFleetCare(req.body?.da);
  res.json({
    url: `${fleetcareUrl}/api/auth/sso?token=${encodeURIComponent(token)}${da ? `&da=${encodeURIComponent(da)}` : ""}`,
  });
});

/* ─── Lookup utenti (per picker membri progetto) ─── */
// GET /api/users/lookup?q=stringa  — accessibile a qualunque utente autenticato.
// Esclude l'utente corrente (non senso aggiungere se stesso). Limit 50.
router.get("/users/lookup", requireAuth, async (req, res): Promise<void> => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const meId = req.user!.id;
  // Serve una query di ≥2 caratteri: senza, si poteva dumpare l'intera rubrica
  // (email di tutti gli utenti → enumerazione/phishing). Gli admin non hanno
  // questo limite (usano la lista completa dal pannello admin).
  if (q.length < 2 && req.user!.role !== "admin") { res.json({ users: [] }); return; }
  const r = q
    ? await db.execute(sql`
        SELECT id, email, full_name FROM users
         WHERE active = true AND id <> ${meId}::uuid
           AND (lower(email) LIKE ${'%' + q + '%'} OR lower(coalesce(full_name,'')) LIKE ${'%' + q + '%'})
         ORDER BY email ASC LIMIT 20
      `)
    : await db.execute(sql`
        SELECT id, email, full_name FROM users
         WHERE active = true AND id <> ${meId}::uuid
         ORDER BY email ASC LIMIT 50
      `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  res.json({
    users: rows.map(u => ({ id: u.id, email: u.email, fullName: u.full_name })),
  });
});

/* ─── Admin: gestione utenti ─── */

// GET /api/admin/users
router.get("/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active, last_login_at, created_at,
           mfa_attiva, deve_cambiare_password, mfa_recupero_chiave,
           /* bloccato: per i codici sbagliati, o per la password da almeno un indirizzo */
           GREATEST(
             CASE WHEN mfa_bloccata_fino > now() THEN mfa_bloccata_fino END,
             (SELECT max(t.bloccato_fino) FROM accessi_tentativi t
               WHERE t.chiave = lower(trim(users.email)) AND t.bloccato_fino > now())
           ) AS bloccato_fino
      FROM users ORDER BY created_at ASC
  `);
  const rows: any[] = (r as any).rows ?? (r as any) ?? [];
  // Mappa snake_case -> camelCase per coerenza col resto della API
  const users = rows.map(u => ({
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    role: u.role,
    permissions: u.permissions,
    fleetcareRole: u.fleetcare_role ?? "driver",
    active: u.active,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    mfaAttiva: !!u.mfa_attiva,
    mfaObbligatoria: mfaObbligatoria({ role: u.role, permissions: u.permissions }),
    passwordDaCambiare: !!u.deve_cambiare_password,
    bloccatoFino: u.bloccato_fino ?? null,
    /* codici di recupero di una chiave che non è più quella attuale (cambio di chiave) */
    codiciDaRifare: !!u.mfa_attiva && !!u.mfa_recupero_chiave && u.mfa_recupero_chiave !== idChiave(),
  }));
  res.json({ users });
});

// POST /api/admin/users { email, password, fullName, role, permissions, fleetcareRole }
router.post("/admin/users", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { password, fullName, role, permissions, fleetcareRole } = req.body || {};
  /* un'email si scrive in un modo solo: il login non bada a maiuscole e spazi */
  const email = typeof req.body?.email === "string" ? chiaveEmail(req.body.email) : "";
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Email non valida" }); return;
  }
  const erroreP = erroreNuovaPassword(password, { email, nome: typeof fullName === "string" ? fullName : null });
  if (erroreP) { res.status(400).json({ error: erroreP }); return; }
  const safeRole = role === "admin" ? "admin" : "user";
  /* chi nasce senza indicazioni parte senza Analisi (lib/permessi.ts) */
  const safePerm = normalizzaPermessi(permissions, { nuovo: true });
  const safeFleetcareRole = (FLEETCARE_ROLES as readonly string[]).includes(fleetcareRole)
    ? fleetcareRole
    : "driver";
  try {
    const gia = await db.execute<any>(sql`SELECT 1 FROM users WHERE lower(trim(email)) = ${email} LIMIT 1`);
    if ((gia as any).rows?.length) { res.status(409).json({ error: "Email già registrata" }); return; }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await db.execute(sql`
      INSERT INTO users (email, password_hash, full_name, role, permissions, fleetcare_role, active, deve_cambiare_password, password_controllata)
      VALUES (${email}, ${hash}, ${fullName ?? null}, ${safeRole}, ${JSON.stringify(safePerm)}::jsonb, ${safeFleetcareRole}, true, true, true)
      RETURNING id, email, full_name, role, permissions, fleetcare_role, active, created_at
    `);
    const row: any = (r as any).rows?.[0] ?? (r as any)[0];
    res.json({ user: {
      id: row.id, email: row.email, fullName: row.full_name,
      role: row.role, permissions: row.permissions,
      fleetcareRole: row.fleetcare_role, active: row.active,
      createdAt: row.created_at,
    }});
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate")) {
      res.status(409).json({ error: "Email già registrata" }); return;
    }
    console.error("[admin.users.create] error:", e?.message || e);
    res.status(500).json({ error: "Errore creazione utente" });
  }
});

// PATCH /api/admin/users/:id { fullName?, role?, permissions?, fleetcareRole?, active?, password? }
router.patch("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const { fullName, role, permissions, fleetcareRole, active, password, resetMfa, sblocca } = req.body || {};
  const sets: any[] = [];
  let revoca = false;
  if (fullName !== undefined) sets.push(sql`full_name = ${fullName}`);
  if (role !== undefined) sets.push(sql`role = ${role === "admin" ? "admin" : "user"}`);
  if (permissions !== undefined) {
    /* l'oggetto intero, come lo manda Gestione Utenti; rete e orari porta con sé i turni (lib/permessi.ts) */
    sets.push(sql`permissions = ${JSON.stringify(normalizzaPermessi(permissions, { nuovo: false }))}::jsonb`);
  }
  if (fleetcareRole !== undefined) {
    if (!(FLEETCARE_ROLES as readonly string[]).includes(fleetcareRole)) {
      res.status(400).json({ error: `Ruolo FleetCare non valido: ${fleetcareRole}` }); return;
    }
    sets.push(sql`fleetcare_role = ${fleetcareRole}`);
  }
  if (active !== undefined) sets.push(sql`active = ${!!active}`);
  /* una password corta o banale si rifiuta: prima veniva ignorata in silenzio */
  if (password !== undefined) {
    const ur = await db.execute<any>(sql`SELECT email, full_name FROM users WHERE id = ${id}::uuid`);
    const u = (ur as any).rows?.[0];
    if (!u) { res.status(404).json({ error: "Utente non trovato" }); return; }
    const erroreP = erroreNuovaPassword(password, { email: u.email, nome: typeof fullName === "string" ? fullName : u.full_name });
    if (erroreP) { res.status(400).json({ error: erroreP }); return; }
    /* la password data dall'admin è provvisoria: al primo accesso va cambiata, e
     * le sessioni aperte si chiudono */
    sets.push(sql`password_hash = ${await bcrypt.hash(password, BCRYPT_ROUNDS)}`);
    sets.push(sql`deve_cambiare_password = true`, sql`password_cambiata_il = now()`, sql`password_controllata = true`);
    revoca = true;
  }
  /* telefono perso: si toglie la verifica (al prossimo accesso la riattiva) */
  if (resetMfa === true) {
    sets.push(sql`mfa_attiva = false`, sql`mfa_segreto = NULL`, sql`mfa_recupero = NULL`, sql`mfa_recupero_chiave = NULL`, sql`mfa_ultimo_passo = NULL`);
    revoca = true;
  }
  /* sblocca (e con una password nuova o la verifica tolta si riparte puliti) */
  if (sblocca === true || resetMfa === true) sets.push(sql`mfa_errori = 0`, sql`mfa_bloccata_fino = NULL`);
  if (active === false) revoca = true;
  if (revoca) sets.push(sql`sessione_versione = sessione_versione + 1`);
  /* password provvisoria o disattivazione: anche i browser riconosciuti si dimenticano
   * (non per «Reimposta verifica»: il solito computer deve restare riconosciuto) */
  if (password !== undefined || active === false) sets.push(sql`dispositivi_versione = dispositivi_versione + 1`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  // Concatena gli assignment con virgole
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE users SET ${assignments} WHERE id = ${id}::uuid
    RETURNING id, email, full_name, role, permissions, fleetcare_role, active
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Utente non trovato" }); return; }
  /* la password da ogni indirizzo: sbloccata, o nuova (la provvisoria deve poter entrare) */
  if (sblocca === true || password !== undefined) await azzeraTuttiITentativiPassword(chiaveEmail(row.email));
  /* nel registro degli accessi: chi ha fatto che cosa sull'accesso di chi */
  const azioni = [
    password !== undefined && "password_provvisoria", resetMfa === true && "verifica_tolta",
    sblocca === true && "sbloccato", active === false && "disattivato", active === true && "riattivato",
  ].filter((x): x is string => !!x);
  for (const a of azioni) await registraAccesso(req, { userId: id, email: row.email, esito: `admin:${a} (${req.user!.email})` });
  res.json({ user: {
    id: row.id, email: row.email, fullName: row.full_name,
    role: row.role, permissions: row.permissions,
    fleetcareRole: row.fleetcare_role, active: row.active,
  }});
});

// DELETE /api/admin/users/:id
router.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  if (req.user?.id === id) { res.status(400).json({ error: "Non puoi eliminare te stesso" }); return; }
  await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid`);
  res.json({ ok: true });
});

export default router;
