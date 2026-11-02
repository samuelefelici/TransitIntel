"""Il budget di tempo e lo stop ordinato di crew_scheduler_v4.

La revisione della PR 2.5 (coda dei lavori, #583) ha misurato due difetti:

- il budget (argv[1]) non era rispettato sulle reti grandi: 250 turni
  macchina con budget 90 s finivano dopo 32 minuti. Gli scenari UNKNOWN
  saltavano il controllo del tempo, i ripieghi PCT-CAP e CAR-CAP ripartivano
  con il budget intero anche a tempo finito, e ogni segmentazione aveva i suoi
  minimi (20 s, 15 s di rifinitura) oltre il budget;
- il SIGINT non fermava lo script: CP-SAT lo intercettava durante il solve
  (e dopo il solve rimetteva SIGINT al default), quindi lo stop dell'utente e
  il tempo massimo del lanciatore (SIGINT, poi SIGKILL dopo 5 s) uccidevano il
  calcolo senza risultato.

Qui si verifica che il budget sia una scadenza unica e che il SIGINT chiuda lo
script entro 5 s con un JSON valido.
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

CARTELLA_SCRIPT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ═══════════════════════════════════════════════════════════════
#  LA RETE SINTETICA
# ═══════════════════════════════════════════════════════════════

_CLUSTER = [
    {"id": "c_cav", "name": "PIAZZA CAVOUR", "keywords": ["CAVOUR"], "stopNames": ["Piazza Cavour"], "transferFromDepotMin": 10},
    {"id": "c_tav", "name": "TAVERNELLE", "keywords": ["TAVERNELLE"], "stopNames": ["Tavernelle"], "transferFromDepotMin": 15},
    {"id": "c_pos", "name": "POSATORA", "keywords": ["POSATORA"], "stopNames": ["Posatora"], "transferFromDepotMin": 15},
    {"id": "c_fs", "name": "STAZIONE FS", "keywords": ["STAZIONE"], "stopNames": ["Stazione FS"], "transferFromDepotMin": 12},
]
# (linea, capolinea A, capolinea B, minuti di corsa)
_LINEE = [
    ("1", "Piazza Cavour", "Tavernelle", 30),
    ("2", "Piazza Cavour", "Posatora", 25),
    ("3", "Tavernelle", "Stazione FS", 35),
    ("4", "Posatora", "Stazione FS", 28),
    ("5", "Piazza Cavour", "Stazione FS", 22),
]


def _hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def rete_sintetica(n_turni: int, seme: int = 7) -> dict:
    """`n_turni` turni macchina deterministici su cinque linee fra quattro
    capolinea (tutti cluster): circa metà lunghi (tutta la giornata, da
    tagliare in tre), un terzo medi, il resto corti. È la forma delle reti su
    cui il portfolio CP-SAT diventa lento: molti segmenti, molte coppie."""
    rng = random.Random(seme)
    turni = []
    for v in range(n_turni):
        linea, a, b, durata_corsa = _LINEE[v % len(_LINEE)]
        r = rng.random()
        if r < 0.45:
            inizio, nastro = rng.randint(330, 420), rng.randint(780, 1000)
        elif r < 0.78:
            inizio, nastro = rng.randint(330, 720), rng.randint(360, 540)
        else:
            inizio, nastro = rng.randint(400, 1000), rng.randint(150, 300)
        fine = min(inizio + nastro, 1430)
        vid = f"S{v:03d}"
        corse = [{"type": "deadhead", "depotLeg": "out", "deadheadMin": 10, "deadheadKm": 4.0,
                  "departureMin": inizio - 10, "arrivalMin": inizio,
                  "firstStopName": "Deposito", "lastStopName": a}]
        t, k, da, verso = inizio, 0, a, b
        while t + durata_corsa <= fine:
            corse.append({"type": "trip", "tripId": f"{vid}t{k}", "routeId": f"L{linea}", "routeName": linea,
                          "departureTime": _hhmm(t), "arrivalTime": _hhmm(t + durata_corsa),
                          "departureMin": t, "arrivalMin": t + durata_corsa,
                          "firstStopName": da, "lastStopName": verso, "stopCount": 10,
                          "durationMin": durata_corsa, "directionId": k % 2})
            t += durata_corsa + rng.randint(5, 15)
            da, verso = verso, da
            k += 1
        ultimo = corse[-1]["lastStopName"]
        arrivo = corse[-1]["arrivalMin"]
        corse.append({"type": "deadhead", "depotLeg": "in", "deadheadMin": 10, "deadheadKm": 4.0,
                      "departureMin": arrivo, "arrivalMin": arrivo + 10,
                      "firstStopName": ultimo, "lastStopName": "Deposito"})
        turni.append({"vehicleId": vid, "vehicleType": "12m", "category": "urbano", "trips": corse})
    return {"vehicleShifts": turni, "config": {"clusters": [dict(c) for c in _CLUSTER]}}


# ═══════════════════════════════════════════════════════════════
#  IL BUDGET È UNA SCADENZA UNICA
# ═══════════════════════════════════════════════════════════════

import json  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

import pytest  # noqa: E402
from ortools.sat.python import cp_model  # noqa: E402

import crew_scheduler_v4 as v4  # noqa: E402


def test_molti_scenari_unknown_restano_nel_budget(monkeypatch, capsys):
    """Ogni solve costa 0,4 s e finisce UNKNOWN, come gli scenari delle reti
    grandi (6-15 s l'uno). Prima della correzione il controllo del tempo
    saltava gli UNKNOWN: 24 scenari, per i ripieghi PCT-CAP e CAR-CAP, per
    ogni segmentazione in gara, cioè più di due minuti. Ora il calcolo resta
    in un multiplo piccolo del budget, senza ripieghi a tempo finito, e la
    soluzione la dà il greedy."""
    chiamate = []

    def solve_lento(solver, model):
        chiamate.append(solver.parameters.max_time_in_seconds)
        time.sleep(0.4)
        return cp_model.UNKNOWN

    monkeypatch.setattr(v4, "_risolvi", solve_lento)
    budget = 3
    t0 = time.monotonic()
    out = v4.run(rete_sintetica(10), time_limit_sec=budget)
    durata = time.monotonic() - t0
    log = capsys.readouterr().err

    assert durata < 3 * budget, f"{durata:.1f}s per un budget di {budget}s ({len(chiamate)} solve)"
    assert out["driverShifts"], "il greedy deve comunque dare i turni"
    assert out["interrupted"] is False
    assert "fallback a greedy" in log
    # a budget finito i ripieghi non ripartono: dritti al greedy
    assert "[V4][PCT-CAP]" not in log and "[V4][CAR-CAP]" not in log
    assert "[V4][RIPIEGO]" in log
    # nessun solve ha chiesto più del tempo che restava (a parte il minimo
    # garantito al primo scenario della prima segmentazione)
    assert max(chiamate[1:] or [0]) <= budget


def test_infeasible_dimostrato_passa_subito_al_ripiego(monkeypatch, capsys):
    """Gli scenari cambiano solo l'obiettivo: un INFEASIBLE dimostrato vale
    per tutti, quindi si passa subito al ripiego invece di provare gli altri
    23 scenari. E con il tempo a disposizione il ripiego PCT-CAP parte
    ancora: la scadenza non spegne i ripieghi quando il tempo c'è."""
    vero = v4._risolvi
    chiamate = {"n": 0}

    def primo_infattibile(solver, model):
        chiamate["n"] += 1
        if chiamate["n"] == 1:
            return cp_model.INFEASIBLE
        return vero(solver, model)

    monkeypatch.setattr(v4, "_risolvi", primo_infattibile)
    raw = rete_sintetica(8)
    raw["config"]["bds"] = {"scenari": {"count": 4}}
    out = v4.run(raw, time_limit_sec=30)
    log = capsys.readouterr().err

    assert "INFEASIBLE vale per tutti gli scenari" in log
    assert log.count("[V4][PCT-CAP]") == 1, "il ripiego deve partire, il tempo c'è"
    assert "fallback a greedy" not in log, "con il tempo a disposizione la soluzione è di CP-SAT"
    assert out["driverShifts"]
    # nella prima chiamata un solo scenario: l'INFEASIBLE ha fermato il loop
    primo = log.split("[V4][PCT-CAP]")[0]
    assert primo.count("  Scenario ") == 1, primo[-2000:]


# ═══════════════════════════════════════════════════════════════
#  IL SIGINT CHIUDE LO SCRIPT CON UN JSON VALIDO
# ═══════════════════════════════════════════════════════════════

def test_sigint_a_meta_calcolo_chiude_entro_5s_con_json_valido():
    """Come il lanciatore dell'API (lib/lavori/python.ts): JSON su stdin,
    SIGINT a metà del portfolio CP-SAT, poi SIGKILL dopo 5 s. Lo script deve
    uscire prima, con codice 0 e un JSON valido, dichiarato `interrupted`.
    Prima CP-SAT si teneva il SIGINT: lo script andava avanti per minuti."""
    raw = rete_sintetica(60)
    p = subprocess.Popen(
        [sys.executable, "crew_scheduler_v4.py", "600"],
        cwd=CARTELLA_SCRIPT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    righe: list[str] = []
    a_meta = threading.Event()

    def leggi_stderr():
        for r in p.stderr:
            riga = r.decode("utf-8", "replace")
            righe.append(riga)
            # dentro il portfolio: il primo scenario è finito, il secondo parte
            if riga.startswith("PROGRESS|optimize|") and "Scenario 2/" in riga:
                a_meta.set()

    uscita: list[bytes] = []

    def leggi_stdout():
        uscita.append(p.stdout.read())

    lettori = [threading.Thread(target=f, daemon=True) for f in (leggi_stderr, leggi_stdout)]
    for t in lettori:
        t.start()
    try:
        p.stdin.write(json.dumps(raw).encode("utf-8"))
        p.stdin.close()
        assert a_meta.wait(120), "il portfolio non è partito:\n" + "".join(righe[-30:])
        time.sleep(1.0)  # dentro il solve del secondo scenario
        assert p.poll() is None, "lo script è finito prima del SIGINT: la rete di prova è troppo facile"
        t_sigint = time.monotonic()
        p.send_signal(signal.SIGINT)
        try:
            p.wait(timeout=5)   # poi il lanciatore manderebbe SIGKILL
        except subprocess.TimeoutExpired:
            pytest.fail("lo script non è uscito entro 5 s dal SIGINT:\n" + "".join(righe[-30:]))
        durata = time.monotonic() - t_sigint
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
    for t in lettori:
        t.join(5)

    assert durata < 5, f"uscito {durata:.1f}s dopo il SIGINT"
    assert p.returncode == 0, "".join(righe[-30:])
    out = json.loads(uscita[0])
    assert out["interrupted"] is True
    assert out["driverShifts"], "la soluzione migliore trovata (o il greedy) deve esserci"
    assert any("SIGINT received" in r for r in righe)
