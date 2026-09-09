"""La mappa delle coincidenze: quelle che ci sono, quelle perse per poco e
quanto costa prenderle.

Il conto che serve al pianificatore prima di toccare il quadro: se sposto una
linea intera di δ minuti, quante coincidenze guadagno e quante ne perdo altrove.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import coincidence_analysis as ca  # noqa: E402


def _t(tid, route, dire, dep, arr, first, last, flex=30, transiti=None):
    t = {"tripId": tid, "routeId": route, "routeName": route, "directionId": dire,
         "departureMin": dep, "arrivalMin": arr,
         "firstStopName": first, "lastStopName": last, "flexMin": flex}
    if transiti:
        t["terminalTransits"] = [{"stopName": n, "arrivalMin": m, "departureMin": m}
                                 for n, m in transiti]
    return t


def _sfiorata(attesa=20, n=4, flex=30):
    """Due linee al capolinea di Posatora: la 3 arriva, la 21/33 riparte
    `attesa` minuti dopo — sistematicamente, ma fuori soglia."""
    trips = []
    for k in range(n):
        ora = 480 + k * 120
        trips.append(_t(f"a3_{k}", "3", 0, ora - 22, ora, "CAVOUR", "POSATORA CAPOLINEA"))
        trips.append(_t(f"a21_{k}", "21/33", 0, ora + attesa, ora + attesa + 30,
                        "POSATORA CAPOLINEA", "MONTESICURO", flex=flex))
    return trips


def test_la_coincidenza_persa_per_poco_si_vede_con_le_sue_attese():
    m = ca.near_misses(_sfiorata())
    assert len(m) == 1
    c = m[0]
    assert (c["node"], c["fromRoute"], c["toRoute"]) == ("POSATORA", "3", "21/33")
    assert c["occurrences"] == 4 and c["attesaMin"]["mediana"] == 20
    assert c["giaInCoincidenza"] == 0
    assert c["sample"][0]["attesaMin"] == 20


def test_la_traslazione_che_la_prende_si_trova_col_suo_costo():
    o = ca.line_shift_opportunities(_sfiorata())
    per_linea = {x["route"]: x for x in o}
    # anticipare la 21/33 di 15-20 minuti porta l'attesa dentro i 5
    best = per_linea["21/33"]["migliore"]
    assert best["deltaMin"] in range(-20, -14)
    assert best["create"] == 1 and best["rotte"] == 0
    assert best["relazioniCreate"][0]["node"] == "POSATORA"
    assert best["dentroLaFlessibilita"] is True


def test_una_traslazione_oltre_la_flessibilita_si_vede_ma_si_dichiara():
    """Una mossa che le corse non possono fare e' un'informazione, non un piano."""
    o = ca.line_shift_opportunities(_sfiorata(flex=5))
    best = {x["route"]: x for x in o}["21/33"]["migliore"]
    assert best["dentroLaFlessibilita"] is False
    assert best["flexDichiarataMin"] == 5


def test_le_coppie_che_si_rimpiazzano_non_contano_come_perdita():
    """Se chi porta i passeggeri passa ogni mezz'ora, spostare di venti minuti
    rompe quattro coppie e ne crea altre quattro: la relazione resta viva."""
    trips = []
    for k in range(4):                       # la 2/6 arriva ogni 30'
        for j in range(6):
            ora = 480 + k * 180 + j * 30
            trips.append(_t(f"a26_{k}_{j}", "2/6", 0, ora - 25, ora, "CAVOUR", "MADONNETTA"))
        ora = 480 + k * 180
        trips.append(_t(f"a21_{k}", "21/33", 0, ora + 5, ora + 35, "MADONNETTA", "MONTESICURO"))
    esistenti = ca.analyze({"trips": trips})["esistenti"]
    assert any(c["fromRoute"] == "2/6" and c["occurrences"] == 4 for c in esistenti)

    pairs = ca.candidate_pairs(trips, window=35, lower=-30)
    s = ca._score_shift(pairs, "21/33", -30, 0, 5, 3)
    assert s["rotte"] == 0, "la relazione non si rompe: la prende il mezzo prima"
    assert s["netto"] == 0


def test_l_attesa_minima_esclude_i_cambi_che_nessuno_fa():
    """A zero minuti i due mezzi sono contemporanei: il passeggero non scende
    e risale. Con una soglia minima quella traslazione non e' un'occasione."""
    pairs = ca.candidate_pairs(_sfiorata(attesa=20), window=35, lower=-30)
    # -20 porta l'attesa a zero: i due mezzi si incrociano al minuto
    assert ca._score_shift(pairs, "21/33", -20, 0, 5, 3)["create"] == 1
    assert ca._score_shift(pairs, "21/33", -20, 3, 5, 3)["create"] == 0
    # -16 lascia i quattro minuti che servono a scendere e salire
    assert ca._score_shift(pairs, "21/33", -16, 3, 5, 3)["create"] == 1


def test_l_analisi_dichiara_se_i_passaggi_mancano():
    """Senza i passaggi intermedi si vedono solo le coincidenze da fermo, e chi
    legge deve saperlo."""
    senza = ca.analyze({"trips": _sfiorata()})
    assert senza["corseConPassaggi"] == 0 and "ATTENZIONE" in senza["nota"]

    trips = _sfiorata()
    trips[1]["terminalTransits"] = [{"stopName": "MADONNETTA", "arrivalMin": 500,
                                     "departureMin": 500}]
    con = ca.analyze({"trips": trips})
    assert con["corseConPassaggi"] == 1 and "ATTENZIONE" not in con["nota"]
