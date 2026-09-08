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


def test_la_banda_del_turno_pieno_arriva_al_tetto_legale():
    """Un turno intero puo' arrivare a 435 minuti (7h15) ed e' lavoro ordinario
    pagato al 100%: fino a li' non c'e' straordinario da riconoscere.

    Con target_work_max a 402 la maggiorazione partiva a 408 minuti, 27 prima
    del tetto legale: la banda «gratis» fra sottoutilizzo e straordinario era
    [366, 408] e il solver parcheggiava ogni turno sul fondo. Nel giro AL il
    nastro medio e' stato 367 minuti, UN minuto sopra la soglia — e sono usciti
    42 turni contro i 38 del piano dell'operatore."""
    from cost_model import CostRates
    from optimizer_common import (SHIFT_RULES, TARGET_WORK_LOW, TARGET_WORK_HIGH,
                                  TARGET_WORK_MID)

    tetto = SHIFT_RULES["intero"]["maxLavoro"]
    assert tetto == 435                       # 7h15
    r = CostRates()
    assert r.target_work_max == tetto, "la banda deve arrivare al tetto legale"

    mid = (r.target_work_min + r.target_work_max) / 2.0
    # lo straordinario non parte prima del tetto legale del turno intero
    assert mid + 12 <= tetto
    # un turno da 400 minuti (6h40) e' pieno, non straordinario
    assert 400 < mid + 12
    # e non e' nemmeno sottoutilizzato
    assert 400 > mid - 30

    # le due definizioni di «turno pieno» nel motore non devono divergere
    assert TARGET_WORK_LOW == r.target_work_min
    assert TARGET_WORK_HIGH == r.target_work_max
    assert abs(TARGET_WORK_MID - mid) <= 1


def test_alzare_il_tetto_non_deve_alzare_il_pavimento():
    """Le due soglie di costo del turno sono INDIPENDENTI.

    Derivarle entrambe dalla media della banda significa che allargare il tetto
    trascina su anche il pavimento. E' l'errore costato il giro AN: portando
    target_work_max da 402 a 435 il pavimento e' salito da 366 a 382,5 minuti,
    e turni perfettamente regolari da 370 minuti hanno cominciato a pagare
    sottoutilizzo — +411 EUR di costo guida per lo stesso identico lavoro, e
    nemmeno un turno risparmiato."""
    from cost_model import CostRates, UNDERTIME_TOLERANCE

    r = CostRates()
    pavimento = r.target_work_min - UNDERTIME_TOLERANCE
    assert pavimento == 366, "il pavimento deve restare dove stava"
    assert r.target_work_max == 435, "il tetto e' quello legale"

    # il pavimento dipende SOLO dal minimo: muovere il tetto non lo tocca
    r2 = CostRates.from_config({"costRates": {"targetWorkMax": 480}})
    assert r2.target_work_max == 480
    assert r2.target_work_min - UNDERTIME_TOLERANCE == pavimento

    # e muovere il minimo non tocca il tetto
    r3 = CostRates.from_config({"costRates": {"targetWorkMin": 360}})
    assert r3.target_work_max == r.target_work_max
    assert r3.target_work_min - UNDERTIME_TOLERANCE == 336
