/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA — esportazione in Excel (col marchio) e in CSV
 * ───────────────────────────────────────────────────────────────────────────
 * Tre fogli: Riepilogo (conducenti per deposito e documenti da guardare),
 * Anagrafica (una riga per conducente), Scadenze (una riga per documento
 * scaduto, in scadenza entro 90 giorni, senza data, o con visita non idonea).
 *
 * Le colonne dipendono da chi esporta: senza il permesso «personale» escono
 * solo quelle operative, le stesse che vede nel roster. I conducenti arrivano
 * qui già mascherati: questa funzione non decide niente sui permessi, si
 * limita a non stampare colonne che sarebbero vuote.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import {
  ETICHETTE_DOCUMENTO, ETICHETTE_ESITO, ETICHETTE_STATO, ORDINE_STATI, formattaOrario, scadenzeDi, statoPeggiore,
  type Conducente, type StatoScadenza,
} from "./anagrafica-campi";
import { scriviXlsx, Stili, type Foglio, type Valore } from "./xlsx-mini";
import { CERBERO, logoCerberoPng, LOGO_CERBERO_PX } from "./cerbero-brand";

const it = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");

export const COLORE_STATO: Record<StatoScadenza, string | null> = {
  non_idoneo: "FCA5A5",
  scaduta: "FECACA",
  entro_30: "FED7AA",
  entro_60: "FEF08A",
  entro_90: "E0F2FE",
  mancante: "E4E4E7",
  ok: null,
};

interface Colonna {
  titolo: string;
  larghezza: number;
  sensibile?: boolean;
  valore: (c: Conducente) => string | number | null;
}

/** Le colonne dell'anagrafica, nell'ordine del foglio e del CSV. */
export const COLONNE: Colonna[] = [
  { titolo: "Matricola", larghezza: 11, valore: c => c.matricola },
  { titolo: "Cognome", larghezza: 18, valore: c => c.cognome ?? (c.nome ? null : c.name) },
  { titolo: "Nome", larghezza: 16, valore: c => c.nome },
  { titolo: "Deposito", larghezza: 14, valore: c => c.residenzaServizio },
  { titolo: "Categoria", larghezza: 14, valore: c => c.categoria },
  { titolo: "Orario settimanale", larghezza: 10, valore: c => formattaOrario(c.orarioSettimanaleMin) || null },
  { titolo: "Rotazione riposi", larghezza: 18, valore: c => c.rotazioneRiposi?.nome ?? null },
  { titolo: "Scaglione riposi", larghezza: 9, valore: c => c.rotazioneRiposi?.scaglione ?? null },
  { titolo: "Scaglione ferie", larghezza: 9, valore: c => c.scaglioneFerie },
  { titolo: "Rotazione turni", larghezza: 12, valore: c => c.rotazioneTurni?.gruppo ?? null },
  { titolo: "Posizione turni", larghezza: 9, valore: c => c.rotazioneTurni?.posizione ?? null },
  { titolo: "Abilitazioni", larghezza: 18, valore: c => c.abilitazioni.join(", ") || null },
  { titolo: "Cellulare", larghezza: 13, valore: c => c.cellulare },
  { titolo: "Patente (categorie)", larghezza: 10, valore: c => c.patente },
  { titolo: "Scadenza patente", larghezza: 11, valore: c => it(c.patenteValidita) || null },
  { titolo: "Scadenza CQC", larghezza: 11, valore: c => it(c.cqcValidita) || null },
  { titolo: "Scadenza visita ferrovie", larghezza: 11, valore: c => it(c.visitaFerrovieValidita) || null },
  { titolo: "Scadenza visita medico competente", larghezza: 11, valore: c => it(c.visitaMedicoCompetenteValidita) || null },
  { titolo: "In servizio fino al", larghezza: 11, valore: c => it(c.dataFineServizio) || null },
  /* sensibili: solo con il permesso «personale» */
  { titolo: "Codice fiscale", larghezza: 18, sensibile: true, valore: c => c.cf ?? null },
  { titolo: "Data di nascita", larghezza: 11, sensibile: true, valore: c => it(c.dataNascita) || null },
  { titolo: "Data di assunzione", larghezza: 11, sensibile: true, valore: c => it(c.dataAssunzione) || null },
  { titolo: "Residenza", larghezza: 32, sensibile: true, valore: c => c.residenzaAnagrafica ?? null },
  { titolo: "Telefono", larghezza: 13, sensibile: true, valore: c => c.telefono ?? null },
  { titolo: "Inquadramento", larghezza: 16, sensibile: true, valore: c => c.inquadramento ?? null },
  { titolo: "Parametro", larghezza: 9, sensibile: true, valore: c => c.parametro ?? null },
  { titolo: "Ferie annue", larghezza: 8, sensibile: true, valore: c => c.ferieAnnue ?? null },
  { titolo: "Ferie residue", larghezza: 8, sensibile: true, valore: c => c.ferieResidue ?? null },
  { titolo: "Residuo al", larghezza: 11, sensibile: true, valore: c => it(c.ferieResidueAl) || null },
  { titolo: "Ferie in", larghezza: 7, sensibile: true, valore: c => (c.ferieAnnue != null || c.ferieResidue != null ? c.ferieUnita ?? "giorni" : null) },
  { titolo: "Numero patente", larghezza: 14, sensibile: true, valore: c => c.patenteNumero ?? null },
  { titolo: "Numero CQC (se diverso)", larghezza: 14, sensibile: true, valore: c => (c.cqcNumero && c.cqcNumero !== c.patenteNumero ? c.cqcNumero : null) },
  { titolo: "Data visita ferrovie", larghezza: 11, sensibile: true, valore: c => it(c.visitaFerrovieData) || null },
  { titolo: "Esito visita ferrovie", larghezza: 16, sensibile: true, valore: c => (c.visitaFerrovieEsito ? ETICHETTE_ESITO[c.visitaFerrovieEsito] : null) },
  { titolo: "Data visita medico competente", larghezza: 11, sensibile: true, valore: c => it(c.visitaMedicoCompetenteData) || null },
  { titolo: "Esito visita medico competente", larghezza: 16, sensibile: true, valore: c => (c.visitaMedicoCompetenteEsito ? ETICHETTE_ESITO[c.visitaMedicoCompetenteEsito] : null) },
  { titolo: "Note", larghezza: 40, sensibile: true, valore: c => c.note ?? null },
];

export function colonneDi(sensibili: boolean): Colonna[] {
  return COLONNE.filter(c => sensibili || !c.sensibile);
}

export interface InfoEsportazione {
  sensibili: boolean;
  oggi: string;
  generatoIl: string;
  /** es. «solo Ancona», «anche i cessati» */
  filtro?: string;
}

export function esportaAnagraficaXlsx(conducenti: Conducente[], info: InfoEsportazione): Buffer {
  const st = new Stili();
  const S = {
    banda: st.indice({ fill: CERBERO.navy }),
    titolo: st.indice({ fill: CERBERO.navy, color: CERBERO.bianco, bold: true, size: 20, valign: "center" }),
    sottotitolo: st.indice({ fill: CERBERO.navy, color: "94A7B5", size: 11, valign: "center" }),
    h2: st.indice({ bold: true, size: 13, color: CERBERO.inchiostro }),
    testo: st.indice({ color: CERBERO.inchiostro, wrap: true, valign: "top" }),
    intestazione: st.indice({ fill: CERBERO.navy, color: CERBERO.bianco, bold: true, size: 10, border: true, borderColor: "26343F", valign: "center", wrap: true }),
    cella: st.indice({ border: true, valign: "top", size: 10, color: CERBERO.inchiostro }),
    cellaTesto: st.indice({ border: true, valign: "top", wrap: true, size: 10, color: CERBERO.inchiostro }),
    numero: st.indice({ border: true, align: "right", size: 10, color: CERBERO.inchiostro }),
  };
  const stato = new Map<StatoScadenza, number>();
  for (const s of ORDINE_STATI) {
    const fill = COLORE_STATO[s];
    stato.set(s, fill ? st.indice({ fill, border: true, size: 10, color: CERBERO.inchiostro, valign: "top" }) : S.cella);
  }
  const colonne = colonneDi(info.sensibili);
  const scadenze = conducenti.filter(c => c.isActive).map(c => ({ c, voci: scadenzeDi(c, info.oggi) }));

  /* ── Riepilogo ── */
  const R: Valore[][] = [];
  const banda = (testo: string | null = null, stile = S.banda): Valore[] =>
    [{ v: null, s: S.banda }, { v: null, s: S.banda }, { v: testo, s: stile }, { v: null, s: S.banda }, { v: null, s: S.banda }, { v: null, s: S.banda }];
  const attivi = conducenti.filter(c => c.isActive);
  R.push(banda());
  R.push(banda("Anagrafica del personale", S.titolo));
  R.push(banda(`${attivi.length} ${attivi.length === 1 ? "conducente attivo" : "conducenti attivi"}${info.filtro ? ` · ${info.filtro}` : ""}`, S.sottotitolo));
  R.push(banda(`Esportata il ${it(info.oggi)} · ${info.sensibili ? "con i dati personali" : "solo dati operativi (senza il permesso «Personale»)"}`, S.sottotitolo));
  R.push([]);
  R.push([{ v: "Conducenti per deposito", s: S.h2 }]);
  R.push([{ v: "Deposito", s: S.intestazione }, { v: "Conducenti", s: S.intestazione }, { v: "Documenti da guardare", s: S.intestazione }]);
  const perDeposito = new Map<string, { n: number; daGuardare: number }>();
  for (const { c, voci } of scadenze) {
    const k = c.residenzaServizio ?? "(senza deposito)";
    const x = perDeposito.get(k) ?? { n: 0, daGuardare: 0 };
    x.n++;
    if (!["ok", "entro_90"].includes(statoPeggiore(voci))) x.daGuardare++;
    perDeposito.set(k, x);
  }
  for (const [k, x] of [...perDeposito].sort((a, b) => a[0].localeCompare(b[0]))) {
    R.push([{ v: k, s: S.cella }, { v: x.n, s: S.numero }, { v: x.daGuardare, s: S.numero }]);
  }
  R.push([]);
  R.push([{ v: "Documenti", s: S.h2 }]);
  R.push([{ v: "Stato", s: S.intestazione }, { v: "Documenti", s: S.intestazione }]);
  for (const s of ORDINE_STATI) {
    const n = scadenze.reduce((t, x) => t + x.voci.filter(v => v.stato === s).length, 0);
    R.push([{ v: ETICHETTE_STATO[s], s: stato.get(s)! }, { v: n, s: S.numero }]);
  }
  R.push([]);
  R.push([{ v: "Le scadenze contano patente, CQC, visita ferrovie e visita del medico competente. «Non idoneo» vale "
    + "anche per «temporaneamente non idoneo» e prevale sulla data.", s: S.testo }]);

  const riepilogo: Foglio = {
    nome: "Riepilogo",
    righe: R,
    larghezze: [30, 14, 60, 12, 12, 12],
    altezze: { 1: 18, 2: 30, 3: 18, 4: 18 },
    unioni: ["C2:F2", "C3:F3", "C4:F4", `A${R.length}:F${R.length}`],
    immagine: {
      id: 1, cella: "A1",
      larghezzaPx: 200, altezzaPx: Math.round(200 * LOGO_CERBERO_PX.altezza / LOGO_CERBERO_PX.larghezza),
      offsetPx: { x: 10, y: 10 },
    },
  };

  /* ── Anagrafica ── */
  const A: Valore[][] = [[...colonne.map(c => ({ v: c.titolo, s: S.intestazione })), { v: "Documenti", s: S.intestazione }]];
  for (const { c, voci } of scadenze.concat(conducenti.filter(x => !x.isActive).map(c => ({ c, voci: [] })))) {
    const peggiore = voci.length ? statoPeggiore(voci) : null;
    A.push([
      ...colonne.map(col => {
        const v = col.valore(c);
        return { v: v === "" ? null : v, s: typeof v === "number" ? S.numero : col.larghezza >= 30 ? S.cellaTesto : S.cella };
      }),
      { v: c.isActive ? (peggiore ? ETICHETTE_STATO[peggiore] : "") : "non più in servizio", s: peggiore ? stato.get(peggiore)! : S.cella },
    ]);
  }
  const anagrafica: Foglio = {
    nome: "Anagrafica",
    righe: A,
    larghezze: [...colonne.map(c => c.larghezza), 18],
    altezze: { 1: 42 },
    blocca: { righe: 1, colonne: 3 },
  };

  /* ── Scadenze ── */
  const Z: Valore[][] = [[
    "Matricola", "Cognome e nome", "Deposito", "Documento", "Scadenza", "Giorni", "Stato",
  ].map(t => ({ v: t, s: S.intestazione }))];
  const voci = scadenze.flatMap(({ c, voci }) => voci.filter(v => v.stato !== "ok").map(v => ({ c, v })));
  voci.sort((a, b) => ORDINE_STATI.indexOf(a.v.stato) - ORDINE_STATI.indexOf(b.v.stato)
    || (a.v.scadenza ?? "9999").localeCompare(b.v.scadenza ?? "9999"));
  for (const { c, v } of voci) {
    Z.push([
      { v: c.matricola, s: S.cella },
      { v: [c.cognome, c.nome].filter(Boolean).join(" ") || c.name, s: S.cella },
      { v: c.residenzaServizio, s: S.cella },
      { v: ETICHETTE_DOCUMENTO[v.documento], s: S.cella },
      { v: it(v.scadenza) || null, s: S.cella },
      { v: v.giorni, s: S.numero },
      { v: ETICHETTE_STATO[v.stato], s: stato.get(v.stato)! },
    ]);
  }
  const fogliScadenze: Foglio = {
    nome: "Scadenze",
    righe: Z,
    larghezze: [11, 28, 14, 26, 11, 8, 18],
    blocca: { righe: 1, colonne: 0 },
  };

  return scriviXlsx([riepilogo, anagrafica, fogliScadenze], st, [{ id: 1, png: logoCerberoPng() }]);
}

/**
 * Una cella di CSV che Excel non scambia per una formula: davanti a =, @,
 * tabulazione, a capo, e a + o - seguiti da una non-cifra va un apostrofo.
 * «+39 333…» e «-1,5» restano come sono.
 */
export function cellaSicura(x: unknown): string {
  const s = String(x ?? "");
  return /^[=@\t\r]/.test(s) || /^[+-](?![\d\s])/.test(s) ? `'${s}` : s;
}

export function esportaAnagraficaCsv(conducenti: Conducente[], info: InfoEsportazione): string {
  const colonne = colonneDi(info.sensibili);
  const q = (x: unknown) => `"${cellaSicura(x).replace(/"/g, '""')}"`;
  const righe = [[...colonne.map(c => c.titolo), "Documenti", "Attivo"].map(q).join(";")];
  for (const c of conducenti) {
    const peggiore = c.isActive ? statoPeggiore(scadenzeDi(c, info.oggi)) : null;
    righe.push([...colonne.map(col => col.valore(c)), peggiore ? ETICHETTE_STATO[peggiore] : "", c.isActive ? "sì" : "no"].map(q).join(";"));
  }
  /* il BOM fa aprire a Excel il file in UTF-8 (accenti) */
  return `﻿${righe.join("\r\n")}`;
}
