/**
 * Polimetriche — Area di lavoro (Fares Engine).
 *
 * Le polimetriche si fanno su una FOTOGRAFIA di un programma di Planning
 * Studio (tappa 6.36): di solito quello in esercizio, o uno programmato o una
 * bozza. La fotografia (polim_imports, fonte «programma») tiene le linee
 * extraurbane, le loro varianti e le fermate coi km; la fa
 * lib/polimetrica-programma.ts, che ci porta anche il lavoro fatto sulla
 * fotografia di prima. Le fotografie di prima della 6.36 vengono da uno ZIP
 * GTFS (fonte «gtfs»): si aprono come prima, ma uno ZIP non si carica più.
 *
 * Endpoints (tutti sotto requireAuth, area Tariffe):
 *   GET    /api/fares/polimetriche/programmi                    — i programmi da cui si può fare una fotografia
 *   POST   /api/fares/polimetriche/programmi/:id/fotografia     — la fotografia di un programma, col lavoro fatto
 *   GET    /api/fares/polimetriche/imports                      — le fotografie (di tutta l'azienda)
 *   GET    /api/fares/polimetriche/imports/:id                  — albero linee→percorsi (metadata)
 *   GET    /api/fares/polimetriche/imports/:id/percorso         — dettaglio 1 percorso (?routeId=&variantId=)
 *   DELETE /api/fares/polimetriche/imports/:id                  — elimina una fotografia + sue polimetriche
 *   GET    /api/fares/polimetriche/saved?importId=              — polimetriche salvate
 *   POST   /api/fares/polimetriche/saved                        — crea/aggiorna polimetrica
 *   DELETE /api/fares/polimetriche/saved/:id                    — elimina polimetrica
 *   GET    /api/fares/polimetriche/fasce                        — le fasce chilometriche dell'azienda (sola lettura)
 *
 * Gli identificativi (`:id`, `importId`) sono UUID: uno che non lo è dà 400.
 * Agli errori del server il browser riceve un messaggio fisso; il dettaglio
 * resta nel log (tappa 6.35).
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { fasceDalDatabase } from "../lib/fasce-km-store";
import { strictLimiter } from "../middlewares/rate-limit";
import {
  FotografiaRifiutata, fotografaProgramma, programmiPerLePolimetriche, type Linea, type Percorso,
} from "../lib/polimetrica-programma";
import { z } from "zod";
import {
  componiPolimetrica, leggiCorpo, èUuid, LIMITI, type PercorsoImport,
} from "../lib/polimetrica-salvata";

const router: IRouter = Router();

/* Le tabelle polim_imports e polim_polimetriche arrivano dalle migrazioni (lib/db/migrations); 0057 per la fonte. */

const userId = (req: any): string | null => req?.user?.id ?? null;
const isAdmin = (req: any): boolean => req?.user?.role === "admin";
const chiE = (req: any) => ({ id: String(req.user?.id ?? ""), admin: isAdmin(req) });

/* ogni `:id` di queste rotte (un import, o una polimetrica salvata) è un UUID */
router.param("id", (_req, res, next, id) => {
  if (!èUuid(id)) { res.status(400).json({ error: "Identificativo non valido" }); return; }
  next();
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/programmi
 *
 *  I programmi da cui chi lavora alle tariffe può fare una fotografia: quello
 *  in esercizio, quelli programmati, le bozze di Planning Studio che può
 *  aprire. Con la data dell'ultima fotografia di ognuno.
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/programmi", async (req, res): Promise<void> => {
  try {
    res.json({ programmi: await programmiPerLePolimetriche(db, chiE(req)) });
  } catch (e: any) {
    console.error("[polimetriche] programmi", e);
    res.status(500).json({ error: "Programmi non leggibili" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  POST /api/fares/polimetriche/programmi/:id/fotografia
 *
 *  La fotografia di un programma (uno di quelli dell'elenco qui sopra), col
 *  lavoro fatto portato sopra: le polimetriche salvate e le decisioni del
 *  confronto, sui percorsi con le stesse fermate.
 * ───────────────────────────────────────────────────────────── */
router.post("/fares/polimetriche/programmi/:id/fotografia", strictLimiter, async (req, res): Promise<void> => {
  try {
    res.json(await fotografaProgramma(String(req.params.id), chiE(req)));
  } catch (e: any) {
    if (e instanceof FotografiaRifiutata) { res.status(e.stato).json({ error: e.message }); return; }
    console.error("[polimetriche] fotografia", e);
    res.status(500).json({ error: "Fotografia non riuscita" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports", async (_req, res): Promise<void> => {
  try {
    /* le polimetriche sono dell'azienda: chi ha l'area Tariffe vede tutte le fotografie (tappa 6.36) */
    const rows = (await db.execute<any>(sql`
      SELECT i.id, i.filename, i.agency_name, i.line_count, i.percorso_count, i.created_at,
             i.fonte, i.progetto_id, i.progetto_nome, i.stato_programma,
             (SELECT count(*)::int FROM polim_polimetriche p WHERE p.import_id = i.id) AS salvate
        FROM polim_imports i ORDER BY i.created_at DESC LIMIT 100`)).rows;
    res.json(rows.map((r: any) => ({
      id: r.id, filename: r.filename, agencyName: r.agency_name,
      lineCount: r.line_count, percorsoCount: r.percorso_count, createdAt: r.created_at,
      fonte: r.fonte, progettoId: r.progetto_id ?? null, progettoNome: r.progetto_nome ?? null, statoProgramma: r.stato_programma ?? null,
      salvate: Number(r.salvate) || 0,
    })));
  } catch (e: any) {
    console.error("[polimetriche] list imports", e);
    res.status(500).json({ error: "Import non leggibili" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports/:id   → albero linee→percorsi (metadata)
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports/:id", async (req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      SELECT id, filename, agency_name, line_count, percorso_count, payload, created_at, fonte, progetto_nome, stato_programma
      FROM polim_imports WHERE id = ${req.params.id} LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "Import non trovato" }); return; }
    const payload = row.payload as { agencyName: string | null; lines: Linea[] };
    // lista polimetriche già salvate per questo import (per marcare "fatto")
    const saved = (await db.execute<any>(sql`
      SELECT route_id, variant_id, direction FROM polim_polimetriche WHERE import_id = ${req.params.id}`)).rows;
    const savedKey = new Set(saved.map((s: any) => `${s.route_id}::${s.variant_id}::${s.direction}`));

    res.json({
      id: row.id,
      filename: row.filename,
      agencyName: row.agency_name,
      lineCount: row.line_count,
      percorsoCount: row.percorso_count,
      createdAt: row.created_at,
      fonte: row.fonte, progettoNome: row.progetto_nome ?? null, statoProgramma: row.stato_programma ?? null,
      lines: (payload.lines || []).map(l => ({
        lineCode: l.lineCode,
        lineName: l.lineName,
        routeIds: l.routeIds,
        percorsi: l.percorsi.map(p => ({
          variantId: p.variantId,
          routeId: p.routeId,
          directionId: p.directionId,
          tripCount: p.tripCount,
          firstStopName: p.firstStopName,
          lastStopName: p.lastStopName,
          stopCount: p.stopCount,
          totalKm: p.totalKm,
          distanceMethod: p.distanceMethod,
          savedAB: savedKey.has(`${p.routeId}::${p.variantId}::AB`),
          savedBA: savedKey.has(`${p.routeId}::${p.variantId}::BA`),
        })),
      })),
    });
  } catch (e: any) {
    console.error("[polimetriche] get import", e);
    res.status(500).json({ error: "Import non leggibile" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports/:id/percorso?routeId=&variantId=
 *      → dettaglio fermate + shape di un percorso
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports/:id/percorso", async (req, res): Promise<void> => {
  try {
    const { routeId, variantId } = req.query as { routeId?: string; variantId?: string };
    if (!routeId || !variantId) { res.status(400).json({ error: "routeId e variantId richiesti" }); return; }
    const r = await db.execute<any>(sql`SELECT payload FROM polim_imports WHERE id = ${req.params.id} LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "Import non trovato" }); return; }
    const payload = row.payload as { lines: Linea[] };
    let found: Percorso | null = null;
    let line: Linea | null = null;
    for (const l of payload.lines || []) {
      const p = l.percorsi.find(x => x.variantId === variantId && (x.routeId === routeId || x.routeIds.includes(routeId)));
      if (p) { found = p; line = l; break; }
    }
    if (!found || !line) { res.status(404).json({ error: "Percorso non trovato" }); return; }
    res.json({
      lineCode: line.lineCode,
      lineName: line.lineName,
      ...found,
    });
  } catch (e: any) {
    console.error("[polimetriche] get percorso", e);
    res.status(500).json({ error: "Percorso non leggibile" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports/:id/full
 *      → tutti i percorsi con fermate (stopName + km) per l'export massivo.
 *        Niente shape/lat/lon per tenere il payload leggero.
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports/:id/full", async (req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      SELECT agency_name, filename, payload FROM polim_imports WHERE id = ${req.params.id} LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "Import non trovato" }); return; }
    const payload = row.payload as { lines: Linea[] };
    res.json({
      agencyName: row.agency_name,
      filename: row.filename,
      lines: (payload.lines || []).map(l => ({
        lineCode: l.lineCode,
        lineName: l.lineName,
        percorsi: l.percorsi.map(p => ({
          variantId: p.variantId,
          routeId: p.routeId,
          directionId: p.directionId,
          firstStopName: p.firstStopName,
          lastStopName: p.lastStopName,
          totalKm: p.totalKm,
          stops: p.stops.map(s => ({ stopName: s.stopName, km: s.km })),
        })),
      })),
    });
  } catch (e: any) {
    console.error("[polimetriche] get full", e);
    res.status(500).json({ error: "Import non leggibile" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/imports/:id
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/imports/:id", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`DELETE FROM polim_imports WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[polimetriche] delete import", e);
    res.status(500).json({ error: "Import non eliminato" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/imports/:id/percorso?routeId=&variantId=
 *      → rimuove un percorso dall'elenco dell'import (pulizia)
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/imports/:id/percorso", async (req, res): Promise<void> => {
  try {
    const { routeId, variantId } = req.query as { routeId?: string; variantId?: string };
    if (!routeId || !variantId) { res.status(400).json({ error: "routeId e variantId richiesti" }); return; }
    const r = await db.execute<any>(sql`SELECT payload FROM polim_imports WHERE id = ${req.params.id} LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "Import non trovato" }); return; }
    const payload = row.payload as { agencyName: string | null; lines: Linea[] };
    let removed = 0;
    for (const l of payload.lines || []) {
      const before = l.percorsi.length;
      l.percorsi = l.percorsi.filter(p => !(p.variantId === variantId && (p.routeId === routeId || p.routeIds.includes(routeId))));
      removed += before - l.percorsi.length;
    }
    payload.lines = (payload.lines || []).filter(l => l.percorsi.length > 0);
    const percorsoCount = payload.lines.reduce((s, l) => s + l.percorsi.length, 0);
    await db.execute(sql`
      UPDATE polim_imports
      SET payload = ${JSON.stringify(payload)}::jsonb, line_count = ${payload.lines.length}, percorso_count = ${percorsoCount}
      WHERE id = ${req.params.id}`);
    res.json({ ok: true, removed, lineCount: payload.lines.length, percorsoCount });
  } catch (e: any) {
    console.error("[polimetriche] delete percorso", e);
    res.status(500).json({ error: "Percorso non eliminato" });
  }
});

const PercorsiDaEliminare = z.array(z.object({
  routeId: z.string().min(1).max(LIMITI.testo), variantId: z.string().min(1).max(LIMITI.testo),
})).max(10_000);

/* ─────────────────────────────────────────────────────────────
 *  POST /api/fares/polimetriche/imports/:id/percorsi/delete
 *      → rimuove PIÙ percorsi in un colpo solo. Body: { items: [{routeId, variantId}] }
 * ───────────────────────────────────────────────────────────── */
router.post("/fares/polimetriche/imports/:id/percorsi/delete", async (req, res): Promise<void> => {
  try {
    const letti = PercorsiDaEliminare.safeParse(req.body?.items);
    if (!letti.success) { res.status(400).json({ error: "Elenco dei percorsi da eliminare non valido" }); return; }
    const items = letti.data;
    if (items.length === 0) { res.status(400).json({ error: "Nessun percorso da eliminare" }); return; }
    const keys = new Set(items.map(i => `${i.routeId}::${i.variantId}`));
    const r = await db.execute<any>(sql`SELECT payload FROM polim_imports WHERE id = ${req.params.id} LIMIT 1`);
    const row = r.rows?.[0];
    if (!row) { res.status(404).json({ error: "Import non trovato" }); return; }
    const payload = row.payload as { agencyName: string | null; lines: Linea[] };
    let removed = 0;
    for (const l of payload.lines || []) {
      const before = l.percorsi.length;
      l.percorsi = l.percorsi.filter(p =>
        !(keys.has(`${p.routeId}::${p.variantId}`) || p.routeIds.some(rid => keys.has(`${rid}::${p.variantId}`))));
      removed += before - l.percorsi.length;
    }
    payload.lines = (payload.lines || []).filter(l => l.percorsi.length > 0);
    const percorsoCount = payload.lines.reduce((s, l) => s + l.percorsi.length, 0);
    await db.execute(sql`
      UPDATE polim_imports
      SET payload = ${JSON.stringify(payload)}::jsonb, line_count = ${payload.lines.length}, percorso_count = ${percorsoCount}
      WHERE id = ${req.params.id}`);
    res.json({ ok: true, removed, lineCount: payload.lines.length, percorsoCount });
  } catch (e: any) {
    console.error("[polimetriche] batch delete percorsi", e);
    res.status(500).json({ error: "Percorsi non eliminati" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/saved?importId=
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/saved", async (req, res): Promise<void> => {
  try {
    const importId = req.query.importId;
    if (importId !== undefined && !èUuid(importId)) { res.status(400).json({ error: "import non valido" }); return; }
    const rows = importId
      ? (await db.execute<any>(sql`
          SELECT * FROM polim_polimetriche WHERE import_id = ${importId} ORDER BY line_code, created_at`)).rows
      : (await db.execute<any>(sql`
          SELECT * FROM polim_polimetriche ORDER BY created_at DESC LIMIT 200`)).rows;
    res.json(rows.map(mapSavedRow));
  } catch (e: any) {
    console.error("[polimetriche] list saved", e);
    res.status(500).json({ error: "Polimetriche non leggibili" });
  }
});

function mapSavedRow(r: any) {
  return {
    id: r.id,
    importId: r.import_id,
    routeId: r.route_id,
    lineCode: r.line_code,
    lineName: r.line_name,
    variantId: r.variant_id,
    direction: r.direction,
    name: r.name,
    totalKm: r.total_km,
    stopCount: r.stop_count,
    trattaCount: r.tratta_count,
    boundaries: r.boundaries,
    tratte: r.tratte,
    stops: r.stops,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* ─────────────────────────────────────────────────────────────
 *  POST /api/fares/polimetriche/saved   (upsert)
 * ───────────────────────────────────────────────────────────── */
router.post("/fares/polimetriche/saved", async (req, res): Promise<void> => {
  const letto = leggiCorpo(req.body);
  if (!letto.ok) { res.status(400).json({ error: letto.errore }); return; }
  const c = letto.corpo;
  try {
    const percorso = await percorsoDellImport(c.importId, c.routeId, c.variantId);
    if (percorso === "senza import") { res.status(404).json({ error: "Import non trovato" }); return; }
    if (percorso === null) { res.status(400).json({ error: "Il percorso non è in questo import" }); return; }
    const composta = componiPolimetrica(c, percorso);
    if (!composta.ok) { res.status(400).json({ error: composta.errore }); return; }
    const p = composta.polimetrica;
    const inserted = await db.execute<any>(sql`
      INSERT INTO polim_polimetriche (
        import_id, route_id, line_code, line_name, variant_id, direction, name,
        total_km, stop_count, tratta_count, boundaries, tratte, stops, created_by, updated_at
      ) VALUES (
        ${p.importId}::uuid, ${p.routeId}, ${p.lineCode}, ${p.lineName}, ${p.variantId}, ${p.direction},
        ${p.name}, ${p.totalKm}, ${p.stops.length}, ${p.tratte.length},
        ${JSON.stringify(p.boundaries)}::jsonb, ${JSON.stringify(p.tratte)}::jsonb, ${JSON.stringify(p.stops)}::jsonb,
        ${userId(req)}, now()
      )
      ON CONFLICT (import_id, route_id, variant_id, direction) DO UPDATE SET
        name = EXCLUDED.name,
        line_code = EXCLUDED.line_code,
        line_name = EXCLUDED.line_name,
        total_km = EXCLUDED.total_km,
        stop_count = EXCLUDED.stop_count,
        tratta_count = EXCLUDED.tratta_count,
        boundaries = EXCLUDED.boundaries,
        tratte = EXCLUDED.tratte,
        stops = EXCLUDED.stops,
        updated_at = now()
      RETURNING *
    `);
    res.json(mapSavedRow(inserted.rows?.[0]));
  } catch (e: any) {
    console.error("[polimetriche] save", e);
    res.status(500).json({ error: "Polimetrica non salvata" });
  }
});

/**
 * Il percorso di un import (senza la geometria), cercato come lo cerca la
 * pagina: la variante, e la linea GTFS o una delle sue linee sorelle.
 * «senza import» se l'import non c'è, `null` se il percorso non è nell'import.
 */
async function percorsoDellImport(importId: string, routeId: string, variantId: string): Promise<PercorsoImport | "senza import" | null> {
  const c = await db.execute<any>(sql`SELECT 1 FROM polim_imports WHERE id = ${importId}::uuid`);
  if (!c.rows?.length) return "senza import";
  const r = await db.execute<any>(sql`
    SELECT l.value->>'lineCode' AS line_code, l.value->>'lineName' AS line_name, p.value - 'shape' AS percorso
      FROM polim_imports i
      CROSS JOIN LATERAL jsonb_array_elements(i.payload->'lines') WITH ORDINALITY AS l(value, n)
      CROSS JOIN LATERAL jsonb_array_elements(l.value->'percorsi') WITH ORDINALITY AS p(value, n)
     WHERE i.id = ${importId}::uuid
       AND p.value->>'variantId' = ${variantId}
       AND (p.value->>'routeId' = ${routeId} OR p.value->'routeIds' @> jsonb_build_array(${routeId}::text))
     ORDER BY l.n, p.n
     LIMIT 1`);
  const x = r.rows?.[0];
  if (!x) return null;
  const p = x.percorso ?? {};
  return {
    routeId: String(p.routeId ?? routeId), variantId: String(p.variantId ?? variantId),
    lineCode: x.line_code ?? null, lineName: x.line_name ?? null,
    totalKm: Number(p.totalKm) || 0,
    stops: Array.isArray(p.stops) ? p.stops : [],
  };
}

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/saved/:id
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/saved/:id", async (req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`DELETE FROM polim_polimetriche WHERE id = ${req.params.id}::uuid RETURNING id`);
    if (!r.rows?.length) { res.status(404).json({ error: "Polimetrica non trovata" }); return; }
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[polimetriche] delete saved", e);
    res.status(500).json({ error: "Polimetrica non eliminata" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/fasce
 *
 *  Le fasce chilometriche dell'azienda, per chi lavora alle polimetriche
 *  (tappa 6.33): la pagina ci calcola le tratte e la fascia fra due nodi.
 *  Le scrive solo l'amministratore (PUT /api/admin/fasce-km); qui si leggono.
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/fasce", async (_req, res): Promise<void> => {
  try {
    res.json({ fasce: await fasceDalDatabase() });
  } catch (e) {
    console.error("[polimetriche] fasce", e);
    res.status(500).json({ error: "Fasce chilometriche non leggibili" });
  }
});

export default router;
