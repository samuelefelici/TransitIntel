import React from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Map, Activity, MapPin, BarChart3, Menu, X, LayoutDashboard, Database, Bus,
  Timer, PanelLeftClose, PanelLeftOpen, Users, Route, ArrowRightLeft,
  Zap, ChevronDown, Truck, LogOut, Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import logoImg from "/logo.png";
import logoSidebarImg from "/logosidebar.png";

interface NavItem { href: string; label: string; icon: any; }
interface NavSection {
  title: string;
  icon?: any;            // section-level icon (shown when collapsed & for expandable groups)
  collapsible?: boolean; // if true, items are behind a toggle
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: "Panoramica",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/traffic", label: "Traffico & Rete", icon: Activity },
      { href: "/territory", label: "Territorio & Domanda", icon: Map },
    ],
  },
  {
    title: "Crea Servizio",
    icon: Route,
    collapsible: true,
    items: [
      { href: "/scenarios", label: "Scenari", icon: Route },
      { href: "/coincidence-zones", label: "Zone Coincidenza", icon: Zap },
      { href: "/intermodal", label: "Intermodale", icon: ArrowRightLeft },
    ],
  },
  {
    title: "Ottimizzazione Servizio",
    items: [
      { href: "/optimization", label: "Ottimizzazione", icon: Truck },
    ],
  },
  {
    title: "Analisi Rete",
    items: [
      { href: "/network", label: "Linee & Fermate", icon: Network },
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
  const { logout } = useAuth();

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
          bg-card/50 backdrop-blur-2xl border-r border-border/50
          flex flex-col h-full
          transition-all duration-300 ease-in-out
          ${collapsed ? "w-16" : "w-64"}
          ${isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        {/* Logo + collapse toggle */}
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

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-3 overflow-y-auto">
          {NAV_SECTIONS.map((section) => {
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
            );
          })}
        </nav>

        {!collapsed && (
          <div className="p-4 mt-auto border-t border-border/30 space-y-3">
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
        {collapsed && (
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
      </aside>

      {/* Main Content */}
      <main className="flex-1 relative flex flex-col h-full overflow-hidden pt-14 md:pt-0">
        <div className={`flex-1 w-full h-full ${location !== "/dashboard" && location !== "/scenarios" ? "overflow-y-auto p-3 sm:p-4 md:p-8" : ""}`}>
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
    </div>
  );
}
