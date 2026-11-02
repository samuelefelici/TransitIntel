/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ANDAMENTO DELL'AVM — settimana per settimana, dall'inizio dei dati
 * ───────────────────────────────────────────────────────────────────────────
 * Il controllo settimanale guarda otto settimane e risponde a «chi ha
 * ripreso, chi si è fermato». Mentre si sistemano gli apparati serve anche
 * la vista lunga: come va il parco da quando lo si osserva, e per ogni
 * vettura che cosa c'è da fare. Le azioni sono quattro, con quattro
 * destinatari diversi:
 *
 *   da riparare            l'apparato non si localizza   → officina / Mizar
 *   da togliere da SIRI    l'officina non ha più il mezzo → Mizar (anagrafica)
 *   da aggiungere a SIRI   il mezzo c'è, il centro no     → Mizar (anagrafica)
 *   da verificare          muta da settimane, ma per l'officina è in servizio:
 *                          guasta o alienata?             → officina
 *
 * Il metro è lo stesso del controllo settimanale (statoSettimana in
 * avm-controllo.ts): una vettura funziona in una settimana se si è
 * localizzata in almeno una giornata contata. Le due viste non possono dire
 * cose diverse sulla stessa settimana: lo controlla un test di parità.
 *
 * Il perimetro è il parco di OGGI: chi FleetCare dà fuori parco o dismessa
 * adesso esce da tutte le settimane, così il denominatore resta lo stesso e
 * la crescita delle vetture che si localizzano misura i lavori, non il parco
 * che cambia.
 *
 * Le richieste a Mizar (togliere, aggiungere) si chiudono da sole quando il
 * diario mostra la vettura sparita dal flusso o comparsa: verificaRichieste.
 *
 * Si misura l'apparato, non le persone: niente turni, niente conducenti.
 *
 * Funzioni pure: niente database, niente rete (vedi __tests__/avm-storia.test.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { CAMPIONI_MINIMI_GIORNATA, GIORNATE_MINIME, esclusioneOfficina, type Esclusione } from "./avm-diario.js";
import {
  ETICHETTE_ESITO_INTERVENTO, giudicaIntervento, lunediDi, notaOfficina, spostaGiorni, statoSettimana,
  type InterventoAvm, type InterventoGiudicato, type StatoSettimana,
} from "./avm-controllo.js";
import { giornateDelPeriodo } from "./fleet-trend.js";
import { identitaVettura } from "./parco-anagrafica.js";
import type { MezzoOfficina, ParcoOfficina } from "./officina.js";

/* ── Le soglie ─────────────────────────────────────────────────────────── */

/** Quante settimane si guardano al massimo: un anno. */
export const SETTIMANE_MASSIME = 52;
/** Le ultime settimane giudicabili in cui si contano i cambi di stato. */
export const SETTIMANE_INSTABILITA = 6;
/** Da quanti cambi F ↔ non F in quelle settimane una vettura è instabile. */
export const CAMBI_INSTABILE = 2;
/** Una vettura tornata a localizzarsi resta «riparata» per queste settimane. */
export const SETTIMANE_RIPARATA = 8;
/** Muta o assente da tante settimane, e in servizio per l'officina: guasta o alienata? */
export const SETTIMANE_SILENZIO_ALIENATA = 4;
/** Giornate contate di assenza dal flusso dopo una richiesta «togliere» per darla fatta. */
export const GIORNATE_ASSENZA_TOLTA = 3;
/** Una richiesta a Mizar aperta da più giorni di così va sollecitata. */
export const GIORNI_SOLLECITO_MIZAR = 14;
/** Le richieste chiuse si mostrano per tanti giorni, poi restano solo nel database. */
export const GIORNI_RICHIESTE_CHIUSE = 90;
/** Le richieste chiuse si cancellano dopo tanti mesi. */
export const MESI_CONSERVAZIONE_RICHIESTE = 24;

export const SOGLIE = {
  settimaneMassime: SETTIMANE_MASSIME,
  settimaneInstabilita: SETTIMANE_INSTABILITA,
  cambiInstabile: CAMBI_INSTABILE,
  settimaneRiparata: SETTIMANE_RIPARATA,
  settimaneSilenzioAlienata: SETTIMANE_SILENZIO_ALIENATA,
  giornateAssenzaTolta: GIORNATE_ASSENZA_TOLTA,
  giorniSollecitoMizar: GIORNI_SOLLECITO_MIZAR,
  giornateMinime: GIORNATE_MINIME,
} as const;

/* ── Il vocabolario ────────────────────────────────────────────────────── */

export type Azione =
  | "da_riparare"
  | "da_togliere_da_siri"
  | "da_aggiungere_a_siri"
  | "da_verificare_alienata"
  | "instabile"
  | "riparata"
  | "funziona"
  | "non_giudicabile"
  | "gia_tolta";

/** L'ordine di lettura: prima quello che c'è da fare. */
export const ORDINE_AZIONI: Azione[] = [
  "da_riparare", "da_togliere_da_siri", "da_aggiungere_a_siri", "da_verificare_alienata",
  "instabile", "riparata", "funziona", "non_giudicabile", "gia_tolta",
];

export const ETICHETTE_AZIONE: Record<Azione, { titolo: string; breve: string; perche: string }> = {
  da_riparare: {
    titolo: "Da riparare", breve: "Da riparare",
    perche: "Nell'ultima settimana chiusa l'apparato non si è localizzato in nessuna giornata contata.",
  },
  da_togliere_da_siri: {
    titolo: "Da togliere da SIRI", breve: "Da togliere",
    perche: "L'officina non ha più il mezzo, o lo dà dismesso, ma il flusso SIRI lo elenca ancora: "
      + "va tolto dall'anagrafica del centro Mizar, non riparato.",
  },
  da_aggiungere_a_siri: {
    titolo: "Da aggiungere a SIRI", breve: "Da aggiungere",
    perche: "Il mezzo è nel parco dell'officina ma non è mai comparso nel flusso SIRI: "
      + "va censito a Mizar, o manca l'apparato a bordo.",
  },
  da_verificare_alienata: {
    titolo: "Da verificare: guasta o alienata?", breve: "Da verificare",
    perche: `Muta o assente da almeno ${SETTIMANE_SILENZIO_ALIENATA} settimane, ma l'officina la dà in servizio `
      + "senza fermi né segnalazioni: o l'apparato è guasto, o il mezzo non c'è più e FleetCare non è aggiornato.",
  },
  instabile: {
    titolo: "Instabile", breve: "Instabile",
    perche: `Si localizza, ma nelle ultime ${SETTIMANE_INSTABILITA} settimane è passata più volte fra funzionare e no.`,
  },
  riparata: {
    titolo: "Riparata", breve: "Riparata",
    perche: `È tornata a localizzarsi nelle ultime ${SETTIMANE_RIPARATA} settimane, dopo un periodo senza posizione.`,
  },
  funziona: {
    titolo: "Funziona", breve: "Funziona",
    perche: "Si localizza nell'ultima settimana chiusa, senza cambi recenti.",
  },
  non_giudicabile: {
    titolo: "Non giudicabile", breve: "Non giudicabile",
    perche: "Nessuna settimana chiusa con abbastanza giornate contate da quando compare.",
  },
  gia_tolta: {
    titolo: "Già tolta dal flusso", breve: "Già tolta",
    perche: "Fuori parco o dismessa, e il flusso SIRI non la elenca più.",
  },
};

export type TipoRichiesta = "togliere" | "aggiungere";

export interface RichiestaMizar {
  id: string;
  vehicleRef: string;
  tipo: TipoRichiesta;
  /** "YYYY-MM-DD" */
  richiestaIl: string;
  nota: string | null;
  creataIl: string;
  /** il nome di chi l'ha segnata, se lo si sa (mai l'id) */
  creataDa: string | null;
  esito: "fatta" | "annullata" | null;
  chiusaIl: string | null;
  /** il nome di chi l'ha chiusa a mano; null con esito «fatta» = verificata da Cerbero */
  chiusaDa: string | null;
  /** chiusa da Cerbero guardando il diario */
  automatica: boolean;
}

export interface RichiestaVista extends RichiestaMizar {
  /** giorni da quando è partita, fino a oggi o alla chiusura */
  giorniAttesa: number;
  /** una vettura «tolta» che il flusso elenca di nuovo: il primo giorno */
  ricomparsaIl: string | null;
  sollecitare: boolean;
}

export interface SettimanaStoria {
  lunedi: string;
  domenica: string;
  giornateContate: number;
  chiusa: boolean;
}

export interface VetturaStoria {
  vehicleRef: string;
  codice: string | null;
  azienda: string;
  mezzo: string | null;
  /** un carattere per settimana di `settimane`: F P M A . (come il controllo settimanale) */
  storia: string;
  /** primo e ultimo giorno in cui il flusso SIRI la elenca; null se mai */
  primoGiorno: string | null;
  ultimoGiorno: string | null;
  /** elencata dal flusso nelle ultime giornate contate */
  inSiri: boolean;
  ultimaPosizione: string | null;
  ultimoContatto: string | null;
  /** settimane chiuse giudicabili di fila, fino all'ultima, senza posizione; null se mai elencata */
  settimaneSenzaPosizione: number | null;
  /** la prima giornata contata senza posizione dopo l'ultima posizione */
  senzaPosizioneDal: string | null;
  /** settimane chiuse giudicabili di fila, fino all'ultima, senza contatto (mute o assenti) */
  settimaneSilenzio: number;
  /** cambi F ↔ non F nelle ultime SETTIMANE_INSTABILITA settimane giudicabili */
  cambi: number;
  /** riparata: la prima giornata con posizione dopo il periodo senza */
  riparataDal: string | null;
  /** da riparare, ma nella settimana in corso si è già localizzata: il giorno */
  posizioneInSettimana: string | null;
  officina: MezzoOfficina | null;
  /** solo fuori parco e dismesse */
  esclusa: Esclusione | null;
  ultimoIntervento: InterventoGiudicato | null;
  interventi: number;
  azione: Azione;
  /** da riparare ma anche instabile */
  instabile: boolean;
  perche: string;
  /** la richiesta a Mizar aperta per la vettura, o l'ultima chiusa */
  richiesta: RichiestaVista | null;
}

export interface StoriaAvm {
  generatoIl: string;
  oggi: string;
  /** il lunedì della prima settimana con dati */
  inizio: string;
  /** il lunedì dell'ultima settimana chiusa */
  ultimaChiusa: string;
  /** dalla più vecchia; l'ultima è la settimana in corso */
  settimane: SettimanaStoria[];
  vetture: VetturaStoria[];
  conteggi: Record<Azione, number>;
  richieste: RichiestaVista[];
}

/** Le giornate di una vettura nel diario, compresse: un carattere per giorno. */
export interface PresenzaVettura {
  vehicleRef: string;
  /** "YYYY-MM-DD", in ordine */
  giorni: string[];
  /** stessa lunghezza di `giorni`: '0'..'3', bit 0 posizione, bit 1 contatto */
  esiti: string;
}

export interface DatiStoria {
  /** giornata di esercizio di oggi */
  oggi: string;
  /** il lunedì da cui guardare */
  inizio: string;
  generatoIl?: string;
  /** per giornata, il massimo dei campioni fra le vetture (quanta raccolta ha avuto) */
  campioni: ReadonlyMap<string, number>;
  vetture: PresenzaVettura[];
  /** il parco dell'officina, già passato da parcoCredibile; null o non disponibile = senza officina */
  parco: ParcoOfficina | null;
  interventi: InterventoAvm[] | null;
  richieste: RichiestaMizar[];
}

/* ── Le date ───────────────────────────────────────────────────────────── */

function ddmm(g: string | null): string {
  if (!g) return "";
  const [, m, d] = g.split("-");
  return `${d}/${m}`;
}
function ddmmyyyy(g: string | null): string {
  return g ? g.slice(0, 10).split("-").reverse().join("/") : "";
}
function giorniFra(da: string, a: string): number {
  return Math.round((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${da}T00:00:00Z`).getTime()) / 86_400_000);
}
function settimane(n: number): string {
  return `${n} ${n === 1 ? "settimana" : "settimane"}`;
}

const CONEROBUS = /^\d{1,4}$/;
export const eConerobus = (ref: string) => CONEROBUS.test(ref);

/* ── Le richieste a Mizar ──────────────────────────────────────────────── */

/**
 * Le richieste aperte che il diario mostra già fatte, con il giorno in cui
 * lo mostra (non il momento del controllo: rifarlo più tardi non cambia
 * niente).
 *   aggiungere: il primo giorno, dalla richiesta, in cui il flusso la elenca;
 *   togliere:   GIORNATE_ASSENZA_TOLTA giornate contate senza la vettura dopo
 *               la richiesta e dopo l'ultima volta che c'era; il giorno è la
 *               prima di quelle giornate. Un connettore fermo non chiude
 *               niente: senza raccolta non ci sono giornate contate.
 */
export function verificaRichieste(
  aperte: Array<Pick<RichiestaMizar, "id" | "vehicleRef" | "tipo" | "richiestaIl" | "esito">>,
  presenze: ReadonlyMap<string, string[]>,
  contate: string[],
  oggi: string,
): Array<{ id: string; chiusaIl: string }> {
  const out: Array<{ id: string; chiusaIl: string }> = [];
  for (const r of aperte) {
    if (r.esito != null) continue;
    const giorni = presenze.get(r.vehicleRef) ?? [];
    if (r.tipo === "aggiungere") {
      const primo = giorni.find(g => g >= r.richiestaIl && g <= oggi);
      if (primo) out.push({ id: r.id, chiusaIl: primo });
    } else {
      const ultimo = giorni.at(-1) ?? null;
      const assenti = contate.filter(g => g >= r.richiestaIl && (ultimo == null || g > ultimo));
      if (assenti.length >= GIORNATE_ASSENZA_TOLTA) out.push({ id: r.id, chiusaIl: assenti[0] });
    }
  }
  return out;
}

/** La richiesta come la vede la pagina: da quanto aspetta, se la vettura è ricomparsa. */
export function vediRichiesta(r: RichiestaMizar, giorni: string[], oggi: string): RichiestaVista {
  const fine = r.chiusaIl ?? oggi;
  const giorniAttesa = Math.max(0, giorniFra(r.richiestaIl, fine));
  const ricomparsaIl = r.tipo === "togliere" && r.esito === "fatta" && r.chiusaIl
    ? giorni.find(g => g > r.chiusaIl!) ?? null
    : null;
  return { ...r, giorniAttesa, ricomparsaIl, sollecitare: r.esito == null && giorniAttesa > GIORNI_SOLLECITO_MIZAR };
}

/* ── I testi per Mizar ─────────────────────────────────────────────────── */

export interface TestoMizar {
  oggetto: string;
  testo: string;
  matricole: string[];
}

/** La richiesta di togliere vetture dall'anagrafica del centro (stesse parole del diario). */
export function richiestaTogliere(matricole: string[]): TestoMizar {
  const una = matricole.length === 1;
  return {
    oggetto: `AVM Conerobus — vetture da togliere dall'anagrafica del centro (${matricole.length})`,
    testo: una
      ? "Nel canale SIRI compare 1 matricola Conerobus che il parco dell'officina non ha più, o che dà "
        + "per dismessa. Non è un apparato da riparare: chiediamo di toglierla dall'anagrafica del centro, "
        + `così che non risulti come vettura muta.\n\nMatricola: ${matricole[0]}.`
      : `Nel canale SIRI compaiono ${matricole.length} matricole Conerobus che il parco `
        + "dell'officina non ha più, o che dà per dismesse. Non sono apparati da riparare: "
        + "chiediamo di toglierle dall'anagrafica del centro, così che non risultino come "
        + `vetture mute.\n\nMatricole: ${matricole.join(", ")}.`,
    matricole,
  };
}

/** La richiesta di censire vetture del parco che il centro non conosce (stesse parole del diario). */
export function richiestaAggiungere(mezzi: MezzoOfficina[], periodo: string): TestoMizar {
  return {
    oggetto: `AVM Conerobus — vetture del parco che il centro non conosce (${mezzi.length})`,
    testo: (mezzi.length === 1
      ? `1 vettura del parco Conerobus non è mai comparsa nel canale SIRI ${periodo}. Chiediamo di `
        + "verificare se ha l'apparato a bordo e se è censita nell'anagrafica del centro.\n\n"
      : `${mezzi.length} vetture del parco Conerobus non sono mai comparse nel canale SIRI `
        + `${periodo}. Chiediamo di verificare se hanno l'apparato a bordo e se sono censite `
        + "nell'anagrafica del centro.\n\n")
      + mezzi.map(m => `${m.matricola} (${m.targa}${m.modello ? `, ${m.modello}` : ""}`
        + `${m.deposito ? `, ${m.deposito}` : ""})`).join("\n"),
    matricole: mezzi.map(m => m.matricola),
  };
}

/** I due testi, solo per le vetture senza una richiesta già aperta dello stesso tipo. */
export function testiMizar(s: Pick<StoriaAvm, "vetture" | "settimane" | "oggi">): {
  togliere: TestoMizar | null; aggiungere: TestoMizar | null;
} {
  const senzaRichiesta = (v: VetturaStoria, tipo: TipoRichiesta) =>
    !(v.richiesta && v.richiesta.esito == null && v.richiesta.tipo === tipo);
  const togliere = s.vetture.filter(v => v.azione === "da_togliere_da_siri" && senzaRichiesta(v, "togliere"));
  const aggiungere = s.vetture.filter(v => v.azione === "da_aggiungere_a_siri" && v.officina && senzaRichiesta(v, "aggiungere"));
  const primo = s.settimane.find(w => w.giornateContate > 0)?.lunedi ?? s.oggi;
  const periodo = `dal ${ddmmyyyy(primo)} al ${ddmmyyyy(s.oggi)}`;
  return {
    togliere: togliere.length ? richiestaTogliere(togliere.map(v => v.vehicleRef)) : null,
    aggiungere: aggiungere.length ? richiestaAggiungere(aggiungere.map(v => v.officina!), periodo) : null,
  };
}

/* ── Il calcolo ────────────────────────────────────────────────────────── */

const POSIZIONE = 1;
const CONTATTO = 2;

function vuoti(): Record<Azione, number> {
  return Object.fromEntries(ORDINE_AZIONI.map(a => [a, 0])) as Record<Azione, number>;
}

export function contaAzioni(vetture: Array<Pick<VetturaStoria, "azione">>): Record<Azione, number> {
  const c = vuoti();
  for (const v of vetture) c[v.azione]++;
  return c;
}

/**
 * L'andamento per settimana sulle vetture passate: quante si localizzavano,
 * parlavano soltanto, tacevano, mancavano dal flusso. Una vettura conta solo
 * dalla settimana in cui compare per la prima volta.
 */
export function andamentoStoria(
  s: Pick<StoriaAvm, "settimane">, vetture: Array<Pick<VetturaStoria, "storia" | "primoGiorno">>,
): Array<SettimanaStoria & { F: number; P: number; M: number; A: number }> {
  return s.settimane.map((w, i) => {
    const n = { F: 0, P: 0, M: 0, A: 0 };
    for (const v of vetture) {
      if (!v.primoGiorno || lunediDi(v.primoGiorno) > w.lunedi) continue;
      const ch = v.storia[i] as StatoSettimana | undefined;
      if (ch === "F" || ch === "P" || ch === "M" || ch === "A") n[ch]++;
    }
    return { ...w, ...n };
  });
}

export function calcolaStoria(dati: DatiStoria): StoriaAvm {
  const { oggi, campioni } = dati;
  const lunediOggi = lunediDi(oggi);
  const ultimaChiusa = spostaGiorni(lunediOggi, -7);
  const primoLunedi = lunediDi(dati.inizio) > lunediOggi ? lunediOggi : lunediDi(dati.inizio);

  const contata = (g: string) => g < oggi && (campioni.get(g) ?? 0) >= CAMPIONI_MINIMI_GIORNATA;

  /* Le settimane, dalla prima con almeno una giornata contata (prima non c'era il diario). */
  let lunedi: string[] = [];
  for (let l = primoLunedi; l <= lunediOggi; l = spostaGiorni(l, 7)) lunedi.push(l);
  const giorniDi = new Map(lunedi.map(l => [l, giornateDelPeriodo(l, spostaGiorni(l, 6))]));
  const contateDi = new Map(lunedi.map(l => [l, giorniDi.get(l)!.filter(contata)]));
  const primaConDati = lunedi.findIndex(l => contateDi.get(l)!.length > 0);
  lunedi = primaConDati < 0 ? [lunediOggi] : lunedi.slice(primaConDati);
  const settimaneStoria: SettimanaStoria[] = lunedi.map(l => ({
    lunedi: l, domenica: spostaGiorni(l, 6), giornateContate: contateDi.get(l)!.length, chiusa: l <= ultimaChiusa,
  }));
  const tutteContate = lunedi.flatMap(l => contateDi.get(l)!);
  const inizioDati = tutteContate[0] ?? lunedi[0];
  const ultimeContate = tutteContate.slice(-GIORNATE_ASSENZA_TOLTA);

  const parco = dati.parco?.disponibile ? dati.parco : null;
  const perMatricola = new Map((parco?.mezzi ?? []).map(m => [m.matricola, m]));

  /* Gli interventi per matricola, chiusi nel periodo guardato. */
  const interventiPer = new Map<string, InterventoAvm[]>();
  for (const i of dati.interventi ?? []) {
    const l = interventiPer.get(i.matricola) ?? [];
    l.push(i);
    interventiPer.set(i.matricola, l);
  }

  /* Le richieste per vettura: la aperta, se c'è, altrimenti l'ultima chiusa. */
  const presenze = new Map(dati.vetture.map(v => [v.vehicleRef, v.giorni]));
  const richieste = dati.richieste
    .map(r => vediRichiesta(r, presenze.get(r.vehicleRef) ?? [], oggi))
    .sort((a, b) => (a.esito == null ? 0 : 1) - (b.esito == null ? 0 : 1)
      || b.richiestaIl.localeCompare(a.richiestaIl) || b.creataIl.localeCompare(a.creataIl));
  const richiestaDi = new Map<string, RichiestaVista>();
  for (const r of richieste) if (!richiestaDi.has(r.vehicleRef)) richiestaDi.set(r.vehicleRef, r);

  /* Le vetture: quelle del flusso, più quelle del parco mai comparse. */
  const elenco: PresenzaVettura[] = [...dati.vetture];
  const viste = new Set(dati.vetture.map(v => v.vehicleRef));
  for (const m of parco?.mezzi ?? []) {
    if (m.stato !== "dismesso" && !viste.has(m.matricola)) elenco.push({ vehicleRef: m.matricola, giorni: [], esiti: "" });
  }

  const vetture: VetturaStoria[] = elenco.map(p => {
    const esito = new Map(p.giorni.map((g, k) => [g, Number(p.esiti[k] ?? "0")]));
    const conPosizione = (g: string) => ((esito.get(g) ?? 0) & POSIZIONE) !== 0;
    const conContatto = (g: string) => ((esito.get(g) ?? 0) & CONTATTO) !== 0;
    const primoGiorno = p.giorni[0] ?? null;
    const ultimoGiorno = p.giorni.at(-1) ?? null;
    const lunediComparsa = primoGiorno ? lunediDi(primoGiorno) : null;

    const storia = lunedi.map(l => {
      const contate = contateDi.get(l)!;
      const presenti = contate.filter(g => esito.has(g));
      return statoSettimana(contate.length, presenti.length,
        presenti.filter(conPosizione).length, presenti.filter(conContatto).length);
    });

    /* Le settimane che contano per l'azione: chiuse, giudicabili, dalla comparsa. */
    const giudicabili = lunedi
      .map((l, i) => ({ l, s: storia[i] }))
      .filter(x => x.l <= ultimaChiusa && x.s !== "." && lunediComparsa != null && x.l >= lunediComparsa);
    const ultima = giudicabili.at(-1) ?? null;
    let senzaPos = 0;
    for (let k = giudicabili.length - 1; k >= 0 && giudicabili[k].s !== "F"; k--) senzaPos++;
    let silenzio = 0;
    for (let k = giudicabili.length - 1; k >= 0 && (giudicabili[k].s === "M" || giudicabili[k].s === "A"); k--) silenzio++;
    const recenti = giudicabili.slice(-SETTIMANE_INSTABILITA);
    let cambi = 0;
    for (let k = 1; k < recenti.length; k++) if ((recenti[k].s === "F") !== (recenti[k - 1].s === "F")) cambi++;

    const giorniPos = p.giorni.filter(conPosizione);
    const ultimaPosizione = giorniPos.at(-1) ?? null;
    const ultimoContatto = p.giorni.filter(conContatto).at(-1) ?? null;
    const senzaPosizioneDal = ultimaPosizione
      ? tutteContate.find(g => g > ultimaPosizione) ?? null
      : primoGiorno ? tutteContate.find(g => g >= primoGiorno) ?? null : null;

    /* Riparata: l'ultima è F, prima c'è stata una non F, e la serie di F è recente. */
    let riparataDal: string | null = null;
    if (ultima?.s === "F") {
      let k = giudicabili.length - 1;
      while (k >= 0 && giudicabili[k].s === "F") k--;
      const inizioSerie = k + 1;
      const settimaneInSerie = giudicabili.length - inizioSerie;
      if (k >= 0 && settimaneInSerie <= SETTIMANE_RIPARATA) {
        const l = giudicabili[inizioSerie].l;
        riparataDal = giorniPos.find(g => g >= l) ?? l;
      }
    }

    const inCorso = lunedi.at(-1)!;
    const posizioneInSettimana = inCorso > ultimaChiusa
      ? giorniPos.find(g => g >= inCorso) ?? null
      : null;

    const mezzo = parco ? perMatricola.get(p.vehicleRef) ?? null : null;
    const escl = parco ? esclusioneOfficina(p.vehicleRef, "muta", mezzo ?? undefined) : null;
    const esclusa = escl && (escl.motivo === "fuori_parco" || escl.motivo === "dismesso") ? escl : null;
    const inSiri = p.giorni.length > 0 && (ultimeContate.length === 0 || ultimoGiorno! >= ultimeContate[0]);

    /* Gli interventi, giudicati sulle giornate contate di tutto il periodo. */
    const suoi = (interventiPer.get(p.vehicleRef) ?? [])
      .map(i => giudicaIntervento(i, tutteContate, conPosizione, conContatto))
      .sort((a, b) => a.chiusaIl.localeCompare(b.chiusaIl));
    const ultimoIntervento = suoi.at(-1) ?? null;

    /* L'azione, nell'ordine in cui decide. */
    let azione: Azione;
    if (esclusa) azione = inSiri ? "da_togliere_da_siri" : "gia_tolta";
    else if (mezzo && p.giorni.length === 0) azione = "da_aggiungere_a_siri";
    else if (!ultima) azione = "non_giudicabile";
    else if (mezzo && silenzio >= SETTIMANE_SILENZIO_ALIENATA
      && (mezzo.stato === "in_servizio" || mezzo.stato === "riserva") && !mezzo.segnalazioneAvm) {
      azione = "da_verificare_alienata";
    } else if (ultima.s !== "F") azione = "da_riparare";
    else if (cambi >= CAMBI_INSTABILE) azione = "instabile";
    else if (riparataDal) azione = "riparata";
    else azione = "funziona";

    const id = identitaVettura(p.vehicleRef);
    const v: VetturaStoria = {
      vehicleRef: p.vehicleRef, codice: id.codice, azienda: id.azienda, mezzo: id.mezzo,
      storia: storia.join(""), primoGiorno, ultimoGiorno, inSiri, ultimaPosizione, ultimoContatto,
      settimaneSenzaPosizione: primoGiorno ? senzaPos : null, senzaPosizioneDal, settimaneSilenzio: silenzio,
      cambi, riparataDal: azione === "riparata" ? riparataDal : null,
      posizioneInSettimana: azione === "da_riparare" ? posizioneInSettimana : null,
      officina: mezzo, esclusa, ultimoIntervento, interventi: suoi.length,
      azione, instabile: azione === "da_riparare" && cambi >= CAMBI_INSTABILE,
      perche: "", richiesta: richiestaDi.get(p.vehicleRef) ?? null,
    };
    v.perche = scriviPerche(v, ultima?.s ?? null, giudicabili.filter(x => x.s === "F").length, giudicabili.length,
      inizioDati);
    return v;
  });

  const peso = new Map(ORDINE_AZIONI.map((a, i) => [a, i]));
  vetture.sort((a, b) =>
    (peso.get(a.azione)! - peso.get(b.azione)!)
    || (a.azione === "da_riparare" ? (b.settimaneSenzaPosizione ?? 0) - (a.settimaneSenzaPosizione ?? 0) : 0)
    || a.vehicleRef.localeCompare(b.vehicleRef, undefined, { numeric: true }));

  return {
    generatoIl: dati.generatoIl ?? new Date().toISOString(),
    oggi,
    inizio: lunedi[0],
    ultimaChiusa,
    settimane: settimaneStoria,
    vetture,
    conteggi: contaAzioni(vetture),
    richieste,
  };
}

/* ── Le parole ─────────────────────────────────────────────────────────── */

/** Il perché di una vettura: deve reggere da solo in una mail, con le date. */
function scriviPerche(
  v: VetturaStoria, ultimoStato: StatoSettimana | null, settimaneF: number, settimaneGiudicabili: number,
  inizioDati: string,
): string {
  const pezzi: string[] = [];
  switch (v.azione) {
    case "da_togliere_da_siri":
      pezzi.push(v.esclusa!.testo);
      pezzi.push(`Il flusso SIRI la elenca ancora (ultimo giorno ${ddmm(v.ultimoGiorno)}).`);
      break;
    case "gia_tolta":
      pezzi.push(`${v.esclusa!.motivo === "fuori_parco" ? "Non è più nel parco dell'officina" : "Dismessa per l'officina"}, `
        + `e il flusso SIRI non la elenca più dal ${ddmm(v.ultimoGiorno)}.`);
      break;
    case "da_aggiungere_a_siri": {
      const m = v.officina!;
      pezzi.push(`Nel parco dell'officina (${[m.targa, m.deposito, m.modello].filter(Boolean).join(", ")}) ma mai `
        + `comparsa nel flusso SIRI dal ${ddmm(inizioDati)}: va censita a Mizar, o manca l'apparato a bordo.`);
      break;
    }
    case "da_verificare_alienata":
      pezzi.push(`Muta o assente da ${settimane(v.settimaneSilenzio)}`
        + `${v.ultimoContatto ? ` (ultimo contatto il ${ddmm(v.ultimoContatto)})` : ""}, ma l'officina la dà `
        + `${v.officina!.stato === "riserva" ? "di riserva" : "in servizio"} senza fermi né segnalazioni AVM aperte. `
        + "Guasta o alienata? Se il mezzo non c'è più, va segnato dismesso in FleetCare.");
      break;
    case "da_riparare": {
      const n = v.settimaneSenzaPosizione ?? 0;
      pezzi.push(`Non si localizza da ${settimane(n)}`
        + `${v.senzaPosizioneDal ? ` (dal ${ddmm(v.senzaPosizioneDal)})` : ""}`
        + `${v.ultimaPosizione ? `; ultima posizione il ${ddmm(v.ultimaPosizione)}` : `; mai localizzata dal ${ddmm(inizioDati)}`}.`);
      pezzi.push(ultimoStato === "P"
        ? (v.ultimaPosizione
          ? "Parla col centro ma non si localizza: antenna o apparato."
          : "Parla col centro ma non si è mai localizzata: attivazione al centro Mizar, o antenna.")
        : ultimoStato === "M"
          ? "Elencata ma muta: apparato spento, SIM, o mezzo fermo in rimessa."
          : "Il flusso SIRI non la elenca nell'ultima settimana.");
      if (v.instabile) pezzi.push(`Instabile: ${v.cambi} cambi nelle ultime ${SETTIMANE_INSTABILITA} settimane.`);
      if (v.posizioneInSettimana) pezzi.push(`In questa settimana si è localizzata il ${ddmm(v.posizioneInSettimana)}.`);
      break;
    }
    case "instabile":
      pezzi.push(`Si localizza, ma ha cambiato stato ${v.cambi} volte nelle ultime ${SETTIMANE_INSTABILITA} settimane: `
        + "da tenere d'occhio.");
      break;
    case "riparata":
      pezzi.push(`Si localizza di nuovo dal ${ddmm(v.riparataDal)}.`);
      break;
    case "funziona":
      pezzi.push(`Si localizza in ${settimaneF} delle ${settimane(settimaneGiudicabili)} giudicabili.`);
      break;
    case "non_giudicabile":
      pezzi.push(v.primoGiorno
        ? `Compare nel flusso dal ${ddmm(v.primoGiorno)}: nessuna settimana chiusa con abbastanza giornate contate.`
        : "Nessuna settimana chiusa con abbastanza giornate contate.");
      break;
  }
  if (v.azione !== "da_togliere_da_siri" && v.azione !== "gia_tolta" && v.azione !== "da_aggiungere_a_siri") {
    const officina = notaOfficina(v.officina, null, false);
    if (officina) pezzi.push(officina);
  }
  if (v.ultimoIntervento) {
    const i = v.ultimoIntervento;
    pezzi.push(`Ultimo intervento ${i.riferimento} chiuso il ${ddmm(i.giornoChiusura)}: `
      + `${ETICHETTE_ESITO_INTERVENTO[i.esitoAvm].toLowerCase()}.`);
  }
  if (v.richiesta) {
    const r = v.richiesta;
    const cosa = r.tipo === "togliere" ? "togliere" : "aggiungere";
    pezzi.push(r.esito == null
      ? `Richiesta a Mizar di ${cosa} inviata il ${ddmm(r.richiestaIl)}, `
        + `${r.giorniAttesa === 0 ? "in attesa" : `in attesa da ${r.giorniAttesa} ${r.giorniAttesa === 1 ? "giorno" : "giorni"}`}.`
      : r.esito === "fatta"
        ? `Richiesta a Mizar di ${cosa} fatta il ${ddmm(r.chiusaIl)}${r.ricomparsaIl ? `, ma è ricomparsa il ${ddmm(r.ricomparsaIl)}` : ""}.`
        : `Richiesta a Mizar di ${cosa} annullata il ${ddmm(r.chiusaIl)}.`);
  }
  return pezzi.join(" ");
}

/**
 * La frase di sintesi dell'andamento: quante vetture si localizzavano
 * nell'ultima settimana chiusa giudicabile, e quante nella prima.
 */
export function fraseAndamento(a: Array<SettimanaStoria & { F: number; P: number; M: number; A: number }>): string {
  const giudicabili = a.filter(w => w.chiusa && w.giornateContate >= GIORNATE_MINIME);
  const ultima = giudicabili.at(-1);
  if (!ultima) return "Nessuna settimana chiusa con abbastanza giornate contate: l'andamento non si può ancora dire.";
  const quota = (w: typeof ultima) => {
    const tot = w.F + w.P + w.M + w.A;
    return { tot, pct: tot ? Math.round((100 * w.F) / tot) : 0 };
  };
  const u = quota(ultima);
  const pezzi = [`Nella settimana dal ${ddmm(ultima.lunedi)} al ${ddmm(ultima.domenica)} si sono localizzate `
    + `${ultima.F} vetture su ${u.tot} (${u.pct}%).`];
  const prima = giudicabili[0];
  if (prima && prima.lunedi !== ultima.lunedi) {
    const p = quota(prima);
    pezzi.push(`Nella prima settimana osservata, dal ${ddmm(prima.lunedi)}, erano ${prima.F} su ${p.tot} (${p.pct}%).`);
  }
  return pezzi.join(" ");
}
