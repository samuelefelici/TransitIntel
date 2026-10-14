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
 * I tempi sono minuti dalla mezzanotte del giorno di servizio e a mezzanotte
 * non si azzerano (convenzione GTFS: «25:10» è l'01:10 del giorno dopo). Per
 * confrontare giorni diversi si sommano i giorni dall'epoca: l'ora è quella
 * dell'orologio, quindi la notte del cambio d'ora il riposo vero è di un'ora
 * in più o in meno.
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
  /** minuti assoluti: giornoEpoca(giorno) × 1440 + minuti del giorno di servizio */
  inizio: number;
  fine: number;
  servizio: Servizio | null;
  servizioDa: ServizioDa;
  forzato: boolean;
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
}

export const chiaveTurno = (dssId: string, giorno: string, codice: string): string => `${dssId}|${giorno}|${codice}`;

/** Il riposo minimo fra due turni: 8h solo se sono urbani tutti e due. */
export function riposoMinimo(a: Pick<TurnoNelTempo, "servizio">, b: Pick<TurnoNelTempo, "servizio">): { minimo: number; presunto: boolean } {
  if (a.servizio === "urbano" && b.servizio === "urbano") return { minimo: RIPOSO_MINIMO_MIN.urbano, presunto: false };
  const certo = a.servizio === "extraurbano" || b.servizio === "extraurbano";
  return { minimo: RIPOSO_MINIMO_MIN.extraurbano, presunto: !certo };
}

/**
 * Le violazioni fra i turni di UN conducente: tutte le coppie che si
 * sovrappongono, e i riposi troppo corti fra un turno e il successivo (il
 * precedente è quello che finisce più tardi fra quelli già iniziati).
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
  let precedente: TurnoNelTempo | null = null;
  for (const t of ordinati) {
    if (precedente && t.inizio >= precedente.fine) {
      const riposo = t.inizio - precedente.fine;
      const { minimo, presunto } = riposoMinimo(precedente, t);
      if (riposo < minimo) out.push(violazione("riposo", precedente, t, riposo, minimo, presunto));
    }
    if (!precedente || t.fine > precedente.fine) precedente = t;
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

/** «lun 13/10 21:40» da minuti assoluti. */
export function quando(minutiAssoluti: number): string {
  const giorno = Math.floor(minutiAssoluti / MINUTI_GIORNO);
  const m = minutiAssoluti - giorno * MINUTI_GIORNO;
  const data = new Date(giorno * 86_400_000);
  const dow = data.toLocaleDateString("it-IT", { weekday: "short", timeZone: "UTC" });
  return `${dow} ${due(data.getUTCDate())}/${due(data.getUTCMonth() + 1)} ${due(Math.floor(m / 60))}:${due(m % 60)}`;
}

/** La fine di un intervallo: solo l'ora se è lo stesso giorno dell'inizio, altrimenti anche il giorno. */
function finoA(inizio: number, fine: number): string {
  const q = quando(fine);
  return Math.floor(inizio / MINUTI_GIORNO) === Math.floor(fine / MINUTI_GIORNO) ? q.slice(-5) : q;
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
  return { regola, conducenteId: a.conducenteId, turni: [a, b], minuti, minimo, presunto, testo };
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
    forzata: v.turni.some(t => t.forzato),
    turni: v.turni.map(t => ({
      assegnazioneId: t.assegnazioneId, giorno: t.giorno, codice: t.codice, dssId: t.dssId,
      servizio: t.servizio, servizioDa: t.servizioDa,
    })),
  };
}
export type ViolazioneClient = ReturnType<typeof perIlClient>;
