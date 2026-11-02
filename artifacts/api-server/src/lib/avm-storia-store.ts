/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ANDAMENTO DELL'AVM — le letture e le richieste a Mizar
 * ───────────────────────────────────────────────────────────────────────────
 * Il diario si legge AGGREGATO: per l'andamento di un anno non servono le
 * righe intere (circa 135.000), ma per ogni vettura le giornate in cui il
 * flusso l'ha elencata e, per ciascuna, se si è localizzata e se ha parlato
 * col centro. Una riga per vettura, un carattere per giornata.
 *
 * Le richieste a Mizar stanno in caronte.avm_richieste_mizar (migrazione
 * 0005): la tabella c'è dalle migrazioni, qui non si crea niente. Di chi
 * segna o chiude una richiesta si scrive solo l'id; il nome si legge al
 * momento da users, per la pagina.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { PresenzaVettura, RichiestaMizar, TipoRichiesta } from "./avm-storia.js";

let ultimoErrore: string | null = null;
export function erroreStoria(): string | null { return ultimoErrore; }

function errore(e: any): string {
  return e?.cause?.message ?? e?.message ?? String(e);
}

/** Vetture lette al massimo: il flusso ne elenca circa 370, il parco qualche decina in più. */
const VETTURE_MASSIME = 5_000;

/** ARRAY[...]::text[] con i valori come parametri, mai interpolati. */
function arrayTesto(valori: string[]) {
  if (!valori.length) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(valori.map(x => sql`${x}`), sql`, `)}]::text[]`;
}

export interface DiarioAggregato {
  campioni: Map<string, number>;
  vetture: PresenzaVettura[];
  errore: string | null;
}

/** Il diario dal giorno `da` al giorno `a` (compresi), aggregato per vettura. */
export async function leggiStoriaDiario(da: string, a: string): Promise<DiarioAggregato> {
  try {
    const giorni = await db.execute<any>(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS giorno, max(letture) AS campioni
        FROM caronte.avm_diario
       WHERE day >= ${da}::date AND day <= ${a}::date
       GROUP BY day
       ORDER BY day`);
    const vetture = await db.execute<any>(sql`
      SELECT vehicle_ref,
             array_agg(to_char(day, 'YYYY-MM-DD') ORDER BY day) AS giorni,
             string_agg(((CASE WHEN letture_posizione > 0 THEN 1 ELSE 0 END)
                       + (CASE WHEN letture_fresche   > 0 THEN 2 ELSE 0 END))::text, '' ORDER BY day) AS esiti
        FROM caronte.avm_diario
       WHERE day >= ${da}::date AND day <= ${a}::date
       GROUP BY vehicle_ref
       ORDER BY vehicle_ref
       LIMIT ${VETTURE_MASSIME}`);
    ultimoErrore = null;
    return {
      campioni: new Map(((giorni as any).rows ?? []).map((r: any) => [String(r.giorno), Number(r.campioni ?? 0)])),
      vetture: ((vetture as any).rows ?? []).map((r: any): PresenzaVettura => ({
        vehicleRef: String(r.vehicle_ref),
        giorni: Array.isArray(r.giorni) ? r.giorni.map(String) : [],
        esiti: String(r.esiti ?? ""),
      })),
      errore: null,
    };
  } catch (e) {
    ultimoErrore = errore(e);
    return { campioni: new Map(), vetture: [], errore: ultimoErrore };
  }
}

function giorno(x: unknown): string | null {
  if (x == null) return null;
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  return String(x).slice(0, 10);
}

/**
 * Le richieste aperte, più quelle chiuse dal giorno `chiuseDal`. I nomi di
 * chi le ha segnate o chiuse vengono da users al momento (un utente
 * cancellato lascia il nome vuoto).
 */
export async function leggiRichieste(chiuseDal: string): Promise<{ richieste: RichiestaMizar[]; errore: string | null }> {
  try {
    const r = await db.execute<any>(sql`
      SELECT r.id, r.vehicle_ref, r.tipo,
             to_char(r.richiesta_il, 'YYYY-MM-DD') AS richiesta_il,
             r.nota, to_char(r.creata_il AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS creata_il, r.esito,
             to_char(r.chiusa_il, 'YYYY-MM-DD') AS chiusa_il,
             r.creata_da IS NOT NULL AS ha_creatore, r.chiusa_da IS NOT NULL AS ha_chiusore,
             c.full_name AS creata_da_nome, c.email AS creata_da_email,
             x.full_name AS chiusa_da_nome, x.email AS chiusa_da_email
        FROM caronte.avm_richieste_mizar r
        LEFT JOIN users c ON c.id = r.creata_da
        LEFT JOIN users x ON x.id = r.chiusa_da
       WHERE r.esito IS NULL OR r.chiusa_il >= ${chiuseDal}::date
       ORDER BY r.richiesta_il DESC, r.creata_il DESC
       LIMIT 2000`);
    const richieste = ((r as any).rows ?? []).map((x: any): RichiestaMizar => ({
      id: String(x.id),
      vehicleRef: String(x.vehicle_ref),
      tipo: x.tipo as TipoRichiesta,
      richiestaIl: String(x.richiesta_il),
      nota: x.nota ?? null,
      creataIl: String(x.creata_il),
      creataDa: x.creata_da_nome || x.creata_da_email || null,
      esito: x.esito ?? null,
      chiusaIl: giorno(x.chiusa_il),
      chiusaDa: x.esito ? (x.chiusa_da_nome || x.chiusa_da_email || (x.ha_chiusore ? "utente rimosso" : null)) : null,
      automatica: x.esito === "fatta" && !x.ha_chiusore,
    }));
    return { richieste, errore: null };
  } catch (e) {
    return { richieste: [], errore: errore(e) };
  }
}

/**
 * Segna le richieste inviate a Mizar, una per matricola. Una richiesta già
 * aperta per la stessa vettura e lo stesso tipo non si duplica (indice unico
 * parziale): torna fra le `giaAperte`.
 */
export async function creaRichieste(n: {
  tipo: TipoRichiesta; matricole: string[]; richiestaIl: string; nota: string | null; utenteId: string | null;
}): Promise<{ create: string[]; giaAperte: string[] }> {
  const r = await db.execute<any>(sql`
    INSERT INTO caronte.avm_richieste_mizar (vehicle_ref, tipo, richiesta_il, nota, creata_da)
    SELECT m, ${n.tipo}, ${n.richiestaIl}::date, ${n.nota}, ${n.utenteId}::uuid
      FROM unnest(${arrayTesto(n.matricole)}) AS m
        ON CONFLICT (vehicle_ref, tipo) WHERE esito IS NULL DO NOTHING
    RETURNING vehicle_ref`);
  const create = ((r as any).rows ?? []).map((x: any) => String(x.vehicle_ref));
  const fatte = new Set(create);
  return { create, giaAperte: n.matricole.filter(m => !fatte.has(m)) };
}

/** Chiude a mano richieste aperte: annullate, o fatte (per esempio una vettura rinumerata da Mizar). */
export async function chiudiRichieste(
  ids: string[], esito: "fatta" | "annullata", utenteId: string | null, giornoChiusura: string,
): Promise<string[]> {
  if (!ids.length) return [];
  const r = await db.execute<any>(sql`
    UPDATE caronte.avm_richieste_mizar
       SET esito = ${esito}, chiusa_il = greatest(${giornoChiusura}::date, richiesta_il), chiusa_da = ${utenteId}::uuid
     WHERE id IN (SELECT unnest(${arrayTesto(ids)})::uuid) AND esito IS NULL
    RETURNING id`);
  return ((r as any).rows ?? []).map((x: any) => String(x.id));
}

/**
 * Le chiusure che il diario dimostra (verificaRichieste). Idempotente: tocca
 * solo le richieste ancora aperte, quindi due letture insieme non fanno danni.
 */
export async function registraVerifiche(chiusure: Array<{ id: string; chiusaIl: string }>): Promise<number> {
  if (!chiusure.length) return 0;
  const valori = sql.join(chiusure.map(c => sql`(${c.id}::uuid, ${c.chiusaIl}::date)`), sql`, `);
  const r = await db.execute<any>(sql`
    UPDATE caronte.avm_richieste_mizar r
       SET esito = 'fatta', chiusa_il = greatest(v.giorno, r.richiesta_il)
      FROM (VALUES ${valori}) AS v(id, giorno)
     WHERE r.id = v.id AND r.esito IS NULL`);
  return (r as any).rowCount ?? 0;
}

/** Conservazione: le richieste chiuse prima del giorno `limite` si cancellano. */
export async function pulisciRichieste(limite: string): Promise<number> {
  const r = await db.execute<any>(sql`
    DELETE FROM caronte.avm_richieste_mizar WHERE esito IS NOT NULL AND chiusa_il < ${limite}::date`);
  return (r as any).rowCount ?? 0;
}
