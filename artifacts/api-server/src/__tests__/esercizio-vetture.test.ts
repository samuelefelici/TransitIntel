/**
 * Gli avvisi sulle vetture dei turni macchina (tappa 5.4), puri: mai blocchi.
 */
import { describe, it, expect } from "vitest";
import { avvisiVetture, MATRICOLA, type TurnoConVettura } from "../lib/esercizio-vetture";
import type { ParcoOfficina } from "../lib/officina";

const turno = (turnoMacchina: string, uscita: string | null, rientro: string | null, vettura: string | null, extra: Partial<TurnoConVettura> = {}): TurnoConVettura => ({
  vssId: "v", turnoMacchina, udp: null, deposito: "Jesi", depositoCodice: "jesi", tipoMezzo: "12m",
  uscita, rientro, corse: 3, vettura, assegnataDa: null, assegnataIl: null, vistaDallAvm: [], avvisi: [], ...extra,
});
const mezzo = (matricola: string, modello: string | null, stato: "in_servizio" | "riserva" | "in_officina" | "dismesso", fermoDal: string | null = null) => ({
  matricola, targa: null, modello, deposito: "Jesi", stato, fermoDal, fermoMotivo: null, commessa: null,
});
const parco = (mezzi: ReturnType<typeof mezzo>[]): ParcoOfficina => ({ disponibile: true, motivo: null, mezzi } as unknown as ParcoOfficina);

describe("avvisi sulle vetture dei turni macchina", () => {
  it("la stessa vettura su due turni che si sovrappongono; in fila no", () => {
    const [a, b, c] = avvisiVetture([
      turno("M1", "05:00", "09:30", "301"),
      turno("M2", "09:00", "13:00", "301"),
      turno("M3", "13:00", "26:05", "301"),
    ], null);
    expect(a!.avvisi).toEqual(["La vettura 301 è anche sul turno M2, che si sovrappone"]);
    expect(b!.avvisi).toEqual(["La vettura 301 è anche sul turno M1, che si sovrappone"]);
    expect(c!.avvisi).toEqual([]);
  });

  it("senza orari si avvisa comunque, senza dire che si sovrappone; le maiuscole e gli spazi non contano", () => {
    const [a] = avvisiVetture([turno("M1", null, null, "ab 12"), turno("M2", "10:00", "11:00", " AB 12 ")], null);
    expect(a!.avvisi).toEqual(["La vettura ab 12 è anche sul turno M2"]);
  });

  it("officina: ferma o dismessa; il tipo solo se l'officina usa gli stessi nomi dei turni", () => {
    const p = parco([mezzo("301", "12m", "in_officina", "2032-06-10T08:00:00Z"), mezzo("302", "18m", "in_servizio"), mezzo("303", "Citaro", "riserva"), mezzo("304", null, "dismesso")]);
    const turni = avvisiVetture([
      turno("M1", "05:00", "08:00", "301"),
      turno("M2", "05:00", "08:00", "302"),
      turno("M3", "05:00", "08:00", "303"),
      turno("M4", "05:00", "08:00", "304"),
      turno("M5", "05:00", "08:00", "999"),
      turno("M6", "05:00", "08:00", null, { tipoMezzo: "18m" }),
    ], p);
    expect(turni.map((t) => t.avvisi)).toEqual([
      ["La vettura 301 è ferma in officina dal 2032-06-10"],
      ["Il turno vuole 12m, la vettura 302 è 18m"],
      // «Citaro» non è un tipo dei turni del giorno: nessun confronto
      [],
      ["La vettura 304 risulta dismessa"],
      // non è nel parco (scritta a mano): nessun avviso
      [],
      [],
    ]);
  });

  it("l'AVM ha visto altre vetture sulle corse del turno", () => {
    const [a, b] = avvisiVetture([
      turno("M1", "05:00", "08:00", "301", { vistaDallAvm: ["301", "305"] }),
      turno("M2", "09:00", "12:00", null, { vistaDallAvm: ["306"] }),
    ], null);
    expect(a!.avvisi).toEqual(["L'AVM ha visto un'altra vettura sulle corse del turno: 305"]);
    // senza vettura assegnata non c'è niente da confrontare
    expect(b!.avvisi).toEqual([]);
  });

  it("officina non disponibile: nessun avviso dall'officina", () => {
    const [a] = avvisiVetture([turno("M1", "05:00", "08:00", "301")], { disponibile: false, motivo: "non collegata", mezzi: [] } as unknown as ParcoOfficina);
    expect(a!.avvisi).toEqual([]);
  });

  it("la matricola: lettere, cifre e pochi segni, al più 40", () => {
    for (const ok of ["301", "AB 123", "FR-12.3/A", "x".repeat(40)]) expect(MATRICOLA.test(ok)).toBe(true);
    for (const no of ["", " 301", "-1", "<b>", "x".repeat(41), "a;drop"]) expect(MATRICOLA.test(no)).toBe(false);
  });
});
