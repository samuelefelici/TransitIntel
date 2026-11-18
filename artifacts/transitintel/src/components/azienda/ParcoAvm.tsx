/**
 * Il parco dell'azienda nel canale dell'AVM (tappa 6.21), nella pagina
 * Amministrazione › Azienda: i prefissi SIRI delle consorziate, le eccezioni
 * e l'anagrafica dei mezzi importata dall'export dell'officina. Li usano il
 * diario AVM, lo stato del parco, i fogli per l'officina e il report di
 * esercizio. API: /api/admin/parco. I controlli in lib/parco.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Plus, Save, Trash2, Truck, Upload } from "lucide-react";
import { apiFetch, getApiBase } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  datiDaSalvare, erroriConsorziate, esempioDellaRegola, moduloCambiato, moduloDa,
  type ModuloConsorziate, type StatoParco,
} from "@/lib/parco";

/** Il corpo delle richieste all'API arriva al più a 4 MB. */
const MASSIMO_BYTE = 3_500_000;

const quando = (iso: string | null) => iso
  ? new Date(iso).toLocaleString("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
  : null;

export default function ParcoAvm() {
  const { toast } = useToast();
  const [stato, setStato] = useState<StatoParco | null>(null);
  const [modulo, setModulo] = useState<ModuloConsorziate | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [provato, setProvato] = useState(false);
  const scelta = useRef<HTMLInputElement>(null);

  const carica = useCallback(async () => {
    try {
      const s = await apiFetch<StatoParco>("/api/admin/parco");
      setStato(s); setModulo(moduloDa(s)); setErrore(null); setProvato(false);
    } catch (e: any) { setErrore(String(e?.message ?? e)); }
  }, []);
  useEffect(() => { void carica(); }, [carica]);

  const errori = modulo ? erroriConsorziate(modulo) : [];
  const cambiato = !!modulo && !!stato && moduloCambiato(modulo, moduloDa(stato));

  const salva = async () => {
    if (!modulo) return;
    setProvato(true);
    if (errori.length) return;
    setBusy(true);
    try {
      const s = await apiFetch<StatoParco>("/api/admin/parco/consorziate", { method: "PUT", body: JSON.stringify(datiDaSalvare(modulo)) });
      setStato(s); setModulo(moduloDa(s)); setProvato(false);
      toast({ title: "Prefissi ed eccezioni salvati", description: "Le pagine dell'AVM li usano da subito." });
    } catch (e: any) {
      toast({ title: "Non salvati", description: String(e?.message ?? e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const importa = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MASSIMO_BYTE) { toast({ title: "Il file è troppo grande", description: "Al più 3,5 MB.", variant: "destructive" }); return; }
    const testo = await f.text();
    const domanda = stato && stato.vetture > 0
      ? `Sostituire i ${stato.vetture} mezzi dell'anagrafica con quelli di «${f.name}»?`
      : `Importare l'anagrafica da «${f.name}»?`;
    if (!window.confirm(domanda)) return;
    setBusy(true);
    try {
      const r = await apiFetch<StatoParco & { importate: number; doppie: number }>("/api/admin/parco/vetture", { method: "PUT", body: JSON.stringify({ testo }) });
      setStato(r);
      toast({
        title: `Anagrafica importata: ${r.importate} mezzi`,
        description: r.doppie ? `${r.doppie} righe con un codice già visto: è valsa la prima.` : undefined,
      });
    } catch (e: any) {
      toast({ title: "Import non riuscito", description: String(e?.message ?? e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  const riga = (lista: "consorziate" | "eccezioni", i: number, campo: string, valore: string | boolean) =>
    setModulo((m) => (m ? { ...m, [lista]: m[lista].map((x, k) => (k === i ? { ...x, [campo]: valore } : x)) } as ModuloConsorziate : m));
  const togli = (lista: "consorziate" | "eccezioni", i: number) =>
    setModulo((m) => (m ? { ...m, [lista]: m[lista].filter((_, k) => k !== i) } as ModuloConsorziate : m));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Truck className="w-4 h-4 text-primary" aria-hidden /> AVM: le consorziate e l'anagrafica dei mezzi
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {errore && <p role="alert" className="text-sm text-destructive">Non riesco a leggere il parco: {errore}</p>}

        <section className="space-y-2" aria-labelledby="parco-prefissi">
          <h3 id="parco-prefissi" className="text-sm font-medium">Le consorziate nel canale</h3>
          <p className="text-xs text-muted-foreground max-w-2xl">
            Nel canale dell'AVM una vettura di una consorziata ha una matricola di cinque cifre: le prime due dicono l'azienda,
            le altre tre sono il progressivo del codice del mezzo (11096 → CJ096). Se un prefisso vale per due sigle, decide
            l'anagrafica. Un prefisso che non segue il progressivo si abbina solo con le eccezioni.
          </p>
          {modulo && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="text-left font-normal py-1 pr-2">Prefisso</th><th className="text-left font-normal py-1 pr-2">Sigle</th>
                    <th className="text-left font-normal py-1 pr-2">Le tre cifre sono il progressivo</th><th className="text-left font-normal py-1 pr-2">Per esempio</th><th /></tr>
                </thead>
                <tbody>
                  {modulo.consorziate.map((c, i) => (
                    <tr key={i} className="border-t border-border/40">
                      <td className="py-1 pr-2"><Input aria-label={`Prefisso, riga ${i + 1}`} value={c.prefisso} maxLength={2} className="h-8 w-16 font-mono" placeholder="11" onChange={(e) => riga("consorziate", i, "prefisso", e.target.value)} /></td>
                      <td className="py-1 pr-2"><Input aria-label={`Sigle, riga ${i + 1}`} value={c.sigle} className="h-8 w-32" placeholder="CJ" onChange={(e) => riga("consorziate", i, "sigle", e.target.value)} /></td>
                      <td className="py-1 pr-2"><input type="checkbox" aria-label={`Progressivo, riga ${i + 1}`} checked={c.aProgressivo} onChange={(e) => riga("consorziate", i, "aProgressivo", e.target.checked)} /></td>
                      <td className="py-1 pr-2 text-xs text-muted-foreground font-mono">{esempioDellaRegola(c)}</td>
                      <td className="py-1"><Button type="button" variant="ghost" size="sm" aria-label={`Togli il prefisso, riga ${i + 1}`} onClick={() => togli("consorziate", i)}><Trash2 className="w-4 h-4" /></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setModulo((m) => (m ? { ...m, consorziate: [...m.consorziate, { prefisso: "", sigle: "", aProgressivo: true }] } : m))}>
                <Plus className="w-4 h-4 mr-1" aria-hidden /> Aggiungi un prefisso
              </Button>
            </div>
          )}
        </section>

        <section className="space-y-2" aria-labelledby="parco-eccezioni">
          <h3 id="parco-eccezioni" className="text-sm font-medium">Le eccezioni</h3>
          <p className="text-xs text-muted-foreground max-w-2xl">Le matricole che non seguono la regola, abbinate una per una al codice del mezzo.</p>
          {modulo && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="text-left font-normal py-1 pr-2">Matricola SIRI</th><th className="text-left font-normal py-1 pr-2">Codice del mezzo</th><th className="text-left font-normal py-1 pr-2">Nota</th><th /></tr>
                </thead>
                <tbody>
                  {modulo.eccezioni.map((x, i) => (
                    <tr key={i} className="border-t border-border/40">
                      <td className="py-1 pr-2"><Input aria-label={`Matricola, riga ${i + 1}`} value={x.siriRef} maxLength={10} className="h-8 w-28 font-mono" placeholder="15004" onChange={(e) => riga("eccezioni", i, "siriRef", e.target.value)} /></td>
                      <td className="py-1 pr-2"><Input aria-label={`Codice, riga ${i + 1}`} value={x.codice} maxLength={20} className="h-8 w-28 font-mono" placeholder="XY052" onChange={(e) => riga("eccezioni", i, "codice", e.target.value)} /></td>
                      <td className="py-1 pr-2"><Input aria-label={`Nota, riga ${i + 1}`} value={x.nota} maxLength={300} className="h-8" placeholder="come è stata abbinata" onChange={(e) => riga("eccezioni", i, "nota", e.target.value)} /></td>
                      <td className="py-1"><Button type="button" variant="ghost" size="sm" aria-label={`Togli l'eccezione, riga ${i + 1}`} onClick={() => togli("eccezioni", i)}><Trash2 className="w-4 h-4" /></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setModulo((m) => (m ? { ...m, eccezioni: [...m.eccezioni, { siriRef: "", codice: "", nota: "" }] } : m))}>
                <Plus className="w-4 h-4 mr-1" aria-hidden /> Aggiungi un'eccezione
              </Button>
            </div>
          )}
        </section>

        {provato && errori.length > 0 && (
          <ul role="alert" className="text-xs text-destructive list-disc pl-5 space-y-0.5">{errori.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void salva()} disabled={busy || !cambiato}>
            <Save className="w-4 h-4 mr-1.5" aria-hidden /> Salva prefissi ed eccezioni
          </Button>
          {cambiato && !busy && stato && <Button variant="ghost" onClick={() => { setModulo(moduloDa(stato)); setProvato(false); }}>Annulla le modifiche</Button>}
        </div>

        <section className="space-y-2 border-t border-border/40 pt-4" aria-labelledby="parco-anagrafica">
          <h3 id="parco-anagrafica" className="text-sm font-medium">L'anagrafica dei mezzi</h3>
          <p className="text-xs text-muted-foreground max-w-2xl">
            L'export dell'officina, un mezzo per riga: il codice e la descrizione, separati da una tabulazione (copiati da un
            foglio di calcolo) o in un CSV. Dà la descrizione accanto alla matricola nel diario AVM e nei fogli per l'officina.
          </p>
          {stato && (
            <p className="text-sm">
              {stato.vetture > 0
                ? <>{stato.vetture} mezzi{quando(stato.importataIl) ? `, importati il ${quando(stato.importataIl)}${stato.importataDa ? ` da ${stato.importataDa}` : ""}` : ""}.</>
                : "Nessun mezzo: le matricole del canale si vedono senza descrizione."}
            </p>
          )}
          {stato && stato.sigleSenzaPrefisso.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Nell'anagrafica ci sono mezzi con sigle che nessun prefisso porta ({stato.sigleSenzaPrefisso.join(", ")}): dal canale non si riconoscono.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input ref={scelta} id="parco-file" type="file" accept=".tsv,.csv,.txt,text/csv,text/tab-separated-values,text/plain" className="hidden"
              onChange={(e) => { void importa(e.target.files?.[0]); e.target.value = ""; }} />
            <Button variant="outline" disabled={busy} onClick={() => scelta.current?.click()}>
              <Upload className="w-4 h-4 mr-1.5" aria-hidden /> Importa l'export
            </Button>
            {stato && stato.vetture > 0 && (
              <Button variant="ghost" asChild>
                <a href={`${getApiBase()}/api/admin/parco/vetture.tsv`}><Download className="w-4 h-4 mr-1.5" aria-hidden /> Scarica l'anagrafica</a>
              </Button>
            )}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
