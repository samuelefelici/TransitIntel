/**
 * Il catalogo dei titoli di viaggio (tappa 6.9), nella pagina
 * Amministrazione › Azienda: i biglietti e gli abbonamenti dell'azienda, da
 * cui si riempie un feed nella pagina Tariffe. Sono raggruppati per rete, e
 * ogni riga si salva da sé. L'identificativo non cambia: è quello del GTFS.
 * API: /api/admin/titoli. I conti in lib/titoli-catalogo.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Plus, Save, Ticket, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useReti } from "@/hooks/use-reti";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { etichettaDi, etichettaRete, type Rete } from "@/lib/reti";
import {
  corpoModificaTitolo, corpoNuovoTitolo, durataInParole, erroriTitolo, euro, idDaNome, moduloDa, moduloVuoto, NOME_TIPO, riassuntoCatalogo,
  TIPI_TITOLO, TIPO_IN_BREVE, titoliPerRete, type ElencoTitoli, type ModuloTitolo, type TipoTitolo, type TitoloCatalogo,
} from "@/lib/titoli-catalogo";

const SELECT = "block h-8 rounded-md border border-input bg-background px-2 text-sm";

export default function TitoliCatalogo() {
  const { toast } = useToast();
  const reti = useReti();
  const [elenco, setElenco] = useState<ElencoTitoli | null>(null);
  const [busy, setBusy] = useState(false);
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState(false);

  const carica = useCallback(async () => {
    try { setElenco(await apiFetch<ElencoTitoli>("/api/admin/titoli")); }
    catch (e: any) { toast({ title: "Catalogo non letto", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const esegui = async (fatto: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast({ title: fatto }); await carica(); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const togli = (t: TitoloCatalogo) => {
    if (!window.confirm(`Tolgo «${t.nome}» dal catalogo? I feed che l'hanno già copiato lo tengono.`)) return;
    void esegui(`${t.nome} tolto`, () => apiFetch(`/api/admin/titoli/${encodeURIComponent(t.titolo)}`, { method: "DELETE" }));
  };

  const titoli = elenco?.titoli ?? [];
  const categorie = [...new Set(["ordinario", ...titoli.map((t) => t.categoria)])].sort();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Ticket className="w-4 h-4 text-primary" aria-hidden /> Titoli di viaggio</CardTitle>
        <p className="text-xs text-muted-foreground">
          Il catalogo dei biglietti e degli abbonamenti dell'azienda. Nella pagina Tariffe, chi riempie un feed copia da qui i titoli che mancano;
          quelli che nel feed ci sono già non si toccano. I biglietti extraurbani di corsa semplice non stanno qui: sono uno per fascia chilometrica.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!elenco ? <div className="text-sm text-muted-foreground">Carico il catalogo…</div> : (
          <>
            <p className="text-sm">{riassuntoCatalogo(titoli)}</p>
            {titoliPerRete(titoli, reti).map((g) => (
              <details key={g.rete} className="rounded-md border border-border/50">
                <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
                  {etichettaDi(reti, g.rete)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{g.titoli.length === 1 ? "un titolo" : `${g.titoli.length} titoli`}</span>
                </summary>
                <div className="overflow-x-auto border-t border-border/50">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                      <th className="px-3 py-1.5">Titolo</th><th className="px-2 py-1.5">Tipo</th><th className="px-2 py-1.5">Durata</th>
                      <th className="px-2 py-1.5 text-right">Prezzo</th><th className="px-2 py-1.5" />
                    </tr></thead>
                    <tbody>
                      {g.titoli.map((t) => aperto === t.titolo ? (
                        <tr key={t.titolo} className="bg-muted/30"><td colSpan={5} className="px-3 py-2">
                          <ModuloTitoloForm iniziale={moduloDa(t)} reti={reti} categorie={categorie} busy={busy} onAnnulla={() => setAperto(null)}
                            onSalva={async (m) => {
                              const ok = await esegui(`${m.nome.trim()} salvato`, () =>
                                apiFetch(`/api/admin/titoli/${encodeURIComponent(t.titolo)}`, { method: "PUT", body: JSON.stringify(corpoModificaTitolo(m)) }));
                              if (ok) setAperto(null);
                            }} />
                        </td></tr>
                      ) : (
                        <tr key={t.titolo} className="border-t border-border/40 align-top">
                          <td className="px-3 py-1.5">
                            <span className="font-medium">{t.nome}{t.fascia !== null ? ` — Fascia ${t.fascia}` : ""}</span>
                            <span className="block text-xs text-muted-foreground">
                              <span className="font-mono">{t.titolo}</span>
                              {t.categoria !== "ordinario" ? ` · ${t.categoria}` : ""}
                              {t.diRiferimento ? " · biglietto di riferimento della rete" : ""}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap" title={NOME_TIPO[t.tipo]}>{TIPO_IN_BREVE[t.tipo]}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">{durataInParole(t.durataMinuti)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{euro(t.prezzo)} €</td>
                          <td className="px-2 py-1.5 text-right whitespace-nowrap">
                            <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => { setNuovo(false); setAperto(t.titolo); }}>Modifica</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => togli(t)}
                              aria-label={`Togli ${t.nome}${t.fascia !== null ? `, fascia ${t.fascia}` : ""}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
            {nuovo ? (
              <ModuloTitoloForm iniziale={moduloVuoto(reti[0]?.rete ?? "")} nuovo reti={reti} categorie={categorie} busy={busy} onAnnulla={() => setNuovo(false)}
                onSalva={async (m) => {
                  const ok = await esegui(`${m.nome.trim()} aggiunto`, () =>
                    apiFetch("/api/admin/titoli", { method: "POST", body: JSON.stringify(corpoNuovoTitolo(m)) }));
                  if (ok) setNuovo(false);
                }} />
            ) : titoli.length >= elenco.massimo ? (
              <p className="text-xs text-muted-foreground">Il catalogo ha {elenco.massimo} titoli, il massimo.</p>
            ) : (
              <Button variant="outline" size="sm" onClick={() => { setAperto(null); setNuovo(true); }} disabled={busy}>
                <Plus className="w-4 h-4 mr-1.5" />Aggiungi un titolo
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Un prezzo cambiato qui vale per i feed riempiti da adesso. Per portarlo in un feed che ha già il titolo: pagina Tariffe, «Prodotti & Supporti», «Allinea al catalogo».
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModuloTitoloForm({ iniziale, nuovo = false, reti, categorie, busy, onSalva, onAnnulla }: {
  iniziale: ModuloTitolo; nuovo?: boolean; reti: readonly Rete[]; categorie: string[]; busy: boolean;
  onSalva: (m: ModuloTitolo) => void; onAnnulla: () => void;
}) {
  const [m, setM] = useState(iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriTitolo(m, nuovo, reti);
  const rete = reti.find((r) => r.rete === m.rete);
  const urbana = rete?.tipo === "urbano";
  const id = (k: string) => `titolo-${nuovo ? "nuovo" : iniziale.titolo}-${k}`;
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (!errori.length) onSalva(m); }}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={id("nome")} className="text-xs">Nome</Label>
          <Input id={id("nome")} value={m.nome} className="h-8 w-80 max-w-full" maxLength={120} onChange={(e) => setM({ ...m, nome: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("titolo")} className="text-xs">Identificativo{nuovo ? " (facoltativo)" : ""}</Label>
          <Input id={id("titolo")} value={m.titolo} className="h-8 w-56 font-mono" maxLength={60} disabled={!nuovo}
            placeholder={nuovo ? idDaNome(m.nome) || "dal nome" : undefined} onChange={(e) => setM({ ...m, titolo: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={id("rete")} className="block text-xs">Rete</Label>
          <select id={id("rete")} className={SELECT} value={m.rete}
            onChange={(e) => setM({ ...m, rete: e.target.value, fascia: "", diRiferimento: false })}>
            {!rete && <option value={m.rete}>scegli…</option>}
            {reti.map((r) => <option key={r.rete} value={r.rete}>{etichettaRete(r)}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("tipo")} className="block text-xs">Tipo</Label>
          <select id={id("tipo")} className={SELECT} value={m.tipo}
            onChange={(e) => setM({ ...m, tipo: e.target.value as TipoTitolo, diRiferimento: e.target.value === "single" ? m.diRiferimento : false })}>
            {TIPI_TITOLO.map((tipo) => <option key={tipo} value={tipo}>{NOME_TIPO[tipo]}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("categoria")} className="text-xs">Categoria</Label>
          <Input id={id("categoria")} value={m.categoria} className="h-8 w-40" maxLength={40} list={id("categorie")} onChange={(e) => setM({ ...m, categoria: e.target.value })} />
          <datalist id={id("categorie")}>{categorie.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("prezzo")} className="text-xs">Prezzo (€)</Label>
          <Input id={id("prezzo")} value={m.prezzo} className="h-8 w-24 tabular-nums" inputMode="decimal" maxLength={9} onChange={(e) => setM({ ...m, prezzo: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id("durata")} className="text-xs">Durata (minuti)</Label>
          <Input id={id("durata")} value={m.durata} className="h-8 w-28 tabular-nums" inputMode="numeric" maxLength={7} placeholder="nessuna"
            onChange={(e) => setM({ ...m, durata: e.target.value })} />
        </div>
        {!urbana && (
          <div className="space-y-1">
            <Label htmlFor={id("fascia")} className="text-xs">Fascia</Label>
            <Input id={id("fascia")} value={m.fascia} className="h-8 w-20 tabular-nums" inputMode="numeric" maxLength={2} placeholder="nessuna"
              onChange={(e) => setM({ ...m, fascia: e.target.value })} />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={id("ordine")} className="text-xs">Ordine</Label>
          <Input id={id("ordine")} value={m.ordine} className="h-8 w-20" inputMode="numeric" maxLength={5}
            placeholder={nuovo ? "in fondo" : undefined} onChange={(e) => setM({ ...m, ordine: e.target.value })} />
        </div>
      </div>
      {urbana && m.tipo === "single" && (
        <label htmlFor={id("riferimento")} className="flex items-center gap-2 text-sm">
          <input id={id("riferimento")} type="checkbox" checked={m.diRiferimento} onChange={(e) => setM({ ...m, diRiferimento: e.target.checked })} />
          È il biglietto di riferimento della rete: con questo si dà il prezzo di una corsa urbana (uno solo per rete)
        </label>
      )}
      <p className="text-xs text-muted-foreground">
        Durata: 60 è un'ora, 1440 un giorno, 43200 trenta giorni. Un biglietto urbano con una durata ha la sua regola di tratta nel GTFS.
        {!urbana ? " Fascia: solo per un titolo che ha un prezzo per ogni fascia chilometrica; nel feed il nome prende la fascia e i suoi chilometri." : ""}
        {nuovo ? " L'identificativo è quello che finisce nel GTFS, e non si cambia più." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="h-8" disabled={busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}
