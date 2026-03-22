import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  RefreshCw, Database, Map, Users, CheckCircle2,
  AlertTriangle, Clock, Loader2, Info, ExternalLink, Star,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api";

interface SourceStatus {
  ready: boolean;
  cooldownRemaining: number;
  lastSync: string | null;
}
interface SyncStatus {
  "google-poi": SourceStatus;
  poi: SourceStatus;
  traffic: SourceStatus;
  census: SourceStatus;
}

interface SyncResult {
  success: boolean;
  source: string;
  inserted?: number;
  skipped?: number;
  failed?: number;
  categories?: Record<string, number>;
  errors?: string[];
  message?: string;
}

const SOURCES = [
  {
    key: "google-poi",
    label: "Punti di Interesse — Google Places",
    badge: "Raccomandato",
    badgeColor: "bg-green-500/20 text-green-400 border-green-500/30",
    description:
      "Ospedali, scuole, stazioni, centri commerciali, uffici pubblici con coordinate precise da Google Maps. Ricerca per 15 zone della provincia.",
    icon: Map,
    color: "text-green-400",
    bg: "bg-green-500/10",
    border: "border-green-500/40",
    apiLabel: "Google Places API (Nearby Search)",
    apiUrl: "https://developers.google.com/maps/documentation/places/web-service",
    keyNeeded: "GOOGLE_PLACES_API_KEY",
    detail:
      "Interroga l'endpoint nearbysearch per ogni categoria (ospedale, scuola, ecc.) attorno ai 15 centri abitati principali della provincia di Ancona. Deduplica per place_id e filtra per bounding box. Sostituisce tutti i POI esistenti con dati verificati da Google.",
  },
  {
    key: "traffic",
    label: "Traffico Stradale — TomTom",
    badge: "API Key",
    badgeColor: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    description:
      "Velocità e congestione real-time su 40 arterie principali (SS16, A14, SS76, strade urbane Ancona).",
    icon: RefreshCw,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    apiLabel: "TomTom Traffic Flow API v4",
    apiUrl: "https://developer.tomtom.com/traffic-api",
    keyNeeded: "TOMTOM_API_KEY",
    detail:
      "Interroga flowSegmentData per ogni punto strategico sulle strade provinciali. Calcola congestione = 1 − (velocità attuale / flusso libero). Conserva i dati per 90 giorni.",
  },
  {
    key: "census",
    label: "Popolazione — ISTAT 2023",
    badge: "Gratuita",
    badgeColor: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    description:
      "Popolazione residente e densità per tutti i 44 comuni della provincia di Ancona (stime ISTAT 2023).",
    icon: Users,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    apiLabel: "ISTAT — Dati Comuni 2023",
    apiUrl: "https://www.istat.it",
    keyNeeded: null,
    detail:
      "Inserisce o aggiorna le 44 sezioni censuarie con centroidi verificati e popolazione ISTAT 2023. Usato per calcolo domanda e identificazione zone sottoservite.",
  },
  {
    key: "poi",
    label: "Punti di Interesse — OpenStreetMap",
    badge: "Alternativa",
    badgeColor: "bg-slate-500/20 text-slate-400 border-slate-500/30",
    description:
      "POI da Overpass API (OSM). Meno preciso di Google ma completamente gratuito e open source.",
    icon: Map,
    color: "text-slate-400",
    bg: "bg-slate-500/10",
    border: "border-slate-500/30",
    apiLabel: "Overpass API (OpenStreetMap)",
    apiUrl: "https://overpass-api.de",
    keyNeeded: null,
    detail:
      "Interroga l'API Overpass per ottenere POI verificati dalla community OSM. Richiede ~2 minuti. Meno dati commerciali rispetto a Google, migliore per POI pubblici.",
  },
];

export default function SyncPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, SyncResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function fetchStatus() {
    try {
      const r = await fetch(`${getApiBase()}/api/admin/sync/status`);
      if (r.ok) setStatus(await r.json());
    } catch {}
  }

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, []);

  async function triggerSync(source: string) {
    setRunning((p) => ({ ...p, [source]: true }));
    setErrors((p) => ({ ...p, [source]: "" }));
    setResults((p) => { const n = { ...p }; delete n[source]; return n; });

    try {
      const r = await fetch(`${getApiBase()}/api/admin/sync/${source}`, { method: "POST" });
      const json = await r.json() as SyncResult;
      if (!r.ok || !json.success) {
        setErrors((p) => ({ ...p, [source]: json.message ?? `HTTP ${r.status}` }));
      } else {
        setResults((p) => ({ ...p, [source]: json }));
      }
    } catch (e: any) {
      setErrors((p) => ({ ...p, [source]: e.message ?? "Errore di rete" }));
    } finally {
      setRunning((p) => ({ ...p, [source]: false }));
      fetchStatus();
    }
  }

  function formatLastSync(iso: string | null) {
    if (!iso) return "Mai sincronizzato";
    return new Date(iso).toLocaleString("it-IT", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-3xl font-display font-bold">Sincronizza Dati</h1>
        <p className="text-muted-foreground mt-1">
          Aggiorna i dati di analisi con fonti esterne reali — Google Places, TomTom, ISTAT.
        </p>
      </motion.div>

      {/* Quick start banner */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.05 }}>
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="p-4 flex gap-3 items-start">
            <Star className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Ordine consigliato:</strong>{" "}
              1. <em>Popolazione</em> (istantaneo, ISTAT) →{" "}
              2. <em>POI Google Places</em> (~2 min, coordinate precise) →{" "}
              3. <em>Traffico</em> (richiede TomTom API Key).{" "}
              Il sync Google POI sostituisce completamente i dati esistenti con posizioni verificate.
            </p>
          </CardContent>
        </Card>
      </motion.div>

      {/* Source cards */}
      <div className="space-y-4">
        {SOURCES.map((src, i) => {
          const st = status?.[src.key as keyof SyncStatus];
          const isRunning = running[src.key];
          const result = results[src.key];
          const err = errors[src.key];
          const ready = st?.ready !== false;

          return (
            <motion.div
              key={src.key}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + i * 0.07 }}
            >
              <Card className={`border ${src.border} ${src.bg}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-9 h-9 rounded-lg ${src.bg} border ${src.border} flex items-center justify-center shrink-0`}>
                        <src.icon className={`w-4 h-4 ${src.color}`} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <CardTitle className="text-base">{src.label}</CardTitle>
                          <Badge className={`text-[10px] h-4 px-1.5 border ${src.badgeColor}`} variant="outline">
                            {src.badge}
                          </Badge>
                        </div>
                        <a
                          href={src.apiUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors mt-0.5"
                        >
                          {src.apiLabel} <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={src.key === "google-poi" ? "default" : "outline"}
                      disabled={isRunning || !ready}
                      onClick={() => triggerSync(src.key)}
                      className="shrink-0"
                    >
                      {isRunning ? (
                        <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />In corso…</>
                      ) : !ready ? (
                        <><Clock className="w-3.5 h-3.5 mr-1.5" />{st?.cooldownRemaining}s</>
                      ) : (
                        <><RefreshCw className="w-3.5 h-3.5 mr-1.5" />Sincronizza</>
                      )}
                    </Button>
                  </div>
                </CardHeader>

                <CardContent className="pt-0 space-y-3">
                  <p className="text-sm text-muted-foreground">{src.description}</p>

                  <p className="text-[11px] text-muted-foreground/70 leading-relaxed border-t border-border/30 pt-2">
                    {src.detail}
                  </p>

                  {src.keyNeeded && (
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="text-muted-foreground">Richiede secret:</span>
                      <code className="bg-muted px-1.5 py-0.5 rounded text-primary font-mono">{src.keyNeeded}</code>
                      <CheckCircle2 className="w-3 h-3 text-green-400" />
                      <span className="text-green-400">configurata</span>
                    </div>
                  )}

                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    Ultima sync: {formatLastSync(st?.lastSync ?? null)}
                  </div>

                  {/* Success result */}
                  {result && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="rounded-lg bg-green-500/10 border border-green-500/30 p-3 space-y-2"
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-green-400">
                        <CheckCircle2 className="w-4 h-4" />
                        Completato con successo
                      </div>
                      {result.inserted !== undefined && (
                        <p className="text-xs text-muted-foreground">
                          <strong className="text-foreground">{result.inserted}</strong> POI inseriti
                          {result.skipped != null && result.skipped > 0 && (
                            <span> · {result.skipped} scartati (fuori bbox o senza nome)</span>
                          )}
                          {result.failed != null && result.failed > 0 && (
                            <span className="text-amber-400"> · {result.failed} punti non raggiungibili</span>
                          )}
                        </p>
                      )}
                      {result.categories && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {Object.entries(result.categories).map(([cat, n]) => (
                            <Badge key={cat} variant="outline" className="text-[10px] h-5">
                              {cat}: {n as number}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {result.errors && result.errors.length > 0 && (
                        <details className="text-[10px] text-muted-foreground">
                          <summary className="cursor-pointer">{result.errors.length} avvisi</summary>
                          <ul className="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
                            {result.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                          </ul>
                        </details>
                      )}
                    </motion.div>
                  )}

                  {/* Error */}
                  {err && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 flex items-start gap-2"
                    >
                      <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                      <p className="text-xs text-destructive">{err}</p>
                    </motion.div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* Data sources reference */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
        <Card className="border-border/30">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <Database className="w-4 h-4 text-muted-foreground" />
              Altre fonti per analisi avanzate
            </h3>
            <div className="space-y-2 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <span className="text-primary font-mono shrink-0">GTFS</span>
                <span>Feed ufficiale ATMA/Marche — importa da <em>Import GTFS</em> per fermate e percorsi reali</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-primary font-mono shrink-0">ISTAT</span>
                <span>
                  Dati sezione censuaria granulari:{" "}
                  <a href="https://www.istat.it/storage/cartografia/basi_territoriali" target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                    Basi Territoriali ISTAT
                  </a>
                  {" "}— shapefile con popolazione per sezione (più preciso del dato comunale)
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-primary font-mono shrink-0">TomTom</span>
                <span>
                  Incidents API per eventi traffico (incidenti, lavori):{" "}
                  <code className="bg-muted px-1 rounded">/traffic/services/5/incidentDetails</code>
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
