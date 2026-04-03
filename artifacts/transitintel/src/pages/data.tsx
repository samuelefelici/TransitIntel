import React, { useState, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Database, FileArchive, RefreshCw } from "lucide-react";

// Lazy-load each sub-page to preserve code-splitting
const GtfsContent = lazy(() => import("@/pages/gtfs"));
const SyncContent = lazy(() => import("@/pages/sync"));

type Tab = "gtfs" | "sync";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "gtfs", label: "Importa GTFS", icon: <FileArchive className="w-3.5 h-3.5" /> },
  { id: "sync", label: "Sincronizza Dati", icon: <RefreshCw className="w-3.5 h-3.5" /> },
];

function TabLoader() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}

export default function DataPage() {
  const [tab, setTab] = useState<Tab>("gtfs");

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-8">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 rounded-xl bg-primary/10 border border-primary/20">
            <Database className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dati & GTFS</h1>
            <p className="text-sm text-muted-foreground">
              Importa feed GTFS e sincronizza sorgenti dati esterne
            </p>
          </div>
        </div>
      </motion.div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-xl bg-muted/30 border border-border/30 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`
              relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium
              transition-all duration-200
              ${tab === t.id
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }
            `}
          >
            {tab === t.id && (
              <motion.div
                layoutId="data-tab-bg"
                className="absolute inset-0 bg-background/80 border border-border/50 rounded-lg shadow-sm"
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              {t.icon}
              {t.label}
            </span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }}
        >
          <Suspense fallback={<TabLoader />}>
            {tab === "gtfs" && <GtfsContent />}
            {tab === "sync" && <SyncContent />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
