/**
 * L'indicatore dei calcoli, in basso a destra in tutte le pagine dell'app
 * (anche Fucina e Planning Studio, dove il menu è nascosto): compare solo
 * mentre un calcolo gira, porta a «I miei calcoli» e avvisa quando uno finisce.
 * Sta a sinistra del pulsante di Argos e sotto le finestre modali (z-40 < z-50),
 * lontano da «Disconnetti» in fondo al menu.
 */
import { useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useCalcoli } from "@/hooks/use-calcoli";
import { appenaFiniti, apriDi, etichetta, linkDi, vivo, type Calcolo } from "@/lib/calcoli";

export default function IndicatoreCalcoli() {
  const { calcoli, abilitato } = useCalcoli();
  const [location] = useLocation();
  const prima = useRef<Calcolo[] | null>(null);

  // un calcolo visto vivo che ora è finito: lo si dice una volta
  useEffect(() => {
    if (!abilitato) return;
    const precedenti = prima.current;
    prima.current = calcoli;
    if (!precedenti) return;
    for (const c of appenaFiniti(precedenti, calcoli)) {
      // sulla pagina che lo sta seguendo l'esito lo dice già lei
      const pagina = linkDi(c)?.split("?")[0];
      if (pagina && location === pagina) continue;
      const apri = apriDi(c);
      // caricamento nuovo: la pagina d'arrivo legge ?calcolo= solo all'apertura
      // (con la navigazione interna, dentro la stessa pagina il link non farebbe nulla)
      const azione = apri ? { label: "Apri", onClick: () => window.location.assign(apri) } : undefined;
      if (c.status === "completed") toast.success(`Calcolo finito: ${etichetta(c)}`, { action: azione, duration: 10_000 });
      else if (c.status === "failed") toast.error(`Calcolo non riuscito: ${etichetta(c)}`, { description: c.error ?? undefined, action: azione, duration: 15_000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calcoli, abilitato]);

  const vivi = calcoli.filter(vivo);
  if (!abilitato || vivi.length === 0 || location === "/calcoli") return null;
  const inCorso = vivi.filter(c => c.status === "running").length;
  const testo = vivi.length === 1
    ? `${etichetta(vivi[0])} · ${vivi[0].status === "queued" ? "in coda" : "in corso"}`
    : `${vivi.length} calcoli ${inCorso === vivi.length ? "in corso" : `(${inCorso} in corso)`}`;
  return (
    <Link
      href="/calcoli"
      aria-label={`I miei calcoli: ${testo}`}
      className="fixed bottom-6 right-24 z-40 inline-flex items-center gap-2 rounded-full border border-sky-500/40 bg-slate-900/90 px-3 py-1.5 text-xs text-sky-100 shadow-lg backdrop-blur hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 max-w-[calc(100vw-7.5rem)]"
    >
      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden />
      <span className="truncate">{testo}</span>
    </Link>
  );
}
