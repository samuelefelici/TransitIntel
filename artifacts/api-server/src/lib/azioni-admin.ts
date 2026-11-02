/**
 * Che cosa ha cambiato l'admin sull'accesso di un utente, per il registro
 * degli accessi (accessi_log). Funzione pura: le rotte di Gestione Utenti
 * (lib/auth.ts) leggono la riga prima e dopo e registrano un esito per azione,
 * nella forma `admin:<azione> (<email dell'admin>)`.
 *
 * Minimizzazione: del nome si scrive solo che è cambiato, mai il valore; dei
 * permessi solo i nomi dei moduli. Password e segreti non entrano mai.
 */

export interface StatoUtente {
  role?: string | null;
  permissions?: Record<string, unknown> | null;
  fleetcare_role?: string | null;
  full_name?: string | null;
  active?: boolean | null;
}

export interface Richiesta {
  password?: boolean;
  resetMfa?: boolean;
  sblocca?: boolean;
}

const moduliAccesi = (p: StatoUtente["permissions"]): Set<string> =>
  new Set(Object.entries(p ?? {}).filter(([, v]) => v === true).map(([k]) => k));

/** Le azioni, senza il prefisso `admin:` e senza l'email dell'admin. */
export function azioniAdmin(prima: StatoUtente | null, dopo: StatoUtente | null, richiesta: Richiesta = {}): string[] {
  if (!prima && dopo) {
    const moduli = [...moduliAccesi(dopo.permissions)].sort();
    return [`utente_creato ${dopo.role === "admin" ? "admin" : "user"}${moduli.length ? ` ${moduli.join(",")}` : ""}`];
  }
  if (prima && !dopo) return ["utente_eliminato"];
  if (!prima || !dopo) return [];

  const azioni: string[] = [];
  if ((prima.role ?? "user") !== (dopo.role ?? "user")) azioni.push(`ruolo_cambiato ${prima.role ?? "user"}→${dopo.role ?? "user"}`);
  const p = moduliAccesi(prima.permissions);
  const d = moduliAccesi(dopo.permissions);
  const aggiunti = [...d].filter((m) => !p.has(m)).sort().map((m) => `+${m}`);
  const tolti = [...p].filter((m) => !d.has(m)).sort().map((m) => `-${m}`);
  if (aggiunti.length || tolti.length) azioni.push(`permessi_cambiati ${[...aggiunti, ...tolti].join(" ")}`);
  if ((prima.fleetcare_role ?? null) !== (dopo.fleetcare_role ?? null)) {
    azioni.push(`ruolo_fleetcare_cambiato ${prima.fleetcare_role ?? "-"}→${dopo.fleetcare_role ?? "-"}`);
  }
  if ((prima.full_name ?? "") !== (dopo.full_name ?? "")) azioni.push("nome_cambiato");
  if (richiesta.password) azioni.push("password_provvisoria");
  if (richiesta.resetMfa) azioni.push("verifica_tolta");
  if (richiesta.sblocca) azioni.push("sbloccato");
  if (prima.active !== false && dopo.active === false) azioni.push("disattivato");
  if (prima.active === false && dopo.active !== false) azioni.push("riattivato");
  return azioni;
}
