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

import { richiedeDiritto, requirePermissionByPath, scriveDatiPersonali, vedeCodiciSanitari, vedeDatiPersonali, type AuthUser, type Permission } from "../lib/auth";
import { utenteDiProva } from "./helpers/app-di-prova";
import type { RuoloAziendale } from "@workspace/permessi";

/* Chi aveva gli interruttori di prima dei ruoli: sono il suo «accesso di prima»
 * (migrazione 0009). Tutto quello che questo file provava prima dei ruoli deve
 * valere uguale: il giorno del rilascio nessuno cambia accesso. */
function utente(attivi: Permission[], role: "admin" | "user" = "user"): AuthUser {
  return utenteDiProva("u", attivi, role);
}

/** Un utente che ha solo ruoli aziendali. */
function conRuoli(ruoli: RuoloAziendale[], extra: { datiSanitari?: boolean; analisi?: boolean } = {}): AuthUser {
  return utenteDiProva("r", [], "user", { ruoli, ...extra });
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

  it("l'andamento AVM e le richieste a Mizar: solo con Centrale, anche per scrivere", () => {
    expect(verifica("/siri/parco/storia", soloCentrale)).toBe("passa");
    expect(verifica("/siri/parco/richieste", soloCentrale, "POST")).toBe("passa");
    expect(verifica("/siri/parco/richieste/chiudi", soloCentrale, "POST")).toBe("passa");
    expect(verifica("/siri/parco/storia", soloAnalytics)).toBe(403);
    expect(verifica("/siri/parco/richieste", soloAnalytics, "POST")).toBe(403);
    expect(verifica("/siri/parco/richieste", nessuno, "POST")).toBe(403);
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

  it("senza permessi: niente Mappa, né parco, né le paline Mizar della pagina Dati", () => {
    expect(verifica("/operations/live", nessuno)).toBe(403);
    expect(verifica("/siri/parco", nessuno)).toBe(403);
    expect(verifica("/siri/fermate/abbinamenti", nessuno)).toBe(403);
    expect(verifica("/siri/status", nessuno)).toBe(403);
  });

  it("le paline Mizar e la diagnostica SIRI: la pagina Dati, cioè Analisi o Centrale", () => {
    expect(verifica("/siri/fermate/abbinamenti", soloCentrale)).toBe("passa");
    expect(verifica("/siri/status", soloAnalytics)).toBe("passa");
    expect(verifica("/siri/fermate/suggerisci/123", soloAnalytics, "POST")).toBe("passa");
    expect(verifica("/siri/status", utente(["fares"]))).toBe(403);
  });

  it("l'admin passa ovunque anche con tutti i permessi spenti", () => {
    const admin = utente([], "admin");
    expect(verifica("/operations/live", admin)).toBe("passa");
    expect(verifica("/siri/parco/settimana", admin)).toBe("passa");
    expect(verifica("/fares/x", admin)).toBe("passa");
  });

  it("il prefisso non cattura nomi che iniziano allo stesso modo", () => {
    /* /siri/parco non deve coprire un ipotetico /siri/parcometri: lo copre /siri */
    expect(verifica("/siri/parcometri", soloAnalytics)).toBe("passa");
    expect(verifica("/siri/parco", soloAnalytics)).toBe(403);
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
    richiedeDiritto("personale")({ user: utente([], "admin"), authVia: "argos", method: "GET" } as any, res as any, () => { codice = "passa"; });
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

  it("il Database di esercizio non c'è più (PR 2.13b): il suo percorso non ha un permesso, quindi è negato a chi non è admin", () => {
    expect(verifica("/service-db/overview", utente([]))).toBe(403);
    expect(verifica("/service-db/overview", utente(["scheduling"]))).toBe(403);
  });
});


describe("deny by default: un percorso senza voce è solo dell'admin", () => {
  const tutti = utente(["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale", "roster"]);

  it("un prefisso che nessuna voce copre dà 403 anche con tutti i permessi", () => {
    expect(verifica("/nuova-rotta", tutti)).toBe(403);
    expect(verifica("/admin/sync/status", tutti)).toBe(403);
    expect(verifica("/ADMIN/SYNC", tutti)).toBe(403);
    expect(verifica("/intermodalita", tutti, "POST")).toBe(403);
  });

  it("l'admin passa anche lì", () => {
    expect(verifica("/nuova-rotta", utente([], "admin"))).toBe("passa");
    expect(verifica("/admin/sync/status", utente([], "admin"))).toBe("passa");
  });

  it("Argos vive dentro Planning Studio: serve «network»", () => {
    expect(verifica("/ai/argos/chat", utente(["network"]), "POST")).toBe("passa");
    expect(verifica("/ai/argos/territory/around", utente(["network"]))).toBe("passa");
    expect(verifica("/ai/argos/context", utente(["scheduling", "analytics"]))).toBe(403);
    expect(verifica("/ai/argos/territory/search", utente(["fares"]))).toBe(403);
  });

  it("la Fucina: regole salvate e analisi intermodale con «scheduling»", () => {
    expect(verifica("/optimizer-rule-profiles", utente(["scheduling"]))).toBe("passa");
    expect(verifica("/optimizer-rule-profiles/resolve", utente(["scheduling"]))).toBe("passa");
    expect(verifica("/intermodal-optimizer/analyze", utente(["scheduling"]), "POST")).toBe("passa");
    expect(verifica("/intermodal-optimizer/analyze", utente(["network"]), "POST")).toBe(403);
    expect(verifica("/optimizer-rule-profiles", utente(["network"]))).toBe(403);
  });

  it("/intermodal non copre /intermodal-optimizer (il prefisso vuole la barra)", () => {
    expect(verifica("/intermodal/lines", utente(["network"]))).toBe("passa");
    expect(verifica("/intermodal-optimizer/analyze", utente(["network"]), "POST")).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * I RUOLI AZIENDALI: lettura e scrittura per area (analisi § 3.5)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("ruoli aziendali: chi legge e chi scrive", () => {
  const pianificatore = conRuoli(["pianificatore"]);
  const ufficioTurni = conRuoli(["ufficio_turni"]);
  const capoDeposito = conRuoli(["capo_deposito"]);
  const centrale = conRuoli(["centrale_operativa"]);
  const officina = conRuoli(["officina"]);
  const amministrazione = conRuoli(["amministrazione"]);
  const tutti = [pianificatore, ufficioTurni, capoDeposito, centrale, officina, amministrazione];
  const PROGETTO = "/planning-studio/projects/11111111-1111-4111-8111-111111111111";

  it("il Pianificatore scrive la rete e legge i turni", () => {
    expect(verifica(`${PROGETTO}/lines`, pianificatore)).toBe("passa");
    expect(verifica(`${PROGETTO}/lines`, pianificatore, "POST")).toBe("passa");
    expect(verifica(`${PROGETTO}/trips/abc`, pianificatore, "DELETE")).toBe("passa");
    expect(verifica("/service-program/scenarios", pianificatore)).toBe("passa");
    expect(verifica("/service-program/cpsat", pianificatore, "POST")).toBe(403);
    expect(verifica("/driver-shifts/abc/scenarios", pianificatore, "POST")).toBe(403);
    expect(verifica("/roster/drivers", pianificatore)).toBe(403);
    expect(verifica("/fares/products", pianificatore)).toBe("passa");
    expect(verifica("/fares/products", pianificatore, "POST")).toBe(403);
  });

  it("l'Ufficio turni scrive i turni e li pubblica, legge la rete e il tabellone", () => {
    expect(verifica("/service-program/cpsat", ufficioTurni, "POST")).toBe("passa");
    expect(verifica("/driver-shifts/abc/cpsat/async", ufficioTurni, "POST")).toBe("passa");
    expect(verifica("/roster/pubblicazioni", ufficioTurni, "POST")).toBe("passa");
    expect(verifica(`${PROGETTO}/lines`, ufficioTurni)).toBe("passa");
    expect(verifica(`${PROGETTO}/lines`, ufficioTurni, "POST")).toBe(403);
    expect(verifica("/roster/board", ufficioTurni)).toBe("passa");
    expect(verifica("/roster/assignments", ufficioTurni, "POST")).toBe(403);
    expect(verifica("/fares/products", ufficioTurni)).toBe(403);
  });

  it("il Capo deposito scrive il tabellone e legge il resto", () => {
    expect(verifica("/roster/assignments", capoDeposito, "POST")).toBe("passa");
    expect(verifica("/roster/entries/abc", capoDeposito, "DELETE")).toBe("passa");
    expect(verifica("/roster/drivers", capoDeposito)).toBe("passa");
    expect(verifica("/roster/history/abc", capoDeposito, "DELETE")).toBe(403);
    expect(verifica("/roster/anagrafica/import/leggi", capoDeposito, "POST")).toBe(403);
    expect(verifica("/roster/pubblicazioni", capoDeposito)).toBe("passa");
    expect(verifica("/roster/pubblicazioni", capoDeposito, "POST")).toBe(403);
    expect(verifica("/service-program/cpsat", capoDeposito, "POST")).toBe(403);
    expect(verifica("/operations/live", capoDeposito)).toBe("passa");
  });

  it("la Centrale operativa scrive l'esercizio e legge rete, turni e tabellone", () => {
    expect(verifica("/siri/parco/richieste", centrale, "POST")).toBe("passa");
    expect(verifica("/operations/live", centrale)).toBe("passa");
    expect(verifica("/roster/board", centrale)).toBe("passa");
    expect(verifica("/roster/assignments", centrale, "POST")).toBe(403);
    expect(verifica(`${PROGETTO}/lines`, centrale, "PATCH")).toBe(403);
  });

  it("l'Officina legge l'esercizio e nient'altro", () => {
    expect(verifica("/operations/live", officina)).toBe("passa");
    expect(verifica("/siri/parco", officina)).toBe("passa");
    expect(verifica("/siri/parco/richieste", officina, "POST")).toBe(403);
    expect(verifica(`${PROGETTO}/lines`, officina)).toBe(403);
    expect(verifica("/service-program/scenarios", officina)).toBe(403);
    expect(verifica("/roster/board", officina)).toBe(403);
    expect(verifica("/fares/products", officina)).toBe(403);
  });

  it("l'Amministrazione scrive il personale e le tariffe, non il tabellone", () => {
    expect(verifica("/roster/drivers/abc", amministrazione, "PATCH")).toBe("passa");
    expect(verifica("/roster/anagrafica/import/leggi", amministrazione, "POST")).toBe("passa");
    expect(verifica("/roster/history/abc", amministrazione, "DELETE")).toBe("passa");
    expect(verifica("/fares/products", amministrazione, "POST")).toBe("passa");
    expect(verifica("/roster/board", amministrazione)).toBe("passa");
    expect(verifica("/roster/assignments", amministrazione, "POST")).toBe(403);
    expect(verifica("/service-program/cpsat", amministrazione, "POST")).toBe(403);
  });

  it("nessun ruolo apre l'Analisi, l'amministrazione di sistema o un percorso senza voce", () => {
    for (const u of tutti) {
      expect(verifica("/traffic/stats", u)).toBe(403);
      expect(verifica("/gtfs/feeds/activate", u, "POST")).toBe(403);
      expect(verifica("/admin/sync/gtfs", u, "POST")).toBe(403);
      expect(verifica("/admin/registro", u)).toBe(403);
      expect(verifica("/qualcosa-di-nuovo", u)).toBe(403);
    }
  });

  it("l'Analisi è una capacità a parte", () => {
    expect(verifica("/traffic/stats", conRuoli(["pianificatore"], { analisi: true }))).toBe("passa");
    expect(verifica("/traffic/stats", conRuoli([], { analisi: true }))).toBe("passa");
    expect(verifica(`${PROGETTO}/lines`, conRuoli([], { analisi: true }))).toBe(403);
  });

  it("con due ruoli vale il diritto più alto", () => {
    const due = conRuoli(["pianificatore", "ufficio_turni"]);
    expect(verifica(`${PROGETTO}/lines`, due, "POST")).toBe("passa");
    expect(verifica("/service-program/cpsat", due, "POST")).toBe("passa");
    expect(verifica("/roster/assignments", due, "POST")).toBe(403);
  });

  it("chi legge soltanto può fare i calcoli che non scrivono, e solo quelli", () => {
    expect(verifica("/driver-shifts/tools/validate", pianificatore, "POST")).toBe("passa");
    expect(verifica("/clusters/by-routes", ufficioTurni, "POST")).toBe("passa");
    expect(verifica("/fares/simulate", pianificatore, "POST")).toBe("passa");
    expect(verifica("/roster/pubblicazioni/anteprima", capoDeposito, "POST")).toBe("passa");
    expect(verifica("/ai/argos/chat", ufficioTurni, "POST")).toBe("passa");
    // ma non con un altro metodo, né sotto un percorso più lungo, né senza l'area
    expect(verifica("/driver-shifts/tools/validate", pianificatore, "PUT")).toBe(403);
    expect(verifica("/driver-shifts/tools/validate/altro", pianificatore, "POST")).toBe(403);
    expect(verifica("/driver-shifts/tools/validate", officina, "POST")).toBe(403);
    expect(verifica("/fares/simulate", ufficioTurni, "POST")).toBe(403);
    expect(verifica("/ai/argos/agent/goals", ufficioTurni, "POST")).toBe(403);
  });

  it("una maiuscola nel percorso non trasforma una scrittura in un calcolo, né salta il controllo", () => {
    expect(verifica("/Driver-Shifts/Tools/Validate", pianificatore, "POST")).toBe("passa");
    expect(verifica("/SERVICE-PROGRAM/CPSAT", pianificatore, "POST")).toBe(403);
    expect(verifica("/Roster/Assignments", ufficioTurni, "POST")).toBe(403);
  });

  it("il messaggio dice «sola lettura» a chi può leggere e non scrivere", () => {
    const messaggio = (path: string, user: AuthUser, method: string): string => {
      let detto = "";
      const res = { status() { return this; }, json(b: any) { detto = b.error; return this; } };
      requirePermissionByPath({ user, path, method } as any, res as any, () => { detto = "passa"; });
      return detto;
    };
    expect(messaggio("/service-program/cpsat", pianificatore, "POST")).toBe("Sola lettura: per modificare serve la scrittura su «Turni»");
    expect(messaggio("/service-program/cpsat", officina, "POST")).toBe("Manca l'accesso a «Turni»");
    expect(messaggio("/depots", officina, "GET")).toBe("Manca l'accesso a «Turni» o «Rete e orari»");
  });
});

describe("ruoli aziendali: dati personali e codici sanitari", () => {
  it("i dati personali li vede e li scrive solo l'Amministrazione", () => {
    expect(vedeDatiPersonali({ user: conRuoli(["amministrazione"]) })).toBe(true);
    expect(scriveDatiPersonali({ user: conRuoli(["amministrazione"]) })).toBe(true);
    for (const r of ["pianificatore", "ufficio_turni", "capo_deposito", "centrale_operativa", "officina"] as RuoloAziendale[]) {
      expect(vedeDatiPersonali({ user: conRuoli([r]) }), r).toBe(false);
      expect(scriveDatiPersonali({ user: conRuoli([r]) }), r).toBe(false);
    }
    expect(scriveDatiPersonali({ user: conRuoli(["amministrazione"]), authVia: "argos" })).toBe(false);
  });

  it("chi aveva l'interruttore «personale» li scrive come prima", () => {
    expect(scriveDatiPersonali({ user: utente(["personale"]) })).toBe(true);
    expect(scriveDatiPersonali({ user: utente(["roster"]) })).toBe(false);
  });

  it("i codici sanitari non vengono con nessun ruolo: servono la capacità e il roster", () => {
    expect(vedeCodiciSanitari({ user: conRuoli(["capo_deposito"]) })).toBe(false);
    expect(vedeCodiciSanitari({ user: conRuoli(["capo_deposito"], { datiSanitari: true }) })).toBe(true);
    expect(vedeCodiciSanitari({ user: conRuoli(["amministrazione"], { datiSanitari: true }) })).toBe(true);
    expect(vedeCodiciSanitari({ user: conRuoli(["pianificatore"], { datiSanitari: true }) })).toBe(false);
    expect(vedeCodiciSanitari({ user: conRuoli(["capo_deposito"], { datiSanitari: true }), authVia: "argos" })).toBe(false);
  });

  it("richiedeDiritto: lettura per GET, scrittura per il resto", () => {
    const prova = (user: AuthUser, method: string): number | "passa" => {
      let codice: number | "passa" = "passa";
      const res = { status(c: number) { codice = c; return this; }, json() { return this; } };
      richiedeDiritto("roster")({ user, method } as any, res as any, () => { codice = "passa"; });
      return codice;
    };
    expect(prova(conRuoli(["ufficio_turni"]), "GET")).toBe("passa");
    expect(prova(conRuoli(["ufficio_turni"]), "POST")).toBe(403);
    expect(prova(conRuoli(["capo_deposito"]), "POST")).toBe("passa");
    expect(prova(conRuoli(["officina"]), "GET")).toBe(403);
  });
});
