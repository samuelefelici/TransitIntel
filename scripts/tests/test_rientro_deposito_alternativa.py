"""Il rientro in deposito come ALTERNATIVA, non come ripiego.

Fino al giro AI il motore mandava il bus in deposito fra due corse solo se
costretto: riposizionamento diretto vietato dall'archivio fuorilinea, oppure
sosta oltre max_idle_at_terminal, che vale 240 minuti. Non c'era un terzo ramo,
quindi un bus poteva restare fermo a un capolinea per quattro ore senza che
l'alternativa entrasse nel modello — e in quelle ore serve un conducente che lo
presidi o un'autovettura che porti il cambio.

Qui la mossa entra fra le alternative sopra depot_alternative_min_gap e vince
solo se costa meno dell'attesa, prezzata per quello che vale davvero.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vehicle_scheduler_cpsat as vsp  # noqa: E402
from optimizer_common import (VehicleCostRates, set_deadhead_matrix,  # noqa: E402
                              set_deadhead_min_matrix, dh_key)
from test_cover_rule_2 import _vtrip  # noqa: E402


def test_attesa_al_capolinea_paga_il_conducente_oltre_il_limite():
    """I minuti oltre il limite di vettura incustodita sono tempo pagato: la
    vettura non puo' restare sola, quindi o il conducente resta col mezzo o
    un'autovettura porta il cambio."""
    r = VehicleCostRates()
    assert r.terminal_wait_free_min == 15
    # la sosta utile parte dopo il layover minimo di manovra
    idle = lambda gap: gap - vsp.MIN_LAYOVER
    # sosta di 18' -> 15' utili: nessun minuto presidiato, solo il mezzo fermo
    diciotto = vsp.terminal_wait_cost(18, 0, r)
    assert abs(diciotto - idle(18) * r.idle_per_min) < 1e-9
    # 78' -> 75' utili, di cui 60 presidiati oltre il limite, a tariffa conducente
    settantotto = vsp.terminal_wait_cost(78, 0, r)
    i = idle(78)
    atteso = (i * r.idle_per_min
              + (i - r.long_idle_threshold) * r.long_idle_per_min
              + (i - r.terminal_wait_free_min) * r.driver_cost_per_min)
    assert abs(settantotto - atteso) < 1e-9
    # ed e' la voce dominante: senza, l'attesa costerebbe meno della meta'
    assert 60 * r.driver_cost_per_min > settantotto / 2


def test_il_deposito_non_paga_le_ore_in_cui_il_bus_e_a_casa():
    """In deposito il mezzo e' a casa e non c'e' nessuno a tenerlo d'occhio: il
    costo e' solo andata e ritorno, e non cresce con la durata della sosta."""
    r = VehicleCostRates()
    legs = {"km": 10.0, "min": 30, "kmIn": 5.0, "minIn": 15, "kmOut": 5.0, "minOut": 15}
    costo = vsp.via_depot_cost(legs, "12m", r)
    # km compensati dal corrispettivo (2,60 > 0,80): resta il tempo, piu' la voce fissa
    assert abs(costo - (30 * r.driver_cost_per_min + r.per_depot_return)) < 1e-9
    # una sosta di 30' non lo giustifica, una di 90' si': il punto di pareggio
    # non e' fissato a mano, esce dalla distanza del deposito
    assert vsp.terminal_wait_cost(30, 0, r) < costo
    assert vsp.terminal_wait_cost(90, 0, r) > costo


def test_deposito_piu_lontano_tiene_il_bus_fuori_piu_a_lungo():
    r = VehicleCostRates()
    vicino = {"km": 4.0, "min": 12, "kmIn": 2.0, "minIn": 6, "kmOut": 2.0, "minOut": 6}
    lontano = {"km": 24.0, "min": 70, "kmIn": 12.0, "minIn": 35, "kmOut": 12.0, "minOut": 35}
    assert vsp.via_depot_cost(vicino, "12m", r) < vsp.via_depot_cost(lontano, "12m", r)
    # col deposito vicino una sosta di 45' basta a mandarlo a casa, con quello
    # lontano no: la stessa regola da' risposte diverse dove la citta' e' diversa
    quarantacinque = vsp.terminal_wait_cost(45, 0, r)
    assert vsp.via_depot_cost(vicino, "12m", r) < quarantacinque
    assert vsp.via_depot_cost(lontano, "12m", r) > quarantacinque


def test_arco_via_deposito_generato_su_sosta_lunga_con_diretto_legale():
    """Il caso che mancava: collegamento diretto perfettamente legale e sosta
    lunga. Prima l'unica alternativa era tenere il bus fermo al capolinea."""
    Y, Z = (43.62, 13.52), (43.64, 13.48)
    D = {"id": "d1", "name": "Deposito", "lat": 43.61, "lon": 13.49}
    d = (D["lat"], D["lon"])
    key = lambda p, q: f"{dh_key(*p)}|{dh_key(*q)}"
    # diretto Y->Z corto e ammesso; deposito raggiungibile da entrambi i capi
    set_deadhead_matrix({key(Y, Z): 2.0, key(Y, d): 5.0, key(d, Z): 5.0})
    set_deadhead_min_matrix({key(Y, Z): 6, key(Y, d): 15, key(d, Z): 15})
    try:
        r = VehicleCostRates()
        # sosta di 3 ore: il diretto e' legale, ma tenere il bus li' costa il
        # nastro di chi lo presidia
        trips = [_vtrip(0, 480, 510, "X", "Y", 43.60, 13.50, *Y),
                 _vtrip(1, 690, 720, "Z", "W", *Z, 43.66, 13.50)]
        vsp._VIA_DEPOT_ARCS["chosenOverDirect"] = 0
        archi = vsp.build_compatible_arcs_fast(trips, r, depots=[D])
        arco = next(a for a in archi if a.i == 0 and a.j == 1)
        assert arco.via_depot, "il rientro in deposito non e' stato scelto"
        assert arco.depot_return
        assert vsp._VIA_DEPOT_ARCS["chosenOverDirect"] == 1

        # stessa coppia con sosta breve (20'): sotto la soglia, resta il diretto
        trips_corta = [_vtrip(0, 480, 510, "X", "Y", 43.60, 13.50, *Y),
                       _vtrip(1, 530, 560, "Z", "W", *Z, 43.66, 13.50)]
        vsp._VIA_DEPOT_ARCS["chosenOverDirect"] = 0
        archi2 = vsp.build_compatible_arcs_fast(trips_corta, r, depots=[D])
        arco2 = next(a for a in archi2 if a.i == 0 and a.j == 1)
        assert not arco2.via_depot
        assert vsp._VIA_DEPOT_ARCS["chosenOverDirect"] == 0
    finally:
        set_deadhead_matrix(None)
        set_deadhead_min_matrix(None)


def test_la_soglia_e_configurabile_dall_operatore():
    r = VehicleCostRates()
    assert r.depot_alternative_min_gap == 30
    r2 = VehicleCostRates.from_config({"depotAlternativeMinGap": 60,
                                       "terminalWaitFreeMin": 20})
    assert r2.depot_alternative_min_gap == 60
    assert r2.terminal_wait_free_min == 20
