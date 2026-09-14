/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE CORREZIONI ALLA TRANSCODIFICA — quello che l'operatore ha deciso
 * ───────────────────────────────────────────────────────────────────────────
 * Il file dell'azienda è il punto di partenza; non è perfetto e invecchia:
 * paline nuove senza codice, fermate spostate, abbinamenti che il nome
 * smentisce. Le correzioni si fanno dalla scheda «Paline Mizar» e vivono
 * qui, una riga per codice Mizar: chi l'ha decisa, quando, e perché.
 *
 * Una correzione con stop_id vuoto vuol dire «questa palina non ha una
 * fermata nel feed»: toglie l'abbinamento del file invece di sostituirlo.
 *
 * Il file non si tocca mai: la tabella effettiva è file + correzioni, e si
 * esporta nello stesso formato del file, con la colonna che dice da dove
 * viene ogni riga. Come per le altre tabelle dell'esercizio, si crea da sé
 * al primo bisogno e se il database non concede si legge vuota.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface OverridePalina {
  mizarRef: string;
  /** null = nessuna fermata nel feed per questa palina */
  stopId: string | null;
  nome: string | null;
  nota: string | null;
  utente: string | null;
  aggiornataAlle: string;
}

let pronto: Promise<boolean> | null = null;
let ultimoErrore: string | null = null;
let cache: { at: number; righe: OverridePalina[] } | null = null;
const TTL_MS = 60_000;

export function erroreOverrides(): string | null { return ultimoErrore; }

async function crea(): Promise<boolean> {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS caronte.stop_alias_overrides (
        mizar_ref text PRIMARY KEY,
        stop_id text,
        nome text,
        nota text,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now())`);
    ultimoErrore = null;
    return true;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    console.warn("[siri] correzioni alla transcodifica non attive:", ultimoErrore);
    return false;
  }
}
function assicura(): Promise<boolean> {
  if (!pronto) {
    pronto = crea().then(ok => { if (!ok) pronto = null; return ok; }).catch(() => { pronto = null; return false; });
  }
  return pronto;
}

export function invalidaOverrides(): void { cache = null; }

/** Tutte le correzioni, con una cache breve: l'indice del feed le rilegge a ogni ricarica. */
export async function leggiOverrides(force = false): Promise<OverridePalina[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.righe;
  if (!(await assicura())) return cache?.righe ?? [];
  try {
    const r = await db.execute<any>(sql`
      SELECT mizar_ref, stop_id, nome, nota, updated_by, updated_at
        FROM caronte.stop_alias_overrides ORDER BY mizar_ref`);
    const righe: OverridePalina[] = ((r as any).rows ?? []).map((x: any) => ({
      mizarRef: String(x.mizar_ref),
      stopId: x.stop_id != null && String(x.stop_id).trim() ? String(x.stop_id).trim() : null,
      nome: x.nome ?? null, nota: x.nota ?? null, utente: x.updated_by ?? null,
      aggiornataAlle: new Date(x.updated_at).toISOString(),
    }));
    cache = { at: Date.now(), righe };
    ultimoErrore = null;
    return righe;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return cache?.righe ?? [];
  }
}

export async function salvaOverride(o: { mizarRef: string; stopId: string | null; nome?: string | null; nota?: string | null; utente?: string | null }): Promise<boolean> {
  if (!(await assicura())) return false;
  try {
    await db.execute(sql`
      INSERT INTO caronte.stop_alias_overrides (mizar_ref, stop_id, nome, nota, updated_by)
      VALUES (${o.mizarRef}, ${o.stopId}, ${o.nome ?? null}, ${o.nota ?? null}, ${o.utente ?? null})
      ON CONFLICT (mizar_ref) DO UPDATE SET
        stop_id = EXCLUDED.stop_id, nome = COALESCE(EXCLUDED.nome, caronte.stop_alias_overrides.nome),
        nota = EXCLUDED.nota, updated_by = EXCLUDED.updated_by, updated_at = now()`);
    invalidaOverrides();
    ultimoErrore = null;
    return true;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return false;
  }
}

export async function rimuoviOverride(mizarRef: string): Promise<boolean> {
  if (!(await assicura())) return false;
  try {
    await db.execute(sql`DELETE FROM caronte.stop_alias_overrides WHERE mizar_ref = ${mizarRef}`);
    invalidaOverrides();
    return true;
  } catch (e: any) {
    ultimoErrore = e?.cause?.message ?? e?.message ?? String(e);
    return false;
  }
}

export function resetOverridesCache(): void { pronto = null; cache = null; ultimoErrore = null; }
