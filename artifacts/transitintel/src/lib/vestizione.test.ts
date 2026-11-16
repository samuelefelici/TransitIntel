import { describe, it, expect } from "vitest";
import { ordineDiServizio, vestizione, type TabelloneVestizione } from "./vestizione";

const G = "2026-11-17";
const b: TabelloneVestizione = {
  drivers: [
    { id: "bianchi", name: "x", cognome: "Bianchi", nome: "Anna", depositoCodice: "JESI" },
    { id: "verdi", name: "x", cognome: "Verdi", nome: "Luca", depositoCodice: "JESI" },
    { id: "neri", name: "x", cognome: "Neri", nome: "Paolo", depositoCodice: "JESI" },
    { id: "gialli", name: "x", cognome: "Gialli", nome: "Sara", depositoCodice: "JESI" },
    { id: "blu", name: "x", cognome: "Blu", nome: "Ugo", depositoCodice: "JESI" },
    { id: "rosa", name: "x", cognome: "Rosa", nome: "Ada", depositoCodice: "JESI" },
    { id: "finto", name: "Finto", isFictitious: true, depositoCodice: "JESI" },
    { id: "ancona", name: "x", cognome: "Porto", nome: "Ivo", depositoCodice: "ANCONA" },
  ],
  assignments: [
    { id: "1", driverId: "bianchi", day: G, dutyCode: "J1", dssId: "d" },
    { id: "2", driverId: "gialli", day: G, dutyCode: "J2", dssId: "d" },
    { id: "3", driverId: "verdi", day: G, dutyCode: "J4", dssId: "d", titolareId: "rosa" },
    { id: "4", driverId: "ancona", day: G, dutyCode: "A1", dssId: "d" },
  ],
  occupatiDaAltri: [{ day: G, dutyCode: "J5", dssId: "d" }],
  entries: [
    { driverId: "bianchi", day: G, category: "assenza", code: "MA" },
    { driverId: "neri", day: G, category: "presenza", code: "D1" },
    { driverId: "blu", day: G, category: "assenza", code: "R" },
    { driverId: "rosa", day: G, category: "assenza", code: "ASS" },
  ],
  pubblicati: { [G]: [{ dssId: "d", udpNome: "Feriale" }] },
  dutiesByDss: { d: [
    { code: "J1", type: "intero", start: "05:10", end: "12:00", depositoCodice: "JESI" },
    { code: "J2", type: "intero", start: "06:00", end: "13:00", depositoCodice: "JESI" },
    { code: "J3", type: "spezzato", start: "07:00", end: "19:00", depositoCodice: "JESI" },
    { code: "J4", type: "intero", start: "04:30", end: "11:00", depositoCodice: "JESI" },
    { code: "J5", type: "intero", start: "08:00", end: "14:00", depositoCodice: "JESI" },
    { code: "A1", type: "intero", start: "05:00", end: "12:00", depositoCodice: "ANCONA" },
  ] },
};

describe("vestizione per deposito", () => {
  it("i turni del deposito: da coprire in cima (scoperti e liberati), poi in ordine di uscita", () => {
    const v = vestizione(b, G, "JESI");
    expect(v.turni.map((t) => [t.codice, t.stato])).toEqual([
      ["J1", "liberato"], ["J3", "scoperto"], ["J4", "coperto"], ["J2", "coperto"], ["J5", "altro_deposito"],
    ]);
    expect(v.turni[0]!.titolare?.nome).toBe("Bianchi Anna");
    // il sostituto e chi sostituisce
    expect(v.turni[2]).toMatchObject({ conducente: { nome: "Verdi Luca" }, titolare: { nome: "Rosa Ada" } });
  });
  it("i conducenti del deposito in gruppi; i fittizi e gli altri depositi no", () => {
    const v = vestizione(b, G, "JESI");
    const nomi = (g: keyof typeof v.conducenti) => v.conducenti[g].map((c) => c.nome);
    expect(nomi("in_servizio")).toEqual(["Gialli Sara", "Verdi Luca"]);
    expect(nomi("disposizione")).toEqual(["Neri Paolo"]);
    expect(nomi("riposo")).toEqual(["Blu Ugo"]);
    expect(nomi("assenti")).toEqual(["Bianchi Anna", "Rosa Ada"]);
    expect(nomi("liberi")).toEqual([]);
    expect(v.conducenti.assenti[0]).toMatchObject({ voce: "MA", turni: ["J1"] });
  });
  it("senza deposito: tutti", () => {
    expect(vestizione(b, G, null).turni).toHaveLength(6);
  });
  it("l'ordine di servizio: i turni con chi li fa, «da coprire» senza dire chi è assente, testo protetto", () => {
    const v = vestizione({
      ...b, drivers: [...b.drivers, { id: "x", name: "<b>Ma</b>", depositoCodice: "JESI" }],
      entries: [...b.entries!, { driverId: "x", day: G, category: "presenza", code: "D2" }],
    }, G, "JESI");
    const html = ordineDiServizio(v, { giorno: G, deposito: "Jesi & dintorni", azienda: "Azienda", stampatoIl: "17/11/2026 06:00" });
    expect(html).toContain("Ordine di servizio · Jesi &amp; dintorni");
    expect(html).toMatch(/J1<\/td>.*DA COPRIRE/s);
    expect(html).not.toContain("Bianchi");
    expect(html).not.toContain("MA");
    expect(html).toContain("Verdi Luca");
    expect(html).toContain("<strong>A disposizione:</strong> &lt;b&gt;Ma&lt;/b&gt;, Neri Paolo");
    expect(html).not.toContain("J5");
    expect(html).not.toContain("<b>Ma</b>");
  });
});
