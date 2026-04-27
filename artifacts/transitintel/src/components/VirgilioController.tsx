/**
 * VirgilioController — esegue le UI actions emesse sul bus.
 *
 * Va montato UNA volta a livello App (sopra il routing).
 * - ui_navigate → setLocation()
 * - ui_focus_map → window event 'virgilio:focus-map' (le mappe ascoltano)
 * - ui_highlight → window event 'virgilio:highlight' + tentacolo (gestito da VirgilioTentacles)
 */
import React from "react";
import { useLocation } from "wouter";
import { VirgilioBus, VIRGILIO_EVENTS, type UiAction } from "@/lib/virgilio-bus";

export default function VirgilioController() {
  const [, setLocation] = useLocation();

  // ── Listener leggero per ui_highlight: scrolla + pulse CSS, niente SVG ──
  React.useEffect(() => {
    const onHighlight = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        target: string;
        label?: string;
        color?: "emerald" | "amber" | "rose" | "cyan";
      };
      if (!detail?.target) return;
      const tryPulse = (attempt = 0) => {
        const el = document.querySelector(
          `[data-virgilio-id="${detail.target}"]`,
        ) as HTMLElement | null;
        if (!el) {
          if (attempt < 8) setTimeout(() => tryPulse(attempt + 1), 350);
          return;
        }
        const colorMap: Record<string, string> = {
          emerald: "#34d399",
          amber: "#fbbf24",
          rose: "#fb7185",
          cyan: "#22d3ee",
        };
        const color = colorMap[detail.color || "emerald"];
        try {
          el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        } catch {
          el.scrollIntoView();
        }
        el.style.transition = "box-shadow 0.4s, outline 0.4s";
        el.style.outline = `2px solid ${color}`;
        el.style.outlineOffset = "2px";
        el.style.boxShadow = `0 0 24px ${color}cc, inset 0 0 12px ${color}33`;
        setTimeout(() => {
          el.style.outline = "";
          el.style.boxShadow = "";
        }, 5000);
      };
      // Lascia tempo a navigazioni / lazy-load
      setTimeout(() => tryPulse(0), 500);
    };
    window.addEventListener(VIRGILIO_EVENTS.HIGHLIGHT, onHighlight);
    return () => window.removeEventListener(VIRGILIO_EVENTS.HIGHLIGHT, onHighlight);
  }, []);

  React.useEffect(() => {
    const off = VirgilioBus.on((action: UiAction) => {
      switch (action.type) {
        case "ui_navigate": {
          if (action.payload.path) {
            setLocation(action.payload.path);
          }
          break;
        }
        case "ui_focus_map": {
          window.dispatchEvent(
            new CustomEvent(VIRGILIO_EVENTS.FOCUS_MAP, { detail: action.payload }),
          );
          break;
        }
        case "ui_highlight": {
          window.dispatchEvent(
            new CustomEvent(VIRGILIO_EVENTS.HIGHLIGHT, { detail: action.payload }),
          );
          break;
        }
        case "ui_plan_trip": {
          // 1) Naviga a /trip-planner se non siamo già lì
          if (window.location.pathname !== "/trip-planner") {
            setLocation("/trip-planner");
          }
          // 2) Dopo che la pagina ha avuto tempo di montarsi, dispatch evento con i dati
          //    Retry per gestire lazy-loading / ritardo del listener
          let attempts = 0;
          const tryDispatch = () => {
            attempts++;
            // Marker globale settato dalla pagina trip-planner quando è pronta ad ascoltare
            const ready = (window as any).__virgilioTripPlannerReady === true;
            if (ready || attempts > 8) {
              window.dispatchEvent(
                new CustomEvent(VIRGILIO_EVENTS.PLAN_TRIP, { detail: action.payload }),
              );
              return;
            }
            setTimeout(tryDispatch, 250);
          };
          setTimeout(tryDispatch, 300);
          break;
        }
        case "ui_fucina_wizard": {
          const sub = action.payload.action;
          // Per "start" naviga sempre a /fucina; per goto_step idem; per highlight_field non navigare
          if (sub === "start" || sub === "goto_step") {
            if (window.location.pathname !== "/fucina") {
              setLocation("/fucina");
            }
          }
          // Retry per attendere mount + ready flag
          let attempts = 0;
          const tryDispatch = () => {
            attempts++;
            const ready = (window as any).__virgilioFucinaReady === true;
            if (ready || attempts > 10) {
              window.dispatchEvent(
                new CustomEvent(VIRGILIO_EVENTS.FUCINA, { detail: action.payload }),
              );
              return;
            }
            setTimeout(tryDispatch, 250);
          };
          // Per highlight_field non c'è bisogno di attendere navigazione → delay basso
          setTimeout(tryDispatch, sub === "highlight_field" ? 100 : 400);
          break;
        }
      }
    });
    return off;
  }, [setLocation]);

  return null;
}
