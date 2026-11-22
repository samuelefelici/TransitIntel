"""Profilo «misto» dei turni guida (tappa 7.9): ogni turno segue le regole
della sua categoria. I turni macchina non mescolano urbano ed extraurbano:
il calcolo li risolve in due parti, ognuna con le sue regole, e poi dà i
codici, verifica e calcola cambi e auto aziendali su tutti insieme."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_scheduler_v4 as v4  # noqa: E402
from optimizer_common import Cluster  # noqa: E402


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _shift(vid, t0, end, categoria, dur=25, headway=30, pullout=12, pullin=14):
    trips, d, k = [], 0, 0
    t = t0
    while t + dur <= end:
        a, b = ("Piazza Uno", "Borgo Due") if d == 0 else ("Borgo Due", "Piazza Uno")
        trips.append({"type": "trip", "tripId": f"{vid}t{k}", "routeId": "L1", "routeName": "1",
                      "departureTime": hhmm(t), "arrivalTime": hhmm(t + dur), "departureMin": t, "arrivalMin": t + dur,
                      "firstStopName": a, "lastStopName": b, "stopCount": 10, "durationMin": dur, "directionId": d})
        t += headway
        d ^= 1
        k += 1
    legs = ([{"type": "deadhead", "depotLeg": "out", "deadheadMin": pullout, "deadheadKm": 4.0,
              "departureMin": t0 - pullout, "arrivalMin": t0, "firstStopName": "Deposito", "lastStopName": "Piazza Uno"}]
            + trips
            + [{"type": "deadhead", "depotLeg": "in", "deadheadMin": pullin, "deadheadKm": 4.5,
                "departureMin": trips[-1]["arrivalMin"], "arrivalMin": trips[-1]["arrivalMin"] + pullin,
                "firstStopName": trips[-1]["lastStopName"], "lastStopName": "Deposito"}])
    return {"vehicleId": vid, "vehicleType": "12m", "category": categoria, "trips": legs}


CLUSTERS = [Cluster(id="c_uno", name="PIAZZA UNO", keywords=["UNO"], transfer_from_depot_min=10, stop_names=["Piazza Uno"]),
            Cluster(id="c_due", name="BORGO DUE", keywords=["DUE"], transfer_from_depot_min=15, stop_names=["Borgo Due"])]
CLUSTERS_CFG = [{"id": c.id, "name": c.name, "keywords": c.keywords, "stopNames": c.stop_names,
                 "transferFromDepotMin": c.transfer_from_depot_min} for c in CLUSTERS]


def test_categoria_e_regole_della_categoria():
    assert v4._categoria_turno_macchina({"category": "extraurbano"}) == "extraurbano"
    assert v4._categoria_turno_macchina({"category": "urbano"}) == "urbano"
    assert v4._categoria_turno_macchina({}) == "urbano"
    cfg = {"bds": {"serviceType": "misto", "shiftRules": {"intero": {"maxNastro": 999}},
                   "regolePerCategoria": {"extraurbano": {"shiftRules": {"intero": {"maxNastro": 470}}, "targetWork": {"mid": 395}}}},
           "solverIntensity": 1}
    u = v4._config_della_categoria(cfg, "urbano")
    e = v4._config_della_categoria(cfg, "extraurbano")
    # il profilo della categoria, non le regole «miste» della config
    assert u["bds"]["serviceType"] == "urbano" and u["bds"]["shiftRules"]["intero"]["maxNastro"] == 435
    assert u["bds"]["shiftRules"]["semiunico"]["intMin"] == 75 and u["bds"]["targetWork"]["mid"] == 412
    # i valori propri della categoria sopra il profilo di partenza
    assert e["bds"]["serviceType"] == "extraurbano" and e["bds"]["shiftRules"]["intero"]["maxNastro"] == 470
    assert e["bds"]["shiftRules"]["intero"]["maxLavoro"] == 480 and e["bds"]["shiftRules"]["spezzato"]["maxPct"] == 9
    assert e["bds"]["targetWork"] == {"low": 372, "high": 402, "mid": 395}
    # la config dell'utente non cambia
    assert cfg["bds"]["serviceType"] == "misto" and cfg["bds"]["shiftRules"] == {"intero": {"maxNastro": 999}}


def test_le_regole_ripartono_dai_valori_di_partenza():
    partenza = v4._REGOLE_DI_PARTENZA["intero"]["maxNastro"]
    v4._imposta({"bds": {"serviceType": "extraurbano", "shiftRules": {"intero": {"maxNastro": 480, "maxLavoro": 480}}}}, [], 1, silenzioso=True)
    assert v4.SHIFT_RULES["intero"]["maxNastro"] == 480 and v4.NASTRO_INTERO_MAX == 480
    # un calcolo dopo, senza regole sue, non si porta dietro quelle di prima
    v4._imposta({"bds": {"serviceType": "urbano"}}, [], 1, silenzioso=True)
    assert v4.SHIFT_RULES["intero"]["maxNastro"] == partenza and v4.NASTRO_INTERO_MAX == partenza


def test_validazioni_unite():
    a = {"totalViolations": 2, "dutiesWithViolations": 1, "details": {"A001": ["x", "y"]}, "globalViolations": [],
         "pctCaps": {"hard": True, "relaxed": False, "byType": {"semiunico": {"maxPct": 12, "ok": True}}},
         "totalWarnings": 1, "warningDetails": {"A001": ["w"]}, "bdsResults": {"A001": {}}}
    b = {"totalViolations": 1, "dutiesWithViolations": 0, "details": {}, "globalViolations": ["spezzato: oltre il tetto"],
         "pctCaps": {"hard": True, "relaxed": True, "byType": {"semiunico": {"maxPct": 39, "ok": True}}},
         "totalWarnings": 0, "warningDetails": {}, "bdsResults": {"A002": {}}}
    v = v4._unisci_validazioni([("urbano", a), ("extraurbano", b)])
    assert v["totalViolations"] == 3 and v["dutiesWithViolations"] == 1 and v["totalWarnings"] == 1
    assert v["globalViolations"] == ["extraurbano — spezzato: oltre il tetto"]
    assert set(v["pctCaps"]["byType"]) == {"semiunico (urbano)", "semiunico (extraurbano)"}
    assert v["pctCaps"]["relaxed"] is True
    assert set(v["bdsResults"]) == {"A001", "A002"}
    assert v["perCategoria"] == {"urbano": {"totalViolations": 2, "dutiesWithViolations": 1},
                                 "extraurbano": {"totalViolations": 1, "dutiesWithViolations": 0}}


def test_run_misto_regole_per_turno():
    shifts = ([_shift(f"U{v + 1:02d}", 7 * 60 + v * 10, 20 * 60 + v * 15, "urbano") for v in range(3)]
              + [_shift(f"E{v + 1:02d}", 6 * 60 + v * 20, 19 * 60 + v * 10, "extraurbano", dur=40, headway=50) for v in range(2)])
    cfg = {"bds": {"serviceType": "misto", "optimizer": {"maxCompanyCars": 5}}, "solverIntensity": 1, "clusters": CLUSTERS_CFG}
    out = v4.run({"vehicleShifts": shifts, "config": cfg}, time_limit_sec=20)
    turni = out["driverShifts"]
    assert turni, "nessun turno"
    # ogni turno dice con che regole è stato fatto, e prende solo vetture della sua categoria
    categoria_della_vettura = {s["vehicleId"]: s["category"] for s in shifts}
    for t in turni:
        assert t["regole"] in ("urbano", "extraurbano")
        vetture = {v for r in t.get("riprese") or [] for v in (r.get("vehicleIds") or [])}
        assert vetture and all(categoria_della_vettura[v] == t["regole"] for v in vetture), (t["driverId"], vetture)
    # una sola numerazione: nessun codice doppio
    codici = [t["driverId"] for t in turni]
    assert len(codici) == len(set(codici))
    m = out["misto"]
    assert m["regolePerTurno"] is True
    assert m["perCategoria"]["urbano"]["turniMacchina"] == 3 and m["perCategoria"]["extraurbano"]["turniMacchina"] == 2
    assert m["perCategoria"]["urbano"]["turni"] + m["perCategoria"]["extraurbano"]["turni"] == len(turni)
    assert m["perCategoria"]["urbano"]["regole"]["intero"]["maxNastro"] == 435
    assert m["perCategoria"]["extraurbano"]["regole"]["intero"]["maxNastro"] == 480
    # la verifica: ogni turno con le regole della sua categoria, i conteggi per categoria
    val = out["summary"]["validation"]
    assert set(val["perCategoria"]) == {"urbano", "extraurbano"}
    assert set(val["bdsResults"]) == set(codici)
    # le auto aziendali si contano su tutto, col tetto dell'azienda
    assert out["summary"]["companyCarsCap"] == 5
    assert out["summary"]["totalShifts"] == len(turni)


def test_run_misto_con_una_sola_categoria():
    shifts = [_shift(f"U{v + 1:02d}", 7 * 60 + v * 10, 15 * 60, "urbano") for v in range(2)]
    cfg = {"bds": {"serviceType": "misto"}, "solverIntensity": 1, "clusters": CLUSTERS_CFG}
    out = v4.run({"vehicleShifts": shifts, "config": cfg}, time_limit_sec=10)
    assert out["driverShifts"] and all(t["regole"] == "urbano" for t in out["driverShifts"])
    assert list(out["misto"]["perCategoria"]) == ["urbano"]
