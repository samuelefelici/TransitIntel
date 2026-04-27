/**
 * Fares Engine — Landing Page
 *
 * Stessa struttura della SplashScreen di Fucina, palette verde dal logo.
 * Sfondo geometrico enterprise (griglia + esagoni in slow-pulse).
 */
import React from "react";
import { motion } from "framer-motion";
import {
  Ticket, BarChart3, Gamepad2, BookOpen, MapPinCheck, ArrowRight,
} from "lucide-react";

const MODULES = [
  { label: "Bigliettazione",      icon: Ticket },
  { label: "Analisi Tariffaria",  icon: BarChart3 },
  { label: "Simulatore",          icon: Gamepad2 },
  { label: "Metodologia & Docs",  icon: BookOpen },
  { label: "Classifica Fermate",  icon: MapPinCheck },
] as const;

/* ── Sfondo geometrico enterprise ────────────────────────── */
function GeometricBackdrop() {
  // Griglia di esagoni; coordinate in unità "esagono"
  const cols = 14;
  const rows = 9;
  const hexSize = 40; // px
  const hexW = hexSize * Math.sqrt(3);
  const hexH = hexSize * 2;
  const rowOffset = hexH * 0.75;

  const hexagons = React.useMemo(() => {
    const arr: { cx: number; cy: number; delay: number; weight: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = c * hexW + (r % 2 ? hexW / 2 : 0);
        const cy = r * rowOffset;
        // peso casuale fisso per cella
        arr.push({
          cx,
          cy,
          delay: Math.random() * 6,
          weight: Math.random(),
        });
      }
    }
    return arr;
  }, []);

  // Path esagono centrato (puntato in alto)
  const hexPath = React.useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push(`${(hexSize * Math.cos(a)).toFixed(2)},${(hexSize * Math.sin(a)).toFixed(2)}`);
    }
    return `M${pts.join(" L")} Z`;
  }, []);

  const totalW = cols * hexW + hexW;
  const totalH = rows * rowOffset + hexH;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {/* Griglia tecnica sottile */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(0,160,96,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,160,96,0.06) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      {/* Esagoni */}
      <svg
        className="absolute left-1/2 top-1/2"
        width={totalW}
        height={totalH}
        style={{
          transform: `translate(-50%, -50%)`,
          maskImage:
            "radial-gradient(ellipse 50% 50% at 50% 50%, transparent 0%, transparent 18%, black 60%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 50% 50% at 50% 50%, transparent 0%, transparent 18%, black 60%)",
        }}
      >
        {hexagons.map((h, i) => (
          <g key={i} transform={`translate(${h.cx},${h.cy})`}>
            <motion.path
              d={hexPath}
              fill="none"
              stroke={h.weight > 0.7 ? "#34d399" : "#0a8060"}
              strokeWidth={0.6}
              initial={{ opacity: 0.05 }}
              animate={{
                opacity: [0.05, 0.05 + h.weight * 0.4, 0.05],
              }}
              transition={{
                duration: 5 + h.weight * 4,
                repeat: Infinity,
                delay: h.delay,
                ease: "easeInOut",
              }}
            />
            {h.weight > 0.85 && (
              <motion.path
                d={hexPath}
                fill="#34d399"
                opacity={0.08}
                animate={{ opacity: [0, 0.18, 0] }}
                transition={{
                  duration: 6,
                  repeat: Infinity,
                  delay: h.delay + 0.5,
                  ease: "easeInOut",
                }}
              />
            )}
          </g>
        ))}
      </svg>

      {/* Linee diagonali sottili che attraversano lentamente */}
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="absolute h-px"
          style={{
            top: `${20 + i * 30}%`,
            left: 0,
            right: 0,
            background:
              "linear-gradient(to right, transparent 0%, rgba(52,211,153,0.45) 50%, transparent 100%)",
            boxShadow: "0 0 6px rgba(52,211,153,0.35)",
          }}
          initial={{ x: "-100%" }}
          animate={{ x: ["-100%", "100%"] }}
          transition={{
            duration: 14 + i * 4,
            repeat: Infinity,
            delay: i * 5,
            ease: "linear",
          }}
        />
      ))}

      {/* Vignettatura scura centrale per far risaltare il logo */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 30% 35% at 50% 48%, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0) 80%)",
        }}
      />
    </div>
  );
}

export default function FaresEnginePage() {
  return (
    <div
      className="relative h-full w-full overflow-hidden flex flex-col items-center justify-center"
      style={{
        background:
          "radial-gradient(ellipse at 50% 50%, #001a10 0%, #00100a 55%, #000604 85%, #000000 100%)",
      }}
    >
      <GeometricBackdrop />

      {/* Logo */}
      <motion.div
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.7, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative mb-6 z-10"
      >
        <div className="absolute inset-0 blur-3xl bg-emerald-500/40 rounded-full scale-125 pointer-events-none" />
        <div className="absolute inset-0 blur-2xl bg-lime-400/25 rounded-full scale-110 pointer-events-none" />
        <img
          src="/faresengine.png"
          alt="Fares Engine"
          className="relative h-52 w-auto drop-shadow-[0_0_45px_rgba(52,211,153,0.7)]"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      </motion.div>

      {/* Titolo + descrizione + pills */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.4 }}
        className="text-center px-6 z-10"
      >
        <motion.h1
          className="text-4xl font-black tracking-tight mb-1 inline-block"
          animate={{ backgroundPositionX: ["0%", "100%", "0%"] }}
          transition={{ duration: 14, repeat: Infinity, ease: "linear" }}
          style={{
            backgroundImage:
              "linear-gradient(110deg, #006040 0%, #008060 18%, #00a060 35%, #34d36a 55%, #80e040 75%, #a3e635 92%)",
            backgroundSize: "220% 100%",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          FARES ENGINE
        </motion.h1>
        <p className="text-sm text-emerald-300/70 font-mono mb-2 tracking-widest uppercase">
          EMV · Account-Based · Tariff Intelligence
        </p>
        <p className="text-sm text-emerald-200/55 max-w-sm mx-auto leading-relaxed mt-3">
          Cinque moduli, un unico cervello tariffario — bigliettazione, analisi, simulazione, metodologia e classifica fermate fusi in un motore di intelligence economica.
        </p>

        <div className="flex items-center justify-center gap-1.5 flex-wrap mt-5">
          {MODULES.map((m, i) => (
            <React.Fragment key={m.label}>
              <span className="flex items-center gap-1.5 text-[10px] px-2.5 py-1 rounded-full border border-emerald-500/30 text-emerald-400/80 bg-emerald-500/5 backdrop-blur-sm">
                <m.icon className="w-3 h-3" />
                {m.label}
              </span>
              {i < MODULES.length - 1 && <ArrowRight className="w-2.5 h-2.5 text-emerald-400/30 shrink-0" />}
            </React.Fragment>
          ))}
        </div>
      </motion.div>
    </div>
  );
}
