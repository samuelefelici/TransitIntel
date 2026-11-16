/**
 * Giornate di esercizio (Amministrazione, solo admin; tappa 4.2): il
 * programmato congelato di ogni giornata.
 *
 * Il lavoratore prepara la giornata di domani e la congela all'inizio della
 * giornata (le 03:00): da lì il suo programmato non cambia più. Qui si
 * leggono le giornate e le loro corse, e si può preparare una giornata che
 * manca (una passata nasce congelata e «ricostruita» dallo storico).
 *
 * Dalla 4.3 ogni corsa porta anche il turno macchina, il turno guida e il
 * deposito, dai turni pubblicati com'erano all'inizio della giornata, e la
 * giornata ha i suoi turni macchina con i vuoti programmati.
 *
 * Dalla 4.4 una giornata cominciata ha la proposta dall'AVM: l'esito che le
 * prove suggeriscono per ogni corsa, con le prove, e le candidate corse
 * aggiunte. È una proposta: la conferma è della tappa successiva.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bus, CalendarDays, Lock, Radio, RefreshCw, Snowflake } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface VoceGiornata {
  giorno: string; stato: "preparata" | "congelata"; programma: string | null; feed: string | null;
  ricostruita: boolean; corse: number; kmProg: number; avvisi: number; preparataIl: string; congelataIl: string | null;
  /** null: turni non ancora aggiunti (giornata congelata prima dei turni) */
  turniPubblicati: boolean | null; senzaTurnoMacchina: number | null;
  /** null: proposta dall'AVM non ancora fatta */
  effettuateAvm: number | null; propostaDefinitiva: boolean | null;
}
type Proposta = "effettuata_avm" | "parziale" | "continuita" | "da_verificare" | "soppressione_indizio" | "non_rilevata";
interface Prove {
  modo: "id" | "codice" | "numero" | null; programmate: number; osservate: number; prima: number | null; ultima: number | null;
  vetture: string[]; partenzaReale: string | null; ritardoPartenza: number | null; dichiarata: boolean; motivo?: string;
  continuita?: { prima: string; dopo: string; vettura: string };
}
interface RiepilogoProposta {
  caronte: boolean; sorgente?: string; calcolataIl: string; definitiva: boolean;
  soglie?: { quotaFermate: number; fermateMancanti: number };
  corse?: number; perProposta?: Record<Proposta, number>; perModo?: Record<"id" | "codice" | "numero", number>;
  copertura?: number | null; aggiunte?: number; viaggi?: number; viaggiRiconosciuti?: number; rosterLetto?: boolean;
}
interface Aggiunta {
  chiaveAvm: string; trip: string | null; linea: string | null; numero: string | null; partenza: string | null;
  destinazione: string | null; vetture: string[]; transiti: number; osservazioni: number;
}
interface Corsa {
  chiave: string; codice: string | null; numero: string; linea: string | null; variante: string | null; direzione: number | null;
  partenza: string | null; arrivo: string | null; fermataDa: string | null; fermataA: string | null; kmProg: number | null; aChiamata: boolean;
  turnoMacchina: string | null; turnoGuida: string | null; deposito: string | null;
  proposta: Proposta | null; prove: Prove | null;
}
interface Vuoto { tipo: string; da: string | null; a: string | null; partenza: string | null; arrivo: string | null; km: number | null }
interface TurnoMacchina {
  turnoMacchina: string; udp: string | null; deposito: string | null; tipoMezzo: string | null; uscita: string | null; rientro: string | null;
  corse: number; corseNelGiorno: number; kmVuotoProg: number; vuoti: Vuoto[];
}
interface RiepilogoTurni {
  istante: string; pubblicato: boolean;
  udp: Array<{ udpId: string; udpNome: string | null; dssNome: string | null; vssNome: string | null; dssSuperato: boolean; dssDatiSuperati: boolean; vssSuperato: boolean }>;
  altroProgramma: number | null; corse: number; conTurnoMacchina: number; conTurnoGuida: number;
  scoperte: { senzaTurnoMacchina: number; fuoriUdp: number | null; scoperteNelCalcolo: number; nonNelCalcolo: number; senzaTurnoGuida: number };
  turniMacchina: number; turniGuida: number;
  corseDeiTurniFuoriProgramma: { quante: number };
  kmVuoto: { turni: number; riepilogo: number | null };
}
interface Giornata extends Omit<VoceGiornata, "avvisi" | "turniPubblicati" | "senzaTurnoMacchina" | "effettuateAvm" | "propostaDefinitiva"> {
  progettoId: string | null; feedId: string | null; avvisi: string[]; inizio: string; fine: string; elenco: Corsa[];
  turni: RiepilogoTurni | null; turniMacchina: TurnoMacchina[];
  proposta: RiepilogoProposta | null; aggiunte: Aggiunta[];
}

const PROPOSTE: Array<{ id: Proposta; nome: string; colore: string }> = [
  { id: "effettuata_avm", nome: "Effettuata (AVM)", colore: "text-emerald-300 border-emerald-400/40" },
  { id: "continuita", nome: "Per continuità", colore: "text-teal-300 border-teal-400/40" },
  { id: "parziale", nome: "Parziale?", colore: "text-amber-300 border-amber-400/40" },
  { id: "da_verificare", nome: "Da verificare", colore: "text-amber-200 border-amber-300/40" },
  { id: "soppressione_indizio", nome: "Soppressa?", colore: "text-rose-300 border-rose-400/40" },
  { id: "non_rilevata", nome: "Non rilevata", colore: "text-muted-foreground border-border" },
];
const proposta = (p: Proposta | null) => PROPOSTE.find((x) => x.id === p) ?? null;
const MODI: Record<string, string> = { id: "per id", codice: "per codice stabile", numero: "per numero di corsa" };

/** Le prove di una corsa, in parole, per il suggerimento. */
function proveInParole(c: Corsa): string | undefined {
  const p = c.prove;
  if (!p) return undefined;
  const r: string[] = [];
  if (p.modo) r.push(`Riconosciuta ${MODI[p.modo]}.`);
  if (p.osservate) r.push(`Fermate osservate ${p.osservate} su ${p.programmate} (dalla ${p.prima}ª alla ${p.ultima}ª).`);
  else if (p.dichiarata) r.push("Viaggio dichiarato dall'AVM, senza passaggi alle fermate.");
  else r.push("Nessuna prova dell'AVM.");
  if (p.vetture.length) r.push(`Vettura ${p.vetture.join(", ")}.`);
  if (p.partenzaReale) r.push(`Partita alle ${p.partenzaReale}${p.ritardoPartenza != null ? ` (${p.ritardoPartenza >= 0 ? "+" : ""}${Math.round(p.ritardoPartenza / 60)}')` : ""}.`);
  if (p.continuita) r.push(`La vettura ${p.continuita.vettura} fa la corsa prima e quella dopo del turno macchina.`);
  if (p.motivo) r.push(p.motivo.charAt(0).toUpperCase() + p.motivo.slice(1) + ".");
  return r.join(" ");
}

const quando = (ts: string | null) => (ts ? new Date(ts).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const data = (g: string) => new Date(`${g}T12:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const km = (n: number | null) => (n == null ? "—" : n.toLocaleString("it-IT", { maximumFractionDigits: 1 }));
const ora = (t: string | null) => (t ? t.slice(0, 5) : "—");

function Stato({ g }: { g: Pick<VoceGiornata, "stato" | "ricostruita"> }) {
  return g.stato === "congelata"
    ? <span className="inline-flex items-center gap-1 text-xs text-sky-300"><Snowflake className="w-3 h-3" />congelata{g.ricostruita ? " · ricostruita" : ""}</span>
    : <span className="inline-flex items-center gap-1 text-xs text-amber-300"><RefreshCw className="w-3 h-3" />preparata</span>;
}

/** I turni nella riga dell'elenco: pubblicati o no, e quante corse restano senza turno macchina. */
const turniInBreve = (g: VoceGiornata) =>
  g.turniPubblicati == null ? " · turni da aggiungere"
    : !g.turniPubblicati ? (g.corse ? " · nessun turno pubblicato" : "")
      : g.senzaTurnoMacchina ? ` · ${g.senzaTurnoMacchina.toLocaleString("it-IT")} senza turno` : " · tutte coi turni";

const NOMI_VUOTO: Record<string, string> = { uscita: "Uscita", rientro: "Rientro", deposito: "Rientro intermedio", trasferimento: "Vuoto" };
const vuotiInParole = (v: Vuoto[]) => v.map((x) =>
  `${NOMI_VUOTO[x.tipo] ?? x.tipo} ${ora(x.partenza)}–${ora(x.arrivo)}${x.da || x.a ? ` ${x.da ?? "?"} → ${x.a ?? "?"}` : ""}${x.km != null ? ` (${km(x.km)} km)` : ""}`).join("\n");

function PropostaDellaGiornata({ g, onCalcola, occupato, scelta, onScegli }: {
  g: Giornata; onCalcola: () => void; occupato: boolean; scelta: Proposta | null; onScegli: (p: Proposta | null) => void;
}) {
  const p = g.proposta;
  const intestazione = (
    <CardHeader className="pb-2 flex flex-row flex-wrap items-start justify-between gap-3">
      <div>
        <CardTitle className="text-base flex items-center gap-2"><Radio className="w-4 h-4" />Proposta dall'AVM</CardTitle>
        <p className="text-xs text-muted-foreground max-w-2xl">
          L'esito che le prove dell'AVM suggeriscono per ogni corsa. È una proposta: decide una persona. Una corsa senza prove resta
          «non rilevata», mai soppressa da sola.
        </p>
      </div>
      {g.stato === "congelata" && (
        <Button size="sm" variant="outline" onClick={onCalcola} disabled={occupato}>
          <RefreshCw className={`w-4 h-4 mr-1.5 ${occupato ? "animate-spin" : ""}`} />{p ? "Ricalcola" : "Calcola la proposta"}
        </Button>
      )}
    </CardHeader>
  );
  if (g.stato !== "congelata") {
    return <Card>{intestazione}<CardContent className="text-sm text-muted-foreground">La proposta si fa quando la giornata comincia.</CardContent></Card>;
  }
  if (!p) {
    return <Card>{intestazione}<CardContent className="text-sm text-muted-foreground">Non ancora calcolata: il lavoratore la fa definitiva dopo le 04:00 del giorno dopo; durante la giornata si chiede qui.</CardContent></Card>;
  }
  if (!p.caronte) {
    return <Card>{intestazione}<CardContent className="text-sm text-muted-foreground">Le tabelle dell'AVM non ci sono in questo database: nessuna proposta.</CardContent></Card>;
  }
  const conteggi = p.perProposta ?? ({} as Record<Proposta, number>);
  return (
    <Card>
      {intestazione}
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-2">
          {PROPOSTE.map((x) => (
            <button key={x.id} type="button" onClick={() => onScegli(scelta === x.id ? null : x.id)}
              className={`rounded-md border px-2.5 py-1 text-xs tabular-nums ${x.colore} ${scelta === x.id ? "bg-muted" : "hover:bg-muted/50"}`}
              aria-pressed={scelta === x.id}>
              {x.nome} <span className="font-semibold">{(conteggi[x.id] ?? 0).toLocaleString("it-IT")}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 tabular-nums">
          <div><span className="text-muted-foreground">Corse con passaggi alle fermate: </span>{p.copertura != null ? `${p.copertura.toLocaleString("it-IT")}%` : "—"}</div>
          <div>
            <span className="text-muted-foreground">Riconosciute: </span>
            {p.perModo ? `${p.perModo.id} per id, ${p.perModo.codice} per codice, ${p.perModo.numero} per numero` : "—"}
          </div>
          <div><span className="text-muted-foreground">Viaggi dell'AVM: </span>{p.viaggi ?? 0}, riconosciuti {p.viaggiRiconosciuti ?? 0}</div>
          <div><span className="text-muted-foreground">Candidate corse aggiunte: </span>{p.aggiunte ?? 0}</div>
          <div className="sm:col-span-2 text-xs text-muted-foreground">
            {p.definitiva ? "Definitiva" : "Vista viva, non ancora definitiva"}, calcolata il {quando(p.calcolataIl)}
            {p.soglie && <> · effettuata con almeno il {Math.round(p.soglie.quotaFermate * 100)}% delle fermate; parziale con almeno {p.soglie.fermateMancanti} fermate mancanti in fondo</>}
            {p.sorgente === "tutte" && <> · le prove non distinguono SIRI dalle altre sorgenti</>}
          </div>
        </div>
        {g.aggiunte.length > 0 && (
          <div className="overflow-x-auto max-h-[280px] overflow-y-auto rounded-md border border-border/50">
            <table className="w-full text-sm">
              <caption className="text-left px-3 py-2 text-xs text-muted-foreground">Viaggi dell'AVM che il programmato non ha: candidate corse aggiunte</caption>
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2">Parte</th><th className="px-3 py-2">Linea</th><th className="px-3 py-2">N.</th>
                  <th className="px-3 py-2">Vetture</th><th className="px-3 py-2 text-right">Passaggi</th><th className="px-3 py-2 text-right">Letture</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {g.aggiunte.map((a) => (
                  <tr key={a.chiaveAvm} className="border-t border-border/40">
                    <td className="px-3 py-1.5">{a.partenza ?? "—"}</td>
                    <td className="px-3 py-1.5">{a.linea ?? "—"}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{a.numero ?? (a.trip ? <span title={a.trip}>id del feed</span> : "—")}</td>
                    <td className="px-3 py-1.5">{a.vetture.join(", ") || "—"}</td>
                    <td className="px-3 py-1.5 text-right">{a.transiti}</td>
                    <td className="px-3 py-1.5 text-right">{a.osservazioni}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TurniDellaGiornata({ g, onAggiungi, occupato }: { g: Giornata; onAggiungi: () => void; occupato: boolean }) {
  const t = g.turni;
  if (!t) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Bus className="w-4 h-4" />Turni</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {g.stato === "congelata"
              ? "Giornata congelata prima dei turni: il lavoratore li aggiunge al prossimo giro, dai turni pubblicati com'erano alle 03:00. Le corse non cambiano."
              : "Turni non ancora calcolati: il lavoratore li calcola al prossimo giro, quando rifà la giornata."}
          </span>
          <Button size="sm" variant="outline" onClick={onAggiungi} disabled={occupato}>Aggiungi i turni ora</Button>
        </CardContent>
      </Card>
    );
  }
  const s = t.scoperte;
  const parti = [
    s.fuoriUdp ? `${s.fuoriUdp} fuori dalle UDP pubblicate` : null,
    s.scoperteNelCalcolo ? `${s.scoperteNelCalcolo} lasciate scoperte dal calcolo` : null,
    s.nonNelCalcolo ? `${s.nonNelCalcolo} non comprese nel calcolo` : null,
  ].filter(Boolean);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2"><Bus className="w-4 h-4" />Turni pubblicati</CardTitle>
        <p className="text-xs text-muted-foreground">Dal roster, com'erano il {quando(t.istante)}.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!t.pubblicato ? (
          <div className="text-muted-foreground">Nessun turno pubblicato per la giornata: le corse non hanno turno macchina né turno guida.</div>
        ) : (
          <>
            <ul className="space-y-1">
              {t.udp.map((u) => (
                <li key={u.udpId}>
                  <span className="font-medium">{u.udpNome ?? "UDP"}</span>
                  <span className="text-muted-foreground"> · turni guida </span>{u.dssNome ?? "—"}
                  {u.dssSuperato && <span className="ml-1 text-xs text-amber-300">(c'è una versione più nuova)</span>}
                  {u.dssDatiSuperati && <span className="ml-1 text-xs text-amber-300">(su dati poi cambiati)</span>}
                  <span className="text-muted-foreground"> · turni macchina </span>{u.vssNome ?? "—"}
                  {u.vssSuperato && <span className="ml-1 text-xs text-amber-300">(c'è una versione più nuova)</span>}
                </li>
              ))}
            </ul>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 tabular-nums">
              <div><span className="text-muted-foreground">Corse col turno macchina: </span>{t.conTurnoMacchina.toLocaleString("it-IT")} su {t.corse.toLocaleString("it-IT")}</div>
              <div><span className="text-muted-foreground">Corse col turno guida: </span>{t.conTurnoGuida.toLocaleString("it-IT")} su {t.corse.toLocaleString("it-IT")}</div>
              <div><span className="text-muted-foreground">Turni macchina: </span>{t.turniMacchina} · <span className="text-muted-foreground">turni guida: </span>{t.turniGuida}</div>
              <div>
                <span className="text-muted-foreground">Km a vuoto programmati: </span>{km(t.kmVuoto.turni)}
                {t.kmVuoto.riepilogo != null && <span className="text-muted-foreground"> (riepilogo del calcolo: {km(t.kmVuoto.riepilogo)})</span>}
              </div>
              {s.senzaTurnoMacchina > 0 && (
                <div className="sm:col-span-2"><span className="text-muted-foreground">Senza turno macchina: </span>{s.senzaTurnoMacchina.toLocaleString("it-IT")}{parti.length ? ` (${parti.join(", ")})` : ""}</div>
              )}
              {s.senzaTurnoGuida > 0 && <div className="sm:col-span-2"><span className="text-muted-foreground">Col turno macchina ma senza turno guida: </span>{s.senzaTurnoGuida.toLocaleString("it-IT")}</div>}
              {t.corseDeiTurniFuoriProgramma.quante > 0 && (
                <div className="sm:col-span-2"><span className="text-muted-foreground">Corse dei turni che il programmato non ha: </span>{t.corseDeiTurniFuoriProgramma.quante.toLocaleString("it-IT")}</div>
              )}
            </div>
            {g.turniMacchina.length > 0 && (
              <div className="overflow-x-auto max-h-[360px] overflow-y-auto rounded-md border border-border/50">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                    <tr className="text-left">
                      <th className="px-3 py-2">Turno macchina</th><th className="px-3 py-2">Deposito</th><th className="px-3 py-2">Mezzo</th>
                      <th className="px-3 py-2">Esce</th><th className="px-3 py-2">Rientra</th><th className="px-3 py-2 text-right">Corse</th>
                      <th className="px-3 py-2 text-right">Km a vuoto</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {g.turniMacchina.map((m, i) => (
                      <tr key={`${i}|${m.turnoMacchina}`} className="border-t border-border/40">
                        <td className="px-3 py-1.5 font-medium">{m.turnoMacchina}{t.udp.length > 1 && m.udp && <span className="ml-1 text-xs text-muted-foreground">{m.udp}</span>}</td>
                        <td className="px-3 py-1.5">{m.deposito ?? "—"}</td>
                        <td className="px-3 py-1.5">{m.tipoMezzo ?? "—"}</td>
                        <td className="px-3 py-1.5">{ora(m.uscita)}</td>
                        <td className="px-3 py-1.5">{ora(m.rientro)}</td>
                        <td className="px-3 py-1.5 text-right" title={m.corseNelGiorno < m.corse ? `${m.corse - m.corseNelGiorno} corse del turno non sono nel programmato della giornata` : undefined}>
                          {m.corseNelGiorno === m.corse ? m.corse : `${m.corseNelGiorno} di ${m.corse}`}
                        </td>
                        <td className="px-3 py-1.5 text-right" title={m.vuoti.length ? vuotiInParole(m.vuoti) : undefined}>{km(m.kmVuotoProg)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminGiornatePage() {
  const [elenco, setElenco] = useState<VoceGiornata[]>([]);
  const [scelta, setScelta] = useState<string | null>(null);
  const [giornata, setGiornata] = useState<Giornata | null>(null);
  const [daAprire, setDaAprire] = useState("");
  /* la giornata chiesta che non è ancora preparata */
  const [mancante, setMancante] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [perTurno, setPerTurno] = useState(false);
  const [soloProposta, setSoloProposta] = useState<Proposta | null>(null);
  const [occupato, setOccupato] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  const caricaElenco = useCallback(async () => {
    try {
      const r = await apiFetch<{ giornate: VoceGiornata[] }>("/api/admin/esercizio/giornate");
      setElenco(r.giornate);
      return r.giornate;
    } catch (e: any) { setErrore(e?.message || "Giornate non leggibili"); return []; }
  }, []);
  const apri = useCallback(async (g: string) => {
    setScelta(g); setErrore(null); setMancante(null); setOccupato(true);
    try { setGiornata(await apiFetch<Giornata>(`/api/admin/esercizio/giornate/${g}`)); }
    catch (e: any) {
      setGiornata(null);
      if (e?.status === 404 || /non ancora preparata/i.test(String(e?.message ?? ""))) setMancante(g);
      else setErrore(e?.message || "Giornata non leggibile");
    }
    finally { setOccupato(false); }
  }, []);
  useEffect(() => { void caricaElenco().then((l) => { if (l[0]) void apri(l.find((x) => x.stato === "congelata")?.giorno ?? l[0].giorno); }); }, [caricaElenco, apri]);

  /* un'altra giornata: il filtro per proposta riparte da capo */
  const cambiaGiornata = (g: string) => { setSoloProposta(null); void apri(g); };

  const prepara = async (g: string) => {
    setErrore(null); setOccupato(true);
    try {
      await apiFetch(`/api/admin/esercizio/giornate/${g}/prepara`, { method: "POST" });
      await caricaElenco();
      await apri(g);
    } catch (e: any) { setErrore(e?.message || "Preparazione non riuscita"); }
    finally { setOccupato(false); }
  };

  const corse = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    const l = giornata?.elenco ?? [];
    const conProposta = soloProposta ? l.filter((c) => c.proposta === soloProposta) : l;
    const filtrate = f ? conProposta.filter((c) => [c.linea, c.numero, c.codice, c.fermataDa, c.fermataA, c.turnoMacchina, c.turnoGuida, c.deposito]
      .some((x) => (x ?? "").toLowerCase().includes(f))) : conProposta;
    /* per turno macchina: le corse di ogni turno in fila, quelle senza turno in fondo */
    return perTurno
      ? [...filtrate].sort((a, b) => (a.turnoMacchina == null ? 1 : 0) - (b.turnoMacchina == null ? 1 : 0)
          || (a.turnoMacchina ?? "").localeCompare(b.turnoMacchina ?? "", "it", { numeric: true }) || (a.partenza ?? "").localeCompare(b.partenza ?? ""))
      : filtrate;
  }, [giornata, filtro, perTurno, soloProposta]);

  const calcolaProposta = async (g: string) => {
    setErrore(null); setOccupato(true);
    try {
      await apiFetch(`/api/admin/esercizio/giornate/${g}/proposta`, { method: "POST" });
      await caricaElenco();
      await apri(g);
    } catch (e: any) { setErrore(e?.message || "Proposta non riuscita"); }
    finally { setOccupato(false); }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <CalendarDays className="w-6 h-6 text-primary mt-0.5" />
        <div>
          <h1 className="text-xl font-semibold">Giornate di esercizio</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">
            Il programmato di ogni giornata, dal programma in esercizio alle 03:00 (storico delle attivazioni). Il lavoratore
            prepara la giornata di domani e la congela quando comincia: da lì non cambia più, nemmeno se il programma viene
            rimesso in esercizio o duplicato. Una giornata passata preparata dopo nasce congelata e «ricostruita».
            Ogni corsa porta il turno macchina, il turno guida e il deposito dei turni pubblicati nel roster alle 03:00.
          </p>
        </div>
      </div>

      <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (daAprire) cambiaGiornata(daAprire); }}>
        <div className="space-y-1">
          <Label htmlFor="giornata-da-aprire">Giornata</Label>
          <Input id="giornata-da-aprire" type="date" value={daAprire} onChange={(e) => setDaAprire(e.target.value)} className="w-44" />
        </div>
        <Button type="submit" variant="outline" disabled={occupato || !daAprire}>Apri</Button>
      </form>

      {errore && <div className="text-sm text-destructive">{errore}</div>}
      {mancante && (
        <div className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
          <span className="capitalize">{data(mancante)}</span>
          <span className="text-muted-foreground">non è ancora preparata.</span>
          <Button size="sm" onClick={() => void prepara(mancante)} disabled={occupato}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${occupato ? "animate-spin" : ""}`} /> Prepara
          </Button>
          <span className="text-xs text-muted-foreground">Una giornata passata nasce congelata e ricostruita dallo storico.</span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Ultimi 30 giorni e domani</CardTitle></CardHeader>
          <CardContent className="p-0">
            {elenco.length === 0 && <div className="px-4 pb-4 text-sm text-muted-foreground">Nessuna giornata preparata: le prepara il lavoratore.</div>}
            <ul className="max-h-[560px] overflow-y-auto">
              {elenco.map((g) => (
                <li key={g.giorno}>
                  <button type="button" onClick={() => cambiaGiornata(g.giorno)}
                    className={`w-full text-left px-4 py-2 border-t border-border/50 hover:bg-muted/40 ${scelta === g.giorno ? "bg-muted/60" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium capitalize">{data(g.giorno)}</span>
                      <Stato g={g} />
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {g.corse.toLocaleString("it-IT")} corse · {km(g.kmProg)} km{turniInBreve(g)}{g.effettuateAvm != null ? ` · ${g.effettuateAvm.toLocaleString("it-IT")} effettuate (AVM)` : ""}{g.avvisi ? ` · ${g.avvisi} avvisi` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          {giornata && (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2 capitalize">
                    {data(giornata.giorno)} <Stato g={giornata} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div><span className="text-muted-foreground">Programma: </span>{giornata.programma ?? "nessuno nello storico"}</div>
                  <div><span className="text-muted-foreground">Feed: </span>{giornata.feed ?? "—"}</div>
                  <div><span className="text-muted-foreground">Dalle </span>{quando(giornata.inizio)}<span className="text-muted-foreground"> alle </span>{quando(giornata.fine)}</div>
                  <div className="tabular-nums"><span className="text-muted-foreground">Corse: </span>{giornata.corse.toLocaleString("it-IT")} · {km(giornata.kmProg)} km</div>
                  <div><span className="text-muted-foreground">Preparata: </span>{quando(giornata.preparataIl)}</div>
                  <div className="flex items-center gap-1">
                    {giornata.congelataIl ? <><Lock className="w-3 h-3 text-sky-300" /><span className="text-muted-foreground">Congelata: </span>{quando(giornata.congelataIl)}</> : <span className="text-muted-foreground">Si congela all'inizio della giornata</span>}
                  </div>
                  {giornata.avvisi.length > 0 && (
                    <div className="sm:col-span-2 mt-2 space-y-1">
                      {giornata.avvisi.map((a, i) => <div key={i} className="flex gap-2 text-amber-200"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{a}</div>)}
                    </div>
                  )}
                </CardContent>
              </Card>

              <TurniDellaGiornata g={giornata} onAggiungi={() => void prepara(giornata.giorno)} occupato={occupato} />

              <PropostaDellaGiornata g={giornata} onCalcola={() => void calcolaProposta(giornata.giorno)} occupato={occupato}
                scelta={soloProposta} onScegli={setSoloProposta} />

              <Card>
                <CardHeader className="pb-2 flex flex-row flex-wrap items-center justify-between gap-3">
                  <CardTitle className="text-base">Corse</CardTitle>
                  <div className="flex flex-wrap items-center gap-3">
                    <label htmlFor="giornata-per-turno" className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <input id="giornata-per-turno" type="checkbox" checked={perTurno} onChange={(e) => setPerTurno(e.target.checked)} />
                      Per turno macchina
                    </label>
                    <Input id="giornata-filtro" placeholder="Linea, numero, codice, capolinea, turno" value={filtro} onChange={(e) => setFiltro(e.target.value)} className="h-8 w-64" />
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                        <tr className="text-left">
                          <th className="px-3 py-2">Linea</th><th className="px-3 py-2">N.</th><th className="px-3 py-2">Parte</th><th className="px-3 py-2">Arriva</th>
                          <th className="px-3 py-2">Da</th><th className="px-3 py-2">A</th><th className="px-3 py-2 text-right">Km</th>
                          <th className="px-3 py-2">Turno macchina</th><th className="px-3 py-2">Turno guida</th><th className="px-3 py-2">Deposito</th>
                          <th className="px-3 py-2">Proposta</th>
                          <th className="px-3 py-2">Codice</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {corse.slice(0, 1000).map((c) => (
                          <tr key={c.chiave} className="border-t border-border/40">
                            <td className="px-3 py-1.5 font-medium">{c.linea ?? "—"}{c.aChiamata && <span className="ml-1 text-xs text-amber-300">a chiamata</span>}</td>
                            <td className="px-3 py-1.5">{c.numero}</td>
                            <td className="px-3 py-1.5">{ora(c.partenza)}</td>
                            <td className="px-3 py-1.5">{ora(c.arrivo)}</td>
                            <td className="px-3 py-1.5 max-w-[180px] truncate">{c.fermataDa ?? "—"}</td>
                            <td className="px-3 py-1.5 max-w-[180px] truncate">{c.fermataA ?? "—"}</td>
                            <td className="px-3 py-1.5 text-right">{km(c.kmProg)}</td>
                            <td className="px-3 py-1.5">{c.turnoMacchina ?? <span className="text-muted-foreground">—</span>}</td>
                            <td className="px-3 py-1.5">{c.turnoGuida ?? <span className="text-muted-foreground">—</span>}</td>
                            <td className="px-3 py-1.5 max-w-[140px] truncate">{c.deposito ?? <span className="text-muted-foreground">—</span>}</td>
                            <td className="px-3 py-1.5" title={proveInParole(c)}>
                              {proposta(c.proposta)
                                ? <span className={`inline-block rounded border px-1.5 py-0.5 text-xs whitespace-nowrap ${proposta(c.proposta)!.colore}`}>{proposta(c.proposta)!.nome}</span>
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground max-w-[220px] truncate">{c.codice ?? c.chiave}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {corse.length > 1000 && <div className="px-3 py-2 text-xs text-muted-foreground">Le prime 1.000 di {corse.length.toLocaleString("it-IT")}: filtra per vedere le altre.</div>}
                  {corse.length === 0 && <div className="px-3 py-3 text-sm text-muted-foreground">Nessuna corsa.</div>}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
