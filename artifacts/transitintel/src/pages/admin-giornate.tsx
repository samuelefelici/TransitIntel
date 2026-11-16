/**
 * Giornate di esercizio (Amministrazione, solo admin; tappa 4.2): il
 * programmato congelato di ogni giornata.
 *
 * Il lavoratore prepara la giornata di domani e la congela all'inizio della
 * giornata (le 03:00): da lì il suo programmato non cambia più. Qui si
 * leggono le giornate e le loro corse, e si può preparare una giornata che
 * manca (una passata nasce congelata e «ricostruita» dallo storico).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, Lock, RefreshCw, Snowflake } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface VoceGiornata {
  giorno: string; stato: "preparata" | "congelata"; programma: string | null; feed: string | null;
  ricostruita: boolean; corse: number; kmProg: number; avvisi: number; preparataIl: string; congelataIl: string | null;
}
interface Corsa {
  chiave: string; codice: string | null; numero: string; linea: string | null; variante: string | null; direzione: number | null;
  partenza: string | null; arrivo: string | null; fermataDa: string | null; fermataA: string | null; kmProg: number | null; aChiamata: boolean;
}
interface Giornata extends Omit<VoceGiornata, "avvisi"> {
  progettoId: string | null; feedId: string | null; avvisi: string[]; inizio: string; fine: string; elenco: Corsa[];
}

const quando = (ts: string | null) => (ts ? new Date(ts).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const data = (g: string) => new Date(`${g}T12:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const km = (n: number | null) => (n == null ? "—" : n.toLocaleString("it-IT", { maximumFractionDigits: 1 }));
const ora = (t: string | null) => (t ? t.slice(0, 5) : "—");

function Stato({ g }: { g: Pick<VoceGiornata, "stato" | "ricostruita"> }) {
  return g.stato === "congelata"
    ? <span className="inline-flex items-center gap-1 text-xs text-sky-300"><Snowflake className="w-3 h-3" />congelata{g.ricostruita ? " · ricostruita" : ""}</span>
    : <span className="inline-flex items-center gap-1 text-xs text-amber-300"><RefreshCw className="w-3 h-3" />preparata</span>;
}

export default function AdminGiornatePage() {
  const [elenco, setElenco] = useState<VoceGiornata[]>([]);
  const [scelta, setScelta] = useState<string | null>(null);
  const [giornata, setGiornata] = useState<Giornata | null>(null);
  const [daAprire, setDaAprire] = useState("");
  /* la giornata chiesta che non è ancora preparata */
  const [mancante, setMancante] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [occupato, setOccupato] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const caricaElenco = useCallback(async () => {
    try {
      const r = await apiFetch<{ giornate: VoceGiornata[] }>("/api/admin/esercizio/giornate");
      setElenco(r.giornate);
      return r.giornate;
    } catch (e: any) { setErrore(e?.message || "Giornate non leggibili"); return []; }
  }, []);
  const apri = useCallback(async (g: string) => {
    setScelta(g); setErrore(null); setMancante(null); setOccupato(true);
    try { setGiornata(await apiFetch<Giornata>(`/api/admin/esercizio/giornate/${g}`)); }
    catch (e: any) {
      setGiornata(null);
      if (e?.status === 404 || /non ancora preparata/i.test(String(e?.message ?? ""))) setMancante(g);
      else setErrore(e?.message || "Giornata non leggibile");
    }
    finally { setOccupato(false); }
  }, []);
  useEffect(() => { void caricaElenco().then((l) => { if (l[0]) void apri(l.find((x) => x.stato === "congelata")?.giorno ?? l[0].giorno); }); }, [caricaElenco, apri]);

  const prepara = async (g: string) => {
    setErrore(null); setOccupato(true);
    try {
      await apiFetch(`/api/admin/esercizio/giornate/${g}/prepara`, { method: "POST" });
      await caricaElenco();
      await apri(g);
    } catch (e: any) { setErrore(e?.message || "Preparazione non riuscita"); }
    finally { setOccupato(false); }
  };

  const corse = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    const l = giornata?.elenco ?? [];
    return f ? l.filter((c) => [c.linea, c.numero, c.codice, c.fermataDa, c.fermataA].some((x) => (x ?? "").toLowerCase().includes(f))) : l;
  }, [giornata, filtro]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <CalendarDays className="w-6 h-6 text-primary mt-0.5" />
        <div>
          <h1 className="text-xl font-semibold">Giornate di esercizio</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Il programmato di ogni giornata, dal programma in esercizio alle 03:00 (storico delle attivazioni). Il lavoratore
            prepara la giornata di domani e la congela quando comincia: da lì non cambia più, nemmeno se il programma viene
            rimesso in esercizio o duplicato. Una giornata passata preparata dopo nasce congelata e «ricostruita».
          </p>
        </div>
      </div>

      <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (daAprire) void apri(daAprire); }}>
        <div className="space-y-1">
          <Label htmlFor="giornata-da-aprire">Giornata</Label>
          <Input id="giornata-da-aprire" type="date" value={daAprire} onChange={(e) => setDaAprire(e.target.value)} className="w-44" />
        </div>
        <Button type="submit" variant="outline" disabled={occupato || !daAprire}>Apri</Button>
      </form>

      {errore && <div className="text-sm text-destructive">{errore}</div>}
      {mancante && (
        <div className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
          <span className="capitalize">{data(mancante)}</span>
          <span className="text-muted-foreground">non è ancora preparata.</span>
          <Button size="sm" onClick={() => void prepara(mancante)} disabled={occupato}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${occupato ? "animate-spin" : ""}`} /> Prepara
          </Button>
          <span className="text-xs text-muted-foreground">Una giornata passata nasce congelata e ricostruita dallo storico.</span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Ultimi 30 giorni e domani</CardTitle></CardHeader>
          <CardContent className="p-0">
            {elenco.length === 0 && <div className="px-4 pb-4 text-sm text-muted-foreground">Nessuna giornata preparata: le prepara il lavoratore.</div>}
            <ul className="max-h-[560px] overflow-y-auto">
              {elenco.map((g) => (
                <li key={g.giorno}>
                  <button type="button" onClick={() => void apri(g.giorno)}
                    className={`w-full text-left px-4 py-2 border-t border-border/50 hover:bg-muted/40 ${scelta === g.giorno ? "bg-muted/60" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium capitalize">{data(g.giorno)}</span>
                      <Stato g={g} />
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {g.corse.toLocaleString("it-IT")} corse · {km(g.kmProg)} km{g.avvisi ? ` · ${g.avvisi} avvisi` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          {giornata && (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2 capitalize">
                    {data(giornata.giorno)} <Stato g={giornata} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Programma: </span>{giornata.programma ?? "nessuno nello storico"}</div>
                  <div><span className="text-muted-foreground">Feed: </span>{giornata.feed ?? "—"}</div>
                  <div><span className="text-muted-foreground">Dalle </span>{quando(giornata.inizio)}<span className="text-muted-foreground"> alle </span>{quando(giornata.fine)}</div>
                  <div className="tabular-nums"><span className="text-muted-foreground">Corse: </span>{giornata.corse.toLocaleString("it-IT")} · {km(giornata.kmProg)} km</div>
                  <div><span className="text-muted-foreground">Preparata: </span>{quando(giornata.preparataIl)}</div>
                  <div className="flex items-center gap-1">
                    {giornata.congelataIl ? <><Lock className="w-3 h-3 text-sky-300" /><span className="text-muted-foreground">Congelata: </span>{quando(giornata.congelataIl)}</> : <span className="text-muted-foreground">Si congela all'inizio della giornata</span>}
                  </div>
                  {giornata.avvisi.length > 0 && (
                    <div className="sm:col-span-2 mt-2 space-y-1">
                      {giornata.avvisi.map((a, i) => <div key={i} className="flex gap-2 text-amber-200"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{a}</div>)}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
                  <CardTitle className="text-base">Corse</CardTitle>
                  <Input id="giornata-filtro" placeholder="Linea, numero, codice, capolinea" value={filtro} onChange={(e) => setFiltro(e.target.value)} className="h-8 w-64" />
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                        <tr className="text-left">
                          <th className="px-3 py-2">Linea</th><th className="px-3 py-2">N.</th><th className="px-3 py-2">Parte</th><th className="px-3 py-2">Arriva</th>
                          <th className="px-3 py-2">Da</th><th className="px-3 py-2">A</th><th className="px-3 py-2 text-right">Km</th><th className="px-3 py-2">Codice</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {corse.slice(0, 1000).map((c) => (
                          <tr key={c.chiave} className="border-t border-border/40">
                            <td className="px-3 py-1.5 font-medium">{c.linea ?? "—"}{c.aChiamata && <span className="ml-1 text-xs text-amber-300">a chiamata</span>}</td>
                            <td className="px-3 py-1.5">{c.numero}</td>
                            <td className="px-3 py-1.5">{ora(c.partenza)}</td>
                            <td className="px-3 py-1.5">{ora(c.arrivo)}</td>
                            <td className="px-3 py-1.5 max-w-[180px] truncate">{c.fermataDa ?? "—"}</td>
                            <td className="px-3 py-1.5 max-w-[180px] truncate">{c.fermataA ?? "—"}</td>
                            <td className="px-3 py-1.5 text-right">{km(c.kmProg)}</td>
                            <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground max-w-[220px] truncate">{c.codice ?? c.chiave}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {corse.length > 1000 && <div className="px-3 py-2 text-xs text-muted-foreground">Le prime 1.000 di {corse.length.toLocaleString("it-IT")}: filtra per vedere le altre.</div>}
                  {corse.length === 0 && <div className="px-3 py-3 text-sm text-muted-foreground">Nessuna corsa.</div>}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
