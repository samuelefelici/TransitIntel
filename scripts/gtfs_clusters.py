"""gtfs_clusters.py — Classifica i dati GTFS per l'ottimizzatore conducenti.

Due responsabilità, entrambe a monte del trasporto conducenti:

  1. GENERA i `clusterStops` di ogni corsa dal GTFS (stop_times): per ogni corsa,
     l'elenco delle fermate che appartengono a un cluster, con l'orario di transito.
     Finora le corse portavano solo primo/ultimo capolinea: i transiti intermedi
     (un bus che PASSA per un cluster a metà servizio) andavano persi. Questi
     transiti sono i bus su cui un conducente può salire come passeggero.

  2. Costruisce l'INDICE DI CONNETTIVITÀ IN LINEA: da quei transiti deriva, per ogni
     coppia di cluster (A, B), le corse che collegano A→B come passeggero (salgo ad A
     quando il bus parte, scendo a B quando arriva). È la base per il "taxi su bus di
     linea" cluster→cluster, alternativa gratuita ad auto aziendale/taxi.

Il deposito è fuori rete (solo entrata/uscita): i bus di linea NON lo toccano, quindi
servono solo spostamenti cluster→cluster, mai cluster→deposito.
"""

from __future__ import annotations

import csv
from bisect import bisect_left
from dataclasses import dataclass, field

from optimizer_common import Cluster, ClusterStop


# ════════════════════════════════════════════════════════════════
#  Cluster di Jesi (rete reale Conerobus/ATMA) — derivati dal GTFS
# ════════════════════════════════════════════════════════════════
# stop_id presi da stops.txt per nome. I cluster sono configurabili: questi sono i
# default per Jesi finché non arrivano dal DB/config.
JESI_CLUSTERS: list[Cluster] = [
    Cluster(
        id="arco_clementino", name="Arco Clementino",
        keywords=["ARCO CLEMENTINO"], transfer_from_depot_min=12,
        stop_ids=["21054", "21178", "5028", "CI398"],
    ),
    Cluster(
        id="portavalle", name="Portavalle",
        keywords=["PORTAVALLE", "PORTA VALLE"], transfer_from_depot_min=12,
        stop_ids=["CI003", "CI369"],
    ),
    Cluster(
        id="stazione_jesi", name="Stazione Jesi",
        keywords=["AUTOSTAZIONE JESI", "JESI (AUTOSTAZIONE)"], transfer_from_depot_min=10,
        stop_ids=["20420", "21290"],
    ),
]


def hms_to_min(hms: str) -> int:
    """'HH:MM:SS' → minuti dopo mezzanotte. GTFS ammette ore ≥ 24 (servizio notturno)."""
    hms = (hms or "").strip().strip('"')
    if not hms:
        return 0
    parts = hms.split(":")
    h = int(parts[0]); m = int(parts[1]) if len(parts) > 1 else 0
    return h * 60 + m


def stop_to_cluster_map(clusters: list[Cluster]) -> dict[str, str]:
    """stop_id → cluster_id, dai soli stop_ids dichiarati nei cluster."""
    return {sid: c.id for c in clusters for sid in c.stop_ids}


# ════════════════════════════════════════════════════════════════
#  (1) GTFS stop_times → clusterStops per ogni trip
# ════════════════════════════════════════════════════════════════

def build_cluster_passages(
    stop_times_path: str,
    clusters: list[Cluster],
    only_trip_ids: set[str] | None = None,
) -> dict[str, list[ClusterStop]]:
    """Legge stop_times.txt e restituisce {trip_id: [ClusterStop ordinati per sequenza]},
    solo per le fermate appartenenti a un cluster. Se `only_trip_ids` è dato, filtra
    a quelle corse (utile per i soli trip dei turni macchina)."""
    sid2cl = stop_to_cluster_map(clusters)
    name = {c.id: c.name for c in clusters}
    passages: dict[str, list[ClusterStop]] = {}
    with open(stop_times_path, newline="") as f:
        for row in csv.DictReader(f):
            sid = (row["stop_id"] or "").strip().strip('"')
            cl = sid2cl.get(sid)
            if cl is None:
                continue
            tid = (row["trip_id"] or "").strip().strip('"')
            if only_trip_ids is not None and tid not in only_trip_ids:
                continue
            passages.setdefault(tid, []).append(ClusterStop(
                stop_id=sid,
                stop_name=name.get(cl, cl),
                stop_sequence=int((row["stop_sequence"] or "0").strip().strip('"') or 0),
                cluster_id=cl,
                arrival_min=hms_to_min(row["arrival_time"]),
                departure_min=hms_to_min(row["departure_time"]),
            ))
    for lst in passages.values():
        lst.sort(key=lambda cs: cs.stop_sequence)
    return passages


def attach_cluster_stops_to_shifts(
    vehicle_shifts: list[dict],
    passages: dict[str, list[ClusterStop]],
) -> int:
    """Inietta i clusterStops (formato JSON) nelle corse dei turni macchina, abbinando
    per `tripId`. Così il dato fluisce nella pipeline esistente (v4 li rilegge già).
    Ritorna il numero di corse arricchite."""
    n = 0
    for vs in vehicle_shifts:
        for t in vs.get("trips", []):
            tid = t.get("tripId", "")
            cs = passages.get(tid)
            if not cs:
                continue
            t["clusterStops"] = [{
                "stopId": p.stop_id, "stopName": p.stop_name,
                "stopSequence": p.stop_sequence, "clusterId": p.cluster_id,
                "arrivalTime": _min_to_hhmm(p.arrival_min),
                "departureTime": _min_to_hhmm(p.departure_min),
            } for p in cs]
            n += 1
    return n


def _min_to_hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


# ════════════════════════════════════════════════════════════════
#  (2) Indice di connettività in linea cluster→cluster
# ════════════════════════════════════════════════════════════════

@dataclass
class InServiceEdge:
    """Una corsa di linea collega A→B come passeggero: salgo a `board_min` (partenza
    da A), scendo a `alight_min` (arrivo a B)."""
    board_min: int
    alight_min: int
    trip_id: str
    vehicle_id: str | None = None


@dataclass
class InServiceIndex:
    """Connettività cluster→cluster offerta dai bus di linea, derivata dai transiti."""
    edges: dict[tuple[str, str], list[InServiceEdge]] = field(default_factory=dict)

    def add_trip(self, cluster_stops: list[ClusterStop], trip_id: str,
                 vehicle_id: str | None = None) -> None:
        """Per ogni coppia ordinata di cluster DIVERSI toccati dalla corsa, aggiunge
        un arco A→B (salita alla partenza da A, discesa all'arrivo a B)."""
        cs = sorted(cluster_stops, key=lambda c: c.stop_sequence)
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                a, b = cs[i], cs[j]
                if a.cluster_id == b.cluster_id:
                    continue
                self.edges.setdefault((a.cluster_id, b.cluster_id), []).append(
                    InServiceEdge(a.departure_min, b.arrival_min, trip_id, vehicle_id))

    def finalize(self) -> None:
        for lst in self.edges.values():
            lst.sort(key=lambda e: e.board_min)

    def connect(self, from_cluster: str, to_cluster: str, ready_min: int,
                window: int) -> InServiceEdge | None:
        """Primo bus che parte da `from_cluster` non prima di `ready_min` ed entro
        `window` minuti d'attesa, diretto a `to_cluster`. None se nessuno."""
        if not from_cluster or not to_cluster or from_cluster == to_cluster:
            return None
        lst = self.edges.get((from_cluster, to_cluster))
        if not lst:
            return None
        i = bisect_left([e.board_min for e in lst], ready_min)
        if i < len(lst) and (lst[i].board_min - ready_min) <= window:
            return lst[i]
        return None


def build_inservice_index(blocks, clusters: list[Cluster] | None = None) -> InServiceIndex:
    """Costruisce l'indice dai `cluster_stops` già presenti sulle corse dei VehicleBlock.
    (Se i clusterStops non sono popolati, l'indice resta vuoto: nessuna regressione.)"""
    idx = InServiceIndex()
    for b in blocks:
        for t in b.trips:
            cs = getattr(t, "cluster_stops", None) or []
            if len(cs) >= 2:
                idx.add_trip(cs, getattr(t, "trip_id", ""), getattr(b, "vehicle_id", None))
    idx.finalize()
    return idx
