import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  MapPin, Download, Loader2, Search, Filter, Bus, ArrowRightLeft,
  CheckCircle2, BarChart3, FileText, Info,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface ClassifiedStop {
  stopId: string;
  stopCode: string | null;
  stopName: string;
  stopLat: number;
  stopLon: number;
  wheelchairBoarding: number | null;
  classification: number; // 0=Urbana, 1=Extraurbana, 2=Mista
  classLabel: string;
  routeCount: number;
  urbanRoutes: number;
  extraRoutes: number;
}

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const CLASS_CONFIG: Record<number, { label: string; color: string; bg: string; border: string; icon: React.ReactNode }> = {
  0: { label: "Urbana", color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500/30", icon: <Bus className="w-3.5 h-3.5" /> },
  1: { label: "Extraurbana", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  2: { label: "Mista", color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500/30", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
};

// ═══════════════════════════════════════════════════════════
// PAGE COMPONENT
// ═══════════════════════════════════════════════════════════

export default function StopsClassificationPage() {
  const { toast } = useToast();
  const [stops, setStops] = useState<ClassifiedStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterClass, setFilterClass] = useState<number | "all">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ClassifiedStop[]>("/api/fares/stops-classification");
      setStops(data);
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let result = stops;
    if (filterClass !== "all") {
      result = result.filter(s => s.classification === filterClass);
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      result = result.filter(s =>
        s.stopName.toLowerCase().includes(q) ||
        s.stopId.toLowerCase().includes(q) ||
        (s.stopCode && s.stopCode.toLowerCase().includes(q))
      );
    }
    return result;
  }, [stops, filterClass, searchTerm]);

  // Stats
  const stats = useMemo(() => {
    const urban = stops.filter(s => s.classification === 0).length;
    const extra = stops.filter(s => s.classification === 1).length;
    const mixed = stops.filter(s => s.classification === 2).length;
    return { total: stops.length, urban, extra, mixed };
  }, [stops]);

  const exportTxt = async () => {
    setExporting(true);
    try {
      const response = await fetch("/api/fares/stops-classification/export");
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "stops.txt";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Esportazione completata", description: "File stops.txt scaricato" });
    } catch (e: any) {
      toast({ title: "Errore esportazione", description: e.message, variant: "destructive" });
    }
    setExporting(false);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <MapPin className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Classificazione Fermate</h1>
            <p className="text-sm text-muted-foreground">
              Classifica ogni fermata come Urbana (0), Extraurbana (1) o Mista (2) in base alle linee servite
            </p>
          </div>
        </div>
        <Button onClick={exportTxt} disabled={exporting || stops.length === 0} className="gap-2">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Esporta stops.txt
        </Button>
      </motion.div>

      {/* Info card */}
      <Card className="bg-blue-500/5 border-blue-500/20">
        <CardContent className="p-4">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
            <div className="text-sm space-y-1">
              <p className="font-semibold text-blue-600">Come funziona la classificazione?</p>
              <p className="text-muted-foreground">
                Per ogni fermata si analizzano le <strong>linee che vi transitano</strong> (tramite stop_times → trips → routes).
                Incrociando con la <strong>classificazione delle linee</strong> (tab "Classificazione Linee" nella Bigliettazione):
              </p>
              <div className="flex flex-wrap gap-3 mt-2">
                <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 gap-1">
                  <Bus className="w-3 h-3" /> 0 = Urbana
                </Badge>
                <span className="text-xs text-muted-foreground self-center">Solo linee urbane</span>
                <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/30 gap-1">
                  <ArrowRightLeft className="w-3 h-3" /> 1 = Extraurbana
                </Badge>
                <span className="text-xs text-muted-foreground self-center">Solo linee extraurbane</span>
                <Badge className="bg-purple-500/10 text-purple-400 border-purple-500/30 gap-1">
                  <CheckCircle2 className="w-3 h-3" /> 2 = Mista
                </Badge>
                <span className="text-xs text-muted-foreground self-center">Entrambi i tipi</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Il file <strong>stops.txt</strong> esportato contiene tutte le colonne standard GTFS più il campo
                aggiuntivo <code className="text-[10px] bg-muted/30 px-1 rounded">stop_classification</code>.
                È un file standalone che <strong>non altera</strong> il GTFS completo.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      {!loading && stops.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="bg-card/50">
            <CardContent className="p-4 text-center">
              <BarChart3 className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
              <p className="text-2xl font-bold">{stats.total}</p>
              <p className="text-xs text-muted-foreground">Fermate totali</p>
            </CardContent>
          </Card>
          <Card className={`${CLASS_CONFIG[0].bg} ${CLASS_CONFIG[0].border} border`}>
            <CardContent className="p-4 text-center">
              <Bus className={`w-5 h-5 ${CLASS_CONFIG[0].color} mx-auto mb-1`} />
              <p className="text-2xl font-bold">{stats.urban}</p>
              <p className="text-xs text-muted-foreground">Urbane (0)</p>
            </CardContent>
          </Card>
          <Card className={`${CLASS_CONFIG[1].bg} ${CLASS_CONFIG[1].border} border`}>
            <CardContent className="p-4 text-center">
              <ArrowRightLeft className={`w-5 h-5 ${CLASS_CONFIG[1].color} mx-auto mb-1`} />
              <p className="text-2xl font-bold">{stats.extra}</p>
              <p className="text-xs text-muted-foreground">Extraurbane (1)</p>
            </CardContent>
          </Card>
          <Card className={`${CLASS_CONFIG[2].bg} ${CLASS_CONFIG[2].border} border`}>
            <CardContent className="p-4 text-center">
              <CheckCircle2 className={`w-5 h-5 ${CLASS_CONFIG[2].color} mx-auto mb-1`} />
              <p className="text-2xl font-bold">{stats.mixed}</p>
              <p className="text-xs text-muted-foreground">Miste (2)</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border border-border bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            placeholder="Cerca per nome, ID o codice fermata..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-muted/30 border border-border/30">
          <button
            onClick={() => setFilterClass("all")}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              filterClass === "all" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Tutte ({stats.total})
          </button>
          {[0, 1, 2].map(c => (
            <button
              key={c}
              onClick={() => setFilterClass(c)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors gap-1 flex items-center ${
                filterClass === c ? `${CLASS_CONFIG[c].bg} ${CLASS_CONFIG[c].color} shadow-sm` : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {CLASS_CONFIG[c].icon}
              {CLASS_CONFIG[c].label} ({c === 0 ? stats.urban : c === 1 ? stats.extra : stats.mixed})
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <Card className="bg-card/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" />
              Fermate classificate
              {filtered.length !== stops.length && (
                <Badge variant="outline" className="text-[10px] ml-2">
                  {filtered.length} / {stops.length}
                </Badge>
              )}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Caricamento classificazione...</span>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {stops.length === 0
                ? "Nessuna fermata trovata. Assicurati di aver caricato un feed GTFS e classificato le linee."
                : "Nessun risultato per i filtri applicati."
              }
            </p>
          ) : (
            <div className="overflow-auto max-h-[600px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border/30">
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground">stop_id</th>
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground">stop_code</th>
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground">stop_name</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Linee</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Urbane</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Extra</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">stop_classification</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const cfg = CLASS_CONFIG[s.classification] || CLASS_CONFIG[0];
                    return (
                      <tr key={s.stopId} className="border-b border-border/10 hover:bg-muted/10">
                        <td className="py-1.5 px-2 font-mono text-xs text-muted-foreground">{s.stopId}</td>
                        <td className="py-1.5 px-2 font-mono text-xs text-muted-foreground">{s.stopCode || "—"}</td>
                        <td className="py-1.5 px-2 font-medium">{s.stopName}</td>
                        <td className="py-1.5 px-2 text-center text-xs">{s.routeCount}</td>
                        <td className="py-1.5 px-2 text-center text-xs text-blue-400">{s.urbanRoutes}</td>
                        <td className="py-1.5 px-2 text-center text-xs text-amber-400">{s.extraRoutes}</td>
                        <td className="py-1.5 px-2 text-center">
                          <Badge className={`${cfg.bg} ${cfg.color} ${cfg.border} border gap-1 text-[10px]`}>
                            {cfg.icon}
                            {s.classification} — {cfg.label}
                          </Badge>
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
  );
}
