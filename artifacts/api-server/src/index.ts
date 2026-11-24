import app from "./app";
import { logger } from "./lib/logger";
import { avviaTraffico } from "./lib/traffico-quota";
import { MAX_GAP_SEC as SIRI_MAX_POLL_SECONDS, effectivePollSeconds } from "./lib/siri-vm";
import { avviaControlloArgos } from "./lib/controllo-argos";
import { controllaSegretiCron } from "./lib/segreto-cron";
import { controllaSegretoArgosProxy } from "./lib/argos-proxy";
import { avviaGuardiaSchema, statoDelloSchema } from "./lib/guardia-schema";
import { creaEsecutore } from "./lib/lavori/esecutore";
import { GESTORI } from "./lib/lavori/gestori";
import { chiSono, esecutoreInternoAcceso, slotDaAmbiente } from "./lib/lavori/ambiente";
import { arresto } from "./lib/arresto";
import { controllaIdentita } from "./lib/identita-db";
import { inSistema } from "@workspace/db/contesto";
import { tieniAggiornataAzienda } from "./lib/azienda";

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

/* l'azienda in memoria segue la riga anche per i timer, che non passano da una richiesta: la regola
 * delle vetture dell'azienda nell'AVM sta lì (lib/vetture-azienda.ts) */
tieniAggiornataAzienda();

const server = app.listen(port, () => {
  logger.info({ port }, "Server listening");

  // Con chi lavoro sul database (cerbero_app come cerbero_owner): se il ruolo non si applica, esce
  void controllaIdentita("api");
  // Il database ha tutte le migrazioni di questo codice? (log e /api/healthz)
  avviaGuardiaSchema();
  // I calcoli della coda (coda.lavori): li esegue il lavoratore; finché non c'è,
  // o per tornare indietro, anche l'API (CERBERO_LAVORATORE_INTERNO, default acceso)
  if (esecutoreInternoAcceso()) {
    esecutoreInterno = creaEsecutore({
      chi: chiSono("api"),
      slot: slotDaAmbiente(),
      gestori: GESTORI,
      log: logger,
      puoPrendere: () => { const st = statoDelloSchema(); return st === "ok" || st === "avanti"; },
    });
    esecutoreInterno.avvia();
    logger.info({ slot: slotDaAmbiente() }, "Esecutore interno dei lavori acceso (CERBERO_LAVORATORE_INTERNO=0 lo spegne quando c'è il lavoratore)");
  }
  // Argos deve leggere solo le tabelle del contratto: lo si controlla nel log
  avviaControlloArgos();
  controllaSegretiCron();
  controllaSegretoArgosProxy();

  // (tappa 7.26) Qui c'era un precaricamento della cache all'avvio: chiamava
  // territorio e analisi via HTTP senza credenziali, riceveva sempre 401 e non
  // precaricava niente. Tolto: niente cambia per chi usa le pagine, la prima
  // chiamata dopo un riavvio calcola come già faceva.

  // ─── Letture del traffico da TomTom, dentro la quota mensile (tappa 7.30) ──
  // L'intervallo viene dai punti stradali e da TRAFFICO_RICHIESTE_MESE; la prima
  // lettura arriva un intervallo dopo l'ultima registrata (lib/traffico-quota.ts).
  if (process.env.TOMTOM_API_KEY) {
    avviaTraffico(logger).catch((err) => logger.error(err, "Traffic auto-sync: non avviato"));
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

    setTimeout(() => void inSistema("timer:siri", () => tick("startup")), 15_000);
    setInterval(() => void inSistema("timer:siri", () => tick("scheduled")), SIRI_INTERVAL_MS);
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
    setTimeout(() => void inSistema("timer:avm-controllo", controlloAvm), 120_000);
    setInterval(() => void inSistema("timer:avm-controllo", controlloAvm), 60 * 60 * 1000);
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
// (25 s, al massimo 28: oltre i 30 s Coolify uccide il processo). I calcoli
// dell'esecutore interno si fermano e tornano in coda: li riprende il
// lavoratore o il container nuovo. Lo stream dei lavori si chiude (il client
// riprova e arriva al container nuovo).
let inArresto = false;
let esecutoreInterno: ReturnType<typeof creaEsecutore> | null = null;
let fermataLavori: Promise<void> = Promise.resolve();
let uscendo = false;
const risposteInCorso = new Set<import("node:http").ServerResponse>();
server.prependListener("request", (_req, res) => {
  if (inArresto) res.shouldKeepAlive = false;
  risposteInCorso.add(res);
  res.once("close", () => risposteInCorso.delete(res));
});
const ATTESA_ARRESTO_MS = Math.min(Math.max(Number(process.env.CERBERO_ARRESTO_SECONDI) || 25, 1), 28) * 1000;
function fine(motivo: string): void {
  logger.info({ motivo, richiesteAperte: risposteInCorso.size, lavoriInCorso: esecutoreInterno?.inCorso() ?? 0 }, "Arresto completato");
  server.close();
  process.exit(0);
}
/* senza richieste in corso si esce, ma prima i lavori dell'esecutore interno
   devono tornare in coda (il termine ATTESA_ARRESTO_MS vale comunque) */
function esci(motivo: string): void {
  if (uscendo) return;
  uscendo = true;
  void fermataLavori.catch(() => {}).then(() => fine(motivo));
}
function arresta(segnale: string): void {
  if (inArresto) return;
  inArresto = true;
  logger.info({ segnale }, "Arresto: chiudo le connessioni a fine risposta e finisco quelle in corso");
  arresto.abort();
  if (esecutoreInterno) fermataLavori = esecutoreInterno.ferma(Math.max(0, ATTESA_ARRESTO_MS - 12_000));
  for (const r of risposteInCorso) if (!r.headersSent) r.shouldKeepAlive = false;
  let ferma = 0;
  setInterval(() => {
    server.closeIdleConnections();
    ferma = risposteInCorso.size === 0 ? ferma + 1 : 0;
    if (ferma >= 4) esci("nessuna richiesta in corso");
  }, 250).unref();
  setTimeout(() => fine(`scaduti ${ATTESA_ARRESTO_MS / 1000} s`), ATTESA_ARRESTO_MS).unref();
}
process.on("SIGTERM", () => arresta("SIGTERM"));
process.on("SIGINT", () => arresta("SIGINT"));

