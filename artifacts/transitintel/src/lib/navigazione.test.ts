import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { Permission } from "@/hooks/use-auth";
import {
  CASA, NOMI_PERMESSI, PERMESSI_PAGINA, PREFISSI_PUBBLICI, SEZIONI,
  paginaDiLavoro, paginaTariffe, sezioniVisibili, voceAttiva,
} from "./navigazione";

const TUTTI: Permission[] = ["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale", "roster"];
const con = (...p: Permission[]) => (x: Permission) => p.includes(x);
/** come il server: Rete e orari porta con sé i Turni */
const profilo = (...p: Permission[]) => con(...p, ...(p.includes("network") ? ["scheduling" as const] : []));
const menu = (ha: (p: Permission) => boolean, admin = false) =>
  Object.fromEntries(sezioniVisibili(ha, admin).map(s => [s.titolo, s.voci.map(v => v.etichetta)]));

describe("il menu di chi entra", () => {
  it("senza permessi: Oggi e la sicurezza del proprio account", () => {
    expect(menu(con())).toEqual({ Oggi: ["Oggi"], Amministrazione: ["Sicurezza dell'account"] });
  });

  it("Rete e orari: Planning Studio, i turni che porta con sé e gli orari al pubblico", () => {
    const m = menu(profilo("network"));
    expect(Object.keys(m)).toEqual(["Oggi", "Rete e orari", "Turni", "Pubblicazione", "Amministrazione"]);
    expect(m["Pubblicazione"]).toEqual(["Turni al roster", "Orari al pubblico"]);
  });

  it("solo Turni: i progetti, i misti e la pubblicazione al roster, non gli orari al pubblico", () => {
    const m = menu(con("scheduling"));
    expect(m["Turni"]).toEqual(["Progetti di esercizio", "Turni misti"]);
    expect(m["Pubblicazione"]).toEqual(["Turni al roster"]);
    expect(m["Rete e orari"]).toBeUndefined();
  });

  it("Roster e Personale", () => {
    expect(menu(con("roster"))["Personale"]).toEqual(["Roster", "Anagrafica"]);
    expect(menu(con("personale"))["Personale"]).toEqual(["Anagrafica"]);
  });

  it("Esercizio: mappa, AVM e tempi osservati; chi ha solo Analisi tiene i tempi osservati", () => {
    expect(menu(con("centrale"))["Esercizio"]).toEqual(["Mappa live", "AVM", "Tempi osservati"]);
    expect(menu(con("analytics"))["Esercizio"]).toEqual(["Tempi osservati"]);
  });

  it("Analisi è una sezione sua, con i dati GTFS in Amministrazione", () => {
    const m = menu(con("analytics"));
    expect(m["Analisi"]).toEqual(["Mappa del territorio", "Traffico", "Territorio e domanda", "Linee e fermate GTFS", "Ipotesi di linea"]);
    expect(m["Amministrazione"]).toEqual(["Dati e integrazioni", "Sicurezza dell'account"]);
    expect(menu(con("network"))["Analisi"]).toBeUndefined();
  });

  it("Tariffe e Flotta", () => {
    expect(menu(con("fares"))["Tariffe"]).toHaveLength(6);
    expect(menu(con("fleetcare"))["Flotta"]).toEqual(["FleetCare"]);
  });

  it("l'admin vede tutto, compresa Gestione Utenti", () => {
    const m = menu(con(), true);
    expect(Object.keys(m)).toEqual(SEZIONI.map(s => s.titolo));
    expect(m["Amministrazione"]).toContain("Utenti e accessi");
    expect(menu(con(...TUTTI))["Amministrazione"]).not.toContain("Utenti e accessi");
  });

  it("in ogni combinazione di permessi: niente sezioni vuote, Oggi e Amministrazione sempre", () => {
    for (let bit = 0; bit < 1 << TUTTI.length; bit++) {
      const attivi = TUTTI.filter((_, i) => bit & (1 << i));
      const sezioni = sezioniVisibili(con(...attivi), false);
      expect(sezioni.every(s => s.voci.length > 0)).toBe(true);
      expect(sezioni[0]!.titolo).toBe("Oggi");
      expect(sezioni.at(-1)!.titolo).toBe("Amministrazione");
    }
  });
});

describe("menu e pagine dicono la stessa cosa", () => {
  const voci = SEZIONI.flatMap(s => s.voci);

  it("ogni voce chiede gli stessi permessi della sua pagina", () => {
    for (const v of voci) {
      if (v.href in PERMESSI_PAGINA) {
        expect(v.permessi, v.href).toEqual(PERMESSI_PAGINA[v.href as keyof typeof PERMESSI_PAGINA]);
      }
    }
  });

  it("App.tsx usa PERMESSI_PAGINA per ogni pagina con un modulo", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    for (const pagina of Object.keys(PERMESSI_PAGINA)) {
      expect(app, pagina).toContain(`PERMESSI_PAGINA["${pagina}"]`);
    }
  });

  it("nessuna voce comincia come i percorsi pubblici dei QR", () => {
    for (const v of voci) for (const p of PREFISSI_PUBBLICI) expect(v.href.startsWith(p), v.href).toBe(false);
  });

  it("ogni voce ha un href solo e la casa è la prima", () => {
    expect(new Set(voci.map(v => v.href)).size).toBe(voci.length);
    expect(voci[0]!.href).toBe(CASA);
  });

  it("ogni permesso ha il suo nome nel menu", () => {
    for (const p of TUTTI) expect(NOMI_PERMESSI[p]).toBeTruthy();
  });
});

describe("la voce accesa e le pagine di lavoro", () => {
  const tutte = sezioniVisibili(() => true, true);

  it("la voce più specifica vince", () => {
    expect(voceAttiva("/roster/anagrafica", tutte)).toBe("/roster/anagrafica");
    expect(voceAttiva("/roster/pubblicazione", tutte)).toBe("/roster/pubblicazione");
    expect(voceAttiva("/roster", tutte)).toBe("/roster");
    expect(voceAttiva("/planning-studio/abc/trips", tutte)).toBe("/planning-studio");
    expect(voceAttiva("/planning", tutte)).toBe("/planning");
    expect(voceAttiva("/fares-polimetriche", tutte)).toBe("/fares-polimetriche");
  });

  it("le pagine dentro la Fucina accendono Progetti di esercizio", () => {
    expect(voceAttiva("/fucina/abc/vehicles/def", tutte)).toBe("/fucina/esercizio");
    expect(voceAttiva("/driver-shifts/abc", tutte)).toBe("/fucina/esercizio");
  });

  it("una pagina fuori dal menu non accende niente", () => {
    expect(voceAttiva("/admin/parametri-che-non-ci-sono", tutte)).toBeNull();
  });

  it("pagine di lavoro e pagine delle tariffe", () => {
    expect(paginaDiLavoro("/planning-studio/abc")).toBe(true);
    expect(paginaDiLavoro("/planning-studio")).toBe(false);
    expect(paginaDiLavoro("/fucina/esercizio")).toBe(true);
    expect(paginaDiLavoro("/roster")).toBe(false);
    expect(paginaTariffe("/fare-docs")).toBe(true);
    expect(paginaTariffe("/fucina")).toBe(false);
  });
});
