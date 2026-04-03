import React from "react";
import {
  Cross, GraduationCap, ShoppingBag, Factory, Dumbbell, Landmark, TrainFront,
  Briefcase, Church, HeartHandshake, CircleParking, Camera,
} from "lucide-react";
import type { ViewMode } from "./types";

export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";

export const MAP_STYLES: Record<string, string> = {
  dark: "mapbox://styles/mapbox/dark-v11",
  city3d: "mapbox://styles/mapbox/standard",
  "city3d-dark": "mapbox://styles/mapbox/standard",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

export const SCENARIO_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#a855f7", "#ec4899",
  "#06b6d4", "#f97316", "#8b5cf6", "#14b8a6",
];

export const LINE_COLORS = [
  "#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

export const POI_CATEGORY_IT: Record<string, string> = {
  hospital: "Sanità", school: "Istruzione", shopping: "Commercio",
  industrial: "Zona Industriale", leisure: "Sport / Svago", office: "Uffici / P.A.",
  transit: "Hub Trasporti", workplace: "Aziende", worship: "Culto",
  elderly: "RSA", parking: "Parcheggi", tourism: "Cultura",
};

export const POI_COLOR: Record<string, string> = {
  hospital: "#ef4444", school: "#eab308", shopping: "#a855f7",
  industrial: "#f97316", leisure: "#22c55e", office: "#3b82f6",
  transit: "#06b6d4", workplace: "#64748b", worship: "#d946ef",
  elderly: "#f43f5e", parking: "#94a3b8", tourism: "#14b8a6",
};

export const POI_ICON: Record<string, React.ReactNode> = {
  hospital: <Cross className="w-3 h-3" />, school: <GraduationCap className="w-3 h-3" />,
  shopping: <ShoppingBag className="w-3 h-3" />, industrial: <Factory className="w-3 h-3" />,
  leisure: <Dumbbell className="w-3 h-3" />, office: <Landmark className="w-3 h-3" />,
  transit: <TrainFront className="w-3 h-3" />, workplace: <Briefcase className="w-3 h-3" />,
  worship: <Church className="w-3 h-3" />, elderly: <HeartHandshake className="w-3 h-3" />,
  parking: <CircleParking className="w-3 h-3" />, tourism: <Camera className="w-3 h-3" />,
};

export const POI_SVG_PATHS: Record<string, string[]> = {
  hospital: ["M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01", "M9 2h6M12 10v8M9 14h6"],
  school: ["M22 10v6M2 10l10-5 10 5-10 5z", "M6 12v5c0 2 6 3 6 3s6-1 6-3v-5"],
  shopping: ["M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z", "M3 6h18", "M16 10a4 4 0 01-8 0"],
  industrial: ["M2 20h20", "M5 20V8l5 6V8l5 6V4h3v16"],
  leisure: ["M6.5 6.5a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0", "M2 12h20M6 12a4 4 0 010-8M6 12a4 4 0 000 8M18 12a4 4 0 000-8M18 12a4 4 0 010 8"],
  office: ["M3 22V6l9-4 9 4v16", "M3 10h18M7 22V10M11 22V10M15 22V10M19 22V10"],
  transit: ["M4 11V6a2 2 0 012-2h12a2 2 0 012 2v5", "M4 15h16M6 19l2-4M16 19l2-4M4 11h16v4H4z", "M9 7h6"],
  workplace: ["M8 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2h-3", "M16 3v4M8 3v4M3 11h18", "M12 11v4M9 15h6"],
  worship: ["M18 2v4M6 2v4M12 2v10", "M8 6h8M2 22l4-10h12l4 10", "M12 12l-2 10M12 12l2 10"],
  elderly: ["M10 15v5M14 15v5M12 2a3 3 0 100 6 3 3 0 000-6z", "M19 14c-1-1-3-2-7-2s-6 1-7 2", "M17 20H7"],
  parking: ["M12 2a10 10 0 100 20 10 10 0 000-20z", "M9 17V7h4a3 3 0 010 6H9"],
  tourism: ["M14.5 4h-5L7 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-3l-2.5-3z", "M12 13a3 3 0 100-6 3 3 0 000 6z"],
};

export function renderPoiIcon(category: string): ImageData {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fillStyle = POI_COLOR[category] || "#888"; ctx.fill();
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
  const iconScale = 26 / 24; const offset = (size - 26) / 2;
  ctx.save(); ctx.translate(offset, offset); ctx.scale(iconScale, iconScale);
  ctx.strokeStyle = "#ffffff"; ctx.fillStyle = "none"; ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const paths = POI_SVG_PATHS[category] || [];
  for (const d of paths) { ctx.stroke(new Path2D(d)); }
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

export const DEFAULT_PDE_CONFIG = {
  targetKm: 500,
  serviceStartH: 6,
  serviceEndH: 22,
  minCadenceMin: 10,
  maxCadenceMin: 60,
  avgSpeedKmh: 20,
  dwellTimeSec: 25,
  terminalTimeSec: 300,
  bidirectional: true,
};

export const VIEW_MODE_OPTIONS: { key: ViewMode; label: string }[] = [
  { key: "dark", label: "Scuro" },
  { key: "city3d", label: "3D" },
  { key: "city3d-dark", label: "Notte" },
  { key: "satellite", label: "Sat" },
];
