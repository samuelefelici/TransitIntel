/**
 * Il comportamento da finestra di dialogo per le finestre fatte a mano del
 * roster (scheda conducente, import): il focus entra nella finestra quando
 * si apre e torna dov'era quando si chiude, Tab gira dentro la finestra
 * invece di finire sulla pagina sotto, Esc chiude (passando da `chiudi`, che
 * può chiedere conferma se ci sono modifiche).
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCALIZZABILI = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogo(ref: RefObject<HTMLElement | null>, chiudi: () => void, attivo = true): void {
  const chiudiRef = useRef(chiudi);
  chiudiRef.current = chiudi;

  useEffect(() => {
    if (!attivo) return;
    const prima = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const tasto = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        chiudiRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const voci = [...el.querySelectorAll<HTMLElement>(FOCALIZZABILI)].filter(x => x.offsetParent !== null);
      if (!voci.length) { e.preventDefault(); el.focus(); return; }
      const primo = voci[0], ultimo = voci[voci.length - 1];
      const dentro = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === primo || !dentro)) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && (document.activeElement === ultimo || !dentro)) { e.preventDefault(); primo.focus(); }
    };
    window.addEventListener("keydown", tasto, true);
    return () => {
      window.removeEventListener("keydown", tasto, true);
      if (prima && document.contains(prima)) prima.focus();
    };
  }, [ref, attivo]);
}
