/**
 * Il pagamento con carta a bordo nel database (tabelle contactless,
 * contactless_tariffe e contactless_reti, migrazione 0058): leggerlo per il
 * GTFS e per Amministrazione › Azienda, e salvarlo (GET e PUT
 * /api/admin/contactless). Le regole stanno in lib/contactless.ts.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import {
  CONTACTLESS_VUOTO, contactlessPulito, erroriContactless, MASSIMO_FINESTRA, MASSIMO_PREZZO, MASSIMO_RETI, MASSIMO_VALIDITA,
  TIPI_CONTACTLESS, type Contactless, type DatiContactless, type TariffaContactless, type TipoContactless,
} from "./contactless";

export class RifiutoContactless extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

type Ex = { execute: (q: any) => Promise<any> };
const righe = (r: any): any[] => r?.rows ?? [];
const numero = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Le regole come stanno nel database; senza la riga delle impostazioni, quelle di partenza (vuote). */
export async function contactlessDalDatabase(ex: Ex = db): Promise<Contactless> {
  const [impostazioni, tariffe, reti] = await Promise.all([
    ex.execute(sql`SELECT massimale_unico, finestra_ore, supporto FROM contactless WHERE chiave = 'unica'`),
    ex.execute(sql`SELECT tipo, primo, secondo, terzo, validita_minuti, massimale FROM contactless_tariffe`),
    ex.execute(sql`SELECT rete FROM contactless_reti ORDER BY rete`),
  ]);
  const i = righe(impostazioni)[0];
  return {
    massimaleUnico: i ? numero(i.massimale_unico) : CONTACTLESS_VUOTO.massimaleUnico,
    finestraOre: i ? Number(i.finestra_ore) : CONTACTLESS_VUOTO.finestraOre,
    supporto: i?.supporto ? String(i.supporto) : null,
    tariffe: righe(tariffe)
      .map((t): TariffaContactless => ({
        tipo: t.tipo as TipoContactless, primo: Number(t.primo), secondo: Number(t.secondo), terzo: Number(t.terzo),
        validitaMinuti: Number(t.validita_minuti), massimale: Number(t.massimale),
      }))
      .sort((a, b) => TIPI_CONTACTLESS.indexOf(a.tipo) - TIPI_CONTACTLESS.indexOf(b.tipo)),
    reti: righe(reti).map((r) => String(r.rete)),
  };
}

export interface ElencoContactless {
  contactless: Contactless;
  /** le reti dell'azienda, per scegliere dove vale */
  retiDisponibili: { rete: string; nome: string; tipo: TipoContactless }[];
  /** i supporti dell'azienda, per scegliere con che cosa si paga */
  supportiDisponibili: { supporto: string; nome: string; tipo: number }[];
  limiti: { prezzo: number; validitaMinuti: number; finestraOre: number; reti: number };
}

export async function elencoContactless(ex: Ex = db): Promise<ElencoContactless> {
  const [contactless, reti, supporti] = await Promise.all([
    contactlessDalDatabase(ex),
    ex.execute(sql`SELECT rete, nome, tipo FROM reti ORDER BY ordine, rete`),
    ex.execute(sql`SELECT supporto, nome, tipo FROM supporti_catalogo ORDER BY ordine, supporto`),
  ]);
  return {
    contactless,
    retiDisponibili: righe(reti).map((r) => ({ rete: String(r.rete), nome: String(r.nome), tipo: r.tipo as TipoContactless })),
    supportiDisponibili: righe(supporti).map((s) => ({ supporto: String(s.supporto), nome: String(s.nome), tipo: Number(s.tipo) })),
    limiti: { prezzo: MASSIMO_PREZZO, validitaMinuti: MASSIMO_VALIDITA, finestraOre: MASSIMO_FINESTRA, reti: MASSIMO_RETI },
  };
}

/**
 * Salva tutte le regole insieme. Tocca solo le righe che cambiano: nel
 * registro resta quello che è cambiato davvero. Le reti e il supporto devono
 * esserci fra quelli dell'azienda; una rete vuole la tariffa del suo tipo.
 * Senza reti il pagamento con carta non vale da nessuna parte.
 */
export async function salvaContactless(d: z.infer<typeof DatiContactless>): Promise<Contactless> {
  const c = contactlessPulito(d);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:contactless'))`);
    const reti = new Map(righe(await tx.execute(sql`
      SELECT rete, nome, tipo FROM reti WHERE rete IN (SELECT jsonb_array_elements_text(${JSON.stringify(c.reti)}::jsonb))`))
      .map((r) => [String(r.rete), { tipo: r.tipo as TipoContactless, nome: String(r.nome) }]));
    const errori = erroriContactless(c, (r) => reti.get(r) ?? null);
    if (errori.length) throw new RifiutoContactless(400, errori[0]!);
    if (c.supporto) {
      const s = righe(await tx.execute(sql`SELECT 1 FROM supporti_catalogo WHERE supporto = ${c.supporto}`));
      if (!s.length) throw new RifiutoContactless(400, `Il supporto «${c.supporto}» non c'è più: ricarica la pagina`);
    }
    await tx.execute(sql`
      INSERT INTO contactless (chiave, massimale_unico, finestra_ore, supporto)
      VALUES ('unica', ${c.massimaleUnico}, ${c.finestraOre}, ${c.supporto})
      ON CONFLICT (chiave) DO UPDATE SET massimale_unico = excluded.massimale_unico, finestra_ore = excluded.finestra_ore,
             supporto = excluded.supporto, aggiornato_il = now()
       WHERE (contactless.massimale_unico, contactless.finestra_ore, contactless.supporto)
             IS DISTINCT FROM (excluded.massimale_unico, excluded.finestra_ore, excluded.supporto)`);
    await tx.execute(sql`
      DELETE FROM contactless_tariffe WHERE tipo NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(c.tariffe.map((t) => t.tipo))}::jsonb))`);
    for (const t of c.tariffe) {
      await tx.execute(sql`
        INSERT INTO contactless_tariffe (tipo, primo, secondo, terzo, validita_minuti, massimale)
        VALUES (${t.tipo}, ${t.primo}, ${t.secondo}, ${t.terzo}, ${t.validitaMinuti}, ${t.massimale})
        ON CONFLICT (tipo) DO UPDATE SET primo = excluded.primo, secondo = excluded.secondo, terzo = excluded.terzo,
               validita_minuti = excluded.validita_minuti, massimale = excluded.massimale
         WHERE (contactless_tariffe.primo, contactless_tariffe.secondo, contactless_tariffe.terzo, contactless_tariffe.validita_minuti, contactless_tariffe.massimale)
               IS DISTINCT FROM (excluded.primo, excluded.secondo, excluded.terzo, excluded.validita_minuti, excluded.massimale)`);
    }
    await tx.execute(sql`
      DELETE FROM contactless_reti WHERE rete NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(c.reti)}::jsonb))`);
    await tx.execute(sql`
      INSERT INTO contactless_reti (rete) SELECT jsonb_array_elements_text(${JSON.stringify(c.reti)}::jsonb) ON CONFLICT (rete) DO NOTHING`);
  });
  return c;
}
