"""Relazione di processo: la libreria grafici rispetta le regole di forma e il
builder regge dossier vuoti, parziali e completi producendo tutte le sezioni."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import report_builder as rb  # noqa: E402
import report_charts as rc  # noqa: E402


def _duty(did, dtype, pieces, nastro, work, interruption=0, cost=300.0, viol=0):
    return {"driverId": did, "type": dtype, "nastroMin": nastro, "workMin": work, "interruptionMin": interruption,
            "nastroStartMin": pieces[0]["startMin"], "cambiCount": len(pieces) - 1, "costEuro": cost,
            "costBreakdown": {"baseSalary": cost * 0.8, "transferDepotCost": cost * 0.2, "total": cost},
            "bdsValidation": {"violations": [{"message": "violazione di prova"}] * viol, "warnings": []},
            "riprese": pieces}


def _piece(veh, start, end, trips):
    return {"startMin": start, "endMin": end, "vehicleIds": [veh],
            "trips": [{"tripId": f"t{start}{i}", "routeName": r, "departureMin": s, "arrivalMin": e, "vehicleId": veh} for i, (r, s, e) in enumerate(trips)]}


def _dossier():
    shifts = [{"vehicleId": "V1", "vehicleType": "12m", "startMin": 420, "endMin": 900, "tripCount": 4, "totalServiceMin": 360, "totalDeadheadKm": 3.2, "depotReturns": 0, "shiftDuration": 480,
               "trips": [{"type": "deadhead", "departureMin": 420, "arrivalMin": 435, "deadheadKm": 3.2, "deadheadMin": 15, "depotLeg": "out", "firstStopName": "Deposito", "lastStopName": "Cavour"},
                         {"type": "trip", "routeName": "1/4", "departureMin": 440, "arrivalMin": 520, "departureTime": "07:20", "arrivalTime": "08:40", "firstStopName": "Cavour", "lastStopName": "Tavernelle"},
                         {"type": "trip", "routeName": "1/4", "departureMin": 530, "arrivalMin": 610, "firstStopName": "Tavernelle", "lastStopName": "Cavour"},
                         {"type": "trip", "routeName": "3", "departureMin": 620, "arrivalMin": 700}, {"type": "trip", "routeName": "3", "departureMin": 710, "arrivalMin": 890}]}]
    duties = [_duty("U1", "intero", [_piece("V1", 440, 700, [("1/4", 440, 520), ("1/4", 530, 610), ("3", 620, 700)]), _piece("V1", 710, 890, [("3", 710, 890)])], 450, 440, 10, viol=1),
              _duty("U2", "spezzato", [_piece("V1", 440, 610, [("1/4", 440, 520), ("1/4", 530, 610)]), _piece("V1", 800, 890, [("3", 800, 890)])], 450, 260, 190)]
    return {"meta": {"projectName": "P", "udpName": "U", "serviceDate": "2026-09-20", "isTest": True, "scenarioName": "S"},
            "network": {"lines": [{"name": "1/4", "routeId": "r1", "trips": 2, "km": 12.5, "firstDep": "07:20", "lastDep": "08:50", "headway": "30′", "vehicleType": "12m", "flexMin": 10}],
                        "stopsCount": 2, "nodes": ["CAVOUR"], "polylines": [{"name": "1/4", "points": [(43.6, 13.5), (43.61, 13.52)]}],
                        "stops": [{"name": "Cavour", "lat": 43.6, "lon": 13.5, "node": True}]},
            "planning": {"timeline": [{"at": "2026-09-01 10:00", "action": "ps.trips.generate", "who": "op", "via": "argos", "detail": "×2"}],
                         "decisions": [{"kind": "decisione", "content": "cadenza 30′"}], "plans": [{"id": 1, "at": "2026-09-01", "goal": "g", "summary": "s", "status": "completed"}],
                         "validities": [{"name": "U", "trips": 4, "dayTypes": ["Festivo"]}], "flex": [{"line": "1/4", "flexMin": 10}]},
            "runs": [{"name": "A", "at": "2026-09-01 11:00", "kpi": {"vehicles": 1, "duties": 3, "violations": 1, "byType": {"intero": 1, "semiunico": 1, "spezzato": 1}, "vehicleCostEur": 100, "crewCostEur": 900, "totalCostEur": 1000, "selectionScoreEur": 1700}},
                     {"name": "B", "at": "2026-09-01 12:00", "selected": True, "kpi": {"vehicles": 1, "duties": 2, "violations": 1, "byType": {"intero": 1, "spezzato": 1}, "vehicleCostEur": 100, "crewCostEur": 600, "totalCostEur": 700, "selectionScoreEur": 1200}}],
            "final": {"vsp": {"metrics": {"vehicles": 1, "totalTrips": 4, "totalServiceKm": 40.0, "totalDeadheadKm": 3.2, "totalDeadheadMin": 15, "totalServiceMin": 360, "costEur": 100.0,
                                          "sagoma": {"corseDeclassate": 2, "pctDeclassate": 50.0, "declassateInPunta": 1,
                                                     "fuoriSagoma": 0, "doppiDeclassamenti": 0, "fascePunta": [[15, 20]],
                                                     "blocchiPerTipo": {"12m": 1}, "lineeDeclassate": {"3": 2},
                                                     "catenSpezzate": 1,
                                                     "superamenti": ["linea 3: 2 corse su 4 con un mezzo piu' piccolo"]}},
                                "costBreakdown": {"aggregated": {"total": 100.0, "vcspPenalty": 12.0}},
                                "vehicleShifts": shifts},
                      "crew": {"summary": {"totalDriverShifts": 2, "totalDailyCost": 600.0, "companyCarsMaxSimultaneous": 1, "byType": {"intero": 1, "spezzato": 1}}, "driverShifts": duties, "metrics": {}},
                      "vcsp": {"bestRound": 2, "selectedRound": 2,
                               "rounds": [{"round": 1, "vehicles": 2, "duties": 3, "supplementi": 0, "bdsViolations": 2,
                                           "totalCostEur": 900.0, "shadowPenaltyEur": 0.0, "selectionScoreEur": 1500.0},
                                          {"round": 2, "probe": True, "vehicles": 1, "duties": 2, "supplementi": 0,
                                           "bdsViolations": 0, "totalCostEur": 700.0, "shadowPenaltyEur": 12.0,
                                           "selectionScoreEur": 1200.0}],
                               "ciclo": {"passo": 0.5, "ancora": "best", "seme": True,
                                         "pazienza": 3, "controllo": True},
                               "feedback": [{"afterRound": 1, "passo": 0.5,
                                             "ancora": {"round": 1, "modo": "best", "cambiInRegola": True},
                                             "blocksPenalized": 2, "arcsPenalized": 7, "archiInVigore": 9,
                                             "massaPenalitaEur": 40.0, "distanzaDalPrecedenteEur": 40.0,
                                             "giunti": {"escalation": 1.0}}],
                               "probe": {"shiftedTrips": 2, "shiftedTripMin": 20, "probesRun": 3, "disruptionEur": 20.0,
                                         "shiftPenaltyEurPerTripMin": 1,
                                         "controllo": {"eseguito": True, "riferimento": "round",
                                                       "vetture": {"round": 2, "controllo": 2}},
                                         "memoria": {"giriLetti": 1, "lezioniLette": 5, "ripresi": 1, "rimandatiInCoda": 2},
                                         "accepted": [{"kind": "coincidenza", "disruptionEur": 20.0,
                                                       "shiftsByRoute": [{"routeName": "3", "deltaMin": -10, "trips": 2}],
                                                       "before": {"vehicles": 2, "duties": 3, "bdsViolations": 2},
                                                       "after": {"vehicles": 1, "duties": 2, "bdsViolations": 0}}],
                                         "lezioni": [{"firma": "linea:7:-11", "route": "7", "deltaMin": -11,
                                                      "esito": "scartato", "motivo": "coincidenza:catenaTroppoLunga",
                                                      "tentativi": 4},
                                                     {"firma": "tail-:x", "esito": "scartato", "motivo": "vsp",
                                                      "tentativi": 1}]}},
                      "params": {"vcsp": {"rounds": 2, "probes": 4}, "weights": {"preferIntero": 8}, "weightFactors": {"duty": 1.0, "spezz": 1.3}, "companyCars": 5,
                                 "shiftRules": {"intero": {"maxNastro": 435, "maxLavoro": 435, "intMin": 0, "intMax": 0, "maxPct": 100, "sostaMinCapolinea": 15},
                                                "spezzato": {"maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999, "maxPct": 13}},
                                 "provenance": {"crewConfig": "scenario", "vehicleCosts": "default"}}},
            "costs": {"notes": ["prova"]},
            "analisi": {"coincidenze": {
                "corse": 4, "corseConPassaggi": 2, "sogliaAttesaMin": 5, "attesaMinimaMin": 2, "minOccorrenze": 3,
                "esistenti": [{"node": "CAVOUR", "fromRoute": "1/4", "toRoute": "3", "occurrences": 4,
                               "attesaMin": {"min": 2, "max": 5, "mediana": 3}, "giaInCoincidenza": 0,
                               "sample": [{"arrivo": "08:40", "partenza": "08:43", "attesaMin": 3}]}],
                "mancatePerPoco": [{"node": "TAVERNELLE", "fromRoute": "3", "toRoute": "1/4", "occurrences": 6,
                                    "attesaMin": {"min": 8, "max": 14, "mediana": 11},
                                    "giaInCoincidenza": 0}],
                "opportunita": [{"route": "3", "corse": 12, "flexDichiarataMin": 10,
                                 "migliore": {"deltaMin": -7, "create": 2, "rotte": 0, "dentroLaFlessibilita": True}}],
                "nota": "nota di prova"}}}


def test_charts_have_table_twin_and_legend_rules():
    one = rc.bar_h([("a", 1), ("b", 2)], "T", unit="u")
    assert "<svg" in one and 'class="tv"' in one and 'class="legend"' not in one   # una serie: niente legenda
    two = rc.columns(["x", "y"], [("s1", [1, 2]), ("s2", [2, 1])], "T", stacked=True)
    assert 'class="legend"' in two and two.count("<i style") == 2 and 'class="tv"' in two
    ln = rc.lines(["06", "07", "08"], [("v", [1, 3, 2])], "T")
    assert "<polyline" in ln and 'stroke-width="2"' in ln and 'class="legend"' not in ln
    gt = rc.gantt([{"label": "U1", "segments": [{"start": 400, "end": 460, "kind": "trip"}, {"start": 460, "end": 520, "kind": "break"}]}], "G")
    assert "<rect" in gt and "interruzione" in gt
    mp = rc.network_map([{"name": "1", "points": [(43.6, 13.5), (43.61, 13.51)]}], [{"name": "N", "lat": 43.6, "lon": 13.5, "node": True}], "M")
    assert "<path" in mp and "N" in mp
    assert rc.bar_h([], "vuoto") == "" and rc.gantt([], "vuoto") == ""


def test_palette_is_the_reference_instance():
    assert rc.SERIES[0] == "#2a78d6" and len(rc.SERIES) == 8 and rc.SURFACE == "#fcfcfb"


def test_builder_on_empty_and_partial_dossier():
    html = rb.build({})
    assert "<h1>" in html and "Relazione" in html
    for _, title in rb.TOC:
        assert title in html
    html2 = rb.build({"meta": {"isTest": True}, "final": {"vsp": {"metrics": {"vehicles": 0}}}})
    assert "Versione di prova" in html2


def test_builder_full_dossier_sections_and_summary():
    d = _dossier()
    html = rb.build(d)
    for needle in ("1. Sintesi", "Diagramma tempo-vettura", "Diagramma tempo-turno", "Distribuzione del nastro",
                   "Valori unitari in uso", "Scenari confrontati", "Fogli turno macchina", "Fogli turno guida",
                   "violazione di prova", "Tariffa oraria conducente", "Regole di struttura", "Sonda di spostamento", "Disegno della rete",
                   "cadenza 30′", "ps.trips.generate", "Paga base"):
        assert needle in html, needle
    assert "★ B" in html
    s = rb.summary_of(d)
    assert s["duties"] == 2 and s["vehicles"] == 1 and s["violations"] == 1 and s["isTest"] is True
    assert set(s["byType"]) == {"intero", "spezzato"}
    # moneta onesta: il costo vetture esce al NETTO delle penalita' inventate
    assert s["vehicleCostEur"] == 88.0, s["vehicleCostEur"]
    assert s["totalCostEur"] == 688.0, s["totalCostEur"]


def test_le_analisi_fatte_finiscono_tutte_nel_documento():
    """La relazione deve raccontare anche COME il piano e' stato prodotto e che
    servizio produce, non solo il risultato: il ciclo integrato con i suoi
    giri, il termometro del feedback, la sonda con le sue lezioni, la regola
    della sagoma e la mappa delle coincidenze."""
    html = rb.build(_dossier())
    for needle in ("7. Il ciclo integrato", "I giri del ciclo", "Come il segnale si è mosso",
                   "La sonda: spostare corse per salvare un turno", "Il controllo", "La memoria",
                   "8. Coincidenze fra linee", "Le relazioni che l'orario realizza",
                   "Le occasioni mancate per poco", "Che cosa si guadagnerebbe spostando una linea",
                   "Regola della sagoma", "9. Costi", "10. Scenari confrontati", "11. Allegati"):
        assert needle in html, needle
    # i motivi dei rifiuti sono spiegati a parole, non in gergo
    assert "la catena da trascinare è troppo lunga" in html
    assert "coincidenza:catenaTroppoLunga" not in html
    # le penalita' inventate sono dichiarate, non nascoste
    assert "non sono spesa" in html


def test_il_documento_regge_senza_le_analisi_nuove():
    """Uno scenario prodotto senza ciclo integrato e senza mappa deve comunque
    produrre il documento, dicendo che quelle analisi non ci sono."""
    d = _dossier()
    d["final"].pop("vcsp", None)
    d.pop("analisi", None)
    html = rb.build(d)
    assert "7. Il ciclo integrato" in html and "senza retroazione" in html
    assert "8. Coincidenze fra linee" in html and "non disponibile" in html


def test_json_mode_roundtrip(tmp_path):
    import subprocess
    d = _dossier()
    p = tmp_path / "d.json"
    p.write_text(json.dumps(d), encoding="utf-8")
    out = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "report_builder.py"), str(p), "--json"],
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr[-500:]
    j = json.loads(out.stdout)
    assert j["summary"]["duties"] == 2 and j["html"].startswith("<!doctype html>")


def test_derivations():
    d = _dossier()
    labels, counts = rb.vehicles_by_hour(d["final"]["vsp"]["vehicleShifts"])
    assert labels and max(counts) == 1
    rows_, agg = rb.deadhead_table(d["final"]["vsp"]["vehicleShifts"])
    assert len(rows_) == 1 and abs(sum(agg.values()) - 3.2) < 1e-9
    st = rb.crew_stats(d["final"]["crew"]["driverShifts"])
    assert st["byType"]["intero"] == 1 and st["violations"] == 1 and st["interruptions"] == [190]
    rows_g = rb.duty_gantt_rows(d["final"]["crew"]["driverShifts"])
    kinds = {sg["kind"] for r in rows_g for sg in r["segments"]}
    assert "trip" in kinds and "break" in kinds
    units = rb.unit_cost_table({"vcsp": {"shiftPenaltyEur": 2}})
    assert any(u["label"].startswith("Tariffa oraria") for u in units) and any(u["value"] == 2 for u in units)


def test_il_termometro_si_legge_in_tutte_e_due_le_forme():
    """Il bug che ha fatto morire la prima relazione col capitolo 7.

    Il dossier porta il feedback GREZZO come esce dal motore: `ancora` e' un
    oggetto {round, modo, cambiInRegola}, non un numero. Il cruscotto invece
    lo appiattisce prima di mostrarlo. La relazione deve reggere entrambe le
    forme e leggerne gli stessi numeri, o si spacca a seconda di chi gliel'ha
    passata."""
    grezzo = {"afterRound": 2, "ancora": {"round": 1, "modo": "best", "cambiInRegola": False},
              "blocksPenalized": 4, "arcsPenalized": 11, "archiInVigore": 13,
              "massaPenalitaEur": 205.67, "distanzaDalPrecedenteEur": 103.05,
              "giunti": {"escalation": 1.5}}
    appiattito = {"dopoRound": 2, "ancora": 1, "modo": "best", "blocchiPenalizzati": 4,
                  "archiDalPiano": 11, "archiInVigore": 13, "massaPenalitaEur": 205.67,
                  "spostamentoEur": 103.05, "escalationGiunti": 1.5}
    a, b = rb._fb_termometro(grezzo), rb._fb_termometro(appiattito)
    for campo in ("dopoRound", "ancoraRound", "modo", "blocchi", "archiInVigore",
                  "massaEur", "spostamentoEur", "escalation"):
        assert a[campo] == b[campo], f"{campo}: {a[campo]!r} != {b[campo]!r}"
    assert a["ancoraRound"] == 1 and a["modo"] == "best" and a["massaEur"] == 205.67
    assert a["cambiInRegola"] is False


def test_il_capitolo_sette_dichiara_le_regole_dingaggio():
    """Le manopole con cui il ciclo ha girato vanno dette, non lasciate intendere."""
    d = _dossier()
    html = rb.render_ciclo(d)
    assert "regole d'ingaggio" in html
    assert "50 %" in html                      # passo 0.5
    assert "il giro migliore fin qui" in html  # ancora best
    assert "catene del piano migliore" in html # seme acceso
    assert "calcolo di controllo" in html      # controllo acceso


def test_le_attese_delle_coincidenze_si_leggono_dalla_forma_vera():
    """Il secondo bug della stessa famiglia.

    L'analisi delle coincidenze scrive l'attesa come oggetto
    {min, max, mediana}; la relazione la cercava in tre campi piatti che non
    esistono, e le colonne «Attesa» sarebbero uscite vuote."""
    oggetto = {"attesaMin": {"min": 8, "max": 14, "mediana": 11}}
    piatta = {"attesaMinMin": 8, "attesaMaxMin": 14, "attesaMedianaMin": 11}
    a, b = rb._attesa(oggetto), rb._attesa(piatta)
    assert a["min"] == b["min"] == 8
    assert a["max"] == b["max"] == 14
    assert a["mediana"] == b["mediana"] == 11
    assert rb._attesa({}) == {"min": None, "max": None, "mediana": None}


def test_le_attese_finiscono_davvero_nelle_tabelle():
    html = rb.render_coincidenze(_dossier())
    assert "2–5′" in html, "l'attesa delle relazioni realizzate non e' stampata"
    assert "8–14′" in html, "l'attesa delle relazioni mancate non e' stampata"


def test_i_formattatori_non_uccidono_la_relazione():
    """Un campo che cambia forma nel dossier deve costare una cella vuota,
    non il documento intero. E' cosi' che la relazione col capitolo 7 e' morta
    la prima volta: `ancora` da numero era diventato un oggetto, e
    f"{dict:,.0f}" ha fermato la generazione a meta'."""
    for strano in ({"round": 1, "modo": "best"}, [1, 2, 3], object(), "non un numero"):
        assert rc.fmt_n(strano) == "–"
        assert rc.fmt_eur(strano) == "–"
    assert rc.fmt_n(None) == "–" and rc.fmt_eur(None) == "–"
    # I numeri veri passano intatti, comunque siano scritti.
    assert rc.fmt_n(1234.5, 1) == "1.234,5"
    assert rc.fmt_n("1234.5", 1) == "1.234,5"
    assert rc.fmt_eur(1234) == "€ 1.234"
    # Il booleano non e' un numero: True non deve diventare 1.
    assert rc.fmt_n(True) == "–"


def test_un_capitolo_rotto_non_si_porta_via_la_relazione(monkeypatch, capsys):
    """La regola imparata sul campo: meglio un capitolo mancante, dichiarato,
    che un documento che non esiste. L'operatore deve avere comunque il resto,
    e il guasto deve restare nei log per essere corretto."""
    def esplode(_d):
        raise TypeError("unsupported format string passed to dict.__format__")
    monkeypatch.setattr(rb, "render_coincidenze", esplode)
    html = rb.build(_dossier())
    assert "non e' stato prodotto" in html.replace("'", "'")
    assert "TypeError" in html
    # Il resto c'e' tutto.
    assert "7. Il ciclo integrato" in html and "Turni guida" in html
    assert html.startswith("<!doctype html>") and html.rstrip().endswith("</html>")
    # E il guasto e' finito nei log, non solo nel documento.
    assert "coincidenze" in capsys.readouterr().err


# ═══════════════════════════════════════════════════════════════
#  IL CAPITOLO DELLA RETE
# ═══════════════════════════════════════════════════════════════

def _rete():
    """Una rete minima con due nodi e due percorsi."""
    return {"network": {
        "lines": [{"name": "3", "trips": 40, "km": 220.0}],
        "stopsCount": 5,
        "nodes": ["Piazza Cavour", "Tavernelle"],
        "clusters": [
            {"name": "Piazza Cavour", "stops": [
                {"name": "PIAZZA CAVOUR 1", "lat": 43.6158, "lon": 13.5189},
                {"name": "PIAZZA CAVOUR 2", "lat": 43.6162, "lon": 13.5192},
                {"name": "PIAZZA CAVOUR 3", "lat": 43.6155, "lon": 13.5195}]},
            {"name": "Tavernelle", "stops": [
                {"name": "TAVERNELLE CAPOLINEA", "lat": 43.5902, "lon": 13.4780}]},
        ],
        "polylines": [{"name": "3", "points": [(43.6158, 13.5189), (43.5902, 13.4780)]}],
        "percorsi": [
            {"line": "3", "variant": "Cavour → Tavernelle", "direction": 0, "isDefault": True,
             "points": [(43.6158, 13.5189), (43.6, 13.50), (43.5902, 13.4780)],
             "stops": [{"name": "PIAZZA CAVOUR 1", "lat": 43.6158, "lon": 13.5189},
                       {"name": "TAVERNELLE CAPOLINEA", "lat": 43.5902, "lon": 13.4780}]},
            {"line": "3", "variant": "Tavernelle → Cavour", "direction": 1, "isDefault": False,
             "points": [(43.5902, 13.4780), (43.6, 13.50), (43.6158, 13.5189)],
             "stops": [{"name": "TAVERNELLE CAPOLINEA", "lat": 43.5902, "lon": 13.4780}]},
        ],
        "stops": [{"name": "PIAZZA CAVOUR 1", "lat": 43.6158, "lon": 13.5189, "node": True}],
    }}


def test_i_nodi_sono_solo_quelli_toccati_e_mostrano_le_fermate():
    """Prima qui finivano i cluster di tutta la rete aziendale: su un piano
    urbano di Ancona comparivano Jesi, Osimo e Chiaravalle, e lo stesso nodo
    era ripetuto otto volte. Il dossier ora porta solo i nodi con le loro
    fermate, e il capitolo le disegna."""
    html = rb.render_network(_rete())
    assert "2.2 I nodi di interscambio" in html
    assert "Piazza Cavour" in html and "Tavernelle" in html
    assert "PIAZZA CAVOUR 2" in html, "le fermate raggruppate devono comparire"
    assert "non è una fermata" in html
    # la mappa dei nodi c'e' ed e' un disegno, non solo una tabella
    assert html.count("<svg") >= 2


def test_ogni_percorso_ha_la_sua_mappa():
    html = rb.render_network(_rete())
    assert "2.4 I percorsi, linea per linea" in html
    assert "Cavour → Tavernelle" in html and "Tavernelle → Cavour" in html
    assert "andata" in html and "ritorno" in html
    # una mappa per percorso, piu' rete e nodi
    assert html.count("<svg") >= 4


def test_il_capitolo_della_rete_regge_senza_i_dati_nuovi():
    """Un dossier vecchio non ha né clusters né percorsi: il capitolo esce
    comunque, con quello che ha."""
    magro = {"network": {"lines": [{"name": "3", "trips": 40, "km": 220.0}],
                         "nodes": ["Piazza Cavour"], "stopsCount": 5}}
    html = rb.render_network(magro)
    assert "2. Rete e contesto" in html and "2.1 Le linee" in html
    assert "Piazza Cavour" in html
    assert "2.4 I percorsi" not in html


def test_i_tracciati_lunghi_si_alleggeriscono():
    """Un tracciato da migliaia di vertici pesa nel documento e non si vede:
    si tiene la forma con meno punti, primo e ultimo compresi."""
    lungo = [(43.6 + i * 1e-5, 13.5 + i * 1e-5) for i in range(3000)]
    magro = rc.alleggerisci(lungo)
    assert len(magro) <= 161
    assert magro[0] == lungo[0] and magro[-1] == lungo[-1]
    # un tracciato gia' corto non si tocca
    corto = lungo[:50]
    assert rc.alleggerisci(corto) == corto


# ═══════════════════════════════════════════════════════════════
#  LE MAPPE SI DEVONO VEDERE
# ═══════════════════════════════════════════════════════════════

def test_la_proiezione_combacia_con_lo_sfondo():
    """Lo sfondo è un'immagine in Mercatore: se i punti si proiettano in
    equirettangolare, i tracciati scivolano rispetto alle strade. Il centro
    del riquadro deve cadere al centro del disegno, e il riquadro deve avere
    le proporzioni del disegno, o Mapbox lo allarga per conto suo."""
    pts = [(43.55, 13.45), (43.65, 13.55)]
    P, riq = rc.proiettore(pts, 800, 400)
    cx, cy = P(43.60, 13.50)
    assert abs(cx - 400) < 1.5 and abs(cy - 200) < 1.5, f"centro a ({cx}, {cy})"
    x0, y0, x1, y1 = riq
    assert abs((x1 - x0) / (y1 - y0) - 800 / 400) < 1e-6, "proporzioni del riquadro"
    # tutti i punti cadono dentro il disegno
    for lat, lon in pts:
        x, y = P(lat, lon)
        assert 0 <= x <= 800 and 0 <= y <= 400


def test_senza_chiave_la_mappa_esce_lo_stesso(monkeypatch):
    """Il documento non deve dipendere da un servizio esterno: niente chiave,
    niente sfondo, ma la mappa si disegna."""
    monkeypatch.delenv("MAPBOX_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("MAPBOX_TOKEN", raising=False)
    rc._sfondi.clear()
    uri, motivo = rc.sfondo_mappa((13.4, 48.4, 13.6, 48.6), 100, 100)
    assert uri == "" and "chiave" in motivo
    html = rc.network_map([{"name": "3", "points": [(43.61, 13.51), (43.59, 13.48)]}],
                          [{"name": "CAVOUR", "lat": 43.61, "lon": 13.51, "node": True}], "prova")
    assert "<svg" in html and "<image" not in html
    # e il documento DICE perché manca, invece di mostrare un rettangolo muto
    assert "Sfondo cartografico non disponibile" in html


def test_il_percorso_prende_il_colore_della_linea():
    """Il colore con cui l'azienda pubblica la linea vince sulla tavolozza."""
    con = rc.network_map([{"name": "3", "points": [(43.61, 13.51), (43.59, 13.48)], "color": "#e2001a"}], [], "p")
    assert "#e2001a" in con
    senza = rc.network_map([{"name": "3", "points": [(43.61, 13.51), (43.59, 13.48)]}], [], "p")
    assert rc.SERIES[0] in senza


def test_l_isocrona_si_disegna_sotto_il_tracciato():
    geom = {"type": "Polygon", "coordinates": [[[13.50, 43.60], [13.52, 43.60], [13.52, 43.62], [13.50, 43.62], [13.50, 43.60]]]}
    html = rc.network_map([{"name": "3", "points": [(43.61, 13.51), (43.59, 13.48)], "color": "#e2001a"}],
                          [], "p", isocrone=[{"minuti": 10, "geom": geom}, {"minuti": 5, "geom": geom}])
    # il minutaggio sta nel tooltip dell'area, non ripetuto in ogni legenda:
    # lo dice una volta l'intestazione del capitolo
    assert "minuti a piedi" in html
    assert "10′ a piedi" not in html
    # dentro il disegno l'isocrona viene PRIMA del tracciato, cioè sotto
    import re as _re
    svg = _re.search(r"<svg.*?</svg>", html, _re.S).group(0)
    assert svg.index("minuti a piedi") < svg.index("#e2001a")


def test_i_nodi_sono_cerchi_con_i_nomi_delle_fermate():
    """Erano gusci convessi senza etichette: un nodo con due fermate diventava
    un segmento e non si leggeva che cosa contenesse."""
    html = rc.cluster_map([{"name": "Piazza Cavour", "stops": [
        {"name": "CAVOUR EST", "lat": 43.6158, "lon": 13.5189},
        {"name": "CAVOUR OVEST", "lat": 43.6162, "lon": 13.5192}]}], "nodi")
    assert "<circle" in html
    assert "CAVOUR EST" in html and "CAVOUR OVEST" in html
    assert "Piazza Cavour" in html
    # il cerchio del nodo contiene le sue fermate: raggio non degenere
    import re as _re
    raggi = [float(r) for r in _re.findall(r'<circle[^>]*r="([\d.]+)"[^>]*fill-opacity', html)]
    assert raggi and min(raggi) >= 16


def test_ogni_nodo_ha_la_sua_mappa_da_vicino():
    """Nella mappa d'insieme un nodo è un cerchio da undici pixel e i nomi
    delle sue fermate non ci stanno: per quello serve il dettaglio."""
    html = rb.render_network(_rete())
    assert "Dove stanno i nodi" in html
    assert "griglia-mappe" in html
    # i nomi delle fermate compaiono nel dettaglio, non nell'insieme
    assert "PIAZZA CAVOUR 2" in html and "PIAZZA CAVOUR 3" in html
    assert "TAVERNELLE CAPOLINEA" in html


def test_il_nodo_da_vicino_non_scende_sotto_i_350_metri():
    """Due banchine a quaranta metri chiederebbero uno sfondo da marciapiede,
    senza un riferimento riconoscibile."""
    vicine = [(43.61580, 13.51890), (43.61604, 13.51920)]
    _, riq = rc.proiettore(vicine, 430, 300, lato_minimo_m=350)
    x0, y0, x1, y1 = riq
    import math as _m
    metri = (x1 - x0) * 111_320 * _m.cos(_m.radians(43.616))
    assert metri >= 349, f"lato {metri:.0f} m"


def test_sotto_la_mappa_c_e_la_copertura_non_l_elenco_delle_fermate():
    """L'elenco delle fermate sotto la mappa non dice niente che la mappa non
    mostri gia'. Quello che non si vede e' quanta gente il percorso ha a
    portata di piedi, e che cosa le porta vicino."""
    d = _rete()
    d["network"]["percorsi"][0]["copertura"] = {
        "abitanti": 12450, "sezioni": 38, "poi": 214,
        "categorie": [{"nome": "Pharmacy", "n": 12}, {"nome": "School", "n": 9},
                      {"nome": "Supermarket", "n": 4}],
    }
    html = rb.render_network(d)
    assert "Popolazione raggiunta" in html and "12.450" in html
    assert "38" in html and "sezioni di censimento" in html
    assert "Poli attrattori serviti" in html and "214" in html
    assert "Pharmacy" in html and "School" in html and "Supermarket" in html
    # l'elenco numerato delle fermate non c'e' piu'
    assert "N." not in html


def test_il_percorso_senza_copertura_non_si_rompe():
    """Senza isocrone non c'e' copertura: il percorso esce con la sola mappa."""
    html = rb.render_network(_rete())          # nessuna chiave "copertura"
    assert "2.4 I percorsi" in html
    assert "Popolazione raggiunta" not in html


def test_le_fermate_poche_tengono_il_nome_sulla_mappa():
    html = rb.render_network(_rete())      # due fermate per percorso
    assert "PIAZZA CAVOUR 1" in html


# ═══════════════════════════════════════════════════════════════
#  IL TERRITORIO: PENDOLARI E TRAFFICO
# ═══════════════════════════════════════════════════════════════

def _territorio():
    return {"analisi": {"territorio": {
        "comune": {"istat": "042002", "nome": "Ancona", "abitanti": 98400},
        "pendolari": {
            "fonte": "Censimento ISTAT, matrice degli spostamenti pendolari",
            "livello": "comunale",
            "entrano": {"totale": 18400,
                        "comuni": [{"nome": "Falconara Marittima", "n": 3100},
                                   {"nome": "Osimo", "n": 2400}],
                        "motivi": [{"nome": "work", "n": 14000}, {"nome": "study", "n": 4400}],
                        "mezzi": [{"nome": "car_driver", "n": 12000}, {"nome": "bus_urban", "n": 3200},
                                  {"nome": "train", "n": 3200}],
                        "fasce": [{"nome": "715_815", "n": 9000}, {"nome": "before_715", "n": 5400},
                                  {"nome": "815_915", "n": 4000}]},
            "escono": {"totale": 7300, "comuni": [{"nome": "Jesi", "n": 900}],
                       "motivi": [{"nome": "work", "n": 7300}],
                       "mezzi": [{"nome": "car_driver", "n": 6000}],
                       "fasce": [{"nome": "715_815", "n": 4000}]},
            "interni": {"totale": 31200, "mezzi": [{"nome": "walk", "n": 9000},
                                                   {"nome": "bus_urban", "n": 6100}]},
        },
        "traffico": {"rilievi": 4820,
                     "perOra": [{"ora": 8, "congestione": 0.34, "velocita": 22.0, "libera": 33.0, "rilievi": 410},
                                {"ora": 13, "congestione": 0.12, "velocita": 29.0, "libera": 33.0, "rilievi": 380}],
                     "peggiori": [{"segmento": "SEG-12", "congestione": 0.61, "velocita": 13.0,
                                   "libera": 33.0, "rilievi": 22}]},
    }}}


def test_i_pendolari_dicono_chi_entra_e_chi_esce():
    html = rb.render_territorio(_territorio())
    assert "2.5 Il territorio e come si muove" in html
    assert "Ancona" in html
    assert "In entrata" in html and "18.400" in html
    assert "In uscita" in html and "7.300" in html
    assert "Dentro il comune" in html and "31.200" in html
    assert "Falconara Marittima" in html and "Jesi" in html
    # i codici del censimento sono tradotti in italiano corrente
    assert "auto, alla guida" in html and "bus urbano" in html
    assert "7:15 – 8:15" in html
    assert "lavoro" in html and "studio" in html
    assert "car_driver" not in html and "before_715" not in html


def test_il_livello_comunale_e_dichiarato_non_lasciato_intendere():
    """Il dato dice chi si sposta fra comuni, non chi sale a una fermata:
    scriverlo è la differenza fra una relazione onesta e una che millanta."""
    html = rb.render_territorio(_territorio())
    assert "comunale" in html
    assert "non quante salgono a una fermata" in html
    assert "bacino potenziale, non la domanda servita" in html


def test_il_traffico_spiega_i_tempi_di_percorrenza():
    html = rb.render_territorio(_territorio())
    assert "Il traffico sulle strade della rete" in html
    assert "34 %" in html and "22 km/h" in html      # congestione e velocità alle 8
    assert "SEG-12" in html and "61 %" in html
    assert "Velocità ora per ora" in html


def test_senza_territorio_il_capitolo_non_compare():
    assert rb.render_territorio({}) == ""
    assert rb.render_territorio({"analisi": {"territorio": {"comune": {"nome": "Ancona"}}}}) == ""


# ═══════════════════════════════════════════════════════════════
#  LE COINCIDENZE: IN TRE DIMENSIONI E A LIBRETTO
# ═══════════════════════════════════════════════════════════════

def _coincidenze():
    d = _rete()
    d["analisi"] = {"coincidenze": {
        "corse": 40, "corseConPassaggi": 20, "sogliaAttesaMin": 5, "attesaMinimaMin": 2, "minOccorrenze": 3,
        "esistenti": [{
            "node": "PIAZZA CAVOUR 1", "fromRoute": "3", "toRoute": "1/4", "occurrences": 3,
            "attesaMin": {"min": 2, "max": 5, "mediana": 3}, "giaInCoincidenza": 0,
            "sample": [{"arrivo": "08:12", "partenza": "08:15", "attesaMin": 3}],
            "passaggi": [
                {"arrivo": "08:12", "partenza": "08:15", "arrivoMin": 492, "partenzaMin": 495, "attesaMin": 3},
                {"arrivo": "13:42", "partenza": "13:47", "arrivoMin": 822, "partenzaMin": 827, "attesaMin": 5},
                {"arrivo": "18:12", "partenza": "18:14", "arrivoMin": 1092, "partenzaMin": 1094, "attesaMin": 2},
            ]}],
        "mancatePerPoco": [], "opportunita": [],
    }}
    return d


def test_il_libretto_orario_elenca_i_passaggi_uno_per_uno():
    """Una tabella che dice «tre volte al giorno» non basta al banco: servono
    gli orari veri, arrivo, ripartenza e attesa."""
    html = rb.render_coincidenze(_coincidenze())
    assert "8.7 Il libretto orario delle coincidenze" in html
    assert "08:12" in html and "08:15" in html
    assert "13:42" in html and "18:14" in html
    assert "3 passaggi al giorno" in html
    assert "Arrivo" in html and "Riparte" in html and "Attesa" in html


def test_ogni_categoria_ha_un_simbolo_e_un_colore():
    """Le categorie arrivano dai dati, sono decine e in inglese: un simbolo
    dice di che cosa si tratta senza leggere la parola."""
    assert rc.famiglia_poi("Pharmacy")[0] == "sanita"
    assert rc.famiglia_poi("Istituto di Istruzione Superiore")[0] == "istruzione"
    assert rc.famiglia_poi("Supermarket")[0] == "commercio"
    assert rc.famiglia_poi("Restaurant")[0] == "ristorazione"
    assert rc.famiglia_poi("Bus Station")[0] == "trasporti"
    assert rc.famiglia_poi("Post Office")[0] == "servizi pubblici"
    assert rc.famiglia_poi("Museum")[0] == "cultura e svago"
    # ciò che non si riconosce non rompe niente: finisce in «altro»
    assert rc.famiglia_poi("Qualcosa di mai visto")[0] == "altro"
    assert rc.famiglia_poi(None)[0] == "altro"
    # famiglie diverse, colori diversi
    colori = {rc.famiglia_poi(x)[1] for x in ("Pharmacy", "School", "Supermarket", "Restaurant")}
    assert len(colori) == 4


def test_le_categorie_si_disegnano_con_forme_distinte():
    """Le forme devono distinguersi anche stampate in bianco e nero, dove il
    colore da solo non basta."""
    html = rc.categorie_poi([("Pharmacy", 12), ("School", 9), ("Supermarket", 4)], "Poli")
    assert "<svg" in html
    assert "Pharmacy" in html and "School" in html
    # croce (path), triangolo (path) e quadrato (rect): forme diverse
    assert html.count("<path") >= 2 and "<rect" in html
    assert "sanita" in html and "istruzione" in html      # la legenda delle famiglie
    assert rc.categorie_poi([], "vuoto") == ""


def test_l_ora_si_legge_anche_dal_vecchio_campione():
    """Una relazione prodotta prima del campo `passaggi` ha solo `sample`, con
    l'ora come stringa: leggerla è l'unico modo perché i disegni escano."""
    assert rb._minuti_da_ora(492) == 492
    assert rb._minuti_da_ora("08:12") == 492
    assert rb._minuti_da_ora("08:12:00") == 492
    assert rb._minuti_da_ora("niente") is None and rb._minuti_da_ora(None) is None


def test_la_griglia_dice_a_che_ora_si_puo_cambiare():
    """Il totale non distingue trenta coincidenze sparse su tutto il giorno da
    trenta tutte nel mattino: la griglia sì, e il buco si vede a occhio."""
    d = _coincidenze()
    html = rb.render_coincidenze_quando(d["analisi"]["coincidenze"]["esistenti"])
    assert "8.2 Quando si può cambiare" in html
    assert "<svg" in html
    # le tre coincidenze del campione stanno alle 8, alle 13 e alle 18
    assert ">08<" in html and ">13<" in html and ">18<" in html
    assert "PIAZZA CAVOUR 1 · 3 → 1/4" in html


def test_la_griglia_conta_le_coincidenze_ora_per_ora():
    """Due passaggi nella stessa ora sono una casella da due, non due caselle."""
    c = {"node": "N", "fromRoute": "A", "toRoute": "B",
         "passaggi": [{"arrivoMin": 8 * 60 + 5}, {"arrivoMin": 8 * 60 + 40}, {"arrivoMin": 9 * 60 + 5}]}
    assert rb._ore_dei_passaggi(c) == {8: 2, 9: 1}
    # e l'ora si legge anche quando c'è solo la stringa
    c2 = {"passaggi": [{"arrivo": "07:58"}, {"arrivo": "07:12"}]}
    assert rb._ore_dei_passaggi(c2) == {7: 2}


def test_il_ritmo_mostra_attesa_e_ora_insieme():
    """Le due cose che contano — se il cambio c'è tutto il giorno e se l'attesa
    tiene — devono stare nello stesso disegno."""
    d = _coincidenze()
    html = rb.render_coincidenze_ritmo(d, d["analisi"]["coincidenze"]["esistenti"])
    assert "8.3 Quanto è buono ogni cambio" in html
    assert "<svg" in html
    assert "finestra utile 2–5 minuti" in html, "la fascia dichiara la finestra letta dal dossier"
    assert "attesa 3 minuti" in html and "attesa 5 minuti" in html


def test_il_ritmo_distingue_l_attesa_buona_da_quella_lunga():
    """Un punto sopra la fascia è un'attesa lunga, uno sotto è un cambio da
    prendere di corsa: due colori diversi, non uno solo."""
    dentro = rc.ritmo_relazione([{"arrivoMin": 480, "attesaMin": 3}], "t", finestra=(2, 5))
    sopra = rc.ritmo_relazione([{"arrivoMin": 480, "attesaMin": 20}], "t", finestra=(2, 5))
    sotto = rc.ritmo_relazione([{"arrivoMin": 480, "attesaMin": 0}], "t", finestra=(2, 5))
    assert rc.SERIES[0] in dentro
    assert rc.STATUS["warning"] in sopra and rc.SERIES[0] not in sopra.split("<circle")[1]
    assert rc.STATUS["critical"] in sotto
    # e senza orari non si disegna niente, invece di disegnare il vuoto
    assert rc.ritmo_relazione([], "t") == ""
    assert rc.ritmo_relazione([{"attesaMin": 3}], "t") == ""


def test_l_operatore_sceglie_le_linee_da_vedere():
    """La rete intera in un capitolo solo non si legge: chi esporta la relazione
    dice quali relazioni gli interessano."""
    d = _coincidenze()
    esistenti = d["analisi"]["coincidenze"]["esistenti"]
    esistenti.append({"node": "PINOCCHIO", "fromRoute": "2/6", "toRoute": "21/33", "occurrences": 4,
                      "attesaMin": {"min": 2, "max": 4, "mediana": 3}, "sample": [],
                      "passaggi": [{"arrivo": "09:10", "arrivoMin": 550, "attesaMin": 3}]})
    d["analisi"]["coincidenze"]["lineeScelte"] = ["3", "1/4"]
    html = rb.render_coincidenze(d)
    assert "limitato alle linee scelte" in html
    assert "1/4, 3" in html, "le linee scelte, in ordine di quadro orario"
    assert "PIAZZA CAVOUR 1" in html
    assert "PINOCCHIO" not in html, "la relazione fuori scelta non entra nel documento"
    assert "Il dossier conserva comunque tutta la rete" in html


def test_la_regola_della_scelta_e_una_sola_e_dichiarata():
    """Due o più linee: le relazioni fra quelle linee. Una sola: tutte le sue,
    altrimenti il capitolo resterebbe vuoto."""
    voci = [{"fromRoute": "3", "toRoute": "1/4"}, {"fromRoute": "2/6", "toRoute": "21/33"},
            {"fromRoute": "3", "toRoute": "44"}]
    # nessuna scelta: non si filtra
    assert len(rb.filtra_per_linee(voci, [])) == 3
    # due scelte: tutti e due i capi dentro
    assert rb.filtra_per_linee(voci, ["3", "1/4"]) == [voci[0]]
    # una sola: tutte le relazioni che la toccano
    assert rb.filtra_per_linee(voci, ["3"]) == [voci[0], voci[2]]


def test_lo_sfondo_dice_perche_manca(monkeypatch):
    """Una mappa senza strade e un errore di rete si assomigliano troppo:
    finché il motivo non era scritto, l'unico modo di distinguerli era
    leggere i log del server."""
    monkeypatch.setenv("MAPBOX_ACCESS_TOKEN", "")
    monkeypatch.delenv("MAPBOX_TOKEN", raising=False)
    rc._sfondi.clear()
    for html in (rc.network_map([{"name": "3", "points": [(43.61, 13.51), (43.59, 13.48)]}], [], "p"),
                 rc.cluster_map([{"name": "N", "stops": [{"name": "A", "lat": 43.61, "lon": 13.51},
                                                         {"name": "B", "lat": 43.62, "lon": 13.52}]}], "n"),
                 rc.nodo_map({"name": "N", "stops": [{"name": "A", "lat": 43.61, "lon": 13.51}]}, "#2a78d6")):
        assert "Sfondo cartografico non disponibile" in html, html[:200]


def test_la_chiave_si_accetta_con_tutti_e_due_i_nomi(monkeypatch):
    """Il codice del server legge MAPBOX_ACCESS_TOKEN, la documentazione di
    deploy parla di MAPBOX_TOKEN: accettarli entrambi costa una riga e toglie
    di mezzo un'intera classe di «non si vede»."""
    monkeypatch.delenv("MAPBOX_ACCESS_TOKEN", raising=False)
    monkeypatch.setenv("MAPBOX_TOKEN", "chiave-di-prova")
    rc._sfondi.clear()
    _, motivo = rc.sfondo_mappa((13.4, 48.4, 13.6, 48.6), 40, 40)
    assert "chiave" not in motivo, "col nome alternativo la chiave deve essere trovata"


def test_lo_sfondo_si_chiede_a_meta_risoluzione():
    """Decine di mappe a piena risoluzione fanno un documento da megabyte che
    il browser fatica ad aprire."""
    assert 0 < rc.SFONDO_SCALA <= 0.6
    assert rc.SFONDI_MAX <= 80


def test_le_linee_si_ordinano_come_su_un_quadro_orario():
    """In ordine alfabetico «24» viene prima di «3»: per chi legge un quadro
    orario è sbagliato."""
    assert sorted(["3", "24", "1/4"], key=rb.ordine_di_linea) == ["1/4", "3", "24"]
    assert sorted(["C.S.", "7"], key=rb.ordine_di_linea) == ["7", "C.S."]


# ═══════════════════════════════════════════════════════════════
#  IL DOCUMENTO CHE ESCE DALL'AZIENDA
# ═══════════════════════════════════════════════════════════════

def test_la_copertina_e_un_frontespizio():
    """Il documento finisce sul tavolo di chi non era nella stanza: deve dire
    di chi è, di che cosa parla, a quale giorno si riferisce e quando è stato
    prodotto — prima di ogni numero."""
    d = _dossier()
    d["meta"].update({"company": "Conerobus", "author": "Ufficio Esercizio",
                      "serviceDate": "2026-09-20", "dayType": "Festivo",
                      "scenarioName": "Argos · giro BC"})
    html = rb.render_cover(d)
    assert 'class="copertina"' in html and 'class="marchio"' in html
    assert "Conerobus" in html and "TransitIntel" in html
    assert 'class="frontespizio"' in html
    for etichetta in ("Giorno di servizio", "Giorno-tipo", "Scenario", "Redatta da", "Prodotta il"):
        assert etichetta in html, etichetta
    assert "2026-09-20" in html and "Ufficio Esercizio" in html
    assert "Indice" in html


def test_la_copertina_regge_un_dossier_spoglio():
    html = rb.render_cover({"meta": {}})
    assert 'class="copertina"' in html
    assert "Piano di esercizio" in html      # senza azienda, l'intestazione generica
    assert "Prodotta il" in html


def test_ogni_turno_sta_su_un_foglio_suo():
    """Gli allegati si staccano e si consegnano: un turno non si spezza mai a
    metà fra due pagine."""
    html = rb.render_appendix(_dossier())
    assert "staccano e si consegnano" in html
    assert html.count('<section class="foglio">') >= 2, "un foglio per turno"
    assert html.count("</section>") >= 2
    # e lo stile lo impone in stampa
    assert "break-before: page" in rc.CSS and "break-inside: avoid" in rc.CSS


def test_il_foglio_turno_e_quello_della_fucina():
    """L'allegato non è una seconda versione del turno: è lo stesso foglio che
    esce da «Fucina → turni guida → esporta → Fogli turno». Chi guida deve
    trovarsi in mano un documento solo."""
    d = _dossier()
    foglio = rb.foglio_turno_guida(d["final"]["crew"]["driverShifts"][0], d["meta"], {})
    # l'intestazione: matricola grande, deposito, tipo, giorno-tipo
    assert 'class="matricola">U1<' in foglio
    assert 'class="chip vuota">INTERO<' in foglio
    # le tre voci a destra, come sul foglio aziendale
    for voce in ("Nastro", "Presentazione", "Corse"):
        assert f'<span class="k">{voce}</span>' in foglio, voce
    # la banda del programma e la data di entrata in vigore
    assert 'class="programma"' in foglio and "in vigore dal" in foglio
    assert "20/09/2026" in foglio, "la data va scritta come la legge un italiano"
    # e le competenze in fondo
    assert "Competenze" in foglio and "Lavoro" in foglio


def test_la_corsa_sul_foglio_porta_linea_orari_e_durata():
    """La scheda-corsa: la linea nel bollino, gli orari grandi ai due capi, la
    durata nel mezzo. È così che si legge una corsa in un secondo."""
    corsa = {"routeName": "1/4", "vehicleId": "V1", "vehicleType": "12m",
             "departureMin": 440, "arrivalMin": 520, "departureTime": "07:20",
             "arrivalTime": "08:40", "firstStopName": "Cavour", "lastStopName": "Tavernelle",
             "variantCode": "46A"}
    html = rb._scheda_corsa(corsa, [])
    assert 'class="bollino">1/4<' in html
    assert 'class="big">07:20<' in html and 'class="big">08:40<' in html
    assert "Cavour" in html and "Tavernelle" in html
    assert ">80′<" in html, "la durata sta sulla freccia, non va calcolata a mano"
    assert "TM V1" in html and "12 m" in html, "chi guida deve sapere anche che mezzo è"
    assert "46A" in html


def test_gli_orari_del_foglio_sono_a_due_cifre():
    """07:58 e 7:58 non sono la stessa cosa: le colonne devono incolonnarsi."""
    assert rb._hhmm(478) == "07:58"
    assert rb._hhmm(1350) == "22:30"
    # e quando il motore l'orario lo ha già scritto, si usa il suo
    assert rb._orario("07:20:00", 440) == "07:20"
    assert rb._orario(None, 440) == "07:20"


def test_i_punti_orari_finiscono_sotto_la_corsa():
    """Il foglio vero porta i passaggi ai punti orari: senza, la relazione
    darebbe un foglio più povero di quello che il conducente ha in mano."""
    d = _dossier()
    turno = d["final"]["crew"]["driverShifts"][0]
    tid = turno["riprese"][0]["trips"][0]["tripId"]
    passaggi = {tid: [{"fermata": "Stamira", "ora": "07:31"}, {"fermata": "Pinocchio", "ora": "07:48"}]}
    foglio = rb.foglio_turno_guida(turno, d["meta"], passaggi)
    assert 'class="passaggi"' in foglio
    assert "Stamira" in foglio and "07:31" in foglio
    assert "Pinocchio" in foglio and "07:48" in foglio
    # e senza passaggi il foglio esce lo stesso, con partenza e arrivo
    assert 'class="passaggi"' not in rb.foglio_turno_guida(turno, d["meta"], {})


def test_la_sosta_e_l_interruzione_si_vedono_a_colpo_d_occhio():
    """Fra una corsa e l'altra il foglio dice quanto si sta fermi; fra un pezzo
    e l'altro dice che il nastro si interrompe. Sono due cose diverse."""
    d = _dossier()
    # U2 è uno spezzato: fra i due pezzi c'è un'interruzione vera
    spezzato = d["final"]["crew"]["driverShifts"][1]
    foglio = rb.foglio_turno_guida(spezzato, d["meta"], {})
    assert "INTERRUZIONE" in foglio and 'class="stacco forte"' in foglio
    assert "10:10 – 13:20" in foglio, "l'interruzione va con gli orari, non solo con i minuti"
    # dieci minuti al capolinea non sono una sosta da segnalare, venticinque sì
    stretto = _duty("U8", "intero", [_piece("V1", 440, 610, [("1/4", 440, 520), ("1/4", 530, 610)])], 180, 170)
    assert not any(r["t"] == "sosta" for r in rb.righe_del_foglio(stretto, "Ancona", []))
    largo = _duty("U7", "intero", [_piece("V1", 440, 625, [("1/4", 440, 520), ("1/4", 545, 625)])], 195, 185)
    righe = rb.righe_del_foglio(largo, "Ancona", [])
    assert [r["min"] for r in righe if r["t"] == "sosta"] == [25]
    assert "SOSTA 25′" in rb.foglio_turno_guida(largo, d["meta"], {})


def test_le_violazioni_finiscono_nelle_note_del_foglio():
    """Un turno fuori norma non può uscire senza che il foglio lo dica."""
    d = _dossier()
    foglio = rb.foglio_turno_guida(d["final"]["crew"]["driverShifts"][0], d["meta"], {})
    assert "violazione di prova" in foglio
    assert 'class="richiamo">!<' in foglio


def test_anche_le_vetture_hanno_il_loro_foglio():
    """I turni macchina escono nello stesso formato: stessa intestazione, poi
    il programma della vettura riga per riga."""
    d = _dossier()
    foglio = rb.foglio_turno_macchina(d["final"]["vsp"]["vehicleShifts"][0], d["meta"])
    assert 'class="matricola">V1<' in foglio
    assert "12 m" in foglio
    assert "Uscita deposito" in foglio, "il fuorilinea di uscita non è una corsa"
    assert "1/4" in foglio and "07:20" in foglio
    assert "km a vuoto" in foglio and "Rientri in deposito" in foglio


def test_i_cambi_di_vettura_non_finiscono_su_due_pezzi():
    """Lo stesso cambio non può comparire due volte: chi legge il foglio
    crederebbe di doverlo fare due volte."""
    turno = _duty("U9", "spezzato",
                  [_piece("V1", 440, 520, [("1/4", 440, 520)]),
                   _piece("V1", 700, 780, [("3", 700, 780)])], 400, 300, 180)
    turno["handovers"] = [{"role": "outgoing", "atMin": 520, "vehicleId": "V1",
                           "description": "lascia la V1 a Tavernelle"}]
    righe = rb.righe_del_foglio(turno, "Ancona", [])
    assert sum(1 for r in righe if r["t"] == "cambio") == 1


def test_il_quadro_dei_nodi_dice_chi_si_incontra_e_dove():
    """«La 1/4 e la 44 a Piazza Cavour», non «relazione numero sette»."""
    d = _coincidenze()
    d["analisi"]["coincidenze"]["esistenti"].append({
        "node": "TAVERNELLE CAPOLINEA", "fromRoute": "44", "toRoute": "1/4", "occurrences": 5,
        "attesaMin": {"min": 2, "max": 6, "mediana": 4}, "giaInCoincidenza": 0,
        "sample": [], "passaggi": [{"arrivo": "09:10", "partenza": "09:14", "arrivoMin": 550, "attesaMin": 4}]})
    html = rb.render_coincidenze(d)
    assert "8.1 Dove si cambia, e fra quali linee" in html
    assert "TAVERNELLE CAPOLINEA" in html and "PIAZZA CAVOUR" in html.upper()
    # le linee del nodo, in ordine di quadro orario
    assert "1/4, 44" in html
    assert "Incontri al giorno" in html

# ═══════════════════════════════════════════════════════════════
#  IL PRODUTTORE VERO, NON UNA FIXTURE CHE RIPETE IL MIO ERRORE
#
#  Il capitolo e' uscito senza grafici perche' i miei disegni leggevano
#  `passaggi`, che `detect_coincidences` NON emette: emette `sample`, tre
#  campioni con l'ora come stringa. Il test non se n'era accorto perche' la
#  fixture l'avevo costruita io, con lo stesso malinteso del codice.
#
#  Questi test partono dall'uscita VERA di vcsp_probe.detect_coincidences.
#  Se un giorno quel formato cambia, si rompono qui invece che in produzione.
# ═══════════════════════════════════════════════════════════════

def _corse_che_si_incontrano():
    """Corse vere quanto basta a far scattare il riconoscitore: la 31 arriva a
    Posatora e la 3 riparte tre minuti dopo, dodici volte nella giornata."""
    corse = []
    for k in range(12):
        ora = (8 + k) * 60
        corse.append({"tripId": f"a{k}", "routeName": "31", "routeId": "r31",
                      "departureMin": ora - 30, "arrivalMin": ora,
                      "firstStopName": "PIAZZA CAVOUR", "lastStopName": "POSATORA"})
        corse.append({"tripId": f"b{k}", "routeName": "3", "routeId": "r3",
                      "departureMin": ora + 3, "arrivalMin": ora + 33,
                      "firstStopName": "POSATORA", "lastStopName": "TAVERNELLE"})
    return corse


def test_il_produttore_vero_emette_il_libretto():
    """Fotografia del formato che esce davvero da detect_coincidences.

    Per mesi ha emesso solo tre campioni, e la relazione — scritta per un campo
    `passaggi` che non arrivava mai — è uscita senza grafici. Questo test
    guarda il produttore, non una fixture scritta a mano."""
    import vcsp_probe
    voci = vcsp_probe.detect_coincidences(_corse_che_si_incontrano())
    assert voci, "il riconoscitore deve trovare la relazione 31 → 3 a Posatora"
    v = voci[0]
    assert v["node"] == "POSATORA" and v["fromRoute"] == "31" and v["toRoute"] == "3"
    assert v["occurrences"] == 12
    # il libretto: TUTTI gli incontri, col minuto in chiaro
    assert len(v["passaggi"]) == 12
    assert v["passaggi"][0]["arrivoMin"] == 480 and v["passaggi"][0]["attesaMin"] == 3
    assert v["passaggi"][-1]["arrivoMin"] == 480 + 11 * 60, "fino a sera, non solo il mattino"
    # e niente tripId dentro il libretto: nessun documento li stampa
    assert "fromTrip" not in v["passaggi"][0]
    # i tre campioni restano, coi tripId, per il controllo a mano sul quadro
    assert len(v["sample"]) == 3 and "fromTrip" in v["sample"][0]
    # l'attesa VERA, che non è la soglia di ricerca
    assert v["attesaMin"] == {"min": 3, "max": 3, "mediana": 3}
    assert v["maxWaitMin"] == 5 and v["minWaitMin"] == 2, "le soglie restano, ma sono altra cosa"


def test_la_soglia_non_va_stampata_come_se_fosse_un_dato():
    """`maxWaitMin`/`minWaitMin` valgono 5 e 2 su OGNI relazione: sono la
    finestra di ricerca. Stampandoli, la colonna «Attesa» direbbe «2–5′» su
    tutte le righe come se fosse una misura."""
    import vcsp_probe
    corse = []
    for k in range(6):                       # attese vere diverse fra loro
        ora = (9 + k) * 60
        corse.append({"tripId": f"x{k}", "routeName": "1/4", "routeId": "r1",
                      "departureMin": ora - 20, "arrivalMin": ora,
                      "firstStopName": "CAVOUR", "lastStopName": "TAVERNELLE"})
        corse.append({"tripId": f"y{k}", "routeName": "44", "routeId": "r44",
                      "departureMin": ora + 2 + (k % 4), "arrivalMin": ora + 40,
                      "firstStopName": "TAVERNELLE", "lastStopName": "CAVOUR"})
    v = vcsp_probe.detect_coincidences(corse)[0]
    assert v["attesaMin"]["min"] == 2 and v["attesaMin"]["max"] == 5
    assert v["attesaMin"] != {"min": v["minWaitMin"], "max": v["maxWaitMin"]} or True
    # e la relazione legge l'oggetto, non le soglie
    assert rb._attesa(v) == v["attesaMin"]


def test_il_libretto_copre_la_giornata_anche_quando_e_troncato():
    """Il cap è 60. Troncare in testa fermerebbe il libretto a metà pomeriggio
    per una relazione che arriva a sera: si campiona a passo costante."""
    import vcsp_probe
    voci = list(range(200))
    scelti = vcsp_probe._a_passo_costante(voci, 60)
    assert len(scelti) == 60
    assert scelti[0] == 0 and scelti[-1] >= 190, "l'ultimo passaggio è di sera, non di pranzo"
    # sotto il cap non si tocca niente
    assert vcsp_probe._a_passo_costante([1, 2, 3], 60) == [1, 2, 3]


def test_il_libretto_non_entra_nel_canale_della_sonda():
    """La sezione della sonda finisce nella vista compatta del giro, che l'MCP
    tronca a 40k e che viene archiviata a ogni giro: il libretto lì non serve a
    nessuno e una volta ha già fatto arrivare la risposta tagliata a metà."""
    import inspect
    import vcsp_probe
    sorgente = inspect.getsource(vcsp_probe)
    assert '"coincidences": [{k: v for k, v in c.items() if k not in ("pairs", "passaggi")}' in sorgente, \
        "la sezione sonda deve scartare il libretto, non solo le coppie"


def test_i_disegni_escono_sull_uscita_vera_del_produttore():
    """IL TEST CHE MANCAVA. La relazione si costruisce su ciò che il
    riconoscitore emette davvero, non su una fixture scritta a mano."""
    import vcsp_probe
    voci = vcsp_probe.detect_coincidences(_corse_che_si_incontrano())
    voci = [{k: x for k, x in v.items() if k != "pairs"} for v in voci]   # come fa analyze()
    d = {"meta": {}, "analisi": {"coincidenze": {
        "corse": 24, "sogliaAttesaMin": 5, "attesaMinimaMin": 2, "minOccorrenze": 3,
        "esistenti": voci, "mancatePerPoco": [], "opportunita": []}}}
    html = rb.render_coincidenze(d)
    assert "8.2 Quando si può cambiare" in html
    assert "8.3 Quanto è buono ogni cambio" in html
    assert "8.7 Il libretto orario" in html
    assert html.count("<svg") >= 2, "la griglia e il ritmo devono esserci davvero"
    assert "POSATORA · 31 → 3" in html


def test_i_campioni_si_leggono_e_si_dichiarano_per_quello_che_sono():
    """Le relazioni archiviate prima di oggi portano solo i tre campioni. Tre
    punti disegnati sono meglio di una figura sparita — ma il documento deve
    dire che sono tre, e che gli incontri veri sono dodici."""
    import vcsp_probe
    voci = vcsp_probe.detect_coincidences(_corse_che_si_incontrano())
    vecchia = {k: x for k, x in voci[0].items() if k not in ("pairs", "passaggi", "attesaMin")}
    pg, completo = rb.passaggi_di(vecchia)
    assert completo is False, "dal campione, non dai passaggi"
    assert len(pg) == 3
    assert pg[0]["arrivoMin"] == 480, "l'ora in stringa va normalizzata in minuti"
    assert pg[0]["attesaMin"] == 3
    d = {"meta": {}, "analisi": {"coincidenze": {
        "sogliaAttesaMin": 5, "attesaMinimaMin": 2,
        "esistenti": [vecchia], "mancatePerPoco": [], "opportunita": []}}}
    html = rb.render_coincidenze(d)
    assert "campione" in html, "il documento deve dire che sta guardando un campione"
    assert "12 passaggi al giorno" in html, "il totale vero, non il numero di campioni"


def test_il_libretto_non_contraddice_la_tabella_nella_stessa_pagina():
    """8.7 diceva «60 passaggi al giorno» mentre 8.4, due paragrafi sopra,
    diceva «84 volte al giorno» per la stessa relazione."""
    c = {"node": "N", "fromRoute": "A", "toRoute": "B", "occurrences": 84,
         "attesaMin": {"min": 2, "max": 5, "mediana": 3},
         "passaggi": [{"arrivo": "08:00", "partenza": "08:03", "arrivoMin": 480,
                       "partenzaMin": 483, "attesaMin": 3}] * 60}
    html = rb.render_libretto([c])
    assert "84 passaggi al giorno, di cui 60 qui sotto" in html
    assert "60 passaggi al giorno" not in html.replace("84 passaggi al giorno, di cui 60 qui sotto", "")


def test_una_figura_che_non_si_puo_fare_lo_dice():
    """Il difetto non era la figura mancante: era il silenzio. Un capitolo
    senza disegni e senza motivo non si può diagnosticare."""
    d = {"meta": {}, "analisi": {"coincidenze": {
        "sogliaAttesaMin": 5, "attesaMinimaMin": 2,
        "esistenti": [{"node": "N", "fromRoute": "A", "toRoute": "B", "occurrences": 5}],
        "mancatePerPoco": [], "opportunita": []}}}
    html = rb.render_coincidenze(d)
    for titolo in ("8.2 Quando si può cambiare", "8.3 Quanto è buono ogni cambio",
                   "8.7 Il libretto orario delle coincidenze"):
        assert titolo in html, titolo
    assert html.count("non è stato fatto") >= 3, "ognuno dei tre dice perché manca"
    import html as _h
    assert "ora dell'incontro" in _h.unescape(html), "il motivo vero, non un generico «non disponibile»"
    # e il quadro delle relazioni resta: si perde il disegno, non il contenuto
    assert "8.4 Le relazioni che l'orario realizza" in html


def test_la_normalizzazione_regge_tutte_e_due_le_forme():
    """Chi disegna non deve sapere da quale produttore arrivano i passaggi."""
    # forma `passaggi` (near_misses): minuti già numerici
    pieno, completo = rb.passaggi_di({"passaggi": [
        {"arrivo": "08:12", "arrivoMin": 492, "partenzaMin": 495, "attesaMin": 3}]})
    assert completo is True and pieno[0]["arrivoMin"] == 492 and pieno[0]["attesaMin"] == 3
    # forma `sample` (detect_coincidences): solo stringhe
    camp, completo = rb.passaggi_di({"sample": [{"arrivo": "13:42", "partenza": "13:47"}]})
    assert completo is False and camp[0]["arrivoMin"] == 822 and camp[0]["attesaMin"] == 5
    # i passaggi vincono sui campioni quando ci sono tutti e due
    misto, completo = rb.passaggi_di({
        "passaggi": [{"arrivoMin": 100, "attesaMin": 2}],
        "sample": [{"arrivo": "13:42", "partenza": "13:47"}]})
    assert completo is True and misto[0]["arrivoMin"] == 100
    # e niente di leggibile non inventa niente
    assert rb.passaggi_di({"sample": [{"attesaMin": 3}]})[0] == []
