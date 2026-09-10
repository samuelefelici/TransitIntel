/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGISTRO ANOMALIE — che cosa è andato storto oggi
 * ───────────────────────────────────────────────────────────────────────────
 * Il resto della Sala Operativa misura scostamenti. Qui si nominano i fatti,
 * e ogni fatto ha un simbolo suo: un mezzo uscito dal percorso e una corsa in
 * ritardo non si somigliano nella realtà, e non devono somigliarsi nemmeno
 * sullo schermo.
 *
 * L'ordine è per gravità, non cronologico: chi apre questa pagina non vuole
 * la storia della giornata, vuole sapere da dove cominciare.
 *
 * Ogni riga porta la sua CONFIDENZA. "Probabile" non è una sfumatura
 * decorativa: significa che il dato è compatibile con più spiegazioni, e che
 * prima di parlarne con qualcuno bisogna guardarci. Un elenco che presentasse
 * le probabili come certe manderebbe a contestare persone che non hanno fatto
 * nulla — e basterebbe una volta perché l'intero registro perda credito.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import {
  AlertTriangle, ArrowLeftRight, Clock, Download, MapPinOff,
  Rabbit, SkipForward, CircleSlash,
} from "lucide-react";

export type TipoAnomalia =
  | "anticipo_partenza" | "anticipo_percorso" | "ritardo_accumulato"
  | "fuori_percorso" | "fermate_saltate" | "corsa_non_effettuata";

export interface Anomalia {
  tipo: TipoAnomalia;
  gravita: number;
  confidenza: "certa" | "probabile";
  tripId: string;
  vehicleId: string | null;
  routeShortName: string | null;
  day: string;
  quando: string | null;
  dove: string | null;
  titolo: string;
  dettaglio: string;
  misure: Record<string, number | string | null>;
}

export interface RegistroResp {
  caronteAvailable: boolean;
  date?: string;
  giorni?: number;
  corseEsaminate?: number;
  anomalie: Anomalia[];
  troncato?: number;
  nota?: string;
  sintesi: {
    totale: number;
    perTipo: Array<{ tipo: TipoAnomalia; conteggio: number; etichetta: string }>;
    corseCoinvolte: number;
    gravitaMassima: number;
    nota: string;
  } | null;
}

/* Un simbolo per tipo, scelto sul fatto che descrive e non sul catalogo:
 * la lepre è la corsa partita prima, il segnale spezzato è il percorso
 * lasciato, la freccia che salta è la fermata non servita. */
const SEGNO: Record<TipoAnomalia, {
  icona: typeof Clock; colore: string; fondo: string; nome: string;
}> = {
  anticipo_partenza:   { icona: Rabbit,        colore: "#fbbf24", fondo: "rgba(251,191,36,0.12)",  nome: "Partenza anticipata" },
  anticipo_percorso:   { icona: ArrowLeftRight, colore: "#38bdf8", fondo: "rgba(56,189,248,0.12)",  nome: "Anticipo in linea" },
  ritardo_accumulato:  { icona: Clock,         colore: "#f87171", fondo: "rgba(248,113,113,0.12)", nome: "Ritardo che non rientra" },
  fuori_percorso:      { icona: MapPinOff,     colore: "#c084fc", fondo: "rgba(192,132,252,0.12)", nome: "Fuori percorso" },
  fermate_saltate:     { icona: SkipForward,   colore: "#fb923c", fondo: "rgba(251,146,60,0.12)",  nome: "Fermate non servite" },
  corsa_non_effettuata:{ icona: CircleSlash,   colore: "#94a3b8", fondo: "rgba(148,163,184,0.12)", nome: "Nessun passaggio" },
};

function fmtOra(ts: string | null): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}

export default function RegistroAnomalie({
  dati, urlCsv, onApriCorsa,
}: {
  dati: RegistroResp | undefined;
  urlCsv: string;
  onApriCorsa?: (tripId: string) => void;
}) {
  const [filtro, setFiltro] = useState<TipoAnomalia | null>(null);

  const visibili = useMemo(
    () => (dati?.anomalie ?? []).filter(a => !filtro || a.tipo === filtro),
    [dati, filtro],
  );

  if (!dati) {
    return <div className="p-8 text-center text-xs text-muted-foreground">Analisi in corso…</div>;
  }
  if (dati.nota) {
    return <div className="p-8 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">{dati.nota}</div>;
  }

  const s = dati.sintesi;

  return (
    <div className="flex flex-col min-h-0">
      {/* La riga che si legge per prima: com'è andata, in una frase. */}
      <div className="px-4 py-2.5 border-b border-border/40 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] leading-snug text-muted-foreground max-w-xl">
          {s?.nota}
        </span>
        <a
          href={urlCsv}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 border border-border/60 transition-colors"
        >
          <Download className="w-3 h-3" /> CSV
        </a>
      </div>

      {/* I tipi come filtri: il conteggio è già l'informazione, il clic
          restringe. Un tipo assente non compare — un contatore a zero
          occuperebbe spazio senza dire niente. */}
      {s && s.perTipo.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap gap-1.5 border-b border-border/30">
          <button
            onClick={() => setFiltro(null)}
            className={`px-2 py-1 rounded-lg text-[11px] border transition-colors ${
              filtro === null
                ? "bg-white/10 border-border text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:bg-white/5"
            }`}
          >
            Tutte {s.totale}
          </button>
          {s.perTipo.map(t => {
            const seg = SEGNO[t.tipo];
            const Ico = seg.icona;
            const attivo = filtro === t.tipo;
            return (
              <button
                key={t.tipo}
                onClick={() => setFiltro(attivo ? null : t.tipo)}
                className="px-2 py-1 rounded-lg text-[11px] border flex items-center gap-1.5 transition-colors"
                style={{
                  color: seg.colore,
                  backgroundColor: attivo ? seg.fondo : "transparent",
                  borderColor: attivo ? seg.colore + "66" : "transparent",
                }}
              >
                <Ico className="w-3 h-3" />
                {seg.nome} {t.conteggio}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto divide-y divide-border/30">
        {visibili.length === 0 && (
          <div className="p-8 text-center text-xs text-muted-foreground">
            {s?.totale === 0
              ? "Nessuna anomalia: le corse osservate rispettano percorso e orario."
              : "Nessuna anomalia di questo tipo."}
          </div>
        )}

        {visibili.map((a, i) => {
          const seg = SEGNO[a.tipo];
          const Ico = seg.icona;
          return (
            <button
              key={`${a.tripId}-${a.day}-${a.tipo}-${i}`}
              onClick={() => onApriCorsa?.(a.tripId)}
              className="w-full text-left px-4 py-2.5 flex gap-3 hover:bg-white/[0.03] transition-colors"
            >
              {/* Il simbolo porta il tipo; la barretta a sinistra la gravità,
                  che si legge di sfuggita scorrendo l'elenco. */}
              <span
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: seg.fondo, color: seg.colore }}
              >
                <Ico className="w-4 h-4" />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-xs font-semibold" style={{ color: seg.colore }}>
                    {a.titolo}
                  </span>
                  {a.confidenza === "probabile" && (
                    <span
                      className="px-1.5 py-px rounded text-[9px] font-medium border border-border/60 text-muted-foreground"
                      title="Il dato è compatibile con più spiegazioni: da guardare prima di trarne conclusioni"
                    >
                      da verificare
                    </span>
                  )}
                  <span className="ml-auto text-[10px] font-mono text-muted-foreground">
                    {fmtOra(a.quando)}
                  </span>
                </span>

                <span className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                  {a.routeShortName && (
                    <span className="px-1 rounded bg-white/10 font-bold text-foreground">
                      {a.routeShortName}
                    </span>
                  )}
                  {a.vehicleId && <span className="font-mono">{a.vehicleId}</span>}
                  {a.dove && <span className="truncate">{a.dove}</span>}
                </span>

                <span className="mt-1 block text-[10px] text-muted-foreground/80 leading-snug">
                  {a.dettaglio}
                </span>
              </span>
            </button>
          );
        })}

        {dati.troncato && (
          <div className="px-4 py-2 text-[10px] text-muted-foreground">
            Mostrate le 500 più gravi di {dati.troncato}. L'export CSV le contiene tutte.
          </div>
        )}
      </div>

      {dati.corseEsaminate != null && (
        <div className="px-4 py-1.5 border-t border-border/40 text-[10px] text-muted-foreground">
          {dati.corseEsaminate} corse esaminate
          {s && s.corseCoinvolte > 0 && ` · ${s.corseCoinvolte} con almeno un'anomalia`}
        </div>
      )}
    </div>
  );
}
