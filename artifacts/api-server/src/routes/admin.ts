import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/auth";
import { GIORNI_MAX, Parametri, leggiRegistro, statoRegistro } from "../lib/registro-modifiche";
import { DatiAzienda, dettaglioAzienda, erroriDiValidazione, salvaAzienda } from "../lib/azienda";
import { cancellaVoce, creaVoce, elencoVoci, ModificaVoce, modificaVoce, NuovaVoce, RifiutoVoci } from "../lib/roster-voci";
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
