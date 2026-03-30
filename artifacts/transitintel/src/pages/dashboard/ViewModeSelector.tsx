import React from "react";
import { Sun, Building2, Moon, Satellite } from "lucide-react";
import type { ViewMode } from "./types";

interface ViewModeSelectorProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
}

const VIEW_MODES: { key: ViewMode; icon: React.ReactNode; label: string }[] = [
  { key: "dark",        icon: <Sun className="w-3.5 h-3.5" />,       label: "Scuro" },
  { key: "city3d",      icon: <Building2 className="w-3.5 h-3.5" />, label: "Città 3D" },
  { key: "city3d-dark", icon: <Moon className="w-3.5 h-3.5" />,      label: "3D Notte" },
  { key: "satellite",   icon: <Satellite className="w-3.5 h-3.5" />, label: "Satellite" },
];

export function ViewModeSelector({ viewMode, onViewModeChange }: ViewModeSelectorProps) {
  return (
    <div className="absolute bottom-6 right-4 flex flex-col gap-2 pointer-events-auto">
      <div className="bg-card/90 backdrop-blur-xl border border-border/50 shadow-xl rounded-xl p-1 flex gap-1">
        {VIEW_MODES.map(({ key, icon, label }) => (
          <button key={key} title={label}
            onClick={() => onViewModeChange(key)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
              viewMode === key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}>
            {icon}
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
