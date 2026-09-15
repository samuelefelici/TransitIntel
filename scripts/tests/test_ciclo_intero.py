"""Il ciclo intero, con i solver finti: l'ordine, il seme e la via di fuga.

I pezzi presi uno per uno sono coperti dagli altri test. Qui si guida
`vcsp_orchestrator.main()` da capo a fondo con un VSP e un CSP finti, perche'
tre cose si possono sbagliare solo nel MONTAGGIO e nessun test di unita' le
vedrebbe:

1. L'ORDINE. Al round r il seme deve venire dal campione dei round PRECEDENTI
   (best non include ancora il round r), e il feedback deve essere calcolato
   DOPO che il round r ha avuto la sua occasione di diventare campione. Se i
   due momenti si invertono, il giro insegue se stesso.
2. IL SEME arriva davvero al VSP, e non al round 1 (che non ha un campione).
3. LA VIA DI FUGA. Con penaltyStep=1, penaltyAnchor="last" e
   seedFromBest=false il ciclo deve comportarsi ESATTAMENTE come prima della
   modifica: nessun seme nel payload, penalita' sostituite di netto, feedback
   sull'ultimo round. E' la rete di sicurezza dell'operatore, e va provata.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import optimizer_common  # noqa: E402
import vcsp_orchestrator as orch  # noqa: E402


class _Motori:
    """VSP e CSP finti. Il VSP restituisce, round per round, i piani scritti
    nel copione; registra i payload ricevuti."""

    def __init__(self, copione):
        self.copione = copione
        self.payload_visti = []
        self.chiamate = 0

    def vsp(self, payload):
        self.payload_visti.append(payload)
        piano = self.copione[min(self.chiamate, len(self.copione) - 1)]
        self.chiamate += 1
        vetture, ombra, blocchi = piano
        return {
            "vehicleShifts": blocchi,
            "metrics": {"vehicles": vetture, "costEur": 1000.0 * vetture + ombra},
            "costBreakdown": {"aggregated": {"total": 1000.0 * vetture + ombra,
                                             "vcspPenalty": ombra}},
        }

    def csp(self, payload, time_limit):
        return {"summary": {"totalShifts": 40, "totalDailyCost": 5000.0,
                            "totalSupplementi": 0,
                            "validation": {"totalViolations": 0},
                            "handoverModes": {"unattendedLimitMin": 15, "overLimit": []},
                            "companyCarsCap": 5, "companyCarsMaxSimultaneous": 1,
                            "companyCarsConflicts": 0},
                "driverShifts": [], "handovers": [], "metrics": {}, "clusters": []}


def _blocchi(*gruppi):
    return [{"vehicleId": f"U{i:03d}",
             "trips": [{"type": "trip", "tripId": t, "departureMin": 480 + 30 * k,
                        "arrivalMin": 500 + 30 * k} for k, t in enumerate(g)],
             "totalServiceMin": 120}
            for i, g in enumerate(gruppi, start=1)]


def _giro(copione, vcsp_cfg, monkeypatch):
    motori = _Motori(copione)
    uscita = {}
    monkeypatch.setattr(orch.vsp_engine, "run", motori.vsp)
    monkeypatch.setattr(orch.csp_engine, "run", motori.csp)
    monkeypatch.setattr(orch, "load_input", lambda: {
        "vsp": {"trips": [{"tripId": "t1", "departureMin": 480, "arrivalMin": 500},
                          {"tripId": "t2", "departureMin": 540, "arrivalMin": 560},
                          {"tripId": "t3", "departureMin": 600, "arrivalMin": 620}],
                "config": {}},
        "crew": {"config": {}},
        "vcsp": {**vcsp_cfg, "probes": 0},
    })
    monkeypatch.setattr(orch, "write_output", lambda d: uscita.update(d))
    monkeypatch.setattr(optimizer_common, "report_progress", lambda *a, **k: None)
    orch.main()
    return motori, uscita


# ── l'ordine e il seme ───────────────────────────────────────────────────

def test_il_primo_round_non_ha_un_campione_da_cui_ripartire(monkeypatch):
    copione = [(3, 0.0, _blocchi(["t1"], ["t2"], ["t3"]))]
    motori, _ = _giro(copione, {"rounds": 1}, monkeypatch)
    assert "warmStartChains" not in motori.payload_visti[0]


def test_dal_secondo_round_il_seme_e_il_piano_del_campione(monkeypatch):
    # round 1: 3 vetture; round 2: 2 vetture (diventa campione); round 3: 4.
    copione = [
        (3, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
        (2, 0.0, _blocchi(["t1", "t2"], ["t3"])),
        (4, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
    ]
    motori, uscita = _giro(copione, {"rounds": 3}, monkeypatch)
    assert len(motori.payload_visti) == 3
    # il round 2 riparte dal round 1 (l'unico campione possibile)
    assert motori.payload_visti[1]["warmStartChains"] == [["t1"], ["t2"], ["t3"]]
    # il round 3 riparte dal round 2, che nel frattempo e' diventato campione:
    # la prova che best e' aggiornato PRIMA del payload successivo
    assert motori.payload_visti[2]["warmStartChains"] == [["t1", "t2"], ["t3"]]
    assert uscita["vcsp"]["bestRound"] == 2


def test_il_seme_non_segue_un_round_peggiore(monkeypatch):
    """Il round 3 e' il peggiore della serie: il round successivo deve
    ripartire dal campione, non da lui."""
    copione = [
        (2, 0.0, _blocchi(["t1", "t2"], ["t3"])),
        (3, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
        (9, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
        (3, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
    ]
    motori, uscita = _giro(copione, {"rounds": 4, "earlyStopPatience": 9}, monkeypatch)
    for payload in motori.payload_visti[1:]:
        assert payload["warmStartChains"] == [["t1", "t2"], ["t3"]]
    assert uscita["vcsp"]["bestRound"] == 1


# ── la moneta onesta, dentro il giro ─────────────────────────────────────

def test_il_round_che_ha_ricevuto_piu_segnale_non_sembra_piu_caro(monkeypatch):
    """Due round con lo stesso numero di vetture e lo stesso costo vero; il
    secondo porta 800 euro di penalita' realizzate. Col costo lordo perdeva."""
    copione = [
        (3, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
        (3, 800.0, _blocchi(["t1", "t2"], ["t3"])),
    ]
    _, uscita = _giro(copione, {"rounds": 2, "earlyStopPatience": 9}, monkeypatch)
    costi = [r["vehicleCostEur"] for r in uscita["vcsp"]["rounds"]]
    assert costi == [3000.0, 3000.0], costi
    ombre = [r["shadowPenaltyEur"] for r in uscita["vcsp"]["rounds"]]
    assert ombre == [0.0, 800.0]


# ── la via di fuga ───────────────────────────────────────────────────────

def test_con_le_tre_manopole_il_ciclo_torna_a_com_era(monkeypatch):
    copione = [
        (3, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
        (2, 0.0, _blocchi(["t1", "t2"], ["t3"])),
        (4, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
    ]
    motori, uscita = _giro(copione, {
        "rounds": 3, "earlyStopPatience": 9,
        "seedFromBest": False, "penaltyStep": 1.0, "penaltyAnchor": "last",
    }, monkeypatch)
    for payload in motori.payload_visti:
        assert "warmStartChains" not in payload, "nessun seme con seedFromBest=false"
    for f in uscita["vcsp"]["feedback"]:
        assert f["ancora"]["modo"] == "last"
        assert f["ancora"]["round"] == f["afterRound"], "il feedback torna sull'ultimo round"
        assert f["passo"] == 1.0


def test_di_default_il_feedback_si_ancora_al_campione(monkeypatch):
    copione = [
        (2, 0.0, _blocchi(["t1", "t2"], ["t3"])),
        (5, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
    ]
    _, uscita = _giro(copione, {"rounds": 2, "earlyStopPatience": 9}, monkeypatch)
    f = uscita["vcsp"]["feedback"][0]
    assert f["ancora"]["modo"] == "best"
    assert f["ancora"]["round"] == 1, "il round 2 e' peggiore: l'ancora resta il round 1"
    assert f["passo"] == orch.PENALTY_STEP


def test_il_termometro_esce_nel_rendiconto(monkeypatch):
    copione = [
        (3, 0.0, _blocchi(["t1"], ["t2"], ["t3"])),
        (3, 0.0, _blocchi(["t1", "t2"], ["t3"])),
    ]
    _, uscita = _giro(copione, {"rounds": 2, "earlyStopPatience": 9}, monkeypatch)
    f = uscita["vcsp"]["feedback"][0]
    for chiave in ("massaPenalitaEur", "distanzaDalPrecedenteEur", "archiInVigore"):
        assert chiave in f, chiave
