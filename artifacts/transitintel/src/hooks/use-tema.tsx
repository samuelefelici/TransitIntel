/**
 * Il tema dell'app nella pagina (tappa 7.32): la scelta della persona, il
 * tema del sistema quando cambia, la classe su <html>. Le regole in lib/tema.ts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { CHIAVE_TEMA, CLASSE_CHIARO, COLORE_BARRA, sceltaValida, stileMappa, temaRisolto, type SceltaTema, type Tema } from "@/lib/tema";

const QUERY_CHIARO = "(prefers-color-scheme: light)";

function leggiScelta(): SceltaTema {
  try { return sceltaValida(localStorage.getItem(CHIAVE_TEMA)); } catch { return "scuro"; }
}

function sistemaChiaro(): boolean {
  try { return window.matchMedia?.(QUERY_CHIARO).matches ?? false; } catch { return false; }
}

/** Mette il tema sulla pagina: la classe su <html>, color-scheme e il colore della barra del telefono. */
export function applicaTema(tema: Tema): void {
  const html = document.documentElement;
  html.classList.toggle(CLASSE_CHIARO, tema === "chiaro");
  html.style.colorScheme = tema === "chiaro" ? "light" : "dark";
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = COLORE_BARRA[tema];
}

/** Prima di disegnare l'app (main.tsx): niente lampo dello scuro per chi ha scelto il chiaro. */
export function applicaTemaSalvato(): void {
  applicaTema(temaRisolto(leggiScelta(), sistemaChiaro()));
}

type ContestoTema = { scelta: SceltaTema; tema: Tema; scegli: (s: SceltaTema) => void };
const Contesto = createContext<ContestoTema>({ scelta: "scuro", tema: "scuro", scegli: () => {} });

export function TemaProvider({ children }: { children: ReactNode }) {
  const [scelta, setScelta] = useState<SceltaTema>(leggiScelta);
  const [chiaroDiSistema, setChiaroDiSistema] = useState(sistemaChiaro);
  const tema = temaRisolto(scelta, chiaroDiSistema);

  useEffect(() => { applicaTema(tema); }, [tema]);

  useEffect(() => {
    const mq = window.matchMedia?.(QUERY_CHIARO);
    if (!mq) return;
    const cambia = () => setChiaroDiSistema(mq.matches);
    mq.addEventListener?.("change", cambia);
    return () => mq.removeEventListener?.("change", cambia);
  }, []);

  /* la scelta fatta in un'altra scheda vale anche qui */
  useEffect(() => {
    const daAltraScheda = (e: StorageEvent) => { if (e.key === CHIAVE_TEMA) setScelta(sceltaValida(e.newValue)); };
    window.addEventListener("storage", daAltraScheda);
    return () => window.removeEventListener("storage", daAltraScheda);
  }, []);

  const scegli = useCallback((s: SceltaTema) => {
    setScelta(s);
    try { localStorage.setItem(CHIAVE_TEMA, s); } catch { /* storage spento: vale fino alla chiusura */ }
  }, []);

  const valore = useMemo(() => ({ scelta, tema, scegli }), [scelta, tema, scegli]);
  return <Contesto.Provider value={valore}>{children}</Contesto.Provider>;
}

export function useTema(): ContestoTema {
  return useContext(Contesto);
}

/** Lo stile della mappa di base adatto al tema (un fondo scuro diventa il suo gemello chiaro). */
export function useStileMappa(stile: string): string {
  const { tema } = useTema();
  return stileMappa(stile, tema);
}
