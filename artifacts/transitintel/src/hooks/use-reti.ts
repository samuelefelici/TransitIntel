import { useAuth } from "@/hooks/use-auth";
import type { Rete } from "@/lib/reti";

/**
 * Le reti dell'azienda (l'extraurbana e le urbane): etichette, sigle e colori
 * delle pagine vengono da qui. Arrivano con la sessione: non fa richieste sue.
 * Per rileggerle dopo un salvataggio: `useAuth().refresh()`.
 */
export function useReti(): readonly Rete[] {
  return useAuth().reti;
}
