/**
 * I diritti dei ruoli che l'amministratore cambia dall'app (PR 2.18,
 * migrazione 0015, Amministrazione › Ruoli).
 *
 * La matrice di partenza è nel codice (lib/permessi); public.ruoli_diritti
 * tiene solo le celle cambiate. La matrice in vigore è la prima con sopra le
 * seconde, e con quella si calcolano i diritti di tutti.
 *
 * - **Chiuso se non si legge.** Ogni caricamento di un utente passa da
 *   matriceFresca(): se la tabella non si è mai letta e il database non
 *   risponde, la richiesta fallisce. Non si ripiega sulla matrice di partenza,
 *   che potrebbe dare a un ruolo quello che l'amministratore gli ha tolto.
 *   Se una lettura c'è già stata, vale quella finché il database non torna.
 * - **Mezzo minuto di memoria.** Chi salva la aggiorna subito in questo
 *   processo; un altro processo dell'API la vede entro mezzo minuto.
 * - **L'amministratore di sistema non dipende dalla matrice**: può tutto
 *   comunque, quindi cambiandola non ci si chiude fuori.
 * - **Un salvataggio è una transazione sola**: le celle del ruolo e, per chi
 *   ha quel ruolo, la vista users.permissions (la leggono FleetCare e la
 *   regola della verifica in due passaggi) e i dati sanitari, che non restano
 *   accesi a chi non può più aprire il roster.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  AREE, MATRICE, RUOLI, interruttoriCompatibili, matriceConModifiche, modificheDelRuolo, puo, rigaDelRuolo,
  dirittiDi, type Diritti, type Matrice, type RuoloAziendale,
} from "@workspace/permessi";
import { matriceInVigore, mettiInVigore } from "./matrice-in-vigore";
import { profiloDaRiga } from "./permessi";

const DURATA_MS = 30_000;
/** 0 = mai letta dal database in questo processo */
let lettaIl = 0;
let inCorso: Promise<Matrice> | null = null;

async function leggi(esecutore: { execute: typeof db.execute } = db): Promise<Matrice> {
  const r = await esecutore.execute<any>(sql`SELECT ruolo, area, livello FROM ruoli_diritti`);
  return matriceConModifiche(MATRICE, (r as any).rows ?? []);
}

/**
 * La matrice in vigore, riletta se è più vecchia di mezzo minuto. Va chiamata
 * prima di calcolare i diritti di qualcuno (lo fa il caricamento dell'utente).
 */
export async function matriceFresca(): Promise<Matrice> {
  if (lettaIl && Date.now() - lettaIl < DURATA_MS) return matriceInVigore();
  /* tante richieste insieme: una lettura sola */
  inCorso ??= (async () => {
    try {
      mettiInVigore(await leggi());
      lettaIl = Date.now();
    } catch (e) {
      /* mai letta: non si indovina chi può cosa. Già letta: vale quella di prima */
      if (!lettaIl) throw e;
    } finally {
      inCorso = null;
    }
    return matriceInVigore();
  })();
  return inCorso;
}

/**
 * Per chi scrive la vista dei permessi di un utente (Gestione utenti): dentro
 * la sua transazione, si mette in fila con chi sta cambiando i ruoli e rilegge
 * la matrice. Senza, una modifica a un utente fatta nello stesso istante di una
 * modifica ai ruoli potrebbe scrivergli la vista calcolata con la matrice di
 * prima, e resterebbe sbagliata fino al riavvio (FleetCare e la regola della
 * verifica in due passaggi leggono quella).
 */
export async function matriceSottoLucchetto(tx: { execute: typeof db.execute }): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext('cerbero:ruoli_diritti'))`);
  mettiInVigore(await leggi(tx));
  lettaIl = Date.now();
}

/** Per i test: come un processo appena partito. */
export function dimenticaMatrice(): void { lettaIl = 0; inCorso = null; mettiInVigore(MATRICE); }

/* ── La pagina dell'amministratore ────────────────────────────────────────── */

export interface StatoRuolo {
  codice: RuoloAziendale;
  /** gli utenti attivi che hanno il ruolo (gli amministratori di sistema non contano: possono tutto comunque) */
  utenti: number;
  diritti: Diritti;
  diPartenza: Diritti;
  /** l'ultima modifica alle sue celle, se ne ha di cambiate */
  aggiornataIl: string | null;
  aggiornataDa: string | null;
}

/** I ruoli come sono adesso nel database: letti apposta, non dalla memoria. */
export async function statoDeiRuoli(): Promise<{ ruoli: StatoRuolo[] }> {
  const matrice = await leggi();
  const quanti = await db.execute<any>(sql`
    SELECT r AS ruolo, count(*)::int AS n FROM users u, unnest(u.ruoli) AS r
     WHERE u.active AND u.role <> 'admin' GROUP BY r`);
  const ultime = await db.execute<any>(sql`
    SELECT DISTINCT ON (d.ruolo) d.ruolo, d.aggiornata_il, coalesce(nullif(btrim(u.full_name), ''), u.email) AS da
      FROM ruoli_diritti d LEFT JOIN users u ON u.id = d.aggiornata_da
     ORDER BY d.ruolo, d.aggiornata_il DESC`);
  const n = new Map<string, number>(((quanti as any).rows ?? []).map((x: any) => [String(x.ruolo), Number(x.n)]));
  const u = new Map<string, any>(((ultime as any).rows ?? []).map((x: any) => [String(x.ruolo), x]));
  return {
    ruoli: RUOLI.map(codice => ({
      codice,
      utenti: n.get(codice) ?? 0,
      diritti: rigaDelRuolo(matrice, codice),
      diPartenza: rigaDelRuolo(MATRICE, codice),
      aggiornataIl: u.get(codice)?.aggiornata_il ? new Date(u.get(codice).aggiornata_il).toISOString() : null,
      aggiornataDa: u.get(codice)?.da ?? null,
    })),
  };
}

export interface EsitoSalvataggio {
  /** le celle del ruolo che sono cambiate davvero */
  celle: number;
  /** gli utenti a cui è cambiata la vista dei permessi (quella che leggono FleetCare e la regola della verifica) */
  utentiAggiornati: number;
  /** a quanti si sono spenti i dati sanitari perché non possono più aprire il roster */
  datiSanitariSpenti: number;
  /** quanti, con questo ruolo, devono ora attivare la verifica in due passaggi per continuare */
  daVerificare: number;
}

/**
 * Salva i diritti di un ruolo: le sole celle diverse dalla matrice di partenza
 * (le altre non hanno riga), e nella stessa transazione riallinea chi ha quel
 * ruolo. Alla fine la matrice in memoria è quella nuova.
 */
export async function salvaDirittiDelRuolo(ruolo: RuoloAziendale, voluti: Diritti, utenteId: string | null): Promise<EsitoSalvataggio> {
  const modifiche = modificheDelRuolo(MATRICE, ruolo, voluti);
  const aree = `{${modifiche.map(m => m.area).filter(a => (AREE as readonly string[]).includes(a)).join(",")}}`;
  const { esito, matrice } = await db.transaction(async (tx) => {
    /* una modifica ai ruoli per volta: due amministratori insieme non si mescolano, e chi
     * sta scrivendo i permessi di un utente (matriceSottoLucchetto) finisce prima */
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cerbero:ruoli_diritti'))`);
    const tolte = await tx.execute<any>(sql`
      DELETE FROM ruoli_diritti WHERE ruolo = ${ruolo} AND NOT (area = ANY(${aree}::text[])) RETURNING area`);
    let celle = ((tolte as any).rows ?? []).length;
    for (const m of modifiche) {
      /* una cella già a quel livello non si riscrive: niente righe a vuoto nel registro */
      const r = await tx.execute<any>(sql`
        INSERT INTO ruoli_diritti (ruolo, area, livello, aggiornata_il, aggiornata_da)
        VALUES (${m.ruolo}, ${m.area}, ${m.livello}, now(), ${utenteId}::uuid)
        ON CONFLICT (ruolo, area) DO UPDATE
          SET livello = EXCLUDED.livello, aggiornata_il = EXCLUDED.aggiornata_il, aggiornata_da = EXCLUDED.aggiornata_da
        WHERE ruoli_diritti.livello IS DISTINCT FROM EXCLUDED.livello
        RETURNING area`);
      celle += ((r as any).rows ?? []).length;
    }
    const matrice = await leggi(tx as any);
    /* chi ha il ruolo: la vista permissions e i dati sanitari, con la matrice nuova */
    const utenti = await tx.execute<any>(sql`
      SELECT id, role, ruoli, accesso_di_prima, dati_sanitari, analisi, permissions FROM users
       WHERE role <> 'admin' AND ruoli @> ARRAY[${ruolo}]::text[] FOR UPDATE`);
    let utentiAggiornati = 0, datiSanitariSpenti = 0;
    for (const row of ((utenti as any).rows ?? []) as any[]) {
      const profilo = profiloDaRiga(row);
      const diritti = dirittiDi(profilo, matrice);
      const vista = interruttoriCompatibili(diritti);
      const scritta = row.permissions && typeof row.permissions === "object" ? row.permissions as Record<string, unknown> : {};
      const chiavi = Object.keys(vista) as Array<keyof typeof vista>;
      const vistaUguale = Object.keys(scritta).length === chiavi.length && chiavi.every(k => scritta[k] === vista[k]);
      const spegni = profilo.datiSanitari && !puo(diritti, "roster", "L");
      if (vistaUguale && !spegni) continue;
      await tx.execute(sql`
        UPDATE users SET permissions = ${JSON.stringify(vista)}::jsonb, dati_sanitari = ${spegni ? false : profilo.datiSanitari}
         WHERE id = ${row.id}::uuid`);
      if (!vistaUguale) utentiAggiornati++;
      if (spegni) datiSanitariSpenti++;
    }
    const v = await tx.execute<any>(sql`
      SELECT count(*)::int AS n FROM users
       WHERE role <> 'admin' AND active AND ruoli @> ARRAY[${ruolo}]::text[] AND mfa_obbligatoria AND NOT mfa_attiva`);
    return { esito: { celle, utentiAggiornati, datiSanitariSpenti, daVerificare: Number((v as any).rows?.[0]?.n ?? 0) }, matrice };
  });
  /* da adesso vale per ogni richiesta di questo processo */
  mettiInVigore(matrice);
  lettaIl = Date.now();
  return esito;
}
