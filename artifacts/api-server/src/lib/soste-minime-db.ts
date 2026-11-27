/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA SOSTA MINIMA AL CAPOLINEA — le letture
 * ───────────────────────────────────────────────────────────────────────────
 * Le usa il giro (ottimizza-veicoli/esegui.ts, nel lavoratore: qui niente
 * Express né rotte), il controllo prima del giro e le rotte
 * (soste-minime-rotte.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { Ex } from "./anagrafica-store";
import { sostaEffettiva, type SosteDelProgetto } from "./soste-minime";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows = (r: any): any[] => r?.rows ?? [];
const intero = (x: unknown): number | undefined => {
  const n = Number(x);
  return x != null && x !== "" && Number.isInteger(n) && n >= 0 && n <= 60 ? n : undefined;
};

export async function sosteMinimeDelProgetto(psProjectId: string, ex: Ex = db): Promise<SosteDelProgetto> {
  const p = rows(await ex.execute(sql`
    SELECT agency_settings->>'sostaMinimaCapolineaMin' AS v FROM ps_projects WHERE id = ${psProjectId}::uuid`))[0];
  const perNodo = new Map<string, number>();
  for (const r of rows(await ex.execute(sql`
    SELECT id::text, attributes->>'sostaMinimaMin' AS v FROM ps_stop_clusters
     WHERE project_id = ${psProjectId}::uuid AND attributes ? 'sostaMinimaMin'`))) {
    const v = intero(r.v);
    if (v !== undefined) perNodo.set(String(r.id), v);
  }
  const perFermata = new Map<string, number>();
  const nodoDi = new Map<string, string>();
  for (const r of rows(await ex.execute(sql`
    SELECT id::text, cluster_id::text AS nodo, attributes->>'sostaMinimaMin' AS v FROM ps_stops
     WHERE project_id = ${psProjectId}::uuid AND (attributes ? 'sostaMinimaMin' OR cluster_id IS NOT NULL)`))) {
    const v = intero(r.v);
    if (v !== undefined) perFermata.set(String(r.id), v);
    if (r.nodo) nodoDi.set(String(r.id), String(r.nodo));
  }
  return { predefinita: intero(p?.v) ?? null, perFermata, perNodo, nodoDi };
}

/** I capolinea delle corse attive del progetto, con la sosta che vale per ciascuno. */
export async function capolineaDelProgetto(psProjectId: string, s: SosteDelProgetto) {
  const r = rows(await db.execute(sql`
    WITH estremi AS (
      (SELECT DISTINCT ON (st.trip_id) st.stop_id FROM ps_stop_times st JOIN ps_trips t ON t.id = st.trip_id
        WHERE t.project_id = ${psProjectId}::uuid AND COALESCE(t.is_active, true)
        ORDER BY st.trip_id, st.stop_seq DESC)
    )
    SELECT s.id::text AS id, s.name, count(*)::int AS arrivi
      FROM estremi e JOIN ps_stops s ON s.id = e.stop_id
     GROUP BY s.id, s.name ORDER BY count(*) DESC, s.name`));
  return r.map(x => {
    const e = sostaEffettiva(String(x.id), s);
    return { stopId: String(x.id), nome: String(x.name ?? ""), arrivi: Number(x.arrivi), minuti: e?.minuti ?? null, fonte: e?.fonte ?? null };
  });
}
