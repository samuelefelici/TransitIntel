import app from "./app";
import { logger } from "./lib/logger";
import { syncTrafficFromTomTom } from "./routes/cron";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, () => {
  logger.info({ port }, "Server listening");

  // ─── Auto-scheduler: TomTom traffic sync ────────────────────────
  const TRAFFIC_INTERVAL_MS = 30 * 60 * 1000; // 30 minuti

  if (process.env.TOMTOM_API_KEY) {
    // Primo sync 10 secondi dopo l'avvio
    setTimeout(async () => {
      try {
        const result = await syncTrafficFromTomTom();
        logger.info(result, "Traffic auto-sync (startup): done");
      } catch (err) {
        logger.error(err, "Traffic auto-sync (startup): failed");
      }
    }, 10_000);

    // Poi ogni 30 minuti
    setInterval(async () => {
      try {
        const result = await syncTrafficFromTomTom();
        logger.info(result, "Traffic auto-sync (scheduled): done");
      } catch (err) {
        logger.error(err, "Traffic auto-sync (scheduled): failed");
      }
    }, TRAFFIC_INTERVAL_MS);

    logger.info("Traffic auto-sync enabled: every 30 min (50 road points × 48/day = ~2400 req/day)");
  } else {
    logger.warn("TOMTOM_API_KEY not set — traffic auto-sync disabled");
  }
});
