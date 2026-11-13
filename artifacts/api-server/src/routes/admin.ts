import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/auth";
import { GIORNI_MAX, Parametri, leggiRegistro, statoRegistro } from "../lib/registro-modifiche";
import { DatiAzienda, dettaglioAzienda, erroriDiValidazione, salvaAzienda } from "../lib/azienda";
import { RUOLI, rigaChiesta, type RuoloAziendale } from "@workspace/permessi";
import { salvaDirittiDelRuolo, statoDeiRuoli } from "../lib/matrice-ruoli";
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
 * ambito che non è una persona), limite, cursore (`da` compreso, `a` escluso). Ogni altro parametro è un
 * errore: il registro non si filtra né si ordina per persona.
 * La lettura passa da registro.leggi(), che annota la consultazione.
 */
router.use("/admin/registro", requireAdmin);
router.get("/admin/registro", async (req, res): Promise<void> => {
  const p = Parametri.safeParse(req.query);
  if (!p.success) {
    const estranei = p.error.issues.filter((i) => i.code === "unrecognized_keys").flatMap((i: any) => i.keys as string[]);
    // un tentativo di leggere il registro in un modo non previsto (per persona): resta nel log, coi soli nomi dei parametri
    if (estranei.length) req.log?.warn?.({ parametri: estranei.map((k) => String(k).slice(0, 40)).slice(0, 10), utente: req.user?.id }, "registro delle modifiche: parametro non ammesso");
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
      if (!(giorni > 0) || giorni > GIORNI_MAX) { res.status(400).json({ error: "Il periodo va da un giorno prima a uno dopo, 92 giorni al più" }); return; }
    }
    const pagina = await leggiRegistro(p.data);
    if ("errore" in pagina) { res.status(400).json({ error: pagina.errore }); return; }
    res.json({ stato, ...pagina });
  } catch (e: any) {
    // classe 22: un limite della funzione (periodo, righe, una data fuori scala) che la validazione qui sopra non ha fermato
    const codice = String(e?.code ?? e?.cause?.code ?? "");
    if (codice.startsWith("22")) { res.status(400).json({ error: "Richiesta fuori dai limiti del registro" }); return; }
    // 57014: la lettura ha superato il tempo massimo
    if (codice === "57014") { res.status(400).json({ error: "La ricerca è troppo ampia: scegli una tabella o un periodo più stretto" }); return; }
    req.log?.error?.({ err: e?.message }, "registro delle modifiche non leggibile");
    res.status(500).json({ error: "Registro non leggibile" });
  }
});

/**
 * GET e PUT /api/admin/azienda — i dati dell'azienda (PR 2.17a, lib/azienda.ts).
 * Li legge chiunque sia entrato, con la sessione (/api/auth/me); qui c'è la
 * pagina dell'amministratore: la riga con chi l'ha salvata e quando, e il
 * salvataggio. Solo admin, mai un token di Argos (requireAdmin). Un campo che
 * non è fra quelli previsti è un errore.
 */
router.use("/admin/azienda", requireAdmin);
router.get("/admin/azienda", async (req, res): Promise<void> => {
  try {
    res.json(await dettaglioAzienda());
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "dati dell'azienda non leggibili");
    res.status(500).json({ error: "Dati dell'azienda non leggibili" });
  }
});
router.put("/admin/azienda", async (req, res): Promise<void> => {
  const p = DatiAzienda.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try {
    res.json(await salvaAzienda(p.data, req.user?.id ?? null));
  } catch (e: any) {
    /* 23514: un vincolo della tabella che la validazione qui sopra non ha fermato */
    const codice = String(e?.code ?? e?.cause?.code ?? "");
    if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
    req.log?.error?.({ err: e?.message }, "dati dell'azienda non salvati");
    res.status(500).json({ error: "Dati dell'azienda non salvati" });
  }
});

/**
 * GET /api/admin/ruoli e PUT /api/admin/ruoli/:ruolo — che cosa dà ogni ruolo
 * aziendale (PR 2.18, lib/matrice-ruoli.ts). Solo admin, mai un token di Argos
 * (requireAdmin): è chi può fare che cosa.
 *
 * Il PUT prende `{ diritti }` con TUTTE le aree, ognuna "S", "L" o null: un
 * ruolo che non c'è, un'area in più o in meno, un livello diverso sono un
 * errore. I ruoli sono quelli del codice: da qui non se ne creano e non se ne
 * tolgono. L'amministratore di sistema non è un ruolo e non si tocca.
 */
router.use("/admin/ruoli", requireAdmin);
router.get("/admin/ruoli", async (req, res): Promise<void> => {
  try {
    res.json(await statoDeiRuoli());
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "ruoli non leggibili");
    res.status(500).json({ error: "Ruoli non leggibili" });
  }
});
router.put("/admin/ruoli/:ruolo", async (req, res): Promise<void> => {
  const ruolo = String(req.params.ruolo ?? "");
  if (!(RUOLI as readonly string[]).includes(ruolo)) { res.status(404).json({ error: "Ruolo sconosciuto" }); return; }
  const corpo = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : null;
  const estranei = corpo ? Object.keys(corpo).filter(k => k !== "diritti") : [];
  if (!corpo || estranei.length) {
    res.status(400).json({ error: estranei.length ? `Campo non previsto: ${estranei.slice(0, 5).map(k => k.slice(0, 40)).join(", ")}` : "Richiesta non valida" });
    return;
  }
  const chiesta = rigaChiesta(corpo.diritti);
  if ("errore" in chiesta) { res.status(400).json({ error: chiesta.errore }); return; }
  try {
    const esito = await salvaDirittiDelRuolo(ruolo as RuoloAziendale, chiesta.diritti, req.user?.id ?? null);
    /* resta nel log dell'applicazione, oltre che nel registro delle modifiche: senza nomi né valori */
    req.log?.info?.({ ruolo, ...esito, utente: req.user?.id }, "diritti di un ruolo cambiati");
    res.json({ ...(await statoDeiRuoli()), esito });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, ruolo }, "diritti del ruolo non salvati");
    res.status(500).json({ error: "Diritti del ruolo non salvati" });
  }
});

export default router;
