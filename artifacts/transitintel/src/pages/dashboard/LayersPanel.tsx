import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Layers, ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { LayersState, ViewMode } from "./types";
import { POI_COLOR, POI_ICON, POI_CATEGORY_IT } from "./constants";

interface LayersPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  layers: LayersState;
  onLayerChange: (key: keyof LayersState, value: boolean) => void;
  viewMode: ViewMode;
  showBuildings: boolean;
  selectedPoiCats: string[];
  onPoiCatToggle: (cat: string) => void;
  showRouteFilter: boolean;
  selectedRouteIds: string[];
  selectedDirection: 0 | 1 | null;
  onRouteFilterToggle: () => void;
}

export function LayersPanel({
  collapsed, onToggle, layers, onLayerChange, viewMode,
  showBuildings, selectedPoiCats, onPoiCatToggle,
  showRouteFilter, selectedRouteIds, selectedDirection, onRouteFilterToggle,
}: LayersPanelProps) {
  const layerItems: Array<{ key: keyof LayersState; label: string; hint?: string }> = [
    { key: "gtfsShapes",    label: "Percorsi GTFS",       hint: "colorati per congestione" },
    { key: "gtfsStops",     label: "Fermate GTFS",        hint: "clicca per dettaglio" },
    { key: "poi",           label: "Punti di interesse",  hint: "clicca per info" },
    { key: "demand",        label: "Heatmap popolazione" },
    { key: "mapboxTraffic", label: "Traffico strade",     hint: "live — strade principali" },
  ];

  return (
    <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Layers className="w-4 h-4 text-primary" />
          Livelli Mappa
        </span>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <CardContent className="px-3 pb-3 pt-0 space-y-2.5 border-t border-border/30">
              {layerItems.map(({ key, label, hint }) => (
                <div key={key}>
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <div>
                      <Label htmlFor={`layer-${key}`} className="text-sm cursor-pointer">{label}</Label>
                      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
                    </div>
                    <Switch
                      id={`layer-${key}`}
                      checked={key === "buildings" ? showBuildings : layers[key]}
                      disabled={key === "buildings" && viewMode === "city3d"}
                      onCheckedChange={c => onLayerChange(key, c)}
                    />
                  </div>
                  {/* POI category filter pills */}
                  {key === "poi" && layers.poi && (
                    <div className="flex flex-wrap gap-1 mt-1.5 pl-0">
                      {Object.entries(POI_COLOR).map(([cat, color]) => {
                        const on = selectedPoiCats.includes(cat);
                        return (
                          <button key={cat}
                            onClick={() => onPoiCatToggle(cat)}
                            className={`text-[9px] px-1.5 py-0.5 rounded-full border transition-all flex items-center gap-1 ${on ? "opacity-100" : "opacity-30"}`}
                            style={{ borderColor: color, color }}>
                            {POI_ICON[cat]} {POI_CATEGORY_IT[cat] || cat}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}

              {/* Route filter button */}
              {layers.gtfsShapes && (
                <button
                  onClick={onRouteFilterToggle}
                  className={`w-full mt-1 flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-medium transition-all ${
                    showRouteFilter || selectedRouteIds.length > 0 || selectedDirection !== null
                      ? "bg-primary/15 border-primary/40 text-primary"
                      : "bg-muted/40 border-border/40 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                    Filtra linee
                  </div>
                  <div className="flex items-center gap-1">
                    {selectedRouteIds.length > 0 && (
                      <Badge className="text-[10px] h-4 px-1.5 bg-primary text-primary-foreground">{selectedRouteIds.length}</Badge>
                    )}
                    {selectedDirection !== null && (
                      <Badge variant="secondary" className="text-[9px] h-4 px-1">{selectedDirection === 0 ? "→" : "←"}</Badge>
                    )}
                    {!selectedRouteIds.length && selectedDirection === null && (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </div>
                </button>
              )}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}