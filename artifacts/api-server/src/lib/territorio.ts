/**
 * Il territorio dell'azienda (tappa 6.1, migrazione 0035): i comuni e i
 * luoghi di riferimento, prima scritti nel codice per la provincia di Ancona.
 *
 *   territorio_comuni  codice ISTAT a 6 cifre («042002»), nome, soppresso (i
 *                      comuni fusi, che i dati del 2011 nominano ancora),
 *                      centroide, superficie e popolazione di riferimento per
 *                      l'import della popolazione;
 *   territorio_luoghi  i luoghi per uso: dove cercare i punti d'interesse
 *                      (con un raggio), i punti del meteo, i poli di lavoro
 *                      dell'analisi della rete.
 *
 * Il codice ISTAT arriva in più forme, e qui le si riconosce tutte:
 *   - ufficiale, 6 cifre con la provincia a tre: «042002»;
 *   - dalle sezioni del censimento, che cominciano con la provincia senza zeri
 *     davanti e il comune: «42002…» (sezioni 2011), e i loro primi 6
 *     caratteri «420020» che alcune pagine usano come codice.
 *
 * Chi legge passa da qui (memoria di un minuto, come l'azienda); chi salva la
 * fa rileggere. Li legge chi è entrato, li cambia l'amministratore.
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface Comune {
  codiceIstat: string;
  nome: string;
  soppresso: boolean;
  lat: number | null;
  lng: number | null;
  areaKm2: number | null;
  popolazione: number | null;
  /** la riga in census_sections che l'import della popolazione tiene per il comune */
  sezioneCensimento: string | null;
}

export const USI_LUOGO = ["punti_interesse", "meteo", "polo_lavoro"] as const;
export type UsoLuogo = (typeof USI_LUOGO)[number];

export interface Luogo { id: string; nome: string; uso: UsoLuogo; lat: number; lng: number; raggioM: number | null; ordine: number }

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const numero = (x: any) => (x == null ? null : Number(x));

const comuneDa = (r: any): Comune => ({
  codiceIstat: String(r.codice_istat), nome: String(r.nome), soppresso: !!r.soppresso,
  lat: numero(r.lat), lng: numero(r.lng), areaKm2: numero(r.area_km2), popolazione: numero(r.popolazione),
  sezioneCensimento: r.sezione_censimento ?? null,
});
const luogoDa = (r: any): Luogo => ({
  id: String(r.id), nome: String(r.nome), uso: r.uso as UsoLuogo, lat: Number(r.lat), lng: Number(r.lng),
  raggioM: numero(r.raggio_m), ordine: Number(r.ordine ?? 0),
});

/* ── Lettura, con la memoria di un minuto ─────────────────────────────────── */

const DURATA_MS = 60_000;
let inMemoria: { comuni: Comune[]; luoghi: Luogo[]; lettoIl: number } | null = null;

async function territorio() {
  if (inMemoria && Date.now() - inMemoria.lettoIl < DURATA_MS) return inMemoria;
  try {
    const comuni = righe(await db.execute(sql`
      SELECT codice_istat, nome, soppresso, lat, lng, area_km2, popolazione, sezione_censimento
        FROM territorio_comuni ORDER BY nome`)).map(comuneDa);
    const luoghi = righe(await db.execute(sql`
      SELECT id, nome, uso, lat, lng, raggio_m, ordine FROM territorio_luoghi ORDER BY ordine, nome`)).map(luogoDa);
    inMemoria = { comuni, luoghi, lettoIl: Date.now() };
    return inMemoria;
  } catch (e) {
    if (inMemoria) return inMemoria;
    throw e;
  }
}

/** Fa rileggere il territorio alla prossima richiesta (dopo un salvataggio, e nei test). */
export function dimenticaTerritorio(): void { inMemoria = null; }

export async function leggiComuni(): Promise<Comune[]> { return (await territorio()).comuni; }
export async function leggiLuoghi(uso?: UsoLuogo): Promise<Luogo[]> {
  const l = (await territorio()).luoghi;
  return uso ? l.filter((x) => x.uso === uso) : l;
}

/* ── I nomi dei comuni, da qualunque forma del codice ─────────────────────── */

/** Il prefisso delle sezioni del censimento: «042002» → «42002», «108001» → «108001». */
export const chiaveCensimento = (codice6: string) => String(Number(codice6.slice(0, 3))) + codice6.slice(3);

export interface NomiComuni { perCodice: Map<string, string>; perCensimento: Map<string, string> }

export function nomiDa(comuni: Pick<Comune, "codiceIstat" | "nome">[]): NomiComuni {
  return {
    perCodice: new Map(comuni.map((c) => [c.codiceIstat, c.nome])),
    perCensimento: new Map(comuni.map((c) => [chiaveCensimento(c.codiceIstat), c.nome])),
  };
}

/** Il nome del comune, o null se il territorio non lo ha. */
export function nomeComune(codice: string, nomi: NomiComuni): string | null {
  const c = String(codice ?? "").trim();
  if (!c) return null;
  /* ufficiale: sei cifre con la provincia a tre (comincia con 0 o con 1) */
  if (/^[01][0-9]{5}$/.test(c)) {
    const n = nomi.perCodice.get(c);
    if (n) return n;
  }
  /* dalle sezioni: la provincia senza zeri (una, due o tre cifre) e il comune a tre */
  return nomi.perCensimento.get(c.slice(0, 5)) ?? nomi.perCensimento.get(c.slice(0, 6)) ?? nomi.perCensimento.get(c.slice(0, 4)) ?? null;
}

/** Il nome, o «Comune …» come prima per un codice che il territorio non ha. */
export const nomeOppure = (codice: string, nomi: NomiComuni) => nomeComune(codice, nomi) ?? `Comune ${codice}`;

export async function nomiComuni(): Promise<NomiComuni> { return nomiDa(await leggiComuni()); }

/* ── L'amministratore ─────────────────────────────────────────────────────── */

export class RifiutoTerritorio extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const NOME = (max: number) => z.string().transform((s) => s.trim()).pipe(
  z.string().min(1, "non può essere vuoto").max(max, `al più ${max} caratteri`).regex(/^[^\u0000-\u001f\u007f]*$/, "senza caratteri di controllo"));
const facoltativo = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (v === undefined || v === null || v === "" ? null : v), t.nullable());

export const DatiComune = z.object({
  codiceIstat: z.string().trim().regex(/^[0-9]{6}$/, "codice ISTAT: sei cifre, come «042002»"),
  nome: NOME(80),
  soppresso: z.boolean().default(false),
  lat: facoltativo(z.number().min(-90).max(90)),
  lng: facoltativo(z.number().min(-180).max(180)),
  areaKm2: facoltativo(z.number().positive().max(99999)),
  popolazione: facoltativo(z.number().int().min(0).max(20_000_000)),
}).strict().refine((c) => (c.lat == null) === (c.lng == null), { message: "latitudine e longitudine vanno insieme", path: ["lat"] });

export const DatiLuogo = z.object({
  nome: NOME(120),
  uso: z.enum(USI_LUOGO),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  raggioM: facoltativo(z.number().int().min(100).max(50_000)),
  ordine: z.number().int().min(0).max(99_999).default(0),
}).strict();

/** Tutto il territorio per la pagina dell'amministratore, senza memoria. */
export async function elencoTerritorio(): Promise<{ comuni: Comune[]; luoghi: Luogo[] }> {
  dimenticaTerritorio();
  const t = await territorio();
  return { comuni: t.comuni, luoghi: t.luoghi };
}

/** Un comune, nuovo o da cambiare (per codice). La sezione del censimento resta quella che è. */
export async function salvaComune(c: z.infer<typeof DatiComune>): Promise<Comune> {
  const r = righe(await db.execute(sql`
    INSERT INTO territorio_comuni (codice_istat, nome, soppresso, lat, lng, area_km2, popolazione)
    VALUES (${c.codiceIstat}, ${c.nome}, ${c.soppresso}, ${c.lat}, ${c.lng}, ${c.areaKm2}, ${c.popolazione})
    ON CONFLICT (codice_istat) DO UPDATE SET nome = EXCLUDED.nome, soppresso = EXCLUDED.soppresso, lat = EXCLUDED.lat,
      lng = EXCLUDED.lng, area_km2 = EXCLUDED.area_km2, popolazione = EXCLUDED.popolazione, aggiornato_il = now()
    RETURNING codice_istat, nome, soppresso, lat, lng, area_km2, popolazione, sezione_censimento`));
  dimenticaTerritorio();
  return comuneDa(r[0]);
}

export async function cancellaComune(codice: string): Promise<void> {
  const r = righe(await db.execute(sql`DELETE FROM territorio_comuni WHERE codice_istat = ${codice} RETURNING codice_istat`));
  if (!r.length) throw new RifiutoTerritorio(404, "Comune non trovato");
  dimenticaTerritorio();
}

export async function creaLuogo(l: z.infer<typeof DatiLuogo>): Promise<Luogo> {
  if (l.uso !== "punti_interesse" && l.raggioM != null) throw new RifiutoTerritorio(400, "Il raggio vale solo per la ricerca dei punti d'interesse");
  const r = righe(await db.execute(sql`
    INSERT INTO territorio_luoghi (nome, uso, lat, lng, raggio_m, ordine)
    VALUES (${l.nome}, ${l.uso}, ${l.lat}, ${l.lng}, ${l.uso === "punti_interesse" ? l.raggioM ?? 3000 : null}, ${l.ordine})
    RETURNING id, nome, uso, lat, lng, raggio_m, ordine`));
  dimenticaTerritorio();
  return luogoDa(r[0]);
}

export async function modificaLuogo(id: string, l: z.infer<typeof DatiLuogo>): Promise<Luogo> {
  if (l.uso !== "punti_interesse" && l.raggioM != null) throw new RifiutoTerritorio(400, "Il raggio vale solo per la ricerca dei punti d'interesse");
  const r = righe(await db.execute(sql`
    UPDATE territorio_luoghi SET nome = ${l.nome}, uso = ${l.uso}, lat = ${l.lat}, lng = ${l.lng},
           raggio_m = ${l.uso === "punti_interesse" ? l.raggioM ?? 3000 : null}, ordine = ${l.ordine}, aggiornato_il = now()
     WHERE id = ${id}::uuid
    RETURNING id, nome, uso, lat, lng, raggio_m, ordine`));
  if (!r.length) throw new RifiutoTerritorio(404, "Luogo non trovato");
  dimenticaTerritorio();
  return luogoDa(r[0]);
}

export async function cancellaLuogo(id: string): Promise<void> {
  const r = righe(await db.execute(sql`DELETE FROM territorio_luoghi WHERE id = ${id}::uuid RETURNING id`));
  if (!r.length) throw new RifiutoTerritorio(404, "Luogo non trovato");
  dimenticaTerritorio();
}
