import React from "react";
import {
  CheckCircle2, Clock, XCircle, AlertCircle,
  Briefcase, Palmtree, GraduationCap, HeartPulse,
  ShoppingBag, Factory, Ship, TrainFront, Plane,
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════
 *  Intermodal – Constants & utilities
 * ═══════════════════════════════════════════════════════════════ */

// ─── Map styles — UNIQUE for intermodal (different from dashboard) ───
export type ViewMode = "neon" | "midnight" | "blueprint" | "satellite";

export const MAP_STYLES: Record<ViewMode, string> = {
  neon: "mapbox://styles/mapbox/navigation-night-v1",
  midnight: "mapbox://styles/mapbox/dark-v11",
  blueprint: "mapbox://styles/mapbox/navigation-day-v1",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
};

export const HUB_COLORS: Record<string, string> = {
  railway: "#06b6d4",
  port: "#8b5cf6",
  airport: "#f59e0b",
};

export const STATUS_CONFIG: Record<string, {
  color: string; bg: string; border: string; label: string; icon: React.ReactNode;
}> = {
  ok: { color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20", label: "OK", icon: <CheckCircle2 className="w-3 h-3" /> },
  "long-wait": { color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20", label: "Attesa lunga", icon: <Clock className="w-3 h-3" /> },
  "no-bus": { color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/20", label: "Nessun bus", icon: <XCircle className="w-3 h-3" /> },
  "just-missed": { color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/20", label: "Appena perso", icon: <AlertCircle className="w-3 h-3" /> },
};

export const PRIORITY_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  critical: { bg: "bg-red-500/15", border: "border-red-500/30", text: "text-red-300", label: "CRITICO" },
  high: { bg: "bg-amber-500/15", border: "border-amber-500/30", text: "text-amber-200", label: "ALTO" },
  medium: { bg: "bg-blue-500/10", border: "border-blue-500/20", text: "text-blue-200", label: "MEDIO" },
  low: { bg: "bg-muted/30", border: "border-border/30", text: "text-muted-foreground", label: "BASSO" },
};

export const POI_ICONS: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  office: { icon: <Briefcase className="w-3 h-3" />, color: "#3b82f6", label: "Uffici" },
  hospital: { icon: <HeartPulse className="w-3 h-3" />, color: "#ef4444", label: "Sanità" },
  school: { icon: <GraduationCap className="w-3 h-3" />, color: "#f59e0b", label: "Scuole" },
  industrial: { icon: <Factory className="w-3 h-3" />, color: "#6b7280", label: "Industria" },
  leisure: { icon: <Palmtree className="w-3 h-3" />, color: "#22c55e", label: "Tempo libero" },
  shopping: { icon: <ShoppingBag className="w-3 h-3" />, color: "#a855f7", label: "Shopping" },
};

/* ── Helper: walk circle GeoJSON ── */
export function walkCircle(lat: number, lng: number, radiusKm: number, steps = 64): GeoJSON.Feature {
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    const dLat = (radiusKm / 111.32) * Math.cos(angle);
    const dLng = (radiusKm / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.sin(angle);
    coords.push([lng + dLng, lat + dLat]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
}

export function shortHubName(name: string) {
  return name
    .replace("Stazione FS ", "")
    .replace("Stazione di Ancona ", "")
    .replace("Stazione ", "")
    .replace("Porto di Ancona (Terminal Passeggeri)", "Porto Ancona")
    .replace("Aeroporto Raffaello Sanzio (Falconara)", "Aeroporto");
}

export function hubIcon(type: string, className = "w-5 h-5") {
  if (type === "airport") return <Plane className={className} />;
  if (type === "port") return <Ship className={className} />;
  return <TrainFront className={className} />;
}

export function hubGlowColor(type: string) {
  if (type === "airport") return "rgba(245,158,11,0.4)";
  if (type === "port") return "rgba(139,92,246,0.4)";
  return "rgba(6,182,212,0.4)";
}

export function hubTransportLabel(type: string) {
  if (type === "airport") return "volo";
  if (type === "port") return "nave";
  return "treno";
}
