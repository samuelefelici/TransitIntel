import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api";

export type Permission = "analytics" | "fares" | "scheduling" | "network" | "fleetcare";

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string | null;
  role: "admin" | "user";
  permissions: Record<Permission, boolean>;
  /** Ruolo dentro il modulo FleetCare (usato dallo SSO; admin = fleet_admin). */
  fleetcareRole?: string;
  active: boolean;
}

interface AuthCtx {
  user: CurrentUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (p: Permission) => boolean;
}

const AuthContext = createContext<AuthCtx | null>(null);

/* ────────────────────────────────────────────────────────────
 * Soft-cache utente in localStorage
 *  ── Motivazione ──
 *  Senza cache, ad ogni F5 il client parte con `user=null` e mostra
 *  brevemente il login finché `/api/auth/me` non risponde (cold-start
 *  Render = 5-30s, oppure rete instabile). Se quella chiamata fallisce
 *  per qualunque motivo non-401, l'utente viene erroneamente "sloggato".
 *
 *  Strategia:
 *   - alla `login()` salvi user in localStorage
 *   - al boot lo ripristini subito → niente flash login
 *   - in background fai /me: se 401 vero ⇒ pulisci; se errore di rete ⇒
 *     mantieni la cache e aspetti la prossima visita.
 *  Nessun token viene salvato (resta cookie httpOnly): la cache contiene
 *  solo metadati identity/permessi che il backend riemetterà comunque.
 * ──────────────────────────────────────────────────────────── */
const AUTH_CACHE_KEY = "transitintel.auth.user.v1";
function loadCachedUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CurrentUser;
  } catch { return null; }
}
function saveCachedUser(u: CurrentUser | null): void {
  try {
    if (u) localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(u));
    else localStorage.removeItem(AUTH_CACHE_KEY);
  } catch { /* noop */ }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<CurrentUser | null>(() => loadCachedUser());
  // Se abbiamo cache, possiamo già mostrare l'app: niente loading screen iniziale.
  const [loading, setLoading] = useState<boolean>(() => loadCachedUser() === null);

  const setUser = useCallback((u: CurrentUser | null) => {
    setUserState(u);
    saveCachedUser(u);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<{ user: CurrentUser }>("/api/auth/me");
      setUser(r.user);
    } catch (e: any) {
      // Sloggiamo SOLO se il backend ha risposto con un 401 esplicito
      // ("Non autenticato" / "Sessione non valida"). In tutti gli altri
      // casi (errore di rete, 5xx, backend Render in cold-start, timeout
      // proxy, ecc.) manteniamo lo stato utente precedente (e la cache):
      // un singolo glitch di rete non deve buttare giù la sessione e
      // costringere l'utente a rifare login a ogni refresh della pagina.
      const status: number | undefined = e?.status;
      if (status === 401) {
        setUser(null);
      } else {
        console.warn("[auth] /api/auth/me failed (non-401), mantengo sessione:", e?.message || e);
      }
    } finally {
      setLoading(false);
    }
  }, [setUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const r = await apiFetch<{ user: CurrentUser }>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      setUser(r.user);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Credenziali non valide" };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (p: Permission) => {
      if (!user) return false;
      if (user.role === "admin") return true;
      return !!user.permissions?.[p];
    },
    [user],
  );

  const value: AuthCtx = {
    user,
    loading,
    isAuthenticated: !!user,
    isAdmin: user?.role === "admin",
    login,
    logout,
    refresh,
    hasPermission,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
