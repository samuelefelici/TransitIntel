import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/auth";
import { GIORNI_MAX, Parametri, leggiRegistro, statoRegistro } from "../lib/registro-modifiche";
import { DatiAzienda, dettaglioAzienda, erroriDiValidazione, leggiAzienda, salvaAzienda } from "../lib/azienda";
import { cancellaVoce, creaVoce, elencoVoci, ModificaVoce, modificaVoce, NuovaVoce, RifiutoVoci } from "../lib/roster-voci";
import {
  cancellaComune, cancellaLuogo, creaLuogo, DatiComune, DatiLuogo, elencoTerritorio, modificaLuogo, RifiutoTerritorio, salvaComune,
} from "../lib/territorio";
import { impostaAttivi, preparaDatiAperti, statoDatiAperti } from "../lib/dati-aperti";
import { cancellaDeposito, creaDeposito, elencoDepositi, ModificaDeposito, modificaDeposito, NuovoDeposito, RifiutoDepositi } from "../lib/depositi";
import { anteprimaRegole, cancellaRete, creaRete, elencoReti, ModificaRete, modificaRete, NuovaRete, Regole, RifiutoReti, salvaRegole } from "../lib/reti";
import { elencoFasce, Fasce, RifiutoFasce, salvaFasce } from "../lib/fasce-km-store";
import { Categorie, elenchiTariffe, erroreElenco, RifiutoElenchi, salvaCategorie, salvaSupporti, Supporti } from "../lib/elenchi-tariffe-store";
import { TIPI_SUPPORTO } from "../lib/elenchi-tariffe";
import { cancellaGestore, creaGestore, elencoGestori, erroreGestore, ModificaGestore, modificaGestore, NuovoGestore, RifiutoGestori } from "../lib/gestori-store";
import { agenziaDellAzienda } from "../lib/gestori";
import { cancellaNodo, creaNodo, DatiNodo, elencoNodi, IDENTIFICATIVO_NODO, modificaNodo, NuovoNodo, RifiutoNodi } from "../lib/nodi-scambio-store";
import { statoDellInstallazione } from "../lib/installazione";
import { cancellaTitolo, creaTitolo, elencoTitoli, ModificaTitolo, modificaTitolo, NuovoTitolo, RifiutoTitoli } from "../lib/titoli-catalogo";
import { RUOLI, rigaChiesta, type RuoloAziendale } from "@workspace/permessi";
import { salvaDirittiDelRuolo, statoDeiRuoli } from "../lib/matrice-ruoli";
import { diagnosiDelGiorno } from "../lib/esercizio-diagnosi";
import { elencoGiornate, giornoValido, leggiGiornata, preparaGiornata } from "../lib/esercizio-giornate";
import { calcolaProposta, RifiutoProposta } from "../lib/esercizio-proposta";
import { elencoCausali, salvaCausale, RifiutoGiornale } from "../lib/esercizio-giornale";
import { chiudiMese, meseValido, riapriGiornata, riapriMese, RifiutoChiusura } from "../lib/esercizio-chiusura";
import { getLatestFeedId } from "./gtfs-helpers";
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
 * GET /api/admin/esercizio/diagnosi?giorno=AAAA-MM-GG — la diagnosi di una
 * giornata di esercizio, in sola lettura (tappa 4, lib/esercizio-diagnosi.ts).
 * Il feed dell'AVM è quello su cui l'aggancio lavora oggi: GTFS_FEED_ID, o
 * l'ultimo feed, come siri-ingest.
 */
router.use("/admin/esercizio", requireAdmin);
router.get("/admin/esercizio/diagnosi", async (req, res): Promise<void> => {
  const giorno = String(req.query.giorno ?? "");
  const t = /^\d{4}-\d{2}-\d{2}$/.test(giorno) ? Date.parse(`${giorno}T00:00:00Z`) : NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== giorno || giorno < "2000-01-01" || giorno > "2099-12-31") {
    res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" });
    return;
  }
  try {
    const feedAvm = process.env.GTFS_FEED_ID || (await getLatestFeedId());
    res.json(await diagnosiDelGiorno(giorno, feedAvm ?? null));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, giorno }, "diagnosi della giornata non riuscita");
    res.status(500).json({ error: "Diagnosi non riuscita" });
  }
});

/**
 * Le giornate di esercizio, il programmato congelato (tappa 4.2,
 * lib/esercizio-giornate.ts). Le prepara e le congela il lavoratore; qui si
 * leggono, e l'amministratore può preparare una giornata che manca (una
 * passata nasce congelata e «ricostruita»). Dalla 4.3 ogni giornata porta
 * anche i turni pubblicati: turno macchina, turno guida e deposito per corsa,
 * i turni macchina con i vuoti e il riepilogo (lib/esercizio-turni.ts).
 *   GET  /api/admin/esercizio/giornate?dal=&al=   l'elenco (al più 366 giorni; senza: gli ultimi 30 e domani)
 *   GET  /api/admin/esercizio/giornate/:giorno     una giornata con le sue corse e i suoi turni
 *   POST /api/admin/esercizio/giornate/:giorno/prepara   (409 se congelata; una congelata senza turni li riceve)
 *   POST /api/admin/esercizio/giornate/:giorno/proposta  la proposta dall'AVM (4.4), solo su una giornata congelata
 */
const piuGiorni = (g: string, n: number) => {
  const d = new Date(`${g}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
router.get("/admin/esercizio/giornate", async (req, res): Promise<void> => {
  const oggi = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dal = req.query.dal === undefined ? piuGiorni(oggi, -30) : String(req.query.dal);
  const al = req.query.al === undefined ? piuGiorni(oggi, 1) : String(req.query.al);
  if (!giornoValido(dal) || !giornoValido(al) || dal > al || Date.parse(al) - Date.parse(dal) > 366 * 86_400_000) {
    res.status(400).json({ error: "dal e al: date vere, AAAA-MM-GG, al più un anno" });
    return;
  }
  try {
    res.json({ dal, al, giornate: await elencoGiornate(dal, al) });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "giornate di esercizio non leggibili");
    res.status(500).json({ error: "Giornate non leggibili" });
  }
});
router.get("/admin/esercizio/giornate/:giorno", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  try {
    const g = await leggiGiornata(giorno);
    if (!g) { res.status(404).json({ error: "Giornata non ancora preparata" }); return; }
    res.json(g);
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, giorno }, "giornata di esercizio non leggibile");
    res.status(500).json({ error: "Giornata non leggibile" });
  }
});
router.post("/admin/esercizio/giornate/:giorno/prepara", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  try {
    const e = await preparaGiornata(giorno);
    /* congelata prima della 4.3: le corse restano, i turni si aggiungono dallo storico del canale */
    if (e.giaCongelata && !e.turniCompletati) { res.status(409).json({ error: "Giornata già congelata: il suo programmato non cambia più" }); return; }
    res.json(e);
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, giorno }, "preparazione della giornata non riuscita");
    res.status(500).json({ error: "Preparazione non riuscita" });
  }
});
/* chiusura e blocco (4.6): riaprire una giornata, chiudere e riaprire un mese; sempre col motivo per riaprire */
const rispostaChiusura = (req: any, res: any, cosa: string) => (e: any) => {
  if (e instanceof RifiutoChiusura) { res.status(e.status).json({ error: e.message }); return; }
  req.log?.error?.({ err: e?.message }, `${cosa} non riuscita`);
  res.status(500).json({ error: `${cosa.charAt(0).toUpperCase()}${cosa.slice(1)} non riuscita` });
};
router.post("/admin/esercizio/giornate/:giorno/riapertura", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  await riapriGiornata(giorno, String(req.body?.motivo ?? ""), (req as any).user?.id ?? null).then((r) => res.json(r), rispostaChiusura(req, res, "riapertura"));
});
router.post("/admin/esercizio/mesi/:mese/chiusura", async (req, res): Promise<void> => {
  const mese = String(req.params.mese);
  if (!meseValido(mese)) { res.status(400).json({ error: "mese: AAAA-MM" }); return; }
  await chiudiMese(mese, (req as any).user?.id ?? null).then((r) => res.json(r), rispostaChiusura(req, res, "chiusura del mese"));
});
router.post("/admin/esercizio/mesi/:mese/riapertura", async (req, res): Promise<void> => {
  const mese = String(req.params.mese);
  if (!meseValido(mese)) { res.status(400).json({ error: "mese: AAAA-MM" }); return; }
  await riapriMese(mese, String(req.body?.motivo ?? ""), (req as any).user?.id ?? null).then((r) => res.json(r), rispostaChiusura(req, res, "riapertura del mese"));
});

/* il catalogo delle causali del consuntivo (4.5): l'amministratore lo cambia; il codice no, le corse lo citano */
router.get("/admin/esercizio/causali", async (req, res): Promise<void> => {
  try { res.json({ causali: await elencoCausali(true) }); }
  catch (e: any) {
    req.log?.error?.({ err: e?.message }, "causali non leggibili");
    res.status(500).json({ error: "Causali non leggibili" });
  }
});
router.put("/admin/esercizio/causali/:codice", async (req, res): Promise<void> => {
  try { res.json(await salvaCausale(String(req.params.codice), req.body)); }
  catch (e: any) {
    if (e instanceof RifiutoGiornale) { res.status(e.status).json({ error: e.message }); return; }
    req.log?.error?.({ err: e?.message }, "causale non salvata");
    res.status(500).json({ error: "Causale non salvata" });
  }
});

/* la proposta dall'AVM di una giornata cominciata (4.4): durante il giorno è una vista viva */
router.post("/admin/esercizio/giornate/:giorno/proposta", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  try {
    res.json(await calcolaProposta(giorno));
  } catch (e: any) {
    if (e instanceof RifiutoProposta) { res.status(e.status).json({ error: e.message }); return; }
    req.log?.error?.({ err: e?.message, giorno }, "proposta della giornata non riuscita");
    res.status(500).json({ error: "Proposta non riuscita" });
  }
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
 * Il catalogo delle voci del roster (tappa 5.5, lib/roster-voci.ts): GET
 * l'elenco intero con quanto è usata ogni voce, POST una voce nuova, PUT
 * /:codice le modifiche, DELETE /:codice una voce mai usata. Solo admin, mai
 * un token di Argos (requireAdmin): le regole decidono anche chi vede i dati
 * sanitari. Codice e categoria non cambiano; «sanitaria» si accende e non si
 * spegne; R e ASS cambiano solo nome, ordine e codice per le paghe.
 */
const CODICE_VOCE = /^[A-Za-z0-9]{1,40}$/;
const rifiutoVoci = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoVoci) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/voci-roster", requireAdmin);
router.get("/admin/voci-roster", async (req, res): Promise<void> => {
  try { res.json({ voci: await elencoVoci() }); }
  catch (e) { rifiutoVoci(req, res, e, "catalogo delle voci non leggibile"); }
});
router.post("/admin/voci-roster", async (req, res): Promise<void> => {
  const p = NuovaVoce.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.status(201).json({ voce: await creaVoce(p.data) }); }
  catch (e) { rifiutoVoci(req, res, e, "voce non creata"); }
});
router.put("/admin/voci-roster/:codice", async (req, res): Promise<void> => {
  const codice = String(req.params.codice ?? "");
  if (!CODICE_VOCE.test(codice)) { res.status(404).json({ error: "Voce non trovata" }); return; }
  const p = ModificaVoce.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ voce: await modificaVoce(codice, p.data) }); }
  catch (e) { rifiutoVoci(req, res, e, "voce non salvata"); }
});
router.delete("/admin/voci-roster/:codice", async (req, res): Promise<void> => {
  const codice = String(req.params.codice ?? "");
  if (!CODICE_VOCE.test(codice)) { res.status(404).json({ error: "Voce non trovata" }); return; }
  try { await cancellaVoce(codice); res.json({ ok: true }); }
  catch (e) { rifiutoVoci(req, res, e, "voce non cancellata"); }
});

/**
 * Il territorio dell'azienda (tappa 6.1, lib/territorio.ts): i comuni (per
 * codice ISTAT) e i luoghi di riferimento (punti d'interesse, meteo, poli di
 * lavoro). GET tutto; PUT /comuni/:codice salva un comune, nuovo o no;
 * DELETE lo toglie; POST, PUT e DELETE sui luoghi. Solo admin, mai un token
 * di Argos (requireAdmin). La provincia ISTAT sta con i dati dell'azienda.
 */
const CODICE_COMUNE = /^[0-9]{6}$/;
const UUID_LUOGO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rifiutoTerritorio = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoTerritorio) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/territorio", requireAdmin);
router.get("/admin/territorio", async (req, res): Promise<void> => {
  try { res.json(await elencoTerritorio()); }
  catch (e) { rifiutoTerritorio(req, res, e, "territorio non leggibile"); }
});
router.put("/admin/territorio/comuni/:codice", async (req, res): Promise<void> => {
  const codice = String(req.params.codice ?? "");
  if (!CODICE_COMUNE.test(codice)) { res.status(400).json({ error: "Codice ISTAT: sei cifre, come «042002»" }); return; }
  const p = DatiComune.safeParse({ ...(req.body ?? {}), codiceIstat: codice });
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ comune: await salvaComune(p.data) }); }
  catch (e) { rifiutoTerritorio(req, res, e, "comune non salvato"); }
});
router.delete("/admin/territorio/comuni/:codice", async (req, res): Promise<void> => {
  const codice = String(req.params.codice ?? "");
  if (!CODICE_COMUNE.test(codice)) { res.status(404).json({ error: "Comune non trovato" }); return; }
  try { await cancellaComune(codice); res.json({ ok: true }); }
  catch (e) { rifiutoTerritorio(req, res, e, "comune non cancellato"); }
});
router.post("/admin/territorio/luoghi", async (req, res): Promise<void> => {
  const p = DatiLuogo.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.status(201).json({ luogo: await creaLuogo(p.data) }); }
  catch (e) { rifiutoTerritorio(req, res, e, "luogo non creato"); }
});
router.put("/admin/territorio/luoghi/:id", async (req, res): Promise<void> => {
  const id = String(req.params.id ?? "");
  if (!UUID_LUOGO.test(id)) { res.status(404).json({ error: "Luogo non trovato" }); return; }
  const p = DatiLuogo.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ luogo: await modificaLuogo(id, p.data) }); }
  catch (e) { rifiutoTerritorio(req, res, e, "luogo non salvato"); }
});
router.delete("/admin/territorio/luoghi/:id", async (req, res): Promise<void> => {
  const id = String(req.params.id ?? "");
  if (!UUID_LUOGO.test(id)) { res.status(404).json({ error: "Luogo non trovato" }); return; }
  try { await cancellaLuogo(id); res.json({ ok: true }); }
  catch (e) { rifiutoTerritorio(req, res, e, "luogo non cancellato"); }
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

/**
 * I dati aperti (tappa 6.3, lib/dati-aperti.ts): il GTFS e il NeTEx pubblicati
 * a un indirizzo stabile (routes/dati-aperti.ts). GET lo stato (l'interruttore,
 * la versione in esercizio, i due file e l'ultimo tentativo); PUT accende o
 * spegne; POST /prepara rifà i file subito, senza aspettare il giro del
 * lavoratore (mezzo minuto su un programma vero). Solo admin, mai un token di
 * Argos (requireAdmin).
 */
router.use("/admin/dati-aperti", requireAdmin);
router.get("/admin/dati-aperti", async (req, res): Promise<void> => {
  try { res.json(await statoDatiAperti()); }
  catch (e: any) {
    req.log?.error?.({ err: e?.message }, "dati aperti: stato non leggibile");
    res.status(500).json({ error: "Stato dei dati aperti non leggibile" });
  }
});
router.put("/admin/dati-aperti", async (req, res): Promise<void> => {
  const attivi = (req.body ?? {}).attivi;
  if (typeof attivi !== "boolean") { res.status(400).json({ error: "attivi: true o false" }); return; }
  try {
    if ((await impostaAttivi(attivi)) === "senza_azienda") {
      res.status(409).json({ error: "Prima compila i dati dell'azienda: i file pubblicati portano il suo nome" });
      return;
    }
    res.json(await statoDatiAperti());
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "dati aperti: interruttore non salvato");
    res.status(500).json({ error: "Pubblicazione non cambiata" });
  }
});
router.post("/admin/dati-aperti/prepara", async (req, res): Promise<void> => {
  try {
    const esito = await preparaDatiAperti({
      forza: true,
      suGuasto: (err: any, tipo) => req.log?.error?.({ err: err?.message, tipo }, "dati aperti: preparazione non riuscita"),
    });
    if (esito.stato === "spenti") { res.status(409).json({ error: "La pubblicazione è spenta: accendila, poi prepara i file" }); return; }
    if (esito.stato === "occupato") { res.status(409).json({ error: "I file si stanno già preparando: riprova fra un minuto" }); return; }
    res.json({ preparazione: esito.file, ...(await statoDatiAperti()) });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "dati aperti: preparazione non riuscita");
    res.status(500).json({ error: "Preparazione dei file non riuscita" });
  }
});

/**
 * I depositi dell'azienda (tappa 6.4, lib/depositi.ts): il catalogo dei
 * depositi del personale. GET tutti, con quanto sono usati; POST ne crea uno
 * (il codice si ricava dal nome, se manca); PUT /:codice cambia nome, gruppo,
 * periodi dei turni, altri nomi e ordine (il codice no); DELETE lo toglie, se
 * nessuno lo usa. Solo admin, mai un token di Argos (requireAdmin).
 */
const CODICE_DEPOSITO = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const rifiutoDepositi = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoDepositi) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  if (codice === "23503") { res.status(409).json({ error: "Il deposito è in uso: prima sposta chi lo usa" }); return; }
  if (codice === "23505") { res.status(409).json({ error: "C'è già un deposito con questo codice" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/depositi", requireAdmin);
router.get("/admin/depositi", async (req, res): Promise<void> => {
  try { res.json({ depositi: await elencoDepositi() }); }
  catch (e) { rifiutoDepositi(req, res, e, "depositi non leggibili"); }
});
router.post("/admin/depositi", async (req, res): Promise<void> => {
  const p = NuovoDeposito.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.status(201).json({ deposito: await creaDeposito(p.data) }); }
  catch (e) { rifiutoDepositi(req, res, e, "deposito non creato"); }
});
router.put("/admin/depositi/:codice", async (req, res): Promise<void> => {
  const codice = String(req.params.codice ?? "");
  if (!CODICE_DEPOSITO.test(codice)) { res.status(404).json({ error: "Deposito non trovato" }); return; }
  const p = ModificaDeposito.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ deposito: await modificaDeposito(codice, p.data) }); }
  catch (e) { rifiutoDepositi(req, res, e, "deposito non salvato"); }
});
router.delete("/admin/depositi/:codice", async (req, res): Promise<void> => {
  const codice = String(req.params.codice ?? "");
  if (!CODICE_DEPOSITO.test(codice)) { res.status(404).json({ error: "Deposito non trovato" }); return; }
  try { await cancellaDeposito(codice); res.json({ ok: true }); }
  catch (e) { rifiutoDepositi(req, res, e, "deposito non tolto"); }
});

/**
 * Le reti dell'azienda e le regole delle linee (tappa 6.7, lib/reti.ts). GET
 * tutte, con quanto sono usate, e le regole in ordine; POST crea una rete
 * urbana (identificativo, zona e codice li ricava il programma); PUT /:rete
 * cambia nome, luogo, sigla, colore e ordine; DELETE la toglie, se nessuno la
 * usa. PUT /regole salva l'elenco intero delle regole; POST /regole/anteprima
 * dice quali linee cambierebbero rete, senza scrivere. Solo admin, mai un
 * token di Argos (requireAdmin).
 */
const ID_RETE = /^[a-z][a-z0-9_]{1,39}$/;
const rifiutoReti = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoReti) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  if (codice === "23503") { res.status(409).json({ error: "La rete non c'è più: ricarica la pagina" }); return; }
  if (codice === "23505") { res.status(409).json({ error: "C'è già una rete con questo luogo, questa sigla o questo codice" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/reti", requireAdmin);
router.get("/admin/reti", async (req, res): Promise<void> => {
  try { res.json(await elencoReti()); }
  catch (e) { rifiutoReti(req, res, e, "reti non leggibili"); }
});
router.post("/admin/reti", async (req, res): Promise<void> => {
  const p = NuovaRete.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.status(201).json({ rete: await creaRete(p.data) }); }
  catch (e) { rifiutoReti(req, res, e, "rete non creata"); }
});
/* le due rotte delle regole prima di /:rete: «regole» non è una rete */
router.put("/admin/reti/regole", async (req, res): Promise<void> => {
  const p = Regole.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ regole: await salvaRegole(p.data) }); }
  catch (e) { rifiutoReti(req, res, e, "regole non salvate"); }
});
router.post("/admin/reti/regole/anteprima", async (req, res): Promise<void> => {
  const p = Regole.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json(await anteprimaRegole(p.data)); }
  catch (e) { rifiutoReti(req, res, e, "anteprima non riuscita"); }
});
router.put("/admin/reti/:rete", async (req, res): Promise<void> => {
  const rete = String(req.params.rete ?? "");
  if (!ID_RETE.test(rete)) { res.status(404).json({ error: "Rete non trovata" }); return; }
  const p = ModificaRete.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ rete: await modificaRete(rete, p.data) }); }
  catch (e) { rifiutoReti(req, res, e, "rete non salvata"); }
});
router.delete("/admin/reti/:rete", async (req, res): Promise<void> => {
  const rete = String(req.params.rete ?? "");
  if (!ID_RETE.test(rete)) { res.status(404).json({ error: "Rete non trovata" }); return; }
  try { res.json({ ok: true, ...(await cancellaRete(rete)) }); }
  catch (e) { rifiutoReti(req, res, e, "rete non tolta"); }
});

/**
 * Le fasce chilometriche dell'extraurbano (tappa 6.8, lib/fasce-km.ts): a
 * ogni fascia di chilometri il suo prezzo. GET tutte, in ordine; PUT salva
 * l'elenco intero (numerate da 1, la prima da 0 km, senza buchi né
 * sovrapposizioni). Solo admin, mai un token di Argos (requireAdmin).
 */
const rifiutoFasce = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoFasce) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/fasce-km", requireAdmin);
router.get("/admin/fasce-km", async (req, res): Promise<void> => {
  try { res.json(await elencoFasce()); }
  catch (e) { rifiutoFasce(req, res, e, "fasce non leggibili"); }
});
router.put("/admin/fasce-km", async (req, res): Promise<void> => {
  const p = Fasce.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ fasce: await salvaFasce(p.data) }); }
  catch (e) { rifiutoFasce(req, res, e, "fasce non salvate"); }
});

/**
 * Il catalogo dei titoli di viaggio (tappa 6.9, lib/titoli-catalogo.ts): i
 * biglietti e gli abbonamenti con cui si riempie un feed. GET tutti, in
 * ordine; POST ne crea uno; PUT /:titolo cambia tutto tranne
 * l'identificativo; DELETE lo toglie (i feed che l'hanno già copiato lo
 * tengono). Solo admin, mai un token di Argos (requireAdmin).
 */
const ID_TITOLO = /^[a-z][a-z0-9_]{1,59}$/;
const rifiutoTitoli = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoTitoli) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  if (codice === "23503") { res.status(400).json({ error: "La rete non c'è più: ricarica la pagina" }); return; }
  if (codice === "23505") { res.status(409).json({ error: "C'è già un titolo con questo identificativo" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/titoli", requireAdmin);
router.get("/admin/titoli", async (req, res): Promise<void> => {
  try { res.json(await elencoTitoli()); }
  catch (e) { rifiutoTitoli(req, res, e, "catalogo non leggibile"); }
});
router.post("/admin/titoli", async (req, res): Promise<void> => {
  const p = NuovoTitolo.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.status(201).json({ titolo: await creaTitolo(p.data) }); }
  catch (e) { rifiutoTitoli(req, res, e, "titolo non creato"); }
});
router.put("/admin/titoli/:titolo", async (req, res): Promise<void> => {
  const titolo = String(req.params.titolo ?? "");
  if (!ID_TITOLO.test(titolo)) { res.status(404).json({ error: "Titolo non trovato" }); return; }
  const p = ModificaTitolo.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ titolo: await modificaTitolo(titolo, p.data) }); }
  catch (e) { rifiutoTitoli(req, res, e, "titolo non salvato"); }
});
router.delete("/admin/titoli/:titolo", async (req, res): Promise<void> => {
  const titolo = String(req.params.titolo ?? "");
  if (!ID_TITOLO.test(titolo)) { res.status(404).json({ error: "Titolo non trovato" }); return; }
  try { await cancellaTitolo(titolo); res.json({ ok: true }); }
  catch (e) { rifiutoTitoli(req, res, e, "titolo non tolto"); }
});

/**
 * Gli elenchi di partenza delle tariffe (tappa 6.10, lib/elenchi-tariffe.ts):
 * le categorie di passeggero e i supporti con cui la pagina Tariffe riempie
 * un feed. GET tutto insieme; ogni PUT salva un elenco intero. Solo admin,
 * mai un token di Argos (requireAdmin).
 */
const rifiutoElenchi = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoElenchi) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  if (codice === "23505") { res.status(409).json({ error: "Un identificativo compare due volte" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/elenchi-tariffe", requireAdmin);
router.get("/admin/elenchi-tariffe", async (req, res): Promise<void> => {
  try {
    res.json({ ...(await elenchiTariffe()), tipiSupporto: TIPI_SUPPORTO });
  } catch (e) { rifiutoElenchi(req, res, e, "elenchi non leggibili"); }
});
router.put("/admin/elenchi-tariffe/categorie", async (req, res): Promise<void> => {
  const p = Categorie.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroreElenco(p.error) }); return; }
  try { res.json({ categorie: await salvaCategorie(p.data) }); }
  catch (e) { rifiutoElenchi(req, res, e, "categorie non salvate"); }
});
router.put("/admin/elenchi-tariffe/supporti", async (req, res): Promise<void> => {
  const p = Supporti.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroreElenco(p.error) }); return; }
  try { res.json({ supporti: await salvaSupporti(p.data) }); }
  catch (e) { rifiutoElenchi(req, res, e, "supporti non salvati"); }
});
/**
 * I gestori (tappa 6.11, lib/gestori.ts): le aziende che gestiscono le linee,
 * ognuna un'agenzia nei GTFS. GET tutti, con le linee che ognuno ha nei
 * programmi di lavoro e con l'azienda, che figura finché l'elenco è vuoto;
 * POST ne aggiunge uno (il primo è il predefinito); PUT /:gestore cambia
 * tutto tranne l'identificativo, e con `predefinito: true` lo fa diventare
 * il predefinito; DELETE lo toglie (il predefinito solo per ultimo). Solo
 * admin, mai un token di Argos (requireAdmin).
 */
const ID_GESTORE = /^[A-Za-z0-9_.-]{1,40}$/;
const rifiutoGestori = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoGestori) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  if (codice === "23505") { res.status(409).json({ error: "C'è già un gestore con questo identificativo" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
router.use("/admin/gestori", requireAdmin);
router.get("/admin/gestori", async (req, res): Promise<void> => {
  try {
    const [elenco, azienda] = await Promise.all([elencoGestori(), leggiAzienda()]);
    res.json({ ...elenco, azienda: agenziaDellAzienda(azienda) });
  } catch (e) { rifiutoGestori(req, res, e, "gestori non leggibili"); }
});
router.post("/admin/gestori", async (req, res): Promise<void> => {
  const p = NuovoGestore.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroreGestore(p.error) }); return; }
  try { res.status(201).json({ gestore: await creaGestore(p.data) }); }
  catch (e) { rifiutoGestori(req, res, e, "gestore non aggiunto"); }
});
router.put("/admin/gestori/:gestore", async (req, res): Promise<void> => {
  const gestore = String(req.params.gestore ?? "");
  if (!ID_GESTORE.test(gestore)) { res.status(404).json({ error: "Gestore non trovato" }); return; }
  const p = ModificaGestore.safeParse(req.body ?? {});
  if (!p.success) { res.status(400).json({ error: erroreGestore(p.error) }); return; }
  try { res.json({ gestore: await modificaGestore(gestore, p.data) }); }
  catch (e) { rifiutoGestori(req, res, e, "gestore non salvato"); }
});
router.delete("/admin/gestori/:gestore", async (req, res): Promise<void> => {
  const gestore = String(req.params.gestore ?? "");
  if (!ID_GESTORE.test(gestore)) { res.status(404).json({ error: "Gestore non trovato" }); return; }
  try { res.json({ ok: true, ...(await cancellaGestore(gestore)) }); }
  catch (e) { rifiutoGestori(req, res, e, "gestore non tolto"); }
});

/**
 * I nodi di scambio dell'azienda (tappa 6.16, lib/nodi-scambio-store.ts):
 * stazioni, porti, aeroporti e parcheggi scambiatori, con gli orari stimati.
 * Li usano l'analisi intermodale, le zone di coincidenza, l'ottimizzatore e
 * il confronto fra programmi. Solo l'amministratore.
 */
const rifiutoNodi = (req: any, res: any, e: any, cosa: string) => {
  if (e instanceof RifiutoNodi) { res.status(e.status).json({ error: e.message }); return; }
  const codice = String(e?.code ?? e?.cause?.code ?? "");
  if (codice === "23514") { res.status(400).json({ error: "Uno dei valori non è ammesso" }); return; }
  req.log?.error?.({ err: e?.message }, cosa);
  res.status(500).json({ error: cosa.charAt(0).toUpperCase() + cosa.slice(1) });
};
/**
 * Che cosa ha scritto l'azienda e che cosa le manca (tappa 6.18,
 * lib/installazione.ts): voce per voce, dove si scrive e che cosa succede
 * finché manca. Solo l'amministratore.
 */
router.get("/admin/installazione", requireAdmin, async (req, res): Promise<void> => {
  try { res.json(await statoDellInstallazione()); }
  catch (e: any) {
    req.log?.error?.({ err: e?.message }, "stato dell'installazione non leggibile");
    res.status(500).json({ error: "Stato dell'installazione non leggibile" });
  }
});

router.use("/admin/nodi-scambio", requireAdmin);
router.get("/admin/nodi-scambio", async (req, res): Promise<void> => {
  try { res.json(await elencoNodi()); }
  catch (e) { rifiutoNodi(req, res, e, "nodi di scambio non leggibili"); }
});
router.post("/admin/nodi-scambio", async (req, res): Promise<void> => {
  const p = NuovoNodo.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.status(201).json({ nodo: await creaNodo(p.data) }); }
  catch (e) { rifiutoNodi(req, res, e, "nodo non creato"); }
});
router.put("/admin/nodi-scambio/:nodo", async (req, res): Promise<void> => {
  const nodo = String(req.params.nodo ?? "");
  if (!IDENTIFICATIVO_NODO.test(nodo)) { res.status(404).json({ error: "Nodo non trovato" }); return; }
  const p = DatiNodo.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: erroriDiValidazione(p.error) }); return; }
  try { res.json({ nodo: await modificaNodo(nodo, p.data) }); }
  catch (e) { rifiutoNodi(req, res, e, "nodo non salvato"); }
});
router.delete("/admin/nodi-scambio/:nodo", async (req, res): Promise<void> => {
  const nodo = String(req.params.nodo ?? "");
  if (!IDENTIFICATIVO_NODO.test(nodo)) { res.status(404).json({ error: "Nodo non trovato" }); return; }
  try { await cancellaNodo(nodo); res.json({ ok: true }); }
  catch (e) { rifiutoNodi(req, res, e, "nodo non tolto"); }
});

export default router;
