/**
 * La dimostrazione di Argos sulla pagina di accesso (tappa 7.36): una
 * biblioteca d'esempio e due domande d'esempio, con la loro traccia, per far
 * girare lo stesso crawler della console (lib/argos-sciame.ts, e in 3D
 * lib/argos-cervello3d.ts) senza essere entrati e senza chiamare il server.
 *
 * La pagina dice che è un esempio. Le risposte dicono solo cose che Cerbero fa
 * davvero (il controllo del GTFS delle tappe 6.43–6.45, le assenze col
 * sostituto suggerito della 5.1, il roster per deposito della 2.14c). Nessun
 * dato di un'azienda: i documenti sono titoli generici del settore.
 */
import type { Affermazione, DocumentoMappa, Mappa, Passaggio, TracciaRetrieval, TracciaVerifica } from "./argos-sciame";

type Lingua = "it" | "en";
type Testo = Readonly<Record<Lingua, string>>;

/** Le categorie della biblioteca, coi nomi in inglese in tutte e due le lingue. */
export const CATEGORIE_DIMOSTRAZIONE = [
  "Labour agreements", "Regulations", "Procedures", "Network & timetables", "Fares", "Operations",
] as const;

/** I documenti: [categoria, titolo italiano, titolo inglese]. */
const DOCUMENTI: ReadonlyArray<readonly [number, string, string]> = [
  [0, "CCNL Autoferrotranvieri", "National transit labour agreement"], [0, "Accordo aziendale turni", "Company duty agreement"],
  [0, "Riposi e pause", "Rest and breaks"], [0, "Vestizione dei turni", "Duty assignment"], [0, "Ferie e permessi", "Leave and permits"],
  [0, "Lavoro straordinario", "Overtime"],
  [1, "Reg. CE 561/2006", "Reg. (EC) 561/2006"], [1, "Specifica GTFS", "GTFS reference"], [1, "Profilo NeTEx italiano", "Italian NeTEx profile"],
  [1, "Codice della strada", "Highway code"], [1, "Protezione dei dati", "Data protection"], [1, "Carta della mobilità", "Service charter"],
  [2, "Pubblicazione del GTFS", "GTFS publishing"], [2, "Controllo del feed", "Feed validation"], [2, "Gestione delle assenze", "Absence handling"],
  [2, "Sostituzioni", "Replacements"], [2, "Chiusura del mese", "Month-end close"], [2, "Variazioni di servizio", "Service changes"],
  [3, "Guida a Planning Studio", "Planning Studio guide"], [3, "Matrice di validità", "Validity matrix"], [3, "Calendari e festivi", "Calendars and holidays"],
  [3, "Percorsi e fermate", "Routes and stops"], [3, "Tempi di percorrenza", "Running times"], [3, "Orari invernali", "Winter timetable"],
  [4, "Fasce chilometriche", "Distance bands"], [4, "Polimetriche", "Distance fare tables"], [4, "Zone tariffarie", "Fare zones"],
  [4, "Titoli di viaggio", "Ticket products"], [4, "Pagamento contactless", "Contactless payment"], [4, "Bigliettazione", "Ticketing system"],
  [5, "Sala operativa", "Control room"], [5, "Regole dell'AVM", "AVL rules"], [5, "Diagnosi della giornata", "Daily diagnosis"],
  [5, "Soppressioni", "Cancellations"], [5, "Sciopero e fasce garantite", "Strikes and guaranteed hours"], [5, "Mezzi e depositi", "Vehicles and depots"],
];

/** L'id di un documento d'esempio: 1000 + posizione. */
const idDoc = (i: number) => 1000 + i;
const indice = (titoloIt: string) => {
  const i = DOCUMENTI.findIndex((d) => d[1] === titoloIt);
  if (i < 0) throw new Error(`documento d'esempio sconosciuto: ${titoloIt}`);
  return i;
};

/** La mappa dei documenti, come GET /mappa/documenti. */
export function mappaDimostrazione(lingua: Lingua): Mappa {
  const nodes: DocumentoMappa[] = DOCUMENTI.map(([c, it, en], i) => ({
    id: idDoc(i),
    title: lingua === "en" ? en : it,
    category: CATEGORIE_DIMOSTRAZIONE[c]!,
    chunks: 8 + ((i * 37) % 29),
  }));
  return { nodes, categories: [...CATEGORIE_DIMOSTRAZIONE] };
}

type Stato = "kept" | "dropped" | "dup" | "below";
interface Candidato { doc: string; stato: Stato; rango?: number; punteggio: number; sezione?: Testo }

interface Concetto { nome: Testo; doc: string }

interface Copione {
  domanda: Testo;
  /** le parole chiave della domanda, quelle che il crawler cerca nei passaggi */
  termini: Readonly<Record<Lingua, readonly string[]>>;
  /** la risposta, con i rimandi alle fonti fra parentesi quadre */
  risposta: Testo;
  /** le frasi della risposta e la fonte di ciascuna (1, 2, 3 = rango nel contesto) */
  frasi: ReadonlyArray<{ testo: Testo; fonte: number }>;
  candidati: readonly Candidato[];
  ponti: ReadonlyArray<{ doc: string; da: string }>;
  concetti: readonly Concetto[];
  relazioni: ReadonlyArray<readonly [number, number, string]>;
  strumenti: readonly string[];
}

const COPIONI: readonly Copione[] = [
  {
    domanda: {
      it: "Che cosa controlla Cerbero sul GTFS prima di pubblicarlo?",
      en: "What does Cerbero check in the GTFS before publishing it?",
    },
    termini: { it: ["controlla", "gtfs", "pubblicare"], en: ["check", "gtfs", "publishing"] },
    risposta: {
      it: "Prima di pubblicare, Cerbero controlla le fermate lontane dal tracciato del percorso e gli orari impossibili fra due fermate [1][2]. Guarda anche la validità dei calendari: un programma già scaduto non va nei dati aperti [3].",
      en: "Before publishing, Cerbero checks stops lying far from the route shape and impossible times between two stops [1][2]. It also looks at calendar validity: an expired timetable does not go into the open data [3].",
    },
    frasi: [
      { testo: { it: "Cerbero controlla le fermate lontane dal tracciato del percorso", en: "Cerbero checks stops lying far from the route shape" }, fonte: 1 },
      { testo: { it: "e gli orari impossibili fra due fermate", en: "and impossible times between two stops" }, fonte: 2 },
      { testo: { it: "un programma già scaduto non va nei dati aperti", en: "an expired timetable does not go into the open data" }, fonte: 3 },
    ],
    candidati: [
      { doc: "Controllo del feed", stato: "kept", rango: 1, punteggio: 0.86, sezione: { it: "§ Fermate e tracciati", en: "§ Stops and shapes" } },
      { doc: "Tempi di percorrenza", stato: "kept", rango: 2, punteggio: 0.79, sezione: { it: "§ Orari impossibili", en: "§ Impossible times" } },
      { doc: "Pubblicazione del GTFS", stato: "kept", rango: 3, punteggio: 0.77, sezione: { it: "§ Programmi scaduti", en: "§ Expired timetables" } },
      { doc: "Specifica GTFS", stato: "kept", rango: 4, punteggio: 0.71 },
      { doc: "Percorsi e fermate", stato: "dropped", punteggio: 0.62 },
      { doc: "Calendari e festivi", stato: "dropped", punteggio: 0.58 },
      { doc: "Guida a Planning Studio", stato: "dropped", punteggio: 0.55 },
      { doc: "Controllo del feed", stato: "dup", punteggio: 0.66 },
      { doc: "Profilo NeTEx italiano", stato: "dropped", punteggio: 0.49 },
      { doc: "Matrice di validità", stato: "dup", punteggio: 0.47 },
      { doc: "Orari invernali", stato: "below", punteggio: 0.21 },
      { doc: "Zone tariffarie", stato: "below", punteggio: 0.17 },
      { doc: "Sala operativa", stato: "below", punteggio: 0.14 },
      { doc: "Carta della mobilità", stato: "below", punteggio: 0.12 },
    ],
    ponti: [{ doc: "Calendari e festivi", da: "Pubblicazione del GTFS" }, { doc: "Percorsi e fermate", da: "Controllo del feed" }],
    concetti: [
      { nome: { it: "fermata fuori tracciato", en: "off-route stop" }, doc: "Controllo del feed" },
      { nome: { it: "tempo di percorrenza", en: "running time" }, doc: "Tempi di percorrenza" },
      { nome: { it: "validità del calendario", en: "calendar validity" }, doc: "Pubblicazione del GTFS" },
      { nome: { it: "feed GTFS", en: "GTFS feed" }, doc: "Specifica GTFS" },
    ],
    relazioni: [[0, 3, "applica"], [1, 3, "applica"], [2, 3, "prerequisito"], [0, 1, "correlato"]],
    strumenti: [],
  },
  {
    domanda: {
      it: "Se un conducente si assenta, chi copre il suo turno?",
      en: "If a driver is absent, who covers the duty?",
    },
    termini: { it: ["conducente", "assenta", "turno"], en: ["driver", "absent", "duty"] },
    risposta: {
      it: "L'assenza libera il turno e Cerbero suggerisce un sostituto fra i conducenti liberi del deposito [1][2]. La scelta resta al capo deposito, che la conferma nel roster del suo deposito [3].",
      en: "The absence frees the duty and Cerbero suggests a replacement among the depot's free drivers [1][2]. The choice stays with the depot manager, who confirms it in the depot's roster [3].",
    },
    frasi: [
      { testo: { it: "L'assenza libera il turno", en: "The absence frees the duty" }, fonte: 1 },
      { testo: { it: "Cerbero suggerisce un sostituto fra i conducenti liberi del deposito", en: "Cerbero suggests a replacement among the depot's free drivers" }, fonte: 2 },
      { testo: { it: "La scelta resta al capo deposito", en: "The choice stays with the depot manager" }, fonte: 3 },
    ],
    candidati: [
      { doc: "Gestione delle assenze", stato: "kept", rango: 1, punteggio: 0.88, sezione: { it: "§ Turno liberato", en: "§ Freed duty" } },
      { doc: "Sostituzioni", stato: "kept", rango: 2, punteggio: 0.84, sezione: { it: "§ Sostituto suggerito", en: "§ Suggested replacement" } },
      { doc: "Vestizione dei turni", stato: "kept", rango: 3, punteggio: 0.74, sezione: { it: "§ Per deposito", en: "§ By depot" } },
      { doc: "Riposi e pause", stato: "kept", rango: 4, punteggio: 0.69 },
      { doc: "CCNL Autoferrotranvieri", stato: "dropped", punteggio: 0.61 },
      { doc: "Accordo aziendale turni", stato: "dropped", punteggio: 0.57 },
      { doc: "Ferie e permessi", stato: "dropped", punteggio: 0.52 },
      { doc: "Sostituzioni", stato: "dup", punteggio: 0.64 },
      { doc: "Mezzi e depositi", stato: "dropped", punteggio: 0.46 },
      { doc: "Lavoro straordinario", stato: "dup", punteggio: 0.44 },
      { doc: "Diagnosi della giornata", stato: "below", punteggio: 0.22 },
      { doc: "Soppressioni", stato: "below", punteggio: 0.18 },
      { doc: "Reg. CE 561/2006", stato: "below", punteggio: 0.15 },
      { doc: "Titoli di viaggio", stato: "below", punteggio: 0.09 },
    ],
    ponti: [{ doc: "CCNL Autoferrotranvieri", da: "Riposi e pause" }, { doc: "Mezzi e depositi", da: "Vestizione dei turni" }],
    concetti: [
      { nome: { it: "turno scoperto", en: "uncovered duty" }, doc: "Gestione delle assenze" },
      { nome: { it: "sostituto", en: "replacement" }, doc: "Sostituzioni" },
      { nome: { it: "deposito", en: "depot" }, doc: "Vestizione dei turni" },
      { nome: { it: "riposo minimo", en: "minimum rest" }, doc: "Riposi e pause" },
    ],
    relazioni: [[0, 1, "prerequisito"], [1, 2, "applica"], [3, 1, "applica"], [2, 0, "correlato"]],
    strumenti: ["roster"],
  },
];

export interface CorsaDimostrativa {
  domanda: string;
  risposta: string;
  traccia: TracciaRetrieval;
  verifica: TracciaVerifica;
  fonti: Array<{ document_id: number; document_title: string; score: number }>;
  strumenti: readonly string[];
}

export const QUANTE_CORSE = COPIONI.length;

/** La corsa d'esempio n (a rotazione), nella lingua chiesta: domanda, traccia, risposta, verifica, fonti. */
export function corsaDimostrativa(n: number, lingua: Lingua): CorsaDimostrativa {
  const c = COPIONI[((n % COPIONI.length) + COPIONI.length) % COPIONI.length]!;
  const titolo = (doc: string) => {
    const d = DOCUMENTI[indice(doc)]!;
    return lingua === "en" ? d[2] : d[1];
  };
  const categoria = (doc: string) => CATEGORIE_DIMOSTRAZIONE[DOCUMENTI[indice(doc)]![0]]!;
  const termini = c.termini[lingua];

  const pool: Passaggio[] = c.candidati.map((k, i) => ({
    id: idDoc(indice(k.doc)) * 100 + i,
    document_id: idDoc(indice(k.doc)),
    title: titolo(k.doc),
    category: categoria(k.doc),
    section: k.sezione ? k.sezione[lingua] : null,
    score: k.punteggio,
    rerank: k.stato === "kept" || k.stato === "dropped" ? Math.round((k.punteggio + (k.stato === "kept" ? 0.08 : -0.1)) * 100) / 100 : null,
    status: k.stato,
    final_rank: k.rango ?? null,
    hits: Object.fromEntries(termini.slice(0, 2).map((t, j) => [t, Math.max(1, 3 - j - (i % 2))])),
  }));
  const contesto = pool.filter((p) => p.status === "kept").sort((a, b) => (a.final_rank ?? 99) - (b.final_rank ?? 99));
  const bridges: Passaggio[] = c.ponti.map((p, i) => {
    const da = contesto.find((x) => x.document_id === idDoc(indice(p.da)));
    return {
      id: idDoc(indice(p.doc)) * 100 + 90 + i,
      document_id: idDoc(indice(p.doc)),
      title: titolo(p.doc),
      category: categoria(p.doc),
      section: null,
      score: 0.6 - i * 0.05,
      status: "kept",
      final_rank: null,
      via: "cosine",
      from_id: da?.id ?? null,
    };
  });
  const concepts = c.concetti.map((k, i) => ({
    id: 500 + i,
    name: k.nome[lingua],
    category: categoria(k.doc),
    weight: 3 - (i % 3),
    chunk_ids: contesto.filter((p) => p.document_id === idDoc(indice(k.doc))).map((p) => p.id),
  }));
  const traccia: TracciaRetrieval = {
    kind: "retrieval",
    query: { text: c.domanda[lingua], terms: termini.slice(0, 6) },
    settings: { min_score: 0.3, top_k: 4 },
    pool,
    context: [...contesto.map((p) => p.id), bridges[0]?.id ?? null],
    bridges,
    concepts,
    concept_edges: c.relazioni.map(([a, b, rel]) => ({ a: 500 + a, b: 500 + b, rel, w: 0.7, from: 500 + a })),
    categories: [...CATEGORIE_DIMOSTRAZIONE],
    memory: false,
  };
  const claims: Affermazione[] = c.frasi.map((f) => ({
    text: f.testo[lingua],
    source: f.fonte,
    traced: true,
    cited: true,
    overlap: 0.6,
    words: f.testo[lingua].toLowerCase().match(/[a-zà-ÿ]{5,}/g)?.slice(0, 3) ?? [],
  }));
  const verifica: TracciaVerifica = { kind: "verify", claims, traced: claims.length, total: claims.length, tools_used: [...c.strumenti] };
  const fonti = contesto.slice(0, 3).map((p) => ({ document_id: Number(p.document_id), document_title: p.title ?? "", score: p.score }));
  return { domanda: c.domanda[lingua], risposta: c.risposta[lingua], traccia, verifica, fonti, strumenti: c.strumenti };
}

/** Le fasi del crawler, coi nomi in inglese e la frase nella lingua della pagina. */
export const FASI_DIMOSTRAZIONE: ReadonlyArray<{ nome: string; frase: Testo }> = [
  { nome: "QUERY", frase: { it: "che cosa mi stai chiedendo?", en: "what are you asking?" } },
  { nome: "RETRIEVAL", frase: { it: "dove se ne parla?", en: "where is it discussed?" } },
  { nome: "RERANK", frase: { it: "che cosa è davvero pertinente?", en: "what is really relevant?" } },
  { nome: "CONTEXT", frase: { it: "che cosa leggo per rispondere?", en: "what do I read to answer?" } },
  { nome: "BRIDGES", frase: { it: "quali documenti si collegano?", en: "which documents connect?" } },
  { nome: "CONCEPTS", frase: { it: "quali idee entrano in gioco?", en: "which ideas come into play?" } },
  { nome: "ANSWER", frase: { it: "scrivo la risposta", en: "writing the answer" } },
  { nome: "VERIFY", frase: { it: "ogni affermazione ha una fonte?", en: "does every claim have a source?" } },
];
