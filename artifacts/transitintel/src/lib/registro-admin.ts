import { NOMI_PERMESSI } from "./navigazione";

/**
 * Le voci che l'admin lascia nel registro degli accessi, scritte dal server
 * come `admin:<azione>[ <dettaglio>] (<email dell'admin>)` (api-server,
 * lib/azioni-admin.ts), lette in italiano. Null se la voce non è dell'admin.
 */
const AZIONI: Record<string, string> = {
  password_provvisoria: "password provvisoria",
  verifica_tolta: "verifica tolta",
  sbloccato: "sbloccato",
  disattivato: "disattivato",
  riattivato: "riattivato",
  utente_creato: "utente creato",
  utente_eliminato: "utente eliminato",
  ruolo_cambiato: "ruolo cambiato",
  permessi_cambiati: "permessi cambiati",
  ruolo_fleetcare_cambiato: "ruolo FleetCare cambiato",
  nome_cambiato: "nome cambiato",
};

const modulo = (m: string) => (NOMI_PERMESSI as Record<string, string>)[m] ?? m;

function dettaglio(azione: string, d: string): string {
  if (azione === "permessi_cambiati") {
    /* «+centrale -fares» → «+ Esercizio, − Tariffe» */
    return d.split(" ").filter(Boolean)
      .map((t) => `${t.startsWith("-") ? "−" : "+"} ${modulo(t.slice(1))}`).join(", ");
  }
  if (azione === "utente_creato") {
    /* «user fares,scheduling» → «utente; Tariffe, Turni» */
    const [ruolo, moduli] = d.split(" ");
    const r = ruolo === "admin" ? "admin" : "utente";
    return moduli ? `${r}; ${moduli.split(",").map(modulo).join(", ")}` : r;
  }
  return d.replace("→", " → ");
}

export function voceAdminLeggibile(esito: string): string | null {
  const m = /^admin:([a-z_]+)(?: (.+?))? \(([^()]*)\)$/.exec(esito);
  if (!m) return null;
  const [, azione, dett, admin] = m;
  const nome = AZIONI[azione!] ?? azione!;
  return `${nome}${dett ? ` (${dettaglio(azione!, dett)})` : ""}, dall'admin ${admin}`;
}
