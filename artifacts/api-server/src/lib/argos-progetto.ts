/**
 * Chi può vedere che cosa di Argos: l'accesso ai progetti di Planning Studio.
 *
 * Il pannello di Argos e la console (/argos) leggono lavori fatti su un
 * progetto: un piano, la traccia di un'esecuzione, le note. Si vedono solo se
 * l'utente può aprire quel progetto, con lo stesso criterio delle altre rotte
 * di Planning Studio (owner, membro, o progetto messo in esercizio). Vivono qui
 * perché le usano sia routes/ai.ts sia routes/argos-console.ts.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const UUID_RE = /^[0-9a-f-]{36}$/i;

export function utenteDi(req: any): string | null {
  return req?.session?.userId ?? req?.user?.id ?? null;
}

/** La riga del progetto se l'utente vi ha accesso, altrimenti null. */
export async function accessoAlProgetto(projectId: string, userId: string): Promise<{ id: string } | null> {
  const r = await db.execute(sql`
    SELECT p.id
      FROM ps_projects p
      LEFT JOIN ps_project_members pm
             ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid
       AND (
         p.owner_user_id = ${userId}::uuid
         OR pm.user_id IS NOT NULL
         OR (p.materialized_feed_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM gtfs_feeds gf
                          WHERE gf.id = p.materialized_feed_id AND gf.is_active = true))
       )
     LIMIT 1
  `);
  return ((r as any).rows?.[0] as { id: string } | undefined) ?? null;
}

/**
 * Dei progetti dati, quelli che l'utente può aprire. Un id malformato o un
 * errore del database non apre niente: fallisce chiuso.
 */
export async function progettiAccessibili(projectIds: Iterable<string>, userId: string): Promise<Set<string>> {
  const unici = [...new Set(projectIds)].filter((id) => UUID_RE.test(id));
  const esiti = await Promise.all(unici.map((id) => accessoAlProgetto(id, userId).then((p) => (p ? id : null)).catch(() => null)));
  return new Set(esiti.filter((id): id is string => id !== null));
}
