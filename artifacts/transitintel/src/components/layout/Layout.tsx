import React from "react";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { Menu, X, PanelLeftClose, PanelLeftOpen, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api";
import { CASA, paginaDiLavoro, paginaTariffe, sezioniVisibili, voceAttiva, type VoceMenu } from "@/lib/navigazione";
import ArgosSidebar from "@/components/ArgosSidebar";
import logoSidebarImg from "/logosidebar.png";

/**
 * L'impalcatura dell'app: il menu sul ciclo di lavoro (lib/navigazione.ts) e
 * la pagina. Nelle pagine di lavoro a tutto schermo (un progetto di Planning
 * Studio, la Fucina) il menu si nasconde del tutto e torna con la linguetta;
 * altrove si riduce alle icone.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const [isMobileOpen, setIsMobileOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const { logout: esci, user, isAdmin, hasPermission } = useAuth();
  /* chi esce di sua volontà riparte dalla radice: chi entra dopo non eredita la sua pagina
   * (una sessione scaduta invece resta dov'era, e dopo l'accesso si torna lì) */
  const logout = React.useCallback(async () => { await esci(); navigate("/", { replace: true }); }, [esci, navigate]);
  const { toast } = useToast();

  /* ── SSO verso FleetCare (modulo gestione flotta) ──
   * FleetCare è un'app separata sullo stesso database: chi ha un account Cerbero
   * ci entra solo da qui (o da /fleetcare, pages/fleetcare.tsx). Il backend emette
   * un biglietto monouso (60s) e ci reindirizza là già autenticati. */
  const [fleetcareBusy, setFleetcareBusy] = React.useState(false);
  const openFleetCare = React.useCallback(async () => {
    if (fleetcareBusy) return;
    setFleetcareBusy(true);
    try {
      const r = await apiFetch<{ url: string }>("/api/auth/fleetcare-sso", { method: "POST", body: "{}" });
      window.location.href = r.url;
    } catch (e: any) {
      setFleetcareBusy(false);
      toast({
        title: "FleetCare non disponibile",
        description: e?.message || "Errore durante l'accesso a FleetCare.",
        variant: "destructive",
      });
    }
  }, [fleetcareBusy, toast]);
  /* tornando indietro da FleetCare la pagina può riapparire dalla cache del browser
   * (bfcache) col pulsante ancora «occupato»: lo si libera */
  React.useEffect(() => {
    const sblocca = (e: PageTransitionEvent) => { if (e.persisted) setFleetcareBusy(false); };
    window.addEventListener("pageshow", sblocca);
    return () => window.removeEventListener("pageshow", sblocca);
  }, []);

  const sezioni = React.useMemo(() => sezioniVisibili(hasPermission, isAdmin), [hasPermission, isAdmin]);
  const attiva = voceAttiva(location, sezioni);
  const lavoro = paginaDiLavoro(location);
  /* nelle pagine di lavoro «compresso» vuol dire nascosto del tutto */
  const nascosto = lavoro && collapsed;
  const icone = !lavoro && collapsed;
  // Planning Studio: qui c'è Argos. Se siamo dentro un progetto specifico ne
  // estraiamo l'id (uuid) da passare ad Argos come contesto.
  const isPlanningStudio = location === "/planning-studio" || location.startsWith("/planning-studio/");
  const planningStudioProjectId = location.match(/^\/planning-studio\/([0-9a-f-]{36})/i)?.[1];

  const Background = () => (
    <div className="fixed inset-0 z-[-1] pointer-events-none">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
    </div>
  );

  /* una funzione, non un componente: ricreato a ogni giro farebbe rimontare le voci */
  const voce = (v: VoceMenu) => {
    const isActive = attiva === v.href;
    const Icona = v.icona;
    const classi = `
      w-full flex items-center gap-3 rounded-lg cursor-pointer text-left
      transition-all duration-150 group relative text-sm
      ${icone ? "justify-center px-2 py-2.5" : "px-3 py-2"}
      ${isActive ? "bg-primary/15 text-primary font-medium" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}
    `;
    const contenuto = (
      <>
        {isActive && (
          <motion.div
            layoutId="active-nav"
            className="absolute left-0 w-0.5 h-5 bg-primary rounded-r-full"
            initial={false}
            transition={{ type: "spring", stiffness: 350, damping: 35 }}
          />
        )}
        <Icona className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : "group-hover:text-foreground transition-colors"}`} />
        {!icone && <span className="text-[13px] truncate">{v.azione === "fleetcare" && fleetcareBusy ? "Apro FleetCare…" : v.etichetta}</span>}
      </>
    );
    if (v.azione === "fleetcare") {
      return (
        <button
          key={v.href}
          type="button"
          onClick={() => { setIsMobileOpen(false); void openFleetCare(); }}
          disabled={fleetcareBusy}
          title={icone ? v.etichetta : v.descrizione}
          className={`${classi} disabled:opacity-60`}
        >
          {contenuto}
        </button>
      );
    }
    return (
      <Link key={v.href} href={v.href}>
        <div
          onClick={() => setIsMobileOpen(false)}
          title={icone ? v.etichetta : v.descrizione}
          aria-current={isActive ? "page" : undefined}
          className={classi}
        >
          {contenuto}
        </div>
      </Link>
    );
  };

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
        <Button variant="ghost" size="icon" onClick={() => setIsMobileOpen(!isMobileOpen)} aria-label={isMobileOpen ? "Chiudi il menu" : "Apri il menu"}>
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

      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-40 shrink-0
          backdrop-blur-2xl border-r bg-card/50 border-border/50
          flex flex-col h-full
          transition-all duration-300 ease-in-out
          ${nascosto ? "w-64 md:w-0 md:border-r-0 md:overflow-hidden" : icone ? "w-64 md:w-16" : "w-64"}
          ${isMobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        <div className="px-3 pt-3 pb-3 border-b border-border/30 flex items-center justify-between gap-2">
          {!icone && (
            <Link href={CASA}>
              <div className="relative flex items-center justify-center flex-1 cursor-pointer" onClick={() => setIsMobileOpen(false)}>
                <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl scale-125 pointer-events-none" />
                <img src={logoSidebarImg} alt="Cerbero, vai a Oggi" className="relative h-12 w-auto drop-shadow-[0_0_10px_rgba(var(--primary-rgb,56,189,248),0.5)]" />
              </div>
            </Link>
          )}
          <button
            onClick={() => setCollapsed(c => !c)}
            className="hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors shrink-0"
            title={lavoro ? "Nascondi il menu (più spazio al lavoro)" : collapsed ? "Espandi il menu" : "Comprimi il menu"}
          >
            {icone ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 px-2 py-4 space-y-3 overflow-y-auto" aria-label="Menu principale">
          {sezioni.map((s) => (
            <div key={s.titolo} className="space-y-0.5">
              {!icone ? (
                <p className="px-3 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                  {s.titolo}
                </p>
              ) : (
                <div className="flex justify-center py-1 mb-0.5">
                  <div title={s.titolo} className="w-6 h-px bg-border/40 rounded" />
                </div>
              )}
              {s.voci.map(voce)}
            </div>
          ))}
        </nav>

        {!icone ? (
          <div className="p-4 mt-auto border-t border-border/30 space-y-3">
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
        ) : (
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

      {/* Linguetta per riaprire il menu quando è nascosto in una pagina di lavoro */}
      {nascosto && (
        <button
          onClick={() => setCollapsed(false)}
          title="Mostra il menu"
          className="hidden md:flex fixed left-0 top-1/2 -translate-y-1/2 z-40 items-center justify-center w-6 h-16 rounded-r-md shadow-lg transition-colors bg-card/95 hover:bg-muted border border-l-0 border-border/60 text-muted-foreground"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      )}

      {/* Main Content */}
      <main className={`flex-1 relative flex flex-col h-full overflow-hidden pt-14 md:pt-0 ${paginaTariffe(location) ? "fares-zone" : ""}`}>
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

      {/* Argos, dentro Planning Studio: legge i dati del PROGETTO aperto (ps_*) via /api/ai/argos/chat */}
      {isPlanningStudio && <ArgosSidebar projectId={planningStudioProjectId} />}
    </div>
  );
}
