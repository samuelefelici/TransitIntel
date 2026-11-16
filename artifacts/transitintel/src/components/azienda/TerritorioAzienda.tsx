/**
 * Il territorio dell'azienda (tappa 6.1), sotto i dati dell'azienda nella
 * pagina Amministrazione › Azienda: i comuni (per nome nelle analisi, e per
 * l'import della popolazione) e i luoghi di riferimento per uso. Ogni riga si
 * salva da sé. API: /api/admin/territorio. I conti in lib/territorio.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { Landmark, MapPinned, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  coordinate, corpoComune, corpoLuogo, erroriComune, erroriLuogo, MODULO_COMUNE_VUOTO, moduloComuneDa, moduloLuogoDa, moduloLuogoVuoto, USI,
  type Comune, type Luogo, type ModuloComune, type ModuloLuogo, type UsoLuogo,
} from "@/lib/territorio";

const nf = (n: number | null, cifre = 0) => (n == null ? "—" : n.toLocaleString("it-IT", { maximumFractionDigits: cifre }));

export default function TerritorioAzienda() {
  const { toast } = useToast();
  const [dati, setDati] = useState<{ comuni: Comune[]; luoghi: Luogo[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const carica = useCallback(async () => {
    try { setDati(await apiFetch<{ comuni: Comune[]; luoghi: Luogo[] }>("/api/admin/territorio")); }
    catch (e: any) { toast({ title: "Territorio non letto", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const esegui = async (fatto: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast({ title: fatto }); await carica(); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  if (!dati) return <div className="text-sm text-muted-foreground">Carico il territorio…</div>;
  return (
    <>
      <Comuni comuni={dati.comuni} busy={busy}
        onSalva={(m) => esegui(`Comune ${m.nome.trim()} salvato`, () =>
          apiFetch(`/api/admin/territorio/comuni/${encodeURIComponent(m.codiceIstat.trim())}`, { method: "PUT", body: JSON.stringify(corpoComune(m)) }))}
        onTogli={(c) => {
          if (!window.confirm(`Tolgo ${c.nome} (${c.codiceIstat}) dal territorio? Le analisi lo chiameranno «Comune ${c.codiceIstat}».`)) return;
          void esegui(`${c.nome} tolto`, () => apiFetch(`/api/admin/territorio/comuni/${c.codiceIstat}`, { method: "DELETE" }));
        }} />
      <Luoghi luoghi={dati.luoghi} busy={busy}
        onCrea={(m) => esegui(`${m.nome.trim()} aggiunto`, () => apiFetch("/api/admin/territorio/luoghi", { method: "POST", body: JSON.stringify(corpoLuogo(m)) }))}
        onSalva={(id, m) => esegui(`${m.nome.trim()} salvato`, () => apiFetch(`/api/admin/territorio/luoghi/${id}`, { method: "PUT", body: JSON.stringify(corpoLuogo(m)) }))}
        onTogli={(l) => {
          if (!window.confirm(`Tolgo ${l.nome}?`)) return;
          void esegui(`${l.nome} tolto`, () => apiFetch(`/api/admin/territorio/luoghi/${l.id}`, { method: "DELETE" }));
        }} />
    </>
  );
}

/* ── I comuni ─────────────────────────────────────────────────────────────── */

function Comuni({ comuni, busy, onSalva, onTogli }: {
  comuni: Comune[]; busy: boolean; onSalva: (m: ModuloComune) => Promise<boolean>; onTogli: (c: Comune) => void;
}) {
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState<ModuloComune | null>(null);
  const attuali = comuni.filter((c) => !c.soppresso).length;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Landmark className="w-4 h-4 text-primary" aria-hidden /> Comuni del territorio</CardTitle>
        <p className="text-xs text-muted-foreground">
          {attuali} comuni{comuni.length > attuali ? `, ${comuni.length - attuali} soppressi` : ""}. Danno il nome ai comuni nelle analisi e negli scenari;
          centroide, superficie e popolazione servono all'import della popolazione. I soppressi restano per i dati del 2011.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {comuni.length === 0 && <div className="text-sm text-muted-foreground">Nessun comune: le analisi scrivono «Comune» e il codice ISTAT.</div>}
        {comuni.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border/50 max-h-[28rem] overflow-y-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-xs text-muted-foreground sticky top-0 bg-card"><tr className="text-left">
                <th className="px-3 py-1.5">Codice</th><th className="px-3 py-1.5">Nome</th><th className="px-3 py-1.5">Centroide</th>
                <th className="px-3 py-1.5 text-right">km²</th><th className="px-3 py-1.5 text-right">Abitanti</th><th className="px-3 py-1.5" />
              </tr></thead>
              <tbody>
                {comuni.map((c) => aperto === c.codiceIstat ? (
                  <tr key={c.codiceIstat} className="bg-muted/30"><td colSpan={6} className="px-3 py-2">
                    <ModuloComuneForm iniziale={moduloComuneDa(c)} codiceFisso busy={busy}
                      onSalva={async (m) => { if (await onSalva(m)) setAperto(null); }} onAnnulla={() => setAperto(null)} />
                  </td></tr>
                ) : (
                  <tr key={c.codiceIstat} className={`border-t border-border/40 ${c.soppresso ? "opacity-60" : ""}`}>
                    <td className="px-3 py-1.5 font-mono tabular-nums">{c.codiceIstat}</td>
                    <td className="px-3 py-1.5">{c.nome}{c.soppresso && <span className="text-xs text-muted-foreground"> · soppresso</span>}</td>
                    <td className="px-3 py-1.5 tabular-nums text-xs">{coordinate(c.lat, c.lng)}</td>
                    <td className="px-3 py-1.5 tabular-nums text-right">{nf(c.areaKm2, 1)}</td>
                    <td className="px-3 py-1.5 tabular-nums text-right">{nf(c.popolazione)}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => setAperto(c.codiceIstat)}>Modifica</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => onTogli(c)} aria-label={`Togli ${c.nome}`}>
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
          <ModuloComuneForm iniziale={nuovo} busy={busy} onSalva={async (m) => { if (await onSalva(m)) setNuovo(null); }} onAnnulla={() => setNuovo(null)} />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setNuovo(MODULO_COMUNE_VUOTO)} disabled={busy}><Plus className="w-4 h-4 mr-1.5" />Aggiungi un comune</Button>
        )}
      </CardContent>
    </Card>
  );
}

function ModuloComuneForm({ iniziale, codiceFisso = false, busy, onSalva, onAnnulla }: {
  iniziale: ModuloComune; codiceFisso?: boolean; busy: boolean; onSalva: (m: ModuloComune) => void; onAnnulla: () => void;
}) {
  const [m, setM] = useState(iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriComune(m);
  const id = (k: string) => `comune-${iniziale.codiceIstat || "nuovo"}-${k}`;
  const casella = (k: keyof ModuloComune, etichetta: string, cls = "w-28", extra: Record<string, unknown> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={id(k)} className="text-xs">{etichetta}</Label>
      <Input id={id(k)} value={String(m[k])} className={`h-8 ${cls}`} onChange={(e) => setM({ ...m, [k]: e.target.value })} {...extra} />
    </div>
  );
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (!errori.length) onSalva(m); }}>
      <div className="flex flex-wrap items-end gap-3">
        {casella("codiceIstat", "Codice ISTAT", "w-28 font-mono", { disabled: codiceFisso, inputMode: "numeric", maxLength: 6, placeholder: "042002" })}
        {casella("nome", "Nome", "w-56", { maxLength: 80 })}
        {casella("lat", "Latitudine", "w-28", { inputMode: "decimal", placeholder: "43.6166" })}
        {casella("lng", "Longitudine", "w-28", { inputMode: "decimal", placeholder: "13.5185" })}
        {casella("areaKm2", "Superficie (km²)", "w-28", { inputMode: "decimal" })}
        {casella("popolazione", "Abitanti", "w-28", { inputMode: "numeric" })}
        <label htmlFor={id("soppresso")} className="flex items-center gap-2 text-sm pb-1.5">
          <input id={id("soppresso")} type="checkbox" checked={m.soppresso} onChange={(e) => setM({ ...m, soppresso: e.target.checked })} />
          Soppresso
        </label>
        <Button type="submit" size="sm" className="h-8" disabled={busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}

/* ── I luoghi ─────────────────────────────────────────────────────────────── */

function Luoghi({ luoghi, busy, onCrea, onSalva, onTogli }: {
  luoghi: Luogo[]; busy: boolean;
  onCrea: (m: ModuloLuogo) => Promise<boolean>; onSalva: (id: string, m: ModuloLuogo) => Promise<boolean>; onTogli: (l: Luogo) => void;
}) {
  const [aperto, setAperto] = useState<string | null>(null);
  const [nuovo, setNuovo] = useState<UsoLuogo | null>(null);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><MapPinned className="w-4 h-4 text-primary" aria-hidden /> Luoghi di riferimento</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {USI.map(([uso, titolo, spiega]) => {
          const di = luoghi.filter((l) => l.uso === uso);
          return (
            <section key={uso} className="space-y-2" aria-label={titolo}>
              <div>
                <h3 className="text-sm font-medium">{titolo} <span className="text-muted-foreground font-normal">· {di.length}</span></h3>
                <p className="text-xs text-muted-foreground">{spiega}</p>
              </div>
              {di.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border/50">
                  <table className="w-full min-w-[640px] text-sm">
                    <tbody>
                      {di.map((l) => aperto === l.id ? (
                        <tr key={l.id} className="bg-muted/30"><td colSpan={4} className="px-3 py-2">
                          <ModuloLuogoForm iniziale={moduloLuogoDa(l)} chiave={l.id} busy={busy}
                            onSalva={async (m) => { if (await onSalva(l.id, m)) setAperto(null); }} onAnnulla={() => setAperto(null)} />
                        </td></tr>
                      ) : (
                        <tr key={l.id} className="border-t border-border/40 first:border-t-0">
                          <td className="px-3 py-1.5">{l.nome}</td>
                          <td className="px-3 py-1.5 tabular-nums text-xs">{coordinate(l.lat, l.lng)}</td>
                          <td className="px-3 py-1.5 tabular-nums text-xs text-muted-foreground">{l.raggioM != null ? `raggio ${nf(l.raggioM / 1000, 1)} km` : ""}</td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap">
                            <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => setAperto(l.id)}>Modifica</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => onTogli(l)} aria-label={`Togli ${l.nome}`}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {nuovo === uso ? (
                <ModuloLuogoForm iniziale={moduloLuogoVuoto(uso)} chiave={`nuovo-${uso}`} busy={busy}
                  onSalva={async (m) => { if (await onCrea(m)) setNuovo(null); }} onAnnulla={() => setNuovo(null)} />
              ) : (
                <Button variant="outline" size="sm" onClick={() => setNuovo(uso)} disabled={busy}><Plus className="w-4 h-4 mr-1.5" />Aggiungi</Button>
              )}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ModuloLuogoForm({ iniziale, chiave, busy, onSalva, onAnnulla }: {
  iniziale: ModuloLuogo; chiave: string; busy: boolean; onSalva: (m: ModuloLuogo) => void; onAnnulla: () => void;
}) {
  const [m, setM] = useState(iniziale);
  const [provato, setProvato] = useState(false);
  const errori = erroriLuogo(m);
  const id = (k: string) => `luogo-${chiave}-${k}`;
  const casella = (k: keyof ModuloLuogo, etichetta: string, cls = "w-28", extra: Record<string, unknown> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={id(k)} className="text-xs">{etichetta}</Label>
      <Input id={id(k)} value={String(m[k])} className={`h-8 ${cls}`} onChange={(e) => setM({ ...m, [k]: e.target.value })} {...extra} />
    </div>
  );
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); setProvato(true); if (!errori.length) onSalva(m); }}>
      <div className="flex flex-wrap items-end gap-3">
        {casella("nome", "Nome", "w-64", { maxLength: 120 })}
        <div className="space-y-1">
          <Label htmlFor={id("uso")} className="text-xs">Uso</Label>
          <select id={id("uso")} className="h-8 rounded-md border border-input bg-background px-2 text-sm block" value={m.uso}
            onChange={(e) => { const uso = e.target.value as UsoLuogo; setM({ ...m, uso, raggioM: uso === "punti_interesse" ? m.raggioM || "3000" : "" }); }}>
            {USI.map(([u, t]) => <option key={u} value={u}>{t}</option>)}
          </select>
        </div>
        {casella("lat", "Latitudine", "w-28", { inputMode: "decimal" })}
        {casella("lng", "Longitudine", "w-28", { inputMode: "decimal" })}
        {m.uso === "punti_interesse" && casella("raggioM", "Raggio (m)", "w-24", { inputMode: "numeric" })}
        {casella("ordine", "Ordine", "w-20", { inputMode: "numeric" })}
        <Button type="submit" size="sm" className="h-8" disabled={busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onAnnulla}>Annulla</Button>
      </div>
      {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
    </form>
  );
}
