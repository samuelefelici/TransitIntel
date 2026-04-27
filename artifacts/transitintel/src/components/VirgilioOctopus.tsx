/**
 * VirgilioOctopus — avatar polipo con tentacoli che ondeggiano.
 * Tutti i motion hanno `initial` esplicito per evitare warning SVG di framer-motion.
 */
import React from "react";
import { motion } from "framer-motion";

export type VirgilioOctopusProps = {
  size?: number;
  state?: "idle" | "active" | "speaking";
  className?: string;
};

const TENTACLE_COUNT = 6;

export default function VirgilioOctopus({
  size = 40,
  state = "idle",
  className = "",
}: VirgilioOctopusProps) {
  const tentacles = React.useMemo(
    () =>
      Array.from({ length: TENTACLE_COUNT }, (_, i) => {
        const angle = Math.PI * (0.15 + (0.7 * i) / (TENTACLE_COUNT - 1));
        const baseX = 50 + Math.cos(angle) * 22;
        const baseY = 55 + Math.sin(angle) * 8;
        const tipX = 50 + Math.cos(angle) * 42;
        const tipY = 55 + Math.sin(angle) * 38;
        const ctrlX1 = 50 + Math.cos(angle) * 30;
        const ctrlY1 = 55 + Math.sin(angle) * 18;
        const ctrlX2 = 50 + Math.cos(angle) * 36;
        const ctrlY2 = 55 + Math.sin(angle) * 30;
        const dRest = `M ${baseX} ${baseY} C ${ctrlX1} ${ctrlY1}, ${ctrlX2} ${ctrlY2}, ${tipX} ${tipY}`;
        const dWave1 = `M ${baseX} ${baseY} C ${ctrlX1 + 4} ${ctrlY1 - 3}, ${ctrlX2 - 3} ${ctrlY2 + 4}, ${tipX + 2} ${tipY + 3}`;
        const dWave2 = `M ${baseX} ${baseY} C ${ctrlX1 - 3} ${ctrlY1 + 2}, ${ctrlX2 + 4} ${ctrlY2 - 2}, ${tipX - 3} ${tipY - 1}`;
        return { idx: i, dRest, dWave1, dWave2 };
      }),
    [],
  );

  const isActive = state === "active";
  const isSpeaking = state === "speaking";
  const speed = isActive ? 1.2 : isSpeaking ? 0.8 : 2.4;

  return (
    <div
      className={`relative ${className}`}
      style={{ width: size, height: size }}
      aria-label="Virgilio"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: "visible" }}>
        <defs>
          <radialGradient id="virgilio-body" cx="50%" cy="40%" r="55%">
            <stop offset="0%" stopColor="#a7f3d0" />
            <stop offset="55%" stopColor="#10b981" />
            <stop offset="100%" stopColor="#064e3b" />
          </radialGradient>
          <filter id="virgilio-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={isActive || isSpeaking ? 3 : 1.5} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {tentacles.map((t) => (
          <motion.path
            key={t.idx}
            stroke="url(#virgilio-body)"
            strokeWidth={3.5}
            strokeLinecap="round"
            fill="none"
            filter="url(#virgilio-glow)"
            initial={{ d: t.dRest }}
            animate={{ d: [t.dRest, t.dWave1, t.dWave2, t.dRest] }}
            transition={{
              duration: speed,
              repeat: Infinity,
              ease: "easeInOut",
              delay: t.idx * 0.15,
            }}
          />
        ))}

        <motion.ellipse
          cx={50}
          cy={42}
          initial={{ rx: 28, ry: 25 }}
          animate={
            isSpeaking
              ? { rx: [28, 27.5, 28], ry: [25, 27, 25] }
              : isActive
                ? { rx: 28, ry: [25, 26, 25] }
                : { rx: 28, ry: 25 }
          }
          transition={{ duration: 0.6, repeat: Infinity, ease: "easeInOut" }}
          fill="url(#virgilio-body)"
          filter="url(#virgilio-glow)"
        />

        <ellipse cx={45} cy={32} rx={12} ry={6} fill="rgba(255,255,255,0.35)" />

        <g>
          <circle cx={42} cy={42} r={4} fill="#0b1820" />
          <circle cx={58} cy={42} r={4} fill="#0b1820" />
          <motion.circle
            r={1.4}
            fill="white"
            initial={{ cx: 43, cy: 41 }}
            animate={isActive ? { cx: [43, 44, 42, 43], cy: [41, 42, 40, 41] } : { cx: 43, cy: 41 }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
          <motion.circle
            r={1.4}
            fill="white"
            initial={{ cx: 59, cy: 41 }}
            animate={isActive ? { cx: [59, 60, 58, 59], cy: [41, 42, 40, 41] } : { cx: 59, cy: 41 }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
        </g>

        <g>
          <path d="M 38 22 L 42 14 L 46 20 L 50 12 L 54 20 L 58 14 L 62 22 Z" fill="#fbbf24" opacity={0.85} />
          <circle cx={50} cy={12} r={1.6} fill="#fde68a" />
        </g>
      </svg>
    </div>
  );
}
