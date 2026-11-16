/**
 * Ruoli (Amministrazione, solo admin): che cosa dà ogni ruolo aziendale, area
 * per area — niente, lettura o scrittura. Prima era scritto solo nel codice;
 * ora l'amministratore lo cambia da qui (PR 2.18, migrazione 0015).
 * API: GET /api/admin/ruoli e PUT /api/admin/ruoli/:ruolo. La logica è in
 * lib/ruoli-admin.ts; chi può davvero fare una cosa lo decide sempre l'API.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Info, RotateCcw, Save, ShieldCheck, Users } from "lucide-react";
import { AREE, DESCRIZIONI_AREE, DESCRIZIONI_RUOLI, NOMI_AREE, NOMI_RUOLI, type Area, type Diritti, type RuoloAziendale } from "@workspace/permessi";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  NOMI_LIVELLI, SCELTE, avvisiDelCambio, corpoDelSalvataggio, differenzaInParole, differenze, esitoInParole, livelloDi,
  riassuntoDeiDiritti, ruoliValidi, sceltaDi, uguali, type RispostaRuoli, type Scelta, type StatoRuolo,
} from "@/lib/ruoli-admin";

const quando = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("it-IT", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

const persone = (n: number) => (n === 0 ? "nessun utente" : n === 1 ? "1 utente" : `${n} utenti`);

export default function AdminRuoliPage() {
  const { toast } = useToast();
  const [ruoli, setRuoli] = useState<StatoRuolo[] | null>(null);
  const [scelto, setScelto] = useState<RuoloAziendale | null>(null);
  /* le modifiche non ancora salvate, ruolo per ruolo: cambiare scheda non le butta via */
  const [bozze, setBozze] = useState<Partial<Record<RuoloAziendale, Diritti>>>({});
  const [conferma, setConferma] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<RispostaRuoli>("/api/admin/ruoli")
      .then(r => { const v = ruoliValidi(r); setRuoli(v); setScelto(s => s ?? v[0]?.codice ?? null); })
      .catch((e: any) => toast({ title: "Ruoli non letti", description: e?.message, variant: "destructive" }));
  }, [toast]);

  const ruolo = useMemo(() => ruoli?.find(r => r.codice === scelto) ?? null, [ruoli, scelto]);
  const bozza: Diritti | null = ruolo ? bozze[ruolo.codice] ?? ruolo.diritti : null;
  const cambi = ruolo && bozza ? differenze(ruolo.diritti, bozza) : [];
  const avvisi = ruolo && bozza ? avvisiDelCambio(ruolo.diritti, bozza, ruolo.utenti) : [];
  const daSalvare = (r: StatoRuolo) => !!bozze[r.codice] && !uguali(r.diritti, bozze[r.codice]!);

  const scegli = (area: Area, s: Scelta) => {
    if (!ruolo || !bozza) return;
    setBozze(b => ({ ...b, [ruolo.codice]: { ...bozza, [area]: livelloDi(s) } }));
  };
  const annulla = () => { if (ruolo) setBozze(b => { const { [ruolo.codice]: _via, ...resto } = b; return resto; }); };
  const allaPartenza = () => { if (ruolo) setBozze(b => ({ ...b, [ruolo.codice]: { ...ruolo.diPartenza } })); };

  const salva = async () => {
    if (!ruolo || !bozza || cambi.length === 0) return;
    setBusy(true);
    try {
      const r = await apiFetch<RispostaRuoli>(`/api/admin/ruoli/${ruolo.codice}`, { method: "PUT", body: JSON.stringify(corpoDelSalvataggio(bozza)) });
      const nuovi = ruoliValidi(r);
      setRuoli(nuovi);
      setBozze(b => { const { [ruolo.codice]: _via, ...resto } = b; return resto; });
      setConferma(false);
      toast({ title: `«${NOMI_RUOLI[ruolo.codice]}» salvato`, description: esitoInParole(r.esito, nuovi.find(x => x.codice === ruolo.codice)?.utenti ?? ruolo.utenti) });
    } catch (e: any) {
      toast({ title: "Non salvato", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const ultimo = quando(ruolo?.aggiornataIl ?? null);
  const diversoDallaPartenza = !!ruolo && !!bozza && !uguali(ruolo.diPartenza, bozza);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="w-6 h-6 text-primary" aria-hidden /> Ruoli
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Che cosa può fare ogni ruolo, area per area. Chi ha più ruoli ha il diritto più alto fra i suoi. I ruoli si
          assegnano alle persone in Utenti e accessi; l'amministratore di sistema può sempre tutto e non dipende da questa pagina.
        </p>
      </div>

      {/* i ruoli: una scheda per ruolo, con quanti utenti lo hanno */}
      <div role="tablist" aria-label="Ruoli aziendali" className="flex flex-wrap gap-2">
        {(ruoli ?? []).map(r => {
          const attivo = r.codice === scelto;
          return (
            <button
              key={r.codice} type="button" role="tab" id={`scheda-${r.codice}`} aria-selected={attivo} aria-controls="pannello-ruolo"
              onClick={() => setScelto(r.codice)}
              className={`text-left rounded-lg border px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                attivo ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"}`}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                {NOMI_RUOLI[r.codice]}
                {daSalvare(r) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">da salvare</span>}
                {!daSalvare(r) && !uguali(r.diritti, r.diPartenza) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300">modificato</span>}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Users className="w-3 h-3" aria-hidden /> {persone(r.utenti)}
              </span>
            </button>
          );
        })}
      </div>

      {ruolo && bozza && (
        <Card id="pannello-ruolo" role="tabpanel" aria-labelledby={`scheda-${ruolo.codice}`}>
          <CardHeader>
            <CardTitle className="text-base">{NOMI_RUOLI[ruolo.codice]}</CardTitle>
            <p className="text-sm text-muted-foreground">{DESCRIZIONI_RUOLI[ruolo.codice]}.</p>
            <p className="text-xs text-muted-foreground" data-testid="riassunto-ruolo">Adesso: {riassuntoDeiDiritti(bozza)}.</p>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="hidden sm:grid grid-cols-[1fr_auto] gap-4 px-2 pb-1 text-xs uppercase tracking-wide text-muted-foreground">
              <span>Area</span><span className="w-[17rem] text-center">Che cosa può fare</span>
            </div>
            {AREE.map(area => {
              const valore = sceltaDi(bozza[area]);
              const partenza = sceltaDi(ruolo.diPartenza[area]);
              const cambiata = valore !== sceltaDi(ruolo.diritti[area]);
              return (
                <fieldset key={area} className={`grid sm:grid-cols-[1fr_auto] gap-x-4 gap-y-2 items-center rounded-md px-2 py-2 border ${
                  cambiata ? "border-amber-500/40 bg-amber-500/5" : "border-transparent"}`}>
                  <legend className="sr-only">{NOMI_AREE[area]}</legend>
                  <div>
                    <div className="text-sm font-medium" aria-hidden>{NOMI_AREE[area]}</div>
                    <div className="text-xs text-muted-foreground">{DESCRIZIONI_AREE[area]}</div>
                    {valore !== partenza && (
                      <div className="text-xs text-sky-300 mt-0.5">Valore di partenza: {NOMI_LIVELLI[partenza]}</div>
                    )}
                  </div>
                  <div className="inline-flex rounded-md border border-border overflow-hidden w-[17rem]">
                    {SCELTE.map(s => {
                      const id = `ruolo-${ruolo.codice}-${area}-${s}`;
                      const accesa = valore === s;
                      return (
                        <label key={s} htmlFor={id}
                          className={`flex-1 text-center text-xs py-1.5 cursor-pointer select-none border-r border-border last:border-r-0 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary ${
                            accesa
                              ? s === "S" ? "bg-primary text-primary-foreground font-medium" : s === "L" ? "bg-primary/25 text-foreground font-medium" : "bg-muted text-foreground font-medium"
                              : "text-muted-foreground hover:bg-muted/40"}`}>
                          <input type="radio" id={id} name={`ruolo-${ruolo.codice}-${area}`} value={s} checked={accesa} disabled={busy}
                            onChange={() => scegli(area, s)} className="sr-only" />
                          {NOMI_LIVELLI[s]}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}

            <div className="flex flex-wrap items-center gap-3 pt-4">
              <Button onClick={() => setConferma(true)} disabled={busy || cambi.length === 0}>
                <Save className="w-4 h-4 mr-1.5" aria-hidden /> Salva
              </Button>
              {cambi.length > 0 && <Button variant="ghost" onClick={annulla} disabled={busy}>Annulla le modifiche</Button>}
              {diversoDallaPartenza && (
                <Button variant="ghost" onClick={allaPartenza} disabled={busy}>
                  <RotateCcw className="w-4 h-4 mr-1.5" aria-hidden /> Riporta ai valori di partenza
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                {cambi.length > 0
                  ? `${cambi.length === 1 ? "Una modifica" : `${cambi.length} modifiche`} da salvare.`
                  : ultimo ? `Cambiato il ${ultimo}${ruolo.aggiornataDa ? ` da ${ruolo.aggiornataDa}` : ""}.` : "Sono i valori di partenza."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground flex gap-2 max-w-3xl">
        <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
        <span>
          Tre cose non stanno nel ruolo e si scelgono persona per persona in Utenti e accessi: i depositi su cui scrive il roster,
          i dati sanitari e l'Analisi. Ogni modifica a questa pagina finisce nel registro delle modifiche.
        </span>
      </p>

      {/* la conferma: che cosa cambia, per quanti, e con quali conseguenze */}
      <Dialog open={conferma} onOpenChange={aperto => { if (!busy) setConferma(aperto); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiare «{ruolo ? NOMI_RUOLI[ruolo.codice] : ""}»?</DialogTitle>
          </DialogHeader>
          {ruolo && (
            <div className="space-y-3 text-sm">
              <ul className="list-disc pl-5 space-y-0.5">
                {cambi.map(d => <li key={d.area}>{differenzaInParole(d)}</li>)}
              </ul>
              <p className="text-muted-foreground">
                {ruolo.utenti === 0
                  ? "Nessun utente ha questo ruolo, per ora: varrà per chi lo riceverà."
                  : `Vale da subito per ${ruolo.utenti === 1 ? "la persona che ha" : `le ${ruolo.utenti} persone che hanno`} questo ruolo, anche se ${ruolo.utenti === 1 ? "è già dentro" : "sono già dentro"}.`}
              </p>
              {avvisi.map((a, i) => (
                <p key={i} className={`flex gap-2 rounded-md border px-3 py-2 ${
                  a.tono === "attenzione" ? "border-amber-500/40 bg-amber-500/10" : "border-border bg-muted/30"}`}>
                  {a.tono === "attenzione"
                    ? <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" aria-hidden />
                    : <Info className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />}
                  <span>{a.testo}</span>
                </p>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConferma(false)} disabled={busy}>Torna indietro</Button>
            <Button onClick={() => void salva()} disabled={busy}>{busy ? "Salvataggio…" : "Salva le modifiche"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
