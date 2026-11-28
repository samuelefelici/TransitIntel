"""Fase di ASSORBIMENTO dei turni guida (crew_assorbimento.py).

Il caso vero: i 15 turni macchina di un giro VCSP della domenica di Ancona e i
36 turni guida che il solver ci aveva costruito sopra (28 interi, 5 semiunici,
2 spezzati, 1 supplemento, dieci turni sotto le 4h30). Sulle stesse vetture e
con gli stessi orari la fase deve toglierne almeno quattro, senza violazioni,
senza scoprire né duplicare una corsa e senza sforare le auto aziendali.
Più due casi piccoli: un bus spezzato in tre turni da quattro ore (diventano
due) e un turno solo, che non si può migliorare (resta com'è).
"""
import json
import os
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_assorbimento as ca  # noqa: E402
import crew_scheduler_v4 as v4  # noqa: E402

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "domenica_ancona_15_vetture.json")


def _hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _pezzo(block, da, a, clusters):
    """Il pezzo di un turno del giro: corse da..a del bus, con le metà dei
    tagli intra-corsa dove il solver aveva tagliato dentro una corsa."""
    (i, hi), (j, hj) = da, a
    trips = list(block.trips[i:j + 1])
    if hi == "seconda":
        trips[0] = v4._split_trip_at_stop(trips[0], trips[0].cluster_stops[0])[1]
    if hj == "prima":
        trips[-1] = v4._split_trip_at_stop(trips[-1], trips[-1].cluster_stops[0])[0]
    return v4._make_segment(block.vehicle_id, block.vehicle_type, trips, "middle", None, clusters, block=block)


def _giro():
    fx = json.load(open(FIXTURE))
    vs = fx["vehicleShifts"]
    config, clusters, bds = v4._imposta(fx["config"], vs, 120, silenzioso=True)
    blocks = v4.parse_vehicle_blocks(vs, clusters)
    by_vid = {b.vehicle_id: b for b in blocks}
    rules = config.get("shiftRules", v4.SHIFT_RULES)
    duties, tipi_attesi = [], []
    for t in fx["turniDelGiro"]:
        segs = [_pezzo(by_vid[p["vettura"]], p["da"], p["a"], clusters) for p in t["pezzi"]]
        d = ca.turno_da_segmenti(v4, segs, rules, bds, clusters)
        assert d is not None, t["codice"]
        d.driver_id = t["codice"]
        duties.append(d)
        tipi_attesi.append(t["tipo"])
    return config, clusters, bds, blocks, duties, tipi_attesi


def _corse(duties):
    """Per ogni corsa, i tratti guidati riuniti: una corsa intera, oppure le due
    metà di un taglio intra-corsa, coprono lo stesso intervallo. Un tratto
    guidato due volte resta visibile (due intervalli sovrapposti non si fondono)."""
    per_corsa: dict = {}
    for d in duties:
        for s in d.segments:
            for t in s.trips:
                per_corsa.setdefault(t.trip_id, []).append((t.departure_min, t.arrival_min))
    out = {}
    for tid, iv in per_corsa.items():
        iv.sort()
        fusi = [list(iv[0])]
        for a, b in iv[1:]:
            if a == fusi[-1][1]:
                fusi[-1][1] = b
            else:
                fusi.append([a, b])
        out[tid] = [tuple(x) for x in fusi]
    return out


def test_il_giro_si_ricostruisce_come_lo_aveva_fatto_il_solver():
    _, clusters, bds, _, duties, tipi_attesi = _giro()
    assert len(duties) == 36
    assert [d.duty_type for d in duties] == tipi_attesi
    assert Counter(tipi_attesi) == {"intero": 28, "semiunico": 5, "spezzato": 2, "supplemento": 1}
    assert v4.validate_all_bds(duties, bds, clusters)["totalViolations"] == 0


def test_assorbimento_toglie_turni_sulle_stesse_vetture():
    config, clusters, bds, blocks, duties, _ = _giro()
    prima = _corse(duties)
    nuovi, info = ca.assorbi(duties, blocks, config, clusters, bds,
                             scadenza=time.monotonic() + 600, max_iterazioni=300000)
    assert info["accettata"], info
    assert len(nuovi) <= 32, info
    assert info["scoreDopo"] < info["scorePrima"]
    # stesse corse, ognuna una volta sola (le metà dei tagli intra-corsa comprese)
    assert _corse(nuovi) == prima
    # nessuna violazione, tetti percentuali e auto aziendali rispettati
    val = v4.validate_all_bds(nuovi, bds, clusters)
    assert val["totalViolations"] == 0, val["details"]
    assert all(c["ok"] for c in val["pctCaps"]["byType"].values())
    assert info["autoDopo"] <= v4.MAX_COMPANY_CARS
    assert info["conflittiAutoDopo"] <= info["conflittiAutoPrima"]
    # ogni turno ha al massimo due pezzi, come nel modello CP-SAT
    assert all(1 <= len(d.segments) <= 2 for d in nuovi)
    corti_prima = sum(1 for d in duties if d.work_min < 270)
    corti_dopo = sum(1 for d in nuovi if d.work_min < 270)
    assert corti_dopo < corti_prima


SOLO_INTERI = {"bds": {"vincoliGlobali": [{"tipo": "numerico", "tipologie": ["semiunico", "spezzato", "supplemento"],
                                             "max": 0, "label": "solo turni interi"}]}}


def test_con_il_vincolo_solo_interi_non_crea_turni_di_altri_tipi():
    """Il giro ha 8 turni non interi (5 semiunici, 2 spezzati, 1 supplemento).
    Con il vincolo globale «solo turni interi» l'assorbimento non può
    aggiungerne: la ricerca li paga più di due turni, e l'accettazione
    misura quanti turni sono fuori vincolo, non quanti vincoli."""
    config, clusters, bds, blocks, duties, _ = _giro()
    fuori = lambda ds: sum(1 for d in ds if d.duty_type != "intero")  # noqa: E731
    v4.apply_vincoli_globali_config(SOLO_INTERI)
    try:
        assert ca.sforo_vincoli_globali(v4, duties) == fuori(duties) == 8
        prima = _corse(duties)
        nuovi, info = ca.assorbi(duties, blocks, config, clusters, bds,
                                 scadenza=time.monotonic() + 600, max_iterazioni=150000)
        assert fuori(nuovi) <= 8, Counter(d.duty_type for d in nuovi)
        assert info["sforoVincoliPrima"] == 8
        if info["accettata"]:
            assert info["sforoVincoliDopo"] == fuori(nuovi) <= 8
            assert _corse(nuovi) == prima
            assert v4.validate_all_bds(nuovi, bds, clusters)["totalViolations"] == 0
    finally:
        v4.apply_vincoli_globali_config({})


def test_lo_sforo_dei_vincoli_si_misura_in_turni():
    _, _, _, _, duties, _ = _giro()
    v4.apply_vincoli_globali_config({"bds": {"vincoliGlobali": [
        {"tipo": "numerico", "tipologie": ["semiunico"], "max": 2},           # 5 semiunici: 3 di troppo
        {"tipo": "percentuale", "tipologie": ["spezzato"], "maxPct": 3},      # 2 su 36 = 5,6%: 1 di troppo
        {"tipo": "numerico", "tipologie": ["intero"], "min": 30},             # 28 interi: 2 in meno
    ]}})
    try:
        assert ca.sforo_vincoli_globali(v4, duties) == 3 + 1 + 2
    finally:
        v4.apply_vincoli_globali_config({})
    assert ca.sforo_vincoli_globali(v4, duties) == 0


def _anelli(vid, t0, t1, passo=30, durata=25):
    trips, k, t = [], 0, t0
    while t + durata <= t1:
        trips.append({"type": "trip", "tripId": f"{vid}-{k}", "routeId": "L1", "routeName": "1",
                      "departureTime": _hhmm(t), "arrivalTime": _hhmm(t + durata),
                      "departureMin": t, "arrivalMin": t + durata,
                      "firstStopName": "Piazza Cavour", "lastStopName": "Piazza Cavour"})
        k += 1
        t += passo
    return ([{"type": "deadhead", "depotLeg": "out", "deadheadMin": 10, "departureMin": t0 - 10, "arrivalMin": t0,
              "firstStopName": "Deposito", "lastStopName": "Piazza Cavour"}] + trips
            + [{"type": "deadhead", "depotLeg": "in", "deadheadMin": 10, "departureMin": trips[-1]["arrivalMin"],
                "arrivalMin": trips[-1]["arrivalMin"] + 10, "firstStopName": "Piazza Cavour", "lastStopName": "Deposito"}])


CFG = {"clusters": [{"id": "c_cav", "name": "Piazza Cavour", "keywords": ["CAVOUR"], "transferFromDepotMin": 10}],
       "bds": {"serviceType": "urbano"}}


def _un_bus(fasce):
    vs = [{"vehicleId": "V1", "vehicleType": "12m", "category": "urbano", "trips": _anelli("V1", 420, 1140)}]
    config, clusters, bds = v4._imposta(CFG, vs, 60, silenzioso=True)
    block = v4.parse_vehicle_blocks(vs, clusters)[0]
    rules = config.get("shiftRules", v4.SHIFT_RULES)
    duties = []
    for i, j in fasce:
        seg = v4._make_segment("V1", "12m", block.trips[i:j], "middle", None, clusters, block=block)
        duties.append(ca.turno_da_segmenti(v4, [seg], rules, bds, clusters))
    return config, clusters, bds, [block], duties


def test_tre_turni_da_quattro_ore_diventano_due():
    # 24 anelli di 25′ dalle 07:00 alle 19:00 sullo stesso bus, in tre turni da 8 anelli
    config, clusters, bds, blocks, duties = _un_bus([(0, 8), (8, 16), (16, 24)])
    assert len(duties) == 3 and all(d.duty_type == "intero" for d in duties)
    nuovi, info = ca.assorbi(duties, blocks, config, clusters, bds,
                             scadenza=time.monotonic() + 120, max_iterazioni=3000)
    assert info["accettata"] and len(nuovi) == 2
    assert _corse(nuovi) == _corse(duties)
    assert v4.validate_all_bds(nuovi, bds, clusters)["totalViolations"] == 0


def test_se_non_migliora_resta_la_soluzione_del_solver():
    # Un turno solo da 4 ore: non c'è niente da assorbire
    config, clusters, bds, blocks, duties = _un_bus([(0, 8)])
    blocks[0].trips = blocks[0].trips[:8]
    nuovi, info = ca.assorbi(duties, blocks, config, clusters, bds,
                             scadenza=time.monotonic() + 30, max_iterazioni=500)
    assert not info["accettata"]
    assert nuovi is duties


def test_tempo_della_fase():
    assert ca.secondi_della_fase({"assorbimento": {"attivo": False}}, 240) == 0
    assert ca.secondi_della_fase({}, 240) == 48            # 20% del tempo che resta
    assert ca.secondi_della_fase({}, 1000) == 60           # mai oltre il massimo
    assert ca.secondi_della_fase({}, 10) == 2              # i calcoli brevi: poco tempo
    assert ca.secondi_della_fase({}, 4) == 0               # sotto il secondo non parte
    assert ca.secondi_della_fase({"assorbimento": {"secondi": 30}}, 240) == 30
    assert ca.secondi_della_fase({"assorbimento": {"secondi": 300}}, 240) == 120   # mai più di metà
