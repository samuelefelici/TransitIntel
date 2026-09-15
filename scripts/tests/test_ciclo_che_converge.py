"""Il ciclo VSP-CSP smette di inseguire: moneta onesta, ancora, memoria, seme.

Il difetto, misurato: i round non migliorano l'uno sull'altro. Giro BA 25, 25,
27, 21, 33 vetture sullo stesso orario; giro AZ 25, 31, 26, 25, 26. Quattro
cause distinte, tutte nel modo in cui il feedback passa da un round all'altro:

1. LA MONETA ERA TRUCCATA. Il costo con cui si confrontano i round arriva dal
   VSP e porta dentro le penalita' d'arco, che sono soldi inventati da noi e
   cambiano a ogni round: il round 1 non ne ha nessuna, i round dopo si'. I
   round finivano in classifica su scale diverse.
2. IL FEEDBACK NASCEVA DALL'ULTIMO ARRIVATO, anche quando era il peggiore della
   serie, e si trascinava dietro tutto il resto del giro.
3. LE PENALITA' SI CANCELLAVANO. Erano riassegnate, non aggiornate: un arco
   penalizzato al round r, se il round r+1 lo evitava, al round r+2 tornava
   gratis. E' il generatore classico del ciclo limite.
4. NON C'ERA IL CANALE PER RIPARTIRE DAL PIANO MIGLIORE: ogni round era un
   solve da capo.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import vcsp_orchestrator as orch  # noqa: E402


def _vsp(vetture=20, costo=1000.0, ombra=0.0, shifts=None):
    return {
        "vehicleShifts": shifts if shifts is not None else [],
        "metrics": {"vehicles": vetture, "costEur": costo},
        "costBreakdown": {"aggregated": {"total": costo, "vcspPenalty": ombra}},
    }


def _crew(turni=40, costo=15000.0, violazioni=0):
    return {"summary": {"totalShifts": turni, "totalDailyCost": costo,
                        "validation": {"totalViolations": violazioni},
                        "totalSupplementi": 0}}


# ── 1. la moneta onesta ──────────────────────────────────────────────────

def test_le_penalita_inventate_si_leggono_dal_piano():
    assert orch._vcsp_penalty_of(_vsp(ombra=123.45)) == 123.45
    assert orch._vcsp_penalty_of({}) == 0.0
    assert orch._vcsp_penalty_of({"costBreakdown": {}}) == 0.0
    assert orch._vcsp_penalty_of({"costBreakdown": {"aggregated": {"vcspPenalty": "x"}}}) == 0.0
    assert orch._vcsp_penalty_of({"costBreakdown": {"aggregated": {"vcspPenalty": -5}}}) == 0.0


def test_il_costo_del_round_e_al_netto_delle_penalita_inventate():
    kpi = orch._round_kpi(2, _vsp(costo=1000.0, ombra=250.0), _crew(costo=500.0))
    assert kpi["vehicleCostEur"] == 750.0, "250 di penalita' non sono soldi veri"
    assert kpi["shadowPenaltyEur"] == 250.0
    assert kpi["totalCostEur"] == 1250.0


def test_due_round_con_lo_stesso_costo_vero_finiscono_pari():
    """Il round 1 non ha penalita' per costruzione, il round 3 si'. Con la
    moneta vecchia il round 3 sembrava piu' caro di 300 euro senza aver speso
    un centesimo in piu'."""
    uno = orch._round_kpi(1, _vsp(costo=1000.0, ombra=0.0), _crew())
    tre = orch._round_kpi(3, _vsp(costo=1300.0, ombra=300.0), _crew())
    assert uno["vehicleCostEur"] == tre["vehicleCostEur"] == 1000.0
    assert orch._round_rank(uno) == orch._round_rank(tre)


def test_la_moneta_onesta_non_sottrae_piu_del_costo():
    kpi = orch._round_kpi(1, _vsp(costo=100.0, ombra=999.0), _crew(costo=0.0))
    assert kpi["vehicleCostEur"] == 0.0


# ── 3. le penalita' hanno memoria ────────────────────────────────────────

def test_col_passo_intero_le_penalita_si_sostituiscono_come_prima():
    vecchie = {"a|b": 100.0, "c|d": 50.0}
    nuove = {"e|f": 20.0}
    assert orch._mix_penalties(vecchie, nuove, 1.0) == nuove


def test_col_passo_smorzato_un_arco_caro_resta_caro_anche_se_nessuno_lo_usa():
    """E' il punto: il round dopo evita l'arco, quindi non compare fra le
    penalita' nuove. Prima tornava gratis e il piano ci ricascava."""
    dopo = orch._mix_penalties({"a|b": 100.0}, {}, 0.5)
    assert dopo["a|b"] == 50.0
    ancora = orch._mix_penalties(dopo, {}, 0.5)
    assert ancora["a|b"] == 25.0


def test_la_penalita_che_si_e_spenta_si_dimentica():
    """Si scende per meta' a ogni round: sotto la soglia sparisce, o il
    vettore cresce all'infinito con briciole."""
    d = {"a|b": 3.0}
    for _ in range(3):
        d = orch._mix_penalties(d, {}, 0.5)
    assert d == {}, d


def test_il_passo_smorzato_media_vecchio_e_nuovo():
    dopo = orch._mix_penalties({"a|b": 100.0}, {"a|b": 200.0}, 0.5)
    assert dopo["a|b"] == 150.0


def test_il_termometro_misura_quanto_e_saltato_il_bersaglio():
    assert orch._penalty_distance({"a|b": 100.0}, {"a|b": 100.0}) == 0.0
    assert orch._penalty_distance({"a|b": 100.0}, {}) == 100.0
    assert orch._penalty_distance({"a|b": 100.0}, {"c|d": 40.0}) == 140.0


# ── 4. il seme ───────────────────────────────────────────────────────────

def test_il_seme_sono_i_blocchi_del_piano_in_ordine():
    shifts = [
        {"vehicleId": "U001", "trips": [
            {"type": "trip", "tripId": "t1"},
            {"type": "deadhead"},
            {"type": "trip", "tripId": "t2"}]},
        {"vehicleId": "U002", "trips": [{"type": "trip", "tripId": "t3"}]},
    ]
    assert orch.seed_chains_from_shifts(shifts) == [["t1", "t2"], ["t3"]]


def test_un_blocco_senza_corse_non_entra_nel_seme():
    shifts = [{"vehicleId": "U001", "trips": [{"type": "deadhead"}]},
              {"vehicleId": "U002", "trips": []},
              {"vehicleId": "U003"}]
    assert orch.seed_chains_from_shifts(shifts) == []
    assert orch.seed_chains_from_shifts([]) == []
    assert orch.seed_chains_from_shifts(None) == []


# ── manopole: si torna al comportamento di prima senza un deploy ─────────

def test_le_manopole_del_feedback_si_leggono_dalla_configurazione():
    assert orch.penalty_step_from_cfg({}) == orch.PENALTY_STEP
    assert orch.penalty_step_from_cfg({"penaltyStep": 1.0}) == 1.0
    assert orch.penalty_step_from_cfg({"penaltyStep": 0}) == 0.05, "mai zero: il feedback morirebbe"
    assert orch.penalty_step_from_cfg({"penaltyStep": 9}) == 1.0
    assert orch.penalty_step_from_cfg({"penaltyStep": "boh"}) == orch.PENALTY_STEP

    assert orch.penalty_anchor_from_cfg({}) == "best"
    assert orch.penalty_anchor_from_cfg({"penaltyAnchor": "last"}) == "last"
    assert orch.penalty_anchor_from_cfg({"penaltyAnchor": "sbagliato"}) == "best"

    assert orch.seed_from_best_from_cfg({}) is True
    assert orch.seed_from_best_from_cfg({"seedFromBest": False}) is False
    for parola in ("false", "0", "off", "no", " FALSE "):
        assert orch.seed_from_best_from_cfg({"seedFromBest": parola}) is False, parola


def test_col_passo_intero_e_ancora_sull_ultimo_si_torna_a_com_era():
    """La via di fuga: due valori in configurazione e il ciclo si comporta
    come prima della modifica, senza rimettere mano al codice."""
    cfg = {"penaltyStep": 1.0, "penaltyAnchor": "last", "seedFromBest": False}
    assert orch.penalty_step_from_cfg(cfg) == 1.0
    assert orch.penalty_anchor_from_cfg(cfg) == "last"
    assert orch.seed_from_best_from_cfg(cfg) is False
    vecchie, nuove = {"a|b": 100.0}, {"c|d": 7.0}
    assert orch._mix_penalties(vecchie, nuove, orch.penalty_step_from_cfg(cfg)) == nuove


# ── 2bis. il moltiplicatore e il piano che moltiplica ────────────────────
#
# Il rilievo che la revisione ha confermato all'unanimita', e che l'ancora
# aveva introdotto: l'escalation dei giunti si misurava sulla legalita'
# dell'ULTIMO round e si applicava alle penalita' del CAMPIONE. Ma le
# penalita' sui giunti esistono SOLO quando ci sono cambi senza auto o bus
# lasciati soli oltre il limite, cioe' esattamente quando il piano NON e'
# legale. Con un campione legale il moltiplicatore moltiplicava il vuoto,
# mentre il log diceva «cambi fuori regola» e il rendiconto mostrava un
# numero che non agiva su niente.


def _piano_con_un_giunto():
    """Un blocco con due corse: il giunto e' l'arco fra le due."""
    return {"vehicleShifts": [{"vehicleId": "U001", "trips": [
        {"type": "trip", "tripId": "t1", "arrivalMin": 600},
        {"type": "trip", "tripId": "t2", "departureMin": 640}]}]}


def _turni(*, incustodito=0, conflitti_auto=0, con_auto=False):
    """Turni guida con un cambio in linea sul giunto del blocco."""
    over = [{"vehicleId": "U001"}] if incustodito > 15 else []
    return {
        "summary": {"handoverModes": {"unattendedLimitMin": 15, "overLimit": over},
                    "companyCarsCap": 5, "companyCarsMaxSimultaneous": 1,
                    "companyCarsConflicts": conflitti_auto},
        "handovers": [{"kind": "inline", "vehicleId": "U001", "atMin": 620,
                       "unattendedMin": incustodito,
                       "incomingMode": "car" if con_auto else "piedi",
                       "outgoingMode": "piedi"}],
    }


def test_su_un_piano_in_regola_le_penalita_dei_giunti_sono_vuote_a_ogni_moltiplicatore():
    """La ragione per cui il moltiplicatore va misurato sullo stesso piano da
    cui nascono le penalita': su un piano legale non c'e' niente da
    moltiplicare, e un'escalation che sale li' sopra sale a vuoto."""
    legale = _turni(incustodito=5)
    assert orch.round_is_legal(legale) is True
    for moltiplicatore in (1.0, 2.5, 8.0):
        pen, _ = orch.handover_arc_penalties(_piano_con_un_giunto(), legale, moltiplicatore)
        assert pen == {}, f"moltiplicatore {moltiplicatore}: {pen}"


def test_su_un_piano_fuori_regola_il_moltiplicatore_morde():
    fuori = _turni(incustodito=40)
    assert orch.round_is_legal(fuori) is False
    una, _ = orch.handover_arc_penalties(_piano_con_un_giunto(), fuori, 1.0)
    otto, _ = orch.handover_arc_penalties(_piano_con_un_giunto(), fuori, 8.0)
    assert una == {"t1|t2": orch.UNATTENDED_PENALTY_EUR}
    assert otto["t1|t2"] == orch.UNATTENDED_PENALTY_EUR * 8


def test_il_tetto_delle_auto_sfondato_rende_il_piano_illegale_e_penalizzato():
    fuori = _turni(incustodito=5, conflitti_auto=2, con_auto=True)
    assert orch.round_is_legal(fuori) is False
    pen, diag = orch.handover_arc_penalties(_piano_con_un_giunto(), fuori, 1.0)
    assert pen.get("t1|t2", 0) > 0
    assert diag["giuntiConAuto"] == 1


def test_legale_e_senza_penalita_sui_giunti_sono_la_stessa_cosa():
    """L'equivalenza su cui poggia la correzione, provata nei quattro casi."""
    casi = [_turni(incustodito=5),
            _turni(incustodito=40),
            _turni(incustodito=5, conflitti_auto=1, con_auto=True),
            _turni(incustodito=40, conflitti_auto=1, con_auto=True)]
    for t in casi:
        pen, _ = orch.handover_arc_penalties(_piano_con_un_giunto(), t, 2.5)
        assert orch.round_is_legal(t) == (pen == {}), t["summary"]
