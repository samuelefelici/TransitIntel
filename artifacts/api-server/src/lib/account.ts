/**
 * Sicurezza dell'account: cambio della password, verifica in due passaggi
 * (attiva, conferma, disattiva, nuovi codici di recupero, reimposta dopo il
 * telefono perso), «esci da tutti i dispositivi», e per l'admin il registro
 * degli accessi.
 *
 *   POST /api/auth/password            { attuale, nuova }
 *   POST /api/auth/mfa/attiva          { password? } → { segreto, uri } (non ancora attiva)
 *   POST /api/auth/mfa/conferma        { codice } → { codiciRecupero }
 *   POST /api/auth/mfa/disattiva       { codice } (solo se il ruolo non la chiede)
 *   POST /api/auth/mfa/codici-recupero { codice } → { codiciRecupero }
 *   POST /api/auth/mfa/reimposta       { password } (sessione entrata con un codice di recupero)
 *   POST /api/auth/sessioni/chiudi     tutte le altre sessioni decadono
 *   GET  /api/admin/accessi?limite=&utente=
 *
 * Ogni cambio alza la versione della sessione (le altre sessioni decadono) e
 * riemette il cookie di questa, così chi lo fa resta dentro. Password e codici
 * sbagliati qui contano come al login: chi ha in mano una sessione non può
 * provarli all'infinito. I token dati ad Argos non arrivano qui (requireAuth).
 */
import { Router, type IRouter, type Request, type Response, type RequestHandler } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { loginLimiter } from "../middlewares/rate-limit";
import {
  BCRYPT_ROUNDS, dispositivoPer, emettiSessione, indirizzoDi, registraAccesso, requireAdmin, requireAuth, ricordaDispositivo,
  rispostaBloccato,
} from "./auth";
import { erroreNuovaPassword } from "./password-regole";
import { nuovoSegreto, uriOtpauth } from "./totp";
import { cifra } from "./mfa-cifratura";
import { accessoRecente, chiaveEmail, mfaObbligatoria, nuoviCodiciDiRecupero } from "./accesso-regole";
import { azzeraTentativiPassword, improntePerSalvare, prenotaTentativoPassword, provaCodice, type EsitoCodice } from "./accesso-db";

const router: IRouter = Router();

/** Solo la persona, mai un servizio per conto suo (doppia sicurezza: requireAuth li ferma già). */
const soloPersona: RequestHandler = (req, res, next) => {
  if (req.authVia) { res.status(403).json({ error: "Non disponibile da questo canale" }); return; }
  next();
};

/**
 * La versione della sessione è salita: si riemette il cookie di chi ha fatto
 * il cambio. La sessione scade sempre 12 ore dopo l'accesso (at), anche se si
 * è appena ridata la password: `passwordData` segna solo che la password è
 * fresca (pw), così attivare la verifica subito dopo non la richiede.
 */
function nuovaSessione(req: Request, res: Response, sv: number, s: { mfa: boolean; passwordData?: boolean; rec?: boolean; dv?: number }): void {
  emettiSessione(res, req.user!.id, {
    sv, mfa: s.mfa,
    at: req.sessione?.at,
    pw: s.passwordData ? Math.floor(Date.now() / 1000) : req.sessione?.pw,
    rec: s.rec ?? req.sessione?.rec,
  });
  /* browser dimenticati (cambio password, «esci ovunque»): questo resta riconosciuto, gli altri no */
  if (s.dv !== undefined) ricordaDispositivo(req, res, req.user!.id, s.dv);
}

async function riga(id: string): Promise<any> {
  const r = await db.execute<any>(sql`
    SELECT id, email, full_name, role, permissions, password_hash, mfa_attiva, mfa_segreto, dispositivi_versione
      FROM users WHERE id = ${id}::uuid`);
  return (r as any).rows?.[0] ?? null;
}

/**
 * La password di chi è già dentro (cambio password, reimposta, attivazione
 * senza un accesso recente): conta come un tentativo di login. Risponde da sé
 * se è bloccata o sbagliata.
 */
async function passwordGiusta(req: Request, res: Response, u: any, password: unknown, esitoErrato: string): Promise<boolean> {
  const chiave = chiaveEmail(u.email);
  const ip = indirizzoDi(req);
  const dispositivo = dispositivoPer(req, { id: u.id, dv: Number(u.dispositivi_versione ?? 1) });
  const prenotato = await prenotaTentativoPassword(chiave, ip, dispositivo);
  if (!prenotato.ok) {
    await registraAccesso(req, { userId: u.id, email: u.email, esito: prenotato.account ? "bloccato_account" : "bloccato" });
    rispostaBloccato(res, prenotato.fino, prenotato.account ? "account" : "password");
    return false;
  }
  if (typeof password !== "string" || !(await bcrypt.compare(password, u.password_hash))) {
    await registraAccesso(req, { userId: u.id, email: u.email, esito: esitoErrato });
    res.status(400).json({ error: "La password non è giusta", serve: "password" });
    return false;
  }
  await azzeraTentativiPassword(chiave, ip, dispositivo);
  return true;
}

/** Un codice provato e non andato bene: risponde con il messaggio giusto. */
async function rispostaCodice(req: Request, res: Response, u: any, e: Exclude<EsitoCodice, { esito: "ok" }>): Promise<void> {
  switch (e.esito) {
    case "bloccato":
      await registraAccesso(req, { userId: u.id, email: u.email, esito: "codici_bloccati" });
      rispostaBloccato(res, e.fino, "codici"); return;
    case "illeggibile":
      await registraAccesso(req, { userId: u.id, email: u.email, esito: "segreto_illeggibile" });
      res.status(503).json({ error: "La verifica in due passaggi non è disponibile in questo momento: avvisa l'amministratore." }); return;
    case "riusato":
      res.status(400).json({ error: "Codice già usato: aspetta il prossimo" }); return;
    case "manca":
      res.status(409).json({ error: "Prima avvia l'attivazione" }); return;
    case "errato":
      await registraAccesso(req, { userId: u.id, email: u.email, esito: "codice_errato" });
      res.status(400).json({ error: "Codice non valido: controlla l'ora del telefono e riprova" }); return;
  }
}

router.post("/auth/password", loginLimiter, requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    const { attuale, nuova } = req.body ?? {};
    const u = await riga(req.user!.id);
    if (!u) { res.status(404).json({ error: "Utente non trovato" }); return; }
    /* prima le regole della nuova (non costa niente), poi l'attuale, che conta come un tentativo */
    const errore = erroreNuovaPassword(nuova, { email: u.email, nome: u.full_name });
    if (errore) { res.status(400).json({ error: errore }); return; }
    if (nuova === attuale) { res.status(400).json({ error: "La password nuova deve essere diversa da quella attuale" }); return; }
    if (!(await passwordGiusta(req, res, u, attuale, "password_attuale_errata"))) return;
    const r = await db.execute<any>(sql`
      UPDATE users SET password_hash = ${await bcrypt.hash(nuova, BCRYPT_ROUNDS)}, password_cambiata_il = now(),
             deve_cambiare_password = false, password_controllata = true, sessione_versione = sessione_versione + 1,
             dispositivi_versione = dispositivi_versione + 1
       WHERE id = ${u.id}::uuid RETURNING sessione_versione, dispositivi_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), {
      mfa: !!req.sessione?.mfa, passwordData: true, dv: Number((r as any).rows[0].dispositivi_versione),
    });
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "password_cambiata" });
    res.json({ ok: true });
  } catch (e: any) { console.error("[account] password:", e?.message || e); res.status(500).json({ error: "Password non cambiata" }); }
});

router.post("/auth/mfa/attiva", loginLimiter, requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    const u = await riga(req.user!.id);
    if (!u) { res.status(404).json({ error: "Utente non trovato" }); return; }
    if (u.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi è già attiva" }); return; }
    /* una sessione rubata non deve poter legare il telefono di un altro: se la
     * password non è stata data da poco, si chiede di nuovo */
    if (!accessoRecente(req.sessione?.pw ?? req.sessione?.at, Date.now())) {
      if (req.body?.password === undefined) {
        res.status(403).json({ error: "Per sicurezza inserisci di nuovo la password", serve: "password" }); return;
      }
      if (!(await passwordGiusta(req, res, u, req.body.password, "password_attuale_errata"))) return;
    }
    /* il segreto si salva subito, cifrato, ma la verifica parte solo alla conferma */
    const segreto = nuovoSegreto();
    await db.execute(sql`UPDATE users SET mfa_segreto = ${cifra(segreto)}, mfa_ultimo_passo = NULL WHERE id = ${u.id}::uuid AND NOT mfa_attiva`);
    res.json({ segreto, uri: uriOtpauth(segreto, u.email) });
  } catch (e: any) { console.error("[account] mfa attiva:", e?.message || e); res.status(500).json({ error: "Verifica non avviata" }); }
});

router.post("/auth/mfa/conferma", loginLimiter, requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    const u = await riga(req.user!.id);
    if (u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi è già attiva" }); return; }
    if (!u?.mfa_segreto) { res.status(400).json({ error: "Prima avvia l'attivazione" }); return; }
    /* qui gli errori non contano: il segreto l'ha appena ricevuto chi prova. L'attivazione
     * avviene nella stessa transazione della verifica, con la riga sotto lucchetto: si attiva
     * proprio il segreto appena verificato, non uno cambiato nel frattempo da un'altra scheda */
    const codici = nuoviCodiciDiRecupero();
    const salva = improntePerSalvare(codici);
    const e = await provaCodice(u.id, { codice: req.body?.codice }, {
      recupero: false, conta: false,
      seOk: async (tx) => {
        const r = await tx.execute<any>(sql`
          UPDATE users SET mfa_attiva = true, mfa_recupero = ${salva.impronte}::jsonb, mfa_recupero_chiave = ${salva.chiave},
                 sessione_versione = sessione_versione + 1
           WHERE id = ${u.id}::uuid AND NOT mfa_attiva
          RETURNING sessione_versione`);
        return (r as any).rows?.[0]?.sessione_versione ?? null;
      },
    });
    if (e.esito !== "ok") { await rispostaCodice(req, res, u, e); return; }
    if (e.dato == null) { res.status(409).json({ error: "La verifica in due passaggi è già attiva" }); return; }
    nuovaSessione(req, res, Number(e.dato), { mfa: true, rec: false });
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "verifica_attivata" });
    res.json({ codiciRecupero: codici });
  } catch (e: any) { console.error("[account] mfa conferma:", e?.message || e); res.status(500).json({ error: "Verifica non attivata" }); }
});

router.post("/auth/mfa/disattiva", loginLimiter, requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    if (mfaObbligatoria(req.user!)) { res.status(403).json({ error: "Per il tuo ruolo la verifica in due passaggi è obbligatoria" }); return; }
    const u = await riga(req.user!.id);
    if (!u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi non è attiva" }); return; }
    const e = await provaCodice(u.id, { codice: req.body?.codice }, { recupero: false, conta: true });
    if (e.esito !== "ok") { await rispostaCodice(req, res, u, e); return; }
    const r = await db.execute<any>(sql`
      UPDATE users SET mfa_attiva = false, mfa_segreto = NULL, mfa_recupero = NULL, mfa_recupero_chiave = NULL, mfa_ultimo_passo = NULL,
             sessione_versione = sessione_versione + 1
       WHERE id = ${u.id}::uuid RETURNING sessione_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), { mfa: false, rec: false });
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "verifica_disattivata" });
    res.json({ ok: true });
  } catch (e: any) { console.error("[account] mfa disattiva:", e?.message || e); res.status(500).json({ error: "Verifica non disattivata" }); }
});

router.post("/auth/mfa/codici-recupero", loginLimiter, requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    const u = await riga(req.user!.id);
    if (!u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi non è attiva" }); return; }
    const e = await provaCodice(u.id, { codice: req.body?.codice }, { recupero: false, conta: true });
    if (e.esito !== "ok") { await rispostaCodice(req, res, u, e); return; }
    const codici = nuoviCodiciDiRecupero();
    const salva = improntePerSalvare(codici);
    await db.execute(sql`
      UPDATE users SET mfa_recupero = ${salva.impronte}::jsonb, mfa_recupero_chiave = ${salva.chiave} WHERE id = ${u.id}::uuid`);
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "codici_recupero_nuovi" });
    res.json({ codiciRecupero: codici });
  } catch (e: any) { console.error("[account] codici recupero:", e?.message || e); res.status(500).json({ error: "Codici non rifatti" }); }
});

/**
 * Telefono perso: chi è entrato con un codice di recupero, ridando la
 * password, toglie la verifica e la rifà col telefono nuovo (per i ruoli che
 * la chiedono, la sessione diventa limitata finché non la riattiva). Sono due
 * fattori, come per entrare: il codice di recupero e la password.
 */
router.post("/auth/mfa/reimposta", loginLimiter, requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    if (!req.sessione?.rec) { res.status(403).json({ error: "Si può fare solo entrando con un codice di recupero" }); return; }
    const u = await riga(req.user!.id);
    if (!u?.mfa_attiva) { res.status(409).json({ error: "La verifica in due passaggi non è attiva" }); return; }
    if (!(await passwordGiusta(req, res, u, req.body?.password, "password_attuale_errata"))) return;
    const r = await db.execute<any>(sql`
      UPDATE users SET mfa_attiva = false, mfa_segreto = NULL, mfa_recupero = NULL, mfa_recupero_chiave = NULL, mfa_ultimo_passo = NULL,
             mfa_errori = 0, mfa_bloccata_fino = NULL, sessione_versione = sessione_versione + 1
       WHERE id = ${u.id}::uuid RETURNING sessione_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), { mfa: false, passwordData: true, rec: false });
    await registraAccesso(req, { userId: u.id, email: u.email, esito: "verifica_reimpostata" });
    res.json({ ok: true });
  } catch (e: any) { console.error("[account] mfa reimposta:", e?.message || e); res.status(500).json({ error: "Verifica non reimpostata" }); }
});

router.post("/auth/sessioni/chiudi", requireAuth, soloPersona, async (req, res): Promise<void> => {
  try {
    const r = await db.execute<any>(sql`
      UPDATE users SET sessione_versione = sessione_versione + 1, dispositivi_versione = dispositivi_versione + 1
       WHERE id = ${req.user!.id}::uuid RETURNING sessione_versione, dispositivi_versione`);
    nuovaSessione(req, res, Number((r as any).rows[0].sessione_versione), {
      mfa: !!req.sessione?.mfa, dv: Number((r as any).rows[0].dispositivi_versione),
    });
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
