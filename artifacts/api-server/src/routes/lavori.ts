/**
 * «I miei calcoli»: gli ultimi calcoli in coda di chi chiede, di tutti gli
 * ambiti (turni guida, turni macchina, giri di Argos, sincronizzazioni dei
 * feed), e lo stop. Solo i propri: un lavoro di un altro risponde come uno che
 * non c'è (404), anche all'admin, che ferma i calcoli altrui dalle rotte di
 * ciascun ambito. Niente richiesta né risultato: il risultato si legge dalla
 * rotta del suo ambito.
 */
import { Router, type IRouter } from "express";
import * as coda from "../lib/lavori/coda";
import { TUTTI_GLI_AMBITI } from "../lib/lavori/ambiti";
import { STATO_PUBBLICO } from "../lib/facciata-lavori";

const router: IRouter = Router();

/** I metadati che servono a riconoscere un calcolo; il resto (per esempio i parametri di un giro) resta fuori. */
const DETTAGLI = ["scenarioId", "scenarioName", "date", "mode", "projectId", "psProjectId", "schedulingProjectId", "budgetSec"] as const;

export function vistaLavoro(l: coda.RigaElenco) {
  const m = l.metadati ?? {};
  const dettagli: Record<string, unknown> = {};
  for (const k of DETTAGLI) if (m[k] != null) dettagli[k] = m[k];
  return {
    jobId: l.id,
    tipo: l.tipo,
    ambito: m.ambito ?? null,
    status: STATO_PUBBLICO[l.stato],
    /** stop chiesto, il calcolo non si è ancora fermato */
    stopping: l.stato === "in_corso" && l.annulla,
    corsia: l.corsia,
    progress: l.avanzamento ?? null,
    httpStatus: l.http_codice ?? null,
    error: l.errore ?? null,
    errorType: l.errore_tipo ?? null,
    createdAt: +l.creato_il,
    startedAt: l.iniziato_il ? +l.iniziato_il : null,
    finishedAt: l.finito_il ? +l.finito_il : null,
    updatedAt: +l.aggiornato_il,
    dettagli,
  };
}

/** GET /api/lavori?n=20 — i miei ultimi calcoli (al più 50), i più recenti prima. */
router.get("/lavori", async (req, res) => {
  try {
    const n = Number(req.query.n ?? 20);
    const righe = await coda.lavoriDi(req.user!.id, TUTTI_GLI_AMBITI, Number.isFinite(n) ? n : 20);
    res.set("Cache-Control", "no-store");
    res.json({ lavori: righe.map(vistaLavoro) });
  } catch (err: any) {
    req.log.error(err, "elenco dei calcoli");
    res.status(500).json({ error: "Errore nella lettura dei calcoli" });
  }
});

/** POST /api/lavori/:jobId/stop — ferma un mio calcolo in coda o in corso. */
router.post("/lavori/:jobId/stop", async (req, res) => {
  try {
    const l = await coda.leggi(String(req.params.jobId));
    const mio = !!l && l.utente_id === req.user!.id && (TUTTI_GLI_AMBITI as readonly string[]).includes(l.metadati?.ambito);
    if (!l || !mio) { res.status(404).json({ error: "Calcolo non trovato" }); return; }
    const esito = await coda.chiediAnnullamento(l.id);
    if (!esito) { res.status(400).json({ error: "Il calcolo è già finito" }); return; }
    req.log.info({ lavoro: l.id, ambito: l.metadati?.ambito }, "calcolo fermato dall'elenco");
    res.json({ jobId: l.id, status: esito === "fermato" ? "stopped" : "stopping" });
  } catch (err: any) {
    req.log.error(err, "stop del calcolo");
    res.status(500).json({ error: "Errore nello stop del calcolo" });
  }
});

export default router;
