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
        atteso = min(vo.CAR_CAP_TOTAL_EUR, vo.CAR_CAP_TOTAL_EUR / 3.0 * 2) / 2
        assert pen["a|b"] == atteso and pen["x|y"] == atteso

    def test_la_spesa_sul_problema_auto_e_limitata(self):
        # Anche con un tetto sfondato di molto, il totale speso non deve
        # arrivare a valere piu' vetture: spaccare i blocchi per evitare i
        # cambi e' il rovescio della regola aziendale.
        crew = _crew([_ho("V1", 540), _ho("V2", 540)], cap=5, picco=25)
        pen, diag = vo.handover_arc_penalties(VSP, crew)
        assert diag["autoRotte"] == 20
        assert sum(pen.values()) <= vo.CAR_CAP_TOTAL_EUR + 0.01

    def test_una_giornata_vettura_costa_molto_meno_del_giunto_ma_non_dieci(self):
        # Riferimento: una vettura in piu' costa ~42 EUR/giorno di costo fisso.
        assert 1.5 * 42 <= vo.UNATTENDED_PENALTY_EUR <= 3 * 42
        assert vo.CAR_CAP_TOTAL_EUR <= 4 * 42

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


    def test_il_mezzo_in_piu_pesa_quanto_costa_possederlo(self):
        """Nel giro AT la selezione ha preferito 30 vetture a 21 per 366 €:
        il costo di esercizio non vede il capitale fermo in rimessa."""
        base = {"summary": {"totalDailyCost": 100, "totalShifts": 5,
                            "validation": {"totalViolations": 0},
                            "companyCarsCap": 5, "companyCarsMaxSimultaneous": 5,
                            "companyCarsConflicts": 0,
                            "handoverModes": {"overLimit": []}}}
        magro = vo._round_kpi(1, {"metrics": {"costEur": 100, "vehicles": 21}}, base)
        grasso = vo._round_kpi(2, {"metrics": {"costEur": 100, "vehicles": 30}}, base)
        assert (grasso["selectionScoreEur"]
                == magro["selectionScoreEur"] + 9 * vo.VEHICLE_SHADOW_EUR)
        assert vo._round_rank(magro) < vo._round_rank(grasso)

    def test_il_supplemento_pesa_piu_di_un_turno_pieno(self):
        """Quello che il solver dei turni evita, la selezione non se lo ricompra."""
        vsp = {"metrics": {"costEur": 100, "vehicles": 10}}
        def _k(turni, suppl):
            return vo._round_kpi(1, vsp, {"summary": {
                "totalDailyCost": 100, "totalShifts": turni, "totalSupplementi": suppl,
                "validation": {"totalViolations": 0},
                "companyCarsCap": 5, "companyCarsMaxSimultaneous": 5,
                "companyCarsConflicts": 0, "handoverModes": {"overLimit": []}}})
        # 35 pieni + 8 supplementi contro 43 pieni + 1: stesso numero di uomini,
        # ma l'operatore vuole i turni interi
        con_suppl = _k(43, 8)
        quasi_tutti_pieni = _k(44, 1)
        assert quasi_tutti_pieni["selectionScoreEur"] < con_suppl["selectionScoreEur"]

    def test_il_giro_AT_si_sarebbe_scelto_il_round_giusto(self):
        """I numeri veri del giro AT: round 4 (30 vetture, 8 supplementi) contro
        round 5 (21 vetture, 1 supplemento), una violazione ciascuno."""
        def _k(r, vetture, costo_v, turni, suppl, costo_c):
            return vo._round_kpi(r, {"metrics": {"costEur": costo_v, "vehicles": vetture}},
                                 {"summary": {"totalDailyCost": costo_c, "totalShifts": turni,
                                              "totalSupplementi": suppl,
                                              "validation": {"totalViolations": 1},
                                              "companyCarsCap": 5, "companyCarsMaxSimultaneous": 4,
                                              "companyCarsConflicts": 0,
                                              "handoverModes": {"overLimit": []}}})
        r4 = _k(4, 30, 6533.89, 43, 8, 15062.14)
        r5 = _k(5, 21, 6423.40, 44, 1, 15338.51)
        assert vo._round_rank(r5) < vo._round_rank(r4), "vince il piano da 21 vetture"


class TestEscalation:
    """La penalità non è solo un costo, è una guida alla ricerca: finché il
    round resta illegale sui cambi si alza il tiro, e ci si ferma appena
    diventa legale — così si paga il minimo indispensabile."""

    def test_round_legale_riconosciuto(self):
        assert vo.round_is_legal(_crew([], cap=5, picco=5, conflitti=0)) is True

    def test_tetto_auto_sfondato_non_e_legale(self):
        assert vo.round_is_legal(_crew([], cap=5, picco=6)) is False

    def test_conflitto_auto_non_e_legale(self):
        assert vo.round_is_legal(_crew([], cap=5, picco=5, conflitti=1)) is False

    def test_bus_incustodito_non_e_legale(self):
        crew = _crew([], cap=5, picco=5, over=[{"vehicleId": "V1", "unattendedMin": 81}])
        assert vo.round_is_legal(crew) is False

    def test_l_escalation_moltiplica_la_penalita(self):
        crew = _crew([_ho("V1", 540, unattended=81)])
        base, _ = vo.handover_arc_penalties(VSP, crew)
        alzata, diag = vo.handover_arc_penalties(VSP, crew, escalation=4.0)
        assert alzata["a|b"] == base["a|b"] * 4.0
        assert diag["escalation"] == 4.0

    def test_il_tetto_di_spesa_sale_con_l_escalation_ma_resta_governato(self):
        crew = _crew([_ho("V1", 540), _ho("V2", 540)], cap=5, picco=25)
        pen, _ = vo.handover_arc_penalties(VSP, crew, escalation=vo.ESCALATION_MAX)
        assert sum(pen.values()) <= vo.CAR_CAP_TOTAL_EUR * vo.ESCALATION_MAX + 0.01


# ═══════════════════════════════════════════════════════════════
#  PREZZO DEI KM A VUOTO
# ═══════════════════════════════════════════════════════════════

from optimizer_common import VehicleCostRates  # noqa: E402


class TestCostoDeiVuoti:
    """Il corrispettivo è 2,60 €/km su TUTTI i km, di linea e di fuorilinea:
    un km a vuoto non è una perdita, è compensato. Quello che costa davvero è
    il tempo che impegna il conducente. Prezzare i vuoti solo a km faceva
    fuggire il motore dai rientri in deposito — che sono però la mossa con cui
    il conducente cambia mezzo senza autovettura."""

    def test_il_km_a_vuoto_e_compensato(self):
        r = VehicleCostRates()
        for tipo, costo in r.per_deadhead_km.items():
            assert costo < r.corrispettivo_per_km, (
                f"{tipo}: un km a vuoto costa {costo} e ne rende "
                f"{r.corrispettivo_per_km}, quindi al netto non costa nulla")

    def test_il_tempo_del_conducente_e_il_costo_vero(self):
        r = VehicleCostRates()
        # 27 €/ora
        assert abs(r.driver_cost_per_min * 60 - 27.0) < 0.5

    def test_un_vuoto_lento_costa_piu_di_uno_veloce_a_pari_km(self):
        r = VehicleCostRates()
        km_netto = max(0.0, r.per_deadhead_km["12m"] - r.corrispettivo_per_km)
        lento = 8 * km_netto + 40 * r.driver_cost_per_min
        veloce = 8 * km_netto + 12 * r.driver_cost_per_min
        assert lento > veloce

    def test_il_rientro_in_deposito_non_e_piu_una_penale(self):
        # I km e i minuti del rientro sono contati a parte: i 15 € di prima li
        # contavano una seconda volta ed erano il motivo per cui il motore
        # evitava il deposito.
        r = VehicleCostRates()
        assert r.per_depot_return <= 5.0


def test_le_regole_non_si_comprano():
    """Selezione fra round: prima chi rompe MENO REGOLE, poi il punteggio.

    Nel giro AP il motore ha scartato un piano da 20 vetture e ZERO violazioni
    per uno da 26 vetture e TRE violazioni, perche' le tre gli costavano 300
    EUR (VIOLATION_SHADOW_EUR = 100 l'una) mentre le sei vetture in piu'
    gliene facevano risparmiare 526. Ma il tetto delle autovetture l'operatore
    lo ha definito «inviolabile» e la normativa sui turni e' legge: un piano
    che le rompe non e' un piano peggiore, non e' un piano.
    """
    import vcsp_orchestrator as orch

    pulito = {"bdsViolations": 0, "selectionScoreEur": 30142.67}   # 20 vetture
    sporco = {"bdsViolations": 3, "selectionScoreEur": 29931.57}   # 26 vetture

    # il punteggio da' ragione allo sporco...
    assert sporco["selectionScoreEur"] < pulito["selectionScoreEur"]
    # ...ma l'ordine no: le regole vengono prima
    assert orch._round_rank(pulito) < orch._round_rank(sporco)


def test_fra_pari_violazioni_decide_il_punteggio():
    import vcsp_orchestrator as orch
    caro = {"bdsViolations": 2, "selectionScoreEur": 30000.0}
    economico = {"bdsViolations": 2, "selectionScoreEur": 29000.0}
    assert orch._round_rank(economico) < orch._round_rank(caro)
    # e una violazione in meno batte mille euro di risparmio
    meno_violazioni = {"bdsViolations": 1, "selectionScoreEur": 30000.0}
    assert orch._round_rank(meno_violazioni) < orch._round_rank(economico)


def test_early_stop_al_primo_round_non_esplode():
    """Al primo round non c'e' un precedente con cui misurarsi.

    Senza questo controllo l'accesso a rounds_kpi[-2] solleva IndexError e il
    giro muore dopo il round 1: e' successo nel giro AQ, in produzione.
    """
    import vcsp_orchestrator as orch
    assert orch._round_without_gain([]) is False
    assert orch._round_without_gain([{"bdsViolations": 3, "selectionScoreEur": 30642.55}]) is False


def test_early_stop_usa_lo_stesso_ordine_della_selezione():
    import vcsp_orchestrator as orch
    # punteggio peggiore ma UNA VIOLAZIONE IN MENO: e' un miglioramento
    migliorato = [{"bdsViolations": 3, "selectionScoreEur": 30000.0},
                  {"bdsViolations": 2, "selectionScoreEur": 30500.0}]
    assert orch._round_without_gain(migliorato) is False
    # punteggio migliore ma una violazione in piu': non e' un miglioramento
    peggiorato = [{"bdsViolations": 2, "selectionScoreEur": 30500.0},
                  {"bdsViolations": 3, "selectionScoreEur": 30000.0}]
    assert orch._round_without_gain(peggiorato) is True
    # a pari violazioni decide il punteggio
    assert orch._round_without_gain([{"bdsViolations": 2, "selectionScoreEur": 30000.0},
                                     {"bdsViolations": 2, "selectionScoreEur": 29000.0}]) is False
    assert orch._round_without_gain([{"bdsViolations": 2, "selectionScoreEur": 29000.0},
                                     {"bdsViolations": 2, "selectionScoreEur": 30000.0}]) is True
