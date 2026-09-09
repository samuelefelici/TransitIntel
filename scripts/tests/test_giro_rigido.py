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
            "firstStopName": first, "lastStopName": last,
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


def _rete_con_coincidenza():
    """Alla Madonnetta la 2/6 arriva e la 21/33 riparte 3 minuti dopo, quattro
    volte nella giornata: e' una coincidenza, non un incontro casuale."""
    trips = []
    for k, ora in enumerate((480, 540, 600, 660)):
        trips.append(_t("in%d" % k, "R26", 0, ora - 30, ora,
                        "CAVOUR", "MADONNETTA  CAPOLINEA"))
        trips.append(_t("out%d" % k, "R2133", 0, ora + 3, ora + 33,
                       "MADONNETTA (CAPOLINEA)", "MONTESICURO"))
    # due linee che si sfiorano una volta sola: non e' una coincidenza
    trips.append(_t("z1", "R44", 0, 700, 730, "CAVOUR", "TAVERNELLE"))
    trips.append(_t("z2", "R43", 0, 732, 762, "TAVERNELLE", "CAVOUR"))
    return trips


def test_le_coincidenze_si_riconoscono_dall_orario():
    c = probe.detect_coincidences(_rete_con_coincidenza())
    assert len(c) == 1, "una sola relazione sistematica"
    assert c[0]["fromRoute"] == "R26" and c[0]["toRoute"] == "R2133"
    assert c[0]["occurrences"] == 4
    # il nome del nodo e' normalizzato: «MADONNETTA  CAPOLINEA» e
    # «MADONNETTA (CAPOLINEA)» sono lo stesso posto
    assert c[0]["node"] == "MADONNETTA"


def test_uno_spostamento_che_rompe_la_coincidenza_viene_visto():
    trips = _rete_con_coincidenza()
    by_id = {t["tripId"]: t for t in trips}
    pairs = probe.coincidence_pairs(probe.detect_coincidences(trips))

    # ritardo la sola coincidenza in partenza di 10': il passeggero aspetta 13'
    rotte = probe.coincidences_broken({"out0": +10}, by_id, pairs)
    assert len(rotte) == 1 and rotte[0]["attesaMin"] == 13

    # anticiparla la fa partire PRIMA che arrivi chi deve salirci
    rotte = probe.coincidences_broken({"out0": -5}, by_id, pairs)
    assert len(rotte) == 1 and rotte[0]["attesaMin"] == -2


def test_il_giro_spostato_rigidamente_non_rompe_niente():
    """Se le due corse slittano dello stesso delta l'attesa non cambia: e'
    esattamente il caso del giro, e per costruzione e' innocuo."""
    trips = _rete_con_coincidenza()
    by_id = {t["tripId"]: t for t in trips}
    pairs = probe.coincidence_pairs(probe.detect_coincidences(trips))
    assert probe.coincidences_broken({"in0": +20, "out0": +20}, by_id, pairs) == []
    # e uno spostamento che non tocca nessuna delle due non viene nemmeno guardato
    assert probe.coincidences_broken({"z1": +25}, by_id, pairs) == []
