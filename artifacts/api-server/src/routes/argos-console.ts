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
import { mintShortLivedUserToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { argosHeaders } from "../lib/argos-proxy";
import { UUID_RE, accessoAlProgetto, progettiAccessibili, utenteDi } from "../lib/argos-progetto";
import { erroreLeggibile } from "../middlewares/errori-interni";

const router: IRouter = Router();

const ARGOS_URL = (process.env.ARGOS_URL || "").replace(/\/+$/, "");
const ARGOS_CLIENT_SLUG = process.env.ARGOS_CLIENT_SLUG || "tpl-personale";
const MAX_COMPITO = 4000;

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

  // Su un progetto: prima l'accesso, poi il token a breve scadenza dell'utente.
  let progetto: string | null = null;
  let token: string | null = null;
  if (projectId !== undefined && projectId !== null && projectId !== "") {
    if (typeof projectId !== "string" || !UUID_RE.test(projectId)) { res.status(400).json({ error: "projectId non valido" }); return; }
    const ok = await accessoAlProgetto(projectId, userId).catch(() => null);
    if (!ok) { res.status(404).json({ error: "Progetto non trovato o accesso negato" }); return; }
    progetto = projectId;
    token = mintShortLivedUserToken(userId, (req as any).sessione);
  }

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

export default router;
