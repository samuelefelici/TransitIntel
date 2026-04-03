import rateLimit from "express-rate-limit";

/**
 * Global API rate limiter — 100 requests per minute per IP.
 * Permissive enough for normal usage, prevents abuse / scraping.
 */
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,     // 1 minuto
  max: 100,                // max 100 req per finestra
  standardHeaders: "draft-7", // RateLimit-* headers (RFC draft-7)
  legacyHeaders: false,    // disabilita X-RateLimit-* vecchi
  message: { error: "Troppe richieste, riprova tra un minuto." },
  keyGenerator: (req) => {
    // In produzione dietro reverse-proxy, usa x-forwarded-for
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.ip
      || "unknown";
  },
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
  keyGenerator: (req) => {
    return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.ip
      || "unknown";
  },
});
