import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Simple in-memory cache middleware with configurable TTL.
 *
 * Caches successful JSON responses (status 200–299) by full URL (path + query).
 * Subsequent identical requests within the TTL window are served from memory
 * without touching the database or external APIs.
 *
 * Usage:
 *   router.get("/expensive", cache({ ttlSeconds: 120 }), handler);
 *
 * The cache can be cleared at any time:
 *   import { clearCache } from "./cache";
 *   clearCache();                // flush everything
 *   clearCache("/api/gtfs/");    // flush keys containing this prefix
 */

interface CacheEntry {
  body: string;
  contentType: string;
  status: number;
  storedAt: number;
}

const store = new Map<string, CacheEntry>();

// Periodic GC to avoid memory leaks (every 5 min)
const GC_INTERVAL = 5 * 60 * 1000;
let gcTimer: ReturnType<typeof setInterval> | null = null;

function ensureGc() {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.storedAt > 10 * 60 * 1000) store.delete(key);
    }
    if (store.size === 0 && gcTimer) {
      clearInterval(gcTimer);
      gcTimer = null;
    }
  }, GC_INTERVAL);
  if (gcTimer && typeof gcTimer === "object" && "unref" in gcTimer) {
    gcTimer.unref(); // don't keep process alive just for GC
  }
}

/**
 * Create a caching middleware for a specific TTL.
 *
 * @param opts.ttlSeconds  How long to cache responses (default: 60)
 * @param opts.keyFn       Optional custom key generator (default: req.originalUrl)
 */
export function cache(opts: {
  ttlSeconds?: number;
  keyFn?: (req: Request) => string;
} = {}): RequestHandler {
  const ttl = (opts.ttlSeconds ?? 60) * 1000;

  return (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== "GET") return next();

    const key = opts.keyFn ? opts.keyFn(req) : req.originalUrl;
    const cached = store.get(key);

    if (cached && Date.now() - cached.storedAt < ttl) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Type", cached.contentType);
      res.status(cached.status).send(cached.body);
      return;
    }

    // Intercept res.json / res.send to capture the response
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    const capture = (body: any, contentType: string) => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        const serialized = typeof body === "string" ? body : JSON.stringify(body);
        store.set(key, {
          body: serialized,
          contentType,
          status,
          storedAt: Date.now(),
        });
        ensureGc();
      }
    };

    res.json = function (body: any) {
      capture(body, "application/json; charset=utf-8");
      res.setHeader("X-Cache", "MISS");
      return originalJson(body);
    } as any;

    res.send = function (body: any) {
      const ct = res.getHeader("content-type");
      capture(body, typeof ct === "string" ? ct : "application/octet-stream");
      res.setHeader("X-Cache", "MISS");
      return originalSend(body);
    } as any;

    next();
  };
}

/**
 * Flush cached entries.
 *
 * @param prefix  If provided, only flush keys containing this substring.
 *                If omitted, flush everything.
 */
export function clearCache(prefix?: string): number {
  if (!prefix) {
    const count = store.size;
    store.clear();
    return count;
  }
  let count = 0;
  for (const key of store.keys()) {
    if (key.includes(prefix)) {
      store.delete(key);
      count++;
    }
  }
  return count;
}

/** Current cache size (for monitoring / health checks). */
export function cacheSize(): number {
  return store.size;
}
