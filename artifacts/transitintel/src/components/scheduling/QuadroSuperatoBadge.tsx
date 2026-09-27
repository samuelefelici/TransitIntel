/**
 * QuadroSuperatoBadge — «questi turni sono stati calcolati prima dell'ultima
 * modifica al quadro orario».
 *
 * Il ciclo pianificazione → turni si chiudeva male: in Planning si sposta una
 * corsa, se ne cancella una, si ritocca un orario, e lo scenario salvato in
 * Fucina resta lì come se niente fosse. Il server ora lo sa (registro
 * attività di Planning, ogni scrittura); questa pastiglia lo dice dove si
 * sceglie lo scenario, con che cosa è cambiato e quando, e il titolo indica
 * il rimedio. Niente se il piano è allineato.
 */
import type { QuadroStato } from "@/lib/scheduling-projects-api";

const quando = (iso: string | null) => iso
  ? new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
  : "";

export default function QuadroSuperatoBadge({ quadro, compact }: {
  quadro?: QuadroStato | null;
  /** solo «quadro cambiato», per le card strette del cruscotto */
  compact?: boolean;
}) {
  if (!quadro?.superato) return null;
  const n = quadro.modificheDopo;
  const conteggio = n > 0 ? ` · ${n} modific${n === 1 ? "a" : "he"}` : "";
  const ultima = quadro.ultimaModificaIl ? ` (ultima ${quando(quadro.ultimaModificaIl)})` : "";
  const title =
    `Il quadro orario è cambiato dopo il calcolo di questi turni${ultima}: ${quadro.riassunto || "modifiche al quadro"}. ` +
    "Ricalcolali per riallinearli: i turni bloccati col lucchetto restano com'è.";
  return (
    <span
      className="font-mono inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-300 border border-orange-500/30 shrink-0"
      title={title}
    >
      ⚠ {compact ? "quadro cambiato" : `quadro cambiato dopo il calcolo${conteggio}`}
    </span>
  );
}
