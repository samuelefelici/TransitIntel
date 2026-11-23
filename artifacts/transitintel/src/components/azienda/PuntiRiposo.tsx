/**
 * I punti di riposo dei turni guida (tappa 7.22), nella pagina Amministrazione
 * › Azienda: dove il conducente fa la pausa di un turno a due riprese fuori
 * residenza. Il calcolo dei turni guida conta retribuita una parte della sosta
 * in questi luoghi, di più se non hanno servizi, e li riconosce dai nomi delle
 * fermate. API: /api/admin/punti-riposo. Il modulo in lib/punti-riposo.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Coffee, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { corpoPunto, erroriPunto, MODULO_PUNTO_VUOTO, moduloPuntoDa, serviziInBreve, type ModuloPunto, type PuntoDiRiposo } from "@/lib/punti-riposo";

export default function PuntiRiposo() {
  const { toast } = useToast();
  const [punti, setPunti] = useState<PuntoDiRiposo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState(false);

  const carica = useCallback(async () => {
    try { setPunti((await apiFetch<{ punti: PuntoDiRiposo[] }>("/api/admin/punti-riposo")).punti); }
    catch (e: any) { toast({ title: "Punti di riposo non letti", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const esegui = async (fatto: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast({ title: fatto }); await carica(); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const togli = (p: PuntoDiRiposo) => {
    if (!window.confirm(`Tolgo il punto di riposo ${p.nome}? I calcoli dei turni guida non lo conteranno più.`)) return;
    void esegui(`${p.nome} tolto`, () => apiFetch(`/api/admin/punti-riposo/${encodeURIComponent(p.id)}`, { method: "DELETE" }));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Coffee className="w-4 h-4 text-primary" aria-hidden /> Punti di riposo dei turni guida</CardTitle>
        <p className="text-xs text-muted-foreground">
          I luoghi dove il conducente fa la pausa di un turno a due riprese fuori residenza. Il calcolo dei turni guida conta retribuita una parte
          della sosta: di più dove non ci sono servizi (bagno, sala d'attesa). Riconosce il luogo dai nomi delle fermate, scritti come nel GTFS.
          Valgono per tutti i calcoli, insieme ai nodi di sosta dei progetti di Planning Studio.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!punti ? <div className="text-sm text-muted-foreground">Carico i punti di riposo…</div> : (
          <>
            {punti.length === 0 && (
              <div role="status" className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm">
                Nessun punto di riposo. Senza, la sosta fuori residenza conta solo ai nodi di sosta dei progetti di Planning Studio collegati.
              </div>
            )}
            {punti.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5">Luogo</th><th className="px-3 py-1.5">Servizi</th><th className="px-3 py-1.5">Fermate</th><th className="px-3 py-1.5" />
                  </tr></thead>
                  <tbody>
                    {punti.map((p) => aperto === p.id ? (
                      <tr key={p.id} className="bg-muted/30"><td colSpan={4} className="px-3 py-2">
                        <ModuloPuntoForm chiave={p.id} iniziale={moduloPuntoDa(p)} busy={busy} onAnnulla={() => setAperto(null)}
                          onSalva={async (m) => {
                            const ok = await esegui(`${m.nome.trim()} salvato`, () =>
                              apiFetch(`/api/admin/punti-riposo/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify(corpoPunto(m)) }));
                            if (ok) setAperto(null);
                          }} />
                      </td></tr>
                    ) : (
                      <tr key={p.id} className="border-t border-border/40 align-top">
                        <td className="px-3 py-1.5">
                          <span className="font-medium">{p.nome}</span>
                          {p.nota && <span className="block text-xs text-muted-foreground">{p.nota}</span>}
                        </td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{serviziInBreve(p)}</td>
                        <td className="px-3 py-1.5 text-xs">
                          {p.fermate.join(", ")}
                          {p.fermateNonTrovate.length > 0 && (
                            <span className="block text-amber-600 dark:text-amber-400">
                              Non nel feed in esercizio: {p.fermateNonTrovate.join(", ")}. Controlla come sono scritte.
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => { setNuovo(false); setAperto(p.id); }}>Modifica</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => togli(p)}
                            aria-label={`Togli ${p.nome}`} title={`Togli ${p.nome}`}>
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
              <ModuloPuntoForm chiave="nuovo" iniziale={MODULO_PUNTO_VUOTO} busy={busy} onAnnulla={() => setNuovo(false)}
                onSalva={async (m) => {
                  const ok = await esegui(`${m.nome.trim()} aggiunto`, () =>
                    apiFetch("/api/admin/punti-riposo", { method: "POST", body: JSON.stringify(corpoPunto(m)) }));
                  if (ok) setNuovo(false);
                }} />
            ) : (
              <Button variant="outline" size="sm" onClick={() => { setAperto(null); setNuovo(true); }} disabled={busy}>
                <Plus className="w-4 h-4 mr-1.5" />Aggiungi un punto di riposo
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModuloPuntoForm({ chiave, iniziale, busy, onSalva, onAnnulla }: {
  chiave: string; iniziale: ModuloPunto; busy: boolean; onSalva: (m: ModuloPunto) => void; onAnnulla: () => void;
}) {
  const [m, setM] = useState(iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriPunto(m);
  const id = (k: string) => `riposo-${chiave}-${k}`;
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (!errori.length) onSalva(m); }}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={id("nome")} className="text-xs">Luogo</Label>
          <Input id={id("nome")} value={m.nome} className="h-8 w-56" maxLength={120} onChange={(e) => setM({ ...m, nome: e.target.value })} />
        </div>
        <label htmlFor={id("servizi")} className="flex items-center gap-2 text-sm h-8">
          <input id={id("servizi")} type="checkbox" checked={m.conServizi} onChange={(e) => setM({ ...m, conServizi: e.target.checked })} />
          Ha servizi (bagno, sala d'attesa)
        </label>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("fermate")} className="text-xs">Fermate del luogo, una per riga, come nel GTFS</Label>
        <textarea id={id("fermate")} value={m.fermate} rows={3}
          className="block w-full max-w-xl rounded-md border border-input bg-background px-2 py-1 text-sm"
          onChange={(e) => setM({ ...m, fermate: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("nota")} className="text-xs">Nota (facoltativa)</Label>
        <Input id={id("nota")} value={m.nota} className="h-8 w-full max-w-xl" maxLength={300} onChange={(e) => setM({ ...m, nota: e.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="h-8" disabled={busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}
