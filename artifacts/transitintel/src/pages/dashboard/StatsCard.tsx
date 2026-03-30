import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { GtfsSummary, DayFilter } from "./types";
import { congestionLabel } from "./constants";

interface StatsCardProps {
  collapsed: boolean;
  onToggle: () => void;
  gtfsSummary: GtfsSummary | null;
  dayFilter: DayFilter;
  avgCongestion?: number | null;
}

export function StatsCard({ collapsed, onToggle, gtfsSummary, dayFilter, avgCongestion }: StatsCardProps) {
  const dayRows = [
    ...(dayFilter === "tutti" || dayFilter === "feriale" ? [{
      label: "Feriale",
      routes: gtfsSummary?.weekdayRoutes,
      stops:  gtfsSummary?.weekdayStops,
      trips:  gtfsSummary?.weekdayTrips,
      km:     gtfsSummary?.weekdayKm,
      color:  "text-green-400",
    }] : []),
    ...(dayFilter === "tutti" || dayFilter === "sabato" ? [{
      label: "Sabato",
      routes: gtfsSummary?.saturdayRoutes,
      stops:  gtfsSummary?.saturdayStops,
      trips:  gtfsSummary?.saturdayTrips,
      km:     gtfsSummary?.saturdayKm,
      color:  "text-amber-400",
    }] : []),
    ...(dayFilter === "tutti" || dayFilter === "domenica" ? [{
      label: "Festivo",
      routes: gtfsSummary?.sundayRoutes,
      stops:  gtfsSummary?.sundayStops,
      trips:  gtfsSummary?.sundayTrips,
      km:     gtfsSummary?.sundayKm,
      color:  "text-rose-400",
    }] : []),
  ];

  return (
    <div className="absolute top-10 left-4 md:w-72 pointer-events-none">
      <AnimatePresence>
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="pointer-events-auto">
          <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
            <button
              onClick={onToggle}
              className="w-full p-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
            >
              <span className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                <span className="text-sm font-bold">Stato Rete</span>
                <span className="text-[10px] text-muted-foreground">ATMA · Ancona</span>
              </span>
              {collapsed
                ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
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
                    {/* Dynamic table */}
                    <div className="rounded-lg border border-border/40 overflow-hidden mt-2">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="bg-muted/30 text-muted-foreground">
                            <th className="text-left px-2 py-1 font-medium">Tipo</th>
                            <th className="text-right px-2 py-1 font-medium">Linee</th>
                            <th className="text-right px-2 py-1 font-medium">Fermate</th>
                            <th className="text-right px-2 py-1 font-medium">Corse</th>
                            <th className="text-right px-2 py-1 font-medium">Km</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/20">
                          {dayRows.map(row => (
                            <tr key={row.label}>
                              <td className={`px-2 py-1 font-semibold ${row.color}`}>{row.label}</td>
                              <td className="text-right px-2 py-1 font-mono">{row.routes != null ? row.routes.toLocaleString("it-IT") : "--"}</td>
                              <td className="text-right px-2 py-1 font-mono">{row.stops != null ? row.stops.toLocaleString("it-IT") : "--"}</td>
                              <td className="text-right px-2 py-1 font-mono">{row.trips != null ? row.trips.toLocaleString("it-IT") : "--"}</td>
                              <td className="text-right px-2 py-1 font-mono">{row.km != null ? row.km.toLocaleString("it-IT") : "--"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Service hours */}
                    {gtfsSummary?.firstDeparture && (
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground bg-muted/30 rounded-lg px-2.5 py-1.5">
                        <span>Prima corsa</span>
                        <span className="font-mono font-semibold text-foreground">{gtfsSummary.firstDeparture.substring(0, 5)}</span>
                        <span>Ultima</span>
                        <span className="font-mono font-semibold text-foreground">{gtfsSummary.lastArrival?.substring(0, 5)}</span>
                      </div>
                    )}

                    {/* Traffic */}
                    {avgCongestion != null && (
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="flex items-center gap-1 text-muted-foreground"><Activity className="w-3 h-3" /> Congestione media</span>
                        <span className="font-semibold" style={{ color: congestionLabel(avgCongestion).color }}>
                          {congestionLabel(avgCongestion).text} ({(avgCongestion * 100).toFixed(0)}%)
                        </span>
                      </div>
                    )}
                  </CardContent>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
