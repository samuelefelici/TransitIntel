/**
 * Le vetture sui turni macchina del giorno (tappa 5.4; migrazione 0033).
 *
 * Il capo deposito assegna una vettura (la matricola dell'AVM) a ogni turno
 * macchina della giornata di esercizio, oggi o domani. Le assegnazioni stanno
 * in esercizio_vetture, a parte dai turni macchina, che si riscrivono finché
 * la giornata non comincia; un'assegnazione il cui turno macchina è sparito
 * resta «da riassegnare».
 *
 * Avvisi, mai blocchi:
 *   - la stessa vettura su due turni macchina che si sovrappongono;
 *   - la vettura è ferma in officina o dismessa (FleetCare);
 *   - il tipo del turno e il modello della vettura non coincidono, solo dove
 *     turni e officina usano gli stessi nomi (altrimenti avviserebbe sempre);
 *   - l'AVM ha visto un'altra vettura sulle corse del turno.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { Deposito } from "./anagrafica-campi";
import { depositoDelNome } from "./roster-colori-depositi";
import type { ParcoOfficina } from "./officina";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const chiave = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Una matricola: lettere, cifre e pochi segni, al più 40. */
export const MATRICOLA = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/;

export class RifiutoVetture extends Error {
  constructor(public status: number, messaggio: string, public extra: Record<string, unknown> = {}) { super(messaggio); }
}

export interface TurnoConVettura {
  vssId: string; turnoMacchina: string; udp: string | null;
  deposito: string | null; depositoCodice: string | null; tipoMezzo: string | null;
  uscita: string | null; rientro: string | null; corse: number;
  vettura: string | null; assegnataDa: string | null; assegnataIl: string | null;
  /** le vetture che l'AVM ha visto sulle corse del turno */
  vistaDallAvm: string[];
  avvisi: string[];
}

const minuti = (t: string | null) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Gli avvisi, puri: dai turni (con la vettura assegnata) e dal parco dell'officina. */
export function avvisiVetture(turni: TurnoConVettura[], parco: ParcoOfficina | null): TurnoConVettura[] {
  const mezzi = new Map((parco?.disponibile ? parco.mezzi : []).map((m) => [chiave(m.matricola), m]));
  const tipiDelGiorno = new Set(turni.map((t) => chiave(t.tipoMezzo)).filter(Boolean));
  return turni.map((t) => {
    const avvisi: string[] = [];
    if (t.vettura) {
      const v = chiave(t.vettura);
      const [i, f] = [minuti(t.uscita), minuti(t.rientro)];
      for (const altro of turni) {
        if (altro === t || chiave(altro.vettura) !== v) continue;
        const [ai, af] = [minuti(altro.uscita), minuti(altro.rientro)];
        if (i == null || f == null || ai == null || af == null || (i < af && ai < f)) {
          avvisi.push(`La vettura ${t.vettura} è anche sul turno ${altro.turnoMacchina}${i == null || ai == null ? "" : ", che si sovrappone"}`);
        }
      }
      const m = mezzi.get(v);
      if (m?.stato === "in_officina") avvisi.push(`La vettura ${t.vettura} è ferma in officina${m.fermoDal ? ` dal ${m.fermoDal.slice(0, 10)}` : ""}`);
      if (m?.stato === "dismesso") avvisi.push(`La vettura ${t.vettura} risulta dismessa`);
      if (m?.modello && t.tipoMezzo && tipiDelGiorno.has(chiave(m.modello)) && chiave(m.modello) !== chiave(t.tipoMezzo)) {
        avvisi.push(`Il turno vuole ${t.tipoMezzo}, la vettura ${t.vettura} è ${m.modello}`);
      }
      const altreAvm = t.vistaDallAvm.filter((x) => chiave(x) !== v);
      if (altreAvm.length) avvisi.push(`L'AVM ha visto ${altreAvm.length === 1 ? "un'altra vettura" : "altre vetture"} sulle corse del turno: ${altreAvm.join(", ")}`);
    }
    return { ...t, avvisi };
  });
}

/** I turni macchina della giornata con le vetture, gli avvisi e le assegnazioni da riassegnare. */
export async function vettureDelGiorno(giorno: string, catalogo: Deposito[], parco: ParcoOfficina | null) {
  const g = righe(await db.execute(sql`SELECT stato FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
  if (!g) return { giornata: null, turni: [] as TurnoConVettura[], daRiassegnare: [] as Array<{ vssId: string; turnoMacchina: string; vettura: string }> };
  const avm = new Map<string, string[]>();
  for (const r of righe(await db.execute(sql`
    SELECT c.vss_id::text AS vss, c.turno_macchina, array_agg(DISTINCT v) AS vetture
      FROM esercizio_corse c, jsonb_array_elements_text(COALESCE(c.prove->'vetture', '[]'::jsonb)) v
     WHERE c.giorno = ${giorno}::date AND c.turno_macchina IS NOT NULL
     GROUP BY 1, 2`))) avm.set(`${r.vss}|${r.turno_macchina}`, (r.vetture ?? []).filter(Boolean).sort());
  const turni: TurnoConVettura[] = righe(await db.execute(sql`
    SELECT t.vss_id::text AS vss, t.turno_macchina, t.udp_nome, t.deposito, t.tipo_mezzo, t.uscita, t.rientro, t.corse_nel_giorno,
           v.vettura, COALESCE(u.full_name, u.email) AS da, v.assegnata_il
      FROM esercizio_turni_macchina t
      LEFT JOIN esercizio_vetture v ON v.giorno = t.giorno AND v.vss_id = t.vss_id AND v.turno_macchina = t.turno_macchina
      LEFT JOIN users u ON u.id = v.assegnata_da
     WHERE t.giorno = ${giorno}::date
     ORDER BY t.uscita NULLS LAST, t.turno_macchina`)).map((r) => ({
    vssId: String(r.vss), turnoMacchina: String(r.turno_macchina), udp: r.udp_nome ?? null,
    deposito: r.deposito ?? null, depositoCodice: r.deposito ? depositoDelNome(r.deposito, catalogo)?.codice ?? null : null,
    tipoMezzo: r.tipo_mezzo ?? null, uscita: r.uscita ?? null, rientro: r.rientro ?? null, corse: Number(r.corse_nel_giorno ?? 0),
    vettura: r.vettura ?? null, assegnataDa: r.da ?? null, assegnataIl: r.assegnata_il ? new Date(r.assegnata_il).toISOString() : null,
    vistaDallAvm: avm.get(`${r.vss}|${r.turno_macchina}`) ?? [], avvisi: [],
  }));
  const daRiassegnare = righe(await db.execute(sql`
    SELECT v.vss_id::text AS vss, v.turno_macchina, v.vettura FROM esercizio_vetture v
     WHERE v.giorno = ${giorno}::date
       AND NOT EXISTS (SELECT 1 FROM esercizio_turni_macchina t WHERE t.giorno = v.giorno AND t.vss_id = v.vss_id AND t.turno_macchina = v.turno_macchina)
     ORDER BY 2`)).map((r) => ({ vssId: String(r.vss), turnoMacchina: String(r.turno_macchina), vettura: String(r.vettura) }));
  return { giornata: { stato: String(g.stato) }, turni: avvisiVetture(turni, parco), daRiassegnare };
}

/** Il turno macchina della giornata da scrivere, controllato: giornata aperta, turno che c'è, deposito scrivibile. */
async function turnoDaScrivere(ex: any, giorno: string, vssId: string, turnoMacchina: string, catalogo: Deposito[],
  scrive: (codice: string | null) => boolean, ancheSparito: boolean) {
  if (!UUID.test(vssId) || !turnoMacchina || turnoMacchina.length > 100) throw new RifiutoVetture(400, "vssId (uuid) e turnoMacchina richiesti");
  const g = righe(await ex.execute(sql`SELECT stato FROM esercizio_giornate WHERE giorno = ${giorno}::date`))[0];
  if (!g) throw new RifiutoVetture(404, "Giornata non ancora preparata");
  if (g.stato === "chiusa") throw new RifiutoVetture(409, "Giornata chiusa: non si scrive più");
  const t = righe(await ex.execute(sql`
    SELECT deposito FROM esercizio_turni_macchina WHERE giorno = ${giorno}::date AND vss_id = ${vssId}::uuid AND turno_macchina = ${turnoMacchina}`))[0];
  if (!t && !ancheSparito) throw new RifiutoVetture(404, "Turno macchina non trovato in questa giornata");
  const codice = t?.deposito ? depositoDelNome(t.deposito, catalogo)?.codice ?? null : null;
  if (!scrive(codice)) {
    throw new RifiutoVetture(403, t ? `Sola lettura: il turno macchina è del deposito «${t.deposito ?? "?"}», che non modifichi` : "Sola lettura: il turno macchina non c'è più e il suo deposito non si sa", { solaLettura: true });
  }
}

export async function assegnaVettura(v: { giorno: string; vssId: string; turnoMacchina: string; vettura: string }, autore: { id: string | null },
  catalogo: Deposito[], scrive: (codice: string | null) => boolean) {
  const vettura = v.vettura.trim();
  if (!MATRICOLA.test(vettura)) throw new RifiutoVetture(400, "vettura: una matricola (lettere, cifre, al più 40)");
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await turnoDaScrivere(ex, v.giorno, v.vssId.toLowerCase(), v.turnoMacchina, catalogo, scrive, false);
    await ex.execute(sql`
      INSERT INTO esercizio_vetture (giorno, vss_id, turno_macchina, vettura, assegnata_da, assegnata_il)
      VALUES (${v.giorno}::date, ${v.vssId}::uuid, ${v.turnoMacchina}, ${vettura}, ${autore.id}::uuid, now())
      ON CONFLICT (giorno, vss_id, turno_macchina) DO UPDATE SET vettura = EXCLUDED.vettura, assegnata_da = EXCLUDED.assegnata_da, assegnata_il = now()`);
    return { vettura };
  });
}

export async function togliVettura(v: { giorno: string; vssId: string; turnoMacchina: string }, catalogo: Deposito[], scrive: (codice: string | null) => boolean) {
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await turnoDaScrivere(ex, v.giorno, v.vssId.toLowerCase(), v.turnoMacchina, catalogo, scrive, true);
    const r = righe(await ex.execute(sql`
      DELETE FROM esercizio_vetture WHERE giorno = ${v.giorno}::date AND vss_id = ${v.vssId}::uuid AND turno_macchina = ${v.turnoMacchina} RETURNING vettura`));
    if (!r.length) throw new RifiutoVetture(404, "Nessuna vettura assegnata a questo turno");
    return { tolta: r[0].vettura as string };
  });
}
