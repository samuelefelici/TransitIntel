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
 * Le correzioni si fanno qui, riga per riga, e restano tracciate: chi,
 * quando, perché. Il file dell'azienda non si tocca; la tabella effettiva
 * (file + correzioni) si esporta nello stesso formato, con la colonna che
 * dice da dove viene ogni riga. Chi corregge ha tre aiuti, in ordine di
 * forza: il nome (un suggerimento), i dati di Mizar (una dimostrazione:
 * le corse che passano dalla palina passano da quello stop_id allo stesso
 * orario), e la ricerca libera nel feed.
 *
 * Gli stati sono pochi e distinti, con un colore ciascuno: «sospetta» non
 * è una sfumatura di «abbinata», è un abbinamento da guardare prima di
 * fidarsi.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Download, RefreshCw, Search, MapPin, AlertTriangle, CircleOff, HelpCircle, Check,
  Pencil, Undo2, Sparkles, X,
} from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";

type Stato = "abbinata" | "sospetta" | "fermata_assente" | "senza_codice";

interface Suggerimento { stopId: string; nome: string | null; motivo: "stesso_nome" | "nome_contenuto" }
interface Riga {
  mizarRef: string; stopId: string | null; nomeMizar: string | null; nomeFeed: string | null;
  stato: Stato; fonte: "file" | "manuale"; nota: string | null; utente: string | null;
  collisione: string | null; condivisaCon: number; vistaNelFlusso: boolean;
  /** assente se l'API in esecuzione è più vecchia della pagina */
  suggerimenti?: Suggerimento[];
}
interface Resp {
  file: string | null; errore: string | null; feed: string | null;
  correzioni: number; erroreCorrezioni: string | null; puoCorreggere: boolean;
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
interface FermataFeed { stopId: string; stopCode: string | null; nome: string | null }
interface Deduzione {
  ref: string; passaggi: number; corseAgganciate: number;
  deduzione: {
    passaggiUtili: number;
    candidati: Array<{ stopId: string; nome: string | null; prove: number; esempi: Array<{ corsa: string; orario: string }> }>;
    suggerito: string | null; lettura: string;
  } | null;
  nota?: string;
}

type Filtro = Stato | "collisione" | "feed_senza_codice" | "flusso" | "manuale" | null;

const SEGNO: Record<Stato, { etichetta: string; icona: typeof Check; colore: string; fondo: string; spiegazione: string }> = {
  abbinata:        { etichetta: "Abbinata",        icona: Check,         colore: "#34d399", fondo: "rgba(52,211,153,0.12)",  spiegazione: "la fermata esiste nel feed e il nome combacia" },
  sospetta:        { etichetta: "Sospetta",        icona: AlertTriangle, colore: "#fbbf24", fondo: "rgba(251,191,36,0.12)",  spiegazione: "la fermata esiste nel feed, ma con un altro nome: da controllare" },
  fermata_assente: { etichetta: "Fermata assente", icona: CircleOff,     colore: "#f87171", fondo: "rgba(248,113,113,0.12)", spiegazione: "lo stop_id della tabella non esiste nel feed in uso" },
  senza_codice:    { etichetta: "Senza codice",    icona: HelpCircle,    colore: "#94a3b8", fondo: "rgba(148,163,184,0.12)", spiegazione: "palina di Mizar senza una fermata nel feed" },
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

/* ── L'editor di una riga ─────────────────────────────────────────────────
 * Tre fonti di candidati e una decisione. La deduzione dai dati costa una
 * richiesta a Mizar: si chiede solo premendo il pulsante. */
function EditorAbbinamento({ riga, onChiudi }: { riga: Riga | { mizarRef: string; nomeMizar: string | null; stopId: null; suggerimenti?: Suggerimento[]; fonte: "file"; nota: null }; onChiudi: () => void }) {
  /* Un'API più vecchia della pagina non manda i suggerimenti: la lista
     resta vuota, il resto dell'editor funziona. */
  const suggerimenti = riga.suggerimenti ?? [];
  const qc = useQueryClient();
  const [scelta, setScelta] = useState<string | null>(riga.stopId);
  const [nessuna, setNessuna] = useState(false);
  const [nota, setNota] = useState(riga.nota ?? "");
  const [cercaFeed, setCercaFeed] = useState("");

  const ricerca = useQuery({
    queryKey: ["fermate-cerca", cercaFeed],
    queryFn: () => apiFetch<{ fermate: FermataFeed[] }>(`/api/siri/fermate/cerca?q=${encodeURIComponent(cercaFeed)}`),
    enabled: cercaFeed.trim().length >= 2,
    staleTime: 60_000,
  });
  const deduzione = useMutation({
    mutationFn: () => apiFetch<Deduzione>(`/api/siri/fermate/suggerisci/${encodeURIComponent(riga.mizarRef)}`, { method: "POST" }),
  });
  const salva = useMutation({
    mutationFn: () => apiFetch(`/api/siri/fermate/abbinamenti/${encodeURIComponent(riga.mizarRef)}`, {
      method: "PUT",
      body: JSON.stringify({ stopId: nessuna ? null : scelta, nota: nota.trim() || null, nome: riga.nomeMizar }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fermate-abbinamenti"] }); onChiudi(); },
  });
  const ripristina = useMutation({
    mutationFn: () => apiFetch(`/api/siri/fermate/abbinamenti/${encodeURIComponent(riga.mizarRef)}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fermate-abbinamenti"] }); onChiudi(); },
  });

  const Candidato = ({ stopId, nome, dettaglio, forte }: { stopId: string; nome: string | null; dettaglio: string; forte?: boolean }) => (
    <button
      type="button"
      onClick={() => { setScelta(stopId); setNessuna(false); }}
      className={`flex items-center gap-2 w-full text-left px-2 py-1 rounded border text-[11px] ${scelta === stopId && !nessuna ? "border-emerald-400/60 bg-emerald-400/10" : "border-border/40 hover:bg-muted/40"}`}
    >
      <span className="font-mono">{stopId}</span>
      <span className="truncate">{nome ?? "—"}</span>
      <span className={`ml-auto shrink-0 ${forte ? "text-emerald-300" : "text-muted-foreground"}`}>{dettaglio}</span>
    </button>
  );

  const d = deduzione.data?.deduzione ?? null;
  const cambiato = nessuna ? riga.stopId !== null : scelta !== riga.stopId;

  return (
    <tr className="border-b border-border/20 bg-muted/20">
      <td colSpan={7} className="px-3 py-3">
        <div className="grid gap-3 md:grid-cols-3 text-[11px]">
          <div className="space-y-1.5">
            <div className="font-medium flex items-center gap-1.5">Per nome
              <span className="text-muted-foreground font-normal">· un suggerimento</span></div>
            {suggerimenti.length === 0 && <div className="text-muted-foreground">Nessuna fermata del feed con un nome simile a «{riga.nomeMizar ?? "—"}».</div>}
            {suggerimenti.map(s => (
              <Candidato key={s.stopId} stopId={s.stopId} nome={s.nome} dettaglio={s.motivo === "stesso_nome" ? "stesso nome" : "nome simile"} />
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="font-medium flex items-center gap-1.5">Dai dati di Mizar
              <span className="text-muted-foreground font-normal">· una dimostrazione</span></div>
            <button
              type="button"
              onClick={() => deduzione.mutate()}
              disabled={deduzione.isPending}
              className="flex items-center gap-1.5 px-2 py-1 rounded border border-border/50 hover:bg-muted/40 disabled:opacity-50"
              title="Chiede a Mizar i passaggi di questa palina e cerca nel feed la fermata che le corse servono allo stesso orario"
            >
              <Sparkles className={`w-3.5 h-3.5 ${deduzione.isPending ? "animate-pulse" : ""}`} />
              {deduzione.isPending ? "Interrogo Mizar…" : "Verifica dai passaggi"}
            </button>
            {deduzione.isError && <div className="text-red-300">{String((deduzione.error as any)?.message ?? deduzione.error)}</div>}
            {deduzione.data && (
              <>
                <div className="text-muted-foreground leading-snug">{d?.lettura ?? deduzione.data.nota ?? `${deduzione.data.passaggi} passaggi, ${deduzione.data.corseAgganciate} corse nel feed.`}</div>
                {d?.candidati.slice(0, 4).map(c => (
                  <Candidato key={c.stopId} stopId={c.stopId} nome={c.nome} forte={c.stopId === d.suggerito}
                    dettaglio={`${c.prove} ${c.prove === 1 ? "prova" : "prove"}${c.stopId === d.suggerito ? " · suggerita" : ""}`} />
                ))}
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="font-medium">Cerca nel feed</div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1.5 text-muted-foreground" />
              <input
                id={`cerca-feed-${riga.mizarRef}`}
                value={cercaFeed}
                onChange={e => setCercaFeed(e.target.value)}
                placeholder="stop_id, stop_code o nome"
                className="w-full pl-7 pr-2 py-1 rounded border border-border/50 bg-background text-[11px]"
              />
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {(ricerca.data?.fermate ?? []).map(f => (
                <Candidato key={f.stopId} stopId={f.stopId} nome={f.nome} dettaglio={f.stopCode && f.stopCode !== f.stopId ? `code ${f.stopCode}` : ""} />
              ))}
              {cercaFeed.trim().length >= 2 && ricerca.data && ricerca.data.fermate.length === 0 && <div className="text-muted-foreground">Nessuna fermata trovata.</div>}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" id={`nessuna-${riga.mizarRef}`} checked={nessuna} onChange={e => setNessuna(e.target.checked)} />
            Nessuna fermata nel feed per questa palina
          </label>
          <input
            id={`nota-${riga.mizarRef}`}
            value={nota}
            onChange={e => setNota(e.target.value)}
            placeholder="Perché (facoltativo): banchina spostata, palina dismessa…"
            className="flex-1 min-w-[200px] px-2 py-1 rounded border border-border/50 bg-background text-[11px]"
          />
          <span className="text-muted-foreground">
            Scelta: <span className="font-mono">{nessuna ? "nessuna" : (scelta ?? "—")}</span>
          </span>
          <button
            type="button"
            onClick={() => salva.mutate()}
            disabled={salva.isPending || !cambiato}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/20 border border-emerald-400/40 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40"
          >
            <Check className="w-3.5 h-3.5" /> Salva correzione
          </button>
          {riga.fonte === "manuale" && (
            <button
              type="button"
              onClick={() => ripristina.mutate()}
              disabled={ripristina.isPending}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border/50 hover:bg-muted/40"
              title="Toglie la correzione e torna alla riga del file"
            >
              <Undo2 className="w-3.5 h-3.5" /> Ripristina dal file
            </button>
          )}
          <button type="button" onClick={onChiudi} className="flex items-center gap-1 px-2 py-1 rounded hover:bg-muted/40 text-muted-foreground">
            <X className="w-3.5 h-3.5" /> Chiudi
          </button>
          {(salva.isError || ripristina.isError) && (
            <span className="text-red-300">{String(((salva.error ?? ripristina.error) as any)?.message ?? "non salvata")}</span>
          )}
        </div>
      </td>
    </tr>
  );
}

export default function FermateMizar() {
  const [filtro, setFiltro] = useState<Filtro>(null);
  const [cerca, setCerca] = useState("");
  const [inModifica, setInModifica] = useState<string | null>(null);

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
    else if (filtro === "manuale") base = base.filter(r => r.fonte === "manuale");
    else if (filtro && filtro !== "feed_senza_codice") base = base.filter(r => r.stato === filtro);
    /* Prima ciò che va guardato: sospette, assenti, senza codice; le
       abbinate in fondo, in ordine di codice. */
    const peso: Record<Stato, number> = { sospetta: 0, fermata_assente: 1, senza_codice: 2, abbinata: 3 };
    return base.filter(trova).sort((a, b) => peso[a.stato] - peso[b.stato] || a.mizarRef.localeCompare(b.mizarRef, undefined, { numeric: true }));
  }, [d, filtro, cerca]);

  const feedSenza = useMemo(() => {
    if (!d) return [];
    const t = cerca.trim().toUpperCase();
    return (d.feedSenzaCodice ?? []).filter(f => !t || f.stopId.toUpperCase().includes(t) || (f.nome ?? "").toUpperCase().includes(t));
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
  const puoCorreggere = d.puoCorreggere;
  const manuali = d.righe.filter(x => x.fonte === "manuale").length;
  const flussoNon = d.flussoNonTrascodificato ?? [];

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
            {manuali > 0 && ` ${manuali} ${manuali === 1 ? "riga corretta" : "righe corrette"} da qui.`}
          </p>
          {d.ultimoGiro && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Ultimo giro SIRI alle {new Date(d.ultimoGiro.alle).toLocaleTimeString("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" })}:
              {" "}{d.ultimoGiro.agganciate} fermate agganciate ({d.ultimoGiro.perId} per codice, {d.ultimoGiro.perNome} per nome),
              {" "}{d.ultimoGiro.nonAgganciate.length} non agganciate.
            </p>
          )}
          {d.erroreCorrezioni && (
            <p className="text-[11px] text-amber-300 mt-1">Le correzioni non sono disponibili: {d.erroreCorrezioni}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => q.refetch()} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-[11px] hover:bg-muted/40" title="Rileggi">
            <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? "animate-spin" : ""}`} /> Aggiorna
          </button>
          <a href={`${getApiBase()}/api/siri/fermate/abbinamenti?formato=csv`} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border/50 text-[11px] hover:bg-muted/40" title="Tutte le righe con lo stato">
            <Download className="w-3.5 h-3.5" /> Stati (CSV)
          </a>
          <a href={`${getApiBase()}/api/siri/fermate/transcodifica?formato=csv`} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/40 text-[11px] hover:bg-muted/40" title="La transcodifica con le correzioni, nello stesso formato del file dell'azienda">
            <Download className="w-3.5 h-3.5" /> Transcodifica corretta (CSV)
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
        <Contatore n={manuali} etichetta="corrette da qui" colore="#7dd3fc" fondo="rgba(125,211,252,0.10)" icona={Pencil}
          attivo={filtro === "manuale"} onClick={() => setFiltro(filtro === "manuale" ? null : "manuale")} />
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

      {filtro === "flusso" && flussoNon.length > 0 && (
        <div className="rounded-lg border border-border/40 p-3 text-[11px] space-y-2">
          <div className="font-medium">Codici usati dal flusso SIRI nell'ultimo giro che la tabella non conosce</div>
          <div className="flex flex-wrap gap-1.5">
            {flussoNon.map(ref => (
              <button key={ref} type="button" disabled={!puoCorreggere} onClick={() => setInModifica(`nuovo:${ref}`)}
                className="font-mono px-2 py-0.5 rounded border border-border/40 hover:bg-muted/40 disabled:opacity-60" title={puoCorreggere ? "Abbina questa palina a una fermata del feed" : "Solo un amministratore può correggere"}>
                {ref}
              </button>
            ))}
          </div>
          {inModifica?.startsWith("nuovo:") && (
            <table className="w-full"><tbody>
              <EditorAbbinamento
                riga={{ mizarRef: inModifica.slice(6), nomeMizar: null, stopId: null, suggerimenti: [], fonte: "file", nota: null }}
                onChiudi={() => setInModifica(null)}
              />
            </tbody></table>
          )}
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
          <p className="px-2 py-1.5 text-[10px] text-muted-foreground">
            Una fermata del feed senza codice Mizar non si può abbinare da qui: il codice lo assegna Mizar. Quando comparirà nel flusso SIRI, la troverai fra le «viste nel flusso, non in tabella».
          </p>
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
                <th className="px-2 py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {righe.slice(0, MOSTRA).map(x => {
                const s = SEGNO[x.stato];
                const Icona = s.icona;
                const aperta = inModifica === x.mizarRef;
                return (
                  <React.Fragment key={`${x.mizarRef}|${x.stopId ?? ""}`}>
                    <tr className={`border-b border-border/20 align-top ${aperta ? "bg-muted/20" : ""}`}>
                      <td className="px-2 py-1 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: s.fondo, color: s.colore }} title={s.spiegazione}>
                          <Icona className="w-3 h-3" /> {s.etichetta}
                        </span>
                        {x.fonte === "manuale" && (
                          <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-sky-300 bg-sky-400/10" title={`corretta da ${x.utente ?? "un operatore"}${x.nota ? `: ${x.nota}` : ""}`}>
                            <Pencil className="w-3 h-3" /> corretta
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono">{x.mizarRef}</td>
                      <td className="px-2 py-1">{x.nomeMizar ?? "—"}</td>
                      <td className="px-2 py-1 font-mono">{x.stopId ?? "—"}</td>
                      <td className="px-2 py-1">{x.nomeFeed ?? <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {[
                          x.nota ? `«${x.nota}»` : null,
                          x.collisione ? `nel feed lo stop_id ${x.collisione}` : null,
                          x.condivisaCon > 0 ? `stessa fermata di altre ${x.condivisaCon} paline` : null,
                          x.vistaNelFlusso ? "vista nel flusso SIRI" : null,
                          x.stato !== "abbinata" && (x.suggerimenti?.length ?? 0) > 0 ? `${x.suggerimenti!.length} ${x.suggerimenti!.length === 1 ? "suggerimento" : "suggerimenti"} per nome` : null,
                        ].filter(Boolean).join(" · ")}
                      </td>
                      <td className="px-2 py-1 text-right whitespace-nowrap">
                        {puoCorreggere && (
                          <button type="button" onClick={() => setInModifica(aperta ? null : x.mizarRef)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/40 hover:bg-muted/40" title="Correggi l'abbinamento">
                            <Pencil className="w-3 h-3" /> {aperta ? "chiudi" : "correggi"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {aperta && <EditorAbbinamento riga={x} onChiudi={() => setInModifica(null)} />}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          {righe.length > MOSTRA && <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Mostrate {MOSTRA} su {righe.length}: restringi con la ricerca o i filtri, o scarica il CSV.</div>}
          {righe.length === 0 && <div className="px-2 py-3 text-[11px] text-muted-foreground">Nessuna palina con questi criteri.</div>}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Tabella: {d.file ?? "—"} · feed {d.feed ?? "nessuno"} · {d.correzioni ?? 0} correzioni salvate. {d.nota ?? ""}
        {!puoCorreggere && " Le correzioni sono riservate agli amministratori."}
      </p>
    </div>
  );
}
