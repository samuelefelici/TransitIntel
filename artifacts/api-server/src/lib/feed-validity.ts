/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IN QUALE MOMENTO DELLA SUA VITA È UN FEED
 * ───────────────────────────────────────────────────────────────────────────
 * "Il calendario non comprende oggi" mette insieme due situazioni opposte:
 * un feed SCADUTO, che è un problema, e un feed che deve ancora ENTRARE IN
 * VIGORE, che è buona pratica — l'orario nuovo si carica prima che parta.
 *
 * Confonderle fa due danni in direzioni opposte: manda a rimaterializzare un
 * feed che va benissimo, e non dice nulla di utile su quello scaduto. Per
 * questo lo stato ha tre valori e non un booleano.
 *
 * ── La combinazione che conta davvero ──
 *
 * Un feed futuro ATTIVO non è un errore di per sé, ma ha una conseguenza che
 * nessuno si aspetta: fino alla data di inizio nessuna corsa circola secondo
 * il calendario, quindi l'aggancio ripiega su TUTTE le validità insieme e
 * diventa ambiguo. Va detto, ed è diverso dal dire "rimaterializza".
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type StatoValidita =
  /** entra in vigore più avanti: normale per un orario caricato in anticipo */
  | "futuro"
  /** comprende oggi */
  | "corrente"
  /** finito: le sue corse non circolano più */
  | "scaduto"
  /** nessun calendario: non si sa quali corse circolino, in nessuna data */
  | "assente";

export interface ValiditaFeed {
  stato: StatoValidita;
  dal: string | null;
  al: string | null;
  /** giorni che mancano all'entrata in vigore (solo per "futuro") */
  fraGiorni: number | null;
  nota: string;
}

/** "20260914" → giorni da oggi; negativo se è già passato. */
function giorniDa(ymd: string, oggi: string): number {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const a = d(ymd), b = d(oggi);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

const YMD = /^\d{8}$/;

export function validitaFeed(
  righe: number, dal: string | null, al: string | null,
  oggiYmd: string, attivo = false,
): ValiditaFeed {
  if (righe === 0 || !dal || !al || !YMD.test(dal) || !YMD.test(al)) {
    return {
      stato: "assente", dal, al, fraGiorni: null,
      nota: "Questo feed non ha calendario: non si sa quali corse circolino in "
        + "nessuna data, e l'aggancio delle corse lavora su tutte le validità "
        + "insieme.",
    };
  }

  if (dal > oggiYmd) {
    const fra = giorniDa(dal, oggiYmd);
    return {
      stato: "futuro", dal, al, fraGiorni: fra,
      nota: `Entra in vigore fra ${fra} giorn${fra === 1 ? "o" : "i"}. `
        + (attivo
          /* Non è un errore, ma la conseguenza non è ovvia e va detta. */
          ? "È già il feed attivo: fino ad allora nessuna corsa circola secondo "
            + "il suo calendario, quindi l'aggancio ripiega su tutte le validità "
            + "insieme ed è ambiguo. Se l'orario in vigore è un altro, attiva quello."
          : "Caricarlo in anticipo è corretto: attivalo quando entra in servizio."),
    };
  }

  if (al < oggiYmd) {
    const da = -giorniDa(al, oggiYmd);
    return {
      stato: "scaduto", dal, al, fraGiorni: null,
      nota: `Scaduto da ${da} giorn${da === 1 ? "o" : "i"}. Le sue corse non `
        + "circolano più: l'aggancio ripiega su tutte le validità insieme ed è "
        + "ambiguo. Va sostituito con l'orario in vigore.",
    };
  }

  return {
    stato: "corrente", dal, al, fraGiorni: null,
    nota: "Il calendario comprende oggi.",
  };
}

/** La data di oggi come "YYYYMMDD" nel fuso dell'azienda. */
export function oggiYmd(timeZone = process.env.SIRI_TIMEZONE || "Europe/Rome"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()).replace(/-/g, "");
}
