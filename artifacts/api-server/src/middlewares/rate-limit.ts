import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";

/**
 * Identità per il rate limiting.
 *
 * In produzione l'API sta dietro CDN/reverse-proxy: keyare solo per IP fa
 * finire utenti diversi (o lo stesso utente su hop diversi) nello stesso
 * bucket, e il 429 colpiva anche /auth/me bloccando l'intera SPA.
 * Se la richiesta porta un JWT valido nel cookie usiamo l'id utente come
 * chiave (bucket personale, limite più alto); altrimenti si ricade sull'IP.
 *
 * NB: il secret è duplicato da lib/auth.ts perché auth.ts importa questo
 * modulo (loginLimiter) — importare auth qui creerebbe un ciclo. Il fallback
 * dev-only non è un rischio: in produzione auth.ts fa fail-closed al boot
 * se JWT_SECRET manca.
 */
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-cerbero123-in-production-please";
const JWT_COOKIE = "ti_auth";

function authBucket(req: any): string | null {
  if (req.__rlBucket !== undefined) return req.__rlBucket;
  let bucket: string | null = null;
  const token = req.cookies?.[JWT_COOKIE];
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as { sub?: string };
      if (decoded?.sub) bucket = `user:${decoded.sub}`;
    } catch { /* token assente/scaduto/invalido → bucket per IP */ }
  }
  req.__rlBucket = bucket;
  return bucket;
}

/**
 * Global API rate limiter.
 * - Utenti autenticati: 3000 req/min per UTENTE. La SPA fa legittimamente
 *   raffiche di chiamate (mappa, pannelli, TanStack Query, TTD) e 600/min
 *   faceva scattare 429 nell'uso normale del Planner Studio.
 * - Anonimi: 600 req/min per IP — resta protettivo contro abusi/scraping
 *   (login ha comunque il suo limiter dedicato molto più stretto).
 * I preflight CORS (OPTIONS) non consumano quota.
 */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minuto
  limit: (req) => (authBucket(req) ? 3000 : 600),
  keyGenerator: (req) => authBucket(req) ?? ipKeyGenerator(req.ip ?? ""),
  skip: (req) => req.method === "OPTIONS",
  standardHeaders: "draft-7", // RateLimit-* headers (RFC draft-7)
  legacyHeaders: false,    // disabilita X-RateLimit-* vecchi
  message: { error: "Troppe richieste, riprova tra un minuto." },
});

/**
 * Strict limiter per endpoint pesanti (upload GTFS, optimizer, solver).
 * 10 req per minuto per IP.
 */
export const strictLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Limite raggiunto per operazioni pesanti, riprova tra un minuto." },
  // Use default keyGenerator (req.ip) — no custom one needed for dev
});

/**
 * Login limiter — protegge /auth/login da brute-force e dal flood di hashing
 * bcrypt (ogni tentativo è CPU-intensive). 20 tentativi/min per IP.
 */
export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Troppi tentativi di accesso, riprova tra un minuto." },
});
