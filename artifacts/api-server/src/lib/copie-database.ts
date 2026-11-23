/**
 * Le copie del database fuori dal server, viste dall'API (tappa 7.23): le
 * fa il lavoratore (lib/lavori/copia.ts), che è il solo ad avere le
 * credenziali dello storage e del ruolo che legge tutto. L'API legge gli esiti
 * e registra la richiesta di una copia adesso: la prende il lavoratore entro
 * un minuto.
 */
import { pool } from "@workspace/db";

export interface Copia {
  id: string;
  stato: "chiesta" | "in_corso" | "riuscita" | "fallita" | "interrotta";
  chiestaDa: string | null;
  creataIl: string;
  iniziataIl: string | null;
  finitaIl: string | null;
  oggetto: string | null;
  byte: number | null;
  sha256: string | null;
  tabelle: number | null;
  versione: string | null;
  /** le tabelle saltate perché il ruolo della copia non le legge */
  escluse: string[];
  errore: string | null;
}

export class RifiutoCopie extends Error {
  constructor(public stato: number, messaggio: string) { super(messaggio); }
}

const ISO = (d: unknown) => (d == null ? null : new Date(d as string).toISOString());

/** Le ultime copie, la più recente prima; e l'ultima riuscita, anche se è più indietro. */
export async function elencoCopie(quante = 30): Promise<{ copie: Copia[]; ultimaRiuscita: Copia | null }> {
  const riga = (r: any): Copia => ({
    id: r.id, stato: r.stato, chiestaDa: r.chiesta_da_nome ?? null,
    creataIl: ISO(r.creata_il)!, iniziataIl: ISO(r.iniziata_il), finitaIl: ISO(r.finita_il),
    oggetto: r.oggetto ?? null, byte: r.byte == null ? null : Number(r.byte), sha256: r.sha256 ?? null,
    tabelle: r.tabelle ?? null, versione: r.versione ?? null, escluse: r.escluse ?? [], errore: r.errore ?? null,
  });
  const scelta = `
    SELECT c.id, c.stato, coalesce(nullif(u.full_name, ''), u.email) AS chiesta_da_nome, c.creata_il, c.iniziata_il,
           c.finita_il, c.oggetto, c.byte, c.sha256, c.tabelle, c.versione, c.escluse, c.errore
      FROM backup_copie c LEFT JOIN users u ON u.id = c.chiesta_da`;
  const { rows } = await pool.query(`${scelta} ORDER BY c.creata_il DESC LIMIT $1`, [quante]);
  const { rows: [ultima] } = await pool.query(`${scelta} WHERE c.stato = 'riuscita' ORDER BY c.finita_il DESC NULLS LAST LIMIT 1`);
  return { copie: rows.map(riga), ultimaRiuscita: ultima ? riga(ultima) : null };
}

/** Chiede una copia adesso. Una sola chiesta alla volta (indice unico): la seconda è un 409. */
export async function chiediCopia(utenteId: string | null): Promise<{ id: string }> {
  try {
    const { rows: [r] } = await pool.query(
      "INSERT INTO backup_copie (stato, chiesta_da) VALUES ('chiesta', $1) RETURNING id", [utenteId]);
    return { id: r.id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new RifiutoCopie(409, "C'è già una copia chiesta: il lavoratore la prende entro un minuto");
    }
    throw err;
  }
}
