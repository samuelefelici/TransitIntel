/**
 * Il lavoratore dei calcoli: un processo a parte, stessa immagine dell'API
 * (CERBERO_PROCESSO=lavoratore in docker/avvio.sh), che esegue i lavori della
 * coda (coda.lavori). Un deploy dell'API non interrompe più i calcoli.
 *
 * - Prende lavori solo se lo schema del database è quello che conosce (o più
 *   nuovo): la guardia di versione (lib/guardia-schema.ts). Non applica
 *   migrazioni: le applica l'API al suo avvio.
 * - GET /api/healthz su 127.0.0.1:PORT, così l'HEALTHCHECK dell'immagine
 *   (docker/salute.mjs) vale anche qui. Risponde 200 anche con lo schema
 *   indietro: il lavoratore non riceve traffico, e al push di una migrazione
 *   il suo container può partire prima che l'API la applichi; con un 503
 *   Coolify lo scarterebbe e terrebbe il vecchio. Aspetta, senza prendere
 *   lavori (`prendeLavori: false`), e la guardia lo riallinea in 15 s.
 *   (PR 2.8: con lo schema «sconosciuto», cioè senza SELECT sulla tabella di
 *   tracciamento, non prende lavori: il permesso va dato all'utente dell'app.)
 * - SIGTERM: smette di prendere lavori, aspetta 20 s quelli in corso, poi li
 *   ferma e li rimette in coda senza consumare il tentativo (Coolify concede
 *   30 s).
 *
 * - Ogni 6 ore le pulizie (lib/lavori/pulizie.ts): calcoli delle tariffe
 *   rimasti «running», feed sintetici orfani.
 *
 * Non importa app.ts, le rotte, lib/auth.ts né lib/planning-studio.ts: lo
 * controlla __tests__/lavoratore-import.test.ts. Non ha bisogno di JWT_SECRET
 * né di CERBERO_CHIAVE_MFA.
 */
import http from "node:http";
import { logger } from "./lib/logger";
import { attendiPrimoControllo, avviaGuardiaSchema, statoDelloSchema } from "./lib/guardia-schema";
import { creaEsecutore } from "./lib/lavori/esecutore";
import { GESTORI } from "./lib/lavori/gestori";
import { chiSono, slotDaAmbiente } from "./lib/lavori/ambiente";
import { avviaPulizie } from "./lib/lavori/pulizie";

const porta = Number(process.env.PORT || 3001);
const ATTESA_ARRESTO_MS = 20_000;
const chi = chiSono("lavoratore");
const slot = slotDaAmbiente();

avviaGuardiaSchema();
const puoPrendere = () => {
  const s = statoDelloSchema();
  return s === "ok" || s === "avanti";
};
const esecutore = creaEsecutore({ chi, slot, gestori: GESTORI, log: logger, puoPrendere });
esecutore.avvia();
// pulizie periodiche (calcoli delle tariffe appesi, feed sintetici orfani): solo qui, non nell'API
const fermaPulizie = avviaPulizie(logger, () => statoDelloSchema() === "ok");

const server = http.createServer(async (req, res) => {
  const percorso = (req.url ?? "").split("?")[0];
  if (req.method !== "GET" || percorso !== "/api/healthz") {
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Non trovato"}');
    return;
  }
  await attendiPrimoControllo(3_000);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    status: "ok",
    schema: statoDelloSchema(),
    processo: "lavoratore",
    prendeLavori: puoPrendere(),
    lavoriInCorso: esecutore.inCorso(),
  }));
});
server.listen(porta, "127.0.0.1", () => logger.info(
  { porta, chi, slot, tipi: GESTORI.map(g => `${g.tipo}@${g.versione}`) }, "Lavoratore dei calcoli avviato"));

let inArresto = false;
async function arresta(segnale: string): Promise<void> {
  if (inArresto) return;
  inArresto = true;
  logger.info({ segnale, lavoriInCorso: esecutore.inCorso() }, "Arresto del lavoratore: niente lavori nuovi, finisco o rimetto in coda quelli in corso");
  fermaPulizie();
  try { await esecutore.ferma(ATTESA_ARRESTO_MS); }
  catch (err) { logger.error({ err }, "arresto del lavoratore: errore fermando i lavori"); }
  server.close();
  logger.info("Lavoratore fermo");
  process.exit(0);
}
process.on("SIGTERM", () => void arresta("SIGTERM"));
process.on("SIGINT", () => void arresta("SIGINT"));
