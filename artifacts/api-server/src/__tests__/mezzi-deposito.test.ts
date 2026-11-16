/**
 * Mezzi per deposito (tappa 5.3), senza database: il confronto fra il
 * fabbisogno dei turni macchina e i mezzi dell'officina.
 */
import { describe, it, expect } from "vitest";
import { mezziPerDeposito, type FabbisognoTurni } from "../lib/mezzi-deposito";
import type { ParcoOfficina, MezzoOfficina } from "../lib/officina";
import type { Deposito } from "../lib/anagrafica-campi";

const catalogo = [
  { codice: "jesi", nome: "Jesi", alias: [] },
  { codice: "ancona", nome: "Ancona", alias: [] },
] as unknown as Deposito[];
const mezzo = (matricola: string, deposito: string | null, stato: MezzoOfficina["stato"], modello: string | null, extra: Partial<MezzoOfficina> = {}): MezzoOfficina => ({
  matricola, numeroDiParco: matricola, targa: "", stato, deposito, modello, fermoDal: null, fermoMotivo: null, commessa: null, segnalazioneAvm: null, ...extra,
});
const parco: ParcoOfficina = {
  disponibile: true, motivo: null, tenant: "t", lettoAlle: "2026-11-16T10:00:00Z",
  mezzi: [
    mezzo("301", "Deposito Jesi", "in_servizio", "12m"), mezzo("302", "Deposito Jesi", "in_servizio", "12m"),
    mezzo("303", "Deposito Jesi", "riserva", "12m"),
    mezzo("304", "Deposito Jesi", "in_officina", "12m", { fermoDal: "2026-11-10T08:00:00Z", fermoMotivo: "frizione", commessa: "C-12" }),
    mezzo("305", "Deposito Jesi", "dismesso", "12m"),
    mezzo("401", "Ancona", "in_servizio", "Citaro"), mezzo("402", "Ancona", "in_servizio", "Citaro"), mezzo("403", "Ancona", "in_servizio", "Citaro"),
  ],
};
const fabbisogno: FabbisognoTurni[] = [
  { deposito: "Deposito di Jesi", tipo: "12m", turni: 4 },
  { deposito: "Ancona", tipo: "10m", turni: 2 },
];

describe("mezzi per deposito", () => {
  it("fabbisogno, disponibili, fermi e margine; prima dove mancano mezzi", () => {
    const r = mezziPerDeposito({ fabbisogno, parco, catalogo });
    expect(r.map((x) => [x.codice, x.margine])).toEqual([["jesi", -1], ["ancona", 1]]);
    const jesi = r[0]!;
    expect(jesi.fabbisogno).toEqual({ totale: 4, perTipo: [{ tipo: "12m", turni: 4 }] });
    expect(jesi.disponibili).toEqual({ totale: 3, inServizio: 2, riserva: 1, perModello: [{ modello: "12m", mezzi: 3 }] });
    expect(jesi.inOfficina).toEqual([{ matricola: "304", modello: "12m", fermoDal: "2026-11-10T08:00:00Z", motivo: "frizione", commessa: "C-12" }]);
    // stesso nome nei turni e nell'officina: il confronto per tipo
    expect(jesi.perTipo).toEqual([{ tipo: "12m", servono: 4, ci_sono: 3 }]);
    // nomi diversi (10m e Citaro): solo i totali
    expect(r[1]!.perTipo).toEqual([]);
  });
  it("senza officina: solo il fabbisogno, nessun margine", () => {
    const r = mezziPerDeposito({ fabbisogno, parco: { ...parco, disponibile: false, motivo: "FleetCare non risponde", mezzi: [] }, catalogo });
    expect(r.map((x) => [x.codice, x.fabbisogno.totale, x.disponibili, x.margine])).toEqual([["ancona", 2, null, null], ["jesi", 4, null, null]]);
  });
  it("chi vede solo alcuni depositi vede solo quelli", () => {
    const r = mezziPerDeposito({ fabbisogno, parco, catalogo, vede: (c) => c === "ancona" });
    expect(r.map((x) => x.codice)).toEqual(["ancona"]);
  });
});
