import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cloud, Droplets, Wind, Eye, Thermometer, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useGetWeatherCurrent } from "@workspace/api-client-react";

/** Map OpenWeatherMap icon code to emoji */
function weatherEmoji(icon?: string, main?: string): string {
  if (!icon) return "🌡️";
  const code = icon.slice(0, 2);
  const isNight = icon.endsWith("n");
  switch (code) {
    case "01": return isNight ? "🌙" : "☀️";
    case "02": return isNight ? "🌙" : "⛅";
    case "03": return "☁️";
    case "04": return "☁️";
    case "09": return "🌧️";
    case "10": return isNight ? "🌧️" : "🌦️";
    case "11": return "⛈️";
    case "13": return "🌨️";
    case "50": return "🌫️";
    default: return "🌡️";
  }
}

/** Translate weather main group to Italian */
function weatherMainIt(main?: string): string {
  if (!main) return "N/D";
  const map: Record<string, string> = {
    Clear: "Sereno", Clouds: "Nuvoloso", Rain: "Pioggia", Drizzle: "Pioggerella",
    Thunderstorm: "Temporale", Snow: "Neve", Mist: "Foschia", Fog: "Nebbia",
    Haze: "Caligine", Smoke: "Fumo", Dust: "Polvere", Sand: "Sabbia",
    Ash: "Cenere", Squall: "Burrasca", Tornado: "Tornado",
  };
  return map[main] ?? main;
}

interface WeatherWidgetProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function WeatherWidget({ collapsed, onToggle }: WeatherWidgetProps) {
  const { data: weatherData, isLoading } = useGetWeatherCurrent();

  // Pick primary location (first one, usually Ancona Centro)
  const primary = weatherData?.[0];

  return (
    <Card className="bg-card/85 backdrop-blur-xl border-border/50 shadow-2xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Cloud className="w-4 h-4 text-blue-400" />
          Meteo
          {primary && !collapsed && (
            <span className="text-xs font-normal text-muted-foreground ml-1">
              {primary.locationName}
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {primary && collapsed && (
            <span className="text-xs text-muted-foreground">
              {weatherEmoji(primary.weatherIcon, primary.weatherMain)} {Math.round(primary.temp ?? 0)}°C
            </span>
          )}
          {collapsed ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
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
            <CardContent className="px-3 pb-3 pt-0 border-t border-border/30">
              {isLoading && (
                <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  Caricamento meteo…
                </div>
              )}

              {!isLoading && !primary && (
                <p className="text-xs text-muted-foreground/60 py-3">
                  Dati meteo non disponibili. Verifica OPENWEATHER_API_KEY.
                </p>
              )}

              {!isLoading && primary && (
                <div className="space-y-3 pt-2">
                  {/* Main weather display */}
                  <div className="flex items-center gap-3">
                    <span className="text-4xl leading-none">
                      {weatherEmoji(primary.weatherIcon, primary.weatherMain)}
                    </span>
                    <div>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-2xl font-bold tabular-nums">
                          {Math.round(primary.temp ?? 0)}°
                        </span>
                        <span className="text-sm text-muted-foreground">C</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {weatherMainIt(primary.weatherMain)}
                        {primary.weatherDescription && primary.weatherDescription !== primary.weatherMain?.toLowerCase()
                          ? ` · ${primary.weatherDescription}`
                          : ""}
                      </p>
                    </div>
                  </div>

                  {/* Detail grid */}
                  <div className="grid grid-cols-2 gap-2">
                    <DetailRow
                      icon={<Thermometer className="w-3 h-3 text-orange-400" />}
                      label="Percepita"
                      value={`${Math.round(primary.feelsLike ?? 0)}°C`}
                    />
                    <DetailRow
                      icon={<Droplets className="w-3 h-3 text-blue-400" />}
                      label="Umidità"
                      value={`${primary.humidity ?? 0}%`}
                    />
                    <DetailRow
                      icon={<Wind className="w-3 h-3 text-cyan-400" />}
                      label="Vento"
                      value={`${((primary.windSpeed ?? 0) * 3.6).toFixed(0)} km/h`}
                    />
                    <DetailRow
                      icon={<Eye className="w-3 h-3 text-gray-400" />}
                      label="Visibilità"
                      value={
                        primary.visibility != null
                          ? primary.visibility >= 1000
                            ? `${(primary.visibility / 1000).toFixed(0)} km`
                            : `${primary.visibility} m`
                          : "N/D"
                      }
                    />
                  </div>

                  {/* Rain/Snow alert */}
                  {(primary.rain1h != null && primary.rain1h > 0) && (
                    <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-2.5 py-1.5">
                      <span className="text-sm">🌧️</span>
                      <span className="text-[11px] text-blue-400 font-medium">
                        Pioggia: {primary.rain1h.toFixed(1)} mm/h
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        ⚠ Impatto traffico
                      </span>
                    </div>
                  )}
                  {(primary.snow1h != null && primary.snow1h > 0) && (
                    <div className="flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-2.5 py-1.5">
                      <span className="text-sm">🌨️</span>
                      <span className="text-[11px] text-indigo-400 font-medium">
                        Neve: {primary.snow1h.toFixed(1)} mm/h
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        ⚠ Impatto traffico elevato
                      </span>
                    </div>
                  )}

                  {/* Other locations */}
                  {weatherData && weatherData.length > 1 && (
                    <div className="border-t border-border/30 pt-2">
                      <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wide font-medium">
                        Altre stazioni
                      </p>
                      <div className="space-y-1">
                        {weatherData.slice(1).map((w, i) => (
                          <div key={i} className="flex items-center gap-2 text-[11px]">
                            <span>{weatherEmoji(w.weatherIcon, w.weatherMain)}</span>
                            <span className="text-muted-foreground truncate flex-1">{w.locationName}</span>
                            <span className="font-bold tabular-nums">{Math.round(w.temp ?? 0)}°</span>
                            <span className="text-muted-foreground/70 text-[10px]">
                              {weatherMainIt(w.weatherMain)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Timestamp */}
                  {primary.capturedAt && (
                    <p className="text-[9px] text-muted-foreground/50 text-right">
                      Aggiornato: {new Date(primary.capturedAt).toLocaleString("it-IT", {
                        hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
                      })}
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <div>
        <p className="text-[10px] text-muted-foreground leading-none">{label}</p>
        <p className="text-xs font-semibold leading-tight">{value}</p>
      </div>
    </div>
  );
}
