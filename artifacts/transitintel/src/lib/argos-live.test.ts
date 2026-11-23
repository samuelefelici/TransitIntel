import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annunciaScrittura, ascoltaAltreSchede, CANALE_ARGOS_LIVE, indirizzoArgos } from "./argos-live";

/* niente browser: la finestra è un EventTarget, il BroadcastChannel è quello di Node */
const finestra = new EventTarget();
const ricevuti: unknown[] = [];
const registra = (e: Event) => ricevuti.push((e as CustomEvent).detail);
const attesa = () => new Promise(r => setTimeout(r, 30));

beforeEach(() => {
  (globalThis as any).window = finestra;
  ricevuti.length = 0;
  finestra.addEventListener("argos-live", registra);
});
afterEach(() => {
  finestra.removeEventListener("argos-live", registra);
  delete (globalThis as any).window;
});

describe("la regia in diretta fra schede", () => {
  it("una scrittura va alla finestra e alle altre schede", async () => {
    const altra = new BroadcastChannel(CANALE_ARGOS_LIVE);
    const arrivati: unknown[] = [];
    altra.onmessage = e => arrivati.push(e.data);
    const d = { name: "ti_bulk_create_trips", ok: true, tripIds: ["t1"], projectId: "p1" };
    annunciaScrittura(d);
    await attesa();
    altra.close();
    expect(ricevuti).toEqual([d]);
    expect(arrivati).toEqual([d]);
  });

  it("dalle altre schede arrivano come eventi di questa finestra; il resto si ignora", async () => {
    const smetti = ascoltaAltreSchede();
    const altra = new BroadcastChannel(CANALE_ARGOS_LIVE);
    altra.postMessage({ name: "ti_set_validity", ok: true });
    altra.postMessage("non un oggetto");
    altra.postMessage({ ok: true });
    await attesa();
    smetti();
    altra.postMessage({ name: "dopo la chiusura", ok: true });
    await attesa();
    altra.close();
    expect(ricevuti).toEqual([{ name: "ti_set_validity", ok: true }]);
  });
});

describe("il bottone di Planning Studio", () => {
  it("apre le conversazioni, sul progetto se c'è", () => {
    expect(indirizzoArgos(undefined, "/")).toBe("/argos?scheda=conversazioni");
    expect(indirizzoArgos("11111111-2222-3333-4444-555555555555", "/cerbero/"))
      .toBe("/cerbero/argos?scheda=conversazioni&progetto=11111111-2222-3333-4444-555555555555");
  });
});
