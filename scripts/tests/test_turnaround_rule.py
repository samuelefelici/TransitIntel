"""Regola del giro sulle linee radiali: la vettura che arriva a un capolinea
periferico con la corsa di ritorno della stessa linea in partenza entro pochi
minuti deve farla; saltarla (o chiudere lì il turno macchina) costa; al
centro (nodi di interscambio) la regola non si applica."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vehicle_scheduler_cpsat as vsp  # noqa: E402
from optimizer_common import set_deadhead_matrix, set_deadhead_min_matrix  # noqa: E402
from test_cover_rule_2 import _vtrip  # noqa: E402


def _radial_trips():
    C, P, Q = (43.60, 13.50), (43.66, 13.56), (43.61, 13.51)
    t0 = _vtrip(0, 480, 520, "C", "P", *C, *P)            # 08:00 centro → periferia (08:40)
    t1 = _vtrip(1, 525, 565, "P", "C", *P, *C); t1.direction_id = 1   # 08:45 ritorno naturale
    t2 = _vtrip(2, 555, 585, "Q", "C", *Q, *C); t2.route_id = "R2"; t2.route_name = "2"   # altra linea vicina (raggiungibile a vuoto)
    t3 = _vtrip(3, 600, 640, "P", "C", *P, *C); t3.direction_id = 1   # ritorno successivo (10:00)
    return [t0, t1, t2, t3]


def test_natural_turnaround_and_costs():
    trips = _radial_trips()
    rates = vsp.VehicleCostRates()
    vsp.set_center_stops(["C"])
    try:
        arcs = vsp.build_compatible_arcs_fast(trips, rates, None)
        lookup = {(a.i, a.j): a for a in arcs}
        nat = vsp.compute_natural_turnarounds(trips, lookup, rates.turnaround_max_gap)
        assert nat == {0: 1}          # da P si riparte con la 1 delle 08:45, non con la 3 delle 10:00
        vsp._TURNAROUND_NEXT.clear(); vsp._TURNAROUND_NEXT.update(nat)
        costs = vsp.precompute_arc_costs(arcs, trips, rates)
        # saltare il giro (0→2) costa per_missed_turnaround in più rispetto a farlo (0→1)
        assert costs[(0, 2)] - costs[(0, 1)] >= int(rates.per_missed_turnaround * vsp.COST_SCALE) - 1
        # costo di catena coerente: [0, 2] paga il giro saltato, [0, 1] no; chiudere su P (catena [0]) lo paga
        assert vsp.chain_normativa_cost([0, 2], trips, rates) >= rates.per_missed_turnaround
        assert vsp.chain_normativa_cost([0, 1], trips, rates) == 0.0
        assert vsp.chain_normativa_cost([0], trips, rates) >= rates.per_missed_turnaround
        rep = vsp.turnaround_report([[0, 2], [1], [3]], trips)
        assert rep["natural"] == 1 and rep["missed"] == 1 and rep["chained"] == 0
        assert rep["missedList"][0]["insteadOf"].startswith("2 09:15")
        # al centro la regola non vale: se P è un nodo di interscambio, niente giro obbligato
        vsp.set_center_stops(["C", "P"])
        assert vsp.compute_natural_turnarounds(trips, lookup, rates.turnaround_max_gap) == {}
    finally:
        vsp._TURNAROUND_NEXT.clear(); vsp.set_center_stops([])


def test_solver_chains_the_turnaround():
    trips = _radial_trips()
    rates = vsp.VehicleCostRates()
    vsp.set_center_stops(["C"])
    try:
        arcs = vsp.build_compatible_arcs_fast(trips, rates, None)
        lookup = {(a.i, a.j): a for a in arcs}
        vsp._TURNAROUND_NEXT.clear()
        vsp._TURNAROUND_NEXT.update(vsp.compute_natural_turnarounds(trips, lookup, rates.turnaround_max_gap))
        costs = vsp.precompute_arc_costs(arcs, trips, rates)
        fixed = vsp.precompute_fixed_costs(trips, rates)
        status, chains, _ = vsp.solve_vsp_cost_based(trips, arcs, costs, fixed, rates, "urbano", time_limit=10)
        assert status in ("OPTIMAL", "FEASIBLE")
        chain0 = next(c for c in chains if c[0] == 0)
        assert chain0[:2] == [0, 1]
    finally:
        vsp._TURNAROUND_NEXT.clear(); vsp.set_center_stops([])
