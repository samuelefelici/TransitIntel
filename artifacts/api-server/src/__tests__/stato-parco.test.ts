/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Stato del parco — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questo elenco manda qualcuno a controllare un mezzo. Sbagliare la causa
 * significa far cercare un'antenna GPS quando il problema è la SIM: due
 * interventi diversi, due reparti diversi, e un giro a vuoto.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  diagnosiVettura, statoParco, parseVehicleMonitoringResponse,
  type SiriVehicle,
} from "../lib/siri-vm";

const ORA = new Date("2026-09-10T19:20:00+02:00").getTime();
const fa = (secondi: number) => new Date(ORA - secondi * 1000);

/** Una vettura come arriva dal flusso, poi modificata caso per caso. */
const BASE = `<Envelope><VehicleMonitoringDelivery><VehicleActivity>
  <RecordedAtTime>2026-09-10T19:19:00+02:00</RecordedAtTime>
  <MonitoredVehicleJourney>
    <VehicleRef>268</VehicleRef><Monitored>true</Monitored>
    <VehicleLocation><Longitude>13.5</Longitude><Latitude>43.6</Latitude></VehicleLocation>
    <ProgressStatus>InDepot</ProgressStatus>
  </MonitoredVehicleJourney>
</VehicleActivity></VehicleMonitoringDelivery></Envelope>`;

function vettura(over: Partial<SiriVehicle> = {}): SiriVehicle {
  const v = parseVehicleMonitoringResponse(BASE).vehicles[0];
  return { ...v, recordedAt: fa(60), inDepot: false, ...over };
}

describe("diagnosi della singola vettura", () => {
  it("un mezzo in corsa è in servizio, anche se il contatto è di un minuto fa", () => {
    const d = diagnosiVettura(vettura({ journeyRef: "472661", recordedAt: fa(75) }), ORA);
    expect(d.stato).toBe("in_servizio");
  });

  /* Le due cause non si riparano allo stesso modo: la SIM è un reparto, il
   * GPS è un altro. Confonderle manda qualcuno a fare un giro a vuoto. */
  it("distingue la mancanza di rete da quella del segnale satellitare", () => {
    expect(diagnosiVettura(vettura({ monitoringError: "GPRS" }), ORA).stato)
      .toBe("senza_rete");
    expect(diagnosiVettura(vettura({ monitoringError: "GPS" }), ORA).stato)
      .toBe("senza_gps");
  });

  it("una vettura in rimessa senza errori è in rimessa, non guasta", () => {
    const d = diagnosiVettura(vettura({ inDepot: true, monitoringError: null }), ORA);
    expect(d.stato).toBe("in_rimessa");
  });

  it("una vettura seguita e senza corsa è pronta", () => {
    const d = diagnosiVettura(vettura({ monitoringError: null }), ORA);
    expect(d.stato).toBe("pronta");
  });

  /* Oltre un giorno non è più un disservizio momentaneo: è un apparato. */
  it("oltre un giorno di silenzio la vettura è muta, qualunque cosa dichiari", () => {
    const d = diagnosiVettura(
      vettura({ recordedAt: fa(3 * 24 * 3600), journeyRef: "472661", inDepot: false }), ORA);
    expect(d.stato).toBe("muta");
    expect(d.etaContattoSec).toBe(3 * 24 * 3600);
  });

  it("riporta quando e perché, non solo lo stato", () => {
    const d = diagnosiVettura(
      vettura({ monitoringError: "GPRS", progressStatus: "InDepot/ExpiredLocalization" }), ORA);
    expect(d.ultimoContatto).toBe(fa(60).toISOString());
    expect(d.errore).toBe("GPRS");
    expect(d.progressStatus).toBe("InDepot/ExpiredLocalization");
  });

  it("una vettura senza contatto noto non viene dichiarata muta per supposizione", () => {
    const d = diagnosiVettura(vettura({ recordedAt: null, monitoringError: null }), ORA);
    expect(d.etaContattoSec).toBeNull();
    expect(d.stato).not.toBe("muta");
  });
});

describe("quadro del parco", () => {
  const parco = [
    vettura({ vehicleRef: "268", journeyRef: "T1" }),
    vettura({ vehicleRef: "278", journeyRef: "T2" }),
    vettura({ vehicleRef: "301", monitoringError: null }),
    vettura({ vehicleRef: "310", inDepot: true, monitoringError: null }),
    vettura({ vehicleRef: "402", monitoringError: "GPRS" }),
    vettura({ vehicleRef: "415", monitoringError: "GPS" }),
    vettura({ vehicleRef: "433", recordedAt: fa(40 * 24 * 3600) }),
    vettura({ vehicleRef: "450", recordedAt: fa(6 * 24 * 3600) }),
  ];

  it("conta le vetture per stato", () => {
    const s = statoParco(parco, ORA);
    expect(s.totale).toBe(8);
    const m = new Map(s.perStato.map(x => [x.stato, x.conteggio]));
    expect(m.get("in_servizio")).toBe(2);
    expect(m.get("pronta")).toBe(1);
    expect(m.get("in_rimessa")).toBe(1);
    expect(m.get("senza_rete")).toBe(1);
    expect(m.get("senza_gps")).toBe(1);
    expect(m.get("muta")).toBe(2);
  });

  /* L'elenco è l'ordine in cui si apre un'officina: prima le mute, e fra
   * quelle prima la più ferma. */
  it("mette in cima le vetture ferme da più tempo", () => {
    const s = statoParco(parco, ORA);
    expect(s.daVerificare[0].vehicleRef).toBe("433");   // 40 giorni
    expect(s.daVerificare[1].vehicleRef).toBe("450");   // 6 giorni
    expect(s.daVerificare).toHaveLength(4);             // 2 mute + rete + gps
  });

  /* Chi è in rimessa o pronto non va in officina: sono mezzi sani. */
  it("non manda a verificare le vetture sane", () => {
    const s = statoParco(parco, ORA);
    const refs = s.daVerificare.map(d => d.vehicleRef);
    expect(refs).not.toContain("268");
    expect(refs).not.toContain("310");
  });

  it("misura la quota di parco davvero seguita", () => {
    const s = statoParco(parco, ORA);
    expect(s.quotaUtilizzabile).toBe(0.375);   // 3 su 8
  });

  it("nomina le vetture mute, che sono il fatto da riportare", () => {
    expect(statoParco(parco, ORA).nota).toMatch(/non danno segno/i);
  });

  it("su un parco sano riporta la copertura invece di un allarme", () => {
    const sane = [vettura({ journeyRef: "T1" }), vettura({ monitoringError: null })];
    expect(statoParco(sane, ORA).nota).toMatch(/utilizzabile/i);
  });

  it("su elenco vuoto non inventa un parco", () => {
    const s = statoParco([], ORA);
    expect(s.totale).toBe(0);
    expect(s.quotaUtilizzabile).toBe(0);
    expect(s.nota).toMatch(/nessuna vettura/i);
  });
});
