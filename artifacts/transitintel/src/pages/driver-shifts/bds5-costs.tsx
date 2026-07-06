/* ═══════════════════════════════════════════════════════════════
 *  Costi avanzati BDS5 (Manuale configurazione algoritmo MAIOR)
 *  Editor compatto per: scalini, costi 2° grado, cambio vettura per
 *  località, cambio patente, soste spezzanti, fasce senza cambi,
 *  lunghezza minima pezzi. Tutto opzionale → payload solo se attivo.
 * ═══════════════════════════════════════════════════════════════ */
import React, { useState } from "react";
import { Coins, X } from "lucide-react";

export interface Bds5Scalino { attributo: "nastro" | "lavoro" | "guida"; testo: string }
export interface Bds5Quadratico {
  attributo: "nastro" | "lavoro" | "guida" | "durataRiprese" | "equilibrioRiprese" | "stacco";
  riferimento?: number | null;
  lineare?: number | null;
  quadratico?: number | null;
  termineNoto?: number | null;
}
export interface Bds5Config {
  scalini: Bds5Scalino[];
  quadratici: Bds5Quadratico[];
  cambioVettura?: { coeffDeposito?: number | null; coeffLinea?: number | null; coeffDepLinea?: number | null };
  cambioPatente?: { costo?: number | null; gruppo1: string[]; gruppo2: string[] };
  sosteSpezzantiMin?: number | null;
  fasceSenzaCambi?: string;   // "07:30-08:30, 12:00-13:00"
  lungPezziMin?: number | null;
  lungPezziMinExtra?: number | null;
}

export const EMPTY_BDS5: Bds5Config = { scalini: [], quadratici: [] };

const VEHICLE_TYPES = ["pollicino", "10m", "12m", "autosnodato"];

function timeToMin(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "391=0.10, 7:00=0.22" → [{da, costo}] (minuti o hh:mm). */
function parseScalini(testo: string): { da: number; costo: number }[] {
  const out: { da: number; costo: number }[] = [];
  for (const part of testo.split(",")) {
    const [a, b] = part.split("=").map(s => s?.trim());
    if (!a || !b) continue;
    const da = a.includes(":") ? timeToMin(a) : Number(a);
    const costo = Number(b);
    if (da != null && Number.isFinite(da) && Number.isFinite(costo)) out.push({ da, costo });
  }
  return out.sort((x, y) => x.da - y.da);
}

/** "07:30-08:30, 12:00-13:00" → [{startMin, endMin}]. */
function parseFasce(testo: string): { startMin: number; endMin: number }[] {
  const out: { startMin: number; endMin: number }[] = [];
  for (const part of testo.split(",")) {
    const [a, b] = part.split("-").map(s => s?.trim());
    const s = a ? timeToMin(a) : null;
    const e = b ? timeToMin(b) : null;
    if (s != null && e != null && s < e) out.push({ startMin: s, endMin: e });
  }
  return out;
}

/** Converte l'editor nello schema config.bds del solver. Null se tutto vuoto. */
export function bds5ToSolverConfig(cfg: Bds5Config): { costiAvanzati?: any; cuts?: any } | null {
  const ca: any = {};
  const scalini = cfg.scalini
    .map(s => ({ attributo: s.attributo, scalini: parseScalini(s.testo) }))
    .filter(s => s.scalini.length > 0);
  if (scalini.length) ca.scalini = scalini;
  const quadratici = cfg.quadratici
    .filter(q => (q.lineare || q.quadratico || q.termineNoto))
    .map(q => ({
      attributo: q.attributo,
      riferimento: q.riferimento ?? 0,
      ...(q.termineNoto ? { termineNoto: q.termineNoto } : {}),
      ...(q.lineare ? { lineare: q.lineare } : {}),
      ...(q.quadratico ? { quadratico: q.quadratico } : {}),
    }));
  if (quadratici.length) ca.quadratici = quadratici;
  const cv = cfg.cambioVettura;
  if (cv && (cv.coeffDeposito || cv.coeffLinea || cv.coeffDepLinea)) {
    ca.cambioVettura = {
      coeffDeposito: cv.coeffDeposito ?? 0,
      coeffLinea: cv.coeffLinea ?? 0,
      coeffDepLinea: cv.coeffDepLinea ?? 0,
    };
  }
  const cp = cfg.cambioPatente;
  if (cp && (cp.costo ?? 0) > 0 && cp.gruppo1.length && cp.gruppo2.length) {
    ca.cambioPatente = { costo: cp.costo, gruppo1: cp.gruppo1, gruppo2: cp.gruppo2 };
  }
  const cuts: any = {};
  if ((cfg.sosteSpezzantiMin ?? 0) > 0) cuts.sosteSpezzantiMin = cfg.sosteSpezzantiMin;
  const fasce = cfg.fasceSenzaCambi ? parseFasce(cfg.fasceSenzaCambi) : [];
  if (fasce.length) cuts.fasceSenzaCambi = fasce;
  if ((cfg.lungPezziMin ?? 0) > 0) cuts.lungPezziMin = cfg.lungPezziMin;
  if ((cfg.lungPezziMinExtra ?? 0) > 0) cuts.lungPezziMinExtra = cfg.lungPezziMinExtra;

  if (!Object.keys(ca).length && !Object.keys(cuts).length) return null;
  return {
    ...(Object.keys(ca).length ? { costiAvanzati: ca } : {}),
    ...(Object.keys(cuts).length ? { cuts } : {}),
  };
}

const ATTR_SCALARI = [
  { key: "nastro", label: "Nastro" }, { key: "lavoro", label: "Lavoro" }, { key: "guida", label: "Guida" },
] as const;
const ATTR_TUTTI = [
  ...ATTR_SCALARI,
  { key: "durataRiprese", label: "Durata riprese" },
  { key: "equilibrioRiprese", label: "Equilibrio riprese" },
  { key: "stacco", label: "Stacco tra riprese" },
] as const;

export function Bds5CostsEditor({ cfg, onChange }: { cfg: Bds5Config; onChange: (c: Bds5Config) => void }) {
  const [open, setOpen] = useState(false);
  const activeCount = (bds5ToSolverConfig(cfg) ? 1 : 0)
    && (cfg.scalini.length + cfg.quadratici.length
      + (cfg.cambioVettura ? 1 : 0) + (cfg.cambioPatente ? 1 : 0)
      + (cfg.sosteSpezzantiMin ? 1 : 0) + (cfg.fasceSenzaCambi ? 1 : 0)
      + (cfg.lungPezziMin || cfg.lungPezziMinExtra ? 1 : 0));

  const num = (v: number | null | undefined, on: (n: number | null) => void, ph: string, step = 0.01, w = "w-16") => (
    <input type="number" min={0} step={step} placeholder={ph} value={v ?? ""}
      onChange={e => on(e.target.value === "" ? null : Number(e.target.value))}
      className={`${w} bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[11px] focus:outline-none focus:border-orange-500/50`} />
  );

  return (
    <div className="space-y-2">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-1.5">
        <Coins className="w-3.5 h-3.5 text-orange-400" />
        <span className="text-[11px] font-semibold text-orange-300">Costi avanzati (BDS5)</span>
        {activeCount > 0 && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-300 border border-orange-500/30">
            {activeCount} attiv{activeCount === 1 ? "o" : "i"}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="space-y-3">
          <p className="text-[10px] text-muted-foreground/70 leading-tight">
            La funzione obiettivo del BDS5: componenti opzionali sommate al costo di ogni turno.
            Vuoto = disattivo, il risultato riporta il costo BDS5 totale.
          </p>

          {/* Scalini */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-foreground/80">Costi a scalini (indennità per soglia)</span>
              <button onClick={() => onChange({ ...cfg, scalini: [...cfg.scalini, { attributo: "nastro", testo: "" }] })}
                className="text-[10px] px-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground">+ scalino</button>
            </div>
            {cfg.scalini.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <select value={s.attributo}
                  onChange={e => onChange({ ...cfg, scalini: cfg.scalini.map((x, xi) => xi === i ? { ...x, attributo: e.target.value as any } : x) })}
                  className="bg-background/60 border border-border/40 rounded px-1 py-1 text-[10px]">
                  {ATTR_SCALARI.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
                </select>
                <input value={s.testo} placeholder="es. 6:31=0.10, 7:00=0.22, 8:00=0.34"
                  onChange={e => onChange({ ...cfg, scalini: cfg.scalini.map((x, xi) => xi === i ? { ...x, testo: e.target.value } : x) })}
                  className="flex-1 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[10px] font-mono focus:outline-none focus:border-orange-500/50" />
                <button onClick={() => onChange({ ...cfg, scalini: cfg.scalini.filter((_, xi) => xi !== i) })}
                  className="text-muted-foreground hover:text-red-400"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>

          {/* Quadratici */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-foreground/80">Costi di 2° grado (oltre il riferimento)</span>
              <button onClick={() => onChange({ ...cfg, quadratici: [...cfg.quadratici, { attributo: "lavoro", riferimento: 408 }] })}
                className="text-[10px] px-1.5 rounded border border-border/40 text-muted-foreground hover:text-foreground">+ costo</button>
            </div>
            {cfg.quadratici.map((q, i) => {
              const upd = (patch: Partial<Bds5Quadratico>) =>
                onChange({ ...cfg, quadratici: cfg.quadratici.map((x, xi) => xi === i ? { ...x, ...patch } : x) });
              return (
                <div key={i} className="flex items-center gap-1.5 flex-wrap">
                  <select value={q.attributo} onChange={e => upd({ attributo: e.target.value as any })}
                    className="bg-background/60 border border-border/40 rounded px-1 py-1 text-[10px]">
                    {ATTR_TUTTI.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
                  </select>
                  <span className="text-[9px] text-muted-foreground">rif. (min)</span>
                  {num(q.riferimento, v => upd({ riferimento: v }), "408", 1, "w-14")}
                  <span className="text-[9px] text-muted-foreground">€/min</span>
                  {num(q.lineare, v => upd({ lineare: v }), "0.05")}
                  <span className="text-[9px] text-muted-foreground">€/min²</span>
                  {num(q.quadratico, v => upd({ quadratico: v }), "0.002", 0.001)}
                  <button onClick={() => onChange({ ...cfg, quadratici: cfg.quadratici.filter((_, xi) => xi !== i) })}
                    className="text-muted-foreground hover:text-red-400"><X className="w-3 h-3" /></button>
                </div>
              );
            })}
          </div>

          {/* Cambio vettura per località */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-semibold text-foreground/80">Cambio vettura (€):</span>
            <span className="text-[9px] text-muted-foreground">in linea</span>
            {num(cfg.cambioVettura?.coeffLinea, v => onChange({ ...cfg, cambioVettura: { ...cfg.cambioVettura, coeffLinea: v } }), "-", 0.5, "w-12")}
            <span className="text-[9px] text-muted-foreground">dep↔linea</span>
            {num(cfg.cambioVettura?.coeffDepLinea, v => onChange({ ...cfg, cambioVettura: { ...cfg.cambioVettura, coeffDepLinea: v } }), "-", 0.5, "w-12")}
            <span className="text-[9px] text-muted-foreground">in deposito</span>
            {num(cfg.cambioVettura?.coeffDeposito, v => onChange({ ...cfg, cambioVettura: { ...cfg.cambioVettura, coeffDeposito: v } }), "-", 0.5, "w-12")}
          </div>

          {/* Cambio patente */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold text-foreground/80">Cambio patente (€):</span>
              {num(cfg.cambioPatente?.costo,
                v => onChange({ ...cfg, cambioPatente: { gruppo1: [], gruppo2: [], ...cfg.cambioPatente, costo: v } }),
                "-", 1, "w-14")}
              <span className="text-[9px] text-muted-foreground">per turni che guidano veicoli di entrambi i gruppi</span>
            </div>
            {(cfg.cambioPatente?.costo ?? 0) > 0 && (["gruppo1", "gruppo2"] as const).map(g => (
              <div key={g} className="flex items-center gap-1 pl-2">
                <span className="text-[9px] text-muted-foreground w-14">{g === "gruppo1" ? "Gruppo 1" : "Gruppo 2"}</span>
                {VEHICLE_TYPES.map(vt => {
                  const sel = cfg.cambioPatente?.[g]?.includes(vt) ?? false;
                  return (
                    <button key={vt}
                      onClick={() => {
                        const cp = { costo: null, gruppo1: [], gruppo2: [], ...cfg.cambioPatente };
                        const list = sel ? cp[g].filter((x: string) => x !== vt) : [...cp[g], vt];
                        onChange({ ...cfg, cambioPatente: { ...cp, [g]: list } });
                      }}
                      className={`text-[9px] px-1.5 py-0.5 rounded border ${sel ? "border-orange-500/60 text-orange-300 bg-orange-500/10" : "border-border/30 text-muted-foreground"}`}>
                      {vt}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Generazione pezzi */}
          <div className="space-y-1 pt-1 border-t border-border/20">
            <span className="text-[10px] font-semibold text-foreground/80">Generazione dei pezzi</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] text-muted-foreground">Soste spezzanti ≥ (min)</span>
              {num(cfg.sosteSpezzantiMin, v => onChange({ ...cfg, sosteSpezzantiMin: v }), "-", 5, "w-14")}
              <span className="text-[9px] text-muted-foreground">Pezzi min urbano</span>
              {num(cfg.lungPezziMin, v => onChange({ ...cfg, lungPezziMin: v }), "-", 5, "w-14")}
              <span className="text-[9px] text-muted-foreground">extra</span>
              {num(cfg.lungPezziMinExtra, v => onChange({ ...cfg, lungPezziMinExtra: v }), "-", 5, "w-14")}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-muted-foreground shrink-0">Fasce senza cambi</span>
              <input value={cfg.fasceSenzaCambi ?? ""} placeholder="es. 07:30-08:30, 12:00-13:00"
                onChange={e => onChange({ ...cfg, fasceSenzaCambi: e.target.value })}
                className="flex-1 bg-background/60 border border-border/40 rounded px-1.5 py-1 text-[10px] font-mono focus:outline-none focus:border-orange-500/50" />
            </div>
            <p className="text-[9px] text-muted-foreground/60 leading-tight">
              Soste spezzanti: ogni sosta del turno macchina ≥ soglia diventa un confine obbligatorio dei pezzi.
              Fasce senza cambi: i cambi conducente in fascia sono fortemente sconsigliati al solver.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Badge di report metrics.bds5 nel risultato. */
export function Bds5Report({ report }: { report: any | null | undefined }) {
  if (!report) return null;
  const parts: string[] = [];
  if (report.costi?.length) parts.push(report.costi.join(", "));
  if (report.sosteSpezzantiMin) parts.push(`soste≥${report.sosteSpezzantiMin}'`);
  if (report.fasceSenzaCambi) parts.push(`${report.fasceSenzaCambi} fasce`);
  if (report.lungPezziMin || report.lungPezziMinExtra) parts.push(`pezzi≥${report.lungPezziMin || report.lungPezziMinExtra}'`);
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full border bg-orange-500/10 border-orange-500/30 text-orange-300"
      title={`Componenti BDS5 attive: ${parts.join(" · ")}`}>
      💰 BDS5 attivo ({parts.join(" · ")}) — costo aggiuntivo €{(report.costoTotaleEur ?? 0).toLocaleString("it-IT")}
    </span>
  );
}
