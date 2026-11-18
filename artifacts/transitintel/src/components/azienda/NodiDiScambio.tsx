/**
 * I nodi di scambio (tappa 6.16), nella pagina Amministrazione › Azienda:
 * stazioni, porti, aeroporti e parcheggi scambiatori, con gli orari stimati.
 * Li usano l'analisi intermodale, le zone di coincidenza, l'ottimizzatore
 * delle coincidenze e il confronto fra programmi.
 * API: /api/admin/nodi-scambio. I conti in lib/nodi-scambio.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { coordinate } from "@/lib/territorio";
import {
  corpoNodo, corseStimate, domandaTogli, erroriNodo, moduloDa, moduloVuoto, nomeDelTipo, TIPI_NODO,
  type ElencoNodi, type ModuloNodo, type NodoConZone, type TipoNodo,
} from "@/lib/nodi-scambio";

function ModuloNodoForm(p: {
  iniziale: ModuloNodo; nuovo?: boolean; gia: string[]; busy: boolean;
  onSalva: (m: ModuloNodo) => Promise<void>; onAnnulla: () => void;
}) {
  const [m, setM] = useState<ModuloNodo>(p.iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriNodo(m, !!p.nuovo, p.gia);
  const id = (campo: string) => `nodo-${p.nuovo ? "nuovo" : p.iniziale.nodo}-${campo}`;
  const casella = (campo: keyof ModuloNodo, etichetta: string, esempio: string, extra: Record<string, unknown> = {}) => (
    <div>
      <Label htmlFor={id(campo)} className="text-xs">{etichetta}</Label>
      <Input id={id(campo)} value={m[campo]} placeholder={esempio} className="h-8" onChange={(e) => setM({ ...m, [campo]: e.target.value })} {...extra} />
    </div>
  );
  const orari = (campo: "arrivi" | "partenze", etichetta: string, esempio: string) => (
    <div>
      <Label htmlFor={id(campo)} className="text-xs">{etichetta}</Label>
      <textarea id={id(campo)} value={m[campo]} placeholder={esempio} rows={4}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onChange={(e) => setM({ ...m, [campo]: e.target.value })} />
    </div>
  );
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (errori.length === 0) void p.onSalva(m); }}>
      <div className="grid gap-2 sm:grid-cols-4">
        {p.nuovo
          ? casella("nodo", "Identificativo", "stazione-centrale", { className: "h-8 font-mono text-xs", maxLength: 40 })
          : casella("nodo", "Identificativo", "", { className: "h-8 font-mono text-xs", readOnly: true, title: "L'identificativo non cambia: è quello che le zone di coincidenza ricordano" })}
        <div className="sm:col-span-2">{casella("nome", "Nome", "Stazione FS Centrale", { maxLength: 120 })}</div>
        <div>
          <Label htmlFor={id("tipo")} className="text-xs">Tipo</Label>
          <select id={id("tipo")} className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm block" value={m.tipo}
            onChange={(e) => setM({ ...m, tipo: e.target.value as TipoNodo })}>
            {TIPI_NODO.map(([t, nome]) => <option key={t} value={t}>{nome}</option>)}
          </select>
        </div>
        {casella("lat", "Latitudine", "44.5060", { inputMode: "decimal" })}
        {casella("lng", "Longitudine", "11.3430", { inputMode: "decimal" })}
        {casella("minutiAPiedi", "Minuti a piedi", "2", { inputMode: "numeric", title: "Dal binario, dalla nave o dall'aereo fino alla fermata" })}
        {casella("ordine", "Ordine", "", { inputMode: "numeric" })}
        <div className="sm:col-span-2">{casella("fermate", "Fermate GTFS (facoltative)", "1201, 1202")}</div>
        <div className="sm:col-span-2">{casella("descrizione", "Descrizione (facoltativa)", "Stazione principale, treni regionali e nazionali", { maxLength: 300 })}</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {orari("arrivi", "Arrivi stimati: da dove, a che ora", "Bologna (R): 07:10 08:10 09:10")}
        {orari("partenze", "Partenze stimate: per dove, a che ora", "Roma (FR): 06:30 10:00")}
      </div>
      <p className="text-xs text-muted-foreground">
        Una riga per luogo: il luogo, i due punti, poi gli orari. Sono una stima: per le stazioni l'analisi intermodale usa l'orario vero, quando lo ha scaricato.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={p.busy}><Save className="w-3.5 h-3.5 mr-1" />{p.nuovo ? "Aggiungi" : "Salva"}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={p.busy} onClick={p.onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}

export default function NodiDiScambio() {
  const { toast } = useToast();
  const [elenco, setElenco] = useState<ElencoNodi | null>(null);
  const [busy, setBusy] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState(false);

  const carica = useCallback(async () => {
    try { setElenco(await apiFetch<ElencoNodi>("/api/admin/nodi-scambio")); }
    catch (e: any) { toast({ title: "Nodi di scambio non letti", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const esegui = async (fatto: string, cosa: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try { await cosa(); await carica(); toast({ title: fatto }); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const nodi = elenco?.nodi ?? [];
  const togli = (n: NodoConZone) => {
    if (!window.confirm(domandaTogli(n))) return;
    void esegui(`${n.nome} tolto`, () => apiFetch(`/api/admin/nodi-scambio/${encodeURIComponent(n.nodo)}`, { method: "DELETE" }));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ArrowLeftRight className="w-4 h-4 text-primary" aria-hidden /> Nodi di scambio</CardTitle>
        <p className="text-xs text-muted-foreground">
          Stazioni, porti, aeroporti e parcheggi scambiatori dove i passeggeri cambiano mezzo. Li usano l'analisi intermodale (stazioni, porti e aeroporti), le zone di coincidenza e il confronto fra programmi.
          Oltre a questi, l'analisi trova da sola le stazioni dai nomi delle fermate.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!elenco ? <div className="text-sm text-muted-foreground">Carico i nodi…</div> : (
          <>
            {nodi.length === 0 && <p className="text-sm text-muted-foreground">Nessun nodo scritto.</p>}
            {nodi.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5">Nodo</th><th className="px-2 py-1.5">Tipo</th><th className="px-2 py-1.5">Posizione</th>
                    <th className="px-2 py-1.5 text-right" title="Arrivi e partenze stimati">Corse stimate</th>
                    <th className="px-2 py-1.5 text-right" title="Le zone di coincidenza che lo ricordano">Zone</th><th className="px-2 py-1.5" />
                  </tr></thead>
                  <tbody>
                    {nodi.map((n) => aperto === n.nodo ? (
                      <tr key={n.nodo} className="bg-muted/30"><td colSpan={6} className="px-3 py-2">
                        <ModuloNodoForm iniziale={moduloDa(n)} gia={[]} busy={busy} onAnnulla={() => setAperto(null)}
                          onSalva={async (m) => {
                            const ok = await esegui(`${m.nome.trim()} salvato`, () =>
                              apiFetch(`/api/admin/nodi-scambio/${encodeURIComponent(n.nodo)}`, { method: "PUT", body: JSON.stringify(corpoNodo(m, false)) }));
                            if (ok) setAperto(null);
                          }} />
                      </td></tr>
                    ) : (
                      <tr key={n.nodo} className="border-t border-border/40 align-top">
                        <td className="px-3 py-1.5">
                          <span className="font-medium">{n.nome}</span>
                          <span className="block font-mono text-xs text-muted-foreground">{n.nodo}</span>
                        </td>
                        <td className="px-2 py-1.5 text-xs">{nomeDelTipo(n.tipo)}</td>
                        <td className="px-2 py-1.5 tabular-nums text-xs">{coordinate(n.lat, n.lng)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{corseStimate(n)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{n.zone}</td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => { setNuovo(false); setAperto(n.nodo); }}>Modifica</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => togli(n)} aria-label={`Togli ${n.nome}`}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {nuovo ? (
              <ModuloNodoForm iniziale={moduloVuoto()} nuovo gia={nodi.map((n) => n.nodo)} busy={busy} onAnnulla={() => setNuovo(false)}
                onSalva={async (m) => {
                  const ok = await esegui(`${m.nome.trim()} aggiunto`, () =>
                    apiFetch("/api/admin/nodi-scambio", { method: "POST", body: JSON.stringify(corpoNodo(m, true)) }));
                  if (ok) setNuovo(false);
                }} />
            ) : nodi.length >= elenco.massimo ? (
              <p className="text-xs text-muted-foreground">I nodi sono {elenco.massimo}, il massimo.</p>
            ) : (
              <Button variant="outline" size="sm" onClick={() => { setAperto(null); setNuovo(true); }} disabled={busy}>
                <Plus className="w-4 h-4 mr-1.5" />Aggiungi un nodo
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
