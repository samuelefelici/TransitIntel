/**
 * Il quadro del roster SENZA NOMI, per Argos (il Rosterista).
 *
 * Decisione del titolare: i dati del roster che riguardano le persone non
 * vanno al fornitore del modello di intelligenza artificiale. Il calcolo con i
 * nomi resta in Cerbero («Copri gli scoperti», lib/roster-copertura.ts, che
 * l'operatore apre e applica a mano); ad Argos arriva solo questo quadro, fatto
 * di depositi, conteggi e codici di turno:
 *
 *   per giorno e per deposito: i turni pubblicati, quanti sono coperti, quanti
 *   da coprire (senza conducente o col titolare assente), quanti Cerbero sa già
 *   proporre e quanti restano senza candidati; quanti conducenti sono liberi, a
 *   disposizione, assenti; e i turni che restano scoperti, col codice e l'orario.
 *
 * Mai: nomi, matricole, id delle persone, motivi delle assenze, chi è assente.
 * Il quadro si costruisce campo per campo da una lista chiusa: quello che il
 * calcolo porta in più (nomi dei candidati, titolari) qui non passa, e il test
 * lo controlla sull'uscita serializzata.
 */
import type { Copertura, DaCoprire, Scoperto } from "./roster-copertura";

/** I dati di un giorno come li dà il calcolo (routes/roster.ts, calcolaCopertura). */
export interface CalcoloDelGiorno {
  pubblicato: boolean;
  daCoprire: DaCoprire[];
  coperture: Copertura[];
  scoperti: Scoperto[];
  turni: Array<{ deposito: string | null; daCoprire: boolean; titolareAssente: boolean }>;
  liberi: Array<{ deposito: string | null; disposizione: boolean }>;
  assenti: Array<{ deposito: string | null }>;
}

export interface TurnoScoperto {
  turno: string;
  inizio: string | null;
  fine: string | null;
  motivo: "nessun_candidato" | "candidati_finiti";
}

export interface QuadroDeposito {
  deposito: string;
  turni: number;
  coperti: number;
  daCoprire: number;
  senzaConducente: number;
  titolareAssente: number;
  /** quanti dei turni da coprire Cerbero sa già proporre a un conducente libero */
  proponibili: number;
  senzaCandidati: number;
  candidatiFiniti: number;
  liberi: number;
  aDisposizione: number;
  assenti: number;
  scoperti: TurnoScoperto[];
}

export interface QuadroDelGiorno {
  giorno: string;
  pubblicato: boolean;
  depositi: QuadroDeposito[];
}

const SENZA_DEPOSITO = "Senza deposito";

function vuoto(deposito: string): QuadroDeposito {
  return {
    deposito, turni: 0, coperti: 0, daCoprire: 0, senzaConducente: 0, titolareAssente: 0,
    proponibili: 0, senzaCandidati: 0, candidatiFiniti: 0, liberi: 0, aDisposizione: 0, assenti: 0, scoperti: [],
  };
}

/**
 * Il quadro di un giorno, per deposito. `filtro` (facoltativo) tiene solo i
 * depositi il cui nome lo contiene, senza badare alle maiuscole.
 */
export function quadroDelGiorno(giorno: string, c: CalcoloDelGiorno, filtro?: string | null): QuadroDelGiorno {
  if (!c.pubblicato) return { giorno, pubblicato: false, depositi: [] };
  const per = new Map<string, QuadroDeposito>();
  const di = (deposito: string | null | undefined): QuadroDeposito => {
    const nome = deposito && deposito.trim() ? deposito.trim() : SENZA_DEPOSITO;
    let q = per.get(nome);
    if (!q) { q = vuoto(nome); per.set(nome, q); }
    return q;
  };
  for (const t of c.turni) {
    const q = di(t.deposito);
    q.turni += 1;
    if (!t.daCoprire) { q.coperti += 1; continue; }
    q.daCoprire += 1;
    if (t.titolareAssente) q.titolareAssente += 1; else q.senzaConducente += 1;
  }
  for (const x of c.coperture) di(x.turno.deposito).proponibili += 1;
  for (const x of c.scoperti) {
    const q = di(x.turno.deposito);
    if (x.motivo === "nessun_candidato") q.senzaCandidati += 1; else q.candidatiFiniti += 1;
    q.scoperti.push({ turno: String(x.turno.codice), inizio: x.turno.inizio ?? null, fine: x.turno.fine ?? null, motivo: x.motivo });
  }
  for (const l of c.liberi) {
    const q = di(l.deposito);
    q.liberi += 1;
    if (l.disposizione) q.aDisposizione += 1;
  }
  for (const a of c.assenti) di(a.deposito).assenti += 1;
  const f = (filtro ?? "").trim().toLowerCase();
  const depositi = [...per.values()]
    .filter(q => !f || q.deposito.toLowerCase().includes(f))
    .map(q => ({ ...q, scoperti: [...q.scoperti].sort((a, b) => (a.inizio ?? "99:99").localeCompare(b.inizio ?? "99:99") || a.turno.localeCompare(b.turno, "it", { numeric: true })) }))
    .sort((a, b) => a.deposito.localeCompare(b.deposito, "it"));
  return { giorno, pubblicato: true, depositi };
}

/** I giorni da `dal` ad `al` compresi; `null` se il periodo non va (al prima di dal, oltre `massimo`). */
export function giorniDelPeriodo(dal: string, al: string, massimo: number): string[] | null {
  if (al < dal) return null;
  const giorni: string[] = [];
  for (let d = new Date(`${dal}T12:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const g = d.toISOString().slice(0, 10);
    if (g > al) break;
    giorni.push(g);
    if (giorni.length > massimo) return null;
  }
  return giorni;
}

/** Il periodo più lungo che si chiede in una volta: ogni giorno rifà il calcolo dei candidati. */
export const GIORNI_MASSIMI_QUADRO = 14;
