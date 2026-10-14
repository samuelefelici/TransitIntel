/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PUBBLICAZIONE DEI TURNI NEL ROSTER — le rotte
 * ───────────────────────────────────────────────────────────────────────────
 * Il canale unico fra Scheduling Engine e Roster (lib/roster-pubblicazione*.ts):
 *
 *   GET  /api/roster/pubblicazioni/programmi   i programmi che si possono pubblicare
 *   POST /api/roster/pubblicazioni/anteprima   {psProjectId, dal, al, scelte?} → cosa succederebbe
 *   POST /api/roster/pubblicazioni             {psProjectId, dal, al, scelte, gettone, passato?, nota?}
 *   POST /api/roster/pubblicazioni/ritira      {dal, al, psProjectId?, udpIds?, passato?, nota?}
 *   GET  /api/roster/pubblicazioni             il registro
 *
 * Permesso: «scheduling», come tutto il roster (lib/auth.ts, prefisso /roster).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter, type Response } from "express";
import { assicuraAnagrafica } from "../lib/anagrafica-store";
import {
  anteprima, assicuraPubblicazione, programmi, pubblica, registro, ritira, RifiutoPubblicazione,
} from "../lib/roster-pubblicazione-db";

const router: IRouter = Router();

router.use(async (req, res, next) => {
  if (!req.path.toLowerCase().startsWith("/roster/pubblicazioni")) { next(); return; }
  try { await assicuraAnagrafica(); await assicuraPubblicazione(); }
  catch { res.status(503).json({ error: "Pubblicazione non disponibile: riprova tra poco" }); return; }
  next();
});

const chi = (req: any) => ({ userId: (req.user?.id ?? null) as string | null, via: (req.authVia ?? null) as string | null, admin: req.user?.role === "admin" });

function rispondi(res: Response, e: any, contesto: string): void {
  if (e instanceof RifiutoPubblicazione) { res.status(e.status).json({ error: e.message, ...e.extra }); return; }
  const codice = e?.cause?.code ?? e?.code;
  if (codice === "40P01" || codice === "55P03") { res.status(409).json({ error: "Qualcun altro sta pubblicando o assegnando turni: riprova" }); return; }
  console.error(`[roster.pubblicazione] ${contesto}:`, codice ?? e?.message);
  res.status(500).json({ error: "Errore interno della pubblicazione" });
}

const testo = (v: unknown) => (typeof v === "string" ? v : "");
const scelteDa = (v: unknown): Record<string, string | null> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k.toLowerCase()] = typeof x === "string" && x ? x.toLowerCase() : null;
  return out;
};

router.get("/roster/pubblicazioni/programmi", async (req, res): Promise<void> => {
  try {
    const c = chi(req);
    res.json({ programmi: await programmi(c.userId ?? "", c.admin) });
  } catch (e) { rispondi(res, e, "programmi"); }
});

router.post("/roster/pubblicazioni/anteprima", async (req, res): Promise<void> => {
  try {
    const c = chi(req);
    const b = req.body ?? {};
    res.json(await anteprima({ psProjectId: testo(b.psProjectId).toLowerCase(), dal: testo(b.dal), al: testo(b.al), scelte: scelteDa(b.scelte) }, c.userId ?? "", c.admin));
  } catch (e) { rispondi(res, e, "anteprima"); }
});

router.post("/roster/pubblicazioni", async (req, res): Promise<void> => {
  try {
    const c = chi(req);
    const b = req.body ?? {};
    const scelte = scelteDa(b.scelte);
    if (!scelte) { res.status(400).json({ error: "scelte richieste: per ogni UDP il turno guida, o null" }); return; }
    if (!testo(b.gettone)) { res.status(400).json({ error: "gettone dell'anteprima richiesto" }); return; }
    res.status(201).json(await pubblica({
      psProjectId: testo(b.psProjectId).toLowerCase(), dal: testo(b.dal), al: testo(b.al), scelte,
      gettone: testo(b.gettone), passato: b.passato === true, nota: testo(b.nota).slice(0, 500) || null,
    }, c.userId, c.via, c.admin));
  } catch (e) { rispondi(res, e, "pubblica"); }
});

router.post("/roster/pubblicazioni/ritira", async (req, res): Promise<void> => {
  try {
    const c = chi(req);
    const b = req.body ?? {};
    res.json(await ritira({
      dal: testo(b.dal), al: testo(b.al), psProjectId: testo(b.psProjectId).toLowerCase() || null,
      udpIds: Array.isArray(b.udpIds) ? b.udpIds.map((x: unknown) => testo(x).toLowerCase()) : null,
      passato: b.passato === true, nota: testo(b.nota).slice(0, 500) || null,
    }, c.userId, c.admin));
  } catch (e) { rispondi(res, e, "ritira"); }
});

router.get("/roster/pubblicazioni", async (_req, res): Promise<void> => {
  try { res.json({ pubblicazioni: await registro() }); }
  catch (e) { rispondi(res, e, "registro"); }
});

export default router;
