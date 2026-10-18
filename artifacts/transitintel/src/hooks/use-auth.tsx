import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Speculare a `Permission` in api-server/src/lib/auth.ts: un modulo per chiave.
 *  centrale = Centrale Operativa (Mappa live + AVM), attivabile per utente.
 *  personale = anagrafica del personale completa (dati personali, paghe, ferie, visite). */
export type Permission = "analytics" | "fares" | "scheduling" | "network" | "fleetcare" | "centrale" | "personale" | "roster";

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

/** Stato dell'accesso (api-server/src/lib/auth.ts, Accesso): sessione limitata e verifica. */
export interface Accesso {
  /** "password": password provvisoria da cambiare; "mfa": verifica in due passaggi da attivare */
  limitato: null | "password" | "mfa";
  mfaAttiva: boolean;
  mfaObbligatoria: boolean;
  passwordDaCambiare: boolean;
}

export type EsitoLogin =
  | { ok: true }
  | { ok: false; error: string }
  /* password giusta, serve il codice dell'app: il biglietto vale 5 minuti */
  | { ok: false; mfaBiglietto: string };

interface AuthCtx {
  user: CurrentUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<EsitoLogin>;
  /** il secondo passo: il codice dell'app o un codice di recupero */
  loginMfa: (biglietto: string, prova: { codice: string } | { recupero: string }) => Promise<{ ok: boolean; error?: string }>;
  /** null finché il server non ha risposto */
  accesso: Accesso | null;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (p: Permission) => boolean;
  /** installazione di prova: si possono creare conducenti fittizi (CERBERO_DATI_PROVA=1) */
  datiProva: boolean;
  /** il server ha risposto almeno una volta a /me: i permessi in cache possono essere vecchi */
  verificato: boolean;
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
  /* non in cache: finché /me non risponde, niente dati di prova */
  const [datiProva, setDatiProva] = useState(false);
  const [verificato, setVerificato] = useState(false);
  const [accesso, setAccesso] = useState<Accesso | null>(null);
  // Se abbiamo cache, possiamo già mostrare l'app: niente loading screen iniziale.
  const [loading, setLoading] = useState<boolean>(() => loadCachedUser() === null);

  const setUser = useCallback((u: CurrentUser | null) => {
    setUserState(u);
    saveCachedUser(u);
  }, []);

  /* Cambia la persona (uscita, o un altro accesso dallo stesso PC): via tutta
   * la cache delle query. Dentro ci sono dati che il nuovo utente non deve
   * vedere (l'anagrafica del personale coi dati personali), e con 5 minuti
   * di staleTime li vedrebbe senza che la pagina li richieda al server. */
  const queryClient = useQueryClient();
  const utenteId = user?.id ?? null;
  const utentePrima = useRef(utenteId);
  useEffect(() => {
    if (utentePrima.current === utenteId) return;
    utentePrima.current = utenteId;
    queryClient.clear();
  }, [utenteId, queryClient]);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<{ user: CurrentUser; datiProva?: boolean; accesso?: Accesso | null }>("/api/auth/me");
      setUser(r.user);
      setDatiProva(!!r.datiProva);
      setAccesso(r.accesso ?? null);
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
      setVerificato(true);
    }
  }, [setUser]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  type RispostaLogin = { user?: CurrentUser; datiProva?: boolean; accesso?: Accesso | null; mfaRichiesta?: boolean; biglietto?: string };
  const entra = useCallback((r: RispostaLogin) => {
    setUser(r.user!);
    setDatiProva(!!r.datiProva);
    setAccesso(r.accesso ?? null);
  }, [setUser]);

  const login = useCallback(async (email: string, password: string): Promise<EsitoLogin> => {
    try {
      const r = await apiFetch<RispostaLogin>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (r.mfaRichiesta && r.biglietto) return { ok: false, mfaBiglietto: r.biglietto };
      entra(r);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Credenziali non valide" };
    }
  }, [entra]);

  const loginMfa = useCallback(async (biglietto: string, prova: { codice: string } | { recupero: string }) => {
    try {
      const r = await apiFetch<RispostaLogin>("/api/auth/login/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ biglietto, ...prova }),
      });
      entra(r);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Codice non valido" };
    }
  }, [entra]);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setUser(null);
    setAccesso(null);
  }, [setUser]);

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
    loginMfa,
    accesso,
    logout,
    refresh,
    hasPermission,
    datiProva,
    verificato,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
