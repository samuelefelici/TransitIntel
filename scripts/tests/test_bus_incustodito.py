"""Il tempo massimo del bus senza conducente a un cambio in linea (tappa 6.31).

Era 15 minuti scritti nel codice (UNATTENDED_BUS_MAX). Ora è una regola dei
turni guida, config.bds.copertura.busIncustoditoMax; senza, resta 15.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import crew_scheduler_v4 as csp
import crew_tools


def _con(minuti=None):
    cop = {} if minuti is None else {"busIncustoditoMax": minuti}
    return {"bds": {"copertura": cop}}


def teardown_function(_):
    csp.apply_bus_incustodito_config({})


def test_senza_regola_resta_il_valore_di_sempre():
    csp.apply_bus_incustodito_config({})
    assert csp.UNATTENDED_BUS_MAX == 15
    csp.apply_bus_incustodito_config(_con())
    assert csp.UNATTENDED_BUS_MAX == 15


def test_la_regola_scritta_vale_e_quella_storta_no():
    csp.apply_bus_incustodito_config(_con(10))
    assert csp.UNATTENDED_BUS_MAX == 10
    for storto in (-1, 61, "10", True, None):
        csp.apply_bus_incustodito_config(_con(storto))
        assert csp.UNATTENDED_BUS_MAX == 15, storto


def test_il_montante_prende_il_bus_entro_il_tempo_scritto():
    # arrivo alle 10:00, ripartenza alle 11:00: la sosta è lunga
    csp.apply_bus_incustodito_config(_con(15))
    assert csp.takeover_min(600, 660) == 615
    csp.apply_bus_incustodito_config(_con(5))
    assert csp.takeover_min(600, 660) == 605
    # sosta corta (fino al doppio del limite): il montante la copre tutta
    assert csp.takeover_min(600, 610) == 600
    csp.apply_bus_incustodito_config(_con(0))
    assert csp.takeover_min(600, 660) == 600


def test_gli_strumenti_dei_turni_leggono_la_stessa_regola():
    crew_tools._setup(_con(8))
    assert csp.UNATTENDED_BUS_MAX == 8
