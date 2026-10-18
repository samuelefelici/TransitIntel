/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROSTER — assegnazione turni guida al personale viaggiante (2 finestre)
 * ───────────────────────────────────────────────────────────────────────────
 * A sinistra il tabellone (operatori × giorni). A destra i turni SCOPERTI per
 * giorno. Per assegnare: seleziona un turno a destra → Q (taglia), seleziona
 * un conducente a sinistra → W (incolla): il turno va nel giorno giusto perché
 * la tabella ha una colonna per ogni giorno. Anagrafica conducente completa
 * via la matita; accanto a ogni conducente la righetta del suo deposito, dello
 * stesso colore dei turni di quel deposito.
 *
 * Strumenti: col puntatore il click non cambia niente (seleziona la cella e ci
 * ferma il crocino di riga e colonna); la gomma toglie turni e voci; il cambio
 * turno scambia i turni di due persone nello stesso giorno (click sul turno,
 * poi sull'altra persona).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Loader2,
  UserPlus, Users, Pencil, Scissors, ClipboardPaste, Ban, Clock, ChevronDown,
  Eraser, Check, Maximize2, RotateCcw, Cpu, Printer, Eye, Plus, Wand2, Trash2, X,
  MousePointer2, ArrowLeftRight, Pin, Send,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { COLORE_CATEGORIA_GIORNO, COLORE_GIORNO_NEUTRO } from "@/lib/day-classifier";

/** La categoria di un giorno nel calendario aziendale (GET /api/roster/calendario). */
interface GiornoCalendario { date: string; key: string; level1: string; level2: string | null; label: string; periodo: string | null }
interface CalendarioRoster {
  calendario: { psProjectId: string | null; nome: string | null; compilato: boolean; scelto: string; nota: string | null };
  days: GiornoCalendario[];
}
import DriverEditDialog, { type RosterDriver } from "@/components/roster/DriverEditDialog";
import { AbilitazioneBadges } from "@/components/roster/abilitazioni";
import { RotazioneRiposiCreateDialog, RotazioniRiposiListDialog, AssegnaRotazioniDialog, GeneraRiposiDialog } from "@/components/roster/RotazioniRiposi";
import { useDialogo } from "@/components/roster/useDialogo";

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
/** Chi ha assegnato un turno nonostante riposo troppo corto o sovrapposizione, quando e cosa. */
interface Forzatura { da: string | null; il: string; regole: string[]; testi: string[] }
/** Stato di un'assegnazione nel canale della pubblicazione (api-server routes/roster.ts, board). */
type StatoAssegnazione = "pubblicato" | "da_riassegnare" | "non_pubblicato";
interface RosterAssignment {
  id: string; driverId: string; day: string; dutyCode: string; dssId: string;
  snapshot?: DutySnapshot | null; forzatura?: Forzatura | null;
  /** pubblicato; da_riassegnare = il giorno è pubblicato ma questo turno no; non_pubblicato = giorno mai pubblicato */
  stato?: StatoAssegnazione;
  /** l'ultima volta che una ripubblicazione l'ha spostata su un turno uguale */
  ricollegata?: { pubblicazione: string; il: string; prima: { dssId: string; codice: string } } | null;
}
type Servizio = "urbano" | "extraurbano";
/** Riposo troppo corto o sovrapposizione fra due turni di un conducente (api-server lib/roster-normativa.ts). */
interface ViolazioneRoster {
  regola: "riposo" | "sovrapposizione";
  conducenteId: string;
  minuti: number;
  minimo: number | null;
  /** 9h perché di un turno non si sa se è urbano o extraurbano */
  presunto: boolean;
  testo: string;
  /** chi forza manda le chiavi delle violazioni che ha visto */
  chiave: string;
  /** chi ha assegnato uno dei due turni ha visto e forzato proprio questa */
  forzata: boolean;
  turni: Array<{ assegnazioneId: string | null; giorno: string; codice: string; dssId: string; servizio: Servizio | null; servizioDa: string | null }>;
}
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
/** Un'UDP pubblicata in un giorno, con i suoi turni guida (il canale della pubblicazione). */
interface Pubblicato { udpId: string; udpNome: string | null; dssId: string; dssNome: string | null; psProjectId: string | null }
interface Board {
  /** depositoCodice: il deposito del catalogo, abbinato dal server come fa l'anagrafica */
  from: string; days: string[]; drivers: Array<RosterDriver & { depositoCodice?: string | null }>;
  assignments: RosterAssignment[];
  entries?: RosterEntry[];
  /** il colore di ogni deposito del personale, lo stesso dei suoi turni */
  depositi?: ColoreDeposito[];
  /** per giorno, le UDP pubblicate e i loro turni guida: l'unica fonte dei turni */
  pubblicati: Record<string, Pubblicato[]>;
  /** i programmi pubblicati nei giorni visibili */
  programmi: Array<{ id: string; nome: string }>;
  /** i turni (senza tratte) dei DSS pubblicati e di quelli delle assegnazioni */
  dutiesByDss: Record<string, RosterDuty[]>;
  /** riposi troppo corti e sovrapposizioni nei giorni visibili */
  violazioni?: ViolazioneRoster[];
}
/** Un turno nel tabellone: il codice da solo non basta, due UDP dello stesso deposito hanno entrambe A001. */
interface RifTurno { day: string; code: string; dssId: string }

/** Da dove viene il colore: i turni sul tabellone, Planner Studio, o la tavolozza fissa. */
interface ColoreDeposito { codice: string; nome: string; colore: string; da: "turni" | "planner" | "predefinito"; depositoPlanner: string | null }

/** Lo strumento attivo sul tabellone. */
type Strumento = "puntatore" | "gomma" | "cambio";
/** Un cambio turno: «da» passa a aConducente, «a» (se c'è) torna al conducente di «da». */
interface Scambio { da: RosterAssignment; aConducente: string; a: RosterAssignment | null; forza?: string[] }
/** Un'assegnazione chiesta al server; forza = le chiavi delle violazioni viste, si procede nonostante quelle. */
interface Assegnazione { driverId: string; day: string; dutyCode: string; dssId: string; forza?: string[]; sostituisce?: string }
/** Il 409 forzabile del server: violazioni da mostrare e l'azione da rifare con forza. */
interface AvvisoNormativa { titolo: string; violazioni: ViolazioneRoster[]; conferma: string; forza: () => void }
const eForzabile = (e: unknown): e is Error & { status: number; body: { forzabile: true; violazioni: ViolazioneRoster[] } } =>
  (e as any)?.status === 409 && (e as any)?.body?.forzabile === true && Array.isArray((e as any)?.body?.violazioni);

/* cursori degli strumenti: le stesse icone dei pulsanti, con un bordo scuro per vederle su ogni fondo */
const cursoreSvg = (tratti: string, colore: string, x: number, y: number, riserva: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + `<g stroke="#0f172a" stroke-width="4.5">${tratti}</g><g stroke="${colore}" stroke-width="2">${tratti}</g></svg>`,
  )}") ${x} ${y}, ${riserva}`;
const CURSORE: Record<Strumento, string | undefined> = {
  puntatore: undefined,
  gomma: cursoreSvg(`<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>`, "#fda4af", 3, 20, "cell"),
  cambio: cursoreSvg(`<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>`, "#fcd34d", 12, 12, "alias"),
};

/** Le regole CSS del crocino: riga e colonna della cella sotto il mouse, o di quella fissata. */
function regoleCroce(hover: { r: string | null; c: string | null }, pin: { r: string; c: string } | null): string {
  const sicuro = (v: string | null) => (v && /^[0-9A-Za-z-]+$/.test(v) ? v : null);
  const out: string[] = [];
  const croce = (r: string | null, c: string | null, tinta: string, bordo: string) => {
    if (r) out.push(`.roster-board tr[data-r="${r}"] > td { box-shadow: inset 0 0 0 999px ${tinta}; }`);
    if (c) out.push(`.roster-board td[data-c="${c}"], .roster-unc [data-c="${c}"] { box-shadow: inset 0 0 0 999px ${tinta}; }`);
    if (c) out.push(`.roster-board th[data-c="${c}"] { box-shadow: inset 0 -2px 0 ${bordo}, inset 0 0 0 999px ${tinta}; }`);
    if (r && c) out.push(`.roster-board tr[data-r="${r}"] > td[data-c="${c}"] { box-shadow: inset 0 0 0 2px ${bordo}, inset 0 0 0 999px ${tinta}; }`);
  };
  const hr = sicuro(hover.r), hc = sicuro(hover.c);
  if (pin) {
    /* con la croce fissata, sotto il mouse resta solo il contorno della cella
       (sopra la tinta della croce, se la cella ci sta dentro) */
    const tinta = "rgba(56,189,248,0.13)";
    if (hr && hc) {
      const dentro = hr === pin.r || hc === pin.c ? `, inset 0 0 0 999px ${tinta}` : "";
      out.push(`.roster-board tr[data-r="${hr}"] > td[data-c="${hc}"] { box-shadow: inset 0 0 0 1px #64748b${dentro}; }`);
    }
    croce(sicuro(pin.r), sicuro(pin.c), tinta, "#38bdf8");
  } else {
    croce(hr, hc, "rgba(148,163,184,0.10)", "#94a3b8");
  }
  return out.join("\n");
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
function DriverAvatar({ drv, size = 28, bordo }: { drv: RosterDriver; size?: number; bordo?: string }) {
  if (!size) return null;
  const initials = (drv.cognome ?? drv.name ?? "?").trim().slice(0, 2).toUpperCase() || "?";
  const st = { width: size, height: size, ...(bordo ? { borderColor: bordo } : {}) };
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

  // selezioni + appunti (taglia/incolla)
  const [selDuty, setSelDuty] = useState<RifTurno | null>(null);
  const [selDriver, setSelDriver] = useState<string | null>(null);
  const [cut, setCut] = useState<RifTurno | null>(null);
  /* id del conducente di cui è aperta la scheda, o "new" */
  const [editDriver, setEditDriver] = useState<string | null | "new">(null);
  const { hasPermission, datiProva } = useAuth();
  /* la pubblicazione dei turni è dello Scheduling: senza, i link non portano da nessuna parte */
  const puoPubblicare = hasPermission("scheduling");
  /* senza «Personale» dal tabellone si creano solo conducenti fittizi */
  const personale = hasPermission("personale");

  // Vista a più settimane: il tabellone scorre orizzontalmente (barra di
  // scorrimento) invece di navigare una settimana alla volta. I turni vengono
  // solo dalla pubblicazione: niente più scelta della fonte qui.
  const RANGE_DAYS = 28;
  const boardQ = useQuery({
    queryKey: ["roster", "board", from],
    queryFn: () => apiFetch<Board>(`/api/roster/board?from=${from}&days=${RANGE_DAYS}`),
  });
  const invalidateBoard = () => qc.invalidateQueries({ queryKey: ["roster", "board"] });

  /* Il calendario aziendale di Planning Studio, per la righetta sopra ogni giorno: quello del programma pubblicato */
  const calendarioQ = useQuery({
    queryKey: ["roster", "calendario", from, RANGE_DAYS, psProjectId],
    queryFn: () => apiFetch<CalendarioRoster>(`/api/roster/calendario?from=${from}&days=${RANGE_DAYS}`
      + `${psProjectId ? `&psProjectId=${psProjectId}` : ""}`),
    staleTime: 10 * 60 * 1000,
  });
  const giornoCal = useMemo(() => new Map((calendarioQ.data?.days ?? []).map(g => [g.date, g])), [calendarioQ.data]);
  const calCompilato = !!calendarioQ.data?.calendario.compilato;
  /** colore e descrizione della righetta: senza calendario compilato, solo domeniche e festivi */
  const righetta = (day: string): { colore: string; testo: string } | null => {
    const g = giornoCal.get(day);
    if (!g) return null;
    const vale = calCompilato || g.level1 === "festivo";
    return {
      colore: vale ? (COLORE_CATEGORIA_GIORNO[g.key] ?? COLORE_GIORNO_NEUTRO) : COLORE_GIORNO_NEUTRO,
      testo: vale ? `${g.label}${g.periodo ? ` — ${g.periodo}` : ""}` : "Calendario aziendale non compilato: scuole aperte o chiuse non si sa",
    };
  };
  /* le categorie presenti nel periodo, per la legenda */
  const legendaCal = useMemo(() => {
    const m = new Map<string, { colore: string; testo: string }>();
    for (const g of calendarioQ.data?.days ?? []) {
      const vale = calCompilato || g.level1 === "festivo";
      const chiave = vale ? g.key : "neutro";
      if (!m.has(chiave)) m.set(chiave, { colore: vale ? (COLORE_CATEGORIA_GIORNO[g.key] ?? COLORE_GIORNO_NEUTRO) : COLORE_GIORNO_NEUTRO, testo: vale ? g.label : "non classificato" });
    }
    return [...m.values()];
  }, [calendarioQ.data, calCompilato]);

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
    onSuccess: (r: { created: number; riposi?: number }) => {
      toast.success(`${r.created} conducenti di prova creati${r.riposi ? `, con ${r.riposi} riposi già sul tabellone` : ""}`);
      qc.invalidateQueries({ queryKey: ["roster"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /* riposo troppo corto o turni sovrapposti: il server avvisa (409) e si può forzare */
  const [avviso, setAvviso] = useState<AvvisoNormativa | null>(null);
  const assignMut = useMutation({
    mutationFn: (input: Assegnazione) =>
      apiFetch<{ forzato?: boolean }>("/api/roster/assignments", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: (r, input) => {
      if (r?.forzato) toast.warning(`${input.dutyCode} assegnato nonostante l'avviso: resta segnato sul turno`);
      setCut(null); setSelDuty(null); invalidateBoard();
    },
    onError: (e: Error, input) => {
      if (eForzabile(e)) {
        const viste = e.body.violazioni.map((v) => v.chiave);
        setAvviso({ titolo: e.message, violazioni: e.body.violazioni, conferma: "Assegna comunque", forza: () => assignMut.mutate({ ...input, forza: viste }) });
        return;
      }
      /* il turno non è (più) pubblicato quel giorno, o il tabellone era vecchio: si ricarica e si riparte */
      if ((e as any)?.body?.nonPubblicato || (e as any)?.body?.ricarica) { setCut(null); setSelDuty(null); invalidateBoard(); }
      toast.error("Assegnazione fallita", { description: e.message });
    },
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

  // ── Strumenti: puntatore (il click non cambia niente), gomma, cambio turno ──
  const [tool, setTool] = useState<Strumento>("puntatore");
  const eraser = tool === "gomma";
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
  const [ctxDuty, setCtxDuty] = useState<{ x: number; y: number; duty: RosterDuty; dssId: string } | null>(null);
  const openDutyContext = (e: ReactMouseEvent, duty: RosterDuty | undefined, dssId: string) => {
    if (!duty) return;
    e.preventDefault();
    setCtxDuty({ x: e.clientX, y: e.clientY, duty, dssId });
  };
  /* le tratte del turno si chiedono quando si apre il dettaglio: il tabellone porta solo i riassunti */
  const tratteQ = useQuery({
    queryKey: ["roster", "turno", ctxDuty?.dssId, ctxDuty?.duty.code],
    queryFn: () => apiFetch<{ turno: RosterDuty }>(`/api/roster/turni/${ctxDuty!.dssId}/${encodeURIComponent(ctxDuty!.duty.code)}`).then(r => r.turno),
    enabled: !!ctxDuty,
    staleTime: 10 * 60 * 1000,
  });
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
    setOpenTopMenu(null);
  };

  const board = boardQ.data;
  /* i turni per DSS e codice */
  const turnoDi = useMemo(() => {
    const m = new Map<string, RosterDuty>();
    for (const [dss, l] of Object.entries(board?.dutiesByDss ?? {})) for (const d of l) m.set(`${dss}|${d.code}`, d);
    return m;
  }, [board?.dutiesByDss]);
  /** Il turno di un'assegnazione, dal suo DSS; senza, ricostruito dallo snapshot salvato. */
  const dutyFor = (a: RosterAssignment): RosterDuty | undefined => {
    const d = turnoDi.get(`${a.dssId}|${a.dutyCode}`);
    if (d) return d;
    if (!a.snapshot) return undefined;
    return {
      code: a.dutyCode, type: null, start: a.snapshot.start ?? null, end: a.snapshot.end ?? null,
      nastro: null, work: null, interruption: null, ripreseCount: 0, tripsCount: 0, costEuro: null,
    };
  };
  /* l'UDP pubblicata di un DSS in un giorno, per l'etichetta quando un giorno ne ha più d'una */
  const udpDi = (day: string, dssId: string) => board?.pubblicati?.[day]?.find(p => p.dssId === dssId)?.udpNome ?? null;
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
  /* gli scoperti di ogni giorno: i turni delle UDP pubblicate quel giorno, meno quelli assegnati */
  const uncoveredByDay = useMemo(() => {
    const m = new Map<string, Array<{ duty: RosterDuty; dssId: string; udpNome: string | null }>>();
    if (!board) return m;
    for (const day of board.days) {
      const taken = new Set(board.assignments.filter((a) => a.day === day).map((a) => `${a.dssId}|${a.dutyCode}`));
      m.set(day, (board.pubblicati?.[day] ?? []).flatMap(p =>
        (board.dutiesByDss?.[p.dssId] ?? []).filter(d => !taken.has(`${p.dssId}|${d.code}`)).map(d => ({ duty: d, dssId: p.dssId, udpNome: p.udpNome }))));
    }
    return m;
  }, [board]);
  const giornoPubblicato = (day: string) => (board?.pubblicati?.[day]?.length ?? 0) > 0;
  const daRiassegnare = useMemo(() => (board?.assignments ?? []).filter(a => a.stato === "da_riassegnare"), [board?.assignments]);

  // ── Taglia/incolla via tastiera: Q = taglia turno selezionato, W = incolla sul conducente ──
  /* il conducente si passa quando arriva da un click: lo stato selDriver si aggiorna solo al giro dopo */
  function doPaste(driverId: string | null = selDriver) {
    /* un'assegnazione per volta: il secondo click di un doppio click non incolla altrove */
    if (assignMut.isPending) return;
    if (!cut) { toast.info("Prima seleziona un turno e premi Q (taglia)"); return; }
    if (!driverId) { toast.info("Seleziona un conducente a sinistra"); return; }
    /* se il conducente quel giorno ha un turno da riassegnare, il nuovo lo sostituisce */
    const vecchio = (assignmentsByCell.get(`${driverId}|${cut.day}`) ?? []).find(a => a.stato === "da_riassegnare");
    // Un conducente può avere più turni nello stesso giorno: nessun blocco.
    assignMut.mutate({ driverId, day: cut.day, dutyCode: cut.code, dssId: cut.dssId, ...(vecchio ? { sostituisce: vecchio.id } : {}) });
  }

  // ── Crocino: riga e colonna sotto il mouse; il click col puntatore lo ferma ──
  /* Si colora con un foglio di stile riscritto a ogni cambio di cella, non con
     lo stato di React: così il mouse non fa ridisegnare migliaia di celle. */
  const croceRef = useRef<HTMLStyleElement>(null);
  const hoverCell = useRef<{ r: string | null; c: string | null }>({ r: null, c: null });
  const [pin, setPin] = useState<{ r: string; c: string } | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const dipingiCroce = () => {
    if (croceRef.current) croceRef.current.textContent = regoleCroce(hoverCell.current, pinRef.current);
  };
  useEffect(dipingiCroce, [pin]);
  const onBoardOver = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement;
    const r = t.closest<HTMLElement>("tr[data-r]")?.dataset.r ?? null;
    const c = t.closest<HTMLElement>("[data-c]")?.dataset.c ?? null;
    if (hoverCell.current.r === r && hoverCell.current.c === c) return;
    hoverCell.current = { r, c };
    dipingiCroce();
  };
  const onBoardLeave = () => { hoverCell.current = { r: null, c: null }; dipingiCroce(); };

  // ── Cambio turno: click sul turno da cedere, poi su un'altra persona dello stesso giorno ──
  const [swapFrom, setSwapFrom] = useState<RosterAssignment | null>(null);
  const [swapAsk, setSwapAsk] = useState<(Scambio & { avvisi: string[] }) | null>(null);
  const nomeDi = (id: string) => {
    const d = board?.drivers.find((x) => x.id === id);
    return d ? driverLabel(d) : "il conducente";
  };
  const quandoDi = (day: string) => `${dayLabel(day).dow} ${dayLabel(day).dm}`;
  const swapMut = useMutation({
    mutationFn: (s: Scambio) => apiFetch("/api/roster/assignments/scambia", {
      method: "POST",
      body: JSON.stringify({
        da: s.da.id, daConducente: s.da.driverId, a: s.a?.id ?? null, aConducente: s.aConducente,
        /* il tabellone mostra tutti i turni pubblicati: niente filtro per DSS */
        dssVisto: null,
        ...(s.forza ? { forza: s.forza } : {}),
      }),
    }) as Promise<{ forzato?: boolean }>,
    onSuccess: (r, s) => {
      const fatto = s.a
        ? `Cambio turno di ${quandoDi(s.da.day)}: ${s.da.dutyCode} a ${nomeDi(s.aConducente)}, ${s.a.dutyCode} a ${nomeDi(s.da.driverId)}`
        : `${s.da.dutyCode} di ${quandoDi(s.da.day)} passa a ${nomeDi(s.aConducente)}`;
      /* forzato lo dice il server: se intanto la violazione è sparita, non c'è niente da segnare */
      if (r?.forzato) toast.warning(`${fatto}, nonostante l'avviso: resta segnato sul turno`);
      else toast.success(fatto);
      setSwapFrom(null);
      invalidateBoard();
    },
    onError: (e: Error, s) => {
      /* riposi o sovrapposizioni: il turno scelto resta, si decide nella finestra */
      if (eForzabile(e)) {
        const viste = e.body.violazioni.map((v) => v.chiave);
        setAvviso({ titolo: e.message, violazioni: e.body.violazioni, conferma: "Scambia comunque", forza: () => swapMut.mutate({ ...s, forza: viste }) });
        return;
      }
      toast.error("Cambio turno non riuscito", { description: e.message });
      setSwapFrom(null);
      invalidateBoard();
    },
  });
  const labelAssenza = (code: string) => vociQ.data?.assenza.find((v) => v.code === code)?.label ?? code;
  /** Un click col cambio turno: sul turno (target) o sulla cella/sul nome di un conducente (target null). */
  const swapClick = (driverId: string, day: string | null, target: RosterAssignment | null) => {
    if (swapMut.isPending) return;
    if (!swapFrom) {
      if (target) setSwapFrom(target);
      else toast.info("Cambio turno: clicca prima il turno da scambiare");
      return;
    }
    if (target?.id === swapFrom.id) { setSwapFrom(null); return; }
    if (driverId === swapFrom.driverId) {
      /* un altro turno della stessa persona diventa quello da cedere */
      if (target) setSwapFrom(target); else toast.info("Ora clicca un'altra persona");
      return;
    }
    const giorno = swapFrom.day;
    if ((target?.day ?? day ?? giorno) !== giorno) {
      toast.info(`Il cambio turno è nello stesso giorno: clicca nella colonna di ${quandoDi(giorno)}`);
      return;
    }
    let a = target;
    if (!a) {
      const loro = assignmentsByCell.get(`${driverId}|${giorno}`) ?? [];
      if (loro.length > 1) { toast.info(`${nomeDi(driverId)} ${quandoDi(giorno)} ha ${loro.length} turni: clicca quello da scambiare`); return; }
      a = loro[0] ?? null;
    }
    /* chi riceve un turno in un giorno di assenza: si chiede prima */
    const assenze = (id: string) => (entriesByCell.get(`${id}|${giorno}`) ?? []).filter((en) => en.category === "assenza");
    const avvisi = assenze(driverId).map((en) => `${nomeDi(driverId)} ${quandoDi(giorno)} ha ${en.code} (${labelAssenza(en.code)}) e riceve ${swapFrom.dutyCode}`);
    if (a) {
      const ricevuto = a.dutyCode;
      avvisi.push(...assenze(swapFrom.driverId).map((en) => `${nomeDi(swapFrom.driverId)} ${quandoDi(giorno)} ha ${en.code} (${labelAssenza(en.code)}) e riceve ${ricevuto}`));
    }
    const s: Scambio = { da: swapFrom, aConducente: driverId, a };
    if (avvisi.length) setSwapAsk({ ...s, avvisi }); else swapMut.mutate(s);
  };
  /* se il turno scelto sparisce o cambia conducente (ricarica, un altro utente), si riparte */
  useEffect(() => {
    if (swapFrom && !board?.assignments.some((x) => x.id === swapFrom.id && x.driverId === swapFrom.driverId)) setSwapFrom(null);
  }, [board?.assignments, swapFrom]);
  /* la croce fissata si lascia quando la sua cella esce dal tabellone (altro periodo, conducente tolto) */
  useEffect(() => {
    if (pin && board && (!board.days.includes(pin.c) || !board.drivers.some((d) => d.id === pin.r))) setPin(null);
  }, [board, pin]);

  /** Cambia strumento: la croce fissata e il turno scelto per lo scambio si lasciano. */
  const scegliStrumento = (t: Strumento) => {
    setTool(t);
    setSwapFrom(null);
    setPin(null);
    if (t !== "puntatore") { setArmedVoce(null); setVoceMenu(null); }
  };

  /* la scelta della gomma su una cella che intanto si è svuotata non si vede: si chiude */
  useEffect(() => {
    if (!eraseChoice) return;
    const k = `${eraseChoice.driverId}|${eraseChoice.day}`;
    if (!(assignmentsByCell.get(k)?.length || entriesByCell.get(k)?.length)) setEraseChoice(null);
  }, [eraseChoice, assignmentsByCell, entriesByCell]);
  /* le due finestre del tabellone: focus dentro, Tab che gira dentro, Esc che chiude */
  const swapAskRef = useRef<HTMLDivElement>(null);
  const eraseChoiceRef = useRef<HTMLDivElement>(null);
  const avvisoRef = useRef<HTMLDivElement>(null);
  useDialogo(swapAskRef, () => setSwapAsk(null), !!swapAsk);
  useDialogo(eraseChoiceRef, () => setEraseChoice(null), !!eraseChoice);
  useDialogo(avvisoRef, () => setAvviso(null), !!avviso);

  /* La tastiera. Il gestore si rilegge a ogni giro (onKeyRef), così vede sempre
     lo stato attuale; con una finestra aperta i tasti sono suoi, non del tabellone. */
  const finestraAperta = editDriver !== null || rotDialog !== null || !!swapAsk || !!eraseChoice || !!avviso;
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    if (finestraAperta || document.querySelector('[aria-modal="true"]')) return;
    if (e.key === "Escape") {
      /* un passo alla volta: menu e dettagli aperti, poi il turno scelto per lo
         scambio, poi lo strumento o la voce o il taglio, infine la croce fissata */
      if (ctxDuty || voceMenu || openTopMenu) { setCtxDuty(null); setVoceMenu(null); setOpenTopMenu(null); return; }
      if (swapFrom) { setSwapFrom(null); return; }
      if (cut || armedVoce || tool !== "puntatore") { setCut(null); setArmedVoce(null); setTool("puntatore"); return; }
      setPin(null);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "q") { e.preventDefault(); if (selDuty) { setCut(selDuty); toast.success(`Turno ${selDuty.code} in taglio: scegli un conducente e premi W`); } }
    else if (k === "w") { e.preventDefault(); doPaste(); }
    else if (k === "v") scegliStrumento("puntatore");
    else if (k === "g") scegliStrumento("gomma");
    else if (k === "c") scegliStrumento("cambio");
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // colore turno: residenza per-turno (deposito del turno) → tipo
  const resColor = (duty: RosterDuty | null | undefined) =>
    duty?.residenzaColor ?? dutyColor(duty?.type ?? null);

  // ── Deposito del conducente: la righetta ha lo stesso colore dei turni del deposito ──
  const coloreDeposito = useMemo(
    () => new Map((board?.depositi ?? []).map((d) => [d.codice, d])),
    [board?.depositi],
  );
  const depositoDi = (drv: Board["drivers"][number]) =>
    (drv.depositoCodice ? coloreDeposito.get(drv.depositoCodice) : undefined) ?? null;
  const spiegaColore = (d: ColoreDeposito) =>
    d.da === "turni" ? `colore dei turni (${d.depositoPlanner})`
      : d.da === "planner" ? `colore del deposito di Planner Studio «${d.depositoPlanner}»`
        : "colore predefinito: il deposito non si ritrova fra quelli di Planner Studio";
  /* i depositi dei conducenti sul tabellone, per la legenda */
  const legendaDepositi = useMemo(() => {
    const presenti = new Set((board?.drivers ?? []).map((d) => d.depositoCodice).filter(Boolean));
    return (board?.depositi ?? []).filter((d) => presenti.has(d.codice));
  }, [board?.drivers, board?.depositi]);

  // ── Riposi e sovrapposizioni: le violazioni di ogni turno sul tabellone ──
  const violazioniDi = useMemo(() => {
    const m = new Map<string, ViolazioneRoster[]>();
    for (const v of board?.violazioni ?? []) {
      for (const t of v.turni) {
        if (!t.assegnazioneId) continue;
        const l = m.get(t.assegnazioneId);
        if (l) l.push(v); else m.set(t.assegnazioneId, [v]);
      }
    }
    return m;
  }, [board?.violazioni]);
  /* si contano solo quelle che sul tabellone hanno un turno segnato: col tabellone di
     un solo DSS, una violazione fra turni di altri DSS qui non si vedrebbe */
  const violazioniVisibili = useMemo(() => {
    const visibili = new Set((board?.assignments ?? []).map((a) => a.id));
    return (board?.violazioni ?? []).filter((v) => v.turni.some((t) => t.assegnazioneId && visibili.has(t.assegnazioneId)));
  }, [board?.violazioni, board?.assignments]);
  const contaViolazioni = useMemo(() => ({
    aperte: violazioniVisibili.filter((v) => !v.forzata).length,
    forzate: violazioniVisibili.filter((v) => v.forzata).length,
  }), [violazioniVisibili]);
  /* i giorni visibili con turni pubblicati e i programmi da cui vengono */
  const giorniPubblicati = useMemo(() => (board?.days ?? []).filter(d => (board?.pubblicati?.[d]?.length ?? 0) > 0).length, [board]);

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
      {/* il crocino: le regole le scrive dipingiCroce */}
      <style ref={croceRef} />
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
        {/* da dove vengono i turni: solo dalla pubblicazione (che è dello Scheduling) */}
        {(() => {
          const testo = board?.programmi?.length
            ? <span>Turni pubblicati: <b className="font-semibold">{board.programmi.map(p => p.nome).join(" · ")}</b> · {giorniPubblicati}/{board.days.length} giorni</span>
            : <span>Nessun turno pubblicato{puoPubblicare && <> · <b className="font-semibold">Pubblica</b></>}</span>;
          return puoPubblicare ? (
            <Link href={`/roster/pubblicazione${psProjectId ? `?psProjectId=${psProjectId}` : ""}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 text-xs text-slate-200 whitespace-nowrap"
              title="I turni del roster arrivano solo dalla pubblicazione: qui si sceglie per periodo quali turni guida mandare">
              <Send className="w-3.5 h-3.5 text-violet-400" />{testo}
            </Link>
          ) : (
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300 whitespace-nowrap"
              title="I turni li pubblica l'ufficio turni (permesso Scheduling)">
              <Send className="w-3.5 h-3.5 text-violet-400" />{testo}
            </span>
          );
        })()}
        <div className="flex items-center gap-1 rounded-lg border border-slate-700 px-1 py-0.5">
          <button onClick={() => setFrom(shiftDate(from, -RANGE_DAYS))} className="p-1.5 rounded hover:bg-white/10" title="Periodo precedente"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-xs font-mono px-2 flex items-center gap-1.5"><CalendarDays className="w-3.5 h-3.5 text-violet-400" />{dayLabel(from).dm} – {dayLabel(shiftDate(from, RANGE_DAYS - 1)).dm}</span>
          <button onClick={() => setFrom(shiftDate(from, RANGE_DAYS))} className="p-1.5 rounded hover:bg-white/10" title="Periodo successivo"><ChevronRight className="w-4 h-4" /></button>
          <button onClick={() => setFrom(mondayOf(new Date()))} className="text-[11px] px-2 py-1 rounded hover:bg-white/10 text-slate-300" title="Torna a oggi">Oggi</button>
        </div>
        <span className="text-[10px] text-slate-500 hidden xl:inline">← scorri il tabellone per vedere le {RANGE_DAYS} giornate</span>

        {/* Strumenti: puntatore (il click non cambia niente), gomma, cambio turno */}
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-700 p-0.5" role="group" aria-label="Strumenti del tabellone">
          {([
            ["puntatore", MousePointer2, "Puntatore", "Puntatore (V): il click seleziona la cella e ci ferma la croce; non cambia niente", "bg-slate-700 text-white"],
            ["gomma", Eraser, "Gomma", "Gomma (G): clicca una cella per cancellarne turno e voci (il turno torna fra gli scoperti)", "bg-rose-500/25 text-rose-100"],
            ["cambio", ArrowLeftRight, "Cambio turno", "Cambio turno (C): clicca il turno di una persona, poi un'altra persona nello stesso giorno: i due turni si scambiano", "bg-amber-500/25 text-amber-100"],
          ] as const).map(([k, Icona, testo, aiuto, attivo]) => (
            <button key={k} onClick={() => scegliStrumento(k)} aria-pressed={tool === k} title={aiuto}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400 ${
                tool === k ? attivo : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}>
              <Icona className="w-3.5 h-3.5" /> <span className="hidden md:inline">{testo}</span>
            </button>
          ))}
        </div>

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
                    onClick={() => { scegliStrumento("puntatore"); setArmedVoce({ category: cat, code: v.code, label: v.label }); setVoceMenu(null); }}
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

        {pin && (
          <span className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg border border-sky-500/40 bg-sky-500/10 text-[11px] text-sky-100 whitespace-nowrap"
            title="Cella fissata: la croce resta qui. Clicca di nuovo la cella, o premi Esc, per lasciarla">
            <Pin className="w-3 h-3" /> {nomeDi(pin.r)} · {quandoDi(pin.c)}
            <button onClick={() => setPin(null)} className="p-0.5 rounded hover:bg-sky-500/20" aria-label="Lascia la cella"><X className="w-3 h-3" /></button>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden lg:flex items-center gap-1 text-[10px] text-slate-500"><Scissors className="w-3 h-3" /> Q taglia · <ClipboardPaste className="w-3 h-3" /> W incolla · V G C strumenti</span>
          <Link href="/roster/anagrafica" className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs">
            Anagrafica
          </Link>
          <button onClick={() => setEditDriver("new")} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium"
            title={personale ? "Nuovo conducente" : "Nuovo conducente fittizio (per i conducenti veri serve il permesso «Personale»)"}>
            <UserPlus className="w-3.5 h-3.5" /> {personale ? "Conducente" : "Fittizio"}
          </button>
          {datiProva && <button onClick={() => { if (confirm("Creare 30 conducenti di prova (fittizi, senza matricola) con foto, depositi diversi e rotazioni riposi?")) seedMut.mutate(); }} disabled={seedMut.isPending} className="px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs disabled:opacity-50">
            +30 fittizi
          </button>}
        </div>
      </div>

      {/* legenda: calendario aziendale (le righette sopra i giorni) e depositi (le righette accanto ai conducenti) */}
      {(calendarioQ.data || legendaDepositi.length > 0 || contaViolazioni.aperte + contaViolazioni.forzate > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1 border-b border-slate-800 bg-slate-900/60 text-[10px] text-slate-400">
          {/* riposi troppo corti e turni sovrapposti nei giorni visibili */}
          {contaViolazioni.aperte + contaViolazioni.forzate > 0 && (
            <span className="inline-flex items-center gap-2" title={violazioniVisibili.slice(0, 12).map((v) => `${v.forzata ? "(forzato) " : ""}${nomeDi(v.conducenteId)}: ${v.testo}`).join("\n")}>
              {contaViolazioni.aperte > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-200 border border-rose-500/40">
                  <AlertTriangle className="w-3 h-3" /> {contaViolazioni.aperte} da controllare
                </span>
              )}
              {contaViolazioni.forzate > 0 && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-200 border border-amber-500/30">
                  <AlertTriangle className="w-3 h-3" /> {contaViolazioni.forzate} forzati
                </span>
              )}
              <span>riposi e sovrapposizioni</span>
            </span>
          )}
          {calendarioQ.data && (
            <>
              <span title={calendarioQ.data.calendario.nota ?? undefined}>
                Calendario aziendale{calendarioQ.data.calendario.nome ? `: ${calendarioQ.data.calendario.nome}` : ""}
                {!calCompilato && <span className="ml-1 text-amber-300/90">· non compilato, solo domeniche e festivi</span>}
              </span>
              {legendaCal.map(l => (
                <span key={l.testo} className="inline-flex items-center gap-1">
                  <span className="inline-block w-3 h-1.5 rounded-sm" style={{ background: l.colore }} /> {l.testo}
                </span>
              ))}
            </>
          )}
          {legendaDepositi.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 sm:ml-auto">
              <span>Depositi</span>
              {legendaDepositi.map(d => (
                <span key={d.codice} className="inline-flex items-center gap-1" title={spiegaColore(d)}>
                  <span className="inline-block w-1.5 h-3 rounded-sm" style={{ background: d.colore }} /> {d.nome}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

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
          <button onClick={() => scegliStrumento("puntatore")} className="ml-auto underline hover:no-underline">Chiudi</button>
        </div>
      )}

      {/* cambio turno attivo */}
      {tool === "cambio" && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-[11px] text-amber-100 flex items-center gap-2 shrink-0" aria-live="polite">
          <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
          {swapFrom ? (
            <span>
              Cambio turno: <b>{swapFrom.dutyCode}</b> di <b>{nomeDi(swapFrom.driverId)}</b> · {quandoDi(swapFrom.day)} — ora <b>clicca un'altra persona</b>,
              nella stessa colonna o sul nome. Esc per scegliere un altro turno.
            </span>
          ) : (
            <span>Cambio turno — <b>clicca il turno</b> da scambiare, poi l'altra persona. Esc per uscire.</span>
          )}
          {swapMut.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <button onClick={() => scegliStrumento("puntatore")} className="ml-auto underline hover:no-underline">Chiudi</button>
        </div>
      )}

      {/* ── Tabellone (sopra) + turni scoperti (finestra in basso) ── */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Tabellone a tutta larghezza */}
        <div ref={boardScrollRef} onScroll={() => mirrorScroll("board")} className="flex-1 min-w-0 overflow-auto">
          {boardQ.isLoading ? (
            <div className="p-10 text-center text-slate-500 text-sm flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carico il tabellone…</div>
          ) : !board || board.drivers.length === 0 ? (
            <div className="p-10 text-center text-slate-500 text-sm">Nessun conducente. {datiProva ? "Aggiungine uno o genera operatori fittizi." : "Aggiungili dall'Anagrafica personale."}</div>
          ) : (
            <table className={`roster-board min-w-full text-xs border-collapse ${tool === "puntatore" && !armedVoce ? "cursor-default" : ""}`}
              onMouseOver={onBoardOver} onMouseLeave={onBoardLeave}>
              <thead className="sticky top-0 bg-slate-900 z-30">
                <tr>
                  <th className={`text-left px-2 py-1 border-b border-slate-800 sticky left-0 z-20 bg-slate-900 ${nameColW}`}>Conducente</th>
                  {board.days.map((day) => {
                    const { dow, dm } = dayLabel(day);
                    const unc = uncoveredByDay.get(day)?.length ?? 0;
                    return (
                      <th key={day} data-c={day} className={`px-1 py-1 border-b border-slate-800 text-center ${dayColW} ${festBg(day)}`}>
                        {(() => {
                          const r = righetta(day);
                          return r ? <span className="block h-1.5 -mx-1 -mt-1 mb-1 rounded-b-sm" style={{ background: r.colore }} title={r.testo} aria-label={r.testo} /> : null;
                        })()}
                        <span className={`uppercase text-[9px] ${festLevel(day) ? "text-rose-300/80" : "text-slate-500"}`}>{dow} </span>
                        <span className="font-semibold text-[11px]">{dm}</span>
                        {cellSize !== "small" && (
                          !giornoPubblicato(day)
                            ? <span className="block text-[9px] font-mono text-slate-500" title="Nessun turno pubblicato per questo giorno">non pubbl.</span>
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
                  const dep = depositoDi(drv);
                  return (
                    <tr key={drv.id} data-r={drv.id} className={isSel ? "bg-violet-500/10" : "odd:bg-white/[0.02]"}>
                      <td className={`pl-3 pr-2 py-0.5 border-b border-slate-800/40 sticky left-0 z-20 cursor-pointer ${isSel ? "bg-violet-950" : "bg-slate-950"}`}
                          style={tool === "cambio" && swapFrom ? { cursor: CURSORE.cambio } : undefined}
                          onClick={() => {
                            /* col cambio turno avviato, il nome è un bersaglio: lo scambio è nel giorno del turno scelto */
                            if (tool === "cambio" && swapFrom) swapClick(drv.id, null, null);
                            else setSelDriver(isSel ? null : drv.id);
                          }}>
                        {/* la righetta del deposito: lo stesso colore dei suoi turni */}
                        {dep ? (
                          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1" style={{ background: dep.colore }} title={`Deposito ${dep.nome} — ${spiegaColore(dep)}`} />
                        ) : drv.residenzaServizio ? (
                          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-[repeating-linear-gradient(180deg,#64748b_0_3px,transparent_3px_6px)]" title={`Deposito «${drv.residenzaServizio}» fuori elenco: niente colore`} />
                        ) : null}
                        <div className="flex items-center gap-1.5">
                          <DriverAvatar drv={drv} size={avatarSize} bordo={dep?.colore} />
                          <div className="min-w-0 flex-1">
                            {/* Nome su riga propria (meno troncato); matricola e simboli sotto */}
                            <div className="font-medium truncate text-[12px] leading-tight">{driverLabel(drv)}</div>
                            <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 mt-0.5">
                              {drv.matricola && <span className="text-[9px] font-mono text-slate-500">{drv.matricola}</span>}
                              {drv.isFictitious && <span className="text-[7px] px-1 rounded bg-violet-500/15 text-violet-300">fittizio</span>}
                              {drv.abilitazioni?.length > 0 && <AbilitazioneBadges keys={drv.abilitazioni} size={9} />}
                            </div>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); setEditDriver(drv.id); }} className="p-0.5 rounded text-slate-500 hover:text-violet-300 shrink-0" title="Anagrafica conducente"><Pencil className="w-3 h-3" /></button>
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
                        const cellClick = () => {
                          if (armedVoce) placeVoce(drv.id, day);
                          else if (tool === "gomma") eraseCell(drv.id, day);
                          else if (tool === "cambio") swapClick(drv.id, day, null);
                          else {
                            /* puntatore: seleziona e ferma la croce (un altro click la lascia); incolla solo se c'è un turno in taglio */
                            setSelDriver(drv.id);
                            setPin((p) => (p && p.r === drv.id && p.c === day ? null : { r: drv.id, c: day }));
                            if (cut && cut.day === day) doPaste(drv.id);
                          }
                        };
                        return (
                          <td key={day} data-c={day}
                            onClick={cellClick}
                            style={!armedVoce && CURSORE[tool] ? { cursor: CURSORE[tool] } : undefined}
                            className={`px-0.5 py-0.5 border-b border-slate-800/40 text-center align-middle ${festBg(day)} ${
                              armedVoce ? "cursor-crosshair" : ""
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
                                      const a = it.a;
                                      const scelto = swapFrom?.id === a.id;
                                      /* riposo troppo corto o sovrapposizione: rosso da controllare, ambra se forzato */
                                      const sue = violazioniDi.get(a.id) ?? [];
                                      const daControllare = sue.some((v) => !v.forzata);
                                      const avvisoTurno = sue.length
                                        ? `\n\n${sue.map((v) => `${v.forzata ? "Forzato: " : "⚠ "}${v.testo}`).join("\n")}`
                                        : "";
                                      /* il canale: turno non più pubblicato quel giorno (da riassegnare), o giorno mai pubblicato */
                                      const orfano = a.stato === "da_riassegnare";
                                      const statoTurno = orfano
                                        ? "Da riassegnare: questo turno non è più pubblicato per il giorno. Incolla qui un turno pubblicato per sostituirlo, o toglilo con la Gomma.\n\n"
                                        : a.stato === "non_pubblicato" ? "Giorno non pubblicato: assegnazione di prima della pubblicazione.\n\n" : "";
                                      const ricollegata = a.ricollegata
                                        ? `\n\nPassato qui da ${a.ricollegata.prima.codice} con la pubblicazione del ${new Date(a.ricollegata.il).toLocaleDateString("it-IT")} (stesse corse e orari).`
                                        : "";
                                      const etichettaUdp = (board?.pubblicati?.[day]?.length ?? 0) > 1 ? udpDi(day, a.dssId) : null;
                                      return (
                                        <button key={a.id}
                                          /* col puntatore il click passa alla cella (seleziona, croce); col cambio turno sceglie QUESTO turno */
                                          onClick={tool === "cambio" ? (e) => { e.stopPropagation(); swapClick(drv.id, day, a); } : undefined}
                                          onContextMenu={(e) => { e.stopPropagation(); openDutyContext(e, duty, a.dssId); }}
                                          aria-pressed={tool === "cambio" ? scelto : undefined}
                                          title={statoTurno + (etichettaUdp ? `${etichettaUdp}\n` : "") + (tool === "cambio"
                                            ? (scelto ? "Turno scelto: ora clicca un'altra persona (un altro click lo lascia)" : swapFrom ? `Scambia con ${swapFrom.dutyCode}` : "Scegli questo turno da scambiare")
                                            : "Tasto destro: dettaglio · per toglierlo la Gomma, per scambiarlo il Cambio turno") + avvisoTurno + ricollegata}
                                          aria-description={[orfano ? "Da riassegnare" : "", ...sue.map((v) => v.testo)].filter(Boolean).join(". ") || undefined}
                                          className={`relative w-full rounded font-bold leading-tight ${tool === "cambio" ? "hover:opacity-80" : "cursor-default"} ${big ? dutyBigCls : "px-1 py-0.5 text-[9px]"} ${
                                            orfano ? "text-amber-100 border-2 border-dashed border-amber-400 bg-slate-900"
                                              : a.stato === "non_pubblicato" ? "text-white opacity-60" : "text-white"
                                          } ${
                                            scelto ? "ring-2 ring-amber-300 ring-offset-2 ring-offset-slate-950"
                                              : daControllare ? "ring-2 ring-rose-500 ring-offset-1 ring-offset-slate-950"
                                                : sue.length ? "ring-1 ring-amber-400/80" : ""
                                          }`}
                                          style={{ ...(orfano ? {} : { backgroundColor: resColor(duty) }), ...(tool === "cambio" ? { cursor: CURSORE.cambio } : {}) }}>
                                          {sue.length > 0 && (
                                            <span aria-hidden className={`absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full flex items-center justify-center shadow ${daControllare ? "bg-rose-500" : "bg-amber-400 text-slate-900"}`}>
                                              <AlertTriangle className="w-2.5 h-2.5" />
                                            </span>
                                          )}
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
                                      /* niente × sulla voce: col puntatore il click non toglie niente, per toglierla c'è la Gomma */
                                      <div key={en.id}
                                        className={`w-full font-bold leading-none ${voceTextColor(en.category, en.code)} ${big ? voceBigCls : "text-[11px] py-0.5"}`}
                                        title={`${vociQ.data?.[en.category]?.find((v) => v.code === en.code)?.label ?? en.category} · per toglierla la Gomma`}>
                                        {en.code}
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
        {board && (
          <div className={`shrink-0 border-t border-slate-800 bg-slate-900/50 flex flex-col ${showUncovered ? "h-44" : "h-8"}`}>
            <div className="px-3 h-8 shrink-0 border-b border-slate-800 text-xs font-semibold text-slate-300 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Turni scoperti per giorno
              <span className="text-[10px] font-normal text-slate-500">tasto destro per il dettaglio · Q taglia · W incolla</span>
              {daRiassegnare.length > 0 && (
                <span className="text-[10px] font-normal px-1.5 py-0.5 rounded border border-dashed border-amber-400 text-amber-200"
                  title="Turni assegnati che una ripubblicazione ha tolto senza trovare un turno uguale: incollaci sopra un turno pubblicato o toglili con la Gomma">
                  {daRiassegnare.length} da riassegnare
                </span>
              )}
              <button onClick={() => setShowUncovered((v) => !v)} className="ml-auto text-[11px] text-slate-400 hover:text-slate-100">
                {showUncovered ? "Nascondi ▾" : "Mostra ▸"}
              </button>
            </div>
            {showUncovered && (
              <div ref={uncoveredScrollRef} onScroll={() => mirrorScroll("unc")} onMouseOver={onBoardOver} onMouseLeave={onBoardLeave}
                className="roster-unc flex-1 min-h-0 overflow-x-auto overflow-y-hidden flex">
                {board?.days.map((day) => {
                  const list = uncoveredByDay.get(day) ?? [];
                  return (
                    <div key={day} data-c={day} className={`w-28 shrink-0 border-r border-slate-800/70 flex flex-col min-h-0 ${festBg(day)}`}>
                      {(() => {
                        const r = righetta(day);
                        return r ? <span className="block h-1 shrink-0" style={{ background: r.colore }} title={r.testo} /> : null;
                      })()}
                      <div className={`px-2 py-1 shrink-0 text-[10px] uppercase tracking-wide border-b border-slate-800/60 flex items-center justify-between ${festLevel(day) ? "text-rose-300/80" : "text-slate-400"}`}>
                        <span>{dayLabel(day).dow} {dayLabel(day).dm}</span>
                        <span className={!giornoPubblicato(day) ? "text-slate-500" : list.length ? "text-amber-400" : "text-emerald-400"}>{giornoPubblicato(day) ? list.length : "—"}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto p-1 space-y-1">
                        {!giornoPubblicato(day) ? (
                          puoPubblicare ? (
                            <Link href={`/roster/pubblicazione${psProjectId ? `?psProjectId=${psProjectId}` : ""}`} className="block text-[10px] text-slate-500 px-1 hover:text-violet-300">
                              non pubblicato · <span className="underline">pubblica</span>
                            </Link>
                          ) : <div className="text-[10px] text-slate-500 px-1">non pubblicato</div>
                        ) : list.length === 0 ? (
                          <div className="text-[10px] text-emerald-400/60 px-1">tutto coperto</div>
                        ) : list.map(({ duty: d, dssId: dss, udpNome }) => {
                          const isSel = selDuty?.day === day && selDuty?.code === d.code && selDuty?.dssId === dss;
                          const isCut = cut?.day === day && cut?.code === d.code && cut?.dssId === dss;
                          const piuUdp = (board?.pubblicati?.[day]?.length ?? 0) > 1;
                          return (
                            <button key={`${day}|${dss}|${d.code}`}
                              onClick={() => setSelDuty(isSel ? null : { day, code: d.code, dssId: dss })}
                              onContextMenu={(e) => openDutyContext(e, d, dss)}
                              title={piuUdp && udpNome ? udpNome : undefined}
                              className={`w-full text-left px-1.5 py-1 rounded border flex items-center gap-1.5 transition-colors ${
                                isCut ? "border-amber-500/70 bg-amber-500/10" : isSel ? "border-violet-500/70 bg-violet-500/10" : "border-slate-800 hover:border-violet-500/40"
                              }`}>
                              <span className="px-1 py-0.5 rounded text-white text-[10px] font-bold shrink-0" style={{ backgroundColor: resColor(d) }}>{d.code}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[10px] text-slate-200 leading-tight">{d.start ?? "?"}–{d.end ?? "?"}</span>
                                <span className="block text-[9px] text-slate-500 leading-tight truncate">{piuUdp && udpNome ? udpNome : (d.type ?? "turno")}{d.tripsCount ? ` · ${d.tripsCount}c` : ""}</span>
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
        <DriverEditDialog driverId={editDriver === "new" ? null : editDriver} fittizio={editDriver === "new" && !personale} onClose={() => setEditDriver(null)} />
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
            <div ref={eraseChoiceRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="gomma-titolo"
              className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-sm flex flex-col text-slate-100 outline-none" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
                <div id="gomma-titolo" className="text-sm font-semibold flex items-center gap-2"><Eraser className="w-4 h-4 text-rose-400" /> Cosa vuoi togliere?</div>
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

      {/* Cambio turno verso chi quel giorno è assente: si chiede prima */}
      {swapAsk && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={() => setSwapAsk(null)}>
          <div ref={swapAskRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="scambio-titolo"
            className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md flex flex-col text-slate-100 outline-none" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div id="scambio-titolo" className="text-sm font-semibold flex items-center gap-2"><ArrowLeftRight className="w-4 h-4 text-amber-400" /> Chi riceve il turno è assente</div>
              <button onClick={() => setSwapAsk(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800" aria-label="Chiudi"><X className="h-4 w-4" /></button>
            </div>
            <ul className="px-4 py-3 space-y-1.5 text-xs text-slate-200 list-disc list-inside">
              {swapAsk.avvisi.map((a) => <li key={a}>{a}</li>)}
            </ul>
            <p className="px-4 pb-3 text-[11px] text-slate-500">Si spostano solo i turni: le assenze e le altre voci restano dove sono.</p>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800">
              <button onClick={() => setSwapAsk(null)} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
              <button onClick={() => { const { avvisi: _a, ...s } = swapAsk; setSwapAsk(null); swapMut.mutate(s); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-amber-600 text-white hover:bg-amber-500">
                <ArrowLeftRight className="w-4 h-4" /> Scambia lo stesso
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Riposo troppo corto o turni sovrapposti: si può assegnare lo stesso */}
      {avviso && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4" onClick={() => setAvviso(null)}>
          <div ref={avvisoRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="avviso-titolo" aria-describedby="avviso-elenco"
            className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg flex flex-col text-slate-100 outline-none" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <div id="avviso-titolo" className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" /> {avviso.titolo}
              </div>
              <button onClick={() => setAvviso(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800" aria-label="Chiudi"><X className="h-4 w-4" /></button>
            </div>
            <ul id="avviso-elenco" className="px-4 py-3 space-y-2 max-h-[50vh] overflow-auto">
              {avviso.violazioni.map((v, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed">
                  <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                    v.regola === "sovrapposizione" ? "bg-rose-500/20 text-rose-200" : "bg-amber-500/15 text-amber-200"
                  }`}>{v.regola === "sovrapposizione" ? "Sovrapposti" : "Riposo"}</span>
                  <span className="text-slate-200">
                    <b className="font-semibold">{nomeDi(v.conducenteId)}: </b>{v.testo}
                    {v.presunto && <span className="block text-[11px] text-slate-400 mt-0.5">Per togliere il dubbio, indica se l'Unità di Progettazione è urbana o extraurbana in Planning Studio.</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="px-4 pb-3 text-[11px] text-slate-400">
              Puoi procedere lo stesso: il turno resta segnato come forzato, con il tuo nome e l'ora.
            </p>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-800">
              <button onClick={() => setAvviso(null)} className="px-3 py-1.5 text-sm rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800">Annulla</button>
              <button onClick={() => { const a = avviso; setAvviso(null); a.forza(); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-amber-600 text-white hover:bg-amber-500">
                <AlertTriangle className="w-4 h-4" /> {avviso.conferma}
              </button>
            </div>
          </div>
        </div>
      )}

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
            {tratteQ.isLoading ? (
              <div className="text-[10px] text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Carico le tratte…</div>
            ) : (tratteQ.data?.segments ?? []).length === 0 ? (
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
                  {(tratteQ.data?.segments ?? []).map((s, i) => {
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
