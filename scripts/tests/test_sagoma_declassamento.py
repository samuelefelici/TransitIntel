"""Regola della sagoma: il tipo dichiarato su una linea e' il mezzo giusto e
insieme il suo tetto fisico.

Sopra quella taglia la strada non regge, quindi non esiste promozione: mandare
un 12m su una linea da pollicino non e' uno spreco, e' un mezzo che in quella
strada non passa. Sotto si perde capienza, e si concede un gradino solo, mai
due, e il meno possibile.

Scala, dal piu' grande al piu' piccolo: autosnodato -> 12m -> 10m -> pollicino.
Un blocco di una certa taglia puo' quindi servire solo le linee della propria
taglia e quelle di UNA taglia superiore, queste ultime in declassamento.
"""

import pytest

from optimizer_common import (
    VEHICLE_SIZE, can_vehicle_serve, is_peak_hour,
    set_peak_windows, get_peak_windows, DEFAULT_PEAK_WINDOWS,
    VShiftTrip, VehicleShift,
)
from vehicle_scheduler_cpsat import (
    Trip, trips_vehicle_compatible, chain_servable_by_single_vehicle,
    assign_vehicle_type, build_sagoma_report,
)


def mk_trip(i: int, required: str, forced: bool = False,
            departure_min: int = 480, route_name: str | None = None) -> Trip:
    return Trip(
        idx=i, trip_id=f"t{i}", route_id=f"r_{required}",
        route_name=route_name or required, headsign="",
        departure_time="08:00", arrival_time="08:30",
        departure_min=departure_min, arrival_min=departure_min + 20,
        duration_min=20, direction_id=0,
        first_stop_id="A", last_stop_id="B",
        first_stop_lat=43.6, first_stop_lon=13.5,
        last_stop_lat=43.6, last_stop_lon=13.5,
        first_stop_name="A", last_stop_name="B", stop_count=5,
        required_vehicle=required, forced=forced, category="urbano",
    )


def chain_of(requireds: list[str], forced_idx: set[int] | None = None):
    """Corse allo stesso capolinea, distanziate un'ora: concatenabili nel tempo,
    così quel che decide è solo la regola della sagoma."""
    forced_idx = forced_idx or set()
    trips = [mk_trip(i, rv, forced=(i in forced_idx), departure_min=480 + i * 60)
             for i, rv in enumerate(requireds)]
    return list(range(len(trips))), trips


# ═══════════════════════════════════════════════════════════════
#  VERSO DEL VINCOLO: si scende, non si sale
# ═══════════════════════════════════════════════════════════════

class TestVersoDelVincolo:
    def test_mezzo_piu_grande_non_ammesso(self):
        # Un autosnodato non puo' servire una linea dichiarata da 12m.
        assert can_vehicle_serve(VEHICLE_SIZE["autosnodato"], VEHICLE_SIZE["12m"]) is False
        # Ne' un 12m una linea da pollicino: e' il caso della linea 11.
        assert can_vehicle_serve(VEHICLE_SIZE["12m"], VEHICLE_SIZE["pollicino"]) is False
        assert can_vehicle_serve(VEHICLE_SIZE["10m"], VEHICLE_SIZE["pollicino"]) is False

    def test_mezzo_giusto_ammesso(self):
        for t in ("autosnodato", "12m", "10m", "pollicino"):
            assert can_vehicle_serve(VEHICLE_SIZE[t], VEHICLE_SIZE[t]) is True

    def test_un_gradino_sotto_ammesso(self):
        assert can_vehicle_serve(VEHICLE_SIZE["12m"], VEHICLE_SIZE["autosnodato"]) is True
        assert can_vehicle_serve(VEHICLE_SIZE["10m"], VEHICLE_SIZE["12m"]) is True
        assert can_vehicle_serve(VEHICLE_SIZE["pollicino"], VEHICLE_SIZE["10m"]) is True

    def test_due_gradini_sotto_vietati(self):
        # Il pollicino non puo' fare una corsa della 3: sarebbe 12m -> 10m -> pollicino.
        assert can_vehicle_serve(VEHICLE_SIZE["pollicino"], VEHICLE_SIZE["12m"]) is False
        assert can_vehicle_serve(VEHICLE_SIZE["10m"], VEHICLE_SIZE["autosnodato"]) is False


# ═══════════════════════════════════════════════════════════════
#  CONCATENAMENTO
# ═══════════════════════════════════════════════════════════════

class TestConcatenamento:
    def test_linea_11_e_linea_3_non_stanno_insieme(self):
        # Il caso di scuola: una corsa da pollicino non entra in un blocco della 3.
        a, b = mk_trip(0, "pollicino"), mk_trip(1, "12m")
        assert trips_vehicle_compatible(a, b) is False

    def test_taglie_adiacenti_si_concatenano(self):
        assert trips_vehicle_compatible(mk_trip(0, "12m"), mk_trip(1, "10m")) is True
        assert trips_vehicle_compatible(mk_trip(0, "pollicino"), mk_trip(1, "10m")) is True
        assert trips_vehicle_compatible(mk_trip(0, "autosnodato"), mk_trip(1, "12m")) is True

    def test_guard_di_catena_blocca_la_scala(self):
        # Ogni coppia consecutiva e' compatibile, ma nessun mezzo copre tutto.
        chain, trips = chain_of(["12m", "10m", "pollicino"])
        assert trips_vehicle_compatible(trips[0], trips[1]) is True
        assert trips_vehicle_compatible(trips[1], trips[2]) is True
        assert chain_servable_by_single_vehicle(chain, trips) is False

    def test_forced_inchioda_la_linea_al_suo_mezzo(self):
        a = mk_trip(0, "pollicino", forced=True)
        assert trips_vehicle_compatible(a, mk_trip(1, "12m")) is False
        # Anche col lucchetto resta lecito il gradino singolo verso la 10m.
        assert trips_vehicle_compatible(a, mk_trip(1, "10m")) is True


# ═══════════════════════════════════════════════════════════════
#  MEZZO ASSEGNATO AL BLOCCO
# ═══════════════════════════════════════════════════════════════

class TestMezzoDelBlocco:
    def test_blocco_monolinea_non_viene_declassato(self):
        # Regressione: la versione precedente cercava «la taglia minima che
        # serve tutte le corse» e mandava su un 10m un blocco di sole corse 12m.
        for t in ("autosnodato", "12m", "10m", "pollicino"):
            chain, trips = chain_of([t, t, t])
            assert assign_vehicle_type(chain, trips) == t

    def test_blocco_misto_prende_la_taglia_piu_piccola(self):
        # Una corsa della 3 che avanza, infilata in un blocco da 10m.
        chain, trips = chain_of(["12m", "10m"])
        assert assign_vehicle_type(chain, trips) == "10m"

    def test_pollicino_fermo_che_assorbe_la_circolare(self):
        # Il pollicino della 11 si prende qualche corsa da 10m che gli sta vicino.
        chain, trips = chain_of(["pollicino", "pollicino", "10m"])
        assert assign_vehicle_type(chain, trips) == "pollicino"

    def test_snodato_declassato_a_dodici_metri(self):
        chain, trips = chain_of(["autosnodato", "12m"])
        assert assign_vehicle_type(chain, trips) == "12m"

    def test_forced_vince(self):
        chain, trips = chain_of(["pollicino", "10m"], forced_idx={0})
        assert assign_vehicle_type(chain, trips) == "pollicino"

    def test_filobus_mai_come_ripiego(self):
        # filobus e 12m hanno la stessa taglia: il filobus vive solo dove la
        # linea e' elettrificata e non deve spuntare come sostituto di un 12m.
        chain, trips = chain_of(["autosnodato", "12m"])
        assert assign_vehicle_type(chain, trips) == "12m"
        chain, trips = chain_of(["12m", "12m"])
        assert assign_vehicle_type(chain, trips) == "12m"
        # Dichiarato esplicitamente, invece, resta.
        chain, trips = chain_of(["filobus", "filobus"])
        assert assign_vehicle_type(chain, trips) == "filobus"

    def test_catena_vuota_non_esplode(self):
        assert assign_vehicle_type([], []) == "12m"


# ═══════════════════════════════════════════════════════════════
#  FASCE DI PUNTA
# ═══════════════════════════════════════════════════════════════

class TestFascePunta:
    def teardown_method(self):
        set_peak_windows(None)

    def test_default_feriale(self):
        set_peak_windows(None)
        assert get_peak_windows() == DEFAULT_PEAK_WINDOWS
        assert is_peak_hour(8 * 60) is True
        assert is_peak_hour(16 * 60) is False

    def test_festivo_pomeridiano(self):
        set_peak_windows([[15, 20]])
        assert is_peak_hour(8 * 60) is False
        assert is_peak_hour(16 * 60) is True
        assert is_peak_hour(20 * 60) is True

    def test_valori_sballati_ricadono_sul_default(self):
        set_peak_windows([[99, 3], ["x", "y"]])
        assert get_peak_windows() == DEFAULT_PEAK_WINDOWS


# ═══════════════════════════════════════════════════════════════
#  RENDICONTO
# ═══════════════════════════════════════════════════════════════

def mk_shift(vehicle_type: str, corse: list[tuple[str, str, int]]) -> VehicleShift:
    """corse: (nome linea, tipo richiesto dalla linea, minuto di partenza)."""
    vs = VehicleShift(vehicle_id=f"V_{vehicle_type}", vehicle_type=vehicle_type,
                      category="urbano")
    for k, (linea, richiesto, dep) in enumerate(corse):
        down = VEHICLE_SIZE[vehicle_type] < VEHICLE_SIZE[richiesto]
        vs.trips.append(VShiftTrip(
            type="trip", trip_id=f"{linea}_{k}", route_id=f"r_{linea}",
            route_name=linea, headsign="",
            departure_time="", arrival_time="",
            departure_min=dep, arrival_min=dep + 20,
            duration_min=20, downsized=down,
            original_vehicle=richiesto if down else None,
            required_vehicle=richiesto,
        ))
    return vs


class TestRendicontoSagoma:
    def teardown_method(self):
        set_peak_windows(None)

    def test_conta_blocchi_e_declassamenti(self):
        shifts = [
            mk_shift("12m", [("3", "12m", 8 * 60), ("3", "12m", 10 * 60)]),
            mk_shift("10m", [("3", "12m", 10 * 60), ("circolare", "10m", 11 * 60)]),
            mk_shift("pollicino", [("11", "pollicino", 9 * 60)]),
        ]
        rep = build_sagoma_report(shifts, {}, None)
        assert rep["blocchiPerTipo"] == {"12m": 1, "10m": 1, "pollicino": 1}
        assert rep["corse"] == 5
        assert rep["corseDeclassate"] == 1
        assert rep["perLinea"]["3"]["corse"] == 3
        assert rep["perLinea"]["3"]["declassate"] == 1
        assert rep["perLinea"]["11"]["declassate"] == 0

    def test_supera_il_tetto_per_linea(self):
        # 2 corse su 3 declassate: ben oltre il 10%.
        shifts = [mk_shift("10m", [("3", "12m", 8 * 60), ("3", "12m", 9 * 60)]),
                  mk_shift("12m", [("3", "12m", 10 * 60)])]
        rep = build_sagoma_report(shifts, {}, None)
        tipi = {s["tipo"] for s in rep["superamenti"]}
        assert "linea" in tipi

    def test_tetto_piu_severo_in_punta(self):
        set_peak_windows([[15, 20]])
        corse = [("3", "12m", 16 * 60)] + [("3", "12m", 8 * 60 + i) for i in range(19)]
        shifts = [mk_shift("10m", corse[:1]), mk_shift("12m", corse[1:])]
        rep = build_sagoma_report(shifts, {}, None)
        # 1 su 20 = 5% complessivo (nel tetto), ma tutta in punta: 5% = al limite.
        assert rep["corseDeclassateInPunta"] == 1
        assert rep["fascePunta"] == [[15, 20]]

    def test_flotta_per_tipo_insufficiente(self):
        shifts = [mk_shift("pollicino", [("11", "pollicino", 8 * 60)]) for _ in range(4)]
        rep = build_sagoma_report(shifts, {"flotta": {"pollicino": 3}}, None)
        flotta = [s for s in rep["superamenti"] if s["tipo"] == "flotta"]
        assert len(flotta) == 1
        assert flotta[0]["usati"] == 4 and flotta[0]["disponibili"] == 3

    def test_flotta_dai_depositi(self):
        shifts = [mk_shift("pollicino", [("11", "pollicino", 8 * 60)]) for _ in range(2)]
        rep = build_sagoma_report(shifts, {}, [{"fleet": {"pollicino": 3}}])
        assert rep["flottaDisponibile"] == {"pollicino": 3}
        assert [s for s in rep["superamenti"] if s["tipo"] == "flotta"] == []


# ═══════════════════════════════════════════════════════════════
#  CATENE A SCALA: la compatibilita' non e' transitiva
# ═══════════════════════════════════════════════════════════════

from vehicle_scheduler_cpsat import (  # noqa: E402
    enforce_sagoma_chains, canonical_vehicle_type, greedy_warmstart,
    build_compatible_arcs_fast,
)
from optimizer_common import VehicleCostRates  # noqa: E402


class TestCatenaAScala:
    def test_la_scala_viene_spezzata(self):
        # Ogni coppia consecutiva dista un gradino, ma nessun mezzo copre gli
        # estremi: gli archi sono pairwise, quindi il CP-SAT puo' produrla.
        chain, trips = chain_of(["autosnodato", "12m", "10m"])
        assert chain_servable_by_single_vehicle(chain, trips) is False
        pezzi, tagli = enforce_sagoma_chains([chain], trips)
        assert tagli == 1
        assert all(chain_servable_by_single_vehicle(p, trips) for p in pezzi)
        assert sorted(i for p in pezzi for i in p) == chain  # nessuna corsa persa

    def test_catena_legittima_non_viene_toccata(self):
        chain, trips = chain_of(["12m", "12m", "10m"])
        pezzi, tagli = enforce_sagoma_chains([chain], trips)
        assert tagli == 0 and pezzi == [chain]

    def test_forced_incompatibile_spezza(self):
        chain, trips = chain_of(["pollicino", "10m", "12m"], forced_idx={0})
        pezzi, tagli = enforce_sagoma_chains([chain], trips)
        assert tagli >= 1
        assert all(chain_servable_by_single_vehicle(p, trips) for p in pezzi)

    def test_nessuna_corsa_persa_ne_duplicata(self):
        chain, trips = chain_of(["autosnodato", "12m", "10m", "pollicino", "10m", "12m"])
        pezzi, _ = enforce_sagoma_chains([chain], trips)
        piatto = [i for p in pezzi for i in p]
        assert sorted(piatto) == chain and len(piatto) == len(set(piatto))


class TestTipoCanonico:
    def test_mai_filobus_per_ripiego(self):
        assert canonical_vehicle_type(VEHICLE_SIZE["12m"]) == "12m"
        assert canonical_vehicle_type(VEHICLE_SIZE["10m"]) == "10m"
        assert canonical_vehicle_type(VEHICLE_SIZE["pollicino"]) == "pollicino"
        assert canonical_vehicle_type(VEHICLE_SIZE["autosnodato"]) == "autosnodato"

    def test_filobus_solo_se_tutta_la_catena_lo_chiede(self):
        chain, trips = chain_of(["filobus", "filobus"])
        assert assign_vehicle_type(chain, trips) == "filobus"
        # Con dentro una corsa non elettrificata il blocco scende al 12m diesel:
        # un filobus su una linea senza bifilare non ci puo' circolare.
        chain, trips = chain_of(["filobus", "filobus", "12m"])
        assert assign_vehicle_type(chain, trips) == "12m"


class TestGreedyFinestraTaglie:
    def _greedy(self, requireds, forced_idx=None):
        _, trips = chain_of(requireds, forced_idx)
        rates = VehicleCostRates()
        arcs = build_compatible_arcs_fast(trips, rates, None)
        lookup = {(a.i, a.j): a for a in arcs}
        return greedy_warmstart(trips, arcs, lookup, rates), trips

    def test_non_congela_il_mezzo_sulla_prima_corsa(self):
        # Aprendo su una 12m e fissando li' il tipo, la 10m veniva rifiutata e
        # nasceva un secondo veicolo: un solo 10m le copre entrambe.
        catene, trips = self._greedy(["12m", "10m"])
        assert len(catene) == 1
        assert assign_vehicle_type(catene[0], trips) == "10m"

    def test_due_gradini_restano_separati(self):
        catene, _ = self._greedy(["12m", "pollicino"])
        assert len(catene) == 2

    def test_le_catene_del_greedy_sono_sempre_servibili(self):
        for reqs in (["autosnodato", "12m", "10m"],
                     ["pollicino", "10m", "12m"],
                     ["10m", "12m", "autosnodato", "10m"]):
            catene, trips = self._greedy(reqs)
            for c in catene:
                assert chain_servable_by_single_vehicle(c, trips), f"{reqs} -> {c}"


class TestDenominatoreDellaPunta:
    def teardown_method(self):
        set_peak_windows(None)

    def test_la_punta_si_misura_sulle_corse_in_punta(self):
        set_peak_windows([[15, 20]])
        # 5 corse in punta, tutte declassate; 95 fuori punta, nessuna.
        punta = [("3", "12m", 16 * 60 + i) for i in range(5)]
        morbida = [("3", "12m", 8 * 60 + i) for i in range(95)]
        rep = build_sagoma_report([mk_shift("10m", punta), mk_shift("12m", morbida)], {}, None)
        row = rep["perLinea"]["3"]
        assert row["corsePunta"] == 5 and row["declassatePunta"] == 5
        # 5/100 sul giorno intero passerebbe nel tetto: sulla punta e' il 100%.
        assert row["pctPunta"] == 100.0
        assert any(s["tipo"] == "lineaPunta" for s in rep["superamenti"])


# ═══════════════════════════════════════════════════════════════
#  COMPORTAMENTO END-TO-END: declassare solo se toglie un mezzo
# ═══════════════════════════════════════════════════════════════

import vehicle_scheduler_cpsat as _v  # noqa: E402


def _run(piano: list[tuple[str, str, list[int]]], config: dict | None = None) -> dict:
    trips = []
    for nome, tipo, partenze in piano:
        for k, dep in enumerate(partenze):
            trips.append({
                "tripId": f"{nome}-{k}", "routeId": f"R_{nome}", "routeName": nome,
                "headsign": "cap", "directionId": 0,
                "departureTime": f"{dep // 60:02d}:{dep % 60:02d}:00",
                "arrivalTime": f"{(dep + 40) // 60:02d}:{(dep + 40) % 60:02d}:00",
                "departureMin": dep, "arrivalMin": dep + 40,
                "firstStopId": "CAVOUR", "lastStopId": "CAVOUR",
                "firstStopLat": 43.616, "firstStopLon": 13.518,
                "lastStopLat": 43.616, "lastStopLon": 13.518,
                "firstStopName": "Piazza Cavour", "lastStopName": "Piazza Cavour",
                "stopCount": 12, "requiredVehicle": tipo,
                "category": "urbano", "forced": False,
            })
    return _v.run({"trips": trips, "config": {"solverTimeLimit": 10, **(config or {})}})


class TestComportamentoDelPiano:
    def test_declassa_quando_risparmia_un_mezzo(self):
        # La circolare tiene un 10m tutto il giorno con buchi di 80'; la linea 3
        # ha due corse isolate che ci cadono dentro. Assorbirle costa un gradino,
        # non assorbirle costa un mezzo intero: si assorbe.
        out = _run([("circolare", "10m", [7 * 60, 9 * 60, 11 * 60, 13 * 60]),
                    ("3", "12m", [8 * 60, 10 * 60])])
        sg = out["metrics"]["sagoma"]
        assert len(out["vehicleShifts"]) == 1
        assert sg["perLinea"]["3"]["declassate"] == 2
        # e il superamento del tetto viene comunque riportato all'operatore
        assert any(s["tipo"] == "linea" for s in sg["superamenti"])

    def test_non_declassa_quando_non_serve(self):
        # Quattro linee che si sovrappongono: servono comunque quattro mezzi,
        # quindi non c'e' nessun motivo di mettere qualcuno su un mezzo ridotto.
        base = [7 * 60 + k * 70 for k in range(5)]
        out = _run([("11", "pollicino", base), ("circolare", "10m", base),
                    ("3", "12m", base), ("1/4", "autosnodato", base)])
        sg = out["metrics"]["sagoma"]
        assert sg["corseDeclassate"] == 0
        assert sg["superamenti"] == []
        for linea, row in sg["perLinea"].items():
            assert list(row["tipiUsati"]) == [row["richiesto"]], f"{linea}: {row['tipiUsati']}"

    def test_nessun_mezzo_fuori_sagoma_ne_doppio_declassamento(self):
        base = [7 * 60 + k * 55 for k in range(6)]
        out = _run([("11", "pollicino", base), ("circolare", "10m", base),
                    ("3", "12m", base), ("1/4", "autosnodato", base)])
        for s in out["vehicleShifts"]:
            vs = VEHICLE_SIZE[s["vehicleType"]]
            for t in s["trips"]:
                if t.get("type") != "trip" or not t.get("requiredVehicle"):
                    continue
                rs = VEHICLE_SIZE[t["requiredVehicle"]]
                assert vs <= rs, f"{s['vehicleId']} ({s['vehicleType']}) su {t['requiredVehicle']}"
                assert rs - vs <= 1, f"doppio declassamento su {t['tripId']}"
