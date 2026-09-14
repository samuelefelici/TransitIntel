"""La sonda impara dagli errori: dentro il giro e fra un giro e l'altro.

Nel giro AX la sonda ha usato tre sonde su dieci e il rendiconto non lo diceva:
la lista dei candidati di linea era di quattro mosse migliori, tre sono morte nel
filtro delle coincidenze, e la coda si e' svuotata. Lo stesso rifiuto compariva
quattro volte, una per passata del ciclo, e sembrava che la sonda ci spendesse
sonde. Qui si verifica che: il rifiuto si registra una volta coi tentativi
accanto; quando la mossa migliore di una linea muore nel filtro si prova il
delta dopo; la coda esaurita si dichiara; e le lezioni del giro si scrivono in
una forma che il giro dopo rilegge — come ordine, non come veto.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vcsp_probe as probe  # noqa: E402


def _t(tid, route, dep, arr, first, last, flex):
    return {"tripId": tid, "routeId": route, "directionId": 0,
            "departureMin": dep, "arrivalMin": arr,
            "firstStopId": first, "lastStopId": last,
            "firstStopName": first, "lastStopName": last,
            "routeName": route, "flexMin": flex}


def _rete():
    """La A (flex 15) arriva a N1; la B, la D e la E (rigide) ripartono da N1
    sette e nove minuti dopo: incontri mancati per poco. A N0 la C (rigida)
    arriva tre minuti prima che la A parta: coincidenza esistente.

    La mossa migliore della A e' +4 (crea B, D, E; rompe C): muore nel filtro
    perche' la C non ha flessibilita'. L'alternativa +2 crea la B e non rompe
    la C: passa."""
    trips = []
    for k in range(4):
        ora = 480 + 60 * k
        dep_a = ora - 40
        trips.append(_t(f"A{k}", "A", dep_a, ora, "N0", "N1", 15))
        trips.append(_t(f"C{k}", "C", dep_a - 33, dep_a - 3, "X", "N0", 0))
        trips.append(_t(f"B{k}", "B", ora + 7, ora + 37, "N1", "Y", 0))
        trips.append(_t(f"D{k}", "D", ora + 9, ora + 39, "N1", "Z", 0))
        trips.append(_t(f"E{k}", "E", ora + 9, ora + 39, "N1", "W", 0))
    return trips


def _solver_finti(accetta: set[int], violazioni_controllo: int = 0):
    """VSP finto: riconosce lo spostamento della A dall'orario di A0 e risparmia
    una vettura solo per i delta in `accetta` (0 = il controllo, senza
    spostamenti). CSP finto: nessun turno; le violazioni del controllo si
    impongono da fuori."""
    visti: list[int] = []
    stato = {"ultimo": None}

    def vsp_run(payload):
        a0 = next(t for t in payload["trips"] if t["tripId"] == "A0")
        d = int(a0["departureMin"]) - 440
        visti.append(d)
        stato["ultimo"] = d
        vetture = 9 if d in accetta else 10
        return {"vehicleShifts": [{"vehicleId": "V1", "trips": []}],
                "metrics": {"vehicles": vetture, "costEur": 100.0 * vetture}}

    def csp_run(payload, time_limit):
        return {"driverShifts": [], "summary": {}}

    def kpi_fn(v, c):
        vetture = int(v["metrics"]["vehicles"])
        viol = violazioni_controllo if stato["ultimo"] == 0 else 0
        return {"totalCostEur": 1000.0 + 100.0 * vetture,
                "selectionScoreEur": 1000.0 + 100.0 * vetture + 100.0 * viol,
                "duties": 5, "bdsViolations": viol}

    return vsp_run, csp_run, kpi_fn, visti


def _giro(accetta={2}, max_probes=10, probe_memory=None, controllo=False,
          violazioni_controllo=0):
    vsp_run, csp_run, kpi_fn, visti = _solver_finti(set(accetta), violazioni_controllo)
    best_vsp = {"vehicleShifts": [{"vehicleId": "V1", "trips": []}],
                "metrics": {"vehicles": 10, "costEur": 1000.0}}
    best_crew = {"driverShifts": [], "summary": {}}
    best_kpi = {"totalCostEur": 2000.0, "selectionScoreEur": 2000.0, "duties": 5, "bdsViolations": 0}
    res = probe.run_probe_phase(
        {"trips": _rete(), "config": {}}, best_vsp, best_crew, best_kpi,
        vsp_run=vsp_run, csp_run=csp_run, crew_config={}, crew_time_limit=5,
        kpi_fn=kpi_fn, max_probes=max_probes, probe_memory=probe_memory,
        probe_control=controllo)
    _giro.ultimo = res
    return res["probe"], visti


# ── firma ────────────────────────────────────────────────────────────────

def test_la_firma_di_una_linea_e_linea_e_delta():
    c = {"kind": "coincidenza", "route": "7", "shifts": {"x": -11, "y": -11}}
    assert probe.candidate_signature(c) == "linea:7:-11"


def test_la_firma_di_una_mossa_non_dipende_dall_ordine_delle_corse():
    a = {"kind": "tail-", "shifts": {"aaaaaaaa1": -3, "bbbbbbbb2": -3}}
    b = {"kind": "tail-", "shifts": {"bbbbbbbb2": -3, "aaaaaaaa1": -3}}
    assert probe.candidate_signature(a) == probe.candidate_signature(b) == "tail-:aaaaaaaa-3,bbbbbbbb-3"


def test_oltre_quattro_corse_la_firma_si_riassume():
    c = {"kind": "crew-both", "shifts": {f"corsa{i}": 5 for i in range(6)}}
    f = probe.candidate_signature(c)
    assert f.startswith("crew-both:6corse:") and len(f) == len("crew-both:6corse:") + 8


# ── alternative e coda ───────────────────────────────────────────────────

def test_la_lista_di_linea_porta_le_alternative_dopo_le_migliori():
    cands = probe.find_coincidence_probe_candidates(_rete())
    firme = [probe.candidate_signature(c) for c in cands]
    assert firme[0] == "linea:A:+4", firme
    assert "linea:A:+2" in firme
    alt = next(c for c in cands if probe.candidate_signature(c) == "linea:A:+2")
    assert alt["alternativaDi"] == 4
    assert "alternativaDi" not in cands[0]


def test_quando_la_mossa_migliore_muore_nel_filtro_si_prova_l_alternativa():
    sez, visti = _giro(accetta={2})
    assert visti[0] == 2, "la prima mossa arrivata al solver e' l'alternativa +2"
    assert sez["accepted"] and sez["accepted"][0]["firma"] == "linea:A:+2"
    assert sez["accepted"][0]["alternativaDi"] == 4
    assert sez["accepted"][0]["after"]["vehicles"] == 9


def test_il_rifiuto_del_filtro_si_registra_una_volta_coi_tentativi():
    # Nessuna mossa conviene al solver: +2 arriva al solver e viene bocciata,
    # poi il ciclo fa una seconda passata (stessa rete) e il filtro rivede +4.
    sez, visti = _giro(accetta=set())
    assert visti == [2] and sez["probesRun"] == 1
    voci = [r for r in sez["rejected"] if r.get("firma") == "linea:A:+4"]
    assert len(voci) == 1, voci
    assert voci[0]["motivo"] == "coincidenza:flessibilitaInsufficiente"
    assert voci[0]["tentativi"] == 2, "il filtro gira a ogni passata, ma si conta una volta"
    assert sez["rejectedForCoincidence"] == len(
        {r["firma"] for r in sez["rejected"] if r.get("why") == "rompe una coincidenza"})
    assert sez["propagationFailures"]["flessibilitaInsufficiente"] == len(
        {r["firma"] for r in sez["rejected"] if r.get("propagationFailed") == "flessibilitaInsufficiente"})


def test_la_coda_esaurita_si_dichiara():
    sez, _ = _giro(accetta={2}, max_probes=10)
    assert sez["codaEsaurita"] is True
    assert sez["probesRun"] < 10
    assert sez["sondeNonUsate"] == 10 - sez["probesRun"]


def test_col_budget_finito_la_coda_non_e_esaurita():
    sez, _ = _giro(accetta={2}, max_probes=1)
    assert sez["probesRun"] == 1
    assert sez["codaEsaurita"] is False
    assert sez["sondeNonUsate"] == 0


# ── lezioni e memoria ────────────────────────────────────────────────────

def test_le_lezioni_portano_esito_motivo_e_tentativi():
    sez, _ = _giro(accetta={2})
    per_firma = {l["firma"]: l for l in sez["lezioni"]}
    assert per_firma["linea:A:+2"]["esito"] == "accettato"
    assert per_firma["linea:A:+2"]["scoreDeltaEur"] < 0
    assert per_firma["linea:A:+2"]["vetture"] == [10, 9]
    assert per_firma["linea:A:+4"]["esito"] == "scartato"
    assert per_firma["linea:A:+4"]["motivo"] == "coincidenza:flessibilitaInsufficiente"
    assert per_firma["linea:A:+4"]["tentativi"] == 1
    assert len(sez["lezioni"]) == len(per_firma), "una voce per firma"


def test_la_memoria_ordina_e_non_decide():
    cands = [{"kind": "coincidenza", "route": "A", "shifts": {"A0": 2}},
             {"kind": "tail-", "shifts": {"B0000000": -3}},
             {"kind": "coincidenza", "route": "C", "shifts": {"C0": -5}}]
    memoria = probe.build_probe_memory([
        {"firma": "linea:C:-5", "esito": "accettato", "giro": "g1"},
        {"firma": "linea:A:+2", "esito": "scartato", "motivo": "crew", "giro": "g1"},
        # morto nel filtro: si ricontrolla, non si rimanda
        {"firma": "tail-:B0000000-3", "esito": "scartato",
         "motivo": "coincidenza:flessibilitaInsufficiente", "giro": "g2"},
        {"firma": "linea:A:+2", "esito": "accettato", "giro": "g0"},   # piu' vecchia: perde
        {"senza firma": True},
    ])
    assert set(memoria) == {"linea:C:-5", "linea:A:+2", "tail-:B0000000-3"}
    ordinati, ripresi, rimandati = probe.order_by_memory(cands, memoria)
    assert [probe.candidate_signature(c) for c in ordinati] == [
        "linea:C:-5", "tail-:B0000000-3", "linea:A:+2"]
    assert (ripresi, rimandati) == (1, 1)
    assert len(ordinati) == 3, "nessuno viene tolto"


def test_il_giro_dopo_rilegge_le_lezioni_e_le_conta():
    prima, _ = _giro(accetta={2})
    lezioni = [dict(l, giro="giro-prima") for l in prima["lezioni"]]
    # Il giro dopo: la stessa rete, e la memoria dice che +2 era stato accettato.
    dopo, visti = _giro(accetta={2}, probe_memory=lezioni)
    assert dopo["memoria"]["giriLetti"] == 1
    assert dopo["memoria"]["lezioniLette"] == len(lezioni)
    assert dopo["memoria"]["ripresi"] == 1
    assert visti[0] == 2


def test_un_candidato_bocciato_dal_solver_va_in_fondo_ma_si_prova_ancora():
    memoria = [{"firma": "linea:A:+2", "esito": "scartato", "motivo": "crew", "giro": "g"}]
    sez, visti = _giro(accetta={2}, probe_memory=memoria)
    assert sez["memoria"]["rimandatiInCoda"] == 1
    assert 2 in visti, "rimandato in coda, non cancellato"
    assert sez["accepted"] and sez["accepted"][0]["firma"] == "linea:A:+2"


def test_senza_memoria_il_rendiconto_lo_dice():
    sez, _ = _giro(accetta={2})
    assert sez["memoria"] == {"giriLetti": 0, "lezioniLette": 0, "ripresi": 0, "rimandatiInCoda": 0}


# ── orchestratore ────────────────────────────────────────────────────────

def test_l_orchestratore_legge_la_memoria_dalla_configurazione():
    import vcsp_orchestrator as orch
    assert orch.probe_memory_from_cfg({}) == []
    assert orch.probe_memory_from_cfg({"probeMemory": "no"}) == []
    voci = [{"firma": "linea:A:+2", "esito": "accettato"}, {"senza": 1}, "x", {"firma": "  "}]
    assert orch.probe_memory_from_cfg({"probeMemory": voci}) == [voci[0]]
    troppe = [{"firma": f"f{i}"} for i in range(orch.PROBE_MEMORY_MAX + 5)]
    assert len(orch.probe_memory_from_cfg({"probeMemory": troppe})) == orch.PROBE_MEMORY_MAX


# ── il controllo ─────────────────────────────────────────────────────────

def test_senza_controllo_non_si_spende_un_solve():
    sez, visti = _giro(accetta={2}, controllo=False)
    assert sez["controllo"] is None
    assert visti[0] == 2


def test_il_controllo_gira_per_primo_e_se_non_batte_il_round_resta_il_round():
    sez, visti = _giro(accetta={2}, controllo=True)
    assert visti[0] == 0, "il controllo e' il primo solve, senza spostamenti"
    c = sez["controllo"]
    assert c["eseguito"] is True and c["riferimento"] == "round"
    assert c["vetture"] == {"round": 10, "controllo": 10}
    assert "punteggio" not in c, "senza mezzi in meno non si spende il CSP"
    assert sez["accepted"] and sez["accepted"][0]["firma"] == "linea:A:+2"
    assert sez["accepted"][0]["before"]["vehicles"] == 10


def test_il_controllo_che_batte_il_round_diventa_il_riferimento():
    """Il giro AY: 22 vetture dal re-solve corto contro 28 del round, senza
    spostare nulla. Il candidato che poi 'guadagna' le stesse 9 vetture non
    ha merito: si misura contro il controllo e viene scartato."""
    sez, visti = _giro(accetta={0, 2}, controllo=True)
    c = sez["controllo"]
    assert c["riferimento"] == "controllo"
    assert c["vetture"] == {"round": 10, "controllo": 9}
    assert c["punteggio"] == {"round": 2000.0, "controllo": 1900.0}
    assert c["violazioni"] == {"round": 0, "controllo": 0}
    assert sez["accepted"] == [], "9 vetture contro 9 del controllo: nessun merito"
    scartato = next(r for r in sez["rejected"] if r.get("firma") == "linea:A:+2")
    assert scartato["reason"] == "vsp"
    assert _giro.ultimo["kpi"]["totalCostEur"] == 1900.0, "il piano del controllo esce come risultato"
    assert _giro.ultimo["vsp"]["metrics"]["vehicles"] == 9


def test_il_controllo_non_compra_violazioni():
    sez, _ = _giro(accetta={0, 2}, controllo=True, violazioni_controllo=2)
    c = sez["controllo"]
    assert c["vetture"] == {"round": 10, "controllo": 9}
    assert c["violazioni"] == {"round": 0, "controllo": 2}
    assert c["riferimento"] == "round", "una vettura in meno non compra due violazioni"
    assert sez["accepted"] and sez["accepted"][0]["firma"] == "linea:A:+2"


def test_l_orchestratore_legge_il_controllo_dalla_configurazione():
    import vcsp_orchestrator as orch
    assert orch.probe_control_from_cfg({}) is True
    assert orch.probe_control_from_cfg({"probeControl": False}) is False
    assert orch.probe_control_from_cfg({"probeControl": 0}) is False
    for parola in ("false", "0", "off", "no", " FALSE "):
        assert orch.probe_control_from_cfg({"probeControl": parola}) is False, parola
    assert orch.probe_control_from_cfg({"probeControl": "si"}) is True
