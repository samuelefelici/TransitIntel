/**
 * Un'app minima per provare un router senza login e senza database: l'utente
 * si inietta, il router risponde sotto /api come nell'app vera. Il login e i
 * permessi per percorso hanno i loro test (auth-permessi.test.ts).
 */
import express, { type Express, type IRouter } from "express";
import { dirittiDi, interruttoriCompatibili, type InterruttoreDiPrima, type RuoloAziendale } from "@workspace/permessi";
import type { AuthUser, Permission } from "../../lib/auth";

/**
 * Un utente di prova. `interruttori` sono gli interruttori di prima dei ruoli:
 * diventano il suo accesso di prima, come fa la migrazione 0009 il giorno del
 * rilascio (chi ha «roster» tiene i dati sanitari, «analytics» è l'Analisi).
 * Con `ruoli` si prova invece un utente che ha solo ruoli aziendali.
 */
export function utenteDiProva(
  id: string, interruttori: Permission[] = [], ruolo: "admin" | "user" = "user",
  extra: { ruoli?: RuoloAziendale[]; datiSanitari?: boolean; analisi?: boolean; depositi?: string[]; depositiVisibili?: string[] } = {},
): AuthUser {
  const accessoDiPrima = Object.fromEntries(interruttori.filter(i => i !== "analytics").map(i => [i, true])) as Partial<Record<InterruttoreDiPrima, true>>;
  const profilo = {
    admin: ruolo === "admin", ruoli: extra.ruoli ?? [], accessoDiPrima,
    analisi: extra.analisi ?? interruttori.includes("analytics"),
    datiSanitari: extra.datiSanitari ?? interruttori.includes("roster"),
  };
  const diritti = dirittiDi(profilo);
  return {
    id, email: `${id}@prova.local`, fullName: null, role: ruolo,
    ruoli: profilo.ruoli, accessoDiPrima, datiSanitari: profilo.datiSanitari, analisi: profilo.analisi,
    depositi: extra.depositi ?? [], depositiVisibili: extra.depositiVisibili ?? [],
    diritti, permissions: interruttoriCompatibili(diritti),
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
