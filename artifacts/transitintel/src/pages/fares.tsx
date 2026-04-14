import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Map, { Source, Layer, Marker, MapRef } from "react-map-gl/mapbox";
import {
  Ticket, Tag, MapPin, Download, Play, Loader2, CheckCircle2, AlertTriangle,
  ChevronDown, Save, RefreshCw, Sparkles, Bus, ArrowRightLeft, Euro,
  FileText, Shield, Zap, Search, Filter, Navigation, Circle, Clock, Trash2, Plus,
  Edit3, Archive, ToggleLeft, ToggleRight, CalendarDays, Users, Info, HelpCircle,
  Hexagon, Crosshair, MousePointer2, Layers,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface RouteNetwork {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  routeColor: string | null;
  networkId: string | null;
  defaultNetworkId: string;
}

interface FareNetwork {
  id: string;
  networkId: string;
  networkName: string;
}

interface FareMedia {
  id: string;
  fareMediaId: string;
  fareMediaName: string;
  fareMediaType: number;
  isActive: boolean;
}

interface RiderCategory {
  id: string;
  riderCategoryId: string;
  riderCategoryName: string;
  isDefault: boolean;
  eligibilityUrl: string | null;
}

interface FareProduct {
  id: string;
  fareProductId: string;
  fareProductName: string;
  networkId: string | null;
  riderCategoryId: string | null;
  fareMediaId: string | null;
  amount: number;
  currency: string;
  durationMinutes: number | null;
  fareType: string;
}

interface FareArea {
  id: string;
  areaId: string;
  areaName: string;
  networkId: string | null;
  routeId: string | null;
  kmFrom: number | null;
  kmTo: number | null;
}

interface RouteStop {
  stopId: string;
  stopName: string;
  sequence: number;
  lat: number;
  lon: number;
  progressiveKm: number;
  kmMin?: number;
  kmMax?: number;
  percorsiCount?: number;
  percorsiDetail?: { shapeId: string; km: number }[];
  suggestedFascia: number | null;
  suggestedAreaId: string | null;
  currentAreaId: string | null;
  currentAreaName: string | null;
}

interface SimulationResult {
  type: "urban" | "extraurban";
  networkId: string;
  routeId?: string;
  fromStop?: { stopId: string; name: string; lat: number; lon: number; km: number };
  toStop?: { stopId: string; name: string; lat: number; lon: number; km: number };
  fromArea?: { areaId: string; name: string; kmFrom: number; kmTo: number };
  toArea?: { areaId: string; name: string; kmFrom: number; kmTo: number };
  distanceKm?: number;
  fascia?: number;
  fareProductId?: string;
  amount?: number;
  currency?: string;
  bandRange?: string;
  intermediateStops?: { stopId: string; stopName: string; lat: number; lon: number; km: number }[];
  products?: { fareProductId: string; name: string; amount: number; currency: string; durationMinutes: number | null }[];
  percorsiCount?: number;
  distanceVariants?: { km: number; shapeId: string }[];
}

interface GenerateResult {
  files: Record<string, string>;
  validation: {
    routesClassified: number;
    totalRoutes: number;
    missingRoutes: string[];
    products: number;
    areas: number;
    stopAreaAssignments: number;
    legRules: number;
    transferRules: number;
    timeframes: number;
    isComplete: boolean;
  };
}

interface CalendarEntry {
  id: string;
  serviceId: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  saturday: number;
  sunday: number;
  startDate: string;
  endDate: string;
}

interface CalendarDateEntry {
  id: string;
  serviceId: string;
  date: string;
  exceptionType: number;
}

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const NETWORK_OPTIONS = [
  { value: "urbano_ancona", label: "Urbano Ancona", color: "#3b82f6" },
  { value: "urbano_jesi", label: "Urbano Jesi", color: "#8b5cf6" },
  { value: "urbano_falconara", label: "Urbano Falconara", color: "#06b6d4" },
  { value: "extraurbano", label: "Extraurbano", color: "#f59e0b" },
];

type Tab = "classify" | "products" | "riders" | "zones" | "timeframes" | "calendar" | "editor" | "generate" | "simulate" | "feedinfo";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "classify", label: "Classificazione Linee", icon: <Tag className="w-3.5 h-3.5" /> },
  { id: "products", label: "Prodotti & Supporti", icon: <Euro className="w-3.5 h-3.5" /> },
  { id: "riders", label: "Categorie Passeggero", icon: <Users className="w-3.5 h-3.5" /> },
  { id: "zones", label: "Zone Extraurbane", icon: <MapPin className="w-3.5 h-3.5" /> },
  { id: "timeframes", label: "Fasce Orarie", icon: <Clock className="w-3.5 h-3.5" /> },
  { id: "calendar", label: "Calendario Servizio", icon: <CalendarDays className="w-3.5 h-3.5" /> },
  { id: "feedinfo", label: "Feed Info", icon: <Info className="w-3.5 h-3.5" /> },
  { id: "editor", label: "Editor Fermate", icon: <Edit3 className="w-3.5 h-3.5" /> },
  { id: "generate", label: "Genera & Esporta", icon: <Download className="w-3.5 h-3.5" /> },
  { id: "simulate", label: "Simulatore", icon: <Play className="w-3.5 h-3.5" /> },
];

// ═══════════════════════════════════════════════════════════
// TAB 1: CLASSIFICAZIONE LINEE
// ═══════════════════════════════════════════════════════════

function ClassifyTab() {
  const { toast } = useToast();
  const [routes, setRoutes] = useState<RouteNetwork[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterNetwork, setFilterNetwork] = useState<string | "all">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<RouteNetwork[]>("/api/fares/route-networks");
      // Auto-classify on first load if routes exist but none assigned
      if (data.length > 0 && data.every(r => !r.networkId)) {
        await apiFetch("/api/fares/networks/seed", { method: "POST" });
        await apiFetch("/api/fares/route-networks/auto-classify", { method: "POST" });
        const fresh = await apiFetch<RouteNetwork[]>("/api/fares/route-networks");
        setRoutes(fresh);
        toast({ title: "Auto-classificazione eseguita", description: `${fresh.length} linee GTFS classificate automaticamente` });
      } else {
        setRoutes(data);
      }
    } catch { /* noop */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const autoClassify = async () => {
    setLoading(true);
    try {
      // Seed networks first
      await apiFetch("/api/fares/networks/seed", { method: "POST" });
      const result = await apiFetch<{ classified: number }>("/api/fares/route-networks/auto-classify", { method: "POST" });
      toast({ title: "Auto-classificazione completata", description: `${result.classified} linee classificate` });
      await load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  };

  const updateRoute = (routeId: string, networkId: string) => {
    setRoutes(prev => prev.map(r => r.routeId === routeId ? { ...r, networkId } : r));
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      const assignments = routes
        .filter(r => r.networkId)
        .map(r => ({ routeId: r.routeId, networkId: r.networkId! }));
      await apiFetch("/api/fares/route-networks/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments }),
      });
      toast({ title: "Salvato", description: `${assignments.length} assegnazioni salvate` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  const filtered = routes.filter(r => {
    const matchSearch = !searchTerm || 
      (r.shortName || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (r.longName || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      r.routeId.toLowerCase().includes(searchTerm.toLowerCase());
    const matchFilter = filterNetwork === "all" || r.networkId === filterNetwork;
    return matchSearch && matchFilter;
  });

  const stats = NETWORK_OPTIONS.map(n => ({
    ...n,
    count: routes.filter(r => r.networkId === n.value).length,
  }));

  if (loading && routes.length === 0) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map(s => (
          <Card key={s.value} className="bg-card/50">
            <CardContent className="p-3">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="text-xs font-medium text-muted-foreground">{s.label}</span>
              </div>
              <p className="text-2xl font-bold mt-1">{s.count}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={autoClassify} variant="outline" size="sm" disabled={loading}>
          <Sparkles className="w-3.5 h-3.5 mr-1.5" />
          Auto-Classifica Tutte
        </Button>
        <Button onClick={saveAll} size="sm" disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
          Salva Classificazione
        </Button>
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Cerca linea..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background/50 w-48 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <select
          value={filterNetwork}
          onChange={e => setFilterNetwork(e.target.value)}
          className="px-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        >
          <option value="all">Tutte le reti</option>
          {NETWORK_OPTIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
          <option value="">Non classificate</option>
        </select>
      </div>

      {/* Table */}
      <Card className="bg-card/50">
        <div className="overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card border-b border-border/30">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Linea</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Descrizione</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Default</th>
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Rete Tariffaria</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.routeId} className="border-b border-border/10 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-8 h-5 rounded text-[10px] font-bold flex items-center justify-center text-white"
                        style={{ backgroundColor: r.routeColor ? `#${r.routeColor}` : "#6b7280" }}
                      >
                        {r.shortName || "?"}
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{r.routeId}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground text-xs truncate max-w-[200px]">
                    {r.longName || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="outline" className="text-[10px]">
                      {NETWORK_OPTIONS.find(n => n.value === r.defaultNetworkId)?.label || r.defaultNetworkId}
                    </Badge>
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={r.networkId || ""}
                      onChange={e => updateRoute(r.routeId, e.target.value)}
                      className="px-2 py-1 text-xs rounded border border-border/50 bg-background/50 w-full max-w-[180px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                    >
                      <option value="">— Seleziona —</option>
                      {NETWORK_OPTIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted-foreground text-right">
        {filtered.length} di {routes.length} linee visualizzate
      </p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 2: PRODOTTI & SUPPORTI
// ═══════════════════════════════════════════════════════════

function ProductsTab() {
  const { toast } = useToast();
  const [products, setProducts] = useState<FareProduct[]>([]);
  const [media, setMedia] = useState<FareMedia[]>([]);
  const [categories, setCategories] = useState<RiderCategory[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, m, c] = await Promise.all([
        apiFetch<FareProduct[]>("/api/fares/products"),
        apiFetch<FareMedia[]>("/api/fares/media"),
        apiFetch<RiderCategory[]>("/api/fares/rider-categories"),
      ]);
      // Auto-seed on first load if products empty
      if (p.length === 0) {
        await apiFetch("/api/fares/networks/seed", { method: "POST" });
        await apiFetch("/api/fares/media/seed", { method: "POST" });
        await apiFetch("/api/fares/rider-categories/seed", { method: "POST" });
        await apiFetch("/api/fares/products/seed", { method: "POST" });
        const [p2, m2, c2] = await Promise.all([
          apiFetch<FareProduct[]>("/api/fares/products"),
          apiFetch<FareMedia[]>("/api/fares/media"),
          apiFetch<RiderCategory[]>("/api/fares/rider-categories"),
        ]);
        setProducts(p2);
        setMedia(m2);
        setCategories(c2);
        toast({ title: "Inizializzazione automatica", description: "Reti, supporti, categorie e prodotti configurati" });
      } else {
        setProducts(p);
        setMedia(m);
        setCategories(c);
      }
    } catch { /* noop */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const seedAll = async () => {
    setLoading(true);
    try {
      await apiFetch("/api/fares/networks/seed", { method: "POST" });
      await apiFetch("/api/fares/media/seed", { method: "POST" });
      await apiFetch("/api/fares/rider-categories/seed", { method: "POST" });
      await apiFetch("/api/fares/products/seed", { method: "POST" });
      toast({ title: "Inizializzazione completata", description: "Reti, supporti, categorie e prodotti creati" });
      await load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  };

  const toggleMedia = async (fareMediaId: string, isActive: boolean) => {
    try {
      await apiFetch(`/api/fares/media/${fareMediaId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      setMedia(prev => prev.map(m => m.fareMediaId === fareMediaId ? { ...m, isActive } : m));
    } catch { /* noop */ }
  };

  const updatePrice = async (id: string, amount: number) => {
    try {
      await apiFetch(`/api/fares/products/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      setProducts(prev => prev.map(p => p.id === id ? { ...p, amount } : p));
      toast({ title: "Prezzo aggiornato" });
    } catch { /* noop */ }
  };

  if (loading && products.length === 0) return <LoadingSpinner />;

  const urbanProducts = products.filter(p => p.fareType !== "zone");
  const extraProducts = products.filter(p => p.fareType === "zone").sort((a, b) => a.amount - b.amount);

  return (
    <div className="space-y-6">
      {products.length === 0 && (
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="p-6 text-center space-y-3">
            <Sparkles className="w-8 h-8 text-primary mx-auto" />
            <p className="font-medium">Nessun prodotto tariffario configurato</p>
            <p className="text-sm text-muted-foreground">
              Inizializza le reti, i supporti e i prodotti con i valori di default ATMA.
            </p>
            <Button onClick={seedAll} className="mt-2">
              <Sparkles className="w-4 h-4 mr-2" />
              Inizializza Tutto
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Warning: products with fare_media_id set */}
      {products.filter(p => p.fareMediaId).length > 0 && (
        <Card className="bg-amber-500/5 border-amber-500/20">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-700">Attenzione: {products.filter(p => p.fareMediaId).length} prodotti hanno <code className="text-xs bg-amber-100 px-1 rounded">fare_media_id</code> impostato</p>
              <p className="text-xs text-muted-foreground mt-1">
                Nello standard GTFS Fares V2, i prodotti non dovrebbero avere <code>fare_media_id</code> forzato.
                Il legame prodotto↔supporto avviene tramite le leg rules. Clicca per correggere.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 border-amber-500/30 text-amber-700 hover:bg-amber-500/10"
                onClick={async () => {
                  try {
                    const res = await apiFetch<{ updated: number }>("/api/fares/products/fix-media", { method: "POST" });
                    toast({ title: "✅ Corretto", description: `${res.updated} prodotti aggiornati (fare_media_id → NULL)` });
                    await load();
                  } catch (e: any) { toast({ title: "Errore", description: e.message, variant: "destructive" }); }
                }}
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Rimuovi fare_media_id
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Fare Media */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Supporti Tariffari (fare_media)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {media.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessun supporto configurato. Clicca "Inizializza Tutto".</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {media.map(m => (
                <label key={m.fareMediaId} className="flex items-center gap-3 p-3 rounded-lg border border-border/30 hover:bg-muted/20 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={m.isActive}
                    onChange={e => toggleMedia(m.fareMediaId, e.target.checked)}
                    className="rounded border-border accent-primary"
                  />
                  <div>
                    <p className="text-sm font-medium">{m.fareMediaName}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">type={m.fareMediaType} · {m.fareMediaId}</p>
                  </div>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Urban Products */}
      {urbanProducts.length > 0 && (
        <Card className="bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="w-4 h-4 text-primary" />
              Prodotti Urbani
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="text-left py-2 font-medium text-muted-foreground">Prodotto</th>
                  <th className="text-left py-2 font-medium text-muted-foreground">Rete</th>
                  <th className="text-left py-2 font-medium text-muted-foreground">Tipo</th>
                  <th className="text-left py-2 font-medium text-muted-foreground">Validità</th>
                  <th className="text-right py-2 font-medium text-muted-foreground">Prezzo (€)</th>
                </tr>
              </thead>
              <tbody>
                {urbanProducts.map(p => (
                  <tr key={p.id} className="border-b border-border/10">
                    <td className="py-2 font-medium">{p.fareProductName}</td>
                    <td className="py-2">
                      <Badge variant="outline" className="text-[10px]">
                        {NETWORK_OPTIONS.find(n => n.value === p.networkId)?.label || p.networkId}
                      </Badge>
                    </td>
                    <td className="py-2 text-muted-foreground">{p.fareType === "return" ? "A/R" : "Singolo"}</td>
                    <td className="py-2 text-muted-foreground">{p.durationMinutes ? `${p.durationMinutes} min` : "—"}</td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        step="0.05"
                        value={p.amount}
                        onChange={e => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) setProducts(prev => prev.map(x => x.id === p.id ? { ...x, amount: val } : x));
                        }}
                        onBlur={e => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) updatePrice(p.id, val);
                        }}
                        className="w-20 text-right px-2 py-1 text-sm rounded border border-border/50 bg-background/50 font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Extraurban fare bands */}
      {extraProducts.length > 0 && (
        <Card className="bg-card/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-primary" />
              Fasce Chilometriche Extraurbane (DGR Marche)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-auto max-h-[400px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border/30">
                    <th className="text-left py-2 font-medium text-muted-foreground">Fascia</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">ID Prodotto</th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Prezzo (€)</th>
                  </tr>
                </thead>
                <tbody>
                  {extraProducts.map(p => (
                    <tr key={p.id} className="border-b border-border/10 hover:bg-muted/10">
                      <td className="py-1.5">{p.fareProductName}</td>
                      <td className="py-1.5 font-mono text-xs text-muted-foreground">{p.fareProductId}</td>
                      <td className="py-1.5 text-right">
                        <input
                          type="number"
                          step="0.05"
                          value={p.amount}
                          onChange={e => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) setProducts(prev => prev.map(x => x.id === p.id ? { ...x, amount: val } : x));
                          }}
                          onBlur={e => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val)) updatePrice(p.id, val);
                          }}
                          className="w-20 text-right px-2 py-1 text-sm rounded border border-border/50 bg-background/50 font-mono focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: CATEGORIE PASSEGGERO (rider_categories) — GUIDATO
// ═══════════════════════════════════════════════════════════

const RIDER_PRESETS = [
  { riderCategoryId: "ordinario", riderCategoryName: "Tariffa Ordinaria", desc: "Tariffa standard applicata a tutti i passeggeri adulti senza riduzioni." },
  { riderCategoryId: "studente", riderCategoryName: "Studenti", desc: "Per studenti fino a 26 anni con tessera di iscrizione scolastica/universitaria." },
  { riderCategoryId: "anziano", riderCategoryName: "Anziani (over 65)", desc: "Per passeggeri con età superiore a 65 anni." },
  { riderCategoryId: "disabile", riderCategoryName: "Disabili", desc: "Per persone con disabilità certificate (L. 104/92)." },
  { riderCategoryId: "bambino", riderCategoryName: "Bambini (6-14)", desc: "Per bambini da 6 a 14 anni. Sotto i 6 anni il trasporto è gratuito." },
];

function RiderCategoriesTab() {
  const { toast } = useToast();
  const [categories, setCategories] = useState<RiderCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ riderCategoryName: string; eligibilityUrl: string }>({
    riderCategoryName: "", eligibilityUrl: "",
  });
  const [showAdd, setShowAdd] = useState(false);
  const [newForm, setNewForm] = useState({ riderCategoryId: "", riderCategoryName: "", eligibilityUrl: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<RiderCategory[]>("/api/fares/rider-categories");
      if (data.length === 0) {
        await apiFetch("/api/fares/rider-categories/seed", { method: "POST" });
        const seeded = await apiFetch<RiderCategory[]>("/api/fares/rider-categories");
        setCategories(seeded);
      } else {
        setCategories(data);
      }
    } catch { /* noop */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const addCategory = async () => {
    if (!newForm.riderCategoryId || !newForm.riderCategoryName) {
      toast({ title: "Errore", description: "ID e Nome sono obbligatori", variant: "destructive" });
      return;
    }
    try {
      const rows = await apiFetch<RiderCategory[]>("/api/fares/rider-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm),
      });
      setCategories(rows);
      setNewForm({ riderCategoryId: "", riderCategoryName: "", eligibilityUrl: "" });
      setShowAdd(false);
      toast({ title: "Categoria aggiunta" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const addPreset = async (preset: typeof RIDER_PRESETS[0]) => {
    try {
      const rows = await apiFetch<RiderCategory[]>("/api/fares/rider-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ riderCategoryId: preset.riderCategoryId, riderCategoryName: preset.riderCategoryName }),
      });
      setCategories(rows);
      toast({ title: `Categoria "${preset.riderCategoryName}" aggiunta` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const saveEdit = async (id: string) => {
    try {
      const rows = await apiFetch<RiderCategory[]>(`/api/fares/rider-categories/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      setCategories(rows);
      setEditingId(null);
      toast({ title: "Categoria aggiornata" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const deleteCategory = async (id: string) => {
    try {
      await apiFetch(`/api/fares/rider-categories/${id}`, { method: "DELETE" });
      setCategories(prev => prev.filter(c => c.id !== id));
      toast({ title: "Categoria rimossa" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  if (loading && categories.length === 0) return <LoadingSpinner />;

  const existingIds = new Set(categories.map(c => c.riderCategoryId));

  return (
    <div className="space-y-6">
      {/* Spiegazione guidata */}
      <Card className="bg-blue-500/5 border-blue-500/20">
        <CardContent className="p-5">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
            <div className="space-y-2 text-sm">
              <p className="font-semibold text-blue-600">Cos'è il file rider_categories.txt?</p>
              <p className="text-muted-foreground">
                Definisce le <strong>categorie di passeggero</strong> a cui si applicano tariffe differenziate.
                Ogni azienda TPL può offrire sconti per studenti, anziani, disabili, ecc.
              </p>
              <div className="grid gap-1.5 mt-2 text-xs text-muted-foreground">
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">rider_category_id</Badge>
                  <span>Codice univoco (es. "studente", "anziano"). Usato internamente per collegare i prodotti tariffari.</span>
                </div>
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">rider_category_name</Badge>
                  <span>Nome leggibile mostrato all'utente (es. "Studenti", "Anziani over 65").</span>
                </div>
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">is_default</Badge>
                  <span>Se <strong>1</strong>, è la tariffa applicata quando non viene specificata una categoria (tipicamente "ordinario").</span>
                </div>
                <div className="flex items-start gap-2">
                  <Badge variant="outline" className="text-[10px] shrink-0 mt-0.5">eligibility_url</Badge>
                  <span>URL (opzionale) a una pagina web con i requisiti per ottenere la tariffa agevolata.</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Categorie esistenti */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Categorie configurate
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => setShowAdd(true)} className="gap-1">
              <Plus className="w-3.5 h-3.5" /> Aggiungi
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna categoria. Usa i preset suggeriti qui sotto.</p>
          ) : (
            <div className="space-y-2">
              {categories.map(c => (
                <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg border border-border/30 hover:bg-muted/20 transition-colors">
                  {editingId === c.id ? (
                    <div className="flex-1 space-y-2">
                      <div className="flex gap-2">
                        <input
                          className="flex-1 px-3 py-1.5 text-sm rounded border border-border bg-background/50"
                          placeholder="Nome categoria"
                          value={editForm.riderCategoryName}
                          onChange={e => setEditForm(p => ({ ...p, riderCategoryName: e.target.value }))}
                        />
                        <input
                          className="flex-1 px-3 py-1.5 text-sm rounded border border-border bg-background/50"
                          placeholder="URL eleggibilità (opzionale)"
                          value={editForm.eligibilityUrl}
                          onChange={e => setEditForm(p => ({ ...p, eligibilityUrl: e.target.value }))}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => saveEdit(c.id)} className="gap-1">
                          <Save className="w-3 h-3" /> Salva
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>Annulla</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{c.riderCategoryName}</span>
                          {c.isDefault && <Badge variant="default" className="text-[10px]">DEFAULT</Badge>}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs font-mono text-muted-foreground">id: {c.riderCategoryId}</span>
                          {c.eligibilityUrl && (
                            <a href={c.eligibilityUrl} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-blue-500 hover:underline truncate max-w-[200px]">
                              {c.eligibilityUrl}
                            </a>
                          )}
                        </div>
                      </div>
                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0"
                        onClick={() => { setEditingId(c.id); setEditForm({ riderCategoryName: c.riderCategoryName, eligibilityUrl: c.eligibilityUrl || "" }); }}>
                        <Edit3 className="w-3.5 h-3.5" />
                      </Button>
                      {!c.isDefault && (
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => deleteCategory(c.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Form aggiunta manuale */}
      {showAdd && (
        <Card className="bg-card/50 border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Nuova Categoria (manuale)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  rider_category_id *
                  <HelpCircle className="w-3 h-3 inline ml-1 text-muted-foreground/60" />
                </label>
                <input className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  placeholder="es. militare"
                  value={newForm.riderCategoryId}
                  onChange={e => setNewForm(p => ({ ...p, riderCategoryId: e.target.value.toLowerCase().replace(/\s+/g, "_") }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  rider_category_name *
                </label>
                <input className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  placeholder="es. Militari e Forze dell'Ordine"
                  value={newForm.riderCategoryName}
                  onChange={e => setNewForm(p => ({ ...p, riderCategoryName: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  eligibility_url
                </label>
                <input className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  placeholder="https://www.atmaancona.it/tariffe/..."
                  value={newForm.eligibilityUrl}
                  onChange={e => setNewForm(p => ({ ...p, eligibilityUrl: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addCategory} className="gap-1">
                <Plus className="w-3.5 h-3.5" /> Aggiungi
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Annulla</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Preset suggeriti */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            Categorie Suggerite
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Clicca per aggiungere rapidamente una categoria comune. Le categorie già presenti sono disabilitate.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {RIDER_PRESETS.map(p => (
              <button
                key={p.riderCategoryId}
                disabled={existingIds.has(p.riderCategoryId)}
                onClick={() => addPreset(p)}
                className={`text-left p-3 rounded-lg border transition-colors ${
                  existingIds.has(p.riderCategoryId)
                    ? "border-border/20 bg-muted/10 opacity-50 cursor-not-allowed"
                    : "border-border/30 hover:bg-primary/5 hover:border-primary/30 cursor-pointer"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.riderCategoryName}</span>
                  {existingIds.has(p.riderCategoryId) && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{p.desc}</p>
                <span className="text-[10px] font-mono text-muted-foreground/60 mt-1 block">id: {p.riderCategoryId}</span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: CALENDARIO SERVIZIO (calendar.txt + calendar_dates.txt) — GUIDATO
// ═══════════════════════════════════════════════════════════

const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const DAY_LABELS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

const CALENDAR_PRESETS = [
  { serviceId: "feriale", label: "Feriale (Lun-Ven)", days: [1, 1, 1, 1, 1, 0, 0] },
  { serviceId: "sabato", label: "Sabato", days: [0, 0, 0, 0, 0, 1, 0] },
  { serviceId: "festivo", label: "Festivo (Domenica)", days: [0, 0, 0, 0, 0, 0, 1] },
  { serviceId: "lun_sab", label: "Lun-Sab", days: [1, 1, 1, 1, 1, 1, 0] },
  { serviceId: "tutti", label: "Tutti i giorni", days: [1, 1, 1, 1, 1, 1, 1] },
];

function CalendarTab() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<CalendarEntry[]>([]);
  const [dates, setDates] = useState<CalendarDateEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [showAddException, setShowAddException] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form per nuovo service
  const [newServiceId, setNewServiceId] = useState("");
  const [newDays, setNewDays] = useState([0, 0, 0, 0, 0, 0, 0]);
  const [newStartDate, setNewStartDate] = useState(() => {
    const y = new Date().getFullYear();
    return `${y}-01-01`;
  });
  const [newEndDate, setNewEndDate] = useState(() => {
    const y = new Date().getFullYear();
    return `${y}-12-31`;
  });

  // Form per eccezione
  const [excServiceId, setExcServiceId] = useState("");
  const [excDate, setExcDate] = useState("");
  const [excType, setExcType] = useState<1 | 2>(2);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cal, calDates] = await Promise.all([
        apiFetch<CalendarEntry[]>("/api/fares/calendar"),
        apiFetch<CalendarDateEntry[]>("/api/fares/calendar-dates"),
      ]);
      setEntries(cal);
      setDates(calDates);
    } catch { /* noop */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const seedDefaults = async () => {
    try {
      const rows = await apiFetch<CalendarEntry[]>("/api/fares/calendar/seed", { method: "POST" });
      setEntries(rows);
      toast({ title: "Calendario inizializzato", description: "Creati: Feriale, Sabato, Festivo" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const addEntry = async () => {
    if (!newServiceId) {
      toast({ title: "Errore", description: "Inserisci un Service ID", variant: "destructive" });
      return;
    }
    const startDate = newStartDate.replace(/-/g, "");
    const endDate = newEndDate.replace(/-/g, "");
    const body: Record<string, unknown> = { serviceId: newServiceId, startDate, endDate };
    DAY_NAMES.forEach((d, i) => { body[d] = newDays[i]; });
    try {
      const rows = await apiFetch<CalendarEntry[]>("/api/fares/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setEntries(rows);
      setShowAddEntry(false);
      setNewServiceId("");
      setNewDays([0, 0, 0, 0, 0, 0, 0]);
      toast({ title: "Servizio aggiunto" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const applyPreset = (preset: typeof CALENDAR_PRESETS[0]) => {
    setNewServiceId(preset.serviceId);
    setNewDays([...preset.days]);
  };

  const updateEntry = async (id: string, updates: Record<string, unknown>) => {
    try {
      const rows = await apiFetch<CalendarEntry[]>(`/api/fares/calendar/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      setEntries(rows);
      setEditingId(null);
      toast({ title: "Servizio aggiornato" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const deleteEntry = async (id: string) => {
    try {
      await apiFetch(`/api/fares/calendar/${id}`, { method: "DELETE" });
      setEntries(prev => prev.filter(e => e.id !== id));
      toast({ title: "Servizio rimosso" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const addException = async () => {
    if (!excServiceId || !excDate) {
      toast({ title: "Errore", description: "Seleziona servizio e data", variant: "destructive" });
      return;
    }
    try {
      const rows = await apiFetch<CalendarDateEntry[]>("/api/fares/calendar-dates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: excServiceId, date: excDate.replace(/-/g, ""), exceptionType: excType }),
      });
      setDates(rows);
      setShowAddException(false);
      setExcDate("");
      toast({ title: "Eccezione aggiunta" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const deleteException = async (id: string) => {
    try {
      await apiFetch(`/api/fares/calendar-dates/${id}`, { method: "DELETE" });
      setDates(prev => prev.filter(d => d.id !== id));
      toast({ title: "Eccezione rimossa" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  const formatDate = (d: string) => {
    if (d.length === 8) return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
    return d;
  };

  if (loading && entries.length === 0) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      {/* Spiegazione guidata */}
      <Card className="bg-blue-500/5 border-blue-500/20">
        <CardContent className="p-5">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
            <div className="space-y-2 text-sm">
              <p className="font-semibold text-blue-600">Cos'è il file calendar.txt?</p>
              <p className="text-muted-foreground">
                Definisce i <strong>pattern settimanali di servizio</strong>: per ogni service_id indica in quali giorni della settimana 
                il servizio è attivo e il periodo di validità (start_date / end_date).
              </p>
              <p className="text-muted-foreground">
                Le <strong>eccezioni</strong> (calendar_dates.txt) permettono di aggiungere o rimuovere il servizio in date specifiche 
                (es. festività infrasettimanali, scioperi, servizi speciali natalizi).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Servizi esistenti */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-primary" />
              Pattern Settimanali (calendar.txt)
            </CardTitle>
            <div className="flex gap-2">
              {entries.length === 0 && (
                <Button size="sm" variant="default" onClick={seedDefaults} className="gap-1">
                  <Sparkles className="w-3.5 h-3.5" /> Inizializza Feriale/Sabato/Festivo
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setShowAddEntry(true)} className="gap-1">
                <Plus className="w-3.5 h-3.5" /> Nuovo
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <div className="text-center py-6 space-y-2">
              <CalendarDays className="w-8 h-8 text-muted-foreground/40 mx-auto" />
              <p className="text-sm text-muted-foreground">Nessun pattern di servizio definito.</p>
              <p className="text-xs text-muted-foreground">Clicca "Inizializza" per creare i 3 pattern base (Feriale, Sabato, Festivo).</p>
            </div>
          ) : (
            <div className="space-y-2">
              {entries.map(e => (
                <CalendarRow
                  key={e.id}
                  entry={e}
                  isEditing={editingId === e.id}
                  onEdit={() => setEditingId(e.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSave={(updates) => updateEntry(e.id, updates)}
                  onDelete={() => deleteEntry(e.id)}
                  formatDate={formatDate}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Form aggiunta con preset */}
      {showAddEntry && (
        <Card className="bg-card/50 border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Nuovo Pattern di Servizio</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Quick presets */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Preset rapidi:</p>
              <div className="flex flex-wrap gap-2">
                {CALENDAR_PRESETS.map(p => (
                  <Button
                    key={p.serviceId}
                    size="sm"
                    variant={newServiceId === p.serviceId ? "default" : "outline"}
                    onClick={() => applyPreset(p)}
                    className="text-xs"
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">service_id *</label>
                <input
                  className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  placeholder="es. feriale_estivo"
                  value={newServiceId}
                  onChange={e => setNewServiceId(e.target.value.toLowerCase().replace(/\s+/g, "_"))}
                />
              </div>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Da</label>
                  <input type="date" className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                    value={newStartDate} onChange={e => setNewStartDate(e.target.value)} />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">A</label>
                  <input type="date" className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                    value={newEndDate} onChange={e => setNewEndDate(e.target.value)} />
                </div>
              </div>
            </div>

            {/* Day checkboxes */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Giorni attivi:</label>
              <div className="flex gap-2">
                {DAY_LABELS.map((label, i) => (
                  <button
                    key={label}
                    onClick={() => setNewDays(prev => { const n = [...prev]; n[i] = n[i] ? 0 : 1; return n; })}
                    className={`w-10 h-10 rounded-lg text-xs font-bold border transition-all ${
                      newDays[i]
                        ? "bg-primary text-primary-foreground border-primary shadow-sm"
                        : "bg-muted/20 text-muted-foreground border-border/30 hover:bg-muted/40"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={addEntry} className="gap-1">
                <Plus className="w-3.5 h-3.5" /> Aggiungi
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddEntry(false)}>Annulla</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Eccezioni (calendar_dates.txt) */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Eccezioni (calendar_dates.txt)
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => setShowAddException(true)} className="gap-1"
              disabled={entries.length === 0}>
              <Plus className="w-3.5 h-3.5" /> Aggiungi Eccezione
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {dates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nessuna eccezione definita. Usa le eccezioni per gestire festività infrasettimanali o servizi speciali.
            </p>
          ) : (
            <div className="overflow-auto max-h-[300px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border/30">
                    <th className="text-left py-2 font-medium text-muted-foreground">Servizio</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Data</th>
                    <th className="text-left py-2 font-medium text-muted-foreground">Tipo</th>
                    <th className="text-right py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {dates.map(d => (
                    <tr key={d.id} className="border-b border-border/10 hover:bg-muted/10">
                      <td className="py-1.5 font-mono text-xs">{d.serviceId}</td>
                      <td className="py-1.5">{formatDate(d.date)}</td>
                      <td className="py-1.5">
                        <Badge variant={d.exceptionType === 1 ? "default" : "destructive"} className="text-[10px]">
                          {d.exceptionType === 1 ? "Aggiunto" : "Rimosso"}
                        </Badge>
                      </td>
                      <td className="py-1.5 text-right">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive"
                          onClick={() => deleteException(d.id)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Form aggiunta eccezione */}
      {showAddException && (
        <Card className="bg-card/50 border-amber-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Nuova Eccezione</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              <strong>Tipo 1 (Aggiunto):</strong> aggiunge il servizio in una data in cui normalmente non c'è (es. servizio festivo il 25 aprile).
              <br />
              <strong>Tipo 2 (Rimosso):</strong> rimuove il servizio in una data in cui normalmente c'è (es. sciopero, chiusura straordinaria).
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Servizio</label>
                <select className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  value={excServiceId} onChange={e => setExcServiceId(e.target.value)}>
                  <option value="">Seleziona…</option>
                  {entries.map(e => (
                    <option key={e.serviceId} value={e.serviceId}>{e.serviceId}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Data</label>
                <input type="date" className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  value={excDate} onChange={e => setExcDate(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Tipo eccezione</label>
                <select className="w-full px-3 py-2 text-sm rounded border border-border bg-background/50"
                  value={excType} onChange={e => setExcType(Number(e.target.value) as 1 | 2)}>
                  <option value={1}>1 — Servizio AGGIUNTO</option>
                  <option value={2}>2 — Servizio RIMOSSO</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={addException} className="gap-1">
                <Plus className="w-3.5 h-3.5" /> Aggiungi Eccezione
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddException(false)}>Annulla</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Sub-component for inline editing of a calendar row
function CalendarRow({
  entry, isEditing, onEdit, onCancelEdit, onSave, onDelete, formatDate,
}: {
  entry: CalendarEntry;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (updates: Record<string, unknown>) => void;
  onDelete: () => void;
  formatDate: (d: string) => string;
}) {
  const [days, setDays] = useState(DAY_NAMES.map(d => entry[d]));
  const [startDate, setStartDate] = useState(
    entry.startDate.length === 8
      ? `${entry.startDate.slice(0, 4)}-${entry.startDate.slice(4, 6)}-${entry.startDate.slice(6, 8)}`
      : entry.startDate
  );
  const [endDate, setEndDate] = useState(
    entry.endDate.length === 8
      ? `${entry.endDate.slice(0, 4)}-${entry.endDate.slice(4, 6)}-${entry.endDate.slice(6, 8)}`
      : entry.endDate
  );

  const handleSave = () => {
    const updates: Record<string, unknown> = {
      startDate: startDate.replace(/-/g, ""),
      endDate: endDate.replace(/-/g, ""),
    };
    DAY_NAMES.forEach((d, i) => { updates[d] = days[i]; });
    onSave(updates);
  };

  return (
    <div className="p-3 rounded-lg border border-border/30 hover:bg-muted/10 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">{entry.serviceId}</span>
          <span className="text-xs text-muted-foreground">
            {formatDate(entry.startDate)} → {formatDate(entry.endDate)}
          </span>
        </div>
        <div className="flex gap-1">
          {isEditing ? (
            <>
              <Button size="sm" onClick={handleSave} className="h-7 gap-1 text-xs">
                <Save className="w-3 h-3" /> Salva
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancelEdit}>Annulla</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onEdit}>
                <Edit3 className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={onDelete}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <div className="flex gap-2">
            {DAY_LABELS.map((label, i) => (
              <button
                key={label}
                onClick={() => setDays(prev => { const n = [...prev]; n[i] = n[i] ? 0 : 1; return n; })}
                className={`w-10 h-10 rounded-lg text-xs font-bold border transition-all ${
                  days[i]
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-muted/20 text-muted-foreground border-border/30 hover:bg-muted/40"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Da</label>
              <input type="date" className="w-full px-2 py-1 text-sm rounded border border-border bg-background/50"
                value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">A</label>
              <input type="date" className="w-full px-2 py-1 text-sm rounded border border-border bg-background/50"
                value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          {DAY_LABELS.map((label, i) => (
            <span
              key={label}
              className={`w-8 h-8 rounded text-[10px] font-bold flex items-center justify-center ${
                entry[DAY_NAMES[i]]
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-muted/10 text-muted-foreground/40 border border-transparent"
              }`}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 3: ZONE EXTRAURBANE
// ═══════════════════════════════════════════════════════════

function ZonesTab() {
  const { toast } = useToast();
  const [routeNets, setRouteNets] = useState<RouteNetwork[]>([]);
  const [areas, setAreas] = useState<FareArea[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [routeStops, setRouteStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [loadingStops, setLoadingStops] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rn, a] = await Promise.all([
        apiFetch<RouteNetwork[]>("/api/fares/route-networks"),
        apiFetch<FareArea[]>("/api/fares/areas"),
      ]);
      setRouteNets(rn);
      setAreas(a);
    } catch { /* noop */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const extraRoutes = routeNets.filter(r => r.networkId === "extraurbano");
  const extraAreas = areas.filter(a => a.networkId === "extraurbano");

  const generateAll = async () => {
    setGenerating(true);
    try {
      const result = await apiFetch<any>("/api/fares/zones/generate-all", { method: "POST" });
      toast({
        title: "Zone generate",
        description: `${result.urbanAreas} aree urbane + ${result.totalZones} zone extraurbane su ${result.extraurbanRoutes} linee`,
      });
      await load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setGenerating(false);
  };

  const loadRouteStops = async (routeId: string) => {
    setSelectedRoute(routeId);
    setLoadingStops(true);
    try {
      const data = await apiFetch<RouteStop[]>(`/api/fares/route-stops/${routeId}`);
      setRouteStops(data);
    } catch { setRouteStops([]); }
    setLoadingStops(false);
  };

  if (loading && routeNets.length === 0) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="bg-card/50">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Linee Extraurbane</p>
            <p className="text-2xl font-bold">{extraRoutes.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Zone Create</p>
            <p className="text-2xl font-bold">{extraAreas.length}</p>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Aree Totali</p>
            <p className="text-2xl font-bold">{areas.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button onClick={generateAll} disabled={generating} size="sm">
          {generating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
          Genera Tutte le Zone
        </Button>
        <p className="text-xs text-muted-foreground">
          Calcola le zone km per ogni linea extraurbana + aree urbane flat
        </p>
      </div>

      {/* Route picker + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Route list */}
        <Card className="bg-card/50 lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Linee Extraurbane</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[50vh] overflow-auto">
              {extraRoutes.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  Nessuna linea classificata come extraurbana. Vai al tab "Classificazione Linee" prima.
                </p>
              ) : (
                extraRoutes.map(r => {
                  const routeAreaCount = extraAreas.filter(a => a.routeId === r.routeId).length;
                  return (
                    <button
                      key={r.routeId}
                      onClick={() => loadRouteStops(r.routeId)}
                      className={`w-full text-left px-4 py-2.5 border-b border-border/10 hover:bg-muted/20 transition-colors flex items-center justify-between ${selectedRoute === r.routeId ? "bg-primary/10 border-l-2 border-l-primary" : ""}`}
                    >
                      <div>
                        <span className="font-medium text-sm">{r.shortName || r.routeId}</span>
                        <span className="text-xs text-muted-foreground ml-2 truncate">{r.longName}</span>
                      </div>
                      {routeAreaCount > 0 && (
                        <Badge variant="secondary" className="text-[10px] shrink-0">{routeAreaCount} zone</Badge>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>

        {/* Stop detail */}
        <Card className="bg-card/50 lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {selectedRoute ? `Fermate Linea ${selectedRoute}` : "Seleziona una linea"}
            </CardTitle>
            {routeStops.length > 0 && routeStops[0]?.percorsiCount != null && routeStops[0].percorsiCount > 1 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Km calcolati come media su {routeStops[0].percorsiCount} percorsi distinti — DGR 1036/2022 art. 2.d
              </p>
            )}
          </CardHeader>
          <CardContent>
            {!selectedRoute ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                ← Seleziona una linea extraurbana per vedere le fermate e le zone assegnate
              </p>
            ) : loadingStops ? (
              <LoadingSpinner />
            ) : routeStops.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">Nessuna fermata trovata per questa linea.</p>
            ) : (
              <div className="overflow-auto max-h-[50vh]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border/30">
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">#</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Fermata</th>
                      <th className="text-right py-2 px-2 font-medium text-muted-foreground">Km (media)</th>
                      <th className="text-right py-2 px-2 font-medium text-muted-foreground">Min–Max</th>
                      <th className="text-center py-2 px-2 font-medium text-muted-foreground">Percorsi</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Fascia</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Zona</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeStops.map((s, i) => {
                      const dispersion = (s.kmMax != null && s.kmMin != null) ? (s.kmMax - s.kmMin) : 0;
                      return (
                      <tr key={`${s.stopId}-${i}`} className="border-b border-border/10 hover:bg-muted/10">
                        <td className="py-1.5 px-2 text-muted-foreground">{s.sequence}</td>
                        <td className="py-1.5 px-2">
                          <div>
                            <span className="font-medium">{s.stopName}</span>
                            <span className="text-[10px] text-muted-foreground ml-2 font-mono">{s.stopId}</span>
                          </div>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">{s.progressiveKm.toFixed(1)}</td>
                        <td className="py-1.5 px-2 text-right font-mono text-[11px]">
                          {s.kmMin != null && s.kmMax != null ? (
                            <span className={dispersion > 2 ? "text-amber-400" : "text-muted-foreground"}>
                              {s.kmMin.toFixed(1)}–{s.kmMax.toFixed(1)}
                              {dispersion > 2 && " ⚠"}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="py-1.5 px-2 text-center font-mono text-[11px]">
                          {s.percorsiCount ?? "—"}
                        </td>
                        <td className="py-1.5 px-2">
                          {s.suggestedFascia && (
                            <Badge variant="outline" className="text-[10px]">F{s.suggestedFascia}</Badge>
                          )}
                        </td>
                        <td className="py-1.5 px-2">
                          {s.currentAreaId ? (
                            <Badge variant="secondary" className="text-[10px]">{s.currentAreaId}</Badge>
                          ) : s.suggestedAreaId ? (
                            <span className="text-[10px] text-muted-foreground italic">{s.suggestedAreaId}</span>
                          ) : "—"}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ZONES CONTAINER — macro-tab with sub-tabs: Km per Linea / Cluster
// ═══════════════════════════════════════════════════════════

function ZonesContainerTab() {
  const [subTab, setSubTab] = useState<"km" | "cluster">("km");
  return (
    <div className="space-y-4">
      {/* Sub-tab switcher */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit">
        <button
          onClick={() => setSubTab("km")}
          className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            subTab === "km" ? "text-foreground bg-background/80 border border-border/50 shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
          }`}
        >
          <MapPin className="w-3.5 h-3.5" /> Km per Linea
        </button>
        <button
          onClick={() => setSubTab("cluster")}
          className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            subTab === "cluster" ? "text-foreground bg-background/80 border border-border/50 shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
          }`}
        >
          <Hexagon className="w-3.5 h-3.5" /> Cluster
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={subTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
          {subTab === "km" ? <ZonesTab /> : <ClustersTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 3b: ZONE CLUSTER — partition-based zoning
// ═══════════════════════════════════════════════════════════

interface ClusterFull {
  id: string;
  clusterId: string;
  clusterName: string;
  polygon: any;
  centroidLat: number | null;
  centroidLon: number | null;
  color: string;
  stopCount: number;
  stops: { stopId: string; stopName: string; stopLat: number; stopLon: number }[];
}

interface ExtraStop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lon: number;
}

interface DistanceEntry {
  from: string;
  to: string;
  distanceKm: number;
  fascia: number | null;
}

const CLUSTER_MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

const CLUSTER_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6",
  "#ec4899", "#14b8a6", "#f59e0b", "#6366f1", "#d946ef", "#84cc16", "#0ea5e9",
];

// ─── Convex hull (Graham scan) ──────────────────────────
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: [number, number][] = [];
  for (const p of sorted.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ─── Point-in-polygon (ray casting) ────────────────────────
function pointInPolygon(lon: number, lat: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ClustersTab() {
  const { toast } = useToast();
  const mapRef = useRef<MapRef>(null);

  // All data loaded once from /full endpoint
  const [clusters, setClusters] = useState<ClusterFull[]>([]);
  const [extraStops, setExtraStops] = useState<ExtraStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [autoGenerating, setAutoGenerating] = useState(false);
  const [showAutoConfirm, setShowAutoConfirm] = useState(false);

  // Active cluster being edited
  const [activeClusterId, setActiveClusterId] = useState<string | null>(null);
  // Pending stop set for the active cluster (local edits before save)
  const [pendingStops, setPendingStops] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);

  // Drawing
  const [drawMode, setDrawMode] = useState(false);
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [hoveredPoint, setHoveredPoint] = useState<[number, number] | null>(null);

  // Matrix
  const [distMatrix, setDistMatrix] = useState<DistanceEntry[]>([]);
  const [showMatrix, setShowMatrix] = useState(false);

  // New cluster form
  const [newName, setNewName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // ── Build ownership map: stopId → clusterId (from saved data) ──
  const ownershipMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of clusters) {
      for (const s of c.stops) m[s.stopId] = c.clusterId;
    }
    return m;
  }, [clusters]);

  // ── Load everything ──
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [full, es] = await Promise.all([
        apiFetch<ClusterFull[]>("/api/fares/zone-clusters/full"),
        apiFetch<ExtraStop[]>("/api/fares/extraurban-stops"),
      ]);
      setClusters(full);
      setExtraStops(es);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Active cluster object
  const activeCluster = clusters.find(c => c.clusterId === activeClusterId) || null;

  // ── Select a cluster ──
  const selectCluster = (c: ClusterFull) => {
    if (dirty) {
      if (!confirm("Hai modifiche non salvate. Vuoi scartarle?")) return;
    }
    setActiveClusterId(c.clusterId);
    setPendingStops(new Set(c.stops.map(s => s.stopId)));
    setDirty(false);
    setDrawMode(false);
    setPolygonPoints([]);
    if (c.centroidLat && c.centroidLon && mapRef.current) {
      mapRef.current.flyTo({ center: [c.centroidLon, c.centroidLat], zoom: 11, duration: 800 });
    }
  };

  // ── Create cluster ──
  const createCluster = async () => {
    if (!newName.trim()) return;
    try {
      const id = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const color = CLUSTER_COLORS[clusters.length % CLUSTER_COLORS.length];
      await apiFetch("/api/fares/zone-clusters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusterId: id, clusterName: newName.trim(), color }),
      });
      setNewName("");
      await loadAll();
      setActiveClusterId(id);
      setPendingStops(new Set());
      setDirty(false);
      toast({ title: "Cluster creato", description: `"${newName.trim()}" — clicca sulle fermate per assegnarle` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  // ── Delete cluster ──
  const deleteCluster = async (id: string) => {
    try {
      await apiFetch(`/api/fares/zone-clusters/${id}`, { method: "DELETE" });
      if (activeClusterId && clusters.find(c => c.id === id)?.clusterId === activeClusterId) {
        setActiveClusterId(null); setPendingStops(new Set()); setDirty(false);
      }
      await loadAll();
      toast({ title: "Cluster eliminato" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  // ── Toggle stop in pending set ──
  const toggleStop = useCallback((stopId: string) => {
    if (!activeClusterId) return;
    // Check if stop belongs to another cluster
    const owner = ownershipMap[stopId];
    if (owner && owner !== activeClusterId && !pendingStops.has(stopId)) {
      const ownerCluster = clusters.find(c => c.clusterId === owner);
      toast({
        title: "Fermata già assegnata",
        description: `Questa fermata appartiene a "${ownerCluster?.clusterName || owner}". Verrà spostata nel cluster attivo al salvataggio.`,
      });
    }
    setPendingStops(prev => {
      const next = new Set(prev);
      if (next.has(stopId)) next.delete(stopId); else next.add(stopId);
      return next;
    });
    setDirty(true);
  }, [activeClusterId, ownershipMap, pendingStops, clusters, toast]);

  // ── Save stops ──
  const saveStops = async () => {
    if (!activeClusterId) return;
    setSaving(true);
    try {
      const stops = extraStops
        .filter(s => pendingStops.has(s.stop_id))
        .map(s => ({ stopId: s.stop_id, stopName: s.stop_name, stopLat: s.lat, stopLon: s.lon }));
      await apiFetch(`/api/fares/zone-clusters/${activeClusterId}/stops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stops }),
      });
      await loadAll();
      // Re-select to refresh pending
      const updated = (await apiFetch<ClusterFull[]>("/api/fares/zone-clusters/full")).find(c => c.clusterId === activeClusterId);
      if (updated) setPendingStops(new Set(updated.stops.map(s => s.stopId)));
      setDirty(false);
      toast({ title: "Fermate salvate", description: `${stops.length} fermate nel cluster` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  // ── Generate zones ──
  const generateFromClusters = async () => {
    setGenerating(true);
    try {
      const result = await apiFetch<any>("/api/fares/zone-clusters/generate-zones", { method: "POST" });
      toast({ title: "Zone generate", description: `${result.areasCreated} aree, ${result.stopsAssigned} fermate, ${result.odRules} regole OD` });
    } catch (e: any) { toast({ title: "Errore", description: e.message, variant: "destructive" }); }
    setGenerating(false);
  };

  // ── Auto-generate clusters ──
  const [autoMode, setAutoMode] = useState<"concentric" | "spatial">("spatial");

  const autoGenerateClusters = async () => {
    setShowAutoConfirm(false);
    setAutoGenerating(true);
    try {
      const result = await apiFetch<any>("/api/fares/zone-clusters/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: autoMode }),
      });
      setActiveClusterId(null);
      setPendingStops(new Set());
      setDirty(false);
      await loadAll();
      toast({
        title: "✨ Cluster generati automaticamente",
        description: `${result.clustersCreated} cluster creati, ${result.totalStopsAssigned} fermate assegnate su ${result.totalExtraStops}`,
      });
    } catch (e: any) {
      toast({ title: "Errore generazione", description: e.message, variant: "destructive" });
    }
    setAutoGenerating(false);
  };

  // ── Distance matrix ──
  const loadMatrix = async () => {
    try {
      const data = await apiFetch<{ clusters: any[]; matrix: DistanceEntry[] }>("/api/fares/zone-clusters/distance-matrix");
      setDistMatrix(data.matrix); setShowMatrix(true);
    } catch (e: any) { toast({ title: "Errore", description: e.message, variant: "destructive" }); }
  };

  // ── Polygon drawing ──
  const polygonGeoJSON = useMemo(() => {
    if (polygonPoints.length < 2) return null;
    const coords = [...polygonPoints];
    if (hoveredPoint) coords.push(hoveredPoint);
    if (coords.length >= 3) {
      const closed = [...coords, coords[0]];
      return { type: "FeatureCollection" as const, features: [
        { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [closed] }, properties: { kind: "fill" } },
        { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: coords }, properties: { kind: "line" } },
      ]};
    }
    return { type: "FeatureCollection" as const, features: [
      { type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: coords }, properties: { kind: "line" } },
    ]};
  }, [polygonPoints, hoveredPoint]);

  // ── Cluster partition polygons (convex hulls) ──
  const partitionsGeoJSON = useMemo(() => {
    const features: any[] = [];
    for (const c of clusters) {
      if (c.stops.length < 3) continue;
      const pts: [number, number][] = c.stops.map(s => [s.stopLon, s.stopLat]);
      const hull = convexHull(pts);
      if (hull.length >= 3) {
        // Add buffer by expanding hull slightly outward from centroid
        const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
        const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
        const buffered = hull.map(p => {
          const dx = p[0] - cx, dy = p[1] - cy;
          const len = Math.sqrt(dx * dx + dy * dy);
          const buf = 0.003; // ~300m buffer
          return [p[0] + (len > 0 ? (dx / len) * buf : 0), p[1] + (len > 0 ? (dy / len) * buf : 0)] as [number, number];
        });
        const closed = [...buffered, buffered[0]];
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [closed] },
          properties: { clusterId: c.clusterId, color: c.color, name: c.clusterName },
        });
      }
    }
    return { type: "FeatureCollection", features };
  }, [clusters]);

  // ── Stops GeoJSON: all extraurban stops with ownership coloring ──
  const activeColor = activeCluster?.color || "#3b82f6";

  const stopsGeoJSON = useMemo(() => {
    if (!extraStops.length) return null;
    return {
      type: "FeatureCollection" as const,
      features: extraStops.map(s => {
        const owner = ownershipMap[s.stop_id];
        const ownerCluster = owner ? clusters.find(c => c.clusterId === owner) : null;
        const isPending = pendingStops.has(s.stop_id);
        // Determine color
        let color = "#475569"; // unassigned: slate-600
        if (activeClusterId && isPending) {
          color = activeColor; // belongs to active cluster (pending)
        } else if (ownerCluster) {
          color = ownerCluster.color; // belongs to some cluster
        }
        return {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
          properties: {
            stopId: s.stop_id,
            stopName: s.stop_name,
            color,
            isPending: isPending ? 1 : 0,
            isOwned: owner ? 1 : 0,
            isActiveCluster: (activeClusterId && isPending) ? 1 : 0,
          },
        };
      }),
    };
  }, [extraStops, ownershipMap, pendingStops, activeClusterId, activeColor, clusters]);

  // ── Map click ──
  const handleMapClick = useCallback((e: any) => {
    if (drawMode) {
      setPolygonPoints(prev => [...prev, [e.lngLat.lng, e.lngLat.lat]]);
      return;
    }
    if (!activeClusterId) return;
    const features = e.features;
    if (features && features.length > 0) {
      const stopId = features[0].properties?.stopId;
      if (stopId) toggleStop(stopId);
    }
  }, [drawMode, activeClusterId, toggleStop]);

  // ── Double-click: close polygon ──
  const handleMapDblClick = useCallback((e: any) => {
    if (!drawMode || polygonPoints.length < 3) return;
    e.preventDefault();
    const poly = polygonPoints as [number, number][];
    const inside = extraStops.filter(s => pointInPolygon(s.lon, s.lat, poly));
    setPendingStops(prev => {
      const next = new Set(prev);
      inside.forEach(s => next.add(s.stop_id));
      return next;
    });
    setDirty(true);
    setDrawMode(false);
    setPolygonPoints([]);
    setHoveredPoint(null);
    toast({ title: `${inside.length} fermate selezionate`, description: "dal poligono disegnato" });
  }, [drawMode, polygonPoints, extraStops, toast]);

  const handleMapMouseMove = useCallback((e: any) => {
    if (!drawMode || polygonPoints.length === 0) return;
    setHoveredPoint([e.lngLat.lng, e.lngLat.lat]);
  }, [drawMode, polygonPoints.length]);

  // ── Pending stops list for display ──
  const pendingStopsList = useMemo(() => {
    return extraStops
      .filter(s => pendingStops.has(s.stop_id))
      .filter(s => !searchTerm || s.stop_name.toLowerCase().includes(searchTerm.toLowerCase()) || s.stop_id.includes(searchTerm));
  }, [extraStops, pendingStops, searchTerm]);

  // Total assigned
  const totalAssigned = useMemo(() => {
    const set = new Set<string>();
    for (const c of clusters) for (const s of c.stops) set.add(s.stopId);
    return set.size;
  }, [clusters]);

  const interactiveLayerIds = useMemo(() => activeClusterId ? ["stops-circle-layer"] : [], [activeClusterId]);

  if (loading && clusters.length === 0) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      {/* Info */}
      <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 p-3 flex items-start gap-3">
        <Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
        <div className="text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">Partizioni Territoriali (Cluster)</p>
          <p>
            Ogni fermata appartiene a <strong>un solo cluster</strong>.
            Seleziona un cluster, poi clicca sulle fermate o disegna un'area per assegnarle.
            Le tariffe si calcolano in base alla distanza tra i centroidi.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <Card className="bg-card/50"><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Cluster</p>
          <p className="text-2xl font-bold">{clusters.length}</p>
        </CardContent></Card>
        <Card className="bg-card/50"><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Fermate Totali</p>
          <p className="text-2xl font-bold">{extraStops.length}</p>
        </CardContent></Card>
        <Card className="bg-card/50"><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Assegnate</p>
          <p className="text-2xl font-bold text-green-400">{totalAssigned}</p>
        </CardContent></Card>
        <Card className="bg-card/50"><CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Non Assegnate</p>
          <p className="text-2xl font-bold text-yellow-400">{extraStops.length - totalAssigned}</p>
        </CardContent></Card>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nome nuovo cluster..."
            className="h-8 px-2 text-sm rounded-md border border-border/50 bg-background/50 w-48"
            onKeyDown={e => e.key === "Enter" && createCluster()} />
          <Button onClick={createCluster} disabled={!newName.trim()} size="sm" variant="outline">
            <Plus className="w-3.5 h-3.5 mr-1" /> Crea
          </Button>
        </div>
        <div className="border-l border-border/30 h-6" />
        <Button onClick={() => setShowAutoConfirm(true)} disabled={autoGenerating} size="sm"
          className="bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white shadow-lg shadow-violet-500/20">
          {autoGenerating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
          Genera Automaticamente
        </Button>
        <div className="border-l border-border/30 h-6" />
        <Button onClick={loadMatrix} size="sm" variant="outline">
          <Crosshair className="w-3.5 h-3.5 mr-1.5" /> Matrice Distanze
        </Button>
        <Button onClick={generateFromClusters} disabled={generating || clusters.length === 0} size="sm">
          {generating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
          Genera Zone GTFS
        </Button>
      </div>

      {/* Auto-generate confirmation dialog */}
      <AnimatePresence>
        {showAutoConfirm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setShowAutoConfirm(false)}>
            <motion.div initial={{ opacity: 0, scale: 0.95, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", duration: 0.3 }}
              className="bg-card border border-border/50 rounded-2xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden"
              onClick={e => e.stopPropagation()}>
              {/* Header gradient */}
              <div className="bg-gradient-to-r from-violet-600/20 to-blue-600/20 border-b border-border/30 px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-blue-500 flex items-center justify-center shadow-lg shadow-violet-500/30">
                    <Sparkles className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-base">Generazione Automatica Cluster</h3>
                    <p className="text-xs text-muted-foreground">Scegli la logica di partizionamento</p>
                  </div>
                </div>
              </div>
              {/* Body */}
              <div className="px-6 py-4 space-y-4">
                {/* Mode selector cards */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Spatial mode */}
                  <button onClick={() => setAutoMode("spatial")}
                    className={`relative text-left rounded-xl border-2 p-3.5 transition-all ${
                      autoMode === "spatial"
                        ? "border-emerald-500 bg-emerald-500/10 shadow-lg shadow-emerald-500/10"
                        : "border-border/30 bg-muted/10 hover:border-border/60 hover:bg-muted/20"
                    }`}>
                    {autoMode === "spatial" && (
                      <div className="absolute top-2 right-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      </div>
                    )}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${
                      autoMode === "spatial" ? "bg-emerald-500/20" : "bg-muted/30"
                    }`}>
                      <Layers className={`w-4 h-4 ${autoMode === "spatial" ? "text-emerald-400" : "text-muted-foreground"}`} />
                    </div>
                    <p className={`text-sm font-semibold mb-0.5 ${autoMode === "spatial" ? "text-emerald-300" : "text-foreground"}`}>
                      Addensamenti
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Cluster affiancati come tasselli di un puzzle, basati sulla densità delle fermate
                    </p>
                  </button>

                  {/* Concentric mode */}
                  <button onClick={() => setAutoMode("concentric")}
                    className={`relative text-left rounded-xl border-2 p-3.5 transition-all ${
                      autoMode === "concentric"
                        ? "border-blue-500 bg-blue-500/10 shadow-lg shadow-blue-500/10"
                        : "border-border/30 bg-muted/10 hover:border-border/60 hover:bg-muted/20"
                    }`}>
                    {autoMode === "concentric" && (
                      <div className="absolute top-2 right-2">
                        <CheckCircle2 className="w-4 h-4 text-blue-400" />
                      </div>
                    )}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${
                      autoMode === "concentric" ? "bg-blue-500/20" : "bg-muted/30"
                    }`}>
                      <Circle className={`w-4 h-4 ${autoMode === "concentric" ? "text-blue-400" : "text-muted-foreground"}`} />
                    </div>
                    <p className={`text-sm font-semibold mb-0.5 ${autoMode === "concentric" ? "text-blue-300" : "text-foreground"}`}>
                      Anelli Concentrici
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Fasce ad anello dal baricentro, allineate alle fasce km regionali (~6 km)
                    </p>
                  </button>
                </div>

                {/* Description based on mode */}
                <div className="rounded-lg bg-muted/20 border border-border/20 p-3 text-xs text-muted-foreground space-y-1.5">
                  {autoMode === "spatial" ? (
                    <>
                      <p>L'algoritmo individua <strong>nuclei di addensamento</strong> naturali delle fermate extraurbane, creando partizioni territoriali affiancate come le tessere di un mosaico.</p>
                      <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" /> Cluster basati sulla vicinanza geografica reale</p>
                      <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" /> Numero cluster calcolato automaticamente</p>
                      <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" /> Nomi derivati dalla fermata centrale di ogni gruppo</p>
                    </>
                  ) : (
                    <>
                      <p>L'algoritmo crea <strong>anelli concentrici</strong> attorno al baricentro delle fermate, seguendo le fasce tariffarie regionali (~6 km per fascia).</p>
                      <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-blue-400 shrink-0" /> Distanze allineate alle fasce km regionali</p>
                      <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-blue-400 shrink-0" /> Fasce: 0-6, 6-12, 12-18 km…</p>
                      <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-blue-400 shrink-0" /> Centroide = baricentro di tutte le fermate</p>
                    </>
                  )}
                  <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" /> Ogni fermata in un solo cluster (partizione)</p>
                  <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" /> Modificabile manualmente dopo la generazione</p>
                </div>

                {clusters.length > 0 && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                    <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-yellow-200/80">
                      <strong>Attenzione:</strong> i {clusters.length} cluster esistenti e le relative assegnazioni verranno <strong>sostituiti</strong>.
                    </p>
                  </div>
                )}
              </div>
              {/* Footer */}
              <div className="px-6 py-3 border-t border-border/30 flex items-center justify-end gap-2 bg-muted/10">
                <Button variant="ghost" size="sm" onClick={() => setShowAutoConfirm(false)}>Annulla</Button>
                <Button size="sm" onClick={autoGenerateClusters}
                  className={autoMode === "spatial"
                    ? "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white"
                    : "bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white"
                  }>
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                  {autoMode === "spatial" ? "Genera per Addensamenti" : "Genera Anelli"}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main: sidebar + map */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-3">
          {/* Cluster list */}
          <Card className="bg-card/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Hexagon className="w-3.5 h-3.5" /> Cluster ({clusters.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[28vh] overflow-auto">
                {clusters.length === 0 ? (
                  <p className="p-4 text-xs text-muted-foreground">Nessun cluster. Creane uno sopra.</p>
                ) : clusters.map(c => (
                  <div key={c.id} onClick={() => selectCluster(c)}
                    className={`cursor-pointer w-full text-left px-3 py-2.5 border-b border-border/10 hover:bg-muted/20 transition-all ${
                      activeClusterId === c.clusterId ? "bg-primary/10 border-l-3 shadow-sm" : ""
                    }`}
                    style={activeClusterId === c.clusterId ? { borderLeftColor: c.color } : {}}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-3.5 h-3.5 rounded-full shrink-0 ring-1 ring-white/20" style={{ background: c.color }} />
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-xs block truncate">{c.clusterName}</span>
                        <span className="text-[10px] text-muted-foreground">{c.stopCount} fermate</span>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); deleteCluster(c.id); }}
                        className="text-muted-foreground hover:text-destructive transition-colors shrink-0">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Active cluster: stop list + tools */}
          {activeClusterId && (
            <Card className="bg-card/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: activeColor }} />
                    {activeCluster?.clusterName} ({pendingStops.size})
                  </CardTitle>
                  <div className="flex gap-1">
                    {dirty && (
                      <Button onClick={saveStops} disabled={saving} size="sm" className="h-6 text-[10px] px-2">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                        Salva
                      </Button>
                    )}
                    <Button size="sm" variant={drawMode ? "default" : "outline"} className="h-6 text-[10px] px-2"
                      onClick={() => { if (drawMode) { setDrawMode(false); setPolygonPoints([]); setHoveredPoint(null); } else { setPolygonPoints([]); setHoveredPoint(null); setDrawMode(true); } }}>
                      {drawMode ? "✕ Stop" : "✏️ Area"}
                    </Button>
                  </div>
                </div>
                {drawMode && (
                  <p className="text-[9px] text-muted-foreground mt-1">
                    Click per vertici, <strong>doppio-click</strong> per chiudere e selezionare
                  </p>
                )}
              </CardHeader>
              <CardContent className="p-0">
                <div className="px-3 pb-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1.5 w-3 h-3 text-muted-foreground" />
                    <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Cerca fermata..."
                      className="w-full h-6 pl-6 pr-2 text-[10px] rounded border border-border/50 bg-background/50" />
                  </div>
                </div>
                <div className="max-h-[28vh] overflow-auto">
                  <table className="w-full text-[10px]">
                    <thead className="sticky top-0 bg-card z-10">
                      <tr className="border-b border-border/30">
                        <th className="text-left py-1 px-2 font-medium text-muted-foreground">ID</th>
                        <th className="text-left py-1 px-2 font-medium text-muted-foreground">Nome</th>
                        <th className="w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingStopsList.map(s => (
                        <tr key={s.stop_id} className="border-b border-border/5 hover:bg-muted/10">
                          <td className="py-0.5 px-2 font-mono text-muted-foreground">{s.stop_id}</td>
                          <td className="py-0.5 px-2 truncate max-w-[120px]">{s.stop_name}</td>
                          <td className="py-0.5 px-1">
                            <button onClick={() => toggleStop(s.stop_id)} className="text-muted-foreground hover:text-destructive">
                              <Trash2 className="w-2.5 h-2.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                      {pendingStopsList.length === 0 && (
                        <tr><td colSpan={3} className="py-3 text-center text-muted-foreground text-[10px]">
                          {pendingStops.size === 0 ? "Clicca le fermate sulla mappa per aggiungerle" : "Nessun risultato"}
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Legend */}
          <div className="px-1 space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Legenda</p>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <div className="w-3 h-3 rounded-full bg-[#475569] ring-1 ring-white/20" />
              Non assegnata
            </div>
            {clusters.map(c => (
              <div key={c.clusterId} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="w-3 h-3 rounded-full ring-1 ring-white/20" style={{ background: c.color }} />
                {c.clusterName}
              </div>
            ))}
          </div>
        </div>

        {/* MAP */}
        <Card className="bg-card/50 lg:col-span-3 overflow-hidden">
          <CardContent className="p-0">
            {CLUSTER_MAPBOX_TOKEN ? (
              <div className="h-[600px] relative">
                <Map
                  ref={mapRef}
                  mapboxAccessToken={CLUSTER_MAPBOX_TOKEN}
                  initialViewState={{ longitude: 13.35, latitude: 43.55, zoom: 9.5 }}
                  mapStyle="mapbox://styles/mapbox/navigation-night-v1"
                  style={{ width: "100%", height: "100%" }}
                  interactiveLayerIds={interactiveLayerIds}
                  doubleClickZoom={!drawMode}
                  onClick={handleMapClick}
                  onDblClick={handleMapDblClick}
                  onMouseMove={handleMapMouseMove}
                  cursor={drawMode ? "crosshair" : activeClusterId ? "pointer" : "grab"}
                >
                  {/* ── Partition polygons (convex hull per cluster) ── */}
                  {partitionsGeoJSON.features.length > 0 && (
                    <Source id="partitions" type="geojson" data={partitionsGeoJSON as any}>
                      <Layer id="partitions-fill" type="fill" paint={{
                        "fill-color": ["get", "color"],
                        "fill-opacity": 0.1,
                      }} />
                      <Layer id="partitions-stroke" type="line" paint={{
                        "line-color": ["get", "color"],
                        "line-width": 2,
                        "line-opacity": 0.5,
                        "line-dasharray": [4, 2],
                      }} />
                      <Layer id="partitions-label" type="symbol" layout={{
                        "text-field": ["get", "name"],
                        "text-size": 11,
                        "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
                      }} paint={{
                        "text-color": ["get", "color"],
                        "text-halo-color": "#0f172a",
                        "text-halo-width": 1.5,
                        "text-opacity": 0.7,
                      }} />
                    </Source>
                  )}

                  {/* ── All stops (colored by ownership) ── */}
                  {stopsGeoJSON && (
                    <Source id="cluster-stops" type="geojson" data={stopsGeoJSON as any}>
                      <Layer
                        id="stops-circle-layer"
                        type="circle"
                        paint={{
                          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 11, 5, 14, 8, 17, 12],
                          "circle-color": ["get", "color"],
                          "circle-opacity": [
                            "case",
                            ["==", ["get", "isActiveCluster"], 1], 1,
                            ["==", ["get", "isOwned"], 1], 0.75,
                            activeClusterId ? 0.6 : 0.4,
                          ],
                          "circle-stroke-width": [
                            "case",
                            ["==", ["get", "isActiveCluster"], 1], 2.5,
                            ["==", ["get", "isOwned"], 1], 1.5,
                            0.8,
                          ],
                          "circle-stroke-color": [
                            "case",
                            ["==", ["get", "isActiveCluster"], 1], "#ffffff",
                            ["==", ["get", "isOwned"], 1], "rgba(255,255,255,0.4)",
                            "rgba(255,255,255,0.15)",
                          ],
                        }}
                      />
                      <Layer
                        id="stops-label-layer"
                        type="symbol"
                        minzoom={12}
                        layout={{
                          "text-field": ["get", "stopName"],
                          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 8, 15, 10],
                          "text-offset": [0, 1.3],
                          "text-anchor": "top",
                          "text-max-width": 8,
                        }}
                        paint={{
                          "text-color": ["get", "color"],
                          "text-halo-color": "#0f172a",
                          "text-halo-width": 1.2,
                          "text-opacity": [
                            "case",
                            ["==", ["get", "isActiveCluster"], 1], 1,
                            ["==", ["get", "isOwned"], 1], 0.6,
                            0.3,
                          ],
                        }}
                      />
                    </Source>
                  )}

                  {/* ── Drawing polygon ── */}
                  {polygonGeoJSON && (
                    <Source id="draw-polygon" type="geojson" data={polygonGeoJSON as any}>
                      <Layer id="draw-fill" type="fill" filter={["==", ["get", "kind"], "fill"]}
                        paint={{ "fill-color": activeColor, "fill-opacity": 0.15 }} />
                      <Layer id="draw-stroke" type="line"
                        paint={{ "line-color": activeColor, "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.8 }} />
                    </Source>
                  )}

                  {/* Polygon vertices */}
                  {polygonPoints.map((pt, i) => (
                    <Marker key={`v-${i}`} longitude={pt[0]} latitude={pt[1]} anchor="center">
                      <div className="w-3 h-3 rounded-full border-2 border-white shadow-lg" style={{ backgroundColor: activeColor }} />
                    </Marker>
                  ))}

                  {/* Cluster centroid labels */}
                  {clusters.map(c => c.centroidLat && c.centroidLon ? (
                    <Marker key={`ctr-${c.clusterId}`} longitude={c.centroidLon} latitude={c.centroidLat} anchor="center">
                      <div onClick={() => selectCluster(c)}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-white text-[9px] font-bold shadow-lg cursor-pointer whitespace-nowrap transition-all ${
                          activeClusterId === c.clusterId ? "scale-110 ring-2 ring-white/40" : "opacity-70 hover:opacity-100"
                        }`}
                        style={{ backgroundColor: c.color + "dd" }}>
                        <Hexagon className="w-2.5 h-2.5" />
                        {c.clusterName}
                        <span className="ml-0.5 opacity-60">{c.stopCount}</span>
                      </div>
                    </Marker>
                  ) : null)}
                </Map>

                {/* Draw mode banner */}
                {drawMode && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
                      className="bg-primary/90 text-primary-foreground px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2 shadow-lg">
                      ✏️ {polygonPoints.length === 0 ? "Clicca per iniziare" : polygonPoints.length < 3 ? `${polygonPoints.length} vertici — min 3` : `${polygonPoints.length} vertici — doppio-click per chiudere`}
                    </motion.div>
                  </div>
                )}

                {/* Active cluster indicator */}
                {activeClusterId && !drawMode && (
                  <div className="absolute top-4 left-4 z-10">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg backdrop-blur"
                      style={{ backgroundColor: activeColor + "22", borderColor: activeColor + "44", border: "1px solid" }}>
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: activeColor }} />
                      <span style={{ color: activeColor }}>{activeCluster?.clusterName}</span>
                      <span className="text-muted-foreground">— clicca fermate per assegnare</span>
                    </div>
                  </div>
                )}

                {/* Stats badge */}
                <div className="absolute bottom-3 right-3 z-10 flex gap-2">
                  <Badge variant="secondary" className="text-[10px] bg-background/80 backdrop-blur">
                    {extraStops.length} fermate
                  </Badge>
                  {activeClusterId && dirty && (
                    <Badge className="text-[10px] bg-yellow-500/80">
                      {pendingStops.size} selezionate • non salvate
                    </Badge>
                  )}
                </div>
              </div>
            ) : (
              <div className="h-[600px] flex items-center justify-center text-muted-foreground text-sm">
                Token Mapbox non configurato (VITE_MAPBOX_TOKEN)
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Distance matrix */}
      {showMatrix && distMatrix.length > 0 && (
        <Card className="bg-card/50">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Layers className="w-3.5 h-3.5" /> Matrice Distanze Centroidi
              </CardTitle>
              <button onClick={() => setShowMatrix(false)} className="text-xs text-muted-foreground hover:text-foreground">✕</button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-auto max-h-[300px] rounded-lg border border-border/30">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b">
                    <th className="text-left px-2 py-1.5 font-semibold">Da → A</th>
                    <th className="text-right px-2 py-1.5 font-semibold">Km</th>
                    <th className="text-center px-2 py-1.5 font-semibold">Fascia</th>
                  </tr>
                </thead>
                <tbody>
                  {distMatrix.map((d, i) => (
                    <tr key={i} className="border-b border-border/10 hover:bg-muted/10">
                      <td className="px-2 py-1">
                        <span className="text-foreground">{clusters.find(c => c.clusterId === d.from)?.clusterName || d.from}</span>
                        <span className="text-muted-foreground mx-1">→</span>
                        <span className="text-foreground">{clusters.find(c => c.clusterId === d.to)?.clusterName || d.to}</span>
                      </td>
                      <td className="px-2 py-1 text-right">{d.distanceKm}</td>
                      <td className="px-2 py-1 text-center">
                        {d.fascia ? <Badge variant="outline" className="text-[10px]">F{d.fascia}</Badge> : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// TAB 4: FASCE ORARIE (GTFS timeframes.txt)
// ═══════════════════════════════════════════════════════════

interface Timeframe {
  id: string;
  timeframeGroupId: string;
  startTime: string | null;
  endTime: string | null;
  serviceId: string | null;
}

function TimeframesTab() {
  const { toast } = useToast();
  const [timeframes, setTimeframes] = useState<Timeframe[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ timeframeGroupId: "", startTime: "", endTime: "", serviceId: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Timeframe[]>("/api/fares/timeframes");
      setTimeframes(data);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!form.timeframeGroupId || !form.startTime || !form.endTime) {
      toast({ title: "Compila i campi obbligatori", description: "Gruppo, ora inizio e ora fine sono richiesti", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      await apiFetch("/api/fares/timeframes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeframeGroupId: form.timeframeGroupId,
          startTime: form.startTime,
          endTime: form.endTime,
          serviceId: form.serviceId || undefined,
        }),
      });
      toast({ title: "✅ Fascia oraria aggiunta" });
      setForm({ timeframeGroupId: "", startTime: "", endTime: "", serviceId: "" });
      load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally { setAdding(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/fares/timeframes/${id}`, { method: "DELETE" });
      toast({ title: "🗑️ Fascia rimossa" });
      load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  };

  // Group by timeframeGroupId
  const grouped = useMemo(() => {
    const map: Record<string, Timeframe[]> = {};
    for (const tf of timeframes) {
      if (!map[tf.timeframeGroupId]) map[tf.timeframeGroupId] = [];
      map[tf.timeframeGroupId].push(tf);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [timeframes]);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      {/* Add form */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Aggiungi Fascia Oraria
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Gruppo *</label>
              <input
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="es. peak"
                value={form.timeframeGroupId}
                onChange={(e) => setForm({ ...form, timeframeGroupId: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ora Inizio *</label>
              <input
                type="time"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Ora Fine *</label>
              <input
                type="time"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Service ID</label>
              <input
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="opzionale"
                value={form.serviceId}
                onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
              />
            </div>
            <div className="flex items-end">
              <Button onClick={handleAdd} disabled={adding} className="w-full">
                {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                <span className="ml-2">Aggiungi</span>
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            I timeframe definiscono fasce orarie (es. peak/off-peak) che possono essere referenziate nelle fare_leg_rules per differenziare i prezzi.
          </p>
        </CardContent>
      </Card>

      {/* Existing timeframes */}
      {grouped.length === 0 ? (
        <Card className="py-12">
          <CardContent className="text-center text-muted-foreground">
            <Clock className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium">Nessuna fascia oraria definita</p>
            <p className="text-sm mt-1">Aggiungi fasce orarie (peak, off-peak) per differenziare i prezzi</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {grouped.map(([groupId, items]) => (
            <Card key={groupId}>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {groupId}
                  </Badge>
                  <span className="text-muted-foreground font-normal">
                    {items.length} {items.length === 1 ? "intervallo" : "intervalli"}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border/50">
                  {items.map((tf) => (
                    <div key={tf.id} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-4 text-sm">
                        <span className="font-mono">
                          {tf.startTime || "—"} → {tf.endTime || "—"}
                        </span>
                        {tf.serviceId && (
                          <Badge variant="outline" className="text-xs">
                            service: {tf.serviceId}
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(tf.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Quick-seed presets */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Preset fasce orarie standard</p>
              <p className="text-xs text-muted-foreground">Peak (07:00-09:00, 17:00-19:00) e Off-peak (restante)</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const presets = [
                  { timeframeGroupId: "peak", startTime: "07:00:00", endTime: "09:00:00" },
                  { timeframeGroupId: "peak", startTime: "17:00:00", endTime: "19:00:00" },
                  { timeframeGroupId: "off_peak", startTime: "09:00:00", endTime: "17:00:00" },
                  { timeframeGroupId: "off_peak", startTime: "19:00:00", endTime: "23:59:00" },
                  { timeframeGroupId: "off_peak", startTime: "00:00:00", endTime: "07:00:00" },
                ];
                for (const p of presets) {
                  await apiFetch("/api/fares/timeframes", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(p),
                  });
                }
                toast({ title: "✅ Preset fasce orarie caricati" });
                load();
              }}
            >
              <Sparkles className="w-3.5 h-3.5 mr-1" />
              Carica Preset
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 5: EDITOR FERMATE — pickup_type / drop_off_type
// ═══════════════════════════════════════════════════════════

interface StopTimeRow {
  stopId: string;
  stopName: string;
  sequence: number;
  lat: number;
  lon: number;
  arrivalTime: string | null;
  departureTime: string | null;
  pickupType: number;
  dropOffType: number;
}

function StopTimesEditorTab() {
  const { toast } = useToast();
  const [routes, setRoutes] = useState<RouteNetwork[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<string>("");
  const [stops, setStops] = useState<StopTimeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingStops, setLoadingStops] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load routes
  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<RouteNetwork[]>("/api/fares/route-networks");
        setRoutes(data);
      } catch { /* ignore */ } finally { setLoading(false); }
    })();
  }, []);

  // Load stop times when route selected
  const loadStops = useCallback(async (routeId: string) => {
    if (!routeId) return;
    setLoadingStops(true);
    try {
      const data = await apiFetch<StopTimeRow[]>(`/api/fares/stop-times/${routeId}`);
      setStops(data);
      setDirty(false);
    } catch { /* ignore */ } finally { setLoadingStops(false); }
  }, []);

  useEffect(() => { if (selectedRoute) loadStops(selectedRoute); }, [selectedRoute, loadStops]);

  const togglePickup = (idx: number) => {
    setStops(prev => prev.map((s, i) => i === idx ? { ...s, pickupType: s.pickupType === 0 ? 1 : 0 } : s));
    setDirty(true);
  };

  const toggleDropOff = (idx: number) => {
    setStops(prev => prev.map((s, i) => i === idx ? { ...s, dropOffType: s.dropOffType === 0 ? 1 : 0 } : s));
    setDirty(true);
  };

  const saveChanges = async () => {
    setSaving(true);
    try {
      const updates = stops.map(s => ({
        stopId: s.stopId,
        pickupType: s.pickupType,
        dropOffType: s.dropOffType,
      }));
      await apiFetch(`/api/fares/stop-times/${selectedRoute}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      toast({ title: "✅ Salvataggio completato", description: "Pickup/drop-off aggiornati per tutte le corse della linea" });
      setDirty(false);
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  if (loading) return <LoadingSpinner />;

  const selectedInfo = routes.find(r => r.routeId === selectedRoute);

  return (
    <div className="space-y-6">
      {/* Route selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Bus className="w-4 h-4" />
            Seleziona Linea
          </CardTitle>
        </CardHeader>
        <CardContent>
          <select
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            value={selectedRoute}
            onChange={(e) => setSelectedRoute(e.target.value)}
          >
            <option value="">— Seleziona una linea —</option>
            {routes.map(r => (
              <option key={r.routeId} value={r.routeId}>
                {r.shortName || r.routeId} — {r.longName || ""}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {/* Editor */}
      {selectedRoute && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Edit3 className="w-4 h-4" />
                Fermate linea {selectedInfo?.shortName || selectedRoute}
                <Badge variant="outline" className="text-xs ml-2">
                  {stops.length} fermate
                </Badge>
              </CardTitle>
              <div className="flex items-center gap-2">
                {dirty && (
                  <Badge variant="secondary" className="animate-pulse text-xs">
                    Modifiche non salvate
                  </Badge>
                )}
                <Button onClick={saveChanges} disabled={saving || !dirty} size="sm">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  <span className="ml-1">Salva</span>
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingStops ? (
              <LoadingSpinner />
            ) : stops.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Nessuna fermata trovata</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  <span className="font-medium">Salita (pickup):</span> ✅ = fermata regolare, ❌ = no salita —
                  <span className="font-medium ml-2">Discesa (drop-off):</span> ✅ = fermata regolare, ❌ = no discesa
                </p>
                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50">
                        <th className="text-left px-3 py-2 font-medium">#</th>
                        <th className="text-left px-3 py-2 font-medium">Fermata</th>
                        <th className="text-left px-3 py-2 font-medium">Arrivo</th>
                        <th className="text-left px-3 py-2 font-medium">Partenza</th>
                        <th className="text-center px-3 py-2 font-medium">Salita</th>
                        <th className="text-center px-3 py-2 font-medium">Discesa</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stops.map((s, i) => (
                        <tr key={s.stopId + i} className="border-t border-border/30 hover:bg-muted/20">
                          <td className="px-3 py-2 text-muted-foreground">{s.sequence}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium">{s.stopName}</span>
                            <span className="text-xs text-muted-foreground ml-2">{s.stopId}</span>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{s.arrivalTime || "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs">{s.departureTime || "—"}</td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => togglePickup(i)}
                              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                                s.pickupType === 0
                                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              }`}
                            >
                              {s.pickupType === 0 ? "✅ Sì" : "❌ No"}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => toggleDropOff(i)}
                              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                                s.dropOffType === 0
                                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                              }`}
                            >
                              {s.dropOffType === 0 ? "✅ Sì" : "❌ No"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 6: GENERA & ESPORTA
// ═══════════════════════════════════════════════════════════

function GenerateTab() {
  const { toast } = useToast();
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [zoningMethod, setZoningMethod] = useState<"km" | "cluster">("km");
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; checks: { id: string; label: string; ok: boolean; detail?: string }[] } | null>(null);
  const [deduplicating, setDeduplicating] = useState(false);

  /** 1-click: genera regole tariffarie + anteprima completa (solo Fares V2) */
  const generateAll = async () => {
    setGenerating(true);
    try {
      if (zoningMethod === "cluster") {
        // First generate zones from clusters, then leg rules
        await apiFetch("/api/fares/zone-clusters/generate-zones", { method: "POST" });
      }
      // Generate leg rules (uses whatever areas/stop_areas exist)
      await apiFetch("/api/fares/leg-rules/generate", { method: "POST" });
      // Generate preview
      const data = await apiFetch<GenerateResult>("/api/fares/generate-gtfs", { method: "POST" });
      setResult(data);
      setPreviewFile(null);
      toast({ title: "✅ Generazione completata", description: `${Object.keys(data.files).length} file tariffari pronti (metodo: ${zoningMethod === "km" ? "Km per linea" : "Cluster"})` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally { setGenerating(false); }
  };

  /** Download ZIP completo del GTFS (base + tariffe) */
  const downloadFullZip = async () => {
    setDownloadingZip(true);
    try {
      const apiBase = import.meta.env.VITE_API_URL || "";
      const response = await fetch(`${apiBase}/api/fares/export-zip`, { credentials: "include" });
      if (!response.ok) throw new Error("Errore durante l'export");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gtfs_export.zip";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "✅ GTFS ZIP scaricato", description: "Archivio completo con dati base + bigliettazione" });
    } catch (e: any) {
      toast({ title: "Errore export", description: e.message, variant: "destructive" });
    } finally { setDownloadingZip(false); }
  };

  return (
    <div className="space-y-5">
      {/* Zoning method selector */}
      <Card className="bg-card/50">
        <CardContent className="p-3">
          <div className="flex items-center gap-4">
            <p className="text-xs font-medium text-muted-foreground shrink-0">Metodo zonizzazione extraurbana:</p>
            <div className="flex gap-2">
              <button
                onClick={() => setZoningMethod("km")}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                  zoningMethod === "km"
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "border-border/30 text-muted-foreground hover:bg-muted/30"
                }`}
              >
                <MapPin className="w-3 h-3" /> Km per Linea
              </button>
              <button
                onClick={() => setZoningMethod("cluster")}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                  zoningMethod === "cluster"
                    ? "bg-primary/10 border-primary/30 text-primary"
                    : "border-border/30 text-muted-foreground hover:bg-muted/30"
                }`}
              >
                <Hexagon className="w-3 h-3" /> Cluster
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              {zoningMethod === "km"
                ? "Zone calcolate sulla distanza progressiva per ogni linea extraurbana"
                : "Zone calcolate dalla distanza tra centroidi dei cluster"}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={generateAll} disabled={generating} size="sm">
          {generating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
          Genera Anteprima Tariffe
        </Button>
        <Button onClick={downloadFullZip} disabled={downloadingZip} variant="outline" size="sm">
          {downloadingZip ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Archive className="w-4 h-4 mr-2" />}
          Scarica GTFS Completo (ZIP)
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={deduplicating}
          onClick={async () => {
            setDeduplicating(true);
            try {
              const res = await apiFetch<{ deleted: number; remaining: number }>("/api/fares/stop-areas/deduplicate", { method: "POST" });
              toast({ title: "Deduplicazione completata", description: `${res.deleted} duplicati rimossi, ${res.remaining} assegnamenti rimasti` });
            } catch (e: any) { toast({ title: "Errore", description: e.message, variant: "destructive" }); }
            setDeduplicating(false);
          }}
        >
          {deduplicating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Deduplica Stop-Areas
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={validating}
          onClick={async () => {
            setValidating(true);
            try {
              const res = await apiFetch<{ ok: boolean; checks: { id: string; label: string; ok: boolean; detail?: string }[] }>("/api/fares/validate");
              setValidation(res);
            } catch (e: any) { toast({ title: "Errore", description: e.message, variant: "destructive" }); }
            setValidating(false);
          }}
        >
          {validating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
          Valida Feed
        </Button>
      </div>

      {/* Validation checklist */}
      {validation && (
        <Card className={validation.ok ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              {validation.ok
                ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                : <AlertTriangle className="w-4 h-4 text-amber-500" />}
              Checklist Pre-Export ({validation.checks.filter(c => c.ok).length}/{validation.checks.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {validation.checks.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-sm">
                  {c.ok
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    : <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                  <span className={c.ok ? "text-foreground" : "text-amber-700 font-medium"}>{c.label}</span>
                  {c.detail && <span className="text-xs text-muted-foreground ml-auto font-mono">{c.detail}</span>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Description */}
      <p className="text-xs text-muted-foreground">
        <strong>Genera Anteprima:</strong> crea le regole tariffarie e mostra l'anteprima di tutti i file Fares V2 (usa metodo "{zoningMethod === "km" ? "Km per Linea" : "Cluster"}"). —
        <strong className="ml-1">Scarica ZIP:</strong> esporta l'intero feed GTFS (agency, routes, trips, stops, stop_times, calendar, shapes + tutti i file tariffari).
      </p>

      {result && (
        <>
          {/* Validation card */}
          <Card className={result.validation.isComplete ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {result.validation.isComplete
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  : <AlertTriangle className="w-4 h-4 text-amber-500" />}
                Riepilogo Validazione
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Linee classificate</span><span className="font-mono">{result.validation.routesClassified}/{result.validation.totalRoutes}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Prodotti</span><span className="font-mono">{result.validation.products}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Zone/Aree</span><span className="font-mono">{result.validation.areas}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Assegnamenti fermata↔zona</span><span className="font-mono">{result.validation.stopAreaAssignments}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Regole leg</span><span className="font-mono">{result.validation.legRules}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Regole trasferimento</span><span className="font-mono">{result.validation.transferRules}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Fasce orarie</span><span className="font-mono">{result.validation.timeframes}</span></div>
              </div>
              {result.validation.missingRoutes.length > 0 && (
                <p className="text-amber-600 text-xs mt-3">
                  ⚠ Linee non classificate: {result.validation.missingRoutes.slice(0, 10).join(", ")}{result.validation.missingRoutes.length > 10 ? ` e altre ${result.validation.missingRoutes.length - 10}` : ""}
                </p>
              )}
            </CardContent>
          </Card>

          {/* File grid — ALL fare files */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="w-4 h-4" />
                File Tariffari ({Object.keys(result.files).length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {Object.entries(result.files).map(([filename, content]) => {
                  const lines = content.split("\n").filter(Boolean).length - 1; // exclude header
                  return (
                    <button
                      key={filename}
                      onClick={() => setPreviewFile(previewFile === filename ? null : filename)}
                      className={`text-left p-3 rounded-lg border transition-all ${
                        previewFile === filename
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border/40 hover:bg-muted/30 hover:border-border"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="text-xs font-medium truncate">{filename}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-muted-foreground">{lines} record</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* CSV Preview */}
          {previewFile && result.files[previewFile] && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-mono flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5" />
                    {previewFile}
                  </CardTitle>
                  <button
                    onClick={() => setPreviewFile(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >✕ Chiudi</button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-auto max-h-[400px] rounded-lg border border-border/30">
                  <table className="w-full text-[11px] font-mono">
                    {(() => {
                      const lines = result.files[previewFile].split("\n").filter(Boolean);
                      const headers = lines[0]?.split(",") || [];
                      const rows = lines.slice(1);
                      return (
                        <>
                          <thead>
                            <tr className="bg-muted/50 sticky top-0">
                              {headers.map((h, i) => (
                                <th key={i} className="text-left px-2 py-1.5 font-semibold text-foreground whitespace-nowrap border-b">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {rows.slice(0, 100).map((row, ri) => (
                              <tr key={ri} className="border-b border-border/20 hover:bg-muted/20">
                                {row.split(",").map((cell, ci) => (
                                  <td key={ci} className="px-2 py-1 text-muted-foreground whitespace-nowrap">{cell || "—"}</td>
                                ))}
                              </tr>
                            ))}
                            {rows.length > 100 && (
                              <tr><td colSpan={headers.length} className="px-2 py-2 text-center text-muted-foreground italic">
                                ... e altri {rows.length - 100} record
                              </td></tr>
                            )}
                          </tbody>
                        </>
                      );
                    })()}
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 5: SIMULATORE BIGLIETTO + MAPPA (dual mode: Km Linea / Cluster)
// ═══════════════════════════════════════════════════════════

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

// ─── types for cluster simulation ──────────────────────
interface ClusterSimResult {
  type: "cluster";
  fromStop: { stopId: string; name: string; lat: number; lon: number } | null;
  toStop: { stopId: string; name: string; lat: number; lon: number } | null;
  fromCluster: {
    clusterId: string; clusterName: string; color: string;
    centroidLat: number; centroidLon: number;
    stops: { stopId: string; stopName: string; lat: number; lon: number }[];
  };
  toCluster: {
    clusterId: string; clusterName: string; color: string;
    centroidLat: number; centroidLon: number;
    stops: { stopId: string; stopName: string; lat: number; lon: number }[];
  };
  sameCluster: boolean;
  distanceKm: number;
  fascia: number | null;
  amount: number | null;
  currency: string;
  bandRange: string | null;
}

// Convex hull for map display (reuse logic from ClustersTab)
function simConvexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: [number, number][] = [];
  for (const p of sorted.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function SimulateTab() {
  const { toast } = useToast();
  const mapRef = useRef<MapRef>(null);

  // ── Sim mode ──
  const [simMode, setSimMode] = useState<"line" | "cluster">("line");

  // ── Line-based (km) state ──
  const [routeNets, setRouteNets] = useState<RouteNetwork[]>([]);
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [selectedRoute, setSelectedRoute] = useState("");
  const [fromStop, setFromStop] = useState("");
  const [toStop, setToStop] = useState("");
  const [routeStops, setRouteStops] = useState<RouteStop[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStops, setLoadingStops] = useState(false);

  // ── Cluster-based state ──
  const [clSelectedRoute, setClSelectedRoute] = useState("");
  const [clRouteStops, setClRouteStops] = useState<RouteStop[]>([]);
  const [clLoadingStops, setClLoadingStops] = useState(false);
  const [clFrom, setClFrom] = useState("");
  const [clTo, setClTo] = useState("");
  const [clResult, setClResult] = useState<ClusterSimResult | null>(null);
  const [clLoading, setClLoading] = useState(false);

  // ── Load route networks ──
  useEffect(() => {
    apiFetch<RouteNetwork[]>("/api/fares/route-networks").then(setRouteNets).catch(() => {});
  }, []);

  // ──────────── LINE MODE logic ──────────────
  const filteredRoutes = routeNets.filter(r => r.networkId === selectedNetwork);

  useEffect(() => {
    if (selectedNetwork === "extraurbano" && selectedRoute) {
      setLoadingStops(true);
      apiFetch<RouteStop[]>(`/api/fares/route-stops/${selectedRoute}`)
        .then(setRouteStops)
        .catch(() => setRouteStops([]))
        .finally(() => setLoadingStops(false));
    } else {
      setRouteStops([]);
    }
  }, [selectedNetwork, selectedRoute]);

  useEffect(() => {
    if (routeStops.length > 1 && mapRef.current) {
      const lats = routeStops.map(s => s.lat);
      const lons = routeStops.map(s => s.lon);
      mapRef.current.fitBounds(
        [[Math.min(...lons) - 0.02, Math.min(...lats) - 0.01], [Math.max(...lons) + 0.02, Math.max(...lats) + 0.01]],
        { padding: 60, duration: 800 }
      );
    }
  }, [routeStops]);

  useEffect(() => {
    if (result?.intermediateStops && result.intermediateStops.length > 1 && mapRef.current) {
      const lats = result.intermediateStops.map(s => s.lat);
      const lons = result.intermediateStops.map(s => s.lon);
      mapRef.current.fitBounds(
        [[Math.min(...lons) - 0.02, Math.min(...lats) - 0.01], [Math.max(...lons) + 0.02, Math.max(...lats) + 0.01]],
        { padding: 60, duration: 800 }
      );
    }
  }, [result]);

  const simulateLine = async () => {
    if (!selectedNetwork) return;
    setLoading(true);
    setResult(null);
    try {
      const body: Record<string, string> = { networkId: selectedNetwork };
      if (selectedNetwork === "extraurbano") {
        body.routeId = selectedRoute;
        body.fromStopId = fromStop;
        body.toStopId = toStop;
      }
      const data = await apiFetch<SimulationResult>("/api/fares/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setResult(data);
    } catch (e: any) {
      toast({ title: "Errore simulazione", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  };

  // ──────────── CLUSTER MODE logic ──────────────
  const clFilteredRoutes = routeNets.filter(r => r.networkId === "extraurbano");

  useEffect(() => {
    if (clSelectedRoute) {
      setClLoadingStops(true);
      apiFetch<RouteStop[]>(`/api/fares/route-stops/${clSelectedRoute}`)
        .then(setClRouteStops)
        .catch(() => setClRouteStops([]))
        .finally(() => setClLoadingStops(false));
    } else {
      setClRouteStops([]);
    }
  }, [clSelectedRoute]);

  useEffect(() => {
    if (clRouteStops.length > 1 && mapRef.current && simMode === "cluster") {
      const lats = clRouteStops.map(s => s.lat);
      const lons = clRouteStops.map(s => s.lon);
      mapRef.current.fitBounds(
        [[Math.min(...lons) - 0.02, Math.min(...lats) - 0.01], [Math.max(...lons) + 0.02, Math.max(...lats) + 0.01]],
        { padding: 60, duration: 800 }
      );
    }
  }, [clRouteStops, simMode]);

  const simulateCluster = async () => {
    if (!clFrom || !clTo) return;
    setClLoading(true);
    setClResult(null);
    try {
      const data = await apiFetch<ClusterSimResult>("/api/fares/simulate-cluster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromStopId: clFrom, toStopId: clTo }),
      });
      setClResult(data);
      // Fit map to show both clusters
      if (data.fromCluster && data.toCluster && mapRef.current) {
        const allPts = [...data.fromCluster.stops, ...data.toCluster.stops];
        if (allPts.length > 0) {
          const lats = allPts.map(s => s.lat);
          const lons = allPts.map(s => s.lon);
          mapRef.current.fitBounds(
            [[Math.min(...lons) - 0.03, Math.min(...lats) - 0.02], [Math.max(...lons) + 0.03, Math.max(...lats) + 0.02]],
            { padding: 50, duration: 800 }
          );
        }
      }
    } catch (e: any) {
      toast({ title: "Errore simulazione", description: e.message, variant: "destructive" });
    }
    setClLoading(false);
  };

  // ── Cluster hulls GeoJSON ──
  const clusterHullsGeoJSON = useMemo(() => {
    if (!clResult) return null;
    const features: any[] = [];
    const makeHull = (cluster: ClusterSimResult["fromCluster"], label: string) => {
      if (cluster.stops.length < 3) return;
      const pts: [number, number][] = cluster.stops.map(s => [s.lon, s.lat]);
      const hull = simConvexHull(pts);
      if (hull.length >= 3) {
        const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
        const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
        const buffered = hull.map(p => {
          const dx = p[0] - cx, dy = p[1] - cy;
          const len = Math.sqrt(dx * dx + dy * dy);
          const buf = 0.004;
          return [p[0] + (len > 0 ? (dx / len) * buf : 0), p[1] + (len > 0 ? (dy / len) * buf : 0)] as [number, number];
        });
        const closed = [...buffered, buffered[0]];
        features.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [closed] },
          properties: { color: cluster.color, name: cluster.clusterName, label },
        });
      }
    };
    makeHull(clResult.fromCluster, "from");
    if (!clResult.sameCluster) makeHull(clResult.toCluster, "to");
    return { type: "FeatureCollection", features };
  }, [clResult]);

  // ── Centroid line GeoJSON ──
  const centroidLineGeoJSON = useMemo(() => {
    if (!clResult || clResult.sameCluster) return null;
    return {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [clResult.fromCluster.centroidLon, clResult.fromCluster.centroidLat],
            [clResult.toCluster.centroidLon, clResult.toCluster.centroidLat],
          ],
        },
        properties: {},
      }],
    };
  }, [clResult]);

  // ── Cluster-mode route line + stops GeoJSON ──
  const clRouteLineGeoJson = useMemo(() => {
    if (clRouteStops.length < 2) return null;
    return {
      type: "FeatureCollection" as const,
      features: [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: clRouteStops.map(s => [s.lon, s.lat]) } }],
    };
  }, [clRouteStops]);

  const clStopsGeoJson = useMemo(() => {
    if (clRouteStops.length === 0) return null;
    return {
      type: "FeatureCollection" as const,
      features: clRouteStops.map(s => ({
        type: "Feature" as const,
        properties: {
          stopId: s.stopId, name: s.stopName, km: s.progressiveKm,
          isFrom: s.stopId === clFrom, isTo: s.stopId === clTo,
        },
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      })),
    };
  }, [clRouteStops, clFrom, clTo]);

  // ── Line-mode GeoJSON ──
  const routeLineGeoJson = useMemo(() => {
    if (routeStops.length < 2) return null;
    return {
      type: "FeatureCollection" as const,
      features: [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: routeStops.map(s => [s.lon, s.lat]) } }],
    };
  }, [routeStops]);

  const segmentGeoJson = useMemo(() => {
    if (!result?.intermediateStops || result.intermediateStops.length < 2) return null;
    return {
      type: "FeatureCollection" as const,
      features: [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: result.intermediateStops.map(s => [s.lon, s.lat]) } }],
    };
  }, [result]);

  const stopsGeoJson = useMemo(() => {
    if (routeStops.length === 0) return null;
    return {
      type: "FeatureCollection" as const,
      features: routeStops.map(s => ({
        type: "Feature" as const,
        properties: {
          stopId: s.stopId, name: s.stopName, km: s.progressiveKm,
          isFrom: s.stopId === fromStop, isTo: s.stopId === toStop,
          isIntermediate: result?.intermediateStops?.some(is => is.stopId === s.stopId) ?? false,
        },
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      })),
    };
  }, [routeStops, fromStop, toStop, result]);

  // ═══════════ RENDER ═══════════
  return (
    <div className="space-y-4">
      {/* Mode switcher */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit">
        <button
          onClick={() => { setSimMode("line"); setClResult(null); }}
          className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            simMode === "line" ? "text-foreground bg-background/80 border border-border/50 shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
          }`}
        >
          <ArrowRightLeft className="w-3.5 h-3.5" /> Km per Linea
        </button>
        <button
          onClick={() => { setSimMode("cluster"); setResult(null); }}
          className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            simMode === "cluster" ? "text-foreground bg-background/80 border border-border/50 shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
          }`}
        >
          <Hexagon className="w-3.5 h-3.5" /> Cluster
        </button>
      </div>

      {/* ══════════════ LINE MODE ══════════════ */}
      {simMode === "line" && (
        <>
          <Card className="bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Play className="w-4 h-4 text-primary" />
                Simulatore per Km Linea
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Rete Tariffaria</label>
                  <select value={selectedNetwork}
                    onChange={e => { setSelectedNetwork(e.target.value); setSelectedRoute(""); setResult(null); }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30">
                    <option value="">— Seleziona rete —</option>
                    {NETWORK_OPTIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
                  </select>
                </div>
                {selectedNetwork === "extraurbano" && (
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">Linea</label>
                    <select value={selectedRoute}
                      onChange={e => { setSelectedRoute(e.target.value); setFromStop(""); setToStop(""); setResult(null); }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30">
                      <option value="">— Seleziona linea —</option>
                      {filteredRoutes.map(r => (
                        <option key={r.routeId} value={r.routeId}>{r.shortName || r.routeId} — {r.longName}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              {selectedNetwork === "extraurbano" && selectedRoute && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Fermata Salita</span>
                    </label>
                    <select value={fromStop} onChange={e => { setFromStop(e.target.value); setResult(null); }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30" disabled={loadingStops}>
                      <option value="">— Seleziona fermata —</option>
                      {routeStops.map(s => (<option key={s.stopId} value={s.stopId}>{s.stopName} (km {s.progressiveKm.toFixed(1)})</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Fermata Discesa</span>
                    </label>
                    <select value={toStop} onChange={e => { setToStop(e.target.value); setResult(null); }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30" disabled={loadingStops}>
                      <option value="">— Seleziona fermata —</option>
                      {routeStops.map(s => (<option key={s.stopId} value={s.stopId}>{s.stopName} (km {s.progressiveKm.toFixed(1)})</option>))}
                    </select>
                  </div>
                </div>
              )}
              <Button onClick={simulateLine}
                disabled={loading || !selectedNetwork || (selectedNetwork === "extraurbano" && (!selectedRoute || !fromStop || !toStop))}
                className="w-full sm:w-auto">
                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                Calcola Tariffa
              </Button>
            </CardContent>
          </Card>

          {/* Map + Result for line mode */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {selectedNetwork === "extraurbano" && selectedRoute && routeStops.length > 0 && (
              <Card className="bg-card/50 lg:col-span-3 overflow-hidden">
                <div className="relative w-full h-[400px] lg:h-[500px]">
                  <Map ref={mapRef} mapboxAccessToken={MAPBOX_TOKEN}
                    initialViewState={{ longitude: 13.35, latitude: 43.55, zoom: 10 }}
                    style={{ width: "100%", height: "100%" }} mapStyle="mapbox://styles/mapbox/dark-v11" attributionControl={false}>
                    {routeLineGeoJson && (
                      <Source id="route-line" type="geojson" data={routeLineGeoJson}>
                        <Layer id="route-line-layer" type="line" paint={{ "line-color": "#6b7280", "line-width": 3, "line-opacity": 0.5, "line-dasharray": [2, 2] }} />
                      </Source>
                    )}
                    {segmentGeoJson && (
                      <Source id="segment-line" type="geojson" data={segmentGeoJson}>
                        <Layer id="segment-line-layer" type="line" paint={{ "line-color": "#10b981", "line-width": 5, "line-opacity": 0.9 }} />
                      </Source>
                    )}
                    {stopsGeoJson && (
                      <Source id="stops-points" type="geojson" data={stopsGeoJson}>
                        <Layer id="stops-default" type="circle"
                          filter={["all", ["!", ["get", "isFrom"]], ["!", ["get", "isTo"]], ["!", ["get", "isIntermediate"]]]}
                          paint={{ "circle-radius": 4, "circle-color": "#6b7280", "circle-stroke-width": 1, "circle-stroke-color": "#374151", "circle-opacity": 0.6 }} />
                        <Layer id="stops-intermediate" type="circle"
                          filter={["all", ["get", "isIntermediate"], ["!", ["get", "isFrom"]], ["!", ["get", "isTo"]]]}
                          paint={{ "circle-radius": 5, "circle-color": "#14b8a6", "circle-stroke-width": 1.5, "circle-stroke-color": "#fff", "circle-opacity": 0.8 }} />
                      </Source>
                    )}
                    {fromStop && routeStops.find(s => s.stopId === fromStop) && (() => {
                      const s = routeStops.find(s => s.stopId === fromStop)!;
                      return (
                        <Marker longitude={s.lon} latitude={s.lat} anchor="center">
                          <div className="relative">
                            <div className="w-6 h-6 rounded-full bg-emerald-500 border-2 border-white shadow-lg flex items-center justify-center"><Navigation className="w-3 h-3 text-white" /></div>
                            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-emerald-600/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">SALITA</div>
                          </div>
                        </Marker>
                      );
                    })()}
                    {toStop && routeStops.find(s => s.stopId === toStop) && (() => {
                      const s = routeStops.find(s => s.stopId === toStop)!;
                      return (
                        <Marker longitude={s.lon} latitude={s.lat} anchor="center">
                          <div className="relative">
                            <div className="w-6 h-6 rounded-full bg-rose-500 border-2 border-white shadow-lg flex items-center justify-center"><MapPin className="w-3 h-3 text-white" /></div>
                            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-rose-600/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">DISCESA</div>
                          </div>
                        </Marker>
                      );
                    })()}
                  </Map>
                  <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm text-white text-[10px] p-2 rounded-lg space-y-1">
                    <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Salita</div>
                    <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Discesa</div>
                    <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-teal-500" /> Tratta</div>
                  </div>
                </div>
              </Card>
            )}
            <div className={`space-y-4 ${selectedNetwork === "extraurbano" && selectedRoute && routeStops.length > 0 ? "lg:col-span-2" : "lg:col-span-5"}`}>
              <AnimatePresence>
                {result && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <Card className="bg-emerald-500/5 border-emerald-500/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2 text-emerald-400">
                          <CheckCircle2 className="w-4 h-4" /> Risultato Simulazione
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        {result.type === "urban" ? (
                          <div className="space-y-2">
                            <p className="text-sm">Tariffa <strong>flat</strong> per la rete <Badge variant="outline">{NETWORK_OPTIONS.find(n => n.value === result.networkId)?.label}</Badge></p>
                            <div className="space-y-2 mt-3">
                              {result.products?.map(p => (
                                <div key={p.fareProductId} className="flex items-center justify-between p-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5">
                                  <div>
                                    <p className="text-sm font-medium">{p.name}</p>
                                    {p.durationMinutes && <p className="text-[10px] text-muted-foreground">Validità: {p.durationMinutes} min</p>}
                                  </div>
                                  <span className="text-xl font-bold text-emerald-400">€{p.amount.toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Bus className="w-3.5 h-3.5" /><span>Linea {result.routeId}</span></div>
                            <div className="flex items-start gap-3">
                              <div className="flex flex-col items-center gap-1 pt-1">
                                <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-emerald-300" />
                                <div className="w-0.5 h-8 bg-gradient-to-b from-emerald-500 to-rose-500 rounded" />
                                <div className="w-3 h-3 rounded-full bg-rose-500 border-2 border-rose-300" />
                              </div>
                              <div className="flex-1 space-y-2">
                                <div><p className="text-xs text-muted-foreground">Salita — km {result.fromStop?.km?.toFixed(1)}</p><p className="text-sm font-medium">{result.fromStop?.name}</p></div>
                                <div><p className="text-xs text-muted-foreground">Discesa — km {result.toStop?.km?.toFixed(1)}</p><p className="text-sm font-medium">{result.toStop?.name}</p></div>
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              <div className="p-2 rounded-lg bg-muted/20 text-center">
                                <p className="text-[10px] text-muted-foreground uppercase">Distanza</p>
                                <p className="text-lg font-bold">{result.distanceKm?.toFixed(1)} <span className="text-xs font-normal">km</span></p>
                              </div>
                              <div className="p-2 rounded-lg bg-muted/20 text-center">
                                <p className="text-[10px] text-muted-foreground uppercase">Fascia</p>
                                <p className="text-lg font-bold">F{result.fascia}</p>
                              </div>
                              <div className="p-2 rounded-lg bg-muted/20 text-center">
                                <p className="text-[10px] text-muted-foreground uppercase">Range</p>
                                <p className="text-lg font-bold text-xs mt-1">{result.bandRange}</p>
                              </div>
                            </div>
                            {result.percorsiCount && result.percorsiCount > 1 && result.distanceVariants && (
                              <div className="p-2.5 rounded-lg bg-muted/20 border border-border/20 text-xs space-y-1.5">
                                <p className="font-medium text-foreground">
                                  Media su {result.percorsiCount} percorsi distinti (DGR 1036/2022 art. 2.d)
                                </p>
                                {result.distanceVariants.map((v, i) => (
                                  <div key={i} className="flex items-center justify-between text-muted-foreground">
                                    <span className="truncate max-w-[180px]">shape {v.shapeId || "n/a"}</span>
                                    <span className="font-mono">{v.km.toFixed(2)} km</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center justify-between p-4 rounded-xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 to-emerald-500/5">
                              <div>
                                <p className="text-sm font-medium">Biglietto Corsa Semplice</p>
                                <p className="text-[10px] text-muted-foreground">{result.intermediateStops?.length || 0} fermate nel percorso</p>
                              </div>
                              <span className="text-4xl font-bold text-emerald-400">€{result.amount?.toFixed(2)}</span>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </motion.div>
                )}
              </AnimatePresence>
              {selectedNetwork === "extraurbano" && selectedRoute && routeStops.length > 0 && !result && (
                <Card className="bg-card/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-primary" /> Fermate della linea ({routeStops.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="max-h-[300px] overflow-auto space-y-0.5">
                      {routeStops.map((s, i) => (
                        <div key={s.stopId}
                          className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                            s.stopId === fromStop ? "bg-emerald-500/10 text-emerald-400" :
                            s.stopId === toStop ? "bg-rose-500/10 text-rose-400" : "text-muted-foreground hover:bg-muted/20"
                          }`}>
                          <span className="w-5 text-right font-mono text-[10px] opacity-50">{i + 1}</span>
                          <span className={`w-2 h-2 rounded-full ${s.stopId === fromStop ? "bg-emerald-500" : s.stopId === toStop ? "bg-rose-500" : "bg-gray-500/40"}`} />
                          <span className="flex-1 truncate">{s.stopName}</span>
                          <span className="font-mono text-[10px] opacity-60">km {s.progressiveKm.toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      {/* ══════════════ CLUSTER MODE ══════════════ */}
      {simMode === "cluster" && (
        <>
          <Card className="bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Hexagon className="w-4 h-4 text-violet-400" />
                Simulatore per Cluster
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Line selector (extraurbano only) */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Linea Extraurbana</label>
                <select value={clSelectedRoute}
                  onChange={e => { setClSelectedRoute(e.target.value); setClFrom(""); setClTo(""); setClResult(null); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30">
                  <option value="">— Seleziona linea —</option>
                  {clFilteredRoutes.map(r => (
                    <option key={r.routeId} value={r.routeId}>{r.shortName || r.routeId} — {r.longName}</option>
                  ))}
                </select>
              </div>
              {/* From / To stop selectors */}
              {clSelectedRoute && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Fermata Salita</span>
                    </label>
                    <select value={clFrom} onChange={e => { setClFrom(e.target.value); setClResult(null); }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30" disabled={clLoadingStops}>
                      <option value="">— Seleziona fermata —</option>
                      {clRouteStops.map(s => (<option key={s.stopId} value={s.stopId}>{s.stopName} (km {s.progressiveKm.toFixed(1)})</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Fermata Discesa</span>
                    </label>
                    <select value={clTo} onChange={e => { setClTo(e.target.value); setClResult(null); }}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30" disabled={clLoadingStops}>
                      <option value="">— Seleziona fermata —</option>
                      {clRouteStops.map(s => (<option key={s.stopId} value={s.stopId}>{s.stopName} (km {s.progressiveKm.toFixed(1)})</option>))}
                    </select>
                  </div>
                </div>
              )}
              <Button onClick={simulateCluster} disabled={clLoading || !clFrom || !clTo} className="w-full sm:w-auto">
                {clLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                Calcola Tariffa per Cluster
              </Button>
            </CardContent>
          </Card>

          {/* Map + Result for cluster mode */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* Map with cluster hulls */}
            {(clSelectedRoute && clRouteStops.length > 0) && (
              <Card className="bg-card/50 lg:col-span-3 overflow-hidden">
                <div className="relative w-full h-[400px] lg:h-[500px]">
                  <Map ref={mapRef} mapboxAccessToken={MAPBOX_TOKEN}
                    initialViewState={{ longitude: 13.35, latitude: 43.55, zoom: 10 }}
                    style={{ width: "100%", height: "100%" }} mapStyle="mapbox://styles/mapbox/navigation-night-v1" attributionControl={false}>

                    {/* Route line (dashed, as background) */}
                    {clRouteLineGeoJson && (
                      <Source id="cl-route-line" type="geojson" data={clRouteLineGeoJson}>
                        <Layer id="cl-route-line-layer" type="line" paint={{ "line-color": "#6b7280", "line-width": 2.5, "line-opacity": 0.4, "line-dasharray": [2, 2] }} />
                      </Source>
                    )}

                    {/* Route stops (small dots) */}
                    {clStopsGeoJson && (
                      <Source id="cl-stops-pts" type="geojson" data={clStopsGeoJson}>
                        <Layer id="cl-stops-default" type="circle"
                          filter={["all", ["!", ["get", "isFrom"]], ["!", ["get", "isTo"]]]}
                          paint={{ "circle-radius": 3.5, "circle-color": "#6b7280", "circle-stroke-width": 1, "circle-stroke-color": "#374151", "circle-opacity": 0.5 }} />
                      </Source>
                    )}

                    {/* Cluster hull fills */}
                    {clusterHullsGeoJSON && (
                      <Source id="cl-hulls" type="geojson" data={clusterHullsGeoJSON as any}>
                        <Layer id="cl-hull-fill" type="fill"
                          paint={{ "fill-color": ["get", "color"], "fill-opacity": 0.2 }} />
                        <Layer id="cl-hull-stroke" type="line"
                          paint={{ "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.7 }} />
                        <Layer id="cl-hull-label" type="symbol"
                          layout={{
                            "text-field": ["get", "name"],
                            "text-size": 11,
                            "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
                          }}
                          paint={{ "text-color": ["get", "color"], "text-halo-color": "#0f172a", "text-halo-width": 1.5 }} />
                      </Source>
                    )}

                    {/* Centroid-to-centroid line */}
                    {centroidLineGeoJSON && (
                      <Source id="cl-centroid-line" type="geojson" data={centroidLineGeoJSON as any}>
                        <Layer id="cl-centroid-line-layer" type="line"
                          paint={{ "line-color": "#ffffff", "line-width": 2, "line-dasharray": [4, 3], "line-opacity": 0.6 }} />
                      </Source>
                    )}

                    {/* From stop marker (pre-simulation) */}
                    {!clResult && clFrom && clRouteStops.find(s => s.stopId === clFrom) && (() => {
                      const s = clRouteStops.find(s => s.stopId === clFrom)!;
                      return (
                        <Marker longitude={s.lon} latitude={s.lat} anchor="center">
                          <div className="relative">
                            <div className="w-6 h-6 rounded-full bg-emerald-500 border-2 border-white shadow-lg flex items-center justify-center"><Navigation className="w-3 h-3 text-white" /></div>
                            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-emerald-600/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">SALITA</div>
                          </div>
                        </Marker>
                      );
                    })()}

                    {/* To stop marker (pre-simulation) */}
                    {!clResult && clTo && clRouteStops.find(s => s.stopId === clTo) && (() => {
                      const s = clRouteStops.find(s => s.stopId === clTo)!;
                      return (
                        <Marker longitude={s.lon} latitude={s.lat} anchor="center">
                          <div className="relative">
                            <div className="w-6 h-6 rounded-full bg-rose-500 border-2 border-white shadow-lg flex items-center justify-center"><MapPin className="w-3 h-3 text-white" /></div>
                            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-rose-600/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">DISCESA</div>
                          </div>
                        </Marker>
                      );
                    })()}

                    {/* From stop marker (post-simulation with cluster color) */}
                    {clResult?.fromStop && (
                      <Marker longitude={clResult.fromStop.lon} latitude={clResult.fromStop.lat} anchor="center">
                        <div className="relative">
                          <div className="w-7 h-7 rounded-full border-3 border-white shadow-xl flex items-center justify-center"
                            style={{ backgroundColor: clResult.fromCluster.color }}>
                            <Navigation className="w-3.5 h-3.5 text-white" />
                          </div>
                          <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-white text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shadow-lg"
                            style={{ backgroundColor: clResult.fromCluster.color + "dd" }}>
                            SALITA
                          </div>
                        </div>
                      </Marker>
                    )}

                    {/* To stop marker */}
                    {clResult?.toStop && (
                      <Marker longitude={clResult.toStop.lon} latitude={clResult.toStop.lat} anchor="center">
                        <div className="relative">
                          <div className="w-7 h-7 rounded-full border-3 border-white shadow-xl flex items-center justify-center"
                            style={{ backgroundColor: clResult.toCluster.color }}>
                            <MapPin className="w-3.5 h-3.5 text-white" />
                          </div>
                          <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-white text-[8px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap shadow-lg"
                            style={{ backgroundColor: clResult.toCluster.color + "dd" }}>
                            DISCESA
                          </div>
                        </div>
                      </Marker>
                    )}

                    {/* Centroid markers */}
                    {clResult && (
                      <>
                        <Marker longitude={clResult.fromCluster.centroidLon} latitude={clResult.fromCluster.centroidLat} anchor="center">
                          <div className="w-3 h-3 rounded-full border-2 border-white/60 opacity-70" style={{ backgroundColor: clResult.fromCluster.color }} />
                        </Marker>
                        {!clResult.sameCluster && (
                          <Marker longitude={clResult.toCluster.centroidLon} latitude={clResult.toCluster.centroidLat} anchor="center">
                            <div className="w-3 h-3 rounded-full border-2 border-white/60 opacity-70" style={{ backgroundColor: clResult.toCluster.color }} />
                          </Marker>
                        )}
                      </>
                    )}
                  </Map>

                  {/* Legend */}
                  {clResult ? (
                    <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm text-white text-[10px] p-2.5 rounded-lg space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: clResult.fromCluster.color + "44", border: `2px solid ${clResult.fromCluster.color}` }} />
                        {clResult.fromCluster.clusterName}
                      </div>
                      {!clResult.sameCluster && (
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: clResult.toCluster.color + "44", border: `2px solid ${clResult.toCluster.color}` }} />
                          {clResult.toCluster.clusterName}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 h-0 border-t-2 border-dashed border-white/60" />
                        Distanza centroidi
                      </div>
                    </div>
                  ) : (
                    <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm text-white text-[10px] p-2 rounded-lg space-y-1">
                      <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Salita</div>
                      <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Discesa</div>
                      <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gray-500" /> Fermate</div>
                    </div>
                  )}
                </div>
              </Card>
            )}

            {/* Result card */}
            <div className={`space-y-4 ${(clSelectedRoute && clRouteStops.length > 0) ? "lg:col-span-2" : "lg:col-span-5"}`}>
              <AnimatePresence>
                {clResult && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <Card className="bg-violet-500/5 border-violet-500/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base flex items-center gap-2 text-violet-400">
                          <CheckCircle2 className="w-4 h-4" /> Risultato Simulazione Cluster
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {/* From cluster → To cluster */}
                        <div className="flex items-start gap-3">
                          <div className="flex flex-col items-center gap-1 pt-1">
                            <div className="w-4 h-4 rounded-full border-2" style={{ backgroundColor: clResult.fromCluster.color, borderColor: clResult.fromCluster.color + "88" }} />
                            <div className="w-0.5 h-10 rounded" style={{ background: `linear-gradient(${clResult.fromCluster.color}, ${clResult.toCluster.color})` }} />
                            <div className="w-4 h-4 rounded-full border-2" style={{ backgroundColor: clResult.toCluster.color, borderColor: clResult.toCluster.color + "88" }} />
                          </div>
                          <div className="flex-1 space-y-3">
                            <div>
                              <p className="text-[10px] text-muted-foreground">Salita</p>
                              <p className="text-sm font-medium">{clResult.fromStop?.name}</p>
                              <p className="text-[10px] mt-0.5 px-1.5 py-0.5 rounded-full w-fit" style={{ backgroundColor: clResult.fromCluster.color + "22", color: clResult.fromCluster.color }}>
                                {clResult.fromCluster.clusterName}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Discesa</p>
                              <p className="text-sm font-medium">{clResult.toStop?.name}</p>
                              <p className="text-[10px] mt-0.5 px-1.5 py-0.5 rounded-full w-fit" style={{ backgroundColor: clResult.toCluster.color + "22", color: clResult.toCluster.color }}>
                                {clResult.toCluster.clusterName}
                              </p>
                            </div>
                          </div>
                        </div>

                        {clResult.sameCluster ? (
                          <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-sm text-center">
                            <p className="font-medium text-blue-300">Stesso Cluster</p>
                            <p className="text-xs text-muted-foreground">Le fermate appartengono allo stesso cluster</p>
                          </div>
                        ) : (
                          <div className="grid grid-cols-3 gap-2">
                            <div className="p-2 rounded-lg bg-muted/20 text-center">
                              <p className="text-[10px] text-muted-foreground uppercase">Distanza</p>
                              <p className="text-lg font-bold">{clResult.distanceKm.toFixed(1)} <span className="text-xs font-normal">km</span></p>
                            </div>
                            <div className="p-2 rounded-lg bg-muted/20 text-center">
                              <p className="text-[10px] text-muted-foreground uppercase">Fascia</p>
                              <p className="text-lg font-bold">{clResult.fascia ? `F${clResult.fascia}` : "—"}</p>
                            </div>
                            <div className="p-2 rounded-lg bg-muted/20 text-center">
                              <p className="text-[10px] text-muted-foreground uppercase">Range</p>
                              <p className="text-lg font-bold text-xs mt-1">{clResult.bandRange || "—"}</p>
                            </div>
                          </div>
                        )}

                        {/* Price */}
                        <div className="flex items-center justify-between p-4 rounded-xl border bg-gradient-to-r"
                          style={{ borderColor: (clResult.sameCluster ? clResult.fromCluster.color : "#8b5cf6") + "44", background: `linear-gradient(135deg, ${(clResult.sameCluster ? clResult.fromCluster.color : "#8b5cf6")}11, transparent)` }}>
                          <div>
                            <p className="text-sm font-medium">Biglietto Corsa Semplice</p>
                            <p className="text-[10px] text-muted-foreground">
                              {clResult.sameCluster ? "Spostamento intra-cluster" : `${clResult.fromCluster.clusterName} → ${clResult.toCluster.clusterName}`}
                            </p>
                          </div>
                          <span className="text-4xl font-bold" style={{ color: clResult.sameCluster ? clResult.fromCluster.color : "#a78bfa" }}>
                            €{(clResult.amount ?? 0).toFixed(2)}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Info panel when no result */}
              {!clResult && !clSelectedRoute && (
                <Card className="bg-card/50">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <Info className="w-4 h-4 text-violet-400 mt-0.5 shrink-0" />
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p className="font-medium text-foreground">Come funziona</p>
                        <p>Seleziona una <strong>linea extraurbana</strong>, poi scegli una fermata di <strong>salita</strong> e una di <strong>discesa</strong>. Il simulatore troverà a quale cluster appartiene ciascuna e calcolerà la tariffa in base alla <strong>distanza tra i centroidi</strong> dei due cluster.</p>
                        <p>La mappa mostrerà le aree colorate dei cluster coinvolti.</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
              {/* Stops list when line selected but no result */}
              {!clResult && clSelectedRoute && clRouteStops.length > 0 && (
                <Card className="bg-card/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><MapPin className="w-3.5 h-3.5 text-violet-400" /> Fermate della linea ({clRouteStops.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="max-h-[300px] overflow-auto space-y-0.5">
                      {clRouteStops.map((s, i) => (
                        <div key={s.stopId}
                          className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                            s.stopId === clFrom ? "bg-emerald-500/10 text-emerald-400" :
                            s.stopId === clTo ? "bg-rose-500/10 text-rose-400" : "text-muted-foreground hover:bg-muted/20"
                          }`}>
                          <span className="w-5 text-right font-mono text-[10px] opacity-50">{i + 1}</span>
                          <span className={`w-2 h-2 rounded-full ${s.stopId === clFrom ? "bg-emerald-500" : s.stopId === clTo ? "bg-rose-500" : "bg-gray-500/40"}`} />
                          <span className="flex-1 truncate">{s.stopName}</span>
                          <span className="font-mono text-[10px] opacity-60">km {s.progressiveKm.toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="w-6 h-6 text-primary animate-spin" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB: FEED INFO
// ═══════════════════════════════════════════════════════════

function FeedInfoTab() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    feedPublisherName: "ATMA Scpa",
    feedPublisherUrl: "https://www.atmaancona.it",
    feedLang: "it",
    defaultLang: "",
    feedStartDate: "",
    feedEndDate: "",
    feedVersion: "",
    feedContactEmail: "info@atmaancona.it",
    feedContactUrl: "https://www.atmaancona.it",
  });

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<any>("/api/fares/feed-info");
        if (data) {
          setForm({
            feedPublisherName: data.feedPublisherName || "",
            feedPublisherUrl: data.feedPublisherUrl || "",
            feedLang: data.feedLang || "it",
            defaultLang: data.defaultLang || "",
            feedStartDate: data.feedStartDate || "",
            feedEndDate: data.feedEndDate || "",
            feedVersion: data.feedVersion || "",
            feedContactEmail: data.feedContactEmail || "",
            feedContactUrl: data.feedContactUrl || "",
          });
        }
      } catch { /* noop */ }
      setLoading(false);
    })();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch("/api/fares/feed-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      toast({ title: "✅ Feed Info salvato" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  if (loading) return <LoadingSpinner />;

  const fields: { key: keyof typeof form; label: string; placeholder: string; required?: boolean }[] = [
    { key: "feedPublisherName", label: "Publisher Name", placeholder: "ATMA Scpa", required: true },
    { key: "feedPublisherUrl", label: "Publisher URL", placeholder: "https://www.atmaancona.it", required: true },
    { key: "feedLang", label: "Lingua (BCP-47)", placeholder: "it", required: true },
    { key: "defaultLang", label: "Default Lang", placeholder: "it" },
    { key: "feedStartDate", label: "Data inizio (YYYYMMDD)", placeholder: "20260101" },
    { key: "feedEndDate", label: "Data fine (YYYYMMDD)", placeholder: "20261231" },
    { key: "feedVersion", label: "Versione feed", placeholder: "1.0.0" },
    { key: "feedContactEmail", label: "Email contatto", placeholder: "info@atmaancona.it" },
    { key: "feedContactUrl", label: "URL contatto", placeholder: "https://www.atmaancona.it" },
  ];

  return (
    <div className="space-y-6">
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            Feed Info (feed_info.txt)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            Metadati del feed GTFS — identificano il publisher e la validità temporale del dataset.
            Questi dati finiscono nel file <code>feed_info.txt</code> incluso nell'export ZIP.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                </label>
                <input
                  type="text"
                  value={form[f.key]}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 rounded-lg border border-border/50 bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-4">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Salva Feed Info
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════

export default function FaresPage() {
  const [tab, setTab] = useState<Tab>("classify");

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-8">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-xl bg-primary/10 border border-primary/20">
            <Ticket className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Bigliettazione Elettronica</h1>
            <p className="text-sm text-muted-foreground">
              GTFS Fares V2 — Classificazione reti, prodotti tariffari, zone e generazione file
            </p>
          </div>
        </div>
      </motion.div>

      {/* Tab bar — scrollable */}
      <div className="relative">
        <div
          className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 overflow-x-auto scroll-smooth
            [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]
            [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent
            [&::-webkit-scrollbar-thumb]:bg-border/50 [&::-webkit-scrollbar-thumb]:rounded-full
            hover:[&::-webkit-scrollbar-thumb]:bg-border"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`
                relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap shrink-0
                transition-all duration-200
                ${tab === t.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                }
              `}
            >
              {tab === t.id && (
                <motion.div
                  layoutId="fares-tab-bg"
                  className="absolute inset-0 bg-background/80 border border-border/50 rounded-lg shadow-sm"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2">
                {t.icon}
                {t.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          {tab === "classify" && <ClassifyTab />}
          {tab === "products" && <ProductsTab />}
          {tab === "riders" && <RiderCategoriesTab />}
          {tab === "zones" && <ZonesContainerTab />}
          {tab === "timeframes" && <TimeframesTab />}
          {tab === "calendar" && <CalendarTab />}
          {tab === "editor" && <StopTimesEditorTab />}
          {tab === "generate" && <GenerateTab />}
          {tab === "simulate" && <SimulateTab />}
          {tab === "feedinfo" && <FeedInfoTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
