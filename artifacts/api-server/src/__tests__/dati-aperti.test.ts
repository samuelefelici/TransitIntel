/**
 * I dati aperti a un indirizzo stabile (tappa 6.3): le regole senza database.
 * Quando un file va rifatto, e quando chi scarica lo ha già.
 */
import { describe, it, expect } from "vitest";
import { deveProvare, firmaDi, FILE } from "../lib/dati-aperti";
import { AZIENDA_DA_COMPILARE, type Azienda } from "../lib/azienda";
import { giaCeLHa } from "../routes/dati-aperti";
import { zipDelGtfs } from "../lib/gtfs-consegnabile";
import type { Gtfs } from "../lib/gtfs-verifica";

const AZIENDA: Azienda = {
  ...AZIENDA_DA_COMPILARE, ragioneSociale: "Trasporti di prova S.p.A.", nome: "Prova", sito: "https://prova.example",
  telefono: "+39 071 000000", gtfsAgencyId: "prova", netexCodiceLocale: "ITI3", netexFornitore: null, compilata: true,
};
const V = { versioneId: "d6300000-0000-4000-8000-000000000001", feedId: "d6300000-0000-4000-8000-000000000002" };

describe("dati aperti: la firma di un file", () => {
  it("è stabile, ed è diversa per i due file", () => {
    expect(firmaDi("gtfs", V, AZIENDA)).toMatch(/^[0-9a-f]{64}$/);
    expect(firmaDi("gtfs", V, { ...AZIENDA })).toBe(firmaDi("gtfs", V, AZIENDA));
    expect(firmaDi("netex", V, AZIENDA)).not.toBe(firmaDi("gtfs", V, AZIENDA));
  });
  it("cambia con la versione in esercizio e con i dati dell'azienda che finiscono nel file", () => {
    const base = firmaDi("gtfs", V, AZIENDA);
    expect(firmaDi("gtfs", { ...V, versioneId: V.feedId }, AZIENDA)).not.toBe(base);
    expect(firmaDi("gtfs", { ...V, feedId: V.versioneId }, AZIENDA)).not.toBe(base);
    for (const cambio of [{ ragioneSociale: "Altra S.p.A." }, { sito: null }, { telefono: null }, { gtfsAgencyId: "altra" }]) {
      expect(firmaDi("gtfs", V, { ...AZIENDA, ...cambio }), JSON.stringify(cambio)).not.toBe(base);
    }
  });
  it("i codici NeTEx toccano solo il NeTEx; la città e il centro della mappa nessuno dei due", () => {
    const conFornitore = { ...AZIENDA, netexFornitore: "ATMA" };
    expect(firmaDi("gtfs", V, conFornitore)).toBe(firmaDi("gtfs", V, AZIENDA));
    expect(firmaDi("netex", V, conFornitore)).not.toBe(firmaDi("netex", V, AZIENDA));
    const altrove = { ...AZIENDA, citta: "Jesi", centro: { lat: 43.5, lng: 13.2, zoom: 11 } };
    expect(firmaDi("gtfs", V, altrove)).toBe(firmaDi("gtfs", V, AZIENDA));
    expect(firmaDi("netex", V, altrove)).toBe(firmaDi("netex", V, AZIENDA));
  });
});

describe("dati aperti: quando un file va rifatto", () => {
  const firma = firmaDi("gtfs", V, AZIENDA);
  const adesso = new Date("2026-11-17T08:00:00Z");
  const prima = (esito: any, minutiFa = 5, f = firma) => ({ firma: f, esito, provatoIl: new Date(adesso.getTime() - minutiFa * 60_000) });
  it("mai fatto, o nato da altro: sì", () => {
    expect(deveProvare(undefined, firma, adesso)).toBe(true);
    expect(deveProvare(prima("pubblicato", 5, "0".repeat(64)), firma, adesso)).toBe(true);
    expect(deveProvare({ firma: null, esito: "senza_versione", provatoIl: adesso }, firma, adesso)).toBe(true);
  });
  it("già pubblicato, o fermato dai dati: no, darebbe lo stesso esito", () => {
    for (const e of ["pubblicato", "gtfs_con_errori", "non_valido", "senza_codice"]) expect(deveProvare(prima(e, 600), firma, adesso), e).toBe(false);
  });
  it("fermato da un guasto: dopo un'ora", () => {
    for (const e of ["errore", "senza_xmllint"]) {
      expect(deveProvare(prima(e, 59), firma, adesso), e).toBe(false);
      expect(deveProvare(prima(e, 60), firma, adesso), e).toBe(true);
    }
  });
  it("«Prepara adesso» rifà sempre", () => {
    expect(deveProvare(prima("pubblicato"), firma, adesso, true)).toBe(true);
  });
});

describe("dati aperti: chi scarica ha già il file", () => {
  const f = { impronta: "a".repeat(64), byte: 10, preparatoIl: new Date("2026-11-17T08:00:00.700Z"), inEsercizioDal: null };
  it("If-None-Match: la stessa impronta, anche fra altre e in forma debole", () => {
    expect(giaCeLHa(f, { "if-none-match": `"${f.impronta}"` })).toBe(true);
    expect(giaCeLHa(f, { "if-none-match": `"x", W/"${f.impronta}"` })).toBe(true);
    expect(giaCeLHa(f, { "if-none-match": "*" })).toBe(true);
    expect(giaCeLHa(f, { "if-none-match": `"${"b".repeat(64)}"` })).toBe(false);
    expect(giaCeLHa(f, { "if-none-match": f.impronta })).toBe(false); // senza virgolette non è un'ETag
  });
  it("If-None-Match vince su If-Modified-Since", () => {
    expect(giaCeLHa(f, { "if-none-match": '"altra"', "if-modified-since": "Wed, 18 Nov 2026 00:00:00 GMT" })).toBe(false);
  });
  it("If-Modified-Since: al secondo, come Last-Modified", () => {
    expect(giaCeLHa(f, { "if-modified-since": f.preparatoIl.toUTCString() })).toBe(true);
    expect(giaCeLHa(f, { "if-modified-since": "Tue, 17 Nov 2026 07:59:59 GMT" })).toBe(false);
    expect(giaCeLHa(f, { "if-modified-since": "non è una data" })).toBe(false);
    expect(giaCeLHa(f, {})).toBe(false);
  });
});

describe("dati aperti: i file", () => {
  it("gli indirizzi sono quelli registrati al NAP: non si cambiano", () => {
    expect(FILE.gtfs.percorso).toBe("/api/dati-aperti/gtfs.zip");
    expect(FILE.netex.percorso).toBe("/api/dati-aperti/netex.xml.gz");
  });
  it("lo stesso GTFS dà lo stesso zip, byte per byte", async () => {
    const g: Gtfs = { "agency.txt": { colonne: ["agency_id"], righe: [{ agency_id: "prova" }] } };
    const quando = new Date("2026-11-13T10:00:01Z");
    const a = zipDelGtfs(g, quando);
    await new Promise((r) => setTimeout(r, 2100)); // l'ora nello zip va a due secondi
    expect(zipDelGtfs(g, quando).equals(a)).toBe(true);
  });
});
