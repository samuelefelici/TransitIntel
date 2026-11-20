/**
 * Il confronto fra la polimetrica della bigliettazione e quella che esce dai
 * percorsi dell'azienda (tappa 6.34b).
 *
 * Un percorso di una linea della bigliettazione ha i suoi punti tariffari col
 * km progressivo e le righe (coppia di nodi → km e fascia). A ogni punto
 * corrisponde una fermata di un percorso dell'azienda: da lì vengono il km
 * nuovo del punto e, con le fasce chilometriche dell'azienda, la fascia nuova
 * di ogni coppia. Le differenze sono l'elenco da ribattere a mano nella
 * bigliettazione.
 *
 * L'API (GET /api/fares/polimetriche/ufficiale/linea) dà i dati e le
 * proposte; qui i conti. Niente rete.
 */
import type { FasciaKm } from "./fasce-km";
import { fasciaDeiKm } from "./polimetrica";

export type Verso = "AB" | "BA";

export interface PuntoUfficiale { ordine: number; codice: string; nome: string | null; nodo: string | null; km: number }
export interface RigaUfficiale {
  percorso: string; direzione: string; da: string; a: string;
  km: number | null; tariffario: string | null; fascia: number | null; forzata: boolean;
}
export interface FermataPercorso { stopId: string; nome: string; km: number }
export interface PuntoAbbinato { ordine: number; fermata: string | null; come?: "codice" | "nome" | null }
export interface Candidato {
  routeId: string; variantId: string; verso: Verso; trovati: number;
  /** di quanti km, in media, i punti ritrovati si scostano dai km della bigliettazione */
  scarto?: number;
  punti: PuntoAbbinato[];
}
export interface Deciso { routeId: string; variantId: string; verso: Verso; punti: { ordine: number; fermata: string | null }[]; nellImport: boolean }
export interface PercorsoUfficiale { percorso: string; direzione: string; punti: PuntoUfficiale[]; candidati: Candidato[]; deciso: Deciso | null }
export interface PercorsoAzienda {
  routeId: string; variantId: string; direzione: number | null;
  da: string; a: string; corse: number; km: number; fermate: FermataPercorso[];
}
export interface DettaglioLinea {
  linea: string; abbinata: string | null;
  percorsi: PercorsoUfficiale[]; righe: RigaUfficiale[]; percorsiAzienda: PercorsoAzienda[];
}

/** I chilometri arrotondati al metro. */
const alMetro = (km: number) => Math.round(km * 1000) / 1000;

/** Le fermate di un percorso lette nel verso scelto: BA è al contrario, coi km contati dall'altro capo. */
export function fermateNelVerso(fermate: readonly FermataPercorso[], verso: Verso): FermataPercorso[] {
  if (verso === "AB") return fermate.map((f) => ({ ...f }));
  const totale = fermate.length ? fermate[fermate.length - 1]!.km : 0;
  return [...fermate].reverse().map((f) => ({ ...f, km: alMetro(totale - f.km) }));
}

/** La scelta su cui si lavora per un percorso della bigliettazione: il percorso dell'azienda, il verso e la fermata di ogni punto. */
export interface Scelta {
  routeId: string; variantId: string; verso: Verso;
  /** per ordine del punto: la fermata, o null se non ne ha */
  fermate: Record<number, string | null>;
  /** come si è ritrovata la fermata proposta; un punto scelto a mano non c'è */
  come: Record<number, "codice" | "nome">;
}

const daCandidato = (c: Candidato): Scelta => ({
  routeId: c.routeId, variantId: c.variantId, verso: c.verso,
  fermate: Object.fromEntries(c.punti.map((p) => [p.ordine, p.fermata])),
  come: Object.fromEntries(c.punti.flatMap((p) => (p.fermata != null && p.come ? [[p.ordine, p.come]] : []))),
});

/**
 * Da dove si parte: la decisione salvata, se il suo percorso è ancora
 * nell'import; altrimenti la proposta migliore; senza né l'una né l'altra,
 * niente (la linea non è abbinata, o nessun punto si ritrova).
 */
export function sceltaIniziale(p: PercorsoUfficiale): { scelta: Scelta | null; salvata: boolean } {
  if (p.deciso?.nellImport) {
    const proposta = p.candidati.find((c) => c.routeId === p.deciso!.routeId && c.variantId === p.deciso!.variantId && c.verso === p.deciso!.verso);
    const fermate: Record<number, string | null> = Object.fromEntries(p.deciso.punti.map((x) => [x.ordine, x.fermata]));
    /* «come» resta solo dove la fermata salvata è ancora quella della proposta */
    const come: Record<number, "codice" | "nome"> = {};
    for (const x of proposta?.punti ?? []) if (x.fermata != null && x.come && fermate[x.ordine] === x.fermata) come[x.ordine] = x.come;
    return { scelta: { routeId: p.deciso.routeId, variantId: p.deciso.variantId, verso: p.deciso.verso, fermate, come }, salvata: true };
  }
  return { scelta: p.candidati[0] ? daCandidato(p.candidati[0]) : null, salvata: false };
}

/** La scelta quando si cambia percorso dell'azienda o verso: la proposta di quel percorso, o tutti i punti senza fermata. */
export function sceltaPerPercorso(p: PercorsoUfficiale, routeId: string, variantId: string, verso: Verso): Scelta {
  const c = p.candidati.find((x) => x.routeId === routeId && x.variantId === variantId && x.verso === verso);
  return c ? daCandidato(c) : { routeId, variantId, verso, fermate: Object.fromEntries(p.punti.map((x) => [x.ordine, null])), come: {} };
}

/** Il corpo di PUT /api/fares/polimetriche/ufficiale/linea/punti. */
export function corpoDecisione(importId: string, linea: string, p: PercorsoUfficiale, s: Scelta) {
  return {
    importId, lineaUfficiale: linea, percorso: p.percorso, direzione: p.direzione,
    routeId: s.routeId, variantId: s.variantId, verso: s.verso,
    punti: p.punti.map((x) => ({ ordine: x.ordine, fermata: s.fermate[x.ordine] ?? null })),
  };
}

/** Un punto della bigliettazione accanto alla sua fermata. */
export interface RigaPunto {
  ordine: number; codice: string; nome: string | null; nodo: string;
  kmUfficiale: number;
  fermata: FermataPercorso | null;
  /** il km del punto contato come nella bigliettazione, ma coi km dell'azienda */
  kmNuovo: number | null;
  /** km nuovo meno km della bigliettazione */
  differenza: number | null;
  /** la fermata viene prima di quella del punto precedente: l'ordine non torna */
  fuoriOrdine: boolean;
}

export type Esito = "uguale" | "cambia" | "spenta" | "manca";

/** Una coppia di nodi: la riga della bigliettazione e quella che esce dai km dell'azienda. */
export interface RigaCoppia {
  da: string; a: string; nomeDa: string; nomeA: string;
  kmUfficiale: number | null; kmNuovo: number;
  fasciaUfficiale: number | null; fasciaNuova: number | null;
  tariffario: string | null; forzata: boolean;
  /**
   * uguale: stessa fascia; cambia: fascia diversa; spenta: nella bigliettazione
   * la coppia è senza fascia (non vendibile); manca: la riga non c'è.
   */
  esito: Esito;
}

export interface Confronto {
  punti: RigaPunto[];
  coppie: RigaCoppia[];
  /** righe della bigliettazione di questo percorso con un nodo che non è fra i punti abbinati */
  righeSenzaPunto: number;
}

/**
 * Il confronto di un percorso della bigliettazione con le fermate scelte.
 *
 * Il km nuovo di un punto è contato dal primo punto abbinato, a cui resta il
 * km che ha nella bigliettazione: così i km nuovi stanno sulla stessa scala
 * dei vecchi anche se il percorso dell'azienda comincia prima o dopo.
 * La fascia nuova di una coppia è quella della differenza dei due km nuovi.
 */
export function confronta(
  p: PercorsoUfficiale, righe: readonly RigaUfficiale[], fermate: readonly FermataPercorso[], scelta: Scelta, fasce: readonly FasciaKm[],
): Confronto {
  /* la fermata di ogni punto: la prima con quel codice dopo quella del punto prima; se non c'è, la prima in assoluto (fuori ordine) */
  let dopo = -1;
  let primo: { kmUfficiale: number; kmFermata: number } | null = null;
  const punti: RigaPunto[] = p.punti.map((x) => {
    const id = scelta.fermate[x.ordine] ?? null;
    let i = -1, fuoriOrdine = false;
    if (id != null) {
      i = fermate.findIndex((f, k) => k > dopo && f.stopId === id);
      if (i < 0) { i = fermate.findIndex((f) => f.stopId === id); fuoriOrdine = i >= 0; }
    }
    const fermata = i >= 0 ? fermate[i]! : null;
    if (fermata && !fuoriOrdine) dopo = i;
    if (fermata && !primo) primo = { kmUfficiale: x.km, kmFermata: fermata.km };
    const kmNuovo = fermata && primo ? alMetro(primo.kmUfficiale + (fermata.km - primo.kmFermata)) : null;
    return {
      ordine: x.ordine, codice: x.codice, nome: x.nome, nodo: x.nodo ?? x.codice, kmUfficiale: x.km,
      fermata, kmNuovo, differenza: kmNuovo == null ? null : alMetro(kmNuovo - x.km), fuoriOrdine,
    };
  });

  /* le righe di questo percorso; quelle senza percorso né direzione valgono per tutti */
  const diQui = righe.filter((r) => (r.percorso === p.percorso && r.direzione === p.direzione) || (r.percorso === "" && r.direzione === ""));
  const chiave = (da: string, a: string) => `${da}\u0000${a}`;
  const perCoppia = new Map<string, RigaUfficiale>();
  /* una riga del percorso vale più di una «per tutti» */
  for (const r of [...diQui].sort((x, y) => Number(x.percorso === "") - Number(y.percorso === ""))) {
    if (!perCoppia.has(chiave(r.da, r.a))) perCoppia.set(chiave(r.da, r.a), r);
  }

  const abbinati = punti.filter((x) => x.kmNuovo != null);
  const nome = new Map(punti.map((x) => [x.nodo, x.nome ?? x.codice]));
  const coppie: RigaCoppia[] = [];
  const viste = new Set<string>();
  for (let i = 0; i < abbinati.length; i++) {
    for (let j = i + 1; j < abbinati.length; j++) {
      const da = abbinati[i]!, a = abbinati[j]!;
      if (da.nodo === a.nodo || viste.has(chiave(da.nodo, a.nodo))) continue;
      viste.add(chiave(da.nodo, a.nodo));
      const riga = perCoppia.get(chiave(da.nodo, a.nodo)) ?? perCoppia.get(chiave(a.nodo, da.nodo)) ?? null;
      const kmNuovo = alMetro(Math.abs(a.kmNuovo! - da.kmNuovo!));
      const fasciaNuova = fasciaDeiKm(kmNuovo, fasce);
      const fasciaUfficiale = riga?.fascia ?? null;
      const esito: Esito = !riga ? "manca" : fasciaUfficiale == null || fasciaUfficiale === 0 ? "spenta" : fasciaUfficiale === fasciaNuova ? "uguale" : "cambia";
      coppie.push({
        da: da.nodo, a: a.nodo, nomeDa: nome.get(da.nodo) ?? da.nodo, nomeA: nome.get(a.nodo) ?? a.nodo,
        kmUfficiale: riga?.km ?? null, kmNuovo, fasciaUfficiale, fasciaNuova,
        tariffario: riga?.tariffario ?? null, forzata: riga?.forzata ?? false, esito,
      });
    }
  }

  const nodiAbbinati = new Set(abbinati.map((x) => x.nodo));
  const righeSenzaPunto = diQui.filter((r) => !nodiAbbinati.has(r.da) || !nodiAbbinati.has(r.a)).length;
  return { punti, coppie, righeSenzaPunto };
}

/** I numeri del confronto, per la riga di riassunto. */
export interface Riassunto {
  punti: number; abbinati: number; fuoriOrdine: number;
  /** la differenza di km più grande, in valore assoluto */
  scartoMassimo: number;
  coppie: number; uguali: number; cambiano: number; cambianoForzate: number; spente: number; mancano: number;
  righeSenzaPunto: number;
}

export function riassunto(c: Confronto): Riassunto {
  const conta = (e: Esito) => c.coppie.filter((x) => x.esito === e).length;
  return {
    punti: c.punti.length, abbinati: c.punti.filter((x) => x.fermata).length, fuoriOrdine: c.punti.filter((x) => x.fuoriOrdine).length,
    scartoMassimo: c.punti.reduce((m, x) => Math.max(m, Math.abs(x.differenza ?? 0)), 0),
    coppie: c.coppie.length, uguali: conta("uguale"), cambiano: conta("cambia"),
    cambianoForzate: c.coppie.filter((x) => x.esito === "cambia" && x.forzata).length,
    spente: conta("spenta"), mancano: conta("manca"), righeSenzaPunto: c.righeSenzaPunto,
  };
}

export const ETICHETTE_ESITO: Record<Esito, string> = {
  uguale: "uguale", cambia: "cambia", spenta: "senza fascia nella bigliettazione", manca: "manca nella bigliettazione",
};

/* ── I nodi del percorso dai punti della bigliettazione ───────────────────── */

/**
 * Le tratte del percorso dell'azienda fatte coi punti abbinati: un nodo per
 * punto, col punto tariffario sulla sua fermata e il nome della
 * bigliettazione. La prima tratta comincia alla prima fermata del percorso
 * anche se il primo punto viene dopo. I punti fuori ordine restano fuori.
 */
export function nodiDaiPunti(c: Confronto, fermate: readonly FermataPercorso[]): { confini: number[]; scelte: number[]; nomi: Record<number, string> } {
  const indici: { i: number; nome: string }[] = [];
  let dopo = -1;
  for (const x of c.punti) {
    if (!x.fermata || x.fuoriOrdine) continue;
    const i = fermate.findIndex((f, k) => k > dopo && f.stopId === x.fermata!.stopId);
    if (i < 0) continue;
    dopo = i;
    indici.push({ i, nome: x.nome ?? x.codice });
  }
  return {
    confini: indici.slice(1).map((x) => x.i),
    scelte: indici.map((x) => x.i),
    nomi: Object.fromEntries(indici.map((x, k) => [k, x.nome])),
  };
}

/* ── I CSV delle differenze ───────────────────────────────────────────────── */

/** Un numero come lo vuole un foglio di calcolo italiano: con la virgola, senza zeri inutili. */
const numeroCsv = (n: number | null): string => (n == null ? "" : String(alMetro(n)).replace(".", ","));

/**
 * Una casella di testo: fra virgolette se serve, e con un apostrofo davanti
 * se comincia come una formula (=, +, -, @), perché un foglio di calcolo non
 * la esegua.
 */
export function casellaCsv(v: string | null): string {
  let t = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  if (/^[=+\-@]/.test(t)) t = `'${t}`;
  return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

const riga = (caselle: string[]) => caselle.join(";");

/** Chi è: la linea della bigliettazione, il percorso e la direzione, in testa a ogni riga dei CSV. */
export interface Dove { linea: string; percorso: string; direzione: string }

/** I punti: km della bigliettazione, fermata, km nuovo e differenza. Col BOM, punto e virgola e decimali con la virgola. */
export function csvPunti(dove: Dove, c: Confronto): string {
  const righe = [riga(["linea", "percorso", "direzione", "ordine", "codice", "nome", "nodo", "km bigliettazione", "fermata", "nome fermata", "km nuovo", "differenza km"])];
  for (const x of c.punti) {
    righe.push(riga([
      casellaCsv(dove.linea), casellaCsv(dove.percorso), casellaCsv(dove.direzione), String(x.ordine), casellaCsv(x.codice), casellaCsv(x.nome), casellaCsv(x.nodo),
      numeroCsv(x.kmUfficiale), casellaCsv(x.fermata?.stopId ?? null), casellaCsv(x.fermata?.nome ?? null), numeroCsv(x.kmNuovo), numeroCsv(x.differenza),
    ]));
  }
  return `﻿${righe.join("\r\n")}\r\n`;
}

/** Le coppie: km e fascia della bigliettazione, km e fascia nuovi, e l'esito. `soloDifferenze`: senza quelle uguali. */
export function csvCoppie(dove: Dove, c: Confronto, soloDifferenze: boolean): string {
  const righe = [riga(["linea", "percorso", "direzione", "da", "nome da", "a", "nome a", "km bigliettazione", "km nuovo", "tariffario", "fascia bigliettazione", "fascia nuova", "forzata", "esito"])];
  for (const x of c.coppie) {
    if (soloDifferenze && x.esito === "uguale") continue;
    righe.push(riga([
      casellaCsv(dove.linea), casellaCsv(dove.percorso), casellaCsv(dove.direzione), casellaCsv(x.da), casellaCsv(x.nomeDa), casellaCsv(x.a), casellaCsv(x.nomeA),
      numeroCsv(x.kmUfficiale), numeroCsv(x.kmNuovo), casellaCsv(x.tariffario), x.fasciaUfficiale == null ? "" : String(x.fasciaUfficiale),
      x.fasciaNuova == null ? "" : String(x.fasciaNuova), x.forzata ? "sì" : "no", ETICHETTE_ESITO[x.esito],
    ]));
  }
  return `﻿${righe.join("\r\n")}\r\n`;
}

/** Un nome di file senza caratteri che un file system non vuole. */
export const nomeFile = (dove: Dove, cosa: string): string =>
  `${cosa}-${dove.linea}-${dove.percorso}-${dove.direzione}`.replace(/[^A-Za-z0-9._-]+/g, "_") + ".csv";
