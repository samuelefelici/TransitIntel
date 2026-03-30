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
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = (body as any)?.error || `HTTP ${res.status}`;
    console.error(`[API] ${init?.method ?? "GET"} ${path} → ${res.status}:`, msg);
    throw new Error(msg);
  }
  return res.json();
}
