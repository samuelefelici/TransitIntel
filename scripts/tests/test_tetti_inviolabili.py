"""Nastro e lavoro non si sforano mai.

Fino al giro BB il tetto era morbido in due punti, e i due difetti si
coprivano a vicenda:

- la scelta dei tagli SCONTAVA lo sforamento del nastro dal punteggio
  (`score -= max(0, worst - max_nastro) * 2`), cosi' un taglio che sforava di
  6' pagava 12 punti e vinceva lo stesso;
- la validazione ammetteva una franchigia di 15' sugli interi e 5' sugli
  altri, cosi' il pezzo fuori norma che ne usciva risultava regolare.

Il giro BB ha prodotto A001 con 441' di lavoro contro un tetto di 435, e ha
dichiarato zero violazioni. Qui si verifica che non possa piu' succedere.

Le norme (nastro / lavoro / interruzione):
  intero     435 / 435 / nessuna
  semiunico  555 / 480 / almeno 75'  non retribuita
  spezzato   630 / 450 / almeno 180' non retribuita
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_scheduler_v4 as v4  # noqa: E402
from crew_scheduler_v4 import BDSConfig  # noqa: E402
from optimizer_common import Cluster, DriverDutyV3, Segment  # noqa: E402

CLUSTERS = [Cluster(id="c_cav", name="PIAZZA CAVOUR", keywords=["CAVOUR"],
                    transfer_from_depot_min=10, stop_names=["PIAZZA CAVOUR"])]
BDS = BDSConfig()


def _seg(start, end, veh="U1"):
    return Segment(idx=start, vehicle_id=veh, vehicle_type="12m", trips=[],
                   start_min=start, end_min=end, work_min=end - start,
                   driving_min=end - start, first_stop="PIAZZA CAVOUR",
                   last_stop="PIAZZA CAVOUR", first_cluster="c_cav", last_cluster="c_cav",
                   half="full", cut_index=None)


def _duty(tipo, nastro, lavoro, interruzione=0, segs=1):
    pezzi = ([_seg(360, 360 + nastro)] if segs == 1
             else [_seg(360, 360 + nastro // 2), _seg(360 + nastro // 2 + interruzione,
                                                      360 + nastro, "U2")])
    return DriverDutyV3(idx=0, driver_id="A001", duty_type=tipo, segments=pezzi,
                        nastro_start=360, nastro_end=360 + nastro, nastro_min=nastro,
                        work_min=lavoro, driving_min=min(lavoro, 240),
                        interruption_min=interruzione, pre_turno_min=12, transfer_min=10)


# ═══════════════════════════════════════════════════════════════
#  LA VALIDAZIONE NON PERDONA PIU'
# ═══════════════════════════════════════════════════════════════

def test_a001_del_giro_bb_e_una_violazione():
    """441' di lavoro su un tetto di 435: sei minuti sono una violazione."""
    d = _duty("intero", nastro=441, lavoro=441)
    res = v4.validate_duty_bds(d, BDS, CLUSTERS)
    assert not res.lavoro_ok, "441' di lavoro contro 435 devono essere una violazione"
    assert not res.nastro_ok, "441' di nastro contro 435 devono essere una violazione"
    assert any("441" in v and "435" in v for v in res.violations)
    # e la franchigia non deve comparire nel messaggio
    assert not any("+15" in v or "+5" in v for v in res.violations)


def test_il_turno_al_tetto_esatto_e_regolare():
    """435 esatti stanno dentro: il vincolo e' <=, non <."""
    res = v4.validate_duty_bds(_duty("intero", nastro=435, lavoro=435), BDS, CLUSTERS)
    assert res.nastro_ok and res.lavoro_ok
    assert not [v for v in res.violations if "nastro" in v or "lavoro" in v]


def test_ogni_tipo_ha_il_suo_tetto_e_nessuno_lo_sfora():
    casi = [("intero", 435, 435, 0), ("semiunico", 555, 480, 90), ("spezzato", 630, 450, 200)]
    for tipo, max_nastro, max_lavoro, interr in casi:
        dentro = _duty(tipo, max_nastro, max_lavoro, interr, segs=1 if interr == 0 else 2)
        res = v4.validate_duty_bds(dentro, BDS, CLUSTERS)
        assert res.nastro_ok and res.lavoro_ok, f"{tipo} al tetto esatto deve passare: {res.violations}"

        for sfora_di in (1, 5, 15):
            fuori = _duty(tipo, max_nastro, max_lavoro + sfora_di, interr, segs=1 if interr == 0 else 2)
            res = v4.validate_duty_bds(fuori, BDS, CLUSTERS)
            assert not res.lavoro_ok, (
                f"{tipo} con {max_lavoro + sfora_di}' di lavoro (tetto {max_lavoro}) "
                f"deve essere una violazione, anche per un minuto solo")


# ═══════════════════════════════════════════════════════════════
#  IL CLASSIFICATORE NON RIPESCA PIU'
# ═══════════════════════════════════════════════════════════════

def test_fuori_tetto_vuol_dire_invalido():
    """Il ripescaggio con franchigia non esiste piu': classificatore e
    validazione guardano lo stesso numero."""
    assert v4.classify_duty(_duty("intero", 435, 435), BDS, CLUSTERS) == "intero"
    assert v4.classify_duty(_duty("intero", 441, 441), BDS, CLUSTERS) == "invalido"
    assert v4.classify_duty(_duty("intero", 445, 445), BDS, CLUSTERS) == "invalido"
    # semiunico: 555/480 con interruzione nella finestra
    assert v4.classify_duty(_duty("semiunico", 555, 480, 90, segs=2), BDS, CLUSTERS) == "semiunico"
    assert v4.classify_duty(_duty("semiunico", 558, 480, 90, segs=2), BDS, CLUSTERS) == "invalido"
    assert v4.classify_duty(_duty("semiunico", 555, 483, 90, segs=2), BDS, CLUSTERS) == "invalido"


def test_classificatore_e_validazione_dicono_la_stessa_cosa():
    """Il motivo per cui la franchigia era stata messa: i due non coincidevano.
    Ora coincidono perche' nessuno dei due perdona."""
    for nastro, lavoro in [(430, 430), (435, 435), (436, 436), (441, 441), (450, 450)]:
        d = _duty("intero", nastro, lavoro)
        tipo = v4.classify_duty(d, BDS, CLUSTERS)
        res = v4.validate_duty_bds(d, BDS, CLUSTERS)
        dentro = nastro <= 435 and lavoro <= 435
        assert (tipo == "intero") == dentro, f"classificatore incoerente a {nastro}/{lavoro}"
        assert (res.nastro_ok and res.lavoro_ok) == dentro, f"validazione incoerente a {nastro}/{lavoro}"


# ═══════════════════════════════════════════════════════════════
#  I TAGLI NON PRODUCONO PIU' PEZZI FUORI NORMA
# ═══════════════════════════════════════════════════════════════

def _hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def _corsa(k, t0, t1, a, b):
    return {"type": "trip", "tripId": f"t{k}", "routeId": "L3", "routeName": "3",
            "departureTime": _hhmm(t0), "arrivalTime": _hhmm(t1),
            "departureMin": t0, "arrivalMin": t1, "firstStopName": a, "lastStopName": b,
            "stopCount": 12, "durationMin": t1 - t0, "directionId": k % 2}


def _blocco_lungo():
    """Un blocco da 06:00 a 22:20 (980' di nastro) sulla stessa coppia di
    capolinea: e' il caso di U001 nel giro BB, quello che aveva prodotto il
    pezzo da 441'. Con tre pezzi ognuno deve stare nei 435."""
    CAV, UB = "PIAZZA CAVOUR", "PIAZZA UGO BASSI"
    trips = [{"type": "deadhead", "depotLeg": "out", "deadheadMin": 10, "deadheadKm": 3.0,
              "departureMin": 350, "arrivalMin": 360, "firstStopName": "Deposito", "lastStopName": CAV}]
    t, k = 360, 0
    while t + 45 <= 1330:                       # fino alle 22:10
        a, b = (CAV, UB) if k % 2 == 0 else (UB, CAV)
        trips.append(_corsa(k, t, t + 40, a, b))
        t += 45
        k += 1
    trips.append({"type": "deadhead", "depotLeg": "in", "deadheadMin": 10, "deadheadKm": 3.0,
                  "departureMin": t, "arrivalMin": t + 10,
                  "firstStopName": trips[-1]["lastStopName"], "lastStopName": "Deposito"})
    b = v4.parse_vehicle_blocks(
        [{"vehicleId": "U001", "vehicleType": "12m", "category": "urbano", "trips": trips}],
        CLUSTERS_DUE)[0]
    return b


CLUSTERS_DUE = [
    Cluster(id="c_cav", name="PIAZZA CAVOUR", keywords=["CAVOUR"],
            transfer_from_depot_min=10, stop_names=["PIAZZA CAVOUR"]),
    Cluster(id="c_ub", name="PIAZZA UGO BASSI", keywords=["UGO BASSI"],
            transfer_from_depot_min=10, stop_names=["PIAZZA UGO BASSI"]),
]


def test_i_nastri_dei_pezzi_si_contano_tutti_bordi_compresi():
    """Il lettore unico: N tagli danno N+1 pezzi, e il primo e l'ultimo
    portano il trasferimento da e per il deposito."""
    b = _blocco_lungo()
    v4.analyze_vehicle_block(b, CLUSTERS_DUE, BDS)
    v4.classify_blocks([b], CLUSTERS_DUE)
    cands = b.cut_candidates
    assert len(cands) >= 2, "il blocco di prova deve offrire almeno due tagli"
    uno = v4._nastri_dei_pezzi(b, [cands[len(cands) // 2]], CLUSTERS_DUE)
    assert len(uno) == 2 and all(n > 0 for n in uno)
    due = v4._nastri_dei_pezzi(b, [cands[len(cands) // 3], cands[2 * len(cands) // 3]], CLUSTERS_DUE)
    assert len(due) == 3 and all(n > 0 for n in due)
    # i pezzi coprono la giornata: la somma dei nastri non e' minore del nastro
    # del blocco (i trasferimenti di bordo la fanno crescere, mai calare)
    assert sum(due) >= b.nastro_min


def test_nessun_pezzo_esce_dai_435_dopo_il_taglio():
    """L'invariante che il giro BB violava: il blocco viene tagliato in modo
    che OGNI pezzo stia nel nastro dell'intero. Prima lo sforamento era uno
    sconto sul punteggio, e un pezzo da 441' vinceva pagando 12 punti."""
    b = _blocco_lungo()
    v4.analyze_vehicle_block(b, CLUSTERS_DUE, BDS)
    v4.classify_blocks([b], CLUSTERS_DUE)
    assert b.classification == "LUNGO", f"il blocco di prova deve essere LUNGO, e' {b.classification}"
    v4.build_initial_segments([b], CLUSTERS_DUE)
    assert len(b.segments) >= 3, "un blocco da oltre 9h15 vuole almeno tre pezzi"
    tetto = v4.SHIFT_RULES["intero"]["maxNastro"]
    fuori = [(s.start_min, s.end_min, s.end_min - s.start_min)
             for s in b.segments if s.end_min - s.start_min > tetto]
    assert not fuori, f"pezzi oltre il nastro di {tetto}′: {fuori}"


def test_la_terna_di_tagli_scarta_chi_sfora_il_nastro():
    """`_best_three_cuts` con un tetto di nastro non restituisce mai una terna
    fuori norma: il vincolo filtra, non sconta."""
    b = _blocco_lungo()
    v4.analyze_vehicle_block(b, CLUSTERS_DUE, BDS)
    v4.classify_blocks([b], CLUSTERS_DUE)
    tetto = v4.SHIFT_RULES["intero"]["maxNastro"]
    trio = v4._best_three_cuts(b, CLUSTERS_DUE, max_guida=0, min_piece_work=60, max_nastro=tetto)
    if trio is not None:
        nastri = v4._nastri_dei_pezzi(b, trio, CLUSTERS_DUE)
        assert max(nastri) <= tetto, f"terna fuori norma: {nastri}"
    # con un tetto assurdamente basso nessuna terna puo' rientrare
    assert v4._best_three_cuts(b, CLUSTERS_DUE, max_guida=0, min_piece_work=60, max_nastro=30) is None


def test_il_nastro_viene_prima_del_punteggio():
    """La regola che il giro BB non aveva.

    Prima: `score -= max(0, worst - max_nastro) * 2`. Un taglio che sforava di
    6 minuti pagava 12 punti; se il suo punteggio era piu' alto di 12, vinceva
    lo stesso — ed e' esattamente cosi' che e' nato A001 con 441'.
    Ora nessun punteggio, per quanto alto, compra un minuto di nastro."""
    T = 435
    dentro_scarso = v4.rango_dei_tagli(worst_nastro=430, max_nastro=T, score=10.0)
    fuori_ottimo = v4.rango_dei_tagli(worst_nastro=441, max_nastro=T, score=10_000.0)
    assert dentro_scarso < fuori_ottimo, (
        "un taglio dentro il tetto deve battere uno fuori, qualunque sia il punteggio")

    # col vecchio criterio il fuori-tetto vinceva: lo si vede rifacendo il conto
    vecchio_dentro = 10.0
    vecchio_fuori = 10_000.0 - max(0, 441 - T) * 2
    assert vecchio_fuori > vecchio_dentro, "controprova: col vecchio sconto vinceva il fuori-tetto"

    # fra due che sforano, vince il meno fuori anche se ha punteggio peggiore
    poco_fuori = v4.rango_dei_tagli(worst_nastro=437, max_nastro=T, score=0.0)
    molto_fuori = v4.rango_dei_tagli(worst_nastro=470, max_nastro=T, score=9_999.0)
    assert poco_fuori < molto_fuori

    # al tetto esatto si e' dentro
    assert v4.rango_dei_tagli(435, T, 1.0) < v4.rango_dei_tagli(436, T, 1.0)
    assert v4.rango_dei_tagli(435, T, 1.0)[0] == 0

    # a parita' di nastro decide il punteggio, come prima
    assert v4.rango_dei_tagli(400, T, 50.0) < v4.rango_dei_tagli(400, T, 10.0)


# ═══════════════════════════════════════════════════════════════
#  LA PAUSA DI 15' SI CERCA, NON SI IMPONE
# ═══════════════════════════════════════════════════════════════

def test_la_sosta_di_quindici_minuti_e_un_avvertimento():
    """Il gestore la dichiara violabile: va fra gli avvertimenti, come la
    pausa pasto. Le violazioni restano nastro, lavoro, interruzione e la
    guida continuativa del RD 131."""
    d = _duty("intero", nastro=400, lavoro=400)   # un solo pezzo, nessuna sosta dentro
    res = v4.validate_duty_bds(d, BDS, CLUSTERS)
    assert not res.sosta_capolinea_ok, "il turno di prova non ha soste: l'esito deve dirlo"
    assert any("sosta" in w for w in res.warnings), "la sosta mancante va negli avvertimenti"
    assert not any("sosta" in v for v in res.violations), "la sosta mancante non e' una violazione"
    # e il turno resta regolare su cio' che conta
    assert res.nastro_ok and res.lavoro_ok


def test_i_tetti_restano_violazioni_anche_senza_la_sosta():
    """Declassare la sosta non deve ammorbidire nient'altro."""
    d = _duty("intero", nastro=441, lavoro=441)
    res = v4.validate_duty_bds(d, BDS, CLUSTERS)
    assert not res.nastro_ok and not res.lavoro_ok
    assert any(v.startswith("nastro 441min") for v in res.violations)
    assert any(v.startswith("lavoro 441min") for v in res.violations)
    assert not any("sosta" in v for v in res.violations)
