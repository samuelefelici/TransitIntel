/** Le vetture sui turni macchina del giorno (GET /api/roster/vetture, tappa 5.4), senza React. */

export interface TurnoConVettura {
  vssId: string; turnoMacchina: string; udp: string | null;
  deposito: string | null; depositoCodice: string | null; tipoMezzo: string | null;
  uscita: string | null; rientro: string | null; corse: number;
  vettura: string | null; assegnataDa: string | null; assegnataIl: string | null;
  vistaDallAvm: string[];
  avvisi: string[];
}
export interface MezzoProposto { matricola: string; modello: string | null; stato: "in_servizio" | "riserva"; depositoCodice: string | null }
export interface VettureDelGiorno {
  giorno: string;
  giornata: { stato: string } | null;
  turni: TurnoConVettura[];
  daRiassegnare: Array<{ vssId: string; turnoMacchina: string; vettura: string }>;
  officina: { disponibile: boolean; motivo: string | null };
  mezzi: MezzoProposto[];
}

const chiave = (s: string | null | undefined) => String(s ?? "").trim().toLowerCase();

/** I turni del deposito scelto (codice del catalogo), o tutti con `null`. */
export function turniDi(v: VettureDelGiorno, codice: string | null): TurnoConVettura[] {
  return codice ? v.turni.filter((t) => t.depositoCodice === codice) : v.turni;
}

/**
 * I mezzi da proporre per un turno: quelli del deposito (o tutti, se il
 * deposito non si sa), prima i liberi del tipo giusto, poi gli altri liberi,
 * poi quelli già su un altro turno (con l'indicazione).
 */
export function mezziPer(v: VettureDelGiorno, t: TurnoConVettura): Array<MezzoProposto & { su: string | null }> {
  const su = new Map<string, string>();
  for (const x of v.turni) if (x.vettura && x !== t) su.set(chiave(x.vettura), x.turnoMacchina);
  const delDeposito = t.depositoCodice ? v.mezzi.filter((m) => m.depositoCodice === t.depositoCodice) : v.mezzi;
  const peso = (m: MezzoProposto) =>
    (su.has(chiave(m.matricola)) ? 4 : 0) + (m.stato === "riserva" ? 1 : 0) + (t.tipoMezzo && chiave(m.modello) === chiave(t.tipoMezzo) ? 0 : 2);
  return delDeposito
    .map((m) => ({ ...m, su: su.get(chiave(m.matricola)) ?? null }))
    .sort((a, b) => peso(a) - peso(b) || a.matricola.localeCompare(b.matricola, "it", { numeric: true }));
}

/** Quante vetture mancano ancora sui turni del deposito, e quanti turni hanno un avviso. */
export function riepilogoVetture(turni: TurnoConVettura[]) {
  return {
    turni: turni.length,
    senza: turni.filter((t) => !t.vettura).length,
    conAvvisi: turni.filter((t) => t.avvisi.length > 0).length,
  };
}

/** Una matricola accettabile: la stessa regola dell'API. */
export const MATRICOLA = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/;
