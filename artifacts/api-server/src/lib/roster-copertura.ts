/**
 * «Copri gli scoperti» (PR 7.6): per un giorno, i turni pubblicati senza
 * conducente, o col titolare assente e senza sostituto, si propongono ai
 * conducenti dello stesso deposito che quel giorno sono liberi o a
 * disposizione e a cui il turno non crea violazioni di riposo (le stesse
 * regole dei sostituti della 5.1, lib/roster-sostituti.ts).
 *
 * Qui solo la scelta, senza database: chi la usa passa i turni da coprire e,
 * per ognuno, i candidati già filtrati (deposito, servizio, assenze,
 * violazioni). Regole:
 *   - i turni in ordine di inizio (i primi del mattino prima);
 *   - per ogni turno, prima i liberi, poi quelli a disposizione; a parità chi
 *     ha meno turni nei giorni intorno (il carico), poi per nome;
 *   - un conducente prende al più un turno del giorno: due turni nello stesso
 *     giorno li decide una persona;
 *   - chi è già in servizio quel giorno non si propone (lo fa la 5.1 a mano).
 * È una proposta: si guarda e poi si assegna, con gli stessi controlli
 * dell'assegnazione a mano.
 */
export interface DaCoprire {
  dssId: string;
  codice: string;
  inizio: string | null;
  fine: string | null;
  deposito: string | null;
  /** l'assegnazione del titolare assente, se il turno era suo */
  titolare: { id: string; nome: string | null } | null;
}

export type GruppoCopertura = "libero" | "disposizione";

export interface CandidatoCopertura {
  id: string;
  nome: string;
  gruppo: GruppoCopertura;
  /** i turni del conducente nei giorni intorno: a parità si sceglie chi ne ha meno */
  carico: number;
}

export interface Copertura { turno: DaCoprire; driverId: string; nome: string; gruppo: GruppoCopertura }
export type MotivoScoperto = "nessun_candidato" | "candidati_finiti";
export interface Scoperto { turno: DaCoprire; motivo: MotivoScoperto }

export const chiaveTurno = (t: { dssId: string; codice: string }) => `${t.dssId}|${t.codice}`;

const ORDINE: GruppoCopertura[] = ["libero", "disposizione"];

/** La scelta: chi copre che cosa, e che cosa resta scoperto e perché. */
export function copri(turni: DaCoprire[], candidati: Map<string, CandidatoCopertura[]>): { coperture: Copertura[]; scoperti: Scoperto[] } {
  const inOrdine = [...turni].sort((a, b) =>
    (a.inizio ?? "99:99").localeCompare(b.inizio ?? "99:99") || a.codice.localeCompare(b.codice, "it", { numeric: true }));
  const usati = new Set<string>();
  const coperture: Copertura[] = [];
  const scoperti: Scoperto[] = [];
  for (const t of inOrdine) {
    const elenco = [...(candidati.get(chiaveTurno(t)) ?? [])].sort((a, b) =>
      ORDINE.indexOf(a.gruppo) - ORDINE.indexOf(b.gruppo) || a.carico - b.carico || a.nome.localeCompare(b.nome, "it"));
    if (!elenco.length) { scoperti.push({ turno: t, motivo: "nessun_candidato" }); continue; }
    const scelto = elenco.find(c => !usati.has(c.id));
    if (!scelto) { scoperti.push({ turno: t, motivo: "candidati_finiti" }); continue; }
    usati.add(scelto.id);
    coperture.push({ turno: t, driverId: scelto.id, nome: scelto.nome, gruppo: scelto.gruppo });
  }
  return { coperture, scoperti };
}
