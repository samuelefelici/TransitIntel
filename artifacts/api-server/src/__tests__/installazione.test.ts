/**
 * Che cosa ha scritto l'azienda e che cosa le manca (tappa 6.18), puro: lo
 * stato di ogni voce dai conteggi.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { vociDellInstallazione, type Conteggi } from "../lib/installazione";

const VUOTA: Conteggi = {
  aziendaCompilata: false, provinciaIstat: false, netexCodiceLocale: false, avmRegola: false,
  retiUrbane: 0, regoleLinee: 0, gestori: 0, fasce: 0, titoli: 0, categorie: 1, supporti: 0, comuni: 0,
  luoghi: { punti_interesse: 0, meteo: 0, polo_lavoro: 0, traffico: 0, centro_urbano: 0 },
  nodiScambio: 0, depositi: 0, puntiDiCambio: 0, puntiSenzaFermate: 0, autoAziendali: null,
};
/* come la copia dei dati veri di Conerobus */
const CONEROBUS: Conteggi = {
  aziendaCompilata: true, provinciaIstat: true, netexCodiceLocale: true, avmRegola: true,
  retiUrbane: 6, regoleLinee: 8, gestori: 1, fasce: 23, titoli: 159, categorie: 7, supporti: 7, comuni: 50,
  luoghi: { punti_interesse: 15, meteo: 5, polo_lavoro: 14, traffico: 37, centro_urbano: 1 },
  nodiScambio: 9, depositi: 7, puntiDiCambio: 4, puntiSenzaFermate: 1, autoAziendali: 8,
};

describe("le voci di un'installazione", () => {
  it("una nuova azienda: le necessarie da compilare, le altre facoltative; nessuna compilata", () => {
    const voci = vociDellInstallazione(VUOTA);
    const per = (s: string) => voci.filter((v) => v.stato === s).map((v) => v.voce);
    expect(per("compilata")).toEqual([]);
    expect(per("da_compilare")).toEqual([
      "azienda", "reti", "depositi", "fasce", "titoli", "elenchi", "provincia", "comuni", "punti-interesse", "punti-cambio",
    ]);
    expect(per("facoltativa")).toEqual([
      "gestori", "meteo", "poli-lavoro", "traffico", "centri-urbani", "nodi-scambio", "auto-aziendali", "avm", "netex",
    ]);
  });

  it("Conerobus: tutte compilate; l'avviso del punto di cambio senza fermate", () => {
    const voci = vociDellInstallazione(CONEROBUS);
    expect(voci.filter((v) => v.stato !== "compilata").map((v) => v.voce)).toEqual([]);
    expect(voci.find((v) => v.voce === "punti-cambio")).toMatchObject({
      dettaglio: "4 punti", avviso: "1 punto non ha fermate: nessuno dei due calcoli dei turni guida li riconosce.",
    });
    expect(voci.filter((v) => v.avviso).map((v) => v.voce)).toEqual(["punti-cambio"]);
    expect(voci.find((v) => v.voce === "titoli")?.dettaglio).toBe("159 titoli");
    expect(voci.find((v) => v.voce === "reti")?.dettaglio).toBe("6 reti urbane, 8 regole");
    expect(voci.find((v) => v.voce === "auto-aziendali")?.dettaglio).toBe("8 auto");
  });

  it("le reti: basta una rete urbana o una regola; le categorie e i supporti vogliono tutti e due", () => {
    const stato = (c: Partial<Conteggi>, voce: string) => vociDellInstallazione({ ...VUOTA, ...c }).find((v) => v.voce === voce)!.stato;
    expect(stato({ retiUrbane: 1 }, "reti")).toBe("compilata");
    expect(stato({ regoleLinee: 1 }, "reti")).toBe("compilata");
    expect(stato({ categorie: 1, supporti: 0 }, "elenchi")).toBe("da_compilare");
    expect(stato({ categorie: 1, supporti: 2 }, "elenchi")).toBe("compilata");
    /* zero auto è un numero scritto: vale */
    expect(stato({ autoAziendali: 0 }, "auto-aziendali")).toBe("compilata");
  });

  it("ogni voce dice dove si scrive e che cosa succede se manca", () => {
    for (const v of vociDellInstallazione(VUOTA)) {
      expect(v.seManca.length, v.voce).toBeGreaterThan(10);
      expect(v.dove.pagina, v.voce).toMatch(/^\/[a-z-/]+$/);
      expect(v.dove.etichetta, v.voce).not.toBe("");
      if (v.dove.pagina === "/admin/azienda") expect(v.dove.sezione, v.voce).toMatch(/^azienda-[a-z]+$/);
    }
    expect(new Set(vociDellInstallazione(VUOTA).map((v) => v.voce)).size).toBe(19);
  });
});

describe("i collegamenti", () => {
  it("ogni sezione della pagina Azienda a cui porta una voce esiste nella pagina", () => {
    const pagina = readFileSync(path.resolve(__dirname, "../../../transitintel/src/pages/admin-azienda.tsx"), "utf8");
    const sezioni = new Set(vociDellInstallazione(VUOTA).map((v) => v.dove.sezione).filter(Boolean));
    expect(sezioni.size).toBeGreaterThan(5);
    for (const s of sezioni) expect(pagina, s!).toContain(`id="${s}"`);
  });
});
