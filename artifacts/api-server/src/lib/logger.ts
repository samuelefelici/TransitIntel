import pino from "pino";
import crypto from "node:crypto";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

/**
 * Generate or propagate a correlation ID.
 * Uses the incoming `x-request-id` header if present, otherwise generates a UUID v4.
 */
export function getRequestId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const existing = req.headers["x-request-id"];
  // Propaga l'id solo se rispetta un formato safe (evita log-injection / bloat
  // da header client arbitrario, che viene loggato e riflesso in risposta).
  if (typeof existing === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(existing)) return existing;
  return crypto.randomUUID();
}
