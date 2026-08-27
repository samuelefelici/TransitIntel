/**
 * Cubo spazio-tempo — la matematica, senza three.js.
 *
 * Piano (x,z) = cartografia locale in unità di scena (km riscalati per stare
 * nel cubo), asse y = tempo. Ogni corsa accesa diventa un FILO: la spezzata
 * dei suoi transiti alle fermate, sollevata nel tempo. Fili di linee diverse
 * che toccano lo stesso NODO a orari vicini = coincidenza (le sfere verdi).
 *
 * Il modulo è puro perché la geometria va potuta verificare a tavolino: la
 * resa three.js sta in components/planning-studio/SpaceTimeCube.tsx.
 */

export interface CubeStop { id: string; lat: number; lon: number; name?: string }

export interface CubeThreadInput {
  tripId: string;
  /** chiave della LINEA (routeId): le coincidenze contano solo tra linee diverse */
  routeKey: string;
  label: string;
  color: string;
  /** transiti in ordine di percorrenza: secondi GTFS (anche >24h) */
  stops: Array<{ stopId: string; sec: number }>;
}

export interface CubePoint { x: number; y: number; z: number }

export interface CubeThread {
  tripId: string;
  routeKey: string;
  label: string;
  color: string;
  points: CubePoint[];
  /** secondi del primo e ultimo transito (per la lama e i tooltip) */
  t0: number;
  t1: number;
}

export interface CubeNode {
  nodeId: string;
  name: string;
  x: number; z: number;
}

export interface CubeCoincidence {
  nodeId: string;
  nodeName: string;
  x: number; z: number;
  /** istante rappresentativo (media dei due transiti), secondi */
  sec: number;
  waitMin: number;
  tripA: string; tripB: string;
  labelA: string; labelB: string;
}

export interface CubeProjection {
  toX(lon: number): number;
  toZ(lat: number): number;
  toY(sec: number): number;
  /** estensione del piano in unità di scena (lato maggiore) */
  planSize: number;
  /** finestra temporale coperta dai fili [sec, sec] */
  tMin: number;
  tMax: number;
}

/**
 * Proiezione: equirettangolare locale centrata sul baricentro delle fermate,
 * riscalata perché il lato maggiore del piano valga `planSize` unità; il
 * tempo scala con `minutesPerUnit` (default 55′ per unità — un'ora abbondante
 * per tacca, il cubo resta proporzionato anche su giornate intere).
 */
export function buildProjection(
  stops: CubeStop[],
  tMin: number,
  tMax: number,
  planSize = 10,
  minutesPerUnit = 55,
): CubeProjection {
  const lats = stops.map(s => s.lat), lons = stops.map(s => s.lon);
  const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2 || 0;
  const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2 || 0;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const kz = 110.54;
  const wKm = (Math.max(...lons) - Math.min(...lons)) * kx || 1;
  const hKm = (Math.max(...lats) - Math.min(...lats)) * kz || 1;
  const scale = planSize / Math.max(wKm, hKm);
  return {
    toX: lon => (lon - lon0) * kx * scale,
    toZ: lat => -(lat - lat0) * kz * scale,
    toY: sec => (sec - tMin) / 60 / minutesPerUnit,
    planSize,
    tMin,
    tMax,
  };
}

/** I fili: transiti → punti 3D. Le fermate senza coordinate vengono saltate
 *  (mai inventate); un filo con meno di 2 punti proiettabili non si disegna. */
export function buildThreads(
  inputs: CubeThreadInput[],
  stopsById: Map<string, CubeStop>,
  proj: CubeProjection,
): CubeThread[] {
  const out: CubeThread[] = [];
  for (const t of inputs) {
    const pts: CubePoint[] = [];
    let t0 = Infinity, t1 = -Infinity;
    for (const s of t.stops) {
      const st = stopsById.get(s.stopId);
      if (!st) continue;
      pts.push({ x: proj.toX(st.lon), y: proj.toY(s.sec), z: proj.toZ(st.lat) });
      if (s.sec < t0) t0 = s.sec;
      if (s.sec > t1) t1 = s.sec;
    }
    if (pts.length < 2) continue;
    out.push({ tripId: t.tripId, routeKey: t.routeKey, label: t.label, color: t.color, points: pts, t0, t1 });
  }
  return out;
}

/** Posizione dei nodi (piloni): media delle fermate che vi appartengono. */
export function buildNodes(
  nodeIds: Set<string>,
  nodeOfStop: Map<string, string>,
  stops: CubeStop[],
  proj: CubeProjection,
): CubeNode[] {
  const acc = new Map<string, { lat: number; lon: number; n: number; name: string }>();
  for (const st of stops) {
    const nid = nodeOfStop.get(st.id) ?? st.id;
    if (!nodeIds.has(nid)) continue;
    const a = acc.get(nid) ?? { lat: 0, lon: 0, n: 0, name: st.name || "" };
    a.lat += st.lat; a.lon += st.lon; a.n += 1;
    if (!a.name && st.name) a.name = st.name;
    acc.set(nid, a);
  }
  return [...acc.entries()].map(([nodeId, a]) => ({
    nodeId,
    name: a.name,
    x: proj.toX(a.lon / a.n),
    z: proj.toZ(a.lat / a.n),
  }));
}

/**
 * Coincidenze: per ogni NODO, transiti di corse di LINEE DIVERSE a distanza
 * ≤ soglia. Si confronta il primo transito di ogni corsa al nodo (i ripassi
 * successivi contano come passaggi distinti). Deduplica per coppia di corse
 * sullo stesso nodo (resta l'attesa minima).
 */
export function findCoincidences(
  inputs: CubeThreadInput[],
  stopsById: Map<string, CubeStop>,
  nodeOfStop: Map<string, string>,
  nodes: CubeNode[],
  thresholdMin: number,
): CubeCoincidence[] {
  const nodeById = new Map(nodes.map(n => [n.nodeId, n]));
  // per corsa: nodo → elenco transiti (sec) su quel nodo
  type Pass = { trip: CubeThreadInput; sec: number };
  const byNode = new Map<string, Pass[]>();
  for (const t of inputs) {
    const seen = new Set<string>();
    for (const s of t.stops) {
      if (!stopsById.has(s.stopId)) continue;
      const nid = nodeOfStop.get(s.stopId) ?? s.stopId;
      if (!nodeById.has(nid)) continue;
      const key = `${t.tripId}|${nid}|${s.sec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const arr = byNode.get(nid) ?? [];
      arr.push({ trip: t, sec: s.sec });
      byNode.set(nid, arr);
    }
  }
  const best = new Map<string, CubeCoincidence>();
  for (const [nid, passes] of byNode) {
    const node = nodeById.get(nid)!;
    for (let i = 0; i < passes.length; i++) {
      for (let j = i + 1; j < passes.length; j++) {
        const a = passes[i], b = passes[j];
        if (a.trip.routeKey === b.trip.routeKey) continue;
        const wait = Math.abs(a.sec - b.sec) / 60;
        if (wait > thresholdMin) continue;
        const pairKey = [nid, a.trip.tripId, b.trip.tripId].join("|");
        const prev = best.get(pairKey);
        if (prev && prev.waitMin <= wait) continue;
        best.set(pairKey, {
          nodeId: nid,
          nodeName: node.name,
          x: node.x, z: node.z,
          sec: Math.round((a.sec + b.sec) / 2),
          waitMin: Math.round(wait),
          tripA: a.trip.tripId, tripB: b.trip.tripId,
          labelA: a.trip.label, labelB: b.trip.label,
        });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.sec - b.sec);
}
