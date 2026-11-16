/**
 * Mezzi: fabbisogno e disponibilità per deposito (tappa 5.3).
 *
 *   fabbisogno     dai turni macchina della giornata di esercizio (4.3): ogni
 *                  turno macchina vuole un mezzo, per deposito e tipo;
 *   disponibilità  dall'officina (FleetCare, lib/officina.ts): per deposito i
 *                  mezzi in servizio e di riserva, e quelli fermi in officina
 *                  (da quando, la commessa). I dismessi non contano. È lo stato
 *                  di ADESSO: per domani si assume che chi è in officina oggi lo
 *                  sia ancora, e la risposta lo dice.
 *
 * Il confronto è sui totali per deposito: i tipi dei turni («12m») e i
 * modelli dell'officina non parlano la stessa lingua, e un confronto per tipo
 * si fa solo dove i nomi coincidono. I depositi si abbinano al catalogo del
 * personale come i colori del tabellone (lib/roster-colori-depositi.ts).
 * Se FleetCare non risponde resta il fabbisogno, con il motivo.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { Deposito } from "./anagrafica-campi";
import { depositoDelNome } from "./roster-colori-depositi";
import type { MezzoOfficina, ParcoOfficina } from "./officina";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const chiave = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

export interface FabbisognoTurni { deposito: string | null; tipo: string | null; turni: number }
export interface FermoInOfficina { matricola: string; modello: string | null; fermoDal: string | null; motivo: string | null; commessa: string | null }

export interface MezziDelDeposito {
  /** codice del catalogo, o null se il nome non si abbina */
  codice: string | null;
  deposito: string;
  fabbisogno: { totale: number; perTipo: Array<{ tipo: string; turni: number }> };
  /** null se l'officina non è disponibile */
  disponibili: { totale: number; inServizio: number; riserva: number; perModello: Array<{ modello: string; mezzi: number }> } | null;
  inOfficina: FermoInOfficina[];
  /** disponibili - fabbisogno; null senza l'officina */
  margine: number | null;
  /** per i tipi che hanno lo stesso nome nei turni e nell'officina: quanti servono e quanti ce ne sono */
  perTipo: Array<{ tipo: string; servono: number; ci_sono: number }>;
}

/**
 * Il confronto, puro: dalle righe del fabbisogno e dal parco dell'officina.
 * `deposito` limita a un deposito del catalogo (codice), `vede` ai depositi
 * che chi chiede vede.
 */
export function mezziPerDeposito(input: {
  fabbisogno: FabbisognoTurni[];
  parco: ParcoOfficina;
  catalogo: Deposito[];
  vede?: (codice: string | null) => boolean;
}): MezziDelDeposito[] {
  const out = new Map<string, MezziDelDeposito>();
  const abbina = (nome: string | null) => {
    const n = (nome ?? "").trim();
    const dep = n ? depositoDelNome(n, input.catalogo) : null;
    return { codice: dep?.codice ?? null, nome: dep?.nome ?? (n || "Senza deposito") };
  };
  const voce = (nome: string | null): MezziDelDeposito => {
    const d = abbina(nome);
    const k = d.codice ?? `?${chiave(d.nome)}`;
    let v = out.get(k);
    if (!v) {
      v = {
        codice: d.codice, deposito: d.nome, fabbisogno: { totale: 0, perTipo: [] },
        disponibili: input.parco.disponibile ? { totale: 0, inServizio: 0, riserva: 0, perModello: [] } : null,
        inOfficina: [], margine: null, perTipo: [],
      };
      out.set(k, v);
    }
    return v;
  };
  for (const f of input.fabbisogno) {
    const v = voce(f.deposito);
    v.fabbisogno.totale += f.turni;
    const tipo = f.tipo?.trim() || "non indicato";
    const t = v.fabbisogno.perTipo.find((x) => x.tipo === tipo);
    if (t) t.turni += f.turni; else v.fabbisogno.perTipo.push({ tipo, turni: f.turni });
  }
  if (input.parco.disponibile) {
    for (const m of input.parco.mezzi) {
      if (m.stato === "dismesso") continue;
      const v = voce(m.deposito);
      if (m.stato === "in_officina") { v.inOfficina.push(fermo(m)); continue; }
      const d = v.disponibili!;
      d.totale++;
      if (m.stato === "riserva") d.riserva++; else d.inServizio++;
      const modello = m.modello?.trim() || "non indicato";
      const x = d.perModello.find((y) => y.modello === modello);
      if (x) x.mezzi++; else d.perModello.push({ modello, mezzi: 1 });
    }
  }
  const risultato = [...out.values()].filter((v) => !input.vede || input.vede(v.codice));
  for (const v of risultato) {
    if (v.disponibili) {
      v.margine = v.disponibili.totale - v.fabbisogno.totale;
      v.perTipo = v.fabbisogno.perTipo
        .map((t) => ({ tipo: t.tipo, servono: t.turni, ci_sono: v.disponibili!.perModello.find((m) => chiave(m.modello) === chiave(t.tipo))?.mezzi ?? -1 }))
        .filter((t) => t.ci_sono >= 0);
    }
    v.fabbisogno.perTipo.sort((a, b) => b.turni - a.turni || a.tipo.localeCompare(b.tipo));
    v.disponibili?.perModello.sort((a, b) => b.mezzi - a.mezzi || a.modello.localeCompare(b.modello));
    v.inOfficina.sort((a, b) => (a.fermoDal ?? "").localeCompare(b.fermoDal ?? "") || a.matricola.localeCompare(b.matricola));
  }
  /* prima quelli dove mancano mezzi, poi per nome */
  return risultato.sort((a, b) => Number((b.margine ?? 0) < 0) - Number((a.margine ?? 0) < 0) || a.deposito.localeCompare(b.deposito, "it"));
}

const fermo = (m: MezzoOfficina): FermoInOfficina => ({
  matricola: m.matricola, modello: m.modello, fermoDal: m.fermoDal, motivo: m.fermoMotivo, commessa: m.commessa,
});

/** Il fabbisogno della giornata: i turni macchina per deposito e tipo. `null` se la giornata non è ancora preparata. */
export async function fabbisognoDelGiorno(giorno: string): Promise<FabbisognoTurni[] | null> {
  const g = righe(await db.execute(sql`SELECT 1 FROM esercizio_giornate WHERE giorno = ${giorno}::date`));
  if (!g.length) return null;
  return righe(await db.execute(sql`
    SELECT deposito, tipo_mezzo, count(*)::int AS turni FROM esercizio_turni_macchina
     WHERE giorno = ${giorno}::date GROUP BY 1, 2 ORDER BY 1, 2`))
    .map((r) => ({ deposito: r.deposito ?? null, tipo: r.tipo_mezzo ?? null, turni: Number(r.turni) }));
}
