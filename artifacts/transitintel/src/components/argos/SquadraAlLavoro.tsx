/**
 * La squadra al lavoro: quando Argos (il regista) fa lavorare insieme più
 * agenti, sopra la risposta si vede chi lavora, chi ha finito, quanti
 * strumenti ha usato e quanto ci ha messo. Arriva in diretta dagli eventi
 * {"squadra": …} del turno e resta nei metadati del messaggio (storia).
 */
import { AlertTriangle, Check, Clock, Loader2, Users } from "lucide-react";
import { type MembroSquadra } from "@/lib/argos-squadra";

const ETICHETTA: Record<MembroSquadra["stato"], string> = {
  al_lavoro: "al lavoro",
  fatto: "fatto",
  errore: "non riuscito",
  tempo_scaduto: "tempo scaduto",
};

function Icona({ m }: { m: MembroSquadra }) {
  if (m.stato === "al_lavoro") return <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />;
  if (m.stato === "fatto") return <Check className="h-3 w-3 shrink-0 text-emerald-300" aria-hidden />;
  if (m.stato === "tempo_scaduto") return <Clock className="h-3 w-3 shrink-0 text-amber-300" aria-hidden />;
  return <AlertTriangle className="h-3 w-3 shrink-0 text-rose-300" aria-hidden />;
}

function dettaglio(m: MembroSquadra): string {
  const parti = [ETICHETTA[m.stato]];
  if (m.strumenti) parti.push(`${m.strumenti} ${m.strumenti === 1 ? "strumento" : "strumenti"}`);
  if (m.ms != null && m.stato !== "al_lavoro") parti.push(`${Math.max(1, Math.round(m.ms / 1000))} s`);
  return parti.join(" · ");
}

export function SquadraAlLavoro({ squadra }: { squadra: MembroSquadra[] }) {
  if (!squadra.length) return null;
  const inCorso = squadra.filter(m => m.stato === "al_lavoro").length;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1" role="status"
      aria-label={inCorso ? `La squadra di Argos: ${inCorso} al lavoro` : "La squadra di Argos ha finito"}>
      <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide text-violet-300/80">
        <Users className="h-3 w-3" aria-hidden />Squadra
      </span>
      {squadra.map(m => (
        <span key={m.id}
          title={[`${m.nome}: ${dettaglio(m)}`, m.ultimo ? `ultimo strumento: ${m.ultimo}` : "", m.errore ?? "",
                  m.run_id ? `esecuzione #${m.run_id} nell'Ispettore` : ""].filter(Boolean).join("\n")}
          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
            m.stato === "al_lavoro" ? "border-violet-400/50 bg-violet-500/15 text-violet-100"
              : m.stato === "fatto" ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
                : "border-amber-400/30 bg-amber-500/10 text-amber-100"}`}>
          <Icona m={m} />
          <span className="font-medium">{m.nome}</span>
          <span className="text-zinc-400">{dettaglio(m)}</span>
        </span>
      ))}
    </div>
  );
}
