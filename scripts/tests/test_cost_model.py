"""
Test unitari per cost_model.py
Copre: CostRates, DutyCostBreakdown, compute_duty_cost con duty mock.
"""

import pytest

from optimizer_common import (
    Duty, Ripresa, DutyBlock, Task, VShiftTrip, CambioInfo,
)
from cost_model import CostRates, DutyCostBreakdown, compute_duty_cost, compute_global_cost_breakdown


# ═══════════════════════════════════════════════════════════════
#  HELPERS — Build minimal duty fixtures
# ═══════════════════════════════════════════════════════════════

def make_trip(dep_min: int, arr_min: int, **kwargs) -> VShiftTrip:
    return VShiftTrip(
        type="trip",
        trip_id=kwargs.get("trip_id", "T1"),
        route_id="R1",
        route_name="Linea 1",
        headsign=None,
        departure_time=f"{dep_min // 60:02d}:{dep_min % 60:02d}",
        arrival_time=f"{arr_min // 60:02d}:{arr_min % 60:02d}",
        departure_min=dep_min,
        arrival_min=arr_min,
        first_stop_name="Partenza",
        last_stop_name="Arrivo",
        stop_count=10,
        duration_min=arr_min - dep_min,
    )


def make_task(dep_min: int, arr_min: int, trips=None) -> Task:
    if trips is None:
        trips = [make_trip(dep_min, arr_min)]
    return Task(
        idx=0,
        vehicle_id="V1",
        vehicle_type="12m",
        trips=trips,
        start_min=dep_min,
        end_min=arr_min,
        duration_min=arr_min - dep_min,
        driving_min=arr_min - dep_min,
        first_stop="Partenza",
        last_stop="Arrivo",
        first_cluster="stazione",
        last_cluster="cavour",
    )


def make_simple_duty(dep_min=420, arr_min=810, duty_type="intero") -> Duty:
    """Crea un duty minimo: 1 ripresa, 1 blocco, 1 corsa di 6h30 (07:00-13:30)."""
    task = make_task(dep_min, arr_min)
    block = DutyBlock(task=task, cambio=None)
    rip = Ripresa(
        blocks=[block],
        start_min=dep_min,
        end_min=arr_min,
        pre_turno_min=12,
        transfer_min=10,
        transfer_type="auto",
        work_min=arr_min - dep_min + 12 + 10,
    )
    return Duty(
        idx=0,
        duty_type=duty_type,
        riprese=[rip],
        nastro_start=dep_min - 22,
        nastro_end=arr_min,
        nastro_min=arr_min - (dep_min - 22),
        work_min=arr_min - dep_min + 12 + 10,
        interruption_min=0,
        transfer_min=10,
        pre_turno_min=12,
        cambi_count=0,
        task_indices=[0],
    )


# ═══════════════════════════════════════════════════════════════
#  COST RATES
# ═══════════════════════════════════════════════════════════════

class TestCostRates:
    def test_defaults(self):
        rates = CostRates()
        assert rates.hourly_rate == 22.0
        assert rates.overtime_multiplier == 1.3
        assert rates.target_work_min == 390

    def test_from_config_empty(self):
        rates = CostRates.from_config({})
        assert rates.hourly_rate == 22.0

    def test_from_config_override(self):
        rates = CostRates.from_config({
            "costRates": {"hourlyRate": 25.0, "companyCars": 3}
        })
        assert rates.hourly_rate == 25.0
        assert rates.company_cars == 3

    def test_to_dict(self):
        d = CostRates().to_dict()
        assert "hourlyRate" in d
        assert d["hourlyRate"] == 22.0
        assert "companyCars" in d


# ═══════════════════════════════════════════════════════════════
#  DUTY COST BREAKDOWN
# ═══════════════════════════════════════════════════════════════

class TestDutyCostBreakdown:
    def test_compute_sums(self):
        c = DutyCostBreakdown(base_salary=100, driving_cost=50, cambio_cost=5)
        c.compute()
        assert c.total == 155.0

    def test_to_dict_keys(self):
        c = DutyCostBreakdown()
        c.compute()
        d = c.to_dict()
        expected_keys = {
            "baseSalary", "overtimeCost", "undertimeCost", "drivingCost",
            "idleAtTerminalCost", "preTurnoCost", "transferDepotCost",
            "interruptionCost", "companyCarCost", "taxiCost", "cambioCost",
            "fragmentationPenalty", "workImbalancePenalty", "total",
            "idleSegments", "transferDetails",
        }
        assert set(d.keys()) == expected_keys


# ═══════════════════════════════════════════════════════════════
#  COMPUTE DUTY COST — Golden path
# ═══════════════════════════════════════════════════════════════

class TestComputeDutyCost:
    def test_simple_intero_duty(self):
        """Un turno intero di ~6h30 dovrebbe avere costo ragionevole."""
        duty = make_simple_duty(dep_min=420, arr_min=810)  # 07:00 - 13:30
        rates = CostRates()
        cost = compute_duty_cost(duty, rates)

        assert cost.total > 0
        assert cost.driving_cost > 0
        assert cost.base_salary > 0
        assert cost.pre_turno_cost > 0
        assert cost.company_car_cost > 0  # 1 ripresa = 1 trasferimento

    def test_cost_proportional_to_work(self):
        """Turno più lungo → costo maggiore."""
        short_duty = make_simple_duty(dep_min=420, arr_min=750)  # 5h30
        long_duty = make_simple_duty(dep_min=420, arr_min=870)   # 7h30
        rates = CostRates()
        cost_short = compute_duty_cost(short_duty, rates)
        cost_long = compute_duty_cost(long_duty, rates)
        assert cost_long.total > cost_short.total

    def test_supplemento_gets_fixed_indennity(self):
        """Turno supplemento deve avere indennità fissa aggiuntiva."""
        regular = make_simple_duty(dep_min=420, arr_min=540, duty_type="intero")
        suppl = make_simple_duty(dep_min=420, arr_min=540, duty_type="supplemento")
        rates = CostRates()
        cost_regular = compute_duty_cost(regular, rates)
        cost_suppl = compute_duty_cost(suppl, rates)
        # Supplemento ha costo base_salary maggiore di rates.supplemento_fixed
        assert cost_suppl.base_salary > cost_regular.base_salary
        assert cost_suppl.base_salary >= cost_regular.base_salary + rates.supplemento_fixed - 0.01

    def test_overtime_penalty(self):
        """Turno molto lungo → overtime cost > 0."""
        long_duty = make_simple_duty(dep_min=360, arr_min=900)  # 9h
        # work_min = 540 + 22 = 562 → molto sopra target 396
        rates = CostRates()
        cost = compute_duty_cost(long_duty, rates)
        assert cost.overtime_cost > 0

    def test_duty_with_cambio(self):
        """Un turno con cambio in linea deve avere cambio_cost > 0."""
        task1 = make_task(420, 600)
        task2 = make_task(600, 780)
        cambio = CambioInfo(
            cluster="stazione", cluster_name="Stazione FS",
            from_vehicle="V1", to_vehicle="V2",
        )
        block1 = DutyBlock(task=task1, cambio=None)
        block2 = DutyBlock(task=task2, cambio=cambio)
        rip = Ripresa(
            blocks=[block1, block2],
            start_min=420, end_min=780,
            pre_turno_min=12, transfer_min=10,
            transfer_type="auto", work_min=372,
        )
        duty = Duty(
            idx=0, duty_type="intero", riprese=[rip],
            nastro_start=398, nastro_end=780, nastro_min=382,
            work_min=372, interruption_min=0, transfer_min=10,
            pre_turno_min=12, cambi_count=1, task_indices=[0, 1],
        )
        rates = CostRates()
        cost = compute_duty_cost(duty, rates)
        assert cost.cambio_cost > 0

    def test_idle_at_terminal(self):
        """Turno con attesa tra corse → idle_at_terminal_cost > 0."""
        trip1 = make_trip(420, 480)
        trip2 = make_trip(510, 570)  # 30 min gap
        task = make_task(420, 570, trips=[trip1, trip2])
        block = DutyBlock(task=task, cambio=None)
        rip = Ripresa(
            blocks=[block], start_min=420, end_min=570,
            pre_turno_min=12, transfer_min=10,
            transfer_type="auto", work_min=172,
        )
        duty = Duty(
            idx=0, duty_type="intero", riprese=[rip],
            nastro_start=398, nastro_end=570, nastro_min=172,
            work_min=172, interruption_min=0, transfer_min=10,
            pre_turno_min=12, cambi_count=0, task_indices=[0],
        )
        rates = CostRates()
        cost = compute_duty_cost(duty, rates)
        assert cost.idle_at_terminal_cost > 0


# ═══════════════════════════════════════════════════════════════
#  GLOBAL COST BREAKDOWN
# ═══════════════════════════════════════════════════════════════

class TestGlobalCostBreakdown:
    def test_single_duty(self):
        duty = make_simple_duty()
        rates = CostRates()
        duty.cost_breakdown = compute_duty_cost(duty, rates)
        result = compute_global_cost_breakdown([0], [duty], rates)
        assert result["totalDailyCost"] > 0
        assert "costBreakdown" in result
        assert "efficiency" in result
        assert "rates" in result

    def test_empty_selection(self):
        result = compute_global_cost_breakdown([], [], CostRates())
        assert result["totalDailyCost"] == 0.0
