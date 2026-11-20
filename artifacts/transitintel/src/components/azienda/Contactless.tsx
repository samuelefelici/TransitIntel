/**
 * Il pagamento con carta a bordo (tappa 6.38), nella pagina Amministrazione ›
 * Azienda: le reti dove vale, le tariffe per tipo di rete (primo, secondo e
 * terzo viaggio, validità, massimale), il massimale unico, la finestra di ore
 * e il supporto. Si scrive in bozza e si salva tutto insieme.
 * API: /api/admin/contactless. I conti in lib/contactless.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { CreditCard, Save } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  bozzaCambiata, bozzaDa, corpoDa, erroriBozza, NOME_TIPO, riassunto, tariffaInBreve, TIPI_CONTACTLESS,
  type BozzaContactless, type Contactless as RegoleCarta, type ElencoContactless, type RigaTariffa, type TipoContactless,
} from "@/lib/contactless";

const SELECT = "h-8 rounded-md border border-input bg-background px-2 text-sm";
const CAMPI: { chiave: keyof Omit<RigaTariffa, "attiva">; titolo: string; aiuto: string }[] = [
  { chiave: "primo", titolo: "1° viaggio (€)", aiuto: "il prezzo del primo tap" },
  { chiave: "validita", titolo: "Vale (minuti)", aiuto: "i viaggi che cominciano entro questi minuti dal primo tap non si pagano" },
  { chiave: "secondo", titolo: "2° viaggio (€)", aiuto: "dopo la validità del primo" },
  { chiave: "terzo", titolo: "3° viaggio (€)", aiuto: "" },
  { chiave: "massimale", titolo: "Massimale (€)", aiuto: "il più che si paga nella finestra di ore" },
];

export default function Contactless() {
  const { toast } = useToast();
  const [elenco, setElenco] = useState<ElencoContactless | null>(null);
  const [bozza, setBozza] = useState<BozzaContactless | null>(null);
  const [busy, setBusy] = useState(false);
  const [provato, setProvato] = useState(false);

  const carica = useCallback(async () => {
    try {
      const e = await apiFetch<ElencoContactless>("/api/admin/contactless");
      setElenco(e); setBozza(bozzaDa(e.contactless)); setProvato(false);
    } catch (e: any) { toast({ title: "Pagamento con carta non letto", description: e?.message, variant: "destructive" }); }
  }, [toast]);
  useEffect(() => { void carica(); }, [carica]);

  const errori = elenco && bozza ? erroriBozza(bozza, elenco) : [];
  const cambiata = elenco && bozza ? bozzaCambiata(bozza, elenco.contactless) : false;
  const tariffa = (tipo: TipoContactless, parte: Partial<RigaTariffa>) =>
    setBozza((b) => (b ? { ...b, tariffe: { ...b.tariffe, [tipo]: { ...b.tariffe[tipo], ...parte } } } : b));
  const rete = (r: string, si: boolean) =>
    setBozza((b) => (b ? { ...b, reti: si ? [...new Set([...b.reti, r])].sort() : b.reti.filter((x) => x !== r) } : b));

  const salva = async () => {
    if (!bozza) return;
    setProvato(true);
    if (errori.length) return;
    setBusy(true);
    try {
      const r = await apiFetch<{ contactless: RegoleCarta }>("/api/admin/contactless", { method: "PUT", body: JSON.stringify(corpoDa(bozza)) });
      setElenco((e) => (e ? { ...e, contactless: r.contactless } : e)); setBozza(bozzaDa(r.contactless)); setProvato(false);
      toast({ title: "Pagamento con carta salvato", description: "Entra nel GTFS dal prossimo export e nei dati aperti alla preparazione successiva." });
    } catch (e: any) { toast({ title: "Non riuscito", description: e?.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const salvate = elenco?.contactless;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><CreditCard className="w-4 h-4 text-primary" aria-hidden /> Pagamento con carta a bordo</CardTitle>
        <p className="text-xs text-muted-foreground">
          Dove il sistema di bigliettazione lo permette, si sale avvicinando al validatore una carta bancaria contactless, o uno smartphone o un orologio con un portafoglio digitale.
          Il sistema conta i tap e addebita secondo le regole di chi fissa le tariffe.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!elenco || !bozza || !salvate ? <div className="text-sm text-muted-foreground">Carico il pagamento con carta…</div> : (
          <>
            <p className="text-sm">{riassunto(salvate, elenco)}</p>
            {salvate.tariffe.length > 0 && salvate.reti.length > 0 && (
              <ul className="text-xs text-muted-foreground space-y-0.5">
                {salvate.tariffe.map((t) => <li key={t.tipo}><span className="font-medium text-foreground">{NOME_TIPO[t.tipo]}</span>: {tariffaInBreve(t, salvate.finestraOre)}</li>)}
              </ul>
            )}

            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Dove vale</legend>
              {elenco.retiDisponibili.length === 0 ? (
                <p className="text-xs text-muted-foreground">Non c'è nessuna rete: aggiungile prima in «Reti e linee».</p>
              ) : (
                <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                  {elenco.retiDisponibili.map((r) => (
                    <label key={r.rete} htmlFor={`carta-rete-${r.rete}`} className="flex items-center gap-1.5 text-sm">
                      <input id={`carta-rete-${r.rete}`} type="checkbox" checked={bozza.reti.includes(r.rete)} onChange={(e) => rete(r.rete, e.target.checked)} />
                      {r.nome}
                      <span className="text-xs text-muted-foreground">({r.tipo === "urbano" ? "urbana" : "tutte le linee extraurbane"})</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Tariffe per tipo di rete</legend>
              <div className="overflow-x-auto rounded-md border border-border/50">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="text-xs text-muted-foreground bg-card"><tr className="text-left">
                    <th className="px-3 py-1.5">Tipo</th>
                    {CAMPI.map((c) => <th key={c.chiave} className="px-2 py-1.5 font-normal" title={c.aiuto || undefined}>{c.titolo}</th>)}
                  </tr></thead>
                  <tbody>
                    {TIPI_CONTACTLESS.map((tipo) => {
                      const r = bozza.tariffe[tipo];
                      return (
                        <tr key={tipo} className="border-t border-border/40">
                          <td className="px-3 py-1">
                            <label htmlFor={`carta-${tipo}-attiva`} className="flex items-center gap-1.5">
                              <input id={`carta-${tipo}-attiva`} type="checkbox" checked={r.attiva} onChange={(e) => tariffa(tipo, { attiva: e.target.checked })} />
                              {NOME_TIPO[tipo]}
                            </label>
                          </td>
                          {CAMPI.map((c) => (
                            <td key={c.chiave} className="px-2 py-1">
                              <Label htmlFor={`carta-${tipo}-${c.chiave}`} className="sr-only">{NOME_TIPO[tipo]}: {c.titolo}</Label>
                              <Input id={`carta-${tipo}-${c.chiave}`} value={r[c.chiave]} disabled={!r.attiva} className="h-8 w-20 tabular-nums"
                                inputMode={c.chiave === "validita" ? "numeric" : "decimal"} maxLength={7}
                                onChange={(e) => tariffa(tipo, { [c.chiave]: e.target.value })} />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </fieldset>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="carta-massimale-unico">Massimale unico (€)</Label>
                <Input id="carta-massimale-unico" value={bozza.massimaleUnico} className="h-8 w-28 tabular-nums" inputMode="decimal" maxLength={7}
                  onChange={(e) => setBozza({ ...bozza, massimaleUnico: e.target.value })} />
                <p className="text-xs text-muted-foreground">Se nella finestra si usano urbano ed extraurbano. Vuoto se non c'è.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="carta-finestra">Finestra (ore)</Label>
                <Input id="carta-finestra" value={bozza.finestraOre} className="h-8 w-20 tabular-nums" inputMode="numeric" maxLength={2}
                  onChange={(e) => setBozza({ ...bozza, finestraOre: e.target.value })} />
                <p className="text-xs text-muted-foreground">Dal primo tap: ci si contano i viaggi e i massimali.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="carta-supporto">Supporto</Label>
                <select id="carta-supporto" className={`${SELECT} block w-full max-w-[16rem]`} value={bozza.supporto}
                  onChange={(e) => setBozza({ ...bozza, supporto: e.target.value })}>
                  <option value="">Nessuno</option>
                  {elenco.supportiDisponibili.map((s) => <option key={s.supporto} value={s.supporto}>{s.nome}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">Fra i supporti delle tariffe: quello della carta bancaria.</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" disabled={busy || !cambiata} onClick={() => void salva()}><Save className="w-3.5 h-3.5 mr-1" />Salva il pagamento con carta</Button>
              {cambiata && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setBozza(bozzaDa(salvate)); setProvato(false); }}>Annulla le modifiche</Button>
              )}
              <p className="text-xs text-muted-foreground">{cambiata ? "In vigore restano le regole salvate." : "Queste sono le regole in vigore."}</p>
            </div>
            {provato && errori.length > 0 && <ul className="text-xs text-destructive">{errori.map((x) => <li key={x}>{x}</li>)}</ul>}
            <p className="text-xs text-muted-foreground">
              Nel GTFS entrano il prezzo del primo viaggio, la validità e il supporto: sulle reti scelte la carta è un'alternativa ai biglietti.
              Il prezzo dal secondo viaggio e i massimali nel GTFS non si possono scrivere; entreranno nel NeTEx delle tariffe.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
