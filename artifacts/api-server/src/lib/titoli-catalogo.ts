/**
 * Il catalogo dei titoli di viaggio (tappa 6.9, migrazione 0042).
 *
 * I biglietti e gli abbonamenti con cui si riempie un feed erano tre elenchi
 * nel codice, con i nomi e i prezzi di una sola azienda. Ora sono un catalogo
 * dell'azienda (tabella `titoli_catalogo`): lo gestisce l'amministratore
 * (GET, POST, PUT e DELETE /api/admin/titoli) e ogni modifica resta nel
 * registro. Dalla pagina Tariffe, chi riempie un feed copia da qui.
 *
 * Tre cose in più, che il codice di prima non faceva:
 *   - riempire un feed non crea doppioni: si aggiungono solo i titoli che
 *     nel feed mancano (prima ogni pressione del pulsante li raddoppiava);
 *   - i titoli già nel feed non si toccano: per portarli ai nomi e ai prezzi
 *     del catalogo e delle fasce c'è un'azione a parte, che prima dice che
 *     cosa cambierebbe (`confrontoColCatalogo`, `allineaAlCatalogo`);
 *   - i doppioni che ci sono già si tolgono con `togliDoppioni`.
 *
 * I biglietti extraurbani di corsa semplice non stanno nel catalogo: sono uno
 * per fascia chilometrica, col prezzo della fascia (lib/fasce-km.ts).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { fasceKm, SenzaFasce, type FasciaKm } from "./fasce-km";
import { RETE_EXTRAURBANA, retiUrbane, type ReteUrbana } from "./reti-linee";

export class RifiutoTitoli extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

type Ex = Pick<typeof db, "execute">;
const righe = (r: any): any[] => (Array.isArray(r) ? r : r?.rows ?? []);

/** I tipi di un titolo del catalogo. I biglietti extraurbani per fascia (tipo «zone») vengono dalle fasce, non da qui. */
export const TIPI_TITOLO = ["single", "return", "abbonamento_settimanale", "abbonamento_mensile", "abbonamento_annuale"] as const;
export type TipoTitolo = (typeof TIPI_TITOLO)[number];
export const eBiglietto = (tipo: string): boolean => tipo === "single" || tipo === "return";

export const MASSIMO_TITOLI = 1000;

/** Un titolo del catalogo. */
export interface TitoloCatalogo {
  /** l'identificativo, quello che finisce nel GTFS (fare_product_id): non cambia */
  titolo: string;
  nome: string;
  rete: string;
  tipo: TipoTitolo;
  /** la categoria di passeggero: «ordinario», «studente»… */
  categoria: string;
  prezzo: number;
  durataMinuti: number | null;
  /** solo per i titoli extraurbani col prezzo per fascia chilometrica: il numero della fascia */
  fascia: number | null;
  /** il biglietto di corsa semplice con cui si calcola il prezzo di una corsa sulla sua rete urbana */
  diRiferimento: boolean;
  ordine: number;
}

/* ── le regole, senza database ─────────────────────────────────────────── */

/** Un titolo come va scritto in un feed (gtfs_fare_products). */
export interface TitoloNelFeed {
  id: string;
  nome: string;
  rete: string;
  tipo: string;
  categoria: string;
  prezzo: number;
  durata: number | null;
  /** il biglietto orario di riferimento della sua rete urbana (is_urban_hourly) */
  orario: boolean;
}

/** L'identificativo e il nome del biglietto extraurbano di corsa semplice di una fascia. */
export const idBigliettoFascia = (fascia: number): string => `extra_fascia_${fascia}`;

/** I biglietti extraurbani di corsa semplice: uno per fascia, col suo prezzo. */
export function bigliettiDelleFasce(fasce: readonly FasciaKm[]): TitoloNelFeed[] {
  return fasce.map((b) => ({
    id: idBigliettoFascia(b.fascia), nome: `Extraurbano ${b.kmFrom}-${b.kmTo} km`, rete: RETE_EXTRAURBANA, tipo: "zone",
    categoria: "ordinario", prezzo: b.price, durata: null, orario: false,
  }));
}

/**
 * Un titolo del catalogo come va scritto in un feed. Un titolo per fascia
 * prende nel nome la fascia e i suoi chilometri; se quella fascia non c'è fra
 * le fasce in vigore il titolo non si scrive (null).
 */
export function titoloNelFeed(t: TitoloCatalogo, fasce: readonly FasciaKm[]): TitoloNelFeed | null {
  const base = { id: t.titolo, rete: t.rete, tipo: t.tipo, categoria: t.categoria, prezzo: t.prezzo, durata: t.durataMinuti, orario: t.diRiferimento };
  if (t.fascia === null) return { ...base, nome: t.nome };
  const b = fasce.find((x) => x.fascia === t.fascia);
  return b ? { ...base, nome: `${t.nome} — Fascia ${b.fascia} (${b.kmFrom}–${b.kmTo} km)` } : null;
}

/** Che cosa copiare in un feed: solo i biglietti (coi biglietti delle fasce), oppure tutto il catalogo. */
export type Quali = "biglietti" | "catalogo";

/**
 * I titoli da copiare in un feed. Se il catalogo ha titoli per fascia ma
 * l'azienda non ha scritto le fasce, non si può: `SenzaFasce`.
 */
export function titoliDaCopiare(catalogo: readonly TitoloCatalogo[], fasce: readonly FasciaKm[], quali: Quali): TitoloNelFeed[] {
  const scelti = quali === "biglietti" ? catalogo.filter((t) => eBiglietto(t.tipo)) : catalogo;
  if (fasce.length === 0 && scelti.some((t) => t.fascia !== null)) throw new SenzaFasce();
  const dalCatalogo = scelti.map((t) => titoloNelFeed(t, fasce)).filter((t): t is TitoloNelFeed => t !== null);
  return quali === "biglietti" ? [...dalCatalogo, ...bigliettiDelleFasce(fasce)] : dalCatalogo;
}

/** Un titolo come sta in un feed, per le regole di tratta e per il biglietto di riferimento. */
export interface ProdottoDelFeed {
  fareProductId: string;
  fareProductName: string;
  networkId: string | null;
  fareType: string;
  amount: number;
  durationMinutes: number | null;
  isUrbanHourly: boolean;
}

/** Una regola di tratta urbana: su quella rete vale quel titolo, ovunque. */
export interface RegolaUrbana { legGroupId: string; networkId: string; fareProductId: string }

/**
 * Le regole di tratta delle reti urbane, dai titoli che ci sono nel feed: per
 * ogni rete urbana dell'azienda, una regola per ogni biglietto (di corsa
 * semplice o di andata e ritorno) che ha una durata. Prima erano sei regole
 * scritte a mano per tre reti, verso titoli che nel feed potevano non esserci.
 * L'ordine: le reti come nell'elenco, poi la durata, poi il prezzo.
 */
export function regoleUrbane(prodotti: readonly ProdottoDelFeed[], urbane: readonly Pick<ReteUrbana, "rete">[]): RegolaUrbana[] {
  const posto = new Map(urbane.map((r, i) => [r.rete, i]));
  const visti = new Set<string>();
  return prodotti
    .filter((p) => p.networkId !== null && posto.has(p.networkId) && eBiglietto(p.fareType) && (p.durationMinutes ?? 0) > 0)
    .sort((a, b) => posto.get(a.networkId!)! - posto.get(b.networkId!)! || a.durationMinutes! - b.durationMinutes!
      || Number(a.fareType === "return") - Number(b.fareType === "return") || a.amount - b.amount || a.fareProductId.localeCompare(b.fareProductId))
    .filter((p) => (visti.has(p.fareProductId) ? false : (visti.add(p.fareProductId), true)))
    .map((p) => ({ legGroupId: `lg_${p.fareProductId.replace(/min$/, "")}`, networkId: p.networkId!, fareProductId: p.fareProductId }));
}

/** Il biglietto con cui si dà il prezzo di una corsa su una rete urbana. */
export interface BigliettoDiRiferimento { id: string; name: string; price: number; durationMin: number | null }

/* ── il catalogo nel database ──────────────────────────────────────────── */

function titoloDa(r: any): TitoloCatalogo {
  return {
    titolo: String(r.titolo), nome: String(r.nome), rete: String(r.rete), tipo: r.tipo as TipoTitolo, categoria: String(r.categoria),
    prezzo: Number(r.prezzo), durataMinuti: r.durata_minuti == null ? null : Number(r.durata_minuti),
    fascia: r.fascia == null ? null : Number(r.fascia), diRiferimento: r.di_riferimento === true, ordine: Number(r.ordine),
  };
}

/** Il catalogo, nell'ordine in cui si mostra. */
export async function catalogoTitoli(ex: Ex = db): Promise<TitoloCatalogo[]> {
  return righe(await ex.execute(sql`
    SELECT titolo, nome, rete, tipo, categoria, prezzo, durata_minuti, fascia, di_riferimento, ordine
      FROM titoli_catalogo ORDER BY ordine, titolo`)).map(titoloDa);
}

const TITOLO = z.string().trim().regex(/^[a-z][a-z0-9_]{1,59}$/, "identificativo: lettere minuscole, cifre e trattini bassi, come «urbano_60min»");
const NOME = z.string().trim().min(1, "nome: almeno un carattere").max(120, "nome: al più 120 caratteri")
  .regex(/^[^"\p{Cc}]+$/u, "nome: niente virgolette doppie né a capo (finisce nei file del GTFS)");
const RETE = z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "rete: scegli una rete dell'elenco");
const CATEGORIA = z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "categoria: lettere minuscole, cifre e trattini bassi, come «studente»");
const decimali = (n: number, cifre: number) => Math.abs(n * 10 ** cifre - Math.round(n * 10 ** cifre)) < 1e-6;
const PREZZO = z.number().min(0, "prezzo: da zero in su").max(99999.99, "prezzo: al più 99.999,99 €").refine((n) => decimali(n, 2), "prezzo: al più due decimali");
const DURATA = z.number().int("durata: un numero intero di minuti").min(1, "durata: almeno un minuto").max(5256000, "durata: al più dieci anni");
const FASCIA = z.number().int().min(1, "fascia: da 1 in su").max(60, "fascia: al più 60");
const ORDINE = z.number().int().min(0).max(99999);

export const NuovoTitolo = z.object({
  titolo: TITOLO,
  nome: NOME,
  rete: RETE,
  tipo: z.enum(TIPI_TITOLO),
  categoria: CATEGORIA.default("ordinario"),
  prezzo: PREZZO,
  durataMinuti: DURATA.nullable().default(null),
  fascia: FASCIA.nullable().default(null),
  diRiferimento: z.boolean().default(false),
  ordine: ORDINE.optional(),
}).strict();

export const ModificaTitolo = z.object({
  nome: NOME.optional(),
  rete: RETE.optional(),
  tipo: z.enum(TIPI_TITOLO).optional(),
  categoria: CATEGORIA.optional(),
  prezzo: PREZZO.optional(),
  durataMinuti: DURATA.nullable().optional(),
  fascia: FASCIA.nullable().optional(),
  diRiferimento: z.boolean().optional(),
  ordine: ORDINE.optional(),
}).strict();

/** Che cosa non torna in un titolo rispetto alla sua rete; null se sta in piedi. */
export function difettoDelTitolo(t: Pick<TitoloCatalogo, "rete" | "tipo" | "fascia" | "diRiferimento">, tipoRete: "urbano" | "extraurbano"): string | null {
  if (t.fascia !== null && tipoRete !== "extraurbano") return "fascia: solo un titolo extraurbano ha un prezzo per fascia chilometrica";
  if (t.diRiferimento && (tipoRete !== "urbano" || t.tipo !== "single")) {
    return "biglietto di riferimento: può esserlo solo un biglietto di corsa semplice di una rete urbana";
  }
  return null;
}

export interface ElencoTitoli { titoli: TitoloCatalogo[]; massimo: number }

export async function elencoTitoli(): Promise<ElencoTitoli> {
  return { titoli: await catalogoTitoli(), massimo: MASSIMO_TITOLI };
}

async function blocca(ex: Ex, che: string): Promise<void> {
  await ex.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`cerbero:titoli:${che}`}))`);
}

/** Il tipo della rete di un titolo; rifiuta se la rete non c'è. */
async function tipoDellaRete(ex: Ex, rete: string): Promise<"urbano" | "extraurbano"> {
  const r = righe(await ex.execute(sql`SELECT tipo FROM reti WHERE rete = ${rete}`))[0];
  if (!r) throw new RifiutoTitoli(400, `rete: la rete «${rete}» non c'è`);
  return r.tipo === "urbano" ? "urbano" : "extraurbano";
}

/** Il biglietto di riferimento di una rete è uno solo: chi lo diventa lo toglie all'altro. */
async function unSoloRiferimento(ex: Ex, t: TitoloCatalogo): Promise<void> {
  if (!t.diRiferimento) return;
  await ex.execute(sql`UPDATE titoli_catalogo SET di_riferimento = false, aggiornato_il = now()
                        WHERE rete = ${t.rete} AND di_riferimento AND titolo <> ${t.titolo}`);
}

export async function creaTitolo(d: z.infer<typeof NuovoTitolo>): Promise<TitoloCatalogo> {
  return db.transaction(async (tx) => {
    await blocca(tx, "catalogo");
    const stato = righe(await tx.execute(sql`
      SELECT count(*)::int AS n, coalesce(max(ordine), 0)::int AS ultimo, bool_or(titolo = ${d.titolo}) AS esiste FROM titoli_catalogo`))[0];
    if (stato.esiste) throw new RifiutoTitoli(409, `C'è già un titolo «${d.titolo}» nel catalogo`);
    if (stato.n >= MASSIMO_TITOLI) throw new RifiutoTitoli(409, `Il catalogo ha già ${MASSIMO_TITOLI} titoli, il massimo`);
    const t: TitoloCatalogo = { ...d, ordine: d.ordine ?? Math.min(99999, stato.ultimo + 1) };
    const difetto = difettoDelTitolo(t, await tipoDellaRete(tx, t.rete));
    if (difetto) throw new RifiutoTitoli(400, difetto);
    await unSoloRiferimento(tx, t);
    await tx.execute(sql`
      INSERT INTO titoli_catalogo (titolo, nome, rete, tipo, categoria, prezzo, durata_minuti, fascia, di_riferimento, ordine)
      VALUES (${t.titolo}, ${t.nome}, ${t.rete}, ${t.tipo}, ${t.categoria}, ${t.prezzo}, ${t.durataMinuti}, ${t.fascia}, ${t.diRiferimento}, ${t.ordine})`);
    return t;
  });
}

export async function modificaTitolo(titolo: string, m: z.infer<typeof ModificaTitolo>): Promise<TitoloCatalogo> {
  return db.transaction(async (tx) => {
    await blocca(tx, "catalogo");
    const prima = (await catalogoTitoli(tx)).find((t) => t.titolo === titolo);
    if (!prima) throw new RifiutoTitoli(404, "Titolo non trovato");
    const dopo: TitoloCatalogo = {
      ...prima,
      nome: m.nome ?? prima.nome, rete: m.rete ?? prima.rete, tipo: m.tipo ?? prima.tipo, categoria: m.categoria ?? prima.categoria,
      prezzo: m.prezzo ?? prima.prezzo, durataMinuti: m.durataMinuti === undefined ? prima.durataMinuti : m.durataMinuti,
      fascia: m.fascia === undefined ? prima.fascia : m.fascia, diRiferimento: m.diRiferimento ?? prima.diRiferimento, ordine: m.ordine ?? prima.ordine,
    };
    const difetto = difettoDelTitolo(dopo, await tipoDellaRete(tx, dopo.rete));
    if (difetto) throw new RifiutoTitoli(400, difetto);
    await unSoloRiferimento(tx, dopo);
    await tx.execute(sql`
      UPDATE titoli_catalogo
         SET nome = ${dopo.nome}, rete = ${dopo.rete}, tipo = ${dopo.tipo}, categoria = ${dopo.categoria}, prezzo = ${dopo.prezzo},
             durata_minuti = ${dopo.durataMinuti}, fascia = ${dopo.fascia}, di_riferimento = ${dopo.diRiferimento}, ordine = ${dopo.ordine},
             aggiornato_il = now()
       WHERE titolo = ${titolo}`);
    return dopo;
  });
}

/** Toglie un titolo dal catalogo. I feed che l'hanno già copiato lo tengono. */
export async function cancellaTitolo(titolo: string): Promise<void> {
  const r = await db.execute(sql`DELETE FROM titoli_catalogo WHERE titolo = ${titolo} RETURNING titolo`);
  if (righe(r).length === 0) throw new RifiutoTitoli(404, "Titolo non trovato");
}

/* ── dal catalogo a un feed ────────────────────────────────────────────── */

const comeJson = (titoli: readonly TitoloNelFeed[]) => JSON.stringify(titoli);
const DAL_JSON = sql`AS v(id text, nome text, rete text, tipo text, categoria text, prezzo float8, durata int, orario boolean)`;

export interface EsitoCopia {
  /** i titoli aggiunti adesso */
  aggiunti: number;
  /** i titoli che nel feed c'erano già, e non sono stati toccati */
  presenti: number;
}

/**
 * Copia in un feed i titoli che mancano: i biglietti (quelli del catalogo e
 * quelli delle fasce) oppure tutto il catalogo. Quelli che ci sono già non si
 * toccano e non si raddoppiano. Un feed alla volta: due pressioni insieme non
 * si pestano i piedi.
 */
export async function copiaDalCatalogo(feedId: string, quali: Quali): Promise<EsitoCopia> {
  return db.transaction(async (tx) => {
    await blocca(tx, feedId);
    const titoli = titoliDaCopiare(await catalogoTitoli(tx), fasceKm(), quali);
    if (titoli.length === 0) return { aggiunti: 0, presenti: 0 };
    const r = await tx.execute(sql`
      INSERT INTO gtfs_fare_products
             (feed_id, fare_product_id, fare_product_name, network_id, amount, duration_minutes, fare_type, is_urban_hourly, rider_category_id, fare_media_id)
      SELECT ${feedId}::uuid, v.id, v.nome, v.rete, v.prezzo, v.durata, v.tipo, v.orario, v.categoria, NULL
        FROM jsonb_to_recordset(${comeJson(titoli)}::jsonb) ${DAL_JSON}
       WHERE NOT EXISTS (SELECT 1 FROM gtfs_fare_products p WHERE p.feed_id = ${feedId}::uuid AND p.fare_product_id = v.id)
      RETURNING fare_product_id`);
    const aggiunti = righe(r).length;
    return { aggiunti, presenti: titoli.length - aggiunti };
  });
}

/** Un titolo del feed che non è come nel catalogo (o come la sua fascia). */
export interface TitoloDiverso {
  id: string;
  /** che cosa è diverso, a parole: «prezzo 1,35 → 1,50» */
  differenze: string[];
}

const euro = (n: number) => n.toFixed(2).replace(".", ",");

/** Le differenze fra un titolo del feed e quello del catalogo, a parole. */
export function differenze(nelFeed: { nome: string; rete: string | null; tipo: string; categoria: string | null; prezzo: number; durata: number | null }, t: TitoloNelFeed): string[] {
  const d: string[] = [];
  if (Math.abs(nelFeed.prezzo - t.prezzo) > 0.004) d.push(`prezzo ${euro(nelFeed.prezzo)} → ${euro(t.prezzo)}`);
  if (nelFeed.nome !== t.nome) d.push(`nome «${nelFeed.nome}» → «${t.nome}»`);
  if (nelFeed.durata !== t.durata) d.push(`durata ${nelFeed.durata ?? "nessuna"} → ${t.durata ?? "nessuna"}`);
  if (nelFeed.tipo !== t.tipo) d.push(`tipo ${nelFeed.tipo} → ${t.tipo}`);
  if ((nelFeed.rete ?? "") !== t.rete) d.push(`rete ${nelFeed.rete ?? "nessuna"} → ${t.rete}`);
  if ((nelFeed.categoria ?? "") !== t.categoria) d.push(`categoria ${nelFeed.categoria ?? "nessuna"} → ${t.categoria}`);
  return d;
}

export interface ConfrontoColCatalogo {
  /** i titoli del catalogo (e delle fasce) che nel feed mancano */
  mancanti: number;
  /** i titoli del feed che ci sono nel catalogo, ma diversi */
  diversi: TitoloDiverso[];
  /** i titoli del feed uguali al catalogo */
  uguali: number;
}

/** Tutti i titoli che il catalogo e le fasce danno, per il confronto. Se mancano le fasce, i soli titoli senza fascia. */
function tuttiITitoli(catalogo: readonly TitoloCatalogo[]): TitoloNelFeed[] {
  const fasce = fasceKm();
  return [
    ...catalogo.map((t) => titoloNelFeed(t, fasce)).filter((t): t is TitoloNelFeed => t !== null),
    ...bigliettiDelleFasce(fasce),
  ];
}

/** Che cosa ha il feed di diverso dal catalogo e dalle fasce. Non scrive niente. */
export async function confrontoColCatalogo(feedId: string, ex: Ex = db): Promise<ConfrontoColCatalogo> {
  const attesi = new Map(tuttiITitoli(await catalogoTitoli(ex)).map((t) => [t.id, t]));
  const nelFeed = righe(await ex.execute(sql`
    SELECT DISTINCT ON (fare_product_id) fare_product_id AS id, fare_product_name AS nome, network_id AS rete, fare_type AS tipo,
           rider_category_id AS categoria, amount AS prezzo, duration_minutes AS durata
      FROM gtfs_fare_products WHERE feed_id = ${feedId}::uuid
     ORDER BY fare_product_id, is_urban_hourly DESC, (duration_minutes IS NULL), created_at, id`));
  const diversi: TitoloDiverso[] = [];
  let uguali = 0;
  const visti = new Set<string>();
  for (const p of nelFeed) {
    const t = attesi.get(String(p.id));
    if (!t) continue;
    visti.add(t.id);
    const d = differenze({ nome: String(p.nome), rete: p.rete, tipo: String(p.tipo), categoria: p.categoria, prezzo: Number(p.prezzo), durata: p.durata == null ? null : Number(p.durata) }, t);
    if (d.length) diversi.push({ id: t.id, differenze: d }); else uguali++;
  }
  return { mancanti: attesi.size - visti.size, diversi, uguali };
}

/**
 * Porta i titoli del feed ai nomi, ai prezzi e alle durate del catalogo e
 * delle fasce: solo quelli che ci sono già e sono diversi. Non aggiunge i
 * mancanti (lo fa `copiaDalCatalogo`) e non tocca il biglietto di riferimento
 * scelto nel feed.
 */
export async function allineaAlCatalogo(feedId: string): Promise<{ allineati: number }> {
  return db.transaction(async (tx) => {
    await blocca(tx, feedId);
    const titoli = tuttiITitoli(await catalogoTitoli(tx));
    if (titoli.length === 0) return { allineati: 0 };
    const r = await tx.execute(sql`
      UPDATE gtfs_fare_products p
         SET fare_product_name = v.nome, network_id = v.rete, fare_type = v.tipo, rider_category_id = v.categoria,
             amount = v.prezzo, duration_minutes = v.durata, updated_at = now()
        FROM jsonb_to_recordset(${comeJson(titoli)}::jsonb) ${DAL_JSON}
       WHERE p.feed_id = ${feedId}::uuid AND p.fare_product_id = v.id
         AND (p.fare_product_name, p.network_id, p.fare_type, p.rider_category_id, round(p.amount::numeric, 2), p.duration_minutes)
             IS DISTINCT FROM (v.nome, v.rete, v.tipo, v.categoria, round(v.prezzo::numeric, 2), v.durata)
      RETURNING p.fare_product_id`);
    return { allineati: new Set(righe(r).map((x: any) => x.fare_product_id)).size };
  });
}

/**
 * Toglie i doppioni di un feed: più righe con lo stesso titolo, la stessa
 * categoria e lo stesso supporto. Resta una riga sola: quella di riferimento
 * se c'è, poi quella con la durata, poi la più vecchia.
 */
export async function togliDoppioni(feedId: string): Promise<{ tolti: number; restano: number }> {
  return db.transaction(async (tx) => {
    await blocca(tx, feedId);
    const tolti = righe(await tx.execute(sql`
      DELETE FROM gtfs_fare_products p
       USING (
         SELECT id, row_number() OVER (
                  PARTITION BY fare_product_id, coalesce(rider_category_id, ''), coalesce(fare_media_id, '')
                  ORDER BY is_urban_hourly DESC, (duration_minutes IS NULL), created_at, id) AS posto
           FROM gtfs_fare_products WHERE feed_id = ${feedId}::uuid
       ) d
       WHERE p.id = d.id AND d.posto > 1
      RETURNING p.id`)).length;
    const restano = Number(righe(await tx.execute(sql`SELECT count(*)::int AS n FROM gtfs_fare_products WHERE feed_id = ${feedId}::uuid`))[0]?.n ?? 0);
    return { tolti, restano };
  });
}

/** Quanti doppioni ha un feed (righe in più dello stesso titolo, categoria e supporto). */
export async function contaDoppioni(feedId: string, ex: Ex = db): Promise<number> {
  const r = righe(await ex.execute(sql`
    SELECT (count(*) - count(DISTINCT (fare_product_id, coalesce(rider_category_id, ''), coalesce(fare_media_id, ''))))::int AS n
      FROM gtfs_fare_products WHERE feed_id = ${feedId}::uuid`))[0];
  return Number(r?.n ?? 0);
}

/**
 * Il biglietto con cui dare il prezzo di una corsa su ogni rete urbana. Dal
 * feed: quello marcato come biglietto orario di riferimento; se non ce n'è
 * uno marcato, il biglietto di corsa semplice con una durata che costa meno.
 * Per le reti che nel feed non hanno titoli, dal catalogo dell'azienda. Una
 * rete senza nessun biglietto di corsa semplice non compare.
 */
export async function bigliettiDiRiferimento(feedId: string, ex: Ex = db): Promise<Map<string, BigliettoDiRiferimento>> {
  const urbane = retiUrbane().map((r) => r.rete);
  const trovati = new Map<string, BigliettoDiRiferimento>();
  if (urbane.length === 0) return trovati;
  const elenco = sql.join(urbane.map((rete) => sql`${rete}`), sql`, `);
  for (const r of righe(await ex.execute(sql`
    SELECT DISTINCT ON (network_id) network_id AS rete, fare_product_id AS id, fare_product_name AS nome, amount AS prezzo, duration_minutes AS durata
      FROM gtfs_fare_products
     WHERE feed_id = ${feedId}::uuid AND fare_type = 'single' AND network_id IN (${elenco})
     ORDER BY network_id, is_urban_hourly DESC, (duration_minutes IS NULL), duration_minutes, amount, fare_product_id`))) {
    trovati.set(String(r.rete), { id: String(r.id), name: String(r.nome), price: Number(r.prezzo), durationMin: r.durata == null ? null : Number(r.durata) });
  }
  for (const r of righe(await ex.execute(sql`
    SELECT DISTINCT ON (rete) rete, titolo AS id, nome, prezzo, durata_minuti AS durata
      FROM titoli_catalogo
     WHERE tipo = 'single' AND fascia IS NULL AND rete IN (${elenco})
     ORDER BY rete, di_riferimento DESC, (durata_minuti IS NULL), durata_minuti, prezzo, titolo`))) {
    if (!trovati.has(String(r.rete))) {
      trovati.set(String(r.rete), { id: String(r.id), name: String(r.nome), price: Number(r.prezzo), durationMin: r.durata == null ? null : Number(r.durata) });
    }
  }
  return trovati;
}
