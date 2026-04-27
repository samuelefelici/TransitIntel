import React, { useState, useEffect, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  MapPin, Download, Loader2, Search, Bus, ArrowRightLeft, Route,
  AlertCircle, BarChart3, FileText, Info, Minus,
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
  classification: number;       // 0, 1, 10-15, 20-25, 99
  classLabel: string;
  classShortCode: string;
  networks: string[];
  routeCount: number;
  urbanRoutes: number;
  extraRoutes: number;
}

type ClassKind = "none" | "extra" | "urban" | "mixed" | "other";

interface ClassDef {
  code: number;
  label: string;
  shortCode: string;
  kind: ClassKind;
  color: string;
  bg: string;
  border: string;
  icon: React.ReactNode;
}

// ═══════════════════════════════════════════════════════════
// CLASSIFICATION CATALOG
// Enumeration di tutti i 14 codici previsti, ordinati per gruppo.
// ═══════════════════════════════════════════════════════════

const CLASS_CATALOG: ClassDef[] = [
  { code: 0,  label: "Non servita",                            shortCode: "NONE",      kind: "none",  color: "text-slate-400",  bg: "bg-slate-500/10",  border: "border-slate-500/30",  icon: <Minus className="w-3.5 h-3.5" /> },
  { code: 1,  label: "Extraurbano",                            shortCode: "EXTRA",     kind: "extra", color: "text-amber-400",  bg: "bg-amber-500/10",  border: "border-amber-500/30",  icon: <Route className="w-3.5 h-3.5" /> },
  // Urbani puri
  { code: 2, label: "Urbano Ancona",                          shortCode: "URB_AN",    kind: "urban", color: "text-blue-400",   bg: "bg-blue-500/10",   border: "border-blue-500/30",   icon: <Bus className="w-3.5 h-3.5" /> },
  { code: 3, label: "Urbano Jesi",                            shortCode: "URB_JE",    kind: "urban", color: "text-emerald-400",bg: "bg-emerald-500/10",border: "border-emerald-500/30",icon: <Bus className="w-3.5 h-3.5" /> },
  { code: 4, label: "Urbano Falconara",                       shortCode: "URB_FA",    kind: "urban", color: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/30", icon: <Bus className="w-3.5 h-3.5" /> },
  { code: 5, label: "Urbano Senigallia",                      shortCode: "URB_SE",    kind: "urban", color: "text-cyan-400",   bg: "bg-cyan-500/10",   border: "border-cyan-500/30",   icon: <Bus className="w-3.5 h-3.5" /> },
  { code: 6, label: "Urbano Castelfidardo",                   shortCode: "URB_CF",    kind: "urban", color: "text-pink-400",   bg: "bg-pink-500/10",   border: "border-pink-500/30",   icon: <Bus className="w-3.5 h-3.5" /> },
  { code: 7, label: "Urbano Sassoferrato",                    shortCode: "URB_SS",    kind: "urban", color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/30", icon: <Bus className="w-3.5 h-3.5" /> },
  // Misti
  { code: 12, label: "Mista Extraurbano + Urbano Ancona",      shortCode: "MIX_EX_AN", kind: "mixed", color: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/30", icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  { code: 13, label: "Mista Extraurbano + Urbano Jesi",        shortCode: "MIX_EX_JE", kind: "mixed", color: "text-teal-400",   bg: "bg-teal-500/10",   border: "border-teal-500/30",   icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  { code: 14, label: "Mista Extraurbano + Urbano Falconara",   shortCode: "MIX_EX_FA", kind: "mixed", color: "text-fuchsia-400",bg: "bg-fuchsia-500/10",border: "border-fuchsia-500/30",icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  { code: 15, label: "Mista Extraurbano + Urbano Senigallia",  shortCode: "MIX_EX_SE", kind: "mixed", color: "text-sky-400",    bg: "bg-sky-500/10",    border: "border-sky-500/30",    icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  { code: 16, label: "Mista Extraurbano + Urbano Castelfidardo", shortCode: "MIX_EX_CF", kind: "mixed", color: "text-rose-400", bg: "bg-rose-500/10",   border: "border-rose-500/30",   icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  { code: 17, label: "Mista Extraurbano + Urbano Sassoferrato",shortCode: "MIX_EX_SS", kind: "mixed", color: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/30", icon: <ArrowRightLeft className="w-3.5 h-3.5" /> },
  // Fallback
  { code: 99, label: "Multi-rete non prevista",                shortCode: "OTHER",     kind: "other", color: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/30",    icon: <AlertCircle className="w-3.5 h-3.5" /> },
];

const CLASS_BY_CODE: Record<number, ClassDef> =
  Object.fromEntries(CLASS_CATALOG.map(c => [c.code, c]));

const FALLBACK_DEF: ClassDef = CLASS_CATALOG[CLASS_CATALOG.length - 1]; // OTHER

// Abbreviazione per network_id → etichetta short per la colonna "Reti"
const NETWORK_SHORT: Record<string, string> = {
  extraurbano:          "Extra",
  urbano_ancona:        "AN",
  urbano_jesi:          "JE",
  urbano_falconara:     "FA",
  urbano_senigallia:    "SE",
  urbano_castelfidardo: "CF",
  urbano_sassoferrato:  "SS",
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
  const [filterCode, setFilterCode] = useState<number | "all">("all");
  const [filterKind, setFilterKind] = useState<ClassKind | "all">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<ClassifiedStop[]>("/api/fares/stops-classification");
      setStops(data);
    } catch (e: any) {
      toast({ title: "Errore", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // ─────────────────────────────────────────────────────────
  // Statistiche aggregate per codice
  // ─────────────────────────────────────────────────────────
  const { total, byCode, presentCodes, byKind } = useMemo(() => {
    const byCode = new Map<number, number>();
    for (const s of stops) byCode.set(s.classification, (byCode.get(s.classification) ?? 0) + 1);

    const presentCodes = CLASS_CATALOG
      .filter(c => (byCode.get(c.code) ?? 0) > 0)
      .sort((a, b) => a.code - b.code);

    const byKind = { none: 0, extra: 0, urban: 0, mixed: 0, other: 0 } as Record<ClassKind, number>;
    for (const [code, cnt] of byCode) {
      const def = CLASS_BY_CODE[code] ?? FALLBACK_DEF;
      byKind[def.kind] += cnt;
    }

    return { total: stops.length, byCode, presentCodes, byKind };
  }, [stops]);

  // ─────────────────────────────────────────────────────────
  // Filtro applicato
  // ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let result = stops;

    if (filterCode !== "all") {
      result = result.filter(s => s.classification === filterCode);
    } else if (filterKind !== "all") {
      result = result.filter(s => (CLASS_BY_CODE[s.classification] ?? FALLBACK_DEF).kind === filterKind);
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
  }, [stops, filterCode, filterKind, searchTerm]);

  // ─────────────────────────────────────────────────────────
  // Export
  // ─────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────
  // Render helpers
  // ─────────────────────────────────────────────────────────
  const setFilterAll = () => { setFilterCode("all"); setFilterKind("all"); };
  const setFilterByKind = (kind: ClassKind) => { setFilterKind(kind); setFilterCode("all"); };
  const setFilterByCode = (code: number) => { setFilterCode(code); setFilterKind("all"); };

  const renderStatCard = (def: ClassDef, count: number) => (
    <Card key={def.code} className={`${def.bg} ${def.border} border transition-all cursor-pointer hover:scale-[1.02]`}
      onClick={() => setFilterByCode(def.code)}
    >
      <CardContent className="p-3 text-center">
        <div className={`w-5 h-5 ${def.color} mx-auto mb-1`}>{def.icon}</div>
        <p className="text-xl font-bold">{count}</p>
        <p className="text-[11px] text-muted-foreground leading-tight">{def.label}</p>
        <p className={`text-[10px] font-mono ${def.color} mt-0.5`}>{def.code}</p>
      </CardContent>
    </Card>
  );

  // ─────────────────────────────────────────────────────────

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
              Ogni fermata riceve un codice in base alle reti tariffarie che la servono. Di seguito tutte le possibili combinazioni e il loro significato.
            </p>
          </div>
        </div>
        <Button onClick={exportTxt} disabled={exporting || stops.length === 0} className="gap-2">
          {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Esporta stops.txt
        </Button>
      </motion.div>

      {/* Tabella dettagliata schema classificazione */}
      <Card className="border-blue-500/30">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="w-4 h-4 text-blue-500" />
            Schema completo di classificazione
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-4 pt-0">
          <table className="w-full text-xs border-separate border-spacing-y-1">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 px-2">Badge</th>
                <th className="py-1 px-2">Codice</th>
                <th className="py-1 px-2">Label</th>
                <th className="py-1 px-2">Descrizione</th>
              </tr>
            </thead>
            <tbody>
              {CLASS_CATALOG.map(def => (
                <tr key={def.code} className="align-top">
                  <td className="py-1 px-2">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${def.bg} ${def.color} ${def.border}`}>{def.icon} {def.shortCode}</span>
                  </td>
                  <td className="py-1 px-2 font-mono text-[13px]">{def.code}</td>
                  <td className="py-1 px-2 font-semibold">{def.label}</td>
                  <td className="py-1 px-2">
                    {(() => {
                      if (def.code === 0) return "Nessuna linea serve la fermata.";
                      if (def.code === 1) return "Solo linee extraurbane.";
                      if (def.code === 2) return "Urbano Ancona";
                      if (def.code === 3) return "Urbano Jesi";
                      if (def.code === 4) return "Urbano Falconara";
                      if (def.code === 5) return "Urbano Senigallia";
                      if (def.code === 6) return "Urbano Castelfidardo";
                      if (def.code === 7) return "Urbano Sassoferrato";
                      if (def.code === 12) return "Linee extraurbane + Urbano Ancona";
                      if (def.code === 13) return "Linee extraurbane + Urbano Jesi";
                      if (def.code === 14) return "Linee extraurbane + Urbano Falconara";
                      if (def.code === 15) return "Linee extraurbane + Urbano Senigallia";
                      if (def.code === 16) return "Linee extraurbane + Urbano Castelfidardo";
                      if (def.code === 17) return "Linee extraurbane + Urbano Sassoferrato";
                      if (def.code === 99) return "Fermata servita da più reti urbane contemporaneamente o da reti non previste.";
                      return "";
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-xs text-muted-foreground mt-2">
            Il file <b>stops.txt</b> esportato contiene tutte le colonne standard GTFS più <code className="text-[10px] bg-muted/30 px-1 rounded">stop_classification</code> (numerica) e <code className="text-[10px] bg-muted/30 px-1 rounded">stop_classification_label</code> (testuale).
          </div>
        </CardContent>
      </Card>

      {/* Info card */}
      <Card className="bg-blue-500/5 border-blue-500/20">
        <CardContent className="p-4">
          <div className="flex gap-3">
            <Info className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
            <div className="text-sm space-y-2">
              <p className="font-semibold text-blue-600">Schema di classificazione</p>
              <p className="text-muted-foreground">
                Per ogni fermata si analizzano le linee servite (<code className="text-[10px] bg-muted/30 px-1 rounded">stop_times → trips → route_networks</code>) e si determina l'insieme delle reti tariffarie raggiunte. Il codice assegnato segue questo schema:
              </p>
              <p className="text-xs text-muted-foreground">
                Il file <strong>stops.txt</strong> esportato contiene le colonne standard GTFS più{" "}
                <code className="text-[10px] bg-muted/30 px-1 rounded">stop_classification</code> (numerica) e{" "}
                <code className="text-[10px] bg-muted/30 px-1 rounded">stop_classification_label</code> (testuale).
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats: totale + macrogruppi + griglia per-codice */}
      {!loading && stops.length > 0 && (
        <>
          {/* Macrogruppi */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Card className="bg-card/50 cursor-pointer hover:scale-[1.02] transition-all" onClick={setFilterAll}>
              <CardContent className="p-3 text-center">
                <BarChart3 className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
                <p className="text-xl font-bold">{total}</p>
                <p className="text-[11px] text-muted-foreground">Totali</p>
              </CardContent>
            </Card>
            <Card className="bg-amber-500/5 border-amber-500/20 border cursor-pointer hover:scale-[1.02] transition-all" onClick={() => setFilterByKind("extra")}>
              <CardContent className="p-3 text-center">
                <Route className="w-5 h-5 text-amber-400 mx-auto mb-1" />
                <p className="text-xl font-bold">{byKind.extra}</p>
                <p className="text-[11px] text-muted-foreground">Extraurbano puro</p>
              </CardContent>
            </Card>
            <Card className="bg-blue-500/5 border-blue-500/20 border cursor-pointer hover:scale-[1.02] transition-all" onClick={() => setFilterByKind("urban")}>
              <CardContent className="p-3 text-center">
                <Bus className="w-5 h-5 text-blue-400 mx-auto mb-1" />
                <p className="text-xl font-bold">{byKind.urban}</p>
                <p className="text-[11px] text-muted-foreground">Urbano puro</p>
              </CardContent>
            </Card>
            <Card className="bg-indigo-500/5 border-indigo-500/20 border cursor-pointer hover:scale-[1.02] transition-all" onClick={() => setFilterByKind("mixed")}>
              <CardContent className="p-3 text-center">
                <ArrowRightLeft className="w-5 h-5 text-indigo-400 mx-auto mb-1" />
                <p className="text-xl font-bold">{byKind.mixed}</p>
                <p className="text-[11px] text-muted-foreground">Miste</p>
              </CardContent>
            </Card>
            <Card className={`${byKind.other > 0 ? "bg-red-500/5 border-red-500/20" : "bg-card/50"} border cursor-pointer hover:scale-[1.02] transition-all`} onClick={() => setFilterByKind("other")}>
              <CardContent className="p-3 text-center">
                <AlertCircle className={`w-5 h-5 ${byKind.other > 0 ? "text-red-400" : "text-muted-foreground"} mx-auto mb-1`} />
                <p className="text-xl font-bold">{byKind.other + byKind.none}</p>
                <p className="text-[11px] text-muted-foreground">Altro / Non servita</p>
              </CardContent>
            </Card>
          </div>

          {/* Griglia per-codice (solo codici presenti) */}
          {presentCodes.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 gap-2">
              {presentCodes.map(def => renderStatCard(def, byCode.get(def.code) ?? 0))}
            </div>
          )}
        </>
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

        {/* Attivi */}
        {(filterCode !== "all" || filterKind !== "all") && (
          <Button variant="outline" size="sm" onClick={setFilterAll} className="text-xs">
            Rimuovi filtri
          </Button>
        )}
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
              {filterCode !== "all" && (
                <Badge className={`${(CLASS_BY_CODE[filterCode] ?? FALLBACK_DEF).bg} ${(CLASS_BY_CODE[filterCode] ?? FALLBACK_DEF).color} ${(CLASS_BY_CODE[filterCode] ?? FALLBACK_DEF).border} border text-[10px] ml-1`}>
                  Filtro: {(CLASS_BY_CODE[filterCode] ?? FALLBACK_DEF).label}
                </Badge>
              )}
              {filterKind !== "all" && filterCode === "all" && (
                <Badge variant="outline" className="text-[10px] ml-1 capitalize">
                  Gruppo: {filterKind === "extra" ? "Extraurbano" : filterKind === "urban" ? "Urbano puro" : filterKind === "mixed" ? "Misto" : filterKind === "other" ? "Altro" : "Non servita"}
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
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Urb.</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">Extra</th>
                    <th className="text-left py-2 px-2 font-medium text-muted-foreground">Reti</th>
                    <th className="text-center py-2 px-2 font-medium text-muted-foreground">stop_classification</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(s => {
                    const def = CLASS_BY_CODE[s.classification] ?? FALLBACK_DEF;
                    return (
                      <tr key={s.stopId} className="border-b border-border/10 hover:bg-muted/10">
                        <td className="py-1.5 px-2 font-mono text-xs text-muted-foreground">{s.stopId}</td>
                        <td className="py-1.5 px-2 font-mono text-xs text-muted-foreground">{s.stopCode || "—"}</td>
                        <td className="py-1.5 px-2 font-medium">{s.stopName}</td>
                        <td className="py-1.5 px-2 text-center text-xs">{s.routeCount}</td>
                        <td className="py-1.5 px-2 text-center text-xs text-blue-400">{s.urbanRoutes}</td>
                        <td className="py-1.5 px-2 text-center text-xs text-amber-400">{s.extraRoutes}</td>
                        <td className="py-1.5 px-2">
                          <div className="flex flex-wrap gap-1">
                            {s.networks.map(n => (
                              <span key={n} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground">
                                {NETWORK_SHORT[n] ?? n}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          <Badge
                            className={`${def.bg} ${def.color} ${def.border} border gap-1 text-[10px] cursor-pointer`}
                            onClick={() => setFilterByCode(def.code)}
                            title={`Filtra per ${def.label}`}
                          >
                            {def.icon}
                            <span className="font-mono">{s.classification}</span>
                            <span>—</span>
                            <span>{def.shortCode}</span>
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