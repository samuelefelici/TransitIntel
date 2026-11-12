/* «Sola lettura» dentro le pagine: i comandi che modificano restano visibili
 * ma spenti, con il motivo, per chi sulla pagina può solo leggere.
 *
 * Chi decide davvero è l'API (lib/permessi-rotte.ts): questo è solo cortesia.
 * Un comando che qui resta acceso per sbaglio viene comunque rifiutato, e
 * l'avviso unico lo dice (lib/sola-lettura.ts, App.tsx).
 *
 * La pagina sa le sue aree dalla guardia (Gated in App.tsx), che le mette nel
 * contesto; un comando di un'area diversa da quella della pagina la dichiara.
 */
import { cloneElement, createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";
import { NOMI_AREE, type Area } from "@workspace/permessi";
import { useAuth } from "@/hooks/use-auth";
import { EVENTO_SOLA_LETTURA, mancaLaScrittura, motivoSolaLettura, propsDelComandoSpento, type RifiutoSolaLettura } from "@/lib/sola-lettura";

export interface StatoSolaLettura {
  /** vero se chi guarda non può modificare */
  solaLettura: boolean;
  /** la spiegazione da mostrare sul comando spento; vuota se può modificare */
  motivo: string;
  /**
   * Per i gesti che non hanno un pulsante da spegnere (una scorciatoia da
   * tastiera, un trascinamento): mostra l'avviso unico, lo stesso che compare
   * quando è l'API a rifiutare. Non fa niente se chi guarda può modificare.
   */
  avvisa: () => void;
}

const PUO_MODIFICARE: StatoSolaLettura = { solaLettura: false, motivo: "", avvisa: () => {} };

/** Le aree della pagina aperta. Fuori da una pagina guardata non ce ne sono: niente si spegne. */
const AreeDellaPagina = createContext<readonly Area[]>([]);

export function PaginaConAree({ aree, children }: { aree: readonly Area[]; children: ReactNode }) {
  return <AreeDellaPagina.Provider value={aree}>{children}</AreeDellaPagina.Provider>;
}

/**
 * Chi guarda può modificare? Senza argomento vale la pagina (basta la
 * scrittura su una delle sue aree, come per l'API); con un'area, quella.
 */
export function useSolaLettura(area?: Area | readonly Area[]): StatoSolaLettura {
  const { puo } = useAuth();
  const dellaPagina = useContext(AreeDellaPagina);
  const aree: readonly Area[] = area === undefined ? dellaPagina : typeof area === "string" ? [area] : area;
  const scrive = aree.length === 0 || aree.some(a => puo(a, "S"));
  const chiave = aree.join(",");
  return useMemo(
    () => {
      if (scrive) return PUO_MODIFICARE;
      const nomi = aree.map(a => NOMI_AREE[a]);
      const detail: RifiutoSolaLettura = { messaggio: mancaLaScrittura(nomi) };
      return {
        solaLettura: true,
        motivo: motivoSolaLettura(nomi),
        avvisa: () => { window.dispatchEvent(new CustomEvent(EVENTO_SOLA_LETTURA, { detail })); },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- le aree contano per valore, non per identità
    [scrive, chiave],
  );
}

/**
 * Avvolge un comando che modifica (un pulsante, una voce di menu): in sola
 * lettura lo spegne e gli mette il motivo. Il figlio deve accettare
 * `disabled`, `title` e `className`, come i pulsanti dell'app.
 *
 * Con `nascosto` in sola lettura il comando non si mostra affatto: è per le
 * azioni di riga (il cestino che compare al passaggio del mouse), che spente
 * su ogni riga sarebbero solo rumore. I comandi principali restano visibili:
 * chi legge deve sapere che la funzione esiste e perché non la può usare.
 */
export function SeScrive({ area, nascosto, children }: {
  area?: Area | readonly Area[];
  nascosto?: boolean;
  children: ReactElement<{ className?: string }>;
}) {
  const { solaLettura, motivo } = useSolaLettura(area);
  if (!solaLettura) return children;
  if (nascosto) return null;
  return cloneElement(children, propsDelComandoSpento(children.props.className, motivo) as object);
}
