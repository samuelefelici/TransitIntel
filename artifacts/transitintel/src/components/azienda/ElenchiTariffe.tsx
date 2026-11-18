/**
 * Gli elenchi di partenza delle tariffe (tappa 6.10), nella pagina
 * Amministrazione › Azienda: le categorie di passeggero e i supporti da cui
 * la pagina Tariffe riempie un feed. Ogni elenco si scrive in bozza e si
 * salva tutto insieme. Chi figura come agenzia nei GTFS sta nella scheda dei
 * gestori (components/azienda/Gestori.tsx, tappa 6.11).
 * API: /api/admin/elenchi-tariffe. I conti in lib/elenchi-tariffe.ts.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ListChecks, Plus, Save, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  bozzaCategorie, bozzaSupporti, cambiato, categoriaNuova, corpoCategorie, corpoSupporti, erroriCategorie, erroriSupporti, supportoNuovo,
  type CategoriaCatalogo, type ElenchiTariffe as Elenchi, type RigaCategoria, type RigaSupporto, type SupportoCatalogo,
} from "@/lib/elenchi-tariffe";

const quanti = (n: number, uno: string, tanti: string) => (n === 1 ? `${uno}` : `${n} ${tanti}`);

/** Un elenco che si apre: il titolo, quante voci ha, e dentro la tabella con i suoi comandi. */
function Elenco(p: { titolo: string; conta: string; spiegazione: string; children: ReactNode }) {
  return (
    <details className="rounded-md border border-border/50">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
        {p.titolo}<span className="ml-2 text-xs font-normal text-muted-foreground">{p.conta}</span>
      </summary>
      <div className="space-y-3 border-t border-border/50 px-3 py-3">
        <p className="text-xs text-muted-foreground">{p.spiegazione}</p>
        {p.children}
      </div>
    </details>
  );
}

/** I comandi in fondo a un elenco: aggiungi, salva, annulla, e gli errori dopo che si è provato a salvare. */
function Comandi(p: {
  aggiungi: string; salva: string; busy: boolean; cambiato: boolean; pieno: boolean; errori: string[]; provato: boolean;
  onAggiungi: () => void; onSalva: () => void; onAnnulla: () => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={p.busy || p.pieno} onClick={p.onAggiungi}><Plus className="w-4 h-4 mr-1.5" />{p.aggiungi}</Button>
        <Button type="button" size="sm" disabled={p.busy || !p.cambiato} onClick={p.onSalva}><Save className="w-3.5 h-3.5 mr-1" />{p.salva}</Button>
        {p.cambiato && <Button type="button" variant="ghost" size="sm" disabled={p.busy} onClick={p.onAnnulla}>Annulla le modifiche</Button>}
      </div>
      {p.provato && p.errori.length > 0 && <ul className="text-xs text-destructive">{p.errori.slice(0, 6).map((x) => <li key={x}>{x}</li>)}</ul>}
    </>
  );
}

const Togli = (p: { cosa: string; onClick: () => void }) => (
  <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5 text-destructive" aria-label={`Togli ${p.cosa}`} onClick={p.onClick}>
    <X className="w-3.5 h-3.5" />
  </Button>
);

export default function ElenchiTariffe() {
  const { toast } = useToast();
  const [elenchi, setElenchi] = useState<Elenchi | null>(null);
  const [busy, setBusy] = useState(false);
  const [categorie, setCategorie] = useState<RigaCategoria[]>([]);
  const [supporti, setSupporti] = useState<RigaSupporto[]>([]);
  const [provato, setProvato] = useState<Record<string, boolean>>({});

  const carica = useCallback(async () => {
    try {
      const e = await apiFetch<Elenchi>("/api/admin/elenchi-tariffe");
      setElenchi(e);
      setCategorie(bozzaCategorie(e.categorie)); setSupporti(bozzaSupporti(e.supporti));
      setProvato({});
    } catch (e: any) { toast({ title: "Elenchi non letti", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  /** Salva una parte: se ci sono errori li mostra e non manda niente. */
  const salva = async <T,>(parte: string, errori: string[], manda: () => Promise<T>, fatto: (r: T) => void, messaggio: string) => {
    setProvato((p) => ({ ...p, [parte]: true }));
    if (errori.length) return;
    setBusy(true);
    try {
      fatto(await manda());
      setProvato((p) => ({ ...p, [parte]: false }));
      toast({ title: messaggio });
    } catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };
  const manda = <T,>(parte: string, corpo: unknown) =>
    apiFetch<T>(`/api/admin/elenchi-tariffe/${parte}`, { method: "PUT", body: JSON.stringify(corpo) });

  if (!elenchi) {
    return (
      <Card><CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><ListChecks className="w-4 h-4 text-primary" aria-hidden /> Tariffe: elenchi di partenza</CardTitle></CardHeader>
        <CardContent><div className="text-sm text-muted-foreground">Carico gli elenchi…</div></CardContent></Card>
    );
  }

  const eCategorie = erroriCategorie(categorie), eSupporti = erroriSupporti(supporti);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><ListChecks className="w-4 h-4 text-primary" aria-hidden /> Tariffe: elenchi di partenza</CardTitle>
        <p className="text-xs text-muted-foreground">
          Gli elenchi da cui la pagina Tariffe riempie un feed nuovo. Cambiarli qui non tocca i feed già riempiti.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ── Le categorie ── */}
        <Elenco titolo="Categorie di passeggero" conta={quanti(elenchi.categorie.length, "una categoria", "categorie")}
          spiegazione="Ordinario, studente, anziano… La predefinita vale per i titoli che non ne dicono un'altra. Una categoria che il catalogo dei titoli usa non si può togliere.">
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                <th className="px-2 py-1.5">Identificativo</th><th className="px-2 py-1.5">Nome</th><th className="px-2 py-1.5">Pagina dei requisiti</th>
                <th className="px-2 py-1.5 text-center w-24">Predefinita</th><th className="px-2 py-1.5 w-10" />
              </tr></thead>
              <tbody>
                {categorie.map((r, i) => {
                  const cambia = (parte: Partial<RigaCategoria>) => setCategorie((b) => b.map((x, j) => (j === i ? { ...x, ...parte } : x)));
                  return (
                    <tr key={i} className="border-t border-border/40">
                      <td className="px-2 py-1">
                        <Label htmlFor={`cat-${i}-id`} className="sr-only">Categoria {i + 1}: identificativo</Label>
                        <Input id={`cat-${i}-id`} value={r.categoria} className="h-8 w-36 font-mono text-xs" maxLength={40} readOnly={!r.nuova}
                          title={r.nuova ? undefined : "L'identificativo di una categoria salvata non cambia"} onChange={(e) => cambia({ categoria: e.target.value })} />
                      </td>
                      <td className="px-2 py-1">
                        <Label htmlFor={`cat-${i}-nome`} className="sr-only">Categoria {i + 1}: nome</Label>
                        <Input id={`cat-${i}-nome`} value={r.nome} className="h-8 min-w-36" maxLength={120} onChange={(e) => cambia({ nome: e.target.value })} />
                      </td>
                      <td className="px-2 py-1">
                        <Label htmlFor={`cat-${i}-url`} className="sr-only">Categoria {i + 1}: pagina dei requisiti</Label>
                        <Input id={`cat-${i}-url`} value={r.url} className="h-8 min-w-32" maxLength={210} placeholder="https://…" onChange={(e) => cambia({ url: e.target.value })} />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <input type="radio" id={`cat-${i}-pred`} name="categoria-predefinita" className="h-4 w-4 accent-primary" checked={r.predefinita}
                          aria-label={`Categoria ${i + 1}: predefinita`} onChange={() => setCategorie((b) => b.map((x, j) => ({ ...x, predefinita: j === i })))} />
                      </td>
                      <td className="px-2 py-1 text-right"><Togli cosa={`la categoria ${i + 1}`} onClick={() => setCategorie((b) => b.filter((_, j) => j !== i))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Comandi aggiungi="Aggiungi una categoria" salva="Salva le categorie" busy={busy} pieno={categorie.length >= 40} errori={eCategorie} provato={!!provato.categorie}
            cambiato={cambiato(categorie, bozzaCategorie(elenchi.categorie))}
            onAggiungi={() => setCategorie((b) => [...b, categoriaNuova(b)])}
            onAnnulla={() => { setCategorie(bozzaCategorie(elenchi.categorie)); setProvato((p) => ({ ...p, categorie: false })); }}
            onSalva={() => void salva("categorie", eCategorie, () => manda<{ categorie: CategoriaCatalogo[] }>("categorie", corpoCategorie(categorie)),
              (r) => { setElenchi((e) => (e ? { ...e, categorie: r.categorie } : e)); setCategorie(bozzaCategorie(r.categorie)); }, "Categorie salvate")} />
        </Elenco>

        {/* ── I supporti ── */}
        <Elenco titolo="Supporti" conta={quanti(elenchi.supporti.length, "un supporto", "supporti")}
          spiegazione="Su che cosa si carica un titolo: contanti a bordo, biglietto di carta, tessera, carta bancaria, applicazione.">
          <div className="overflow-x-auto rounded-md border border-border/50">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                <th className="px-2 py-1.5">Identificativo</th><th className="px-2 py-1.5">Nome</th><th className="px-2 py-1.5">Tipo</th><th className="px-2 py-1.5 w-10" />
              </tr></thead>
              <tbody>
                {supporti.map((r, i) => {
                  const cambia = (parte: Partial<RigaSupporto>) => setSupporti((b) => b.map((x, j) => (j === i ? { ...x, ...parte } : x)));
                  return (
                    <tr key={i} className="border-t border-border/40">
                      <td className="px-2 py-1">
                        <Label htmlFor={`sup-${i}-id`} className="sr-only">Supporto {i + 1}: identificativo</Label>
                        <Input id={`sup-${i}-id`} value={r.supporto} className="h-8 w-36 font-mono text-xs" maxLength={40} readOnly={!r.nuova}
                          title={r.nuova ? undefined : "L'identificativo di un supporto salvato non cambia"} onChange={(e) => cambia({ supporto: e.target.value })} />
                      </td>
                      <td className="px-2 py-1">
                        <Label htmlFor={`sup-${i}-nome`} className="sr-only">Supporto {i + 1}: nome</Label>
                        <Input id={`sup-${i}-nome`} value={r.nome} className="h-8 min-w-40" maxLength={120} onChange={(e) => cambia({ nome: e.target.value })} />
                      </td>
                      <td className="px-2 py-1">
                        <Label htmlFor={`sup-${i}-tipo`} className="sr-only">Supporto {i + 1}: tipo</Label>
                        <select id={`sup-${i}-tipo`} value={r.tipo} className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                          onChange={(e) => cambia({ tipo: e.target.value })}>
                          {elenchi.tipiSupporto.map((t) => <option key={t.tipo} value={String(t.tipo)}>{t.nome}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-1 text-right"><Togli cosa={`il supporto ${i + 1}`} onClick={() => setSupporti((b) => b.filter((_, j) => j !== i))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Comandi aggiungi="Aggiungi un supporto" salva="Salva i supporti" busy={busy} pieno={supporti.length >= 40} errori={eSupporti} provato={!!provato.supporti}
            cambiato={cambiato(supporti, bozzaSupporti(elenchi.supporti))}
            onAggiungi={() => setSupporti((b) => [...b, supportoNuovo()])}
            onAnnulla={() => { setSupporti(bozzaSupporti(elenchi.supporti)); setProvato((p) => ({ ...p, supporti: false })); }}
            onSalva={() => void salva("supporti", eSupporti, () => manda<{ supporti: SupportoCatalogo[] }>("supporti", corpoSupporti(supporti)),
              (r) => { setElenchi((e) => (e ? { ...e, supporti: r.supporti } : e)); setSupporti(bozzaSupporti(r.supporti)); }, "Supporti salvati")} />
        </Elenco>
      </CardContent>
    </Card>
  );
}
