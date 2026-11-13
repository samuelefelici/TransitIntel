/**
 * Che cosa ha cambiato l'admin sull'accesso di un utente, per il registro
 * degli accessi (accessi_log). Funzione pura: le rotte di Gestione Utenti
 * (lib/auth.ts) leggono la riga prima e dopo e registrano un esito per azione,
 * nella forma `admin:<azione> (<email dell'admin>)`.
 *
 * Minimizzazione: del nome si scrive solo che è cambiato, mai il valore; dei
 * permessi solo i nomi dei ruoli e degli interruttori. Password e segreti non
 * entrano mai. La colonna permissions non si guarda: è la vista che l'API
 * ricava dai ruoli, e cambia solo insieme a loro.
 */

export interface StatoUtente {
  role?: string | null;
  /** i ruoli aziendali */
  ruoli?: readonly string[] | null;
  /** gli interruttori di prima dei ruoli ancora accesi */
  accesso_di_prima?: Record<string, unknown> | null;
  dati_sanitari?: boolean | null;
  analisi?: boolean | null;
  /** i depositi di cui modifica i conducenti */
  depositi?: readonly string[] | null;
  /** i depositi di cui vede i conducenti */
  depositi_visibili?: readonly string[] | null;
  fleetcare_role?: string | null;
  full_name?: string | null;
  active?: boolean | null;
}

export interface Richiesta {
  password?: boolean;
  resetMfa?: boolean;
  sblocca?: boolean;
}

const accesi = (p: StatoUtente["accesso_di_prima"]): Set<string> =>
  new Set(Object.entries(p ?? {}).filter(([, v]) => v === true).map(([k]) => k));
const ruoliDi = (u: StatoUtente): Set<string> => new Set((u.ruoli ?? []).filter((r) => typeof r === "string"));
const depositiDi = (u: StatoUtente): Set<string> => new Set((u.depositi ?? []).filter((d) => typeof d === "string"));
const visibiliDi = (u: StatoUtente): Set<string> => new Set((u.depositi_visibili ?? []).filter((d) => typeof d === "string"));
const differenze = (prima: Set<string>, dopo: Set<string>): string[] => [
  ...[...dopo].filter((m) => !prima.has(m)).sort().map((m) => `+${m}`),
  ...[...prima].filter((m) => !dopo.has(m)).sort().map((m) => `-${m}`),
];

/** Le azioni, senza il prefisso `admin:` e senza l'email dell'admin. */
export function azioniAdmin(prima: StatoUtente | null, dopo: StatoUtente | null, richiesta: Richiesta = {}): string[] {
  if (!prima && dopo) {
    const dati = [...ruoliDi(dopo)].sort();
    if (dopo.dati_sanitari === true) dati.push("+dati_sanitari");
    if (dopo.analisi === true) dati.push("+analisi");
    for (const d of [...depositiDi(dopo)].sort()) dati.push(`deposito:${d}`);
    for (const d of [...visibiliDi(dopo)].sort()) dati.push(`vede:${d}`);
    return [`utente_creato ${dopo.role === "admin" ? "admin" : "user"}${dati.length ? ` ${dati.join(",")}` : ""}`];
  }
  if (prima && !dopo) return ["utente_eliminato"];
  if (!prima || !dopo) return [];

  const azioni: string[] = [];
  if ((prima.role ?? "user") !== (dopo.role ?? "user")) azioni.push(`ruolo_cambiato ${prima.role ?? "user"}→${dopo.role ?? "user"}`);
  const ruoli = differenze(ruoliDi(prima), ruoliDi(dopo));
  if (ruoli.length) azioni.push(`ruoli_aziendali_cambiati ${ruoli.join(" ")}`);
  const diPrima = differenze(accesi(prima.accesso_di_prima), accesi(dopo.accesso_di_prima));
  if (diPrima.length) azioni.push(`accesso_di_prima_cambiato ${diPrima.join(" ")}`);
  if ((prima.dati_sanitari === true) !== (dopo.dati_sanitari === true)) azioni.push(dopo.dati_sanitari === true ? "dati_sanitari_dati" : "dati_sanitari_tolti");
  if ((prima.analisi === true) !== (dopo.analisi === true)) azioni.push(dopo.analisi === true ? "analisi_data" : "analisi_tolta");
  /* i depositi sono codici del catalogo, non dati di persone: si scrivono */
  const depositi = differenze(depositiDi(prima), depositiDi(dopo));
  if (depositi.length) azioni.push(`depositi_cambiati ${depositi.join(" ")}`);
  const visibili = differenze(visibiliDi(prima), visibiliDi(dopo));
  if (visibili.length) azioni.push(`depositi_visibili_cambiati ${visibili.join(" ")}`);
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
