import { describe, expect, it } from "vitest";
import { limitiSuiDepositi } from "@workspace/permessi";
import {
  conInterruttore, conModifica, conScelta, depositiDellUtente, depositiInBreve, elenchiDaSalvare, erroreDepositi, sceltaSul,
  type DepositiScelti,
} from "./depositi-utente";

const CATALOGO = ["ancona", "jesi", "osimo"];
const nome = (c: string) => ({ ancona: "Ancona", jesi: "Jesi", osimo: "Osimo" } as Record<string, string>)[c] ?? c;
/** Quello che l'API farà valere per gli elenchi che il modulo manda. */
const effetto = (s: DepositiScelti) => limitiSuiDepositi({ admin: false, ...elenchiDaSalvare(s) });

describe("lo stato del modulo da quello che ha l'utente", () => {
  it("senza elenchi: li vede tutti, nessun limite", () => {
    const s = depositiDellUtente({});
    expect(s).toEqual({ vedeTutti: true, depositi: [], depositiVisibili: [] });
    expect(effetto(s)).toEqual({ vede: null, scrive: null });
  });

  it("solo quelli che modifica (com'era con la 2.14c): interruttore acceso", () => {
    const s = depositiDellUtente({ depositi: ["jesi"] });
    expect(s).toEqual({ vedeTutti: true, depositi: ["jesi"], depositiVisibili: [] });
    expect(effetto(s)).toEqual({ vede: null, scrive: ["jesi"] });
  });

  it("con dei visibili: interruttore spento, e le tre scelte per deposito", () => {
    const s = depositiDellUtente({ depositi: ["jesi"], depositiVisibili: ["jesi", "ancona"] });
    expect(s.vedeTutti).toBe(false);
    expect(CATALOGO.map(c => sceltaSul(s, c))).toEqual(["vede", "modifica", "niente"]);
    // un deposito da modificare che manca fra i visibili si mostra comunque fra i visibili
    expect(depositiDellUtente({ depositi: ["jesi"], depositiVisibili: ["ancona"] }).depositiVisibili).toEqual(["ancona", "jesi"]);
  });
});

describe("le scelte", () => {
  const base: DepositiScelti = { vedeTutti: false, depositi: ["jesi"], depositiVisibili: ["jesi", "ancona"] };

  it("modifica, vede, niente: i due elenchi restano coerenti", () => {
    const a = conScelta(base, "osimo", "modifica");
    expect(CATALOGO.map(c => sceltaSul(a, c))).toEqual(["vede", "modifica", "modifica"]);
    const b = conScelta(a, "jesi", "vede");
    expect(CATALOGO.map(c => sceltaSul(b, c))).toEqual(["vede", "vede", "modifica"]);
    const c = conScelta(b, "ancona", "niente");
    expect(CATALOGO.map(x => sceltaSul(c, x))).toEqual(["niente", "vede", "modifica"]);
    expect([...(effetto(c).vede ?? [])].sort()).toEqual(["jesi", "osimo"]);
    expect(effetto(c).scrive).toEqual(["osimo"]);
    // scegliere due volte la stessa cosa non raddoppia i codici
    expect(elenchiDaSalvare(conScelta(conScelta(base, "jesi", "modifica"), "jesi", "modifica"))).toEqual({ depositi: ["jesi"], depositiVisibili: ["ancona", "jesi"] });
  });

  it("solo «vede» su tutto: vede e non modifica niente (l'API non lo legge come «tutti»)", () => {
    const s = conScelta(conScelta({ vedeTutti: false, depositi: [], depositiVisibili: [] }, "jesi", "vede"), "ancona", "vede");
    expect(effetto(s)).toEqual({ vede: ["jesi", "ancona"], scrive: [] });
  });

  it("nessun deposito visibile non si salva: nel database vorrebbe dire «li vede tutti»", () => {
    const s = conScelta(conScelta(base, "jesi", "niente"), "ancona", "niente");
    expect(erroreDepositi(s)).toMatch(/almeno un deposito/);
    expect(erroreDepositi(base)).toBeNull();
    expect(erroreDepositi({ vedeTutti: true, depositi: [], depositiVisibili: [] })).toBeNull();
  });

  it("con l'interruttore acceso si sceglie solo che cosa modifica, come prima", () => {
    const s = conModifica(conModifica({ vedeTutti: true, depositi: [], depositiVisibili: [] }, "jesi", true), "osimo", true);
    expect(elenchiDaSalvare(s)).toEqual({ depositi: ["jesi", "osimo"], depositiVisibili: [] });
    expect(elenchiDaSalvare(conModifica(s, "jesi", false))).toEqual({ depositi: ["osimo"], depositiVisibili: [] });
  });
});

describe("l'interruttore non cambia quello che la persona può fare in quel momento", () => {
  it("spegnerlo a chi non aveva limiti: tutti i depositi restano da modificare", () => {
    const prima = depositiDellUtente({});
    const dopo = conInterruttore(prima, false, CATALOGO, true);
    expect(CATALOGO.map(c => sceltaSul(dopo, c))).toEqual(["modifica", "modifica", "modifica"]);
    expect(effetto(dopo).scrive).toEqual(CATALOGO);
  });

  it("spegnerlo a chi modificava solo Jesi: Jesi da modificare, gli altri da vedere", () => {
    const dopo = conInterruttore(depositiDellUtente({ depositi: ["jesi"] }), false, CATALOGO, true);
    expect(CATALOGO.map(c => sceltaSul(dopo, c))).toEqual(["vede", "modifica", "vede"]);
    expect(effetto(dopo)).toEqual({ vede: CATALOGO, scrive: ["jesi"] });
  });

  it("spegnerlo a chi il roster lo legge soltanto: tutti da vedere, nessuno da modificare", () => {
    const dopo = conInterruttore(depositiDellUtente({}), false, CATALOGO, false);
    expect(CATALOGO.map(c => sceltaSul(dopo, c))).toEqual(["vede", "vede", "vede"]);
  });

  it("riaccenderlo: li vede di nuovo tutti; se li modificava tutti torna senza limiti", () => {
    const tutti = conInterruttore(depositiDellUtente({}), false, CATALOGO, true);
    expect(conInterruttore(tutti, true, CATALOGO, true)).toEqual({ vedeTutti: true, depositi: [], depositiVisibili: [] });
    const soloJesi = conInterruttore({ vedeTutti: false, depositi: ["jesi"], depositiVisibili: ["jesi"] }, true, CATALOGO, true);
    expect(elenchiDaSalvare(soloJesi)).toEqual({ depositi: ["jesi"], depositiVisibili: [] });
  });
});

describe("la riga dell'utente", () => {
  it("dice che cosa modifica e che cosa vede soltanto, o niente se non ha limiti", () => {
    expect(depositiInBreve({}, nome)).toEqual([]);
    expect(depositiInBreve({ depositi: ["jesi"] }, nome)).toEqual(["modifica solo: Jesi"]);
    expect(depositiInBreve({ depositi: ["jesi"], depositiVisibili: ["jesi", "ancona"] }, nome)).toEqual(["modifica: Jesi", "vede soltanto: Ancona"]);
    expect(depositiInBreve({ depositi: ["jesi"], depositiVisibili: ["jesi"] }, nome)).toEqual(["modifica: Jesi"]);
    expect(depositiInBreve({ depositiVisibili: ["osimo", "x9"] }, nome)).toEqual(["non modifica nessun deposito", "vede soltanto: Osimo, x9"]);
  });
});
