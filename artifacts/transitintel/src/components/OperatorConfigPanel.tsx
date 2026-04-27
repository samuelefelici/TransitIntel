/**
 * OperatorConfigPanel — Pannello configurazione operatore per il solver CP-SAT
 *
 * Drawer laterale con:
 * - Selettore intensità solver
 * - Slider pesi obiettivo (0-10)
 * - Radar chart pesi
 * - Override regole turno
 * - Preset system (salva/carica da localStorage)
 */

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Settings, X, Save, RotateCcw, Zap, Shield,
  ChevronDown, ChevronRight, Bookmark, Trash2,
  DollarSign, Layers, Car, Route, Clock, Coffee, AlertTriangle,
} from "lucide-react";
import type { OperatorConfig, CostRates } from "@/hooks/use-crew-optimization";

/* ─── Default Weights ────────────────────────────────────────── */

const DEFAULT_WEIGHTS: Record<string, number> = {
  minDrivers: 8,
  workBalance: 6,
  minCambi: 5,
  preferIntero: 7,
  minSupplementi: 4,
  qualityTarget: 5,
};

const WEIGHT_LABELS: Record<string, { label: string; description: string }> = {
  minDrivers:     { label: "Min. Conducenti",     description: "Priorità alla riduzione del numero totale conducenti" },
  workBalance:    { label: "Bilancio Ore Lavoro",  description: "Quanto uniformare le ore di lavoro tra turni" },
  minCambi:       { label: "Min. Cambi Linea",     description: "Penalizzazione per cambi in linea" },
  preferIntero:   { label: "Preferenza Intero",    description: "Quanto preferire turni intero vs semiunici/spezzati" },
  minSupplementi: { label: "Min. Supplementi",     description: "Riduzione turni supplemento brevi" },
  qualityTarget:  { label: "Target Qualità",       description: "Aderenza al target 6h30-6h42 per turno" },
};

const WEIGHT_COLORS: Record<string, string> = {
  minDrivers: "#3b82f6",
  workBalance: "#22c55e",
  minCambi: "#06b6d4",
  preferIntero: "#f59e0b",
  minSupplementi: "#8b5cf6",
  qualityTarget: "#ef4444",
};

/* ─── Presets ─────────────────────────────────────────────────── */

interface Preset {
  name: string;
  description: string;
  config: Partial<OperatorConfig>;
  builtIn?: boolean;
}

const BUILT_IN_PRESETS: Preset[] = [
  {
    name: "🏎️ Rapido",
    description: "Soluzione veloce, minimo tempo di calcolo",
    builtIn: true,
    config: {
      solverIntensity: 1,
      maxRounds: 1,
      weights: { minDrivers: 8, workBalance: 3, minCambi: 3, preferIntero: 5, minSupplementi: 3, qualityTarget: 3 },
    },
  },
  {
    name: "⚖️ Bilanciato",
    description: "Buon compromesso tra qualità e velocità",
    builtIn: true,
    config: {
      solverIntensity: 2,
      maxRounds: 3,
      weights: { minDrivers: 7, workBalance: 6, minCambi: 5, preferIntero: 6, minSupplementi: 4, qualityTarget: 5 },
    },
  },
  {
    name: "🧠 Aggressivo",
    description: "Massima qualità, tempo di calcolo più lungo",
    builtIn: true,
    config: {
      solverIntensity: 3,
      maxRounds: 5,
      weights: { minDrivers: 9, workBalance: 7, minCambi: 6, preferIntero: 8, minSupplementi: 6, qualityTarget: 7 },
    },
  },
  {
    name: "👷 Minimo Personale",
    description: "Priorità assoluta alla riduzione conducenti",
    builtIn: true,
    config: {
      solverIntensity: 3,
      maxRounds: 5,
      weights: { minDrivers: 10, workBalance: 3, minCambi: 2, preferIntero: 4, minSupplementi: 8, qualityTarget: 3 },
    },
  },
];

const STORAGE_KEY = "transitintel-optimizer-presets";

function loadUserPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveUserPresets(presets: Preset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

/* ─── Radar Chart (pure SVG) ─────────────────────────────────── */

function WeightsRadarChart({ weights }: { weights: Record<string, number> }) {
  const keys = Object.keys(WEIGHT_LABELS);
  const n = keys.length;
  const cx = 80, cy = 80, r = 65;

  const points = useMemo(() => {
    return keys.map((k, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      const val = (weights[k] ?? 5) / 10;
      return {
        x: cx + Math.cos(angle) * r * val,
        y: cy + Math.sin(angle) * r * val,
        lx: cx + Math.cos(angle) * (r + 14),
        ly: cy + Math.sin(angle) * (r + 14),
        color: WEIGHT_COLORS[k],
        label: WEIGHT_LABELS[k]?.label.slice(0, 8) || k,
      };
    });
  }, [weights]);

  const polygon = points.map(p => `${p.x},${p.y}`).join(" ");

  // Grid circles
  const gridLevels = [0.25, 0.5, 0.75, 1.0];

  return (
    <svg viewBox="0 0 160 160" className="w-full max-w-[200px] mx-auto">
      {/* Grid */}
      {gridLevels.map(level => (
        <polygon
          key={level}
          points={keys.map((_, i) => {
            const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
            return `${cx + Math.cos(angle) * r * level},${cy + Math.sin(angle) * r * level}`;
          }).join(" ")}
          fill="none" stroke="hsl(var(--border))" strokeWidth={0.5} opacity={0.3}
        />
      ))}
      {/* Axes */}
      {keys.map((_, i) => {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        return (
          <line key={i}
            x1={cx} y1={cy}
            x2={cx + Math.cos(angle) * r}
            y2={cy + Math.sin(angle) * r}
            stroke="hsl(var(--border))" strokeWidth={0.5} opacity={0.3}
          />
        );
      })}
      {/* Data polygon */}
      <polygon
        points={polygon}
        fill="hsl(var(--primary))" fillOpacity={0.15}
        stroke="hsl(var(--primary))" strokeWidth={1.5}
      />
      {/* Data points */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} fill={p.color} />
      ))}
      {/* Labels */}
      {points.map((p, i) => (
        <text key={`l${i}`} x={p.lx} y={p.ly}
          textAnchor="middle" dominantBaseline="middle"
          fontSize={6} fill="hsl(var(--muted-foreground))"
        >{p.label}</text>
      ))}
    </svg>
  );
}

/* ─── Slider ──────────────────────────────────────────────────── */

function WeightSlider({ id, value, onChange }: { id: string; value: number; onChange: (v: number) => void }) {
  const meta = WEIGHT_LABELS[id];
  const color = WEIGHT_COLORS[id];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium">{meta?.label || id}</label>
        <span className="text-xs font-mono font-bold" style={{ color }}>{value}</span>
      </div>
      {meta && <div className="text-[10px] text-muted-foreground">{meta.description}</div>}
      <input
        type="range" min={0} max={10} step={1} value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{
          background: `linear-gradient(to right, ${color} ${value * 10}%, hsl(var(--muted)) ${value * 10}%)`,
        }}
      />
      <div className="flex justify-between text-[8px] text-muted-foreground/50">
        <span>0</span><span>5</span><span>10</span>
      </div>
    </div>
  );
}

/* ─── Main Panel ──────────────────────────────────────────────── */

interface OperatorConfigPanelProps {
  isOpen: boolean;
  onClose: () => void;
  config: OperatorConfig;
  onChange: (config: OperatorConfig) => void;
}

export function OperatorConfigPanel({ isOpen, onClose, config, onChange }: OperatorConfigPanelProps) {
  const [userPresets, setUserPresets] = useState<Preset[]>(loadUserPresets);
  const [newPresetName, setNewPresetName] = useState("");
  const [showPresets, setShowPresets] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showCosts, setShowCosts] = useState(false);
  const [showGranularity, setShowGranularity] = useState(false);
  const [showBDS, setShowBDS] = useState(false);

  const weights = useMemo(() => ({ ...DEFAULT_WEIGHTS, ...(config.weights || {}) }), [config.weights]);
  const intensity = config.solverIntensity ?? 2;
  const maxRounds = config.maxRounds ?? 5;

  const setWeight = useCallback((key: string, val: number) => {
    onChange({ ...config, weights: { ...weights, [key]: val } });
  }, [config, weights, onChange]);

  const setIntensity = useCallback((val: number) => {
    onChange({ ...config, solverIntensity: val });
  }, [config, onChange]);

  const setMaxRounds = useCallback((val: number) => {
    onChange({ ...config, maxRounds: val });
  }, [config, onChange]);

  const applyPreset = useCallback((preset: Preset) => {
    onChange({ ...config, ...preset.config });
  }, [config, onChange]);

  const savePreset = useCallback(() => {
    if (!newPresetName.trim()) return;
    const preset: Preset = {
      name: newPresetName.trim(),
      description: "Preset personalizzato",
      config: { weights, solverIntensity: intensity, maxRounds },
    };
    const updated = [...userPresets, preset];
    setUserPresets(updated);
    saveUserPresets(updated);
    setNewPresetName("");
  }, [newPresetName, weights, intensity, maxRounds, userPresets]);

  const deletePreset = useCallback((idx: number) => {
    const updated = userPresets.filter((_, i) => i !== idx);
    setUserPresets(updated);
    saveUserPresets(updated);
  }, [userPresets]);

  const resetDefaults = useCallback(() => {
    onChange({
      ...config,
      weights: { ...DEFAULT_WEIGHTS },
      solverIntensity: 2,
      maxRounds: 5,
      taskGranularity: "auto",
      enableCrossCluster: true,
      enableTaxiFallback: true,
      cutOnlyAtClusters: true,
      costRates: undefined,
    });
  }, [config, onChange]);

  const allPresets = [...BUILT_IN_PRESETS, ...userPresets];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={onClose}
          />
          {/* Drawer */}
          <motion.div
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed right-0 top-0 h-full w-[380px] max-w-[90vw] bg-card border-l border-border z-50 overflow-y-auto"
          >
            <div className="p-4 space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold flex items-center gap-2">
                  <Settings className="w-4 h-4 text-primary" />
                  Configurazione Solver
                </h2>
                <button onClick={onClose} className="p-1 rounded hover:bg-muted/30">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Presets */}
              <div>
                <button onClick={() => setShowPresets(!showPresets)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground mb-2">
                  {showPresets ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <Bookmark className="w-3 h-3" /> Preset
                </button>
                <AnimatePresence>
                  {showPresets && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-1 overflow-hidden">
                      {allPresets.map((p, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <button
                            onClick={() => applyPreset(p)}
                            className="flex-1 text-left text-xs px-2 py-1.5 rounded-lg bg-muted/20 hover:bg-muted/40 transition-colors"
                          >
                            <div className="font-medium">{p.name}</div>
                            <div className="text-[10px] text-muted-foreground">{p.description}</div>
                          </button>
                          {!p.builtIn && (
                            <button onClick={() => deletePreset(i - BUILT_IN_PRESETS.length)}
                              className="p-1 text-red-400 hover:text-red-300">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                      {/* Save new */}
                      <div className="flex items-center gap-1 mt-2">
                        <input
                          value={newPresetName} onChange={e => setNewPresetName(e.target.value)}
                          placeholder="Nome nuovo preset..."
                          className="flex-1 text-xs bg-background border border-border/50 rounded px-2 py-1"
                          onKeyDown={e => e.key === "Enter" && savePreset()}
                        />
                        <button onClick={savePreset} disabled={!newPresetName.trim()}
                          className="p-1 text-primary hover:text-primary/80 disabled:opacity-30">
                          <Save className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Solver Intensity */}
              <div className="space-y-2">
                <h3 className="text-xs font-semibold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-amber-400" /> Intensità Solver (portfolio multi-scenario)
                </h3>
                <div className="grid grid-cols-4 gap-1">
                  {([1, 2, 3, 4] as const).map(v => (
                    <button key={v} onClick={() => setIntensity(v)}
                      className={`px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        intensity === v ? "bg-orange-600 text-white" : "bg-muted/20 hover:bg-muted/40"
                      }`}>
                      {v === 1 ? "⚡ Rapido" : v === 2 ? "⚖️ Standard" : v === 3 ? "🧠 Aggressivo" : "🔥 Estremo"}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {intensity === 1 ? "14 scenari · ~90s · ricerca veloce" :
                   intensity === 2 ? "24 scenari · ~4min · buon compromesso (consigliato)" :
                   intensity === 3 ? "36 scenari · ~8min · linearizzazione + simmetria" :
                   "48 scenari · ~15min · esplora ogni combinazione possibile"}
                </div>
              </div>

              {/* Max Rounds */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium">Round massimi</label>
                  <span className="text-xs font-mono font-bold text-primary">{maxRounds}</span>
                </div>
                <input
                  type="range" min={1} max={10} step={1} value={maxRounds}
                  onChange={e => setMaxRounds(parseInt(e.target.value))}
                  className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, hsl(var(--primary)) ${maxRounds * 10}%, hsl(var(--muted)) ${maxRounds * 10}%)`,
                  }}
                />
              </div>

              {/* Radar Chart */}
              <div>
                <h3 className="text-xs font-semibold mb-2">Profilo Pesi</h3>
                <WeightsRadarChart weights={weights} />
              </div>

              {/* Weight Sliders */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold">Pesi Obiettivo</h3>
                {Object.keys(WEIGHT_LABELS).map(k => (
                  <WeightSlider key={k} id={k} value={weights[k] ?? 5} onChange={v => setWeight(k, v)} />
                ))}
              </div>

              {/* Shift Rules Override */}
              <div>
                <button onClick={() => setShowRules(!showRules)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground mb-2">
                  {showRules ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <Shield className="w-3 h-3" /> Override Regole Turno
                </button>
                <AnimatePresence>
                  {showRules && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
                      <div className="text-[10px] text-muted-foreground mb-1">
                        Modifica i limiti CCNL (solo se autorizzato dall'azienda)
                      </div>
                      {/* Semiunico % */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] w-32">Semiunici max %</label>
                        <input type="number" min={0} max={50}
                          value={config.shiftRules?.semiunico?.maxPct ?? 12}
                          onChange={e => onChange({
                            ...config,
                            shiftRules: {
                              ...config.shiftRules,
                              semiunico: { ...(config.shiftRules?.semiunico || {}), maxPct: parseInt(e.target.value) || 12 }
                            }
                          })}
                          className="w-16 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                        />
                      </div>
                      {/* Spezzato % */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] w-32">Spezzati max %</label>
                        <input type="number" min={0} max={50}
                          value={config.shiftRules?.spezzato?.maxPct ?? 13}
                          onChange={e => onChange({
                            ...config,
                            shiftRules: {
                              ...config.shiftRules,
                              spezzato: { ...(config.shiftRules?.spezzato || {}), maxPct: parseInt(e.target.value) || 13 }
                            }
                          })}
                          className="w-16 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                        />
                      </div>
                      {/* Max cambi per turno */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] w-32">Max cambi/turno</label>
                        <input type="number" min={0} max={10}
                          value={config.pinnedConstraints?.maxCambiPerTurno ?? ""}
                          placeholder="∞"
                          onChange={e => onChange({
                            ...config,
                            pinnedConstraints: {
                              ...config.pinnedConstraints,
                              maxCambiPerTurno: e.target.value ? parseInt(e.target.value) : null,
                            }
                          })}
                          className="w-16 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Granularità Task */}
              <div>
                <button onClick={() => setShowGranularity(!showGranularity)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground mb-2">
                  {showGranularity ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <Layers className="w-3 h-3" /> Granularità Task & Trasferimenti
                </button>
                <AnimatePresence>
                  {showGranularity && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-3 overflow-hidden">
                      <div className="text-[10px] text-muted-foreground mb-1">
                        Controlla come i turni macchina vengono suddivisi in task e come vengono gestiti i trasferimenti tra cluster.
                      </div>
                      {/* Task Granularity */}
                      <div className="space-y-1">
                        <label className="text-xs font-medium">Granularità task</label>
                        <div className="grid grid-cols-4 gap-1">
                          {(["auto", "fine", "medium", "coarse"] as const).map(g => (
                            <button key={g} onClick={() => onChange({ ...config, taskGranularity: g })}
                              className={`px-1.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${
                                (config.taskGranularity ?? "auto") === g
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-muted/20 hover:bg-muted/40"
                              }`}>
                              {g === "auto" ? "🔄 Auto" : g === "fine" ? "🔬 Fine" : g === "medium" ? "📐 Media" : "📦 Grossa"}
                            </button>
                          ))}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {(config.taskGranularity ?? "auto") === "auto"
                            ? "Multi-livello: genera tutti i livelli e lascia al solver scegliere"
                            : (config.taskGranularity ?? "auto") === "fine"
                            ? "Taglia ad ogni gap ≥5 min tra cluster"
                            : (config.taskGranularity ?? "auto") === "medium"
                            ? "Taglia solo a gap ≥15 min tra cluster"
                            : "Nessun taglio: un task = un turno macchina"}
                        </div>
                      </div>
                      {/* Cross-cluster */}
                      <div className="flex items-center gap-2">
                        <input type="checkbox"
                          checked={config.enableCrossCluster !== false}
                          onChange={e => onChange({ ...config, enableCrossCluster: e.target.checked })}
                          className="rounded border-border"
                        />
                        <div>
                          <label className="text-xs font-medium flex items-center gap-1">
                            <Route className="w-3 h-3" /> Trasferimenti cross-cluster
                          </label>
                          <div className="text-[10px] text-muted-foreground">
                            Consenti ai conducenti di spostarsi tra cluster diversi (con auto aziendale o a piedi)
                          </div>
                        </div>
                      </div>
                      {/* Taxi fallback */}
                      <div className="flex items-center gap-2">
                        <input type="checkbox"
                          checked={config.enableTaxiFallback !== false}
                          onChange={e => onChange({ ...config, enableTaxiFallback: e.target.checked })}
                          className="rounded border-border"
                        />
                        <div>
                          <label className="text-xs font-medium flex items-center gap-1">
                            <Car className="w-3 h-3" /> Taxi fallback
                          </label>
                          <div className="text-[10px] text-muted-foreground">
                            Permetti trasferimento taxi come ultima opzione (costo elevato)
                          </div>
                        </div>
                      </div>
                      {/* Cut only at clusters */}
                      <div className="flex items-center gap-2">
                        <input type="checkbox"
                          checked={config.cutOnlyAtClusters !== false}
                          onChange={e => onChange({ ...config, cutOnlyAtClusters: e.target.checked })}
                          className="rounded border-border"
                        />
                        <div>
                          <label className="text-xs font-medium flex items-center gap-1">
                            <Shield className="w-3 h-3" /> Cambi solo su cluster definiti
                          </label>
                          <div className="text-[10px] text-muted-foreground">
                            I cambi conducente possono avvenire solo ai 6 cluster definiti (Ugo Bassi, Stazione, Cavour, 4 Novembre, Tavernelle, Torrette)
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Modello Costi */}
              <div>
                <button onClick={() => setShowCosts(!showCosts)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground mb-2">
                  {showCosts ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <DollarSign className="w-3 h-3" /> Modello Costi (EUR)
                </button>
                <AnimatePresence>
                  {showCosts && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-2 overflow-hidden">
                      <div className="text-[10px] text-muted-foreground mb-1">
                        Parametri economici per l'ottimizzazione basata su costo. L'obiettivo è minimizzare il costo giornaliero totale.
                      </div>
                      {([
                        { key: "hourlyRate", label: "Tariffa oraria (€/h)", default: 22, step: 0.5, min: 10, max: 50 },
                        { key: "overtimeMultiplier", label: "Moltiplicatore straordinario", default: 1.30, step: 0.05, min: 1.0, max: 2.0 },
                        { key: "undertimeDeduction", label: "Deduzione sotto-orario (€/h)", default: 5, step: 0.5, min: 0, max: 20 },
                        { key: "drivingPremium", label: "Premio guida (€/h)", default: 2, step: 0.5, min: 0, max: 10 },
                        { key: "idlePenalty", label: "Penale inattività (€/h)", default: 3, step: 0.5, min: 0, max: 15 },
                        { key: "companyCar", label: "Auto aziendale (€/uso)", default: 8, step: 1, min: 0, max: 30 },
                        { key: "taxiTransfer", label: "Trasferimento taxi (€)", default: 25, step: 1, min: 0, max: 80 },
                        { key: "cambioOverhead", label: "Overhead cambio linea (€)", default: 5, step: 0.5, min: 0, max: 20 },
                        { key: "extraDriverDaily", label: "Autista extra giorn. (€)", default: 180, step: 5, min: 100, max: 300 },
                        { key: "supplementoFixed", label: "Supplemento fisso (€)", default: 18, step: 1, min: 0, max: 50 },
                        { key: "companyCars", label: "Autovetture aziendali (n.)", default: 5, step: 1, min: 0, max: 15 },
                      ] as const).map(({ key, label, default: def, step, min, max }) => (
                        <div key={key} className="flex items-center gap-2">
                          <label className="text-[10px] flex-1 min-w-0">{label}</label>
                          <input type="number" min={min} max={max} step={step}
                            value={(config.costRates as any)?.[key] ?? def}
                            onChange={e => onChange({
                              ...config,
                              costRates: {
                                ...config.costRates,
                                [key]: parseFloat(e.target.value) || def,
                              }
                            })}
                            className="w-20 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-right"
                          />
                        </div>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* ═══ NORMATIVA BDS ═══ */}
              <div>
                <button onClick={() => setShowBDS(!showBDS)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground mb-2">
                  {showBDS ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <AlertTriangle className="w-3 h-3" /> Normativa BDS (CCNL / CE 561)
                </button>
                <AnimatePresence>
                  {showBDS && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="space-y-4 overflow-hidden">
                      <div className="text-[10px] text-muted-foreground mb-1">
                        Parametri normativi ispirati a MAIOR BDS v4. Modifica solo se autorizzato.
                      </div>

                      {/* Pre/Post Turno */}
                      <div className="space-y-2">
                        <h4 className="text-[11px] font-semibold flex items-center gap-1">
                          <Clock className="w-3 h-3 text-blue-400" /> Tempi Pre/Post (min)
                        </h4>
                        {([
                          { key: "preTurnoDeposito", label: "Pre-turno deposito", default: 12 },
                          { key: "preTurnoCambio", label: "Pre-turno cambio", default: 5 },
                          { key: "postTurnoDeposito", label: "Post-turno deposito", default: 8 },
                          { key: "postTurnoCambio", label: "Post-turno cambio", default: 3 },
                          { key: "preRipresa", label: "Pre-ripresa", default: 5 },
                          { key: "postRipresa", label: "Post-ripresa", default: 3 },
                          { key: "prePezzoCambio", label: "Pre-pezzo cambio", default: 3 },
                          { key: "postPezzoCambio", label: "Post-pezzo cambio", default: 2 },
                        ] as const).map(({ key, label, default: def }) => (
                          <div key={key} className="flex items-center gap-2">
                            <label className="text-[10px] flex-1 min-w-0">{label}</label>
                            <input type="number" min={0} max={30} step={1}
                              value={(config as any).bds?.prePost?.[key] ?? def}
                              onChange={e => onChange({
                                ...config,
                                bds: {
                                  ...(config as any).bds,
                                  prePost: {
                                    ...((config as any).bds?.prePost || {}),
                                    [key]: parseInt(e.target.value) || def,
                                  }
                                }
                              })}
                              className="w-14 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                            />
                          </div>
                        ))}
                      </div>

                      {/* CE 561/2006 */}
                      <div className="space-y-2">
                        <h4 className="text-[11px] font-semibold flex items-center gap-1">
                          <Shield className="w-3 h-3 text-red-400" /> CE 561/2006
                        </h4>
                        <div className="flex items-center gap-2">
                          <input type="checkbox"
                            checked={(config as any).bds?.cee561?.attivo !== false}
                            onChange={e => onChange({
                              ...config,
                              bds: {
                                ...(config as any).bds,
                                cee561: {
                                  ...((config as any).bds?.cee561 || {}),
                                  attivo: e.target.checked,
                                }
                              }
                            })}
                            className="rounded border-border"
                          />
                          <label className="text-[10px]">Vincolo guida continuativa attivo</label>
                        </div>
                        {([
                          { key: "maxPeriodoContinuativo", label: "Max guida continua (min)", default: 270 },
                          { key: "sostaCheSpezza", label: "Pausa completa (min)", default: 45 },
                          { key: "minSosta", label: "Pausa minima fraz. (min)", default: 15 },
                        ] as const).map(({ key, label, default: def }) => (
                          <div key={key} className="flex items-center gap-2">
                            <label className="text-[10px] flex-1 min-w-0">{label}</label>
                            <input type="number" min={0} max={600} step={5}
                              value={(config as any).bds?.cee561?.[key] ?? def}
                              onChange={e => onChange({
                                ...config,
                                bds: {
                                  ...(config as any).bds,
                                  cee561: {
                                    ...((config as any).bds?.cee561 || {}),
                                    [key]: parseInt(e.target.value) || def,
                                  }
                                }
                              })}
                              className="w-14 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                            />
                          </div>
                        ))}
                      </div>

                      {/* Intervallo Pasto */}
                      <div className="space-y-2">
                        <h4 className="text-[11px] font-semibold flex items-center gap-1">
                          <Coffee className="w-3 h-3 text-amber-400" /> Intervallo Pasto
                        </h4>
                        <div className="flex items-center gap-2">
                          <input type="checkbox"
                            checked={(config as any).bds?.pasto?.attivo !== false}
                            onChange={e => onChange({
                              ...config,
                              bds: {
                                ...(config as any).bds,
                                pasto: {
                                  ...((config as any).bds?.pasto || {}),
                                  attivo: e.target.checked,
                                }
                              }
                            })}
                            className="rounded border-border"
                          />
                          <label className="text-[10px]">Vincolo pasto attivo</label>
                        </div>
                        {([
                          { key: "pranzoSostaMinima", label: "Pranzo: sosta min. (min)", default: 30 },
                          { key: "cenaSostaMinima", label: "Cena: sosta min. (min)", default: 30 },
                        ] as const).map(({ key, label, default: def }) => (
                          <div key={key} className="flex items-center gap-2">
                            <label className="text-[10px] flex-1 min-w-0">{label}</label>
                            <input type="number" min={0} max={120} step={5}
                              value={(config as any).bds?.pasto?.[key] ?? def}
                              onChange={e => onChange({
                                ...config,
                                bds: {
                                  ...(config as any).bds,
                                  pasto: {
                                    ...((config as any).bds?.pasto || {}),
                                    [key]: parseInt(e.target.value) || def,
                                  }
                                }
                              })}
                              className="w-14 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                            />
                          </div>
                        ))}
                      </div>

                      {/* Gestore Riprese */}
                      <div className="space-y-2">
                        <h4 className="text-[11px] font-semibold flex items-center gap-1">
                          <Layers className="w-3 h-3 text-green-400" /> Gestore Riprese
                        </h4>
                        {([
                          { key: "sostaCheSpezza", label: "Sosta che spezza (min)", default: 75 },
                          { key: "maxRiprese", label: "Max riprese", default: 2 },
                          { key: "maxDurataRipresa", label: "Max durata ripresa (min)", default: 480 },
                          { key: "maxGuidaPerRipresa", label: "Max guida/ripresa (min)", default: 270 },
                        ] as const).map(({ key, label, default: def }) => (
                          <div key={key} className="flex items-center gap-2">
                            <label className="text-[10px] flex-1 min-w-0">{label}</label>
                            <input type="number" min={0} max={600} step={5}
                              value={(config as any).bds?.riprese?.[key] ?? def}
                              onChange={e => onChange({
                                ...config,
                                bds: {
                                  ...(config as any).bds,
                                  riprese: {
                                    ...((config as any).bds?.riprese || {}),
                                    [key]: parseInt(e.target.value) || def,
                                  }
                                }
                              })}
                              className="w-14 text-xs bg-background border border-border/50 rounded px-2 py-0.5 text-center"
                            />
                          </div>
                        ))}
                      </div>

                      {/* ─── LIMITI TURNI GUIDA (RD 131/1938 — modificabili) ─── */}
                      <div className="space-y-3 pt-2 border-t border-orange-500/20">
                        <h4 className="text-[11px] font-semibold flex items-center gap-1">
                          <Clock className="w-3 h-3 text-orange-400" /> Limiti Turni Guida (RD 131/1938)
                        </h4>
                        <p className="text-[10px] text-muted-foreground -mt-1">
                          Massimali di nastro e lavoro per ogni tipo di turno (in minuti). Modifica per sperimentare scenari alternativi.
                        </p>
                        {([
                          { type: "intero",      label: "Intero",       defaults: { maxNastro: 435, maxLavoro: 435 } },
                          { type: "semiunico",   label: "Semiunico",    defaults: { maxNastro: 555, maxLavoro: 480, intMin: 75, intMax: 179 } },
                          { type: "spezzato",    label: "Spezzato",     defaults: { maxNastro: 630, maxLavoro: 450, intMin: 180, intMax: 999 } },
                          { type: "supplemento", label: "Supplemento",  defaults: { maxNastro: 150, maxLavoro: 150 } },
                        ] as const).map(({ type, label, defaults }) => (
                          <div key={type} className="bg-background/30 rounded p-2 border border-border/20">
                            <div className="text-[10px] font-semibold text-orange-300 mb-1.5">{label}</div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {(Object.keys(defaults) as Array<keyof typeof defaults>).map((k) => (
                                <div key={k} className="flex items-center gap-1">
                                  <label className="text-[9px] flex-1 min-w-0 text-muted-foreground uppercase tracking-wider">{k}</label>
                                  <input type="number" min={0} max={1000} step={5}
                                    value={(config as any).bds?.shiftRules?.[type]?.[k] ?? defaults[k]}
                                    onChange={e => onChange({
                                      ...config,
                                      bds: {
                                        ...(config as any).bds,
                                        shiftRules: {
                                          ...((config as any).bds?.shiftRules || {}),
                                          [type]: {
                                            ...((config as any).bds?.shiftRules?.[type] || {}),
                                            [k]: parseInt(e.target.value) || defaults[k],
                                          },
                                        },
                                      },
                                    })}
                                    className="w-14 text-[10px] bg-background border border-border/50 rounded px-1.5 py-0.5 text-center"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                        {/* Target lavoro */}
                        <div className="bg-background/30 rounded p-2 border border-border/20">
                          <div className="text-[10px] font-semibold text-orange-300 mb-1.5">Target lavoro giornaliero (min)</div>
                          <div className="grid grid-cols-3 gap-1.5">
                            {([
                              { key: "low" as const, label: "Min", default: 390 },
                              { key: "mid" as const, label: "Mid", default: 408 },
                              { key: "high" as const, label: "Max", default: 435 },
                            ]).map(({ key, label, default: def }) => (
                              <div key={key} className="flex items-center gap-1">
                                <label className="text-[9px] flex-1 min-w-0 text-muted-foreground uppercase">{label}</label>
                                <input type="number" min={0} max={1000} step={5}
                                  value={(config as any).bds?.targetWork?.[key] ?? def}
                                  onChange={e => onChange({
                                    ...config,
                                    bds: {
                                      ...(config as any).bds,
                                      targetWork: {
                                        ...((config as any).bds?.targetWork || {}),
                                        [key]: parseInt(e.target.value) || def,
                                      },
                                    },
                                  })}
                                  className="w-14 text-[10px] bg-background border border-border/50 rounded px-1.5 py-0.5 text-center"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Reset button */}
              <button onClick={resetDefaults}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
                  bg-muted/20 hover:bg-muted/40 transition-colors text-muted-foreground">
                <RotateCcw className="w-3.5 h-3.5" /> Ripristina Valori Default
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
