/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DIAGRAMMA ORARIO-PERCORSO — programmato contro osservato
 * ───────────────────────────────────────────────────────────────────────────
 * Lo strumento canonico del mestiere, da centocinquant'anni: Étienne-Jules
 * Marey lo disegnò per le ferrovie francesi e da allora ogni ufficio movimento
 * legge l'esercizio così. Le fermate scorrono in verticale nell'ordine del
 * percorso, il tempo in orizzontale, e ogni corsa è una linea che scende. La
 * PENDENZA è la velocità: più la linea è ripida, più il mezzo è lento.
 *
 * Qui le linee sono due — l'orario e la realtà — e il messaggio è la loro
 * DIVERGENZA. Dove si allontanano, lì la corsa perde tempo. Una tabella di
 * venti numeri dice quanto; questo dice DOVE, che è la domanda a cui serve
 * rispondere per ritarare un orario.
 *
 * Entrambe le linee partono da zero, non dall'ora del giorno: così il
 * diagramma misura la PERCORRENZA e non la puntualità. Un mezzo partito con
 * cinque minuti di ritardo che li mantiene fino al capolinea qui appare
 * perfetto — perché lo è, dal punto di vista del tempo di percorrenza. Il
 * problema di quella corsa è alla partenza, e si guarda altrove.
 *
 * L'asse del tempo in orizzontale e le fermate in verticale è l'opposto di
 * come si legge un elenco, ed è voluto: è la convenzione del quadro orario
 * grafico, quella che chi lavora in esercizio legge senza pensarci.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";

export interface MareyStop {
  seq: number;
  stopName: string | null;
  stopId: string;
  /** orario previsto, secondi dalla mezzanotte */
  scheduledSec: number | null;
  /** transito reale */
  actualTs: string | null;
  delaySeconds: number | null;
  /** il mezzo è stato visto passare, oppure l'orario è stato ricostruito */
  recorded?: boolean;
  imputed?: boolean;
}

/* Il verde e il rosso portano il segno dello scarto; l'ardesia è l'orario,
 * che non ha un giudizio da dare — è il metro, non la misura. */
const C_PROG = "#64748b";
const C_TARDI = "#f87171";
const C_ANTICIPO = "#38bdf8";
const C_ORARIO = "#34d399";

function fmtDur(sec: number): string {
  const m = Math.floor(Math.abs(sec) / 60);
  const s = Math.round(Math.abs(sec) % 60);
  return `${sec < 0 ? "−" : ""}${m}′${String(s).padStart(2, "0")}″`;
}

function coloreScarto(sec: number | null): string {
  if (sec == null) return C_PROG;
  if (sec > 120) return C_TARDI;
  if (sec < -120) return C_ANTICIPO;
  return C_ORARIO;
}

export default function MareyChart({ stops }: { stops: MareyStop[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const dati = useMemo(() => {
    /* Servono le fermate con entrambi i termini: senza l'orario previsto non
     * c'è metro, senza il transito non c'è misura. */
    const utili = stops.filter(s => s.scheduledSec != null);
    if (utili.length < 2) return null;

    const sched0 = utili[0].scheduledSec!;
    const primoReale = utili.find(s => s.actualTs)?.actualTs;
    const reale0 = primoReale ? new Date(primoReale).getTime() : null;

    const punti = utili.map(s => {
      const tProg = s.scheduledSec! - sched0;
      const tReale = s.actualTs && reale0 != null
        ? Math.round((new Date(s.actualTs).getTime() - reale0) / 1000)
        : null;
      return {
        ...s,
        tProg,
        tReale,
        /* Lo scarto di PERCORRENZA: quanto tempo in più o in meno il mezzo ha
         * impiegato per arrivare fin qui, non quanto è in ritardo. */
        scarto: tReale != null ? tReale - tProg : null,
      };
    });

    const tMax = Math.max(
      ...punti.map(p => Math.max(p.tProg, p.tReale ?? 0)),
    );
    return { punti, tMax: Math.max(tMax, 60) };
  }, [stops]);

  if (!dati) {
    return (
      <div className="rounded-lg border border-border/50 bg-card/40 p-6 text-center text-xs text-muted-foreground">
        Servono almeno due fermate con orario previsto per disegnare il diagramma.
      </div>
    );
  }

  const { punti, tMax } = dati;

  /* Geometria. L'altezza cresce con le fermate: un percorso di quaranta
   * fermate non sta in trecento pixel senza diventare illeggibile. */
  const rigaH = 22;
  /* Il margine sinistro tiene il nome più lungo: fissarlo a occhio taglia le
   * etichette dei capolinea, che sono proprio quelle che si leggono per
   * prime. 6.2 px per carattere a 10px è la misura di DM Sans. */
  const maxNome = Math.max(...punti.map(p => Math.min((p.stopName ?? p.stopId).length, 22)));
  const padL = Math.max(120, Math.round(maxNome * 6.2) + 22);
  const padR = 62, padT = 26;
  const altezza = padT + punti.length * rigaH + 34;
  const larghezza = padL + 520 + padR;
  const plotW = larghezza - padL - padR;

  const x = (t: number) => padL + (t / tMax) * plotW;
  const y = (i: number) => padT + i * rigaH;

  const linea = (get: (p: typeof punti[0]) => number | null): string => {
    const segmenti: string[] = [];
    let aperto = false;
    punti.forEach((p, i) => {
      const t = get(p);
      if (t == null) { aperto = false; return; }
      segmenti.push(`${aperto ? "L" : "M"}${x(t).toFixed(1)},${y(i).toFixed(1)}`);
      aperto = true;
    });
    return segmenti.join(" ");
  };

  /* L'area fra le due linee è il tempo perso o guadagnato: è la quantità che
   * il diagramma esiste per mostrare, quindi va campita, non lasciata vuota. */
  const areaScarto = (): string => {
    const conEntrambi = punti.map((p, i) => ({ p, i })).filter(({ p }) => p.tReale != null);
    if (conEntrambi.length < 2) return "";
    const andata = conEntrambi.map(({ p, i }) => `${x(p.tProg).toFixed(1)},${y(i).toFixed(1)}`);
    const ritorno = [...conEntrambi].reverse()
      .map(({ p, i }) => `${x(p.tReale!).toFixed(1)},${y(i).toFixed(1)}`);
    return `M${andata.join(" L")} L${ritorno.join(" L")} Z`;
  };

  const scartoFinale = punti[punti.length - 1]?.scarto ?? null;
  /* Tacche ogni 5 minuti finché ci stanno, altrimenti ogni 10: una griglia
   * troppo fitta smette di essere un riferimento e diventa rumore. */
  const passo = tMax > 2400 ? 600 : 300;
  const tacche: number[] = [];
  for (let t = 0; t <= tMax; t += passo) tacche.push(t);

  return (
    <div className="rounded-lg border border-border/50 bg-card/40 overflow-x-auto">
      <div className="flex items-baseline gap-3 px-4 pt-3 pb-1">
        <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground">
          Orario · percorso
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          la distanza fra le due linee è il tempo perso o guadagnato
        </span>
        {scartoFinale != null && (
          <span
            className="ml-auto text-xs font-mono font-bold"
            style={{ color: coloreScarto(scartoFinale) }}
          >
            {scartoFinale > 0 ? "+" : ""}{fmtDur(scartoFinale)} al capolinea
          </span>
        )}
      </div>

      <svg
        width={larghezza}
        height={altezza}
        className="block"
        role="img"
        aria-label="Diagramma orario-percorso: confronto fra tempo previsto e tempo reale lungo la corsa"
      >
        {/* Griglia del tempo */}
        {tacche.map(t => (
          <g key={t}>
            <line
              x1={x(t)} y1={padT - 8} x2={x(t)} y2={altezza - 30}
              stroke="currentColor" className="text-border" strokeWidth={1} opacity={0.35}
            />
            <text
              x={x(t)} y={altezza - 16} textAnchor="middle" fontSize={9}
              className="fill-muted-foreground" fontFamily="var(--font-mono)"
            >
              {t === 0 ? "0" : `${Math.round(t / 60)}′`}
            </text>
          </g>
        ))}

        {/* Nomi delle fermate, nell'ordine del percorso */}
        {punti.map((p, i) => (
          <g key={`f-${p.seq}`}>
            <line
              x1={padL} y1={y(i)} x2={larghezza - padR} y2={y(i)}
              stroke="currentColor" className="text-border" strokeWidth={1}
              opacity={hover === i ? 0.5 : 0.12}
            />
            <text
              x={padL - 10} y={y(i) + 3.5} textAnchor="end" fontSize={10}
              className={hover === i ? "fill-foreground" : "fill-muted-foreground"}
            >
              {(p.stopName ?? p.stopId).length > 22
                ? `${(p.stopName ?? p.stopId).slice(0, 21)}…`
                : (p.stopName ?? p.stopId)}
            </text>
          </g>
        ))}

        {/* Il tempo perso o guadagnato, campito */}
        <path
          d={areaScarto()}
          fill={coloreScarto(scartoFinale)}
          opacity={0.13}
        />

        {/* L'orario: il metro, quindi tratteggiato e senza colore di giudizio */}
        <path
          d={linea(p => p.tProg)}
          fill="none" stroke={C_PROG} strokeWidth={1.5}
          strokeDasharray="4 3" strokeLinejoin="round"
        />

        {/* La realtà */}
        <path
          d={linea(p => p.tReale)}
          fill="none" stroke={coloreScarto(scartoFinale)} strokeWidth={2.5}
          strokeLinejoin="round" strokeLinecap="round"
        />

        {/* I punti. Pieno = il mezzo è stato visto passare; vuoto = l'orario è
            stato ricostruito da noi. La differenza deve restare leggibile. */}
        {punti.map((p, i) => {
          if (p.tReale == null) return null;
          const osservato = p.recorded !== false && !p.imputed;
          return (
            <circle
              key={`p-${p.seq}`}
              cx={x(p.tReale)} cy={y(i)} r={hover === i ? 4.5 : 3}
              fill={osservato ? coloreScarto(p.scarto) : "transparent"}
              stroke={coloreScarto(p.scarto)} strokeWidth={osservato ? 0 : 1.5}
              className="cursor-pointer transition-all"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <title>
                {`${p.stopName ?? p.stopId}\n`
                  + `previsto  ${fmtDur(p.tProg)} dalla partenza\n`
                  + `reale     ${fmtDur(p.tReale)}\n`
                  + `scarto    ${p.scarto! > 0 ? "+" : ""}${fmtDur(p.scarto!)}\n`
                  + (osservato ? "passaggio osservato" : "orario ricostruito")}
              </title>
            </circle>
          );
        })}

        {/* Lo scarto in cifre sulla fermata puntata: il diagramma dà la forma,
            il numero serve quando si deve decidere di quanto correggere. */}
        {hover != null && punti[hover]?.scarto != null && (
          <text
            x={larghezza - padR + 6} y={y(hover) + 3.5} fontSize={10}
            fontFamily="var(--font-mono)" fontWeight={700}
            fill={coloreScarto(punti[hover].scarto)}
          >
            {punti[hover].scarto! > 0 ? "+" : ""}{fmtDur(punti[hover].scarto!)}
          </text>
        )}
      </svg>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={C_PROG} strokeWidth="1.5" strokeDasharray="4 3" /></svg>
          orario
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={C_ORARIO} strokeWidth="2.5" /></svg>
          reale
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: C_ORARIO }} /> osservata
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full border" style={{ borderColor: C_ORARIO }} /> ricostruita
        </span>
        <span className="ml-auto">
          il tempo parte da zero alla prima fermata: si misura la percorrenza, non la puntualità
        </span>
      </div>
    </div>
  );
}
