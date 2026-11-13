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
import { conContesto, inSistema } from "@workspace/db/contesto";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ipKeyGenerator } from "express-rate-limit";
import { loginLimiter } from "../middlewares/rate-limit";
import { decidiPrimoAdmin, ePasswordPubblicata, erroreNuovaPassword, PASSWORD_PUBBLICATE } from "./password-regole";
import { aziendaOppureNeutra, aziendaPerLaWeb, paroleVietateDellAzienda } from "./azienda";
import {
  depositiPuliti, dirittiEVista, livelloDelMetodo, permessiDopo, profiloDaRiga, puo,
  ruoliSconosciuti, ruoliValidi, vedeDatiSanitari, MAX_DEPOSITI_PER_UTENTE, NOMI_AREE,
  type Area, type Diritti, type InterruttoreDiPrima, type Livello, type Permission, type RuoloAziendale,
} from "./permessi";
import { decidi } from "./permessi-rotte";
import { datiProvaAttivi } from "./dati-prova";
import { logger } from "./logger";
import { azioniAdmin } from "./azioni-admin";
import { idChiave } from "./mfa-cifratura";
import { SQL_MFA_OBBLIGATORIA, chiaveEmail, limitazione, percorsoConsentitoLimitato, percorsoVietatoAiServizi, type Limitazione } from "./accesso-regole";
import {
  azzeraTentativiPassword, azzeraTuttiITentativiPassword, controllaChiaveMfa, forsePulisciAccessi, prenotaTentativoPassword,
  provaCodice, pulisciAccessi,
} from "./accesso-db";
import { viaPerIlDatabase } from "./agent-context";

/* ────────────────────────────────────────────────────────────
 * Tipi
 * ──────────────────────────────────────────────────────────── */
/* ruoli aziendali, aree e livelli: lib/permessi.ts (il pacchetto @workspace/permessi) */
export type { Permission };
export interface AuthUser {
  id: string;
  email: string;
  fullName: string | null;
  /** "admin" è l'amministratore di sistema: non un ruolo di lavoro, può tutto */
  role: "admin" | "user";
  /** i ruoli aziendali: ognuno dà lettura o scrittura per area */
  ruoli: RuoloAziendale[];
  /** gli interruttori di prima dei ruoli ancora accesi: valgono scrittura sulla loro area */
  accessoDiPrima: Partial<Record<InterruttoreDiPrima, true>>;
  /** vede i codici sanitari del roster (malattia, infortunio, 104) */
  datiSanitari: boolean;
  /** vede l'area Analisi */
  analisi: boolean;
  /** i depositi a cui è limitata la sua scrittura sul roster; vuoto = nessun limite (lib/roster-limite-depositi.ts) */
  depositi: string[];
  /** quello che ne risulta, area per area: è su questo che si decide */
  diritti: Diritti;
  /** la vista di prima (un interruttore = almeno la lettura sulla sua area): la leggono FleetCare e i client di prima */
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
 * Preparazione degli utenti e primo amministratore
 * Tabelle, colonne e indici li fanno le migrazioni (lib/db/migrations), che
 * girano prima dell'API: qui si toccano solo i dati.
 * ──────────────────────────────────────────────────────────── */
let bootstrapped = false;
let preparazione: Promise<void> | null = null;

/** Un elenco di nomi come parametro text[] ('{a,b}'): solo nomi già passati da ruoliValidi. */
const pgArray = (nomi: readonly string[]): string => `{${nomi.filter(n => /^[a-z_]+$/.test(n)).join(",")}}`;
/** Una sola preparazione anche se arrivano tante richieste insieme all'avvio; se fallisce, la prossima riprova. */
export function utentiPronti(): Promise<void> {
  if (bootstrapped) return Promise.resolve();
  /* è del sistema anche se la fa partire (o ripartire) una richiesta: non va attribuita a lei (PR 2.9) */
  preparazione ??= inSistema("avvio:utenti", () => preparaUtenti().then(
    () => {
      bootstrapped = true;
      void disattivaPasswordPubblicate("altri").catch((e: any) => console.error("[auth] controllo password pubblicate:", e?.message || e));
      void controllaChiaveMfa().catch((e: any) => console.error("[auth] controllo chiave della verifica:", e?.message || e));
    },
    (e: any) => { console.error("[auth] preparazione degli utenti non riuscita:", e?.message || e); preparazione = null; },
  ));
  return preparazione;
}

/** Le righe con la stessa email (maiuscole o spazi diversi, da prima): vince quella attiva più vecchia, sempre la stessa. */
const ORDINE_STESSA_EMAIL = sql`active DESC, created_at ASC, id ASC`;

async function preparaUtenti(): Promise<void> {
  /* il registro degli accessi tiene 12 mesi */
  await pulisciAccessi();
  /* un'email, un utente (maiuscole e spazi non contano): l'indice unico lo fa la
   * migrazione 0000_baseline, che lo salta se ci sono già doppioni. Qui si
   * controlla soltanto, e lo si dice finché manca */
  const indice = await db.execute<any>(sql`
    SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'users_email_normale_uq'`);
  if (!(indice as any).rows?.length) {
    console.warn("[auth] manca l'indice unico delle email (users_email_normale_uq): ci sono utenti con la stessa email scritta in modi diversi (maiuscole, spazi). Unificali da Gestione Utenti, poi crea l'indice come dice DEPLOY.md («L'indice unico delle email»)");
  }

  /* gli admin con una password pubblicata si disattivano subito (sono pochi, e il
     recupero qui sotto deve sapere se ne resta uno); gli altri dopo, in background */
  await disattivaPasswordPubblicate("admin");

  const cnt = await db.execute(sql`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
  const nAdmin = ((cnt as any).rows?.[0] ?? (cnt as any)[0])?.n ?? 0;
  const primo = decidiPrimoAdmin(nAdmin, process.env, await paroleVietateDellAzienda());
  if (primo.tipo === "crea") {
    /* se l'email c'è già (per esempio l'admin appena disattivato, anche scritta con
     * le maiuscole) si rimette in piedi la stessa riga con cui si entra */
    const hash = await bcrypt.hash(primo.password, BCRYPT_ROUNDS);
    const rimesso = await db.execute<any>(sql`
      UPDATE users SET
        password_hash = ${hash}, password_cambiata_il = now(), role = 'admin', active = true, deve_cambiare_password = true, password_controllata = true,
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
          ${JSON.stringify(dirittiEVista(profiloDaRiga({ role: "admin" })).permissions)}::jsonb,
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

  await riallineaVistaPermessi();
}

/**
 * users.permissions è la vista che leggono FleetCare (chi può entrare) e la
 * colonna calcolata mfa_obbligatoria: un interruttore è acceso se l'utente ha
 * almeno la lettura su una delle sue aree. La scrive Gestione utenti a ogni
 * modifica; qui si rimette a posto per chi non coincide, cioè dopo un cambio
 * della matrice dei ruoli nel codice o una riga toccata a mano. Gli
 * amministratori non contano: per loro decide il ruolo, non la vista.
 */
export async function riallineaVistaPermessi(): Promise<number> {
  const r = await db.execute<any>(sql`
    SELECT id, role, ruoli, accesso_di_prima, dati_sanitari, analisi, permissions FROM users WHERE role <> 'admin'`);
  let n = 0;
  for (const row of ((r as any).rows ?? []) as any[]) {
    const vista = dirittiEVista(profiloDaRiga(row)).permissions;
    const scritta = row.permissions && typeof row.permissions === "object" ? row.permissions as Record<string, unknown> : {};
    const chiavi = Object.keys(vista) as Permission[];
    if (Object.keys(scritta).length === chiavi.length && chiavi.every(k => scritta[k] === vista[k])) continue;
    /* solo se nel frattempo nessuno ha cambiato i suoi ruoli: altrimenti la vista giusta l'ha già scritta lui */
    const fatto = await db.execute<any>(sql`
      UPDATE users SET permissions = ${JSON.stringify(vista)}::jsonb
       WHERE id = ${row.id}::uuid AND role <> 'admin'
         AND ruoli = ${pgArray(profiloDaRiga(row).ruoli)}::text[] AND accesso_di_prima = ${JSON.stringify(row.accesso_di_prima ?? {})}::jsonb
         AND dati_sanitari = ${row.dati_sanitari === true} AND analisi = ${row.analisi === true}
      RETURNING id`);
    if ((fatto as any).rows?.length) n++;
  }
  if (n > 0) logger.info({ utenti: n }, "vista dei permessi (users.permissions) riallineata ai ruoli");
  return n;
}
void utentiPronti();

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

interface UtenteCaricato {
  user: AuthUser; sv: number; mfaAttiva: boolean; deveCambiarePassword: boolean; codiciChiave: string | null;
  /** La colonna calcolata users.mfa_obbligatoria: la regola sta nel database (migrazione 0008). */
  mfaObbligatoria: boolean;
}

/* La regola letta da users: una costante di accesso-regole.ts, senza dati di nessuno (sql.raw non prende altro) */
const MFA_OBBLIGATORIA = sql.raw(SQL_MFA_OBBLIGATORIA); // scan-ok: testo costante del codice

/**
 * L'utente dalla sua riga. I diritti si calcolano qui, da ruoli, accesso di
 * prima e capacità: la colonna permissions non si legge, è solo la vista che
 * l'API scrive per chi sta fuori (FleetCare, la regola della verifica).
 */
export function utenteDaRiga(row: any): AuthUser {
  const profilo = profiloDaRiga(row);
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name ?? null,
    role: profilo.admin ? "admin" : "user",
    ruoli: profilo.ruoli,
    accessoDiPrima: profilo.accessoDiPrima,
    datiSanitari: profilo.datiSanitari,
    analisi: profilo.analisi,
    depositi: profilo.depositi,
    ...dirittiEVista(profilo),
    fleetcareRole: row.fleetcare_role ?? "driver",
    active: !!row.active,
  };
}

async function loadUserById(id: string): Promise<UtenteCaricato | null> {
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, ruoli, accesso_di_prima, dati_sanitari, analisi, depositi, fleetcare_role, active,
           sessione_versione, mfa_attiva, ${MFA_OBBLIGATORIA} AS mfa_obbligatoria, deve_cambiare_password, mfa_recupero_chiave
      FROM users WHERE id = ${id}::uuid LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) return null;
  return {
    user: utenteDaRiga(row),
    sv: Number(row.sessione_versione ?? 0),
    mfaAttiva: !!row.mfa_attiva,
    // la colonna è NOT NULL: se non arriva un «false» scritto, la verifica resta obbligatoria
    mfaObbligatoria: row.mfa_obbligatoria !== false,
    deveCambiarePassword: !!row.deve_cambiare_password,
    codiciChiave: row.mfa_recupero_chiave ?? null,
  };
}

/** Lo stato dell'accesso di un utente caricato, con la sessione che sta usando. */
function accessoDi(u: UtenteCaricato, sessione: { mfa: boolean; rec?: boolean }): Accesso & { rifiuta: boolean } {
  const lim = limitazione({ mfaObbligatoria: u.mfaObbligatoria, deveCambiarePassword: u.deveCambiarePassword, mfaAttiva: u.mfaAttiva }, sessione);
  return {
    limitato: lim === "rifiuta" ? null : lim,
    rifiuta: lim === "rifiuta",
    mfaAttiva: u.mfaAttiva,
    mfaObbligatoria: u.mfaObbligatoria,
    passwordDaCambiare: u.deveCambiarePassword,
    recupero: !!sessione.rec && u.mfaAttiva,
    codiciDaRifare: u.mfaAttiva && !!u.codiciChiave && u.codiciChiave !== idChiave(),
  };
}

/* ────────────────────────────────────────────────────────────
 * Middleware
 * ──────────────────────────────────────────────────────────── */
export const requireAuth: RequestHandler = async (req, res, next) => {
  await utentiPronti();
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
  // da qui in poi ogni connessione al database sa chi è (cerbero.attore, PR 2.9)
  conContesto({ attore: u.user.id, via: viaPerIlDatabase(verificato.via) }, next);
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

/**
 * Ha almeno questo livello sull'area? L'amministratore di sistema sempre.
 * È la domanda che fanno gli handler quando il percorso non basta a decidere.
 */
export function haDiritto(req: { user?: AuthUser }, area: Area, livello: Livello): boolean {
  if (!req.user) return false;
  return req.user.role === "admin" || puo(req.user.diritti, area, livello);
}

/**
 * Per le rotte che vogliono un'area precisa, più stretta del loro prefisso:
 * lettura per GET e HEAD, scrittura per il resto.
 */
export function richiedeDiritto(area: Area): RequestHandler {
  return (req, res, next) => {
    if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
    /* i dati personali non passano a un servizio che agisce per conto dell'utente */
    if (area === "personale" && req.authVia) { res.status(403).json({ error: "Dati del personale non disponibili da questo canale" }); return; }
    const livello = livelloDelMetodo(req.method);
    if (haDiritto(req, area, livello)) { next(); return; }
    /* solaLettura: la web riconosce il caso da qui, non dal testo */
    if (livello === "S" && haDiritto(req, area, "L")) {
      res.status(403).json({ error: `Sola lettura: per modificare serve la scrittura su «${NOMI_AREE[area]}»`, solaLettura: true });
      return;
    }
    res.status(403).json({ error: `Manca l'accesso a «${NOMI_AREE[area]}»` });
  };
}

/**
 * Chi può VEDERE i dati personali dell'anagrafica (contatti, residenza, paghe,
 * ferie, visite): l'amministratore o chi ha almeno la lettura su «Personale»,
 * e mai attraverso un token emesso per Argos.
 */
export function vedeDatiPersonali(req: { user?: AuthUser; authVia?: string }): boolean {
  if (!req.user || req.authVia) return false;
  return haDiritto(req, "personale", "L");
}

/** Chi può SCRIVERE i dati personali dell'anagrafica: serve la scrittura su «Personale». */
export function scriveDatiPersonali(req: { user?: AuthUser; authVia?: string }): boolean {
  if (!req.user || req.authVia) return false;
  return haDiritto(req, "personale", "S");
}

/**
 * I codici sanitari delle voci del roster (malattia, infortunio, 104):
 * l'amministratore o chi ha la capacità «dati sanitari» (e può aprire il
 * roster), e mai attraverso un token emesso per Argos. Chi non li vede legge
 * un'assenza generica (lib/roster-voci.ts).
 */
export function vedeCodiciSanitari(req: { user?: AuthUser; authVia?: string }): boolean {
  if (!req.user || req.authVia) return false;
  const u = req.user;
  return vedeDatiSanitari({ admin: u.role === "admin", ruoli: u.ruoli, accessoDiPrima: u.accessoDiPrima, analisi: u.analisi, datiSanitari: u.datiSanitari });
}

/**
 * Il controllo centrale: quale area e quale livello servono per il percorso lo
 * dice lib/permessi-rotte.ts (deny by default: un percorso senza voce è solo
 * dell'amministratore).
 */
export const requirePermissionByPath: RequestHandler = (req, res, next) => {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  const esito = decidi({ admin: req.user.role === "admin", diritti: req.user.diritti }, req.method, req.path);
  if (esito.passa) { next(); return; }
  // un 403 senza voce vuol dire quasi sempre una voce dimenticata in AREE_PER_PREFISSO: il log lo dice
  if (esito.senzaVoce) logger.warn({ metodo: req.method, percorso: req.path, utente: req.user.id }, "percorso senza permesso assegnato: 403");
  res.status(403).json(esito.solaLettura ? { error: esito.errore, solaLettura: true } : { error: esito.errore });
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
    /* come /auth/me: chi entra ha subito nome, città e centro delle mappe dell'azienda */
    azienda: aziendaPerLaWeb(await aziendaOppureNeutra()),
  });
}

router.post("/auth/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await utentiPronti();
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email e password obbligatori" });
    return;
  }
  const chiave = chiaveEmail(email);
  const ip = indirizzoDi(req);
  const r = await db.execute(sql`
    SELECT id, email, active, password_hash,
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
  /* da qui la persona è identificata (password giusta): le scritture su users sono sue (PR 2.9) */
  await conContesto({ attore: row.id, via: "accesso" }, async () => {
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
});

// POST /api/auth/login/mfa { biglietto, codice } oppure { biglietto, recupero }
router.post("/auth/login/mfa", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await utentiPronti();
  const b = leggiBiglietto(req.body?.biglietto);
  if (!b) { res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return; }
  const r = await db.execute(sql`
    SELECT id, email, active, sessione_versione, dispositivi_versione, mfa_attiva FROM users WHERE id = ${b.sub}::uuid LIMIT 1`);
  const row: any = (r as any).rows?.[0];
  if (!row || !row.active || !row.mfa_attiva || Number(row.sessione_versione ?? 0) !== b.sv) {
    res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return;
  }
  /* il biglietto dice chi è: i contatori dei codici e l'accesso sono suoi (PR 2.9) */
  await conContesto({ attore: row.id, via: "accesso" }, async () => {
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
});

// POST /api/auth/logout
router.post("/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/auth/me", requireAuth, async (req, res) => {
  /* datiProva: se questa installazione permette i conducenti fittizi (lib/dati-prova.ts);
   * accesso: sessione limitata (password provvisoria, verifica da attivare) e stato della verifica;
   * azienda: nome, città e centro della mappa di questa installazione (lib/azienda.ts). Se non si
   * riesce a leggerla la sessione vale lo stesso, con i valori neutri */
  res.json({
    user: req.user, datiProva: datiProvaAttivi(), accesso: req.accesso ?? null,
    azienda: aziendaPerLaWeb(await aziendaOppureNeutra()),
  });
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
    /* permissions è la vista compatibile: «fleetcare» è acceso per chi ha almeno la lettura su «Flotta» */
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
  /* serve alle finestre di condivisione dei progetti (Turni, Planning Studio):
   * chi non ha quei moduli non la vede, e nemmeno i token emessi per Argos */
  if (req.authVia) { res.status(403).json({ error: "Non disponibile da questo canale" }); return; }
  if (!haDiritto(req, "rete", "L") && !haDiritto(req, "turni", "L")) {
    res.status(403).json({ error: "Manca l'accesso a «Rete e orari» o «Turni»" }); return;
  }
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
  const meId = req.user!.id;
  // Serve una query di ≥2 caratteri: senza, si poteva dumpare l'intera rubrica
  // (email di tutti gli utenti → enumerazione/phishing). Gli admin non hanno
  // questo limite (usano la lista completa dal pannello admin).
  if (q.length < 2 && req.user!.role !== "admin") { res.json({ users: [] }); return; }
  /* % e _ sono caratteri come gli altri: altrimenti «%%» o «__» elencano tutti */
  const modello = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const r = q
    ? await db.execute(sql`
        SELECT id, email, full_name FROM users
         WHERE active = true AND id <> ${meId}::uuid
           AND (lower(email) LIKE ${modello} ESCAPE '\\' OR lower(coalesce(full_name,'')) LIKE ${modello} ESCAPE '\\')
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
    SELECT id, email, full_name, role, ruoli, accesso_di_prima, dati_sanitari, analisi, depositi, fleetcare_role, active, last_login_at, created_at,
           mfa_attiva, ${MFA_OBBLIGATORIA} AS mfa_obbligatoria, deve_cambiare_password, mfa_recupero_chiave,
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
    /* ruoli, accesso di prima, capacità e i diritti che ne risultano (utenteDaRiga) */
    ...utenteDaRiga(u),
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    mfaAttiva: !!u.mfa_attiva,
    mfaObbligatoria: u.mfa_obbligatoria !== false,
    passwordDaCambiare: !!u.deve_cambiare_password,
    bloccatoFino: u.bloccato_fino ?? null,
    /* codici di recupero di una chiave che non è più quella attuale (cambio di chiave) */
    codiciDaRifare: !!u.mfa_attiva && !!u.mfa_recupero_chiave && u.mfa_recupero_chiave !== idChiave(),
  }));
  res.json({ users });
});

/**
 * I campi dei permessi come arrivano da Gestione utenti. Un ruolo che non
 * esiste è un errore (non si scarta in silenzio: l'admin crederebbe di averlo
 * dato), e così `permissions`, che mandano i client di prima dei ruoli.
 */
function leggiPermessiRichiesti(corpo: any): { errore: string } | { ruoli?: RuoloAziendale[]; datiSanitari?: boolean; analisi?: boolean; accessoDiPrima?: unknown; depositi?: string[] } {
  const out: { ruoli?: RuoloAziendale[]; datiSanitari?: boolean; analisi?: boolean; accessoDiPrima?: unknown; depositi?: string[] } = {};
  /* la pagina di prima dei ruoli (rimasta aperta in un browser durante il rilascio) manda gli
   * interruttori: non si scartano in silenzio, altrimenti l'admin crederebbe di averli cambiati */
  if (corpo?.permissions !== undefined) return { errore: "I permessi ora si danno con i ruoli aziendali: ricarica la pagina" };
  if (corpo?.ruoli !== undefined) {
    if (!Array.isArray(corpo.ruoli)) return { errore: "ruoli: serve un elenco" };
    const ignoti = ruoliSconosciuti(corpo.ruoli);
    if (ignoti.length) return { errore: `Ruolo aziendale sconosciuto: ${ignoti.map(r => String(r).slice(0, 40)).join(", ")}` };
    out.ruoli = ruoliValidi(corpo.ruoli);
  }
  for (const k of ["datiSanitari", "analisi"] as const) {
    if (corpo?.[k] === undefined) continue;
    if (typeof corpo[k] !== "boolean") return { errore: `${k}: serve vero o falso` };
    out[k] = corpo[k];
  }
  if (corpo?.accessoDiPrima !== undefined) out.accessoDiPrima = corpo.accessoDiPrima;
  /* i depositi: un elenco di codici. Scritto male è un errore, non «nessun limite» */
  if (corpo?.depositi !== undefined) {
    if (!Array.isArray(corpo.depositi) || corpo.depositi.some((d: unknown) => typeof d !== "string" || !d.trim())) {
      return { errore: "depositi: serve un elenco di codici di deposito" };
    }
    if (corpo.depositi.length > MAX_DEPOSITI_PER_UTENTE) return { errore: `depositi: al più ${MAX_DEPOSITI_PER_UTENTE}` };
    out.depositi = depositiPuliti(corpo.depositi);
  }
  return out;
}

/** Un elenco di testi come valore text[]: ogni elemento è un parametro, mai testo dentro l'SQL. */
const arrayDiTesti = (v: readonly string[]) =>
  v.length ? sql`ARRAY[${sql.join(v.map(x => sql`${x}`), sql`, `)}]::text[]` : sql`'{}'::text[]`;

/**
 * I depositi chiesti che non sono nel catalogo (public.roster_depositi). Un
 * codice sbagliato non corrisponderebbe a nessun conducente: la persona
 * resterebbe limitata a niente, o si crederebbe limitata a un deposito che non
 * lo è. Si rifiuta, come un ruolo che non esiste.
 */
async function depositiSconosciuti(ex: { execute: (q: any) => Promise<any> }, chiesti: readonly string[]): Promise<string[]> {
  if (!chiesti.length) return [];
  const r = await ex.execute(sql`SELECT codice FROM roster_depositi`);
  const noti = new Set<string>(((r as any).rows ?? []).map((x: any) => String(x.codice)));
  return chiesti.filter(c => !noti.has(c));
}

const COLONNE_UTENTE = sql.raw("id, email, full_name, role, ruoli, accesso_di_prima, dati_sanitari, analisi, depositi, permissions, fleetcare_role, active, created_at"); // scan-ok: testo costante del codice

// POST /api/admin/users { email, password, fullName, role, ruoli, datiSanitari, analisi, depositi, fleetcareRole }
router.post("/admin/users", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { password, fullName, role, fleetcareRole } = req.body || {};
  const chiesti = leggiPermessiRichiesti(req.body);
  if ("errore" in chiesti) { res.status(400).json({ error: chiesti.errore }); return; }
  /* un'email si scrive in un modo solo: il login non bada a maiuscole e spazi */
  const email = typeof req.body?.email === "string" ? chiaveEmail(req.body.email) : "";
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Email non valida" }); return;
  }
  const erroreP = erroreNuovaPassword(password, { email, nome: typeof fullName === "string" ? fullName : null }, await paroleVietateDellAzienda());
  if (erroreP) { res.status(400).json({ error: erroreP }); return; }
  const safeRole = role === "admin" ? "admin" : "user";
  /* un utente nuovo ha solo quello che gli danno i ruoli: nessun accesso di prima, e
   * senza ruoli non apre nessuna area finché l'amministratore non gliene dà */
  const nuovo = permessiDopo({ role: "user" }, {
    role: safeRole, ruoli: chiesti.ruoli ?? [], datiSanitari: chiesti.datiSanitari ?? false, analisi: chiesti.analisi ?? false,
    depositi: chiesti.depositi ?? [],
  });
  const vista = nuovo.permissions;
  const safeFleetcareRole = (FLEETCARE_ROLES as readonly string[]).includes(fleetcareRole)
    ? fleetcareRole
    : "driver";
  try {
    const gia = await db.execute<any>(sql`SELECT 1 FROM users WHERE lower(trim(email)) = ${email} LIMIT 1`);
    if ((gia as any).rows?.length) { res.status(409).json({ error: "Email già registrata" }); return; }
    const ignoti = await depositiSconosciuti(db, nuovo.depositi);
    if (ignoti.length) { res.status(400).json({ error: `Deposito sconosciuto: ${ignoti.map(d => d.slice(0, 40)).join(", ")}` }); return; }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await db.execute(sql`
      INSERT INTO users (email, password_hash, full_name, role, ruoli, dati_sanitari, analisi, depositi, permissions, fleetcare_role, active, deve_cambiare_password, password_controllata)
      VALUES (${email}, ${hash}, ${fullName ?? null}, ${safeRole}, ${pgArray(nuovo.ruoli)}::text[], ${nuovo.dati_sanitari}, ${nuovo.analisi},
              ${arrayDiTesti(nuovo.depositi)}, ${JSON.stringify(vista)}::jsonb, ${safeFleetcareRole}, true, true, true)
      RETURNING ${COLONNE_UTENTE}
    `);
    const row: any = (r as any).rows?.[0] ?? (r as any)[0];
    for (const a of azioniAdmin(null, row)) {
      await registraAccesso(req, { userId: row.id, email: row.email, esito: `admin:${a} (${req.user!.email})` });
    }
    res.json({ user: { ...utenteDaRiga(row), createdAt: row.created_at } });
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate")) {
      res.status(409).json({ error: "Email già registrata" }); return;
    }
    console.error("[admin.users.create] error:", e?.message || e);
    res.status(500).json({ error: "Errore creazione utente" });
  }
});

// PATCH /api/admin/users/:id { fullName?, role?, ruoli?, datiSanitari?, analisi?, accessoDiPrima?, depositi?, fleetcareRole?, active?, password? }
// accessoDiPrima: gli interruttori di prima da tenere accesi. Si possono solo togliere.
// depositi: i codici dei depositi a cui limitare la scrittura sul roster; [] toglie il limite.
router.patch("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  const { fullName, role, fleetcareRole, active, password, resetMfa, sblocca } = req.body || {};
  const chiesti = leggiPermessiRichiesti(req.body);
  if ("errore" in chiesti) { res.status(400).json({ error: chiesti.errore }); return; }
  const cambiaPermessi = role !== undefined || chiesti.ruoli !== undefined || chiesti.datiSanitari !== undefined
    || chiesti.analisi !== undefined || chiesti.accessoDiPrima !== undefined || chiesti.depositi !== undefined;
  const sets: any[] = [];
  let revoca = false;
  if (fullName !== undefined) sets.push(sql`full_name = ${fullName}`);
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
    const erroreP = erroreNuovaPassword(password, { email: u.email, nome: typeof fullName === "string" ? fullName : u.full_name }, await paroleVietateDellAzienda());
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
  if (sets.length === 0 && !cambiaPermessi) { res.json({ ok: true, noop: true }); return; }
  /* Lettura e scrittura nella stessa transazione, con la riga bloccata: i campi dei
   * permessi e la vista permissions si scrivono insieme, da un solo stato. */
  const esito = await db.transaction(async (tx) => {
    /* com'era prima: il registro scrive solo quello che cambia davvero */
    const pr = await tx.execute<any>(sql`
      SELECT role, ruoli, accesso_di_prima, dati_sanitari, analisi, depositi, permissions, fleetcare_role, full_name, active
        FROM users WHERE id = ${id}::uuid FOR UPDATE`);
    const prima = (pr as any).rows?.[0];
    if (!prima) return null;
    if (cambiaPermessi) {
      /* lo stato di prima con sopra la richiesta, e la vista permissions ricavata da lì (lib/permessi.ts) */
      const dopo = permessiDopo(prima, { role, ...chiesti });
      /* solo i depositi chiesti adesso: quelli che c'erano già non si ricontrollano
       * (un deposito tolto dal catalogo non deve impedire di cambiare un ruolo) */
      if (chiesti.depositi !== undefined) {
        const ignoti = await depositiSconosciuti(tx, dopo.depositi);
        if (ignoti.length) return { errore: `Deposito sconosciuto: ${ignoti.map(d => d.slice(0, 40)).join(", ")}` };
      }
      sets.push(
        sql`role = ${dopo.role}`, sql`ruoli = ${pgArray(dopo.ruoli)}::text[]`,
        sql`accesso_di_prima = ${JSON.stringify(dopo.accesso_di_prima)}::jsonb`,
        sql`dati_sanitari = ${dopo.dati_sanitari}`, sql`analisi = ${dopo.analisi}`,
        sql`depositi = ${arrayDiTesti(dopo.depositi)}`,
        sql`permissions = ${JSON.stringify(dopo.permissions)}::jsonb`,
      );
    }
    const r = await tx.execute(sql`
      UPDATE users SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid
      RETURNING ${COLONNE_UTENTE}
    `);
    return { prima, row: (r as any).rows?.[0] ?? (r as any)[0] };
  });
  if (esito && "errore" in esito) { res.status(400).json({ error: esito.errore }); return; }
  if (!esito?.row) { res.status(404).json({ error: "Utente non trovato" }); return; }
  const { prima, row } = esito;
  /* la password da ogni indirizzo: sbloccata, o nuova (la provvisoria deve poter entrare) */
  if (sblocca === true || password !== undefined) await azzeraTuttiITentativiPassword(chiaveEmail(row.email));
  /* nel registro degli accessi: chi ha fatto che cosa sull'accesso di chi
   * (ruolo, permessi, ruolo FleetCare, nome, password, verifica, blocco, stato) */
  const azioni = azioniAdmin(prima, row, { password: password !== undefined, resetMfa: resetMfa === true, sblocca: sblocca === true });
  for (const a of azioni) await registraAccesso(req, { userId: id, email: row.email, esito: `admin:${a} (${req.user!.email})` });
  res.json({ user: utenteDaRiga(row) });
});

// DELETE /api/admin/users/:id
router.delete("/admin/users/:id", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
  if (req.user?.id === id) { res.status(400).json({ error: "Non puoi eliminare te stesso" }); return; }
  const r = await db.execute<any>(sql`DELETE FROM users WHERE id = ${id}::uuid RETURNING id, email, role`);
  const tolto = (r as any).rows?.[0];
  if (tolto) {
    for (const a of azioniAdmin(tolto, null)) {
      await registraAccesso(req, { userId: tolto.id, email: tolto.email, esito: `admin:${a} (${req.user!.email})` });
    }
  }
  res.json({ ok: true });
});

export default router;
