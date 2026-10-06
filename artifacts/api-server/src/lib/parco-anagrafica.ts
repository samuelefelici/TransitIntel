/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PARCO — da matricola SIRI a mezzo
 * ───────────────────────────────────────────────────────────────────────────
 * Il flusso SIRI di Mizar identifica le vetture con un numero: per le
 * Conerobus è la matricola aziendale così com'è (263, 1372), per le
 * consorziate è un numero a cinque cifre in cui le DUE cifre iniziali
 * sostituiscono la sigla dell'azienda e le tre finali sono il progressivo:
 *
 *     10003 → SA003    10031 → BV031    11096 → CJ096
 *     12002 → BU002    13163 → RE163
 *
 * Il prefisso 10 vale per due sigle, SA e BV, i cui progressivi non si
 * sovrappongono (SA 001–016, BV 023–040): decide quale codice esiste in
 * anagrafica. Il prefisso 15 (AF e SAP) NON segue il progressivo — 15004 è
 * SAP052 — e si abbina solo con la tabella ECCEZIONI_SIRI.
 *
 * FlashNet applica questa stessa transcodifica al contrario e mostra il
 * codice con le lettere, insieme a una descrizione del mezzo (ambito, classe
 * di lunghezza, modello). Questo modulo porta quella descrizione in Cerbero:
 * nel diario AVM, nello stato del parco e nei fogli da allegare, così una
 * segnalazione all'officina dice «1372, X30p Interurbano 29+1 posti» e non
 * solo un numero.
 *
 * Come è stato verificato. Il 6 ottobre 2026 alle 12:04 sono stati presi,
 * a venti secondi di distanza, l'export FlashNet «Dettaglio veicoli» e il
 * parco SIRI completo: 365 vetture da entrambe le parti. La colonna
 * «Rilevamento» di FlashNet è l'ultimo contatto (ora italiana) e coincide al
 * secondo con il RecordedAtTime di SIRI. Su 290 vetture con un contatto
 * stabile (più di due minuti prima degli export) l'orario conferma la regola
 * in tutti i casi, senza nessuna smentita: 237 Conerobus, 23 BU, 11 CJ,
 * 10 SA, 6 RE, 3 BV. Le eccezioni del 15 vengono dallo stesso confronto.
 *
 * Una matricola che non si riesce ad attribuire si legge «consorziata,
 * prefisso NN», o con le sigle possibili, e non viene attribuita a caso.
 *
 * L'elenco qui sotto è l'export FlashNet «Codice veicolo / Descrizione
 * veicolo» (ottobre 2026). Per aggiornarlo si incolla l'export nuovo: una
 * riga per vettura, codice e descrizione separati da tabulazione.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Prefisso SIRI (due cifre) → sigle aziendali possibili nei codici FlashNet. */
export const AZIENDE_SIRI: Readonly<Record<string, readonly string[]>> = {
  "10": ["SA", "BV"], // SA001–016 e BV023–040: progressivi disgiunti
  "11": ["CJ"],
  "12": ["BU"],
  "13": ["RE"],
  "15": ["AF", "SAP"], // solo via ECCEZIONI_SIRI: il progressivo non coincide
};

/** Prefissi per cui il progressivo SIRI è il progressivo del codice. */
const PREFISSI_A_PROGRESSIVO = new Set(["10", "11", "12", "13"]);

/**
 * Le matricole SIRI che non seguono il progressivo, abbinate una per una
 * sull'orario di ultimo contatto (confronto del 6/10/2026).
 *   15004, 15005, 15007: orario identico al secondo con SAP052, SAP051, SAP053.
 *   15006: per esclusione — è l'unica vettura SIRI rimasta con un contatto, e
 *          AF006 l'unica rimasta in FlashNet; gli orari però differivano di
 *          otto minuti, quindi va riconfermata.
 *   15001, 15002, 15003 non hanno mai parlato col centro, come AF002, AF003 e
 *   SAP062 in FlashNet: l'ordine fra loro non si può dedurre e restano fuori.
 */
export const ECCEZIONI_SIRI: Readonly<Record<string, string>> = {
  "15004": "SAP052",
  "15005": "SAP051",
  "15006": "AF006",
  "15007": "SAP053",
};

const ECCEZIONI_INVERSE = new Map(Object.entries(ECCEZIONI_SIRI).map(([s, c]) => [c, s]));
const SIGLA_A_PREFISSO = new Map(
  Object.entries(AZIENDE_SIRI)
    .filter(([p]) => PREFISSI_A_PROGRESSIVO.has(p))
    .flatMap(([p, sigle]) => sigle.map(s => [s, p] as const)),
);

export type Ambito = "urbano" | "interurbano";

export interface SchedaVettura {
  /** matricola come la pubblica SIRI */
  siriRef: string;
  /** codice FlashNet / aziendale: uguale alla matricola per le Conerobus */
  codice: string;
  /** "Conerobus" oppure la sigla della consorziata */
  azienda: string;
  /** la descrizione FlashNet così com'è */
  descrizione: string;
  ambito: Ambito | null;
  /** classe di lunghezza normalizzata: "<7,5 m", "7,5–9 m", "9–11 m", "11–15 m", "18 m snodato" */
  classe: string | null;
  /** il modello, quando la descrizione lo porta */
  modello: string | null;
}

/* ── Transcodifica ────────────────────────────────────────────────────────── */

/**
 * Da matricola SIRI a codice FlashNet; `null` se non si può dire.
 *
 * Con una sola sigla per prefisso il codice si costruisce anche se non è in
 * anagrafica (una vettura nuova di CJ resta CJ). Con due sigle, come per il
 * 10, decide l'anagrafica: se il progressivo non c'è in nessuna delle due la
 * vettura non viene attribuita.
 */
export function codiceDaSiri(siriRef: string): string | null {
  const ref = siriRef.trim();
  if (/^\d{1,4}$/.test(ref)) return ref;
  const eccezione = ECCEZIONI_SIRI[ref];
  if (eccezione) return eccezione;
  if (!/^\d{5}$/.test(ref)) return null;
  const prefisso = ref.slice(0, 2);
  if (!PREFISSI_A_PROGRESSIVO.has(prefisso)) return null;
  const candidati = (AZIENDE_SIRI[prefisso] ?? []).map(s => s + ref.slice(2));
  const inAnagrafica = candidati.filter(c => ANAGRAFICA.has(c));
  if (inAnagrafica.length === 1) return inAnagrafica[0];
  return candidati.length === 1 ? candidati[0] : null;
}

/** Da codice FlashNet a matricola SIRI. `null` se la sigla non ha una regola. */
export function siriDaCodice(codice: string): string | null {
  const c = codice.trim().toUpperCase();
  if (/^\d{1,4}$/.test(c)) return c;
  const eccezione = ECCEZIONI_INVERSE.get(c);
  if (eccezione) return eccezione;
  const m = c.match(/^([A-Z]+)(\d{3})$/);
  if (!m) return null;
  const prefisso = SIGLA_A_PREFISSO.get(m[1]);
  return prefisso ? prefisso + m[2] : null;
}

/**
 * "Conerobus", la sigla della consorziata, le sigle possibili ("AF/SAP") se
 * il prefisso è noto ma la vettura no, oppure `null` se il prefisso è ignoto.
 */
export function aziendaDaSiri(siriRef: string): string | null {
  const ref = siriRef.trim();
  if (/^\d{1,4}$/.test(ref)) return "Conerobus";
  const codice = codiceDaSiri(ref);
  if (codice) return codice.match(/^[A-Z]+/)?.[0] ?? null;
  if (/^\d{5}$/.test(ref)) return AZIENDE_SIRI[ref.slice(0, 2)]?.join("/") ?? null;
  return null;
}

/** Com'è vista dalla pagina una vettura che non si riesce ad attribuire. */
export function etichettaAzienda(siriRef: string): string {
  const a = aziendaDaSiri(siriRef);
  if (a) return a;
  if (/^\d{5}$/.test(siriRef)) return `consorziata, prefisso ${siriRef.slice(0, 2)}`;
  return "matricola non riconosciuta";
}

/* ── Lettura della descrizione FlashNet ───────────────────────────────────── */

const CLASSI: Array<[RegExp, string]> = [
  [/snodato\s*18\s*m/i, "18 m snodato"],
  [/<7,5\s*m/i, "<7,5 m"],
  [/=7,5<9\s*m/i, "7,5–9 m"],
  [/=9<11\s*m/i, "9–11 m"],
  [/=11<12\s*m/i, "11–12 m"],
  [/=11<15\s*m/i, "11–15 m"],
];

function classeDa(testo: string): string | null {
  for (const [re, classe] of CLASSI) if (re.test(testo)) return classe;
  return null;
}

export function interpretaDescrizione(descrizione: string): Pick<SchedaVettura, "ambito" | "classe" | "modello"> {
  const d = descrizione.replace(/\s+/g, " ").trim();
  const ambito: Ambito | null = /interurbano/i.test(d) ? "interurbano" : /urbano/i.test(d) ? "urbano" : null;

  /* «Urbano =11<15m Irisbus Citelis…», «Interurbano snodato 18m Setra…»,
   * «Urbano Snodato 18m - Solaris…»: ambito, classe, poi il modello. */
  const m1 = d.match(/^(?:Urbano|Interurbano)\s+(snodato\s*18\s*m|<7,5m|=7,5<9m|=9<11m|=11<15m)\s*-?\s*(.*)$/i);
  if (m1) return { ambito, classe: classeDa(m1[1]), modello: m1[2].trim() || null };

  /* «10m - Urbano normale (=9<11mt)», «E3 - Interurbano medio (=7,5<9mt)»,
   * «X30p - Interurbano 29+1 posti»: una categoria, non un modello. */
  const m2 = d.match(/^\S+\s+-\s+(?:Urbano|Interurbano)\s+(.*)$/i);
  if (m2) {
    const dentro = m2[1].match(/\((.*)\)/)?.[1];
    return { ambito, classe: dentro ? classeDa(dentro) : null, modello: null };
  }

  /* «IVECO Crossway»: solo il modello. */
  return { ambito, classe: classeDa(d), modello: d || null };
}

/* ── L'anagrafica ─────────────────────────────────────────────────────────── */

const ANAGRAFICA_FLASHNET = `
10	Urbano Snodato 18m - Solaris Trollino T18AC
11	Urbano Snodato 18m - Solaris Trollino T18AC
12	Urbano Snodato 18m - Solaris Trollino T18AC
13	Urbano =11<15m Ansaldo Breda F22
14	Urbano =11<15m Ansaldo Breda F22
15	Urbano =11<15m Ansaldo Breda F22
16	Urbano =11<15m Ansaldo Breda F22
17	Urbano =11<15m Ansaldo Breda F22
18	Urbano =11<15m Ansaldo Breda F22
218	Urbano =9<11m Vanhool A300 De Simon
227	Urbano =11<15m BredaMenarinibus M240 LU
228	Urbano =11<15m BredaMenarinibus M240 LU
229	Interurbano =7,5<9m CAM Ale T 154/3
243	Urbano =11<15m Irisbus 491 E12.29 Cityclass
244	Urbano =11<15m Irisbus 491 E12.29 Cityclass
245	Urbano =11<15m Irisbus 491 E12.29 Cityclass
246	Urbano =11<15m Irisbus 491 E12.29 Cityclass
248	Urbano =11<15m Irisbus 491 E12.29 Cityclass
249	Urbano =11<15m Irisbus 491 E12.29 Cityclass
250	Urbano =11<15m Irisbus 491 E12.29 Cityclass
251	Urbano =9<11m Irisbus 491 E10.24 Cityclass
252	Urbano =9<11m Irisbus 491 E10.24 Cityclass
253	Urbano =9<11m Irisbus 491 E10.24 Cityclass
254	Urbano =9<11m Irisbus 491 E10.24 Cityclass
255	Urbano =9<11m Irisbus 491 E10.24 Cityclass
256	Urbano =9<11m Irisbus 491 E10.24 Cityclass
257	Urbano =9<11m Irisbus 491 E10.24 Cityclass
258	Urbano =9<11m Irisbus 491 E10.24 Cityclass
259	Urbano =9<11m Irisbus 491 E10.24 Cityclass
260	Urbano =9<11m Irisbus 491 E10.24 Cityclass
261	Urbano =11<15m BredaMenarinibus M240 GNC
263	Urbano =11<15m BredaMenarinibus M240 GNC
264	Urbano =11<15m BredaMenarinibus M240 GNC
265	Urbano =11<15m BredaMenarinibus M240 GNC
266	Urbano =11<15m BredaMenarinibus M240 GNC
267	Urbano =11<15m BredaMenarinibus M240 GNC
268	Urbano =11<15m BredaMenarinibus M240 GNC
269	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
270	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
271	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
272	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
273	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
274	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
275	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
276	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
277	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
278	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
279	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
280	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
281	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
282	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
283	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
284	Urbano =11<15m Irisbus 491 E10.27 CNG Cityclass
285	Urbano snodato 18M Irisbus 491 E18.31 CNG
286	Urbano snodato 18M Irisbus 491 E18.31 CNG
287	Urbano snodato 18M Irisbus 491 E18.31 CNG
288	Urbano snodato 18M Irisbus 491 E18.31 CNG
289	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
290	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
291	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
292	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
293	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
294	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
295	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
296	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
297	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
298	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
299	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
300	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
400	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
401	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
402	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
403	Urbano =9<11m Irisbus Citelis 10M CNG PS09D5/80
404	Urbano =9<11m BredaMenarinibus M240 GNC NU
405	Urbano =7,5<9m Iveco 65C17/E4 Sitcar CT.14
406	Urbano =7,5<9m Iveco 65C17/E4 Sitcar CT.14
407	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
408	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
409	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
410	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
411	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
412	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
413	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
414	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
415	Urbano =11<15m Avancity Plus CNG JDV LU/3P 100
416	Urbano =11<15m Solaris Urbino 12m-W24
417	Urbano =11<15m Solaris Urbino 12m-W24
418	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
419	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
420	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
421	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
422	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
423	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
424	Urbano =9<11m Solaris Urbino 10m
425	Urbano =9<11m Solaris Urbino 10m
426	Urbano =9<11m Citymood 10 CNG
427	Urbano =9<11m Citymood 10 CNG
428	Urbano =9<11m Citymood 10 CNG
429	Urbano =9<11m Citymood 10 CNG
430	Urbano =9<11m Citymood 10 CNG
431	Urbano =9<11m Citymood 10 CNG
432	Urbano =9<11m Citymood 10 CNG
433	Urbano =11<15m Citymood 12 CNG
434	Urbano =11<15m Citymood 12 CNG
435	Urbano =11<15m Citymood 12 CNG
436	Urbano =11<15m Citymood 12 CNG
437	Urbano =11<15m Citymood 12 CNG
438	Urbano =11<15m Citymood 12 CNG
439	Urbano =11<15m Citymood 12 CNG
440	Urbano =11<15m Citymood 12 CNG
441	Urbano =11<15m Citymood 12 CNG
442	Urbano <7,5m Fiat Ducato City 21A
443	Urbano <7,5m Fiat Ducato City 21A
444	Urbano =11<15m Citymood 12 CNG CONSIP
445	Urbano =11<15m Citymood 12 CNG CONSIP
446	Urbano =11<15m Citymood 12 CNG CONSIP
447	Urbano =11<15m Citymood 12 CNG CONSIP
448	Urbano =11<15m Citymood 12 CNG CONSIP
449	Urbano =11<15m Citymood 12 CNG CONSIP
450	Urbano =7,5<9m Heuliez GX 127
451	Urbano =7,5<9m Heuliez GX 127
452	Urbano =7,5<9m Heuliez GX 127
453	Urbano =11<15m Irisbus Citelis 12M PS09D1/B/100
454	Urbano <7,5m Irisbus Citelis 12m PS09D1/B/100
455	12m - Urbano lungo (=11<12mt)
456	12m - Urbano lungo (=11<12mt)
457	12m - Urbano lungo (=11<12mt)
458	12m - Urbano lungo (=11<12mt)
459	10m - Urbano normale (=9<11mt)
460	10m - Urbano normale (=9<11mt)
461	10m - Urbano normale (=9<11mt)
462	10m - Urbano normale (=9<11mt)
463	10m - Urbano normale (=9<11mt)
464	10m - Urbano normale (=9<11mt)
465	10m - Urbano normale (=9<11mt)
466	10m - Urbano normale (=9<11mt)
611	Urbano =9<11m Irisbus 491 E10.24 CNG Cityclass
612	Urbano =9<11m Irisbus 491 E10.24 CNG Cityclass
613	Urbano =9<11m Irisbus 491 E10.24 CNG Cityclass
614	Urbano =9<11m Irisbus 491 E10.24 CNG Cityclass
615	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
618	Urbano <7,5m Iveco 50C11 CNG Sitcar Citytour
619	10m - Urbano normale (=9<11mt)
620	10m - Urbano normale (=9<11mt)
621	10m - Urbano normale (=9<11mt)
622	10m - Urbano normale (=9<11mt)
800	Urbano =7,5<9m Iveco City Tour
801	Urbano =7,5<9m Iveco City Tour
1228	Interurbano =11<15m - De Simon IL1E12 Scania
1229	Interurbano =11<15m - De Simon IL1E12 Scania
1231	Interurbano =11<15m - De Simon IL1E12 Scania
1234	Interurbano =11<15m De Simon IL3.311LC2 Scania
1236	Interurbano =11<15m De Simon IL3.311LC2 Scania
1237	Interurbano =11<15m De Simon IL3.311LC2 Scania
1239	Interurbano =11<15m De Simon IL3.311LC2 Scania
1243	Interurbano snodato 18m Evobus o530GNU/L Citaro
1246	Interurbano =7,5<9m Cacciamali TC1800/840
1247	Urbano =7,5<9m Irisbus 203 E9.27 CNG Europolis
1249	Urbano =7,5<9m Irisbus 203 E9.27 CNG Europolis
1250	Interurbano =11<15m Evobus MB O550U Integro
1251	Interurbano =11<15m Evobus MB O550U Integro
1252	Interurbano =11<15m Evobus MB O550U Integro
1253	Interurbano =11<15m Evobus MB O550U Integro
1254	Interurbano =11<15m Evobus MB O550U Integro
1255	Interurbano =11<15m Evobus MB O550U Integro
1257	Interurbano =11<15m Evobus MB O550U Integro
1261	Interurbano snodato 18m Setra SG 321 UL
1262	Interurbano snodato 18m Setra SG 321 UL
1263	Interurbano snodato 18m Setra SG 321 UL
1264	Interurbano snodato 18m Setra SG 321 UL
1265	Interurbano snodato 18m Setra SG 321 UL
1266	Interurbano snodato 18m Setra SG 321 UL
1272	Interurbano =11<15m Setra S 415 UL
1273	Interurbano =11<15m Setra S 415 UL
1274	Interurbano =11<15m Setra S 415 UL
1275	Interurbano =11<15m Setra S 415 UL
1277	Interurbano =11<15m Setra S 415 UL
1278	Interurbano =11<15m Setra S 415 UL
1279	Interurbano =11<15m Setra S 415 UL
1280	Interurbano snodato 18m Irisbus Citelis CNG
1281	Interurbano =11<15m Irisbus Agora CNG
1290	Interurbano snodato 18m Irisbus 491 E18.31 CNG
1293	Interurbano =11<15m Irisbus Citelis CNG
1294	Interurbano =11<15m Irisbus Citelis CNG
1296	Interurbano =7,5<9m Iveco 65C14 CNG Caccia. Thesi
1297	Interurbano =7,5<9m Iveco 65C14 CNG Caccia. Thesi
1300	Interurbano =11<15m Setra S 417 UL
1301	Interurbano =11<15m Setra S 417 UL
1311	Interurbano snodato 18m Vanhool C21
1313	Interurbano =11<15m Irisbus Crossway 12m EEV
1314	Interurbano =11<15m Irisbus Crossway 12m EEV
1315	Interurbano =11<15m Irisbus Crossway 12m EEV
1316	Interurbano =11<15m Irisbus Crossway 12m EEV
1317	Interurbano =11<15m Irisbus Crossway 12m EEV
1318	Interurbano =11<15m Irisbus Crossway 12m EEV
1319	Interurbano =11<15m Irisbus Crossway 12m EEV
1320	Interurbano =11<15m Irisbus Crossway 12m EEV
1321	Interurbano =11<15m Irisbus Crossway 12m EEV
1322	Interurbano =11<15m Irisbus Crossway 12m EEV
1323	Interurbano =11<15m Irisbus Crossway 12m EEV
1324	Interurbano =11<15m Irisbus Crossway 12m EEV
1325	Interurbano =11<15m Irisbus Crossway 12m EEV
1326	Interurbano =11<15m Irisbus Crossway 12m EEV
1327	Interurbano =11<15m Irisbus Crossway 12m EEV
1328	Interurbano =11<15m Irisbus Crossway 12m EEV
1329	Interurbano =11<15m Iveco France SFR160
1330	Interurbano snodato 18m Irisbus 491 E18.35/S/3P
1331	Interurbano =11<15m Man Lion's City C (NL363 A36)
1332	Interurbano =11<15m Man Lion's City C (NL363 A36)
1333	Interurbano =11<15m Man Lion's City C (NL363 A36)
1334	Interurbano =11<15m Man Lion's City C (NL363 A36)
1335	Interurbano snodato 18m Man NG313 A23
1336	Interurbano =7,5<9m Man A76
1337	Interurbano =7,5<9m Man A76
1338	Interurbano snodato 18m Man A23 Lions City G
1339	Interurbano snodato 18m Man A23 Lions City G
1340	Interurbano snodato 18m Man A23 Lions City G
1341	Interurbano =11<15m Iveco Crossway Low Entry
1342	Interurbano =11<15m Iveco Crossway Low Entry
1343	Interurbano =11<15m Iveco Crossway Low Entry
1344	Interurbano =11<15m Iveco Crossway Low Entry
1345	Interurbano =11<15m Iveco Crossway Low Entry
1346	Interurbano =11<15m Iveco Crossway Low Entry
1347	Interurbano =11<15m Iveco Crossway Low Entry
1348	Interurbano =11<15m Iveco Crossway Low Entry
1349	Interurbano =11<15m Iveco Crossway Low Entry
1350	Interurbano =11<15m Iveco Crossway Low Entry
1351	Interurbano =11<15m Iveco Crossway Low Entry
1352	Urbano =7,5<9m Solaris Urbino 8,9m
1353	Urbano =7,5<9m Solaris Urbino 8,9m
1354	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1355	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1356	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1357	Interurbano =7,5<9m Solaris Urbino 8,9m
1358	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1359	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1360	Interurbano =7,5<9m Heuliez GX 127
1361	Interurbano =11<15m Iveco Crossway Low Entry
1362	Interurbano snodato 18m Man A23 Lions City G
1363	Interurbano snodato 18m Man A23 Lions City G
1364	Interurbano snodato 18m Man A23 Lions City G
1365	10m - Urbano normale (=9<11mt)
1366	10m - Urbano normale (=9<11mt)
1367	10m - Urbano normale (=9<11mt)
1368	10m - Urbano normale (=9<11mt)
1369	10m - Urbano normale (=9<11mt)
1370	10m - Urbano normale (=9<11mt)
1371	X30p - Interurbano 29+1 posti
1372	X30p - Interurbano 29+1 posti
1373	Interurbano =11<15m Iveco Crossway
1374	Interurbano =11<15m Iveco Crossway
1375	Interurbano =11<15m Iveco Crossway
1376	Interurbano =11<15m Iveco Crossway
1377	Interurbano =11<15m Iveco Crossway
1378	Interurbano =11<15m Iveco Crossway
1379	IVECO Crossway
1380	IVECO Crossway
1381	IVECO Crossway
1382	IVECO Crossway
1383	IVECO Crossway
1384	IVECO Crossway
1385	IVECO Crossway
1386	IVECO Crossway
1387	IVECO Crossway
1388	IVECO Crossway
1389	IVECO Crossway
1390	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1391	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1392	Interurbano =11<15m Iveco Crossway Low Entry 3assi
1393	10m - Urbano normale (=9<11mt)
1394	10m - Urbano normale (=9<11mt)
1395	10m - Urbano normale (=9<11mt)
1396	10m - Urbano normale (=9<11mt)
1397	10m - Urbano normale (=9<11mt)
1398	10m - Urbano normale (=9<11mt)
1399	10m - Urbano normale (=9<11mt)
1400	10m - Urbano normale (=9<11mt)
AF002	10m - Urbano normale (=9<11mt)
AF003	10m - Urbano normale (=9<11mt)
AF006	10m - Urbano normale (=9<11mt)
BU002	Interurbano =11<15m Setra S 315 UL
BU012	Interurbano snodato 18m Setra SG 321 UL
BU025	Interurbano =11<15m Setra S 315 UL
BU027	Interurbano =11<15m Setra S 315 UL
BU029	Interurbano =11<15m Setra S 315 UL
BU031	Interurbano =11<15m Setra S 315 UL
BU042	Interurbano =11<15m Setra S 315 UL
BU043	Interurbano =11<15m Setra S 315 UL
BU044	Interurbano =11<15m Setra S 315 UL
BU045	Interurbano =11<15m Setra S 315 UL
BU046	Interurbano snodato 18m Setra SG 321 UL
BU048	Interurbano snodato 18m Setra SG 321 UL
BU052	Interurbano =11<15m Setra S 415 UL
BU053	Interurbano =11<15m Setra S 415 UL
BU054	Interurbano =11<15m Setra S 415 UL
BU055	Interurbano =11<15m Iveco Citelys
BU056	Interurbano =11<15m Iveco Citelys
BU057	Interurbano =11<15m Setra S 417 UL
BU058	Interurbano =11<15m Setra S 417 UL
BU059	Interurbano =7,5<9m Iveco Indcar
BU060	Interurbano =11<15m Setra S 417 UL
BU061	Interurbano =11<15m Setra S 417 UL
BU062	Interurbano =7,5<9m Iveco Indcar
BU063	Urbano =7,5<9m Iveco City Tour
BU064	Interurbano =7,5<9m Iveco A65/C
BU065	Interurbano =11<15m Setra S 415 UL
BU066	Interurbano =11<15m Setra S 417 UL
BU067	Interurbano =11<15m Setra S 417 UL
BU068	Interurbano =11<15m Setra S 417 UL
BU069	Interurbano =11<15m Setra S 415 UL
BU070	Interurbano =11<15m Setra S 415 UL
BU071	Interurbano =11<15m Setra S 415 UL
BU072	Interurbano =11<15m Setra S 415 UL
BU073	Interurbano =11<15m Setra S 415 UL
BU074	Interurbano =11<15m Iveco Crossway
BV023	Interurbano =11<15m Setra S 415 UL
BV031	Interurbano =11<15m Setra S 415 UL
BV034	Interurbano =11<15m Setra S 415 UL
BV040	Interurbano =11<15m Setra S 415 UL
CJ012	Interurbano =11<15m Noge Touring HD
CJ016	Interurbano <7,5m Iveco Daily A50CT-19
CJ061	Interurbano snodato 18m Evobus SG320 UL
CJ062	Interurbano snodato 18m Evobus SG320 UL
CJ063	Interurbano =11<15m Setra S 317 UL
CJ064	Interurbano =11<15m Setra S 417 UL
CJ065	Interurbano =11<15m Setra S 415 UL
CJ066	Interurbano =11<15m Setra S 417 UL
CJ067	Interurbano =11<15m Iveco France SFR160
CJ086	Interurbano snodato 18m Evobus o530GNU/L Citaro
CJ096	Interurbano =11<15m Iveco Crossway
CJ103	Interurbano =11<15m Iveco Crossway
CJ104	Interurbano =11<15m Iveco Crossway Low Entry
CJ105	Interurbano =11<15m Iveco Crossway
CJ106	Interurbano =11<15m Iveco Crossway
CJ107	Interurbano =11<15m Iveco Crossway
CJ108	Interurbano =11<15m Iveco Crossway
RE145	Interurbano =11<15m Setra S 315 UL
RE152	Interurbano =11<15m Setra S 415 UL
RE155	Interurbano =11<15m Setra S 415 UL
RE156	Interurbano =11<15m Setra S 415 UL
RE157	Interurbano =11<15m Setra S 415 UL
RE159	Interurbano =11<15m Setra 633 04
RE160	Interurbano =11<15m Setra 633 04
RE161	Interurbano =11<15m Setra S 415 UL
RE162	Interurbano =11<15m Iveco Crossway
RE163	Interurbano =11<15m Iveco Crossway
SA001	Interurbano =11<15m Setra S 418 LE
SA002	Interurbano =11<15m Setra S 416 LE
SA003	Interurbano =11<15m Setra S 418 LE
SA004	Interurbano =11<15m Setra S 418 LE
SA005	Interurbano =11<15m Setra S 315 UL
SA006	Interurbano =11<15m Setra S 419 UL
SA007	Interurbano =11<15m Setra S 417 UL
SA008	Interurbano =11<15m Setra S 417 UL
SA009	Interurbano =11<15m Setra S 417 UL
SA010	Interurbano =11<15m Setra S 416 LE
SA011	Interurbano =11<15m Setra S 416 LE
SA012	Interurbano =11<15m Setra S 415 UL
SA013	Interurbano =11<15m Setra S 418 LE
SA015	Interurbano =7,5<9m Iveco 65/E4 Wing
SA016	Interurbano =11<15m Setra S 417 UL
SAP051	E3 - Interurbano medio (=7,5<9mt)
SAP052	10m - Urbano normale (=9<11mt)
SAP053	10m - Urbano normale (=9<11mt)
SAP062	E4 - Interurbano corto (<7,5mt)
`;

interface VoceAnagrafica { codice: string; descrizione: string }

const ANAGRAFICA: ReadonlyMap<string, VoceAnagrafica> = new Map(
  ANAGRAFICA_FLASHNET.split("\n")
    .map(r => r.trim()).filter(Boolean)
    .map(r => {
      const [codice, ...resto] = r.split("\t");
      return [codice.toUpperCase(), { codice: codice.toUpperCase(), descrizione: resto.join(" ").trim() }] as const;
    }),
);

/** Tutte le voci dell'anagrafica, nell'ordine dell'export. */
export function anagraficaParco(): VoceAnagrafica[] {
  return [...ANAGRAFICA.values()];
}

/** La scheda del mezzo a partire dalla matricola SIRI; `null` se non è in anagrafica. */
export function schedaVettura(siriRef: string): SchedaVettura | null {
  const codice = codiceDaSiri(siriRef);
  if (!codice) return null;
  const voce = ANAGRAFICA.get(codice);
  if (!voce) return null;
  return {
    siriRef: siriRef.trim(),
    codice,
    azienda: aziendaDaSiri(siriRef) ?? "?",
    descrizione: voce.descrizione,
    ...interpretaDescrizione(voce.descrizione),
  };
}

/** I tre campi che le pagine mostrano accanto alla matricola. */
export interface IdentitaVettura {
  /** codice FlashNet, o null se il prefisso SIRI non è ancora abbinato */
  codice: string | null;
  /** "Conerobus", sigla della consorziata, o la spiegazione di perché non si sa */
  azienda: string;
  /** descrizione FlashNet del mezzo, o null se la vettura non è in anagrafica */
  mezzo: string | null;
}

export function identitaVettura(siriRef: string): IdentitaVettura {
  const s = schedaVettura(siriRef);
  return {
    codice: s?.codice ?? codiceDaSiri(siriRef),
    azienda: etichettaAzienda(siriRef),
    mezzo: s?.descrizione ?? null,
  };
}
