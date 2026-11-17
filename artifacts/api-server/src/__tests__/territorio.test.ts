/**
 * Il territorio dell'azienda (tappa 6.1), puro: i nomi dei comuni da ogni
 * forma del codice ISTAT, la validazione di comuni e luoghi, i dati di
 * partenza di Conerobus nella migrazione 0035.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chiaveCensimento, DatiComune, DatiLuogo, nomeComune, nomeOppure, nomiDa } from "../lib/territorio";

const SQL = readFileSync(path.resolve(__dirname, "../../../../lib/db/migrations/0035_territorio_dell_azienda.sql"), "utf8");
const comuniDellaMigrazione = [...SQL.matchAll(/\('(\d{6})', '((?:[^']|'')+)', (true|false), /g)]
  .map((m) => ({ codiceIstat: m[1]!, nome: m[2]!.replace(/''/g, "'"), soppresso: m[3] === "true" }));
const nomi = nomiDa(comuniDellaMigrazione);

describe("i nomi dei comuni", () => {
  it("la chiave delle sezioni del censimento: la provincia senza zeri davanti", () => {
    expect(chiaveCensimento("042002")).toBe("42002");
    expect(chiaveCensimento("001272")).toBe("1272");
    expect(chiaveCensimento("108001")).toBe("108001");
  });

  it("da ogni forma del codice: ufficiale, sezione a 5, prefisso a 6, sezione intera", () => {
    expect(nomeComune("042002", nomi)).toBe("Ancona");
    expect(nomeComune("42002", nomi)).toBe("Ancona");
    expect(nomeComune("420020", nomi)).toBe("Ancona");
    expect(nomeComune("420020001234", nomi)).toBe("Ancona");
    expect(nomeComune(" 42021 ", nomi)).toBe("Jesi");
    expect(nomeComune("99999", nomi)).toBeNull();
    expect(nomeComune("", nomi)).toBeNull();
    expect(nomeOppure("99999", nomi)).toBe("Comune 99999");
  });

  it("la copia sfasata che c'era nell'analisi della rete non torna: 420260 è Montecarotto, 420340 è Osimo", () => {
    expect(nomeComune("420260", nomi)).toBe("Montecarotto");
    expect(nomeComune("420290", nomi)).toBe("Monte Roberto");
    expect(nomeComune("420340", nomi)).toBe("Osimo");
    expect(nomeComune("420450", nomi)).toBe("Senigallia");
  });

  it("anche province a una e a tre cifre", () => {
    const altri = nomiDa([{ codiceIstat: "001272", nome: "Torino" }, { codiceIstat: "108001", nome: "Agrate Brianza" }]);
    expect(nomeComune("1272", altri)).toBe("Torino");
    expect(nomeComune("127200010001", altri)).toBe("Torino");
    expect(nomeComune("108001", altri)).toBe("Agrate Brianza");
    expect(nomeComune("108001000123", altri)).toBe("Agrate Brianza");
  });

  it("i dati di partenza di Conerobus: i 47 comuni della provincia e i 3 soppressi del 2011, codici unici", () => {
    expect(comuniDellaMigrazione.filter((c) => !c.soppresso)).toHaveLength(47);
    expect(comuniDellaMigrazione.filter((c) => c.soppresso).map((c) => c.nome).sort()).toEqual(["Castel Colonna", "Monterado", "Ripe"]);
    expect(new Set(comuniDellaMigrazione.map((c) => c.codiceIstat)).size).toBe(50);
    expect(comuniDellaMigrazione.every((c) => c.codiceIstat.startsWith("042"))).toBe(true);
    // i soppressi servono ai dati del 2011 (pendolarismo), con il loro nome
    expect(nomeComune("042028", nomi)).toBe("Monterado");
  });
});

describe("comuni e luoghi, la validazione", () => {
  it("un comune: codice a sei cifre, nome, centroide intero o niente", () => {
    expect(DatiComune.safeParse({ codiceIstat: "042002", nome: " Ancona " }).data).toMatchObject({ nome: "Ancona", soppresso: false, lat: null, lng: null });
    expect(DatiComune.safeParse({ codiceIstat: "42002", nome: "Ancona" }).success).toBe(false);
    expect(DatiComune.safeParse({ codiceIstat: "042002", nome: "" }).success).toBe(false);
    expect(DatiComune.safeParse({ codiceIstat: "042002", nome: "Ancona", lat: 43.6 }).success).toBe(false);
    expect(DatiComune.safeParse({ codiceIstat: "042002", nome: "Ancona", lat: 43.6, lng: 13.5, areaKm2: 124, popolazione: 99000 }).success).toBe(true);
    expect(DatiComune.safeParse({ codiceIstat: "042002", nome: "Ancona", altro: 1 }).success).toBe(false);
    expect(DatiComune.safeParse({ codiceIstat: "042002", nome: "Anc\u0000ona" }).success).toBe(false);
  });

  it("un luogo: uso fra quelli previsti, coordinate, raggio fra 100 m e 50 km", () => {
    expect(DatiLuogo.safeParse({ nome: "Jesi", uso: "meteo", lat: 43.52, lng: 13.24 }).data).toMatchObject({ raggioM: null, ordine: 0 });
    expect(DatiLuogo.safeParse({ nome: "Jesi", uso: "traffico", lat: 43.52, lng: 13.24 }).success).toBe(false);
    expect(DatiLuogo.safeParse({ nome: "Jesi", uso: "punti_interesse", lat: 43.52, lng: 13.24, raggioM: 50 }).success).toBe(false);
    expect(DatiLuogo.safeParse({ nome: "Jesi", uso: "punti_interesse", lat: 91, lng: 13.24 }).success).toBe(false);
  });
});
