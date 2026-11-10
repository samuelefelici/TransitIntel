import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/auth";
import { Parametri, leggiRegistro, statoRegistro } from "../lib/registro-modifiche";
import { syncPoiFromOsm, syncPoiFromGoogle, syncTrafficFromTomTom, syncCensusFromIstat, syncCommutingOdFromIstat } from "./cron.js";

const router: IRouter = Router();

// Sync distruttivi (wipe POI, TRUNCATE ISTAT, billing Google Places): solo admin.
router.use("/admin/sync", requireAdmin);

// Simple in-memory rate limit: one sync at a time, cooldown 60s
const cooldown: Record<string, number> = {};
const COOLDOWN_MS = 60_000;

function checkCooldown(key: string): { ok: boolean; remaining: number } {
  const last = cooldown[key] ?? 0;
  const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - last));
  return { ok: remaining === 0, remaining: Math.ceil(remaining / 1000) };
}
function setCooldown(key: string) {
  cooldown[key] = Date.now();
}

const ALLOWED_SOURCES = ["google-poi", "poi", "traffic", "census", "commuting"] as const;
const STATUS_SOURCES = [...ALLOWED_SOURCES];

/**
 * POST /api/admin/sync/:source
 */
router.post("/admin/sync/:source", async (req, res) => {
  const { source } = req.params as { source: string };
  if (!ALLOWED_SOURCES.includes(source as any)) {
    res.status(400).json({ error: `Unknown source. Use: ${ALLOWED_SOURCES.join(", ")}` });
    return;
  }

  const cd = checkCooldown(source);
  if (!cd.ok) {
    res.status(429).json({ error: `Cooldown attivo. Riprova tra ${cd.remaining}s.` });
    return;
  }

  setCooldown(source);

  try {
    let result: Record<string, any> = {};

    if (source === "google-poi") {
      result = await syncPoiFromGoogle();
    } else if (source === "poi") {
      result = await syncPoiFromOsm();
    } else if (source === "traffic") {
      result = await syncTrafficFromTomTom();
    } else if (source === "census") {
      result = await syncCensusFromIstat();
    } else if (source === "commuting") {
      result = await syncCommutingOdFromIstat();
    }

    res.json({ success: true, source, ...result });
  } catch (err: any) {
    req.log.error(err, `Error syncing ${source}`);
    res.status(500).json({ success: false, source, message: err.message ?? "Errore interno" });
  }
});

/**
 * GET /api/admin/sync/status
 */
router.get("/admin/sync/status", (_req, res) => {
  const status: Record<string, any> = {};
  for (const source of STATUS_SOURCES) {
    const cd = checkCooldown(source);
    const last = cooldown[source];
    status[source] = {
      ready: cd.ok,
      cooldownRemaining: cd.remaining,
      lastSync: last ? new Date(last).toISOString() : null,
    };
  }
  res.json(status);
});

/**
 * GET /api/admin/registro — il registro delle modifiche (PR 2.11).
 * Solo admin (mai un token di Argos: requireAdmin li rifiuta). Parametri: da,
 * a (istanti ISO), tabella, operazione, ambitoTipo, ambitoId (solo con un
 * ambito che non è una persona), limite, cursore. Ogni altro parametro è un
 * errore: il registro non si filtra né si ordina per persona.
 * La lettura passa da registro.leggi(), che annota la consultazione.
 */
router.use("/admin/registro", requireAdmin);
router.get("/admin/registro", async (req, res): Promise<void> => {
  const p = Parametri.safeParse(req.query);
  if (!p.success) {
    const estranei = p.error.issues.filter((i) => i.code === "unrecognized_keys").flatMap((i: any) => i.keys as string[]);
    res.status(400).json({
      error: estranei.length
        ? `Parametro non ammesso: ${estranei.join(", ")}. Il registro si filtra per periodo, tabella, operazione e ambito, non per persona`
        : `Parametri non validi: ${p.error.issues.map((i) => `${i.path.join(".") || "richiesta"} (${i.message})`).join("; ")}`,
    });
    return;
  }
  try {
    const stato = await statoRegistro();
    if (p.data.tabella && !stato.tabelle.some((t) => t.tabella === p.data.tabella)) {
      res.status(400).json({ error: "Questa tabella non è sorvegliata dal registro" });
      return;
    }
    if (p.data.da && p.data.a) {
      const giorni = (Date.parse(p.data.a) - Date.parse(p.data.da)) / 86_400_000;
      if (!(giorni > 0) || giorni > 92) { res.status(400).json({ error: "Il periodo va da un giorno prima a uno dopo, 92 giorni al più" }); return; }
    }
    const pagina = await leggiRegistro(p.data);
    if ("errore" in pagina) { res.status(400).json({ error: pagina.errore }); return; }
    res.json({ stato, ...pagina });
  } catch (e: any) {
    // 22023: un limite della funzione (periodo, righe) che la validazione qui sopra non ha fermato
    if (e?.code === "22023" || e?.cause?.code === "22023") { res.status(400).json({ error: "Richiesta fuori dai limiti del registro" }); return; }
    req.log?.error?.({ err: e?.message }, "registro delle modifiche non leggibile");
    res.status(500).json({ error: "Registro non leggibile" });
  }
});

export default router;
