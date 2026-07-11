/**
 * WorkWindowPanel — "Area di lavoro" (stile MAIOR Bdsi, finestra LAVORO) condivisa
 * tra Turni Macchina e Turni Guida.
 *
 * È una PAGINA a schermo intero: sidebar con il gantt dei turni (mini-gantt,
 * allargabile) da cui TRASCINI i turni nell'area di lavoro. Lì ogni turno è una
 * CARD TABELLARE (una riga = una corsa: percorso · ora/luogo inizio · ora/luogo
 * fine). "Spacchetta" (nell'header della card) scioglie il turno in RIGHE LIBERE
 * che muovi e ordini a piacere sul canvas; selezioni con il mouse (rettangolo)
 * o con ctrl+click, poi "Rimpacchetta" chiude un turno nuovo (deposito scelto
 * dall'operatore, tipologia rilevata dalla normativa — logica del workspace
 * ospite via onRepack). Colori: corse GIALLE, riserva VERDE, presidio AZZURRO,
 * taxi ARANCIONE. Click destro su una corsa → dettagli + tipologia di macchina.
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import { X, PackageOpen, Package, Trash2, CheckSquare, Square, ShieldCheck, ArrowLeft } from "lucide-react";

export interface WorkActivity {
  /** id univoco nell'ambito della finestra (per le corse: tripId) */
  id: string;
  /** true = corsa di servizio (selezionabile e rimpacchettabile) */
  isTrip: boolean;
  /** etichetta tipo attività (per le corse: il PERCORSO/linea) */
  kindLabel: string;
  kindColor?: string;
  /** fascia oraria "HH:MM → HH:MM" */
  timeLabel: string;
  /** descrizione libera (fallback) */
  desc: string;
  deletable?: boolean;
  /** minuti dal giorno */
  startMin?: number;
  endMin?: number;
  /** luoghi di inizio/fine corsa */
  fromName?: string;
  toName?: string;
  /** tipologia di macchina (mostrata col click destro) */
  vehicleLabel?: string;
  /** tipo attività non-corsa: colora la riga (verde/azzurro/arancione) */
  actType?: "riserva" | "presidio" | "taxi";
}

export interface WorkShiftView {
  id: string;
  label: string;
  sub?: string;
  unpacked: boolean;
  activities: WorkActivity[];
}

/** Turno disponibile nel gantt (non ancora nella finestra). */
export interface WorkAvailableShift {
  id: string;
  label: string;
  sub?: string;
  color?: string;
  segments: Array<{ startMin: number; endMin: number; color?: string }>;
}

interface Props {
  shifts: WorkShiftView[];
  loose?: WorkActivity[];
  onReorderLoose?: (fromIdx: number, toIdx: number) => void;
  onImport?: () => void;
  onAddActivity?: () => void;
  onDeleteLoose?: (id: string) => void;
  selected: Set<string>;
  onToggleSelect: (activityId: string) => void;
  /** selezione in blocco (rettangolo col mouse / click semplice): sostituisce
   *  la selezione, o la ESTENDE se additive=true (ctrl premuto) */
  onSelectMany?: (ids: string[], additive?: boolean) => void;
  onToggleSelectAll: (shiftId: string) => void;
  onDropShift: (shiftId: string) => void;
  onRemoveShift: (shiftId: string) => void;
  onUnpack: (shiftId: string) => void;
  onUnpackAll: () => void;
  onRepack: () => void;
  onRepackIds?: (ids: string[]) => void;
  /** tipologia LIVE della selezione corrente (normativa) */
  onPreviewIds?: (ids: string[]) => Promise<string | null>;
  onVerifyShift?: (shiftId: string) => void;
  available?: WorkAvailableShift[];
  onClose: () => void;
  busy?: boolean;
  accent?: "amber" | "purple";
}

/* colori riga per tipo (specifica operatore): corse gialle, riserva verde,
 * presidio azzurro, taxi arancione */
const ROW_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  trip:     { bg: "rgba(234,179,8,0.16)",  border: "rgba(234,179,8,0.55)",  text: "#fde047" },
  riserva:  { bg: "rgba(34,197,94,0.16)",  border: "rgba(34,197,94,0.55)",  text: "#86efac" },
  presidio: { bg: "rgba(56,189,248,0.16)", border: "rgba(56,189,248,0.55)", text: "#7dd3fc" },
  taxi:     { bg: "rgba(249,115,22,0.18)", border: "rgba(249,115,22,0.55)", text: "#fdba74" },
};
const rowColorOf = (a: WorkActivity) => ROW_COLORS[a.actType ?? (a.isTrip ? "trip" : "riserva")] ?? ROW_COLORS.trip;
/** selezionabile per il rimpacchetta: corse E attività create dall'operatore */
const isPickable = (a: WorkActivity) => a.isTrip || !!a.actType;

const CARD_W = 470;   // larghezza card-riga libera
const CARD_H = 26;    // altezza card-riga libera

export default function WorkWindowPanel({
  shifts, loose = [], onImport, onAddActivity, onDeleteLoose,
  selected, onToggleSelect, onSelectMany, onToggleSelectAll, onDropShift, onRemoveShift,
  onUnpack, onUnpackAll, onRepack, onPreviewIds, onVerifyShift, available, onClose, busy, accent = "purple",
}: Props) {
  const ac = accent === "amber"
    ? { text: "text-amber-300", border: "border-amber-500/40", bg: "bg-amber-500/10", solid: "bg-amber-500/20" }
    : { text: "text-purple-300", border: "border-purple-500/40", bg: "bg-purple-500/10", solid: "bg-purple-500/20" };
  const nSel = selected.size;

  /* ── Sidebar gantt (allargabile) ── */
  const [sideW, setSideW] = useState(300);
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    if (!resizing) return;
    const move = (e: MouseEvent) => setSideW(Math.max(210, Math.min(680, e.clientX)));
    const up = () => setResizing(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [resizing]);
  const av = available ?? [];
  const avAll = av.flatMap(r => r.segments);
  const avMin = avAll.length ? Math.min(...avAll.map(s => s.startMin)) : 0;
  const avSpan = avAll.length ? Math.max(1, Math.max(...avAll.map(s => s.endMin)) - avMin) : 1;

  /* ── Posizioni libere sul canvas (card turno + righe sciolte) ── */
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const posRef = useRef(pos); posRef.current = pos;
  // default: le card turno in colonna a sinistra, le righe libere a destra
  useEffect(() => {
    setPos(prev => {
      const next = { ...prev };
      let changed = false;
      shifts.forEach((s, i) => {
        const k = `shift:${s.id}`;
        if (!next[k]) { next[k] = { x: 24 + (i % 2) * 540, y: 24 + Math.floor(i / 2) * 260 }; changed = true; }
      });
      loose.forEach((a, i) => {
        const k = `card:${a.id}`;
        if (!next[k]) { next[k] = { x: 1120 + (i % 2) * 30, y: 24 + i * (CARD_H + 8) }; changed = true; }
      });
      return changed ? next : prev;
    });
  }, [shifts, loose]);

  /* drag di una card (turno o riga libera): soglia 4px per distinguere dal click */
  const dragRef = useRef<{ key: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const startDrag = (key: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const p = posRef.current[key] ?? { x: 0, y: 0 };
    dragRef.current = { key, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    const move = (ev: MouseEvent) => {
      const d = dragRef.current; if (!d) return;
      const dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
      if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      d.moved = true;
      setPos(prev => ({ ...prev, [d.key]: { x: Math.max(0, d.ox + dx), y: Math.max(0, d.oy + dy) } }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setTimeout(() => { dragRef.current = null; }, 0);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const wasDrag = () => !!dragRef.current?.moved;

  /* ── Selezione a rettangolo sul canvas (più ctrl+click sulle card) ── */
  const canvasRef = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const bandStart = (e: React.MouseEvent) => {
    if (e.target !== canvasRef.current || e.button !== 0) return;
    const rc = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rc.left + canvasRef.current!.parentElement!.scrollLeft;
    const y = e.clientY - rc.top + canvasRef.current!.parentElement!.scrollTop;
    const additive = e.ctrlKey || e.metaKey;
    const start = { x0: x, y0: y, x1: x, y1: y };
    setBand(start);
    const move = (ev: MouseEvent) => {
      const r2 = canvasRef.current!.getBoundingClientRect();
      setBand(b => b ? { ...b, x1: ev.clientX - r2.left + canvasRef.current!.parentElement!.scrollLeft, y1: ev.clientY - r2.top + canvasRef.current!.parentElement!.scrollTop } : b);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBand(b => {
        if (b) {
          const [xa, xb] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
          const [ya, yb] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
          const hit: string[] = [];
          for (const a of loose) {
            const p = posRef.current[`card:${a.id}`]; if (!p) continue;
            if (p.x < xb && p.x + CARD_W > xa && p.y < yb && p.y + CARD_H > ya) hit.push(a.id);
          }
          if (xb - xa > 6 || yb - ya > 6) onSelectMany?.(hit, additive);
          else if (!additive) onSelectMany?.([], false); // click sul vuoto = deseleziona
        }
        return null;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /* click su una card/riga: ctrl = toggle, semplice = selezione singola */
  const rowClick = (a: WorkActivity) => (e: React.MouseEvent) => {
    if (wasDrag() || !isPickable(a)) return;
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) onToggleSelect(a.id);
    else if (onSelectMany) onSelectMany([a.id], false);
    else onToggleSelect(a.id);
  };

  /* ── Click destro: dettagli corsa + tipologia di macchina ── */
  const [ctx, setCtx] = useState<{ x: number; y: number; a: WorkActivity } | null>(null);
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("contextmenu", close); };
  }, [ctx]);
  const rowCtx = (a: WorkActivity) => (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, a });
  };

  /* ── Tipologia LIVE della selezione (normativa) ── */
  const [selType, setSelType] = useState<string | null>(null);
  useEffect(() => {
    if (!onPreviewIds || nSel === 0) { setSelType(null); return; }
    const ids = [...selected];
    const t = setTimeout(() => { void onPreviewIds(ids).then(setSelType); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify([...selected].sort())]);

  const handleDropShift = (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("application/x-cerbero-row") || e.dataTransfer.getData("text/plain");
    if (id) onDropShift(id);
  };

  /* riga-tabella di una corsa/attività: percorso · inizio (ora+luogo) · fine (ora+luogo) */
  const rowCells = (a: WorkActivity) => {
    const c = rowColorOf(a);
    const [t0, t1] = a.timeLabel.split("→").map(s => s?.trim() ?? "");
    return (
      <>
        <span className="w-16 shrink-0 font-bold truncate" style={{ color: c.text }}>{a.isTrip ? a.kindLabel : (a.actType ?? a.kindLabel)}</span>
        <span className="w-11 shrink-0 font-mono">{t0}</span>
        <span className="flex-1 min-w-0 truncate opacity-90">{a.fromName ?? a.desc.split("→")[0]}</span>
        <span className="w-11 shrink-0 font-mono">{t1}</span>
        <span className="flex-1 min-w-0 truncate opacity-90">{a.toName ?? a.desc.split("→")[1] ?? ""}</span>
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col" onDragOver={(e) => e.preventDefault()} onDrop={handleDropShift}>
      {/* ── Header pagina ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-background/95 flex-wrap shrink-0">
        <button onClick={onClose} title="Torna al gantt"
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Gantt
        </button>
        <span className={`text-sm font-bold ${ac.text}`}>🪟 Area di lavoro</span>
        <span className="text-[10px] text-muted-foreground">{shifts.length} turni · {loose.length} corse sciolte · {nSel} selezionate</span>
        {selType && nSel > 0 && (
          <span title="Tipologia che avrebbe il turno chiuso con la selezione corrente (normativa attiva)"
            className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300">
            selezione → {selType}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {onAddActivity && (
            <button onClick={onAddActivity} disabled={busy}
              title="Crea un'attività: riserva (verde), presidio (azzurro), taxi (arancione) — diventa una riga libera"
              className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">
              ➕ Attività
            </button>
          )}
          {onImport && (
            <button onClick={onImport} disabled={busy}
              title="Importa corse scoperte da altre UDP con la stessa validità"
              className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground disabled:opacity-40">
              ⬇ Importa scoperte
            </button>
          )}
          <button onClick={onUnpackAll} disabled={busy || shifts.length === 0}
            title="Spacchetta TUTTI i turni nell'area: le corse diventano righe libere"
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground disabled:opacity-40">
            <PackageOpen className="w-3.5 h-3.5" /> Spacchetta tutto
          </button>
          <button onClick={onRepack} disabled={busy || nSel === 0}
            title="Chiude un turno NUOVO con le corse selezionate: scegli il deposito, tipologia e fuorilinea automatici"
            className={`flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-lg border ${ac.border} ${ac.solid} ${ac.text} hover:opacity-90 disabled:opacity-40`}>
            <Package className="w-3.5 h-3.5" /> Rimpacchetta ({nSel})
          </button>
          <button onClick={onClose} title="Chiudi l'area di lavoro" className="p-1 rounded text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── SIDEBAR GANTT (allargabile) ── */}
        <div className="shrink-0 border-r border-border/30 bg-background/60 overflow-y-auto" style={{ width: sideW }}>
          <div className="px-2 py-1.5 border-b border-border/30 sticky top-0 bg-background/95 z-10">
            <p className={`text-[10px] font-bold uppercase tracking-wide ${ac.text}`}>Turni dal gantt</p>
            <p className="text-[9px] text-muted-foreground">trascina un turno nell'area di lavoro, o aggiungilo col ⊕</p>
          </div>
          {av.map(row => (
            <div key={row.id}
              draggable
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("application/x-cerbero-row", row.id); e.dataTransfer.setData("text/plain", row.id); }}
              onDoubleClick={() => onDropShift(row.id)}
              title={`${row.label}${row.sub ? ` · ${row.sub}` : ""} — trascina nell'area di lavoro (o doppio click / ⊕)`}
              className="px-2 py-1.5 border-b border-border/15 cursor-grab active:cursor-grabbing hover:bg-muted/20 select-none">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: row.color || "#a78bfa" }} />
                <span className="text-[11px] font-bold text-foreground truncate">{row.label}</span>
                {row.sub && <span className="text-[9px] text-muted-foreground truncate">{row.sub}</span>}
                <button onClick={(e) => { e.stopPropagation(); onDropShift(row.id); }}
                  title="Aggiungi all'area di lavoro"
                  className={`ml-auto shrink-0 w-5 h-5 rounded border ${ac.border} ${ac.text} text-[12px] leading-none hover:opacity-80`}>＋</button>
              </div>
              <div className="relative h-2.5 mt-1 rounded-sm bg-muted/20 overflow-hidden">
                {row.segments.map((sg, i) => (
                  <div key={i} className="absolute top-0 bottom-0 rounded-[2px]"
                    style={{
                      left: `${((sg.startMin - avMin) / avSpan) * 100}%`,
                      width: `${Math.max(0.8, ((sg.endMin - sg.startMin) / avSpan) * 100)}%`,
                      background: sg.color || row.color || "#a78bfa",
                      opacity: 0.85,
                    }} />
                ))}
              </div>
            </div>
          ))}
          {av.length === 0 && <p className="px-2 py-3 text-[10px] text-muted-foreground">Tutti i turni sono già nell'area di lavoro.</p>}
        </div>
        <div onMouseDown={(e) => { e.preventDefault(); setResizing(true); }}
          title="Trascina per allargare/restringere il gantt"
          className={`w-1.5 shrink-0 cursor-col-resize transition-colors ${resizing ? ac.solid : "bg-border/30 hover:bg-border/70"}`} />

        {/* ── CANVAS: card turno tabellari + righe libere, tutto trascinabile ── */}
        <div className="flex-1 min-w-0 overflow-auto" onDragOver={(e) => e.preventDefault()} onDrop={handleDropShift}>
          <div ref={canvasRef} onMouseDown={bandStart}
            className="relative"
            style={{ width: 2400, height: Math.max(900, ...Object.values(pos).map(p => p.y + 320)) }}>

            {/* rettangolo di selezione */}
            {band && (
              <div className={`absolute border ${ac.border} ${ac.bg} pointer-events-none z-30`}
                style={{ left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) }} />
            )}

            {shifts.length === 0 && loose.length === 0 && (
              <div className="absolute left-8 top-8 right-8 border-2 border-dashed border-border/30 rounded-xl p-10 text-center pointer-events-none">
                <p className="text-sm text-muted-foreground">Trascina qui un turno dalla sidebar (o usa ⊕)</p>
                <p className="text-[11px] text-muted-foreground/60 mt-1">Lo vedrai come tabella (una riga = una corsa): Spacchetta per liberare le corse, selezionale col mouse o ctrl+click, poi Rimpacchetta.</p>
              </div>
            )}

            {/* CARD TURNO tabellari (trascinabili dall'header) */}
            {shifts.map(s => {
              const p = pos[`shift:${s.id}`] ?? { x: 24, y: 24 };
              const trips = s.activities.filter(a => a.isTrip);
              const allSel = trips.length > 0 && trips.every(t => selected.has(t.id));
              return (
                <div key={s.id} className="absolute rounded-lg border border-border/50 bg-background/95 shadow-xl select-none"
                  style={{ left: p.x, top: p.y, width: 520 }}>
                  {/* header (drag della card) — stile nastro Bdsi */}
                  <div onMouseDown={startDrag(`shift:${s.id}`)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-t-lg cursor-grab active:cursor-grabbing ${ac.solid} border-b ${ac.border}`}>
                    <button onClick={(e) => { e.stopPropagation(); onToggleSelectAll(s.id); }} onMouseDown={(e) => e.stopPropagation()}
                      className={ac.text} title={allSel ? "Deseleziona tutte le corse" : "Seleziona tutte le corse"}>
                      {allSel ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                    </button>
                    <span className="text-[11px] font-bold text-foreground">{s.label}</span>
                    {s.sub && <span className="text-[9px] text-muted-foreground truncate">{s.sub}</span>}
                    <div className="ml-auto flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
                      {!s.unpacked && (
                        <button onClick={() => onUnpack(s.id)}
                          title="Spacchetta: le corse diventano righe LIBERE da muovere e ricomporre"
                          className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded border ${ac.border} ${ac.text} hover:opacity-80`}>
                          <PackageOpen className="w-3 h-3" /> Spacchetta
                        </button>
                      )}
                      {onVerifyShift && (
                        <button onClick={() => onVerifyShift(s.id)} title="Verifica normativa del turno"
                          className="p-0.5 rounded text-muted-foreground hover:text-emerald-400"><ShieldCheck className="w-3.5 h-3.5" /></button>
                      )}
                      <button onClick={() => onRemoveShift(s.id)} title="Rimuovi dall'area (torna nel gantt)"
                        className="p-0.5 rounded text-muted-foreground hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                  {/* righe = corse/attività */}
                  <div className="divide-y divide-border/15 max-h-72 overflow-y-auto rounded-b-lg">
                    {s.activities.map((a, i) => {
                      const c = rowColorOf(a);
                      const sel = isPickable(a) && selected.has(a.id);
                      return (
                        <div key={`${a.id}-${i}`}
                          onClick={rowClick(a)}
                          onContextMenu={rowCtx(a)}
                          title={isPickable(a) ? "click = seleziona · ctrl+click = aggiungi · destro = dettagli" : a.kindLabel}
                          className={`flex items-center gap-1.5 px-2 h-[26px] text-[10px] ${isPickable(a) ? "cursor-pointer" : "opacity-70"} ${sel ? "ring-2 ring-inset ring-white/70" : ""}`}
                          style={{ background: c.bg, borderLeft: `3px solid ${c.border}` }}>
                          {rowCells(a)}
                        </div>
                      );
                    })}
                    {s.activities.length === 0 && <div className="px-2 py-2 text-[10px] text-muted-foreground">nessuna corsa</div>}
                  </div>
                </div>
              );
            })}

            {/* RIGHE LIBERE (corse spacchettate/importate + attività): muovile dove vuoi */}
            {loose.map(a => {
              const p = pos[`card:${a.id}`] ?? { x: 1120, y: 24 };
              const c = rowColorOf(a);
              const sel = selected.has(a.id);
              return (
                <div key={a.id}
                  onMouseDown={startDrag(`card:${a.id}`)}
                  onClick={rowClick(a)}
                  onContextMenu={rowCtx(a)}
                  title="trascina per spostare · click = seleziona · ctrl+click = aggiungi · destro = dettagli"
                  className={`absolute flex items-center gap-1.5 px-2 rounded-md border text-[10px] cursor-grab active:cursor-grabbing shadow-md ${sel ? "ring-2 ring-white/70" : ""}`}
                  style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H, background: c.bg, borderColor: c.border }}>
                  {rowCells(a)}
                  {a.deletable && onDeleteLoose && (
                    <button onClick={(e) => { e.stopPropagation(); onDeleteLoose(a.id); }} onMouseDown={(e) => e.stopPropagation()}
                      title="Elimina questa attività" className="shrink-0 text-muted-foreground hover:text-rose-400">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Context menu (click destro): dettagli + tipologia macchina ── */}
      {ctx && (
        <div className="fixed z-[70] rounded-lg border border-border/60 bg-zinc-950 shadow-2xl p-2.5 text-[11px] space-y-1 min-w-[220px]"
          style={{ left: Math.min(ctx.x, window.innerWidth - 260), top: Math.min(ctx.y, window.innerHeight - 160) }}
          onClick={(e) => e.stopPropagation()}>
          <p className="font-bold" style={{ color: rowColorOf(ctx.a).text }}>
            {ctx.a.isTrip ? `Corsa · percorso ${ctx.a.kindLabel}` : ctx.a.kindLabel}
          </p>
          <p className="text-zinc-300 font-mono">{ctx.a.timeLabel}</p>
          <p className="text-zinc-400">Da: <b className="text-zinc-200">{ctx.a.fromName ?? "—"}</b></p>
          <p className="text-zinc-400">A: <b className="text-zinc-200">{ctx.a.toName ?? "—"}</b></p>
          {ctx.a.isTrip && (
            <p className="text-zinc-400 pt-0.5 border-t border-zinc-800">Tipologia macchina: <b className="text-amber-300">{ctx.a.vehicleLabel ?? "—"}</b></p>
          )}
        </div>
      )}
    </div>
  );
}
