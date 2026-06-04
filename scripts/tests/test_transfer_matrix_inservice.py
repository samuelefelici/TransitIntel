"""Test: trasferimento `bus_inservice` (bus di linea cluster→cluster) nel concatenatore.

Verifica che, quando un bus di linea collega A→B nella finestra del gap, il
trasferimento sia gratuito e preferito ad auto/taxi; e che senza indice il
comportamento resti invariato.
"""

from cost_model import CostRates
from optimizer_common import Task, ClusterStop
from transfer_matrix import build_transfer_matrix
from gtfs_clusters import InServiceIndex


def cs(cluster, seq, arr, dep=None):
    return ClusterStop(stop_id=f"s{seq}", stop_name=cluster, stop_sequence=seq,
                       cluster_id=cluster, arrival_min=arr,
                       departure_min=dep if dep is not None else arr)


def task(idx, start, end, cluster, vehicle, lat=43.5, lon=13.2):
    return Task(idx=idx, vehicle_id=vehicle, vehicle_type="12m", trips=[],
                start_min=start, end_min=end, duration_min=end - start, driving_min=end - start,
                first_stop=cluster, last_stop=cluster, first_cluster=cluster, last_cluster=cluster,
                first_lat=lat, first_lon=lon, last_lat=lat, last_lon=lon)


def _index_arco_to_porta(board, alight):
    idx = InServiceIndex()
    idx.add_trip([cs("arco_clementino", 1, board, board), cs("portavalle", 4, alight, alight)], "T1", "V9")
    idx.finalize()
    return idx


def test_bus_inservice_preferito_ad_auto():
    """A finisce ad Arco (480), B parte da Portavalle (510). Un bus Arco→Portavalle
    parte 485 arriva 495 → trasferimento gratuito su bus, non in auto."""
    a = task(0, 400, 480, "arco_clementino", "V1")
    b = task(1, 510, 560, "portavalle", "V2")
    m = build_transfer_matrix([a, b], CostRates(), max_gap=180,
                              inservice=_index_arco_to_porta(485, 495))
    tr = m[(0, 1)]
    assert tr.transfer_type == "bus_inservice"
    assert tr.cost_euro == 0.0
    assert tr.time_min == 495 - 480       # attesa + viaggio


def test_senza_indice_resta_auto_o_taxi():
    """Stesso scenario senza indice in linea → torna al modello auto/taxi (a pagamento)."""
    a = task(0, 400, 480, "arco_clementino", "V1")
    b = task(1, 510, 560, "portavalle", "V2")
    m = build_transfer_matrix([a, b], CostRates(), max_gap=180)
    assert m[(0, 1)].transfer_type in ("company_car", "taxi", "walk")
    assert m[(0, 1)].cost_euro > 0.0


def test_bus_inservice_ignorato_se_arriva_troppo_tardi():
    """Il bus arriva (515) dopo l'inizio di B (510) → non utilizzabile, fallback auto."""
    a = task(0, 400, 480, "arco_clementino", "V1")
    b = task(1, 510, 560, "portavalle", "V2")
    m = build_transfer_matrix([a, b], CostRates(), max_gap=180,
                              inservice=_index_arco_to_porta(505, 515))
    assert m[(0, 1)].transfer_type != "bus_inservice"


def test_stesso_cluster_resta_cambio_in_linea():
    """Stesso cluster (cambio in linea) ha precedenza sul bus: nessun viaggio necessario."""
    a = task(0, 400, 480, "portavalle", "V1")
    b = task(1, 500, 560, "portavalle", "V2")
    m = build_transfer_matrix([a, b], CostRates(), max_gap=180,
                              inservice=_index_arco_to_porta(485, 495))
    assert m[(0, 1)].transfer_type == "same_stop"
