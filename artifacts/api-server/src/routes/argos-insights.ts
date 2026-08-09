/**
 * Argos — copertura di validità corsa per corsa.
 *
 * GET /api/ai/argos/validity-coverage?projectId=…
 *
 * L'unica metrica che nessun'altra rotta espone in forma diretta: quante corse
 * del progetto hanno una validità (bollini in matrice corsa×giorno-tipo,
 * categorie del calendario aziendale, o calendario legacy) e quante sono SENZA
 * alcuna validità — quelle che nell'export legacy cadrebbero nel fallback 7/7.
 * È il primo controllo di una valutazione: se qui c'è un buco, gli orari che
 * si pubblicano non descrivono i giorni reali di circolazione.
 *
 * Serve ad Argos (tool ti_validity_coverage) per diagnosticare da solo il caso
 * "N corse senza validità → bollinare in matrice, non creare calendari GTFS".
 * Sola lettura, stessa auth del context (owner/membro/pubblicato).
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { hasProjectAccess } from "./argos-context";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

router.get("/ai/argos/validity-coverage", async (req: any, res: any) => {
  const projectId = String(req.query.projectId ?? "").trim();
  if (!UUID_RE.test(projectId)) {
    res.status(400).json({ error: "projectId non valido" });
    return;
  }
  const userId = (req.user?.id ?? req.user?.userId) as string | undefined;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const ok = await hasProjectAccess(projectId, userId).catch(() => false);
  if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }

  try {
    /* Un flag per fonte di validità, per ogni corsa attiva. "Senza alcuna
     * validità" = niente bollini giorno-tipo, niente categorie, niente
     * calendario legacy: la corsa non dichiara QUANDO circola. */
    const flags = ((await db.execute<any>(sql`
      SELECT t.id, t.route_id,
             r.short_name AS linea,
             COALESCE(t.headsign, '') AS headsign,
             (t.calendar_id IS NOT NULL) AS has_cal,
             EXISTS (SELECT 1 FROM ps_trip_day_validity v
                      WHERE v.trip_id = t.id AND v.is_valid) AS has_day,
             EXISTS (SELECT 1 FROM ps_trip_category_validity c
                      WHERE c.trip_id = t.id) AS has_cat,
             (SELECT MIN(st.departure_time) FROM ps_stop_times st
               WHERE st.trip_id = t.id) AS partenza
        FROM ps_trips t
        JOIN ps_routes r ON r.id = t.route_id
       WHERE t.project_id = ${projectId}::uuid
         AND COALESCE(t.is_active, true) = true`)) as any).rows ?? [];

    const senza = flags.filter((f: any) => !f.has_day && !f.has_cat && !f.has_cal);

    /* Raggruppo le scoperte per linea: è la vista su cui si agisce (bollino
     * in blocco per linea/insieme di corse, non corsa per corsa). */
    const perLinea: Record<string, number> = {};
    for (const f of senza) perLinea[f.linea || "?"] = (perLinea[f.linea || "?"] || 0) + 1;

    /* Corse valide per ciascun giorno-tipo (matrice): il quadro "quando
     * circola davvero il servizio" letto dalla fonte autoritativa. */
    const perGiornoTipo = ((await db.execute<any>(sql`
      SELECT dt.name AS giorno_tipo, dt.code AS codice, COUNT(*)::int AS corse
        FROM ps_trip_day_validity v
        JOIN ps_trips t ON t.id = v.trip_id
        JOIN ps_day_types dt ON dt.id = v.day_type_id
       WHERE t.project_id = ${projectId}::uuid AND v.is_valid
         AND COALESCE(t.is_active, true) = true
       GROUP BY dt.name, dt.code, dt.sort_order
       ORDER BY dt.sort_order NULLS LAST, dt.name`)) as any).rows ?? [];

    res.json({
      corseAttive: flags.length,
      conBollinoGiornoTipo: flags.filter((f: any) => f.has_day).length,
      conCategoriaAziendale: flags.filter((f: any) => f.has_cat).length,
      conCalendarioLegacy: flags.filter((f: any) => f.has_cal).length,
      senzaAlcunaValidita: {
        count: senza.length,
        perLinea: Object.entries(perLinea)
          .sort((a, b) => b[1] - a[1])
          .map(([linea, corse]) => ({ linea, corse })),
        esempi: senza.slice(0, 20).map((f: any) => ({
          linea: f.linea, partenza: f.partenza, destinazione: f.headsign || null,
        })),
      },
      corseValidePerGiornoTipo: perGiornoTipo.map((g: any) => ({
        giornoTipo: g.giorno_tipo, codice: g.codice, corse: g.corse,
      })),
      nota: senza.length > 0
        ? "Le corse senza alcuna validità cadrebbero nel fallback 7/7 nell'export legacy. "
          + "Correzione: bollinare le corse col giorno-tipo giusto nella matrice "
          + "(operazione bulk corsa×giorno-tipo) — NON creare calendari GTFS. "
          + "Con la matrice popolata l'export passa da solo alla validità effettiva."
        : "Tutte le corse attive dichiarano quando circolano: la validità è coperta.",
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "errore" });
  }
});

export default router;
