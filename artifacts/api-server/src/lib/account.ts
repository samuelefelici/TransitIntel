/**
 * Sicurezza dell'account: cambio della password, verifica in due passaggi
 * (attiva, conferma, disattiva, nuovi codici di recupero), «esci da tutti i
 * dispositivi», e per l'admin il registro degli accessi.
 *
 *   POST /api/auth/password            { attuale, nuova }
 *   POST /api/auth/mfa/attiva          → { segreto, uri } (non ancora attiva)
 *   POST /api/auth/mfa/conferma        { codice } → { codiciRecupero }
 *   POST /api/auth/mfa/disattiva       { codice } (solo se il ruolo non la chiede)
 *   POST /api/auth/mfa/codici-recupero { codice } → { codiciRecupero }
 *   POST /api/auth/sessioni/chiudi     tutte le altre sessioni decadono
 *   GET  /api/admin/accessi?limite=&utente=
 *
 * Ogni cambio alza la versione della sessione (le altre sessioni decadono) e
 * riemette il cookie di questa, così chi lo fa resta dentro.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { BCRYPT_ROUNDS, registraAccesso, requireAdmin, requireAuth, setAuthCookie, signToken } from "./auth";
import { erroreNuovaPassword } from "./password-regole";
import { nuovoSegreto, uriOtpauth, verificaCodice } from "./totp";
import { cifra, decifra } from "./mfa-cifratura";
import { improntaRecupero, mfaObbligatoria, nuoviCodiciDiRecupero } from "./accesso-regole";

const router: IRouter = Router();

/** La versione della sessione è salita: si riemette il cookie di chi ha fatto il cambio. */
function nuovaSessione(req: Request, res: Response, sv: number, mfa: boolean): void {
  setAuthCookie(res, signToken(req.user!.id, sv, mfa));
}

async function riga(id: string): Promise<any> {
  const r = await db.execute<any>(sql`
    SELECT id, email, full_name, role, permissions, password_hash, mfa_attiva, mfa_segreto, mfa_ultimo_passo
      FROM users WHERE id = ${id}::uuid`);
  return (r as any).rows?.[0] ?? null;
}

/** Il codice dell'app va bene? E il passo si segna, così non si riusa. */
async function codiceValido(u: any, codice: unknown): Promise<boolean> {
  if (!u?.mfa_segreto) return false;
  let v: ReturnType<typeof verificaCodice> = { ok: false };
  try { v = verificaCodice(decifra(u.mfa_segreto), codice, Date.now(), u.mfa_ultimo_passo == null ? null : Number(u.mfa_ultimo_passo)); }
  catch { return false; }
  if (!v.ok) return false;
  const r = await db.execute<any>(sql`
    UPDATE users SET mfa_ultimo_passo = ${v.passo}
     WHERE id = ${u.id}::uuid AND (mfa_ultimo_passo IS NULL OR mfa_ultimo_passo < ${v.passo}) RETURNING id`);
  return !!(r as any).rows?.length;
}

router.post("/auth/password", requireAuth, async (req, res): Promise<void> => {
  try {
    const { attuale, nuova } = req.body ?? {};
    const u = await riga(req.user!.id);
    if (!u || typeof attuale !== "string" || !(await bcrypt.compare(attuale, u.password_hash))) {
      res.status(400).json({ error: "La password attuale non è giusta" }); return;
    }
    const errore = erroreNuovaPassword(nuova, { email: u.email, nome: u.full_name });
    if (errore) { res.status(400).json({ error: errore }); return; }
    if (nuova === attuale) { res.status(400).json({ error: "La password nuova deve essere diversa da quella attuale" }); return; }
    const r = await db.execute<any>(sql`
      UPDATE users SET password_hash = ${await bcrypt.hash(nuova, BCRYPT_ROUNDS)}, password_cambiata_il = now(),
             deve_cambiare_password = false, sessione_versione = sessione_versione + 1
       WHERE id = ${u.id}::uuid RETURNING sessione_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), !!req.sessione?.mfa);
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "password_cambiata" });
    res.json({ ok: true });
  } catch (e: any) { console.error("[account] password:", e?.message || e); res.status(500).json({ error: "Password non cambiata" }); }
});

router.post("/auth/mfa/attiva", requireAuth, async (req, res): Promise<void> => {
  try {
    const u = await riga(req.user!.id);
    if (u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi è già attiva" }); return; }
    /* il segreto si salva subito, cifrato, ma la verifica parte solo alla conferma */
    const segreto = nuovoSegreto();
    await db.execute(sql`UPDATE users SET mfa_segreto = ${cifra(segreto)}, mfa_ultimo_passo = NULL WHERE id = ${req.user!.id}::uuid AND NOT mfa_attiva`);
    res.json({ segreto, uri: uriOtpauth(segreto, req.user!.email) });
  } catch (e: any) { console.error("[account] mfa attiva:", e?.message || e); res.status(500).json({ error: "Verifica non avviata" }); }
});

router.post("/auth/mfa/conferma", requireAuth, async (req, res): Promise<void> => {
  try {
    const u = await riga(req.user!.id);
    if (u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi è già attiva" }); return; }
    if (!u?.mfa_segreto) { res.status(400).json({ error: "Prima avvia l'attivazione" }); return; }
    if (!(await codiceValido(u, req.body?.codice))) { res.status(400).json({ error: "Codice non valido: controlla l'ora del telefono e riprova" }); return; }
    const codici = nuoviCodiciDiRecupero();
    const r = await db.execute<any>(sql`
      UPDATE users SET mfa_attiva = true, mfa_recupero = ${JSON.stringify(codici.map(improntaRecupero))}::jsonb,
             sessione_versione = sessione_versione + 1
       WHERE id = ${u.id}::uuid RETURNING sessione_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), true);
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "verifica_attivata" });
    res.json({ codiciRecupero: codici });
  } catch (e: any) { console.error("[account] mfa conferma:", e?.message || e); res.status(500).json({ error: "Verifica non attivata" }); }
});

router.post("/auth/mfa/disattiva", requireAuth, async (req, res): Promise<void> => {
  try {
    if (mfaObbligatoria(req.user!)) { res.status(403).json({ error: "Per il tuo ruolo la verifica in due passaggi è obbligatoria" }); return; }
    const u = await riga(req.user!.id);
    if (!u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi non è attiva" }); return; }
    if (!(await codiceValido(u, req.body?.codice))) { res.status(400).json({ error: "Codice non valido" }); return; }
    const r = await db.execute<any>(sql`
      UPDATE users SET mfa_attiva = false, mfa_segreto = NULL, mfa_recupero = NULL, mfa_ultimo_passo = NULL,
             sessione_versione = sessione_versione + 1
       WHERE id = ${u.id}::uuid RETURNING sessione_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), false);
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "verifica_disattivata" });
    res.json({ ok: true });
  } catch (e: any) { console.error("[account] mfa disattiva:", e?.message || e); res.status(500).json({ error: "Verifica non disattivata" }); }
});

router.post("/auth/mfa/codici-recupero", requireAuth, async (req, res): Promise<void> => {
  try {
    const u = await riga(req.user!.id);
    if (!u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi non è attiva" }); return; }
    if (!(await codiceValido(u, req.body?.codice))) { res.status(400).json({ error: "Codice non valido" }); return; }
    const codici = nuoviCodiciDiRecupero();
    await db.execute(sql`UPDATE users SET mfa_recupero = ${JSON.stringify(codici.map(improntaRecupero))}::jsonb WHERE id = ${u.id}::uuid`);
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "codici_recupero_nuovi" });
    res.json({ codiciRecupero: codici });
  } catch (e: any) { console.error("[account] codici recupero:", e?.message || e); res.status(500).json({ error: "Codici non rifatti" }); }
});

router.post("/auth/sessioni/chiudi", requireAuth, async (req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      UPDATE users SET sessione_versione = sessione_versione + 1 WHERE id = ${req.user!.id}::uuid RETURNING sessione_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), !!req.sessione?.mfa);
    await registraAccesso(req, { userId: req.user!.id, email: req.user!.email, esito: "sessioni_chiuse" });
    res.json({ ok: true });
  } catch (e: any) { console.error("[account] sessioni:", e?.message || e); res.status(500).json({ error: "Sessioni non chiuse" }); }
});

router.get("/admin/accessi", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  try {
    const limite = Math.min(Math.max(Number(req.query.limite) || 500, 1), 2000);
    const utente = typeof req.query.utente === "string" && /^[0-9a-f-]{36}$/i.test(req.query.utente) ? req.query.utente : null;
    const r = await db.execute<any>(sql`
      SELECT id::text, ts, user_id::text, email, esito, ip, user_agent FROM accessi_log
       ${utente ? sql`WHERE user_id = ${utente}::uuid` : sql``}
       ORDER BY ts DESC LIMIT ${limite}`);
    res.json({ accessi: (r as any).rows.map((x: any) => ({
      id: x.id, ts: x.ts, userId: x.user_id, email: x.email, esito: x.esito, ip: x.ip, userAgent: x.user_agent,
    })) });
  } catch (e: any) { console.error("[account] accessi:", e?.message || e); res.status(500).json({ error: "Registro non leggibile" }); }
});

export default router;
