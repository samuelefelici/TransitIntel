import rateLimit from "express-rate-limit";

/**
 * Global API rate limiter — 600 requests per minute per IP.
 * La SPA fa legittimamente decine di chiamate parallele (mappa, pannelli,
 * TanStack Query): 100/min faceva scattare 429 nell'uso normale del
 * Planner Studio. 600/min resta protettivo contro abusi/scraping.
 * Permissive enough for normal usage, prevents abuse / scraping.
 */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minuto
  max: 600,                // max 600 req per finestra
  standardHeaders: "draft-7", // RateLimit-* headers (RFC draft-7)
  legacyHeaders: false,    // disabilita X-RateLimit-* vecchi
  message: { error: "Troppe richieste, riprova tra un minuto." },
  // Use default keyGenerator (req.ip) — no custom one needed for dev
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
