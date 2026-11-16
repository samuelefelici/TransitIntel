/**
 * Le giornate di esercizio: il programmato congelato (tappa 4.2; analisi,
 * «Tappe in PR piccole», PR 3; migrazione 0025).
 *
 * Il programmato di una giornata D è il feed in esercizio all'istante
 * inizioDi(D) (le 03:00, lib/service-day.ts), dallo storico delle attivazioni:
 * l'unica fonte già congelata, la stessa su cui l'azienda ha messo in
 * esercizio il programma con un atto tracciato. Non il feed acceso oggi.
 *
 *  - preparaGiornata(D) fa l'istantanea: le corse del feed che circolano in D
 *    con le loro identità (chiave del feed, codice stabile, numero di corsa),
 *    linea, percorso, orari, capolinea e km dalla geometria, calcolati qui;
 *  - finché la giornata non comincia si può rifare (lo fa il lavoratore a ogni
 *    giro); dal suo inizio si congela e non cambia più: una nuova messa in
 *    esercizio, una duplica o un feed caricato dopo non la toccano;
 *  - una giornata preparata solo dopo il suo inizio (una giornata passata
 *    aperta dopo il rilascio) nasce congelata e «ricostruita»: il programma
 *    viene comunque dallo storico all'inizio della giornata.
 *
 * Senza un programma nello storico all'inizio della giornata (prima della
 * porta unica, PR 3.2) la giornata resta vuota e lo dice: non si ripiega sul
 * feed di oggi.
 *
 * Un lucchetto per giornata (pg_advisory_xact_lock) mette in fila chi la
 * prepara: lavoratore e amministratore non si pestano.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { inizioDi } from "./service-day";
import { lunghezzaDellaGeometria } from "./km-programmati";
import { programmaAllInizio, corseDelFeedNelGiorno } from "./esercizio-corse";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const GIORNO = /^\d{4}-\d{2}-\d{2}$/;

/** Una data vera, AAAA-MM-GG, fra il 2000 e il 2099. */
export function giornoValido(g: unknown): g is string {
  if (typeof g !== "string" || !GIORNO.test(g)) return false;
  const t = Date.parse(`${g}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === g && g >= "2000-01-01" && g <= "2099-12-31";
}

export type EsitoPreparazione =
  | { stato: "congelata"; giaCongelata: true }
  | { stato: "preparata" | "congelata"; giaCongelata: false; corse: number; kmProg: number; ricostruita: boolean; avvisi: string[] };

/** La giornata è cominciata? (adesso ≥ le 03:00 del giorno, nel fuso dell'azienda) */
async function cominciata(ex: any, giorno: string): Promise<boolean> {
  return !!righe(await ex.execute(sql`SELECT now() >= ${inizioDi(giorno)} AS si`))[0]?.si;
}

/**
 * Prepara (o rifà) l'istantanea della giornata; se la giornata è già
 * cominciata, la congela. Una giornata congelata non si tocca.
 */
export async function preparaGiornata(giorno: string): Promise<EsitoPreparazione> {
  if (!giornoValido(giorno)) throw new Error("giorno non valido");
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cerbero:giornata:${giorno}`}))`);
    const prima = righe(await ex.execute(sql`
      SELECT stato, preparata_il FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
    if (prima?.stato === "congelata") return { stato: "congelata" as const, giaCongelata: true as const };

    const avvisi: string[] = [];
    const programma = await programmaAllInizio(giorno);
    if (!programma) avvisi.push("Nello storico delle attivazioni nessun programma era in esercizio all'inizio della giornata.");
    const corse = programma ? await corseDelFeedNelGiorno(programma.feedId, giorno) : [];
    if (programma && corse.length === 0) avvisi.push("Il calendario del feed in esercizio non ha corse in questa giornata.");

    /* km dalla geometria del feed, calcolati qui (la funzione della 3.5): mai dal client */
    const metri = new Map<string, number>();
    if (programma) {
      for (const x of righe(await ex.execute(sql`SELECT shape_id, geojson FROM gtfs_shapes WHERE feed_id = ${programma.feedId}::uuid`))) {
        const m = lunghezzaDellaGeometria(x.geojson);
        if (m > 0) metri.set(String(x.shape_id), m);
      }
    }
    const kmDi = (shape: string | null) => (shape && metri.has(shape) ? Math.round(metri.get(shape)!) / 1000 : null);
    const senzaKm = corse.filter((c) => kmDi(c.shapeId) == null).length;
    if (senzaKm) avvisi.push(`${senzaKm} corse senza geometria: senza km programmati.`);
    /* il totale dai metri pieni, come gli altri conteggi dei km (3.5): arrotondato una volta sola */
    const kmTotali = Math.round(corse.reduce((s, c) => s + (c.shapeId ? metri.get(c.shapeId) ?? 0 : 0), 0) / 100) / 10;
    const numeri = new Map<string, number>();
    for (const c of corse) numeri.set(c.numero, (numeri.get(c.numero) ?? 0) + 1);
    const ripetuti = [...numeri.values()].filter((n) => n > 1).length;
    if (ripetuti) avvisi.push(`${ripetuti} numeri di corsa ripetuti nella giornata: per numero quelle corse non si riconoscono.`);

    const adesso = await cominciata(ex, giorno);
    /* preparata per la prima volta dopo l'inizio: ricostruita */
    const ricostruita = adesso && !(prima && righe(await ex.execute(sql`
      SELECT ${prima.preparata_il}::timestamptz < ${inizioDi(giorno)} AS prima`))[0]?.prima);
    const stato = adesso ? "congelata" : "preparata";

    await ex.execute(sql`
      INSERT INTO esercizio_giornate (giorno, stato, ps_project_id, feed_id, programma, feed_file, ricostruita,
                                      corse, km_prog, avvisi, preparata_il, congelata_il)
      VALUES (${giorno}::date, ${stato}, ${programma?.progettoId ?? null}::uuid, ${programma?.feedId ?? null}::uuid,
              ${programma?.progetto ?? null}, ${programma?.file ?? null}, ${ricostruita},
              ${corse.length}, ${kmTotali}, ${JSON.stringify(avvisi)}::jsonb, now(), ${adesso ? sql`now()` : sql`NULL`})
      ON CONFLICT (giorno) DO UPDATE SET
        stato = EXCLUDED.stato, ps_project_id = EXCLUDED.ps_project_id, feed_id = EXCLUDED.feed_id,
        programma = EXCLUDED.programma, feed_file = EXCLUDED.feed_file, ricostruita = EXCLUDED.ricostruita,
        corse = EXCLUDED.corse, km_prog = EXCLUDED.km_prog, avvisi = EXCLUDED.avvisi,
        preparata_il = CASE WHEN EXCLUDED.stato = 'preparata' THEN now() ELSE esercizio_giornate.preparata_il END,
        congelata_il = EXCLUDED.congelata_il`);
    await ex.execute(sql`DELETE FROM esercizio_corse WHERE giorno = ${giorno}::date`);
    for (let i = 0; i < corse.length; i += 500) {
      const blocco = corse.slice(i, i + 500);
      await ex.execute(sql`
        INSERT INTO esercizio_corse (giorno, chiave, codice, numero, route_id, linea, variante, shape_id, direzione,
                                     partenza, arrivo, fermata_da, fermata_a, km_prog, a_chiamata)
        SELECT ${giorno}::date, x.chiave, x.codice, x.numero, x.route_id, x.linea, x.variante, x.shape_id, x.direzione,
               x.partenza, x.arrivo, x.fermata_da, x.fermata_a, x.km_prog, x.a_chiamata
          FROM jsonb_to_recordset(${JSON.stringify(blocco.map((c) => ({
            chiave: c.tripId, codice: c.codice, numero: c.numero, route_id: c.routeId, linea: c.linea, variante: c.variante,
            shape_id: c.shapeId, direzione: c.direzione, partenza: c.partenza, arrivo: c.arrivo, fermata_da: c.fermataDa,
            fermata_a: c.fermataA, km_prog: kmDi(c.shapeId), a_chiamata: c.aChiamata,
          })))}::jsonb) AS x(chiave text, codice text, numero text, route_id text, linea text, variante text, shape_id text,
                             direzione smallint, partenza text, arrivo text, fermata_da text, fermata_a text,
                             km_prog numeric, a_chiamata boolean)`);
    }
    return { stato, giaCongelata: false as const, corse: corse.length, kmProg: kmTotali, ricostruita, avvisi };
  });
}

/**
 * Il giro del lavoratore: prepara oggi e domani (oggi, dopo le 03:00, si
 * congela) e congela le giornate preparate già cominciate. Restituisce che
 * cosa ha fatto, per il log.
 */
export async function giroDelleGiornate(oggi: string, domani: string): Promise<Record<string, string>> {
  const fatto: Record<string, string> = {};
  const daCongelare = righe(await db.execute(sql`
    SELECT giorno::text AS g FROM esercizio_giornate
     WHERE stato = 'preparata' AND now() >= ${inizioDi(sql`giorno`)} ORDER BY giorno`)).map((x) => String(x.g));
  for (const g of [...new Set([...daCongelare, oggi, domani])].filter(giornoValido)) {
    const e = await preparaGiornata(g);
    fatto[g] = e.giaCongelata ? "già congelata" : `${e.stato}, ${e.corse} corse`;
  }
  return fatto;
}

/** Le giornate fra due date, per il calendario. */
export async function elencoGiornate(dal: string, al: string) {
  return righe(await db.execute(sql`
    SELECT giorno::text AS giorno, stato, programma, feed_file, ricostruita, corse, km_prog::float AS km_prog,
           jsonb_array_length(avvisi) AS avvisi, preparata_il, congelata_il
      FROM esercizio_giornate WHERE giorno BETWEEN ${dal}::date AND ${al}::date ORDER BY giorno DESC`)).map((x) => ({
    giorno: String(x.giorno).slice(0, 10), stato: x.stato, programma: x.programma ?? null, feed: x.feed_file ?? null,
    ricostruita: !!x.ricostruita, corse: Number(x.corse), kmProg: Number(x.km_prog), avvisi: Number(x.avvisi),
    preparataIl: new Date(x.preparata_il).toISOString(), congelataIl: x.congelata_il ? new Date(x.congelata_il).toISOString() : null,
  }));
}

/** Una giornata con le sue corse; null se non è mai stata preparata. */
export async function leggiGiornata(giorno: string) {
  const g = righe(await db.execute(sql`
    SELECT giorno::text AS giorno, stato, ps_project_id::text AS progetto_id, feed_id::text AS feed_id, programma, feed_file,
           ricostruita, corse, km_prog::float AS km_prog, avvisi, preparata_il, congelata_il,
           ${inizioDi(sql`giorno`)} AS inizio, ${inizioDi(sql`giorno + 1`)} AS fine
      FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
  if (!g) return null;
  const corse = righe(await db.execute(sql`
    SELECT chiave, codice, numero, route_id, linea, variante, direzione, partenza, arrivo, fermata_da, fermata_a,
           km_prog::float AS km_prog, a_chiamata
      FROM esercizio_corse WHERE giorno = ${giorno}::date ORDER BY partenza NULLS LAST, linea, numero`)).map((c) => ({
    chiave: c.chiave, codice: c.codice ?? null, numero: c.numero, routeId: c.route_id ?? null, linea: c.linea ?? null,
    variante: c.variante ?? null, direzione: c.direzione ?? null, partenza: c.partenza ?? null, arrivo: c.arrivo ?? null,
    fermataDa: c.fermata_da ?? null, fermataA: c.fermata_a ?? null, kmProg: c.km_prog != null ? Number(c.km_prog) : null,
    aChiamata: !!c.a_chiamata,
  }));
  return {
    giorno: String(g.giorno).slice(0, 10), stato: g.stato, progettoId: g.progetto_id ?? null, feedId: g.feed_id ?? null,
    programma: g.programma ?? null, feed: g.feed_file ?? null, ricostruita: !!g.ricostruita, corse: Number(g.corse),
    kmProg: Number(g.km_prog), avvisi: Array.isArray(g.avvisi) ? g.avvisi : [],
    preparataIl: new Date(g.preparata_il).toISOString(), congelataIl: g.congelata_il ? new Date(g.congelata_il).toISOString() : null,
    inizio: new Date(g.inizio).toISOString(), fine: new Date(g.fine).toISOString(),
    elenco: corse,
  };
}
