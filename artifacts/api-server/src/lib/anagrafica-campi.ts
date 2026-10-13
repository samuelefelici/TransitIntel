/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PERSONALE — i campi, i valori ammessi, la mascheratura
 * ───────────────────────────────────────────────────────────────────────────
 * Funzioni pure, senza database: le usano le scritture (scheda e import),
 * l'esportazione e la pagina, e sono quelle che si testano davvero.
 *
 * Tre regole che attraversano tutto il modulo:
 *   · ogni valore che arriva da fuori passa da un lettore che dice «valore»,
 *     «vuoto» o «errore» con un messaggio leggibile: mai un NULL silenzioso;
 *   · chi ha solo il permesso «scheduling» vede i CAMPI_OPERATIVI e basta.
 *     È un elenco di campi AMMESSI: un campo nuovo resta nascosto finché
 *     qualcuno non decide che è operativo;
 *   · la matricola si confronta sempre nella forma canonica.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/* ── Valori ammessi ─────────────────────────────────────────────────────── */

/** Parametri retributivi del CCNL usati in azienda (busta paga). */
export const PARAMETRI = [140, 158, 175, 183] as const;

/** Abilitazioni alla guida e alle mansioni (chiavi stabili). */
export const ABILITAZIONI = ["autobus", "filobus", "autosnodato", "ascensore", "verificatore"] as const;

export const ESITI_VISITA = ["idoneo", "idoneo_prescrizioni", "temp_non_idoneo", "non_idoneo"] as const;
export type EsitoVisita = typeof ESITI_VISITA[number];
export const ETICHETTE_ESITO: Record<EsitoVisita, string> = {
  idoneo: "Idoneo",
  idoneo_prescrizioni: "Idoneo con prescrizioni",
  temp_non_idoneo: "Temporaneamente non idoneo",
  non_idoneo: "Non idoneo",
};

export const MOTIVI_CESSAZIONE = ["pensione", "dimissioni", "licenziamento", "fine_contratto", "altro"] as const;
export type MotivoCessazione = typeof MOTIVI_CESSAZIONE[number];
export const ETICHETTE_MOTIVO: Record<MotivoCessazione, string> = {
  pensione: "Pensione",
  dimissioni: "Dimissioni",
  licenziamento: "Licenziamento",
  fine_contratto: "Fine contratto",
  altro: "Altro",
};

export const UNITA_FERIE = ["giorni", "ore"] as const;
export type UnitaFerie = typeof UNITA_FERIE[number];

/* ── Depositi del personale ─────────────────────────────────────────────── */

export type Gruppo = "A" | "B";
/** settimanale = Jesi Urbano; semimensile = 1–15 / 16–fine mese, 24 periodi l'anno */
export type CadenzaTurni = "settimanale" | "semimensile";

export interface Deposito {
  codice: string;
  nome: string;
  gruppo: Gruppo;
  cadenzaTurni: CadenzaTurni;
  /** altri nomi o codici con cui il deposito arriva da un file */
  alias: string[];
  ordine: number;
}

/**
 * I sette depositi con rotazione. Gruppo A: niente servizio la domenica e nei
 * festivi; gruppo B: servizio anche la domenica. I microdepositi assorbiti
 * sono alias del deposito che li ha assorbiti.
 */
export const DEPOSITI_INIZIALI: Deposito[] = [
  { codice: "ancona", nome: "Ancona", gruppo: "B", cadenzaTurni: "semimensile", alias: ["polverigi"], ordine: 1 },
  { codice: "marina", nome: "Marina", gruppo: "B", cadenzaTurni: "semimensile", alias: ["belvedere", "belvedere ostrense", "ostra", "marina di montemarciano"], ordine: 2 },
  { codice: "osimo", nome: "Osimo", gruppo: "B", cadenzaTurni: "semimensile", alias: [], ordine: 3 },
  { codice: "jesi", nome: "Jesi", gruppo: "A", cadenzaTurni: "semimensile", alias: [], ordine: 4 },
  { codice: "jesi-urbano", nome: "Jesi Urbano", gruppo: "A", cadenzaTurni: "settimanale", alias: ["moie", "jesi u", "jesi urb"], ordine: 5 },
  { codice: "castelfidardo", nome: "Castelfidardo", gruppo: "A", cadenzaTurni: "semimensile", alias: [], ordine: 6 },
  { codice: "filottrano", nome: "Filottrano", gruppo: "A", cadenzaTurni: "semimensile", alias: [], ordine: 7 },
];

/** Testo confrontabile: minuscole, senza accenti, spazi e punteggiatura ridotti a uno spazio. */
export function chiaveTesto(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/** Un codice tutto cifre si confronta senza zeri iniziali («01» = «1»). */
function chiaveCodice(s: string): string {
  const k = chiaveTesto(s);
  return /^\d+$/.test(k) ? (k.replace(/^0+/, "") || "0") : k;
}

/** Il deposito del catalogo che corrisponde a un nome, a un codice o a un alias. */
export function trovaDeposito(valore: string | null | undefined, catalogo: Deposito[]): Deposito | null {
  if (!valore || !valore.trim()) return null;
  const k = chiaveCodice(valore);
  for (const d of catalogo) {
    if (chiaveCodice(d.nome) === k || chiaveCodice(d.codice) === k) return d;
  }
  for (const d of catalogo) {
    if (d.alias.some(a => chiaveCodice(a) === k)) return d;
  }
  return null;
}

/* ── Esiti dei lettori ──────────────────────────────────────────────────── */

export type Lettura<T> =
  | { ok: true; valore: T; avviso?: string }
  | { ok: false; errore: string }
  /** il dato c'è ma non si salva (non blocca la riga): resta l'avviso */
  | { ok: "ignora"; avviso: string }
  | null; // vuoto: il dato non c'è, e chi scrive non tocca quello esistente

const vuoto = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === "";

/** Toglie i caratteri che Postgres rifiuta nel testo e gli spazi in eccesso. */
export function pulisciTesto(v: unknown, max = 200): string | null {
  if (vuoto(v)) return null;
  const s = String(v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/* ── Matricola ──────────────────────────────────────────────────────────── */

/**
 * La forma con cui due matricole si confrontano: senza spazi, maiuscole, e
 * se è tutta cifre senza zeri iniziali («00123» = «123»). È l'unica
 * definizione: anche il bootstrap la usa per la colonna matricola_chiave.
 */
export function matricolaCanonica(v: unknown): string | null {
  if (vuoto(v)) return null;
  let s = String(v).replace(/\u0000/g, "").replace(/\s+/g, "").toUpperCase();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ""); // 123.0 da un numero di Excel
  if (/^\d+$/.test(s)) s = s.replace(/^0+/, "") || "0";
  return s || null;
}

export function leggiMatricola(v: unknown): Lettura<string> {
  if (vuoto(v)) return null;
  const s = String(v).replace(/\u0000/g, "").trim().replace(/\.0+$/, "");
  if (s.length > 20) return { ok: false, errore: "matricola troppo lunga" };
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return { ok: false, errore: `matricola non valida («${s}»)` };
  return { ok: true, valore: s };
}

/* ── Date ───────────────────────────────────────────────────────────────── */

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const ITA = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;

function dataValida(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Numero seriale di Excel → data (epoca 30/12/1899, che assorbe l'errore del 1900 bisestile). */
export function dataDaSeriale(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 80_000) return null;
  const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/**
 * Una data da un file o da un modulo: ISO (anche con l'ora, come la esporta
 * il gestionale), gg/mm/aaaa, gg-mm-aa, o il numero seriale di Excel. Le
 * date prima del 1901 sono il «vuoto» del gestionale (1900-01-01).
 */
export function leggiData(v: unknown, anni: { min?: number; max?: number } = {}): Lettura<string> {
  if (vuoto(v)) return null;
  const s = String(v).trim();
  let iso: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = ISO.exec(s))) iso = dataValida(+m[1], +m[2], +m[3]);
  else if ((m = ITA.exec(s))) {
    let y = +m[3];
    if (m[3].length === 2) {
      const ora = new Date().getUTCFullYear() % 100;
      y += y <= ora + 15 ? 2000 : 1900;
    }
    iso = dataValida(y, +m[2], +m[1]);
  } else if (/^\d+(\.\d+)?$/.test(s)) iso = dataDaSeriale(Number(s));
  if (!iso) return { ok: false, errore: `data non valida («${s.slice(0, 30)}»)` };
  const anno = +iso.slice(0, 4);
  if (anno < 1901) return { ok: "ignora", avviso: `data ${iso} ignorata: è il vuoto del gestionale` };
  if (anni.min !== undefined && anno < anni.min) return { ok: false, errore: `data fuori dal plausibile (${iso})` };
  if (anni.max !== undefined && anno > anni.max) return { ok: false, errore: `data fuori dal plausibile (${iso})` };
  return { ok: true, valore: iso };
}

/* ── Orario settimanale ─────────────────────────────────────────────────── */

export const ORARIO_MIN_PLAUSIBILE = 600;   // 10h
export const ORARIO_MAX_PLAUSIBILE = 3000;  // 50h
export const ORARIO_MAX = 3600;             // 60h

export function formattaOrario(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "";
  const h = Math.floor(min / 60);
  return `${h}:${String(Math.round(min - h * 60)).padStart(2, "0")}`;
}

/**
 * L'orario di lavoro settimanale, in minuti, da come lo si scrive a mano o
 * come lo esporta il gestionale. Regola unica per l'import e per lo storico:
 *   · «38:30», «38h30», «38 h», «38,5» (ore decimali) → ore;
 *   · un intero fino a 80, anche con «h» o «ore» → ore; oltre 80, o con «m»/«min» → minuti;
 *   · un decimale sotto 4 → giorni (la durata salvata come data da Excel: 1,625 = 39h);
 *   · «aaaa-mm-gg hh:mm» del gestionale (una durata salvata come data): valore
 *     meno l'epoca, 30/12/1899 se l'anno è 1899, 1/1/1900 altrimenti.
 */
export function leggiOrario(v: unknown): Lettura<number> {
  if (vuoto(v)) return null;
  const s = String(v).trim().toLowerCase().replace(/\s+/g, " ");
  let min: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,3}):(\d{2})(?::\d{2})?$/.exec(s))) min = +m[1] * 60 + +m[2];
  else if ((m = /^(\d{1,3}) ?h ?(\d{1,2})(?: ?m(?:in)?)?$/.exec(s))) min = +m[1] * 60 + +m[2];
  else if ((m = /^(\d{1,3}) ?(?:h|ore)$/.exec(s))) min = +m[1] * 60;
  else if ((m = /^(\d{1,3})[.,](\d+) ?(?:h|ore)$/.exec(s))) min = Math.round(Number(`${m[1]}.${m[2]}`) * 60);
  else if ((m = /^(\d{1,5}) ?(?:m|min|minuti)$/.exec(s))) min = +m[1];
  else if ((m = /^(\d{1,5})$/.exec(s))) min = +m[1] <= 80 ? +m[1] * 60 : +m[1];
  else if ((m = /^(\d{1,5})[.,](\d+)$/.exec(s))) {
    const n = Number(`${m[1]}.${m[2]}`);
    min = n < 4 ? Math.round(n * 1440) : n <= 80 ? Math.round(n * 60) : Math.round(n);
  } else if ((m = /^(1899|1900)-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})/.exec(s))) {
    const epoca = m[1] === "1899" ? Date.UTC(1899, 11, 30) : Date.UTC(1900, 0, 1);
    min = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - epoca) / 60_000);
  }
  if (min === null || !Number.isFinite(min)) return { ok: false, errore: `orario non leggibile («${s.slice(0, 30)}»)` };
  if (min < 0 || min > ORARIO_MAX) return { ok: false, errore: `orario fuori misura (${formattaOrario(min)} a settimana)` };
  if (min < ORARIO_MIN_PLAUSIBILE || min > ORARIO_MAX_PLAUSIBILE) {
    return { ok: true, valore: min, avviso: `orario insolito: ${formattaOrario(min)} a settimana` };
  }
  return { ok: true, valore: min };
}

/* ── Telefoni ───────────────────────────────────────────────────────────── */

export interface Telefoni { cellulare?: string; telefono?: string; avvisi: string[] }

/** Cifre di un numero italiano senza prefisso internazionale, o null se non è un numero. */
export function cifreTelefono(v: string): string | null {
  let s = v.replace(/[\s./()-]/g, "");
  if (s.startsWith("+39")) s = s.slice(3);
  else if (s.startsWith("0039")) s = s.slice(4);
  return /^\d{6,12}$/.test(s) ? s : null;
}

/**
 * I numeri di una riga (anche da colonne «Tel», «Tel1», «Tel2» senza un
 * nome che dica quale è il cellulare): un numero che comincia per 3 è un
 * cellulare, uno che comincia per 0 è un fisso.
 */
export function classificaTelefoni(valori: unknown[]): Telefoni {
  const out: Telefoni = { avvisi: [] };
  for (const raw of valori) {
    if (vuoto(raw)) continue;
    const s = String(raw).trim();
    const c = cifreTelefono(s);
    if (!c) { out.avvisi.push(`telefono non leggibile («${s.slice(0, 20)}»)`); continue; }
    if (/^3\d{8,9}$/.test(c)) {
      if (!out.cellulare) out.cellulare = c;
      else if (c !== out.cellulare && !out.telefono) {
        out.telefono = c;
        out.avvisi.push("due cellulari: il secondo va nel telefono");
      }
    } else if (/^0\d{5,10}$/.test(c)) {
      if (!out.telefono) out.telefono = c;
    } else out.avvisi.push(`telefono non riconosciuto («${s.slice(0, 20)}»)`);
  }
  return out;
}

/* ── Parametro, ferie, codice fiscale, visite ───────────────────────────── */

export function leggiParametro(v: unknown): Lettura<number> {
  if (vuoto(v)) return null;
  const s = String(v).trim();
  const m = /(\d{3})(?:[.,]0+)?(?!\d)/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  if ((PARAMETRI as readonly number[]).includes(n)) return { ok: true, valore: n };
  /* fuori elenco: non si salva, ma non blocca la riga */
  return { ok: "ignora", avviso: `parametro «${s.slice(0, 10)}» non tra ${PARAMETRI.join(", ")}: non salvato` };
}

export function leggiFerie(v: unknown): Lettura<number> {
  if (vuoto(v)) return null;
  const s = String(v).trim().replace(",", ".");
  if (!/^-?\d{1,4}(\.\d+)?$/.test(s)) return { ok: false, errore: `ferie non leggibili («${String(v).slice(0, 15)}»)` };
  const n = Math.round(Number(s) * 10) / 10;
  if (Math.abs(n) > 999) return { ok: false, errore: `ferie fuori misura (${n})` };
  return { ok: true, valore: n };
}

export function leggiCodiceFiscale(v: unknown): Lettura<string> {
  if (vuoto(v)) return null;
  const s = String(v).replace(/\s+/g, "").toUpperCase();
  if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(s) || /^[A-Z0-9]{16}$/.test(s) || /^\d{11}$/.test(s)) {
    return { ok: true, valore: s };
  }
  return { ok: "ignora", avviso: `codice fiscale non valido («${s.slice(0, 16)}»): non salvato` };
}

export function leggiEsitoVisita(v: unknown): Lettura<EsitoVisita> {
  if (vuoto(v)) return null;
  const k = chiaveTesto(String(v));
  if ((ESITI_VISITA as readonly string[]).includes(String(v))) return { ok: true, valore: String(v) as EsitoVisita };
  if (/^(temp|temporaneamente) ?non idone/.test(k)) return { ok: true, valore: "temp_non_idoneo" };
  if (/^non idone/.test(k)) return { ok: true, valore: "non_idoneo" };
  if (/^idone[oa]? (con )?(prescrizion|limitazion)/.test(k)) return { ok: true, valore: "idoneo_prescrizioni" };
  if (/^idone[oa]$/.test(k)) return { ok: true, valore: "idoneo" };
  return { ok: false, errore: `esito della visita non riconosciuto («${String(v).slice(0, 30)}»)` };
}

/** Il motivo dell'uscita dal servizio, da come lo scrive il gestionale o un foglio. */
export function leggiMotivoCessazione(v: unknown): Lettura<MotivoCessazione> {
  if (vuoto(v)) return null;
  const k = chiaveTesto(String(v));
  if ((MOTIVI_CESSAZIONE as readonly string[]).includes(String(v))) return { ok: true, valore: String(v) as MotivoCessazione };
  if (/pension/.test(k)) return { ok: true, valore: "pensione" };
  if (/dimiss|dimess/.test(k)) return { ok: true, valore: "dimissioni" };
  if (/licenzia/.test(k)) return { ok: true, valore: "licenziamento" };
  if (/fine (contratto|rapporto)|scadenza contratto|tempo determinato/.test(k)) return { ok: true, valore: "fine_contratto" };
  return { ok: true, valore: "altro", avviso: `motivo dell'uscita «${String(v).slice(0, 30)}» salvato come «altro»` };
}

/** Indirizzo da colonne separate: solo se la via c'è, altrimenti un indirizzo completo non si sovrascrive con una città. */
export function componiIndirizzo(p: { indirizzo?: unknown; cap?: unknown; citta?: unknown; prov?: unknown }): string | null {
  const via = pulisciTesto(p.indirizzo, 150);
  if (!via) return null;
  const cap = pulisciTesto(p.cap, 10);
  const citta = pulisciTesto(p.citta, 80);
  const prov = pulisciTesto(p.prov, 4);
  const luogo = [cap, citta].filter(Boolean).join(" ");
  return [via, luogo ? `${luogo}${prov ? ` (${prov.toUpperCase()})` : ""}` : null].filter(Boolean).join(", ");
}

/* ── Il conducente come lo vede chi chiama l'API ────────────────────────── */

export interface RotazioneDelConducente {
  id: string;
  nome: string;
  settimane: number;
  /** numero del gruppo, 1-based (week_index + 1): resta fisso, è la riga di partenza */
  scaglione: number;
  /**
   * i codici della riga di questa settimana, lun→dom (null = lavoro); null se
   * la rotazione non ha ancora l'ancora (non è mai stata generata)
   */
  settimanaCorrente: Array<string | null> | null;
}

/** Lunedì (ISO) della settimana di una data ISO. */
export function lunediDi(giorno: string): string {
  const t = Date.parse(`${giorno}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * La riga della rotazione che un gruppo usa nella settimana di `giorno`: la
 * stessa aritmetica di genera-riposi (lib/roster-rotazioni.ts). Il gruppo
 * `weekIndex` è sulla riga `weekIndex` nella settimana dell'ancora e scende
 * di una riga a settimana.
 */
export function rigaRotazione(weekIndex: number, settimane: number, ancora: string, giorno: string): number {
  const offset = Math.round((Date.parse(`${lunediDi(giorno)}T00:00:00Z`) - Date.parse(`${lunediDi(ancora)}T00:00:00Z`)) / (7 * 86_400_000));
  return ((weekIndex + offset) % settimane + settimane) % settimane;
}

export interface Conducente {
  id: string;
  name: string;
  badge: string | null;
  isFictitious: boolean;
  isActive: boolean;
  /** cresce a ogni modifica: chi salva la scheda la rimanda, e se è cambiata nel frattempo il salvataggio si ferma */
  versione: number;
  updatedAt: string | null;
  matricola: string | null;
  cognome: string | null;
  nome: string | null;
  /** deposito di appartenenza (nome del catalogo) */
  residenzaServizio: string | null;
  categoria: string | null;
  orarioSettimanaleMin: number | null;
  rotazioneRiposi: RotazioneDelConducente | null;
  /** quante rotazioni riposi ha in tutto (più di una è un errore da sistemare) */
  rotazioniRiposi: number;
  scaglioneFerie: string | null;
  rotazioneTurni: { gruppoId: string; gruppo: string; posizione: number | null } | null;
  abilitazioni: string[];
  photoUrl: string | null;
  patente: string | null;
  patenteValidita: string | null;
  cqcValidita: string | null;
  visitaFerrovieValidita: string | null;
  visitaMedicoCompetenteValidita: string | null;
  visitaFerrovieEsito: EsitoVisita | null;
  visitaMedicoCompetenteEsito: EsitoVisita | null;
  cellulare: string | null;
  dataFineServizio: string | null;
  /* sensibili */
  /** perché esce dal servizio (pensione, dimissioni…): la data è operativa, il motivo no */
  motivoCessazione?: MotivoCessazione | null;
  cf?: string | null;
  dataNascita?: string | null;
  dataAssunzione?: string | null;
  residenzaAnagrafica?: string | null;
  telefono?: string | null;
  inquadramento?: string | null;
  parametro?: number | null;
  ferieAnnue?: number | null;
  ferieResidue?: number | null;
  ferieResidueAl?: string | null;
  ferieUnita?: UnitaFerie;
  patenteNumero?: string | null;
  cqcNumero?: string | null;
  visitaFerrovieData?: string | null;
  visitaMedicoCompetenteData?: string | null;
  note?: string | null;
}

/**
 * I campi che vede chi ha solo «scheduling»: servono a vestire i turni e a
 * coprire le assenze. Il cellulare è qui perché alle cinque del mattino chi
 * copre un'assenza deve poter chiamare la disposizione.
 */
export const CAMPI_OPERATIVI = [
  "id", "name", "badge", "isFictitious", "isActive", "versione", "updatedAt",
  "matricola", "cognome", "nome", "residenzaServizio", "categoria", "orarioSettimanaleMin",
  "rotazioneRiposi", "rotazioniRiposi", "scaglioneFerie", "rotazioneTurni",
  "abilitazioni", "photoUrl", "patente", "patenteValidita", "cqcValidita",
  "visitaFerrovieValidita", "visitaMedicoCompetenteValidita",
  "visitaFerrovieEsito", "visitaMedicoCompetenteEsito",
  "cellulare", "dataFineServizio",
] as const satisfies ReadonlyArray<keyof Conducente>;

/** Solo l'idoneità che toglie dal servizio è un dato operativo; le prescrizioni no. */
function esitoOperativo(e: EsitoVisita | null): EsitoVisita | null {
  return e === "non_idoneo" || e === "temp_non_idoneo" ? e : null;
}

export function mascheraConducente(c: Conducente, vedeSensibili: boolean): Conducente {
  if (vedeSensibili) return c;
  const out: Record<string, unknown> = {};
  for (const k of CAMPI_OPERATIVI) out[k] = c[k];
  out.visitaFerrovieEsito = esitoOperativo(c.visitaFerrovieEsito);
  out.visitaMedicoCompetenteEsito = esitoOperativo(c.visitaMedicoCompetenteEsito);
  return out as unknown as Conducente;
}

/* ── Scadenziario ───────────────────────────────────────────────────────── */

export type StatoScadenza = "non_idoneo" | "scaduta" | "entro_30" | "entro_60" | "entro_90" | "ok" | "mancante";
export const ORDINE_STATI: StatoScadenza[] = ["non_idoneo", "scaduta", "entro_30", "entro_60", "entro_90", "mancante", "ok"];
export const ETICHETTE_STATO: Record<StatoScadenza, string> = {
  non_idoneo: "Non idoneo",
  scaduta: "Scaduta",
  entro_30: "Entro 30 giorni",
  entro_60: "Entro 60 giorni",
  entro_90: "Entro 90 giorni",
  ok: "In regola",
  mancante: "Manca la data",
};

export type Documento = "patente" | "cqc" | "visita_ferrovie" | "visita_medico_competente";
export const ETICHETTE_DOCUMENTO: Record<Documento, string> = {
  patente: "Patente",
  cqc: "CQC",
  visita_ferrovie: "Visita ferrovie",
  visita_medico_competente: "Visita medico competente",
};

function giorniTra(da: string, a: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${da}T00:00:00Z`)) / 86_400_000);
}

export function statoScadenza(scadenza: string | null, oggi: string, esito?: EsitoVisita | null): { stato: StatoScadenza; giorni: number | null } {
  if (esito === "non_idoneo" || esito === "temp_non_idoneo") {
    return { stato: "non_idoneo", giorni: scadenza ? giorniTra(oggi, scadenza) : null };
  }
  if (!scadenza) return { stato: "mancante", giorni: null };
  const g = giorniTra(oggi, scadenza);
  const stato: StatoScadenza = g < 0 ? "scaduta" : g <= 30 ? "entro_30" : g <= 60 ? "entro_60" : g <= 90 ? "entro_90" : "ok";
  return { stato, giorni: g };
}

export interface VoceScadenziario {
  documento: Documento;
  scadenza: string | null;
  stato: StatoScadenza;
  giorni: number | null;
}

/** Le quattro scadenze di un conducente, ciascuna col suo stato. */
export function scadenzeDi(c: Conducente, oggi: string): VoceScadenziario[] {
  const voci: Array<[Documento, string | null, EsitoVisita | null]> = [
    ["patente", c.patenteValidita, null],
    ["cqc", c.cqcValidita, null],
    ["visita_ferrovie", c.visitaFerrovieValidita, c.visitaFerrovieEsito],
    ["visita_medico_competente", c.visitaMedicoCompetenteValidita, c.visitaMedicoCompetenteEsito],
  ];
  return voci.map(([documento, scadenza, esito]) => ({ documento, scadenza, ...statoScadenza(scadenza, oggi, esito) }));
}

/** Lo stato peggiore fra le scadenze di un conducente. */
export function statoPeggiore(voci: VoceScadenziario[]): StatoScadenza {
  let peggiore: StatoScadenza = "ok";
  for (const v of voci) if (ORDINE_STATI.indexOf(v.stato) < ORDINE_STATI.indexOf(peggiore)) peggiore = v.stato;
  return peggiore;
}

/** Lo scaglione ferie in una forma sola: «Gruppo 03», «gr. 3», «3» → «3»; «Estate A» → «ESTATE A». */
export function normalizzaScaglioneFerie(v: unknown): string | null {
  const s = pulisciTesto(v, 40);
  if (!s) return null;
  const k = s.toUpperCase().replace(/^(GRUPPO|SCAGLIONE|SCAGL\.?|GR\.?)\s*/, "").trim();
  if (!k) return null;
  return /^\d+$/.test(k) ? (k.replace(/^0+/, "") || "0") : k.slice(0, 20);
}
