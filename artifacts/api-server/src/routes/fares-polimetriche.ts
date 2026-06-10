/**
 * Polimetriche — Area di lavoro dedicata (Fares Engine).
 *
 * Import GTFS ISOLATO (non tocca il feed di Bigliettazione): lo ZIP viene
 * parsato in memoria, si estraggono i percorsi univoci delle SOLE linee
 * extraurbane (codice linea che inizia con una lettera) e si salva una
 * struttura compatta in `polim_imports.payload` (jsonb).
 *
 * Per ogni linea si raggruppano i trip per signature canonica
 * `min(fwd_stop_ids, rev_stop_ids)` (unifica andata/ritorno) e per ogni
 * percorso si calcolano le fermate ordinate con km cumulato: proiezione
 * sulla shape GTFS se presente, altrimenti haversine fermata→fermata.
 *
 * Endpoints (tutti sotto requireAuth):
 *   POST   /api/fares/polimetriche/import                       — upload ZIP, estrae, salva
 *   GET    /api/fares/polimetriche/imports                      — lista import
 *   GET    /api/fares/polimetriche/imports/:id                  — albero linee→percorsi (metadata)
 *   GET    /api/fares/polimetriche/imports/:id/percorso         — dettaglio 1 percorso (?routeId=&variantId=)
 *   DELETE /api/fares/polimetriche/imports/:id                  — elimina import + sue polimetriche
 *   GET    /api/fares/polimetriche/saved?importId=              — polimetriche salvate
 *   POST   /api/fares/polimetriche/saved                        — crea/aggiorna polimetrica
 *   DELETE /api/fares/polimetriche/saved/:id                    — elimina polimetrica
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { haversineKm } from "../lib/geo-utils";
import { parseCsv } from "./gtfs-helpers";
import { strictLimiter } from "../middlewares/rate-limit";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

/* ─────────────────────────────────────────────────────────────
 *  Tabelle (bootstrap lazy — niente migration richiesta)
 * ───────────────────────────────────────────────────────────── */
let bootstrapped = false;
async function ensureTables(): Promise<void> {
  if (bootstrapped) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS polim_imports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        filename text,
        agency_name text,
        created_by text,
        line_count int NOT NULL DEFAULT 0,
        percorso_count int NOT NULL DEFAULT 0,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_polim_imports_created_at ON polim_imports(created_at DESC)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS polim_polimetriche (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        import_id uuid NOT NULL REFERENCES polim_imports(id) ON DELETE CASCADE,
        route_id text NOT NULL,
        line_code text,
        line_name text,
        variant_id text NOT NULL,
        direction text NOT NULL DEFAULT 'AB',
        name text,
        total_km double precision,
        stop_count int,
        tratta_count int,
        boundaries jsonb,
        tratte jsonb,
        stops jsonb,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (import_id, route_id, variant_id, direction)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_polim_polimetriche_import ON polim_polimetriche(import_id)`);
    bootstrapped = true;
  } catch (e: any) {
    console.error("[polimetriche] bootstrap tables error", e?.message);
  }
}
void ensureTables();

const userId = (req: any): string | null => req?.user?.id ?? null;
const isAdmin = (req: any): boolean => req?.user?.role === "admin";

/* ─────────────────────────────────────────────────────────────
 *  Geometria — proiezione fermate sulla shape
 * ───────────────────────────────────────────────────────────── */
type LatLon = { lat: number; lon: number };

/** Punto più vicino su un segmento A→B (in spazio lat/lon equirettangolare locale). */
function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): { t: number } {
  // scala longitudine per la latitudine media → metrica locale ~ isotropa
  const latRef = (a.lat + b.lat) / 2;
  const kx = Math.cos((latRef * Math.PI) / 180);
  const ax = a.lon * kx, ay = a.lat;
  const bx = b.lon * kx, by = b.lat;
  const px = p.lon * kx, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0 };
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return { t };
}

/**
 * Calcola km cumulato per ogni fermata proiettandola sulla shape.
 * Ritorna null se la shape è inutilizzabile.
 */
function cumKmAlongShape(stops: LatLon[], shape: LatLon[]): number[] | null {
  if (shape.length < 2) return null;
  // distanze cumulate sui vertici della shape
  const cum: number[] = [0];
  for (let i = 1; i < shape.length; i++) {
    cum.push(cum[i - 1] + haversineKm(shape[i - 1].lat, shape[i - 1].lon, shape[i].lat, shape[i].lon));
  }
  const result: number[] = [];
  let searchFrom = 0; // mantiene monotonia lungo la shape
  for (const st of stops) {
    let best = { dist: Infinity, km: 0, segIdx: searchFrom };
    for (let i = searchFrom; i < shape.length - 1; i++) {
      const { t } = projectOnSegment(st, shape[i], shape[i + 1]);
      const projLat = shape[i].lat + t * (shape[i + 1].lat - shape[i].lat);
      const projLon = shape[i].lon + t * (shape[i + 1].lon - shape[i].lon);
      const d = haversineKm(st.lat, st.lon, projLat, projLon);
      if (d < best.dist) {
        const segLen = cum[i + 1] - cum[i];
        best = { dist: d, km: cum[i] + t * segLen, segIdx: i };
      }
    }
    // se la fermata è lontanissima dalla shape (>2km) la proiezione non è affidabile
    if (best.dist > 2) return null;
    const km = result.length ? Math.max(best.km, result[result.length - 1]) : best.km;
    result.push(km);
    searchFrom = best.segIdx; // non tornare indietro
  }
  return result;
}

/** km cumulato haversine fermata→fermata (fallback). */
function cumKmHaversine(stops: LatLon[]): number[] {
  const out: number[] = [];
  let cum = 0;
  for (let i = 0; i < stops.length; i++) {
    if (i > 0) cum += haversineKm(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    out.push(cum);
  }
  return out;
}

/** Downsample una polilinea mantenendo max `maxPts` punti (capi inclusi). */
function downsample<T>(arr: T[], maxPts: number): T[] {
  if (arr.length <= maxPts) return arr;
  const step = (arr.length - 1) / (maxPts - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPts; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const shortHash = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 7);
};
const isExtraurban = (code: string): boolean => /^[A-Za-z]/.test((code || "").trim());

/* ─────────────────────────────────────────────────────────────
 *  Tipi del payload compatto
 * ───────────────────────────────────────────────────────────── */
interface PercorsoStop { stopId: string; stopName: string; lat: number; lon: number; km: number; distPrev: number; }
interface Percorso {
  variantId: string;
  routeId: string;
  routeIds: string[];
  directionId: number | null; // verso operato dal bus (direction_id GTFS): 0=andata, 1=ritorno
  tripCount: number;
  firstStopName: string;
  lastStopName: string;
  stopCount: number;
  totalKm: number;
  distanceMethod: "shape" | "haversine";
  stops: PercorsoStop[];
  shape: [number, number][] | null; // [lon,lat]
}
interface Linea { lineCode: string; lineName: string; routeIds: string[]; percorsi: Percorso[]; }

/* ─────────────────────────────────────────────────────────────
 *  POST /api/fares/polimetriche/import
 * ───────────────────────────────────────────────────────────── */
router.post("/fares/polimetriche/import", strictLimiter, upload.single("file"), async (req, res): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: "Nessun file ricevuto. Invia uno ZIP GTFS come campo 'file'." });
    return;
  }
  try {
    await ensureTables();
    const zip = new AdmZip(req.file.buffer);
    const getFile = (name: string): string | null => {
      const e = zip.getEntry(name);
      return e ? e.getData().toString("utf8") : null;
    };

    const routesRaw = parseCsv(getFile("routes.txt") || "");
    const tripsRaw = parseCsv(getFile("trips.txt") || "");
    const stopTimesRaw = parseCsv(getFile("stop_times.txt") || "");
    const stopsRaw = parseCsv(getFile("stops.txt") || "");
    const shapesRaw = parseCsv(getFile("shapes.txt") || "");
    const agencyRaw = parseCsv(getFile("agency.txt") || "");

    if (routesRaw.length === 0 || tripsRaw.length === 0 || stopTimesRaw.length === 0 || stopsRaw.length === 0) {
      res.status(400).json({ error: "ZIP GTFS incompleto: servono almeno routes.txt, trips.txt, stop_times.txt, stops.txt." });
      return;
    }

    const agencyName = agencyRaw[0]?.["agency_name"] || null;

    // ── stops index ──
    const stopById = new Map<string, { name: string; lat: number; lon: number }>();
    for (const s of stopsRaw) {
      const id = s["stop_id"];
      if (!id) continue;
      stopById.set(id, {
        name: s["stop_name"] || id,
        lat: parseFloat(s["stop_lat"] || "0"),
        lon: parseFloat(s["stop_lon"] || "0"),
      });
    }

    // ── shapes index ──
    const shapeById = new Map<string, LatLon[]>();
    if (shapesRaw.length > 0) {
      const tmp = new Map<string, { seq: number; lat: number; lon: number }[]>();
      for (const p of shapesRaw) {
        const id = p["shape_id"];
        if (!id) continue;
        if (!tmp.has(id)) tmp.set(id, []);
        tmp.get(id)!.push({
          seq: parseInt(p["shape_pt_sequence"] || "0", 10),
          lat: parseFloat(p["shape_pt_lat"] || "0"),
          lon: parseFloat(p["shape_pt_lon"] || "0"),
        });
      }
      for (const [id, pts] of tmp) {
        pts.sort((a, b) => a.seq - b.seq);
        shapeById.set(id, pts.map(p => ({ lat: p.lat, lon: p.lon })));
      }
    }

    // ── routes extraurbane (codice che inizia con lettera) ──
    // raggruppa per CODICE LINEA (route_short_name) → una linea può avere più route_id
    const routeMeta = new Map<string, { lineCode: string; lineName: string }>();
    const lineRouteIds = new Map<string, Set<string>>(); // lineCode → route_id[]
    for (const r of routesRaw) {
      const rid = r["route_id"];
      if (!rid) continue;
      const code = (r["route_short_name"] || rid).trim();
      if (!isExtraurban(code)) continue;
      routeMeta.set(rid, { lineCode: code, lineName: r["route_long_name"] || "" });
      if (!lineRouteIds.has(code)) lineRouteIds.set(code, new Set());
      lineRouteIds.get(code)!.add(rid);
    }
    if (routeMeta.size === 0) {
      res.status(400).json({ error: "Nessuna linea extraurbana trovata (codici che iniziano con una lettera)." });
      return;
    }

    // ── trips → route + shape (solo route extraurbane) ──
    const tripInfo = new Map<string, { routeId: string; shapeId: string | null; directionId: string | null }>();
    for (const t of tripsRaw) {
      const rid = t["route_id"];
      if (!rid || !routeMeta.has(rid)) continue;
      tripInfo.set(t["trip_id"], {
        routeId: rid,
        shapeId: t["shape_id"] || null,
        directionId: t["direction_id"] ?? null,
      });
    }

    // ── stop_times → sequenza fermate per trip rilevante ──
    const tripStops = new Map<string, { seq: number; stopId: string }[]>();
    for (const st of stopTimesRaw) {
      const tid = st["trip_id"];
      if (!tid || !tripInfo.has(tid)) continue;
      if (!tripStops.has(tid)) tripStops.set(tid, []);
      tripStops.get(tid)!.push({ seq: parseInt(st["stop_sequence"] || "0", 10), stopId: st["stop_id"] });
    }
    for (const arr of tripStops.values()) arr.sort((a, b) => a.seq - b.seq);

    // ── costruzione linee → percorsi (signature canonica fwd/rev) ──
    const lines: Linea[] = [];
    for (const [lineCode, ridSet] of lineRouteIds) {
      const routeIds = [...ridSet];
      // bucket per signature ESATTA (sequenza fermate come operata dal bus).
      // Andata e ritorno restano percorsi DISTINTI, distinti dal direction_id.
      type Bucket = {
        sig: string;            // signature forward esatta
        stopSeq: string[];      // fermate nell'ordine operato
        repShapeId: string | null;
        routeIds: Set<string>;
        tripCount: number;
        dirCount: Record<string, number>;  // direction_id → n. trip
      };
      const buckets = new Map<string, Bucket>();
      for (const [tid, info] of tripInfo) {
        if (!ridSet.has(info.routeId)) continue;
        const seq = tripStops.get(tid);
        if (!seq || seq.length < 2) continue;
        const ids = seq.map(s => s.stopId);
        const sig = ids.join("|");
        let b = buckets.get(sig);
        if (!b) {
          b = { sig, stopSeq: ids, repShapeId: info.shapeId, routeIds: new Set(), tripCount: 0, dirCount: {} };
          buckets.set(sig, b);
        }
        b.routeIds.add(info.routeId);
        b.tripCount++;
        const d = info.directionId ?? "?";
        b.dirCount[d] = (b.dirCount[d] ?? 0) + 1;
        if (!b.repShapeId && info.shapeId) b.repShapeId = info.shapeId;
      }
      if (buckets.size === 0) continue;

      const percorsi: Percorso[] = [...buckets.values()]
        .sort((a, b) => b.tripCount - a.tripCount)
        .map((b) => {
          const stopLL: LatLon[] = b.stopSeq.map(id => {
            const s = stopById.get(id);
            return { lat: s?.lat ?? 0, lon: s?.lon ?? 0 };
          });
          // distanze: shape se proiezione valida, altrimenti haversine
          let kms: number[] | null = null;
          let method: "shape" | "haversine" = "haversine";
          let shapeOut: [number, number][] | null = null;
          if (b.repShapeId && shapeById.has(b.repShapeId)) {
            const shape = shapeById.get(b.repShapeId)!;
            kms = cumKmAlongShape(stopLL, shape);
            if (kms) {
              method = "shape";
              shapeOut = downsample(shape, 600).map(p => [round(p.lon, 6), round(p.lat, 6)] as [number, number]);
            }
          }
          if (!kms) kms = cumKmHaversine(stopLL);

          // direction_id dominante (0 = andata, 1 = ritorno)
          let directionId: number | null = null;
          let bestN = -1;
          for (const [k, n] of Object.entries(b.dirCount)) {
            if (k !== "0" && k !== "1") continue;
            if (n > bestN) { bestN = n; directionId = parseInt(k, 10); }
          }

          const stops: PercorsoStop[] = b.stopSeq.map((id, i) => {
            const s = stopById.get(id);
            return {
              stopId: id,
              stopName: s?.name ?? id,
              lat: round(s?.lat ?? 0, 6),
              lon: round(s?.lon ?? 0, 6),
              km: round(kms![i], 3),
              distPrev: round(i > 0 ? kms![i] - kms![i - 1] : 0, 3),
            };
          });
          const totalKm = stops.length ? stops[stops.length - 1].km : 0;
          return {
            variantId: shortHash(b.sig),
            routeId: [...b.routeIds][0],
            routeIds: [...b.routeIds],
            directionId,
            tripCount: b.tripCount,
            firstStopName: stops[0]?.stopName ?? "",
            lastStopName: stops[stops.length - 1]?.stopName ?? "",
            stopCount: stops.length,
            totalKm: round(totalKm, 2),
            distanceMethod: method,
            stops,
            shape: shapeOut,
          };
        });

      const meta = routeMeta.get(routeIds[0]);
      lines.push({
        lineCode,
        lineName: meta?.lineName || percorsi[0]?.firstStopName + " ↔ " + percorsi[0]?.lastStopName || lineCode,
        routeIds,
        percorsi,
      });
    }

    // ordina linee per codice (alfanumerico naturale)
    lines.sort((a, b) => a.lineCode.localeCompare(b.lineCode, "it", { numeric: true }));

    const percorsoCount = lines.reduce((s, l) => s + l.percorsi.length, 0);
    const payload = { agencyName, lines };

    const inserted = await db.execute<any>(sql`
      INSERT INTO polim_imports (filename, agency_name, created_by, line_count, percorso_count, payload)
      VALUES (
        ${req.file.originalname || "feed.zip"}, ${agencyName}, ${userId(req)},
        ${lines.length}, ${percorsoCount}, ${JSON.stringify(payload)}::jsonb
      )
      RETURNING id, created_at
    `);
    const row = inserted.rows?.[0];
    res.json({
      importId: row?.id,
      createdAt: row?.created_at,
      agencyName,
      lineCount: lines.length,
      percorsoCount,
      lines: lines.map(l => ({
        lineCode: l.lineCode,
        lineName: l.lineName,
        percorsoCount: l.percorsi.length,
      })),
    });
  } catch (e: any) {
    console.error("[polimetriche] import", e);
    res.status(500).json({ error: e?.message || "Errore durante l'import GTFS" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports", async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const uid = userId(req);
    const rows = isAdmin(req) || !uid
      ? (await db.execute<any>(sql`
          SELECT id, filename, agency_name, line_count, percorso_count, created_at
          FROM polim_imports ORDER BY created_at DESC LIMIT 100`)).rows
      : (await db.execute<any>(sql`
          SELECT id, filename, agency_name, line_count, percorso_count, created_at
          FROM polim_imports WHERE created_by = ${uid} OR created_by IS NULL
          ORDER BY created_at DESC LIMIT 100`)).rows;
    res.json(rows.map((r: any) => ({
      id: r.id, filename: r.filename, agencyName: r.agency_name,
      lineCount: r.line_count, percorsoCount: r.percorso_count, createdAt: r.created_at,
    })));
  } catch (e: any) {
    console.error("[polimetriche] list imports", e);
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports/:id   → albero linee→percorsi (metadata)
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports/:id", async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const r = await db.execute<any>(sql`
      SELECT id, filename, agency_name, line_count, percorso_count, payload, created_at
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
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/imports/:id/percorso?routeId=&variantId=
 *      → dettaglio fermate + shape di un percorso
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/imports/:id/percorso", async (req, res): Promise<void> => {
  try {
    await ensureTables();
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
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/imports/:id
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/imports/:id", async (req, res): Promise<void> => {
  try {
    await ensureTables();
    await db.execute(sql`DELETE FROM polim_imports WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[polimetriche] delete import", e);
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/imports/:id/percorso?routeId=&variantId=
 *      → rimuove un percorso dall'elenco dell'import (pulizia)
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/imports/:id/percorso", async (req, res): Promise<void> => {
  try {
    await ensureTables();
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
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  POST /api/fares/polimetriche/imports/:id/percorsi/delete
 *      → rimuove PIÙ percorsi in un colpo solo. Body: { items: [{routeId, variantId}] }
 * ───────────────────────────────────────────────────────────── */
router.post("/fares/polimetriche/imports/:id/percorsi/delete", async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const items: { routeId: string; variantId: string }[] = Array.isArray(req.body?.items) ? req.body.items : [];
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
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/saved?importId=
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/saved", async (req, res): Promise<void> => {
  try {
    await ensureTables();
    const importId = req.query.importId as string | undefined;
    const rows = importId
      ? (await db.execute<any>(sql`
          SELECT * FROM polim_polimetriche WHERE import_id = ${importId} ORDER BY line_code, created_at`)).rows
      : (await db.execute<any>(sql`
          SELECT * FROM polim_polimetriche ORDER BY created_at DESC LIMIT 200`)).rows;
    res.json(rows.map(mapSavedRow));
  } catch (e: any) {
    console.error("[polimetriche] list saved", e);
    res.status(500).json({ error: e?.message || "Errore" });
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
  try {
    await ensureTables();
    const b = req.body || {};
    const { importId, routeId, lineCode, lineName, variantId } = b;
    const direction = b.direction === "BA" ? "BA" : "AB";
    if (!importId || !routeId || !variantId) {
      res.status(400).json({ error: "importId, routeId e variantId richiesti" });
      return;
    }
    const tratte = Array.isArray(b.tratte) ? b.tratte : [];
    const boundaries = Array.isArray(b.boundaries) ? b.boundaries : [];
    const stops = Array.isArray(b.stops) ? b.stops : [];
    const inserted = await db.execute<any>(sql`
      INSERT INTO polim_polimetriche (
        import_id, route_id, line_code, line_name, variant_id, direction, name,
        total_km, stop_count, tratta_count, boundaries, tratte, stops, created_by, updated_at
      ) VALUES (
        ${importId}, ${routeId}, ${lineCode ?? null}, ${lineName ?? null}, ${variantId}, ${direction},
        ${b.name ?? null}, ${b.totalKm ?? null}, ${stops.length}, ${tratte.length},
        ${JSON.stringify(boundaries)}::jsonb, ${JSON.stringify(tratte)}::jsonb, ${JSON.stringify(stops)}::jsonb,
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
    res.status(500).json({ error: e?.message || "Errore salvataggio" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/saved/:id
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/saved/:id", async (req, res): Promise<void> => {
  try {
    await ensureTables();
    await db.execute(sql`DELETE FROM polim_polimetriche WHERE id = ${req.params.id}`);
    res.json({ ok: true });
  } catch (e: any) {
    console.error("[polimetriche] delete saved", e);
    res.status(500).json({ error: e?.message || "Errore" });
  }
});

export default router;
