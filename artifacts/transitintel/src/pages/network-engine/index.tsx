/**
 * Network Engine — Hub (splash dinamico).
 *
 * Landing page del modulo Network Engine: il "Crea Servizio" del software.
 * Da qui si accede a:
 *  - Planner Studio (database del servizio: fermate, linee, percorsi, orari)
 *  - Scenari (variazioni e ipotesi)
 *  - Planner Legacy (analisi GTFS)
 *  - Zone Coincidenza
 *  - Intermodale
 *
 * Tema: viola/fuchsia/magenta. Hero con logo planningstudio.png e
 * mappa metropolitana SVG animata (linee colorate + punti luminosi che
 * viaggiano sulle tratte, come treni in transito).
 */
import React from "react";
import { Link } from "wouter";
import { motion } from "framer-motion";
import {
  Map, Network, Route, Layers, Zap, ArrowRightLeft, Sparkles, Database,
  GitBranch, ArrowRight,
} from "lucide-react";

interface ToolCard {
  href: string;
  title: string;
  subtitle: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  primary?: boolean;
}

const PRIMARY_TOOLS: ToolCard[] = [
  {
    href: "/planning-studio",
    title: "Planner Studio",
    subtitle: "Database del servizio",
    description:
      "Disegna fermate sulla mappa, costruisci linee e varianti con percorsi snappati alle strade (OSRM), gestisci calendari e orari. Tutto in un unico ambiente cartografico.",
    icon: Map,
    badge: "Core · L1-L5",
    primary: true,
  },
];

const SECONDARY_TOOLS: ToolCard[] = [
  {
    href: "/scenarios",
    title: "Scenari",
    subtitle: "Variazioni & ipotesi",
    description: "Crea varianti del servizio per simulare modifiche, confronti A/B e ipotesi di esercizio.",
    icon: Route,
  },
  {
    href: "/planning",
    title: "Planner Legacy",
    subtitle: "Analisi GTFS",
    description: "Analisi sul feed GTFS importato, KPI di rete e supporto alle decisioni in modalità read-only.",
    icon: Layers,
  },
  {
    href: "/coincidence-zones",
    title: "Zone Coincidenza",
    subtitle: "Hub & trasbordi",
    description: "Definisci aree dove gestire le coincidenze tra linee per garantire connessioni fluide.",
    icon: Zap,
  },
  {
    href: "/planning-studio",
    title: "Intermodale",
    subtitle: "Treno · gomma",
    description: "Coincidenze bus↔treno sui nodi di scambio: si apre dentro un progetto Planner Studio, sulla rete di quel progetto.",
    icon: ArrowRightLeft,
  },
];

export default function NetworkEngineHub() {
  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-purple-950/40 via-zinc-950 to-black text-foreground">
      {/* ─── HERO con metro map animata ─── */}
      <Hero />

      {/* ─── Strumenti ─── */}
      <div className="max-w-7xl mx-auto px-6 sm:px-10 py-10 sm:py-14 space-y-12">
        <section>
          <SectionHeader
            number="01"
            title="Database del Servizio"
            subtitle="L'ambiente cartografico dove costruire la rete"
          />
          <div className="grid grid-cols-1 gap-4">
            {PRIMARY_TOOLS.map((t, i) => (
              <PrimaryCard key={t.href} tool={t} index={i} />
            ))}
          </div>
        </section>

        <section>
          <SectionHeader
            number="02"
            title="Pianificazione & Analisi"
            subtitle="Strumenti complementari per scenari, ipotesi e integrazione"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {SECONDARY_TOOLS.map((t, i) => (
              <SecondaryCard key={t.href} tool={t} index={i} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ───────────────────────── HERO ───────────────────────── */

function Hero() {
  return (
    <div className="relative overflow-hidden border-b border-purple-900/40">
      {/* Sfondi multilivello */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,_rgba(168,85,247,0.25),_transparent_60%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_75%_80%,_rgba(217,70,239,0.18),_transparent_60%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#a855f70a_1px,transparent_1px),linear-gradient(to_bottom,#a855f70a_1px,transparent_1px)] bg-[size:32px_32px]" />

      <div className="relative max-w-7xl mx-auto px-6 sm:px-10 py-14 sm:py-20 grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-10 items-center">
        {/* COLONNA SX: brand + payoff */}
        <motion.div
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10"
        >
          {/* Logo + brand */}
          <div className="flex items-center gap-4 mb-6">
            <div className="relative shrink-0">
              <div className="absolute -inset-3 bg-gradient-to-br from-fuchsia-500/40 to-purple-600/30 rounded-2xl blur-2xl opacity-70 animate-pulse" />
              <img
                src="/planningstudio.png"
                alt="Network Engine"
                className="relative w-20 h-20 sm:w-24 sm:h-24 rounded-2xl object-contain drop-shadow-[0_0_25px_rgba(217,70,239,0.5)]"
                onError={(e) => {
                  // Fallback se il file non esistesse: nasconde l'immagine
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-fuchsia-300/70">
                Cerbero · Suite
              </p>
              <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.05] bg-gradient-to-r from-fuchsia-200 via-purple-100 to-violet-300 bg-clip-text text-transparent">
                Network Engine
              </h1>
            </div>
          </div>

          <p className="text-base sm:text-lg text-purple-100/80 leading-relaxed max-w-xl">
            Il <span className="text-fuchsia-300 font-semibold">database vivente</span> del tuo
            servizio di trasporto. Disegna la rete sulla mappa, costruisci{" "}
            <span className="text-purple-200 font-semibold">linee, varianti e orari</span>,
            gestisci scenari e coincidenze in un unico ambiente cartografico.
          </p>

          {/* Stat strip */}
          <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-2xl">
            <StatPill icon={Database} label="Modello dati" value="L1-L5" />
            <StatPill icon={GitBranch} label="Varianti / linea" value="∞" />
            <StatPill icon={Sparkles} label="Snap su strade" value="OSRM" />
            <StatPill icon={Network} label="Condivisione team" value="RBAC" />
          </div>

          {/* CTA */}
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/planning-studio">
              <button className="group inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white font-bold text-sm shadow-[0_0_30px_rgba(217,70,239,0.4)] hover:shadow-[0_0_40px_rgba(217,70,239,0.6)] transition-shadow">
                <Map className="w-4 h-4" /> Apri Planner Studio
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
            </Link>
            <Link href="/scenarios">
              <button className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl border border-purple-500/40 text-purple-200 font-semibold text-sm hover:bg-purple-500/10 transition-colors">
                <Route className="w-4 h-4" /> Scenari
              </button>
            </Link>
          </div>
        </motion.div>

        {/* COLONNA DX: METRO MAP ANIMATA */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="relative w-full aspect-[4/3] max-w-xl mx-auto"
          aria-hidden
        >
          <MetroMap />
        </motion.div>
      </div>
    </div>
  );
}

/* ────────── METRO MAP ANIMATA (SVG) ────────── */

/**
 * Mappa metropolitana stilizzata con 4 linee colorate (viola/fucsia/rosa/magenta)
 * che si intrecciano in stazioni di interscambio. Su ogni linea scorre un
 * "treno" luminoso (animateMotion) e ogni stazione ha un anello pulsante.
 */
function MetroMap() {
  // Path delle 4 linee — coordinate scelte per intrecci leggibili.
  // viewBox 0 0 600 460
  const lines: Array<{
    id: string; d: string; color: string; speed: number; reverse?: boolean;
  }> = [
    {
      id: "L1",
      d: "M 60 90 L 200 90 L 240 130 L 240 250 L 320 330 L 540 330",
      color: "#a855f7", // purple-500
      speed: 9,
    },
    {
      id: "L2",
      d: "M 80 380 L 240 380 L 280 340 L 380 240 L 380 60",
      color: "#d946ef", // fuchsia-500
      speed: 11,
      reverse: true,
    },
    {
      id: "L3",
      d: "M 520 60 L 380 60 L 320 120 L 240 250 L 180 310 L 80 310",
      color: "#ec4899", // pink-500
      speed: 13,
    },
    {
      id: "L4",
      d: "M 540 200 L 460 200 L 380 240 L 320 330 L 220 410",
      color: "#c084fc", // purple-300/400
      speed: 7,
      reverse: true,
    },
  ];

  // Stazioni — alcune sono interscambio (hub) → cerchio più grande.
  const stations: Array<{ x: number; y: number; hub?: boolean; label?: string }> = [
    { x: 60,  y: 90,  label: "T1" },
    { x: 200, y: 90,  hub: true },
    { x: 240, y: 130 },
    { x: 240, y: 250, hub: true, label: "Centro" },
    { x: 320, y: 330, hub: true },
    { x: 540, y: 330, label: "T2" },
    { x: 80,  y: 380, label: "T3" },
    { x: 280, y: 340 },
    { x: 380, y: 240, hub: true },
    { x: 380, y: 60,  label: "T4" },
    { x: 520, y: 60,  label: "T5" },
    { x: 320, y: 120 },
    { x: 180, y: 310 },
    { x: 80,  y: 310, label: "T6" },
    { x: 540, y: 200, label: "T7" },
    { x: 460, y: 200 },
    { x: 220, y: 410, label: "T8" },
  ];

  return (
    <svg
      viewBox="0 0 600 460"
      className="w-full h-full"
      style={{ filter: "drop-shadow(0 0 20px rgba(168, 85, 247, 0.25))" }}
    >
      <defs>
        {/* Glow soft per le linee */}
        <filter id="metroGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Glow forte per i "treni" */}
        <radialGradient id="trainGlow">
          <stop offset="0%" stopColor="#fff" stopOpacity="1" />
          <stop offset="40%" stopColor="#fff" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Grid leggero di sfondo */}
      <g opacity="0.08">
        {Array.from({ length: 13 }).map((_, i) => (
          <line key={`gv${i}`} x1={i * 50} y1={0} x2={i * 50} y2={460}
                stroke="#a855f7" strokeWidth="0.5" />
        ))}
        {Array.from({ length: 10 }).map((_, i) => (
          <line key={`gh${i}`} x1={0} y1={i * 50} x2={600} y2={i * 50}
                stroke="#a855f7" strokeWidth="0.5" />
        ))}
      </g>

      {/* Tracce linee — disegno progressivo */}
      {lines.map((l, idx) => (
        <g key={l.id}>
          {/* Halo */}
          <path
            d={l.d}
            stroke={l.color}
            strokeOpacity="0.18"
            strokeWidth="14"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#metroGlow)"
          />
          {/* Tratto principale */}
          <path
            id={`metro-line-${l.id}`}
            d={l.d}
            stroke={l.color}
            strokeWidth="4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Disegno progressivo iniziale */}
            <animate
              attributeName="stroke-dasharray"
              from="0 2000"
              to="2000 0"
              dur={`${1.2 + idx * 0.25}s`}
              fill="freeze"
            />
          </path>

          {/* "Treno" luminoso che scorre lungo la linea */}
          <g>
            <circle r="6" fill="#fff" filter="url(#metroGlow)">
              <animateMotion
                dur={`${l.speed}s`}
                repeatCount="indefinite"
                rotate="auto"
                keyPoints={l.reverse ? "1;0" : "0;1"}
                keyTimes="0;1"
              >
                <mpath xlinkHref={`#metro-line-${l.id}`} />
              </animateMotion>
            </circle>
            <circle r="10" fill="url(#trainGlow)">
              <animateMotion
                dur={`${l.speed}s`}
                repeatCount="indefinite"
                keyPoints={l.reverse ? "1;0" : "0;1"}
                keyTimes="0;1"
              >
                <mpath xlinkHref={`#metro-line-${l.id}`} />
              </animateMotion>
            </circle>
          </g>
        </g>
      ))}

      {/* Stazioni */}
      {stations.map((s, i) => (
        <g key={i}>
          {/* Anello pulsante per gli hub */}
          {s.hub && (
            <circle cx={s.x} cy={s.y} r="10" fill="none" stroke="#f0abfc" strokeWidth="1.5" opacity="0.6">
              <animate attributeName="r" from="8" to="20" dur="2.4s" repeatCount="indefinite" />
              <animate attributeName="opacity" from="0.7" to="0" dur="2.4s" repeatCount="indefinite" />
            </circle>
          )}
          {/* Cerchio stazione */}
          <circle
            cx={s.x}
            cy={s.y}
            r={s.hub ? 7 : 4.5}
            fill={s.hub ? "#fdf4ff" : "#0a0a0a"}
            stroke={s.hub ? "#d946ef" : "#a855f7"}
            strokeWidth={s.hub ? 2.5 : 2}
          />
          {/* Etichetta capolinea */}
          {s.label && (
            <text
              x={s.x}
              y={s.y - 12}
              fill="#e9d5ff"
              fontSize="10"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
              fontWeight="600"
              textAnchor="middle"
              opacity="0.7"
            >
              {s.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/* ───────────── UI helpers ───────────── */

function StatPill({
  icon: Icon, label, value,
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-purple-500/5 border border-purple-500/20 backdrop-blur-sm">
      <Icon className="w-4 h-4 text-fuchsia-300 shrink-0" />
      <div className="min-w-0">
        <p className="text-[9px] uppercase tracking-widest text-purple-400/60 font-mono leading-none">{label}</p>
        <p className="text-sm font-bold text-purple-100 mt-0.5">{value}</p>
      </div>
    </div>
  );
}

function SectionHeader({ number, title, subtitle }: { number: string; title: string; subtitle: string }) {
  return (
    <div className="mb-5 flex items-baseline gap-3">
      <span className="text-xs font-mono text-purple-400/40 tracking-widest">{number}</span>
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-purple-100 tracking-tight">{title}</h2>
        <p className="text-xs text-purple-300/50 mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

function PrimaryCard({ tool, index }: { tool: ToolCard; index: number }) {
  const Icon = tool.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 + index * 0.05 }}
    >
      <Link href={tool.href}>
        <div
          className="group relative overflow-hidden rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-900/30 via-purple-950/20 to-fuchsia-950/20 p-6 sm:p-8 cursor-pointer hover:border-fuchsia-400/60 hover:from-purple-900/40 transition-all"
        >
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(217,70,239,0.18),_transparent_70%)] pointer-events-none" />
          <div className="relative flex items-start gap-5">
            <div className="shrink-0 w-14 h-14 flex items-center justify-center rounded-xl bg-fuchsia-500/20 border border-fuchsia-400/30 group-hover:scale-105 transition-transform">
              <Icon className="w-7 h-7 text-fuchsia-200" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-xl sm:text-2xl font-bold text-purple-50">{tool.title}</h3>
                {tool.badge && (
                  <span className="text-[9px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/30">
                    {tool.badge}
                  </span>
                )}
              </div>
              <p className="text-sm text-purple-300/80 font-medium mb-2">{tool.subtitle}</p>
              <p className="text-sm text-purple-200/60 leading-relaxed max-w-2xl">{tool.description}</p>
            </div>
            <ArrowRight className="w-5 h-5 text-purple-300/40 group-hover:text-fuchsia-200 group-hover:translate-x-1 transition-all shrink-0 mt-2" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}

function SecondaryCard({ tool, index }: { tool: ToolCard; index: number }) {
  const Icon = tool.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 + index * 0.05 }}
    >
      <Link href={tool.href}>
        <div className="group h-full rounded-xl border border-purple-500/20 bg-purple-500/5 p-5 cursor-pointer hover:border-fuchsia-400/40 hover:bg-purple-500/10 transition-all">
          <div className="flex items-start gap-4">
            <div className="shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-purple-500/15 border border-purple-500/20 group-hover:bg-fuchsia-500/20 transition-colors">
              <Icon className="w-5 h-5 text-purple-300 group-hover:text-fuchsia-200 transition-colors" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-purple-100 mb-0.5">{tool.title}</h3>
              <p className="text-[11px] text-purple-300/60 font-mono uppercase tracking-wider mb-2">{tool.subtitle}</p>
              <p className="text-xs text-purple-200/60 leading-relaxed">{tool.description}</p>
            </div>
            <ArrowRight className="w-4 h-4 text-purple-300/30 group-hover:text-fuchsia-200 group-hover:translate-x-0.5 transition-all shrink-0" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
