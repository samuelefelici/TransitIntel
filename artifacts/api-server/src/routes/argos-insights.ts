/**
 * Argos — copertura di validità corsa per corsa + percorso di una linea.
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
 *
 * GET /api/ai/argos/line-route?projectId=…&routeId=…[&direction=0|1]
 *
 * Il PERCORSO di una linea come lo vede il pianificatore: le varianti con la
 * sequenza ORDINATA delle fermate (ps_variant_stops), la progressiva in km, il
 * NODO di interscambio a cui la fermata appartiene (cluster curato a mano in
 * ps_stop_clusters) e le altre linee che toccano la stessa fermata. Senza
 * questa rotta Argos vedeva solo nomi e lunghezze: gli interscambi finivano
 * dedotti dai nomi delle linee invece che dalle fermate condivise, e gli orari
 * intermedi non avevano progressive su cui ancorarsi. Vale anche (soprattutto)
 * in fase disegno-rete, quando le corse non esistono ancora e il quadro orario
 * per fermata è vuoto.
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

router.get("/ai/argos/line-route", async (req: any, res: any) => {
  const projectId = String(req.query.projectId ?? "").trim();
  const routeId = String(req.query.routeId ?? "").trim();
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
  if (!UUID_RE.test(routeId)) { res.status(400).json({ error: "routeId non valido" }); return; }
  const direction = ["0", "1"].includes(String(req.query.direction ?? "")) ? Number(req.query.direction) : null;
  const userId = (req.user?.id ?? req.user?.userId) as string | undefined;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const ok = await hasProjectAccess(projectId, userId).catch(() => false);
  if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }

  try {
    const routeRow = ((await db.execute<any>(sql`
      SELECT id::text AS id, code, short_name, long_name
        FROM ps_routes WHERE id = ${routeId}::uuid AND project_id = ${projectId}::uuid`)) as any).rows?.[0];
    if (!routeRow) { res.status(404).json({ error: "Linea non trovata nel progetto" }); return; }

    const variants = ((await db.execute<any>(sql`
      SELECT v.id::text AS id, v.name, v.code, v.direction, v.headsign, v.variant_kind,
             v.is_default, v.distance_m_cached, v.duration_s_cached,
             (SELECT count(*)::int FROM ps_trips t WHERE t.variant_id = v.id) AS corse,
             (SELECT s.distance_m FROM ps_shapes s WHERE s.variant_id = v.id LIMIT 1) AS shape_m
        FROM ps_route_variants v
       WHERE v.route_id = ${routeId}::uuid AND v.project_id = ${projectId}::uuid
         ${direction !== null ? sql`AND v.direction = ${direction}` : sql``}
       ORDER BY v.direction ASC, v.is_default DESC, v.created_at ASC`)) as any).rows ?? [];

    const stopRows = ((await db.execute<any>(sql`
      SELECT vs.variant_id::text AS variant_id, vs.seq, vs.shape_dist_traveled,
             s.id::text AS stop_id, s.name, s.code AS stop_code, s.lat, s.lon,
             c.name AS nodo
        FROM ps_variant_stops vs
        JOIN ps_route_variants v ON v.id = vs.variant_id
        JOIN ps_stops s ON s.id = vs.stop_id
        LEFT JOIN ps_stop_clusters c ON c.id = s.cluster_id
       WHERE v.route_id = ${routeId}::uuid AND v.project_id = ${projectId}::uuid
       ORDER BY vs.variant_id, vs.seq ASC`)) as any).rows ?? [];

    /* Altre linee per fermata: quali ALTRE linee del progetto toccano le stesse
     * fermate di questa. È l'interscambio "di fatto" (fermata condivisa); quello
     * "di progetto" sono i nodi (cluster), riportati per fermata qui sotto. */
    const shared = ((await db.execute<any>(sql`
      SELECT vs.stop_id::text AS stop_id,
             array_agg(DISTINCT COALESCE(r.code, r.short_name)) AS linee
        FROM ps_variant_stops vs
        JOIN ps_route_variants v ON v.id = vs.variant_id
        JOIN ps_routes r ON r.id = v.route_id
       WHERE v.project_id = ${projectId}::uuid AND r.id <> ${routeId}::uuid
         AND vs.stop_id IN (
           SELECT vs2.stop_id FROM ps_variant_stops vs2
             JOIN ps_route_variants v2 ON v2.id = vs2.variant_id
            WHERE v2.route_id = ${routeId}::uuid)
       GROUP BY vs.stop_id`)) as any).rows ?? [];
    const altreLinee = new Map<string, string[]>(
      shared.map((r: any) => [r.stop_id, (r.linee ?? []).filter(Boolean)]));

    const byVariant = new Map<string, any[]>();
    for (const s of stopRows) {
      let arr = byVariant.get(s.variant_id);
      if (!arr) { arr = []; byVariant.set(s.variant_id, arr); }
      arr.push({
        seq: Number(s.seq),
        nome: s.name,
        codice: s.stop_code ?? null,
        lat: s.lat != null ? +Number(s.lat).toFixed(5) : null,
        lon: s.lon != null ? +Number(s.lon).toFixed(5) : null,
        progressivaKm: s.shape_dist_traveled != null
          ? +(Number(s.shape_dist_traveled) / 1000).toFixed(2) : null,
        nodo: s.nodo ?? null,
        altreLinee: altreLinee.get(s.stop_id) ?? [],
      });
    }

    res.json({
      linea: {
        id: routeRow.id,
        codice: routeRow.code ?? routeRow.short_name,
        nome: routeRow.long_name ?? null,
      },
      varianti: variants.map((v: any) => ({
        id: v.id,
        nome: v.name,
        codice: v.code ?? null,
        direzione: v.direction,
        destinazione: v.headsign ?? null,
        tipo: v.variant_kind ?? "standard",
        predefinita: !!v.is_default,
        lunghezzaKm: v.distance_m_cached != null
          ? +(Number(v.distance_m_cached) / 1000).toFixed(2)
          : v.shape_m != null ? +(Number(v.shape_m) / 1000).toFixed(2) : null,
        durataMinCached: v.duration_s_cached != null
          ? Math.round(Number(v.duration_s_cached) / 60) : null,
        corse: Number(v.corse ?? 0),
        fermate: byVariant.get(v.id) ?? [],
      })),
      nota: "Sequenza fermate dal disegno della variante (esiste anche senza corse). "
        + "'nodo' = cluster di interscambio curato dal pianificatore: gli interscambi "
        + "si dichiarano lì (o su fermate con 'altreLinee'), non dedotti dai nomi. "
        + "'progressivaKm' ancora i tempi intermedi; 'corse'=0 su una direzione "
        + "significa che il ritorno non è ancora programmato.",
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "errore" });
  }
});

export default router;
