import { NOMI_RUOLI } from "@workspace/permessi";

/* I nomi degli interruttori di prima dei ruoli: restano nelle voci già scritte nel registro */
const NOMI_INTERRUTTORI: Record<string, string> = {
  network: "Rete e orari", scheduling: "Turni", roster: "Roster", personale: "Personale",
  centrale: "Esercizio", fleetcare: "Flotta", fares: "Tariffe", analytics: "Analisi",
};

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
  ruolo_cambiato: "ruolo di sistema cambiato",
  permessi_cambiati: "permessi cambiati",
  ruoli_aziendali_cambiati: "ruoli aziendali cambiati",
  accesso_di_prima_cambiato: "accesso di prima cambiato",
  dati_sanitari_dati: "dati sanitari: dati",
  dati_sanitari_tolti: "dati sanitari: tolti",
  analisi_data: "Analisi: data",
  analisi_tolta: "Analisi: tolta",
  ruolo_fleetcare_cambiato: "ruolo FleetCare cambiato",
  nome_cambiato: "nome cambiato",
};

/* un interruttore di prima, un ruolo aziendale o una capacità, col suo nome */
const CAPACITA: Record<string, string> = { "+dati_sanitari": "dati sanitari", "+analisi": "Analisi" };
const modulo = (m: string) => NOMI_INTERRUTTORI[m] ?? (NOMI_RUOLI as Record<string, string>)[m] ?? CAPACITA[m] ?? m;

function dettaglio(azione: string, d: string): string {
  if (azione === "permessi_cambiati" || azione === "ruoli_aziendali_cambiati" || azione === "accesso_di_prima_cambiato") {
    /* «+centrale -fares» → «+ Esercizio, − Tariffe»; «+capo_deposito» → «+ Capo deposito» */
    return d.split(" ").filter(Boolean)
      .map((t) => `${t.startsWith("-") ? "−" : "+"} ${modulo(t.slice(1))}`).join(", ");
  }
  if (azione === "utente_creato") {
    /* «user ufficio_turni,+dati_sanitari» → «utente; Ufficio turni, dati sanitari»
     * (prima dei ruoli: «user fares,scheduling» → «utente; Tariffe, Turni») */
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
