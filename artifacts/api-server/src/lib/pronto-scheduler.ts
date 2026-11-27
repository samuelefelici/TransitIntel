/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRONTO PER LO SCHEDULER — i controlli prima di un giro, le regole
 * ───────────────────────────────────────────────────────────────────────────
 * Un giro dello scheduler dura minuti e lascia scenari nella Fucina: se parte
 * su dati sbagliati, il risultato sembra un risultato e non lo è. Qui si
 * guarda prima, sull'UDP che il giro userà:
 *
 *   udp_allineata      le corse dell'UDP sono quelle che circolano nei suoi
 *                      giorni? Una linea che circola quei giorni ma non è
 *                      nell'UDP (né in un'altra UDP degli stessi giorni) è un
 *                      ERRORE: il riallineamento al lancio guarda solo le
 *                      linee che l'UDP ha già, quindi da sola non entra mai.
 *                      Le corse in più o in meno sulle stesse linee sono un
 *                      avviso: il lancio le riallinea.
 *   tipi_mezzo         ogni linea ha il tipo di mezzo dichiarato (senza, il
 *                      giro si rifiuta o ricade su un tipo di comodo).
 *   depositi           i depositi del giro: indicati e del progetto.
 *   archi_fuorilinea   ogni capolinea ha un arco fuorilinea con almeno uno
 *                      dei depositi del giro (in un verso o nell'altro: il
 *                      giro usa il verso opposto quando ne manca uno).
 *   margini_capolinea  andata e ritorno al capolinea: un ritorno che riparte
 *                      nello stesso minuto in cui l'andata arriva (sosta
 *                      zero) è un errore; margine scarso, ritorno o andata
 *                      senza la sua corsa sono avvisi (fuorilinea in più: la
 *                      prima corsa del giorno esce dal deposito, ed è giusto).
 *   margini_reali      dai transiti SIRI: le corse il cui delta finale non
 *                      assorbe il ritardo all'85° percentile.
 *   dati_reali         le linee con pochi tratti osservati: i loro tempi
 *                      restano quelli programmati.
 *
 * Errore = il giro non parte. Avviso = parte, ma lo si dice.
 * Funzioni pure: le letture stanno in pronto-scheduler-db.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type Livello = "errore" | "avviso" | "ok";
export type ChiaveControllo =
  | "udp_allineata" | "tipi_mezzo" | "depositi" | "archi_fuorilinea"
  | "margini_capolinea" | "margini_reali" | "dati_reali";

export interface Controllo {
  chiave: ChiaveControllo;
  livello: Livello;
  titolo: string;
  /** quanti elementi non vanno (0 se ok) */
  numero: number;
  dettaglio: string;
  /** qualche esempio leggibile (linee, capolinea, corse) */
  campioni: string[];
  /** come si sistema, in parole */
  rimedio: string | null;
}

export interface Esito {
  pronto: boolean;
  errori: number;
  avvisi: number;
  controlli: Controllo[];
}

/** Sotto questa quota di tempo coperto da tratti osservati, una linea è «senza dati reali». */
export const COPERTURA_MINIMA_PCT = 50;
const CAMPIONI = 12;

const ok = (chiave: ChiaveControllo, titolo: string, dettaglio: string): Controllo =>
  ({ chiave, livello: "ok", titolo, numero: 0, dettaglio, campioni: [], rimedio: null });

/** «1/4 (68), 2 (28)» dalle etichette ripetute, le più numerose prima. */
export function conteggi(etichette: string[]): string[] {
  const n = new Map<string, number>();
  for (const e of etichette) n.set(e, (n.get(e) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "it", { numeric: true }))
    .map(([e, k]) => `${e} (${k})`);
}

/* ───────────────────────────── l'UDP ───────────────────────────── */

export interface DatiUdp {
  /** le corse salvate nell'UDP */
  salvate: string[];
  /** le corse che circolano nelle date dell'UDP (prototipi esclusi) */
  attive: Set<string>;
  /** corsa → linea (id) e linea → etichetta */
  lineaDi: Map<string, string>;
  etichetta: Map<string, string>;
  /** le corse di altre UDP del progetto con date in comune */
  inAltreUdp: Set<string>;
}

export function controlloUdp(d: DatiUdp): Controllo {
  const titolo = "L'UDP è allineata alle validità";
  const salvate = new Set(d.salvate);
  const scope = new Set(d.salvate.map(id => d.lineaDi.get(id)).filter((x): x is string => !!x));
  const nome = (r: string | undefined) => (r && d.etichetta.get(r)) || r || "?";
  const fuori: string[] = [];
  const nuove: string[] = [];
  for (const id of d.attive) {
    if (salvate.has(id)) continue;
    const r = d.lineaDi.get(id);
    if (r && scope.has(r)) nuove.push(id);
    else if (!d.inAltreUdp.has(id)) fuori.push(id);
  }
  const morte = d.salvate.filter(id => !d.attive.has(id));
  if (fuori.length) {
    return {
      chiave: "udp_allineata", livello: "errore", titolo, numero: fuori.length,
      dettaglio: `${fuori.length} corse circolano nei giorni dell'UDP su linee che l'UDP non ha (e nessun'altra UDP di quei giorni): `
        + `il riallineamento al lancio guarda solo le linee dell'UDP, quindi queste non entrerebbero nel giro.`
        + (nuove.length || morte.length ? ` In più, sulle linee dell'UDP, ${nuove.length} corse da aggiungere e ${morte.length} da togliere.` : ""),
      campioni: conteggi(fuori.map(id => nome(d.lineaDi.get(id)))).slice(0, CAMPIONI),
      rimedio: "Allarga l'UDP a quelle linee (riallinea), oppure togli loro la validità di quei giorni.",
    };
  }
  if (nuove.length || morte.length) {
    return {
      chiave: "udp_allineata", livello: "avviso", titolo, numero: nuove.length + morte.length,
      dettaglio: `Sulle linee dell'UDP ${nuove.length} corse da aggiungere e ${morte.length} da togliere: il lancio le riallinea da sé.`,
      campioni: conteggi([...nuove, ...morte].map(id => nome(d.lineaDi.get(id)))).slice(0, CAMPIONI),
      rimedio: null,
    };
  }
  return ok("udp_allineata", titolo, `${d.salvate.length} corse, le stesse che circolano nei giorni dell'UDP.`);
}

/* ──────────────────────────── i mezzi ──────────────────────────── */

export function controlloTipiMezzo(linee: { routeId: string; etichetta: string; tipo: string | null }[]): Controllo {
  const titolo = "Ogni linea ha il tipo di mezzo";
  const senza = linee.filter(l => !l.tipo);
  if (!senza.length) return ok("tipi_mezzo", titolo, `${linee.length} linee, tutte col tipo di mezzo dichiarato.`);
  return {
    chiave: "tipi_mezzo", livello: "errore", titolo, numero: senza.length,
    dettaglio: `${senza.length} linee senza tipo di mezzo dichiarato: il giro le rifiuta, o le mette su un tipo di comodo che non è il loro.`,
    campioni: senza.map(l => l.etichetta).sort((a, b) => a.localeCompare(b, "it", { numeric: true })).slice(0, CAMPIONI),
    rimedio: "Dichiara il tipo di mezzo della linea (Ispettore → linea → Tipologia di vettura).",
  };
}

/* ─────────────────────────── i depositi ─────────────────────────── */

export function controlloDepositi(scelti: string[] | null, delProgetto: { id: string; nome: string }[]): Controllo {
  const titolo = "I depositi del giro";
  if (!delProgetto.length) {
    return {
      chiave: "depositi", livello: "errore", titolo, numero: 1,
      dettaglio: "Nessun deposito con coordinate per questo progetto: il giro non sa da dove escono i mezzi.",
      campioni: [], rimedio: "Aggiungi il deposito (Planning Studio → Depositi).",
    };
  }
  if (!scelti || !scelti.length) {
    return {
      chiave: "depositi", livello: "avviso", titolo, numero: delProgetto.length,
      dettaglio: `Nessun deposito indicato: il giro userà tutti i ${delProgetto.length} depositi del progetto.`,
      campioni: delProgetto.map(d => d.nome).slice(0, CAMPIONI),
      rimedio: "Indica i depositi del giro.",
    };
  }
  const ids = new Set(delProgetto.map(d => d.id));
  const ignoti = scelti.filter(id => !ids.has(id));
  if (ignoti.length) {
    return {
      chiave: "depositi", livello: "errore", titolo, numero: ignoti.length,
      dettaglio: `${ignoti.length} depositi indicati non sono di questo progetto (o non hanno coordinate).`,
      campioni: ignoti.slice(0, CAMPIONI), rimedio: "Scegli i depositi fra quelli del progetto.",
    };
  }
  const nomi = delProgetto.filter(d => scelti.includes(d.id)).map(d => d.nome);
  return ok("depositi", titolo, `${nomi.join(", ")}.`);
}

export interface Capolinea { stopId: string; nome: string; clusterId: string | null; lat: number | null; lon: number | null }
export interface Deposito { id: string; nome: string; lat: number; lon: number }
export interface Arco {
  fromKey: string; fromType: string; fromLat: number; fromLon: number;
  toKey: string; toType: string; toLat: number; toLon: number;
}

/** La chiave di coordinate dell'archivio fuorilinea (5 decimali, come deadhead-matrix). */
export const chiaveCoord = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/**
 * I capolinea senza un arco fuorilinea verso o da almeno uno dei depositi.
 * Un capo d'arco è il capolinea se è la sua fermata (stop:<id>), il suo nodo
 * (cluster:<id>) o, per un capolinea, le stesse coordinate; è il deposito se
 * è depot:<id> o, per un deposito, le stesse coordinate. Come nel giro.
 */
export function capolineaSenzaArco(capolinea: Capolinea[], depositi: Deposito[], archi: Arco[]): Capolinea[] {
  const depIds = new Set(depositi.map(d => d.id));
  const depCoord = new Set(depositi.map(d => chiaveCoord(d.lat, d.lon)));
  const eDeposito = (key: string, type: string, lat: number, lon: number) =>
    key.startsWith("depot:") ? depIds.has(key.slice(6)) : type === "depot" && depCoord.has(chiaveCoord(lat, lon));
  const eCapolinea = (c: Capolinea, key: string, type: string, lat: number, lon: number) =>
    key === `stop:${c.stopId}` || (c.clusterId != null && key === `cluster:${c.clusterId}`)
    || (type !== "depot" && !key.startsWith("depot:") && c.lat != null && c.lon != null
        && chiaveCoord(lat, lon) === chiaveCoord(c.lat, c.lon));
  return capolinea.filter(c => !archi.some(a =>
    (eDeposito(a.fromKey, a.fromType, a.fromLat, a.fromLon) && eCapolinea(c, a.toKey, a.toType, a.toLat, a.toLon))
    || (eDeposito(a.toKey, a.toType, a.toLat, a.toLon) && eCapolinea(c, a.fromKey, a.fromType, a.fromLat, a.fromLon))));
}

export function controlloArchi(capolinea: Capolinea[], depositi: Deposito[], archi: Arco[]): Controllo {
  const titolo = "Ogni capolinea ha il suo fuorilinea";
  if (!depositi.length) {
    return { chiave: "archi_fuorilinea", livello: "errore", titolo, numero: capolinea.length,
      dettaglio: "Senza depositi non si controllano i fuorilinea.", campioni: [], rimedio: "Indica i depositi del giro." };
  }
  const senza = capolineaSenzaArco(capolinea, depositi, archi);
  if (!senza.length) return ok("archi_fuorilinea", titolo, `${capolinea.length} capolinea, tutti collegati a ${depositi.map(d => d.nome).join(", ")}.`);
  return {
    chiave: "archi_fuorilinea", livello: "errore", titolo, numero: senza.length,
    dettaglio: `${senza.length} capolinea su ${capolinea.length} senza arco fuorilinea con ${depositi.map(d => d.nome).join(", ")}: `
      + "il giro stimerebbe uscite e rientri a distanza, senza i minuti veri.",
    campioni: senza.map(c => c.nome).sort((a, b) => a.localeCompare(b, "it")).slice(0, CAMPIONI),
    rimedio: "Aggiungi gli archi deposito ↔ capolinea (Planning Studio → Depositi → Trasferimenti).",
  };
}

/* ─────────────────────────── i capolinea ─────────────────────────── */

export interface Anomalia {
  tipo: "missingReturn" | "tooTight" | "lateReturn" | "orphanReturn" | "noVariantCode";
  linea: string;
  capolinea: string;
  arrivo: string;
  ritorno: string | null;
  /** la sosta minima dichiarata a quel capolinea (null = nessun dato) */
  sostaMinima?: number | null;
}

/** Margine fra arrivo e ripartenza, in minuti (null se manca un orario). */
export function margineMin(a: Pick<Anomalia, "arrivo" | "ritorno">): number | null {
  const x = minuti(a.arrivo), y = minuti(a.ritorno);
  return x != null && y != null ? y - x : null;
}

/** Il margine minimo «scarso» quando il capolinea non ha una sosta dichiarata. */
export const MARGINE_SCARSO_MIN = 2;

/**
 * Un margine da segnalare: sotto i 2′, o sotto la sosta minima dichiarata a
 * quel capolinea (il giro non darà le due corse allo stesso bus).
 */
export function margineDaSegnalare(a: Pick<Anomalia, "arrivo" | "ritorno" | "sostaMinima">): boolean {
  const m = margineMin(a);
  if (m == null) return true;
  return m < MARGINE_SCARSO_MIN || (a.sostaMinima != null && m < a.sostaMinima);
}

const minuti = (hhmm: string | null) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function controlloMargini(anomalie: Anomalia[]): Controllo {
  const titolo = "Andata e ritorno ai capolinea";
  // il ritorno che riparte nello stesso minuto in cui l'andata arriva: sosta zero
  const impossibili = anomalie.filter(a => {
    if (a.tipo !== "tooTight") return false;
    const x = minuti(a.arrivo), y = minuti(a.ritorno);
    return x != null && y != null && y <= x;
  });
  const descr = (a: Anomalia) => `${a.linea} a ${a.capolinea}: arriva ${a.arrivo}${a.ritorno ? `, riparte ${a.ritorno}` : ""}`;
  if (impossibili.length) {
    return {
      chiave: "margini_capolinea", livello: "errore", titolo, numero: impossibili.length,
      dettaglio: `${impossibili.length} ritorni ripartono nello stesso minuto in cui arriva l'andata: senza sosta lo stesso bus non può farli, e ogni ritardo passa al giro dopo.`
        + (anomalie.length > impossibili.length ? ` E altre ${anomalie.length - impossibili.length} anomalie minori.` : ""),
      campioni: impossibili.map(descr).slice(0, CAMPIONI),
      rimedio: "Sposta il ritorno dopo l'arrivo dell'andata con la sua sosta, o rifai i tempi della corsa sul reale.",
    };
  }
  const contano = anomalie.filter(a => a.tipo !== "noVariantCode" && a.tipo !== "lateReturn");
  const sottoSosta = anomalie.filter(a => {
    const m = margineMin(a);
    return a.tipo === "tooTight" && a.sostaMinima != null && m != null && m > 0 && m < a.sostaMinima;
  }).length;
  if (contano.length) {
    return {
      chiave: "margini_capolinea", livello: "avviso", titolo, numero: contano.length,
      dettaglio: `${contano.length} corse con margine scarso o senza la corsa di ritorno/andata al capolinea: ogni caso è un fuorilinea in più o un ritardo che passa al giro dopo.`
        + (sottoSosta ? ` ${sottoSosta} ritorni sono sotto la sosta minima del capolinea: il giro non li darà allo stesso bus.` : ""),
      campioni: contano.map(descr).slice(0, CAMPIONI),
      rimedio: null,
    };
  }
  return ok("margini_capolinea", titolo, "Nessun ritorno impossibile né margine scarso ai capolinea.");
}

export interface CorsaReale { linea: string; partenza: string | null; capolinea: string; coperturaPct: number; giudizio: string }

export function controlloMarginiReali(corse: CorsaReale[]): Controllo {
  const titolo = "I margini reggono i ritardi veri";
  const scarse = corse.filter(c => c.giudizio === "insufficiente");
  if (!corse.some(c => c.coperturaPct > 0)) {
    return { chiave: "margini_reali", livello: "avviso", titolo, numero: 0,
      dettaglio: "Nessun dato SIRI per le corse dell'UDP: i margini non si possono misurare.", campioni: [], rimedio: null };
  }
  if (!scarse.length) return ok("margini_reali", titolo, "Ai capolinea il delta finale assorbe il ritardo all'85° percentile.");
  return {
    chiave: "margini_reali", livello: "avviso", titolo, numero: scarse.length,
    dettaglio: `${scarse.length} corse con un delta finale che non assorbe il ritardo all'85° percentile (SIRI): il ritardo passa alla corsa dopo.`,
    campioni: conteggi(scarse.map(c => c.linea)).slice(0, CAMPIONI),
    rimedio: "Rifai i tempi sul reale (Planning Studio → Percorrenze → Tempi reali) o allarga la sosta.",
  };
}

export function controlloDatiReali(linee: { etichetta: string; coperturaPct: number }[]): Controllo {
  const titolo = "Le linee hanno tempi reali";
  const poche = linee.filter(l => l.coperturaPct < COPERTURA_MINIMA_PCT);
  if (!poche.length) return ok("dati_reali", titolo, `${linee.length} linee con tratti osservati per almeno metà del tempo.`);
  return {
    chiave: "dati_reali", livello: "avviso", titolo, numero: poche.length,
    dettaglio: `${poche.length} linee con meno del ${COPERTURA_MINIMA_PCT}% del tempo coperto da tratti SIRI: i loro tempi restano quelli programmati.`,
    campioni: poche.sort((a, b) => a.coperturaPct - b.coperturaPct).map(l => `${l.etichetta} (${l.coperturaPct}%)`).slice(0, CAMPIONI),
    rimedio: null,
  };
}

/* ───────────────────────────── l'esito ───────────────────────────── */

export function esito(controlli: Controllo[]): Esito {
  const errori = controlli.filter(c => c.livello === "errore").length;
  const avvisi = controlli.filter(c => c.livello === "avviso").length;
  return { pronto: errori === 0, errori, avvisi, controlli };
}

/** Il messaggio del rifiuto del giro: gli errori in una riga ciascuno. */
export function messaggioRifiuto(e: Esito): string {
  return "Il giro non parte: " + e.controlli.filter(c => c.livello === "errore")
    .map(c => `${c.titolo.toLowerCase()} — ${c.dettaglio}${c.campioni.length ? ` (${c.campioni.slice(0, 6).join(", ")})` : ""}`)
    .join(" · ");
}
