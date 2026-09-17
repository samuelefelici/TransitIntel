/**
 * ReportOptionsDialog — che cosa mettere nella relazione, prima di generarla.
 *
 * Nasce da una cosa vista in uso: il capitolo delle coincidenze con diciassette
 * linee dentro non si legge. Chi esporta la relazione sa già quali relazioni gli
 * interessano — «la 1/4 e la 44 a Piazza Cavour», «la 2/6 col 21/33 al
 * Pinocchio» — e sceglierle qui costa un secondo.
 *
 * La regola è una sola, ed è scritta anche nel documento:
 *   · due o più linee scelte → le relazioni con TUTTI E DUE i capi fra quelle;
 *   · una sola linea         → tutte le relazioni che la toccano;
 *   · nessuna                → tutta la rete, come prima.
 *
 * Il taglio è del DOCUMENTO, non del dato: il dossier archiviato resta intero.
 */
import { useMemo, useState } from "react";
import { X, FileText, Waypoints } from "lucide-react";

interface Props {
  /** Le linee del piano, così come si chiamano sul quadro orario. */
  lines: string[];
  busy?: boolean;
  onClose: () => void;
  onConfirm: (opts: { coincidenzeLinee: string[] }) => void;
}

/** In ordine alfabetico «24» viene prima di «3»: per un quadro orario è sbagliato. */
export function ordineDiLinea(nome: string): [number, string] {
  const m = /\d+/.exec(nome ?? "");
  return [m ? Number(m[0]) : 1e6, String(nome ?? "")];
}

export function ordinaLinee(linee: string[]): string[] {
  return [...linee].sort((a, b) => {
    const [na, ta] = ordineDiLinea(a), [nb, tb] = ordineDiLinea(b);
    return na - nb || ta.localeCompare(tb);
  });
}

/**
 * LE LINEE DEL PIANO, non tutto quello che ha un `routeName`.
 *
 * Il turno macchina porta anche i fuorilinea, e il motore dà anche a quelli un
 * nome che sembra una linea: «Uscita Ancona (1.2 km)», «Rientro Ancona (1.1
 * km)», «Vuoto (2.1 km)». Finivano tutti nell'elenco da spuntare, e di una
 * coincidenza fra due fuorilinea non esiste il concetto.
 *
 * Due segnali, tutti e due autorevoli: il `type` dichiarato dal motore
 * (`deadhead` e `depot` non sono corse) e il `routeId`, che sulle voci
 * sintetiche è sempre vuoto — così l'elenco regge anche sugli scenari salvati
 * prima che il `type` esistesse.
 */
export function lineeDelPiano(turni: unknown): string[] {
  const fuori = new Set<string>();
  for (const t of (Array.isArray(turni) ? turni : []) as any[]) {
    for (const c of (Array.isArray(t?.trips) ? t.trips : []) as any[]) {
      const tipo = String(c?.type ?? "trip");
      if (tipo !== "trip") continue;                       // fuorilinea e rientri in deposito
      if (!String(c?.routeId ?? "").trim()) continue;      // le voci sintetiche non hanno linea
      const nome = String(c?.routeName ?? "").trim();
      if (nome) fuori.add(nome);
    }
  }
  return ordinaLinee([...fuori]);
}

export function ReportOptionsDialog({ lines, busy, onClose, onConfirm }: Props) {
  const tutte = useMemo(() => ordinaLinee([...new Set(lines.filter(Boolean))]), [lines]);
  const [scelte, setScelte] = useState<Set<string>>(new Set());

  const attiva = (l: string) => {
    setScelte(prev => {
      const n = new Set(prev);
      if (n.has(l)) n.delete(l); else n.add(l);
      return n;
    });
  };

  const regola = scelte.size === 0
    ? "Nessuna scelta: il capitolo mostra tutte le relazioni della rete."
    : scelte.size === 1
      ? `Una linea sola: il capitolo mostra tutte le relazioni che toccano la ${[...scelte][0]}.`
      : `${scelte.size} linee: il capitolo mostra le relazioni con tutti e due i capi fra queste.`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg mx-4 rounded-lg border border-border/60 bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-teal-400" />
            <h3 className="text-sm font-semibold">Genera la relazione</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Waypoints className="w-3.5 h-3.5 text-muted-foreground" />
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Coincidenze: di quali linee
            </label>
          </div>

          {tutte.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              Il piano non porta nomi di linea: il capitolo uscirà con tutta la rete.
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 max-h-52 overflow-y-auto">
              {tutte.map(l => {
                const on = scelte.has(l);
                return (
                  <button
                    key={l}
                    onClick={() => attiva(l)}
                    className={`text-xs px-2.5 py-1 rounded border transition ${
                      on
                        ? "bg-teal-600 border-teal-600 text-white"
                        : "bg-background hover:bg-muted/40 text-foreground border-border/50"
                    }`}
                  >
                    {l}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-3 text-[11px]">
            <button
              onClick={() => setScelte(new Set(tutte))}
              className="text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              tutte
            </button>
            <button
              onClick={() => setScelte(new Set())}
              className="text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              nessuna
            </button>
          </div>

          <div className="text-[10px] text-muted-foreground border-t border-border/40 pt-2">
            {regola} Il dossier archiviato resta comunque intero: il taglio è del documento, non del dato.
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/40">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-border/50 hover:bg-muted/40 transition"
          >
            Annulla
          </button>
          <button
            onClick={() => onConfirm({ coincidenzeLinee: [...scelte] })}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 transition"
          >
            {busy ? "Genero…" : "Genera relazione"}
          </button>
        </div>
      </div>
    </div>
  );
}
