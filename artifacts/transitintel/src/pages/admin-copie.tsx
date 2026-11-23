/**
 * Copie del database (Amministrazione, solo admin; tappa 7.23).
 *
 * Ogni notte il lavoratore fa una copia del database, la cifra con la chiave
 * pubblica dell'azienda, la carica nello storage fuori dal server e la
 * riscarica per controllarla. Qui gli esiti e il pulsante per farne una
 * adesso (la prende il lavoratore entro un minuto). Come si imposta e come si
 * ripristina: DEPLOY.md, «Copia del database fuori dal server».
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, DatabaseBackup, Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { etaCopia, ETICHETTE_STATO, megabyte, statoCopie, type Copia } from "@/lib/copie-database";

export default function AdminCopiePage() {
  const { toast } = useToast();
  const [copie, setCopie] = useState<Copia[] | null>(null);
  const [ultima, setUltima] = useState<Copia | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [chiedendo, setChiedendo] = useState(false);

  const leggi = useCallback(async () => {
    try {
      const r = await apiFetch<{ copie: Copia[]; ultimaRiuscita: Copia | null }>("/api/admin/copie");
      setCopie(r.copie);
      setUltima(r.ultimaRiuscita);
      setErrore(null);
    } catch (e: any) {
      setErrore(e?.message ?? "Copie non lette");
    }
  }, []);

  useEffect(() => { void leggi(); }, [leggi]);
  // mentre una copia è chiesta o in corso, si rilegge ogni 15 secondi
  const attesa = copie?.some(c => c.stato === "chiesta" || c.stato === "in_corso") ?? false;
  useEffect(() => {
    if (!attesa) return;
    const t = setInterval(() => { void leggi(); }, 15_000);
    return () => clearInterval(t);
  }, [attesa, leggi]);

  const chiedi = async () => {
    setChiedendo(true);
    try {
      await apiFetch("/api/admin/copie", { method: "POST", body: "{}" });
      toast({ title: "Copia chiesta", description: "Il lavoratore la comincia entro un minuto." });
      await leggi();
    } catch (e: any) {
      toast({ title: "Copia non chiesta", description: e?.message, variant: "destructive" });
    } finally {
      setChiedendo(false);
    }
  };

  const stato = statoCopie(ultima, new Date());

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <DatabaseBackup className="w-6 h-6 text-primary" aria-hidden /> Copie del database
        </h1>
        <p className="text-sm text-muted-foreground">
          Ogni notte una copia cifrata del database va nello storage fuori dal server, e si controlla riscaricandola.
          Il server ha solo la chiave pubblica: per leggerla serve la chiave privata, che resta all'azienda.
        </p>
      </div>

      {errore && <p className="text-sm text-destructive" role="alert">{errore}</p>}

      <Card className={stato.livello === "bene" ? "" : "border-amber-500/60"}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            {stato.livello === "bene"
              ? <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden />
              : <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden />}
            {stato.titolo}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">{stato.dettaglio}</p>
          {ultima && (
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-1 tabular-nums">
              <div><dt className="text-xs text-muted-foreground">Ultima riuscita</dt><dd>{etaCopia(ultima.finitaIl ?? ultima.creataIl, new Date())}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Dimensione cifrata</dt><dd>{megabyte(ultima.byte)}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Tabelle con dati</dt><dd>{ultima.tabelle ?? "—"}</dd></div>
              <div className="sm:col-span-3 min-w-0"><dt className="text-xs text-muted-foreground">Nello storage</dt>
                <dd className="font-mono text-xs break-all">{ultima.oggetto}</dd></div>
            </dl>
          )}
          <div className="flex flex-wrap gap-2">
            <Button id="copia-adesso" onClick={chiedi} disabled={chiedendo || attesa}>
              {chiedendo || attesa ? <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden /> : <DatabaseBackup className="w-4 h-4 mr-2" aria-hidden />}
              {attesa ? "Copia in corso…" : "Fai una copia adesso"}
            </Button>
            <Button id="copie-aggiorna" variant="outline" onClick={() => void leggi()}>
              <RefreshCw className="w-4 h-4 mr-2" aria-hidden /> Aggiorna
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Ultime copie</CardTitle></CardHeader>
        <CardContent>
          {copie == null ? (
            <p className="text-sm text-muted-foreground">Caricamento…</p>
          ) : copie.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna copia ancora.</p>
          ) : (
            <ul className="divide-y">
              {copie.map(c => (
                <li key={c.id} className="py-2 text-sm flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
                  <span className={`shrink-0 inline-flex w-fit items-center rounded px-2 py-0.5 text-xs font-medium ${ETICHETTE_STATO[c.stato].classe}`}>
                    {ETICHETTE_STATO[c.stato].testo}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {new Date(c.creataIl).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                  <span className="min-w-0 break-words">
                    {c.chiestaDa ? `chiesta da ${c.chiestaDa}` : "della notte"}
                    {c.stato === "riuscita" && ` · ${megabyte(c.byte)} · ${c.tabelle ?? "?"} tabelle`}
                    {c.errore && <span className="block text-destructive">{c.errore}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
