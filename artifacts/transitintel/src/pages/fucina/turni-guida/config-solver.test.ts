import { describe, expect, it } from "vitest";
import type { OperatorConfig } from "@/hooks/use-crew-optimization";
import { bds5ToSolverConfig, EMPTY_BDS5, type Bds5Config } from "./bds5-config";
import {
  AMBITO_VUOTO, clusterDaMandare, conAutoAziendali, configPerIlSolver, scelteAttive, vincoloAttivo,
  type AmbitoDelCalcolo,
} from "./config-solver";
import type { VincoloGlobale } from "./types";

const BASE: OperatorConfig = {
  solverIntensity: 2,
  timeLimit: 240,
  weights: { minDrivers: 8 },
  bds: {
    serviceType: "urbano",
    cuts: { minCutGap: 5, collassaMinGap: 30 },
    optimizer: { maxCompanyCars: 4, minWorkPerDuty: 360 },
  },
};

const VINCOLO: VincoloGlobale = { tipo: "percentuale", tipologie: ["spezzato"], maxPct: 13 };

const COSTI: Bds5Config = {
  scalini: [{ attributo: "lavoro", testo: "391=0.10, 7:00=0.22" }],
  quadratici: [],
  sosteSpezzantiMin: 20,
  fasceSenzaCambi: "07:30-08:30",
};

function ambito(parte: Partial<AmbitoDelCalcolo>): AmbitoDelCalcolo {
  return { ...AMBITO_VUOTO, ...parte };
}

describe("configPerIlSolver", () => {
  it("senza scelte restituisce la configurazione di partenza, la stessa", () => {
    expect(configPerIlSolver(BASE, AMBITO_VUOTO)).toBe(BASE);
    expect(configPerIlSolver(BASE, ambito({ clusterScelti: [] }))).toBe(BASE);
    expect(configPerIlSolver(BASE, ambito({ bds5: { scalini: [], quadratici: [] } }))).toBe(BASE);
  });

  it("non cambia la configurazione di partenza", () => {
    const prima = JSON.stringify(BASE);
    configPerIlSolver(BASE, ambito({ clusterScelti: ["a"], vincoliGlobali: [VINCOLO], bds5: COSTI }));
    expect(JSON.stringify(BASE)).toBe(prima);
  });

  it("i cluster scelti vanno in selectedClusterIds, il resto resta com'è", () => {
    const c = configPerIlSolver(BASE, ambito({ clusterScelti: ["c2", "c1", "c2"] }));
    expect(c.selectedClusterIds).toEqual(["c2", "c1"]);
    expect(c.bds).toBe(BASE.bds);
    expect(c.weights).toBe(BASE.weights);
  });

  it("i vincoli globali vanno in bds.vincoliGlobali, dove li legge il solver", () => {
    const c = configPerIlSolver(BASE, ambito({ vincoliGlobali: [VINCOLO] }));
    expect(c.bds?.vincoliGlobali).toEqual([VINCOLO]);
    expect(c.bds?.optimizer).toEqual(BASE.bds?.optimizer);
    expect(c.bds?.cuts).toEqual(BASE.bds?.cuts);
    expect(c.selectedClusterIds).toBeUndefined();
    expect((c as Record<string, unknown>).vincoliGlobali).toBeUndefined();
  });

  it("i costi avanzati vanno in bds.costiAvanzati e i loro tagli si aggiungono a quelli delle regole", () => {
    const c = configPerIlSolver(BASE, ambito({ bds5: COSTI }));
    expect(c.bds?.costiAvanzati).toEqual({
      scalini: [{ attributo: "lavoro", scalini: [{ da: 391, costo: 0.1 }, { da: 420, costo: 0.22 }] }],
    });
    expect(c.bds?.cuts).toEqual({
      minCutGap: 5, collassaMinGap: 30,
      sosteSpezzantiMin: 20,
      fasceSenzaCambi: [{ startMin: 450, endMin: 510 }],
    });
  });

  it("funziona anche su una configurazione senza bds", () => {
    const c = configPerIlSolver({ solverIntensity: 1 }, ambito({ vincoliGlobali: [VINCOLO] }));
    expect(c).toEqual({ solverIntensity: 1, bds: { vincoliGlobali: [VINCOLO] } });
  });

  /* La pagina vecchia componeva la configurazione a mano dentro il componente:
   * a parità di scelte, quella nuova deve mandare al solver le stesse cose. */
  it("manda le stesse impostazioni che mandava la pagina vecchia", () => {
    const scelte = ambito({ clusterScelti: ["c1", "c3"], vincoliGlobali: [VINCOLO], bds5: COSTI });
    const b5 = bds5ToSolverConfig(COSTI)!;
    const dellaPaginaVecchia = {
      ...BASE,
      selectedClusterIds: ["c1", "c3"],
      bds: {
        ...BASE.bds,
        vincoliGlobali: [VINCOLO],
        costiAvanzati: b5.costiAvanzati,
        cuts: { ...BASE.bds!.cuts, ...b5.cuts },
      },
    };
    expect(configPerIlSolver(BASE, scelte)).toEqual(dellaPaginaVecchia);
  });
});

describe("clusterDaMandare", () => {
  it("nessuna scelta o elenco vuoto: niente da mandare (per l'API vale «tutti»)", () => {
    expect(clusterDaMandare(null)).toBeNull();
    expect(clusterDaMandare([])).toBeNull();
    expect(clusterDaMandare([""])).toBeNull();
  });
  it("toglie i doppioni e tiene l'ordine", () => {
    expect(clusterDaMandare(["b", "a", "b"])).toEqual(["b", "a"]);
  });
});

describe("vincoloAttivo", () => {
  it("vuole almeno una tipologia e almeno un limite, come il solver", () => {
    expect(vincoloAttivo(VINCOLO)).toBe(true);
    expect(vincoloAttivo({ tipo: "percentuale", tipologie: [], maxPct: 13 })).toBe(false);
    expect(vincoloAttivo({ tipo: "percentuale", tipologie: ["spezzato"] })).toBe(false);
    expect(vincoloAttivo({ tipo: "numerico", tipologie: ["intero"], min: 0 })).toBe(true);
    expect(vincoloAttivo({ tipo: "numerico", tipologie: ["intero"], min: null, max: null })).toBe(false);
    expect(vincoloAttivo({ tipo: "media", tipologie: ["intero"], maxMin: 400 })).toBe(false);
    expect(vincoloAttivo({ tipo: "media", tipologie: ["intero"], misura: "lavoro", maxMin: 400 })).toBe(true);
  });
});

describe("scelteAttive", () => {
  it("conta le scelte che cambiano il calcolo", () => {
    expect(scelteAttive(AMBITO_VUOTO)).toBe(0);
    expect(scelteAttive(ambito({ clusterScelti: [] }))).toBe(0);
    expect(scelteAttive(ambito({ vincoliGlobali: [{ tipo: "numerico", tipologie: [] }] }))).toBe(0);
    expect(scelteAttive(ambito({ bds5: EMPTY_BDS5 }))).toBe(0);
    expect(scelteAttive(ambito({ clusterScelti: ["a"], vincoliGlobali: [VINCOLO], bds5: COSTI }))).toBe(3);
  });
});

describe("conAutoAziendali", () => {
  it("mette il parametro dell'azienda al posto del numero di partenza", () => {
    const c = conAutoAziendali(BASE, 8);
    expect(c.bds?.optimizer).toEqual({ maxCompanyCars: 8, minWorkPerDuty: 360 });
    expect(c.bds?.cuts).toBe(BASE.bds?.cuts);
    expect(BASE.bds?.optimizer?.maxCompanyCars).toBe(4);
  });
  it("se il profilo di regole dice il suo numero, vale quello", () => {
    expect(conAutoAziendali(BASE, 8, 4)).toBe(BASE);
    expect(conAutoAziendali(BASE, 8, 0)).toBe(BASE);
  });
  it("un parametro che non è un numero fra 0 e 50 non cambia niente", () => {
    for (const no of [null, undefined, "8", 7.5, -1, 51, NaN]) expect(conAutoAziendali(BASE, no)).toBe(BASE);
    expect(conAutoAziendali(BASE, 0).bds?.optimizer?.maxCompanyCars).toBe(0);
  });
  it("funziona anche senza bds", () => {
    expect(conAutoAziendali({ solverIntensity: 1 }, 3)).toEqual({ solverIntensity: 1, bds: { optimizer: { maxCompanyCars: 3 } } });
  });
});
