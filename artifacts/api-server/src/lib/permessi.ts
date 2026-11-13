/**
 * I permessi dell'API: i ruoli aziendali, le aree e i livelli stanno nel
 * pacchetto condiviso `@workspace/permessi` (li legge anche la web). Qui c'è
 * solo il passaggio dalla riga di public.users al profilo di un utente.
 *
 * Che cosa si scrive di un utente (migrazione 0009):
 *   ruoli             i ruoli aziendali
 *   accesso_di_prima  gli interruttori di prima dei ruoli ancora accesi
 *   dati_sanitari     vede i codici sanitari del roster
 *   analisi           vede l'area Analisi
 *   depositi          i depositi di cui modifica i conducenti (migrazione 0012)
 *   depositi_visibili i depositi di cui vede i conducenti (migrazione 0016);
 *                     la regola dei due elenchi è in @workspace/permessi
 *                     (limitiSuiDepositi)
 *   permissions       NON è una fonte: è la vista che leggono FleetCare e la
 *                     colonna calcolata mfa_obbligatoria. La scrive l'API da
 *                     quello che c'è sopra (interruttoriCompatibili).
 */
import {
  accessoDiPrimaPulito, accessoDiPrimaRidotto, depositiPuliti, dirittiDi, interruttoriCompatibili, puo, ruoliValidi,
  type Diritti, type Interruttore, type InterruttoreDiPrima, type ProfiloPermessi, type RuoloAziendale,
} from "@workspace/permessi";

import { matriceInVigore } from "./matrice-in-vigore";

export * from "@workspace/permessi";

/** I nomi degli interruttori di prima: restano le chiavi di users.permissions. */
export type Permission = Interruttore;

/** Le colonne di public.users che dicono che cosa può fare un utente. */
export interface RigaPermessi {
  role?: unknown;
  ruoli?: unknown;
  accesso_di_prima?: unknown;
  dati_sanitari?: unknown;
  analisi?: unknown;
  depositi?: unknown;
  depositi_visibili?: unknown;
}

/** Il profilo di un utente dalla sua riga: quello che non è scritto bene non vale. */
export function profiloDaRiga(r: RigaPermessi): ProfiloPermessi & { ruoli: RuoloAziendale[]; accessoDiPrima: Partial<Record<InterruttoreDiPrima, true>>; depositi: string[]; depositiVisibili: string[] } {
  return {
    admin: r.role === "admin",
    ruoli: ruoliValidi(r.ruoli),
    accessoDiPrima: accessoDiPrimaPulito(r.accesso_di_prima),
    datiSanitari: r.dati_sanitari === true,
    analisi: r.analisi === true,
    depositi: depositiPuliti(r.depositi),
    depositiVisibili: depositiPuliti(r.depositi_visibili),
  };
}

/**
 * I diritti e la vista compatibile di un profilo, insieme: si usano sempre in
 * coppia. Si calcolano con la matrice dei ruoli IN VIGORE (quella di partenza
 * con le modifiche dell'amministratore, PR 2.18): chi carica un utente la
 * rilegge prima dal database (lib/matrice-ruoli.ts, matriceFresca).
 */
export function dirittiEVista(p: ProfiloPermessi): { diritti: Diritti; permissions: Record<Permission, boolean> } {
  const diritti = dirittiDi(p, matriceInVigore());
  return { diritti, permissions: interruttoriCompatibili(diritti) };
}

/** Che cosa chiede Gestione utenti sui permessi di un utente (i campi assenti non cambiano). */
export interface RichiestaPermessi {
  /** il ruolo di sistema: "admin" o qualunque altra cosa per "user" */
  role?: unknown;
  ruoli?: RuoloAziendale[];
  datiSanitari?: boolean;
  analisi?: boolean;
  /** gli interruttori di prima da tenere accesi: si possono solo togliere */
  accessoDiPrima?: unknown;
  /** i depositi di cui modifica i conducenti */
  depositi?: string[];
  /** i depositi di cui vede i conducenti (vuoto = tutti) */
  depositiVisibili?: string[];
}

/**
 * Le colonne dei permessi dopo una modifica: lo stato di prima con sopra la
 * richiesta, e la vista permissions ricavata da lì. L'accesso di prima si può
 * solo ridurre: i diritti nuovi si danno con i ruoli. I dati sanitari non
 * restano accesi a chi non può più aprire il roster: una capacità che non si
 * può usare tornerebbe attiva da sola il giorno in cui gli si dà un ruolo col
 * roster, senza che nessuno l'abbia deciso.
 * I depositi invece restano anche a chi perde la scrittura sul roster: sono un
 * limite, non una capacità, e un limite che torna valido da solo non allarga
 * l'accesso di nessuno.
 */
export function permessiDopo(prima: RigaPermessi, richiesta: RichiestaPermessi) {
  const corrente = profiloDaRiga(prima);
  const dopo = {
    role: (richiesta.role !== undefined ? (richiesta.role === "admin" ? "admin" : "user") : corrente.admin ? "admin" : "user") as "admin" | "user",
    ruoli: richiesta.ruoli !== undefined ? ruoliValidi(richiesta.ruoli) : corrente.ruoli,
    accesso_di_prima: richiesta.accessoDiPrima !== undefined
      ? accessoDiPrimaRidotto(corrente.accessoDiPrima, richiesta.accessoDiPrima) : corrente.accessoDiPrima,
    dati_sanitari: richiesta.datiSanitari ?? corrente.datiSanitari,
    analisi: richiesta.analisi ?? corrente.analisi,
    depositi: richiesta.depositi !== undefined ? depositiPuliti(richiesta.depositi) : corrente.depositi,
    depositi_visibili: richiesta.depositiVisibili !== undefined ? depositiPuliti(richiesta.depositiVisibili) : corrente.depositiVisibili,
  };
  /* dove si è scelto che cosa far vedere, quello che si modifica sta fra quello che si vede:
   * un deposito da modificare che manca fra i visibili ci entra (lib/permessi, limitiSuiDepositi) */
  if (dopo.depositi_visibili.length) {
    dopo.depositi_visibili = depositiPuliti([...dopo.depositi_visibili, ...dopo.depositi]);
  }
  const { diritti, permissions } = dirittiEVista(profiloDaRiga(dopo));
  if (dopo.role !== "admin" && !puo(diritti, "roster", "L")) dopo.dati_sanitari = false;
  return { ...dopo, permissions };
}
