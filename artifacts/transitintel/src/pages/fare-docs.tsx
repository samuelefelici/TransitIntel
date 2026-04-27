import React, { useState, useEffect } from "react";
import {
  BookOpen, CheckCircle2, Clock, AlertCircle, Circle,
  ChevronDown, ChevronRight, Printer, Download,
  Zap, MapPin, Route, Ruler, FileText, Database,
  BarChart3, Shield, Package, Layers, ArrowRight,
  Info, HelpCircle, ExternalLink, Ticket, Euro, Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

// ═══════════════════════════════════════════════════════════
// TIPI
// ═══════════════════════════════════════════════════════════

type MilestoneStatus = "done" | "in-progress" | "todo";

interface Milestone {
  id: string;
  label: string;
  description: string;
  status: MilestoneStatus;
  targetDate?: string;
  completedDate?: string;
  notes?: string;
}

interface Phase {
  id: string;
  title: string;
  icon: React.ElementType;
  color: string;
  milestones: Milestone[];
}

// ═══════════════════════════════════════════════════════════
// DATI — MILESTONE
// ═══════════════════════════════════════════════════════════

const PHASES: Phase[] = [
  {
    id: "fondamenta",
    title: "1 · Fondamenta GTFS & Reti",
    icon: Database,
    color: "blue",
    milestones: [
      {
        id: "gtfs-upload",
        label: "Upload feed GTFS",
        description: "Caricamento file ZIP GTFS con parsing e salvataggio su DB (stops, routes, trips, shapes, stop_times, calendar).",
        status: "done",
        completedDate: "feb 2026",
      },
      {
        id: "reti-tariffarie",
        label: "Reti tariffarie (networks)",
        description: "Definizione delle 4 reti: Urbano Ancona, Urbano Jesi, Urbano Falconara, Extraurbano. Classificazione automatica delle linee per nome.",
        status: "done",
        completedDate: "feb 2026",
      },
      {
        id: "media-categorie",
        label: "Supporti di pagamento e categorie passeggeri",
        description: "Configurazione fare_media (carta contactless, cartaceo, app, cEMV) e rider_categories (ordinario, studente, anziano, disabile).",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "prodotti-base",
        label: "Prodotti tariffari — biglietti",
        description: "Seed dei biglietti di corsa semplice e A/R per le tre reti urbane e delle 23 fasce km extraurbane (DGR Regione Marche).",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "abbonamenti",
        label: "Prodotti tariffari — abbonamenti",
        description: "Abbonamenti settimanali, mensili e annuali per tutte le reti urbane. Abbonamenti mensili extraurbani per fascia (ordinario + studente).",
        status: "done",
        completedDate: "apr 2026",
      },
    ],
  },
  {
    id: "zonazione",
    title: "2 · Zonazione & Distanze",
    icon: MapPin,
    color: "orange",
    milestones: [
      {
        id: "aree-urbane",
        label: "Aree tariffarie urbane (flat)",
        description: "Creazione di un'area unica per rete urbana (tutte le fermate → stessa area → tariffa piatta indipendente dall'O/D).",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "zone-extraurbane",
        label: "Zone extraurbane per fascia km",
        description: "Generazione automatica delle zone per ogni linea extraurbana: le fermate vengono ordinate per km progressivi sul percorso dominante e assegnate alla fascia DGR corrispondente.",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "proiezione-shape",
        label: "Metodo Proiezione su Shape",
        description: "Calcolo del km progressivo di ogni fermata come media ponderata per numero di corse su tutti i percorsi (shape GTFS) della linea. Gestisce linee con più varianti di percorso.",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "percorso-dominante",
        label: "Metodo Percorso Dominante",
        description: "Identificazione del percorso con più corse giornaliere come riferimento canonico. Il km della fermata è letto direttamente sulla geometria shape GTFS — senza proiezione ortogonale. Regola 1 (linea unica O/D) e Regola 2 (più linee).",
        status: "done",
        completedDate: "apr 2026",
      },
      {
        id: "simulatore",
        label: "Simulatore tariffa O/D",
        description: "Tool interattivo che calcola la tariffa per qualsiasi coppia di fermate, mostra il percorso sulla mappa, la fascia applicata, la regola usata e la trasparenza del calcolo.",
        status: "done",
        completedDate: "apr 2026",
      },
    ],
  },
  {
    id: "regole",
    title: "3 · Regole e Matrice Tariffaria",
    icon: Layers,
    color: "violet",
    milestones: [
      {
        id: "leg-rules",
        label: "Generazione leg rules (fare_leg_rules.txt)",
        description: "Matrice tariffaria completa: per ogni coppia di aree (from_area × to_area) viene associato il prodotto tariffario corretto. Per l'extraurbano: O(n²) coppie per ogni linea.",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "transfer-rules",
        label: "Regole di trasbordo (fare_transfer_rules.txt)",
        description: "Configurazione dei trasbordi intermodali: treno↔bus, abbonamento integrato, finestre temporali. Da definire con l'ATC le politiche di trasbordo applicabili.",
        status: "in-progress",
        targetDate: "mag 2026",
        notes: "In attesa di definizione delle politiche di trasbordo da parte dell'ATC.",
      },
      {
        id: "timeframes",
        label: "Fasce orarie tariffarie (timeframes.txt)",
        description: "Tariffe differenziate per fascia oraria (es. ore di punta vs fuori punta) o per tipo di giorno (feriale/sabato/festivo). Da valutare se applicabile alla rete ATMA.",
        status: "todo",
        targetDate: "mag 2026",
        notes: "Da valutare con ATMA se differenziazione tariffaria oraria è prevista dal contratto.",
      },
    ],
  },
  {
    id: "export",
    title: "4 · Export & Conformità GTFS",
    icon: Package,
    color: "green",
    milestones: [
      {
        id: "generate-gtfs",
        label: "Generazione CSV GTFS Fares V2",
        description: "Produzione in-memoria di tutti i file CSV conformi allo standard GTFS Fares V2 (MobilityData): networks, fare_media, rider_categories, fare_products, areas, stop_areas, fare_leg_rules, fare_transfer_rules.",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "export-zip",
        label: "Download ZIP GTFS Fares V2",
        description: "Export con un click di tutti i file tariffari in un unico archivio ZIP, con README e metadati feed_info. Pronto per consegna all'ATC o integrazione nel feed GTFS completo.",
        status: "done",
        completedDate: "apr 2026",
      },
      {
        id: "validazione",
        label: "Checklist di validazione pre-export",
        description: "10 controlli automatici prima dell'export: linee classificate, prodotti presenti, stop-areas senza duplicati, priorità regole urbane, calendario, feed info.",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "audit-log",
        label: "Registro audit normativo",
        description: "Ogni azione (modifica prezzi, generazione export, seed prodotti) viene registrata automaticamente con timestamp e autore. Possibilità di aggiungere note manuali (delibere DGR, approvazioni).",
        status: "done",
        completedDate: "apr 2026",
      },
      {
        id: "feed-info",
        label: "Feed info publisher (feed_info.txt)",
        description: "Metadati dell'editore del feed: ragione sociale, URL, lingua, versione, email contatto. Obbligatorio per i feed pubblici.",
        status: "done",
        completedDate: "mar 2026",
      },
    ],
  },
  {
    id: "analisi",
    title: "5 · Analisi & Monitoraggio",
    icon: BarChart3,
    color: "teal",
    milestones: [
      {
        id: "kpi-dashboard",
        label: "Dashboard KPI tariffario",
        description: "Copertura fermate %, linee classificate, distribuzione O/D per fascia km, prezzo medio per rete, fermate senza area assegnata.",
        status: "done",
        completedDate: "apr 2026",
      },
      {
        id: "classificazione-fermate",
        label: "Classificazione fermate per livello di servizio",
        description: "Scoring delle fermate in base a corse/giorno, ore di punta, accessibilità. Mappa con livelli di servizio sovrapposta.",
        status: "done",
        completedDate: "mar 2026",
      },
      {
        id: "confronto-scenari",
        label: "Confronto tariffe tra scenari",
        description: "Dato uno scenario KML con nuovi percorsi, calcolare come cambia la matrice tariffaria rispetto al GTFS corrente e stimare l'impatto sul revenue.",
        status: "todo",
        targetDate: "mag 2026",
        notes: "Da sviluppare dopo stabilizzazione modulo scenari.",
      },
      {
        id: "report-contrattuale",
        label: "Report contrattuale stampabile",
        description: "Documento print-friendly (o PDF) con rete attiva, tariffe vigenti, abbonamenti, ultimo export GTFS + hash, ultime voci audit. Per allegato in sede DGR.",
        status: "todo",
        targetDate: "giu 2026",
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════
// FASCE DGR
// ═══════════════════════════════════════════════════════════

const EXTRA_BANDS = [
  { fascia: 1, kmFrom: 0, kmTo: 6, price: 1.35 },
  { fascia: 2, kmFrom: 6, kmTo: 12, price: 1.85 },
  { fascia: 3, kmFrom: 12, kmTo: 18, price: 2.35 },
  { fascia: 4, kmFrom: 18, kmTo: 24, price: 2.85 },
  { fascia: 5, kmFrom: 24, kmTo: 30, price: 3.20 },
  { fascia: 6, kmFrom: 30, kmTo: 36, price: 3.55 },
  { fascia: 7, kmFrom: 36, kmTo: 42, price: 3.90 },
  { fascia: 8, kmFrom: 42, kmTo: 50, price: 4.25 },
  { fascia: 9, kmFrom: 50, kmTo: 60, price: 4.55 },
  { fascia: 10, kmFrom: 60, kmTo: 70, price: 4.85 },
  { fascia: 11, kmFrom: 70, kmTo: 80, price: 5.15 },
  { fascia: 12, kmFrom: 80, kmTo: 90, price: 5.45 },
  { fascia: 13, kmFrom: 90, kmTo: 100, price: 5.75 },
  { fascia: 14, kmFrom: 100, kmTo: 110, price: 6.05 },
  { fascia: 15, kmFrom: 110, kmTo: 120, price: 6.35 },
  { fascia: 16, kmFrom: 120, kmTo: 130, price: 6.65 },
  { fascia: 17, kmFrom: 130, kmTo: 140, price: 6.95 },
  { fascia: 18, kmFrom: 140, kmTo: 150, price: 7.25 },
  { fascia: 19, kmFrom: 150, kmTo: 160, price: 7.55 },
  { fascia: 20, kmFrom: 160, kmTo: 170, price: 7.85 },
  { fascia: 21, kmFrom: 170, kmTo: 180, price: 8.15 },
  { fascia: 22, kmFrom: 180, kmTo: 190, price: 8.45 },
  { fascia: 23, kmFrom: 190, kmTo: 200, price: 8.75 },
];

// ═══════════════════════════════════════════════════════════
// GLOSSARIO
// ═══════════════════════════════════════════════════════════

const GLOSSARY = [
  {
    term: "GTFS",
    full: "General Transit Feed Specification",
    def: "Standard internazionale per la descrizione dei dati di trasporto pubblico (orari, fermate, percorsi). Sviluppato da Google, mantenuto da MobilityData. Il sistema lavora su GTFS + estensione Fares V2.",
  },
  {
    term: "GTFS Fares V2",
    full: "GTFS Fares V2 Specification",
    def: "Estensione GTFS che descrive i sistemi tariffari in modo standardizzato. Introdotta nel 2022. Sostituisce la vecchia Fares V1. Permette di modellare biglietti, abbonamenti, zone, trasbordi e categorie di passeggeri.",
  },
  {
    term: "Fascia km",
    full: "Fascia chilometrica DGR",
    def: "Intervallo di distanza a cui corrisponde un prezzo fisso del biglietto. Definita dalla Delibera di Giunta Regionale Marche. Sono 23 fasce da 0–6 km (€1,35) fino a 190–200 km (€8,75).",
  },
  {
    term: "Percorso Dominante",
    full: "Metodo di determinazione del percorso di riferimento",
    def: "Il percorso (shape GTFS) della linea con il maggior numero di corse giornaliere. Usato come riferimento canonico per misurare i km progressivi delle fermate senza distorsioni da varianti rare.",
  },
  {
    term: "Regola 1",
    full: "Regola di calcolo Regola 1 — Linea Unica",
    def: "Si applica quando per la coppia O/D esiste una sola linea diretta. La distanza O/D viene letta direttamente sul percorso dominante di quella linea. Il km è esatto, non approssimato.",
  },
  {
    term: "Regola 2",
    full: "Regola di calcolo Regola 2 — Linee Multiple",
    def: "Si applica quando la coppia O/D è servita da più linee. La tariffa è calcolata su ciascuna linea che copre la tratta, e viene applicata la tariffa della linea con più corse (dominante tra quelle applicabili).",
  },
  {
    term: "fare_leg_rules.txt",
    full: "File GTFS Fares V2 — Regole di Tratta",
    def: "Matrice tariffaria: per ogni coppia (from_area, to_area) specifica quale fare_product applicare. È il cuore del sistema tariffario. Una rete con N aree genera O(N²) righe.",
  },
  {
    term: "fare_transfer_rules.txt",
    full: "File GTFS Fares V2 — Regole di Trasbordo",
    def: "Definisce il costo di un trasbordo tra due tratte. Può essere: A+B (somma), A+sconto (una delle due a prezzo ridotto), max(A,B) (si paga solo la più cara). Usato per abbonamenti integrati treno+bus.",
  },
  {
    term: "stop_areas.txt",
    full: "File GTFS Fares V2 — Assegnazione Fermate ad Aree",
    def: "Tabella che assegna ogni fermata (stop_id) a una o più aree tariffarie (area_id). Per le reti urbane tutte le fermate vanno nell'area flat. Per l'extraurbano ogni fermata va nell'area della sua fascia km.",
  },
  {
    term: "network_id",
    full: "Identificatore Rete Tariffaria",
    def: "Codice che identifica la rete: urbano_ancona, urbano_jesi, urbano_falconara, extraurbano. Determina quale insieme di tariffe si applica a una corsa.",
  },
  {
    term: "km progressivo",
    full: "Distanza progressiva lungo il percorso",
    def: "Distanza in km dalla prima fermata della linea fino alla fermata considerata, misurata lungo la geometria shape GTFS (non in linea d'aria). È il dato da cui si ricava la fascia tariffaria.",
  },
  {
    term: "feed_id",
    full: "Identificatore Feed GTFS",
    def: "UUID che identifica un particolare caricamento del file GTFS. Tutti i dati tariffari sono associati a un feed_id, così da poter gestire più versioni del feed senza conflitti.",
  },
];

// ═══════════════════════════════════════════════════════════
// HELPER STATUS
// ═══════════════════════════════════════════════════════════

function StatusBadge({ status }: { status: MilestoneStatus }) {
  if (status === "done") return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 rounded-full px-2 py-0.5">
      <CheckCircle2 className="w-3 h-3" /> Completato
    </span>
  );
  if (status === "in-progress") return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">
      <Clock className="w-3 h-3" /> In corso
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">
      <Circle className="w-3 h-3" /> Da fare
    </span>
  );
}

function phaseProgress(phase: Phase): { done: number; total: number; pct: number } {
  const done = phase.milestones.filter((m) => m.status === "done").length;
  const total = phase.milestones.length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

const COLOR_CLASSES: Record<string, { bg: string; border: string; text: string; bar: string; light: string }> = {
  blue:   { bg: "bg-blue-50",   border: "border-blue-200",   text: "text-blue-700",   bar: "bg-blue-500",   light: "bg-blue-100" },
  orange: { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", bar: "bg-orange-500", light: "bg-orange-100" },
  violet: { bg: "bg-violet-50", border: "border-violet-200", text: "text-violet-700", bar: "bg-violet-500", light: "bg-violet-100" },
  green:  { bg: "bg-green-50",  border: "border-green-200",  text: "text-green-700",  bar: "bg-green-500",  light: "bg-green-100" },
  teal:   { bg: "bg-teal-50",   border: "border-teal-200",   text: "text-teal-700",   bar: "bg-teal-500",   light: "bg-teal-100" },
};

// ═══════════════════════════════════════════════════════════
// SEZIONI (tab interna)
// ═══════════════════════════════════════════════════════════

const SECTIONS = [
  { id: "overview",    label: "Panoramica",       icon: BookOpen },
  { id: "methodology", label: "Come funziona",    icon: Route },
  { id: "progress",    label: "Avanzamento",      icon: CheckCircle2 },
  { id: "bands",       label: "Fasce DGR",        icon: Ruler },
  { id: "glossary",    label: "Glossario",        icon: HelpCircle },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

export default function FareDocsPage() {
  const [section, setSection] = useState<SectionId>("overview");

  const totalMilestones = PHASES.flatMap((p) => p.milestones).length;
  const doneMilestones  = PHASES.flatMap((p) => p.milestones).filter((m) => m.status === "done").length;
  const inProgressMilestones = PHASES.flatMap((p) => p.milestones).filter((m) => m.status === "in-progress").length;
  const overallPct = Math.round((doneMilestones / totalMilestones) * 100);

  const handlePrint = () => {
    const printDiv = document.getElementById("docs-printable");
    if (!printDiv) {
      alert("❌ Errore: contenuto stampabile non trovato nel DOM.");
      return;
    }

    // Apre nuova finestra con il contenuto e le stesse stylesheet
    const win = window.open("", "_blank", "width=960,height=800");
    if (!win) {
      alert("❌ Popup bloccato dal browser. Abilita i popup per questa pagina e riprova.");
      return;
    }

    // Copia tutti i tag <link> e <style> del documento corrente
    const styleLinks = Array.from(document.querySelectorAll("link[rel='stylesheet'], style"))
      .map((el) => el.outerHTML)
      .join("\n");

    win.document.write(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <title>Documentazione ATMA Scpa — TransitIntel</title>
  ${styleLinks}
  <style>
    /* Forza tema chiaro — sovrascrive variabili CSS dark mode */
    :root {
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --border: 214.3 31.8% 91.4%;
      --primary: 221.2 83.2% 53.3%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
    }
    html, body { background: #fff !important; color: #111 !important; }
    body { padding: 32px; font-family: sans-serif; }
    /* Card sempre bianche */
    [class*="card"], .card, div[class*="Card"] { background: #fff !important; border-color: #e2e8f0 !important; }
    /* Badge colori espliciti */
    [class*="bg-muted"] { background-color: #f1f5f9 !important; color: #475569 !important; }
    /* Preserva testo bianco su elementi con sfondo colorato inline */
    [style*="background-color"] { color: inherit !important; }
    [style*="background-color"] span, [style*="background-color"] * { color: white !important; }
    @media print { body { padding: 16px; } }
  </style>
</head>
<body>
  <h1 style="font-size:20px;font-weight:700;margin-bottom:4px;color:#111">Bigliettazione Elettronica — Documentazione ATMA Scpa</h1>
  <p style="font-size:12px;color:#666;margin-bottom:24px">Generato da TransitIntel · ${new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" })} · Uso interno</p>
  ${printDiv.innerHTML}
</body>
</html>`);
    win.document.close();
    win.focus();

    // Aspetta che le risorse siano caricate, poi stampa
    win.onload = () => {
      win.print();
      setTimeout(() => {
        win.close();
        alert("✅ PDF/stampa completata. Se la finestra non si è chiusa, puoi chiuderla manualmente.");
      }, 500);
    };

    // Fallback se onload non scatta
    setTimeout(() => {
      if (!win.closed) {
        win.print();
      }
    }, 1500);
  };

  return (
    <div className="p-6 max-w-[1100px] mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BookOpen className="w-7 h-7 text-primary" />
          Bigliettazione Elettronica — Documentazione
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Metodologia · Stato avanzamento · Fasce tariffarie DGR · Glossario tecnico
        </p>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Badge className="bg-green-100 text-green-800 border-green-200">ATMA Scpa</Badge>
          <Badge variant="outline">GTFS Fares V2</Badge>
          <Badge variant="outline">DGR Regione Marche</Badge>
          <Badge className="bg-amber-100 text-amber-800 border-amber-200">In sviluppo — scadenza giu 2026</Badge>
        </div>
      </div>

      {/* Progress bar globale */}
      <Card className="print:shadow-none">
        <CardContent className="pt-5">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <span className="text-sm font-semibold">Avanzamento complessivo</span>
            <div className="flex gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-600" />{doneMilestones} completati</span>
              <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-amber-500" />{inProgressMilestones} in corso</span>
              <span className="flex items-center gap-1"><Circle className="w-3 h-3 text-gray-400" />{totalMilestones - doneMilestones - inProgressMilestones} da fare</span>
            </div>
          </div>
          <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all duration-700"
              style={{ width: `${overallPct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1 text-right">{overallPct}% completato ({doneMilestones}/{totalMilestones} milestone)</p>
        </CardContent>
      </Card>

      {/* Navigazione sezioni + pulsante stampa */}
      <div id="docs-nav" className="flex items-center gap-1 border-b">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                section === s.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
        <div className="ml-auto pb-1 pr-1">
          <button
            onClick={handlePrint}
            style={{ cursor: "pointer" }}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Printer className="w-4 h-4" />
            Stampa / PDF
          </button>
        </div>
      </div>

      {/* Contenuto sezione attiva (visibile a schermo) */}
      <div>
        {section === "overview"    && <OverviewSection phases={PHASES} />}
        {section === "methodology" && <MethodologySection />}
        {section === "progress"    && <ProgressSection phases={PHASES} />}
        {section === "bands"       && <BandsSection />}
        {section === "glossary"    && <GlossarySection />}
      </div>

      {/* Versione stampabile — sempre nel DOM, visibile solo in stampa */}
      <div id="docs-printable" style={{ display: "none" }} aria-hidden="true">
        <h1 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "8px" }}>
          Bigliettazione Elettronica — Documentazione ATMA Scpa
        </h1>
        <p style={{ fontSize: "12px", color: "#666", marginBottom: "24px" }}>
          Generato da TransitIntel · {new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" })} · Uso interno
        </p>
        <div className="space-y-12">
          <OverviewSection phases={PHASES} />
          <MethodologySection printMode />
          <ProgressSection phases={PHASES} />
          <BandsSection />
          <GlossarySection />
          <AnalyticsSection />
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SEZIONE 1: PANORAMICA
// ═══════════════════════════════════════════════════════════

function OverviewSection({ phases }: { phases: Phase[] }) {
  return (
    <div className="space-y-6">
      {/* Contesto */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            Contesto del progetto
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3 text-muted-foreground leading-relaxed">
          <p>
            <strong className="text-foreground">Obiettivo:</strong> Costruire l'infrastruttura software per la bigliettazione elettronica
            della rete ATMA Scpa (Ancona e provincia), in conformità con lo standard{" "}
            <strong className="text-foreground">GTFS Fares V2</strong> e le tariffe definite dalla{" "}
            <strong className="text-foreground">DGR Regione Marche</strong>.
          </p>
          <p>
            Il sistema calcola automaticamente la tariffa per qualsiasi coppia
            origine-destinazione (O/D) sulla rete, partendo dai dati GTFS già disponibili.
            L'output è un set di file CSV standardizzati, consegnabili all'ATC e
            integrabili in qualsiasi validatore EMV o app di bigliettazione conforme a GTFS.
          </p>
          <p>
            <strong className="text-foreground">Cosa NON richiede:</strong> il sistema lavora interamente in <em>fase preventiva e analitica</em> —
            non richiede connessione a GPS dei veicoli, validatori a bordo o sistemi di pagamento reali.
            Produce la <em>configurazione tariffaria</em> che quei sistemi utilizzeranno.
          </p>
        </CardContent>
      </Card>

      {/* Architettura a 3 livelli */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            Architettura del sistema
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                step: "1",
                title: "Dati GTFS",
                desc: "Feed GTFS caricato (stops, routes, trips, shapes, stop_times, calendar). È la fonte di verità per percorsi e fermate.",
                icon: Database,
                color: "blue",
              },
              {
                step: "2",
                title: "Motore tariffario",
                desc: "Calcola km progressivi, assegna zone, genera la matrice O/D. Applica Regola 1 o Regola 2 in base alla topologia della rete.",
                icon: Zap,
                color: "violet",
              },
              {
                step: "3",
                title: "Output GTFS Fares V2",
                desc: "File CSV standardizzati: fare_products, areas, stop_areas, fare_leg_rules. Consegnabili all'ATC / integrabili in validatori.",
                icon: Package,
                color: "green",
              },
            ].map((item) => {
              const Icon = item.icon;
              const c = COLOR_CLASSES[item.color];
              return (
                <div key={item.step} className={`rounded-lg border p-4 ${c.bg} ${c.border}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center ${c.light} ${c.text}`}>{item.step}</span>
                    <Icon className={`w-4 h-4 ${c.text}`} />
                    <span className={`font-semibold text-sm ${c.text}`}>{item.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground">
            <span>GTFS Upload</span>
            <ArrowRight className="w-3 h-3" />
            <span>Classificazione linee</span>
            <ArrowRight className="w-3 h-3" />
            <span>Generazione zone</span>
            <ArrowRight className="w-3 h-3" />
            <span>Leg rules</span>
            <ArrowRight className="w-3 h-3" />
            <span>Export ZIP</span>
          </div>
        </CardContent>
      </Card>

      {/* Riepilogo fasi */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {phases.map((phase) => {
          const { done, total, pct } = phaseProgress(phase);
          const Icon = phase.icon;
          const c = COLOR_CLASSES[phase.color];
          return (
            <div key={phase.id} className={`rounded-lg border p-4 ${c.bg} ${c.border}`}>
              <div className="flex items-center gap-2 mb-3">
                <Icon className={`w-4 h-4 ${c.text}`} />
                <span className={`text-sm font-semibold ${c.text}`}>{phase.title}</span>
              </div>
              <div className="w-full bg-white/60 rounded-full h-1.5 mb-2">
                <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${pct}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">{done}/{total} milestone · {pct}%</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SEZIONE 2: METODOLOGIA
// ═══════════════════════════════════════════════════════════

function MethodologySection({ printMode = false }: { printMode?: boolean }) {
  const [open, setOpen] = useState<string | null>("regola1");

  const toggle = (id: string) => setOpen((v) => v === id ? null : id);

  const sections = [
    {
      id: "reti",
      title: "Reti tariffarie",
      icon: Layers,
      content: (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>La rete ATMA è suddivisa in <strong className="text-foreground">7 reti tariffarie</strong>:</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { id: "urbano_ancona",        name: "Urbano Ancona",        color: "#3b82f6", rule: "Linee che iniziano con cifra o C.D./C.S.", tariff: "Biglietto flat (60 min €1,35 / 100 min €1,50)" },
              { id: "urbano_jesi",          name: "Urbano Jesi",          color: "#8b5cf6", rule: "Linee che iniziano con \"JE\"", tariff: "Biglietto flat (60 min €1,35 / A/R €2,20)" },
              { id: "urbano_falconara",     name: "Urbano Falconara",     color: "#06b6d4", rule: "Linee che iniziano con \"Y\"", tariff: "Biglietto flat (60 min €1,35 / A/R €2,00)" },
              { id: "urbano_senigallia",    name: "Urbano Senigallia",    color: "#10b981", rule: "Linee che iniziano con \"SG\"", tariff: "Biglietto flat urbano" },
              { id: "urbano_castelfidardo", name: "Urbano Castelfidardo", color: "#f97316", rule: "Linee che iniziano con \"CF\"", tariff: "Biglietto flat urbano" },
              { id: "urbano_sassoferrato",  name: "Urbano Sassoferrato",  color: "#ec4899", rule: "Linee che iniziano con \"SS\"", tariff: "Biglietto flat urbano" },
              { id: "extraurbano",          name: "Extraurbano",          color: "#64748b", rule: "Tutte le altre linee", tariff: "Tariffazione km progressivi — 23 fasce DGR" },
            ].map((n) => (
              <div key={n.id} className="border rounded p-3 bg-background" style={{ borderLeftColor: n.color, borderLeftWidth: 3 }}>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: n.color }} />
                  <p className="font-semibold text-foreground text-sm">{n.name}</p>
                </div>
                <p className="text-xs mt-1"><span className="font-medium">Classificazione:</span> {n.rule}</p>
                <p className="text-xs mt-0.5"><span className="font-medium">Tariffa:</span> {n.tariff}</p>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: "regola1",
      title: "Regola 1 — Linea unica O/D",
      icon: Route,
      content: (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Si applica quando la coppia O/D è servita da <strong className="text-foreground">una sola linea diretta</strong> (es. fermata A e fermata B sono entrambe sulla linea 90).
          </p>
          <div className="bg-muted/60 rounded p-3 space-y-2">
            <p className="font-semibold text-foreground text-xs uppercase tracking-wide">Algoritmo</p>
            <ol className="space-y-1 text-xs list-decimal list-inside">
              <li>Identificare tutte le linee che servono sia la fermata di origine che quella di destinazione</li>
              <li>Se esiste una sola linea → è Regola 1</li>
              <li>Trovare il <strong className="text-foreground">percorso dominante</strong> di quella linea (trip con più corse giornaliere)</li>
              <li>Leggere la sequenza di fermate sul percorso dominante</li>
              <li>Calcolare la distanza O/D come differenza dei km progressivi sulla shape GTFS</li>
              <li>Assegnare la fascia DGR corrispondente alla distanza calcolata</li>
            </ol>
          </div>
          <p className="text-xs">
            <strong className="text-foreground">Nota:</strong> il km viene letto <em>direttamente sulla geometria shape</em>,
            non proiettato ortogonalmente. Questo garantisce la corrispondenza esatta con la distanza percorsa dal mezzo.
          </p>
        </div>
      ),
    },
    {
      id: "regola2",
      title: "Regola 2 — Più linee servono l'O/D",
      icon: Layers,
      content: (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Si applica quando la coppia O/D è servita da <strong className="text-foreground">due o più linee</strong> (es. sia la linea 90 che la linea 91 fermano in A e in B).
          </p>
          <div className="bg-muted/60 rounded p-3 space-y-2">
            <p className="font-semibold text-foreground text-xs uppercase tracking-wide">Algoritmo</p>
            <ol className="space-y-1 text-xs list-decimal list-inside">
              <li>Identificare tutte le linee che servono sia O che D</li>
              <li>Per ogni linea: calcolare la distanza O/D sul suo percorso dominante</li>
              <li>Trovare la linea con il <strong className="text-foreground">maggior numero di corse giornaliere</strong> tra quelle applicabili</li>
              <li>Applicare la fascia della linea dominante</li>
            </ol>
          </div>
          <p className="text-xs">
            La logica rispecchia il principio che il servizio prevalente — quello su cui viaggiano più passeggeri —
            deve essere il riferimento tariffario.
          </p>
        </div>
      ),
    },
    {
      id: "kmcalc",
      title: "Calcolo km progressivi",
      icon: Ruler,
      content: (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>Esistono due metodi di calcolo del km progressivo di ogni fermata, selezionabili nella pagina Bigliettazione:</p>
          <div className="space-y-3">
            <div className="border rounded p-3 bg-background">
              <p className="font-semibold text-foreground text-sm">Proiezione su Shape (media ponderata)</p>
              <p className="text-xs mt-1">
                Per ogni fermata, considera <em>tutti</em> i percorsi (shape) della linea. Il km progressivo è la
                media ponderata per numero di corse. Utile per analisi comparative tra varianti.
              </p>
              <p className="text-xs mt-1 text-amber-600">Strumento analitico — non raccomandato per tariffazione ufficiale (nessuna base normativa esplicita).</p>
            </div>
            <div className="border rounded p-3 bg-background border-primary/30">
              <div className="flex items-center gap-1 mb-1">
                <p className="font-semibold text-foreground text-sm">Regola 1/2 — Ricerca automatica</p>
                <Badge className="text-[10px] bg-primary/10 text-primary border-primary/20">Consigliato</Badge>
              </div>
              <p className="text-xs mt-1">
                Cerca tutte le linee extraurbane che servono le due fermate. Se più linee collegano la stessa
                relazione O-D, applica la <strong>Regola 2</strong> (media semplice tra i percorsi), altrimenti
                usa la <strong>Regola 1</strong> (percorso dominante della linea). Degrada automaticamente al
                caso più semplice.
              </p>
              <p className="text-xs mt-1 text-green-600">Rispetta esattamente l'Allegato A DGR punto 2.d: <em>"il prezzo è calcolato sulla media della lunghezza"</em>.</p>
            </div>
          </div>

          {/* ── DIAGRAMMA VISUALE ── */}
          <div className="mt-4 border rounded-lg overflow-hidden bg-background">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-3 pt-3 pb-2">Confronto visuale dei due metodi</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x">
              {/* Proiezione su Shape */}
              <div className="p-3">
                <p className="text-xs font-semibold text-amber-700 mb-2">① Proiezione su Shape (media ponderata)</p>
                {/*
                  Scena: una fermata F (punto giallo) non sta su nessuna shape.
                  Viene proiettata ortogonalmente su Shape A → ottiene km_A=38.
                  Viene proiettata ortogonalmente su Shape B → ottiene km_B=44.
                  La media ponderata (6 corse A, 2 corse B) → km = 39.5
                */}
                <svg viewBox="0 0 220 160" className="w-full" style={{ maxHeight: 160 }}>
                  <defs>
                    <marker id="projArrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#f59e0b"/></marker>
                    <marker id="projArrowB" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#6366f1"/></marker>
                    <marker id="kmArr" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#64748b"/></marker>
                  </defs>

                  {/* ── Shape A: curva arancione (6 corse — dominante) ── */}
                  <path d="M 20 80 C 55 30 95 30 130 60 C 160 85 185 65 200 50" fill="none" stroke="#f59e0b" strokeWidth="2.5" />
                  <text x="110" y="26" fontSize="8" fill="#b45309" fontWeight="bold" textAnchor="middle">Shape A</text>
                  <text x="110" y="36" fontSize="7" fill="#b45309" textAnchor="middle">(6 corse)</text>

                  {/* ── Shape B: curva viola (2 corse — secondaria) ── */}
                  <path d="M 20 80 C 55 110 100 115 140 105 C 165 98 190 90 200 85" fill="none" stroke="#6366f1" strokeWidth="2" strokeDasharray="5 3" />
                  <text x="110" y="122" fontSize="8" fill="#4338ca" fontWeight="bold" textAnchor="middle">Shape B</text>
                  <text x="110" y="131" fontSize="7" fill="#4338ca" textAnchor="middle">(2 corse)</text>

                  {/* ── Fermata F ── */}
                  <circle cx="112" cy="75" r="6" fill="#ef4444" stroke="white" strokeWidth="2" />
                  <text x="122" y="72" fontSize="8.5" fill="#b91c1c" fontWeight="bold">F</text>

                  {/* ── Proiezione ortogonale su Shape A → punto P_A ── */}
                  {/* Punto più vicino su Shape A approssimativamente (x=125, y=62) */}
                  <circle cx="126" cy="62" r="4" fill="#f59e0b" stroke="white" strokeWidth="1.5" />
                  {/* Linea perpendicolare da F a P_A */}
                  <line x1="112" y1="75" x2="126" y2="62" stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="3 2" markerEnd="url(#projArrow)" />
                  {/* Angolo retto */}
                  <rect x="115" y="63" width="5" height="5" fill="none" stroke="#f59e0b" strokeWidth="1" transform="rotate(-45,117.5,65.5)" />
                  <text x="136" y="58" fontSize="7" fill="#b45309">P_A (km=38)</text>

                  {/* ── Proiezione ortogonale su Shape B → punto P_B ── */}
                  {/* Punto più vicino su Shape B approssimativamente (x=112, y=108) */}
                  <circle cx="112" cy="107" r="4" fill="#6366f1" stroke="white" strokeWidth="1.5" />
                  <line x1="112" y1="81" x2="112" y2="103" stroke="#6366f1" strokeWidth="1.5" strokeDasharray="3 2" markerEnd="url(#projArrowB)" />
                  <rect x="107" y="96" width="5" height="5" fill="none" stroke="#6366f1" strokeWidth="1" />
                  <text x="120" y="113" fontSize="7" fill="#4338ca">P_B (km=44)</text>

                  {/* ── Risultato media ponderata ── */}
                  <rect x="18" y="143" width="186" height="14" rx="4" fill="#fef3c7" stroke="#f59e0b" strokeWidth="1" />
                  <text x="111" y="153" fontSize="8" fill="#92400e" textAnchor="middle" fontWeight="bold">
                    km_medio = (38×6 + 44×2) / 8 = <tspan fill="#b45309">39.5 km</tspan>
                  </text>
                </svg>
              </div>
              {/* Percorso Dominante */}
              <div className="p-3">
                <p className="text-xs font-semibold text-green-700 mb-2">② Percorso Dominante (deterministico)</p>
                <svg viewBox="0 0 220 160" className="w-full" style={{ maxHeight: 160 }}>
                  <defs>
                    <marker id="domArr" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="#22c55e"/></marker>
                  </defs>

                  {/* Shape secondaria sfumata */}
                  <path d="M 20 80 C 55 110 100 115 140 105 C 165 98 190 90 200 85" fill="none" stroke="#e2e8f0" strokeWidth="1.5" strokeDasharray="4 3" />
                  <text x="110" y="122" fontSize="7" fill="#cbd5e1" textAnchor="middle">Shape B (ignorata)</text>

                  {/* Shape dominante evidenziata */}
                  <path d="M 20 80 C 55 30 95 30 130 60 C 160 85 185 65 200 50" fill="none" stroke="#22c55e" strokeWidth="3" />
                  <text x="110" y="26" fontSize="8" fill="#15803d" fontWeight="bold" textAnchor="middle">Shape Dominante</text>
                  <text x="110" y="36" fontSize="7" fill="#15803d" textAnchor="middle">(6 corse — usata)</text>

                  {/* Fermate direttamente sulla shape */}
                  {[
                    { cx: 20, cy: 80, km: "0 km" },
                    { cx: 75, cy: 40, km: "22 km" },
                    { cx: 130, cy: 60, km: "38 km" },
                    { cx: 200, cy: 50, km: "55 km" },
                  ].map((s, i) => (
                    <g key={i}>
                      <circle cx={s.cx} cy={s.cy} r="5" fill="#15803d" stroke="white" strokeWidth="1.5" />
                      <text x={s.cx} y={s.cy - 9} fontSize="7.5" fill="#15803d" textAnchor="middle" fontWeight="bold">{s.km}</text>
                    </g>
                  ))}

                  {/* Freccia km diretta */}
                  <line x1="20" y1="148" x2="128" y2="148" stroke="#22c55e" strokeWidth="2" markerEnd="url(#domArr)" />
                  <text x="74" y="144" fontSize="7" fill="#15803d" textAnchor="middle">38 km progressivi</text>

                  {/* Badge risultato */}
                  <rect x="28" y="143" width="166" height="14" rx="4" fill="#dcfce7" stroke="#22c55e" strokeWidth="1" />
                  <text x="111" y="153" fontSize="8" fill="#166534" textAnchor="middle" fontWeight="bold">
                    km = <tspan fill="#15803d">38 km</tspan> — lettura diretta sulla shape ✓
                  </text>
                </svg>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "workflow",
      title: "Flusso operativo — dall'upload all'export",
      icon: ArrowRight,
      content: (
        <div className="space-y-2 text-sm text-muted-foreground">
          {[
            { n: 1, label: "Carica il feed GTFS", page: "Dati & GTFS", desc: "Drag & drop del file ZIP GTFS. Il sistema analizza e carica fermate, linee, corse, orari, forme." },
            { n: 2, label: "Verifica classificazione linee", page: "Bigliettazione → Reti", desc: "Controllo automatico. Se una linea non è classificata correttamente, si corregge manualmente." },
            { n: 3, label: "Seed prodotti tariffari", page: "Bigliettazione → Prodotti", desc: "Genera biglietti + abbonamenti dalla configurazione DGR. Modificabili singolarmente." },
            { n: 4, label: "Genera zone extraurbane", page: "Bigliettazione → Zone", desc: "Per ogni linea extraurbana: assegna le fermate alle fasce km. Usa il percorso dominante." },
            { n: 5, label: "Genera leg rules", page: "Bigliettazione → Regole Tratta", desc: "Costruisce la matrice tariffaria completa O/D per tutte le reti." },
            { n: 6, label: "Simula tariffa", page: "Bigliettazione → Simulatore", desc: "Testa qualsiasi coppia O/D. Verifica Regola 1/2, fascia applicata, mappa del percorso." },
            { n: 7, label: "Valida e aggiungi note audit", page: "Analisi Tariffaria → Audit", desc: "Checklist automatica pre-export. Aggiungi riferimento delibera DGR al registro." },
            { n: 8, label: "Esporta ZIP GTFS Fares V2", page: "Analisi Tariffaria → Export", desc: "Download del pacchetto completo, pronto per consegna all'ATC." },
          ].map((step) => (
            <div key={step.n} className="flex gap-3 items-start">
              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                {step.n}
              </span>
              <div>
                <p className="font-medium text-foreground">{step.label} <span className="text-xs text-muted-foreground">→ <em>{step.page}</em></span></p>
                <p className="text-xs mt-0.5">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {sections.map((s) => {
        const Icon = s.icon;
        const isOpen = printMode || open === s.id;
        return (
          <Card key={s.id} className="overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-muted/40 transition-colors text-left"
              onClick={() => !printMode && toggle(s.id)}
            >
              <span className="flex items-center gap-2 font-semibold text-sm">
                <Icon className="w-4 h-4 text-primary" />
                {s.title}
              </span>
              {!printMode && (isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />)}
            </button>
            {isOpen && (
              <div className="px-5 pb-5 border-t bg-muted/10">
                <div className="pt-4">{s.content}</div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SEZIONE 3: AVANZAMENTO MILESTONE
// ═══════════════════════════════════════════════════════════

function ProgressSection({ phases }: { phases: Phase[] }) {
  return (
    <div className="space-y-6">
      {phases.map((phase) => {
        const { done, total, pct } = phaseProgress(phase);
        const Icon = phase.icon;
        const c = COLOR_CLASSES[phase.color];
        return (
          <Card key={phase.id} className={`border ${c.border}`}>
            <CardHeader className={`pb-2 ${c.bg} rounded-t-lg`}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className={`text-sm flex items-center gap-2 ${c.text}`}>
                  <Icon className="w-4 h-4" />
                  {phase.title}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{done}/{total}</span>
                  <div className="w-24 bg-white/60 rounded-full h-1.5">
                    <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className={`text-xs font-semibold ${c.text}`}>{pct}%</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="space-y-3">
                {phase.milestones.map((m) => (
                  <div key={m.id} className="flex gap-3">
                    <div className="mt-0.5">
                      {m.status === "done"        && <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />}
                      {m.status === "in-progress" && <Clock        className="w-4 h-4 text-amber-500 shrink-0" />}
                      {m.status === "todo"        && <Circle       className="w-4 h-4 text-gray-300 shrink-0" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm font-medium ${m.status === "todo" ? "text-muted-foreground" : "text-foreground"}`}>
                          {m.label}
                        </span>
                        <StatusBadge status={m.status} />
                        {m.completedDate && (
                          <span className="text-xs text-muted-foreground">✓ {m.completedDate}</span>
                        )}
                        {m.targetDate && m.status !== "done" && (
                          <span className="text-xs text-amber-600">→ target: {m.targetDate}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{m.description}</p>
                      {m.notes && (
                        <p className="text-xs mt-1 text-amber-700 bg-amber-50 rounded px-2 py-1 border border-amber-100">
                          <AlertCircle className="w-3 h-3 inline mr-1" />
                          {m.notes}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SEZIONE 4: FASCE DGR
// ═══════════════════════════════════════════════════════════

function BandsSection() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Ruler className="w-4 h-4 text-primary" />
            23 Fasce chilometriche — DGR Regione Marche
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Le tariffe extraurbane sono definite dalla <strong className="text-foreground">Delibera di Giunta Regionale Marche</strong>.
            Ogni fascia corrisponde a un intervallo di distanza percorsa. La distanza viene calcolata
            sul percorso dominante della linea, dalla fermata di origine a quella di destinazione.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left pb-2 pr-4 font-medium">Fascia</th>
                  <th className="text-left pb-2 pr-4 font-medium">Da km</th>
                  <th className="text-left pb-2 pr-4 font-medium">A km</th>
                  <th className="text-right pb-2 pr-4 font-medium">Prezzo</th>
                  <th className="text-left pb-2 font-medium">Visuale</th>
                </tr>
              </thead>
              <tbody>
                {EXTRA_BANDS.map((b) => {
                  const maxPrice = 8.75;
                  const pct = (b.price / maxPrice) * 100;
                  return (
                    <tr key={b.fascia} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="py-1.5 pr-4">
                        <span className="font-mono text-xs bg-muted rounded px-1.5 py-0.5">F{b.fascia}</span>
                      </td>
                      <td className="py-1.5 pr-4 text-muted-foreground">{b.kmFrom}</td>
                      <td className="py-1.5 pr-4 text-muted-foreground">{b.kmTo}</td>
                      <td className="py-1.5 pr-4 text-right font-semibold">€{b.price.toFixed(2)}</td>
                      <td className="py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="w-32 bg-muted rounded-full h-2 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-orange-400"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            <strong>Scaglione:</strong> ogni fascia ha un incremento di €0,30–0,50 rispetto alla precedente. ·
            <strong> Nota:</strong> i prezzi degli abbonamenti mensili sono calcolati come ~65% del costo di 22 corse (ordinario) o ~50% (studente).
          </p>
        </CardContent>
      </Card>

      {/* Prezzi urbani */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="w-4 h-4 text-primary" />
            Tariffe reti urbane
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            {[
              {
                name: "Urbano Ancona",
                tickets: [
                  { label: "Biglietto 60 min", price: "€1,35" },
                  { label: "Biglietto 100 min", price: "€1,50" },
                  { label: "Abbonamento settimanale", price: "€12,50" },
                  { label: "Abbonamento mensile", price: "€37,00" },
                  { label: "Abbonamento mensile studente", price: "€26,00" },
                  { label: "Abbonamento annuale", price: "€360,00" },
                ],
              },
              {
                name: "Urbano Jesi",
                tickets: [
                  { label: "Biglietto 60 min", price: "€1,35" },
                  { label: "Biglietto A/R", price: "€2,20" },
                  { label: "Abbonamento settimanale", price: "€11,00" },
                  { label: "Abbonamento mensile", price: "€33,00" },
                  { label: "Abbonamento annuale", price: "€310,00" },
                ],
              },
              {
                name: "Urbano Falconara",
                tickets: [
                  { label: "Biglietto 60 min", price: "€1,35" },
                  { label: "Biglietto A/R", price: "€2,00" },
                  { label: "Abbonamento settimanale", price: "€11,00" },
                  { label: "Abbonamento mensile", price: "€33,00" },
                  { label: "Abbonamento annuale", price: "€310,00" },
                ],
              },
            ].map((net) => (
              <div key={net.name} className="border rounded p-3">
                <p className="font-semibold mb-2 text-sm">{net.name}</p>
                <div className="space-y-1">
                  {net.tickets.map((t) => (
                    <div key={t.label} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{t.label}</span>
                      <span className="font-medium">{t.price}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            * I prezzi mostrati sono quelli attualmente inseriti nel sistema. Verificare sempre con l'ultima DGR vigente prima della consegna all'ATC.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SEZIONE 5: GLOSSARIO
// ═══════════════════════════════════════════════════════════

function GlossarySection() {
  const [filter, setFilter] = useState("");
  const filtered = GLOSSARY.filter(
    (g) =>
      !filter ||
      g.term.toLowerCase().includes(filter.toLowerCase()) ||
      g.def.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <input
          className="flex-1 border rounded px-3 py-2 text-sm bg-background max-w-xs"
          placeholder="Cerca nel glossario…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setFilter("")}
          >
            Cancella
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {filtered.map((entry) => (
          <Card key={entry.term} className="overflow-hidden">
            <CardContent className="pt-4">
              <div className="flex items-start gap-2">
                <HelpCircle className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">{entry.term}</p>
                  {entry.full !== entry.term && (
                    <p className="text-xs text-muted-foreground italic">{entry.full}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{entry.def}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground col-span-2 text-center py-8">Nessun termine trovato per "{filter}".</p>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SEZIONE 6: ANALISI TARIFFARIA & CLUSTER (solo stampa)
// ═══════════════════════════════════════════════════════════

const FARE_TYPE_LABELS: Record<string, string> = {
  single: "Corsa semplice",
  return: "Andata/Ritorno",
  zone: "Zonale extraurbano",
  abbonamento_settimanale: "Abbonamento Settimanale",
  abbonamento_mensile: "Abbonamento Mensile",
  abbonamento_annuale: "Abbonamento Annuale",
};

const NET_LABELS: Record<string, string> = {
  urbano_ancona: "Urbano Ancona",
  urbano_jesi: "Urbano Jesi",
  urbano_falconara: "Urbano Falconara",
  urbano_senigallia: "Urbano Senigallia",
  urbano_castelfidardo: "Urbano Castelfidardo",
  urbano_sassoferrato: "Urbano Sassoferrato",
  extraurbano: "Extraurbano",
};

interface KpiData {
  coverage: { totalStops: number; coveredStops: number; coveragePercent: number; uncoveredCount: number };
  routes: { total: number; classified: number; classifiedPercent: number };
  productsByType: Array<{ fare_type: string; cnt: string; min_price: string; max_price: string }>;
  avgPriceByNetwork: Array<{ network_id: string; avg_price: string; products: string }>;
  fasciaDistribution: Array<{ fare_product_id: string; amount: string; fare_product_name: string; od_pairs: string }>;
  legRulesByNetwork: Array<{ network_id: string; cnt: string }>;
}

interface FareProduct {
  id: string;
  fareProductId: string;
  fareProductName: string;
  networkId: string | null;
  riderCategoryId: string | null;
  fareMediaId: string | null;
  amount: number;
  fareType: string;
}

interface Cluster {
  clusterId: string;
  clusterName: string;
  color: string | null;
  stopCount: number;
  centroidLat: number | null;
  centroidLon: number | null;
}

interface ClusterStop {
  stopId: string;
  stopName: string;
  stopLat: number | null;
  stopLon: number | null;
}

interface ClusterFull extends Cluster {
  stops: ClusterStop[];
}

const MEDIA_TYPE_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "Nessun supporto (cash)", color: "bg-gray-100 text-gray-700" },
  1: { label: "Biglietto cartaceo", color: "bg-yellow-100 text-yellow-800" },
  2: { label: "Tessera contactless", color: "bg-blue-100 text-blue-800" },
  3: { label: "cEMV (carta bancaria)", color: "bg-purple-100 text-purple-800" },
  4: { label: "App mobile", color: "bg-green-100 text-green-800" },
};

const NET_COLORS: Record<string, string> = {
  urbano_ancona:        "#3b82f6",
  urbano_jesi:          "#8b5cf6",
  urbano_falconara:     "#06b6d4",
  urbano_senigallia:    "#10b981",
  urbano_castelfidardo: "#f97316",
  urbano_sassoferrato:  "#ec4899",
  extraurbano:          "#f59e0b",
};

const NET_CLASSIFY: Record<string, string> = {
  urbano_ancona:        "Linee numeriche, C.D., C.S.",
  urbano_jesi:          "Linee JE***",
  urbano_falconara:     "Linee Y***",
  urbano_senigallia:    "Linee BUSS*, BUS***",
  urbano_castelfidardo: "Linee CIRCA, CIRCB",
  urbano_sassoferrato:  "Classificato come extraurbano",
  extraurbano:          "Tutte le altre linee",
};

interface FareMedia {
  id: string;
  fareMediaId: string;
  fareMediaName: string;
  fareMediaType: number;
  isActive: boolean;
}

interface RiderCategory {
  id: string;
  riderCategoryId: string;
  riderCategoryName: string;
  isDefault: boolean;
  eligibilityUrl: string | null;
}

interface RouteNetwork {
  routeId: string;
  shortName: string | null;
  longName: string | null;
  routeColor: string | null;
  networkId: string | null;
  defaultNetworkId: string;
}

interface Network {
  id: string;
  networkId: string;
  networkName: string;
  networkUrl: string | null;
  timezone: string | null;
}

function AnalyticsSection() {
  const [kpi, setKpi] = useState<KpiData | null>(null);
  const [products, setProducts] = useState<FareProduct[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [fullClusters, setFullClusters] = useState<ClusterFull[]>([]);
  const [media, setMedia] = useState<FareMedia[]>([]);
  const [riders, setRiders] = useState<RiderCategory[]>([]);
  const [routeNets, setRouteNets] = useState<RouteNetwork[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<KpiData>("/api/fares/kpi").catch(() => null),
      apiFetch<FareProduct[]>("/api/fares/products").catch(() => []),
      apiFetch<ClusterFull[]>("/api/fares/zone-clusters/full").catch(() => []),
      apiFetch<FareMedia[]>("/api/fares/media").catch(() => []),
      apiFetch<RiderCategory[]>("/api/fares/rider-categories").catch(() => []),
      apiFetch<RouteNetwork[]>("/api/fares/route-networks").catch(() => []),
      apiFetch<Network[]>("/api/fares/networks").catch(() => []),
    ]).then(([k, p, c, m, r, rn, n]) => {
      if (k) setKpi(k as KpiData);
      setProducts(p as FareProduct[]);
      const fc = c as ClusterFull[];
      setFullClusters(fc);
      setClusters(fc.map(({ stops: _s, ...rest }) => rest));
      setMedia(m as FareMedia[]);
      setRiders(r as RiderCategory[]);
      setRouteNets(rn as RouteNetwork[]);
      setNetworks(n as Network[]);
      setLoading(false);
    });
  }, []);

  if (loading) return (
    <div className="py-8 text-center text-muted-foreground text-sm">Caricamento dati analitici…</div>
  );

  const abbonamenti = products.filter((p) => p.fareType.startsWith("abbonamento"));
  const biglietti = products.filter((p) => !p.fareType.startsWith("abbonamento"));

  // Raggruppa linee per rete
  const routesByNet = routeNets.reduce<Record<string, RouteNetwork[]>>((acc, r) => {
    const net = r.networkId ?? r.defaultNetworkId ?? "extraurbano";
    if (!acc[net]) acc[net] = [];
    acc[net].push(r);
    return acc;
  }, {});

  return (
    <div className="space-y-8">
      <h2 className="text-xl font-bold flex items-center gap-2 border-b pb-2">
        <BarChart3 className="w-5 h-5 text-primary" />
        Analisi Tariffaria & Bigliettazione
      </h2>

      {/* ── KPI OVERVIEW ── */}
      {kpi && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Copertura fermate", value: `${kpi.coverage.coveragePercent.toFixed(1)}%`, sub: `${kpi.coverage.coveredStops}/${kpi.coverage.totalStops}`, ok: kpi.coverage.coveragePercent >= 95 },
            { label: "Linee classificate", value: `${kpi.routes.classifiedPercent.toFixed(1)}%`, sub: `${kpi.routes.classified}/${kpi.routes.total}`, ok: kpi.routes.classifiedPercent >= 100 },
            { label: "Prodotti tariffari", value: String(products.length), sub: `${kpi.productsByType.length} tipologie`, ok: true },
            { label: "Cluster territoriali", value: String(clusters.length), sub: "zone extraurbane", ok: clusters.length > 0 },
          ].map((c) => (
            <Card key={c.label} className={c.ok ? "bg-white" : "border-orange-200 bg-orange-50"}>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className="text-2xl font-bold">{c.value}</p>
                <p className="text-xs text-muted-foreground">{c.sub}</p>
                <div className={`mt-2 h-1 rounded-full ${c.ok ? "bg-green-500" : "bg-orange-400"}`} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── RETI TARIFFARIE ── */}
      {networks.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              Reti Tariffarie ({networks.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {networks.map((n) => (
                <div key={n.networkId} className="border rounded-lg p-3 bg-white flex items-start gap-3">
                  <div className="w-3 h-3 rounded-full mt-1 shrink-0" style={{ backgroundColor: NET_COLORS[n.networkId] ?? "#94a3b8" }} />
                  <div className="min-w-0">
                    <div className="font-semibold text-sm">{n.networkName}</div>
                    <div className="text-xs text-muted-foreground font-mono">{n.networkId}</div>
                    <div className="text-xs text-muted-foreground mt-1">{NET_CLASSIFY[n.networkId] ?? "—"}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {routesByNet[n.networkId]?.length ?? 0} linee assegnate
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── CLASSIFICAZIONE LINEE ── */}
      {routeNets.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Route className="w-4 h-4 text-primary" />
              Classificazione Linee GTFS ({routeNets.length} linee)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(routesByNet)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([netId, routes]) => (
                  <div key={netId}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: NET_COLORS[netId] ?? "#94a3b8" }} />
                      <span className="text-sm font-semibold">{NET_LABELS[netId] ?? netId}</span>
                      <Badge className="text-[10px] text-white px-2" style={{ backgroundColor: NET_COLORS[netId] ?? "#94a3b8" }}>
                        {routes.length} linee
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pl-4">
                      {routes.map((r) => {
                        const bg = r.routeColor ? `#${r.routeColor}` : (NET_COLORS[netId] ?? "#94a3b8");
                        // Calcola luminanza per scegliere testo chiaro o scuro
                        const hex = bg.replace("#", "");
                        const rgb = hex.length === 6 ? [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)] : [148,163,184];
                        const lum = (0.299*rgb[0] + 0.587*rgb[1] + 0.114*rgb[2]) / 255;
                        const textColor = lum > 0.55 ? "#1e293b" : "#ffffff";
                        return (
                          <div
                            key={r.routeId}
                            className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                            style={{ backgroundColor: bg, color: textColor }}
                          >
                            <span className="font-mono">{r.shortName ?? r.routeId}</span>
                            {r.longName && <span style={{ opacity: 0.85 }} className="font-normal truncate max-w-[120px]">{r.longName}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── SUPPORTI TARIFFARI ── */}
      {media.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Supporti Tariffari — fare_media ({media.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {media.map((m) => {
                const typeInfo = MEDIA_TYPE_LABELS[m.fareMediaType] ?? { label: `Tipo ${m.fareMediaType}`, color: "bg-gray-100 text-gray-700" };
                return (
                  <div key={m.fareMediaId} className={`border rounded-lg p-3 bg-white ${!m.isActive ? "opacity-50" : ""}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-sm">{m.fareMediaName}</div>
                        <div className="text-xs font-mono text-muted-foreground">{m.fareMediaId}</div>
                      </div>
                      {!m.isActive && <Badge className="text-[10px] bg-gray-100 text-gray-500">Inattivo</Badge>}
                    </div>
                    <div className="mt-2">
                      <Badge className={`text-[10px] ${typeInfo.color}`}>{typeInfo.label}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── CATEGORIE PASSEGGERO ── */}
      {riders.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-primary" />
              Categorie Passeggero — rider_categories ({riders.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground text-xs">
                  <th className="text-left pb-1.5 pr-3 font-medium">ID</th>
                  <th className="text-left pb-1.5 pr-3 font-medium">Nome</th>
                  <th className="text-left pb-1.5 pr-3 font-medium">Default</th>
                  <th className="text-left pb-1.5 font-medium">URL Idoneità</th>
                </tr>
              </thead>
              <tbody>
                {riders.map((r) => (
                  <tr key={r.riderCategoryId} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{r.riderCategoryId}</td>
                    <td className="py-1.5 pr-3 font-medium">{r.riderCategoryName}</td>
                    <td className="py-1.5 pr-3">
                      {r.isDefault
                        ? <Badge className="text-[10px] bg-green-100 text-green-800">Sì</Badge>
                        : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground truncate max-w-xs">
                      {r.eligibilityUrl ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* ── PRODOTTI PER TIPOLOGIA ── */}
      {kpi && kpi.productsByType.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="w-4 h-4 text-primary" />
              Prodotti per Tipologia
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {kpi.productsByType.map((row) => (
                <div key={row.fare_type} className="flex items-center justify-between py-1.5 border-b last:border-0 text-sm">
                  <span className="font-medium">{FARE_TYPE_LABELS[row.fare_type] ?? row.fare_type}</span>
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground">{row.cnt} prodotti</span>
                    <span className="font-semibold">
                      €{Number(row.min_price).toFixed(2)}
                      {row.min_price !== row.max_price && ` – €${Number(row.max_price).toFixed(2)}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── PREZZO MEDIO PER RETE ── */}
      {kpi && kpi.avgPriceByNetwork.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Euro className="w-4 h-4 text-primary" />
              Prezzo Medio per Rete
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {kpi.avgPriceByNetwork.map((row) => (
                <div key={row.network_id} className="flex items-center gap-3 text-sm">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: NET_COLORS[row.network_id] ?? "#94a3b8" }} />
                  <div className="w-44 shrink-0 font-medium">{NET_LABELS[row.network_id] ?? row.network_id}</div>
                  <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${Math.min(100, (Number(row.avg_price) / 5) * 100)}%`, backgroundColor: NET_COLORS[row.network_id] ?? "#3b82f6" }} />
                  </div>
                  <div className="w-16 text-right font-bold">€{Number(row.avg_price).toFixed(2)}</div>
                  <div className="w-16 text-right text-muted-foreground text-xs">{row.products} prod.</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── DISTRIBUZIONE FASCE EXTRAURBANO ── */}
      {kpi && kpi.fasciaDistribution.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              Fasce Km Extraurbano — {kpi.fasciaDistribution.length} fasce DGR
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {kpi.fasciaDistribution.map((row) => (
                <div key={row.fare_product_id} className="border rounded-lg px-3 py-2 bg-white">
                  <div className="text-xs font-semibold text-foreground">
                    {row.fare_product_name.replace("Extraurbano ", "").replace("Fascia ", "Fascia ")}
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-sm font-bold text-amber-600">€{Number(row.amount).toFixed(2)}</span>
                    <span className="text-xs text-muted-foreground">{row.od_pairs} O/D</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── CLUSTER TERRITORIALI — visualizzazione schematica SVG ── */}
      {fullClusters.length > 0 && (() => {
        const allStops = fullClusters.flatMap(c =>
          c.stops.filter(s => s.stopLat != null && s.stopLon != null)
            .map(s => ({ lat: s.stopLat!, lon: s.stopLon!, color: c.color ?? "#94a3b8", clusterId: c.clusterId }))
        );
        if (allStops.length === 0) return null;

        const lats = allStops.map(s => s.lat);
        const lons = allStops.map(s => s.lon);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLon = Math.min(...lons), maxLon = Math.max(...lons);
        const latSpan = (maxLat - minLat) || 0.01;
        const lonSpan = (maxLon - minLon) || 0.01;
        const cosLat = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
        const W = 800, PAD = 0.1;
        const H = Math.max(320, Math.round(W * (latSpan / lonSpan) / cosLat));
        const toXY = (lat: number, lon: number) => ({
          x: ((lon - minLon) / lonSpan * (1 - 2 * PAD) + PAD) * W,
          y: (1 - (lat - minLat) / latSpan * (1 - 2 * PAD) - PAD) * H,
        });

        const centroids = fullClusters.map(c => {
          const stops = c.stops.filter(s => s.stopLat != null && s.stopLon != null);
          const lat = c.centroidLat ?? (stops.length ? stops.reduce((a, s) => a + s.stopLat!, 0) / stops.length : (minLat + maxLat) / 2);
          const lon = c.centroidLon ?? (stops.length ? stops.reduce((a, s) => a + s.stopLon!, 0) / stops.length : (minLon + maxLon) / 2);
          return { ...c, lat, lon, ...toXY(lat, lon) };
        });

        // Raggio del cerchio cluster proporzionale al numero di fermate
        const maxStops = Math.max(...fullClusters.map(c => c.stopCount ?? 1));
        const clusterR = (count: number) => Math.max(18, Math.min(42, 18 + (count / maxStops) * 24));

        return (
          <Card className="bg-white">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="w-4 h-4 text-primary" />
                Zone Tariffarie Extraurbane — Cluster Territoriali ({fullClusters.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Schema delle zone tariffarie extraurbane. Ogni cerchio rappresenta un cluster; la dimensione è proporzionale al numero di fermate. Le fermate sono i punti grigi.
              </p>
              <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ display: "block" }}>
                  {/* Fermate come piccoli punti */}
                  {allStops.map((s, i) => {
                    const { x, y } = toXY(s.lat, s.lon);
                    return <circle key={i} cx={x} cy={y} r={2} fill={s.color} fillOpacity="0.35" />;
                  })}
                  {/* Cerchio area cluster (alone) */}
                  {centroids.map(c => {
                    const r = clusterR(c.stopCount ?? 1);
                    return <circle key={`halo-${c.clusterId}`} cx={c.x} cy={c.y} r={r + 6} fill={c.color ?? "#94a3b8"} fillOpacity="0.12" />;
                  })}
                  {/* Cerchio pieno cluster */}
                  {centroids.map(c => {
                    const r = clusterR(c.stopCount ?? 1);
                    const label = c.clusterName.replace(/^Cluster\s*/i, "");
                    return (
                      <g key={c.clusterId}>
                        <circle cx={c.x} cy={c.y} r={r} fill={c.color ?? "#94a3b8"} fillOpacity="0.85" stroke="white" strokeWidth="2.5" />
                        <text x={c.x} y={c.y - 2} fontSize="9" fontWeight="bold" fill="white" textAnchor="middle" dominantBaseline="middle">{label}</text>
                        <text x={c.x} y={c.y + 10} fontSize="8" fill="white" textAnchor="middle" dominantBaseline="middle" fillOpacity="0.9">{c.stopCount} ferm.</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              {/* Legenda */}
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {fullClusters.map((c) => (
                  <div key={c.clusterId} className="flex items-center gap-2 text-xs border rounded-lg px-2.5 py-2 bg-white">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c.color ?? "#94a3b8" }} />
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{c.clusterName}</div>
                      <div className="text-muted-foreground">{c.stopCount} fermate</div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* ── 3 TIPOLOGIE DI ZONIZZAZIONE ── */}
      <Card className="bg-white">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" />
            3 Tipologie di Zonizzazione Extraurbana
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">Il sistema supporta tre approcci per la generazione delle zone tariffarie extraurbane. Ogni metodo risponde a un principio diverso di tariffazione.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Tipo 1: Zone Concentriche */}
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-blue-600 px-3 py-2">
                <p className="text-xs font-bold text-white">① Zone Concentriche</p>
                <p className="text-[10px] text-blue-100">Anelli dal centroide geografico</p>
              </div>
              <div className="p-3 flex flex-col gap-2">
                <svg viewBox="0 0 120 100" className="w-full" style={{ maxHeight: 100 }}>
                  <circle cx="60" cy="50" r="40" fill="none" stroke="#bfdbfe" strokeWidth="12" />
                  <circle cx="60" cy="50" r="25" fill="none" stroke="#93c5fd" strokeWidth="12" />
                  <circle cx="60" cy="50" r="10" fill="#3b82f6" />
                  {/* Etichette zone */}
                  <text x="60" y="19" fontSize="7" fill="#1d4ed8" textAnchor="middle">{"Fascia C (>20km)"}</text>
                  <text x="60" y="36" fontSize="7" fill="#1d4ed8" textAnchor="middle">Fascia B</text>
                  <text x="60" y="53" fontSize="7" fill="white" textAnchor="middle">A</text>
                  {/* Fermate sui cerchi */}
                  {[[60,10],[95,50],[25,50],[60,90]].map(([x,y],i) => (
                    <circle key={i} cx={x} cy={y} r="3" fill="#1e40af" stroke="white" strokeWidth="1"/>
                  ))}
                  {[[80,28],[40,72]].map(([x,y],i) => (
                    <circle key={i} cx={x} cy={y} r="3" fill="#2563eb" stroke="white" strokeWidth="1"/>
                  ))}
                </svg>
                <p className="text-[10px] text-muted-foreground">Le fermate sono assegnate alla fascia in base alla distanza <strong>in linea d'aria</strong> dal centroide della rete.</p>
              </div>
            </div>
            {/* Tipo 2: Cluster K-Means Geografico */}
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-purple-600 px-3 py-2">
                <p className="text-xs font-bold text-white">② Cluster K-Means</p>
                <p className="text-[10px] text-purple-100">Raggruppamento per densità geografica</p>
              </div>
              <div className="p-3 flex flex-col gap-2">
                <svg viewBox="0 0 120 100" className="w-full" style={{ maxHeight: 100 }}>
                  {/* Cluster A - sinistra */}
                  <ellipse cx="35" cy="40" rx="22" ry="18" fill="#ede9fe" stroke="#8b5cf6" strokeWidth="1.5" strokeDasharray="3 2" />
                  {/* Cluster B - destra in basso */}
                  <ellipse cx="85" cy="65" rx="22" ry="18" fill="#fce7f3" stroke="#ec4899" strokeWidth="1.5" strokeDasharray="3 2" />
                  {/* Cluster C - in alto a destra */}
                  <ellipse cx="85" cy="28" rx="16" ry="14" fill="#dbeafe" stroke="#3b82f6" strokeWidth="1.5" strokeDasharray="3 2" />
                  {/* Fermate cluster A */}
                  {[[28,35],[38,45],[30,50],[45,35]].map(([x,y],i) => <circle key={i} cx={x} cy={y} r="3" fill="#7c3aed" stroke="white" strokeWidth="1"/>)}
                  {/* Fermate cluster B */}
                  {[[78,58],[90,70],[80,75],[95,62]].map(([x,y],i) => <circle key={i} cx={x} cy={y} r="3" fill="#be185d" stroke="white" strokeWidth="1"/>)}
                  {/* Fermate cluster C */}
                  {[[80,25],[90,30],[85,35]].map(([x,y],i) => <circle key={i} cx={x} cy={y} r="3" fill="#1d4ed8" stroke="white" strokeWidth="1"/>)}
                  {/* Centroidi */}
                  <circle cx="35" cy="40" r="4" fill="#7c3aed" stroke="white" strokeWidth="1.5"/>
                  <circle cx="85" cy="65" r="4" fill="#be185d" stroke="white" strokeWidth="1.5"/>
                  <circle cx="85" cy="28" r="4" fill="#1d4ed8" stroke="white" strokeWidth="1.5"/>
                  <text x="35" y="20" fontSize="7" fill="#7c3aed" textAnchor="middle">Zona A</text>
                  <text x="85" y="88" fontSize="7" fill="#be185d" textAnchor="middle">Zona B</text>
                  <text x="85" y="12" fontSize="7" fill="#1d4ed8" textAnchor="middle">Zona C</text>
                </svg>
                <p className="text-[10px] text-muted-foreground">L'algoritmo K-Means identifica <strong>gruppi naturali</strong> di fermate per prossimità geografica. Le fermate vicine appartengono alla stessa zona.</p>
              </div>
            </div>
            {/* Tipo 3: Zone Km per Linea (Percorso Dominante) */}
            <div className="border rounded-xl overflow-hidden">
              <div className="bg-green-600 px-3 py-2">
                <p className="text-xs font-bold text-white">③ Zone Km per Linea</p>
                <p className="text-[10px] text-green-100">Distanza progressiva sul percorso</p>
              </div>
              <div className="p-3 flex flex-col gap-2">
                <svg viewBox="0 0 120 100" className="w-full" style={{ maxHeight: 100 }}>
                  {/* Percorso linea */}
                  <path d="M 10 50 Q 35 25 60 50 Q 85 75 110 50" fill="none" stroke="#22c55e" strokeWidth="2.5" />
                  {/* Fasce colorate sotto il tracciato */}
                  <path d="M 10 50 Q 20 37 30 45" fill="none" stroke="#bbf7d0" strokeWidth="8" opacity="0.7"/>
                  <path d="M 30 45 Q 45 33 60 50" fill="none" stroke="#86efac" strokeWidth="8" opacity="0.7"/>
                  <path d="M 60 50 Q 75 62 90 60" fill="none" stroke="#4ade80" strokeWidth="8" opacity="0.7"/>
                  <path d="M 90 60 Q 100 57 110 50" fill="none" stroke="#16a34a" strokeWidth="8" opacity="0.7"/>
                  {/* Fermate con km */}
                  {[
                    {cx:10, cy:50, km:"0 km", fs:1},
                    {cx:40, cy:40, km:"8 km", fs:2},
                    {cx:70, cy:58, km:"18 km", fs:3},
                    {cx:110, cy:50, km:"28 km", fs:4},
                  ].map((s,i) => (
                    <g key={i}>
                      <circle cx={s.cx} cy={s.cy} r="4" fill="#15803d" stroke="white" strokeWidth="1.5"/>
                      <text x={s.cx} y={s.cy - 8} fontSize="6.5" fill="#166534" textAnchor="middle" fontWeight="bold">{s.km}</text>
                      <text x={s.cx + 8} y={s.cy + 12} fontSize="6" fill="#16a34a" textAnchor="middle">F{s.fs}</text>
                    </g>
                  ))}
                  <text x="60" y="95" fontSize="7" fill="#15803d" textAnchor="middle" fontWeight="bold">Fascia = km progressivi</text>
                </svg>
                <p className="text-[10px] text-muted-foreground">Ogni fermata viene assegnata alla fascia DGR in base alla sua <strong>distanza progressiva in km</strong> dall'origine lungo il tracciato GTFS della linea.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── STRUMENTI DISPONIBILI ── */}
      <Card className="bg-white">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="w-4 h-4 text-primary" />
            Strumenti del Sistema
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { icon: Route, title: "Classificazione Linee", desc: "Associa ogni linea GTFS alla rete tariffaria corretta. Auto-classificazione o correzione manuale.", color: "text-blue-600", bg: "bg-blue-50" },
              { icon: Ticket, title: "Prodotti & Supporti", desc: "Gestione biglietti, abbonamenti, supporti (carta/app/contactless). Seed automatico da tariffe DGR.", color: "text-purple-600", bg: "bg-purple-50" },
              { icon: Users, title: "Categorie Passeggero", desc: "Ordinario, studente, anziano, agevolato ISEE. Con URL eligibilità per sistemi EMV.", color: "text-green-600", bg: "bg-green-50" },
              { icon: MapPin, title: "Zone Extraurbane", desc: "Genera zone tariffarie dai cluster territoriali o dalla distanza km. Matrice O/D completa.", color: "text-orange-600", bg: "bg-orange-50" },
              { icon: Zap, title: "Simulatore Tariffario", desc: "Testa qualsiasi coppia O/D. Mostra fascia, prezzo, percorso sulla mappa, Regola 1 o 2.", color: "text-yellow-600", bg: "bg-yellow-50" },
              { icon: BarChart3, title: "Analisi Tariffaria", desc: "KPI copertura, distribuzione prezzi, registro audit normativo, export ZIP GTFS Fares V2.", color: "text-red-600", bg: "bg-red-50" },
              { icon: Database, title: "Dati & GTFS", desc: "Upload feed GTFS, analisi stops/routes/trips, verifica qualità dati, gestione feed multipli.", color: "text-slate-600", bg: "bg-slate-50" },
              { icon: FileText, title: "Generazione Regole", desc: "Crea automaticamente fare_leg_rules.txt con tutte le coppie O/D della rete extraurbana.", color: "text-teal-600", bg: "bg-teal-50" },
            ].map((tool) => {
              const Icon = tool.icon;
              return (
                <div key={tool.title} className={`rounded-lg border p-3 ${tool.bg}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={`w-4 h-4 ${tool.color}`} />
                    <span className={`font-semibold text-sm ${tool.color}`}>{tool.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{tool.desc}</p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── ABBONAMENTI COMPLETI ── */}
      {abbonamenti.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="w-4 h-4 text-emerald-600" />
              Abbonamenti ({abbonamenti.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left pb-1.5 pr-2 font-medium">Nome</th>
                  <th className="text-left pb-1.5 pr-2 font-medium">Rete</th>
                  <th className="text-left pb-1.5 pr-2 font-medium">Tipologia</th>
                  <th className="text-left pb-1.5 pr-2 font-medium">Passeggero</th>
                  <th className="text-right pb-1.5 font-medium">Prezzo</th>
                </tr>
              </thead>
              <tbody>
                {abbonamenti.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-1 pr-2 font-medium">{p.fareProductName}</td>
                    <td className="py-1 pr-2 text-muted-foreground">{NET_LABELS[p.networkId ?? ""] ?? p.networkId ?? "—"}</td>
                    <td className="py-1 pr-2">{FARE_TYPE_LABELS[p.fareType] ?? p.fareType}</td>
                    <td className="py-1 pr-2 capitalize text-muted-foreground">{p.riderCategoryId ?? "—"}</td>
                    <td className="py-1 text-right font-bold text-emerald-700">€{p.amount.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* ── BIGLIETTI ── */}
      {biglietti.length > 0 && (
        <Card className="bg-white">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="w-4 h-4 text-primary" />
              Biglietti & Titoli di Viaggio ({biglietti.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left pb-1.5 pr-2 font-medium">Nome</th>
                  <th className="text-left pb-1.5 pr-2 font-medium">Rete</th>
                  <th className="text-left pb-1.5 pr-2 font-medium">Tipologia</th>
                  <th className="text-left pb-1.5 pr-2 font-medium">Passeggero</th>
                  <th className="text-right pb-1.5 font-medium">Prezzo</th>
                </tr>
              </thead>
              <tbody>
                {biglietti.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="py-1 pr-2 font-medium">{p.fareProductName}</td>
                    <td className="py-1 pr-2 text-muted-foreground">{NET_LABELS[p.networkId ?? ""] ?? p.networkId ?? "—"}</td>
                    <td className="py-1 pr-2">{FARE_TYPE_LABELS[p.fareType] ?? p.fareType}</td>
                    <td className="py-1 pr-2 capitalize text-muted-foreground">{p.riderCategoryId ?? "—"}</td>
                    <td className="py-1 text-right font-bold">€{p.amount.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
