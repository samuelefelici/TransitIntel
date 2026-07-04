/**
 * Auth — modulo unico per gestione utenti, login, JWT, middleware.
 *
 * Bootstrap idempotente: alla prima richiesta crea la tabella `users` e
 * fa il seed dell'admin + 3 utenti cerbero.it se la tabella è vuota.
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

/* ────────────────────────────────────────────────────────────
 * Tipi
 * ──────────────────────────────────────────────────────────── */
export type Permission = "analytics" | "fares" | "scheduling" | "network" | "fleetcare";
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
    }
  }
}

/* ────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────── */
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-cerbero123-in-production-please";
const JWT_COOKIE = "ti_auth";
const JWT_TTL_DAYS = 30;
const BCRYPT_ROUNDS = 10;

/* ────────────────────────────────────────────────────────────
 * Bootstrap tabella + seed
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
        permissions jsonb NOT NULL DEFAULT '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false}'::jsonb,
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

    const cnt = await db.execute(sql`SELECT count(*)::int AS n FROM users`);
    const n = ((cnt as any).rows?.[0] ?? (cnt as any)[0])?.n ?? 0;
    if (n === 0) {
      // Seed iniziale
      const seedUsers: { email: string; pwd: string; full: string; role: "admin" | "user" }[] = [
        { email: "samuele@transitintel.local", pwd: "Capo2026!", full: "Samuele (admin)", role: "admin" },
        { email: "f.beccacece@cerbero.it", pwd: "Fabrizio", full: "Fabrizio Beccacece", role: "user" },
        { email: "g.giuliodori@cerbero.it", pwd: "Giorgio", full: "Giorgio Giuliodori", role: "user" },
        { email: "a.bergantino@cerbero.it", pwd: "Aldo", full: "Aldo Bergantino", role: "user" },
      ];
      for (const u of seedUsers) {
        const hash = bcrypt.hashSync(u.pwd, BCRYPT_ROUNDS);
        await db.execute(sql`
          INSERT INTO users (email, password_hash, full_name, role, permissions, active)
          VALUES (
            ${u.email}, ${hash}, ${u.full}, ${u.role},
            '{"analytics":true,"fares":true,"scheduling":true,"network":true,"fleetcare":false}'::jsonb,
            true
          )
        `);
      }
      console.log("[auth] seeded 4 users (1 admin + 3 cerbero.it)");
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
function verifyToken(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string };
    return decoded.sub;
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
    permissions: row.permissions ?? { analytics: true, fares: true, scheduling: true, network: true, fleetcare: false },
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
  const userId = verifyToken(token);
  if (!userId) { res.status(401).json({ error: "Sessione non valida" }); return; }
  const user = await loadUserById(userId);
  if (!user || !user.active) { res.status(401).json({ error: "Utente non attivo" }); return; }
  req.user = user;
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
    if (req.user.role === "admin") { next(); return; }
    if (req.user.permissions?.[p]) { next(); return; }
    res.status(403).json({ error: `Manca il permesso: ${p}` });
  };
}

/* ────────────────────────────────────────────────────────────
 * Router /api/auth/* + /api/admin/users/*
 * ──────────────────────────────────────────────────────────── */
const router: IRouter = Router();

// POST /api/auth/login { email, password }
router.post("/auth/login", async (req: Request, res: Response): Promise<void> => {
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
  const ok = bcrypt.compareSync(password, row.password_hash);
  if (!ok) { res.status(401).json({ error: "Credenziali non valide" }); return; }
  await db.execute(sql`UPDATE users SET last_login_at = now() WHERE id = ${row.id}::uuid`);
  setAuthCookie(res, signToken(row.id));
  res.json({
    user: {
      id: row.id, email: row.email, fullName: row.full_name,
      role: row.role, permissions: row.permissions,
      fleetcareRole: row.fleetcare_role ?? "driver", active: row.active,
    },
  });
});

// POST /api/auth/logout
router.post("/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
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
  const r = q
    ? await db.execute(sql`
        SELECT id, email, full_name FROM users
         WHERE active = true AND id <> ${meId}::uuid
           AND (lower(email) LIKE ${'%' + q + '%'} OR lower(coalesce(full_name,'')) LIKE ${'%' + q + '%'})
         ORDER BY email ASC LIMIT 50
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
  if (typeof email !== "string" || typeof password !== "string" || password.length < 4) {
    res.status(400).json({ error: "Email e password (≥4 char) obbligatori" }); return;
  }
  const safeRole = role === "admin" ? "admin" : "user";
  const safePerm = {
    analytics: !!(permissions?.analytics ?? true),
    fares:     !!(permissions?.fares     ?? true),
    scheduling:!!(permissions?.scheduling?? true),
    network:   !!(permissions?.network   ?? true),
    // FleetCare: abilitazione esplicita → default false
    fleetcare: !!(permissions?.fleetcare ?? false),
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
    res.status(500).json({ error: e?.message || "Errore creazione utente" });
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
    const p = {
      analytics: !!permissions.analytics,
      fares: !!permissions.fares,
      scheduling: !!permissions.scheduling,
      network: !!permissions.network,
      fleetcare: !!permissions.fleetcare,
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
  if (typeof password === "string" && password.length >= 4) {
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
