import React from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { Map, Activity, MapPin, BarChart3, Menu, X, LayoutDashboard, FileArchive, Bus, RefreshCw, Timer, PanelLeftClose, PanelLeftOpen, Users, Route, ArrowRightLeft, ClipboardList, Clock, Grip } from "lucide-react";
import { Button } from "@/components/ui/button";
import logoImg from "/logo.png";

interface NavSection {
  title: string;
  items: { href: string; label: string; icon: any }[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Mappa & Panoramica",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/traffic", label: "Traffico", icon: Activity },
      { href: "/territory", label: "Territorio", icon: Map },
    ],
  },
  {
    title: "Analisi",
    items: [
      { href: "/routes", label: "Analisi Linee", icon: Bus },
      { href: "/travel-time", label: "Tempi Percorso", icon: Timer },
      { href: "/stops", label: "Fermate & Linee", icon: MapPin },
      { href: "/demand", label: "Qualità Servizio", icon: BarChart3 },
      { href: "/segments", label: "Segmenti Utenza", icon: Users },
      { href: "/scenarios", label: "Scenari", icon: Route },
      { href: "/intermodal", label: "Intermodale", icon: ArrowRightLeft },
      { href: "/optimizer-route", label: "Programma Esercizio", icon: ClipboardList },
      { href: "/optimizer-schedule", label: "Ottim. Orari", icon: Clock },
      { href: "/cluster-management", label: "Cluster Cambio", icon: Grip },
    ],
  },
  {
    title: "Gestione Dati",
    items: [
      { href: "/gtfs", label: "Importa GTFS", icon: FileArchive },
      { href: "/sync", label: "Sincronizza Dati", icon: RefreshCw },
    ],
  },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  const Background = () => (
    <div className="fixed inset-0 z-[-1] pointer-events-none">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
    </div>
  );

  return (
    <div className="flex h-screen w-full overflow-hidden text-foreground selection:bg-primary/30">
      <Background />

      {/* Mobile Header */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-background/90 backdrop-blur-md border-b border-border/50 z-50 flex items-center justify-between px-4">
        <div className="flex items-center">
          <img src={logoImg} alt="TransitIntel" className="h-6 w-auto" />
        </div>
        <Button variant="ghost" size="icon" onClick={() => setIsMobileOpen(!isMobileOpen)}>
          {isMobileOpen ? <X /> : <Menu />}
        </Button>
      </div>

      {/* Mobile overlay backdrop */}
      {isMobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-30 backdrop-blur-sm"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* Sidebar — CSS-only transform, no framer-motion x conflict */}
      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-40 shrink-0
          bg-card/50 backdrop-blur-2xl border-r border-border/50
          flex flex-col h-full
          transition-all duration-300 ease-in-out
          ${collapsed ? "w-16" : "w-64"}
          ${isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        {/* Logo + collapse toggle */}
        <div className="px-3 py-4 border-b border-border/30 flex items-center justify-between gap-2">
          {!collapsed && <img src={logoImg} alt="TransitIntel" className="h-8 w-auto" />}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
            title={collapsed ? "Espandi sidebar" : "Comprimi sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-4 overflow-y-auto">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="space-y-0.5">
              {!collapsed && (
                <p className="px-3 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {section.title}
                </p>
              )}
              {section.items.map((item) => {
                const isActive = location === item.href;
                return (
                  <Link key={item.href} href={item.href}>
                    <div
                      onClick={() => setIsMobileOpen(false)}
                      title={collapsed ? item.label : undefined}
                      className={`
                        flex items-center gap-3 rounded-lg cursor-pointer
                        transition-all duration-150 group relative text-sm
                        ${collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"}
                        ${isActive
                          ? "bg-primary/15 text-primary font-medium"
                          : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                        }
                      `}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="active-nav"
                          className="absolute left-0 w-0.5 h-6 bg-primary rounded-r-full"
                          initial={false}
                          transition={{ type: "spring", stiffness: 350, damping: 35 }}
                        />
                      )}
                      <item.icon className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : "group-hover:text-foreground transition-colors"}`} />
                      {!collapsed && item.label}
                    </div>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {!collapsed && (
          <div className="p-4 mt-auto border-t border-border/30">
            <div className="bg-gradient-to-br from-primary/10 to-accent/10 rounded-xl p-4 border border-primary/20">
              <h4 className="font-semibold text-xs mb-0.5 text-primary">Ancona / Marche</h4>
              <p className="text-[11px] text-muted-foreground">Sistema attivo</p>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 relative flex flex-col h-full overflow-hidden pt-14 md:pt-0">
        <div className={`flex-1 w-full h-full ${location !== "/dashboard" && location !== "/scenarios" ? "overflow-y-auto p-4 md:p-8" : ""}`}>
          <motion.div
            key={location}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="h-full"
          >
            {children}
          </motion.div>
        </div>
      </main>
    </div>
  );
}
