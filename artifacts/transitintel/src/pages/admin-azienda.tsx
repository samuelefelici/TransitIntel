/**
 * Azienda (Amministrazione, solo admin): i dati dell'azienda che usa questa
 * installazione. Prima erano scritti nel codice; ora stanno in public.azienda
 * (migrazione 0014) e li usano i GTFS esportati, i documenti stampati, le
 * regole delle password e le mappe di tutta la rete.
 * API: GET e PUT /api/admin/azienda. La logica del modulo è in lib/azienda.ts.
 * Sotto, il territorio (tappa 6.1): comuni e luoghi di riferimento, ognuno
 * salvato da sé (components/azienda/TerritorioAzienda.tsx), e i dati aperti
 * (tappa 6.3): gli indirizzi per il NAP (components/azienda/DatiAperti.tsx),
 * i depositi del personale (tappa 6.4, components/azienda/DepositiAzienda.tsx),
 * le reti con le regole delle linee (tappa 6.7, components/azienda/RetiAzienda.tsx),
 * le fasce chilometriche dell'extraurbano (tappa 6.8, components/azienda/FasceKm.tsx),
 * il catalogo dei titoli di viaggio (tappa 6.9, components/azienda/TitoliCatalogo.tsx),
 * gli elenchi di partenza delle tariffe (tappa 6.10, components/azienda/ElenchiTariffe.tsx)
 * e i gestori delle linee, le agenzie dei GTFS (tappa 6.11, components/azienda/Gestori.tsx).
 */
import { useEffect, useMemo, useState } from "react";
import { Building2, FileCode2, MapPin, Radio, Save, Scale, IdCard } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import TerritorioAzienda from "@/components/azienda/TerritorioAzienda";
import DatiAperti from "@/components/azienda/DatiAperti";
import DepositiAzienda from "@/components/azienda/DepositiAzienda";
import RetiAzienda from "@/components/azienda/RetiAzienda";
import FasceKm from "@/components/azienda/FasceKm";
import TitoliCatalogo from "@/components/azienda/TitoliCatalogo";
import ElenchiTariffe from "@/components/azienda/ElenchiTariffe";
import Gestori from "@/components/azienda/Gestori";
import NodiDiScambio from "@/components/azienda/NodiDiScambio";
import ParcoAvm from "@/components/azienda/ParcoAvm";
import StatoInstallazione from "@/components/azienda/StatoInstallazione";
import {
  aziendaValida, datiDaSalvare, erroriDelModulo, esempioCodiciTurni, esempioIdNetex, moduloCambiato, moduloDa,
  type Azienda, type CampoAzienda, type ModuloAzienda,
} from "@/lib/azienda";

interface Dettaglio { azienda: Azienda; aggiornataIl: string | null; aggiornataDa: string | null }

const quando = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("it-IT", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

export default function AdminAziendaPage() {
  const { toast } = useToast();
  const { refresh } = useAuth();
  const [dettaglio, setDettaglio] = useState<Dettaglio | null>(null);
  const [salvato, setSalvato] = useState<ModuloAzienda | null>(null);
  const [modulo, setModulo] = useState<ModuloAzienda | null>(null);
  const [busy, setBusy] = useState(false);
  /* gli errori si mostrano dopo il primo tentativo di salvare, o sulle caselle già toccate */
  const [toccati, setToccati] = useState<Set<CampoAzienda>>(new Set());
  const [provato, setProvato] = useState(false);

  const accogli = (d: Dettaglio) => {
    const pulito = { ...d, azienda: aziendaValida(d.azienda) };
    setDettaglio(pulito);
    const m = moduloDa(pulito.azienda);
    setSalvato(m); setModulo(m); setToccati(new Set()); setProvato(false);
  };

  useEffect(() => {
    apiFetch<Dettaglio>("/api/admin/azienda")
      .then(accogli)
      .catch((e: any) => toast({ title: "Dati dell'azienda non letti", description: e?.message, variant: "destructive" }));
  }, [toast]);

  const errori = useMemo(() => (modulo ? erroriDelModulo(modulo) : {}), [modulo]);
  const cambiato = !!modulo && !!salvato && moduloCambiato(modulo, salvato);
  const daCompilare = dettaglio !== null && !dettaglio.azienda.compilata;

  const salva = async () => {
    if (!modulo) return;
    setProvato(true);
    if (Object.keys(errori).length > 0) return;
    setBusy(true);
    try {
      accogli(await apiFetch<Dettaglio>("/api/admin/azienda", { method: "PUT", body: JSON.stringify(datiDaSalvare(modulo)) }));
      toast({ title: "Dati dell'azienda salvati", description: "Chi è già dentro li vede al prossimo caricamento della pagina." });
      /* la sessione porta i dati dell'azienda: la barra laterale e le mappe di questa scheda si aggiornano */
      void refresh();
    } catch (e: any) {
      toast({ title: "Non salvato", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const casella = (campo: CampoAzienda, etichetta: string, opzioni: { aiuto?: string; facoltativo?: boolean; larghezza?: string; tipo?: string; esempio?: string } = {}) => {
    const errore = (provato || toccati.has(campo)) ? errori[campo] : undefined;
    const id = `azienda-${campo}`;
    return (
      <div className={opzioni.larghezza ?? ""}>
        <Label htmlFor={id}>
          {etichetta}{opzioni.facoltativo && <span className="text-muted-foreground font-normal"> (facoltativo)</span>}
        </Label>
        <Input
          id={id}
          type={opzioni.tipo === "decimale" ? "text" : opzioni.tipo ?? "text"}
          inputMode={opzioni.tipo === "decimale" ? "decimal" : undefined}
          value={modulo?.[campo] ?? ""}
          placeholder={opzioni.esempio}
          disabled={!modulo || busy}
          onChange={e => setModulo(m => (m ? { ...m, [campo]: e.target.value } : m))}
          onBlur={() => setToccati(t => new Set(t).add(campo))}
          aria-invalid={!!errore}
          aria-describedby={errore ? `${id}-errore` : opzioni.aiuto ? `${id}-aiuto` : undefined}
        />
        {errore
          ? <p id={`${id}-errore`} role="alert" className="text-xs text-destructive mt-1">{errore}</p>
          : opzioni.aiuto && <p id={`${id}-aiuto`} className="text-xs text-muted-foreground mt-1">{opzioni.aiuto}</p>}
      </div>
    );
  };

  const ultimo = quando(dettaglio?.aggiornataIl ?? null);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Building2 className="w-6 h-6 text-primary" aria-hidden /> Azienda
        </h1>
        <p className="text-sm text-muted-foreground">
          I dati dell'azienda che usa questa installazione. Finiscono nei GTFS esportati, nei documenti stampati e nelle mappe.
        </p>
      </div>

      {daCompilare && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          <strong>Da compilare.</strong> Finché non salvi questi dati, i GTFS escono con il nome «Azienda di trasporto» e le mappe si aprono sull'Italia.
        </div>
      )}

      {/* che cosa c'è da compilare (tappa 6.18): ogni voce porta alla sua sezione, qui sotto o in un'altra pagina */}
      <StatoInstallazione />

      <Card id="azienda-identita" className="scroll-mt-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" aria-hidden /> Identità
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {casella("ragioneSociale", "Ragione sociale", { larghezza: "sm:col-span-2", aiuto: "Il nome per esteso: è l'agenzia e l'editore dei GTFS esportati dagli scenari.", esempio: "Trasporti Esempio S.p.A." })}
          {casella("nome", "Nome", { aiuto: "Il nome corto, per le intestazioni dei documenti.", esempio: "Esempio" })}
          {casella("gtfsAgencyId", "Identificativo GTFS", { aiuto: "L'agency_id dei GTFS esportati dagli scenari. Cambiarlo cambia l'identità dell'agenzia per chi li riceve.", esempio: "esempio" })}
          {casella("sito", "Sito", { facoltativo: true, tipo: "url", aiuto: "Va nei GTFS come indirizzo dell'agenzia.", esempio: "https://www.esempio.it" })}
          {casella("telefono", "Telefono", { facoltativo: true, tipo: "tel", aiuto: "Va nei GTFS esportati dagli scenari.", esempio: "+39 071 000000" })}
        </CardContent>
      </Card>

      <Card id="azienda-luogo" className="scroll-mt-4">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="w-4 h-4 text-primary" aria-hidden /> Territorio
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {casella("citta", "Città principale", { aiuto: "Compare nelle intestazioni. Il nome dell'azienda e la città non bastano come password.", esempio: "Ancona" })}
            {casella("regione", "Regione", { facoltativo: true, esempio: "Marche" })}
            {casella("provinciaIstat", "Provincia ISTAT", { facoltativo: true, larghezza: "sm:col-span-2", esempio: "042",
              aiuto: "Tre cifre. Gli import ISTAT (popolazione, pendolarismo) prendono questa provincia; i comuni e i luoghi sono qui sotto." })}
          </div>
          <div>
            <p className="text-sm font-medium mb-2">Centro delle mappe</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {casella("centroLat", "Latitudine", { tipo: "decimale", esempio: "43.58" })}
              {casella("centroLng", "Longitudine", { tipo: "decimale", esempio: "13.45" })}
              {casella("zoom", "Zoom", { tipo: "decimale", aiuto: "Da 3 (un continente) a 18 (una via). Per una provincia: 10.", esempio: "10" })}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Dove si aprono le mappe di tutta la rete: la mappa della pagina iniziale, la Mappa live e gli Scenari.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card id="azienda-netex" className="scroll-mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-primary" aria-hidden /> NeTEx per il NAP
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {casella("netexCodiceLocale", "Codice locale", { facoltativo: true, esempio: "ITI3",
              aiuto: "Il codice NUTS degli identificativi NeTEx del profilo italiano: per le Marche ITI3. Senza, il NeTEx non si esporta." })}
            {casella("netexFornitore", "Fornitore", { facoltativo: true, esempio: "ATMA",
              aiuto: "In fondo a ogni identificativo, se la Regione lo chiede per distinguere i dati di più aziende. Cambiarlo cambia tutti gli identificativi." })}
            {casella("netexPrefisso", "Prefisso degli identificativi", { facoltativo: true, esempio: "epd",
              aiuto: "Davanti a ogni identificativo, come nei file della Regione (epd:IT:ITI3:…)." })}
            {casella("netexPrefissoCodici", "Prefisso dei codici", { facoltativo: true, esempio: "ABC",
              aiuto: "Davanti al codice di linee, fermate e corse, con un trattino basso (ABC_1/3). Non va davanti a operatori e rete." })}
            {casella("netexCodiceRete", "Codice della rete", { facoltativo: true, esempio: "RETE_TPL_ABC",
              aiuto: "L'identificativo della rete. Senza, quello dell'azienda (l'identificativo GTFS)." })}
          </div>
          <p className="text-xs text-muted-foreground">
            I codici li decide la Regione: usa quelli dei suoi file, così linee e fermate tengono lo stesso identificativo.
            {modulo && esempioIdNetex(modulo) && <> Una linea uscirà come <code className="font-mono">{esempioIdNetex(modulo)}</code>.</>}
          </p>
        </CardContent>
      </Card>

      <Card id="azienda-regola-tariffe" className="scroll-mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Scale className="w-4 h-4 text-primary" aria-hidden /> Tariffe extraurbane: la regola regionale
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {casella("tariffeRiferimento", "Riferimento della regola", { facoltativo: true, larghezza: "sm:col-span-2",
              esempio: "Delibera di Giunta regionale n. 123/2022, art. 2",
              aiuto: "La norma della Regione che dice come si misura la distanza di un viaggio extraurbano. Compare nelle pagine delle tariffe accanto al calcolo. Vuoto: non compare." })}
          </div>
          <p className="text-xs text-muted-foreground">
            Le pagine delle tariffe misurano la distanza fra due fermate sul percorso con più corse della linea; se più linee
            hanno gli stessi capolinea, con la media dei loro chilometri pesata sulle corse. Il calcolo è lo stesso per tutte le aziende:
            qui si scrive solo da quale norma viene.
          </p>
        </CardContent>
      </Card>

      <Card id="azienda-codici-turni" className="scroll-mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <IdCard className="w-4 h-4 text-primary" aria-hidden /> Turni guida: i codici
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {casella("turniGuidaPomeriggioDa", "Inizio dei turni del pomeriggio", { facoltativo: true, esempio: "12:00",
              aiuto: "Un turno che comincia da quest'ora ha il codice da 100 in su; quelli del mattino da 001. Vuoto: una sola numerazione da 001." })}
          </div>
          <p className="text-xs text-muted-foreground">
            Il codice di un turno guida è la sigla del deposito di residenza seguita da tre cifre
            {modulo && esempioCodiciTurni(modulo.turniGuidaPomeriggioDa) && <>: <code className="font-mono">{esempioCodiciTurni(modulo.turniGuidaPomeriggioDa)}</code></>}.
            La sigla di ogni deposito si scrive nella pagina Depositi; senza, vale l'iniziale del nome.
          </p>
        </CardContent>
      </Card>

      <Card id="azienda-avm" className="scroll-mt-4">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="w-4 h-4 text-primary" aria-hidden /> AVM: le vetture dell'azienda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {casella("avmMatricolaCifre", "Cifre della matricola", { facoltativo: true, tipo: "decimale", esempio: "4",
              aiuto: "Nel canale dell'AVM, una vettura è dell'azienda se la sua matricola è un numero con al più queste cifre. Vuoto: tutte le vetture del canale sono dell'azienda." })}
          </div>
          <p className="text-xs text-muted-foreground">
            Serve dove nel canale dell'AVM passano anche le vetture di aziende consorziate, che hanno matricole più lunghe.
            Le pagine dell'AVM guardano di base solo le vetture dell'azienda, e solo quelle si confrontano con il parco dell'officina.
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void salva()} disabled={busy || !modulo || !cambiato}>
          <Save className="w-4 h-4 mr-1.5" aria-hidden /> {busy ? "Salvataggio…" : "Salva"}
        </Button>
        {cambiato && !busy && (
          <Button variant="ghost" onClick={() => { setModulo(salvato); setToccati(new Set()); setProvato(false); }}>Annulla le modifiche</Button>
        )}
        <p className="text-xs text-muted-foreground">
          {provato && Object.keys(errori).length > 0
            ? "Correggi le caselle segnate, poi salva."
            : ultimo
              ? `Salvati il ${ultimo}${dettaglio?.aggiornataDa ? ` da ${dettaglio.aggiornataDa}` : ""}.`
              : dettaglio && !daCompilare ? "Valori di partenza, mai modificati da qui." : ""}
        </p>
      </div>

      {/* i dati aperti (tappa 6.3): il GTFS e il NeTEx a un indirizzo stabile; si accende e si spegne da sé */}
      <DatiAperti />

      {/* i depositi del personale (tappa 6.4): li crea e li cambia l'amministratore, ogni riga si salva da sé */}
      <section id="azienda-depositi" className="scroll-mt-4"><DepositiAzienda /></section>

      {/* le reti e le regole delle linee (tappa 6.7): urbano o extraurbano, per le tariffe e per il Roster */}
      <section id="azienda-reti" className="scroll-mt-4"><RetiAzienda /></section>

      {/* i gestori (tappa 6.11): le aziende che gestiscono le linee, ognuna un'agenzia nei GTFS */}
      <section id="azienda-gestori" className="scroll-mt-4"><Gestori /></section>

      {/* le fasce chilometriche dell'extraurbano (tappa 6.8): a ogni fascia di chilometri il suo prezzo */}
      <section id="azienda-fasce" className="scroll-mt-4"><FasceKm /></section>

      {/* il catalogo dei titoli di viaggio (tappa 6.9): i biglietti e gli abbonamenti con cui si riempie un feed */}
      <section id="azienda-titoli" className="scroll-mt-4"><TitoliCatalogo /></section>

      {/* gli elenchi di partenza delle tariffe (tappa 6.10): categorie di passeggero e supporti */}
      <section id="azienda-elenchi" className="scroll-mt-4"><ElenchiTariffe /></section>

      {/* il territorio (tappa 6.1): comuni e luoghi, ogni riga si salva da sé */}
      <section id="azienda-territorio" className="scroll-mt-4"><TerritorioAzienda /></section>

      {/* i nodi di scambio (tappa 6.16): stazioni, porti, aeroporti e parcheggi scambiatori, con gli orari stimati */}
      <section id="azienda-nodi" className="scroll-mt-4"><NodiDiScambio /></section>
      <section id="azienda-parco" className="scroll-mt-4"><ParcoAvm /></section>
    </div>
  );
}
