/**
 * In produzione (Vercel) → punta al backend su Render
 * In dev locale → stringa vuota (stessa origine, proxy Vite)
 */
export function getApiBase(): string {
  return import.meta.env.VITE_API_BASE_URL || "";
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
