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
import { gestoriDalDatabase } from "./gestori-store";
import { versioniDelProgetto, type Versione } from "./versioni-pubblicate";
import { rigaDelProblema, verificaGtfs, type Gtfs, type EsitoVerifica } from "./gtfs-verifica";
import { csvOrariImpossibili, orariImpossibili } from "./orari-impossibili";
import { oggiDiRoma, scadutoIl } from "./periodo-di-servizio";
import type { ConteggiNetex } from "./netex";
import { validaNetex, type EsitoValidazione } from "./netex-validazione";
import { costruisciGtfs, netexDelGtfs, nomeFileNetex, zipDelGtfs, SenzaCodiceNetex } from "./gtfs-consegnabile";
import { conLeTariffe, type TariffeDelGtfs } from "./gtfs-tariffe";

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

/** Il GTFS con le tariffe (tappa 6.37) e la sua verifica, con gli avvisi delle tariffe. */
async function costruisciEVerifica(progetto: any, fonte: Versione): Promise<{ gtfs: Gtfs; verifica: EsitoVerifica; tariffe: TariffeDelGtfs["conteggi"] }> {
  const azienda = await leggiAzienda();
  const orari = await costruisciGtfs(fonte.id, progetto, azienda, fonte.quale, await gestoriDalDatabase());
  const { gtfs, tariffe } = await conLeTariffe(fonte.id, orari);
  const verifica = verificaGtfs(gtfs);
  verifica.avvisi.push(...tariffe.avvisi);
  return { gtfs, verifica, tariffe: tariffe.conteggi };
}

/* GET …/export-gtfs/verifica — il controllo del file che si esporterebbe */
router.get("/planning-studio/projects/:id/export-gtfs/verifica", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const { gtfs, verifica, tariffe } = await costruisciEVerifica(pv.progetto, pv.fonte);
    res.json({
      versione: pv.fonte,
      righe: Object.fromEntries(Object.entries(gtfs).map(([f, x]) => [f, x.righe.length])),
      tariffe,
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
    /* le tratte con un orario impossibile (tappa 6.44): con più di zero la pagina offre l'elenco da scaricare */
    res.setHeader("X-Gtfs-Orari-Impossibili", String(verifica.avvisi.find((a) => a.codice === "velocita_impossibile")?.quante ?? 0));
    /* i primi avvisi, per dirli a chi scarica senza rifare il controllo; il periodo già finito per primo (tappa 6.45) */
    const inCima = [...verifica.avvisi].sort((a, b) => Number(b.codice === "file_scaduto") - Number(a.codice === "file_scaduto"));
    res.setHeader("X-Gtfs-Avvisi-Elenco", encodeURIComponent(
      inCima.slice(0, 5).map((a) => rigaDelProblema(a)).join(" · ").slice(0, 1500)));
    /* tutte le corse in giorni già passati: la pagina lo dice in cima (tappa 6.45) */
    res.setHeader("X-Programma-Scaduto", scadutoIl(gtfs, oggiDiRoma()) ?? "");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Gtfs-Versione, X-Gtfs-Avvisi, X-Gtfs-Errori, X-Gtfs-Avvisi-Elenco, X-Gtfs-Orari-Impossibili, X-Programma-Scaduto");
    res.send(zipDelGtfs(gtfs));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId: req.params.id }, "export GTFS fallito");
    res.status(500).json({ error: "Errore durante l'export GTFS" });
  }
});

/*
 * GET …/export-gtfs/orari-impossibili.csv — le tratte con un orario impossibile
 * del GTFS che si esporterebbe (tappa 6.44, lib/orari-impossibili.ts): linea,
 * corsa, fermate, orari, secondi, km, km/h e, se c'è, la corsa sana dello stesso
 * percorso da usare come riferimento in Percorrenze › «Ricalcola esistenti».
 * Solo lettura.
 */
router.get("/planning-studio/projects/:id/export-gtfs/orari-impossibili.csv", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const gtfs = await costruisciGtfs(pv.fonte.id, pv.progetto, await leggiAzienda(), pv.fonte.quale, await gestoriDalDatabase());
    const tratte = orariImpossibili(gtfs);
    const safeName = String(pv.progetto.name || "programma").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="orari-impossibili_${safeName}_${pv.fonte.quale}_${dateStr}.csv"`);
    res.setHeader("X-Orari-Impossibili", String(tratte.length));
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Orari-Impossibili");
    res.send(csvOrariImpossibili(tratte));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, projectId: req.params.id }, "elenco degli orari impossibili non riuscito");
    res.status(500).json({ error: "Errore durante l'elenco degli orari impossibili" });
  }
});

/* ── NeTEx, profilo italiano: livello 1 (tappa 6.2), livello 3 con le tariffe (6.40) ── */

/** Il livello chiesto: 3 con le tariffe; altrimenti 1, l'EPIP che legge il portale regionale (tappa 6.41). */
const livelloChiesto = (req: Request): 1 | 3 => (req.query.livello === "3" ? 3 : 1);

async function costruisciNetex(progetto: any, fonte: Versione, livello: 1 | 3): Promise<{
  xml: string; conteggi: ConteggiNetex; verifica: EsitoVerifica; validazione: EsitoValidazione; nome: string; scaduto: string | null;
}> {
  const azienda = await leggiAzienda();
  if (!azienda.netexCodiceLocale) throw new SenzaCodiceNetex();
  /* gli stessi gestori per il GTFS e per il NeTEx che ne nasce: gli operatori sono le agenzie */
  const gestori = await gestoriDalDatabase();
  const orari = await costruisciGtfs(fonte.id, progetto, azienda, fonte.quale, gestori);
  /* il livello 3 con le tariffe del GTFS (tappa 6.40); il livello 1 con i soli orari */
  const { gtfs, perNetex } = livello === 3
    ? await conLeTariffe(fonte.id, orari).then((t) => ({ gtfs: t.gtfs, perNetex: t.tariffe.perNetex }))
    : { gtfs: orari, perNetex: null };
  const { xml, conteggi } = netexDelGtfs(gtfs, azienda, gestori, new Date(), perNetex);
  return {
    xml, conteggi, verifica: verificaGtfs(gtfs), validazione: await validaNetex(xml), nome: nomeFileNetex(azienda, livello),
    scaduto: scadutoIl(gtfs, oggiDiRoma()),
  };
}

/** Le fermate fuori dal tracciato secondo il controllo del GTFS (tappa 6.43): al più 5, con la linea. */
export const fermateFuoriTracciato = (v: EsitoVerifica): string[] =>
  v.avvisi.filter((a) => a.codice === "fermata_lontana_dal_tracciato" || a.codice === "fermata_fuori_ordine_sul_tracciato")
    .flatMap((a) => a.esempi).slice(0, 5);

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
    const livello = livelloChiesto(req);
    const { conteggi, verifica, validazione } = await costruisciNetex(pv.progetto, pv.fonte, livello);
    res.json({ versione: pv.fonte, livello, conteggi, gtfs: verifica, validazione });
  } catch (e: any) { rispondiNetex(req, res, e, "verifica NeTEx fallita"); }
});

/*
 * GET …/export-netex — il file .xml.gz; livello=3 con le tariffe, altrimenti il
 * livello 1. Il nome come al portale regionale, col programma e la data:
 * IT-ITI3-ABC-NeTEx_L1_esercizio_20261120.xml.gz. Si ferma (422) se il GTFS da cui nasce
 * ha errori o se il NeTEx non passa lo schema del profilo italiano (EPIP, o
 * quello del livello 3 se ha le tariffe), a meno di forza=1; senza xmllint il
 * controllo dello schema non si fa e l'intestazione lo dice.
 */
router.get("/planning-studio/projects/:id/export-netex", async (req: Request, res: Response): Promise<void> => {
  try {
    const pv = await programmaEVersione(req, res);
    if (!pv) return;
    const livello = livelloChiesto(req);
    const { xml, conteggi, verifica, validazione, nome, scaduto } = await costruisciNetex(pv.progetto, pv.fonte, livello);
    const forza = req.query.forza === "1";
    if (!forza && verifica.errori.length > 0) {
      res.status(422).json({ error: "Il GTFS da cui nasce il NeTEx ha errori: correggili, oppure esporta forzando", versione: pv.fonte, gtfs: verifica });
      return;
    }
    if (!forza && validazione.stato === "non_valido") {
      res.status(422).json({ error: "Il NeTEx non passa lo schema del profilo italiano", versione: pv.fonte, validazione });
      return;
    }
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${nome}_${pv.fonte.quale}_${dateStr}.xml.gz"`);
    res.setHeader("X-Netex-Versione", pv.fonte.quale);
    res.setHeader("X-Netex-Validazione", validazione.stato);
    res.setHeader("X-Netex-Corse", String(conteggi.corse));
    res.setHeader("X-Netex-Livello", String(livello));
    /* le coppie di fermate senza tracciato (tappa 6.42): lì chi legge il file traccia una linea retta */
    res.setHeader("X-Netex-Tratte-Senza-Tracciato", String(conteggi.tratteSenzaTracciato));
    /* e quali fermate guardare (tappa 6.43): gli esempi degli avvisi del controllo sulle fermate fuori dal tracciato */
    res.setHeader("X-Netex-Fermate-Fuori-Tracciato", encodeURIComponent(fermateFuoriTracciato(verifica).join(" · ").slice(0, 1500)));
    /* tutte le corse in giorni già passati: la pagina lo dice in cima (tappa 6.45) */
    res.setHeader("X-Programma-Scaduto", scaduto ?? "");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Netex-Versione, X-Netex-Validazione, X-Netex-Corse, X-Netex-Livello, X-Netex-Tratte-Senza-Tracciato, X-Netex-Fermate-Fuori-Tracciato, X-Programma-Scaduto");
    res.send(gzipSync(Buffer.from(xml, "utf8")));
  } catch (e: any) { rispondiNetex(req, res, e, "export NeTEx fallito"); }
});

export default router;
