import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { SlidersHorizontal, Search, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { RouteItem } from "./types";

interface RouteFilterPanelProps {
  visible: boolean;
  onClose: () => void;
  routeSearch: string;
  onRouteSearchChange: (v: string) => void;
  selectedRouteIds: string[];
  selectedDirection: 0 | 1 | null;
  onDirectionChange: (v: 0 | 1 | null) => void;
  onResetSelection: () => void;
  onToggleRoute: (routeId: string) => void;
  filteredRoutes: RouteItem[];
  routeListEmpty: boolean;
}

export function RouteFilterPanel({
  visible, onClose, routeSearch, onRouteSearchChange,
  selectedRouteIds, selectedDirection, onDirectionChange,
  onResetSelection, onToggleRoute, filteredRoutes, routeListEmpty,
}: RouteFilterPanelProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          className="absolute left-4 top-1/2 -translate-y-1/2 w-72 z-10 pointer-events-auto"
        >
          <Card className="bg-card/95 backdrop-blur-xl border-border/60 shadow-2xl">
            <CardContent className="p-3 space-y-2.5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-primary" />
                  Filtra Linee GTFS
                </span>
                <div className="flex items-center gap-2">
                  {(selectedRouteIds.length > 0 || selectedDirection !== null) && (
                    <button onClick={onResetSelection}
                      className="text-[10px] text-muted-foreground hover:text-foreground underline">
                      Ripristina
                    </button>
                  )}
                  <button onClick={onClose}
                    className="text-muted-foreground hover:text-foreground">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Direction filter */}
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Verso (direction)</p>
                <div className="grid grid-cols-3 gap-1">
                  {([
                    { val: null, label: "Entrambi" },
                    { val: 0,    label: "→ Andata" },
                    { val: 1,    label: "← Ritorno" },
                  ] as { val: 0 | 1 | null; label: string }[]).map(opt => (
                    <button key={String(opt.val)} onClick={() => onDirectionChange(opt.val)}
                      className={`px-2 py-1 rounded-lg border text-[10px] font-medium transition-all ${
                        selectedDirection === opt.val
                          ? "bg-primary/15 border-primary/40 text-primary"
                          : "border-border/40 text-muted-foreground hover:bg-muted/50"
                      }`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={routeSearch}
                  onChange={e => onRouteSearchChange(e.target.value)}
                  placeholder="Cerca linea..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted rounded-lg border border-border/40 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              {selectedRouteIds.length > 0 && (
                <div className="text-[10px] text-primary bg-primary/10 rounded px-2 py-1">
                  {selectedRouteIds.length} {selectedRouteIds.length === 1 ? "linea selezionata" : "linee selezionate"}
                  {selectedDirection !== null && ` · ${selectedDirection === 0 ? "Andata" : "Ritorno"}`}
                </div>
              )}

              {/* Route list */}
              <div className="max-h-52 overflow-y-auto space-y-0.5 pr-1">
                {filteredRoutes.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    {routeListEmpty ? "Carica un feed GTFS per vedere le linee" : "Nessun risultato"}
                  </p>
                )}
                {filteredRoutes.map(route => {
                  const isSelected = selectedRouteIds.includes(route.routeId);
                  const color = route.routeColor || "#6b7280";
                  return (
                    <button
                      key={route.routeId}
                      onClick={() => onToggleRoute(route.routeId)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                        isSelected ? "bg-primary/15 border border-primary/30" : "hover:bg-muted/70 border border-transparent"
                      }`}
                    >
                      <div className="w-3 h-3 rounded-full shrink-0 border border-black/20" style={{ backgroundColor: color }} />
                      <span className="text-xs font-semibold shrink-0 w-8 truncate">{route.routeShortName || route.routeId}</span>
                      <span className="text-[10px] text-muted-foreground truncate flex-1">
                        {route.routeLongName || ""}
                      </span>
                      {route.tripsCount != null && (
                        <span className="text-[10px] text-muted-foreground shrink-0">{route.tripsCount}↗</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
