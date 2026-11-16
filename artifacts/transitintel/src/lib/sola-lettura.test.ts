import { describe, expect, it } from "vitest";
import { chiLoDecide, dettaglioSolaLettura, frenoAvvisi, mancaLaScrittura, motivoSolaLettura, propsDelComandoSpento, rifiutoDiSolaLettura } from "./sola-lettura";

describe("rifiutoDiSolaLettura", () => {
  it("lo riconosce dal campo, non dal testo", () => {
    expect(rifiutoDiSolaLettura(403, { error: "Sola lettura: per modificare serve la scrittura su «Turni»", solaLettura: true }))
      .toEqual({ messaggio: "Sola lettura: per modificare serve la scrittura su «Turni»" });
    // il testo da solo non basta: un handler può dire «Sola lettura» per altri motivi
    expect(rifiutoDiSolaLettura(403, { error: "Sola lettura: per modificare serve la scrittura su «Turni»" })).toBeNull();
    expect(rifiutoDiSolaLettura(403, { error: "Manca l'accesso a «Turni»" })).toBeNull();
    expect(rifiutoDiSolaLettura(403, { solaLettura: "true" })).toBeNull();
  });

  it("solo sui 403", () => {
    expect(rifiutoDiSolaLettura(200, { solaLettura: true })).toBeNull();
    expect(rifiutoDiSolaLettura(401, { solaLettura: true })).toBeNull();
    expect(rifiutoDiSolaLettura(500, { solaLettura: true })).toBeNull();
  });

  it("non si rompe con corpi strani, e senza messaggio ne dà uno suo", () => {
    for (const corpo of [null, undefined, "testo", 7, []]) expect(rifiutoDiSolaLettura(403, corpo)).toBeNull();
    expect(rifiutoDiSolaLettura(403, { solaLettura: true })?.messaggio).toMatch(/^Sola lettura/);
    expect(rifiutoDiSolaLettura(403, { solaLettura: true, error: { x: 1 } })?.messaggio).toMatch(/^Sola lettura/);
    expect(rifiutoDiSolaLettura(403, { solaLettura: true, error: "x".repeat(900) })?.messaggio).toHaveLength(300);
  });
});

describe("dettaglioSolaLettura", () => {
  it("toglie il prefisso e mette la maiuscola", () => {
    expect(dettaglioSolaLettura("Sola lettura: per modificare serve la scrittura su «Turni»")).toBe("Per modificare serve la scrittura su «Turni»");
    expect(dettaglioSolaLettura("Un altro testo")).toBe("Un altro testo");
    expect(dettaglioSolaLettura("Sola lettura:")).toBe("");
  });
});

describe("chiLoDecide", () => {
  it("di solito manca un ruolo; per un rifiuto di deposito mancano i depositi", () => {
    expect(chiLoDecide("Sola lettura: per modificare serve la scrittura su «Roster»")).toBe("Il ruolo lo assegna l'amministratore");
    expect(chiLoDecide("Sola lettura: il conducente è del deposito «Ancona», e tu scrivi solo sui conducenti di Jesi")).toBe("I depositi li sceglie l'amministratore");
    expect(chiLoDecide("Sola lettura: questo conducente è di un altro deposito, e tu scrivi solo sui conducenti dei tuoi")).toBe("I depositi li sceglie l'amministratore");
    expect(chiLoDecide("Sola lettura: i conducenti di prova nascono in tutti i depositi, e tu scrivi solo sui tuoi")).toBe("I depositi li sceglie l'amministratore");
    // senza messaggio vale la frase di sempre
    expect(chiLoDecide("")).toBe("Il ruolo lo assegna l'amministratore");
  });
});

describe("frenoAvvisi", () => {
  it("lo stesso messaggio non si ripete prima del tempo", () => {
    const annuncia = frenoAvvisi(4000);
    expect(annuncia("a", 1000)).toBe(true);
    expect(annuncia("a", 2000)).toBe(false);
    expect(annuncia("a", 4999)).toBe(false);
    expect(annuncia("a", 5000)).toBe(true);
  });
  it("un messaggio diverso passa subito", () => {
    const annuncia = frenoAvvisi(4000);
    expect(annuncia("turni", 1000)).toBe(true);
    expect(annuncia("roster", 1100)).toBe(true);
    expect(annuncia("roster", 1200)).toBe(false);
  });
});

describe("i comandi spenti", () => {
  it("il motivo nomina le aree che servono", () => {
    expect(motivoSolaLettura(["Turni"])).toBe("Sola lettura: per farlo serve la scrittura su «Turni». Il ruolo lo assegna l'amministratore.");
    expect(motivoSolaLettura(["Roster", "Personale"])).toContain("su «Roster» o «Personale»");
    expect(motivoSolaLettura([])).toBe("Sola lettura: per farlo serve la scrittura. Il ruolo lo assegna l'amministratore.");
  });

  it("il messaggio breve passa dall'avviso unico come quello dell'API", () => {
    const breve = mancaLaScrittura(["Roster"]);
    expect(breve).toBe("Sola lettura: per farlo serve la scrittura su «Roster»");
    expect(dettaglioSolaLettura(breve)).toBe("Per farlo serve la scrittura su «Roster»");
  });

  it("spento, senza azione, col motivo al posto del suggerimento, e le sue classi restano", () => {
    const p = propsDelComandoSpento("px-2 disabled:pointer-events-none", "perché");
    expect(p.disabled).toBe(true);
    expect(p["aria-disabled"]).toBe(true);
    expect(p.onClick).toBeUndefined();
    expect(p.title).toBe("perché");
    expect(p.className).toContain("px-2 disabled:pointer-events-none");
    // il puntatore resta, altrimenti il motivo non si legge
    expect(p.className).toContain("!pointer-events-auto");
    // e resta attenuato anche dove lo stile del pulsante lo schiarirebbe al passaggio
    expect(p.className).toContain("!opacity-50");
    expect(propsDelComandoSpento(undefined, "x").className).not.toMatch(/^ /);
  });
});
