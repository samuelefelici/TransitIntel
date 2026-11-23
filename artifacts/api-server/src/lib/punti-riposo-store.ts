/**
 * I punti di riposo dei turni guida (tappa 7.22, tabella punti_riposo): dove
 * il conducente fa la pausa di un turno a due riprese fuori residenza. Il
 * calcolo dei turni guida conta retribuita una parte della sosta in quei
 * luoghi: di più se non hanno servizi. Il calcolo li riconosce dai nomi
 * delle fermate (in maiuscolo), come i nodi di sosta dei progetti.
 *
 * Le scritture sono dell'amministratore; la lettura per il calcolo sta in
 * puntiRiposoPerIlCalcolo(), che lib/dati-solver.ts unisce ai nodi di sosta
 * del progetto.
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const MASSIMO_PUNTI = 200;
export const MASSIMO_FERMATE = 50;

export interface PuntoDiRiposo {
  id: string;
  nome: string;
  conServizi: boolean;
  /** i nomi delle fermate del luogo, come li scrive il GTFS */
  fermate: string[];
  nota: string;
}

/** Un punto nel formato che il calcolo dei turni guida riceve in config.restPoints. */
export interface PuntoPerIlCalcolo {
  id: string;
  name: string;
  hasFacilities: boolean;
  stopIds: string[];
  stopNames: string[];
}

const righe = (r: any): any[] => r?.rows ?? r ?? [];

const puntoDa = (r: any): PuntoDiRiposo => ({
  id: String(r.id), nome: String(r.nome), conServizi: r.con_servizi === true,
  fermate: Array.isArray(r.fermate) ? r.fermate.map(String) : [], nota: String(r.nota ?? ""),
});

const COLONNE = sql`id, nome, con_servizi, fermate, nota`;

/** Un elenco di testi come letterale di array di Postgres, in un parametro solo. */
const arrayDiTesti = (v: readonly string[]) => `{${v.map((x) => `"${x.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(",")}}`;

/** Il confronto del calcolo: maiuscole, senza spazi ai lati. */
export const chiaveFermata = (nome: string) => nome.trim().toUpperCase();

/* ── Le regole ────────────────────────────────────────────────────────────── */

export class RifiutoPunti extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const SENZA_CONTROLLO = /^[^\u0000-\u001f\u007f]*$/;
const testo = (max: number, min = 1) => z.string().transform((s) => s.trim()).pipe(
  z.string().min(min, "non può essere vuoto").max(max, `al più ${max} caratteri`).regex(SENZA_CONTROLLO, "senza caratteri di controllo"));

/** Le fermate: senza doppioni (anche scritte con maiuscole diverse), nell'ordine in cui arrivano. */
const senzaDoppioni = (fermate: string[]) => {
  const viste = new Set<string>();
  return fermate.filter((f) => { const k = chiaveFermata(f); if (viste.has(k)) return false; viste.add(k); return true; });
};

export const DatiPunto = z.object({
  nome: testo(120),
  conServizi: z.boolean().default(false),
  fermate: z.array(testo(120)).max(MASSIMO_FERMATE, `al più ${MASSIMO_FERMATE} fermate`).default([]).transform(senzaDoppioni),
  nota: testo(300, 0).default(""),
}).strict();
export type DatiPunto = z.infer<typeof DatiPunto>;

export const ID_PUNTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Lettura ──────────────────────────────────────────────────────────────── */

export async function leggiPunti(): Promise<PuntoDiRiposo[]> {
  return righe(await db.execute(sql`SELECT ${COLONNE} FROM punti_riposo ORDER BY nome`)).map(puntoDa);
}

/** I punti dell'azienda per il calcolo dei turni guida. */
export async function puntiRiposoPerIlCalcolo(): Promise<PuntoPerIlCalcolo[]> {
  return (await leggiPunti()).map((p) => ({ id: p.id, name: p.nome, hasFacilities: p.conServizi, stopIds: [], stopNames: [...p.fermate] }));
}

export interface PuntoNellElenco extends PuntoDiRiposo {
  /** le fermate che non ci sono nel feed in esercizio (o nel più recente): il calcolo non le troverà */
  fermateNonTrovate: string[];
}

/**
 * L'elenco per la pagina dell'amministratore, con le fermate che non ci sono
 * nel feed in esercizio (o, se non ce n'è uno, nel più recente): un nome
 * scritto male non lo riconosce nessun calcolo.
 */
export async function elencoPunti(): Promise<{ punti: PuntoNellElenco[]; massimo: number; feed: string | null }> {
  const punti = await leggiPunti();
  const feed = righe(await db.execute(sql`
    SELECT id::text AS id FROM gtfs_feeds ORDER BY is_active DESC, uploaded_at DESC NULLS LAST LIMIT 1`))[0]?.id ?? null;
  const tutte = [...new Set(punti.flatMap((p) => p.fermate.map(chiaveFermata)))];
  const trovate = new Set<string>(feed && tutte.length
    ? righe(await db.execute(sql`
        SELECT DISTINCT upper(btrim(stop_name)) AS n FROM gtfs_stops
         WHERE feed_id = ${feed}::uuid AND upper(btrim(stop_name)) = ANY (${arrayDiTesti(tutte)}::text[])`))
        .map((r) => String(r.n))
    : []);
  return {
    punti: punti.map((p) => ({ ...p, fermateNonTrovate: feed ? p.fermate.filter((f) => !trovate.has(chiaveFermata(f))) : [] })),
    massimo: MASSIMO_PUNTI,
    feed,
  };
}

/* ── Le scritture dell'amministratore ─────────────────────────────────────── */

const nomeGiaUsato = (e: unknown, nome: string) => {
  const pg = (e as any)?.cause ?? e;
  return pg?.code === "23505" ? new RifiutoPunti(409, `C'è già un punto di riposo «${nome}»`) : null;
};

export async function creaPunto(p: DatiPunto): Promise<PuntoDiRiposo> {
  try {
    const r = righe(await db.execute(sql`
      INSERT INTO punti_riposo (nome, con_servizi, fermate, nota)
      SELECT ${p.nome}::text, ${p.conServizi}::boolean, ${arrayDiTesti(p.fermate)}::text[], ${p.nota}::text
       WHERE (SELECT count(*) FROM punti_riposo) < ${MASSIMO_PUNTI}::integer
      RETURNING ${COLONNE}`));
    if (!r.length) throw new RifiutoPunti(409, `I punti di riposo sono già ${MASSIMO_PUNTI}, il massimo`);
    return puntoDa(r[0]);
  } catch (e) {
    throw nomeGiaUsato(e, p.nome) ?? e;
  }
}

export async function modificaPunto(id: string, p: DatiPunto): Promise<PuntoDiRiposo> {
  try {
    const r = righe(await db.execute(sql`
      UPDATE punti_riposo
         SET nome = ${p.nome}::text, con_servizi = ${p.conServizi}::boolean, fermate = ${arrayDiTesti(p.fermate)}::text[],
             nota = ${p.nota}::text, aggiornato_il = now()
       WHERE id = ${id}::uuid
      RETURNING ${COLONNE}`));
    if (!r.length) throw new RifiutoPunti(404, "Punto di riposo non trovato");
    return puntoDa(r[0]);
  } catch (e) {
    throw nomeGiaUsato(e, p.nome) ?? e;
  }
}

export async function cancellaPunto(id: string): Promise<void> {
  const r = righe(await db.execute(sql`DELETE FROM punti_riposo WHERE id = ${id}::uuid RETURNING id`));
  if (!r.length) throw new RifiutoPunti(404, "Punto di riposo non trovato");
}
