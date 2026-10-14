/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RIPOSI E SOVRAPPOSIZIONI FRA I TURNI DI UN CONDUCENTE
 * ───────────────────────────────────────────────────────────────────────────
 * Due regole sul Roster. Avvisano e si possono forzare:
 *   - fra la fine di un turno e l'inizio del successivo dello stesso
 *     conducente servono almeno 8h se i due turni sono urbani, 9h se almeno
 *     uno è extraurbano. Un turno di tipo non determinato conta come
 *     extraurbano: nel dubbio vale la regola più severa;
 *   - due turni dello stesso conducente non si sovrappongono.
 *
 * I tempi dei turni sono minuti dalla mezzanotte del giorno di servizio e a
 * mezzanotte non si azzerano («25:10» è l'01:10 del giorno dopo). Per
 * confrontare giorni diversi diventano istanti veri, in minuti dall'epoca,
 * leggendoli come ora dell'orologio di Roma: la notte del cambio d'ora il
 * riposo è quello vero, un'ora in più o in meno di quello che dice
 * l'orologio.
 *
 * Funzioni pure; la parte che legge il database sta in roster-normativa-db.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import type { Servizio } from "./udp-servizio";

export const MINUTI_GIORNO = 1440;

/** Riposo minimo fra due turni, in minuti. */
export const RIPOSO_MINIMO_MIN: Record<Servizio, number> = { urbano: 480, extraurbano: 540 };

/* ── Tempi ───────────────────────────────────────────────────────────────── */

/** Minuti da un numero o da «H:MM», «HH:MM», «HH:MM:SS», «25:10», «-1:50»; altrimenti null. */
export function minutiDa(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : null;
  if (typeof v !== "string") return null;
  const m = /^\s*(-?)(\d{1,3}):(\d{2})(?::(\d{2}))?\s*$/.exec(v);
  if (!m || Number(m[3]) > 59) return null;
  const valore = Number(m[2]) * 60 + Number(m[3]);
  return m[1] ? -valore : valore;
}

const numeri = (xs: Array<number | null>): number[] => xs.filter((x): x is number => x !== null);
const primo = (...xs: Array<number | null>): number | null => xs.find(x => x !== null) ?? null;
const lista = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * Inizio e fine di un turno guida del DSS (result.driverShifts[i]), in minuti
 * dalla mezzanotte del giorno di servizio. Prima i minuti del nastro, poi i
 * bordi delle riprese, poi le stringhe orarie, poi le corse; le attività
 * aggiunte a mano (riserva, presidio) sono lavoro anche loro.
 */
export function intervalloTurno(d: any): { inizio: number; fine: number } | null {
  if (!d || typeof d !== "object") return null;
  const riprese = lista(d.riprese);
  const corse = riprese.flatMap(r => lista(r?.trips));
  const ripI = numeri(riprese.map(r => minutiDa(r?.startMin) ?? minutiDa(r?.startTime)));
  const ripF = numeri(riprese.map(r => minutiDa(r?.endMin) ?? minutiDa(r?.endTime)));
  const corI = numeri(corse.map(t => minutiDa(t?.departureMin) ?? minutiDa(t?.departureTime)));
  const corF = numeri(corse.map(t => minutiDa(t?.arrivalMin) ?? minutiDa(t?.arrivalTime)));
  let inizio = primo(minutiDa(d.nastroStartMin), ripI.length ? Math.min(...ripI) : null,
    minutiDa(d.nastroStart ?? d.startTime), corI.length ? Math.min(...corI) : null);
  let fine = primo(minutiDa(d.nastroEndMin), ripF.length ? Math.max(...ripF) : null,
    minutiDa(d.nastroEnd ?? d.endTime), corF.length ? Math.max(...corF) : null);
  for (const a of lista(d.activities)) {
    const i = minutiDa(a?.startMin), f = minutiDa(a?.endMin);
    if (i !== null) inizio = inizio === null ? i : Math.min(inizio, i);
    if (f !== null) fine = fine === null ? f : Math.max(fine, f);
  }
  return intervalloSensato(inizio, fine);
}

/** Inizio e fine dallo snapshot salvato con l'assegnazione (minuti, o le stringhe di allora). */
export function intervalloDaSnapshot(s: any): { inizio: number; fine: number } | null {
  if (!s || typeof s !== "object") return null;
  return intervalloSensato(primo(minutiDa(s.startMin), minutiDa(s.start)), primo(minutiDa(s.endMin), minutiDa(s.end)));
}

function intervalloSensato(inizio: number | null, fine: number | null): { inizio: number; fine: number } | null {
  if (inizio === null || fine === null) return null;
  /* vecchi orari già riportati sotto le 24h: «23:30–01:10» finisce il giorno dopo */
  if (fine < inizio) fine += MINUTI_GIORNO;
  /* un turno lungo zero o più di 24 ore non è un turno: non si controlla */
  if (fine === inizio || fine - inizio > MINUTI_GIORNO) return null;
  return { inizio, fine };
}

/** Giorni dall'epoca di una data YYYY-MM-DD (UTC, così non c'entra il fuso del server). */
export const giornoEpoca = (giorno: string): number => Math.round(Date.parse(`${giorno}T00:00:00Z`) / 86_400_000);

export const FUSO = "Europe/Rome";
const formatoFuso = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
/** Quanti minuti Roma è avanti a UTC in un istante (60 d'inverno, 120 d'estate). */
function scartoRoma(istante: Date): number {
  const p = Object.fromEntries(formatoFuso.formatToParts(istante).map(x => [x.type, x.value]));
  const locale = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((locale - Math.floor(istante.getTime() / 60_000) * 60_000) / 60_000);
}
/* l'ora legale cambia solo allo scoccare di un'ora: si ricorda lo scarto di ogni ora già vista */
const scarti = new Map<number, number>();
function scartoAlMinuto(minutiUtc: number): number {
  const ora = Math.floor(minutiUtc / 60);
  let scarto = scarti.get(ora);
  if (scarto === undefined) {
    scarto = scartoRoma(new Date(ora * 3_600_000));
    if (scarti.size > 20_000) scarti.clear();
    scarti.set(ora, scarto);
  }
  return scarto;
}

/**
 * L'istante vero, in minuti dall'epoca, di un orario del giorno di servizio:
 * il giorno più i minuti, letti sull'orologio di Roma. Nell'ora che d'autunno
 * si ripete vale la seconda volta; in quella che a marzo non c'è, l'ora dopo.
 */
export function istante(giorno: string, minuti: number): number {
  const orologio = giornoEpoca(giorno) * MINUTI_GIORNO + minuti;
  const primo = scartoAlMinuto(orologio - 60);
  return orologio - scartoAlMinuto(orologio - primo);
}

/* ── Regole ──────────────────────────────────────────────────────────────── */

export type ServizioDa = "udp" | "linee" | "fucina" | null;

export interface TurnoNelTempo {
  /** chiave unica del turno nel giorno: dss|giorno|codice */
  chiave: string;
  assegnazioneId: string | null;
  conducenteId: string;
  giorno: string;
  codice: string;
  dssId: string;
  /** istanti in minuti dall'epoca: istante(giorno, minuti del giorno di servizio) */
  inizio: number;
  fine: number;
  servizio: Servizio | null;
  servizioDa: ServizioDa;
  /** le violazioni (chiaveViolazione) che chi ha assegnato questo turno ha visto e forzato */
  coppieForzate: string[];
}

export type Regola = "riposo" | "sovrapposizione";

export interface Violazione {
  regola: Regola;
  conducenteId: string;
  /** i due turni, in ordine di inizio */
  turni: [TurnoNelTempo, TurnoNelTempo];
  /** il riposo che c'è, o quanto si sovrappongono */
  minuti: number;
  /** il riposo minimo richiesto (solo per la regola del riposo) */
  minimo: number | null;
  /** true se il minimo è 9h perché un turno non ha il tipo di servizio */
  presunto: boolean;
  testo: string;
  /** regola|turno prima|turno dopo: chi forza dice quali violazioni ha visto */
  chiave: string;
}

export const chiaveTurno = (dssId: string, giorno: string, codice: string): string => `${dssId}|${giorno}|${codice}`;
export const chiaveViolazione = (regola: Regola, a: Pick<TurnoNelTempo, "chiave">, b: Pick<TurnoNelTempo, "chiave">): string =>
  `${regola}|${a.chiave}|${b.chiave}`;

/**
 * Il riposo minimo fra due blocchi di lavoro: 8h solo se tutti i turni dei
 * due blocchi sono urbani. `decisivi` sono i turni che portano a 9h: gli
 * extraurbani, o quelli di tipo ignoto se non ce n'è uno extraurbano.
 */
export function riposoMinimoFra<T extends Pick<TurnoNelTempo, "servizio">>(turni: T[]): { minimo: number; presunto: boolean; decisivi: T[] } {
  const extra = turni.filter(t => t.servizio === "extraurbano");
  if (extra.length) return { minimo: RIPOSO_MINIMO_MIN.extraurbano, presunto: false, decisivi: extra };
  const ignoti = turni.filter(t => t.servizio !== "urbano");
  if (ignoti.length) return { minimo: RIPOSO_MINIMO_MIN.extraurbano, presunto: true, decisivi: ignoti };
  return { minimo: RIPOSO_MINIMO_MIN.urbano, presunto: false, decisivi: [] };
}

/** Il riposo minimo fra due turni: 8h solo se sono urbani tutti e due. */
export function riposoMinimo(a: Pick<TurnoNelTempo, "servizio">, b: Pick<TurnoNelTempo, "servizio">): { minimo: number; presunto: boolean } {
  const { minimo, presunto } = riposoMinimoFra([a, b]);
  return { minimo, presunto };
}

/**
 * Le violazioni fra i turni di UN conducente.
 *
 * Sovrapposizioni: ogni coppia di turni che si sovrappongono.
 *
 * Riposi: i turni che si sovrappongono formano un blocco di lavoro, e il
 * riposo è lo spazio fra un blocco e il successivo, dalla fine dell'ultimo
 * turno di uno all'inizio del primo turno dell'altro. Basta un turno
 * extraurbano (o di tipo ignoto) in uno dei due blocchi per volere 9h. Due
 * turni che si toccano senza sovrapporsi sono due blocchi con riposo zero.
 */
export function violazioniDelConducente(turni: TurnoNelTempo[]): Violazione[] {
  const ordinati = [...turni].sort((a, b) => a.inizio - b.inizio || a.fine - b.fine || a.chiave.localeCompare(b.chiave));
  const out: Violazione[] = [];
  for (let i = 0; i < ordinati.length; i++) {
    for (let j = i + 1; j < ordinati.length && ordinati[j]!.inizio < ordinati[i]!.fine; j++) {
      const a = ordinati[i]!, b = ordinati[j]!;
      const minuti = Math.min(a.fine, b.fine) - b.inizio;
      if (minuti > 0) out.push(violazione("sovrapposizione", a, b, minuti, null, false, []));
    }
  }
  const blocchi: TurnoNelTempo[][] = [];
  let fineBlocco = -Infinity;
  for (const t of ordinati) {
    const ultimo = blocchi[blocchi.length - 1];
    if (ultimo && t.inizio < fineBlocco) { ultimo.push(t); fineBlocco = Math.max(fineBlocco, t.fine); }
    else { blocchi.push([t]); fineBlocco = t.fine; }
  }
  for (let i = 1; i < blocchi.length; i++) {
    const prima = blocchi[i - 1]!, dopo = blocchi[i]!;
    const a = prima.reduce((x, y) => (y.fine > x.fine ? y : x));
    const b = dopo[0]!;
    const riposo = b.inizio - a.fine;
    if (riposo >= RIPOSO_MINIMO_MIN.extraurbano) continue;
    const { minimo, presunto, decisivi } = riposoMinimoFra([...prima, ...dopo]);
    if (riposo < minimo) out.push(violazione("riposo", a, b, riposo, minimo, presunto, decisivi, prima.length + dopo.length));
  }
  return out;
}

/** Le violazioni di più conducenti insieme. */
export function violazioniDeiTurni(turni: TurnoNelTempo[]): Violazione[] {
  const perConducente = new Map<string, TurnoNelTempo[]>();
  for (const t of turni) {
    const l = perConducente.get(t.conducenteId);
    if (l) l.push(t); else perConducente.set(t.conducenteId, [t]);
  }
  return [...perConducente.values()].flatMap(violazioniDelConducente);
}

/* ── Testi ───────────────────────────────────────────────────────────────── */

const due = (n: number) => String(n).padStart(2, "0");

const formatoQuando = new Intl.DateTimeFormat("it-IT", {
  timeZone: FUSO, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
/** «lun 13/10 21:40», ora di Roma, da un istante in minuti dall'epoca. */
export function quando(istante: number): string {
  const p = Object.fromEntries(formatoQuando.formatToParts(new Date(istante * 60_000)).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

/** La fine di un intervallo: solo l'ora se è lo stesso giorno dell'inizio, altrimenti anche il giorno. */
function finoA(inizio: number, fine: number): string {
  const a = quando(inizio), b = quando(fine);
  return a.slice(0, -6) === b.slice(0, -6) ? b.slice(-5) : b;
}

/** «7h05», «45 min». */
export function durata(minuti: number): string {
  const m = Math.max(0, Math.round(minuti));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${due(m % 60)}`;
}

/** Perché serve quel minimo: chi è extraurbano, o di chi non si sa il tipo. */
function perche(minimo: number, presunto: boolean, decisivi: TurnoNelTempo[], quanti: number): string {
  const codici = [...new Set(decisivi.map(t => t.codice))];
  const elenco = codici.length > 1 ? `${codici.slice(0, -1).join(", ")} e ${codici[codici.length - 1]}` : codici[0] ?? "";
  if (!decisivi.length) return `fra ${quanti === 2 ? "due " : ""}turni urbani servono almeno ${durata(minimo)}`;
  if (presunto) return `servono almeno ${durata(minimo)}: di ${elenco} non si sa se è urbano o extraurbano, e nel dubbio vale la regola più severa`;
  return `${elenco} ${codici.length > 1 ? "sono extraurbani" : "è extraurbano"}: servono almeno ${durata(minimo)}`;
}

function violazione(regola: Regola, a: TurnoNelTempo, b: TurnoNelTempo, minuti: number, minimo: number | null,
  presunto: boolean, decisivi: TurnoNelTempo[], quanti = 2): Violazione {
  const testo = regola === "sovrapposizione"
    ? `${a.codice} (${quando(a.inizio)}–${finoA(a.inizio, a.fine)}) e ${b.codice} (${quando(b.inizio)}–${finoA(b.inizio, b.fine)}) si sovrappongono per ${durata(minuti)}`
    : `Riposo di ${durata(minuti)} fra ${a.codice} (fine ${quando(a.fine)}) e ${b.codice} (inizio ${quando(b.inizio)}): ${perche(minimo!, presunto, decisivi, quanti)}`;
  return { regola, conducenteId: a.conducenteId, turni: [a, b], minuti, minimo, presunto, testo, chiave: chiaveViolazione(regola, a, b) };
}

/** Come le violazioni vanno al client: niente minuti assoluti, solo quello che serve a mostrarle. */
export function perIlClient(v: Violazione) {
  return {
    regola: v.regola,
    conducenteId: v.conducenteId,
    minuti: v.minuti,
    minimo: v.minimo,
    presunto: v.presunto,
    testo: v.testo,
    chiave: v.chiave,
    /* forzata solo se chi ha assegnato uno dei due turni ha visto e forzato proprio questa */
    forzata: v.turni.some(t => t.coppieForzate.includes(v.chiave)),
    turni: v.turni.map(t => ({
      assegnazioneId: t.assegnazioneId, giorno: t.giorno, codice: t.codice, dssId: t.dssId,
      servizio: t.servizio, servizioDa: t.servizioDa,
    })),
  };
}
export type ViolazioneClient = ReturnType<typeof perIlClient>;
