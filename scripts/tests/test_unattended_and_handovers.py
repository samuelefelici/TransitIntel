"""Regola aziendale del cambio in linea: la vettura può restare ferma SENZA
conducente al massimo UNATTENDED_BUS_MAX (15′); ogni cambio viene scritto
nei due turni («In [Nodo] lascia/prende la vettura [bus] al/dal turno
[codice]») con la modalità (auto aziendale, a piedi, deposito)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crew_scheduler_v4 as v4  # noqa: E402
from crew_scheduler_v3 import compute_handovers, inline_handovers, handover_view, serialize_handovers  # noqa: E402
from optimizer_common import UNATTENDED_BUS_MAX  # noqa: E402
from test_cover_rule import _trip, CLUSTERS, _block_with_deadhead_and_depot  # noqa: E402


def _block(vid, trips):
    return v4.parse_vehicle_blocks([{"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": trips}], CLUSTERS)[0]


def test_takeover_within_unattended_limit():
    assert UNATTENDED_BUS_MAX == 15
    # sosta 40′ al nodo: il montante prende il bus 15′ dopo l'arrivo e copre i 25′ restanti
    b = _block("U1", [_trip("U1", 0, 420, 450, "Piazza Cavour", "Tavernelle"),
                      _trip("U1", 1, 490, 520, "Tavernelle", "Piazza Cavour")])
    assert v4.takeover_min(450, 490) == 465
    assert v4.piece_start_min(b, 0) == 465
    seg = v4._make_segment("U1", "12m", b.trips[1:], "second", 0, CLUSTERS, block=b)
    assert seg.start_min == 465 and seg.lead_idle_min == 25 and seg.work_min == 520 - 465
    assert seg.first_stop == "Tavernelle"
    # sosta 10′: non c'è da aspettare, il montante prende il bus alla partenza
    b2 = _block("U2", [_trip("U2", 0, 420, 450, "Piazza Cavour", "Tavernelle"),
                       _trip("U2", 1, 460, 490, "Tavernelle", "Piazza Cavour")])
    assert v4.piece_start_min(b2, 0) == 460
    seg2 = v4._make_segment("U2", "12m", b2.trips[1:], "second", 0, CLUSTERS, block=b2)
    assert seg2.start_min == 460 and seg2.lead_idle_min == 0
    # mai prima dell'arrivo dello smontante
    assert v4.takeover_min(450, 440) == 450


def test_cut_analysis_uses_takeover_time():
    b = _block("U3", [_trip("U3", 0, 400, 520, "Piazza Cavour", "Tavernelle"),
                      _trip("U3", 1, 560, 700, "Tavernelle", "Piazza Cavour")])
    v4.analyze_vehicle_block(b, CLUSTERS, v4.BDSConfig())
    cut = next(c for c in b.cut_candidates if c.index == 0)
    # il pezzo di destra parte 15′ dopo l'arrivo (535), non all'arrivo (520)
    assert cut.right_work_min == 700 - 535


def _seg(vid, start, end, fc, lc, fs, ls, sad=False, ead=False):
    class Seg:
        pass
    s = Seg()
    s.vehicle_id, s.start_min, s.end_min = vid, start, end
    s.first_cluster, s.last_cluster, s.first_stop, s.last_stop = fc, lc, fs, ls
    s.starts_at_depot, s.ends_at_depot = sad, ead
    s.trips = []
    return s


class _Duty:
    def __init__(self, did, segs):
        self.driver_id, self.segments = did, segs


def test_handovers_track_mode_and_unattended_time():
    # Bus V1: A guida 06:00-10:00 (smonta a Cavour), B monta a Cavour alle 10:10
    # arrivando con l'auto; B prima era sul bus V2 fino alle 10:05 a Cavour: a piedi.
    a1 = _seg("V1", 360, 600, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", sad=True)
    b0 = _seg("V2", 400, 605, "c_tav", "c_cav", "Tavernelle", "Piazza Cavour", sad=True)
    b1 = _seg("V1", 610, 840, "c_cav", "c_tav", "Piazza Cavour", "Tavernelle", ead=True)
    # Bus V2: C la prende a Cavour alle 10:05 arrivando in auto (B l'ha lasciata alle 10:05)
    c1 = _seg("V2", 605, 900, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", ead=True)
    A, B, C = _Duty("A", [a1]), _Duty("B", [b0, b1]), _Duty("C", [c1])
    hs = compute_handovers([A, B, C], CLUSTERS)
    by = {h.vehicle_id: h for h in hs}
    h1 = by["V1"]
    assert h1.outgoing_driver == "A" and h1.incoming_driver == "B"
    assert h1.unattended_min == 10 and h1.kind == "inline"
    assert h1.incoming_mode == "walk" and h1.incoming_prev_vehicle == "V2"
    assert h1.outgoing_mode == "car"
    h2 = by["V2"]
    assert h2.outgoing_driver == "B" and h2.incoming_driver == "C"
    assert h2.unattended_min == 0 and h2.outgoing_mode == "walk" and h2.outgoing_next_vehicle == "V1"
    assert h2.incoming_mode == "car"
    names = {c.id: c.name for c in CLUSTERS}
    va = handover_view(h1, "A", names)
    assert va["role"] == "outgoing" and va["description"] == "In PIAZZA CAVOUR lascia la vettura V1 al turno B"
    assert "10′" in va["detail"] and "auto aziendale" in va["detail"]
    assert va["takenMin"] == 610 and va["unattendedMin"] == 10 and va["label"].startswith("10:00 · In PIAZZA CAVOUR lascia")
    vb = handover_view(h1, "B", names)
    assert vb["role"] == "incoming" and vb["description"] == "In PIAZZA CAVOUR prende la vettura V1 dal turno A"
    assert vb["mode"] == "walk" and "a piedi dalla vettura V2" in vb["detail"] and vb["label"].startswith("10:10 ·")
    assert len(inline_handovers(hs)) == 2
    ser = serialize_handovers(hs, CLUSTERS)
    assert all("kind" in x and "unattendedMin" in x for x in ser)


def test_depot_change_is_tracked_but_not_a_line_change():
    # Bus V: A la riporta in deposito alle 10:00, B la riprende in deposito alle 14:00
    a1 = _seg("V", 360, 600, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", sad=True, ead=True)
    b1 = _seg("V", 840, 1080, "c_cav", "c_cav", "Piazza Cavour", "Piazza Cavour", sad=True, ead=True)
    hs = compute_handovers([_Duty("A", [a1]), _Duty("B", [b1])], CLUSTERS)
    assert len(hs) == 1 and hs[0].kind == "depot" and hs[0].unattended_min == 0
    assert inline_handovers(hs) == []
    names = {c.id: c.name for c in CLUSTERS}
    va = handover_view(hs[0], "A", names)
    assert va["description"] == "In deposito lascia la vettura V al turno B" and "14:00" in va["detail"]
    vb = handover_view(hs[0], "B", names)
    assert vb["description"] == "In deposito prende la vettura V dal turno A" and vb["kind"] == "depot"


def test_run_writes_every_change_in_both_duties():
    cfg = {"bds": {"shiftRules": {"intero": {"maxNastro": 435}}}, "companyCars": 5,
           "clusters": [{"id": c.id, "name": c.name, "keywords": c.keywords, "stopNames": c.stop_names,
                         "transferFromDepotMin": c.transfer_from_depot_min} for c in CLUSTERS]}
    shifts = []
    for i in range(3):
        s = _block_with_deadhead_and_depot()
        s["vehicleId"] = f"U{i + 1}"
        for t in s["trips"]:
            if t.get("type") == "trip":
                t["tripId"] = f"U{i + 1}{t['tripId'][2:]}"
        shifts.append(s)
    out = v4.run({"vehicleShifts": shifts, "config": cfg}, time_limit_sec=10)
    hs = out["handovers"]
    duties = {d["driverId"]: d for d in out["driverShifts"]}
    for h in hs:
        assert h["kind"] in ("inline", "depot")
        assert 0 <= h["unattendedMin"] <= UNATTENDED_BUS_MAX
        # scritto in ENTRAMBI i turni, nel formato del foglio turno
        out_v = [x for x in duties[h["outgoingDriver"]]["handovers"] if x["vehicleId"] == h["vehicleId"] and x["role"] == "outgoing"]
        in_v = [x for x in duties[h["incomingDriver"]]["handovers"] if x["vehicleId"] == h["vehicleId"] and x["role"] == "incoming"]
        assert out_v and in_v
        assert out_v[0]["description"].startswith("In ") and " lascia la vettura " in out_v[0]["description"]
        assert in_v[0]["description"].startswith("In ") and " prende la vettura " in in_v[0]["description"]
        assert out_v[0]["otherDriver"] == h["incomingDriver"] and in_v[0]["otherDriver"] == h["outgoingDriver"]
    s = out["summary"]
    assert s["totalCambi"] == len([h for h in hs if h["kind"] == "inline"])
    assert s["handoverModes"]["unattendedLimitMin"] == UNATTENDED_BUS_MAX
    assert s["handoverModes"]["unattendedMaxMin"] <= UNATTENDED_BUS_MAX
    for d in out["driverShifts"]:
        n_inline = sum(1 for x in d["handovers"] if x["kind"] == "inline")
        assert d["cambiCount"] >= n_inline
        for lbl in d["vehicleHandoverLabels"]:
            assert " · In " in lbl
