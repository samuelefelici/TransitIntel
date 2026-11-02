/**
 * Deny by default: ogni rotta montata dopo il controllo dei permessi deve
 * avere una voce in lib/auth.ts (PERMISSION_BY_PREFIX o LETTURE_CONDIVISE).
 * Senza voce, chi non è admin prende 403: una rotta nuova dimenticata nella
 * mappa si scopre qui, non in produzione.
 *
 * E i router prima del login sono un elenco chiuso: una rotta pubblica nuova
 * va scelta apposta, non per errore di posizione in routes/index.ts.
 */
import { describe, it, expect, vi } from "vitest";

/* nessun database: qui si guarda solo come sono montate le rotte */
vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(async () => ({ rows: [] })) },
  pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() },
}));

import router from "../routes";
import { requireAuth, requirePermissionByPath, permessoPerPercorso } from "../lib/auth";
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

/** Prefissi solo per l'admin, voluti: si proteggono anche da sé con requireAdmin. */
const SOLO_ADMIN = ["/admin/sync"];

type Strato = { handle: any; route?: { path: string | string[]; methods: Record<string, boolean> } };
const strati = (r: any): Strato[] => r.stack as Strato[];

/** Le rotte (metodo, percorso) di un router e dei suoi sotto-router montati senza prefisso. */
function rotte(r: any): { metodo: string; percorso: string }[] {
  const out: { metodo: string; percorso: string }[] = [];
  for (const s of strati(r)) {
    if (s.route) {
      const percorsi = Array.isArray(s.route.path) ? s.route.path : [s.route.path];
      for (const p of percorsi) for (const m of Object.keys(s.route.methods)) out.push({ metodo: m.toUpperCase(), percorso: p });
    } else if (Array.isArray(s.handle?.stack)) {
      out.push(...rotte(s.handle));
    }
  }
  return out;
}

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
      healthRouter, authRouter, accountRouter, cronRouter, argosWatchCronRouter, weatherCronRouter,
      caronteRouter, gtfsRtRouter, networkShareRouter, timetableMapShareRouter,
    ];
    const prima = pila.slice(0, posAuth).map((s) => s.handle);
    expect(prima).toHaveLength(attesi.length);
    for (const r of attesi) expect(prima).toContain(r);
  });

  it("ogni rotta dopo il controllo dei permessi ha una voce in lib/auth.ts", () => {
    const tutte = pila.slice(posPermessi + 1).flatMap((s) => (s.route ? rotte({ stack: [s] }) : rotte(s.handle ?? {})));
    expect(tutte.length).toBeGreaterThan(500);
    const scoperte = tutte.filter(({ metodo, percorso }) => {
      const p = percorso.toLowerCase();
      if (SOLO_ADMIN.some((a) => p === a || p.startsWith(a + "/"))) return false;
      const { condivisa, prefisso } = permessoPerPercorso(metodo, percorso);
      return !condivisa && !prefisso;
    });
    expect(scoperte.map((r) => `${r.metodo} ${r.percorso}`)).toEqual([]);
  });

  it("la cron del meteo sta prima del login: si protegge col segreto", () => {
    expect(rotte(weatherCronRouter)).toEqual([{ metodo: "POST", percorso: "/cron/weather" }]);
  });
});
