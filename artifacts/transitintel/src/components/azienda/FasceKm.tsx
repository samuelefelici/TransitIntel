/**
 * Le fasce chilometriche dell'extraurbano (tappa 6.8), nella pagina
 * Amministrazione › Azienda: a ogni fascia di chilometri il suo prezzo. Si
 * scrivono in bozza e si salvano tutte insieme. Di ogni fascia si scrive solo
 * dove finisce e quanto costa: comincia dove finisce quella prima.
 * API: /api/admin/fasce-km. I conti in lib/fasce-km.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Ruler, Save, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  avvisiFasce, bozzaDa, corpoFasce, daDellaRiga, erroriFasce, fasceCambiate, km, riassuntoFasce, rigaNuova,
  type ElencoFasce, type FasciaKm, type RigaFascia,
} from "@/lib/fasce-km";

export default function FasceKm() {
  const { toast } = useToast();
  const [elenco, setElenco] = useState<ElencoFasce | null>(null);
  const [bozza, setBozza] = useState<RigaFascia[]>([]);
  const [busy, setBusy] = useState(false);
  const [provato, setProvato] = useState(false);

  const carica = useCallback(async () => {
    try {
      const e = await apiFetch<ElencoFasce>("/api/admin/fasce-km");
      setElenco(e); setBozza(bozzaDa(e.fasce)); setProvato(false);
    } catch (e: any) { toast({ title: "Fasce non lette", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const salvate = elenco?.fasce ?? [];
  const errori = elenco ? erroriFasce(bozza, elenco.massimoFasce) : [];
  const avvisi = avvisiFasce(bozza);
  const cambiate = elenco ? fasceCambiate(bozza, salvate) : false;
  const cambia = (i: number, parte: Partial<RigaFascia>) => setBozza((b) => b.map((r, j) => (j === i ? { ...r, ...parte } : r)));

  const salva = async () => {
    setProvato(true);
    if (errori.length) return;
    if (bozza.length === 0 && !window.confirm("Tolgo tutte le fasce? Senza, i prezzi dell'extraurbano non si possono calcolare.")) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ fasce: FasciaKm[] }>("/api/admin/fasce-km", { method: "PUT", body: JSON.stringify(corpoFasce(bozza)) });
      setElenco((e) => (e ? { ...e, fasce: r.fasce } : e)); setBozza(bozzaDa(r.fasce)); setProvato(false);
      toast({ title: "Fasce salvate", description: "I prezzi dell'extraurbano si calcolano da subito con queste." });
    } catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Ruler className="w-4 h-4 text-primary" aria-hidden /> Fasce chilometriche</CardTitle>
        <p className="text-xs text-muted-foreground">
          Il prezzo di una corsa extraurbana dipende dalla distanza: a ogni fascia di chilometri il suo prezzo. Oltre l'ultima fascia vale l'ultima.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!elenco ? <div className="text-sm text-muted-foreground">Carico le fasce…</div> : (
          <>
            <p className="text-sm">{riassuntoFasce(salvate)}</p>
            {bozza.length === 0 ? (
              <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                Non c'è nessuna fascia. Aggiungi la prima: parte da 0 km.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5 w-16">Fascia</th><th className="px-2 py-1.5">Da (km)</th><th className="px-2 py-1.5">A (km)</th>
                    <th className="px-2 py-1.5">Prezzo (€)</th><th className="px-2 py-1.5 w-10" />
                  </tr></thead>
                  <tbody>
                    {bozza.map((r, i) => {
                      const da = daDellaRiga(bozza, i);
                      return (
                        <tr key={i} className="border-t border-border/40">
                          <td className="px-3 py-1 tabular-nums text-muted-foreground">{i + 1}</td>
                          <td className="px-2 py-1 tabular-nums text-muted-foreground">{Number.isNaN(da) ? "—" : `più di ${km(da)}`}</td>
                          <td className="px-2 py-1">
                            <Label htmlFor={`fascia-${i}-a`} className="sr-only">Fascia {i + 1}: fino a quanti chilometri</Label>
                            <Input id={`fascia-${i}-a`} value={r.a} className="h-8 w-24 tabular-nums" inputMode="decimal" maxLength={7}
                              onChange={(e) => cambia(i, { a: e.target.value })} />
                          </td>
                          <td className="px-2 py-1">
                            <Label htmlFor={`fascia-${i}-prezzo`} className="sr-only">Fascia {i + 1}: prezzo in euro</Label>
                            <Input id={`fascia-${i}-prezzo`} value={r.prezzo} className="h-8 w-24 tabular-nums" inputMode="decimal" maxLength={7}
                              onChange={(e) => cambia(i, { prezzo: e.target.value })} />
                          </td>
                          <td className="px-2 py-1 text-right">
                            <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5 text-destructive" aria-label={`Togli la fascia ${i + 1}`}
                              title="Togli questa fascia: quella dopo comincerà dove finisce quella prima"
                              onClick={() => setBozza((b) => b.filter((_, j) => j !== i))}><X className="w-3.5 h-3.5" /></Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy || bozza.length >= elenco.massimoFasce}
                onClick={() => setBozza((b) => [...b, rigaNuova(b)])}><Plus className="w-4 h-4 mr-1.5" />Aggiungi una fascia</Button>
              <Button type="button" size="sm" disabled={busy || !cambiate} onClick={() => void salva()}><Save className="w-3.5 h-3.5 mr-1" />Salva le fasce</Button>
              {cambiate && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setBozza(bozzaDa(salvate)); setProvato(false); }}>Annulla le modifiche</Button>
              )}
              <p className="text-xs text-muted-foreground">
                {cambiate ? "Le fasce in vigore sono ancora quelle salvate." : "Queste sono le fasce in vigore."}
              </p>
            </div>
            {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
            {avvisi.length > 0 && (
              <ul role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                {avvisi.map((x) => <li key={x}>{x}</li>)}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Cambiano i prezzi calcolati da qui in avanti. I titoli di viaggio già creati in un feed tengono il loro prezzo (si cambia dalla pagina Tariffe), e le zone già generate restano come sono finché non si rigenerano.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
