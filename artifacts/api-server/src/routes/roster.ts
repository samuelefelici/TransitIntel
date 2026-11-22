/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — assegnazione turni guida al personale viaggiante
 * ───────────────────────────────────────────────────────────────────────────
 * Tabellone: righe = conducenti (anche fittizi), colonne = giorni. I turni da
 * coprire arrivano da un canale solo, la pubblicazione (routes/roster-
 * pubblicazione.ts): per ogni giorno, i turni guida delle UDP pubblicate.
 * I turni non ancora assegnati sono gli "scoperti".
 *
 *   GET    /api/roster/duty-sources            — DSS salvati (lo usa la pagina Misti; il roster no)
 *   GET    /api/roster/board?from=&days=       — griglia: turni pubblicati, assegnazioni, voci
 *   GET    /api/roster/turni/:dssId/:codice    — le tratte di un turno (dettaglio)
 *   POST   /api/roster/assignments             — assegna {driverId, day, dutyCode, dssId, forza?: chiavi viste}
 *   POST   /api/roster/assignments/scambia     — cambio turno fra due conducenti, stesso giorno (forza?)
 *   DELETE /api/roster/assignments/:id         — rimuovi assegnazione
 *   GET    /api/roster/voci                    — catalogo assenze/presenze (le voci attive; tabella roster_voci, 5.5)
 *   GET    /api/roster/calendario?from=&days=  — la categoria di ogni giorno nel calendario aziendale
 *   POST   /api/roster/entries · DELETE /api/roster/entries/:id
 *   GET    /api/roster/sostituti?day=&dssId=&dutyCode= — chi può coprire un turno (5.1)
 *   GET    /api/roster/mezzi?giorno=           — mezzi per deposito: fabbisogno e disponibilità (5.3)
 *   GET    /api/roster/vetture?giorno=         — i turni macchina della giornata con le vetture assegnate (5.4)
 *   PUT    /api/roster/vetture                 — assegna una vettura a un turno macchina {giorno, vssId, turnoMacchina, vettura}
 *   DELETE /api/roster/vetture?giorno=&vssId=&turnoMacchina= — toglie la vettura
 *
 * Assenze che liberano il turno (5.1, lib/roster-sostituti.ts): un'assenza
 * (non il riposo) del conducente assegnato rimette il turno «da coprire»
 * senza toccare l'assegnazione, che resta come titolare. Riassegnarlo mentre
 * il titolare è assente lo registra come sostituzione (titolare_id e chi,
 * quando, perché); una riassegnazione normale la svuota.
 *
 * I conducenti (anagrafica, storico, fittizi) stanno in routes/anagrafica.ts.
 *
 * Vincoli: un turno è coperto da un solo conducente al giorno (per la stessa
 * fonte DSS); un conducente può fare più turni nello stesso giorno.
 *
 * Riposi e sovrapposizioni (lib/roster-normativa.ts): fra due turni dello
 * stesso conducente servono 8h se urbani, 9h se uno è extraurbano, e due
 * turni non si sovrappongono. Assegnare o scambiare un turno che le viola
 * risponde 409 { violazioni, forzabile: true }; con forza: [le chiavi delle
 * violazioni mostrate] si fa lo stesso e l'assegnazione resta segnata
 * (forzatura: chi, quando, quali coppie di turni).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { driverScenariosAccessibleWhere, requireDriverScenarioRead } from "../lib/scenario-access";
import { assicuraAnagrafica, leggiDepositi, registra, righe, type Ex } from "../lib/anagrafica-store";
import { conducentiPer, Rifiuto, rispondiErrore } from "./anagrafica";
import { abbinaColori, depositiPlanner, depositoDelNome, type DepositoColorato } from "../lib/roster-colori-depositi";
import { trovaDeposito, type Conducente } from "../lib/anagrafica-campi";
import { vedeCodiciSanitari, vedeDatiPersonali } from "../lib/auth";
import { controlloDepositi, fuoriDaiDepositi, haLimiteDiVisibilita } from "../lib/roster-limite-depositi";
import { chiaveTurno, copri, type CandidatoCopertura, type DaCoprire } from "../lib/roster-copertura";
import { bilancia, scarto, type ConducenteBilancio, type Mossa, type TurnoBilancio } from "../lib/roster-bilancia";
import {
  inizioPeriodo, periodiFra, postoDi, rotazione, type AssegnazioneProposta, type Cadenza, type Posto, type Ricerca, type TipoGiorno,
} from "../lib/roster-rotazione-turni";
import { aDisposizione, catalogoPer, esitoScrittura, leggiCatalogo, liberaIlTurno, mascheraVoce } from "../lib/roster-voci";
import { perIlClient, type Violazione } from "../lib/roster-normativa";
import {
  assegnazioniDei, forzaturaDa, piuGiorni, preparaControllo, serviziDeiDss, snapshotDa, turniDelDss, turniNelTempo, violazioniDeiCambi,
  violazioniDelTabellone, violazioniPerCandidati, type Lettore,
} from "../lib/roster-normativa-db";
import { calendarioPredefinito, loadCalendarProfile } from "../lib/planning-studio-calendar";
import { turnoRoster } from "../lib/roster-turni";
import { bloccoCanaleCondiviso, canale, riassuntiDei, snapshotDaRiassunto, statoNelCanale } from "../lib/roster-pubblicazione-db";
import { classifyRange, type CalendarProfile } from "../lib/day-classifier";
import { assentiNelGiorno, sostitutiDa, type Candidato, type Voce } from "../lib/roster-sostituti";
import { fabbisognoDelGiorno, mezziPerDeposito } from "../lib/mezzi-deposito";
import { leggiParcoOfficina } from "../lib/officina";
import { limitiDi } from "../lib/roster-limite-depositi";
import { scriveSulDeposito, vedeIlDeposito } from "../lib/permessi";
import { assegnaVettura, RifiutoVetture, togliVettura, vettureDelGiorno } from "../lib/esercizio-vetture";
import { giornataOggi } from "../lib/service-day";

const router: IRouter = Router();

/* Le tabelle del roster (conducenti, assegnazioni, storico, voci) le crea
 * l'anagrafica del personale: lib/anagrafica-store.ts. */


router.use(async (req, res, next) => {
  if (!req.path.toLowerCase().startsWith("/roster")) { next(); return; }
  try { await assicuraAnagrafica(); }
  catch { res.status(503).json({ error: "Roster non disponibile: riprova tra poco" }); return; }
  next();
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Una data vera, AAAA-MM-GG (non il 30 febbraio). */
const dataVera = (g: string) => DATE_RE.test(g) && !Number.isNaN(Date.parse(`${g}T12:00:00Z`)) && new Date(`${g}T12:00:00Z`).toISOString().slice(0, 10) === g;
const UUID_RE = /^[0-9a-f-]{36}$/i;

// Conducenti, storico, fittizi: routes/anagrafica.ts (montato prima di questo router).

/**
 * Chi ha dei depositi scrive solo sui conducenti di quelli (PR 2.14c,
 * lib/roster-limite-depositi.ts). 403 con `solaLettura`: la web mostra
 * l'avviso unico. Chi non ha limiti non fa nessuna lettura in più.
 */
async function richiedeDeposito(req: Request, ex: Ex, conducenti: readonly unknown[]): Promise<void> {
  const motivo = await fuoriDaiDepositi(req, ex, conducenti);
  if (motivo) throw new Rifiuto(403, motivo, { solaLettura: true });
}

/** I depositi dei turni con il loro colore, come li vede l'utente nelle celle. */
function residenzeDeiTurni(duties: Array<{ residenzaName: string | null; residenzaColor: string | null }>): DepositoColorato[] {
  return duties.filter(d => d.residenzaName && d.residenzaColor)
    .map(d => ({ name: d.residenzaName!, color: d.residenzaColor! }));
}

/**
 * I depositi per la righetta accanto ai conducenti. Il colore di ogni deposito
 * del personale: prima quello dei turni sul tabellone, poi quello di Planner
 * Studio, poi la tavolozza (lib/roster-colori-depositi.ts). Il deposito di
 * ogni conducente lo decide qui lo stesso abbinamento dell'anagrafica (nome,
 * codice o alias), così anche un «Jesi Urb.» rimasto da un vecchio import ha
 * il colore di Jesi Urbano.
 */
async function depositiDelTabellone(drivers: Conducente[], dalTurni: DepositoColorato[]) {
  const ex = db as unknown as Ex;
  const catalogo = await leggiDepositi(ex);
  return {
    drivers: drivers.map(d => ({ ...d, depositoCodice: trovaDeposito(d.residenzaServizio, catalogo)?.codice ?? null })),
    depositi: abbinaColori(catalogo, [
      { da: "turni", depositi: dalTurni },
      { da: "planner", depositi: await depositiPlanner(ex) },
    ]),
  };
}

/** Riposi troppo corti e sovrapposizioni nei giorni del tabellone; se il controllo fallisce, il tabellone si vede lo stesso. */
async function violazioniPerTabellone(conducenti: string[], dal: string, al: string) {
  try { return (await violazioniDelTabellone(conducenti, dal, al)).map(perIlClient); }
  catch (e: any) {
    console.error("[roster] controllo riposi:", e?.code ?? e?.message);
    return [];
  }
}

// ── Calendario aziendale sopra i giorni ─────────────────────────────────────

/**
 * La categoria di ogni giorno nel Calendario Aziendale di Planning Studio
 * (scuole aperte, scuole chiuse invernali o estive, domeniche, festivi
 * rossi), per la righetta colorata sopra le colonne del tabellone.
 *
 * Il calendario è per progetto. Quale progetto, in quest'ordine:
 *   1. ?psProjectId (il tabellone aperto da un servizio);
 *   2. quello dei turni scelti (?dssId);
 *   3. il progetto in esercizio, se ha il calendario compilato;
 *   4. l'unico progetto con un calendario compilato (calendarioPredefinito);
 *   5. nessuno: domeniche e festivi nazionali sì, scuole aperte/chiuse no.
 * Un profilo vuoto classificherebbe ogni feriale come «scuole aperte»:
 * sembra giusto ed è sbagliato, quindi la risposta dice se è compilato.
 */
router.get("/roster/calendario", async (req, res): Promise<void> => {
  try {
    const from = String(req.query.from ?? "");
    if (!DATE_RE.test(from)) { res.status(400).json({ error: "from=YYYY-MM-DD richiesto" }); return; }
    const days = Math.min(Math.max(Number(req.query.days) || 28, 1), 62);
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const richiesto = String(req.query.psProjectId ?? "");

    let psProjectId: string | null = null;
    let scelto: "indicato" | "dai turni" | "in esercizio" | "riconosciuto" | "assente" = "assente";
    if (UUID_RE.test(richiesto)) { psProjectId = richiesto; scelto = "indicato"; }
    /* il programma dei turni pubblicati in quei giorni (quello con più giorni, se sono due) */
    if (!psProjectId) {
      try {
        const r = await db.execute<any>(sql`
          SELECT ps_project_id::text AS id FROM roster_turni_pubblicati
           WHERE sostituita_da IS NULL AND ps_project_id IS NOT NULL AND day BETWEEN ${from}::date AND ${to}::date
           GROUP BY ps_project_id ORDER BY count(DISTINCT day) DESC LIMIT 1`);
        if (r.rows[0]?.id) { psProjectId = r.rows[0].id; scelto = "dai turni"; }
      } catch { /* canale non ancora creato: si va avanti */ }
    }
    if (!psProjectId) {
      try {
        const r = await db.execute<any>(sql`
          SELECT p.id FROM ps_projects p
            JOIN gtfs_feeds f ON f.id = p.materialized_feed_id AND COALESCE(f.is_active, false)
            JOIN ps_calendar_profiles cp ON cp.project_id = p.id
           WHERE jsonb_array_length(COALESCE(cp.closed_periods, '[]'::jsonb)) > 0 OR cp.summer_period IS NOT NULL
           ORDER BY p.updated_at DESC LIMIT 1`);
        if (r.rows[0]?.id) { psProjectId = r.rows[0].id; scelto = "in esercizio"; }
      } catch { /* tabelle di Planning Studio assenti */ }
    }
    let nota: string | null = null;
    if (!psProjectId) {
      const p = await calendarioPredefinito();
      if (p.projectId) { psProjectId = p.projectId; scelto = "riconosciuto"; }
      nota = p.nota ?? null;
    }

    let profilo: CalendarProfile = { closedPeriods: [], summerPeriod: null, extraHolidays: [] };
    let nome: string | null = null;
    if (psProjectId) {
      try { profilo = await loadCalendarProfile(psProjectId); } catch { /* resta il calendario civile */ }
      try {
        const r = await db.execute<any>(sql`SELECT name FROM ps_projects WHERE id = ${psProjectId}::uuid`);
        nome = r.rows[0]?.name ?? null;
      } catch { /* nome facoltativo */ }
    }
    const compilato = profilo.closedPeriods.length > 0 || profilo.summerPeriod !== null;
    if (!compilato) {
      nota = psProjectId
        ? "Il calendario aziendale di questo progetto non ha periodi di scuole chiuse: si distinguono solo domeniche e festivi."
        : (nota ?? "Nessun calendario aziendale compilato in Planning Studio: si distinguono solo domeniche e festivi.");
    }
    const { days: classi } = classifyRange(from, to, profilo);
    res.json({
      from, to,
      calendario: { psProjectId, nome, compilato, scelto, nota },
      days: classi.map(d => ({
        date: d.date, key: d.key, level1: d.level1, level2: d.level2, label: d.label,
        periodo: d.level1 === "scuole_chiuse"
          ? (profilo.closedPeriods.find(p => p.from <= d.date && d.date <= p.to)?.label ?? null)
          : null,
      })),
    });
  } catch (e: any) {
    console.error("[roster.calendario]", e?.cause?.code ?? e?.code ?? "errore");
    res.status(500).json({ error: "Calendario non leggibile" });
  }
});

// ── Fonti turni (DSS salvati) ────────────────────────────────────────────────

router.get("/roster/duty-sources", async (req, res): Promise<void> => {
  try {
    // Filtri opzionali:
    //   ?operationalOnly=1   → solo i turni-guida marcati "in esercizio"
    //   ?psProjectId=<uuid>  → solo quelli del servizio (progetto PS) indicato
    const operationalOnly = String(req.query.operationalOnly ?? "") === "1";
    const psProjectId = String(req.query.psProjectId ?? "").trim();
    const opWhere = operationalOnly ? sql`AND COALESCE(d.is_operational, false) = true` : sql``;
    const psWhere = psProjectId && UUID_RE.test(psProjectId)
      ? sql`AND sp.planning_studio_project_id = ${psProjectId}::uuid`
      : sql``;
    const r = await db.execute<any>(sql`
      SELECT d.id, d.name, d.created_at,
             COALESCE(d.is_operational, false) AS is_operational,
             s.name AS scenario_name, s.date AS scenario_date,
             sp.validity_unit_id AS validity_unit_id, vu.name AS unit_name,
             jsonb_array_length(COALESCE(d.result->'driverShifts', '[]'::jsonb)) AS duty_count
      FROM driver_shift_scenarios d
      LEFT JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
      LEFT JOIN scheduling_projects sp ON sp.id = s.project_id
      LEFT JOIN ps_validity_units vu ON vu.id = sp.validity_unit_id
      WHERE ${driverScenariosAccessibleWhere(req.user!.id, req.user!.role === "admin")} ${opWhere} ${psWhere}
      ORDER BY d.is_operational DESC, d.created_at DESC
      LIMIT 50
    `);
    /* urbano o extraurbano: decide il riposo minimo fra i turni (8h o 9h) */
    const servizi = await serviziDeiDss(r.rows.map((x: any) => String(x.id))).catch(() => new Map());
    res.json({ sources: r.rows.map((x: any) => ({
      dssId: x.id, name: x.name, scenarioName: x.scenario_name,
      scenarioDate: x.scenario_date, dutyCount: Number(x.duty_count ?? 0),
      isOperational: !!x.is_operational,
      validityUnitId: x.validity_unit_id ?? null, validityUnitName: x.unit_name ?? null,
      serviceType: servizi.get(String(x.id))?.servizio ?? null,
      serviceTypeDa: servizi.get(String(x.id))?.da ?? null,
      createdAt: x.created_at,
    })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Tabellone ────────────────────────────────────────────────────────────────

/**
 * Il tabellone. I turni arrivano solo dal canale della pubblicazione
 * (lib/roster-pubblicazione-db.ts): per ogni giorno le UDP pubblicate e i
 * loro turni guida. Ogni assegnazione ha uno stato:
 *   - pubblicato: il suo turno è pubblicato quel giorno;
 *   - da_riassegnare: il giorno è pubblicato ma il suo turno no (una
 *     ripubblicazione l'ha tolto e non ha trovato un turno uguale);
 *   - non_pubblicato: il giorno non è pubblicato (assegnazioni di prima).
 * I turni sono riassunti (senza tratte): le tratte di un turno si chiedono
 * a parte (GET /roster/turni/:dssId/:codice).
 */
router.get("/roster/board", async (req, res): Promise<void> => {
  try {
    const from = String(req.query.from ?? "");
    if (!DATE_RE.test(from)) { res.status(400).json({ error: "from=YYYY-MM-DD richiesto" }); return; }
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
    const dayList: string[] = [];
    const d0 = new Date(`${from}T00:00:00Z`);
    for (let i = 0; i < days; i++) dayList.push(new Date(d0.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    const al = dayList[dayList.length - 1]!;
    const ex = db as unknown as Ex;

    /* i conducenti come li può vedere chi chiede: senza «personale», solo i dati operativi;
     * chi vede solo alcuni depositi (PR 2.14d), solo i conducenti di quelli */
    const drivers = await conducentiPer(req, ex);
    /* per chi ha quel limite, turni e voci dei conducenti che non vede non escono: delle voci
     * niente, dei turni solo che sono occupati (giorno e turno, senza il conducente),
     * altrimenti gli sembrerebbero scoperti e proverebbe ad assegnarli */
    const visti = haLimiteDiVisibilita(req) ? new Set(drivers.map(d => String(d.id).toLowerCase())) : null;
    const vede = (driverId: unknown) => !visti || visti.has(String(driverId).toLowerCase());
    const righeCanale = await canale(ex, from, al);
    const assegnazioni = righe(await ex.execute(sql`
      SELECT id::text, driver_id::text, day::text AS day, duty_code, dss_id::text, snapshot, forzatura, ricollegamenti, titolare_id::text
        FROM roster_assignments WHERE day BETWEEN ${from}::date AND ${al}::date`));
    const riassunti = await riassuntiDei([...righeCanale.map(r => r.dssId), ...assegnazioni.map(a => String(a.dss_id))]);
    const dutiesByDss: Record<string, unknown[]> = {};
    /* il deposito del catalogo di ogni turno (5.2, la vestizione per deposito): dalla residenza, come i colori */
    const catalogoDepositi = await leggiDepositi(ex);
    const depositoDi = new Map<string, string | null>();
    const codiceDeposito = (nome: string | null | undefined): string | null => {
      if (!nome) return null;
      if (!depositoDi.has(nome)) depositoDi.set(nome, depositoDelNome(nome, catalogoDepositi)?.codice ?? null);
      return depositoDi.get(nome)!;
    };
    for (const [id, r] of riassunti) {
      dutiesByDss[id] = r.turni.map(({ firma: _f, corse: _c, inizio: _i, fine: _e, ...t }) => ({ ...t, depositoCodice: codiceDeposito(t.residenzaName) }));
    }

    const pubblicati: Record<string, Array<{ udpId: string; udpNome: string | null; dssId: string; dssNome: string | null; psProjectId: string | null }>> = {};
    for (const r of righeCanale) {
      (pubblicati[r.day] ??= []).push({ udpId: r.udpId, udpNome: r.udpNome ?? null, dssId: r.dssId, dssNome: r.dssNome ?? null, psProjectId: r.psProjectId });
    }
    const stato = (day: string, dss: string) =>
      !pubblicati[day]?.length ? "non_pubblicato" : pubblicati[day]!.some(x => x.dssId === dss) ? "pubblicato" : "da_riassegnare";

    const idProgrammi = [...new Set(righeCanale.map(r => r.psProjectId).filter((x): x is string => !!x))];
    let programmi: Array<{ id: string; nome: string }> = [];
    if (idProgrammi.length) {
      try {
        programmi = righe(await ex.execute(sql`
          SELECT id::text, name FROM ps_projects WHERE id IN (${sql.join(idProgrammi.map(id => sql`${id}::uuid`), sql`, `)})`))
          .map(x => ({ id: x.id, nome: x.name }));
      } catch { /* nomi facoltativi */ }
    }

    // Voci Assenza/Presenza nel range, con le regole del catalogo (5.5).
    const catalogo = await leggiCatalogo(db as unknown as Ex);
    const entriesQ = await db.execute<any>(sql`
      SELECT id, driver_id, day::text AS day, category, code, source
        FROM roster_entries
       WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day')
    `);

    /* il colore dei depositi dai turni pubblicati, dal giorno più recente indietro */
    const dssPubblicati = [...new Set([...righeCanale].reverse().map(r => r.dssId))];
    const dep = await depositiDelTabellone(drivers, dssPubblicati.flatMap(id => residenzeDeiTurni(riassunti.get(id)?.turni ?? [])));
    res.json({
      from, days: dayList,
      drivers: dep.drivers,
      depositi: dep.depositi,
      pubblicati,
      programmi,
      dutiesByDss,
      assignments: assegnazioni.filter((a: any) => vede(a.driver_id)).map((a: any) => ({
        id: a.id, driverId: a.driver_id, day: String(a.day).slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id,
        snapshot: a.snapshot ?? null, forzatura: a.forzatura ?? null,
        /* sostituzione per assenza (5.1): chi aveva il turno; il nome lo trova il tabellone, se lo vede */
        titolareId: a.titolare_id ?? null,
        stato: stato(String(a.day).slice(0, 10), a.dss_id),
        ricollegata: Array.isArray(a.ricollegamenti) && a.ricollegamenti.length ? a.ricollegamenti[a.ricollegamenti.length - 1] : null,
      })),
      /* i turni presi da conducenti che chi chiede non vede: occupati, senza dire da chi */
      occupatiDaAltri: assegnazioni.filter((a: any) => !vede(a.driver_id))
        .map((a: any) => ({ day: String(a.day).slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id })),
      violazioni: await violazioniPerTabellone(dep.drivers.map(d => d.id), from, al),
      /* i codici sanitari (malattia, infortunio, 104) solo a chi ha il permesso roster; le
       * regole (libera il turno, a disposizione) quelle della voce vera, anche se mascherata */
      entries: entriesQ.rows.filter((e: any) => vede(e.driver_id)).map((e: any) => mascheraVoce({
        id: e.id, driverId: e.driver_id, day: e.day.slice(0, 10), category: e.category, code: e.code,
        source: e.source ?? null,
        liberaTurno: liberaIlTurno({ category: e.category, code: e.code }, catalogo),
        aDisposizione: aDisposizione({ category: e.category, code: e.code }, catalogo),
      }, vedeCodiciSanitari(req), catalogo)),
    });
  } catch (e: any) {
    console.error("[roster.board]", e?.cause?.code ?? e?.code ?? e?.message);
    res.status(500).json({ error: "Tabellone non leggibile" });
  }
});

/** Le tratte di un turno (linea, orari, luoghi), per il dettaglio col tasto destro. */
router.get("/roster/turni/:dssId/:codice", async (req, res): Promise<void> => {
  try {
    const dssId = String(req.params.dssId).toLowerCase(), codice = String(req.params.codice);
    if (!UUID_RE.test(dssId) || !codice || codice.length > 100) { res.status(400).json({ error: "dssId e codice richiesti" }); return; }
    /* il roster mostra i turni dei DSS pubblicati o assegnati; gli altri solo a chi può leggerli */
    const nelRoster = righe(await db.execute<any>(sql`
      SELECT EXISTS (SELECT 1 FROM roster_turni_pubblicati WHERE dss_id = ${dssId}::uuid)
          OR EXISTS (SELECT 1 FROM roster_assignments WHERE dss_id = ${dssId}::uuid) AS si`))[0]?.si;
    if (!nelRoster && !(await requireDriverScenarioRead(req, res, dssId))) return;
    const turno = (await turniDelDss([{ dssId, codice }])).get(`${dssId}|${codice}`);
    if (!turno) { res.status(404).json({ error: "Turno non trovato" }); return; }
    res.json({ turno: turnoRoster(turno, 0) });
  } catch (e: any) {
    console.error("[roster.turno]", e?.cause?.code ?? e?.code ?? e?.message);
    res.status(500).json({ error: "Turno non leggibile" });
  }
});

const UUID_STRETTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Chi ha fatto la richiesta, per il registro. */
const utente = (req: any) => ({ userId: req.user?.id ?? null, via: req.authVia ?? null });

/**
 * Blocca i conducenti e li rilegge: prima i conducenti, poi i turni, sempre
 * in ordine di id. È l'ordine della disattivazione e dell'import, così
 * nessuno resta ad aspettare l'altro. Il blocco aspetta chi sta cambiando il
 * conducente (disattivazione, data di uscita) e poi legge il dato già
 * salvato; ed è esclusivo fra due assegnazioni allo stesso conducente, così
 * la seconda vede il turno della prima (riposi, sovrapposizioni). NO KEY
 * UPDATE lascia passare i controlli delle chiavi esterne.
 */
async function bloccaConducenti(ex: Ex, ids: string[]): Promise<any[]> {
  return righe(await ex.execute(sql`
    SELECT id, cognome, nome, name, is_active,
           to_char(data_assunzione, 'YYYY-MM-DD') AS dal, to_char(data_fine_servizio, 'YYYY-MM-DD') AS al
      FROM roster_drivers
     WHERE id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
     ORDER BY id
       FOR NO KEY UPDATE`));
}

const nomeConducente = (c: any): string =>
  c ? ([c.cognome, c.nome].filter(Boolean).join(" ") || c.name) : "Il conducente";

/** Riceve un turno solo chi è in servizio quel giorno: attivo, assunto, non ancora uscito. */
function controllaInServizio(c: any, giorno: string, personale: boolean): void {
  const chi = nomeConducente(c);
  const quando = giorno.split("-").reverse().join("/");
  if (!c || !c.is_active) throw new Rifiuto(409, `${chi} non è più fra i conducenti attivi`);
  /* la data di uscita è un dato operativo; quella di assunzione no: a chi non
     vede i dati personali non si dice se non è ancora assunto */
  if (c.dal && c.dal > giorno) throw new Rifiuto(409, personale ? `${chi} il ${quando} non è ancora assunto` : `${chi} il ${quando} non è in servizio`);
  if (c.al && c.al < giorno) throw new Rifiuto(409, `${chi} il ${quando} non è più in servizio`);
}

/**
 * Forzare vuol dire: ho visto queste violazioni e procedo. Il client manda in
 * `forza` le chiavi delle violazioni che ha mostrato; si procede solo se
 * quelle di adesso sono tutte fra queste. Se nel frattempo ne è nata
 * un'altra (un collega ha assegnato un turno allo stesso conducente), si
 * chiede di nuovo, con l'elenco aggiornato.
 */
function viste(corpo: any): Set<string> {
  return new Set(Array.isArray(corpo?.forza) ? corpo.forza.filter((x: unknown) => typeof x === "string") : []);
}
function controllaForzatura(violazioni: Violazione[], forzate: Set<string>): void {
  if (!violazioni.length || violazioni.every(v => forzate.has(v.chiave))) return;
  const sovr = violazioni.filter(v => v.regola === "sovrapposizione").length;
  const rip = violazioni.length - sovr;
  const parti = [
    sovr ? (sovr === 1 ? "due turni si sovrappongono" : `${sovr} sovrapposizioni`) : "",
    rip ? (rip === 1 ? "un riposo è troppo corto" : `${rip} riposi troppo corti`) : "",
  ].filter(Boolean);
  const cambiato = forzate.size > 0;
  throw new Rifiuto(409, `${cambiato ? "Nel frattempo è cambiato qualcosa" : "Attenzione"}: ${parti.join(" e ")}`,
    { violazioni: violazioni.map(perIlClient), forzabile: true, ...(cambiato ? { cambiato: true } : {}) });
}

/** Dentro la transazione si legge in un savepoint: un errore non la rovina, e non si prendono altre connessioni. */
const inSavepoint = (tx: any): Lettore => f => tx.transaction((sp: any) => f(sp as Ex));

/**
 * L'inizio di ogni scrittura sulle assegnazioni: non si aspetta un blocco
 * per più di qualche secondo (poi 409 «riprova»), e si prende il lucchetto
 * del canale condiviso, così una pubblicazione in corso finisce prima.
 */
async function iniziaScrittura(ex: Ex): Promise<void> {
  await ex.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await bloccoCanaleCondiviso(ex);
}

/**
 * Il canale unico: un turno si assegna o si sposta solo se è pubblicato quel
 * giorno. In un giorno mai pubblicato (assegnazioni di prima della
 * pubblicazione) si può solo spostare quello che c'è già.
 */
async function controllaPubblicato(ex: Ex, day: string, dssId: string, codice: string, cosa: "assegna" | "sposta"): Promise<void> {
  const stato = await statoNelCanale(ex, day, dssId);
  const quando = day.split("-").reverse().join("/");
  if (stato === "pubblicato") return;
  if (stato === "giorno_vuoto" && cosa === "sposta") return;
  if (stato === "giorno_vuoto") {
    throw new Rifiuto(409, `Il ${quando} non ha turni pubblicati: pubblicali prima da «Pubblicazione turni»`, { nonPubblicato: true });
  }
  throw new Rifiuto(409, `${codice} non è più pubblicato il ${quando}: va tolto o sostituito`, { nonPubblicato: true });
}

/**
 * Chi può coprire un turno (5.1): i sostituti suggeriti, in gruppi (liberi, a
 * disposizione, già in servizio ma compatibili), fra i conducenti che chi
 * chiede vede, dello stesso deposito del titolare (o del turno), attivi, in
 * servizio quel giorno e non fittizi. Fuori chi quel giorno ha un'assenza
 * (riposo compreso) e chi avrebbe una violazione di riposo o sovrapposizione:
 * di loro solo quanti sono, mai chi né perché. È un suggerimento: decide chi
 * assegna, e l'assegnazione ricontrolla tutto.
 */
router.get("/roster/sostituti", async (req, res): Promise<void> => {
  try {
    const day = String(req.query.day ?? "");
    const dssId = String(req.query.dssId ?? "").toLowerCase();
    const dutyCode = String(req.query.dutyCode ?? "").trim();
    if (!dataVera(day) || !UUID_STRETTO.test(dssId) || !dutyCode || dutyCode.length > 100) {
      res.status(400).json({ error: "day (YYYY-MM-DD), dssId (uuid) e dutyCode richiesti" });
      return;
    }
    const ex = db as unknown as Ex;
    const a = righe(await ex.execute(sql`
      SELECT id::text, driver_id::text, titolare_id::text, snapshot FROM roster_assignments
       WHERE dss_id = ${dssId}::uuid AND day = ${day}::date AND duty_code = ${dutyCode}`))[0] ?? null;
    const preparato = await preparaControllo([], [day], [{ dssId, codice: dutyCode }]);
    const snapshot = a?.snapshot ?? snapshotDa(preparato.orari.get(`${dssId}|${dutyCode}`));
    if (!snapshot) throw new Rifiuto(404, `Il turno ${dutyCode} non c'è in quei turni guida`);

    const conducenti = await conducentiPer(req, ex);
    const nomeDi = (c: Conducente) => [c.cognome, c.nome].filter(Boolean).join(" ") || c.name;
    const titolareId: string | null = a ? (a.titolare_id ?? a.driver_id) : null;
    const titolare = titolareId ? conducenti.find(c => c.id === titolareId) ?? null : null;
    const assente = titolareId ? (await assentiNelGiorno(ex, [titolareId], day)).has(titolareId) : false;
    /* il deposito: del titolare, o quello del turno nel DSS */
    const catalogo = await leggiDepositi(ex);
    const dep = (x: string | null | undefined) => (x && x.trim() ? trovaDeposito(x, catalogo)?.nome ?? x.trim() : null);
    let deposito = dep(titolare?.residenzaServizio);
    if (!deposito) deposito = dep((await riassuntiDei([dssId])).get(dssId)?.turni.find(t => t.code === dutyCode)?.residenzaName);

    const attivi = conducenti.filter(c => c.isActive && !c.isFictitious && (!deposito || dep(c.residenzaServizio) === deposito));
    const elenco = (ids: string[]) => sql.join(ids.map(id => sql`${id}::uuid`), sql`, `);
    const inServizio = new Set(attivi.length ? righe(await ex.execute(sql`
      SELECT id::text FROM roster_drivers
       WHERE id IN (${elenco(attivi.map(c => c.id))})
         AND (data_assunzione IS NULL OR data_assunzione <= ${day}::date)
         AND (data_fine_servizio IS NULL OR data_fine_servizio >= ${day}::date)`)).map(x => String(x.id)) : []);
    const candidati: Candidato[] = attivi.filter(c => inServizio.has(c.id))
      .map(c => ({ id: c.id, nome: nomeDi(c), matricola: c.matricola ?? null, deposito: dep(c.residenzaServizio) }));
    const ids = candidati.map(c => c.id);
    const voci: Voce[] = ids.length ? righe(await ex.execute(sql`
      SELECT driver_id::text, category, code FROM roster_entries WHERE day = ${day}::date AND driver_id IN (${elenco(ids)})`))
      .map(x => ({ driverId: String(x.driver_id), day, category: String(x.category), code: String(x.code) })) : [];
    const turni = new Map<string, string[]>();
    if (ids.length) {
      for (const t of righe(await ex.execute(sql`
        SELECT driver_id::text, duty_code FROM roster_assignments WHERE day = ${day}::date AND driver_id IN (${elenco(ids)}) ORDER BY duty_code`))) {
        const l = turni.get(t.driver_id); if (l) l.push(t.duty_code); else turni.set(t.driver_id, [t.duty_code]);
      }
    }
    const esclusi = new Set([a?.driver_id, titolareId].filter((x): x is string => !!x));
    const assentiTutti = new Set(voci.filter(v => v.category === "assenza").map(v => v.driverId));
    const daControllare = ids.filter(id => !esclusi.has(id) && !assentiTutti.has(id));
    const violazioni = await violazioniPerCandidati({ id: a?.id ?? null, day, dssId, dutyCode, snapshot }, daControllare, preparato);
    const r = sostitutiDa({ candidati, esclusi, voci, turni, violazioni: new Map([...violazioni].map(([k, v]) => [k, v.length])), catalogo: await leggiCatalogo(ex) });
    res.json({
      turno: { day, dssId, dutyCode, inizio: snapshot.start ?? null, fine: snapshot.end ?? null },
      deposito,
      /* il titolare, se c'è: assente quel giorno (il turno è da coprire) o no; il motivo non si dice */
      titolare: titolareId ? { id: titolareId, nome: titolare ? nomeDi(titolare) : null, assente } : null,
      sostituti: r.sostituti,
      fuori: r.fuori,
    });
  } catch (e) { rispondiErrore(res, e, "sostituti"); }
});

/**
 * «Copri gli scoperti» (7.6): i turni pubblicati di un giorno senza conducente,
 * o col titolare assente e senza sostituto, proposti ai conducenti dello
 * stesso deposito liberi o a disposizione, senza violazioni (la scelta è in
 * lib/roster-copertura.ts). `{ day }` restituisce la proposta; `{ day,
 * applica: true }` la ricalcola e assegna un turno alla volta con le stesse
 * regole dell'assegnazione a mano, senza forzare: quello che nel frattempo non
 * va più resta scoperto, col motivo. Solo i conducenti che chi chiede vede e
 * su cui scrive.
 */
router.post("/roster/copri-scoperti", async (req, res): Promise<void> => {
  try {
    const day = String(req.body?.day ?? "");
    if (!dataVera(day)) { res.status(400).json({ error: "day: una data vera, AAAA-MM-GG" }); return; }
    const applica = req.body?.applica === true;
    const ex = db as unknown as Ex;
    const dssIds = righe(await ex.execute(sql`
      SELECT DISTINCT dss_id::text AS id FROM roster_turni_pubblicati WHERE sostituita_da IS NULL AND day = ${day}::date`)).map(x => String(x.id));
    if (!dssIds.length) { res.json({ day, pubblicato: false, coperture: [], scoperti: [] }); return; }

    const riassunti = await riassuntiDei(dssIds);
    const assegnazioni = righe(await ex.execute(sql`
      SELECT dss_id::text AS dss, duty_code, driver_id::text AS driver, titolare_id::text AS titolare
        FROM roster_assignments WHERE day = ${day}::date AND dss_id = ANY(${`{${dssIds.join(",")}}`}::uuid[])`));
    const perTurno = new Map(assegnazioni.map(a => [chiaveTurno({ dssId: a.dss, codice: a.duty_code }), a]));
    const assenti = await assentiNelGiorno(ex, assegnazioni.filter(a => !a.titolare).map(a => String(a.driver)), day);
    const conducenti = await conducentiPer(req, ex);
    const perId = new Map(conducenti.map(c => [c.id, c]));
    const nomeDi = (c: Conducente) => [c.cognome, c.nome].filter(Boolean).join(" ") || c.name;
    const catalogo = await leggiDepositi(ex);
    const dep = (x: string | null | undefined) => (x && x.trim() ? trovaDeposito(x, catalogo)?.nome ?? x.trim() : null);

    /* i turni da coprire: nessuno assegnato, o il titolare assente e nessun sostituto;
       chi scrive solo su alcuni depositi vede i turni di quelli (e quelli senza deposito) */
    const controllo = await controlloDepositi(req, ex);
    const daCoprire: DaCoprire[] = [];
    for (const [dssId, r] of riassunti) {
      for (const t of r.turni) {
        const a = perTurno.get(chiaveTurno({ dssId, codice: t.code }));
        if (a && (a.titolare || !assenti.has(String(a.driver)))) continue;
        const titolare = a ? perId.get(String(a.driver)) ?? null : null;
        const deposito = dep(titolare?.residenzaServizio) ?? dep(t.residenzaName);
        if (controllo && deposito && !controllo.scrive(deposito)) continue;
        daCoprire.push({
          dssId, codice: t.code, inizio: t.start ?? null, fine: t.end ?? null, deposito,
          titolare: a ? { id: String(a.driver), nome: titolare ? nomeDi(titolare) : null } : null,
        });
      }
    }

    /* i candidati: visti e scrivibili da chi chiede, attivi, non fittizi, in servizio, senza assenze né turni quel giorno */
    const attivi = conducenti.filter(c => c.isActive && !c.isFictitious && (!controllo || controllo.scrive(c.residenzaServizio)));
    const ids = attivi.map(c => c.id);
    const inServizio = new Set(ids.length ? righe(await ex.execute(sql`
      SELECT id::text FROM roster_drivers WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])
         AND (data_assunzione IS NULL OR data_assunzione <= ${day}::date)
         AND (data_fine_servizio IS NULL OR data_fine_servizio >= ${day}::date)`)).map(x => String(x.id)) : []);
    const voci: Voce[] = ids.length ? righe(await ex.execute(sql`
      SELECT driver_id::text, category, code FROM roster_entries WHERE day = ${day}::date AND driver_id = ANY(${`{${ids.join(",")}}`}::uuid[])`))
      .map(x => ({ driverId: String(x.driver_id), day, category: String(x.category), code: String(x.code) })) : [];
    const catalogoVoci = await leggiCatalogo(ex);
    const conAssenza = new Set(voci.filter(v => v.category === "assenza").map(v => v.driverId));
    const disposizione = new Set(voci.filter(v => aDisposizione(v, catalogoVoci)).map(v => v.driverId));
    const conTurno = new Set(ids.length ? righe(await ex.execute(sql`
      SELECT DISTINCT driver_id::text AS id FROM roster_assignments WHERE day = ${day}::date AND driver_id = ANY(${`{${ids.join(",")}}`}::uuid[])`)).map(x => String(x.id)) : []);
    const liberi = attivi.filter(c => inServizio.has(c.id) && !conAssenza.has(c.id) && !conTurno.has(c.id));
    /* il carico: i turni di ognuno nei tre giorni prima e dopo */
    const carico = new Map(liberi.length ? righe(await ex.execute(sql`
      SELECT driver_id::text AS id, count(*)::int AS n FROM roster_assignments
       WHERE driver_id = ANY(${`{${liberi.map(c => c.id).join(",")}}`}::uuid[])
         AND day BETWEEN ${day}::date - 3 AND ${day}::date + 3
       GROUP BY driver_id`)).map(x => [String(x.id), Number(x.n)]) : []);

    const preparato = await preparaControllo(liberi.map(c => c.id), [day], daCoprire.map(t => ({ dssId: t.dssId, codice: t.codice })));
    const candidati = new Map<string, CandidatoCopertura[]>();
    for (const t of daCoprire) {
      const delDeposito = liberi.filter(c => !t.deposito || dep(c.residenzaServizio) === t.deposito);
      const snapshot = snapshotDa(preparato.orari.get(chiaveTurno(t)));
      if (!snapshot || !delDeposito.length) { candidati.set(chiaveTurno(t), []); continue; }
      const violazioni = await violazioniPerCandidati({ id: null, day, dssId: t.dssId, dutyCode: t.codice, snapshot }, delDeposito.map(c => c.id), preparato);
      candidati.set(chiaveTurno(t), delDeposito.filter(c => !(violazioni.get(c.id)?.length)).map(c => ({
        id: c.id, nome: nomeDi(c), gruppo: disposizione.has(c.id) ? "disposizione" as const : "libero" as const, carico: carico.get(c.id) ?? 0,
      })));
    }
    const { coperture, scoperti } = copri(daCoprire, candidati);

    if (!applica) { res.json({ day, pubblicato: true, coperture, scoperti }); return; }
    const assegnate: typeof coperture = [];
    const nonAndate: Array<{ turno: DaCoprire; motivo: string }> = [];
    for (const c of coperture) {
      try {
        await eseguiAssegnazione(req, { driverId: c.driverId, dssId: c.turno.dssId, day, dutyCode: c.turno.codice, forzate: new Set(), sostituisce: null });
        assegnate.push(c);
      } catch (e: any) {
        if (!(e instanceof Rifiuto)) throw e;
        nonAndate.push({ turno: c.turno, motivo: e.message });
      }
    }
    res.json({ day, pubblicato: true, assegnate, nonAndate, scoperti });
  } catch (e) { rispondiErrore(res, e, "copri gli scoperti"); }
});

/**
 * «Bilancia i carichi» (7.7): in un periodo (da domani, al più 31 giorni), i
 * turni già assegnati si spostano o si scambiano fra i conducenti dello stesso
 * deposito perché le ore di lavoro siano più vicine (lib/roster-bilancia.ts).
 * Senza `applica` solo la proposta, per deposito; con `applica` le mosse si
 * fanno una per volta con i controlli dello scambio a mano (eseguiScambio), e
 * quelle rifiutate si elencano. Si toccano solo conducenti attivi, non
 * fittizi, dei depositi su cui chi chiede scrive.
 */
const PERIODO_MASSIMO_BILANCIO = 31;
router.post("/roster/bilancia-carichi", async (req, res): Promise<void> => {
  try {
    const dal = String(req.body?.dal ?? ""), al = String(req.body?.al ?? "");
    if (!dataVera(dal) || !dataVera(al) || al < dal) { res.status(400).json({ error: "dal e al: date vere, AAAA-MM-GG, con al non prima di dal" }); return; }
    const domani = piuGiorni(giornataOggi(), 1);
    if (dal < domani) { res.status(400).json({ error: "Si bilanciano i giorni da domani in poi" }); return; }
    const giorni: string[] = [];
    for (let g = dal; g <= al && giorni.length <= PERIODO_MASSIMO_BILANCIO; g = piuGiorni(g, 1)) giorni.push(g);
    if (giorni.length > PERIODO_MASSIMO_BILANCIO) { res.status(400).json({ error: `Al più ${PERIODO_MASSIMO_BILANCIO} giorni` }); return; }
    const applica = req.body?.applica === true;
    const ex = db as unknown as Ex;
    const periodo = new Set(giorni);

    /* i conducenti: visti e scrivibili da chi chiede, attivi, non fittizi */
    const controllo = await controlloDepositi(req, ex);
    const conducenti = (await conducentiPer(req, ex)).filter(c => c.isActive && !c.isFictitious && (!controllo || controllo.scrive(c.residenzaServizio)));
    const ids = conducenti.map(c => c.id);
    const lista = `{${ids.join(",")}}`;
    const servizio = new Map(ids.length ? righe(await ex.execute(sql`
      SELECT id::text, data_assunzione::text AS dal, data_fine_servizio::text AS al FROM roster_drivers WHERE id = ANY(${lista}::uuid[])`))
      .map(x => [String(x.id), { dal: x.dal ? String(x.dal).slice(0, 10) : null, al: x.al ? String(x.al).slice(0, 10) : null }]) : []);
    const inServizio = (id: string, g: string) => {
      const s = servizio.get(id);
      return !!s && (!s.dal || s.dal <= g) && (!s.al || s.al >= g);
    };
    const voci = ids.length ? righe(await ex.execute(sql`
      SELECT driver_id::text AS id, day::text AS day, category FROM roster_entries
       WHERE driver_id = ANY(${lista}::uuid[]) AND day BETWEEN ${dal}::date AND ${al}::date`)) : [];
    const conVoce = new Set(voci.map(v => `${v.id}|${String(v.day).slice(0, 10)}`));
    const assente = new Set(voci.filter(v => v.category === "assenza").map(v => `${v.id}|${String(v.day).slice(0, 10)}`));
    /* i turni, con i giorni intorno per i riposi; le sostituzioni non si spostano */
    const righeTurni = await assegnazioniDei(ex, ids, piuGiorni(dal, -2), piuGiorni(al, 2));
    const sostituzioni = new Set(ids.length ? righe(await ex.execute(sql`
      SELECT id::text FROM roster_assignments WHERE driver_id = ANY(${lista}::uuid[])
         AND day BETWEEN ${dal}::date AND ${al}::date AND titolare_id IS NOT NULL`)).map(x => String(x.id)) : []);
    const forzate = new Set(righeTurni.filter(r => r.forzatura).map(r => String(r.id)));
    const nelTempo = await turniNelTempo(righeTurni);

    const nomeDi = (c: Conducente) => [c.cognome, c.nome].filter(Boolean).join(" ") || c.name;
    const catalogo = await leggiDepositi(ex);
    const dep = (x: string | null | undefined) => (x && x.trim() ? trovaDeposito(x, catalogo)?.nome ?? x.trim() : null);
    const gruppi = new Map<string, Conducente[]>();
    for (const c of conducenti) {
      const d = dep(c.residenzaServizio);
      if (!d) continue; /* senza deposito non si sa con chi bilanciare */
      const l = gruppi.get(d);
      if (l) l.push(c); else gruppi.set(d, [c]);
    }

    const depositi = [...gruppi.entries()].sort(([a], [b]) => a.localeCompare(b, "it")).map(([deposito, membri]) => {
      const suoi = new Set(membri.map(c => c.id));
      const perBilancio: ConducenteBilancio[] = membri.map(c => ({
        id: c.id, nome: nomeDi(c),
        liberi: new Set(giorni.filter(g => inServizio(c.id, g) && !conVoce.has(`${c.id}|${g}`))),
        presente: new Set(giorni.filter(g => inServizio(c.id, g) && !assente.has(`${c.id}|${g}`))),
      }));
      const turni: TurnoBilancio[] = nelTempo.filter(t => suoi.has(t.conducenteId)).map(t => ({
        turno: t,
        spostabile: !!t.assegnazioneId && periodo.has(t.giorno) && !sostituzioni.has(t.assegnazioneId) && !forzate.has(t.assegnazioneId),
      }));
      const { mosse, carichi } = bilancia(perBilancio, turni, periodo);
      return { deposito, conducenti: membri.length, scartoPrima: scarto(carichi, "prima"), scartoDopo: scarto(carichi, "dopo"), mosse, carichi };
    }).filter(d => d.conducenti > 1);

    if (!applica) { res.json({ dal, al, depositi }); return; }
    const fatte: Mossa[] = [];
    const nonAndate: Array<{ mossa: Mossa; motivo: string }> = [];
    for (const m of depositi.flatMap(d => d.mosse)) {
      try {
        await eseguiScambio(req, { da: m.turno.id, daConducente: m.da.id, a: m.inCambio?.id ?? null, aConducente: m.a.id, dssVisto: null, forzate: new Set() });
        fatte.push(m);
      } catch (e: any) {
        if (!(e instanceof Rifiuto)) throw e;
        nonAndate.push({ mossa: m, motivo: e.message });
      }
    }
    res.json({ dal, al, fatte, nonAndate });
  } catch (e) { rispondiErrore(res, e, "bilancia i carichi"); }
});

/* ── Rotazione dei turni (7.8, migrazione 0061) ─────────────────────────── */

const CODICE_POSTO_MAX = 40;
const POSTI_MAX = 500;

/** Il gruppo di rotazione, se chi chiede ne vede il deposito; altrimenti 404 (non si dice che c'è). */
async function gruppoRotazione(req: Request, id: string) {
  if (!UUID_STRETTO.test(id)) throw new Rifiuto(400, "gruppo: un uuid");
  const ex = db as unknown as Ex;
  const g = righe(await ex.execute(sql`
    SELECT id::text, deposito_codice, nome, to_char(data_riferimento, 'YYYY-MM-DD') AS riferimento
      FROM roster_gruppi_turni WHERE id = ${id}::uuid`))[0];
  const limiti = limitiDi(req);
  if (!g || !vedeIlDeposito(limiti.vede, g.deposito_codice)) throw new Rifiuto(404, "Gruppo non trovato");
  const deposito = (await leggiDepositi(ex)).find(d => d.codice === g.deposito_codice) ?? null;
  return {
    id: String(g.id), nome: String(g.nome), depositoCodice: String(g.deposito_codice), depositoNome: deposito?.nome ?? String(g.deposito_codice),
    cadenza: (deposito?.cadenzaTurni ?? "semimensile") as Cadenza,
    riferimento: g.riferimento ? String(g.riferimento) : null,
    scrive: scriveSulDeposito(limiti.scrive, g.deposito_codice),
  };
}

async function postiDel(ex: Ex, gruppoId: string): Promise<Posto[]> {
  return righe(await ex.execute(sql`
    SELECT feriale, sabato, domenica FROM roster_rotazioni_turni_posti WHERE gruppo_id = ${gruppoId}::uuid ORDER BY posto`))
    .map(x => ({ feriale: x.feriale ?? null, sabato: x.sabato ?? null, domenica: x.domenica ?? null }));
}

const nomeConducenteDi = (c: Conducente) => [c.cognome, c.nome].filter(Boolean).join(" ") || c.name;

/**
 * La rotazione di un gruppo: i posti, la cadenza del deposito, la data di
 * riferimento, i conducenti del gruppo con il posto di oggi.
 */
router.get("/roster/rotazioni-turni/:gruppoId", async (req, res): Promise<void> => {
  try {
    const gruppo = await gruppoRotazione(req, String(req.params.gruppoId).toLowerCase());
    const ex = db as unknown as Ex;
    const posti = await postiDel(ex, gruppo.id);
    const oggi = giornataOggi();
    const riferimento = gruppo.riferimento ?? inizioPeriodo(oggi, gruppo.cadenza);
    const k = periodiFra(riferimento, oggi, gruppo.cadenza);
    const membri = (await conducentiPer(req, ex)).filter(c => c.rotazioneTurni?.gruppoId === gruppo.id && c.isActive);
    res.json({
      gruppo, posti,
      periodoDiOggi: inizioPeriodo(oggi, gruppo.cadenza),
      conducenti: membri.map(c => {
        const pos = c.rotazioneTurni?.posizione ?? null;
        return { id: c.id, nome: nomeConducenteDi(c), fittizio: c.isFictitious, posizione: pos,
          postoDiOggi: pos !== null && posti.length && pos <= posti.length ? postoDi(pos, k, posti.length) : null };
      }).sort((a, b) => (a.posizione ?? 1e9) - (b.posizione ?? 1e9) || a.nome.localeCompare(b.nome, "it")),
    });
  } catch (e) { rispondiErrore(res, e, "rotazione turni"); }
});

/** Salva la tabella dei posti (l'ordine è il numero del posto) e la data di riferimento. */
router.put("/roster/rotazioni-turni/:gruppoId", async (req, res): Promise<void> => {
  try {
    const gruppo = await gruppoRotazione(req, String(req.params.gruppoId).toLowerCase());
    if (!gruppo.scrive) throw new Rifiuto(403, "Sola lettura: il gruppo è di un deposito su cui non scrivi", { solaLettura: true });
    const corpo = req.body ?? {};
    const rif = corpo.dataRiferimento === undefined || corpo.dataRiferimento === null || corpo.dataRiferimento === ""
      ? inizioPeriodo(giornataOggi(), gruppo.cadenza) : String(corpo.dataRiferimento);
    if (!dataVera(rif)) throw new Rifiuto(400, "dataRiferimento: una data vera, AAAA-MM-GG");
    if (!Array.isArray(corpo.posti) || corpo.posti.length < 1 || corpo.posti.length > POSTI_MAX) throw new Rifiuto(400, `posti: da 1 a ${POSTI_MAX}`);
    const codice = (v: unknown, dove: string) => {
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") throw new Rifiuto(400, `${dove}: un codice di turno`);
      const t = v.trim();
      if (t.length > CODICE_POSTO_MAX) throw new Rifiuto(400, `${dove}: al più ${CODICE_POSTO_MAX} caratteri`);
      return t || null;
    };
    const posti: Posto[] = corpo.posti.map((p: any, i: number) => ({
      feriale: codice(p?.feriale, `posto ${i + 1}, feriale`),
      sabato: codice(p?.sabato, `posto ${i + 1}, sabato`),
      domenica: codice(p?.domenica, `posto ${i + 1}, domenica`),
    }));
    await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      await ex.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await ex.execute(sql`SELECT 1 FROM roster_gruppi_turni WHERE id = ${gruppo.id}::uuid FOR UPDATE`);
      await ex.execute(sql`UPDATE roster_gruppi_turni SET data_riferimento = ${rif}::date WHERE id = ${gruppo.id}::uuid`);
      await ex.execute(sql`DELETE FROM roster_rotazioni_turni_posti WHERE gruppo_id = ${gruppo.id}::uuid`);
      await ex.execute(sql`
        INSERT INTO roster_rotazioni_turni_posti (gruppo_id, posto, feriale, sabato, domenica)
        SELECT ${gruppo.id}::uuid, x.n::smallint, x.e->>'feriale', x.e->>'sabato', x.e->>'domenica'
          FROM jsonb_array_elements(${JSON.stringify(posti)}::jsonb) WITH ORDINALITY AS x(e, n)`);
    });
    res.json({ ok: true, dataRiferimento: rif, posti });
  } catch (e) { rispondiErrore(res, e, "rotazione turni"); }
});

/**
 * La rotazione applicata a un periodo (da domani, al più 31 giorni): senza
 * `applica` la proposta, con `applica` le assegnazioni, una per volta con i
 * controlli dell'assegnazione a mano. Si assegna solo a chi quel giorno è
 * libero (attivo, non fittizio, in servizio, senza voci né turni); quello che
 * non si può fare si dice col motivo, e i turni rimasti si coprono poi con
 * «Copri gli scoperti».
 */
router.post("/roster/rotazioni-turni/:gruppoId/applica", async (req, res): Promise<void> => {
  try {
    const gruppo = await gruppoRotazione(req, String(req.params.gruppoId).toLowerCase());
    if (!gruppo.scrive) throw new Rifiuto(403, "Sola lettura: il gruppo è di un deposito su cui non scrivi", { solaLettura: true });
    const dal = String(req.body?.dal ?? ""), al = String(req.body?.al ?? "");
    if (!dataVera(dal) || !dataVera(al) || al < dal) throw new Rifiuto(400, "dal e al: date vere, AAAA-MM-GG, con al non prima di dal");
    if (dal < piuGiorni(giornataOggi(), 1)) throw new Rifiuto(400, "La rotazione si applica dai giorni da domani in poi");
    const giorni: string[] = [];
    for (let g = dal; g <= al && giorni.length <= PERIODO_MASSIMO_BILANCIO; g = piuGiorni(g, 1)) giorni.push(g);
    if (giorni.length > PERIODO_MASSIMO_BILANCIO) throw new Rifiuto(400, `Al più ${PERIODO_MASSIMO_BILANCIO} giorni`);
    const applica = req.body?.applica === true;
    const ex = db as unknown as Ex;
    const posti = await postiDel(ex, gruppo.id);
    if (!posti.length) throw new Rifiuto(409, "Il gruppo non ha ancora la tabella dei posti: creala prima");
    const riferimento = gruppo.riferimento ?? inizioPeriodo(dal, gruppo.cadenza);

    /* i conducenti del gruppo e i giorni in cui sono liberi */
    const membri = (await conducentiPer(req, ex)).filter(c => c.rotazioneTurni?.gruppoId === gruppo.id && c.isActive && !c.isFictitious);
    const ids = membri.map(c => c.id);
    const lista = `{${ids.join(",")}}`;
    const servizio = new Map(ids.length ? righe(await ex.execute(sql`
      SELECT id::text, data_assunzione::text AS dal, data_fine_servizio::text AS al FROM roster_drivers WHERE id = ANY(${lista}::uuid[])`))
      .map(x => [String(x.id), { dal: x.dal ? String(x.dal).slice(0, 10) : null, al: x.al ? String(x.al).slice(0, 10) : null }]) : []);
    const occupati = new Set([
      ...(ids.length ? righe(await ex.execute(sql`
        SELECT driver_id::text AS id, day::text AS day FROM roster_entries WHERE driver_id = ANY(${lista}::uuid[]) AND day BETWEEN ${dal}::date AND ${al}::date`)) : []),
      ...(ids.length ? righe(await ex.execute(sql`
        SELECT driver_id::text AS id, day::text AS day FROM roster_assignments WHERE driver_id = ANY(${lista}::uuid[]) AND day BETWEEN ${dal}::date AND ${al}::date`)) : []),
    ].map(x => `${x.id}|${String(x.day).slice(0, 10)}`));
    const inServizio = (id: string, g: string) => {
      const s = servizio.get(id);
      return !!s && (!s.dal || s.dal <= g) && (!s.al || s.al >= g);
    };

    /* i turni pubblicati di ogni giorno e chi li ha già */
    const pubblicati = righe(await ex.execute(sql`
      SELECT day::text AS day, dss_id::text AS dss, ps_project_id::text AS progetto FROM roster_turni_pubblicati
       WHERE sostituita_da IS NULL AND day BETWEEN ${dal}::date AND ${al}::date`)).map(x => ({ day: String(x.day).slice(0, 10), dss: String(x.dss), progetto: x.progetto ? String(x.progetto) : null }));
    const riassunti = pubblicati.length ? await riassuntiDei([...new Set(pubblicati.map(p => p.dss))]) : new Map();
    const codiciDel = new Map<string, Set<string>>();
    for (const [dssId, r] of riassunti) codiciDel.set(dssId, new Set(r.turni.map((t: { code: string }) => t.code)));
    const dssDel = new Map<string, string[]>();
    for (const p of pubblicati) { const l = dssDel.get(p.day); if (l) l.push(p.dss); else dssDel.set(p.day, [p.dss]); }
    const cerca = (g: string, codice: string): Ricerca => {
      const dove = (dssDel.get(g) ?? []).filter(d => codiciDel.get(d)?.has(codice));
      if (!dove.length) return "non_pubblicato";
      if (dove.length > 1) return "ambiguo";
      return { dssId: dove[0]!, codice };
    };
    const diChi = new Map(righe(await ex.execute(sql`
      SELECT day::text AS day, dss_id::text AS dss, duty_code, driver_id::text AS chi FROM roster_assignments
       WHERE day BETWEEN ${dal}::date AND ${al}::date`)).map(x => [`${String(x.day).slice(0, 10)}|${x.dss}|${x.duty_code}`, String(x.chi)]));

    /* il tipo di giorno dal calendario del programma pubblicato (domeniche e festivi, patrono compreso) */
    const progetto = pubblicati.find(p => p.progetto)?.progetto ?? null;
    let profilo: CalendarProfile = { closedPeriods: [], summerPeriod: null, extraHolidays: [] };
    if (progetto) { try { profilo = await loadCalendarProfile(progetto); } catch { /* resta il calendario civile */ } }
    const classi = new Map(classifyRange(dal, al, profilo).days.map(d => [d.date, d]));
    const tipoDi = (g: string): TipoGiorno => {
      const d = classi.get(g);
      if (!d) return "feriale";
      if (d.level1 === "festivo") return "domenica";
      return d.weekday === 5 ? "sabato" : "feriale";
    };

    const { assegnazioni, nonFatte } = rotazione({
      posti, giorni, riferimento, cadenza: gruppo.cadenza, tipoDi, cerca,
      occupato: (g, t) => diChi.get(`${g}|${t.dssId}|${t.codice}`) ?? null,
      membri: membri.map(c => ({
        id: c.id, nome: nomeConducenteDi(c), posizione: c.rotazioneTurni?.posizione ?? null,
        liberi: new Set(giorni.filter(g => inServizio(c.id, g) && !occupati.has(`${c.id}|${g}`))),
      })),
    });
    const intestazione = { gruppo: { id: gruppo.id, nome: gruppo.nome, deposito: gruppo.depositoNome, cadenza: gruppo.cadenza, riferimento }, dal, al };
    if (!applica) { res.json({ ...intestazione, assegnazioni, nonFatte }); return; }
    const fatte: AssegnazioneProposta[] = [];
    const nonAndate: Array<{ assegnazione: AssegnazioneProposta; motivo: string }> = [];
    for (const a of assegnazioni) {
      try {
        await eseguiAssegnazione(req, { driverId: a.driverId, dssId: a.dssId, day: a.giorno, dutyCode: a.codice, forzate: new Set(), sostituisce: null });
        fatte.push(a);
      } catch (e: any) {
        if (!(e instanceof Rifiuto)) throw e;
        nonAndate.push({ assegnazione: a, motivo: e.message });
      }
    }
    res.json({ ...intestazione, fatte, nonFatte, nonAndate });
  } catch (e) { rispondiErrore(res, e, "rotazione turni"); }
});

/**
 * I mezzi per deposito (5.3): quanti ne servono il giorno (i turni macchina
 * della giornata di esercizio) e quanti ce ne sono (l'officina, FleetCare:
 * lo stato di adesso), con il margine. Si legge col Roster; chi vede solo
 * alcuni depositi vede solo quelli.
 */
router.get("/roster/mezzi", async (req, res): Promise<void> => {
  try {
    const oggi = giornataOggi();
    const giorno = req.query.giorno === undefined ? oggi : String(req.query.giorno);
    const vero = dataVera(giorno);
    if (!vero) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
    const [fabbisogno, parco, catalogo] = await Promise.all([fabbisognoDelGiorno(giorno), leggiParcoOfficina(), leggiDepositi(db as unknown as Ex)]);
    const limite = limitiDi(req).vede;
    const depositi = mezziPerDeposito({
      fabbisogno: fabbisogno ?? [], parco, catalogo,
      vede: limite === null ? undefined : (codice) => !!codice && vedeIlDeposito(limite, codice),
    });
    res.json({
      giorno,
      /* senza giornata preparata non si sa quanti mezzi servono */
      giornata: fabbisogno !== null,
      officina: {
        disponibile: parco.disponibile, motivo: parco.motivo, lettoAlle: parco.lettoAlle,
        /* l'officina dice com'è adesso: per un altro giorno è una stima */
        statoDiAdesso: giorno !== oggi,
      },
      depositi,
    });
  } catch (e) { rispondiErrore(res, e, "mezzi"); }
});

const rispondiVetture = (res: any, e: any, contesto: string) => {
  if (e instanceof RifiutoVetture) { res.status(e.status).json({ error: e.message, ...e.extra }); return; }
  rispondiErrore(res, e, contesto);
};

/**
 * Le vetture sui turni macchina della giornata (5.4): i turni con la vettura
 * assegnata e gli avvisi (sovrapposizioni, officina, tipo, AVM), le
 * assegnazioni rimaste senza turno, i mezzi dell'officina da proporre. Chi
 * vede solo alcuni depositi vede solo i loro turni.
 */
router.get("/roster/vetture", async (req, res): Promise<void> => {
  try {
    const giorno = req.query.giorno === undefined ? giornataOggi() : String(req.query.giorno);
    if (!dataVera(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
    const [catalogo, parco] = await Promise.all([leggiDepositi(db as unknown as Ex), leggiParcoOfficina()]);
    const r = await vettureDelGiorno(giorno, catalogo, parco);
    const limite = limitiDi(req).vede;
    const vede = (codice: string | null) => vedeIlDeposito(limite, codice);
    const depositoMezzo = (nome: string | null) => (nome ? depositoDelNome(nome, catalogo)?.codice ?? null : null);
    res.json({
      giorno, giornata: r.giornata,
      turni: r.turni.filter((t) => vede(t.depositoCodice)),
      /* senza turno non si sa di che deposito: le vede solo chi vede tutto */
      daRiassegnare: limite === null ? r.daRiassegnare : [],
      officina: { disponibile: parco.disponibile, motivo: parco.motivo },
      mezzi: parco.disponibile
        ? parco.mezzi.filter((m) => m.stato === "in_servizio" || m.stato === "riserva")
          .map((m) => ({ matricola: m.matricola, modello: m.modello, stato: m.stato, depositoCodice: depositoMezzo(m.deposito) }))
          .filter((m) => vede(m.depositoCodice))
        : [],
    });
  } catch (e) { rispondiVetture(res, e, "vetture"); }
});

router.put("/roster/vetture", async (req, res): Promise<void> => {
  try {
    const { giorno, vssId, turnoMacchina, vettura } = req.body ?? {};
    if (typeof giorno !== "string" || !dataVera(giorno) || typeof vssId !== "string" || typeof turnoMacchina !== "string" || typeof vettura !== "string") {
      res.status(400).json({ error: "giorno, vssId, turnoMacchina e vettura richiesti" });
      return;
    }
    const catalogo = await leggiDepositi(db as unknown as Ex);
    const limite = limitiDi(req).scrive;
    res.json(await assegnaVettura({ giorno, vssId, turnoMacchina, vettura }, { id: utente(req).userId }, catalogo,
      (codice) => scriveSulDeposito(limite, codice)));
  } catch (e) { rispondiVetture(res, e, "assegna vettura"); }
});

router.delete("/roster/vetture", async (req, res): Promise<void> => {
  try {
    const giorno = String(req.query.giorno ?? ""), vssId = String(req.query.vssId ?? ""), turnoMacchina = String(req.query.turnoMacchina ?? "");
    if (!dataVera(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
    const catalogo = await leggiDepositi(db as unknown as Ex);
    const limite = limitiDi(req).scrive;
    res.json(await togliVettura({ giorno, vssId, turnoMacchina }, catalogo, (codice) => scriveSulDeposito(limite, codice)));
  } catch (e) { rispondiVetture(res, e, "togli vettura"); }
});

/**
 * Assegna un turno a un conducente. Un conducente può avere più turni in un
 * giorno; il turno resta però di un solo conducente (UNIQUE dss_id/day/
 * duty_code): riassegnarlo lo sposta sul nuovo conducente.
 *
 * Lo SNAPSHOT del turno (orari, anche in minuti) resta con l'assegnazione:
 * lo storico e i controlli sui riposi funzionano anche se il DSS viene
 * versionato o il turno rinumerato.
 */
/**
 * Un turno a un conducente, con tutti i controlli: il deposito di chi scrive,
 * il conducente in servizio quel giorno, il turno pubblicato, i riposi e le
 * sovrapposizioni (forzabili con `forzate`), la sostituzione per assenza del
 * titolare. La usano l'assegnazione a mano e «Copri gli scoperti» (7.6).
 */
async function eseguiAssegnazione(req: Request, p: {
  driverId: string; dssId: string; day: string; dutyCode: string; forzate: Set<string>; sostituisce: string | null;
}): Promise<{ id: string; violazioni: Violazione[] }> {
  const { driverId, dssId, day, dutyCode, forzate, sostituisce } = p;
    const personale = vedeDatiPersonali(req);
    const chi = utente(req);
    /* fuori dalla transazione, con db: orari e tipi dei turni intorno al giorno e del turno nuovo */
    const preparato = await preparaControllo([driverId], [day], [{ dssId, codice: dutyCode }]);
    const snapshot = snapshotDa(preparato.orari.get(`${dssId}|${dutyCode}`));
  return db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      await iniziaScrittura(ex);
      const [conducente] = await bloccaConducenti(ex, [driverId]);
      await richiedeDeposito(req, ex, [driverId]);
      controllaInServizio(conducente, day, personale);
      /* il canale unico: si assegnano solo turni pubblicati quel giorno */
      await controllaPubblicato(ex, day, dssId, dutyCode, "assegna");
      if (!snapshot) throw new Rifiuto(409, `Il turno ${dutyCode} non c'è in quei turni guida: il tabellone si ricarica`, { ricarica: true });
      /* «sostituisci»: l'assegnazione da riassegnare dello stesso conducente e giorno se ne va qui */
      if (sostituisce) {
        const vecchia = righe(await ex.execute(sql`
          SELECT id::text, driver_id::text, day::text AS day, dss_id::text, duty_code FROM roster_assignments
           WHERE id = ${sostituisce}::uuid FOR UPDATE`))[0];
        if (!vecchia || vecchia.driver_id !== driverId || String(vecchia.day).slice(0, 10) !== day
          || (await statoNelCanale(ex, day, vecchia.dss_id)) !== "non_pubblicato") {
          throw new Rifiuto(409, "Il turno da sostituire non è più da riassegnare: il tabellone si ricarica", { ricarica: true });
        }
        await ex.execute(sql`DELETE FROM roster_assignments WHERE id = ${sostituisce}::uuid`);
        await registra(ex, { ...chi, driverId, azione: "turno-sostituito", campi: ["turno"], dettaglio: { day, da: { dssId: vecchia.dss_id, codice: vecchia.duty_code }, a: { dssId, codice: dutyCode } } });
      }
      const prima = righe(await ex.execute(sql`
        SELECT id::text, driver_id::text, snapshot, titolare_id::text FROM roster_assignments
         WHERE dss_id = ${dssId}::uuid AND day = ${day}::date AND duty_code = ${dutyCode}
           FOR UPDATE`))[0];
      if (prima?.driver_id === driverId) return { id: prima.id as string, violazioni: [] as Violazione[] };
      /* il turno è già di un altro conducente: assegnarlo qui glielo toglie, quindi serve scrivere anche sul suo deposito */
      if (prima?.driver_id) await richiedeDeposito(req, ex, [prima.driver_id]);
      const violazioni = await violazioniDeiCambi(ex, [
        { id: prima?.id ?? null, driverId, day, dssId, dutyCode, snapshot: prima?.snapshot ?? snapshot },
      ], preparato, inSavepoint(tx));
      controllaForzatura(violazioni, forzate);
      const forzatura = violazioni.length ? forzaturaDa(chi.userId, violazioni) : null;
      /* sostituzione per assenza (5.1): il titolare (quello di prima, o il primo di una catena di sostituti) è assente quel giorno */
      const titolare: string | null = prima ? (prima.titolare_id ?? prima.driver_id) : null;
      const perAssenza = !!titolare && titolare !== driverId && (await assentiNelGiorno(ex, [titolare], day)).has(titolare);
      const sostituzione = perAssenza ? { da: chi.userId, il: new Date().toISOString(), motivo: "assenza" } : null;
      const r = righe(await ex.execute(sql`
        INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot, forzatura)
        VALUES (${driverId}::uuid, ${day}::date, ${dssId}::uuid, ${dutyCode},
                ${snapshot ? JSON.stringify(snapshot) : null}::jsonb, ${forzatura ? JSON.stringify(forzatura) : null}::jsonb)
        ON CONFLICT (dss_id, day, duty_code)
        DO UPDATE SET driver_id = EXCLUDED.driver_id,
                      snapshot = COALESCE(roster_assignments.snapshot, EXCLUDED.snapshot),
                      forzatura = EXCLUDED.forzatura,
                      titolare_id = ${perAssenza ? titolare : null}::uuid,
                      sostituzione = ${sostituzione ? JSON.stringify(sostituzione) : null}::jsonb
        RETURNING id::text`));
      if (perAssenza) {
        await registra(ex, { ...chi, driverId, azione: "turno-sostituzione", campi: ["turno"], dettaglio: { day, dssId, codice: dutyCode, titolare, motivo: "assenza" } });
      }
      if (forzatura) {
        await registra(ex, { ...chi, driverId, azione: "turno-forzato", campi: forzatura.regole, dettaglio: { dutyCode, day, dssId, testi: forzatura.testi } });
      }
      return { id: r[0]?.id as string, violazioni };
    });
}

router.post("/roster/assignments", async (req, res): Promise<void> => {
  try {
    const corpo = req.body ?? {};
    const driverId = typeof corpo.driverId === "string" ? corpo.driverId.toLowerCase() : "";
    const dssId = typeof corpo.dssId === "string" ? corpo.dssId.toLowerCase() : "";
    const day = String(corpo.day ?? "");
    const dutyCode = typeof corpo.dutyCode === "string" ? corpo.dutyCode.trim() : "";
    if (!UUID_STRETTO.test(driverId) || !UUID_STRETTO.test(dssId) || !DATE_RE.test(day) || !dutyCode || dutyCode.length > 100) {
      res.status(400).json({ error: "driverId e dssId (uuid), day (YYYY-MM-DD) e dutyCode richiesti" });
      return;
    }
    const forzate = viste(corpo);
    const sostituisce = typeof corpo.sostituisce === "string" && UUID_STRETTO.test(corpo.sostituisce.toLowerCase()) ? corpo.sostituisce.toLowerCase() : null;
    const esito = await eseguiAssegnazione(req, { driverId, dssId, day, dutyCode, forzate, sostituisce });
    res.status(201).json({ ok: true, id: esito.id, forzato: esito.violazioni.length > 0 });
  } catch (e: any) { rispondiErrore(res, e, "assegnazione turno"); }
});

/**
 * Lo scambio (o la cessione, senza «a») di due turni dello stesso giorno fra
 * due conducenti, con tutti i controlli: lo usano «Cambio turno» e
 * «Bilancia i carichi» (7.7). Lancia Rifiuto se non si può.
 */
async function eseguiScambio(req: Request, p: {
  da: string; daConducente: string; a: string | null; aConducente: string; dssVisto: string | null; forzate: Set<string>;
}) {
  const { da, daConducente, a, aConducente, dssVisto, forzate } = p;
  const conA = a !== null;
  const personale = vedeDatiPersonali(req);
  const chi = utente(req);
  /* fuori dalla transazione, con db: i due turni e quelli dei due conducenti intorno al giorno */
  const dueTurni = righe(await db.execute(sql`
    SELECT day::text AS day FROM roster_assignments
     WHERE id IN (${da}::uuid, ${conA ? a : da}::uuid)`));
  /* i due turni stanno già fra le assegnazioni dei due conducenti: si leggono dal DSS solo se lo snapshot non ha i minuti */
  const preparato = await preparaControllo([daConducente, aConducente], dueTurni.map(t => String(t.day).slice(0, 10)), []);
  return await db.transaction(async (tx) => {
    const ex = tx as unknown as Ex;
    await iniziaScrittura(ex);
    const conducenti = await bloccaConducenti(ex, [aConducente, daConducente]);
    /* lo scambio tocca il roster di tutti e due: devono essere tutti e due dei depositi di chi scrive */
    await richiedeDeposito(req, ex, [aConducente, daConducente]);
    const r = righe(await ex.execute(sql`
      SELECT id, driver_id, day::text AS day, dss_id::text, duty_code, snapshot
        FROM roster_assignments
       WHERE id IN (${da}::uuid, ${conA ? a : da}::uuid)
       ORDER BY id
         FOR UPDATE`));
    const ceduto = r.find(x => x.id === da);
    const ricevuto = conA ? r.find(x => x.id === a) : null;
    if (!ceduto || (conA && !ricevuto)) throw new Rifiuto(409, "Uno dei due turni non c'è più: il tabellone si ricarica", { ricarica: true });
    if (ceduto.driver_id !== daConducente || (ricevuto && ricevuto.driver_id !== aConducente)) {
      throw new Rifiuto(409, "Nel frattempo uno dei due turni è passato a un altro conducente: il tabellone si ricarica", { ricarica: true });
    }
    const giorno = String(ceduto.day).slice(0, 10);
    if (ricevuto && String(ricevuto.day).slice(0, 10) !== giorno) {
      throw new Rifiuto(400, "Si scambiano solo turni dello stesso giorno");
    }
    /* il canale unico: un turno non più pubblicato quel giorno non passa a un altro, si toglie o si sostituisce */
    await controllaPubblicato(ex, giorno, ceduto.dss_id, ceduto.duty_code, "sposta");
    if (ricevuto) await controllaPubblicato(ex, giorno, ricevuto.dss_id, ricevuto.duty_code, "sposta");
    const quando = giorno.split("-").reverse().join("/");
    const nomeDi = (id: string) => nomeConducente(conducenti.find(x => x.id === id));
    /* senza turno in cambio, chi riceve quel giorno non aveva turni, fra quelli
       che l'utente vedeva: se intanto ne ha ricevuto uno, voleva uno scambio e
       non un turno in più. Un turno di un altro DSS, che il tabellone per DSS
       non mostra, non conta: avere più turni nello stesso giorno si può. */
    if (!ricevuto) {
      const gia = righe(await ex.execute(sql`
        SELECT duty_code FROM roster_assignments
         WHERE driver_id = ${aConducente}::uuid AND day = ${giorno}::date
           AND (${dssVisto}::uuid IS NULL OR dss_id = ${dssVisto}::uuid)
         LIMIT 1`));
      if (gia.length) {
        throw new Rifiuto(409, `${nomeDi(aConducente)} nel frattempo ha ricevuto ${gia[0].duty_code} il ${quando}: il tabellone si ricarica`, { ricarica: true });
      }
    }
    /* chi riceve un turno dev'essere in servizio quel giorno */
    for (const id of ricevuto ? [aConducente, daConducente] : [aConducente]) {
      controllaInServizio(conducenti.find(x => x.id === id), giorno, personale);
    }
    /* riposi e sovrapposizioni dopo lo scambio, per tutti e due */
    const cambi = [
      { id: da as string, driverId: aConducente as string, day: giorno, dssId: ceduto.dss_id, dutyCode: ceduto.duty_code, snapshot: ceduto.snapshot },
      ...(ricevuto ? [{ id: a as string, driverId: daConducente as string, day: giorno, dssId: ricevuto.dss_id, dutyCode: ricevuto.duty_code, snapshot: ricevuto.snapshot }] : []),
    ];
    const violazioni = await violazioniDeiCambi(ex, cambi, preparato, inSavepoint(tx));
    controllaForzatura(violazioni, forzate);
    /* il segno della forzatura va sul turno spostato che viola; gli altri lo perdono, cambiato il conducente */
    const forzaturaDi = (dssId: string, codice: string) => {
      const sue = violazioni.filter(v => v.turni.some(t => t.dssId === dssId && t.codice === codice && t.giorno === giorno));
      return sue.length ? forzaturaDa(chi.userId, sue) : null;
    };
    const fCeduto = forzaturaDi(ceduto.dss_id, ceduto.duty_code);
    await ex.execute(sql`UPDATE roster_assignments SET driver_id = ${aConducente}::uuid,
      forzatura = ${fCeduto ? JSON.stringify(fCeduto) : null}::jsonb WHERE id = ${da}::uuid`);
    if (fCeduto) await registra(ex, { ...chi, driverId: aConducente, azione: "turno-forzato", campi: fCeduto.regole, dettaglio: { dutyCode: ceduto.duty_code, day: giorno, dssId: ceduto.dss_id, testi: fCeduto.testi, scambio: true } });
    if (ricevuto) {
      const fRicevuto = forzaturaDi(ricevuto.dss_id, ricevuto.duty_code);
      await ex.execute(sql`UPDATE roster_assignments SET driver_id = ${daConducente}::uuid,
        forzatura = ${fRicevuto ? JSON.stringify(fRicevuto) : null}::jsonb WHERE id = ${a}::uuid`);
      if (fRicevuto) await registra(ex, { ...chi, driverId: daConducente, azione: "turno-forzato", campi: fRicevuto.regole, dettaglio: { dutyCode: ricevuto.duty_code, day: giorno, dssId: ricevuto.dss_id, testi: fRicevuto.testi, scambio: true } });
    }
    return {
      forzato: violazioni.length > 0,
      giorno,
      ceduto: { id: da, dutyCode: ceduto.duty_code, driverId: aConducente },
      ricevuto: ricevuto ? { id: a, dutyCode: ricevuto.duty_code, driverId: daConducente } : null,
    };
  });
}

/**
 * Cambio turno: due conducenti si scambiano i turni dello stesso giorno.
 *   { da, daConducente, a?, aConducente, dssVisto? }
 * «da» è l'assegnazione che il primo conducente cede; «a», se c'è, quella che
 * riceve in cambio. Senza «a» il turno passa e basta: il secondo conducente
 * quel giorno non aveva turni da dare.
 *
 * Le righe si bloccano e si ricontrollano: se nel frattempo qualcuno ha già
 * spostato uno dei due turni, o senza «a» il secondo conducente ha ricevuto un
 * turno quel giorno, 409 e il tabellone si ricarica. Riceve un turno solo chi
 * è in servizio quel giorno (attivo, assunto, non ancora uscito); a chi non
 * vede i dati personali non si dice se non è ancora assunto o se è uscito,
 * perché la data di assunzione per lui è mascherata.
 *
 * Se dopo lo scambio uno dei due resta con un riposo troppo corto o con due
 * turni sovrapposti, 409 forzabile; con forza: [chiavi viste] si scambia lo stesso.
 */
router.post("/roster/assignments/scambia", async (req, res): Promise<void> => {
  try {
    const corpo = req.body ?? {};
    /* minuscole: si confrontano con gli uuid che restituisce Postgres */
    const [da, daConducente, a, aConducente] = [corpo.da, corpo.daConducente, corpo.a, corpo.aConducente]
      .map(v => (typeof v === "string" ? v.toLowerCase() : v));
    const conA = a !== undefined && a !== null && a !== "";
    const uuid = (v: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(v ?? ""));
    /* il DSS del tabellone che l'utente guardava (null: tutti i turni, AUTO o nessun DSS) */
    const dssVisto = typeof corpo.dssVisto === "string" && corpo.dssVisto ? corpo.dssVisto.toLowerCase() : null;
    if (![da, daConducente, aConducente].every(uuid) || (conA && !uuid(a)) || (dssVisto !== null && !uuid(dssVisto))) {
      res.status(400).json({ error: "da, daConducente e aConducente (uuid) richiesti; a e dssVisto facoltativi" }); return;
    }
    if (daConducente === aConducente) { res.status(400).json({ error: "Lo scambio è fra due conducenti diversi" }); return; }
    if (conA && a === da) { res.status(400).json({ error: "Lo scambio è fra due turni diversi" }); return; }

    const esito = await eseguiScambio(req, { da, daConducente, a: conA ? a : null, aConducente, dssVisto, forzate: viste(corpo) });
    res.json({ ok: true, ...esito });
  } catch (e: any) { rispondiErrore(res, e, "scambio turni"); }
});

// ── Voci Assenza / Presenza ───────────────────────────────────────────────────

router.get("/roster/voci", async (req, res): Promise<void> => {
  try { res.json({ catalog: catalogoPer(vedeCodiciSanitari(req), await leggiCatalogo(db as unknown as Ex)) }); }
  catch (e) { rispondiErrore(res, e, "catalogo delle voci"); }
});

router.post("/roster/entries", async (req, res): Promise<void> => {
  try {
    const { driverId, day, category, code } = req.body ?? {};
    if (!driverId || !UUID_RE.test(String(driverId)) || !DATE_RE.test(String(day ?? ""))) {
      res.status(400).json({ error: "driverId (uuid) e day (YYYY-MM-DD) richiesti" }); return;
    }
    const esito = esitoScrittura(category, code, vedeCodiciSanitari(req), await leggiCatalogo(db as unknown as Ex));
    if (esito === "non-valido") { res.status(400).json({ error: "categoria o codice voce non validi" }); return; }
    if (esito === "spenta") { res.status(400).json({ error: "Questa voce è spenta nel catalogo: non si scrive più" }); return; }
    if (esito === "riservato") {
      res.status(403).json({ error: "Malattia, infortunio e 104 li scrive solo chi ha il permesso Roster: usa «ASS – Assenza»" }); return;
    }
    await richiedeDeposito(req, db as unknown as Ex, [driverId]);
    const r = await db.execute<any>(sql`
      INSERT INTO roster_entries (driver_id, day, category, code)
      VALUES (${driverId}::uuid, ${day}::date, ${category}, ${code})
      ON CONFLICT (driver_id, day, code) DO UPDATE SET category = EXCLUDED.category
      RETURNING id
    `);
    res.status(201).json({ ok: true, id: r.rows[0]?.id });
  } catch (e: any) {
    if (e instanceof Rifiuto) { rispondiErrore(res, e, "voce"); return; }
    res.status(500).json({ error: e.message });
  }
});

router.delete("/roster/entries/:id", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    /* di chi è la voce: serve solo a chi ha dei depositi, gli altri non leggono niente in più */
    const voce = righe(await db.execute(sql`SELECT driver_id::text FROM roster_entries WHERE id = ${id}::uuid`))[0];
    if (voce) await richiedeDeposito(req, db as unknown as Ex, [voce.driver_id]);
    await db.execute(sql`DELETE FROM roster_entries WHERE id = ${id}::uuid`);
    res.json({ ok: true });
  } catch (e: any) {
    if (e instanceof Rifiuto) { rispondiErrore(res, e, "togli voce"); return; }
    res.status(500).json({ error: e.message });
  }
});

router.delete("/roster/assignments/:id", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id).toLowerCase();
    if (!UUID_STRETTO.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    /* anche togliere aspetta una pubblicazione in corso: il ricollegamento lavora su queste righe */
    await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      await iniziaScrittura(ex);
      const turno = righe(await ex.execute(sql`SELECT driver_id::text FROM roster_assignments WHERE id = ${id}::uuid FOR UPDATE`))[0];
      if (turno) await richiedeDeposito(req, ex, [turno.driver_id]);
      await ex.execute(sql`DELETE FROM roster_assignments WHERE id = ${id}::uuid`);
    });
    res.json({ ok: true });
  } catch (e: any) { rispondiErrore(res, e, "togli turno"); }
});

export default router;
