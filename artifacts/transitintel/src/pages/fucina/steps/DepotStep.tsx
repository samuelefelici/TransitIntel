/**
 * Step 2 — Selezione Deposito di Partenza
 *
 * L'utente sceglie da quale deposito devono partire i veicoli.
 * Questa informazione sarà usata per il calcolo dei "fuori linea"
 * (tragitti deposito → prima fermata e ultima fermata → deposito).
 */
import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Map, { Marker, Popup, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  Building2, ArrowLeft, ChevronRight, Loader2, AlertTriangle,
  MapPin, Truck, Clock, Zap, Fuel, Navigation, CheckCircle2, Plus,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

/* ── Tipi ── */
interface Depot {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  capacity: number | null;
  operatingHoursStart: string | null;
  operatingHoursEnd: string | null;
  hasDiesel: boolean;
  hasMethane: boolean;
  hasElectric: boolean;
  chargingPoints: number;
  cngPoints: number;
  color: string;
  notes: string | null;
}

interface Props {
  initial?: string | null;   // depotId preselezionato (rientro dallo step successivo)
  onBack: () => void;
  onComplete: (depotId: string) => void;
}

export default function DepotStep({ initial, onBack, onComplete }: Props) {
  const [depots, setDepots] = useState<Depot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initial ?? null);
  const [popupId, setPopupId] = useState<string | null>(null);
  const mapRef = useRef<MapRef>(null);

  /* ── Fetch ── */
  useEffect(() => {
    setLoading(true);
    fetch(`${getApiBase()}/api/depots`)
      .then(r => r.json())
      .then((data: unknown) => {
        const list: Depot[] = Array.isArray(data) ? data : (data as any)?.data ?? [];
        setDepots(list);
        // pre-seleziona il primo se ce n'è solo uno
        if (!initial && list.length === 1) setSelectedId(list[0].id);
      })
      .catch(() => setError("Impossibile caricare i depositi"))
      .finally(() => setLoading(false));
  }, []);

  /* ── Helpers ── */
  const mappable = depots.filter(d => d.lat != null && d.lon != null);

  const mapCenter = mappable.length > 0
    ? {
        longitude: mappable.reduce((s, d) => s + d.lon!, 0) / mappable.length,
        latitude:  mappable.reduce((s, d) => s + d.lat!, 0) / mappable.length,
      }
    : { longitude: 12.4964, latitude: 41.9028 };

  const flyTo = (d: Depot) => {
    if (d.lat == null || d.lon == null) return;
    mapRef.current?.flyTo({ center: [d.lon, d.lat], zoom: 14, duration: 700 });
    setPopupId(d.id);
  };

  const select = (d: Depot) => {
    setSelectedId(d.id);
    flyTo(d);
  };

  const selected = depots.find(d => d.id === selectedId) ?? null;

  /* ── Render ── */
  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-orange-500/15 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-orange-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-foreground">Deposito di Partenza</h2>
            <p className="text-[10px] text-muted-foreground">
              Da qui partiranno i veicoli — usato per calcolare i fuori linea
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 transition-all border border-border/30"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Indietro
          </button>
          <button
            disabled={!selectedId}
            onClick={() => selectedId && onComplete(selectedId)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-all bg-orange-500 text-black hover:bg-orange-400 shadow-[0_0_12px_rgba(249,115,22,0.3)]"
          >
            Avanti — Cluster
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Mappa ── */}
        <div className="flex-1 relative">
          {MAPBOX_TOKEN ? (
            <Map
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={{ ...mapCenter, zoom: mappable.length > 0 ? 10 : 5 }}
              style={{ width: "100%", height: "100%" }}
              mapStyle="mapbox://styles/mapbox/dark-v11"
            >
              <NavigationControl position="top-right" />

              {mappable.map(d => (
                <React.Fragment key={d.id}>
                  <Marker
                    longitude={d.lon!}
                    latitude={d.lat!}
                    anchor="center"
                    onClick={e => { e.originalEvent.stopPropagation(); select(d); }}
                  >
                    <motion.div
                      animate={{ scale: selectedId === d.id ? 1.35 : 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 20 }}
                      className="cursor-pointer flex flex-col items-center"
                    >
                      <div
                        className="w-10 h-10 rounded-full border-2 flex items-center justify-center shadow-lg"
                        style={{
                          background: d.color,
                          borderColor: selectedId === d.id ? "white" : `${d.color}70`,
                          boxShadow: selectedId === d.id
                            ? `0 0 0 4px ${d.color}40, 0 4px 14px ${d.color}70`
                            : `0 2px 8px ${d.color}50`,
                        }}
                      >
                        <Building2 className="w-4 h-4 text-white" />
                      </div>
                      {/* freccia sotto */}
                      <div
                        className="w-0 h-0"
                        style={{
                          borderLeft: "5px solid transparent",
                          borderRight: "5px solid transparent",
                          borderTop: `7px solid ${d.color}`,
                          marginTop: "-1px",
                        }}
                      />
                    </motion.div>
                  </Marker>

                  {popupId === d.id && (
                    <Popup
                      longitude={d.lon!}
                      latitude={d.lat!}
                      anchor="bottom"
                      offset={[0, -50] as [number, number]}
                      closeButton
                      closeOnClick={false}
                      onClose={() => setPopupId(null)}
                    >
                      <div className="px-3 py-2 min-w-[170px]">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
                          <p className="text-xs font-bold text-foreground">{d.name}</p>
                          {selectedId === d.id && (
                            <CheckCircle2 className="w-3 h-3 text-green-400 ml-auto" />
                          )}
                        </div>
                        {d.address && <p className="text-[10px] text-muted-foreground">{d.address}</p>}
                        {d.capacity != null && (
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
                            <Truck className="w-2.5 h-2.5" /> {d.capacity} bus
                          </p>
                        )}
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {d.hasDiesel   && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">Gasolio</span>}
                          {d.hasMethane  && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/20  text-blue-400  border border-blue-500/30">Metano</span>}
                          {d.hasElectric && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30">Elettrico</span>}
                        </div>
                        {selectedId !== d.id && (
                          <button
                            onClick={() => select(d)}
                            className="mt-2 w-full text-[10px] font-semibold py-1 rounded-lg bg-orange-500 text-black hover:bg-orange-400 transition-all"
                          >
                            Seleziona questo deposito
                          </button>
                        )}
                      </div>
                    </Popup>
                  )}
                </React.Fragment>
              ))}
            </Map>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground bg-muted/10">
              <MapPin className="w-8 h-8 opacity-30" />
              <p className="text-xs">Token Mapbox non configurato</p>
            </div>
          )}

          {/* badge deposito selezionato in overlay */}
          <AnimatePresence>
            {selected && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                className="absolute bottom-4 left-4 flex items-center gap-2 px-3 py-2 rounded-xl bg-black/70 backdrop-blur-sm border border-white/10 shadow-xl"
              >
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: selected.color }} />
                <div>
                  <p className="text-xs font-bold text-white leading-tight">{selected.name}</p>
                  {selected.address && <p className="text-[9px] text-white/50">{selected.address}</p>}
                </div>
                <CheckCircle2 className="w-4 h-4 text-green-400 ml-1" />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Pannello lista ── */}
        <div className="w-80 shrink-0 border-l border-border/30 flex flex-col overflow-hidden bg-background/50">

          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin text-orange-400" />
              <p className="text-xs">Caricamento depositi…</p>
            </div>
          )}

          {!loading && error && (
            <div className="m-3 flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <p className="text-xs">{error}</p>
            </div>
          )}

          {!loading && !error && depots.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center gap-3 py-16 px-4 text-center"
            >
              <div className="w-12 h-12 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-orange-400/50" />
              </div>
              <p className="text-xs font-semibold text-foreground">Nessun deposito configurato</p>
              <p className="text-[10px] text-muted-foreground px-2">
                Vai in <span className="text-orange-400 font-medium">Strumenti → Depositi</span> per aggiungerne almeno uno prima di continuare.
              </p>
            </motion.div>
          )}

          {!loading && !error && depots.length > 0 && (
            <>
              <div className="p-3 border-b border-border/20 shrink-0">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                  {depots.length} deposit{depots.length === 1 ? "o" : "i"} disponibil{depots.length === 1 ? "e" : "i"}
                </p>
                <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                  Seleziona il punto di partenza per i veicoli
                </p>
              </div>

              <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                <AnimatePresence>
                  {depots.map(d => {
                    const isSelected = selectedId === d.id;
                    const hasCoords = d.lat != null && d.lon != null;
                    return (
                      <motion.div
                        key={d.id}
                        layout
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        role="button"
                        tabIndex={0}
                        onClick={() => select(d)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            select(d);
                          }
                        }}
                        className="w-full text-left rounded-xl border px-3 py-2.5 transition-all group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/40"
                        style={{
                          borderColor: isSelected ? d.color : `${d.color}30`,
                          background: isSelected ? `${d.color}15` : `${d.color}07`,
                          boxShadow: isSelected ? `0 0 0 1px ${d.color}50` : undefined,
                        }}
                      >
                        <div className="flex items-start gap-2.5">
                          {/* Pallino + check */}
                          <div className="mt-0.5 shrink-0 relative">
                            <div
                              className="w-8 h-8 rounded-full flex items-center justify-center"
                              style={{
                                background: `${d.color}25`,
                                border: `1.5px solid ${isSelected ? d.color : d.color + "50"}`,
                              }}
                            >
                              {isSelected
                                ? <CheckCircle2 className="w-4 h-4" style={{ color: d.color }} />
                                : <Building2 className="w-3.5 h-3.5" style={{ color: d.color }} />
                              }
                            </div>
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className={`text-xs font-bold truncate ${isSelected ? "text-foreground" : "text-foreground/80"}`}>
                                {d.name}
                              </p>
                              {isSelected && (
                                <span className="text-[8px] px-1.5 py-0.5 rounded-full font-bold bg-orange-500 text-black shrink-0">
                                  SELEZIONATO
                                </span>
                              )}
                            </div>

                            {d.address && (
                              <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                                <MapPin className="w-2.5 h-2.5 shrink-0" />{d.address}
                              </p>
                            )}

                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {d.capacity != null && (
                                <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70">
                                  <Truck className="w-2 h-2" />{d.capacity} bus
                                </span>
                              )}
                              {d.operatingHoursStart && d.operatingHoursEnd && (
                                <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70">
                                  <Clock className="w-2 h-2" />{d.operatingHoursStart}–{d.operatingHoursEnd}
                                </span>
                              )}
                            </div>

                            <div className="flex gap-1 mt-1.5 flex-wrap">
                              {d.hasDiesel   && <span className="text-[8px] px-1 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25">Gasolio</span>}
                              {d.hasMethane  && <span className="text-[8px] px-1 py-0.5 rounded-full bg-blue-500/15  text-blue-400  border border-blue-500/25">Metano</span>}
                              {d.hasElectric && <span className="text-[8px] px-1 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25">Elettrico</span>}
                              {!hasCoords && (
                                <span className="text-[8px] px-1 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 flex items-center gap-0.5">
                                  <MapPin className="w-2 h-2" />Senza coordinate
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Bottone localizza */}
                          {hasCoords && (
                            <button
                              onClick={e => { e.stopPropagation(); flyTo(d); }}
                              className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-blue-400 hover:bg-blue-500/10 transition-all opacity-0 group-hover:opacity-100"
                              title="Centra sulla mappa"
                            >
                              <Navigation className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>

              {/* CTA bottom */}
              <div className="p-3 border-t border-border/20 shrink-0">
                <button
                  disabled={!selectedId}
                  onClick={() => selectedId && onComplete(selectedId)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-all bg-orange-500 text-black hover:bg-orange-400 shadow-[0_0_15px_rgba(249,115,22,0.25)]"
                >
                  {selectedId
                    ? <>Procedi con «{depots.find(d => d.id === selectedId)?.name}» <ChevronRight className="w-3.5 h-3.5" /></>
                    : <>Seleziona un deposito per continuare</>
                  }
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
