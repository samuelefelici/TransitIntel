/* «Sola lettura»: quando l'API rifiuta una modifica a chi può solo leggere.
 *
 * Il rifiuto arriva come 403 con `solaLettura: true` (api-server,
 * lib/permessi-rotte.ts). Tutte le chiamate della web passano da un punto solo
 * (lib/api.ts): lì si riconosce e si annuncia con un evento, così l'avviso è
 * lo stesso in ogni pagina, anche in quelle che di loro direbbero «HTTP 403».
 * Qui c'è solo la logica, senza browser: il riconoscimento e il freno alle
 * ripetizioni (una pagina che salva tre cose non deve dare tre avvisi). */

export const EVENTO_SOLA_LETTURA = "permessi:sola-lettura";

export interface RifiutoSolaLettura {
  /** il messaggio dell'API: dice su quale area serve la scrittura */
  messaggio: string;
}

const MESSAGGIO_DI_RISERVA = "Sola lettura: il tuo ruolo non può modificare questi dati";

/** È un rifiuto di sola lettura? Dal campo, non dal testo. */
export function rifiutoDiSolaLettura(stato: number, corpo: unknown): RifiutoSolaLettura | null {
  if (stato !== 403 || !corpo || typeof corpo !== "object") return null;
  const c = corpo as { solaLettura?: unknown; error?: unknown };
  if (c.solaLettura !== true) return null;
  const testo = typeof c.error === "string" ? c.error.trim().slice(0, 300) : "";
  return { messaggio: testo || MESSAGGIO_DI_RISERVA };
}

/** Il messaggio senza il prefisso, per metterlo sotto il titolo «Sola lettura». */
export function dettaglioSolaLettura(messaggio: string): string {
  const senza = messaggio.replace(/^Sola lettura:\s*/i, "");
  return senza ? senza.charAt(0).toUpperCase() + senza.slice(1) : "";
}

/**
 * Un avviso ogni tanto, non uno per richiesta: lo stesso messaggio entro
 * `ogniMs` non si ripete. Restituisce la funzione che dice se annunciare.
 */
export function frenoAvvisi(ogniMs = 4000): (messaggio: string, adesso: number) => boolean {
  let ultimo: { messaggio: string; quando: number } | null = null;
  return (messaggio, adesso) => {
    if (ultimo && ultimo.messaggio === messaggio && adesso - ultimo.quando < ogniMs) return false;
    ultimo = { messaggio, quando: adesso };
    return true;
  };
}
