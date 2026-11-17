/**
 * Le reti delle linee (tappe 6.6 e 6.7): l'elenco delle reti e le regole che
 * dal nome breve di una linea ricavano la rete stanno in un posto solo, e
 * sono dati dell'azienda.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyRoute, CODICE_URBANO_MAX, CODICE_URBANO_MIN, corrisponde, eReteUrbana, idRetiUrbane, impostaReti, nomeZonaUrbana,
  RETE_EXTRAURBANA, reteDalleRegole, reteUrbana, RETI_NEUTRE, retiInVigore, retiUrbane, SCARTO_CODICE_MISTO, servizioDellaLinea,
  TIPI_REGOLA, zonaDellaRete, type RegolaLinea,
} from "../lib/reti-linee";
import { conLeRetiDiProva, RETI_DI_PROVA, senzaReti } from "./helpers/reti-di-prova";

beforeEach(conLeRetiDiProva);
afterAll(senzaReti);

describe("l'elenco delle reti in vigore", () => {
  it("ogni rete urbana ha un identificativo, una sigla, una zona e due codici tutti suoi", () => {
    const unici = (valori: (string | number)[]) => new Set(valori).size === valori.length;
    const urbane = retiUrbane();
    expect(urbane.length).toBe(6);
    expect(unici(urbane.map((r) => r.rete))).toBe(true);
    expect(unici(urbane.map((r) => r.sigla))).toBe(true);
    expect(unici(urbane.map((r) => r.zona))).toBe(true);
    expect(unici(urbane.flatMap((r) => [r.codice, r.codiceMisto]))).toBe(true);
    for (const r of urbane) {
      expect(r.rete, r.rete).toMatch(/^urbano_[a-z]+$/);
      expect(r.zona, r.rete).toMatch(/^[a-z]+_urban$/);
      /* 0 è «non servita», 1 «extraurbano», 99 «multi-rete»: i codici delle reti stanno in mezzo */
      expect(r.codice >= CODICE_URBANO_MIN && r.codice <= CODICE_URBANO_MAX, r.rete).toBe(true);
      expect(r.codiceMisto, r.rete).toBe(r.codice + SCARTO_CODICE_MISTO);
    }
    expect(idRetiUrbane()).toEqual(urbane.map((r) => r.rete));
    expect(idRetiUrbane()).not.toContain(RETE_EXTRAURBANA);
    expect(retiInVigore().reti.map((r) => r.rete).at(-1)).toBe(RETE_EXTRAURBANA);
  });

  it("ogni rete ha la sua zona: Senigallia, Castelfidardo e Sassoferrato non finiscono in quella di Falconara", () => {
    expect(Object.fromEntries(idRetiUrbane().map((rete) => [rete, zonaDellaRete(rete)]))).toEqual({
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

  it("il nome della zona si ricava dal luogo, quello della rete sta nell'elenco", () => {
    const jesi = reteUrbana("urbano_jesi")!;
    expect(jesi.nome).toBe("Urbano di Jesi");
    expect(nomeZonaUrbana(jesi)).toBe("Zona Urbana Jesi");
    expect([jesi.sigla, jesi.codice, jesi.codiceMisto]).toEqual(["JE", 3, 13]);
  });

  it("quello che è in vigore non si cambia da fuori", () => {
    expect(() => { (retiInVigore().reti as any).push({}); }).toThrow();
    expect(() => { (retiUrbane()[0] as any).zona = "altra"; }).toThrow();
    expect(() => { (retiInVigore().regole[0] as any).rete = "altra"; }).toThrow();
  });
});

describe("un'azienda che non ha ancora detto niente", () => {
  it("ha il solo extraurbano e nessuna regola: ogni linea è extraurbana", () => {
    senzaReti();
    expect(retiInVigore()).toEqual(RETI_NEUTRE);
    expect(retiUrbane()).toEqual([]);
    for (const nome of ["1", "JE1", "Y", "BUS5", "CIRCA", "C.D.", "A", "", null]) {
      expect(classifyRoute(nome), String(nome)).toBe(RETE_EXTRAURBANA);
      expect(servizioDellaLinea(nome), String(nome)).toBe("extraurbano");
    }
  });

  it("l'extraurbano c'è sempre, anche se chi imposta le reti lo dimentica", () => {
    impostaReti({ reti: RETI_DI_PROVA.reti.filter((r) => r.tipo === "urbano"), regole: RETI_DI_PROVA.regole });
    expect(retiInVigore().reti.some((r) => r.rete === RETE_EXTRAURBANA)).toBe(true);
    expect(classifyRoute("JE1")).toBe("urbano_jesi");
  });

  it("una regola verso una rete che non c'è non vale", () => {
    impostaReti({ reti: RETI_NEUTRE.reti, regole: [{ tipo: "inizia_con_cifra", valore: null, rete: "urbano_ancona" }] });
    expect(retiInVigore().regole).toEqual([]);
    expect(classifyRoute("41")).toBe(RETE_EXTRAURBANA);
  });
});

describe("la rete di una linea dal suo nome breve", () => {
  /* Il comportamento della regola scritta nel codice fino alla 6.6, fissato caso
     per caso: le regole di Conerobus in tabella danno gli stessi risultati. */
  const CASI: [string | null | undefined, string][] = [
    ["JE1", "urbano_jesi"], ["je12", "urbano_jesi"], [" JE3 ", "urbano_jesi"], ["JESI", "urbano_jesi"],
    ["Y", "urbano_falconara"], ["Y1", "urbano_falconara"], ["y", "urbano_falconara"],
    ["BUS5", "urbano_senigallia"], ["BUS10", "urbano_senigallia"], ["BUSS2", "urbano_senigallia"], ["bus87", "urbano_senigallia"],
    ["CIRCA", "urbano_castelfidardo"], ["CIRCB", "urbano_castelfidardo"], ["circa", "urbano_castelfidardo"],
    ["1", "urbano_ancona"], ["41", "urbano_ancona"], ["1/4", "urbano_ancona"], ["2B", "urbano_ancona"],
    ["C.D.", "urbano_ancona"], ["C.S.", "urbano_ancona"], ["c.d", "urbano_ancona"],
    ["A", RETE_EXTRAURBANA], ["B12", RETE_EXTRAURBANA], ["CIRCX", RETE_EXTRAURBANA], ["CIRC", RETE_EXTRAURBANA],
    ["BUS", RETE_EXTRAURBANA], ["BUSSOLA", RETE_EXTRAURBANA], ["BUSSS1", RETE_EXTRAURBANA], ["R", RETE_EXTRAURBANA],
    ["C.D.E.", RETE_EXTRAURBANA], ["   ", RETE_EXTRAURBANA], ["", RETE_EXTRAURBANA], [null, RETE_EXTRAURBANA], [undefined, RETE_EXTRAURBANA],
  ];

  /** La regola com'era scritta nel codice fino alla tappa 6.6. */
  function comePrima(shortName: string | null | undefined): string {
    if (!shortName) return "extraurbano";
    const s = shortName.trim().toUpperCase();
    if (s.startsWith("JE")) return "urbano_jesi";
    if (s.startsWith("Y")) return "urbano_falconara";
    if (/^BUSS?\d/.test(s)) return "urbano_senigallia";
    if (s === "CIRCA" || s === "CIRCB") return "urbano_castelfidardo";
    if (/^\d/.test(s)) return "urbano_ancona";
    if (/^[A-Z]\.[A-Z]\.?$/.test(s)) return "urbano_ancona";
    return "extraurbano";
  }

  it.each(CASI)("%j → %s", (nome, rete) => {
    expect(classifyRoute(nome)).toBe(rete);
    expect(comePrima(nome)).toBe(rete);
  });

  it("su migliaia di nomi fatti a caso le regole in tabella danno la rete di prima", () => {
    const pezzi = ["JE", "Y", "BUS", "BUSS", "CIRC", "CIRCA", "CIRCB", "C.", "D.", "A", "B", "S", "X", "0", "1", "7", "9", ".", "/", " ", "je", "bus"];
    let seme = 20261117;
    const caso = (n: number) => { seme = (seme * 1103515245 + 12345) % 2147483648; return seme % n; };
    for (let i = 0; i < 5000; i++) {
      const nome = Array.from({ length: 1 + caso(4) }, () => pezzi[caso(pezzi.length)]).join("");
      expect(classifyRoute(nome), JSON.stringify(nome)).toBe(comePrima(nome));
    }
  });

  it("rende sempre una rete dell'elenco", () => {
    const ammesse = new Set(retiInVigore().reti.map((r) => r.rete));
    for (const [nome] of CASI) expect(ammesse.has(classifyRoute(nome)), String(nome)).toBe(true);
  });

  it("urbano o extraurbano segue l'elenco delle reti", () => {
    for (const [nome, rete] of CASI) {
      expect(servizioDellaLinea(nome), String(nome)).toBe(rete === RETE_EXTRAURBANA ? "extraurbano" : "urbano");
    }
  });
});

describe("i tipi di regola", () => {
  const r = (tipo: RegolaLinea["tipo"], valore: string | null = null) => ({ tipo, valore });

  it("sono un elenco chiuso di cinque", () => {
    expect([...TIPI_REGOLA]).toEqual(["inizia", "uguale", "inizia_poi_cifra", "inizia_con_cifra", "lettere_puntate"]);
  });

  it("ognuno corrisponde a quello che dice il suo nome", () => {
    expect([corrisponde("JE1", r("inizia", "JE")), corrisponde("AJE", r("inizia", "JE"))]).toEqual([true, false]);
    expect([corrisponde("CIRCA", r("uguale", "CIRCA")), corrisponde("CIRCAB", r("uguale", "CIRCA"))]).toEqual([true, false]);
    expect([corrisponde("BUS5", r("inizia_poi_cifra", "BUS")), corrisponde("BUSA", r("inizia_poi_cifra", "BUS")), corrisponde("BUS", r("inizia_poi_cifra", "BUS"))])
      .toEqual([true, false, false]);
    expect([corrisponde("41", r("inizia_con_cifra")), corrisponde("A41", r("inizia_con_cifra"))]).toEqual([true, false]);
    expect([corrisponde("C.D.", r("lettere_puntate")), corrisponde("C.D", r("lettere_puntate")), corrisponde("CD", r("lettere_puntate"))]).toEqual([true, true, false]);
  });

  it("una regola con valore ma senza valore non corrisponde a niente", () => {
    for (const tipo of ["inizia", "uguale", "inizia_poi_cifra"] as const) {
      expect(corrisponde("", r(tipo, "")), tipo).toBe(false);
      expect(corrisponde("JE1", r(tipo, null)), tipo).toBe(false);
    }
  });

  it("vale la prima regola che corrisponde: l'ordine conta", () => {
    const regole = [
      { tipo: "uguale", valore: "9X", rete: RETE_EXTRAURBANA },
      { tipo: "inizia_con_cifra", valore: null, rete: "urbano_ancona" },
    ] satisfies RegolaLinea[];
    expect(reteDalleRegole("9X", regole)).toBe(RETE_EXTRAURBANA);
    expect(reteDalleRegole("9", regole)).toBe("urbano_ancona");
    expect(reteDalleRegole("9X", [...regole].reverse())).toBe("urbano_ancona");
  });
});

describe("la migrazione 0040 carica nell'installazione di Conerobus le reti e le regole di prima", () => {
  const sqlMigrazione = readFileSync(join(__dirname, "../../../../lib/db/migrations/0040_le_reti_dell_azienda.sql"), "utf8");
  /** I valori di una riga di VALUES: stringhe fra apici, numeri e NULL. */
  const valori = (riga: string): (string | number | null)[] =>
    [...riga.matchAll(/'((?:[^']|'')*)'|\b(NULL)\b|(-?\d+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] ? null : Number(m[3])));
  const blocco = (dopo: string): (string | number | null)[][] => {
    const da = sqlMigrazione.indexOf(dopo);
    const testo = sqlMigrazione.slice(sqlMigrazione.indexOf("(VALUES", da) + 7, sqlMigrazione.indexOf(") AS ", da));
    return testo.split("\n").map((r) => r.trim()).filter((r) => r.startsWith("(")).map(valori);
  };

  it("le reti, una per una", () => {
    const reti = blocco("INSERT INTO public.reti (rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine)\nSELECT");
    expect(reti).toEqual(RETI_DI_PROVA.reti.map((r) => [r.rete, r.tipo, r.nome, r.luogo, r.sigla, r.zona, r.codice, r.colore, r.ordine]));
  });

  it("le regole, nello stesso ordine", () => {
    const regole = blocco("INSERT INTO public.reti_regole (ordine, tipo, valore, rete)");
    expect(regole).toEqual(RETI_DI_PROVA.regole.map((g, i) => [i + 1, g.tipo, g.valore, g.rete]));
  });

  it("solo dove l'azienda è Conerobus; l'extraurbano ovunque", () => {
    expect(sqlMigrazione.match(/WHERE EXISTS \(SELECT 1 FROM public\.azienda a WHERE a\.gtfs_agency_id = 'conerobus'\)/g)?.length).toBe(2);
    expect(sqlMigrazione).toContain("VALUES ('extraurbano', 'extraurbano', 'Extraurbano', '#f59e0b', 1)\nON CONFLICT (rete) DO NOTHING;");
  });
});

describe("una regola sola nel codice", () => {
  const SRC = join(__dirname, "..");
  const sorgenti = (cartella: string): string[] => readdirSync(join(SRC, cartella), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sorgenti(join(cartella, e.name)) : e.name.endsWith(".ts") ? [join(cartella, e.name)] : []);
  const file = [...sorgenti("lib"), ...sorgenti("routes")];

  it("nessuna regola sul nome delle linee scritta nel codice", () => {
    /* i due segni della regola di prima: le linee di Senigallia e quelle di Castelfidardo */
    const copie = file.filter((f) => /BUSS\?\\d|"CIRCA"/.test(readFileSync(join(SRC, f), "utf8")));
    expect(copie).toEqual([]);
  });

  it("le zone urbane non si nominano nel codice", () => {
    const zone = new RegExp(`["'\`](${RETI_DI_PROVA.reti.filter((x) => x.zona).map((x) => x.zona).join("|")})["'\`]`);
    expect(file.filter((f) => zone.test(readFileSync(join(SRC, f), "utf8")))).toEqual([]);
  });

  it("nessun elenco delle reti urbane scritto a mano: chi le vuole tutte le prende dall'elenco", () => {
    /* tre reti urbane minori nominate nella stessa riga sono un elenco ricopiato;
       i cataloghi dei titoli di viaggio le nominano una per riga e restano dove sono */
    const minori = ["urbano_senigallia", "urbano_castelfidardo", "urbano_sassoferrato"];
    const ricopiati = file.filter((f) => {
      const testo = readFileSync(join(SRC, f), "utf8");
      return testo.split("\n").some((riga) => minori.every((rete) => riga.includes(rete)));
    });
    expect(ricopiati).toEqual([]);
  });
});
