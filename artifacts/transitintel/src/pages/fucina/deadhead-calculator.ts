import type { ServiceCategory } from "@/pages/optimizer-route/types";
import type { DeadheadMatrix } from "@/pages/fucina/steps/DeadheadStep";

export interface StopCoord {
  lat: number;
  lon: number;
}

export interface CalculateDeadheadInput {
  fromStop: string;
  toStop: string;
  category: ServiceCategory;
  deadheadMatrix?: DeadheadMatrix | null;
  resolveStopCoord?: (stopName: string) => StopCoord | null;
}

export interface DeadheadEstimate {
  km: number;
  durationMin: number;
  source: "matrix" | "haversine" | "fallback";
}

function haversineKm(a: StopCoord, b: StopCoord): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function estimateFromKm(km: number, category: ServiceCategory): { km: number; durationMin: number } {
  const speed = category === "extraurbano" ? 40 : 20;
  const durationMin = Math.ceil((km / speed) * 60) + 5;
  return {
    km: Math.round(Math.max(0, km) * 10) / 10,
    durationMin: Math.max(1, durationMin),
  };
}

function findMatrixEstimate(
  deadheadMatrix: DeadheadMatrix,
  fromStop: string,
  toStop: string,
): { km: number; durationMin: number } | null {
  const from = fromStop.trim().toLowerCase();
  const to = toStop.trim().toLowerCase();
  if (!from || !to) return null;

  const fromNode = deadheadMatrix.nodes.find(n => n.name.trim().toLowerCase() === from);
  const toNode = deadheadMatrix.nodes.find(n => n.name.trim().toLowerCase() === to);
  if (!fromNode || !toNode) return null;

  const match = deadheadMatrix.deadheads.find(
    d => d.fromId === fromNode.id && d.toId === toNode.id && (d.enabled ?? true),
  );
  if (!match) return null;

  return {
    km: Math.round((match.distanceKm ?? 0) * 10) / 10,
    durationMin: Math.max(1, Math.round(match.durationMin ?? 1)),
  };
}

export function calculateDeadhead(input: CalculateDeadheadInput): DeadheadEstimate {
  const { fromStop, toStop, category, deadheadMatrix, resolveStopCoord } = input;

  if (deadheadMatrix) {
    const matrix = findMatrixEstimate(deadheadMatrix, fromStop, toStop);
    if (matrix) {
      return { ...matrix, source: "matrix" };
    }
  }

  if (resolveStopCoord) {
    const fromCoord = resolveStopCoord(fromStop);
    const toCoord = resolveStopCoord(toStop);
    if (fromCoord && toCoord) {
      const straight = haversineKm(fromCoord, toCoord);
      const roadKm = straight * 1.3;
      return { ...estimateFromKm(roadKm, category), source: "haversine" };
    }
  }

  return { ...estimateFromKm(3.5, category), source: "fallback" };
}
