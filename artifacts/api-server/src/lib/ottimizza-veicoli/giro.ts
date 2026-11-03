/**
 * I giri di Argos (agent-optimize): il calcolo, il salvataggio dello scenario
 * (turni macchina e, in VCSP, turni guida) e la vista compatta del risultato
 * per la chat. Senza Express e senza DDL: la usano le rotte e il lavoratore
 * dei calcoli. La tabella agent_optimize_jobs c'è dalle migrazioni.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { Progresso } from "../lavori/python";
import { eseguiOttimizzazione, type ModoVeicoli } from "./esegui";

type LogGiro = { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

/** Un giro come lo registra agent_optimize_jobs (e la memoria dell'API, col flag a 0). */
export type AgentOptimizeJob = {
  id: string;
  userId: string;
  psProjectId: string;
  mode: ModoVeicoli;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
  progress: { phase: string; pct: number; msg: string };
  params: Record<string, any>;
  error?: string;
  result?: any;               // risposta COMPLETA (in memoria, per il salvataggio)
  scenarioId?: string | null;
  dssId?: string | null;
  scenarioName?: string;
};

/** Cosa serve per salvare lo scenario a fine giro: lo prepara la rotta, prima di accodare. */
export interface SalvataggioGiro {
  utenteId: string;
  psProjectId: string;
  /** il nome del progetto Planning Studio, per il nome di default dello scenario */
  psName: string;
  /** la data come l'ha scritta chi lancia (YYYY-MM-DD o YYYYMMDD) */
  rawDate: string;
  /** il feed del giro come l'ha risolto la rotta (UDP, esercizio o esplicito): va nello scenario */
  feedId: string;
  serviceType: string;
  routes: unknown[];
  depotsSel: unknown[] | null;
  schedProjectId: string | null;
  defaultVehicleType: string | null;
  saveScenario: boolean;
  scenarioName: string | null;
  /** quando il giro è stato chiesto (ms) */
  creatoIl: number;
}

/** La richiesta di un giro in coda (giro_agente v1). */
export interface RichiestaGiro {
  mode: ModoVeicoli;
  /** il feed del calcolo, già controllato per l'utente (getLatestFeedId nella rotta) */
  feedId: string;
  /** il corpo per eseguiOttimizzazione (runBody) */
  corpo: Record<string, any>;
  params: Record<string, any>;
  salvataggio: SalvataggioGiro;
}

/** Il registro persistente di un giro: alla creazione e alla fine (esito compatto, scenario, errore).
 *  Un giro «done» non torna indietro: un esito diverso scritto dopo (uno stop o un errore
 *  di un tentativo ripreso) non cancella lo scenario già salvato. */
export async function scriviGiro(
  job: AgentOptimizeJob, request?: unknown, esecutore: { execute: typeof db.execute } = db,
  /** solo se la riga non c'è ancora (la rotta, dopo aver accodato: il lavoratore può aver già scritto l'esito) */
  o: { soloSeManca?: boolean } = {},
): Promise<void> {
  const compact = job.status === "done" && job.result ? compactAgentResult(job.result) : null;
  await esecutore.execute(sql`
    INSERT INTO agent_optimize_jobs (id, user_id, ps_project_id, mode, status, created_at, finished_at,
                                     progress, params, request, error, scenario_id, dss_id, scenario_name, result_compact, updated_at)
    VALUES (${job.id}::uuid, ${job.userId}::uuid, ${job.psProjectId}::uuid, ${job.mode}, ${job.status},
            to_timestamp(${job.createdAt / 1000}),
            ${job.finishedAt ? new Date(job.finishedAt).toISOString() : null}::timestamptz,
            ${JSON.stringify(job.progress)}::jsonb, ${JSON.stringify(job.params)}::jsonb,
            ${request ? JSON.stringify(request) : null}::jsonb,
            ${job.error ?? null}, ${job.scenarioId ?? null}::uuid, ${job.dssId ?? null}::uuid, ${job.scenarioName ?? null},
            ${compact ? JSON.stringify(compact) : null}::jsonb, now())
    ON CONFLICT (id) DO ${o.soloSeManca ? sql`NOTHING` : sql`UPDATE SET
      status = EXCLUDED.status, finished_at = EXCLUDED.finished_at, progress = EXCLUDED.progress,
      params = EXCLUDED.params, request = COALESCE(EXCLUDED.request, agent_optimize_jobs.request),
      error = EXCLUDED.error, scenario_id = EXCLUDED.scenario_id, dss_id = EXCLUDED.dss_id,
      scenario_name = EXCLUDED.scenario_name,
      result_compact = COALESCE(EXCLUDED.result_compact, agent_optimize_jobs.result_compact),
      updated_at = now()
    WHERE agent_optimize_jobs.status <> 'done' OR EXCLUDED.status = 'done'`}`);
}

/** Il giro già salvato (agent_optimize_jobs «done»), se c'è: un lavoro ripreso non lo ricalcola. */
export async function giroGiaSalvato(id: string): Promise<{ scenarioId: string | null; dssId: string | null; scenarioName: string | null } | null> {
  const r = (await db.execute<any>(sql`
    SELECT scenario_id, dss_id, scenario_name FROM agent_optimize_jobs WHERE id = ${id}::uuid AND status = 'done'`)).rows[0];
  return r ? { scenarioId: r.scenario_id ?? null, dssId: r.dss_id ?? null, scenarioName: r.scenario_name ?? null } : null;
}

/** I parametri del giro con il ciclo VERO, letto dal motore: se restassero quelli
 * della richiesta, un giro lanciato coi default li avrebbe vuoti e il confronto
 * non potrebbe dire che due giri hanno avuto un ciclo diverso. */
export function paramsConCiclo(params: Record<string, any>, payload: any): Record<string, any> {
  const ciclo = payload?.vcsp?.ciclo;
  if (!ciclo || typeof ciclo !== "object") return params;
  return {
    ...params,
    penaltyStep: ciclo.passo ?? null,
    penaltyAnchor: ciclo.ancora ?? null,
    seedFromBest: ciclo.seme ?? null,
    earlyStopPatience: ciclo.pazienza ?? params?.earlyStopPatience ?? null,
    controllo: ciclo.controllo ?? null,
  };
}

const UUID = /^[0-9a-f-]{36}$/i;

export type EsitoSalvataggio =
  | { stato: "salvato"; scenarioId: string | null; dssId: string | null; scenarioName: string | null; params: Record<string, any>; giaSalvato: boolean }
  /** la riga della coda non è più di chi salva (lease perso) o è stato chiesto lo stop */
  | { stato: "non-nostro"; perche: "lease" | "annullato" };

/**
 * Il salvataggio di fine giro, tutto in una transazione:
 * 1. con la coda (`chi`), la riga del lavoro FOR UPDATE: deve essere ancora di
 *    chi salva, in corso e senza stop chiesto (un lavoratore che ha perso il
 *    lease non scrive uno scenario doppio);
 * 2. agent_optimize_jobs FOR UPDATE: un giro già «done» non si salva di nuovo
 *    (il lavoro ripreso dopo un crash fra il salvataggio e la chiusura);
 * 3. lo scenario turni macchina in un solo INSERT (proprietario, progetto,
 *    depositi, configurazione);
 * 4. in VCSP i turni guida del round migliore in un savepoint: un loro errore
 *    non ferma il resto, come sempre;
 * 5. agent_optimize_jobs «done» con l'esito compatto.
 */
export async function salvaGiro(a: {
  lavoroId: string; chi: string | null; payload: any; r: RichiestaGiro; log: LogGiro;
}): Promise<EsitoSalvataggio> {
  const { payload, r, log } = a;
  const s = r.salvataggio;
  return db.transaction(async (tx) => {
    if (a.chi) {
      const riga = (await tx.execute<any>(sql`
        SELECT preso_da, stato, annulla FROM coda.lavori WHERE id = ${a.lavoroId}::uuid FOR UPDATE`)).rows[0];
      if (!riga || riga.preso_da !== a.chi || riga.stato !== "in_corso") return { stato: "non-nostro", perche: "lease" } as const;
      if (riga.annulla) return { stato: "non-nostro", perche: "annullato" } as const;
    }
    const prima = (await tx.execute<any>(sql`
      SELECT status, scenario_id, dss_id, scenario_name, params FROM agent_optimize_jobs
       WHERE id = ${a.lavoroId}::uuid FOR UPDATE`)).rows[0];
    if (prima?.status === "done") {
      return {
        stato: "salvato", scenarioId: prima.scenario_id ?? null, dssId: prima.dss_id ?? null,
        scenarioName: prima.scenario_name ?? null, params: prima.params ?? r.params, giaSalvato: true,
      } as const;
    }

    // il proprietario solo se l'utente c'è ancora (FK su users): cancellato a giro
    // in corso, lo scenario si salva senza, come quando lo scriveva un UPDATE a parte
    let scenarioId: string | null = null;
    let dssId: string | null = null;
    let scenarioName: string | null = null;
    if (s.saveScenario) {
      const name = s.scenarioName ?? `Argos · ${s.psName} · ${s.rawDate}${r.mode === "vcsp" ? " · VCSP" : ""}`;
      scenarioName = name;
      // Scenario TURNI MACCHINA (il top-level è già il best round / sonda).
      const savedResult = payload.vcsp?.bestRound != null
        ? { ...payload, vcspSelectedRound: payload.vcsp.bestRound }
        : payload;
      const input = {
        date: s.rawDate, serviceType: s.serviceType, routes: s.routes,
        source: "argos-agent", mode: r.mode,
        ...(r.corpo.vcsp ? { vcsp: r.corpo.vcsp } : {}),
      };
      // Dossier di processo: la CONFIGURAZIONE usata (manopole guida, tariffe,
      // parametri VCSP/VSP, tetto auto) resta con lo scenario, così la
      // relazione può dichiarare con quali valori è stato calcolato.
      const provenance = {
        source: "argos-agent", mode: r.mode, savedAt: new Date().toISOString(),
        crewConfig: r.corpo.crewConfig ?? null,
        vcsp: r.corpo.vcsp ?? null,
        vehicleCosts: r.corpo.vehicleCosts ?? null,
        vspAdvanced: r.corpo.vspAdvanced ?? null,
        intensity: r.corpo.intensity ?? null, robustness: r.corpo.robustness ?? null,
        serviceType: s.serviceType, defaultVehicleType: s.defaultVehicleType ?? null,
        companyCars: r.corpo.crewConfig?.companyCars ?? null,
      };
      const depots = (Array.isArray(s.depotsSel) ? s.depotsSel : [])
        .filter((d: any) => d && typeof d.id === "string" && UUID.test(d.id))
        .map((d: any) => ({ id: d.id, maxVehicles: Number.isFinite(Number(d.maxVehicles)) && Number(d.maxVehicles) > 0 ? Number(d.maxVehicles) : null }));
      const ins = await tx.execute<any>(sql`
        INSERT INTO service_program_scenarios (name, date, feed_id, input, result, owner_user_id, project_id, depots, config)
        VALUES (${name}, ${s.rawDate.replace(/-/g, "")}, ${s.feedId || null}::uuid,
                ${JSON.stringify(input)}::jsonb, ${JSON.stringify(savedResult)}::jsonb,
                (SELECT id FROM users WHERE id = ${s.utenteId}::uuid), ${s.schedProjectId}::uuid,
                ${depots.length > 0 ? JSON.stringify(depots) : null}::jsonb, ${JSON.stringify(provenance)}::jsonb)
        RETURNING id`);
      scenarioId = ins.rows[0].id;
      // VCSP: anche i TURNI GUIDA del best round come DSS collegato,
      // così entrambe le aree di lavoro sono pronte (parità con la fucina).
      const v = payload.vcsp;
      if (r.mode === "vcsp" && Array.isArray(v?.crew?.driverShifts) && v.crew.driverShifts.length > 0) {
        try {
          dssId = await tx.transaction(async (sp) => {
            const dss = await sp.execute<any>(sql`
              INSERT INTO driver_shift_scenarios (service_program_scenario_id, name, result, config, owner_user_id)
              VALUES (${scenarioId}::uuid, ${`${name} · Turni guida (VCSP round ${v.bestRound ?? "?"})`},
                      ${JSON.stringify({
                        solver: "vcsp_crew",
                        driverShifts: v.crew.driverShifts,
                        summary: v.crew.summary ?? null,
                        handovers: v.crew.handovers ?? [],
                        clusters: v.crew.clusters ?? [],
                        metrics: v.crew.metrics ?? null,
                      })}::jsonb,
                      ${JSON.stringify({ source: "argos-agent", bestRound: v.bestRound ?? null, selectedRound: v.bestRound ?? null,
                                         crewConfig: r.corpo.crewConfig ?? null })}::jsonb,
                      (SELECT id FROM users WHERE id = ${s.utenteId}::uuid))
              RETURNING id`);
            return dss.rows[0].id as string;
          });
        } catch (e: any) {
          log.warn(`agent-optimize: salvataggio turni guida fallito (non-fatale): ${e?.message}`);
        }
      }
    }

    const params = paramsConCiclo(r.params, payload);
    await scriviGiro({
      id: a.lavoroId, userId: s.utenteId, psProjectId: s.psProjectId, mode: r.mode,
      status: "done", createdAt: s.creatoIl, finishedAt: Date.now(),
      progress: { phase: r.mode === "vcsp" ? "VCSP" : "VSP", pct: 100, msg: "Completato" },
      params, result: payload, scenarioId, dssId, ...(scenarioName ? { scenarioName } : {}),
    }, undefined, tx as any);
    return { stato: "salvato", scenarioId, dssId, scenarioName, params, giaSalvato: false } as const;
  });
}

export type EsitoGiro =
  | { stato: "fatto"; scenarioId: string | null; dssId: string | null; scenarioName: string | null; params: Record<string, any>; payload: any }
  | { stato: "errore"; errore: string; codice?: number; scaduto?: boolean }
  | { stato: "fermato" }
  | { stato: "non-nostro"; perche: "lease" | "annullato" };

/**
 * Un giro: il calcolo (la stessa pipeline della Fucina) e il salvataggio.
 * `chi` è il lease del lavoro in coda (null dentro l'API, col flag a 0).
 */
export async function eseguiGiro(r: RichiestaGiro, ctx: {
  lavoroId: string; chi: string | null; log: LogGiro;
  segnale?: AbortSignal; progresso?: (p: Progresso) => void; scadenza?: number;
}): Promise<EsitoGiro> {
  const out = await eseguiOttimizzazione(r.corpo, {
    mode: r.mode, feedId: r.feedId, log: ctx.log,
    segnale: ctx.segnale, progresso: ctx.progresso, scadenza: ctx.scadenza,
  });
  if (out.motivo === "fermato") return { stato: "fermato" };
  if (out.motivo === "scaduto") return { stato: "errore", errore: out.corpo?.error ?? "Tempo massimo superato", codice: out.codice, scaduto: true };
  const payload = out.corpo;
  if (out.codice !== 200 || payload?.error || payload?.status === "NO_INPUT") {
    return {
      stato: "errore", codice: out.codice,
      errore: payload?.error
        || (payload?.status === "NO_INPUT"
          ? "Nessuna corsa attiva per la data/linee scelte: controlla la data di esercizio"
          : `Errore HTTP ${out.codice}`),
    };
  }
  let salvato: EsitoSalvataggio;
  try {
    salvato = await salvaGiro({ lavoroId: ctx.lavoroId, chi: ctx.chi, payload, r, log: ctx.log });
  } catch (e: any) {
    return { stato: "errore", errore: `Giro completato ma salvataggio fallito: ${e?.message}` };
  }
  if (salvato.stato === "non-nostro") return salvato;
  return {
    stato: "fatto", scenarioId: salvato.scenarioId, dssId: salvato.dssId,
    scenarioName: salvato.scenarioName, params: salvato.params, payload,
  };
}

/** Aggrega i messaggi per-turno ({driverId: [msg…]}) in un top-10 per tipo. */
export function aggregateDutyMessages(det: any): { msg: string; n: number }[] | null {
  if (!det || typeof det !== "object") return null;
  const counts = new Map<string, number>();
  for (const msgs of Object.values(det as Record<string, string[]>)) {
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs) {
      const key = String(m).slice(0, 120);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return [];
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([msg, n]) => ({ msg, n }));
}

/** Vista COMPATTA del risultato per la chat (l'MCP tronca a ~40k):
 * KPI, round, sonda e advisories — mai i turni completi (si aprono in app). */
/** Riepilogo per linea di una lista di spostamenti della sonda (niente corse ripetute). */
export function summarizeShifts(shifts: any[]): { shiftedTrips: number; shiftsByRoute: any[] } {
  const byKey = new Map<string, { routeName: string; variantCode: string | null; deltaMin: number; trips: number; first: string; last: string }>();
  for (const sft of shifts) {
    const routeName = String(sft?.routeName ?? "?");
    const variantCode = sft?.variantCode ?? null;
    const deltaMin = Number(sft?.deltaMin ?? 0);
    const key = `${routeName}|${variantCode ?? ""}|${deltaMin}`;
    const cur = byKey.get(key);
    const from = String(sft?.from ?? "");
    if (cur) {
      cur.trips += 1;
      if (from && from < cur.first) cur.first = from;
      if (from && from > cur.last) cur.last = from;
    } else {
      byKey.set(key, { routeName, variantCode, deltaMin, trips: 1, first: from, last: from });
    }
  }
  return { shiftedTrips: shifts.length, shiftsByRoute: Array.from(byKey.values()) };
}

export function compactAgentResult(payload: any): any {
  const v = payload?.vcsp;
  const s = payload?.summary ?? {};
  const m = payload?.solverMetrics ?? {};
  return {
    solver: payload?.solver ?? null,
    summary: {
      totalVehicles: s.totalVehicles ?? null,
      totalTrips: s.totalTrips ?? null,
      totalServiceHours: s.totalServiceHours ?? null,
      totalDeadheadKm: s.totalDeadheadKm ?? null,
      efficiency: s.efficiency ?? null,
      byType: s.byType ?? null,
      byDepot: s.byDepot ?? null,
    },
    vehicleCostEur: m.costEur ?? null,
    solveTimeSec: m.solveTimeSec ?? null,
    fleetInfeasibility: m.fleetInfeasibility ?? null,
    // Da dove vengono i fuorilinea: archivio «Archi fuorilinea» (coppie
    // ammesse/vietate, tempi e km presi dall'archivio, tratte deposito senza
    // arco e quindi stimate) e riposizionamenti instradati via deposito.
    deadheadArchive: m.deadheadArchive ?? null,
    viaDepotArcs: m.viaDepotArcs ?? null,
    // Rientri a vuoto che potrebbero diventare corse di linea (le corse in
    // linea sono pagate, i km a vuoto no): proposte, da creare in Planning
    // Studio solo con conferma dell'operatore.
    serviceReturnProposals: Array.isArray(m.serviceReturnProposals) ? m.serviceReturnProposals.slice(0, 20) : [],
    // Regola del giro (linee radiali): ritorni naturali dal capolinea
    // periferico fatti e saltati nelle catene finali
    turnarounds: m.turnarounds ?? null,
    // Regola della sagoma: che mezzo ha preso ogni blocco, quante corse girano
    // su un mezzo più piccolo di quello dichiarato dalla loro linea e se la
    // flotta per tipologia basta.
    sagoma: m.sagoma ?? null,
    advisories: (Array.isArray(payload?.advisories) ? payload.advisories : [])
      .filter((a: any) => a.severity === "critical" || a.severity === "warning")
      .slice(0, 5)
      .map((a: any) => ({ severity: a.severity, title: a.title, description: a.description })),
    ...(v ? {
      vcsp: {
        bestRound: v.bestRound ?? null,
      // Il giro fermato prima dei round chiesti: il piano è il migliore fra
      // QUELLI PROVATI, e due giri con round diversi non sono alla pari.
      earlyStop: v.earlyStop ?? null,
      // Le manopole del ciclo EFFETTIVAMENTE in vigore (dal motore, non dalla
      // richiesta): chi lancia coi default non le scrive, e il confronto fra
      // giri le vedeva vuote.
      ciclo: v.ciclo ?? null,
        roundsExecuted: v.roundsExecuted ?? null,
        elapsedSec: v.elapsedSec ?? null,
        rounds: (Array.isArray(v.rounds) ? v.rounds : []).map((r: any) => ({
          round: r.round, probe: !!r.probe, vehicles: r.vehicles,
          duties: r.duties, supplementi: r.supplementi, bdsViolations: r.bdsViolations,
          vehicleCostEur: r.vehicleCostEur, crewCostEur: r.crewCostEur, totalCostEur: r.totalCostEur,
          // Punteggio usato per scegliere il best round (costo + ombre
          // turni/violazioni): senza, "bestRound" sembra arbitrario dalla chat.
          selectionScoreEur: r.selectionScoreEur ?? null,
          // Quanto del costo grezzo del VSP erano penalità d'arco, cioè soldi
          // che l'orchestratore inventa per spingere il solver. Il costo qui
          // sopra è già al netto; questo dice quanto mordeva il feedback.
          shadowPenaltyEur: r.shadowPenaltyEur ?? null,
          ...(r.probe ? { shiftedTrips: r.shiftedTrips ?? 0, shiftPenaltyEur: r.shiftPenaltyEur ?? 0 } : {}),
        })),
        // IL TERMOMETRO DEL CICLO, un rigo per round: quanto pesano le
        // penalità in vigore, quanto si sono spostate dal round prima, e su
        // quale piano sono state calcolate. Se lo spostamento non cala, il
        // VSP insegue un bersaglio che salta e nessun round può migliorare il
        // precedente — è esattamente il 21→33 vetture del giro BA. Il
        // dettaglio per blocco resta fuori: qui servono i numeri che si
        // leggono in fila.
        feedback: (Array.isArray(v.feedback) ? v.feedback : []).map((f: any) => ({
          dopoRound: f.afterRound ?? null,
          ancora: f.ancora?.round ?? null,
          modo: f.ancora?.modo ?? null,
          passo: f.passo ?? null,
          blocchiPenalizzati: f.blocksPenalized ?? null,
          // Attenzione ai nomi: "dalPiano" sono gli archi che il piano
          // ancorato ha fatto penalizzare in QUESTA estrazione; "inVigore"
          // sono quelli che il round successivo riceve davvero, cioè dopo
          // che il passo li ha mescolati con quelli di prima. I due numeri
          // divergono apposta: è la memoria del feedback che si vede.
          archiDalPiano: f.arcsPenalized ?? null,
          archiInVigore: f.archiInVigore ?? null,
          massaPenalitaEur: f.massaPenalitaEur ?? null,
          spostamentoEur: f.distanzaDalPrecedenteEur ?? null,
          escalationGiunti: f.giunti?.escalation ?? null,
        })),
        crew: v.crew?.summary ? {
          duties: v.crew.summary.totalShifts ?? null,
          supplementi: v.crew.summary.totalSupplementi ?? null,
          costEur: v.crew.summary.totalDailyCost ?? null,
          bdsViolations: v.crew.summary.validation?.totalViolations ?? 0,
          dutiesWithViolations: v.crew.summary.validation?.dutiesWithViolations ?? 0,
          // DIAGNOSI: violazioni aggregate per messaggio (top 10) — senza
          // questa la chat vede "33 violazioni" ma non QUALI regole saltano,
          // e non può scegliere la leva giusta per il giro successivo.
          violationsBreakdown: aggregateDutyMessages(v.crew.summary.validation?.details),
          // Avvisi non bloccanti (es. pause pasto con severità "avviso"):
          // il turno resta valido ma l'operatore deve vederli.
          bdsWarnings: v.crew.summary.validation?.totalWarnings ?? 0,
          warningsBreakdown: aggregateDutyMessages(v.crew.summary.validation?.warningDetails),
          // Forma dei turni: quanto lavora un turno medio e quante coppie si
          // formano — senza, dalla chat non si capisce se si è vicini al
          // pavimento (ore-vettura ÷ lavoro massimo legale).
          avgWorkMin: v.crew.summary.avgWorkMin ?? null,
          avgNastroMin: v.crew.summary.avgNastroMin ?? null,
          byType: v.crew.summary.byType ?? null,
          semiunicoPct: v.crew.summary.semiunicoPct ?? null,
          spezzatoPct: v.crew.summary.spezzatoPct ?? null,
          // ATTENZIONE: totalCambi conta i soli cambi IN LINEA. Il cambio
          // in deposito (chi smonta rientra guidando il bus, chi monta
          // riparte guidandolo fuori) non costa un'autovettura e non ci
          // finisce dentro: senza totalDepotChanges non si vede se il
          // motore lo sta usando, e si giudica il giro alla cieca.
          totalCambi: v.crew.summary.totalCambi ?? null,
          totalDepotChanges: v.crew.summary.totalDepotChanges ?? null,
          // Tetti percentuali dei tipi di turno (rigidi, tolleranza di frazione
          // di turno): tetto, massimo ammesso, conteggio, esito; "relaxed" =
          // nessuno scenario fattibile coi tetti rigidi
          pctCaps: v.crew.summary.pctCaps ?? null,
          pctCapRelaxed: !!v.crew.summary.pctCapRelaxed,
          // Come si fanno i cambi in linea e quanto resta ferma una vettura senza conducente
          handoverModes: v.crew.summary.handoverModes ?? null,
          // Gara fra segmentazioni (storica vs pair-aware): chi ha vinto e perché
          segmentation: v.crew.metrics?.optimizerParams?.segmentation ?? v.crew.metrics?.segmentation ?? null,
          // Fattori applicati dai pesi operatore (1.0 = slider al default)
          weightFactors: v.crew.metrics?.weightFactors ?? null,
          // Elenco compatto dei turni: serve al passo "pianificazione" (quali
          // interi restano corti, dove spostare le corse). Un turno = tipo,
          // nastro/lavoro e i suoi pezzi (bus, orari, nodi, linee).
          dutyList: (Array.isArray(v.crew.driverShifts) ? v.crew.driverShifts : []).slice(0, 80).map((d: any) => ({
            id: d.driverId, type: d.type, nastroMin: d.nastroMin, workMin: d.workMin,
            interruptionMin: d.interruptionMin ?? 0,
            pieces: (Array.isArray(d.riprese) ? d.riprese : []).map((r: any) => {
              const trips = Array.isArray(r.trips) ? r.trips.filter((t: any) => t && t.tripId) : [];
              const lines = Array.from(new Set(trips.map((t: any) => t.routeName).filter(Boolean)));
              return {
                veh: Array.isArray(r.vehicleIds) && r.vehicleIds.length ? r.vehicleIds[0] : (trips[0]?.vehicleId ?? null),
                start: r.startTime, end: r.endTime,
                from: trips[0]?.firstStopName ?? null, to: r.lastStop ?? null,
                lines, trips: trips.length,
              };
            }),
          })),
          // Struttura dei blocchi macchina visti dal CSP (CORTO/MEDIO/LUNGO):
          // dice se le violazioni sono un problema di blocchi troppo lunghi.
          blocks: v.crew.metrics ? {
            vehicleBlocks: v.crew.metrics.vehicleBlocks ?? null,
            classifications: v.crew.metrics.classifications ?? null,
          } : null,
          // Vincolo RIGIDO autovetture (i campi vivono nel SUMMARY del CSP).
          companyCars: {
            cap: v.crew.summary.companyCarsCap ?? null,
            maxSimultaneous: v.crew.summary.companyCarsMaxSimultaneous ?? null,
            // "used" = auto distinte impiegate (NON i bus toccati dai turni)
            used: v.crew.summary.companyCarsUsed ?? null,
            movements: v.crew.summary.companyCarsMovements ?? null,
            conflicts: v.crew.summary.companyCarsConflicts ?? null,
            // ritiri che nessuna consegna raggiunge (nessuno porta un'auto a quel nodo)
            unpaired: v.crew.summary.companyCarsUnpaired ?? null,
            violated: !!v.crew.summary.companyCarsHardViolation,
            // Viaggi auto uno per uno (consegna/ritiro, nodo, orari, auto, attesa)
            trips: Array.isArray(v.crew.metrics?.carPool?.movements) ? v.crew.metrics.carPool.movements.slice(0, 120) : undefined,
          },
        } : null,
        // Sonda di spostamento: ciò che l'agente racconta all'operatore. Il
        // dettaglio per corsa sta UNA volta sola in timeShifts (cumulato sugli
        // orari originali); le proposte accettate portano il riepilogo per
        // linea — con le corse ripetute per proposta il compatto superava il
        // tetto del canale MCP (40k) e arrivava troncato.
        probe: v.probe ? {
          flexTrips: v.probe.flexTrips ?? 0,
          candidates: v.probe.candidates ?? 0,
          probesRun: v.probe.probesRun ?? 0,
          crewScope: v.probe.crewScope ?? null,
          // Perché la sonda guidata dai turni non propone nulla: bi-riprese
          // esaminate, quante non possono diventare interi e il δ che servirebbe.
          crewStats: v.probe.crewStats ?? null,
          // Coincidenze fra linee riconosciute dall'orario (nodo, A→B,
          // occorrenze) e quanti candidati sono stati scartati per non
          // romperle. Senza questi due numeri non si sa se il vincolo morde
          // troppo poco o troppo, e si giudica la sonda alla cieca.
          coincidences: Array.isArray(v.probe.coincidences) ? v.probe.coincidences : null,
          rejectedForCoincidence: v.probe.rejectedForCoincidence ?? null,
          // Quanti candidati, invece di essere scartati, si sono portati dietro
          // la corsa in coincidenza: e' la misura del mattone spostato.
          propagatedForCoincidence: v.probe.propagatedForCoincidence ?? null,
          // Perché la catena non si è chiusa (flessibilità, delta in conflitto,
          // tetto): senza il motivo non si sa dove allargare.
          propagationFailures: v.probe.propagationFailures ?? null,
          // La coda si è svuotata prima del budget? Quante sonde sono rimaste?
          // (AX: tre su dieci, e nessuno lo diceva.) E cosa ha imparato il
          // giro — una voce per firma con esito, motivo e tentativi: è ciò
          // che il giro dopo rilegge come memoria (vedi loadProbeLessons).
          codaEsaurita: v.probe.codaEsaurita ?? null,
          sondeNonUsate: v.probe.sondeNonUsate ?? null,
          // Il controllo: re-solve del best round senza spostamenti, stessa
          // configurazione dei candidati. Vetture e punteggio round/controllo
          // e chi è rimasto riferimento: se è il controllo, il guadagno del
          // round sonda è del solver, non dell'orario.
          controllo: v.probe.controllo ?? null,
          memoria: v.probe.memoria ?? null,
          lezioni: Array.isArray(v.probe.lezioni) ? v.probe.lezioni.slice(0, 40) : [],
          shiftPenaltyEurPerTripMin: v.probe.shiftPenaltyEurPerTripMin ?? null,
          // I candidati «coincidenza» spostano una linea intera: nel rendiconto
          // portano la linea e le relazioni comprate.
          accepted: (Array.isArray(v.probe.accepted) ? v.probe.accepted : []).map((a: any) => {
            const { shifts, ...rest } = a ?? {};
            return { ...rest, ...summarizeShifts(Array.isArray(shifts) ? shifts : []) };
          }),
          rejectedCount: Array.isArray(v.probe.rejected) ? v.probe.rejected.length : 0,
          rejected: (Array.isArray(v.probe.rejected) ? v.probe.rejected : []).slice(0, 12).map((a: any) => {
            const { shifts, ...rest } = a ?? {};
            return { ...rest, ...summarizeShifts(Array.isArray(shifts) ? shifts : []) };
          }),
          shiftedTrips: v.probe.shiftedTrips ?? Object.keys(v.probe.timeShifts ?? {}).length,
          shiftedTripMin: v.probe.shiftedTripMin ?? null,
          disruptionEur: v.probe.disruptionEur ?? null,
          timeShifts: Array.isArray(v.probe.timeShiftDetails)
            ? v.probe.timeShiftDetails.map((d: any) => ({
                tripId: d.tripId, routeName: d.routeName, variantCode: d.variantCode ?? null,
                deltaMin: d.deltaMin, from: d.from, to: d.to,
              }))
            : Object.entries(v.probe.timeShifts ?? {}).map(([tripId, deltaMin]) => ({ tripId, deltaMin })),
        } : null,
      },
    } : {}),
  };
}

/** La riga della coda di un giro, per quanto serve alla vista. */
export interface CodaDelGiro {
  id: string;
  stato: "in_coda" | "in_corso" | "completato" | "fallito" | "fermato";
  avanzamento: any | null;
  errore: string | null;
  errore_tipo?: string | null;
  risultato: any | null;
  utente_id: string | null;
  metadati: Record<string, any> | null;
  creato_il: Date | string;
  finito_il: Date | string | null;
}

const ms = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null);

/**
 * Lo stato di un giro per Argos (GET /service-program/agent-optimize/:jobId e
 * l'elenco), dalla riga di agent_optimize_jobs e da quella della coda, con le
 * chiavi di sempre:
 * - «done» in agent_optimize_jobs vince (lo scrive salvaGiro, nella stessa
 *   transazione dello scenario);
 * - un lavoro in coda o in corso è «running», con l'avanzamento della coda:
 *   un deploy dell'API non lo interrompe più;
 * - un lavoro fallito o fermato è «error», col suo messaggio;
 * - senza riga in coda e ancora «running» è un giro di prima della coda (o di
 *   oltre 30 giorni): interrotto da un riavvio, con la richiesta per rilanciarlo.
 */
export function vistaGiro(row: any | null, l: CodaDelGiro | null, full: boolean, adesso: number = Date.now()): Record<string, any> | null {
  if (!row && !l) return null;
  const mode = row?.mode ?? l?.metadati?.mode ?? null;
  const fase = mode === "cpsat" ? "VSP" : "VCSP";
  const createdMs = ms(row?.created_at) ?? ms(l?.creato_il) ?? adesso;
  const base = {
    jobId: row?.id ?? l!.id,
    mode,
    psProjectId: row?.ps_project_id ?? l?.metadati?.psProjectId ?? null,
  };
  const trascorsi = (fine: number | null) => Math.round(((fine ?? adesso) - createdMs) / 1000);
  const params = row?.params ?? l?.metadati?.params ?? {};
  /* nell'elenco (full=false) anche quando è nato e, se finito, lo scenario: come l'elenco in memoria */
  const elenco = (scenarioId: string | null) => (full ? {} : { createdAt: new Date(createdMs).toISOString(), scenarioId });

  if (row?.status === "done") {
    return {
      ...base, status: "done", progress: row.progress ?? null,
      elapsedSec: trascorsi(ms(row.finished_at)), params, ...elenco(row.scenario_id ?? null),
      ...(full ? {
        scenarioId: row.scenario_id ?? null,
        dssId: row.dss_id ?? null,
        scenarioName: row.scenario_name ?? null,
        result: row.result_compact ?? null,
        persisted: true,
      } : {}),
    };
  }
  if (l && (l.stato === "in_coda" || l.stato === "in_corso")) {
    const a = l.avanzamento;
    const progress = a
      ? { phase: String(a.phase ?? fase), pct: Math.round(Number(a.percentage) || 0), msg: String(a.detail ?? "").trim() }
      : l.stato === "in_coda" ? { phase: fase, pct: 0, msg: "In coda…" } : (row?.progress ?? { phase: fase, pct: 0, msg: "Avvio…" });
    return { ...base, status: "running", progress, elapsedSec: trascorsi(null), params, ...elenco(null) };
  }
  if (l) {
    // finito in coda, ma il giro non è «done»: fallito o fermato (o «done» non scritto)
    const errore = row?.status === "error" && row.error
      ? row.error
      : l.stato === "fermato" ? "Giro fermato" : (l.errore ?? "Giro non riuscito");
    if (l.stato === "completato") {
      return {
        ...base, status: "done", progress: row?.progress ?? { phase: fase, pct: 100, msg: "Completato" },
        elapsedSec: trascorsi(ms(l.finito_il)), params, ...elenco(l.risultato?.scenarioId ?? null),
        ...(full ? {
          scenarioId: l.risultato?.scenarioId ?? null, dssId: l.risultato?.dssId ?? null,
          scenarioName: l.risultato?.scenarioName ?? null, result: null, persisted: true,
        } : {}),
      };
    }
    // interrotto (il lavoratore è caduto più volte): la richiesta per rilanciarlo, come prima
    const interrotto = l.errore_tipo === "interrotto" || row?.status === "running";
    return {
      ...base, status: "error", progress: row?.progress ?? l.avanzamento ?? null,
      elapsedSec: trascorsi(ms(row?.finished_at) ?? ms(l.finito_il)), params, error: errore, ...elenco(null),
      ...(interrotto && row ? { request: row.request ?? null } : {}),
    };
  }
  const interrupted = row.status === "running";
  return {
    ...base,
    status: interrupted ? "error" : row.status,
    progress: row.progress ?? null,
    elapsedSec: trascorsi(ms(row.finished_at)),
    params, ...elenco(row.scenario_id ?? null),
    ...(interrupted
      ? { error: "Giro interrotto dal riavvio del server (deploy): rilancialo con gli stessi parametri (campo request)", request: row.request ?? null }
      : row.error ? { error: row.error } : {}),
  };
}
