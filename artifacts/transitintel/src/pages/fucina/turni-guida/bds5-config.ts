/* ═══════════════════════════════════════════════════════════════
 *  Costi avanzati BDS5: i dati dell'editor e la loro traduzione nello
 *  schema che legge il solver (config.bds.costiAvanzati e config.bds.cuts).
 *  Solo logica, niente interfaccia: l'editor è in bds5-costs.tsx.
 * ═══════════════════════════════════════════════════════════════ */

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
