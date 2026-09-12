/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AVANZAMENTO CORSE — l'intera flotta in una schermata, in ordine di urgenza
 * ───────────────────────────────────────────────────────────────────────────
 * La mappa risponde a "dove sono i mezzi". Chi sta in sala operativa ha però
 * una domanda diversa e più pressante: CHI DEVO GUARDARE ADESSO. Su una mappa
 * quella risposta non c'è — i mezzi sono sparsi sul territorio, e per sapere
 * quale è in difficoltà bisogna cliccarli uno per uno.
 *
 * Qui ogni corsa è una riga: la barra è il percorso da capolinea a capolinea,
 * il segno è il punto in cui il mezzo è arrivato, il colore è la puntualità.
 * Le corse in ritardo stanno in cima, perché è da lì che si comincia.
 *
 * Non si disegna una "posizione prevista": richiederebbe di sapere dove il
 * mezzo dovrebbe trovarsi in questo istante, e quel dato non ce l'abbiamo —
 * inventarlo interpolando renderebbe la barra un'illusione precisa. Si mostra
 * la progressione reale e, accanto, il ritardo misurato: due fatti, nessuna
 * congettura.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo } from "react";

export interface CorsaInLinea {
  vehicleId: string | null;
  tripId: string | null;
  routeShortName: string | null;
  routeId: string | null;
  routeColor: string | null;
  headsign: string | null;
  nearestStopName: string | null;
  delaySeconds: number | null;
  /** il colore dello scarto, deciso dal server */
  tinta?: { colore: string; etichetta: string };
  /** progressivo dell'ultima fermata transitata */
  lastStopSeq: number | null;
  totalStops: number | null;
  ts: string;
}

/* Il colore arriva dal server, con la stessa scala della mappa e della tabella
 * delle fermate. Qui ne viveva una terza, simile ma non uguale: l'anticipo era
 * azzurro invece che blu e le tre tinte erano scelte a occhio. Bastava
 * ritoccare una soglia da una parte perché lo stesso mezzo risultasse in
 * ritardo in questo elenco e in orario sulla mappa accanto. */
const C_IGNOTO = "#64748b";

function colore(t: { colore: string } | null | undefined): string {
  return t?.colore ?? C_IGNOTO;
}

function fmtDelay(s: number | null): string {
  if (s == null) return "—";
  const m = Math.floor(Math.abs(s) / 60);
  const ss = Math.abs(s) % 60;
  return `${s < 0 ? "−" : "+"}${m}′${String(ss).padStart(2, "0")}″`;
}

export default function AvanzamentoCorse({
  corse, selectedKey, onSelect,
}: {
  corse: CorsaInLinea[];
  selectedKey: string | null;
  onSelect: (v: CorsaInLinea) => void;
}) {
  /* In cima chi è più in ritardo: è l'ordine in cui si lavora. I mezzi senza
   * misura vanno in fondo — non sono un problema, sono un'assenza di dato. */
  const ordinate = useMemo(() => [...corse].sort((a, b) => {
    const da = a.delaySeconds, db = b.delaySeconds;
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return db - da;
  }), [corse]);

  const inRitardo = ordinate.filter(c => (c.delaySeconds ?? 0) > 300).length;

  if (corse.length === 0) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground">
        Nessuna corsa in linea in questo momento.
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-4 py-2 flex items-baseline gap-3 border-b border-border/40">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {ordinate.length} corse in linea
        </span>
        {inRitardo > 0 && (
          <span className="text-[11px] font-semibold" /* il colore di chi è in ritardo lo dà la prima corsa che lo è:
               così l'intestazione non può usare un rosso diverso dalle righe */
            style={{ color: colore(ordinate.find(c => (c.delaySeconds ?? 0) > 300)?.tinta) }}>
            {inRitardo} oltre i 5 minuti
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          la barra è il percorso · il segno è dove il mezzo è arrivato
        </span>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-border/30">
        {ordinate.map((c) => {
          const key = c.vehicleId ?? c.tripId ?? c.ts;
          const sel = key === selectedKey;
          const col = colore(c.tinta);
          /* La progressione è nota solo se il feed dice quante fermate ha la
           * corsa: senza denominatore non c'è frazione da disegnare. */
          const quota = c.lastStopSeq != null && c.totalStops
            ? Math.min(1, Math.max(0, c.lastStopSeq / c.totalStops))
            : null;

          return (
            <button
              key={key}
              onClick={() => onSelect(c)}
              className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
                sel ? "bg-sky-500/10" : "hover:bg-white/[0.03]"
              }`}
            >
              <span
                className="shrink-0 w-9 h-6 rounded flex items-center justify-center text-[11px] font-bold text-white"
                style={{ backgroundColor: c.routeColor ? `#${c.routeColor.replace(/^#/, "")}` : "#334155" }}
              >
                {c.routeShortName ?? c.routeId ?? "n/d"}
              </span>

              <span className="shrink-0 w-16 text-[11px] font-mono text-muted-foreground truncate">
                {c.vehicleId ?? "—"}
              </span>

              {/* Il percorso. Barra piena fin dove il mezzo è arrivato. */}
              <span className="flex-1 min-w-0">
                <span className="relative block h-1.5 rounded-full bg-white/[0.07]">
                  {quota != null && (
                    <>
                      <span
                        className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                        style={{ width: `${quota * 100}%`, backgroundColor: col, opacity: 0.45 }}
                      />
                      <span
                        className="absolute top-1/2 w-2 h-2 rounded-full -translate-y-1/2 -translate-x-1/2 ring-2 ring-background transition-all duration-500"
                        style={{ left: `${quota * 100}%`, backgroundColor: col }}
                      />
                    </>
                  )}
                </span>
                <span className="mt-1 block text-[10px] text-muted-foreground truncate">
                  {c.nearestStopName ?? c.headsign ?? "in transito"}
                  {c.lastStopSeq != null && c.totalStops
                    ? ` · ${c.lastStopSeq}/${c.totalStops}`
                    : ""}
                </span>
              </span>

              <span
                className="shrink-0 w-16 text-right text-[11px] font-mono font-bold"
                style={{ color: col }}
              >
                {fmtDelay(c.delaySeconds)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
