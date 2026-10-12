/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL CONTROLLO SETTIMANALE IN UN FOGLIO EXCEL
 * ───────────────────────────────────────────────────────────────────────────
 * L'allegato del lunedì: chi ha smesso di localizzarsi, chi ha ripreso, chi
 * è ancora guasto, che cosa hanno prodotto gli interventi. Stesso marchio e
 * stessi colori del diario e della pagina AVM: verde per chi si localizza,
 * rosso per chi si è fermato, arancio per chi è ancora guasto.
 *
 * Un foglio per le tre notizie da girare a qualcuno (si sono fermate,
 * riprese, ancora guaste), uno per gli interventi, uno con tutto. Ogni
 * vettura porta la striscia delle 14 giornate e quella delle 8 settimane:
 * è la prova che chi riceve il foglio vede senza chiedere.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  ETICHETTE_CATEGORIA, ETICHETTE_ESITO_INTERVENTO, ORDINE_CATEGORIE, ORDINE_ESITI_INTERVENTO,
  andamentoSettimane, contaCategorie, notaGenerale,
  type Categoria, type ControlloSettimanale, type EsitoIntervento, type VetturaControllo,
} from "./avm-controllo.js";
import { ETICHETTE_ESCLUSIONE } from "./avm-diario.js";
import { ETICHETTE_STATO_OFFICINA } from "./officina.js";
import { scriviXlsx, Stili, type Foglio, type Valore } from "./xlsx-mini.js";
import { CERBERO, logoCerberoPng, LOGO_CERBERO_PX } from "./cerbero-brand.js";

/* I colori della pagina, esadecimali senza cancelletto. */
export const COLORE_CATEGORIA: Record<Categoria, string> = {
  fermata: "F87171", ripresa: "34D399", guasta: "FB923C", nuova: "C084FC",
  uscita: "94A3B8", funziona: "7DD3FC", non_giudicabile: "D4D4D8",
};
/** Le giornate, come nel diario; «-» non elencata, «.» non osservata, « » da venire. */
export const COLORE_CARATTERE_GIORNO: Record<string, string | null> = {
  S: "34D399", T: "7DD3FC", C: "FBBF24", M: "3F3F46", "-": "E4E4E7", ".": null, " ": null,
};
export const COLORE_STATO_SETTIMANA: Record<string, string | null> = {
  F: "34D399", P: "FBBF24", M: "3F3F46", A: "E4E4E7", ".": null,
};
export const COLORE_ESITO_INTERVENTO: Record<EsitoIntervento, string> = {
  riuscito: "34D399", gia_funzionava: "7DD3FC", senza_effetto: "F87171", peggiorato: "FB923C",
  ricaduta: "F87171", senza_confronto: "A7F3D0", da_verificare: "FBBF24", non_nel_flusso: "D4D4D8",
};
const TESTO_CARATTERE: Array<[string, string]> = [
  ["S", "si localizza ed è su una corsa"], ["T", "si localizza, senza corsa"], ["C", "parla col centro, senza posizione"],
  ["M", "elencata, nessun contatto"], ["-", "non elencata dal flusso SIRI"], [".", "giornata non contata (raccolta a metà o assente)"],
  [" ", "giornata non ancora finita"],
];
const TESTO_STATO: Array<[string, string]> = [
  ["F", "si è localizzata almeno un giorno"], ["P", "ha parlato col centro, mai localizzata"],
  ["M", "nessun contatto"], ["A", "non elencata dal flusso SIRI"], [".", "meno di 3 giornate contate: non si giudica"],
];

function ddmm(g: string): string {
  const [, m, d] = g.split("-");
  return `${d}/${m}`;
}
function ddmmyyyy(g: string | null): string {
  return g ? g.slice(0, 10).split("-").reverse().join("/") : "";
}
function oraLocale(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** La cella «Officina»: esclusione, oppure stato · targa · deposito. */
function officinaInBreve(v: VetturaControllo): string {
  if (v.esclusa) return ETICHETTE_ESCLUSIONE[v.esclusa.motivo];
  if (!v.officina) return "";
  return [ETICHETTE_STATO_OFFICINA[v.officina.stato], v.officina.targa, v.officina.deposito].filter(Boolean).join(" · ");
}

/** «x su y»: giornate con posizione su giornate contate, nella settimana sotto controllo. */
function posizioneSu(v: VetturaControllo): string {
  return `${v.settimana.conPosizione} su ${v.settimana.giornateOsservate}`;
}

export interface InfoEsportazione {
  /** il controllo viene dall'archivio (congelato) o è calcolato adesso */
  archiviato: boolean;
  /** descrizione del perimetro esportato, per il sottotitolo */
  perimetro?: string;
}

/**
 * Il foglio completo. `vetture` è il perimetro scelto sulla pagina (solo
 * Conerobus, solo parco officina): il foglio esporta quello che si guardava.
 */
export function esportaControlloXlsx(
  c: ControlloSettimanale,
  vetture: VetturaControllo[] = c.vetture,
  info: InfoEsportazione = { archiviato: false },
): Buffer {
  const st = new Stili();
  const S = {
    banda: st.indice({ fill: CERBERO.navy }),
    titolo: st.indice({ fill: CERBERO.navy, color: CERBERO.bianco, bold: true, size: 20, valign: "center" }),
    sottotitolo: st.indice({ fill: CERBERO.navy, color: "94A7B5", size: 11, valign: "center" }),
    h2: st.indice({ bold: true, size: 13, color: CERBERO.inchiostro }),
    testo: st.indice({ color: CERBERO.inchiostro, wrap: true, valign: "top" }),
    testoTenue: st.indice({ color: CERBERO.inchiostroTenue, size: 10, wrap: true, valign: "top" }),
    intestazione: st.indice({ fill: CERBERO.navy, color: CERBERO.bianco, bold: true, size: 10, border: true, borderColor: "26343F", valign: "center", wrap: true }),
    intestazioneCentro: st.indice({ fill: CERBERO.navy, color: CERBERO.bianco, bold: true, size: 10, border: true, borderColor: "26343F", align: "center", valign: "center", wrap: true }),
    intestazioneSettimana: st.indice({ fill: "26343F", color: CERBERO.bianco, bold: true, size: 9, border: true, borderColor: "0B1220", align: "center", valign: "center", wrap: true }),
    cella: st.indice({ border: true, valign: "top", wrap: true, size: 10, color: CERBERO.inchiostro }),
    cellaMono: st.indice({ border: true, valign: "top", size: 10, color: CERBERO.inchiostro, bold: true }),
    numero: st.indice({ border: true, align: "right", size: 10, color: CERBERO.inchiostro }),
    centro: st.indice({ border: true, align: "center", size: 10, color: CERBERO.inchiostro }),
    vuota: st.indice({ border: true, borderColor: "E4E4E7", align: "center", size: 9, color: "A1A1AA" }),
    valore: st.indice({ size: 10, color: CERBERO.inchiostro }),
  };
  const colorato = (fill: string, opts: { bold?: boolean } = {}) =>
    st.indice({ fill, border: true, size: 10, bold: opts.bold, valign: "top", wrap: true, color: CERBERO.inchiostro, borderColor: "FFFFFF" });
  const quadratino = (fill: string | null, testo: string): Valore =>
    fill ? { v: null, s: st.indice({ fill, border: true, borderColor: "FFFFFF" }) } : { v: testo.trim() ? "·" : null, s: S.vuota };

  const sett = c.settimana;
  const statoSettimana = sett.chiusa ? "settimana chiusa" : "settimana in corso: risultato provvisorio";
  const origine = info.archiviato ? `archiviato il ${oraLocale(c.generatoIl)}` : `calcolato il ${oraLocale(c.generatoIl)}`;
  /* Il sottotitolo sta su due righe della banda: in una sola, dentro celle
   * unite che Excel non lascia traboccare, il perimetro e l'origine sparivano. */
  const sottotitolo = `Settimana dal ${ddmmyyyy(sett.lunedi)} al ${ddmmyyyy(sett.domenica)} · ${statoSettimana}`;
  const sottotitolo2 = `${vetture.length} ${vetture.length === 1 ? "vettura" : "vetture"}`
    + `${info.perimetro ? ` (${info.perimetro})` : ""} · ${origine}`;
  const conteggi = contaCategorie(vetture);

  /* ── Foglio 1: Riepilogo ─────────────────────────────────────────────── */
  const R: Valore[][] = [];
  const banda = (testo: string | null = null, stile = S.banda) =>
    [{ v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: testo, s: stile },
      { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }];
  R.push(banda());
  R.push(banda("Controllo settimanale AVM", S.titolo));
  R.push(banda(sottotitolo, S.sottotitolo));
  R.push(banda(sottotitolo2, S.sottotitolo));
  R.push([]);
  R.push([{ v: "Come leggere", s: S.h2 }]);
  R.push([{ v: "Ogni vettura è confrontata con l'ultima settimana in cui si poteva giudicare. Il metro è l'apparato: "
    + "funziona chi si è localizzato almeno in una giornata contata; la corsa dipende dal conducente e sta nella nota. "
    + "Una giornata conta solo se il connettore l'ha ascoltata almeno per metà.", s: S.testo }]);
  /* La frase di sintesi sulle vetture esportate, come la tabella sotto. */
  R.push([{ v: notaGenerale(sett, sett.chiusa, conteggi, vetture.length), s: S.testoTenue }]);
  R.push([]);

  R.push([{ v: "Le categorie della settimana", s: S.h2 }]);
  R.push([{ v: "Categoria", s: S.intestazione }, { v: "Vetture", s: S.intestazioneCentro }, { v: "Che cosa vuol dire", s: S.intestazione }]);
  for (const cat of ORDINE_CATEGORIE) {
    if (!conteggi[cat]) continue;
    R.push([{ v: ETICHETTE_CATEGORIA[cat].titolo, s: colorato(COLORE_CATEGORIA[cat], { bold: true }) },
      { v: conteggi[cat], s: S.numero }, { v: ETICHETTE_CATEGORIA[cat].perche, s: S.cella }]);
  }
  R.push([]);

  R.push([{ v: `Andamento delle ultime ${c.settimane.length} settimane`, s: S.h2 }]);
  R.push([{ v: "Settimana", s: S.intestazione }, { v: "Giornate contate", s: S.intestazioneCentro },
    { v: "Si localizzano", s: S.intestazioneCentro }, { v: "Parlano soltanto", s: S.intestazioneCentro },
    { v: "Mute", s: S.intestazioneCentro }, { v: "Non nel flusso", s: S.intestazioneCentro }]);
  for (const a of andamentoSettimane(c, vetture)) {
    const giudicabile = a.giornateOsservate > 0;
    R.push([{ v: `${ddmm(a.lunedi)} – ${ddmm(a.domenica)}`, s: S.cella }, { v: a.giornateOsservate, s: S.numero },
      { v: giudicabile ? a.F : "", s: S.numero }, { v: giudicabile ? a.P : "", s: S.numero },
      { v: giudicabile ? a.M : "", s: S.numero }, { v: giudicabile ? a.A : "", s: S.numero }]);
  }
  R.push([]);

  const perimetroRef = new Set(vetture.map(v => v.vehicleRef));
  /* Gli interventi delle vetture esportate, più quelli su vetture che il
   * flusso non elenca (non hanno una riga da filtrare): restano visibili. */
  const interventi = c.interventi.filter(i => perimetroRef.has(i.matricola) || i.esitoAvm === "non_nel_flusso");
  R.push([{ v: "Interventi AVM chiusi (FleetCare)", s: S.h2 }]);
  if (c.fonteInterventi && !c.fonteInterventi.disponibile) {
    R.push([{ v: c.fonteInterventi.motivo ?? "Interventi non disponibili.", s: S.testoTenue }]);
  } else if (!interventi.length) {
    R.push([{ v: "Nessun intervento AVM chiuso nelle settimane guardate, per le vetture esportate.", s: S.testoTenue }]);
  } else {
    R.push([{ v: "Esito sull'apparato", s: S.intestazione }, { v: "Interventi", s: S.intestazioneCentro }]);
    for (const e of ORDINE_ESITI_INTERVENTO) {
      const n = interventi.filter(i => i.esitoAvm === e).length;
      if (n) R.push([{ v: ETICHETTE_ESITO_INTERVENTO[e], s: colorato(COLORE_ESITO_INTERVENTO[e], { bold: true }) }, { v: n, s: S.numero }]);
    }
  }
  R.push([]);
  if (c.officina) {
    R.push([{ v: c.officina.disponibile
      ? `Officina (FleetCare): ${c.officina.mezzi} mezzi nel parco, letto il ${oraLocale(c.officina.lettoAlle)}.`
      : `Officina (FleetCare) non disponibile: ${c.officina.motivo ?? ""}`, s: S.testoTenue }]);
    R.push([]);
  }

  R.push([{ v: "Legenda: le giornate", s: S.h2 }]);
  for (const [ch, t] of TESTO_CARATTERE) R.push([quadratino(COLORE_CARATTERE_GIORNO[ch] ?? null, ch), { v: t, s: S.valore }]);
  R.push([]);
  R.push([{ v: "Legenda: le settimane", s: S.h2 }]);
  for (const [ch, t] of TESTO_STATO) R.push([quadratino(COLORE_STATO_SETTIMANA[ch] ?? null, ch), { v: t, s: S.valore }]);

  const riepilogo: Foglio = {
    nome: "Riepilogo",
    righe: R,
    larghezze: [34, 14, 70, 16, 12, 14, 12, 12],
    altezze: { 1: 18, 2: 30, 3: 18, 4: 18, 7: 48, 8: 30 },
    unioni: ["D2:H2", "D3:H3", "D4:H4", "A7:H7", "A8:H8"],
    immagine: {
      id: 1, cella: "A1",
      larghezzaPx: 200, altezzaPx: Math.round(200 * LOGO_CERBERO_PX.altezza / LOGO_CERBERO_PX.larghezza),
      offsetPx: { x: 10, y: 10 },
    },
  };

  /* ── I fogli delle vetture ───────────────────────────────────────────── */
  const fisse = ["Matricola", "Codice", "Mezzo", "Officina", "Categoria", "Dal", "Posizione (gg)", "Senza posizione (gg)"];
  const testata: Valore[] = [
    ...fisse.map((t, i) => ({ v: t, s: i >= 5 ? S.intestazioneCentro : S.intestazione })),
    ...c.giornate.map((g, i) => ({ v: ddmm(g), s: i < 7 ? S.intestazioneSettimana : S.intestazioneCentro })),
    ...c.settimane.map(s => ({ v: `sett. ${ddmm(s.lunedi)}`, s: S.intestazioneSettimana })),
    { v: "Nota", s: S.intestazione },
  ];
  const rigaVettura = (v: VetturaControllo): Valore[] => [
    { v: v.vehicleRef, s: S.cellaMono },
    { v: v.codice ?? "", s: S.cellaMono },
    { v: v.mezzo ?? (v.codice ? "non in anagrafica" : v.azienda), s: S.cella },
    { v: officinaInBreve(v), s: S.cella },
    { v: ETICHETTE_CATEGORIA[v.categoria].breve, s: colorato(COLORE_CATEGORIA[v.categoria], { bold: true }) },
    { v: v.dal ? ddmmyyyy(v.dal) : "", s: S.centro },
    { v: posizioneSu(v), s: S.centro },
    { v: v.giorniSenzaPosizione ?? "", s: S.numero },
    ...[...v.giorni].map(ch => quadratino(COLORE_CARATTERE_GIORNO[ch] ?? null, ch)),
    ...[...v.storia].map(ch => quadratino(COLORE_STATO_SETTIMANA[ch] ?? null, ch)),
    { v: v.nota, s: S.cella },
  ];
  const larghezze = [11, 9, 38, 30, 16, 12, 12, 12, ...c.giornate.map(() => 5), ...c.settimane.map(() => 7), 90];
  const foglioVetture = (nome: string, elenco: VetturaControllo[], vuoto: string): Foglio => ({
    nome,
    righe: elenco.length ? [testata, ...elenco.map(rigaVettura)] : [testata, [{ v: vuoto, s: S.cella }]],
    larghezze,
    altezze: { 1: 32 },
    blocca: { righe: 1, colonne: 1 },
  });
  const di = (cat: Categoria) => vetture.filter(v => v.categoria === cat);

  /* ── Foglio: Interventi ──────────────────────────────────────────────── */
  const I: Valore[][] = [[
    { v: "Matricola", s: S.intestazione }, { v: "Mezzo", s: S.intestazione }, { v: "Fonte", s: S.intestazione },
    { v: "Riferimento", s: S.intestazione }, { v: "Chiuso il", s: S.intestazioneCentro }, { v: "Descrizione", s: S.intestazione },
    { v: "Esito sull'apparato", s: S.intestazione }, { v: "Prima (gg con posizione)", s: S.intestazioneCentro },
    { v: "Dopo (gg con posizione)", s: S.intestazioneCentro }, { v: "Prima posizione dopo", s: S.intestazioneCentro },
  ]];
  const perRef = new Map(vetture.map(v => [v.vehicleRef, v]));
  for (const i of interventi) {
    const v = perRef.get(i.matricola);
    I.push([
      { v: i.matricola, s: S.cellaMono }, { v: v?.mezzo ?? "", s: S.cella }, { v: i.fonte, s: S.cella },
      { v: i.riferimento, s: S.cellaMono }, { v: ddmmyyyy(i.giornoChiusura), s: S.centro },
      { v: i.descrizione ?? "", s: S.cella },
      { v: ETICHETTE_ESITO_INTERVENTO[i.esitoAvm], s: colorato(COLORE_ESITO_INTERVENTO[i.esitoAvm], { bold: true }) },
      { v: `${i.posizionePrima} su ${i.giorniPrima}`, s: S.centro }, { v: `${i.posizioneDopo} su ${i.giorniDopo}`, s: S.centro },
      { v: i.primaPosizioneDopo ? ddmmyyyy(i.primaPosizioneDopo) : "", s: S.centro },
    ]);
  }
  if (interventi.length === 0) {
    I.push([{ v: c.fonteInterventi && !c.fonteInterventi.disponibile
      ? (c.fonteInterventi.motivo ?? "Interventi non disponibili.")
      : "Nessun intervento AVM chiuso nelle settimane guardate.", s: S.cella }]);
  }
  const interventiFoglio: Foglio = {
    nome: "Interventi",
    righe: I,
    larghezze: [11, 38, 14, 16, 12, 50, 36, 14, 14, 14],
    altezze: { 1: 32 },
    blocca: { righe: 1, colonne: 1 },
  };

  const fogli: Foglio[] = [
    riepilogo,
    foglioVetture("Si sono fermate", di("fermata"), "Nessuna vettura ha smesso di localizzarsi questa settimana."),
    foglioVetture("Riprese", di("ripresa"), "Nessuna vettura ha ripreso a localizzarsi questa settimana."),
    foglioVetture("Ancora guaste", di("guasta"), "Nessuna vettura resta senza posizione."),
    interventiFoglio,
    foglioVetture("Tutte", vetture, "Nessuna vettura nel perimetro esportato."),
  ];
  return scriviXlsx(fogli, st, [{ id: 1, png: logoCerberoPng() }]);
}

/** Le colonne del CSV, una riga per vettura: per chi deve incrociare i dati. */
export function esportaControlloCsv(c: ControlloSettimanale, vetture: VetturaControllo[] = c.vetture): string {
  /* giorni: S T C M come sulla pagina, «_» non elencata, «.» non contata, « » non ancora finita */
  const testata = ["matricola", "codice", "azienda", "mezzo", "categoria", "dal", "stato_settimana",
    "giornate_contate", "giornate_con_posizione", "giornate_con_corsa", "settimana_prima", "stato_prima",
    "ultima_posizione", "giornate_senza_posizione", "giorni", "storia", "officina", "targa",
    "interventi", "nota"];
  const righe = vetture.map(v => [
    v.vehicleRef, v.codice ?? "", v.azienda, v.mezzo ?? "", ETICHETTE_CATEGORIA[v.categoria].breve, v.dal ?? "",
    v.settimana.stato, v.settimana.giornateOsservate, v.settimana.conPosizione, v.settimana.conCorsa,
    v.prima?.lunedi ?? "", v.prima?.stato ?? "", v.ultimaPosizione ?? "", v.giorniSenzaPosizione ?? "",
    strisciaCsv(v.giorni), v.storia, officinaInBreve(v), v.officina?.targa ?? "",
    v.interventi.map(i => `${i.riferimento} ${i.giornoChiusura} ${i.esitoAvm}`).join(" | "), v.nota,
  ]);
  return "﻿" + [testata, ...righe]
    .map(r => r.map(x => `"${cellaCsv(x).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");
}

/**
 * La striscia delle giornate nel CSV: «-» (non elencata) diventa «_», così
 * nessuna striscia comincia con un segno che Excel legge come formula, e
 * nessuna ha bisogno dell'apostrofo che la renderebbe lunga 15 caratteri
 * invece di 14, sfasando i giorni per chi la legge con un programma.
 */
export function strisciaCsv(giorni: string): string {
  return giorni.replace(/-/g, "_");
}

/**
 * Una cella CSV che Excel non scambia per una formula: un testo che comincia
 * con = + - @ è il varco classico dell'iniezione di formule. L'apostrofo
 * davanti lo fa leggere come testo.
 */
export function cellaCsv(x: unknown): string {
  const s = String(x ?? "");
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
