/**
 * La scelta del tema nel menu (tappa 7.32): scuro, chiaro o come il sistema.
 * Nel menu compresso un pulsante solo, che passa alla scelta seguente.
 */
import { Monitor, Moon, Sun } from "lucide-react";
import { useTema } from "@/hooks/use-tema";
import { SCELTE_TEMA, sceltaSeguente, type SceltaTema } from "@/lib/tema";

const ICONE: Record<SceltaTema, typeof Moon> = { scuro: Moon, chiaro: Sun, sistema: Monitor };
const etichetta = (s: SceltaTema) => SCELTE_TEMA.find((x) => x.valore === s)!.etichetta;

export function SceltaTema() {
  const { scelta, scegli } = useTema();
  return (
    <div role="group" aria-label="Tema" className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-0.5">
      {SCELTE_TEMA.map(({ valore }) => {
        const Icona = ICONE[valore];
        const attiva = scelta === valore;
        return (
          <button
            key={valore}
            type="button"
            onClick={() => scegli(valore)}
            aria-pressed={attiva}
            title={`Tema: ${etichetta(valore).toLowerCase()}`}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              attiva ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icona className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{etichetta(valore)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SceltaTemaCompatta() {
  const { scelta, scegli } = useTema();
  const Icona = ICONE[scelta];
  const dopo = sceltaSeguente(scelta);
  return (
    <button
      type="button"
      onClick={() => scegli(dopo)}
      title={`Tema: ${etichetta(scelta).toLowerCase()} (passa a «${etichetta(dopo).toLowerCase()}»)`}
      aria-label={`Tema: ${etichetta(scelta)}. Passa a ${etichetta(dopo)}`}
      className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icona className="w-4 h-4" aria-hidden />
    </button>
  );
}
