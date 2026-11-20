/**
 * La polimetrica della bigliettazione, da confrontare con quella generata
 * nella pagina Polimetriche (tappa 6.34a).
 *
 * La polimetrica che sta nel sistema di bigliettazione invecchia; l'azienda
 * genera la sua e le confronta. Qui si carica quella della bigliettazione (due
 * CSV, lib/polimetrica-ufficiale.ts) e si dice a quale linea dell'azienda
 * corrisponde ogni sua linea. Il confronto punto per punto è la tappa dopo.
 *
 *   GET    /api/fares/polimetriche/ufficiale?importId=    — caricamento, linee, proposte di abbinamento
 *   POST   /api/fares/polimetriche/ufficiale              — carica i due CSV (campi «punti» e «polimetrica»)
 *   DELETE /api/fares/polimetriche/ufficiale              — toglie la polimetrica caricata
 *   PUT    /api/fares/polimetriche/ufficiale/abbinamenti  — le decisioni sulle linee
 *
 * Sotto /fares: le apre chi ha l'area Tariffe, e le scritture chi può scriverla.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { z } from "zod";
import { strictLimiter } from "../middlewares/rate-limit";
import { legaContesto } from "../lib/contesto-http";
import { candidateDellaLinea, leggiCsvPunti, leggiCsvRighe, type LineaAzienda } from "../lib/polimetrica-ufficiale";
import {
  caricaUfficiale, caricamento, eliminaUfficiale, lineeDellImport, lineeUfficiali, puntiPerLinea, salvaAbbinamenti,
} from "../lib/polimetrica-ufficiale-store";

const router: IRouter = Router();

/* due file di testo: la polimetrica di un consorzio intero sta in un paio di MB */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 2, fields: 4 } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Il testo di un file caricato: UTF-8, o Latin-1 se non lo è (un export fatto su Windows). */
function testoDelFile(b: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { return b.toString("latin1"); }
}

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/ufficiale?importId=
 *
 *  Con l'import: per ogni linea della bigliettazione le linee dell'import
 *  dove si ritrovano i suoi punti e, se una spicca, la proposta; e le linee
 *  dell'import a cui non è abbinata nessuna linea della bigliettazione.
 * ───────────────────────────────────────────────────────────── */
router.get("/fares/polimetriche/ufficiale", async (req, res): Promise<void> => {
  const importId = typeof req.query.importId === "string" ? req.query.importId : null;
  if (importId && !UUID.test(importId)) { res.status(400).json({ error: "import non valido" }); return; }
  try {
    const [stato, linee] = await Promise.all([caricamento(), lineeUfficiali()]);
    let aziendali: LineaAzienda[] = [];
    if (importId) {
      const trovate = await lineeDellImport(importId);
      if (!trovate) { res.status(404).json({ error: "Import non trovato" }); return; }
      aziendali = trovate;
    }
    const punti = aziendali.length ? await puntiPerLinea() : new Map();
    const abbinate = new Set(linee.map((l) => l.abbinata).filter((x): x is string => x != null));
    res.json({
      caricamento: stato,
      linee: linee.map((l) => ({
        ...l,
        ...(aziendali.length ? candidateDellaLinea(l.linea, punti.get(l.linea) ?? [], aziendali) : { candidate: [], proposta: null, motivo: null }),
      })),
      lineeAzienda: aziendali.map((l) => ({ codice: l.codice, nome: l.nome })),
      senzaUfficiale: aziendali.filter((l) => !abbinate.has(l.codice)).map((l) => ({ codice: l.codice, nome: l.nome })),
    });
  } catch (e) {
    req.log.error({ err: e }, "polimetrica della bigliettazione non leggibile");
    res.status(500).json({ error: "Polimetrica della bigliettazione non leggibile" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  POST /api/fares/polimetriche/ufficiale
 *
 *  I due file insieme, campi «punti» e «polimetrica». O entrano tutti e due
 *  o resta quello che c'era. Gli abbinamenti delle linee non si toccano.
 * ───────────────────────────────────────────────────────────── */
router.post("/fares/polimetriche/ufficiale", strictLimiter,
  legaContesto(upload.fields([{ name: "punti", maxCount: 1 }, { name: "polimetrica", maxCount: 1 }])),
  async (req, res): Promise<void> => {
    const file = req.files as Record<string, Express.Multer.File[]> | undefined;
    const filePunti = file?.punti?.[0], fileRighe = file?.polimetrica?.[0];
    if (!filePunti || !fileRighe) {
      res.status(400).json({ error: "Servono due file CSV: i punti tariffari (campo «punti») e la polimetrica (campo «polimetrica»)." });
      return;
    }
    const punti = leggiCsvPunti(testoDelFile(filePunti.buffer));
    if (punti.errori.length) { res.status(400).json({ error: `Il file dei punti tariffari non va: ${punti.errori.join("; ")}` }); return; }
    const righe = leggiCsvRighe(testoDelFile(fileRighe.buffer));
    if (righe.errori.length) { res.status(400).json({ error: `Il file della polimetrica non va: ${righe.errori.join("; ")}` }); return; }
    try {
      await caricaUfficiale(punti.righe, righe.righe, { filePunti: filePunti.originalname, fileRighe: fileRighe.originalname, utenteId: req.user?.id ?? null });
      const linee = new Set([...punti.righe.map((p) => p.linea), ...righe.righe.map((r) => r.linea)]).size;
      req.log.info({ punti: punti.righe.length, righe: righe.righe.length, linee, da: req.user?.id }, "polimetrica della bigliettazione caricata");
      res.json({ punti: punti.righe.length, righe: righe.righe.length, linee, puntiSenzaKm: punti.saltate });
    } catch (e) {
      req.log.error({ err: e }, "caricamento della polimetrica della bigliettazione non riuscito");
      res.status(500).json({ error: "Caricamento non riuscito: resta la polimetrica di prima" });
    }
  });

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/ufficiale
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/ufficiale", async (req, res): Promise<void> => {
  try {
    await eliminaUfficiale();
    req.log.info({ da: req.user?.id }, "polimetrica della bigliettazione tolta");
    res.json({ ok: true });
  } catch (e) {
    req.log.error({ err: e }, "polimetrica della bigliettazione non tolta");
    res.status(500).json({ error: "Non riuscito: la polimetrica è ancora quella di prima" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  PUT /api/fares/polimetriche/ufficiale/abbinamenti
 *
 *  Per ogni linea della bigliettazione: la linea dell'import a cui
 *  corrisponde, oppure esclusa, oppure di nuovo da abbinare (né l'una né
 *  l'altra). Le linee nominate devono esistere: quella della bigliettazione
 *  fra le caricate, quella dell'azienda nell'import.
 * ───────────────────────────────────────────────────────────── */
const SENZA_CONTROLLI = /^[^\u0000-\u001f\u007f]+$/;
const Abbinamenti = z.object({
  importId: z.string().regex(UUID),
  abbinamenti: z.array(z.object({
    lineaUfficiale: z.string().trim().min(1).max(40).regex(SENZA_CONTROLLI),
    linea: z.string().trim().min(1).max(64).regex(SENZA_CONTROLLI).nullable(),
    esclusa: z.boolean(),
  }).strict()).min(1).max(2000),
}).strict();

router.put("/fares/polimetriche/ufficiale/abbinamenti", async (req, res): Promise<void> => {
  const p = Abbinamenti.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Richiesta non valida: per ogni linea servono lineaUfficiale, linea (o null) ed esclusa" }); return; }
  if (p.data.abbinamenti.some((a) => a.esclusa && a.linea != null)) { res.status(400).json({ error: "Una linea è abbinata oppure esclusa, non tutte e due" }); return; }
  try {
    const [ufficiali, aziendali] = await Promise.all([lineeUfficiali(), lineeDellImport(p.data.importId)]);
    if (!aziendali) { res.status(404).json({ error: "Import non trovato" }); return; }
    const caricate = new Set(ufficiali.map((l) => l.linea));
    const delImport = new Set(aziendali.map((l) => l.codice));
    for (const a of p.data.abbinamenti) {
      if (!caricate.has(a.lineaUfficiale.toUpperCase())) { res.status(400).json({ error: `La linea «${a.lineaUfficiale}» non è nella polimetrica caricata` }); return; }
      if (a.linea != null && !delImport.has(a.linea)) { res.status(400).json({ error: `La linea «${a.linea}» non è fra le linee dell'import` }); return; }
    }
    await salvaAbbinamenti(p.data.abbinamenti, req.user?.id ?? null);
    res.json({ ok: true, salvate: p.data.abbinamenti.length });
  } catch (e) {
    req.log.error({ err: e }, "abbinamenti delle linee non salvati");
    res.status(500).json({ error: "Abbinamenti non salvati" });
  }
});

export default router;
