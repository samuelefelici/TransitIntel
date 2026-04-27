/**
 * PlannerStudio — Lista scenari di pianificazione GTFS
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import { Layers, Plus, Loader2, AlertTriangle, ArrowRight, FileText } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface Scenario {
  id: string;
  name: string;
  description: string | null;
  baselineFeedId: string;
  mode: "single" | "ab";
  status: string;
  summary: { editsCount?: number; routesAffected?: number } | null;
  createdAt: string;
  updatedAt: string;
  baselineFeedName: string | null;
  baselineAgency: string | null;
}

export default function PlanningListPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ scenarios: Scenario[] }>("/api/planning/scenarios")
      .then((d) => setScenarios(d.scenarios || []))
      .catch((e) => setError(e?.message || "Errore caricamento scenari"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Layers className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">PlannerStudio</h1>
            <p className="text-sm text-muted-foreground">
              Scenari di pianificazione e simulazione modifiche al servizio GTFS
            </p>
          </div>
        </div>
        <Link href="/planning/new">
          <a className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition">
            <Plus className="w-4 h-4" />
            Nuovo scenario
          </a>
        </Link>
      </div>

      {/* Body */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center gap-3 p-4 bg-destructive/10 text-destructive rounded-lg">
          <AlertTriangle className="w-5 h-5" />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && scenarios.length === 0 && (
        <div className="border-2 border-dashed border-border rounded-lg p-12 text-center">
          <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-lg font-semibold mb-1">Nessuno scenario</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Crea il tuo primo scenario per iniziare a simulare modifiche al servizio.
          </p>
          <Link href="/planning/new">
            <a className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg">
              <Plus className="w-4 h-4" /> Nuovo scenario
            </a>
          </Link>
        </div>
      )}

      {!loading && !error && scenarios.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map((s, i) => (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.04 }}
            >
              <Link href={`/planning/${s.id}/workspace`}>
                <a className="block bg-card border border-border rounded-lg p-4 hover:border-primary hover:shadow-md transition">
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold truncate">{s.name}</h3>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        s.mode === "ab"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {s.mode === "ab" ? "A/B" : "Single"}
                    </span>
                  </div>
                  {s.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
                      {s.description}
                    </p>
                  )}
                  <div className="text-xs text-muted-foreground space-y-1">
                    <div>
                      <span className="font-medium">Feed:</span>{" "}
                      {s.baselineFeedName || "—"} ({s.baselineAgency || "—"})
                    </div>
                    <div>
                      <span className="font-medium">Modifiche:</span>{" "}
                      {s.summary?.editsCount ?? 0} ·{" "}
                      <span className="font-medium">Linee impattate:</span>{" "}
                      {s.summary?.routesAffected ?? 0}
                    </div>
                    <div>
                      Aggiornato: {new Date(s.updatedAt).toLocaleString("it-IT")}
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span
                      className={`px-2 py-0.5 rounded ${
                        s.status === "draft"
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {s.status}
                    </span>
                    <ArrowRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </a>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
