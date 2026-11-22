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
 * Gli errori di Argos sul segreto (401/403/503) arrivano al browser come 502
 * con la spiegazione: un 401 qui farebbe credere all'app che la sessione di
 * Cerbero sia scaduta.
 */
import { Router, type IRouter } from "express";
import { mintShortLivedUserToken } from "../lib/auth";
import { logger } from "../lib/logger";
import { argosHeaders } from "../lib/argos-proxy";
import { UUID_RE, accessoAlProgetto, progettiAccessibili, utenteDi } from "../lib/argos-progetto";

const router: IRouter = Router();

const ARGOS_URL = (process.env.ARGOS_URL || "").replace(/\/+$/, "");
const ARGOS_CLIENT_SLUG = process.env.ARGOS_CLIENT_SLUG || "tpl-personale";
const MAX_COMPITO = 4000;

/** La chiave di un agente: minuscole, cifre e trattini (come in Argos, agenti.py). */
export function chiaveValida(chiave: unknown): chiave is string {
  return typeof chiave === "string" && /^[a-z0-9][a-z0-9-]{1,40}$/.test(chiave);
}

/** Lo stato HTTP per il browser, dato quello di Argos. */
export function statoPerIlBrowser(argos: number): number {
  if (argos === 404) return 404;
  if (argos === 422 || argos === 400) return 400;
  if (argos === 429) return 429;
  return 502; // 401/403/503 (segreto), 5xx: il problema è fra Cerbero e Argos
}

/** Il messaggio per il browser, dato quello di Argos. */
export function motivoPerIlBrowser(argos: number, dettaglio: string): string {
  if (argos === 401 || argos === 403) return "Argos rifiuta il proxy di Cerbero: ARGOS_PROXY_SECRET non coincide (DEPLOY.md)";
  if (argos === 503) return dettaglio || "Argos non è pronto: manca ARGOS_PROXY_SECRET o gli agenti sono spenti";
  return dettaglio || `Argos ha risposto ${argos}`;
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
      res.status(statoPerIlBrowser(r.status)).json({ error: motivoPerIlBrowser(r.status, String(data?.detail ?? "")) });
      return undefined;
    }
    return data;
  } catch (err: any) {
    res.status(502).json({ error: err?.message || "Argos non raggiungibile" });
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
    if (!r.ok) { res.status(statoPerIlBrowser(r.status)).json({ error: motivoPerIlBrowser(r.status, String(d?.detail ?? "")) }); return; }
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
      errore(motivoPerIlBrowser(upstream.status, typeof d?.detail === "string" ? d.detail : ""));
      res.end();
      return;
    }
    for await (const chunk of upstream.body as any) res.write(chunk);
    res.end();
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      logger.error({ err: err?.message }, "Argos console: esecuzione interrotta");
      errore(err?.message || "Errore del proxy verso Argos");
    }
    res.end();
  }
});

export default router;
