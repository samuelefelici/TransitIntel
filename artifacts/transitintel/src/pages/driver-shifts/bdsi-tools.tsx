/* ═══════════════════════════════════════════════════════════════
 *  Strumenti BDSI per il Workspace Turni Guida
 *  - Stato di verifica + forzatura (§10.1)
 *  - Ricerca a chips (cap. 7)
 *  - Riassunti tipologia × residenza con drill-down (cap. 15)
 *  - Vista copertura turni macchina (§2.2)
 *  - "Scambia con pezzo…" (§12.2) e "Turni unici" (§12.1)
 *  - Editor vincoli globali di soluzione (cap. 14)
 * ═══════════════════════════════════════════════════════════════ */
import React, { useMemo, useState } from "react";
import { Search, X, Shield, Repeat, Loader2, Wand2, Bus } from "lucide-react";
import type { DriverShiftData, DriverShiftType, RipresaTrip, Ripresa, VincoloGlobale } from "./types";
import { TYPE_LABELS, TYPE_COLORS } from "./constants";

/* ───────────────────────────────────────────────────────────────
 *  STATO DI VERIFICA (§10.1)
 * ─────────────────────────────────────────────────────────────── */

export type VerifyState = NonNullable<DriverShiftData["verifyState"]>;

/** Stato di verifica effettivo di un turno (fallback su bdsValidation). */
export function effectiveVerifyState(s: DriverShiftData): VerifyState | null {
  if (s.verifyState) return s.verifyState;
  if (!s.bdsValidation) return null;
  return s.bdsValidation.valid ? "conforme" : "scorretto";
}

export const VERIFY_BADGE: Record<VerifyState, { label: string; cls: string }> = {
  da_verificare: { label: "⏳ DA VERIFICARE", cls: "bg-zinc-500/15 text-zinc-300" },
  conforme: { label: "✅ BDS", cls: "bg-amber-500/15 text-amber-300" },
  scorretto: { label: "❌ BDS", cls: "bg-red-500/15 text-red-400" },
  forzato: { label: "🔵 FORZATO", cls: "bg-blue-500/15 text-blue-300" },
};

export function VerifyBadge({ shift }: { shift: DriverShiftData }) {
  const st = effectiveVerifyState(shift);
  if (!st) return null;
  const b = VERIFY_BADGE[st];
  const nViol = shift.bdsValidation?.violations.length ?? 0;
  const title = st === "forzato"
    ? `Forzato dall'operatore${shift.forcedReason ? `: ${shift.forcedReason}` : ""}${nViol ? ` (${nViol} violazioni ignorate)` : ""}`
    : st === "da_verificare"
      ? "Modificato a mano: verifica in corso…"
      : (shift.bdsValidation?.valid ? "Conforme BDS" : shift.bdsValidation?.violations.join(", ") ?? "");
  return (
    <span title={title} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${b.cls}`}>
      {st === "scorretto" && nViol ? `${b.label} (${nViol})` : b.label}
    </span>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  RICERCA A CHIPS (cap. 7) — filtro con espressioni semplici
 *  Token supportati (spazio = AND):
 *    linea:7  res:Ancona  tipo:spezzato  stato:scorretto|conforme|forzato|da_verificare
 *    nastro>555  nastro<300  lavoro>420  lavoro<200  guida>240
 *    cambi>0  corse<5  deposito (inizia o finisce in deposito=ha trasferimento)
 *    testo libero → match su driverId
 * ─────────────────────────────────────────────────────────────── */

export function matchShiftQuery(s: DriverShiftData, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const routeNames = new Set<string>();
  let nCorse = 0;
  for (const r of s.riprese) for (const t of r.trips) { routeNames.add(String(t.routeName ?? "").toLowerCase()); nCorse++; }
  const drivingMin = s.workCalculation?.driving ?? null;

  const cmp = (val: number | null, op: string, ref: number) => {
    if (val == null) return false;
    return op === ">" ? val > ref : op === "<" ? val < ref : val === ref;
  };
  const parseRef = (raw: string): number => {
    // "6:30" → 390 min, altrimenti numero (minuti)
    if (raw.includes(":")) { const [h, m] = raw.split(":"); return (Number(h) || 0) * 60 + (Number(m) || 0); }
    return Number(raw) || 0;
  };

  for (const tok of tokens) {
    let m = tok.match(/^(nastro|lavoro|guida|cambi|corse)([<>=])(.+)$/);
    if (m) {
      const val = m[1] === "nastro" ? s.nastroMin
        : m[1] === "lavoro" ? s.workMin
        : m[1] === "guida" ? drivingMin
        : m[1] === "cambi" ? s.cambiCount
        : nCorse;
      if (!cmp(val, m[2], parseRef(m[3]))) return false;
      continue;
    }
    m = tok.match(/^(linea|res|tipo|stato):(.+)$/);
    if (m) {
      const v = m[2];
      if (m[1] === "linea") { if (![...routeNames].some(r => r.includes(v))) return false; }
      else if (m[1] === "res") { if (!String(s.residenzaName ?? "").toLowerCase().includes(v)) return false; }
      else if (m[1] === "tipo") { if (!s.type.toLowerCase().startsWith(v)) return false; }
      else { const st = effectiveVerifyState(s); if (!st || !st.startsWith(v)) return false; }
      continue;
    }
    if (tok === "deposito") { if (!(s.transferMin > 0 || s.transferBackMin > 0)) return false; continue; }
    // testo libero → driverId
    if (!s.driverId.toLowerCase().includes(tok)) return false;
  }
  return true;
}

const RECENT_KEY = "tg_ricerche_recenti";

export function SearchChipsBar({ query, onChange }: { query: string; onChange: (q: string) => void }) {
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
  });
  const commit = (q: string) => {
    onChange(q);
    const t = q.trim();
    if (!t) return;
    setRecent(prev => {
      const next = [t, ...prev.filter(x => x !== t)].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* full */ }
      return next;
    });
  };
  const QUICK = ["stato:scorretto", "stato:forzato", "tipo:spezzato", "cambi>0", "deposito"];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={e => onChange(e.target.value)}
            onBlur={e => commit(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); }}
            placeholder='Cerca… es. linea:2 tipo:spezzato nastro>9:00 stato:scorretto'
            className="w-full bg-background/60 border border-border/40 rounded-lg pl-8 pr-8 py-1.5 text-xs focus:outline-none focus:border-orange-500/50"
          />
          {query && (
            <button onClick={() => onChange("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {QUICK.map(q => (
          <button key={q} onClick={() => commit(query.includes(q) ? query.replace(q, "").trim() : `${query} ${q}`.trim())}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${query.includes(q) ? "bg-orange-500/20 border-orange-500/50 text-orange-300" : "border-border/40 text-muted-foreground hover:text-foreground"}`}>
            {q}
          </button>
        ))}
        {recent.filter(r => !QUICK.includes(r)).slice(0, 3).map(r => (
          <button key={r} onClick={() => commit(r)}
            className="text-[10px] px-2 py-0.5 rounded-full border border-border/30 text-muted-foreground/70 hover:text-foreground italic">
            ↺ {r}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  RIASSUNTI tipologia × residenza (cap. 15) con drill-down
 * ─────────────────────────────────────────────────────────────── */

interface RiassuntoCell {
  residenza: string;
  tipo: DriverShiftType | "tutti";
  n: number;
  pct: number;          // % sui turni della residenza
  lavoroMedio: number;
  nastroMedio: number;
  sfridoTot: number;    // Σ (nastro - lavoro)
}

export function buildRiassunti(shifts: DriverShiftData[]): { residenze: string[]; cells: RiassuntoCell[] } {
  const byRes = new Map<string, DriverShiftData[]>();
  for (const s of shifts) {
    const key = s.residenzaName || "Senza residenza";
    if (!byRes.has(key)) byRes.set(key, []);
    byRes.get(key)!.push(s);
  }
  const cells: RiassuntoCell[] = [];
  const tipi: (DriverShiftType | "tutti")[] = ["tutti", "intero", "semiunico", "spezzato", "supplemento", "invalido"];
  for (const [res, group] of byRes) {
    for (const tipo of tipi) {
      const sel = tipo === "tutti" ? group : group.filter(s => s.type === tipo);
      if (!sel.length) continue;
      cells.push({
        residenza: res, tipo, n: sel.length,
        pct: Math.round(sel.length / group.length * 1000) / 10,
        lavoroMedio: Math.round(sel.reduce((a, s) => a + s.workMin, 0) / sel.length),
        nastroMedio: Math.round(sel.reduce((a, s) => a + s.nastroMin, 0) / sel.length),
        sfridoTot: sel.reduce((a, s) => a + Math.max(0, s.nastroMin - s.workMin), 0),
      });
    }
  }
  return { residenze: [...byRes.keys()].sort(), cells };
}

const fmtH = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, "0")}`;

export function RiassuntiTable({ shifts, onDrill }: {
  shifts: DriverShiftData[];
  onDrill: (residenza: string | null, tipo: DriverShiftType | null) => void;
}) {
  const { residenze, cells } = useMemo(() => buildRiassunti(shifts), [shifts]);
  if (!shifts.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-muted-foreground border-b border-border/30">
            <th className="text-left py-1.5 pr-2 font-medium">Residenza</th>
            <th className="text-left py-1.5 pr-2 font-medium">Tipologia</th>
            <th className="text-right py-1.5 px-2 font-medium">N°</th>
            <th className="text-right py-1.5 px-2 font-medium">%</th>
            <th className="text-right py-1.5 px-2 font-medium">Lavoro medio</th>
            <th className="text-right py-1.5 px-2 font-medium">Nastro medio</th>
            <th className="text-right py-1.5 pl-2 font-medium">Sfrido tot.</th>
          </tr>
        </thead>
        <tbody>
          {residenze.flatMap(res =>
            cells.filter(c => c.residenza === res).map((c, i) => (
              <tr key={`${res}_${c.tipo}`}
                className={`border-b border-border/10 hover:bg-orange-500/5 ${c.tipo === "tutti" ? "font-semibold" : ""}`}>
                <td className="py-1 pr-2 text-muted-foreground">{i === 0 ? res : ""}</td>
                <td className="py-1 pr-2">
                  {c.tipo === "tutti"
                    ? <span className="text-foreground">Tutti</span>
                    : <span style={{ color: TYPE_COLORS[c.tipo as DriverShiftType] }}>{TYPE_LABELS[c.tipo as DriverShiftType]}</span>}
                </td>
                <td className="py-1 px-2 text-right">
                  <button
                    title="Mostra questi turni nella lista (drill-down)"
                    onClick={() => onDrill(res === "Senza residenza" ? null : res, c.tipo === "tutti" ? null : c.tipo as DriverShiftType)}
                    className="underline decoration-dotted hover:text-orange-300 cursor-zoom-in">
                    {c.n}
                  </button>
                </td>
                <td className="py-1 px-2 text-right text-muted-foreground">{c.pct}%</td>
                <td className="py-1 px-2 text-right">{fmtH(c.lavoroMedio)}</td>
                <td className="py-1 px-2 text-right">{fmtH(c.nastroMedio)}</td>
                <td className="py-1 pl-2 text-right text-muted-foreground">{fmtH(c.sfridoTot)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      <p className="text-[9px] text-muted-foreground/60 mt-1.5">
        Clicca su un N° per vedere quei turni nella lista (come gli "occhiali" del riassunto BDS). Sfrido = nastro − lavoro.
      </p>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  COPERTURA TURNI MACCHINA (§2.2)
 * ─────────────────────────────────────────────────────────────── */

export interface CoverageSegment {
  tripId: string;
  routeName: string;
  startMin: number;
  endMin: number;
  driverId: string | null;   // null = pezzo scoperto
}
export interface VehicleCoverage {
  vehicleId: string;
  vehicleType: string;
  startMin: number;
  endMin: number;
  segments: CoverageSegment[];
  uncoveredPieces: { trips: RipresaTrip[]; startMin: number; endMin: number }[];
}

/** Costruisce la copertura per blocco vettura: corse del TM × chi le copre. */
export function buildCoverage(vehicleShifts: any[], driverShifts: DriverShiftData[]): VehicleCoverage[] {
  const tripToDriver = new Map<string, string>();
  for (const d of driverShifts) for (const r of d.riprese) for (const t of r.trips) tripToDriver.set(String(t.tripId), d.driverId);

  const out: VehicleCoverage[] = [];
  for (const vs of vehicleShifts ?? []) {
    const trips = (vs.trips ?? []).filter((t: any) => t.type === "trip" && t.departureMin != null);
    if (!trips.length) continue;
    const segments: CoverageSegment[] = trips.map((t: any) => ({
      tripId: String(t.tripId),
      routeName: String(t.routeName ?? t.routeId ?? ""),
      startMin: t.departureMin,
      endMin: t.arrivalMin,
      driverId: tripToDriver.get(String(t.tripId)) ?? null,
    }));
    // pezzi scoperti = run contigui di corse senza conducente
    const uncovered: VehicleCoverage["uncoveredPieces"] = [];
    let cur: any[] = [];
    for (const t of trips) {
      if (!tripToDriver.has(String(t.tripId))) cur.push(t);
      else if (cur.length) { uncovered.push(_mkPiece(cur)); cur = []; }
    }
    if (cur.length) uncovered.push(_mkPiece(cur));
    out.push({
      vehicleId: String(vs.vehicleId),
      vehicleType: String(vs.vehicleType ?? "12m"),
      startMin: trips[0].departureMin,
      endMin: trips[trips.length - 1].arrivalMin,
      segments,
      uncoveredPieces: uncovered,
    });
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

function _mkPiece(trips: any[]): { trips: RipresaTrip[]; startMin: number; endMin: number } {
  return {
    trips: trips.map((t: any) => ({
      tripId: String(t.tripId), routeId: String(t.routeId ?? ""), routeName: String(t.routeName ?? t.routeId ?? ""),
      headsign: t.headsign ?? null, departureTime: t.departureTime ?? "", arrivalTime: t.arrivalTime ?? "",
      departureMin: t.departureMin, arrivalMin: t.arrivalMin,
      firstStopName: t.firstStopName, lastStopName: t.lastStopName,
    })),
    startMin: trips[0].departureMin,
    endMin: trips[trips.length - 1].arrivalMin,
  };
}

const DRIVER_PALETTE = ["#fb923c", "#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#facc15", "#22d3ee", "#fca5a5", "#86efac", "#c4b5fd"];

export function CoveragePanel({ coverage, onFocusDriver, onSwapPiece, onTurnoUnico }: {
  coverage: VehicleCoverage[];
  onFocusDriver: (driverId: string) => void;
  onSwapPiece: (vehicleId: string, vehicleType: string, piece: { trips: RipresaTrip[] }) => void;
  onTurnoUnico: (vehicleId: string, vehicleType: string, piece: { trips: RipresaTrip[] }) => void;
}) {
  const driverColor = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const v of coverage) for (const s of v.segments) {
      if (s.driverId && !map.has(s.driverId)) map.set(s.driverId, DRIVER_PALETTE[i++ % DRIVER_PALETTE.length]);
    }
    return map;
  }, [coverage]);

  if (!coverage.length) return <p className="text-xs text-muted-foreground">Nessun turno macchina caricato.</p>;
  const globalStart = Math.min(...coverage.map(v => v.startMin));
  const globalEnd = Math.max(...coverage.map(v => v.endMin));
  const span = Math.max(1, globalEnd - globalStart);
  const nUncovered = coverage.reduce((a, v) => a + v.uncoveredPieces.length, 0);

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] text-muted-foreground">
        Ogni riga è un turno macchina; i colori indicano il turno guida che copre le corse.
        {nUncovered > 0
          ? <span className="text-red-400 font-medium"> {nUncovered} pezz{nUncovered === 1 ? "o scoperto" : "i scoperti"}</span>
          : <span className="text-amber-300"> Tutte le corse sono coperte.</span>}
      </p>
      {coverage.map(v => (
        <div key={v.vehicleId} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[10px] font-mono text-muted-foreground flex items-center gap-1">
            <Bus className="w-3 h-3 text-orange-400/60" />{v.vehicleId}
          </span>
          <div className="relative flex-1 h-5 bg-background/60 rounded overflow-hidden border border-border/20">
            {v.segments.map(s => {
              const left = ((s.startMin - globalStart) / span) * 100;
              const width = Math.max(0.4, ((s.endMin - s.startMin) / span) * 100);
              const color = s.driverId ? (driverColor.get(s.driverId) ?? "#888") : undefined;
              return (
                <button
                  key={s.tripId}
                  title={`${s.routeName} ${fmtH(s.startMin)}→${fmtH(s.endMin)} · ${s.driverId ? `turno ${s.driverId}` : "SCOPERTA"}`}
                  onClick={() => s.driverId && onFocusDriver(s.driverId)}
                  className="absolute top-0.5 bottom-0.5 rounded-sm"
                  style={{
                    left: `${left}%`, width: `${width}%`,
                    background: color ?? "repeating-linear-gradient(45deg, rgba(239,68,68,.55), rgba(239,68,68,.55) 3px, rgba(239,68,68,.2) 3px, rgba(239,68,68,.2) 6px)",
                    cursor: s.driverId ? "pointer" : "default",
                  }}
                />
              );
            })}
          </div>
          {v.uncoveredPieces.length > 0 && (
            <div className="flex items-center gap-1 shrink-0">
              {v.uncoveredPieces.map((p, pi) => (
                <span key={pi} className="flex items-center gap-0.5">
                  <button onClick={() => onSwapPiece(v.vehicleId, v.vehicleType, p)}
                    title={`Scambia con pezzo… (${p.trips.length} corse ${fmtH(p.startMin)}→${fmtH(p.endMin)})`}
                    className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25">
                    <Repeat className="w-2.5 h-2.5 inline mr-0.5" />assorbi
                  </button>
                  <button onClick={() => onTurnoUnico(v.vehicleId, v.vehicleType, p)}
                    title="Crea un turno unico da questo pezzo"
                    className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25">
                    <Wand2 className="w-2.5 h-2.5 inline mr-0.5" />turno unico
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 flex-wrap pt-1">
        {[...driverColor.entries()].slice(0, 14).map(([d, c]) => (
          <button key={d} onClick={() => onFocusDriver(d)} className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: c }} />{d}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  APPLY: inserisce un pezzo in un turno guida (per swap/insert e
 *  per aggiungere i turni unici). Client-side, poi si ri-verifica.
 * ─────────────────────────────────────────────────────────────── */

function mkRipresaFromTrips(trips: RipresaTrip[], vehicleId: string, vehicleType: string): Ripresa {
  const sorted = [...trips].sort((a, b) => a.departureMin - b.departureMin);
  const start = sorted[0].departureMin;
  const end = sorted[sorted.length - 1].arrivalMin;
  return {
    startTime: fmtH(start), endTime: fmtH(end), startMin: start, endMin: end,
    preTurnoMin: 0, transferMin: 0, transferType: "none",
    transferBackMin: 0, transferBackType: "none",
    workMin: end - start, vehicleIds: [vehicleId], vehicleType,
    cambi: [], trips: sorted.map(t => ({ ...t, vehicleId, vehicleType })),
  };
}

/** Inserisce le corse di un pezzo in un turno: nella ripresa che le contiene
 * temporalmente, oppure come nuova ripresa. Rimuove eventuali releasedTripIds. */
export function applyPieceToShift(
  shifts: DriverShiftData[],
  driverId: string,
  piece: { trips: RipresaTrip[] },
  vehicleId: string,
  vehicleType: string,
  releasedTripIds: Set<string>,
): { shifts: DriverShiftData[]; released: RipresaTrip[] } {
  const released: RipresaTrip[] = [];
  const next = shifts.map(s => {
    if (s.driverId !== driverId) return s;
    let riprese = s.riprese.map(r => ({ ...r, trips: [...r.trips] }));
    // 1. rilascia le corse dello scambio
    if (releasedTripIds.size) {
      riprese = riprese.map(r => {
        const keep = r.trips.filter(t => {
          if (releasedTripIds.has(String(t.tripId))) { released.push(t); return false; }
          return true;
        });
        return { ...r, trips: keep };
      }).filter(r => r.trips.length > 0);
    }
    // 2. inserisci il pezzo: nella ripresa che si sovrappone/adiacente, o nuova
    const sorted = [...piece.trips].sort((a, b) => a.departureMin - b.departureMin);
    const pStart = sorted[0].departureMin;
    const pEnd = sorted[sorted.length - 1].arrivalMin;
    const host = riprese.find(r => pStart <= r.endMin + 60 && pEnd >= r.startMin - 60);
    if (host) {
      host.trips = [...host.trips, ...sorted.map(t => ({ ...t, vehicleId, vehicleType }))]
        .sort((a, b) => a.departureMin - b.departureMin);
      host.startMin = Math.min(host.startMin, pStart);
      host.endMin = Math.max(host.endMin, pEnd);
      host.startTime = fmtH(host.startMin);
      host.endTime = fmtH(host.endMin);
      if (!host.vehicleIds.includes(vehicleId)) host.vehicleIds = [...host.vehicleIds, vehicleId];
    } else {
      riprese = [...riprese, mkRipresaFromTrips(sorted, vehicleId, vehicleType)]
        .sort((a, b) => a.startMin - b.startMin);
    }
    // 3. aggiorna aggregati base (nastro); lavoro/validazione arrivano dalla ri-verifica
    const allStart = Math.min(...riprese.map(r => r.startMin));
    const allEnd = Math.max(...riprese.map(r => r.endMin));
    return {
      ...s, riprese,
      nastroStartMin: allStart, nastroEndMin: allEnd,
      nastroStart: fmtH(allStart), nastroEnd: fmtH(allEnd),
      nastroMin: allEnd - allStart,
      verifyState: "da_verificare" as const,
    };
  });
  return { shifts: next, released };
}

/* ───────────────────────────────────────────────────────────────
 *  EDITOR VINCOLI GLOBALI (cap. 14)
 * ─────────────────────────────────────────────────────────────── */

const TIPOLOGIE: DriverShiftType[] = ["intero", "semiunico", "spezzato", "supplemento"];

export function VincoliGlobaliEditor({ vincoli, onChange }: {
  vincoli: VincoloGlobale[];
  onChange: (v: VincoloGlobale[]) => void;
}) {
  const upd = (i: number, patch: Partial<VincoloGlobale>) =>
    onChange(vincoli.map((v, vi) => vi === i ? { ...v, ...patch } : v));
  const numInput = (i: number, key: keyof VincoloGlobale, ph: string, title?: string) => (
    <input type="number" min={0} placeholder={ph} title={title}
      value={(vincoli[i][key] as number | null | undefined) ?? ""}
      onChange={e => upd(i, { [key]: e.target.value === "" ? null : Number(e.target.value) } as any)}
      className="w-16 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px] focus:outline-none focus:border-orange-500/50" />
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold text-orange-300 flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5" /> Vincoli globali di soluzione
        </p>
        <div className="flex gap-1">
          {(["numerico", "percentuale", "media"] as const).map(tipo => (
            <button key={tipo}
              onClick={() => onChange([...vincoli, {
                tipo, tipologie: ["spezzato"],
                ...(tipo === "media" ? { misura: "lavoro" as const } : {}),
              }])}
              className="text-[10px] px-2 py-0.5 rounded border border-border/40 text-muted-foreground hover:text-foreground hover:border-orange-500/40">
              + {tipo}
            </button>
          ))}
        </div>
      </div>
      {vincoli.length === 0 && (
        <p className="text-[10px] text-muted-foreground/70">
          Nessun vincolo. Esempi: max 4 spezzati · min 60% interi · lavoro medio interi ≥ 6:30.
          I vincoli guidano il solver in modo quasi-rigido e il risultato riporta se sono soddisfatti.
        </p>
      )}
      {vincoli.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-wrap bg-background/40 border border-border/20 rounded-lg px-2 py-1.5">
          <span className="text-[10px] uppercase font-bold text-orange-300/80 w-20">{v.tipo}</span>
          <div className="flex gap-1">
            {TIPOLOGIE.map(t => (
              <button key={t}
                onClick={() => upd(i, {
                  tipologie: v.tipologie.includes(t)
                    ? v.tipologie.filter(x => x !== t)
                    : [...v.tipologie, t],
                })}
                className={`text-[9px] px-1.5 py-0.5 rounded border ${v.tipologie.includes(t) ? "border-orange-500/60 text-orange-300 bg-orange-500/10" : "border-border/30 text-muted-foreground"}`}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          {v.tipo === "numerico" && (<>
            <span className="text-[10px] text-muted-foreground">min</span>{numInput(i, "min", "-")}
            <span className="text-[10px] text-muted-foreground">max</span>{numInput(i, "max", "-", "numero massimo di turni")}
          </>)}
          {v.tipo === "percentuale" && (<>
            <span className="text-[10px] text-muted-foreground">min%</span>{numInput(i, "minPct", "-")}
            <span className="text-[10px] text-muted-foreground">max%</span>{numInput(i, "maxPct", "-", "% sul totale dei turni")}
          </>)}
          {v.tipo === "media" && (<>
            <select value={v.misura ?? "lavoro"} onChange={e => upd(i, { misura: e.target.value as any })}
              className="bg-background/60 border border-border/40 rounded px-1 py-1 text-[10px]">
              <option value="lavoro">lavoro</option><option value="nastro">nastro</option><option value="guida">guida</option>
            </select>
            <span className="text-[10px] text-muted-foreground">min (minuti)</span>{numInput(i, "minMin", "-")}
            <span className="text-[10px] text-muted-foreground">max</span>{numInput(i, "maxMin", "-")}
          </>)}
          {v.tipo !== "media" && (
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={!!v.perResidenza} onChange={e => upd(i, { perResidenza: e.target.checked })} className="accent-orange-500" />
              per residenza
            </label>
          )}
          <button onClick={() => onChange(vincoli.filter((_, vi) => vi !== i))}
            className="ml-auto text-muted-foreground hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

/** Report soddisfacimento vincoli (metrics.vincoliGlobali dal solver). */
export function VincoliReport({ report }: { report: any[] | null | undefined }) {
  if (!report?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {report.map((r, i) => (
        <span key={i}
          title={(r.dettaglio ?? []).map((d: any) => `${d.scope ?? "totale"}: ${d.attuale}${r.tipo === "percentuale" ? "%" : r.tipo === "media" ? " min" : ""} (${d.count}/${d.totale})`).join(" · ")}
          className={`text-[10px] px-2 py-0.5 rounded-full border ${r.soddisfatto ? "bg-amber-500/10 border-amber-500/30 text-amber-300" : "bg-red-500/10 border-red-500/30 text-red-400"}`}>
          {r.soddisfatto ? "✓" : "✗"} {r.label}
        </span>
      ))}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  DIALOG "SCAMBIA CON PEZZO…" (§12.2)
 * ─────────────────────────────────────────────────────────────── */

export interface SwapProposal {
  driverId: string;
  kind: "insert" | "swap";
  releasedTrips: any[];
  valid: boolean;
  newType: string;
  violations: string[];
  deltaWorkMin: number;
}

export function SwapDialog({ open, piece, proposals, loading, onApply, onClose }: {
  open: boolean;
  piece: { vehicleId: string; trips: RipresaTrip[] } | null;
  proposals: SwapProposal[];
  loading: boolean;
  onApply: (p: SwapProposal) => void;
  onClose: () => void;
}) {
  if (!open || !piece) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border/50 rounded-2xl max-w-lg w-full p-4 space-y-3" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-bold flex items-center gap-2">
          <Repeat className="w-4 h-4 text-orange-400" /> Scambia con pezzo…
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Pezzo scoperto: <b className="text-foreground">{piece.trips.length} corse</b> su vettura {piece.vehicleId}
          ({fmtH(piece.trips[0]?.departureMin ?? 0)} → {fmtH(piece.trips[piece.trips.length - 1]?.arrivalMin ?? 0)}).
          Turni che possono assorbirlo — validati con la stessa normativa del solver:
        </p>
        {loading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> <span className="text-xs">Valuto gli scambi…</span>
          </div>
        ) : proposals.length === 0 ? (
          <p className="text-xs text-red-400 py-4 text-center">Nessun turno può assorbire questo pezzo (né con inserimento né con scambio).</p>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {proposals.map((p, i) => (
              <div key={i} className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${p.valid ? "border-amber-500/30 bg-amber-500/5" : "border-border/30 bg-background/40"}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold">
                    {p.kind === "insert" ? "➕ Inserisci in" : "🔁 Scambia con"} <span className="font-mono">{p.driverId}</span>
                    <span className="text-[10px] text-muted-foreground ml-1">→ {p.newType}, Δlavoro {p.deltaWorkMin > 0 ? "+" : ""}{p.deltaWorkMin}′</span>
                  </p>
                  {p.kind === "swap" && p.releasedTrips.length > 0 && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      rilascia {p.releasedTrips.length} corse ({p.releasedTrips.map((t: any) => t.routeName).filter(Boolean).slice(0, 3).join(", ")}…) → tornano scoperte
                    </p>
                  )}
                  {!p.valid && <p className="text-[10px] text-red-400 truncate">{p.violations.slice(0, 2).join("; ")}</p>}
                </div>
                <button onClick={() => onApply(p)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg shrink-0 ${p.valid ? "bg-orange-500 text-black hover:bg-orange-400" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
                  Applica
                </button>
              </div>
            ))}
          </div>
        )}
        <button onClick={onClose} className="w-full text-xs py-1.5 rounded-lg border border-border/40 text-muted-foreground hover:text-foreground">Chiudi</button>
      </div>
    </div>
  );
}
