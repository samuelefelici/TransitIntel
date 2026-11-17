/**
 * I dati aperti (tappa 6.3), nella pagina Amministrazione › Azienda: il GTFS
 * e il NeTEx pubblicati a un indirizzo stabile, da registrare al NAP. Si
 * accende e si spegne da qui; i file li prepara il lavoratore dalla versione
 * in esercizio, e «Prepara adesso» li rifà subito.
 * API: /api/admin/dati-aperti. I conti in lib/dati-aperti.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Copy, Globe, RefreshCw } from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  contenuto, DETTAGLIO_FILE, dimensione, erroriDelTentativo, indirizzo, NOME_FILE, quando, riassunto,
  type StatoDatiAperti, type StatoFile, type Tono,
} from "@/lib/dati-aperti";

const TONI: Record<Tono, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  attenzione: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  fermo: "border-border bg-muted text-muted-foreground",
};

const origine = () => getApiBase() || window.location.origin;

export default function DatiAperti() {
  const { toast } = useToast();
  const [stato, setStato] = useState<StatoDatiAperti | null>(null);
  const [busy, setBusy] = useState<null | "interruttore" | "preparazione">(null);

  const carica = useCallback(async () => {
    try { setStato(await apiFetch<StatoDatiAperti>("/api/admin/dati-aperti")); }
    catch (e: any) { toast({ title: "Dati aperti non letti", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const prepara = async (): Promise<boolean> => {
    setBusy("preparazione");
    try {
      const r = await apiFetch<StatoDatiAperti & { preparazione: Record<string, string> }>("/api/admin/dati-aperti/prepara", { method: "POST" });
      setStato(r);
      const usciti = Object.values(r.preparazione).filter((e) => e === "pubblicato").length;
      const tutti = Object.keys(r.preparazione).length;
      toast(usciti === tutti
        ? { title: "File preparati", description: "Il GTFS e il NeTEx in linea sono quelli della versione in esercizio." }
        : { title: usciti === 0 ? "Nessun file è uscito" : "È uscito un file su due", description: "Il motivo è scritto accanto a ogni file.", variant: "destructive" });
      return true;
    } catch (e: any) {
      toast({ title: "Preparazione non riuscita", description: e?.message, variant: "destructive" });
      await carica();
      return false;
    } finally { setBusy(null); }
  };

  const accendiOSpegni = async (attivi: boolean) => {
    const domanda = attivi
      ? "Accendo la pubblicazione? Da quel momento chiunque abbia l'indirizzo scarica il GTFS e il NeTEx della versione in esercizio, senza login."
      : "Spengo la pubblicazione? I due indirizzi risponderanno «non trovato» finché non la riaccendi: chi scarica ogni giorno, come il NAP, non troverà i file.";
    if (!window.confirm(domanda)) return;
    setBusy("interruttore");
    try {
      setStato(await apiFetch<StatoDatiAperti>("/api/admin/dati-aperti", { method: "PUT", body: JSON.stringify({ attivi }) }));
      toast({ title: attivi ? "Pubblicazione accesa" : "Pubblicazione spenta" });
    } catch (e: any) {
      toast({ title: "Non riuscito", description: e?.message, variant: "destructive" });
      setBusy(null);
      return;
    }
    setBusy(null);
    if (attivi) await prepara();
  };

  const copia = async (testo: string) => {
    try { await navigator.clipboard.writeText(testo); toast({ title: "Indirizzo copiato" }); }
    catch { toast({ title: "Copia non riuscita", description: "Seleziona l'indirizzo e copialo a mano.", variant: "destructive" }); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <Globe className="w-4 h-4 text-primary" aria-hidden /> Dati aperti: gli indirizzi per il NAP
          {stato && (
            <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONI[stato.attivi ? "ok" : "fermo"]}`}>
              {stato.attivi ? "Pubblicazione accesa" : "Pubblicazione spenta"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Due indirizzi che non cambiano, senza login, da registrare al NAP: chi li scarica riceve sempre la versione in esercizio, mai una bozza.
          I file si rifanno da soli entro dieci minuti da una nuova messa in esercizio.
        </p>

        {!stato ? <p className="text-sm text-muted-foreground">Carico i dati aperti…</p> : (
          <>
            {!stato.aziendaCompilata && (
              <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                Prima compila e salva i dati dell'azienda qui sopra: i file pubblicati portano il suo nome.
              </div>
            )}
            <p className="text-sm">
              <span className="text-muted-foreground">Programma in esercizio: </span>
              {stato.versione
                ? <><span className="font-medium">{stato.versione.nome}</span>{stato.versione.dal ? <span className="text-muted-foreground">, dal {quando(stato.versione.dal)}</span> : null}</>
                : <span className="text-amber-700 dark:text-amber-300">{stato.senzaVersione}</span>}
            </p>

            <div className="grid gap-3 lg:grid-cols-2">
              {stato.file.map((f) => <UnFile key={f.tipo} f={f} attivi={stato.attivi} onCopia={copia} />)}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {stato.attivi ? (
                <>
                  <Button variant="outline" onClick={() => void prepara()} disabled={busy !== null}>
                    <RefreshCw className={`w-4 h-4 mr-1.5 ${busy === "preparazione" ? "animate-spin" : ""}`} aria-hidden />
                    {busy === "preparazione" ? "Preparo i file…" : "Prepara adesso"}
                  </Button>
                  <Button variant="ghost" onClick={() => void accendiOSpegni(false)} disabled={busy !== null}>Spegni la pubblicazione</Button>
                </>
              ) : (
                <Button onClick={() => void accendiOSpegni(true)} disabled={busy !== null || !stato.aziendaCompilata}>
                  {busy === "interruttore" ? "Accendo…" : "Accendi la pubblicazione"}
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                {busy === "preparazione"
                  ? "Su un programma intero serve circa mezzo minuto."
                  : stato.attivi
                    ? "«Prepara adesso» di solito non serve: rifà i file senza aspettare il giro automatico."
                    : "Finché è spenta i due indirizzi rispondono «non trovato»."}
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UnFile({ f, attivi, onCopia }: { f: StatoFile; attivi: boolean; onCopia: (testo: string) => void }) {
  const url = indirizzo(origine(), f.percorso);
  const r = riassunto(f);
  const dentro = contenuto(f);
  /* senza una versione in esercizio il motivo è già scritto sopra, una volta per tutti e due */
  const nonUscito = f.ultimoTentativo && !["pubblicato", "senza_versione"].includes(f.ultimoTentativo.esito) ? f.ultimoTentativo : null;
  const errori = erroriDelTentativo(f);
  return (
    <section aria-label={NOME_FILE[f.tipo]} className="rounded-lg border border-border p-3 space-y-2 min-w-0">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{NOME_FILE[f.tipo]}</h3>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${TONI[attivi ? r.tono : "fermo"]}`}>
            {attivi ? r.testo : f.inLinea ? "Pronto, ma la pubblicazione è spenta" : r.testo}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{DETTAGLIO_FILE[f.tipo]}</p>
      </div>
      <div className="flex items-start gap-2">
        <code id={`dati-aperti-indirizzo-${f.tipo}`} className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-xs">{url}</code>
        <Button variant="outline" size="sm" onClick={() => onCopia(url)} aria-label={`Copia l'indirizzo del ${NOME_FILE[f.tipo]}`}>
          <Copy className="w-3.5 h-3.5 mr-1" aria-hidden /> Copia
        </Button>
      </div>
      {f.inLinea && (
        <p className="text-xs text-muted-foreground">
          {dimensione(f.inLinea.byte)}, preparato il {quando(f.inLinea.preparatoIl)}
          {dentro.length > 0 ? ` · ${dentro.join(", ")}` : ""}
          <span className="block">Impronta SHA-256: <span className="font-mono">{f.inLinea.impronta.slice(0, 16)}…</span></span>
        </p>
      )}
      {nonUscito && (
        <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <p>{nonUscito.messaggio ?? "L'ultimo tentativo non è uscito."}</p>
          {errori.length > 0 && (
            <ul className="mt-1 list-disc pl-4 font-mono break-words">
              {errori.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
          {nonUscito.provatoIl && <p className="mt-1 text-muted-foreground">Provato il {quando(nonUscito.provatoIl)}.</p>}
        </div>
      )}
    </section>
  );
}
