/**
 * I contatori dei tentativi, nel database (le regole sono in accesso-regole.ts):
 *  - password: una serie per email e indirizzo, e una per l'account intero
 *    (ip = "*"), nella tabella accessi_tentativi. Valgono anche per le email
 *    che non esistono, così la risposta non dice quali ci sono;
 *  - codici della verifica: una serie per utente, sulla riga di users.
 * Più la prova di un codice (dell'app o di recupero) sotto lucchetto, e la
 * pulizia periodica del registro.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { prenotaTentativo, REGOLA_ACCOUNT, REGOLA_CODICI, REGOLA_INDIRIZZO, type StatoTentativi } from "./accesso-regole";
import { verificaCodice } from "./totp";
import { apriSegreto, cifra, impronteRecupero } from "./mfa-cifratura";

/** la riga dell'account: gli errori da tutti gli indirizzi insieme */
export const TUTTI = "*";

const statoDi = (r: any): StatoTentativi => ({
  errori: Number(r?.errori ?? 0),
  inizio: r?.inizio ? new Date(r.inizio) : null,
  ultimo: r?.ultimo ? new Date(r.ultimo) : null,
  bloccatoFino: r?.bloccato_fino ? new Date(r.bloccato_fino) : null,
});

/**
 * Prima di confrontare la password: il tentativo si conta subito, per questo
 * indirizzo e per l'account. Se uno dei due è bloccato non si conta niente e
 * si dice fino a quando. Una transazione breve: il confronto lento viene dopo.
 */
export async function prenotaTentativoPassword(chiave: string, ip: string): Promise<{ ok: true } | { ok: false; fino: Date }> {
  return db.transaction(async (tx) => {
    /* le righe si prendono sempre nello stesso ordine ("*" prima): niente stalli fra due login */
    await tx.execute(sql`
      INSERT INTO accessi_tentativi (chiave, ip) VALUES (${chiave}, ${TUTTI}), (${chiave}, ${ip})
      ON CONFLICT DO NOTHING`);
    const r = await tx.execute<any>(sql`
      SELECT ip, errori, inizio, ultimo, bloccato_fino FROM accessi_tentativi
       WHERE chiave = ${chiave} AND ip IN (${TUTTI}, ${ip})
       ORDER BY ip FOR UPDATE`);
    const ora = Date.now();
    const esiti = ((r as any).rows as any[]).map(x => ({
      ip: String(x.ip),
      p: prenotaTentativo(statoDi(x), ora, x.ip === TUTTI ? REGOLA_ACCOUNT : REGOLA_INDIRIZZO),
    }));
    const fino = esiti.flatMap(e => ("bloccatoFino" in e.p ? [e.p.bloccatoFino.getTime()] : []));
    if (fino.length) return { ok: false as const, fino: new Date(Math.max(...fino)) };
    for (const e of esiti) {
      if (!("stato" in e.p)) continue;
      const s = e.p.stato;
      await tx.execute(sql`
        UPDATE accessi_tentativi
           SET errori = ${s.errori}, inizio = ${s.inizio}, ultimo = ${s.ultimo}, bloccato_fino = ${s.bloccatoFino}
         WHERE chiave = ${chiave} AND ip = ${e.ip}`);
    }
    return { ok: true as const };
  });
}

/** Password giusta: le serie di errori di questa email, da qui e per l'account, si chiudono. */
export async function azzeraTentativiPassword(chiave: string, ip: string): Promise<void> {
  await db.execute(sql`DELETE FROM accessi_tentativi WHERE chiave = ${chiave} AND ip IN (${TUTTI}, ${ip})`);
}

/** L'admin sblocca (o dà una password provvisoria): via le serie della password da ogni indirizzo. */
export async function azzeraTuttiITentativiPassword(chiave: string): Promise<void> {
  await db.execute(sql`DELETE FROM accessi_tentativi WHERE chiave = ${chiave}`);
}

export type EsitoCodice =
  | { esito: "ok"; recupero: boolean }
  | { esito: "errato"; recupero: boolean }
  /** giusto ma già usato: si aspetta il prossimo, e non conta come errore */
  | { esito: "riusato" }
  | { esito: "bloccato"; fino: Date }
  /** il segreto salvato non si apre con la chiave: guasto di configurazione, non conta come errore */
  | { esito: "illeggibile" }
  /** non c'è un segreto da verificare */
  | { esito: "manca" };

/**
 * Prova un codice dell'app (o, se `recupero`, un codice di recupero) di un
 * utente, con la sua riga sotto lucchetto: blocco, verifica, passo usato o
 * codice di recupero tolto, contatore degli errori, tutto insieme. Con
 * `conta: false` gli errori non contano (la conferma dell'attivazione: il
 * segreto l'ha appena ricevuto chi prova).
 */
export async function provaCodice(
  userId: string,
  prova: { codice?: unknown; recupero?: unknown },
  opz: { recupero: boolean; conta: boolean },
): Promise<EsitoCodice> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<any>(sql`
      SELECT mfa_segreto, mfa_ultimo_passo, mfa_recupero, mfa_errori, mfa_bloccata_fino
        FROM users WHERE id = ${userId}::uuid FOR UPDATE`);
    const u = (r as any).rows?.[0];
    if (!u) return { esito: "manca" as const };
    const ora = Date.now();
    const p = prenotaTentativo(
      { errori: Number(u.mfa_errori ?? 0), inizio: null, ultimo: null, bloccatoFino: u.mfa_bloccata_fino ? new Date(u.mfa_bloccata_fino) : null },
      ora, REGOLA_CODICI,
    );
    if ("bloccatoFino" in p) return { esito: "bloccato" as const, fino: p.bloccatoFino };
    const sbagliato = async (recupero: boolean): Promise<EsitoCodice> => {
      if (opz.conta) {
        await tx.execute(sql`
          UPDATE users SET mfa_errori = ${p.stato.errori}, mfa_bloccata_fino = ${p.stato.bloccatoFino}
           WHERE id = ${userId}::uuid`);
      }
      return { esito: "errato", recupero };
    };

    if (opz.recupero && typeof prova.recupero === "string" && prova.recupero.trim()) {
      const elenco: string[] = Array.isArray(u.mfa_recupero) ? u.mfa_recupero : [];
      const impronta = impronteRecupero(prova.recupero).find(i => elenco.includes(i));
      if (!impronta) return sbagliato(true);
      /* un codice di recupero vale una volta sola */
      await tx.execute(sql`
        UPDATE users SET mfa_recupero = mfa_recupero - ${impronta}, mfa_errori = 0, mfa_bloccata_fino = NULL
         WHERE id = ${userId}::uuid`);
      return { esito: "ok" as const, recupero: true };
    }

    if (!u.mfa_segreto) return { esito: "manca" as const };
    let segreto: ReturnType<typeof apriSegreto>;
    try { segreto = apriSegreto(String(u.mfa_segreto)); }
    catch (e: any) {
      console.error(`[accesso] il segreto della verifica di ${userId} non si apre con CERBERO_CHIAVE_MFA:`, e?.message || e);
      return { esito: "illeggibile" as const };
    }
    const v = verificaCodice(segreto.testo, prova.codice, ora, u.mfa_ultimo_passo == null ? null : Number(u.mfa_ultimo_passo));
    if (!v.ok) return v.riusato ? { esito: "riusato" as const } : sbagliato(false);
    /* il passo usato non vale più; un segreto letto con la chiave di prima si ricifra con la nuova */
    await tx.execute(sql`
      UPDATE users SET mfa_ultimo_passo = ${v.passo}, mfa_errori = 0, mfa_bloccata_fino = NULL
             ${segreto.vecchiaChiave ? sql`, mfa_segreto = ${cifra(segreto.testo)}` : sql``}
       WHERE id = ${userId}::uuid`);
    return { esito: "ok" as const, recupero: false };
  });
}

/**
 * All'avvio: la chiave apre i segreti salvati? Se no, nessuno con la verifica
 * attiva può entrare, e conviene saperlo subito dai log, non dagli utenti.
 */
export async function controllaChiaveMfa(): Promise<void> {
  const r = await db.execute<any>(sql`SELECT mfa_segreto FROM users WHERE mfa_segreto IS NOT NULL LIMIT 1`);
  const s = (r as any).rows?.[0]?.mfa_segreto;
  if (!s) return;
  try { apriSegreto(String(s)); }
  catch {
    console.error("[accesso] ATTENZIONE: CERBERO_CHIAVE_MFA non apre i segreti salvati. Chi ha la verifica in due passaggi non può entrare: rimetti la chiave di prima, o mettila in CERBERO_CHIAVE_MFA_PRECEDENTE.");
  }
}

/** Registro degli accessi 12 mesi; serie di tentativi chiuse da due giorni. */
export async function pulisciAccessi(): Promise<void> {
  await db.execute(sql`DELETE FROM accessi_log WHERE ts < now() - interval '12 months'`);
  await db.execute(sql`
    DELETE FROM accessi_tentativi
     WHERE ultimo < now() - interval '2 days' AND (bloccato_fino IS NULL OR bloccato_fino < now())`);
}

let ultimaPulizia = 0;
/** La pulizia, al più ogni 6 ore, senza far aspettare chi la innesca. */
export function forsePulisciAccessi(): void {
  if (Date.now() - ultimaPulizia < 6 * 3_600_000) return;
  ultimaPulizia = Date.now();
  void pulisciAccessi().catch((e: any) => console.error("[accesso] pulizia del registro:", e?.message || e));
}
