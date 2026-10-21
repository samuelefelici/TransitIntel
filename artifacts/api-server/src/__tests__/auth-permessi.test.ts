/**
 * Chi entra dove: la mappa prefisso → permesso di auth.ts.
 *
 * Il caso che questo test protegge è il modulo Centrale Operativa: /operations
 * è condiviso fra la Mappa (permesso "centrale") e i Tempi di percorrenza
 * (permesso "analytics"), e un errore qui o apre la Mappa a chi non ha il
 * modulo, o toglie i Tempi di percorrenza a chi lo aveva.
 */
import { describe, it, expect, vi } from "vitest";

/* auth.ts al caricamento prova a creare la tabella users: qui non c'è un
 * database, e non serve — il controllo dei permessi è una funzione pura
 * sull'utente già caricato. */
vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [{ n: 1 }] })) },
}));

import { requirePermission, requirePermissionByPath, vedeCodiciSanitari, vedeDatiPersonali, type AuthUser, type Permission } from "../lib/auth";

function utente(attivi: Permission[], role: "admin" | "user" = "user"): AuthUser {
  const permissions = Object.fromEntries(
    (["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale", "roster"] as Permission[])
      .map(p => [p, attivi.includes(p)]),
  ) as Record<Permission, boolean>;
  return { id: "u", email: "u@x", fullName: null, role, permissions, fleetcareRole: "driver", active: true };
}

/** "passa" se il middleware chiama next, altrimenti il codice HTTP. */
function verifica(path: string, user: AuthUser, method = "GET"): "passa" | number {
  let esito: "passa" | number = "passa";
  const res = {
    status(c: number) { esito = c; return this; },
    json() { return this; },
  };
  requirePermissionByPath({ user, path, method } as any, res as any, () => { esito = "passa"; });
  return esito;
}

describe("Centrale Operativa: chi vede la Mappa e l'AVM", () => {
  const soloCentrale = utente(["centrale"]);
  const soloAnalytics = utente(["analytics"]);
  const nessuno = utente([]);

  it("con il solo modulo si leggono la flotta live e il parco SIRI", () => {
    expect(verifica("/operations/live", soloCentrale)).toBe("passa");
    expect(verifica("/operations/vehicles/263/track", soloCentrale)).toBe("passa");
    expect(verifica("/siri/parco", soloCentrale)).toBe("passa");
    expect(verifica("/siri/parco/settimana", soloCentrale)).toBe("passa");
  });

  it("il modulo da solo non apre il resto di analytics", () => {
    expect(verifica("/timetables", soloCentrale)).toBe(403);
    expect(verifica("/territory/zones", soloCentrale)).toBe(403);
  });

  it("chi ha solo analytics tiene i Tempi di percorrenza, ma non il parco SIRI", () => {
    expect(verifica("/operations/runtimes", soloAnalytics)).toBe("passa");
    expect(verifica("/operations/trips/abc/transits", soloAnalytics)).toBe("passa");
    expect(verifica("/operations/copertura", soloAnalytics)).toBe("passa");
    expect(verifica("/siri/parco/settimana", soloAnalytics)).toBe(403);
  });

  it("senza permessi: niente Mappa né parco, ma le fermate Mizar della scheda Dati restano", () => {
    expect(verifica("/operations/live", nessuno)).toBe(403);
    expect(verifica("/siri/parco", nessuno)).toBe(403);
    expect(verifica("/siri/fermate/abbinamenti", nessuno)).toBe("passa");
    expect(verifica("/siri/status", nessuno)).toBe("passa");
  });

  it("l'admin passa ovunque anche con tutti i permessi spenti", () => {
    const admin = utente([], "admin");
    expect(verifica("/operations/live", admin)).toBe("passa");
    expect(verifica("/siri/parco/settimana", admin)).toBe("passa");
    expect(verifica("/fares/x", admin)).toBe("passa");
  });

  it("il prefisso non cattura nomi che iniziano allo stesso modo", () => {
    /* /siri/parco non deve coprire un ipotetico /siri/parcometri */
    expect(verifica("/siri/parcometri", nessuno)).toBe("passa");
  });
});


describe("Anagrafica del personale: chi entra, chi vede i dati personali", () => {
  const soloPersonale = utente(["personale"]);
  const soloRoster = utente(["roster"]);
  const soloScheduling = utente(["scheduling"]);
  const nessuno = utente(["fares"]);

  it("una maiuscola nel percorso non salta il controllo", () => {
    expect(verifica("/Roster/drivers", nessuno)).toBe(403);
    expect(verifica("/ROSTER/board", nessuno)).toBe(403);
    expect(verifica("/roster/ANAGRAFICA/import/leggi", soloRoster)).toBe(403);
    expect(verifica("/FARES/x", soloRoster)).toBe(403);
  });

  it("chi ha solo «personale» legge e scrive l'anagrafica, ma non il tabellone", () => {
    expect(verifica("/roster/drivers", soloPersonale)).toBe("passa");
    expect(verifica("/roster/drivers/abc/history", soloPersonale)).toBe("passa");
    expect(verifica("/roster/history/abc", soloPersonale)).toBe("passa");
    expect(verifica("/roster/depositi", soloPersonale)).toBe("passa");
    expect(verifica("/roster/rotazioni-riposi", soloPersonale)).toBe("passa");
    expect(verifica("/roster/anagrafica/import/leggi", soloPersonale)).toBe("passa");
    expect(verifica("/roster/board", soloPersonale)).toBe(403);
    expect(verifica("/roster/assignments", soloPersonale)).toBe(403);
  });

  it("chi ha solo «roster» legge i conducenti ed esporta, ma non importa né vede lo storico", () => {
    expect(verifica("/roster/drivers", soloRoster)).toBe("passa");
    expect(verifica("/roster/anagrafica/esporta", soloRoster)).toBe("passa");
    expect(verifica("/roster/board", soloRoster)).toBe("passa");
    expect(verifica("/roster/voci", soloRoster)).toBe("passa");
    expect(verifica("/roster/anagrafica/import/prova", soloRoster)).toBe(403);
    expect(verifica("/roster/history/abc", soloRoster)).toBe(403);
    /* la pubblicazione dei turni è dello Scheduling */
    expect(verifica("/roster/pubblicazioni", soloRoster)).toBe(403);
  });

  it("chi ha solo «scheduling» pubblica i turni ma non entra nel roster", () => {
    expect(verifica("/roster/pubblicazioni/anteprima", soloScheduling)).toBe("passa");
    expect(verifica("/roster/duty-sources", soloScheduling)).toBe("passa");
    expect(verifica("/roster/board", soloScheduling)).toBe(403);
    expect(verifica("/roster/assignments", soloScheduling)).toBe(403);
    expect(verifica("/roster/drivers", soloScheduling)).toBe(403);
    expect(verifica("/roster/rotazioni-riposi", soloScheduling)).toBe(403);
  });

  it("i codici sanitari: admin o «roster», mai col token di Argos", () => {
    expect(vedeCodiciSanitari({ user: soloRoster })).toBe(true);
    expect(vedeCodiciSanitari({ user: soloScheduling })).toBe(false);
    expect(vedeCodiciSanitari({ user: soloPersonale })).toBe(false);
    expect(vedeCodiciSanitari({ user: utente([], "admin") })).toBe(true);
    expect(vedeCodiciSanitari({ user: soloRoster, authVia: "argos" })).toBe(false);
    expect(vedeCodiciSanitari({})).toBe(false);
  });

  it("i dati personali: admin o «personale», mai col token di Argos", () => {
    expect(vedeDatiPersonali({ user: soloPersonale })).toBe(true);
    expect(vedeDatiPersonali({ user: soloScheduling })).toBe(false);
    expect(vedeDatiPersonali({ user: soloRoster })).toBe(false);
    expect(vedeDatiPersonali({ user: utente([], "admin") })).toBe(true);
    expect(vedeDatiPersonali({ user: utente([], "admin"), authVia: "argos" })).toBe(false);
    let codice: number | "passa" = "passa";
    const res = { status(c: number) { codice = c; return this; }, json() { return this; } };
    requirePermission("personale")({ user: utente([], "admin"), authVia: "argos" } as any, res as any, () => { codice = "passa"; });
    expect(codice).toBe(403);
  });
});

describe("Letture condivise: Analisi spenta non rompe gli altri moduli", () => {
  const UUID = "0b0e6a6c-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
  const UUID2 = "1c1f7b7d-2e3f-4a4b-8c9d-8e7f6a5b4c3d";

  it("Turni senza Analisi: feed, fermate, autovetture e la scelta del programma", () => {
    const turni = utente(["scheduling"]);
    expect(verifica("/gtfs/feeds", turni)).toBe("passa");
    expect(verifica("/gtfs/stops/all", turni)).toBe("passa");
    expect(verifica("/settings/company-cars", turni)).toBe("passa");
    expect(verifica("/planning-studio/projects", turni)).toBe("passa");
    expect(verifica(`/planning-studio/projects/${UUID}`, turni)).toBe("passa");
    expect(verifica(`/planning-studio/projects/${UUID}/validity-units/${UUID2}/detail`, turni)).toBe("passa");
    /* le maiuscole non contano, come per Express */
    expect(verifica(`/Planning-Studio/projects/${UUID.toUpperCase()}`, turni)).toBe("passa");
  });

  it("solo in lettura: le scritture restano al modulo che possiede i dati", () => {
    const turni = utente(["scheduling"]);
    expect(verifica("/gtfs/feeds", turni, "DELETE")).toBe(403);
    expect(verifica("/gtfs/feeds/abc", turni)).toBe(403);
    expect(verifica("/settings/company-cars", turni, "PUT")).toBe(403);
    expect(verifica("/planning-studio/projects", turni, "POST")).toBe(403);
    expect(verifica(`/planning-studio/projects/${UUID}`, turni, "PATCH")).toBe(403);
    expect(verifica(`/planning-studio/projects/${UUID}/trips`, turni)).toBe(403);
    expect(verifica("/settings/timetable-map-domain", turni)).toBe(403);
  });

  it("Tariffe senza Analisi: linee, forme, fermate per linea e confini dei comuni", () => {
    const tariffe = utente(["fares"]);
    for (const p of ["/gtfs/routes", "/gtfs/shapes/geojson", "/gtfs/route-stop-ids", "/territory/comuni-boundaries"]) {
      expect(verifica(p, tariffe), p).toBe("passa");
    }
    expect(verifica("/territory/zones", tariffe)).toBe(403);
    expect(verifica("/gtfs/summary", tariffe)).toBe(403);
  });

  it("Rete e orari senza Analisi: il dominio dei QR e il confronto fra programmi", () => {
    const rete = utente(["network"]);
    expect(verifica("/settings/timetable-map-domain", rete)).toBe("passa");
    expect(verifica("/planning/compare", rete)).toBe("passa");
    expect(verifica("/planning/scenarios", rete)).toBe(403);
    expect(verifica("/settings/timetable-map-domain", rete, "PUT")).toBe(403);
  });

  it("Esercizio senza Analisi: le linee per i Tempi osservati, non il resto degli orari", () => {
    const esercizio = utente(["centrale"]);
    expect(verifica("/timetables/routes", esercizio)).toBe("passa");
    expect(verifica("/timetables", esercizio)).toBe(403);
  });

  it("Analisi legge l'elenco delle zone di coincidenza ma non le modifica", () => {
    const analisi = utente(["analytics"]);
    expect(verifica("/coincidence-zones", analisi)).toBe("passa");
    expect(verifica("/coincidence-zones", analisi, "POST")).toBe(403);
  });

  it("il Database di esercizio è dei Turni (prima bastava essere entrati)", () => {
    expect(verifica("/service-db/overview", utente([]))).toBe(403);
    expect(verifica("/service-db/overview", utente(["scheduling"]))).toBe("passa");
  });
});
