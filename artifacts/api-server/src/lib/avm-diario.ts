/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL DIARIO DELL'AVM — una settimana di osservazione, vettura per vettura
 * ───────────────────────────────────────────────────────────────────────────
 * Lo stato del parco dice come sta il parco ADESSO, e adesso è un'istantanea:
 * una vettura in officina alle 8:20 sembra muta, una che ha fatto una corsa
 * alle 6 e poi è rientrata sembra ferma. Su un'istantanea non si scrive una
 * segnalazione, perché chi la riceve risponde — giustamente — che quel giorno
 * il mezzo era in rimessa.
 *
 * Questo modulo raccoglie invece la GIORNATA: a ogni giro di lettura aggiorna
 * una riga per (giornata, matricola) con quante volte l'abbiamo vista, quante
 * volte stava parlando col centro, quante volte aveva una posizione, quante
 * volte era su una corsa. Una settimana di righe così risponde alla domanda
 * che serve davvero: questa vettura funziona, oppure no, e di chi è il pezzo
 * che manca.
 *
 * ── Perché conta la DIFFERENZA fra i quattro segnali ──
 *
 * Gli anelli sono in fila, e ognuno ha un padrone diverso:
 *
 *   contatto    l'apparato parla col centro       → SIM, rete, alimentazione
 *   monitorata  il centro la segue                → attivazione al centro (Mizar)
 *   posizione   sa dove si trova                  → antenna GPS, grafo
 *   corsa       sa quale corsa sta facendo        → turno a bordo, qualifica
 *
 * Il primo anello che manca è la segnalazione da fare: incolpare l'antenna di
 * una vettura che il centro non sta nemmeno seguendo manda l'officina a
 * cercare un guasto che non c'è. Per questo la classificazione qui sotto
 * scende gli anelli in ordine e si ferma al primo rotto.
 *
 * ── Quello che il diario NON dice ──
 *
 * "Mai in servizio" non è "guasta": può essere una vettura di scorta, in
 * revisione, o semplicemente non messa in turno. Per questo ogni riga porta
 * con sé quante giornate ha avuto contatto e quante corse ha fatto: sono i
 * numeri che chi legge la segnalazione userà per rispondere, e averli già
 * accanto evita il giro di risposte.
 *
 * Funzioni pure: niente database, niente rete (vedi __tests__/avm-diario.test.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Una giornata di una vettura, come sta scritta nel diario. */
export interface RigaDiario {
  /** "YYYY-MM-DD", giornata di esercizio */
  giorno: string;
  vehicleRef: string;
  /** quante volte l'abbiamo trovata nella risposta dell'AVM */
  letture: number;
  /** letture in cui l'ultimo contatto era recente: l'apparato stava parlando */
  lettureFresche: number;
  /** letture in cui il centro la dichiarava seguita (Monitored) */
  lettureMonitorata: number;
  /** letture con una posizione fresca */
  letturePosizione: number;
  /** letture con una corsa in servizio */
  lettureCorsa: number;
  lettureErroreGps: number;
  lettureErroreGprs: number;
  lettureInRimessa: number;
  /** primo e ultimo contatto dichiarati dall'apparato nella giornata */
  primoContatto: string | null;
  ultimoContatto: string | null;
  /** linee viste nella giornata */
  linee: string[];
  /** codici corsa distinti agganciati nella giornata */
  corse: string[];
}

/**
 * Come si è comportata in UNA giornata. Sono i quattro anelli, dal più
 * completo al più rotto.
 */
export type EsitoGiorno =
  /** ha fatto almeno una corsa */
  | "in_servizio"
  /** si è localizzata ma non ha mai agganciato una corsa */
  | "traccia"
  /** ha parlato col centro ma non si è localizzata */
  | "collegata"
  /** non ha mai parlato col centro in tutta la giornata */
  | "muta";

export function esitoGiorno(r: RigaDiario): EsitoGiorno {
  if (r.lettureCorsa > 0) return "in_servizio";
  if (r.letturePosizione > 0) return "traccia";
  if (r.lettureFresche > 0) return "collegata";
  return "muta";
}

/**
 * Il verdetto della settimana. Si legge come una scala: ogni voce è l'anello
 * più alto che quella vettura ha raggiunto almeno una volta nel periodo.
 */
export type EsitoSettimana =
  /** ha fatto corse: l'intera catena funziona */
  | "funziona"
  /** si localizza ma non aggancia mai una corsa */
  | "senza_corsa"
  /** parla col centro, dichiara errore GPS e non si localizza mai: antenna */
  | "senza_posizione"
  /** parla col centro senza errori a bordo, ma il centro non la localizza mai:
   *  non è attivata (grafo, modo di localizzazione) */
  | "non_attivata"
  /** non ha mai parlato col centro in tutto il periodo */
  | "muta";

export type Destinatario = "Mizar" | "Officina" | "Esercizio" | "Gestore SIM" | "nessuno";

/**
 * L'avviso è diverso dal verdetto. Il verdetto dice che cosa la vettura ha
 * DIMOSTRATO di saper fare nel periodo; l'avviso dice che cosa va guardato
 * ADESSO. Una vettura che ha fatto corse lunedì e tace da giovedì "funziona"
 * come verdetto, ed è la prima da controllare come avviso: è un apparato che
 * si è rotto da poco, e quelli si riparano.
 */
export type Avviso =
  /** funzionava (corse o posizione) e tace da almeno GIORNI_SMESSA giornate */
  | "smessa"
  /** parla, dichiara errore GPS, non si è mai localizzata: antenna */
  | "antenna"
  /** parla senza errori a bordo, mai localizzata dal centro: da attivare */
  | "da_attivare"
  /** parla a sprazzi: rete o alimentazione incerta */
  | "intermittente";

export interface VetturaSettimana {
  vehicleRef: string;
  esito: EsitoSettimana;
  destinatario: Destinatario;
  /** che cosa chiedere, in una riga da incollare nella segnalazione */
  azione: string;
  /** perché è finita in questa voce, coi numeri che la sostengono */
  nota: string;
  /** giornate osservate (quelle in cui il diario ha almeno una lettura) */
  giornate: number;
  giorniConContatto: number;
  giorniMonitorata: number;
  giorniConPosizione: number;
  giorniConCorsa: number;
  giorniErroreGps: number;
  giorniErroreGprs: number;
  /** corse distinte in tutto il periodo */
  corse: number;
  linee: string[];
  primoContatto: string | null;
  ultimoContatto: string | null;
  /** giornate dall'ultimo contatto, contate dalla fine del periodo */
  giorniDiSilenzio: number;
  /** parla a sprazzi: meno di metà delle giornate, ma non è muta */
  intermittente: boolean;
  /** un esito per giornata, in ordine: è la riga di stato da leggere a colpo d'occhio */
  perGiorno: Array<{ giorno: string; esito: EsitoGiorno }>;
  /** ultima giornata in cui si è localizzata o ha fatto corse, se mai */
  ultimoGiornoBuono: string | null;
  /** giornate osservate passate da allora */
  giorniDaBuono: number | null;
  /** che cosa va guardato adesso, se qualcosa */
  avviso: Avviso | null;
}

export interface GiornataDiario {
  giorno: string;
  inServizio: number;
  traccia: number;
  collegata: number;
  muta: number;
  /** quante il centro dichiarava di seguire almeno una volta nella giornata */
  monitorate: number;
  /** vetture con almeno una lettura nella giornata */
  vetture: number;
  /** campioni scritti in quella giornata (il massimo fra le vetture): misura
   *  di quanto il connettore ha girato, non di quanto hanno parlato i mezzi */
  campioni: number;
}

export interface Segnalazione {
  destinatario: Destinatario;
  esito: EsitoSettimana;
  azione: string;
  /** matricole, in ordine di quanto sono vicine a funzionare */
  matricole: string[];
  /** quelle che parlano ancora: sono le più facili da recuperare */
  conContattoRecente: string[];
}

export interface DiarioSettimana {
  giornate: string[];
  /** giornate con almeno una lettura: sotto le tre il verdetto non si dà */
  giornateOsservate: number;
  vetture: VetturaSettimana[];
  perGiorno: GiornataDiario[];
  riepilogo: {
    totale: number;
    funzionanti: number;
    daSegnalare: number;
    perEsito: Array<{ esito: EsitoSettimana; conteggio: number }>;
    perDestinatario: Array<{ destinatario: Destinatario; conteggio: number }>;
  };
  /** che cosa è cambiato fra l'inizio e la fine del periodo */
  cambiamenti: {
    migliorate: Array<{ vehicleRef: string; da: EsitoGiorno; a: EsitoGiorno }>;
    peggiorate: Array<{ vehicleRef: string; da: EsitoGiorno; a: EsitoGiorno }>;
  };
  segnalazioni: Segnalazione[];
  nota: string;
  /** giornate mancanti nel mezzo: il connettore era fermo, non le vetture */
  giornateSenzaDati: string[];
  /** le vetture da guardare adesso, per avviso, dalle più urgenti */
  avvisi: Array<{ avviso: Avviso; matricole: string[]; titolo: string; perche: string }>;
  /** quanto è affidabile la raccolta su cui poggia tutto il resto */
  qualita: {
    /** campioni attesi in una giornata piena con un campione ogni due minuti */
    campioniAttesi: number;
    /** giornate con meno di mezza raccolta, escluse la prima e l'ultima */
    giornateParziali: string[];
    nota: string;
  };
}

/** Ordine degli anelli, dal più completo al più rotto. */
const SCALA: Record<EsitoGiorno, number> = {
  in_servizio: 3, traccia: 2, collegata: 1, muta: 0,
};

const PESO_ESITO: Record<EsitoSettimana, number> = {
  funziona: 0, senza_corsa: 1, senza_posizione: 2, non_attivata: 3, muta: 4,
};

export const ETICHETTE_ESITO: Record<EsitoSettimana, string> = {
  funziona: "Funziona: ha fatto corse",
  senza_corsa: "Si localizza ma non aggancia la corsa",
  senza_posizione: "Parla ma non aggancia il GPS",
  non_attivata: "Parla ma il centro non la localizza",
  muta: "Nessun contatto nel periodo",
};

export const ETICHETTE_GIORNO: Record<EsitoGiorno, string> = {
  in_servizio: "in servizio", traccia: "traccia", collegata: "collegata", muta: "muta",
};

/** Le azioni: una riga per voce, scritta per chi la riceve. */
const AZIONI: Record<EsitoSettimana, { destinatario: Destinatario; azione: string }> = {
  funziona: {
    destinatario: "nessuno",
    azione: "Nessuna segnalazione: la catena è completa.",
  },
  senza_corsa: {
    destinatario: "Esercizio",
    azione: "La vettura si localizza ma non dichiara mai una corsa: verificare che "
      + "l'autista si qualifichi a bordo e che il turno del giorno sia caricato "
      + "sull'apparato. Se la qualifica c'è, è il grafo di linea a non coprire "
      + "quel percorso e la domanda passa a Mizar.",
  },
  senza_posizione: {
    destinatario: "Officina",
    azione: "L'apparato parla col centro e dichiara errore GPS: non arriva mai "
      + "una posizione valida. Controllare antenna, cavo e collocazione "
      + "dell'apparato.",
  },
  non_attivata: {
    destinatario: "Mizar",
    azione: "L'apparato parla col centro senza errori a bordo, ma il centro non "
      + "produce mai una posizione: manca l'attivazione (grafo di linea, modo "
      + "di localizzazione). È l'intervento più rapido, si fa dal centro.",
  },
  muta: {
    destinatario: "Gestore SIM",
    azione: "Nessun contatto in tutto il periodo: chiedere al gestore il traffico "
      + "dati della SIM. Zero byte significa apparato spento o SIM senza piano, "
      + "e allora è una verifica a bordo; traffico presente significa che il "
      + "dato si ferma prima del centro, e allora è di nuovo Mizar.",
  },
};

/** Sotto questa quota di giornate con contatto, l'apparato parla a sprazzi. */
const QUOTA_CONTINUA = 0.5;

/** Sotto questo numero di giornate un verdetto sarebbe un'istantanea travestita. */
export const GIORNATE_MINIME = 3;

/**
 * Da quante giornate osservate senza posizione una vettura che funzionava si
 * considera "smessa". Tre coprono un fine settimana più un giorno di riposo:
 * sotto, si manderebbe l'officina a cercare il guasto di un mezzo in sosta.
 */
export const GIORNI_SMESSA = 3;

/** Un campione ogni due minuti: in una giornata piena sono 720. */
export const CAMPIONI_GIORNATA = 720;

export const ETICHETTE_AVVISO: Record<Avviso, { titolo: string; perche: string }> = {
  smessa: {
    titolo: "Ha smesso di tracciare",
    perche: "Si localizzava o faceva corse, e da almeno tre giornate non dà più "
      + "una posizione. È un apparato che si è rotto da poco: quelli si riparano, "
      + "e prima si guarda meglio è.",
  },
  antenna: {
    titolo: "Errore GPS a bordo",
    perche: "Parla col centro ma dichiara errore GPS e non si è mai localizzata: "
      + "antenna, cavo o collocazione dell'apparato.",
  },
  da_attivare: {
    titolo: "Parla ma non è attivata",
    perche: "Contatto regolare, nessun errore a bordo, nessuna posizione dal "
      + "centro: manca l'attivazione. Un elenco per Mizar, nessuna officina.",
  },
  intermittente: {
    titolo: "Parla a sprazzi",
    perche: "Presente meno di metà delle giornate ma non muta: rete, SIM o "
      + "alimentazione incerta. In officina si chiude sempre con «a me "
      + "funzionava»: serve il diario davanti.",
  },
};

function giornoDi(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

/** Distanza in giornate fra due "YYYY-MM-DD". */
function distanzaGiorni(da: string, a: string): number {
  const x = Date.parse(`${da}T00:00:00Z`);
  const y = Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.max(0, Math.round((y - x) / 86_400_000));
}

/**
 * Il verdetto di una vettura sulle sue giornate.
 *
 * Si scende la scala degli anelli e ci si ferma al primo rotto: è la
 * segnalazione giusta, non la più grave. Una vettura che una volta sola in
 * sette giorni ha fatto una corsa "funziona", e il fatto che sia successo una
 * volta sola sta nei numeri accanto — che è il posto giusto per un dubbio,
 * invece di un verdetto più severo che poi nessuno riesce a difendere.
 */
export function classificaVettura(
  vehicleRef: string, righe: RigaDiario[], giornate: string[],
): VetturaSettimana {
  const ordinate = [...righe].sort((a, b) => a.giorno.localeCompare(b.giorno));
  const conta = (f: (r: RigaDiario) => boolean) => ordinate.filter(f).length;

  const giorniConContatto = conta(r => r.lettureFresche > 0);
  const giorniMonitorata = conta(r => r.lettureMonitorata > 0);
  const giorniConPosizione = conta(r => r.letturePosizione > 0);
  const giorniConCorsa = conta(r => r.lettureCorsa > 0);
  const giorniErroreGps = conta(r => r.lettureErroreGps > 0);
  const giorniErroreGprs = conta(r => r.lettureErroreGprs > 0);

  const corse = new Set<string>();
  const linee = new Set<string>();
  for (const r of ordinate) {
    for (const c of r.corse) corse.add(c);
    for (const l of r.linee) linee.add(l);
  }

  const contatti = ordinate.map(r => r.ultimoContatto).filter((x): x is string => !!x).sort();
  const primi = ordinate.map(r => r.primoContatto).filter((x): x is string => !!x).sort();
  const ultimoContatto = contatti.length ? contatti[contatti.length - 1] : null;
  const primoContatto = primi.length ? primi[0] : null;

  /* La scala. I due anelli di mezzo si distinguono con l'errore che l'apparato
   * dichiara, non col flag Monitored: misurato sul flusso vero del 15
   * settembre, Monitored è la negazione esatta di MonitoringError su 368
   * vetture su 368, quindi non dice se il centro la segue, dice solo se quella
   * lettura è pulita. Un errore GPS su una vettura che parla è l'antenna; una
   * vettura che parla senza errori e che il centro non localizza mai è una
   * vettura che il centro non ha attivato. */
  const esito: EsitoSettimana =
    giorniConCorsa > 0 ? "funziona"
      : giorniConPosizione > 0 ? "senza_corsa"
        : giorniConContatto > 0 && giorniErroreGps > 0 ? "senza_posizione"
          : giorniConContatto > 0 ? "non_attivata"
            : "muta";

  const osservate = giornate.length || ordinate.length;
  const intermittente = giorniConContatto > 0
    && giorniConContatto < Math.max(1, Math.ceil(osservate * QUOTA_CONTINUA));

  const fine = giornate.length ? giornate[giornate.length - 1] : ordinate[ordinate.length - 1]?.giorno;
  const ultimoGiornoConContatto = [...ordinate].reverse().find(r => r.lettureFresche > 0)?.giorno
    ?? giornoDi(ultimoContatto);
  const giorniDiSilenzio = ultimoGiornoConContatto && fine
    ? distanzaGiorni(ultimoGiornoConContatto, fine)
    : osservate;

  const perGiorno = ordinate.map(r => ({ giorno: r.giorno, esito: esitoGiorno(r) }));

  /* L'ultima giornata buona e quante giornate osservate sono passate da
   * allora. Si contano le giornate OSSERVATE, non quelle di calendario: un
   * buco del connettore non deve far sembrare smessa una vettura sana. */
  const buone = perGiorno.filter(g => g.esito === "in_servizio" || g.esito === "traccia");
  const ultimoGiornoBuono = buone.length ? buone[buone.length - 1].giorno : null;
  const giorniDaBuono = ultimoGiornoBuono
    ? giornate.filter(g => g > ultimoGiornoBuono).length
    : null;

  const avviso: Avviso | null =
    ultimoGiornoBuono && giorniDaBuono != null && giorniDaBuono >= GIORNI_SMESSA ? "smessa"
      : esito === "senza_posizione" ? "antenna"
        : esito === "non_attivata" ? "da_attivare"
          : intermittente && esito !== "muta" ? "intermittente"
            : null;

  const { destinatario, azione } = AZIONI[esito];

  /* La nota è quella che finisce nella segnalazione: deve reggere da sola,
   * senza la tabella accanto. */
  const pezzi: string[] = [];
  pezzi.push(`${giorniConContatto} giornate su ${osservate} con contatto`);
  if (giorniMonitorata > 0) pezzi.push(`${giorniMonitorata} seguita dal centro`);
  if (giorniConPosizione > 0) pezzi.push(`${giorniConPosizione} con posizione`);
  if (giorniConCorsa > 0) pezzi.push(`${giorniConCorsa} con corse (${corse.size} corse in tutto)`);
  if (giorniErroreGps > 0) pezzi.push(`${giorniErroreGps} con errore GPS`);
  if (giorniErroreGprs > 0) pezzi.push(`${giorniErroreGprs} con errore di rete`);
  if (intermittente) pezzi.push("parla a sprazzi, non con continuità");
  if (esito !== "muta" && giorniDiSilenzio >= 2) pezzi.push(`tace da ${giorniDiSilenzio} giornate`);
  if (avviso === "smessa") pezzi.push(`ultima posizione il ${ultimoGiornoBuono}, poi niente per ${giorniDaBuono} giornate`);

  return {
    vehicleRef, esito, destinatario, azione,
    nota: pezzi.join("; ") + ".",
    giornate: osservate,
    giorniConContatto, giorniMonitorata, giorniConPosizione, giorniConCorsa,
    giorniErroreGps, giorniErroreGprs,
    corse: corse.size,
    linee: [...linee].sort().slice(0, 8),
    primoContatto, ultimoContatto, giorniDiSilenzio, intermittente,
    perGiorno, ultimoGiornoBuono, giorniDaBuono, avviso,
  };
}

/**
 * Tutto il periodo: il verdetto per vettura, l'andamento giorno per giorno e
 * le segnalazioni già divise per destinatario.
 *
 * `giornate` è l'elenco delle giornate che il periodo COPRE, non solo quelle
 * con dati: una giornata in cui il connettore era fermo non deve diventare una
 * giornata in cui tutte le vetture erano mute, e infatti viene segnalata a
 * parte in `giornateSenzaDati`.
 */
export function analizzaDiario(righe: RigaDiario[], giornate: string[]): DiarioSettimana {
  const giorni = [...new Set(giornate)].sort();
  const conDati = new Set(righe.map(r => r.giorno));
  const giornateSenzaDati = giorni.filter(g => !conDati.has(g));
  /* Le giornate su cui si giudica sono quelle in cui abbiamo davvero letto:
   * includere i buchi del connettore abbasserebbe ogni percentuale e farebbe
   * sembrare intermittenti vetture che non hanno saltato un giro. */
  const osservate = giorni.filter(g => conDati.has(g));

  const perVettura = new Map<string, RigaDiario[]>();
  for (const r of righe) {
    const l = perVettura.get(r.vehicleRef) ?? [];
    l.push(r);
    perVettura.set(r.vehicleRef, l);
  }

  const vetture = [...perVettura.entries()]
    .map(([ref, l]) => classificaVettura(ref, l, osservate))
    .sort((a, b) => {
      const p = PESO_ESITO[a.esito] - PESO_ESITO[b.esito];
      if (p !== 0) return p;
      /* Dentro la stessa voce, prima quelle che parlano ancora: sono quelle su
       * cui una segnalazione ha più probabilità di produrre qualcosa. */
      const c = b.giorniConContatto - a.giorniConContatto;
      if (c !== 0) return c;
      return a.vehicleRef.localeCompare(b.vehicleRef, undefined, { numeric: true });
    });

  const perGiorno: GiornataDiario[] = osservate.map(g => {
    const delGiorno = righe.filter(r => r.giorno === g);
    const conteggi = { inServizio: 0, traccia: 0, collegata: 0, muta: 0 };
    let monitorate = 0, campioni = 0;
    for (const r of delGiorno) {
      if (r.letture > campioni) campioni = r.letture;
      const e = esitoGiorno(r);
      if (e === "in_servizio") conteggi.inServizio++;
      else if (e === "traccia") conteggi.traccia++;
      else if (e === "collegata") conteggi.collegata++;
      else conteggi.muta++;
      if (r.lettureMonitorata > 0) monitorate++;
    }
    return { giorno: g, ...conteggi, monitorate, vetture: delGiorno.length, campioni };
  });

  /* La qualità della raccolta. Le giornate a metà nel MEZZO del periodo sono
   * un connettore che si è fermato: vanno dette, perché una vettura che quel
   * giorno risulta muta forse ha solo parlato mentre nessuno ascoltava. La
   * prima e l'ultima giornata sono parziali per natura. */
  const interne = perGiorno.slice(1, -1);
  const giornateParziali = interne
    .filter(g => g.campioni < CAMPIONI_GIORNATA / 2)
    .map(g => g.giorno);
  const qualita: DiarioSettimana["qualita"] = {
    campioniAttesi: CAMPIONI_GIORNATA,
    giornateParziali,
    nota: perGiorno.length === 0
      ? "Nessuna giornata raccolta."
      : giornateParziali.length
        ? `${giornateParziali.length} giornate con meno di mezza raccolta (`
          + `${giornateParziali.join(", ")}): il connettore era fermo per ore. `
          + "I silenzi di quei giorni non sono tutti delle vetture."
        : `Raccolta regolare: ogni giornata interna ha almeno ${CAMPIONI_GIORNATA / 2} campioni.`,
  };

  /* Che cosa è cambiato: si confronta la prima giornata osservata con
   * l'ultima, sulla scala degli anelli. È la misura di un'attivazione fatta
   * in mezzo al periodo — e, all'incontrario, di un apparato che ha ceduto. */
  const migliorate: DiarioSettimana["cambiamenti"]["migliorate"] = [];
  const peggiorate: DiarioSettimana["cambiamenti"]["peggiorate"] = [];
  if (osservate.length >= 2) {
    const primo = osservate[0];
    const ultimo = osservate[osservate.length - 1];
    for (const v of vetture) {
      const da = v.perGiorno.find(x => x.giorno === primo)?.esito;
      const a = v.perGiorno.find(x => x.giorno === ultimo)?.esito;
      if (!da || !a || da === a) continue;
      if (SCALA[a] > SCALA[da]) migliorate.push({ vehicleRef: v.vehicleRef, da, a });
      else peggiorate.push({ vehicleRef: v.vehicleRef, da, a });
    }
  }

  const perEsito = (["funziona", "senza_corsa", "senza_posizione", "non_attivata", "muta"] as EsitoSettimana[])
    .map(esito => ({ esito, conteggio: vetture.filter(v => v.esito === esito).length }))
    .filter(x => x.conteggio > 0);

  const segnalazioni: Segnalazione[] = perEsito
    .filter(x => x.esito !== "funziona")
    .map(({ esito }) => {
      const gruppo = vetture.filter(v => v.esito === esito);
      return {
        destinatario: AZIONI[esito].destinatario,
        esito,
        azione: AZIONI[esito].azione,
        matricole: gruppo.map(v => v.vehicleRef),
        conContattoRecente: gruppo.filter(v => v.giorniDiSilenzio <= 1 && v.giorniConContatto > 0)
          .map(v => v.vehicleRef),
      };
    });

  const ORDINE_AVVISI: Avviso[] = ["smessa", "antenna", "da_attivare", "intermittente"];
  const avvisi = ORDINE_AVVISI
    .map(a => ({
      avviso: a,
      matricole: vetture.filter(v => v.avviso === a).map(v => v.vehicleRef),
      ...ETICHETTE_AVVISO[a],
    }))
    .filter(x => x.matricole.length > 0);

  const perDest = new Map<Destinatario, number>();
  for (const v of vetture) {
    if (v.esito === "funziona") continue;
    perDest.set(v.destinatario, (perDest.get(v.destinatario) ?? 0) + 1);
  }

  const funzionanti = vetture.filter(v => v.esito === "funziona").length;
  const nota = osservate.length === 0
    ? "Il diario è vuoto: nessun giro di lettura ha ancora registrato una giornata."
    : osservate.length < GIORNATE_MINIME
      ? `Solo ${osservate.length} giornate raccolte su ${giorni.length}: servono almeno `
        + `${GIORNATE_MINIME} giornate prima di segnalare, altrimenti si sta guardando `
        + "un'istantanea con più passaggi."
      : `${funzionanti} vetture su ${vetture.length} hanno fatto almeno una corsa in `
        + `${osservate.length} giornate; ${vetture.length - funzionanti} hanno un anello `
        + "rotto e sono divise per destinatario qui sotto."
        + (giornateSenzaDati.length
          ? ` Attenzione: ${giornateSenzaDati.length} giornate del periodo non hanno dati `
            + "(connettore fermo) e non entrano nei conti."
          : "");

  return {
    giornate: giorni,
    giornateOsservate: osservate.length,
    vetture,
    perGiorno,
    riepilogo: {
      totale: vetture.length,
      funzionanti,
      daSegnalare: vetture.length - funzionanti,
      perEsito,
      perDestinatario: [...perDest.entries()]
        .map(([destinatario, conteggio]) => ({ destinatario, conteggio }))
        .sort((a, b) => b.conteggio - a.conteggio),
    },
    cambiamenti: { migliorate, peggiorate },
    segnalazioni,
    nota,
    giornateSenzaDati,
    avvisi,
    qualita,
  };
}
