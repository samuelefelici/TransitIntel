/**
 * Argos, la console (pagina /argos): una pagina intera per guardare la squadra
 * degli agenti, farli lavorare, ispezionare che cosa hanno fatto e che cosa
 * possono toccare. Il pannello laterale nelle altre pagine resta: questa è la
 * pagina per quando serve solo l'analisi, o per capire un'esecuzione.
 *
 * Tema chiaro o scuro solo per questa pagina (index.css, .argos-chiaro),
 * ricordato nel browser; la scheda e l'esecuzione aperta stanno nell'indirizzo,
 * così un link porta dritto a una traccia.
 */
import { useCallback, useEffect, useState } from "react";
import { BookOpen, Bot, Gauge, Moon, Network, Play, Search, Sparkles, Sun, Wrench } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Cruscotto from "@/components/argos-console/Cruscotto";
import Squadra from "@/components/argos-console/Squadra";
import Lavora from "@/components/argos-console/Lavora";
import Ispettore from "@/components/argos-console/Ispettore";
import Capacita from "@/components/argos-console/Capacita";
import Biblioteca from "@/components/argos-console/Biblioteca";
import Mappa from "@/components/argos-console/Mappa";
import Crawler from "@/components/argos-console/Crawler";

const SCHEDE = ["cruscotto", "crawler", "biblioteca", "mappa", "squadra", "lavora", "ispettore", "capacita"] as const;
type Scheda = (typeof SCHEDE)[number];
const CHIAVE_TEMA = "argos-console-tema";

function temaIniziale(): "chiaro" | "scuro" {
  try {
    const s = localStorage.getItem(CHIAVE_TEMA);
    if (s === "chiaro" || s === "scuro") return s;
  } catch { /* storage spento: si va col sistema */ }
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "chiaro" : "scuro";
}

function dallIndirizzo(): { scheda: Scheda; esecuzione: number | null; agente: string | null } {
  const q = new URLSearchParams(window.location.search);
  const s = q.get("scheda") as Scheda | null;
  const e = Number(q.get("esecuzione"));
  const a = q.get("agente");
  return {
    scheda: s && (SCHEDE as readonly string[]).includes(s) ? s : "cruscotto",
    esecuzione: Number.isInteger(e) && e > 0 ? e : null,
    agente: a && /^[a-z0-9][a-z0-9-]{1,40}$/.test(a) ? a : null,
  };
}

export default function ArgosPage() {
  const iniziale = dallIndirizzo();
  const [scheda, setScheda] = useState<Scheda>(iniziale.scheda);
  const [esecuzione, setEsecuzione] = useState<number | null>(iniziale.esecuzione);
  const [agente, setAgente] = useState<string | null>(iniziale.agente);
  const [tema, setTema] = useState<"chiaro" | "scuro">(temaIniziale);
  const [documentoInMappa, setDocumentoInMappa] = useState<number | null>(null);
  const [documentoInBiblioteca, setDocumentoInBiblioteca] = useState<number | null>(null);
  const { isAdmin } = useAuth();

  useEffect(() => {
    try { localStorage.setItem(CHIAVE_TEMA, tema); } catch { /* niente */ }
  }, [tema]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (scheda !== "cruscotto") q.set("scheda", scheda);
    if (scheda === "ispettore" && esecuzione) q.set("esecuzione", String(esecuzione));
    if (scheda === "lavora" && agente) q.set("agente", agente);
    const testo = q.toString();
    const nuovo = `${window.location.pathname}${testo ? `?${testo}` : ""}`;
    if (nuovo !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", nuovo);
  }, [scheda, esecuzione, agente]);

  const apriEsecuzione = useCallback((id: number) => { setEsecuzione(id); setScheda("ispettore"); }, []);
  const faiLavorare = useCallback((chiave: string) => { setAgente(chiave); setScheda("lavora"); }, []);
  const apriInMappa = useCallback((id: number) => { setDocumentoInMappa(id); setScheda("mappa"); }, []);
  const apriInBiblioteca = useCallback((id: number) => { setDocumentoInBiblioteca(id); setScheda("biblioteca"); }, []);

  return (
    <div className={`argos-console ${tema === "chiaro" ? "argos-chiaro rounded-2xl" : ""} min-h-full`}>
      <div className="mx-auto max-w-[1600px] px-4 py-5 md:px-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl"><Bot className="h-6 w-6 text-primary" aria-hidden />Argos</h1>
            <p className="text-sm text-muted-foreground">Che cosa sa, come ragiona, chi lavora: la biblioteca, il crawler e la squadra degli agenti.</p>
          </div>
          <button type="button" onClick={() => setTema(t => (t === "chiaro" ? "scuro" : "chiaro"))}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={tema === "chiaro" ? "Passa al tema scuro" : "Passa al tema chiaro"}>
            {tema === "chiaro" ? <Moon className="h-3.5 w-3.5" aria-hidden /> : <Sun className="h-3.5 w-3.5" aria-hidden />}
            {tema === "chiaro" ? "Tema scuro" : "Tema chiaro"}
          </button>
        </header>

        <Tabs value={scheda} onValueChange={v => setScheda(v as Scheda)}>
          <TabsList className="mb-4 flex h-auto flex-wrap justify-start gap-1 bg-muted p-1">
            <TabsTrigger value="cruscotto" className="gap-1.5"><Gauge className="h-4 w-4" aria-hidden />Cruscotto</TabsTrigger>
            <TabsTrigger value="crawler" className="gap-1.5"><Sparkles className="h-4 w-4" aria-hidden />Crawler</TabsTrigger>
            <TabsTrigger value="biblioteca" className="gap-1.5"><BookOpen className="h-4 w-4" aria-hidden />Biblioteca</TabsTrigger>
            <TabsTrigger value="mappa" className="gap-1.5"><Network className="h-4 w-4" aria-hidden />Mappa</TabsTrigger>
            <TabsTrigger value="squadra" className="gap-1.5"><Bot className="h-4 w-4" aria-hidden />Squadra</TabsTrigger>
            <TabsTrigger value="lavora" className="gap-1.5"><Play className="h-4 w-4" aria-hidden />Lavora</TabsTrigger>
            <TabsTrigger value="ispettore" className="gap-1.5"><Search className="h-4 w-4" aria-hidden />Ispettore</TabsTrigger>
            <TabsTrigger value="capacita" className="gap-1.5"><Wrench className="h-4 w-4" aria-hidden />Capacità</TabsTrigger>
          </TabsList>
          <TabsContent value="cruscotto"><Cruscotto apriEsecuzione={apriEsecuzione} /></TabsContent>
          {/* montato sempre anche il crawler: una domanda in corso non si perde cambiando scheda */}
          <div hidden={scheda !== "crawler"}><Crawler /></div>
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
  );
}
