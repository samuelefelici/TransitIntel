/* ═══════════════════════════════════════════════════════════════
 *  LETTURA DEL RISULTATO DEI TURNI GUIDA
 *
 *  I pannelli che si leggono dopo un calcolo: come ha ragionato
 *  l'algoritmo, la classifica degli scenari CP-SAT, le distribuzioni,
 *  i cluster usati, la conformità, i riassunti per tipologia e residenza
 *  (BDSI cap. 15) e l'elenco dei turni con la ricerca (BDSI cap. 7).
 *  Vengono dalla pagina /driver-shifts; qui sono componenti che ricevono
 *  il risultato e non tengono altro stato che i filtri di lettura.
 * ═══════════════════════════════════════════════════════════════ */
import React, { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, Clock, ChevronDown, ChevronUp, Bus, BarChart3, AlertTriangle, TrendingUp,
  Coffee, Shield, Repeat, Car,
  Trophy, Flame, ListOrdered, Sparkles, Target, Gauge, Brain, Lightbulb, Activity, Wand2,
} from "lucide-react";
import { toast } from "sonner";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type {
  DriverShiftType, DriverShiftData, DriverShiftsResult, ScenarioResult, OptimizationAnalysis, HandoverInfo,
} from "./types";
import {
  SearchChipsBar, matchShiftQuery, RiassuntiTable, VerifyBadge, effectiveVerifyState,
} from "./bdsi-tools";
import { TYPE_LABELS, TYPE_COLORS, TYPE_DESC, formatDuration, minToTime } from "./constants";

/* ───────────────────────────────────────────────────────────────
 *  DISTRIBUZIONI: per tipologia e per ore di lavoro
 * ─────────────────────────────────────────────────────────────── */
export function GraficiDistribuzione({ result }: { result: DriverShiftsResult }) {
  const typeDistData = useMemo(() => {
    return (Object.entries(result.summary.byType) as [DriverShiftType, number][])
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({
        name: TYPE_LABELS[type],
        count,
        color: TYPE_COLORS[type],
      }));
  }, [result]);

  const workDistData = useMemo(() => {
    const buckets: Record<string, number> = {};
    for (const ds of result.driverShifts) {
      const h = Math.floor(ds.workMin / 60);
      const label = `${h}h`;
      buckets[label] = (buckets[label] || 0) + 1;
    }
    return Object.entries(buckets)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([label, count]) => ({ label, count }));
  }, [result]);

  return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Type distribution */}
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><BarChart3 className="w-4 h-4 text-orange-400" /> Distribuzione per Tipo</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={typeDistData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={90} />
                  <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" name="Turni" radius={[0, 4, 4, 0]}>
                    {typeDistData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* Type legend with limits */}
              <div className="mt-3 space-y-1">
                {(Object.entries(TYPE_LABELS) as [DriverShiftType, string][]).map(([type, label]) => {
                  const count = result.summary.byType[type] || 0;
                  if (count === 0) return null;
                  return (
                    <div key={type} className="flex items-center gap-2 text-[10px]">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                      <span className="font-medium">{label}</span>
                      <span className="text-muted-foreground">{count} turni</span>
                      <span className="text-muted-foreground/60">— {TYPE_DESC[type]}</span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Work duration distribution */}
          <Card className="bg-muted/30 border-border/30">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><TrendingUp className="w-4 h-4 text-orange-400" /> Distribuzione Ore Lavoro</h3>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={workDistData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                  <ReTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" name="Turni" fill="#f97316" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="mt-2 text-[10px] text-muted-foreground text-center">
                Target: 6h30–6h42 di lavoro effettivo per turno
              </div>
            </CardContent>
          </Card>
        </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  CLUSTER DI CAMBIO usati dal calcolo
 * ─────────────────────────────────────────────────────────────── */
export function ClusterDelRisultato({ result }: { result: DriverShiftsResult }) {
  return (
    <>
          {result.clusters && result.clusters.length > 0 && (
            <Card className="bg-muted/30 border-border/30">
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><Repeat className="w-4 h-4 text-orange-400" /> Cluster di Cambio in Linea</h3>
                <p className="text-xs text-muted-foreground mb-3">
                  Zone dove i conducenti possono scambiarsi il veicolo durante il servizio. Il conducente subentrante arriva dal deposito (Via Bocconi 35) guidando un'auto aziendale che lascia al capolinea. Il conducente uscente prende l'auto e rientra al deposito.
                </p>
                <div className="flex flex-wrap gap-2">
                  {result.clusters.map(c => (
                    <div key={c.id} className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
                      <div className="w-2 h-2 rounded-full bg-orange-400" />
                      <div>
                        <div className="text-xs font-medium">{c.name}</div>
                        <div className="text-[10px] text-muted-foreground">Trasf. deposito: {c.transferMin} min</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <Car className="w-3.5 h-3.5" />
                  <span>{result.companyCars} auto aziendali disponibili per trasferimenti deposito ↔ cluster</span>
                </div>
              </CardContent>
            </Card>
          )}
    </>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  CONFORMITÀ NORMATIVA
 * ─────────────────────────────────────────────────────────────── */
export function ConformitaNormativa({ result }: { result: DriverShiftsResult }) {
  return (
        <Card className="bg-muted/30 border-border/30">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3"><Shield className="w-4 h-4 text-orange-400" /> Conformità Normativa</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className={`rounded-lg p-3 border ${result.summary.semiunicoPct <= 12 ? "bg-amber-500/10 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Semiunici ≤ 12%</div>
                <div className={`text-2xl font-bold ${result.summary.semiunicoPct <= 12 ? "text-amber-300" : "text-red-400"}`}>
                  {result.summary.semiunicoPct}%
                </div>
                <div className="text-[10px] text-muted-foreground">{result.summary.byType.semiunico} su {result.summary.totalDriverShifts} autisti</div>
              </div>
              <div className={`rounded-lg p-3 border ${result.summary.spezzatoPct <= 13 ? "bg-amber-500/10 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Spezzati ≤ 13%</div>
                <div className={`text-2xl font-bold ${result.summary.spezzatoPct <= 13 ? "text-amber-300" : "text-red-400"}`}>
                  {result.summary.spezzatoPct}%
                </div>
                <div className="text-[10px] text-muted-foreground">{result.summary.byType.spezzato} su {result.summary.totalDriverShifts} autisti</div>
              </div>
              <div className={`rounded-lg p-3 border ${result.summary.avgWorkMin >= 380 && result.summary.avgWorkMin <= 420 ? "bg-amber-500/10 border-amber-500/30" : "bg-amber-500/5 border-amber-500/20"}`}>
                <div className="text-[10px] text-muted-foreground mb-1">Lavoro medio target 6h30–6h42</div>
                <div className={`text-2xl font-bold ${result.summary.avgWorkMin >= 380 && result.summary.avgWorkMin <= 420 ? "text-amber-300" : "text-amber-400"}`}>
                  {formatDuration(result.summary.avgWorkMin)}
                </div>
                <div className="text-[10px] text-muted-foreground">media per turno</div>
              </div>
            </div>
            {/* BDS per-check breakdown */}
            {result.driverShifts.some(s => s.bdsValidation) && (() => {
              const withBds = result.driverShifts.filter(s => s.bdsValidation);
              const checks: [string, keyof NonNullable<DriverShiftData["bdsValidation"]>][] = [
                ["CE 561/2006", "cee561"], ["Pasto", "intervalloPasto"],
                ["Stacco min.", "staccoMinimo"], ["Nastro", "nastro"], ["Riprese", "riprese"],
              ];
              return (
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {checks.map(([label, key]) => {
                    const ok = withBds.filter(s => s.bdsValidation![key] === true).length;
                    const pct = Math.round((ok / withBds.length) * 100);
                    return (
                      <div key={key} className={`rounded-lg p-2 border text-center ${pct === 100 ? "bg-amber-500/10 border-amber-500/30" : "bg-amber-500/5 border-amber-500/20"}`}>
                        <div className="text-[10px] text-muted-foreground mb-0.5">{label}</div>
                        <div className={`text-lg font-bold ${pct === 100 ? "text-amber-300" : "text-amber-400"}`}>{pct}%</div>
                        <div className="text-[9px] text-muted-foreground">{ok}/{withBds.length}</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </CardContent>
        </Card>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  ELENCO DEI TURNI, con il dettaglio cronologico di ciascuno
 * ─────────────────────────────────────────────────────────────── */
export function ElencoTurni({ shifts, forzaTurno, sbloccaTurno }: {
  shifts: DriverShiftData[];
  /** BDSI §10.1.3: l'operatore dichiara conforme un turno scorretto. Senza, il comando non compare. */
  forzaTurno?: (driverId: string) => void;
  sbloccaTurno?: (driverId: string) => void;
}) {
  const [expandedShifts, setExpandedShifts] = useState<Set<string>>(new Set());
  const toggleShift = (id: string) => {
    setExpandedShifts(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  return (
    <div className="space-y-1">
            {shifts.map(shift => {
              const isExpanded = expandedShifts.has(shift.driverId);
              const typeColor = TYPE_COLORS[shift.type];
              return (
                <div key={shift.driverId} className="bg-background/50 rounded-lg overflow-hidden">
                  <button onClick={() => toggleShift(shift.driverId)} className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/30 transition-colors">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: typeColor }} />
                    <span className="font-mono font-medium text-xs">{shift.driverId}</span>
                    <Badge variant="outline" className="text-[10px]" style={{ borderColor: typeColor, color: typeColor }}>
                      {TYPE_LABELS[shift.type]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {(shift.nastroStart ?? "").slice(0, 5)} → {(shift.nastroEnd ?? "").slice(0, 5)}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      Lavoro: {shift.work} · Nastro: {shift.nastro}
                      {shift.interruption && <> · Pausa: {shift.interruption}</>}
                      {shift.cambiCount > 0 && (() => {
                        const intraH = shift.handovers?.filter(h => h.cutType === "intra").length ?? 0;
                        const icon = intraH > 0 ? " ✂️" : ((shift.handovers?.length ?? 0) > 0 ? " 🔄" : "");
                        return <> · <span className={intraH > 0 ? "text-amber-400" : "text-orange-400"}>{shift.cambiCount} cambi{icon}</span></>;
                      })()}
                      {shift.riprese.length > 0 && <> · {shift.riprese.reduce((s, r) => s + r.trips.length, 0)} corse</>}
                      {shift.costEuro != null && shift.costEuro > 0 && <> · <span className="text-amber-400 font-medium">€{shift.costEuro.toFixed(0)}</span></>}
                    </span>
                    {/* Stato di verifica BDSI (grigio/verde/rosso/blu) */}
                    <VerifyBadge shift={shift} />
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="px-3 pb-3">
                        {/* BDSI §10.1.3 — forzatura correttezza */}
                        {(() => {
                          const st = effectiveVerifyState(shift);
                          if (st === "scorretto") return (
                            <div className="flex items-center gap-2 mb-2 bg-red-500/5 border border-red-500/20 rounded-lg px-2.5 py-1.5">
                              <span className="text-[10px] text-red-400 flex-1">
                                {shift.bdsValidation?.violations.slice(0, 2).join(" · ")}
                              </span>
                              {forzaTurno && <button onClick={() => forzaTurno(shift.driverId)}
                                className="text-[10px] font-semibold px-2 py-1 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 hover:bg-blue-500/25 shrink-0">
                                🔵 Forza correttezza
                              </button>}
                            </div>
                          );
                          if (st === "forzato") return (
                            <div className="flex items-center gap-2 mb-2 bg-blue-500/5 border border-blue-500/20 rounded-lg px-2.5 py-1.5">
                              <span className="text-[10px] text-blue-300 flex-1">
                                Turno forzato dall'operatore{shift.forcedReason ? `: "${shift.forcedReason}"` : ""} — considerato conforme
                                {(shift.bdsValidation?.violations.length ?? 0) > 0 && ` (${shift.bdsValidation!.violations.length} violazioni ignorate)`}
                              </span>
                              {sbloccaTurno && <button onClick={() => sbloccaTurno(shift.driverId)}
                                className="text-[10px] font-semibold px-2 py-1 rounded border border-border/40 text-muted-foreground hover:text-foreground shrink-0">
                                Rimuovi forzatura
                              </button>}
                            </div>
                          );
                          return null;
                        })()}
                        {/* LASCIA / PRENDE vettura labels */}
                        {shift.vehicleHandoverLabels && shift.vehicleHandoverLabels.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {shift.vehicleHandoverLabels.map((lbl, li) => (
                              <div key={li} className={`flex items-center gap-1.5 text-[11px] font-semibold rounded-md px-2.5 py-1.5 border ${
                                /\blascia\b/i.test(lbl) || lbl.startsWith("LASCIA") ? "bg-red-500/10 border-red-500/25 text-red-400" : "bg-amber-500/10 border-amber-500/25 text-amber-300"
                              }`}>
                                <Repeat className="w-3 h-3" />
                                {lbl}
                              </div>
                            ))}
                          </div>
                        )}
                        {shift.riprese.map((rip, ri) => {
                          // ── Build chronological activity list for this ripresa ──
                          const activities: { type: string; startMin: number; endMin: number; label: string; detail?: string; icon: React.ReactNode; colorClass: string; bgClass: string; vehicleId?: string }[] = [];

                          // Handovers for this ripresa (match by vehicle and time: chi monta
                          // all'inizio della ripresa, chi smonta alla fine)
                          const ripSvcS = typeof rip.serviceStartMin === "number" ? rip.serviceStartMin : rip.startMin + (rip.preTurnoMin || 0) + (rip.transferMin || 0);
                          const ripSvcE = typeof rip.serviceEndMin === "number" ? rip.serviceEndMin : rip.endMin - (rip.transferBackMin || 0);
                          const myHandovers = (shift.handovers ?? []).filter(h => {
                            const sameBus = !rip.vehicleIds?.length || rip.vehicleIds.includes(h.vehicleId);
                            const taken = typeof h.takenMin === "number" ? h.takenMin : h.atMin;
                            const t = h.role === "outgoing" ? h.atMin : taken;
                            return sameBus && t >= ripSvcS - 16 && t <= ripSvcE + 16;
                          });
                          const incomingH = myHandovers.find(h => h.role === "incoming");
                          const outgoingH = myHandovers.find(h => h.role === "outgoing");
                          const handoverText = (h: HandoverInfo) => h.description + (h.detail ? ` · ${h.detail}` : "");

                          let cursor = rip.startMin;

                          // 1. Pre-turno
                          if (rip.preTurnoMin > 0) {
                            const end = cursor + rip.preTurnoMin;
                            activities.push({
                              type: "preturno", startMin: cursor, endMin: end,
                              label: "Pre-turno",
                              detail: "Controllo veicolo, foglio di servizio",
                              icon: <Shield className="w-3.5 h-3.5" />,
                              colorClass: "text-orange-400", bgClass: "bg-orange-500/8 border-orange-500/15",
                            });
                            cursor = end;
                          }

                          // 2. Trasferimento a vuoto deposito → capolinea (con auto aziendale)
                          if (rip.transferMin > 0) {
                            const end = cursor + rip.transferMin;
                            const dest = rip.transferToStop || "capolinea";
                            let transferDetail = `Guidi dal Deposito${shift.residenzaName ? ` ${shift.residenzaName}` : ""} a ${dest} con auto aziendale (${rip.transferMin} min)`;
                            if (incomingH) {
                              transferDetail = `Arrivi a ${dest} con auto aziendale per prendere la vettura ${incomingH.vehicleId} dal turno ${incomingH.otherDriver}`;
                            }
                            // Car pool info: quale auto e orari
                            if (rip.carPoolOut) {
                              transferDetail += `\n🚗 ${rip.carPoolOut.description}`;
                            }
                            activities.push({
                              type: "transfer", startMin: cursor, endMin: end,
                              label: `Auto aziendale → ${dest}`,
                              detail: transferDetail,
                              icon: <Car className="w-3.5 h-3.5" />,
                              colorClass: "text-orange-400", bgClass: "bg-orange-500/8 border-orange-500/15",
                              vehicleId: rip.vehicleIds[0],
                            });
                            cursor = end;
                          }

                          // 2b. Incoming handover: autista arriva e prende il bus da un collega
                          if (incomingH) {
                            const isIntra = incomingH.cutType === "intra";
                            const takenAt = typeof incomingH.takenMin === "number" ? incomingH.takenMin : incomingH.atMin;
                            activities.push({
                              type: "handover", startMin: takenAt, endMin: takenAt,
                              label: incomingH.kind === "depot" ? "🏭 Prende la vettura in deposito" : isIntra ? "✂️ Cambio intra-corsa (arrivo)" : "🔄 Prende la vettura",
                              detail: handoverText(incomingH),
                              icon: <Repeat className="w-3.5 h-3.5" />,
                              colorClass: isIntra ? "text-amber-400" : "text-orange-400",
                              bgClass: isIntra ? "bg-amber-500/10 border-amber-500/20" : "bg-orange-500/10 border-orange-500/20",
                            });
                          }

                          // 3. Corse di linea + soste tra corse + cambi in linea
                          for (let ti = 0; ti < rip.trips.length; ti++) {
                            const t = rip.trips[ti];

                            // Cambio in linea — se il veicolo cambia rispetto alla corsa precedente
                            if (ti > 0 && t.vehicleId && rip.trips[ti - 1].vehicleId && t.vehicleId !== rip.trips[ti - 1].vehicleId) {
                              const cambio = rip.cambi?.find(c => Math.abs(c.atMin - t.departureMin) < 10);
                              activities.push({
                                type: "handover", startMin: cursor, endMin: t.departureMin,
                                label: "🔄 Cambio in Linea",
                                detail: cambio
                                  ? `${cambio.clusterName}: ${cambio.fromVehicle} → ${cambio.toVehicle}`
                                  : `${rip.trips[ti - 1].vehicleId} → ${t.vehicleId}`,
                                icon: <Repeat className="w-3.5 h-3.5" />,
                                colorClass: "text-orange-400", bgClass: "bg-orange-500/10 border-orange-500/20",
                                vehicleId: t.vehicleId,
                              });
                            }

                            // Sosta prima della corsa (gap tra cursor e partenza)
                            if (t.departureMin > cursor + 1) {
                              activities.push({
                                type: "sosta", startMin: cursor, endMin: t.departureMin,
                                label: "Sosta al capolinea",
                                detail: `Attesa ${t.departureMin - cursor} min`,
                                icon: <Coffee className="w-3.5 h-3.5" />,
                                colorClass: "text-amber-400", bgClass: "bg-amber-500/8 border-amber-500/15",
                                vehicleId: t.vehicleId,
                              });
                            }

                            // Corsa di linea
                            const dur = t.arrivalMin - t.departureMin;
                            const fromStop = t.firstStopName || "—";
                            const toStop = t.lastStopName || t.headsign || "—";
                            activities.push({
                              type: "trip", startMin: t.departureMin, endMin: t.arrivalMin,
                              label: `Linea ${t.routeName}`,
                              detail: `${fromStop} → ${toStop} (${dur} min)`,
                              icon: <Bus className="w-3.5 h-3.5" />,
                              colorClass: "text-amber-400", bgClass: "bg-amber-500/8 border-amber-500/15",
                              vehicleId: t.vehicleId,
                            });
                            cursor = t.arrivalMin;
                          }

                          // 3b. Outgoing handover: autista lascia il bus a un collega
                          if (outgoingH) {
                            const isIntraOut = outgoingH.cutType === "intra";
                            activities.push({
                              type: "handover", startMin: outgoingH.atMin, endMin: outgoingH.atMin,
                              label: outgoingH.kind === "depot" ? "🏭 Lascia la vettura in deposito" : isIntraOut ? "✂️ Cambio intra-corsa (uscita)" : "🔄 Lascia la vettura",
                              detail: handoverText(outgoingH),
                              icon: <Repeat className="w-3.5 h-3.5" />,
                              colorClass: isIntraOut ? "text-amber-400" : "text-orange-400",
                              bgClass: isIntraOut ? "bg-amber-500/10 border-amber-500/20" : "bg-orange-500/10 border-orange-500/20",
                            });
                          }

                          // 4. Rientro a vuoto — guidi auto aziendale al deposito
                          const transferBack = rip.transferBackMin || 0;
                          if (transferBack > 0) {
                            const lastTrip = rip.trips[rip.trips.length - 1];
                            const returnFrom = rip.lastStop || lastTrip?.lastStopName || "capolinea";
                            const returnDur = transferBack > 0 ? transferBack : rip.endMin - cursor;
                            const returnEnd = cursor + returnDur;
                            let returnDetail = `Guidi auto aziendale da ${returnFrom} al Deposito${shift.residenzaName ? ` ${shift.residenzaName}` : ""} (${returnDur} min)`;
                            if (outgoingH) {
                              returnDetail = `Vettura ${outgoingH.vehicleId} lasciata al turno ${outgoingH.otherDriver} — rientri al deposito con auto aziendale`;
                            }
                            // Car pool info: quale auto e orari
                            if (rip.carPoolReturn) {
                              returnDetail += `\n🚗 ${rip.carPoolReturn.description}`;
                            }
                            activities.push({
                              type: "rientro", startMin: cursor, endMin: returnEnd,
                              label: `Rientro da ${returnFrom}`,
                              detail: returnDetail,
                              icon: <Car className="w-3.5 h-3.5" />,
                              colorClass: "text-orange-400", bgClass: "bg-orange-500/8 border-orange-500/15",
                              vehicleId: rip.vehicleIds[rip.vehicleIds.length - 1],
                            });
                          }

                          return (
                            <div key={ri} className="mb-3">
                              {/* Ripresa header */}
                              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                <div className="text-[11px] font-semibold text-foreground/80">
                                  Ripresa {ri + 1}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {(rip.startTime ?? "").slice(0, 5)} → {(rip.endTime ?? "").slice(0, 5)}
                                </div>
                                <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                                  <Bus className="w-3 h-3" />
                                  <span className="font-mono">{rip.vehicleIds.join(", ")}</span>
                                  {rip.vehicleType && <Badge variant="outline" className="text-[9px] py-0 px-1">{rip.vehicleType}</Badge>}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {rip.trips.length} corse · {rip.workMin} min lavoro
                                </div>
                              </div>

                              {/* Chronological timeline */}
                              <div className="relative ml-4 border-l-2 border-border/30 space-y-0">
                                {activities.map((act, ai) => (
                                  <div key={ai} className="relative pl-5 pb-1">
                                    {/* Timeline dot */}
                                    <div className={`absolute left-[-5px] top-[7px] w-2 h-2 rounded-full ${act.type === "trip" ? "bg-amber-400" : act.type === "sosta" ? "bg-amber-400" : act.type === "preturno" ? "bg-orange-400" : act.type === "handover" ? "bg-orange-400" : "bg-orange-400"}`} />
                                    {/* Activity row */}
                                    <div className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs border ${act.bgClass}`}>
                                      <span className={`${act.colorClass} shrink-0`}>{act.icon}</span>
                                      <span className="font-mono font-medium text-foreground/90 min-w-[90px] shrink-0">
                                        {minToTime(act.startMin)} → {minToTime(act.endMin)}
                                      </span>
                                      <span className={`font-semibold ${act.colorClass} min-w-[130px] shrink-0`}>{act.label}</span>
                                      {act.detail && (
                                        <span className="text-muted-foreground flex flex-col">
                                          {act.detail.split('\n').map((line, li) => (
                                            <span key={li} className={li > 0 ? "text-[10px] text-amber-400/80" : "truncate"}>{line}</span>
                                          ))}
                                        </span>
                                      )}
                                      {act.vehicleId && (
                                        <span className="text-[9px] font-mono text-muted-foreground/70 bg-muted/30 border border-border/20 rounded px-1.5 py-0.5 shrink-0">{act.vehicleId}</span>
                                      )}
                                      <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">{act.endMin - act.startMin} min</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}

                        {/* Interruption between riprese */}
                        {shift.interruptionMin > 0 && shift.riprese.length >= 2 && (
                          <div className="flex items-center gap-2 text-xs bg-amber-500/8 border border-amber-500/15 rounded-md px-3 py-2 my-2">
                            <Coffee className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            <span className="font-mono font-medium text-foreground/90 min-w-[90px]">
                              {(shift.riprese[0]?.endTime ?? "").slice(0, 5)} → {(shift.riprese[1]?.startTime ?? "").slice(0, 5)}
                            </span>
                            <span className="font-semibold text-amber-400">Interruzione</span>
                            <span className="text-muted-foreground">
                              {shift.interruption} — {shift.type === "semiunico" ? "non retribuita, in residenza" : "spezzato, riposo"}
                            </span>
                            <span className="ml-auto text-[10px] text-muted-foreground/60">{shift.interruptionMin} min</span>
                          </div>
                        )}

                        {/* BDS Validation & Work Calculation detail */}
                        {(shift.bdsValidation || shift.workCalculation) && (
                          <div className="mt-3 space-y-2">
                            {/* BDS Validation checks */}
                            {shift.bdsValidation && (
                              <div className={`rounded-lg border p-3 ${shift.bdsValidation.valid ? "bg-amber-500/10 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                                <div className="flex items-center gap-2 mb-2">
                                  <Shield className="w-3.5 h-3.5 text-orange-400" />
                                  <span className="text-xs font-semibold">Validazione BDS</span>
                                  <Badge variant="outline" className={`text-[9px] ${shift.bdsValidation.valid ? "border-amber-500/40 text-amber-300" : "border-red-500/40 text-red-400"}`}>
                                    {shift.bdsValidation.valid ? "CONFORME" : "NON CONFORME"}
                                  </Badge>
                                </div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1">
                                  {([
                                    ["classificazioneValida", "Classificazione"],
                                    ["cee561", "CE 561/2006"],
                                    ["intervalloPasto", "Pasto"],
                                    ["staccoMinimo", "Stacco min."],
                                    ["nastro", "Nastro"],
                                    ["riprese", "Riprese"],
                                  ] as [keyof typeof shift.bdsValidation, string][]).map(([key, label]) => {
                                    const val = shift.bdsValidation![key];
                                    if (typeof val !== "boolean") return null;
                                    return (
                                      <div key={key} className="flex items-center gap-1 text-[10px]">
                                        <span>{val ? "✅" : "❌"}</span>
                                        <span className={val ? "text-amber-300" : "text-red-400"}>{label}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                                {shift.bdsValidation.violations.length > 0 && (
                                  <div className="mt-2 space-y-0.5">
                                    {shift.bdsValidation.violations.map((v, vi) => (
                                      <div key={vi} className="flex items-start gap-1.5 text-[10px] text-red-400">
                                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                                        <span>{v}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Work Calculation breakdown */}
                            {shift.workCalculation && (
                              <div className="rounded-lg border bg-muted/20 border-border/30 p-3">
                                <div className="flex items-center gap-2 mb-2">
                                  <Clock className="w-3.5 h-3.5 text-orange-400" />
                                  <span className="text-xs font-semibold">Calcolo Lavoro BDS</span>
                                  <span className="text-[10px] text-muted-foreground ml-auto">
                                    Netto: <span className="font-semibold text-foreground">{formatDuration(shift.workCalculation.lavoroNetto)}</span>
                                    {" · "}Conv.: <span className="font-semibold text-foreground">{formatDuration(shift.workCalculation.lavoroConvenzionale)}</span>
                                  </span>
                                </div>
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                  {([
                                    ["driving", "Guida", "text-amber-400"],
                                    ["idleAtTerminal", "Soste capolinea", "text-amber-400"],
                                    ["prePost", "Pre/Post turno", "text-orange-400"],
                                    ["transfer", "Trasferimenti", "text-orange-400"],
                                    ["sosteFraRipreseIR", "Soste IR (inter-rip.)", "text-red-400"],
                                    ["sosteFraRipreseFR", "Soste FR (fra rip.)", "text-orange-400"],
                                  ] as [keyof typeof shift.workCalculation, string, string][]).map(([key, label, color]) => {
                                    const val = shift.workCalculation![key];
                                    if (typeof val !== "number" || val === 0) return null;
                                    return (
                                      <div key={key} className="text-[10px]">
                                        <div className="text-muted-foreground">{label}</div>
                                        <div className={`font-semibold ${color}`}>{val} min</div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  SCENARIO RANKING CARD — classifica di tutti gli scenari CP-SAT
 * ═══════════════════════════════════════════════════════════════ */

type SortKey =
  | "rank" | "duties" | "interi" | "semiunici" | "spezzati" | "supplementi"
  | "totalWorkH" | "totalNastroH" | "totalIdleH" | "vuotiSignificativi"
  | "totalCost" | "bdsViolations" | "score" | "elapsed";

export function ScenarioRankingCard({ scenarios }: { scenarios: ScenarioResult[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState(true);
  const [highlight, setHighlight] = useState<number | null>(null);

  const feasible = useMemo(() => scenarios.filter(s => s.feasible), [scenarios]);
  const infeasible = useMemo(() => scenarios.filter(s => !s.feasible), [scenarios]);

  const sorted = useMemo(() => {
    const arr = [...feasible];
    arr.sort((a, b) => {
      const av = (a as any)[sortKey] ?? 0;
      const bv = (b as any)[sortKey] ?? 0;
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [feasible, sortKey, sortDir]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(k);
      setSortDir(k === "rank" || k === "score" || k === "totalCost" || k === "bdsViolations" || k === "totalIdleH" || k === "vuotiSignificativi" ? "asc" : "desc");
    }
  };

  // Best per varie dimensioni (per mettere medagliette)
  const best = useMemo(() => {
    if (feasible.length === 0) return {};
    const min = (k: SortKey) => feasible.reduce((m, s) => ((s as any)[k] < (m as any)[k] ? s : m), feasible[0]);
    const max = (k: SortKey) => feasible.reduce((m, s) => ((s as any)[k] > (m as any)[k] ? s : m), feasible[0]);
    return {
      cheapest: min("totalCost"),
      fewestDuties: min("duties"),
      leastIdle: min("totalIdleH"),
      leastViolations: min("bdsViolations"),
      shortestWork: min("totalWorkH"),
      bestScore: min("score"),
      fewestSupplementi: min("supplementi"),
    };
  }, [feasible]);

  if (scenarios.length === 0) return null;

  const bestScenario = feasible.find(s => s.isBest);

  return (
    <Card className="bg-gradient-to-br from-orange-950/30 via-red-950/10 to-card/30 border-orange-500/30">
      <CardContent className="p-4">
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-2 mb-3 text-left">
          <Flame className="w-5 h-5 text-orange-400" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              Classifica Scenari CP-SAT
              <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-300">
                {feasible.length} fattibili / {scenarios.length} totali
              </Badge>
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              L'ottimizzatore ha esplorato {scenarios.length} configurazioni. Clicca su una colonna per ordinare, seleziona uno scenario per confrontare.
            </p>
          </div>
          {bestScenario && (
            <div className="text-right mr-2">
              <div className="text-[10px] text-muted-foreground">Migliore (score)</div>
              <div className="text-xs font-bold text-orange-400 flex items-center gap-1 justify-end">
                <Trophy className="w-3 h-3" /> #{bestScenario.scenarioNum} · €{bestScenario.totalCost?.toLocaleString("it-IT", { maximumFractionDigits: 0 })}
              </div>
            </div>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="overflow-x-auto rounded-lg border border-orange-500/20 bg-background/40">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-orange-300/70 border-b border-orange-500/20 bg-orange-500/5">
                      {([
                        ["rank", "#", "Ranking (score asc)"],
                        ["duties", "Turni", "Numero totale turni guida"],
                        ["interi", "Interi", "Turni interi"],
                        ["semiunici", "SemiU", "Turni semiunici"],
                        ["spezzati", "Spezz", "Turni spezzati"],
                        ["supplementi", "Suppl", "Supplementi (straordinari)"],
                        ["totalWorkH", "Lavoro h", "Ore lavoro totali"],
                        ["totalNastroH", "Nastro h", "Ore nastro totali"],
                        ["totalIdleH", "Vuoti h", "Ore 'vuote' (nastro - lavoro)"],
                        ["vuotiSignificativi", "N vuoti", "Turni con > 60' di vuoto"],
                        ["totalCost", "€ Costo", "Costo giornaliero"],
                        ["bdsViolations", "BDS", "Violazioni normative"],
                        ["score", "Score", "Punteggio globale (min = meglio)"],
                        ["elapsed", "Sec", "Tempo risoluzione scenario"],
                      ] as [SortKey, string, string][]).map(([k, label, title]) => (
                        <th key={k}
                          title={title}
                          onClick={() => toggleSort(k)}
                          className="px-2 py-2 text-center font-semibold cursor-pointer select-none hover:bg-orange-500/10 transition-colors whitespace-nowrap">
                          <span className="inline-flex items-center gap-0.5">
                            {label}
                            {sortKey === k && (
                              <span className="text-orange-400">
                                {sortDir === "asc" ? "▲" : "▼"}
                              </span>
                            )}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((s, i) => {
                      const isBest = s.isBest;
                      const isHi = highlight === s.scenarioNum;
                      const medals: string[] = [];
                      if (s === (best as any).cheapest) medals.push("💰");
                      if (s === (best as any).fewestDuties) medals.push("📉");
                      if (s === (best as any).leastIdle) medals.push("⚡");
                      if (s === (best as any).leastViolations && s.bdsViolations === 0) medals.push("✅");
                      if (s === (best as any).fewestSupplementi && (s.supplementi ?? 0) === 0) medals.push("🧱");
                      return (
                        <tr key={s.idx}
                          onClick={() => setHighlight(h => h === s.scenarioNum ? null : s.scenarioNum)}
                          className={`border-b border-orange-500/10 cursor-pointer transition-colors ${
                            isBest
                              ? "bg-orange-500/10 hover:bg-orange-500/15"
                              : isHi
                              ? "bg-amber-500/10"
                              : i % 2 === 0 ? "hover:bg-orange-500/5" : "bg-orange-500/[0.02] hover:bg-orange-500/5"
                          }`}>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className="inline-flex items-center gap-1">
                              {isBest && <Trophy className="w-3 h-3 text-orange-400" />}
                              {s.isPolish && <Wand2 className="w-3 h-3 text-amber-400" />}
                              <span className={isBest ? "text-orange-300 font-bold" : "text-muted-foreground"}>
                                #{s.rank ?? "?"}
                              </span>
                              {medals.length > 0 && (
                                <span className="text-[9px]" title={medals.map(m => ({ "💰": "Più economico", "📉": "Meno turni", "⚡": "Meno vuoti", "✅": "0 violazioni BDS", "🧱": "Senza supplementi" }[m as string] || "")).filter(Boolean).join(" · ")}>
                                  {medals.join("")}
                                </span>
                              )}
                            </span>
                            <div className="text-[9px] text-muted-foreground/60 font-normal truncate max-w-[80px]" title={s.params?.strategyLabel || ""}>
                              {s.isPolish ? "🪄 Rifinitura" : (s.params?.strategyLabel || `sc. ${s.scenarioNum}`)}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono font-semibold text-foreground">{s.duties ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-muted-foreground">{s.interi ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={s.semiCompliant ? "text-amber-300" : "text-red-400 font-semibold"}>{s.semiunici ?? "–"}</span>
                            <span className="text-[9px] text-muted-foreground/60 ml-0.5">({s.semiPct ?? 0}%)</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={s.spezCompliant ? "text-amber-300" : "text-red-400 font-semibold"}>{s.spezzati ?? "–"}</span>
                            <span className="text-[9px] text-muted-foreground/60 ml-0.5">({s.spezPct ?? 0}%)</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={(s.supplementi ?? 0) === 0 ? "text-amber-300" : "text-orange-400"}>{s.supplementi ?? "–"}</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono text-foreground/80">{s.totalWorkH?.toFixed(1) ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-foreground/80">{s.totalNastroH?.toFixed(1) ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-orange-400/80">{s.totalIdleH?.toFixed(1) ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-orange-400/80">{s.vuotiSignificativi ?? "–"}</td>
                          <td className="px-2 py-1.5 text-center font-mono font-semibold text-amber-300">
                            {s.totalCost != null ? `€${s.totalCost.toLocaleString("it-IT", { maximumFractionDigits: 0 })}` : "–"}
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono">
                            <span className={(s.bdsViolations ?? 0) === 0 ? "text-amber-300" : "text-red-400 font-semibold"}>
                              {s.bdsViolations ?? 0}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono font-semibold text-foreground">
                            {s.score != null ? s.score.toLocaleString("it-IT", { maximumFractionDigits: 0 }) : "–"}
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono text-[10px] text-muted-foreground">{s.elapsed.toFixed(1)}s</td>
                        </tr>
                      );
                    })}
                    {infeasible.length > 0 && (
                      <tr className="bg-muted/10">
                        <td colSpan={14} className="px-2 py-1.5 text-center text-[10px] text-muted-foreground italic border-t border-orange-500/20">
                          {infeasible.length} scenar{infeasible.length === 1 ? "io" : "i"} non fattibil{infeasible.length === 1 ? "e" : "i"} ({infeasible.map(s => `#${s.scenarioNum}`).join(", ")})
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Legenda medaglie */}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground px-1">
                <span className="inline-flex items-center gap-1"><Trophy className="w-3 h-3 text-orange-400" /> Best score (default)</span>
                <span>💰 Più economico</span>
                <span>📉 Meno turni</span>
                <span>⚡ Meno vuoti</span>
                <span>✅ 0 violazioni BDS</span>
                <span>🧱 0 supplementi</span>
              </div>

              {/* Scheda dettaglio highlighted */}
              {highlight != null && (() => {
                const s = scenarios.find(x => x.scenarioNum === highlight);
                if (!s) return null;
                return (
                  <div className="mt-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
                    <div className="flex items-center gap-2 mb-2">
                      <ListOrdered className="w-4 h-4 text-amber-300" />
                      <span className="text-xs font-semibold">Scenario #{s.scenarioNum} — dettagli</span>
                      <span className="text-[10px] text-muted-foreground">seed {s.params?.seed} · noise {s.params?.noise} · lin {s.params?.linLevel} · {s.params?.nWorkers}w</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                      <MiniStat label="Costo/turno" value={s.costPerDuty != null ? `€${s.costPerDuty.toFixed(0)}` : "–"} />
                      <MiniStat label="Guida tot" value={s.totalDrivingH != null ? `${s.totalDrivingH}h` : "–"} />
                      <MiniStat label="Lavoro/turno" value={s.avgWorkMin != null ? formatDuration(s.avgWorkMin) : "–"} />
                      <MiniStat label="Nastro/turno" value={s.avgNastroMin != null ? formatDuration(s.avgNastroMin) : "–"} />
                      <MiniStat label="Interruzione tot" value={s.totalInterruptionH != null ? `${s.totalInterruptionH}h` : "–"} />
                      <MiniStat label="Trasferimenti tot" value={s.totalTransferH != null ? `${s.totalTransferH}h` : "–"} />
                      <MiniStat label="Vuoto medio" value={s.avgIdleMin != null ? `${s.avgIdleMin}'` : "–"} />
                      <MiniStat label="Obj CP-SAT" value={s.obj?.toLocaleString("it-IT") ?? "–"} />
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-2 py-1 rounded bg-background/40 border border-border/30">
      <div className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-xs font-mono font-semibold text-foreground">{value}</div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
 *  OPTIMIZATION ANALYSIS CARD
 *  Interpretazione in italiano del processo di ottimizzazione
 * ═══════════════════════════════════════════════════════════════ */

export function OptimizationAnalysisCard({ analysis }: { analysis: OptimizationAnalysis }) {
  const [expanded, setExpanded] = useState(true);

  // Interpretazione qualitativa del score spread
  const spread = analysis.scoreSpreadPct;
  const spreadInterpretation =
    spread < 3 ? { label: "convergente", color: "text-amber-300", desc: "Le strategie convergono: la soluzione e' robusta." }
    : spread < 10 ? { label: "moderata", color: "text-amber-400", desc: "Variabilita' normale tra strategie." }
    : { label: "ampia", color: "text-orange-400", desc: "Strategie molto diverse tra loro: il portfolio ha scoperto alternative significative." };

  const coveragePct = Math.round(analysis.strategiesExplored / analysis.totalStrategiesAvailable * 100);

  // Narrativa dinamica
  const narrative = useMemo(() => {
    const parts: string[] = [];
    parts.push(
      `Ho esplorato ${analysis.nScenariosRun} configurazioni diverse dell'ottimizzatore CP-SAT in ${analysis.totalElapsedSec}s, testando ${analysis.strategiesExplored} strategie su ${analysis.totalStrategiesAvailable} disponibili.`
    );
    parts.push(
      `La strategia vincente e' "${analysis.bestStrategyLabel}" (${analysis.bestStrategyDesc.toLowerCase()}).`
    );
    if (analysis.polishImproved) {
      parts.push(
        `La fase di rifinitura finale ha migliorato la soluzione di ${analysis.polishDeltaPct.toFixed(1)}% (-${analysis.polishDeltaScore.toFixed(0)} punti score).`
      );
    } else if (analysis.polishElapsedSec > 0) {
      parts.push(
        `La rifinitura finale non ha trovato miglioramenti: la soluzione era gia' all'ottimo della strategia vincente.`
      );
    }
    if (analysis.nInfeasible > 0) {
      parts.push(`${analysis.nInfeasible} scenari non fattibili sono stati scartati.`);
    }
    return parts.join(" ");
  }, [analysis]);

  return (
    <Card className="bg-gradient-to-br from-amber-950/30 via-orange-950/20 to-card/30 border-amber-500/30">
      <CardContent className="p-4">
        <button onClick={() => setExpanded(e => !e)} className="w-full flex items-start gap-3 text-left">
          <div className="w-9 h-9 shrink-0 rounded-lg bg-gradient-to-br from-amber-500/30 to-orange-500/30 border border-amber-500/40 flex items-center justify-center">
            <Brain className="w-5 h-5 text-amber-300" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
              Analisi Ottimizzazione
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">
                <Sparkles className="w-2.5 h-2.5 mr-1" /> {analysis.bestStrategyLabel}
              </Badge>
              {analysis.polishImproved && (
                <Badge variant="outline" className="text-[10px] border-orange-500/40 text-orange-300">
                  <Wand2 className="w-2.5 h-2.5 mr-1" /> Rifinitura -{analysis.polishDeltaPct.toFixed(1)}%
                </Badge>
              )}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{narrative}</p>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                <AnalysisMetric
                  icon={<ListOrdered className="w-4 h-4" />}
                  label="Scenari esplorati"
                  value={`${analysis.nScenariosRun}/${analysis.nScenariosRequested}`}
                  sub={`${analysis.nFeasible} fattibili · ${analysis.nInfeasible} scartati`}
                  tone="orange"
                />
                <AnalysisMetric
                  icon={<Target className="w-4 h-4" />}
                  label="Strategie testate"
                  value={`${analysis.strategiesExplored}/${analysis.totalStrategiesAvailable}`}
                  sub={`copertura ${coveragePct}% del portfolio`}
                  tone="amber"
                />
                <AnalysisMetric
                  icon={<Gauge className="w-4 h-4" />}
                  label="Variabilita' esplorata"
                  value={`${spread.toFixed(1)}%`}
                  sub={spreadInterpretation.desc}
                  toneClass={spreadInterpretation.color}
                />
                <AnalysisMetric
                  icon={<Activity className="w-4 h-4" />}
                  label="Tempo totale"
                  value={`${analysis.totalElapsedSec}s`}
                  sub={`${analysis.scenarioElapsedSec}s scenari + ${analysis.polishElapsedSec}s rifinitura`}
                  tone="orange"
                />
              </div>

              {/* Strategie a confronto */}
              <div className="mt-4">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80 mb-2 flex items-center gap-1.5">
                  <Flame className="w-3.5 h-3.5" /> Portfolio Strategie (ordinate per score)
                </h4>
                <div className="space-y-1.5">
                  {analysis.strategySummary.map((strat) => {
                    const barWidth = analysis.strategySummary.length > 1
                      ? Math.max(8, 100 - ((strat.bestScore - analysis.strategySummary[0].bestScore) / Math.max(analysis.strategySummary[analysis.strategySummary.length - 1].bestScore - analysis.strategySummary[0].bestScore, 1)) * 92)
                      : 100;
                    return (
                      <div key={strat.key}
                        className={`rounded-md border p-2 transition-colors ${
                          strat.isWinner
                            ? "border-orange-500/40 bg-gradient-to-r from-orange-500/10 to-amber-500/5"
                            : "border-border/30 bg-background/30"
                        }`}>
                        <div className="flex items-center gap-2 mb-1">
                          {strat.isWinner
                            ? <Trophy className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                            : <span className="w-3.5 h-3.5 shrink-0" />}
                          <span className={`text-xs font-semibold ${strat.isWinner ? "text-orange-300" : "text-foreground/90"}`}>
                            {strat.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground flex-1 truncate">— {strat.desc}</span>
                          <div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
                            <span className="text-muted-foreground">{strat.nRuns} run</span>
                            {strat.bestDuties != null && <span className="text-foreground/80">{strat.bestDuties} turni</span>}
                            {strat.bestCost != null && <span className="text-amber-300">€{strat.bestCost.toLocaleString("it-IT", { maximumFractionDigits: 0 })}</span>}
                            <span className={strat.isWinner ? "text-orange-400 font-semibold" : "text-muted-foreground"}>
                              score {strat.bestScore.toLocaleString("it-IT", { maximumFractionDigits: 0 })}
                            </span>
                          </div>
                        </div>
                        <div className="h-1 rounded-full bg-background/60 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${strat.isWinner ? "bg-gradient-to-r from-orange-500 to-red-500" : "bg-amber-500/40"}`}
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Spiegazione tecnica */}
              <div className="mt-4 p-3 rounded-lg border border-amber-500/20 bg-amber-500/5">
                <div className="flex items-start gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    <span className="font-semibold text-amber-300">Come funziona: </span>
                    L'ottimizzatore costruisce un <span className="font-mono text-foreground/80">modello CP-SAT</span> con {analysis.nSegments} segmenti e {analysis.nFeasiblePairs.toLocaleString("it-IT")} coppie candidate.
                    Poi esegue {analysis.nScenariosRequested} scenari in parallelo, ciascuno con pesi differenti
                    {" "}(seed random, perturbazione costi, strategia obiettivo) per esplorare diverse zone dello spazio soluzioni.
                    Dopo aver individuato la strategia migliore, una fase di <span className="font-mono text-foreground/80">rifinitura</span>{" "}
                    riesegue la soluzione vincente con budget triplo e noise zero per convergere verso l'ottimo locale.
                    Intensita corrente: <span className="font-mono text-amber-300">{analysis.intensity}</span>
                    ({analysis.intensity === 1 ? "rapida" : analysis.intensity === 3 ? "approfondita" : "standard"}) · budget totale: <span className="font-mono text-amber-300">{analysis.timeBudgetSec}s</span>.
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

function AnalysisMetric({
  icon, label, value, sub, tone, toneClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: "orange" | "amber" | "red";
  toneClass?: string;
}) {
  const toneMap = {
    orange: "text-orange-300",
    amber: "text-amber-300",
    red: "text-red-400",
  };
  const valueClass = toneClass ?? (tone ? toneMap[tone] : "text-foreground");
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
        <span className={tone ? toneMap[tone] : "text-muted-foreground"}>{icon}</span>
        {label}
      </div>
      <div className={`text-lg font-bold font-mono mt-0.5 ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{sub}</div>}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
 *  TUTTA LA LETTURA, nell'ordine in cui si legge un risultato
 * ─────────────────────────────────────────────────────────────── */
export function LetturaDelRisultato({ result, forzaTurno, sbloccaTurno, copertura }: {
  result: DriverShiftsResult;
  forzaTurno?: (driverId: string) => void;
  sbloccaTurno?: (driverId: string) => void;
  /** Il pannello «Copertura turni macchina»: ha comandi che cambiano i turni, quindi lo dà la pagina.
   *  Riceve la funzione che porta l'elenco su un turno. */
  copertura?: (cerca: (driverId: string) => void) => React.ReactNode;
}) {
  const [typeFilter, setTypeFilter] = useState<DriverShiftType | "all">("all");
  const [residenzaFilter, setResidenzaFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredShifts = useMemo(() => {
    let out = result.driverShifts;
    if (typeFilter !== "all") out = out.filter(s => s.type === typeFilter);
    // BDSI: drill-down dai riassunti (residenza, tipologia) + ricerca a chips
    if (residenzaFilter) out = out.filter(s => (s.residenzaName || null) === residenzaFilter);
    if (searchQuery.trim()) out = out.filter(s => matchShiftQuery(s, searchQuery));
    return out;
  }, [result, typeFilter, residenzaFilter, searchQuery]);

  const cerca = (driverId: string) => { setSearchQuery(driverId); setTypeFilter("all"); setResidenzaFilter(null); };

  return (
    <div className="space-y-4">
      {/* Come ha ragionato l'algoritmo */}
      {result.optimizationAnalysis && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-6 w-1 rounded-full bg-gradient-to-b from-amber-500 to-orange-500" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">Come ha ragionato l'algoritmo</h3>
            <span className="text-[10px] text-muted-foreground">— cosa ha provato, quale strategia ha vinto, quanto si è rifinito</span>
          </div>
          <OptimizationAnalysisCard analysis={result.optimizationAnalysis} />
        </div>
      )}

      {/* Classifica degli scenari CP-SAT */}
      {result.scenarios && result.scenarios.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-6 w-1 rounded-full bg-gradient-to-b from-orange-500 to-red-500" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-orange-300">Tutti gli scenari a confronto</h3>
            <span className="text-[10px] text-muted-foreground">— clicca su una colonna per riordinare, clicca su una riga per il dettaglio</span>
          </div>
          <ScenarioRankingCard scenarios={result.scenarios} />
        </div>
      )}

      <GraficiDistribuzione result={result} />
      <ClusterDelRisultato result={result} />
      <ConformitaNormativa result={result} />

      {copertura?.(cerca)}

      {/* BDSI cap. 15: riassunti tipologia × residenza */}
      <Card className="bg-muted/30 border-border/30">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-orange-400" /> Riassunti per tipologia e residenza
          </h3>
          <RiassuntiTable
            shifts={result.driverShifts}
            onDrill={(res, tipo) => {
              setResidenzaFilter(res);
              setTypeFilter(tipo ?? "all");
              setSearchQuery("");
              toast.info("Filtro applicato", { description: `${tipo ? TYPE_LABELS[tipo] : "Tutti i tipi"}${res ? ` · ${res}` : ""} — vedi Dettaglio Turni` });
            }}
          />
        </CardContent>
      </Card>

      {/* Elenco dei turni */}
      <Card className="bg-muted/30 border-border/30">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
            <Users className="w-4 h-4 text-orange-400" /> Dettaglio Turni ({filteredShifts.length}
            {filteredShifts.length !== result.driverShifts.length ? ` di ${result.driverShifts.length}` : ""})
          </h3>
          {/* BDSI cap. 7: ricerca a chips */}
          <div className="mb-3 space-y-1.5">
            <SearchChipsBar query={searchQuery} onChange={setSearchQuery} />
            <div className="flex flex-wrap gap-1.5">
              {typeFilter !== "all" && (
                <button onClick={() => setTypeFilter("all")}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/40 text-orange-300">
                  Tipologia: {TYPE_LABELS[typeFilter]} ✕
                </button>
              )}
              {residenzaFilter && (
                <button onClick={() => setResidenzaFilter(null)}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/40 text-orange-300">
                  Residenza: {residenzaFilter} ✕
                </button>
              )}
            </div>
          </div>
          <ElencoTurni shifts={filteredShifts} forzaTurno={forzaTurno} sbloccaTurno={sbloccaTurno} />
        </CardContent>
      </Card>
    </div>
  );
}
