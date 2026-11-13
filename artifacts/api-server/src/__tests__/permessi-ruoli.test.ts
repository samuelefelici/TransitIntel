import { describe, expect, it } from "vitest";
import {
  AREE, AREE_DELL_INTERRUTTORE, INTERRUTTORI, INTERRUTTORI_DI_PRIMA, MATRICE, NESSUN_DIRITTO, NOMI_AREE, NOMI_RUOLI, RUOLI,
  accessoDiPrimaPulito, accessoDiPrimaRidotto, dirittiDi, haAccessoDiPrima, interruttoriCompatibili,
  depositiPuliti, limiteDepositi, livelloDelMetodo, piuAlto, puo, puoSuUna, ruoliSconosciuti, ruoliValidi, scriveSulDeposito, vedeDatiSanitari,
  MAX_DEPOSITI_PER_UTENTE,
  matriceConModifiche, modificheDelRuolo, rigaChiesta, rigaDelRuolo,
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

describe("i depositi di una persona", () => {
  it("nessun deposito scelto vuol dire nessun limite, come prima", () => {
    expect(limiteDepositi({ admin: false })).toBeNull();
    expect(limiteDepositi({ admin: false, depositi: [] })).toBeNull();
    expect(limiteDepositi({ admin: false, depositi: null })).toBeNull();
    expect(scriveSulDeposito(null, "jesi")).toBe(true);
    expect(scriveSulDeposito(null, null)).toBe(true);
  });

  it("l'amministratore non ha limiti, anche se gli si scrivono dei depositi", () => {
    expect(limiteDepositi({ admin: true, depositi: ["jesi"] })).toBeNull();
  });

  it("con dei depositi si scrive solo su quelli", () => {
    const limite = limiteDepositi({ admin: false, depositi: ["jesi", "jesi-urbano"] });
    expect(limite).toEqual(["jesi", "jesi-urbano"]);
    expect(scriveSulDeposito(limite, "jesi")).toBe(true);
    expect(scriveSulDeposito(limite, "jesi-urbano")).toBe(true);
    expect(scriveSulDeposito(limite, "ancona")).toBe(false);
    // il codice è esatto: non un prefisso, non un'altra scrittura
    expect(scriveSulDeposito(limite, "jes")).toBe(false);
    expect(scriveSulDeposito(limite, "Jesi")).toBe(false);
  });

  it("un conducente senza deposito lo scrive solo chi non ha limiti", () => {
    const limite = limiteDepositi({ admin: false, depositi: ["jesi"] });
    expect(scriveSulDeposito(limite, null)).toBe(false);
    expect(scriveSulDeposito(limite, undefined)).toBe(false);
    expect(scriveSulDeposito(limite, "")).toBe(false);
  });

  it("i codici scritti male non contano, e non diventano «nessun limite» per sbaglio", () => {
    expect(depositiPuliti(["jesi", " jesi ", "", 7, null, "ancona", "jesi"])).toEqual(["jesi", "ancona"]);
    expect(depositiPuliti("jesi")).toEqual([]);
    expect(depositiPuliti(undefined)).toEqual([]);
    expect(depositiPuliti(["x".repeat(61)])).toEqual([]);
    expect(depositiPuliti(Array.from({ length: 80 }, (_, i) => `d${i}`))).toHaveLength(MAX_DEPOSITI_PER_UTENTE);
    // chi ha un deposito valido e uno scritto male resta limitato a quello valido
    expect(limiteDepositi({ admin: false, depositi: ["jesi", ""] })).toEqual(["jesi"]);
  });
});

/* PR 2.18: l'amministratore cambia la matrice cella per cella (Amministrazione › Ruoli). */
describe("la matrice in vigore: quella di partenza con le modifiche dell'amministratore", () => {
  const profilo = (ruoli: RuoloAziendale[], extra: Partial<ProfiloPermessi> = {}): ProfiloPermessi =>
    ({ admin: false, ruoli, accessoDiPrima: {}, analisi: false, datiSanitari: false, ...extra });

  it("una modifica toglie, abbassa o alza una cella; le altre restano quelle di partenza", () => {
    const m = matriceConModifiche(MATRICE, [
      { ruolo: "capo_deposito", area: "esercizio", livello: "N" },
      { ruolo: "capo_deposito", area: "roster", livello: "L" },
      { ruolo: "capo_deposito", area: "tariffe", livello: "S" },
    ]);
    expect(rigaDelRuolo(m, "capo_deposito")).toEqual({ ...rigaDelRuolo(MATRICE, "capo_deposito"), esercizio: null, roster: "L", tariffe: "S" });
    for (const r of RUOLI.filter(x => x !== "capo_deposito")) expect(rigaDelRuolo(m, r)).toEqual(rigaDelRuolo(MATRICE, r));
    // la matrice di partenza non si tocca
    expect(MATRICE.capo_deposito.esercizio).toBe("L");
    expect(MATRICE.capo_deposito.roster).toBe("S");
    expect(MATRICE.capo_deposito.tariffe).toBeUndefined();
  });

  it("senza modifiche è la matrice di partenza", () => {
    const m = matriceConModifiche(MATRICE, []);
    for (const r of RUOLI) expect(rigaDelRuolo(m, r)).toEqual(rigaDelRuolo(MATRICE, r));
  });

  it("una modifica scritta male non vale: resta la cella di partenza", () => {
    const m = matriceConModifiche(MATRICE, [
      null, "x", 3, {}, { ruolo: "direttore", area: "roster", livello: "S" }, { ruolo: "officina", area: "magazzino", livello: "S" },
      { ruolo: "officina", area: "personale", livello: "W" }, { ruolo: "officina", area: "personale", livello: null },
      { ruolo: "officina", area: "personale" }, { ruolo: "__proto__", area: "roster", livello: "S" },
    ]);
    for (const r of RUOLI) expect(rigaDelRuolo(m, r)).toEqual(rigaDelRuolo(MATRICE, r));
    expect(({} as any).roster).toBeUndefined();
  });

  it("i diritti si calcolano con la matrice che gli si dà", () => {
    const m = matriceConModifiche(MATRICE, [
      { ruolo: "capo_deposito", area: "flotta", livello: "N" },
      { ruolo: "capo_deposito", area: "personale", livello: "L" },
    ]);
    const capo = profilo(["capo_deposito"]);
    expect(dirittiDi(capo).flotta).toBe("L");
    expect(dirittiDi(capo, m).flotta).toBeNull();
    expect(dirittiDi(capo, m).personale).toBe("L");
    // con più ruoli vale ancora il più alto: l'officina ha la scrittura sulla flotta
    expect(dirittiDi(profilo(["capo_deposito", "officina"]), m).flotta).toBe("S");
    // l'amministratore di sistema e l'accesso di prima non dipendono dalla matrice
    const vuota = matriceConModifiche(MATRICE, RUOLI.flatMap(r => AREE.map(a => ({ ruolo: r, area: a, livello: "N" }))));
    expect(Object.values(dirittiDi(profilo(RUOLI.slice()), vuota)).every(v => v === null)).toBe(true);
    expect(Object.values(dirittiDi({ ...profilo(["officina"]), admin: true }, vuota)).every(v => v === "S")).toBe(true);
    expect(dirittiDi(profilo([], { accessoDiPrima: { roster: true } }), vuota).roster).toBe("S");
  });

  it("i dati sanitari seguono la matrice: senza il roster non si vedono", () => {
    const senzaRoster = matriceConModifiche(MATRICE, [{ ruolo: "capo_deposito", area: "roster", livello: "N" }]);
    const capo = profilo(["capo_deposito"], { datiSanitari: true });
    expect(vedeDatiSanitari(capo)).toBe(true);
    expect(vedeDatiSanitari(capo, senzaRoster)).toBe(false);
  });

  it("le modifiche di un ruolo sono solo le celle diverse da quelle di partenza", () => {
    const partenza = rigaDelRuolo(MATRICE, "capo_deposito");
    expect(modificheDelRuolo(MATRICE, "capo_deposito", partenza)).toEqual([]);
    expect(modificheDelRuolo(MATRICE, "capo_deposito", { ...partenza, esercizio: null, roster: "L", tariffe: "S" })).toEqual([
      { ruolo: "capo_deposito", area: "roster", livello: "L" },
      { ruolo: "capo_deposito", area: "esercizio", livello: "N" },
      { ruolo: "capo_deposito", area: "tariffe", livello: "S" },
    ]);
    // andata e ritorno: applicate alla matrice di partenza danno la riga voluta
    const voluta = { ...partenza, flotta: null, personale: "L" as const };
    expect(rigaDelRuolo(matriceConModifiche(MATRICE, modificheDelRuolo(MATRICE, "capo_deposito", voluta)), "capo_deposito")).toEqual(voluta);
  });

  it("quello che chiede l'amministratore: tutte le aree, ognuna lettura, scrittura o niente", () => {
    const buona = rigaDelRuolo(MATRICE, "pianificatore");
    expect(rigaChiesta(buona)).toEqual({ diritti: buona });
    expect(rigaChiesta(null)).toHaveProperty("errore");
    expect(rigaChiesta([buona])).toHaveProperty("errore");
    expect(rigaChiesta("S")).toHaveProperty("errore");
    const { roster: _tolta, ...senzaUnArea } = buona;
    expect(rigaChiesta(senzaUnArea)).toEqual({ errore: "Manca l'area «Roster»" });
    expect(rigaChiesta({ ...buona, magazzino: "S" })).toEqual({ errore: "Area sconosciuta: magazzino" });
    expect(rigaChiesta({ ...buona, roster: "W" })).toEqual({ errore: "«Roster»: il livello è lettura, scrittura o niente" });
    expect(rigaChiesta({ ...buona, roster: undefined })).toHaveProperty("errore");
    expect(rigaChiesta({ ...buona, roster: true })).toHaveProperty("errore");
    expect(rigaChiesta({ ...buona, roster: "N" })).toHaveProperty("errore");
  });
});
