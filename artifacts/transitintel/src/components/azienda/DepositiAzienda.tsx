/**
 * I depositi dell'azienda (tappa 6.4), nella pagina Amministrazione › Azienda:
 * il catalogo dei depositi del personale. Da qui si creano, si cambiano e si
 * tolgono; ogni riga si salva da sé. Il codice non cambia (lo usano i gruppi
 * turni e i depositi degli utenti), e un deposito in uso non si toglie.
 * API: /api/admin/depositi. I conti in lib/depositi.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Trash2, Warehouse } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CADENZE, cadenzaInBreve, codiceDaNome, corpoModificaDeposito, corpoNuovoDeposito, depositoInUso, erroriDeposito, GRUPPI, gruppoInBreve, MODULO_DEPOSITO_VUOTO,
  moduloDepositoDa, nomeCadenza, nomeGruppo, usoDelDeposito, type Cadenza, type DepositoConUso, type Gruppo, type ModuloDeposito,
} from "@/lib/depositi";

const SELECT = "block h-8 rounded-md border border-input bg-background px-2 text-sm";

export default function DepositiAzienda() {
  const { toast } = useToast();
  const [depositi, setDepositi] = useState<DepositoConUso[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState(false);

  const carica = useCallback(async () => {
    try { setDepositi((await apiFetch<{ depositi: DepositoConUso[] }>("/api/admin/depositi")).depositi); }
    catch (e: any) { toast({ title: "Depositi non letti", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const esegui = async (fatto: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast({ title: fatto }); await carica(); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const togli = (d: DepositoConUso) => {
    if (!window.confirm(`Tolgo il deposito ${d.nome}? Non lo usa nessuno; se servirà di nuovo va ricreato.`)) return;
    void esegui(`${d.nome} tolto`, () => apiFetch(`/api/admin/depositi/${encodeURIComponent(d.codice)}`, { method: "DELETE" }));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Warehouse className="w-4 h-4 text-primary" aria-hidden /> Depositi</CardTitle>
        <p className="text-xs text-muted-foreground">
          I depositi del personale: a un deposito si assegnano i conducenti e i gruppi turni, e per deposito si decide che cosa vede e scrive un utente.
          Il gruppo dice se il deposito lavora la domenica e nei festivi; i periodi dicono ogni quanto cambiano i turni.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!depositi ? <div className="text-sm text-muted-foreground">Carico i depositi…</div> : (
          <>
            {depositi.length === 0 && (
              <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                Non c'è ancora nessun deposito. Senza, a un conducente non si può dare il deposito: aggiungi il primo.
              </div>
            )}
            {depositi.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5">Nome</th><th className="px-3 py-1.5">Codice</th><th className="px-3 py-1.5">Domenica e festivi</th>
                    <th className="px-3 py-1.5">Periodi dei turni</th><th className="px-3 py-1.5">Chi lo usa</th><th className="px-3 py-1.5" />
                  </tr></thead>
                  <tbody>
                    {depositi.map((d) => aperto === d.codice ? (
                      <tr key={d.codice} className="bg-muted/30"><td colSpan={6} className="px-3 py-2">
                        <ModuloDepositoForm iniziale={moduloDepositoDa(d)} busy={busy} onAnnulla={() => setAperto(null)}
                          onSalva={async (m) => {
                            const ok = await esegui(`${m.nome.trim()} salvato`, () =>
                              apiFetch(`/api/admin/depositi/${encodeURIComponent(d.codice)}`, { method: "PUT", body: JSON.stringify(corpoModificaDeposito(m)) }));
                            if (ok) setAperto(null);
                          }} />
                      </td></tr>
                    ) : (
                      <tr key={d.codice} className="border-t border-border/40 align-top">
                        <td className="px-3 py-1.5">
                          <span className="font-medium">{d.nome}</span>
                          {d.alias.length > 0 && <span className="block text-xs text-muted-foreground">anche: {d.alias.join(", ")}</span>}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{d.codice}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap" title={nomeGruppo(d.gruppo)}>{gruppoInBreve(d.gruppo)}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap" title={nomeCadenza(d.cadenzaTurni)}>{cadenzaInBreve(d.cadenzaTurni)}</td>
                        <td className="px-3 py-1.5 text-xs">{depositoInUso(d) ? usoDelDeposito(d).join(", ") : <span className="text-muted-foreground">nessuno</span>}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => { setNuovo(false); setAperto(d.codice); }}>Modifica</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy || depositoInUso(d)} onClick={() => togli(d)}
                            aria-label={`Togli ${d.nome}`} title={depositoInUso(d) ? "In uso: prima sposta chi lo usa" : `Togli ${d.nome}`}>
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
              <ModuloDepositoForm iniziale={MODULO_DEPOSITO_VUOTO} nuovo busy={busy} onAnnulla={() => setNuovo(false)}
                onSalva={async (m) => {
                  const ok = await esegui(`${m.nome.trim()} aggiunto`, () =>
                    apiFetch("/api/admin/depositi", { method: "POST", body: JSON.stringify(corpoNuovoDeposito(m)) }));
                  if (ok) setNuovo(false);
                }} />
            ) : (
              <Button variant="outline" size="sm" onClick={() => { setAperto(null); setNuovo(true); }} disabled={busy}>
                <Plus className="w-4 h-4 mr-1.5" />Aggiungi un deposito
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModuloDepositoForm({ iniziale, nuovo = false, busy, onSalva, onAnnulla }: {
  iniziale: ModuloDeposito; nuovo?: boolean; busy: boolean; onSalva: (m: ModuloDeposito) => void; onAnnulla: () => void;
}) {
  const [m, setM] = useState(iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriDeposito(m, nuovo);
  const id = (k: string) => `deposito-${nuovo ? "nuovo" : iniziale.codice}-${k}`;
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (!errori.length) onSalva(m); }}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={id("nome")} className="text-xs">Nome</Label>
          <Input id={id("nome")} value={m.nome} className="h-8 w-48" maxLength={60} onChange={(e) => setM({ ...m, nome: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("codice")} className="text-xs">Codice{nuovo ? " (facoltativo)" : ""}</Label>
          <Input id={id("codice")} value={m.codice} className="h-8 w-40 font-mono" maxLength={40} disabled={!nuovo}
            placeholder={nuovo ? codiceDaNome(m.nome) || "dal nome" : undefined}
            onChange={(e) => setM({ ...m, codice: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("gruppo")} className="block text-xs">Domenica e festivi</Label>
          <select id={id("gruppo")} className={SELECT} value={m.gruppo} onChange={(e) => setM({ ...m, gruppo: e.target.value as Gruppo })}>
            {GRUPPI.map(([k, nome]) => <option key={k} value={k}>{nome}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("cadenza")} className="block text-xs">Periodi dei turni</Label>
          <select id={id("cadenza")} className={SELECT} value={m.cadenzaTurni} onChange={(e) => setM({ ...m, cadenzaTurni: e.target.value as Cadenza })}>
            {CADENZE.map(([k, nome]) => <option key={k} value={k}>{nome}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("ordine")} className="text-xs">Ordine</Label>
          <Input id={id("ordine")} value={m.ordine} className="h-8 w-20" inputMode="numeric" maxLength={4}
            placeholder={nuovo ? "in fondo" : undefined} onChange={(e) => setM({ ...m, ordine: e.target.value })} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={id("alias")} className="text-xs">Altri nomi, separati da virgola</Label>
        <Input id={id("alias")} value={m.alias} className="h-8 w-full max-w-xl" onChange={(e) => setM({ ...m, alias: e.target.value })} />
        <p className="text-xs text-muted-foreground">
          I nomi o i codici con cui il deposito arriva da un file del personale.
          {nuovo ? " Il codice non si cambia più: resta quello anche se cambi il nome." : " Se cambi il nome, quello di prima resta fra gli altri nomi."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="h-8" disabled={busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}
