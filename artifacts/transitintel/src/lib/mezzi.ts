/** I mezzi per deposito (GET /api/roster/mezzi, tappa 5.3), senza React. */

export interface MezziDelDeposito {
  codice: string | null;
  deposito: string;
  fabbisogno: { totale: number; perTipo: Array<{ tipo: string; turni: number }> };
  disponibili: { totale: number; inServizio: number; riserva: number; perModello: Array<{ modello: string; mezzi: number }> } | null;
  inOfficina: Array<{ matricola: string; modello: string | null; fermoDal: string | null; motivo: string | null; commessa: string | null }>;
  margine: number | null;
  perTipo: Array<{ tipo: string; servono: number; ci_sono: number }>;
}
export interface MezziDelGiorno {
  giorno: string;
  giornata: boolean;
  officina: { disponibile: boolean; motivo: string | null; lettoAlle: string; statoDiAdesso: boolean };
  depositi: MezziDelDeposito[];
}

/** I depositi dove i mezzi non bastano, col numero che manca. */
export function mancanze(m: MezziDelGiorno): Array<{ deposito: string; mancano: number }> {
  return m.depositi.filter((d) => d.margine != null && d.margine < 0).map((d) => ({ deposito: d.deposito, mancano: -d.margine! }));
}

/** Il deposito scelto nella vestizione (codice del catalogo), o tutti sommati con `null`. */
export function mezziDi(m: MezziDelGiorno, codice: string | null): MezziDelDeposito | null {
  if (codice) return m.depositi.find((d) => d.codice === codice) ?? null;
  if (!m.depositi.length) return null;
  const tot = m.depositi.reduce<MezziDelDeposito>((a, d) => ({
    ...a,
    fabbisogno: { totale: a.fabbisogno.totale + d.fabbisogno.totale, perTipo: [] },
    disponibili: a.disponibili && d.disponibili ? {
      totale: a.disponibili.totale + d.disponibili.totale, inServizio: a.disponibili.inServizio + d.disponibili.inServizio,
      riserva: a.disponibili.riserva + d.disponibili.riserva, perModello: [],
    } : null,
    inOfficina: [...a.inOfficina, ...d.inOfficina],
  }), {
    codice: null, deposito: "Tutti i depositi", fabbisogno: { totale: 0, perTipo: [] },
    disponibili: m.officina.disponibile ? { totale: 0, inServizio: 0, riserva: 0, perModello: [] } : null,
    inOfficina: [], margine: null, perTipo: [],
  });
  return { ...tot, margine: tot.disponibili ? tot.disponibili.totale - tot.fabbisogno.totale : null };
}
