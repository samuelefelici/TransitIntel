// Healthcheck del container (HEALTHCHECK di Dockerfile.api). Usa node perché
// l'immagine slim non ha né curl né wget.
const porta = process.env.PORT || "3000";
try {
  const r = await fetch(`http://127.0.0.1:${porta}/api/healthz`, { signal: AbortSignal.timeout(4000) });
  process.exit(r.ok ? 0 : 1);
} catch {
  process.exit(1);
}
