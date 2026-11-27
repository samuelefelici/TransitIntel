/**
 * ═══════════════════════════════════════════════════════════════════════════
 * I PROFILI DELLE REGOLE NEL GIRO DI ARGOS
 * ───────────────────────────────────────────────────────────────────────────
 * La Fucina parte dai profili delle regole salvati (optimizer_rule_profiles):
 * quello predefinito dell'azienda e, sopra, quello del progetto, per i turni
 * macchina (vsp: costi e parametri avanzati) e per i turni guida (crew). Il
 * giro lanciato da Argos (agent-optimize) non li leggeva: senza la
 * configurazione nella richiesta partiva dai default del codice, e due giri
 * sullo stesso progetto potevano avere regole diverse a seconda di chi li
 * lanciava. Qui il giro fa come la Fucina: profilo dell'azienda, poi del
 * progetto, poi quello che la richiesta chiede esplicitamente (vince). E
 * dichiara nei parametri del giro quali profili ha usato.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Unisce due configurazioni: gli oggetti si uniscono, il resto lo sovrascrive `sopra`. */
export function unisci(sotto: any, sopra: any): any {
  if (sopra == null) return sotto;
  if (sotto == null) return sopra;
  if (Array.isArray(sotto) || Array.isArray(sopra) || typeof sotto !== "object" || typeof sopra !== "object") return sopra;
  const out: any = { ...sotto };
  for (const k of Object.keys(sopra)) out[k] = unisci(sotto[k], sopra[k]);
  return out;
}

export interface Fonte { azienda: boolean; progetto: boolean }
export interface ProfiliDelGiro {
  vsp: Record<string, any> | null;
  crew: Record<string, any> | null;
  fonti: { vsp: Fonte; crew: Fonte };
}

const nessuno = (): ProfiliDelGiro => ({
  vsp: null, crew: null, fonti: { vsp: { azienda: false, progetto: false }, crew: { azienda: false, progetto: false } },
});

/** I profili predefiniti di chi lancia, per turni macchina e turni guida (azienda ⊕ progetto). */
export async function profiliDelGiro(userId: string, psProjectId: string | null): Promise<ProfiliDelGiro> {
  const out = nessuno();
  let righe: any[];
  try {
    righe = ((await db.execute<any>(sql`
      SELECT domain, scope, config_json FROM optimizer_rule_profiles
       WHERE owner_user_id = ${userId}::uuid AND is_default = true AND domain IN ('vsp', 'crew')
         AND (scope = 'company' ${psProjectId ? sql`OR (scope = 'project' AND project_id = ${psProjectId}::uuid)` : sql``})
       ORDER BY updated_at DESC`)).rows ?? []) as any[];
  } catch (e: any) {
    if ((e?.cause?.code ?? e?.code) === "42P01") return out;   // tabella non ancora creata
    throw e;
  }
  for (const d of ["vsp", "crew"] as const) {
    const az = righe.find(r => r.domain === d && r.scope === "company")?.config_json ?? null;
    const pr = righe.find(r => r.domain === d && r.scope === "project")?.config_json ?? null;
    out[d] = az || pr ? unisci(az ?? {}, pr) : null;
    out.fonti[d] = { azienda: !!az, progetto: !!pr };
  }
  return out;
}

const etichetta = (f: Fonte): string | null => f.azienda && f.progetto ? "azienda+progetto" : f.azienda ? "azienda" : f.progetto ? "progetto" : null;

/**
 * La richiesta del giro con i profili sotto: costi e parametri avanzati dei
 * turni macchina, la configurazione dei turni guida (solo VCSP). Quello che
 * la richiesta porta vince; il tipo di servizio è sempre quello del giro.
 */
export function applicaProfili(
  runBody: Record<string, any>, profili: ProfiliDelGiro, mode: string, serviceType: string,
): { corpo: Record<string, any>; usati: { vsp: string | null; crew: string | null } } {
  const corpo = { ...runBody };
  const vsp = profili.vsp ?? {};
  if (vsp.vehicleCosts && typeof vsp.vehicleCosts === "object") corpo.vehicleCosts = unisci(vsp.vehicleCosts, runBody.vehicleCosts);
  if (vsp.vspAdvanced && typeof vsp.vspAdvanced === "object") corpo.vspAdvanced = unisci(vsp.vspAdvanced, runBody.vspAdvanced);
  let crew: string | null = null;
  if (mode === "vcsp" && profili.crew) {
    const unito = unisci(profili.crew, runBody.crewConfig ?? null);
    corpo.crewConfig = { ...unito, bds: { ...(unito?.bds ?? {}), serviceType: runBody.crewConfig?.bds?.serviceType ?? serviceType } };
    crew = etichetta(profili.fonti.crew);
  }
  const usaVsp = !!(vsp.vehicleCosts || vsp.vspAdvanced);
  return { corpo, usati: { vsp: usaVsp ? etichetta(profili.fonti.vsp) : null, crew } };
}
