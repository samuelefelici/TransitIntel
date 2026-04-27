/**
 * Virgilio avatar — monogramma "V" stilizzato neon verde,
 * con due varianti (bright per header / floating button, soft per messaggi).
 * Pure SVG inline, niente asset esterni.
 */
import React from "react";

interface Props {
  size?: number;
  variant?: "bright" | "soft";
  pulse?: boolean;
  className?: string;
}

export default function VirgilioAvatar({
  size = 32,
  variant = "bright",
  pulse = false,
  className = "",
}: Props) {
  const bright = variant === "bright";
  const gradId = React.useId();
  const glowId = React.useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`${className} ${pulse ? "[animation:virgilio-pulse_2.4s_ease-in-out_infinite]" : ""}`}
      style={{ filter: bright ? `drop-shadow(0 0 8px rgba(16,185,129,0.55))` : undefined }}
    >
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
          {bright ? (
            <>
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="55%" stopColor="#10b981" />
              <stop offset="100%" stopColor="#84cc16" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="#022c22" />
              <stop offset="100%" stopColor="#052e1a" />
            </>
          )}
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#6ee7b7" stopOpacity={bright ? 0.55 : 0.25} />
          <stop offset="100%" stopColor="#022c22" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* outer hexagon plate */}
      <polygon
        points="32,3 57,17 57,47 32,61 7,47 7,17"
        fill={`url(#${gradId})`}
        stroke={bright ? "#a7f3d0" : "#10b981"}
        strokeWidth="1.5"
        strokeOpacity={bright ? 0.9 : 0.5}
      />

      {/* inner glow */}
      <polygon
        points="32,3 57,17 57,47 32,61 7,47 7,17"
        fill={`url(#${glowId})`}
      />

      {/* circuit accents */}
      <g
        stroke={bright ? "#ecfccb" : "#34d399"}
        strokeWidth="0.8"
        strokeOpacity={bright ? 0.55 : 0.7}
        fill="none"
      >
        <path d="M11 22 L19 22 L22 19" />
        <path d="M53 22 L45 22 L42 19" />
        <path d="M11 42 L19 42 L22 45" />
        <path d="M53 42 L45 42 L42 45" />
      </g>
      <g fill={bright ? "#ecfccb" : "#34d399"} fillOpacity={bright ? 0.85 : 0.8}>
        <circle cx="11" cy="22" r="1" />
        <circle cx="53" cy="22" r="1" />
        <circle cx="11" cy="42" r="1" />
        <circle cx="53" cy="42" r="1" />
      </g>

      {/* "V" monogram */}
      <path
        d="M19 19 L32 47 L45 19"
        fill="none"
        stroke={bright ? "#0a0f0c" : "#a7f3d0"}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 19 L32 47 L45 19"
        fill="none"
        stroke={bright ? "#ecfccb" : "#34d399"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />

      {/* tiny crown dot (riferimento dantesco / "guida") */}
      <circle cx="32" cy="11" r="1.6" fill={bright ? "#fef3c7" : "#fbbf24"} />

      <style>{`
        @keyframes virgilio-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.92; transform: scale(0.97); }
        }
      `}</style>
    </svg>
  );
}
