/**
 * Il giornale di esercizio e la conferma degli esiti (tappa 4.5; analisi,
 * «Il giornale di esercizio» e «La conferma», PR 6; migrazione 0028).
 *
 * La proposta dall'AVM (4.4) suggerisce; qui decide una persona. Ogni
 * decisione è un EVENTO del giornale, solo in aggiunta: un evento sbagliato
 * si annulla con un altro evento. Lo stato di ogni corsa (esito, km
 * effettivi, causale, vettura, nota, chi e quando) si aggiorna nella stessa
 * transazione dell'evento, che tiene com'erano le corse prima: così
 * l'annullamento le rimette a posto.
 *
 * Gli eventi:
 *   esito         una o più corse: effettuata, parziale, soppressa, da
 *                 verificare (soppressa e parziale con la causale);
 *   conferma      la conferma di massa delle proposte (effettuata dall'AVM,
 *                 per continuità) delle corse non ancora decise;
 *   aggiunta      una corsa che il programmato non ha (bis, recupero,
 *                 sostitutiva, fuori programma), anche da una candidata
 *                 dell'AVM;
 *   annullamento  di un evento, se nessun evento dopo ha toccato le stesse
 *                 corse;
 *   nota          sulla giornata o su delle corse;
 *   cancellazione_avm  l'AVM annulla una corsa: lo registra il sistema, ed
 *                 è un indizio per la proposta, non un esito.
 *
 * Scritture concorrenti: chi scrive dice quale versione della giornata ha
 * visto; se nel frattempo è cambiata, 409. Lo stesso lucchetto per giornata
 * di chi la prepara e di chi fa la proposta. Solo sulle giornate congelate.
 *
 * Il codice non aggiorna né cancella mai una riga di esercizio_eventi.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { giornataOggi } from "./service-day";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const MAX_CORSE = 5000;
/** Un elenco di testi come text[]: drizzle espande gli array di JS in una lista di parametri, quindi passa per JSON. */
const testi = (xs: string[]) => sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))::text[]`;

export class RifiutoGiornale extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

/* ── Le richieste ────────────────────────────────────────────────────────── */

const ESITI = ["effettuata", "parziale", "soppressa", "da_verificare"] as const;
const FONTI = ["centrale", "deposito", "movimento"] as const;
const TIPI_AGGIUNTA = ["bis", "recupero", "sostitutiva", "fuori_programma"] as const;
const testo = (max: number) => z.string().trim().min(1).max(max);
const ORA = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, "orario HH:MM");
const comune = { versione: z.number().int().min(0), fonte: z.enum(FONTI).default("movimento") };
const chiavi = z.array(testo(200)).min(1).max(MAX_CORSE);

export const RICHIESTA = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("esito"), ...comune, chiavi, esito: z.enum(ESITI),
    causale: testo(30).optional(), kmEff: z.number().min(0).max(10000).nullable().optional(),
    vettura: testo(40).nullable().optional(), nota: testo(500).nullable().optional(),
  }).strict(),
  z.object({
    /* non_rilevata: la presunzione di effettuazione (4.6), esito «presunta» */
    tipo: z.literal("conferma"), ...comune, proposte: z.array(z.enum(["effettuata_avm", "continuita", "non_rilevata"])).min(1).max(3),
  }).strict(),
  z.object({
    tipo: z.literal("aggiunta"), ...comune, tipoAggiunta: z.enum(TIPI_AGGIUNTA), linea: testo(40), partenza: ORA,
    arrivo: ORA.optional(), numero: testo(40).optional(), vettura: testo(40).optional(),
    kmEff: z.number().min(0).max(10000).optional(), causale: testo(30).optional(), nota: testo(500).optional(),
    candidata: testo(200).optional(),
  }).strict(),
  z.object({ tipo: z.literal("annullamento"), ...comune, evento: z.number().int().positive(), nota: testo(500).optional() }).strict(),
  z.object({ tipo: z.literal("nota"), ...comune, chiavi: z.array(testo(200)).max(MAX_CORSE).default([]), nota: testo(500) }).strict(),
]);
export type Richiesta = z.infer<typeof RICHIESTA>;

/** La richiesta, o il primo errore in parole. */
export function leggiRichiesta(corpo: unknown): { richiesta: Richiesta } | { errore: string } {
  const r = RICHIESTA.safeParse(corpo);
  if (r.success) {
    const x = r.data;
    if (x.tipo === "esito" && (x.esito === "soppressa" || x.esito === "parziale") && !x.causale) {
      return { errore: `Una corsa ${x.esito} vuole la causale` };
    }
    return { richiesta: x };
  }
  const p = r.error.issues[0];
  return { errore: `${p?.path.join(".") || "richiesta"}: ${p?.message ?? "non valida"}` };
}

/* ── Lo stato delle corse, prima e dopo ──────────────────────────────────── */

interface StatoCorsa {
  chiave: string; esito: string | null; km_eff: number | null; causale: string | null; vettura: string | null;
  nota: string | null; confermata_da: string | null; confermata_il: string | null;
}
const COLONNE_STATO = sql`chiave, esito, km_eff::float AS km_eff, causale, vettura, nota, confermata_da::text AS confermata_da, confermata_il`;

async function statoDi(ex: any, giorno: string, chiaviCorse: string[]): Promise<StatoCorsa[]> {
  return righe(await ex.execute(sql`
    SELECT ${COLONNE_STATO} FROM esercizio_corse
     WHERE giorno = ${giorno}::date AND chiave IN (SELECT jsonb_array_elements_text(${JSON.stringify(chiaviCorse)}::jsonb))`));
}

/** Rimette le corse com'erano (annullamento), dallo stato salvato nell'evento. */
async function ripristina(ex: any, giorno: string, prima: StatoCorsa[]) {
  for (let i = 0; i < prima.length; i += 500) {
    await ex.execute(sql`
      UPDATE esercizio_corse c SET esito = x.esito, km_eff = x.km_eff, causale = x.causale, vettura = x.vettura, nota = x.nota,
             confermata_da = x.confermata_da, confermata_il = x.confermata_il
        FROM jsonb_to_recordset(${JSON.stringify(prima.slice(i, i + 500))}::jsonb)
             AS x(chiave text, esito text, km_eff numeric, causale text, vettura text, nota text, confermata_da uuid, confermata_il timestamptz)
       WHERE c.giorno = ${giorno}::date AND c.chiave = x.chiave`);
  }
}

/* ── La scrittura ────────────────────────────────────────────────────────── */

export interface Autore { id: string | null }

/**
 * Registra un evento e aggiorna le corse, nella stessa transazione.
 * Restituisce l'evento, la versione nuova della giornata e quante corse ha toccato.
 */
export async function registraEvento(giorno: string, r: Richiesta, autore: Autore) {
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cerbero:giornata:${giorno}`}))`);
    const g = righe(await ex.execute(sql`SELECT stato, versione FROM esercizio_giornate WHERE giorno = ${giorno}::date FOR UPDATE`))[0];
    if (!g) throw new RifiutoGiornale(404, "Giornata non ancora preparata");
    if (g.stato === "chiusa") throw new RifiutoGiornale(409, "Giornata chiusa: non si scrive più. La riapre l'amministratore, con un motivo");
    if (g.stato !== "congelata") throw new RifiutoGiornale(409, "Il giornale si scrive sulle giornate cominciate (congelate)");
    if (Number(g.versione) !== r.versione) {
      throw new RifiutoGiornale(409, "Nel frattempo la giornata è cambiata: ricaricala e riprova");
    }
    const causale = "causale" in r ? r.causale ?? null : null;
    if (causale) {
      const c = righe(await ex.execute(sql`SELECT attiva FROM esercizio_causali WHERE codice = ${causale}`))[0];
      if (!c) throw new RifiutoGiornale(400, "Causale sconosciuta");
      if (!c.attiva) throw new RifiutoGiornale(400, "Causale non più attiva");
    }

    let toccate: string[] = [];
    let dati: Record<string, unknown> = {};
    let annulla: number | null = null;
    let cambiaStato = true;

    if (r.tipo === "esito") {
      toccate = [...new Set(r.chiavi)];
      const prima = await statoDi(ex, giorno, toccate);
      if (prima.length !== toccate.length) throw new RifiutoGiornale(400, `${toccate.length - prima.length} corse non sono di questa giornata`);
      /* km effettivi: effettuata = programmati, soppressa = 0, parziale = quelli detti (o da calcolare) */
      await ex.execute(sql`
        UPDATE esercizio_corse SET esito = ${r.esito},
               km_eff = CASE ${r.esito} WHEN 'effettuata' THEN km_prog WHEN 'soppressa' THEN 0
                                        WHEN 'parziale' THEN ${r.kmEff ?? null}::numeric ELSE NULL END,
               causale = ${causale},
               vettura = COALESCE(${r.vettura ?? null}, vettura),
               nota = COALESCE(${r.nota ?? null}, nota),
               confermata_da = ${autore.id}::uuid, confermata_il = now()
         WHERE giorno = ${giorno}::date AND chiave IN (SELECT jsonb_array_elements_text(${JSON.stringify(toccate)}::jsonb))`);
      dati = { esito: r.esito, kmEff: r.kmEff ?? null, vettura: r.vettura ?? null, nota: r.nota ?? null, prima };
    } else if (r.tipo === "conferma") {
      /* le non rilevate comprendono le corse senza proposta (giornate senza AVM): la presunzione vale per tutte */
      const presunzione = r.proposte.includes("non_rilevata");
      toccate = righe(await ex.execute(sql`
        SELECT chiave FROM esercizio_corse
         WHERE giorno = ${giorno}::date AND esito IS NULL
           AND (proposta IN (SELECT jsonb_array_elements_text(${JSON.stringify(r.proposte)}::jsonb))
                OR (${presunzione} AND proposta IS NULL))`)).map((x) => String(x.chiave));
      if (!toccate.length) throw new RifiutoGiornale(400, "Nessuna corsa da confermare con queste proposte");
      const prima = await statoDi(ex, giorno, toccate);
      await ex.execute(sql`
        UPDATE esercizio_corse SET esito = CASE WHEN proposta = 'non_rilevata' OR proposta IS NULL THEN 'presunta' ELSE 'effettuata' END,
               km_eff = km_prog, causale = NULL,
               vettura = COALESCE(vettura, CASE WHEN jsonb_array_length(COALESCE(prove->'vetture', '[]'::jsonb)) = 1 THEN prove->'vetture'->>0 END),
               confermata_da = ${autore.id}::uuid, confermata_il = now()
         WHERE giorno = ${giorno}::date AND chiave IN (SELECT jsonb_array_elements_text(${JSON.stringify(toccate)}::jsonb))`);
      dati = { proposte: r.proposte, prima };
    } else if (r.tipo === "aggiunta") {
      let { linea, partenza, numero, vettura } = r;
      if (r.candidata) {
        const c = righe(await ex.execute(sql`
          SELECT linea, partenza, numero, vetture FROM esercizio_aggiunte_proposte WHERE giorno = ${giorno}::date AND chiave_avm = ${r.candidata}`))[0];
        if (!c) throw new RifiutoGiornale(400, "Candidata aggiunta sconosciuta");
        const gia = righe(await ex.execute(sql`
          SELECT 1 FROM esercizio_eventi e
           WHERE e.giorno = ${giorno}::date AND e.tipo = 'aggiunta' AND e.dati->>'candidata' = ${r.candidata}
             AND NOT EXISTS (SELECT 1 FROM esercizio_eventi a WHERE a.annulla = e.id)`));
        if (gia.length) throw new RifiutoGiornale(409, "Questa candidata è già stata aggiunta");
        numero ??= c.numero ?? undefined;
        vettura ??= Array.isArray(c.vetture) && c.vetture.length === 1 ? c.vetture[0] : undefined;
      }
      const chiave = `agg:${randomUUID()}`;
      const hhmmss = (t: string) => (t.length <= 5 ? `${t.padStart(5, "0")}:00` : t.padStart(8, "0"));
      await ex.execute(sql`
        INSERT INTO esercizio_corse (giorno, chiave, numero, linea, partenza, arrivo, origine, tipo_aggiunta,
                                     esito, km_eff, causale, vettura, nota, confermata_da, confermata_il)
        VALUES (${giorno}::date, ${chiave}, ${numero ?? "agg"}, ${linea}, ${hhmmss(partenza)}, ${r.arrivo ? hhmmss(r.arrivo) : null},
                'aggiunta', ${r.tipoAggiunta}, 'effettuata', ${r.kmEff ?? null}::numeric, ${causale}, ${vettura ?? null},
                ${r.nota ?? null}, ${autore.id}::uuid, now())`);
      toccate = [chiave];
      dati = { tipoAggiunta: r.tipoAggiunta, linea, partenza, numero: numero ?? null, vettura: vettura ?? null, kmEff: r.kmEff ?? null, candidata: r.candidata ?? null };
    } else if (r.tipo === "annullamento") {
      const e = righe(await ex.execute(sql`
        SELECT id, tipo, chiavi, dati, (SELECT a.id FROM esercizio_eventi a WHERE a.annulla = e.id) AS annullato
          FROM esercizio_eventi e WHERE e.id = ${r.evento} AND e.giorno = ${giorno}::date`))[0];
      if (!e) throw new RifiutoGiornale(404, "Evento non trovato in questa giornata");
      if (e.annullato) throw new RifiutoGiornale(409, "Evento già annullato");
      if (!["esito", "conferma", "aggiunta", "nota"].includes(e.tipo)) throw new RifiutoGiornale(400, "Questo evento non si annulla");
      const chiaviEvento: string[] = Array.isArray(e.chiavi) ? e.chiavi : [];
      if (chiaviEvento.length && e.tipo !== "nota") {
        const dopo = righe(await ex.execute(sql`
          SELECT d.id FROM esercizio_eventi d
           WHERE d.giorno = ${giorno}::date AND d.id > ${e.id} AND d.tipo IN ('esito', 'conferma', 'aggiunta')
             AND d.chiavi && ${testi(chiaviEvento)}
             AND NOT EXISTS (SELECT 1 FROM esercizio_eventi a WHERE a.annulla = d.id)
           ORDER BY d.id DESC LIMIT 1`))[0];
        if (dopo) throw new RifiutoGiornale(409, `Dopo questo evento le stesse corse sono state cambiate (evento ${dopo.id}): annulla prima quello`);
      }
      if (e.tipo === "esito" || e.tipo === "conferma") await ripristina(ex, giorno, Array.isArray(e.dati?.prima) ? e.dati.prima : []);
      if (e.tipo === "aggiunta") {
        await ex.execute(sql`DELETE FROM esercizio_corse WHERE giorno = ${giorno}::date AND origine = 'aggiunta' AND chiave = ANY(${testi(chiaviEvento)})`);
      }
      cambiaStato = e.tipo !== "nota";
      toccate = chiaviEvento;
      annulla = Number(e.id);
      dati = { tipoAnnullato: e.tipo, nota: r.nota ?? null };
    } else {
      toccate = [...new Set(r.chiavi)];
      if (toccate.length) {
        const n = (await statoDi(ex, giorno, toccate)).length;
        if (n !== toccate.length) throw new RifiutoGiornale(400, `${toccate.length - n} corse non sono di questa giornata`);
      }
      dati = { nota: r.nota };
      cambiaStato = false;
    }

    const evento = righe(await ex.execute(sql`
      INSERT INTO esercizio_eventi (giorno, tipo, chiavi, dati, causale, fonte, autore, annulla)
      VALUES (${giorno}::date, ${r.tipo}, ${testi(toccate)}, ${JSON.stringify(dati)}::jsonb, ${causale}, ${r.fonte},
              ${autore.id}::uuid, ${annulla}::bigint)
      RETURNING id, ts`))[0];
    const versione = cambiaStato
      ? Number(righe(await ex.execute(sql`UPDATE esercizio_giornate SET versione = versione + 1 WHERE giorno = ${giorno}::date RETURNING versione`))[0].versione)
      : Number(g.versione);
    return { evento: Number(evento.id), ts: new Date(evento.ts).toISOString(), versione, corse: toccate.length };
  });
}

/**
 * Una corsa annullata dall'AVM (SIRI, VehicleActivityCancellation): un evento
 * del sistema, una volta per corsa e giornata. Non cambia l'esito: è un
 * indizio per la proposta. Non ferma mai l'ingestione.
 */
export async function registraCancellazioneAvm(c: { tripId: string; journeyRef: string | null; vehicleRef: string | null }, adesso: Date = new Date()): Promise<boolean> {
  try {
    const giorno = giornataOggi(adesso);
    const r = await db.execute(sql`
      INSERT INTO esercizio_eventi (giorno, tipo, chiavi, dati, fonte)
      SELECT g.giorno, 'cancellazione_avm',
             COALESCE((SELECT ARRAY[ec.chiave] FROM esercizio_corse ec
                        WHERE ec.giorno = g.giorno AND (ec.chiave = ${c.tripId} OR ec.codice = ${c.tripId})
                        ORDER BY (ec.chiave = ${c.tripId}) DESC LIMIT 1), '{}'::text[]),
             ${JSON.stringify({ trip: c.tripId, journeyRef: c.journeyRef, vettura: c.vehicleRef })}::jsonb, 'avm'
        FROM esercizio_giornate g
       WHERE g.giorno = ${giorno}::date AND g.stato = 'congelata'
         AND NOT EXISTS (SELECT 1 FROM esercizio_eventi e
                          WHERE e.giorno = g.giorno AND e.tipo = 'cancellazione_avm' AND e.dati->>'trip' = ${c.tripId})`);
    return ((r as any).rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

/* ── La lettura ──────────────────────────────────────────────────────────── */

/** Il giornale di una giornata, dal più recente; senza lo stato «prima», che pesa. */
export async function leggiGiornale(giorno: string, limite = 300) {
  return righe(await db.execute(sql`
    SELECT e.id, e.ts, e.tipo, cardinality(e.chiavi) AS corse, e.chiavi[1:5] AS esempi, e.dati - 'prima' AS dati, e.causale, e.fonte,
           COALESCE(u.full_name, u.email) AS autore, e.annulla,
           (SELECT a.id FROM esercizio_eventi a WHERE a.annulla = e.id) AS annullato_da
      FROM esercizio_eventi e LEFT JOIN users u ON u.id = e.autore
     WHERE e.giorno = ${giorno}::date ORDER BY e.id DESC LIMIT ${limite}`)).map((e) => ({
    id: Number(e.id), ts: new Date(e.ts).toISOString(), tipo: e.tipo, corse: Number(e.corse), esempi: e.esempi ?? [],
    dati: e.dati ?? {}, causale: e.causale ?? null, fonte: e.fonte, autore: e.autore ?? null,
    annulla: e.annulla != null ? Number(e.annulla) : null, annullatoDa: e.annullato_da != null ? Number(e.annullato_da) : null,
  }));
}

/** Il catalogo delle causali; `tutte` comprende quelle non più attive. */
export async function elencoCausali(tutte = false) {
  return righe(await db.execute(sql`
    SELECT codice, descrizione, gruppo, imputabile_azienda, codice_ente, attiva, ordine
      FROM esercizio_causali ${tutte ? sql`` : sql`WHERE attiva`} ORDER BY ordine, codice`)).map((c) => ({
    codice: c.codice, descrizione: c.descrizione, gruppo: c.gruppo, imputabileAzienda: !!c.imputabile_azienda,
    codiceEnte: c.codice_ente ?? null, attiva: !!c.attiva, ordine: Number(c.ordine),
  }));
}

export const CAUSALE = z.object({
  descrizione: testo(120), gruppo: z.enum(["mezzo", "personale", "esterna", "servizio", "altro"]),
  imputabileAzienda: z.boolean(), codiceEnte: z.string().trim().max(30).nullable().optional(),
  attiva: z.boolean().default(true), ordine: z.number().int().min(0).max(9999).default(0),
}).strict();

/** Aggiunge o cambia una causale (amministratore). Il codice non cambia: le corse lo citano. */
export async function salvaCausale(codice: string, corpo: unknown) {
  if (!/^[A-Z0-9_]{1,30}$/.test(codice)) throw new RifiutoGiornale(400, "Codice: lettere maiuscole, cifre e _, al più 30");
  const r = CAUSALE.safeParse(corpo);
  if (!r.success) throw new RifiutoGiornale(400, `${r.error.issues[0]?.path.join(".") || "causale"}: ${r.error.issues[0]?.message}`);
  const c = r.data;
  await db.execute(sql`
    INSERT INTO esercizio_causali (codice, descrizione, gruppo, imputabile_azienda, codice_ente, attiva, ordine)
    VALUES (${codice}, ${c.descrizione}, ${c.gruppo}, ${c.imputabileAzienda}, ${c.codiceEnte || null}, ${c.attiva}, ${c.ordine})
    ON CONFLICT (codice) DO UPDATE SET descrizione = EXCLUDED.descrizione, gruppo = EXCLUDED.gruppo,
      imputabile_azienda = EXCLUDED.imputabile_azienda, codice_ente = EXCLUDED.codice_ente, attiva = EXCLUDED.attiva, ordine = EXCLUDED.ordine`);
  return (await elencoCausali(true)).find((x) => x.codice === codice);
}
