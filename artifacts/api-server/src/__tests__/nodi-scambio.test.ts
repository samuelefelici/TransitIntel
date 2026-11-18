/**
 * I nodi di scambio come dato dell'azienda (tappa 6.16, migrazione 0046),
 * puro. Prima i nodi erano scritti nel codice in due copie: una per l'analisi
 * intermodale e una per le zone di coincidenza (helpers/nodi-di-prima.json,
 * com'erano). Qui si prova che i nove nodi che la migrazione dà a Conerobus
 * sono quelli, che l'analisi vede gli stessi sei di prima, e che le zone
 * vedono gli otto di prima più l'aeroporto, con le sole differenze decise.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { comeHub, hubDellAnalisi, orariInOrdine, orarioNormale, TIPI_NODO, type NodoDiScambio } from "../lib/nodi-scambio";
import { DatiNodo, NuovoNodo } from "../lib/nodi-scambio-store";

const PRIMA: { analisi: any[]; zone: any[] } = JSON.parse(readFileSync(path.join(__dirname, "helpers/nodi-di-prima.json"), "utf8"));
const SQL = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0046_i_nodi_di_scambio.sql"), "utf8");

/* le righe della migrazione: (nodo, nome, tipo, lat, lng, fermate, minuti, descrizione, arrivi, partenze, ordine) */
const testo = (s: string) => s.replace(/''/g, "'");
const NODI: NodoDiScambio[] = [...SQL.matchAll(
  /\('([^']+)', '((?:[^']|'')*)', '([a-z-]+)', ([0-9.]+), ([0-9.]+), (ARRAY\[[^\]]*\]::text\[\]|'\{\}'::text\[\]), (\d+), '((?:[^']|'')*)',\s*'((?:[^']|'')*)'::jsonb,\s*'((?:[^']|'')*)'::jsonb, (\d+)\)/g,
)].map((m) => ({
  nodo: m[1]!, nome: testo(m[2]!), tipo: m[3] as NodoDiScambio["tipo"], lat: Number(m[4]), lng: Number(m[5]),
  fermateGtfs: m[6]!.startsWith("ARRAY") ? [...m[6]!.matchAll(/'([^']*)'/g)].map((f) => f[1]!) : [],
  minutiAPiedi: Number(m[7]), descrizione: testo(m[8]!),
  arrivi: JSON.parse(testo(m[9]!)), partenze: JSON.parse(testo(m[10]!)), ordine: Number(m[11]),
}));

describe("i nodi di Conerobus nella migrazione 0046", () => {
  it("sono nove: i sei dell'analisi, poi i tre parcheggi scambiatori delle zone", () => {
    expect(NODI.map((n) => n.nodo)).toEqual([
      "rail-ancona", "rail-falconara", "rail-palombina", "port-ancona", "airport-falconara", "rail-torrette",
      "pr-tavernelle", "pr-baraccola", "pr-posatora",
    ]);
    expect(NODI.map((n) => n.ordine)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(NODI.every((n) => TIPI_NODO.includes(n.tipo))).toBe(true);
  });

  it("l'analisi intermodale vede i sei nodi di prima, campo per campo e nello stesso ordine", () => {
    expect(hubDellAnalisi(NODI)).toEqual(PRIMA.analisi);
  });

  it("le zone di coincidenza vedono gli otto nodi di prima, più l'aeroporto, con le sole differenze decise", () => {
    const oggi = NODI.map(comeHub);
    expect(oggi.map((h) => h.id).filter((id) => id !== "airport-falconara").sort()).toEqual(PRIMA.zone.map((h) => h.id).sort());
    const differenze: string[] = [];
    for (const prima of PRIMA.zone) {
      const ora = oggi.find((h) => h.id === prima.id)!;
      for (const campo of ["name", "type", "lat", "lng", "gtfsStopIds", "platformWalkMinutes"] as const) {
        expect(ora[campo], `${prima.id}.${campo}`).toEqual(prima[campo]);
      }
      if (ora.description !== prima.description) differenze.push(`${prima.id}: descrizione`);
      /* gli orari: gli stessi, per luogo; cambia solo il nome di qualche luogo */
      for (const verso of ["typicalArrivals", "typicalDepartures"] as const) {
        const chiave = verso === "typicalArrivals" ? "origin" : "destination";
        const orari = (l: any[]) => l.map((c) => c.times.join(" ")).sort();
        expect(orari(ora[verso]), `${prima.id}.${verso}`).toEqual(orari(prima[verso]));
        const luoghiPrima = new Set(prima[verso].map((c: any) => c[chiave]));
        for (const c of ora[verso] as any[]) if (!luoghiPrima.has(c[chiave])) differenze.push(`${prima.id}: «${c[chiave]}»`);
      }
    }
    expect(differenze.sort()).toEqual([
      "port-ancona: descrizione",
      "port-ancona: «Durazzo (AL) - Adria Ferries»", "port-ancona: «Durazzo (AL) - Adria Ferries»",
      "port-ancona: «Patrasso (GR) - Minoan/Anek»", "port-ancona: «Patrasso (GR) - Minoan/Anek»",
      "rail-ancona: descrizione", "rail-falconara: descrizione", "rail-palombina: descrizione", "rail-torrette: descrizione",
    ]);
  });

  it("gli orari scritti nella migrazione sono già nella forma che il salvataggio dà: normali, in ordine, senza doppioni", () => {
    for (const n of NODI) for (const c of [...n.arrivi, ...n.partenze]) {
      expect(c.orari.map(orarioNormale), `${n.nodo} ${c.luogo}`).toEqual(c.orari);
      expect(orariInOrdine(c.orari), `${n.nodo} ${c.luogo}`).toEqual(c.orari);
      expect(c.luogo).not.toContain(":");
    }
  });

  it("entrano solo dove c'è Conerobus, e solo se la tabella è vuota", () => {
    expect(SQL).toContain("WHERE EXISTS (SELECT 1 FROM public.azienda WHERE gtfs_agency_id = 'conerobus')");
    expect(SQL).toContain("AND NOT EXISTS (SELECT 1 FROM public.nodi_scambio)");
  });
});

describe("gli orari", () => {
  it("un orario: HH:MM da 00:00 a 47:59, con lo zero davanti", () => {
    expect(["6:10", "06:10", " 23:59 ", "24:00", "47:59"].map(orarioNormale)).toEqual(["06:10", "06:10", "23:59", "24:00", "47:59"]);
    expect(["48:00", "6:1", "06:60", "6.10", "", "ore 6"].map(orarioNormale)).toEqual([null, null, null, null, null, null]);
  });
});

describe("un nodo, la validazione", () => {
  const nodo = { nodo: "stazione-centrale", nome: " Stazione Centrale ", tipo: "railway", lat: 44.5, lng: 11.3 };

  it("quello che manca ha il suo valore; gli orari si mettono in ordine, senza doppioni", () => {
    const p = NuovoNodo.safeParse({ ...nodo, partenze: [{ luogo: " Roma ", orari: ["9:00", "07:30", "09:00"] }] });
    expect(p.success, JSON.stringify(p.error?.issues)).toBe(true);
    expect(p.data).toMatchObject({
      nome: "Stazione Centrale", fermateGtfs: [], minutiAPiedi: 2, descrizione: "", arrivi: [], ordine: 0,
      partenze: [{ luogo: "Roma", orari: ["07:30", "09:00"] }],
    });
  });

  it("un orario sbagliato, un luogo con i due punti, una riga senza orari: rifiutati", () => {
    expect(NuovoNodo.safeParse({ ...nodo, arrivi: [{ luogo: "Roma", orari: ["25:61"] }] }).success).toBe(false);
    expect(NuovoNodo.safeParse({ ...nodo, arrivi: [{ luogo: "Roma: centro", orari: ["08:00"] }] }).success).toBe(false);
    expect(NuovoNodo.safeParse({ ...nodo, arrivi: [{ luogo: "Roma", orari: [] }] }).success).toBe(false);
    expect(NuovoNodo.safeParse({ ...nodo, arrivi: Array.from({ length: 41 }, (_, i) => ({ luogo: `L${i}`, orari: ["08:00"] })) }).success).toBe(false);
  });

  it("l'identificativo: minuscole, cifre e trattini; non quelli dei nodi che l'analisi trova da sola", () => {
    for (const ok of ["rail-ancona", "pr-2", "porto"]) expect(NuovoNodo.safeParse({ ...nodo, nodo: ok }).success, ok).toBe(true);
    for (const no of ["Rail", "-porto", "a", "gtfs-railway-x", "synthetic-center-1", "porto centrale", "x".repeat(41)]) {
      expect(NuovoNodo.safeParse({ ...nodo, nodo: no }).success, no).toBe(false);
    }
    /* cambiandolo, l'identificativo non si manda: è quello che le zone ricordano */
    expect(DatiNodo.safeParse({ ...nodo }).success).toBe(false);
    const { nodo: _id, ...senza } = nodo;
    expect(DatiNodo.safeParse(senza).success).toBe(true);
  });

  it("il tipo fra i quattro; le fermate GTFS senza spazi, una volta sola", () => {
    expect(NuovoNodo.safeParse({ ...nodo, tipo: "bus" }).success).toBe(false);
    expect(NuovoNodo.safeParse({ ...nodo, fermateGtfs: ["13", " 18 ", "13"] }).data?.fermateGtfs).toEqual(["13", "18"]);
    expect(NuovoNodo.safeParse({ ...nodo, fermateGtfs: ["1 3"] }).success).toBe(false);
  });
});
