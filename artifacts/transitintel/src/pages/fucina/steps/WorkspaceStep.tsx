/**
 * Step 3 — Area di Lavoro Turni Macchina
 *
 * Wrappa VehicleWorkspace (Gantt interattivo drag & drop)
 * passando il result dell'ottimizzazione come initialResult.
 *
 * In modalità progetto (projectId valorizzato) questo step è il PUNTO
 * UNICO di salvataggio dello scenario vetture: l'utente affina i turni
 * sul Gantt e poi clicca "Salva nel progetto" che fa POST + ritorno
 * alla dashboard del progetto.
 */
import React, { useState } from "react";
import { ArrowLeft, Download, Truck, FolderOpen, Save, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import VehicleWorkspace from "@/pages/fucina/vehicle-workspace";
import { getApiBase } from "@/lib/api";
import type { GtfsSelection } from "@/pages/fucina";
import type { ServiceProgramResult } from "@/pages/optimizer-route/types";
import type { DeadheadMatrix } from "@/pages/fucina/steps/DeadheadStep";

interface Props {
  gtfsSelection: GtfsSelection;
  optimizationResult: ServiceProgramResult;
  deadheadMatrix?: DeadheadMatrix | null;
  savedScenarioId?: string;
  onBack: () => void;
  /** Vai allo step 7 — Area di Lavoro Turni Guida (interno fucina) */
  onContinueToDriverShifts?: () => void;
  /** Quando passato, attiva la modalità "progetto":
   *  - il bottone diventa "Salva nel progetto" (POST scenario + return)
   *  - il return navigation viene chiamato dopo il save riuscito.
   *  Se savedScenarioId è già presente, salta il POST e fa solo il return. */
  projectId?: string | null;
  onSaveAndReturn?: (savedId?: string) => void;
}

export default function WorkspaceStep({
  gtfsSelection,
  optimizationResult,
  deadheadMatrix,
  savedScenarioId,
  onBack,
  onContinueToDriverShifts,
  projectId,
  onSaveAndReturn,
}: Props) {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [scenarioName, setScenarioName] = useState("");
  const [saving, setSaving] = useState(false);

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(optimizationResult, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `turni-macchina-${gtfsSelection.date || "export"}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Esportazione completata");
  };

  /** Salva lo scenario nel progetto e torna alla dashboard.
   *  Se savedScenarioId è già presente (es. utente ha già salvato),
   *  salta il POST e va direttamente al ritorno. */
  async function saveAndReturn() {
    if (!onSaveAndReturn) return;
    if (savedScenarioId) {
      onSaveAndReturn();
      return;
    }
    setShowSaveDialog(true);
    setScenarioName(`Scenario ${new Date().toLocaleDateString("it-IT")}`);
  }

  async function confirmSave() {
    if (!scenarioName.trim() || !projectId) return;
    setSaving(true);
    try {
      const base = getApiBase();
      // Ricostruiamo input minimale dai dati disponibili
      const date = gtfsSelection.date || (optimizationResult as any)?.summary?.date || "";
      const resp = await fetch(`${base}/api/service-program/scenarios`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: scenarioName.trim(),
          date,
          input: {},
          result: optimizationResult,
          projectId,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json().catch(() => ({}));
      const newId: string | undefined = data?.id || data?.scenario?.id;

      // ── VCSP: il salvataggio a fine procedura crea ENTRAMBI gli scenari.
      // Turni guida del round scelto → DSS collegato allo scenario vetture.
      const vcsp = (optimizationResult as any)?.vcsp;
      let crewSaved: boolean | null = null;
      if (newId && vcsp) {
        const selR = (optimizationResult as any)?.vcspSelectedRound ?? vcsp.bestRound ?? null;
        const rr = vcsp.roundResults?.find((x: any) => x.round === selR);
        const crew = rr?.crew ?? vcsp.crew;
        if (crew?.driverShifts?.length) {
          crewSaved = false;
          try {
            const dssResp = await fetch(`${base}/api/driver-shifts/${newId}/scenarios`, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: `${scenarioName.trim()} · Turni guida (VCSP${selR != null ? ` round ${selR}` : ""})`,
                result: {
                  solver: "vcsp_crew",
                  driverShifts: crew.driverShifts,
                  summary: crew.summary ?? null,
                  handovers: crew.handovers ?? [],
                  clusters: crew.clusters ?? [],
                  metrics: crew.metrics ?? null,
                },
                config: { source: "vcsp", bestRound: vcsp.bestRound ?? null, selectedRound: selR },
              }),
            });
            crewSaved = dssResp.ok;
          } catch { /* i TM sono salvati comunque; i TG si possono generare dal CSP */ }
        }
      }
      if (crewSaved === null) {
        toast.success("Scenario vetture salvato nel progetto", { description: scenarioName.trim() });
      } else if (crewSaved) {
        toast.success("Salvati ENTRAMBI nel progetto", {
          description: "🚌 Turni macchina + 👥 Turni guida (VCSP): li trovi nelle due aree di lavoro.",
        });
      } else {
        toast.warning("Turni macchina salvati, turni guida NO", {
          description: "Aprili dal Workspace Turni Guida e generali dallo step CSP, oppure risalva.",
        });
      }
      setShowSaveDialog(false);
      onSaveAndReturn?.(newId);
    } catch (e: any) {
      toast.error("Errore salvataggio", { description: e.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Sub-header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-orange-500/10 bg-orange-950/10 shrink-0">
        <div className="flex items-center gap-2">
          <Truck className="w-3.5 h-3.5 text-orange-400/60" />
          <span className="text-[11px] text-orange-300/60 font-medium">Area di Lavoro — Turni Macchina</span>
          <span className="text-[10px] text-orange-400/30 font-mono px-1.5 py-0.5 bg-orange-500/5 rounded border border-orange-500/10">
            {gtfsSelection.label}
          </span>
          <span className="text-[9px] text-orange-300/30 italic hidden sm:inline">
            Trascina le corse tra i turni
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onBack}
            className="flex items-center gap-1.5 text-[11px] text-orange-300/50 hover:text-orange-300 transition-colors px-2 py-1 rounded-lg hover:bg-orange-500/8">
            <ArrowLeft className="w-3.5 h-3.5" /> Indietro
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-1.5 text-[11px] text-orange-300 font-medium px-3 py-1.5 rounded-lg border border-orange-500/30 bg-orange-500/8 hover:bg-orange-500/15 transition-all">
            <Download className="w-3.5 h-3.5" /> Esporta JSON
          </button>
          {/* Pipeline-mode in un progetto: salva inline + torna alla dashboard.
              Da lì l'utente sceglierà "Area di Lavoro Turni Guida" e potrà selezionare
              lo scenario vetture corrispondente. */}
          {onSaveAndReturn ? (
            <button
              onClick={saveAndReturn}
              className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg border border-emerald-500/40 bg-gradient-to-r from-emerald-500/15 to-teal-500/15 text-emerald-200 hover:from-emerald-500/25 hover:to-teal-500/25 transition-all"
              title={savedScenarioId ? "Torna alla dashboard del progetto" : "Salva nel progetto e torna alla dashboard"}
            >
              <Save className="w-3.5 h-3.5" />
              {savedScenarioId ? "Torna al progetto" : "Salva nel progetto"}
            </button>
          ) : onContinueToDriverShifts ? (
            <button
              onClick={() => {
                if (!savedScenarioId) {
                  toast.warning("Devi prima salvare lo scenario nello step Ottimizzazione", {
                    description: "Torna allo step 6 → 'Salva scenario' per abilitare i Turni Guida.",
                  });
                  return;
                }
                onContinueToDriverShifts();
              }}
              className={`flex items-center gap-1.5 text-[11px] font-medium px-3 py-1.5 rounded-lg border transition-all ${
                savedScenarioId
                  ? "text-purple-300 border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15"
                  : "text-purple-300/40 border-purple-500/15 bg-purple-500/5 cursor-help"
              }`}
              title={savedScenarioId ? "Procedi ai Turni Guida" : "Salva prima lo scenario nell'Ottimizzazione"}
            >
              Turni Guida →
            </button>
          ) : savedScenarioId ? (
            <a href={`/driver-shifts/${savedScenarioId}`}
              className="flex items-center gap-1.5 text-[11px] text-purple-300 font-medium px-3 py-1.5 rounded-lg border border-purple-500/30 bg-purple-500/8 hover:bg-purple-500/15 transition-all">
              Turni Guida →
            </a>
          ) : null}
        </div>
      </div>

      {/* Workspace */}
      <div className="flex-1 overflow-hidden">
        <VehicleWorkspace initialResult={optimizationResult} deadheadMatrix={deadheadMatrix} initialSavedId={savedScenarioId ?? null} />
      </div>

      {/* Save dialog (modalità progetto) */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-zinc-950 to-black p-6 shadow-[0_0_40px_rgba(16,185,129,0.15)]">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-emerald-400" />
                <h3 className="text-lg font-bold text-zinc-100">Salva scenario nel progetto</h3>
              </div>
              <button onClick={() => setShowSaveDialog(false)} disabled={saving}
                className="text-zinc-500 hover:text-zinc-200 p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            {(() => {
              const vcsp = (optimizationResult as any)?.vcsp;
              if (!vcsp) {
                return (
                  <p className="text-xs text-zinc-400 mb-3">
                    Lo scenario verrà agganciato al progetto corrente e sarà disponibile per la creazione dei turni guida.
                  </p>
                );
              }
              const selR = (optimizationResult as any)?.vcspSelectedRound ?? vcsp.bestRound;
              const rr = vcsp.roundResults?.find((x: any) => x.round === selR);
              const tmN = (optimizationResult as any)?.shifts?.length ?? 0;
              const tgN = (rr?.crew ?? vcsp.crew)?.driverShifts?.length ?? 0;
              return (
                <p className="text-xs text-emerald-300 mb-3">
                  Con un solo salvataggio crei <b>ENTRAMBI</b> gli scenari del round #{selR}:
                  {" "}🚌 {tmN} turni macchina e 👥 {tgN} turni guida — pronti nelle due aree di lavoro.
                </p>
              );
            })()}
            <label className="text-[11px] text-zinc-500 font-mono uppercase tracking-widest">Nome scenario</label>
            <input
              autoFocus
              type="text"
              value={scenarioName}
              onChange={e => setScenarioName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirmSave(); if (e.key === "Escape") setShowSaveDialog(false); }}
              disabled={saving}
              placeholder="es. Esercizio invernale v1"
              className="w-full mt-1 px-3 py-2 rounded-lg bg-black/60 border border-zinc-800 focus:border-emerald-500/50 outline-none text-sm text-zinc-100 placeholder:text-zinc-600"
            />
            <div className="flex items-center justify-end gap-2 mt-5">
              <button onClick={() => setShowSaveDialog(false)} disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-white/5">
                Annulla
              </button>
              <button onClick={confirmSave} disabled={saving || !scenarioName.trim()}
                className="flex items-center gap-1.5 text-xs font-bold px-4 py-1.5 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-black disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-[0_0_12px_rgba(16,185,129,0.4)] transition-shadow">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? "Salvataggio…" : "Salva e torna al progetto"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
