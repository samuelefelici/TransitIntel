/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PALINE MIZAR — gli abbinamenti fra il codice dell'AVM e la fermata del feed
 * ───────────────────────────────────────────────────────────────────────────
 * Le fermate hanno due numerazioni che si sovrappongono: la 200 di Mizar è
 * Piazza Cavour, la 200 del feed è Via del Conero. La tabella di
 * transcodifica dell'azienda le mette in corrispondenza; questa pagina la
 * mostra riga per riga con il suo stato, perché chi la tiene possa
 * correggerla, e con le due liste che la tabella da sola non dice: le
 * fermate del feed che nessun codice raggiunge, e i codici che il flusso
 * SIRI usa e la tabella non ha.
 *
 * Gli stati sono pochi e distinti, con un colore ciascuno: «sospetta» non
 * è una sfumatura di «abbinata», è un abbinamento da guardare prima di
 * fidarsi.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Search, MapPin, AlertTriangle, CircleOff, HelpCircle, Check } from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";

type Stato = "abbinata" | "sospetta" | "fermata_assente" | "senza_codice";

interface Riga {
  mizarRef: string; stopId: string | null; nomeMizar: string | null; nomeFeed: string | null;
  stato: Stato; collisione: string | null; condivisaCon: number; vistaNelFlusso: boolean;
}
interface Resp {
  file: string | null; errore: string | null; feed: string | null;
  ultimoGiro: { alle: string; nonAgganciate: string[]; conflitti: string[]; agganciate: number; perId: number; perNome: number } | null;
  righe: Riga[];
  feedSenzaCodice: Array<{ stopId: string; nome: string | null }>;
  flussoNonTrascodificato: string[];
  riepilogo: {
    paline: number; abbinate: number; sospette: number; fermateAssenti: number; senzaCodice: number;
    collisioni: number; feedSenzaCodice: number; flussoNonTrascodificato: number;
  };
  lettura: string[];
  nota?: string;
}

type Filtro = Stato | "collisione" | "feed_senza_codice" | "flusso" | null;

const SEGNO: Record<Stato, { etichetta: string; icona: typeof Check; colore: string; fondo: string; spiegazione: string }> = {
  abbinata:        { etichetta: "Abbinata",        icona: Check,         colore: "#34d399", fondo: "rgba(52,211,153,0.12)",  spiegazione: "la fermata esiste nel feed e il nome combacia" },
  sospetta:        { etichetta: "Sospetta",        icona: AlertTriangle, colore: "#fbbf24", fondo: "rgba(251,191,36,0.12)",  spiegazione: "la fermata esiste nel feed, ma con un altro nome: da controllare" },
  fermata_assente: { etichetta: "Fermata assente", icona: CircleOff,     colore: "#f87171", fondo: "rgba(248,113,113,0.12)", spiegazione: "lo stop_id della tabella non esiste nel feed in uso" },
  senza_codice:    { etichetta: "Senza codice",    icona: HelpCircle,    colore: "#94a3b8", fondo: "rgba(148,163,184,0.12)", spiegazione: "palina di Mizar non ancora codificata nel software aziendale" },
};

function Contatore({ n, etichetta, colore, fondo, attivo, onClick, icona: Icona }: {
  n: number; etichetta: string; colore: string; fondo: string; attivo: boolean; onClick: () => void; icona?: typeof Check;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${attivo ? "border-foreground/40" : "border-border/40 hover:border-border"}`}
      style={{ background: fondo }}
      title={etichetta}
    >
      {Icona && <Icona className="w-3.5 h-3.5 shrink-0" style={{ color: colore }} />}
      <span className="font-mono text-base font-semibold tabular-nums" style={{ color: colore }}>{n}</span>
      <span className="text-[11px] text-muted-foreground">{etichetta}</span>
    </button>
  );
}

export default function FermateMizar() {
  const [filtro, setFiltro] = useState<Filtro>(null);
  const [cerca, setCerca] = useState("");

  const q = useQuery({
    queryKey: ["fermate-abbinamenti"],
    queryFn: () => apiFetch<Resp>("/api/siri/fermate/abbinamenti"),
    staleTime: 5 * 60 * 1000,
  });
  const d = q.data;

  const righe = useMemo(() => {
    if (!d) return [];
    const t = cerca.trim().toUpperCase();
    const trova = (r: Riga) => !t
      || r.mizarRef.toUpperCase().includes(t) || (r.stopId ?? "").toUpperCase().includes(t)
      || (r.nomeMizar ?? "").toUpperCase().includes(t) || (r.nomeFeed ?? "").toUpperCase().includes(t);
    let base = d.righe;
    if (filtro === "collisione") base = base.filter(r => r.collisione);
    else if (filtro === "flusso") base = base.filter(r => r.vistaNelFlusso);
    else if (filtro && filtro !== "feed_senza_codice") base = base.filter(r => r.stato === filtro);
    /* Prima ciò che va guardato: sospette, assenti, senza codice; le
       abbinate in fondo, in ordine di codice. */
    const peso: Record<Stato, number> = { sospetta: 0, fermata_assente: 1, senza_codice: 2, abbinata: 3 };
    return base.filter(trova).sort((a, b) => peso[a.stato] - peso[b.stato] || a.mizarRef.localeCompare(b.mizarRef, undefined, { numeric: true }));
  }, [d, filtro, cerca]);

  const feedSenza = useMemo(() => {
    if (!d) return [];
    const t = cerca.trim().toUpperCase();
    return d.feedSenzaCodice.filter(f => !t || f.stopId.toUpperCase().includes(t) || (f.nome ?? "").toUpperCase().includes(t));
  }, [d, cerca]);

  if (q.isError) {
    return <div className="p-8 text-center text-xs text-muted-foreground">Non riesco a leggere gli abbinamenti: {String((q.error as any)?.message ?? q.error)}</div>;
  }
  if (!d) return <div className="p-8 text-center text-xs text-muted-foreground">Leggo la tabella di transcodifica…</div>;
  if (d.errore && !d.righe.length) {
    return (
      <div className="p-8 text-center text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
        Nessuna tabella di transcodifica caricata: {d.errore}
      </div>
    );
  }

  const r = d.riepilogo;
  const MOSTRA = 400;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-primary" />
            <span className="text-sm font-semibold">Paline Mizar ↔ fermate del feed</span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 max-w-2xl leading-relaxed">
            {d.lettura.join(" ")}
          </p>
          {d.ultimoGiro && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Ultimo giro SIRI alle {new Date(d.ultimoGiro.alle).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}:
              {" "}{d.ultimoGiro.agganciate} fermate agganciate ({d.ultimoGiro.perId} per codice, {d.ultimoGiro.perNome} per nome),
              {" "}{d.ultimoGiro.nonAgganciate.length} non agganciate.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => q.refetch()} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-[11px] hover:bg-muted/40" title="Rileggi">
            <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? "animate-spin" : ""}`} /> Aggiorna
          </button>
          <a href={`${getApiBase()}/api/siri/fermate/abbinamenti?formato=csv`} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-[11px] hover:bg-muted/40" title="Scarica tutto in CSV">
            <Download className="w-3.5 h-3.5" /> CSV
          </a>
        </div>
      </div>

      {/* I contatori sono anche i filtri: si clicca quello che si vuole vedere. */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(SEGNO) as Stato[]).map(s => (
          <Contatore key={s} n={s === "abbinata" ? r.abbinate : s === "sospetta" ? r.sospette : s === "fermata_assente" ? r.fermateAssenti : r.senzaCodice}
            etichetta={SEGNO[s].etichetta} colore={SEGNO[s].colore} fondo={SEGNO[s].fondo} icona={SEGNO[s].icona}
            attivo={filtro === s} onClick={() => setFiltro(filtro === s ? null : s)} />
        ))}
        <Contatore n={r.collisioni} etichetta="con numero omonimo nel feed" colore="#c084fc" fondo="rgba(192,132,252,0.12)"
          attivo={filtro === "collisione"} onClick={() => setFiltro(filtro === "collisione" ? null : "collisione")} />
        <Contatore n={r.feedSenzaCodice} etichetta="fermate del feed senza codice" colore="#fb923c" fondo="rgba(251,146,60,0.12)"
          attivo={filtro === "feed_senza_codice"} onClick={() => setFiltro(filtro === "feed_senza_codice" ? null : "feed_senza_codice")} />
        {d.ultimoGiro && (
          <Contatore n={r.flussoNonTrascodificato} etichetta="viste nel flusso, non in tabella" colore="#f87171" fondo="rgba(248,113,113,0.12)"
            attivo={filtro === "flusso"} onClick={() => setFiltro(filtro === "flusso" ? null : "flusso")} />
        )}
      </div>

      <div className="relative max-w-sm">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-muted-foreground" />
        <input
          id="cerca-palina"
          value={cerca}
          onChange={e => setCerca(e.target.value)}
          placeholder="Codice Mizar, stop_id o nome…"
          className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-border/50 bg-background text-xs"
        />
      </div>

      {filtro === "flusso" && d.flussoNonTrascodificato.length > 0 && (
        <div className="rounded-lg border border-border/40 p-3 text-[11px]">
          <div className="font-medium mb-1">Codici usati dal flusso SIRI nell'ultimo giro che la tabella non conosce</div>
          <div className="font-mono text-muted-foreground break-words">{d.flussoNonTrascodificato.join("  ")}</div>
        </div>
      )}

      {filtro === "feed_senza_codice" ? (
        <div className="rounded-lg border border-border/40 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-left text-muted-foreground border-b border-border/40">
              <tr><th className="px-2 py-1.5 font-medium">stop_id feed</th><th className="px-2 py-1.5 font-medium">Nome nel feed</th></tr>
            </thead>
            <tbody>
              {feedSenza.slice(0, MOSTRA).map(f => (
                <tr key={f.stopId} className="border-b border-border/20">
                  <td className="px-2 py-1 font-mono">{f.stopId}</td>
                  <td className="px-2 py-1">{f.nome ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {feedSenza.length > MOSTRA && <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Mostrate {MOSTRA} su {feedSenza.length}: restringi con la ricerca o scarica il CSV.</div>}
          {feedSenza.length === 0 && <div className="px-2 py-3 text-[11px] text-muted-foreground">Nessuna fermata del feed senza codice.</div>}
        </div>
      ) : (
        <div className="rounded-lg border border-border/40 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="text-left text-muted-foreground border-b border-border/40">
              <tr>
                <th className="px-2 py-1.5 font-medium">Stato</th>
                <th className="px-2 py-1.5 font-medium">Codice Mizar</th>
                <th className="px-2 py-1.5 font-medium">Nome per Mizar</th>
                <th className="px-2 py-1.5 font-medium">stop_id feed</th>
                <th className="px-2 py-1.5 font-medium">Nome nel feed</th>
                <th className="px-2 py-1.5 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {righe.slice(0, MOSTRA).map(x => {
                const s = SEGNO[x.stato];
                const Icona = s.icona;
                return (
                  <tr key={`${x.mizarRef}|${x.stopId ?? ""}`} className="border-b border-border/20 align-top">
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: s.fondo, color: s.colore }} title={s.spiegazione}>
                        <Icona className="w-3 h-3" /> {s.etichetta}
                      </span>
                    </td>
                    <td className="px-2 py-1 font-mono">{x.mizarRef}</td>
                    <td className="px-2 py-1">{x.nomeMizar ?? "—"}</td>
                    <td className="px-2 py-1 font-mono">{x.stopId ?? "—"}</td>
                    <td className="px-2 py-1">{x.nomeFeed ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {[
                        x.collisione ? `nel feed lo stop_id ${x.collisione}` : null,
                        x.condivisaCon > 0 ? `stessa fermata di altre ${x.condivisaCon} paline` : null,
                        x.vistaNelFlusso ? "vista nel flusso SIRI" : null,
                      ].filter(Boolean).join(" · ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {righe.length > MOSTRA && <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Mostrate {MOSTRA} su {righe.length}: restringi con la ricerca o i filtri, o scarica il CSV.</div>}
          {righe.length === 0 && <div className="px-2 py-3 text-[11px] text-muted-foreground">Nessuna palina con questi criteri.</div>}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Tabella: {d.file ?? "—"} · feed {d.feed ?? "nessuno"}. {d.nota ?? ""}
      </p>
    </div>
  );
}
