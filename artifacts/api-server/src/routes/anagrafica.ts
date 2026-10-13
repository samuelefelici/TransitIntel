/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PERSONALE — rotte
 * ───────────────────────────────────────────────────────────────────────────
 *   GET    /api/roster/depositi | /categorie | /gruppi-turni   cataloghi
 *   GET    /api/roster/drivers[?tutti=1&foto=0]                conducenti
 *   GET    /api/roster/drivers/:id
 *   POST   /api/roster/drivers                                  nuovo
 *   PATCH  /api/roster/drivers/:id                              scheda (solo i campi cambiati + versione)
 *   DELETE /api/roster/drivers/:id                              esce dal servizio
 *   POST   /api/roster/drivers/:id/riattiva
 *   POST   /api/roster/drivers/seed                             conducenti FITTIZI per provare il tabellone
 *   GET    /api/roster/drivers/:id/history                      storico
 *   POST   /api/roster/drivers/:id/history
 *   DELETE /api/roster/history/:hid
 *   POST   /api/roster/anagrafica/import/leggi    file .xlsx/.csv → righe normalizzate (niente database)
 *   POST   /api/roster/anagrafica/import/prova    {righe, scelte} → rapporto, senza scrivere
 *   POST   /api/roster/anagrafica/import/applica  {righe, scelte} → tutto o niente
 *   GET    /api/roster/anagrafica/esporta?formato=xlsx|csv[&tutti=1]
 *
 * Permessi (il prefisso in auth.ts fa entrare chi ha «scheduling» o
 * «personale»; qui si decide il resto):
 *   · lettura: tutti e due; senza «personale» i dati personali mancano dalla
 *     risposta (mascheraConducente, elenco di campi AMMESSI);
 *   · scrittura: «personale». Chi ha solo «scheduling» può creare, cambiare
 *     nei campi operativi e togliere i conducenti FITTIZI, che servono a
 *     provare il tabellone e non hanno dati di nessuno;
 *   · storico: «personale» (dice quando e dove ha lavorato una persona).
 *
 * Gli errori del database non escono mai col loro testo: dentro c'è la
 * query coi parametri, cioè i dati della persona.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter, type Request, type Response } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { haPermesso, requirePermission, vedeDatiPersonali } from "../lib/auth";
import {
  DEPOSITI_INIZIALI, ESITI_VISITA, formattaOrario, leggiData, leggiEsitoVisita, leggiOrario,
  mascheraConducente, pulisciTesto, trovaDeposito, type Conducente,
} from "../lib/anagrafica-campi";
import {
  assicuraAnagrafica, leggiCategorie, leggiConducenti, leggiDepositi, leggiGruppiTurni, oggiRoma,
  registra, righe, sincronizzaCorrenti, sincronizzaSeNuovoGiorno, statoAnagrafica, TIPI_STORICO, type Ex, type TipoStorico,
} from "../lib/anagrafica-store";
import {
  applicaVariazioni, categoriaCanonica, disattivaConducente, riattivaConducente,
} from "../lib/anagrafica-scritture";
import { CAMPI_SCRIVIBILI_FITTIZI, leggiCorpoScheda } from "../lib/anagrafica-scheda";
import { creaConducentiDiProva } from "../lib/anagrafica-prova";
import { analizza, leggiTabella, ErroreFile, type RigaImport } from "../lib/anagrafica-import";
import { Annulla, eseguiImport, ESCLUDI, type ScelteImport } from "../lib/anagrafica-import-db";
import { esportaAnagraficaCsv, esportaAnagraficaXlsx } from "../lib/anagrafica-export";
import { ErroreXlsx } from "../lib/xlsx-leggi";

const router: IRouter = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/* Il bootstrap gira solo per le richieste del roster: il router è montato
 * senza prefisso, e un errore qui non deve fermare il resto dell'API. */
router.use(async (req, res, next) => {
  if (!req.path.toLowerCase().startsWith("/roster")) { next(); return; }
  try {
    await assicuraAnagrafica();
    await sincronizzaSeNuovoGiorno();
  } catch {
    res.status(503).json({ error: "Anagrafica del personale non disponibile: riprova tra poco" });
    return;
  }
  next();
});

/* ── Errori ─────────────────────────────────────────────────────────────── */

export class Rifiuto extends Error {
  constructor(public status: number, messaggio: string, public extra: Record<string, unknown> = {}) { super(messaggio); }
}

export function rispondiErrore(res: Response, e: any, contesto: string): void {
  if (e instanceof Rifiuto) { res.status(e.status).json({ error: e.message, ...e.extra }); return; }
  const code = e?.cause?.code ?? e?.code;
  if (code === "23505") { res.status(409).json({ error: "Valore già presente (matricola doppia?)" }); return; }
  if (code === "22021" || code === "22P05" || code === "22001") { res.status(400).json({ error: "Testo non valido o troppo lungo" }); return; }
  if (code === "40P01" || code === "55P03") { res.status(409).json({ error: "Qualcun altro sta modificando gli stessi conducenti: riprova" }); return; }
  /* solo codice e vincolo: il messaggio di drizzle contiene i parametri */
  console.error(`[anagrafica] ${contesto}:`, code ?? e?.name ?? "errore", e?.cause?.constraint ?? "");
  res.status(500).json({ error: "Errore interno dell'anagrafica" });
}

const utente = (req: Request) => ({ userId: req.user?.id ?? null, via: req.authVia ?? null });

function richiedePersonale(req: Request): void {
  if (!vedeDatiPersonali(req)) throw new Rifiuto(403, "Serve il permesso «Personale» per modificare l'anagrafica");
}

function uuid(v: unknown): string {
  const s = String(v ?? "");
  if (!UUID_RE.test(s)) throw new Rifiuto(400, "ID non valido");
  return s;
}

/* ── Cataloghi ──────────────────────────────────────────────────────────── */

router.get("/roster/depositi", async (_req, res): Promise<void> => {
  try { res.json({ depositi: await leggiDepositi(db as unknown as Ex) }); }
  catch (e) { rispondiErrore(res, e, "depositi"); }
});

router.get("/roster/categorie", async (_req, res): Promise<void> => {
  try { res.json({ categorie: await leggiCategorie(db as unknown as Ex) }); }
  catch (e) { rispondiErrore(res, e, "categorie"); }
});

router.get("/roster/gruppi-turni", async (_req, res): Promise<void> => {
  try { res.json({ gruppi: await leggiGruppiTurni(db as unknown as Ex) }); }
  catch (e) { rispondiErrore(res, e, "gruppi turni"); }
});

/* ── Conducenti ─────────────────────────────────────────────────────────── */

/** I conducenti come li può vedere chi fa la richiesta. */
export async function conducentiPer(req: Request, ex: Ex, f: Parameters<typeof leggiConducenti>[1] = {}): Promise<Conducente[]> {
  const vede = vedeDatiPersonali(req);
  return (await leggiConducenti(ex, f, oggiRoma())).map(c => mascheraConducente(c, vede));
}

router.get("/roster/drivers", async (req, res): Promise<void> => {
  try {
    const drivers = await conducentiPer(req, db as unknown as Ex, {
      ancheDisattivati: req.query.tutti === "1",
      conFoto: req.query.foto !== "0",
    });
    /* chi tiene l'anagrafica vede anche i problemi trovati all'avvio (matricole doppie…) */
    res.json({ drivers, sensibili: vedeDatiPersonali(req), avvisi: vedeDatiPersonali(req) ? statoAnagrafica().avvisi : [] });
  } catch (e) { rispondiErrore(res, e, "elenco"); }
});

router.get("/roster/drivers/:id", async (req, res): Promise<void> => {
  try {
    const id = uuid(req.params.id);
    const [c] = await conducentiPer(req, db as unknown as Ex, { id, ancheDisattivati: true });
    if (!c) throw new Rifiuto(404, "Conducente non trovato");
    res.json({ conducente: c, sensibili: vedeDatiPersonali(req) });
  } catch (e) { rispondiErrore(res, e, "scheda"); }
});

/** Chi ha solo «scheduling» tocca solo i fittizi, e solo nei campi operativi. */
function controllaScrittura(req: Request, fittizio: boolean, chiavi: string[]): void {
  if (vedeDatiPersonali(req)) return;
  if (!fittizio || !haPermesso(req, "scheduling")) richiedePersonale(req);
  const fuori = chiavi.filter(k => !CAMPI_SCRIVIBILI_FITTIZI.has(k) && k !== "isFictitious" && k !== "name");
  if (fuori.length) throw new Rifiuto(403, `Senza il permesso «Personale» non si possono scrivere: ${fuori.join(", ")}`);
}

interface Risultato { conducente: Conducente | null; avvisi: string[]; daRigenerare: string[] }

async function rispostaScrittura(req: Request, id: string, avvisi: string[], daRigenerare: Set<string>): Promise<Risultato> {
  const [c] = await conducentiPer(req, db as unknown as Ex, { id, ancheDisattivati: true });
  return { conducente: c ?? null, avvisi, daRigenerare: [...daRigenerare] };
}

router.post("/roster/drivers", async (req, res): Promise<void> => {
  try {
    const corpo = leggiCorpoScheda(req.body);
    const fittizio = req.body?.isFictitious === true;
    controllaScrittura(req, fittizio, corpo.chiavi);
    if (Object.keys(corpo.errori).length) throw new Rifiuto(400, "Controlla i campi", { campi: corpo.errori });
    const oggi = oggiRoma();
    let id = "";
    const esito = await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      const nome = [corpo.variazioni.cognome, corpo.variazioni.nome].filter(Boolean).join(" ");
      if (!nome) throw new Rifiuto(400, "Servono cognome o nome", { campi: { cognome: "obbligatorio" } });
      id = righe(await ex.execute(sql`
        INSERT INTO roster_drivers (name, is_fictitious, versione, updated_at)
        VALUES (${nome}, ${fittizio}, 0, now()) RETURNING id`))[0].id;
      const es = await applicaVariazioni(ex, id, corpo.variazioni, {
        oggi, decorrenza: corpo.decorrenza ?? oggi, nota: "scheda", puoCreareCataloghi: vedeDatiPersonali(req), depositi: await leggiDepositi(ex), categorie: await leggiCategorie(ex),
      });
      if (es.conflitti.length) throw new Rifiuto(409, es.conflitti.join("; "), { conflitti: es.conflitti });
      await sincronizzaCorrenti(ex, oggi, [...es.tipi], [id]);
      await registra(ex, { ...utente(req), driverId: id, azione: "crea", campi: es.cambiati, dettaglio: fittizio ? { fittizio: true } : undefined });
      return es;
    });
    res.status(201).json(await rispostaScrittura(req, id, esito.avvisi, esito.daRigenerare));
  } catch (e) { rispondiErrore(res, e, "nuovo conducente"); }
});

router.patch("/roster/drivers/:id", async (req, res): Promise<void> => {
  try {
    const id = uuid(req.params.id);
    const corpo = leggiCorpoScheda(req.body);
    if (Object.keys(corpo.errori).length) throw new Rifiuto(400, "Controlla i campi", { campi: corpo.errori });
    const oggi = oggiRoma();
    const esito = await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      const riga = righe(await ex.execute(sql`SELECT * FROM roster_drivers WHERE id = ${id}::uuid FOR UPDATE`))[0];
      if (!riga) throw new Rifiuto(404, "Conducente non trovato");
      controllaScrittura(req, !!riga.is_fictitious, corpo.chiavi);
      if (corpo.versione !== undefined && Number(riga.versione) !== corpo.versione) {
        throw new Rifiuto(409, "La scheda è stata cambiata da qualcun altro mentre la modificavi: ricaricala", { versione: Number(riga.versione) });
      }
      const es = await applicaVariazioni(ex, id, corpo.variazioni, {
        oggi, decorrenza: corpo.decorrenza ?? oggi, nota: "scheda", puoCreareCataloghi: vedeDatiPersonali(req), riga,
        depositi: await leggiDepositi(ex), categorie: await leggiCategorie(ex),
      });
      if (es.conflitti.length) throw new Rifiuto(409, es.conflitti.join("; "), { conflitti: es.conflitti });
      await sincronizzaCorrenti(ex, oggi, [...es.tipi], [id]);
      if (es.cambiati.length) await registra(ex, { ...utente(req), driverId: id, azione: "modifica", campi: es.cambiati });
      return es;
    });
    res.json(await rispostaScrittura(req, id, esito.avvisi, esito.daRigenerare));
  } catch (e) { rispondiErrore(res, e, "modifica"); }
});

router.delete("/roster/drivers/:id", async (req, res): Promise<void> => {
  try {
    const id = uuid(req.params.id);
    const oggi = oggiRoma();
    const r = await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      const riga = righe(await ex.execute(sql`SELECT is_fictitious, is_active FROM roster_drivers WHERE id = ${id}::uuid FOR UPDATE`))[0];
      if (!riga) throw new Rifiuto(404, "Conducente non trovato");
      controllaScrittura(req, !!riga.is_fictitious, []);
      if (!riga.is_active) return { turniLiberati: 0 };
      const out = await disattivaConducente(ex, id, oggi);
      await registra(ex, { ...utente(req), driverId: id, azione: "disattiva", dettaglio: out });
      return out;
    });
    res.json({ ok: true, ...r });
  } catch (e) { rispondiErrore(res, e, "disattivazione"); }
});

router.post("/roster/drivers/:id/riattiva", async (req, res): Promise<void> => {
  try {
    const id = uuid(req.params.id);
    richiedePersonale(req);
    await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      const errore = await riattivaConducente(ex, id);
      if (errore) throw new Rifiuto(409, errore);
      await registra(ex, { ...utente(req), driverId: id, azione: "riattiva" });
    });
    res.json(await rispostaScrittura(req, id, [], new Set()));
  } catch (e) { rispondiErrore(res, e, "riattivazione"); }
});

/* ── Conducenti fittizi, per provare il tabellone ──────────────────────── */

/**
 * Conducenti FITTIZI completi (lib/anagrafica-prova.ts): ritratto, depositi
 * diversi, rotazioni riposi miste coi riposi già generati. Niente matricola:
 * non si confondono con le persone vere.
 */
router.post("/roster/drivers/seed", async (req, res): Promise<void> => {
  try {
    if (!vedeDatiPersonali(req) && !haPermesso(req, "scheduling")) richiedePersonale(req);
    const quanti = Math.min(Math.max(Number(req.body?.count) || 30, 1), 200);
    const oggi = oggiRoma();
    const esito = await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      const r = await creaConducentiDiProva(ex, quanti, oggi);
      await registra(ex, { ...utente(req), azione: "fittizi", dettaglio: { quanti: r.creati } });
      return r;
    });
    res.json({ ok: true, created: esito.creati, rotazioni: esito.rotazioni, riposi: esito.riposi });
  } catch (e) { rispondiErrore(res, e, "fittizi"); }
});

/* ── Storico ────────────────────────────────────────────────────────────── */

function rigaStorico(h: any) {
  return {
    id: h.id, driverId: h.driver_id, kind: h.kind, value: h.value ?? null,
    eventDate: h.event_date ? String(h.event_date).slice(0, 10) : null,
    expiryDate: h.expiry_date ? String(h.expiry_date).slice(0, 10) : null,
    note: h.note ?? null, createdAt: h.created_at,
  };
}

router.get("/roster/drivers/:id/history", async (req, res): Promise<void> => {
  try {
    const id = uuid(req.params.id);
    richiedePersonale(req);
    const r = await db.execute<any>(sql`
      SELECT * FROM roster_driver_history WHERE driver_id = ${id}::uuid
       ORDER BY event_date DESC NULLS LAST, created_at DESC`);
    res.json({ history: righe(r).map(rigaStorico), oggi: oggiRoma() });
  } catch (e) { rispondiErrore(res, e, "storico"); }
});

/**
 * Una riga di storico scritta a mano (date retroattive o future). Il valore
 * passa dallo stesso lettore della scheda: il deposito dal catalogo,
 * l'orario in «hh:mm», l'esito della visita dall'elenco.
 */
router.post("/roster/drivers/:id/history", async (req, res): Promise<void> => {
  try {
    const id = uuid(req.params.id);
    richiedePersonale(req);
    const b = req.body ?? {};
    const kind = String(b.kind ?? "") as TipoStorico;
    if (!(TIPI_STORICO as readonly string[]).includes(kind)) throw new Rifiuto(400, "Tipo di storico non valido");
    const quando = leggiData(b.eventDate, { min: 1950, max: 2100 });
    if (!quando || quando.ok !== true) throw new Rifiuto(400, "Data di inizio obbligatoria", { campi: { eventDate: "obbligatoria" } });
    const scad = leggiData(b.expiryDate, { min: 1950, max: 2100 });
    if (scad && scad.ok !== true) throw new Rifiuto(400, "Scadenza non valida", { campi: { expiryDate: "non valida" } });
    const nota = pulisciTesto(b.note, 500);
    const oggi = oggiRoma();
    const riga = await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      let value: string | null = null;
      if (kind === "deposito") {
        const dep = trovaDeposito(String(b.value ?? ""), await leggiDepositi(ex));
        if (!dep) throw new Rifiuto(400, "Deposito non in elenco", { campi: { value: "deposito non in elenco" } });
        value = dep.nome;
      } else if (kind === "categoria") {
        const testo = pulisciTesto(b.value, 60);
        if (!testo) throw new Rifiuto(400, "Categoria obbligatoria", { campi: { value: "obbligatoria" } });
        const c = categoriaCanonica(testo, await leggiCategorie(ex));
        if (c.nuova) {
          await ex.execute(sql`INSERT INTO roster_categorie (codice, nome) VALUES (${c.nome.toLowerCase().replace(/[^a-z0-9]+/g, "-")}, ${c.nome}) ON CONFLICT DO NOTHING`);
        }
        value = c.nome;
      } else if (kind === "orario_lavoro") {
        const o = leggiOrario(b.value);
        if (!o || o.ok !== true) throw new Rifiuto(400, "Orario non leggibile: scrivi per esempio 38:30", { campi: { value: "orario non leggibile" } });
        value = formattaOrario(o.valore);
      } else if (kind === "visita_ferrovie" || kind === "visita_medico_competente") {
        const e = leggiEsitoVisita(b.value);
        if (e && e.ok !== true) throw new Rifiuto(400, `Esito: ${ESITI_VISITA.join(", ")}`, { campi: { value: "esito non valido" } });
        value = e?.ok === true ? e.valore : null;
      } else {
        value = pulisciTesto(b.value, 60);
      }
      const r = righe(await ex.execute(sql`
        INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note)
        VALUES (${id}::uuid, ${kind}, ${value}, ${quando.valore}::date, ${scad?.ok === true ? scad.valore : null}::date, ${nota})
        RETURNING *`))[0];
      await sincronizzaCorrenti(ex, oggi, [kind], [id]);
      await ex.execute(sql`UPDATE roster_drivers SET versione = versione + 1, updated_at = now() WHERE id = ${id}::uuid`);
      await registra(ex, { ...utente(req), driverId: id, azione: "storico", campi: [kind] });
      return r;
    });
    res.status(201).json(rigaStorico(riga));
  } catch (e: any) {
    if ((e?.cause?.code ?? e?.code) === "23503") { res.status(404).json({ error: "Conducente non trovato" }); return; }
    rispondiErrore(res, e, "storico");
  }
});

router.delete("/roster/history/:hid", async (req, res): Promise<void> => {
  try {
    const hid = uuid(req.params.hid);
    richiedePersonale(req);
    const oggi = oggiRoma();
    await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      const h = righe(await ex.execute(sql`
        DELETE FROM roster_driver_history WHERE id = ${hid}::uuid RETURNING driver_id, kind`))[0];
      if (!h) throw new Rifiuto(404, "Riga di storico non trovata");
      await sincronizzaCorrenti(ex, oggi, [h.kind as TipoStorico], [h.driver_id]);
      await ex.execute(sql`UPDATE roster_drivers SET versione = versione + 1, updated_at = now() WHERE id = ${h.driver_id}::uuid`);
      await registra(ex, { ...utente(req), driverId: h.driver_id, azione: "storico-cancella", campi: [h.kind] });
    });
    res.json({ ok: true });
  } catch (e) { rispondiErrore(res, e, "storico"); }
});

/* ── Import ─────────────────────────────────────────────────────────────── */

/* il permesso si controlla PRIMA di multer, che altrimenti tiene in memoria
 * 5 MB per chiunque provi */
const caricamento = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 } });
const soloPersonale = requirePermission("personale");
/* Un import si fa a giri: leggi, prova, una scelta, prova di nuovo, applica.
 * Il limite delle operazioni pesanti (10 al minuto, condiviso) si esaurisce
 * a metà di un import normale; questo è suo e più largo. */
const limiteImport = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Troppi passaggi dell'import in un minuto: aspetta un momento e riprova." },
});

/* gli errori di multer (file troppo grande, troppi file) diventano un messaggio leggibile, non un 500 */
const unFile: import("express").RequestHandler = (req, res, next) => {
  caricamento.single("file")(req, res, (e?: unknown) => {
    if (e instanceof multer.MulterError) {
      res.status(e.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        error: e.code === "LIMIT_FILE_SIZE" ? "File troppo grande: al massimo 5 MB" : "Caricamento non valido: un file solo",
      });
      return;
    }
    next(e as Error | undefined);
  });
};

router.post("/roster/anagrafica/import/leggi", limiteImport, soloPersonale, unFile, async (req, res): Promise<void> => {
  try {
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) throw new Rifiuto(400, "Manca il file");
    const k = req.body?.colonnaChiave;
    const colonnaChiave = k === undefined || k === "" ? undefined : Number(k);
    const analisi = analizza(leggiTabella(file.buffer, file.originalname), Number.isInteger(colonnaChiave) ? colonnaChiave : undefined);
    res.json({ analisi, nomeFile: file.originalname.slice(0, 120) });
  } catch (e: any) {
    if (e instanceof ErroreFile || e instanceof ErroreXlsx) { res.status(400).json({ error: e.message }); return; }
    rispondiErrore(res, e, "lettura del file");
  }
});

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function leggiScelte(x: any): ScelteImport {
  const oggetto = (o: any): Record<string, string> => {
    const out: Record<string, string> = {};
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o).slice(0, 500)) {
      if (typeof v === "string") out[String(k).slice(0, 80)] = v.slice(0, 80);
    }
    return out;
  };
  const collega: Record<string, string> = {};
  for (const [k, v] of Object.entries(oggetto(x?.collega))) if (UUID_RE.test(v)) collega[k] = v;
  return {
    depositi: oggetto(x?.depositi),
    categorie: oggetto(x?.categorie),
    creaNuovi: x?.creaNuovi !== false,
    aggiornaEsistenti: x?.aggiornaEsistenti !== false,
    disattivaCessati: x?.disattivaCessati === true,
    collega,
    creaComunque: Array.isArray(x?.creaComunque) ? x.creaComunque.map(Number).filter(Number.isInteger).slice(0, 20_000) : [],
    ferieAl: DATA_RE.test(String(x?.ferieAl ?? "")) ? String(x.ferieAl) : null,
    ferieUnita: x?.ferieUnita === "ore" ? "ore" : "giorni",
    decorrenza: DATA_RE.test(String(x?.decorrenza ?? "")) ? String(x.decorrenza) : oggiRoma(),
    nomeFile: String(x?.nomeFile ?? "file").replace(/[\u0000-\u001f]/g, "").slice(0, 120),
  };
}

function leggiRighe(x: unknown): RigaImport[] {
  if (!Array.isArray(x) || x.length > 20_000) throw new Rifiuto(400, "Righe non valide");
  return x.map((r: any): RigaImport => {
    if (!r || typeof r !== "object" || !Number.isInteger(r.n) || !r.valori || typeof r.valori !== "object") {
      throw new Rifiuto(400, "Riga non valida");
    }
    if (Object.keys(r.valori).length > 60) throw new Rifiuto(400, "Riga non valida");
    const testo = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);
    const rot = r.rotazioneRiposi && typeof r.rotazioneRiposi === "object"
      && typeof r.rotazioneRiposi.nome === "string" && Number.isInteger(r.rotazioneRiposi.scaglione)
      ? { nome: r.rotazioneRiposi.nome.slice(0, 120), scaglione: r.rotazioneRiposi.scaglione } : undefined;
    return {
      n: r.n, valori: r.valori,
      depositoGrezzo: testo(r.depositoGrezzo, 60), categoriaGrezza: testo(r.categoriaGrezza, 60),
      rotazioneRiposi: rot,
      errori: Array.isArray(r.errori) ? r.errori.map(String).slice(0, 20) : [],
      avvisi: Array.isArray(r.avvisi) ? r.avvisi.map(String).slice(0, 20) : [],
    };
  });
}

async function importa(req: Request, scrivi: boolean) {
  const righeFile = leggiRighe(req.body?.righe);
  const scelte = leggiScelte(req.body?.scelte);
  const oggi = oggiRoma();
  try {
    return await db.transaction(async (tx) => {
      const rapporto = await eseguiImport(tx as unknown as Ex, righeFile, scelte, { oggi, userId: req.user?.id ?? null, via: req.authVia ?? null });
      /* prova, o applicazione con errori: si annulla tutto, il rapporto esce con l'eccezione */
      if (!scrivi || rapporto.conteggi.errore > 0) throw new Annulla(rapporto);
      rapporto.applicato = true;
      return rapporto;
    });
  } catch (e) {
    if (e instanceof Annulla) return e.rapporto;
    throw e;
  }
}

router.post("/roster/anagrafica/import/prova", limiteImport, soloPersonale, async (req, res): Promise<void> => {
  try { res.json({ rapporto: await importa(req, false), escludi: ESCLUDI }); }
  catch (e) { rispondiErrore(res, e, "prova dell'import"); }
});

router.post("/roster/anagrafica/import/applica", limiteImport, soloPersonale, async (req, res): Promise<void> => {
  try {
    const rapporto = await importa(req, true);
    res.status(rapporto.applicato ? 200 : 409).json({
      rapporto,
      ...(rapporto.applicato ? {} : { error: "Ci sono righe in errore: non è stato scritto niente" }),
    });
  } catch (e) { rispondiErrore(res, e, "import"); }
});

/* ── Esportazione ───────────────────────────────────────────────────────── */

router.get("/roster/anagrafica/esporta", async (req, res): Promise<void> => {
  try {
    const formato = req.query.formato === "csv" ? "csv" : "xlsx";
    const tutti = req.query.tutti === "1";
    const sensibili = vedeDatiPersonali(req);
    const oggi = oggiRoma();
    const conducenti = (await conducentiPer(req, db as unknown as Ex, { ancheDisattivati: tutti, conFoto: false }))
      .filter(c => !c.isFictitious);
    const info = { sensibili, oggi, generatoIl: new Date().toISOString(), filtro: tutti ? "compresi quelli non più in servizio" : undefined };
    await registra(db as unknown as Ex, {
      ...utente(req), azione: "esporta",
      dettaglio: { formato, righe: conducenti.length, conDatiPersonali: sensibili },
    });
    const nome = `anagrafica-personale-${oggi}`;
    if (formato === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${nome}.csv"`);
      res.send(esportaAnagraficaCsv(conducenti, info));
      return;
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nome}.xlsx"`);
    res.send(esportaAnagraficaXlsx(conducenti, info));
  } catch (e) { rispondiErrore(res, e, "esportazione"); }
});

export default router;
