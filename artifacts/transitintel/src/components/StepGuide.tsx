/* ═══════════════════════════════════════════════════════════════
 *  StepGuide — guida contestuale per gli ottimizzatori (VSP/CSP/VCSP)
 *  - <HelpTip testo="..."/>: pallino "?" accanto a un comando, spiega
 *    cosa succede se lo usi (tooltip nativo, zero dipendenze).
 *  - <AlgoGuide/>: pannello collassabile "Come funziona l'algoritmo"
 *    con gli step numerati del processo.
 * ═══════════════════════════════════════════════════════════════ */
import React, { useState } from "react";
import { HelpCircle, BookOpen } from "lucide-react";

export function HelpTip({ testo, className = "" }: { testo: string; className?: string }) {
  return (
    <span title={testo} className={`inline-flex items-center cursor-help align-middle ${className}`}>
      <HelpCircle className="w-3 h-3 text-muted-foreground/60 hover:text-orange-300 transition-colors" />
    </span>
  );
}

export interface AlgoStep {
  t: string;   // titolo breve dello step
  d: string;   // descrizione: cosa fa l'algoritmo in questo step
}

export function AlgoGuide({ titolo, sottotitolo, steps, accent = "orange", defaultOpen = false }: {
  titolo: string;
  sottotitolo?: string;
  steps: AlgoStep[];
  accent?: "orange" | "cyan" | "purple";
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ac = {
    orange: { text: "text-orange-300", border: "border-orange-500/25", bg: "bg-orange-500/5", dot: "bg-orange-500/20 text-orange-300" },
    cyan: { text: "text-cyan-300", border: "border-cyan-500/25", bg: "bg-cyan-500/5", dot: "bg-cyan-500/20 text-cyan-300" },
    purple: { text: "text-purple-300", border: "border-purple-500/25", bg: "bg-purple-500/5", dot: "bg-purple-500/20 text-purple-300" },
  }[accent];
  return (
    <div className={`rounded-xl border ${ac.border} ${ac.bg}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2">
        <BookOpen className={`w-3.5 h-3.5 ${ac.text}`} />
        <span className={`text-[11px] font-semibold ${ac.text}`}>{titolo}</span>
        {sottotitolo && <span className="text-[10px] text-muted-foreground hidden sm:inline">— {sottotitolo}</span>}
        <span className="ml-auto text-[10px] text-muted-foreground">{open ? "▲ chiudi" : "▼ apri la guida"}</span>
      </button>
      {open && (
        <ol className="px-3 pb-3 space-y-1.5">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-2">
              <span className={`shrink-0 w-4 h-4 rounded-full ${ac.dot} text-[9px] font-bold flex items-center justify-center mt-0.5`}>{i + 1}</span>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                <b className="text-foreground/90">{s.t}.</b> {s.d}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ── Guide precompilate per i tre ottimizzatori ── */

export const VSP_GUIDE: AlgoStep[] = [
  { t: "Costruzione del grafo", d: "Ogni corsa è un nodo; un arco collega due corse se lo stesso mezzo può fare entrambe (tempi compatibili, capolinea raggiungibile, km a vuoto sotto soglia — calcolati su strada con OSRM). Qui agiscono i filtri della Normativa: vieta cambi linea e vieta vuoti interni eliminano gli archi proibiti." },
  { t: "Warm-start greedy", d: "Una soluzione veloce di partenza: le corse vengono concatenate in ordine di orario. Serve come base di confronto e per accelerare il CP-SAT." },
  { t: "Portfolio CP-SAT multi-scenario", d: "Il vero ottimizzatore: risolve il modello matematico più volte con strategie diverse (bilanciato, meno veicoli, minimo vuoto, monolinea…) e tiene il migliore. L'Intensità decide quanti scenari e quanto tempo per ciascuno." },
  { t: "Local search", d: "La soluzione migliore viene rifinita spostando corse tra veicoli, fondendo e spezzando catene, finché il costo non scende più." },
  { t: "Eliminazione veicoli", d: "Prova a svuotare un veicolo alla volta ridistribuendo le sue corse: ogni veicolo eliminato è un mezzo (e un costo fisso) in meno." },
  { t: "Garanzie normativa e flotta", d: "I blocchi che violano i cap (max pezzi, max cambi linea) vengono spezzati nel punto di violazione; la domiciliazione assegna ogni blocco al deposito più conveniente rispettando i limiti di flotta per tipologia." },
];

export const CSP_GUIDE: AlgoStep[] = [
  { t: "Analisi dei blocchi", d: "Ogni turno macchina viene analizzato per trovare i punti di taglio buoni: soste ai capolinea, fermate nei cluster (punti di cambio), anche a metà corsa (cambio intra-corsa). Le fasce senza cambi e le lunghezze minime dei pezzi filtrano i tagli." },
  { t: "Costruzione dei segmenti", d: "I blocchi vengono spezzati nei tagli scelti: ogni segmento è una porzione di lavoro affidabile a un solo conducente." },
  { t: "Accoppiamento CP-SAT", d: "Il modello decide per ogni segmento se diventa un turno da solo (intero/supplemento) o si accoppia con un altro in un turno a due riprese (semiunico/spezzato), rispettando nastro, lavoro e interruzioni della normativa. Qui agiscono i Vincoli globali e i Costi avanzati BDS5." },
  { t: "Multi-scenario", d: "Come per i mezzi: più risoluzioni con strategie e perturbazioni diverse, poi la classifica sceglie la migliore (vedi 'Come ha ragionato l'algoritmo' nel risultato)." },
  { t: "Validazione BDS", d: "Ogni turno viene verificato contro RD 131/1938 e regole aziendali: guida continuativa, soste al capolinea, pasto, stacco, riprese. I badge ✅/❌ nel risultato vengono da qui — e si aggiornano a ogni tua modifica manuale." },
  { t: "Cambi e auto aziendali", d: "Dove un bus passa di mano viene creato il cambio (LASCIA/PRENDE) e, se serve, il viaggio con l'auto aziendale — nel rispetto del numero di auto disponibili." },
];

export const VCSP_GUIDE: AlgoStep[] = [
  { t: "Round 1: mezzi", d: "Parte il VSP completo (vedi guida VSP): produce i turni macchina migliori per costo mezzi." },
  { t: "Round 1: personale", d: "Sui turni macchina appena creati gira subito il CSP completo: turni guida, tipologie, violazioni, costo del personale. NON devi lanciarlo tu: è dentro il giro." },
  { t: "Costi-ombra", d: "Il CSP dice al VSP quali concatenamenti rendono i turni guida cari o illegali (blocchi troppo lunghi, tagli scomodi): quei collegamenti ricevono una penalità." },
  { t: "Round successivi", d: "Il VSP riottimizza i mezzi tenendo conto delle penalità, poi il CSP rigira sul nuovo piano. Il processo si ferma quando non migliora o al numero di round scelto." },
  { t: "Scelta del round migliore", d: "Vince il round con il costo TOTALE (mezzi + personale) più basso — lo vedi nella tabella dei round con la stella." },
  { t: "Salvataggio doppio", d: "Al salvataggio vengono creati ENTRAMBI gli scenari: turni macchina (Workspace Vetture) e turni guida (Workspace Turni Guida, già pronti — il pulsante li apre senza rigenerare)." },
];
