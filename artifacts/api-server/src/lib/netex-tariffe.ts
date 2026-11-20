/**
 * NeTEx con il profilo italiano, livello 3: le tariffe (tappa 6.40).
 *
 * Riferimenti: «Linee guida per la compilazione del profilo italiano del
 * NeTEx» v5.0.1, par. 5.2.5.7 (TariffZones) e 5.2.7 (FareFrame), e lo schema
 * del livello 3 (assets/netex-it, dal repository 5Tsrl/netex-italian-profile).
 *
 * Si costruisce dalle tariffe del GTFS consegnabile (lib/gtfs-tariffe.ts,
 * tappa 6.37), più quello che il GTFS non sa dire: il tipo e la durata di
 * ogni titolo del catalogo, le fasce chilometriche, e del pagamento con carta
 * il secondo e il terzo viaggio e i massimali (tappa 6.38). Qui solo la
 * traduzione, pura: niente database.
 *
 *   ServiceFrame › tariffZones   le reti urbane del file e i nodi tariffari
 *                                delle linee extraurbane; ogni punto di
 *                                fermata dice le sue zone
 *   FareFrame (EU_PI_FARE)
 *     geographicalUnits          il chilometro
 *     tariffs › Tariff           le fasce (GeographicalInterval), le durate
 *                                (TimeInterval), un elemento tariffario per
 *                                titolo (FareStructureElement), le coppie di
 *                                nodi delle polimetriche (DistanceMatrixElement)
 *     validableElements          uno per titolo
 *     usageParameters            i periodi di validità e i profili di utente
 *                                (le categorie di passeggero)
 *     fareProducts               un PreassignedFareProduct per titolo
 *     fareTables                 i prezzi: del titolo, di ogni coppia di nodi,
 *                                di ogni fascia, i massimali della carta
 *     distributionChannels       a bordo, con la carta (se c'è la carta)
 *     typesOfTravelDocuments     i supporti
 *     salesOfferPackages         uno per titolo: prezzi, supporto, titolo
 *
 * L'extraurbano di corsa semplice è un titolo solo: il prezzo è quello della
 * coppia di nodi (la fascia dei km fra i loro punti tariffari). Nel GTFS sono
 * un biglietto per fascia, perché lì un prezzo sta sul titolo.
 */
import type { Gtfs, Riga } from "./gtfs-verifica";
import type { FasciaKm } from "./fasce-km";
import { idBigliettoFascia, type TipoTitolo } from "./titoli-catalogo";
import { contactlessAttivo, type Contactless, type TipoContactless } from "./contactless";
import { RETE_EXTRAURBANA } from "./reti-linee";

/** Di un titolo del catalogo, quello che il GTFS non dice. */
export interface TitoloPerNetex { tipo: TipoTitolo; durataMinuti: number | null; fascia: number | null; rete: string }

/** Quello che serve al livello 3 oltre ai file tariffari del GTFS. */
export interface TariffePerNetex {
  /** per identificativo del titolo (fare_product_id) */
  titoli: ReadonlyMap<string, TitoloPerNetex>;
  fasce: readonly FasciaKm[];
  contactless: Contactless | null;
}

/** Gli attrezzi del file in cui le tariffe entrano (lib/netex.ts). */
export interface AttrezziNetex {
  /** l'identificativo di un oggetto: [prefisso]:IT:[codice locale]:[Tipo]:[codice] */
  id: (tipo: string, codice: string) => string;
  /** l'identificativo del FareFrame */
  frame: string;
  /** le fermate e le linee scritte nel file (stop_id, route_id) */
  fermate: ReadonlySet<string>;
  linee: ReadonlySet<string>;
}

export interface ConteggiTariffeNetex {
  zone: number; prodotti: number; profili: number; supporti: number; coppie: number; fasce: number;
  /** titoli del GTFS che non sono nel catalogo, lasciati fuori */
  fuori: number;
}

export interface TariffeNetex {
  /** le TariffZone, per lo ServiceFrame */
  zone: string[];
  /** fermata (stop_id) → gli identificativi delle sue zone */
  zoneDellaFermata: Map<string, string[]>;
  /** il FareFrame, riga per riga */
  fareFrame: string[];
  conteggi: ConteggiTariffeNetex;
}

/* ── Piccoli attrezzi ────────────────────────────────────────────────────── */

const xml = (v: unknown) => String(v ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const testo = (v: unknown) => (v == null ? "" : String(v).trim());
const V = 'version="1"';
const euro = (n: number) => n.toFixed(2);
const soldi = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

/** Una durata in minuti come la vuole lo schema: «PT60M», e i giorni interi «P30D». */
export function durataIso(minuti: number): string {
  return minuti % 1440 === 0 ? `P${minuti / 1440}D` : `PT${minuti}M`;
}

/** Il codice di una zona da un'area del GTFS: i due punti separano le parti degli identificativi NeTEx. */
export const codiceZona = (areaId: string) => areaId.replace(/:/g, "-");

const TIPI_UTENTE = [
  "adult", "child", "infant", "senior", "student", "youngPerson", "schoolPupil", "military", "disabled", "disabledCompanion",
  "jobSeeker", "employee", "animal", "guideDog", "member", "other", "anyone",
] as const;
type TipoUtente = (typeof TIPI_UTENTE)[number];

/**
 * Il profilo di utente di una categoria di passeggero. Lo schema non ha il
 * nome del profilo: dice il tipo e, se c'è, l'età. Si legge dall'identificativo
 * e dal nome della categoria («Studente under 14» → studente, al più 13 anni);
 * la categoria predefinita vale per tutti.
 */
export function profiloDellaCategoria(categoria: string, nome: string, predefinita: boolean): { tipo: TipoUtente; minima: number | null; massima: number | null } {
  const t = `${categoria} ${nome}`.toLowerCase();
  const sotto = /under\s*(\d{1,3})/.exec(t);
  const sopra = /over\s*(\d{1,3})/.exec(t) ?? /(\d{1,3})\s*\+/.exec(t);
  const minima = sopra ? Number(sopra[1]) : null;
  const massima = sotto ? Math.max(0, Number(sotto[1]) - 1) : null;
  if (predefinita) return { tipo: "anyone", minima: null, massima: null };
  const tipo: TipoUtente = /anzian|senior|argento|over\s*\d/.test(t) ? "senior"
    : /studen|scolar|univ/.test(t) ? "student"
      : /bambin|infanzia/.test(t) ? "child"
        : /disab|invalid/.test(t) ? "disabled"
          : /militar/.test(t) ? "military"
            : /dipendent/.test(t) ? "employee"
              : /giovan|ragazz/.test(t) ? "youngPerson"
                : "other";
  return { tipo, minima, massima };
}

/** Il periodo di validità di un titolo del catalogo: il tipo NeTEx e la durata. */
export function periodoDelTitolo(tipo: TipoTitolo, durataMinuti: number | null): { codice: string; tipo: string; durata: string | null } {
  const d = durataMinuti && durataMinuti > 0 ? durataIso(durataMinuti) : null;
  switch (tipo) {
    case "single": return d ? { codice: `corsa-${d}`, tipo: "singleTrip", durata: d } : { codice: "corsa-semplice", tipo: "singleRide", durata: null };
    case "return": return { codice: `andata-ritorno${d ? `-${d}` : ""}`, tipo: "returnTrip", durata: d };
    case "abbonamento_settimanale": return { codice: `settimanale${d ? `-${d}` : ""}`, tipo: "weeklyPass", durata: d };
    case "abbonamento_mensile": return { codice: `mensile${d ? `-${d}` : ""}`, tipo: "monthlyPass", durata: d };
    case "abbonamento_annuale": return { codice: `annuale${d ? `-${d}` : ""}`, tipo: "annualPass", durata: d };
    default: return { codice: `altro${d ? `-${d}` : ""}`, tipo: "other", durata: d };
  }
}

/* GTFS fare_media_type → il tipo di supporto NeTEx */
const SUPPORTO: Record<string, { carta: boolean; smart: boolean; media: string; lettura: string | null }> = {
  "0": { carta: false, smart: false, media: "none", lettura: null },
  "1": { carta: false, smart: false, media: "paperTicket", lettura: null },
  "2": { carta: true, smart: true, media: "smartCard", lettura: "chip nfc" },
  "3": { carta: true, smart: true, media: "card", lettura: "chip nfc" },
  "4": { carta: false, smart: false, media: "mobileApp", lettura: "barCode" },
};

const NOME_TIPO: Record<TipoContactless, string> = { urbano: "urbano", extraurbano: "extraurbano" };

/* ── La traduzione ───────────────────────────────────────────────────────── */

/**
 * Le zone e il FareFrame dalle tariffe del GTFS. Null se il GTFS non ha
 * titoli: allora il file resta di livello 1.
 */
export function tariffeNetex(gtfs: Gtfs, t: TariffePerNetex, a: AttrezziNetex): TariffeNetex | null {
  const righe = (f: string): Riga[] => gtfs[f]?.righe ?? [];
  const prodottiGtfs = new Map<string, Riga>();
  for (const p of righe("fare_products.txt")) {
    const id = testo(p.fare_product_id);
    if (id && !prodottiGtfs.has(id)) prodottiGtfs.set(id, p);
  }
  if (prodottiGtfs.size === 0) return null;
  const id = a.id;

  /* ── le zone ── */
  const reteDellaLinea = new Map(righe("route_networks.txt").map((r) => [testo(r.route_id), testo(r.network_id)]));
  const nomeDellaRete = new Map(righe("networks.txt").map((r) => [testo(r.network_id), testo(r.network_name)]));
  const reteExtra = (rete: string) => rete.startsWith(`${RETE_EXTRAURBANA}:`);
  /* le reti urbane: una zona ciascuna, con le fermate delle sue linee */
  const urbane = new Map<string, Set<string>>();
  for (const [rete] of nomeDellaRete) if (!reteExtra(rete)) urbane.set(rete, new Set());
  const lineaDellaCorsa = new Map(righe("trips.txt").map((c) => [testo(c.trip_id), testo(c.route_id)]));
  for (const st of righe("stop_times.txt")) {
    const fermata = testo(st.stop_id);
    if (!a.fermate.has(fermata)) continue;
    const rete = reteDellaLinea.get(lineaDellaCorsa.get(testo(st.trip_id)) ?? "");
    if (rete) urbane.get(rete)?.add(fermata);
  }
  /* i nodi delle linee extraurbane: le aree del GTFS */
  const nodi = new Map(righe("areas.txt").map((r) => [testo(r.area_id), testo(r.area_name)]));
  const zoneDellaFermata = new Map<string, string[]>();
  const aggiungi = (fermata: string, zona: string) => {
    if (!a.fermate.has(fermata)) return;
    const l = zoneDellaFermata.get(fermata);
    if (!l) zoneDellaFermata.set(fermata, [zona]); else if (!l.includes(zona)) l.push(zona);
  };
  const zona = (codice: string) => id("TariffZone", codice);
  for (const [rete, fermate] of urbane) for (const f of fermate) aggiungi(f, zona(rete));
  for (const r of righe("stop_areas.txt")) if (nodi.has(testo(r.area_id))) aggiungi(testo(r.stop_id), zona(codiceZona(testo(r.area_id))));
  const zone: string[] = [
    ...[...urbane.keys()].map((rete) => `<TariffZone id="${zona(rete)}" ${V}><Name>${xml(nomeDellaRete.get(rete) || rete)}</Name></TariffZone>`),
    ...[...nodi].map(([area, nome]) => `<TariffZone id="${zona(codiceZona(area))}" ${V}><Name>${xml(nome || area)}</Name></TariffZone>`),
  ];

  /* ── quello che finisce nel FareFrame, per parti ── */
  const intervalli: string[] = [];       // GeographicalInterval
  const durate = new Map<number, string>(); // minuti → TimeInterval
  const elementi: string[] = [];         // FareStructureElement
  const coppie: string[] = [];           // DistanceMatrixElement
  const validabili: string[] = [];       // ValidableElement
  const periodi = new Map<string, string>(); // UsageValidityPeriod
  const prodotti: string[] = [];         // PreassignedFareProduct
  const tabelle: string[] = [];          // FareTable
  const canali: string[] = [];           // DistributionChannel
  const pacchetti: string[] = [];        // SalesOfferPackage

  /* i profili di utente: le categorie del GTFS */
  const profili = righe("rider_categories.txt").map((c) => {
    const categoria = testo(c.rider_category_id);
    const p = profiloDellaCategoria(categoria, testo(c.rider_category_name), String(c.is_default_fare_category) === "1");
    return {
      categoria,
      xml: `<UserProfile id="${id("UserProfile", categoria)}" ${V}><UserType>${p.tipo}</UserType>`
        + (p.minima !== null ? `<MinimumAge>${p.minima}</MinimumAge>` : "")
        + (p.massima !== null ? `<MaximumAge>${p.massima}</MaximumAge>` : "")
        + "</UserProfile>",
    };
  });
  const conProfilo = new Set(profili.map((p) => p.categoria));

  /* i supporti: i fare_media del GTFS */
  const supporti = righe("fare_media.txt").map((m) => {
    const s = SUPPORTO[testo(m.fare_media_type)] ?? SUPPORTO["0"]!;
    return {
      supporto: testo(m.fare_media_id),
      xml: `<TypeOfTravelDocument id="${id("TypeOfTravelDocument", testo(m.fare_media_id))}" ${V}>`
        + `<IsCard>${s.carta}</IsCard><IsSmartCard>${s.smart}</IsSmartCard><HasPhoto>false</HasPhoto><MediaType>${s.media}</MediaType>`
        + (s.lettura ? `<MachineReadable>${s.lettura}</MachineReadable>` : "")
        + "</TypeOfTravelDocument>",
    };
  });
  const conSupporto = new Set(supporti.map((s) => s.supporto));

  const periodo = (codice: string, tipo: string, durata: string | null) => {
    if (!periodi.has(codice)) {
      periodi.set(codice, `<UsageValidityPeriod id="${id("UsageValidityPeriod", codice)}" ${V}><ValidityPeriodType>${tipo}</ValidityPeriodType>`
        + (durata ? `<StandardDuration>${durata}</StandardDuration>` : "") + "</UsageValidityPeriod>");
    }
    return id("UsageValidityPeriod", codice);
  };
  const durata = (minuti: number) => {
    if (!durate.has(minuti)) {
      durate.set(minuti, `<TimeInterval id="${id("TimeInterval", `${minuti}min`)}" ${V}><Description>${minuti} minuti</Description><Duration>${durataIso(minuti)}</Duration></TimeInterval>`);
    }
    return id("TimeInterval", `${minuti}min`);
  };
  const ref = (tipo: string, v: string) => `<${tipo} ref="${v}" ${V}/>`;
  /** il periodo e il profilo di un elemento tariffario, e dove vale */
  const assegnazione = (codice: string, ordine: number, o: { periodo?: string; profilo?: string; zone?: readonly string[]; linee?: readonly string[] }) => {
    const limiti = (o.periodo ? ref("UsageValidityPeriodRef", o.periodo) : "") + (o.profilo ? ref("UserProfileRef", o.profilo) : "");
    const dove = [...(o.linee ?? []).map((l) => ref("LineRef", l)), ...(o.zone ?? []).map((z) => ref("TariffZoneRef", z))].join("");
    return `<GenericParameterAssignment id="${id("GenericParameterAssignment", `${codice}-${ordine}`)}" ${V} order="${ordine}">`
      + (limiti ? `<limitations>${limiti}</limitations>` : "")
      + (dove ? `<validityParameters>${dove}</validityParameters>` : "")
      + "</GenericParameterAssignment>";
  };
  /** un elemento tariffario: la fascia, la durata o le coppie, poi chi e dove */
  const elemento = (codice: string, o: { fascia?: string; durata?: string; coppie?: readonly string[]; ordine?: number } & Parameters<typeof assegnazione>[2]) => {
    const ordine = o.ordine ?? 1;
    elementi.push(`<FareStructureElement id="${id("FareStructureElement", codice)}" ${V}>`
      + (o.fascia ? ref("GeographicalIntervalRef", o.fascia) : "")
      + (o.durata ? ref("TimeIntervalRef", o.durata) : "")
      + (o.coppie?.length ? `<distanceMatrixElements>${o.coppie.map((c) => ref("DistanceMatrixElementRef", c)).join("")}</distanceMatrixElements>` : "")
      + `<fareStructureElementsInSequence><FareStructureElementInSequence id="${id("FareStructureElementInSequence", codice)}" ${V} order="${ordine}">`
      + assegnazione(codice, ordine, o)
      + "</FareStructureElementInSequence></fareStructureElementsInSequence></FareStructureElement>");
    return id("FareStructureElement", codice);
  };
  /** il titolo, l'elemento validabile e il pacchetto in vendita */
  const titolo = (codice: string, o: {
    nome: string; descrizione?: string; momento: string; elementi: readonly string[]; tabelle: readonly string[];
    supporto?: string; periodo?: string; canale?: string;
  }) => {
    validabili.push(`<ValidableElement id="${id("ValidableElement", codice)}" ${V}><Name>${xml(o.nome)}</Name>`
      + `<fareStructureElements>${o.elementi.map((e) => ref("FareStructureElementRef", e)).join("")}</fareStructureElements></ValidableElement>`);
    prodotti.push(`<PreassignedFareProduct id="${id("PreassignedFareProduct", codice)}" ${V}><Name>${xml(o.nome)}</Name>`
      + (o.descrizione ? `<Description>${xml(o.descrizione)}</Description>` : "")
      + `<ChargingMomentType>${o.momento}</ChargingMomentType>`
      + (o.periodo ? `<validityParameterAssignments>${assegnazione(`${codice}-titolo`, 1, { periodo: o.periodo })}</validityParameterAssignments>` : "")
      + `<validableElements>${ref("ValidableElementRef", id("ValidableElement", codice))}</validableElements></PreassignedFareProduct>`);
    pacchetti.push(`<SalesOfferPackage id="${id("SalesOfferPackage", codice)}" ${V}>`
      + (o.canale ? `<distributionAssignments><DistributionAssignment id="${id("DistributionAssignment", codice)}" ${V} order="1">${ref("DistributionChannelRef", o.canale)}</DistributionAssignment></distributionAssignments>` : "")
      + `<salesOfferPackageElements><SalesOfferPackageElement id="${id("SalesOfferPackageElement", codice)}" ${V} order="1">`
      + `<fareTables>${o.tabelle.map((x) => ref("FareTableRef", x)).join("")}</fareTables>`
      + (o.supporto && conSupporto.has(o.supporto) ? ref("TypeOfTravelDocumentRef", id("TypeOfTravelDocument", o.supporto)) : "")
      + ref("FareProductRef", id("PreassignedFareProduct", codice))
      + "</SalesOfferPackageElement></salesOfferPackageElements></SalesOfferPackage>");
  };
  const prezzo = (tipo: "FareStructureElementPrice" | "DistanceMatrixElementPrice" | "GeographicalIntervalPrice", codice: string, nome: string, importo: number, rif: string) => {
    const tipoRif = tipo.replace(/Price$/, "Ref");
    return `<${tipo} id="${id(tipo, codice)}" ${V}><Name>${xml(nome)}</Name><Amount>${euro(importo)}</Amount><Currency>EUR</Currency>`
      + `<CanBeCumulative>false</CanBeCumulative>${ref(tipoRif, rif)}</${tipo}>`;
  };
  const tabella = (codice: string, prezzi: readonly string[]) => {
    tabelle.push(`<FareTable id="${id("FareTable", codice)}" ${V}><prices>${prezzi.join("")}</prices></FareTable>`);
    return id("FareTable", codice);
  };

  /* le fasce: un intervallo geografico ciascuna, in chilometri */
  const intervalloDellaFascia = new Map<number, string>();
  if (t.fasce.length) {
    for (const f of t.fasce) {
      const gi = id("GeographicalInterval", `fascia-${f.fascia}`);
      intervalloDellaFascia.set(f.fascia, gi);
      intervalli.push(`<GeographicalInterval id="${gi}" ${V}><Description>${xml(`Fascia ${f.fascia}: da ${f.kmFrom} a ${f.kmTo} km`)}</Description>`
        + `<StartGeographicalValue>${f.kmFrom}</StartGeographicalValue><EndGeographicalValue>${f.kmTo}</EndGeographicalValue>`
        + `${ref("GeographicalUnitRef", id("GeographicalUnit", "km"))}</GeographicalInterval>`);
    }
  }

  /* ── i titoli del catalogo ── */
  let titoliScritti = 0;
  const ignoti: string[] = [];
  for (const [pid, p] of prodottiGtfs) {
    if (pid.startsWith("contactless:") || /^extra_fascia_\d+$/.test(pid)) continue;
    const c = t.titoli.get(pid);
    if (!c) { ignoti.push(pid); continue; }
    const per = periodoDelTitolo(c.tipo, c.durataMinuti);
    const categoria = testo(p.rider_category_id);
    const biglietto = c.tipo === "single" || c.tipo === "return";
    const fse = elemento(pid, {
      fascia: c.fascia !== null ? intervalloDellaFascia.get(c.fascia) : undefined,
      durata: biglietto && c.durataMinuti ? durata(c.durataMinuti) : undefined,
      periodo: periodo(per.codice, per.tipo, per.durata),
      profilo: categoria && conProfilo.has(categoria) ? id("UserProfile", categoria) : undefined,
      zone: urbane.has(c.rete) ? [zona(c.rete)] : [],
    });
    const importo = Number(p.amount);
    const ft = tabella(pid, [prezzo("FareStructureElementPrice", pid, testo(p.fare_product_name), importo, fse)]);
    titolo(pid, { nome: testo(p.fare_product_name), momento: "beforeTravel", elementi: [fse], tabelle: [ft], supporto: testo(p.fare_media_id) || undefined });
    titoliScritti++;
  }

  /* ── l'extraurbano di corsa semplice: le coppie di nodi delle polimetriche ── */
  const prezzoDellaFascia = new Map<string, { fascia: number; importo: number }>();
  for (const f of t.fasce) {
    const p = prodottiGtfs.get(idBigliettoFascia(f.fascia));
    if (p) prezzoDellaFascia.set(idBigliettoFascia(f.fascia), { fascia: f.fascia, importo: Number(p.amount) });
  }
  const prezziCoppie: string[] = [];
  const refCoppie: string[] = [];
  for (const r of righe("fare_leg_rules.txt")) {
    const da = testo(r.from_area_id), al = testo(r.to_area_id), f = prezzoDellaFascia.get(testo(r.fare_product_id));
    if (!da || !al || !f || !nodi.has(da) || !nodi.has(al)) continue;
    const codice = `${codiceZona(da)}--${al.split(":").pop()}`;
    const dme = id("DistanceMatrixElement", codice);
    refCoppie.push(dme);
    coppie.push(`<DistanceMatrixElement id="${dme}" ${V}>${ref("StartTariffZoneRef", zona(codiceZona(da)))}${ref("EndTariffZoneRef", zona(codiceZona(al)))}</DistanceMatrixElement>`);
    prezziCoppie.push(prezzo("DistanceMatrixElementPrice", codice, `Fascia ${f.fascia}`, f.importo, dme));
  }
  if (refCoppie.length) {
    const predefinita = righe("rider_categories.txt").find((c) => String(c.is_default_fare_category) === "1");
    const fse = elemento("extraurbano-corsa-semplice", {
      coppie: refCoppie,
      periodo: periodo("corsa-semplice", "singleRide", null),
      profilo: predefinita ? id("UserProfile", testo(predefinita.rider_category_id)) : undefined,
    });
    const ftCoppie = tabella("extraurbano-coppie", prezziCoppie);
    const ftFasce = tabella("extraurbano-fasce", t.fasce
      .filter((f) => prezzoDellaFascia.has(idBigliettoFascia(f.fascia)))
      .map((f) => prezzo("GeographicalIntervalPrice", `fascia-${f.fascia}`, `Fascia ${f.fascia} (${f.kmFrom}-${f.kmTo} km)`, f.price, intervalloDellaFascia.get(f.fascia)!)));
    titolo("extraurbano-corsa-semplice", {
      nome: "Extraurbano, corsa semplice",
      descrizione: "Il prezzo è quello della fascia dei chilometri fra i nodi tariffari di salita e di discesa, sulla stessa linea",
      momento: "beforeTravel", elementi: [fse], tabelle: [ftCoppie, ftFasce],
    });
  }

  /* ── il pagamento con carta a bordo: tre viaggi a prezzo, un massimale ── */
  let titoliCarta = 0;
  const carta = contactlessAttivo(t.contactless) ? t.contactless : null;
  if (carta) {
    const attive = new Set(carta.reti);
    const lineeExtra = [...reteDellaLinea].filter(([l, rete]) => reteExtra(rete) && a.linee.has(l)).map(([l]) => id("Line", l));
    const dove = (tipo: TipoContactless) => tipo === "urbano"
      ? { zone: [...urbane.keys()].filter((r) => attive.has(r)).map(zona), linee: [] as string[] }
      : { zone: [] as string[], linee: attive.has(RETE_EXTRAURBANA) ? lineeExtra : [] };
    const scritti = carta.tariffe.filter((x) => { const d = dove(x.tipo); return d.zone.length + d.linee.length > 0; });
    if (scritti.length) {
      const canale = id("DistributionChannel", "a-bordo-carta");
      canali.push(`<DistributionChannel id="${canale}" ${V}><Name>A bordo, con la carta</Name>`
        + "<Description>Si avvicina al validatore una carta bancaria contactless, o uno smartphone o un orologio con un portafoglio digitale</Description>"
        + "<DistributionChannelType>onBoard</DistributionChannelType><PaymentMethods>contactlessPaymentCard</PaymentMethods></DistributionChannel>");
      const finestra = periodo(`carta-${carta.finestraOre}h`, "cap", durataIso(carta.finestraOre * 60));
      const unico = carta.massimaleUnico !== null && scritti.length > 1
        ? tabella("contactless-massimale-unico", [`<CappingRulePrice id="${id("CappingRulePrice", "contactless-massimale-unico")}" ${V}><Name>Massimale unico</Name><Amount>${euro(carta.massimaleUnico)}</Amount><Currency>EUR</Currency></CappingRulePrice>`])
        : null;
      for (const x of scritti) {
        const codice = `contactless-${x.tipo}`;
        const d = dove(x.tipo);
        const per = periodo(`carta-${durataIso(x.validitaMinuti)}`, "singleTrip", durataIso(x.validitaMinuti));
        const viaggi = [x.primo, x.secondo, x.terzo];
        const fse = viaggi.map((_, i) => elemento(`${codice}-${i + 1}`, { durata: durata(x.validitaMinuti), periodo: per, ordine: i + 1, ...d }));
        const ft = tabella(codice, [
          `<CappingRulePrice id="${id("CappingRulePrice", codice)}" ${V}><Name>Massimale</Name><Amount>${euro(x.massimale)}</Amount><Currency>EUR</Currency></CappingRulePrice>`,
          ...viaggi.map((importo, i) => prezzo("FareStructureElementPrice", `${codice}-${i + 1}`, `${i + 1}° viaggio`, importo, fse[i]!)),
        ]);
        titolo(codice, {
          nome: `Carta contactless a bordo · ${NOME_TIPO[x.tipo]}`,
          descrizione: `1° viaggio ${soldi(x.primo)} (vale ${x.validitaMinuti} minuti), 2° ${soldi(x.secondo)}, 3° ${soldi(x.terzo)}; al massimo ${soldi(x.massimale)} in ${carta.finestraOre} ore dal primo tap`
            + (unico ? `; usando urbano ed extraurbano al massimo ${soldi(carta.massimaleUnico!)}` : ""),
          momento: "atEndOfFareDay", elementi: fse, tabelle: unico ? [ft, unico] : [ft], supporto: carta.supporto ?? undefined,
          periodo: finestra, canale,
        });
        titoliCarta++;
      }
    }
  }

  /* ── il FareFrame, nell'ordine dello schema ── */
  const f: string[] = [];
  const p = (s: string) => f.push(s);
  p(`<FareFrame id="${a.frame}" ${V}>`);
  p('<TypeOfFrameRef ref="epip:EU_PI_FARE" versionRef="1.0"/>');
  p("<FrameDefaults><DefaultCurrency>EUR</DefaultCurrency></FrameDefaults>");
  if (intervalli.length) p(`<geographicalUnits><GeographicalUnit id="${id("GeographicalUnit", "km")}" ${V}><Name>Chilometro</Name><Distance>1000</Distance></GeographicalUnit></geographicalUnits>`);
  p(`<tariffs><Tariff id="${id("Tariff", "tariffe")}" ${V}>`);
  if (intervalli.length) { p("<geographicalIntervals>"); intervalli.forEach(p); p("</geographicalIntervals>"); }
  if (durate.size) { p("<timeIntervals>"); [...durate.keys()].sort((x, y) => x - y).forEach((m) => p(durate.get(m)!)); p("</timeIntervals>"); }
  if (elementi.length) { p("<fareStructureElements>"); elementi.forEach(p); p("</fareStructureElements>"); }
  if (coppie.length) { p("<distanceMatrixElements>"); coppie.forEach(p); p("</distanceMatrixElements>"); }
  p("</Tariff></tariffs>");
  if (validabili.length) { p("<validableElements>"); validabili.forEach(p); p("</validableElements>"); }
  if (periodi.size || profili.length) { p("<usageParameters>"); [...periodi.values()].forEach(p); profili.forEach((x) => p(x.xml)); p("</usageParameters>"); }
  if (prodotti.length) { p("<fareProducts>"); prodotti.forEach(p); p("</fareProducts>"); }
  if (tabelle.length) { p("<fareTables>"); tabelle.forEach(p); p("</fareTables>"); }
  if (canali.length) { p("<distributionChannels>"); canali.forEach(p); p("</distributionChannels>"); }
  if (supporti.length) { p("<typesOfTravelDocuments>"); supporti.forEach((x) => p(x.xml)); p("</typesOfTravelDocuments>"); }
  if (pacchetti.length) { p("<salesOfferPackages>"); pacchetti.forEach(p); p("</salesOfferPackages>"); }
  p("</FareFrame>");

  return {
    zone, zoneDellaFermata, fareFrame: f,
    conteggi: {
      zone: zone.length, prodotti: titoliScritti + (refCoppie.length ? 1 : 0) + titoliCarta,
      profili: profili.length, supporti: supporti.length, coppie: refCoppie.length, fasce: intervalli.length,
      fuori: ignoti.length,
    },
  };
}
