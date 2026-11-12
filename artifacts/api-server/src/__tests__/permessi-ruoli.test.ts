import { describe, expect, it } from "vitest";
import {
  AREE, AREE_DELL_INTERRUTTORE, INTERRUTTORI, INTERRUTTORI_DI_PRIMA, MATRICE, NESSUN_DIRITTO, NOMI_AREE, NOMI_RUOLI, RUOLI,
  accessoDiPrimaPulito, accessoDiPrimaRidotto, dirittiDi, haAccessoDiPrima, interruttoriCompatibili,
  livelloDelMetodo, piuAlto, puo, puoSuUna, ruoliSconosciuti, ruoliValidi, vedeDatiSanitari,
  type Area, type Livello, type ProfiloPermessi, type RuoloAziendale,
} from "@workspace/permessi";

const nessuno: ProfiloPermessi = { admin: false, ruoli: [], accessoDiPrima: {}, analisi: false, datiSanitari: false };
const con = (p: Partial<ProfiloPermessi>): ProfiloPermessi => ({ ...nessuno, ...p });

/* La matrice dell'analisi (§ 3.5), riga per riga, scritta qui una seconda volta:
 * un cambio alla matrice deve passare anche da questo test. */
const ATTESA: Record<RuoloAziendale, Partial<Record<Area, Livello>>> = {
  pianificatore:      { rete: "S", turni: "L", pubblicazione_orari: "S", pubblicazione_turni: "L", esercizio: "L", consuntivo: "L", tariffe: "L" },
  ufficio_turni:      { rete: "L", turni: "S", pubblicazione_orari: "L", pubblicazione_turni: "S", roster: "L", esercizio: "L", consuntivo: "L" },
  capo_deposito:      { rete: "L", turni: "L", pubblicazione_orari: "L", pubblicazione_turni: "L", roster: "S", esercizio: "L", consuntivo: "L", flotta: "L" },
  centrale_operativa: { rete: "L", turni: "L", pubblicazione_orari: "L", pubblicazione_turni: "L", roster: "L", esercizio: "S", consuntivo: "S", flotta: "L" },
  officina:           { esercizio: "L", flotta: "S" },
  amministrazione:    { rete: "L", turni: "L", pubblicazione_orari: "L", pubblicazione_turni: "L", personale: "S", roster: "L", esercizio: "L", consuntivo: "S", flotta: "L", tariffe: "S" },
};

describe("la matrice dei ruoli", () => {
  it("è quella dell'analisi", () => {
    expect(MATRICE).toEqual(ATTESA);
    expect([...RUOLI].sort()).toEqual(Object.keys(ATTESA).sort());
  });

  it("ogni ruolo e ogni area hanno un nome", () => {
    for (const r of RUOLI) expect(NOMI_RUOLI[r]).toBeTruthy();
    for (const a of AREE) expect(NOMI_AREE[a]).toBeTruthy();
  });

  it("nessun ruolo dà i dati personali tranne l'Amministrazione, e nessuno dà l'Analisi", () => {
    for (const r of RUOLI) {
      expect(MATRICE[r].analisi).toBeUndefined();
      if (r !== "amministrazione") expect(MATRICE[r].personale).toBeUndefined();
    }
  });

  it("un solo ruolo scrive su ogni area di lavoro, tranne il consuntivo (esiti e chiusura)", () => {
    const scrivono = (a: Area) => RUOLI.filter(r => MATRICE[r][a] === "S");
    expect(scrivono("rete")).toEqual(["pianificatore"]);
    expect(scrivono("turni")).toEqual(["ufficio_turni"]);
    expect(scrivono("pubblicazione_orari")).toEqual(["pianificatore"]);
    expect(scrivono("pubblicazione_turni")).toEqual(["ufficio_turni"]);
    expect(scrivono("roster")).toEqual(["capo_deposito"]);
    expect(scrivono("personale")).toEqual(["amministrazione"]);
    expect(scrivono("esercizio")).toEqual(["centrale_operativa"]);
    expect(scrivono("tariffe")).toEqual(["amministrazione"]);
    expect(scrivono("flotta")).toEqual(["officina"]);
    expect(scrivono("consuntivo")).toEqual(["centrale_operativa", "amministrazione"]);
  });
});

describe("dirittiDi", () => {
  it("senza ruoli e senza accesso di prima non si ha niente", () => {
    expect(dirittiDi(nessuno)).toEqual(NESSUN_DIRITTO);
  });

  it("l'amministratore di sistema scrive ovunque", () => {
    const d = dirittiDi(con({ admin: true }));
    for (const a of AREE) expect(d[a]).toBe("S");
  });

  it("un ruolo dà la sua riga della matrice", () => {
    for (const r of RUOLI) {
      const d = dirittiDi(con({ ruoli: [r] }));
      for (const a of AREE) expect(d[a]).toBe(ATTESA[r][a] ?? null);
    }
  });

  it("con più ruoli vale il diritto più alto, area per area", () => {
    const d = dirittiDi(con({ ruoli: ["pianificatore", "ufficio_turni"] }));
    expect(d).toMatchObject({ rete: "S", turni: "S", pubblicazione_orari: "S", pubblicazione_turni: "S", roster: "L", tariffe: "L", personale: null, flotta: null });
    const tutti = dirittiDi(con({ ruoli: [...RUOLI] }));
    for (const a of AREE) expect(tutti[a]).toBe(a === "analisi" ? null : "S");
  });

  it("l'ordine dei ruoli non conta", () => {
    expect(dirittiDi(con({ ruoli: ["officina", "amministrazione"] }))).toEqual(dirittiDi(con({ ruoli: ["amministrazione", "officina"] })));
  });

  it("un interruttore di prima vale scrittura sulle sue aree", () => {
    expect(dirittiDi(con({ accessoDiPrima: { network: true } }))).toMatchObject({ rete: "S", pubblicazione_orari: "S", turni: null });
    expect(dirittiDi(con({ accessoDiPrima: { scheduling: true } }))).toMatchObject({ turni: "S", pubblicazione_turni: "S", rete: null });
    expect(dirittiDi(con({ accessoDiPrima: { roster: true, personale: true, centrale: true, fares: true, fleetcare: true } })))
      .toMatchObject({ roster: "S", personale: "S", esercizio: "S", tariffe: "S", flotta: "S", rete: null, analisi: null });
  });

  it("solo `true` accende un interruttore di prima", () => {
    const quasi = { network: "true", scheduling: 1, roster: null } as unknown as ProfiloPermessi["accessoDiPrima"];
    expect(dirittiDi(con({ accessoDiPrima: quasi }))).toEqual(NESSUN_DIRITTO);
  });

  it("l'accesso di prima si somma ai ruoli e non li abbassa", () => {
    const d = dirittiDi(con({ ruoli: ["pianificatore"], accessoDiPrima: { scheduling: true } }));
    expect(d).toMatchObject({ rete: "S", turni: "S", pubblicazione_turni: "S", tariffe: "L" });
  });

  it("l'Analisi viene solo dalla sua capacità", () => {
    expect(dirittiDi(con({ analisi: true })).analisi).toBe("S");
    expect(dirittiDi(con({ ruoli: [...RUOLI] })).analisi).toBeNull();
  });

  it("un ruolo che non esiste non dà niente e non rompe", () => {
    expect(dirittiDi(con({ ruoli: ["direttore" as RuoloAziendale] }))).toEqual(NESSUN_DIRITTO);
  });
});

describe("puo e puoSuUna", () => {
  const d = dirittiDi(con({ ruoli: ["ufficio_turni"] }));
  it("la scrittura comprende la lettura, la lettura non dà la scrittura", () => {
    expect(puo(d, "turni", "S")).toBe(true);
    expect(puo(d, "turni", "L")).toBe(true);
    expect(puo(d, "rete", "L")).toBe(true);
    expect(puo(d, "rete", "S")).toBe(false);
    expect(puo(d, "personale", "L")).toBe(false);
  });
  it("su più aree ne basta una", () => {
    expect(puoSuUna(d, ["rete", "turni"], "S")).toBe(true);
    expect(puoSuUna(d, ["rete", "roster"], "S")).toBe(false);
    expect(puoSuUna(d, [], "L")).toBe(false);
  });
  it("piuAlto", () => {
    expect(piuAlto("L", "S")).toBe("S");
    expect(piuAlto("S", null)).toBe("S");
    expect(piuAlto(null, undefined)).toBeNull();
    expect(piuAlto("L", "L")).toBe("L");
  });
});

describe("i dati sanitari", () => {
  it("servono la capacità e l'accesso al roster", () => {
    expect(vedeDatiSanitari(con({ datiSanitari: true }))).toBe(false);
    expect(vedeDatiSanitari(con({ ruoli: ["capo_deposito"] }))).toBe(false);
    expect(vedeDatiSanitari(con({ ruoli: ["capo_deposito"], datiSanitari: true }))).toBe(true);
    expect(vedeDatiSanitari(con({ ruoli: ["ufficio_turni"], datiSanitari: true }))).toBe(true);
    expect(vedeDatiSanitari(con({ accessoDiPrima: { roster: true }, datiSanitari: true }))).toBe(true);
    expect(vedeDatiSanitari(con({ ruoli: ["pianificatore"], datiSanitari: true }))).toBe(false);
  });
  it("l'amministratore di sistema li vede", () => {
    expect(vedeDatiSanitari(con({ admin: true }))).toBe(true);
  });
});

describe("interruttoriCompatibili (la colonna users.permissions letta da FleetCare)", () => {
  it("chi ha solo l'accesso di prima ritrova gli stessi interruttori", () => {
    for (const i of INTERRUTTORI_DI_PRIMA) {
      const comp = interruttoriCompatibili(dirittiDi(con({ accessoDiPrima: { [i]: true } })));
      for (const j of INTERRUTTORI) expect(comp[j], `${i} → ${j}`).toBe(i === j);
    }
    expect(interruttoriCompatibili(dirittiDi(con({ analisi: true }))).analytics).toBe(true);
  });
  it("un ruolo accende gli interruttori delle aree che può almeno leggere", () => {
    expect(interruttoriCompatibili(dirittiDi(con({ ruoli: ["officina"] }))))
      .toEqual({ analytics: false, fares: false, scheduling: false, network: false, fleetcare: true, centrale: true, personale: false, roster: false });
    expect(interruttoriCompatibili(dirittiDi(con({ ruoli: ["amministrazione"] }))))
      .toEqual({ analytics: false, fares: true, scheduling: true, network: true, fleetcare: true, centrale: true, personale: true, roster: true });
    expect(interruttoriCompatibili(dirittiDi(con({ ruoli: ["pianificatore"] }))))
      .toMatchObject({ network: true, scheduling: true, roster: false, personale: false, fleetcare: false });
  });
  it("ogni interruttore ha le sue aree e ogni area tranne il consuntivo ha un interruttore", () => {
    const coperte = new Set(INTERRUTTORI.flatMap(i => AREE_DELL_INTERRUTTORE[i]));
    expect(AREE.filter(a => !coperte.has(a))).toEqual(["consuntivo"]);
  });
});

describe("quello che arriva da fuori", () => {
  it("ruoliValidi tiene solo i ruoli veri, senza doppioni, nell'ordine di RUOLI", () => {
    expect(ruoliValidi(["officina", "pianificatore", "officina", "direttore", 3, null])).toEqual(["pianificatore", "officina"]);
    expect(ruoliValidi("pianificatore")).toEqual([]);
    expect(ruoliValidi(undefined)).toEqual([]);
  });
  it("ruoliSconosciuti dice quali nomi non sono ruoli", () => {
    expect(ruoliSconosciuti(["officina", "direttore", "direttore", 3])).toEqual(["direttore", "3"]);
    expect(ruoliSconosciuti(["officina"])).toEqual([]);
  });
  it("accessoDiPrimaPulito tiene solo gli interruttori accesi, e non l'Analisi", () => {
    expect(accessoDiPrimaPulito({ network: true, scheduling: false, analytics: true, admin: true, roster: "true" })).toEqual({ network: true });
    expect(accessoDiPrimaPulito(null)).toEqual({});
    expect(accessoDiPrimaPulito(["network"])).toEqual({});
  });
  it("l'accesso di prima si può solo togliere", () => {
    const attuale = { network: true, scheduling: true } as const;
    expect(accessoDiPrimaRidotto(attuale, { network: true })).toEqual({ network: true });
    expect(accessoDiPrimaRidotto(attuale, {})).toEqual({});
    expect(accessoDiPrimaRidotto(attuale, { network: true, scheduling: true, roster: true, personale: true })).toEqual({ network: true, scheduling: true });
    expect(accessoDiPrimaRidotto({}, { roster: true })).toEqual({});
  });
  it("haAccessoDiPrima", () => {
    expect(haAccessoDiPrima({})).toBe(false);
    expect(haAccessoDiPrima({ fares: false })).toBe(false);
    expect(haAccessoDiPrima({ fares: true })).toBe(true);
  });
});

describe("letture e scritture", () => {
  it("GET e HEAD leggono, il resto scrive", () => {
    for (const m of ["GET", "get", "HEAD", "OPTIONS"]) expect(livelloDelMetodo(m)).toBe("L");
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "delete", "QUALCOSA"]) expect(livelloDelMetodo(m)).toBe("S");
  });
});
