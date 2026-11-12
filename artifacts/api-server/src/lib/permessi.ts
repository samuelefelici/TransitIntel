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
 *   permissions       NON è una fonte: è la vista che leggono FleetCare e la
 *                     colonna calcolata mfa_obbligatoria. La scrive l'API da
 *                     quello che c'è sopra (interruttoriCompatibili).
 */
import {
  accessoDiPrimaPulito, accessoDiPrimaRidotto, dirittiDi, interruttoriCompatibili, puo, ruoliValidi,
  type Diritti, type Interruttore, type InterruttoreDiPrima, type ProfiloPermessi, type RuoloAziendale,
} from "@workspace/permessi";

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
}

/** Il profilo di un utente dalla sua riga: quello che non è scritto bene non vale. */
export function profiloDaRiga(r: RigaPermessi): ProfiloPermessi & { ruoli: RuoloAziendale[]; accessoDiPrima: Partial<Record<InterruttoreDiPrima, true>> } {
  return {
    admin: r.role === "admin",
    ruoli: ruoliValidi(r.ruoli),
    accessoDiPrima: accessoDiPrimaPulito(r.accesso_di_prima),
    datiSanitari: r.dati_sanitari === true,
    analisi: r.analisi === true,
  };
}

/** I diritti e la vista compatibile di un profilo, insieme: si usano sempre in coppia. */
export function dirittiEVista(p: ProfiloPermessi): { diritti: Diritti; permissions: Record<Permission, boolean> } {
  const diritti = dirittiDi(p);
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
}

/**
 * Le colonne dei permessi dopo una modifica: lo stato di prima con sopra la
 * richiesta, e la vista permissions ricavata da lì. L'accesso di prima si può
 * solo ridurre: i diritti nuovi si danno con i ruoli. I dati sanitari non
 * restano accesi a chi non può più aprire il roster: una capacità che non si
 * può usare tornerebbe attiva da sola il giorno in cui gli si dà un ruolo col
 * roster, senza che nessuno l'abbia deciso.
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
  };
  const { diritti, permissions } = dirittiEVista(profiloDaRiga(dopo));
  if (dopo.role !== "admin" && !puo(diritti, "roster", "L")) dopo.dati_sanitari = false;
  return { ...dopo, permissions };
}
