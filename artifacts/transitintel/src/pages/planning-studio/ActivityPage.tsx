/**
 * PlannerStudio — Registro attività del progetto.
 *
 * La risposta alla domanda dell'operatore «cosa è successo al sistema?»:
 * il log ps_project_activity_log esisteva da sempre ma nessuna vista lo
 * mostrava. Qui ogni modifica è una riga con QUANDO, CHI (con badge Argos
 * quando l'ha fatta l'agente col tuo consenso) e COSA, in italiano.
 *
 * Il filtro Argos/Operatore usa `via` (payload.via marcato dal middleware
 * X-Argos lato server): è la distinzione che prima non esisteva — le
 * scritture dell'agente avvengono col token dell'utente e risultavano
 * indistinguibili dalle modifiche manuali.
 */
import { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, History, Loader2, RefreshCw, Bot, User as UserIcon, Search, X,
} from "lucide-react";
import PsProjectNav from "@/components/planning-studio/PsProjectNav";
import {
  getPsProject, listPsActivity, type PsActivity,
} from "@/lib/planning-studio-api";

/* Etichette italiane per i codici azione del registro. Le voci mancanti
 * degradano sul codice grezzo: meglio un codice visibile che una riga muta. */
const ACTION_LABEL: Record<string, string> = {
  "ps.project.create": "Progetto creato",
  "ps.project.duplicate": "Progetto duplicato",
  "ps.project.update": "Impostazioni progetto aggiornate",
  "ps.project.activate": "Messo in esercizio",
  "ps.project.activate.schedule": "Attivazione programmata",
  "ps.project.activate.scheduled": "Attivazione automatica eseguita",
  "ps.project.activate.unschedule": "Attivazione programmata annullata",
  "ps.member.add": "Membro aggiunto",
  "ps.member.remove": "Membro rimosso",
  "ps.stop.create": "Fermata creata",
  "ps.stop.bulk": "Fermate importate in blocco",
  "ps.stop.update": "Fermata modificata",
  "ps.stop.delete": "Fermata eliminata",
  "ps.route.create": "Linea creata",
  "ps.route.update": "Linea modificata",
  "ps.route.delete": "Linea eliminata",
  "ps.variant.create": "Variante di percorso creata",
  "ps.variant.update": "Variante modificata",
  "ps.variant.delete": "Variante eliminata",
  "ps.variant.sequence": "Sequenza fermate aggiornata",
  "ps.shape.save": "Tracciato salvato",
  "ps.calendar.create": "Calendario creato",
  "ps.calendar.update": "Calendario modificato",
  "ps.calendar.delete": "Calendario eliminato",
  "ps.calendar.dates": "Date del calendario aggiornate",
  "ps.trip.create": "Corsa creata",
  "ps.trip.delete": "Corsa eliminata",
  "ps.trip.stop-times": "Orari di corsa aggiornati",
  "ps.nogo_zone.create": "Zona interdetta creata",
  "ps.nogo_zone.delete": "Zona interdetta eliminata",
  "trip.update": "Corsa modificata",
  "trip.shift": "Corse traslate nel tempo",
  "trip.batch_create": "Corse create in blocco",
  "trip.bulk_update": "Corse modificate in blocco",
  "trip.bulk_delete": "Corse eliminate in blocco",
  "trip.generate_headway": "Corse generate a cadenza",
  "trip.merge_twins": "Corse gemelle unificate",
  "trip.split_categories": "Corse suddivise per categoria",
  "trip.prototype_missing": "Corse prototipo generate",
  "trip.exception.add": "Eccezione di corsa aggiunta",
  "trip.exception.remove": "Eccezione di corsa rimossa",
  "trip.blocks_from_scenario": "Blocchi importati dallo scenario",
  "validity.bulk.route-row": "Validità applicata a intere linee",
  "validity.bulk.trip-row": "Validità applicata a corse",
  "validity.bulk.date-column": "Validità applicata a una data",
  "validity.bulk.trip-categories": "Categorie corse aggiornate",
  "validity.bulk.clear-exceptions": "Eccezioni di validità azzerate",
  "validity.bulk.row-restore": "Bollini ripristinati (annullo turno)",
  "validity.auto-import": "Validità importata automaticamente",
  "validity.generate-unit": "Unità di progettazione generata",
  "validity.day_type.create": "Giorno-tipo creato",
  "validity.day_type.update": "Giorno-tipo modificato",
  "validity.day_type.delete": "Giorno-tipo eliminato",
  "service_period.create": "Periodo di servizio creato",
  "service_period.update": "Periodo di servizio modificato",
  "service_period.delete": "Periodo di servizio eliminato",
  "cluster.create": "Nodo creato",
  "cluster.update": "Nodo modificato",
  "cluster.delete": "Nodo eliminato",
  "cluster.set_stops": "Fermate del nodo aggiornate",
};

/* I dettagli utili del payload, senza fare il dump del JSON: nome/short name
 * quando c'è, conteggi quando ci sono. */
function payloadDetail(a: PsActivity): string {
  const p = a.payload || {};
  const bits: string[] = [];
  if (p.name) bits.push(String(p.name));
  if (p.shortName) bits.push(`linea ${p.shortName}`);
  if (typeof p.count === "number") bits.push(`${p.count} elementi`);
  if (typeof p.trips === "number") bits.push(`${p.trips} corse`);
  if (typeof p.inserted === "number") bits.push(`${p.inserted} inserite`);
  if (typeof p.deletedTrips === "number" && p.deletedTrips > 0) bits.push(`${p.deletedTrips} corse eliminate`);
  if (Array.isArray(p.fields) && p.fields.length) bits.push(p.fields.join(", "));
  return bits.join(" · ");
}

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}

export default function PlanningStudioActivityPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";

  const projectQ = useQuery({
    queryKey: ["ps", "project", projectId],
    queryFn: () => getPsProject(projectId),
    enabled: !!projectId,
  });
  const activityQ = useQuery({
    queryKey: ["ps", "activity", projectId],
    queryFn: () => listPsActivity(projectId, 300),
    enabled: !!projectId,
    refetchInterval: 30_000, // il registro è "vivo": si aggiorna mentre Argos lavora
  });

  const [who, setWho] = useState<"all" | "argos" | "operator">("all");
  const [query, setQuery] = useState("");

  const entries = activityQ.data ?? [];
  const argosCount = useMemo(() => entries.filter(e => e.via).length, [entries]);

  const visible = useMemo(() => {
    let list = entries;
    if (who === "argos") list = list.filter(e => e.via);
    else if (who === "operator") list = list.filter(e => !e.via);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(e =>
        (ACTION_LABEL[e.action] ?? e.action).toLowerCase().includes(q)
        || (e.userFullName ?? e.userEmail ?? "").toLowerCase().includes(q)
        || payloadDetail(e).toLowerCase().includes(q));
    }
    return list;
  }, [entries, who, query]);

  /* Raggruppa per giorno mantenendo l'ordine (già DESC dal server). */
  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: PsActivity[] }> = [];
    for (const e of visible) {
      const day = dayKey(e.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [visible]);

  if (!projectId) {
    return <div className="p-8 text-slate-300">Progetto non specificato.</div>;
  }
  const project = projectQ.data;

  return (
    <div className="h-full w-full min-w-0 flex flex-col bg-slate-950 text-slate-100">
      {/* Toolbar */}
      <div className="h-14 border-b border-slate-800 bg-slate-900 px-4 flex items-center gap-3 shrink-0">
        <Link href={`/planning-studio/${projectId}`}>
          <button className="p-2 rounded hover:bg-slate-800 text-slate-300">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-amber-400" />
          <h1 className="font-semibold text-sm">Registro</h1>
        </div>
        {project && (
          <span className="text-xs text-slate-500 ml-2">
            {project.name} · <span className="text-slate-400">{entries.length} voci{argosCount > 0 ? ` · ${argosCount} di Argos` : ""}</span>
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => activityQ.refetch()}
          disabled={activityQ.isFetching}
          className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm flex items-center gap-1.5 disabled:opacity-50"
          title="Aggiorna il registro"
        >
          {activityQ.isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Aggiorna
        </button>
      </div>
      <PsProjectNav projectId={projectId} active="activity" />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {/* Spiegazione una-volta: perché questo registro esiste */}
          <p className="text-xs text-slate-500 mb-4">
            Ogni modifica al progetto — fatta a mano o da Argos con la tua approvazione — lascia una voce qui.
            Le voci con il badge <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 text-[10px] font-semibold"><Bot className="w-3 h-3" /> Argos</span> sono
            state eseguite dall'agente sul tuo account.
          </p>

          {/* Filtri */}
          <div className="flex flex-wrap items-center gap-2 mb-5">
            {([["all", "Tutte"], ["argos", "Solo Argos"], ["operator", "Solo operatore"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setWho(k)}
                className={`px-3 py-1 rounded-full text-xs border transition ${
                  who === k
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/40 font-semibold"
                    : "text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="relative ml-auto min-w-52">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Cerca nel registro…"
                className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-xs focus:outline-none focus:border-amber-500 placeholder:text-slate-600"
              />
              {query && (
                <button onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-500 hover:text-slate-200">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Timeline */}
          {activityQ.isLoading ? (
            <div className="flex items-center justify-center py-24 text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin mr-2" /> Caricamento registro…
            </div>
          ) : activityQ.isError ? (
            <div className="text-center py-16 text-rose-400 text-sm">Errore nel caricamento del registro.</div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16 text-slate-500 text-sm">
              {entries.length === 0
                ? "Nessuna attività registrata su questo progetto."
                : "Nessuna voce corrisponde ai filtri."}
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(g => (
                <div key={g.day}>
                  <h2 className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2 capitalize">{g.day}</h2>
                  <ul className="space-y-1">
                    {g.items.map(e => <ActivityRow key={e.id} e={e} />)}
                  </ul>
                </div>
              ))}
              {entries.length >= 300 && (
                <p className="text-[11px] text-slate-600 text-center pt-2">
                  Mostrate le ultime 300 voci.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActivityRow({ e }: { e: PsActivity }) {
  const isArgos = !!e.via;
  const label = ACTION_LABEL[e.action] ?? e.action;
  const detail = payloadDetail(e);
  const time = new Date(e.at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  const actor = e.userFullName || e.userEmail || "utente";
  return (
    <li className={`flex items-start gap-3 px-3 py-2 rounded-lg border ${
      isArgos ? "border-violet-500/20 bg-violet-500/[0.04]" : "border-slate-800/70 bg-slate-900/40"
    }`}>
      <span className="text-[11px] text-slate-500 tabular-nums pt-0.5 w-10 shrink-0">{time}</span>
      <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center ${
        isArgos ? "bg-violet-500/20 text-violet-300" : "bg-slate-700/60 text-slate-300"
      }`}>
        {isArgos ? <Bot className="w-3 h-3" /> : <UserIcon className="w-3 h-3" />}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200">
          {label}
          {detail && <span className="text-slate-400"> — {detail}</span>}
        </p>
        <p className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
          {isArgos ? (
            <>
              <span className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-violet-500/15 text-violet-300 font-semibold">
                <Bot className="w-2.5 h-2.5" /> Argos{e.via === "argos" ? "" : ` (${String(e.via).split(":")[1] ?? ""})`}
              </span>
              <span>sull'account di {actor}</span>
            </>
          ) : (
            <span>{actor}</span>
          )}
        </p>
      </div>
    </li>
  );
}
