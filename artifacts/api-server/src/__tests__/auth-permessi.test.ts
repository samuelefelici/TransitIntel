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

import { requirePermissionByPath, type AuthUser, type Permission } from "../lib/auth";

function utente(attivi: Permission[], role: "admin" | "user" = "user"): AuthUser {
  const permissions = Object.fromEntries(
    (["analytics", "fares", "scheduling", "network", "fleetcare", "centrale"] as Permission[])
      .map(p => [p, attivi.includes(p)]),
  ) as Record<Permission, boolean>;
  return { id: "u", email: "u@x", fullName: null, role, permissions, fleetcareRole: "driver", active: true };
}

/** "passa" se il middleware chiama next, altrimenti il codice HTTP. */
function verifica(path: string, user: AuthUser): "passa" | number {
  let esito: "passa" | number = "passa";
  const res = {
    status(c: number) { esito = c; return this; },
    json() { return this; },
  };
  requirePermissionByPath({ user, path } as any, res as any, () => { esito = "passa"; });
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
