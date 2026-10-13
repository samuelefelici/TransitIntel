/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA — import da Excel o CSV: lettura del file e righe normalizzate
 * ───────────────────────────────────────────────────────────────────────────
 * Parte pura dell'import: dal file alle righe, senza database. Il file può
 * essere l'export della tabella DIPENDENTE del gestionale (nomi di colonna
 * come Id_dipendente, Codice_Deposito, Gruppo_Ferie, NumeroPatente…) o un
 * foglio aziendale con intestazioni in italiano: le colonne si riconoscono
 * per alias, senza maiuscole, accenti, spazi e trattini bassi.
 *
 * Sul filo una riga porta SOLO i valori non vuoti: una cella vuota non
 * cancella niente (chi vuole svuotare un campo lo fa dalla scheda).
 *
 * Tre cose che l'import non decide da solo, e chiede:
 *   · quale colonna è la matricola, quando ce n'è più di una candidata
 *     (Id_dipendente, Codice_per_paghe, VecchiaMatricola…);
 *   · a quale deposito del catalogo corrisponde ogni valore della colonna
 *     deposito, e quali escludere;
 *   · quali categorie (qualifiche, mansioni) sono conducenti: il gestionale
 *     esporta anche officina e uffici.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { parse } from "csv-parse/sync";
import {
  chiaveTesto, classificaTelefoni, componiIndirizzo, leggiCodiceFiscale, leggiData, leggiEsitoVisita,
  leggiFerie, leggiMatricola, leggiOrario, leggiParametro, pulisciTesto, formattaOrario,
  type Lettura,
} from "./anagrafica-campi";
import { leggiXlsx, LIMITI_XLSX } from "./xlsx-leggi";

export class ErroreFile extends Error {}

/* ── Il file come tabella ───────────────────────────────────────────────── */

/** Il separatore di un CSV: quello che compare più volte nella prima riga non vuota. */
function separatore(testo: string): string {
  const riga = testo.split(/\r?\n/).find(r => r.trim()) ?? "";
  const conta = (c: string) => riga.split(c).length - 1;
  return [";", ",", "\t"].sort((a, b) => conta(b) - conta(a))[0];
}

/** Il testo di un CSV: UTF-8 se lo è davvero, altrimenti latin1 (i CSV di Excel in italiano). */
function testoCsv(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  return utf8.includes("�") ? buf.toString("latin1") : utf8;
}

export function leggiTabella(buf: Buffer, nomeFile: string): Array<Array<string | null>> {
  const est = nomeFile.toLowerCase().split(".").pop();
  if (est === "xlsx" || est === "xlsm") return leggiXlsx(buf);
  if (est === "xls") throw new ErroreFile("I file .xls (Excel 97-2003) non si leggono: salvalo come .xlsx o come CSV.");
  if (est === "csv" || est === "txt") {
    const testo = testoCsv(buf);
    try {
      const righe = parse(testo, {
        delimiter: separatore(testo), bom: true, relax_column_count: true, relax_quotes: true,
        skip_empty_lines: false, trim: true,
      }) as string[][];
      /* gli stessi limiti del lettore .xlsx */
      if (righe.length > LIMITI_XLSX.righe) throw new ErroreFile(`Il file ha più di ${LIMITI_XLSX.righe} righe.`);
      if (righe.some(r => r.length > LIMITI_XLSX.colonne)) throw new ErroreFile(`Il file ha più di ${LIMITI_XLSX.colonne} colonne.`);
      return righe.map(r => r.map(c => (c === "" ? null : c.replace(/\u0000/g, "").slice(0, LIMITI_XLSX.cella))));
    } catch {
      throw new ErroreFile("Il CSV non si legge: controlla separatore e virgolette.");
    }
  }
  throw new ErroreFile("Formati letti: .xlsx e .csv.");
}

/* ── Le colonne ─────────────────────────────────────────────────────────── */

export type CampoImport =
  | "matricola" | "cognome" | "nome" | "nominativo" | "cf"
  | "dataNascita" | "dataAssunzione" | "dataFineServizio"
  | "deposito" | "categoria" | "orario"
  | "rotazioneRiposi" | "scaglioneRiposi" | "scaglioneFerie" | "rotazioneTurniGruppo" | "rotazioneTurniPosizione"
  | "inquadramento" | "parametro" | "ferieAnnue" | "ferieResidue" | "ferieResidueAl"
  | "residenza" | "indirizzo" | "cap" | "citta" | "prov" | "telefono"
  | "patente" | "patenteNumero" | "cqcNumero" | "patenteValidita" | "cqcValidita"
  | "visitaFerrovieData" | "visitaFerrovieValidita" | "visitaFerrovieEsito"
  | "visitaMedicoCompetenteData" | "visitaMedicoCompetenteValidita" | "visitaMedicoCompetenteEsito"
  | "note";

/**
 * Gli alias di ogni campo, in ordine di preferenza: quando due colonne
 * cadono sullo stesso campo vince quella con l'alias più in alto (per il
 * deposito, Id_residenza e Desc_residenza prima di Codice_Deposito: nel
 * gestionale è la residenza che lega il conducente ai turni).
 */
export const ALIAS: Array<[CampoImport, string, string[]]> = [
  ["matricola", "Matricola", ["matricola", "matr", "n matricola", "numero matricola", "id dipendente", "codice dipendente", "cod dipendente", "codice per paghe", "vecchia matricola"]],
  ["cognome", "Cognome", ["cognome"]],
  ["nome", "Nome", ["nome"]],
  ["nominativo", "Cognome e nome", ["nominativo", "cognome nome", "cognome e nome", "nome dipendente", "dipendente"]],
  ["cf", "Codice fiscale", ["codice fiscale", "cod fiscale", "cf", "cod fis"]],
  ["dataNascita", "Data di nascita", ["data nascita", "data di nascita", "nato il", "data nasc"]],
  ["dataAssunzione", "Data di assunzione", ["data assunzione", "data di assunzione", "assunto il", "data assunz"]],
  ["dataFineServizio", "Fine servizio", ["data fine servizio", "fine servizio", "data licenziamento", "data cessazione", "data fine rapporto", "cessato il"]],
  ["deposito", "Deposito", ["deposito", "deposito di appartenenza", "id residenza", "desc residenza", "residenza di servizio", "residenza servizio", "codice deposito", "cod deposito", "sede"]],
  ["categoria", "Categoria", ["categoria", "categoria conducente", "qualifica", "desc qualifica", "mansione", "desc mansione", "id qualifica", "id mansione", "profilo", "ruolo"]],
  ["orario", "Orario settimanale", ["orario settimanale", "orario di lavoro settimanale", "orario lavoro", "ore settimanali", "orario contrattuale settimanale", "orario contrattuale", "minuti settimanali", "ore contratto"]],
  ["rotazioneRiposi", "Rotazione riposi", ["rotazione riposi", "rotazione dei riposi", "ciclo riposi"]],
  ["scaglioneRiposi", "Scaglione riposi", ["scaglione riposi", "scaglione dei riposi", "gruppo riposi", "squadra riposo"]],
  ["scaglioneFerie", "Scaglione ferie", ["scaglione ferie", "scaglione delle ferie", "gruppo ferie", "turno ferie"]],
  ["rotazioneTurniGruppo", "Rotazione turni", ["rotazione turni", "rotazione dei turni", "gruppo turni", "gruppo rotazione turni", "gruppo rotazione"]],
  ["rotazioneTurniPosizione", "Posizione nella rotazione turni", ["posizione turni", "posizione rotazione turni", "posizione rotazione", "posizione"]],
  ["inquadramento", "Inquadramento", ["inquadramento", "livello", "area professionale", "profilo professionale", "qualifica contrattuale"]],
  ["parametro", "Parametro", ["parametro", "id parametro", "param", "parametro retributivo", "parametro ccnl"]],
  ["ferieAnnue", "Ferie maturate in un anno", ["ferie annue", "ferie anno", "ferie maturate anno", "ferie maturate", "ferie anno base", "ferie spettanti", "giorni ferie"]],
  ["ferieResidue", "Ferie residue", ["ferie residue", "residuo ferie", "ferie residuo", "saldo ferie", "ferie da godere"]],
  ["ferieResidueAl", "Residuo ferie al", ["ferie residue al", "residuo ferie al", "residuo al", "saldo al", "data residuo", "data saldo ferie"]],
  ["residenza", "Residenza (completa)", ["residenza", "residenza anagrafica", "dove abita", "abitazione"]],
  ["indirizzo", "Indirizzo", ["indirizzo", "via", "indirizzo residenza", "indirizzo domicilio"]],
  ["cap", "CAP", ["cap", "cap residenza", "cap domicilio"]],
  ["citta", "Città", ["citta", "comune", "citta residenza", "localita"]],
  ["prov", "Provincia", ["prov", "provincia", "sigla provincia", "sigla provincia domicilio"]],
  ["telefono", "Telefono", ["cellulare", "cell", "tel cellulare", "telefono cellulare", "mobile", "telefono", "tel", "tel1", "tel2", "telefono fisso", "recapito", "recapito telefonico"]],
  ["patente", "Categorie patente", ["tipo patente", "categorie patente", "categoria patente", "patente categorie", "patente"]],
  ["patenteNumero", "Numero patente", ["numero patente", "n patente", "num patente", "patente numero", "numero patente cqc"]],
  ["cqcNumero", "Numero CQC", ["numero cqc", "n cqc", "num cqc", "cqc numero"]],
  ["patenteValidita", "Scadenza patente", ["scadenza patente", "data scadenza patente", "patente scadenza", "validita patente", "patente valida fino al"]],
  ["cqcValidita", "Scadenza CQC", ["scadenza cqc", "data scadenza cqc", "cqc scadenza", "validita cqc", "cqc valida fino al"]],
  ["visitaFerrovieData", "Data visita ferrovie", ["data visita ferrovie", "visita ferrovie", "data visita ferroviaria", "ultima visita ferrovie", "visita idoneita ferroviaria", "data visita rfi"]],
  ["visitaFerrovieValidita", "Scadenza visita ferrovie", ["scadenza visita ferrovie", "scadenza idoneita ferroviaria", "visita ferrovie scadenza", "scadenza visita ferroviaria", "scadenza visita rfi"]],
  ["visitaFerrovieEsito", "Esito visita ferrovie", ["esito visita ferrovie", "idoneita ferroviaria", "esito visita ferroviaria"]],
  ["visitaMedicoCompetenteData", "Data visita medico competente", ["data visita medico competente", "visita medico competente", "ultima visita medico competente", "data visita medica", "visita medica"]],
  ["visitaMedicoCompetenteValidita", "Scadenza visita medico competente", ["scadenza visita medico competente", "scadenza visita medica", "scadenza sorveglianza sanitaria", "visita medico competente scadenza"]],
  ["visitaMedicoCompetenteEsito", "Esito visita medico competente", ["esito visita medico competente", "esito visita medica", "giudizio idoneita"]],
  ["note", "Note", ["note", "annotazioni", "osservazioni"]],
];

const CAMPI_CHIAVE = new Set(["matricola", "matr", "n matricola", "numero matricola", "id dipendente", "codice dipendente", "cod dipendente", "codice per paghe", "vecchia matricola"].map(a => a.replace(/ /g, "")));

/** Un'intestazione confrontabile: «Data_Scadenza_CQC» → «datascadenzacqc». Un'intestazione vera è corta. */
export const chiaveIntestazione = (s: string) => (s.length > 120 ? "" : chiaveTesto(s.replace(/_/g, " ")).replace(/ /g, ""));

const INDICE_ALIAS = new Map<string, { campo: CampoImport; priorita: number }>();
for (const [campo, , alias] of ALIAS) {
  alias.forEach((a, i) => {
    const k = a.replace(/ /g, "");
    if (!INDICE_ALIAS.has(k)) INDICE_ALIAS.set(k, { campo, priorita: i });
  });
}

export interface Colonna {
  indice: number;
  intestazione: string;
  campo: CampoImport | null;
  /** può essere la matricola */
  candidataChiave: boolean;
}

/** La riga delle intestazioni: la prima, fra le prime dieci, con almeno due colonne riconosciute. */
export function trovaIntestazioni(tabella: Array<Array<string | null>>): number {
  for (let i = 0; i < Math.min(10, tabella.length); i++) {
    const riconosciute = (tabella[i] ?? []).filter(c => c && INDICE_ALIAS.has(chiaveIntestazione(c))).length;
    if (riconosciute >= 2) return i;
  }
  return -1;
}

/**
 * Le colonne del file e il campo di ciascuna. Due colonne sullo stesso
 * campo: vince l'alias preferito, l'altra resta ignorata (si vede
 * nell'anteprima). Le colonne dei telefoni fanno eccezione: vanno tutte nel
 * mucchio da classificare.
 */
export function mappaColonne(intestazioni: Array<string | null>, colonnaChiave?: number): Colonna[] {
  const colonne: Colonna[] = intestazioni.map((h, indice) => {
    const k = h ? chiaveIntestazione(h) : "";
    return { indice, intestazione: h ?? "", campo: null, candidataChiave: CAMPI_CHIAVE.has(k) };
  });
  const migliore = new Map<CampoImport, { indice: number; priorita: number }>();
  for (const c of colonne) {
    const a = INDICE_ALIAS.get(chiaveIntestazione(c.intestazione));
    if (!a) continue;
    if (a.campo === "telefono") { c.campo = "telefono"; continue; }
    if (a.campo === "matricola") continue; // la matricola si sceglie sotto
    const ora = migliore.get(a.campo);
    if (!ora || a.priorita < ora.priorita) migliore.set(a.campo, { indice: c.indice, priorita: a.priorita });
  }
  for (const [campo, { indice }] of migliore) colonne[indice].campo = campo;
  const candidate = colonne.filter(c => c.candidataChiave);
  const scelta = colonnaChiave !== undefined && candidate.some(c => c.indice === colonnaChiave)
    ? colonnaChiave
    : candidate.sort((a, b) => (INDICE_ALIAS.get(chiaveIntestazione(a.intestazione))?.priorita ?? 99)
        - (INDICE_ALIAS.get(chiaveIntestazione(b.intestazione))?.priorita ?? 99))[0]?.indice;
  if (scelta !== undefined) colonne[scelta].campo = "matricola";
  return colonne;
}

/* ── Le righe ───────────────────────────────────────────────────────────── */

/**
 * Una riga pronta per l'applicazione. `valori` usa gli stessi nomi della
 * scheda conducente (il server la rilegge con lo stesso lettore) e contiene
 * solo i valori non vuoti.
 */
export interface RigaImport {
  /** numero di riga nel file (1 = prima riga del foglio) */
  n: number;
  valori: Record<string, unknown>;
  /** il valore del file per deposito e categoria: si abbinano con le scelte */
  depositoGrezzo?: string;
  categoriaGrezza?: string;
  /** nome della rotazione riposi di Cerbero e scaglione (1-based) */
  rotazioneRiposi?: { nome: string; scaglione: number };
  errori: string[];
  avvisi: string[];
}

export interface Statistica { righe: number; min: number; mediana: number; max: number }

export interface Analisi {
  rigaIntestazioni: number;
  colonne: Colonna[];
  righe: RigaImport[];
  /** valori distinti della colonna deposito, coi conteggi */
  depositi: Array<{ valore: string; righe: number }>;
  categorie: Array<{ valore: string; righe: number }>;
  scaglioniFerie: Array<{ valore: string; righe: number }>;
  statistiche: Partial<Record<"ferieAnnue" | "ferieResidue" | "orarioSettimanaleMin", Statistica>>;
  haDataResiduo: boolean;
}

function statistica(valori: number[]): Statistica | undefined {
  if (!valori.length) return undefined;
  const s = [...valori].sort((a, b) => a - b);
  return { righe: s.length, min: s[0], mediana: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

function conta(valori: Array<string | undefined>): Array<{ valore: string; righe: number }> {
  const m = new Map<string, number>();
  for (const v of valori) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([valore, righe]) => ({ valore, righe })).sort((a, b) => b.righe - a.righe || a.valore.localeCompare(b.valore));
}

/** «Rossi Mario» → cognome «Rossi», nome «Mario»; «De Luca Marco» → «De Luca», «Marco». */
export function dividiNominativo(s: string): { cognome: string; nome: string | null } {
  const parti = s.trim().split(/\s+/);
  if (parti.length < 2) return { cognome: s.trim(), nome: null };
  return { cognome: parti.slice(0, -1).join(" "), nome: parti[parti.length - 1] };
}

export function analizza(tabella: Array<Array<string | null>>, colonnaChiave?: number): Analisi {
  const h = trovaIntestazioni(tabella);
  if (h < 0) throw new ErroreFile("Non trovo le intestazioni: servono almeno due colonne riconoscibili (per esempio Matricola e Cognome) nelle prime dieci righe.");
  const colonne = mappaColonne(tabella[h], colonnaChiave);
  if (!colonne.some(c => c.campo === "matricola")) {
    throw new ErroreFile("Manca la colonna della matricola (Matricola, Id_dipendente, Codice_per_paghe…): senza, le righe non si abbinano ai conducenti.");
  }
  const col = (campo: CampoImport) => colonne.find(c => c.campo === campo)?.indice;
  const colTelefoni = colonne.filter(c => c.campo === "telefono").map(c => c.indice);
  const righe: RigaImport[] = [];
  const ferieAnnue: number[] = [];
  const ferieResidue: number[] = [];
  const orari: number[] = [];

  for (let i = h + 1; i < tabella.length; i++) {
    const t = tabella[i] ?? [];
    if (t.every(c => c === null || c === undefined || String(c).trim() === "")) continue;
    const cella = (campo: CampoImport) => { const k = col(campo); return k === undefined ? null : (t[k] ?? null); };
    const r: RigaImport = { n: i + 1, valori: {}, errori: [], avvisi: [] };
    const metti = <T>(chiave: string, etichetta: string, l: Lettura<T>, trasforma: (x: T) => unknown = x => x) => {
      if (l === null) return;
      if (l.ok === true) {
        r.valori[chiave] = trasforma(l.valore);
        if (l.avviso) r.avvisi.push(`${etichetta}: ${l.avviso}`);
      } else if (l.ok === false) r.errori.push(`${etichetta}: ${l.errore}`);
      else r.avvisi.push(`${etichetta}: ${l.avviso}`);
    };
    const testo = (chiave: string, campo: CampoImport, max: number) => {
      const v = pulisciTesto(cella(campo), max);
      if (v) r.valori[chiave] = v;
    };

    metti("matricola", "Matricola", leggiMatricola(cella("matricola")));
    if (!r.valori.matricola) r.errori.push("manca la matricola");
    testo("cognome", "cognome", 80);
    testo("nome", "nome", 80);
    if (!r.valori.cognome && !r.valori.nome && cella("nominativo")) {
      const d = dividiNominativo(String(cella("nominativo")));
      r.valori.cognome = pulisciTesto(d.cognome, 80);
      if (d.nome) r.valori.nome = pulisciTesto(d.nome, 80);
      r.avvisi.push("cognome e nome divisi dal nominativo: controlla i cognomi doppi");
    }
    metti("cf", "Codice fiscale", leggiCodiceFiscale(cella("cf")));
    metti("dataNascita", "Data di nascita", leggiData(cella("dataNascita"), { min: 1920, max: new Date().getUTCFullYear() }));
    metti("dataAssunzione", "Data di assunzione", leggiData(cella("dataAssunzione"), { min: 1950, max: new Date().getUTCFullYear() + 1 }));
    metti("dataFineServizio", "Fine servizio", leggiData(cella("dataFineServizio"), { min: 1950, max: 2100 }));

    const dep = pulisciTesto(cella("deposito"), 60);
    if (dep) r.depositoGrezzo = dep;
    const cat = pulisciTesto(cella("categoria"), 60);
    if (cat) r.categoriaGrezza = cat;

    metti("orarioSettimanaleMin", "Orario", leggiOrario(cella("orario")));
    if (typeof r.valori.orarioSettimanaleMin === "number") {
      orari.push(r.valori.orarioSettimanaleMin);
      /* sul filo l'orario va come «hh:mm», che il lettore della scheda riconosce senza ambiguità */
      r.valori.orarioSettimanaleMin = formattaOrario(r.valori.orarioSettimanaleMin);
    }

    const rotNome = pulisciTesto(cella("rotazioneRiposi"), 120);
    const scagl = pulisciTesto(cella("scaglioneRiposi"), 10);
    if (rotNome || scagl) {
      const n = Number(scagl?.replace(/\D/g, ""));
      if (!rotNome) r.errori.push("Scaglione riposi senza la rotazione riposi");
      else if (!scagl || !Number.isInteger(n) || n < 1) r.errori.push("Rotazione riposi senza uno scaglione valido");
      else r.rotazioneRiposi = { nome: rotNome, scaglione: n };
    }
    testo("scaglioneFerie", "scaglioneFerie", 40);
    const gruppo = pulisciTesto(cella("rotazioneTurniGruppo"), 40);
    if (gruppo) {
      const p = pulisciTesto(cella("rotazioneTurniPosizione"), 6);
      const pos = p ? Number(p.replace(/\D/g, "")) : null;
      if (pos !== null && (!Number.isInteger(pos) || pos < 1)) r.errori.push("Posizione nella rotazione turni non valida");
      else r.valori.rotazioneTurni = { gruppo, posizione: pos };
    }

    testo("inquadramento", "inquadramento", 80);
    metti("parametro", "Parametro", leggiParametro(cella("parametro")));
    metti("ferieAnnue", "Ferie annue", leggiFerie(cella("ferieAnnue")));
    if (typeof r.valori.ferieAnnue === "number") ferieAnnue.push(r.valori.ferieAnnue);
    metti("ferieResidue", "Ferie residue", leggiFerie(cella("ferieResidue")));
    if (typeof r.valori.ferieResidue === "number") ferieResidue.push(r.valori.ferieResidue);
    metti("ferieResidueAl", "Residuo ferie al", leggiData(cella("ferieResidueAl"), { min: 2000, max: new Date().getUTCFullYear() + 2 }));

    const residenza = pulisciTesto(cella("residenza"), 200)
      ?? componiIndirizzo({ indirizzo: cella("indirizzo"), cap: cella("cap"), citta: cella("citta"), prov: cella("prov") });
    if (residenza) r.valori.residenzaAnagrafica = residenza;
    const tel = classificaTelefoni(colTelefoni.map(k => t[k] ?? null));
    if (tel.cellulare) r.valori.cellulare = tel.cellulare;
    if (tel.telefono) r.valori.telefono = tel.telefono;
    r.avvisi.push(...tel.avvisi);

    testo("patente", "patente", 40);
    const nPat = pulisciTesto(cella("patenteNumero"), 30);
    const nCqc = pulisciTesto(cella("cqcNumero"), 30);
    if (nPat) r.valori.patenteNumero = nPat.toUpperCase();
    if (nCqc) r.valori.cqcNumero = nCqc.toUpperCase();
    if (nPat && nCqc && nPat.toUpperCase() !== nCqc.toUpperCase()) r.avvisi.push("numero patente e numero CQC diversi: salvati tutti e due");
    metti("patenteValidita", "Scadenza patente", leggiData(cella("patenteValidita"), { min: 1990, max: 2100 }));
    metti("cqcValidita", "Scadenza CQC", leggiData(cella("cqcValidita"), { min: 1990, max: 2100 }));
    for (const [pref, etichetta] of [["visitaFerrovie", "Visita ferrovie"], ["visitaMedicoCompetente", "Visita medico competente"]] as const) {
      metti(`${pref}Data`, `${etichetta}, data`, leggiData(cella(`${pref}Data`), { min: 1990, max: new Date().getUTCFullYear() + 1 }));
      metti(`${pref}Validita`, `${etichetta}, scadenza`, leggiData(cella(`${pref}Validita`), { min: 1990, max: 2100 }));
      metti(`${pref}Esito`, `${etichetta}, esito`, leggiEsitoVisita(cella(`${pref}Esito`)));
    }
    const note = cella("note");
    if (note !== null && String(note).trim()) r.valori.note = String(note).replace(/\u0000/g, "").trim().slice(0, 2000);
    righe.push(r);
  }

  return {
    rigaIntestazioni: h + 1,
    colonne,
    righe,
    depositi: conta(righe.map(r => r.depositoGrezzo)),
    categorie: conta(righe.map(r => r.categoriaGrezza)),
    scaglioniFerie: conta(righe.map(r => r.valori.scaglioneFerie as string | undefined)),
    statistiche: {
      ferieAnnue: statistica(ferieAnnue),
      ferieResidue: statistica(ferieResidue),
      orarioSettimanaleMin: statistica(orari),
    },
    haDataResiduo: colonne.some(c => c.campo === "ferieResidueAl"),
  };
}
