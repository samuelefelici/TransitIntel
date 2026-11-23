import { describe, it, expect } from "vitest";
import { etaCopia, megabyte, statoCopie, type Copia } from "./copie-database";

const adesso = new Date("2026-11-23T12:00:00Z");
const copia = (finitaIl: string): Copia => ({
  id: "x", stato: "riuscita", chiestaDa: null, creataIl: finitaIl, iniziataIl: finitaIl, finitaIl,
  oggetto: "cerbero/x.dump.enc", byte: 74_748_084, sha256: "a".repeat(64), tabelle: 181, versione: "17", errore: null,
});

describe("le copie del database nella pagina dell'amministratore (tappa 7.23)", () => {
  it("senza copie riuscite: attenzione, e dice come impostarle", () => {
    const s = statoCopie(null, adesso);
    expect(s.livello).toBe("attenzione");
    expect(s.dettaglio).toMatch(/BACKUP_\*/);
  });
  it("l'ultima di stanotte: in regola; di due giorni fa: attenzione", () => {
    expect(statoCopie(copia("2026-11-23T02:10:00Z"), adesso).livello).toBe("bene");
    const vecchia = statoCopie(copia("2026-11-21T02:10:00Z"), adesso);
    expect(vecchia.livello).toBe("attenzione");
    expect(vecchia.dettaglio).toMatch(/2 giorni fa/);
  });
  it("quanto tempo fa, e la dimensione", () => {
    expect(etaCopia("2026-11-23T11:59:30Z", adesso)).toBe("adesso");
    expect(etaCopia("2026-11-23T11:15:00Z", adesso)).toBe("45 minuti fa");
    expect(etaCopia("2026-11-23T02:00:00Z", adesso)).toBe("10 ore fa");
    expect(etaCopia("2026-11-20T12:00:00Z", adesso)).toBe("3 giorni fa");
    expect(megabyte(74_748_084)).toBe("74,7 MB");
    expect(megabyte(null)).toBe("—");
  });
});
