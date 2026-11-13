import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { AREE, INTERRUTTORI, dirittiDi, puo, type Area, type Interruttore, type RuoloAziendale } from "@workspace/permessi";
import {
  AREE_PAGINA, CASA, NOMI_AREE, PREFISSI_PUBBLICI, SEZIONI,
  paginaDiLavoro, paginaTariffe, sezioniVisibili, voceAttiva,
} from "./navigazione";
import { schedeVisibili } from "@/pages/data";

type Permission = Interruttore;
const TUTTI: Permission[] = [...INTERRUTTORI];
const legge = (ruoli: RuoloAziendale[], interruttori: Permission[]) => {
  const d = dirittiDi({
    admin: false, ruoli,
    accessoDiPrima: Object.fromEntries(interruttori.filter(i => i !== "analytics").map(i => [i, true])),
    analisi: interruttori.includes("analytics"), datiSanitari: false,
  });
  return (a: Area) => puo(d, a, "L");
};
/** Chi ha questi interruttori di prima dei ruoli (il suo «accesso di prima»): il menu
 *  deve restare quello che vedeva. «analytics» è diventato la capacità Analisi. */
const con = (...p: Permission[]) => legge([], p);
/** Chi ha solo ruoli aziendali. */
const conRuoli = (...r: RuoloAziendale[]) => legge(r, []);
/** come il server di prima dei ruoli: Rete e orari portava con sé i Turni */
const profilo = (...p: Permission[]) => con(...p, ...(p.includes("network") ? ["scheduling" as const] : []));
const menu = (ha: (a: Area) => boolean, admin = false) =>
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

  it("solo Turni: i progetti, i calcoli e la pubblicazione al roster, non gli orari al pubblico", () => {
    const m = menu(con("scheduling"));
    // PR 2.13b: «Turni misti» è fuori dal menu (la pagina resta), «Database di esercizio» non c'è più
    expect(m["Turni"]).toEqual(["Progetti di esercizio", "I miei calcoli"]);
    // dalla pagina dei misti resta accesa la voce dei Progetti di esercizio
    expect(voceAttiva("/misto", sezioniVisibili(() => true, true))).toBe("/fucina/esercizio");
    expect(m["Pubblicazione"]).toEqual(["Turni al roster"]);
    expect(m["Rete e orari"]).toBeUndefined();
  });

  it("Roster e Personale", () => {
    expect(menu(con("roster"))["Personale"]).toEqual(["Roster", "Anagrafica"]);
    expect(menu(con("personale"))["Personale"]).toEqual(["Anagrafica"]);
  });

  it("Esercizio: mappa, AVM e tempi osservati, più le paline in Dati; chi ha solo Analisi tiene i tempi osservati", () => {
    expect(menu(con("centrale"))["Esercizio"]).toEqual(["Mappa live", "AVM", "Tempi osservati"]);
    expect(menu(con("centrale"))["Amministrazione"]).toEqual(["Dati e integrazioni", "Sicurezza dell'account"]);
    expect(menu(con("analytics"))["Esercizio"]).toEqual(["Tempi osservati"]);
  });

  it("Analisi è una sezione sua, con i dati GTFS in Amministrazione", () => {
    const m = menu(con("analytics"));
    expect(m["Analisi"]).toEqual(["Mappa del territorio", "Traffico", "Territorio e domanda", "Linee e fermate GTFS", "Ipotesi di linea"]);
    expect(m["Amministrazione"]).toEqual(["Dati e integrazioni", "Sicurezza dell'account"]);
    expect(menu(con("network"))["Analisi"]).toBeUndefined();
  });

  it("Tariffe e Flotta", () => {
    expect(menu(con("fares"))["Tariffe"]).toEqual(["Bigliettazione", "Polimetriche", "Simulatore", "Prodotti e KPI", "Percorso e tariffa"]);
    expect(menu(con("fleetcare"))["Flotta"]).toEqual(["FleetCare"]);
  });

  it("l'admin vede tutto, compresa Gestione Utenti", () => {
    const m = menu(con(), true);
    expect(Object.keys(m)).toEqual(SEZIONI.map(s => s.titolo));
    expect(m["Amministrazione"]).toEqual(["Utenti e accessi", "Azienda", "Parametri di esercizio", "Registro delle modifiche", "Dati e integrazioni", "Sicurezza dell'account"]);
    expect(menu(con(...TUTTI))["Amministrazione"]).not.toContain("Utenti e accessi");
    // il registro delle modifiche lo legge solo l'admin, qualunque permesso abbia l'utente
    expect(menu(con(...TUTTI))["Amministrazione"]).not.toContain("Registro delle modifiche");
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

  it("ogni voce chiede le stesse aree della sua pagina", () => {
    for (const v of voci) {
      if (v.href in AREE_PAGINA) {
        expect(v.aree, v.href).toEqual(AREE_PAGINA[v.href as keyof typeof AREE_PAGINA]);
      }
    }
  });

  it("App.tsx usa AREE_PAGINA per ogni pagina con un'area", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    for (const pagina of Object.keys(AREE_PAGINA)) {
      expect(app, pagina).toContain(`AREE_PAGINA["${pagina}"]`);
    }
    // nessuna guardia con i nomi di prima dei ruoli
    expect(app).not.toMatch(/<Gated perm="(network|scheduling|centrale|fares|analytics|fleetcare)"/);
  });

  it("nessuna voce comincia come i percorsi pubblici dei QR", () => {
    for (const v of voci) for (const p of PREFISSI_PUBBLICI) expect(v.href.startsWith(p), v.href).toBe(false);
  });

  it("ogni voce ha un href solo e la casa è la prima", () => {
    expect(new Set(voci.map(v => v.href)).size).toBe(voci.length);
    expect(voci[0]!.href).toBe(CASA);
  });

  it("ogni area ha il suo nome nel menu, e ogni area di una pagina esiste", () => {
    for (const a of AREE) expect(NOMI_AREE[a]).toBeTruthy();
    for (const aree of Object.values(AREE_PAGINA)) for (const a of aree) expect(AREE).toContain(a);
    for (const v of voci) for (const a of v.aree ?? []) expect(AREE).toContain(a);
  });
});

describe("il menu dei ruoli aziendali", () => {
  it("Pianificatore: rete, turni in lettura, tutta la pubblicazione, esercizio e tariffe; niente personale", () => {
    const m = menu(conRuoli("pianificatore"));
    expect(Object.keys(m)).toEqual(["Oggi", "Rete e orari", "Turni", "Pubblicazione", "Esercizio", "Tariffe", "Amministrazione"]);
    expect(m["Pubblicazione"]).toEqual(["Turni al roster", "Orari al pubblico"]);
    expect(m["Amministrazione"]).toEqual(["Dati e integrazioni", "Sicurezza dell'account"]);
  });

  it("Ufficio turni: come il Pianificatore senza le tariffe, più il tabellone", () => {
    const m = menu(conRuoli("ufficio_turni"));
    expect(Object.keys(m)).toEqual(["Oggi", "Rete e orari", "Turni", "Pubblicazione", "Personale", "Esercizio", "Amministrazione"]);
    expect(m["Personale"]).toEqual(["Roster", "Anagrafica"]);
  });

  it("Capo deposito e Centrale: anche la Flotta", () => {
    for (const r of ["capo_deposito", "centrale_operativa"] as const) {
      const m = menu(conRuoli(r));
      expect(Object.keys(m), r).toEqual(["Oggi", "Rete e orari", "Turni", "Pubblicazione", "Personale", "Esercizio", "Flotta", "Amministrazione"]);
    }
  });

  it("Officina: l'esercizio e la flotta, nient'altro", () => {
    const m = menu(conRuoli("officina"));
    expect(Object.keys(m)).toEqual(["Oggi", "Esercizio", "Flotta", "Amministrazione"]);
    expect(m["Esercizio"]).toEqual(["Mappa live", "AVM", "Tempi osservati"]);
  });

  it("Amministrazione: tutto tranne l'Analisi", () => {
    const m = menu(conRuoli("amministrazione"));
    expect(Object.keys(m)).toEqual(["Oggi", "Rete e orari", "Turni", "Pubblicazione", "Personale", "Esercizio", "Flotta", "Tariffe", "Amministrazione"]);
    expect(m["Amministrazione"]).not.toContain("Utenti e accessi");
  });

  it("nessun ruolo apre l'Analisi né le pagine dell'amministratore di sistema", () => {
    for (const r of ["pianificatore", "ufficio_turni", "capo_deposito", "centrale_operativa", "officina", "amministrazione"] as const) {
      const m = menu(conRuoli(r));
      expect(m["Analisi"], r).toBeUndefined();
      for (const voce of ["Utenti e accessi", "Azienda", "Parametri di esercizio", "Registro delle modifiche"]) expect(m["Amministrazione"], r).not.toContain(voce);
    }
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
    expect(voceAttiva("/fucina/abc/drivers/def", tutte)).toBe("/fucina/esercizio");
  });

  it("una pagina fuori dal menu non accende niente", () => {
    expect(voceAttiva("/admin/parametri-che-non-ci-sono", tutte)).toBeNull();
  });

  it("pagine di lavoro e pagine delle tariffe", () => {
    expect(paginaDiLavoro("/planning-studio/abc")).toBe(true);
    expect(paginaDiLavoro("/planning-studio")).toBe(false);
    expect(paginaDiLavoro("/fucina/esercizio")).toBe(true);
    expect(paginaDiLavoro("/roster")).toBe(false);
    expect(paginaTariffe("/fare-analytics")).toBe(true);
    // la «Documentazione ATMA» non c'è più (PR 2.13b)
    expect(paginaTariffe("/fare-docs")).toBe(false);
    expect(paginaTariffe("/fucina")).toBe(false);
  });
});

describe("Dati e integrazioni: le schede secondo i permessi", () => {
  it("l'Esercizio vede solo le paline; Analisi anche i feed; l'admin tutto", () => {
    expect(schedeVisibili({ analisi: false, admin: false })).toEqual(["paline"]);
    expect(schedeVisibili({ analisi: true, admin: false })).toEqual(["gtfs", "paline"]);
    expect(schedeVisibili({ analisi: false, admin: true })).toEqual(["gtfs", "sync", "paline"]);
  });
});
