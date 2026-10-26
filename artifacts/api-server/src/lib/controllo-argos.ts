/**
 * All'avvio: argos_ro legge solo le tabelle del contratto?
 *
 * La migrazione 0002 ha chiuso la lettura di Argos sulle tabelle che usa.
 * Basta però rilanciare argos/cerbero_readonly_user.sql per ridargli tutto
 * (utenti, accessi, anagrafica, roster) e le tabelle future: la migrazione
 * non riparte da sola, quindi lo si dice nel log a ogni avvio.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { letturaFuoriContratto } from "./contratto-argos";
import { logger } from "./logger";

export async function controllaLetturaArgos(): Promise<void> {
  try {
    const ruolo = await db.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = 'argos_ro'`);
    if (!ruolo.rows.length) return;
    const r = await db.execute(sql`
      SELECT n.nspname || '.' || c.relname AS tabella
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'caronte') AND c.relkind IN ('r', 'v', 'm', 'p')
         AND has_table_privilege('argos_ro', c.oid, 'SELECT')`);
    const fuori = letturaFuoriContratto(r.rows.map((x: any) => String(x.tabella)));
    const predefiniti = await db.execute(sql`
      SELECT 1 FROM pg_default_acl d
       WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 'argos_ro'::regrole)`);
    if (fuori.length || predefiniti.rows.length) {
      logger.warn(
        { quante: fuori.length, tabelle: fuori.slice(0, 15), tabelleFuture: predefiniti.rows.length > 0 },
        "argos_ro legge tabelle fuori dal contratto (lib/contratto-argos.ts): probabilmente è stato "
        + "rilanciato argos/cerbero_readonly_user.sql. Riapplica i permessi con "
        + "psql -f lib/db/migrations/0002_argos_lettura.sql (DEPLOY.md, «Argos: sola lettura»)",
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "Controllo dei permessi di Argos non riuscito");
  }
}
