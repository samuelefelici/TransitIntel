/**
 * Pagina PUBBLICA della Mappa di Rete condivisa via link (/m/:token).
 * L'utente può accendere/spegnere le linee da visualizzare. Brandizzata Cerbero.
 * Nessuna autenticazione richiesta.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPinned } from "lucide-react";
import { apiFetch } from "@/lib/api";
import NetworkMap3D, { type NData } from "@/components/NetworkMap3D";

interface ShareResp extends NData {
  token: string;
  title: string | null;
  agencyName: string | null;
  expiresAt?: string | null;
}

function col(c: string | null | undefined): string {
  if (!c) return "#2563eb";
  return c.startsWith("#") ? c : `#${c}`;
}

export default function NetworkSharePage() {
  const [, params] = useRoute("/m/:token");
  const token = params?.token ?? "";

  const q = useQuery({
    queryKey: ["network-share", token],
    queryFn: () => apiFetch<ShareResp>(`/api/network-share/${encodeURIComponent(token)}`),
    enabled: !!token,
    staleTime: 60 * 1000,
  });
  const data = q.data;

  const lines = useMemo(
    () => [...(data?.lines ?? [])].sort((a, b) => String(a.shortName ?? "").localeCompare(String(b.shortName ?? ""), "it", { numeric: true })),
    [data],
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visibleLines = useMemo(() => lines.filter((l) => !hidden.has(l.routeId)), [lines, hidden]);
  const filtered: NData | undefined = data
    ? { projectId: data.projectId, lines: visibleLines, cityNodes: data.cityNodes }
    : undefined;

  function toggle(routeId: string) {
    setHidden((prev) => { const n = new Set(prev); n.has(routeId) ? n.delete(routeId) : n.add(routeId); return n; });
  }

  if (q.isLoading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Carico la mappa…</div>;
  }
  if (q.isError || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-white gap-2">
        <MapPinned className="w-8 h-8 text-slate-500" />
        <p className="text-lg font-semibold">Link non valido o scaduto</p>
        <p className="text-sm text-slate-400">Controlla l'indirizzo o richiedi un nuovo link.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-white">
      {/* Header brandizzato */}
      <header className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-slate-900 to-slate-800 border-b border-white/10">
        <img src="/logo.png" alt="Cerbero Analytics" className="h-9 w-auto drop-shadow" />
        <div className="leading-tight">
          <div className="text-base font-extrabold tracking-wide">Cerbero Analytics</div>
          <div className="text-[11px] text-slate-300">Mappa di Rete{data.agencyName ? ` · ${data.agencyName}` : ""}{data.title ? ` · ${data.title}` : ""}</div>
        </div>
        <div className="ml-auto text-right text-[11px] text-slate-400">
          <div>{visibleLines.length}/{lines.length} linee</div>
          {data.expiresAt && <div className="text-slate-500">valido fino al {new Date(data.expiresAt).toLocaleDateString("it-IT")}</div>}
        </div>
      </header>

      <div className="flex-1 grid" style={{ gridTemplateColumns: "260px 1fr" }}>
        {/* Legenda / selezione linee */}
        <aside className="border-r border-white/10 bg-slate-900/60 overflow-y-auto">
          <div className="px-3 py-2 flex items-center gap-2 border-b border-white/10">
            <span className="text-xs font-semibold text-slate-300">Linee</span>
            <button onClick={() => setHidden(new Set())} className="ml-auto text-[11px] text-sky-300 hover:underline">Tutte</button>
            <button onClick={() => setHidden(new Set(lines.map((l) => l.routeId)))} className="text-[11px] text-slate-400 hover:underline">Nessuna</button>
          </div>
          <div className="divide-y divide-white/5">
            {lines.map((l) => {
              const on = !hidden.has(l.routeId);
              return (
                <label key={l.routeId} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5">
                  <input type="checkbox" checked={on} onChange={() => toggle(l.routeId)} className="accent-sky-500" />
                  <span className="px-2 py-0.5 rounded text-white text-xs font-bold shrink-0" style={{ backgroundColor: col(l.color), opacity: on ? 1 : 0.4 }}>{l.shortName ?? "?"}</span>
                  <span className={`text-xs truncate ${on ? "text-slate-200" : "text-slate-500"}`}>{l.longName ?? l.routeId}</span>
                </label>
              );
            })}
          </div>
        </aside>

        {/* Mappa */}
        <main className="relative">
          {filtered && visibleLines.length > 0
            ? <NetworkMap3D projectId={data.projectId} routeIds={visibleLines.map((l) => l.routeId)} data={filtered} height="calc(100vh - 92px)" />
            : <div className="h-full flex items-center justify-center text-slate-400 text-sm">Seleziona almeno una linea dal pannello a sinistra.</div>}
        </main>
      </div>

      <footer className="px-4 py-1.5 text-[10px] text-slate-500 bg-slate-900 border-t border-white/10 text-center">
        Powered by Cerbero Analytics
      </footer>
    </div>
  );
}
