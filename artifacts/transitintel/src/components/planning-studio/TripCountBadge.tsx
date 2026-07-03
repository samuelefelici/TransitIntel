/**
 * Badge "km totali" per la toolbar del Planner Studio.
 * km = Σ per corsa della lunghezza del suo percorso (vetture·km programmate):
 * cresce man mano che si aggiungono corse.
 * La query usa il prefisso ["ps", projectId, "trips", …]: ogni invalidazione
 * delle corse (creazione singola, generazione a cadenza, eliminazioni, import)
 * aggiorna automaticamente anche il contatore.
 */
import { useQuery } from "@tanstack/react-query";
import { Route as RouteIcon } from "lucide-react";
import { countPsTrips } from "@/lib/planning-studio-api";

const fmtKm = (km: number) =>
  km.toLocaleString("it-IT", { minimumFractionDigits: km < 100 ? 1 : 0, maximumFractionDigits: km < 100 ? 1 : 0 });

export default function TripCountBadge({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ["ps", projectId, "trips", "count-badge"],
    queryFn: () => countPsTrips(projectId),
    enabled: !!projectId,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
  if (!projectId) return null;
  // Endpoint non raggiungibile (es. server API non ancora aggiornato):
  // il badge resta VISIBILE in stato "n/d" invece di sparire.
  if (q.isError) {
    return (
      <span
        title="Contatore km non disponibile: il server API non espone ancora /trips-count (deploy in corso?). Riprova tra poco."
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-700 bg-slate-800/60 text-slate-500 text-xs font-medium select-none whitespace-nowrap"
      >
        <RouteIcon className="w-3.5 h-3.5" /> — km
      </span>
    );
  }
  if (!q.data) return null; // primo caricamento (frazione di secondo)
  // difensivo: se il backend non è ancora aggiornato i campi possono mancare
  const count = Number(q.data.count) || 0;
  const active = Number(q.data.active) || 0;
  const km = Number(q.data.km) || 0;
  const kmActive = Number(q.data.kmActive) || 0;
  return (
    <span
      title={`Percorrenze programmate del progetto: ${fmtKm(km)} km totali su ${count} corse${count !== active ? ` · ${fmtKm(kmActive)} km sulle ${active} corse attive` : ""}`}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs font-medium select-none whitespace-nowrap"
    >
      <RouteIcon className="w-3.5 h-3.5" />
      <span className="font-mono font-semibold">{fmtKm(km)}</span> km
      <span className="text-amber-500/70">· {count} corse</span>
    </span>
  );
}
