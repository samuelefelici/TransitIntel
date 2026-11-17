/**
 * Le reti delle linee (tappa 6.6): l'elenco delle reti urbane e la regola che
 * dal nome breve di una linea ricava la rete stanno in un posto solo.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRoute, eReteUrbana, ID_RETI_URBANE, nomeReteUrbana, nomeZonaUrbana, RETE_EXTRAURBANA, RETI_URBANE,
  reteUrbana, servizioDellaLinea, zonaDellaRete,
} from "../lib/reti-linee";

describe("l'elenco delle reti urbane", () => {
  it("ogni rete ha un identificativo, una sigla, una zona e due codici tutti suoi", () => {
    const unici = (valori: (string | number)[]) => new Set(valori).size === valori.length;
    expect(RETI_URBANE.length).toBe(6);
    expect(unici(RETI_URBANE.map((r) => r.rete))).toBe(true);
    expect(unici(RETI_URBANE.map((r) => r.sigla))).toBe(true);
    expect(unici(RETI_URBANE.map((r) => r.zona))).toBe(true);
    expect(unici(RETI_URBANE.flatMap((r) => [r.codice, r.codiceMisto]))).toBe(true);
    for (const r of RETI_URBANE) {
      expect(r.rete, r.rete).toMatch(/^urbano_[a-z]+$/);
      expect(r.zona, r.rete).toMatch(/^[a-z]+_urban$/);
      /* 0 è «non servita», 1 «extraurbano», 99 «multi-rete»: i codici delle reti stanno in mezzo */
      expect(r.codice > 1 && r.codice < 99 && r.codiceMisto > 1 && r.codiceMisto < 99, r.rete).toBe(true);
    }
    expect(ID_RETI_URBANE).toEqual(RETI_URBANE.map((r) => r.rete));
    expect(ID_RETI_URBANE).not.toContain(RETE_EXTRAURBANA);
  });

  it("ogni rete ha la sua zona: Senigallia, Castelfidardo e Sassoferrato non finiscono in quella di Falconara", () => {
    expect(Object.fromEntries(ID_RETI_URBANE.map((rete) => [rete, zonaDellaRete(rete)]))).toEqual({
      urbano_ancona: "ancona_urban",
      urbano_jesi: "jesi_urban",
      urbano_falconara: "falconara_urban",
      urbano_senigallia: "senigallia_urban",
      urbano_castelfidardo: "castelfidardo_urban",
      urbano_sassoferrato: "sassoferrato_urban",
    });
    for (const rete of [RETE_EXTRAURBANA, "urbano_altrove", "", null, undefined]) {
      expect(zonaDellaRete(rete), String(rete)).toBeNull();
      expect(eReteUrbana(rete), String(rete)).toBe(false);
    }
  });

  it("i nomi di rete e di zona si ricavano dal luogo", () => {
    const jesi = reteUrbana("urbano_jesi")!;
    expect(nomeReteUrbana(jesi)).toBe("Urbano di Jesi");
    expect(nomeZonaUrbana(jesi)).toBe("Zona Urbana Jesi");
    expect([jesi.sigla, jesi.codice, jesi.codiceMisto]).toEqual(["JE", 3, 13]);
  });

  it("l'elenco non si cambia da fuori", () => {
    expect(() => { (RETI_URBANE as any).push({}); }).toThrow();
    expect(() => { (RETI_URBANE[0] as any).zona = "altra"; }).toThrow();
  });
});

describe("la rete di una linea dal suo nome breve", () => {
  /* Il comportamento delle tre copie di prima, fissato caso per caso. */
  const CASI: [string | null | undefined, string][] = [
    ["JE1", "urbano_jesi"], ["je12", "urbano_jesi"], [" JE3 ", "urbano_jesi"], ["JESI", "urbano_jesi"],
    ["Y", "urbano_falconara"], ["Y1", "urbano_falconara"], ["y", "urbano_falconara"],
    ["BUS5", "urbano_senigallia"], ["BUS10", "urbano_senigallia"], ["BUSS2", "urbano_senigallia"], ["bus87", "urbano_senigallia"],
    ["CIRCA", "urbano_castelfidardo"], ["CIRCB", "urbano_castelfidardo"], ["circa", "urbano_castelfidardo"],
    ["1", "urbano_ancona"], ["41", "urbano_ancona"], ["1/4", "urbano_ancona"], ["2B", "urbano_ancona"],
    ["C.D.", "urbano_ancona"], ["C.S.", "urbano_ancona"], ["c.d", "urbano_ancona"],
    ["A", RETE_EXTRAURBANA], ["B12", RETE_EXTRAURBANA], ["CIRCX", RETE_EXTRAURBANA], ["CIRC", RETE_EXTRAURBANA],
    ["BUS", RETE_EXTRAURBANA], ["BUSSOLA", RETE_EXTRAURBANA], ["R", RETE_EXTRAURBANA], ["C.D.E.", RETE_EXTRAURBANA],
    ["", RETE_EXTRAURBANA], [null, RETE_EXTRAURBANA], [undefined, RETE_EXTRAURBANA],
  ];

  it.each(CASI)("%j → %s", (nome, rete) => {
    expect(classifyRoute(nome)).toBe(rete);
  });

  it("rende sempre una rete dell'elenco oppure l'extraurbano", () => {
    const ammesse = new Set([...ID_RETI_URBANE, RETE_EXTRAURBANA]);
    for (const [nome] of CASI) expect(ammesse.has(classifyRoute(nome)), String(nome)).toBe(true);
  });

  it("urbano o extraurbano segue l'elenco delle reti", () => {
    for (const [nome, rete] of CASI) {
      expect(servizioDellaLinea(nome), String(nome)).toBe(rete === RETE_EXTRAURBANA ? "extraurbano" : "urbano");
    }
  });
});

describe("una regola sola nel codice", () => {
  const SRC = join(__dirname, "..");
  const sorgenti = (cartella: string): string[] => readdirSync(join(SRC, cartella), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sorgenti(join(cartella, e.name)) : e.name.endsWith(".ts") ? [join(cartella, e.name)] : []);
  const file = [...sorgenti("lib"), ...sorgenti("routes")].filter((f) => f !== join("lib", "reti-linee.ts"));

  it("la regola dal nome della linea sta solo in lib/reti-linee.ts", () => {
    /* i due segni della regola: le linee di Senigallia e quelle di Castelfidardo */
    const copie = file.filter((f) => /BUSS\?\\d|"CIRCA"/.test(readFileSync(join(SRC, f), "utf8")));
    expect(copie).toEqual([]);
  });

  it("le zone urbane non si nominano fuori dall'elenco", () => {
    const zone = new RegExp(`["'\`](${RETI_URBANE.map((r) => r.zona).join("|")})["'\`]`);
    expect(file.filter((f) => zone.test(readFileSync(join(SRC, f), "utf8")))).toEqual([]);
  });

  it("nessun elenco delle reti urbane scritto a mano: chi le vuole tutte le prende dall'elenco", () => {
    /* tre reti urbane minori nominate nello stesso file sono un elenco ricopiato;
       i cataloghi dei titoli di viaggio le nominano una per riga e restano dove sono */
    const minori = ["urbano_senigallia", "urbano_castelfidardo", "urbano_sassoferrato"];
    const ricopiati = file.filter((f) => {
      const testo = readFileSync(join(SRC, f), "utf8");
      return testo.split("\n").some((riga) => minori.every((rete) => riga.includes(rete)));
    });
    expect(ricopiati).toEqual([]);
  });
});
