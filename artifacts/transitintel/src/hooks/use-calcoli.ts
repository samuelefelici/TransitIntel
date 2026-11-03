/**
 * I miei calcoli, una sola lettura per la pagina e per l'indicatore (stessa
 * chiave di react-query): ogni 5 secondi mentre qualcosa gira, ogni minuto
 * altrimenti, ferma quando la scheda del browser è nascosta.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { elencoCalcoli, fermaCalcolo, vivo, type Calcolo } from "@/lib/calcoli";
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
    refetchInterval: (query) => ((query.state.data as Calcolo[] | undefined)?.some(vivo) ? 5_000 : 60_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const client = useQueryClient();
  const ferma = useCallback(async (jobId: string) => {
    const esito = await fermaCalcolo(jobId);
    await client.invalidateQueries({ queryKey: CHIAVE_CALCOLI });
    return esito;
  }, [client]);
  return { ...q, calcoli: q.data ?? [], abilitato, ferma };
}
