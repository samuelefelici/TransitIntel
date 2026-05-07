/**
 * In produzione (Vercel) → punta al backend su Render
 * In dev locale → stringa vuota (stessa origine, proxy Vite)
 */
export function getApiBase(): string {
  return import.meta.env.VITE_API_BASE_URL || "";
}

/* ════════════════════════════════════════════════════════════
 *  GLOBAL FETCH PATCH — auto-include credentials per /api/*
 *
 *  Storia: molte pagine (fucina, vehicle-workspace, OptimizerStep,
 *  IntermodalAdvisor, ecc.) usano `fetch(...)` raw verso `${getApiBase()}/api/...`
 *  senza passare `credentials: "include"`. In dev locale funziona (stessa origin
 *  via proxy Vite), ma in prod cross-origin (Vercel → Render) il cookie
 *  di sessione NON viene inviato → requireAuth risponde 401 → l'utente
 *  vede "Errore: non riesce a recuperare i dati".
 *
 *  Patch: intercettiamo `window.fetch` UNA SOLA VOLTA al primo import di
 *  questo modulo; per ogni richiesta diretta a /api (relativa o verso
 *  l'API base) aggiungiamo `credentials: "include"` se non già esplicito.
 *  Trasparente per chi usa già apiFetch (che lo include comunque) e per
 *  fetch a domini terzi.
 * ════════════════════════════════════════════════════════════ */
declare global {
  interface Window { __ttFetchPatched?: boolean }
}
if (typeof window !== "undefined" && !window.__ttFetchPatched) {
  const originalFetch = window.fetch.bind(window);
  const apiBase = getApiBase();
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let url = "";
    try {
      url = typeof input === "string" ? input
          : input instanceof URL ? input.toString()
          : (input as Request).url;
    } catch { /* noop */ }
    // Considera "API call" se: relativa /api, oppure assoluta verso l'API base
    const isApiCall = url.startsWith("/api/")
      || url.startsWith("/api?")
      || (apiBase && url.startsWith(`${apiBase}/api/`));
    if (isApiCall) {
      const merged: RequestInit = { credentials: "include", ...(init || {}) };
      // Se l'utente ha esplicitato un altro valore di credentials (es. "omit"),
      // lo rispettiamo. Altrimenti garantiamo "include".
      if (!init || init.credentials === undefined) merged.credentials = "include";
      return originalFetch(input as any, merged);
    }
    return originalFetch(input as any, init);
  };
  window.__ttFetchPatched = true;
}

/**
 * Wrapper fetch che:
 * 1. Controlla r.ok (lancia se HTTP error)
 * 2. Logga errori in console con contesto
 * 3. Parsifica JSON automaticamente
 *
 * Uso: const data = await apiFetch<MyType>("/api/scenarios");
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${getApiBase()}${path}`;
  // Sempre cookie httpOnly auth (cross-site Vercel <-> Render con SameSite=None)
  // Auto-set Content-Type: application/json se c'è un body string e nessun header esplicito
  const hasBody = init?.body !== undefined && init?.body !== null;
  const userHeaders = init?.headers ? new Headers(init.headers) : new Headers();
  if (hasBody && typeof init!.body === "string" && !userHeaders.has("Content-Type")) {
    userHeaders.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    credentials: "include",
    ...(init || {}),
    headers: userHeaders,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as any)?.error || `HTTP ${res.status}`;
    console.error(`[API] ${init?.method ?? "GET"} ${path} → ${res.status}:`, msg);
    // Eventi globali: 401 -> redirect login; 403 -> notify
    if (res.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("auth:unauthorized"));
    }
    const err = new Error(msg) as Error & { status?: number; body?: any };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}
