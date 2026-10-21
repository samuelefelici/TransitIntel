/**
 * I permessi per utente: i moduli del menu (spa/lib/navigazione.ts).
 *
 *   network    = Rete e orari (Planning Studio, confronto programmi, orari al pubblico)
 *   scheduling = Turni (progetti di esercizio, pubblicazione dei turni al roster)
 *   roster     = Roster del personale, con i codici sanitari
 *   personale  = Anagrafica completa del personale
 *   centrale   = Esercizio (Mappa live, AVM)
 *   fares      = Tariffe
 *   fleetcare  = Flotta (FleetCare)
 *   analytics  = Analisi (mappa del territorio, traffico, domanda, linee GTFS,
 *                ipotesi di linea, dati GTFS). Spenta per i nuovi utenti: le
 *                letture che servono anche ai moduli sopra stanno in
 *                LETTURE_CONDIVISE (auth.ts), non qui.
 *
 * Un permesso nuovo si aggiunge qui, nel DEFAULT della colonna (auth.ts e una
 * migrazione), nel `Permission` della SPA (hooks/use-auth.tsx) e in Gestione
 * Utenti (pages/admin-users.tsx).
 */
export const PERMESSI = ["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale", "roster"] as const;
export type Permission = typeof PERMESSI[number];

/** Con che cosa parte un utente nuovo, se l'admin non dice altro. */
export const PERMESSI_NUOVO_UTENTE: Readonly<Record<Permission, boolean>> = {
  analytics: false, fares: true, scheduling: true, network: true,
  fleetcare: false, centrale: false, personale: false, roster: false,
};

/**
 * I permessi come si salvano: tutte le chiavi, solo booleani, niente chiavi
 * sconosciute. Per un utente nuovo la chiave che manca prende il default;
 * in modifica la chiave che manca è spenta (Gestione Utenti manda sempre
 * l'oggetto intero). Rete e orari porta con sé i Turni: Planning Studio e
 * Scheduling lavorano sugli stessi dati (rete, depositi, nodi, archi), e chi
 * ha il primo senza il secondo vedrebbe divergere l'accesso ai dati condivisi.
 */
export function normalizzaPermessi(input: unknown, o: { nuovo: boolean }): Record<Permission, boolean> {
  const dato = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const out = {} as Record<Permission, boolean>;
  for (const p of PERMESSI) {
    out[p] = p in dato ? dato[p] === true : o.nuovo ? PERMESSI_NUOVO_UTENTE[p] : false;
  }
  if (out.network) out.scheduling = true;
  return out;
}
