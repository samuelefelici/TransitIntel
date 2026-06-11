/**
 * Merge topologico dei pattern fermate di più corse in un unico ordine
 * "master" per l'orario generale di linea (fermate × corse).
 *
 * Le corse di una stessa linea possono saltare fermate o servirne di extra:
 * l'ordine master deve rispettare l'ordine relativo osservato in ogni corsa.
 * Kahn con tie-break sull'ordine di prima apparizione; in presenza di cicli
 * (pattern contraddittori tra corse) le fermate residue vengono accodate
 * nell'ordine di apparizione.
 */

export interface PatternStop { stopId: string; stopName: string | null }

export function mergeStopPatterns(patterns: PatternStop[][]): PatternStop[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const succ = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  const nameOf = new Map<string, string | null>();

  for (const stops of patterns) {
    for (let i = 0; i < stops.length; i++) {
      const a = stops[i].stopId;
      if (!seen.has(a)) { seen.add(a); order.push(a); indeg.set(a, indeg.get(a) ?? 0); }
      if (!nameOf.has(a)) nameOf.set(a, stops[i].stopName);
      if (i > 0) {
        const p = stops[i - 1].stopId;
        if (p !== a && !succ.get(p)?.has(a)) {
          if (!succ.has(p)) succ.set(p, new Set());
          succ.get(p)!.add(a);
          indeg.set(a, (indeg.get(a) ?? 0) + 1);
        }
      }
    }
  }

  const master: string[] = [];
  const ready = order.filter((sId) => (indeg.get(sId) ?? 0) === 0);
  const indegWork = new Map(indeg);
  while (ready.length > 0) {
    const cur = ready.shift()!;
    master.push(cur);
    for (const nxt of succ.get(cur) ?? []) {
      const d = (indegWork.get(nxt) ?? 1) - 1;
      indegWork.set(nxt, d);
      if (d === 0) {
        // inserisce mantenendo la posizione relativa di prima apparizione
        const pos = order.indexOf(nxt);
        let ins = ready.length;
        while (ins > 0 && order.indexOf(ready[ins - 1]) > pos) ins--;
        ready.splice(ins, 0, nxt);
      }
    }
  }
  // cicli: appende ciò che resta in ordine di apparizione
  for (const sId of order) if (!master.includes(sId)) master.push(sId);

  return master.map((sId) => ({ stopId: sId, stopName: nameOf.get(sId) ?? sId }));
}
