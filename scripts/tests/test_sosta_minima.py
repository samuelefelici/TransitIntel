"""La sosta minima al capolinea e il ritardo vero delle corse nel giro.

Il caso vero: la 22/24 arriva a Brecce Bianche alle 08:10 e riparte alle
08:10. Allo stesso capolinea il giro accettava 0′ di sosta (i 3′ fissi del
codice valevano solo fra fermate diverse): con una sosta minima dichiarata
quel concatenamento non c'è più. E il margine contro i ritardi viene dal
ritardo all'85° SIRI della corsa, non dalla congestione media della città.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vehicle_scheduler_cpsat as vsp  # noqa: E402
from optimizer_common import set_deadhead_matrix, set_deadhead_min_matrix, dh_key  # noqa: E402
from test_cover_rule_2 import _vtrip  # noqa: E402

C, P, Q = (43.60, 13.50), (43.66, 13.56), (43.6640, 13.5640)   # Q a ~550 m da P: un altro capolinea


def _t(idx, dep, arr, a, b, pa, pb):
    t = _vtrip(idx, dep, arr, a, b, *pa, *pb)
    t.duration_min = arr - dep
    return t


def _giro():
    set_deadhead_matrix({})
    set_deadhead_min_matrix({})
    andata = _t(0, 470, 490, "C", "P", C, P)              # arriva a P alle 08:10
    subito = _t(1, 490, 510, "P", "C", P, C)              # riparte da P alle 08:10
    dopo4 = _t(2, 494, 514, "P", "C", P, C)               # alle 08:14
    dopo8 = _t(3, 498, 518, "P", "C", P, C)               # alle 08:18
    return [andata, subito, dopo4, dopo8]


def _archi(trips, **kw):
    return {(a.i, a.j) for a in vsp.build_compatible_arcs_fast(trips, vsp.VehicleCostRates(), None, **kw)}


def test_senza_dati_il_giro_resta_come_prima():
    archi = _archi(_giro())
    assert {(0, 1), (0, 2), (0, 3)} <= archi          # 0′ allo stesso capolinea: si concatena


def test_la_sosta_della_fermata_toglie_i_concatenamenti_troppo_stretti():
    archi = _archi(_giro(), min_layover_by_stop={"P": 5})
    assert (0, 1) not in archi and (0, 2) not in archi
    assert (0, 3) in archi
    assert vsp._LAST_LAYOVER_DROPPED == 2


def test_il_valore_del_progetto_vale_dove_la_fermata_non_ha_dato():
    archi = _archi(_giro(), min_layover_by_stop={"C": 0}, min_layover_default=4)
    assert (0, 1) not in archi and (0, 2) in archi
    # la fermata col suo dato (0′) vince sul progetto
    assert _archi(_giro(), min_layover_by_stop={"P": 0}, min_layover_default=10) >= {(0, 1)}


def test_fra_fermate_diverse_non_meno_di_min_layover():
    set_deadhead_matrix({f"{dh_key(*P)}|{dh_key(*Q)}": 0.6})
    set_deadhead_min_matrix({f"{dh_key(*P)}|{dh_key(*Q)}": 1})     # 1′ a vuoto da P a Q
    try:
        trips = [_t(0, 470, 490, "C", "P", C, P), _t(1, 494, 514, "Q", "C", Q, C)]
        # 4′ dopo: con 1′ di vuoto e MIN_LAYOVER 3′ ci sta; con 1′ dichiarato resta MIN_LAYOVER
        assert (0, 1) in _archi(trips)
        assert (0, 1) in _archi(trips, min_layover_by_stop={"P": 1})
        # con 5′ dichiarati a P non ci sta più
        assert (0, 1) not in _archi(trips, min_layover_by_stop={"P": 5})
    finally:
        set_deadhead_matrix({})
        set_deadhead_min_matrix({})


def test_parse_sosta_minima():
    assert vsp.parse_sosta_minima(None) == ({}, None)
    assert vsp.parse_sosta_minima({"perFermata": {"P": 5, "X": 61, "Y": -1, "Z": 2.5, "B": True}, "predefinitaMin": 3}) == ({"P": 5}, 3)
    assert vsp.parse_sosta_minima({"perFermata": {}, "predefinitaMin": "3"}) == ({}, None)


def test_il_ritardo_siri_della_corsa_vince_sul_profilo_orario():
    trips = _giro()
    cfg = {"level": "media", "delayByHour": {"8": 6}, "delayByTrip": {"t0": 4, "t1": 0, "t2": 40, "t3": True}}
    buffers, livello, fattore, da_siri, reale = vsp.buffer_ritardi(trips, cfg)
    assert (livello, fattore, reale) == ("media", 1.0, True)
    assert da_siri == 3                      # t3 ha un valore non valido: profilo orario
    assert buffers[0] == 4                   # dal SIRI
    assert 1 not in buffers                  # ritardo zero: nessun margine in più
    assert buffers[2] == 15                  # tetto
    assert buffers[3] == 2                   # profilo: 6 min/h × 20′ di corsa
    assert vsp.buffer_ritardi(trips, {"level": "off", "delayByTrip": {"t0": 9}})[0] == {}
    alta = vsp.buffer_ritardi(trips, {"level": "alta", "delayByTrip": {"t0": 4}})[0]
    assert alta[0] == 7                      # 1.8 × 4


def test_il_margine_siri_entra_nei_concatenamenti():
    trips = _giro()
    buffers = vsp.buffer_ritardi(trips, {"level": "media", "delayByTrip": {"t0": 6}})[0]
    archi = _archi(trips, delay_buffers=buffers, min_layover_by_stop={"P": 2})
    assert (0, 3) in archi and (0, 2) not in archi     # 08:10 + 2′ + 6′ = 08:18
