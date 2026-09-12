/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LA CAUSA VERA DI UN RIFIUTO DEL DATABASE
 * ───────────────────────────────────────────────────────────────────────────
 * Drizzle avvolge l'errore di Postgres in un "Failed query: <SQL> params: …" e
 * mette la causa in `cause`. Chi poi lo cattura scrive "Internal server error"
 * e butta via tutto: il risultato è un 500 che non dice niente, e per capire
 * perché una riga sia stata rifiutata bisogna riprodurre il caso a mano.
 *
 * Era già successo con l'ingestione SIRI: ogni apertura di corsa veniva
 * rifiutata da giorni per un `id` uuid NOT NULL senza predefinito, e il
 * messaggio mostrava la query — che sapevamo già — nascondendo la sola cosa
 * che serviva. Qui si tira fuori SQLSTATE, messaggio, colonna, vincolo e
 * tabella, che insieme dicono la causa senza doverla indovinare.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface CausaDb {
  /** SQLSTATE, es. 23503 = violazione di chiave esterna */
  code: string | null;
  /** la frase pronta da mostrare a chi legge */
  messaggio: string;
  /** tabella e vincolo coinvolti, quando Postgres li dichiara */
  tabella: string | null;
  vincolo: string | null;
}

export function causaDb(e: any): CausaDb {
  const c = e?.cause ?? e;
  const parti = [
    c?.code ? `[${c.code}]` : null,
    c?.message ?? e?.message ?? String(e),
    c?.detail ? `— ${c.detail}` : null,
    c?.column ? `(colonna ${c.column})` : null,
    c?.constraint ? `(vincolo ${c.constraint})` : null,
    c?.hint ? `Suggerimento: ${c.hint}` : null,
  ].filter(Boolean);
  return {
    code: c?.code ?? null,
    messaggio: parti.join(" "),
    tabella: c?.table ?? null,
    vincolo: c?.constraint ?? null,
  };
}

/**
 * Gli SQLSTATE che chi legge può risolvere da solo, tradotti.
 *
 * Non sono tutti: solo quelli che un'operazione dell'interfaccia può davvero
 * produrre. Per gli altri resta il messaggio di Postgres, che è comunque
 * infinitamente più utile di "Internal server error".
 */
export function spiegaCausa(c: CausaDb): string | null {
  switch (c.code) {
    case "23503":
      return "Qualcos'altro nel sistema fa ancora riferimento a questo dato"
        + (c.tabella ? ` (tabella ${c.tabella})` : "")
        + ": va prima scollegato.";
    case "23505":
      return "Esiste già un dato con questi valori: " + (c.vincolo ?? "duplicato");
    case "42501":
      return "Il database non concede il permesso per questa operazione.";
    case "57014":
      return "L'operazione ha superato il tempo massimo. Su un archivio grande "
        + "può servire eseguirla in più passi.";
    case "53100":
      return "Spazio su disco esaurito sul database.";
    default:
      return null;
  }
}
