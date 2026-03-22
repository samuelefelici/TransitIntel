/**
 * In produzione (Vercel) → punta al backend su Render
 * In dev locale → stringa vuota (stessa origine, proxy Vite)
 */
export function getApiBase(): string {
  return import.meta.env.VITE_API_BASE_URL || "";
}
