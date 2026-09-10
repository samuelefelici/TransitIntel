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

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");

  // ─── Warm-up cache: precarica gli endpoint pesanti ──────────────
  // territory/deep impiega ~27s a freddo per le subquery nearest-stop su ~4000 fermate.
  // Lo precarichiamo subito così il primo utente non aspetta mai.
  const WARMUP_PATHS = [
    "/api/territory/overview",
    "/api/territory/deep",
    "/api/analysis/underserved?minScore=3",
    "/api/analysis/stats",
  ];
  setTimeout(async () => {
    logger.info({ paths: WARMUP_PATHS.length }, "Warm-up cache: avvio precaricamento endpoint pesanti");
    for (const path of WARMUP_PATHS) {
      const t0 = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${port}${path}`);
        logger.info({ path, ms: Date.now() - t0, status: r.status }, "Warm-up: ok");
      } catch (err) {
        logger.warn({ path, err: String(err) }, "Warm-up: fallito (non critico)");
      }
    }
    logger.info("Warm-up cache: completato");
  }, 2_000);

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

  // ─── Auto-poller: AVM esterno via SIRI Vehicle Monitoring ────────
  // Alimenta lo schema `caronte` (posizioni, corse attive, transiti alle
  // fermate) da cui dipendono Sala Operativa, Tempi di percorrenza e GTFS-RT.
  if (process.env.SIRI_VM_URL) {
    const SIRI_INTERVAL_MS = Math.max(10, Number(process.env.SIRI_POLL_SECONDS) || 30) * 1000;
    let siriRunning = false; // un giro lento non deve accavallarsi col successivo

    const tick = async (phase: string) => {
      if (siriRunning) { logger.warn("SIRI poll: giro precedente ancora in corso, salto"); return; }
      siriRunning = true;
      try {
        const { runSiriIngest } = await import("./routes/siri");
        const result = await runSiriIngest();
        logger.info(result, `SIRI poll (${phase})`);
      } catch (err) {
        logger.error(err, `SIRI poll (${phase}): failed`);
      } finally {
        siriRunning = false;
      }
    };

    setTimeout(() => void tick("startup"), 15_000);
    setInterval(() => void tick("scheduled"), SIRI_INTERVAL_MS);
    logger.info(
      { url: process.env.SIRI_VM_URL, everySeconds: SIRI_INTERVAL_MS / 1000 },
      "SIRI auto-poll enabled",
    );
  } else {
    logger.warn("SIRI_VM_URL not set — connettore AVM SIRI disattivato");
  }
});

// ─── Timeout estesi per CP-SAT (vehicle/crew scheduler fino a 20 min) ──
server.requestTimeout = 1_500_000;     // 25 min — singola richiesta
server.headersTimeout = 1_500_000;     // 25 min — header
server.keepAliveTimeout = 1_500_000;   // 25 min — keep-alive
server.timeout = 0;                    // no socket timeout
logger.info("HTTP timeouts configurati per CP-SAT estesi (25 min)");

