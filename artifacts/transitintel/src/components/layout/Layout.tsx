import React from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Map, Activity, MapPin, BarChart3, Menu, X, LayoutDashboard, Database, Bus,
  Timer, PanelLeftClose, PanelLeftOpen, Users, Route, ArrowRightLeft,
  Zap, ChevronDown, Truck, LogOut, Network, Ticket, MapPinCheck,
  Flame, BookOpen, Gamepad2, ChevronLeft, ClipboardList, Clock, Grip, Anvil,
  Layers, Building2, Trash2, RefreshCw, FolderOpen, Coins, Wallet, Receipt, Navigation,
  Milestone, Radio, Printer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, type Permission } from "@/hooks/use-auth";
import { getApiBase } from "@/lib/api";
import CopilotSidebar from "@/components/CopilotSidebar";
import logoImg from "/logo.png";
import logoSidebarImg from "/logosidebar.png";

interface NavItem { href: string; label: string; icon: any; }
interface NavSection {
  title: string;
  icon?: any;            // section-level icon (shown when collapsed & for expandable groups)
  collapsible?: boolean; // if true, items are behind a toggle
  permission?: Permission; // se presente, sezione visibile solo con questo permesso (admin sempre)
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Panoramica",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/operations", label: "Sala Operativa", icon: Radio },
      { href: "/traffic", label: "Traffico & Rete", icon: Activity },
      { href: "/territory", label: "Territorio & Domanda", icon: Map },
    ],
  },
  {
    title: "Network Engine",
    permission: "network",
    items: [
      { href: "/network-engine", label: "Network Engine", icon: Network },
    ],
  },
  {
    title: "Ottimizzazione Servizio",
    permission: "scheduling",
    items: [
      { href: "/fucina", label: "Scheduling Engine", icon: Flame },
      { href: "/roster", label: "Roster Personale", icon: Users },
      { href: "/service-db", label: "Database di Esercizio", icon: Database },
    ],
  },
  {
    title: "Bigliettazione Elettronica",
    permission: "fares",
    items: [
      { href: "/fares-engine", label: "Fares Engine", icon: Wallet },
    ],
  },
  {
    title: "Analisi Rete",
    permission: "analytics",
    items: [
      { href: "/network", label: "Linee & Fermate", icon: Network },
      { href: "/timetables", label: "Stampa Orari", icon: Printer },
    ],
  },
  {
    title: "Gestione Dati",
    items: [
      { href: "/data", label: "Dati & GTFS", icon: Database },
    ],
  },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const { logout, user, isAdmin, hasPermission } = useAuth();

  // Filtra le voci di Panoramica per i permessi (analytics)
  // e nasconde sezioni intere se non si ha il permesso richiesto.
  const visibleSections = React.useMemo(() => {
    return NAV_SECTIONS
      .filter(s => !s.permission || hasPermission(s.permission))
      .map(s => {
        if (s.title === "Panoramica") {
          return {
            ...s,
            items: s.items.filter(i => {
              if (i.href === "/traffic" || i.href === "/territory" || i.href === "/operations") return hasPermission("analytics");
              return true;
            }),
          };
        }
        return s;
      })
      .filter(s => s.items.length > 0);
  }, [hasPermission]);

  const isSchedulingZone = location.startsWith("/fucina") || location.startsWith("/driver-shifts");
  const isNetworkZone =
    location === "/network-engine" ||
    location.startsWith("/network-engine/") ||
    location === "/planning-studio" ||
    location.startsWith("/planning-studio/") ||
    location === "/depots" ||
    location === "/scenarios" ||
    location === "/planning" ||
    location.startsWith("/planning/") ||
    location === "/coincidence-zones" ||
    location === "/intermodal";
  const isFaresZone =
    location === "/fares-engine" ||
    location === "/fares" ||
    location === "/fares-polimetriche" ||
    location === "/fare-analytics" ||
    location === "/fare-simulator" ||
    location === "/fare-docs" ||
    location === "/stops-classification" ||
    location === "/trip-planner";

  // Track which collapsible sections are expanded (by title)
  const [expandedSections, setExpandedSections] = React.useState<Record<string, boolean>>(() => {
    // Auto-expand the section whose item is currently active
    const initial: Record<string, boolean> = {};
    for (const section of NAV_SECTIONS) {
      if (section.collapsible && section.items.some(i => i.href === location)) {
        initial[section.title] = true;
      }
    }
    return initial;
  });

  const toggleSection = (title: string) =>
    setExpandedSections(prev => ({ ...prev, [title]: !prev[title] }));

  // Auto-expand collapsible section when navigating into it
  React.useEffect(() => {
    for (const section of NAV_SECTIONS) {
      if (section.collapsible && section.items.some(i => i.href === location)) {
        setExpandedSections(prev => ({ ...prev, [section.title]: true }));
      }
    }
  }, [location]);

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
          <div className="relative flex items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-primary/20 blur-lg scale-150 pointer-events-none" />
            <img src={logoSidebarImg} alt="TransitIntel" className="relative h-8 w-auto drop-shadow-[0_0_8px_rgba(var(--primary-rgb,56,189,248),0.5)]" />
          </div>
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
          backdrop-blur-2xl border-r
          flex flex-col h-full
          transition-all duration-300 ease-in-out
          ${isSchedulingZone
            ? `bg-gradient-to-b from-orange-950/95 via-zinc-950/95 to-black/95 border-orange-900/40 ${collapsed ? "w-0 md:w-0 border-r-0 overflow-hidden" : "w-64"}`
            : isNetworkZone
              ? `bg-gradient-to-b from-purple-950/95 via-zinc-950/95 to-black/95 border-purple-900/40 ${collapsed ? "w-0 md:w-0 border-r-0 overflow-hidden" : "w-64"}`
            : isFaresZone
              ? `bg-gradient-to-b from-emerald-950/95 via-zinc-950/95 to-black/95 border-emerald-900/40 ${collapsed ? "w-0 md:w-0 border-r-0 overflow-hidden" : "w-64"}`
              : `bg-card/50 border-border/50 ${collapsed ? "w-16" : "w-64"}`
          }
          ${isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        {/* Logo + collapse toggle */}
        {isSchedulingZone ? (
          /* ── Fucina logo header ── */
          <div className="px-4 pt-4 pb-3 border-b border-orange-900/30 flex items-center gap-3">
            <div className="relative shrink-0">
              <img
                src="/schedulingengine.png"
                alt="Scheduling Engine"
                className="h-10 w-10 object-contain drop-shadow-[0_0_8px_rgba(251,146,60,0.6)]"
              />
              <div className="absolute inset-0 blur-xl bg-orange-500/20 rounded-full pointer-events-none" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black tracking-widest uppercase bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent leading-tight">
                Scheduling Engine
              </p>
              <p className="text-[9px] text-orange-400/40 font-mono mt-0.5">CP-SAT · v2</p>
            </div>
            <button
              onClick={() => setCollapsed(true)}
              title="Nascondi sidebar (più spazio al workspace)"
              className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-orange-300/60 hover:text-orange-200 hover:bg-orange-500/10 transition-colors shrink-0"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        ) : isNetworkZone ? (
          /* ── Network Engine logo header ── */
          <div className="px-4 pt-4 pb-3 border-b border-purple-900/40 flex items-center gap-3">
            <div className="relative shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-gradient-to-br from-purple-500/30 to-fuchsia-500/20 border border-purple-500/30">
              <Network className="w-5 h-5 text-purple-300 drop-shadow-[0_0_6px_rgba(192,132,252,0.7)]" />
              <div className="absolute inset-0 blur-xl bg-purple-500/30 rounded-full pointer-events-none" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black tracking-widest uppercase bg-gradient-to-r from-purple-300 via-fuchsia-300 to-violet-300 bg-clip-text text-transparent leading-tight">
                Network Engine
              </p>
              <p className="text-[9px] text-purple-400/40 font-mono mt-0.5">Servizio · Rete · v1</p>
            </div>
            <button
              onClick={() => setCollapsed(true)}
              title="Nascondi sidebar"
              className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-purple-300/60 hover:text-purple-200 hover:bg-purple-500/10 transition-colors shrink-0"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        ) : isFaresZone ? (
          /* ── Fares Engine logo header ── */
          <div className="px-4 pt-4 pb-3 border-b border-emerald-900/40 flex items-center gap-3">
            <div className="relative shrink-0">
              <img
                src="/faresengine.png"
                alt="Fares Engine"
                className="h-10 w-10 object-contain drop-shadow-[0_0_8px_rgba(0,160,96,0.8)]"
              />
              <div className="absolute inset-0 blur-xl bg-emerald-500/30 rounded-full pointer-events-none" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-black tracking-widest uppercase bg-gradient-to-r from-emerald-300 via-green-300 to-lime-300 bg-clip-text text-transparent leading-tight">
                Fares Engine
              </p>
              <p className="text-[9px] text-emerald-400/40 font-mono mt-0.5">EMV · ABT · v1</p>
            </div>
            <button
              onClick={() => setCollapsed(true)}
              title="Nascondi sidebar"
              className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-emerald-300/60 hover:text-emerald-200 hover:bg-emerald-500/10 transition-colors shrink-0"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        ) : (
          /* ── Normal logo header ── */
          <div className="px-3 pt-3 pb-3 border-b border-border/30 flex items-center justify-between gap-2">
            {!collapsed && (
              <div className="relative flex items-center justify-center flex-1">
                <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl scale-125 pointer-events-none" />
                <img src={logoSidebarImg} alt="TransitIntel" className="relative h-12 w-auto drop-shadow-[0_0_10px_rgba(var(--primary-rgb,56,189,248),0.5)]" />
              </div>
            )}
            <button
              onClick={() => setCollapsed(c => !c)}
              className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
              title={collapsed ? "Espandi sidebar" : "Comprimi sidebar"}
            >
              {collapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
          </div>
        )}

        {/* Nav */}
        {isSchedulingZone ? (
          /* ── Scheduling Engine nav ── */
          <nav className="flex-1 px-3 py-5 flex flex-col gap-1 overflow-y-auto">

            {/* ─ Procedura scheduling ─ */}
            <p className="text-[9px] font-semibold uppercase tracking-widest text-orange-400/40 px-2 mb-1">
              Procedura Scheduling
            </p>

            {/* Hub progetti di esercizio (la lista turni macchina è dentro al singolo progetto) */}
            <Link href="/fucina">
              <div
                onClick={() => setIsMobileOpen(false)}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group transition-all relative ${
                  location === "/fucina"
                    ? "bg-orange-500/15 text-orange-300"
                    : "text-orange-300/60 hover:text-orange-200 hover:bg-orange-500/10"
                }`}
              >
                {location === "/fucina" && (
                  <motion.div layoutId="active-sched" className="absolute left-0 w-0.5 h-5 bg-orange-400 rounded-r-full" initial={false} transition={{ type: "spring", stiffness: 350, damping: 35 }} />
                )}
                <FolderOpen className={`w-4 h-4 shrink-0 transition-colors ${location === "/fucina" ? "text-orange-400" : "text-orange-500/60 group-hover:text-orange-400"}`} />
                <div className="min-w-0">
                  <p className="text-[12px] font-medium leading-tight">Progetti di Esercizio</p>
                  <p className="text-[9px] text-orange-400/30 font-mono">Hub · pipeline · scenari</p>
                </div>
              </div>
            </Link>

            {/* ─ Separatore ─ */}
            <div className="my-3 border-t border-orange-900/25" />

            {/* ─ Turni Macchina Salvati: rimosso — gli scenari ora vivono dentro al singolo progetto ─ */}

            {/* ─ Torna ─ */}
            <div className="mt-auto pt-4 border-t border-orange-900/30">
              <Link href="/network">
                <div
                  onClick={() => setIsMobileOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer text-orange-300/40 hover:text-orange-200/80 hover:bg-orange-500/8 transition-all group"
                >
                  <ChevronLeft className="w-4 h-4 shrink-0 group-hover:-translate-x-0.5 transition-transform" />
                  <span className="text-[12px]">Torna all'app</span>
                </div>
              </Link>
            </div>
          </nav>
        ) : isNetworkZone ? (
          /* ── Network Engine nav ── */
          <nav className="flex-1 px-3 py-5 flex flex-col gap-1 overflow-y-auto">

            {/* ─ Database del Servizio ─ */}
            <p className="text-[9px] font-semibold uppercase tracking-widest text-purple-400/40 px-2 mb-1">
              Database Servizio
            </p>

            {[
              { href: "/network-engine", label: "Hub Network Engine", icon: Network, desc: "Panoramica · navigazione" },
              { href: "/planning-studio", label: "Planner Studio", icon: Map, desc: "Fermate · linee · percorsi · orari", match: (l: string) => l === "/planning-studio" || l.startsWith("/planning-studio/") },
            ].map((item) => {
              const isActive = item.match ? item.match(location) : location === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setIsMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group transition-all relative ${
                      isActive
                        ? "bg-purple-500/15 text-purple-200"
                        : "text-purple-300/60 hover:text-purple-200 hover:bg-purple-500/10"
                    }`}
                  >
                    {isActive && (
                      <motion.div layoutId="active-network" className="absolute left-0 w-0.5 h-5 bg-purple-400 rounded-r-full" initial={false} transition={{ type: "spring", stiffness: 350, damping: 35 }} />
                    )}
                    <Icon className={`w-4 h-4 shrink-0 transition-colors ${isActive ? "text-purple-300" : "text-purple-500/60 group-hover:text-purple-300"}`} />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-tight">{item.label}</p>
                      <p className="text-[9px] text-purple-400/30 font-mono">{item.desc}</p>
                    </div>
                  </div>
                </Link>
              );
            })}

            {/* ─ Separatore ─ */}
            <div className="my-3 border-t border-purple-900/25" />

            {/* ─ Infrastruttura ─ */}
            <p className="text-[9px] font-semibold uppercase tracking-widest text-purple-400/40 px-2 mb-1">
              Infrastruttura
            </p>

            {[
              // I cluster sono gestiti per-progetto in Planner Studio
              // (/planning-studio/:id/clusters). La vecchia pagina globale
              // /cluster era un duplicato e generava confusione.
              { href: "/depots", label: "Depositi", icon: Building2, desc: "Rimessaggio · rifornimento" },
            ].map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setIsMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group transition-all relative ${
                      isActive
                        ? "bg-purple-500/15 text-purple-200"
                        : "text-purple-300/60 hover:text-purple-200 hover:bg-purple-500/10"
                    }`}
                  >
                    {isActive && (
                      <motion.div layoutId="active-network" className="absolute left-0 w-0.5 h-5 bg-purple-400 rounded-r-full" initial={false} transition={{ type: "spring", stiffness: 350, damping: 35 }} />
                    )}
                    <Icon className={`w-4 h-4 shrink-0 transition-colors ${isActive ? "text-purple-300" : "text-purple-500/60 group-hover:text-purple-300"}`} />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-tight">{item.label}</p>
                      <p className="text-[9px] text-purple-400/30 font-mono">{item.desc}</p>
                    </div>
                  </div>
                </Link>
              );
            })}

            {/* ─ Separatore ─ */}
            <div className="my-3 border-t border-purple-900/25" />

            {/* ─ Pianificazione Operativa ─ */}
            <p className="text-[9px] font-semibold uppercase tracking-widest text-purple-400/40 px-2 mb-1">
              Pianificazione
            </p>

            {[
              { href: "/scenarios", label: "Scenari", icon: Route, desc: "Variazioni · ipotesi · A/B" },
              { href: "/planning", label: "Planner Legacy", icon: Layers, desc: "Analisi GTFS · feed" },
              { href: "/coincidence-zones", label: "Zone Coincidenza", icon: Zap, desc: "Hub · trasbordi" },
              { href: "/intermodal", label: "Intermodale", icon: ArrowRightLeft, desc: "Treno · gomma · integraz." },
            ].map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setIsMobileOpen(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group transition-all relative ${
                      isActive
                        ? "bg-purple-500/15 text-purple-200"
                        : "text-purple-300/60 hover:text-purple-200 hover:bg-purple-500/10"
                    }`}
                  >
                    {isActive && (
                      <motion.div layoutId="active-network" className="absolute left-0 w-0.5 h-5 bg-purple-400 rounded-r-full" initial={false} transition={{ type: "spring", stiffness: 350, damping: 35 }} />
                    )}
                    <Icon className={`w-4 h-4 shrink-0 transition-colors ${isActive ? "text-purple-300" : "text-purple-500/60 group-hover:text-purple-300"}`} />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-tight">{item.label}</p>
                      <p className="text-[9px] text-purple-400/30 font-mono">{item.desc}</p>
                    </div>
                  </div>
                </Link>
              );
            })}

            {/* ─ Torna ─ */}
            <div className="mt-auto pt-4 border-t border-purple-900/30">
              <Link href="/network">
                <div
                  onClick={() => setIsMobileOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer text-purple-300/40 hover:text-purple-200/80 hover:bg-purple-500/8 transition-all group"
                >
                  <ChevronLeft className="w-4 h-4 shrink-0 group-hover:-translate-x-0.5 transition-transform" />
                  <span className="text-[12px]">Torna all'app</span>
                </div>
              </Link>
            </div>
          </nav>
        ) : isFaresZone ? (
          /* ── Fares Engine nav ── */
          <nav className="flex-1 px-3 py-5 flex flex-col gap-1 overflow-y-auto">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-emerald-400/40 px-2 mb-1">
              Bigliettazione Elettronica
            </p>

            {[
              { href: "/fares-engine", label: "Home Fares Engine", icon: Wallet, desc: "Panoramica · navigazione" },
              { href: "/fares", label: "Bigliettazione", icon: Ticket, desc: "Tariffe · titoli · zone" },
              { href: "/fares-polimetriche", label: "Polimetriche", icon: Milestone, desc: "Tratte · area di lavoro" },
              { href: "/fare-analytics", label: "Analisi Tariffaria", icon: BarChart3, desc: "Ricavi · OD · KPI" },
              { href: "/fare-simulator", label: "Simulatore", icon: Gamepad2, desc: "What-if · scenari" },
              { href: "/trip-planner", label: "Trip Planner", icon: Navigation, desc: "Game maps · door-to-door" },
              { href: "/fare-docs", label: "Metodologia & Docs", icon: BookOpen, desc: "Riferimenti · note" },
              // "Classifica Fermate" è ora accessibile come step 2 dentro Bigliettazione.
              // Voce sidebar disattivata ma route preservata in App.tsx per accesso diretto.
              // { href: "/stops-classification", label: "Classifica Fermate", icon: MapPinCheck, desc: "Tier · accessibilità" },
            ].map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div
                    onClick={() => setIsMobileOpen(false)}
                    data-virgilio-id={`nav:${item.href.replace(/^\//, "").replace(/\//g, "-")}`}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer group transition-all relative ${
                      isActive
                        ? "bg-emerald-500/15 text-emerald-200"
                        : "text-emerald-300/60 hover:text-emerald-200 hover:bg-emerald-500/10"
                    }`}
                  >
                    {isActive && (
                      <motion.div layoutId="active-fares" className="absolute left-0 w-0.5 h-5 bg-emerald-400 rounded-r-full" initial={false} transition={{ type: "spring", stiffness: 350, damping: 35 }} />
                    )}
                    <Icon className={`w-4 h-4 shrink-0 transition-colors ${isActive ? "text-emerald-400" : "text-emerald-500/60 group-hover:text-emerald-400"}`} />
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium leading-tight">{item.label}</p>
                      <p className="text-[9px] text-emerald-400/30 font-mono">{item.desc}</p>
                    </div>
                  </div>
                </Link>
              );
            })}

            {/* ─ Torna ─ */}
            <div className="mt-auto pt-4 border-t border-emerald-900/30">
              <Link href="/network">
                <div
                  onClick={() => setIsMobileOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer text-emerald-300/40 hover:text-emerald-200/80 hover:bg-emerald-500/8 transition-all group"
                >
                  <ChevronLeft className="w-4 h-4 shrink-0 group-hover:-translate-x-0.5 transition-transform" />
                  <span className="text-[12px]">Torna all'app</span>
                </div>
              </Link>
            </div>
          </nav>
        ) : (
          /* ── Normal nav ── */
          <nav className="flex-1 px-2 py-4 space-y-3 overflow-y-auto">
          {visibleSections.map((section) => {
            const sectionHasActive = section.items.some(i => location === i.href);
            const isExpanded = expandedSections[section.title] ?? false;

            // ── Collapsible section (e.g. "Pianificazione Servizio") ──
            if (section.collapsible) {
              const SectionIcon = section.icon;
              return (
                <div key={section.title} className="space-y-0.5">
                  {/* Group header / toggle */}
                  {!collapsed ? (
                    <button
                      onClick={() => toggleSection(section.title)}
                      className={`
                        w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left
                        transition-all duration-150 text-xs font-semibold uppercase tracking-wider
                        ${sectionHasActive
                          ? "text-primary/90"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                        }
                      `}
                    >
                      {SectionIcon && <SectionIcon className="w-3.5 h-3.5 shrink-0" />}
                      <span className="flex-1">{section.title}</span>
                      <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
                    </button>
                  ) : (
                    /* When sidebar is collapsed, just show the section icon as a separator */
                    <div className="flex justify-center py-1">
                      {SectionIcon && (
                        <div
                          title={section.title}
                          className={`w-8 h-8 flex items-center justify-center rounded-lg cursor-pointer
                            ${sectionHasActive ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-white/5"}
                          `}
                          onClick={() => toggleSection(section.title)}
                        >
                          <SectionIcon className="w-4 h-4" />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Expandable items */}
                  <AnimatePresence initial={false}>
                    {(isExpanded || collapsed) && (
                      <motion.div
                        initial={collapsed ? false : { height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeInOut" }}
                        className="overflow-hidden"
                      >
                        <div className={!collapsed ? "pl-2 border-l border-border/30 ml-4 space-y-0.5" : "space-y-0.5"}>
                          {section.items.map((item) => {
                            const isActive = location === item.href;
                            return (
                              <Link key={item.href} href={item.href}>
                                <div
                                  onClick={() => setIsMobileOpen(false)}
                                  title={collapsed ? item.label : undefined}
                                  data-virgilio-id={`nav:${item.href.replace(/^\//, "").replace(/\//g, "-")}`}
                                  className={`
                                    flex items-center gap-3 rounded-lg cursor-pointer
                                    transition-all duration-150 group relative text-sm
                                    ${collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2"}
                                    ${isActive
                                      ? "bg-primary/15 text-primary font-medium"
                                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                                    }
                                  `}
                                >
                                  {isActive && (
                                    <motion.div
                                      layoutId="active-nav"
                                      className="absolute left-0 w-0.5 h-5 bg-primary rounded-r-full"
                                      initial={false}
                                      transition={{ type: "spring", stiffness: 350, damping: 35 }}
                                    />
                                  )}
                                  <item.icon className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : "group-hover:text-foreground transition-colors"}`} />
                                  {!collapsed && <span className="text-[13px]">{item.label}</span>}
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            }

            // ── Normal section (flat list) ──
            return (
              <div key={section.title} className="space-y-0.5">
                {!collapsed && (
                  <p className="px-3 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                    {section.title}
                  </p>
                )}
                {collapsed && section.icon && (
                  <div className="flex justify-center py-1 mb-0.5">
                    <div title={section.title} className="w-6 h-px bg-border/40 rounded" />
                  </div>
                )}
                {section.items.map((item) => {
                  const isActive = location === item.href;
                  const isFucina = item.href === "/fucina";
                  const isFaresEngine = item.href === "/fares-engine";
                  const isNetworkEngine = item.href === "/network-engine";
                  return (
                    <Link key={item.href} href={item.href}>
                      <div
                        onClick={() => setIsMobileOpen(false)}
                        title={collapsed ? item.label : undefined}
                        data-virgilio-id={`nav:${item.href.replace(/^\//, "").replace(/\//g, "-")}`}
                        className={`
                          flex items-center gap-3 rounded-lg cursor-pointer
                          transition-all duration-150 group relative text-sm
                          ${collapsed ? "justify-center px-2 py-2.5" : "px-3 py-2.5"}
                          ${isActive
                            ? isFucina
                              ? "bg-orange-500/10 text-orange-400 font-medium"
                              : isFaresEngine
                                ? "bg-emerald-500/10 text-emerald-300 font-medium"
                                : isNetworkEngine
                                  ? "bg-purple-500/10 text-purple-300 font-medium"
                                  : "bg-primary/15 text-primary font-medium"
                            : isFucina
                              ? "text-orange-400/60 hover:bg-orange-500/8 hover:text-orange-300"
                              : isFaresEngine
                                ? "text-emerald-400/70 hover:bg-emerald-500/8 hover:text-emerald-200"
                                : isNetworkEngine
                                  ? "text-purple-400/70 hover:bg-purple-500/8 hover:text-purple-200"
                                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                          }
                        `}
                      >
                        {isActive && (
                          <motion.div
                            layoutId="active-nav"
                            className={`absolute left-0 w-0.5 h-6 rounded-r-full ${isFucina ? "bg-orange-400" : isFaresEngine ? "bg-emerald-400" : isNetworkEngine ? "bg-purple-400" : "bg-primary"}`}
                            initial={false}
                            transition={{ type: "spring", stiffness: 350, damping: 35 }}
                          />
                        )}
                        <item.icon className={`w-4 h-4 shrink-0 ${
                          isFucina
                            ? isActive ? "text-orange-400" : "text-orange-500/70 group-hover:text-orange-400 transition-colors"
                            : isFaresEngine
                              ? isActive ? "text-emerald-400" : "text-emerald-500/70 group-hover:text-emerald-300 transition-colors"
                              : isNetworkEngine
                                ? isActive ? "text-purple-400" : "text-purple-500/70 group-hover:text-purple-300 transition-colors"
                                : isActive ? "text-primary" : "group-hover:text-foreground transition-colors"
                        }`} />
                        {!collapsed && (
                          isFucina
                            ? <span className={isActive ? "text-orange-400" : "text-orange-400/70 group-hover:text-orange-300 transition-colors"}>{item.label}</span>
                            : isFaresEngine
                              ? <span className={isActive ? "text-emerald-300" : "text-emerald-400/80 group-hover:text-emerald-200 transition-colors"}>{item.label}</span>
                              : isNetworkEngine
                                ? <span className={isActive ? "text-purple-300" : "text-purple-400/80 group-hover:text-purple-200 transition-colors"}>{item.label}</span>
                                : item.label
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
        )} {/* end normal nav conditional */}

        {!isSchedulingZone && !isFaresZone && !isNetworkZone && !collapsed && (
          <div className="p-4 mt-auto border-t border-border/30 space-y-3">
            {isAdmin && (
              <Link href="/admin/users">
                <div
                  onClick={() => setIsMobileOpen(false)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs cursor-pointer transition-all ${
                    location === "/admin/users"
                      ? "bg-amber-500/15 text-amber-300"
                      : "text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/10"
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  <span className="font-medium">Gestione Utenti</span>
                </div>
              </Link>
            )}
            {user && (
              <div className="px-3 py-1 text-[10px] text-muted-foreground">
                <div className="font-medium text-foreground/80 truncate">
                  {user.fullName || user.email}
                </div>
                <div className="font-mono opacity-60 truncate">{user.email}</div>
                {isAdmin && <div className="text-amber-400/70 mt-0.5">admin</div>}
              </div>
            )}
            <div className="bg-gradient-to-br from-primary/10 to-accent/10 rounded-xl p-4 border border-primary/20">
              <h4 className="font-semibold text-xs mb-0.5 text-primary">Ancona / Marche</h4>
              <p className="text-[11px] text-muted-foreground">Sistema attivo</p>
            </div>
            <button
              onClick={logout}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Disconnetti</span>
            </button>
          </div>
        )}
        {!isSchedulingZone && !isFaresZone && !isNetworkZone && collapsed && (
          <div className="mt-auto border-t border-border/30 py-3 flex justify-center">
            <button
              onClick={logout}
              title="Disconnetti"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-all"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        )}
        {isSchedulingZone && (
          <div className="border-t border-orange-900/30 py-3 px-4 flex justify-center">
            <button
              onClick={logout}
              title="Disconnetti"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-orange-400/40 hover:text-red-400 hover:bg-red-500/10 transition-all"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Disconnetti</span>
            </button>
          </div>
        )}
        {isFaresZone && (
          <div className="border-t border-emerald-900/30 py-3 px-4 flex justify-center">
            <button
              onClick={logout}
              title="Disconnetti"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-emerald-400/40 hover:text-red-400 hover:bg-red-500/10 transition-all"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Disconnetti</span>
            </button>
          </div>
        )}
        {isNetworkZone && (
          <div className="border-t border-purple-900/30 py-3 px-4 flex justify-center">
            <button
              onClick={logout}
              title="Disconnetti"
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-purple-400/40 hover:text-red-400 hover:bg-red-500/10 transition-all"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Disconnetti</span>
            </button>
          </div>
        )}
      </aside>

      {/* Linguetta flottante per riaprire la sidebar quando è nascosta nelle zone scheduling/fares/network */}
      {(isSchedulingZone || isFaresZone || isNetworkZone) && collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          title="Mostra sidebar"
          className={`hidden md:flex fixed left-0 top-1/2 -translate-y-1/2 z-40 items-center justify-center w-6 h-16 rounded-r-md shadow-lg transition-colors ${
            isSchedulingZone
              ? "bg-orange-950/95 hover:bg-orange-900 border border-l-0 border-orange-800/60 text-orange-300"
              : isNetworkZone
                ? "bg-purple-950/95 hover:bg-purple-900 border border-l-0 border-purple-800/60 text-purple-300"
                : "bg-emerald-950/95 hover:bg-emerald-900 border border-l-0 border-emerald-800/60 text-emerald-300"
          }`}
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      {/* Main Content */}
      <main className={`flex-1 relative flex flex-col h-full overflow-hidden pt-14 md:pt-0 ${isFaresZone ? "fares-zone" : ""}`}>
        <div className={`flex-1 w-full h-full ${
          location === "/dashboard" || location === "/operations" || location === "/scenarios" ||
          /^\/planning-studio\/[^/]+$/.test(location)
            ? ""
            : "overflow-y-auto p-3 sm:p-4 md:p-8"
        }`}>
          <motion.div
            key={location}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="h-full max-w-full overflow-x-hidden"
          >
            {children}
          </motion.div>
        </div>
      </main>

      {/* AI Copilot — disponibile su ogni pagina */}
      <CopilotSidebar />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  SavedScenariosSection — lista dei turni macchina salvati
 *  (con nesting dei turni guida figli)
 *  visibile solo nella sidebar dello Scheduling Engine
 * ═══════════════════════════════════════════════════════════════ */
interface SavedScenario { id: string; name: string; date: string; createdAt: string; }
interface SavedDriverShift { id: string; name: string; createdAt: string; summary?: any; }

function SavedScenariosSection({ location, onNavigate }: { location: string; onNavigate: () => void }) {
  const [scenarios, setScenarios] = React.useState<SavedScenario[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [dssByScenario, setDssByScenario] = React.useState<Record<string, SavedDriverShift[]>>({});

  const refetch = React.useCallback(() => {
    setLoading(true);
    fetch(`${getApiBase()}/api/service-program/scenarios`)
      .then(r => (r.ok ? r.json() : []))
      .then(d => setScenarios(Array.isArray(d) ? d : []))
      .catch(() => setScenarios([]))
      .finally(() => setLoading(false));
  }, []);

  // refetch al mount + ogni cambio di pagina dentro lo Scheduling Engine
  React.useEffect(() => { refetch(); }, [refetch, location]);

  // refetch quando la finestra torna in focus (utile dopo un salvataggio)
  React.useEffect(() => {
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  // se sono dentro /driver-shifts/:id, espando automaticamente quello scenario
  React.useEffect(() => {
    const m = location.match(/^\/driver-shifts\/([^/?#]+)/);
    if (m) {
      const id = m[1];
      setExpanded(prev => prev.has(id) ? prev : new Set(prev).add(id));
    }
  }, [location]);

  const fetchDss = React.useCallback((scenarioId: string) => {
    fetch(`${getApiBase()}/api/driver-shifts/${scenarioId}/scenarios`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setDssByScenario(prev => ({ ...prev, [scenarioId]: Array.isArray(d) ? d : [] })))
      .catch(() => setDssByScenario(prev => ({ ...prev, [scenarioId]: [] })));
  }, []);

  // carica i DSS per ogni scenario espanso
  React.useEffect(() => {
    expanded.forEach(id => { if (!(id in dssByScenario)) fetchDss(id); });
  }, [expanded, dssByScenario, fetchDss]);

  const toggleExpand = (id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (confirmDel !== id) {
      setConfirmDel(id);
      setTimeout(() => setConfirmDel(prev => (prev === id ? null : prev)), 3000);
      return;
    }
    try {
      await fetch(`${getApiBase()}/api/service-program/scenarios/${id}`, { method: "DELETE" });
      setScenarios(prev => prev.filter(s => s.id !== id));
    } catch { /* ignore */ }
    setConfirmDel(null);
  };

  // estrae il dssId dal pathname/search corrente
  const currentDssId = React.useMemo(() => {
    const qs = typeof window !== "undefined" ? window.location.search : "";
    return new URLSearchParams(qs).get("dss");
  }, [location]);

  return (
    <>
      <div className="my-3 border-t border-orange-900/25" />
      <div className="px-2 mb-1 flex items-center justify-between">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-orange-400/40 flex items-center gap-1.5">
          <FolderOpen className="w-3 h-3" />
          Turni Macchina Salvati
          {scenarios.length > 0 && (
            <span className="text-orange-400/30 font-mono normal-case tracking-normal">({scenarios.length})</span>
          )}
        </p>
        <button
          onClick={refetch}
          title="Aggiorna lista"
          className="text-orange-400/40 hover:text-orange-300 transition-colors p-0.5 rounded hover:bg-orange-500/10"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {loading && scenarios.length === 0 ? (
        <div className="px-3 py-2 text-[10px] text-orange-400/30 italic">Caricamento…</div>
      ) : scenarios.length === 0 ? (
        <div className="px-3 py-2 text-[10px] text-orange-400/40 italic leading-snug">
          Nessuno scenario salvato.<br/>
          <span className="text-orange-400/30">Esegui un'ottimizzazione e salvala.</span>
        </div>
      ) : (
        <div className="space-y-0.5 max-h-[28rem] overflow-y-auto pr-1">
          {scenarios.map(sc => {
            const dateIso = sc.date && sc.date.length === 8
              ? `${sc.date.slice(0,4)}-${sc.date.slice(4,6)}-${sc.date.slice(6,8)}`
              : sc.date;
            const href = `/driver-shifts/${sc.id}`;
            const isActive = location === href || location.startsWith(href + "?");
            const isExpanded = expanded.has(sc.id);
            const dssList = dssByScenario[sc.id];
            return (
              <div key={sc.id}>
                <div
                  className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg transition-all relative ${
                    isActive
                      ? "bg-orange-500/15 text-orange-300"
                      : "text-orange-300/60 hover:text-orange-200 hover:bg-orange-500/10"
                  }`}
                >
                  {isActive && (
                    <div className="absolute left-0 w-0.5 h-5 bg-orange-400 rounded-r-full" />
                  )}
                  <button
                    onClick={(e) => toggleExpand(sc.id, e)}
                    className="p-0.5 rounded hover:bg-orange-500/15 shrink-0"
                    title={isExpanded ? "Comprimi turni guida" : "Mostra turni guida"}
                  >
                    {isExpanded
                      ? <ChevronDown className="w-3 h-3 text-orange-400/60" />
                      : <ChevronDown className="w-3 h-3 text-orange-400/60 -rotate-90" />}
                  </button>
                  <Link href={href}>
                    <div onClick={onNavigate} className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" title={sc.name}>
                      <ClipboardList className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-orange-400" : "text-orange-500/50"}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium leading-tight truncate">{sc.name}</p>
                        <p className="text-[9px] text-orange-400/40 font-mono leading-tight">{dateIso}</p>
                      </div>
                    </div>
                  </Link>
                  <Link href={`/fucina?scenario=${sc.id}`}>
                    <button
                      onClick={onNavigate}
                      title="Riapri nell'Area di Lavoro Turni Macchina"
                      className="shrink-0 p-1 rounded text-orange-400/40 hover:text-orange-300 hover:bg-orange-500/15 opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Truck className="w-3 h-3" />
                    </button>
                  </Link>
                  <button
                    onClick={(e) => handleDelete(sc.id, e)}
                    title={confirmDel === sc.id ? "Conferma eliminazione" : "Elimina"}
                    className={`shrink-0 p-1 rounded transition-all ${
                      confirmDel === sc.id
                        ? "text-red-400 bg-red-500/20 opacity-100"
                        : "text-orange-400/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>

                {/* ── Turni Guida figli (driver-shift scenarios) ── */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="overflow-hidden ml-5 border-l border-orange-900/30 pl-2 mt-0.5 space-y-0.5"
                    >
                      {dssList === undefined ? (
                        <div className="px-2 py-1 text-[9px] text-orange-400/30 italic">Caricamento turni guida…</div>
                      ) : dssList.length === 0 ? (
                        <div className="px-2 py-1 text-[9px] text-orange-400/40 italic">Nessun turno guida salvato</div>
                      ) : dssList.map(dss => {
                        const dssHref = `/driver-shifts/${sc.id}?dss=${dss.id}`;
                        const dssActive = isActive && currentDssId === dss.id;
                        return (
                          <Link key={dss.id} href={dssHref}>
                            <div
                              onClick={onNavigate}
                              className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-all ${
                                dssActive
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "text-orange-300/55 hover:text-emerald-200 hover:bg-emerald-500/10"
                              }`}
                              title={dss.name}
                            >
                              <Users className={`w-3 h-3 shrink-0 ${dssActive ? "text-emerald-400" : "text-emerald-500/40"}`} />
                              <div className="min-w-0 flex-1">
                                <p className="text-[10px] leading-tight truncate">{dss.name}</p>
                                {dss.summary?.totalDriverShifts != null && (
                                  <p className="text-[8px] text-emerald-400/30 font-mono leading-tight">
                                    {dss.summary.totalDriverShifts} autisti
                                  </p>
                                )}
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
