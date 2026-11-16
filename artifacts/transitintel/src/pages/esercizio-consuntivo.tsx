/**
 * Consuntivo (Esercizio; area «Consuntivo» dei ruoli; tappa 4.5): gli esiti
 * delle corse, giorno per giorno.
 *
 * La proposta dall'AVM suggerisce, una persona decide. La conferma è per
 * eccezione: si confermano in blocco le corse che l'AVM ha visto (o che
 * tornano per continuità del turno macchina) e si lavora sul resto, corsa per
 * corsa o a gruppi. Ogni decisione è un evento del giornale, con autore e
 * ora; un errore si annulla con un altro evento.
 *
 * Chi ha l'area in lettura vede tutto e non ha i comandi. Se due persone
 * lavorano sulla stessa giornata, la seconda che salva riceve «la giornata è
 * cambiata» e la pagina si ricarica.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, CalendarRange, ClipboardCheck, History, Lock, Plus, RefreshCw, Snowflake, Undo2 } from "lucide-react";
import { chiudeLeGiornate } from "@workspace/permessi";
import { apiFetch, getApiBase } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { descrivi, elenco as elencoDi, leggiFasce, type VoceVariazione } from "@/lib/variazioni";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Esito = "effettuata" | "presunta" | "parziale" | "soppressa" | "da_verificare";
type Proposta = "effettuata_avm" | "parziale" | "continuita" | "da_verificare" | "soppressione_indizio" | "non_rilevata";
interface VoceGiornata { giorno: string; stato: "preparata" | "congelata" | "chiusa"; corse: number; confermate: number; effettuateAvm: number | null }
interface RiepilogoChiusura {
  corse: { programmate: number; aggiunte: number; effettuate: number; presunte: number; parziali: number; soppresse: number };
  km: { programmati: number; effettivi: number; persi: number; aggiunti: number };
}
interface Chiusura {
  chiusa: boolean; chiusaIl: string | null; chiusaDa: string | null; riepilogo: RiepilogoChiusura | null;
  perché: string | null; meseChiuso: boolean;
}
interface Corsa {
  chiave: string; codice: string | null; numero: string; linea: string | null; partenza: string | null; arrivo: string | null;
  fermataDa: string | null; fermataA: string | null; kmProg: number | null; turnoMacchina: string | null;
  proposta: Proposta | null; prove: { vetture?: string[]; motivo?: string } | null;
  origine: "programmata" | "aggiunta"; tipoAggiunta: string | null;
  esito: Esito | null; kmEff: number | null; causale: string | null; vettura: string | null; nota: string | null;
}
interface Causale { codice: string; descrizione: string; gruppo: string; imputabileAzienda: boolean; codiceEnte: string | null; attiva: boolean; ordine: number }
interface Evento {
  id: number; ts: string; tipo: string; corse: number; esempi: string[]; dati: Record<string, any>; causale: string | null;
  fonte: string; autore: string | null; annulla: number | null; annullatoDa: number | null;
}
interface Aggiunta { chiaveAvm: string; linea: string | null; numero: string | null; partenza: string | null; vetture: string[]; transiti: number; osservazioni: number }
interface Giornata {
  giorno: string; stato: "preparata" | "congelata" | "chiusa"; programma: string | null; corse: number; kmProg: number; versione: number;
  elenco: Corsa[]; aggiunte: Aggiunta[]; giornale: Evento[]; causali: Causale[]; chiusura: Chiusura | null;
  proposta: { caronte: boolean; definitiva: boolean; calcolataIl: string } | null;
}

const data = (g: string) => new Date(`${g}T12:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const ora = (t: string | null) => (t ? t.slice(0, 5) : "—");
const oraDi = (ts: string) => new Date(ts).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const km = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("it-IT", { maximumFractionDigits: 1 }));

const ESITI: Array<{ id: Esito; nome: string; colore: string }> = [
  { id: "effettuata", nome: "Effettuata", colore: "text-emerald-300 border-emerald-400/40" },
  /* la presunzione di effettuazione (4.6): senza prove, salvo segnalazione */
  { id: "presunta", nome: "Presunta", colore: "text-teal-200 border-teal-300/40" },
  { id: "parziale", nome: "Parziale", colore: "text-amber-300 border-amber-400/40" },
  { id: "soppressa", nome: "Soppressa", colore: "text-rose-300 border-rose-400/40" },
  { id: "da_verificare", nome: "Da verificare", colore: "text-amber-200 border-amber-300/40" },
];
const PROPOSTE: Record<Proposta, string> = {
  effettuata_avm: "Effettuata (AVM)", continuita: "Per continuità", parziale: "Parziale?", da_verificare: "Da verificare",
  soppressione_indizio: "Soppressa?", non_rilevata: "Non rilevata",
};
const TIPI_EVENTO: Record<string, string> = {
  esito: "Esito", conferma: "Conferma delle proposte", aggiunta: "Corsa aggiunta", annullamento: "Annullamento",
  cancellazione_avm: "Annullata dall'AVM", nota: "Nota", chiusura: "Giornata chiusa", riapertura: "Giornata riaperta",
};
const TIPI_AGGIUNTA = [["bis", "Bis"], ["recupero", "Recupero"], ["sostitutiva", "Sostitutiva"], ["fuori_programma", "Fuori programma"]] as const;
const FILTRI = [
  ["tutte", "Tutte"], ["da_decidere", "Da decidere"], ["probabili", "Soppressioni probabili"],
  ["effettuata", "Effettuate"], ["presunta", "Presunte"], ["parziale", "Parziali"],
  ["soppressa", "Soppresse"], ["da_verificare", "Da verificare"], ["aggiunte", "Aggiunte"],
] as const;

const etichettaEsito = (e: Esito | null) => ESITI.find((x) => x.id === e) ?? null;
const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-sm";

export default function ConsuntivoPage() {
  const { puo, user } = useAuth();
  const scrive = puo("consuntivo", "S");
  const admin = user?.role === "admin";
  const chiude = chiudeLeGiornate({ admin, ruoli: user?.ruoli ?? [] });
  const [motivoRiapertura, setMotivoRiapertura] = useState<string | null>(null);
  const [elenco, setElenco] = useState<VoceGiornata[]>([]);
  const [scelta, setScelta] = useState<string | null>(null);
  const [g, setG] = useState<Giornata | null>(null);
  const [filtro, setFiltro] = useState<(typeof FILTRI)[number][0]>("da_decidere");
  const [cerca, setCerca] = useState("");
  const [selezione, setSelezione] = useState<Set<string>>(new Set());
  const [azione, setAzione] = useState<null | "soppressa" | "parziale">(null);
  const [causale, setCausale] = useState("");
  const [kmParziale, setKmParziale] = useState("");
  const [nota, setNota] = useState("");
  const [daAprire, setDaAprire] = useState("");
  const [occupato, setOccupato] = useState(false);
  const [messaggio, setMessaggio] = useState<{ tipo: "ok" | "errore"; testo: string } | null>(null);

  const caricaElenco = useCallback(async () => {
    try { setElenco((await apiFetch<{ giornate: VoceGiornata[] }>("/api/esercizio/giornate")).giornate); }
    catch (e: any) { setMessaggio({ tipo: "errore", testo: e?.message || "Giornate non leggibili" }); }
  }, []);
  const apri = useCallback(async (giorno: string) => {
    setScelta(giorno); setOccupato(true);
    try { setG(await apiFetch<Giornata>(`/api/esercizio/giornate/${giorno}`)); }
    catch (e: any) { setG(null); setMessaggio({ tipo: "errore", testo: e?.message || "Giornata non leggibile" }); }
    finally { setOccupato(false); }
  }, []);
  useEffect(() => {
    void (async () => {
      const r = await apiFetch<{ giornate: VoceGiornata[] }>("/api/esercizio/giornate").catch(() => ({ giornate: [] as VoceGiornata[] }));
      setElenco(r.giornate);
      /* la giornata di ieri, la prima da consuntivare; altrimenti la più recente congelata */
      const congelate = r.giornate.filter((x) => x.stato === "congelata");
      const prima = congelate.find((x) => x.confermate < x.corse) ?? congelate[0];
      if (prima) void apri(prima.giorno);
    })();
  }, [apri]);
  const cambiaGiornata = (giorno: string) => { setSelezione(new Set()); setAzione(null); setMessaggio(null); void apri(giorno); };

  /** Un evento del giornale; se la giornata è cambiata nel frattempo, si ricarica e lo si dice. */
  const registra = async (corpo: Record<string, unknown>, fatto: string) => {
    if (!g) return;
    setOccupato(true); setMessaggio(null);
    try {
      await apiFetch(`/api/esercizio/giornate/${g.giorno}/eventi`, { method: "POST", body: JSON.stringify({ versione: g.versione, ...corpo }) });
      setSelezione(new Set()); setAzione(null); setNota(""); setKmParziale("");
      await Promise.all([apri(g.giorno), caricaElenco()]);
      /* il messaggio dopo il ricaricamento: i conteggi che si vedono sono già quelli nuovi */
      setMessaggio({ tipo: "ok", testo: fatto });
    } catch (e: any) {
      setMessaggio({ tipo: "errore", testo: e?.message || "Non registrato" });
      if (e?.status === 409) await apri(g.giorno);
    } finally { setOccupato(false); }
  };

  const corse = useMemo(() => {
    const l = g?.elenco ?? [];
    const f = cerca.trim().toLowerCase();
    return l.filter((c) => {
      if (filtro === "da_decidere" && c.esito) return false;
      /* da decidere, con la proposta «soppressione probabile» (annullata dall'AVM, fuori fascia di uno sciopero, turno scoperto) */
      if (filtro === "probabili" && (c.esito || c.proposta !== "soppressione_indizio")) return false;
      if (filtro === "aggiunte" && c.origine !== "aggiunta") return false;
      if (["effettuata", "presunta", "parziale", "soppressa", "da_verificare"].includes(filtro) && c.esito !== filtro) return false;
      return !f || [c.linea, c.numero, c.codice, c.turnoMacchina, c.fermataDa, c.fermataA, c.vettura].some((x) => (x ?? "").toLowerCase().includes(f));
    });
  }, [g, filtro, cerca]);
  const conteggi = useMemo(() => {
    const l = g?.elenco ?? [];
    const per = Object.fromEntries(ESITI.map((e) => [e.id, 0])) as Record<Esito, number>;
    let daDecidere = 0, kmEff = 0, kmProgConfermati = 0, senzaProposta = 0;
    const proposteAperte: Partial<Record<Proposta, number>> = {};
    for (const c of l) {
      if (c.esito) { per[c.esito]++; kmEff += c.kmEff ?? 0; kmProgConfermati += c.kmProg ?? 0; }
      else { daDecidere++; if (c.proposta) proposteAperte[c.proposta] = (proposteAperte[c.proposta] ?? 0) + 1; else senzaProposta++; }
    }
    /* la presunzione vale per le non rilevate e per le corse senza proposta (giornate senza AVM) */
    return { per, daDecidere, kmEff, kmProgConfermati, proposteAperte, presumibili: (proposteAperte.non_rilevata ?? 0) + senzaProposta };
  }, [g]);
  const causaliAttive = g?.causali ?? [];
  /* una giornata chiusa non si scrive più: niente comandi */
  const scriveGiornata = scrive && g?.stato === "congelata";
  const visibili = corse.slice(0, 1000);
  const tutteSelezionate = visibili.length > 0 && visibili.every((c) => selezione.has(c.chiave));
  const commuta = (k: string) => setSelezione((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <ClipboardCheck className="w-6 h-6 text-primary mt-0.5" />
        <div>
          <h1 className="text-xl font-semibold">Consuntivo</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Gli esiti delle corse, giorno per giorno. La proposta dall'AVM suggerisce, una persona decide: si confermano in blocco le
            corse che l'AVM ha visto e si lavora sul resto. Ogni decisione resta nel giornale con autore e ora; un errore si annulla.
            {!scrive && " Hai il consuntivo in sola lettura."}
          </p>
        </div>
      </div>

      <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (daAprire) cambiaGiornata(daAprire); }}>
        <div className="space-y-1">
          <Label htmlFor="consuntivo-giorno">Giornata</Label>
          <Input id="consuntivo-giorno" type="date" value={daAprire} onChange={(e) => setDaAprire(e.target.value)} className="w-44" />
        </div>
        <Button type="submit" variant="outline" disabled={occupato || !daAprire}>Apri</Button>
      </form>

      {messaggio && (
        <div role="status" className={`text-sm ${messaggio.tipo === "ok" ? "text-emerald-300" : "text-destructive"}`}>{messaggio.testo}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Giornate</CardTitle></CardHeader>
          <CardContent className="p-0">
            {elenco.length === 0 && <div className="px-4 pb-4 text-sm text-muted-foreground">Nessuna giornata: le prepara il lavoratore.</div>}
            <ul className="max-h-[640px] overflow-y-auto">
              {elenco.map((x) => (
                <li key={x.giorno}>
                  <button type="button" onClick={() => cambiaGiornata(x.giorno)}
                    className={`w-full text-left px-4 py-2 border-t border-border/50 hover:bg-muted/40 ${scelta === x.giorno ? "bg-muted/60" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium capitalize">{data(x.giorno)}</span>
                      {x.stato === "chiusa" ? <Lock className="w-3 h-3 text-emerald-300" aria-label="chiusa" />
                        : x.stato === "congelata"
                          ? (daChiudere(x.giorno)
                            ? <span className="inline-flex items-center gap-1 text-xs text-amber-300"><AlertTriangle className="w-3 h-3" />da chiudere</span>
                            : <Snowflake className="w-3 h-3 text-sky-300" aria-label="cominciata" />)
                          : <span className="text-xs text-muted-foreground">domani</span>}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {x.stato === "chiusa" ? "chiusa"
                        : x.stato === "congelata"
                        ? `${x.confermate.toLocaleString("it-IT")} su ${x.corse.toLocaleString("it-IT")} decise`
                        : `${x.corse.toLocaleString("it-IT")} corse programmate`}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          {g && g.stato === "preparata" && (
            <Card><CardContent className="py-6 text-sm text-muted-foreground">La giornata del {data(g.giorno)} non è ancora cominciata: il consuntivo si fa da quando comincia, alle 03:00.</CardContent></Card>
          )}
          {g && g.stato !== "preparata" && (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base capitalize">{data(g.giorno)}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {g.programma ?? "—"} · {g.corse.toLocaleString("it-IT")} corse programmate · {km(g.kmProg)} km
                    {g.proposta?.caronte ? ` · proposta dall'AVM ${g.proposta.definitiva ? "definitiva" : "viva"}` : " · senza proposta dall'AVM"}
                  </p>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex flex-wrap gap-2 tabular-nums">
                    {ESITI.map((e) => (
                      <span key={e.id} className={`rounded-md border px-2.5 py-1 text-xs ${e.colore}`}>{e.nome} <b>{conteggi.per[e.id].toLocaleString("it-IT")}</b></span>
                    ))}
                    <span className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">Da decidere <b>{conteggi.daDecidere.toLocaleString("it-IT")}</b></span>
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    Km effettivi delle corse decise: {km(conteggi.kmEff)} su {km(conteggi.kmProgConfermati)} programmati
                  </div>
                  {scriveGiornata && (
                    <div className="flex flex-wrap gap-2">
                      {(["effettuata_avm", "continuita"] as const).map((p) => (
                        <Button key={p} size="sm" variant="outline" disabled={occupato || !conteggi.proposteAperte[p]}
                          onClick={() => void registra({ tipo: "conferma", proposte: [p] }, `Confermate le corse «${PROPOSTE[p]}»`)}>
                          Conferma «{PROPOSTE[p]}» ({(conteggi.proposteAperte[p] ?? 0).toLocaleString("it-IT")})
                        </Button>
                      ))}
                      <Button size="sm" variant="outline" disabled={occupato || !conteggi.presumibili}
                        title="Le corse senza prove dell'AVM si presumono effettuate, salvo segnalazione: un esito a sé, distinto dalle provate"
                        onClick={() => void registra({ tipo: "conferma", proposte: ["non_rilevata"] }, "Presunte effettuate le corse non rilevate")}>
                        Presumi effettuate le non rilevate ({conteggi.presumibili.toLocaleString("it-IT")})
                      </Button>
                      <Button size="sm" variant="ghost" disabled={occupato}
                        onClick={async () => {
                          setOccupato(true);
                          try { await apiFetch(`/api/esercizio/giornate/${g.giorno}/proposta`, { method: "POST" }); await apri(g.giorno); }
                          catch (e: any) { setMessaggio({ tipo: "errore", testo: e?.message || "Proposta non riuscita" }); }
                          finally { setOccupato(false); }
                        }}>
                        <RefreshCw className={`w-4 h-4 mr-1.5 ${occupato ? "animate-spin" : ""}`} />Ricalcola la proposta
                      </Button>
                    </div>
                  )}
                  <ChiusuraGiornata g={g} chiude={chiude} admin={admin} occupato={occupato} motivo={motivoRiapertura} setMotivo={setMotivoRiapertura}
                    onChiudi={async () => {
                      setOccupato(true); setMessaggio(null);
                      try {
                        await apiFetch(`/api/esercizio/giornate/${g.giorno}/chiusura`, { method: "POST", body: JSON.stringify({ versione: g.versione }) });
                        await Promise.all([apri(g.giorno), caricaElenco()]);
                        setMessaggio({ tipo: "ok", testo: "Giornata chiusa" });
                      } catch (e: any) { setMessaggio({ tipo: "errore", testo: e?.message || "Chiusura non riuscita" }); if (e?.status === 409) await apri(g.giorno); }
                      finally { setOccupato(false); }
                    }}
                    onRiapri={async (motivo) => {
                      setOccupato(true); setMessaggio(null);
                      try {
                        await apiFetch(`/api/admin/esercizio/giornate/${g.giorno}/riapertura`, { method: "POST", body: JSON.stringify({ motivo }) });
                        setMotivoRiapertura(null);
                        await Promise.all([apri(g.giorno), caricaElenco()]);
                        setMessaggio({ tipo: "ok", testo: "Giornata riaperta" });
                      } catch (e: any) { setMessaggio({ tipo: "errore", testo: e?.message || "Riapertura non riuscita" }); }
                      finally { setOccupato(false); }
                    }} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-3">
                  <CardTitle className="text-base">Corse</CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor="consuntivo-filtro" className="sr-only">Mostra</Label>
                    <select id="consuntivo-filtro" className={selectCls} value={filtro} onChange={(e) => { setFiltro(e.target.value as any); setSelezione(new Set()); }}>
                      {FILTRI.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
                    </select>
                    <Input id="consuntivo-cerca" placeholder="Linea, numero, turno, vettura" value={cerca} onChange={(e) => setCerca(e.target.value)} className="h-8 w-56" />
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {scriveGiornata && selezione.size > 0 && (
                    <div className="flex flex-wrap items-end gap-2 border-y border-border/50 bg-muted/30 px-3 py-2 text-sm">
                      <span className="mr-1 tabular-nums">{selezione.size.toLocaleString("it-IT")} selezionate:</span>
                      <Button size="sm" disabled={occupato} onClick={() => void registra({ tipo: "esito", chiavi: [...selezione], esito: "effettuata" }, "Segnate effettuate")}>Effettuate</Button>
                      <Button size="sm" variant="outline" disabled={occupato} onClick={() => void registra({ tipo: "esito", chiavi: [...selezione], esito: "da_verificare" }, "Segnate da verificare")}>Da verificare</Button>
                      <Button size="sm" variant="outline" disabled={occupato} onClick={() => setAzione("soppressa")}>Soppresse…</Button>
                      <Button size="sm" variant="outline" disabled={occupato || selezione.size !== 1} onClick={() => setAzione("parziale")}>Parziale…</Button>
                      {azione && (
                        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
                          e.preventDefault();
                          if (!causale) return;
                          void registra({
                            tipo: "esito", chiavi: [...selezione], esito: azione, causale,
                            ...(azione === "parziale" && kmParziale ? { kmEff: Number(kmParziale.replace(",", ".")) } : {}),
                            ...(nota.trim() ? { nota: nota.trim() } : {}),
                          }, azione === "soppressa" ? "Segnate soppresse" : "Segnata parziale");
                        }}>
                          <div className="space-y-1">
                            <Label htmlFor="consuntivo-causale" className="text-xs">Causale</Label>
                            <select id="consuntivo-causale" className={selectCls} value={causale} onChange={(e) => setCausale(e.target.value)} required>
                              <option value="">Scegli…</option>
                              {causaliAttive.map((c) => <option key={c.codice} value={c.codice}>{c.descrizione}</option>)}
                            </select>
                          </div>
                          {azione === "parziale" && (
                            <div className="space-y-1">
                              <Label htmlFor="consuntivo-km" className="text-xs">Km fatti</Label>
                              <Input id="consuntivo-km" inputMode="decimal" className="h-8 w-24" value={kmParziale} onChange={(e) => setKmParziale(e.target.value)} placeholder="da calcolare" />
                            </div>
                          )}
                          <div className="space-y-1">
                            <Label htmlFor="consuntivo-nota-esito" className="text-xs">Nota</Label>
                            <Input id="consuntivo-nota-esito" className="h-8 w-56" maxLength={500} value={nota} onChange={(e) => setNota(e.target.value)} />
                          </div>
                          <Button size="sm" type="submit" disabled={occupato || !causale}>Registra</Button>
                          <Button size="sm" type="button" variant="ghost" onClick={() => setAzione(null)}>Annulla</Button>
                        </form>
                      )}
                    </div>
                  )}
                  <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                        <tr className="text-left">
                          {scriveGiornata && (
                            <th className="px-3 py-2 w-8">
                              <input type="checkbox" aria-label="Seleziona tutte quelle mostrate" checked={tutteSelezionate}
                                onChange={() => setSelezione(tutteSelezionate ? new Set() : new Set(visibili.map((c) => c.chiave)))} />
                            </th>
                          )}
                          <th className="px-3 py-2">Linea</th><th className="px-3 py-2">N.</th><th className="px-3 py-2">Parte</th>
                          <th className="px-3 py-2">Turno macchina</th><th className="px-3 py-2">Proposta</th><th className="px-3 py-2">Esito</th>
                          <th className="px-3 py-2">Causale</th><th className="px-3 py-2 text-right">Km</th><th className="px-3 py-2">Vettura</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {visibili.map((c) => {
                          const e = etichettaEsito(c.esito);
                          return (
                            <tr key={c.chiave} className={`border-t border-border/40 ${selezione.has(c.chiave) ? "bg-muted/40" : ""}`}>
                              {scriveGiornata && (
                                <td className="px-3 py-1.5"><input type="checkbox" aria-label={`Seleziona la corsa ${c.numero}`} checked={selezione.has(c.chiave)} onChange={() => commuta(c.chiave)} /></td>
                              )}
                              <td className="px-3 py-1.5 font-medium">{c.linea ?? "—"}{c.origine === "aggiunta" && <span className="ml-1 text-xs text-sky-300">aggiunta</span>}</td>
                              <td className="px-3 py-1.5">{c.numero}</td>
                              <td className="px-3 py-1.5">{ora(c.partenza)}</td>
                              <td className="px-3 py-1.5">{c.turnoMacchina ?? <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-3 py-1.5 text-xs text-muted-foreground" title={c.prove?.motivo}>{c.proposta ? PROPOSTE[c.proposta] : "—"}</td>
                              <td className="px-3 py-1.5">{e ? <span className={`inline-block rounded border px-1.5 py-0.5 text-xs ${e.colore}`}>{e.nome}</span> : <span className="text-xs text-muted-foreground">da decidere</span>}</td>
                              <td className="px-3 py-1.5 text-xs" title={c.nota ?? undefined}>{causaliAttive.find((x) => x.codice === c.causale)?.descrizione ?? c.causale ?? ""}</td>
                              <td className="px-3 py-1.5 text-right">{c.esito ? km(c.kmEff) : km(c.kmProg)}</td>
                              <td className="px-3 py-1.5">{c.vettura ?? ""}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {corse.length > 1000 && <div className="px-3 py-2 text-xs text-muted-foreground">Le prime 1.000 di {corse.length.toLocaleString("it-IT")}: filtra per vedere le altre.</div>}
                  {corse.length === 0 && <div className="px-3 py-3 text-sm text-muted-foreground">Nessuna corsa con questo filtro.</div>}
                </CardContent>
              </Card>

              <AggiunteCard g={g} scrive={scriveGiornata} occupato={occupato} registra={registra} causali={causaliAttive} />
              <GiornaleCard g={g} scrive={scriveGiornata} occupato={occupato} registra={registra} />
            </>
          )}
          {g && <MeseCard mese={g.giorno.slice(0, 7)} admin={admin} versioneGiornata={`${g.giorno}|${g.stato}|${g.versione}`}
            onCambiato={() => { void caricaElenco(); if (g) void apri(g.giorno); }} />}
          {admin && g && <CausaliAdmin onSalvato={() => g && void apri(g.giorno)} />}
        </div>
      </div>

      <VariazioniCard scrive={scrive} onCambiato={() => { void caricaElenco(); if (g) void apri(g.giorno); }} />
    </div>
  );
}

type Registra = (corpo: Record<string, unknown>, fatto: string) => Promise<void>;

/** Una giornata cominciata e ancora aperta dopo tre giorni: va chiusa (nessun blocco automatico, solo il segnale). */
function daChiudere(giorno: string): boolean {
  const limite = new Date();
  limite.setDate(limite.getDate() - 3);
  return giorno < limite.toISOString().slice(0, 10);
}

const riepilogoInBreve = (r: RiepilogoChiusura) =>
  `${r.corse.programmate.toLocaleString("it-IT")} programmate: ${r.corse.effettuate.toLocaleString("it-IT")} effettuate, `
  + `${r.corse.presunte.toLocaleString("it-IT")} presunte, ${r.corse.parziali.toLocaleString("it-IT")} parziali, ${r.corse.soppresse.toLocaleString("it-IT")} soppresse`
  + `${r.corse.aggiunte ? `; ${r.corse.aggiunte.toLocaleString("it-IT")} aggiunte` : ""} · km ${km(r.km.effettivi)} su ${km(r.km.programmati)} (persi ${km(r.km.persi)})`;

function ChiusuraGiornata({ g, chiude, admin, occupato, motivo, setMotivo, onChiudi, onRiapri }: {
  g: Giornata; chiude: boolean; admin: boolean; occupato: boolean; motivo: string | null; setMotivo: (m: string | null) => void;
  onChiudi: () => void; onRiapri: (motivo: string) => void;
}) {
  const c = g.chiusura;
  if (g.stato === "chiusa" && c) {
    return (
      <div className="space-y-2 rounded-md border border-emerald-400/30 bg-emerald-500/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Lock className="w-4 h-4 text-emerald-300" />
          <span className="font-medium">Chiusa</span>
          <span className="text-xs text-muted-foreground">il {c.chiusaIl ? oraDi(c.chiusaIl) : "—"}{c.chiusaDa ? ` da ${c.chiusaDa}` : ""} · non si scrive più</span>
        </div>
        {c.riepilogo && <div className="text-xs tabular-nums">{riepilogoInBreve(c.riepilogo)}</div>}
        {admin && (c.meseChiuso
          ? <div className="text-xs text-muted-foreground">Il mese è chiuso: per riaprire la giornata riapri prima il mese.</div>
          : motivo === null
            ? <Button size="sm" variant="outline" disabled={occupato} onClick={() => setMotivo("")}>Riapri…</Button>
            : (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (motivo.trim().length >= 5) onRiapri(motivo.trim()); }}>
                <div className="space-y-1 grow"><Label htmlFor="riapertura-motivo" className="text-xs">Perché la riapri (resta nel giornale)</Label>
                  <Input id="riapertura-motivo" className="h-8" maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></div>
                <Button size="sm" type="submit" disabled={occupato || motivo.trim().length < 5}>Riapri la giornata</Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setMotivo(null)}>Annulla</Button>
              </form>
            ))}
      </div>
    );
  }
  if (g.stato !== "congelata" || !chiude) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border/50 pt-3">
      <Button size="sm" disabled={occupato || !!c?.perché} onClick={onChiudi}><Lock className="w-4 h-4 mr-1.5" />Chiudi la giornata</Button>
      <span className={`text-xs ${c?.perché ? "text-amber-200" : "text-muted-foreground"}`}>
        {c?.perché ?? "Tutte le corse sono decise: chiudendo, il riepilogo si congela e la giornata non si scrive più."}
      </span>
    </div>
  );
}

interface StatoMese {
  mese: string; stato: "aperto" | "chiuso"; chiusoIl: string | null; giorni: number; chiuse: number; aperte: string[]; mancanti: string[];
  riepilogo: RiepilogoChiusura | null; storia: Array<{ azione: string; da: string | null; il: string; motivo?: string }>;
}

interface VoceReport {
  linea?: string | null; vettore?: string; programmate: number; effettuate: number; presunte: number; parziali: number; soppresse: number;
  aggiunte: number; kmProgrammati: number; kmEffettivi: number; regolaritaCorse: number | null; regolaritaKm: number | null;
}
interface Report {
  statoMese: "aperto" | "chiuso";
  giornate: { chiuse: number; delMese: number; aperte: string[] };
  totali: VoceReport & { kmPersi: number; kmAggiunti: number };
  indicatori: {
    regolaritaCorse: { lorda: number | null; netta: number | null }; regolaritaKm: { lorda: number | null; netta: number | null };
    quotaProvata: number | null; puntualita: { campione: number; inOrario: number; quota: number | null; copertura: number | null };
  };
  perLinea: VoceReport[]; perVettore: VoceReport[]; perComune: Array<{ comune: string; kmProgrammati: number; kmEffettivi: number }>; notaComuni: string | null;
}
const perc = (x: number | null | undefined) => (x == null ? "—" : `${x.toLocaleString("it-IT", { maximumFractionDigits: 1 })}%`);

/** Il report del mese (4.7), a richiesta: gli indicatori, le linee più indietro, gli scaricamenti. */
function ReportMese({ mese, versione }: { mese: string; versione: string }) {
  const [r, setR] = useState<Report | null>(null);
  const [occupato, setOccupato] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  useEffect(() => { setR(null); }, [mese, versione]);
  const calcola = async () => {
    setOccupato(true); setErrore(null);
    try { setR(await apiFetch<Report>(`/api/esercizio/mesi/${mese}/report`)); }
    catch (e: any) { setErrore(e?.message || "Report non riuscito"); }
    finally { setOccupato(false); }
  };
  const base = `${getApiBase()}/api/esercizio/mesi/${mese}`;
  /* solo le linee sotto il 100%: con tutte al 100% l'elenco non direbbe niente */
  const linee = r ? r.perLinea.filter((l) => l.programmate > 0 && l.regolaritaKm != null && l.regolaritaKm < 100)
    .sort((a, b) => a.regolaritaKm! - b.regolaritaKm!).slice(0, 8) : [];
  const nComuni = r?.perComune.length ?? 0;
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Report del mese</span>
        <span className="text-xs text-muted-foreground">sulle giornate chiuse{r && r.statoMese !== "chiuso" ? " · provvisorio finché il mese è aperto" : ""}</span>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" disabled={occupato} onClick={() => void calcola()}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${occupato ? "animate-spin" : ""}`} />{r ? "Ricalcola" : "Calcola il report"}
          </Button>
          <a className="text-sm underline underline-offset-2" href={`${base}/report.xlsx`} download>Scarica XLSX</a>
          <a className="text-sm underline underline-offset-2" href={`${base}/dettaglio.csv`} download>Dettaglio corse (CSV)</a>
        </div>
      </div>
      {errore && <div className="text-destructive text-sm">{errore}</div>}
      {r && (
        <>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 text-sm tabular-nums">
            <div><span className="text-muted-foreground">Regolarità corse: </span>{perc(r.indicatori.regolaritaCorse.lorda)} <span className="text-muted-foreground">(netta {perc(r.indicatori.regolaritaCorse.netta)})</span></div>
            <div><span className="text-muted-foreground">Regolarità km: </span>{perc(r.indicatori.regolaritaKm.lorda)} <span className="text-muted-foreground">(netta {perc(r.indicatori.regolaritaKm.netta)})</span></div>
            <div><span className="text-muted-foreground">Provate dall'AVM: </span>{perc(r.indicatori.quotaProvata)} <span className="text-muted-foreground">delle programmate</span></div>
            <div title="Solo sulle corse con la partenza vista dall'AVM: non è la puntualità dell'azienda">
              <span className="text-muted-foreground">Puntualità sul campione AVM: </span>{perc(r.indicatori.puntualita.quota)}
              <span className="text-muted-foreground"> su {r.indicatori.puntualita.campione.toLocaleString("it-IT")} corse (copertura {perc(r.indicatori.puntualita.copertura)})</span>
            </div>
            <div><span className="text-muted-foreground">Km: </span>{km(r.totali.kmEffettivi)} su {km(r.totali.kmProgrammati)} <span className="text-muted-foreground">(persi {km(r.totali.kmPersi)}, aggiunti {km(r.totali.kmAggiunti)})</span></div>
            <div><span className="text-muted-foreground">Vettori: </span>{r.perVettore.map((v) => `${v.vettore} ${(v.programmate + v.aggiunte).toLocaleString("it-IT")}`).join(" · ")}</div>
          </div>
          {linee.length === 0 && r.perLinea.length > 0 && <div className="text-sm text-muted-foreground">Tutte le linee al 100% di regolarità km.</div>}
          {linee.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <caption className="text-left py-1 text-muted-foreground">Le linee con la regolarità km più bassa</caption>
                <thead className="text-muted-foreground"><tr className="text-left">
                  <th className="px-2 py-1">Linea</th><th className="px-2 py-1 text-right">Programmate</th><th className="px-2 py-1 text-right">Soppresse</th>
                  <th className="px-2 py-1 text-right">Parziali</th><th className="px-2 py-1 text-right">Km</th><th className="px-2 py-1 text-right">Regolarità km</th>
                </tr></thead>
                <tbody>
                  {linee.map((l) => (
                    <tr key={String(l.linea)} className="border-t border-border/40">
                      <td className="px-2 py-1 font-medium">{l.linea ?? "—"}</td><td className="px-2 py-1 text-right">{l.programmate}</td>
                      <td className="px-2 py-1 text-right">{l.soppresse}</td><td className="px-2 py-1 text-right">{l.parziali}</td>
                      <td className="px-2 py-1 text-right">{km(l.kmEffettivi)} / {km(l.kmProgrammati)}</td><td className="px-2 py-1 text-right">{perc(l.regolaritaKm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            {nComuni ? `Per comune: ${nComuni} ${nComuni === 1 ? "voce" : "voci"} nell'XLSX.` : r.notaComuni}
            {r.giornate.aperte.length > 0 && ` · ${r.giornate.aperte.length} giornate aperte restano fuori.`}
          </div>
        </>
      )}
    </div>
  );
}

/** Il mese della giornata scelta: giornate chiuse, aperte e mancanti, il riepilogo; chiusura e riapertura dell'amministratore. */
function MeseCard({ mese, admin, versioneGiornata, onCambiato }: { mese: string; admin: boolean; versioneGiornata: string; onCambiato: () => void }) {
  const [m, setM] = useState<StatoMese | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [occupato, setOccupato] = useState(false);
  const carica = useCallback(async () => {
    try { setM(await apiFetch<StatoMese>(`/api/esercizio/mesi/${mese}`)); }
    catch (e: any) { setErrore(e?.message || "Mese non leggibile"); }
  }, [mese]);
  useEffect(() => { void carica(); }, [carica, versioneGiornata]);
  const azione = async (percorso: string, corpo?: unknown) => {
    setOccupato(true); setErrore(null);
    try {
      await apiFetch(percorso, { method: "POST", ...(corpo ? { body: JSON.stringify(corpo) } : {}) });
      setMotivo(null); await carica(); onCambiato();
    } catch (e: any) { setErrore(e?.message || "Non riuscito"); }
    finally { setOccupato(false); }
  };
  if (!m) return null;
  const nome = new Date(`${mese}-15T12:00:00`).toLocaleDateString("it-IT", { month: "long", year: "numeric" });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 capitalize"><CalendarRange className="w-4 h-4" />{nome}
          {m.stato === "chiuso" && <span className="inline-flex items-center gap-1 text-xs font-normal normal-case text-emerald-300"><Lock className="w-3 h-3" />mese chiuso</span>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">Il mese si chiude quando è finito e tutte le sue giornate sono chiuse; chiuso, le sue giornate non si riaprono.</p>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {errore && <div className="text-destructive">{errore}</div>}
        <div className="tabular-nums">
          {m.chiuse} giornate chiuse su {m.giorni}
          {m.aperte.length > 0 && <span className="text-amber-200"> · {m.aperte.length} aperte</span>}
          {m.mancanti.length > 0 && <span className="text-muted-foreground"> · {m.mancanti.length} senza giornata (prima del rilascio, o non preparate)</span>}
        </div>
        {m.riepilogo && <div className="text-xs tabular-nums">{m.stato === "chiuso" ? "Congelato: " : "Le giornate chiuse finora: "}{riepilogoInBreve(m.riepilogo)}</div>}
        {admin && m.stato === "aperto" && (
          <Button size="sm" variant="outline" disabled={occupato || m.aperte.length > 0 || m.chiuse === 0}
            onClick={() => void azione(`/api/admin/esercizio/mesi/${mese}/chiusura`)}>
            <Lock className="w-4 h-4 mr-1.5" />Chiudi il mese
          </Button>
        )}
        {admin && m.stato === "chiuso" && (motivo === null
          ? <Button size="sm" variant="outline" disabled={occupato} onClick={() => setMotivo("")}>Riapri il mese…</Button>
          : (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void azione(`/api/admin/esercizio/mesi/${mese}/riapertura`, { motivo: motivo.trim() }); }}>
              <div className="space-y-1 grow"><Label htmlFor="mese-motivo" className="text-xs">Perché lo riapri</Label>
                <Input id="mese-motivo" className="h-8" maxLength={500} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></div>
              <Button size="sm" type="submit" disabled={occupato || motivo.trim().length < 5}>Riapri il mese</Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setMotivo(null)}>Annulla</Button>
            </form>
          ))}
        {m.chiuse > 0 && <ReportMese mese={mese} versione={versioneGiornata} />}
        {m.storia.length > 0 && (
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {m.storia.map((s, i) => (
              <li key={i}>{oraDi(s.il)}: {s.azione === "chiusura" ? "chiuso" : "riaperto"}{s.da ? ` da ${s.da}` : ""}{s.motivo ? ` («${s.motivo}»)` : ""}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AggiunteCard({ g, scrive, occupato, registra, causali }: { g: Giornata; scrive: boolean; occupato: boolean; registra: Registra; causali: Causale[] }) {
  const [tipo, setTipo] = useState<string>("fuori_programma");
  const [linea, setLinea] = useState("");
  const [partenza, setPartenza] = useState("");
  const [kmA, setKmA] = useState("");
  const [causale, setCausale] = useState("");
  const giaAggiunte = new Set(g.giornale.filter((e) => e.tipo === "aggiunta" && !e.annullatoDa && e.dati?.candidata).map((e) => e.dati.candidata));
  const kmNum = kmA.trim() ? Number(kmA.replace(",", ".")) : undefined;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Plus className="w-4 h-4" />Corse aggiunte</CardTitle>
        <p className="text-xs text-muted-foreground">Corse che il programmato non ha: bis, recuperi, sostitutive, fuori programma. Dall'AVM o a mano.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {g.aggiunte.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border/50 max-h-[260px] overflow-y-auto">
            <table className="w-full text-sm">
              <caption className="text-left px-3 py-2 text-xs text-muted-foreground">Candidate dall'AVM</caption>
              <thead className="text-xs text-muted-foreground"><tr className="text-left">
                <th className="px-3 py-1.5">Parte</th><th className="px-3 py-1.5">Linea</th><th className="px-3 py-1.5">N.</th><th className="px-3 py-1.5">Vetture</th><th className="px-3 py-1.5" />
              </tr></thead>
              <tbody className="tabular-nums">
                {g.aggiunte.map((a) => (
                  <tr key={a.chiaveAvm} className="border-t border-border/40">
                    <td className="px-3 py-1.5">{a.partenza ?? "—"}</td><td className="px-3 py-1.5">{a.linea ?? "—"}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{a.numero ?? "—"}</td><td className="px-3 py-1.5">{a.vetture.join(", ") || "—"}</td>
                    <td className="px-3 py-1.5 text-right">
                      {giaAggiunte.has(a.chiaveAvm) ? <span className="text-xs text-emerald-300">aggiunta</span> : scrive && (
                        <Button size="sm" variant="outline" disabled={occupato || !a.linea || !a.partenza}
                          onClick={() => void registra({ tipo: "aggiunta", tipoAggiunta: tipo, linea: a.linea, partenza: a.partenza, candidata: a.chiaveAvm,
                            ...(kmNum != null ? { kmEff: kmNum } : {}), ...(causale ? { causale } : {}) }, "Corsa aggiunta")}>
                          Aggiungi
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {scrive && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault();
            void registra({ tipo: "aggiunta", tipoAggiunta: tipo, linea: linea.trim(), partenza, ...(kmNum != null ? { kmEff: kmNum } : {}), ...(causale ? { causale } : {}) }, "Corsa aggiunta");
            setLinea(""); setPartenza("");
          }}>
            <div className="space-y-1"><Label htmlFor="aggiunta-tipo" className="text-xs">Tipo</Label>
              <select id="aggiunta-tipo" className={selectCls} value={tipo} onChange={(e) => setTipo(e.target.value)}>
                {TIPI_AGGIUNTA.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
              </select></div>
            <div className="space-y-1"><Label htmlFor="aggiunta-linea" className="text-xs">Linea</Label>
              <Input id="aggiunta-linea" className="h-8 w-24" value={linea} onChange={(e) => setLinea(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="aggiunta-partenza" className="text-xs">Parte</Label>
              <Input id="aggiunta-partenza" type="time" className="h-8 w-28" value={partenza} onChange={(e) => setPartenza(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="aggiunta-km" className="text-xs">Km</Label>
              <Input id="aggiunta-km" inputMode="decimal" className="h-8 w-20" value={kmA} onChange={(e) => setKmA(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="aggiunta-causale" className="text-xs">Causale (facoltativa)</Label>
              <select id="aggiunta-causale" className={selectCls} value={causale} onChange={(e) => setCausale(e.target.value)}>
                <option value="">—</option>
                {causali.map((c) => <option key={c.codice} value={c.codice}>{c.descrizione}</option>)}
              </select></div>
            <Button size="sm" type="submit" disabled={occupato || !linea.trim() || !partenza}>Aggiungi a mano</Button>
            <span className="text-xs text-muted-foreground">Tipo, km e causale valgono anche per «Aggiungi» delle candidate.</span>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function GiornaleCard({ g, scrive, occupato, registra }: { g: Giornata; scrive: boolean; occupato: boolean; registra: Registra }) {
  const [nota, setNota] = useState("");
  const annullabile = (e: Evento) => ["esito", "conferma", "aggiunta", "nota"].includes(e.tipo) && !e.annullatoDa;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><History className="w-4 h-4" />Giornale</CardTitle>
        <p className="text-xs text-muted-foreground">Ogni decisione, con chi e quando. Un evento sbagliato si annulla, non si cancella.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {scrive && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void registra({ tipo: "nota", nota: nota.trim() }, "Nota aggiunta"); setNota(""); }}>
            <div className="space-y-1 grow"><Label htmlFor="giornale-nota" className="text-xs">Nota sulla giornata</Label>
              <Input id="giornale-nota" className="h-8" maxLength={500} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Per esempio: sciopero dalle 8:30 alle 12:30" /></div>
            <Button size="sm" type="submit" disabled={occupato || !nota.trim()}>Aggiungi</Button>
          </form>
        )}
        {g.giornale.length === 0 && <div className="text-muted-foreground">Ancora niente.</div>}
        <ul className="divide-y divide-border/40 max-h-[360px] overflow-y-auto">
          {g.giornale.map((e) => (
            <li key={e.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 ${e.annullatoDa ? "opacity-50 line-through" : ""}`}>
              <span className="text-xs text-muted-foreground tabular-nums w-24">{oraDi(e.ts)}</span>
              <span className="font-medium">{TIPI_EVENTO[e.tipo] ?? e.tipo}{e.tipo === "esito" && e.dati?.esito ? `: ${etichettaEsito(e.dati.esito)?.nome ?? e.dati.esito}` : ""}</span>
              {e.corse > 0 && <span className="text-xs text-muted-foreground tabular-nums">{e.corse.toLocaleString("it-IT")} corse</span>}
              {e.causale && <span className="text-xs">{g.causali.find((c) => c.codice === e.causale)?.descrizione ?? e.causale}</span>}
              {e.dati?.nota && <span className="text-xs italic">«{e.dati.nota}»</span>}
              {e.dati?.variazione && <span className="text-xs text-muted-foreground">da una variazione decisa in anticipo (n. {e.dati.variazione})</span>}
              <span className="text-xs text-muted-foreground">{e.autore ?? (e.fonte === "avm" ? "AVM" : "sistema")}</span>
              {e.annulla && <span className="text-xs text-muted-foreground">annulla l'evento delle {oraDi(g.giornale.find((x) => x.id === e.annulla)?.ts ?? e.ts)}</span>}
              {scrive && annullabile(e) && (
                <Button size="sm" variant="ghost" className="h-7 ml-auto" disabled={occupato}
                  onClick={() => void registra({ tipo: "annullamento", evento: e.id }, "Evento annullato")}>
                  <Undo2 className="w-3.5 h-3.5 mr-1" />Annulla
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Il catalogo delle causali, per l'amministratore: il codice non cambia (le corse lo citano), il resto sì. */
function CausaliAdmin({ onSalvato }: { onSalvato: () => void }) {
  const [causali, setCausali] = useState<Causale[]>([]);
  const [nuova, setNuova] = useState({ codice: "", descrizione: "", gruppo: "altro" });
  const [errore, setErrore] = useState<string | null>(null);
  const carica = useCallback(async () => {
    try { setCausali((await apiFetch<{ causali: Causale[] }>("/api/admin/esercizio/causali")).causali); }
    catch (e: any) { setErrore(e?.message || "Causali non leggibili"); }
  }, []);
  useEffect(() => { void carica(); }, [carica]);
  const salva = async (c: Pick<Causale, "codice" | "descrizione" | "gruppo" | "imputabileAzienda" | "codiceEnte" | "attiva" | "ordine">) => {
    setErrore(null);
    try {
      const { codice, ...corpo } = c;
      await apiFetch(`/api/admin/esercizio/causali/${encodeURIComponent(codice)}`, { method: "PUT", body: JSON.stringify(corpo) });
      await carica(); onSalvato();
    } catch (e: any) { setErrore(e?.message || "Causale non salvata"); }
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Causali (amministratore)</CardTitle>
        <p className="text-xs text-muted-foreground">Il catalogo iniziale si cambia qui: imputabilità all'azienda, codice per l'ente, attiva o no. Il codice resta: le corse lo citano.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {errore && <div className="text-destructive">{errore}</div>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr className="text-left">
              <th className="px-2 py-1.5">Codice</th><th className="px-2 py-1.5">Descrizione</th><th className="px-2 py-1.5">Imputabile all'azienda</th>
              <th className="px-2 py-1.5">Codice per l'ente</th><th className="px-2 py-1.5">Attiva</th>
            </tr></thead>
            <tbody>
              {causali.map((c) => (
                <tr key={c.codice} className="border-t border-border/40">
                  <td className="px-2 py-1 font-mono text-xs">{c.codice}</td>
                  <td className="px-2 py-1">{c.descrizione}</td>
                  <td className="px-2 py-1"><input type="checkbox" aria-label={`${c.descrizione}: imputabile all'azienda`} checked={c.imputabileAzienda} onChange={(e) => void salva({ ...c, imputabileAzienda: e.target.checked })} /></td>
                  <td className="px-2 py-1">
                    <Input aria-label={`${c.descrizione}: codice per l'ente`} className="h-7 w-28" defaultValue={c.codiceEnte ?? ""} maxLength={30}
                      onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== c.codiceEnte) void salva({ ...c, codiceEnte: v }); }} />
                  </td>
                  <td className="px-2 py-1"><input type="checkbox" aria-label={`${c.descrizione}: attiva`} checked={c.attiva} onChange={(e) => void salva({ ...c, attiva: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          void salva({ codice: nuova.codice.trim().toUpperCase(), descrizione: nuova.descrizione.trim(), gruppo: nuova.gruppo, imputabileAzienda: true, codiceEnte: null, attiva: true, ordine: (causali.at(-1)?.ordine ?? 0) + 10 });
          setNuova({ codice: "", descrizione: "", gruppo: "altro" });
        }}>
          <div className="space-y-1"><Label htmlFor="causale-codice" className="text-xs">Codice</Label>
            <Input id="causale-codice" className="h-8 w-40 font-mono" value={nuova.codice} onChange={(e) => setNuova({ ...nuova, codice: e.target.value })} placeholder="ES. DEVIAZIONE" /></div>
          <div className="space-y-1"><Label htmlFor="causale-descrizione" className="text-xs">Descrizione</Label>
            <Input id="causale-descrizione" className="h-8 w-56" value={nuova.descrizione} onChange={(e) => setNuova({ ...nuova, descrizione: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="causale-gruppo" className="text-xs">Gruppo</Label>
            <select id="causale-gruppo" className={selectCls} value={nuova.gruppo} onChange={(e) => setNuova({ ...nuova, gruppo: e.target.value })}>
              {["mezzo", "personale", "esterna", "servizio", "altro"].map((x) => <option key={x} value={x}>{x}</option>)}
            </select></div>
          <Button size="sm" type="submit" disabled={!nuova.codice.trim() || !nuova.descrizione.trim()}>Aggiungi la causale</Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Le variazioni decise in anticipo (4.10): soppressioni e scioperi per oggi e i giorni che vengono. */
function VariazioniCard({ scrive, onCambiato }: { scrive: boolean; onCambiato: () => void }) {
  const [voci, setVoci] = useState<VoceVariazione[] | null>(null);
  const [causali, setCausali] = useState<Causale[]>([]);
  const [tipo, setTipo] = useState<"soppressione" | "sciopero">("soppressione");
  const [giorno, setGiorno] = useState("");
  const [linee, setLinee] = useState("");
  const [numeri, setNumeri] = useState("");
  const [dalle, setDalle] = useState("");
  const [alle, setAlle] = useState("");
  const [fasce, setFasce] = useState("");
  const [causale, setCausale] = useState("");
  const [nota, setNota] = useState("");
  const [occupato, setOccupato] = useState(false);
  const [messaggio, setMessaggio] = useState<{ tipo: "ok" | "errore"; testo: string } | null>(null);

  const carica = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([
        apiFetch<{ variazioni: VoceVariazione[] }>("/api/esercizio/variazioni"),
        apiFetch<{ causali: Causale[] }>("/api/esercizio/causali"),
      ]);
      setVoci(v.variazioni); setCausali(c.causali);
    } catch (e: any) { setMessaggio({ tipo: "errore", testo: e?.message || "Variazioni non leggibili" }); }
  }, []);
  useEffect(() => { void carica(); }, [carica]);

  const fasceLette = tipo === "sciopero" ? leggiFasce(fasce) : null;
  const causaleScelta = causale || (tipo === "sciopero" ? "SCIOPERO" : "");
  const pronta = !!giorno && !!causaleScelta && (tipo === "sciopero"
    ? !!fasceLette
    : elencoDi(linee).length + elencoDi(numeri).length > 0 && !dalle === !alle);

  const scrivi = async () => {
    setOccupato(true); setMessaggio(null);
    try {
      const comune = { giorno, linee: elencoDi(linee), causale: causaleScelta, ...(nota.trim() ? { nota: nota.trim() } : {}) };
      const corpo = tipo === "sciopero"
        ? { tipo, ...comune, fasce: fasceLette }
        : { tipo, ...comune, numeri: elencoDi(numeri), ...(dalle && alle ? { dalle, alle } : {}) };
      const r = await apiFetch<{ id: number; applicata: { corse: number | null; errore?: string } | null }>("/api/esercizio/variazioni", {
        method: "POST", body: JSON.stringify(corpo),
      });
      await carica();
      setLinee(""); setNumeri(""); setDalle(""); setAlle(""); setFasce(""); setNota("");
      setMessaggio(r.applicata
        ? { tipo: r.applicata.errore ? "errore" : "ok", testo: r.applicata.errore
          ? `Variazione scritta, ma non applicata: ${r.applicata.errore}`
          : `Variazione scritta e applicata subito, la giornata è già cominciata: ${(r.applicata.corse ?? 0).toLocaleString("it-IT")} corse` }
        : { tipo: "ok", testo: "Variazione scritta: vale quando la giornata comincia" });
      if (r.applicata) onCambiato();
    } catch (e: any) {
      setMessaggio({ tipo: "errore", testo: e?.message || "Variazione non scritta" });
    } finally { setOccupato(false); }
  };
  const annulla = async (id: number) => {
    setOccupato(true); setMessaggio(null);
    try {
      await apiFetch(`/api/esercizio/variazioni/${id}/annullamento`, { method: "POST", body: "{}" });
      await carica();
      setMessaggio({ tipo: "ok", testo: "Variazione annullata" });
    } catch (e: any) {
      setMessaggio({ tipo: "errore", testo: e?.message || "Variazione non annullata" });
    } finally { setOccupato(false); }
  };

  const stato = (v: VoceVariazione) => {
    if (v.stato === "annullata") return <span className="text-muted-foreground">annullata{v.annullataDa ? ` da ${v.annullataDa}` : ""}</span>;
    if (v.stato === "applicata") {
      return <span className="text-emerald-300">applicata · {(v.corse ?? 0).toLocaleString("it-IT")} {v.tipo === "sciopero" ? "corse fuori fascia" : "corse soppresse"}</span>;
    }
    return <span className="text-amber-300">in attesa{v.corse != null ? ` · ${v.corse.toLocaleString("it-IT")} corse previste` : ""}</span>;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="w-4 h-4" />Variazioni decise in anticipo</CardTitle>
        <p className="text-xs text-muted-foreground max-w-4xl">
          Soppressioni già note e scioperi, per oggi e i giorni che vengono. Quando la giornata comincia, le soppressioni diventano
          esiti nel giornale a nome di chi le ha scritte (e il GTFS-Realtime le annuncia). Lo sciopero non sopprime niente in
          anticipo: le corse fuori dalle fasce garantite non si presumono fatte e la proposta dall'AVM le dà come soppressioni
          probabili. Si annullano fino all'inizio della giornata; dopo si corregge nel giornale.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {messaggio && (
          <div role="status" className={`text-sm ${messaggio.tipo === "ok" ? "text-emerald-300" : "text-destructive"}`}>{messaggio.testo}</div>
        )}
        {scrive && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (pronta) void scrivi(); }}>
            <div className="space-y-1"><Label htmlFor="variazione-tipo" className="text-xs">Tipo</Label>
              <select id="variazione-tipo" className={`${selectCls} block`} value={tipo} onChange={(e) => setTipo(e.target.value as "soppressione" | "sciopero")}>
                <option value="soppressione">Soppressione</option>
                <option value="sciopero">Sciopero</option>
              </select></div>
            <div className="space-y-1"><Label htmlFor="variazione-giorno" className="text-xs">Giorno</Label>
              <Input id="variazione-giorno" type="date" className="h-8 w-40" value={giorno} onChange={(e) => setGiorno(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="variazione-linee" className="text-xs">{tipo === "sciopero" ? "Linee (vuoto: tutte)" : "Linee"}</Label>
              <Input id="variazione-linee" className="h-8 w-36" value={linee} onChange={(e) => setLinee(e.target.value)} placeholder="1, 2/3, 30" /></div>
            {tipo === "soppressione" ? (
              <>
                <div className="space-y-1"><Label htmlFor="variazione-numeri" className="text-xs">e/o numeri di corsa</Label>
                  <Input id="variazione-numeri" className="h-8 w-36" value={numeri} onChange={(e) => setNumeri(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="variazione-dalle" className="text-xs">Partenze dalle</Label>
                  <Input id="variazione-dalle" type="time" className="h-8 w-28" value={dalle} onChange={(e) => setDalle(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="variazione-alle" className="text-xs">alle (esclusa)</Label>
                  <Input id="variazione-alle" type="time" className="h-8 w-28" value={alle} onChange={(e) => setAlle(e.target.value)} /></div>
              </>
            ) : (
              <div className="space-y-1"><Label htmlFor="variazione-fasce" className="text-xs">Fasce garantite</Label>
                <Input id="variazione-fasce" className="h-8 w-48" value={fasce} onChange={(e) => setFasce(e.target.value)} placeholder="6-9, 12-15"
                  aria-invalid={!!fasce.trim() && !fasceLette} /></div>
            )}
            <div className="space-y-1"><Label htmlFor="variazione-causale" className="text-xs">Causale</Label>
              <select id="variazione-causale" className={`${selectCls} block`} value={causaleScelta} onChange={(e) => setCausale(e.target.value)}>
                <option value="">—</option>
                {causali.map((c) => <option key={c.codice} value={c.codice}>{c.descrizione}</option>)}
              </select></div>
            <div className="space-y-1 grow min-w-[12rem]"><Label htmlFor="variazione-nota" className="text-xs">Nota</Label>
              <Input id="variazione-nota" className="h-8" maxLength={500} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Per esempio: corteo in centro" /></div>
            <Button size="sm" type="submit" disabled={occupato || !pronta}>Scrivi la variazione</Button>
          </form>
        )}
        {voci && voci.length === 0 && <div className="text-muted-foreground">Nessuna variazione per i prossimi 60 giorni.</div>}
        {voci && voci.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr className="text-left">
                <th className="px-3 py-1.5">Giorno</th><th className="px-3 py-1.5">Cosa</th><th className="px-3 py-1.5">Causale</th>
                <th className="px-3 py-1.5">Scritta da</th><th className="px-3 py-1.5">Stato</th><th className="px-3 py-1.5" />
              </tr></thead>
              <tbody>
                {voci.map((v) => (
                  <tr key={v.id} className={`border-t border-border/40 align-top ${v.stato === "annullata" ? "opacity-60" : ""}`}>
                    <td className="px-3 py-1.5 tabular-nums whitespace-nowrap">{new Date(`${v.giorno}T12:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })}</td>
                    <td className="px-3 py-1.5">{descrivi(v)}{v.nota && <div className="text-xs italic text-muted-foreground">«{v.nota}»</div>}</td>
                    <td className="px-3 py-1.5">{v.causaleDescrizione ?? v.causale}</td>
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{v.creataDa ?? "—"}</td>
                    <td className="px-3 py-1.5 text-xs">{stato(v)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {scrive && v.annullabile && (
                        <Button size="sm" variant="ghost" className="h-7" disabled={occupato} onClick={() => void annulla(v.id)}>
                          <Undo2 className="w-3.5 h-3.5 mr-1" />Annulla
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
