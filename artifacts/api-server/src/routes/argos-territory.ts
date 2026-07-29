/* ═══════════════════════════════════════════════════════════════════════
 *  TERRITORIO PER ARGOS — Mapbox mediato dal server
 *
 *  Argos sapeva cosa contiene il progetto ma non cosa c'è INTORNO: non
 *  poteva dire "quella fermata è in mezzo ai campi", "l'ospedale ha una
 *  farmacia e due scuole a trecento metri", "da lì a piedi in dieci
 *  minuti si copre mezzo quartiere". Qui gli si dà accesso al territorio
 *  via Mapbox, ma passando dal server:
 *    ▸ il token resta lato server e non finisce mai in mano all'agente;
 *    ▸ le risposte sono normalizzate e in italiano, così l'agente non
 *      deve interpretare tre formati Mapbox diversi;
 *    ▸ c'è una cache breve, perché un agente tende a ripetere la stessa
 *      domanda più volte nello stesso ragionamento.
 *
 *  Tre capacità, che è quello che serve per ragionare su una rete:
 *    · dove sono → indirizzo di un punto e ricerca per nome
 *    · cosa c'è intorno → POI reali entro un raggio
 *    · cosa si raggiunge → isocrone a piedi
 * ═══════════════════════════════════════════════════════════════════════ */
import { Router, type IRouter } from "express";

const router: IRouter = Router();
const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN || "";

/* Cache in memoria: le stesse coordinate vengono richieste più volte nello
 * stesso ragionamento, e ogni chiamata a Mapbox è a consumo. */
const cache = new Map<string, { at: number; data: any }>();
const TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 500;

function cached(key: string): any | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL_MS) return null;
  return hit.data;
}
function putCache(key: string, data: any): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), data });
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function requireToken(res: any): boolean {
  if (MAPBOX_TOKEN) return true;
  res.status(503).json({
    error: "Cartografia non configurata",
    detail: "MAPBOX_ACCESS_TOKEN non impostato sul server: le informazioni sul territorio non sono disponibili.",
  });
  return false;
}

async function mapbox(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Mapbox ha risposto ${r.status}`);
  return r.json();
}

/* ── Che posto è questo ─────────────────────────────────────────────────
 * GET /api/ai/argos/territory/place?lat=&lon=
 * Indirizzo, quartiere, comune e provincia di un punto: serve per dire
 * "la fermata X è in zona industriale" invece del solo nome fermata. */
router.get("/ai/argos/territory/place", async (req: any, res: any) => {
  if (!requireToken(res)) return;
  const lat = num(req.query.lat), lon = num(req.query.lon);
  if (lat == null || lon == null) { res.status(400).json({ error: "lat e lon richiesti" }); return; }

  const key = `place:${lat.toFixed(5)},${lon.toFixed(5)}`;
  const hit = cached(key);
  if (hit) { res.json({ ...hit, daCache: true }); return; }

  try {
    const j = await mapbox(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json`
      + `?language=it&types=address,neighborhood,locality,place,region&access_token=${MAPBOX_TOKEN}`);
    const feats: any[] = j?.features ?? [];
    const pick = (t: string) => feats.find(f => (f.place_type ?? []).includes(t))?.text ?? null;
    const out = {
      punto: { lat, lon },
      indirizzo: feats[0]?.place_name ?? null,
      via: pick("address"),
      quartiere: pick("neighborhood") ?? pick("locality"),
      comune: pick("place"),
      regione: pick("region"),
      fonte: "mapbox/geocoding",
    };
    putCache(key, out);
    res.json(out);
  } catch (err: any) {
    res.status(502).json({ error: "Territorio non disponibile", detail: err?.message });
  }
});

/* ── Cerca un luogo per nome ────────────────────────────────────────────
 * GET /api/ai/argos/territory/search?q=&near=lat,lon
 * "dov'è l'ospedale di Jesi?" → coordinate su cui poi ragionare. */
router.get("/ai/argos/territory/search", async (req: any, res: any) => {
  if (!requireToken(res)) return;
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.status(400).json({ error: "q richiesto" }); return; }
  const near = String(req.query.near ?? "").trim();
  const [nLat, nLon] = near.split(",").map(x => num(x));

  const key = `search:${q}|${near}`;
  const hit = cached(key);
  if (hit) { res.json({ ...hit, daCache: true }); return; }

  try {
    const prox = nLat != null && nLon != null ? `&proximity=${nLon},${nLat}` : "";
    const j = await mapbox(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`
      + `?language=it&limit=8&country=it${prox}&access_token=${MAPBOX_TOKEN}`);
    const out = {
      query: q,
      risultati: (j?.features ?? []).map((f: any) => ({
        nome: f.text, indirizzo: f.place_name,
        lat: f.center?.[1] ?? null, lon: f.center?.[0] ?? null,
        tipo: (f.place_type ?? []).join(","),
        rilevanza: f.relevance ?? null,
      })),
      fonte: "mapbox/geocoding",
    };
    putCache(key, out);
    res.json(out);
  } catch (err: any) {
    res.status(502).json({ error: "Ricerca non disponibile", detail: err?.message });
  }
});

/* ── Cosa c'è intorno ───────────────────────────────────────────────────
 * GET /api/ai/argos/territory/around?lat=&lon=&radius=&categories=
 * POI reali attorno a un punto. Risponde a "questa fermata serve
 * qualcosa?" con i luoghi che ci sono davvero, non con una stima. */
const CATEGORIE_NOTE: Record<string, string> = {
  scuola: "school,college,university",
  sanita: "hospital,clinic,pharmacy,doctor",
  lavoro: "office,industrial",
  commercio: "shopping,grocery,supermarket",
  servizi: "government,post,bank",
  trasporti: "bus,train station,parking",
};

router.get("/ai/argos/territory/around", async (req: any, res: any) => {
  if (!requireToken(res)) return;
  const lat = num(req.query.lat), lon = num(req.query.lon);
  if (lat == null || lon == null) { res.status(400).json({ error: "lat e lon richiesti" }); return; }
  const radius = Math.min(2000, Math.max(100, num(req.query.radius) ?? 500));
  const gruppo = String(req.query.categories ?? "").trim();

  const key = `around:${lat.toFixed(5)},${lon.toFixed(5)},${radius},${gruppo}`;
  const hit = cached(key);
  if (hit) { res.json({ ...hit, daCache: true }); return; }

  try {
    /* Tilequery interroga i tile vettoriali: sono gli stessi dati che si
     * vedono sulla mappa, quindi quello che l'agente descrive coincide con
     * quello che l'utente ha davanti. */
    const j = await mapbox(
      `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lon},${lat}.json`
      + `?radius=${radius}&limit=50&dedupe&layers=poi_label&access_token=${MAPBOX_TOKEN}`);

    const filtro = CATEGORIE_NOTE[gruppo]?.split(",") ?? null;
    const poi = (j?.features ?? [])
      .map((f: any) => ({
        nome: f.properties?.name ?? null,
        categoria: f.properties?.category_en ?? f.properties?.type ?? null,
        classe: f.properties?.class ?? null,
        distanzaM: f.properties?.tilequery?.distance != null
          ? Math.round(f.properties.tilequery.distance) : null,
        lat: f.geometry?.coordinates?.[1] ?? null,
        lon: f.geometry?.coordinates?.[0] ?? null,
      }))
      .filter((x: any) => x.nome)
      .filter((x: any) => !filtro || filtro.some(c =>
        String(x.categoria ?? "").toLowerCase().includes(c) ||
        String(x.classe ?? "").toLowerCase().includes(c)))
      .sort((a: any, b: any) => (a.distanzaM ?? 9999) - (b.distanzaM ?? 9999));

    const out = {
      punto: { lat, lon }, raggioM: radius,
      gruppo: gruppo || "tutti",
      totale: poi.length,
      poi: poi.slice(0, 40),
      // Se il gruppo chiesto non esiste va detto, altrimenti "0 risultati"
      // verrebbe letto come "non c'è niente" invece che "filtro sbagliato".
      avviso: gruppo && !CATEGORIE_NOTE[gruppo]
        ? `Gruppo "${gruppo}" sconosciuto: usa uno tra ${Object.keys(CATEGORIE_NOTE).join(", ")}.`
        : undefined,
      fonte: "mapbox/tilequery",
    };
    putCache(key, out);
    res.json(out);
  } catch (err: any) {
    res.status(502).json({ error: "Dati sul territorio non disponibili", detail: err?.message });
  }
});

/* ── Cosa si raggiunge a piedi ──────────────────────────────────────────
 * GET /api/ai/argos/territory/reach?lat=&lon=&minutes=5,10,15
 * L'isocrona pedonale: "chi scende qui, dove arriva in 10 minuti".
 * È la misura vera dell'accessibilità di una fermata, molto più del
 * raggio in linea d'aria che ignora fiumi, ferrovie e strade chiuse. */
router.get("/ai/argos/territory/reach", async (req: any, res: any) => {
  if (!requireToken(res)) return;
  const lat = num(req.query.lat), lon = num(req.query.lon);
  if (lat == null || lon == null) { res.status(400).json({ error: "lat e lon richiesti" }); return; }
  const minutes = String(req.query.minutes ?? "5,10,15")
    .split(",").map(x => num(x)).filter((n): n is number => n != null && n > 0 && n <= 60)
    .slice(0, 4);
  if (minutes.length === 0) { res.status(400).json({ error: "minutes non valido" }); return; }

  const key = `reach:${lat.toFixed(5)},${lon.toFixed(5)},${minutes.join("-")}`;
  const hit = cached(key);
  if (hit) { res.json({ ...hit, daCache: true }); return; }

  try {
    const j = await mapbox(
      `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon},${lat}`
      + `?contours_minutes=${minutes.join(",")}&polygons=true&denoise=0.5&access_token=${MAPBOX_TOKEN}`);

    const out = {
      punto: { lat, lon },
      isocrone: (j?.features ?? []).map((f: any) => {
        const ring: number[][] = f.geometry?.coordinates?.[0] ?? [];
        // Area approssimata: basta per dire "quanto quartiere si copre"
        let area = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        }
        const kmqApprox = Math.abs(area / 2) * 111 * 111 * Math.cos(lat * Math.PI / 180);
        return {
          minuti: f.properties?.contour ?? null,
          areaKmq: +kmqApprox.toFixed(2),
          // Contorno alleggerito: serve a ragionare, non a disegnare
          contorno: ring.filter((_, i) => i % Math.max(1, Math.ceil(ring.length / 30)) === 0)
            .map(c => [+Number(c[0]).toFixed(5), +Number(c[1]).toFixed(5)]),
        };
      }),
      modo: "a piedi",
      fonte: "mapbox/isochrone",
    };
    putCache(key, out);
    res.json(out);
  } catch (err: any) {
    res.status(502).json({ error: "Isocrone non disponibili", detail: err?.message });
  }
});

/* ── Che cosa so fare ───────────────────────────────────────────────────
 * Un agente deve poter scoprire le proprie capacità senza che siano
 * cablate nel suo prompt. */
router.get("/ai/argos/territory", (_req: any, res: any) => {
  res.json({
    disponibile: !!MAPBOX_TOKEN,
    capacita: [
      { rotta: "/api/ai/argos/territory/place", descrizione: "Indirizzo, quartiere e comune di un punto", parametri: "lat, lon" },
      { rotta: "/api/ai/argos/territory/search", descrizione: "Cerca un luogo per nome", parametri: "q, near=lat,lon" },
      { rotta: "/api/ai/argos/territory/around", descrizione: "POI reali entro un raggio", parametri: `lat, lon, radius (m), categories=${Object.keys(CATEGORIE_NOTE).join("|")}` },
      { rotta: "/api/ai/argos/territory/reach", descrizione: "Isocrone pedonali", parametri: "lat, lon, minutes=5,10,15" },
    ],
    nota: MAPBOX_TOKEN
      ? "Dati cartografici Mapbox mediati dal server: il token non viene mai esposto."
      : "MAPBOX_ACCESS_TOKEN non configurato: le rotte rispondono 503.",
  });
});

export default router;
