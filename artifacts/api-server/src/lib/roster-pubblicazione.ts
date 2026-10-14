/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PUBBLICAZIONE DEI TURNI NEL ROSTER — le regole, funzioni pure
 * ───────────────────────────────────────────────────────────────────────────
 * Il roster riceve i turni guida da un canale solo: la pubblicazione. Chi
 * pubblica sceglie un programma (progetto Planning Studio), un periodo e, per
 * ogni Unità di Progettazione del programma, quali turni guida (DSS) mandare.
 * Ogni UDP vale nei giorni che ha fra le sue date: il canale tiene una riga
 * per giorno e UDP, con il DSS pubblicato.
 *
 * Pubblicare un periodo: nei giorni dove almeno un'UDP scelta ha la data, il
 * canale diventa esattamente quelle righe (le righe di prima, anche di altri
 * programmi, si sostituiscono). I giorni dove nessuna UDP scelta ha la data
 * restano come sono, e si segnalano.
 *
 * Ripubblicando un periodo già vestito, ogni assegnazione il cui turno non è
 * più pubblicato cerca un turno pubblicato quel giorno con lo stesso
 * contenuto (stesse corse, stessi orari) e ci passa, anche se il codice è
 * cambiato. Quelle che non lo trovano restano «da riassegnare».
 *
 * La parte che legge e scrive il database sta in roster-pubblicazione-db.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { intervalloTurno, minutiDa } from "./roster-normativa";

/** Una data YYYY-MM-DD o YYYYMMDD (le UDP vecchie le hanno così) come YYYY-MM-DD. */
export function normData(x: unknown): string | null {
  const s = String(x ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return null;
}

/** I giorni da `dal` ad `al` compresi. */
export function giorniDelPeriodo(dal: string, al: string): string[] {
  const out: string[] = [];
  const fine = Date.parse(`${al}T00:00:00Z`);
  for (let t = Date.parse(`${dal}T00:00:00Z`); t <= fine; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/* ── Il piano del canale ─────────────────────────────────────────────────── */

export interface RigaCanale {
  day: string;
  udpId: string;
  dssId: string;
  psProjectId: string | null;
  udpNome?: string | null;
  dssNome?: string | null;
}

export interface UdpConDate { id: string; nome: string; date: string[] }

export interface Piano {
  /** le righe nuove, nei giorni che la pubblicazione tocca */
  nuove: RigaCanale[];
  /** le righe di adesso nei giorni toccati: si sostituiscono */
  tolte: RigaCanale[];
  giorniToccati: string[];
  /** giorni del periodo dove nessuna UDP scelta ha la data: restano come sono */
  giorniSenzaUdp: string[];
  /** di questi, quelli che oggi hanno turni pubblicati (restano pubblicati così) */
  giorniSenzaUdpPubblicati: string[];
}

/**
 * Il piano di una pubblicazione. `scelte`: per ogni UDP il DSS da pubblicare,
 * o null per lasciarla fuori. `attuali`: le righe di adesso nel periodo.
 */
export function pianoCanale(p: {
  psProjectId: string;
  udp: UdpConDate[];
  scelte: Record<string, string | null>;
  dal: string;
  al: string;
  attuali: RigaCanale[];
  nomiDss?: Record<string, string | null>;
}): Piano {
  const periodo = giorniDelPeriodo(p.dal, p.al);
  const dentro = new Set(periodo);
  const nuovePerGiorno = new Map<string, RigaCanale[]>();
  for (const u of p.udp) {
    const dss = p.scelte[u.id];
    if (!dss) continue;
    for (const g of new Set(u.date.map(normData).filter((d): d is string => !!d && dentro.has(d)))) {
      const l = nuovePerGiorno.get(g) ?? [];
      l.push({ day: g, udpId: u.id, dssId: dss, psProjectId: p.psProjectId, udpNome: u.nome, dssNome: p.nomiDss?.[dss] ?? null });
      nuovePerGiorno.set(g, l);
    }
  }
  const giorniToccati = periodo.filter(g => nuovePerGiorno.has(g));
  const toccati = new Set(giorniToccati);
  const giorniSenzaUdp = periodo.filter(g => !toccati.has(g));
  const pubblicatiOra = new Set(p.attuali.map(r => r.day));
  return {
    nuove: giorniToccati.flatMap(g => nuovePerGiorno.get(g)!),
    tolte: p.attuali.filter(r => toccati.has(r.day)),
    giorniToccati,
    giorniSenzaUdp,
    giorniSenzaUdpPubblicati: giorniSenzaUdp.filter(g => pubblicatiOra.has(g)),
  };
}

/* ── Il contenuto di un turno ────────────────────────────────────────────── */

const lista = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export interface Firma {
  /** le corse del turno, ognuna come linea|partenza|arrivo|da|a, in ordine */
  corse: string[];
  inizio: number | null;
  fine: number | null;
  residenza: string | null;
  /** tutto insieme: due turni con la stessa firma sono lo stesso lavoro */
  firma: string | null;
}

/**
 * Il contenuto di un turno guida, per riconoscerlo anche se lo scheduler lo
 * rinumera o se le corse sono state rigenerate (gli id cambiano, linee e
 * orari no). Senza corse (riserva, presidio) contano gli orari e la
 * residenza, e il ricollegamento resta nella stessa UDP.
 */
export function firmaTurno(d: any): Firma {
  const corse: string[] = [];
  for (const r of lista(d?.riprese)) {
    for (const t of lista(r?.trips)) {
      if ((t?.type ?? "trip") !== "trip") continue;
      const linea = String(t?.routeName ?? t?.routeShortName ?? t?.routeId ?? "").trim();
      const parte = minutiDa(t?.departureMin) ?? minutiDa(t?.departureTime);
      const arriva = minutiDa(t?.arrivalMin) ?? minutiDa(t?.arrivalTime);
      corse.push([linea, parte ?? "", arriva ?? "", String(t?.firstStopName ?? "").trim(), String(t?.lastStopName ?? "").trim()].join("|"));
    }
  }
  corse.sort();
  const intervallo = intervalloTurno(d);
  const residenza = d?.residenzaName ? String(d.residenzaName) : null;
  const inizio = intervallo?.inizio ?? null, fine = intervallo?.fine ?? null;
  const firma = inizio === null || fine === null ? null
    : corse.length ? `C|${inizio}|${fine}|${corse.join(";")}`
      : `R|${residenza ?? ""}|${inizio}|${fine}`;
  return { corse, inizio, fine, residenza, firma };
}

/* ── Il ricollegamento ───────────────────────────────────────────────────── */

export interface TurnoPubblicabile { dssId: string; codice: string; firma: string | null }

export interface DaRicollegare {
  id: string;
  day: string;
  dssId: string;
  codice: string;
  /** la firma del turno che l'assegnazione ha adesso */
  firma: string | null;
  /** l'UDP in cui era pubblicato il suo turno, se lo era */
  udpPrima: string | null;
}

export type MotivoRestano = "nessun turno uguale" | "ambiguo" | "turno illeggibile";

export interface EsitoRicollegamento {
  spostamenti: Array<{ id: string; day: string; dssId: string; codice: string; udpId: string; daDss: string; daCodice: string }>;
  restano: Array<{ id: string; day: string; motivo: MotivoRestano }>;
}

/**
 * Per ogni assegnazione da ricollegare, il turno pubblicato quel giorno con lo
 * stesso contenuto e ancora libero. In ordine: stessa UDP di prima, poi
 * stesso codice, poi un candidato solo; se ne restano più d'uno, nessuno
 * (ambiguo: lo decide una persona). Un turno senza corse si ricollega solo
 * nella stessa UDP. Ogni turno nuovo si usa una volta sola.
 */
export function ricollega(p: {
  assegnazioni: DaRicollegare[];
  /** per giorno: le UDP pubblicate e il loro DSS, dopo la pubblicazione */
  pubblicati: Map<string, Array<{ udpId: string; dssId: string }>>;
  turni: Map<string, TurnoPubblicabile[]>;
  /** dss|giorno|codice già assegnati che restano dove sono */
  occupati: Set<string>;
}): EsitoRicollegamento {
  const out: EsitoRicollegamento = { spostamenti: [], restano: [] };
  const occupati = new Set(p.occupati);
  const ordinate = [...p.assegnazioni].sort((a, b) => a.day.localeCompare(b.day) || a.dssId.localeCompare(b.dssId) || a.codice.localeCompare(b.codice) || a.id.localeCompare(b.id));
  for (const a of ordinate) {
    if (!a.firma) { out.restano.push({ id: a.id, day: a.day, motivo: "turno illeggibile" }); continue; }
    const senzaCorse = a.firma.startsWith("R|");
    const candidati: Array<{ udpId: string; dssId: string; codice: string }> = [];
    for (const { udpId, dssId } of p.pubblicati.get(a.day) ?? []) {
      if (senzaCorse && udpId !== a.udpPrima) continue;
      for (const t of p.turni.get(dssId) ?? []) {
        if (t.firma === a.firma && !occupati.has(`${dssId}|${a.day}|${t.codice}`)) candidati.push({ udpId, dssId, codice: t.codice });
      }
    }
    const stessaUdp = candidati.filter(c => c.udpId === a.udpPrima);
    const gruppo = stessaUdp.length ? stessaUdp : candidati;
    const stessoCodice = gruppo.filter(c => c.codice === a.codice);
    const scelto = stessoCodice.length === 1 ? stessoCodice[0] : gruppo.length === 1 ? gruppo[0] : null;
    if (!scelto) {
      out.restano.push({ id: a.id, day: a.day, motivo: gruppo.length ? "ambiguo" : "nessun turno uguale" });
      continue;
    }
    occupati.add(`${scelto.dssId}|${a.day}|${scelto.codice}`);
    out.spostamenti.push({ id: a.id, day: a.day, dssId: scelto.dssId, codice: scelto.codice, udpId: scelto.udpId, daDss: a.dssId, daCodice: a.codice });
  }
  return out;
}

/**
 * Le coppie forzate (regola|dss|giorno|codice|dss|giorno|codice) dopo il
 * ricollegamento: i turni spostati cambiano chiave, la coppia la segue.
 */
export function rimappaCoppie(coppie: string[], mappa: Map<string, string>): string[] {
  return coppie.map(k => {
    const p = k.split("|");
    if (p.length !== 7) return k;
    const a = p.slice(1, 4).join("|"), b = p.slice(4, 7).join("|");
    return `${p[0]}|${mappa.get(a) ?? a}|${mappa.get(b) ?? b}`;
  });
}

/* ── Doppie coperture ────────────────────────────────────────────────────── */

export interface DoppiaCopertura { giorni: string[]; dss: string[]; corse: number; esempio: string }

/**
 * Le corse che, nello stesso giorno, stanno in due turni pubblicati (due UDP
 * con corse in comune, un DSS misto pubblicato con quelli da cui viene).
 * Si raggruppano i giorni con lo stesso insieme di DSS.
 */
export function doppieCoperture(pubblicati: Map<string, string[]>, corseDiDss: Map<string, string[][]>): DoppiaCopertura[] {
  const perInsieme = new Map<string, string[]>();
  for (const [g, dss] of pubblicati) {
    const chiave = [...new Set(dss)].sort().join(",");
    if (!chiave) continue;
    const l = perInsieme.get(chiave) ?? [];
    l.push(g);
    perInsieme.set(chiave, l);
  }
  const out: DoppiaCopertura[] = [];
  for (const [chiave, giorni] of perInsieme) {
    const dss = chiave.split(",");
    const viste = new Map<string, number>();
    for (const d of dss) for (const turno of corseDiDss.get(d) ?? []) for (const c of turno) viste.set(c, (viste.get(c) ?? 0) + 1);
    const doppie = [...viste].filter(([, n]) => n > 1);
    if (doppie.length) out.push({ giorni: giorni.sort(), dss, corse: doppie.length, esempio: doppie[0]![0] });
  }
  return out;
}
