/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL PARCO NEL TEMPO — quali vetture abbiamo ripreso, quali abbiamo perso
 * ───────────────────────────────────────────────────────────────────────────
 * L'elenco degli apparati da verificare dice chi è guasto OGGI. È utile e non
 * basta: chi lo porta in officina non ha modo di sapere se l'intervento di
 * settimana scorsa è servito, né si accorge di una vettura che ha smesso di
 * trasmettere ieri — resta in fondo all'elenco, ordinata per tempo di fermo,
 * dietro a quelle mute da mesi.
 *
 * Eppure è la differenza che conta, ed è il primo dei due fattori che
 * decidono quanto vediamo. Sul flusso vero: 9 mezzi in servizio su 368
 * trasmessi, con letture ogni ~40 s che consentono di riconoscere circa il 36%
 * dei passaggi — e ne riconosciamo il 37,5%, cioè esattamente quanto
 * l'intervallo permette.
 *
 * I due fattori si MOLTIPLICANO, non si escludono: sull'intervallo siamo già
 * al limite e serve il fornitore, sui mezzi no e serve l'officina. Chi torna a
 * trasmettere aggiunge corse intere, non frazioni di passaggio.
 *
 * ── Quello che questo modulo NON dice ──
 *
 * "Non la vediamo più" non è "è guasta". Una vettura può sparire perché è a
 * riposo, perché è di scorta, perché è in revisione. Il dato dice che ha
 * smesso di trasmettere, e solo quello: il perché lo sa l'officina, e
 * l'elenco serve a farglielo cercare, non a sostituirsi a lei.
 *
 * E per questo "persa" si misura sul SILENZIO recente, non sull'assenza da
 * metà periodo: un mezzo assente da tre giorni può essere in sosta, uno
 * assente da due settimane no. Guardare le metà lasciava sfuggire proprio il
 * caso più utile — la vettura che ha smesso poco dopo la metà, che è il guasto
 * più fresco e quindi quello su cui conviene intervenire.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Una vettura e le giornate in cui l'abbiamo sentita. */
export interface PresenzaVettura {
  vehicleRef: string;
  /** giornate distinte con almeno una posizione, "YYYY-MM-DD" */
  giorni: string[];
}

export type StatoNelTempo =
  /** trasmetteva e ha smesso: è la novità su cui intervenire */
  | "persa"
  /** non trasmetteva e ha ripreso: un intervento ha funzionato */
  | "ripresa"
  /** presente in modo continuo */
  | "stabile"
  /** presente a sprazzi in tutto il periodo: apparato incerto, non fermo */
  | "saltuaria";

export interface VetturaNelTempo {
  vehicleRef: string;
  stato: StatoNelTempo;
  /** giornate sentite nella prima metà del periodo */
  primaMeta: number;
  /** giornate sentite nella seconda metà */
  secondaMeta: number;
  primoGiorno: string;
  ultimoGiorno: string;
  /** giornate dall'ultima volta che l'abbiamo sentita, rispetto a fine periodo */
  giorniDiSilenzio: number;
}

export interface AndamentoParco {
  /** giornate del periodo esaminato */
  giornate: number;
  vetture: number;
  perse: VetturaNelTempo[];
  riprese: VetturaNelTempo[];
  stabili: number;
  saltuarie: number;
  /** quante vetture in più (o in meno) rispetto alla prima metà */
  variazioneNette: number;
  nota: string;
}

/** Sotto questa quota di giornate la presenza è a sprazzi, non continua. */
const QUOTA_CONTINUA = 0.5;

/**
 * Da quanti giorni di silenzio una vettura si considera persa.
 *
 * NON si guarda "assente in tutta la seconda metà del periodo": una vettura
 * che smette di trasmettere poco DOPO la metà avrebbe una presenza nella
 * seconda metà e sfuggirebbe — ed è il caso più azionabile che esista, perché
 * è il guasto più fresco. Si guarda invece da quanto tempo tace rispetto alla
 * fine del periodo.
 *
 * Il minimo di quattro giorni copre un fine settimana più un giorno di riposo:
 * sotto quella soglia si starebbe mandando l'officina a cercare il guasto di
 * un mezzo in sosta.
 */
export function sogliaSilenzio(giornate: number): number {
  return Math.max(4, Math.floor(giornate / 4));
}

/** Elenco ordinato di giornate "YYYY-MM-DD" fra due estremi inclusi. */
export function giornateDelPeriodo(da: string, a: string): string[] {
  const out: string[] = [];
  const fine = new Date(`${a}T00:00:00Z`).getTime();
  let t = new Date(`${da}T00:00:00Z`).getTime();
  /* Un periodo malformato non deve produrre un ciclo infinito. */
  if (!Number.isFinite(t) || !Number.isFinite(fine) || fine < t) return out;
  while (t <= fine && out.length < 400) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/**
 * Confronta la prima metà del periodo con la seconda.
 *
 * `giornate` è l'elenco completo delle giornate osservabili, non solo quelle
 * in cui qualcuno ha trasmesso: senza, un fine settimana in cui nessuno
 * trasmette accorcerebbe il periodo e sposterebbe la metà.
 */
export function andamentoParco(
  presenze: PresenzaVettura[], giornate: string[],
): AndamentoParco {
  const giorni = [...new Set(giornate)].sort();
  if (giorni.length < 4 || presenze.length === 0) {
    return {
      giornate: giorni.length, vetture: presenze.length,
      perse: [], riprese: [], stabili: 0, saltuarie: 0, variazioneNette: 0,
      nota: giorni.length < 4
        ? "Periodo troppo corto per confrontare: servono almeno quattro giornate."
        : "Nessuna vettura ha trasmesso nel periodo.",
    };
  }

  const meta = Math.floor(giorni.length / 2);
  const prima = new Set(giorni.slice(0, meta));
  const seconda = new Set(giorni.slice(meta));
  const fine = giorni[giorni.length - 1];
  const soglia = sogliaSilenzio(giorni.length);

  const valutate: VetturaNelTempo[] = presenze.map(p => {
    const visti = [...new Set(p.giorni)].sort();
    const a = visti.filter(g => prima.has(g)).length;
    const b = visti.filter(g => seconda.has(g)).length;
    const ultimo = visti[visti.length - 1] ?? giorni[0];

    const silenzio = giorniFra(ultimo, fine);

    /* L'ordine conta: una vettura comparsa una volta sola e poi sparita è
     * persa, non "ripresa". Il silenzio recente batte tutto il resto. */
    let stato: StatoNelTempo;
    if (visti.length > 0 && silenzio >= soglia) stato = "persa";
    else if (a === 0 && b > 0) stato = "ripresa";
    else if (a / prima.size >= QUOTA_CONTINUA && b / seconda.size >= QUOTA_CONTINUA) stato = "stabile";
    else stato = "saltuaria";

    return {
      vehicleRef: p.vehicleRef, stato,
      primaMeta: a, secondaMeta: b,
      primoGiorno: visti[0] ?? giorni[0],
      ultimoGiorno: ultimo,
      giorniDiSilenzio: silenzio,
    };
  });

  /* Le perse prima, e fra quelle la più recente: è la novità su cui
   * intervenire, mentre una muta da mesi è già in elenco da mesi. */
  const perse = valutate.filter(v => v.stato === "persa")
    .sort((a, b) => a.giorniDiSilenzio - b.giorniDiSilenzio);
  /* Le riprese in ordine inverso: l'ultima tornata è la conferma più fresca
   * che un intervento funziona. */
  const riprese = valutate.filter(v => v.stato === "ripresa")
    .sort((a, b) => b.ultimoGiorno.localeCompare(a.ultimoGiorno));

  const attivePrima = valutate.filter(v => v.primaMeta > 0).length;
  const attiveDopo = valutate.filter(v => v.secondaMeta > 0).length;

  return {
    giornate: giorni.length,
    vetture: presenze.length,
    perse, riprese,
    stabili: valutate.filter(v => v.stato === "stabile").length,
    saltuarie: valutate.filter(v => v.stato === "saltuaria").length,
    variazioneNette: attiveDopo - attivePrima,
    nota: riassumi(perse.length, riprese.length, attiveDopo - attivePrima, giorni.length),
  };
}

function giorniFra(da: string, a: string): number {
  const t1 = new Date(`${da}T00:00:00Z`).getTime();
  const t2 = new Date(`${a}T00:00:00Z`).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.max(0, Math.round((t2 - t1) / 86_400_000));
}

function riassumi(perse: number, riprese: number, netto: number, giornate: number): string {
  if (perse === 0 && riprese === 0) {
    return `In ${giornate} giornate nessuna vettura ha smesso di trasmettere e `
      + "nessuna ha ripreso: il parco seguito è lo stesso di prima.";
  }
  const pezzi: string[] = [];
  if (perse > 0) {
    pezzi.push(perse === 1
      ? "1 vettura trasmetteva e ha smesso"
      : `${perse} vetture trasmettevano e hanno smesso`);
  }
  if (riprese > 0) {
    pezzi.push(riprese === 1
      ? "1 ha ripreso a trasmettere"
      : `${riprese} hanno ripreso a trasmettere`);
  }
  let testo = pezzi.join(", ") + ".";

  /* Il saldo è il numero che conta: la copertura migliora solo se le riprese
   * superano le perse, e le due cose si guardano insieme o si finisce a
   * festeggiare sei riparazioni mentre se ne sono rotte otto. */
  if (netto > 0) {
    testo += ` Il parco seguito è cresciuto di ${netto}: ogni mezzo in più `
      + "vale più di qualunque cosa possiamo chiedere al fornitore.";
  } else if (netto < 0) {
    testo += ` Il parco seguito è calato di ${-netto}: si perde terreno più in `
      + "fretta di quanto si ripara.";
  } else if (perse > 0) {
    testo += " Il saldo è in pari: si ripara quanto si perde.";
  }
  return testo;
}
