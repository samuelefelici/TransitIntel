/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LE PERCORRENZE DI UNA LINEA: PROGRAMMATO CONTRO REALE, E IL DELTA FINALE
 * ───────────────────────────────────────────────────────────────────────────
 * Per ogni tratto fra due fermate consecutive del percorso: il tempo che
 * l'orario gli dà (arrivo alla seconda − partenza dalla prima) contro quello
 * che i bus ci mettono davvero, dai transiti SIRI/AVM. Il reale si prende
 * dalla stessa coppia di fermate percorsa di seguito da QUALUNQUE linea: una
 * linea nuova (l'81, la 22/24) non ha storia sua, ma i suoi pezzi li fanno
 * già le linee di prima.
 *
 * Per ogni nodo (fermata): il tempo cumulato dalla partenza, programmato e
 * reale — dove la corsa comincia a perdere minuti.
 *
 * Per ogni corsa: il ritardo che si porta all'arrivo (mediana e 85° percentile
 * dei tratti, all'ora in cui li percorre) e il DELTA FINALE, cioè la sosta al
 * capolinea prima della corsa successiva della linea che parte da lì. Il
 * delta deve assorbire il ritardo, altrimenti la corsa dopo parte in ritardo.
 *
 * Le regole stanno qui, il database solo fornisce i numeri: testabile senza.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { italianHolidays } from "./day-classifier";
import { fasciaDi } from "./tratte-osservate";

/** Sotto questi campioni un tratto (o una fascia oraria) non fa statistica. */
export const CAMPIONI_MINIMI = 5;
/** Il margine che il delta finale deve lasciare oltre al ritardo atteso. */
export const MARGINE_S = 120;
/** Oltre questa attesa al capolinea non è "la corsa dopo", è un'altra fase. */
export const ATTESA_MAX_S = 3 * 3600;
/** Una partenza fino a tanto PRIMA dell'arrivo è ancora la corsa dopo dello
 *  stesso bus, con delta negativo: la 22/24 arriva a Brecce Bianche alle
 *  8:10:36 e riparte alle 8:10:00. Saltarla faceva trovare quella di un'ora
 *  dopo e giudicare "assorbe" una sosta che non c'è. */
export const ANTICIPO_MAX_S = 3 * 60;
/** Quanto i ritardi dei tratti di una stessa corsa vanno insieme. Sommare gli
 *  85° percentili (correlazione 1) vuol dire che tutti i tratti vanno male
 *  nella stessa corsa; sommarli in quadratura (0) che non si influenzano mai.
 *  Il traffico li lega, ma solo in parte: 0,3. */
export const CORRELAZIONE_TRATTI = 0.3;
/** Due fermate entro questi metri sono lo stesso capolinea (piazza, stalli). */
export const STESSO_CAPOLINEA_M = 250;

export type TipoGiorno = "festivo" | "sabato" | "feriale";

/** "HH:MM:SS" (anche oltre le 24) → secondi; null se illeggibile. */
export function secondi(hms: string | null | undefined): number | null {
  if (typeof hms !== "string") return null;
  const m = hms.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

export function hhmm(s: number | null): string | null {
  if (s == null || !Number.isFinite(s)) return null;
  const t = Math.round(s / 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

const minuti = (s: number | null): number | null => (s == null ? null : Math.round(s / 6) / 10);

/** Il tipo di giorno di esercizio di una data (YYYY-MM-DD). */
export function tipoDelGiorno(ymd: string): TipoGiorno {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (italianHolidays(d.getUTCFullYear()).has(ymd) || d.getUTCDay() === 0) return "festivo";
  return d.getUTCDay() === 6 ? "sabato" : "feriale";
}

/** Le date degli ultimi `giorni` giorni (fino a ieri compreso) di quel tipo. */
export function giorniOsservati(tipo: TipoGiorno, oggi: string, giorni: number): string[] {
  const out: string[] = [];
  const base = new Date(`${oggi}T00:00:00Z`).getTime();
  for (let i = 1; i <= giorni; i++) {
    const ymd = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
    if (tipoDelGiorno(ymd) === tipo) out.push(ymd);
  }
  return out;
}

/** Il tipo di giorno da osservare per un giorno-tipo del progetto. */
export function tipoPerGiornoTipo(codice: string | null | undefined): TipoGiorno {
  const c = String(codice ?? "").toLowerCase();
  if (c.includes("fest") || c.includes("domen")) return "festivo";
  if (c.includes("sab")) return "sabato";
  return "feriale";
}

/* ── Le statistiche osservate ─────────────────────────────────────────── */

export interface StatTratto {
  n: number; giorni: number; medianaS: number; p85S: number;
  /** la sosta di regolazione tolta dal tratto (calcolo unico, tratte-osservate) */
  sosta?: { corse: number; medianaS: number } | null;
}

/** Da dove viene il numero usato per un tratto: l'ora della corsa, la sua
 *  fascia oraria (punta, morbida…) o tutta la giornata. */
export type FonteTratto = "ora" | "fascia" | "giornata";

/** Statistiche per coppia (da→a): per ora di partenza dalla prima fermata,
 *  per fascia oraria e su tutta la giornata. Chiave: `${da}>${a}`. */
export class Osservato {
  private perOra = new Map<string, StatTratto>();
  private perFascia = new Map<string, StatTratto>();
  private perGiorno = new Map<string, StatTratto>();
  aggiungi(da: string, a: string, ora: number | null, s: StatTratto): void {
    if (ora == null) this.perGiorno.set(`${da}>${a}`, s);
    else this.perOra.set(`${da}>${a}@${ora}`, s);
  }
  aggiungiFascia(da: string, a: string, fascia: string, s: StatTratto): void {
    this.perFascia.set(`${da}>${a}#${fascia}`, s);
  }
  /** La statistica da usare per un tratto percorso a quell'ora: quella
   *  dell'ora se ha abbastanza campioni, poi quella della sua fascia oraria
   *  (le ore di punta non si confondono con la morbida), e solo in ultimo
   *  quella della giornata. */
  per(da: string | null, a: string | null, ora: number | null): (StatTratto & { fonte: FonteTratto }) | null {
    if (!da || !a) return null;
    if (ora != null) {
      const h = this.perOra.get(`${da}>${a}@${ora}`);
      if (h && h.n >= CAMPIONI_MINIMI) return { ...h, fonte: "ora" };
      const f = this.perFascia.get(`${da}>${a}#${fasciaDi(ora)}`);
      if (f && f.n >= CAMPIONI_MINIMI) return { ...f, fonte: "fascia" };
    }
    const g = this.perGiorno.get(`${da}>${a}`);
    return g && g.n >= CAMPIONI_MINIMI ? { ...g, fonte: "giornata" } : null;
  }
  /** Vero se la coppia ha abbastanza campioni sulla giornata. */
  haDati(da: string | null, a: string | null): boolean {
    if (!da || !a) return false;
    const g = this.perGiorno.get(`${da}>${a}`);
    return !!g && g.n >= CAMPIONI_MINIMI;
  }
  /** Prende da un'altra osservazione (il ripiego sui feriali) le coppie che
   *  qui non hanno dati sulla giornata, con le loro ore e fasce. Restituisce
   *  le coppie prese, `${da}>${a}`: chi le usa le deve dichiarare. */
  assorbi(altro: Osservato): Set<string> {
    const prese = new Set<string>();
    for (const [k, g] of altro.perGiorno) {
      if (g.n < CAMPIONI_MINIMI) continue;
      const qui = this.perGiorno.get(k);
      if (qui && qui.n >= CAMPIONI_MINIMI) continue;
      this.perGiorno.set(k, g);
      prese.add(k);
    }
    for (const [k, v] of altro.perOra) if (prese.has(k.slice(0, k.lastIndexOf("@")))) this.perOra.set(k, v);
    for (const [k, v] of altro.perFascia) if (prese.has(k.slice(0, k.lastIndexOf("#")))) this.perFascia.set(k, v);
    return prese;
  }
  giornata(da: string | null, a: string | null): StatTratto | null {
    if (!da || !a) return null;
    return this.perGiorno.get(`${da}>${a}`) ?? null;
  }
  /** La fascia oraria in cui il tratto va peggio rispetto al programmato. */
  oraPeggiore(da: string | null, a: string | null, programmatoS: number): { ora: number; medianaS: number; n: number } | null {
    if (!da || !a) return null;
    let peggio: { ora: number; medianaS: number; n: number } | null = null;
    for (let ora = 0; ora < 30; ora++) {
      const h = this.perOra.get(`${da}>${a}@${ora}`);
      if (!h || h.n < CAMPIONI_MINIMI) continue;
      if (!peggio || h.medianaS - programmatoS > peggio.medianaS - programmatoS) peggio = { ora, medianaS: h.medianaS, n: h.n };
    }
    return peggio;
  }
}

/* ── Le corse del progetto ────────────────────────────────────────────── */

export interface FermataCorsa {
  stopId: string; gtfsId: string | null; nome: string; clusterId: string | null;
  lat: number | null; lon: number | null;
  arrivoS: number | null; partenzaS: number | null;
}
export interface CorsaProgetto {
  tripId: string; variantId: string; direzione: number | null;
  fermate: FermataCorsa[];
}

const orario = (f: FermataCorsa, verso: "arrivo" | "partenza") =>
  verso === "arrivo" ? (f.arrivoS ?? f.partenzaS) : (f.partenzaS ?? f.arrivoS);

function metri(a: FermataCorsa, b: FermataCorsa): number {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return Infinity;
  const k = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * 111_195, (a.lon - b.lon) * 111_195 * k);
}
export function stessoCapolinea(a: FermataCorsa, b: FermataCorsa): boolean {
  return a.stopId === b.stopId || (!!a.clusterId && a.clusterId === b.clusterId) || metri(a, b) <= STESSO_CAPOLINEA_M;
}

export type Giudizio = "assorbe" | "al_limite" | "insufficiente" | "rientro" | "senza_dati";

export interface EsitoCorsa {
  tripId: string; variantId: string; direzione: number | null;
  partenza: string | null; arrivo: string | null; da: string; a: string;
  programmatoMin: number | null;
  realeMedianoMin: number | null; realeP85Min: number | null;
  ritardoMedianoMin: number | null; ritardoP85Min: number | null;
  /** quota del tempo programmato coperta da tratti con dati reali */
  coperturaPct: number;
  deltaFinaleMin: number | null; prossimaPartenza: string | null; prossimaCorsa: string | null;
  /** il delta che resta dopo il ritardo (mediano e 85°): negativo = la corsa dopo parte in ritardo */
  restoMedianoMin: number | null; restoP85Min: number | null;
  giudizio: Giudizio;
}

/** Il ritardo atteso di una corsa: somma dei tratti all'ora in cui li fa.
 *  Un tratto senza dati vale il suo programmato (scarto zero) e abbassa la
 *  copertura, che si dichiara. */
export function ritardoCorsa(c: CorsaProgetto, oss: Osservato): {
  programmatoS: number | null; medianoS: number | null; p85S: number | null; coperturaPct: number;
} {
  const fs = c.fermate;
  if (fs.length < 2) return { programmatoS: null, medianoS: null, p85S: null, coperturaPct: 0 };
  let prog = 0, med = 0, coperto = 0, dSomma = 0, dQuadr = 0;
  for (let i = 0; i + 1 < fs.length; i++) {
    const dep = orario(fs[i], "partenza"), arr = orario(fs[i + 1], "arrivo");
    if (dep == null || arr == null) continue;
    const p = Math.max(0, arr - dep);
    prog += p;
    const s = oss.per(fs[i].gtfsId, fs[i + 1].gtfsId, Math.floor(dep / 3600) % 24);
    if (s) {
      med += s.medianaS; coperto += p;
      const d = Math.max(0, s.p85S - s.medianaS);
      dSomma += d; dQuadr += d * d;
    } else med += p;
  }
  // l'85° della corsa: la mediana più lo scarto dei tratti, combinati con
  // la correlazione dichiarata (fra la quadratura e la somma piena)
  const p85 = med + Math.sqrt((1 - CORRELAZIONE_TRATTI) * dQuadr + CORRELAZIONE_TRATTI * dSomma * dSomma);
  const tot = (orario(fs[fs.length - 1], "arrivo") ?? 0) - (orario(fs[0], "partenza") ?? 0);
  const programmatoS = tot > 0 ? tot : prog;
  return {
    programmatoS,
    medianoS: med, p85S: p85,
    coperturaPct: prog > 0 ? Math.round((coperto / prog) * 100) : 0,
  };
}

export function giudica(deltaS: number | null, ritMedS: number | null, ritP85S: number | null, coperturaPct: number): Giudizio {
  if (deltaS == null) return "rientro";
  if (coperturaPct === 0 || ritMedS == null || ritP85S == null) return "senza_dati";
  if (deltaS - Math.max(0, ritP85S) >= MARGINE_S) return "assorbe";
  if (deltaS - Math.max(0, ritMedS) >= MARGINE_S) return "al_limite";
  return "insufficiente";
}

/** Per ogni corsa il delta finale (fino alla prossima partenza della linea
 *  dallo stesso capolinea), il ritardo atteso e il giudizio. */
export function esitiCorse(corse: CorsaProgetto[], oss: Osservato): EsitoCorsa[] {
  const partenze = corse
    .filter(c => c.fermate.length >= 2 && orario(c.fermate[0], "partenza") != null)
    .map(c => ({ c, dep: orario(c.fermate[0], "partenza")!, prima: c.fermate[0] }))
    .sort((x, y) => x.dep - y.dep);
  return corse
    .filter(c => c.fermate.length >= 2)
    .map(c => {
      const ultima = c.fermate[c.fermate.length - 1];
      const arr = orario(ultima, "arrivo");
      const dep0 = orario(c.fermate[0], "partenza");
      const r = ritardoCorsa(c, oss);
      const ritMed = r.medianoS != null && r.programmatoS != null ? r.medianoS - r.programmatoS : null;
      const ritP85 = r.p85S != null && r.programmatoS != null ? r.p85S - r.programmatoS : null;
      const dopo = arr == null ? undefined : partenze.find(p =>
        p.c.tripId !== c.tripId && p.dep >= arr - ANTICIPO_MAX_S && p.dep - arr <= ATTESA_MAX_S && stessoCapolinea(ultima, p.prima));
      const delta = dopo && arr != null ? dopo.dep - arr : null;
      const giudizio = giudica(delta, ritMed, ritP85, r.coperturaPct);
      return {
        tripId: c.tripId, variantId: c.variantId, direzione: c.direzione,
        partenza: hhmm(dep0), arrivo: hhmm(arr), da: c.fermate[0].nome, a: ultima.nome,
        programmatoMin: minuti(r.programmatoS),
        realeMedianoMin: r.coperturaPct > 0 ? minuti(r.medianoS) : null,
        realeP85Min: r.coperturaPct > 0 ? minuti(r.p85S) : null,
        ritardoMedianoMin: r.coperturaPct > 0 ? minuti(ritMed) : null,
        ritardoP85Min: r.coperturaPct > 0 ? minuti(ritP85) : null,
        coperturaPct: r.coperturaPct,
        deltaFinaleMin: minuti(delta),
        prossimaPartenza: dopo ? hhmm(dopo.dep) : null,
        prossimaCorsa: dopo ? dopo.c.tripId : null,
        restoMedianoMin: delta != null && ritMed != null && r.coperturaPct > 0 ? minuti(delta - Math.max(0, ritMed)) : null,
        restoP85Min: delta != null && ritP85 != null && r.coperturaPct > 0 ? minuti(delta - Math.max(0, ritP85)) : null,
        giudizio,
      };
    })
    .sort((x, y) => (x.partenza ?? "").localeCompare(y.partenza ?? ""));
}

/* ── Per percorso: tratti e nodi ──────────────────────────────────────── */

export interface Tratto {
  seq: number; da: string; a: string;
  programmatoS: number | null;
  reale: StatTratto | null;
  scartoMedianoS: number | null; scartoP85S: number | null;
  oraPeggiore: { ora: number; medianaS: number; scartoS: number; n: number } | null;
}
export interface Nodo {
  seq: number; fermata: string;
  programmatoMin: number | null; realeMin: number | null; scartoMin: number | null;
}

const mediana = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** I tratti e i nodi di un percorso: il programmato è la mediana fra le sue
 *  corse (gli orari possono cambiare per fascia), il reale è la giornata. */
export function trattiENodi(corse: CorsaProgetto[], oss: Osservato): { tratti: Tratto[]; nodi: Nodo[]; coperturaPct: number } {
  const ref = corse.reduce<CorsaProgetto | null>((m, c) => (!m || c.fermate.length > m.fermate.length ? c : m), null);
  if (!ref || ref.fermate.length < 2) return { tratti: [], nodi: [], coperturaPct: 0 };
  const fs = ref.fermate;
  const tratti: Tratto[] = [];
  let conDati = 0;
  for (let i = 0; i + 1 < fs.length; i++) {
    const programmi: number[] = [];
    for (const c of corse) {
      if (c.fermate.length !== fs.length || c.fermate[i].stopId !== fs[i].stopId || c.fermate[i + 1].stopId !== fs[i + 1].stopId) continue;
      const dep = orario(c.fermate[i], "partenza"), arr = orario(c.fermate[i + 1], "arrivo");
      if (dep != null && arr != null) programmi.push(Math.max(0, arr - dep));
    }
    const prog = mediana(programmi);
    const g = oss.giornata(fs[i].gtfsId, fs[i + 1].gtfsId);
    const reale = g && g.n >= CAMPIONI_MINIMI ? g : null;
    if (reale) conDati++;
    const peggio = prog != null ? oss.oraPeggiore(fs[i].gtfsId, fs[i + 1].gtfsId, prog) : null;
    tratti.push({
      seq: i + 1, da: fs[i].nome, a: fs[i + 1].nome,
      programmatoS: prog,
      reale,
      scartoMedianoS: reale && prog != null ? Math.round(reale.medianaS - prog) : null,
      scartoP85S: reale && prog != null ? Math.round(reale.p85S - prog) : null,
      oraPeggiore: peggio && prog != null ? { ...peggio, scartoS: Math.round(peggio.medianaS - prog) } : null,
    });
  }
  const nodi: Nodo[] = [{ seq: 1, fermata: fs[0].nome, programmatoMin: 0, realeMin: 0, scartoMin: 0 }];
  let p = 0, r = 0;
  for (const t of tratti) {
    p += t.programmatoS ?? 0;
    r += t.reale ? t.reale.medianaS : (t.programmatoS ?? 0);
    nodi.push({ seq: t.seq + 1, fermata: t.a, programmatoMin: minuti(p), realeMin: minuti(r), scartoMin: minuti(r - p) });
  }
  return { tratti, nodi, coperturaPct: tratti.length ? Math.round((conDati / tratti.length) * 100) : 0 };
}

export interface Riepilogo {
  corse: number; assorbe: number; al_limite: number; insufficiente: number; rientro: number; senza_dati: number;
  ritardoMedianoMaxMin: number | null; deltaMinimoMin: number | null;
  nota: string;
}

export function riepilogoCorse(esiti: EsitoCorsa[]): Riepilogo {
  const conta = (g: Giudizio) => esiti.filter(e => e.giudizio === g).length;
  const ritardi = esiti.map(e => e.ritardoMedianoMin).filter((x): x is number => x != null);
  const delta = esiti.map(e => e.deltaFinaleMin).filter((x): x is number => x != null);
  const r: Riepilogo = {
    corse: esiti.length, assorbe: conta("assorbe"), al_limite: conta("al_limite"),
    insufficiente: conta("insufficiente"), rientro: conta("rientro"), senza_dati: conta("senza_dati"),
    ritardoMedianoMaxMin: ritardi.length ? Math.max(...ritardi) : null,
    deltaMinimoMin: delta.length ? Math.min(...delta) : null,
    nota: "",
  };
  r.nota = r.insufficiente
    ? `${r.insufficiente} corse con un delta finale che non assorbe nemmeno il ritardo tipico: la corsa dopo parte in ritardo.`
    : r.al_limite
      ? `${r.al_limite} corse al limite: il delta regge il ritardo tipico ma non le giornate peggiori (85°).`
      : r.assorbe
        ? "Il delta finale assorbe il ritardo anche nelle giornate peggiori (85°)."
        : "Nessuna corsa con dati reali e corsa successiva da confrontare.";
  return r;
}
