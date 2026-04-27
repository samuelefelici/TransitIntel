/**
 * ClusterPage — Gestione Cluster di Cambio in Linea
 *
 * Pagina standalone nella zona Scheduling Engine.
 * Wrappa ClusterManagementContent con header coerente col tema fuoco.
 */
import React, { Suspense, lazy } from "react";
import { motion } from "framer-motion";
import { Grip, Loader2, Zap } from "lucide-react";

const ClusterManagementContent = lazy(() => import("@/pages/cluster-management"));

function Spinner() {
  return (
    <div className="flex items-center justify-center h-[60vh] gap-3 text-muted-foreground">
      <Loader2 className="w-5 h-5 animate-spin text-orange-400" />
      <span className="text-sm">Caricamento Gestione Cluster…</span>
    </div>
  );
}

export default function ClusterPage() {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="px-4 pt-3 pb-2.5 border-b border-orange-500/15 shrink-0 bg-gradient-to-r from-orange-950/20 via-transparent to-transparent"
      >
        <div className="flex items-center gap-3">
          <div className="relative">
            <Grip className="w-4 h-4 text-orange-400" />
            <div className="absolute inset-0 blur-sm bg-orange-400/20 rounded pointer-events-none" />
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-sm font-bold bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent">
              Gestione Cluster
            </h1>
            <span className="text-[10px] text-muted-foreground">Cambio in linea · poligoni fermate</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Zap className="w-3 h-3 text-amber-400/40" />
            <span className="text-[9px] text-muted-foreground/40 font-mono hidden sm:inline">indipendente dallo scheduling</span>
          </div>
        </div>
      </motion.div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<Spinner />}>
          <ClusterManagementContent />
        </Suspense>
      </div>
    </div>
  );
}
