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
 * mezzanotte non si azzerano (convenzione GTFS: «25:10» è l'01:10 del giorno
 * dopo). Per confrontare giorni diversi diventano istanti veri, in minuti
 * dall'epoca: come in GTFS, il giorno di servizio parte da mezzogiorno meno
 * 12 ore, ora di Roma. Così la notte del cambio d'ora il riposo è quello
 * vero, un'ora in più o in meno di quello che dice l'orologio.
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
  if (fine - inizio > MINUTI_GIORNO) return null;
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
const inizi = new Map<string, number>();
/**
 * L'istante, in minuti dall'epoca, da cui si contano i minuti del giorno di
 * servizio: mezzogiorno di Roma meno 12 ore (convenzione GTFS). Fuori dai
 * giorni del cambio d'ora è la mezzanotte di Roma.
 */
export function inizioGiorno(giorno: string): number {
  const noto = inizi.get(giorno);
  if (noto !== undefined) return noto;
  const epoca = giornoEpoca(giorno);
  const valore = epoca * MINUTI_GIORNO - scartoRoma(new Date((epoca * MINUTI_GIORNO + 720) * 60_000));
  if (inizi.size > 5000) inizi.clear();
  inizi.set(giorno, valore);
  return valore;
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
  /** istanti in minuti dall'epoca: inizioGiorno(giorno) + minuti del giorno di servizio */
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

/** Il riposo minimo fra due turni: 8h solo se sono urbani tutti e due. */
export function riposoMinimo(a: Pick<TurnoNelTempo, "servizio">, b: Pick<TurnoNelTempo, "servizio">): { minimo: number; presunto: boolean } {
  if (a.servizio === "urbano" && b.servizio === "urbano") return { minimo: RIPOSO_MINIMO_MIN.urbano, presunto: false };
  const certo = a.servizio === "extraurbano" || b.servizio === "extraurbano";
  return { minimo: RIPOSO_MINIMO_MIN.extraurbano, presunto: !certo };
}

/**
 * Le violazioni fra i turni di UN conducente: tutte le coppie che si
 * sovrappongono, e i riposi troppo corti fra un turno e il turno che viene
 * subito dopo. «Subito dopo»: finito u, nessun altro turno comincia prima di
 * t. Se più turni finiscono prima di t senza niente in mezzo (due turni
 * sovrapposti, o che finiscono insieme), ognuno fa coppia con t con la sua
 * regola: un extraurbano vuole 9h anche se l'altro, urbano, finisce dopo.
 */
export function violazioniDelConducente(turni: TurnoNelTempo[]): Violazione[] {
  const ordinati = [...turni].sort((a, b) => a.inizio - b.inizio || a.fine - b.fine || a.chiave.localeCompare(b.chiave));
  const out: Violazione[] = [];
  for (let i = 0; i < ordinati.length; i++) {
    for (let j = i + 1; j < ordinati.length && ordinati[j]!.inizio < ordinati[i]!.fine; j++) {
      const a = ordinati[i]!, b = ordinati[j]!;
      const minuti = Math.min(a.fine, b.fine) - b.inizio;
      if (minuti > 0) out.push(violazione("sovrapposizione", a, b, minuti, null, false));
    }
  }
  for (let j = 0; j < ordinati.length; j++) {
    const t = ordinati[j]!;
    for (let i = 0; i < ordinati.length; i++) {
      const u = ordinati[i]!;
      if (i === j || u.fine > t.inizio || u.inizio > t.inizio) continue;
      const riposo = t.inizio - u.fine;
      /* oltre le 9h va bene comunque */
      if (riposo >= RIPOSO_MINIMO_MIN.extraurbano) continue;
      const inMezzo = ordinati.some((v, k) => k !== i && k !== j && v.inizio >= u.fine && v.inizio < t.inizio);
      if (inMezzo) continue;
      const { minimo, presunto } = riposoMinimo(u, t);
      if (riposo < minimo) out.push(violazione("riposo", u, t, riposo, minimo, presunto));
    }
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

function perche(a: TurnoNelTempo, b: TurnoNelTempo, minimo: number, presunto: boolean): string {
  if (a.servizio === "urbano" && b.servizio === "urbano") return `fra due turni urbani servono almeno ${durata(minimo)}`;
  if (presunto) {
    const ignoto = [a, b].filter(t => !t.servizio).map(t => t.codice).join(" e ");
    return `servono almeno ${durata(minimo)}: di ${ignoto} non si sa se è urbano o extraurbano, e nel dubbio vale la regola più severa`;
  }
  const extra = [a, b].filter(t => t.servizio === "extraurbano").map(t => t.codice).join(" e ");
  return `${extra} ${extra.includes(" e ") ? "sono extraurbani" : "è extraurbano"}: servono almeno ${durata(minimo)}`;
}

function violazione(regola: Regola, a: TurnoNelTempo, b: TurnoNelTempo, minuti: number, minimo: number | null, presunto: boolean): Violazione {
  const testo = regola === "sovrapposizione"
    ? `${a.codice} (${quando(a.inizio)}–${finoA(a.inizio, a.fine)}) e ${b.codice} (${quando(b.inizio)}–${finoA(b.inizio, b.fine)}) si sovrappongono per ${durata(minuti)}`
    : `Riposo di ${durata(minuti)} fra ${a.codice} (fine ${quando(a.fine)}) e ${b.codice} (inizio ${quando(b.inizio)}): ${perche(a, b, minimo!, presunto)}`;
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
