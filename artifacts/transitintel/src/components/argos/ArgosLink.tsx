/**
 * Il bottone di Argos in Planning Studio.
 *
 * Argos non vive più in un pannello laterale: ha la sua pagina (/argos), con le
 * conversazioni da riprendere, gli agenti e le esecuzioni. Il bottone la apre
 * in un'ALTRA scheda del browser, sul progetto aperto, così si lavora con
 * Planning Studio da una parte e Argos dall'altra: quando il Pianificatore
 * scrive, questa scheda si aggiorna da sola (lib/argos-live.ts,
 * ArgosLiveBridge). Stesso aspetto del vecchio bottone flottante.
 */
import { Eye } from "lucide-react";
import { indirizzoArgos } from "@/lib/argos-live";

export default function ArgosLink({ projectId }: { projectId?: string }) {
  return (
    <a
      href={indirizzoArgos(projectId)}
      target="_blank"
      rel="noopener"
      className="group fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-2xl border border-violet-400/50 bg-zinc-950/90 shadow-[0_0_30px_rgba(139,92,246,0.55)] transition-transform hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300"
      aria-label={projectId ? "Apri Argos su questo progetto, in un'altra scheda" : "Apri Argos, in un'altra scheda"}
    >
      <Eye className="h-6 w-6 text-violet-300" aria-hidden />
      <span className="absolute -right-1 -top-1 h-3 w-3 animate-pulse rounded-full bg-violet-300" aria-hidden />
      <span className="pointer-events-none absolute right-full mr-3 whitespace-nowrap rounded-md border border-violet-400/40 bg-zinc-950/95 px-2 py-1 text-xs font-bold text-violet-300 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden>
        Argos · {projectId ? "conversazioni su questo progetto" : "le tue conversazioni"} ↗
      </span>
    </a>
  );
}
