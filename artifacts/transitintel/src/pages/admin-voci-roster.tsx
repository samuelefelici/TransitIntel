/**
 * Voci del roster (Amministrazione, solo admin; tappa 5.5): il catalogo delle
 * assenze e delle presenze che si scrivono nel tabellone, con le loro regole.
 * Prima stava nel codice; ora nella tabella roster_voci (migrazione 0034).
 *
 *   - una voce nuova: codice, categoria, nome, regole, codice per le paghe;
 *   - cambiare: nome, ordine, codice per le paghe, le regole della categoria;
 *   - «dato sanitario» si accende e non si spegne (le voci già scritte
 *     diventerebbero leggibili a chi non ha il permesso);
 *   - spegnere: non si offre più, quelle già scritte restano; cancellare solo
 *     una voce mai usata;
 *   - R e ASS sono di sistema: solo nome, ordine e codice per le paghe.
 *
 * API: GET, POST, PUT /:codice e DELETE /:codice su /api/admin/voci-roster.
 */
import { useCallback, useEffect, useState } from "react";
import { ListChecks, Plus, Save, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CODICE_NUOVO, CODICE_PAGHE, regoleDi, siCancella, usoDi, type VoceDelCatalogo } from "@/lib/voci-roster";

type Categoria = VoceDelCatalogo["categoria"];
const TITOLI: Record<Categoria, string> = { assenza: "Assenze", presenza: "Presenze" };
const selectCls = "h-9 rounded-md border border-input bg-background px-2 text-sm block";

interface Bozza { nome: string; codicePaghe: string; ordine: string; sanitaria: boolean; liberaTurno: boolean; aDisposizione: boolean }
const bozzaDi = (v: VoceDelCatalogo): Bozza => ({
  nome: v.nome, codicePaghe: v.codicePaghe ?? "", ordine: String(v.ordine),
  sanitaria: v.sanitaria, liberaTurno: v.liberaTurno, aDisposizione: v.aDisposizione,
});
const NUOVA = { codice: "", categoria: "assenza" as Categoria, nome: "", codicePaghe: "", liberaTurno: true, aDisposizione: false, sanitaria: false };

const avvisoSanitaria = "«Dato sanitario» non si spegne più da qui: chi non ha il permesso leggerà queste voci come «ASS – Assenza», anche quelle già scritte. Procedo?";

export default function AdminVociRosterPage() {
  const { toast } = useToast();
  const [voci, setVoci] = useState<VoceDelCatalogo[] | null>(null);
  const [aperta, setAperta] = useState<string | null>(null);
  const [nuova, setNuova] = useState(NUOVA);
  const [busy, setBusy] = useState(false);

  const carica = useCallback(async () => {
    try { setVoci((await apiFetch<{ voci: VoceDelCatalogo[] }>("/api/admin/voci-roster")).voci); }
    catch (e: any) { toast({ title: "Catalogo non letto", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const esegui = async (fatto: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast({ title: fatto }); await carica(); return true; }
    catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); return false; }
    finally { setBusy(false); }
  };

  const crea = async () => {
    if (nuova.sanitaria && !window.confirm(avvisoSanitaria)) return;
    const corpo = {
      codice: nuova.codice, categoria: nuova.categoria, nome: nuova.nome.trim(), codicePaghe: nuova.codicePaghe.trim() || null,
      ...(nuova.categoria === "assenza" ? { liberaTurno: nuova.liberaTurno, sanitaria: nuova.sanitaria } : { aDisposizione: nuova.aDisposizione }),
    };
    if (await esegui(`Voce ${nuova.codice} aggiunta`, () => apiFetch("/api/admin/voci-roster", { method: "POST", body: JSON.stringify(corpo) }))) setNuova(NUOVA);
  };
  const nuovaValida = CODICE_NUOVO.test(nuova.codice) && nuova.nome.trim().length > 0 && (!nuova.codicePaghe.trim() || CODICE_PAGHE.test(nuova.codicePaghe.trim()));

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <ListChecks className="w-6 h-6 text-primary mt-0.5" />
        <div>
          <h1 className="text-xl font-semibold">Voci del roster</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Le assenze e le presenze che si scrivono nel tabellone, con le loro regole. Una voce spenta non si offre più, ma quelle
            già scritte restano; si cancella solo una voce mai usata. R e ASS sono di sistema. Ogni modifica va nel registro.
          </p>
        </div>
      </div>

      {voci === null ? <div className="text-sm text-muted-foreground">Carico il catalogo…</div> : (["assenza", "presenza"] as Categoria[]).map((cat) => (
        <Card key={cat}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{TITOLI[cat]}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border/50">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr className="text-left">
                  <th className="px-3 py-1.5">Codice</th><th className="px-3 py-1.5">Nome</th><th className="px-3 py-1.5">Regole</th>
                  <th className="px-3 py-1.5">Paghe</th><th className="px-3 py-1.5">Uso</th><th className="px-3 py-1.5" />
                </tr></thead>
                <tbody>
                  {voci.filter((v) => v.categoria === cat).map((v) => (
                    <RigaVoce key={v.codice} v={v} aperta={aperta === v.codice} busy={busy}
                      onApri={() => setAperta(aperta === v.codice ? null : v.codice)}
                      onSalva={async (m) => {
                        if (m.sanitaria && !v.sanitaria && !window.confirm(avvisoSanitaria)) return;
                        if (await esegui(`Voce ${v.codice} salvata`, () => apiFetch(`/api/admin/voci-roster/${encodeURIComponent(v.codice)}`, { method: "PUT", body: JSON.stringify(m) }))) setAperta(null);
                      }}
                      onAttiva={(attiva) => void esegui(attiva ? `Voce ${v.codice} riaccesa` : `Voce ${v.codice} spenta`,
                        () => apiFetch(`/api/admin/voci-roster/${encodeURIComponent(v.codice)}`, { method: "PUT", body: JSON.stringify({ attiva }) }))}
                      onCancella={() => {
                        if (!window.confirm(`Cancello la voce ${v.codice} – ${v.nome}?`)) return;
                        void esegui(`Voce ${v.codice} cancellata`, () => apiFetch(`/api/admin/voci-roster/${encodeURIComponent(v.codice)}`, { method: "DELETE" }));
                      }} />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Plus className="w-4 h-4" />Voce nuova</CardTitle></CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (nuovaValida) void crea(); }}>
            <div className="space-y-1">
              <Label htmlFor="voce-codice">Codice</Label>
              <Input id="voce-codice" value={nuova.codice} maxLength={8} className="w-28 font-mono uppercase" autoComplete="off"
                onChange={(e) => setNuova((n) => ({ ...n, codice: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="voce-categoria">Categoria</Label>
              <select id="voce-categoria" className={selectCls} value={nuova.categoria}
                onChange={(e) => setNuova((n) => ({ ...n, categoria: e.target.value as Categoria, sanitaria: false, aDisposizione: false, liberaTurno: e.target.value === "assenza" }))}>
                <option value="assenza">Assenza</option><option value="presenza">Presenza</option>
              </select>
            </div>
            <div className="space-y-1 flex-1 min-w-[12rem]">
              <Label htmlFor="voce-nome">Nome</Label>
              <Input id="voce-nome" value={nuova.nome} maxLength={80} onChange={(e) => setNuova((n) => ({ ...n, nome: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="voce-paghe">Codice per le paghe <span className="text-muted-foreground font-normal">(facoltativo)</span></Label>
              <Input id="voce-paghe" value={nuova.codicePaghe} maxLength={20} className="w-36 font-mono" onChange={(e) => setNuova((n) => ({ ...n, codicePaghe: e.target.value }))} />
            </div>
            <Regole categoria={nuova.categoria} valori={nuova} sanitariaBloccata={false} sistema={false} prefisso="voce-nuova"
              onCambia={(k, x) => setNuova((n) => ({ ...n, [k]: x }))} />
            <Button type="submit" disabled={!nuovaValida || busy}><Plus className="w-4 h-4 mr-1.5" />Aggiungi</Button>
          </form>
          <p className="text-xs text-muted-foreground mt-2">Codice: lettere maiuscole e cifre, al più 8. Codice e categoria non cambiano dopo.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Regole({ categoria, valori, sanitariaBloccata, sistema, prefisso, onCambia }: {
  categoria: Categoria; valori: { sanitaria: boolean; liberaTurno: boolean; aDisposizione: boolean };
  sanitariaBloccata: boolean; sistema: boolean; prefisso: string;
  onCambia: (k: "sanitaria" | "liberaTurno" | "aDisposizione", x: boolean) => void;
}) {
  const casella = (k: "sanitaria" | "liberaTurno" | "aDisposizione", testo: string, aiuto: string, bloccata: boolean) => (
    <label htmlFor={`${prefisso}-${k}`} className={`flex items-start gap-2 text-sm ${bloccata ? "opacity-60" : ""}`} title={aiuto}>
      <input id={`${prefisso}-${k}`} type="checkbox" className="mt-0.5" checked={valori[k]} disabled={bloccata} onChange={(e) => onCambia(k, e.target.checked)} />
      <span>{testo}</span>
    </label>
  );
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
      <legend className="sr-only">Regole</legend>
      {categoria === "assenza" ? (
        <>
          {casella("liberaTurno", "Libera il turno", "Il conducente manca: il suo turno torna da coprire. Spento per i riposi.", sistema)}
          {casella("sanitaria", "Dato sanitario", "Chi non ha il permesso la legge come ASS e non la scrive. Acceso, non si spegne.", sistema || sanitariaBloccata)}
        </>
      ) : casella("aDisposizione", "A disposizione", "Nella vestizione e nei sostituti il conducente è a disposizione.", false)}
    </fieldset>
  );
}

function RigaVoce({ v, aperta, busy, onApri, onSalva, onAttiva, onCancella }: {
  v: VoceDelCatalogo; aperta: boolean; busy: boolean; onApri: () => void;
  onSalva: (m: Record<string, unknown>) => Promise<void>; onAttiva: (attiva: boolean) => void; onCancella: () => void;
}) {
  const [b, setB] = useState<Bozza>(bozzaDi(v));
  useEffect(() => { if (aperta) setB(bozzaDi(v)); }, [aperta, v]);
  const ordine = Number(b.ordine);
  const valida = b.nome.trim().length > 0 && Number.isInteger(ordine) && ordine >= 0 && ordine <= 9999 && (!b.codicePaghe.trim() || CODICE_PAGHE.test(b.codicePaghe.trim()));
  const salva = () => {
    const m: Record<string, unknown> = { nome: b.nome.trim(), codicePaghe: b.codicePaghe.trim() || null, ordine };
    if (!v.diSistema) {
      if (v.categoria === "assenza") { m.liberaTurno = b.liberaTurno; if (!v.sanitaria && b.sanitaria) m.sanitaria = true; }
      else m.aDisposizione = b.aDisposizione;
    }
    void onSalva(m);
  };
  return (
    <>
      <tr className={`border-t border-border/40 align-top ${v.attiva ? "" : "opacity-60"}`}>
        <td className="px-3 py-1.5 font-mono font-semibold whitespace-nowrap">{v.codice}</td>
        <td className="px-3 py-1.5">
          {v.nome}
          <div className="text-xs text-muted-foreground">{[v.diSistema ? "di sistema" : null, v.attiva ? null : "spenta"].filter(Boolean).join(" · ")}</div>
        </td>
        <td className="px-3 py-1.5">
          <div className="flex flex-wrap gap-1">
            {regoleDi(v).map((r) => (
              <span key={r} className={`rounded border px-1.5 py-0.5 text-xs ${r === "dato sanitario" ? "border-rose-500/50 text-rose-300" : "border-border/60 text-muted-foreground"}`}>{r}</span>
            ))}
          </div>
        </td>
        <td className="px-3 py-1.5 font-mono text-xs">{v.codicePaghe ?? <span className="font-sans text-muted-foreground">—</span>}</td>
        <td className="px-3 py-1.5 text-xs text-muted-foreground">{usoDi(v)}</td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap space-x-1">
          <Button size="sm" variant={aperta ? "secondary" : "outline"} className="h-7" onClick={onApri} aria-expanded={aperta} disabled={busy}>Modifica</Button>
          {!v.diSistema && (
            <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => onAttiva(!v.attiva)}>{v.attiva ? "Spegni" : "Riaccendi"}</Button>
          )}
          {siCancella(v) && (
            <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={onCancella} aria-label={`Cancella ${v.codice}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </td>
      </tr>
      {aperta && (
        <tr className="bg-muted/30">
          <td colSpan={6} className="px-3 py-2">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (valida) salva(); }}>
              <div className="space-y-1 flex-1 min-w-[12rem]">
                <Label htmlFor={`voce-${v.codice}-nome`} className="text-xs">Nome</Label>
                <Input id={`voce-${v.codice}-nome`} value={b.nome} maxLength={80} className="h-8" onChange={(e) => setB({ ...b, nome: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`voce-${v.codice}-paghe`} className="text-xs">Codice per le paghe</Label>
                <Input id={`voce-${v.codice}-paghe`} value={b.codicePaghe} maxLength={20} className="h-8 w-32 font-mono" onChange={(e) => setB({ ...b, codicePaghe: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`voce-${v.codice}-ordine`} className="text-xs">Ordine</Label>
                <Input id={`voce-${v.codice}-ordine`} value={b.ordine} inputMode="numeric" className="h-8 w-20" onChange={(e) => setB({ ...b, ordine: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
              </div>
              <Regole categoria={v.categoria} valori={b} sanitariaBloccata={v.sanitaria} sistema={v.diSistema} prefisso={`voce-${v.codice}`}
                onCambia={(k, x) => setB({ ...b, [k]: x })} />
              <Button type="submit" size="sm" className="h-8" disabled={!valida || busy}><Save className="w-3.5 h-3.5 mr-1" />Salva</Button>
              <Button type="button" size="sm" variant="ghost" className="h-8" onClick={onApri}>Annulla</Button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
