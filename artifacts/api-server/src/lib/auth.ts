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
import { decidiPrimoAdmin, erroreNuovaPassword } from "./password-regole";
import { datiProvaAttivi } from "./dati-prova";

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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** il token è stato emesso per un servizio che agisce per conto dell'utente (es. "argos") */
      authVia?: string;
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
const JWT_TTL_DAYS = 30;
const BCRYPT_ROUNDS = 10;

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

    const cnt = await db.execute(sql`SELECT count(*)::int AS n FROM users`);
    const n = ((cnt as any).rows?.[0] ?? (cnt as any)[0])?.n ?? 0;
    const primo = decidiPrimoAdmin(n, process.env);
    if (primo.tipo === "crea") {
      /* ON CONFLICT: il bootstrap può partire due volte insieme (import e prima richiesta) */
      await db.execute(sql`
        INSERT INTO users (email, password_hash, full_name, role, permissions, active)
        VALUES (
          ${primo.email}, ${bcrypt.hashSync(primo.password, BCRYPT_ROUNDS)}, 'Amministratore', 'admin',
          '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false,"centrale":true,"personale":false,"roster":true}'::jsonb,
          true
        )
        ON CONFLICT (email) DO NOTHING
      `);
      console.log(`[auth] creato l'amministratore iniziale ${primo.email}: cambia la password al primo accesso e togli CERBERO_ADMIN_PASSWORD`);
    } else if (primo.tipo === "avviso") {
      console.warn(`[auth] ${primo.messaggio}`);
    }
    bootstrapped = true;
  } catch (e: any) {
    console.error("[auth] bootstrap users error:", e?.message || e);
  }
}
void ensureUsersTable();

/* ────────────────────────────────────────────────────────────
 * Helpers JWT/cookie
 * ──────────────────────────────────────────────────────────── */
function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: `${JWT_TTL_DAYS}d` });
}

/** Token a BREVE scadenza per chiamate server-to-server on-behalf-of-user.
 * Usato dal proxy Argos: Argos lo rigira agli endpoint /api/ai/argos/* e
 * /api/intermodal/* come Bearer, così il controllo accessi per-utente resta
 * valido ma il token vive solo per la durata di una risposta. */
export function mintShortLivedUserToken(userId: string): string {
  /* "via": chi usa questo token è un servizio esterno (Argos, e dietro un
   * modello linguistico), non la persona: non vede i dati personali. */
  return jwt.sign({ sub: userId, via: "argos" }, JWT_SECRET, { expiresIn: "10m" });
}
function verifyToken(token: string): { sub: string; via?: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; via?: unknown };
    return { sub: decoded.sub, via: typeof decoded.via === "string" ? decoded.via : undefined };
  } catch { return null; }
}
function setAuthCookie(res: Response, token: string) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(JWT_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax", // none + secure per cross-site (Vercel ↔ Render)
    maxAge: JWT_TTL_DAYS * 24 * 60 * 60 * 1000,
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

async function loadUserById(id: string): Promise<AuthUser | null> {
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active
      FROM users WHERE id = ${id}::uuid LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    permissions: row.permissions ?? { analytics: true, fares: true, scheduling: true, network: true, fleetcare: false, centrale: false, personale: false },
    fleetcareRole: row.fleetcare_role ?? "driver",
    active: row.active,
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
  const user = await loadUserById(verificato.sub);
  if (!user || !user.active) { res.status(401).json({ error: "Utente non attivo" }); return; }
  req.user = user;
  req.authVia = verificato.via;
  next();
};

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
router.post("/auth/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  await ensureUsersTable();
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email e password obbligatori" });
    return;
  }
  const r = await db.execute(sql`
    SELECT id, email, full_name, role, permissions, fleetcare_role, active, password_hash
      FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row || !row.active) { res.status(401).json({ error: "Credenziali non valide" }); return; }
  // async: non blocca l'event loop durante l'hashing bcrypt (una login lenta
  // non deve congelare tutte le altre richieste).
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) { res.status(401).json({ error: "Credenziali non valide" }); return; }
  await db.execute(sql`UPDATE users SET last_login_at = now() WHERE id = ${row.id}::uuid`);
  setAuthCookie(res, signToken(row.id));
  res.json({
    user: {
      id: row.id, email: row.email, fullName: row.full_name,
      role: row.role, permissions: row.permissions,
      fleetcareRole: row.fleetcare_role ?? "driver", active: row.active,
    },
    datiProva: datiProvaAttivi(),
  });
});

// POST /api/auth/logout
router.post("/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/auth/me", requireAuth, (req, res) => {
  /* datiProva: se questa installazione permette i conducenti fittizi (lib/dati-prova.ts) */
  res.json({ user: req.user, datiProva: datiProvaAttivi() });
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
    SELECT id, email, full_name, role, permissions, fleetcare_role, active, last_login_at, created_at
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
      INSERT INTO users (email, password_hash, full_name, role, permissions, fleetcare_role, active)
      VALUES (${email}, ${hash}, ${fullName ?? null}, ${safeRole}, ${JSON.stringify(safePerm)}::jsonb, ${safeFleetcareRole}, true)
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
  const { fullName, role, permissions, fleetcareRole, active, password } = req.body || {};
  const sets: any[] = [];
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
    sets.push(sql`password_hash = ${bcrypt.hashSync(password, BCRYPT_ROUNDS)}`);
  }
  if (sets.length === 0) { res.json({ ok: true, noop: true }); return; }
  // Concatena gli assignment con virgole
  const assignments = sql.join(sets, sql`, `);
  const r = await db.execute(sql`
    UPDATE users SET ${assignments} WHERE id = ${id}::uuid
    RETURNING id, email, full_name, role, permissions, fleetcare_role, active
  `);
  const row: any = (r as any).rows?.[0] ?? (r as any)[0];
  if (!row) { res.status(404).json({ error: "Utente non trovato" }); return; }
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
