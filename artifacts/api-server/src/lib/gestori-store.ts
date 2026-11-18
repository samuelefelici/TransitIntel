/**
 * I gestori nel database (tabella `gestori`, migrazione 0044): leggerli,
 * gestirli (rotte /api/admin/gestori) e assegnarli alle linee di un programma
 * di Planning Studio. Le regole stanno in lib/gestori.ts.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { gestoreDellaLinea, MASSIMO_GESTORI, type Gestore } from "./gestori";

export class RifiutoGestori extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

type Ex = Pick<typeof db, "execute">;

/* ── Lettura ──────────────────────────────────────────────────────────────── */

function daRiga(x: any): Gestore {
  return {
    gestore: String(x.gestore), nome: String(x.nome), sito: String(x.sito),
    telefono: x.telefono ?? null, email: x.email ?? null, tariffeUrl: x.tariffe_url ?? null,
    predefinito: x.predefinito === true,
  };
}

/** I gestori come stanno nel database, nell'ordine dell'elenco. */
export async function gestoriDalDatabase(ex: Ex = db): Promise<Gestore[]> {
  const r = await ex.execute<any>(sql`
    SELECT gestore, nome, sito, telefono, email, tariffe_url, predefinito FROM gestori ORDER BY ordine, gestore`);
  return r.rows.map(daRiga);
}

/** Un gestore dell'elenco con le linee che lo dicono nei programmi di lavoro (non nelle versioni pubblicate). */
export interface GestoreConLinee extends Gestore { linee: number }

export interface ElencoGestori {
  gestori: GestoreConLinee[];
  /** le linee dei programmi di lavoro che non dicono un gestore dell'elenco: prendono il predefinito */
  lineeSenzaGestore: number;
  massimo: number;
}

export async function elencoGestori(): Promise<ElencoGestori> {
  const gestori = await gestoriDalDatabase();
  const r = await db.execute<any>(sql`
    SELECT r.agency_id AS gestore, count(*)::int AS linee
      FROM ps_routes r JOIN ps_projects p ON p.id = r.project_id
     WHERE p.versione_di IS NULL
     GROUP BY r.agency_id`);
  const perId = new Map<string | null, number>(r.rows.map((x) => [x.gestore ?? null, Number(x.linee)]));
  const noti = new Set(gestori.map((g) => g.gestore));
  let senza = 0;
  for (const [id, n] of perId) if (id === null || !noti.has(id)) senza += n;
  return {
    gestori: gestori.map((g) => ({ ...g, linee: perId.get(g.gestore) ?? 0 })),
    lineeSenzaGestore: gestori.length ? senza : 0,
    massimo: MASSIMO_GESTORI,
  };
}

/* ── Quello che l'amministratore può salvare ──────────────────────────────── */

/* gli stessi limiti dei vincoli della tabella: qui si dice in chiaro che cosa non va */
const ID = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/, "identificativo: solo lettere, cifre e . _ - (al più 40)");
const NOME = z.string().trim().min(1, "il nome non può essere vuoto").max(120, "il nome ha al più 120 caratteri")
  .regex(/^[^\u0000-\u001f\u007f"]*$/, "il nome non può contenere virgolette né caratteri di controllo");
const URL_HTTP = z.string().trim().regex(/^https?:\/\/[^\s",<>]{1,200}$/, "l'indirizzo comincia con http:// o https://, senza spazi né virgole");
const facoltativo = <T extends z.ZodTypeAny>(tipo: T) =>
  z.preprocess((v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : v), tipo.nullable());
const TELEFONO = facoltativo(z.string().trim().regex(/^[0-9+() ./-]{3,40}$/, "telefono: solo cifre, spazi e + ( ) . / -"));
const POSTA = facoltativo(z.string().trim().regex(/^[^\s",<>@]{1,64}@[^\s",<>@]{1,190}$/, "l'indirizzo di posta non è valido"));

export const NuovoGestore = z.object({
  gestore: ID, nome: NOME, sito: URL_HTTP, telefono: TELEFONO, email: POSTA, tariffeUrl: facoltativo(URL_HTTP),
}).strict();

/** Tutto tranne l'identificativo. `predefinito: true` lo fa diventare il predefinito al posto di quello di prima. */
export const ModificaGestore = z.object({
  nome: NOME.optional(), sito: URL_HTTP.optional(), telefono: TELEFONO.optional(), email: POSTA.optional(),
  tariffeUrl: facoltativo(URL_HTTP).optional(), predefinito: z.literal(true).optional(),
}).strict();

/** Il primo messaggio di una validazione fallita. */
export function erroreGestore(e: z.ZodError): string {
  const estranei = e.issues.filter((i) => i.code === "unrecognized_keys").flatMap((i: any) => (i.keys as string[]).map((k) => String(k).slice(0, 40)));
  if (estranei.length) return `Campo non previsto: ${estranei.slice(0, 5).join(", ")}`;
  const i = e.issues[0];
  if (!i) return "Richiesta non valida";
  return i.path[0] === "predefinito" ? "Il predefinito si sceglie, non si toglie: scegline un altro" : i.message;
}

const chiuso = (tx: Ex) => tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:gestori'))`);

/** Aggiunge un gestore in fondo all'elenco. Il primo diventa il predefinito. */
export async function creaGestore(d: z.infer<typeof NuovoGestore>): Promise<Gestore> {
  return db.transaction(async (tx) => {
    await chiuso(tx);
    const prima = await gestoriDalDatabase(tx);
    if (prima.some((g) => g.gestore === d.gestore)) throw new RifiutoGestori(409, `C'è già un gestore con l'identificativo «${d.gestore}»`);
    if (prima.length >= MASSIMO_GESTORI) throw new RifiutoGestori(409, `I gestori sono al più ${MASSIMO_GESTORI}`);
    const g: Gestore = {
      gestore: d.gestore, nome: d.nome, sito: d.sito, telefono: d.telefono ?? null, email: d.email ?? null,
      tariffeUrl: d.tariffeUrl ?? null, predefinito: prima.length === 0,
    };
    await tx.execute(sql`
      INSERT INTO gestori (gestore, nome, sito, telefono, email, tariffe_url, predefinito, ordine)
      VALUES (${g.gestore}, ${g.nome}, ${g.sito}, ${g.telefono}, ${g.email}, ${g.tariffeUrl}, ${g.predefinito},
              (SELECT coalesce(max(ordine), 0) + 10 FROM gestori))`);
    return g;
  });
}

/** Cambia un gestore; l'identificativo no. Tocca la riga solo se cambia qualcosa. */
export async function modificaGestore(gestore: string, d: z.infer<typeof ModificaGestore>): Promise<Gestore> {
  return db.transaction(async (tx) => {
    await chiuso(tx);
    const prima = (await gestoriDalDatabase(tx)).find((g) => g.gestore === gestore);
    if (!prima) throw new RifiutoGestori(404, "Gestore non trovato");
    const dopo: Gestore = {
      ...prima,
      nome: d.nome ?? prima.nome, sito: d.sito ?? prima.sito,
      telefono: d.telefono === undefined ? prima.telefono : d.telefono,
      email: d.email === undefined ? prima.email : d.email,
      tariffeUrl: d.tariffeUrl === undefined ? prima.tariffeUrl : d.tariffeUrl,
      predefinito: prima.predefinito || d.predefinito === true,
    };
    /* il predefinito è al più uno: prima lo perde quello di prima, poi lo prende questo */
    if (dopo.predefinito && !prima.predefinito) {
      await tx.execute(sql`UPDATE gestori SET predefinito = false, aggiornato_il = now() WHERE predefinito`);
    }
    await tx.execute(sql`
      UPDATE gestori
         SET nome = ${dopo.nome}, sito = ${dopo.sito}, telefono = ${dopo.telefono}, email = ${dopo.email},
             tariffe_url = ${dopo.tariffeUrl}, predefinito = ${dopo.predefinito}, aggiornato_il = now()
       WHERE gestore = ${gestore}
         AND (nome, sito, telefono, email, tariffe_url, predefinito)
             IS DISTINCT FROM (${dopo.nome}, ${dopo.sito}, ${dopo.telefono}::text, ${dopo.email}::text, ${dopo.tariffeUrl}::text, ${dopo.predefinito}::boolean)`);
    return dopo;
  });
}

/**
 * Toglie un gestore. Le linee che lo dicono non si toccano: da qui prendono
 * il predefinito, e tornano sue se lo si rimette. Il predefinito si toglie
 * solo per ultimo: prima se ne sceglie un altro.
 */
export async function cancellaGestore(gestore: string): Promise<{ restano: number }> {
  return db.transaction(async (tx) => {
    await chiuso(tx);
    const prima = await gestoriDalDatabase(tx);
    const g = prima.find((x) => x.gestore === gestore);
    if (!g) throw new RifiutoGestori(404, "Gestore non trovato");
    if (g.predefinito && prima.length > 1) {
      throw new RifiutoGestori(409, `«${g.nome}» è il gestore predefinito: prima scegline un altro come predefinito.`);
    }
    await tx.execute(sql`DELETE FROM gestori WHERE gestore = ${gestore}`);
    return { restano: prima.length - 1 };
  });
}

/* ── I gestori delle linee di un programma (Planning Studio) ──────────────── */

export interface LineaColGestore {
  id: string;
  shortName: string;
  longName: string | null;
  /** quello che la linea dice (ps_routes.agency_id): può non essere nell'elenco */
  detto: string | null;
  /** il gestore che vale: il suo, o il predefinito; null se non ci sono gestori */
  gestore: string | null;
  /** false se vale il predefinito perché la linea non ne dice uno dell'elenco */
  assegnato: boolean;
}

export interface GestoriDelProgramma {
  /** per la tendina: identificativo, nome e chi è il predefinito */
  gestori: Array<Pick<Gestore, "gestore" | "nome" | "predefinito">>;
  linee: LineaColGestore[];
}

export async function gestoriDelProgramma(progettoId: string): Promise<GestoriDelProgramma> {
  const gestori = await gestoriDalDatabase();
  const r = await db.execute<any>(sql`
    SELECT id, short_name, long_name, agency_id FROM ps_routes
     WHERE project_id = ${progettoId}::uuid ORDER BY sort_order ASC, short_name ASC`);
  return {
    gestori: gestori.map((g) => ({ gestore: g.gestore, nome: g.nome, predefinito: g.predefinito })),
    linee: r.rows.map((x) => {
      const vale = gestoreDellaLinea(x.agency_id, gestori);
      return {
        id: String(x.id), shortName: String(x.short_name ?? ""), longName: x.long_name ?? null, detto: x.agency_id ?? null,
        gestore: vale?.gestore.gestore ?? null, assegnato: vale?.assegnato ?? false,
      };
    }),
  };
}

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "una linea non è valida");
export const AssegnaGestore = z.object({
  /** null: le linee tornano senza un gestore loro, e prendono il predefinito */
  gestore: ID.nullable(),
  linee: z.array(UUID).min(1, "scegli almeno una linea").max(5000, "al più 5000 linee per volta"),
}).strict();

/**
 * Assegna un gestore a un insieme di linee del programma, in una sola
 * istruzione. Le linee che non sono di questo programma si ignorano; quelle
 * che hanno già quel gestore non si toccano. Dice quante sono cambiate.
 */
export async function assegnaGestore(progettoId: string, d: z.infer<typeof AssegnaGestore>): Promise<{ cambiate: number; gestore: string | null }> {
  if (d.gestore !== null) {
    const gestori = await gestoriDalDatabase();
    if (!gestori.some((g) => g.gestore === d.gestore)) {
      throw new RifiutoGestori(400, gestori.length
        ? `«${d.gestore}» non è fra i gestori: lo aggiunge l'amministratore in Amministrazione › Azienda.`
        : "Non ci sono gestori: li scrive l'amministratore in Amministrazione › Azienda.");
    }
  }
  const r = await db.execute(sql`
    UPDATE ps_routes SET agency_id = ${d.gestore}, updated_at = now()
     WHERE project_id = ${progettoId}::uuid
       AND id IN (SELECT (pg_catalog.jsonb_array_elements_text(${JSON.stringify(d.linee)}::jsonb))::uuid)
       AND agency_id IS DISTINCT FROM ${d.gestore}::text`);
  return { cambiate: r.rowCount ?? 0, gestore: d.gestore };
}
