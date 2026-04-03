import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronUp, Footprints, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { LayersState, WalkData } from "./types";
import { POI_COLOR, POI_ICON, POI_CATEGORY_IT } from "./constants";

interface LegendPanelProps {
  collapsed: boolean;
  onToggle: () => void;
  layers: LayersState;
  isochroneGeojson: any;
  isochroneStop: { name: string; lat: number; lng: number } | null;
  walkData: WalkData | null;
}

export function LegendPanel({ collapsed, onToggle, layers, isochroneGeojson, isochroneStop, walkData }: LegendPanelProps) {
  const showLegend = layers.mapboxTraffic || layers.poi || layers.gtfsShapes || layers.demand || isochroneGeojson || walkData;
  if (!showLegend) return null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden">
        <button
          onClick={onToggle}
          className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-muted/20 transition-colors"
        >
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Legenda</span>
          {collapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
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
              <CardContent className="px-3 pb-3 pt-0 space-y-3 border-t border-border/30">
                {layers.gtfsShapes && (
                  <div className="space-y-1.5 pt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Percorsi — congestione</p>
                    {[
                      { color: "#22c55e", h: 2,   label: "Scorrevole",    hint: "0–25%" },
                      { color: "#eab308", h: 3.5, label: "Rallentato",    hint: "25–65%" },
                      { color: "#f97316", h: 5.5, label: "Congestionato", hint: "65–85%" },
                      { color: "#ef4444", h: 8,   label: "Critico",       hint: "> 85%" },
                    ].map(({ color, h, label, hint }) => (
                      <div key={label} className="flex items-center gap-2.5">
                        <div className="w-7 flex items-center"><div className="w-full rounded-full" style={{ backgroundColor: color, height: `${h}px` }} /></div>
                        <span className="text-xs text-foreground/80">{label}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">({hint})</span>
                      </div>
                    ))}
                  </div>
                )}
                {layers.mapboxTraffic && (
                  <div className="space-y-1.5 border-t border-border/20 pt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Traffico strade (live)</p>
                    {[["#22c55e", "Scorrevole"], ["#eab308", "Moderato"], ["#f97316", "Intenso"], ["#ef4444", "Critico"]].map(([c, l]) => (
                      <div key={l} className="flex items-center gap-2">
                        <div className="w-6 h-2 rounded-full" style={{ backgroundColor: c }} />
                        <span className="text-xs text-muted-foreground">{l}</span>
                      </div>
                    ))}
                  </div>
                )}
                {layers.poi && (
                  <div className="space-y-1.5 border-t border-border/20 pt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Punti di interesse</p>
                    {Object.entries(POI_COLOR).map(([cat, color]) => (
                      <div key={cat} className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full border border-black/30" style={{ backgroundColor: color }} />
                        <span className="text-xs text-muted-foreground flex items-center gap-1">{POI_ICON[cat]} {POI_CATEGORY_IT[cat] || cat}</span>
                      </div>
                    ))}
                  </div>
                )}
                {layers.demand && (
                  <div className="space-y-1.5 border-t border-border/20 pt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Users className="w-3 h-3" /> Densità popolazione
                    </p>
                    {walkData ? (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-3 rounded" style={{ background: "linear-gradient(90deg, #bbf7d0, #22c55e, #166534)" }} />
                          <span className="text-[10px] text-muted-foreground">Coperta (walkability)</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-5 h-3 rounded" style={{ background: "linear-gradient(90deg, #ffffcc, #feb24c, #bd0026)" }} />
                          <span className="text-[10px] text-muted-foreground">Non coperta</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-1">
                          <div className="flex-1 h-3 rounded" style={{ background: "linear-gradient(90deg, #ffffcc, #fecc8c, #feb24c, #fd8d3c, #f03b20, #bd0026, #800026)" }} />
                        </div>
                        <div className="flex justify-between text-[9px] text-muted-foreground">
                          <span>0</span><span>200</span><span>500</span><span>1k</span><span>3k</span><span>8k+ ab/km²</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {isochroneGeojson && (
                  <div className="space-y-1.5 border-t border-border/20 pt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Footprints className="w-3 h-3" /> Isocrona pedonale
                    </p>
                    {isochroneStop && (
                      <p className="text-[10px] text-muted-foreground italic">{isochroneStop.name}</p>
                    )}
                    {[
                      { color: "#3b82f6", label: "5 min a piedi", opacity: 0.3 },
                      { color: "#1d4ed8", label: "10 min a piedi", opacity: 0.15 },
                    ].map(({ color, label, opacity }) => (
                      <div key={label} className="flex items-center gap-2">
                        <div className="w-5 h-3 rounded border" style={{ backgroundColor: color, opacity, borderColor: color }} />
                        <span className="text-xs text-muted-foreground">{label}</span>
                      </div>
                    ))}
                  </div>
                )}
                {walkData && (
                  <div className="space-y-1.5 border-t border-border/20 pt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                      <Footprints className="w-3 h-3" /> Copertura pedonale
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-3 rounded border border-blue-600" style={{ backgroundColor: "#3b82f6", opacity: 0.2 }} />
                      <span className="text-xs text-muted-foreground">{walkData.minutes} min — {walkData.coveragePercent}% pop.</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </motion.div>
  );
}
