/**
 * Dai turni del file ai turni di Fucina (tappa 7.38): turni macchina nella
 * forma dello scenario dei turni macchina (service_program_scenarios.result) e
 * turni guida nella forma dello scenario dei turni guida
 * (driver_shift_scenarios.result), così si aprono, si guardano e si
 * modificano come quelli calcolati da Cerbero.
 *
 * Le corse sono quelle del GTFS del progetto (orari, fermate, linea): il file
 * dice solo quale corsa sta in quale turno. Una corsa del file che non si
 * trova nel GTFS resta fuori dai turni e si conta nel resoconto.
 * Funzioni pure: le corse del giorno le passa chi chiama.
 */
import {
  calculateCosts, calculateScore, generateAdvisories, DEADHEAD_SPEED,
  type ShiftTripEntry, type TripBlock, type VehicleShift, type VehicleType, type ServiceCategory,
} from "../ottimizza-veicoli/modello";
import { PEZZO, type FileTurni, type PezzoFile, type TurnoGuidaFile } from "./file";
import { pezzoRiconosciuto, type Abbinamento } from "./abbina";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;
const durata = (m: number) => `${Math.floor(m / 60)}h${String(Math.round(m) % 60).padStart(2, "0")}`;

/** I pezzi in cui il mezzo si muove con il conducente a bordo. */
const PEZZI_COL_MEZZO: ReadonlySet<number> = new Set([PEZZO.inLinea, PEZZO.fuoriLinea, PEZZO.raggiungimentoOrario, PEZZO.trasferimentoOrario]);
/** Gli spostamenti del conducente senza il mezzo (taxi, trasferimenti, raggiungimenti a forfait). */
const PEZZI_TRASFERIMENTO: ReadonlySet<number> = new Set([PEZZO.taxi, PEZZO.taxi2, PEZZO.trasferimentoForfait, PEZZO.raggiungimentoForfait]);
const PEZZI_TAXI: ReadonlySet<number> = new Set([PEZZO.taxi, PEZZO.taxi2]);
const PEZZI_PRE: ReadonlySet<number> = new Set([PEZZO.preTurno, PEZZO.preRipresa]);

/** Attività di lavoro che non sono guida: come le attività aggiunte a mano nell'area di lavoro. */
function tipoAttivita(tipo: number): "riserva" | "presidio" | "verifica" | null {
  switch (tipo) {
    case PEZZO.riserva: case PEZZO.disposizione: case PEZZO.disposizione2:
    case PEZZO.capolinea: case PEZZO.capolineaRiserva:
      return "riserva";
    case PEZZO.presidio: case PEZZO.centrale: case PEZZO.coperturaSosta:
    case PEZZO.rifornimento: case PEZZO.manovra:
      return "presidio";
    case PEZZO.verifica:
      return "verifica";
    default:
      return null;
  }
}

/**
 * Il tipo di mezzo del file nei quattro tipi del calcolo dei turni macchina,
 * dalla lunghezza scritta nel codice (9, 10, 12, 18 metri…). Il filobus va
 * con i 12 metri; il codice del file resta nel turno (tipoOrigine).
 */
export function tipoDelMezzo(codice: string | null | undefined): VehicleType {
  const c = String(codice ?? "").toLowerCase();
  const m = /(\d+(?:[.,]\d+)?)/.exec(c);
  if (m) {
    const metri = Number(m[1]!.replace(",", "."));
    if (metri >= 15) return "autosnodato";
    if (metri >= 11) return "12m";
    if (metri >= 9.5) return "10m";
    return "pollicino";
  }
  if (/snod|artic/.test(c)) return "autosnodato";
  if (/pollic|mini|al[eè]/.test(c)) return "pollicino";
  return "12m";
}

/**
 * Il tipo del turno guida: il nome del file se è uno dei tipi di Cerbero,
 * altrimenti dalla forma del turno (una ripresa = intero; due = semiunico se
 * l'interruzione è breve, spezzato se è lunga).
 */
export function tipoDelTurno(nome: string | null, riprese: number, interruzioneMin: number): "intero" | "semiunico" | "spezzato" | "supplemento" {
  const n = String(nome ?? "").toLowerCase();
  if (n.startsWith("intero") || n.startsWith("interi")) return "intero";
  if (n.startsWith("semiunic")) return "semiunico";
  if (n.startsWith("spezzat")) return "spezzato";
  if (n.startsWith("supplement")) return "supplemento";
  if (riprese <= 1) return "intero";
  return interruzioneMin > 180 ? "spezzato" : "semiunico";
}

/** Km di un fuori linea senza km nel file: durata per la velocità media dei vuoti della categoria. */
export function kmStimati(minuti: number, categoria: ServiceCategory): number {
  return minuti > 0 ? Math.round((minuti / 60) * DEADHEAD_SPEED[categoria] * 10) / 10 : 0;
}

function eDeposito(codice: string, nome: string): boolean {
  return /^dep/i.test(codice) || /deposito|rimessa/i.test(nome);
}

export interface ContestoCostruzione {
  file: FileTurni;
  /** AAAA-MM-GG */
  data: string;
  turni: TurnoGuidaFile[];
  abbinamento: Abbinamento;
  /** tutte le corse del GTFS attive nel giorno, con orari e fermate */
  corseDelGiorno: TripBlock[];
  /** quanti servizi del calendario GTFS valgono quel giorno */
  serviziAttivi: number;
}

export interface Resoconto {
  turniGuida: number;
  turniMacchina: number;
  corseNelFile: number;
  riconosciutePerNumero: number;
  riconosciutePerOrario: number;
  nonTrovate: number;
  corseDelGtfsSenzaTurno: number;
  /** turni macchina del file rimasti senza nessuna corsa riconosciuta: non si importano */
  turniMacchinaVuoti: number;
  /** pezzi in linea di turni guida la cui corsa non si trova: restano fuori dal turno */
  pezziSenzaCorsa: number;
}

export function costruisciTurni(ctx: ContestoCostruzione) {
  const { file, turni, abbinamento } = ctx;
  const corse = new Map(ctx.corseDelGiorno.map((c) => [c.tripId, c]));
  const nodo = (codice: string) => file.nodi.get(codice) || codice;

  /* ── i turni macchina ─────────────────────────────────────────── */
  const perTm = new Map<string, { codice: string | null; pezzi: Map<string, PezzoFile> }>();
  for (const t of turni) {
    for (const p of t.pezzi) {
      if (!p.idTurnoMacchina || !PEZZI_COL_MEZZO.has(p.tipo)) continue;
      const g = perTm.get(p.idTurnoMacchina) ?? { codice: p.turnoMacchina, pezzi: new Map() };
      g.pezzi.set(p.id, p);
      perTm.set(p.idTurnoMacchina, g);
    }
  }
  /* il codice mostrato del turno macchina; se due turni del giorno hanno lo stesso, il secondo prende un indice */
  const vehicleId = new Map<string, string>();
  const codiciUsati = new Map<string, number>();
  for (const [id, g] of [...perTm.entries()].sort(([, a], [, b]) => String(a.codice).localeCompare(String(b.codice), "it", { numeric: true }))) {
    const base = g.codice ?? id;
    const n = (codiciUsati.get(base) ?? 0) + 1;
    codiciUsati.set(base, n);
    vehicleId.set(id, n === 1 ? base : `${base}·${n}`);
  }

  const shifts: (VehicleShift & { tipoOrigine?: string | null; origine: "turni-esistenti" })[] = [];
  const categoriaDelMezzo = new Map<string, ServiceCategory>();
  const coperte = new Set<string>();
  let turniMacchinaVuoti = 0;
  for (const [id, g] of perTm) {
    const pezzi = [...g.pezzi.values()].sort((a, b) => a.partenza - b.partenza || a.arrivo - b.arrivo);
    const codiceMezzo = file.mezzi.get(id) ?? null;
    const tipo = tipoDelMezzo(codiceMezzo);
    const entries: ShiftTripEntry[] = [];
    const visti = new Set<string>();
    for (const p of pezzi) {
      if (p.tipo === PEZZO.inLinea) {
        const tripId = pezzoRiconosciuto(p, abbinamento);
        const tb = tripId ? corse.get(tripId) : undefined;
        if (!tb || visti.has(tb.tripId)) continue; // una corsa divisa fra due conducenti: una volta sola
        visti.add(tb.tripId);
        entries.push({
          type: "trip", tripId: tb.tripId, routeId: tb.routeId, routeName: tb.routeName,
          variantCode: tb.variantCode ?? null, headsign: tb.headsign,
          departureTime: tb.departureTime, arrivalTime: tb.arrivalTime,
          departureMin: tb.departureMin, arrivalMin: tb.arrivalMin,
          firstStopName: tb.firstStopName, lastStopName: tb.lastStopName,
          stopCount: tb.stopCount, durationMin: tb.arrivalMin - tb.departureMin,
          directionId: tb.directionId, requiredVehicle: tipo,
          ...(tb.onDemand ? { onDemand: true } : {}),
        });
      } else {
        const daNome = nodo(p.da), aNome = nodo(p.a);
        const km = p.metri ? Math.round(p.metri / 100) / 10 : 0;
        const uscita = eDeposito(p.da, daNome), rientro = eDeposito(p.a, aNome);
        const etichetta = uscita ? `Uscita ${daNome}` : rientro ? `Rientro ${aNome}` : "Fuori linea";
        entries.push({
          type: "deadhead", tripId: "", routeId: "", headsign: null,
          routeName: km > 0 ? `${etichetta} (${km} km)` : etichetta,
          departureTime: hhmm(p.partenza), arrivalTime: hhmm(p.arrivo),
          departureMin: p.partenza, arrivalMin: p.arrivo,
          deadheadMin: p.arrivo - p.partenza, deadheadKm: km,
          firstStopName: daNome, lastStopName: aNome,
          ...(uscita ? { depotLeg: "out" } : rientro ? { depotLeg: "in" } : {}),
        } as ShiftTripEntry);
      }
    }
    const servizio = entries.filter((e) => e.type === "trip");
    if (servizio.length === 0) { turniMacchinaVuoti++; continue; }
    for (const e of servizio) coperte.add(e.tripId);
    const cat = new Map<ServiceCategory, number>();
    for (const e of servizio) { const c = corse.get(e.tripId)?.category ?? "urbano"; cat.set(c, (cat.get(c) ?? 0) + 1); }
    const category: ServiceCategory = (cat.get("extraurbano") ?? 0) > (cat.get("urbano") ?? 0) ? "extraurbano" : "urbano";
    categoriaDelMezzo.set(id, category);
    const vuoti = entries.filter((e) => e.type !== "trip");
    /* il file non dà i km dei fuori linea: si stimano dalla durata, come fa il calcolo dei turni */
    for (const e of vuoti) {
      if (e.deadheadKm) continue;
      const km = kmStimati(e.arrivalMin - e.departureMin, category);
      e.deadheadKm = km;
      (e as any).kmStimati = true;
      if (km > 0) e.routeName = `${e.routeName} (~${km} km)`;
    }
    const startMin = Math.min(...entries.map((e) => e.departureMin));
    const endMin = Math.max(...entries.map((e) => e.arrivalMin));
    const rientri = entries.filter((e, i) => (e as any).depotLeg === "in" && i < entries.length - 1).length;
    shifts.push({
      vehicleId: vehicleId.get(id)!,
      vehicleType: tipo,
      category,
      trips: entries,
      startMin, endMin,
      totalServiceMin: servizio.reduce((s, e) => s + (e.arrivalMin - e.departureMin), 0),
      totalDeadheadMin: vuoti.reduce((s, e) => s + (e.arrivalMin - e.departureMin), 0),
      totalDeadheadKm: Math.round(vuoti.reduce((s, e) => s + (e.deadheadKm ?? 0), 0) * 10) / 10,
      depotReturns: rientri,
      tripCount: servizio.length,
      fifoOrder: 0,
      firstOut: startMin,
      lastIn: endMin,
      shiftDuration: endMin - startMin,
      downsizedTrips: 0,
      tipoOrigine: codiceMezzo,
      origine: "turni-esistenti",
    });
  }
  shifts.sort((a, b) => (a.category === b.category ? 0 : a.category === "urbano" ? -1 : 1) || a.firstOut - b.firstOut);
  [...shifts].sort((a, b) => a.lastIn - b.lastIn).forEach((s, i) => { s.fifoOrder = i + 1; });

  const giorno = ctx.corseDelGiorno;
  const unassigned = giorno.filter((c) => !coperte.has(c.tripId));

  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = { urbano: 0, extraurbano: 0 };
  for (const s of shifts) {
    byType[s.vehicleType] = (byType[s.vehicleType] || 0) + 1;
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  }
  const perLinea = new Map<string, TripBlock[]>();
  for (const c of giorno) { const v = perLinea.get(c.routeId) ?? []; v.push(c); perLinea.set(c.routeId, v); }
  const routeStats = [...perLinea.entries()].map(([routeId, cs]) => {
    cs.sort((a, b) => a.departureMin - b.departureMin);
    const mezzi = shifts.filter((s) => s.trips.some((t) => t.routeId === routeId));
    const tipi = new Map<string, number>();
    for (const s of mezzi) tipi.set(s.vehicleType, (tipi.get(s.vehicleType) ?? 0) + 1);
    return {
      routeId, routeName: cs[0]!.routeName,
      vehicleType: [...tipi.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "12m",
      category: cs[0]!.category,
      tripsCount: cs.length, vehiclesNeeded: mezzi.length,
      firstDeparture: cs[0]!.departureTime, lastArrival: cs[cs.length - 1]!.arrivalTime,
    };
  }).sort((a, b) => b.tripsCount - a.tripsCount);
  const hourlyDist: { hour: number; trips: number }[] = [];
  for (let h = 4; h <= 26; h++) hourlyDist.push({ hour: h, trips: giorno.filter((t) => Math.floor(t.departureMin / 60) === h).length });

  const totalServiceMin = shifts.reduce((s, v) => s + v.totalServiceMin, 0);
  const totalDeadheadMin = shifts.reduce((s, v) => s + v.totalDeadheadMin, 0);
  const totalDeadheadKm = shifts.reduce((s, v) => s + v.totalDeadheadKm, 0);
  const totalServiceHours = +(totalServiceMin / 60).toFixed(1);
  const summary = {
    date: ctx.data.replace(/-/g, ""),
    activeServices: ctx.serviziAttivi,
    /* le corse nei turni (come nell'area di lavoro); quelle senza turno sono in unassigned */
    totalTrips: coperte.size,
    selectedRoutes: perLinea.size,
    totalVehicles: shifts.length,
    byType, byCategory,
    totalServiceHours,
    totalDeadheadHours: +(totalDeadheadMin / 60).toFixed(1),
    totalDeadheadKm: +totalDeadheadKm.toFixed(1),
    depotReturns: shifts.reduce((s, v) => s + v.depotReturns, 0),
    efficiency: totalServiceMin > 0 ? +((totalServiceMin / (totalServiceMin + totalDeadheadMin)) * 100).toFixed(1) : 0,
    downsizedTrips: 0,
  };
  const costs = calculateCosts(shifts, coperte.size, totalServiceHours);
  const score = calculateScore(shifts, coperte.size, totalServiceMin, totalDeadheadMin, totalDeadheadKm, costs);
  const advisories = generateAdvisories(shifts, giorno, costs, score, hourlyDist);

  /* ── i turni guida ────────────────────────────────────────────── */
  const tm = new Map(shifts.map((s) => [s.vehicleId, s]));
  const codiciGuida = new Map<string, number>();
  let pezziSenzaCorsa = 0;
  const driverShifts = turni.map((t) => {
    const n = (codiciGuida.get(t.codice) ?? 0) + 1;
    codiciGuida.set(t.codice, n);
    const driverId = n === 1 ? t.codice : `${t.codice}·${n}`;
    const pezzi = [...t.pezzi].sort((a, b) => a.partenza - b.partenza || a.arrivo - b.arrivo);
    const gruppi = new Map<number, PezzoFile[]>();
    for (const p of pezzi) { const v = gruppi.get(p.ripresa) ?? []; v.push(p); gruppi.set(p.ripresa, v); }
    const attivita: { id: string; type: string; startMin: number; endMin: number; note?: string }[] = [];
    const riprese = [...gruppi.entries()].sort(([a], [b]) => a - b).map(([, ps]) => {
      const startMin = Math.min(...ps.map((p) => p.partenza));
      const endMin = Math.max(...ps.map((p) => p.arrivo));
      const colMezzo = ps.filter((p) => p.idTurnoMacchina && PEZZI_COL_MEZZO.has(p.tipo));
      const primo = colMezzo[0], ultimo = colMezzo[colMezzo.length - 1];
      const dur = (p: PezzoFile) => p.arrivo - p.partenza;
      const pre = ps.filter((p) => PEZZI_PRE.has(p.tipo)).reduce((s, p) => s + dur(p), 0);
      const trasf = ps.filter((p) => PEZZI_TRASFERIMENTO.has(p.tipo));
      const andata = trasf.filter((p) => !primo || p.arrivo <= primo.partenza);
      const ritorno = trasf.filter((p) => primo && ultimo && p.partenza >= ultimo.arrivo);
      const trips: any[] = [];
      const deadheads: any[] = [];
      const vehicleIds: string[] = [];
      const cambi: any[] = [];
      let precedente: string | null = null;
      for (const p of colMezzo) {
        const vid = vehicleId.get(p.idTurnoMacchina!) ?? p.turnoMacchina ?? p.idTurnoMacchina!;
        if (!vehicleIds.includes(vid)) vehicleIds.push(vid);
        if (precedente && precedente !== vid) {
          cambi.push({ cluster: p.da, clusterName: nodo(p.da), fromVehicle: precedente, toVehicle: vid, atMin: p.partenza, atTime: hhmm(p.partenza) });
        }
        precedente = vid;
        if (p.tipo === PEZZO.inLinea) {
          const tripId = pezzoRiconosciuto(p, abbinamento);
          const tb = tripId ? corse.get(tripId) : undefined;
          if (!tb) { pezziSenzaCorsa++; continue; }
          trips.push({
            tripId: tb.tripId, routeId: tb.routeId, routeName: tb.routeName, variantCode: tb.variantCode ?? null,
            headsign: tb.headsign, departureTime: tb.departureTime, arrivalTime: tb.arrivalTime,
            departureMin: tb.departureMin, arrivalMin: tb.arrivalMin,
            firstStopName: tb.firstStopName, lastStopName: tb.lastStopName,
            vehicleId: vid, vehicleType: tm.get(vid)?.vehicleType ?? tipoDelMezzo(file.mezzi.get(p.idTurnoMacchina!)),
          });
        } else {
          const daNome = nodo(p.da), aNome = nodo(p.a);
          const uscita = eDeposito(p.da, daNome), rientro = eDeposito(p.a, aNome);
          deadheads.push({
            kind: uscita ? "pullout" : rientro ? "pullin" : "reposition",
            fromStop: daNome, toStop: aNome,
            departureMin: p.partenza, arrivalMin: p.arrivo,
            departureTime: hhmm(p.partenza), arrivalTime: hhmm(p.arrivo),
            km: p.metri ? Math.round(p.metri / 100) / 10 : kmStimati(p.arrivo - p.partenza, categoriaDelMezzo.get(p.idTurnoMacchina!) ?? "urbano"),
            minutes: p.arrivo - p.partenza,
            label: uscita ? "Fuorilinea · uscita deposito" : rientro ? "Fuorilinea · rientro deposito" : "Fuorilinea",
          });
        }
      }
      for (const p of ps) {
        const tipo = tipoAttivita(p.tipo);
        if (tipo && !(p.idTurnoMacchina && PEZZI_COL_MEZZO.has(p.tipo))) {
          attivita.push({ id: `file-${p.id}`, type: tipo, startMin: p.partenza, endMin: p.arrivo, note: file.tipiPezzo.get(p.tipo) ?? undefined });
        }
      }
      const ultimoPezzo = ps[ps.length - 1]!;
      return {
        startTime: hhmm(startMin), endTime: hhmm(endMin), startMin, endMin,
        ...(primo ? { serviceStartMin: primo.partenza, serviceEndMin: ultimo!.arrivo } : {}),
        preTurnoMin: pre,
        preTurnoKind: pre > 0 ? (eDeposito(ps[0]!.da, nodo(ps[0]!.da)) ? "bus" : "auto") : "none",
        deadheads,
        transferMin: andata.reduce((s, p) => s + dur(p), 0),
        transferType: andata.some((p) => PEZZI_TAXI.has(p.tipo)) ? "taxi" : andata.length ? "auto" : "none",
        transferToStop: andata.length ? nodo(andata[andata.length - 1]!.a) : undefined,
        transferBackMin: ritorno.reduce((s, p) => s + dur(p), 0),
        transferBackType: ritorno.some((p) => PEZZI_TAXI.has(p.tipo)) ? "taxi" : ritorno.length ? "auto" : "none",
        lastStop: nodo(ultimoPezzo.a),
        workMin: endMin - startMin,
        vehicleIds,
        vehicleType: vehicleIds[0] ? tm.get(vehicleIds[0])?.vehicleType : undefined,
        cambi,
        trips,
      };
    });
    const nastroStartMin = riprese.length ? riprese[0]!.startMin : 0;
    const nastroEndMin = riprese.length ? riprese[riprese.length - 1]!.endMin : 0;
    let interruptionMin = 0;
    for (let i = 1; i < riprese.length; i++) interruptionMin += Math.max(0, riprese[i]!.startMin - riprese[i - 1]!.endMin);
    const nastroMin = t.nastroMin ?? nastroEndMin - nastroStartMin;
    const workMin = t.lavoroMin ?? riprese.reduce((s, r) => s + r.workMin, 0);
    const primoMezzo = riprese.flatMap((r) => r.vehicleIds)[0];
    const tmPrimo = primoMezzo ? tm.get(primoMezzo) as any : undefined;
    return {
      driverId,
      type: tipoDelTurno(t.tipo, riprese.length, interruptionMin),
      nastroStart: hhmm(nastroStartMin), nastroEnd: hhmm(nastroEndMin),
      nastroStartMin, nastroEndMin,
      nastroMin, nastro: durata(nastroMin),
      workMin, work: durata(workMin),
      interruptionMin, interruption: interruptionMin > 0 ? durata(interruptionMin) : null,
      transferMin: riprese.reduce((s, r) => s + r.transferMin, 0),
      transferBackMin: riprese.reduce((s, r) => s + r.transferBackMin, 0),
      preTurnoMin: riprese.reduce((s, r) => s + r.preTurnoMin, 0),
      cambiCount: riprese.reduce((s, r) => s + r.cambi.length, 0),
      riprese,
      ...(attivita.length ? { activities: attivita } : {}),
      residenzaDepotId: tmPrimo?.residenzaDepotId ?? null,
      residenzaName: tmPrimo?.residenzaName ?? null,
      residenzaColor: tmPrimo?.residenzaColor ?? null,
      /* turni dell'azienda, non del calcolo di Cerbero: la verifica delle regole si chiede dall'area di lavoro */
      verifyState: "da_verificare" as const,
      tipoOrigine: t.tipo,
      residenzaOrigine: t.residenza,
      origine: "turni-esistenti" as const,
    };
  });

  const byTypeGuida: Record<string, number> = { intero: 0, semiunico: 0, spezzato: 0, supplemento: 0, invalido: 0 };
  for (const d of driverShifts) byTypeGuida[d.type] = (byTypeGuida[d.type] ?? 0) + 1;
  const principali = byTypeGuida.intero! + byTypeGuida.semiunico! + byTypeGuida.spezzato!;
  const lavoro = driverShifts.reduce((s, d) => s + d.workMin, 0);
  const nastro = driverShifts.reduce((s, d) => s + d.nastroMin, 0);
  const sommarioGuida = {
    totalDriverShifts: principali,
    totalSupplementi: byTypeGuida.supplemento,
    totalShifts: driverShifts.length,
    byType: byTypeGuida,
    totalWorkHours: +(lavoro / 60).toFixed(1),
    avgWorkMin: driverShifts.length ? Math.round(lavoro / driverShifts.length) : 0,
    totalNastroHours: +(nastro / 60).toFixed(1),
    avgNastroMin: driverShifts.length ? Math.round(nastro / driverShifts.length) : 0,
    semiunicoPct: principali ? +((byTypeGuida.semiunico! / principali) * 100).toFixed(1) : 0,
    spezzatoPct: principali ? +((byTypeGuida.spezzato! / principali) * 100).toFixed(1) : 0,
    totalCambi: driverShifts.reduce((s, d) => s + d.cambiCount, 0),
    companyCarsUsed: 0,
  };

  const resoconto: Resoconto = {
    turniGuida: driverShifts.length,
    turniMacchina: shifts.length,
    corseNelFile: abbinamento.perCorsa.size + abbinamento.nonTrovate.length,
    riconosciutePerNumero: abbinamento.perNumero,
    riconosciutePerOrario: abbinamento.perOrario,
    nonTrovate: abbinamento.nonTrovate.length,
    corseDelGtfsSenzaTurno: unassigned.length,
    turniMacchinaVuoti,
    pezziSenzaCorsa,
  };

  return {
    veicoli: { shifts, unassigned, routeStats, hourlyDist, summary, costs, score, advisories },
    guida: { driverShifts, summary: sommarioGuida, unassignedBlocks: 0, unassignedTrips: [], clusters: [], companyCars: null },
    resoconto,
  };
}

/** Dopo la residenza dei turni macchina (che chiede i depositi al database), la stessa ai turni guida. */
export function residenzaAiTurniGuida(
  guida: { driverShifts: any[] },
  shifts: { vehicleId: string; residenzaDepotId?: string | null; residenzaName?: string | null; residenzaColor?: string | null }[],
): void {
  const per = new Map(shifts.map((s) => [s.vehicleId, s]));
  for (const d of guida.driverShifts) {
    const primo = (d.riprese ?? []).flatMap((r: any) => r.vehicleIds ?? [])[0];
    const s = primo ? per.get(primo) : undefined;
    if (!s) continue;
    d.residenzaDepotId = s.residenzaDepotId ?? null;
    d.residenzaName = s.residenzaName ?? null;
    d.residenzaColor = s.residenzaColor ?? null;
  }
}
