/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DIARIO AVM — una settimana di osservazione, e la segnalazione già scritta
 * ───────────────────────────────────────────────────────────────────────────
 * Lo Stato del parco dice come sta il parco adesso. Su un'istantanea non si
 * scrive una segnalazione: chi la riceve risponde che quel giorno il mezzo era
 * in rimessa, e ha ragione. Questa pagina mostra invece che cosa ha fatto ogni
 * apparato giorno per giorno, e scende la catena dei quattro anelli —
 * contatto, attivazione al centro, posizione, corsa — fermandosi al primo
 * rotto: quello è il destinatario della segnalazione.
 *
 * Le tre parti, in quest'ordine, perché è l'ordine delle domande:
 *   1. l'andamento: sta migliorando? (una barra per giornata)
 *   2. le segnalazioni: a chi scrivo, e che cosa? (testo da copiare)
 *   3. l'elenco: quali vetture, coi numeri che reggono la segnalazione
 *
 * Il diario si riempie da solo mentre il connettore gira. Se non ci sono
 * ancora abbastanza giornate la pagina lo dice, invece di mostrare un elenco
 * che sembra definitivo: un verdetto dato su due giorni è un'istantanea
 * travestita, e brucia la credibilità della segnalazione successiva.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download, CalendarRange, Check, Copy, MapPin, Radio, Route, Wrench,
  AlertTriangle, TrendingUp, TrendingDown, Search,
} from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";

type Esito = "funziona" | "senza_corsa" | "senza_posizione" | "non_attivata" | "muta";
type EsitoGiorno = "in_servizio" | "traccia" | "collegata" | "muta";
type Destinatario = "Mizar" | "Officina" | "Esercizio" | "Gestore SIM" | "nessuno";

interface Vettura {
  vehicleRef: string;
  esito: Esito;
  destinatario: Destinatario;
  azione: string;
  nota: string;
  giornate: number;
  giorniConContatto: number;
  giorniMonitorata: number;
  giorniConPosizione: number;
  giorniConCorsa: number;
  giorniErroreGps: number;
  giorniErroreGprs: number;
  corse: number;
  linee: string[];
  ultimoContatto: string | null;
  giorniDiSilenzio: number;
  intermittente: boolean;
  perGiorno: Array<{ giorno: string; esito: EsitoGiorno }>;
}

interface Resp {
  configured: boolean;
  giorni: number;
  periodo: { da: string; a: string };
  maturo: boolean;
  giornateOsservate: number;
  giornateMinime: number;
  erroreRaccolta: string | null;
  nota: string;
  giornateSenzaDati: string[];
  vetture: Vettura[];
  perGiorno: Array<{
    giorno: string; inServizio: number; traccia: number; collegata: number;
    muta: number; monitorate: number; vetture: number;
  }>;
  riepilogo: {
    totale: number; funzionanti: number; daSegnalare: number;
    perEsito: Array<{ esito: Esito; conteggio: number }>;
    perDestinatario: Array<{ destinatario: Destinatario; conteggio: number }>;
  };
  cambiamenti: {
    migliorate: Array<{ vehicleRef: string; da: EsitoGiorno; a: EsitoGiorno }>;
    peggiorate: Array<{ vehicleRef: string; da: EsitoGiorno; a: EsitoGiorno }>;
  };
  testoSegnalazioni: Array<{ destinatario: string; oggetto: string; testo: string; matricole: number }>;
  error?: string;
}

/* Un colore per anello, non uno per gravità: il colore dice DOVE si è rotta
   la catena, ed è l'informazione che serve per smistare il lavoro. */
const ESITI: Record<Esito, { etichetta: string; breve: string; colore: string; fondo: string; icona: React.ElementType }> = {
  funziona:        { etichetta: "Funziona: ha fatto corse", breve: "Funziona", colore: "#34d399", fondo: "rgba(52,211,153,0.12)", icona: Check },
  senza_corsa:     { etichetta: "Si localizza ma non aggancia la corsa", breve: "Senza corsa", colore: "#7dd3fc", fondo: "rgba(125,211,252,0.12)", icona: Route },
  senza_posizione: { etichetta: "Seguita dal centro ma senza posizione", breve: "Senza posizione", colore: "#fb923c", fondo: "rgba(251,146,60,0.12)", icona: MapPin },
  non_attivata:    { etichetta: "Parla col centro ma non è attivata", breve: "Non attivata", colore: "#c084fc", fondo: "rgba(192,132,252,0.12)", icona: Radio },
  muta:            { etichetta: "Nessun contatto nel periodo", breve: "Muta", colore: "#f87171", fondo: "rgba(248,113,113,0.12)", icona: Wrench },
};

const GIORNI: Record<EsitoGiorno, { colore: string; testo: string }> = {
  in_servizio: { colore: "#34d399", testo: "in servizio" },
  traccia:     { colore: "#7dd3fc", testo: "si localizza" },
  collegata:   { colore: "#fbbf24", testo: "collegata, senza posizione" },
  muta:        { colore: "#3f3f46", testo: "nessun contatto" },
};

const DESTINATARI: Record<Destinatario, string> = {
  Mizar: "#c084fc", Officina: "#fb923c", Esercizio: "#7dd3fc",
  "Gestore SIM": "#f87171", nessuno: "#34d399",
};

function giornoBreve(g: string): string {
  const [, m, d] = g.split("-");
  return `${d}/${m}`;
}

export default function DiarioAvm() {
  const [giorni, setGiorni] = useState(7);
  const [filtro, setFiltro] = useState<Esito | null>(null);
  const [cerca, setCerca] = useState("");
  const [copiato, setCopiato] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["diario-avm", giorni],
    queryFn: () => apiFetch<Resp>(`/api/siri/parco/settimana?giorni=${giorni}`),
    staleTime: 5 * 60 * 1000,
  });
  const d = q.data;

  const visibili = useMemo(() => {
    const term = cerca.trim().toLowerCase();
    return (d?.vetture ?? []).filter(v =>
      (!filtro || v.esito === filtro)
      && (!term || v.vehicleRef.toLowerCase().includes(term)
        || v.linee.some(l => l.toLowerCase().includes(term))));
  }, [d, filtro, cerca]);

  async function copia(testo: string, chiave: string) {
    try {
      await navigator.clipboard.writeText(testo);
      setCopiato(chiave);
      setTimeout(() => setCopiato(c => (c === chiave ? null : c)), 2000);
    } catch {
      /* Senza permessi sugli appunti resta la selezione a mano: il testo è
         comunque visibile, ed è quello che serve. */
      setCopiato(null);
    }
  }

  if (q.isLoading) {
    return <div className="p-12 text-center text-xs text-muted-foreground">Leggo il diario…</div>;
  }
  if (q.error || d?.error) {
    return (
      <div className="p-12 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
        Il diario non si è potuto leggere: {d?.error ?? (q.error as Error)?.message}
      </div>
    );
  }
  if (!d) return null;

  const maxGiorno = Math.max(1, ...d.perGiorno.map(g => g.vetture));

  return (
    <div className="space-y-5">
      {/* ── Testata: periodo e stato della raccolta ─────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <CalendarRange className="w-3.5 h-3.5" />
          {d.periodo.da.split("-").reverse().join("/")} → {d.periodo.a.split("-").reverse().join("/")}
          <span className="font-mono">· {d.giornateOsservate} giornate raccolte</span>
        </div>
        <div className="flex items-center gap-1">
          {[7, 14, 30].map(n => (
            <button
              key={n}
              onClick={() => setGiorni(n)}
              className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
                giorni === n
                  ? "bg-white/10 border-border text-foreground"
                  : "bg-white/[0.02] border-border/40 text-muted-foreground hover:bg-white/5"}`}
            >
              {n} giorni
            </button>
          ))}
        </div>
        <a
          href={`${getApiBase()}/api/siri/parco/settimana?giorni=${giorni}&formato=csv`}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 border border-border/60 transition-colors"
        >
          <Download className="w-3 h-3" /> Foglio da allegare
        </a>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground max-w-3xl">{d.nota}</p>

      {d.erroreRaccolta && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-[11px] text-red-200 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>La raccolta del diario ha un problema e le giornate potrebbero
            essere incomplete: {d.erroreRaccolta}</span>
        </div>
      )}

      {!d.maturo && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200 leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Servono almeno {d.giornateMinime} giornate prima di mandare una
            segnalazione: con meno si sta guardando un'istantanea con più
            passaggi, e chi la riceve lo vedrà subito. Le voci qui sotto sono
            già calcolate, ma vanno lette come una prova, non come un verdetto.
          </span>
        </div>
      )}

      {/* ── 1. L'andamento: sta migliorando? ────────────────────────────── */}
      {d.perGiorno.length > 0 && (
        <section className="rounded-xl border border-border/50 bg-white/[0.02] p-4 space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-[12px] font-medium">Giorno per giorno</h3>
            <span className="text-[10px] text-muted-foreground">
              ogni colonna è una giornata: in basso chi ha fatto corse, in alto chi non ha parlato
            </span>
          </div>

          <div className="flex items-end gap-1 h-28">
            {d.perGiorno.map(g => (
              <div key={g.giorno} className="flex-1 flex flex-col justify-end min-w-0" title={
                `${giornoBreve(g.giorno)} — in servizio ${g.inServizio}, si localizzano ${g.traccia}, `
                + `collegate ${g.collegata}, mute ${g.muta}`}>
                {([["muta", g.muta], ["collegata", g.collegata], ["traccia", g.traccia],
                  ["in_servizio", g.inServizio]] as Array<[EsitoGiorno, number]>).map(([e, n]) => (
                  n > 0 ? (
                    <div key={e} style={{
                      height: `${(n / maxGiorno) * 100}%`,
                      background: GIORNI[e].colore,
                      opacity: e === "muta" ? 0.5 : 0.85,
                    }} />
                  ) : null
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {d.perGiorno.map(g => (
              <span key={g.giorno} className="flex-1 text-center text-[9px] font-mono text-muted-foreground min-w-0 truncate">
                {giornoBreve(g.giorno)}
              </span>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1 text-[10px] text-muted-foreground">
            {(Object.keys(GIORNI) as EsitoGiorno[]).map(e => (
              <span key={e} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: GIORNI[e].colore }} />
                {GIORNI[e].testo}
              </span>
            ))}
          </div>

          {(d.cambiamenti.migliorate.length > 0 || d.cambiamenti.peggiorate.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px]">
              {d.cambiamenti.migliorate.length > 0 && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                  <TrendingUp className="w-3 h-3" />
                  {d.cambiamenti.migliorate.length} migliorate:{" "}
                  <span className="font-mono">
                    {d.cambiamenti.migliorate.slice(0, 10).map(x => x.vehicleRef).join(", ")}
                    {d.cambiamenti.migliorate.length > 10 && " …"}
                  </span>
                </span>
              )}
              {d.cambiamenti.peggiorate.length > 0 && (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300">
                  <TrendingDown className="w-3 h-3" />
                  {d.cambiamenti.peggiorate.length} peggiorate:{" "}
                  <span className="font-mono">
                    {d.cambiamenti.peggiorate.slice(0, 10).map(x => x.vehicleRef).join(", ")}
                    {d.cambiamenti.peggiorate.length > 10 && " …"}
                  </span>
                </span>
              )}
            </div>
          )}

          {d.giornateSenzaDati.length > 0 && (
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Giornate senza dati (connettore fermo, non vetture mute):{" "}
              <span className="font-mono">{d.giornateSenzaDati.map(giornoBreve).join(", ")}</span>.
              Non entrano nei conti.
            </p>
          )}
        </section>
      )}

      {/* ── 2. Le segnalazioni: a chi scrivo, e che cosa ────────────────── */}
      {d.testoSegnalazioni.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[12px] font-medium">Segnalazioni da mandare</h3>
            <span className="text-[10px] text-muted-foreground">
              una per destinatario, col foglio allegato
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {d.testoSegnalazioni.map(s => (
              <div key={s.destinatario + s.oggetto}
                className="rounded-xl border border-border/50 bg-white/[0.02] p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium"
                    style={{
                      color: DESTINATARI[s.destinatario as Destinatario] ?? "#94a3b8",
                      background: `${DESTINATARI[s.destinatario as Destinatario] ?? "#94a3b8"}1f`,
                    }}>
                    {s.destinatario}
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    {s.matricole} vetture
                  </span>
                  <button
                    onClick={() => copia(`${s.oggetto}\n\n${s.testo}`, s.oggetto)}
                    className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] bg-white/5 hover:bg-white/10 border border-border/60 transition-colors"
                  >
                    {copiato === s.oggetto
                      ? <><Check className="w-3 h-3" /> copiato</>
                      : <><Copy className="w-3 h-3" /> copia</>}
                  </button>
                </div>
                <p className="text-[11px] font-medium leading-snug">{s.oggetto}</p>
                <p className="text-[10px] text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {s.testo}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 3. L'elenco, filtrabile per voce ────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setFiltro(null)}
            className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
              filtro === null ? "bg-white/10 border-border" : "bg-white/[0.02] border-border/40 text-muted-foreground hover:bg-white/5"}`}
          >
            tutte <span className="font-mono">{d.riepilogo.totale}</span>
          </button>
          {d.riepilogo.perEsito.map(({ esito, conteggio }) => {
            const cfg = ESITI[esito];
            const Icona = cfg.icona;
            return (
              <button
                key={esito}
                onClick={() => setFiltro(f => (f === esito ? null : esito))}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] border transition-colors"
                style={{
                  color: cfg.colore,
                  background: filtro === esito ? cfg.fondo : "rgba(255,255,255,0.02)",
                  borderColor: filtro === esito ? cfg.colore : "rgba(255,255,255,0.08)",
                }}
              >
                <Icona className="w-3 h-3" /> {cfg.breve} <span className="font-mono">{conteggio}</span>
              </button>
            );
          })}
          <div className="ml-auto relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={cerca}
              onChange={e => setCerca(e.target.value)}
              placeholder="matricola o linea"
              className="pl-7 pr-2 py-1 w-44 rounded-lg text-[11px] bg-white/[0.03] border border-border/40 focus:border-border outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-border/50">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border/40">
                <th className="px-3 py-2 font-medium">Vettura</th>
                <th className="px-3 py-2 font-medium">Andamento</th>
                <th className="px-3 py-2 font-medium">Esito</th>
                <th className="px-3 py-2 font-medium text-right">Contatto</th>
                <th className="px-3 py-2 font-medium text-right">Centro</th>
                <th className="px-3 py-2 font-medium text-right">Posizione</th>
                <th className="px-3 py-2 font-medium text-right">Corse</th>
                <th className="px-3 py-2 font-medium">Destinatario</th>
              </tr>
            </thead>
            <tbody>
              {visibili.map(v => {
                const cfg = ESITI[v.esito];
                return (
                  <tr key={v.vehicleRef} className="border-b border-border/20 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-3 py-1.5 font-mono whitespace-nowrap">
                      {v.vehicleRef}
                      {v.intermittente && (
                        <span className="ml-1.5 text-[9px] text-amber-400" title="parla a sprazzi">⌁</span>
                      )}
                    </td>
                    {/* La riga di stato: sette quadratini, uno per giornata.
                        Si legge prima della tabella, ed è quello che mostra a
                        colpo d'occhio se l'attivazione ha funzionato. */}
                    <td className="px-3 py-1.5">
                      <span className="flex gap-0.5">
                        {v.perGiorno.map(g => (
                          <span
                            key={g.giorno}
                            title={`${giornoBreve(g.giorno)}: ${GIORNI[g.esito].testo}`}
                            className="w-2.5 h-4 rounded-[2px]"
                            style={{ background: GIORNI[g.esito].colore, opacity: g.esito === "muta" ? 0.45 : 0.9 }}
                          />
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: cfg.colore }} title={v.nota}>
                      {cfg.breve}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {v.giorniConContatto}/{v.giornate}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {v.giorniMonitorata}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {v.giorniConPosizione}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {v.corse || "—"}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {v.destinatario === "nessuno"
                        ? <span className="text-muted-foreground">—</span>
                        : <span style={{ color: DESTINATARI[v.destinatario] }}>{v.destinatario}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visibili.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] text-muted-foreground">
              {d.vetture.length === 0
                ? "Il diario non ha ancora registrato nessuna giornata: si riempie da solo a ogni giro del connettore."
                : "Nessuna vettura con questi criteri."}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
