/**
 * Planning Studio — Export GTFS
 *
 *   GET /api/planning-studio/projects/:id/export-gtfs?versione=&forza=1
 *       lo zip GTFS: stops, routes, trips, stop_times, calendar,
 *       calendar_dates, shapes, agency, feed_info;
 *   GET /api/planning-studio/projects/:id/export-gtfs/verifica?versione=
 *       il controllo dello stesso file, senza lo zip;
 *   GET /api/planning-studio/projects/:id/export-netex?versione=&forza=1
 *       lo stesso programma in NeTEx, profilo italiano livello 1 (EPIP), in
 *       .xml.gz (tappa 6.2, lib/netex.ts): si costruisce da questo GTFS e passa
 *       lo schema EPIP (lib/netex-validazione.ts);
 *   GET /api/planning-studio/projects/:id/export-netex/verifica?versione=
 *       i conteggi e i due controlli, senza il file.
 *
 * È il deliverable che l'ufficio programmazione consegna a Regione/osservatorio,
 * open data (NAP), fornitori AVM/bigliettazione. Dalla PR 3.4 è «consegnabile»:
 *  - DA QUALE VERSIONE: quella in esercizio del programma (la copia congelata
 *    della PR 3.3), o quella programmata, o la bozza (?versione=). Senza
 *    indicazione, quella in esercizio se c'è, altrimenti la bozza.
 *  - L'AZIENDA VERA: agency.txt e feed_info.txt dai dati di Amministrazione ›
 *    Azienda (ragione sociale, identificativo GTFS, sito, telefono). Prima
 *    agency_id era «1» e il nome quello del progetto. Senza dati dell'azienda,
 *    quelli del progetto, come prima.
 *  - CONTROLLATO: prima dello zip il file passa da lib/gtfs-verifica.ts. Con
 *    errori l'export si ferma (422, con l'elenco), a meno di forza=1; gli
 *    avvisi si contano nell'intestazione X-Gtfs-Avvisi.
 *
 * Il file lo costruisce lib/gtfs-consegnabile.ts (lì le scelte di mappatura);
 * qui stanno le rotte.
 *
 * Solo lettura: nessuna scrittura su DB.
 */
import type { Request, Response } from "express";
import { Router, type IRouter } from "express";
import { gzipSync } from "node:zlib";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { leggiAzienda } from "./azienda";
import { versioniDelProgetto, type Versione } from "./versioni-pubblicate";
import { verificaGtfs, type Gtfs, type EsitoVerifica } from "./gtfs-verifica";
import type { ConteggiNetex } from "./netex";
import { validaNetex, type EsitoValidazione } from "./netex-validazione";
import { costruisciGtfs, netexDelGtfs, zipDelGtfs, SenzaCodiceNetex } from "./gtfs-consegnabile";

export { aziendaDelGtfs, costruisciGtfs, gtfsInCsv } from "./gtfs-consegnabile";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

async function rows(q: any): Promise<any[]> {
  const r: any = await db.execute(q);
  return r.rows ?? r ?? [];
}

/**
 * Il programma (owner o membro: l'export non scrive, ma consegna il programma
 * fuori dall'azienda) e la versione da esportare: quella chiesta, altrimenti
 * quella in esercizio, altrimenti la bozza.
 */
async function programmaEVersione(req: Request, res: Response): Promise<{ progetto: any; fonte: Versione } | null> {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return null; }
  const projectId = String(req.params.id || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "ID progetto non valido" }); return null; }
  const projR = await rows(sql`
    SELECT p.*
      FROM ps_projects p
      LEFT JOIN ps_project_members pm ON pm.project_id = p.id AND pm.user_id = ${userId}::uuid
     WHERE p.id = ${projectId}::uuid AND p.versione_del_feed IS NULL
       AND (p.owner_user_id = ${userId}::uuid OR pm.user_id IS NOT NULL)
     LIMIT 1
  `);
  const progetto = projR[0];
  if (!progetto) { res.status(404).json({ error: "Progetto non trovato o non accessibile" }); return null; }
  const chiesta = String(req.query.versione ?? "");
  if (chiesta && !["esercizio", "programmata", "bozza"].includes(chiesta)) {
    res.status(400).json({ error: "versione: esercizio, programmata o bozza" }); return null;
  }
  const bozza: Versione = { id: projectId, quale: "bozza", dal: null };
  const v = await versioniDelProgetto(projectId);
  const fonte = chiesta === "bozza" ? bozza
    : chiesta === "esercizio" ? v.esercizio
    : chiesta === "programmata" ? v.programmata
    : (v.esercizio ?? bozza);
  if (!fonte) { res.status(404).json({ error: `Il programma non ha una versione ${chiesta}` }); return null; }
  return { progetto, fonte };
}

async function costruisciEVerifica(progetto: any, fonte: Versione): Promise<{ gtfs: Gtfs; verifica: EsitoVerifica }> {
  const azienda = await leggiAzienda();
  const gtfs = await costruisciGtfs(fonte.id, progetto, azienda, fonte.quale);
  return { gtfs, verifica: verificaGtfs(gtfs) };
}

/* GET …/export-gtfs/verifica — il controllo del file che si esporterebbe */
router.get("/planning-studio/projects/:id/export-gtfs/verifica", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { gtfs, verifica } = await costruisciEVerifica(pv.progetto, pv.fonte);
    res.json({
      versione: pv.fonte,
      righe: Object.fromEntries(Object.entries(gtfs).map(([f, x]) => [f, x.righe.length])),
      ...verifica,
    });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId: req.params.id }, "verifica GTFS fallita");
    res.status(500).json({ error: "Errore durante la verifica del GTFS" });
  }
});

router.get("/planning-studio/projects/:id/export-gtfs", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { gtfs, verifica } = await costruisciEVerifica(pv.progetto, pv.fonte);
    const forza = req.query.forza === "1";
    if (verifica.errori.length > 0 && !forza) {
      res.status(422).json({
        error: "Il GTFS ha errori che chi lo riceve non accetterebbe: correggili, oppure esporta forzando",
        versione: pv.fonte, ...verifica,
      });
      return;
    }

    /* ── invio ── */
    const safeName = String(pv.progetto.name || "programma").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="gtfs_${safeName}_${pv.fonte.quale}_${dateStr}.zip"`);
    res.setHeader("X-Gtfs-Versione", pv.fonte.quale);
    res.setHeader("X-Gtfs-Avvisi", String(verifica.avvisi.reduce((n, a) => n + a.quante, 0)));
    res.setHeader("X-Gtfs-Errori", String(verifica.errori.reduce((n, a) => n + a.quante, 0)));
    /* i primi avvisi, per dirli a chi scarica senza rifare il controllo */
    res.setHeader("X-Gtfs-Avvisi-Elenco", encodeURIComponent(
      verifica.avvisi.slice(0, 5).map((a) => `${a.messaggio} (${a.quante})`).join(" · ").slice(0, 1500)));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Gtfs-Versione, X-Gtfs-Avvisi, X-Gtfs-Errori, X-Gtfs-Avvisi-Elenco");
    res.send(zipDelGtfs(gtfs));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId: req.params.id }, "export GTFS fallito");
    res.status(500).json({ error: "Errore durante l'export GTFS" });
  }
});

/* ── NeTEx, profilo italiano livello 1 (tappa 6.2) ─────────────────────── */

async function costruisciNetex(progetto: any, fonte: Versione): Promise<{
  xml: string; conteggi: ConteggiNetex; verifica: EsitoVerifica; validazione: EsitoValidazione;
}> {
  const azienda = await leggiAzienda();
  if (!azienda.netexCodiceLocale) throw new SenzaCodiceNetex();
  const gtfs = await costruisciGtfs(fonte.id, progetto, azienda, fonte.quale);
  const { xml, conteggi } = netexDelGtfs(gtfs, azienda);
  return { xml, conteggi, verifica: verificaGtfs(gtfs), validazione: await validaNetex(xml) };
}

const rispondiNetex = (req: Request, res: Response, e: any, cosa: string) => {
  if (e instanceof SenzaCodiceNetex) { res.status(409).json({ error: e.message }); return; }
  req.log?.error?.({ err: e?.message, projectId: req.params.id }, cosa);
  res.status(500).json({ error: "Errore durante l'export NeTEx" });
};

/* GET …/export-netex/verifica — conteggi e controlli del NeTEx che si esporterebbe */
router.get("/planning-studio/projects/:id/export-netex/verifica", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { conteggi, verifica, validazione } = await costruisciNetex(pv.progetto, pv.fonte);
    res.json({ versione: pv.fonte, conteggi, gtfs: verifica, validazione });
  } catch (e: any) { rispondiNetex(req, res, e, "verifica NeTEx fallita"); }
});

/*
 * GET …/export-netex — il file .xml.gz. Si ferma (422) se il GTFS da cui nasce
 * ha errori o se il NeTEx non passa lo schema EPIP, a meno di forza=1; senza
 * xmllint il controllo dello schema non si fa e l'intestazione lo dice.
 */
router.get("/planning-studio/projects/:id/export-netex", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { xml, conteggi, verifica, validazione } = await costruisciNetex(pv.progetto, pv.fonte);
    const forza = req.query.forza === "1";
    if (!forza && verifica.errori.length > 0) {
      res.status(422).json({ error: "Il GTFS da cui nasce il NeTEx ha errori: correggili, oppure esporta forzando", versione: pv.fonte, gtfs: verifica });
      return;
    }
    if (!forza && validazione.stato === "non_valido") {
      res.status(422).json({ error: "Il NeTEx non passa lo schema EPIP del profilo italiano", versione: pv.fonte, validazione });
      return;
    }
    const safeName = String(pv.progetto.name || "programma").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="netex_${safeName}_${pv.fonte.quale}_${dateStr}.xml.gz"`);
    res.setHeader("X-Netex-Versione", pv.fonte.quale);
    res.setHeader("X-Netex-Validazione", validazione.stato);
    res.setHeader("X-Netex-Corse", String(conteggi.corse));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Netex-Versione, X-Netex-Validazione, X-Netex-Corse");
    res.send(gzipSync(Buffer.from(xml, "utf8")));
  } catch (e: any) { rispondiNetex(req, res, e, "export NeTEx fallito"); }
});

export default router;
