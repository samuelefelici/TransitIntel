/**
 * Diagnosi dell'esercizio (Amministrazione, solo admin; tappa 4).
 *
 * Per una giornata di esercizio dice da quale programma e da quale feed
 * vengono le corse, quante se ne collegano alle prove dell'AVM (per id, per
 * codice, per numero di corsa), quali numeri si ripetono, quali corse non
 * hanno geometria e come stanno i turni pubblicati. Sola lettura: serve a
 * decidere la chiave della corsa e che cosa fa fede come programmato, prima
 * di congelare il servizio del giorno.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, Stethoscope } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Esempio { trip?: string; linea?: string | null; partenza?: string | null; numero?: string | null }
interface Diagnosi {
  giorno: string; inizio: string; fine: string;
  programma: { feedId: string; progettoId: string | null; progetto: string | null; file: string | null; via: string | null; attivatoIl: string | null } | null;
  feedAvm: { feedId: string; file: string | null; ugualeAlProgramma: boolean | null } | null;
  corseProgrammate: number;
  numeriRipetuti: { quanti: number; esempi: Array<{ numero: string; corse: number; linee: Array<string | null> }> };
  collegamento: null | {
    corse: number; perId: number; perCodice: number; perNumero: number; almenoUno: number;
    quota: { perId: number | null; perCodice: number | null; perNumero: number | null; almenoUno: number | null };
  };
  viaggiAvm: null | { viaggi: number; agganciati: number; perModo: Record<string, number>; corseConPassaggi: number; nonRiconducibili: number; esempi: Esempio[] };
  geometria: null | { senzaGeometria: number; esempi: Esempio[]; kmGiorno: number; kmAnalisiFeed: number | null };
  turni: { pubblicato: false } | {
    pubblicato: true; udp: number; altroProgramma: number | null; turniGuidaSuperati: number; turniGuidaSuDatiCambiati: number;
    turniMacchinaSuperati: number; corseFuoriDalleUdp: number; esempi: Esempio[];
  };
  avvisi: string[];
}

/** La giornata di ieri, nell'ora italiana: la più recente con tutte le prove arrivate. */
function ieri(): string {
  const d = new Date(Date.now() - 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const numero = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("it-IT"));
const quota = (q: number | null | undefined) => (q == null ? "" : ` (${q.toLocaleString("it-IT")}%)`);
const ora = (ts: string | null | undefined) => (ts ? new Date(ts).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

function Riga({ etichetta, valore, nota }: { etichetta: string; valore: React.ReactNode; nota?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{etichetta}</span>
      <span className="text-sm font-medium tabular-nums text-right">{valore}{nota && <span className="block text-xs font-normal text-muted-foreground">{nota}</span>}</span>
    </div>
  );
}

function Esempi({ titolo, righe }: { titolo: string; righe: Esempio[] }) {
  if (!righe.length) return null;
  return (
    <div className="mt-2">
      <div className="text-xs text-muted-foreground mb-1">{titolo}</div>
      <ul className="text-xs font-mono space-y-0.5">
        {righe.map((e, i) => (
          <li key={i} className="truncate">{[e.linea && `linea ${e.linea}`, e.partenza, e.numero && `n. ${e.numero}`, e.trip].filter(Boolean).join(" · ")}</li>
        ))}
      </ul>
    </div>
  );
}

export default function AdminEsercizioPage() {
  const [giorno, setGiorno] = useState(ieri);
  const [d, setD] = useState<Diagnosi | null>(null);
  const [caricamento, setCaricamento] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const carica = useCallback(async (g: string) => {
    setCaricamento(true);
    setErrore(null);
    try {
      setD(await apiFetch<Diagnosi>(`/api/admin/esercizio/diagnosi?giorno=${encodeURIComponent(g)}`));
    } catch (e: any) {
      setErrore(e?.message || "Diagnosi non riuscita");
      setD(null);
    } finally {
      setCaricamento(false);
    }
  }, []);
  useEffect(() => { void carica(ieri()); }, [carica]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <Stethoscope className="w-6 h-6 text-primary mt-0.5" />
        <div>
          <h1 className="text-xl font-semibold">Diagnosi dell'esercizio</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Per una giornata: da quale programma vengono le corse, quante se ne riconoscono nelle prove dell'AVM e come,
            e come stanno i turni pubblicati. Serve a decidere la chiave della corsa e che cosa fa fede come programmato,
            prima di congelare il servizio del giorno. Non cambia niente.
          </p>
        </div>
      </div>

      <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); void carica(giorno); }}>
        <div className="space-y-1">
          <Label htmlFor="diagnosi-giorno">Giornata di esercizio</Label>
          <Input id="diagnosi-giorno" type="date" value={giorno} onChange={(e) => setGiorno(e.target.value)} className="w-44" />
        </div>
        <Button type="submit" disabled={caricamento || !giorno}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${caricamento ? "animate-spin" : ""}`} /> Analizza
        </Button>
        {d && <span className="text-xs text-muted-foreground pb-2">dalle {ora(d.inizio)} alle {ora(d.fine)}</span>}
      </form>

      {errore && <div className="text-sm text-destructive">{errore}</div>}

      {d && (
        <>
          {d.avvisi.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1">
              {d.avvisi.map((a, i) => (
                <div key={i} className="flex gap-2 text-sm text-amber-200"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{a}</div>
              ))}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Programma della giornata</CardTitle></CardHeader>
              <CardContent>
                <Riga etichetta="Programma in esercizio all'inizio" valore={d.programma?.progetto ?? (d.programma ? "senza progetto (GTFS caricato)" : "nessuno nello storico")} />
                <Riga etichetta="Feed" valore={d.programma?.file ?? "—"} nota={d.programma ? `in esercizio dal ${ora(d.programma.attivatoIl)}` : undefined} />
                <Riga etichetta="Feed su cui aggancia l'AVM oggi" valore={d.feedAvm?.file ?? "—"}
                  nota={d.feedAvm?.ugualeAlProgramma == null ? undefined : d.feedAvm.ugualeAlProgramma ? "lo stesso" : "un altro feed"} />
                <Riga etichetta="Corse programmate" valore={numero(d.corseProgrammate)} />
                <Riga etichetta="Numeri di corsa ripetuti nel giorno" valore={numero(d.numeriRipetuti.quanti)}
                  nota={d.numeriRipetuti.esempi.length ? d.numeriRipetuti.esempi.map((e) => `${e.numero} × ${e.corse}`).join(", ") : undefined} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Collegamento con l'AVM</CardTitle></CardHeader>
              <CardContent>
                {d.collegamento ? (
                  <>
                    <Riga etichetta="Corse riconosciute per id" valore={`${numero(d.collegamento.perId)}${quota(d.collegamento.quota.perId)}`} />
                    <Riga etichetta="per codice stabile" valore={`${numero(d.collegamento.perCodice)}${quota(d.collegamento.quota.perCodice)}`} />
                    <Riga etichetta="per numero di corsa (unico nel giorno)" valore={`${numero(d.collegamento.perNumero)}${quota(d.collegamento.quota.perNumero)}`} />
                    <Riga etichetta="in almeno un modo" valore={`${numero(d.collegamento.almenoUno)}${quota(d.collegamento.quota.almenoUno)}`} />
                  </>
                ) : <div className="text-sm text-muted-foreground">Le tabelle dell'AVM non ci sono.</div>}
                {d.viaggiAvm && (
                  <>
                    <Riga etichetta="Viaggi dichiarati dall'AVM" valore={numero(d.viaggiAvm.viaggi)}
                      nota={`${numero(d.viaggiAvm.agganciati)} agganciati${Object.keys(d.viaggiAvm.perModo).length ? ` (${Object.entries(d.viaggiAvm.perModo).map(([k, n]) => `${k}: ${n}`).join(", ")})` : ""}`} />
                    <Riga etichetta="Corse con passaggi alle fermate" valore={numero(d.viaggiAvm.corseConPassaggi)} />
                    <Riga etichetta="Viaggi che non si riconducono al programma" valore={numero(d.viaggiAvm.nonRiconducibili)} />
                    <Esempi titolo="Per esempio" righe={d.viaggiAvm.esempi} />
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Geometria e km</CardTitle></CardHeader>
              <CardContent>
                {d.geometria ? (
                  <>
                    <Riga etichetta="Km del giorno dalla geometria" valore={numero(d.geometria.kmGiorno)} />
                    <Riga etichetta="Km del giorno nell'analisi del feed" valore={numero(d.geometria.kmAnalisiFeed)} />
                    <Riga etichetta="Corse senza geometria" valore={numero(d.geometria.senzaGeometria)} />
                    <Esempi titolo="Per esempio" righe={d.geometria.esempi} />
                  </>
                ) : <div className="text-sm text-muted-foreground">Nessun feed per questa giornata.</div>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Turni pubblicati</CardTitle></CardHeader>
              <CardContent>
                {d.turni.pubblicato ? (
                  <>
                    <Riga etichetta="UDP pubblicate" valore={numero(d.turni.udp)} />
                    <Riga etichetta="di un altro programma" valore={numero(d.turni.altroProgramma)} />
                    <Riga etichetta="Turni guida con una versione più nuova" valore={numero(d.turni.turniGuidaSuperati)} />
                    <Riga etichetta="Turni guida su dati poi cambiati" valore={numero(d.turni.turniGuidaSuDatiCambiati)} />
                    <Riga etichetta="Turni macchina con una versione più nuova" valore={numero(d.turni.turniMacchinaSuperati)} />
                    <Riga etichetta="Corse fuori dalle UDP pubblicate" valore={numero(d.turni.corseFuoriDalleUdp)} />
                    <Esempi titolo="Per esempio" righe={d.turni.esempi} />
                  </>
                ) : <div className="text-sm text-muted-foreground">Giornata non pubblicata nel roster.</div>}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
