/**
 * I quadratini delle strisce AVM, condivisi dal controllo settimanale e
 * dall'andamento: stessi colori del foglio Excel (avm-controllo-xlsx.ts).
 */
import React from "react";

export type VoceStriscia = { colore: string | null; testo: string };

/** Lo stato di una vettura in una settimana (statoSettimana in api-server/src/lib/avm-controllo.ts). */
export const SETTIMANA: Record<string, VoceStriscia> = {
  F: { colore: "#34d399", testo: "si è localizzata" },
  P: { colore: "#fbbf24", testo: "ha parlato, mai localizzata" },
  M: { colore: "#3f3f46", testo: "nessun contatto" },
  A: { colore: null, testo: "non elencata" },
  ".": { colore: null, testo: "meno di 3 giornate contate" },
};

/** Un quadratino della striscia: pieno col colore, a contorno se non elencata, un punto se non contata. */
export function Quadratino({ ch, mappa, titolo, alto = "h-4" }: {
  ch: string; mappa: Record<string, VoceStriscia>; titolo: string; alto?: string;
}) {
  const voce = mappa[ch] ?? { colore: null, testo: ch };
  if (voce.colore) {
    return <span title={`${titolo}: ${voce.testo}`} className={`w-2.5 ${alto} rounded-[2px] shrink-0`}
      style={{ background: voce.colore, opacity: ch === "M" ? 0.55 : 0.9 }} />;
  }
  if (ch === "-" || ch === "A") {
    return <span title={`${titolo}: ${voce.testo}`} className={`w-2.5 ${alto} rounded-[2px] shrink-0 border border-border/50`} />;
  }
  return (
    <span title={`${titolo}: ${voce.testo}`} className={`w-2.5 ${alto} shrink-0 flex items-center justify-center`}>
      {ch === "." && <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />}
    </span>
  );
}
