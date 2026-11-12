/**
 * Deny by default: ogni rotta montata dopo il controllo dei permessi deve
 * avere una voce in lib/permessi-rotte.ts (AREE_PER_PREFISSO o LETTURE_CONDIVISE).
 * Senza voce, chi non è admin prende 403: una rotta nuova dimenticata nella
 * mappa si scopre qui, non in produzione.
 *
 * E le rotte prima del login sono un elenco chiuso: una rotta pubblica (o
 * che si protegge da sé) nuova va scelta apposta, non per errore di posizione
 * in routes/index.ts. Fra il login e il controllo dei permessi non ci sono
 * rotte; dopo, nessun router montato con un prefisso (il test non lo vedrebbe).
 */
import { describe, it, expect, vi } from "vitest";

/* nessun database: qui si guarda solo come sono montate le rotte */
vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import router from "../routes";
import { requireAdmin, requireAuth, requirePermissionByPath } from "../lib/auth";
import { CALCOLANO_SENZA_SCRIVERE, dirittoPerPercorso, SOLO_ADMIN } from "../lib/permessi-rotte";
import { ensureTenantMiddleware } from "../lib/tenant";
import healthRouter from "../routes/health";
import authRouter from "../lib/auth";
import accountRouter from "../lib/account";
import cronRouter from "../routes/cron";
import { argosWatchCronRouter } from "../routes/argos-watch";
import { weatherCronRouter } from "../routes/weather";
import caronteRouter from "../routes/caronte";
import gtfsRtRouter from "../routes/gtfs-rt";
import networkShareRouter from "../routes/network-share";
import timetableMapShareRouter from "../routes/timetable-map-share";
import { contestoCron } from "../lib/contesto-http";

type Strato = { handle: any; name?: string; slash?: boolean; route?: { path: string | string[]; methods: Record<string, boolean> } };
const strati = (r: any): Strato[] => (Array.isArray(r?.stack) ? r.stack : []) as Strato[];

/**
 * Le rotte (metodo, percorso) di un router e dei suoi sotto-router montati
 * senza prefisso. Express 5 non conserva il percorso di un montaggio
 * (Layer.path resta vuoto): un router o un middleware montato su un percorso
 * (slash = false) finisce fra i «montaggi», perché qui il suo percorso vero
 * non si può calcolare. requireAdmin montato su un percorso è ammesso: chiude.
 */
function rotte(r: any, montaggi: string[] = []): { metodo: string; percorso: string }[] {
  const out: { metodo: string; percorso: string }[] = [];
  for (const s of strati(r)) {
    if (s.route) {
      const percorsi = Array.isArray(s.route.path) ? s.route.path : [s.route.path];
      for (const p of percorsi) for (const m of Object.keys(s.route.methods)) out.push({ metodo: m.toUpperCase(), percorso: String(p) });
    } else if (s.slash === false && s.handle !== requireAdmin) {
      montaggi.push(s.name ?? "?");
    } else if (Array.isArray(s.handle?.stack)) {
      out.push(...rotte(s.handle, montaggi));
    }
  }
  return out;
}

/** Le rotte prima del login: ognuna è pubblica o si protegge da sé (segreto, chiave, requireAuth nella rotta). */
const PRIMA_DEL_LOGIN = [
  "GET /healthz",
  // accesso e account: ogni rotta autenticata controlla da sé chi la chiama
  "POST /auth/login", "POST /auth/login/mfa", "POST /auth/logout", "GET /auth/me", "POST /auth/fleetcare-sso",
  "GET /users/lookup", "GET /admin/users", "POST /admin/users", "PATCH /admin/users/:id", "DELETE /admin/users/:id",
  "GET /admin/ruoli",
  "POST /auth/password", "POST /auth/mfa/attiva", "POST /auth/mfa/conferma", "POST /auth/mfa/disattiva",
  "POST /auth/mfa/codici-recupero", "POST /auth/mfa/reimposta", "POST /auth/sessioni/chiudi", "GET /admin/accessi",
  // cron col segreto
  "POST /cron/traffic", "POST /cron/avm-controllo-settimanale", "POST /cron/intermodal-schedules", "POST /cron/poi",
  "POST /cron/population", "POST /cron/commuting", "POST /cron/argos-mcp-token", "POST /cron/argos-mcp-projects",
  "POST /cron/argos-watch", "POST /cron/weather",
  // condivisioni col token nel link
  "GET /network-share/:token", "GET /timetable-map/:token", "GET /timetable-map/:token/route/:routeId",
  "GET /timetable-map/:token/stop/:stopId",
].sort();

const pila = strati(router);
const posAuth = pila.findIndex((s) => s.handle === requireAuth);
const posPermessi = pila.findIndex((s) => s.handle === requirePermissionByPath);

describe("inventario delle rotte", () => {
  it("il login e poi il controllo dei permessi, in quest'ordine", () => {
    expect(posAuth).toBeGreaterThan(0);
    expect(posPermessi).toBeGreaterThan(posAuth);
  });

  it("prima del login solo i router pubblici voluti", () => {
    const attesi = [
      healthRouter, authRouter, accountRouter, contestoCron, cronRouter, argosWatchCronRouter, weatherCronRouter,
      caronteRouter, gtfsRtRouter, networkShareRouter, timetableMapShareRouter,
    ];
    const prima = pila.slice(0, posAuth).map((s) => s.handle);
    expect(prima).toHaveLength(attesi.length);
    for (const r of attesi) expect(prima).toContain(r);
  });

  it("prima del login le rotte sono un elenco chiuso (Caronte e GTFS-RT a parte: hanno la loro chiave sul router)", () => {
    const conChiave = [caronteRouter, gtfsRtRouter];
    const elenco = pila.slice(0, posAuth).filter((s) => !conChiave.includes(s.handle))
      .flatMap((s) => rotte(s.handle)).map((r) => `${r.metodo} ${r.percorso}`).sort();
    expect(elenco).toEqual(PRIMA_DEL_LOGIN);
  });

  it("fra il login e il controllo dei permessi solo il tenant, nessuna rotta", () => {
    expect(pila.slice(posAuth + 1, posPermessi).map((s) => s.handle)).toEqual([ensureTenantMiddleware]);
  });

  it("dopo il controllo dei permessi nessun montaggio su un percorso (se ne perderebbe il prefisso)", () => {
    const montaggi: string[] = [];
    for (const s of pila.slice(posPermessi + 1)) {
      if (s.route) continue;
      if (s.slash === false && s.handle !== requireAdmin) montaggi.push(s.name ?? "?");
      else rotte(s.handle, montaggi);
    }
    expect(montaggi).toEqual([]);
  });

  it("ogni rotta dopo il controllo dei permessi ha una voce in lib/permessi-rotte.ts", () => {
    const tutte = pila.slice(posPermessi + 1).flatMap((s) => (s.route ? rotte({ stack: [s] }) : rotte(s.handle)));
    expect(tutte.length).toBeGreaterThan(500);
    const scoperte = tutte.filter(({ metodo, percorso }) => {
      const p = percorso.toLowerCase();
      if (SOLO_ADMIN.some((a) => p === a || p.startsWith(a + "/"))) return false;
      const { condivisa, aree } = dirittoPerPercorso(metodo, percorso);
      return !condivisa && !aree;
    });
    expect(scoperte.map((r) => `${r.metodo} ${r.percorso}`)).toEqual([]);
  });

  it("le richieste che «calcolano senza scrivere» sono rotte vere, non GET, e con un'area", () => {
    const tutte = new Set(pila.slice(posPermessi + 1).flatMap((s) => (s.route ? rotte({ stack: [s] }) : rotte(s.handle)))
      .map((r) => `${r.metodo} ${r.percorso.toLowerCase()}`));
    for (const [metodo, percorso] of CALCOLANO_SENZA_SCRIVERE) {
      expect(tutte.has(`${metodo} ${percorso}`), `${metodo} ${percorso}`).toBe(true);
      expect(["GET", "HEAD"]).not.toContain(metodo);
      expect(percorso).toBe(percorso.toLowerCase());
      const d = dirittoPerPercorso(metodo, percorso);
      expect(d.aree, percorso).not.toBeNull();
      expect(d.livello, percorso).toBe("L");
    }
    // e sono poche: l'elenco si allunga solo guardando l'handler
    expect(CALCOLANO_SENZA_SCRIVERE.length).toBeLessThanOrEqual(20);
  });

  it("ogni altra rotta che non è una GET chiede la scrittura", () => {
    const tutte = pila.slice(posPermessi + 1).flatMap((s) => (s.route ? rotte({ stack: [s] }) : rotte(s.handle)));
    const calcoli = new Set(CALCOLANO_SENZA_SCRIVERE.map(([m, p]) => `${m} ${p}`));
    for (const { metodo, percorso } of tutte) {
      const atteso = metodo === "GET" || metodo === "HEAD" || calcoli.has(`${metodo} ${percorso.toLowerCase()}`) ? "L" : "S";
      expect(dirittoPerPercorso(metodo, percorso).livello, `${metodo} ${percorso}`).toBe(atteso);
    }
  });

  it("la cron del meteo sta prima del login: si protegge col segreto", () => {
    expect(rotte(weatherCronRouter)).toEqual([{ metodo: "POST", percorso: "/cron/weather" }]);
  });
});
