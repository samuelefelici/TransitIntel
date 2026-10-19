/**
 * I contatori dei tentativi, nel database (le regole sono in accesso-regole.ts):
 *  - password: una serie per email e indirizzo, e una per l'account intero
 *    (ip = "*"), nella tabella accessi_tentativi. Valgono anche per le email
 *    che non esistono, così la risposta non dice quali ci sono. Un browser
 *    da cui la persona è già entrata (cookie del dispositivo, lib/auth.ts) ha
 *    una serie sua (ip = "d:<id>") e il blocco per account non lo ferma: chi
 *    prova da tanti indirizzi non tiene fuori il titolare;
 *  - codici della verifica: una serie per utente, sulla riga di users.
 * Più la prova di un codice (dell'app o di recupero) sotto lucchetto, e la
 * pulizia periodica del registro.
 *
 * Le righe di accessi_tentativi si bloccano sempre in ordine di ip (COLLATE
 * "C"), sia per contare sia per cancellare: due richieste insieme non si
 * aspettano a vicenda.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { prenotaTentativo, REGOLA_ACCOUNT, REGOLA_CODICI, REGOLA_INDIRIZZO, type StatoTentativi } from "./accesso-regole";
import { verificaCodice } from "./totp";
import { apriSegreto, chiaviConfigurate, cifra, idChiave, improntaRecupero } from "./mfa-cifratura";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** la riga dell'account: gli errori da tutti gli indirizzi insieme */
export const TUTTI = "*";
/** la riga di un browser da cui la persona è già entrata */
const rigaDispositivo = (id: string) => `d:${id}`;

const statoDi = (r: any): StatoTentativi => ({
  errori: Number(r?.errori ?? 0),
  inizio: r?.inizio ? new Date(r.inizio) : null,
  ultimo: r?.ultimo ? new Date(r.ultimo) : null,
  bloccatoFino: r?.bloccato_fino ? new Date(r.bloccato_fino) : null,
});

/**
 * Prima di confrontare la password: il tentativo si conta subito, per questo
 * indirizzo e per l'account, o (da un browser già usato per entrare) solo per
 * quel browser. Se una serie è bloccata non si conta niente e si dice fino a
 * quando, e se è il blocco dell'account. Una transazione breve: il confronto
 * lento viene dopo.
 */
export async function prenotaTentativoPassword(
  chiave: string, ip: string, dispositivo: string | null,
): Promise<{ ok: true } | { ok: false; fino: Date; account: boolean }> {
  const righe = dispositivo ? [rigaDispositivo(dispositivo)] : [TUTTI, ip];
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO accessi_tentativi (chiave, ip)
      VALUES ${sql.join(righe.map(r => sql`(${chiave}, ${r})`), sql`, `)}
      ON CONFLICT DO NOTHING`);
    const r = await tx.execute<any>(sql`
      SELECT ip, errori, inizio, ultimo, bloccato_fino FROM accessi_tentativi
       WHERE chiave = ${chiave} AND ip IN (${sql.join(righe.map(x => sql`${x}`), sql`, `)})
       ORDER BY ip COLLATE "C" FOR UPDATE`);
    const ora = Date.now();
    const esiti = ((r as any).rows as any[]).map(x => ({
      ip: String(x.ip),
      p: prenotaTentativo(statoDi(x), ora, x.ip === TUTTI ? REGOLA_ACCOUNT : REGOLA_INDIRIZZO),
    }));
    const bloccati = esiti.flatMap(e => ("bloccatoFino" in e.p ? [{ fino: e.p.bloccatoFino.getTime(), account: e.ip === TUTTI }] : []));
    if (bloccati.length) {
      const peggio = bloccati.reduce((a, b) => (b.fino > a.fino ? b : a));
      return { ok: false as const, fino: new Date(peggio.fino), account: peggio.account };
    }
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

/**
 * Cancella righe di accessi_tentativi prendendole prima nello stesso ordine
 * delle prenotazioni, e cancella solo quelle prese: una riga arrivata dopo
 * (un tentativo nuovo) resta, e la DELETE non deve aspettare nessuno.
 */
async function cancellaInOrdine(chiave: string, ips: string[] | null): Promise<void> {
  const filtro = ips ? sql`AND ip IN (${sql.join(ips.map(x => sql`${x}`), sql`, `)})` : sql``;
  await db.transaction(async (tx) => {
    const r = await tx.execute<any>(sql`
      SELECT ip FROM accessi_tentativi WHERE chiave = ${chiave} ${filtro} ORDER BY ip COLLATE "C" FOR UPDATE`);
    const prese = ((r as any).rows as any[]).map(x => String(x.ip));
    if (!prese.length) return;
    await tx.execute(sql`
      DELETE FROM accessi_tentativi WHERE chiave = ${chiave} AND ip IN (${sql.join(prese.map(x => sql`${x}`), sql`, `)})`);
  });
}

/**
 * Password giusta: si chiudono le serie di errori di questa email da qui e
 * dell'account; dal browser già riconosciuto solo la sua. Così un accesso dal
 * solito browser non toglie in anticipo il blocco dell'account: chi lo tiene
 * non capisce che l'email esiste né quando il titolare entra.
 */
export async function azzeraTentativiPassword(chiave: string, ip: string, dispositivo: string | null): Promise<void> {
  await cancellaInOrdine(chiave, dispositivo ? [rigaDispositivo(dispositivo)] : [TUTTI, ip]);
}

/** L'admin sblocca (o dà una password provvisoria): via le serie della password da ogni indirizzo. */
export async function azzeraTuttiITentativiPassword(chiave: string): Promise<void> {
  await cancellaInOrdine(chiave, null);
}

export type EsitoCodice =
  | { esito: "ok"; recupero: boolean; dato?: unknown }
  | { esito: "errato"; recupero: boolean }
  /** giusto ma già usato: si aspetta il prossimo, e non conta come errore */
  | { esito: "riusato" }
  | { esito: "bloccato"; fino: Date }
  /** il segreto (o i codici di recupero) non si aprono con la chiave: guasto di configurazione, non conta come errore */
  | { esito: "illeggibile" }
  /** non c'è un segreto da verificare */
  | { esito: "manca" };

/**
 * Prova un codice dell'app (o, se `recupero`, un codice di recupero) di un
 * utente, con la sua riga sotto lucchetto: blocco, verifica, passo usato o
 * codice di recupero tolto, contatore degli errori, tutto insieme. Con
 * `conta: false` gli errori non contano (la conferma dell'attivazione: il
 * segreto l'ha appena ricevuto chi prova). `seOk` gira nella stessa
 * transazione quando il codice va bene (l'attivazione: il segreto attivato è
 * proprio quello appena verificato).
 *
 * FOR NO KEY UPDATE e non FOR UPDATE: basta a mettere in fila due prove dello
 * stesso utente, e non aspetta le transazioni lunghe che scrivono righe con
 * una chiave esterna verso users (un import GTFS che ne segna il proprietario).
 */
export async function provaCodice(
  userId: string,
  prova: { codice?: unknown; recupero?: unknown },
  opz: { recupero: boolean; conta: boolean; seOk?: (tx: Tx) => Promise<unknown> },
): Promise<EsitoCodice> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<any>(sql`
      SELECT mfa_segreto, mfa_ultimo_passo, mfa_recupero, mfa_recupero_chiave, mfa_errori, mfa_bloccata_fino
        FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE`);
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
    const illeggibile = (che: string): EsitoCodice => {
      console.error(`[accesso] ${che} della verifica di ${userId} non si apre con le chiavi impostate (CERBERO_CHIAVE_MFA, CERBERO_CHIAVE_MFA_PRECEDENTE)`);
      return { esito: "illeggibile" };
    };

    if (!u.mfa_segreto) return { esito: "manca" as const };
    /* un segreto che la chiave non apre: anche i codici di recupero sono di quella chiave */
    let segreto: ReturnType<typeof apriSegreto>;
    try { segreto = apriSegreto(String(u.mfa_segreto)); }
    catch { return illeggibile("il segreto"); }

    if (opz.recupero && typeof prova.recupero === "string" && prova.recupero.trim()) {
      const elenco: string[] = Array.isArray(u.mfa_recupero) ? u.mfa_recupero : [];
      const chiavi = chiaviConfigurate().filter(k => !u.mfa_recupero_chiave || k.id === u.mfa_recupero_chiave);
      if (!chiavi.length) return illeggibile("i codici di recupero");
      const impronta = chiavi.map(k => improntaRecupero(prova.recupero as string, k.chiave)).find(i => elenco.includes(i));
      if (!impronta) return sbagliato(true);
      /* un codice di recupero vale una volta sola */
      await tx.execute(sql`
        UPDATE users SET mfa_recupero = mfa_recupero - ${impronta}, mfa_errori = 0, mfa_bloccata_fino = NULL
         WHERE id = ${userId}::uuid`);
      return { esito: "ok" as const, recupero: true, dato: opz.seOk ? await opz.seOk(tx) : undefined };
    }

    const v = verificaCodice(segreto.testo, prova.codice, ora, u.mfa_ultimo_passo == null ? null : Number(u.mfa_ultimo_passo));
    if (!v.ok) return v.riusato ? { esito: "riusato" as const } : sbagliato(false);
    /* il passo usato non vale più; un segreto letto con la chiave di prima si ricifra con la nuova */
    await tx.execute(sql`
      UPDATE users SET mfa_ultimo_passo = ${v.passo}, mfa_errori = 0, mfa_bloccata_fino = NULL
             ${segreto.vecchiaChiave ? sql`, mfa_segreto = ${cifra(segreto.testo)}` : sql``}
       WHERE id = ${userId}::uuid`);
    return { esito: "ok" as const, recupero: false, dato: opz.seOk ? await opz.seOk(tx) : undefined };
  });
}

/** Le impronte di nuovi codici di recupero, e con quale chiave sono fatte. */
export function improntePerSalvare(codici: string[]): { impronte: string; chiave: string } {
  return { impronte: JSON.stringify(codici.map(c => improntaRecupero(c))), chiave: idChiave() };
}

/**
 * All'avvio: le chiavi aprono i segreti salvati? Se no, chi ha la verifica
 * attiva non può entrare, e conviene saperlo dai log, non dagli utenti.
 * Durante un cambio di chiave i segreti della chiave precedente si ricifrano
 * subito con la nuova (non serve che ciascuno entri); i codici di recupero no
 * (se ne salva solo l'impronta): il log dice di chi sono ancora della chiave
 * precedente, e Gestione Utenti li segna.
 */
export async function controllaChiaveMfa(): Promise<void> {
  /* anche le attivazioni in corso (segreto salvato, verifica non ancora confermata) */
  const r = await db.execute<any>(sql`
    SELECT id, email, mfa_attiva, mfa_segreto, mfa_recupero_chiave FROM users WHERE mfa_segreto IS NOT NULL`);
  const chiavi = chiaviConfigurate();
  const attuale = idChiave();
  const precedente = chiavi.find(k => !k.attuale)?.id ?? null;
  const illeggibili: string[] = [], codiciPrecedente: string[] = [], codiciPersi: string[] = [];
  let ricifrati = 0, nonRicifrati = 0;
  for (const x of ((r as any).rows ?? []) as any[]) {
    let s: ReturnType<typeof apriSegreto> | null = null;
    try { s = apriSegreto(String(x.mfa_segreto)); }
    catch { if (x.mfa_attiva) illeggibili.push(String(x.email)); }
    if (s?.vecchiaChiave) {
      /* un errore del database qui non vuol dire che la chiave è sbagliata: si riprova al prossimo avvio */
      try {
        const u = await db.execute<any>(sql`
          UPDATE users SET mfa_segreto = ${cifra(s.testo)} WHERE id = ${x.id}::uuid AND mfa_segreto = ${x.mfa_segreto} RETURNING id`);
        if ((u as any).rows?.length) ricifrati++;
      } catch { nonRicifrati++; }
    }
    const k = x.mfa_recupero_chiave as string | null;
    if (x.mfa_attiva && k && k !== attuale) (k === precedente ? codiciPrecedente : codiciPersi).push(String(x.email));
  }
  const elenco = (v: string[]) => v.slice(0, 20).join(", ") + (v.length > 20 ? ` e altri ${v.length - 20}` : "");
  if (ricifrati) console.log(`[accesso] cambio di chiave: ${ricifrati} segreti della verifica ricifrati con la chiave nuova`);
  if (nonRicifrati) {
    console.error(`[accesso] cambio di chiave: ${nonRicifrati} segreti non ricifrati per un errore del database. Sono ancora della chiave precedente: lascia CERBERO_CHIAVE_MFA_PRECEDENTE impostata e riavvia.`);
  }
  if (illeggibili.length) {
    console.error(`[accesso] ATTENZIONE: ${illeggibili.length} utenti con la verifica in due passaggi hanno un segreto che CERBERO_CHIAVE_MFA non apre: non possono entrare (${elenco(illeggibili)}). Rimetti la chiave di prima, o mettila in CERBERO_CHIAVE_MFA_PRECEDENTE.`);
  }
  if (codiciPrecedente.length) {
    console.warn(`[accesso] cambio di chiave in corso: ${codiciPrecedente.length} utenti hanno ancora i codici di recupero della chiave precedente (${elenco(codiciPrecedente)}). Li vedono da rifare in «Sicurezza dell'account»; quando non ne resta nessuno, o dopo «Reimposta verifica», togli CERBERO_CHIAVE_MFA_PRECEDENTE.`);
  }
  if (codiciPersi.length) {
    console.warn(`[accesso] i codici di recupero di ${codiciPersi.length} utenti sono di una chiave non più impostata e non valgono (${elenco(codiciPersi)}): entrano con il codice dell'app e possono rifarli da «Sicurezza dell'account».`);
  }
}

/** Registro degli accessi 12 mesi; serie di tentativi chiuse da due giorni (senza aspettare chi le sta usando). */
export async function pulisciAccessi(): Promise<void> {
  await db.execute(sql`DELETE FROM accessi_log WHERE ts < now() - interval '12 months'`);
  await db.execute(sql`
    DELETE FROM accessi_tentativi
     WHERE (chiave, ip) IN (
       SELECT chiave, ip FROM accessi_tentativi
        WHERE ultimo < now() - interval '2 days' AND (bloccato_fino IS NULL OR bloccato_fino < now())
        ORDER BY chiave, ip COLLATE "C" FOR UPDATE SKIP LOCKED)`);
}

let ultimaPulizia = 0;
/** La pulizia, al più ogni 6 ore, senza far aspettare chi la innesca. */
export function forsePulisciAccessi(): void {
  if (Date.now() - ultimaPulizia < 6 * 3_600_000) return;
  ultimaPulizia = Date.now();
  void pulisciAccessi().catch((e: any) => console.error("[accesso] pulizia del registro:", e?.message || e));
}
