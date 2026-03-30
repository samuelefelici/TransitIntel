"""
cost_model.py — Modello di costo granulare per turni guida
Conerobus S.p.A. / TransitIntel

Ogni duty candidato viene valutato in euro.
La funzione obiettivo del solver minimizza direttamente il costo totale.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any

from optimizer_common import (
    Duty, Ripresa, DutyBlock,
    TARGET_WORK_MID,
    COMPANY_CARS,
)


# ═══════════════════════════════════════════════════════════════
#  TARIFFE (tutte in euro)
# ═══════════════════════════════════════════════════════════════

@dataclass
class CostRates:
    """Tariffe unitarie per il calcolo costi, tutte in euro.  Configurabili dall'operatore."""

    # ── Autista ──
    hourly_rate: float = 22.00              # €/ora retribuzione lorda + oneri
    overtime_multiplier: float = 1.30       # maggiorazione straordinario
    supplemento_fixed: float = 18.00        # indennità fissa turno supplemento

    # ── Tempo improduttivo ──
    idle_rate_fraction: float = 1.0         # attesa capolinea retribuita al 100%
    interruption_rate_fraction: float = 0.0 # interruzione semiunico/spezzato NON retribuita
    pre_turno_rate_fraction: float = 1.0    # pre-turno retribuito al 100%
    transfer_rate_fraction: float = 1.0     # trasferimento retribuito al 100%

    # ── Trasferimenti ──
    company_car_per_use: float = 8.00       # €/trasferimento auto aziendale
    taxi_base: float = 6.00                 # €/corsa taxi partenza
    taxi_per_km: float = 1.50              # €/km taxi
    taxi_per_min_wait: float = 0.40         # €/min attesa taxi

    # ── Cambi in linea ──
    cambio_overhead: float = 5.00           # €/cambio coordinamento + rischio
    cambio_risk_per_min_short: float = 2.00 # penalità se gap < 5 min

    # ── Penalità qualità ──
    fragmentation_per_gap: float = 3.00     # €/gap > 10 min nel turno
    work_imbalance_per_min: float = 0.50    # €/min deviazione dal target
    long_idle_penalty_per_min: float = 0.80 # €/min per attese > 20 min

    # ── Turno aggiuntivo ──
    extra_driver_daily: float = 180.00      # costo medio giornaliero conducente aggiuntivo
    supplemento_daily: float = 95.00        # costo medio turno supplemento

    # ── Target lavoro (min) ──
    target_work_min: int = 390              # 6h30
    target_work_max: int = 402              # 6h42

    # ── Autovetture aziendali disponibili ──
    company_cars: int = COMPANY_CARS

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> "CostRates":
        """Costruisce CostRates da un dict di configurazione operatore."""
        cost_cfg = cfg.get("costRates", {})
        rates = cls()
        # Map ogni chiave configurabile
        _MAP = {
            "hourlyRate": "hourly_rate",
            "overtimeMultiplier": "overtime_multiplier",
            "supplementoFixed": "supplemento_fixed",
            "idleRateFraction": "idle_rate_fraction",
            "interruptionRateFraction": "interruption_rate_fraction",
            "preTurnoRateFraction": "pre_turno_rate_fraction",
            "transferRateFraction": "transfer_rate_fraction",
            "companyCarPerUse": "company_car_per_use",
            "taxiBase": "taxi_base",
            "taxiPerKm": "taxi_per_km",
            "taxiPerMinWait": "taxi_per_min_wait",
            "cambioOverhead": "cambio_overhead",
            "cambioRiskPerMinShort": "cambio_risk_per_min_short",
            "fragmentationPerGap": "fragmentation_per_gap",
            "workImbalancePerMin": "work_imbalance_per_min",
            "longIdlePenaltyPerMin": "long_idle_penalty_per_min",
            "extraDriverDaily": "extra_driver_daily",
            "supplementoDaily": "supplemento_daily",
            "targetWorkMin": "target_work_min",
            "targetWorkMax": "target_work_max",
            "companyCars": "company_cars",
        }
        for js_key, py_attr in _MAP.items():
            if js_key in cost_cfg:
                setattr(rates, py_attr, type(getattr(rates, py_attr))(cost_cfg[js_key]))
        return rates

    def to_dict(self) -> dict[str, Any]:
        """Serializza le tariffe per l'output JSON."""
        return {
            "hourlyRate": self.hourly_rate,
            "overtimeMultiplier": self.overtime_multiplier,
            "supplementoFixed": self.supplemento_fixed,
            "companyCarPerUse": self.company_car_per_use,
            "taxiBase": self.taxi_base,
            "cambioOverhead": self.cambio_overhead,
            "extraDriverDaily": self.extra_driver_daily,
            "supplementoDaily": self.supplemento_daily,
            "targetWorkMin": self.target_work_min,
            "targetWorkMax": self.target_work_max,
            "companyCars": self.company_cars,
        }


# ═══════════════════════════════════════════════════════════════
#  BREAKDOWN COSTO DI UN DUTY
# ═══════════════════════════════════════════════════════════════

@dataclass
class DutyCostBreakdown:
    """Costo dettagliato di un singolo turno guida, in euro."""

    # Costo autista
    base_salary: float = 0.0
    overtime_cost: float = 0.0
    undertime_cost: float = 0.0

    # Tempo produttivo
    driving_cost: float = 0.0

    # Tempo improduttivo
    idle_at_terminal_cost: float = 0.0
    pre_turno_cost: float = 0.0
    transfer_depot_cost: float = 0.0
    interruption_cost: float = 0.0

    # Trasferimenti
    company_car_cost: float = 0.0
    taxi_cost: float = 0.0

    # Cambi in linea
    cambio_cost: float = 0.0

    # Penalità qualità
    fragmentation_penalty: float = 0.0
    work_imbalance_penalty: float = 0.0

    # Totale
    total: float = 0.0

    # Dettagli per il frontend
    idle_segments: list[dict] = field(default_factory=list)
    transfer_details: list[dict] = field(default_factory=list)

    def compute(self):
        self.total = (
            self.base_salary
            + self.overtime_cost
            + self.undertime_cost
            + self.driving_cost
            + self.idle_at_terminal_cost
            + self.pre_turno_cost
            + self.transfer_depot_cost
            + self.interruption_cost
            + self.company_car_cost
            + self.taxi_cost
            + self.cambio_cost
            + self.fragmentation_penalty
            + self.work_imbalance_penalty
        )
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "baseSalary": round(self.base_salary, 2),
            "overtimeCost": round(self.overtime_cost, 2),
            "undertimeCost": round(self.undertime_cost, 2),
            "drivingCost": round(self.driving_cost, 2),
            "idleAtTerminalCost": round(self.idle_at_terminal_cost, 2),
            "preTurnoCost": round(self.pre_turno_cost, 2),
            "transferDepotCost": round(self.transfer_depot_cost, 2),
            "interruptionCost": round(self.interruption_cost, 2),
            "companyCarCost": round(self.company_car_cost, 2),
            "taxiCost": round(self.taxi_cost, 2),
            "cambioCost": round(self.cambio_cost, 2),
            "fragmentationPenalty": round(self.fragmentation_penalty, 2),
            "workImbalancePenalty": round(self.work_imbalance_penalty, 2),
            "total": round(self.total, 2),
            "idleSegments": self.idle_segments,
            "transferDetails": self.transfer_details,
        }


# ═══════════════════════════════════════════════════════════════
#  CALCOLO COSTO PER UN DUTY
# ═══════════════════════════════════════════════════════════════

def compute_duty_cost(duty: Duty, rates: CostRates) -> DutyCostBreakdown:
    """
    Calcola il costo in euro di un duty candidato.
    Il costo è la somma di tutte le voci: salario, tempo improduttivo,
    trasferimenti, cambi, penalità qualità.
    """
    c = DutyCostBreakdown()
    per_min = rates.hourly_rate / 60.0

    # ── 1. Guida effettiva ──
    total_driving = 0
    for rip in duty.riprese:
        for block in rip.blocks:
            for t in block.task.trips:
                total_driving += t.arrival_min - t.departure_min
    c.driving_cost = total_driving * per_min

    # ── 2. Attesa al capolinea ──
    total_idle = 0
    long_idle_extra = 0.0
    idle_segments: list[dict] = []

    for rip in duty.riprese:
        for block in rip.blocks:
            trips = block.task.trips
            for i in range(1, len(trips)):
                gap = trips[i].departure_min - trips[i - 1].arrival_min
                if gap > 0:
                    total_idle += gap
                    if gap > 20:
                        long_idle_extra += (gap - 20) * rates.long_idle_penalty_per_min
                    if gap > 5:
                        idle_segments.append({
                            "location": trips[i - 1].last_stop_name or "?",
                            "startMin": trips[i - 1].arrival_min,
                            "endMin": trips[i].departure_min,
                            "durationMin": gap,
                            "cost": round(gap * per_min * rates.idle_rate_fraction
                                          + (max(0, gap - 20) * rates.long_idle_penalty_per_min), 2),
                        })

        # Gap tra blocchi nella stessa ripresa
        for i in range(1, len(rip.blocks)):
            inter_gap = rip.blocks[i].task.start_min - rip.blocks[i - 1].task.end_min
            if inter_gap > 0:
                total_idle += inter_gap
                if inter_gap > 20:
                    long_idle_extra += (inter_gap - 20) * rates.long_idle_penalty_per_min

    c.idle_at_terminal_cost = total_idle * per_min * rates.idle_rate_fraction + long_idle_extra
    c.idle_segments = idle_segments

    # ── 3. Pre-turno ──
    c.pre_turno_cost = duty.pre_turno_min * per_min * rates.pre_turno_rate_fraction

    # ── 4. Trasferimento deposito ──
    c.transfer_depot_cost = duty.transfer_min * per_min * rates.transfer_rate_fraction

    # ── 5. Auto aziendale (ogni ripresa necessita di trasferimento deposito→cluster) ──
    n_transfers = len(duty.riprese)
    c.company_car_cost = n_transfers * rates.company_car_per_use
    c.transfer_details = [
        {
            "type": "company_car",
            "from": "Deposito",
            "to": rip.blocks[0].task.first_stop if rip.blocks else "?",
            "timeMin": rip.transfer_min,
            "cost": round(rates.company_car_per_use, 2),
        }
        for rip in duty.riprese
    ]

    # ── 6. Cambi in linea ──
    c.cambio_cost = 0.0
    for rip in duty.riprese:
        for bi, block in enumerate(rip.blocks):
            if block.cambio:
                c.cambio_cost += rates.cambio_overhead
                # Penalità extra per cambi stretti
                if bi > 0:
                    gap_at_cambio = block.task.start_min - rip.blocks[bi - 1].task.end_min
                    if gap_at_cambio < 5:
                        c.cambio_cost += rates.cambio_risk_per_min_short * (5 - gap_at_cambio)

    # ── 7. Retribuzione base (lavoro retribuito) ──
    # Il conducente è pagato per work_min (guida + attese + pre-turno + trasferimento)
    c.base_salary = duty.work_min * per_min

    # ── 8. Straordinario / sotto-orario ──
    target_mid = (rates.target_work_min + rates.target_work_max) / 2.0
    if duty.work_min > target_mid + 12:
        excess = duty.work_min - target_mid
        c.overtime_cost = excess * per_min * (rates.overtime_multiplier - 1)
    else:
        c.overtime_cost = 0

    if duty.work_min < target_mid - 30:
        deficit = target_mid - duty.work_min
        c.undertime_cost = deficit * rates.work_imbalance_per_min
    else:
        c.undertime_cost = 0

    # ── 9. Supplemento indennità fissa ──
    if duty.duty_type == "supplemento":
        c.base_salary += rates.supplemento_fixed

    # ── 10. Interruzione (semiunico/spezzato — non retribuita, costo opportunità) ──
    if duty.interruption_min > 0:
        c.interruption_cost = duty.interruption_min * per_min * rates.interruption_rate_fraction

    # ── 11. Penalità frammentazione ──
    gaps_over_10 = 0
    for rip in duty.riprese:
        for i in range(1, len(rip.blocks)):
            if rip.blocks[i].task.start_min - rip.blocks[i - 1].task.end_min > 10:
                gaps_over_10 += 1
    c.fragmentation_penalty = gaps_over_10 * rates.fragmentation_per_gap

    # ── 12. Penalità sbilanciamento ──
    dev = abs(duty.work_min - target_mid)
    c.work_imbalance_penalty = dev * rates.work_imbalance_per_min

    c.compute()
    return c


# ═══════════════════════════════════════════════════════════════
#  SUMMARY GLOBALE BREAKDOWN COSTI
# ═══════════════════════════════════════════════════════════════

def compute_global_cost_breakdown(
    selected_indices: list[int],
    duties: list[Duty],
    rates: CostRates,
) -> dict:
    """
    Calcola il breakdown costi globale per tutti i turni selezionati.
    Ritorna un dict per il summary JSON.
    """
    totals = DutyCostBreakdown()
    per_duty_costs: list[float] = []

    for d in selected_indices:
        duty = duties[d]
        cb = getattr(duty, "cost_breakdown", None)
        if cb is None:
            cb = compute_duty_cost(duty, rates)
        per_duty_costs.append(cb.total)

        totals.base_salary += cb.base_salary
        totals.overtime_cost += cb.overtime_cost
        totals.undertime_cost += cb.undertime_cost
        totals.driving_cost += cb.driving_cost
        totals.idle_at_terminal_cost += cb.idle_at_terminal_cost
        totals.pre_turno_cost += cb.pre_turno_cost
        totals.transfer_depot_cost += cb.transfer_depot_cost
        totals.interruption_cost += cb.interruption_cost
        totals.company_car_cost += cb.company_car_cost
        totals.taxi_cost += cb.taxi_cost
        totals.cambio_cost += cb.cambio_cost
        totals.fragmentation_penalty += cb.fragmentation_penalty
        totals.work_imbalance_penalty += cb.work_imbalance_penalty

    totals.compute()
    n = max(len(selected_indices), 1)

    # Calcola ore produttive vs improduttive
    total_driving_min = sum(
        sum(t.arrival_min - t.departure_min
            for rip in duties[d].riprese
            for b in rip.blocks
            for t in b.task.trips)
        for d in selected_indices
    )
    total_work_min = sum(duties[d].work_min for d in selected_indices)
    total_transfer_min = sum(duties[d].transfer_min for d in selected_indices)
    total_idle_min = total_work_min - total_driving_min - sum(duties[d].pre_turno_min for d in selected_indices) - total_transfer_min
    total_all_min = total_work_min + total_transfer_min

    return {
        "totalDailyCost": round(totals.total, 2),
        "costBreakdown": {
            "salaries": round(totals.base_salary, 2),
            "overtime": round(totals.overtime_cost, 2),
            "undertime": round(totals.undertime_cost, 2),
            "driving": round(totals.driving_cost, 2),
            "idleAtTerminal": round(totals.idle_at_terminal_cost, 2),
            "preTurno": round(totals.pre_turno_cost, 2),
            "transfers": round(totals.transfer_depot_cost + totals.company_car_cost + totals.taxi_cost, 2),
            "cambi": round(totals.cambio_cost, 2),
            "penalties": round(totals.fragmentation_penalty + totals.work_imbalance_penalty, 2),
        },
        "efficiency": {
            "productiveTimePct": round(total_driving_min / max(total_all_min, 1) * 100, 1),
            "idleTimePct": round(max(0, total_idle_min) / max(total_all_min, 1) * 100, 1),
            "transferTimePct": round(total_transfer_min / max(total_all_min, 1) * 100, 1),
            "avgCostPerDriver": round(totals.total / n, 2),
            "avgCostPerServiceHour": round(totals.total / max(total_driving_min / 60, 1), 2),
        },
        "rates": rates.to_dict(),
    }
