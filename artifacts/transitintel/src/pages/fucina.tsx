/**
 * Fucina — The Optimization Workspace
 *
 * "La Fucina" (The Forge) — an immersive workspace for forging
 * optimal vehicle and crew schedules. Feels like a separate app
 * inside Cerbero.
 */
import React, { lazy, Suspense, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Flame, ClipboardList, Clock, Grip, Anvil, Zap,
} from "lucide-react";

const VehicleWorkspace = lazy(() => import("@/pages/fucina/vehicle-workspace"));
const OptimizerScheduleContent = lazy(() => import("@/pages/optimizer-schedule/components").then(m => ({ default: () => null })));
const ClusterManagementContent = lazy(() => import("@/pages/cluster-management"));

type Tab = "turni-macchina" | "orari" | "cluster";

const TABS: { id: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "turni-macchina", label: "Turni Macchina", icon: <ClipboardList className="w-3.5 h-3.5" />, desc: "Workspace interattivo veicoli" },
  { id: "orari",          label: "Ottimizzazione Orari", icon: <Clock className="w-3.5 h-3.5" />, desc: "Euristiche & CP-SAT" },
  { id: "cluster",        label: "Gestione Cluster", icon: <Grip className="w-3.5 h-3.5" />, desc: "Cambio in linea" },
];

function TabSpinner() {
  return (
    <div className="flex items-center justify-center h-[60vh] gap-3 text-muted-foreground">
      <div className="w-5 h-5 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
      <p className="text-sm">Caricamento modulo…</p>
    </div>
  );
}

export default function FucinaPage() {
  const [tab, setTab] = useState<Tab>("turni-macchina");
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Fucina branded header ── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="px-4 pt-3 pb-0 border-b border-orange-500/20 shrink-0 bg-gradient-to-r from-orange-500/5 via-transparent to-amber-500/5"
      >
        {/* Title bar */}
        <div className="flex items-center gap-3 mb-2">
          <div className="relative">
            <Flame className="w-5 h-5 text-orange-400" />
            <div className="absolute inset-0 blur-md bg-orange-400/30 rounded-full pointer-events-none" />
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-display font-bold bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent">
              Fucina
            </h1>
            <span className="text-[10px] text-muted-foreground">
              Workspace Ottimizzazione
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-amber-400/60" />
            <span className="text-[9px] text-muted-foreground/60 font-mono">
              engine v2 · CP-SAT
            </span>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 pb-1.5 flex-wrap">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border transition-all ${
                tab === t.id
                  ? "bg-orange-500/10 border-orange-500/30 text-orange-400 font-medium"
                  : "border-border/30 text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {t.icon}
              <span>{t.label}</span>
              <span className="text-[9px] text-muted-foreground/60 hidden sm:inline">· {t.desc}</span>
            </button>
          ))}
        </div>
      </motion.div>

      {/* ── Content area ── */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="h-full"
          >
            <Suspense fallback={<TabSpinner />}>
              {tab === "turni-macchina" && <VehicleWorkspace />}
              {tab === "orari" && <ClusterManagementContent />}
              {tab === "cluster" && <ClusterManagementContent />}
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
