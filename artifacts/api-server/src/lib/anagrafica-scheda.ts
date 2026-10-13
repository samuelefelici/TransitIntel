/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA — il corpo della scheda conducente, letto e validato
 * ───────────────────────────────────────────────────────────────────────────
 * La scheda manda solo i campi cambiati (più `versione`, per accorgersi se
 * qualcun altro ha salvato nel frattempo). Qui ogni campo passa dal suo
 * lettore: un valore sbagliato è un errore con il nome del campo, non un
 * NULL salvato in silenzio come faceva la versione di prima.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  ABILITAZIONI, ESITI_VISITA, MOTIVI_CESSAZIONE, PARAMETRI, UNITA_FERIE, cifreTelefono, leggiCodiceFiscale, leggiData,
  leggiFerie, leggiMatricola, leggiOrario, pulisciTesto,
  type EsitoVisita, type Lettura, type UnitaFerie,
} from "./anagrafica-campi";
import type { Variazioni, Visita } from "./anagrafica-scritture";

export interface CorpoScheda {
  variazioni: Variazioni;
  errori: Record<string, string>;
  decorrenza?: string;
  versione?: number;
  /** le chiavi arrivate (per il controllo dei permessi sui fittizi) */
  chiavi: string[];
}

/** I campi che chi ha solo «scheduling» può cambiare su un conducente FITTIZIO. */
export const CAMPI_SCRIVIBILI_FITTIZI = new Set([
  "cognome", "nome", "residenzaServizio", "categoria", "orarioSettimanaleMin", "scaglioneFerie",
  "rotazioneRiposi", "rotazioneTurni", "abilitazioni", "photoUrl", "patente",
  "patenteValidita", "cqcValidita", "visitaFerrovieValidita", "visitaMedicoCompetenteValidita",
  "cellulare", "dataFineServizio", "decorrenza", "versione",
]);

const FOTO_MAX = 600_000; // un data-URI di 256px in JPEG sta sotto i 60 KB: questo è largo

const presente = (b: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
const vuoto = (v: unknown) => v === null || String(v).trim() === "";

export function leggiCorpoScheda(body: unknown): CorpoScheda {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const v: Variazioni = {};
  const errori: Record<string, string> = {};
  const out: CorpoScheda = { variazioni: v, errori, chiavi: Object.keys(b).filter(k => b[k] !== undefined) };

  /** Applica un lettore: vuoto → null (svuota), errore o valore ignorato → errore sul campo. */
  const con = <T>(k: string, lettore: (x: unknown) => Lettura<T>, metti: (x: T | null) => void) => {
    if (!presente(b, k)) return;
    if (vuoto(b[k])) { metti(null); return; }
    const l = lettore(b[k]);
    if (l === null) metti(null);
    else if (l.ok === true) metti(l.valore);
    else errori[k] = l.ok === false ? l.errore : l.avviso;
  };
  const testo = (k: string, max: number, metti: (x: string | null) => void) => {
    if (!presente(b, k)) return;
    metti(pulisciTesto(b[k], max));
  };
  const anno = new Date().getUTCFullYear();

  con("matricola", leggiMatricola, x => { v.matricola = x; });
  testo("cognome", 80, x => { v.cognome = x; });
  testo("nome", 80, x => { v.nome = x; });
  testo("badge", 20, x => { v.badge = x; });
  con("cf", leggiCodiceFiscale, x => { v.cf = x; });
  con("dataNascita", x => leggiData(x, { min: 1920, max: anno }), x => { v.dataNascita = x; });
  con("dataAssunzione", x => leggiData(x, { min: 1950, max: anno + 1 }), x => { v.dataAssunzione = x; });
  con("dataFineServizio", x => leggiData(x, { min: 1950, max: 2100 }), x => { v.dataFineServizio = x; });
  if (presente(b, "motivoCessazione")) {
    if (vuoto(b.motivoCessazione)) v.motivoCessazione = null;
    else if ((MOTIVI_CESSAZIONE as readonly string[]).includes(String(b.motivoCessazione))) v.motivoCessazione = String(b.motivoCessazione);
    else errori.motivoCessazione = `motivo: ${MOTIVI_CESSAZIONE.join(", ")}`;
  }
  testo("residenzaAnagrafica", 200, x => { v.residenzaAnagrafica = x; });
  for (const k of ["cellulare", "telefono"] as const) {
    if (!presente(b, k)) continue;
    if (vuoto(b[k])) { v[k] = null; continue; }
    const c = cifreTelefono(String(b[k]));
    if (!c) errori[k] = "numero di telefono non valido";
    else v[k] = c;
  }
  testo("inquadramento", 80, x => { v.inquadramento = x; });
  if (presente(b, "parametro")) {
    if (vuoto(b.parametro)) v.parametro = null;
    else {
      const n = Number(b.parametro);
      if ((PARAMETRI as readonly number[]).includes(n)) v.parametro = n;
      else errori.parametro = `parametro ammesso: ${PARAMETRI.join(", ")}`;
    }
  }
  con("ferieAnnue", leggiFerie, x => { v.ferieAnnue = x; });
  if (presente(b, "ferieResidue") || presente(b, "ferieResidueAl")) {
    /* un oggetto, non due let: TypeScript non segue le assegnazioni dentro le callback */
    const fr: { valore: number | null; al: string | null } = { valore: null, al: null };
    con("ferieResidue", leggiFerie, x => { fr.valore = x; });
    con("ferieResidueAl", x => leggiData(x, { min: 2000, max: anno + 2 }), x => { fr.al = x; });
    if (fr.valore !== null && !fr.al) errori.ferieResidueAl = "il residuo ferie va scritto con la data a cui vale";
    v.ferieResidue = fr;
  }
  if (presente(b, "ferieUnita")) {
    if ((UNITA_FERIE as readonly string[]).includes(String(b.ferieUnita))) v.ferieUnita = String(b.ferieUnita) as UnitaFerie;
    else errori.ferieUnita = "unità: giorni o ore";
  }
  testo("scaglioneFerie", 40, x => { v.scaglioneFerie = x; });
  testo("patente", 40, x => { v.patente = x; });
  testo("patenteNumero", 30, x => { v.patenteNumero = x; });
  testo("cqcNumero", 30, x => { v.cqcNumero = x; });
  if (presente(b, "note")) {
    v.note = vuoto(b.note) ? null : String(b.note).replace(/\u0000/g, "").trim().slice(0, 2000);
  }
  if (presente(b, "photoUrl")) {
    if (vuoto(b.photoUrl)) v.photoUrl = null;
    else if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(b.photoUrl)) && String(b.photoUrl).length <= FOTO_MAX) {
      v.photoUrl = String(b.photoUrl);
    } else errori.photoUrl = "foto non valida o troppo grande";
  }
  if (presente(b, "abilitazioni")) {
    if (!Array.isArray(b.abilitazioni)) errori.abilitazioni = "elenco non valido";
    else {
      const ignote = b.abilitazioni.map(String).filter(a => !(ABILITAZIONI as readonly string[]).includes(a));
      if (ignote.length) errori.abilitazioni = `abilitazione sconosciuta: ${ignote.join(", ")}`;
      else v.abilitazioni = b.abilitazioni.map(String);
    }
  }

  /* con storico */
  testo("residenzaServizio", 60, x => { v.deposito = x; });
  testo("categoria", 60, x => { v.categoria = x; });
  con("orarioSettimanaleMin", x => (typeof x === "number" ? leggiOrario(`${x}m`) : leggiOrario(x)), x => { v.orarioSettimanaleMin = x; });
  con("patenteValidita", x => leggiData(x, { min: 1990, max: 2100 }), x => { v.patenteValidita = x; });
  con("cqcValidita", x => leggiData(x, { min: 1990, max: 2100 }), x => { v.cqcValidita = x; });
  const visite: Array<["visitaFerrovie" | "visitaMedicoCompetente", string]> = [
    ["visitaFerrovie", "visitaFerrovie"], ["visitaMedicoCompetente", "visitaMedicoCompetente"],
  ];
  for (const [campo, prefisso] of visite) {
    const vis: Visita = {};
    con(`${prefisso}Data`, x => leggiData(x, { min: 1990, max: anno + 1 }), x => { vis.data = x; });
    con(`${prefisso}Validita`, x => leggiData(x, { min: 1990, max: 2100 }), x => { vis.scadenza = x; });
    if (presente(b, `${prefisso}Esito`)) {
      const e = b[`${prefisso}Esito`];
      if (vuoto(e)) vis.esito = null;
      else if ((ESITI_VISITA as readonly string[]).includes(String(e))) vis.esito = String(e) as EsitoVisita;
      else errori[`${prefisso}Esito`] = "esito non valido";
    }
    if (Object.keys(vis).length) v[campo] = vis;
  }

  /* relazioni */
  if (presente(b, "rotazioneRiposi")) {
    const r = b.rotazioneRiposi as { id?: unknown; scaglione?: unknown } | null;
    if (r === null) v.rotazioneRiposi = null;
    else if (r && typeof r === "object" && /^[0-9a-f-]{36}$/i.test(String(r.id)) && Number.isInteger(Number(r.scaglione))) {
      v.rotazioneRiposi = { id: String(r.id), scaglione: Number(r.scaglione) };
    } else errori.rotazioneRiposi = "rotazione o scaglione non validi";
  }
  if (presente(b, "rotazioneTurni")) {
    const r = b.rotazioneTurni as { gruppo?: unknown; posizione?: unknown } | null;
    if (r === null || (r && vuoto(r.gruppo))) v.rotazioneTurni = null;
    else if (r && typeof r === "object") {
      const pos = vuoto(r.posizione) ? null : Number(r.posizione);
      if (pos !== null && (!Number.isInteger(pos) || pos < 1)) errori.rotazioneTurni = "posizione non valida";
      else v.rotazioneTurni = { gruppo: String(r.gruppo), posizione: pos };
    } else errori.rotazioneTurni = "gruppo non valido";
  }

  if (presente(b, "decorrenza") && !vuoto(b.decorrenza)) {
    const l = leggiData(b.decorrenza, { min: 2000, max: anno + 2 });
    if (l && l.ok === true) out.decorrenza = l.valore;
    else errori.decorrenza = "data di decorrenza non valida";
  }
  if (presente(b, "versione")) {
    const n = Number(b.versione);
    if (Number.isInteger(n) && n >= 0) out.versione = n;
    else errori.versione = "versione non valida";
  }
  return out;
}
