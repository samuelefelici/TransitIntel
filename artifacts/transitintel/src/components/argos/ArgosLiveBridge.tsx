/**
 * Ponte della REGIA IN DIRETTA.
 *
 * Il pannello agente emette un CustomEvent "argos-live" a ogni SCRITTURA
 * riuscita (evento SSE tool_done da Argos: id corse create/eliminate, rete
 * nuova, bollini). Questo componente — montato UNA volta dentro il
 * QueryClientProvider — lo ascolta e invalida i dati di Planning Studio:
 * le pagine aperte (corse, validità, quadri, nodi) si rifetchano da sole
 * mentre l'agente lavora, senza ricaricare nulla a mano. Le evidenziazioni
 * puntuali le fanno le pagine con useArgosFresh.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export type ArgosLiveDetail = {
  name: string;
  ok: boolean;
  count?: number;
  tripIds?: string[];
  deletedTripIds?: string[];
  shiftedTripIds?: string[];
  created?: { routes?: string[]; variants?: string[]; stops?: string[] };
  validity?: {
    isValid: boolean; count: number;
    routeIds?: string[]; tripIds?: string[]; dayTypeCodes?: string[];
  };
  /** Anteprima FANTASMA: percorso proposto, non ancora creato (preview_route). */
  ghost?: { label: string; stopIds: string[] };
};

export default function ArgosLiveBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    const onLive = (e: Event) => {
      const d = (e as CustomEvent<ArgosLiveDetail>).detail;
      if (!d?.ok) return;
      if (d.ghost) return; // anteprima: nessun dato è cambiato, niente rifetch
      // Tutte le chiavi di Planning Studio: una scrittura dell'agente può
      // toccare corse, validità, quadri e conteggi insieme — meglio un
      // rifetch largo e certo che una mappa fine e fragile di dipendenze.
      qc.invalidateQueries({ queryKey: ["ps"] });
    };
    window.addEventListener("argos-live", onLive);
    return () => window.removeEventListener("argos-live", onLive);
  }, [qc]);
  return null;
}
