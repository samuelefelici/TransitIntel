/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LO STORICO DIETRO IL VERDETTO — dove la corsa perde o guadagna i minuti
 * ───────────────────────────────────────────────────────────────────────────
 * Le altre tre viste mostrano UNA giornata: servono a capire cos'è successo
 * ieri. Questa mostra lo storico su una classe di giornata, che è ciò su cui
 * il verdetto "troppo stretto / troppo largo" è stato dato. Finora quel
 * verdetto era una cosa da credere sulla fiducia; qui diventa una tratta con
 * un nome e un numero di minuti.
 *
 * IL SEGNO SI LEGGE PRIMA DEL NUMERO. Ogni tratta è una barra che parte da una
 * tacca — il tempo che l'orario concede — e si allunga fino al tempo davvero
 * impiegato. Se sfonda la tacca, l'eccesso è rosso; se si ferma prima, il
 * tempo che avanza è azzurro. Non serve leggere una cifra per vedere quali
 * righe sono il problema, ed è la ragione per cui questa non è una tabella.
 *
 * LE TRATTE SONO IN ORDINE DI PERCORSO, non di gravità: è come la corsa viene
 * letta da chi la conosce, e permette di vedere se il tempo si perde tutto in
 * un punto o un po' ovunque — due diagnosi diverse, due rimedi diversi. La
 * tratta peggiore è nominata a parte, in testa.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, TrendingDown, TrendingUp, Minus, HelpCircle } from "lucide-react";
import { apiFetch } from "@/lib/api";

type Verdetto = "stretto" | "largo" | "adeguato" | "insufficiente";

interface FermataStorica {
  seq: number;
  stopId: string;
  stopName: string | null;
  scheduled: string | null;
  giorni: number;
  scartoMedianoSec: number | null;
  scartoP85Sec: number | null;
  scartoMinSec: number | null;
  scartoMaxSec: number | null;
}

interface TrattaStorica {
  daSeq: number; aSeq: number;
  daStopId: string; aStopId: string;
  daNome: string | null; aNome: string | null;
  fermateScavalcate: number;
  programmatoSec: number | null;
  giorni: number;
  medianaSec: number; p85Sec: number; minSec: number; maxSec: number;
  scartoMedianaSec: number | null; scartoP85Sec: number | null;
  verdetto: Verdetto;
  motivo: string;
}

interface Storico {
  classe: string | null;
  classeLabel: string | null;
  giornate: number;
  fermate: FermataStorica[];
  tratte: TrattaStorica[];
  trattaPeggiore: TrattaStorica | null;
  nota: string;
}

interface Risposta {
  caronteAvailable: boolean;
  tripId?: string;
  days?: number;
  nota?: string;
  validita?: {
    psProjectId?: string;
    scelto?: "indicato" | "riconosciuto" | "assente";
    profiloCaricato: boolean;
    nota: string;
  };
  classiDisponibili?: Array<{ classe: string; label: string; giornate: number }>;
  storico: Storico | null;
}

const SEGNO: Record<Verdetto, { colore: string; icona: typeof Minus; testo: string }> = {
  stretto:       { colore: "#f87171", icona: TrendingUp,   testo: "manca tempo" },
  largo:         { colore: "#7dd3fc", icona: TrendingDown, testo: "avanza tempo" },
  adeguato:      { colore: "#34d399", icona: Minus,        testo: "adeguata" },
  insufficiente: { colore: "#64748b", icona: HelpCircle,   testo: "pochi dati" },
};

/** Secondi → "8′30″": come si dicono a voce, non come si scrivono in log. */
function dur(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const a = Math.abs(Math.round(sec));
  const m = Math.floor(a / 60), s = a % 60;
  const t = m > 0 ? `${m}′${s > 0 ? `${String(s).padStart(2, "0")}″` : ""}` : `${s}″`;
  return sec < 0 ? `−${t}` : t;
}

function segnato(sec: number | null | undefined): string {
  if (sec == null) return "—";
  return (sec > 0 ? "+" : "") + dur(sec);
}

export default function StoricoTratte({ tripId, days }: { tripId: string; days: number }) {
  const [classe, setClasse] = useState<string>("");

  const qs = new URLSearchParams({ days: String(days) });
  if (classe) qs.set("classe", classe);

  const q = useQuery({
    queryKey: ["runtime-history", tripId, days, classe],
    queryFn: () => apiFetch<Risposta>(
      `/api/operations/trips/${encodeURIComponent(tripId)}/runtime-history?${qs.toString()}`),
  });

  const d = q.data;
  const st = d?.storico ?? null;

  /* Una scala sola per tutte le barre: righe con scale diverse sembrerebbero
   * confrontabili senza esserlo, che è il modo più facile di mentire con un
   * grafico. */
  const scalaMax = useMemo(() => {
    if (!st) return 1;
    const v = st.tratte.flatMap(t => [t.programmatoSec ?? 0, t.medianaSec, t.p85Sec]);
    return Math.max(60, ...v);
  }, [st]);

  if (q.isLoading) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Raccolgo lo storico della corsa…
      </div>
    );
  }
  if (!d || !st) {
    return (
      <div className="py-8 text-center text-xs text-muted-foreground max-w-lg mx-auto leading-relaxed">
        {d?.nota ?? "Nessuno storico disponibile per questa corsa."}
      </div>
    );
  }

  const pct = (sec: number) => `${Math.max(0, Math.min(100, (sec / scalaMax) * 100))}%`;

  return (
    <div className="space-y-3">
      {/* Su quali giornate stiamo guardando. Sta in cima perché cambia il
          significato di ogni numero sotto. */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-muted-foreground">Classe di giornata:</span>
        <select
          value={classe || (st.classe ?? "")}
          onChange={e => setClasse(e.target.value)}
          className="px-2 py-1 rounded bg-card border border-border/60 text-[11px]">
          {(d.classiDisponibili ?? []).map(c => (
            <option key={c.classe} value={c.classe}>
              {c.label} · {c.giornate} giornate
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">
          {st.giornate} giornate osservate negli ultimi {d.days} giorni
        </span>
        <a
          href={`/api/operations/trips/${encodeURIComponent(tripId)}/runtime-history?${qs.toString()}&formato=csv`}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-border/60 transition-colors">
          <Download className="w-3 h-3" /> CSV tratte
        </a>
      </div>

      {/* La frase che nomina il punto critico: è la risposta, il resto è la prova. */}
      <div className="px-3 py-2 rounded-lg bg-white/5 border border-border/50 text-[11px] leading-relaxed">
        {st.nota}
      </div>

      {/* Ambra quando le scuole NON sono distinguibili: lì i numeri mescolano
          settembre e agosto. Neutro quando il calendario c'è ma l'ha scelto il
          sistema: è un'informazione, non un allarme — però va detta, perché
          chi legge deve sapere che può indicarne un altro. */}
      {(!d.validita?.profiloCaricato || d.validita?.scelto === "riconosciuto") && (
        <div className={`px-3 py-2 rounded-lg text-[10px] leading-relaxed border ${
          d.validita?.profiloCaricato
            ? "bg-white/5 border-border/50 text-muted-foreground"
            : "bg-amber-500/10 border-amber-500/30 text-amber-200/90"
        }`}>
          {d.validita?.nota}
        </div>
      )}

      {/* ── Profilo dello scarto lungo il percorso ────────────────────────
          Le tratte dicono dove si perde tempo; questo dice dove il ritardo si
          è ACCUMULATO, che è la stessa corsa vista per somme e non per pezzi.
          Insieme distinguono "un punto critico" da "un po' ovunque". */}
      {st.fermate.some(f => f.scartoMedianoSec != null) && (
        <ProfiloScarto fermate={st.fermate} />
      )}

      {st.tratte.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          Nessuna tratta misurabile: servono due fermate rilevate nella stessa corsa.
        </div>
      ) : (
        <div className="space-y-1">
          {/* Legenda della scala: senza, la lunghezza di una barra non vuol dire nulla. */}
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground px-1">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#475569" }} /> impiegato
            </span>
            <span className="flex items-center gap-1">
              <span className="w-0.5 h-3" style={{ background: "#e2e8f0" }} /> concesso dall'orario
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#f87171" }} /> in più
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#7dd3fc" }} /> che avanza
            </span>
            <span className="ml-auto">scala 0 – {dur(scalaMax)}</span>
          </div>

          {st.tratte.map(t => {
            const seg = SEGNO[t.verdetto];
            const Ico = seg.icona;
            const peggiore = st.trattaPeggiore
              && st.trattaPeggiore.daSeq === t.daSeq && st.trattaPeggiore.aSeq === t.aSeq;
            const prog = t.programmatoSec;
            const ecc = prog != null ? Math.max(0, t.medianaSec - prog) : 0;
            const avanza = prog != null ? Math.max(0, prog - t.medianaSec) : 0;

            return (
              <div
                key={`${t.daSeq}-${t.aSeq}`}
                title={t.motivo}
                className={`px-2 py-1.5 rounded-lg flex items-center gap-3 ${
                  peggiore ? "bg-white/[0.07] ring-1 ring-inset" : "hover:bg-white/[0.03]"
                }`}
                style={peggiore ? { boxShadow: `inset 0 0 0 1px ${seg.colore}55` } : undefined}>

                <Ico className="shrink-0 w-3.5 h-3.5" style={{ color: seg.colore }} />

                <span className="shrink-0 w-72 min-w-0 text-[11px] leading-tight">
                  <span className="block truncate">
                    {t.daNome ?? t.daStopId} <span className="text-muted-foreground">→</span> {t.aNome ?? t.aStopId}
                  </span>
                  {t.fermateScavalcate > 0 && (
                    <span className="block text-[9px] text-muted-foreground/70">
                      scavalca {t.fermateScavalcate} fermat{t.fermateScavalcate === 1 ? "a" : "e"} mai rilevat{t.fermateScavalcate === 1 ? "a" : "e"}
                    </span>
                  )}
                </span>

                {/* La barra. La tacca è l'orario: il messaggio è se la barra la
                    sfonda. Su una riga senza abbastanza giornate la barra si
                    smorza: dichiarare il dato inaffidabile e poi dipingerlo
                    rosso acceso come gli altri è dire due cose opposte, e vince
                    sempre quella che si vede. */}
                <span
                  className="relative flex-1 h-5 min-w-[8rem] rounded bg-white/[0.04]"
                  style={t.verdetto === "insufficiente" ? { opacity: 0.35 } : undefined}>
                  <span className="absolute inset-y-1 left-0 rounded-sm"
                    style={{ width: pct(Math.min(t.medianaSec, prog ?? t.medianaSec)), background: "#475569" }} />
                  {ecc > 0 && prog != null && (
                    <span className="absolute inset-y-1 rounded-r-sm"
                      style={{ left: pct(prog), width: pct(ecc), background: "#f87171" }} />
                  )}
                  {avanza > 0 && prog != null && (
                    <span className="absolute inset-y-[9px] rounded-sm opacity-70"
                      style={{ left: pct(t.medianaSec), width: pct(avanza), background: "#7dd3fc" }} />
                  )}
                  {/* p85: la coda che decide se un orario "regge quasi sempre". */}
                  <span className="absolute inset-y-0 w-px bg-white/30"
                    style={{ left: pct(t.p85Sec) }} title={`p85 ${dur(t.p85Sec)}`} />
                  {prog != null && (
                    <span className="absolute inset-y-0 w-0.5 bg-slate-200"
                      style={{ left: pct(prog) }} />
                  )}
                </span>

                <span className="shrink-0 w-40 text-right text-[10px] font-mono leading-tight">
                  <span className="block">
                    {dur(t.medianaSec)} <span className="text-muted-foreground/60">su</span> {dur(prog)}
                  </span>
                  <span className="block" style={{ color: seg.colore }}>
                    {segnato(t.scartoMedianaSec)} · p85 {segnato(t.scartoP85Sec)}
                  </span>
                </span>

                <span className="shrink-0 w-16 text-right text-[10px] text-muted-foreground/70">
                  {t.giorni} gg
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* La regola che rende leggibili tutti i numeri sopra: senza, qualcuno
          si chiederà perché le fermate ricostruite non ci sono. */}
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed px-1">
        Entrano solo i transiti <strong>osservati</strong>. Le fermate ricostruite per
        interpolazione hanno, per come sono calcolate, esattamente il tempo che
        l'orario concede loro: mediarle direbbe sempre che l'orario è perfetto.
        {" "}Le tratte possono sovrapporsi — nelle giornate in cui una fermata
        intermedia non è stata rilevata si misura la tratta più lunga: sono
        misure indipendenti, non pezzi da sommare.
      </p>
    </div>
  );
}

/* ── Profilo dello scarto ───────────────────────────────────────────────────
 * Lo scarto accumulato a ogni fermata, nell'ordine del percorso. La linea
 * dello zero è l'orario: sopra è ritardo, sotto è anticipo. Serve a vedere in
 * un colpo d'occhio se il ritardo nasce in un punto e poi resta, oppure
 * cresce di continuo — due cose che la stessa somma finale non distingue. */
function ProfiloScarto({ fermate }: { fermate: FermataStorica[] }) {
  const viste = fermate.filter(f => f.scartoMedianoSec != null);
  if (viste.length < 2) return null;

  /* Alto abbastanza da far vedere la salita. A cinquanta pixel un ritardo che
   * quadruplica lungo il percorso appariva come una pendenza gentile: il
   * grafico c'era e il suo messaggio no. */
  const W = 100, H = 46, PAD = 4;
  const max = Math.max(60, ...viste.map(f => Math.abs(f.scartoMedianoSec!)));
  const x = (i: number) => PAD + (i / (viste.length - 1)) * (W - 2 * PAD);
  const y = (s: number) => H / 2 - (s / max) * (H / 2 - PAD);

  const d = viste.map((f, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(f.scartoMedianoSec!).toFixed(2)}`).join(" ");
  const primo = viste[0], ultimo = viste[viste.length - 1];

  return (
    <div className="px-3 py-2 rounded-lg bg-white/[0.03] border border-border/40">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
        <span>Scarto accumulato lungo il percorso (mediana)</span>
        <span className="font-mono">±{dur(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none">
        <line x1={PAD} y1={H / 2} x2={W - PAD} y2={H / 2} stroke="#94a3b8" strokeWidth="0.3" strokeDasharray="1.5 1.5" />
        <path d={d} fill="none" stroke="#fbbf24" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {viste.map((f, i) => (
          <circle key={f.stopId + f.seq} cx={x(i)} cy={y(f.scartoMedianoSec!)} r="0.9"
            fill={f.scartoMedianoSec! > 0 ? "#f87171" : "#34d399"}>
            <title>{`${f.stopName ?? f.stopId} · ${segnato(f.scartoMedianoSec)} su ${f.giorni} giornate`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex justify-between text-[9px] text-muted-foreground/70">
        <span className="truncate max-w-[45%]">{primo.stopName ?? primo.stopId} {segnato(primo.scartoMedianoSec)}</span>
        <span className="truncate max-w-[45%] text-right">{ultimo.stopName ?? ultimo.stopId} {segnato(ultimo.scartoMedianoSec)}</span>
      </div>
    </div>
  );
}
