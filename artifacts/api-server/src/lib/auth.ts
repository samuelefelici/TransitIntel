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
import { loginLimiter } from "../middlewares/rate-limit";
import { decidiPrimoAdmin, ePasswordPubblicata, erroreNuovaPassword, PASSWORD_PUBBLICATE } from "./password-regole";
import { datiProvaAttivi } from "./dati-prova";
import { limitazione, mfaObbligatoria, minutiDiBlocco, percorsoConsentitoLimitato, improntaRecupero, type Limitazione } from "./accesso-regole";
import { verificaCodice } from "./totp";
import { decifra } from "./mfa-cifratura";

/* ────────────────────────────────────────────────────────────
 * Tipi
 * ──────────────────────────────────────────────────────────── */
/**
 * I permessi sono i MODULI attivabili per utente. Un modulo nuovo si aggiunge
 * qui, nel DEFAULT della tabella, nel backfill di ensureUsersTable, nei due
 * handler admin (POST/PATCH) e nello speculare `Permission` del frontend
 * (hooks/use-auth.tsx): la chiave è un jsonb chiuso nel codice, non un enum.
 *   centrale = Centrale Operativa (Mappa live + AVM): attivazione ESPLICITA,
 *              come FleetCare.
 *   personale = Anagrafica del personale completa (dati personali, paghe,
 *              ferie, visite): attivazione ESPLICITA. Senza, il roster mostra
 *              solo i dati operativi dei conducenti.
 *   roster = Roster del personale (tabellone, assegnazioni, voci di
 *              assenza, rotazioni) con i codici sanitari (malattia,
 *              infortunio, 104). La pubblicazione dei turni resta a
 *              «scheduling».
 */
export type Permission = "analytics" | "fares" | "scheduling" | "network" | "fleetcare" | "centrale" | "personale" | "roster";
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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** il token è stato emesso per un servizio che agisce per conto dell'utente (es. "argos") */
      authVia?: string;
      /** la sessione: versione (si revoca alzandola) e se è passata dalla verifica in due passaggi */
      sessione?: { sv: number; mfa: boolean };
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
async function ensureUsersTable(): Promise<void> {
  if (bootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        full_name text,
        role text NOT NULL DEFAULT 'user',
        permissions jsonb NOT NULL DEFAULT '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":false,"personale":false,"roster":false}'::jsonb,
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
      ["password_cambiata_il", "timestamptz"],
      ["deve_cambiare_password", "boolean NOT NULL DEFAULT false"],
      ["tentativi_falliti", "integer NOT NULL DEFAULT 0"],
      ["bloccato_fino", "timestamptz"],
      ["mfa_attiva", "boolean NOT NULL DEFAULT false"],
      ["mfa_segreto", "text"],
      ["mfa_recupero", "jsonb"],
      ["mfa_ultimo_passo", "bigint"],
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
    await db.execute(sql`DELETE FROM accessi_log WHERE ts < now() - interval '12 months'`);

    // Backfill idempotente: assicura che ogni utente abbia la chiave "network"
    // (default true, così chi aveva già accesso a "scheduling" mantiene tutto).
    await db.execute(sql`
      UPDATE users
         SET permissions = permissions || '{"network":true}'::jsonb
       WHERE NOT (permissions ? 'network')
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
      /* se l'email c'è già (per esempio l'admin appena disattivato) si rimette in
       * piedi con la password nuova; ON CONFLICT copre anche due bootstrap insieme */
      await db.execute(sql`
        INSERT INTO users (email, password_hash, full_name, role, permissions, active, deve_cambiare_password)
        VALUES (
          ${primo.email}, ${bcrypt.hashSync(primo.password, BCRYPT_ROUNDS)}, 'Amministratore', 'admin',
          '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":true,"personale":false,"roster":true}'::jsonb,
          true, true
        )
        ON CONFLICT (email) DO UPDATE SET
          password_hash = EXCLUDED.password_hash, role = 'admin', active = true, deve_cambiare_password = true,
          tentativi_falliti = 0, bloccato_fino = NULL,
          mfa_attiva = false, mfa_segreto = NULL, mfa_recupero = NULL, mfa_ultimo_passo = NULL,
          sessione_versione = users.sessione_versione + 1
      `);
      console.log(`[auth] amministratore ${primo.email} pronto (da CERBERO_ADMIN_*): cambia la password al primo accesso e togli CERBERO_ADMIN_PASSWORD`);
    } else if (primo.tipo === "avviso") {
      console.warn(`[auth] ${primo.messaggio}`);
    }
    bootstrapped = true;
    void disattivaPasswordPubblicate("altri").catch((e: any) => console.error("[auth] controllo password pubblicate:", e?.message || e));
  } catch (e: any) {
    console.error("[auth] bootstrap users error:", e?.message || e);
  }
}
void ensureUsersTable();

/**
 * Disattiva gli account attivi che usano ancora una delle password che il
 * vecchio codice pubblicava in chiaro (PASSWORD_PUBBLICATE). Disattivare
 * chiude anche le sessioni già aperte: requireAuth controlla active. L'admin
 * li riattiva impostando una password nuova.
 */
async function disattivaPasswordPubblicate(quali: "admin" | "altri"): Promise<void> {
  const r = await db.execute(sql`
    SELECT id, email, password_hash FROM users
     WHERE active AND ${quali === "admin" ? sql`role = 'admin'` : sql`role <> 'admin'`}`);
  const righe: any[] = (r as any).rows ?? [];
  const bruciati: Array<{ id: string; email: string }> = [];
  for (const u of righe) {
    for (const p of PASSWORD_PUBBLICATE) {
      if (await bcrypt.compare(p, u.password_hash)) { bruciati.push({ id: u.id, email: u.email }); break; }
    }
  }
  if (!bruciati.length) return;
  await db.execute(sql`UPDATE users SET active = false WHERE id IN (${sql.join(bruciati.map(b => sql`${b.id}::uuid`), sql`, `)})`);
  console.warn(`[auth] disattivati ${bruciati.length} account con una password pubblicata nel vecchio codice: ${bruciati.map(b => b.email).join(", ")}. Riattivali da Gestione Utenti con una password nuova.`);
}

/* ────────────────────────────────────────────────────────────
 * Helpers JWT/cookie
 * ──────────────────────────────────────────────────────────── */
/** Il token della sessione: chi è, la versione della sessione, se è passata dalla verifica. */
export function signToken(userId: string, sv: number, mfa: boolean): string {
  return jwt.sign({ sub: userId, sv, ...(mfa ? { mfa: true } : {}) }, JWT_SECRET, { expiresIn: `${SESSIONE_ORE}h` });
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
  const r = await db.execute<any>(sql`SELECT sessione_versione, mfa_attiva FROM users WHERE id = ${userId}::uuid`);
  const u = (r as any).rows?.[0];
  return mintShortLivedUserToken(userId, { sv: Number(u?.sessione_versione ?? 0), mfa: !!u?.mfa_attiva });
}
function verifyToken(token: string): { sub: string; via?: string; sv: number; mfa: boolean } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; via?: unknown; sv?: unknown; mfa?: unknown; aud?: unknown };
    /* un biglietto della verifica (o altro con un destinatario) non è una sessione */
    if (decoded.aud !== undefined) return null;
    return {
      sub: decoded.sub, via: typeof decoded.via === "string" ? decoded.via : undefined,
      sv: typeof decoded.sv === "number" ? decoded.sv : 0, mfa: decoded.mfa === true,
    };
  } catch { return null; }
}
export function setAuthCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(JWT_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax", // none + secure per cross-site (Vercel ↔ Render)
    maxAge: SESSIONE_ORE * 60 * 60 * 1000,
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

interface UtenteCaricato { user: AuthUser; sv: number; mfaAttiva: boolean; deveCambiarePassword: boolean }

async function loadUserById(id: string): Promise<UtenteCaricato | null> {
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active,
           sessione_versione, mfa_attiva, deve_cambiare_password
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
      permissions: row.permissions ?? { analytics: true, fares: true, scheduling: true, network: true, fleetcare: false, centrale: false, personale: false, roster: false },
      fleetcareRole: row.fleetcare_role ?? "driver",
      active: row.active,
    },
    sv: Number(row.sessione_versione ?? 0),
    mfaAttiva: !!row.mfa_attiva,
    deveCambiarePassword: !!row.deve_cambiare_password,
  };
}

/** Lo stato dell'accesso di un utente caricato, con la sessione che sta usando. */
function accessoDi(u: UtenteCaricato, sessione: { mfa: boolean }): Accesso & { rifiuta: boolean } {
  const lim = limitazione({ ...u.user, deveCambiarePassword: u.deveCambiarePassword, mfaAttiva: u.mfaAttiva }, sessione);
  return {
    limitato: lim === "rifiuta" ? null : lim,
    rifiuta: lim === "rifiuta",
    mfaAttiva: u.mfaAttiva,
    mfaObbligatoria: mfaObbligatoria(u.user),
    passwordDaCambiare: u.deveCambiarePassword,
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
  const u = await loadUserById(verificato.sub);
  if (!u || !u.user.active) { res.status(401).json({ error: "Utente non attivo" }); return; }
  /* la versione sale al cambio password, al reset della verifica, a «esci ovunque»:
   * i token di prima non valgono più */
  if (verificato.sv !== u.sv) { res.status(401).json({ error: "Sessione scaduta: entra di nuovo" }); return; }
  const accesso = accessoDi(u, verificato);
  if (accesso.rifiuta) { res.status(401).json({ error: "Serve il codice di verifica: entra di nuovo" }); return; }
  req.user = u.user;
  req.authVia = verificato.via;
  req.sessione = { sv: u.sv, mfa: verificato.mfa };
  req.accesso = { limitato: accesso.limitato, mfaAttiva: accesso.mfaAttiva, mfaObbligatoria: accesso.mfaObbligatoria, passwordDaCambiare: accesso.passwordDaCambiare };
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
  ["/roster", "roster"], ["/optimizer", "scheduling"], ["/scheduling", "scheduling"],
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
  ["/planning-studio", "network"], ["/zones", "network"], ["/routes", "network"],
  ["/stops", "network"],
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

export const requirePermissionByPath: RequestHandler = (req, res, next) => {
  if (!req.user) { res.status(401).json({ error: "Non autenticato" }); return; }
  if (req.user.role === "admin") { next(); return; }
  /* Express confronta i percorsi senza badare alle maiuscole: /Roster/drivers
   * arriva allo stesso handler di /roster/drivers. Il confronto qui deve fare
   * lo stesso, altrimenti basta una maiuscola per saltare il controllo. */
  const path = req.path.toLowerCase();
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
/* un hash fittizio per chi non esiste: il login costa lo stesso tempo, e il
 * tempo di risposta non dice quali email ci sono */
let HASH_FITTIZIO: string | null = null;
const hashFittizio = () => (HASH_FITTIZIO ??= bcrypt.hashSync("nessuno-ha-questa-password", BCRYPT_ROUNDS));

/** Dopo un errore di password o di codice: un tentativo in più, e il blocco se si arriva al limite. */
async function contaErrore(userId: string): Promise<void> {
  const r = await db.execute<any>(sql`
    UPDATE users SET tentativi_falliti = tentativi_falliti + 1 WHERE id = ${userId}::uuid
    RETURNING tentativi_falliti`);
  const minuti = minutiDiBlocco(Number((r as any).rows?.[0]?.tentativi_falliti ?? 0));
  if (minuti > 0) {
    await db.execute(sql`UPDATE users SET bloccato_fino = now() + make_interval(mins => ${minuti}) WHERE id = ${userId}::uuid`);
  }
}

function rispostaBloccato(res: Response, fino: Date): void {
  const minuti = Math.max(1, Math.ceil((fino.getTime() - Date.now()) / 60_000));
  res.status(429).json({ error: `Troppi tentativi falliti: riprova fra ${minuti} minuti, o chiedi all'amministratore di sbloccare l'account.` });
}

/** Entra davvero: cookie della sessione, ultimo accesso, tentativi azzerati, registro. */
async function apriSessione(req: Request, res: Response, row: any, mfa: boolean): Promise<void> {
  await db.execute(sql`UPDATE users SET last_login_at = now(), tentativi_falliti = 0, bloccato_fino = NULL WHERE id = ${row.id}::uuid`);
  setAuthCookie(res, signToken(row.id, Number(row.sessione_versione ?? 0), mfa));
  await registraAccesso(req, { userId: row.id, email: row.email, esito: mfa ? "ok_con_verifica" : "ok" });
  const u = await loadUserById(row.id);
  res.json({
    user: u!.user,
    datiProva: datiProvaAttivi(),
    accesso: u ? (({ rifiuta: _r, ...a }) => a)(accessoDi(u, { mfa })) : null,
  });
}

router.post("/auth/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await ensureUsersTable();
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email e password obbligatori" });
    return;
  }
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active, password_hash,
           sessione_versione, bloccato_fino, mfa_attiva
      FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) {
    await bcrypt.compare(password, hashFittizio());
    await registraAccesso(req, { email: email.slice(0, 200), esito: "utente_sconosciuto" });
    res.status(401).json({ error: "Credenziali non valide" }); return;
  }
  if (row.bloccato_fino && new Date(row.bloccato_fino) > new Date()) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "bloccato" });
    rispostaBloccato(res, new Date(row.bloccato_fino)); return;
  }
  // async: non blocca l'event loop durante l'hashing bcrypt (una login lenta
  // non deve congelare tutte le altre richieste).
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!row.active) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "utente_inattivo" });
    res.status(401).json({ error: "Credenziali non valide" }); return;
  }
  if (!ok) {
    await contaErrore(row.id);
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "password_errata" });
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
  /* hash di prima, più leggero: si rifà col costo di adesso, ora che la password c'è */
  if (bcrypt.getRounds(row.password_hash) < BCRYPT_ROUNDS) {
    await db.execute(sql`UPDATE users SET password_hash = ${await bcrypt.hash(password, BCRYPT_ROUNDS)} WHERE id = ${row.id}::uuid`);
  }
  /* verifica in due passaggi attiva: niente sessione, un biglietto per il codice */
  if (row.mfa_attiva) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "codice_richiesto" });
    res.json({ mfaRichiesta: true, biglietto: firmaBiglietto(row.id, Number(row.sessione_versione ?? 0)) });
    return;
  }
  await apriSessione(req, res, row, false);
});

// POST /api/auth/login/mfa { biglietto, codice } oppure { biglietto, recupero }
router.post("/auth/login/mfa", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await ensureUsersTable();
  const b = leggiBiglietto(req.body?.biglietto);
  if (!b) { res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return; }
  const r = await db.execute(sql`
    SELECT id, email, active, sessione_versione, bloccato_fino, mfa_attiva, mfa_segreto, mfa_recupero, mfa_ultimo_passo
      FROM users WHERE id = ${b.sub}::uuid LIMIT 1`);
  const row: any = (r as any).rows?.[0];
  if (!row || !row.active || !row.mfa_attiva || Number(row.sessione_versione ?? 0) !== b.sv) {
    res.status(401).json({ error: "Tempo scaduto: inserisci di nuovo email e password" }); return;
  }
  if (row.bloccato_fino && new Date(row.bloccato_fino) > new Date()) {
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "bloccato" });
    rispostaBloccato(res, new Date(row.bloccato_fino)); return;
  }
  const { codice, recupero } = req.body ?? {};
  if (typeof recupero === "string" && recupero.trim()) {
    /* un codice di recupero vale una volta sola: si toglie dall'elenco nella stessa UPDATE */
    const impronta = improntaRecupero(recupero);
    const usato = await db.execute<any>(sql`
      UPDATE users SET mfa_recupero = mfa_recupero - ${impronta}
       WHERE id = ${row.id}::uuid AND mfa_recupero ? ${impronta}
      RETURNING jsonb_array_length(mfa_recupero) AS restano`);
    if (!(usato as any).rows?.length) {
      await contaErrore(row.id);
      await registraAccesso(req, { userId: row.id, email: row.email, esito: "recupero_errato" });
      res.status(401).json({ error: "Codice di recupero non valido" }); return;
    }
    await registraAccesso(req, { userId: row.id, email: row.email, esito: "recupero_usato" });
  } else {
    let v: ReturnType<typeof verificaCodice> = { ok: false };
    try { v = verificaCodice(decifra(row.mfa_segreto), codice, Date.now(), row.mfa_ultimo_passo == null ? null : Number(row.mfa_ultimo_passo)); }
    catch (e: any) { console.error("[auth] segreto della verifica non leggibile:", e?.message || e); }
    if (!v.ok) {
      await contaErrore(row.id);
      await registraAccesso(req, { userId: row.id, email: row.email, esito: "codice_errato" });
      res.status(401).json({ error: "Codice non valido" }); return;
    }
    /* il passo usato non vale più: lo stesso codice, intercettato, non rientra */
    const preso = await db.execute<any>(sql`
      UPDATE users SET mfa_ultimo_passo = ${v.passo}
       WHERE id = ${row.id}::uuid AND (mfa_ultimo_passo IS NULL OR mfa_ultimo_passo < ${v.passo})
      RETURNING id`);
    if (!(preso as any).rows?.length) { res.status(401).json({ error: "Codice già usato: aspetta il prossimo" }); return; }
  }
  await apriSessione(req, res, { ...row, sessione_versione: b.sv }, true);
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
 * FleetCare è un'app separata (stesso database, schema `fleetcare`) e NON ha
 * un login proprio: si entra SOLO da qui. Il flusso:
 *   1. l'utente (già autenticato su Cerbero) clicca "FleetCare" in sidebar
 *   2. il frontend chiama questo endpoint → token firmato monouso (60s)
 *      con il segreto condiviso FLEETCARE_SSO_SECRET
 *   3. il browser viene rediretto a <FLEETCARE_URL>/api/auth/sso?token=…
 *   4. FleetCare verifica il token e crea la SUA sessione (upsert profilo)
 *
 * Autorizzazione: admin sempre; gli altri solo con permissions.fleetcare.
 */
router.get("/auth/fleetcare-sso", requireAuth, (req, res): void => {
  const user = req.user!;
  const enabled = user.role === "admin" || !!user.permissions?.fleetcare;
  if (!enabled) {
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
  // Gli admin di Cerbero entrano sempre come fleet_admin; gli altri col ruolo
  // scelto dall'amministratore in Gestione Utenti.
  const fleetcareRole = user.role === "admin" ? "fleet_admin" : user.fleetcareRole || "driver";
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.fullName ?? undefined,
      fleetcareRole,
    },
    secret,
    { expiresIn: "60s", issuer: "cerbero", audience: "fleetcare" },
  );
  res.json({ url: `${fleetcareUrl}/api/auth/sso?token=${encodeURIComponent(token)}` });
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
           mfa_attiva, deve_cambiare_password, tentativi_falliti, bloccato_fino
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
    bloccatoFino: u.bloccato_fino && new Date(u.bloccato_fino) > new Date() ? u.bloccato_fino : null,
  }));
  res.json({ users });
});

// POST /api/admin/users { email, password, fullName, role, permissions, fleetcareRole }
router.post("/admin/users", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { email, password, fullName, role, permissions, fleetcareRole } = req.body || {};
  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(email.trim())) {
    res.status(400).json({ error: "Email non valida" }); return;
  }
  const erroreP = erroreNuovaPassword(password, { email, nome: typeof fullName === "string" ? fullName : null });
  if (erroreP) { res.status(400).json({ error: erroreP }); return; }
  const safeRole = role === "admin" ? "admin" : "user";
  const safePerm = {
    analytics: !!(permissions?.analytics ?? true),
    fares:     !!(permissions?.fares     ?? true),
    // network ⇒ scheduling (dato condiviso tra le due piattaforme): vale
    // anche per gli utenti salvati prima che l'implicazione fosse imposta.
    scheduling:!!(permissions?.scheduling?? true) || !!(permissions?.network ?? true),
    network:   !!(permissions?.network   ?? true),
    // FleetCare, Centrale Operativa, Personale, Roster: abilitazione esplicita → default false
    fleetcare: !!(permissions?.fleetcare ?? false),
    centrale:  !!(permissions?.centrale  ?? false),
    personale: !!(permissions?.personale ?? false),
    roster:    !!(permissions?.roster    ?? false),
  };
  const safeFleetcareRole = (FLEETCARE_ROLES as readonly string[]).includes(fleetcareRole)
    ? fleetcareRole
    : "driver";
  try {
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const r = await db.execute(sql`
      INSERT INTO users (email, password_hash, full_name, role, permissions, fleetcare_role, active, deve_cambiare_password)
      VALUES (${email}, ${hash}, ${fullName ?? null}, ${safeRole}, ${JSON.stringify(safePerm)}::jsonb, ${safeFleetcareRole}, true, true)
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
    // Planner Studio e Scheduling Engine lavorano sullo STESSO dato
    // (stessa rete, stessi depositi, stessi nodi, stessi archi): chi ha il
    // primo ha per forza il secondo, altrimenti l'accesso ai dati condivisi
    // diverge tra le due piattaforme. L'implicazione è imposta qui, non
    // lasciata alla disciplina di chi compila la form.
    const p = {
      analytics: !!permissions.analytics,
      fares: !!permissions.fares,
      scheduling: !!permissions.scheduling || !!permissions.network,
      network: !!permissions.network,
      fleetcare: !!permissions.fleetcare,
      centrale: !!permissions.centrale,
      personale: !!permissions.personale,
      roster: !!permissions.roster,
    };
    sets.push(sql`permissions = ${JSON.stringify(p)}::jsonb`);
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
    sets.push(sql`password_hash = ${bcrypt.hashSync(password, BCRYPT_ROUNDS)}`);
    sets.push(sql`deve_cambiare_password = true`, sql`password_cambiata_il = now()`);
    revoca = true;
  }
  /* telefono perso: si toglie la verifica (al prossimo accesso la riattiva) */
  if (resetMfa === true) {
    sets.push(sql`mfa_attiva = false`, sql`mfa_segreto = NULL`, sql`mfa_recupero = NULL`, sql`mfa_ultimo_passo = NULL`);
    revoca = true;
  }
  if (sblocca === true) sets.push(sql`tentativi_falliti = 0`, sql`bloccato_fino = NULL`);
  if (active === false) revoca = true;
  if (revoca) sets.push(sql`sessione_versione = sessione_versione + 1`);
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  // Concatena gli assignment con virgole
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE users SET ${assignments} WHERE id = ${id}::uuid
    RETURNING id, email, full_name, role, permissions, fleetcare_role, active
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Utente non trovato" }); return; }
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
