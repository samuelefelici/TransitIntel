/**
 * PlannerStudio — Wizard creazione nuovo scenario
 */
import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { ArrowLeft, Loader2, Save, AlertTriangle, Layers } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface GtfsFeed {
  id: string;
  filename: string;
  agencyName: string | null;
  stopsCount: number | null;
  routesCount: number | null;
  tripsCount: number | null;
}

export default function PlanningNewPage() {
  const [, setLocation] = useLocation();
  const [feeds, setFeeds] = useState<GtfsFeed[]>([]);
  const [loadingFeeds, setLoadingFeeds] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baselineFeedId, setBaselineFeedId] = useState("");
  const [mode, setMode] = useState<"ab" | "single">("ab");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ feeds: GtfsFeed[] }>("/api/gtfs/feeds")
      .then((d) => {
        setFeeds(d.feeds || []);
        if (d.feeds?.[0]) setBaselineFeedId(d.feeds[0].id);
      })
      .catch((e) => setError(e?.message || "Errore caricamento GTFS feeds"))
      .finally(() => setLoadingFeeds(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Il nome è obbligatorio");
      return;
    }
    if (!baselineFeedId) {
      setError("Seleziona un GTFS baseline");
      return;
    }
    setSubmitting(true);
    try {
      const r = await apiFetch<{ scenario: { id: string } }>(
        "/api/planning/scenarios",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || null,
            baselineFeedId,
            mode,
          }),
        },
      );
      setLocation(`/planning/${r.scenario.id}/workspace`);
    } catch (e: any) {
      setError(e?.message || "Errore creazione scenario");
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Link href="/planning">
        <a className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Torna ai scenari
        </a>
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Layers className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Nuovo scenario</h1>
          <p className="text-sm text-muted-foreground">
            Configura un nuovo scenario di pianificazione partendo da un GTFS esistente
          </p>
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-5 bg-card border border-border rounded-lg p-6"
      >
        {/* Nome */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            Nome scenario <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="es. Potenziamento linea 8 estate 2026"
            className="w-full px-3 py-2 border border-input rounded-md bg-background"
            disabled={submitting}
          />
        </div>

        {/* Descrizione */}
        <div>
          <label className="block text-sm font-medium mb-1.5">Descrizione</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Obiettivi e contesto dello scenario (opzionale)"
            className="w-full px-3 py-2 border border-input rounded-md bg-background resize-none"
            disabled={submitting}
          />
        </div>

        {/* Feed baseline */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            GTFS baseline <span className="text-destructive">*</span>
          </label>
          {loadingFeeds ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Caricamento...
            </div>
          ) : feeds.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Nessun GTFS caricato. Vai su <Link href="/data"><a className="underline">Dati & GTFS</a></Link> per caricarne uno.
            </div>
          ) : (
            <select
              value={baselineFeedId}
              onChange={(e) => setBaselineFeedId(e.target.value)}
              className="w-full px-3 py-2 border border-input rounded-md bg-background"
              disabled={submitting}
            >
              {feeds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.filename} — {f.agencyName || "?"} ({f.routesCount ?? 0} linee, {f.stopsCount ?? 0} fermate)
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Modalità */}
        <div>
          <label className="block text-sm font-medium mb-2">Modalità</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode("ab")}
              className={`p-3 border rounded-md text-left transition ${
                mode === "ab"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-primary/50"
              }`}
              disabled={submitting}
            >
              <div className="font-medium text-sm">A/B Comparison</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Confronta baseline vs scenario modificato
              </div>
            </button>
            <button
              type="button"
              onClick={() => setMode("single")}
              className={`p-3 border rounded-md text-left transition ${
                mode === "single"
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-primary/50"
              }`}
              disabled={submitting}
            >
              <div className="font-medium text-sm">Single</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Solo modifiche, senza confronto baseline
              </div>
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-md text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Link href="/planning">
            <a className="px-4 py-2 text-sm rounded-md border border-input hover:bg-muted">
              Annulla
            </a>
          </Link>
          <button
            type="submit"
            disabled={submitting || loadingFeeds || feeds.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Crea scenario
          </button>
        </div>
      </form>
    </div>
  );
}
