/**
 * Abilitazioni del conducente — configurazione condivisa (chiave, etichetta,
 * simbolo, colore) usata sia dalla card nel roster sia dal dialog anagrafica.
 * Ogni abilitazione ha un piccolo simbolo per riconoscerla a colpo d'occhio.
 */
import { Bus, Zap, TramFront, ArrowUpDown, ShieldCheck, type LucideIcon } from "lucide-react";

export type AbilitazioneKey = "autobus" | "filobus" | "autosnodato" | "ascensore" | "verificatore";

export interface AbilitazioneDef {
  key: AbilitazioneKey;
  label: string;
  icon: LucideIcon;
  /** colore del simbolo/badge */
  color: string;
  bg: string;
}

export const ABILITAZIONI: AbilitazioneDef[] = [
  { key: "autobus",      label: "Autobus",      icon: Bus,         color: "#10b981", bg: "rgba(16,185,129,.15)" },
  { key: "filobus",      label: "Filobus",      icon: Zap,         color: "#38bdf8", bg: "rgba(56,189,248,.15)" },
  { key: "autosnodato",  label: "Autosnodato",  icon: TramFront,   color: "#f59e0b", bg: "rgba(245,158,11,.15)" },
  { key: "ascensore",    label: "Ascensore",    icon: ArrowUpDown, color: "#a78bfa", bg: "rgba(167,139,250,.15)" },
  { key: "verificatore", label: "Verificatore", icon: ShieldCheck, color: "#fb7185", bg: "rgba(251,113,133,.15)" },
];

export const ABILITAZIONE_BY_KEY: Record<string, AbilitazioneDef> =
  Object.fromEntries(ABILITAZIONI.map((a) => [a.key, a]));

/** Fila di simboli delle abilitazioni possedute — per la card del conducente. */
export function AbilitazioneBadges({ keys, size = 13 }: { keys: string[]; size?: number }) {
  if (!keys || keys.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys
        .map((k) => ABILITAZIONE_BY_KEY[k])
        .filter(Boolean)
        .map((a) => {
          const Icon = a.icon;
          return (
            <span
              key={a.key}
              title={a.label}
              className="inline-flex items-center justify-center rounded"
              style={{ width: size + 5, height: size + 5, background: a.bg, color: a.color }}
            >
              <Icon style={{ width: size, height: size }} />
            </span>
          );
        })}
    </span>
  );
}
