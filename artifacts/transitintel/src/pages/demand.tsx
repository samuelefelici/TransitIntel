import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GraduationCap, Building2, Stethoscope, ArrowLeftRight,
  MapPin, Clock, Info, CheckCircle, ChevronDown, ChevronUp,
  BarChart2,
} from "lucide-react";
import { getApiBase } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────
interface PoiItem {
  name: string; lat: number; lng: number;
  nearestStop: string; distM: number;
  entryBuses: number; exitBuses: number;
  entryRoutes: string[]; exitRoutes: string[];
  verdict: "ottimo" | "buono" | "sufficiente" | "critico";
}
interface VerdictStats {
  ottimo: number; buono: number; sufficiente: number; critico: number; total: number;
}
interface HubRoute { id: string; shortName: string; color: string }
interface TransferPair {
  routeA: string; routeB: string;
  timeA: string; timeB: string; deltaMin: number;
}
interface HubItem {
  stopName: string; lat: number; lng: number;
  routeCount: number; routes: HubRoute[];
  transferPairs: TransferPair[];
  transferScore: "ottimo" | "buono" | "sufficiente" | "critico";
}
interface ServiceData {
  schools:   { items: PoiItem[]; stats: VerdictStats };
  offices:   { items: PoiItem[]; stats: VerdictStats };
  hospitals: { items: PoiItem[]; stats: VerdictStats };
  hubs:      { items: HubItem[]; stats: VerdictStats };
  timeWindows: {
    school: { entry: string; exit: string };
    office: { entry: string; exit: string };
    hospital: { am: string; pm: string };
  };
}

// ─── Colors ──────────────────────────────────────────────────
const V_CFG: Record<string, { color: string; bg: string; border: string; icon: string; label: string }> = {
  ottimo:      { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", icon: "✅", label: "Ottimo" },
  buono:       { color: "text-blue-400",    bg: "bg-blue-500/10",    border: "border-blue-500/20",    icon: "👍", label: "Buono" },
  sufficiente: { color: "text-yellow-400",  bg: "bg-yellow-500/10",  border: "border-yellow-500/20",  icon: "⚠️", label: "Sufficiente" },
  critico:     { color: "text-red-400",     bg: "bg-red-500/10",     border: "border-red-500/20",     icon: "❌", label: "Critico" },
};

function rc(c: string) { return c.startsWith("#") ? c : c ? `#${c}` : "#64748b"; }

// ─── Tabs ─────────────────────────────────────────────────────
type Tab = "schools" | "offices" | "hospitals" | "hubs";
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "schools",   label: "Scuole",           icon: <GraduationCap className="w-3.5 h-3.5" /> },
  { id: "offices",   label: "Uffici & Prod.",    icon: <Building2 className="w-3.5 h-3.5" /> },
  { id: "hospitals", label: "Ospedali",          icon: <Stethoscope className="w-3.5 h-3.5" /> },
  { id: "hubs",      label: "Nodi di Scambio",   icon: <ArrowLeftRight className="w-3.5 h-3.5" /> },
];

// ─── Main Page ────────────────────────────────────────────────
export default function DemandPage() {
  const [data, setData] = useState<ServiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("schools");

  useEffect(() => {
    setLoading(true);
    fetch(`${getApiBase()}/api/analysis/service-quality`, { cache: "no-store" })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(`Errore caricamento: ${e.message}`); setLoading(false); });
  }, []);

  if (loading) return (
    <div className="h-full flex items-center justify-center gap-3 text-muted-foreground">
      <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      <p className="text-sm">Analisi qualità servizio in corso…</p>
    </div>
  );
  if (error || !data) return (
    <div className="h-full flex items-center justify-center text-destructive text-sm">{error ?? "Errore"}</div>
  );

  // Global verdict
  const allPoi = [
    ...data.schools.items, ...data.offices.items, ...data.hospitals.items,
  ];
  const critici = allPoi.filter(x => x.verdict === "critico").length;
  const totalPoi = allPoi.length;
  const pctOk = totalPoi > 0 ? Math.round(((totalPoi - critici) / totalPoi) * 100) : 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <BarChart2 className="w-4 h-4 text-primary" />
          <h1 className="text-base font-display font-bold">Qualità del Servizio</h1>
          <span className="text-[10px] text-muted-foreground ml-1">· analisi oraria per POI · coincidenze ai nodi</span>
        </div>

        {/* KPI strip */}
        <div className="flex gap-2 flex-wrap">
          <KpiCard icon={<GraduationCap className="w-3.5 h-3.5 text-violet-400" />}
            label="Scuole analizzate" value={String(data.schools.stats.total)}
            sub={`${data.schools.stats.ottimo + data.schools.stats.buono} ben servite`} color="text-violet-400" />
          <KpiCard icon={<Building2 className="w-3.5 h-3.5 text-blue-400" />}
            label="Uffici / Produttivo" value={String(data.offices.stats.total)}
            sub={`${data.offices.stats.critico} critici`} color="text-blue-400" />
          <KpiCard icon={<Stethoscope className="w-3.5 h-3.5 text-rose-400" />}
            label="Ospedali" value={String(data.hospitals.stats.total)}
            sub={`${data.hospitals.stats.ottimo} ottimi`} color="text-rose-400" />
          <KpiCard icon={<ArrowLeftRight className="w-3.5 h-3.5 text-amber-400" />}
            label="Nodi di scambio" value={String(data.hubs.stats.total)}
            sub={`${data.hubs.stats.ottimo} con buone coincidenze`} color="text-amber-400" />
          <KpiCard icon={<CheckCircle className="w-3.5 h-3.5 text-emerald-400" />}
            label="Copertura POI" value={`${pctOk}%`}
            sub={`${critici} POI critici su ${totalPoi}`} color="text-emerald-400" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-4 py-1.5 border-b border-border/30 shrink-0">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-lg border transition-all ${
              tab === t.id
                ? "bg-primary/10 border-primary/30 text-primary font-medium"
                : "border-border/30 text-muted-foreground hover:text-foreground hover:border-border"
            }`}>
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {tab === "schools" && (
            <motion.div key="schools" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 max-w-3xl space-y-4">
              <MethodBox
                title="Come analizziamo le scuole"
                text={`Per ogni istituto scolastico (medie, superiori, università) troviamo le fermate GTFS entro 500 m e contiamo quanti autobus passano nelle fasce di ingresso (${data.timeWindows.school.entry}) e uscita (${data.timeWindows.school.exit}). Un istituto è "critico" se ha meno di 5 bus totali nelle fasce chiave — gli studenti rischiano di non trovare corse compatibili con gli orari scolastici.`}
              />
              <VerdictBar stats={data.schools.stats} />
              <PoiList items={data.schools.items} entryLabel="Ingresso" exitLabel="Uscita" />
            </motion.div>
          )}
          {tab === "offices" && (
            <motion.div key="offices" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 max-w-3xl space-y-4">
              <MethodBox
                title="Come analizziamo uffici e zone produttive"
                text={`Per ogni ufficio pubblico, municipio, tribunale e centro produttivo verifichiamo la copertura bus nelle fasce pendolari: ingresso (${data.timeWindows.office.entry}) e uscita (${data.timeWindows.office.exit}). Gli uffici pubblici generano flussi prevedibili: apertura sportelli, turni impiegati, udienze. Se un ufficio ha meno di 5 bus nelle fasce chiave, il lavoratore pendolare ha poche alternative all'auto.`}
              />
              <VerdictBar stats={data.offices.stats} />
              <PoiList items={data.offices.items} entryLabel="Entrata" exitLabel="Uscita" />
            </motion.div>
          )}
          {tab === "hospitals" && (
            <motion.div key="hospitals" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 max-w-3xl space-y-4">
              <MethodBox
                title="Come analizziamo gli ospedali"
                text={`Gli ospedali hanno flussi distribuiti su tutta la giornata: turni infermieristici (${data.timeWindows.hospital.am} e ${data.timeWindows.hospital.pm}), visite ambulatoriali, emergenze. Analizziamo la copertura bus in entrambe le fasce per ciascun ospedale e struttura sanitaria della provincia.`}
              />
              <VerdictBar stats={data.hospitals.stats} />
              <PoiList items={data.hospitals.items} entryLabel="Mattina" exitLabel="Pomeriggio" />
            </motion.div>
          )}
          {tab === "hubs" && (
            <motion.div key="hubs" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 max-w-3xl space-y-4">
              <MethodBox
                title="Come analizziamo i nodi di scambio"
                text="Un nodo di scambio è una fermata (o cluster di fermate entro 200 m) dove convergono almeno 5 linee diverse. Analizziamo le coincidenze nella fascia mattutina (06:30–09:30): due linee hanno una buona coincidenza se passano entro 10 minuti l'una dall'altra. Più coincidenze = più possibilità per chi viene da comuni diversi di cambiare linea e raggiungere la destinazione. Un nodo con poche coincidenze è un collo di bottiglia."
              />
              <VerdictBar stats={data.hubs.stats} />
              <HubList items={data.hubs.items} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Methodology Box ──────────────────────────────────────────
function MethodBox({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border rounded-xl transition-all ${open ? "border-primary/30 bg-primary/5" : "border-border/30 bg-muted/10"}`}>
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <Info className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-semibold text-primary flex-1">{title}</span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <p className="text-[11px] text-muted-foreground px-3 pb-3 leading-relaxed">{text}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Verdict Horizontal Bar ───────────────────────────────────
function VerdictBar({ stats }: { stats: VerdictStats }) {
  if (stats.total === 0) return null;
  const segments: { key: string; count: number; pct: number; cfg: typeof V_CFG["ottimo"] }[] = [
    { key: "ottimo",      count: stats.ottimo,      pct: (stats.ottimo / stats.total) * 100,      cfg: V_CFG.ottimo },
    { key: "buono",       count: stats.buono,       pct: (stats.buono / stats.total) * 100,       cfg: V_CFG.buono },
    { key: "sufficiente", count: stats.sufficiente, pct: (stats.sufficiente / stats.total) * 100, cfg: V_CFG.sufficiente },
    { key: "critico",     count: stats.critico,     pct: (stats.critico / stats.total) * 100,     cfg: V_CFG.critico },
  ].filter(s => s.count > 0);

  return (
    <div>
      {/* Bar */}
      <div className="h-5 w-full rounded-full overflow-hidden flex border border-border/30">
        {segments.map(s => (
          <motion.div key={s.key} initial={{ width: 0 }} animate={{ width: `${s.pct}%` }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className={`h-full ${s.cfg.bg} flex items-center justify-center`}
            title={`${s.cfg.label}: ${s.count}`}>
            {s.pct > 12 && <span className={`text-[9px] font-bold ${s.cfg.color}`}>{s.count}</span>}
          </motion.div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex gap-3 mt-1.5 flex-wrap">
        {segments.map(s => (
          <div key={s.key} className="flex items-center gap-1">
            <span className="text-[10px]">{s.cfg.icon}</span>
            <span className={`text-[10px] font-semibold ${s.cfg.color}`}>{s.count}</span>
            <span className="text-[10px] text-muted-foreground">{s.cfg.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── POI List ─────────────────────────────────────────────────
function PoiList({ items, entryLabel, exitLabel }: {
  items: PoiItem[]; entryLabel: string; exitLabel: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, 15);

  return (
    <div className="space-y-1.5">
      {visible.map((item, i) => {
        const v = V_CFG[item.verdict];
        const allRoutes = [...new Set([...item.entryRoutes, ...item.exitRoutes])];
        return (
          <motion.div key={i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.015 }}
            className={`flex items-center gap-3 rounded-xl border ${v.border} ${v.bg} px-3 py-2`}>
            {/* Verdict icon */}
            <span className="text-sm shrink-0">{v.icon}</span>

            {/* Name + stop */}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{item.name}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <MapPin className="w-2.5 h-2.5 text-muted-foreground/60" />
                <span className="text-[10px] text-muted-foreground truncate">{item.nearestStop} · {item.distM}m</span>
              </div>
            </div>

            {/* Bus counts */}
            <div className="flex gap-2 shrink-0">
              <div className="text-center">
                <p className={`text-xs font-bold ${v.color}`}>{item.entryBuses}</p>
                <p className="text-[8px] text-muted-foreground">{entryLabel}</p>
              </div>
              <div className="text-center">
                <p className={`text-xs font-bold ${v.color}`}>{item.exitBuses}</p>
                <p className="text-[8px] text-muted-foreground">{exitLabel}</p>
              </div>
            </div>

            {/* Routes badge */}
            <div className="flex flex-wrap gap-0.5 max-w-[60px] justify-end shrink-0">
              {allRoutes.slice(0, 3).map(r => (
                <span key={r} className="text-[8px] font-bold px-1 py-0.5 rounded bg-muted/40 border border-border/40 text-muted-foreground">
                  {r}
                </span>
              ))}
              {allRoutes.length > 3 && (
                <span className="text-[8px] text-muted-foreground/50">+{allRoutes.length - 3}</span>
              )}
            </div>
          </motion.div>
        );
      })}
      {items.length > 15 && (
        <button onClick={() => setShowAll(!showAll)}
          className="text-[11px] text-primary hover:underline px-2 py-1">
          {showAll ? "Mostra meno" : `Mostra tutti (${items.length})`}
        </button>
      )}
    </div>
  );
}

// ─── Hub List ─────────────────────────────────────────────────
function HubList({ items }: { items: HubItem[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="space-y-2">
      {items.map((hub, i) => {
        const v = V_CFG[hub.transferScore];
        const isOpen = expanded === i;
        return (
          <div key={i} className={`rounded-xl border ${v.border} overflow-hidden transition-all`}>
            {/* Hub header */}
            <button onClick={() => setExpanded(isOpen ? null : i)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 ${v.bg} text-left`}>
              <span className="text-sm shrink-0">{v.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate">{hub.stopName}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {hub.routeCount} linee · {hub.transferPairs.length} coincidenze trovate
                </p>
              </div>
              <div className="flex flex-wrap gap-0.5 max-w-[120px] justify-end shrink-0">
                {hub.routes.slice(0, 6).map(r => (
                  <span key={r.id} className="text-[8px] font-bold px-1.5 py-0.5 rounded text-white"
                    style={{ backgroundColor: rc(r.color) }}>
                    {r.shortName}
                  </span>
                ))}
                {hub.routes.length > 6 && (
                  <span className="text-[8px] text-muted-foreground/60">+{hub.routes.length - 6}</span>
                )}
              </div>
              {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            </button>

            {/* Transfer pairs detail */}
            <AnimatePresence>
              {isOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="px-3 py-2 border-t border-border/20 space-y-1.5">
                    <p className="text-[10px] text-muted-foreground mb-1">
                      Coincidenze nella fascia mattutina (06:30–09:30) — distanza ≤ 10min
                    </p>
                    {hub.transferPairs.length === 0 && (
                      <p className="text-[10px] text-muted-foreground/60 italic">Nessuna coincidenza trovata</p>
                    )}
                    {hub.transferPairs.map((tp, j) => (
                      <div key={j} className="flex items-center gap-2 bg-card/40 rounded-lg px-2.5 py-1.5">
                        <span className="text-[10px] font-bold text-primary bg-primary/10 rounded px-1.5 py-0.5">
                          {tp.routeA}
                        </span>
                        <Clock className="w-2.5 h-2.5 text-muted-foreground/50" />
                        <span className="text-[11px] font-mono">{tp.timeA}</span>
                        <ArrowLeftRight className="w-3 h-3 text-muted-foreground/40" />
                        <span className="text-[10px] font-bold text-violet-400 bg-violet-500/10 rounded px-1.5 py-0.5">
                          {tp.routeB}
                        </span>
                        <Clock className="w-2.5 h-2.5 text-muted-foreground/50" />
                        <span className="text-[11px] font-mono">{tp.timeB}</span>
                        <span className={`ml-auto text-[10px] font-bold rounded-full px-2 py-0.5 ${
                          tp.deltaMin <= 2
                            ? "text-emerald-400 bg-emerald-500/15"
                            : tp.deltaMin <= 5
                            ? "text-blue-400 bg-blue-500/15"
                            : "text-yellow-400 bg-yellow-500/15"
                        }`}>
                          {tp.deltaMin === 0 ? "⚡ Simultaneo" : `Δ ${tp.deltaMin}min`}
                        </span>
                      </div>
                    ))}

                    {/* All routes at this hub */}
                    <div className="mt-2 pt-2 border-t border-border/20">
                      <p className="text-[10px] text-muted-foreground mb-1">Tutte le linee che transitano qui:</p>
                      <div className="flex flex-wrap gap-1">
                        {hub.routes.map(r => (
                          <span key={r.id} className="text-[9px] font-bold px-1.5 py-0.5 rounded text-white"
                            style={{ backgroundColor: rc(r.color) }}>
                            {r.shortName}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}

// ─── KpiCard ──────────────────────────────────────────────────
function KpiCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub: string; color: string;
}) {
  return (
    <div className="flex items-center gap-2 bg-card/40 border border-border/30 rounded-xl px-3 py-2">
      {icon}
      <div>
        <p className={`text-sm font-bold leading-none ${color}`}>{value}</p>
        <p className="text-[9px] text-muted-foreground leading-tight mt-0.5">{label}</p>
        <p className="text-[9px] text-muted-foreground/60 leading-tight">{sub}</p>
      </div>
    </div>
  );
}
