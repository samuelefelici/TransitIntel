"""Penalità mirate sui giunti che rompono una regola rigida.

Il costo-ombra per blocco dice al VSP «questo blocco costa troppo» e spalma la
penalità su tutti i suoi archi. Ma il tetto delle autovetture aziendali e il bus
lasciato senza conducente oltre il limite NON sono violazioni BDS di un turno:
sono esiti del parco auto, e nel segnale di ritorno pesavano zero. Il risultato
era che nessun numero di round poteva sistemarle, perché il VSP non sapeva
nemmeno che esistessero — né quale giunto sciogliere.
"""

import vcsp_orchestrator as vo


def _vsp(blocchi: dict[str, list[tuple[str, int, int]]]) -> dict:
    """blocchi: vehicleId -> [(tripId, partenza, arrivo), ...]"""
    return {"vehicleShifts": [
        {"vehicleId": vid, "trips": [
            {"type": "trip", "tripId": t, "departureMin": d, "arrivalMin": a}
            for t, d, a in corse]}
        for vid, corse in blocchi.items()]}


def _crew(handovers, *, cap=5, picco=5, conflitti=0, over=()):
    return {
        "handovers": list(handovers),
        "driverShifts": [],
        "summary": {
            "companyCarsCap": cap,
            "companyCarsMaxSimultaneous": picco,
            "companyCarsConflicts": conflitti,
            "handoverModes": {"unattendedLimitMin": 15, "overLimit": list(over)},
        },
    }


def _ho(vid, at_min, *, unattended=0, mode="car"):
    return {"vehicleId": vid, "atMin": at_min, "kind": "inline",
            "unattendedMin": unattended, "incomingMode": mode, "outgoingMode": mode}


VSP = _vsp({"V1": [("a", 480, 540), ("b", 560, 620), ("c", 640, 700)],
            "V2": [("x", 480, 540), ("y", 700, 760)]})


class TestGiuntiIncustoditi:
    def test_il_bus_lasciato_solo_penalizza_il_suo_giunto(self):
        # Cambio sul blocco V1 alle 9:00 (fine della corsa "a"): il giunto è a|b.
        crew = _crew([_ho("V1", 540, unattended=81)])
        pen, diag = vo.handover_arc_penalties(VSP, crew)
        assert pen.get("a|b") == vo.UNATTENDED_PENALTY_EUR
        assert diag["giuntiIncustoditi"] == 1
        # e non tocca gli altri giunti del blocco
        assert "b|c" not in pen

    def test_dentro_il_limite_non_penalizza(self):
        crew = _crew([_ho("V1", 540, unattended=12)])
        pen, diag = vo.handover_arc_penalties(VSP, crew)
        assert pen == {} and diag["giuntiIncustoditi"] == 0

    def test_il_giunto_scelto_e_il_piu_vicino_nel_tempo(self):
        crew = _crew([_ho("V1", 625, unattended=90)])
        pen, _ = vo.handover_arc_penalties(VSP, crew)
        assert list(pen) == ["b|c"]


class TestTettoAuto:
    def test_il_tetto_sforato_si_divide_sui_cambi_che_usano_l_auto(self):
        crew = _crew([_ho("V1", 540), _ho("V2", 540)], cap=5, picco=7)
        pen, diag = vo.handover_arc_penalties(VSP, crew)
        assert diag["eccedenzaPicco"] == 2 and diag["autoRotte"] == 2
        atteso = (vo.CAR_CAP_PENALTY_EUR * 2) / 2
        assert pen["a|b"] == atteso and pen["x|y"] == atteso

    def test_i_cambi_a_piedi_non_consumano_auto(self):
        crew = _crew([_ho("V1", 540, mode="walk"), _ho("V2", 540)], cap=5, picco=6)
        pen, diag = vo.handover_arc_penalties(VSP, crew)
        assert diag["giuntiConAuto"] == 1
        assert "a|b" not in pen and "x|y" in pen

    def test_tetto_rispettato_nessuna_penalita(self):
        crew = _crew([_ho("V1", 540), _ho("V2", 540)], cap=5, picco=4)
        pen, diag = vo.handover_arc_penalties(VSP, crew)
        assert pen == {} and diag["autoRotte"] == 0

    def test_i_conflitti_contano_anche_senza_eccedenza_di_picco(self):
        crew = _crew([_ho("V1", 540)], cap=5, picco=5, conflitti=3)
        _, diag = vo.handover_arc_penalties(VSP, crew)
        assert diag["autoRotte"] == 3


class TestSelezioneFraRound:
    def test_il_bus_incustodito_entra_nel_punteggio(self):
        vsp = {"metrics": {"costEur": 100, "vehicles": 10}}
        base = {"summary": {"totalDailyCost": 100, "totalShifts": 5,
                            "validation": {"totalViolations": 0},
                            "companyCarsCap": 5, "companyCarsMaxSimultaneous": 5,
                            "companyCarsConflicts": 0,
                            "handoverModes": {"overLimit": []}}}
        pulito = vo._round_kpi(1, vsp, base)
        rotto = dict(base)
        rotto["summary"] = dict(base["summary"],
                                handoverModes={"overLimit": [{"vehicleId": "V1"}, {"vehicleId": "V2"}]})
        con_incustodito = vo._round_kpi(1, vsp, rotto)
        assert con_incustodito["unattendedOverLimit"] == 2
        assert (con_incustodito["selectionScoreEur"]
                == pulito["selectionScoreEur"] + 2 * vo.VIOLATION_SHADOW_EUR)
