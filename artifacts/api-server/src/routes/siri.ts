/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SIRI — configurazione, diagnostica e ingestione manuale
 * ───────────────────────────────────────────────────────────────────────────
 * Il collegamento a un AVM esterno si rompe quasi sempre sulle stesse tre
 * cose: rete che non passa, credenziali, e codifiche che non combaciano.
 * Questi endpoint servono a vederle SEPARATAMENTE, prima di scrivere un solo
 * record nel database:
 *
 *   GET  /api/siri/status   — la configurazione è completa? il servizio
 *                             risponde? che cosa permette (filtri, cicli)?
 *   GET  /api/siri/preview  — una richiesta vera, MA SENZA SCRIVERE NULLA:
 *                             quanti mezzi arrivano, quanti agganciano il
 *                             GTFS, e quali riferimenti restano orfani.
 *   POST /api/siri/sync     — un giro di ingestione su richiesta.
 *
 * L'anteprima è il pezzo che conta: dice subito se i riferimenti dell'AVM
 * corrispondono agli id del feed o se serve una tabella di corrispondenza,
 * senza sporcare le tabelle di esercizio con dati mal agganciati.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  buildCheckStatusRequest, buildGetCapabilitiesRequest, postSoap,
  parseCapabilities, parseXml, textOf, findFirst, fetchVehicleMonitoring,
  mapVehicles, describeCompleteness, mostInformative, extractSampleActivity,
  splitInService, MAX_GAP_SEC, effectivePollSeconds, inventoryFields,
  statoParco, diagnosiVettura, type StatoVettura,
  type SiriEndpointConfig, type VehicleCompleteness, type MappingReport,
  type TransitFunnel,
} from "../lib/siri-vm";
import { loadGtfsIndex, ingestVehicles, closeCancelled, auditAgganci } from "../lib/siri-ingest";
import { getLatestFeedId } from "./gtfs-helpers";
import { ensureCaronteSchema, schemaState, tableShape, hasSourceColumn, SOURCE_SIRI } from "../lib/caronte-schema";
import { andamentoParco, giornateDelPeriodo } from "../lib/fleet-trend";
import { validitaFeed, oggiYmd } from "../lib/feed-validity";
import { leggiCodici, erroreRaccolta } from "../lib/journey-codes-store";
import { studiaCodici } from "../lib/journey-code-study";
import { inizioGiornata } from "../lib/service-day";

const router: IRouter = Router();

/** Configurazione da ambiente. Assente = connettore spento, non un errore. */
export function siriConfig(): SiriEndpointConfig | null {
  const url = process.env.SIRI_VM_URL;
  if (!url) return null;
  return {
    url,
    requestorRef: process.env.SIRI_REQUESTOR_REF || "TransitIntel",
    soapAction: process.env.SIRI_SOAP_ACTION || undefined,
    username: process.env.SIRI_USERNAME || null,
    password: process.env.SIRI_PASSWORD || null,
    timeoutMs: Number(process.env.SIRI_TIMEOUT_MS) || 20_000,
  };
}
/**
 * L'intervallo di poll richiesto e quello davvero applicato.
 *
 * Sopra MAX_GAP_SEC il rilevamento dei transiti è impossibile per costruzione:
 * il connettore non diventa lento, diventa muto. Il valore viene quindi
 * riportato entro un limite utile: la regola sta in effectivePollSeconds(),
 * dove si collauda senza avviare il server.
 */
export function siriPoll(): { richiesto: number; effettivo: number; ridotto: boolean } {
  const richiesto = Number(process.env.SIRI_POLL_SECONDS) || 30;
  const effettivo = effectivePollSeconds(richiesto);
  return { richiesto, effettivo, ridotto: effettivo !== richiesto };
}

export function siriDetailLevel(): "minimum" | "basic" | "normal" | "calls" | "full" {
  const v = (process.env.SIRI_DETAIL_LEVEL || "calls").toLowerCase();
  return (["minimum", "basic", "normal", "calls", "full"] as const).includes(v as any)
    ? (v as any) : "calls";
}

/* Esito dell'ultimo giro di ingestione, per poterlo leggere da /siri/status
 * senza che una GET scriva nulla. */
let ultimoGiro: {
  funnel: TransitFunnel;
  nota: string;
  at: string;
  /* Se le scritture falliscono l'imbuto da solo non basta: mostrerebbe una
   * catena sana fino all'ultimo anello senza dire che l'INSERT è morto. */
  mezziNonSalvati: number;
  primoErrore: string | null;
  corseFallite: number;
  erroreCorse: string | null;
  posizioniInserite: number;
  corseAperte: number;
  /* Chiuse perché il mezzo ha smesso di trasmettere: senza questo numero, un
   * calo improvviso delle corse aperte sembrerebbe un guasto. */
  corseAbbandonate: number;
} | null = null;

/* I nomi che legge chi apre la pagina: "senza_rete" è una chiave, non una
 * parola. E le due cause vanno nominate per il reparto che le ripara. */
const ETICHETTE_STATO: Record<StatoVettura, string> = {
  in_servizio: "In servizio",
  pronta: "Pronta, nessuna corsa avviata",
  in_rimessa: "In rimessa",
  senza_rete: "Non comunica — SIM o copertura",
  senza_gps: "Senza posizione — antenna GPS",
  muta: "Nessun segnale da oltre un giorno",
};

const NOT_CONFIGURED = {
  configured: false,
  hint: "Imposta SIRI_VM_URL (e SIRI_REQUESTOR_REF, se il produttore assegna un codice consumatore) "
    + "per attivare il connettore. Facoltative: SIRI_USERNAME/SIRI_PASSWORD, SIRI_SOAP_ACTION, "
    + "SIRI_DETAIL_LEVEL (default 'calls': senza, l'AVM non manda i transiti alle fermate), "
    + "SIRI_POLL_SECONDS (default 30).",
};

/* ── Stato del collegamento ───────────────────────────────────────────────── */

router.get("/siri/status", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  const out: any = {
    configured: true,
    url: cfg.url,
    requestorRef: cfg.requestorRef,
    authentication: cfg.username ? "basic" : "nessuna",
    detailLevel: siriDetailLevel(),
    pollSeconds: siriPoll().effettivo,
    pollNota: siriPoll().ridotto
      ? `SIRI_POLL_SECONDS=${siriPoll().richiesto} renderebbe impossibile rilevare i `
        + `transiti alle fermate (servono al massimo ${MAX_GAP_SEC}s fra due letture): `
        + `l'intervallo è stato riportato a ${siriPoll().effettivo}s. Imposta `
        + "SIRI_POLL_SECONDS=60 per togliere questo avviso."
      : undefined,
  };

  try {
    const chk = await postSoap(cfg, "CheckStatus", buildCheckStatusRequest(cfg.requestorRef));
    const doc = parseXml(chk.xml);
    const fault = findFirst(doc, "Fault");
    out.checkStatus = {
      httpStatus: chk.status,
      alive: !fault && (textOf(doc, "Status") ?? "").toLowerCase() !== "false",
      serviceStartedTime: textOf(doc, "ServiceStartedTime"),
      fault: fault ? (textOf(fault, "faultstring") ?? "SOAP Fault") : null,
    };
  } catch (e: any) {
    out.checkStatus = { alive: false, error: e?.message ?? "irraggiungibile" };
  }

  try {
    const cap = await postSoap(cfg, "GetCapabilities", buildGetCapabilitiesRequest(cfg.requestorRef));
    out.capabilities = parseCapabilities(cap.xml);
    /* Il dettaglio "calls" è ciò che porta i transiti alle fermate: senza,
     * si possono alimentare solo posizioni e corse attive. Attenzione a non
     * scambiare "non dichiarato" per "disponibile": se il produttore non
     * risponde a GetCapabilities restano tutti null, e l'unica prova di che
     * cosa manda davvero è il conteggio nell'anteprima. */
    const known = Object.values(out.capabilities).some(v => v !== null && v !== undefined);
    out.capabilities.notaTransiti = !known
      ? "Il produttore non ha risposto a GetCapabilities (o in una forma non riconosciuta): "
        + "non dichiara nulla. Guarda 'completezza' in /api/siri/preview per sapere che cosa manda davvero."
      : out.capabilities.hasPreviousCalls === false
        ? "Il produttore dichiara di NON fornire le fermate già transitate: puntualità e tempi di percorrenza resteranno senza dati."
        : "Fermate transitate dichiarate disponibili.";
    if (req.query.raw === "1") out.capabilities.xmlGrezzo = cap.xml.slice(0, 4000);
  } catch (e: any) {
    out.capabilities = { error: e?.message ?? "non disponibili" };
  }

  /* Lo stato dell'esercizio va detto qui: è la prima pagina che si guarda. */
  const schema = await schemaState();
  const mancanti = [...schema.missingTables, ...schema.missingColumns];
  out.schemaCaronte = {
    pronto: schema.ready,
    statoIgnoto: schema.unknown || undefined,
    mancanti: mancanti.length > 0 ? mancanti : undefined,
    errore: schema.error ?? undefined,
    nota: schema.ready
      ? undefined
      : "Le tabelle dell'esercizio non sono allineate: le scritture del connettore "
        + "falliscono e Sala Operativa risponde 500. Serve applicare le migrazioni "
        + "in migrations/, oppure dare al ruolo del database il permesso di CREATE/ALTER.",
  };

  /* La struttura VERA delle tabelle, su richiesta. `schemaCaronte.pronto` dice
   * solo che non manca nulla di ciò che ci aspettiamo — ma una tabella creata
   * dal sistema AVM può avere colonne IN PIÙ, obbligatorie e senza valore
   * predefinito: il nostro INSERT, che non le elenca, viene rifiutato mentre
   * lo schema risulta "a posto". Senza vederla, quella causa resta invisibile. */
  if (req.query.tabelle === "1") {
    out.strutturaTabelle = {
      vehicle_positions: await tableShape("vehicle_positions"),
      active_trips: await tableShape("active_trips"),
      stop_transits: await tableShape("stop_transits"),
      nota: "Una colonna con obbligatoria=true e predefinito=null, che il "
        + "connettore non scrive, fa rifiutare ogni INSERT.",
    };
  }

  /* "Sta registrando?" è la domanda che si fa guardando la mappa, e finora
   * l'unico modo di rispondere era contare i puntini. Questi sono i numeri
   * veri delle tabelle di esercizio, in sola lettura. */
  try {
    /* Le righe del connettore vanno contate SEPARATAMENTE da quelle scritte
     * dall'AVM, che usa le stesse tabelle. Un totale unico è ingannevole nel
     * modo peggiore: "194 transiti oggi" sembrava dire che il collegamento
     * funzionava, mentre erano tutte righe dell'AVM e SIRI non ne aveva mai
     * scritta una. `device_id = 'siri'` è ciò che marca le nostre. */
    const r = await db.execute<any>(sql`
      SELECT (SELECT count(*)::int FROM caronte.vehicle_positions
               WHERE ts > now() - interval '1 hour')                       AS pos_ora,
             (SELECT max(ts) FROM caronte.vehicle_positions)               AS ultima_posizione,
             (SELECT count(*)::int FROM caronte.active_trips
               WHERE ended_at IS NULL)                                     AS corse_aperte,
             (SELECT count(*)::int FROM caronte.active_trips
               WHERE ended_at IS NULL AND device_id = 'siri')              AS corse_aperte_siri,
             (SELECT max(started_at) FROM caronte.active_trips
               WHERE device_id = 'siri')                                   AS ultima_corsa_siri,
             (SELECT count(*)::int FROM caronte.stop_transits
               WHERE actual_ts >= ${inizioGiornata()})                      AS transiti_oggi,
             (SELECT count(*)::int FROM caronte.stop_transits
               WHERE actual_ts >= ${inizioGiornata()}
                 AND device_id = 'siri')                                   AS transiti_oggi_siri,
             (SELECT max(actual_ts) FROM caronte.stop_transits)            AS ultimo_transito,
             (SELECT max(actual_ts) FROM caronte.stop_transits
               WHERE device_id = 'siri')                                   AS ultimo_transito_siri`);
    const x = (r as any).rows?.[0] ?? {};
    const posOra = Number(x.pos_ora ?? 0);
    const transitiSiri = Number(x.transiti_oggi_siri ?? 0);
    const transitiTot = Number(x.transiti_oggi ?? 0);
    out.esercizio = {
      posizioniUltimaOra: posOra,
      ultimaPosizione: x.ultima_posizione ?? null,
      corseAperte: Number(x.corse_aperte ?? 0),
      corseAperteDaSiri: Number(x.corse_aperte_siri ?? 0),
      ultimaCorsaApertaDaSiri: x.ultima_corsa_siri ?? null,
      transitiOggi: transitiTot,
      transitiOggiDaSiri: transitiSiri,
      ultimoTransito: x.ultimo_transito ?? null,
      ultimoTransitoDaSiri: x.ultimo_transito_siri ?? null,
      nota: posOra === 0
        ? "Nessuna posizione nell'ultima ora: il poller non sta scrivendo. Guarda 'schemaCaronte' e i log."
        : transitiSiri === 0
          ? (transitiTot > 0
            ? `Attenzione: i ${transitiTot} transiti di oggi NON sono del connettore SIRI `
              + "(nessuno con device_id='siri'): li ha scritti l'AVM sulle stesse tabelle. "
              + "Il connettore non ne ha ancora registrato nessuno — guarda 'acquisizioneTransiti'."
            : "Posizioni sì, transiti no: guarda 'acquisizioneTransiti', dice a quale "
              + "anello della catena si è interrotta l'acquisizione.")
          : undefined,
    };
  } catch (e: any) {
    out.esercizio = { errore: e?.message ?? "non leggibile" };
  }

  /* L'imbuto è calcolato durante l'ingestione, che SCRIVE e quindi vive su
   * un POST. Ma la domanda "perché non arrivano transiti?" si fa aprendo lo
   * stato in un browser: tenendo da parte l'esito dell'ultimo giro la si può
   * rispondere qui, senza far scrivere una GET. */
  out.acquisizioneTransiti = ultimoGiro
    ? {
      ...ultimoGiro.funnel,
      diagnosi: ultimoGiro.mezziNonSalvati > 0
        /* Un errore di scrittura ha la precedenza su qualunque altra lettura
         * dell'imbuto: i contatori a valle sarebbero conseguenza sua. */
        ? `${ultimoGiro.mezziNonSalvati} mezzi non salvati nell'ultimo giro. `
          + `Primo errore: ${ultimoGiro.primoErrore ?? "n/d"}`
        : ultimoGiro.nota,
      alle: ultimoGiro.at,
      ultimoGiro: {
        mezziNonSalvati: ultimoGiro.mezziNonSalvati,
        primoErrore: ultimoGiro.primoErrore ?? undefined,
        corseNonAperte: ultimoGiro.corseFallite || undefined,
        erroreCorse: ultimoGiro.erroreCorse ?? undefined,
        posizioniInserite: ultimoGiro.posizioniInserite,
        corseAperte: ultimoGiro.corseAperte,
      },
    }
    : {
      diagnosi: "Il poller non ha ancora completato un giro da quando il "
        + "servizio è stato riavviato: riprova fra un intervallo di polling.",
    };

  const index = await loadGtfsIndex();
  out.feedGtfs = index
    ? {
        feedId: index.feedId,
        corse: index.trips.size, linee: index.routes.size, fermate: index.stops.size,
        /* Da dove viene questo feed: un id da solo non distingue "scelto
         * apposta" da "capitato", e sono due situazioni molto diverse. */
        scelta: await feedScelto(index.feedId, req),
      }
    : {
        error: "nessun feed GTFS attivo: senza, i riferimenti dell'AVM non sono agganciabili",
        scelta: await feedScelto(null, req),
      };

  res.json(out);
});

/* ── Quale orario stiamo usando, e perché quello ─────────────────────────
 * Il connettore NON riceve il feed: se lo sceglie. Con `GTFS_FEED_ID`
 * impostata usa quello e basta; senza, prende il feed attivo caricato più di
 * recente. Vuol dire che un caricamento fatto da chiunque, o la
 * materializzazione di un altro progetto, può spostare il confronto sotto i
 * piedi all'esercizio — al massimo dieci minuti dopo, quando l'indice scade.
 *
 * Lo stato mostrava l'id del feed ma non COME ci fosse arrivato: un id da solo
 * non distingue "questo è quello giusto, fissato apposta" da "è capitato".
 */
async function feedScelto(feedId: string | null, req?: any): Promise<any> {
  const fissato = !!process.env.GTFS_FEED_ID;
  if (!feedId) {
    return {
      origine: fissato ? "fissato" : "automatico",
      nota: "Nessun feed GTFS raggiungibile: senza orario i riferimenti "
        + "dell'AVM non sono agganciabili a nulla.",
    };
  }
  try {
    const r = await db.execute<any>(sql`
      SELECT filename, agency_name, uploaded_at, feed_start_date, feed_end_date,
             to_jsonb(f) ->> 'is_active'   AS is_active,
             to_jsonb(f) ->> 'archived_at' AS archived_at
        FROM gtfs_feeds f WHERE id = ${feedId}::uuid LIMIT 1`);
    const f = (r as any).rows?.[0] ?? {};

    /* Quanti altri potrebbero essere scelti al posto suo: se sono più d'uno e
     * nessuno è fissato, la scelta di domani non è garantita uguale a oggi. */
    let candidati: number | null = null;
    /* IL RISCHIO PEGGIORE, e non si vedeva da nessuna parte. L'ingestione
     * risolve il feed SENZA utente (è un processo di fondo, non ha una
     * sessione); le pagine lo risolvono CON l'utente, e il filtro per tenant
     * può portarle su un feed diverso. Quando succede, il connettore scrive
     * i passaggi con gli identificativi di corsa del feed A mentre la pagina
     * li cerca nel feed B: le tabelle si riempiono e le pagine restano vuote,
     * senza un solo errore da nessuna parte.
     *
     * Con GTFS_FEED_ID impostata entrambi i percorsi la usano e il problema
     * non esiste. Senza, va almeno detto. */
    let feedDellePagine: string | null = null;
    if (!fissato) {
      try {
        const c = await db.execute<any>(sql`
          SELECT COUNT(*)::int AS n FROM gtfs_feeds
           WHERE to_jsonb(gtfs_feeds) ->> 'archived_at' IS NULL`);
        candidati = Number((c as any).rows?.[0]?.n ?? 0);
      } catch { /* colonna assente su database vecchi */ }
      try { feedDellePagine = await getLatestFeedId(req); } catch { /* ignoto */ }
    }

    /* Il calendario del feed copre oggi? È la stessa verifica che blocca il
     * calcolo della copertura, e qui arriva prima: un feed il cui calendario
     * è scaduto aggancia le corse su TUTTE le validità insieme. */
    let calendario: any = null;
    try {
      const cal = await db.execute<any>(sql`
        SELECT COUNT(*)::int AS righe, MIN(start_date) AS dal, MAX(end_date) AS al,
               COUNT(*) FILTER (
                 WHERE start_date <= to_char(now(), 'YYYYMMDD')
                   AND end_date   >= to_char(now(), 'YYYYMMDD'))::int AS oggi
          FROM gtfs_calendar WHERE feed_id = ${feedId}::uuid`);
      const x = (cal as any).rows?.[0] ?? {};
      calendario = {
        righe: Number(x.righe ?? 0), dal: x.dal ?? null, al: x.al ?? null,
        copreOggi: Number(x.oggi ?? 0) > 0,
      };
    } catch { /* Planning Studio non installato */ }

    const pezzi: string[] = [
      fissato
        ? "Feed FISSATO da GTFS_FEED_ID: non cambia finché non cambi la variabile."
        : "Feed scelto automaticamente: il più recente fra quelli attivi."
          + (candidati != null && candidati > 1
            ? ` Ce ne sono ${candidati} non archiviati, quindi un caricamento nuovo `
              + "o la materializzazione di un altro progetto lo sposterebbero da soli. "
              + "Per bloccarlo, imposta GTFS_FEED_ID."
            : ""),
    ];
    if (feedDellePagine && feedDellePagine !== feedId) {
      pezzi.push("ATTENZIONE GRAVE: le pagine di esercizio risolvono un feed "
        + `DIVERSO (${feedDellePagine}). Il connettore scrive i passaggi con gli `
        + "identificativi di corsa di questo feed, ma le pagine li cercano "
        + "nell'altro: le tabelle si riempiono e le pagine restano vuote. "
        + "Imposta GTFS_FEED_ID per far usare lo stesso feed a entrambi.");
    }
    /* FUTURO e SCADUTO non sono la stessa cosa: il primo è un orario caricato
     * in anticipo, cioè buona pratica, e dirgli di rimaterializzare sarebbe
     * mandarlo a rifare una cosa giusta. */
    if (calendario) {
      const v = validitaFeed(calendario.righe, calendario.dal, calendario.al,
        oggiYmd(), f.is_active === "true");
      calendario.stato = v.stato;
      calendario.fraGiorni = v.fraGiorni;
      if (v.stato !== "corrente") pezzi.push(v.nota);
    }

    return {
      origine: fissato ? "fissato" : "automatico",
      nome: f.filename ?? null,
      azienda: f.agency_name ?? null,
      caricatoIl: f.uploaded_at ?? null,
      validoDal: f.feed_start_date ?? null,
      validoAl: f.feed_end_date ?? null,
      attivo: f.is_active === "true" ? true : f.is_active === "false" ? false : null,
      archiviato: f.archived_at != null,
      candidati,
      calendario,
      nota: pezzi.join(" "),
    };
  } catch (e: any) {
    return { origine: fissato ? "fissato" : "automatico",
             nota: `Dati del feed non leggibili: ${e?.message ?? e}` };
  }
}

/* ── Lettura in chiaro di che cosa è alimentabile ─────────────────────────
 * Tre livelli distinti, perché falliscono per ragioni diverse: la mappa live
 * vuole solo la posizione; le corse attive vogliono il riferimento di corsa;
 * puntualità e tempi di percorrenza vogliono gli orari EFFETTIVI alle
 * fermate. Un flusso può bastare al primo e non al terzo. */
function diagnose(c: VehicleCompleteness, m?: MappingReport): string[] {
  const out: string[] = [];

  if (c.conPosizione === 0) {
    out.push("Nessun mezzo con posizione: non è alimentabile nemmeno la mappa live.");
  } else {
    out.push(`Mappa live alimentabile: ${c.conPosizione} mezzi su ${c.totale} con posizione.`);
  }

  if (c.conCorsa === 0) {
    out.push("L'AVM NON manda il riferimento di corsa (DatedVehicleJourneyRef) per nessun mezzo: "
      + "le corse in servizio non sono ricostruibili e i transiti non sono attribuibili a una corsa. "
      + "È il blocco principale.");
  } else if (m && m.tripMatched === 0) {
    out.push(`Riferimenti di corsa presenti su ${c.conCorsa} mezzi ma NESSUNO aggancia il feed, `
      + "né per identificativo né per linea+ora di partenza: senza corsa i transiti non "
      + "sono attribuibili.");
  } else if (m) {
    const modi: string[] = [];
    if (m.tripMatchedById) modi.push(`${m.tripMatchedById} per identificativo`);
    if (m.tripMatchedBySchedule) modi.push(`${m.tripMatchedBySchedule} per linea+ora di partenza`);
    out.push(`Corse agganciate: ${m.tripMatched} su ${c.conCorsa}`
      + (modi.length ? ` (${modi.join(", ")})` : "")
      + (m.tripAmbiguous ? ` — ${m.tripAmbiguous} ambigue: più corse partono a quell'ora sulla stessa linea.` : "."));
  }

  if (c.conOrarioEffettivo === 0) {
    out.push("Nessun orario EFFETTIVO alle fermate (né PreviousCalls né ActualArrival/Departure): "
      + "puntualità e tempi di percorrenza restano senza dati. "
      + (c.conFermataCorrente > 0
        ? "La fermata corrente però arriva: il produttore manda la posizione nel percorso, non la storia dei transiti."
        : "Non arriva nemmeno la fermata corrente."));
  } else {
    out.push(`Transiti reali disponibili su ${c.conOrarioEffettivo} mezzi: `
      + "puntualità e tempi di percorrenza alimentabili.");
  }

  if (c.conLinea > 0 && m && m.routeMatched < c.conLinea) {
    out.push(`Linee: ${m.routeMatched} agganciate su ${c.conLinea} dichiarate `
      + "— il resto usa una numerazione diversa da quella del feed.");
  }
  if (c.conRitardo > 0) out.push(`Ritardo dichiarato dall'AVM su ${c.conRitardo} mezzi.`);
  if (c.conTurnoVettura > 0) out.push(`Turno vettura (BlockRef) su ${c.conTurnoVettura} mezzi.`);

  /* Perché in Sala Operativa compaiono autobus senza numero di linea. Non è
   * un difetto del collegamento: l'AVM manda tutto il parco, e distingue da
   * sé che cosa sta seguendo. Le tre classi vanno lette insieme, altrimenti
   * un mezzo fermo in deposito e uno in servizio senza turno impostato
   * sembrano lo stesso guasto. */
  const fermi = c.totale - c.monitorati;
  const senzaTurno = Math.max(0, c.monitorati - c.conCorsa);
  if (c.monitorati < c.totale) {
    out.push(`Parco: ${c.totale} vetture trasmesse, ${c.monitorati} monitorate dall'AVM. `
      + `Le altre ${fermi} non sono in esercizio (deposito, rientro) e NON vengono `
      + "registrate: portarle in Sala Operativa vorrebbe dire riempire la mappa di "
      + "autobus anonimi.");
  }
  if (senzaTurno > 0) {
    out.push(`Mezzi seguiti dall'AVM ma SENZA corsa dichiarata: ${senzaTurno}. `
      + "Sono le vetture che in mappa restano senza numero di linea: l'AVM le "
      + "localizza, ma nessun turno macchina è stato impostato a bordo, quindi non "
      + "c'è una corsa a cui attribuire orari e ritardo. È un dato di esercizio "
      + "(turni non avviati), non un difetto del collegamento.");
  }
  if (c.fuoriLinea > 0) {
    out.push(`${c.fuoriLinea} mezzi dichiarati FUORI LINEA: si spostano senza servizio, `
      + "quindi non vengono cercati nell'orario.");
  }

  return out;
}

/* ── Anteprima: legge, non scrive ─────────────────────────────────────────── */

router.get("/siri/preview", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  try {
    const lineRef = (req.query.lineRef as string | undefined)?.trim() || null;
    const maximumVehicles = Number(req.query.max) || null;
    const result = await fetchVehicleMonitoring(cfg, {
      detailLevel: siriDetailLevel(), lineRef, maximumVehicles,
    });

    const index = await loadGtfsIndex();
    /* L'anteprima ragiona sugli stessi mezzi che l'ingestione scriverebbe:
     * misurare gli agganci sull'intero parco farebbe sembrare disastroso un
     * risultato che sui mezzi in servizio è buono. */
    const split = splitInService(result.vehicles);
    const mapping = index ? mapVehicles(split.inServizio, index) : null;
    const completezza = describeCompleteness(result.vehicles);

    /* Il campione va preso sui mezzi IN SERVIZIO: prendendo i primi si
     * finisce sulle vetture in deposito, che non hanno corsa né fermate, e
     * si conclude erroneamente che l'AVM non mandi nulla. */
    const campione = mostInformative(result.vehicles, 5).map(v => ({
      mezzo: v.vehicleRef,
      linea: v.lineRef,
      lineaPubblicata: v.publishedLineName,
      corsa: v.journeyRef,
      corsaDa: v.datedVehicleJourneyRef ? "FramedVehicleJourneyRef" : v.courseOfJourneyRef ? "CourseOfJourneyRef" : null,
      percorso: v.routeRef,
      dataServizio: v.dataFrameRef,
      partenzaProgrammata: v.originAimedDeparture,
      arrivoProgrammato: v.destinationAimedArrival,
      destinazione: v.destinationName,
      posizione: v.lat != null ? [v.lat, v.lon] : null,
      ritardoSec: v.delaySeconds,
      turnoVettura: v.blockRef,
      inCoda: v.inCongestion,
      occupazione: v.occupancy,
      fermataCorrente: v.monitoredCall?.stopPointRef ?? null,
      fermateTransitate: v.previousCalls.length,
      fermateFuture: v.onwardCalls.length,
    }));

    res.json({
      configured: true,
      httpStatus: result.httpStatus,
      failed: result.failed,
      errorText: result.errorText,
      responseTimestamp: result.responseTimestamp,
      shortestPossibleCycleSec: result.shortestPossibleCycleSec,
      mezzi: result.vehicles.length,
      corseAnnullate: result.cancellations.length,
      /* La ripartizione che spiega la mappa: si registra solo l'esercizio. */
      parco: {
        trasmessi: result.vehicles.length,
        inEsercizio: split.inServizio.length,
        fermiNonRegistrati: split.ferme.length,
        nota: split.nonDistinguibile
          ? "Il produttore non dichiara nulla di monitorato: non è possibile "
            + "distinguere il deposito, quindi si registra tutto."
          : undefined,
      },
      /* Che cosa il produttore riempie davvero, campo per campo. */
      completezza,
      diagnosi: diagnose(completezza, mapping?.report),
      corrispondenze: mapping?.report ?? { nota: "nessun feed GTFS attivo" },
      /* Se l'indice non è filtrato per il giorno, OGNI aggancio risulta
       * ambiguo: la stessa corsa esiste in ogni validità. */
      indiceCorse: index?.tripStarts ? {
        corseCircolantiOggi: index.tripStarts.trips,
        giornoDiServizio: index.tripStarts.serviceDay ?? null,
        filtratoPerCalendario: index.tripStarts.calendarFiltered ?? null,
        nota: index.tripStarts.calendarFiltered === false
          ? "Il calendario del feed non dice quali corse circolano oggi: l'indice contiene TUTTE "
            + "le validità, quindi linea+ora individuano più corse e ogni aggancio è ambiguo."
          : undefined,
      } : undefined,
      /* Gli id VERI del feed, accanto ai riferimenti orfani dell'AVM: senza
       * vedere le due codifiche affiancate non si può disegnare la
       * corrispondenza (numeri di linea? codici interni? uuid?). */
      esempiFeed: index ? {
        /* Tutte le linee del feed: con 19 linee orfane serve poter cercare
         * a occhio se quel numero nel feed esiste o no. */
        linee: [...index.routes].sort(),
        fermate: [...index.stops].slice(0, 10),
        corse: [...index.trips].slice(0, 5),
      } : undefined,
      campione,
      /* ?raw=1 ritaglia UNA VehicleActivity dal grezzo: è l'unico modo di
       * vedere i nomi veri degli elementi quando manca ciò che ci si aspetta. */
      xmlEsempio: (req.query.raw === "1")
        ? extractSampleActivity(result.rawXml, String(req.query.marker ?? "LineRef"))
        : undefined,
    });
  } catch (e: any) {
    res.status(502).json({ configured: true, error: e?.message ?? "richiesta fallita" });
  }
});

/* ── Che cosa ci manda l'AVM, per intero ──────────────────────────────────
 * Ogni tabella costruita finora è partita da un'ipotesi su quali campi
 * arrivassero. Questo endpoint toglie l'ipotesi di mezzo: mostra la richiesta
 * che spediamo, l'inventario di OGNI elemento della risposta con quante volte
 * è valorizzato e con che valori, e i blocchi grezzi interi.
 *
 *   GET /api/siri/campi              — inventario per mezzo (VehicleActivity)
 *   GET /api/siri/campi?tutto=1      — inventario dell'intera busta SOAP
 *   GET /api/siri/campi?grezzo=3     — allega 3 VehicleActivity complete
 *   GET /api/siri/campi?lineRef=03   — solo una linea
 */
router.get("/siri/campi", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  try {
    const lineRef = (req.query.lineRef as string | undefined)?.trim() || null;
    const result = await fetchVehicleMonitoring(cfg, {
      detailLevel: siriDetailLevel(), lineRef,
      maximumVehicles: Number(req.query.max) || null,
    });

    const perMezzo = req.query.tutto === "1" ? undefined : "VehicleActivity";
    const inv = inventoryFields(result.rawXml, perMezzo);

    /* Quanti blocchi grezzi allegare. Uno solo può capitare su una vettura
     * povera di dati e far concludere che l'AVM non mandi nulla: se ne
     * prendono di più, scelti fra i più informativi. */
    const nGrezzi = Math.min(Math.max(Number(req.query.grezzo) || 0, 0), 5);

    res.json({
      configured: true,
      httpStatus: result.httpStatus,
      failed: result.failed,
      errorText: result.errorText,
      responseTimestamp: result.responseTimestamp,

      /* 1. LA DOMANDA: che cosa spediamo, testualmente. */
      richiestaSpedita: {
        url: cfg.url,
        soapAction: cfg.soapAction ?? "(predefinita)",
        detailLevel: siriDetailLevel(),
        requestorRef: cfg.requestorRef,
        filtroLinea: lineRef ?? "(nessuno: tutte)",
        xml: result.requestXml,
      },

      /* 2. LA RISPOSTA, campo per campo. `valorizzati` è la colonna che
       *    conta: un campo presente ma sempre vuoto non è utilizzabile, e
       *    finora questa differenza non si vedeva da nessuna parte. */
      inventario: {
        ambito: perMezzo ?? "(intera busta SOAP)",
        mezziEsaminati: inv.radici,
        legenda: "occorrenze = quante volte l'elemento compare · valorizzati = "
          + "...di cui con contenuto · esempi = valori distinti osservati",
        campi: inv.campi,
      },

      /* 3. Il grezzo intero, per i casi in cui l'inventario non basta. */
      grezzo: nGrezzi > 0
        ? mostInformative(result.vehicles, nGrezzi).map(v =>
          extractSampleActivity(result.rawXml, v.vehicleRef ?? "VehicleRef", 6000))
        : undefined,
      notaGrezzo: nGrezzi === 0
        ? "Aggiungi ?grezzo=3 per allegare 3 VehicleActivity complete."
        : undefined,
    });
  } catch (e: any) {
    res.status(502).json({ configured: true, error: e?.message ?? "richiesta fallita" });
  }
});

/* ── Stato del parco: quali apparati di bordo funzionano ──────────────────
 * L'unica informazione di questo flusso che riguarda il MEZZO e non il
 * servizio, e l'unica che nessun altro sistema aziendale produce. Su 368
 * vetture, 298 riportano un errore di monitoraggio e alcune un ultimo
 * contatto di mesi prima: finora serviva solo a scartare le posizioni vecchie.
 *
 * Si legge in diretta dal flusso, senza passare dal database: lo stato di un
 * apparato è quello di adesso, e conservarne la storia sarebbe un'altra cosa.
 *
 *   GET /api/siri/parco              — quadro e vetture da verificare
 *   GET /api/siri/parco?tutte=1      — l'intero parco, vettura per vettura
 *   GET /api/siri/parco?formato=csv  — per l'officina
 */
router.get("/siri/parco", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  try {
    const result = await fetchVehicleMonitoring(cfg, { detailLevel: siriDetailLevel() });
    if (result.failed) {
      res.status(502).json({
        configured: true, failed: true, errorText: result.errorText,
        httpStatus: result.httpStatus,
      });
      return;
    }

    const stato = statoParco(result.vehicles);

    if (String(req.query.formato ?? "") === "csv") {
      const elenco = req.query.tutte === "1"
        ? result.vehicles.map(v => diagnosiVettura(v))
        : stato.daVerificare;
      const testata = ["matricola", "stato", "errore", "ultimo_contatto",
        "fermo_da_ore", "progress_status", "linea", "posizione"];
      const righe = elenco.map(d => [
        d.vehicleRef, ETICHETTE_STATO[d.stato], d.errore ?? "",
        d.ultimoContatto ?? "",
        d.etaContattoSec != null ? (d.etaContattoSec / 3600).toFixed(1) : "",
        d.progressStatus ?? "", d.linea ?? "", d.haPosizione ? "sì" : "no",
      ]);
      const csv = [testata, ...righe]
        .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))
        .join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="parco-avm-${new Date().toISOString().slice(0, 10)}.csv"`);
      /* BOM: senza, Excel in italiano sbaglia gli accenti. */
      res.send("\uFEFF" + csv);
      return;
    }

    res.json({
      configured: true,
      rilevatoAlle: result.responseTimestamp ?? new Date().toISOString(),
      totale: stato.totale,
      quotaUtilizzabile: stato.quotaUtilizzabile,
      nota: stato.nota,
      perStato: stato.perStato.map(x => ({
        stato: x.stato, etichetta: ETICHETTE_STATO[x.stato], conteggio: x.conteggio,
      })),
      daVerificare: stato.daVerificare,
      /* L'intero parco solo su richiesta: 368 righe non servono a chi cerca i
       * mezzi da riparare, e allungano ogni risposta. */
      tutte: req.query.tutte === "1"
        ? result.vehicles.map(v => diagnosiVettura(v))
        : undefined,
    });
  } catch (e: any) {
    res.status(502).json({ configured: true, error: e?.message ?? "richiesta fallita" });
  }
});

/* ── Il parco nel tempo ───────────────────────────────────────────────────
 * L'elenco degli apparati dice chi è guasto OGGI; questo dice che cosa è
 * CAMBIATO. Sono due domande diverse e la seconda, adesso, pesa di più: la
 * misura sul flusso vero dice che sull'intervallo di lettura siamo già al
 * limite (~40 s, 37,5% di passaggi riconosciuti contro il 36% consentito)
 * mentre sui mezzi no: 9 in servizio su 368 trasmessi. I due fattori si
 * moltiplicano, e questo è quello su cui possiamo agire da soli.
 *
 * Si legge dalle posizioni già scritte: non serve una tabella nuova, e i
 * giorni passati ci sono già. */
router.get("/siri/parco/andamento", async (req, res): Promise<void> => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 4), 180);
  try {
    const filtro = (await hasSourceColumn())
      ? sql`vp.source = ${SOURCE_SIRI}`
      : sql`TRUE`;

    const r = await db.execute<any>(sql`
      SELECT vehicle_id, ts::date::text AS day
        FROM caronte.vehicle_positions vp
       WHERE ${filtro}
         AND vehicle_id IS NOT NULL
         AND ts > now() - (${days} * interval '1 day')
       GROUP BY 1, 2
       ORDER BY 1, 2
       LIMIT 200000`);

    const perVettura = new Map<string, string[]>();
    for (const x of ((r as any).rows ?? [])) {
      const v = String(x.vehicle_id);
      const l = perVettura.get(v) ?? [];
      l.push(String(x.day));
      perVettura.set(v, l);
    }

    /* Le giornate del periodo si generano, non si deducono dai dati: se le
     * prendessimo dalle righe, un fine settimana in cui nessuno trasmette
     * accorcerebbe il periodo e sposterebbe la metà. */
    const oggi = new Date();
    const inizio = new Date(oggi.getTime() - (days - 1) * 86_400_000);
    const giornate = giornateDelPeriodo(
      inizio.toISOString().slice(0, 10), oggi.toISOString().slice(0, 10));

    const andamento = andamentoParco(
      [...perVettura.entries()].map(([vehicleRef, giorni]) => ({ vehicleRef, giorni })),
      giornate,
    );

    if (String(req.query.formato ?? "") === "csv") {
      const testata = ["matricola", "stato", "primo_giorno", "ultimo_giorno",
        "giorni_di_silenzio", "giornate_prima_meta", "giornate_seconda_meta"];
      const righe = [...andamento.perse, ...andamento.riprese].map(v => [
        v.vehicleRef, v.stato, v.primoGiorno, v.ultimoGiorno,
        v.giorniDiSilenzio, v.primaMeta, v.secondaMeta,
      ]);
      const csv = [testata, ...righe]
        .map(x => x.map(c => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="parco-andamento-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send("﻿" + csv);
      return;
    }

    res.json({ configured: true, days, andamento });
  } catch (e: any) {
    res.status(500).json({ configured: true, error: e?.message ?? "lettura fallita" });
  }
});

/* ── Verifica dell'aggancio corsa ─────────────────────────────────────────
 * Ogni numero di Tempi di percorrenza poggia sull'attribuzione di un passaggio
 * a una corsa. Questo indirizzo mostra quell'attribuzione messa alla prova
 * contro quello che l'AVM dichiara per conto suo — e, soprattutto, dice su
 * quante corse quella prova non si può nemmeno fare. */
router.get("/siri/aggancio", async (req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.json(NOT_CONFIGURED); return; }

  try {
    const result = await fetchVehicleMonitoring(cfg, { detailLevel: siriDetailLevel() });
    if (result.failed) {
      res.status(502).json({
        configured: true, failed: true, errorText: result.errorText,
        httpStatus: result.httpStatus,
      });
      return;
    }

    const { esiti, riepilogo, feedMancante } = await auditAgganci(result.vehicles);
    if (feedMancante) {
      res.json({
        configured: true, feedMancante: true,
        nota: "Nessun feed GTFS attivo: senza orario non c'è nessuna corsa a cui "
          + "confrontare quello che dichiara l'AVM.",
      });
      return;
    }

    if (String(req.query.formato ?? "") === "csv") {
      const testata = ["matricola", "corsa", "id_avm", "agganciato_come", "verdetto",
        "motivo", "riscontri_indipendenti", "linea", "partenza", "arrivo", "capolinea", "posizione"];
      const perCampo = (e: typeof esiti[number], campo: string) => {
        const r = e.riscontri.find(x => x.campo === campo);
        if (!r) return "";
        if (r.esito === "non_verificabile") return "—";
        const scarto = r.scostamento != null ? ` (${r.scostamento})` : "";
        return `${r.esito}${r.tautologico ? " [tautologico]" : ""}${scarto}`;
      };
      const righe = esiti.map(e => [
        e.vehicleRef ?? "", e.tripId, e.journeyRef ?? "", e.agganciatoCome,
        e.verdetto, e.motivo, e.indipendenti,
        perCampo(e, "linea"), perCampo(e, "partenza"), perCampo(e, "arrivo"),
        perCampo(e, "capolinea"), perCampo(e, "posizione"),
      ]);
      const csv = [testata, ...righe]
        .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"))
        .join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="agganci-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send("﻿" + csv);
      return;
    }

    /* In testa le corse su cui qualcosa non torna: sono quelle per cui
     * qualcuno deve fare qualcosa. Il resto è contesto. */
    const peso = { incoerente: 0, sospetto: 1, verificato: 2, non_verificabile: 3 };
    const ordinati = [...esiti].sort((a, b) => peso[a.verdetto] - peso[b.verdetto]);

    res.json({
      configured: true,
      rilevatoAlle: result.responseTimestamp ?? new Date().toISOString(),
      riepilogo,
      /* Le corse smentite per intero, con i riscontri: senza vedere COSA non
       * torna il verdetto è solo un'altra cosa da credere sulla fiducia. */
      daGuardare: ordinati.filter(e => e.verdetto === "incoerente" || e.verdetto === "sospetto"),
      tutti: req.query.tutti === "1" ? ordinati : undefined,
    });
  } catch (e: any) {
    res.status(502).json({ configured: true, error: e?.message ?? "richiesta fallita" });
  }
});

/* ── I due codici corsa ───────────────────────────────────────────────────
 * L'AVM dichiara un identificativo di corsa; il feed ne ha un altro. I due
 * non combaciano, quindi l'aggancio ripiega su linea + ora di partenza: due
 * corse che partono allo stesso minuto sulla stessa linea restano
 * indistinguibili, e nessuna verifica potrà mai separarle.
 *
 * Questo NON risolve il disallineamento: mostra le coppie che l'aggancio per
 * orario produce ogni giorno e misura quali regole le spiegano. La differenza
 * fra una regola misurata e una indovinata è tutta qui — e finché c'è un
 * giorno solo di raccolta, la risposta onesta è "non si sa ancora".
 */
router.get("/siri/codici", async (req, res): Promise<void> => {
  const giorni = Math.min(Math.max(Number(req.query.giorni) || 30, 1), 180);
  const { righe, giornate, disponibile } = await leggiCodici(giorni);

  if (!disponibile) {
    res.json({
      disponibile: false,
      errore: erroreRaccolta(),
      nota: "La raccolta delle coppie di codici non è attiva: la tabella "
        + "caronte.journey_codes non esiste e non è stato possibile crearla. "
        + "Si crea da sé al primo giro del connettore SIRI, oppure con "
        + "migrations/2026-09_journey_codes.sql.",
    });
    return;
  }

  const studio = studiaCodici(righe.map(r => ({
    giorno: r.giorno, journeyRef: r.journeyRef, tripId: r.tripId,
    agganciatoCome: r.agganciatoCome, osservazioni: r.osservazioni,
  })));

  if (String(req.query.formato ?? "") === "csv") {
    const testata = ["giorno", "codice_avm", "trip_id_gtfs", "agganciato_come",
      "matricola", "line_ref", "linea_pubblicata", "route_ref", "turno",
      "partenza_avm", "capolinea_avm", "route_id", "partenza_gtfs", "capolinea_gtfs",
      "osservazioni", "prima_volta", "ultima_volta"];
    const dati = righe.map(r => [
      r.giorno, r.journeyRef, r.tripId ?? "", r.agganciatoCome ?? "",
      r.vehicleRef ?? "", r.lineRef ?? "", r.publishedLineName ?? "", r.routeRef ?? "",
      r.blockRef ?? "", r.partenzaAvm ?? "", r.destinazioneAvm ?? "",
      r.routeId ?? "", r.partenzaGtfs ?? "", r.capolineaGtfs ?? "",
      r.osservazioni, r.vistoLaPrimaVolta, r.vistoLUltimaVolta,
    ]);
    const csv = [testata, ...dati]
      .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename="codici-corsa-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + csv);
    return;
  }

  /* Il denominatore, che è la prima cosa da sapere: se l'AVM il codice lo
   * manda su 17 mezzi su 368, nessuna regola potrà mai agganciarne di più, e
   * il problema da porre al produttore non è quale sia la codifica ma perché
   * il campo resti vuoto. */
  const ultima = giornate[0] ?? null;
  const copertura = ultima && ultima.mezziPerGiro > 0
    ? {
      mezziPerGiro: ultima.mezziPerGiro,
      conCodicePerGiro: ultima.conCodicePerGiro,
      quota: Math.round(ultima.quotaConCodice * 1000) / 1000,
      nota: ultima.quotaConCodice < 0.5
        ? `Solo ${ultima.conCodicePerGiro} mezzi su ${ultima.mezziPerGiro} dichiarano un `
          + "identificativo di corsa. Anche con la regola perfetta, l'aggancio per codice "
          + "arriverebbe al massimo a questa quota: il resto resterà comunque da riconoscere "
          + "per linea e ora di partenza. Prima della codifica, al produttore va chiesto "
          + "perché il campo sia vuoto sugli altri."
        : "L'AVM dichiara l'identificativo di corsa sulla maggior parte dei mezzi: "
          + "se una regola regge, l'aggancio può diventare un'identificazione.",
    }
    : null;

  res.json({
    disponibile: true,
    giorniRichiesti: giorni,
    copertura,
    giornate,
    studio,
    /* Le coppie vere: senza vederle il verdetto è una cosa da credere sulla
     * fiducia. Le prime 200, oppure tutte con ?tutte=1, oppure il CSV. */
    coppie: req.query.tutte === "1" ? righe : righe.slice(0, 200),
    coppieTotali: righe.length,
    csv: "/api/siri/codici?formato=csv",
  });
});

/* ── Ingestione su richiesta ──────────────────────────────────────────────── */

/* Un'ingestione SCRIVE, quindi resta un POST: una GET che modifica i dati
 * verrebbe eseguita da qualunque prefetch del browser. Ma aprire l'indirizzo
 * nella barra è la prima cosa che si prova, e "Cannot GET" non aiuta nessuno:
 * qui si risponde spiegando come lanciarla, e indicando che di norma non
 * serve perché il poller gira da solo. */
router.get("/siri/sync", (_req, res): void => {
  res.status(405).json({
    error: "Questa è un'operazione di scrittura: si lancia in POST, non aprendo l'indirizzo.",
    diNormaNonServe: "Il poller esegue l'ingestione da solo ogni SIRI_POLL_SECONDS. "
      + "Il sync a mano serve solo per vedere subito i contatori di un giro.",
    comeLanciarla: "Dalla console del browser, mentre sei su una pagina di Cerbero: "
      + "await (await fetch('/api/siri/sync', { method: 'POST', credentials: 'include' })).json()",
    perVedereSoloLoStato: "GET /api/siri/status  ·  GET /api/siri/preview",
  });
});

router.post("/siri/sync", async (_req, res): Promise<void> => {
  const cfg = siriConfig();
  if (!cfg) { res.status(400).json(NOT_CONFIGURED); return; }
  try {
    const result = await runSiriIngest();
    res.json({ ok: true, ...result });
  } catch (e: any) {
    res.status(502).json({ ok: false, error: e?.message ?? "sync fallita" });
  }
});

/** Un giro completo: interroga l'AVM e scrive nelle tabelle di esercizio. */
export async function runSiriIngest(): Promise<Record<string, unknown>> {
  const cfg = siriConfig();
  if (!cfg) return { skipped: "SIRI_VM_URL non impostata" };

  /* Prima di scrivere: le tabelle dell'esercizio devono avere tutte le
   * colonne. Se una migrazione non è stata applicata, ogni INSERT fallirebbe
   * in silenzio nel log del poller e non si accumulerebbe alcun dato. */
  const schema = await ensureCaronteSchema();
  if (!schema.ready) {
    return {
      failed: true,
      errorText: "Schema caronte non allineato — le scritture fallirebbero. Mancano: "
        + ([...schema.missingTables, ...schema.missingColumns].join(", ") || schema.error || "n/d"),
      mezzi: 0,
    };
  }

  const result = await fetchVehicleMonitoring(cfg, { detailLevel: siriDetailLevel() });
  if (result.failed) {
    return {
      failed: true, errorText: result.errorText, httpStatus: result.httpStatus,
      mezzi: 0,
    };
  }
  const ingest = await ingestVehicles(result.vehicles);
  const cancelled = await closeCancelled(result.cancellations);
  ultimoGiro = {
    funnel: ingest.funnel,
    nota: ingest.funnelNota,
    at: new Date().toISOString(),
    mezziNonSalvati: ingest.vehiclesFailed,
    primoErrore: ingest.firstError,
    corseFallite: ingest.corseFallite,
    erroreCorse: ingest.erroreCorse,
    corseAbbandonate: ingest.corseAbbandonate,
    posizioniInserite: ingest.positionsInserted,
    corseAperte: ingest.tripsOpened,
  };
  const poll = siriPoll();

  return {
    mezzi: result.vehicles.length,
    mezziInEsercizio: result.vehicles.length - ingest.vehiclesParked,
    mezziFermiScartati: ingest.vehiclesParked || undefined,
    posizioniInserite: ingest.positionsInserted,
    corseAperte: ingest.tripsOpened,
    corseChiuse: ingest.tripsClosed + cancelled,
    /* Chiuse perché il mezzo ha smesso di trasmettere, non perché ne ha
     * dichiarata un'altra: erano il grosso delle corse aperte in eccesso. */
    corseAbbandonate: ingest.corseAbbandonate || undefined,
    transitiInseriti: ingest.transitsInserted,
    mezziNonSalvati: ingest.vehiclesFailed || undefined,
    primoErrore: ingest.firstError ?? undefined,
    /* Dove si interrompe la catena che porta a un transito. Prima, quando non
     * arrivava niente, si poteva solo tirare a indovinare quale anello avesse
     * ceduto: adesso lo si legge. */
    acquisizioneTransiti: { ...ingest.funnel, diagnosi: ingest.funnelNota },
    /* Quante corse agganciate reggono al confronto con quello che l'AVM
     * dichiara per conto suo. Sta accanto all'imbuto perché risponde alla
     * domanda successiva: non "quanti dati entrano", ma "di quanti ci si
     * può fidare". Il dettaglio è in GET /api/siri/aggancio. */
    verificaAgganci: ingest.riepilogoAgganci,
    intervalloPollSec: poll.effettivo,
    avviso: poll.ridotto
      ? `SIRI_POLL_SECONDS=${poll.richiesto}: oltre i ${MAX_GAP_SEC} s il cambio di fermata `
        + "non è più attribuibile e nessun transito sarebbe registrato. L'intervallo è "
        + `stato riportato a ${poll.effettivo} s perché puntualità e tempi di percorrenza `
        + "si popolino comunque. Imposta SIRI_POLL_SECONDS=60 per togliere l'avviso."
      : undefined,
    corrispondenze: ingest.report,
  };
}

export default router;
