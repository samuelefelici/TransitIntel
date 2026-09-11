/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STATO DEL PARCO — quali apparati di bordo funzionano
 * ───────────────────────────────────────────────────────────────────────────
 * L'unica parte del flusso AVM che riguarda il MEZZO e non il servizio: su 368
 * vetture trasmesse, la gran parte riporta un errore di monitoraggio e alcune
 * un ultimo contatto di mesi prima. Finora quel dato serviva solo a scartare
 * le posizioni vecchie, e finiva lì.
 *
 * Le due cause NON si riparano allo stesso modo, e confonderle manda qualcuno
 * a cercare un'antenna quando il problema è la SIM: due reparti diversi, un
 * giro a vuoto. Per questo hanno etichette distinte e colori distinti, e il
 * testo nomina il pezzo da guardare invece del codice dell'AVM.
 *
 * L'ordine è per tempo di fermo, non alfabetico: è l'ordine in cui si apre
 * un'officina.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download, SignalHigh, SatelliteDish, Moon, BusFront, CircleOff, Wrench,
  ArrowDownRight, ArrowUpRight,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

export type StatoVettura =
  | "in_servizio" | "pronta" | "in_rimessa"
  | "senza_rete" | "senza_gps" | "muta";

export interface VetturaDiagnostica {
  vehicleRef: string;
  stato: StatoVettura;
  etaContattoSec: number | null;
  ultimoContatto: string | null;
  errore: string | null;
  progressStatus: string | null;
  linea: string | null;
  haPosizione: boolean;
}

export interface ParcoResp {
  configured: boolean;
  rilevatoAlle?: string;
  totale?: number;
  quotaUtilizzabile?: number;
  nota?: string;
  perStato?: Array<{ stato: StatoVettura; etichetta: string; conteggio: number }>;
  daVerificare?: VetturaDiagnostica[];
  tutte?: VetturaDiagnostica[];
  failed?: boolean;
  errorText?: string | null;
  error?: string;
}

const SEGNO: Record<StatoVettura, {
  icona: typeof BusFront; colore: string; fondo: string; officina: boolean;
}> = {
  in_servizio: { icona: BusFront,      colore: "#34d399", fondo: "rgba(52,211,153,0.12)", officina: false },
  pronta:      { icona: SatelliteDish, colore: "#7dd3fc", fondo: "rgba(125,211,252,0.10)", officina: false },
  in_rimessa:  { icona: Moon,          colore: "#94a3b8", fondo: "rgba(148,163,184,0.10)", officina: false },
  senza_rete:  { icona: SignalHigh,     colore: "#fbbf24", fondo: "rgba(251,191,36,0.12)",  officina: true },
  senza_gps:   { icona: CircleOff,     colore: "#fb923c", fondo: "rgba(251,146,60,0.12)",  officina: true },
  muta:        { icona: Wrench,        colore: "#f87171", fondo: "rgba(248,113,113,0.12)", officina: true },
};

/** "Ferma da 40 giorni" si capisce; "3456000 secondi" no. */
function fermoDa(sec: number | null): string {
  if (sec == null) return "mai vista";
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)} ore`;
  const g = Math.round(sec / 86400);
  if (g < 60) return `${g} giorni`;
  return `${Math.round(g / 30)} mesi`;
}

interface VetturaNelTempo {
  vehicleRef: string;
  stato: "persa" | "ripresa" | "stabile" | "saltuaria";
  primaMeta: number; secondaMeta: number;
  primoGiorno: string; ultimoGiorno: string; giorniDiSilenzio: number;
}
interface AndamentoResp {
  configured: boolean;
  days?: number;
  andamento?: {
    giornate: number; vetture: number;
    perse: VetturaNelTempo[]; riprese: VetturaNelTempo[];
    stabili: number; saltuarie: number; variazioneNette: number; nota: string;
  };
}

export default function StatoParco({
  dati, urlCsv,
}: { dati: ParcoResp | undefined; urlCsv: string }) {
  const [filtro, setFiltro] = useState<StatoVettura | null>(null);

  /* L'elenco qui sotto dice chi è guasto ORA. Questo dice che cosa è
     CAMBIATO — se le riparazioni funzionano, e quali mezzi hanno smesso di
     trasmettere di recente: quelli, ordinati per tempo di fermo, finivano in
     fondo dietro alle mute da mesi, ed erano i più facili da recuperare. */
  const andQ = useQuery({
    queryKey: ["parco-andamento", 30],
    queryFn: () => apiFetch<AndamentoResp>("/api/siri/parco/andamento?days=30"),
    staleTime: 10 * 60 * 1000,
  });
  const and = andQ.data?.andamento;

  const visibili = useMemo(
    () => (dati?.daVerificare ?? []).filter(v => !filtro || v.stato === filtro),
    [dati, filtro],
  );

  if (!dati) {
    return <div className="p-8 text-center text-xs text-muted-foreground">Interrogo l'AVM…</div>;
  }
  if (dati.error || dati.failed) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
        L'AVM non ha risposto: {dati.errorText ?? dati.error}
      </div>
    );
  }

  const daVerificare = dati.daVerificare ?? [];
  const quota = Math.round((dati.quotaUtilizzabile ?? 0) * 100);

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-4 py-2.5 border-b border-border/40 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11px] leading-snug text-muted-foreground max-w-xl">
          {dati.nota}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="text-[11px] font-mono text-muted-foreground">
            {quota}% del parco seguito
          </span>
          <a
            href={urlCsv}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-white/5 hover:bg-white/10 border border-border/60 transition-colors"
          >
            <Download className="w-3 h-3" /> CSV officina
          </a>
        </span>
      </div>

      {/* Che cosa è CAMBIATO. Sta sopra l'elenco dei guasti perché risponde a
          una domanda che l'elenco non può porre: se quello che l'officina sta
          facendo funziona. E perché una vettura che ha smesso ieri è più
          facile da recuperare di una muta da mesi, ma nell'elenco per tempo
          di fermo finisce dietro a tutte. */}
      {and && (and.perse.length > 0 || and.riprese.length > 0) && (
        <div className="px-4 py-2 border-b border-border/30 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {and.perse.length > 0 && (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-red-500/30 bg-red-500/10 text-red-300">
                <ArrowDownRight className="w-3 h-3" />
                {and.perse.length} hanno smesso di trasmettere
              </span>
            )}
            {and.riprese.length > 0 && (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                <ArrowUpRight className="w-3 h-3" />
                {and.riprese.length} hanno ripreso
              </span>
            )}
            {/* Il saldo, non solo le riparazioni: sei mezzi rimessi in strada
                mentre otto si rompono non sono un miglioramento. */}
            <span className="font-mono" style={{
              color: and.variazioneNette > 0 ? "#34d399"
                : and.variazioneNette < 0 ? "#f87171" : "#94a3b8",
            }}>
              saldo {and.variazioneNette > 0 ? "+" : ""}{and.variazioneNette}
            </span>
            <span className="text-muted-foreground">su {and.giornate} giorni</span>
            <a
              href="/api/siri/parco/andamento?days=30&formato=csv"
              className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] bg-white/5 hover:bg-white/10 border border-border/60 transition-colors">
              <Download className="w-3 h-3" /> CSV andamento
            </a>
          </div>

          {and.perse.length > 0 && (
            <div className="text-[10px] text-muted-foreground leading-relaxed">
              {/* Le più recenti per prime: sono quelle su cui l'officina ha
                  ancora una pista da seguire. */}
              Smesso di recente:{" "}
              {and.perse.slice(0, 8).map(v => (
                <span key={v.vehicleRef} className="font-mono text-red-300/90">
                  {v.vehicleRef}<span className="text-muted-foreground/60">({v.giorniDiSilenzio}g)</span>{" "}
                </span>
              ))}
              {and.perse.length > 8 && <span>e altre {and.perse.length - 8}</span>}
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/80 leading-relaxed">
            {and.nota} Una vettura può sparire anche perché è a riposo o in
            revisione: il dato dice che ha smesso di trasmettere, non che è
            guasta.
          </p>
        </div>
      )}

      {/* Il quadro completo: gli stati sani si contano, quelli da riparare si
          filtrano. Tenerli sulla stessa riga dice il rapporto fra i due. */}
      {dati.perStato && dati.perStato.length > 0 && (
        <div className="px-4 py-2 flex flex-wrap gap-1.5 border-b border-border/30">
          {dati.perStato.map(s => {
            const seg = SEGNO[s.stato];
            const Ico = seg.icona;
            const attivo = filtro === s.stato;
            return (
              <button
                key={s.stato}
                onClick={() => seg.officina && setFiltro(attivo ? null : s.stato)}
                disabled={!seg.officina}
                title={seg.officina ? s.etichetta : `${s.etichetta} — nessun intervento`}
                className={`px-2 py-1 rounded-lg text-[11px] border flex items-center gap-1.5 transition-colors ${
                  seg.officina ? "cursor-pointer" : "cursor-default opacity-70"
                }`}
                style={{
                  color: seg.colore,
                  backgroundColor: attivo ? seg.fondo : "transparent",
                  borderColor: attivo ? seg.colore + "66" : "transparent",
                }}
              >
                <Ico className="w-3 h-3" />
                <span className="font-mono font-semibold">{s.conteggio}</span>
                {s.etichetta}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 overflow-y-auto divide-y divide-border/30">
        {daVerificare.length === 0 && (
          <div className="p-8 text-center text-xs text-muted-foreground">
            Nessun apparato da verificare: tutte le vetture trasmesse comunicano
            e hanno una posizione valida.
          </div>
        )}

        {visibili.map(v => {
          const seg = SEGNO[v.stato];
          const Ico = seg.icona;
          return (
            <div key={v.vehicleRef} className="px-4 py-2 flex items-center gap-3">
              <span
                className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
                style={{ backgroundColor: seg.fondo, color: seg.colore }}
              >
                <Ico className="w-3.5 h-3.5" />
              </span>

              <span className="shrink-0 w-14 font-mono text-xs font-semibold">
                {v.vehicleRef}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block text-[11px]" style={{ color: seg.colore }}>
                  {v.stato === "muta" ? "Nessun segnale"
                    : v.stato === "senza_rete" ? "Non comunica — SIM o copertura"
                    : "Senza posizione — antenna GPS"}
                </span>
                <span className="block text-[10px] text-muted-foreground/80 truncate font-mono">
                  {v.progressStatus ?? "—"}
                  {v.linea ? ` · ${v.linea}` : ""}
                </span>
              </span>

              <span className="shrink-0 text-right">
                <span className="block text-[11px] font-mono font-semibold" style={{ color: seg.colore }}>
                  {fermoDa(v.etaContattoSec)}
                </span>
                <span className="block text-[10px] text-muted-foreground/70">
                  {v.haPosizione ? "ultima posizione nota" : "nessuna posizione"}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {dati.totale != null && (
        <div className="px-4 py-1.5 border-t border-border/40 text-[10px] text-muted-foreground">
          {dati.totale} vetture trasmesse · {daVerificare.length} da verificare
          {dati.rilevatoAlle && ` · rilevato ${new Date(dati.rilevatoAlle).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`}
        </div>
      )}
    </div>
  );
}
