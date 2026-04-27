/**
 * GESTIONE DEPOSITI
 *
 * I depositi sono i punti di rimessaggio degli autobus e di presa di servizio
 * dei conducenti. Da qui è possibile creare, modificare ed eliminare i depositi
 * con tutti i dati operativi (posizione, capacità, tipi di rifornimento, orari).
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Map, { Marker, Popup, NavigationControl, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  Building2, Plus, Trash2, Edit3, Save, MapPin, Clock,
  Zap, Fuel, Loader2, AlertTriangle, CheckCircle2, ChevronDown,
  ChevronUp, Truck, Navigation,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

const BASE = () => getApiBase();
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

/* ── Tipi ─────────────────────────────────────────────────── */
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
  createdAt: string;
  updatedAt: string;
}

const DEPOT_COLORS = [
  "#f97316", "#dc2626", "#dc2626", "#ef4444",
  "#ef4444", "#f97316", "#eab308", "#fbbf24",
  "#f59e0b", "#fb923c",
];

const emptyForm = (): Partial<Depot> => ({
  name: "",
  address: "",
  lat: undefined,
  lon: undefined,
  capacity: undefined,
  operatingHoursStart: "",
  operatingHoursEnd: "",
  hasDiesel: false,
  hasMethane: false,
  hasElectric: false,
  chargingPoints: 0,
  cngPoints: 0,
  color: "#f97316",
  notes: "",
});

/* ── Componente form ──────────────────────────────────────── */
function DepotForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial: Partial<Depot>;
  onSave: (data: Partial<Depot>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<Depot>>(initial);

  const set = (key: keyof Depot, value: any) =>
    setForm(prev => ({ ...prev, [key]: value }));

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="bg-card/60 border border-border/40 rounded-2xl p-5 space-y-5"
    >
      {/* Nome + Colore */}
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5">
            Nome deposito *
          </label>
          <input
            value={form.name ?? ""}
            onChange={e => set("name", e.target.value)}
            placeholder="es. Deposito Nord"
            className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-orange-500/60"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5">
            Colore
          </label>
          <div className="flex gap-1.5 flex-wrap max-w-[160px]">
            {DEPOT_COLORS.map(c => (
              <button
                key={c}
                onClick={() => set("color", c)}
                className="w-6 h-6 rounded-full border-2 transition-all"
                style={{
                  background: c,
                  borderColor: form.color === c ? "white" : "transparent",
                  transform: form.color === c ? "scale(1.2)" : "scale(1)",
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Indirizzo */}
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5">
          Indirizzo
        </label>
        <input
          value={form.address ?? ""}
          onChange={e => set("address", e.target.value)}
          placeholder="es. Via Roma 1, Milano"
          className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-orange-500/60"
        />
      </div>

      {/* Posizione */}
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5 flex items-center gap-1">
          <MapPin className="w-3 h-3" /> Posizione (WGS84)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] text-muted-foreground/60 block mb-1">Latitudine</label>
            <input
              type="number"
              step="any"
              value={form.lat ?? ""}
              onChange={e => set("lat", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="es. 45.4654"
              className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-orange-500/60"
            />
          </div>
          <div>
            <label className="text-[9px] text-muted-foreground/60 block mb-1">Longitudine</label>
            <input
              type="number"
              step="any"
              value={form.lon ?? ""}
              onChange={e => set("lon", e.target.value === "" ? null : Number(e.target.value))}
              placeholder="es. 9.1866"
              className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-orange-500/60"
            />
          </div>
        </div>
      </div>

      {/* Capacità + Orari */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5 flex items-center gap-1">
            <Truck className="w-3 h-3" /> Capacità (bus)
          </label>
          <input
            type="number"
            min={0}
            value={form.capacity ?? ""}
            onChange={e => set("capacity", e.target.value === "" ? null : Number(e.target.value))}
            placeholder="es. 40"
            className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-orange-500/60"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Apertura
          </label>
          <input
            type="time"
            value={form.operatingHoursStart ?? ""}
            onChange={e => set("operatingHoursStart", e.target.value)}
            className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-orange-500/60"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5">
            Chiusura
          </label>
          <input
            type="time"
            value={form.operatingHoursEnd ?? ""}
            onChange={e => set("operatingHoursEnd", e.target.value)}
            className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-orange-500/60"
          />
        </div>
      </div>

      {/* Rifornimento */}
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-3 flex items-center gap-1">
          <Fuel className="w-3 h-3" /> Tipi di rifornimento disponibili
        </label>
        <div className="grid grid-cols-3 gap-3">
          {/* Gasolio */}
          <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
            form.hasDiesel ? "border-amber-500/40 bg-amber-500/8" : "border-border/30 bg-muted/10"
          }`}>
            <input type="checkbox" className="sr-only" checked={!!form.hasDiesel}
              onChange={e => set("hasDiesel", e.target.checked)} />
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
              form.hasDiesel ? "bg-amber-500 border-amber-500" : "border-border/50"
            }`}>
              {form.hasDiesel && <CheckCircle2 className="w-3 h-3 text-black" />}
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">Gasolio</p>
              <p className="text-[9px] text-muted-foreground">Diesel</p>
            </div>
          </label>

          {/* Metano */}
          <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
            form.hasMethane ? "border-orange-500/40 bg-orange-500/8" : "border-border/30 bg-muted/10"
          }`}>
            <input type="checkbox" className="sr-only" checked={!!form.hasMethane}
              onChange={e => set("hasMethane", e.target.checked)} />
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
              form.hasMethane ? "bg-orange-500 border-blue-500" : "border-border/50"
            }`}>
              {form.hasMethane && <CheckCircle2 className="w-3 h-3 text-white" />}
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">Metano</p>
              <p className="text-[9px] text-muted-foreground">CNG / GNC</p>
            </div>
          </label>

          {/* Elettrico */}
          <label className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
            form.hasElectric ? "border-amber-500/40 bg-amber-500/8" : "border-border/30 bg-muted/10"
          }`}>
            <input type="checkbox" className="sr-only" checked={!!form.hasElectric}
              onChange={e => set("hasElectric", e.target.checked)} />
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
              form.hasElectric ? "bg-green-500 border-green-500" : "border-border/50"
            }`}>
              {form.hasElectric && <CheckCircle2 className="w-3 h-3 text-white" />}
            </div>
            <div>
              <p className="text-xs font-semibold text-foreground">Elettrico</p>
              <p className="text-[9px] text-muted-foreground">BEV / FCEV</p>
            </div>
          </label>
        </div>

        {/* Punti ricarica / CNG */}
        {(form.hasElectric || form.hasMethane) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="grid grid-cols-2 gap-3 mt-3 overflow-hidden"
          >
            {form.hasElectric && (
              <div>
                <label className="text-[9px] text-muted-foreground/60 block mb-1 flex items-center gap-1">
                  <Zap className="w-3 h-3 text-amber-400" /> Colonnine elettriche
                </label>
                <input
                  type="number" min={0}
                  value={form.chargingPoints ?? 0}
                  onChange={e => set("chargingPoints", Number(e.target.value))}
                  className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-amber-500/60"
                />
              </div>
            )}
            {form.hasMethane && (
              <div>
                <label className="text-[9px] text-muted-foreground/60 block mb-1 flex items-center gap-1">
                  <Fuel className="w-3 h-3 text-orange-400" /> Distributori CNG
                </label>
                <input
                  type="number" min={0}
                  value={form.cngPoints ?? 0}
                  onChange={e => set("cngPoints", Number(e.target.value))}
                  className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-orange-500/60"
                />
              </div>
            )}
          </motion.div>
        )}
      </div>

      {/* Note */}
      <div>
        <label className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-1.5">Note</label>
        <textarea
          rows={2}
          value={form.notes ?? ""}
          onChange={e => set("notes", e.target.value)}
          placeholder="Note operative, accessi, contatti…"
          className="w-full bg-muted/30 border border-border/40 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-orange-500/60 resize-none"
        />
      </div>

      {/* Azioni */}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground border border-border/30 hover:border-border/60 transition-all"
        >
          Annulla
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={saving || !form.name?.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-500 disabled:opacity-40 transition-all"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salva deposito
        </button>
      </div>
    </motion.div>
  );
}

/* ── Card deposito ─────────────────────────────────────────── */
function DepotCard({
  depot,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  depot: Depot;
  selected?: boolean;
  onSelect?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const fuelBadges = [
    depot.hasDiesel  && { label: "Gasolio",  color: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
    depot.hasMethane && { label: "Metano",   color: "text-orange-400  bg-orange-400/10  border-orange-400/20"  },
    depot.hasElectric && { label: "Elettrico", color: "text-amber-400 bg-amber-400/10 border-amber-400/20" },
  ].filter(Boolean) as { label: string; color: string }[];

  return (
    <motion.div
      layout
      className="rounded-xl border overflow-hidden transition-shadow"
      style={{
        borderColor: selected ? depot.color : `${depot.color}33`,
        background: selected ? `${depot.color}14` : `${depot.color}08`,
        boxShadow: selected ? `0 0 0 1px ${depot.color}44` : undefined,
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        {/* Indicatore colore */}
        <div
          className="w-3 h-3 rounded-full shrink-0"
          style={{ background: depot.color, boxShadow: `0 0 6px ${depot.color}66` }}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-foreground truncate">{depot.name}</span>
            {fuelBadges.map(b => (
              <span
                key={b.label}
                className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium ${b.color}`}
              >
                {b.label}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground flex-wrap">
            {depot.address && (
              <span className="flex items-center gap-1">
                <MapPin className="w-2.5 h-2.5" />{depot.address}
              </span>
            )}
            {depot.lat != null && depot.lon != null && (
              <span className="font-mono">{depot.lat.toFixed(4)}, {depot.lon.toFixed(4)}</span>
            )}
            {depot.capacity != null && (
              <span className="flex items-center gap-1">
                <Truck className="w-2.5 h-2.5" />{depot.capacity} bus
              </span>
            )}
            {depot.operatingHoursStart && depot.operatingHoursEnd && (
              <span className="flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />{depot.operatingHoursStart}–{depot.operatingHoursEnd}
              </span>
            )}
          </div>
        </div>

        {/* Azioni */}
        <div className="flex items-center gap-0.5 shrink-0">
          {onSelect && depot.lat != null && depot.lon != null && (
            <button
              onClick={onSelect}
              title="Localizza sulla mappa"
              className={`p-1.5 rounded-lg transition-all ${selected ? "text-orange-400 bg-orange-500/15" : "text-muted-foreground hover:text-orange-400 hover:bg-orange-500/10"}`}
            >
              <Navigation className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => setExpanded(p => !p)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/8 transition-all"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-orange-400 hover:bg-orange-500/10 transition-all"
          >
            <Edit3 className="w-3 h-3" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Dettaglio espanso */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div
              className="border-t px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3"
              style={{ borderColor: `${depot.color}22` }}
            >
              <div>
                <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-1">Capacità</p>
                <p className="text-sm font-bold text-foreground">{depot.capacity ?? "—"} <span className="text-xs font-normal text-muted-foreground">bus</span></p>
              </div>
              <div>
                <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-1">Orari</p>
                <p className="text-sm font-bold text-foreground">
                  {depot.operatingHoursStart && depot.operatingHoursEnd
                    ? `${depot.operatingHoursStart} – ${depot.operatingHoursEnd}`
                    : "—"}
                </p>
              </div>
              {depot.hasElectric && (
                <div>
                  <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-1 flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5 text-amber-400" /> Colonnine
                  </p>
                  <p className="text-sm font-bold text-amber-400">{depot.chargingPoints}</p>
                </div>
              )}
              {depot.hasMethane && (
                <div>
                  <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-1 flex items-center gap-1">
                    <Fuel className="w-2.5 h-2.5 text-orange-400" /> Dist. CNG
                  </p>
                  <p className="text-sm font-bold text-orange-400">{depot.cngPoints}</p>
                </div>
              )}
              {depot.notes && (
                <div className="col-span-2 sm:col-span-4">
                  <p className="text-[9px] text-muted-foreground/50 uppercase tracking-widest mb-1">Note</p>
                  <p className="text-xs text-muted-foreground">{depot.notes}</p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ── Pagina principale ─────────────────────────────────────── */
export default function DepotsPage() {
  const [depots, setDepots] = useState<Depot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingDepot, setEditingDepot] = useState<Depot | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popupId, setPopupId] = useState<string | null>(null);
  const mapRef = useRef<MapRef>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${BASE()}/api/depots`);
      const data = await r.json();
      setDepots(data.data ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (form: Partial<Depot>) => {
    setSaving(true);
    try {
      const url = editingDepot
        ? `${BASE()}/api/depots/${editingDepot.id}`
        : `${BASE()}/api/depots`;
      const method = editingDepot ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!r.ok) throw new Error(await r.text());
      setShowForm(false);
      setEditingDepot(null);
      await load();
    } catch (e: any) {
      alert("Errore nel salvataggio: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Eliminare questo deposito?")) return;
    await fetch(`${BASE()}/api/depots/${id}`, { method: "DELETE" });
    await load();
  };

  const openNew = () => { setEditingDepot(null); setShowForm(true); setSelectedId(null); };
  const openEdit = (d: Depot) => { setEditingDepot(d); setShowForm(true); setSelectedId(d.id); };
  const cancelForm = () => { setShowForm(false); setEditingDepot(null); };

  // Vola sul marker del deposito selezionato
  const flyTo = (d: Depot) => {
    if (d.lat == null || d.lon == null) return;
    mapRef.current?.flyTo({ center: [d.lon, d.lat], zoom: 15, duration: 800 });
    setSelectedId(d.id);
    setPopupId(d.id);
  };

  // Centro mappa calcolato sui depositi con coordinate
  const mappableDepots = depots.filter(d => d.lat != null && d.lon != null);
  const mapCenter = mappableDepots.length > 0
    ? {
        longitude: mappableDepots.reduce((s, d) => s + d.lon!, 0) / mappableDepots.length,
        latitude:  mappableDepots.reduce((s, d) => s + d.lat!, 0) / mappableDepots.length,
      }
    : { longitude: 12.4964, latitude: 41.9028 }; // default: Roma

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-orange-500/15 border border-orange-500/25 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-orange-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-foreground">Gestione Depositi</h1>
            <p className="text-[10px] text-muted-foreground">Rimessaggio autobus · presa di servizio conducenti</p>
          </div>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-500 transition-all shadow-[0_0_12px_rgba(59,130,246,0.3)]"
        >
          <Plus className="w-3.5 h-3.5" />
          Nuovo deposito
        </button>
      </div>

      {/* ── Body: mappa + lista ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Mappa ── */}
        <div className="flex-1 relative">
          {MAPBOX_TOKEN ? (
            <Map
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={{
                ...mapCenter,
                zoom: mappableDepots.length > 0 ? 11 : 6,
              }}
              style={{ width: "100%", height: "100%" }}
              mapStyle="mapbox://styles/mapbox/dark-v11"
            >
              <NavigationControl position="top-right" />

              {mappableDepots.map(d => (
                <React.Fragment key={d.id}>
                  <Marker
                    longitude={d.lon!}
                    latitude={d.lat!}
                    anchor="center"
                    onClick={e => { e.originalEvent.stopPropagation(); setPopupId(d.id); setSelectedId(d.id); }}
                  >
                    <motion.div
                      animate={{ scale: selectedId === d.id ? 1.3 : 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 20 }}
                      className="cursor-pointer flex flex-col items-center"
                    >
                      <div
                        className="w-9 h-9 rounded-full border-2 flex items-center justify-center shadow-lg"
                        style={{
                          background: d.color,
                          borderColor: selectedId === d.id ? "white" : `${d.color}80`,
                          boxShadow: selectedId === d.id
                            ? `0 0 0 4px ${d.color}40, 0 4px 12px ${d.color}60`
                            : `0 2px 8px ${d.color}60`,
                        }}
                      >
                        <Building2 className="w-4 h-4 text-white" />
                      </div>
                      <div
                        className="w-0 h-0"
                        style={{
                          borderLeft: "4px solid transparent",
                          borderRight: "4px solid transparent",
                          borderTop: `6px solid ${d.color}`,
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
                      offset={[0, -46]}
                      closeButton={true}
                      closeOnClick={false}
                      onClose={() => setPopupId(null)}
                      className="depot-popup"
                    >
                      <div className="px-3 py-2 min-w-[160px]">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
                          <p className="text-xs font-bold text-foreground">{d.name}</p>
                        </div>
                        {d.address && (
                          <p className="text-[10px] text-muted-foreground mb-1">{d.address}</p>
                        )}
                        <p className="text-[9px] font-mono text-muted-foreground/50">
                          {d.lat!.toFixed(5)}, {d.lon!.toFixed(5)}
                        </p>
                        {d.capacity != null && (
                          <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
                            <Truck className="w-2.5 h-2.5" /> {d.capacity} bus
                          </p>
                        )}
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {d.hasDiesel   && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">Gasolio</span>}
                          {d.hasMethane  && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30">Metano</span>}
                          {d.hasElectric && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">Elettrico</span>}
                        </div>
                      </div>
                    </Popup>
                  )}
                </React.Fragment>
              ))}
            </Map>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground bg-muted/10">
              <MapPin className="w-8 h-8 opacity-30" />
              <p className="text-xs">Token Mapbox non configurato (VITE_MAPBOX_TOKEN)</p>
            </div>
          )}

          {/* Overlay: nessun deposito con coordinate */}
          {!loading && mappableDepots.length === 0 && depots.length > 0 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-4 py-2 rounded-full border border-white/10">
              Nessun deposito ha coordinate — aggiungile nel form
            </div>
          )}
        </div>

        {/* ── Pannello laterale ── */}
        <div className="w-80 shrink-0 border-l border-border/30 flex flex-col overflow-hidden bg-background/50">

          {/* Form creazione/modifica */}
          <AnimatePresence>
            {showForm && (
              <div className="overflow-y-auto border-b border-border/30">
                <DepotForm
                  initial={editingDepot ?? emptyForm()}
                  onSave={handleSave}
                  onCancel={cancelForm}
                  saving={saving}
                />
              </div>
            )}
          </AnimatePresence>

          {/* Stati caricamento / errore */}
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin text-orange-400" />
              <p className="text-xs">Caricamento…</p>
            </div>
          )}
          {!loading && error && (
            <div className="m-3 flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <p className="text-xs">{error}</p>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && depots.length === 0 && !showForm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center gap-3 py-16 px-4 text-center"
            >
              <div className="w-12 h-12 rounded-2xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-orange-400/50" />
              </div>
              <p className="text-xs font-semibold text-foreground">Nessun deposito</p>
              <p className="text-[10px] text-muted-foreground">Aggiungine uno per visualizzarlo sulla mappa</p>
              <button onClick={openNew} className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-500 transition-all">
                <Plus className="w-3.5 h-3.5" /> Aggiungi
              </button>
            </motion.div>
          )}

          {/* Lista depositi */}
          {!loading && !error && depots.length > 0 && (
            <div className="flex-1 overflow-y-auto">
              {/* Stats */}
              <div className="grid grid-cols-3 gap-2 p-3 border-b border-border/20">
                {[
                  { label: "Totali",    value: depots.length,                                              color: "text-orange-400"  },
                  { label: "Capacità",  value: depots.reduce((s, d) => s + (d.capacity ?? 0), 0),          color: "text-foreground" },
                  { label: "Ricarica",  value: depots.filter(d => d.hasElectric).length,                   color: "text-amber-400" },
                ].map(s => (
                  <div key={s.label} className="bg-muted/20 rounded-lg p-2 text-center">
                    <p className={`text-base font-black ${s.color}`}>{s.value}</p>
                    <p className="text-[8px] text-muted-foreground uppercase tracking-widest">{s.label}</p>
                  </div>
                ))}
              </div>

              <div className="p-2 space-y-1.5">
                <AnimatePresence>
                  {depots.map(d => (
                    <motion.div
                      key={d.id}
                      layout
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                    >
                      <DepotCard
                        depot={d}
                        selected={selectedId === d.id}
                        onSelect={() => flyTo(d)}
                        onEdit={() => openEdit(d)}
                        onDelete={() => handleDelete(d.id)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
