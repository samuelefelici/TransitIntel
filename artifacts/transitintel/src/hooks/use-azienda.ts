import { useAuth } from "@/hooks/use-auth";
import type { Azienda } from "@/lib/azienda";

/**
 * L'azienda di questa installazione (nome, città, centro delle mappe). Arriva
 * con la sessione: non fa richieste sue. Per rileggerla dopo un salvataggio:
 * `useAuth().refresh()`.
 */
export function useAzienda(): Azienda {
  return useAuth().azienda;
}
