/**
 * VirgilioBus — event emitter globale per le azioni UI di Virgilio.
 *
 * Backend → SSE event:ui_action → CopilotSidebar emette su questo bus →
 * VirgilioController esegue (navigazione, eventi DOM) →
 * VirgilioTentacles disegna i tentacoli verso gli elementi target.
 */

export type UiAction =
  | { type: "ui_navigate"; payload: { path: string; reason?: string } }
  | { type: "ui_focus_map"; payload: { lat: number; lng: number; zoom?: number; label?: string } }
  | { type: "ui_highlight"; payload: { target: string; label?: string; color?: "emerald" | "amber" | "rose" | "cyan" } }
  | {
      type: "ui_plan_trip";
      payload: {
        origin_lat: number;
        origin_lon: number;
        origin_label?: string;
        dest_lat: number;
        dest_lon: number;
        dest_label?: string;
        date?: string;
        time?: string;
        allow_transfers?: boolean;
      };
    }
  | {
      type: "ui_fucina_wizard";
      payload: {
        action: "start" | "goto_step" | "highlight_field";
        step?: number;
        field_id?: string;
        label?: string;
      };
    };

type Listener = (action: UiAction) => void;

class VirgilioBusClass {
  private listeners = new Set<Listener>();

  emit(action: UiAction) {
    // micro-debug: lascia visibile in console per Sprint 1
    // eslint-disable-next-line no-console
    console.log("[Virgilio]", action.type, action.payload);
    for (const l of this.listeners) {
      try {
        l(action);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[VirgilioBus] listener error", err);
      }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const VirgilioBus = new VirgilioBusClass();

/**
 * Helper DOM events emessi da VirgilioController per le azioni mappa
 * (così le pagine con mappa Leaflet/MapLibre possono ascoltare e reagire).
 */
export const VIRGILIO_EVENTS = {
  FOCUS_MAP: "virgilio:focus-map",
  HIGHLIGHT: "virgilio:highlight",
  PLAN_TRIP: "virgilio:plan-trip",
  FUCINA: "virgilio:fucina",
} as const;
