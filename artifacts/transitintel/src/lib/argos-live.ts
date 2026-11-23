/**
 * La regia in diretta, anche fra schede del browser.
 *
 * Quando il Pianificatore scrive sul progetto (corse, validità, rete), le
 * pagine aperte di Planning Studio si aggiornano da sole: il componente della
 * conversazione annuncia la scrittura, ArgosLiveBridge e useArgosFresh la
 * ascoltano come evento "argos-live" della finestra. Da quando Argos vive in
 * una pagina sua (/argos), Planning Studio di solito è aperto in un'ALTRA
 * scheda: l'annuncio passa anche da un BroadcastChannel, e il ponte di
 * quell'altra scheda lo rigira come evento della sua finestra. Senza
 * BroadcastChannel (browser molto vecchi) resta l'evento locale.
 */
import type { ArgosLiveDetail } from "@/components/argos/ArgosLiveBridge";

export const CANALE_ARGOS_LIVE = "argos-live";

function canale(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CANALE_ARGOS_LIVE);
  } catch {
    return null;
  }
}

/** Una scrittura riuscita: alla finestra e alle altre schede. */
export function annunciaScrittura(detail: ArgosLiveDetail): void {
  window.dispatchEvent(new CustomEvent("argos-live", { detail }));
  const c = canale();
  if (c) {
    try { c.postMessage(detail); } catch { /* dettaglio non clonabile: resta locale */ }
    c.close();
  }
}

/** Le scritture annunciate dalle ALTRE schede, rigirate come eventi di questa finestra. */
export function ascoltaAltreSchede(): () => void {
  const c = canale();
  if (!c) return () => {};
  c.onmessage = (e: MessageEvent) => {
    if (e.data && typeof e.data === "object" && typeof (e.data as any).name === "string") {
      window.dispatchEvent(new CustomEvent("argos-live", { detail: e.data }));
    }
  };
  return () => c.close();
}

/** La pagina di Argos sulle conversazioni, facoltativamente filtrate su un progetto. */
export function indirizzoArgos(projectId?: string, base: string = import.meta.env.BASE_URL ?? "/"): string {
  const q = new URLSearchParams({ scheda: "conversazioni" });
  if (projectId) q.set("progetto", projectId);
  return `${base.replace(/\/$/, "")}/argos?${q}`;
}
