/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEDURRE LA FERMATA DAI DATI — quale stop_id è davvero questa palina
 * ───────────────────────────────────────────────────────────────────────────
 * Lo StopMonitoring dice, per una palina di Mizar, quali corse ci passano e
 * a che ora programmata. Il feed dice, per ogni corsa, a che ora passa da
 * ogni stop_id. Se la corsa 369662 passa dalla palina 1122 alle 11:12:00 e
 * nel feed la stessa corsa passa da 20045 alle 11:12:00, la coppia
 * 1122 ↔ 20045 è dimostrata senza guardare nessun nome.
 *
 * Ripetuto su tutte le corse della finestra, il candidato che raccoglie le
 * prove è la fermata. Due candidati con prove simili (banchine vicine
 * servite allo stesso minuto) restano un dubbio, non una scelta: qui si
 * suggerisce, decide l'operatore. Pura, collaudabile.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { unisciVisite, secondiLocali, secondiGtfs, scartoCircolare, fuoriServizio, type VisitaFermata, type RigaOrario } from "./siri-fermata";

export interface CandidatoFermata {
  stopId: string;
  /** corse che passano da questo stop_id allo stesso orario della palina */
  prove: number;
  /** esempi (corsa, orario) */
  esempi: Array<{ corsa: string; orario: string }>;
}

export interface Deduzione {
  /** passaggi di linea con corsa nel feed: la base delle prove */
  passaggiUtili: number;
  candidati: CandidatoFermata[];
  /** il candidato quando è netto: almeno due prove e almeno il doppio del secondo */
  suggerito: string | null;
  lettura: string;
}

export function deduciFermata(
  visite: VisitaFermata[],
  tripByCode: Map<string, string> | undefined,
  orari: Map<string, RigaOrario[]>,
  timeZone?: string,
  tolleranzaSec = 60,
): Deduzione {
  const conteggio = new Map<string, CandidatoFermata>();
  let utili = 0;
  for (const v of unisciVisite(visite)) {
    if (fuoriServizio(v) || !v.courseOfJourneyRef) continue;
    const tripId = tripByCode?.get(v.courseOfJourneyRef.trim());
    if (!tripId) continue;
    const righe = orari.get(tripId);
    const quando = v.aimedDeparture ?? v.aimedArrival;
    if (!righe?.length || !quando) continue;
    utili++;
    const sec = secondiLocali(quando, timeZone);
    /* Tutte le righe della corsa entro la tolleranza: di solito una. */
    for (const r of righe) {
      const s = secondiGtfs(r.scheduled);
      if (s == null || Math.abs(scartoCircolare(sec, s)) > tolleranzaSec) continue;
      const c = conteggio.get(r.stopId) ?? { stopId: r.stopId, prove: 0, esempi: [] };
      c.prove++;
      if (c.esempi.length < 3) c.esempi.push({ corsa: v.courseOfJourneyRef, orario: r.scheduled });
      conteggio.set(r.stopId, c);
    }
  }
  const candidati = [...conteggio.values()].sort((a, b) => b.prove - a.prove);
  const primo = candidati[0], secondo = candidati[1];
  const suggerito = primo && primo.prove >= 2 && (!secondo || primo.prove >= 2 * secondo.prove) ? primo.stopId : null;
  const lettura = !utili
    ? "Nessun passaggio di linea agganciato al feed in questa finestra: niente da cui dedurre."
    : !candidati.length
      ? `${utili} passaggi agganciati, ma nessuna fermata del feed con lo stesso orario: la corsa nel feed non passa di qui a quell'ora.`
      : suggerito
        ? `${primo.prove} passaggi su ${utili} coincidono con lo stop_id ${suggerito}${secondo ? `; il secondo candidato (${secondo.stopId}) ne ha ${secondo.prove}` : ", nessun altro candidato"}.`
        : `Candidati con prove simili (${candidati.slice(0, 3).map(c => `${c.stopId}: ${c.prove}`).join(", ")}): banchine servite allo stesso orario, va scelta a mano.`;
  return { passaggiUtili: utili, candidati, suggerito, lettura };
}
