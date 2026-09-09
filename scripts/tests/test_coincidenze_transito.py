"""La coincidenza non si fa solo al capolinea: si fa anche in transito.

Regola dell'operatore, verificata sul quadro festivo di Ancona: alla Madonnetta
la 2/6 ha il capolinea e la 21/33 ci passa e basta, tre minuti dopo essere
partita da Posatora. Le quattro corse della 21/33 transitano cinque minuti
esatti dopo l'arrivo della 2/6: e' una coincidenza costruita a mano. Guardando
solo la prima e l'ultima fermata di ogni corsa era invisibile, e la sonda
poteva romperla senza accorgersene.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vcsp_probe as probe  # noqa: E402


def _t(tid, route, dep, arr, first, last, transiti=None, flex=30, direction=0):
    t = {"tripId": tid, "routeId": route, "directionId": direction,
         "departureMin": dep, "arrivalMin": arr,
         "firstStopId": first, "lastStopId": last,
         "firstStopName": first, "lastStopName": last,
         "routeName": route, "flexMin": flex}
    if transiti:
        t["terminalTransits"] = [
            {"stopName": n, "arrivalMin": a, "departureMin": d} for n, a, d in transiti]
    return t


def _madonnetta(con_transiti=True):
    """La 2/6 arriva alla Madonnetta (suo capolinea); la 21/33 parte da Posatora
    e ci TRANSITA tre minuti dopo, cinque minuti dopo l'arrivo della 2/6."""
    trips = []
    for k, ora in enumerate((480, 750, 1020, 1170)):
        trips.append(_t("c26_%d" % k, "2/6", ora - 25, ora, "CAVOUR", "MADONNETTA  CAPOLINEA"))
        transiti = [("MADONNETTA (CAPOLINEA)", ora + 5, ora + 5)] if con_transiti else None
        trips.append(_t("c2133_%d" % k, "21/33", ora + 2, ora + 32,
                        "POSATORA CAPOLINEA", "MONTESICURO", transiti))
    return trips


def test_la_coincidenza_in_transito_si_vede():
    c = probe.detect_coincidences(_madonnetta())
    assert len(c) == 1, "una sola relazione sistematica"
    assert c[0]["node"] == "MADONNETTA"
    assert (c[0]["fromRoute"], c[0]["toRoute"]) == ("2/6", "21/33")
    assert c[0]["occurrences"] == 4


def test_senza_i_passaggi_la_stessa_coincidenza_e_invisibile():
    """La prova del difetto: gli stessi orari, ma guardando solo i capolinea."""
    assert probe.detect_coincidences(_madonnetta(con_transiti=False)) == []


def test_due_transiti_non_fanno_un_nodo():
    """Due linee che percorrono lo stesso corridoio si sfiorano di continuo:
    se nessuna delle due si ferma li', non e' una coincidenza."""
    trips = []
    for k, ora in enumerate((480, 540, 600, 660)):
        trips.append(_t("p_%d" % k, "L1", ora, ora + 40, "A", "B",
                        [("PIAZZA X", ora + 10, ora + 10)]))
        trips.append(_t("q_%d" % k, "L2", ora + 5, ora + 45, "C", "D",
                        [("PIAZZA X", ora + 12, ora + 12)]))
    assert probe.detect_coincidences(trips) == []


def test_lo_spostamento_si_misura_sull_orario_del_transito():
    """La 21/33 slitta di 10': al capolinea di Posatora non cambia niente, ma
    alla Madonnetta il passeggero della 2/6 aspetta 15 minuti invece di 5."""
    trips = _madonnetta()
    by_id = {t["tripId"]: t for t in trips}
    pairs = probe.coincidence_pairs(probe.detect_coincidences(trips))
    assert len(pairs) == 4

    rotte = probe.coincidences_broken({"c2133_0": +10}, by_id, pairs)
    assert len(rotte) == 1 and rotte[0]["attesaMin"] == 15
    assert rotte[0]["fromRoute"] == "2/6" and rotte[0]["toRoute"] == "21/33"

    # anticiparla la fa passare PRIMA che arrivi chi deve salirci
    rotte = probe.coincidences_broken({"c2133_0": -10}, by_id, pairs)
    assert len(rotte) == 1 and rotte[0]["attesaMin"] == -5

    # dentro i cinque minuti la coincidenza regge
    assert probe.coincidences_broken({"c2133_0": -3}, by_id, pairs) == []


def test_spostare_tutte_e_due_non_rompe_niente():
    trips = _madonnetta()
    by_id = {t["tripId"]: t for t in trips}
    pairs = probe.coincidence_pairs(probe.detect_coincidences(trips))
    assert probe.coincidences_broken({"c26_0": +20, "c2133_0": +20}, by_id, pairs) == []


def test_la_corsa_si_porta_dietro_i_suoi_passaggi():
    """Chi transitava alle 08:05 transita alle 08:20 se la corsa slitta di 15'."""
    trips = _madonnetta()
    dopo = probe._apply_shifts(trips, {"c2133_0": +15})
    d = {t["tripId"]: t for t in dopo}
    assert d["c2133_0"]["terminalTransits"][0]["arrivalMin"] == 500
    assert d["c2133_0"]["terminalTransits"][0]["departureMin"] == 500
    # l'input resta intatto e le altre corse non si toccano
    assert trips[1]["terminalTransits"][0]["arrivalMin"] == 485
    assert d["c26_0"]["arrivalMin"] == 480


def test_il_capolinea_contro_capolinea_continua_a_valere():
    """I transiti si aggiungono, non sostituiscono: a Posatora entrambe le
    linee hanno il capolinea e la coincidenza si vede come prima."""
    trips = []
    for k, ora in enumerate((480, 540, 600, 660)):
        trips.append(_t("l3_%d" % k, "3", ora - 22, ora, "CAVOUR", "POSATORA CAPOLINEA"))
        trips.append(_t("l21_%d" % k, "21/33", ora + 4, ora + 34, "POSATORA", "MONTESICURO"))
    c = probe.detect_coincidences(trips)
    assert len(c) == 1 and c[0]["node"] == "POSATORA" and c[0]["occurrences"] == 4


# ─────────────────────────────────────────────────────────────────────────────
#  Propagazione: spostare il mattone accanto invece di rinunciare
# ─────────────────────────────────────────────────────────────────────────────

def _rete_con_giri(flex_26=30):
    """Due giri completi che si incontrano alla Madonnetta.
    2/6: Cavour→Madonnetta (arriva alle 8:00) e ritorno Madonnetta→Cavour.
    21/33: Posatora→Montesicuro (transita alla Madonnetta alle 8:05) e ritorno.
    """
    trips = []
    for k, ora in enumerate((480, 750, 1020, 1170)):
        trips.append(_t("a26_%d" % k, "2/6", ora - 25, ora,
                        "CAVOUR", "MADONNETTA  CAPOLINEA", flex=flex_26))
        trips.append(_t("r26_%d" % k, "2/6", ora + 4, ora + 29,
                        "MADONNETTA  CAPOLINEA", "CAVOUR", flex=flex_26, direction=1))
        trips.append(_t("a21_%d" % k, "21/33", ora + 2, ora + 32, "POSATORA", "MONTESICURO",
                        [("MADONNETTA (CAPOLINEA)", ora + 5, ora + 5)]))
        trips.append(_t("r21_%d" % k, "21/33", ora + 36, ora + 66, "MONTESICURO", "POSATORA",
                        direction=1))
    return trips


def _ctx(trips):
    by_id = {t["tripId"]: t for t in trips}
    return (by_id, probe.build_round_trip_pairs(trips),
            probe.coincidence_pairs(probe.detect_coincidences(trips)))


def test_la_coincidenza_si_porta_dietro_invece_di_scartare():
    """La 21/33 slitta di 10': invece di rinunciare, slitta di 10 anche la 2/6
    che le porta i passeggeri — e ognuna si porta dietro il suo ritorno."""
    trips = _rete_con_giri()
    by_id, rt, coinc = _ctx(trips)
    partenza = {"a21_0": +10, "r21_0": +10}
    assert probe.coincidences_broken(partenza, by_id, coinc)   # da sola romperebbe

    out = probe.propagate_for_coincidences(partenza, by_id, rt, coinc)
    assert out is not None
    assert out["a26_0"] == 10, "la corsa in coincidenza slitta dello stesso delta"
    assert out["r26_0"] == 10, "e si porta dietro il suo ritorno"
    assert probe.coincidences_broken(out, by_id, coinc) == [], "niente e' rotto"


def test_se_la_corsa_da_trascinare_non_regge_si_scarta():
    """Le regole non si comprano: se la 2/6 e' inchiodata, lo spostamento cade."""
    trips = _rete_con_giri(flex_26=0)
    by_id, rt, coinc = _ctx(trips)
    assert probe.propagate_for_coincidences({"a21_0": +10, "r21_0": +10},
                                            by_id, rt, coinc) is None


def test_la_catena_ha_un_tetto():
    """Oltre il tetto non si sposta un mattone, si riscrive il quadro."""
    trips = _rete_con_giri()
    by_id, rt, coinc = _ctx(trips)
    assert probe.propagate_for_coincidences({"a21_0": +10, "r21_0": +10},
                                            by_id, rt, coinc, max_trips=3) is None


def test_uno_spostamento_che_non_rompe_niente_resta_com_e():
    trips = _rete_con_giri()
    by_id, rt, coinc = _ctx(trips)
    dentro = {"a21_0": -3, "r21_0": -3}
    assert probe.propagate_for_coincidences(dentro, by_id, rt, coinc) == dentro


def test_gli_orari_delle_coppie_seguono_le_corse():
    trips = _rete_con_giri()
    _, _, coinc = _ctx(trips)
    dopo = probe.shift_coincidence_pairs(coinc, {"a21_0": +10, "a26_0": +10})
    prima = {(a, b): (arr, dep) for a, b, arr, dep in coinc}
    for a, b, arr, dep in dopo:
        p_arr, p_dep = prima[(a, b)]
        assert arr == p_arr + (10 if a == "a26_0" else 0)
        assert dep == p_dep + (10 if b == "a21_0" else 0)
