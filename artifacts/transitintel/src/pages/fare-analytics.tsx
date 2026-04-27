import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import {
  BarChart3, TrendingUp, AlertTriangle, CheckCircle2, Download, Plus,
  Trash2, Edit3, Save, X, RefreshCw, FileText, Shield, Clock,
  Euro, Ticket, MapPin, Layers, Users, Calendar, Info,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface KpiData {
  coverage: {
    totalStops: number;
    coveredStops: number;
    coveragePercent: number;
    uncoveredCount: number;
    uncoveredStops: Array<{ stop_id: string; stop_name: string; stop_lat: number; stop_lon: number }>;
  };
  routes: { total: number; classified: number; classifiedPercent: number };
  productsByType: Array<{ fare_type: string; cnt: string; total_amount: string; min_price: string; max_price: string }>;
  productsByNetwork: Array<{ network_id: string; fare_type: string; cnt: string }>;
  legRulesByNetwork: Array<{ network_id: string; cnt: string }>;
  areasByNetwork: Array<{ network_id: string; cnt: string }>;
  avgPriceByNetwork: Array<{ network_id: string; avg_price: string; products: string }>;
  fasciaDistribution: Array<{ fare_product_id: string; amount: string; fare_product_name: string; od_pairs: string }>;
  recentAudit: AuditEntry[];
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

interface AuditEntry {
  id: string;
  feedId: string | null;
  action: string;
  description: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const FARE_TYPE_LABELS: Record<string, string> = {
  single: "Corsa semplice",
  return: "Andata/Ritorno",
  zone: "Zonale extraurbano",
  abbonamento_settimanale: "Abbonamento Settimanale",
  abbonamento_mensile: "Abbonamento Mensile",
  abbonamento_annuale: "Abbonamento Annuale",
};

const FARE_TYPE_COLORS: Record<string, string> = {
  single: "bg-blue-100 text-blue-800",
  return: "bg-purple-100 text-purple-800",
  zone: "bg-orange-100 text-orange-800",
  abbonamento_settimanale: "bg-green-100 text-green-800",
  abbonamento_mensile: "bg-emerald-100 text-emerald-800",
  abbonamento_annuale: "bg-teal-100 text-teal-800",
};

const NETWORK_LABELS: Record<string, string> = {
  urbano_ancona: "Urbano Ancona",
  urbano_jesi: "Urbano Jesi",
  urbano_falconara: "Urbano Falconara",
  extraurbano: "Extraurbano",
};

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  generate_gtfs:          { label: "Generazione GTFS", color: "bg-blue-100 text-blue-800" },
  export_zip:             { label: "Export ZIP",        color: "bg-violet-100 text-violet-800" },
  validate:               { label: "Validazione",       color: "bg-green-100 text-green-800" },
  update_product:         { label: "Modifica prodotto", color: "bg-yellow-100 text-yellow-800" },
  update_price:           { label: "Modifica prezzo",   color: "bg-amber-100 text-amber-800" },
  seed_products:          { label: "Seed prodotti",     color: "bg-sky-100 text-sky-800" },
  generate_zones:         { label: "Generazione zone",  color: "bg-orange-100 text-orange-800" },
  generate_leg_rules:     { label: "Generazione regole", color: "bg-red-100 text-red-800" },
  manual_note:            { label: "Nota manuale",      color: "bg-gray-100 text-gray-800" },
};

const TABS = [
  { id: "kpi",          label: "KPI Tariffario",        icon: BarChart3 },
  { id: "abbonamenti",  label: "Abbonamenti & Prodotti", icon: Ticket },
  { id: "audit",        label: "Audit & Export",         icon: Shield },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

export default function FareAnalyticsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("kpi");
  const { toast } = useToast();

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-7 h-7 text-primary" />
            Analisi Tariffaria
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            KPI di copertura · Gestione abbonamenti · Audit normativo · Export GTFS Fares V2
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "kpi" && <KpiTab toast={toast} />}
      {activeTab === "abbonamenti" && <AbbonamentiTab toast={toast} />}
      {activeTab === "audit" && <AuditTab toast={toast} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 1: KPI TARIFFARIO
// ═══════════════════════════════════════════════════════════

function KpiTab({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<KpiData>("/api/fares/kpi");
      setKpi(data);
    } catch (e: any) {
      toast({ title: "Errore KPI", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );

  if (!kpi) return (
    <div className="text-center py-16 text-muted-foreground">
      <AlertTriangle className="w-8 h-8 mx-auto mb-2" />
      <p>Nessun feed GTFS caricato. Carica prima un feed da Dati &amp; GTFS.</p>
    </div>
  );

  const coverageOk = kpi.coverage.coveragePercent >= 95;
  const routesOk = kpi.routes.classifiedPercent >= 100;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-muted-foreground">Panoramica</h2>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Aggiorna
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Copertura Fermate"
          value={`${kpi.coverage.coveragePercent.toFixed(1)}%`}
          sub={`${kpi.coverage.coveredStops} / ${kpi.coverage.totalStops} fermate`}
          ok={coverageOk}
          icon={MapPin}
        />
        <KpiCard
          label="Linee Classificate"
          value={`${kpi.routes.classifiedPercent.toFixed(1)}%`}
          sub={`${kpi.routes.classified} / ${kpi.routes.total} linee`}
          ok={routesOk}
          icon={Layers}
        />
        <KpiCard
          label="Prodotti Tariffari"
          value={String(kpi.productsByType.reduce((a, p) => a + Number(p.cnt), 0))}
          sub={`${kpi.productsByType.length} tipologie`}
          ok
          icon={Ticket}
        />
        <KpiCard
          label="Regole di Tratta"
          value={String(kpi.legRulesByNetwork.reduce((a, n) => a + Number(n.cnt), 0))}
          sub="leg rules totali"
          ok={kpi.legRulesByNetwork.length > 0}
          icon={TrendingUp}
        />
      </div>

      {/* Prodotti per tipo */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="w-4 h-4 text-primary" />
              Prodotti per Tipologia
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {kpi.productsByType.map((row) => (
                <div key={row.fare_type} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="flex items-center gap-2">
                    <Badge className={FARE_TYPE_COLORS[row.fare_type] ?? "bg-gray-100 text-gray-800"}>
                      {FARE_TYPE_LABELS[row.fare_type] ?? row.fare_type}
                    </Badge>
                    <span className="text-sm text-muted-foreground">{row.cnt} prodotti</span>
                  </div>
                  <div className="text-right text-sm">
                    <span className="font-medium">€{Number(row.min_price).toFixed(2)}</span>
                    {row.min_price !== row.max_price && (
                      <span className="text-muted-foreground"> – €{Number(row.max_price).toFixed(2)}</span>
                    )}
                  </div>
                </div>
              ))}
              {kpi.productsByType.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Nessun prodotto. Usa "Seed Prodotti" nella pagina Bigliettazione.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Euro className="w-4 h-4 text-primary" />
              Prezzo Medio per Rete
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {kpi.avgPriceByNetwork.map((row) => (
                <div key={row.network_id} className="flex items-center gap-3">
                  <div className="text-sm font-medium w-44 shrink-0">
                    {NETWORK_LABELS[row.network_id] ?? row.network_id}
                  </div>
                  <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full"
                      style={{ width: `${Math.min(100, (Number(row.avg_price) / 5) * 100)}%` }}
                    />
                  </div>
                  <div className="text-sm font-semibold w-14 text-right">
                    €{Number(row.avg_price).toFixed(2)}
                  </div>
                  <div className="text-xs text-muted-foreground w-16 text-right">
                    {row.products} prod.
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Distribuzione fasce extraurbane */}
      {kpi.fasciaDistribution.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              Distribuzione Fasce Km Extraurbano
              <span className="text-xs text-muted-foreground font-normal">(coppie O/D per fascia)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
              {kpi.fasciaDistribution.map((row) => {
                const maxPairs = Math.max(...kpi.fasciaDistribution.map((r) => Number(r.od_pairs)));
                return (
                  <div key={row.fare_product_id} className="flex items-center gap-2 text-xs">
                    <div className="w-8 text-right font-medium text-muted-foreground">
                      €{Number(row.amount).toFixed(2)}
                    </div>
                    <div className="flex-1 bg-muted rounded-full h-4 overflow-hidden relative">
                      <div
                        className="h-full bg-orange-400 rounded-full"
                        style={{ width: `${maxPairs > 0 ? (Number(row.od_pairs) / maxPairs) * 100 : 0}%` }}
                      />
                      <span className="absolute inset-0 flex items-center px-2 text-white font-medium text-[10px]">
                        {row.fare_product_name.replace("Extraurbano ", "")}
                      </span>
                    </div>
                    <div className="w-16 text-right font-semibold">{row.od_pairs} O/D</div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Fermate senza area */}
      {kpi.coverage.uncoveredCount > 0 && (
        <Card className="border-orange-200 bg-orange-50/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-orange-700">
              <AlertTriangle className="w-4 h-4" />
              Fermate senza Area Tariffaria ({kpi.coverage.uncoveredCount})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Queste fermate non hanno un'area assegnata. I passeggeri che salgono/scendono qui non avranno una tariffa calcolabile automaticamente.
              Usa "Generazione Zone" nella pagina Bigliettazione per assegnarle.
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 max-h-48 overflow-y-auto">
              {kpi.coverage.uncoveredStops.map((s) => (
                <div key={s.stop_id} className="text-xs bg-white border rounded px-2 py-1">
                  <div className="font-medium truncate">{s.stop_name}</div>
                  <div className="text-muted-foreground font-mono">{s.stop_id}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KpiCard({
  label, value, sub, ok, icon: Icon,
}: { label: string; value: string; sub: string; ok: boolean; icon: React.ElementType }) {
  return (
    <Card className={ok ? "" : "border-orange-200 bg-orange-50/20"}>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{sub}</p>
          </div>
          <div className={`p-2 rounded-lg ${ok ? "bg-primary/10" : "bg-orange-100"}`}>
            <Icon className={`w-5 h-5 ${ok ? "text-primary" : "text-orange-600"}`} />
          </div>
        </div>
        <div className={`mt-3 h-1 rounded-full ${ok ? "bg-green-500" : "bg-orange-400"}`} />
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 2: ABBONAMENTI & PRODOTTI
// ═══════════════════════════════════════════════════════════

function AbbonamentiTab({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [products, setProducts] = useState<FareProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [seedingAbb, setSeedingAbb] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editName, setEditName] = useState("");
  const [filterType, setFilterType] = useState<string>("all");

  // New product form state
  const [newProduct, setNewProduct] = useState({
    fareProductId: "",
    fareProductName: "",
    networkId: "extraurbano",
    amount: "",
    durationMinutes: "",
    fareType: "abbonamento_mensile",
    riderCategoryId: "ordinario",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<FareProduct[]>("/api/fares/products");
      setProducts(rows);
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function seedAbbonamenti() {
    setSeedingAbb(true);
    try {
      const res = await apiFetch<{ inserted: number; total: number }>("/api/fares/products/seed-abbonamenti", { method: "POST" });
      toast({ title: "Abbonamenti creati", description: `${res.inserted} nuovi prodotti inseriti (${res.total} abbonamenti totali)` });
      await load();
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally { setSeedingAbb(false); }
  }

  async function saveEdit(id: string) {
    try {
      await apiFetch(`/api/fares/products/${id}`, {
        method: "PUT",
        body: JSON.stringify({ amount: parseFloat(editAmount), fareProductName: editName }),
      });
      setEditingId(null);
      await load();
      toast({ title: "Prodotto aggiornato" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  }

  async function deleteProduct(id: string, name: string) {
    if (!confirm(`Eliminare il prodotto "${name}"?`)) return;
    try {
      await apiFetch(`/api/fares/products/${id}`, { method: "DELETE" });
      await load();
      toast({ title: "Prodotto eliminato" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  }

  async function createProduct() {
    if (!newProduct.fareProductId || !newProduct.fareProductName || !newProduct.amount) {
      toast({ title: "Compila tutti i campi obbligatori", variant: "destructive" }); return;
    }
    try {
      await apiFetch("/api/fares/products", {
        method: "POST",
        body: JSON.stringify({
          ...newProduct,
          amount: parseFloat(newProduct.amount),
          durationMinutes: newProduct.durationMinutes ? parseInt(newProduct.durationMinutes) : null,
        }),
      });
      setShowForm(false);
      setNewProduct({ fareProductId: "", fareProductName: "", networkId: "extraurbano", amount: "", durationMinutes: "", fareType: "abbonamento_mensile", riderCategoryId: "ordinario" });
      await load();
      toast({ title: "Prodotto creato" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
  }

  const allTypes = ["all", ...Array.from(new Set(products.map((p) => p.fareType)))];
  const filtered = filterType === "all" ? products : products.filter((p) => p.fareType === filterType);
  const abbonamenti = filtered.filter((p) => p.fareType.startsWith("abbonamento"));
  const altri = filtered.filter((p) => !p.fareType.startsWith("abbonamento"));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {allTypes.map((t) => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === t ? "bg-primary text-primary-foreground border-primary" : "bg-transparent border-border text-muted-foreground hover:border-primary"}`}
            >
              {t === "all" ? "Tutti" : (FARE_TYPE_LABELS[t] ?? t)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
            Aggiorna
          </Button>
          <Button variant="outline" size="sm" onClick={seedAbbonamenti} disabled={seedingAbb}>
            {seedingAbb ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Ticket className="w-4 h-4 mr-2" />}
            Seed Abbonamenti
          </Button>
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            <Plus className="w-4 h-4 mr-2" />
            Nuovo Prodotto
          </Button>
        </div>
      </div>

      {/* New product form */}
      {showForm && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Nuovo Prodotto Tariffario</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium">ID Prodotto *</label>
                  <input
                    className="w-full border rounded px-3 py-2 text-sm font-mono bg-background"
                    placeholder="es. extra_mens_fascia_11"
                    value={newProduct.fareProductId}
                    onChange={(e) => setNewProduct((p) => ({ ...p, fareProductId: e.target.value }))}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2 lg:col-span-1">
                  <label className="text-xs font-medium">Nome *</label>
                  <input
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    placeholder="es. Abbonamento Extraurbano Mensile Fascia 11"
                    value={newProduct.fareProductName}
                    onChange={(e) => setNewProduct((p) => ({ ...p, fareProductName: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Tipologia *</label>
                  <select
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    value={newProduct.fareType}
                    onChange={(e) => setNewProduct((p) => ({ ...p, fareType: e.target.value }))}
                  >
                    {Object.entries(FARE_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Rete</label>
                  <select
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    value={newProduct.networkId}
                    onChange={(e) => setNewProduct((p) => ({ ...p, networkId: e.target.value }))}
                  >
                    {Object.entries(NETWORK_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Categoria Passeggero</label>
                  <select
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    value={newProduct.riderCategoryId}
                    onChange={(e) => setNewProduct((p) => ({ ...p, riderCategoryId: e.target.value }))}
                  >
                    <option value="ordinario">Ordinario</option>
                    <option value="studente">Studente</option>
                    <option value="anziano">Anziano/Senior</option>
                    <option value="disabile">Disabile</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Prezzo (€) *</label>
                  <input
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    type="number" step="0.01" min="0" placeholder="es. 37.00"
                    value={newProduct.amount}
                    onChange={(e) => setNewProduct((p) => ({ ...p, amount: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Durata (minuti)</label>
                  <input
                    className="w-full border rounded px-3 py-2 text-sm bg-background"
                    type="number" min="0" placeholder="es. 43200 per 30 gg"
                    value={newProduct.durationMinutes}
                    onChange={(e) => setNewProduct((p) => ({ ...p, durationMinutes: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex gap-2 mt-4">
                <Button size="sm" onClick={createProduct}>
                  <Save className="w-4 h-4 mr-2" />
                  Crea Prodotto
                </Button>
                <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                  <X className="w-4 h-4 mr-2" />
                  Annulla
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Abbonamenti section */}
      {(filterType === "all" || filterType.startsWith("abbonamento")) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="w-4 h-4 text-emerald-600" />
              Abbonamenti
              <Badge className="bg-emerald-100 text-emerald-800">{abbonamenti.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {abbonamenti.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Nessun abbonamento. Usa "Seed Abbonamenti" per generarli automaticamente.</p>
              </div>
            ) : (
              <ProductTable
                products={abbonamenti}
                editingId={editingId}
                editAmount={editAmount}
                editName={editName}
                onStartEdit={(p) => { setEditingId(p.id); setEditAmount(String(p.amount)); setEditName(p.fareProductName); }}
                onSaveEdit={saveEdit}
                onCancelEdit={() => setEditingId(null)}
                onAmountChange={setEditAmount}
                onNameChange={setEditName}
                onDelete={deleteProduct}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Altri prodotti */}
      {(filterType === "all" || !filterType.startsWith("abbonamento")) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="w-4 h-4 text-primary" />
              Biglietti e Titoli di Viaggio
              <Badge variant="outline">{altri.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {altri.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Nessun prodotto. Usa "Seed Prodotti" nella pagina Bigliettazione.</p>
            ) : (
              <ProductTable
                products={altri}
                editingId={editingId}
                editAmount={editAmount}
                editName={editName}
                onStartEdit={(p) => { setEditingId(p.id); setEditAmount(String(p.amount)); setEditName(p.fareProductName); }}
                onSaveEdit={saveEdit}
                onCancelEdit={() => setEditingId(null)}
                onAmountChange={setEditAmount}
                onNameChange={setEditName}
                onDelete={deleteProduct}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ProductTable({
  products, editingId, editAmount, editName, onStartEdit, onSaveEdit, onCancelEdit, onAmountChange, onNameChange, onDelete,
}: {
  products: FareProduct[];
  editingId: string | null;
  editAmount: string;
  editName: string;
  onStartEdit: (p: FareProduct) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onAmountChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-muted-foreground text-xs">
            <th className="text-left pb-2 pr-3 font-medium">ID</th>
            <th className="text-left pb-2 pr-3 font-medium">Nome</th>
            <th className="text-left pb-2 pr-3 font-medium">Rete</th>
            <th className="text-left pb-2 pr-3 font-medium">Tipologia</th>
            <th className="text-left pb-2 pr-3 font-medium">Passeggero</th>
            <th className="text-right pb-2 pr-3 font-medium">Prezzo</th>
            <th className="text-right pb-2 font-medium">Azioni</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
              <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{p.fareProductId}</td>
              <td className="py-2 pr-3">
                {editingId === p.id ? (
                  <input
                    className="border rounded px-2 py-1 text-xs w-full min-w-40"
                    value={editName}
                    onChange={(e) => onNameChange(e.target.value)}
                  />
                ) : (
                  <span className="font-medium">{p.fareProductName}</span>
                )}
              </td>
              <td className="py-2 pr-3 text-xs text-muted-foreground">
                {NETWORK_LABELS[p.networkId ?? ""] ?? p.networkId ?? "—"}
              </td>
              <td className="py-2 pr-3">
                <Badge className={`text-xs ${FARE_TYPE_COLORS[p.fareType] ?? "bg-gray-100 text-gray-700"}`}>
                  {FARE_TYPE_LABELS[p.fareType] ?? p.fareType}
                </Badge>
              </td>
              <td className="py-2 pr-3 text-xs capitalize text-muted-foreground">{p.riderCategoryId ?? "—"}</td>
              <td className="py-2 pr-3 text-right">
                {editingId === p.id ? (
                  <input
                    className="border rounded px-2 py-1 text-xs w-20 text-right"
                    type="number" step="0.01" min="0"
                    value={editAmount}
                    onChange={(e) => onAmountChange(e.target.value)}
                  />
                ) : (
                  <span className="font-semibold">€{p.amount.toFixed(2)}</span>
                )}
              </td>
              <td className="py-2 text-right">
                <div className="flex items-center justify-end gap-1">
                  {editingId === p.id ? (
                    <>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-green-600" onClick={() => onSaveEdit(p.id)}>
                        <Save className="w-3 h-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCancelEdit}>
                        <X className="w-3 h-3" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onStartEdit(p)}>
                        <Edit3 className="w-3 h-3" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => onDelete(p.id, p.fareProductName)}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TAB 3: AUDIT & EXPORT
// ═══════════════════════════════════════════════════════════

function AuditTab({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteActor, setNoteActor] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [filterAction, setFilterAction] = useState("all");

  const loadAudit = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<AuditEntry[]>("/api/fares/audit");
      setAuditLog(rows);
    } catch (e: any) {
      toast({ title: "Errore audit", description: e.message, variant: "destructive" });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadAudit(); }, [loadAudit]);

  async function downloadZip() {
    setDownloading(true);
    try {
      const res = await fetch("/api/fares/export-fares-zip");
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Errore download" }));
        throw new Error(err.error ?? "Errore download");
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const match = cd.match(/filename="(.+)"/);
      const filename = match?.[1] ?? `gtfs_fares_v2_${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Download completato", description: filename });
      setTimeout(loadAudit, 1000); // ricarica audit dopo download
    } catch (e: any) {
      toast({ title: "Errore download", description: e.message, variant: "destructive" });
    } finally { setDownloading(false); }
  }

  async function addNote() {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await apiFetch("/api/fares/audit", {
        method: "POST",
        body: JSON.stringify({ description: noteText, actor: noteActor || undefined }),
      });
      setNoteText("");
      await loadAudit();
      toast({ title: "Nota aggiunta" });
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    } finally { setSavingNote(false); }
  }

  const allActions = ["all", ...Array.from(new Set(auditLog.map((e) => e.action)))];
  const filtered = filterAction === "all" ? auditLog : auditLog.filter((e) => e.action === filterAction);

  return (
    <div className="space-y-6">
      {/* Export card */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Download className="w-4 h-4 text-primary" />
            Export GTFS Fares V2
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Scarica tutti i file GTFS Fares V2 in un unico archivio ZIP, pronto per essere integrato
            in un feed GTFS completo o consegnato all'Autorità di Trasporto.
            <br />
            <span className="text-xs mt-1 block">
              Include: <code className="bg-muted px-1 rounded">fare_products.txt</code>,&nbsp;
              <code className="bg-muted px-1 rounded">fare_leg_rules.txt</code>,&nbsp;
              <code className="bg-muted px-1 rounded">areas.txt</code>,&nbsp;
              <code className="bg-muted px-1 rounded">stop_areas.txt</code>,&nbsp;
              <code className="bg-muted px-1 rounded">networks.txt</code> e altri.
            </span>
          </p>
          <Button onClick={downloadZip} disabled={downloading} className="gap-2">
            {downloading
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Download in corso…</>
              : <><Download className="w-4 h-4" /> Scarica ZIP GTFS Fares V2</>
            }
          </Button>
        </CardContent>
      </Card>

      {/* Add note card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            Aggiungi Nota Normativa
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Registra verbalmente modifiche tariffarie, approvazioni DGR, o annotazioni di audit da conservare nel registro.
          </p>
          <div className="flex gap-2 flex-col sm:flex-row">
            <input
              className="flex-1 border rounded px-3 py-2 text-sm bg-background"
              placeholder="Es. Tariffe approvate con delibera n. XXX del 16/04/2026 — DGR Marche"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) addNote(); }}
            />
            <input
              className="w-36 border rounded px-3 py-2 text-sm bg-background"
              placeholder="Autore (opz.)"
              value={noteActor}
              onChange={(e) => setNoteActor(e.target.value)}
            />
            <Button size="sm" onClick={addNote} disabled={savingNote || !noteText.trim()}>
              {savingNote ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Salva Nota
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Audit log */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Registro Audit
              <Badge variant="outline">{filtered.length} voci</Badge>
            </CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {allActions.map((a) => {
                const meta = ACTION_LABELS[a];
                return (
                  <button
                    key={a}
                    onClick={() => setFilterAction(a)}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${filterAction === a ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-primary"}`}
                  >
                    {a === "all" ? "Tutti" : (meta?.label ?? a)}
                  </button>
                );
              })}
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadAudit}>
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <Shield className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Nessuna voce nel registro. Le azioni (generazione GTFS, modifiche prezzi, export ZIP) vengono registrate automaticamente.</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
              {filtered.map((entry) => {
                const meta = ACTION_LABELS[entry.action];
                return (
                  <div key={entry.id} className="flex gap-3 py-2 border-b last:border-0">
                    <div className="flex flex-col items-center">
                      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${meta ? "bg-primary" : "bg-gray-300"}`} />
                      <div className="flex-1 w-px bg-border mt-1" />
                    </div>
                    <div className="flex-1 min-w-0 pb-1">
                      <div className="flex items-start gap-2 flex-wrap">
                        <Badge className={`text-xs ${meta?.color ?? "bg-gray-100 text-gray-700"}`}>
                          {meta?.label ?? entry.action}
                        </Badge>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="w-3 h-3" />
                          {entry.actor}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1 ml-auto">
                          <Clock className="w-3 h-3" />
                          {new Date(entry.createdAt).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p className="text-sm mt-1">{entry.description}</p>
                      {entry.metadata && Object.keys(entry.metadata).length > 0 && (
                        <details className="mt-1">
                          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                            <Info className="w-3 h-3 inline mr-1" />
                            Dettagli tecnici
                          </summary>
                          <pre className="text-xs bg-muted rounded p-2 mt-1 overflow-x-auto">
                            {JSON.stringify(entry.metadata, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
