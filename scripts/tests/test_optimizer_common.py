"""
Test unitari per optimizer_common.py
Copre: geometria, utilità tempo, cluster matching, config merge, cost computation.
"""

import math
import pytest

from optimizer_common import (
    haversine_km,
    estimate_deadhead,
    is_peak_hour,
    can_vehicle_serve,
    match_cluster,
    cluster_by_id,
    depot_transfer_min,
    build_cluster_stop_lookup,
    min_to_time,
    fmt_dur,
    merge_config,
    weights_to_solver_params,
    trip_from_dict,
    VehicleCostRates,
    VehicleShiftCost,
    PrePostRules,
    RD131Config,
    Cluster,
    DEFAULT_CLUSTERS,
    SHIFT_RULES,
    VEHICLE_SIZE,
    MAX_DOWNSIZE_LEVELS,
    DEPOT_TRANSFER_CENTRAL,
    DEPOT_TRANSFER_OUTER,
)


# ═══════════════════════════════════════════════════════════════
#  GEOMETRIA
# ═══════════════════════════════════════════════════════════════

class TestHaversineKm:
    def test_same_point_returns_zero(self):
        assert haversine_km(43.6, 13.5, 43.6, 13.5) == 0.0

    def test_known_distance_rome_milan(self):
        """Roma → Milano ≈ 478 km."""
        dist = haversine_km(41.9028, 12.4964, 45.4642, 9.19)
        assert 470 < dist < 490

    def test_short_distance_ancona(self):
        """~2 km all'interno di Ancona."""
        dist = haversine_km(43.6168, 13.5186, 43.6073, 13.4978)
        assert 1.5 < dist < 3.0

    def test_symmetric(self):
        d1 = haversine_km(43.6, 13.5, 44.0, 13.8)
        d2 = haversine_km(44.0, 13.8, 43.6, 13.5)
        assert d1 == pytest.approx(d2, abs=1e-10)

    def test_antimeridian(self):
        """Tokyo → Los Angeles (grandi distanze, antimeridiano)."""
        dist = haversine_km(35.6762, 139.6503, 34.0522, -118.2437)
        assert 8700 < dist < 9000


class TestEstimateDeadhead:
    def test_same_point_returns_near_zero_km(self):
        km, minutes = estimate_deadhead(43.6, 13.5, 43.6, 13.5)
        assert km == 0.0
        # Deadhead buffer è 5 minuti
        assert minutes == 5

    def test_returns_tuple(self):
        result = estimate_deadhead(43.6, 13.5, 43.61, 13.51)
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_urban_vs_extraurbano_speed(self):
        """Urbano è più lento → più minuti per la stessa distanza."""
        _, min_u = estimate_deadhead(43.6, 13.5, 43.65, 13.55, "urbano")
        _, min_e = estimate_deadhead(43.6, 13.5, 43.65, 13.55, "extraurbano")
        assert min_u > min_e

    def test_circuity_factor_applied(self):
        """Distanza stradale > distanza rettilinea (fattore 1.3)."""
        km, _ = estimate_deadhead(43.6, 13.5, 43.61, 13.51)
        straight = haversine_km(43.6, 13.5, 43.61, 13.51)
        assert km > straight


class TestIsPeakHour:
    def test_morning_peak(self):
        assert is_peak_hour(7 * 60) is True   # 07:00
        assert is_peak_hour(8 * 60) is True   # 08:00
        assert is_peak_hour(9 * 60) is True   # 09:00

    def test_evening_peak(self):
        assert is_peak_hour(17 * 60) is True  # 17:00
        assert is_peak_hour(18 * 60) is True  # 18:00
        assert is_peak_hour(19 * 60) is True  # 19:00

    def test_off_peak(self):
        assert is_peak_hour(6 * 60) is False  # 06:00
        assert is_peak_hour(10 * 60) is False # 10:00
        assert is_peak_hour(12 * 60) is False # 12:00
        assert is_peak_hour(16 * 60) is False # 16:00
        assert is_peak_hour(20 * 60) is False # 20:00

    def test_midnight(self):
        assert is_peak_hour(0) is False


class TestCanVehicleServe:
    def test_exact_match(self):
        assert can_vehicle_serve(3, 3) is True

    def test_larger_vehicle(self):
        assert can_vehicle_serve(4, 3) is True

    def test_one_level_smaller_allowed(self):
        assert can_vehicle_serve(2, 3) is True  # MAX_DOWNSIZE_LEVELS = 1

    def test_two_levels_smaller_not_allowed(self):
        assert can_vehicle_serve(1, 3) is False

    def test_smallest_can_serve_itself(self):
        assert can_vehicle_serve(1, 1) is True


# ═══════════════════════════════════════════════════════════════
#  CLUSTER MATCHING
# ═══════════════════════════════════════════════════════════════

class TestMatchCluster:
    def test_keyword_match_stazione(self):
        cid = match_cluster("Stazione FS Ancona")
        assert cid is not None
        assert "stazione" in cid or "station" in cid.lower()

    def test_keyword_match_cavour(self):
        cid = match_cluster("Piazza Cavour")
        assert cid == "cavour"

    def test_keyword_match_tavernelle(self):
        cid = match_cluster("TAVERNELLE capolinea")
        assert cid == "tavernelle"

    def test_keyword_match_ugo_bassi(self):
        cid = match_cluster("Via Ugo Bassi 5")
        assert cid is not None

    def test_no_match(self):
        assert match_cluster("Via Roma 123") is None

    def test_none_input(self):
        assert match_cluster(None) is None

    def test_empty_string(self):
        assert match_cluster("") is None

    def test_match_by_stop_id(self):
        """Test match by stop_id with custom clusters."""
        clusters = [
            Cluster(
                id="test_cl", name="Test", keywords=[],
                transfer_from_depot_min=10,
                stop_ids=["STOP_42"], stop_names=[], color="#000",
            ),
        ]
        assert match_cluster("Unknown stop", clusters, stop_id="STOP_42") == "test_cl"


class TestClusterById:
    def test_existing_cluster(self):
        c = cluster_by_id("cavour")
        assert c is not None
        assert c.name == "Piazza Cavour"

    def test_non_existing(self):
        assert cluster_by_id("non_existent") is None


class TestDepotTransferMin:
    def test_central_cluster(self):
        """Cluster centrali → 10 min."""
        mins = depot_transfer_min("Piazza Cavour")
        assert mins == DEPOT_TRANSFER_CENTRAL

    def test_outer_cluster(self):
        """Ospedale Torrette → 15 min."""
        mins = depot_transfer_min("Ospedale Regionale Torrette")
        assert mins == 15

    def test_unknown_stop(self):
        """Fermata sconosciuta → DEPOT_TRANSFER_OUTER (15)."""
        mins = depot_transfer_min("Fermata Ignota Lontana")
        assert mins == DEPOT_TRANSFER_OUTER


class TestBuildClusterStopLookup:
    def test_builds_lookup(self):
        clusters = [
            Cluster(id="c1", name="C1", keywords=[], transfer_from_depot_min=10,
                    stop_ids=["S1", "S2"], stop_names=[], color="#000"),
            Cluster(id="c2", name="C2", keywords=[], transfer_from_depot_min=15,
                    stop_ids=["S3"], stop_names=[], color="#000"),
        ]
        lookup = build_cluster_stop_lookup(clusters)
        assert lookup["S1"] == "c1"
        assert lookup["S2"] == "c1"
        assert lookup["S3"] == "c2"
        assert "S4" not in lookup


# ═══════════════════════════════════════════════════════════════
#  FORMATTAZIONE TEMPO
# ═══════════════════════════════════════════════════════════════

class TestMinToTime:
    def test_midnight(self):
        assert min_to_time(0) == "00:00"

    def test_morning(self):
        assert min_to_time(450) == "07:30"

    def test_noon(self):
        assert min_to_time(720) == "12:00"

    def test_late_night(self):
        assert min_to_time(23 * 60 + 59) == "23:59"

    def test_over_24h(self):
        """GTFS supporta orari >24:00."""
        assert min_to_time(25 * 60) == "25:00"


class TestFmtDur:
    def test_exact_hours(self):
        assert fmt_dur(360) == "6h00"

    def test_mixed(self):
        assert fmt_dur(390) == "6h30"

    def test_zero(self):
        assert fmt_dur(0) == "0h00"

    def test_large(self):
        assert fmt_dur(630) == "10h30"


# ═══════════════════════════════════════════════════════════════
#  COST STRUCTURES
# ═══════════════════════════════════════════════════════════════

class TestVehicleShiftCost:
    def test_compute_total(self):
        vsc = VehicleShiftCost(
            fixed_daily=42.0,
            service_km_cost=50.0,
            deadhead_km_cost=10.0,
            idle_cost=5.0,
            depot_return_cost=15.0,
            balance_penalty=4.0,
            gap_penalty=11.0,
            downsize_penalty=0.0,
        )
        total = vsc.compute()
        assert total == pytest.approx(137.0)
        assert vsc.total == pytest.approx(137.0)

    def test_to_dict(self):
        vsc = VehicleShiftCost(fixed_daily=42.0)
        vsc.compute()
        d = vsc.to_dict()
        assert "fixedDaily" in d
        assert d["fixedDaily"] == 42.0
        assert "total" in d


class TestVehicleCostRatesFromConfig:
    def test_default(self):
        rates = VehicleCostRates.from_config(None)
        assert rates.fixed_daily["12m"] == 42.0
        assert rates.max_idle_at_terminal == 90

    def test_override_scalar(self):
        rates = VehicleCostRates.from_config({"maxIdleAtTerminal": 120})
        assert rates.max_idle_at_terminal == 120

    def test_override_nested_dict(self):
        rates = VehicleCostRates.from_config({
            "fixedDaily": {"12m": 50.0},
        })
        assert rates.fixed_daily["12m"] == 50.0
        # Other keys unchanged
        assert rates.fixed_daily["autosnodato"] == 55.0


class TestPrePostRules:
    def test_defaults(self):
        rules = PrePostRules()
        assert rules.pre_turno_deposito == 12
        assert rules.pre_turno_cambio == 5

    def test_from_config(self):
        rules = PrePostRules.from_config({"preTurnoDeposito": 15})
        assert rules.pre_turno_deposito == 15
        assert rules.pre_turno_cambio == 5  # default preserved

    def test_to_dict(self):
        d = PrePostRules().to_dict()
        assert "preTurnoDeposito" in d
        assert d["preTurnoDeposito"] == 12


class TestRD131Config:
    def test_defaults(self):
        cfg = RD131Config()
        assert cfg.attivo is True
        assert cfg.max_guida_continuativa == 270

    def test_from_config_with_retro_compat(self):
        """Verifica che maxPeriodoContinuativo funzioni come alias."""
        cfg = RD131Config.from_config({"maxPeriodoContinuativo": 300})
        assert cfg.max_guida_continuativa == 300


# ═══════════════════════════════════════════════════════════════
#  MERGE CONFIG
# ═══════════════════════════════════════════════════════════════

class TestMergeConfig:
    def test_none_returns_defaults(self):
        cfg = merge_config(None)
        assert "shiftRules" in cfg
        assert "weights" in cfg
        assert cfg["solverIntensity"] == 2

    def test_weights_clamped(self):
        cfg = merge_config({"weights": {"minDrivers": 99, "workBalance": -5}})
        assert cfg["weights"]["minDrivers"] == 10.0
        assert cfg["weights"]["workBalance"] == 0.0

    def test_solver_intensity_clamped(self):
        cfg = merge_config({"solverIntensity": 10})
        assert cfg["solverIntensity"] == 3

    def test_shift_rules_merge(self):
        cfg = merge_config({"shiftRules": {"intero": {"maxNastro": 400}}})
        assert cfg["shiftRules"]["intero"]["maxNastro"] == 400
        # maxLavoro should keep its default
        assert cfg["shiftRules"]["intero"]["maxLavoro"] == 435


class TestWeightsToSolverParams:
    def test_default_weights(self):
        from optimizer_common import DEFAULT_OPERATOR_CONFIG
        params = weights_to_solver_params(DEFAULT_OPERATOR_CONFIG["weights"])
        assert "W_CREW" in params
        assert "W_WORK_DEV" in params
        assert params["W_CREW"] > 0

    def test_all_zero_weights(self):
        params = weights_to_solver_params({
            "minDrivers": 0, "workBalance": 0, "minCambi": 0,
            "preferIntero": 0, "minSupplementi": 0, "qualityTarget": 0,
        })
        assert params["W_CREW"] == 50_000
        assert params["W_WORK_DEV"] == 5


# ═══════════════════════════════════════════════════════════════
#  TRIP FROM DICT
# ═══════════════════════════════════════════════════════════════

class TestTripFromDict:
    def test_basic_conversion(self):
        d = {
            "tripId": "T1", "routeId": "R1", "departureMin": 420,
            "arrivalMin": 450, "firstStopId": "S1", "lastStopId": "S2",
        }
        t = trip_from_dict(d, 0)
        assert t.trip_id == "T1"
        assert t.departure_min == 420
        assert t.arrival_min == 450
        assert t.idx == 0
        assert t.departure_time == "07:00"  # min_to_time(420)
        assert t.arrival_time == "07:30"

    def test_defaults_applied(self):
        d = {"tripId": "T2", "routeId": "R2", "departureMin": 0, "arrivalMin": 30}
        t = trip_from_dict(d, 1)
        assert t.direction_id == 0
        assert t.headsign is None
        assert t.route_name == "R2"  # fallback to routeId
