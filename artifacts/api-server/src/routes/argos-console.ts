/**
 * La console di Argos (pagina /argos): il proxy verso /console/* di Argos.
 *
 * Il browser non parla mai con Argos: passa da qui, con la sessione e i
 * permessi di Cerbero (area «rete», lib/permessi-rotte.ts). Argos risponde solo
 * a chi porta ARGOS_PROXY_SECRET (lib/argos-proxy.ts).
 *
 * Che cosa si vede: la squadra degli agenti, le skill, il registro delle
 * capacità, le esecuzioni con la loro traccia. Un'esecuzione fatta su un
 * progetto si vede solo se l'utente può aprire quel progetto
 * (lib/argos-progetto.ts): l'elenco filtra, il dettaglio risponde 404. Un
 * agente che lavora su un progetto riceve il token a breve scadenza
 * dell'utente, come il pannello: legge con i suoi diritti, non con altri.
 *
 * Gli errori di Argos arrivano al browser con un testo fisso scritto qui
 * (traduci): quelli sul segreto (401/403/503) come 502 che lo spiega, perché
 * un 401 farebbe credere all'app che la sessione di Cerbero sia scaduta; gli
 * errori interni di Argos senza il loro testo, che resta nel log (tappa 7.13,
 * middlewares/errori-interni.ts). I 5xx scritti qui passano da erroreLeggibile.
 */
import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { mintShortLivedUserToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { legaContesto } from "../lib/contesto-http";
import { argosHeaders } from "../lib/argos-proxy";
import { UUID_RE, accessoAlProgetto, progettiAccessibili, utenteDi } from "../lib/argos-progetto";
import { erroreLeggibile } from "../middlewares/errori-interni";

const router: IRouter = Router();

const ARGOS_URL = (process.env.ARGOS_URL || "").replace(/\/+$/, "");
const ARGOS_CLIENT_SLUG = process.env.ARGOS_CLIENT_SLUG || "tpl-personale";
const MAX_COMPITO = 4000;
const MAX_MESSAGGIO = 8000;
/** Un libro in PDF può essere grande; oltre, meglio dividerlo per pagine. */
export const MAX_FILE = 100 * 1024 * 1024;
const caricamento = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 1 } });
/** Un allegato della chat: un file da leggere nel turno, non un libro. */
export const MAX_ALLEGATO = 25 * 1024 * 1024;
export const MAX_ALLEGATI_TURNO = 5;
/** I formati che Argos legge (argos/ingestion/formati.py): la porta si chiude anche qui. */
export const FORMATI_ALLEGATI = [
  ".pdf", ".md", ".markdown", ".mmd", ".txt", ".text", ".epub",
  ".docx", ".docm", ".xlsx", ".xlsm", ".pptx", ".pptm", ".odt", ".ods", ".odp",
  ".csv", ".tsv", ".html", ".htm", ".json",
  ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp", ".gif",
] as const;
const caricamentoAllegato = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ALLEGATO, files: 1 } });

export function formatoAllegato(nome: string): boolean {
  const i = nome.lastIndexOf(".");
  return i > 0 && (FORMATI_ALLEGATI as readonly string[]).includes(nome.slice(i).toLowerCase());
}

/** La chiave di un agente: minuscole, cifre e trattini (come in Argos, agenti.py). */
export function chiaveValida(chiave: unknown): chiave is string {
  return typeof chiave === "string" && /^[a-z0-9][a-z0-9-]{1,40}$/.test(chiave);
}

/**
 * Lo stato e il testo per il browser, dato lo stato di Argos e il suo detail.
 * Il testo è sempre fisso, tranne i 404 e 429 che Argos scrive apposta
 * («Agente inesistente», «Budget mensile esaurito»): mai il testo di un errore
 * interno di Argos, che può contenere query o tracce.
 */
export function traduci(argos: number, dettaglio: unknown): { stato: number; testo: string } {
  const scritto = typeof dettaglio === "string" && dettaglio.length > 0 && dettaglio.length <= 200 ? dettaglio : null;
  if (argos === 404) return { stato: 404, testo: scritto ?? "Non trovato in Argos" };
  if (argos === 429) return { stato: 429, testo: scritto ?? "Budget mensile di Argos esaurito" };
  if (argos === 400 || argos === 422) return { stato: 400, testo: "Richiesta non valida per Argos" };
  if (argos === 403 && scritto?.startsWith("Agenti disattivati")) return { stato: 503, testo: "Gli agenti sono spenti in Argos (AGENT_ENABLED)" };
  if (argos === 401 || argos === 403) return { stato: 502, testo: "Argos rifiuta il proxy di Cerbero: ARGOS_PROXY_SECRET non coincide (DEPLOY.md)" };
  if (argos === 503) return { stato: 502, testo: "Argos non accetta il proxy: manca ARGOS_PROXY_SECRET su Argos (DEPLOY.md)" };
  if (argos >= 500) return { stato: 502, testo: "Argos ha avuto un errore: il dettaglio è nel suo log" };
  return { stato: 502, testo: `Argos ha risposto ${argos}` };
}

/** Risponde al browser per un errore di Argos; quello che non si mostra va nel log. */
function rispondiErrore(res: any, argos: number, dettaglio: unknown): void {
  const { stato, testo } = traduci(argos, dettaglio);
  if (argos >= 500 || argos === 401 || argos === 403) {
    res.req?.log?.warn?.({ argos, dettaglio: String(typeof dettaglio === "string" ? dettaglio : JSON.stringify(dettaglio ?? "")).slice(0, 500) }, "Argos console: errore da Argos");
  }
  if (stato >= 500) erroreLeggibile(res, stato, testo);
  else res.status(stato).json({ error: testo });
}

/** Argos non risponde (rete, tempo scaduto): testo fisso, l'errore nel log. */
function irraggiungibile(res: any, err: any): void {
  res.req?.log?.warn?.({ err: err?.message }, "Argos console: Argos non raggiungibile");
  erroreLeggibile(res, 502, "Argos non raggiungibile");
}

/** Le esecuzioni che l'utente può vedere: quelle senza progetto, e quelle dei progetti che apre. */
export function soloVisibili<T extends { project_id?: string | null }>(righe: T[], accessibili: Set<string>): T[] {
  return righe.filter((r) => !r.project_id || accessibili.has(r.project_id));
}

function qs(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams({ client_slug: ARGOS_CLIENT_SLUG });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  return q.toString();
}

/** GET su Argos; in caso d'errore risponde lui e ritorna undefined. */
async function leggi(res: any, percorso: string, params: Record<string, string | undefined> = {}): Promise<any | undefined> {
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return undefined;
  }
  try {
    const r = await fetch(`${ARGOS_URL}/console${percorso}?${qs(params)}`, {
      headers: argosHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      rispondiErrore(res, r.status, data?.detail);
      return undefined;
    }
    return data;
  } catch (err: any) {
    irraggiungibile(res, err);
    return undefined;
  }
}

// GET /api/ai/argos/console/registro → ogni strumento con modulo ed effetto
router.get("/ai/argos/console/registro", async (_req, res) => {
  const d = await leggi(res, "/registro");
  if (d !== undefined) res.json(d);
});

// GET /api/ai/argos/console/agenti → la squadra
router.get("/ai/argos/console/agenti", async (_req, res) => {
  const d = await leggi(res, "/agenti");
  if (d !== undefined) res.json(d);
});

// GET /api/ai/argos/console/agenti/:chiave → un agente, con il prompt e le capacità
router.get("/ai/argos/console/agenti/:chiave", async (req, res) => {
  if (!chiaveValida(req.params.chiave)) { res.status(400).json({ error: "chiave dell'agente non valida" }); return; }
  const d = await leggi(res, `/agenti/${req.params.chiave}`);
  if (d !== undefined) res.json(d);
});

// GET /api/ai/argos/console/skill → la biblioteca delle skill, con le versioni
router.get("/ai/argos/console/skill", async (_req, res) => {
  const d = await leggi(res, "/skill");
  if (d !== undefined) res.json(d);
});

// GET /api/ai/argos/console/budget → il consumo del mese
router.get("/ai/argos/console/budget", async (_req, res) => {
  if (!ARGOS_URL) { res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" }); return; }
  try {
    const r = await fetch(`${ARGOS_URL}/budget/${encodeURIComponent(ARGOS_CLIENT_SLUG)}`, {
      headers: argosHeaders(), signal: AbortSignal.timeout(8000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) { rispondiErrore(res, r.status, d?.detail); return; }
    res.json({ used: Number(d.used) || 0, limit: Number(d.limit) || 0, remaining: Number(d.remaining) || 0 });
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Argos non raggiungibile" });
  }
});

// GET /api/ai/argos/console/esecuzioni?agente=&limit= → le ultime, solo quelle visibili
router.get("/ai/argos/console/esecuzioni", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const agente = req.query.agente === undefined ? undefined : String(req.query.agente);
  if (agente !== undefined && !chiaveValida(agente)) { res.status(400).json({ error: "agente non valido" }); return; }
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 100));
  const d = await leggi(res, "/esecuzioni", { agente, limit: String(limit) });
  if (d === undefined) return;
  const righe: any[] = Array.isArray(d?.esecuzioni) ? d.esecuzioni : [];
  const accessibili = await progettiAccessibili(righe.map((r) => String(r.project_id || "")).filter(Boolean), userId);
  const visibili = soloVisibili(righe, accessibili);
  res.json({ totale: visibili.length, esecuzioni: visibili });
});

// GET /api/ai/argos/console/esecuzioni/:id → run, eventi in ordine, proposte
router.get("/ai/argos/console/esecuzioni/:id", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  const d = await leggi(res, `/esecuzioni/${req.params.id}`);
  if (d === undefined) return;
  if (d?.project_id) {
    const ok = await accessoAlProgetto(String(d.project_id), userId).catch(() => null);
    // 404, non 403: chi non apre il progetto non deve sapere che l'esecuzione esiste
    if (!ok) { res.status(404).json({ error: "Esecuzione inesistente" }); return; }
  }
  res.json(d);
});

// POST /api/ai/argos/console/agenti/:chiave/esegui  { compito, projectId? } → SSE
router.post("/ai/argos/console/agenti/:chiave/esegui", async (req, res) => {
  if (!chiaveValida(req.params.chiave)) { res.status(400).json({ error: "chiave dell'agente non valida" }); return; }
  const { compito, projectId } = (req.body ?? {}) as { compito?: unknown; projectId?: unknown };
  const testo = typeof compito === "string" ? compito.trim() : "";
  if (!testo || testo.length > MAX_COMPITO) { res.status(400).json({ error: `compito richiesto, al massimo ${MAX_COMPITO} caratteri` }); return; }
  if (!ARGOS_URL) { res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" }); return; }
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }

  // Su un progetto: prima l'accesso. Poi il token a breve scadenza dell'utente, anche
  // senza progetto: serve agli strumenti con permessi propri (i turni salvati della
  // Fucina), che Cerbero controlla su quel token come nell'interfaccia dell'utente.
  let progetto: string | null = null;
  if (projectId !== undefined && projectId !== null && projectId !== "") {
    if (typeof projectId !== "string" || !UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const ok = await accessoAlProgetto(projectId, userId).catch(() => null);
    if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }
    progetto = projectId;
  }
  const token = mintShortLivedUserToken(userId, (req as any).sessione);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const errore = (message: string) => res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());

  try {
    const upstream = await fetch(`${ARGOS_URL}/console/agenti/${req.params.chiave}/esegui`, {
      method: "POST",
      headers: argosHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ compito: testo, client_slug: ARGOS_CLIENT_SLUG, project_id: progetto, ti_auth_token: token }),
      signal: ctrl.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const d: any = await upstream.json().catch(() => ({}));
      if (upstream.status >= 500 || upstream.status === 401 || upstream.status === 403) {
        logger.warn({ argos: upstream.status, dettaglio: String(d?.detail ?? "").slice(0, 500) }, "Argos console: esecuzione rifiutata da Argos");
      }
      errore(traduci(upstream.status, d?.detail).testo);
      res.end();
      return;
    }
    for await (const chunk of upstream.body as any) res.write(chunk);
    res.end();
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      // il testo dell'errore resta nel log: nello stream va un testo fisso (tappa 7.13)
      logger.error({ err: err?.message }, "Argos console: esecuzione interrotta");
      errore("Collegamento con Argos interrotto: l'esecuzione resta nell'ispettore fin dove è arrivata");
    }
    res.end();
  }
});

// ─── La biblioteca ───────────────────────────────────────────────────────
// Leggere: chi ha l'area Rete. Caricare, modificare, eliminare, ricostruire:
// solo l'amministratore (la biblioteca è dell'azienda, non di un progetto).

function soloAdmin(req: any, res: any): boolean {
  if (req.user?.role === "admin") return true;
  res.status(403).json({ error: "Solo l'amministratore può modificare la biblioteca di Argos" });
  return false;
}

/** Richiesta a Argos con un corpo; risponde lui in caso d'errore e ritorna undefined. */
async function scrivi(res: any, metodo: string, percorso: string, corpo?: unknown, params: Record<string, string | undefined> = {}): Promise<any | undefined> {
  if (!ARGOS_URL) {
    res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" });
    return undefined;
  }
  try {
    const r = await fetch(`${ARGOS_URL}${percorso}?${qs(params)}`, {
      method: metodo,
      headers: argosHeaders(corpo === undefined ? {} : { "content-type": "application/json" }),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(20000),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) { rispondiErrore(res, r.status, data?.detail); return undefined; }
    return data;
  } catch (err: any) {
    irraggiungibile(res, err);
    return undefined;
  }
}

router.get("/ai/argos/console/biblioteca", async (_req, res) => {
  const d = await leggi(res, "/biblioteca");
  if (d !== undefined) res.json(d);
});

router.get("/ai/argos/console/biblioteca/caricamenti", async (req, res) => {
  const stato = req.query.stato === undefined ? undefined : String(req.query.stato);
  if (stato !== undefined && !["queued", "running", "done", "error"].includes(stato)) { res.status(400).json({ error: "stato non valido" }); return; }
  const limit = String(Math.max(1, Math.min(Number(req.query.limit) || 30, 200)));
  const d = await leggi(res, "/biblioteca/caricamenti", { stato, limit });
  if (d !== undefined) res.json(d);
});

router.get("/ai/argos/console/biblioteca/documenti/:id", async (req, res) => {
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  const limit = String(Math.max(1, Math.min(Number(req.query.limit) || 30, 100)));
  const d = await leggi(res, `/biblioteca/documenti/${req.params.id}`, { limit });
  if (d !== undefined) res.json(d);
});

// POST /api/ai/argos/console/biblioteca/carica  (multipart: file + opzioni) → in coda su Argos
router.post("/ai/argos/console/biblioteca/carica", (req, res, next) => {
  if (!soloAdmin(req, res)) return;
  legaContesto(caricamento.single("file"))(req, res, (err: any) => {
    if (err) {
      const troppo = err?.code === "LIMIT_FILE_SIZE";
      res.status(troppo ? 413 : 400).json({ error: troppo ? `File oltre ${MAX_FILE / (1024 * 1024)} MB: dividilo per pagine` : "Caricamento non valido" });
      return;
    }
    next();
  });
}, async (req: any, res) => {
  const file = req.file as { originalname: string; buffer: Buffer; mimetype: string } | undefined;
  if (!file) { res.status(400).json({ error: "file mancante" }); return; }
  if (!ARGOS_URL) { res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" }); return; }
  const b = req.body ?? {};
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/octet-stream" }), file.originalname.slice(0, 250));
  form.append("client_slug", ARGOS_CLIENT_SLUG);
  for (const k of ["category", "title"]) {
    const v = typeof b[k] === "string" ? b[k].trim().slice(0, 300) : "";
    if (v) form.append(k, v);
  }
  for (const k of ["page_from", "page_to"]) {
    if (b[k] !== undefined && b[k] !== "" && /^\d{1,5}$/.test(String(b[k]))) form.append(k, String(b[k]));
  }
  form.append("parser", ["auto", "mathpix", "text", "markdown"].includes(b.parser) ? b.parser : "auto");
  form.append("replace", b.replace === "true" || b.replace === true ? "true" : "false");
  try {
    const r = await fetch(`${ARGOS_URL}/console/biblioteca/carica`, {
      method: "POST", headers: argosHeaders(), body: form, signal: AbortSignal.timeout(120000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) { rispondiErrore(res, r.status, d?.detail); return; }
    res.json(d);
  } catch (err: any) {
    irraggiungibile(res, err);
  }
});

router.post("/ai/argos/console/biblioteca/caricamenti/riprova-errori", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  const d = await scrivi(res, "POST", "/console/biblioteca/caricamenti/riprova-errori");
  if (d !== undefined) res.json(d);
});

router.post("/ai/argos/console/biblioteca/caricamenti/:id/riprova", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  const d = await scrivi(res, "POST", `/console/biblioteca/caricamenti/${req.params.id}/riprova`);
  if (d !== undefined) res.json(d);
});

// DELETE /api/ai/argos/console/biblioteca/caricamenti/:id → un caricamento non riuscito (o
// sbagliato) se ne va: in errore il job e il suo file; fatto, anche il documento che ha creato.
router.delete("/ai/argos/console/biblioteca/caricamenti/:id", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  const d = await scrivi(res, "DELETE", `/console/biblioteca/caricamenti/${req.params.id}`);
  if (d !== undefined) res.json(d);
});

router.patch("/ai/argos/console/biblioteca/documenti/:id", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  const b = req.body ?? {};
  const corpo: Record<string, string | null> = {};
  if (typeof b.title === "string") corpo.title = b.title.slice(0, 300);
  if (typeof b.category === "string" || b.category === null) corpo.category = b.category === null ? null : String(b.category).slice(0, 120);
  if (!Object.keys(corpo).length) { res.status(400).json({ error: "niente da modificare" }); return; }
  const d = await scrivi(res, "PATCH", `/console/biblioteca/documenti/${req.params.id}`, corpo);
  if (d !== undefined) res.json(d);
});

router.delete("/ai/argos/console/biblioteca/documenti/:id", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  const d = await scrivi(res, "DELETE", `/console/biblioteca/documenti/${req.params.id}`);
  if (d !== undefined) res.json(d);
});

router.post("/ai/argos/console/biblioteca/categorie", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  const nome = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!nome || nome.length > 120) { res.status(400).json({ error: "nome della categoria non valido" }); return; }
  const d = await scrivi(res, "POST", "/console/biblioteca/categorie", { name: nome, client_slug: ARGOS_CLIENT_SLUG });
  if (d !== undefined) res.json(d);
});

router.delete("/ai/argos/console/biblioteca/categorie", async (req, res) => {
  if (!soloAdmin(req, res)) return;
  const nome = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (!nome || nome.length > 120) { res.status(400).json({ error: "nome della categoria non valido" }); return; }
  const d = await scrivi(res, "DELETE", "/console/biblioteca/categorie", undefined, { name: nome });
  if (d !== undefined) res.json(d);
});

for (const [percorso, argos] of [["concetti", "/console/biblioteca/concetti"], ["cervello", "/console/biblioteca/cervello"]] as const) {
  router.post(`/ai/argos/console/biblioteca/${percorso}`, async (req, res) => {
    if (!soloAdmin(req, res)) return;
    const d = await scrivi(res, "POST", argos);
    if (d !== undefined) res.json(d);
  });
}

// ─── Le mappe ────────────────────────────────────────────────────────────
// Documenti come nodi (affinità fra i loro embedding), il grafo dei concetti,
// i collegamenti per sezione di un documento. Niente token.

async function mappa(res: any, percorso: string, params: Record<string, string | undefined> = {}): Promise<void> {
  if (!ARGOS_URL) { res.status(503).json({ error: "Argos non configurato (ARGOS_URL mancante)" }); return; }
  try {
    const r = await fetch(`${ARGOS_URL}${percorso}?${qs(params)}`, { headers: argosHeaders(), signal: AbortSignal.timeout(30000) });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) { rispondiErrore(res, r.status, d?.detail); return; }
    res.json(d);
  } catch (err: any) {
    irraggiungibile(res, err);
  }
}

router.get("/ai/argos/console/mappa/documenti", async (_req, res) => { await mappa(res, "/graph"); });
router.get("/ai/argos/console/mappa/concetti", async (req, res) => {
  await mappa(res, "/graph/concepts", { limit: String(Math.max(10, Math.min(Number(req.query.limit) || 120, 300))) });
});
router.get("/ai/argos/console/mappa/documento/:id", async (req, res) => {
  if (!/^\d{1,12}$/.test(req.params.id)) { res.status(400).json({ error: "id non valido" }); return; }
  await mappa(res, `/graph/doc/${req.params.id}`, { limit: "40" });
});

// ─── Le conversazioni ────────────────────────────────────────────────────
// Si salvano in Argos, intere (gli strumenti compresi): niente si perde e il
// modello non rifà ciò che ha già fatto. Sono dell'utente che le crea:
// l'autore è il suo id, scritto qui e mai preso dal browser. Una conversazione
// su un progetto si apre solo se l'utente apre ancora quel progetto (controllo
// a ogni lettura e a ogni turno); l'elenco nasconde le altre. Il Pianificatore
// lavora su un progetto, col token a breve scadenza dell'utente.

const MODI = ["risposta", "analisi", "agente"] as const;
const MODALITA = ["agente", "piano", "accetta"] as const;

/** La conversazione da Argos, se è dell'utente e il suo progetto è ancora suo; altrimenti ha già risposto. */
async function conversazioneVisibile(res: any, userId: string, id: string): Promise<any | undefined> {
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "conversazione non valida" }); return undefined; }
  const d = await leggi(res, `/conversazioni/${id}`, { autore: userId });
  if (d === undefined) return undefined;
  const progetto = d?.conversazione?.progetto;
  if (progetto) {
    const ok = await accessoAlProgetto(progetto, userId).catch(() => null);
    if (!ok) { res.status(404).json({ error: "Conversazione non trovata o progetto non più accessibile" }); return undefined; }
  }
  return d;
}

// GET /api/ai/argos/console/conversazioni?progetto=&archiviate=1 → le mie conversazioni
router.get("/ai/argos/console/conversazioni", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const progetto = req.query.progetto === undefined || req.query.progetto === "" ? undefined : String(req.query.progetto);
  if (progetto !== undefined) {
    if (!UUID_RE.test(progetto)) { res.status(400).json({ error: "progetto non valido" }); return; }
    const ok = await accessoAlProgetto(progetto, userId).catch(() => null);
    if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }
  }
  const archiviate = req.query.archiviate === "1" || req.query.archiviate === "true" ? "true" : "false";
  const d = await leggi(res, "/conversazioni", { autore: userId, progetto, archiviate, limit: "100" });
  if (d === undefined) return;
  const righe: any[] = Array.isArray(d?.conversazioni) ? d.conversazioni : [];
  const accessibili = await progettiAccessibili(righe.map((r) => r.progetto).filter(Boolean), userId).catch(() => new Set<string>());
  res.json({ conversazioni: righe.filter((r) => !r.progetto || accessibili.has(r.progetto)) });
});

// POST /api/ai/argos/console/conversazioni { modo, agente?, progetto?, titolo? }
router.post("/ai/argos/console/conversazioni", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const modo = typeof b.modo === "string" && (MODI as readonly string[]).includes(b.modo) ? b.modo : null;
  if (!modo) { res.status(400).json({ error: "modo non valido (risposta, analisi, agente)" }); return; }
  const agente = b.agente === undefined || b.agente === null || b.agente === "" ? null : b.agente;
  if (modo === "agente" ? !chiaveValida(agente) : agente !== null) {
    res.status(400).json({ error: "l'agente si sceglie solo, e sempre, nel modo «agente»" }); return;
  }
  const progetto = b.progetto === undefined || b.progetto === null || b.progetto === "" ? null : b.progetto;
  if (progetto !== null) {
    if (typeof progetto !== "string" || !UUID_RE.test(progetto)) { res.status(400).json({ error: "progetto non valido" }); return; }
    const ok = await accessoAlProgetto(progetto, userId).catch(() => null);
    if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }
  }
  if (agente === "pianificatore" && !progetto) { res.status(400).json({ error: "Il Pianificatore lavora su un progetto: sceglilo" }); return; }
  const titolo = typeof b.titolo === "string" ? b.titolo.trim().slice(0, 120) : "";
  const d = await scrivi(res, "POST", "/console/conversazioni",
    { autore: userId, modo, agente, progetto, titolo, client_slug: ARGOS_CLIENT_SLUG });
  if (d !== undefined) res.status(201).json(d);
});

// GET /api/ai/argos/console/conversazioni/pannello?projectId= → le chat del vecchio pannello di quel progetto
router.get("/ai/argos/console/conversazioni/pannello", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const projectId = String(req.query.projectId || "");
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
  const ok = await accessoAlProgetto(projectId, userId).catch(() => null);
  if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }
  const r = await db.execute(sql`
    SELECT thread, count(*)::int AS n FROM ps_argos_messages
     WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid GROUP BY thread`);
  const conta: Record<string, number> = { chat: 0, agente: 0 };
  for (const x of ((r as any).rows ?? []) as Array<{ thread: string; n: number }>) conta[x.thread === "agente" ? "agente" : "chat"] = x.n;
  res.json(conta);
});

// POST /api/ai/argos/console/conversazioni/importa-pannello { projectId, thread } → conversazione da riprendere
router.post("/ai/argos/console/conversazioni/importa-pannello", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const { projectId, thread } = (req.body ?? {}) as { projectId?: unknown; thread?: unknown };
  if (typeof projectId !== "string" || !UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
  if (thread !== "chat" && thread !== "agente") { res.status(400).json({ error: "thread non valido (chat, agente)" }); return; }
  const ok = await accessoAlProgetto(projectId, userId).catch(() => null);
  if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }
  const r = await db.execute(sql`
    SELECT role, content FROM ps_argos_messages
     WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid AND thread = ${thread}
     ORDER BY id LIMIT 2000`);
  const messaggi = ((r as any).rows ?? []) as Array<{ role: string; content: string }>;
  if (!messaggi.length) { res.status(404).json({ error: "Nessuna chat del pannello da importare" }); return; }
  const d = await scrivi(res, "POST", "/console/conversazioni/importa", {
    autore: userId, client_slug: ARGOS_CLIENT_SLUG, progetto: projectId,
    modo: thread === "agente" ? "agente" : "risposta", agente: thread === "agente" ? "pianificatore" : null,
    titolo: thread === "agente" ? "Dal pannello · Pianificatore" : "Dal pannello · Chat",
    messaggi: messaggi.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "").slice(0, 100_000) })),
  });
  if (d !== undefined) res.status(201).json(d);
});

// GET /api/ai/argos/console/conversazioni/:id → la conversazione, con domande e risposte
router.get("/ai/argos/console/conversazioni/:id", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const d = await conversazioneVisibile(res, userId, req.params.id);
  if (d !== undefined) res.json(d);
});

// PATCH /api/ai/argos/console/conversazioni/:id { titolo?, archiviata? }
router.patch("/ai/argos/console/conversazioni/:id", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const corpo: Record<string, unknown> = { autore: userId, client_slug: ARGOS_CLIENT_SLUG };
  if (typeof b.titolo === "string") corpo.titolo = b.titolo.trim().slice(0, 120);
  if (typeof b.archiviata === "boolean") corpo.archiviata = b.archiviata;
  if (Object.keys(corpo).length === 2) { res.status(400).json({ error: "niente da modificare" }); return; }
  if ((await conversazioneVisibile(res, userId, req.params.id)) === undefined) return;
  const d = await scrivi(res, "PATCH", `/console/conversazioni/${req.params.id}`, corpo);
  if (d !== undefined) res.json(d);
});

// DELETE /api/ai/argos/console/conversazioni/:id
router.delete("/ai/argos/console/conversazioni/:id", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  if ((await conversazioneVisibile(res, userId, req.params.id)) === undefined) return;
  const d = await scrivi(res, "DELETE", `/console/conversazioni/${req.params.id}`, undefined, { autore: userId });
  if (d !== undefined) res.json(d);
});

// POST /api/ai/argos/console/conversazioni/:id/messaggi { testo, modalita?, traccia? } → SSE
// traccia: true chiede ad Argos anche la traccia del ragionamento (retrieval e
// verifica delle frasi) per l'animazione della scheda Conversazione: la vede
// solo chi fa il turno, come le fonti della risposta.
// ─── Gli allegati della conversazione ───────────────────────────────────────
// Un file si carica nella conversazione (sua, controllata qui) e Argos lo legge
// subito; il turno dopo lo nomina per id. I dati delle persone non passano:
// Argos rifiuta i file in cui li trova (argos/api/allegati.py).

// POST /api/ai/argos/console/conversazioni/:id/allegati (multipart: file)
router.post("/ai/argos/console/conversazioni/:id/allegati", (req, res, next) => {
  legaContesto(caricamentoAllegato.single("file"))(req, res, (err: any) => {
    if (err) {
      const troppo = err?.code === "LIMIT_FILE_SIZE";
      res.status(troppo ? 413 : 400).json({ error: troppo ? `File oltre ${MAX_ALLEGATO / (1024 * 1024)} MB` : "Caricamento non valido" });
      return;
    }
    next();
  });
}, async (req: any, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const file = req.file as { originalname: string; buffer: Buffer; mimetype: string } | undefined;
  if (!file) { res.status(400).json({ error: "file mancante" }); return; }
  const nome = String(file.originalname || "").split(/[\\/]/).pop()!.slice(0, 200);
  if (!formatoAllegato(nome)) {
    res.status(400).json({ error: `Formato non supportato. Si possono allegare: ${FORMATI_ALLEGATI.join(" ")}` });
    return;
  }
  if ((await conversazioneVisibile(res, userId, req.params.id)) === undefined) return;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "application/octet-stream" }), nome);
  form.append("autore", userId);
  form.append("client_slug", ARGOS_CLIENT_SLUG);
  try {
    const r = await fetch(`${ARGOS_URL}/console/conversazioni/${req.params.id}/allegati`, {
      method: "POST", headers: argosHeaders(), body: form, signal: AbortSignal.timeout(120000),
    });
    const d: any = await r.json().catch(() => ({}));
    // il perché di un file rifiutato (formato, dimensione, dati di persone) è scritto per chi carica
    if ((r.status === 400 || r.status === 413) && typeof d?.detail === "string" && d.detail.length <= 400) {
      res.status(r.status).json({ error: d.detail });
      return;
    }
    if (!r.ok) { rispondiErrore(res, r.status, d?.detail); return; }
    res.json(d);
  } catch (err: any) {
    irraggiungibile(res, err);
  }
});

// GET /api/ai/argos/console/conversazioni/:id/allegati
router.get("/ai/argos/console/conversazioni/:id/allegati", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  if ((await conversazioneVisibile(res, userId, req.params.id)) === undefined) return;
  const d = await leggi(res, `/conversazioni/${req.params.id}/allegati`, { autore: userId });
  if (d !== undefined) res.json(d);
});

// POST /api/ai/argos/console/conversazioni/:id/allegati/:allegato/impara { titolo?, categoria? }
// L'interruttore «📚 Biblioteca»: chi ha caricato il documento lo mette nella
// Biblioteca di Argos, che da lì si alimenta (concetti e cervello). È scrivere
// nella memoria comune di Argos: chiede la scrittura sull'area, come ogni POST
// che non sta fra quelle che calcolano soltanto.
router.post("/ai/argos/console/conversazioni/:id/allegati/:allegato/impara", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  if (!UUID_RE.test(req.params.allegato)) { res.status(400).json({ error: "allegato non valido" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const corpo: Record<string, string> = { autore: userId, client_slug: ARGOS_CLIENT_SLUG };
  for (const [k, max] of [["titolo", 200], ["categoria", 120]] as const) {
    if (typeof b[k] === "string" && b[k].trim()) corpo[k] = b[k].trim().slice(0, max);
  }
  if ((await conversazioneVisibile(res, userId, req.params.id)) === undefined) return;
  try {
    const r = await fetch(`${ARGOS_URL}/console/conversazioni/${req.params.id}/allegati/${req.params.allegato}/impara`, {
      method: "POST", headers: argosHeaders({ "content-type": "application/json" }), body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(30000),
    });
    const d: any = await r.json().catch(() => ({}));
    // il perché di un rifiuto (dati di persone, troppo poco testo, già dentro, tetto) è scritto per chi carica
    if (r.status === 400 && typeof d?.detail === "string" && d.detail.length <= 400) { res.status(400).json({ error: d.detail }); return; }
    if (!r.ok) { rispondiErrore(res, r.status, d?.detail); return; }
    res.json(d);
  } catch (err: any) {
    irraggiungibile(res, err);
  }
});

// DELETE /api/ai/argos/console/conversazioni/:id/allegati/:allegato
router.delete("/ai/argos/console/conversazioni/:id/allegati/:allegato", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  if (!UUID_RE.test(req.params.allegato)) { res.status(400).json({ error: "allegato non valido" }); return; }
  if ((await conversazioneVisibile(res, userId, req.params.id)) === undefined) return;
  const d = await scrivi(res, "DELETE", `/console/conversazioni/${req.params.id}/allegati/${req.params.allegato}`, undefined, { autore: userId });
  if (d !== undefined) res.json(d);
});

/** Gli allegati di un turno: al più cinque id di allegato; altro → null (richiesta non valida). */
export function allegatiDelTurno(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_ALLEGATI_TURNO) return null;
  if (!v.every((x) => typeof x === "string" && UUID_RE.test(x))) return null;
  return [...new Set(v as string[])];
}

router.post("/ai/argos/console/conversazioni/:id/messaggi", async (req, res) => {
  const userId = utenteDi(req);
  if (!userId) { res.status(401).json({ error: "Non autenticato" }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const testo = typeof b.testo === "string" ? b.testo.trim() : "";
  if (!testo || testo.length > MAX_MESSAGGIO) { res.status(400).json({ error: `messaggio richiesto, al massimo ${MAX_MESSAGGIO} caratteri` }); return; }
  const modalita = b.modalita === undefined ? "agente" : b.modalita;
  if (typeof modalita !== "string" || !(MODALITA as readonly string[]).includes(modalita)) {
    res.status(400).json({ error: "modalità non valida (agente, piano, accetta)" }); return;
  }
  if (b.traccia !== undefined && typeof b.traccia !== "boolean") { res.status(400).json({ error: "traccia: sì o no" }); return; }
  const traccia = b.traccia === true;
  // «Calcoli»: l'utente permette, in QUESTO turno, che la squadra di Argos lanci i giri
  // dell'ottimizzatore (salvano uno scenario nuovo, l'orario non si tocca). Il giro passa
  // comunque da qui col token dell'utente: senza scrittura sui turni Cerbero lo rifiuta.
  if (b.calcoli !== undefined && typeof b.calcoli !== "boolean") { res.status(400).json({ error: "calcoli: sì o no" }); return; }
  const calcoli = b.calcoli === true;
  const allegati = allegatiDelTurno(b.allegati);
  if (allegati === null) { res.status(400).json({ error: `allegati: al più ${MAX_ALLEGATI_TURNO} allegati validi` }); return; }
  const d = await conversazioneVisibile(res, userId, req.params.id);
  if (d === undefined) return;
  // Il token a breve scadenza dell'utente, in ogni turno: sul progetto (l'accesso è
  // appena stato controllato) per gli strumenti di Planning Studio; con o senza progetto,
  // in Risposta e Analisi come con gli agenti, per le letture con permessi propri (turni
  // guida salvati, parco dell'officina, roster per soli conteggi). Resta fra Argos e
  // Cerbero: al modello arrivano i risultati delle letture, mai il token. Col token di
  // Argos /admin, /auth e il roster con le persone restano chiusi (percorsoVietatoAiServizi).
  const token = mintShortLivedUserToken(userId, (req as any).sessione);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const errore = (message: string) => res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  try {
    const upstream = await fetch(`${ARGOS_URL}/console/conversazioni/${req.params.id}/messaggi`, {
      method: "POST",
      headers: argosHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ autore: userId, testo, modalita, traccia, allegati, calcoli, ti_auth_token: token, client_slug: ARGOS_CLIENT_SLUG }),
      signal: ctrl.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const e: any = await upstream.json().catch(() => ({}));
      if (upstream.status >= 500 || upstream.status === 401 || upstream.status === 403) {
        logger.warn({ argos: upstream.status, dettaglio: String(e?.detail ?? "").slice(0, 500) }, "Argos console: turno rifiutato da Argos");
      }
      // 409: un turno è già in corso; 429: budget. Argos li scrive apposta.
      errore(upstream.status === 409 ? "C'è già un turno in corso in questa conversazione" : traduci(upstream.status, e?.detail).testo);
      res.end();
      return;
    }
    for await (const chunk of upstream.body as any) res.write(chunk);
    res.end();
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      logger.error({ err: err?.message }, "Argos console: turno interrotto");
      errore("Collegamento con Argos interrotto: la conversazione conserva il lavoro fatto fin lì");
    }
    res.end();
  }
});

export default router;

