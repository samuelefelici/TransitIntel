/**
 * PERCORRENZE · TEMPI REALI — acquisire nel programma i tempi osservati (SIRI).
 *
 * Ambito: una corsa, le corse del percorso scelto, o le corse di una o più
 * linee (anche tutte) del giorno-tipo. Ogni tratto prende il tempo dell'ora
 * in cui la corsa lo percorre — le ore di punta non sono la morbida — poi
 * della fascia oraria, poi della giornata; dove il tipo di giorno non vede
 * il tratto, dai feriali se lo si chiede (dichiarato); altrimenti resta il
 * programmato. Le partenze non cambiano.
 *
 * L'anteprima mostra, corsa per corsa, l'arrivo attuale e quello nuovo e la
 * sosta che resta al capolinea prima della corsa dopo, col giudizio: prima di
 * scrivere si vede se il cadenzamento regge. Si scrivono solo le corse
 * spuntate, e il server rifà il calcolo (non si fida dei numeri del browser).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Radio, Check } from "lucide-react";
import {
  anteprimaTempiReali, applicaTempiReali,
  type PsAmbitoTempiReali, type PsParametriTempiReali, type PsGiudizioSosta, type PsCorsaTempiReali,
} from "@/lib/planning-studio-api";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";

const GIUDIZIO: Record<PsGiudizioSosta, { label: string; cls: string }> = {
  assorbe: { label: "assorbe", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30" },
  al_limite: { label: "al limite", cls: "text-amber-300 bg-amber-500/10 border-amber-500/30" },
  insufficiente: { label: "insufficiente", cls: "text-red-300 bg-red-500/10 border-red-500/30" },
  rientro: { label: "ultima", cls: "text-slate-400 bg-slate-800 border-slate-700" },
  senza_dati: { label: "senza dati", cls: "text-slate-400 bg-slate-800 border-slate-700" },
};

function Giudizio({ g }: { g: PsGiudizioSosta | undefined }) {
  if (!g) return <span className="text-slate-600">—</span>;
  const s = GIUDIZIO[g];
  return <span className={`px-1.5 py-0.5 rounded border text-[10px] ${s.cls}`}>{s.label}</span>;
}

const minuti = (x: number | null | undefined) => (x == null ? "—" : `${x > 0 ? "+" : ""}${x}′`);
const sosta = (x: number | null | undefined) => (x == null ? "—" : `${x}′`);

function Fonti({ c }: { c: PsCorsaTempiReali }) {
  const f = c.fonti;
  const parti = [
    f.ora && `${f.ora} ora`, f.fascia && `${f.fascia} fascia`, f.giornata && `${f.giornata} giornata`,
    f.feriale && `${f.feriale} feriali`, f.programmato && `${f.programmato} programmati`,
  ].filter(Boolean);
  return (
    <span className="text-slate-400" title="Da dove viene il tempo di ogni tratto: l'ora della corsa, la sua fascia oraria, la giornata, i feriali, o il programmato (nessun dato)">
      {parti.join(" · ") || "—"}
    </span>
  );
}

export default function TempiRealiPanel({
  projectId, routes, routeId, variantId, variantLabel, trips, dayTypes, onApplied,
}: {
  projectId: string;
  routes: Array<{ id: string; shortName: string; longName?: string | null }>;
  routeId: string;
  variantId: string;
  variantLabel: string | null;
  /** le corse del percorso scelto, già in ordine di partenza */
  trips: Array<{ id: string; label: string }>;
  dayTypes: Array<{ id: string; code: string; name: string }>;
  onApplied: () => void;
}) {
  const [ambito, setAmbito] = useState<PsAmbitoTempiReali>(variantId ? "percorso" : "linee");
  const [tripId, setTripId] = useState("");
  const [linee, setLinee] = useState<Set<string>>(() => new Set(routeId ? [routeId] : []));
  const [dayTypeId, setDayTypeId] = useState("");
  const [valore, setValore] = useState<"mediana" | "p85">("mediana");
  const [ripiego, setRipiego] = useState(true);
  const [richiesta, setRichiesta] = useState<PsParametriTempiReali | null>(null);
  const [esclusi, setEsclusi] = useState<Set<string>>(new Set());
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);

  // giorno-tipo di partenza: il festivo se c'è (il caso che ha fatto nascere
  // lo strumento), altrimenti il primo
  useEffect(() => {
    if (dayTypeId || dayTypes.length === 0) return;
    setDayTypeId((dayTypes.find(d => d.code === "festivo") ?? dayTypes[0]).id);
  }, [dayTypes, dayTypeId]);
  // cambiano linea o percorso in alto: l'anteprima di prima non vale più
  useEffect(() => { setRichiesta(null); setTripId(""); if (variantId) setAmbito(a => (a === "linee" ? a : "percorso")); }, [variantId]);
  useEffect(() => { if (routeId) setLinee(prev => (prev.size === 0 ? new Set([routeId]) : prev)); }, [routeId]);

  const parametri: PsParametriTempiReali | null = useMemo(() => {
    if (!dayTypeId) return null;
    const base = { dayTypeId, valore, ripiego };
    if (ambito === "corsa") return tripId ? { ...base, ambito, tripIds: [tripId] } : null;
    if (ambito === "percorso") return variantId ? { ...base, ambito, variantId } : null;
    return { ...base, ambito, routeIds: [...linee] };
  }, [ambito, tripId, variantId, linee, dayTypeId, valore, ripiego]);

  const q = useQuery({
    queryKey: ["ps", projectId, "tempi-reali", richiesta],
    queryFn: () => anteprimaTempiReali(projectId, richiesta!),
    enabled: !!richiesta,
    staleTime: 0,
  });
  // nuova anteprima: spuntate le corse che cambiano
  useEffect(() => { setEsclusi(new Set()); }, [q.data]);

  const corse = q.data?.corse ?? [];
  const selezionabili = corse.filter(c => c.cambia && !c.saltata);
  const scelte = selezionabili.filter(c => !esclusi.has(c.tripId));

  const applica = () => {
    if (!richiesta || scelte.length === 0) return;
    const ids = scelte.map(c => c.tripId);
    setConfirmReq({
      title: `Scrivere i tempi reali su ${ids.length} corse?`,
      variant: "primary",
      confirmLabel: `Scrivi ${ids.length} corse`,
      message: (
        <div className="space-y-1.5 text-sm">
          <p>Le partenze dai capolinea non cambiano: cambiano i passaggi alle fermate dopo.</p>
          <p className="text-slate-400 text-xs">
            Il server rifà lo stesso calcolo dell'anteprima e scrive solo le fermate il cui orario cambia.
            La modifica resta nel registro del progetto col prima e il dopo.
          </p>
        </div>
      ),
      onConfirm: async () => {
        try {
          const r = await applicaTempiReali(projectId, richiesta, ids);
          toast.success(`✅ Tempi reali scritti su ${r.corse} corse`, {
            description: `${r.fermate} orari alle fermate${r.senzaModifiche ? ` · ${r.senzaModifiche} già allineate` : ""}${r.saltate ? ` · ${r.saltate} saltate` : ""}`,
            duration: 6000,
          });
          onApplied();
          await q.refetch();
        } catch (e: any) {
          toast.error("Tempi reali non scritti", { description: e?.message });
          throw e;
        }
      },
    });
  };

  const oss = q.data?.osservazione;
  return (
    <div className="rounded-lg border border-sky-500/30 bg-slate-900/60 p-4 space-y-3 text-sm">
      <h3 className="text-sm font-semibold text-sky-300 flex items-center gap-2">
        <Radio className="w-4 h-4" /> Tempi reali nel programma
      </h3>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        Le partenze non si toccano. Ogni tratto prende il tempo osservato <strong className="text-slate-200">all'ora in cui la corsa lo percorre</strong> (le
        ore di punta non sono la morbida), poi quello della fascia oraria, poi della giornata; dove il giorno scelto non vede il tratto, dai feriali se
        lo chiedi; altrimenti resta il programmato. La sosta oltre il minuto alle fermate di regolazione è già tolta dai tempi osservati.
      </p>

      {/* Ambito */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[11px] uppercase tracking-wider text-slate-500">Ambito</span>
        <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
          {([["corsa", "Una corsa"], ["percorso", "Il percorso"], ["linee", "Linee"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => { setAmbito(k); setRichiesta(null); }}
              disabled={k !== "linee" && !variantId}
              title={k !== "linee" && !variantId ? "Scegli prima linea e percorso in alto" : undefined}
              className={`px-3 py-1.5 transition-colors disabled:opacity-40 ${ambito === k ? "bg-sky-600 text-white font-semibold" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
              {l}
            </button>
          ))}
        </div>
        {ambito === "corsa" && (
          <select value={tripId} onChange={e => { setTripId(e.target.value); setRichiesta(null); }}
            className="px-2 py-1.5 rounded bg-slate-900 border border-slate-700 min-w-[260px]">
            <option value="">— scegli la corsa —</option>
            {trips.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
        {ambito === "percorso" && (
          <span className="text-slate-300">{variantLabel ?? "il percorso scelto in alto"} · tutte le sue corse del giorno-tipo</span>
        )}
      </div>
      {ambito === "linee" && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <button onClick={() => { setLinee(new Set()); setRichiesta(null); }}
            className={`px-2 py-1 rounded border ${linee.size === 0 ? "bg-sky-600/30 border-sky-500 text-sky-100" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
            Tutte le linee
          </button>
          {routes.map(r => {
            const on = linee.has(r.id);
            return (
              <button key={r.id} title={r.longName ?? undefined}
                onClick={() => { setLinee(prev => { const n = new Set(prev); on ? n.delete(r.id) : n.add(r.id); return n; }); setRichiesta(null); }}
                className={`px-2 py-1 rounded border font-mono ${on ? "bg-sky-600/30 border-sky-500 text-sky-100" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
                {r.shortName}
              </button>
            );
          })}
        </div>
      )}

      {/* Giorno, valore, ripiego */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Giorno-tipo</span>
          <select value={dayTypeId} onChange={e => { setDayTypeId(e.target.value); setRichiesta(null); }}
            className="px-2 py-1.5 rounded bg-slate-900 border border-slate-700">
            {dayTypes.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden"
             title="Mediana: l'orario descrive la giornata tipica, la sosta al capolinea assorbe le peggiori. 85°: l'orario regge anche le giornate peggiori, ma i bus arrivano spesso in anticipo.">
          {([["mediana", "Mediana"], ["p85", "85° percentile"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => { setValore(k); setRichiesta(null); }}
              className={`px-2.5 py-1.5 ${valore === k ? "bg-sky-600 text-white font-semibold" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
              {l}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-slate-300">
          <input type="checkbox" checked={ripiego} onChange={e => { setRipiego(e.target.checked); setRichiesta(null); }} className="accent-sky-500" />
          dove il giorno-tipo non ha dati, usa i feriali
        </label>
        <button onClick={() => parametri && setRichiesta({ ...parametri })} disabled={!parametri || q.isFetching}
          className="text-xs px-3 py-1.5 rounded bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 inline-flex items-center gap-1.5">
          {q.isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
          Calcola l'anteprima
        </button>
      </div>

      {q.isError && (
        <p className="text-[12px] text-amber-300">Anteprima non riuscita: {String((q.error as any)?.message ?? q.error)}</p>
      )}

      {q.data && (
        <>
          <div className="text-[11px] text-slate-400 flex flex-wrap gap-x-3 gap-y-1">
            <span>{q.data.giornoTipo.nome}: {oss?.giorniDelTipo} giornate osservate {oss?.dal && oss?.al ? `dal ${oss.dal} al ${oss.al}` : ""}</span>
            <span>· {oss?.transiti.toLocaleString("it-IT")} passaggi {oss?.fonte}</span>
            {!!oss?.coppieDaFeriale && <span className="text-amber-300">· {oss.coppieDaFeriale} tratti presi dai feriali</span>}
            {q.data.notaValidita && <span className="text-amber-300">· {q.data.notaValidita}</span>}
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700">{q.data.riepilogo.corse} corse · {q.data.riepilogo.cambiano} cambiano</span>
            {(["assorbe", "al_limite", "insufficiente"] as const).map(g => (
              <span key={g} className={`px-2 py-1 rounded border ${GIUDIZIO[g].cls}`}>
                {GIUDIZIO[g].label}: {q.data!.riepilogo.prima[g] ?? 0} → {q.data!.riepilogo.dopo[g] ?? 0}
              </span>
            ))}
          </div>

          <div className="overflow-auto max-h-[52vh] rounded border border-slate-800">
            <table className="text-[11px] border-collapse w-full">
              <thead className="sticky top-0 bg-slate-900 z-10">
                <tr className="text-slate-400">
                  <th className="px-2 py-1.5 border-b border-slate-800 text-center">
                    <input type="checkbox" className="accent-sky-500"
                      checked={selezionabili.length > 0 && scelte.length === selezionabili.length}
                      onChange={() => setEsclusi(scelte.length === selezionabili.length ? new Set(selezionabili.map(c => c.tripId)) : new Set())} />
                  </th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-left">Linea</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-left">Percorso</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-right">Partenza</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-right">Arrivo attuale → nuovo</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-right">Δ</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-left">Tratti dal reale</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-right" title="La sosta al capolinea prima della corsa dopo della linea che parte da lì">Sosta al capolinea</th>
                  <th className="px-2 py-1.5 border-b border-slate-800 text-left">Giudizio</th>
                </tr>
              </thead>
              <tbody>
                {corse.map(c => {
                  const scelta = c.cambia && !c.saltata && !esclusi.has(c.tripId);
                  return (
                    <tr key={c.tripId} className={`border-b border-slate-800/60 ${!c.cambia || c.saltata ? "opacity-50" : ""}`}>
                      <td className="px-2 py-1 text-center">
                        {c.cambia && !c.saltata ? (
                          <input type="checkbox" checked={scelta} className="accent-sky-500"
                            onChange={() => setEsclusi(prev => { const n = new Set(prev); n.has(c.tripId) ? n.delete(c.tripId) : n.add(c.tripId); return n; })} />
                        ) : c.saltata ? <span title={c.saltata} className="text-amber-400">!</span> : <Check className="w-3 h-3 inline text-slate-500" />}
                      </td>
                      <td className="px-2 py-1 font-mono text-slate-200">{c.linea ?? "—"}</td>
                      <td className="px-2 py-1 text-slate-300">{c.percorso ?? "—"}</td>
                      <td className="px-2 py-1 text-right font-mono">{c.partenza ?? "—"}</td>
                      <td className="px-2 py-1 text-right font-mono">
                        <span className="text-slate-400">{c.arrivoAttuale ?? "—"}</span> → <span className="text-slate-100">{c.arrivoNuovo ?? "—"}</span>
                      </td>
                      <td className={`px-2 py-1 text-right font-mono ${(c.variazioneMin ?? 0) > 0 ? "text-amber-300" : (c.variazioneMin ?? 0) < 0 ? "text-emerald-300" : "text-slate-500"}`}>
                        {c.saltata ? <span title={c.saltata}>saltata</span> : minuti(c.variazioneMin)}
                      </td>
                      <td className="px-2 py-1"><Fonti c={c} /></td>
                      <td className="px-2 py-1 text-right font-mono" title={c.dopo?.prossimaPartenza ? `fino alla corsa delle ${c.dopo.prossimaPartenza}` : undefined}>
                        {sosta(c.prima?.sostaMin)} → {sosta(c.dopo?.sostaMin)}
                      </td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        <Giudizio g={c.prima?.giudizio} /> <span className="text-slate-600">→</span> <Giudizio g={c.dopo?.giudizio} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400">
              {scelte.length} corse da scrivere · le altre restano come sono
            </span>
            <button onClick={applica} disabled={scelte.length === 0}
              className="text-xs px-3 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40 inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Scrivi i tempi di {scelte.length} corse
            </button>
          </div>
        </>
      )}
      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
    </div>
  );
}
