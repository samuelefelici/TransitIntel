import { AlertTriangle } from "lucide-react";

/** Avviso "soft freeze": il progetto Planner Studio è IN ESERCIZIO.
 *  Le modifiche qui NON si riflettono sul feed operativo finché non si
 *  ri-attiva — e la ri-attivazione sostituisce lo snapshot in produzione
 *  (l'attuale viene archiviato). Per i cambi strutturali il flusso corretto
 *  è: Duplica → modifica la copia → Metti in esercizio con decorrenza. */
export default function OperationalEditWarning({ isOperational, projectName }: {
  isOperational?: boolean;
  projectName?: string | null;
}) {
  if (!isOperational) return null;
  return (
    <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="min-w-0 text-xs leading-relaxed">
        <p className="font-bold text-amber-200">
          {projectName ? `«${projectName}» è ` : "Questo progetto è "}IN ESERCIZIO: stai modificando il programma operativo
        </p>
        <p className="text-amber-300/80 mt-0.5">
          Le modifiche non si riflettono sul feed in produzione finché non rimetti in esercizio il progetto
          — e la nuova attivazione sostituirà lo snapshot attuale. Per cambi strutturali usa
          {" "}<b>Duplica</b> e metti in esercizio la copia con una <b>data di decorrenza</b>; le correzioni
          piccole falle qui con le date di validità sulla corsa.
        </p>
      </div>
    </div>
  );
}
