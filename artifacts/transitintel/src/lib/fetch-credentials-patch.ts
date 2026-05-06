/**
 * Patch globale di window.fetch per impostare `credentials: "include"`
 * di default su TUTTE le richieste verso l'API backend.
 *
 * Motivazione: il cookie httpOnly `ti_auth` è cross-site (Vercel ↔ Render)
 * con `SameSite=None; Secure`. Il default di `fetch()` è `credentials: "same-origin"`
 * che NON invia il cookie cross-site → 401 a cascata.
 *
 * Esistono nel codice >100 chiamate `fetch()` dirette senza `credentials: "include"`.
 * Anziché modificarle una per una, patchiamo il globale: se la chiamata ha già
 * un `credentials` esplicito viene rispettato, altrimenti diventa "include".
 *
 * Bonus: su 401 dispatcha l'evento globale `auth:unauthorized` (allineato
 * con apiFetch).
 */
import { getApiBase } from "./api";

if (typeof window !== "undefined" && !(window as any).__tiFetchPatched) {
  const originalFetch = window.fetch.bind(window);
  const apiBase = getApiBase();

  function isApiUrl(input: RequestInfo | URL): boolean {
    try {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      // Stessa origine + path /api → sì
      if (urlStr.startsWith("/api/")) return true;
      // URL assoluto verso il backend configurato
      if (apiBase && urlStr.startsWith(apiBase)) return true;
      // URL assoluto stessa origine
      if (urlStr.startsWith(window.location.origin) && urlStr.includes("/api/")) return true;
      return false;
    } catch {
      return false;
    }
  }

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let nextInit = init;
    if (isApiUrl(input)) {
      // Se non specificato esplicitamente, forza include
      if (!init || init.credentials === undefined) {
        nextInit = { ...(init || {}), credentials: "include" };
      }
    }
    const res = await originalFetch(input as any, nextInit);
    if (res.status === 401 && isApiUrl(input)) {
      try {
        window.dispatchEvent(new CustomEvent("auth:unauthorized"));
      } catch {
        /* noop */
      }
    }
    return res;
  };

  (window as any).__tiFetchPatched = true;
}

export {};
