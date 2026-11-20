/**
 * Le tariffe nel GTFS consegnabile (tappa 6.37): i file di GTFS Fares v2,
 * fatti dai dati dell'azienda e dalle polimetriche, accanto agli orari.
 *
 * Da dove vengono:
 *   rider_categories.txt  le categorie di passeggero (categorie_catalogo, 6.10)
 *   fare_media.txt        i supporti (supporti_catalogo, 6.10)
 *   fare_products.txt     i titoli del catalogo (6.9), più un biglietto di corsa
 *                         semplice per fascia chilometrica col suo prezzo (6.8)
 *   networks.txt          le reti urbane dell'azienda (6.7), più una rete per
 *                         ogni linea extraurbana
 *   route_networks.txt    la rete di ogni linea del file
 *   areas.txt             i nodi tariffari delle linee extraurbane
 *   stop_areas.txt        il nodo di ogni fermata, linea per linea
 *   fare_leg_rules.txt    urbane: su una rete vale il suo biglietto, ovunque
 *                         (regoleUrbane, come il Fares Engine); extraurbane:
 *                         fra due nodi della stessa linea, il biglietto della
 *                         fascia dei km fra i loro punti tariffari; il
 *                         pagamento con carta (6.38) sulle reti dove vale
 *   fare_transfer_rules.txt  dentro la durata di un biglietto urbano a tempo,
 *                         e dentro la validità del pagamento con carta, le
 *                         corse dopo la prima non si pagano
 *
 * Tutte le regole hanno rule_priority 0: con la colonna, un'area vuota vuol
 * dire «l'area non conta» (senza, vorrebbe dire «tutte le aree tranne quelle
 * nominate», e la regola urbana non varrebbe da una fermata che è anche in un
 * nodo extraurbano). Così sulle linee extraurbane il pagamento con carta è
 * un'alternativa al biglietto di fascia.
 *
 * Del pagamento con carta nel GTFS entrano il prezzo del primo viaggio, il
 * supporto e la validità. Il prezzo dal secondo viaggio e i massimali nel
 * GTFS non si possono scrivere.
 *
 * Le regole extraurbane vengono dalle polimetriche. Per ogni percorso della
 * linea, la polimetrica salvata (su una qualunque fotografia) del percorso con
 * le stesse fermate, ricomposta sui km di questo programma; senza, le tratte
 * fatte dalle fasce come nella stampa a gradoni (una per fascia dal
 * capolinea, il punto tariffario alla prima fermata). Poi, linea per linea:
 *   - un nodo per punto tariffario (la fermata), col nome della polimetrica;
 *   - una fermata sta in un nodo solo: quello del percorso più servito che la
 *     tocca. Se altri percorsi la mettono altrove, si conta (avviso);
 *   - fra due nodi vale la fascia più bassa fra quelle dei percorsi che li
 *     hanno tutti e due (i km sono quelli fra i punti tariffari); se i
 *     percorsi non sono d'accordo, si conta (avviso). Dentro lo stesso nodo,
 *     la prima fascia.
 * Una rete per linea, perché nel GTFS una regola non sa su quale linea si
 * viaggia: due linee con fermate in comune e nodi diversi darebbero due
 * prezzi per lo stesso viaggio.
 *
 * Le tariffe non fermano mai il GTFS: quello che non torna (un titolo con una
 * categoria che non c'è, una fascia che manca) resta fuori ed è un avviso.
 */
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { fasciaDeiKm, type FasciaKm } from "./fasce-km";
import { fasceDalDatabase } from "./fasce-km-store";
import { catalogoTitoli, idBigliettoFascia, regoleUrbane, titoloNelFeed, type TitoloCatalogo } from "./titoli-catalogo";
import { categorieCatalogo, supportiCatalogo } from "./elenchi-tariffe-store";
import type { CategoriaCatalogo, SupportoCatalogo } from "./elenchi-tariffe";
import { reteDalleRegole, RETE_EXTRAURBANA, type RetiAzienda } from "./reti-linee";
import { rileggiReti } from "./reti-lettura";
import {
  corpoDallaSalvata, chiaveDelPercorso, datiDelProgramma, fotografia, percorsoPerIlSalvataggio,
  type Linea, type Percorso,
} from "./polimetrica-programma";
import { componiPolimetrica, leggiCorpo } from "./polimetrica-salvata";
import { contactlessAttivo, type Contactless, type TipoContactless } from "./contactless";
import { contactlessDalDatabase } from "./contactless-store";
import type { FileGtfs, Gtfs, Problema, Riga } from "./gtfs-verifica";

type Esecutore = { execute: (q: any) => Promise<any> };
const righe = (r: any): any[] => r?.rows ?? [];

/* ─────────────────────────────────────────────────────────────
 *  Le polimetriche, linea per linea
 * ───────────────────────────────────────────────────────────── */

/** Una fermata di un percorso nel verso della sua polimetrica. */
interface FermataInOrdine { stopId: string; stopName: string; km: number }

/** Le tratte di un percorso: da quale fermata a quale, il punto tariffario e il nome del nodo. */
export interface TrattaDelPercorso { da: number; a: number; punto: number; nome: string }

export interface PolimetricaDelPercorso {
  fermate: FermataInOrdine[];
  tratte: TrattaDelPercorso[];
  fonte: "salvata" | "automatica";
}

/**
 * I confini delle tratte fatte dalle fasce: una tratta nuova comincia alla
 * prima fermata che, dal capolinea, sta in un'altra fascia (la stessa regola
 * di confiniDalleFasce nella pagina).
 */
export function confiniDalleFasce(fermate: readonly { km: number }[], fasce: readonly FasciaKm[]): number[] {
  const confini: number[] = [];
  for (let i = 1; i < fermate.length; i++) {
    if (fasciaDeiKm(fermate[i]!.km, fasce) !== fasciaDeiKm(fermate[i - 1]!.km, fasce)) confini.push(i);
  }
  return confini;
}

/**
 * Le tratte di un percorso fatte dalle fasce. Il punto tariffario è la prima
 * fermata della tratta che è già un nodo della linea (`nodi`: i punti dei
 * percorsi visti prima), altrimenti la prima fermata: così i percorsi di una
 * linea che passano dalle stesse fermate usano gli stessi nodi.
 */
export function tratteAutomatiche(fermate: readonly FermataInOrdine[], fasce: readonly FasciaKm[], nodi: ReadonlySet<string> = new Set()): TrattaDelPercorso[] {
  const inizi = [0, ...confiniDalleFasce(fermate, fasce)];
  return inizi.map((da, k) => {
    const fine = k + 1 < inizi.length ? inizi[k + 1]! - 1 : fermate.length - 1;
    let punto = da;
    for (let i = da; i <= fine; i++) if (nodi.has(fermate[i]!.stopId)) { punto = i; break; }
    return { da, a: k + 1 < inizi.length ? inizi[k + 1]! : fermate.length - 1, punto, nome: "" };
  });
}

/**
 * La polimetrica di un percorso: quella salvata (ricomposta sulle fermate e i
 * km di questo programma) se c'è e torna, altrimenti quella fatta dalle fasce.
 */
export function polimetricaDelPercorso(linea: Linea, p: Percorso, salvata: unknown | null, fasce: readonly FasciaKm[], nodi: ReadonlySet<string> = new Set()): PolimetricaDelPercorso {
  if (salvata) {
    const letto = leggiCorpo(corpoDallaSalvata(salvata, "00000000-0000-4000-8000-000000000000", p));
    if (letto.ok) {
      const c = componiPolimetrica(letto.corpo, percorsoPerIlSalvataggio(linea, p));
      if (c.ok) {
        return {
          fermate: c.polimetrica.stops.map((s) => ({ stopId: s.stopId, stopName: s.stopName, km: s.km })),
          tratte: c.polimetrica.tratte.map((t) => ({ da: t.fromStopIdx, a: t.toStopIdx, punto: t.puntoStopIdx, nome: t.nodeName })),
          fonte: "salvata",
        };
      }
    }
  }
  const fermate = p.stops.map((s) => ({ stopId: s.stopId, stopName: s.stopName, km: s.km }));
  return { fermate, tratte: tratteAutomatiche(fermate, fasce, nodi), fonte: "automatica" };
}

/** I nodi, le fermate e le coppie di una linea extraurbana. */
export interface TariffeDellaLinea {
  linea: string;
  /** nodo (codice della fermata del punto tariffario) → nome */
  nodi: Map<string, string>;
  /** fermata → nodo */
  fermate: Map<string, string>;
  /** «nodoA\u0000nodoB» (in ordine) → fascia */
  coppie: Map<string, number>;
  percorsi: number;
  salvati: number;
  /** fermate che un altro percorso mette in un nodo diverso */
  fermateContese: string[];
  /** coppie di nodi su cui due percorsi danno fasce diverse */
  coppieDiscordi: number;
}

const coppia = (a: string, b: string) => (a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * I nodi tariffari di una linea dalle polimetriche dei suoi percorsi (in
 * ordine di corse, dal più servito). `salvataPer` dà la polimetrica salvata
 * di un percorso, o null.
 */
export function tariffeDellaLinea(linea: Linea, salvataPer: (p: Percorso) => unknown | null, fasce: readonly FasciaKm[]): TariffeDellaLinea {
  const t: TariffeDellaLinea = {
    linea: linea.lineCode, nodi: new Map(), fermate: new Map(), coppie: new Map(),
    percorsi: 0, salvati: 0, fermateContese: [], coppieDiscordi: 0,
  };
  const contese = new Set<string>();
  const discordi = new Set<string>();
  const percorsi = [...linea.percorsi].sort((a, b) => b.tripCount - a.tripCount);
  for (const p of percorsi) {
    const pol = polimetricaDelPercorso(linea, p, salvataPer(p), fasce, new Set(t.nodi.keys()));
    t.percorsi++;
    if (pol.fonte === "salvata") t.salvati++;
    const punti = pol.tratte.map((tr) => pol.fermate[tr.punto]!);
    pol.tratte.forEach((tr, k) => {
      const nodo = punti[k]!.stopId;
      if (!t.nodi.get(nodo)) t.nodi.set(nodo, tr.nome.trim() || punti[k]!.stopName);
      /* le fermate della tratta: dal suo inizio a prima dell'inizio della successiva (l'ultima tratta fino in fondo) */
      const fine = k + 1 < pol.tratte.length ? pol.tratte[k + 1]!.da - 1 : pol.fermate.length - 1;
      for (let i = tr.da; i <= fine; i++) {
        const f = pol.fermate[i]!.stopId;
        const gia = t.fermate.get(f);
        if (gia === undefined) t.fermate.set(f, nodo);
        else if (gia !== nodo) contese.add(f);
      }
    });
    for (let i = 0; i < punti.length; i++) {
      for (let j = i; j < punti.length; j++) {
        const f = fasciaDeiKm(Math.abs(punti[j]!.km - punti[i]!.km), fasce);
        if (f === null) continue;
        const k = coppia(punti[i]!.stopId, punti[j]!.stopId);
        const prima = t.coppie.get(k);
        if (prima === undefined) t.coppie.set(k, f);
        else if (prima !== f) { discordi.add(k); t.coppie.set(k, Math.min(prima, f)); }
      }
    }
  }
  /* dentro lo stesso nodo: la prima fascia */
  const prima = fasce[0]?.fascia;
  if (prima !== undefined) for (const n of t.nodi.keys()) if (!t.coppie.has(coppia(n, n))) t.coppie.set(coppia(n, n), prima);
  t.fermateContese = [...contese].sort();
  t.coppieDiscordi = discordi.size;
  return t;
}

/* ─────────────────────────────────────────────────────────────
 *  I file
 * ───────────────────────────────────────────────────────────── */

export const reteDellaLinea = (linea: string) => `${RETE_EXTRAURBANA}:${linea}`;
export const areaDelNodo = (linea: string, nodo: string) => `${RETE_EXTRAURBANA}:${linea}:${nodo}`;
/** il gruppo delle tratte extraurbane (leg_group_id): uno solo, per eventuali trasbordi */
export const GRUPPO_EXTRAURBANO = "lg_extraurbano";
/**
 * Il titolo del pagamento con carta per un tipo di rete, che è anche il suo
 * gruppo di tratte. I due punti non possono stare negli identificativi del
 * catalogo: nessun titolo dell'azienda lo può coprire.
 */
export const idCarta = (tipo: TipoContactless) => `contactless:${tipo}`;
const NOME_CARTA: Record<TipoContactless, string> = { urbano: "Carta contactless a bordo · urbano", extraurbano: "Carta contactless a bordo · extraurbano" };

export interface DatiDelleTariffe {
  /** le linee e le fermate del GTFS (routes.txt, stops.txt) */
  linee: readonly Riga[];
  fermate: ReadonlySet<string>;
  reti: RetiAzienda;
  titoli: readonly TitoloCatalogo[];
  categorie: readonly CategoriaCatalogo[];
  supporti: readonly SupportoCatalogo[];
  fasce: readonly FasciaKm[];
  /** le linee extraurbane con le loro polimetriche */
  extraurbane: readonly TariffeDellaLinea[];
  /** il pagamento con carta a bordo (6.38); senza, o senza reti, non c'è */
  contactless?: Contactless | null;
}

export interface FileDelleTariffe { file: Gtfs; avvisi: Problema[] }

const file = (colonne: string[], r: Riga[]): FileGtfs => ({ colonne, righe: r });
/** «1 coppia», «3 coppie» */
const quante = (n: number, una: string, tante: string) => `${n} ${n === 1 ? una : tante}`;
const testo = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

/** I file di GTFS Fares v2. Solo quelli con almeno una riga. */
export function fileDelleTariffe(d: DatiDelleTariffe): FileDelleTariffe {
  const avvisi = new Map<string, Problema>();
  const avviso = (codice: string, f: string, messaggio: string, esempio?: string) => {
    let p = avvisi.get(codice);
    if (!p) { p = { codice, file: f, messaggio, quante: 0, esempi: [] }; avvisi.set(codice, p); }
    p.quante++;
    if (esempio && p.esempi.length < 5 && !p.esempi.includes(esempio)) p.esempi.push(esempio);
  };

  /* categorie e supporti */
  const categorie = new Set(d.categorie.map((c) => c.categoria));
  const predefinita = d.categorie.find((c) => c.predefinita)?.categoria ?? "";
  const riderCategories = d.categorie.map((c) => ({
    rider_category_id: c.categoria, rider_category_name: c.nome, is_default_fare_category: c.predefinita ? 1 : 0, eligibility_url: c.url ?? "",
  }));
  const fareMedia = d.supporti.map((s) => ({ fare_media_id: s.supporto, fare_media_name: s.nome, fare_media_type: s.tipo }));

  /* i titoli: il catalogo, più un biglietto per fascia */
  const prodotti: Riga[] = [];
  const idProdotti = new Set<string>();
  for (const t of d.titoli) {
    const nel = titoloNelFeed(t, d.fasce);
    if (!nel) { avviso("titolo_senza_fascia", "fare_products.txt", "titoli per fascia chilometrica la cui fascia non c'è fra le fasce in vigore: restano fuori", t.titolo); continue; }
    if (!categorie.has(t.categoria)) { avviso("titolo_senza_categoria", "fare_products.txt", "titoli con una categoria di passeggero che non c'è fra le categorie: restano fuori", `${t.titolo} (${t.categoria})`); continue; }
    if (idProdotti.has(nel.id)) continue;
    idProdotti.add(nel.id);
    prodotti.push({ fare_product_id: nel.id, fare_product_name: nel.nome, rider_category_id: t.categoria, fare_media_id: "", amount: nel.prezzo.toFixed(2), currency: "EUR" });
  }
  for (const f of d.fasce) {
    const id = idBigliettoFascia(f.fascia);
    if (idProdotti.has(id)) continue;
    idProdotti.add(id);
    prodotti.push({ fare_product_id: id, fare_product_name: `Extraurbano ${f.kmFrom}-${f.kmTo} km`, rider_category_id: predefinita, fare_media_id: "", amount: f.price.toFixed(2), currency: "EUR" });
  }

  /* le reti delle linee */
  const extra = new Map(d.extraurbane.map((x) => [x.linea, x]));
  const urbane = new Map(d.reti.reti.filter((r) => r.tipo === "urbano").map((r) => [r.rete, r]));
  const reti = new Map<string, string>();
  const retiExtraurbane = new Set<string>();
  const routeNetworks: Riga[] = [];
  for (const r of d.linee) {
    const routeId = testo(r.route_id);
    if (!routeId) continue;
    const nome = testo(r.route_short_name) || routeId;
    const rete = reteDalleRegole(nome, d.reti.regole);
    if (urbane.has(rete)) {
      reti.set(rete, urbane.get(rete)!.nome);
      routeNetworks.push({ network_id: rete, route_id: routeId });
    } else {
      const id = reteDellaLinea(nome);
      reti.set(id, `Extraurbano · linea ${nome}`);
      retiExtraurbane.add(id);
      routeNetworks.push({ network_id: id, route_id: routeId });
      if (!extra.has(nome)) avviso("linea_senza_polimetrica", "fare_leg_rules.txt", "linee extraurbane senza percorsi con corse nel programma: senza tariffe", nome);
    }
  }

  /* i trasbordi dentro un gruppo di tratte: le corse che cominciano entro
     `minuti` dalla prima non si pagano (A + 0, senza limite di corse) */
  const transferRules: Riga[] = [];
  const conTrasbordi = new Set<string>();
  const trasbordiDentro = (gruppo: string, minuti: number) => {
    if (conTrasbordi.has(gruppo)) return;
    conTrasbordi.add(gruppo);
    transferRules.push({ from_leg_group_id: gruppo, to_leg_group_id: gruppo, transfer_count: -1, duration_limit: minuti * 60, duration_limit_type: 1, fare_transfer_type: 0, fare_product_id: "" });
  };

  /* le regole urbane: su una rete vale il suo biglietto; un biglietto di corsa
     semplice a tempo vale per tutte le corse che cominciano dentro la durata */
  const legRules: Riga[] = [];
  const prodottiDelFeed = d.titoli
    .filter((t) => idProdotti.has(t.titolo))
    .map((t) => ({ fareProductId: t.titolo, fareProductName: t.nome, networkId: t.rete, fareType: t.tipo, amount: t.prezzo, durationMinutes: t.durataMinuti, isUrbanHourly: t.diRiferimento }));
  const prodottoDi = new Map(prodottiDelFeed.map((p) => [p.fareProductId, p]));
  for (const u of regoleUrbane(prodottiDelFeed, [...urbane.values()].filter((r) => reti.has(r.rete)))) {
    legRules.push({ leg_group_id: u.legGroupId, network_id: u.networkId, from_area_id: "", to_area_id: "", fare_product_id: u.fareProductId, rule_priority: 0 });
    const p = prodottoDi.get(u.fareProductId);
    if (p?.fareType === "single" && (p.durationMinutes ?? 0) > 0) trasbordiDentro(u.legGroupId, p.durationMinutes!);
  }

  /* il pagamento con carta: un titolo per tipo di rete, sulle reti dove vale
     (le urbane scelte, le linee extraurbane se c'è la rete extraurbana) */
  const carta = contactlessAttivo(d.contactless ?? null) ? d.contactless! : null;
  if (carta) {
    const supporto = carta.supporto && d.supporti.some((s) => s.supporto === carta.supporto) ? carta.supporto : "";
    const attive = new Set(carta.reti);
    const tipoDi = new Map(d.reti.reti.map((r) => [r.rete, r.tipo]));
    const conTariffa = new Set(carta.tariffe.map((t) => t.tipo));
    for (const r of carta.reti) {
      const tipo = tipoDi.get(r);
      if (tipo && !conTariffa.has(tipo)) avviso("contactless_senza_tariffa", "fare_leg_rules.txt", "reti col pagamento con carta senza la tariffa del loro tipo: lì la carta non entra nel GTFS", r);
    }
    let regole = 0;
    for (const t of carta.tariffe) {
      const doveVale = t.tipo === "urbano"
        ? [...urbane.keys()].filter((r) => attive.has(r) && reti.has(r))
        : attive.has(RETE_EXTRAURBANA) ? [...retiExtraurbane] : [];
      if (!doveVale.length) continue;
      const id = idCarta(t.tipo);
      idProdotti.add(id);
      prodotti.push({ fare_product_id: id, fare_product_name: NOME_CARTA[t.tipo], rider_category_id: "", fare_media_id: supporto, amount: t.primo.toFixed(2), currency: "EUR" });
      for (const rete of doveVale) legRules.push({ leg_group_id: id, network_id: rete, from_area_id: "", to_area_id: "", fare_product_id: id, rule_priority: 0 });
      trasbordiDentro(id, t.validitaMinuti);
      regole += doveVale.length;
    }
    if (regole && !supporto) {
      avviso("contactless_senza_supporto", "fare_products.txt", "il pagamento con carta non ha un supporto fra quelli dell'azienda: nel GTFS figura senza fare_media (Amministrazione › Azienda, «Pagamento con carta a bordo»)");
    }
  }

  /* le extraurbane: nodi, fermate, coppie */
  const areas: Riga[] = [];
  const stopAreas: Riga[] = [];
  if (d.fasce.length === 0 && d.extraurbane.length > 0) {
    avviso("senza_fasce", "fare_leg_rules.txt", "mancano le fasce chilometriche: le linee extraurbane restano senza tariffe (Amministrazione › Azienda, «Fasce chilometriche»)");
  }
  for (const x of d.extraurbane) {
    if (!reti.has(reteDellaLinea(x.linea))) continue; // la linea non è nel file
    for (const [nodo, nome] of x.nodi) areas.push({ area_id: areaDelNodo(x.linea, nodo), area_name: `${nome} (linea ${x.linea})` });
    for (const [fermata, nodo] of x.fermate) {
      if (!d.fermate.has(fermata)) { avviso("fermata_non_nel_file", "stop_areas.txt", "fermate delle polimetriche che non sono nel file: restano fuori", fermata); continue; }
      stopAreas.push({ area_id: areaDelNodo(x.linea, nodo), stop_id: fermata });
    }
    if (x.fermateContese.length) {
      avviso("fermata_in_piu_nodi", "stop_areas.txt", "linee con fermate che i percorsi mettono in nodi diversi: vale il nodo del percorso più servito", `${x.linea}: ${quante(x.fermateContese.length, "fermata", "fermate")}`);
    }
    if (x.coppieDiscordi) avviso("coppie_discordi", "fare_leg_rules.txt", "linee con coppie di nodi su cui i percorsi danno fasce diverse: vale la più bassa", `${x.linea}: ${quante(x.coppieDiscordi, "coppia", "coppie")}`);
    if (x.salvati < x.percorsi) avviso("percorsi_senza_polimetrica", "fare_leg_rules.txt", "linee extraurbane con percorsi senza una polimetrica salvata: lì le tariffe vengono dalle tratte fatte dalle fasce", `${x.linea}: ${quante(x.percorsi - x.salvati, "percorso", "percorsi")} su ${x.percorsi}`);
    for (const [k, fascia] of x.coppie) {
      const prodotto = idBigliettoFascia(fascia);
      if (!idProdotti.has(prodotto)) continue;
      const [a, b] = k.split("\u0000") as [string, string];
      const rete = reteDellaLinea(x.linea);
      legRules.push({ leg_group_id: GRUPPO_EXTRAURBANO, network_id: rete, from_area_id: areaDelNodo(x.linea, a), to_area_id: areaDelNodo(x.linea, b), fare_product_id: prodotto, rule_priority: 0 });
      if (a !== b) legRules.push({ leg_group_id: GRUPPO_EXTRAURBANO, network_id: rete, from_area_id: areaDelNodo(x.linea, b), to_area_id: areaDelNodo(x.linea, a), fare_product_id: prodotto, rule_priority: 0 });
    }
  }

  const tutti: Gtfs = {
    "rider_categories.txt": file(["rider_category_id", "rider_category_name", "is_default_fare_category", "eligibility_url"], riderCategories),
    "fare_media.txt": file(["fare_media_id", "fare_media_name", "fare_media_type"], fareMedia),
    "fare_products.txt": file(["fare_product_id", "fare_product_name", "rider_category_id", "fare_media_id", "amount", "currency"], prodotti),
    "networks.txt": file(["network_id", "network_name"], [...reti].map(([network_id, network_name]) => ({ network_id, network_name }))),
    "route_networks.txt": file(["network_id", "route_id"], routeNetworks),
    "areas.txt": file(["area_id", "area_name"], areas),
    "stop_areas.txt": file(["area_id", "stop_id"], stopAreas),
    "fare_leg_rules.txt": file(["leg_group_id", "network_id", "from_area_id", "to_area_id", "fare_product_id", "rule_priority"], legRules),
    "fare_transfer_rules.txt": file(["from_leg_group_id", "to_leg_group_id", "transfer_count", "duration_limit", "duration_limit_type", "fare_transfer_type", "fare_product_id"], transferRules),
  };
  /* senza titoli non ci sono tariffe: niente file (le reti da sole non dicono un prezzo) */
  const conTariffe = prodotti.length > 0;
  const fileUtili: Gtfs = conTariffe ? Object.fromEntries(Object.entries(tutti).filter(([, f]) => f.righe.length > 0)) : {};
  return { file: fileUtili, avvisi: [...avvisi.values()] };
}

/* ─────────────────────────────────────────────────────────────
 *  Dal database
 * ───────────────────────────────────────────────────────────── */

/**
 * Le polimetriche salvate (su qualunque fotografia), per chiave del percorso
 * (linea e fermate nel verso d'andata): la più recente, quella d'andata se c'è.
 */
export async function polimetricheSalvate(ex: Esecutore): Promise<Map<string, unknown>> {
  const r = righe(await ex.execute(sql`
    SELECT line_code, direction, name, boundaries, tratte, stops, updated_at
      FROM polim_polimetriche ORDER BY (direction = 'AB') DESC, updated_at DESC`));
  const per = new Map<string, unknown>();
  for (const s of r) {
    const fermate = (Array.isArray(s.stops) ? s.stops : []).map((f: any) => String(f?.stopId ?? ""));
    const inAndata = s.direction === "BA" ? [...fermate].reverse() : fermate;
    const k = chiaveDelPercorso(String(s.line_code ?? ""), inAndata);
    if (!per.has(k)) per.set(k, s);
  }
  return per;
}

export interface TariffeDelGtfs extends FileDelleTariffe {
  conteggi: { linee: number; percorsi: number; salvati: number; nodi: number; regole: number; contactless: number; trasbordi: number };
}

/**
 * Le tariffe del GTFS del programma `progettoId`: legge i dati dell'azienda,
 * le linee del programma e le polimetriche, e fa i file. `gtfs` è il GTFS
 * degli orari (le sue linee e fermate).
 */
export async function tariffeDelGtfs(progettoId: string, gtfs: Gtfs, ex: Esecutore = db): Promise<TariffeDelGtfs> {
  const [reti, fasce, titoli, categorie, supporti, contactless] = await Promise.all([
    /* rilette e messe in vigore: la fotografia classifica le linee con le reti in vigore, i file con queste */
    rileggiReti(ex as any), fasceDalDatabase(ex as any), catalogoTitoli(ex as any), categorieCatalogo(ex as any), supportiCatalogo(ex as any),
    contactlessDalDatabase(ex),
  ]);
  const [dati, salvate] = await Promise.all([datiDelProgramma(ex, progettoId), polimetricheSalvate(ex)]);
  const foto = dati ? fotografia(dati) : { agencyName: null, lines: [] as Linea[] };
  const extraurbane = foto.lines.map((l) => tariffeDellaLinea(l, (p) => salvate.get(chiaveDelPercorso(l.lineCode, p.stops.map((s) => s.stopId))) ?? null, fasce));
  const fatti = fileDelleTariffe({
    linee: gtfs["routes.txt"]?.righe ?? [],
    fermate: new Set((gtfs["stops.txt"]?.righe ?? []).map((s) => testo(s.stop_id))),
    reti, titoli, categorie, supporti, fasce, extraurbane, contactless,
  });
  return {
    ...fatti,
    conteggi: {
      linee: extraurbane.length,
      percorsi: extraurbane.reduce((n, x) => n + x.percorsi, 0),
      salvati: extraurbane.reduce((n, x) => n + x.salvati, 0),
      nodi: fatti.file["areas.txt"]?.righe.length ?? 0,
      regole: fatti.file["fare_leg_rules.txt"]?.righe.length ?? 0,
      contactless: (fatti.file["fare_leg_rules.txt"]?.righe ?? []).filter((r) => String(r.fare_product_id).startsWith("contactless:")).length,
      trasbordi: fatti.file["fare_transfer_rules.txt"]?.righe.length ?? 0,
    },
  };
}

/**
 * L'impronta di tutto quello che finisce nelle tariffe del GTFS: catalogo,
 * categorie, supporti, reti, fasce, polimetriche salvate e pagamento con
 * carta. Entra nella firma del GTFS dei dati aperti: un prezzo cambiato rifà
 * il file.
 */
export async function improntaDelleTariffe(ex: Esecutore = db): Promise<string> {
  const r = righe(await ex.execute(sql`
    SELECT concat_ws('#',
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM titoli_catalogo x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM categorie_catalogo x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM supporti_catalogo x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM reti x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM reti_regole x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM fasce_km x),
      (SELECT string_agg(concat_ws(',', x.massimale_unico, x.finestra_ore, x.supporto), '|') FROM contactless x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM contactless_tariffe x),
      (SELECT string_agg(x::text, '|' ORDER BY x::text) FROM contactless_reti x),
      (SELECT string_agg(x.id::text || ':' || x.updated_at::text, '|' ORDER BY x.id) FROM polim_polimetriche x)
    ) AS tutto`))[0];
  return createHash("sha256").update(String(r?.tutto ?? "")).digest("hex");
}

/** Il GTFS con le tariffe, e gli avvisi delle tariffe da mettere accanto a quelli della verifica. */
export async function conLeTariffe(progettoId: string, gtfs: Gtfs, ex: Esecutore = db): Promise<{ gtfs: Gtfs; tariffe: TariffeDelGtfs }> {
  const tariffe = await tariffeDelGtfs(progettoId, gtfs, ex);
  return { gtfs: { ...gtfs, ...tariffe.file }, tariffe };
}
