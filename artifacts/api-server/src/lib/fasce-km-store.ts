/**
 * Le fasce chilometriche nel database (tabella `fasce_km`, migrazione 0041):
 * leggerle, tenerle in vigore per le rotte delle tariffe, e salvarle
 * (GET e PUT /api/admin/fasce-km). Le regole stanno in lib/fasce-km.ts.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { erroriFasce, impostaFasce, MASSIMO_FASCE, MASSIMO_KM, MASSIMO_PREZZO, type FasciaKm } from "./fasce-km";

export class RifiutoFasce extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

type Ex = Pick<typeof db, "execute">;

/** Per quanto valgono le fasce in memoria prima di rileggerle. */
const DURATA_MS = 60_000;
let letteIl = 0;

/** Le fasce come stanno nel database, in ordine. */
export async function fasceDalDatabase(ex: Ex = db): Promise<FasciaKm[]> {
  const r = await ex.execute<any>(sql`SELECT fascia, km_da, km_a, prezzo FROM fasce_km ORDER BY fascia`);
  return r.rows.map((x) => ({ fascia: Number(x.fascia), kmFrom: Number(x.km_da), kmTo: Number(x.km_a), price: Number(x.prezzo) }));
}

/**
 * Le fasce lette almeno una volta nell'ultimo minuto, e in vigore in questo
 * processo. La chiama chi apre una rotta delle tariffe. Se il database non
 * risponde restano quelle di prima.
 */
export async function fasceLette(): Promise<void> {
  if (Date.now() - letteIl < DURATA_MS) return;
  try {
    impostaFasce(await fasceDalDatabase());
    letteIl = Date.now();
  } catch { /* restano le fasce di prima; si riprova alla prossima richiesta */ }
}

/** Fa rileggere le fasce alla prossima richiesta (nei test). */
export function dimenticaFasce(): void { letteIl = 0; }

/** Mette in vigore queste fasce come appena lette: chi salva, e nei test chi prova un'azienda con le sue fasce. */
export function mettiInVigore(fasce: readonly FasciaKm[]): void {
  impostaFasce(fasce);
  letteIl = Date.now();
}

/* i chilometri con al più un decimale, i prezzi con al più due: come nella tabella */
const decimali = (n: number, cifre: number) => Math.abs(n * 10 ** cifre - Math.round(n * 10 ** cifre)) < 1e-6;
const KM = z.number().min(0, "i chilometri sono numeri da 0 in su").max(MASSIMO_KM, `al più ${MASSIMO_KM} km`)
  .refine((n) => decimali(n, 1), "i chilometri hanno al più un decimale");
const PREZZO = z.number().positive("il prezzo è maggiore di zero").max(MASSIMO_PREZZO, `il prezzo è al più ${MASSIMO_PREZZO} €`)
  .refine((n) => decimali(n, 2), "il prezzo ha al più due decimali");

export const Fasce = z.object({
  fasce: z.array(z.object({
    fascia: z.number().int().min(1).max(MASSIMO_FASCE),
    kmFrom: KM,
    kmTo: KM,
    price: PREZZO,
  }).strict()).max(MASSIMO_FASCE, `al più ${MASSIMO_FASCE} fasce`),
}).strict();

export interface ElencoFasce { fasce: FasciaKm[]; massimoFasce: number }

export async function elencoFasce(): Promise<ElencoFasce> {
  return { fasce: await fasceDalDatabase(), massimoFasce: MASSIMO_FASCE };
}

/**
 * Salva l'elenco intero delle fasce. Tocca solo le righe che cambiano: nel
 * registro resta quello che è cambiato davvero. Un elenco vuoto toglie tutte
 * le fasce (un'azienda senza extraurbano).
 */
export async function salvaFasce(d: z.infer<typeof Fasce>): Promise<FasciaKm[]> {
  const fasce: FasciaKm[] = d.fasce.map((f) => ({ fascia: f.fascia, kmFrom: Math.round(f.kmFrom * 10) / 10, kmTo: Math.round(f.kmTo * 10) / 10, price: Math.round(f.price * 100) / 100 }));
  const errori = erroriFasce(fasce);
  if (errori.length) throw new RifiutoFasce(400, errori[0]!);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:fasce-km'))`);
    await tx.execute(sql`DELETE FROM fasce_km WHERE fascia > ${fasce.length}`);
    for (const f of fasce) {
      await tx.execute(sql`
        INSERT INTO fasce_km (fascia, km_da, km_a, prezzo) VALUES (${f.fascia}, ${f.kmFrom}, ${f.kmTo}, ${f.price})
        ON CONFLICT (fascia) DO UPDATE SET km_da = excluded.km_da, km_a = excluded.km_a, prezzo = excluded.prezzo
         WHERE (fasce_km.km_da, fasce_km.km_a, fasce_km.prezzo) IS DISTINCT FROM (excluded.km_da, excluded.km_a, excluded.prezzo)`);
    }
  });
  /* in vigore subito in questo processo; gli altri le rileggono entro un minuto */
  mettiInVigore(fasce);
  return fasce;
}
