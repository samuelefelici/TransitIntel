"""Il mattone che si sposta e' il GIRO, non la corsa.

Regola dell'operatore: la sosta al capolinea periferico e' solo un cuscinetto
per assorbire i ritardi, quindi e' cortissima. Se si slitta in avanti l'andata
bisogna slittare in avanti anche il ritorno; se si slitta il ritorno da solo la
sosta al capolinea si allunga. La sonda spostava UNA corsa sola — l'ultima del
primo pezzo o la prima del secondo — e faceva esattamente questo.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vcsp_probe as probe  # noqa: E402


def _t(tid, route, direction, dep, arr, first, last, flex=30):
    return {"tripId": tid, "routeId": route, "directionId": direction,
            "departureMin": dep, "arrivalMin": arr,
            "firstStopId": first, "lastStopId": last,
            "routeName": route, "flexMin": flex}


def _giro():
    """Linea 21/33: andata Posatora→Montesicuro 09:00-09:30, sosta 6', ritorno
    Montesicuro→Posatora 09:36-10:06. Piu' una corsa di un'altra linea."""
    return [
        _t("a", "R21", 0, 540, 570, "POSATORA", "MONTESICURO"),
        _t("r", "R21", 1, 576, 606, "MONTESICURO", "POSATORA"),
        _t("x", "R30", 0, 600, 630, "UGOBASSI", "OSPEDALE"),
    ]


def test_andata_e_ritorno_sono_accoppiati():
    pairs = probe.build_round_trip_pairs(_giro())
    assert pairs["a"] == "r"
    assert pairs["r"] == "a"          # la mappa e' simmetrica
    assert "x" not in pairs           # nessun ritorno entro la sosta massima


def test_una_sosta_troppo_lunga_non_e_un_giro():
    """Oltre la sosta massima non e' piu' un'andata col suo ritorno: e' un'altra
    corsa, e puo' muoversi per conto suo."""
    trips = _giro()
    trips[1]["departureMin"] = 570 + probe.ROUND_TRIP_MAX_GAP + 1
    trips[1]["arrivalMin"] = trips[1]["departureMin"] + 30
    assert probe.build_round_trip_pairs(trips) == {}


def test_spostare_l_andata_porta_con_se_il_ritorno():
    """E' il cuore della regola: la sosta al capolinea resta identica al minuto."""
    trips = _giro()
    pairs = probe.build_round_trip_pairs(trips)
    sosta_prima = trips[1]["departureMin"] - trips[0]["arrivalMin"]

    shifts = probe.expand_to_round_trips({"a": +15}, pairs)
    assert shifts == {"a": 15, "r": 15}, "il ritorno deve seguire l'andata"

    dopo = probe._apply_shifts(trips, shifts)
    d = {t["tripId"]: t for t in dopo}
    sosta_dopo = d["r"]["departureMin"] - d["a"]["arrivalMin"]
    assert sosta_dopo == sosta_prima, "la sosta al capolinea non deve cambiare"
    assert d["x"]["departureMin"] == 600, "le altre linee non si toccano"


def test_il_giro_si_muove_quanto_regge_il_pezzo_piu_rigido():
    """Se il ritorno regge 10 minuti, il giro si muove di 10 anche se l'andata
    ne reggerebbe 30."""
    trips = _giro()
    trips[1]["flexMin"] = 10
    by_id = {t["tripId"]: t for t in trips}
    pairs = probe.build_round_trip_pairs(trips)
    assert probe._flex_of(trips[0]) == 30
    assert probe.flex_of_round_trip(trips[0], pairs, by_id) == 10
    # una corsa senza ritorno accoppiato resta libera
    assert probe.flex_of_round_trip(trips[2], pairs, by_id) == 30
