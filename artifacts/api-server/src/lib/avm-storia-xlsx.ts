/**
 * ═══════════════════════════════════════════════════════════════════════════
 * L'ANDAMENTO DELL'AVM IN UN FOGLIO EXCEL
 * ───────────────────────────────────────────────────────────────────────────
 * Il foglio da girare a chi lavora sugli apparati: il riepilogo con
 * l'andamento settimana per settimana e i testi per Mizar, poi un foglio per
 * ognuna delle azioni (da riparare, da togliere da SIRI, da aggiungere, da
 * verificare), le richieste a Mizar e tutte le vetture. Stesso marchio e
 * stessi colori del controllo settimanale.
 *
 * Le richieste non portano i nomi di chi le ha segnate: il foglio gira fuori
 * da Cerbero, e per sapere a che punto è una richiesta il nome non serve.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  ETICHETTE_AZIONE, ORDINE_AZIONI, andamentoStoria, contaAzioni, fraseAndamento, testiMizar,
  type Azione, type RichiestaVista, type StoriaAvm, type VetturaStoria,
} from "./avm-storia.js";
import { ETICHETTE_ESITO_INTERVENTO } from "./avm-controllo.js";
import { ETICHETTE_ESCLUSIONE } from "./avm-diario.js";
import { ETICHETTE_STATO_OFFICINA } from "./officina.js";
import { COLORE_STATO_SETTIMANA } from "./avm-controllo-xlsx.js";
import { scriviXlsx, Stili, type Foglio, type Valore } from "./xlsx-mini.js";
import { CERBERO, logoCerberoPng, LOGO_CERBERO_PX } from "./cerbero-brand.js";

export const COLORE_AZIONE: Record<Azione, string> = {
  da_riparare: "FB923C", da_togliere_da_siri: "F87171", da_aggiungere_a_siri: "C084FC",
  da_verificare_alienata: "FBBF24", instabile: "FDE68A", riparata: "34D399", funziona: "7DD3FC",
  non_giudicabile: "D4D4D8", gia_tolta: "E4E4E7",
};

const TESTO_STATO: Array<[string, string]> = [
  ["F", "si è localizzata almeno un giorno"], ["P", "ha parlato col centro, mai localizzata"],
  ["M", "elencata, nessun contatto"], ["A", "non elencata dal flusso SIRI"], [".", "meno di 3 giornate contate: non si giudica"],
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

function officinaInBreve(v: VetturaStoria): string {
  if (v.esclusa) return ETICHETTE_ESCLUSIONE[v.esclusa.motivo];
  if (!v.officina) return "";
  return [ETICHETTE_STATO_OFFICINA[v.officina.stato], v.officina.targa, v.officina.deposito].filter(Boolean).join(" · ");
}

function richiestaInBreve(r: RichiestaVista | null): string {
  if (!r) return "";
  const cosa = r.tipo === "togliere" ? "togliere" : "aggiungere";
  if (r.esito == null) return `${cosa}: inviata il ${ddmmyyyy(r.richiestaIl)}, da ${r.giorniAttesa} giorni`;
  if (r.esito === "annullata") return `${cosa}: annullata il ${ddmmyyyy(r.chiusaIl)}`;
  return `${cosa}: fatta il ${ddmmyyyy(r.chiusaIl)}${r.automatica ? " (verificata da Cerbero)" : ""}`
    + `${r.ricomparsaIl ? `, ricomparsa il ${ddmmyyyy(r.ricomparsaIl)}` : ""}`;
}

export interface InfoStoriaXlsx {
  /** descrizione del perimetro esportato, per il sottotitolo */
  perimetro?: string;
  /** le vetture che contano nell'andamento, se diverse (senza fuori parco e dismesse) */
  andamento?: VetturaStoria[];
  officina?: { disponibile: boolean; motivo: string | null; lettoAlle: string; mezzi: number } | null;
}

/**
 * Il foglio completo. `vetture` è il perimetro scelto (solo Conerobus): conteggi,
 * testi per Mizar, fogli e richieste contano quelle. L'andamento conta
 * `info.andamento` se c'è (senza fuori parco e dismesse, come nella pagina).
 */
export function esportaStoriaXlsx(s: StoriaAvm, vetture: VetturaStoria[] = s.vetture, info: InfoStoriaXlsx = {}): Buffer {
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

  const andamento = andamentoStoria(s, info.andamento ?? vetture);
  const senzaAlienate = !!info.andamento && info.andamento.length !== vetture.length;
  const conteggi = contaAzioni(vetture);
  const testi = testiMizar({ ...s, vetture });
  const primaSettimana = s.settimane[0];
  const sottotitolo = `Dal ${ddmmyyyy(primaSettimana?.lunedi ?? s.inizio)} al ${ddmmyyyy(s.oggi)} · `
    + `${s.settimane.length} settimane · calcolato il ${oraLocale(s.generatoIl)}`;
  const sottotitolo2 = `${vetture.length} ${vetture.length === 1 ? "vettura" : "vetture"}`
    + `${info.perimetro ? ` (${info.perimetro})` : ""}`;

  /* ── Foglio 1: Riepilogo ─────────────────────────────────────────────── */
  const R: Valore[][] = [];
  const banda = (testo: string | null = null, stile = S.banda) =>
    [{ v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: testo, s: stile },
      { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }];
  R.push(banda());
  R.push(banda("Andamento AVM", S.titolo));
  R.push(banda(sottotitolo, S.sottotitolo));
  R.push(banda(sottotitolo2, S.sottotitolo));
  R.push([]);
  R.push([{ v: "Come leggere", s: S.h2 }]);
  R.push([{ v: "Una vettura funziona in una settimana se si è localizzata almeno in una giornata contata, come nel "
    + "controllo settimanale."
    + (senzaAlienate
      ? " Nell'andamento il perimetro è il parco di oggi: le vetture che FleetCare dà fuori parco o dismesse adesso "
        + "escono da tutte le settimane, così i numeri misurano i lavori sugli apparati e non il parco che cambia. "
        + "Restano invece nei fogli delle azioni, perché vanno tolte da SIRI."
      : ""), s: S.testo }]);
  R.push([{ v: fraseAndamento(andamento), s: S.testoTenue }]);
  R.push([]);

  R.push([{ v: "Che cosa c'è da fare", s: S.h2 }]);
  R.push([{ v: "Azione", s: S.intestazione }, { v: "Vetture", s: S.intestazioneCentro }, { v: "Che cosa vuol dire", s: S.intestazione }]);
  for (const a of ORDINE_AZIONI) {
    if (!conteggi[a]) continue;
    R.push([{ v: ETICHETTE_AZIONE[a].titolo, s: colorato(COLORE_AZIONE[a], { bold: true }) },
      { v: conteggi[a], s: S.numero }, { v: ETICHETTE_AZIONE[a].perche, s: S.cella }]);
  }
  R.push([]);

  R.push([{ v: "Settimana per settimana", s: S.h2 }]);
  R.push([{ v: "Settimana", s: S.intestazione }, { v: "Giornate contate", s: S.intestazioneCentro },
    { v: "Si localizzano", s: S.intestazioneCentro }, { v: "Parlano soltanto", s: S.intestazioneCentro },
    { v: "Mute", s: S.intestazioneCentro }, { v: "Non nel flusso", s: S.intestazioneCentro },
    { v: "% che si localizzano", s: S.intestazioneCentro }]);
  for (const w of andamento) {
    const tot = w.F + w.P + w.M + w.A;
    const giudicabile = w.giornateContate > 0;
    R.push([{ v: `${ddmm(w.lunedi)} – ${ddmm(w.domenica)}${w.chiusa ? "" : " (in corso)"}`, s: S.cella },
      { v: w.giornateContate, s: S.numero },
      { v: giudicabile ? w.F : "", s: S.numero }, { v: giudicabile ? w.P : "", s: S.numero },
      { v: giudicabile ? w.M : "", s: S.numero }, { v: giudicabile ? w.A : "", s: S.numero },
      { v: giudicabile && tot ? `${Math.round((100 * w.F) / tot)}%` : "", s: S.numero }]);
  }
  R.push([]);

  R.push([{ v: "Da mandare a Mizar", s: S.h2 }]);
  for (const t of [testi.togliere, testi.aggiungere]) {
    if (!t) continue;
    R.push([{ v: t.oggetto, s: S.testo }]);
    R.push([{ v: t.testo, s: S.testoTenue }]);
  }
  if (!testi.togliere && !testi.aggiungere) {
    R.push([{ v: "Niente da chiedere: le vetture da togliere o da aggiungere hanno già una richiesta aperta, o non ce ne sono.", s: S.testoTenue }]);
  }
  R.push([]);
  if (info.officina) {
    R.push([{ v: info.officina.disponibile
      ? `Officina (FleetCare): ${info.officina.mezzi} mezzi nel parco, letto il ${oraLocale(info.officina.lettoAlle)}.`
      : `Officina (FleetCare) non disponibile: ${info.officina.motivo ?? ""} Le liste da togliere, da aggiungere `
        + "e da verificare restano vuote.", s: S.testoTenue }]);
    R.push([]);
  }
  R.push([{ v: "Legenda: le settimane", s: S.h2 }]);
  for (const [ch, t] of TESTO_STATO) R.push([quadratino(COLORE_STATO_SETTIMANA[ch] ?? null, ch), { v: t, s: S.valore }]);

  const riepilogo: Foglio = {
    nome: "Riepilogo",
    righe: R,
    larghezze: [34, 14, 70, 16, 12, 14, 14, 12],
    altezze: { 1: 18, 2: 30, 3: 18, 4: 18, 7: 48, 8: 30 },
    unioni: ["D2:H2", "D3:H3", "D4:H4", "A7:H7", "A8:H8"],
    immagine: {
      id: 1, cella: "A1",
      larghezzaPx: 200, altezzaPx: Math.round(200 * LOGO_CERBERO_PX.altezza / LOGO_CERBERO_PX.larghezza),
      offsetPx: { x: 10, y: 10 },
    },
  };

  /* ── I fogli delle vetture ───────────────────────────────────────────── */
  const fisse = ["Matricola", "Codice", "Mezzo", "Officina", "Azione", "Senza posizione (sett.)",
    "Ultima posizione", "Ultimo contatto", "Ultimo intervento", "Richiesta a Mizar"];
  const testata: Valore[] = [
    ...fisse.map((t, i) => ({ v: t, s: i >= 5 && i <= 7 ? S.intestazioneCentro : S.intestazione })),
    ...s.settimane.map(w => ({ v: ddmm(w.lunedi), s: S.intestazioneSettimana })),
    { v: "Perché", s: S.intestazione },
  ];
  const rigaVettura = (v: VetturaStoria): Valore[] => [
    { v: v.vehicleRef, s: S.cellaMono },
    { v: v.codice ?? "", s: S.cellaMono },
    { v: v.mezzo ?? (v.codice ? "non in anagrafica" : v.azienda), s: S.cella },
    { v: officinaInBreve(v), s: S.cella },
    { v: ETICHETTE_AZIONE[v.azione].breve, s: colorato(COLORE_AZIONE[v.azione], { bold: true }) },
    { v: v.settimaneSenzaPosizione ?? "", s: S.numero },
    { v: ddmmyyyy(v.ultimaPosizione), s: S.centro },
    { v: ddmmyyyy(v.ultimoContatto), s: S.centro },
    { v: v.ultimoIntervento
      ? `${v.ultimoIntervento.riferimento} (${ddmmyyyy(v.ultimoIntervento.giornoChiusura)}): `
        + ETICHETTE_ESITO_INTERVENTO[v.ultimoIntervento.esitoAvm]
      : "", s: S.cella },
    { v: richiestaInBreve(v.richiesta), s: S.cella },
    ...[...v.storia].map(ch => quadratino(COLORE_STATO_SETTIMANA[ch] ?? null, ch)),
    { v: v.perche, s: S.cella },
  ];
  const larghezze = [11, 9, 34, 28, 16, 12, 13, 13, 36, 30, ...s.settimane.map(() => 4), 90];
  const foglioVetture = (nome: string, elenco: VetturaStoria[], vuoto: string): Foglio => ({
    nome,
    righe: elenco.length ? [testata, ...elenco.map(rigaVettura)] : [testata, [{ v: vuoto, s: S.cella }]],
    larghezze,
    altezze: { 1: 32 },
    blocca: { righe: 1, colonne: 1 },
  });
  const di = (a: Azione) => vetture.filter(v => v.azione === a);

  /* ── Foglio: Richieste a Mizar (senza nomi) ───────────────────────────── */
  const perimetroRef = new Set(vetture.map(v => v.vehicleRef));
  const richieste = s.richieste.filter(r => perimetroRef.has(r.vehicleRef));
  const Q: Valore[][] = [[
    { v: "Matricola", s: S.intestazione }, { v: "Richiesta", s: S.intestazione },
    { v: "Inviata il", s: S.intestazioneCentro }, { v: "Giorni", s: S.intestazioneCentro },
    { v: "Stato", s: S.intestazione }, { v: "Nota", s: S.intestazione },
  ]];
  for (const r of richieste) {
    Q.push([
      { v: r.vehicleRef, s: S.cellaMono },
      { v: r.tipo === "togliere" ? "Togliere da SIRI" : "Aggiungere a SIRI", s: S.cella },
      { v: ddmmyyyy(r.richiestaIl), s: S.centro },
      { v: r.giorniAttesa, s: S.numero },
      { v: r.esito == null
        ? (r.sollecitare ? "In attesa: da sollecitare" : "In attesa")
        : richiestaInBreve(r).replace(/^[a-z]+: /, ""), s: S.cella },
      { v: r.nota ?? "", s: S.cella },
    ]);
  }
  if (!richieste.length) Q.push([{ v: "Nessuna richiesta a Mizar segnata per le vetture esportate.", s: S.cella }]);
  const richiesteFoglio: Foglio = {
    nome: "Richieste a Mizar",
    righe: Q,
    larghezze: [11, 20, 12, 10, 50, 50],
    altezze: { 1: 32 },
    blocca: { righe: 1, colonne: 1 },
  };

  const fogli: Foglio[] = [
    riepilogo,
    foglioVetture("Da riparare", di("da_riparare"), "Nessuna vettura da riparare."),
    foglioVetture("Da togliere da SIRI", di("da_togliere_da_siri"), "Nessuna vettura da togliere dal flusso SIRI."),
    foglioVetture("Da aggiungere a SIRI", di("da_aggiungere_a_siri"), "Nessuna vettura del parco manca dal flusso SIRI."),
    foglioVetture("Da verificare", di("da_verificare_alienata"), "Nessuna vettura muta da settimane che l'officina dà in servizio."),
    richiesteFoglio,
    foglioVetture("Tutte", vetture, "Nessuna vettura nel perimetro esportato."),
  ];
  return scriviXlsx(fogli, st, [{ id: 1, png: logoCerberoPng() }]);
}
