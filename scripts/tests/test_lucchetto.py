"""Il lucchetto: un turno macchina deciso dall'operatore attraversa il solver
intatto.

Il difetto, visto in uso: in Fucina si spostano tre corse a mano, si preme
«Ri-ottimizza» e il lavoro sparisce — il modello riparte da zero e la partenza
a caldo e' un suggerimento, non un vincolo. Qui si verifica che un turno
bloccato (data.lockedChains) sia un VINCOLO DURO in ogni fase: nel modello
CP-SAT, nel greedy, nella ricerca locale, nell'eliminazione veicoli, nei
post-pass; che tenga la sua matricola; e che quando il modello non puo'
rispettarlo l'errore sia parlante invece di una riparazione silenziosa.

Il campione e' costruito con il PRODUTTORE VERO degli archi
(build_compatible_arcs_fast), non con un lookup finto: l'ultima volta che il
campione era fatto sul mio codice invece che sul suo, il test passava e la
funzione no.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import vehicle_scheduler_cpsat as v  # noqa: E402


def _trip(idx, dep, arr, a="A", b="B", route="R1", vehicle="12m", forced=False):
    """Corse fra due capolinea A e B che stanno a 3 km l'uno dall'altro."""
    coords = {"A": (43.60, 13.50), "B": (43.60, 13.53), "C": (43.66, 13.50)}
    la, lo = coords[a]
    lb, lob = coords[b]
    return v.Trip(
        idx=idx, trip_id=f"t{idx}", route_id=route, departure_min=dep,
        arrival_min=arr, first_stop_id=a, last_stop_id=b,
        first_stop_lat=la, first_stop_lon=lo, last_stop_lat=lb, last_stop_lon=lob,
        route_name=route, headsign=b, direction_id=0,
        departure_time=v.min_to_time(dep), arrival_time=v.min_to_time(arr),
        first_stop_name=a, last_stop_name=b, stop_count=10,
        required_vehicle=vehicle, category="urbano", forced=forced,
        duration_min=arr - dep,
    )


def _rete():
    """Otto corse A→B / B→A in due fasce: concatenabili in molti modi, cosi'
    il solver ha davvero qualcosa da decidere."""
    trips = [
        _trip(0, 480, 510, "A", "B"),
        _trip(1, 485, 515, "A", "B"),
        _trip(2, 520, 550, "B", "A"),
        _trip(3, 530, 560, "B", "A"),
        _trip(4, 570, 600, "A", "B"),
        _trip(5, 575, 605, "A", "B"),
        _trip(6, 615, 645, "B", "A"),
        _trip(7, 620, 650, "B", "A"),
    ]
    rates = v.VehicleCostRates()
    arcs = v.build_compatible_arcs_fast(trips, rates)
    lookup = {(a.i, a.j): a for a in arcs}
    return trips, arcs, lookup, rates


def _catena_strana():
    """Una catena che il solver da solo non farebbe mai: la 1 (parte 08:05)
    seguita dalla 3 (08:50) e dalla 5 (09:35) — salta una corsa per fascia e
    lascia buchi. Se sopravvive, e' perche' il lucchetto la tiene."""
    return ["t1", "t3", "t5"]


# ── traduzione dell'input ───────────────────────────────────────────────

def test_il_lucchetto_si_traduce_e_tiene_la_matricola():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input(
        [{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    assert piano is not None
    assert piano.chains == [[1, 3, 5]]
    assert piano.vehicle_ids == ["U007"]
    assert piano.first == {1} and piano.last == {5}
    assert piano.arcs == {(1, 3), (3, 5)}
    assert piano.is_locked_chain([1, 3, 5])
    assert not piano.is_locked_chain([1, 3])
    assert piano.vehicle_id_of([1, 3, 5]) == "U007"


def test_anche_il_formato_a_liste_semplici_e_ammesso():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([_catena_strana()], trips, lookup)
    assert piano.chains == [[1, 3, 5]]
    assert piano.vehicle_ids == [None]


def test_senza_lucchetto_niente_piano():
    trips, arcs, lookup, rates = _rete()
    for vuoto in (None, [], [[]], [{"vehicleId": "U1", "tripIds": []}]):
        assert v.locked_plan_from_input(vuoto, trips, lookup) is None


def test_una_corsa_che_non_esiste_e_un_errore_parlante():
    trips, arcs, lookup, rates = _rete()
    with pytest.raises(v.LockedChainError) as e:
        v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": ["t1", "fantasma"]}], trips, lookup)
    msg = str(e.value)
    assert "U007" in msg and "fantasma" in msg and "non è in questo orario" in msg


def test_una_corsa_in_due_turni_bloccati_e_un_errore_parlante():
    trips, arcs, lookup, rates = _rete()
    with pytest.raises(v.LockedChainError) as e:
        v.locked_plan_from_input(
            [{"vehicleId": "U001", "tripIds": ["t0", "t2"]},
             {"vehicleId": "U002", "tripIds": ["t2", "t4"]}], trips, lookup)
    msg = str(e.value)
    assert "U001" in msg and "U002" in msg and "due turni bloccati" in msg


def test_un_aggancio_impossibile_dice_perche_si_sovrappone():
    """La 0 arriva alle 08:30, la 1 e' partita alle 08:05: nessun mezzo le fa
    in fila. Non si spezza in silenzio come la partenza a caldo: si spiega."""
    trips, arcs, lookup, rates = _rete()
    assert (0, 1) not in lookup
    with pytest.raises(v.LockedChainError) as e:
        v.locked_plan_from_input([{"vehicleId": "U009", "tripIds": ["t0", "t1"]}], trips, lookup)
    msg = str(e.value)
    assert "U009" in msg and "sovrappongono" in msg and "08:30" in msg and "08:05" in msg


def test_due_matricole_uguali_sono_un_errore():
    trips, arcs, lookup, rates = _rete()
    with pytest.raises(v.LockedChainError) as e:
        v.locked_plan_from_input(
            [{"vehicleId": "U001", "tripIds": ["t0"]},
             {"vehicleId": "U001", "tripIds": ["t2"]}], trips, lookup)
    assert "stessa matricola" in str(e.value)


def test_la_partenza_a_caldo_invece_ripara_in_silenzio():
    """Il contrasto che giustifica il lucchetto: lo stesso aggancio impossibile,
    nella partenza a caldo, spezza la catena senza dire niente."""
    trips, arcs, lookup, rates = _rete()
    catene, diag = v.chains_from_trip_ids([["t0", "t1"]], trips, lookup)
    assert diag["aggancioMancante"] == 1
    assert [0] in catene and [1] in catene


# ── il modello CP-SAT ────────────────────────────────────────────────────

def _costi(trips, arcs, rates):
    strat = v.VSP_STRATEGIES["balanced"]
    return (v.precompute_arc_costs(arcs, trips, rates, strategy=strat),
            v.precompute_fixed_costs(trips, rates, strategy=strat))


def _senza_lucchetto_la_catena_strana_non_esce(trips, arcs, rates):
    arc_costs, fixed_costs = _costi(trips, arcs, rates)
    status, chains, _ = v.solve_vsp_cost_based(
        trips, arcs, arc_costs, fixed_costs, rates, "ALL", time_limit=10, intensity="fast")
    assert status in ("OPTIMAL", "FEASIBLE")
    return [1, 3, 5] not in chains


def test_il_modello_a_costi_rispetta_il_lucchetto():
    trips, arcs, lookup, rates = _rete()
    assert _senza_lucchetto_la_catena_strana_non_esce(trips, arcs, rates), \
        "il campione non distingue: il solver farebbe la catena strana da solo"
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    arc_costs, fixed_costs = _costi(trips, arcs, rates)
    status, chains, _ = v.solve_vsp_cost_based(
        trips, arcs, arc_costs, fixed_costs, rates, "ALL", time_limit=10,
        intensity="fast", locked=piano)
    assert status in ("OPTIMAL", "FEASIBLE")
    assert [1, 3, 5] in chains
    assert sorted(i for c in chains for i in c) == list(range(8))


def test_il_modello_lessicografico_rispetta_il_lucchetto():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    arc_costs, fixed_costs = _costi(trips, arcs, rates)
    status, chains, _ = v.solve_vsp_lexicographic(
        trips, arcs, arc_costs, fixed_costs, rates, "ALL", time_limit=30,
        intensity="fast", locked=piano)
    assert status in ("OPTIMAL", "FEASIBLE")
    assert [1, 3, 5] in chains


def test_il_modello_con_tetto_di_veicoli_rispetta_il_lucchetto():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    arc_costs, fixed_costs = _costi(trips, arcs, rates)
    status, chains = v.solve_vsp_feasibility_with_bound(
        trips, arcs, arc_costs, fixed_costs, max_vehicles=8, time_limit=10,
        intensity="fast", locked=piano)
    assert chains is not None
    assert [1, 3, 5] in chains


def test_il_no_good_cut_non_conta_gli_agganci_bloccati():
    """Un taglio che chiede di cambiare almeno N archi non puo' pretendere di
    cambiare quelli bloccati: restano fuori dal conto."""
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    seq = {(a.i, a.j): object() for a in arcs}
    forbidden = {(1, 3), (3, 5), (0, 2), (2, 4)}
    liberi = v._nogood_vars(seq, forbidden, piano)
    assert len(liberi) == 2
    assert len(v._nogood_vars(seq, forbidden, None)) == 4


# ── le euristiche: greedy, ricerca locale, eliminazione ──────────────────

def test_il_greedy_tiene_il_turno_bloccato_e_copre_il_resto():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    chains = v.greedy_warmstart(trips, arcs, lookup, rates, locked=piano)
    assert [1, 3, 5] in chains
    assert sorted(i for c in chains for i in c) == list(range(8))
    # nessun'altra catena tocca le corse bloccate
    assert all(not (set(c) & {1, 3, 5}) for c in chains if c != [1, 3, 5])


def test_la_ricerca_locale_non_tocca_il_turno_bloccato():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    # partenza volutamente pessima: tutti blocchi singoli piu' il bloccato
    partenza = [[1, 3, 5]] + [[i] for i in (0, 2, 4, 6, 7)]
    dopo = v.advanced_local_search(partenza, trips, lookup, rates, max_iter=500,
                                   max_time_sec=3.0, locked=piano)
    assert [1, 3, 5] in dopo
    assert sorted(i for c in dopo for i in c) == list(range(8))
    assert len(dopo) < len(partenza), "la ricerca locale deve pur fondere qualcosa fra le libere"


def test_l_eliminazione_veicoli_non_tocca_il_turno_bloccato():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    partenza = [[1, 3, 5]] + [[i] for i in (0, 2, 4, 6, 7)]
    dopo, stats = v.vehicle_elimination_pass(partenza, trips, lookup, rates,
                                             max_passes=3, time_budget_sec=5.0, locked=piano)
    assert [1, 3, 5] in dopo
    assert sorted(i for c in dopo for i in c) == list(range(8))
    assert stats["lockedVehicles"] == 1
    assert len(dopo) < len(partenza)


def test_i_post_pass_non_spezzano_il_turno_bloccato():
    """Normativa e sagoma spezzano le catene in violazione; un turno bloccato
    e' una decisione dell'operatore e passa intatto anche se le viola."""
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    rates.max_pieces_per_block = 1          # ogni catena con 2+ corse va spezzata
    libere_e_bloccata = [[1, 3, 5], [0, 2, 4]]
    out, splits = v.enforce_normativa_split(libere_e_bloccata, trips, rates, locked=piano)
    assert [1, 3, 5] in out
    assert splits == 2                       # solo la libera [0,2,4] → [0],[2],[4]
    out2, s2 = v.enforce_sagoma_chains([[1, 3, 5]], trips, locked=piano)
    assert out2 == [[1, 3, 5]] and s2 == 0


# ── dal piano ai turni ───────────────────────────────────────────────────

def test_il_turno_bloccato_esce_con_la_sua_matricola_e_il_flag():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U002", "tripIds": _catena_strana()}], trips, lookup)
    chains = [[0, 2, 4, 6], [1, 3, 5], [7]]
    shifts = v.chains_to_shifts(chains, trips, lookup, rates, locked=piano)
    per_id = {s.vehicle_id: s for s in shifts}
    assert "U002" in per_id
    bloccato = per_id["U002"]
    assert bloccato.locked is True
    assert [t.trip_id for t in bloccato.trips if t.type == "trip"] == ["t1", "t3", "t5"]
    # la numerazione automatica salta la matricola presa: U001, U003 — mai un secondo U002
    assert sorted(per_id) == ["U001", "U002", "U003"]
    assert all(not s.locked for s in shifts if s.vehicle_id != "U002")
    d = v.vehicle_shift_to_dict(bloccato)
    assert d["locked"] is True and d["vehicleId"] == "U002"
    assert "locked" not in v.vehicle_shift_to_dict(per_id["U001"])


def test_validate_locked_segnala_il_lucchetto_rotto():
    trips, arcs, lookup, rates = _rete()
    piano = v.locked_plan_from_input([{"vehicleId": "U007", "tripIds": _catena_strana()}], trips, lookup)
    assert v.validate_locked([[1, 3, 5], [0, 2]], piano, trips) == []
    rotti = v.validate_locked([[1, 3], [5], [0, 2]], piano, trips)
    assert len(rotti) == 1 and "U007" in rotti[0]


# ── il giro intero ───────────────────────────────────────────────────────

def _input_run(locked):
    trips = [
        dict(tripId=f"t{i}", routeId="R1", routeName="R1", departureMin=d, arrivalMin=a,
             firstStopId=x, lastStopId=y, firstStopName=x, lastStopName=y,
             firstStopLat=43.60, firstStopLon=13.50 if x == "A" else 13.53,
             lastStopLat=43.60, lastStopLon=13.50 if y == "A" else 13.53,
             requiredVehicle="12m", category="urbano")
        for i, (d, a, x, y) in enumerate([
            (480, 510, "A", "B"), (485, 515, "A", "B"), (520, 550, "B", "A"), (530, 560, "B", "A"),
            (570, 600, "A", "B"), (575, 605, "A", "B"), (615, 645, "B", "A"), (620, 650, "B", "A"),
        ])
    ]
    return {
        "trips": trips,
        "config": {
            "timeLimit": 20, "solverIntensity": "fast",
            "vspAdvanced": {"totalTimeOverrideSec": 20, "lsTimeOverrideSec": 2,
                            "lsIterOverride": 300, "scenariosOverride": 1,
                            "enablePolish": False,
                            "vehicleEliminationTimeSec": 3,
                            "iterativeReductionTimeSec": 5},
        },
        "lockedChains": locked,
    }


def test_run_intero_il_turno_bloccato_sopravvive_a_tutte_le_fasi():
    """Il criterio di accettazione del lavoro: blocco un turno che il solver
    non farebbe mai, rilancio tutto — CP-SAT, ricerca locale, eliminazione,
    riduzione iterativa, post-pass — e il turno e' ancora li', con la sua
    matricola e il flag."""
    out = v.run(_input_run([{"vehicleId": "U007", "tripIds": _catena_strana()}]))
    assert "error" not in out, out.get("error")
    shifts = out["vehicleShifts"]
    per_id = {s["vehicleId"]: s for s in shifts}
    assert "U007" in per_id, sorted(per_id)
    corse = [t["tripId"] for t in per_id["U007"]["trips"] if t["type"] == "trip"]
    assert corse == ["t1", "t3", "t5"]
    assert per_id["U007"]["locked"] is True
    assert sum(1 for s in shifts if s.get("locked")) == 1
    coperte = sorted(t["tripId"] for s in shifts for t in s["trips"] if t["type"] == "trip")
    assert coperte == [f"t{i}" for i in range(8)]
    assert out["metrics"]["lockedChains"] == {"turni": 1, "corse": 3, "vehicleIds": ["U007"]}


def test_run_intero_senza_lucchetto_non_produce_la_catena_strana():
    """Il controllo del campione: senza lucchetto la catena strana non esce,
    altrimenti il test sopra non proverebbe niente."""
    out = v.run(_input_run(None))
    assert "error" not in out
    forme = [[t["tripId"] for t in s["trips"] if t["type"] == "trip"] for s in out["vehicleShifts"]]
    assert ["t1", "t3", "t5"] not in forme
    assert out["metrics"]["lockedChains"] is None
    assert all("locked" not in s for s in out["vehicleShifts"])


def test_run_intero_un_lucchetto_impossibile_torna_come_errore_parlante():
    out = v.run(_input_run([{"vehicleId": "U009", "tripIds": ["t0", "t1"]}]))
    assert out["errorKind"] == "lockedChains"
    assert "U009" in out["error"] and "sovrappongono" in out["error"]
    assert out["vehicleShifts"] == []
    assert out["metrics"]["status"] == "LOCKED_CHAINS_INFEASIBLE"
