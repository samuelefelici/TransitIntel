/**
 * Che cosa ha scritto l'azienda e che cosa le manca (tappa 6.18), in cima
 * alla pagina Amministrazione › Azienda: voce per voce, con il collegamento
 * alla sezione dove si scrive e che cosa succede finché manca.
 * API: /api/admin/installazione. I conti in lib/installazione.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ClipboardList, Circle, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { collegamento, ETICHETTE_STATO, riassuntoInstallazione, vociInOrdine, type StatoInstallazione, type Voce } from "@/lib/installazione";

const PAGINA = "/admin/azienda";

function Stato({ v }: { v: Voce }) {
  if (v.stato === "compilata") return <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden />{ETICHETTE_STATO.compilata}</span>;
  if (v.stato === "da_compilare") return <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium"><AlertTriangle className="w-3.5 h-3.5" aria-hidden />{ETICHETTE_STATO.da_compilare}</span>;
  return <span className="inline-flex items-center gap-1 text-muted-foreground"><Circle className="w-3.5 h-3.5" aria-hidden />{ETICHETTE_STATO.facoltativa}</span>;
}

function Dove({ v }: { v: Voce }) {
  const c = collegamento(v, PAGINA);
  if (c.tipo === "sezione") {
    return (
      <a href={`#${c.id}`} className="text-primary hover:underline"
        onClick={(e) => { e.preventDefault(); document.getElementById(c.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
        {v.dove.etichetta}
      </a>
    );
  }
  return <Link href={c.href} className="text-primary hover:underline">{v.dove.etichetta}</Link>;
}

export default function StatoInstallazione() {
  const [stato, setStato] = useState<StatoInstallazione | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [aperte, setAperte] = useState(false);

  const carica = useCallback(async () => {
    setErrore(null);
    try { setStato(await apiFetch<StatoInstallazione>("/api/admin/installazione")); }
    catch (e: any) { setErrore(e?.message ?? "Non letto"); }
  }, []);
  useEffect(() => { void carica(); }, [carica]);

  const voci = stato ? vociInOrdine(stato.voci) : [];
  /* le compilate senza avviso si vedono a richiesta: in cima conta quello che manca */
  const daMostrare = aperte ? voci : voci.filter((v) => v.stato !== "compilata" || v.avviso);
  const nascoste = voci.length - daMostrare.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-primary" aria-hidden /> Che cosa c'è da compilare
          <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => void carica()} aria-label="Ricalcola"><RefreshCw className="w-3.5 h-3.5" /></Button>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          I dati dell'azienda che i calcoli usano, voce per voce: quelli che servono, e quelli facoltativi. Ogni voce porta alla sezione dove si scrive.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {errore && <p className="text-sm text-destructive">{errore}</p>}
        {!stato && !errore && <p className="text-sm text-muted-foreground">Conto le voci…</p>}
        {stato && (
          <>
            <p className="text-sm font-medium">{riassuntoInstallazione(stato)}</p>
            {daMostrare.length > 0 && (
              <ul className="divide-y divide-border/50 rounded-md border border-border/50 text-sm">
                {daMostrare.map((v) => (
                  <li key={v.voce} className="px-3 py-2 space-y-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="font-medium">{v.titolo}</span>
                      <span className="text-xs"><Stato v={v} /></span>
                      <span className="text-xs text-muted-foreground tabular-nums">{v.dettaglio}</span>
                      <span className="ml-auto text-xs"><Dove v={v} /></span>
                    </div>
                    {v.stato !== "compilata" && <p className="text-xs text-muted-foreground">{v.seManca}</p>}
                    {v.avviso && <p className="text-xs text-amber-700 dark:text-amber-400">{v.avviso}</p>}
                  </li>
                ))}
              </ul>
            )}
            {(nascoste > 0 || aperte) && (
              <Button variant="outline" size="sm" onClick={() => setAperte(!aperte)}>
                {aperte ? "Mostra solo quello che manca" : nascoste === 1 ? "Mostra anche la voce compilata" : `Mostra anche le ${nascoste} voci compilate`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
