/**
 * Registro delle modifiche (Amministrazione, solo admin; PR 2.11): chi ha
 * cambiato che cosa nei dati di pianificazione, scritto dal database.
 *
 * Decisioni che la pagina rispetta (25/10):
 * - la legge solo l'admin;
 * - niente viste per persona: si filtra per periodo, tabella, operazione e
 *   ambito (un programma, un feed, una corsa…), mai per chi ha fatto la
 *   modifica; non ci sono ordinamenti né conteggi per persona;
 * - i valori prima e dopo ci sono solo dove il registro li tiene (programmi,
 *   orari, turni, tariffe); per utenti, roster e anagrafica solo i nomi dei
 *   campi (degli utenti anche ruolo e permessi); degli orari di dettaglio solo
 *   i riepiloghi.
 * Ogni consultazione viene annotata dal database (registro.letture).
 * I valori arrivano come testo e come testo si mostrano.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, Info, PowerOff, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AMBITI_FILTRABILI, ELENCO_AMBITI, ELENCO_OPERAZIONI, GIORNI_MAX, confronto, descrizione, nomeAmbito, nomeAttore,
  nomeOperazione, nomeTabella, nomeVia, periodoPredefinito, richiesta,
  type FiltriRegistro, type RigaRegistro, type RispostaRegistro, type StatoRegistro,
} from "@/lib/registro-modifiche";

const SELEZIONE = "bg-background border border-border rounded-md h-9 px-2 text-sm w-full";
const filtriIniziali = (): FiltriRegistro => ({ ...periodoPredefinito(), tabella: "", operazione: "", ambitoTipo: "", ambitoId: "" });
const quando = (ts: string) => new Date(ts).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const corto = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export default function AdminRegistroPage() {
  const [filtri, setFiltri] = useState<FiltriRegistro>(filtriIniziali);
  /* i filtri dell'elenco che si sta guardando: «Carica altre» continua quelli, non ciò che si sta scrivendo */
  const [applicati, setApplicati] = useState<FiltriRegistro>(filtriIniziali);
  const [stato, setStato] = useState<StatoRegistro | null>(null);
  const [righe, setRighe] = useState<RigaRegistro[]>([]);
  const [successivo, setSuccessivo] = useState<string | null>(null);
  const [caricamento, setCaricamento] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [aperte, setAperte] = useState<ReadonlySet<number>>(new Set());

  const carica = useCallback(async (f: FiltriRegistro, cursore?: string | null) => {
    const r = richiesta(f, cursore);
    if ("errore" in r) { setErrore(r.errore); return; }
    setCaricamento(true);
    setErrore(null);
    try {
      const d = await apiFetch<RispostaRegistro>(r.percorso);
      setStato(d.stato);
      setRighe((prima) => (cursore ? [...prima, ...d.righe] : d.righe));
      if (!cursore) { setAperte(new Set()); setApplicati(f); }
      setSuccessivo(d.successivo);
    } catch (e: any) {
      setErrore(e?.message || "Registro non leggibile");
    } finally {
      setCaricamento(false);
    }
  }, []);

  useEffect(() => { void carica(filtriIniziali()); }, [carica]);

  const tabelle = useMemo(
    () => [...(stato?.tabelle ?? [])].sort((a, b) => nomeTabella(a.tabella).localeCompare(nomeTabella(b.tabella), "it")),
    [stato],
  );
  const soloRiepiloghi = useMemo(() => new Set((stato?.tabelle ?? []).filter((t) => t.riepilogoSempre).map((t) => t.tabella)), [stato]);
  const idPermesso = AMBITI_FILTRABILI.includes(filtri.ambitoTipo);

  const cambia = (parte: Partial<FiltriRegistro>) => setFiltri((f) => {
    const nuovo = { ...f, ...parte };
    // l'identificativo vale solo per un ambito che non è una persona
    if (!AMBITI_FILTRABILI.includes(nuovo.ambitoTipo)) nuovo.ambitoId = "";
    return nuovo;
  });
  const apri = (i: number) => setAperte((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });
  const soloQuesto = (tipo: string, id: string) => {
    const f = { ...filtri, ambitoTipo: tipo, ambitoId: id };
    setFiltri(f);
    void carica(f);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <History className="w-6 h-6 text-primary" />
          Registro delle modifiche
        </h1>
        <p className="text-sm text-muted-foreground">
          Chi ha cambiato che cosa nei programmi, negli orari, nei turni e nelle tariffe. Lo scrive il database.
        </p>
        {stato && (
          <p className="text-xs text-muted-foreground mt-1 max-w-4xl flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              Dopo {stato.anonimizzaDopoMesi} mesi il nome di chi ha fatto una modifica viene cancellato; la modifica resta
              per {stato.conservazioneMesi} mesi. Per utenti, roster e anagrafica il registro tiene solo i nomi dei campi cambiati
              (degli utenti anche il ruolo e i permessi).
              Le consultazioni di questa pagina vengono annotate.
            </span>
          </p>
        )}
      </div>

      {stato && !stato.attivo && (
        <Card className="border-amber-500/40">
          <CardContent className="py-4 flex items-start gap-3 text-sm">
            <PowerOff className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Il registro è spento: non sta registrando niente.</p>
              <p className="text-muted-foreground">
                Lo accende chi gestisce il database, quando l'azienda ha la base giuridica per farlo (accordo sindacale o
                autorizzazione dell'Ispettorato, informativa, valutazione d'impatto). I passi sono in DEPLOY, «Registro delle modifiche».
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Che cosa cercare</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end"
            onSubmit={(e) => { e.preventDefault(); void carica(filtri); }}
          >
            <div>
              <Label htmlFor="reg-da" className="text-xs">Dal giorno</Label>
              <Input id="reg-da" type="date" value={filtri.da} max={filtri.a} onChange={(e) => cambia({ da: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="reg-a" className="text-xs">Al giorno</Label>
              <Input id="reg-a" type="date" value={filtri.a} min={filtri.da} onChange={(e) => cambia({ a: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="reg-tabella" className="text-xs">Tabella</Label>
              <select id="reg-tabella" className={SELEZIONE} value={filtri.tabella} onChange={(e) => cambia({ tabella: e.target.value })}>
                <option value="">Tutte</option>
                {tabelle.map((t) => <option key={t.tabella} value={t.tabella}>{nomeTabella(t.tabella)}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="reg-operazione" className="text-xs">Operazione</Label>
              <select id="reg-operazione" className={SELEZIONE} value={filtri.operazione} onChange={(e) => cambia({ operazione: e.target.value })}>
                <option value="">Tutte</option>
                {ELENCO_OPERAZIONI.map((o) => <option key={o} value={o}>{nomeOperazione(o)}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="reg-ambito" className="text-xs">Riguarda</Label>
              <select id="reg-ambito" className={SELEZIONE} value={filtri.ambitoTipo} onChange={(e) => cambia({ ambitoTipo: e.target.value })}>
                <option value="">Tutto</option>
                {ELENCO_AMBITI.map((a) => <option key={a} value={a}>{nomeAmbito(a)}</option>)}
              </select>
            </div>
            <div>
              <Label htmlFor="reg-id" className="text-xs">Identificativo</Label>
              <Input
                id="reg-id" value={filtri.ambitoId} disabled={!idPermesso} className="font-mono text-xs"
                placeholder={idPermesso ? "incolla l'id" : "non per persona"}
                title={idPermesso ? "L'identificativo del programma, del feed, della corsa… (si trova aprendo una riga)" : "L'identificativo si può indicare solo per un programma, un feed, una corsa e simili"}
                onChange={(e) => cambia({ ambitoId: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-6 flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={caricamento}>
                <RefreshCw className={`w-4 h-4 mr-1.5 ${caricamento ? "animate-spin" : ""}`} />
                Cerca
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={caricamento} onClick={() => { const f = filtriIniziali(); setFiltri(f); void carica(f); }}>
                Ultimi 7 giorni, tutto
              </Button>
              <span className="text-xs text-muted-foreground">Al più {GIORNI_MAX} giorni per volta. Non si cerca per persona.</span>
            </div>
          </form>
          {errore && <p role="alert" className="mt-3 text-sm text-red-400">{errore}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Modifiche, dalla più recente</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {righe.length === 0 ? "" : `${righe.length} ${righe.length === 1 ? "riga" : "righe"}${successivo ? ", ce ne sono altre" : ""}`}
          </span>
        </CardHeader>
        <CardContent>
          {!stato && caricamento ? (
            <p className="text-sm text-muted-foreground">Caricamento…</p>
          ) : righe.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {stato && !stato.attivo ? "Nessuna modifica registrata: il registro è spento." : "Nessuna modifica in questo periodo con questi filtri."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border/40">
                    <th className="py-1.5 pr-2 w-6" />
                    <th className="py-1.5 pr-3">Quando</th>
                    <th className="py-1.5 pr-3">Chi</th>
                    <th className="py-1.5 pr-3">Da dove</th>
                    <th className="py-1.5 pr-3">Dove</th>
                    <th className="py-1.5 pr-3">Riguarda</th>
                    <th className="py-1.5 pr-3">Che cosa</th>
                  </tr>
                </thead>
                <tbody>
                  {righe.map((r, i) => {
                    const aperta = aperte.has(i);
                    return (
                      <Fragment key={r.id}>
                        <tr className="border-b border-border/10 hover:bg-muted/30 cursor-pointer" onClick={() => apri(i)}>
                          <td className="py-1.5 pr-2 align-top">
                            <button
                              type="button" aria-expanded={aperta} aria-label={aperta ? "Chiudi il dettaglio" : "Apri il dettaglio"}
                              className="text-muted-foreground hover:text-foreground"
                              onClick={(e) => { e.stopPropagation(); apri(i); }}
                            >
                              {aperta ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </button>
                          </td>
                          <td className="py-1.5 pr-3 align-top whitespace-nowrap tabular-nums">{quando(r.ts)}</td>
                          <td className="py-1.5 pr-3 align-top" title={r.attore?.email ?? undefined}>{nomeAttore(r)}</td>
                          <td className="py-1.5 pr-3 align-top text-muted-foreground">{nomeVia(r.via)}</td>
                          <td className="py-1.5 pr-3 align-top">
                            {nomeTabella(r.tabella)}
                            <span className="text-muted-foreground"> · {nomeOperazione(r.operazione)}</span>
                          </td>
                          <td className="py-1.5 pr-3 align-top">
                            {r.ambito ? (
                              <span title={r.ambito.id ?? undefined}>
                                <span className="text-muted-foreground">{nomeAmbito(r.ambito.tipo)}</span>
                                {r.ambito.id && <> {r.ambito.nome ?? <span className="font-mono">{corto(r.ambito.id)}</span>}</>}
                              </span>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="py-1.5 pr-3 align-top break-words max-w-[28rem]">{descrizione(r)}</td>
                        </tr>
                        {aperta && (
                          <tr className="border-b border-border/10 bg-muted/20">
                            <td />
                            <td colSpan={6} className="py-3 pr-3">
                              <Dettaglio riga={r} soloRiepiloghi={soloRiepiloghi.has(r.tabella)} soloQuesto={soloQuesto} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {successivo && (
            <div className="mt-4">
              <Button size="sm" variant="outline" disabled={caricamento} onClick={() => void carica(applicati, successivo)}>
                {caricamento ? "Caricamento…" : "Carica altre"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Il dettaglio di una riga: il prima e dopo campo per campo, o il campione di un riepilogo. */
function Dettaglio({ riga, soloRiepiloghi, soloQuesto }: {
  riga: RigaRegistro; soloRiepiloghi: boolean; soloQuesto: (tipo: string, id: string) => void;
}) {
  const voci = confronto(riga);
  const chiave = riga.chiave ? Object.entries(riga.chiave).map(([k, v]) => `${k} = ${String(v)}`).join(", ") : null;
  return (
    <div className="space-y-3">
      {riga.riepilogo ? (
        <div className="space-y-1.5">
          <p>
            Riepilogo di un'operazione: {descrizione(riga)}.
            {riga.aCascata && " Le righe sono state toccate di conseguenza (per esempio cancellando ciò a cui appartenevano)."}
          </p>
          {soloRiepiloghi && (
            <p className="text-muted-foreground">Di questa tabella il registro tiene solo i riepiloghi, senza i valori riga per riga.</p>
          )}
          {riga.campione?.length ? (
            <div>
              <p className="text-muted-foreground mb-1">
                {riga.campione.length === riga.righe ? "Le righe toccate:" : `Le prime ${riga.campione.length} righe toccate:`}
              </p>
              <ul className="font-mono text-[11px] leading-5 max-h-40 overflow-y-auto">
                {riga.campione.map((c, i) => (
                  <li key={i}>{Object.entries(c ?? {}).map(([k, v]) => `${k} = ${String(v)}`).join(", ")}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : voci.length === 0 ? (
        <p className="text-muted-foreground">
          {riga.operazione === "TRUNCATE" ? "La tabella è stata svuotata." : "Di questa riga il registro non tiene valori."}
        </p>
      ) : (
        <table className="text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-6 font-normal">Campo</th>
              {riga.operazione !== "INSERT" && <th className="py-1 pr-6 font-normal">Prima</th>}
              {riga.operazione !== "DELETE" && <th className="py-1 pr-6 font-normal">Dopo</th>}
            </tr>
          </thead>
          <tbody>
            {voci.map((v) => (
              <tr key={v.campo} className="align-top">
                <td className="py-0.5 pr-6 font-mono">{v.campo}</td>
                {v.soloNome ? (
                  <td colSpan={2} className="py-0.5 pr-6 text-muted-foreground">cambiato (il registro non ne tiene il valore)</td>
                ) : (
                  <>
                    {riga.operazione !== "INSERT" && <td className="py-0.5 pr-6 break-all max-w-md">{v.prima ?? "—"}</td>}
                    {riga.operazione !== "DELETE" && <td className="py-0.5 pr-6 break-all max-w-md">{v.dopo ?? "—"}</td>}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {chiave && <span className="font-mono">riga: {chiave}</span>}
        {riga.ambito?.id && AMBITI_FILTRABILI.includes(riga.ambito.tipo) && (
          <button type="button" className="underline hover:text-foreground" onClick={() => soloQuesto(riga.ambito!.tipo, riga.ambito!.id!)}>
            solo le modifiche di {nomeAmbito(riga.ambito.tipo) === "corsa" || nomeAmbito(riga.ambito.tipo) === "variante" ? "questa" : "questo"} {nomeAmbito(riga.ambito.tipo)}
          </button>
        )}
        <span>collegamento al database: {riga.ruoloDb}{riga.origine ? ` (${riga.origine})` : ""}</span>
        {riga.richiesta && <span className="font-mono">richiesta {riga.richiesta}</span>}
      </div>
    </div>
  );
}
