"""La partenza a caldo: ogni round riparte dal piano migliore, non da zero.

Il difetto, misurato sui giri veri (365 corse, stesso orario, stesse linee): i
round del VCSP non migliorano l'uno sull'altro, oscillano. Giro BA: 25, 25, 27,
21, 33 vetture. Giro AZ: 25, 31, 26, 25, 26. Il miglior piano della serie viene
sempre da UN round fortunato, mai da una convergenza, perche' ogni round e' un
solve da capo: il greedy costruisce una baseline nuova e le penalita' d'arco del
CSP la spostano dove capita.

Qui si verifica il pezzo che traduce il piano di un round nella partenza del
round dopo, e soprattutto che lo RIPARI invece di rifiutarlo: una catena che
arriva da fuori puo' nominare corse che non ci sono piu', ripeterne una, o
chiedere un aggancio che questo modello non ammette.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import vehicle_scheduler_cpsat as v  # noqa: E402


def _trip(idx, dep=480, arr=510, stop="T0"):
    return v.Trip(
        idx=idx, trip_id=f"t{idx}", route_id="R1", departure_min=dep,
        arrival_min=arr, first_stop_id=stop, last_stop_id=stop,
        first_stop_lat=43.5, first_stop_lon=13.4,
        last_stop_lat=43.5, last_stop_lon=13.4,
        route_name="R1", headsign="X", direction_id=0,
        departure_time="08:00:00", arrival_time="08:30:00",
        first_stop_name="A", last_stop_name="A", stop_count=10,
        required_vehicle=None, category="urbano", forced=False,
    )


def _rete(n=4, agganci=None):
    """n corse in fila; `agganci` sono le coppie (i, j) ammesse (default: tutte
    quelle in avanti)."""
    trips = [_trip(i, dep=480 + 60 * i, arr=500 + 60 * i) for i in range(n)]
    if agganci is None:
        agganci = [(i, j) for i in range(n) for j in range(n) if j > i]
    lookup = {(i, j): object() for (i, j) in agganci}
    return trips, lookup


def test_un_piano_intero_si_traduce_e_resta_intero():
    trips, lookup = _rete(4)
    catene, diag = v.chains_from_trip_ids([["t0", "t1"], ["t2", "t3"]], trips, lookup)
    assert catene == [[0, 1], [2, 3]]
    assert diag["corseRiconosciute"] == 4
    assert diag["catene"] == 2
    assert diag["corseAggiunte"] == 0
    assert diag["aggancioMancante"] == 0


def test_senza_piano_non_c_e_partenza_a_caldo():
    trips, lookup = _rete(3)
    for vuoto in (None, [], ()):
        catene, diag = v.chains_from_trip_ids(vuoto, trips, lookup)
        assert catene == []
        assert diag["catene"] == 0


def test_la_partenza_a_caldo_copre_sempre_tutto_l_orario():
    """Una corsa che il piano vecchio non nominava diventa un blocco suo: una
    partenza che lascia corse scoperte non e' una soluzione."""
    trips, lookup = _rete(4)
    catene, diag = v.chains_from_trip_ids([["t0", "t1"]], trips, lookup)
    assert catene == [[0, 1], [2], [3]]
    assert diag["corseAggiunte"] == 2
    coperte = sorted(i for c in catene for i in c)
    assert coperte == [0, 1, 2, 3]


def test_una_corsa_che_qui_non_esiste_si_salta():
    trips, lookup = _rete(3)
    catene, diag = v.chains_from_trip_ids([["t0", "fantasma", "t1"]], trips, lookup)
    assert catene == [[0, 1], [2]]
    assert diag["corseIgnote"] == 1
    assert diag["corseRiconosciute"] == 2


def test_una_corsa_ripetuta_si_tiene_una_volta_sola():
    """Un mezzo non fa due volte la stessa corsa, e due mezzi non se la
    dividono: la seconda occorrenza si butta, ovunque compaia."""
    trips, lookup = _rete(3)
    catene, diag = v.chains_from_trip_ids([["t0", "t1"], ["t1", "t2"]], trips, lookup)
    assert catene == [[0, 1], [2]]
    assert diag["corseDoppie"] == 1
    coperte = sorted(i for c in catene for i in c)
    assert coperte == [0, 1, 2]


def test_un_aggancio_che_non_esiste_spezza_la_catena_invece_di_buttarla():
    """Due mezzi al posto di uno sono un piano peggiore, non un piano illegale:
    la partenza a caldo resta ammissibile e il solver ricuce da li'."""
    trips, lookup = _rete(4, agganci=[(0, 1), (2, 3)])   # manca (1, 2)
    catene, diag = v.chains_from_trip_ids([["t0", "t1", "t2", "t3"]], trips, lookup)
    assert catene == [[0, 1], [2, 3]]
    assert diag["aggancioMancante"] == 1
    assert diag["corseAggiunte"] == 0


def test_il_ritorno_e_sempre_una_soluzione_ammissibile():
    """La prova che conta: comunque sia fatto il piano in arrivo, quello che
    esce copre ogni corsa una volta sola e usa solo agganci che esistono."""
    trips, lookup = _rete(6, agganci=[(0, 1), (1, 2), (3, 4)])
    sporco = [["t0", "t1", "t2", "t3", "t4"], ["t2", "nessuno", "t5"], ["t5"]]
    catene, _ = v.chains_from_trip_ids(sporco, trips, lookup)
    coperte = [i for c in catene for i in c]
    assert sorted(coperte) == [0, 1, 2, 3, 4, 5], "ogni corsa una volta sola"
    assert len(coperte) == len(set(coperte))
    for c in catene:
        for a, b in zip(c, c[1:]):
            assert (a, b) in lookup, f"aggancio inventato {a}->{b}"


def test_le_catene_arrivate_come_spazzatura_non_fanno_saltare_niente():
    trips, lookup = _rete(2)
    catene, _ = v.chains_from_trip_ids(["non una lista", None, ["t0"]], trips, lookup)
    assert sorted(i for c in catene for i in c) == [0, 1]
