import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Map, { Source, Layer, Marker, MapRef } from "react-map-gl/mapbox";
import {
  Ticket, Tag, MapPin, Download, Play, Loader2, CheckCircle2, AlertTriangle,
  ChevronDown, Save, RefreshCw, Sparkles, Bus, ArrowRightLeft, Euro,
  FileText, Shield, Zap, Search, Filter, Navigation, Circle,
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
    isComplete: boolean;
  };
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

type Tab = "classify" | "products" | "zones" | "generate" | "simulate";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "classify", label: "Classificazione Linee", icon: <Tag className="w-3.5 h-3.5" /> },
  { id: "products", label: "Prodotti & Supporti", icon: <Euro className="w-3.5 h-3.5" /> },
  { id: "zones", label: "Zone Extraurbane", icon: <MapPin className="w-3.5 h-3.5" /> },
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

      {/* Rider Categories */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Bus className="w-4 h-4 text-primary" />
            Categorie Passeggero (rider_categories)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna categoria configurata.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {categories.map(c => (
                <Badge key={c.riderCategoryId} variant={c.isDefault ? "default" : "outline"} className="py-1.5 px-3">
                  {c.riderCategoryName}
                  {c.isDefault && <CheckCircle2 className="w-3 h-3 ml-1.5" />}
                </Badge>
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
                      <th className="text-right py-2 px-2 font-medium text-muted-foreground">Km</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Fascia</th>
                      <th className="text-left py-2 px-2 font-medium text-muted-foreground">Zona</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeStops.map((s, i) => (
                      <tr key={`${s.stopId}-${i}`} className="border-b border-border/10 hover:bg-muted/10">
                        <td className="py-1.5 px-2 text-muted-foreground">{s.sequence}</td>
                        <td className="py-1.5 px-2">
                          <div>
                            <span className="font-medium">{s.stopName}</span>
                            <span className="text-[10px] text-muted-foreground ml-2 font-mono">{s.stopId}</span>
                          </div>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono">{s.progressiveKm.toFixed(1)}</td>
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
                    ))}
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
// TAB 4: GENERA & ESPORTA
// ═══════════════════════════════════════════════════════════

function GenerateTab() {
  const { toast } = useToast();
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatingRules, setGeneratingRules] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);

  const generateRules = async () => {
    setGeneratingRules(true);
    try {
      const r = await apiFetch<{ urbanRules: number; odRules: number; total: number }>(
        "/api/fares/leg-rules/generate", { method: "POST" }
      );
      toast({
        title: "Regole generate",
        description: `${r.urbanRules} regole urbane + ${r.odRules} regole OD = ${r.total} totali`,
      });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setGeneratingRules(false);
  };

  const generate = async () => {
    setGenerating(true);
    try {
      const data = await apiFetch<GenerateResult>("/api/fares/generate-gtfs", { method: "POST" });
      setResult(data);
      toast({ title: "GTFS Fares V2 generato", description: `${Object.keys(data.files).length} file pronti` });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setGenerating(false);
  };

  const downloadZip = () => {
    if (!result) return;
    // Create a zip-like download of all files (simplified: download individual CSVs)
    for (const [filename, content] of Object.entries(result.files)) {
      const blob = new Blob([content], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
    toast({ title: "Download", description: "File CSV scaricati" });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={generateRules} disabled={generatingRules} variant="outline" size="sm">
          {generatingRules ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Zap className="w-3.5 h-3.5 mr-1.5" />}
          1. Genera Regole Tariffarie
        </Button>
        <Button onClick={generate} disabled={generating} size="sm">
          {generating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <FileText className="w-3.5 h-3.5 mr-1.5" />}
          2. Genera File GTFS Fares V2
        </Button>
        {result && (
          <Button onClick={downloadZip} variant="outline" size="sm">
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Scarica Tutti i CSV
          </Button>
        )}
      </div>

      {result && (
        <>
          {/* Validation */}
          <Card className={result.validation.isComplete ? "bg-emerald-500/5 border-emerald-500/20" : "bg-amber-500/5 border-amber-500/20"}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {result.validation.isComplete
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  : <AlertTriangle className="w-4 h-4 text-amber-500" />
                }
                Validazione
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div><span className="text-muted-foreground">Linee classificate:</span> <span className="font-mono">{result.validation.routesClassified}/{result.validation.totalRoutes}</span></div>
                <div><span className="text-muted-foreground">Prodotti:</span> <span className="font-mono">{result.validation.products}</span></div>
                <div><span className="text-muted-foreground">Aree:</span> <span className="font-mono">{result.validation.areas}</span></div>
                <div><span className="text-muted-foreground">Regole:</span> <span className="font-mono">{result.validation.legRules}</span></div>
              </div>
              {result.validation.missingRoutes.length > 0 && (
                <p className="text-amber-600 text-xs mt-2">
                  ⚠ Linee non classificate: {result.validation.missingRoutes.join(", ")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* File list */}
          <Card className="bg-card/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">File Generati ({Object.keys(result.files).length})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {Object.entries(result.files).map(([filename, content]) => {
                  const lines = content.split("\n").filter(Boolean).length;
                  return (
                    <button
                      key={filename}
                      onClick={() => setPreviewFile(previewFile === filename ? null : filename)}
                      className={`text-left p-3 rounded-lg border transition-colors ${previewFile === filename ? "border-primary/50 bg-primary/5" : "border-border/30 hover:bg-muted/20"}`}
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="w-3.5 h-3.5 text-primary shrink-0" />
                        <span className="text-sm font-medium truncate">{filename}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-1">{lines} righe</p>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Preview */}
          {previewFile && result.files[previewFile] && (
            <Card className="bg-card/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono">{previewFile}</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-[11px] font-mono bg-background/50 rounded-lg p-4 overflow-auto max-h-[300px] whitespace-pre text-muted-foreground">
                  {result.files[previewFile]}
                </pre>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 5: SIMULATORE BIGLIETTO + MAPPA
// ═══════════════════════════════════════════════════════════

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

function SimulateTab() {
  const { toast } = useToast();
  const mapRef = useRef<MapRef>(null);
  const [routeNets, setRouteNets] = useState<RouteNetwork[]>([]);
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [selectedRoute, setSelectedRoute] = useState("");
  const [fromStop, setFromStop] = useState("");
  const [toStop, setToStop] = useState("");
  const [routeStops, setRouteStops] = useState<RouteStop[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStops, setLoadingStops] = useState(false);

  useEffect(() => {
    apiFetch<RouteNetwork[]>("/api/fares/route-networks").then(setRouteNets).catch(() => {});
  }, []);

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

  // Fit map to route stops when they load
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

  // Fit to simulation result
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

  const simulate = async () => {
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

  // GeoJSON for the route line (all stops of the route)
  const routeLineGeoJson = useMemo(() => {
    if (routeStops.length < 2) return null;
    return {
      type: "FeatureCollection" as const,
      features: [{
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: routeStops.map(s => [s.lon, s.lat]),
        },
      }],
    };
  }, [routeStops]);

  // GeoJSON for the highlighted segment (from → to)
  const segmentGeoJson = useMemo(() => {
    if (!result?.intermediateStops || result.intermediateStops.length < 2) return null;
    return {
      type: "FeatureCollection" as const,
      features: [{
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "LineString" as const,
          coordinates: result.intermediateStops.map(s => [s.lon, s.lat]),
        },
      }],
    };
  }, [result]);

  // GeoJSON for all stops as points
  const stopsGeoJson = useMemo(() => {
    if (routeStops.length === 0) return null;
    return {
      type: "FeatureCollection" as const,
      features: routeStops.map(s => ({
        type: "Feature" as const,
        properties: {
          stopId: s.stopId,
          name: s.stopName,
          km: s.progressiveKm,
          isFrom: s.stopId === fromStop,
          isTo: s.stopId === toStop,
          isIntermediate: result?.intermediateStops?.some(is => is.stopId === s.stopId) ?? false,
        },
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
      })),
    };
  }, [routeStops, fromStop, toStop, result]);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Play className="w-4 h-4 text-primary" />
            Simulatore Validazione Biglietto
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Network selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Rete Tariffaria</label>
              <select
                value={selectedNetwork}
                onChange={e => { setSelectedNetwork(e.target.value); setSelectedRoute(""); setResult(null); }}
                className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              >
                <option value="">— Seleziona rete —</option>
                {NETWORK_OPTIONS.map(n => <option key={n.value} value={n.value}>{n.label}</option>)}
              </select>
            </div>

            {selectedNetwork === "extraurbano" && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Linea</label>
                <select
                  value={selectedRoute}
                  onChange={e => { setSelectedRoute(e.target.value); setFromStop(""); setToStop(""); setResult(null); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  <option value="">— Seleziona linea —</option>
                  {filteredRoutes.map(r => (
                    <option key={r.routeId} value={r.routeId}>{r.shortName || r.routeId} — {r.longName}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Stop selection for extraurban */}
          {selectedNetwork === "extraurbano" && selectedRoute && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                    Fermata Salita
                  </span>
                </label>
                <select
                  value={fromStop}
                  onChange={e => { setFromStop(e.target.value); setResult(null); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                  disabled={loadingStops}
                >
                  <option value="">— Seleziona fermata —</option>
                  {routeStops.map(s => (
                    <option key={s.stopId} value={s.stopId}>{s.stopName} (km {s.progressiveKm.toFixed(1)})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                    Fermata Discesa
                  </span>
                </label>
                <select
                  value={toStop}
                  onChange={e => { setToStop(e.target.value); setResult(null); }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-border/50 bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
                  disabled={loadingStops}
                >
                  <option value="">— Seleziona fermata —</option>
                  {routeStops.map(s => (
                    <option key={s.stopId} value={s.stopId}>{s.stopName} (km {s.progressiveKm.toFixed(1)})</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <Button
            onClick={simulate}
            disabled={loading || !selectedNetwork || (selectedNetwork === "extraurbano" && (!selectedRoute || !fromStop || !toStop))}
            className="w-full sm:w-auto"
          >
            {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            Calcola Tariffa
          </Button>
        </CardContent>
      </Card>

      {/* Map + Result side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Map (takes 3/5 on large screens) */}
        {selectedNetwork === "extraurbano" && selectedRoute && routeStops.length > 0 && (
          <Card className="bg-card/50 lg:col-span-3 overflow-hidden">
            <div className="relative w-full h-[400px] lg:h-[500px]">
              <Map
                ref={mapRef}
                mapboxAccessToken={MAPBOX_TOKEN}
                initialViewState={{ longitude: 13.35, latitude: 43.55, zoom: 10 }}
                style={{ width: "100%", height: "100%" }}
                mapStyle="mapbox://styles/mapbox/dark-v11"
                attributionControl={false}
              >
                {/* Full route line (grey) */}
                {routeLineGeoJson && (
                  <Source id="route-line" type="geojson" data={routeLineGeoJson}>
                    <Layer
                      id="route-line-layer"
                      type="line"
                      paint={{ "line-color": "#6b7280", "line-width": 3, "line-opacity": 0.5, "line-dasharray": [2, 2] }}
                    />
                  </Source>
                )}

                {/* Highlighted segment (bright) */}
                {segmentGeoJson && (
                  <Source id="segment-line" type="geojson" data={segmentGeoJson}>
                    <Layer
                      id="segment-line-layer"
                      type="line"
                      paint={{ "line-color": "#10b981", "line-width": 5, "line-opacity": 0.9 }}
                    />
                  </Source>
                )}

                {/* All stops */}
                {stopsGeoJson && (
                  <Source id="stops-points" type="geojson" data={stopsGeoJson}>
                    {/* Default stops (small grey) */}
                    <Layer
                      id="stops-default"
                      type="circle"
                      filter={["all", ["!", ["get", "isFrom"]], ["!", ["get", "isTo"]], ["!", ["get", "isIntermediate"]]]}
                      paint={{
                        "circle-radius": 4,
                        "circle-color": "#6b7280",
                        "circle-stroke-width": 1,
                        "circle-stroke-color": "#374151",
                        "circle-opacity": 0.6,
                      }}
                    />
                    {/* Intermediate stops (teal) */}
                    <Layer
                      id="stops-intermediate"
                      type="circle"
                      filter={["all", ["get", "isIntermediate"], ["!", ["get", "isFrom"]], ["!", ["get", "isTo"]]]}
                      paint={{
                        "circle-radius": 5,
                        "circle-color": "#14b8a6",
                        "circle-stroke-width": 1.5,
                        "circle-stroke-color": "#fff",
                        "circle-opacity": 0.8,
                      }}
                    />
                  </Source>
                )}

                {/* Origin marker (green) */}
                {fromStop && routeStops.find(s => s.stopId === fromStop) && (() => {
                  const s = routeStops.find(s => s.stopId === fromStop)!;
                  return (
                    <Marker longitude={s.lon} latitude={s.lat} anchor="center">
                      <div className="relative">
                        <div className="w-6 h-6 rounded-full bg-emerald-500 border-2 border-white shadow-lg flex items-center justify-center">
                          <Navigation className="w-3 h-3 text-white" />
                        </div>
                        <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-emerald-600/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">
                          SALITA
                        </div>
                      </div>
                    </Marker>
                  );
                })()}

                {/* Destination marker (red) */}
                {toStop && routeStops.find(s => s.stopId === toStop) && (() => {
                  const s = routeStops.find(s => s.stopId === toStop)!;
                  return (
                    <Marker longitude={s.lon} latitude={s.lat} anchor="center">
                      <div className="relative">
                        <div className="w-6 h-6 rounded-full bg-rose-500 border-2 border-white shadow-lg flex items-center justify-center">
                          <MapPin className="w-3 h-3 text-white" />
                        </div>
                        <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 bg-rose-600/90 text-white text-[9px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">
                          DISCESA
                        </div>
                      </div>
                    </Marker>
                  );
                })()}
              </Map>

              {/* Map legend overlay */}
              <div className="absolute bottom-3 left-3 bg-black/60 backdrop-blur-sm text-white text-[10px] p-2 rounded-lg space-y-1">
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Salita</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Discesa</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-teal-500" /> Tratta</div>
                <div className="flex items-center gap-1.5"><span className="w-6 h-0.5 bg-gray-400 opacity-60" style={{ borderStyle: "dashed" }} /> Percorso</div>
              </div>
            </div>
          </Card>
        )}

        {/* Result card (takes 2/5 on lg, full width if no map) */}
        <div className={`space-y-4 ${selectedNetwork === "extraurbano" && selectedRoute && routeStops.length > 0 ? "lg:col-span-2" : "lg:col-span-5"}`}>
          <AnimatePresence>
            {result && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <Card className="bg-emerald-500/5 border-emerald-500/20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2 text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" />
                      Risultato Simulazione
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
                        {/* Route info */}
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Bus className="w-3.5 h-3.5" />
                          <span>Linea {result.routeId}</span>
                        </div>

                        {/* From → To */}
                        <div className="flex items-start gap-3">
                          <div className="flex flex-col items-center gap-1 pt-1">
                            <div className="w-3 h-3 rounded-full bg-emerald-500 border-2 border-emerald-300" />
                            <div className="w-0.5 h-8 bg-gradient-to-b from-emerald-500 to-rose-500 rounded" />
                            <div className="w-3 h-3 rounded-full bg-rose-500 border-2 border-rose-300" />
                          </div>
                          <div className="flex-1 space-y-2">
                            <div>
                              <p className="text-xs text-muted-foreground">Salita — km {result.fromStop?.km?.toFixed(1)}</p>
                              <p className="text-sm font-medium">{result.fromStop?.name}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground">Discesa — km {result.toStop?.km?.toFixed(1)}</p>
                              <p className="text-sm font-medium">{result.toStop?.name}</p>
                            </div>
                          </div>
                        </div>

                        {/* Stats row */}
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

                        {/* Price */}
                        <div className="flex items-center justify-between p-4 rounded-xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 to-emerald-500/5">
                          <div>
                            <p className="text-sm font-medium">Biglietto Corsa Semplice</p>
                            <p className="text-[10px] text-muted-foreground">
                              {result.intermediateStops?.length || 0} fermate nel percorso
                            </p>
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

          {/* Stop list for context when route is selected */}
          {selectedNetwork === "extraurbano" && selectedRoute && routeStops.length > 0 && !result && (
            <Card className="bg-card/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MapPin className="w-3.5 h-3.5 text-primary" />
                  Fermate della linea ({routeStops.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-[300px] overflow-auto space-y-0.5">
                  {routeStops.map((s, i) => (
                    <div
                      key={s.stopId}
                      className={`flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                        s.stopId === fromStop ? "bg-emerald-500/10 text-emerald-400" :
                        s.stopId === toStop ? "bg-rose-500/10 text-rose-400" :
                        "text-muted-foreground hover:bg-muted/20"
                      }`}
                    >
                      <span className="w-5 text-right font-mono text-[10px] opacity-50">{i + 1}</span>
                      <span className={`w-2 h-2 rounded-full ${
                        s.stopId === fromStop ? "bg-emerald-500" :
                        s.stopId === toStop ? "bg-rose-500" :
                        "bg-gray-500/40"
                      }`} />
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

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`
              relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap
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
          {tab === "zones" && <ZonesTab />}
          {tab === "generate" && <GenerateTab />}
          {tab === "simulate" && <SimulateTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
