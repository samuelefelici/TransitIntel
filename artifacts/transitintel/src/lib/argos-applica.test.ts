import { describe, expect, it } from "vitest";
import { pianoDa, promptApplica, titoloApplica } from "./argos-applica";

const PIANO = {
  summary: "Deposito Nord, lunedì: un turno in meno spostando una corsa",
  proposals: [
    { title: "Linea 12, corsa delle 7:40 a +10'", detail: "ti_shift_trip sulla corsa 12/0740, +10 minuti", line: "12",
      day_type: "feriale", rationale: "fonde due turni macchina; nessuna coincidenza rotta", impact: "-1 turno guida" },
    { title: "", detail: "senza titolo: si scarta" },
    "non è un oggetto",
  ],
};

describe("applica col Pianificatore", () => {
  it("il piano si legge con prudenza: solo gli interventi con un titolo", () => {
    const p = pianoDa(PIANO)!;
    expect(p.interventi).toHaveLength(1);
    expect(p.interventi[0]).toMatchObject({ linea: "12", giornoTipo: "feriale", effetto: "-1 turno guida" });
    expect(pianoDa({ summary: "niente", proposals: [] })).toBeNull();
    expect(pianoDa("piano")).toBeNull();
    expect(pianoDa({ proposals: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` })) })!.interventi).toHaveLength(12);
  });

  it("il messaggio al Pianificatore: interventi, scritture con rilettura, ritorno indietro, verifica col giro", () => {
    const testo = promptApplica(pianoDa(PIANO)!);
    expect(testo).toContain("1. Linea 12, corsa delle 7:40 a +10' — linea 12, giorno-tipo feriale");
    expect(testo).toContain("Effetto atteso: -1 turno guida");
    expect(testo).toContain("ti_shift_trip");
    expect(testo).toContain("come tornare indietro");
    expect(testo).toContain("ti_vcsp_compare");
    expect(testo).not.toContain("senza titolo");
  });

  it("il titolo della conversazione", () => {
    expect(titoloApplica(pianoDa(PIANO)!)).toBe("Applica: Deposito Nord, lunedì: un turno in meno spostando una corsa");
    expect(titoloApplica(pianoDa({ proposals: [{ title: "Sposta la 7:40" }] })!)).toBe("Applica: Sposta la 7:40");
  });
});
