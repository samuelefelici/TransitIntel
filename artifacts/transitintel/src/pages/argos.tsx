/**
 * Argos, la console (pagina /argos): la casa di Argos. La Conversazione (la
 * prima scheda: le conversazioni si riprendono dove si erano lasciate, anche
 * quelle col Pianificatore su un progetto, e ogni turno mostra la rete neurale
 * al lavoro, poi un riepilogo piccolo), la squadra degli agenti, le
 * esecuzioni, la biblioteca. Planning Studio non ha più il pannello laterale: il suo bottone
 * apre questa pagina, in un'altra scheda, sul progetto aperto.
 *
 * Il tema chiaro o scuro è quello dell'app (tappa 7.32, hooks/use-tema.tsx):
 * la pagina mette .argos-chiaro (index.css) quando è chiaro, e il suo pulsante
 * cambia il tema di tutta l'app. La scheda e l'esecuzione aperta stanno nell'indirizzo,
 * così un link porta dritto a una traccia.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Bot, Gauge, ListChecks, MessagesSquare, Moon, Network, Play, Search, Sun, Wrench } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Cruscotto from "@/components/argos-console/Cruscotto";
import Squadra from "@/components/argos-console/Squadra";
import Lavora from "@/components/argos-console/Lavora";
import Ispettore from "@/components/argos-console/Ispettore";
import Capacita from "@/components/argos-console/Capacita";
import Biblioteca from "@/components/argos-console/Biblioteca";
import Mappa from "@/components/argos-console/Mappa";
import Conversazioni from "@/components/argos-console/Conversazioni";
import Proposte from "@/components/argos-console/Proposte";
import { pianoDaProposta } from "@/lib/argos-proposte";
import type { PianoArgos } from "@/lib/argos-applica";
import type { PropostaAgente } from "@/lib/argos-console";
import { TemaArgosContesto } from "@/lib/argos-tema";
import { useTema } from "@/hooks/use-tema";

const SCHEDE = ["conversazione", "proposte", "cruscotto", "biblioteca", "mappa", "squadra", "lavora", "ispettore", "capacita"] as const;
/** i nomi di prima: i link salvati portano alla scheda unica */
const ALIAS: Record<string, Scheda> = { conversazioni: "conversazione", crawler: "conversazione" };
type Scheda = (typeof SCHEDE)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dallIndirizzo(): { scheda: Scheda; esecuzione: number | null; agente: string | null; conversazione: string | null; progetto: string | null } {
  const q = new URLSearchParams(window.location.search);
  const g = q.get("scheda");
  const s = g ? ALIAS[g] ?? g : null;
  const e = Number(q.get("esecuzione"));
  const a = q.get("agente");
  const c = q.get("conversazione");
  const p = q.get("progetto");
  return {
    scheda: s && (SCHEDE as readonly string[]).includes(s) ? (s as Scheda) : "conversazione",
    esecuzione: Number.isInteger(e) && e > 0 ? e : null,
    agente: a && /^[a-z0-9][a-z0-9-]{1,40}$/.test(a) ? a : null,
    conversazione: c && UUID.test(c) ? c : null,
    progetto: p && UUID.test(p) ? p : null,
  };
}

export default function ArgosPage() {
  const [iniziale] = useState(dallIndirizzo);
  const [scheda, setScheda] = useState<Scheda>(iniziale.scheda);
  const [esecuzione, setEsecuzione] = useState<number | null>(iniziale.esecuzione);
  const [agente, setAgente] = useState<string | null>(iniziale.agente);
  const [conversazione, setConversazione] = useState<string | null>(iniziale.conversazione);
  const [progetto, setProgetto] = useState<string | null>(iniziale.progetto);
  /* il tema è quello dell'app (tappa 7.32): il pulsante qui lo cambia per tutta l'app */
  const { tema, scegli } = useTema();
  const [documentoInMappa, setDocumentoInMappa] = useState<number | null>(null);
  const [documentoInBiblioteca, setDocumentoInBiblioteca] = useState<number | null>(null);
  const { isAdmin } = useAuth();
  // «Parti da questa» (scheda Proposte): il piano va al Pianificatore nella scheda Conversazione
  const [avvia, setAvvia] = useState<{ piano: PianoArgos; progetto: string } | null>(null);
  const partiDa = useCallback((p: PropostaAgente) => {
    if (!p.project_id) return;
    setAvvia({ piano: pianoDaProposta(p), progetto: p.project_id });
    setScheda("conversazione");
  }, []);

  useEffect(() => {
    const q = new URLSearchParams();
    if (scheda !== "conversazione") q.set("scheda", scheda);
    if (scheda === "ispettore" && esecuzione) q.set("esecuzione", String(esecuzione));
    if (scheda === "lavora" && agente) q.set("agente", agente);
    if (scheda === "conversazione" && conversazione) q.set("conversazione", conversazione);
    if (scheda === "conversazione" && progetto) q.set("progetto", progetto);
    const testo = q.toString();
    const nuovo = `${window.location.pathname}${testo ? `?${testo}` : ""}`;
    if (nuovo !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", nuovo);
  }, [scheda, esecuzione, agente, conversazione, progetto]);

  const apriEsecuzione = useCallback((id: number) => { setEsecuzione(id); setScheda("ispettore"); }, []);
  const faiLavorare = useCallback((chiave: string) => { setAgente(chiave); setScheda("lavora"); }, []);
  const apriInMappa = useCallback((id: number) => { setDocumentoInMappa(id); setScheda("mappa"); }, []);
  const apriInBiblioteca = useCallback((id: number) => { setDocumentoInBiblioteca(id); setScheda("biblioteca"); }, []);
  const conversazioneCambiata = useCallback((c: string | null, p: string | null) => { setConversazione(c); setProgetto(p); }, []);
  const contestoTema = useMemo(() => ({ tema, cambia: () => scegli(tema === "chiaro" ? "scuro" : "chiaro") }), [tema, scegli]);

  return (
    <TemaArgosContesto.Provider value={contestoTema}>
    <div className={`argos-console ${tema === "chiaro" ? "argos-chiaro rounded-2xl" : ""} min-h-full`}>
      <div className="mx-auto max-w-[1600px] px-4 py-5 md:px-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl"><Bot className="h-6 w-6 text-primary" aria-hidden />Argos</h1>
            <p className="text-sm text-muted-foreground">Le conversazioni, con la rete che ragiona sotto gli occhi; che cosa sa, chi lavora: la biblioteca e la squadra degli agenti.</p>
          </div>
          <button type="button" onClick={contestoTema.cambia}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tema === "chiaro" ? "Passa al tema scuro" : "Passa al tema chiaro"}>
            {tema === "chiaro" ? <Moon className="h-3.5 w-3.5" aria-hidden /> : <Sun className="h-3.5 w-3.5" aria-hidden />}
            {tema === "chiaro" ? "Tema scuro" : "Tema chiaro"}
          </button>
        </header>

        <Tabs value={scheda} onValueChange={v => setScheda(v as Scheda)}>
          <TabsList className="mb-4 flex h-auto flex-wrap justify-start gap-1 bg-muted p-1">
            <TabsTrigger value="conversazione" className="gap-1.5"><MessagesSquare className="h-4 w-4" aria-hidden />Conversazione</TabsTrigger>
            <TabsTrigger value="proposte" className="gap-1.5"><ListChecks className="h-4 w-4" aria-hidden />Proposte</TabsTrigger>
            <TabsTrigger value="cruscotto" className="gap-1.5"><Gauge className="h-4 w-4" aria-hidden />Cruscotto</TabsTrigger>
            <TabsTrigger value="biblioteca" className="gap-1.5"><BookOpen className="h-4 w-4" aria-hidden />Biblioteca</TabsTrigger>
            <TabsTrigger value="mappa" className="gap-1.5"><Network className="h-4 w-4" aria-hidden />Mappa</TabsTrigger>
            <TabsTrigger value="squadra" className="gap-1.5"><Bot className="h-4 w-4" aria-hidden />Squadra</TabsTrigger>
            <TabsTrigger value="lavora" className="gap-1.5"><Play className="h-4 w-4" aria-hidden />Lavora</TabsTrigger>
            <TabsTrigger value="ispettore" className="gap-1.5"><Search className="h-4 w-4" aria-hidden />Ispettore</TabsTrigger>
            <TabsTrigger value="capacita" className="gap-1.5"><Wrench className="h-4 w-4" aria-hidden />Capacità</TabsTrigger>
          </TabsList>
          {/* montate sempre: una risposta in arrivo non si perde cambiando scheda */}
          <div hidden={scheda !== "conversazione"}>
            <Conversazioni progettoIniziale={iniziale.progetto} conversazioneIniziale={iniziale.conversazione} onCambia={conversazioneCambiata}
              avvia={avvia} onAvviato={() => setAvvia(null)} />
          </div>
          <TabsContent value="proposte"><Proposte partiDa={partiDa} apriEsecuzione={apriEsecuzione} /></TabsContent>
          <TabsContent value="cruscotto"><Cruscotto apriEsecuzione={apriEsecuzione} /></TabsContent>
          <TabsContent value="biblioteca"><Biblioteca admin={isAdmin} apriInMappa={apriInMappa} documentoIniziale={documentoInBiblioteca} /></TabsContent>
          <TabsContent value="mappa"><Mappa documentoIniziale={documentoInMappa} apriInBiblioteca={apriInBiblioteca} /></TabsContent>
          <TabsContent value="squadra"><Squadra faiLavorare={faiLavorare} /></TabsContent>
          {/* montata sempre: un'esecuzione in corso non si perde cambiando scheda */}
          <div hidden={scheda !== "lavora"}><Lavora agenteIniziale={agente} apriEsecuzione={apriEsecuzione} /></div>
          <TabsContent value="ispettore"><Ispettore selezionata={esecuzione} seleziona={setEsecuzione} /></TabsContent>
          <TabsContent value="capacita"><Capacita /></TabsContent>
        </Tabs>
      </div>
    </div>
    </TemaArgosContesto.Provider>
  );
}
