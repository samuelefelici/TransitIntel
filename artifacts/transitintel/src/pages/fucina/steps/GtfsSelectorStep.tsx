/**
 * Step 0 — Selezione GTFS
 *
 * L'utente può:
 *   A) Scegliere tra i feed GTFS già caricati a sistema
 *   B) Importare un nuovo ZIP GTFS (caricato nel DB, disponibile per lo scheduling)
 */
import React, { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import {
  Database, CheckCircle2, Loader2,
  AlertTriangle, ChevronRight, FolderOpen, CloudUpload, Upload, X,
} from "lucide-react";
import { getApiBase } from "@/lib/api";
import type { GtfsSelection } from "@/pages/fucina";

interface GtfsFeed {
  id: string;
  filename: string;
  agencyName: string | null;
  feedStartDate: string | null;
  feedEndDate: string | null;
  stopsCount: number;
  routesCount: number;
  tripsCount: number;
  uploadedAt: string;
}

interface Props {
  onComplete: (sel: GtfsSelection) => void;
}

export default function GtfsSelectorStep({ onComplete }: Props) {
  const [mode, setMode] = useState<"existing" | "import">("existing");

  // ── Existing feeds ──
  const [feeds, setFeeds] = useState<GtfsFeed[]>([]);
  const [loadingFeeds, setLoadingFeeds] = useState(true);
  const [selectedFeedId, setSelectedFeedId] = useState<string>("");
  const [feedsError, setFeedsError] = useState<string | null>(null);

  // ── Import ──
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const base = getApiBase();
    fetch(`${base}/api/gtfs/feeds`)
      .then(r => r.json())
      .then((data) => {
        const list: GtfsFeed[] = Array.isArray(data.data) ? data.data : [];
        setFeeds(list);
        if (list.length > 0) setSelectedFeedId(list[0].id);
      })
      .catch(() => setFeedsError("Impossibile caricare i feed GTFS dal server."))
      .finally(() => setLoadingFeeds(false));
  }, []);

  const handleSelectExisting = () => {
    const found = feeds.find(f => f.id === selectedFeedId);
    if (!found) return;
    onComplete({
      source: "existing",
      date: found.feedStartDate || found.uploadedAt.slice(0, 10).replace(/-/g, ""),
      label: (found.agencyName || found.filename) + ` · ${found.routesCount} linee`,
      tempFeedId: found.id,
    });
  };

  const handleUpload = useCallback(async () => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const base = getApiBase();
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${base}/api/gtfs/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Errore ${res.status}`);
      }
      const data = await res.json();
      // data: { success, feedId, agencyName, routesImported, stopsImported, ... }
      onComplete({
        source: "import",
        date: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
        label: `${data.agencyName || file.name} · ${data.routesImported} linee importate`,
        tempFeedId: data.feedId,
      });
    } catch (err: any) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }, [file, onComplete]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".zip")) setFile(f);
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
            <Database className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">Seleziona dati GTFS</h2>
            <p className="text-xs text-muted-foreground">Scegli i dati su cui lavorare in questa sessione</p>
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 mb-6">
          {(["existing", "import"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                mode === m
                  ? "bg-orange-500/15 border-orange-500/40 text-orange-300"
                  : "border-border/40 text-muted-foreground hover:border-orange-500/20 hover:text-orange-300/60"
              }`}
            >
              {m === "existing" ? <FolderOpen className="w-4 h-4" /> : <CloudUpload className="w-4 h-4" />}
              {m === "existing" ? "Dati esistenti" : "Importa nuovo ZIP"}
            </button>
          ))}
        </div>

        {/* Existing feeds panel */}
        {mode === "existing" && (
          <div className="space-y-3">
            {loadingFeeds ? (
              <div className="flex items-center gap-2 text-muted-foreground py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin text-orange-400" />
                <span className="text-sm">Caricamento feed disponibili…</span>
              </div>
            ) : feedsError ? (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-2 text-red-400 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {feedsError}
              </div>
            ) : feeds.length === 0 ? (
              <div className="bg-muted/30 border border-border/30 rounded-xl p-6 text-center text-muted-foreground text-sm">
                Nessun feed GTFS trovato. Usa <strong>Importa nuovo ZIP</strong> per caricarne uno.
              </div>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-2">{feeds.length} feed disponibili — seleziona quello di lavoro:</p>
                <div className="grid gap-2 max-h-64 overflow-y-auto pr-1">
                  {feeds.map(f => (
                    <button
                      key={f.id}
                      onClick={() => setSelectedFeedId(f.id)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                        selectedFeedId === f.id
                          ? "bg-orange-500/10 border-orange-500/30"
                          : "border-border/30 hover:border-orange-500/20 hover:bg-orange-500/5"
                      }`}
                    >
                      <Database className={`w-4 h-4 shrink-0 ${selectedFeedId === f.id ? "text-orange-400" : "text-muted-foreground"}`} />
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${selectedFeedId === f.id ? "text-orange-300" : "text-foreground"}`}>
                          {f.agencyName || f.filename}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {f.routesCount} linee · {f.stopsCount} fermate
                          {f.feedStartDate ? ` · ${formatDate(f.feedStartDate)} → ${f.feedEndDate ? formatDate(f.feedEndDate) : "…"}` : ""}
                        </p>
                      </div>
                      {selectedFeedId === f.id && <CheckCircle2 className="w-4 h-4 text-orange-400 shrink-0" />}
                    </button>
                  ))}
                </div>

                <button
                  onClick={handleSelectExisting}
                  disabled={!selectedFeedId}
                  className="mt-4 w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm text-black bg-gradient-to-r from-orange-400 to-amber-400 disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_20px_rgba(251,146,60,0.3)] transition-shadow"
                >
                  Usa questi dati
                  <ChevronRight className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        )}

        {/* Import panel */}
        {mode === "import" && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Importa un archivio ZIP GTFS. Il feed sarà disponibile <strong className="text-orange-400/80">solo in questa sessione</strong> e non sovrascriverà i dati di sistema.
            </p>

            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                dragOver
                  ? "border-orange-400/60 bg-orange-500/10"
                  : file
                    ? "border-orange-500/40 bg-orange-500/5"
                    : "border-border/40 hover:border-orange-500/30 hover:bg-orange-500/5"
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); }}
              />
              {file ? (
                <div className="flex items-center justify-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-orange-400" />
                  <div className="text-left">
                    <p className="text-sm font-medium text-orange-300">{file.name}</p>
                    <p className="text-[10px] text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    className="ml-2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">Trascina qui il file ZIP o clicca per sfogliare</p>
                  <p className="text-[10px] text-muted-foreground/50 mt-1">Solo file .zip GTFS validi</p>
                </>
              )}
            </div>

            {uploadError && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2 text-red-400 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {uploadError}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm text-black bg-gradient-to-r from-orange-400 to-amber-400 disabled:opacity-40 disabled:cursor-not-allowed hover:shadow-[0_0_20px_rgba(251,146,60,0.3)] transition-shadow"
            >
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
              {uploading ? "Importazione in corso…" : "Importa e continua"}
              {!uploading && <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function formatDate(ymd: string): string {
  if (ymd.length !== 8) return ymd;
  return `${ymd.slice(6, 8)}/${ymd.slice(4, 6)}/${ymd.slice(0, 4)}`;
}
