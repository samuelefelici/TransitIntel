/**
 * Le reti dell'azienda e le regole delle linee (tappa 6.7), nella pagina
 * Amministrazione › Azienda. Due parti:
 *   - le reti: l'extraurbana, che c'è sempre, e le urbane, che si creano, si
 *     cambiano e si tolgono da qui; ogni riga si salva da sé;
 *   - le regole che dal nome breve di una linea ricavano la rete, in ordine:
 *     si scrivono in bozza, si provano con l'anteprima e si salvano insieme.
 * API: /api/admin/reti. I conti in lib/reti.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Network, Plus, Save, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  bozzaDa, corpoModificaRete, corpoNuovaRete, corpoRegole, domandaTogliRete, erroriRegole, erroriRete, etichettaDi, etichettaRete, MODULO_RETE_VUOTO,
  moduloReteDa, NOME_TIPO, regolaVuoleValore, regoleCambiate, RETE_EXTRAURBANA, reteInUso, riassuntoAnteprima, siglaDaLuogo, spostaRegola, TIPI_REGOLA,
  testoCorrispettivo, usoDellaRete, type AnteprimaRegole, type ElencoReti, type ModuloRete, type RegolaInBozza, type ReteConUso, type TipoRegola,
} from "@/lib/reti";

const SELECT = "block h-8 rounded-md border border-input bg-background px-2 text-sm";
/* una regola sta su una riga: numero, tipo, valore, rete, comandi. Su uno schermo stretto va a capo. */
const COLONNE_REGOLA = "items-center gap-2 sm:grid sm:grid-cols-[1.25rem_minmax(0,1.25fr)_5.5rem_minmax(0,1fr)_auto]";
const RIGA_REGOLA = `flex flex-wrap ${COLONNE_REGOLA}`;

export default function RetiAzienda() {
  const { toast } = useToast();
  const { refresh } = useAuth();
  const [elenco, setElenco] = useState<ElencoReti | null>(null);
  const [busy, setBusy] = useState(false);
  const [aperta, setAperta] = useState<string | null>(null);
  const [nuova, setNuova] = useState(false);
  const [bozza, setBozza] = useState<RegolaInBozza[]>([]);
  const [anteprima, setAnteprima] = useState<AnteprimaRegole | null>(null);
  const [provate, setProvate] = useState(false);

  const carica = useCallback(async (tieniBozza = false) => {
    try {
      const e = await apiFetch<ElencoReti>("/api/admin/reti");
      setElenco(e);
      if (!tieniBozza) { setBozza(bozzaDa(e.regole)); setAnteprima(null); setProvate(false); }
    } catch (e: any) { toast({ title: "Reti non lette", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  /** Dopo un salvataggio: l'elenco di nuovo, e le reti della sessione (etichette e colori delle altre pagine). */
  const esegui = async (fatto: string, fn: () => Promise<unknown>, tieniBozza = true) => {
    setBusy(true);
    try { await fn(); toast({ title: fatto }); await carica(tieniBozza); void refresh(); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const togli = (r: ReteConUso) => {
    if (!window.confirm(domandaTogliRete(r))) return;
    /* con la rete se ne vanno le sue regole: la bozza riparte da quelle rimaste */
    void esegui(`${r.nome} tolta`, () => apiFetch(`/api/admin/reti/${encodeURIComponent(r.rete)}`, { method: "DELETE" }), false);
  };

  const reti = elenco?.reti ?? [];
  const urbane = reti.filter((r) => r.tipo === "urbano");
  const errori = elenco ? erroriRegole(bozza, reti, elenco.massimoRegole) : [];
  const cambiate = elenco ? regoleCambiate(bozza, elenco.regole) : false;
  const cambia = (i: number, parte: Partial<RegolaInBozza>) => { setBozza((b) => b.map((g, j) => (j === i ? { ...g, ...parte } : g))); setAnteprima(null); };

  const prova = async (): Promise<AnteprimaRegole | null> => {
    setProvate(true);
    if (errori.length) return null;
    setBusy(true);
    try {
      const a = await apiFetch<AnteprimaRegole>("/api/admin/reti/regole/anteprima", { method: "POST", body: JSON.stringify(corpoRegole(bozza)) });
      setAnteprima(a);
      return a;
    } catch (e: any) { toast({ title: "Anteprima non riuscita", description: e?.message, variant: "destructive" }); return null; }
    finally { setBusy(false); }
  };

  const salvaRegole = async () => {
    const a = anteprima ?? await prova();
    if (!a) return;
    if (a.cambiano.length > 0 && !window.confirm(`${riassuntoAnteprima(a)}\n\nSalvo le regole?`)) return;
    await esegui("Regole salvate", () => apiFetch("/api/admin/reti/regole", { method: "PUT", body: JSON.stringify(corpoRegole(bozza)) }), false);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Network className="w-4 h-4 text-primary" aria-hidden /> Reti e linee</CardTitle>
        <p className="text-xs text-muted-foreground">
          Le reti del servizio: l'extraurbana, che c'è sempre, e le urbane. Le usano le tariffe (ogni rete urbana ha la sua zona a tariffa unica),
          il Roster (fra due turni il riposo minimo è di 8 ore su linee urbane, di 9 su linee extraurbane) e il calcolo dei turni macchina,
          col corrispettivo €/km di ogni rete.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {!elenco ? <div className="text-sm text-muted-foreground">Carico le reti…</div> : (
          <>
            <section aria-label="Reti" className="space-y-3">
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5">Rete</th><th className="px-2 py-1.5">Sigla</th>
                    <th className="px-2 py-1.5">Zona tariffaria</th><th className="px-2 py-1.5">Corrispettivo</th><th className="px-2 py-1.5">Chi la usa</th><th className="px-2 py-1.5" />
                  </tr></thead>
                  <tbody>
                    {reti.map((r) => aperta === r.rete ? (
                      <tr key={r.rete} className="bg-muted/30"><td colSpan={6} className="px-3 py-2">
                        <ModuloReteForm iniziale={moduloReteDa(r)} urbana={r.tipo === "urbano"} chiave={r.rete} busy={busy} onAnnulla={() => setAperta(null)}
                          onSalva={async (m) => {
                            const ok = await esegui(`${m.nome.trim()} salvata`, () =>
                              apiFetch(`/api/admin/reti/${encodeURIComponent(r.rete)}`, { method: "PUT", body: JSON.stringify(corpoModificaRete(m, r.tipo === "urbano")) }));
                            if (ok) setAperta(null);
                          }} />
                      </td></tr>
                    ) : (
                      <tr key={r.rete} className="border-t border-border/40 align-top">
                        <td className="px-3 py-1.5">
                          <span className="flex items-center gap-2 font-medium whitespace-nowrap">
                            <span className="inline-block w-2.5 h-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.colore }} aria-hidden />
                            {etichettaRete(r)}
                          </span>
                          {/* il nome per esteso, quello che esce nel GTFS */}
                          <span className="block pl-[1.125rem] text-xs text-muted-foreground">{r.nome}</span>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs">{r.sigla ?? "—"}</td>
                        <td className="px-2 py-1.5 font-mono text-xs">{r.zona ?? <span className="font-sans text-muted-foreground">per chilometri</span>}</td>
                        <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                          {testoCorrispettivo(r) ?? <span className="text-muted-foreground">non indicato</span>}
                          {r.corrispettivoKm != null && (
                            <span className="block text-muted-foreground">{r.corrispettivoSuVuoti ? "anche sui km a vuoto" : "solo sui km di servizio"}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-xs">{reteInUso(r.uso) ? usoDellaRete(r.uso).join(", ") : <span className="text-muted-foreground">nessuno</span>}</td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => { setNuova(false); setAperta(r.rete); }}>Modifica</Button>
                          {r.rete !== RETE_EXTRAURBANA && (
                            <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy || reteInUso(r.uso)} onClick={() => togli(r)}
                              aria-label={`Togli ${r.nome}`} title={reteInUso(r.uso) ? "In uso: prima sposta o togli chi la usa, dalla pagina Tariffe" : `Togli ${r.nome}`}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {nuova ? (
                <ModuloReteForm iniziale={MODULO_RETE_VUOTO} urbana nuova chiave="nuova" busy={busy} onAnnulla={() => setNuova(false)}
                  onSalva={async (m) => {
                    const ok = await esegui(`Urbano ${m.luogo.trim()} aggiunta`, () =>
                      apiFetch("/api/admin/reti", { method: "POST", body: JSON.stringify(corpoNuovaRete(m)) }));
                    if (ok) setNuova(false);
                  }} />
              ) : urbane.length >= elenco.massimoRetiUrbane ? (
                <p className="text-xs text-muted-foreground">Le reti urbane sono {elenco.massimoRetiUrbane}, il massimo: per aggiungerne una va tolta un'altra.</p>
              ) : (
                <Button variant="outline" size="sm" onClick={() => { setAperta(null); setNuova(true); }} disabled={busy}>
                  <Plus className="w-4 h-4 mr-1.5" />Aggiungi una rete urbana
                </Button>
              )}
            </section>

            <section aria-label="Regole delle linee" className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Di quale rete è una linea</h3>
                <p className="text-xs text-muted-foreground">
                  Le regole si provano in ordine sul nome breve della linea, e vale la prima che corrisponde. Una linea che non ne segue nessuna è extraurbana.
                  Maiuscole e minuscole non contano.
                </p>
              </div>
              {bozza.length === 0 ? (
                <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                  Non c'è nessuna regola: tutte le linee valgono come extraurbane.
                  {urbane.length === 0 ? " Aggiungi prima una rete urbana." : " Aggiungi la prima."}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className={`hidden ${COLONNE_REGOLA} px-2 text-xs text-muted-foreground`} aria-hidden>
                    <span /><span>Se il nome breve…</span><span /><span>…la linea è di</span><span />
                  </div>
                  <ol className="space-y-1.5">
                    {bozza.map((g, i) => (
                      <li key={i} className={`${RIGA_REGOLA} rounded-md border border-border/50 px-2 py-1.5`}>
                        <span className="text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                        <span className="min-w-0">
                          <Label htmlFor={`regola-${i}-tipo`} className="sr-only">Regola {i + 1}: se il nome breve</Label>
                          <select id={`regola-${i}-tipo`} className={`${SELECT} w-full`} value={g.tipo} onChange={(e) => cambia(i, { tipo: e.target.value as TipoRegola })}>
                            {TIPI_REGOLA.map((t) => <option key={t} value={t}>{NOME_TIPO[t]}</option>)}
                          </select>
                        </span>
                        <span>
                          {regolaVuoleValore(g.tipo) && (
                            <>
                              <Label htmlFor={`regola-${i}-valore`} className="sr-only">Regola {i + 1}: il valore</Label>
                              <Input id={`regola-${i}-valore`} value={g.valore} className="h-8 w-full font-mono uppercase" maxLength={12}
                                onChange={(e) => cambia(i, { valore: e.target.value })} />
                            </>
                          )}
                        </span>
                        <span className="min-w-0">
                          <Label htmlFor={`regola-${i}-rete`} className="sr-only">Regola {i + 1}: la linea è di</Label>
                          <select id={`regola-${i}-rete`} className={`${SELECT} w-full`} value={g.rete} onChange={(e) => cambia(i, { rete: e.target.value })}>
                            {!reti.some((r) => r.rete === g.rete) && <option value={g.rete}>scegli…</option>}
                            {reti.map((r) => <option key={r.rete} value={r.rete}>{etichettaRete(r)}</option>)}
                          </select>
                        </span>
                        <span className="flex items-center justify-end">
                          <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5" disabled={i === 0} aria-label={`Sposta su la regola ${i + 1}`}
                            onClick={() => { setBozza((b) => spostaRegola(b, i, -1)); setAnteprima(null); }}><ArrowUp className="w-3.5 h-3.5" /></Button>
                          <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5" disabled={i === bozza.length - 1} aria-label={`Sposta giù la regola ${i + 1}`}
                            onClick={() => { setBozza((b) => spostaRegola(b, i, 1)); setAnteprima(null); }}><ArrowDown className="w-3.5 h-3.5" /></Button>
                          <Button type="button" size="sm" variant="ghost" className="h-7 px-1.5 text-destructive" aria-label={`Togli la regola ${i + 1}`}
                            onClick={() => { setBozza((b) => b.filter((_, j) => j !== i)); setAnteprima(null); }}><X className="w-3.5 h-3.5" /></Button>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy || bozza.length >= elenco.massimoRegole}
                  onClick={() => { setBozza((b) => [...b, { tipo: "inizia", valore: "", rete: urbane[0]?.rete ?? RETE_EXTRAURBANA }]); setAnteprima(null); }}>
                  <Plus className="w-4 h-4 mr-1.5" />Aggiungi una regola
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy || !cambiate} onClick={() => void prova()}>Anteprima</Button>
                <Button type="button" size="sm" disabled={busy || !cambiate} onClick={() => void salvaRegole()}><Save className="w-3.5 h-3.5 mr-1" />Salva le regole</Button>
                {cambiate && (
                  <Button type="button" variant="ghost" size="sm" disabled={busy}
                    onClick={() => { setBozza(bozzaDa(elenco.regole)); setAnteprima(null); setProvate(false); }}>Annulla le modifiche</Button>
                )}
                <p className="text-xs text-muted-foreground">
                  {cambiate ? "Le regole in vigore sono ancora quelle salvate." : "Queste sono le regole in vigore."}
                </p>
              </div>
              {provate && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
              {anteprima && (
                <div role="status" className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm space-y-2">
                  <p>{riassuntoAnteprima(anteprima)}</p>
                  {anteprima.cambiano.length > 0 && (
                    <ul className="max-h-56 overflow-y-auto text-xs space-y-0.5">
                      {anteprima.cambiano.map((c) => (
                        <li key={c.linea}>
                          <span className="font-mono font-medium">{c.linea}</span>: da {etichettaDi(reti, c.da)} a {etichettaDi(reti, c.a)}
                          {c.cambiaServizio && <span className="ml-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px">cambia il riposo nel Roster</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Le linee già assegnate a una rete nella pagina Tariffe restano dove sono: le regole danno la rete proposta, e valgono subito per il Roster.
                  </p>
                </div>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModuloReteForm({ iniziale, urbana, nuova = false, chiave, busy, onSalva, onAnnulla }: {
  iniziale: ModuloRete; urbana: boolean; nuova?: boolean; chiave: string; busy: boolean; onSalva: (m: ModuloRete) => void; onAnnulla: () => void;
}) {
  const [m, setM] = useState(iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriRete(m, urbana, nuova);
  const id = (k: string) => `rete-${chiave}-${k}`;
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (!errori.length) onSalva(m); }}>
      <div className="flex flex-wrap items-end gap-3">
        {urbana && (
          <>
            <div className="space-y-1">
              <Label htmlFor={id("luogo")} className="text-xs">Luogo</Label>
              <Input id={id("luogo")} value={m.luogo} className="h-8 w-44" maxLength={40} placeholder="Pesaro"
                onChange={(e) => setM({ ...m, luogo: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id("sigla")} className="text-xs">Sigla</Label>
              <Input id={id("sigla")} value={m.sigla} className="h-8 w-20 font-mono uppercase" maxLength={4}
                placeholder={nuova ? siglaDaLuogo(m.luogo) || "PS" : undefined} onChange={(e) => setM({ ...m, sigla: e.target.value })} />
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label htmlFor={id("nome")} className="text-xs">Nome nel GTFS{urbana && nuova ? " (facoltativo)" : ""}</Label>
          <Input id={id("nome")} value={m.nome} className="h-8 w-64" maxLength={60}
            placeholder={urbana && nuova ? `Urbano di ${m.luogo.trim() || "…"}` : undefined} onChange={(e) => setM({ ...m, nome: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("colore")} className="block text-xs">Colore</Label>
          <input id={id("colore")} type="color" className="block h-8 w-12 rounded-md border border-input bg-background p-0.5"
            value={/^#[0-9a-f]{6}$/i.test(m.colore) ? m.colore : "#64748b"} onChange={(e) => setM({ ...m, colore: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("ordine")} className="text-xs">Ordine</Label>
          <Input id={id("ordine")} value={m.ordine} className="h-8 w-20" inputMode="numeric" maxLength={4}
            placeholder={nuova ? "in fondo" : undefined} onChange={(e) => setM({ ...m, ordine: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("corrispettivo")} className="text-xs">Corrispettivo €/km</Label>
          <Input id={id("corrispettivo")} value={m.corrispettivo} className="h-8 w-24" inputMode="decimal" maxLength={5} placeholder="1,66"
            onChange={(e) => setM({ ...m, corrispettivo: e.target.value })} />
        </div>
        <label htmlFor={id("vuoti")} className="flex h-8 items-center gap-1.5 text-xs">
          <input id={id("vuoti")} type="checkbox" checked={m.suVuoti} onChange={(e) => setM({ ...m, suVuoti: e.target.checked })} />
          anche sui km a vuoto
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Il corrispettivo €/km, al netto dell'IVA, lo fissa la Regione (per gli urbani, comune per comune). Con la spunta il calcolo dei turni macchina
        considera compensati i km a vuoto di questa rete (uscite, rientri, trasferimenti); senza, li conta a costo pieno.
      </p>
      <p className="text-xs text-muted-foreground">
        {!urbana ? "L'extraurbano c'è sempre: si cambiano il nome, il colore, l'ordine e il corrispettivo."
          : nuova ? "L'identificativo, la zona tariffaria e il codice delle fermate li ricava il programma dal luogo, e non cambiano più. Se non scegli il colore lo sceglie lui."
            : "L'identificativo, la zona tariffaria e il codice delle fermate restano quelli, anche se cambi il luogo."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="h-8" disabled={busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}
