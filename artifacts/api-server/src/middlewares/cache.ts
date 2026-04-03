import type { Request, Response, NextFunction, RequestHandler } from "express";
import NodeCache from "node-cache";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistent in-memory cache middleware using node-cache.
 *
 * Features:
 *  - TTL per entry (configurable per route)
 *  - Automatic periodic cleanup (built into node-cache)
 *  - Snapshots to disk every 2 min → survives restarts
 *  - Stats accessible via cacheStats()
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
}

// ── Persistence ───────────────────────────────────────────────
const CACHE_DIR = path.resolve(process.cwd(), ".cache");
const SNAPSHOT_FILE = path.join(CACHE_DIR, "api-cache.json");
const SNAPSHOT_INTERVAL = 2 * 60 * 1000; // 2 min
const DEFAULT_MAX_AGE = 10 * 60; // 10 min (seconds)

// node-cache instance with TTL check every 120s
const store = new NodeCache({ stdTTL: DEFAULT_MAX_AGE, checkperiod: 120, useClones: false });

// ── Restore from disk on boot ────────────────────────────────
function restoreFromDisk() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const raw = fs.readFileSync(SNAPSHOT_FILE, "utf-8");
      const entries: Record<string, { val: CacheEntry; ttl: number }> = JSON.parse(raw);
      const now = Date.now();
      let restored = 0;
      for (const [key, { val, ttl }] of Object.entries(entries)) {
        const remainingSec = Math.round((ttl - now) / 1000);
        if (remainingSec > 0) {
          store.set(key, val, remainingSec);
          restored++;
        }
      }
      if (restored > 0) {
        console.log(`[cache] Restored ${restored} entries from disk`);
      }
    }
  } catch {
    // corrupted file — ignore
  }
}
restoreFromDisk();

// ── Snapshot to disk periodically ────────────────────────────
function snapshotToDisk() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const keys = store.keys();
    const snapshot: Record<string, { val: CacheEntry; ttl: number }> = {};
    for (const key of keys) {
      const val = store.get<CacheEntry>(key);
      const ttl = store.getTtl(key);
      if (val && ttl) {
        snapshot[key] = { val, ttl };
      }
    }
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot), "utf-8");
  } catch {
    // best-effort — don't crash
  }
}
const snapTimer = setInterval(snapshotToDisk, SNAPSHOT_INTERVAL);
if (snapTimer && typeof snapTimer === "object" && "unref" in snapTimer) {
  (snapTimer as NodeJS.Timeout).unref();
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
  const ttl = opts.ttlSeconds ?? 60;

  return (req: Request, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== "GET") return next();

    const key = opts.keyFn ? opts.keyFn(req) : req.originalUrl;
    const cached = store.get<CacheEntry>(key);

    if (cached) {
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
        store.set<CacheEntry>(key, { body: serialized, contentType, status }, ttl);
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
    const count = store.keys().length;
    store.flushAll();
    return count;
  }
  let count = 0;
  for (const key of store.keys()) {
    if (key.includes(prefix)) {
      store.del(key);
      count++;
    }
  }
  return count;
}

/** Current cache size (for monitoring / health checks). */
export function cacheSize(): number {
  return store.keys().length;
}

/** Cache hit/miss statistics from node-cache. */
export function cacheStats() {
  return store.getStats();
}
