/**
 * VirgilioTentacles — overlay SVG full-screen.
 *
 * Quando arriva un evento 'virgilio:highlight', cerca l'elemento DOM con
 * data-virgilio-id="<target>" e disegna un tentacolo bezier animato
 * dall'avatar di Virgilio (in basso a destra) fino all'elemento, che pulsa.
 *
 * Tentacolo = path SVG con stroke-dasharray animato + glow + curva di controllo
 * che oscilla leggermente per dare vita organica.
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { VIRGILIO_EVENTS } from "@/lib/virgilio-bus";

type Tentacle = {
  id: string;
  target: string;
  label?: string;
  color: "emerald" | "amber" | "rose" | "cyan";
  from: { x: number; y: number };
  to: { x: number; y: number };
  control: { x: number; y: number };
  bornAt: number;
};

const COLOR_HEX: Record<Tentacle["color"], string> = {
  emerald: "#34d399",
  amber: "#fbbf24",
  rose: "#fb7185",
  cyan: "#22d3ee",
};

const TENTACLE_TTL_MS = 9000; // tempo di vita tentacolo

export default function VirgilioTentacles() {
  const [tentacles, setTentacles] = React.useState<Tentacle[]>([]);
  const [, force] = React.useReducer((x) => x + 1, 0);

  // Origine = punto di ancoraggio.
  // Preferisci 'open' (octopus nell'header della sidebar) se presente,
  // altrimenti fallback su 'true' (bottone floating).
  const getOrigin = React.useCallback((): { x: number; y: number } => {
    const open = document.querySelector('[data-virgilio-anchor="open"]') as HTMLElement | null;
    const anchor =
      open ||
      (document.querySelector("[data-virgilio-anchor]") as HTMLElement | null);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return { x: window.innerWidth - 40, y: window.innerHeight - 40 };
  }, []);

  // Trova l'elemento target dal data-virgilio-id
  const findTarget = (id: string): { x: number; y: number } | null => {
    const el = document.querySelector(`[data-virgilio-id="${id}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // Pulsa l'elemento target (CSS class temporanea)
  const pulseTarget = (id: string, color: string) => {
    const el = document.querySelector(`[data-virgilio-id="${id}"]`) as HTMLElement | null;
    if (!el) return;
    // Scrolla in vista (centrato) — fluido
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    } catch {
      el.scrollIntoView();
    }
    el.style.transition = "box-shadow 0.4s, outline 0.4s, background-color 0.4s";
    el.style.outline = `2px solid ${color}`;
    el.style.outlineOffset = "2px";
    el.style.boxShadow = `0 0 24px ${color}cc, inset 0 0 12px ${color}33`;
    setTimeout(() => {
      el.style.outline = "";
      el.style.boxShadow = "";
    }, TENTACLE_TTL_MS);
  };

  React.useEffect(() => {
    const onHighlight = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        target: string;
        label?: string;
        color?: Tentacle["color"];
      };
      // Retry: la pagina target potrebbe essere lazy-loaded e ancora in fetch.
      // Tentiamo fino a 6 volte ogni 400ms (≈ 2.4s totali).
      let attempts = 0;
      const tryHighlight = () => {
        attempts++;
        const to = findTarget(detail.target);
        if (!to) {
          if (attempts < 6) {
            setTimeout(tryHighlight, 400);
            return;
          }
          // eslint-disable-next-line no-console
          console.warn("[Virgilio] target non trovato dopo retry:", detail.target);
          return;
        }
        const from = getOrigin();
        const midX = (from.x + to.x) / 2;
        const midY = (from.y + to.y) / 2;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const perpX = -dy / len;
        const perpY = dx / len;
        const curveAmount = Math.min(180, len * 0.35);
        const control = {
          x: midX + perpX * curveAmount,
          y: midY + perpY * curveAmount,
        };
        const t: Tentacle = {
          id: crypto.randomUUID(),
          target: detail.target,
          label: detail.label,
          color: detail.color || "emerald",
          from,
          to,
          control,
          bornAt: Date.now(),
        };
        setTentacles((prev) => [...prev, t]);
        pulseTarget(detail.target, COLOR_HEX[t.color]);
        setTimeout(() => {
          setTentacles((prev) => prev.filter((x) => x.id !== t.id));
        }, TENTACLE_TTL_MS);
      };
      // Prima attesa più lunga per dare tempo alla nav + render
      setTimeout(tryHighlight, 600);
    };

    window.addEventListener(VIRGILIO_EVENTS.HIGHLIGHT, onHighlight);
    return () => window.removeEventListener(VIRGILIO_EVENTS.HIGHLIGHT, onHighlight);
  }, [getOrigin]);

  // Riallinea su resize/scroll (ricalcola posizioni live)
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (tentacles.length > 0) force();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tentacles.length]);

  // Ricalcola live le posizioni (target potrebbe scrollare o muoversi)
  const liveTentacles = tentacles.map((t) => {
    const newTo = findTarget(t.target);
    const newFrom = getOrigin();
    if (!newTo) return t;
    const midX = (newFrom.x + newTo.x) / 2;
    const midY = (newFrom.y + newTo.y) / 2;
    const dx = newTo.x - newFrom.x;
    const dy = newTo.y - newFrom.y;
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len;
    const perpY = dx / len;
    const curveAmount = Math.min(180, len * 0.35);
    return {
      ...t,
      from: newFrom,
      to: newTo,
      control: { x: midX + perpX * curveAmount, y: midY + perpY * curveAmount },
    };
  });

  return (
    <svg
      className="pointer-events-none fixed inset-0 z-[9998]"
      width="100%"
      height="100%"
      style={{ overflow: "visible" }}
    >
      <defs>
        {(["emerald", "amber", "rose", "cyan"] as const).map((c) => (
          <React.Fragment key={c}>
            <filter id={`glow-${c}`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <radialGradient id={`tip-${c}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={COLOR_HEX[c]} stopOpacity="1" />
              <stop offset="60%" stopColor={COLOR_HEX[c]} stopOpacity="0.6" />
              <stop offset="100%" stopColor={COLOR_HEX[c]} stopOpacity="0" />
            </radialGradient>
          </React.Fragment>
        ))}
      </defs>

      <AnimatePresence>
        {liveTentacles.map((t) => {
          const path = `M ${t.from.x} ${t.from.y} Q ${t.control.x} ${t.control.y} ${t.to.x} ${t.to.y}`;
          const color = COLOR_HEX[t.color];
          return (
            <motion.g key={t.id}>
              {/* Alone esterno largo (più visibile) */}
              <motion.path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={10}
                strokeOpacity={0.25}
                strokeLinecap="round"
                filter={`url(#glow-${t.color})`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: [0, 0.6, 0.4] }}
                exit={{ opacity: 0 }}
                transition={{ pathLength: { duration: 0.7, ease: "easeOut" }, opacity: { duration: 1.2, repeat: Infinity, repeatType: "reverse" } }}
              />
              {/* Tentacolo principale */}
              <motion.path
                d={path}
                fill="none"
                stroke={color}
                strokeWidth={5}
                strokeLinecap="round"
                filter={`url(#glow-${t.color})`}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ pathLength: { duration: 0.7, ease: "easeOut" }, opacity: { duration: 0.3 } }}
              />
              {/* Linea sottile interna (effetto "nervo") */}
              <motion.path
                d={path}
                fill="none"
                stroke="white"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeOpacity={0.85}
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.7, ease: "easeOut" }}
              />
              {/* Punto pulsante alla punta */}
              <motion.circle
                cx={t.to.x}
                cy={t.to.y}
                r={18}
                fill={`url(#tip-${t.color})`}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: [0, 1.6, 1.2, 1.4], opacity: [0, 1, 0.7, 0.9] }}
                transition={{ duration: 1.6, delay: 0.5, repeat: Infinity, repeatType: "reverse" }}
              />
              <motion.circle
                cx={t.to.x}
                cy={t.to.y}
                r={6}
                fill={color}
                filter={`url(#glow-${t.color})`}
                initial={{ scale: 0 }}
                animate={{ scale: [0, 1.3, 1] }}
                transition={{ duration: 0.4, delay: 0.6 }}
              />
              {/* Etichetta */}
              {t.label && (
                <motion.g
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.7 }}
                >
                  <rect
                    x={t.to.x + 12}
                    y={t.to.y - 22}
                    rx={6}
                    width={Math.max(60, t.label.length * 7)}
                    height={22}
                    fill="rgba(9, 17, 24, 0.92)"
                    stroke={color}
                    strokeWidth={1}
                  />
                  <text
                    x={t.to.x + 18}
                    y={t.to.y - 7}
                    fill={color}
                    fontSize={11}
                    fontFamily="ui-monospace, monospace"
                    fontWeight={600}
                  >
                    {t.label.slice(0, 30)}
                  </text>
                </motion.g>
              )}
            </motion.g>
          );
        })}
      </AnimatePresence>
    </svg>
  );
}
