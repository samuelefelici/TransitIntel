/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL DETTAGLIO DI UNA CORSA — la legenda e le fermate
 * ───────────────────────────────────────────────────────────────────────────
 * Le due parti del pannello di destra che si possono guardare da sole, e che
 * quindi si possono collaudare da sole: la scala dei colori e l'elenco delle
 * fermate con orario programmato, transito e scarto.
 *
 * Stanno qui e non dentro la pagina perché la pagina non si può disegnare
 * senza una mappa, un token e una rete — e un difetto di resa di questa
 * tabella non si vede leggendo il codice, si vede guardandola.
 *
 * ── Tre livelli di verità, e non vanno mescolati ──
 *
 *   OSSERVATO     il mezzo è stato visto passare. È una misura.
 *   RICOSTRUITO   dedotto fra due passaggi osservati: è già successo, ma il
 *                 momento esatto l'abbiamo calcolato noi.
 *   PREVISTO      il mezzo non è ancora arrivato lì. Il numero è utile — dice
 *                 fra quanto aspettarlo — ma non è successo niente.
 *
 * Il colore del ritardo spetta solo al primo e al secondo. Dipingere di rosso
 * una fermata che il mezzo deve ancora raggiungere significa mostrare una
 * previsione col peso di un fatto.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Il colore di uno scarto, come l'ha deciso il server. */
export interface Tinta {
  colore: string;
  stato: "anticipo" | "orario" | "ritardo" | "ignoto";
  etichetta: string;
  scarto: string;
}

export interface Legenda {
  tacche: Array<{ sec: number; colore: string; etichetta: string }>;
  sogliaRitardoSec: number;
  sogliaAnticipoSec: number;
  nota: string;
}

export interface FermataCorsa {
  seq: number | null;
  stopId: string | null;
  stopName: string | null;
  lat: number | null;
  lon: number | null;
  scheduled: string | null;
  actualTs: string | null;
  delaySeconds: number | null;
  delayOrigin: "avm" | "calcolato" | "ricostruito" | null;
  origine: "osservato" | "interpolato" | "estrapolato" | null;
  /** false = il mezzo non è ancora arrivato qui: l'orario è una previsione */
  raggiunta?: boolean;
  tinta: Tinta;
}

/** Il grigio di "non si sa". Mai usato per uno scarto vero. */
export const IGNOTO = "#64748b";

/**
 * Se la tinta non arriva — server più vecchio della pagina durante un
 * aggiornamento — NON si ricalcola qui: si mostra il grigio e il numero resta
 * leggibile. Ricalcolarla vorrebbe dire riavere due scale che si assomigliano,
 * ed è esattamente la cosa che il colore deciso dal server esiste per impedire.
 */
export function colore(t: Tinta | null | undefined): string {
  return t?.colore ?? IGNOTO;
}

export function fmtDelay(s: number | null | undefined): string {
  if (s == null) return "—";
  const sign = s < 0 ? "-" : "+";
  const abs = Math.abs(s);
  return `${sign}${Math.floor(abs / 60)}'${String(abs % 60).padStart(2, "0")}"`;
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString("it-IT",
      { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return "—"; }
}

/* ── La legenda ───────────────────────────────────────────────────────────── */

/**
 * Non è un ornamento: senza, "verde" e "blu" sono due colori, e nessuno può
 * sapere che il blu vuol dire anticipo — né che l'anticipo non è una buona
 * notizia. Le tacche e la frase arrivano dal server insieme ai colori che
 * spiegano, così non possono raccontare una scala diversa da quella disegnata.
 */
export function LegendaRitardo({ l }: { l: Legenda }) {
  const min = l.tacche[0].sec;
  const max = l.tacche[l.tacche.length - 1].sec;
  /* Le tacche vanno messe DOVE CADONO, non a distanza uguale. La scala non è
   * simmetrica — cinque minuti di anticipo contro un quarto d'ora di ritardo —
   * e spaziando le tacche in parti uguali lo zero finirebbe a metà barra
   * mentre nella scala vera sta a un quarto: la legenda mostrerebbe una scala
   * diversa da quella che colora la mappa. */
  const dove = (sec: number) => ((sec - min) / (max - min)) * 100;
  const sfumatura = `linear-gradient(to right, ${l.tacche
    .map(t => `${t.colore} ${dove(t.sec).toFixed(1)}%`).join(", ")})`;
  const zero = dove(0);
  return (
    <div className="px-3 py-2 border-b border-border/40 space-y-1">
      <div className="relative">
        <div className="h-2 rounded-full" style={{ background: sfumatura }} />
        {/* Il segno dell'orario esatto, sopra il punto in cui il verde cade
            davvero: è il riferimento rispetto a cui si legge tutto il resto. */}
        <div
          className="absolute -top-0.5 h-3 w-px bg-white/80"
          style={{ left: `${zero}%` }}
        />
      </div>
      <div className="relative h-3 text-[9px] font-mono text-muted-foreground">
        <span className="absolute left-0">{fmtDelay(min)}</span>
        <span
          className="absolute text-emerald-400 font-semibold -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${zero}%` }}
        >
          in orario
        </span>
        <span className="absolute right-0">{fmtDelay(max)}</span>
      </div>
      <p className="text-[9px] text-muted-foreground leading-snug">{l.nota}</p>
    </div>
  );
}

/* ── Le fermate ───────────────────────────────────────────────────────────── */

export function TabellaFermate({ fermate }: { fermate: FermataCorsa[] }) {
  if (fermate.length === 0) return null;
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="px-1.5 py-1 font-medium">Fermata</th>
          <th className="px-1.5 py-1 font-medium text-right">Progr.</th>
          <th className="px-1.5 py-1 font-medium text-right">Reale</th>
          <th className="px-1.5 py-1 font-medium text-right">Δ</th>
        </tr>
      </thead>
      <tbody>
        {fermate.map((s, i) => {
          const transitato = s.actualTs != null;
          const dedotto = s.origine === "interpolato" || s.origine === "estrapolato";
          /* Oltre l'ultima fermata vista passare, l'orario che compare è una
             PREVISIONE: prolunga lo scarto corrente. Il numero serve — dice
             fra quanto aspettare il mezzo — ma non deve avere il colore e il
             peso di una misura. */
          const daVenire = s.raggiunta === false;
          return (
            <tr
              key={`${s.stopId}-${i}`}
              className={`border-t border-border/30 ${transitato ? "" : "opacity-50"}`}
            >
              <td className="px-1.5 py-1 truncate max-w-[120px]" title={s.stopName ?? s.stopId ?? ""}>
                {/* Un orario dedotto non deve somigliare a uno misurato: il
                    pallino lo dice prima che si leggano i numeri. */}
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${
                    s.origine === "osservato" ? "bg-emerald-400"
                      : s.origine ? "border border-slate-400" : "bg-transparent"
                  }`}
                  title={s.origine === "osservato" ? "passaggio osservato"
                    : daVenire ? "previsione: il mezzo non è ancora arrivato qui"
                    : s.origine === "interpolato" ? "ricostruito fra due passaggi osservati"
                    : s.origine === "estrapolato" ? "stimato al capolinea, scarto costante"
                    : "nessun orario"}
                />
                {s.stopName ?? s.stopId ?? "—"}
              </td>
              <td className="px-1.5 py-1 text-right font-mono">{s.scheduled?.slice(0, 5) ?? "—"}</td>
              <td className={`px-1.5 py-1 text-right font-mono ${dedotto ? "italic text-muted-foreground" : ""}`}>
                {transitato ? `${daVenire ? "~" : ""}${fmtTime(s.actualTs).slice(0, 5)}` : "—"}
              </td>
              {/* Una previsione non va urlata come una misura: senza il colore
                  restava in bianco grassetto, cioè PIÙ forte delle righe
                  misurate accanto — l'esatto contrario di quello che deve
                  dire. Smorzata, col ~ davanti, resta leggibile e si vede che
                  non è successo ancora niente. */}
              <td
                className={`px-1.5 py-1 text-right font-mono ${
                  daVenire ? "text-muted-foreground/70" : "font-semibold"
                }`}
                style={{ color: transitato && !daVenire ? colore(s.tinta) : undefined }}
                title={daVenire
                  ? "previsione: il mezzo non è ancora passato di qui"
                  : s.delayOrigin === "avm" ? "ritardo dichiarato dall'AVM"
                  : s.delayOrigin === "calcolato"
                    ? "calcolato: transito reale meno orario programmato"
                    : undefined}
              >
                {transitato && s.delaySeconds != null
                  ? `${daVenire ? "~" : ""}${fmtDelay(s.delaySeconds)}` : ""}
                {transitato && !daVenire && s.delayOrigin === "calcolato" && (
                  <span className="text-muted-foreground font-normal">*</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
