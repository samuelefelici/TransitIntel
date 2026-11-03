/**
 * I giri di Argos (agent-optimize): la vista compatta del risultato per la
 * chat. Senza Express: la usano le rotte e il lavoratore dei calcoli.
 */

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
