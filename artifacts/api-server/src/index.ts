import app from "./app";
import { logger } from "./lib/logger";
import { syncTrafficFromTomTom } from "./routes/cron";
import { MAX_GAP_SEC as SIRI_MAX_POLL_SECONDS, effectivePollSeconds } from "./lib/siri-vm";
import { controllaLetturaArgos } from "./lib/controllo-argos";

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

  // Argos deve leggere solo le tabelle del contratto (migrazione 0002)
  setTimeout(() => void controllaLetturaArgos(), 5_000);

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
    /* Il transito alla fermata si riconosce dal CAMBIO di fermata fra due
     * letture consecutive: oltre i 300 s il cambio non è più attribuibile a
     * una fermata sola e non si registra NULLA. Un intervallo più lungo non
     * rende il connettore lento: lo rende muto, in silenzio, e la pagina
     * Tempi di percorrenza resta vuota senza che niente lo spieghi.
     *
     * Perciò l'intervallo viene riportato a un valore utile invece di essere
     * obbedito alla lettera: una configurazione che disattiva la funzione
     * principale del modulo è una contraddizione, non una scelta. La regola
     * sta in siriPoll(), una sola volta, perché il poller e /api/siri/status
     * non possano raccontare due cose diverse. Se il taglio scatta lo si dice
     * qui nei log e si vede nello stato. */
    const RICHIESTO = Number(process.env.SIRI_POLL_SECONDS) || 30;
    const EFFETTIVO = effectivePollSeconds(RICHIESTO);
    const SIRI_INTERVAL_MS = EFFETTIVO * 1000;
    if (EFFETTIVO !== RICHIESTO) {
      logger.warn(
        { richiesto: RICHIESTO, effettivo: EFFETTIVO, limite: SIRI_MAX_POLL_SECONDS },
        `SIRI_POLL_SECONDS=${RICHIESTO} impedirebbe di rilevare i transiti alle `
        + `fermate (oltre ${SIRI_MAX_POLL_SECONDS}s il cambio di fermata non è più `
        + `attribuibile): intervallo portato a ${EFFETTIVO}s. `
        + `Imposta SIRI_POLL_SECONDS=${EFFETTIVO} per togliere questo avviso.`,
      );
    }
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

    /* Il controllo settimanale dell'AVM: ogni ora guarda se c'è una settimana
     * chiusa senza controllo archiviato e lo calcola. Il primo giro dopo le
     * 03:00 di lunedì archivia la settimana appena chiusa; un deploy nel
     * momento sbagliato non fa perdere niente, perché il giro dopo recupera.
     * Due minuti dopo l'avvio, per non accavallarsi col primo giro SIRI. */
    const controlloAvm = async () => {
      try {
        const { assicuraArchivio } = await import("./lib/avm-controllo-servizio");
        const archiviate = await assicuraArchivio();
        if (archiviate.length) logger.info({ archiviate }, "Controllo settimanale AVM archiviato");
      } catch (err) {
        logger.error(err, "Controllo settimanale AVM: failed");
      }
    };
    setTimeout(() => void controlloAvm(), 120_000);
    setInterval(() => void controlloAvm(), 60 * 60 * 1000);
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

// ─── Arresto ordinato ────────────────────────────────────────────────
// Al deploy Coolify manda SIGTERM e uccide il container dopo 30 s. Il proxy
// (Traefik) toglie il container dal bilanciamento solo quando il processo
// esce: chiudere subito la porta farebbe rifiutare le connessioni che gli
// arrivano ancora (502). Quindi al SIGTERM l'API continua a rispondere, ma con
// «Connection: close», così ogni connessione si chiude a fine risposta e le
// richieste successive vanno al container nuovo; chiude le connessioni
// inattive (con il keep-alive di 25 min resterebbero aperte) ed esce appena non
// ha richieste in corso da 1 s, o comunque dopo CERBERO_ARRESTO_SECONDI
// (25 s, al massimo 28: oltre i 30 s Coolify uccide il processo). I calcoli più
// lunghi non fanno in tempo: per quelli arriva la coda dei lavori.
let inArresto = false;
const risposteInCorso = new Set<import("node:http").ServerResponse>();
server.prependListener("request", (_req, res) => {
  if (inArresto) res.shouldKeepAlive = false;
  risposteInCorso.add(res);
  res.once("close", () => risposteInCorso.delete(res));
});
const ATTESA_ARRESTO_MS = Math.min(Math.max(Number(process.env.CERBERO_ARRESTO_SECONDI) || 25, 1), 28) * 1000;
function esci(motivo: string): void {
  logger.info({ motivo, richiesteAperte: risposteInCorso.size }, "Arresto completato");
  server.close();
  process.exit(0);
}
function arresta(segnale: string): void {
  if (inArresto) return;
  inArresto = true;
  logger.info({ segnale }, "Arresto: chiudo le connessioni a fine risposta e finisco quelle in corso");
  for (const r of risposteInCorso) if (!r.headersSent) r.shouldKeepAlive = false;
  let ferma = 0;
  setInterval(() => {
    server.closeIdleConnections();
    ferma = risposteInCorso.size === 0 ? ferma + 1 : 0;
    if (ferma >= 4) esci("nessuna richiesta in corso");
  }, 250).unref();
  setTimeout(() => esci(`scaduti ${ATTESA_ARRESTO_MS / 1000} s`), ATTESA_ARRESTO_MS).unref();
}
process.on("SIGTERM", () => arresta("SIGTERM"));
process.on("SIGINT", () => arresta("SIGINT"));

