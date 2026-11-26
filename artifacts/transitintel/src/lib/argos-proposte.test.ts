import { describe, expect, it } from "vitest";
import { origineDi, pianoDa, promptApplica } from "./argos-applica";
import { avanzamento, azioni, nomeAgente, pianoDaProposta, rangoPriorita } from "./argos-proposte";
import type { PropostaAgente } from "./argos-console";

const P: PropostaAgente = {
  id: 42, run_id: 7, project_id: "p1", kind: "shift_trip", title: "Linea 12, 7:40 a +10'", line: "12", hub: null,
  detail: "ti_shift_trip 12/0740 +10", rationale: "fonde due turni", impact: "-1 turno guida", day_type: "feriale",
  confidence: "alta", priority: "alta", status: "open", review_note: null, created_at: "", updated_at: "",
  agent_key: "regista", obiettivo: null,
};

describe("la scheda Proposte", () => {
  it("avanzamento: le fatte sul totale da fare, le scartate fuori", () => {
    expect(avanzamento({ open: 3, accepted: 1, applied: 4, rejected: 9 })).toEqual({ fatte: 4, totale: 8, percento: 50 });
    expect(avanzamento({})).toEqual({ fatte: 0, totale: 0, percento: 0 });
  });

  it("le azioni secondo lo stato; Parti da questa solo con un progetto", () => {
    expect(azioni(P)).toEqual(["parti", "fatta", "scarta"]);
    expect(azioni({ ...P, project_id: "" })).toEqual(["fatta", "scarta"]);
    expect(azioni({ ...P, status: "accepted" })).toEqual(["parti", "fatta", "da_fare", "scarta"]);
    expect(azioni({ ...P, status: "applied" })).toEqual(["riapri"]);
    expect(azioni({ ...P, status: "rejected" })).toEqual(["riapri"]);
  });

  it("nomi e priorità", () => {
    expect(nomeAgente("regista")).toBe("Argos");
    expect(nomeAgente("risorse-umane")).toBe("Risorse umane");
    expect(nomeAgente(null)).toBe("Pianificatore");
    expect(["bassa", "critica", "media", "alta", "boh"].sort((a, b) => rangoPriorita(a) - rangoPriorita(b)))
      .toEqual(["critica", "alta", "media", "bassa", "boh"]);
  });

  it("una proposta sola diventa il piano per il Pianificatore, con il suo id d'origine", () => {
    const piano = pianoDaProposta(P);
    expect(origineDi(piano)).toEqual([42]);
    expect(promptApplica(piano)).toContain("1. Linea 12, 7:40 a +10' — linea 12, giorno-tipo feriale");
  });

  it("il piano di Argos porta gli id delle proposte salvate (quelli storti no)", () => {
    const piano = pianoDa({ proposals: [{ id: 5, title: "a" }, { id: "6", title: "b" }, { id: -1, title: "c" }, { title: "d" }] })!;
    expect(origineDi(piano)).toEqual([5]);
  });
});
