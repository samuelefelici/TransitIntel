/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — assegnazione turni guida al personale viaggiante (2 finestre)
 * ───────────────────────────────────────────────────────────────────────────
 * A sinistra il tabellone (operatori × giorni). A destra i turni SCOPERTI per
 * giorno. Per assegnare: seleziona un turno a destra → Q (taglia), seleziona
 * un conducente a sinistra → W (incolla): il turno va nel giorno giusto perché
 * la tabella ha una colonna per ogni giorno. Click su un turno assegnato per
 * rimuoverlo. Anagrafica conducente completa via la matita.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Loader2,
  UserPlus, Users, Pencil, Scissors, ClipboardPaste, Ban, Clock, ChevronDown,
  Eraser, Check, Maximize2, RotateCcw, Cpu, Printer, Eye, Plus, Wand2, Trash2, X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import DriverEditDialog, { type RosterDriver } from "@/components/roster/DriverEditDialog";
import { AbilitazioneBadges } from "@/components/roster/abilitazioni";
import { RotazioneRiposiCreateDialog, RotazioniRiposiListDialog, AssegnaRotazioniDialog, GeneraRiposiDialog } from "@/components/roster/RotazioniRiposi";

/* ─── Tipi (allineati a /api/roster/*) ─── */
interface DutySegment {
  type: string; line: string | null;
  startTime: string | null; startPlace: string | null;
  endTime: string | null; endPlace: string | null;
}
interface RosterDuty {
  code: string; type: string | null; start: string | null; end: string | null;
  nastro: string | null; work: string | null;
  interruption: string | null; ripreseCount: number; tripsCount: number; costEuro: number | null;
  residenzaName?: string | null; residenzaColor?: string | null;
  segments?: DutySegment[];
}
/** Snapshot minimo del turno al momento dell'assegnazione (P6): lo storico
 *  resta leggibile anche se il DSS viene versionato o il duty rinumerato. */
interface DutySnapshot { start?: string | null; end?: string | null; paidHours?: unknown; name?: string | null }
interface RosterAssignment { id: string; driverId: string; day: string; dutyCode: string; dssId: string; snapshot?: DutySnapshot | null }
interface RosterEntry { id: string; driverId: string; day: string; category: "assenza" | "presenza"; code: string }
interface VoceDef { code: string; label: string }
type VociCatalog = { assenza: VoceDef[]; presenza: VoceDef[] };
interface ArmedVoce { category: "assenza" | "presenza"; code: string; label: string }
/** Stile chip voce nel menu della toolbar (solo lì usiamo lo sfondo colorato). */
function voceStyle(cat: "assenza" | "presenza"): string {
  return cat === "assenza"
    ? "bg-rose-500/20 text-rose-200 border border-rose-500/40"
    : "bg-sky-500/20 text-sky-200 border border-sky-500/40";
}
/** Colore della SIGLA nella cella (niente card): assenze in rosso, Riposo in
 *  blu, attività (presenze) in neutro/"nero". */
function voceTextColor(cat: "assenza" | "presenza", code: string): string {
  if (cat === "assenza") return code === "R" ? "text-blue-400" : "text-rose-500";
  return "text-slate-100";
}
interface DutySource {
  dssId: string; name: string; scenarioName: string | null;
  scenarioDate: string | null; dutyCount: number; createdAt: string;
  isOperational?: boolean; validityUnitName?: string | null;
}
interface Board {
  from: string; days: string[]; drivers: RosterDriver[];
  duties: RosterDuty[]; assignments: RosterAssignment[];
  entries?: RosterEntry[];
  /** residenza di servizio (deposito) dello scenario → colore dei turni */
  residenza?: { name: string; color: string } | null;
  /** Modalità AUTO (dssId="auto"): duty raggruppati per DSS + DSS competente per giorno */
  dutiesByDss?: Record<string, RosterDuty[]>;
  dssByDay?: Record<string, string | null>;
}

const DUTY_TYPE_COLOR: Record<string, string> = {
  intero: "#10b981", semiunico: "#38bdf8", spezzato: "#f59e0b", supplemento: "#a78bfa",
};
function dutyColor(type: string | null): string {
  return DUTY_TYPE_COLOR[String(type ?? "").toLowerCase()] ?? "#64748b";
}
function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - dow);
  return x.toISOString().slice(0, 10);
}
function shiftDate(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
function dayLabel(iso: string): { dow: string; dm: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    dow: d.toLocaleDateString("it-IT", { weekday: "short", timeZone: "UTC" }),
    dm: d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", timeZone: "UTC" }),
  };
}
function driverLabel(d: RosterDriver): string {
  return [d.cognome, d.nome].filter(Boolean).join(" ") || d.name;
}
/** Pasqua (algoritmo di Meeus/Gauss) → ISO YYYY-MM-DD per l'anno dato. */
function computusEaster(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
/** Festività nazionali italiane (giorno-mese fissi). */
const FIXED_HOLIDAYS = new Set(["01-01", "01-06", "04-25", "05-01", "06-02", "08-15", "11-01", "12-08", "12-25", "12-26"]);
const _easterCache: Record<number, string> = {};
/** Livello festivo di un giorno: 2 = festività, 1 = domenica, 0 = feriale. */
function festLevel(iso: string): 0 | 1 | 2 {
  const dt = new Date(`${iso}T00:00:00Z`);
  if (FIXED_HOLIDAYS.has(iso.slice(5))) return 2;
  const year = dt.getUTCFullYear();
  const easter = _easterCache[year] ?? (_easterCache[year] = computusEaster(year));
  if (iso === easter || iso === shiftDate(easter, 1)) return 2; // Pasqua + Pasquetta
  if (dt.getUTCDay() === 0) return 1; // domenica
  return 0;
}
/** Sfondo rosso per le colonne festive (festività marcata, domenica più tenue). */
function festBg(iso: string): string {
  const lvl = festLevel(iso);
  return lvl === 2 ? "bg-rose-500/20" : lvl === 1 ? "bg-rose-500/10" : "";
}
/** Avatar del conducente: foto se presente, altrimenti iniziali. size=0 → nascosto. */
function DriverAvatar({ drv, size = 28 }: { drv: RosterDriver; size?: number }) {
  if (!size) return null;
  const initials = (drv.cognome ?? drv.name ?? "?").trim().slice(0, 2).toUpperCase() || "?";
  const st = { width: size, height: size };
  return drv.photoUrl ? (
    <img src={drv.photoUrl} alt="" style={st} className="rounded-full object-cover border border-slate-700 shrink-0" />
  ) : (
    <span style={st} className="rounded-full bg-slate-800 border border-slate-700 text-[9px] font-bold text-slate-400 flex items-center justify-center shrink-0">{initials}</span>
  );
}

export default function RosterPage() {
  const qc = useQueryClient();
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const psProjectId = urlParams.get("psProjectId") ?? "";
  const [from, setFrom] = useState(() => mondayOf(new Date()));
  const [dssId, setDssId] = useState("");
  const [operationalOnly, setOperationalOnly] = useState(urlParams.get("operational") === "1");

  // selezioni + appunti (taglia/incolla)
  const [selDuty, setSelDuty] = useState<{ day: string; code: string } | null>(null);
  const [selDriver, setSelDriver] = useState<string | null>(null);
  const [cut, setCut] = useState<{ day: string; code: string } | null>(null);
  const [editDriver, setEditDriver] = useState<RosterDriver | null | "new">(null);

  const sourcesQ = useQuery({
    queryKey: ["roster", "sources", operationalOnly, psProjectId],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (operationalOnly) qs.set("operationalOnly", "1");
      if (psProjectId) qs.set("psProjectId", psProjectId);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return apiFetch<{ sources: DutySource[] }>(`/api/roster/duty-sources${suffix}`);
    },
  });

  // Vista a più settimane: il tabellone scorre orizzontalmente (barra di
  // scorrimento) invece di navigare una settimana alla volta.
  const RANGE_DAYS = 28;
  const boardQ = useQuery({
    queryKey: ["roster", "board", from, dssId],
    queryFn: () => apiFetch<Board>(`/api/roster/board?from=${from}&days=${RANGE_DAYS}${dssId ? `&dssId=${dssId}` : ""}`),
  });
  const invalidateBoard = () => qc.invalidateQueries({ queryKey: ["roster", "board"] });

  // Scroll orizzontale sincronizzato: tabellone (sopra) ↔ turni scoperti (sotto).
  // Sincronizzazione proporzionale (larghezze diverse), con lock anti-loop.
  const boardScrollRef = useRef<HTMLDivElement>(null);
  const uncoveredScrollRef = useRef<HTMLDivElement>(null);
  const scrollLock = useRef(false);
  const mirrorScroll = (from: "board" | "unc") => {
    const src = from === "board" ? boardScrollRef.current : uncoveredScrollRef.current;
    const dst = from === "board" ? uncoveredScrollRef.current : boardScrollRef.current;
    if (!src || !dst || scrollLock.current) return;
    const sMax = src.scrollWidth - src.clientWidth;
    const dMax = dst.scrollWidth - dst.clientWidth;
    if (sMax <= 0 || dMax <= 0) return;
    scrollLock.current = true;
    dst.scrollLeft = (src.scrollLeft / sMax) * dMax;
    requestAnimationFrame(() => { scrollLock.current = false; });
  };

  const seedMut = useMutation({
    mutationFn: () => apiFetch<{ created: number }>("/api/roster/drivers/seed", { method: "POST", body: JSON.stringify({ count: 30 }) }),
    onSuccess: (r) => { toast.success(`${r.created} operatori fittizi creati`); qc.invalidateQueries({ queryKey: ["roster"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const assignMut = useMutation({
    mutationFn: (input: { driverId: string; day: string; dutyCode: string; dssId: string }) =>
      apiFetch("/api/roster/assignments", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => { setCut(null); setSelDuty(null); invalidateBoard(); },
    onError: (e: Error) => toast.error("Assegnazione fallita", { description: e.message }),
  });
  const unassignMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/roster/assignments/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateBoard(),
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Voci Assenza / Presenza ──
  const vociQ = useQuery({
    queryKey: ["roster", "voci"],
    queryFn: () => apiFetch<{ catalog: VociCatalog }>("/api/roster/voci").then((r) => r.catalog),
  });
  const [armedVoce, setArmedVoce] = useState<ArmedVoce | null>(null);
  const [voceMenu, setVoceMenu] = useState<"assenza" | "presenza" | null>(null);
  const addEntryMut = useMutation({
    mutationFn: (i: { driverId: string; day: string; category: string; code: string }) =>
      apiFetch("/api/roster/entries", { method: "POST", body: JSON.stringify(i) }),
    onSuccess: () => invalidateBoard(),
    onError: (e: Error) => toast.error("Inserimento voce fallito", { description: e.message }),
  });
  const delEntryMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/roster/entries/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateBoard(),
  });
  const placeVoce = (driverId: string, day: string) => {
    if (!armedVoce) return;
    addEntryMut.mutate({ driverId, day, category: armedVoce.category, code: armedVoce.code });
  };

  // ── Gomma: cancella turno + voci di una cella (il turno torna fra gli scoperti) ──
  const [eraser, setEraser] = useState(false);
  const [showUncovered, setShowUncovered] = useState(true); // finestra turni scoperti (in basso)
  const [rotDialog, setRotDialog] = useState<"create-riposi" | "list-riposi" | "assegna" | "genera-riposi" | null>(null);
  // Se una cella ha ≥2 attività, la gomma chiede QUALE togliere.
  const [eraseChoice, setEraseChoice] = useState<{ driverId: string; day: string } | null>(null);
  const removeOne = (it: { kind: "duty"; a: RosterAssignment } | { kind: "voce"; en: RosterEntry }) => {
    if (it.kind === "duty") unassignMut.mutate(it.a.id); else delEntryMut.mutate(it.en.id);
  };
  const eraseCell = (driverId: string, day: string) => {
    const assigns = assignmentsByCell.get(`${driverId}|${day}`) ?? [];
    const entries = entriesByCell.get(`${driverId}|${day}`) ?? [];
    const total = assigns.length + entries.length;
    if (total === 0) return;
    if (total === 1) { // una sola attività → togli subito
      if (assigns[0]) unassignMut.mutate(assigns[0].id); else delEntryMut.mutate(entries[0]!.id);
      return;
    }
    setEraseChoice({ driverId, day }); // ≥2 → scegli quale
  };

  // ── Dimensione celle (Visualizza) ──
  const [cellSize, setCellSize] = useState<"small" | "medium" | "large">(() => {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem("roster.cellSize") : null;
    return v === "small" || v === "large" ? v : "medium";
  });
  useEffect(() => { try { localStorage.setItem("roster.cellSize", cellSize); } catch { /* noop */ } }, [cellSize]);

  // ── Menu della toolbar + tooltip dettaglio turno (tasto destro) ──
  const [openTopMenu, setOpenTopMenu] = useState<string | null>(null);
  const [ctxDuty, setCtxDuty] = useState<{ x: number; y: number; duty: RosterDuty } | null>(null);
  const openDutyContext = (e: ReactMouseEvent, duty: RosterDuty | undefined) => {
    if (!duty) return;
    e.preventDefault();
    setCtxDuty({ x: e.clientX, y: e.clientY, duty });
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
    setOpenTopMenu(null);
  };

  const board = boardQ.data;
  const isAuto = dssId === "auto";
  const dutyByCode = useMemo(() => new Map((board?.duties ?? []).map((d) => [d.code, d])), [board?.duties]);
  /** Dettaglio turno di un'assegnazione: in AUTO cerca nel DSS dell'assegnazione
   *  (dutiesByDss) e in ultima istanza ricostruisce dallo snapshot salvato. */
  const dutyFor = (a: RosterAssignment): RosterDuty | undefined => {
    if (isAuto) {
      const d = board?.dutiesByDss?.[a.dssId]?.find((x) => x.code === a.dutyCode);
      if (d) return d;
      if (a.snapshot) {
        return {
          code: a.dutyCode, type: null, start: a.snapshot.start ?? null, end: a.snapshot.end ?? null,
          nastro: null, work: null, interruption: null, ripreseCount: 0, tripsCount: 0, costEuro: null,
        };
      }
      return undefined;
    }
    return dutyByCode.get(a.dutyCode);
  };
  const assignmentsByCell = useMemo(() => {
    const m = new Map<string, RosterAssignment[]>();
    for (const a of board?.assignments ?? []) {
      const k = `${a.driverId}|${a.day}`;
      const arr = m.get(k); if (arr) arr.push(a); else m.set(k, [a]);
    }
    return m;
  }, [board?.assignments]);
  const entriesByCell = useMemo(() => {
    const m = new Map<string, RosterEntry[]>();
    for (const e of board?.entries ?? []) {
      const k = `${e.driverId}|${e.day}`;
      const arr = m.get(k); if (arr) arr.push(e); else m.set(k, [e]);
    }
    return m;
  }, [board?.entries]);
  const uncoveredByDay = useMemo(() => {
    const m = new Map<string, RosterDuty[]>();
    if (!board) return m;
    for (const day of board.days) {
      // In AUTO i turni del giorno sono quelli del DSS competente per QUELLA
      // data (dssByDay, dai periodi P5); coprono solo le assegnazioni sul
      // medesimo DSS — un turno omonimo del DSS vecchio non copre il nuovo.
      const competent = isAuto ? (board.dssByDay?.[day] ?? null) : null;
      const dayDuties = isAuto
        ? (competent ? board.dutiesByDss?.[competent] ?? [] : [])
        : board.duties;
      const taken = new Set(board.assignments
        .filter((a) => a.day === day && (!isAuto || a.dssId === competent))
        .map((a) => a.dutyCode));
      m.set(day, dayDuties.filter((d) => !taken.has(d.code)));
    }
    return m;
  }, [board, isAuto]);

  // ── Taglia/incolla via tastiera: Q = taglia turno selezionato, W = incolla sul conducente ──
  function doPaste() {
    if (!cut) { toast.info("Prima seleziona un turno e premi Q (taglia)"); return; }
    if (!selDriver) { toast.info("Seleziona un conducente a sinistra"); return; }
    // In AUTO l'assegnazione va sul DSS competente per la data del turno.
    const effDss = isAuto ? (board?.dssByDay?.[cut.day] ?? null) : dssId;
    if (!effDss) { toast.error("Nessun turno guida competente per questa data (periodo di validità mancante)"); return; }
    // Un conducente può avere più turni nello stesso giorno: nessun blocco.
    assignMut.mutate({ driverId: selDriver, day: cut.day, dutyCode: cut.code, dssId: effDss });
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (k === "q") { e.preventDefault(); if (selDuty) { setCut(selDuty); toast.success(`Turno ${selDuty.code} in taglio — scegli un conducente e premi W`); } }
      else if (k === "w") { e.preventDefault(); doPaste(); }
      else if (e.key === "Escape") { setCut(null); setArmedVoce(null); setVoceMenu(null); setEraser(false); setOpenTopMenu(null); setCtxDuty(null); setEraseChoice(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selDuty, selDriver, cut]); // eslint-disable-line react-hooks/exhaustive-deps

  // colore turno: residenza per-turno (deposito del turno) → residenza scenario → tipo
  const resColor = (duty: RosterDuty | null | undefined) =>
    duty?.residenzaColor ?? board?.residenza?.color ?? dutyColor(duty?.type ?? null);

  const menuItemCls = "w-full text-left px-2.5 py-1.5 rounded text-xs text-slate-200 hover:bg-slate-800 flex items-center gap-2";
  const menuDisabledCls = "w-full text-left px-2.5 py-1.5 rounded text-xs text-slate-600 cursor-not-allowed flex items-center gap-2";
  // dimensione celle (Visualizza) — compatte per vedere più autisti/giorni
  const showTimes = cellSize !== "small";   // orari solo da Media in su
  const showExtra = cellSize === "large";   // dettagli extra solo in Grande
  const dutyBigCls = cellSize === "small" ? "px-0.5 py-0 text-[9px]" : cellSize === "large" ? "px-1 py-1 text-[11px]" : "px-1 py-0.5 text-[10px]";
  const voceBigCls = cellSize === "small" ? "text-[11px]" : cellSize === "large" ? "text-lg py-0.5" : "text-sm py-0.5";
  const emptyH = cellSize === "small" ? "h-4" : cellSize === "large" ? "h-8" : "h-6";
  const dayColW = cellSize === "small" ? "min-w-[52px]" : cellSize === "large" ? "min-w-[104px]" : "min-w-[76px]";
  // La card del conducente mostra SEMPRE gli stessi dati: la vista "solo codice"
  // rende compatte solo le celle-giorno, non l'anagrafica di sinistra.
  const nameColW = "min-w-[188px]";
  const avatarSize = 24;

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* ── Toolbar software (menu) ── */}
      <div className="h-9 bg-slate-900 border-b border-slate-800 flex items-center px-2 gap-0.5 shrink-0 text-xs relative z-40">
        {([
          ["Rotazioni", RotateCcw], ["Algoritmi", Cpu], ["Stampe", Printer], ["Visualizza", Eye],
        ] as const).map(([m, Icon]) => (
          <div key={m} className="relative">
            <button onClick={() => setOpenTopMenu(openTopMenu === m ? null : m)}
              className={`px-3 py-1 rounded inline-flex items-center gap-1.5 ${openTopMenu === m ? "bg-slate-800 text-violet-300" : "text-slate-300 hover:bg-slate-800/60"}`}>
              <Icon className="w-3.5 h-3.5" /> {m}
            </button>
            {openTopMenu === m && (
              <div className="absolute left-0 top-full mt-0.5 min-w-56 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl p-1 z-50">
                {m === "Rotazioni" && (
                  <>
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-slate-500">Rotazione riposi</div>
                    <button className={menuItemCls} onClick={() => { setOpenTopMenu(null); setRotDialog("create-riposi"); }}>
                      <Plus className="w-3.5 h-3.5" /> Crea rotazione riposi
                    </button>
                    <button className={menuItemCls} onClick={() => { setOpenTopMenu(null); setRotDialog("list-riposi"); }}>
                      <CalendarDays className="w-3.5 h-3.5" /> Elenco rotazioni riposi
                    </button>
                    <button className={menuItemCls} onClick={() => { setOpenTopMenu(null); setRotDialog("assegna"); }}>
                      <Users className="w-3.5 h-3.5" /> Assegna rotazioni
                    </button>
                    <div className="border-t border-slate-800 my-1" />
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-slate-500">Rotazione turni</div>
                    <button className={menuDisabledCls} disabled>Crea rotazione turni · prossimamente</button>
                  </>
                )}
                {m === "Algoritmi" && (
                  <>
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-slate-500">Assegna cadenze</div>
                    <button className={menuItemCls} onClick={() => { setOpenTopMenu(null); setRotDialog("genera-riposi"); }}>
                      <Wand2 className="w-3.5 h-3.5" /> Assegna cadenze → Riposi
                    </button>
                    <div className="border-t border-slate-800 my-1" />
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-slate-500">Assegnazione automatica</div>
                    <button className={menuDisabledCls} disabled>Copri gli scoperti · prossimamente</button>
                    <button className={menuDisabledCls} disabled>Bilancia i carichi · prossimamente</button>
                  </>
                )}
                {m === "Stampe" && (
                  <button className={menuItemCls} onClick={() => { setOpenTopMenu(null); window.print(); }}>
                    <Printer className="w-3.5 h-3.5" /> Stampa tabellone
                  </button>
                )}
                {m === "Visualizza" && (
                  <>
                    <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-slate-500">Dimensione celle</div>
                    {([
                      ["small", "Piccola — solo codice"], ["medium", "Media — con orari"], ["large", "Grande — con dettagli"],
                    ] as const).map(([k, label]) => (
                      <button key={k} className={menuItemCls} onClick={() => { setCellSize(k); setOpenTopMenu(null); }}>
                        <span className="flex-1">{label}</span>
                        {cellSize === k && <Check className="w-3.5 h-3.5 text-violet-400" />}
                      </button>
                    ))}
                    <div className="border-t border-slate-800 my-1" />
                    <button className={menuItemCls} onClick={toggleFullscreen}>
                      <Maximize2 className="w-3.5 h-3.5" /> Schermo intero
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        <span className="ml-auto pr-2 text-[10px] text-slate-500">Roster · vista operativa</span>
      </div>
      {openTopMenu && <div className="fixed inset-0 z-30" onClick={() => setOpenTopMenu(null)} />}

      {/* ── Barra comandi ── */}
      <div className="border-b border-slate-800 bg-slate-900 px-4 py-2.5 flex flex-wrap items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-violet-400" />
          <span className="font-bold text-sm">Roster · Personale Viaggiante</span>
        </div>
        <select
          value={dssId}
          onChange={(e) => setDssId(e.target.value)}
          className="min-w-64 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-sm outline-none focus:border-violet-500"
        >
          <option value="">— Fonte turni (DSS) —</option>
          <option value="auto">🗓 Auto — DSS per data (periodi di validità)</option>
          {sourcesQ.data?.sources.map((s) => (
            <option key={s.dssId} value={s.dssId}>
              {s.isOperational ? "● " : ""}{s.validityUnitName ? `${s.validityUnitName} · ` : ""}{s.name} · {s.dutyCount} turni
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap cursor-pointer">
          <input type="checkbox" checked={operationalOnly} onChange={(e) => { setOperationalOnly(e.target.checked); setDssId(""); }} className="accent-emerald-500" />
          Solo in esercizio
        </label>
        {board?.residenza && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-300 whitespace-nowrap" title="Residenza di servizio (deposito) — colore dei turni">
            <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: board.residenza.color }} />
            {board.residenza.name}
          </span>
        )}
        <div className="flex items-center gap-1 rounded-lg border border-slate-700 px-1 py-0.5">
          <button onClick={() => setFrom(shiftDate(from, -RANGE_DAYS))} className="p-1.5 rounded hover:bg-white/10" title="Periodo precedente"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-xs font-mono px-2 flex items-center gap-1.5"><CalendarDays className="w-3.5 h-3.5 text-violet-400" />{dayLabel(from).dm} – {dayLabel(shiftDate(from, RANGE_DAYS - 1)).dm}</span>
          <button onClick={() => setFrom(shiftDate(from, RANGE_DAYS))} className="p-1.5 rounded hover:bg-white/10" title="Periodo successivo"><ChevronRight className="w-4 h-4" /></button>
          <button onClick={() => setFrom(mondayOf(new Date()))} className="text-[11px] px-2 py-1 rounded hover:bg-white/10 text-slate-300" title="Torna a oggi">Oggi</button>
        </div>
        <span className="text-[10px] text-slate-500 hidden xl:inline">← scorri il tabellone per vedere le {RANGE_DAYS} giornate</span>

        {/* Voci Assenza / Presenza: scegli una voce → clicca una cella per inserirla */}
        {(["assenza", "presenza"] as const).map((cat) => (
          <div key={cat} className="relative">
            <button
              onClick={() => setVoceMenu(voceMenu === cat ? null : cat)}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${
                cat === "assenza"
                  ? "border-rose-500/40 text-rose-200 bg-rose-500/10 hover:bg-rose-500/20"
                  : "border-sky-500/40 text-sky-200 bg-sky-500/10 hover:bg-sky-500/20"
              }`}
            >
              {cat === "assenza" ? <Ban className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
              {cat === "assenza" ? "Assenza" : "Presenza"}
              <ChevronDown className="w-3 h-3" />
            </button>
            {voceMenu === cat && (
              <div className="absolute z-30 mt-1 left-0 w-60 rounded-lg border border-slate-700 bg-slate-900 shadow-2xl p-1">
                {(vociQ.data?.[cat] ?? []).map((v) => (
                  <button key={v.code}
                    onClick={() => { setArmedVoce({ category: cat, code: v.code, label: v.label }); setVoceMenu(null); setEraser(false); }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-slate-800"
                  >
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${voceStyle(cat)}`}>{v.code}</span>
                    <span className="text-xs text-slate-300">{v.label}</span>
                  </button>
                ))}
                {(vociQ.data?.[cat] ?? []).length === 0 && <p className="text-[11px] text-slate-500 px-2 py-1.5">Caricamento…</p>}
              </div>
            )}
          </div>
        ))}

        <button
          onClick={() => { setEraser((v) => !v); setArmedVoce(null); setVoceMenu(null); }}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${
            eraser ? "border-rose-500 bg-rose-500/20 text-rose-100" : "border-slate-700 text-slate-300 hover:bg-slate-800"
          }`}
          title="Gomma: cancella turno e voci da una cella (il turno torna fra gli scoperti)"
        >
          <Eraser className="w-3.5 h-3.5" /> Gomma
        </button>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden lg:flex items-center gap-1 text-[10px] text-slate-500"><Scissors className="w-3 h-3" /> Q taglia · <ClipboardPaste className="w-3 h-3" /> W incolla</span>
          <button onClick={() => setEditDriver("new")} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium">
            <UserPlus className="w-3.5 h-3.5" /> Conducente
          </button>
          <button onClick={() => seedMut.mutate()} disabled={seedMut.isPending} className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs disabled:opacity-50">
            +30 fittizi
          </button>
        </div>
      </div>

      {/* appunti attivo */}
      {cut && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-1.5 text-[11px] text-amber-200 flex items-center gap-2 shrink-0">
          <Scissors className="w-3.5 h-3.5" /> In taglio: <b>{cut.code}</b> · {dayLabel(cut.day).dow} {dayLabel(cut.day).dm} — seleziona un conducente e premi <b>W</b> (Esc per annullare)
        </div>
      )}

      {/* voce armata: clicca una cella per inserirla */}
      {armedVoce && (
        <div className={`border-b px-4 py-1.5 text-[11px] flex items-center gap-2 shrink-0 ${
          armedVoce.category === "assenza" ? "bg-rose-500/15 border-rose-500/30 text-rose-200" : "bg-sky-500/15 border-sky-500/30 text-sky-200"
        }`}>
          {armedVoce.category === "assenza" ? <Ban className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
          Inserimento voce: <b>{armedVoce.code}</b> ({armedVoce.label}) — <b>clicca una cella</b> del tabellone. Esc per annullare.
          <button onClick={() => setArmedVoce(null)} className="ml-auto underline hover:no-underline">Annulla</button>
        </div>
      )}

      {/* gomma attiva */}
      {eraser && (
        <div className="bg-rose-500/10 border-b border-rose-500/30 px-4 py-1.5 text-[11px] text-rose-100 flex items-center gap-2 shrink-0">
          <Eraser className="w-3.5 h-3.5" /> Gomma attiva — <b>clicca una cella</b> per cancellarne turno e voci (il turno torna fra gli scoperti). Esc per uscire.
          <button onClick={() => setEraser(false)} className="ml-auto underline hover:no-underline">Chiudi</button>
        </div>
      )}

      {/* ── Tabellone (sopra) + turni scoperti (finestra in basso) ── */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Tabellone a tutta larghezza */}
        <div ref={boardScrollRef} onScroll={() => mirrorScroll("board")} className="flex-1 min-w-0 overflow-auto">
          {boardQ.isLoading ? (
            <div className="p-10 text-center text-slate-500 text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico il tabellone…</div>
          ) : !board || board.drivers.length === 0 ? (
            <div className="p-10 text-center text-slate-500 text-sm">Nessun conducente. Aggiungine uno o genera operatori fittizi.</div>
          ) : (
            <table className="min-w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-slate-900 z-30">
                <tr>
                  <th className={`text-left px-2 py-1 border-b border-slate-800 sticky left-0 z-20 bg-slate-900 ${nameColW}`}>Conducente</th>
                  {board.days.map((day) => {
                    const { dow, dm } = dayLabel(day);
                    const unc = uncoveredByDay.get(day)?.length ?? 0;
                    return (
                      <th key={day} className={`px-1 py-1 border-b border-slate-800 text-center ${dayColW} ${festBg(day)}`}>
                        <span className={`uppercase text-[9px] ${festLevel(day) ? "text-rose-300/80" : "text-slate-500"}`}>{dow} </span>
                        <span className="font-semibold text-[11px]">{dm}</span>
                        {dssId && cellSize !== "small" && (
                          isAuto && !board?.dssByDay?.[day]
                            ? <span className="block text-[9px] font-mono text-slate-600">—</span>
                            : <span className={`block text-[9px] font-mono ${unc > 0 ? "text-amber-400" : "text-emerald-400"}`}>{unc > 0 ? `${unc} scoperti` : "coperto"}</span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {board.drivers.map((drv) => {
                  const isSel = selDriver === drv.id;
                  return (
                    <tr key={drv.id} className={isSel ? "bg-violet-500/10" : "odd:bg-white/[0.02]"}>
                      <td className={`px-2 py-0.5 border-b border-slate-800/40 sticky left-0 z-20 cursor-pointer ${isSel ? "bg-violet-950" : "bg-slate-950"}`}
                          onClick={() => setSelDriver(isSel ? null : drv.id)}>
                        <div className="flex items-center gap-1.5">
                          <DriverAvatar drv={drv} size={avatarSize} />
                          <div className="min-w-0 flex-1">
                            {/* Nome su riga propria (meno troncato); matricola e simboli sotto */}
                            <div className="font-medium truncate text-[12px] leading-tight">{driverLabel(drv)}</div>
                            <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 mt-0.5">
                              {drv.matricola && <span className="text-[9px] font-mono text-slate-500">{drv.matricola}</span>}
                              {drv.isFictitious && <span className="text-[7px] px-1 rounded bg-violet-500/15 text-violet-300">fittizio</span>}
                              {drv.abilitazioni?.length > 0 && <AbilitazioneBadges keys={drv.abilitazioni} size={9} />}
                            </div>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); setEditDriver(drv); }} className="p-0.5 rounded text-slate-500 hover:text-violet-300 shrink-0" title="Anagrafica conducente"><Pencil className="w-3 h-3" /></button>
                        </div>
                      </td>
                      {board.days.map((day) => {
                        const cellAssigns = assignmentsByCell.get(`${drv.id}|${day}`) ?? [];
                        const cellEntries = entriesByCell.get(`${drv.id}|${day}`) ?? [];
                        // una cella può contenere PIÙ turni + voci; il PRIMO è primario (grande).
                        const items: Array<{ kind: "duty"; a: RosterAssignment } | { kind: "voce"; en: RosterEntry }> = [
                          ...cellAssigns.map((a) => ({ kind: "duty" as const, a })),
                          ...cellEntries.map((en) => ({ kind: "voce" as const, en })),
                        ];
                        const hasItems = items.length > 0;
                        const cellClick = eraser ? () => eraseCell(drv.id, day)
                          : armedVoce ? () => placeVoce(drv.id, day)
                          : () => { setSelDriver(drv.id); if (cut && cut.day === day) doPaste(); };
                        return (
                          <td key={day}
                            onClick={cellClick}
                            className={`px-0.5 py-0.5 border-b border-slate-800/40 text-center align-middle ${festBg(day)} ${
                              armedVoce ? "cursor-crosshair hover:bg-white/[0.04]" : eraser ? "cursor-pointer hover:bg-rose-500/10" : ""
                            }`}>
                            <div className={armedVoce || eraser ? "pointer-events-none" : ""}>
                              {!hasItems ? (
                                <div className={`${emptyH} rounded border border-dashed flex items-center justify-center text-xs ${
                                  cut && cut.day === day && isSel ? "border-amber-500/70 bg-amber-500/10 text-amber-300" : "border-slate-800/50 text-slate-700"
                                }`}>{cut && cut.day === day ? "↵" : ""}</div>
                              ) : (
                                <div className="space-y-0.5">
                                  {items.map((it, idx) => {
                                    const big = idx === 0;
                                    if (it.kind === "duty") {
                                      const duty = dutyFor(it.a);
                                      return (
                                        <button key={it.a.id}
                                          onClick={(e) => { e.stopPropagation(); if (confirm(`Rimuovere ${it.a.dutyCode} da ${driverLabel(drv)}?`)) unassignMut.mutate(it.a.id); }}
                                          onContextMenu={(e) => { e.stopPropagation(); openDutyContext(e, duty); }}
                                          title="Click: rimuovi · Tasto destro: dettaglio"
                                          className={`w-full rounded text-white font-bold leading-tight hover:opacity-80 ${big ? dutyBigCls : "px-1 py-0.5 text-[9px]"}`}
                                          style={{ backgroundColor: resColor(duty) }}>
                                          {it.a.dutyCode}
                                          {big && showTimes && duty?.start && <span className="block font-normal opacity-90 text-[9px]">{duty.start}–{duty.end}</span>}
                                          {big && showExtra && duty && (duty.tripsCount || duty.nastro) && (
                                            <span className="block font-normal opacity-80 text-[9px]">
                                              {duty.nastro ? `nastro ${duty.nastro}` : ""}{duty.nastro && duty.tripsCount ? " · " : ""}{duty.tripsCount ? `${duty.tripsCount} corse` : ""}
                                            </span>
                                          )}
                                        </button>
                                      );
                                    }
                                    const en = it.en;
                                    return (
                                      <div key={en.id}
                                        className={`group relative w-full font-bold leading-none ${voceTextColor(en.category, en.code)} ${big ? voceBigCls : "text-[11px] py-0.5"}`}
                                        title={en.category}>
                                        {en.code}
                                        <button onClick={(e) => { e.stopPropagation(); delEntryMut.mutate(en.id); }}
                                          className="absolute -top-0.5 -right-0.5 opacity-0 group-hover:opacity-100 text-slate-500 hover:text-rose-400 text-[10px] leading-none">×</button>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* BASSO: turni scoperti — finestra con i GIORNI come colonne, scorrevole */}
        {dssId && (
          <div className={`shrink-0 border-t border-slate-800 bg-slate-900/50 flex flex-col ${showUncovered ? "h-44" : "h-8"}`}>
            <div className="px-3 h-8 shrink-0 border-b border-slate-800 text-xs font-semibold text-slate-300 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Turni scoperti per giorno
              <span className="text-[10px] font-normal text-slate-500">tasto destro per il dettaglio · Q taglia · W incolla</span>
              <button onClick={() => setShowUncovered((v) => !v)} className="ml-auto text-[11px] text-slate-400 hover:text-slate-100">
                {showUncovered ? "Nascondi ▾" : "Mostra ▸"}
              </button>
            </div>
            {showUncovered && (
              <div ref={uncoveredScrollRef} onScroll={() => mirrorScroll("unc")} className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden flex">
                {board?.days.map((day) => {
                  const list = uncoveredByDay.get(day) ?? [];
                  return (
                    <div key={day} className={`w-28 shrink-0 border-r border-slate-800/70 flex flex-col min-h-0 ${festBg(day)}`}>
                      <div className={`px-2 py-1 shrink-0 text-[10px] uppercase tracking-wide border-b border-slate-800/60 flex items-center justify-between ${festLevel(day) ? "text-rose-300/80" : "text-slate-400"}`}>
                        <span>{dayLabel(day).dow} {dayLabel(day).dm}</span>
                        <span className={list.length ? "text-amber-400" : "text-emerald-400"}>{list.length}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-1 space-y-1">
                        {list.length === 0 ? (
                          isAuto && !board?.dssByDay?.[day]
                            ? <div className="text-[10px] text-slate-500 px-1">nessun DSS competente</div>
                            : <div className="text-[10px] text-emerald-400/60 px-1">tutto coperto</div>
                        ) : list.map((d) => {
                          const isSel = selDuty?.day === day && selDuty?.code === d.code;
                          const isCut = cut?.day === day && cut?.code === d.code;
                          return (
                            <button key={`${day}|${d.code}`}
                              onClick={() => setSelDuty(isSel ? null : { day, code: d.code })}
                              onContextMenu={(e) => openDutyContext(e, d)}
                              className={`w-full text-left px-1.5 py-1 rounded border flex items-center gap-1.5 transition-colors ${
                                isCut ? "border-amber-500/70 bg-amber-500/10" : isSel ? "border-violet-500/70 bg-violet-500/10" : "border-slate-800 hover:border-violet-500/40"
                              }`}>
                              <span className="px-1 py-0.5 rounded text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: resColor(d) }}>{d.code}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[10px] text-slate-200 leading-tight">{d.start ?? "?"}–{d.end ?? "?"}</span>
                                <span className="block text-[9px] text-slate-500 leading-tight">{d.type ?? "turno"}{d.tripsCount ? ` · ${d.tripsCount}c` : ""}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {editDriver !== null && (
        <DriverEditDialog driver={editDriver === "new" ? null : editDriver} onClose={() => setEditDriver(null)} />
      )}

      {rotDialog === "create-riposi" && <RotazioneRiposiCreateDialog onClose={() => setRotDialog(null)} />}
      {rotDialog === "list-riposi" && <RotazioniRiposiListDialog onClose={() => setRotDialog(null)} />}
      {rotDialog === "assegna" && <AssegnaRotazioniDialog onClose={() => setRotDialog(null)} />}
      {rotDialog === "genera-riposi" && <GeneraRiposiDialog onClose={() => setRotDialog(null)} />}

      {/* Gomma su cella con più attività: scegli quale togliere */}
      {eraseChoice && (() => {
        const key = `${eraseChoice.driverId}|${eraseChoice.day}`;
        const drv = board?.drivers.find((d) => d.id === eraseChoice.driverId);
        const items: Array<{ kind: "duty"; a: RosterAssignment } | { kind: "voce"; en: RosterEntry }> = [
          ...(assignmentsByCell.get(key) ?? []).map((a) => ({ kind: "duty" as const, a })),
          ...(entriesByCell.get(key) ?? []).map((en) => ({ kind: "voce" as const, en })),
        ];
        if (items.length === 0) return null; // cella già svuotata: niente da scegliere
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={() => setEraseChoice(null)}>
            <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-sm flex flex-col text-slate-100" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                <div className="text-sm font-semibold flex items-center gap-2"><Eraser className="w-4 h-4 text-rose-400" /> Cosa vuoi togliere?</div>
                <button onClick={() => setEraseChoice(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800"><X className="h-4 w-4" /></button>
              </div>
              <div className="px-4 py-2 text-[11px] text-slate-400 border-b border-slate-800">
                {drv ? driverLabel(drv) : "Conducente"} · {dayLabel(eraseChoice.day).dow} {dayLabel(eraseChoice.day).dm} — {items.length} attività nella cella
              </div>
              <div className="p-2 space-y-1 max-h-[50vh] overflow-auto">
                {items.map((it) => {
                  const isDuty = it.kind === "duty";
                  const duty = isDuty ? dutyFor(it.a) : undefined;
                  const code = isDuty ? it.a.dutyCode : it.en.code;
                  const sub = isDuty ? `${duty?.type ?? "turno"}${duty?.start ? ` · ${duty.start}–${duty.end}` : ""}` : (it.en.category === "assenza" ? "assenza" : "presenza");
                  return (
                    <button key={isDuty ? it.a.id : it.en.id}
                      onClick={() => { removeOne(it); setEraseChoice(null); }}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-slate-800 hover:border-rose-500/50 hover:bg-rose-500/10 text-left">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold text-white shrink-0" style={{ backgroundColor: isDuty ? resColor(duty) : "#475569" }}>{code}</span>
                      <span className="flex-1 min-w-0"><span className="block text-xs font-medium">{isDuty ? "Turno" : "Voce"} {code}</span><span className="block text-[10px] text-slate-500">{sub}</span></span>
                      <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800">
                <button onClick={() => setEraseChoice(null)} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
                <button onClick={() => { for (const it of items) removeOne(it); setEraseChoice(null); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-rose-600 text-white hover:bg-rose-500">
                  <Trash2 className="w-4 h-4" /> Togli tutto
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Dettaglio turno (tasto destro) */}
      {ctxDuty && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCtxDuty(null)} onContextMenu={(e) => { e.preventDefault(); setCtxDuty(null); }} />
          <div
            className="fixed z-50 w-[340px] max-h-[70vh] overflow-auto rounded-lg border border-slate-700 bg-slate-900 shadow-2xl p-3 text-[11px]"
            style={{ left: Math.min(ctxDuty.x, window.innerWidth - 350), top: Math.min(ctxDuty.y, window.innerHeight - 320) }}
          >
            <div className="flex items-center gap-1.5 font-semibold text-slate-100 mb-2">
              <span className="px-1.5 py-0.5 rounded text-white text-[10px] font-bold" style={{ backgroundColor: resColor(ctxDuty.duty) }}>{ctxDuty.duty.code}</span>
              <span className="text-slate-300">{ctxDuty.duty.type ?? "turno"}</span>
              {ctxDuty.duty.residenzaName && <span className="text-[10px] text-slate-500 ml-auto">{ctxDuty.duty.residenzaName}</span>}
            </div>
            <div className="grid grid-cols-3 gap-x-2 gap-y-1 text-slate-400 mb-2">
              <span>Inizio: <span className="text-slate-100 font-medium">{ctxDuty.duty.start ?? "?"}</span></span>
              <span>Fine: <span className="text-slate-100 font-medium">{ctxDuty.duty.end ?? "?"}</span></span>
              <span>Lavoro: <span className="text-slate-100 font-medium">{ctxDuty.duty.work ?? "—"}</span></span>
            </div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 border-t border-slate-800 pt-2">Contenuto del turno</div>
            {(ctxDuty.duty.segments ?? []).length === 0 ? (
              <div className="text-[10px] text-slate-500 italic">Dettaglio tratte non disponibile per questo turno.</div>
            ) : (
              <table className="w-full text-[10px]">
                <thead className="text-slate-500">
                  <tr>
                    <th className="text-left font-medium py-0.5">Linea</th>
                    <th className="text-left font-medium">Partenza</th>
                    <th className="text-left font-medium">Arrivo</th>
                  </tr>
                </thead>
                <tbody>
                  {(ctxDuty.duty.segments ?? []).map((s, i) => {
                    const isLine = (s.type ?? "trip") === "trip";
                    return (
                      <tr key={i} className="border-t border-slate-800/60 align-top">
                        <td className="py-1 pr-1">
                          {isLine
                            ? <span className="font-bold text-slate-100">{s.line ?? "—"}</span>
                            : <span className="text-amber-400/90">{s.type === "deadhead" ? "fuorilinea" : (s.line ?? s.type)}</span>}
                        </td>
                        <td className="py-1 pr-1"><span className="text-slate-200 font-mono">{s.startTime ?? "?"}</span> <span className="text-slate-500 block">{s.startPlace ?? "—"}</span></td>
                        <td className="py-1"><span className="text-slate-200 font-mono">{s.endTime ?? "?"}</span> <span className="text-slate-500 block">{s.endPlace ?? "—"}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
