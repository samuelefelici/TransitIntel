/**
 * InteractiveGantt — Drag & drop Gantt chart for vehicle / driver shifts
 *
 * Features:
 *  ✦ Horizontal drag to shift trips in time
 *  ✦ Vertical drag to reassign trips between rows (vehicles/drivers)
 *  ✦ Edge resize to adjust start/end times
 *  ✦ 5-minute snap grid
 *  ✦ Zoom slider (hours per viewport)
 *  ✦ Undo / Redo stack
 *  ✦ Tooltip on hover
 *  ✦ "Modified" badge on changed bars
 *  ✦ Callback `onShiftsChange` to propagate edits back to parent
 */

import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ZoomIn, ZoomOut, Undo2, Redo2, RotateCcw, GripVertical,
  Clock, ArrowRight, Navigation, MapPin, AlertTriangle,
  Pencil, Check, X, Sparkles, Move, Trash2, Maximize2, Minimize2,
} from "lucide-react";

// ─── Shared types ────────────────────────────────────────────
export interface GanttBar {
  /** Unique id for the bar (tripId, ripresaKey, …) */
  id: string;
  /** Row key this bar belongs to (vehicleId, driverId) */
  rowId: string;
  /** Start in minutes from midnight */
  startMin: number;
  /** End in minutes from midnight */
  endMin: number;
  /** Display label */
  label: string;
  /** Bar color */
  color: string;
  /** Visual style */
  style: "solid" | "dashed" | "striped" | "depot";
  /** Tooltip lines */
  tooltip?: string[];
  /** Whether this bar can be dragged/resized */
  locked?: boolean;
  /** Optional glow color (CSS color). If set, the bar gets a colored boxShadow halo behind it — useful to indicate compatibility/affinity (e.g. green = many compatible drivers, red = few). */
  glow?: string;
  /** Arbitrary metadata the parent can attach */
  meta?: Record<string, any>;
}

export interface GanttRow {
  id: string;
  label: string;
  sublabel?: string;
  /** Small color dot before label */
  dotColor?: string;
}

export interface GanttChange {
  barId: string;
  fromRowId: string;
  toRowId: string;
  oldStartMin: number;
  oldEndMin: number;
  newStartMin: number;
  newEndMin: number;
}

export interface InteractiveGanttProps {
  rows: GanttRow[];
  bars: GanttBar[];
  /** Called after every drag/resize commit */
  onBarChange?: (change: GanttChange, allBars: GanttBar[]) => void;
  /** Minimum hour shown (default 4) */
  minHour?: number;
  /** Maximum hour shown (default 26) */
  maxHour?: number;
  /** Snap granularity in minutes (default 5) */
  snapMin?: number;
  /** Row height in px (default 32) */
  rowHeight?: number;
  /** Label column width in px (default 160) */
  labelWidth?: number;
  /** Whether editing is enabled (default true) */
  editable?: boolean;
  /** Called when a row label is renamed inline */
  onRowRename?: (rowId: string, newLabel: string) => void;
  /** Compute suggestions of compatible rows where the given bar could be moved */
  getSuggestions?: (bar: GanttBar) => GanttSuggestion[];
  /** Called when ANY bar (locked or not) is clicked. Useful for opening editor dialogs on synthetic / locked bars (deadheads, depot returns, pull-out/pull-in). Riceve anche le coordinate viewport del click. */
  onBarClick?: (bar: GanttBar, anchor?: { x: number; y: number }) => void;
  /** Called on right click (or shift+click passthrough) over a bar with viewport anchor. */
  onBarContextMenu?: (bar: GanttBar, anchor: { x: number; y: number; side?: "left" | "right" }) => void;
  /** Selected bar id for inline actions (controlled from parent). */
  selectedBarId?: string | null;
  /** Selection change callback. */
  onSelectedBarIdChange?: (barId: string | null) => void;
  /** Delete currently selected bar action (for deadhead/depot/pullout/pullin). */
  onDeleteSelectedBar?: (bar: GanttBar) => void;
  /** Edit currently selected bar action. */
  onEditSelectedBar?: (bar: GanttBar) => void;
  /** Request insertion of a new deadhead around a trip bar from tooltip actions. */
  onInsertDeadheadFromTrip?: (bar: GanttBar, mode: "before" | "after", anchor: { x: number; y: number }) => void;
  /** Highlight rows during drag with a background color (e.g. green for compatible, red for incompatible). Map: rowId -> CSS color (rgba/hex). */
  rowHighlights?: Record<string, string>;
  /** Called when user starts dragging a bar (after the small movement threshold). Useful to compute rowHighlights via suggestions. */
  onBarDragStart?: (bar: GanttBar) => void;
  /** Called when drag ends (commit or cancel). */
  onBarDragEnd?: () => void;
  /** Rende trascinabile l'etichetta di riga (HTML5 dnd): il rowId viaggia in
   *  dataTransfer "application/x-cerbero-row" — usato dalla Finestra di lavoro. */
  rowsDraggable?: boolean;
}

export interface GanttSuggestion {
  rowId: string;
  label: string;
  reason?: string;
  /** Optional extra detail like free gap window */
  detail?: string;
}

// ─── Helpers ─────────────────────────────────────────────────
const snap = (val: number, grid: number) => Math.round(val / grid) * grid;
const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
const minToStr = (m: number) => {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}:${String(mm).padStart(2, "0")}`;
};

/** Check if a bar at [startMin, endMin] would overlap any other bar on the same row */
function detectCollision(
  bars: GanttBar[],
  barId: string,
  targetRowId: string,
  startMin: number,
  endMin: number,
): boolean {
  for (const b of bars) {
    if (b.id === barId) continue; // skip self
    if (b.rowId !== targetRowId) continue; // different row
    // Two intervals overlap if start < otherEnd AND end > otherStart
    if (startMin < b.endMin && endMin > b.startMin) return true;
  }
  return false;
}

// ─── Component ───────────────────────────────────────────────
export default function InteractiveGantt({
  rows,
  bars: initialBars,
  onBarChange,
  minHour = 4,
  maxHour = 26,
  snapMin = 5,
  rowHeight = 32,
  labelWidth = 160,
  editable = true,
  rowsDraggable = false,
  onRowRename,
  getSuggestions,
  onBarClick,
  onBarContextMenu,
  selectedBarId,
  onSelectedBarIdChange,
  onDeleteSelectedBar,
  onEditSelectedBar,
  onInsertDeadheadFromTrip,
  rowHighlights,
  onBarDragStart,
  onBarDragEnd,
}: InteractiveGanttProps) {
  // ── State ──
  const [bars, setBars] = useState<GanttBar[]>(initialBars);
  const [modifiedIds, setModifiedIds] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1); // 1 = full range fits viewport
  const [scrollX, setScrollX] = useState(0);
  const [undoStack, setUndoStack] = useState<GanttBar[][]>([]);
  const [redoStack, setRedoStack] = useState<GanttBar[][]>([]);
  const [hoveredBar, setHoveredBar] = useState<{ bar: GanttBar; x: number; y: number; anchorTop: number } | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [pinnedTooltip, setPinnedTooltip] = useState<string | null>(null);
  const [localSelectedBarId, setLocalSelectedBarId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // FIX-TOOLTIP: posizione finale dopo misurazione + clamp viewport
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);

  // Sync when parent passes new bars (e.g. new optimization result)
  useEffect(() => {
    setBars(initialBars);
    setModifiedIds(new Set());
    setUndoStack([]);
    setRedoStack([]);
  }, [initialBars]);

  const activeSelectedBarId = selectedBarId !== undefined ? selectedBarId : localSelectedBarId;
  const setSelectedBarId = useCallback((barId: string | null) => {
    if (selectedBarId === undefined) setLocalSelectedBarId(barId);
    onSelectedBarIdChange?.(barId);
  }, [selectedBarId, onSelectedBarIdChange]);

  const containerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // FIX-TOOLTIP: dopo che il tooltip è renderizzato, misuriamo le dimensioni
  // reali e ricalcoliamo top/left per garantire che resti dentro il viewport.
  // Se non c'è abbastanza spazio sotto la barra, lo flippiamo sopra.
  useLayoutEffect(() => {
    if (!hoveredBar || !tooltipRef.current) {
      setTipPos(null);
      return;
    }
    const tipEl = tooltipRef.current;
    const tipRect = tipEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    // Default: ancora alla "y" calcolata in onMouseEnter (sotto la barra)
    let top = hoveredBar.y;
    let left = hoveredBar.x - tipRect.width / 2;

    // Clamp orizzontale dentro il viewport
    if (left + tipRect.width + margin > vw) left = vw - tipRect.width - margin;
    if (left < margin) left = margin;

    // Verifica overflow verticale (sotto al viewport)
    if (top + tipRect.height + margin > vh) {
      const flipped = hoveredBar.anchorTop - tipRect.height - 6;
      top = flipped > margin ? flipped : vh - tipRect.height - margin;
    }
    if (top < margin) top = margin;

    setTipPos({ left, top });
  }, [hoveredBar]);

  const totalRangeMin = (maxHour - minHour) * 60;
  const timelineWidthPx = useMemo(
    () => Math.max(800, totalRangeMin * zoom * 1.2),
    [totalRangeMin, zoom],
  );

  // ── Position helpers ──
  const minToPx = useCallback(
    (m: number) => ((m - minHour * 60) / totalRangeMin) * timelineWidthPx,
    [minHour, totalRangeMin, timelineWidthPx],
  );
  const pxToMin = useCallback(
    (px: number) => (px / timelineWidthPx) * totalRangeMin + minHour * 60,
    [minHour, totalRangeMin, timelineWidthPx],
  );
  const rowIndex = useCallback(
    (rowId: string) => rows.findIndex(r => r.id === rowId),
    [rows],
  );

  // ── Commit a change ──
  const commitChange = useCallback(
    (newBars: GanttBar[], change: GanttChange) => {
      setUndoStack(prev => [...prev, bars]);
      setRedoStack([]);
      setModifiedIds(prev => new Set(prev).add(change.barId));
      setBars(newBars);
      onBarChange?.(change, newBars);
    },
    [bars, onBarChange],
  );

  // ── Move a bar to another row (used by suggestion buttons) ──
  // NB: NON usiamo detectCollision qui — i suggerimenti del consumer
  // (es. suggestDriversForTrip) hanno già la loro logica di compatibilità
  // (overlap su trip reali + deadhead). detectCollision invece guarda
  // TUTTE le bar (incluse pre-turno / transfer / riposo / cambio-macchina)
  // e bloccherebbe silenziosamente molti suggerimenti validi.
  // Eventuali conflitti non rilevati dal suggester saranno gestiti dal
  // consumer in `onBarChange` (es. applyDriverTripChange ⇒ toast.warning),
  // e il successivo re-render via `initialBars` riallineerà lo stato.
  const moveBarToRow = useCallback(
    (barId: string, targetRowId: string) => {
      const bar = bars.find(b => b.id === barId);
      if (!bar || bar.locked) return;
      if (bar.rowId === targetRowId) return;
      const change: GanttChange = {
        barId,
        fromRowId: bar.rowId,
        toRowId: targetRowId,
        oldStartMin: bar.startMin,
        oldEndMin: bar.endMin,
        newStartMin: bar.startMin,
        newEndMin: bar.endMin,
      };
      const newBars = bars.map(b => b.id === barId ? { ...b, rowId: targetRowId } : b);
      commitChange(newBars, change);
      setHoveredBar(null);
      setPinnedTooltip(null);
    },
    [bars, commitChange],
  );

  // ── Undo / Redo ──
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack(r => [...r, bars]);
    setUndoStack(s => s.slice(0, -1));
    setBars(prev);
  }, [bars, undoStack]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack(s => [...s, bars]);
    setRedoStack(r => r.slice(0, -1));
    setBars(next);
  }, [bars, redoStack]);

  const resetAll = useCallback(() => {
    setBars(initialBars);
    setModifiedIds(new Set());
    setUndoStack([]);
    setRedoStack([]);
  }, [initialBars]);

  const toggleFullscreen = useCallback(async () => {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch {
      // Ignore fullscreen errors (browser policy / unsupported contexts).
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === shellRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!activeSelectedBarId) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedBarId(null);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const selected = bars.find(b => b.id === activeSelectedBarId);
      if (!selected) return;
      const kind = selected.meta?.type as string | undefined;
      if (kind !== "deadhead" && kind !== "depot" && kind !== "pullout" && kind !== "pullin") return;
      e.preventDefault();
      onDeleteSelectedBar?.(selected);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeSelectedBarId, bars, onDeleteSelectedBar, setSelectedBarId]);

  // ── Drag state ──
  const dragState = useRef<{
    barId: string;
    mode: "move" | "resize-left" | "resize-right";
    origStartMin: number;
    origEndMin: number;
    origRowId: string;
    startClientX: number;
    startClientY: number;
    hasMoved: boolean;
  } | null>(null);

  const [dragPreview, setDragPreview] = useState<{
    barId: string;
    startMin: number;
    endMin: number;
    rowId: string;
    collision: boolean;
  } | null>(null);

  // ── Pointer handlers ──
  const onPointerDown = useCallback(
    (e: React.PointerEvent, barId: string, mode: "move" | "resize-left" | "resize-right") => {
      if (!editable) return;
      // Right-click must remain available for context menu actions.
      if (e.button !== 0) return;
      const bar = bars.find(b => b.id === barId);
      if (!bar || bar.locked) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragState.current = {
        barId,
        mode,
        origStartMin: bar.startMin,
        origEndMin: bar.endMin,
        origRowId: bar.rowId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        hasMoved: false,
      };
    },
    [bars, editable],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      if (!ds) return;
      const dx = e.clientX - ds.startClientX;
      const dy = e.clientY - ds.startClientY;
      if (!ds.hasMoved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      if (!ds.hasMoved) {
        ds.hasMoved = true;
        // Notifica il parent che è iniziato il drag (utile per highlight target)
        const draggedBar = bars.find(b => b.id === ds.barId);
        if (draggedBar) onBarDragStart?.(draggedBar);
      }

      const deltaMins = pxToMin(dx) - pxToMin(0);
      const duration = ds.origEndMin - ds.origStartMin;
      const minBound = minHour * 60;
      const maxBound = maxHour * 60;

      let newStart = ds.origStartMin;
      let newEnd = ds.origEndMin;
      let newRowId = ds.origRowId;

      if (ds.mode === "move") {
        newStart = snap(clamp(ds.origStartMin + deltaMins, minBound, maxBound - duration), snapMin);
        newEnd = newStart + duration;
        // Vertical row change
        const origRowIdx = rowIndex(ds.origRowId);
        const rowOffset = Math.round(dy / rowHeight);
        const newRowIdx = clamp(origRowIdx + rowOffset, 0, rows.length - 1);
        newRowId = rows[newRowIdx].id;
      } else if (ds.mode === "resize-left") {
        newStart = snap(clamp(ds.origStartMin + deltaMins, minBound, ds.origEndMin - snapMin), snapMin);
        newEnd = ds.origEndMin;
      } else {
        newStart = ds.origStartMin;
        newEnd = snap(clamp(ds.origEndMin + deltaMins, ds.origStartMin + snapMin, maxBound), snapMin);
      }

      setDragPreview({
        barId: ds.barId, startMin: newStart, endMin: newEnd, rowId: newRowId,
        collision: detectCollision(bars, ds.barId, newRowId, newStart, newEnd),
      });
    },
    [pxToMin, minHour, maxHour, snapMin, rowIndex, rows, rowHeight, bars, onBarDragStart],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const ds = dragState.current;
      dragState.current = null;
      if (!ds || !ds.hasMoved || !dragPreview) {
        setDragPreview(null);
        if (ds?.hasMoved) onBarDragEnd?.();
        return;
      }

      // ── Block drop if there's a collision ──
      if (dragPreview.collision) {
        setDragPreview(null);
        onBarDragEnd?.();
        return; // bar snaps back to original position
      }

      const change: GanttChange = {
        barId: ds.barId,
        fromRowId: ds.origRowId,
        toRowId: dragPreview.rowId,
        oldStartMin: ds.origStartMin,
        oldEndMin: ds.origEndMin,
        newStartMin: dragPreview.startMin,
        newEndMin: dragPreview.endMin,
      };

      const newBars = bars.map(b =>
        b.id === ds.barId
          ? { ...b, rowId: dragPreview.rowId, startMin: dragPreview.startMin, endMin: dragPreview.endMin }
          : b,
      );

      commitChange(newBars, change);
      setDragPreview(null);
      onBarDragEnd?.();
    },
    [bars, dragPreview, commitChange, onBarDragEnd],
  );

  // ── Hour markers ──
  const hourMarkers = useMemo(() => {
    const markers: { hour: number; px: number }[] = [];
    for (let h = minHour; h <= maxHour; h++) {
      markers.push({ hour: h, px: minToPx(h * 60) });
    }
    return markers;
  }, [minHour, maxHour, minToPx]);

  // ── Rows with bars ──
  const rowBarsMap = useMemo(() => {
    const map = new Map<string, GanttBar[]>();
    rows.forEach(r => map.set(r.id, []));
    bars.forEach(b => {
      const arr = map.get(b.rowId);
      if (arr) arr.push(b);
    });
    return map;
  }, [rows, bars]);

  // ── Render bar ──
  const renderBar = (bar: GanttBar, rIdx: number) => {
    const isBeingDragged = dragPreview?.barId === bar.id;
    const displayStart = isBeingDragged ? dragPreview!.startMin : bar.startMin;
    const displayEnd = isBeingDragged ? dragPreview!.endMin : bar.endMin;
    const displayRowId = isBeingDragged ? dragPreview!.rowId : bar.rowId;
    const displayRowIdx = rowIndex(displayRowId);

    const left = minToPx(displayStart);
    const width = Math.max(4, minToPx(displayEnd) - minToPx(displayStart));
    const isModified = modifiedIds.has(bar.id);

    const isColliding = isBeingDragged && dragPreview!.collision;
    const isSelected = activeSelectedBarId === bar.id;
    const barKind = (bar.meta?.type as string | undefined) ?? "";
    const canInlineActions = barKind === "deadhead" || barKind === "depot" || barKind === "pullout" || barKind === "pullin";

    // Build bar style
    let bgStyle: React.CSSProperties = { backgroundColor: bar.color, opacity: 0.85 };
    if (bar.style === "dashed") {
      bgStyle = { ...bgStyle, border: "1.5px dashed rgba(255,255,255,0.3)", opacity: 0.5 };
    } else if (bar.style === "striped") {
      bgStyle = {
        backgroundColor: "rgba(251,191,36,0.28)",
        border: "1.5px dashed #fbbf24",
        backgroundImage:
          "repeating-linear-gradient(90deg, rgba(251,191,36,0.08), rgba(251,191,36,0.08) 3px, rgba(251,191,36,0.22) 3px, rgba(251,191,36,0.22) 6px)",
        opacity: 0.95,
      };
    } else if (bar.style === "depot") {
      const isIntermediateDepot = barKind === "depot";
      const explicit = (bar.color && !bar.color.startsWith("rgba")) || isIntermediateDepot;
      bgStyle = {
        backgroundColor: isIntermediateDepot ? "rgba(245,158,11,0.34)" : (explicit ? bar.color : "rgba(255,255,255,0.05)"),
        border: isIntermediateDepot
          ? "1px solid rgba(245,158,11,0.95)"
          : (explicit ? "1px dashed rgba(255,255,255,0.4)" : "1px dashed rgba(255,255,255,0.15)"),
        opacity: explicit ? 0.85 : 1,
        backgroundImage: isIntermediateDepot
          ? "none"
          : "repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(255,255,255,0.18) 4px, rgba(255,255,255,0.18) 8px)",
      };
    }

    // Collision visual feedback: red ring + reduced opacity
    if (isColliding) {
      bgStyle = { ...bgStyle, opacity: 0.5 };
    }

    // Glow di compatibilità (es. quanti driver compatibili per quella corsa)
    if (bar.glow && !isBeingDragged) {
      bgStyle = {
        ...bgStyle,
        boxShadow: `0 0 0 1.5px ${bar.glow}, 0 0 8px 1px ${bar.glow}`,
      };
    }

    const top = isBeingDragged
      ? displayRowIdx * rowHeight + 4
      : rIdx * 0 + 4; // relative to row

    return (
      <div
        key={bar.id}
        className={`absolute flex items-center justify-center overflow-visible whitespace-nowrap text-[8px] text-white font-medium
          ${editable && !bar.locked ? "cursor-grab active:cursor-grabbing" : canInlineActions ? "cursor-pointer" : "cursor-default"}
          ${isBeingDragged
            ? isColliding
              ? "z-30 ring-2 ring-red-500 shadow-lg shadow-red-500/30"
              : "z-30 ring-2 ring-primary/60 shadow-lg"
            : isSelected
              ? "z-20"
              : "hover:brightness-125 hover:z-10"}
          transition-shadow`}
        style={{
          left,
          width,
          height: rowHeight - 8,
          top: isBeingDragged ? displayRowIdx * rowHeight + 4 : undefined,
          position: isBeingDragged ? "absolute" : undefined,
          borderRadius: 4,
          transform: isSelected ? "scale(1.02)" : undefined,
          boxShadow: isSelected
            ? "0 0 0 2px rgba(249,115,22,1), 0 0 10px rgba(249,115,22,0.45)"
            : bgStyle.boxShadow,
          ...bgStyle,
        }}
        onPointerDown={(e) => onPointerDown(e, bar.id, "move")}
        onClick={(e) => {
          e.stopPropagation();
          setSelectedBarId(bar.id);
          if (e.shiftKey && bar.meta?.type === "trip" && onBarContextMenu) {
            e.preventDefault();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const side = (e.clientX - rect.left) <= rect.width / 2 ? "left" : "right";
            onBarContextMenu(bar, { x: e.clientX, y: e.clientY, side });
            return;
          }
          // Click su QUALSIASI bar (anche locked): invoca callback custom — il parent
          // decide se gestire (es. apre dialog deadhead per bar locked).
          if (onBarClick && !dragState.current) {
            onBarClick(bar, { x: e.clientX, y: e.clientY });
          }
          // Pin tooltip on click for deadhead/depot entries and for trip suggestions.
          const canPin = canInlineActions || (editable && !bar.locked && !!getSuggestions);
          if (!canPin) return;
          if (dragState.current || modifiedIds.has(bar.id) === false && isBeingDragged) return;
          e.stopPropagation();
          setPinnedTooltip(prev => prev === bar.id ? null : bar.id);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const pRect = containerRef.current?.getBoundingClientRect();
          if (pRect) {
            setHoveredBar({
              bar,
              x: rect.left + rect.width / 2,
              y: rect.bottom + 4,
              anchorTop: rect.top,
            });
          }
        }}
        onMouseEnter={(e) => {
          if (dragState.current) return;
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const pRect = containerRef.current?.getBoundingClientRect();
          if (pRect) {
            setHoveredBar({
              bar,
              x: rect.left + rect.width / 2,
              y: rect.bottom + 4,
              anchorTop: rect.top,
            });
          }
        }}
        onMouseLeave={() => {
          if (pinnedTooltip === bar.id) return;
          setHoveredBar(null);
        }}
        onContextMenu={(e) => {
          if (!onBarContextMenu) return;
          e.preventDefault();
          setSelectedBarId(bar.id);
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const side = (e.clientX - rect.left) <= rect.width / 2 ? "left" : "right";
          onBarContextMenu(bar, { x: e.clientX, y: e.clientY, side });
        }}
      >
        {/* Resize handles */}
        {editable && !bar.locked && (
          <>
            <div
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 transition-colors rounded-l"
              onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, bar.id, "resize-left"); }}
              onContextMenu={(e) => {
                if (!onBarContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                setSelectedBarId(bar.id);
                onBarContextMenu(bar, { x: e.clientX, y: e.clientY, side: "left" });
              }}
            />
            <div
              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 transition-colors rounded-r"
              onPointerDown={(e) => { e.stopPropagation(); onPointerDown(e, bar.id, "resize-right"); }}
              onContextMenu={(e) => {
                if (!onBarContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                setSelectedBarId(bar.id);
                onBarContextMenu(bar, { x: e.clientX, y: e.clientY, side: "right" });
              }}
            />
          </>
        )}

        {/* Label */}
        {width > 30 && (
          <span className="px-1 truncate select-none pointer-events-none">
            {bar.label}
          </span>
        )}

        {/* Modified indicator */}
        {isModified && (
          <div className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full border border-background" title="Modificato" />
        )}
      </div>
    );
  };

  return (
    <div className="relative select-none" ref={containerRef}>
      <div ref={shellRef} className={isFullscreen ? "h-full p-3 bg-background" : ""}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-1 bg-muted/30 rounded-lg px-2 py-1">
          <button onClick={() => setZoom(z => Math.max(0.5, z - 0.25))} className="p-0.5 hover:bg-white/10 rounded" title="Zoom out">
            <ZoomOut className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.1}
            value={zoom}
            onChange={e => setZoom(parseFloat(e.target.value))}
            className="w-20 h-1 accent-orange-500 cursor-pointer"
            title="Slider zoom"
          />
          <span className="text-[10px] text-muted-foreground w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(4, z + 0.25))} className="p-0.5 hover:bg-white/10 rounded" title="Zoom in">
            <ZoomIn className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button onClick={() => setZoom(1)} className="p-0.5 hover:bg-white/10 rounded text-[9px] text-muted-foreground/80 px-1" title="Reset zoom (100%)">
            ⌂
          </button>
        </div>

        {editable && (
          <div className="flex items-center gap-1 bg-muted/30 rounded-lg px-2 py-1">
            <button
              onClick={undo}
              disabled={undoStack.length === 0}
              className="p-0.5 hover:bg-white/10 rounded disabled:opacity-30"
              title="Annulla (⌘Z)"
            >
              <Undo2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button
              onClick={redo}
              disabled={redoStack.length === 0}
              className="p-0.5 hover:bg-white/10 rounded disabled:opacity-30"
              title="Ripristina (⌘⇧Z)"
            >
              <Redo2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button
              onClick={resetAll}
              disabled={modifiedIds.size === 0}
              className="p-0.5 hover:bg-white/10 rounded disabled:opacity-30"
              title="Reset modifiche"
            >
              <RotateCcw className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        )}

        {modifiedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex items-center gap-1 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1"
          >
            <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
            <span className="text-[10px] text-amber-400 font-medium">{modifiedIds.size} modifiche</span>
          </motion.div>
        )}

        <button
          onClick={toggleFullscreen}
          className="ml-auto inline-flex items-center gap-1 bg-muted/30 rounded-lg px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          title={isFullscreen ? "Esci da tutto schermo" : "Apri a tutto schermo"}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          {isFullscreen ? "Riduci" : "Schermo intero"}
        </button>
      </div>

      {/* Chart area */}
      <div
        className={`overflow-x-auto overflow-y-auto border border-border/20 rounded-lg ${isFullscreen ? "h-[calc(100vh-88px)] max-h-none" : "max-h-[55vh]"}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
          e.preventDefault();
          const dir = e.deltaY > 0 ? -1 : 1;
          const scroller = e.currentTarget;
          const rect = scroller.getBoundingClientRect();
          const pointerXInScroller = e.clientX - rect.left;
          const timelinePointer = Math.max(0, scroller.scrollLeft + pointerXInScroller - labelWidth);

          setZoom(prevZoom => {
            const oldWidth = Math.max(800, totalRangeMin * prevZoom * 1.2);
            const nextZoom = clamp(Math.round((prevZoom + dir * 0.1) * 10) / 10, 0.5, 4);
            const newWidth = Math.max(800, totalRangeMin * nextZoom * 1.2);
            const ratio = oldWidth > 0 ? timelinePointer / oldWidth : 0;

            requestAnimationFrame(() => {
              const targetTimelineX = ratio * newWidth;
              const nextScrollLeft = labelWidth + targetTimelineX - pointerXInScroller;
              const maxScroll = Math.max(0, labelWidth + newWidth - scroller.clientWidth);
              scroller.scrollLeft = clamp(nextScrollLeft, 0, maxScroll);
            });

            return nextZoom;
          });
        }}
        onClick={() => setSelectedBarId(null)}
      >
        <div style={{ width: labelWidth + timelineWidthPx, minWidth: "100%" }}>
          {/* Time header */}
          <div className="flex sticky top-0 bg-background/90 backdrop-blur-sm z-20 border-b border-border/30">
            <div className="shrink-0 border-r border-border/20" style={{ width: labelWidth }} />
            <div className="relative" style={{ width: timelineWidthPx, height: 24 }}>
              {hourMarkers.map(({ hour, px }) => (
                <span
                  key={hour}
                  className="absolute text-[9px] text-muted-foreground select-none"
                  style={{ left: px, top: 4 }}
                >
                  {hour}:00
                </span>
              ))}
            </div>
          </div>

          {/* Rows */}
          {rows.map((row, ri) => {
            const rowBars = rowBarsMap.get(row.id) || [];
            const highlightBg = rowHighlights?.[row.id];
            return (
              <div
                key={row.id}
                className="flex group hover:bg-muted/20 transition-colors"
                style={{ height: rowHeight, backgroundColor: highlightBg }}
              >
                {/* Label */}
                <div
                  className={`shrink-0 flex items-center gap-1.5 px-2 text-[10px] font-mono border-r border-border/20 overflow-hidden ${rowsDraggable ? "cursor-grab active:cursor-grabbing" : ""}`}
                  style={{ width: labelWidth }}
                  draggable={rowsDraggable}
                  onDragStart={rowsDraggable ? (e) => {
                    e.dataTransfer.setData("application/x-cerbero-row", row.id);
                    e.dataTransfer.setData("text/plain", row.id);
                    e.dataTransfer.effectAllowed = "copy";
                  } : undefined}
                  title={rowsDraggable ? "Trascina nella Finestra di lavoro" : undefined}
                >
                  {editable && (
                    <GripVertical className="w-3 h-3 text-muted-foreground/30 shrink-0" />
                  )}
                  {row.dotColor && (
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: row.dotColor }}
                    />
                  )}
                  {editingRowId === row.id ? (
                    <input
                      autoFocus
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onBlur={() => {
                        const v = editingValue.trim();
                        if (v && v !== row.label) onRowRename?.(row.id, v);
                        setEditingRowId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const v = editingValue.trim();
                          if (v && v !== row.label) onRowRename?.(row.id, v);
                          setEditingRowId(null);
                        } else if (e.key === "Escape") {
                          setEditingRowId(null);
                        }
                      }}
                      className="flex-1 min-w-0 bg-background border border-primary/60 rounded px-1 text-[10px] font-mono focus:outline-none"
                    />
                  ) : (
                    <span
                      className={`truncate ${editable && onRowRename ? "cursor-text hover:text-primary" : ""}`}
                      title={editable && onRowRename ? "Doppio click per rinominare" : undefined}
                      onDoubleClick={() => {
                        if (!editable || !onRowRename) return;
                        setEditingValue(row.label);
                        setEditingRowId(row.id);
                      }}
                    >
                      {row.label}
                    </span>
                  )}
                  {row.sublabel && editingRowId !== row.id && (
                    <span className="text-muted-foreground text-[9px] shrink-0">({row.sublabel})</span>
                  )}
                  {editable && onRowRename && editingRowId !== row.id && (
                    <button
                      className="ml-auto shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                      title="Rinomina turno"
                      onClick={() => {
                        setEditingValue(row.label);
                        setEditingRowId(row.id);
                      }}
                    >
                      <Pencil className="w-2.5 h-2.5" />
                    </button>
                  )}
                </div>

                {/* Timeline */}
                <div className="relative flex-1" style={{ width: timelineWidthPx, height: rowHeight }}>
                  {/* Grid lines */}
                  {hourMarkers.map(({ hour, px }) => (
                    <div
                      key={hour}
                      className="absolute top-0 bottom-0 border-l border-border/10"
                      style={{ left: px }}
                    />
                  ))}
                  {/* Bars */}
                  {rowBars
                    .filter(b => !(dragPreview && dragPreview.barId === b.id && dragPreview.rowId !== b.rowId))
                    .map(b => renderBar(b, ri))}
                </div>
              </div>
            );
          })}

          {/* Dragged bar overlay (when moved to different row) */}
          {dragPreview && dragPreview.rowId !== dragState.current?.origRowId && (
            <div className="pointer-events-none absolute" style={{ top: 24, left: labelWidth }}>
              {bars
                .filter(b => b.id === dragPreview.barId)
                .map(b => renderBar(b, 0))}
            </div>
          )}
        </div>
      </div>

      {/* Tooltip */}
      <AnimatePresence>
        {hoveredBar && !dragState.current && (
          <motion.div
            ref={tooltipRef}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: tipPos ? 1 : 0, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className={`fixed z-[80] ${pinnedTooltip === hoveredBar.bar.id ? "pointer-events-auto" : "pointer-events-none"}`}
            style={{
              left: tipPos?.left ?? hoveredBar.x,
              top: tipPos?.top ?? hoveredBar.y,
              maxHeight: "calc(100vh - 24px)",
              overflowY: "auto",
            }}
            onMouseEnter={() => { /* keep open */ }}
          >
            <div className="bg-card border border-border rounded-lg shadow-xl p-3 min-w-[240px] max-w-[340px] text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: hoveredBar.bar.color }} />
                <span className="font-semibold">{hoveredBar.bar.label}</span>
                {modifiedIds.has(hoveredBar.bar.id) && (
                  <span className="text-[9px] text-amber-400 ml-auto">✏️ Modificato</span>
                )}
                {pinnedTooltip === hoveredBar.bar.id && (
                  <button
                    className="ml-auto p-0.5 hover:bg-muted rounded"
                    onClick={() => { setPinnedTooltip(null); setHoveredBar(null); }}
                    title="Chiudi"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="w-3 h-3" />
                <span>{minToStr(hoveredBar.bar.startMin)}</span>
                <ArrowRight className="w-3 h-3" />
                <span>{minToStr(hoveredBar.bar.endMin)}</span>
                <span className="text-[9px]">({hoveredBar.bar.endMin - hoveredBar.bar.startMin}′)</span>
              </div>
              {hoveredBar.bar.tooltip?.map((line, i) => (
                <div key={i} className="text-muted-foreground">{line}</div>
              ))}

              {(() => {
                const kind = (hoveredBar.bar.meta?.type as string | undefined) ?? "";
                const fromStop = (hoveredBar.bar.meta?.fromStop as string | undefined)?.trim();
                const toStop = (hoveredBar.bar.meta?.toStop as string | undefined)?.trim();
                if (kind !== "deadhead" && kind !== "depot" && kind !== "pullout" && kind !== "pullin") return null;
                return (
                  <>
                    {(fromStop || toStop) && (
                      <div className="pt-1 mt-1 border-t border-border/20 text-[11px] text-muted-foreground flex items-center gap-1.5">
                        <Navigation className="w-3 h-3" />
                        <span className="truncate">{fromStop || "—"}</span>
                        <ArrowRight className="w-3 h-3 shrink-0" />
                        <span className="truncate">{toStop || "—"}</span>
                      </div>
                    )}
                    <div className="pt-1 mt-1 border-t border-border/20 flex items-center justify-end gap-1.5">
                      <button
                        className="p-1 rounded hover:bg-muted/40 text-amber-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditSelectedBar?.(hoveredBar.bar);
                        }}
                        aria-label="Modifica"
                        title="Modifica"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        className="p-1 rounded hover:bg-red-500/20 text-red-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSelectedBar?.(hoveredBar.bar);
                        }}
                        aria-label="Elimina"
                        title="Elimina"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </>
                );
              })()}

              {/* Smart suggestions */}
              {editable && !hoveredBar.bar.locked && getSuggestions && (() => {
                const suggestions = getSuggestions(hoveredBar.bar).slice(0, 4);
                if (suggestions.length === 0) {
                  return (
                    <div className="text-[9px] text-muted-foreground/60 pt-1.5 mt-1.5 border-t border-border/20 flex items-center gap-1">
                      <Sparkles className="w-2.5 h-2.5" />
                      Nessun turno compatibile trovato
                    </div>
                  );
                }
                return (
                  <div className="pt-1.5 mt-1.5 border-t border-border/20 space-y-1">
                    <div className="flex items-center gap-1 text-[9px] text-muted-foreground font-semibold uppercase tracking-wide">
                      <Sparkles className="w-2.5 h-2.5 text-amber-400" />
                      Turni compatibili
                    </div>
                    {suggestions.map((s) => (
                      <button
                        key={s.rowId}
                        onClick={() => moveBarToRow(hoveredBar.bar.id, s.rowId)}
                        className="w-full flex items-center gap-2 text-left bg-muted/40 hover:bg-primary/20 border border-border/30 hover:border-primary/50 rounded px-1.5 py-1 transition-colors group"
                      >
                        <Move className="w-3 h-3 text-muted-foreground group-hover:text-primary shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] font-mono truncate">{s.label}</div>
                          {s.reason && (
                            <div className="text-[9px] text-muted-foreground truncate">{s.reason}</div>
                          )}
                        </div>
                        {s.detail && (
                          <span className="text-[9px] text-muted-foreground/60 shrink-0">{s.detail}</span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })()}

              {hoveredBar.bar.meta?.type === "trip" && onInsertDeadheadFromTrip && (
                <div className="pt-1.5 mt-1.5 border-t border-border/20 space-y-1">
                  <div className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wide">
                    Fuorilinea
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="flex-1 text-left bg-muted/40 hover:bg-orange-500/20 border border-border/30 hover:border-orange-500/50 rounded px-1.5 py-1 text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onInsertDeadheadFromTrip(hoveredBar.bar, "before", { x: hoveredBar.x, y: hoveredBar.y });
                      }}
                    >
                      ↝ Inserisci prima
                    </button>
                    <button
                      className="flex-1 text-left bg-muted/40 hover:bg-orange-500/20 border border-border/30 hover:border-orange-500/50 rounded px-1.5 py-1 text-[10px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onInsertDeadheadFromTrip(hoveredBar.bar, "after", { x: hoveredBar.x, y: hoveredBar.y });
                      }}
                    >
                      ↝ Inserisci dopo
                    </button>
                  </div>
                </div>
              )}

              {editable && !hoveredBar.bar.locked && (
                <div className="text-[9px] text-muted-foreground/50 pt-1 border-t border-border/20">
                  Trascina per spostare · Bordi per ridimensionare{getSuggestions ? " · Click per suggerimenti" : ""}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
