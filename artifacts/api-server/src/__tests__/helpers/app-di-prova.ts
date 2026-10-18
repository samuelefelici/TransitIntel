/**
 * Un'app minima per provare un router senza login e senza database: l'utente
 * si inietta, il router risponde sotto /api come nell'app vera. Il login e i
 * permessi per percorso hanno i loro test (auth-permessi.test.ts).
 */
import express, { type Express, type IRouter } from "express";
import type { AuthUser, Permission } from "../../lib/auth";

const PERMESSI: Permission[] = ["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale"];

export function utenteDiProva(id: string, permessi: Permission[] = [], ruolo: "admin" | "user" = "user"): AuthUser {
  return {
    id, email: `${id}@prova.local`, fullName: null, role: ruolo,
    permissions: Object.fromEntries(PERMESSI.map(p => [p, permessi.includes(p)])) as Record<Permission, boolean>,
    fleetcareRole: "driver", active: true,
  };
}

/* gli handler scrivono su req.log (pino-http nell'app vera): qui si tace */
const logMuto: any = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logMuto; } };

export function appDiProva(router: IRouter, utente: AuthUser | null): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = logMuto;
    if (utente) req.user = utente;
    next();
  });
  app.use("/api", router);
  return app;
}
