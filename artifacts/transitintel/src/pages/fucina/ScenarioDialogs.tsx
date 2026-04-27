/**
 * ScenarioDialogs — modali per salvataggio e caricamento scenari del workspace turni.
 *  - SaveScenarioDialog: prompt per nome con validazione, default sensato.
 *  - LoadScenarioDialog: lista paginata con carica/elimina per riprendere uno scenario.
 */
import React, { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Save, Loader2, FolderOpen, Trash2, Calendar, Truck, AlertCircle, X } from "lucide-react";
import { getApiBase } from "@/lib/api";
import type { ServiceProgramResult } from "@/pages/optimizer-route/types";

/* ═══════════════════════════════════════════════════════════════
 *  SaveScenarioDialog
 * ═══════════════════════════════════════════════════════════════ */
export function SaveScenarioDialog({
  open, onClose, defaultName, onConfirm, saving,
}: {
  open: boolean;
  onClose: () => void;
  defaultName?: string;
  saving?: boolean;
  /** Restituisce true se vuoi chiudere il dialog dopo */
  onConfirm: (name: string) => Promise<boolean> | boolean;
}) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName?.trim() || `Scenario ${new Date().toLocaleString("it-IT", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      })}`);
      setTouched(false);
      // focus dopo render
      setTimeout(() => {
        const input = document.getElementById("scenario-name-input") as HTMLInputElement | null;
        input?.focus();
        input?.select();
      }, 50);
    }
  }, [open, defaultName]);

  if (!open) return null;
  const trimmed = name.trim();
  const tooShort = trimmed.length < 3;
  const showError = touched && tooShort;

  const submit = async () => {
    setTouched(true);
    if (tooShort) return;
    const ok = await onConfirm(trimmed);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={onClose}>
      <div className="bg-background border border-orange-500/30 rounded-xl max-w-md w-full shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Save className="w-5 h-5 text-orange-400" />
            <h3 className="text-sm font-display font-bold">Salva scenario</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block text-xs text-muted-foreground" htmlFor="scenario-name-input">
            Nome dello scenario
          </label>
          <input
            id="scenario-name-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose();
            }}
            placeholder="Es. Scenario invernale lunedì"
            className={`w-full h-10 px-3 text-sm rounded-lg bg-muted/30 text-foreground border focus:outline-none transition-colors ${
              showError ? "border-red-500/50" : "border-border/40 focus:border-orange-500/60"
            }`}
            disabled={saving}
          />
          {showError && (
            <div className="flex items-center gap-1.5 text-[11px] text-red-400">
              <AlertCircle className="w-3 h-3" /> Inserisci almeno 3 caratteri
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/70">
            Lo scenario verrà salvato nel database e potrai riaprirlo in seguito dal pulsante <em>Carica scenario</em>.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border/30 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs h-8" disabled={saving}>
            Annulla
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={saving || tooShort}
            className="text-xs h-8 bg-orange-500 hover:bg-orange-600 text-white"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}
            Salva
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  LoadScenarioDialog
 * ═══════════════════════════════════════════════════════════════ */
export interface ScenarioListItem {
  id: number;
  name: string;
  date?: string;
  createdAt?: string;
  // metadata opzionali se l'API li espone
  vehicles?: number;
  trips?: number;
}

export function LoadScenarioDialog({
  open, onClose, onLoad,
}: {
  open: boolean;
  onClose: () => void;
  onLoad: (id: number, name: string, result: ServiceProgramResult) => void;
}) {
  const [items, setItems] = useState<ScenarioListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const fetchList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios`);
      if (!res.ok) throw new Error("Errore caricamento lista scenari");
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) fetchList(); }, [open, fetchList]);

  const handleLoad = async (item: ScenarioListItem) => {
    setLoadingId(item.id);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios/${item.id}`);
      if (!res.ok) throw new Error("Errore caricamento scenario");
      const detail = await res.json();
      if (!detail.result) throw new Error("Scenario senza risultato");
      onLoad(item.id, detail.name || item.name, detail.result);
      onClose();
      toast.success("Scenario caricato", { description: detail.name || item.name });
    } catch (e: any) {
      toast.error("Errore caricamento", { description: e.message });
    } finally {
      setLoadingId(null);
    }
  };

  const handleDelete = async (item: ScenarioListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Eliminare lo scenario "${item.name}"?`)) return;
    setDeletingId(item.id);
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/api/service-program/scenarios/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Errore eliminazione");
      setItems(prev => prev.filter(x => x.id !== item.id));
      toast.success("Scenario eliminato");
    } catch (e: any) {
      toast.error("Errore eliminazione", { description: e.message });
    } finally {
      setDeletingId(null);
    }
  };

  if (!open) return null;
  const filtered = filter
    ? items.filter(i => (i.name || "").toLowerCase().includes(filter.toLowerCase()))
    : items;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={onClose}>
      <div className="bg-background border border-orange-500/30 rounded-xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl"
           onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-5 h-5 text-orange-400" />
            <h3 className="text-sm font-display font-bold">Carica scenario</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-3 pb-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtra per nome…"
            className="w-full h-9 px-3 text-xs rounded-lg bg-muted/30 border border-border/40 focus:border-orange-500/60 focus:outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-3 min-h-[200px]">
          {loading && (
            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground text-xs">
              <Loader2 className="w-4 h-4 animate-spin" /> Caricamento…
            </div>
          )}
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="text-center py-10 text-xs text-muted-foreground">
              {items.length === 0 ? "Nessuno scenario salvato." : "Nessun risultato per il filtro corrente."}
            </div>
          )}
          {!loading && filtered.length > 0 && (
            <div className="space-y-1.5">
              {filtered.map(item => {
                const dateStr = item.createdAt
                  ? new Date(item.createdAt).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })
                  : item.date || "—";
                return (
                  <div
                    key={item.id}
                    className="group flex items-center gap-3 px-3 py-2 bg-muted/20 hover:bg-muted/40 border border-border/30 rounded-lg cursor-pointer transition-colors"
                    onClick={() => handleLoad(item)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{item.name || `Scenario #${item.id}`}</div>
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground mt-0.5">
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{dateStr}</span>
                        {item.vehicles !== undefined && (
                          <span className="flex items-center gap-1"><Truck className="w-3 h-3" />{item.vehicles} veicoli</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleDelete(item, e)}
                      disabled={deletingId === item.id}
                      title="Elimina"
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                    >
                      {deletingId === item.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={loadingId === item.id}
                      onClick={(e) => { e.stopPropagation(); handleLoad(item); }}
                      className="h-7 text-[11px] text-orange-300 hover:text-orange-200 hover:bg-orange-500/10"
                    >
                      {loadingId === item.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                        : <FolderOpen className="w-3.5 h-3.5 mr-1" />}
                      Apri
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border/30 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {items.length} scenari salvati
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs h-8">
            Chiudi
          </Button>
        </div>
      </div>
    </div>
  );
}
