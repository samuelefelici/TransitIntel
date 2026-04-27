import { Router, type IRouter } from "express";
import { syncPoiFromOsm, syncPoiFromGoogle, syncTrafficFromTomTom, syncCensusFromIstat, syncCommutingOdFromIstat } from "./cron.js";

const router: IRouter = Router();

// Simple in-memory rate limit: one sync at a time, cooldown 60s
const cooldown: Record<string, number> = {};
const COOLDOWN_MS = 60_000;

function checkCooldown(key: string): { ok: boolean; remaining: number } {
  const last = cooldown[key] ?? 0;
  const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - last));
  return { ok: remaining === 0, remaining: Math.ceil(remaining / 1000) };
}
function setCooldown(key: string) {
  cooldown[key] = Date.now();
}

const ALLOWED_SOURCES = ["google-poi", "poi", "traffic", "census", "commuting"] as const;
const STATUS_SOURCES = [...ALLOWED_SOURCES];

/**
 * POST /api/admin/sync/:source
 */
router.post("/admin/sync/:source", async (req, res) => {
  const { source } = req.params as { source: string };
  if (!ALLOWED_SOURCES.includes(source as any)) {
    res.status(400).json({ error: `Unknown source. Use: ${ALLOWED_SOURCES.join(", ")}` });
    return;
  }

  const cd = checkCooldown(source);
  if (!cd.ok) {
    res.status(429).json({ error: `Cooldown attivo. Riprova tra ${cd.remaining}s.` });
    return;
  }

  setCooldown(source);

  try {
    let result: Record<string, any> = {};

    if (source === "google-poi") {
      result = await syncPoiFromGoogle();
    } else if (source === "poi") {
      result = await syncPoiFromOsm();
    } else if (source === "traffic") {
      result = await syncTrafficFromTomTom();
    } else if (source === "census") {
      result = await syncCensusFromIstat();
    } else if (source === "commuting") {
      result = await syncCommutingOdFromIstat();
    }

    res.json({ success: true, source, ...result });
  } catch (err: any) {
    req.log.error(err, `Error syncing ${source}`);
    res.status(500).json({ success: false, source, message: err.message ?? "Errore interno" });
  }
});

/**
 * GET /api/admin/sync/status
 */
router.get("/admin/sync/status", (_req, res) => {
  const status: Record<string, any> = {};
  for (const source of STATUS_SOURCES) {
    const cd = checkCooldown(source);
    const last = cooldown[source];
    status[source] = {
      ready: cd.ok,
      cooldownRemaining: cd.remaining,
      lastSync: last ? new Date(last).toISOString() : null,
    };
  }
  res.json(status);
});

export default router;
