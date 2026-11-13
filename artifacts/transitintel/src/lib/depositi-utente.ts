/**
 * I depositi di un utente nella finestra di Utenti e accessi (PR 2.14c e
 * 2.14d): per ogni deposito l'amministratore sceglie se la persona MODIFICA i
 * conducenti, li VEDE soltanto, o NON li vede. La regola che conta è nell'API
 * e in @workspace/permessi (limitiSuiDepositi); qui c'è il modulo, in funzioni
 * pure.
 *
 * Nel database sono due elenchi di codici:
 *   depositiVisibili  quelli che vede; vuoto = li vede tutti
 *   depositi          quelli che modifica; senza visibili, vuoto = tutti
 * «Vuoto = tutti» non si può mostrare con tre scelte per deposito: per questo
 * il modulo ha un interruttore in testa («vede tutti i depositi»), e solo con
 * l'interruttore spento le tre scelte.
 */

export type SceltaDeposito = "niente" | "vede" | "modifica";

export interface DepositiScelti {
  /** l'interruttore: vede i conducenti di tutti i depositi */
  vedeTutti: boolean;
  /** i depositi che modifica */
  depositi: string[];
  /** i depositi che vede (conta solo con l'interruttore spento) */
  depositiVisibili: string[];
}

/** Lo stato del modulo da quello che ha l'utente. */
export function depositiDellUtente(u: { depositi?: readonly string[] | null; depositiVisibili?: readonly string[] | null }): DepositiScelti {
  const depositi = [...(u.depositi ?? [])];
  const visibili = [...(u.depositiVisibili ?? [])];
  return { vedeTutti: visibili.length === 0, depositi, depositiVisibili: [...visibili, ...depositi.filter(c => !visibili.includes(c))].filter(() => visibili.length > 0) };
}

/** La scelta su un deposito, con l'interruttore spento. */
export function sceltaSul(s: DepositiScelti, codice: string): SceltaDeposito {
  if (s.depositi.includes(codice)) return "modifica";
  return s.depositiVisibili.includes(codice) ? "vede" : "niente";
}

/** Cambia la scelta su un deposito (interruttore spento). */
export function conScelta(s: DepositiScelti, codice: string, scelta: SceltaDeposito): DepositiScelti {
  const senza = (l: string[]) => l.filter(c => c !== codice);
  return {
    ...s,
    depositi: scelta === "modifica" ? [...senza(s.depositi), codice] : senza(s.depositi),
    depositiVisibili: scelta === "niente" ? senza(s.depositiVisibili) : [...senza(s.depositiVisibili), codice],
  };
}

/** Accende o spegne «modifica» su un deposito con l'interruttore acceso (li vede tutti): com'era con la 2.14c. */
export function conModifica(s: DepositiScelti, codice: string, acceso: boolean): DepositiScelti {
  const senza = s.depositi.filter(c => c !== codice);
  return { ...s, depositi: acceso ? [...senza, codice] : senza };
}

/**
 * Accende o spegne l'interruttore senza cambiare quello che la persona può
 * fare in quel momento: l'amministratore parte da lì e toglie.
 * - spegnendolo: tutti i depositi del catalogo restano visibili, e quelli che
 *   modificava restano da modificare (se li modificava tutti, tutti);
 * - riaccendendolo: li vede di nuovo tutti; se li modificava tutti torna
 *   «nessun limite».
 */
export function conInterruttore(s: DepositiScelti, vedeTutti: boolean, catalogo: readonly string[], scriveIlRoster: boolean): DepositiScelti {
  if (vedeTutti === s.vedeTutti) return s;
  if (!vedeTutti) {
    const modifica = !scriveIlRoster ? [] : s.depositi.length ? s.depositi : [...catalogo];
    return { vedeTutti: false, depositi: modifica, depositiVisibili: [...catalogo, ...modifica.filter(c => !catalogo.includes(c))] };
  }
  const tutti = catalogo.length > 0 && catalogo.every(c => s.depositi.includes(c));
  return { vedeTutti: true, depositi: tutti ? [] : s.depositi, depositiVisibili: [] };
}

/**
 * Perché il modulo non si può salvare, o `null`. Con l'interruttore spento
 * serve almeno un deposito da far vedere: nessuno, nel database, vorrebbe dire
 * «li vede tutti», il contrario di quello che l'amministratore ha scelto.
 */
export function erroreDepositi(s: DepositiScelti): string | null {
  if (s.vedeTutti) return null;
  return s.depositiVisibili.length === 0 ? "Scegli almeno un deposito da far vedere, oppure riaccendi «Vede tutti i depositi»" : null;
}

/** I due elenchi da mandare all'API. */
export function elenchiDaSalvare(s: DepositiScelti): { depositi: string[]; depositiVisibili: string[] } {
  if (s.vedeTutti) return { depositi: [...s.depositi], depositiVisibili: [] };
  const visibili = [...s.depositiVisibili, ...s.depositi.filter(c => !s.depositiVisibili.includes(c))];
  return { depositi: [...s.depositi], depositiVisibili: visibili };
}

const elenco = (codici: readonly string[], nome: (c: string) => string) => codici.map(nome).join(", ");

/** Le etichette nella riga dell'utente: che cosa vede e che cosa modifica, o niente se non ha limiti. */
export function depositiInBreve(u: { depositi?: readonly string[] | null; depositiVisibili?: readonly string[] | null }, nome: (c: string) => string): string[] {
  const depositi = u.depositi ?? [], visibili = u.depositiVisibili ?? [];
  if (!visibili.length) return depositi.length ? [`modifica solo: ${elenco(depositi, nome)}`] : [];
  const soloVisti = visibili.filter(c => !depositi.includes(c));
  return [
    depositi.length ? `modifica: ${elenco(depositi, nome)}` : "non modifica nessun deposito",
    ...(soloVisti.length ? [`vede soltanto: ${elenco(soloVisti, nome)}`] : []),
  ];
}
