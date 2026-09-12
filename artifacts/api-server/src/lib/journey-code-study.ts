/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL CODICE CORSA DELL'AVM E QUELLO DEL GTFS
 * ───────────────────────────────────────────────────────────────────────────
 * L'AVM dichiara un identificativo di corsa (`DatedVehicleJourneyRef`, oppure
 * `CourseOfJourneyRef` su Flashnet). Il feed GTFS ne ha un altro, `trip_id`.
 * I due non combaciano, quindi l'aggancio ripiega su linea + ora di partenza:
 * funziona, ma è un riconoscimento, non un'identificazione — due corse che
 * partono allo stesso minuto sulla stessa linea restano indistinguibili.
 *
 * Qui NON si indovina la regola. Si raccolgono le coppie che l'aggancio per
 * orario produce ogni giorno, e su quelle si misura quali regole reggono.
 *
 * ── Il punto in cui è facile ingannarsi ──
 *
 * Una regola con un parametro (il prefisso costante, la lunghezza della coda)
 * si RICAVA dalle stesse coppie su cui poi la si verifica: dire che spiega il
 * 100% dei casi è tautologico, perché è stata costruita per farlo. L'unica
 * prova vera è la CONTROPROVA: si ricava la regola dal primo giorno e la si
 * verifica sui giorni successivi, che non hanno partecipato alla costruzione.
 * Finché c'è un giorno solo, la quota si dichiara `tautologica` e vale zero
 * come prova.
 *
 * ── E se nessuna regola regge ──
 *
 * Non è un fallimento: vuol dire che i due codici non sono trasformabili
 * l'uno nell'altro, perché nascono da anagrafiche diverse. In quel caso la
 * risposta giusta non è una formula ma proprio questa tabella: la
 * corrispondenza osservata, corsa per corsa. Serve però che sia STABILE — lo
 * stesso codice AVM sulla stessa corsa GTFS, giorno dopo giorno. È la cosa
 * che si misura qui sotto, ed è la sola che decide se ci si può appoggiare.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Una corrispondenza osservata fra i due mondi, in un giorno di servizio. */
export interface CoppiaCodici {
  /** giorno di servizio, "YYYY-MM-DD" */
  giorno: string;
  /** l'identificativo dichiarato dall'AVM */
  journeyRef: string;
  /** la corsa del feed a cui l'abbiamo attribuito, se c'è */
  tripId: string | null;
  /** "id" = i codici combaciavano già; "orario" = riconosciuta da linea+partenza */
  agganciatoCome: "id" | "orario" | null;
  /** quante letture hanno confermato questa coppia */
  osservazioni: number;
}

/* ── La forma di un codice ────────────────────────────────────────────────
 * Prima di cercare una trasformazione conviene guardare che ASPETTO hanno i
 * due codici: "6 cifre" contro "4 cifre + trattino + 3 cifre" dice già che
 * non sono lo stesso numero scritto in due modi. */

/** "0072_12A" → "NNNN_NNL". N = cifra, L = lettera, il resto letterale.
 *
 * In una passata sola: sostituendo prima le cifre con "N" e poi le lettere
 * con "L", le "N" appena scritte verrebbero riconvertite in "L" e ogni codice
 * numerico sembrerebbe alfabetico. */
export function forma(codice: string): string {
  return [...codice].map(c =>
    c >= "0" && c <= "9" ? "N" : /[A-Za-z]/.test(c) ? "L" : c).join("");
}

export interface Forma {
  forma: string;
  quanti: number;
  esempio: string;
}

function formeDi(codici: string[]): Forma[] {
  const m = new Map<string, { quanti: number; esempio: string }>();
  for (const c of codici) {
    const f = forma(c);
    const v = m.get(f);
    if (v) v.quanti++;
    else m.set(f, { quanti: 1, esempio: c });
  }
  return [...m.entries()]
    .map(([forma, v]) => ({ forma, ...v }))
    .sort((a, b) => b.quanti - a.quanti);
}

/* ── Le regole candidate ──────────────────────────────────────────────────
 * Ognuna è una funzione dal codice AVM al codice GTFS. Quelle con un
 * parametro (prefisso, lunghezza) lo IMPARANO da un insieme di coppie, e chi
 * le usa deve sapere su quale insieme: è la differenza fra una misura e una
 * tautologia. */

interface Coppia { j: string; t: string }

export interface Regola {
  nome: string;
  /** che cosa afferma, in una frase leggibile */
  enunciato: string;
  applica: (journeyRef: string) => string | null;
}

/** Solo le cifre, senza zeri davanti: "0072" e "72" sono lo stesso numero. */
function soloCifre(s: string): string | null {
  const d = s.replace(/\D/g, "");
  if (!d) return null;
  const n = d.replace(/^0+/, "");
  return n === "" ? "0" : n;
}

/** Il valore che ricorre di più, se c'è. Serve a imparare un parametro senza
 *  farsi bloccare da qualche coppia storta. */
function piuFrequente(xs: string[]): string | null {
  if (xs.length === 0) return null;
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  const [best] = [...c.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[0] !== "" ? best[0] : null;
}

/**
 * Le regole plausibili, ricavate DA `da`. Chi verifica su un insieme diverso
 * ottiene una misura; chi verifica sullo stesso ottiene una tautologia.
 */
export function regoleDa(da: Coppia[]): Regola[] {
  const regole: Regola[] = [
    {
      nome: "identici",
      enunciato: "il codice dell'AVM è già il trip_id del feed",
      applica: j => j,
    },
    {
      nome: "stesso numero",
      enunciato: "tolte le lettere e gli zeri iniziali i due codici sono lo stesso numero",
      /* Non produce un trip_id: il confronto avviene sul numero di entrambi.
       * Si segnala restituendo la forma numerica, e chi confronta la applica
       * anche al trip_id — vedi `verifica`. */
      applica: j => soloCifre(j),
    },
  ];

  /* Il parametro si impara dalla MAGGIORANZA, non dalla totalità: con dati
   * reali basta una corsa storta perché una regola giusta non venga nemmeno
   * proposta. Quanto valga poi la regola lo dice `verifica`, non questo. */
  const teste = da.filter(c => c.t.endsWith(c.j) && c.t !== c.j)
    .map(c => c.t.slice(0, c.t.length - c.j.length));
  const testa = piuFrequente(teste);
  if (testa) {
    regole.push({
      nome: "prefisso costante",
      enunciato: `il trip_id è «${testa}» seguito dal codice dell'AVM`,
      applica: j => testa + j,
    });
  }
  if (teste.length > 0) {
    regole.push({
      nome: "coda",
      enunciato: "il trip_id termina con il codice dell'AVM, con davanti una parte variabile",
      applica: () => null, // non ricostruisce: serve a misurare, non a tradurre
    });
  }

  /* Suffisso costante: il codice AVM è la testa del trip_id. */
  const code = da.filter(c => c.t.startsWith(c.j) && c.t !== c.j)
    .map(c => c.t.slice(c.j.length));
  const suff = piuFrequente(code);
  if (suff) {
    regole.push({
      nome: "suffisso costante",
      enunciato: `il trip_id è il codice dell'AVM seguito da «${suff}»`,
      applica: j => j + suff,
    });
  }

  /* Un segmento del trip_id: "L03_0072_A" contiene "0072". Non ricostruisce
   * il trip_id (non si sa quale segmento né cosa ci sta attorno): dice solo
   * se il codice AVM compare come pezzo intero. */
  regole.push({
    nome: "un segmento del trip_id",
    enunciato: "il codice dell'AVM è uno dei pezzi del trip_id separati da -, _, . o :",
    applica: () => null,
  });

  return regole;
}

export interface EsitoRegola {
  nome: string;
  enunciato: string;
  /** coppie in cui la regola indovina il trip_id giusto */
  spiegate: number;
  /** coppie in cui produce un trip_id DIVERSO da quello osservato */
  smentite: number;
  /** coppie su cui non si pronuncia */
  mute: number;
  /** spiegate / coppie esaminate */
  quota: number;
  /** true se la regola è stata ricavata dalle stesse coppie su cui è misurata */
  tautologica: boolean;
  /** i primi casi in cui sbaglia: senza questi "83%" non è azionabile */
  controesempi: Array<{ avm: string; feed: string; regolaDice: string }>;
}

/** Applica una regola a un insieme di coppie e conta. */
export function verifica(
  r: Regola, su: Coppia[], tautologica: boolean,
): EsitoRegola {
  let spiegate = 0, smentite = 0, mute = 0;
  const controesempi: EsitoRegola["controesempi"] = [];

  for (const c of su) {
    let ok: boolean;
    let detto: string | null;

    if (r.nome === "stesso numero") {
      const a = soloCifre(c.j), b = soloCifre(c.t);
      detto = a;
      ok = a != null && b != null && a === b;
      if (a == null || b == null) { mute++; continue; }
    } else if (r.nome === "un segmento del trip_id" || r.nome === "coda") {
      detto = null;
      ok = r.nome === "coda"
        ? c.t.endsWith(c.j)
        : c.t.split(/[-_.:]/).includes(c.j);
    } else {
      detto = r.applica(c.j);
      if (detto == null) { mute++; continue; }
      ok = detto === c.t;
    }

    if (ok) spiegate++;
    else {
      smentite++;
      if (controesempi.length < 5) {
        controesempi.push({ avm: c.j, feed: c.t, regolaDice: detto ?? "—" });
      }
    }
  }

  const esaminate = spiegate + smentite + mute;
  return {
    nome: r.nome, enunciato: r.enunciato, spiegate, smentite, mute,
    quota: esaminate > 0 ? spiegate / esaminate : 0,
    tautologica, controesempi,
  };
}

/* ── La stabilità della corrispondenza ────────────────────────────────────
 * Se nessuna formula regge, resta la tabella. Ma una tabella serve solo se la
 * corrispondenza è UNA: un codice AVM che in giorni diversi finisce su corse
 * diverse non è un identificativo di corsa, è un numero di turno o di vettura
 * riusato, e appoggiarcisi sposterebbe i mezzi sulle corse sbagliate. */

export interface Stabilita {
  /** codici AVM visti su più di una corsa GTFS */
  avmAmbigui: Array<{ journeyRef: string; corse: string[] }>;
  /** corse GTFS viste con più di un codice AVM */
  corseAmbigue: Array<{ tripId: string; codici: string[] }>;
  /** quota di codici AVM che puntano sempre alla stessa corsa */
  quotaUnivoca: number;
  /** giorni distinti su cui la misura è fatta: con uno solo non dice nulla */
  giorni: number;
}

function stabilita(coppie: CoppiaCodici[]): Stabilita {
  const perAvm = new Map<string, Set<string>>();
  const perTrip = new Map<string, Set<string>>();
  const giorni = new Set<string>();
  for (const c of coppie) {
    giorni.add(c.giorno);
    if (!c.tripId) continue;
    (perAvm.get(c.journeyRef) ?? perAvm.set(c.journeyRef, new Set()).get(c.journeyRef)!).add(c.tripId);
    (perTrip.get(c.tripId) ?? perTrip.set(c.tripId, new Set()).get(c.tripId)!).add(c.journeyRef);
  }
  const avmAmbigui = [...perAvm.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([journeyRef, s]) => ({ journeyRef, corse: [...s].slice(0, 6) }))
    .slice(0, 25);
  const corseAmbigue = [...perTrip.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([tripId, s]) => ({ tripId, codici: [...s].slice(0, 6) }))
    .slice(0, 25);
  return {
    avmAmbigui, corseAmbigue,
    quotaUnivoca: perAvm.size > 0
      ? [...perAvm.values()].filter(s => s.size === 1).length / perAvm.size : 0,
    giorni: giorni.size,
  };
}

/* ── Lo studio ────────────────────────────────────────────────────────────── */

export interface StudioCodici {
  /** coppie con entrambi i codici: è su queste che si misura */
  coppie: number;
  /** codici AVM distinti */
  codiciAvm: number;
  /** corse GTFS distinte raggiunte */
  corseGtfs: number;
  /** letture in cui l'AVM dichiara un codice ma non si è agganciata una corsa */
  senzaAggancio: number;
  /** quante coppie erano già allineate senza bisogno dell'orario */
  giaAllineate: number;
  giorni: string[];
  forme: { avm: Forma[]; gtfs: Forma[] };
  /** le regole misurate sul giorno più recente, ricavate dal più vecchio */
  regole: EsitoRegola[];
  /** true = c'è un solo giorno, quindi le regole sono tautologiche */
  senzaControprova: boolean;
  stabilita: Stabilita;
  /** che cosa dicono i numeri, in una frase */
  verdetto: string;
}

export function studiaCodici(osservazioni: CoppiaCodici[]): StudioCodici {
  const conTrip = osservazioni.filter(o => !!o.tripId) as Array<CoppiaCodici & { tripId: string }>;
  const giorni = [...new Set(osservazioni.map(o => o.giorno))].sort();
  const coppie: Coppia[] = conTrip.map(o => ({ j: o.journeyRef, t: o.tripId }));

  /* Controprova: si ricava la regola dai giorni PRECEDENTI e la si verifica
   * sull'ultimo, che non ha partecipato. Con un giorno solo non si può, e lo
   * si dichiara invece di far finta. */
  const ultimo = giorni[giorni.length - 1];
  const prima = conTrip.filter(o => o.giorno !== ultimo).map(o => ({ j: o.journeyRef, t: o.tripId }));
  const dopo = conTrip.filter(o => o.giorno === ultimo).map(o => ({ j: o.journeyRef, t: o.tripId }));
  const senzaControprova = giorni.length < 2 || prima.length === 0 || dopo.length === 0;

  const regole = senzaControprova
    ? regoleDa(coppie).map(r => verifica(r, coppie, true))
    : regoleDa(prima).map(r => verifica(r, dopo, false));

  const st = stabilita(osservazioni);
  const migliore = [...regole].sort((a, b) => b.quota - a.quota)[0] ?? null;

  const verdetto = (() => {
    if (coppie.length === 0) {
      return "Nessuna coppia raccolta: o l'AVM non dichiara il codice corsa, "
        + "oppure nessuna corsa è stata agganciata. Senza coppie non c'è nulla da studiare.";
    }
    if (migliore && migliore.quota >= 0.98 && !migliore.tautologica) {
      return `La regola «${migliore.enunciato}» spiega il ${Math.round(migliore.quota * 100)}% `
        + `delle ${dopo.length} coppie di un giorno che non ha partecipato a ricavarla: `
        + "è una corrispondenza vera e si può usare per agganciare direttamente per codice.";
    }
    if (migliore && migliore.quota >= 0.98 && migliore.tautologica) {
      return `La regola «${migliore.enunciato}» torna su tutte le coppie, ma è stata ricavata `
        + "da queste stesse coppie: non è ancora una prova. Serve un secondo giorno di "
        + "raccolta per la controprova.";
    }
    if (st.quotaUnivoca >= 0.98 && st.giorni >= 2) {
      return "Nessuna formula lega i due codici — nascono da anagrafiche diverse — ma la "
        + `corrispondenza osservata è univoca nel ${Math.round(st.quotaUnivoca * 100)}% dei casi `
        + `su ${st.giorni} giorni: la tabella raccolta QUI è già la traduzione, e può essere `
        + "usata come primo tentativo prima di ripiegare su linea + ora di partenza.";
    }
    if (st.giorni < 2) {
      return "Raccolta appena iniziata: un giorno solo non distingue una corrispondenza "
        + "stabile da una coincidenza. Serve almeno un secondo giorno.";
    }
    return `Nessuna formula regge e la corrispondenza non è univoca: ${st.avmAmbigui.length} `
      + "codici dell'AVM sono comparsi su corse diverse. Con ogni probabilità quel codice "
      + "non identifica la corsa dell'orario ma qualcos'altro — un turno vettura o un "
      + "progressivo di viaggio — e va chiesto al produttore che cosa sia.";
  })();

  return {
    coppie: coppie.length,
    codiciAvm: new Set(osservazioni.map(o => o.journeyRef)).size,
    corseGtfs: new Set(conTrip.map(o => o.tripId)).size,
    senzaAggancio: osservazioni.filter(o => !o.tripId).length,
    giaAllineate: osservazioni.filter(o => o.agganciatoCome === "id").length,
    giorni,
    forme: {
      avm: formeDi(osservazioni.map(o => o.journeyRef)),
      gtfs: formeDi(conTrip.map(o => o.tripId)),
    },
    regole: regole.sort((a, b) => b.quota - a.quota),
    senzaControprova,
    stabilita: st,
    verdetto,
  };
}
