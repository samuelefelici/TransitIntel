/**
 * Il traffico come dato dell'azienda (tappa 6.15, migrazione 0045), puro: i
 * punti stradali, le loro zone e il centro del modello che per Conerobus
 * entrano con la migrazione sono quelli che prima erano scritti nel codice.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatiLuogo, MASSIMO_PUNTI_TRAFFICO, USI_LUOGO } from "../lib/territorio";
import { HOURLY_MODEL, modelCongestion } from "../routes/gtfs-helpers";
import { CENTRO_DI_PRIMA, congestioneDiPrima, PUNTI_DI_PRIMA, ZONE_DI_PRIMA, zonaDiPrima } from "./helpers/traffico-di-prima";

const SQL = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0045_il_traffico_dell_azienda.sql"), "utf8");
/* le righe dei punti: ('nome', lat, lng, 'zona', ordine) */
const puntiDellaMigrazione = [...SQL.matchAll(/^\s+\('([^']+)', ([0-9.]+), ([0-9.]+), '([^']+)', (\d+)\),?$/gm)]
  .map((m) => ({ punto: m[1]!, lat: Number(m[2]), lng: Number(m[3]), zona: m[4]!, ordine: Number(m[5]) }));

describe("i dati di partenza di Conerobus nella migrazione 0045", () => {
  it("i punti stradali sono i 37 che erano nel codice, con le stesse coordinate", () => {
    expect(PUNTI_DI_PRIMA).toHaveLength(37);
    const perNome = (a: { punto: string }, b: { punto: string }) => a.punto.localeCompare(b.punto);
    expect(puntiDellaMigrazione.map(({ punto, lat, lng }) => ({ punto, lat, lng })).sort(perNome)).toEqual([...PUNTI_DI_PRIMA].sort(perNome));
    expect(new Set(puntiDellaMigrazione.map((p) => p.punto)).size).toBe(37);
  });

  it("ogni punto ha la zona in cui lo metteva la regola di prima", () => {
    for (const p of puntiDellaMigrazione) expect(p.zona, p.punto).toBe(zonaDiPrima(p.lat, p.lng));
    const perZona = Object.fromEntries(ZONE_DI_PRIMA.map((z) => [z, puntiDellaMigrazione.filter((p) => p.zona === z).length]));
    expect(perZona).toEqual({ "Centro storico": 3, "Porto / Lido": 1, "Zona Ovest": 6, "Nord / Falconara": 2, Entroterra: 25 });
  });

  it("l'ordine tiene insieme i punti di una zona, e le zone nell'ordine dei colori che avevano", () => {
    const inOrdine = [...puntiDellaMigrazione].sort((a, b) => a.ordine - b.ordine);
    expect(new Set(inOrdine.map((p) => p.ordine)).size).toBe(37);
    /* le zone come compaiono scorrendo l'elenco: ognuna una volta sola, nell'ordine di prima */
    const zoneIncontrate = inOrdine.map((p) => p.zona).filter((z, i, tutte) => i === 0 || tutte[i - 1] !== z);
    expect(zoneIncontrate).toEqual([...ZONE_DI_PRIMA]);
    /* dentro una zona i punti restano nell'ordine che avevano nel codice */
    const posto = new Map(PUNTI_DI_PRIMA.map((p, i) => [p.punto, i]));
    for (const z of ZONE_DI_PRIMA) {
      const posti = inOrdine.filter((p) => p.zona === z).map((p) => posto.get(p.punto)!);
      expect(posti, z).toEqual([...posti].sort((a, b) => a - b));
    }
  });

  it("il centro urbano è quello che il modello aveva nel codice", () => {
    expect(SQL).toContain(`SELECT 'Ancona centro', 'centro_urbano', ${CENTRO_DI_PRIMA.lat}, ${CENTRO_DI_PRIMA.lng}, 900`);
  });

  it("entrano solo dove c'è Conerobus, e solo se non ce ne sono già", () => {
    expect(SQL.match(/WHERE EXISTS \(SELECT 1 FROM public\.azienda WHERE gtfs_agency_id = 'conerobus'\)/g)).toHaveLength(2);
    expect(SQL).toContain("AND NOT EXISTS (SELECT 1 FROM public.territorio_luoghi WHERE uso = 'traffico')");
    expect(SQL).toContain("AND NOT EXISTS (SELECT 1 FROM public.territorio_luoghi WHERE uso = 'centro_urbano')");
  });

  it("gli usi ammessi dal database sono quelli dell'API", () => {
    const usi = /CHECK \(uso IN \(([^)]+)\)\)/.exec(SQL)![1]!.split(",").map((u) => u.trim().replace(/'/g, ""));
    expect(usi).toEqual([...USI_LUOGO]);
  });
});

describe("il modello del traffico misura dal centro urbano più vicino", () => {
  /* una griglia sul territorio di prima, e qualche punto lontano */
  const griglia: Array<[number, number]> = [];
  for (let lat = 43.30; lat <= 43.75; lat += 0.03) for (let lng = 12.85; lng <= 13.65; lng += 0.05) griglia.push([lng, lat]);
  const ore = [0, 5, 7, 8, 8.4, 12, 17.6, 18, 23, 26, 30, -1];

  it("con il solo centro di prima dà gli stessi numeri di prima, punto per punto e ora per ora", () => {
    for (const [lng, lat] of griglia) for (const h of ore) {
      expect(modelCongestion(h, lng, lat, [CENTRO_DI_PRIMA]), `${lat},${lng} alle ${h}`).toBe(congestioneDiPrima(HOURLY_MODEL, h, lng, lat));
    }
    for (const p of PUNTI_DI_PRIMA) expect(modelCongestion(8, p.lng, p.lat, [CENTRO_DI_PRIMA])).toBe(congestioneDiPrima(HOURLY_MODEL, 8, p.lng, p.lat));
  });

  it("con più centri vale il più vicino: una città lontana dal primo centro ha il suo", () => {
    const lontano = { lat: 43.5222, lng: 13.2436 };   // a più di 0,27 gradi dal centro di prima
    const soloIlPrimo = modelCongestion(8, lontano.lng, lontano.lat, [CENTRO_DI_PRIMA]);
    const conIlSuo = modelCongestion(8, lontano.lng, lontano.lat, [CENTRO_DI_PRIMA, lontano]);
    expect(conIlSuo).toBeGreaterThan(soloIlPrimo);
    /* e vicino al primo centro non cambia niente, in qualunque ordine siano scritti */
    expect(modelCongestion(8, 13.51, 43.61, [lontano, CENTRO_DI_PRIMA])).toBe(modelCongestion(8, 13.51, 43.61, [CENTRO_DI_PRIMA]));
  });

  it("resta sempre fra il 2% e il 98%", () => {
    for (const [lng, lat] of griglia) for (const h of ore) {
      const c = modelCongestion(h, lng, lat, [CENTRO_DI_PRIMA, { lat: 43.7151, lng: 13.2175 }]);
      expect(c).toBeGreaterThanOrEqual(0.02);
      expect(c).toBeLessThanOrEqual(0.98);
    }
  });
});

describe("un punto stradale, la validazione", () => {
  const punto = { nome: " A14-Nord ", uso: "traffico", lat: 43.64, lng: 13.43 };

  it("la zona è facoltativa, senza spazi ai lati, al più 60 caratteri", () => {
    expect(DatiLuogo.safeParse(punto).data).toMatchObject({ nome: "A14-Nord", uso: "traffico", zona: null, raggioM: null });
    expect(DatiLuogo.safeParse({ ...punto, zona: "  Zona Ovest " }).data).toMatchObject({ zona: "Zona Ovest" });
    expect(DatiLuogo.safeParse({ ...punto, zona: "" }).data).toMatchObject({ zona: null });
    expect(DatiLuogo.safeParse({ ...punto, zona: "z".repeat(61) }).success).toBe(false);
    expect(DatiLuogo.safeParse({ ...punto, zona: "Zo\u0007na" }).success).toBe(false);
  });

  it("un centro urbano è un luogo come gli altri", () => {
    expect(DatiLuogo.safeParse({ nome: "Centro", uso: "centro_urbano", lat: 43.6, lng: 13.5 }).success).toBe(true);
  });

  it("al più cento punti: ognuno è una richiesta al fornitore a ogni giro", () => {
    expect(MASSIMO_PUNTI_TRAFFICO).toBe(100);
  });
});
