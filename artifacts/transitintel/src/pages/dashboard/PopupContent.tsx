import React from "react";
import { Star, MapPin, Footprints, Loader2 } from "lucide-react";
import type { MapPopup } from "./types";
import { POI_CATEGORY_IT, POI_COLOR, POI_ICON, congestionLabel } from "./constants";

interface PopupContentProps {
  popup: MapPopup;
  onShowIsochrone?: (lat: number, lng: number, name: string) => void;
  isochroneLoading?: boolean;
  isochroneVisible?: boolean;
}

export function PopupContent({ popup, onShowIsochrone, isochroneLoading, isochroneVisible }: PopupContentProps) {
  const { type, props } = popup;

  if (type === "traffic") {
    const cong = typeof props.congestion === "number" ? props.congestion : 0;
    const { text, color } = congestionLabel(cong);
    const speedReduction = props.freeflow > 0 ? Math.round((1 - props.speed / props.freeflow) * 100) : null;
    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-semibold text-sm text-gray-900">🚦 Sensore Traffico</div>
        <div className="text-[10px] text-gray-400 font-mono">{props.segmentId}</div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-sm font-bold" style={{ color }}>{text}</span>
          {speedReduction != null && speedReduction > 0 && (
            <span className="ml-auto text-xs text-red-500 font-semibold">−{speedReduction}% velocità</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
          <span className="text-gray-400">Velocità attuale</span><span className="font-bold">{props.speed?.toFixed(0)} km/h</span>
          <span className="text-gray-400">Flusso libero</span><span className="font-bold">{props.freeflow?.toFixed(0)} km/h</span>
          <span className="text-gray-400">Congestione</span><span className="font-bold">{Math.round(cong * 100)}%</span>
        </div>
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${cong * 100}%`, backgroundColor: color }} />
        </div>
      </div>
    );
  }

  if (type === "poi") {
    const catLabel = POI_CATEGORY_IT[props.category] || props.category;
    const catColor = POI_COLOR[props.category] || "#6b7280";
    const catIcon = POI_ICON[props.category] || null;
    const rating = typeof props.rating === "number" ? props.rating : null;
    const total = typeof props.userRatingsTotal === "number" ? props.userRatingsTotal : null;
    let types: string[] = [];
    try { types = JSON.parse(props.types || "[]"); } catch {}
    const displayTypes = types.filter(t => !["point_of_interest", "establishment"].includes(t)).slice(0, 3);

    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-bold text-sm text-gray-900 leading-snug">{props.name}</div>
        <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs text-white font-medium" style={{ backgroundColor: catColor }}>
          {catIcon} {catLabel}
        </div>
        {rating != null && (
          <div className="flex items-center gap-1.5">
            <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
            <span className="text-sm font-bold text-gray-800">{rating.toFixed(1)}</span>
            {total != null && <span className="text-xs text-gray-400">({total.toLocaleString("it-IT")} recensioni)</span>}
          </div>
        )}
        {props.vicinity && props.vicinity !== "null" && (
          <div className="text-xs text-gray-500 flex items-start gap-1">
            <MapPin className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{props.vicinity}</span>
          </div>
        )}
        {displayTypes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {displayTypes.map(t => (
              <span key={t} className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">{t.replace(/_/g, " ")}</span>
            ))}
          </div>
        )}
        {props.source === "google_places" && (
          <div className="text-[9px] text-gray-400 border-t border-gray-100 pt-1">Fonte: Google Places</div>
        )}
      </div>
    );
  }

  if (type === "gtfsStop") {
    const score = typeof props.score === "number" ? props.score : 0;
    const hasData = props.trips > 0;
    const scoreColor = score >= 60 ? "#22c55e" : score >= 30 ? "#eab308" : "#ef4444";
    const scoreLabel = score >= 60 ? "Buono" : score >= 30 ? "Sufficiente" : "Insufficiente";
    const wheelchair = props.wheelchair === 1 || props.wheelchair === "1";

    return (
      <div className="space-y-2 min-w-[220px]">
        <div className="flex items-start justify-between gap-2">
          <div className="font-bold text-sm text-gray-900 leading-snug flex-1">{props.name}</div>
          {wheelchair && <span title="Accessibile" className="text-base shrink-0">♿</span>}
        </div>
        {props.code && props.code !== "-" && (
          <div className="text-[10px] text-gray-400 font-mono bg-gray-100 px-1.5 py-0.5 rounded w-fit">Cod. {props.code}</div>
        )}
        {props.desc && props.desc !== "null" && (
          <div className="text-xs text-gray-500 italic">{props.desc}</div>
        )}
        {hasData ? (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700 bg-gray-50 rounded-lg p-2">
              <span className="text-gray-400">Corse giorno</span><span className="font-bold">{props.trips}</span>
              <span className="text-gray-400">Picco mattina</span><span className="font-bold">{props.morning} <span className="text-gray-400 font-normal">(7–9h)</span></span>
              <span className="text-gray-400">Picco sera</span><span className="font-bold">{props.evening} <span className="text-gray-400 font-normal">(17–19h)</span></span>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-gray-400">Punteggio servizio</span>
                <span className="font-bold text-xs" style={{ color: scoreColor }}>{scoreLabel} ({Math.round(score)})</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: scoreColor }} />
              </div>
            </div>
          </>
        ) : (
          <p className="text-xs text-gray-400 italic">Re-importa il feed GTFS per aggiornare i dati.</p>
        )}
        {onShowIsochrone && (
          <button
            onClick={() => onShowIsochrone(popup.lat, popup.lng, props.name)}
            disabled={isochroneLoading}
            className={`w-full mt-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              isochroneVisible
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100 hover:text-gray-800"
            }`}
          >
            {isochroneLoading ? (
              <><Loader2 className="w-3 h-3 animate-spin" /> Calcolo in corso…</>
            ) : isochroneVisible ? (
              <><Footprints className="w-3 h-3" /> Isocrona visibile</>
            ) : (
              <><Footprints className="w-3 h-3" /> Mostra isocrona pedonale</>
            )}
          </button>
        )}
      </div>
    );
  }

  if (type === "shape") {
    const cong = props.congestion;
    const speedReduction = typeof props.speedReduction === "number" ? props.speedReduction : null;
    const speed = typeof props.speed === "number" ? props.speed : null;
    const freeflow = typeof props.freeflow === "number" ? props.freeflow : null;
    const routeName = props.routeShortName || props.routeId;

    if (cong === null || cong === undefined) {
      return (
        <div className="space-y-1.5 min-w-[180px]">
          <div className="font-semibold text-sm text-gray-900">
            🚌 {routeName ? `Linea ${routeName}` : "Percorso GTFS"}
          </div>
          <div className="text-xs text-gray-400">Nessun sensore TomTom nelle vicinanze.</div>
        </div>
      );
    }

    const { text, color } = congestionLabel(cong);
    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-semibold text-sm text-gray-900">
          🚌 {routeName ? `Linea ${routeName}` : "Percorso GTFS"}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="font-bold text-sm" style={{ color }}>{text}</span>
          {speedReduction != null && speedReduction > 0 && (
            <span className="ml-auto text-xs font-bold text-red-500">−{speedReduction}% velocità</span>
          )}
        </div>
        {speed != null && freeflow != null && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-gray-700">
            <span className="text-gray-400">Vel. attuale</span><span className="font-semibold">{speed.toFixed(0)} km/h</span>
            <span className="text-gray-400">Flusso libero</span><span className="font-semibold">{freeflow.toFixed(0)} km/h</span>
            <span className="text-gray-400">Congestione</span><span className="font-semibold">{Math.round(cong * 100)}%</span>
          </div>
        )}
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${cong * 100}%`, backgroundColor: color }} />
        </div>
        {speedReduction != null && speedReduction > 15 && (
          <div className="text-[10px] text-amber-600 bg-amber-50 rounded px-2 py-1">
            ⚠ Il traffico rallenta le corse del {speedReduction}% su questo tratto
          </div>
        )}
      </div>
    );
  }

  if (type === "census") {
    const pop = Number(props.population) || 0;
    const density = Number(props.density) || 0;
    const area = Number(props.areaKm2) || 0;
    const densityColor = density >= 3000 ? "#991b1b" : density >= 1000 ? "#dc2626" : density >= 500 ? "#f97316" : density >= 200 ? "#eab308" : "#84cc16";
    const densityLabel = density >= 3000 ? "Molto alta" : density >= 1000 ? "Alta" : density >= 500 ? "Media" : density >= 200 ? "Medio-bassa" : "Bassa";
    return (
      <div className="space-y-2 min-w-[200px]">
        <div className="font-semibold text-sm text-gray-900">📊 Sezione Censuaria</div>
        {props.istatCode && <div className="text-[10px] text-gray-400 font-mono">ISTAT: {props.istatCode}</div>}
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: densityColor }} />
          <span className="text-sm font-bold" style={{ color: densityColor }}>{densityLabel}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-700">
          <span className="text-gray-400">Popolazione</span><span className="font-bold">{pop.toLocaleString("it-IT")} ab.</span>
          <span className="text-gray-400">Densità</span><span className="font-bold">{density.toLocaleString("it-IT")} ab/km²</span>
          <span className="text-gray-400">Superficie</span><span className="font-bold">{area.toFixed(3)} km²</span>
        </div>
        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.min(density / 8000 * 100, 100)}%`, backgroundColor: densityColor }} />
        </div>
      </div>
    );
  }

  return null;
}
