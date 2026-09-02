/**
 * Relazione di processo — visualizzazione e stampa di una relazione generata
 * (dossier + documento) per uno scenario di esercizio. Il documento è HTML
 * autonomo prodotto dal server: qui lo si apre in un riquadro isolato, lo si
 * stampa in PDF o lo si scarica.
 */
import { useEffect, useRef, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { ArrowLeft, Download, ExternalLink, FileText, Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch, getApiBase } from "@/lib/api";

interface ReportMeta {
  id: string; scenarioId: string | null; dssId: string | null; projectId: string | null;
  title: string; isTest: boolean; summary: any; createdAt: string; meta?: any;
}

export default function ProcessReportPage() {
  const [, params] = useRoute<{ reportId: string }>("/fucina/relazioni/:reportId");
  const [, setLocation] = useLocation();
  const reportId = params?.reportId ?? "";
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!reportId) return;
    let alive = true;
    (async () => {
      try {
        const m = await apiFetch<ReportMeta>(`/api/service-program/reports/${reportId}`);
        if (!alive) return;
        setMeta(m);
        const r = await fetch(`${getApiBase()}/api/service-program/reports/${reportId}/html`, { credentials: "include" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        if (alive) setHtml(t);
      } catch (e: any) {
        if (alive) setError(e?.message ?? "Relazione non disponibile");
      }
    })();
    return () => { alive = false; };
  }, [reportId]);

  const print = () => { iframeRef.current?.contentWindow?.print(); };
  const download = () => {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `relazione-${(meta?.title ?? reportId).replace(/[^\w-]+/g, "_").slice(0, 60)}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const backTo = meta?.projectId ? `/fucina/${meta.projectId}` : "/fucina";
  const s = meta?.summary ?? {};

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 flex-wrap">
        <Button size="sm" variant="ghost" onClick={() => setLocation(backTo)} className="h-8 text-[11px]">
          <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Progetto
        </Button>
        <FileText className="w-4 h-4 text-cyan-300 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">{meta?.title ?? "Relazione di processo"}</div>
          {meta && (
            <div className="text-[10px] text-muted-foreground truncate">
              {meta.isTest ? "VERSIONE DI PROVA · " : ""}
              {s.vehicles != null ? `${s.vehicles} vetture · ` : ""}
              {s.duties != null ? `${s.duties} turni guida · ` : ""}
              {s.violations != null ? `${s.violations} violazioni · ` : ""}
              {s.totalCostEur != null ? `€ ${Number(s.totalCostEur).toLocaleString("it-IT", { maximumFractionDigits: 0 })}/giorno · ` : ""}
              generata il {new Date(meta.createdAt).toLocaleString("it-IT")}
            </div>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={print} disabled={!html} className="h-8 text-[11px] border-blue-500/40 text-blue-300 hover:bg-blue-500/10" title="Stampa o salva in PDF dal browser">
          <Printer className="w-3.5 h-3.5 mr-1" /> Stampa / PDF
        </Button>
        <Button size="sm" variant="outline" onClick={download} disabled={!html} className="h-8 text-[11px]" title="Scarica il documento HTML (autonomo, apribile ovunque)">
          <Download className="w-3.5 h-3.5 mr-1" /> Scarica HTML
        </Button>
        <a href={`${getApiBase()}/api/service-program/reports/${reportId}/html`} target="_blank" rel="noreferrer"
          className="inline-flex items-center h-8 px-2.5 rounded-md border border-border/60 text-[11px] hover:bg-muted/40" title="Apri il documento in una scheda">
          <ExternalLink className="w-3.5 h-3.5 mr-1" /> Scheda
        </a>
      </div>
      <div className="flex-1 min-h-0 bg-white">
        {error ? (
          <div className="p-6 text-sm text-red-400">{error}</div>
        ) : html ? (
          <iframe ref={iframeRef} title="Relazione" srcDoc={html} className="w-full h-full border-0" />
        ) : (
          <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico la relazione…</div>
        )}
      </div>
    </div>
  );
}
