/**
 * argos_ro, il ruolo con cui Argos legge il database, legge solo le tabelle
 * del contratto (lib/db/contratti/argos-lettura.mjs)?
 *
 * Il migratore riporta i permessi al contratto a ogni avvio; qui si controlla
 * soltanto, all'avvio e poi ogni 6 ore, perché basta rilanciare
 * argos/cerbero_readonly_user.sql per ridare ad Argos tutto (utenti, accessi,
 * anagrafica, roster) e le tabelle future, fino al prossimo avvio. Se qualcosa
 * non torna lo dice nel log, con il comando che lo sistema.
 *
 * Il contratto è quello in vigore nel database se è più nuovo di questo codice
 * (un container vecchio durante un deploy, o dopo un rollback): così non
 * segnala come fuori posto le tabelle date da una versione successiva.
 * (PR 2.8: all'utente dell'app serve SELECT su cerbero_migrazioni.contratti;
 * senza, usa il contratto del codice e lo dice.)
 */
import { pool } from "@workspace/db";
import { verifica } from "../../../../lib/db/scripts/argos-permessi-regole.mjs";
import { logger } from "./logger";

const OGNI = 6 * 60 * 60 * 1000;

export async function controllaLetturaArgos(): Promise<void> {
  try {
    const e = await verifica(pool);
    if (e.assente) return;
    if (e.contratto.nota) logger.info({ contratto: e.contratto.versione }, `Permessi di Argos: ${e.contratto.nota}`);
    if (e.daFare.length || e.errori.length) {
      logger.warn(
        { contratto: e.contratto.versione, daFare: e.daFare.map((a) => a.perche), daSistemareAMano: e.errori },
        "argos_ro non è in regola col contratto di lettura (lib/db/contratti/argos-lettura.mjs). "
        + "Dal container dell'API: node lib/db/scripts/argos-permessi.mjs (DEPLOY.md, «Argos: sola lettura»)",
      );
    }
    // avvisi: per esempio un contratto più nuovo nel database (rollback o revert)
    // o letture fuori dagli schemi di Cerbero
    if (e.avvisi.length) logger.warn({ avvisi: e.avvisi }, "Permessi di Argos: avvisi");
  } catch (err) {
    logger.warn({ err }, "Controllo dei permessi di Argos non riuscito");
  }
}

export function avviaControlloArgos(): void {
  setTimeout(() => void controllaLetturaArgos(), 5_000).unref();
  setInterval(() => void controllaLetturaArgos(), OGNI).unref();
}
