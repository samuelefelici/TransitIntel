/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUANTO VEDIAMO — la riga che qualifica tutte le altre
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni numero di questa pagina è calcolato sulle corse che siamo riusciti a
 * seguire. Se sono una su dieci, quella non è la puntualità dell'azienda: è
 * quella di un campione che nessuno ha scelto, e che nessuno sa se somigli al
 * resto. Finora quel dato non era scritto da nessuna parte, e i numeri
 * sembravano parlare di tutto il servizio.
 *
 * Sta in una riga sola e chiusa, non in un pannello: non è ciò che si viene a
 * cercare qui, ma è ciò che bisogna sapere prima di credere al resto. Chi
 * vuole il dettaglio — l'andamento giorno per giorno e la tabella degli
 * intervalli da portare al fornitore — la apre.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, Eye, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { apiFetch } from "@/lib/api";

type Andamento = "in_miglioramento" | "stabile" | "in_peggioramento" | "indeterminato";

interface Giornata {
  day: string;
  vetture: number;
  vettureConPosizione: number;
  corseProgrammate: number | null;
  corseConTransito: number;
  transiti: number;
  fermateProgrammate: number;
  passoLettureSec: number | null;
  quotaCorse: number | null;
  quotaFermate: number | null;
}

interface Capacita {
  intervalloSec: number; passoMetri: number; quotaMinima: number; cosaComporta: string;
}

interface Risposta {
  caronteAvailable: boolean;
  days?: number;
  intervalloConfiguratoSec?: number | null;
  quadro: {
    giorni: Giornata[];
    quotaCorseMediana: number | null;
    quotaFermateMediana: number | null;
    passoLettureMedianoSec: number | null;
    andamento: Andamento;
    capacitaAttuale: Capacita | null;
    margineDaSoste: number | null;
    nota: string;
  } | null;
  scalaIntervalli?: Capacita[];
}

const TENDENZA: Record<Andamento, { icona: typeof Minus; colore: string; testo: string }> = {
  in_miglioramento: { icona: TrendingUp,   colore: "#34d399", testo: "in miglioramento" },
  stabile:          { icona: Minus,        colore: "#94a3b8", testo: "stabile" },
  in_peggioramento: { icona: TrendingDown, colore: "#f87171", testo: "in peggioramento" },
  indeterminato:    { icona: Minus,        colore: "#64748b", testo: "troppo poche giornate per dire" },
};

const pct = (v: number | null | undefined) => v == null ? "—" : `${Math.round(v * 100)}%`;

/** "02 set". Una data non valida non deve stampare "Invalid Date" in pagina. */
function data(day: string): string {
  const d = new Date(day);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
}

export default function CoperturaBanner({ days }: { days: number }) {
  const [aperto, setAperto] = useState(false);

  const q = useQuery({
    queryKey: ["copertura", days],
    queryFn: () => apiFetch<Risposta>(`/api/operations/copertura?days=${days}`),
  });

  const d = q.data;
  const qd = d?.quadro;
  if (!qd || qd.giorni.length === 0) return null;

  const t = TENDENZA[qd.andamento];
  const Tico = t.icona;
  /* Sotto un quarto delle corse, il campione non è un dettaglio tecnico: è la
     ragione per cui un numero di questa pagina può essere molto diverso dalla
     realtà dell'azienda. Il colore lo dice prima del testo. */
  const scarso = (qd.quotaCorseMediana ?? 0) < 0.25;

  return (
    <div className={`rounded-lg border text-[11px] ${
      scarso ? "bg-amber-500/10 border-amber-500/30" : "bg-white/5 border-border/50"
    }`}>
      <button
        onClick={() => setAperto(v => !v)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left">
        {aperto ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <Eye className="w-3.5 h-3.5 shrink-0" style={{ color: scarso ? "#fbbf24" : "#94a3b8" }} />
        <span className={scarso ? "text-amber-200/90" : "text-muted-foreground"}>
          Questi numeri sono calcolati sul{" "}
          <strong className="font-semibold">{pct(qd.quotaCorseMediana)} delle corse programmate</strong>
          {qd.quotaFermateMediana != null && (
            <> e sul {pct(qd.quotaFermateMediana)} delle loro fermate</>
          )}.
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0" style={{ color: t.colore }}>
          <Tico className="w-3 h-3" /> {t.testo}
        </span>
      </button>

      {aperto && (
        <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border/30">
          <p className="leading-relaxed text-muted-foreground">{qd.nota}</p>

          {/* L'andamento nel tempo: dice se l'aggancio sta migliorando, che è
              la domanda dopo aver visto la quota. */}
          <Andamento giorni={qd.giorni} />

          {/* La tabella da portare al fornitore. Non "vorremmo un refresh più
              frequente", ma che cosa cambia a ciascun intervallo. */}
          {d?.scalaIntervalli && d.scalaIntervalli.length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1">
                Cosa si riesce a riconoscere, al variare dell'intervallo fra due letture
                {qd.passoLettureMedianoSec != null && (
                  <> — oggi il flusso ci arriva ogni <strong>{qd.passoLettureMedianoSec} s</strong></>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[10px] font-mono">
                  <thead className="text-muted-foreground/70">
                    <tr className="text-left">
                      <th className="py-1 pr-3 font-normal">intervallo</th>
                      <th className="py-1 pr-3 font-normal">metri fra due letture</th>
                      <th className="py-1 pr-3 font-normal">passaggi riconoscibili senza sosta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.scalaIntervalli.map(c => {
                      const attuale = qd.capacitaAttuale?.intervalloSec === c.intervalloSec;
                      return (
                        <tr key={c.intervalloSec}
                          className={attuale ? "text-amber-300" : "text-muted-foreground"}>
                          <td className="py-0.5 pr-3">{c.intervalloSec} s{attuale ? " ← oggi" : ""}</td>
                          <td className="py-0.5 pr-3">{c.passoMetri} m</td>
                          <td className="py-0.5 pr-3">{pct(c.quotaMinima)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground/70 leading-relaxed">
                È un limite inferiore: vale per un mezzo che passa <em>senza fermarsi</em>.
                Quando si ferma davvero la finestra si allunga di tutta la sosta e il
                passaggio diventa quasi certo — ed è per questo che la copertura
                osservata può essere più alta di questa colonna.
              </p>
            </div>
          )}

          <a
            href={`/api/operations/copertura?days=${days}&formato=csv`}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-border/60 transition-colors">
            <Download className="w-3 h-3" /> CSV giorno per giorno
          </a>
        </div>
      )}
    </div>
  );
}

/* Una barra per giornata, alta quanto la quota di corse viste. Non serve un
 * asse: serve vedere se la fila è piatta, se sale, o se ha buchi — e i buchi
 * sono giornate in cui non abbiamo visto niente, che una media nasconde. */
function Andamento({ giorni }: { giorni: Giornata[] }) {
  const max = Math.max(0.01, ...giorni.map(g => g.quotaCorse ?? 0));
  return (
    <div>
      <div className="flex items-end gap-px h-10">
        {giorni.map(g => {
          const q = g.quotaCorse;
          return (
            <span
              key={g.day}
              title={`${new Date(g.day).toLocaleDateString("it-IT")} · ${
                q == null ? "corse programmate sconosciute" : `${Math.round(q * 100)}% delle corse`
              } · ${g.transiti} passaggi`}
              className="flex-1 min-w-[2px] rounded-t-sm"
              style={{
                /* Una giornata senza denominatore NON va disegnata alta: in un
                   grafico di copertura l'altezza è la copertura, e una colonna
                   grigia a piena altezza si legge come una giornata ottima.
                   Resta un trattino a terra — "qui non c'è un numero" — grigio
                   invece che azzurro, perché "nessuna corsa vista" e "non si sa
                   quante ne circolavano" sono fatti diversi: il primo è il
                   connettore fermo, il secondo è il calendario che manca. */
                height: q == null ? "3px" : `${Math.max(3, (q / max) * 100)}%`,
                background: q == null ? "#64748b" : "#38bdf8",
              }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-[9px] text-muted-foreground/70 mt-0.5">
        <span>{data(giorni[0].day)}</span>
        {/* Senza questa riga un trattino grigio e uno azzurro basso si
            somigliano, e sono due diagnosi diverse. */}
        <span className="mx-auto flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="w-2 h-0.5" style={{ background: "#38bdf8" }} /> corse viste
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-0.5" style={{ background: "#64748b" }} /> quante ne circolavano non è noto
          </span>
        </span>
        <span>{data(giorni[giorni.length - 1].day)}</span>
      </div>
    </div>
  );
}
