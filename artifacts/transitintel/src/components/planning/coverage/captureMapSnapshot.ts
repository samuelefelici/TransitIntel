/**
 * captureMapSnapshot — cattura screenshot della mappa Mapbox in PNG dataURL.
 * Richiede preserveDrawingBuffer: true sul MapGL al momento della creazione.
 */
import type { MapRef } from "react-map-gl/mapbox";

export async function captureMapSnapshot(map: MapRef | null, timeoutMs = 1500): Promise<string | null> {
  if (!map) return null;
  try {
    const m: any = (map as any).getMap ? (map as any).getMap() : map;
    if (!m) return null;
    // attendi che il render sia "idle"
    await new Promise<void>((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(); } }, timeoutMs);
      try {
        m.once("idle", () => { if (!done) { done = true; clearTimeout(t); resolve(); } });
        m.triggerRepaint?.();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    const canvas: HTMLCanvasElement | undefined = m.getCanvas?.();
    if (!canvas) return null;
    return canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("[captureMapSnapshot] failed", e);
    return null;
  }
}
