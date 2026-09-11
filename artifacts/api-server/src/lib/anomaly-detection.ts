/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGISTRO ANOMALIE — che cosa è andato storto, non quanto
 * ───────────────────────────────────────────────────────────────────────────
 * Il software sa dire di quanto una corsa si scosta dall'orario. Non sa dire
 * CHE COSA è successo — e sono due informazioni diverse, che richiedono due
 * azioni diverse.
 *
 * Otto minuti di ritardo su una linea congestionata sono un orario da
 * ritarare, e si risolve in ufficio. Un mezzo che esce dal percorso, o che
 * parte tre minuti prima dell'orario, sono fatti di esercizio: si risolvono
 * parlando con chi guida, e finché restano nascosti dentro una media di
 * puntualità nessuno se ne accorge.
 *
 * Le anomalie non sono tutte uguali nemmeno fra loro. L'ANTICIPO è il difetto
 * più grave del trasporto pubblico, e quasi sempre il meno segnalato: un
 * ritardo si aspetta alla fermata, un anticipo fa perdere la corsa a chi era
 * arrivato in orario. Per questo pesa più di un ritardo di pari entità.
 *
 * ── Regola che attraversa tutto il file ──
 *
 * Ogni rilevazione dice anche quanto è SICURA, e il testo non promette più di
 * quanto il dato sostenga. "Fermate probabilmente saltate" e "fermate non
 * rilevate" si somigliano nei numeri e sono cose opposte nella realtà: la
 * prima è un fatto di esercizio, la seconda un limite della nostra misura.
 * Chiamare la seconda con il nome della prima manderebbe qualcuno a
 * contestare un conducente che non ha fatto niente di male — un danno che
 * nessun grafico ripaga.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { distanceMeters } from "./siri-vm";

export type TipoAnomalia =
  /** partito dal capolinea prima dell'orario */
  | "anticipo_partenza"
  /** arrivato molto prima del previsto lungo il percorso */
  | "anticipo_percorso"
  /** ritardo che cresce senza mai rientrare */
  | "ritardo_accumulato"
  /** il mezzo si è allontanato dal percorso della sua corsa */
  | "fuori_percorso"
  /** tratto percorso in un tempo incompatibile con le soste previste */
  | "fermate_saltate"
  /** corsa programmata di cui non risulta alcun passaggio */
  | "corsa_non_effettuata";

/**
 * Quanto è solida la rilevazione: il testo non deve promettere di più.
 *
 *   certa      — il dato lo dice, non c'è interpretazione (un anticipo si
 *                misura sull'orologio).
 *   probabile  — la misura è buona, la causa no: "fuori percorso" è un fatto,
 *                ma può essere un cantiere quanto un errore.
 *   possibile  — anche la MISURA è approssimata, perché manca il riferimento
 *                giusto. Non è un grado di sfumatura in più: è il caso in cui
 *                bisogna guardare prima di parlarne con qualcuno.
 */
export type Confidenza = "certa" | "probabile" | "possibile";

export interface Anomalia {
  tipo: TipoAnomalia;
  /** 0-100: ordina il lavoro, non è una percentuale di niente */
  gravita: number;
  confidenza: Confidenza;
  tripId: string;
  vehicleId: string | null;
  routeShortName: string | null;
  day: string;
  /** quando è successo, dove si può dire */
  quando: string | null;
  dove: string | null;
  /** il fatto, in una riga */
  titolo: string;
  /** perché lo diciamo, con i numeri che lo sostengono */
  dettaglio: string;
  /** i valori grezzi, per l'export e per chi vuole verificare */
  misure: Record<string, number | string | null>;
}

/* ── Soglie ───────────────────────────────────────────────────────────────
 * Scelte sul mestiere, non sull'estetica dei numeri. Lo standard TPL colloca
 * la puntualità fra 1 minuto di anticipo e 5 di ritardo: sotto e sopra si
 * esce dal servizio accettabile. L'anticipo alla PARTENZA ha però soglia più
 * severa, perché è l'unico caso in cui il passeggero non ha rimedio. */
const ANTICIPO_PARTENZA_SEC = 60;
const ANTICIPO_PERCORSO_SEC = 180;
const RITARDO_GRAVE_SEC = 300;
/** Oltre questa distanza da ogni tratta della corsa il mezzo non è sul suo
 *  percorso. Larga apposta: le vie parallele di un centro storico stanno
 *  dentro i 150 m, e segnalarle sarebbe rumore. */
const FUORI_PERCORSO_M = 300;
/** Quante letture consecutive fuori prima di dirlo: una sola può essere un
 *  salto del GPS, e su un dato che mette in discussione un conducente non si
 *  parte da una lettura sola. */
const FUORI_PERCORSO_LETTURE = 3;
/**
 * Quando il percorso vero non c'è e si misura dalla spezzata fra le fermate,
 * la soglia cresce con la distanza fra una fermata e l'altra.
 *
 * La spezzata TAGLIA LE CURVE: fra due fermate lontane, la corda che le unisce
 * può passare a centinaia di metri dalla strada che il mezzo percorre
 * davvero. In città, con fermate ogni trecento metri, lo scarto è trascurabile
 * e la soglia resta quella; su un'extraurbana con fermate a tre chilometri una
 * curva ampia sposta la strada di quattrocento metri dalla corda, e un mezzo
 * perfettamente in linea risulterebbe "fuori percorso" per tutta la curva.
 *
 * Per un arco di cerchio la freccia vale circa c²/8R: con corda e raggio dello
 * stesso ordine si sta attorno a un ottavo della corda. Un quarto tiene anche
 * i tornanti, e resta ben sotto la scala di una deviazione vera — che non è
 * una curva più larga, è un'altra strada.
 */
const FUORI_PERCORSO_QUOTA_TRATTA = 0.25;

/** Distanza tipica fra due fermate consecutive con coordinate, in metri. */
function passoFermate(fermate: Array<{ lat: number | null; lon: number | null }>): number | null {
  const p = fermate.filter(f => f.lat != null && f.lon != null);
  if (p.length < 2) return null;
  const d: number[] = [];
  for (let i = 1; i < p.length; i++) {
    d.push(distanceMeters(p[i - 1].lat!, p[i - 1].lon!, p[i].lat!, p[i].lon!));
  }
  /* La MEDIANA, non la media: un capolinea staccato dal resto della linea
   * sposterebbe la media e allargherebbe la soglia su tutto il percorso. */
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] ?? null;
}

/**
 * La distanza oltre la quale dire che il mezzo non è sul suo percorso, e il
 * riferimento su cui la si misura. Con il tracciato del feed è la soglia
 * nominale; senza, si allarga in proporzione al passo fra le fermate.
 */
export function sogliaFuoriPercorso(corsa: {
  fermate: Array<{ lat: number | null; lon: number | null }>;
  tracciato?: Array<{ lat: number; lon: number }>;
}): {
  sogliaM: number;
  riferimento: "tracciato" | "fermate";
  /** la soglia è stata allargata: resta un margine di approssimazione */
  allargata: boolean;
  punti: Array<{ lat: number | null; lon: number | null }>;
} {
  if (corsa.tracciato && corsa.tracciato.length >= 2) {
    return {
      sogliaM: FUORI_PERCORSO_M, riferimento: "tracciato",
      allargata: false, punti: corsa.tracciato,
    };
  }
  const passo = passoFermate(corsa.fermate);
  const sogliaM = Math.max(
    FUORI_PERCORSO_M, Math.round((passo ?? 0) * FUORI_PERCORSO_QUOTA_TRATTA));
  return {
    sogliaM, riferimento: "fermate",
    /* Con fermate vicine la spezzata segue la strada da vicino e la soglia
     * nominale basta: lì la misura è buona quanto con il tracciato, e
     * declassarla sarebbe cautela finta. Il dubbio nasce solo dove la soglia
     * ha dovuto allargarsi — cioè dove le fermate sono lontane e un quarto
     * della corda è una stima, non una garanzia. */
    allargata: sogliaM > FUORI_PERCORSO_M,
    punti: corsa.fermate,
  };
}

export interface FermataCorsa {
  seq: number;
  stopId: string;
  stopName: string | null;
  lat: number | null;
  lon: number | null;
  /** orario previsto in secondi dalla mezzanotte */
  scheduledSec: number | null;
  /** transito rilevato */
  actualTs: string | null;
  /** true se il passaggio è stato osservato, false se ricostruito */
  osservato: boolean;
}

export interface PosizioneMezzo {
  ts: string;
  lat: number;
  lon: number;
}

export interface CorsaDaEsaminare {
  tripId: string;
  vehicleId: string | null;
  routeShortName: string | null;
  day: string;
  fermate: FermataCorsa[];
  /** traccia GPS della giornata, se disponibile */
  posizioni?: PosizioneMezzo[];
  /* Il percorso REALE della corsa (gtfs_shapes), quando il feed ce l'ha.
   * Senza, il confronto si fa sulla spezzata fra le fermate, che taglia le
   * curve: vedi `sogliaFuoriPercorso`. */
  tracciato?: Array<{ lat: number; lon: number }>;
}

/* ── Geometria ────────────────────────────────────────────────────────────── */

/**
 * Distanza di un punto dal segmento fra due fermate.
 *
 * Alle scale urbane la curvatura terrestre è trascurabile: si proietta su un
 * piano locale, si trova il punto più vicino sul segmento e si misura. Usare
 * la distanza dalle sole FERMATE invece che dai segmenti darebbe falsi
 * allarmi ovunque: a metà di una tratta lunga un chilometro il mezzo è
 * legittimamente lontano da entrambe.
 */
export function distanzaDaSegmento(
  plat: number, plon: number,
  alat: number, alon: number,
  blat: number, blon: number,
): number {
  /* Metri per grado alla latitudine data: la longitudine si accorcia col
   * coseno, e ignorarlo sbaglia del 25% alle nostre latitudini. */
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((plat * Math.PI) / 180);

  const ax = alon * mLon, ay = alat * mLat;
  const bx = blon * mLon, by = blat * mLat;
  const px = plon * mLon, py = plat * mLat;

  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distanceMeters(plat, plon, alat, alon);

  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Distanza dal percorso: il minimo fra tutte le tratte della corsa.
 *  Chiede solo le coordinate perché serve anche a chi ha in mano le fermate
 *  del feed (`TripStop`) e non una corsa già ricostruita. */
export function distanzaDalPercorso(
  lat: number, lon: number, fermate: Array<{ lat: number | null; lon: number | null }>,
): number | null {
  const punti = fermate.filter(f => f.lat != null && f.lon != null);
  if (punti.length < 2) return null;
  let min = Infinity;
  for (let i = 1; i < punti.length; i++) {
    const d = distanzaDaSegmento(
      lat, lon,
      punti[i - 1].lat!, punti[i - 1].lon!,
      punti[i].lat!, punti[i].lon!,
    );
    if (d < min) min = d;
  }
  return min === Infinity ? null : min;
}

/* ── Rilevazione ──────────────────────────────────────────────────────────── */

/**
 * Secondi dalla mezzanotte NELL'ORA DELL'AZIENDA.
 *
 * Il confronto con l'orario programmato va fatto nel fuso in cui quell'orario
 * è scritto. Ricavare i secondi da `new Date(giorno + "T00:00:00")` usa il
 * fuso del SERVER: in produzione è UTC, gli orari GTFS sono ora italiana, e
 * ogni corsa risulterebbe partita con due ore di anticipo — un elenco di
 * anomalie interamente falso, e per giunta credibile.
 */
function secLocali(ts: string, timeZone: string): number {
  const p = new Intl.DateTimeFormat("it-IT", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(p.find(x => x.type === t)?.value ?? "0");
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

/**
 * Scarto fra transito e orario previsto, in secondi. Positivo = ritardo.
 * Normalizzato a ±12 h: una corsa notturna con orario "25:10" confrontata con
 * un transito dopo la mezzanotte darebbe altrimenti 24 ore di scarto.
 */
function scartoDaProgrammato(ts: string, scheduledSec: number, timeZone: string): number {
  const DAY = 86_400;
  const grezzo = secLocali(ts, timeZone) - (scheduledSec % DAY);
  return (((grezzo + DAY / 2) % DAY) + DAY) % DAY - DAY / 2;
}

export function rilevaAnomalie(
  corsa: CorsaDaEsaminare, timeZone = "Europe/Rome",
): Anomalia[] {
  const out: Anomalia[] = [];
  const base = {
    tripId: corsa.tripId,
    vehicleId: corsa.vehicleId,
    routeShortName: corsa.routeShortName,
    day: corsa.day,
  };

  const conOrario = corsa.fermate.filter(f => f.scheduledSec != null);
  const osservate = corsa.fermate.filter(f => f.actualTs && f.osservato);

  /* 1. CORSA NON EFFETTUATA. Nessun passaggio su una corsa che l'orario
   *    prevede: o non è partita, o l'AVM non l'ha seguita. Non possiamo
   *    distinguere, e il testo lo dice. */
  if (conOrario.length > 0 && osservate.length === 0) {
    out.push({
      ...base,
      tipo: "corsa_non_effettuata",
      gravita: 70,
      confidenza: "probabile",
      quando: null,
      dove: null,
      titolo: "Nessun passaggio rilevato",
      dettaglio: `La corsa prevede ${conOrario.length} fermate ma non risulta `
        + "alcun transito. Può non essere stata effettuata, oppure il mezzo non "
        + "era seguito dall'AVM: dal solo dato non si distingue.",
      misure: { fermateProgrammate: conOrario.length, fermateOsservate: 0 },
    });
    return out;   // senza osservazioni non c'è altro da dire
  }

  /* 2. ANTICIPO ALLA PARTENZA — il difetto peggiore, e il meno segnalato.
   *    Un ritardo si aspetta alla fermata; un anticipo fa perdere la corsa a
   *    chi era arrivato in orario, e non ha rimedio. */
  const partenza = corsa.fermate.find(f => f.actualTs && f.osservato && f.scheduledSec != null);
  if (partenza && partenza.seq === corsa.fermate[0]?.seq) {
    const scarto = scartoDaProgrammato(partenza.actualTs!, partenza.scheduledSec!, timeZone);
    if (scarto < -ANTICIPO_PARTENZA_SEC) {
      const anticipo = Math.abs(scarto);
      out.push({
        ...base,
        tipo: "anticipo_partenza",
        gravita: Math.min(100, 60 + Math.round(anticipo / 30)),
        confidenza: "certa",
        quando: partenza.actualTs,
        dove: partenza.stopName ?? partenza.stopId,
        titolo: `Partita ${fmtMin(anticipo)} in anticipo`,
        dettaglio: "Chi arriva alla fermata all'orario indicato trova la corsa "
          + "già passata, e non ha modo di accorgersene prima. È il caso in cui "
          + "il passeggero non ha rimedio, per questo pesa più di un ritardo "
          + "della stessa entità.",
        misure: {
          anticipoSec: anticipo,
          previsto: fmtOra(partenza.scheduledSec!),
          reale: partenza.actualTs!,
        },
      });
    }
  }

  /* 3. ANTICIPO LUNGO IL PERCORSO. Meno grave della partenza — chi è già a
   *    bordo non perde niente — ma resta un servizio che non rispetta
   *    l'orario pubblicato alle fermate intermedie. */
  const anticipiForti = osservate.filter(f => {
    if (f.scheduledSec == null) return false;
    return scartoDaProgrammato(f.actualTs!, f.scheduledSec, timeZone) < -ANTICIPO_PERCORSO_SEC;
  });
  if (anticipiForti.length > 0 && !out.some(a => a.tipo === "anticipo_partenza")) {
    const peggiore = anticipiForti.reduce((a, b) => {
      const sa = scartoDaProgrammato(a.actualTs!, a.scheduledSec!, timeZone);
      const sb = scartoDaProgrammato(b.actualTs!, b.scheduledSec!, timeZone);
      return sb < sa ? b : a;
    });
    const anticipo = Math.abs(scartoDaProgrammato(peggiore.actualTs!, peggiore.scheduledSec!, timeZone));
    out.push({
      ...base,
      tipo: "anticipo_percorso",
      gravita: Math.min(90, 40 + Math.round(anticipo / 60) * 5),
      confidenza: "certa",
      quando: peggiore.actualTs,
      dove: peggiore.stopName ?? peggiore.stopId,
      titolo: `Fino a ${fmtMin(anticipo)} in anticipo lungo il percorso`,
      dettaglio: `${anticipiForti.length} fermate servite con più di `
        + `${Math.round(ANTICIPO_PERCORSO_SEC / 60)} minuti di anticipo. Chi aspetta `
        + "a quelle fermate seguendo l'orario pubblicato rischia di non trovare "
        + "la corsa.",
      misure: { fermateInAnticipo: anticipiForti.length, anticipoMassimoSec: anticipo },
    });
  }

  /* 4. RITARDO CHE NON RIENTRA. Un ritardo che cresce e resta è diverso da un
   *    picco isolato: il primo è un orario da rivedere, il secondo un evento. */
  if (osservate.length >= 3) {
    const scarti = osservate
      .filter(f => f.scheduledSec != null)
      .map(f => scartoDaProgrammato(f.actualTs!, f.scheduledSec!, timeZone));
    if (scarti.length >= 3) {
      const finale = scarti[scarti.length - 1];
      const crescente = scarti[scarti.length - 1] > scarti[0];
      if (finale > RITARDO_GRAVE_SEC && crescente) {
        out.push({
          ...base,
          tipo: "ritardo_accumulato",
          gravita: Math.min(85, 35 + Math.round(finale / 60) * 3),
          confidenza: "certa",
          quando: osservate[osservate.length - 1].actualTs,
          dove: osservate[osservate.length - 1].stopName ?? null,
          titolo: `Ritardo salito a ${fmtMin(finale)} senza rientrare`,
          dettaglio: `Il ritardo passa da ${fmtMin(scarti[0])} alla prima fermata `
            + `osservata a ${fmtMin(finale)} all'ultima, crescendo lungo il percorso. `
            + "Un ritardo che si accumula e non rientra è un tempo di percorrenza "
            + "insufficiente, non un evento isolato: si corregge sull'orario.",
          misure: {
            ritardoInizialeSec: scarti[0],
            ritardoFinaleSec: finale,
            fermateConsiderate: scarti.length,
          },
        });
      }
    }
  }

  /* 5. FUORI PERCORSO. Il mezzo si è allontanato dal tracciato della propria
   *    corsa. Servono più letture consecutive: su un dato che mette in
   *    discussione un conducente non si parte da un solo punto GPS. */
  if (corsa.posizioni && corsa.posizioni.length > 0) {
    let consecutive = 0;
    let inizio: PosizioneMezzo | null = null;
    let distMax = 0;
    let peggiore: PosizioneMezzo | null = null;
    /* Il riferimento decide quanto ci si può fidare: il tracciato del feed è
     * la strada vera, la spezzata fra le fermate ne è solo un'ombra. */
    const rif = sogliaFuoriPercorso(corsa);

    for (const p of corsa.posizioni) {
      const d = distanzaDalPercorso(p.lat, p.lon, rif.punti);
      if (d != null && d > rif.sogliaM) {
        if (consecutive === 0) inizio = p;
        consecutive++;
        if (d > distMax) { distMax = d; peggiore = p; }
      } else {
        consecutive = 0;
      }
      if (consecutive >= FUORI_PERCORSO_LETTURE && !out.some(a => a.tipo === "fuori_percorso")) {
        out.push({
          ...base,
          tipo: "fuori_percorso",
          gravita: Math.min(95, 55 + Math.round(distMax / 200)),
          /* Col tracciato del feed la misura è sulla strada vera; senza, è su
           * una spezzata che taglia le curve, e va detto. */
          confidenza: rif.allargata ? "possibile" : "probabile",
          quando: inizio?.ts ?? p.ts,
          dove: null,
          titolo: `Fuori percorso, fino a ${Math.round(distMax)} m dal tracciato`,
          dettaglio: "Il mezzo si è allontanato dal percorso della sua corsa per "
            + `almeno ${FUORI_PERCORSO_LETTURE} rilevazioni consecutive. Può essere `
            + "una deviazione per cantiere o un percorso diverso da quello previsto; "
            + "il dato dice che è successo, non perché."
            + (rif.allargata
              ? " Attenzione: il feed non ha il percorso di questa corsa, quindi la "
                + "distanza è misurata dalla spezzata fra le fermate, che taglia le "
                + `curve. Qui le fermate sono lontane, e la soglia è stata portata a `
                + `${rif.sogliaM} m invece di ${FUORI_PERCORSO_M}: resta comunque una `
                + "stima. Guarda la mappa prima di parlarne con qualcuno."
              : ""),
          misure: {
            distanzaMassimaM: Math.round(distMax),
            sogliaM: rif.sogliaM,
            riferimento: rif.riferimento,
            lat: peggiore?.lat ?? null,
            lon: peggiore?.lon ?? null,
          },
        });
      }
    }
  }

  /* 6. FERMATE PROBABILMENTE SALTATE. Un tratto percorso in molto meno del
   *    tempo previsto, che quel tempo lo include per le soste. È una
   *    rilevazione PROBABILE e resta tale: "non rilevata" e "non servita" si
   *    somigliano nei numeri e sono opposte nella realtà, e scambiarle
   *    manderebbe a contestare un conducente che non ha fatto niente. */
  const salti = rilevaSalti(corsa, timeZone);
  if (salti) out.push({ ...base, ...salti });

  return out.sort((a, b) => b.gravita - a.gravita);
}

/** Il tratto fra due passaggi osservati, percorso troppo in fretta. */
function rilevaSalti(corsa: CorsaDaEsaminare, _timeZone: string): Omit<Anomalia,
  "tripId" | "vehicleId" | "routeShortName" | "day"> | null {
  const oss = corsa.fermate
    .filter(f => f.actualTs && f.osservato && f.scheduledSec != null)
    .sort((a, b) => a.seq - b.seq);
  if (oss.length < 2) return null;

  let peggiore: {
    da: FermataCorsa; a: FermataCorsa; saltate: number;
    reale: number; previsto: number;
  } | null = null;

  for (let i = 1; i < oss.length; i++) {
    const da = oss[i - 1], a = oss[i];
    const saltate = corsa.fermate.filter(f => f.seq > da.seq && f.seq < a.seq).length;
    if (saltate === 0) continue;

    /* Fra due transiti la differenza è assoluta: nessun fuso da applicare. */
    const reale = Math.round(
      (new Date(a.actualTs!).getTime() - new Date(da.actualTs!).getTime()) / 1000);
    const previsto = a.scheduledSec! - da.scheduledSec!;
    if (previsto <= 0 || reale <= 0) continue;

    /* Metà del tempo previsto è la soglia: il programmato include le soste,
     * e chi le fa tutte non può impiegare la metà del tempo. Sotto quel
     * valore o ha saltato, o l'orario di quel tratto è molto sbagliato — e
     * il testo lascia aperte entrambe. */
    if (reale < previsto * 0.5) {
      if (!peggiore || saltate > peggiore.saltate) {
        peggiore = { da, a, saltate, reale, previsto };
      }
    }
  }
  if (!peggiore) return null;

  return {
    tipo: "fermate_saltate",
    gravita: Math.min(80, 40 + peggiore.saltate * 6),
    confidenza: "probabile",
    quando: peggiore.a.actualTs,
    dove: `${peggiore.da.stopName ?? peggiore.da.stopId} → ${peggiore.a.stopName ?? peggiore.a.stopId}`,
    titolo: peggiore.saltate === 1
      ? "Una fermata forse non servita"
      : `${peggiore.saltate} fermate forse non servite`,
    dettaglio: `Il tratto è stato percorso in ${fmtMin(peggiore.reale)} contro i `
      + `${fmtMin(peggiore.previsto)} previsti, che includono le soste. O le fermate `
      + "intermedie non sono state servite, o l'orario di questo tratto è molto "
      + "largo. Il dato non distingue: va guardato prima di trarne conclusioni "
      + "su chi guidava.",
    misure: {
      fermateNelTratto: peggiore.saltate,
      tempoRealeSec: peggiore.reale,
      tempoPrevistoSec: peggiore.previsto,
      quota: Math.round((peggiore.reale / peggiore.previsto) * 100) / 100,
    },
  };
}

function fmtMin(sec: number): string {
  const s = Math.abs(Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}″`;
  return r === 0 ? `${m}′` : `${m}′${String(r).padStart(2, "0")}″`;
}

function fmtOra(sec: number): string {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/* ── Sintesi ──────────────────────────────────────────────────────────────
 * Un elenco di duecento anomalie non è un'informazione, è un altro problema.
 * Quello che serve a chi apre la pagina è sapere in una riga se la giornata
 * ha qualcosa di anomalo e di che natura. */
export interface SintesiAnomalie {
  totale: number;
  perTipo: Array<{ tipo: TipoAnomalia; conteggio: number; etichetta: string }>;
  corseCoinvolte: number;
  gravitaMassima: number;
  nota: string;
}

export const ETICHETTE: Record<TipoAnomalia, string> = {
  anticipo_partenza: "Partenze in anticipo",
  anticipo_percorso: "Anticipi lungo il percorso",
  ritardo_accumulato: "Ritardi che non rientrano",
  fuori_percorso: "Fuori percorso",
  fermate_saltate: "Fermate forse non servite",
  corsa_non_effettuata: "Corse senza passaggi",
};

export function riepiloga(anomalie: Anomalia[]): SintesiAnomalie {
  const perTipo = new Map<TipoAnomalia, number>();
  const corse = new Set<string>();
  let gravitaMax = 0;
  for (const a of anomalie) {
    perTipo.set(a.tipo, (perTipo.get(a.tipo) ?? 0) + 1);
    corse.add(a.tripId);
    if (a.gravita > gravitaMax) gravitaMax = a.gravita;
  }

  const anticipi = (perTipo.get("anticipo_partenza") ?? 0);
  const fuori = (perTipo.get("fuori_percorso") ?? 0);

  return {
    totale: anomalie.length,
    perTipo: [...perTipo.entries()]
      .map(([tipo, conteggio]) => ({ tipo, conteggio, etichetta: ETICHETTE[tipo] }))
      .sort((a, b) => b.conteggio - a.conteggio),
    corseCoinvolte: corse.size,
    gravitaMassima: gravitaMax,
    nota: anomalie.length === 0
      ? "Nessuna anomalia rilevata: le corse osservate rispettano percorso e orario."
      : anticipi > 0
        /* L'anticipo va nominato per primo anche quando non è il più frequente:
         * è l'unico caso in cui il passeggero resta a terra senza rimedio. */
        ? (anticipi === 1
          ? "Una corsa è partita in anticipo — è il caso in cui chi aspetta alla "
            + "fermata perde il servizio senza potersene accorgere."
          : `${anticipi} corse sono partite in anticipo — è il caso in cui chi `
            + "aspetta alla fermata perde il servizio senza potersene accorgere.")
        : fuori > 0
          ? (fuori === 1
            ? "Una corsa ha lasciato il proprio percorso: da guardare prima dei "
              + "ritardi, perché riguarda il servizio erogato e non il suo orario."
            : `${fuori} corse hanno lasciato il proprio percorso: da guardare prima `
              + "dei ritardi, perché riguardano il servizio erogato e non il suo orario.")
          : `${anomalie.length} anomalie su ${corse.size} `
            + `${corse.size === 1 ? "corsa" : "corse"}.`,
  };
}
