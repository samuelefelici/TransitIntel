/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — assegnazione turni guida al personale viaggiante
 * ───────────────────────────────────────────────────────────────────────────
 * Tabellone: righe = conducenti (anche fittizi), colonne = giorni. I turni da
 * coprire arrivano dai turni guida salvati (driver_shift_scenarios.result.
 * driverShifts, prodotti dallo Scheduling Engine): per ogni giorno i turni non
 * ancora assegnati sono gli "scoperti".
 *
 *   GET    /api/roster/duty-sources            — DSS disponibili come fonte turni
 *   GET    /api/roster/board?from=&days=&dssId=— griglia: turni, assegnazioni, voci
 *   POST   /api/roster/assignments             — assegna {driverId, day, dutyCode, dssId}
 *   POST   /api/roster/assignments/scambia     — cambio turno fra due conducenti, stesso giorno
 *   DELETE /api/roster/assignments/:id         — rimuovi assegnazione
 *   GET    /api/roster/voci                    — catalogo assenze/presenze
 *   GET    /api/roster/calendario?from=&days=  — la categoria di ogni giorno nel calendario aziendale
 *   POST   /api/roster/entries · DELETE /api/roster/entries/:id
 *
 * I conducenti (anagrafica, storico, fittizi) stanno in routes/anagrafica.ts.
 *
 * Vincoli: un turno è coperto da un solo conducente al giorno (per la stessa
 * fonte DSS); un conducente può fare più turni nello stesso giorno.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { driverScenariosAccessibleWhere, requireDriverScenarioRead } from "../lib/scenario-access";
import { assicuraAnagrafica, leggiDepositi, righe, type Ex } from "../lib/anagrafica-store";
import { conducentiPer, Rifiuto, rispondiErrore } from "./anagrafica";
import { abbinaColori, depositiPlanner, type DepositoColorato } from "../lib/roster-colori-depositi";
import { trovaDeposito, type Conducente } from "../lib/anagrafica-campi";
import { vedeDatiPersonali } from "../lib/auth";
import { calendarioPredefinito, loadCalendarProfile } from "../lib/planning-studio-calendar";
import { classifyRange, type CalendarProfile } from "../lib/day-classifier";

const router: IRouter = Router();

/* Le tabelle del roster (conducenti, assegnazioni, storico, voci) le crea
 * l'anagrafica del personale: lib/anagrafica-store.ts. */

/** Catalogo voci Assenza/Presenza. Estendibile: aggiungi qui nuovi codici. */
const VOCI_CATALOG: Record<"assenza" | "presenza", Array<{ code: string; label: string }>> = {
  assenza: [
    { code: "R",   label: "Riposo" },
    { code: "MA3", label: "Malattia primi 3 giorni" },
    { code: "MA",  label: "Malattia giorni successivi" },
    { code: "I",   label: "Infortunio" },
    { code: "PAD", label: "Permesso 104" },
  ],
  presenza: [
    { code: "STRA", label: "Straordinario" },
    { code: "D1",   label: "Disposizione mattinale" },
    { code: "D2",   label: "Disposizione pomeridiana" },
    { code: "DISP", label: "Disposizione" },
    { code: "DAM1", label: "Controllerie mattinali" },
    { code: "DAM2", label: "Controllerie pomeridiane" },
  ],
};
const VOCE_CODES: Record<string, Set<string>> = {
  assenza: new Set(VOCI_CATALOG.assenza.map((v) => v.code)),
  presenza: new Set(VOCI_CATALOG.presenza.map((v) => v.code)),
};

router.use(async (req, res, next) => {
  if (!req.path.toLowerCase().startsWith("/roster")) { next(); return; }
  try { await assicuraAnagrafica(); }
  catch { res.status(503).json({ error: "Roster non disponibile: riprova tra poco" }); return; }
  next();
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

interface DutySegment {
  type: string;                 // trip | deadhead | depot | riserva …
  line: string | null;          // linea (route) — null per fuorilinea/attività
  startTime: string | null; startPlace: string | null;
  endTime: string | null;   endPlace: string | null;
}
const _hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;

/** Estrae i turni guida dal result JSON di un DSS (formato crew_scheduler_v4). */
function extractDuties(result: any): Array<{
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
  interruption: string | null; ripreseCount: number; tripsCount: number; costEuro: number | null;
  residenzaName: string | null; residenzaColor: string | null;
  segments: DutySegment[];
}> {
  const list = result?.driverShifts ?? result?.duties ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((d: any, i: number) => {
    const riprese = Array.isArray(d.riprese) ? d.riprese : [];
    const tripsCount = riprese.reduce(
      (s: number, r: any) => s + (Array.isArray(r?.trips) ? r.trips.filter((t: any) => (t?.type ?? "trip") === "trip").length : 0),
      0,
    );
    // Contenuto del turno: ogni tratta con linea, orari e luoghi (anche fuorilinea).
    const segments: DutySegment[] = [];
    for (const r of riprese) {
      for (const t of (Array.isArray(r?.trips) ? r.trips : [])) {
        segments.push({
          type: t?.type ?? "trip",
          line: t?.routeName ?? t?.routeShortName ?? (t?.routeId || null),
          startTime: t?.departureTime ?? (typeof t?.departureMin === "number" ? _hhmm(t.departureMin) : null),
          startPlace: t?.firstStopName ?? null,
          endTime: t?.arrivalTime ?? (typeof t?.arrivalMin === "number" ? _hhmm(t.arrivalMin) : null),
          endPlace: t?.lastStopName ?? null,
        });
      }
    }
    return {
      code: String(d.driverId ?? d.dutyId ?? d.id ?? `T${i + 1}`),
      type: d.type ?? d.dutyType ?? null,
      start: d.nastroStart ?? d.startTime ?? null,
      end: d.nastroEnd ?? d.endTime ?? null,
      nastro: d.nastro ?? null,
      work: d.work ?? null,
      interruption: d.interruption ?? null,
      ripreseCount: riprese.length,
      tripsCount,
      costEuro: typeof d.costEuro === "number" ? d.costEuro : null,
      // Residenza per-turno (dal turno macchina, propagata dal crew scheduler)
      residenzaName: d.residenzaName ?? null,
      residenzaColor: d.residenzaColor ?? null,
      segments,
    };
  });
}

// Conducenti, storico, fittizi: routes/anagrafica.ts (montato prima di questo router).

/** I depositi dei turni con il loro colore, come li vede l'utente nelle celle. */
function residenzeDeiTurni(duties: ReturnType<typeof extractDuties>): DepositoColorato[] {
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
    const dssId = String(req.query.dssId ?? "");

    let psProjectId: string | null = null;
    let scelto: "indicato" | "dai turni" | "in esercizio" | "riconosciuto" | "assente" = "assente";
    if (UUID_RE.test(richiesto)) { psProjectId = richiesto; scelto = "indicato"; }
    if (!psProjectId && UUID_RE.test(dssId)) {
      try {
        const r = await db.execute<any>(sql`
          SELECT sp.planning_studio_project_id AS id
            FROM driver_shift_scenarios d
            JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
            JOIN scheduling_projects sp ON sp.id = s.project_id
           WHERE d.id = ${dssId}::uuid AND sp.planning_studio_project_id IS NOT NULL`);
        if (r.rows[0]?.id) { psProjectId = r.rows[0].id; scelto = "dai turni"; }
      } catch { /* collegamento non leggibile: si va avanti */ }
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
    res.json({ sources: r.rows.map((x: any) => ({
      dssId: x.id, name: x.name, scenarioName: x.scenario_name,
      scenarioDate: x.scenario_date, dutyCount: Number(x.duty_count ?? 0),
      isOperational: !!x.is_operational,
      validityUnitId: x.validity_unit_id ?? null, validityUnitName: x.unit_name ?? null,
      createdAt: x.created_at,
    })) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Tabellone ────────────────────────────────────────────────────────────────

router.get("/roster/board", async (req, res): Promise<void> => {
  try {
    const from = String(req.query.from ?? "");
    if (!DATE_RE.test(from)) { res.status(400).json({ error: "from=YYYY-MM-DD richiesto" }); return; }
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
    const dssId = String(req.query.dssId ?? "");

    const dayList: string[] = [];
    const d0 = new Date(`${from}T00:00:00Z`);
    for (let i = 0; i < days; i++) {
      dayList.push(new Date(d0.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    }

    /* i conducenti come li può vedere chi chiede: senza «personale», solo i dati operativi */
    const drivers = await conducentiPer(req, db as unknown as Ex);

    // ── Modalità AUTO (dssId = "auto"): risoluzione del DSS competente PER
    // DATA usando i periodi valid_from/valid_to (P5). La settimana a cavallo
    // di un cambio turni diventa visibile in un'unica board: giorni < X sul
    // DSS vecchio, giorni ≥ X sul nuovo. I duty arrivano raggruppati per DSS.
    if (dssId === "auto") {
      const userId = (req as any).user?.id ?? null;
      const assignAll = await db.execute<any>(sql`
        SELECT a.id, a.driver_id, a.day::text AS day, a.duty_code, a.dss_id, a.snapshot
        FROM roster_assignments a
        WHERE a.day >= ${from}::date AND a.day < ${from}::date + (${days} * interval '1 day')
      `);
      // candidati = DSS referenziati dalle assegnazioni nel range ∪ DSS con
      // periodo che interseca la finestra o attualmente operativi (accessibili)
      const candQ = await db.execute<any>(sql`
        SELECT d.id, d.result, COALESCE(d.is_operational, false) AS is_operational,
               to_char(d.valid_from, 'YYYY-MM-DD') AS valid_from,
               to_char(d.valid_to,   'YYYY-MM-DD') AS valid_to,
               d.created_at
          FROM driver_shift_scenarios d
         WHERE (d.owner_user_id = ${userId}::uuid OR d.owner_user_id IS NULL)
           AND (
             d.id IN (SELECT DISTINCT dss_id FROM roster_assignments
                       WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day'))
             OR COALESCE(d.is_operational, false) = true
             OR (d.valid_from IS NOT NULL AND d.valid_from < ${from}::date + (${days} * interval '1 day')
                 AND (d.valid_to IS NULL OR d.valid_to >= ${from}::date))
           )
      `);
      const cands = (candQ.rows ?? []) as any[];
      const dutiesByDss: Record<string, ReturnType<typeof extractDuties>> = {};
      for (const c of cands) dutiesByDss[c.id] = extractDuties(c.result);
      // per ogni giorno: il DSS il cui periodo copre la data (preferendo
      // l'operativo, poi il più recente); null = nessun turno competente
      const dssByDay: Record<string, string | null> = {};
      for (const d of dayList) {
        const covering = cands.filter((c) =>
          c.valid_from && c.valid_from <= d && (!c.valid_to || c.valid_to >= d));
        covering.sort((a, b) => (Number(b.is_operational) - Number(a.is_operational))
          || String(b.created_at).localeCompare(String(a.created_at)));
        dssByDay[d] = covering[0]?.id ?? null;
      }
      const entriesA = await db.execute<any>(sql`
        SELECT id, driver_id, day::text AS day, category, code, source
          FROM roster_entries
         WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day')
      `);
      /* il colore dei turni dai DSS che si vedono, dal giorno più recente indietro
         (il più aggiornato vince), poi quelli delle assegnazioni; gli altri candidati no */
      const visibili = [...new Set<string>([
        ...[...dayList].reverse().map(d => dssByDay[d]).filter((x): x is string => !!x),
        ...assignAll.rows.map((a: any) => String(a.dss_id)),
      ])];
      const dep = await depositiDelTabellone(drivers, visibili.flatMap(id => residenzeDeiTurni(dutiesByDss[id] ?? [])));
      res.json({
        from, days: dayList,
        drivers: dep.drivers,
        duties: [], residenza: null,
        depositi: dep.depositi,
        dutiesByDss, dssByDay,
        assignments: assignAll.rows.map((a: any) => ({
          id: a.id, driverId: a.driver_id, day: a.day.slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id,
          snapshot: a.snapshot ?? null,
        })),
        entries: entriesA.rows.map((e: any) => ({
          id: e.id, driverId: e.driver_id, day: e.day.slice(0, 10), category: e.category, code: e.code,
          source: e.source ?? null,
        })),
      });
      return;
    }

    let duties: ReturnType<typeof extractDuties> = [];
    if (dssId) {
      // IDOR fix: verifica che l'utente possa leggere QUESTO scenario turni
      // prima di esporne i duty (codici, orari, costi, residenze).
      if (!UUID_RE.test(dssId)) { res.status(400).json({ error: "dssId non valido" }); return; }
      const acc = await requireDriverScenarioRead(req, res, dssId);
      if (!acc) return;
      const dssQ = await db.execute<any>(sql`
        SELECT result FROM driver_shift_scenarios WHERE id = ${dssId}::uuid LIMIT 1
      `);
      duties = extractDuties(dssQ.rows[0]?.result);
    }

    const assignQ = await db.execute<any>(sql`
      SELECT a.id, a.driver_id, a.day::text AS day, a.duty_code, a.dss_id
      FROM roster_assignments a
      WHERE a.day >= ${from}::date AND a.day < ${from}::date + (${days} * interval '1 day')
        AND (${dssId}::text = '' OR a.dss_id = ${dssId || "00000000-0000-0000-0000-000000000000"}::uuid)
    `);

    // Residenza di servizio = deposito dello scenario turni-macchina collegato al
    // DSS. I turni del Roster vengono colorati con il colore del deposito.
    let residenza: { name: string; color: string } | null = null;
    if (dssId) {
      try {
        const depR = await db.execute<any>(sql`
          SELECT dep.name, dep.color
            FROM driver_shift_scenarios d
            JOIN service_program_scenarios s ON s.id = d.service_program_scenario_id
            JOIN depots dep ON dep.id = s.depot_id
           WHERE d.id = ${dssId}::uuid LIMIT 1`);
        const dep = depR.rows?.[0];
        if (dep) residenza = { name: dep.name, color: dep.color || "#3b82f6" };
      } catch { /* depot_id può non esistere su scenari vecchi */ }
    }

    // Voci Assenza/Presenza nel range (indipendenti dal DSS selezionato).
    const entriesQ = await db.execute<any>(sql`
      SELECT id, driver_id, day::text AS day, category, code, source
        FROM roster_entries
       WHERE day >= ${from}::date AND day < ${from}::date + (${days} * interval '1 day')
    `);

    const dep = await depositiDelTabellone(drivers, [...residenzeDeiTurni(duties), ...(residenza ? [residenza] : [])]);
    res.json({
      from, days: dayList,
      drivers: dep.drivers,
      duties,
      residenza,
      depositi: dep.depositi,
      assignments: assignQ.rows.map((a: any) => ({
        id: a.id, driverId: a.driver_id, day: a.day.slice(0, 10), dutyCode: a.duty_code, dssId: a.dss_id,
      })),
      entries: entriesQ.rows.map((e: any) => ({
        id: e.id, driverId: e.driver_id, day: e.day.slice(0, 10), category: e.category, code: e.code,
        source: e.source ?? null,
      })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/roster/assignments", async (req, res): Promise<void> => {
  try {
    const { driverId, day, dutyCode, dssId } = req.body ?? {};
    if (!driverId || !DATE_RE.test(String(day ?? "")) || !dutyCode || !dssId) {
      res.status(400).json({ error: "driverId, day (YYYY-MM-DD), dutyCode e dssId richiesti" });
      return;
    }
    // SNAPSHOT del turno al momento dell'assegnazione: inizio/fine/ore pagate/
    // nome, così lo storico resta leggibile anche se il DSS viene versionato
    // (P5) o il duty rinumerato. Best-effort: mai bloccare l'assegnazione.
    let snapshot: string | null = null;
    try {
      const dQ = await db.execute<any>(sql`
        SELECT result FROM driver_shift_scenarios WHERE id = ${dssId}::uuid LIMIT 1`);
      const duty = extractDuties(dQ.rows[0]?.result).find((x: any) => String(x.code) === String(dutyCode));
      if (duty) {
        snapshot = JSON.stringify({
          start: (duty as any).start ?? null, end: (duty as any).end ?? null,
          paidHours: (duty as any).paidHours ?? null, name: (duty as any).name ?? null,
        });
      }
    } catch { /* snapshot facoltativo */ }
    // Un conducente può avere più turni in un giorno. Il turno resta però
    // assegnabile a un solo conducente (UNIQUE dss_id/day/duty_code): riassegnarlo
    // lo sposta sul nuovo conducente.
    const r = await db.execute<any>(sql`
      INSERT INTO roster_assignments (driver_id, day, dss_id, duty_code, snapshot)
      VALUES (${driverId}::uuid, ${day}::date, ${dssId}::uuid, ${dutyCode}, ${snapshot}::jsonb)
      ON CONFLICT (dss_id, day, duty_code)
      DO UPDATE SET driver_id = EXCLUDED.driver_id,
                    snapshot = COALESCE(roster_assignments.snapshot, EXCLUDED.snapshot)
      RETURNING id
    `);
    res.status(201).json({ ok: true, id: r.rows[0]?.id });
  } catch (e: any) {
    if (String(e.message).includes("roster_assignments_dss_id_day_duty_code_key")) {
      res.status(409).json({ error: "Turno già assegnato a un altro operatore in quel giorno" });
      return;
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * Cambio turno: due conducenti si scambiano i turni dello stesso giorno.
 *   { da, daConducente, a?, aConducente }
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
 */
router.post("/roster/assignments/scambia", async (req, res): Promise<void> => {
  try {
    const corpo = req.body ?? {};
    /* minuscole: si confrontano con gli uuid che restituisce Postgres */
    const [da, daConducente, a, aConducente] = [corpo.da, corpo.daConducente, corpo.a, corpo.aConducente]
      .map(v => (typeof v === "string" ? v.toLowerCase() : v));
    const conA = a !== undefined && a !== null && a !== "";
    const uuid = (v: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(v ?? ""));
    if (![da, daConducente, aConducente].every(uuid) || (conA && !uuid(a))) {
      res.status(400).json({ error: "da, daConducente e aConducente (uuid) richiesti; a facoltativo" }); return;
    }
    if (daConducente === aConducente) { res.status(400).json({ error: "Lo scambio è fra due conducenti diversi" }); return; }
    if (conA && a === da) { res.status(400).json({ error: "Lo scambio è fra due turni diversi" }); return; }

    const personale = vedeDatiPersonali(req);
    const esito = await db.transaction(async (tx) => {
      const ex = tx as unknown as Ex;
      /* Prima i conducenti, poi i turni, sempre in ordine di id: è l'ordine della
         disattivazione e dell'import, così nessuno resta ad aspettare l'altro.
         FOR SHARE aspetta chi sta cambiando il conducente (disattivazione, data
         di uscita) e poi legge il dato già salvato, non quello di prima. */
      const conducenti = righe(await ex.execute(sql`
        SELECT id, cognome, nome, name, is_active,
               to_char(data_assunzione, 'YYYY-MM-DD') AS dal, to_char(data_fine_servizio, 'YYYY-MM-DD') AS al
          FROM roster_drivers
         WHERE id IN (${aConducente}::uuid, ${daConducente}::uuid)
         ORDER BY id
           FOR SHARE`));
      const r = righe(await ex.execute(sql`
        SELECT id, driver_id, day::text AS day, duty_code
          FROM roster_assignments
         WHERE id IN (${da}::uuid, ${conA ? a : da}::uuid)
         ORDER BY id
           FOR UPDATE`));
      const ceduto = r.find(x => x.id === da);
      const ricevuto = conA ? r.find(x => x.id === a) : null;
      if (!ceduto || (conA && !ricevuto)) throw new Rifiuto(409, "Uno dei due turni non c'è più: il tabellone si ricarica");
      if (ceduto.driver_id !== daConducente || (ricevuto && ricevuto.driver_id !== aConducente)) {
        throw new Rifiuto(409, "Nel frattempo uno dei due turni è passato a un altro conducente: il tabellone si ricarica");
      }
      const giorno = String(ceduto.day).slice(0, 10);
      if (ricevuto && String(ricevuto.day).slice(0, 10) !== giorno) {
        throw new Rifiuto(400, "Si scambiano solo turni dello stesso giorno");
      }
      const quando = giorno.split("-").reverse().join("/");
      const nomeDi = (id: string) => {
        const c = conducenti.find(x => x.id === id);
        return c ? ([c.cognome, c.nome].filter(Boolean).join(" ") || c.name) : "Il conducente";
      };
      /* senza turno in cambio, chi riceve quel giorno non aveva turni: se intanto
         ne ha ricevuto uno, l'utente voleva uno scambio e non un turno in più */
      if (!ricevuto) {
        const gia = righe(await ex.execute(sql`
          SELECT duty_code FROM roster_assignments
           WHERE driver_id = ${aConducente}::uuid AND day = ${giorno}::date
           LIMIT 1`));
        if (gia.length) {
          throw new Rifiuto(409, `${nomeDi(aConducente)} nel frattempo ha ricevuto ${gia[0].duty_code} il ${quando}: il tabellone si ricarica`);
        }
      }
      /* chi riceve un turno dev'essere in servizio quel giorno */
      for (const id of ricevuto ? [aConducente, daConducente] : [aConducente]) {
        const c = conducenti.find(x => x.id === id);
        const chi = nomeDi(id);
        if (!c || !c.is_active) throw new Rifiuto(409, `${chi} non è più fra i conducenti attivi`);
        const nonAncora = !!c.dal && c.dal > giorno, uscito = !!c.al && c.al < giorno;
        /* la data di uscita è un dato operativo; quella di assunzione no */
        if (nonAncora) throw new Rifiuto(409, personale ? `${chi} il ${quando} non è ancora assunto` : `${chi} il ${quando} non è in servizio`);
        if (uscito) throw new Rifiuto(409, `${chi} il ${quando} non è più in servizio`);
      }
      await ex.execute(sql`UPDATE roster_assignments SET driver_id = ${aConducente}::uuid WHERE id = ${da}::uuid`);
      if (ricevuto) await ex.execute(sql`UPDATE roster_assignments SET driver_id = ${daConducente}::uuid WHERE id = ${a}::uuid`);
      return {
        giorno,
        ceduto: { id: da, dutyCode: ceduto.duty_code, driverId: aConducente },
        ricevuto: ricevuto ? { id: a, dutyCode: ricevuto.duty_code, driverId: daConducente } : null,
      };
    });
    res.json({ ok: true, ...esito });
  } catch (e: any) { rispondiErrore(res, e, "scambio turni"); }
});

// ── Voci Assenza / Presenza ───────────────────────────────────────────────────

router.get("/roster/voci", async (_req, res): Promise<void> => {
  res.json({ catalog: VOCI_CATALOG });
});

router.post("/roster/entries", async (req, res): Promise<void> => {
  try {
    const { driverId, day, category, code } = req.body ?? {};
    if (!driverId || !UUID_RE.test(String(driverId)) || !DATE_RE.test(String(day ?? ""))) {
      res.status(400).json({ error: "driverId (uuid) e day (YYYY-MM-DD) richiesti" }); return;
    }
    if (category !== "assenza" && category !== "presenza") { res.status(400).json({ error: "category non valida" }); return; }
    if (!VOCE_CODES[category].has(String(code))) { res.status(400).json({ error: "codice voce non valido" }); return; }
    const r = await db.execute<any>(sql`
      INSERT INTO roster_entries (driver_id, day, category, code)
      VALUES (${driverId}::uuid, ${day}::date, ${category}, ${code})
      ON CONFLICT (driver_id, day, code) DO UPDATE SET category = EXCLUDED.category
      RETURNING id
    `);
    res.status(201).json({ ok: true, id: r.rows[0]?.id });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/entries/:id", async (req, res): Promise<void> => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) { res.status(400).json({ error: "ID non valido" }); return; }
    await db.execute(sql`DELETE FROM roster_entries WHERE id = ${id}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/roster/assignments/:id", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`DELETE FROM roster_assignments WHERE id = ${String(req.params.id)}::uuid`);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
