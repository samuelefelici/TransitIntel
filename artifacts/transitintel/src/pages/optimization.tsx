import React, { lazy, Suspense, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Truck, ClipboardList, Clock, Grip } from "lucide-react";

// Lazy-load each heavy sub-page
const OptimizerRouteContent = lazy(() => import("@/pages/optimizer-route"));
const OptimizerScheduleContent = lazy(() => import("@/pages/optimizer-schedule"));
const ClusterManagementContent = lazy(() => import("@/pages/cluster-management"));

type Tab = "programma" | "orari" | "cluster";

const TABS: { id: Tab; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "programma", label: "Programma Esercizio", icon: <ClipboardList className="w-3.5 h-3.5" />, desc: "Veicoli e corse" },
  { id: "orari",     label: "Ottimizzazione Orari", icon: <Clock className="w-3.5 h-3.5" />, desc: "Euristiche & CP-SAT" },
  { id: "cluster",   label: "Gestione Cluster",     icon: <Grip className="w-3.5 h-3.5" />, desc: "Cambio in linea" },
];

function TabSpinner() {
  return (
    <div className="flex items-center justify-center h-[60vh] gap-3 text-muted-foreground">
      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      <p className="text-sm">Caricamento modulo…</p>
    </div>
  );
}

export default function OptimizationPage() {
  const [tab, setTab] = useState<Tab>("programma");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header + Tab bar */}
      <div className="px-4 pt-3 pb-0 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <Truck className="w-4 h-4 text-primary" />
          <h1 className="text-base font-display font-bold">Ottimizzazione Servizio</h1>
          <span className="text-[10px] text-muted-foreground ml-1">· programma esercizio · orari · cluster</span>
        </div>

        <div className="flex gap-1 pb-1.5 flex-wrap">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border transition-all ${
                tab === t.id
                  ? "bg-primary/10 border-primary/30 text-primary font-medium"
                  : "border-border/30 text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
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
              {tab === "programma" && <OptimizerRouteContent />}
              {tab === "orari" && <OptimizerScheduleContent />}
              {tab === "cluster" && <ClusterManagementContent />}
            </Suspense>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
