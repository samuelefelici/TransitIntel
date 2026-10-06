/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL DIARIO AVM IN UN FOGLIO — l'allegato della segnalazione
 * ───────────────────────────────────────────────────────────────────────────
 * Il CSV bastava a chi lo apre in Excel per conto suo. Non basta a chi lo
 * riceve come allegato di una segnalazione: quello lo apre, guarda la prima
 * schermata, e decide se fidarsi. Questo foglio è pensato per quel momento:
 * in cima il marchio e il periodo, poi i numeri del periodo, poi le vetture
 * una per riga con la stessa striscia di colori della pagina, giorno per
 * giorno. Chi ha davanti la pagina e chi ha davanti il foglio vedono la
 * stessa cosa, coi medesimi colori: è quello che rende la segnalazione
 * difendibile senza essere presenti.
 *
 * I colori sono quelli della pagina AVM, non una tavolozza da stampa: se qui
 * «funziona» fosse di un altro verde, la prima domanda al telefono sarebbe
 * quale dei due è quello giusto.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  type DiarioSettimana, type VetturaSettimana, type EsitoSettimana, type EsitoGiorno, type Avviso,
  ETICHETTE_ESITO, ETICHETTE_AVVISO, ETICHETTE_ESCLUSIONE,
} from "./avm-diario.js";
import { ETICHETTE_STATO_OFFICINA } from "./officina.js";

/** La cella «Officina»: il motivo dell'esclusione, oppure stato · targa · deposito. */
function officinaInBreve(v: VetturaSettimana): string {
  if (v.esclusa) return ETICHETTE_ESCLUSIONE[v.esclusa.motivo];
  if (!v.officina) return "";
  return [ETICHETTE_STATO_OFFICINA[v.officina.stato], v.officina.targa, v.officina.deposito]
    .filter(Boolean).join(" · ");
}
import { scriviXlsx, Stili, lettereColonna, type Foglio, type Valore } from "./xlsx-mini.js";
import { CERBERO, logoCerberoPng, LOGO_CERBERO_PX } from "./cerbero-brand.js";

/* I colori della pagina, esadecimali senza cancelletto. */
const COLORE_ESITO: Record<EsitoSettimana, string> = {
  funziona: "34D399", senza_corsa: "7DD3FC", senza_posizione: "FB923C", non_attivata: "C084FC", muta: "F87171",
};
const COLORE_GIORNO: Record<EsitoGiorno, string> = {
  in_servizio: "34D399", traccia: "7DD3FC", collegata: "FBBF24", muta: "3F3F46",
};
const TESTO_GIORNO: Record<EsitoGiorno, string> = {
  in_servizio: "in servizio", traccia: "si localizza", collegata: "collegata, senza posizione", muta: "nessun contatto",
};
const COLORE_AVVISO: Record<Avviso, string> = {
  smessa: "F87171", antenna: "FB923C", da_attivare: "C084FC", intermittente: "FBBF24",
};
const BREVE_AVVISO: Record<Avviso, string> = {
  smessa: "Ha smesso", antenna: "Antenna GPS", da_attivare: "Da attivare", intermittente: "A sprazzi",
};

/** Le colonne fisse del foglio Vetture, prima di quelle dei giorni. */
const COLONNE_FISSE = ["Matricola", "Codice", "Mezzo", "Officina", "Verdetto", "Avviso", "Destinatario", "Giornate",
  "Contatto (gg)", "Seguita dal centro (gg)", "Posizione (gg)", "Corse (gg)", "Corse distinte", "Silenzio (gg)",
  "A sprazzi", "Ultimo contatto", "Linee viste"];

export interface TestoSegnalazione {
  destinatario: string; oggetto: string; testo: string; matricole: number;
}

function ddmm(g: string): string {
  const [, m, d] = g.split("-");
  return `${d}/${m}`;
}
function ddmmyyyy(g: string): string {
  return g.split("-").reverse().join("/");
}
function oraLocale(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Il foglio completo. `vetture` è il perimetro scelto sulla pagina (per
 * esempio solo Conerobus): il foglio esporta quello che si stava guardando,
 * non tutto, perché un allegato con 369 righe di cui 200 non pertinenti è un
 * allegato che nessuno legge.
 */
export function esportaDiarioXlsx(
  d: DiarioSettimana,
  periodo: { da: string; a: string },
  testi: TestoSegnalazione[],
  vetture: VetturaSettimana[] = d.vetture,
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
    cella: st.indice({ border: true, valign: "top", wrap: true, size: 10, color: CERBERO.inchiostro }),
    cellaMono: st.indice({ border: true, valign: "top", size: 10, color: CERBERO.inchiostro, bold: true }),
    numero: st.indice({ border: true, align: "right", size: 10, color: CERBERO.inchiostro }),
    centro: st.indice({ border: true, align: "center", size: 10, color: CERBERO.inchiostro }),
    etichetta: st.indice({ bold: true, size: 10, color: CERBERO.inchiostroTenue }),
    valore: st.indice({ size: 10, color: CERBERO.inchiostro }),
  };
  const colorato = (fill: string, opts: { bold?: boolean; align?: "left" | "center" | "right"; chiaro?: boolean } = {}) =>
    st.indice({ fill, border: true, size: 10, bold: opts.bold, align: opts.align, valign: "top", wrap: true,
      color: opts.chiaro ? CERBERO.bianco : CERBERO.inchiostro, borderColor: "FFFFFF" });
  const quadratino = (e: EsitoGiorno) => st.indice({ fill: COLORE_GIORNO[e], border: true, borderColor: "FFFFFF" });

  const giornate = d.perGiorno.filter(g => !g.parziale).map(g => g.giorno);
  const sottotitolo = `Osservazione del canale SIRI dal ${ddmmyyyy(periodo.da)} al ${ddmmyyyy(periodo.a)}`
    + ` · ${d.giornateOsservate} giornate contate · ${vetture.length} vetture`;

  /* ── Foglio 1: Riepilogo ─────────────────────────────────────────────── */
  const R: Valore[][] = [];
  const banda = (testo: Valore = null, stile = S.banda) =>
    [{ v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: typeof testo === "object" && testo ? testo.v : testo, s: stile },
      { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }];
  R.push(banda());
  R.push(banda("Diario AVM", S.titolo));
  R.push(banda(sottotitolo, S.sottotitolo));
  R.push(banda());
  R.push([]);
  R.push([{ v: "Come leggere", s: S.h2 }]);
  R.push([{ v: "Ogni vettura è osservata giornata per giornata dal canale SIRI, un campione ogni due minuti. "
    + "Il verdetto dice che cosa ha dimostrato di saper fare nel periodo; l'avviso dice che cosa va guardato adesso. "
    + "Una giornata conta solo se il connettore l'ha ascoltata almeno per metà.", s: S.testo }]);
  R.push([{ v: `Raccolta: ${d.qualita.nota}${d.giornateSenzaDati.length ? ` Giornate senza dati: ${d.giornateSenzaDati.map(ddmm).join(", ")}.` : ""}`, s: S.testoTenue }]);
  R.push([]);

  R.push([{ v: "Verdetto della settimana", s: S.h2 }]);
  R.push([{ v: "Verdetto", s: S.intestazione }, { v: "Vetture", s: S.intestazioneCentro }, { v: "Che cosa vuol dire", s: S.intestazione }]);
  const perEsito = (["funziona", "senza_corsa", "senza_posizione", "non_attivata", "muta"] as EsitoSettimana[])
    .map(e => ({ e, n: vetture.filter(v => v.esito === e).length })).filter(x => x.n > 0);
  const SPIEGA: Record<EsitoSettimana, string> = {
    funziona: "ha fatto almeno una corsa: l'intera catena funziona",
    senza_corsa: "si localizza ma non ha mai agganciato una corsa: turno a bordo o grafo",
    senza_posizione: "parla, dichiara errore GPS, mai localizzata: antenna",
    non_attivata: "parla senza errori a bordo, mai localizzata dal centro: attivazione",
    muta: "nessun contatto in tutto il periodo",
  };
  for (const { e, n } of perEsito) {
    R.push([{ v: ETICHETTE_ESITO[e], s: colorato(COLORE_ESITO[e], { bold: true }) }, { v: n, s: S.numero }, { v: SPIEGA[e], s: S.cella }]);
  }
  R.push([]);

  R.push([{ v: "Dispositivi da controllare adesso", s: S.h2 }]);
  R.push([{ v: "Avviso", s: S.intestazione }, { v: "Vetture", s: S.intestazioneCentro }, { v: "Matricole", s: S.intestazione }]);
  const perimetro = new Set(vetture.map(v => v.vehicleRef));
  const avvisi = d.avvisi.map(a => ({ ...a, matricole: a.matricole.filter(m => perimetro.has(m)) })).filter(a => a.matricole.length);
  if (!avvisi.length) R.push([{ v: "Nessun dispositivo da controllare nel perimetro esportato.", s: S.cella }]);
  for (const a of avvisi) {
    R.push([{ v: ETICHETTE_AVVISO[a.avviso].titolo, s: colorato(COLORE_AVVISO[a.avviso], { bold: true }) },
      { v: a.matricole.length, s: S.numero }, { v: a.matricole.join(", "), s: S.cella }]);
  }
  R.push([]);

  R.push([{ v: "Andamento giorno per giorno", s: S.h2 }]);
  R.push([{ v: "Giornata", s: S.intestazione }, { v: "In servizio", s: S.intestazioneCentro }, { v: "Si localizzano", s: S.intestazioneCentro },
    { v: "Collegate", s: S.intestazioneCentro }, { v: "Mute", s: S.intestazioneCentro }, { v: "Campioni", s: S.intestazioneCentro }, { v: "Conta", s: S.intestazioneCentro }]);
  for (const g of d.perGiorno) {
    R.push([{ v: ddmmyyyy(g.giorno), s: S.cella }, { v: g.inServizio, s: S.numero }, { v: g.traccia, s: S.numero },
      { v: g.collegata, s: S.numero }, { v: g.muta, s: S.numero }, { v: g.campioni, s: S.numero },
      { v: g.parziale ? "no: raccolta a metà" : "sì", s: S.centro }]);
  }
  R.push([]);
  R.push([{ v: "Legenda dei colori nel foglio Vetture", s: S.h2 }]);
  for (const e of ["in_servizio", "traccia", "collegata", "muta"] as EsitoGiorno[]) {
    R.push([{ v: null, s: quadratino(e) }, { v: TESTO_GIORNO[e], s: S.valore }]);
  }

  const riepilogo: Foglio = {
    nome: "Riepilogo",
    righe: R,
    larghezze: [34, 12, 70, 14, 12, 12, 18, 12],
    altezze: { 1: 18, 2: 30, 3: 18, 4: 18, 7: 48, 8: 30 },
    unioni: ["D2:H2", "D3:H3", "A7:H7", "A8:H8"],
    immagine: {
      id: 1, cella: "A1",
      larghezzaPx: 200, altezzaPx: Math.round(200 * LOGO_CERBERO_PX.altezza / LOGO_CERBERO_PX.larghezza),
      offsetPx: { x: 10, y: 10 },
    },
  };

  /* ── Foglio 2: Vetture ───────────────────────────────────────────────── */
  const fisse = COLONNE_FISSE;
  const testata: Valore[] = [
    ...fisse.map((t, i) => ({ v: t, s: i >= 7 && i <= 14 ? S.intestazioneCentro : S.intestazione })),
    ...giornate.map(g => ({ v: ddmm(g), s: S.intestazioneCentro })),
    { v: "Nota", s: S.intestazione }, { v: "Azione", s: S.intestazione },
  ];
  const V: Valore[][] = [testata];
  for (const v of vetture) {
    const perGiorno = new Map(v.perGiorno.map(g => [g.giorno, g.esito]));
    V.push([
      { v: v.vehicleRef, s: S.cellaMono },
      /* Il codice FlashNet e il mezzo: è quello che l'officina riconosce, e
       * la segnalazione «1372» da sola la farebbe cercare in un altro elenco. */
      { v: v.codice ?? "", s: S.cellaMono },
      { v: v.mezzo ?? (v.codice ? "non in anagrafica" : v.azienda), s: S.cella },
      /* Quello che dice l'officina: perché la vettura esce dalle
       * segnalazioni, se esce, altrimenti stato, targa e deposito. */
      { v: officinaInBreve(v), s: S.cella },
      { v: ETICHETTE_ESITO[v.esito], s: colorato(COLORE_ESITO[v.esito]) },
      v.avviso ? { v: BREVE_AVVISO[v.avviso] + (v.avviso === "smessa" && v.giorniDaBuono != null ? ` da ${v.giorniDaBuono} gg` : ""), s: colorato(COLORE_AVVISO[v.avviso]) } : { v: "", s: S.cella },
      { v: v.destinatario === "nessuno" ? "" : v.destinatario, s: S.cella },
      { v: v.giornate, s: S.numero }, { v: v.giorniConContatto, s: S.numero }, { v: v.giorniMonitorata, s: S.numero },
      { v: v.giorniConPosizione, s: S.numero }, { v: v.giorniConCorsa, s: S.numero }, { v: v.corse, s: S.numero },
      { v: v.giorniDiSilenzio, s: S.numero }, { v: v.intermittente ? "sì" : "", s: S.centro },
      { v: oraLocale(v.ultimoContatto), s: S.cella },
      { v: v.linee.join(" · "), s: S.cella },
      ...giornate.map(g => {
        const e = perGiorno.get(g);
        return e ? { v: null, s: quadratino(e) } : { v: null, s: S.cella };
      }),
      { v: v.nota, s: S.cella }, { v: v.azione, s: S.cella },
    ]);
  }
  const vettureFoglio: Foglio = {
    nome: "Vetture",
    righe: V,
    larghezze: [11, 9, 40, 34, 30, 16, 13, 9, 9, 9, 9, 9, 9, 9, 8, 17, 42, ...giornate.map(() => 5), 60, 60],
    altezze: { 1: 42 },
    blocca: { righe: 1, colonne: 1 },
  };

  /* ── Foglio 3: Segnalazioni ──────────────────────────────────────────── */
  const G: Valore[][] = [];
  G.push([{ v: "Segnalazioni da mandare", s: S.h2 }]);
  G.push([{ v: "Una per destinatario. Il testo è pronto da incollare in una mail; questo foglio è l'allegato.", s: S.testoTenue }]);
  G.push([]);
  G.push([{ v: "Destinatario", s: S.intestazione }, { v: "Vetture", s: S.intestazioneCentro }, { v: "Oggetto", s: S.intestazione }, { v: "Testo", s: S.intestazione }]);
  for (const t of testi) {
    const esito = d.segnalazioni.find(s => s.destinatario === t.destinatario)?.esito;
    G.push([
      { v: t.destinatario, s: esito ? colorato(COLORE_ESITO[esito], { bold: true }) : S.cellaMono },
      { v: t.matricole, s: S.numero }, { v: t.oggetto, s: S.cella }, { v: t.testo, s: S.cella },
    ]);
  }
  const segnalazioni: Foglio = {
    nome: "Segnalazioni",
    righe: G,
    larghezze: [16, 9, 60, 110],
    altezze: Object.fromEntries(testi.map((_, i) => [i + 5, 150])),
  };

  return scriviXlsx([riepilogo, vettureFoglio, segnalazioni], st, [{ id: 1, png: logoCerberoPng() }]);
}

/** Per i test e per chi vuole sapere quante colonne di giorni aspettarsi. */
export function colonneGiorni(d: DiarioSettimana): string[] {
  return d.perGiorno.filter(g => !g.parziale).map(g => lettereColonna(COLONNE_FISSE.length + d.perGiorno.filter(x => !x.parziale).indexOf(g)));
}
