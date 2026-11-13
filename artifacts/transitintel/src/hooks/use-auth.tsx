import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { puo as haLivello, type Interruttore, type InterruttoreDiPrima, type RuoloAziendale } from "@workspace/permessi";
import { dirittiDellUtente, type Area, type Diritti, type Livello } from "@/lib/diritti";
import { AZIENDA_DA_COMPILARE, aziendaValida, type Azienda } from "@/lib/azienda";

/** Gli interruttori di prima dei ruoli: restano nella vista `permissions` che l'API
 *  manda (un interruttore = almeno la lettura sulla sua area). I diritti veri sono in `diritti`. */
export type Permission = Interruttore;
export type { Area, Livello };

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string | null;
  /** "admin" è l'amministratore di sistema, non un ruolo di lavoro */
  role: "admin" | "user";
  /** i ruoli aziendali (assenti nell'utente in cache di prima dei ruoli) */
  ruoli?: RuoloAziendale[];
  /** gli interruttori di prima dei ruoli ancora accesi */
  accessoDiPrima?: Partial<Record<InterruttoreDiPrima, true>>;
  datiSanitari?: boolean;
  analisi?: boolean;
  /** i depositi di cui modifica i conducenti (PR 2.14c); la regola dei due elenchi è in @workspace/permessi */
  depositi?: string[];
  /** i depositi di cui vede i conducenti; vuoto o assente = tutti (PR 2.14d) */
  depositiVisibili?: string[];
  /** lettura o scrittura per area: è su questo che si decide che cosa mostrare */
  diritti?: Diritti;
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
  /** entrato con un codice di recupero (telefono perso): può rifare la verifica */
  recupero: boolean;
  /** i codici di recupero sono di prima di un cambio di chiave: vanno rifatti */
  codiciDaRifare?: boolean;
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
  /** può almeno LEGGERE il modulo di questo interruttore (la vista di prima dei ruoli) */
  hasPermission: (p: Permission) => boolean;
  /** i diritti per area, lettura o scrittura */
  diritti: Diritti;
  /** ha almeno questo livello sull'area? («S» per i comandi che modificano) */
  puo: (area: Area, livello: Livello) => boolean;
  /** installazione di prova: si possono creare conducenti fittizi (CERBERO_DATI_PROVA=1) */
  datiProva: boolean;
  /** l'azienda di questa installazione: nome, città, centro delle mappe (lib/azienda.ts) */
  azienda: Azienda;
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
/* anche lo stato dell'accesso: chi ha una sessione limitata, ricaricando la
 * pagina, va subito alla pagina per mettersi in regola invece di aprire l'app
 * e prendere una raffica di 403 finché /me non risponde */
const ACCESSO_CACHE_KEY = "transitintel.auth.accesso.v1";
function loadCached<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch { return null; }
}
function saveCached(key: string, v: unknown): void {
  try {
    if (v) localStorage.setItem(key, JSON.stringify(v));
    else localStorage.removeItem(key);
  } catch { /* noop */ }
}
const loadCachedUser = () => loadCached<CurrentUser>(AUTH_CACHE_KEY);
/* anche l'azienda: nome e centro delle mappe servono al primo disegno, e
 * cambiano di rado. Non è un dato della persona: resta anche dopo l'uscita. */
const AZIENDA_CACHE_KEY = "transitintel.azienda.v1";
const loadCachedAzienda = (): Azienda | null => {
  const a = loadCached<unknown>(AZIENDA_CACHE_KEY);
  return a ? aziendaValida(a) : null;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<CurrentUser | null>(() => loadCachedUser());
  /* non in cache: finché /me non risponde, niente dati di prova */
  const [datiProva, setDatiProva] = useState(false);
  const [verificato, setVerificato] = useState(false);
  const [accesso, setAccessoState] = useState<Accesso | null>(() => (loadCachedUser() ? loadCached<Accesso>(ACCESSO_CACHE_KEY) : null));
  const [azienda, setAziendaState] = useState<Azienda>(() => loadCachedAzienda() ?? AZIENDA_DA_COMPILARE);
  // Se abbiamo cache, possiamo già mostrare l'app: niente loading screen iniziale.
  // Serve anche l'azienda: senza, la prima mappa si aprirebbe sul centro neutro.
  const [loading, setLoading] = useState<boolean>(() => loadCachedUser() === null || loadCachedAzienda() === null);

  const setUser = useCallback((u: CurrentUser | null) => {
    setUserState(u);
    saveCached(AUTH_CACHE_KEY, u);
    if (!u) { setAccessoState(null); saveCached(ACCESSO_CACHE_KEY, null); }
  }, []);
  const setAccesso = useCallback((a: Accesso | null) => {
    setAccessoState(a);
    saveCached(ACCESSO_CACHE_KEY, a);
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

  /* l'azienda arriva con /me e con la risposta del login. Un server non ancora
   * aggiornato non la manda: resta quella che c'era */
  const accogliAzienda = useCallback((x: unknown) => {
    if (x === undefined) return;
    const a = aziendaValida(x);
    setAziendaState(a);
    saveCached(AZIENDA_CACHE_KEY, a);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFetch<{ user: CurrentUser; datiProva?: boolean; accesso?: Accesso | null; azienda?: unknown }>("/api/auth/me");
      setUser(r.user);
      setDatiProva(!!r.datiProva);
      setAccesso(r.accesso ?? null);
      accogliAzienda(r.azienda);
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
  }, [setUser, setAccesso, accogliAzienda]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Un 401 a sessione aperta (12 ore finite, «esci ovunque» da un altro PC,
   * password cambiata) o un 403 di sessione limitata: si richiede /me, che
   * decide. Al più una richiesta ogni 5 secondi, e mai da sloggati: i 401 del
   * login stesso non devono rimbalzare qui. */
  const userRef = useRef(user);
  userRef.current = user;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ultimo = 0;
    const ricontrolla = () => {
      if (!userRef.current || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!userRef.current || Date.now() - ultimo < 5000) return;
        ultimo = Date.now();
        void refresh();
      }, 500);
    };
    window.addEventListener("auth:unauthorized", ricontrolla);
    window.addEventListener("auth:limited", ricontrolla);
    return () => {
      window.removeEventListener("auth:unauthorized", ricontrolla);
      window.removeEventListener("auth:limited", ricontrolla);
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  type RispostaLogin = { user?: CurrentUser; datiProva?: boolean; accesso?: Accesso | null; azienda?: unknown; mfaRichiesta?: boolean; biglietto?: string };
  const entra = useCallback((r: RispostaLogin) => {
    /* prima l'azienda: la prima pagina che si disegna dopo l'accesso ha già nome e centro delle mappe */
    accogliAzienda(r.azienda);
    setUser(r.user!);
    setDatiProva(!!r.datiProva);
    setAccesso(r.accesso ?? null);
  }, [setUser, setAccesso, accogliAzienda]);

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
  }, [setUser]);

  const hasPermission = useCallback(
    (p: Permission) => {
      if (!user) return false;
      if (user.role === "admin") return true;
      return !!user.permissions?.[p];
    },
    [user],
  );

  /* chi può davvero fare una cosa lo decide l'API: qui si decide solo che cosa mostrare */
  const diritti = useMemo(() => dirittiDellUtente(user), [user]);
  const puo = useCallback((area: Area, livello: Livello) => haLivello(diritti, area, livello), [diritti]);

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
    diritti,
    puo,
    datiProva,
    azienda,
    verificato,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
