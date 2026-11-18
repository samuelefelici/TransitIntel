/**
 * I depositi dell'azienda (tappa 6.4, migrazione 0038).
 *
 * Il catalogo dei depositi del personale (roster_depositi) è un dato
 * dell'azienda: lo crea e lo cambia l'amministratore (GET, POST, PUT e DELETE
 * /api/admin/depositi), e ogni modifica resta nel registro. Prima i sette
 * depositi di Conerobus erano scritti nel codice e tornavano a ogni avvio
 * dell'API: un'altra azienda se li sarebbe trovati, e non c'era modo di
 * crearne o toglierne uno.
 *
 * Che cosa tiene insieme un deposito:
 *   codice   non cambia: lo usano i gruppi turni (chiave esterna) e i depositi
 *            degli utenti (users.depositi, users.depositi_visibili);
 *   nome     i conducenti portano il deposito per NOME (residenza_servizio, e
 *            lo storico): chi lo legge lo ritrova nel catalogo per nome,
 *            codice o alias (trovaDeposito). Quindi un nome cambiato resta
 *            come alias, e nessuna modifica può lasciare un conducente con un
 *            deposito che non si ritrova più;
 *   alias    gli altri nomi con cui il deposito arriva da un file. Un nome,
 *            un codice o un alias non può essere di due depositi.
 *
 * Un deposito in uso (conducenti, cambi di deposito programmati, gruppi
 * turni, utenti) non si toglie: prima si sposta chi lo usa.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { chiaveCodice, trovaDeposito, type Deposito } from "./anagrafica-campi";
import { leggiDepositi, oggiRoma, righe, sincronizzaCorrenti, type Ex } from "./anagrafica-store";

export class RifiutoDepositi extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const NOME = z.string().trim().min(1, "nome: almeno un carattere").max(60, "nome: al più 60 caratteri");
const CODICE = z.string().trim().max(40, "codice: al più 40 caratteri")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "codice: lettere minuscole, cifre e trattini, come «deposito-nord»");
const ALIAS = z.array(z.string().trim().min(1, "un altro nome non può essere vuoto").max(60, "un altro nome: al più 60 caratteri"))
  .max(30, "al più 30 altri nomi");
const ORDINE = z.number().int().min(0).max(9999);
const GRUPPO = z.enum(["A", "B"]);
const CADENZA = z.enum(["settimanale", "semimensile"]);

export const NuovoDeposito = z.object({
  /** se manca, lo si ricava dal nome */
  codice: CODICE.optional(),
  nome: NOME,
  gruppo: GRUPPO,
  cadenzaTurni: CADENZA.default("semimensile"),
  alias: ALIAS.default([]),
  ordine: ORDINE.optional(),
}).strict();

export const ModificaDeposito = z.object({
  nome: NOME.optional(),
  gruppo: GRUPPO.optional(),
  cadenzaTurni: CADENZA.optional(),
  alias: ALIAS.optional(),
  ordine: ORDINE.optional(),
}).strict();

/* ── le regole, senza database ─────────────────────────────────────────── */

/** Il codice che si propone per un nome: «Jesi Urbano» → «jesi-urbano». */
export function codiceDaNome(nome: string): string {
  return nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

/**
 * Gli altri nomi puliti: senza vuoti, senza doppioni, senza quelli che sono
 * già scritti come il nome o come il codice. Si confronta la scrittura (a
 * parte maiuscole e spazi ai bordi), non la chiave: «Jesi Urbano» resta un
 * altro nome del deposito «jesi-urbano» che ora si chiama diversamente, perché
 * il database ritrova un deposito solo per scrittura esatta (vedi `comeIlDatabase`).
 */
export function aliasPuliti(alias: readonly string[], d: { nome: string; codice: string }): string[] {
  const visti = new Set([d.nome.trim().toLowerCase(), d.codice.trim().toLowerCase()]);
  const out: string[] = [];
  for (const a of alias) {
    const t = a.trim(), k = t.toLowerCase();
    if (!t || !chiaveCodice(t) || visti.has(k)) continue;
    visti.add(k); out.push(t);
  }
  return out;
}

/**
 * Il deposito di un valore come lo ritrova il database quando riallinea i
 * conducenti (lib/anagrafica-store.ts, CORRENTE.deposito): solo per scrittura
 * esatta di nome, codice o alias, a parte le maiuscole. È più severo di
 * `trovaDeposito`, che confronta senza accenti e punteggiatura.
 */
export function comeIlDatabase(valore: string, catalogo: readonly Deposito[]): Deposito | null {
  const v = valore.trim().toLowerCase();
  if (!v) return null;
  return [...catalogo].sort((a, b) => a.ordine - b.ordine)
    .find((d) => d.nome.toLowerCase() === v || d.codice.toLowerCase() === v || d.alias.some((a) => a.toLowerCase() === v)) ?? null;
}

/** Le chiavi con cui un deposito si ritrova: nome, codice e alias, come li confronta trovaDeposito. */
const chiaviDi = (d: Deposito): Array<[string, string]> => [
  [chiaveCodice(d.nome), d.nome], [chiaveCodice(d.codice), d.codice], ...d.alias.map((a): [string, string] => [chiaveCodice(a), a]),
];

/**
 * Se `d` ha un nome, un codice o un alias che è già di un altro deposito: il
 * messaggio da mostrare; altrimenti null. Due depositi con la stessa chiave
 * renderebbero ambiguo il deposito di un conducente.
 */
export function collisione(d: Deposito, altri: readonly Deposito[]): string | null {
  for (const altro of altri) {
    if (altro.codice === d.codice) continue;
    const sue = new Map(chiaviDi(altro));
    for (const [k, testo] of chiaviDi(d)) {
      if (k && sue.has(k)) return `«${testo}» è già un nome del deposito ${altro.nome}: due depositi non possono chiamarsi allo stesso modo`;
    }
  }
  return null;
}

/* ── le letture ────────────────────────────────────────────────────────── */

export interface DepositoConUso extends Deposito {
  /** conducenti che oggi hanno questo deposito */
  conducenti: number;
  /** cambi di deposito programmati verso questo deposito, con decorrenza futura */
  cambiProgrammati: number;
  gruppiTurni: number;
  /** utenti che lo hanno fra i depositi che scrivono o che vedono */
  utenti: number;
}

/** I valori con cui i conducenti nominano il loro deposito, oggi e nei cambi programmati. */
async function valoriInUso(ex: Ex, oggi: string): Promise<{ correnti: Map<string, number>; programmati: Map<string, number> }> {
  const correnti = new Map<string, number>(righe(await ex.execute(sql`
    SELECT btrim(residenza_servizio) AS v, count(*)::int AS n FROM roster_drivers
     WHERE residenza_servizio IS NOT NULL AND btrim(residenza_servizio) <> '' GROUP BY 1`)).map((r) => [String(r.v), Number(r.n)]));
  const programmati = new Map<string, number>(righe(await ex.execute(sql`
    SELECT btrim(value) AS v, count(*)::int AS n FROM roster_driver_history
     WHERE kind = 'deposito' AND event_date > ${oggi}::date AND value IS NOT NULL AND btrim(value) <> '' GROUP BY 1`))
    .map((r) => [String(r.v), Number(r.n)]));
  return { correnti, programmati };
}

const sommaPer = (valori: Map<string, number>, catalogo: Deposito[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const [v, n] of valori) {
    const d = trovaDeposito(v, catalogo);
    if (d) out.set(d.codice, (out.get(d.codice) ?? 0) + n);
  }
  return out;
};

/** Il catalogo per la pagina dell'amministratore, con quanto ogni deposito è usato. */
export async function elencoDepositi(ex: Ex = db as unknown as Ex): Promise<DepositoConUso[]> {
  const catalogo = await leggiDepositi(ex);
  const uso = await valoriInUso(ex, oggiRoma());
  const conducenti = sommaPer(uso.correnti, catalogo), programmati = sommaPer(uso.programmati, catalogo);
  const gruppi = new Map<string, number>(righe(await ex.execute(sql`
    SELECT deposito_codice AS c, count(*)::int AS n FROM roster_gruppi_turni GROUP BY 1`)).map((r) => [String(r.c), Number(r.n)]));
  const utenti = new Map<string, number>(righe(await ex.execute(sql`
    SELECT c, count(DISTINCT u.id)::int AS n
      FROM users u, unnest(u.depositi || u.depositi_visibili) AS c
     GROUP BY 1`)).map((r) => [String(r.c), Number(r.n)]));
  return catalogo.map((d) => ({
    ...d, conducenti: conducenti.get(d.codice) ?? 0, cambiProgrammati: programmati.get(d.codice) ?? 0,
    gruppiTurni: gruppi.get(d.codice) ?? 0, utenti: utenti.get(d.codice) ?? 0,
  }));
}

/* ── le scritture ──────────────────────────────────────────────────────── */

const testoAlias = (alias: string[]) => `{${alias.map((a) => `"${a.replace(/["\\]/g, "\\$&")}"`).join(",")}}`;

/** Una scrittura alla volta: due amministratori insieme non creano due depositi con lo stesso nome. */
const sottoLucchetto = <T>(fai: (ex: Ex) => Promise<T>): Promise<T> => db.transaction(async (tx) => {
  const ex = tx as unknown as Ex;
  await ex.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:depositi'))`);
  return fai(ex);
});

export async function creaDeposito(d: z.infer<typeof NuovoDeposito>): Promise<Deposito> {
  return sottoLucchetto(async (ex) => {
    const catalogo = await leggiDepositi(ex);
    const codice = d.codice ?? codiceDaNome(d.nome);
    if (!CODICE.safeParse(codice).success) {
      throw new RifiutoDepositi(400, "Dal nome non si ricava un codice: scrivilo tu (lettere minuscole, cifre e trattini)");
    }
    if (catalogo.some((x) => x.codice === codice)) throw new RifiutoDepositi(409, `Il codice «${codice}» è già di un altro deposito`);
    const ordine = d.ordine ?? Math.min(9999, Math.max(0, ...catalogo.map((x) => x.ordine)) + 1);
    const nuovo: Deposito = { codice, nome: d.nome, gruppo: d.gruppo, cadenzaTurni: d.cadenzaTurni, alias: aliasPuliti(d.alias, { nome: d.nome, codice }), ordine };
    const doppio = collisione(nuovo, catalogo);
    if (doppio) throw new RifiutoDepositi(409, doppio);
    await ex.execute(sql`
      INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine)
      VALUES (${nuovo.codice}, ${nuovo.nome}, ${nuovo.gruppo}, ${nuovo.cadenzaTurni}, ${testoAlias(nuovo.alias)}::text[], ${nuovo.ordine})`);
    return nuovo;
  });
}

export async function modificaDeposito(codice: string, m: z.infer<typeof ModificaDeposito>): Promise<Deposito> {
  return sottoLucchetto(async (ex) => {
    const catalogo = await leggiDepositi(ex);
    const vecchio = catalogo.find((x) => x.codice === codice);
    if (!vecchio) throw new RifiutoDepositi(404, "Deposito non trovato");
    const nome = m.nome ?? vecchio.nome;
    const nomeCambiato = chiaveCodice(nome) !== chiaveCodice(vecchio.nome);
    /* il nome di prima resta come alias: i conducenti che lo portano continuano a ritrovarsi */
    const chiesti = [...(m.alias ?? vecchio.alias), ...(nomeCambiato ? [vecchio.nome] : [])];
    const nuovo: Deposito = {
      codice, nome, gruppo: m.gruppo ?? vecchio.gruppo, cadenzaTurni: m.cadenzaTurni ?? vecchio.cadenzaTurni,
      alias: aliasPuliti(chiesti, { nome, codice }), ordine: m.ordine ?? vecchio.ordine,
    };
    const dopo = catalogo.map((x) => (x.codice === codice ? nuovo : x));
    const doppio = collisione(nuovo, catalogo);
    if (doppio) throw new RifiutoDepositi(409, doppio);

    /* nessun conducente resta con un deposito che non si ritrova più (un alias tolto mentre qualcuno lo
     * usa), né per chi legge il catalogo dal codice né per il database che riallinea i conducenti */
    const oggi = oggiRoma();
    const uso = await valoriInUso(ex, oggi);
    const eraSuo = (trova: (v: string, c: Deposito[]) => Deposito | null, v: string) =>
      trova(v, catalogo)?.codice === codice && trova(v, dopo)?.codice !== codice;
    const persi = [...new Set([...uso.correnti.keys(), ...uso.programmati.keys()])]
      .filter((v) => eraSuo(trovaDeposito, v) || eraSuo(comeIlDatabase, v));
    if (persi.length > 0) {
      const quanti = persi.reduce((n, v) => n + (uso.correnti.get(v) ?? 0) + (uso.programmati.get(v) ?? 0), 0);
      throw new RifiutoDepositi(409,
        `${quanti === 1 ? "Un conducente ha" : `${quanti} conducenti hanno`} questo deposito scritto come «${persi.slice(0, 3).join("», «")}»: `
        + "se togli quel nome non si ritrova più. Lascialo fra gli altri nomi");
    }

    await ex.execute(sql`
      UPDATE roster_depositi
         SET nome = ${nuovo.nome}, gruppo = ${nuovo.gruppo}, cadenza_turni = ${nuovo.cadenzaTurni},
             alias = ${testoAlias(nuovo.alias)}::text[], ordine = ${nuovo.ordine}
       WHERE codice = ${codice}`);
    /* i conducenti prendono subito il nome nuovo (lo storico tiene quello di prima, che resta alias) */
    if (nome !== vecchio.nome) await sincronizzaCorrenti(ex, oggi, ["deposito"]);
    return nuovo;
  });
}

export async function cancellaDeposito(codice: string): Promise<void> {
  await sottoLucchetto(async (ex) => {
    const d = (await elencoDepositi(ex)).find((x) => x.codice === codice);
    if (!d) throw new RifiutoDepositi(404, "Deposito non trovato");
    const usi = [
      d.conducenti > 0 ? `${d.conducenti} ${d.conducenti === 1 ? "conducente" : "conducenti"}` : null,
      d.cambiProgrammati > 0 ? `${d.cambiProgrammati} ${d.cambiProgrammati === 1 ? "cambio di deposito programmato" : "cambi di deposito programmati"}` : null,
      d.gruppiTurni > 0 ? `${d.gruppiTurni} ${d.gruppiTurni === 1 ? "gruppo turni" : "gruppi turni"}` : null,
      d.utenti > 0 ? `${d.utenti} ${d.utenti === 1 ? "utente" : "utenti"}` : null,
    ].filter(Boolean);
    if (usi.length > 0) throw new RifiutoDepositi(409, `Il deposito ${d.nome} è in uso (${usi.join(", ")}): prima sposta chi lo usa`);
    await ex.execute(sql`DELETE FROM roster_depositi WHERE codice = ${codice}`);
  });
}
