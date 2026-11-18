/**
 * I gestori (tappa 6.11), nella pagina Amministrazione › Azienda: le aziende
 * che gestiscono le linee. Nei GTFS ogni gestore è un'agenzia e ogni linea è
 * di uno di loro; chi programma per più aziende (un consorzio per i suoi
 * consorziati) le scrive qui, e assegna le linee in Planning Studio. Senza
 * gestori l'agenzia è l'azienda, per tutte le linee.
 * API: /api/admin/gestori. I conti in lib/gestori.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Building2, Plus, Save, Star, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  avvisoSenzaGestore, corpoModificaGestore, corpoNuovoGestore, domandaTogli, erroriGestore, moduloDa, moduloVuoto, riassuntoGestori,
  type ElencoGestori, type GestoreConLinee, type ModuloGestore,
} from "@/lib/gestori";

/** Il modulo di un gestore: nuovo (con l'identificativo) o da cambiare (senza). */
function ModuloGestoreForm(p: {
  iniziale: ModuloGestore; nuovo?: boolean; gia: string[]; busy: boolean;
  onSalva: (m: ModuloGestore) => Promise<void>; onAnnulla: () => void;
}) {
  const [m, setM] = useState<ModuloGestore>(p.iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriGestore(m, p.nuovo ? p.gia : []);
  const id = (campo: string) => `gestore-${p.nuovo ? "nuovo" : p.iniziale.gestore}-${campo}`;
  const casella = (campo: keyof ModuloGestore, etichetta: string, esempio: string, soloLettura = false) => (
    <div>
      <Label htmlFor={id(campo)} className="text-xs">{etichetta}</Label>
      <Input id={id(campo)} value={m[campo]} placeholder={esempio} className={`h-8 ${campo === "gestore" ? "font-mono text-xs" : ""}`} maxLength={200}
        readOnly={soloLettura} title={soloLettura ? "L'identificativo di un gestore salvato non cambia: è quello che sta sulle linee" : undefined}
        onChange={(e) => setM({ ...m, [campo]: e.target.value })} />
    </div>
  );
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (errori.length === 0) void p.onSalva(m); }}>
      <div className="grid gap-2 sm:grid-cols-2">
        {casella("gestore", "Identificativo (agency_id)", "AUTOLINEE_ROSSI", !p.nuovo)}
        {casella("nome", "Nome", "Autolinee Rossi S.r.l.")}
        {casella("sito", "Sito", "https://www.esempio.it")}
        {casella("telefono", "Telefono (facoltativo)", "071 000000")}
        {casella("email", "Posta (facoltativa)", "info@esempio.it")}
        {casella("tariffeUrl", "Pagina delle tariffe (facoltativa)", "https://www.esempio.it/tariffe")}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={p.busy}><Save className="w-3.5 h-3.5 mr-1" />{p.nuovo ? "Aggiungi" : "Salva"}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={p.busy} onClick={p.onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}

export default function Gestori() {
  const { toast } = useToast();
  const [elenco, setElenco] = useState<ElencoGestori | null>(null);
  const [busy, setBusy] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState(false);

  const carica = useCallback(async () => {
    try { setElenco(await apiFetch<ElencoGestori>("/api/admin/gestori")); }
    catch (e: any) { toast({ title: "Gestori non letti", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  /** Fa una cosa sul server, poi rilegge l'elenco. Rende true se è andata. */
  const esegui = async (fatto: string, cosa: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try { await cosa(); await carica(); toast({ title: fatto }); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const gestori = elenco?.gestori ?? [];
  const togli = (g: GestoreConLinee) => {
    if (!window.confirm(domandaTogli(g, gestori))) return;
    void esegui(`${g.nome} tolto`, () => apiFetch(`/api/admin/gestori/${encodeURIComponent(g.gestore)}`, { method: "DELETE" }));
  };
  const avviso = elenco ? avvisoSenzaGestore(elenco) : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Building2 className="w-4 h-4 text-primary" aria-hidden /> Gestori</CardTitle>
        <p className="text-xs text-muted-foreground">
          Le aziende che gestiscono le linee. Nei GTFS ogni gestore è un'agenzia e ogni linea è di uno di loro: serve a chi programma per più aziende, come un consorzio per i suoi consorziati.
          Le linee si assegnano in Planning Studio, dalla pagina della rete.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!elenco ? <div className="text-sm text-muted-foreground">Carico i gestori…</div> : (
          <>
            <p className="text-sm">{riassuntoGestori(elenco)}</p>
            {avviso && <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">{avviso}</div>}
            {gestori.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5">Gestore</th><th className="px-2 py-1.5">Sito e contatti</th>
                    <th className="px-2 py-1.5 text-right">Linee</th><th className="px-2 py-1.5" />
                  </tr></thead>
                  <tbody>
                    {gestori.map((g) => aperto === g.gestore ? (
                      <tr key={g.gestore} className="bg-muted/30"><td colSpan={4} className="px-3 py-2">
                        <ModuloGestoreForm iniziale={moduloDa(g)} gia={[]} busy={busy} onAnnulla={() => setAperto(null)}
                          onSalva={async (m) => {
                            const ok = await esegui(`${m.nome.trim()} salvato`, () =>
                              apiFetch(`/api/admin/gestori/${encodeURIComponent(g.gestore)}`, { method: "PUT", body: JSON.stringify(corpoModificaGestore(m)) }));
                            if (ok) setAperto(null);
                          }} />
                      </td></tr>
                    ) : (
                      <tr key={g.gestore} className="border-t border-border/40 align-top">
                        <td className="px-3 py-1.5">
                          <span className="font-medium">{g.nome}</span>
                          {g.predefinito && gestori.length > 1 && (
                            <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-primary/40 px-1.5 py-0.5 text-[11px] text-primary">
                              <Star className="w-3 h-3" aria-hidden />predefinito
                            </span>
                          )}
                          <span className="block font-mono text-xs text-muted-foreground">{g.gestore}</span>
                        </td>
                        <td className="px-2 py-1.5 text-xs text-muted-foreground break-all">
                          <span className="block">{g.sito}</span>
                          {(g.telefono || g.email) && <span className="block">{[g.telefono, g.email].filter(Boolean).join(" · ")}</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums" title="Le linee dei programmi di lavoro che dicono questo gestore">{g.linee}</td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          {!g.predefinito && (
                            <Button size="sm" variant="ghost" className="h-7" disabled={busy} title="Diventa il gestore delle linee che non ne hanno uno loro"
                              onClick={() => void esegui(`${g.nome} è il predefinito`, () =>
                                apiFetch(`/api/admin/gestori/${encodeURIComponent(g.gestore)}`, { method: "PUT", body: JSON.stringify({ predefinito: true }) }))}>
                              Predefinito
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => { setNuovo(false); setAperto(g.gestore); }}>Modifica</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy || (g.predefinito && gestori.length > 1)}
                            title={g.predefinito && gestori.length > 1 ? "Il predefinito si toglie per ultimo: prima scegline un altro" : undefined}
                            onClick={() => togli(g)} aria-label={`Togli ${g.nome}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {nuovo ? (
              <ModuloGestoreForm iniziale={moduloVuoto()} nuovo gia={gestori.map((g) => g.gestore)} busy={busy} onAnnulla={() => setNuovo(false)}
                onSalva={async (m) => {
                  const ok = await esegui(`${m.nome.trim()} aggiunto`, () =>
                    apiFetch("/api/admin/gestori", { method: "POST", body: JSON.stringify(corpoNuovoGestore(m)) }));
                  if (ok) setNuovo(false);
                }} />
            ) : gestori.length >= elenco.massimo ? (
              <p className="text-xs text-muted-foreground">I gestori sono {elenco.massimo}, il massimo.</p>
            ) : (
              <Button variant="outline" size="sm" onClick={() => { setAperto(null); setNuovo(true); }} disabled={busy}>
                <Plus className="w-4 h-4 mr-1.5" />Aggiungi un gestore
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              L'identificativo è quello che sta sulle linee e nei GTFS: non si cambia. Togliere un gestore non tocca le sue linee: passano al predefinito, e tornano sue se lo rimetti.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
