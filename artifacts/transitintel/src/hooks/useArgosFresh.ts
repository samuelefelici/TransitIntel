/**
 * Gli id toccati dall'agente negli ULTIMI SECONDI (regia in diretta).
 *
 * Le pagine li usano per evidenziare ciò che è appena cambiato: righe che
 * lampeggiano nella griglia corse, linee accese. Alimentato dagli eventi
 * "argos-live" del pannello agente; ogni gruppo di id scade da solo dopo
 * qualche secondo, così l'evidenziazione racconta il presente, non lo storico.
 */
import { useEffect, useState } from "react";
import type { ArgosLiveDetail } from "@/components/argos/ArgosLiveBridge";

const TTL_MS = 12_000;

export interface ArgosFresh {
  trips: Set<string>;
  variants: Set<string>;
  routes: Set<string>;
}

export function useArgosFresh(): ArgosFresh {
  const [fresh, setFresh] = useState<ArgosFresh>({
    trips: new Set(), variants: new Set(), routes: new Set(),
  });
  useEffect(() => {
    const timers: number[] = [];
    const onLive = (e: Event) => {
      const d = (e as CustomEvent<ArgosLiveDetail>).detail;
      if (!d?.ok) return;
      const trips = [...(d.tripIds || []), ...(d.shiftedTripIds || []), ...(d.validity?.tripIds || [])];
      const variants = d.created?.variants || [];
      const routes = [...(d.created?.routes || []), ...(d.validity?.routeIds || [])];
      if (!trips.length && !variants.length && !routes.length) return;
      setFresh(prev => ({
        trips: new Set([...prev.trips, ...trips]),
        variants: new Set([...prev.variants, ...variants]),
        routes: new Set([...prev.routes, ...routes]),
      }));
      timers.push(window.setTimeout(() => {
        setFresh(prev => ({
          trips: new Set([...prev.trips].filter(x => !trips.includes(x))),
          variants: new Set([...prev.variants].filter(x => !variants.includes(x))),
          routes: new Set([...prev.routes].filter(x => !routes.includes(x))),
        }));
      }, TTL_MS));
    };
    window.addEventListener("argos-live", onLive);
    return () => {
      window.removeEventListener("argos-live", onLive);
      timers.forEach(t => window.clearTimeout(t));
    };
  }, []);
  return fresh;
}
