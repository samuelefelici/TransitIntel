/**
 * I pezzi condivisi della console di Argos: pastiglie colorate per effetto,
 * stato e autonomia, i riquadri, i numeri del cruscotto, le barre. Il colore
 * non è mai l'unica informazione: ogni pastiglia porta anche la parola.
 */
import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  EFFETTI, NOMI_AUTONOMIA, NOMI_EFFETTO, NOMI_FASCIA, NOMI_STATO, SPIEGA_AUTONOMIA, SPIEGA_EFFETTO,
  type Autonomia, type Effetto, type Fascia, type StatoEsecuzione,
} from "@/lib/argos-console";

export type Tinta = "ok" | "avviso" | "errore" | "info" | "memoria" | "neutro";

export const TINTA_EFFETTO: Record<Effetto, Tinta> = {
  lettura: "info", esito: "ok", memoria: "memoria", scrittura: "avviso", distruttivo: "errore",
};
export const TINTA_STATO: Record<StatoEsecuzione, Tinta> = {
  running: "info", completed: "ok", failed: "errore", empty: "neutro",
};
export const TINTA_AUTONOMIA: Record<Autonomia, Tinta> = { osserva: "info", propone: "memoria", applica: "avviso" };

export function Pill({ tinta, children, title }: { tinta: Tinta; children: ReactNode; title?: string }) {
  return <span className="argos-pill" data-tinta={tinta} title={title}>{children}</span>;
}

export function PillEffetto({ effetto }: { effetto: Effetto }) {
  return <Pill tinta={TINTA_EFFETTO[effetto]} title={SPIEGA_EFFETTO[effetto]}>{NOMI_EFFETTO[effetto]}</Pill>;
}

export function PillStato({ stato }: { stato: StatoEsecuzione }) {
  return (
    <Pill tinta={TINTA_STATO[stato] ?? "neutro"}>
      {stato === "running" ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <span className="argos-punto" data-tinta={TINTA_STATO[stato] ?? "neutro"} aria-hidden />}
      {NOMI_STATO[stato] ?? stato}
    </Pill>
  );
}

export function PillAutonomia({ autonomia }: { autonomia: Autonomia }) {
  return <Pill tinta={TINTA_AUTONOMIA[autonomia]} title={SPIEGA_AUTONOMIA[autonomia]}>{NOMI_AUTONOMIA[autonomia]}</Pill>;
}

export function PillFascia({ fascia }: { fascia: Fascia }) {
  return <Pill tinta="neutro" title="La fascia di modello: l'agente sceglie la fascia, non il nome del modello">Modello {NOMI_FASCIA[fascia] ?? fascia}</Pill>;
}

export function Riquadro({ titolo, azione, children, className = "" }: { titolo?: ReactNode; azione?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-border bg-card text-card-foreground shadow-sm ${className}`}>
      {(titolo || azione) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          {titolo && <h2 className="text-sm font-semibold tracking-tight">{titolo}</h2>}
          {azione}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Numero({ etichetta, valore, nota, tinta }: { etichetta: string; valore: ReactNode; nota?: ReactNode; tinta?: Tinta }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm" data-tinta={tinta ?? "neutro"}>
      <div className="text-xs font-medium text-muted-foreground">{etichetta}</div>
      <div className={`mt-1 text-2xl font-display font-bold tracking-tight ${tinta ? "argos-tinta" : ""}`}>{valore}</div>
      {nota && <div className="mt-0.5 text-[11px] text-muted-foreground">{nota}</div>}
    </div>
  );
}

/** Una barra divisa per effetto, con la legenda. */
export function BarraEffetti({ perEffetto, legenda = true }: { perEffetto: Partial<Record<Effetto, number>>; legenda?: boolean }) {
  const totale = EFFETTI.reduce((s, e) => s + (perEffetto[e] ?? 0), 0);
  if (!totale) return <div className="text-xs text-muted-foreground">Nessuno strumento</div>;
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img"
        aria-label={EFFETTI.filter(e => perEffetto[e]).map(e => `${NOMI_EFFETTO[e]} ${perEffetto[e]}`).join(", ")}>
        {EFFETTI.filter(e => perEffetto[e]).map(e => (
          <div key={e} className="argos-barra h-full" data-tinta={TINTA_EFFETTO[e]} style={{ width: `${((perEffetto[e] ?? 0) / totale) * 100}%` }} />
        ))}
      </div>
      {legenda && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {EFFETTI.filter(e => perEffetto[e]).map(e => (
            <span key={e} className="inline-flex items-center gap-1" data-tinta={TINTA_EFFETTO[e]}>
              <span className="argos-punto" aria-hidden />{NOMI_EFFETTO[e]} <b className="text-foreground">{perEffetto[e]}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Un elenco di barre orizzontali (etichetta, valore), la più lunga in cima. */
export function Barre({ righe, tinta = "info", formato = String }: { righe: Array<{ etichetta: string; valore: number; nota?: string }>; tinta?: Tinta; formato?: (n: number) => string }) {
  const max = Math.max(1, ...righe.map(r => r.valore));
  return (
    <ul className="space-y-1.5">
      {righe.map(r => (
        <li key={r.etichetta} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-xs">
          <span className="truncate text-muted-foreground" title={r.etichetta}>{r.etichetta}</span>
          <span className="h-1.5 rounded-full bg-muted" data-tinta={tinta}>
            <span className="argos-barra block h-full rounded-full" style={{ width: `${(r.valore / max) * 100}%` }} />
          </span>
          <span className="tabular-nums font-medium">{formato(r.valore)}{r.nota ? <span className="ml-1 text-muted-foreground">{r.nota}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

export function Caricamento({ testo = "Carico…" }: { testo?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{testo}
    </div>
  );
}

export function Problema({ errore }: { errore: unknown }) {
  const msg = errore instanceof Error ? errore.message : String(errore ?? "errore");
  return (
    <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm" data-tinta="errore" role="alert"
      style={{ borderColor: "hsl(var(--tinta) / 0.35)", background: "hsl(var(--tinta) / 0.08)" }}>
      <AlertTriangle className="mt-0.5 h-4 w-4 argos-tinta" aria-hidden />
      <span>{msg}</span>
    </div>
  );
}

export function Vuoto({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}
