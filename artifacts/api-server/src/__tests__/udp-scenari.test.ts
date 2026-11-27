/**
 * Gli scenari di un'UDP: le regole dell'anteprima e dell'eliminazione in
 * blocco (senza database). Il caso vero: decine di giri dello scheduler su
 * corse che non ci sono più, uno scenario in esercizio, un turni guida nel
 * roster — quelli restano, il resto se ne va.
 */
import { describe, it, expect } from "vitest";
import {
  anteprima, blocchiDi, controllaSelezione, leggiRichiesta, usiVuoti, MAX_ID_PER_RICHIESTA,
  type TurniMacchina, type TurniGuida,
} from "../lib/udp-scenari";

const u = (n: number) => `a1b20000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = u(900);
const tm = (n: number, inEsercizio = false): TurniMacchina => ({
  id: u(n), nome: `TM ${n}`, data: "2026-09-20", creato: null, progettoId: P, inEsercizio, vetture: 20,
});
const tg = (n: number, padre: number | null, inEsercizio = false): TurniGuida => ({
  id: u(n), nome: `TG ${n}`, turniMacchinaId: padre == null ? null : u(padre), creato: null, progettoId: P, inEsercizio, turni: 40,
});

describe("la richiesta", () => {
  it("due elenchi di uuid, senza doppi", () => {
    expect(leggiRichiesta({ turniMacchina: [u(1), u(1).toUpperCase()], turniGuida: [u(2)] }))
      .toEqual({ ok: true, turniMacchina: [u(1)], turniGuida: [u(2)] });
  });

  it("fail closed: niente id, id brutti, elenchi che non sono elenchi, troppi id", () => {
    expect(leggiRichiesta({})).toMatchObject({ ok: false, errore: expect.stringMatching(/nessuno scenario/) });
    expect(leggiRichiesta(null)).toMatchObject({ ok: false });
    expect(leggiRichiesta({ turniMacchina: ["1; DROP TABLE x"] })).toMatchObject({ ok: false, errore: expect.stringMatching(/non valido/) });
    expect(leggiRichiesta({ turniGuida: u(1) })).toMatchObject({ ok: false, errore: expect.stringMatching(/elenco/) });
    const troppi = Array.from({ length: MAX_ID_PER_RICHIESTA + 1 }, (_, i) => u(i + 1));
    expect(leggiRichiesta({ turniMacchina: troppi })).toMatchObject({ ok: false, errore: expect.stringMatching(/al massimo/) });
  });
});

describe("i blocchi", () => {
  it("in esercizio, roster, giornate di esercizio", () => {
    const usi = usiVuoti();
    usi.roster.add(u(2));
    usi.giornateEsercizio.add(u(2));
    expect(blocchiDi(tm(1, true), usi)).toEqual(["in_esercizio"]);
    expect(blocchiDi(tg(2, 1), usi)).toEqual(["roster", "giornate_esercizio"]);
    expect(blocchiDi(tm(3), usi)).toEqual([]);
  });
});

describe("l'anteprima", () => {
  it("propone tutto ciò che non è bloccato; il padre di un turni guida bloccato resta", () => {
    const usi = usiVuoti();
    usi.roster.add(u(21));                       // il TG 21 (di TM 2) è nel roster
    const a = anteprima(
      [tm(1), tm(2), tm(3, true)],
      [tg(11, 1), tg(12, 1), tg(21, 2), tg(22, 2), tg(31, 3), tg(40, null)],
      usi,
    );
    expect(a.eliminabili.turniMacchina).toEqual([u(1)]);              // 2 ha un figlio nel roster, 3 è in esercizio
    expect(a.eliminabili.turniGuida).toEqual([u(11), u(12), u(22), u(31), u(40)]);
    expect(a.bloccati).toBe(2);
    expect(a.turniMacchina.find(s => s.id === u(1))).toMatchObject({ turniGuida: 2, blocchi: [] });
    expect(a.turniMacchina.find(s => s.id === u(3))).toMatchObject({ blocchi: ["in_esercizio"] });
  });

  it("e quello che propone passa il controllo così com'è", () => {
    const usi = usiVuoti();
    usi.giornateEsercizio.add(u(2));
    const T = [tm(1), tm(2)], G = [tg(11, 1), tg(21, 2)];
    const a = anteprima(T, G, usi);
    expect(controllaSelezione(a.eliminabili, T, G, usi)).toMatchObject({ ok: true });
  });
});

describe("il controllo della selezione", () => {
  const T = [tm(1), tm(2, true)], G = [tg(11, 1), tg(12, 1), tg(21, 2)];

  it("tutto in ordine: si elimina quello che è stato chiesto", () => {
    expect(controllaSelezione({ turniMacchina: [u(1)], turniGuida: [u(11), u(12)] }, T, G, usiVuoti()))
      .toEqual({ ok: true, turniMacchina: [u(1)], turniGuida: [u(11), u(12)] });
    // un turni guida da solo, anche se il padre resta
    expect(controllaSelezione({ turniMacchina: [], turniGuida: [u(21)] }, T, G, usiVuoti())).toMatchObject({ ok: true });
  });

  it("un id fuori dall'UDP: 400 e niente", () => {
    expect(controllaSelezione({ turniMacchina: [u(1), u(77)], turniGuida: [u(11), u(12)] }, T, G, usiVuoti()))
      .toMatchObject({ ok: false, stato: 400, ids: [u(77)] });
  });

  it("un turni guida del padre scelto, non in elenco (nato dopo l'anteprima): 409, si rifà l'anteprima", () => {
    expect(controllaSelezione({ turniMacchina: [u(1)], turniGuida: [u(11)] }, T, G, usiVuoti()))
      .toMatchObject({ ok: false, stato: 409, ids: [u(12)], errore: expect.stringMatching(/rifai l'anteprima/) });
  });

  it("uno bloccato: 409 col motivo, e non si cancella neanche il resto", () => {
    const r = controllaSelezione({ turniMacchina: [u(1), u(2)], turniGuida: [u(11), u(12), u(21)] }, T, G, usiVuoti());
    expect(r).toMatchObject({ ok: false, stato: 409, ids: [u(2)], errore: expect.stringMatching(/in esercizio/) });
    const usi = usiVuoti();
    usi.roster.add(u(12));
    expect(controllaSelezione({ turniMacchina: [u(1)], turniGuida: [u(11), u(12)] }, T, G, usi))
      .toMatchObject({ ok: false, stato: 409, ids: [u(12)], errore: expect.stringMatching(/roster/) });
  });
});
