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
 * E, per una linea abbinata, i suoi punti tariffari sulle fermate (tappa 6.34b):
 *
 *   GET    /api/fares/polimetriche/ufficiale/linea?codice=&importId=  — percorsi, punti, righe, proposte e decisioni
 *   PUT    /api/fares/polimetriche/ufficiale/linea/punti              — la decisione su un percorso
 *   DELETE /api/fares/polimetriche/ufficiale/linea/punti?codice=&percorso=&direzione=  — torna la proposta
 *
 * Sotto /fares: le apre chi ha l'area Tariffe, e le scritture chi può scriverla.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { z } from "zod";
import { strictLimiter } from "../middlewares/rate-limit";
import { legaContesto } from "../lib/contesto-http";
import { candidateDellaLinea, leggiCsvPunti, leggiCsvRighe, percorsiCandidati, type LineaAzienda } from "../lib/polimetrica-ufficiale";
import {
  caricaUfficiale, caricamento, decisioniDeiPunti, dettaglioLinea, eliminaUfficiale, lineaAbbinata, lineeDellImport, lineeUfficiali,
  percorsiDellaLinea, puntiPerLinea, salvaAbbinamenti, salvaDecisionePunti, togliDecisionePunti,
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

/* ─────────────────────────────────────────────────────────────
 *  GET /api/fares/polimetriche/ufficiale/linea?codice=&importId=
 *
 *  Una linea della bigliettazione, per confrontarla: i suoi percorsi coi
 *  punti tariffari, le sue righe, e i percorsi della linea dell'azienda a
 *  cui è abbinata. Per ogni percorso della bigliettazione i percorsi
 *  dell'azienda dove si ritrovano i suoi punti (nei due versi, il migliore
 *  per primo) e la decisione salvata, se c'è.
 * ───────────────────────────────────────────────────────────── */
const codiceDiLinea = (v: unknown): string | null => {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  return t && t.length <= 40 && SENZA_CONTROLLI.test(t) ? t : null;
};

router.get("/fares/polimetriche/ufficiale/linea", async (req, res): Promise<void> => {
  const codice = codiceDiLinea(req.query.codice);
  const importId = typeof req.query.importId === "string" ? req.query.importId : "";
  if (!codice) { res.status(400).json({ error: "manca la linea" }); return; }
  if (!UUID.test(importId)) { res.status(400).json({ error: "import non valido" }); return; }
  try {
    const [dettaglio, abbinata, decise] = await Promise.all([dettaglioLinea(codice), lineaAbbinata(codice), decisioniDeiPunti(codice)]);
    if (!dettaglio.percorsi.length && !dettaglio.righe.length) { res.status(404).json({ error: "La linea non è nella polimetrica caricata" }); return; }
    const aziendali = abbinata ? await percorsiDellaLinea(importId, abbinata) : await percorsiDellaLinea(importId, "");
    if (aziendali === null) { res.status(404).json({ error: "Import non trovato" }); return; }
    const perCandidati = aziendali.map((p) => ({ routeId: p.routeId, variantId: p.variantId, corse: p.corse, fermate: p.fermate }));
    res.json({
      linea: codice,
      abbinata,
      percorsi: dettaglio.percorsi.map((p) => {
        const deciso = decise.find((d) => d.percorso === p.percorso && d.direzione === p.direzione) ?? null;
        return {
          percorso: p.percorso, direzione: p.direzione,
          punti: p.punti.map((x) => ({ ordine: x.ordine, codice: x.codice, nome: x.nome, nodo: x.nodo, km: x.km })),
          candidati: percorsiCandidati(p.punti, perCandidati, 200),
          deciso: deciso && {
            routeId: deciso.routeId, variantId: deciso.variantId, verso: deciso.verso, punti: deciso.punti,
            /* il percorso scelto può non esserci più: un import nuovo dello stesso GTFS con un percorso cambiato */
            nellImport: aziendali.some((x) => x.routeId === deciso.routeId && x.variantId === deciso.variantId),
          },
        };
      }),
      righe: dettaglio.righe.map((r) => ({ percorso: r.percorso, direzione: r.direzione, da: r.da, a: r.a, km: r.km, tariffario: r.tariffario, fascia: r.fascia, forzata: r.forzata })),
      percorsiAzienda: aziendali,
    });
  } catch (e) {
    req.log.error({ err: e }, "linea della bigliettazione non leggibile");
    res.status(500).json({ error: "Linea non leggibile" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  PUT /api/fares/polimetriche/ufficiale/linea/punti
 *
 *  La decisione su un percorso della bigliettazione: il percorso
 *  dell'azienda, il verso, e per ogni punto la sua fermata (o nessuna).
 *  Tutto deve esistere: il percorso e i punti fra quelli caricati, il
 *  percorso dell'azienda nell'import, sotto la linea abbinata, e ogni
 *  fermata fra le sue.
 * ───────────────────────────────────────────────────────────── */
const DecisioneSuiPunti = z.object({
  importId: z.string().regex(UUID),
  lineaUfficiale: z.string().trim().min(1).max(40).regex(SENZA_CONTROLLI),
  percorso: z.string().min(1).max(40).regex(SENZA_CONTROLLI),
  direzione: z.string().min(1).max(10).regex(SENZA_CONTROLLI),
  routeId: z.string().min(1).max(200).regex(SENZA_CONTROLLI),
  variantId: z.string().min(1).max(64).regex(SENZA_CONTROLLI),
  verso: z.enum(["AB", "BA"]),
  punti: z.array(z.object({
    ordine: z.number().int().min(1).max(100_000),
    fermata: z.string().min(1).max(200).regex(SENZA_CONTROLLI).nullable(),
  }).strict()).max(2000),
}).strict();

router.put("/fares/polimetriche/ufficiale/linea/punti", async (req, res): Promise<void> => {
  const p = DecisioneSuiPunti.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Richiesta non valida: servono la linea, il percorso, la direzione, il percorso dell'azienda col verso e i punti con la loro fermata" }); return; }
  const d = p.data, linea = d.lineaUfficiale.toUpperCase();
  try {
    const [dettaglio, abbinata] = await Promise.all([dettaglioLinea(linea), lineaAbbinata(linea)]);
    const ufficiale = dettaglio.percorsi.find((x) => x.percorso === d.percorso && x.direzione === d.direzione);
    if (!ufficiale) { res.status(400).json({ error: "Questo percorso non è nella polimetrica caricata" }); return; }
    if (!abbinata) { res.status(409).json({ error: "Prima si abbina la linea a una linea dell'import" }); return; }
    const ordini = new Set(ufficiale.punti.map((x) => x.ordine));
    const visti = new Set<number>();
    for (const x of d.punti) {
      if (!ordini.has(x.ordine) || visti.has(x.ordine)) { res.status(400).json({ error: `Il punto ${x.ordine} non è fra i punti del percorso, o è ripetuto` }); return; }
      visti.add(x.ordine);
    }
    const aziendali = await percorsiDellaLinea(d.importId, abbinata);
    if (aziendali === null) { res.status(404).json({ error: "Import non trovato" }); return; }
    const scelto = aziendali.find((x) => x.routeId === d.routeId && x.variantId === d.variantId);
    if (!scelto) { res.status(400).json({ error: `Il percorso scelto non è fra quelli della linea ${abbinata} nell'import` }); return; }
    const fermate = new Set(scelto.fermate.map((f) => f.stopId));
    const fuori = d.punti.find((x) => x.fermata != null && !fermate.has(x.fermata));
    if (fuori) { res.status(400).json({ error: `La fermata «${fuori.fermata}» non è su quel percorso` }); return; }
    await salvaDecisionePunti(linea, { percorso: d.percorso, direzione: d.direzione, routeId: d.routeId, variantId: d.variantId, verso: d.verso, punti: d.punti }, req.user?.id ?? null);
    res.json({ ok: true });
  } catch (e) {
    req.log.error({ err: e }, "abbinamento dei punti non salvato");
    res.status(500).json({ error: "Abbinamento dei punti non salvato" });
  }
});

/* ─────────────────────────────────────────────────────────────
 *  DELETE /api/fares/polimetriche/ufficiale/linea/punti?codice=&percorso=&direzione=
 * ───────────────────────────────────────────────────────────── */
router.delete("/fares/polimetriche/ufficiale/linea/punti", async (req, res): Promise<void> => {
  const codice = codiceDiLinea(req.query.codice);
  const testo = (v: unknown, max: number) => (typeof v === "string" && v.length >= 1 && v.length <= max && SENZA_CONTROLLI.test(v) ? v : null);
  const percorso = testo(req.query.percorso, 40), direzione = testo(req.query.direzione, 10);
  if (!codice || !percorso || !direzione) { res.status(400).json({ error: "servono la linea, il percorso e la direzione" }); return; }
  try {
    await togliDecisionePunti(codice, percorso, direzione);
    res.json({ ok: true });
  } catch (e) {
    req.log.error({ err: e }, "abbinamento dei punti non tolto");
    res.status(500).json({ error: "Non riuscito" });
  }
});

export default router;
