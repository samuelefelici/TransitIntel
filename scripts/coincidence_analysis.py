"""La mappa delle coincidenze del quadro orario, senza lanciare il solver.

Tre domande, una risposta sola:

1. QUALI COINCIDENZE CI SONO — le relazioni fra linee che l'orario realizza
   davvero, capolinea o transito che siano (vcsp_probe.detect_coincidences).
2. QUALI SI PERDONO PER POCO — due linee che si sfiorano a un nodo con
   un'attesa appena fuori soglia. Sono le occasioni: nel festivo di Ancona la 3
   e la 21/33 si incontrano a Posatora con 12 e 20 minuti, e nessuno se n'era
   accorto perche' nessuno le contava.
3. COSA COSTA PRENDERLE — traslando una linea intera di δ minuti (la cadenza
   resta identica: tutte le corse si spostano insieme) quante coincidenze si
   creano e quante se ne rompono altrove. E' il conto che dice se lo
   spostamento conviene, e serve prima di toccare il quadro, non dopo.

Il mattone che si sposta e' la LINEA, non la corsa: e' la mossa che il
pianificatore puo' difendere davanti all'utenza, perche' non cambia la cadenza
ne' le distanze fra le corse. Le mosse fini sulla singola corsa restano alla
sonda del VCSP, che le valuta col solver in mano.
"""
from __future__ import annotations

from vcsp_probe import (
    COINCIDENCE_MAX_WAIT, COINCIDENCE_MIN_OCCURRENCES,
    _node_key, _stop_events, _flex_of, detect_coincidences,
    build_round_trip_pairs, flex_of_round_trip, min_to_time,
)

# Finestra entro cui due linee si considerano «vicine»: oltre, non e' una
# coincidenza mancata per poco, e' un altro orario.
NEAR_MISS_WINDOW = 30
# Attesa MINIMA perche' il cambio sia fattibile: a zero minuti i due mezzi sono
# contemporanei e il passeggero non fa in tempo a scendere e salire. Il valore
# lo decide l'operatore — due minuti e' il tempo di scendere da un mezzo e
# salire sull'altro fermi allo stesso capolinea — e serve a non spacciare per
# opportunita' un orario che nella realta' non si prende. Vale SOLO qui: il
# vincolo del VCSP continua ad accettare da zero minuti in su, per non cambiare
# le coincidenze da difendere senza che l'operatore l'abbia deciso.
COINCIDENCE_MIN_WAIT = 2
# Traslazioni esaminate per ogni linea (minuti).
SHIFT_RANGE = 30


def candidate_pairs(trips: list[dict], window: int = NEAR_MISS_WINDOW,
                    lower: int = 0) -> list[dict]:
    """Tutti gli incontri fra linee diverse allo stesso nodo entro la finestra.

    E' la base di qualunque valutazione: si calcola una volta e si riusa per
    ogni traslazione, invece di rifare il riconoscimento da capo per ogni δ.

    `lower` puo' essere NEGATIVO: per valutare uno spostamento servono anche gli
    incontri che oggi non sono tali — chi parte prima che l'altro arrivi diventa
    una coincidenza se lo si ritarda. Guardare solo le attese positive fa
    scomparire meta' delle occasioni, e fa contare come rotte relazioni che il
    mezzo precedente raccoglie.
    """
    per_nodo: dict[str, dict[str, list]] = {}
    for t in trips:
        for verso, nodo, minuto, capolinea in _stop_events(t):
            per_nodo.setdefault(nodo, {}).setdefault(verso, []).append((t, minuto, capolinea))

    out: list[dict] = []
    for nodo, lati in per_nodo.items():
        for ta, arr, cap_a in lati.get("in", []):
            ra = ta.get("routeName") or ta.get("routeId")
            for tb, dep, cap_b in lati.get("out", []):
                rb = tb.get("routeName") or tb.get("routeId")
                if not ra or not rb or ra == rb:
                    continue
                if not cap_a and not cap_b:
                    continue            # transito contro transito: non e' un nodo
                if not (lower <= dep - arr <= window):
                    continue
                out.append({"node": nodo, "fromRoute": str(ra), "toRoute": str(rb),
                            "fromTrip": ta.get("tripId"), "toTrip": tb.get("tripId"),
                            "arrMin": arr, "depMin": dep})
    return out


def near_misses(trips: list[dict], max_wait: int = COINCIDENCE_MAX_WAIT,
                window: int = NEAR_MISS_WINDOW,
                min_occurrences: int = COINCIDENCE_MIN_OCCURRENCES) -> list[dict]:
    """Le coincidenze che il quadro NON fa, ma per poco.

    Raggruppate per (nodo, linea A → linea B) come quelle vere, cosi' si vede
    subito se e' una relazione sistematica o un incontro isolato.
    """
    rel: dict[tuple[str, str, str], list[dict]] = {}
    gia: dict[tuple[str, str, str], int] = {}
    for p in candidate_pairs(trips, window):
        attesa = p["depMin"] - p["arrMin"]
        chiave = (p["node"], p["fromRoute"], p["toRoute"])
        if attesa <= max_wait:
            gia[chiave] = gia.get(chiave, 0) + 1
            continue                     # questa la coincidenza ce l'ha gia'
        rel.setdefault(chiave, []).append(p)

    out = []
    for (nodo, ra, rb), occ in rel.items():
        if len(occ) < min_occurrences:
            continue
        attese = sorted(p["depMin"] - p["arrMin"] for p in occ)
        out.append({
            "node": nodo, "fromRoute": ra, "toRoute": rb,
            "occurrences": len(occ),
            # La stessa relazione puo' avere gia' altre corse in coincidenza:
            # qui si perde solo una parte del servizio, non tutto.
            "giaInCoincidenza": gia.get((nodo, ra, rb), 0),
            "attesaMin": {"min": attese[0], "max": attese[-1],
                          "mediana": attese[len(attese) // 2]},
            "sample": [{"fromTrip": p["fromTrip"], "arrivo": min_to_time(p["arrMin"]),
                        "toTrip": p["toTrip"], "partenza": min_to_time(p["depMin"]),
                        "attesaMin": p["depMin"] - p["arrMin"]}
                       for p in sorted(occ, key=lambda x: x["arrMin"])[:3]],
        })
    out.sort(key=lambda c: (-c["occurrences"], c["attesaMin"]["mediana"]))
    return out


def _score_shift(pairs: list[dict], route: str, delta: int, min_wait: int,
                 max_wait: int, min_occurrences: int) -> dict:
    """Effetto della traslazione di una linea, contato per RELAZIONE.

    Contare le coppie una per una inganna: anticipando la 21/33 di venti minuti
    le quattro coppie della Madonnetta si rompono, ma la 2/6 passa ogni mezz'ora
    e altre quattro le prendono il posto — la relazione resta viva e il saldo e'
    zero, non +4-4. Quello che conta e' se la relazione, dopo, e' ancora li'.
    """
    prima: dict[tuple[str, str, str], int] = {}
    dopo: dict[tuple[str, str, str], int] = {}
    for p in pairs:
        a_moves = p["fromRoute"] == route
        b_moves = p["toRoute"] == route
        chiave = (p["node"], p["fromRoute"], p["toRoute"])
        att_prima = p["depMin"] - p["arrMin"]
        if min_wait <= att_prima <= max_wait:
            prima[chiave] = prima.get(chiave, 0) + 1
        if not a_moves and not b_moves:
            if min_wait <= att_prima <= max_wait:
                dopo[chiave] = dopo.get(chiave, 0) + 1
            continue
        att_dopo = (p["depMin"] + (delta if b_moves else 0)) - (p["arrMin"] + (delta if a_moves else 0))
        if min_wait <= att_dopo <= max_wait:
            dopo[chiave] = dopo.get(chiave, 0) + 1

    create, rotte = [], []
    for chiave in set(prima) | set(dopo):
        p_n, d_n = prima.get(chiave, 0), dopo.get(chiave, 0)
        n, a, b = chiave
        if d_n >= min_occurrences > p_n:
            create.append({"node": n, "fromRoute": a, "toRoute": b, "occorrenze": d_n})
        elif p_n >= min_occurrences > d_n:
            rotte.append({"node": n, "fromRoute": a, "toRoute": b,
                          "occorrenze": p_n, "restano": d_n})
    create.sort(key=lambda r: -r["occorrenze"])
    rotte.sort(key=lambda r: -r["occorrenze"])
    return {
        "deltaMin": delta,
        "create": len(create), "rotte": len(rotte),
        "netto": len(create) - len(rotte),
        "corseInCoincidenza": {"prima": sum(prima.values()), "dopo": sum(dopo.values())},
        "relazioniCreate": create,
        "relazioniRotte": rotte,
    }


def line_shift_opportunities(trips: list[dict], max_wait: int = COINCIDENCE_MAX_WAIT,
                             shift_range: int = SHIFT_RANGE,
                             window: int = NEAR_MISS_WINDOW,
                             min_occurrences: int = COINCIDENCE_MIN_OCCURRENCES,
                             min_wait: int = COINCIDENCE_MIN_WAIT) -> list[dict]:
    """Per ogni linea, la traslazione che guadagna piu' coincidenze di quante
    ne rompe — col conto di quelle che rompe, sempre, perche' un guadagno che
    costa altrove non e' un guadagno.

    Dice anche se la flessibilita' DICHIARATA in Planning regge quel δ: una
    traslazione che le corse non possono fare e' un'informazione, non un piano.
    """
    # Per valutare una traslazione di ±shift_range servono anche gli incontri
    # che oggi cadono fuori: quelli che il delta porta dentro, e quelli che il
    # delta porta via ma che un altro mezzo raccoglie.
    pairs = candidate_pairs(trips, window=max_wait + shift_range, lower=-shift_range)
    rt_pairs = build_round_trip_pairs(trips)
    by_id = {t.get("tripId"): t for t in trips}

    per_linea: dict[str, list[dict]] = {}
    for t in trips:
        r = str(t.get("routeName") or t.get("routeId") or "")
        if r:
            per_linea.setdefault(r, []).append(t)

    out = []
    for route, corse in per_linea.items():
        flex = min((flex_of_round_trip(t, rt_pairs, by_id) for t in corse), default=0)
        migliori = []
        for d in range(-shift_range, shift_range + 1):
            if d == 0:
                continue
            s = _score_shift(pairs, route, d, min_wait, max_wait, min_occurrences)
            if s["netto"] > 0:
                s["flexDichiarataMin"] = flex
                s["dentroLaFlessibilita"] = abs(d) <= flex
                migliori.append(s)
        if not migliori:
            continue
        migliori.sort(key=lambda s: (-s["netto"], abs(s["deltaMin"])))
        out.append({"route": route, "corse": len(corse),
                    "flexDichiarataMin": flex,
                    "migliore": migliori[0],
                    "alternative": migliori[1:4]})
    out.sort(key=lambda o: -o["migliore"]["netto"])
    return out


def analyze(payload: dict) -> dict:
    """L'analisi completa, pronta da servire."""
    trips = list(payload.get("trips") or [])
    max_wait = int(payload.get("maxWait") or COINCIDENCE_MAX_WAIT)
    window = int(payload.get("nearMissWindow") or NEAR_MISS_WINDOW)
    shift_range = int(payload.get("shiftRange") or SHIFT_RANGE)
    min_occ = int(payload.get("minOccurrences") or COINCIDENCE_MIN_OCCURRENCES)
    min_wait = int(payload.get("minWait") or COINCIDENCE_MIN_WAIT)

    esistenti = detect_coincidences(trips, max_wait=max_wait, min_occurrences=min_occ)
    mancate = near_misses(trips, max_wait=max_wait, window=window, min_occurrences=min_occ)
    opportunita = line_shift_opportunities(trips, max_wait=max_wait, shift_range=shift_range,
                                           window=window, min_occurrences=min_occ,
                                           min_wait=min_wait)
    con_transiti = sum(1 for t in trips if t.get("terminalTransits"))
    return {
        "corse": len(trips),
        "corseConPassaggi": con_transiti,
        "sogliaAttesaMin": max_wait, "attesaMinimaMin": min_wait,
        "minOccorrenze": min_occ,
        "esistenti": [{k: v for k, v in c.items() if k != "pairs"} for c in esistenti],
        "mancatePerPoco": mancate,
        "opportunita": opportunita,
        "nota": ("Le opportunita' traslano la LINEA INTERA dello stesso delta: la cadenza "
                 "resta identica e lo spostamento e' difendibile davanti all'utenza. "
                 "'dentroLaFlessibilita' dice se le corse reggono quel delta secondo la "
                 "flessibilita' dichiarata in Planning; il conto delle rotte e' sempre "
                 "esposto, perche' un guadagno che costa altrove non e' un guadagno."
                 + ("" if con_transiti else
                    " ATTENZIONE: nessuna corsa porta i passaggi intermedi, quindi qui si "
                    "vedono solo le coincidenze fatte da fermo al capolinea.")),
    }


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(analyze(json.load(sys.stdin)), ensure_ascii=False))
