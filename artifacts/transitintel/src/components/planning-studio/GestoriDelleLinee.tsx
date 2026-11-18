/**
 * I gestori delle linee di un programma (tappa 6.11), nella pagina della rete
 * di Planning Studio: ogni linea è di un gestore, che nei GTFS è la sua
 * agenzia. Il riquadro elenca le linee col gestore che vale e ne assegna uno
 * a molte insieme; nel dettaglio di una linea si cambia il suo.
 * L'elenco dei gestori lo tiene l'amministratore (Amministrazione › Azienda).
 * API: /api/planning-studio/projects/:id/gestori. I conti in lib/gestori.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Loader2, Search, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import {
  conteggi, esitoAssegnazione, lineeFiltrate, nomeDelGestore, type FiltroGestore, type GestoriDelProgramma,
} from "@/lib/gestori";

const chiave = (projectId: string) => ["ps", projectId, "gestori"] as const;

/** Le linee del programma coi loro gestori: una lettura sola, condivisa fra il riquadro e il dettaglio della linea. */
export function useGestoriDelProgramma(projectId: string) {
  return useQuery({
    queryKey: chiave(projectId),
    queryFn: () => apiFetch<GestoriDelProgramma>(`/api/planning-studio/projects/${projectId}/gestori`),
    enabled: !!projectId,
  });
}

/** Assegna un gestore (o nessuno) a un insieme di linee, e dice com'è andata. */
function useAssegna(projectId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const assegna = async (gestore: string | null, linee: string[], nome: string | null): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await apiFetch<{ cambiate: number }>(`/api/planning-studio/projects/${projectId}/gestori`, {
        method: "PUT", body: JSON.stringify({ gestore, linee }),
      });
      await queryClient.invalidateQueries({ queryKey: chiave(projectId) });
      toast.success(esitoAssegnazione(r.cambiate, linee.length, nome));
      return true;
    } catch (e: any) {
      toast.error("Gestore non assegnato", { description: e?.message });
      return false;
    } finally { setBusy(false); }
  };
  return { assegna, busy };
}

const TENDINA = "h-8 rounded border border-slate-700 bg-slate-900 px-2 text-xs text-slate-100 disabled:opacity-50";

/** Nel dettaglio di una linea: il suo gestore, e la tendina per cambiarlo. Niente se non ci sono gestori. */
export function GestoreDellaLinea({ projectId, routeId }: { projectId: string; routeId: string }) {
  const q = useGestoriDelProgramma(projectId);
  const { assegna, busy } = useAssegna(projectId);
  const d = q.data;
  const linea = d?.linee.find((l) => l.id === routeId);
  if (!d || !linea || d.gestori.length === 0) return null;
  const nome = (id: string | null) => d.gestori.find((g) => g.gestore === id)?.nome ?? null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-slate-300">{nomeDelGestore(linea, d.gestori)}</div>
      {d.puoScrivere && (
        <div className="flex items-center gap-2">
          <label htmlFor={`gestore-linea-${routeId}`} className="sr-only">Gestore della linea {linea.shortName}</label>
          <select id={`gestore-linea-${routeId}`} className={TENDINA} disabled={busy} value={linea.assegnato ? linea.gestore ?? "" : ""}
            onChange={(e) => { const v = e.target.value || null; void assegna(v, [routeId], nome(v)); }}>
            <option value="">Nessuno suo (vale il predefinito)</option>
            {d.gestori.map((g) => <option key={g.gestore} value={g.gestore}>{g.nome}</option>)}
          </select>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" aria-hidden />}
        </div>
      )}
    </div>
  );
}

/** Il riquadro: tutte le linee del programma col loro gestore, e l'assegnazione a molte insieme. */
export default function GestoriDelleLinee({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const q = useGestoriDelProgramma(projectId);
  const { assegna, busy } = useAssegna(projectId);
  const [filtro, setFiltro] = useState<FiltroGestore>("tutte");
  const [cerca, setCerca] = useState("");
  const [scelte, setScelte] = useState<Set<string>>(new Set());
  const [verso, setVerso] = useState<string>("");
  const riquadro = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const suTasto = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", suTasto);
    riquadro.current?.focus();
    return () => window.removeEventListener("keydown", suTasto);
  }, [onClose]);

  const d = q.data;
  const visibili = useMemo(() => (d ? lineeFiltrate(d.linee, filtro, cerca) : []), [d, filtro, cerca]);
  const quante = useMemo(() => (d ? conteggi(d) : { perGestore: {}, senza: 0 }), [d]);
  const tutteScelte = visibili.length > 0 && visibili.every((l) => scelte.has(l.id));
  const scelteVisibili = visibili.filter((l) => scelte.has(l.id)).map((l) => l.id);

  const cambia = (id: string) => setScelte((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tutte = () => setScelte((s) => {
    const n = new Set(s);
    for (const l of visibili) { if (tutteScelte) n.delete(l.id); else n.add(l.id); }
    return n;
  });
  const linguetta = (f: FiltroGestore, testo: string, n: number) => {
    const attiva = JSON.stringify(f) === JSON.stringify(filtro);
    return (
      <button type="button" key={testo} onClick={() => setFiltro(f)} aria-pressed={attiva}
        className={`rounded-full border px-2.5 py-1 text-xs ${attiva ? "border-violet-400 bg-violet-500/20 text-violet-100" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}>
        {testo} <span className="tabular-nums text-slate-400">{n}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={riquadro} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="gestori-linee-titolo"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg border border-slate-700 bg-slate-950 text-slate-100 shadow-xl outline-none">
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <Building2 className="w-4 h-4 text-violet-400" aria-hidden />
          <h2 id="gestori-linee-titolo" className="text-sm font-semibold">Gestori delle linee</h2>
          <button type="button" onClick={onClose} aria-label="Chiudi" className="ml-auto rounded p-1.5 text-slate-300 hover:bg-slate-800"><XIcon className="w-4 h-4" /></button>
        </div>

        {q.isLoading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" aria-hidden />Carico le linee…</div>
        ) : q.isError || !d ? (
          <div className="p-6 text-sm text-rose-300">Le linee non si sono lette. Chiudi e riprova.</div>
        ) : d.gestori.length === 0 ? (
          <div className="space-y-2 p-6 text-sm text-slate-300">
            <p>Non ci sono gestori: nei GTFS tutte le linee sono dell'azienda.</p>
            <p className="text-slate-400">Se il programma è di più aziende, l'amministratore le aggiunge in Amministrazione › Azienda, scheda «Gestori». Poi qui si assegnano le linee.</p>
          </div>
        ) : (
          <>
            <div className="space-y-2 border-b border-slate-800 px-4 py-3">
              <p className="text-xs text-slate-400">
                Nei GTFS ogni linea porta il suo gestore come agenzia. Una linea senza un gestore suo è del predefinito
                ({d.gestori.find((g) => g.predefinito)?.nome ?? d.gestori[0]!.nome}).
              </p>
              <div className="flex flex-wrap gap-1.5">
                {linguetta("tutte", "Tutte", d.linee.length)}
                {d.gestori.map((g) => linguetta({ gestore: g.gestore }, g.nome, quante.perGestore[g.gestore] ?? 0))}
                {linguetta("senza", "Senza un gestore loro", quante.senza)}
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2 w-3.5 h-3.5 text-slate-500" aria-hidden />
                <label htmlFor="gestori-linee-cerca" className="sr-only">Cerca una linea</label>
                <input id="gestori-linee-cerca" value={cerca} onChange={(e) => setCerca(e.target.value)} placeholder="Cerca per codice o nome"
                  className="h-8 w-full rounded border border-slate-700 bg-slate-900 pl-7 pr-2 text-xs text-slate-100 placeholder:text-slate-500" />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {visibili.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">Nessuna linea con questo filtro.</div>
              ) : (
                <table className="w-full table-fixed text-xs">
                  <thead className="sticky top-0 bg-slate-900 text-left text-slate-400">
                    <tr>
                      <th className="w-9 px-3 py-2">
                        <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={tutteScelte} onChange={tutte} disabled={!d.puoScrivere}
                          aria-label={tutteScelte ? "Togli la scelta a tutte le linee in elenco" : "Scegli tutte le linee in elenco"} />
                      </th>
                      <th className="w-16 px-2 py-2">Linea</th><th className="px-2 py-2">Nome</th><th className="w-56 px-2 py-2">Gestore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibili.map((l) => (
                      <tr key={l.id} className={`border-t border-slate-800 ${scelte.has(l.id) ? "bg-violet-500/10" : ""}`}>
                        <td className="px-3 py-1.5">
                          <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={scelte.has(l.id)} onChange={() => cambia(l.id)} disabled={!d.puoScrivere}
                            aria-label={`Scegli la linea ${l.shortName}`} />
                        </td>
                        <td className="px-2 py-1.5 font-semibold">{l.shortName}</td>
                        <td className="truncate px-2 py-1.5 text-slate-300" title={l.longName ?? undefined}>{l.longName ?? "—"}</td>
                        <td className={`px-2 py-1.5 ${l.assegnato ? "text-slate-200" : "text-amber-300"}`}>{nomeDelGestore(l, d.gestori)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 px-4 py-3">
              {!d.puoScrivere ? (
                <p className="text-xs text-slate-400">Puoi leggere questo programma, non cambiarlo.</p>
              ) : (
                <>
                  <span className="text-xs text-slate-300" role="status">
                    {scelteVisibili.length === 0 ? "Scegli le linee da assegnare." : scelteVisibili.length === 1 ? "Una linea scelta." : `${scelteVisibili.length} linee scelte.`}
                  </span>
                  <label htmlFor="gestori-linee-verso" className="ml-auto text-xs text-slate-400">Assegna a</label>
                  <select id="gestori-linee-verso" className={TENDINA} value={verso} onChange={(e) => setVerso(e.target.value)} disabled={busy}>
                    <option value="">Nessuno (vale il predefinito)</option>
                    {d.gestori.map((g) => <option key={g.gestore} value={g.gestore}>{g.nome}</option>)}
                  </select>
                  <button type="button" disabled={busy || scelteVisibili.length === 0}
                    className="inline-flex h-8 items-center gap-1.5 rounded bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
                    onClick={async () => {
                      const ok = await assegna(verso || null, scelteVisibili, d.gestori.find((g) => g.gestore === verso)?.nome ?? null);
                      if (ok) setScelte(new Set());
                    }}>
                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}Assegna
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
