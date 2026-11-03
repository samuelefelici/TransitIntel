/**
 * I miei calcoli, una sola lettura per la pagina e per l'indicatore (stessa
 * chiave di react-query): ogni 5 secondi mentre qualcosa gira, ogni minuto
 * altrimenti, ferma quando la scheda del browser è nascosta.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { elencoCalcoli, fermaCalcolo, vivo, EVENTO_AVVIO, type Calcolo } from "@/lib/calcoli";
import { useAuth } from "@/hooks/use-auth";

export const CHIAVE_CALCOLI = ["calcoli"] as const;

export function useCalcoli() {
  const { isAdmin, hasPermission } = useAuth();
  const abilitato = isAdmin || hasPermission("scheduling");
  const q = useQuery({
    queryKey: CHIAVE_CALCOLI,
    queryFn: () => elencoCalcoli(20),
    enabled: abilitato,
    retry: false,
    // sempre da rileggere: il default dell'app (5 minuti) lascerebbe l'elenco indietro
    staleTime: 0,
    refetchInterval: (query) => ((query.state.data as Calcolo[] | undefined)?.some(vivo) ? 5_000 : 60_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const client = useQueryClient();
  // un calcolo appena lanciato da una pagina: elenco e indicatore lo mostrano subito
  useEffect(() => {
    if (!abilitato) return;
    const rileggi = () => { void client.invalidateQueries({ queryKey: CHIAVE_CALCOLI }); };
    window.addEventListener(EVENTO_AVVIO, rileggi);
    return () => window.removeEventListener(EVENTO_AVVIO, rileggi);
  }, [abilitato, client]);
  const ferma = useCallback(async (jobId: string) => {
    const esito = await fermaCalcolo(jobId);
    await client.invalidateQueries({ queryKey: CHIAVE_CALCOLI });
    return esito;
  }, [client]);
  return { ...q, calcoli: q.data ?? [], abilitato, ferma };
}
