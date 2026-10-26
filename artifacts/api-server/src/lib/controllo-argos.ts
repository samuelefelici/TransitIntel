/**
 * argos_ro, il ruolo con cui Argos legge il database, legge solo le tabelle
 * del contratto (lib/db/contratti/argos-lettura.mjs)?
 *
 * Il migratore riporta i permessi al contratto a ogni avvio; qui si controlla
 * soltanto, all'avvio e poi ogni 6 ore, perché basta rilanciare
 * argos/cerbero_readonly_user.sql per ridare ad Argos tutto (utenti, accessi,
 * anagrafica, roster) e le tabelle future. Se qualcosa non torna lo dice nel
 * log, con il comando che lo sistema.
 */
import { pool } from "@workspace/db";
import { verifica } from "../../../../lib/db/scripts/argos-permessi-regole.mjs";
import { logger } from "./logger";

const OGNI = 6 * 60 * 60 * 1000;

export async function controllaLetturaArgos(): Promise<void> {
  try {
    const e = await verifica(pool);
    if (e.assente) return;
    if (e.daFare.length || e.errori.length) {
      logger.warn(
        { daFare: e.daFare.map((a) => a.perche), daSistemareAMano: e.errori },
        "argos_ro non è in regola col contratto di lettura (lib/db/contratti/argos-lettura.mjs). "
        + "Dal container dell'API: node lib/db/scripts/argos-permessi.mjs (DEPLOY.md, «Argos: sola lettura»)",
      );
    }
    if (e.avvisi.length) logger.warn({ avvisi: e.avvisi }, "Permessi di Argos: avvisi");
  } catch (err) {
    logger.warn({ err }, "Controllo dei permessi di Argos non riuscito");
  }
}

export function avviaControlloArgos(): void {
  setTimeout(() => void controllaLetturaArgos(), 5_000).unref();
  setInterval(() => void controllaLetturaArgos(), OGNI).unref();
}
