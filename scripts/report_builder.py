#!/usr/bin/env python3
"""Relazione completa di un piano di esercizio: dal progetto di pianificazione
ai turni guida finali. Legge un DOSSIER (JSON) e produce un HTML autonomo,
stampabile in PDF, con testo tecnico, formule, grafici SVG, disegni e costi.

Uso:  python3 report_builder.py dossier.json > relazione.html
      (oppure via stdin: cat dossier.json | python3 report_builder.py)

Schema del dossier (tutte le chiavi sono facoltative: le sezioni senza dati
vengono omesse o dichiarate mancanti, mai inventate):
{
  "meta": {title, subtitle, generatedAt, projectName, udpName, serviceDate,
           dayType, scenarioName, scenarioId, jobId, isTest, testNote, author,
           company},
  "network": {"lines": [{name, routeId, variants, trips, km, firstDep, lastDep,
                         headway, vehicleType, flexMin}],
              "stopsCount", "nodes": [name],
              "polylines": [{name, points: [[lat, lon], …]}],
              "stops": [{name, lat, lon, node}]},
  "planning": {"timeline": [{at, action, who, via, detail}],
               "activityCounts": {action: n}, "decisions": [{kind, content}],
               "plans": [{id, at, goal, summary, status}],
               "validities": [{name, trips, dayTypes}], "flex": [{line, flexMin}]},
  "runs": [{name, scenarioId, at, params, kpi: {vehicles, duties, byType,
            violations, vehicleCostEur, crewCostEur, totalCostEur,
            selectionScoreEur}, rounds: [...], probe: {...}, selected: bool}],
  "final": {"vsp": {"metrics": {...}, "vehicleShifts": [...]},
            "crew": {"summary": {...}, "driverShifts": [...], "metrics": {...}},
            "params": {vcsp, crewConfig, weights, weightFactors, shiftRules,
                       vehicleRates, driverRates, companyCars}},
  "costs": {"unit": [{label, value, unit, source}], "notes": [str]}
}
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
import traceback
from collections import Counter, defaultdict
from typing import Any

import report_charts as rc
from report_charts import esc, hm, fmt_eur, fmt_n, _numero

DUTY_TYPE_ORDER = ["intero", "semiunico", "spezzato", "supplemento"]
DUTY_TYPE_LABEL = {"intero": "Interi", "semiunico": "Semiunici", "spezzato": "Spezzati", "supplemento": "Supplementi"}
COST_COMPONENT_LABEL = {
    "baseSalary": "Paga base (lavoro)", "drivingCost": "Guida", "overtimeCost": "Straordinario", "undertimeCost": "Sotto-lavoro (garantito)",
    "idleAtTerminalCost": "Attese al capolinea", "preTurnoCost": "Pre-turno", "transferDepotCost": "Trasferimenti deposito",
    "interruptionCost": "Interruzioni pagate", "companyCarCost": "Auto aziendale", "taxiCost": "Taxi", "cambioCost": "Cambi in linea",
    "fragmentationPenalty": "Penalità frammentazione", "workImbalancePenalty": "Penalità squilibrio lavoro", "bds5Cost": "Regola BDS5",
    "base": "Paga base (lavoro)", "transfer": "Trasferimenti",
}


def g(d: Any, *path, default=None):
    """Accesso tollerante a chiavi annidate."""
    cur = d
    for p in path:
        if isinstance(cur, dict):
            cur = cur.get(p)
        elif isinstance(cur, list) and isinstance(p, int) and 0 <= p < len(cur):
            cur = cur[p]
        else:
            return default
        if cur is None:
            return default
    return cur


def shadow_eur(d: dict) -> float:
    """Le penalita' d'arco REALIZZATE dal piano, in euro.

    Non sono spesa: le inventa l'orchestratore VCSP per spingere il solver dei
    mezzi lontano dagli accostamenti che il lato guida non sa tagliare. Il VSP
    pero' le somma nel proprio totale, e quel totale finiva nel documento come
    «costo vetture». Un piano che ha ricevuto molto segnale sembrava piu' caro
    di quanto fosse, e due relazioni non erano confrontabili fra loro."""
    agg = g(d, "final", "vsp", "costBreakdown", "aggregated", default={}) or {}
    try:
        return max(0.0, float(agg.get("vcspPenalty") or 0.0))
    except (TypeError, ValueError):
        return 0.0


def vehicle_cost_net(d: dict) -> float:
    """Il costo vetture al netto delle penalita' inventate dal motore."""
    vm = g(d, "final", "vsp", "metrics", default={}) or {}
    try:
        return max(0.0, float(vm.get("costEur") or 0) - shadow_eur(d))
    except (TypeError, ValueError):
        return 0.0


def section(id_: str, title: str, first: bool = False) -> str:
    cls = ' class="first"' if first else ""
    return f'<h2 id="{id_}"{cls}>{esc(title)}</h2>'


def table(headers, rows, numeric_from=1, total=None, cls="") -> str:
    th = "".join(f'<th class="{"num" if i >= numeric_from else ""}">{esc(h)}</th>' for i, h in enumerate(headers))
    body = []
    for r in rows:
        cells = "".join(f'<td class="{"num" if i >= numeric_from else ""}">{c if isinstance(c, str) and c.startswith("<") else esc(c)}</td>' for i, c in enumerate(r))
        body.append(f"<tr>{cells}</tr>")
    if total:
        cells = "".join(f'<td class="{"num" if i >= numeric_from else ""}">{esc(c)}</td>' for i, c in enumerate(total))
        body.append(f'<tr class="total">{cells}</tr>')
    return f'<table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{"".join(body)}</tbody></table>'


def formula(tex_like: str, words: str = "") -> str:
    w = f'<span class="w">{esc(words)}</span>' if words else ""
    return f'<div class="formula">{tex_like}{w}</div>'


def para(t: str) -> str:
    return f"<p>{t}</p>"


def _dur(m) -> str:
    return hm(m) if m is not None else "–"


# ═══════════════════════════════════════════════════════════════
#  Derivazioni dal risultato finale
# ═══════════════════════════════════════════════════════════════

def vehicles_by_hour(vehicle_shifts: list[dict]) -> tuple[list[str], list[int]]:
    """Vetture contemporaneamente in servizio (fuori deposito) per ora."""
    if not vehicle_shifts:
        return [], []
    t0 = min(int(v.get("startMin") or 0) for v in vehicle_shifts)
    t1 = max(int(v.get("endMin") or 0) for v in vehicle_shifts)
    h0, h1 = t0 // 60, t1 // 60 + 1
    labels, counts = [], []
    for h in range(h0, h1 + 1):
        mid = h * 60 + 30
        n = sum(1 for v in vehicle_shifts if int(v.get("startMin") or 0) <= mid < int(v.get("endMin") or 0))
        labels.append(f"{h % 24:02d}")
        counts.append(n)
    return labels, counts


def vehicle_gantt_rows(vehicle_shifts: list[dict]) -> list[dict]:
    rows = []
    for v in vehicle_shifts:
        segs = []
        for t in v.get("trips", []):
            k = t.get("type")
            kind = {"trip": "trip", "deadhead": "deadhead", "depot": "pullout"}.get(k, "trip")
            if k == "deadhead" and t.get("depotLeg"):
                kind = "pullout"
            s, e = int(t.get("departureMin") or 0), int(t.get("arrivalMin") or 0)
            if e <= s:
                continue
            txt = (f'{t.get("routeName") or ""} {t.get("departureTime") or hm(s)}→{t.get("arrivalTime") or hm(e)} '
                   f'{t.get("firstStopName") or ""} → {t.get("lastStopName") or ""}').strip()
            segs.append({"start": s, "end": e, "kind": kind, "label": t.get("routeName") if kind == "trip" else "", "text": txt})
        # soste fra corse consecutive
        segs.sort(key=lambda x: x["start"])
        rows.append({"label": v.get("vehicleId", "?"), "sub": v.get("vehicleType", ""), "segments": segs})
    return rows


def piece_service_bounds(p: dict) -> tuple[int, int]:
    """(inizio, fine) di SERVIZIO di un pezzo: serviceStart/EndMin del motore,
    altrimenti prima partenza / ultimo arrivo delle corse, altrimenti i confini
    di nastro (unica cosa che il greedy emette)."""
    trips = p.get("trips") or []
    s = p.get("serviceStartMin")
    e = p.get("serviceEndMin")
    if s is None:
        s = min((int(t.get("departureMin") or 0) for t in trips if t.get("departureMin") is not None), default=None)
    if e is None:
        e = max((int(t.get("arrivalMin") or 0) for t in trips if t.get("arrivalMin") is not None), default=None)
    if s is None:
        s = int(p.get("startMin") or 0) + int(p.get("preTurnoMin") or 0) + int(p.get("transferMin") or 0)
    if e is None:
        e = int(p.get("endMin") or 0) - int(p.get("transferBackMin") or 0)
    return int(s), int(e)


def duty_gantt_rows(driver_shifts: list[dict]) -> list[dict]:
    rows = []
    for d in driver_shifts:
        segs = []
        pieces = d.get("riprese") or []
        for i, p in enumerate(pieces):
            trips = p.get("trips") or []
            for t in trips:
                s, e = int(t.get("departureMin") or 0), int(t.get("arrivalMin") or 0)
                if e > s:
                    segs.append({"start": s, "end": e, "kind": "trip", "label": t.get("routeName") or "",
                                 "text": f'{t.get("routeName") or ""} {hm(s)}→{hm(e)} bus {t.get("vehicleId") or ""}'})
            if not trips:
                s, e = int(p.get("startMin") or 0), int(p.get("endMin") or 0)
                if e > s:
                    segs.append({"start": s, "end": e, "kind": "trip", "text": f"pezzo {hm(s)}→{hm(e)}"})
            if p.get("carPoolOut"):
                c = p["carPoolOut"]
                segs.append({"start": int(c.get("departMin") or 0), "end": int(c.get("arriveMin") or 0), "kind": "car", "text": c.get("description") or "auto aziendale"})
            if p.get("carPoolReturn"):
                c = p["carPoolReturn"]
                segs.append({"start": int(c.get("departMin") or 0), "end": int(c.get("arriveMin") or 0), "kind": "car", "text": c.get("description") or "auto aziendale"})
            if i + 1 < len(pieces):
                nxt = pieces[i + 1]
                # stacco di SERVIZIO (come interruptionMin del motore), non di nastro
                s, e = piece_service_bounds(p)[1], piece_service_bounds(nxt)[0]
                if e > s:
                    segs.append({"start": s, "end": e, "kind": "break", "text": f"interruzione {hm(s)}→{hm(e)} ({e - s}′)"})
        segs = [s for s in segs if s["end"] > s["start"]]
        segs.sort(key=lambda x: x["start"])
        rows.append({"label": f'{d.get("driverId", "?")} · {(d.get("type") or "")[:4]}', "sub": d.get("type"), "segments": segs})
    return rows


def deadhead_table(vehicle_shifts: list[dict]) -> tuple[list, dict]:
    rows = []
    agg = Counter()
    for v in vehicle_shifts:
        for t in v.get("trips", []):
            if t.get("type") == "deadhead":
                km = float(t.get("deadheadKm") or 0)
                mn = int(t.get("deadheadMin") or 0)
                leg = t.get("depotLeg") or "linea"
                rows.append((v.get("vehicleId"), hm(t.get("departureMin")), t.get("firstStopName") or "–", t.get("lastStopName") or "–", leg, mn, km))
                agg[leg] += km
    return rows, agg


def crew_stats(driver_shifts: list[dict]) -> dict:
    by_type = Counter(d.get("type") for d in driver_shifts)
    nastro = [int(d.get("nastroMin") or 0) for d in driver_shifts]
    work = [int(d.get("workMin") or 0) for d in driver_shifts]
    interruptions = [int(d.get("interruptionMin") or 0) for d in driver_shifts if d.get("type") in ("semiunico", "spezzato")]
    cambi = sum(int(d.get("cambiCount") or 0) for d in driver_shifts)
    cost = sum(float(d.get("costEuro") or 0) for d in driver_shifts)
    viol = 0
    viol_msgs = Counter()
    warn = 0
    warn_msgs = Counter()
    for d in driver_shifts:
        bv = d.get("bdsValidation") or {}
        for v in bv.get("violations") or []:
            viol += 1
            viol_msgs[(v.get("message") if isinstance(v, dict) else str(v))] += 1
        for v in bv.get("warnings") or []:
            warn += 1
            warn_msgs[(v.get("message") if isinstance(v, dict) else str(v))] += 1
    return {"byType": by_type, "nastro": nastro, "work": work, "interruptions": interruptions,
            "cambi": cambi, "cost": cost, "violations": viol, "violationMsgs": viol_msgs,
            "warnings": warn, "warningMsgs": warn_msgs}


def cars_timeline(driver_shifts: list[dict]) -> tuple[list[str], list[int]]:
    """Auto aziendali fuori (consegna/ritiro) per ora, dai carPool delle riprese."""
    events = []
    for d in driver_shifts:
        for p in d.get("riprese") or []:
            for key in ("carPoolOut", "carPoolReturn"):
                c = p.get(key)
                if c and c.get("departMin") is not None and c.get("arriveMin") is not None:
                    events.append((int(c["departMin"]), int(c["arriveMin"])))
    if not events:
        return [], []
    t0, t1 = min(e[0] for e in events) // 60, max(e[1] for e in events) // 60 + 1
    labels, counts = [], []
    for h in range(t0, t1 + 1):
        n = max((sum(1 for s, e in events if s <= m < e) for m in range(h * 60, h * 60 + 60, 5)), default=0)
        labels.append(f"{h % 24:02d}"); counts.append(n)
    return labels, counts


# ═══════════════════════════════════════════════════════════════
#  Sezioni
# ═══════════════════════════════════════════════════════════════

TOC = [("sintesi", "1. Sintesi"), ("rete", "2. Rete e contesto"),
       ("pianificazione", "3. Pianificazione del servizio"), ("metodo", "4. Metodo e modelli matematici"),
       ("macchina", "5. Turni macchina"), ("guida", "6. Turni guida"),
       ("ciclo", "7. Il ciclo integrato"), ("coincidenze", "8. Coincidenze fra linee"),
       ("costi", "9. Costi"), ("scenari", "10. Scenari confrontati"), ("allegati", "11. Allegati")]


def render_cover(d: dict) -> str:
    """La copertina: un frontespizio, non un titolo e via.

    Questo documento esce dall'azienda e finisce sul tavolo di qualcuno che non
    era nella stanza. Deve dire subito di chi e', di che cosa parla, a quale
    giorno si riferisce e quando e' stato prodotto — e deve reggere la stampa,
    dove una copertina sciatta e' la prima cosa che si nota."""
    m = d.get("meta") or {}
    title = m.get("title") or f'Relazione del piano di esercizio \u00b7 {m.get("udpName") or m.get("projectName") or ""}'
    sub = m.get("subtitle") or ""
    gen = m.get("generatedAt") or _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    azienda = m.get("company") or ""

    out = ['<section class="copertina">']
    out.append('<div class="marchio"><span class="bollo"></span>'
               f'<span class="chi">{esc(azienda) if azienda else "Piano di esercizio"}</span>'
               '<span class="prodotto">TransitIntel</span></div>')
    out.append(f"<h1>{esc(title)}</h1>")
    if sub:
        out.append(f'<p class="lead">{esc(sub)}</p>')

    voci = [("Progetto", m.get("projectName")),
            ("Unit\u00e0 di validit\u00e0", m.get("udpName")),
            ("Giorno di servizio", m.get("serviceDate")),
            ("Giorno-tipo", m.get("dayType")),
            ("Scenario", m.get("scenarioName")),
            ("Redatta da", m.get("author")),
            ("Prodotta il", gen)]
    righe = "".join(f'<div class="voce"><dt>{esc(k)}</dt><dd>{esc(str(v))}</dd></div>'
                    for k, v in voci if v)
    out.append(f'<dl class="frontespizio">{righe}</dl>')
    if m.get("isTest"):
        out.append('<div class="banner"><b>Versione di prova.</b> '
                   + esc(m.get("testNote") or "I costi unitari e i fuorilinea non sono ancora stati "
                                              "verificati: i valori economici sono indicativi.")
                   + "</div>")
    out.append('<nav class="toc"><div class="toc-t">Indice</div>'
               + "".join(f'<div><a href="#{i_}">{esc(t)}</a></div>' for i_, t in TOC)
               + "</nav>")
    out.append("</section>")
    return "".join(out)


def render_summary(d: dict) -> str:
    vm = g(d, "final", "vsp", "metrics", default={}) or {}
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    cs = g(d, "final", "crew", "summary", default={}) or {}
    st = crew_stats(ds)
    n_duties = cs.get("totalDriverShifts") or len(ds)
    vehicles = vm.get("vehicles") or len(g(d, "final", "vsp", "vehicleShifts", default=[]) or [])
    vcost = vehicle_cost_net(d)
    ccost = float(cs.get("totalDailyCost") or st["cost"] or 0)
    total = vcost + ccost
    cars = g(d, "final", "params", "companyCars", default=None)
    car_peak = cs.get("companyCarsMaxSimultaneous")
    tiles = [("Corse coperte", fmt_n(vm.get("totalTrips") or 0), f'{fmt_n(vm.get("totalServiceKm") or 0, 1)} km di linea'),
             ("Vetture", fmt_n(vehicles), f'{fmt_n(vm.get("totalDeadheadKm") or 0, 1)} km fuorilinea'),
             ("Turni guida", fmt_n(n_duties), " · ".join(f'{st["byType"].get(k, 0)} {DUTY_TYPE_LABEL[k].lower()}' for k in DUTY_TYPE_ORDER if st["byType"].get(k))),
             ("Violazioni BDS", fmt_n(st["violations"]), f'{st["warnings"]} avvisi'),
             ("Costo giornaliero", fmt_eur(total), f'vetture {fmt_eur(vcost)} · guida {fmt_eur(ccost)}')]
    if car_peak is not None:
        _mov = cs.get("companyCarsMovements")
        _conf = cs.get("companyCarsConflicts") or 0
        tiles.append(("Auto aziendali (picco)", f'{car_peak}{f" / {cars}" if cars is not None else ""}',
                      (f"{_mov} viaggi per i cambi" if _mov is not None else "cambi in linea") + (f" · {_conf} senza auto" if _conf else "")))
    out = [section("sintesi", "1. Sintesi", first=True), rc.kpi_row(tiles)]
    avg_work = sum(st["work"]) / len(st["work"]) if st["work"] else 0
    avg_nastro = sum(st["nastro"]) / len(st["nastro"]) if st["nastro"] else 0
    msgs = []
    if vehicles:
        msgs.append(f'Il servizio ({fmt_n(vm.get("totalTrips") or 0)} corse) è coperto con <b>{vehicles} vetture</b> e <b>{n_duties} turni guida</b>; '
                    f'lavoro medio {hm(avg_work)}, nastro medio {hm(avg_nastro)}.')
    if st["violations"] == 0 and ds:
        msgs.append("Tutti i turni rispettano le regole di struttura (nastro, lavoro, interruzioni, soste): <b>nessuna violazione</b>.")
    elif ds:
        msgs.append(f'<b>{st["violations"]} violazioni</b> delle regole di struttura da sanare prima dell\'esercizio (dettaglio nel capitolo 6).')
    if st["warnings"]:
        msgs.append(f'{st["warnings"]} avvisi non bloccanti (pause pasto): parametro di severità impostato ad «avviso».')
    if car_peak is not None and cars is not None:
        msgs.append(f'Le auto aziendali per i cambi in linea raggiungono un picco di {car_peak} su {cars} disponibili' + (" (vincolo rispettato)." if car_peak <= cars else " (<b>vincolo superato</b>)."))
    runs = d.get("runs") or []
    if len(runs) >= 2:
        first, last = runs[0], runs[-1]
        k0, k1 = first.get("kpi") or {}, last.get("kpi") or {}
        if k0.get("duties") and k1.get("duties"):
            msgs.append(f'Lungo la campagna di ottimizzazione ({len(runs)} giri) i turni guida sono passati da {k0["duties"]} a {k1["duties"]} '
                        f'e il costo da {fmt_eur(k0.get("totalCostEur"))} a {fmt_eur(k1.get("totalCostEur"))}.')
    for mm in msgs:
        out.append(para(mm))
    if st["byType"]:
        cats = [DUTY_TYPE_LABEL[k] for k in DUTY_TYPE_ORDER if st["byType"].get(k)]
        vals = [st["byType"].get(k, 0) for k in DUTY_TYPE_ORDER if st["byType"].get(k)]
        out.append(rc.bar_h(list(zip(cats, vals)), "Turni guida per tipo", unit="turni",
                            subtitle="Struttura del piano: gli interi sono la forma preferita nel festivo."))
    return "".join(out)


def render_network(d: dict) -> str:
    net = d.get("network") or {}
    lines = net.get("lines") or []
    out = [section("rete", "2. Rete e contesto")]
    if not lines and not net.get("polylines"):
        out.append(para("<i>Dati di rete non disponibili nel dossier.</i>"))
        return "".join(out)
    nodi = net.get("nodes") or []
    out.append(para(f'La rete del giorno-tipo comprende <b>{len(lines)} linee</b>'
                    + (f' e {fmt_n(net["stopsCount"])} fermate' if net.get("stopsCount") else "")
                    + (f', e tocca <b>{fmt_n(len(nodi))} nodi di interscambio</b>.' if nodi else ".")))
    out.append("<h3>2.1 Le linee</h3>")
    rows = []
    for l in sorted(lines, key=lambda x: -(x.get("trips") or 0)):
        rows.append((l.get("name"), l.get("variants") or "–", fmt_n(l.get("trips") or 0), fmt_n(l.get("km") or 0, 1),
                     l.get("firstDep") or "–", l.get("lastDep") or "–", l.get("headway") or "–", l.get("vehicleType") or "–",
                     f'±{l["flexMin"]}′' if l.get("flexMin") else "–"))
    tot_trips = sum(l.get("trips") or 0 for l in lines)
    tot_km = sum(l.get("km") or 0 for l in lines)
    out.append(table(["Linea", "Varianti", "Corse", "km", "Prima", "Ultima", "Cadenza", "Vettura", "Flessibilità"], rows,
                     numeric_from=1, total=("Totale", "", fmt_n(tot_trips), fmt_n(tot_km, 1), "", "", "", "", "")))
    if lines:
        out.append(rc.bar_h([(l.get("name"), l.get("trips") or 0) for l in sorted(lines, key=lambda x: -(x.get("trips") or 0))],
                            "Corse per linea", unit="corse"))
    out.append(render_nodi(net))
    if net.get("polylines"):
        out.append("<h3>2.3 Il disegno della rete</h3>")
        out.append(rc.network_map([{"name": pl.get("name"), "points": rc.alleggerisci(pl.get("points") or [])}
                                   for pl in net["polylines"]],
                                  net.get("stops") or [], "Disegno della rete",
                                  subtitle="Tracciati delle linee del giorno-tipo; i nodi di interscambio sono evidenziati.",
                                  note="Proiezione equirettangolare semplificata; le prime otto linee hanno una tinta propria, le altre sono in grigio."))
    out.append(render_percorsi(net))
    out.append(render_territorio(d))
    return "".join(out)


MEZZI_PENDOLARI = {'car_driver': 'auto, alla guida', 'car_passenger': 'auto, passeggero', 'bus_urban': 'bus urbano', 'bus_extraurban': 'bus extraurbano', 'train': 'treno', 'bike': 'bicicletta', 'walk': 'a piedi', 'other': 'altro'}

FASCE_PENDOLARI = {'before_715': 'prima delle 7:15', '715_815': '7:15 – 8:15', '815_915': '8:15 – 9:15', 'after_915': 'dopo le 9:15'}

MOTIVI_PENDOLARI = {'work': 'lavoro', 'study': 'studio'}


def _voci(elenco, dizionario) -> list:
    """Le voci di una ripartizione, tradotte e col peso in percentuale."""
    righe = [v for v in (elenco or []) if isinstance(v, dict)]
    tot = sum(int(v.get("n") or 0) for v in righe) or 1
    return [(dizionario.get(v.get("nome"), v.get("nome") or ""), fmt_n(v.get("n") or 0),
             f'{(int(v.get("n") or 0) / tot * 100):.0f} %') for v in righe]


def render_territorio(d: dict) -> str:
    """2.5 — IL TERRITORIO: chi ci abita, come si muove, quanto e' trafficato.

    La rete non esiste nel vuoto. Qui ci sono i due dati di contesto che
    spiegano la domanda e i tempi di percorrenza: gli spostamenti pendolari del
    Censimento e i rilievi di traffico. I pendolari stanno a livello COMUNALE,
    e va detto: dicono chi entra e chi esce da un comune, non chi sale a una
    fermata."""
    t = g(d, "analisi", "territorio", default=None)
    if not isinstance(t, dict) or (not t.get("pendolari") and not t.get("traffico")):
        return ""
    out = ["<h3>2.5 Il territorio e come si muove</h3>"]
    com = t.get("comune") if isinstance(t.get("comune"), dict) else {}
    if com.get("nome"):
        out.append(para(f'Il piano insiste sul comune di <b>{esc(com["nome"])}</b> '
                        f'({fmt_n(com.get("abitanti") or 0)} abitanti nelle sezioni di censimento '
                        f'sotto la rete).'))

    p_ = t.get("pendolari") if isinstance(t.get("pendolari"), dict) else None
    if p_:
        ent = p_.get("entrano") or {}
        esc_ = p_.get("escono") or {}
        inte = p_.get("interni") or {}
        out.append("<h4>Chi entra e chi esce</h4>")
        out.append(para(
            f'{esc(p_.get("fonte") or "Censimento ISTAT")}. Il dato è a livello '
            f'<b>{esc(p_.get("livello") or "comunale")}</b>: dice quante persone si spostano da un '
            f'comune all\'altro per lavoro o per studio, con quale mezzo e in quale fascia — '
            f'non quante salgono a una fermata. È il bacino potenziale, non la domanda servita.'))
        out.append(rc.kpi_row([
            ("In entrata", fmt_n(ent.get("totale") or 0), "da altri comuni"),
            ("In uscita", fmt_n(esc_.get("totale") or 0), "verso altri comuni"),
            ("Dentro il comune", fmt_n(inte.get("totale") or 0), "spostamenti interni"),
        ]))
        for titolo, dati in (("Da dove arrivano", ent.get("comuni")), ("Dove vanno", esc_.get("comuni"))):
            righe = [(v.get("nome") or "", fmt_n(v.get("n") or 0)) for v in (dati or []) if isinstance(v, dict)]
            if righe:
                out.append(table([titolo, "Persone"], righe, numeric_from=1))
        for titolo, dati, diz in (("Con quale mezzo entrano", ent.get("mezzi"), MEZZI_PENDOLARI),
                                  ("In quale fascia entrano", ent.get("fasce"), FASCE_PENDOLARI),
                                  ("Per quale motivo entrano", ent.get("motivi"), MOTIVI_PENDOLARI)):
            righe = _voci(dati, diz)
            if righe:
                out.append(table([titolo, "Persone", "Quota"], righe, numeric_from=1))
        mezzi_int = _voci(inte.get("mezzi"), MEZZI_PENDOLARI)
        if mezzi_int:
            out.append(table(["Mezzo dentro il comune", "Persone", "Quota"], mezzi_int, numeric_from=1))

    tr = t.get("traffico") if isinstance(t.get("traffico"), dict) else None
    if tr and (tr.get("perOra") or tr.get("peggiori")):
        ore = [x for x in (tr.get("perOra") or []) if isinstance(x, dict)]
        out.append("<h4>Il traffico sulle strade della rete</h4>")
        out.append(para(
            f'Rilievi di velocità sui segmenti stradali dentro l\'area della rete '
            f'({fmt_n(tr.get("rilievi") or 0)} misure). La <b>congestione</b> è quanto la velocità '
            f'reale sta sotto quella a strada libera: è il motivo per cui i tempi di percorrenza '
            f'del quadro orario sono quelli, e cambia con l\'ora.'))
        if ore:
            out.append(rc.lines([f'{int(x.get("ora") or 0):02d}' for x in ore],
                                [("velocità reale", [float(x.get("velocita") or 0) for x in ore]),
                                 ("a strada libera", [float(x.get("libera") or 0) for x in ore])],
                                "Velocità ora per ora", subtitle="km/h medi sui segmenti dell'area"))
            out.append(table(["Ora", "Congestione", "Velocità", "A strada libera", "Rilievi"],
                             [(f'{int(x.get("ora") or 0):02d}:00', f'{float(x.get("congestione") or 0) * 100:.0f} %',
                               f'{float(x.get("velocita") or 0):.0f} km/h', f'{float(x.get("libera") or 0):.0f} km/h',
                               fmt_n(x.get("rilievi") or 0)) for x in ore], numeric_from=1))
        peg = [x for x in (tr.get("peggiori") or []) if isinstance(x, dict)]
        if peg:
            out.append(table(["Segmento", "Congestione", "Velocità", "A strada libera", "Rilievi"],
                             [(x.get("segmento") or "", f'{float(x.get("congestione") or 0) * 100:.0f} %',
                               f'{float(x.get("velocita") or 0):.0f} km/h', f'{float(x.get("libera") or 0):.0f} km/h',
                               fmt_n(x.get("rilievi") or 0)) for x in peg], numeric_from=1))
    return "".join(out)


def render_nodi(net: dict) -> str:
    """2.2 — I NODI DI INTERSCAMBIO: quali sono, e che cosa raggruppano.

    Qui finivano i cluster di tutta la rete aziendale: su un piano urbano di
    Ancona comparivano Jesi, Osimo, Chiaravalle e Castelferretti, che nessuna
    di queste linee tocca, e lo stesso nodo era ripetuto otto volte. Ora ci
    sono solo i nodi attraversati davvero, ognuno con le fermate che tiene
    insieme — perche' «Piazza Cavour» per un cambio vettura non e' un punto,
    e' un gruppo di banchine."""
    gruppi = [c for c in (net.get("clusters") or []) if isinstance(c, dict) and c.get("stops")]
    if not gruppi:
        nodi = net.get("nodes") or []
        if not nodi:
            return ""
        return ("<h3>2.2 I nodi di interscambio</h3>"
                + para("Nodi attraversati dalle linee del piano: " + esc(", ".join(nodi)) + ".")
                + para('<span class="small">Il dettaglio delle fermate raggruppate non è disponibile '
                       'in questo dossier.</span>'))
    out = ["<h3>2.2 I nodi di interscambio</h3>"]
    fermate = sum(len(c["stops"]) for c in gruppi)
    out.append(para(
        f'Un nodo di interscambio non è una fermata: è il gruppo di fermate fra le quali un conducente '
        f'può passare a piedi per cambiare vettura. Il piano ne attraversa <b>{fmt_n(len(gruppi))}</b>, '
        f'che tengono insieme <b>{fmt_n(fermate)} fermate</b>. Sono solo quelli toccati da queste linee: '
        f'i nodi delle altre zone della rete aziendale non compaiono.'))
    out.append(rc.cluster_map(gruppi, "Dove stanno i nodi",
                              subtitle="Ogni cerchio è un nodo; fra parentesi quante fermate tiene insieme."))
    out.append(para(
        "Nella mappa d'insieme un nodo è un cerchio piccolo, e i nomi delle sue fermate non ci "
        "starebbero. Qui sotto ciascuno da vicino, con le banchine fra cui il conducente passa a piedi."))
    out.append('<div class="griglia-mappe">')
    for i_, c in enumerate(gruppi):
        out.append(rc.nodo_map(c, rc.SERIES[i_ % len(rc.SERIES)]))
    out.append("</div>")
    return "".join(out)


def render_percorsi(net: dict) -> str:
    """2.4 — I PERCORSI, uno per uno.

    Il disegno della rete tiene una variante per linea per restare leggibile.
    Qui invece ogni percorso ha la sua mappa, andata e ritorno separate, con le
    fermate che serve."""
    perc = [p for p in (net.get("percorsi") or []) if isinstance(p, dict) and p.get("points")]
    if not perc:
        return ""
    out = ["<h3>2.4 I percorsi, linea per linea</h3>"]
    out.append(para(
        f'Il disegno della rete qui sopra tiene una variante per linea, o diventa illeggibile. '
        f'Questi sono i <b>{fmt_n(len(perc))} percorsi</b> del piano presi uno per uno: per ciascuno '
        f'il tracciato, la popolazione che ha a portata di piedi e i poli attrattori che serve.'))
    righe = []
    for p_ in perc:
        righe.append((p_.get("line") or "–", p_.get("variant") or "–",
                      "andata" if int(p_.get("direction") or 0) == 0 else "ritorno",
                      fmt_n(len(p_.get("stops") or [])), "sì" if p_.get("isDefault") else "no"))
    out.append(table(["Linea", "Variante", "Verso", "Fermate", "Predefinita"], righe, numeric_from=3))
    cop = net.get("coperturaPedonale") if isinstance(net.get("coperturaPedonale"), dict) else {}
    con_iso = sum(1 for p_ in perc if p_.get("isocrone"))
    if con_iso:
        testo = (f'Su ogni percorso è disegnata anche la <b>copertura pedonale</b> delle sue fermate: '
                 f'l\'area tratteggiata è quanto si raggiunge <b>a piedi in '
                 f'{fmt_n(cop.get("minuti") or 10)} minuti</b> da ciascuna, '
                 f'camminando sulle strade vere e non in linea d\'aria. '
                 f'Vale per tutte le mappe che seguono.')
        coperte, tetto = cop.get("fermateCoperte") or 0, cop.get("tetto") or 0
        if tetto and coperte >= tetto:
            testo += (f' Il calcolo si ferma a {fmt_n(tetto)} fermate nuove per relazione: le altre '
                      f'entreranno alla prossima generazione, quando queste saranno gi\u00e0 in archivio.')
        out.append(para(testo))
    elif cop and not cop.get("disponibile"):
        out.append(para('<span class="small">La copertura pedonale non è disegnata: manca il servizio '
                        'di calcolo delle isocrone.</span>'))
    for p_ in perc:
        verso = "andata" if int(p_.get("direction") or 0) == 0 else "ritorno"
        nome = f'{p_.get("line")} · {p_.get("variant") or verso} ({verso})'
        fermate = [{**f_, "n": k + 1} for k, f_ in enumerate(p_.get("stops") or [])]
        out.append(rc.network_map(
            [{"name": p_.get("line") or "", "color": p_.get("color"),
              "points": rc.alleggerisci(p_.get("points") or [])}],
            [{**s_, "node": False} for s_ in fermate],
            nome, subtitle=f'{fmt_n(len(fermate))} fermate servite',
            width=820, height=460,
            isocrone=[i for i in (p_.get("isocrone") or []) if isinstance(i, dict)],
            etichetta_fermate=len(fermate) <= 10))
        out.append(render_copertura(p_))
    return "".join(out)


def render_copertura(perc: dict) -> str:
    """Che cosa serve davvero un percorso: gente e poli attrattori.

    L'elenco delle fermate sotto la mappa non dice niente che la mappa non
    mostri gia'. Quello che non si vede e' quanta gente quel percorso ha a
    portata di piedi e che cosa le porta vicino: e' questo il motivo per cui
    la linea esiste."""
    cop = perc.get("copertura") if isinstance(perc.get("copertura"), dict) else None
    if not cop:
        return ""
    cat = [c for c in (cop.get("categorie") or []) if isinstance(c, dict)]
    out = [rc.kpi_row([
        ("Popolazione raggiunta", fmt_n(cop.get("abitanti") or 0),
         f'in {fmt_n(cop.get("sezioni") or 0)} sezioni di censimento'),
        ("Poli attrattori serviti", fmt_n(cop.get("poi") or 0),
         f'{fmt_n(len(cat))} categorie diverse'),
    ])]
    if cat:
        # un elenco di numeri non fa vedere che una categoria pesa quanto tutte
        # le altre messe insieme: le barre lo fanno. La tabella resta sotto il
        # disegno, dentro il riquadro richiudibile della figura.
        out.append(rc.categorie_poi([(c.get("nome") or "", int(c.get("n") or 0)) for c in cat[:18]],
                                   "Poli attrattori serviti, per categoria",
                                   subtitle="Il simbolo dice di che cosa si tratta, la barra quanti sono."))
        if len(cat) > 18:
            out.append(para(f'<span class="small">... e altre {fmt_n(len(cat) - 18)} categorie '
                            f'con pochi poli ciascuna.</span>'))
    return "".join(out)


def render_planning(d: dict) -> str:
    pl = d.get("planning") or {}
    out = [section("pianificazione", "3. Pianificazione del servizio")]
    dec = pl.get("decisions") or []
    if dec:
        out.append("<h3>3.1 Decisioni e vincoli di impianto</h3>")
        out.append("<ul>" + "".join(f'<li><b>{esc((x.get("kind") or "nota").capitalize())}.</b> {esc(x.get("content") or "")}</li>' for x in dec) + "</ul>")
    plans = pl.get("plans") or []
    if plans:
        out.append("<h3>3.2 Piani di lavoro eseguiti dall'agente</h3>")
        out.append(table(["#", "Data", "Obiettivo", "Esito", "Stato"],
                         [(p.get("id"), (p.get("at") or "")[:16], (p.get("goal") or "")[:180], (p.get("summary") or "")[:220], p.get("status")) for p in plans],
                         numeric_from=99))
    tl = pl.get("timeline") or []
    if tl:
        out.append("<h3>3.3 Cronologia delle modifiche al progetto</h3>")
        counts = pl.get("activityCounts") or Counter(x.get("action") for x in tl)
        out.append(para("Registro attività del progetto (con attribuzione operatore/agente): " +
                        ", ".join(f'{esc(k)} ×{v}' for k, v in sorted(dict(counts).items(), key=lambda kv: -kv[1])[:12]) + "."))
        items = []
        for x in tl[:60]:
            who = x.get("who") or ""
            via = f' <span class="small">via {esc(x["via"])}</span>' if x.get("via") else ""
            items.append(f'<li><span class="t">{esc((x.get("at") or "")[:16])}</span> · <b>{esc(x.get("action") or "")}</b>{via} {esc(x.get("detail") or "")} <span class="small">{esc(who)}</span></li>')
        out.append(f'<ul class="timeline">{"".join(items)}</ul>')
        if len(tl) > 60:
            out.append(para(f'<span class="small">… e altre {len(tl) - 60} registrazioni (l\'elenco completo è nel registro attività del progetto).</span>'))
    val = pl.get("validities") or []
    if val:
        out.append("<h3>3.4 Validità e giorni-tipo</h3>")
        out.append(table(["Unità di validità", "Corse", "Giorni-tipo"], [(v.get("name"), fmt_n(v.get("trips") or 0), ", ".join(v.get("dayTypes") or [])) for v in val], numeric_from=1))
    flex = pl.get("flex") or []
    if flex:
        out.append("<h3>3.5 Flessibilità dichiarata per la sonda di spostamento</h3>")
        out.append(para("Per ciascuna linea è dichiarato di quanti minuti una corsa può essere spostata dall'ottimizzatore senza riaprire la pianificazione: "
                        + ", ".join(f'{esc(f.get("line"))} ±{f.get("flexMin")}′' for f in flex) + "."))
    if not (dec or plans or tl or val or flex):
        out.append(para("<i>Nessuna traccia di pianificazione nel dossier.</i>"))
    return "".join(out)


def render_method(d: dict) -> str:
    p = g(d, "final", "params", default={}) or {}
    rules = p.get("shiftRules") or {}
    wf = p.get("weightFactors") or {}
    weights = p.get("weights") or {}
    vcsp = p.get("vcsp") or {}
    out = [section("metodo", "4. Metodo e modelli matematici")]
    out.append(para("Il piano è prodotto in tre livelli collegati: la <b>pianificazione</b> definisce rete, orari e validità; il "
                    "<b>turno macchina</b> (VSP) assegna le corse alle vetture; il <b>turno guida</b> (CSP) taglia i turni macchina in pezzi "
                    "e li ricompone in turni conformi alla normativa. Un ciclo di coordinamento (VCSP) fa dialogare i due livelli e una "
                    "<b>sonda di spostamento</b> verifica se piccoli ritocchi d'orario, entro la flessibilità dichiarata, migliorano il totale."))
    out.append("<h3>4.1 Turni macchina: problema di scheduling veicoli multi-deposito (MDVSP)</h3>")
    out.append(para("Le corse sono nodi di un grafo orientato nel tempo; un arco (i, j) esiste se la vettura che termina la corsa i può iniziare la corsa j "
                    "(arrivo + tempo di giro banchina + eventuale fuorilinea ≤ partenza) con un tipo di vettura compatibile. Ogni catena dal deposito al deposito è un turno macchina."))
    out.append(formula("min &nbsp; Σ<sub>v</sub> c<sub>fix</sub>·y<sub>v</sub> + Σ<sub>(i,j)</sub> (c<sub>km</sub>·km<sub>ij</sub> + c<sub>min</sub>·t<sub>ij</sub> + π<sub>ij</sub>)·x<sub>ij</sub>",
                       "y_v = 1 se la vettura v è usata; x_ij = 1 se la corsa j segue la corsa i sulla stessa vettura; c_fix costo fisso giornaliero per vettura; km_ij, t_ij chilometri e minuti di fuorilinea fra i e j; π_ij penalità d'arco ricevute dal livello guida (VCSP)."))
    out.append(formula("s.t. &nbsp; Σ<sub>i</sub> x<sub>ij</sub> = 1 ∀ corsa j &nbsp;·&nbsp; Σ<sub>j</sub> x<sub>ij</sub> = Σ<sub>k</sub> x<sub>ki</sub> ∀ i &nbsp;·&nbsp; Σ<sub>v</sub> y<sub>v</sub> ≤ F<sub>tipo</sub> &nbsp;·&nbsp; x<sub>ij</sub> = 0 se tipo(i) ≁ tipo(j)",
                       "ogni corsa è coperta esattamente una volta; conservazione del flusso su ogni corsa; tetto di flotta per tipo di vettura; compatibilità dei tipi (downsize ammesso solo se dichiarato)."))
    out.append(para("Il modello è risolto con CP-SAT (OR-Tools) in più scenari (strategie di costo diverse), scegliendo la soluzione a costo minimo; "
                    "i fuorilinea sono ammessi solo fra coppie di capolinea dichiarate e con la percorrenza stimata dalla matrice di fuorilinea del progetto."))
    out.append("<h3>4.2 Turni guida: tagli, pezzi e accoppiamento (CSP v4)</h3>")
    out.append(para("Ogni turno macchina viene tagliato nei punti di cambio ammessi (nodi con relief point, fra due corse o dentro una corsa a una fermata di cambio). "
                    "La <b>segmentazione</b> sceglie i tagli con una programmazione dinamica che mira a pezzi accoppiabili (lunghezza obiettivo dipendente dalle regole di struttura), "
                    "in gara fra più varianti (storica e pair-aware a diversi bersagli): vince la variante con il punteggio migliore. "
                    "I pezzi sono poi ricomposti in turni con un modello di partizione:"))
    out.append(formula("min &nbsp; Σ<sub>s∈S</sub> c<sub>s</sub>·z<sub>s</sub> + Σ<sub>(a,b)∈P</sub> c<sub>ab</sub>·w<sub>ab</sub> + λ<sub>sat</sub>·Σ<sub>s</sub> u<sub>s</sub> &nbsp;&nbsp; s.t. &nbsp; z<sub>s</sub> + Σ<sub>b</sub> w<sub>sb</sub> + Σ<sub>a</sub> w<sub>as</sub> = 1 ∀ pezzo s",
                       "z_s = 1 se il pezzo s è un turno da solo (intero); w_ab = 1 se i pezzi a e b formano un turno a due riprese (intero composto, semiunico o spezzato); ogni pezzo sta in esattamente un turno; u_s marca i pezzi corti lasciati soli (saturazione), penalizzati con λ_sat invece di essere vietati."))
    out.append(para("Il costo di un turno c = costo economico (paga per il lavoro, trasferimenti, indennità) × fattori di forma. I fattori derivano dalle manopole dell'operatore "
                    "(numero turni, bilanciamento, supplementi, spezzati, trasferimenti, qualità) normalizzate ai valori di default e limitate all'intervallo [0,15; 3]. "
                    "Il fattore «spezzati» è quadratico e i turni interi ricevono l'inverso, così la preferenza per gli interi è una leva reale e non un ritocco cosmetico."))
    if wf:
        out.append(table(["Fattore", "Valore"], [(k, fmt_n(v, 3)) for k, v in wf.items()], numeric_from=1))
    if weights:
        out.append(para("Manopole impostate: " + ", ".join(f'{esc(k)} = {esc(v)}' for k, v in weights.items()) + "."))
    out.append("<h3>4.3 Regole di struttura del turno (BDS)</h3>")
    out.append(para("Le regole applicate a ogni turno; vincoli inviolabili per il modello, con l'eccezione delle pause pasto trattate come avvisi quando la severità è impostata così."))
    if rules:
        rows = []
        for k in DUTY_TYPE_ORDER:
            r = rules.get(k)
            if not r:
                continue
            rows.append((DUTY_TYPE_LABEL[k], hm(r.get("maxNastro")), hm(r.get("maxLavoro")),
                         hm(r.get("intMin")) if r.get("intMin") else "–", hm(r.get("intMax")) if r.get("intMax") and r.get("intMax") < 999 else "–",
                         f'{r.get("maxPct")}%' if r.get("maxPct") is not None else "–",
                         f'{r.get("sostaMinCapolinea")}′' if r.get("sostaMinCapolinea") else "–"))
        out.append(table(["Tipo", "Nastro max", "Lavoro max", "Interruzione min", "Interruzione max", "Quota max", "Sosta min capolinea"], rows, numeric_from=1))
    else:
        out.append(para("<i>Regole non presenti nel dossier: valgono i default del motore (intero 7:15; semiunico 9:15 con interruzione 1:15–2:59; spezzato 10:30 con interruzione ≥ 3:00).</i>"))
    out.append(para("Un turno a due riprese con stacco inferiore all'interruzione minima del semiunico è un <b>intero composto</b> (cambio vettura in linea senza interruzione): "
                    "nastro = lavoro ≤ limite dell'intero, sosta minima al capolinea garantita dentro un pezzo o allo stacco, cambio a piedi se allo stesso nodo o con lo stesso bus, "
                    "altrimenti stacco ≥ 30′ per il trasferimento. Il picco di auto aziendali fuori contemporaneamente è verificato dopo la soluzione e riportato come vincolo."))
    out.append("<h3>4.4 Coordinamento fra i livelli (VCSP) e selezione</h3>")
    out.append(para("I due modelli sono risolti a turno: dopo ogni soluzione guida, gli archi del turno macchina che hanno prodotto turni costosi o violazioni ricevono una penalità π<sub>ij</sub> "
                    "(costo-ombra) e il turno macchina viene ricalcolato. Ogni round è valutato con un punteggio unico, e resta il round migliore:"))
    out.append(formula(f"Punteggio = C<sub>vetture</sub> + C<sub>guida</sub> + n<sub>turni</sub>·{fmt_n(vcsp.get('dutyShadowEur', 200))} € + n<sub>violazioni</sub>·{fmt_n(vcsp.get('violationShadowEur', 100))} €",
                       "le ombre traducono in euro il valore gestionale di un turno in meno e di una violazione in meno, oltre al costo contabile."))
    out.append("<h3>4.5 Sonda di spostamento</h3>")
    out.append(para("A convergenza, la sonda cerca spostamenti di singole corse entro la flessibilità dichiarata in pianificazione: candidati guidati dai mezzi (fusione di due turni macchina) "
                    "e candidati guidati dai turni (ritocco della corsa al confine dello stacco di una bi-ripresa, per farne un intero composto). Ogni candidato è verificato con un ricalcolo completo e accettato solo se abbassa il punteggio, "
                    "comprensivo di un <b>costo del disturbo</b> all'orario pubblicato:"))
    out.append(formula(f"Accetta se &nbsp; Punteggio′ + δ·Σ|Δt<sub>corsa</sub>| &lt; Punteggio &nbsp;&nbsp; (δ = {fmt_n(vcsp.get('shiftPenaltyEur', 1), 2)} € per corsa·minuto)",
                       "un candidato che muove molte corse deve guadagnare molto; le proposte accettate restano da approvare dall'operatore prima di essere applicate al piano."))
    out.append("<h3>4.6 Modello dei costi</h3>")
    out.append(formula("C<sub>guida</sub> = Σ<sub>turni</sub> [ r<sub>h</sub>·lavoro/60 + r<sub>h</sub>·(trasf<sub>andata</sub> + trasf<sub>ritorno</sub>)/60 + indennità(tipo) ] &nbsp;·&nbsp; C<sub>vetture</sub> = Σ<sub>v</sub> c<sub>fix</sub> + c<sub>km</sub>·km<sub>vuoto</sub> + c<sub>min</sub>·min<sub>vuoto</sub>",
                       "r_h tariffa oraria conducente; i trasferimenti deposito↔punto di cambio sono pagati; l'indennità dipende dal tipo di turno (spezzato). I valori unitari in uso sono nel capitolo 7."))
    return "".join(out)


def render_vehicles(d: dict) -> str:
    vs = g(d, "final", "vsp", "vehicleShifts", default=[]) or []
    vm = g(d, "final", "vsp", "metrics", default={}) or {}
    out = [section("macchina", "5. Turni macchina")]
    if not vs:
        out.append(para("<i>Turni macchina non presenti nel dossier.</i>"))
        return "".join(out)
    by_type = Counter(v.get("vehicleType") or "?" for v in vs)
    tiles = [("Vetture", fmt_n(len(vs)), " · ".join(f"{n} {t}" for t, n in by_type.most_common())),
             ("Ore di servizio", fmt_n((vm.get("totalServiceMin") or 0) / 60, 1), "corse di linea"),
             ("km di linea", fmt_n(vm.get("totalServiceKm") or 0, 1), ""),
             ("km fuorilinea", fmt_n(vm.get("totalDeadheadKm") or 0, 1), f'{fmt_n(vm.get("totalDeadheadMin") or 0)} min'),
             ("Efficienza", f'{fmt_n(100 * (vm.get("totalServiceMin") or 0) / max(1, sum(int(v.get("shiftDuration") or (int(v.get("endMin") or 0) - int(v.get("startMin") or 0))) for v in vs)), 1)} %', "servizio / nastro vetture")]
    out.append(rc.kpi_row(tiles))
    labels, counts = vehicles_by_hour(vs)
    if labels:
        out.append(rc.lines(labels, [("vetture fuori deposito", counts)], "Vetture in servizio per ora", unit="vetture",
                            subtitle="Numero di vetture fuori deposito a metà di ogni ora."))
    rows = []
    for v in sorted(vs, key=lambda x: int(x.get("startMin") or 0)):
        rows.append((v.get("vehicleId"), v.get("vehicleType") or "–", hm(v.get("startMin")), hm(v.get("endMin")),
                     hm(v.get("shiftDuration") or (int(v.get("endMin") or 0) - int(v.get("startMin") or 0))),
                     fmt_n(v.get("tripCount") or 0), hm(v.get("totalServiceMin")), fmt_n(v.get("totalDeadheadKm") or 0, 1),
                     fmt_n(v.get("depotReturns") or 0), v.get("residenzaName") or "–"))
    out.append("<h3>5.1 Quadro dei turni macchina</h3>")
    out.append(table(["Vettura", "Tipo", "Uscita", "Rientro", "Nastro", "Corse", "Servizio", "km vuoto", "Rientri", "Deposito"], rows, numeric_from=2))
    out.append(rc.gantt(vehicle_gantt_rows(vs), "Diagramma tempo-vettura", subtitle="Ogni riga è una vettura; le corse portano l'etichetta della linea.",
                        width=940, row_h=14))
    dh_rows, agg = deadhead_table(vs)
    out.append("<h3>5.2 Fuorilinea e movimenti a vuoto</h3>")
    arch = vm.get("deadheadArchive") if isinstance(vm.get("deadheadArchive"), dict) else None
    if arch:
        via = vm.get("viaDepotArcs") if isinstance(vm.get("viaDepotArcs"), dict) else {}
        txt = (f'I fuorilinea ammessi e i loro tempi vengono dall\'archivio «Archi fuorilinea» ({esc(str(arch.get("scope") or ""))}, {fmt_n(arch.get("arcs"))} archi): '
               f'{fmt_n(arch.get("ttAllowed"))} coppie capolinea ammesse, {fmt_n(arch.get("ttForbidden"))} vietate'
               + (f' ({fmt_n(via.get("count"))} riposizionamenti instradati via deposito)' if via and via.get("count") else "")
               + f'; tempi di percorrenza presi dall\'archivio su {fmt_n(arch.get("timesApplied", 0))} coppie'
               + (f', di cui {fmt_n(arch.get("customTimes"))} archi con tempo curato a mano dall\'operatore' if arch.get("customTimes") else "")
               + '.')
        missing = arch.get("depotLegsMissing") or []
        if arch.get("depotLegsOutsideArchive"):
            txt += (f' {fmt_n(arch.get("depotLegsOutsideArchive"))} tratte deposito↔capolinea non hanno un arco in archivio e sono stimate '
                    f'(km stradali ÷ velocità media + 5′)' + (f': {esc("; ".join(str(m) for m in missing[:8]))}' if missing else "") + ".")
        if arch.get("mirroredPairs"):
            txt += f' I fuorilinea valgono lo stesso tempo in andata e ritorno: {fmt_n(arch.get("mirroredPairs"))} versi senza arco proprio prendono tempo e km dal verso opposto.'
        out.append(para(txt))
    turn = vm.get("turnarounds") if isinstance(vm.get("turnarounds"), dict) else None
    if turn and (turn.get("natural") or turn.get("peripheralArrivals")):
        txt = (f'Regola del giro sulle linee radiali: {fmt_n(turn.get("natural"))} arrivi a un capolinea periferico hanno la corsa di ritorno '
               f'della stessa linea in partenza entro pochi minuti; la vettura la fa in {fmt_n(turn.get("chained"))} casi'
               + (f' e la salta in {fmt_n(turn.get("missed"))}' if turn.get("missed") else "") + ".")
        ml = turn.get("missedList") or []
        if ml:
            txt += " Giri saltati: " + "; ".join(
                f'{esc(str(x.get("routeName")))} a {esc(str(x.get("atStop")))} alle {esc(str(x.get("arriveTime")))} (ritorno {esc(str(x.get("returnDepartTime")))}, invece {esc(str(x.get("insteadOf")))})'
                for x in ml[:8]) + "."
        out.append(para(txt))
    props = vm.get("serviceReturnProposals") if isinstance(vm.get("serviceReturnProposals"), list) else []
    if props:
        out.append("<h4>Rientri a vuoto che potrebbero diventare corse di linea</h4>")
        out.append(para("Le corse in linea sono pagate dal contratto di servizio, i chilometri a vuoto no: dopo queste corse la vettura rientra a vuoto "
                        "mentre la linea ha una corsa nella direzione opposta che parte dallo stesso capolinea. Sono proposte da valutare in Planning Studio "
                        "(la corsa va creata dall'operatore), con i km a vuoto risparmiati e i km di servizio aggiunti."))
        rows = []
        for x in props[:25]:
            rows.append((x.get("vehicleId") or "–", f'{x.get("routeName") or ""} {x.get("variantCode") or ""}'.strip(),
                         f'{x.get("fromStop") or "–"} → {x.get("toStop") or "–"}',
                         x.get("departTime") or hm(x.get("departMin")), x.get("arriveTime") or hm(x.get("arriveMin")),
                         x.get("cadenceDepartTime") or "–", fmt_n(x.get("serviceKm"), 1), fmt_n(x.get("deadheadKmSaved"), 1),
                         "fine turno" if x.get("kind") == "final" else "a metà turno"))
        out.append(table(["Vettura", "Linea", "Corsa proposta", "Partenza", "Arrivo", "Per cadenza", "km in linea", "km a vuoto in meno", "Dove"], rows, numeric_from=6))
    if dh_rows:
        out.append(para(f'{len(dh_rows)} movimenti a vuoto per {fmt_n(sum(r[6] for r in dh_rows), 1)} km: ' +
                        ", ".join(f'{esc(k)} {fmt_n(v, 1)} km' for k, v in agg.most_common()) + "."))
        out.append(table(["Vettura", "Ora", "Da", "A", "Tratta", "min", "km"], dh_rows[:80], numeric_from=5))
        if len(dh_rows) > 80:
            out.append(para(f'<span class="small">… e altri {len(dh_rows) - 80} movimenti (elenco completo nell\'allegato).</span>'))
    else:
        out.append(para("Nessun fuorilinea fra corse: le vetture rientrano solo a fine servizio."))
    out.append(render_sagoma(d))
    return "".join(out)


def render_sagoma(d: dict) -> str:
    """5.x — LA REGOLA DELLA SAGOMA: che mezzo ha preso ogni blocco.

    Il tipo dichiarato su una linea non e' una preferenza, e' un tetto fisico:
    sopra quella taglia la strada non passa. Si puo' scendere di un gradino,
    mai di due, e il declassamento e' l'ultima spiaggia — una corsa isolata
    fuori punta non fa danno, venti si'. Senza questo capitolo la relazione
    dice quante vetture servono ma non se sono le vetture giuste."""
    sg = g(d, "final", "vsp", "metrics", "sagoma", default=None)
    if not isinstance(sg, dict) or not sg:
        return ""
    out = ["<h3>5.9 Regola della sagoma: il mezzo giusto su ogni corsa</h3>"]
    tiles = [("Corse declassate", fmt_n(sg.get("corseDeclassate") or 0),
              f'{fmt_n(sg.get("pctDeclassate") or 0, 1)} % del servizio'),
             ("In punta", fmt_n(sg.get("declassateInPunta") or 0),
              "fasce " + ", ".join(f'{a}-{b}' for a, b in (sg.get("fascePunta") or [])) if sg.get("fascePunta") else "fasce non dichiarate"),
             ("Fuori sagoma", fmt_n(sg.get("fuoriSagoma") or 0), "mezzo piu' GRANDE del dichiarato: mai ammesso"),
             ("Doppi declassamenti", fmt_n(sg.get("doppiDeclassamenti") or 0), "due gradini sotto: mai ammesso")]
    out.append(rc.kpi_row(tiles))
    blocchi = sg.get("blocchiPerTipo") or {}
    if blocchi:
        out.append(table(["Tipo di mezzo", "Blocchi"],
                         [(k, fmt_n(v)) for k, v in sorted(blocchi.items(), key=lambda kv: -kv[1])], numeric_from=1))
    per_linea = sg.get("lineeDeclassate") or {}
    if per_linea:
        items = [(str(k), float(v)) for k, v in sorted(per_linea.items(), key=lambda kv: -kv[1])]
        out.append(rc.bar_h(items, "Corse declassate per linea", unit="corse",
                            subtitle="Corse servite da un mezzo di una taglia sotto quello dichiarato dalla linea."))
    sup = sg.get("superamenti") or []
    if sup:
        out.append(para('<span class="small">Superamenti dei tetti di riferimento (10% delle corse della linea, 5% in punta):</span>'))
        out.append("<ul>" + "".join(f"<li>{esc(x)}</li>" for x in sup) + "</ul>")
    else:
        out.append(para("Nessun superamento dei tetti di declassamento."))
    if sg.get("catenSpezzate"):
        out.append(para(f'{fmt_n(sg.get("catenSpezzate"))} catene sono state spezzate per rispettare la sagoma: '
                        "quando allungare un blocco avrebbe richiesto un mezzo non ammesso, il blocco e' stato chiuso."))
    return "".join(out)


def _pct_caps_value(pc: dict | None) -> str:
    if not isinstance(pc, dict) or not pc.get("byType"):
        return "–"
    return "rispettati" if all(v.get("ok", True) for v in pc["byType"].values()) else "sforati"


def _pct_caps_text(pc: dict | None) -> str:
    """Tetti percentuali dei tipi di turno: tetto, massimo ammesso con la
    tolleranza di frazione di turno, conteggio; se il solver ha dovuto
    ripiegare sui tetti flessibili lo si dice."""
    if not isinstance(pc, dict) or not pc.get("byType"):
        return "nessun tetto percentuale configurato"
    parts = []
    for k, v in pc["byType"].items():
        parts.append(f'{k} {fmt_n(v.get("count"))}/{fmt_n(v.get("total"))} ({v.get("pct")}%) su tetto {v.get("maxPct")}% = max {fmt_n(v.get("allowed"))}'
                     + ("" if v.get("ok", True) else " · SFORATO"))
    tail = f' · tolleranza {pc.get("toleranceShifts", 0.9)} turno' + (" · tetti rigidi non soddisfacibili: ripiego sui tetti flessibili" if pc.get("relaxed") else "")
    return " · ".join(parts) + tail


def _handover_modes_text(hm_: dict | None) -> str:
    """Come si fanno i cambi in linea (auto aziendale / a piedi) e quanto resta
    ferma una vettura senza conducente."""
    if not isinstance(hm_, dict) or not hm_:
        return "passaggi di vettura fra conducenti"
    parts = []
    if hm_.get("incomingWalk") or hm_.get("outgoingWalk"):
        parts.append(f'{fmt_n(hm_.get("incomingWalk", 0))} montate e {fmt_n(hm_.get("outgoingWalk", 0))} smontate a piedi')
    if hm_.get("incomingCar") or hm_.get("outgoingCar"):
        parts.append(f'{fmt_n(hm_.get("incomingCar", 0))} montate e {fmt_n(hm_.get("outgoingCar", 0))} smontate con auto aziendale')
    if hm_.get("withUnattended"):
        parts.append(f'vettura ferma senza conducente in {fmt_n(hm_.get("withUnattended"))} cambi, al massimo {fmt_n(hm_.get("unattendedMaxMin"))}′ (limite {fmt_n(hm_.get("unattendedLimitMin", 15))}′)')
    return " · ".join(parts) if parts else "passaggi di vettura fra conducenti"


def render_crew(d: dict) -> str:
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    cs = g(d, "final", "crew", "summary", default={}) or {}
    p = g(d, "final", "params", default={}) or {}
    out = [section("guida", "6. Turni guida")]
    if not ds:
        out.append(para("<i>Turni guida non presenti nel dossier.</i>"))
        return "".join(out)
    st = crew_stats(ds)
    rules = p.get("shiftRules") or {}
    int_max = int(g(rules, "intero", "maxNastro", default=435) or 435)
    tiles = [("Turni", fmt_n(len(ds)), " · ".join(f'{st["byType"].get(k, 0)} {DUTY_TYPE_LABEL[k].lower()}' for k in DUTY_TYPE_ORDER if st["byType"].get(k))),
             ("Lavoro medio", hm(sum(st["work"]) / len(st["work"])), f'min {hm(min(st["work"]))} · max {hm(max(st["work"]))}'),
             ("Nastro medio", hm(sum(st["nastro"]) / len(st["nastro"])), f'min {hm(min(st["nastro"]))} · max {hm(max(st["nastro"]))}'),
             ("Cambi in linea", fmt_n(st["cambi"]), _handover_modes_text(cs.get("handoverModes"))),
             ("Tetti per tipo", _pct_caps_value(cs.get("pctCaps")), _pct_caps_text(cs.get("pctCaps"))),
             ("Violazioni", fmt_n(st["violations"]), f'{st["warnings"]} avvisi')]
    if cs.get("companyCarsMaxSimultaneous") is not None:
        _conf = cs.get("companyCarsConflicts") or 0
        tiles.append(("Auto aziendali (picco)", fmt_n(cs.get("companyCarsMaxSimultaneous")),
                      (f'tetto {p.get("companyCars")}' if p.get("companyCars") is not None else "") + (f" · {_conf} viaggi senza auto" if _conf else "")))
    out.append(rc.kpi_row(tiles))
    out.append("<h3>6.1 Struttura</h3>")
    ncat = [DUTY_TYPE_LABEL[k] for k in DUTY_TYPE_ORDER if st["byType"].get(k)]
    out.append(rc.columns(ncat, [("turni", [st["byType"].get(k, 0) for k in DUTY_TYPE_ORDER if st["byType"].get(k)])], "Turni per tipo", unit="turni", height=220))
    out.append(rc.histogram(st["nastro"], "Distribuzione del nastro", 240, 30, 14, subtitle="Turni per fascia di nastro (classi di 30 minuti).",
                            label=lambda lo, hi: hm(lo), marker=int_max, marker_label="nastro max intero"))
    out.append(rc.histogram(st["work"], "Distribuzione del lavoro", 240, 30, 14, subtitle="Turni per fascia di lavoro pagato (classi di 30 minuti).",
                            label=lambda lo, hi: hm(lo), marker=int(g(rules, "intero", "maxLavoro", default=435) or 435), marker_label="lavoro max intero"))
    if st["interruptions"]:
        out.append(rc.histogram(st["interruptions"], "Interruzioni dei turni a due riprese", 60, 30, 10, subtitle="Stacco fra i due pezzi (semiunici e spezzati).", label=lambda lo, hi: hm(lo)))
    out.append("<h3>6.2 Diagramma dei turni guida</h3>")
    rows = duty_gantt_rows(sorted(ds, key=lambda x: (DUTY_TYPE_ORDER.index(x.get("type")) if x.get("type") in DUTY_TYPE_ORDER else 9, int(x.get("nastroStartMin") or 0))))
    out.append(rc.gantt(rows, "Diagramma tempo-turno", subtitle="Ogni riga è un turno guida; le corse portano la linea, la linea sottile grigia è l'interruzione, il viola l'uso dell'auto aziendale.",
                        width=940, row_h=13))
    labels, counts = cars_timeline(ds)
    if labels and any(counts):
        out.append(rc.lines(labels, [("viaggi in corso", counts)], "Viaggi dell'auto aziendale per ora", unit="viaggi",
                            subtitle="Consegne e ritiri di conducenti in viaggio contemporaneamente (picco entro l'ora); il picco di AUTO impegnate è il valore riportato in testa al capitolo."))
    out.append("<h3>6.3 Verifiche normative</h3>")
    if st["violations"]:
        out.append(table(["Violazione", "n."], [(k, v) for k, v in st["violationMsgs"].most_common()], numeric_from=1))
    else:
        out.append(para('<span class="ok">Nessuna violazione delle regole di struttura.</span>'))
    if st["warnings"]:
        out.append(table(["Avviso (non bloccante)", "n."], [(k, v) for k, v in st["warningMsgs"].most_common()], numeric_from=1))
    out.append("<h3>6.4 Elenco dei turni</h3>")
    rows = []
    for x in sorted(ds, key=lambda x: (DUTY_TYPE_ORDER.index(x.get("type")) if x.get("type") in DUTY_TYPE_ORDER else 9, x.get("driverId") or "")):
        pieces = x.get("riprese") or []
        # orari di SERVIZIO del pezzo (presa in carico → rilascio del bus); i
        # confini di nastro comprendono pre-turno e trasferimenti in auto
        desc = " | ".join(f'{(pc.get("vehicleIds") or ["?"])[0]} {hm(piece_service_bounds(pc)[0])}–{hm(piece_service_bounds(pc)[1])} '
                          f'{",".join(dict.fromkeys(t.get("routeName") or "" for t in (pc.get("trips") or [])))}' for pc in pieces)
        viol = len((x.get("bdsValidation") or {}).get("violations") or [])
        rows.append((x.get("driverId"), x.get("type"), hm(x.get("nastroMin")), hm(x.get("workMin")),
                     f'{x.get("interruptionMin")}′' if x.get("interruptionMin") else "–", fmt_n(x.get("cambiCount") or 0),
                     fmt_eur(x.get("costEuro"), 0), ("✗ " + str(viol)) if viol else "✓", desc))
    out.append(table(["Turno", "Tipo", "Nastro", "Lavoro", "Interr.", "Cambi", "Costo", "BDS", "Pezzi (vettura, orario, linee)"], rows, numeric_from=2))
    return "".join(out)


def unit_cost_table(params: dict) -> list[dict]:
    """Valori unitari in uso: default del motore (cost_model / optimizer_common)
    sovrascritti da ciò che lo scenario ha registrato. Ogni riga dichiara la fonte."""
    rows: list[dict] = []
    prov = params.get("provenance") or {}
    # ── conducenti ──
    try:
        from cost_model import CostRates
        cr_cfg = {"costRates": params.get("costRates")} if params.get("costRates") else {}
        rates = CostRates.from_config(cr_cfg)
        src_c = "scenario" if params.get("costRates") else prov.get("crewConfig") or "default del motore"
        for label, val, unit in (("Tariffa oraria conducente", rates.hourly_rate, "€/h"),
                                 ("Moltiplicatore straordinario", rates.overtime_multiplier, "×"),
                                 ("Supplemento (costo fisso)", rates.supplemento_fixed, "€"),
                                 ("Costo giornaliero conducente aggiuntivo", rates.extra_driver_daily, "€/giorno"),
                                 ("Costo giornaliero supplemento", rates.supplemento_daily, "€/giorno"),
                                 ("Quota pagata dell'attesa al capolinea", rates.idle_rate_fraction, "× tariffa"),
                                 ("Quota pagata dell'interruzione", rates.interruption_rate_fraction, "× tariffa"),
                                 ("Quota pagata del pre-turno", rates.pre_turno_rate_fraction, "× tariffa"),
                                 ("Quota pagata del trasferimento", rates.transfer_rate_fraction, "× tariffa"),
                                 ("Auto aziendale per utilizzo", rates.company_car_per_use, "€"),
                                 ("Taxi: base / km / minuto di attesa", f"{rates.taxi_base} / {rates.taxi_per_km} / {rates.taxi_per_min_wait}", "€"),
                                 ("Costo gestionale per cambio in linea", rates.cambio_overhead, "€"),
                                 ("Lavoro obiettivo per turno", f"{rates.target_work_min}–{rates.target_work_max}", "min")):
            rows.append({"label": label, "value": val, "unit": unit, "source": src_c})
    except Exception:  # noqa: BLE001 — la relazione non deve cadere per il modulo costi
        pass
    # ── vetture ──
    try:
        from optimizer_common import VehicleCostRates
        vc = params.get("vehicleCosts") or {}
        vr = VehicleCostRates.from_config({"vehicleCosts": vc}) if vc and hasattr(VehicleCostRates, "from_config") else VehicleCostRates()
        src_v = "scenario" if vc else prov.get("vehicleCosts") or "default del motore"
        fixed = getattr(vr, "fixed_daily", {}) or {}
        skm = getattr(vr, "per_service_km", {}) or {}
        dkm = getattr(vr, "per_deadhead_km", {}) or {}
        for vt in sorted(set(fixed) | set(skm) | set(dkm)):
            rows.append({"label": f"Vettura {vt}: fisso giornaliero / km di linea / km a vuoto",
                         "value": f"{fixed.get(vt, '–')} / {skm.get(vt, '–')} / {dkm.get(vt, '–')}", "unit": "€/giorno · €/km · €/km", "source": src_v})
        for label, attr, unit in (("Attesa vettura al capolinea", "idle_per_min", "€/min"), ("Attesa lunga (oltre soglia)", "long_idle_per_min", "€/min"),
                                  ("Rientro intermedio in deposito", "per_depot_return", "€"), ("Nastro vettura obiettivo", "target_shift_duration", "min")):
            if hasattr(vr, attr):
                rows.append({"label": label, "value": getattr(vr, attr), "unit": unit, "source": src_v})
    except Exception:  # noqa: BLE001
        pass
    vcsp = params.get("vcsp") or {}
    rows.append({"label": "Ombra per turno guida (selezione VCSP)", "value": vcsp.get("dutyShadowEur", 200), "unit": "€/turno", "source": "parametro VCSP"})
    rows.append({"label": "Ombra per violazione BDS (selezione VCSP)", "value": vcsp.get("violationShadowEur", 100), "unit": "€/violazione", "source": "parametro VCSP"})
    rows.append({"label": "Disturbo all'orario (sonda)", "value": vcsp.get("shiftPenaltyEur", 1), "unit": "€ per corsa·minuto", "source": "parametro VCSP"})
    return rows


def segno_min(v) -> str:
    """Uno spostamento d'orario col segno davanti: «+7′», «−14′», «0′»."""
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return "–"
    return f"{'+' if n > 0 else ('−' if n < 0 else '')}{abs(n)}′"


MOTIVO_RIFIUTO = {
    "vsp": "i mezzi non migliorano",
    "crew": "il guadagno sui mezzi lo mangia il lato guida",
    "violazioni": "porterebbe violazioni in più: non si compra a nessun prezzo",
    "coincidenza:flessibilitaInsufficiente": "romperebbe una coincidenza e le corse vicine non hanno flessibilità per seguirlo",
    "coincidenza:catenaTroppoLunga": "romperebbe una coincidenza e la catena da trascinare è troppo lunga",
    "coincidenza:deltaInConflitto": "romperebbe una coincidenza e i due spostamenti si contraddicono",
    "coincidenza:corsaSconosciuta": "romperebbe una coincidenza su una corsa non riconosciuta",
    "macchina": "il ritorno partirebbe prima dell'arrivo dell'andata",
}


def _fb_termometro(f: dict) -> dict:
    """Legge una riga del termometro del ciclo da QUALUNQUE delle due forme.

    Il dossier della relazione porta il feedback grezzo come esce dal motore
    (`afterRound`, `ancora` come oggetto, `distanzaDalPrecedenteEur`); la
    rotta del cruscotto lo appiattisce prima di mostrarlo (`dopoRound`,
    `ancora` come numero, `spostamentoEur`). Qui si accettano entrambe: la
    relazione non deve rompersi a seconda di chi gliel'ha passata."""
    anc = f.get("ancora")
    anc_dict = anc if isinstance(anc, dict) else {}
    giunti = f.get("giunti") if isinstance(f.get("giunti"), dict) else {}
    return {
        "dopoRound": f.get("dopoRound") if f.get("dopoRound") is not None else f.get("afterRound"),
        "ancoraRound": anc_dict.get("round") if anc_dict else (anc if not isinstance(anc, dict) else None),
        "modo": f.get("modo") or anc_dict.get("modo") or "",
        "cambiInRegola": anc_dict.get("cambiInRegola"),
        "blocchi": (f.get("blocchiPenalizzati") if f.get("blocchiPenalizzati") is not None
                    else f.get("blocksPenalized")),
        "archiInVigore": f.get("archiInVigore"),
        "massaEur": f.get("massaPenalitaEur"),
        "spostamentoEur": (f.get("spostamentoEur") if f.get("spostamentoEur") is not None
                           else f.get("distanzaDalPrecedenteEur")),
        "escalation": (f.get("escalationGiunti") if f.get("escalationGiunti") is not None
                       else giunti.get("escalation")),
    }


def render_ciclo(d: dict) -> str:
    """7 — IL CICLO INTEGRATO: come turni macchina e turni guida sono stati
    decisi INSIEME, e non uno dopo l'altro.

    È il capitolo che spiega perché questo piano è quello che è: quanti giri
    ha fatto il ciclo, come il dolore del lato guida è tornato indietro ai
    mezzi, che cosa la sonda ha provato a spostare e che cosa ha imparato."""
    v = g(d, "final", "vcsp", default=None)
    out = [section("ciclo", "7. Il ciclo integrato")]
    if not isinstance(v, dict) or not v:
        out.append(para("<i>Piano prodotto senza il ciclo integrato: turni macchina e turni guida "
                        "sono stati risolti in sequenza, senza retroazione.</i>"))
        return "".join(out)

    rounds = [r for r in (v.get("rounds") or []) if isinstance(r, dict)]
    best = v.get("selectedRound") or v.get("bestRound")
    out.append(para(
        "Il ciclo risolve i turni macchina, taglia i turni guida su quei blocchi, misura dove il lato "
        "guida ha sofferto e rimanda quel dolore indietro ai mezzi come un prezzo sui singoli "
        "collegamenti fra corsa e corsa. Il giro dopo il solver evita di ricomporre gli accostamenti "
        "che il lato guida non sa tagliare. Si ferma quando smette di migliorare."))

    cic = v.get("ciclo") if isinstance(v.get("ciclo"), dict) else None
    if cic:
        _anc = {"best": "il giro migliore fin qui", "last": "il giro appena fatto"}.get(
            str(cic.get("ancora") or ""), str(cic.get("ancora") or "non dichiarata"))
        voci = [f'il prezzo nuovo entra in vigore per <b>{fmt_n((cic.get("passo") or 0) * 100)} %</b>, '
                f'il resto resta quello del giro prima']
        voci.append(f'il dolore si misura su <b>{_anc}</b>')
        voci.append("i mezzi ripartono dalle catene del piano migliore"
                    if cic.get("seme") else "ogni giro riparte da zero")
        if cic.get("pazienza"):
            voci.append(f'ci si ferma dopo <b>{fmt_n(cic.get("pazienza"))}</b> giri senza progresso')
        voci.append("ogni proposta della sonda è verificata con un calcolo di controllo"
                    if cic.get("controllo") else "le proposte della sonda non sono state ricontrollate")
        out.append(para("<b>Le regole d'ingaggio di questo ciclo.</b> " + "; ".join(voci) + "."))

    if rounds:
        out.append("<h3>7.1 I giri del ciclo</h3>")
        righe = []
        for r in rounds:
            marca = " ← scelto" if r.get("round") == best else (" · sonda" if r.get("probe") else "")
            righe.append((f'{fmt_n(r.get("round"))}{marca}', fmt_n(r.get("vehicles")), fmt_n(r.get("duties")),
                          fmt_n(r.get("supplementi") or 0), fmt_n(r.get("bdsViolations") or 0),
                          fmt_eur(r.get("totalCostEur")), fmt_eur(r.get("shadowPenaltyEur") or 0),
                          fmt_eur(r.get("selectionScoreEur"))))
        out.append(table(["Giro", "Vetture", "Turni", "Suppl.", "Violazioni", "Costo", "di cui ombra", "Punteggio"],
                         righe, numeric_from=1))
        out.append(para('<span class="small">Il piano scelto non è il più economico: è il primo fra quelli che '
                        'non rompono nessuna regola. Le violazioni vengono prima del punteggio, sempre — un piano '
                        'che rompe una regola non è un piano peggiore, non è un piano. La colonna «di cui ombra» '
                        'dice quanto del costo erano penalità inventate dal motore, già tolte dal costo.</span>'))
        if len(rounds) > 1:
            etichette = [str(r.get("round")) for r in rounds]
            out.append(rc.lines(etichette,
                                [("vetture", [float(r.get("vehicles") or 0) for r in rounds]),
                                 ("turni guida", [float(r.get("duties") or 0) for r in rounds])],
                                "Vetture e turni guida, giro per giro",
                                subtitle="Lo stesso orario risolto più volte: ogni giro riceve il segnale del precedente."))

    fb = [f for f in (v.get("feedback") or []) if isinstance(f, dict)]
    if fb:
        out.append("<h3>7.2 Come il segnale si è mosso</h3>")
        out.append(para(
            "Il termometro del ciclo. La «massa» è quanto pesano in tutto le penalità in vigore; lo "
            "«spostamento» è di quanto sono cambiate rispetto al giro prima. Se lo spostamento non cala, "
            "il solver dei mezzi sta inseguendo un bersaglio che salta, e nessun giro può migliorare il "
            "precedente."))
        righe = []
        for f in fb:
            t = _fb_termometro(f)
            righe.append((fmt_n(t["dopoRound"]), fmt_n(t["ancoraRound"]), t["modo"],
                          fmt_n(t["blocchi"]), fmt_n(t["archiInVigore"]),
                          fmt_eur(t["massaEur"]), fmt_eur(t["spostamentoEur"]),
                          f'×{fmt_n(t["escalation"] or 1, 2)}'))
        out.append(table(["Dopo il giro", "Calcolato sul giro", "Ancora", "Blocchi", "Archi in vigore",
                          "Massa", "Spostamento", "Pressione sui cambi"], righe, numeric_from=1))

    out.append(render_sonda(v))
    return "".join(out)


def render_sonda(v: dict) -> str:
    """7.3 — LA SONDA: gli spostamenti di orario provati, e che cosa ha imparato."""
    pr = v.get("probe") if isinstance(v.get("probe"), dict) else None
    if not pr:
        return ""
    out = ["<h3>7.3 La sonda: spostare corse per salvare un turno</h3>"]
    out.append(para(
        "L'ultimo passo. Quando i mezzi e i turni non si incastrano, invece di rassegnarsi la sonda "
        "prova a spostare qualche corsa di pochi minuti — solo dentro la flessibilità che l'azienda "
        "ha dichiarato su quella linea — e verifica ogni proposta con un ricalcolo vero. Non propone "
        "nulla che rompa una coincidenza riconosciuta."))
    acc = [a for a in (pr.get("accepted") or []) if isinstance(a, dict)]
    tiles = [("Corse spostate", fmt_n(pr.get("shiftedTrips") or 0), f'{fmt_n(pr.get("shiftedTripMin") or 0)} minuti in tutto'),
             ("Proposte accettate", fmt_n(len(acc)), f'su {fmt_n(pr.get("probesRun") or 0)} verificate'),
             ("Disturbo all'orario", fmt_eur(pr.get("disruptionEur") or 0),
              f'{fmt_eur(pr.get("shiftPenaltyEurPerTripMin") or 1, 2)} per corsa·minuto')]
    ctrl = pr.get("controllo") if isinstance(pr.get("controllo"), dict) else None
    if ctrl and ctrl.get("vetture"):
        vv = ctrl.get("vetture") or {}
        tiles.append(("Controllo", f'{fmt_n(vv.get("controllo"))} contro {fmt_n(vv.get("round"))}',
                      "stesso calcolo senza spostare niente"))
    out.append(rc.kpi_row(tiles))
    if ctrl:
        out.append(para(
            "<b>Il controllo.</b> Prima di misurare qualunque proposta la sonda rifà il calcolo <i>senza</i> "
            "spostare niente, con le stesse impostazioni. Serve a non attribuire a una corsa spostata un "
            "guadagno che era solo del solver: " +
            ("il calcolo di riferimento resta quello del giro." if ctrl.get("riferimento") == "round"
             else "il calcolo di controllo ha fatto meglio del giro, ed è diventato il riferimento.")))
    if acc:
        righe = []
        for a in acc:
            dove = ", ".join(f'{x.get("routeName")} {segno_min(x.get("deltaMin"))} ({fmt_n(x.get("trips"))} corse)'
                             for x in (a.get("shiftsByRoute") or [])[:6])
            pr_b, pr_a = a.get("before") or {}, a.get("after") or {}
            righe.append((a.get("kind") or "", dove or "–",
                          f'{fmt_n(pr_b.get("vehicles"))} → {fmt_n(pr_a.get("vehicles"))}',
                          f'{fmt_n(pr_b.get("duties"))} → {fmt_n(pr_a.get("duties"))}',
                          f'{fmt_n(pr_b.get("bdsViolations"))} → {fmt_n(pr_a.get("bdsViolations"))}',
                          fmt_eur(a.get("disruptionEur") or 0)))
        out.append(para("<b>Spostamenti accettati.</b> Ognuno è stato verificato con un ricalcolo completo:"))
        out.append(table(["Tipo", "Corse spostate", "Vetture", "Turni", "Violazioni", "Disturbo"], righe, numeric_from=2))
    else:
        out.append(para("Nessuno spostamento è stato accettato: il piano regge senza toccare l'orario."))

    lez = [l for l in (pr.get("lezioni") or []) if isinstance(l, dict)]
    scartate = [l for l in lez if l.get("esito") == "scartato"]
    if scartate:
        from collections import Counter as _C
        per_motivo = _C(l.get("motivo") or "?" for l in scartate)
        out.append(para("<b>Perché le altre proposte non sono passate.</b>"))
        out.append(table(["Motivo", "Proposte"],
                         [(MOTIVO_RIFIUTO.get(k, k), fmt_n(n)) for k, n in per_motivo.most_common()],
                         numeric_from=1))
        linee = [l for l in scartate if l.get("route")]
        if linee:
            righe = [(str(l.get("route")), segno_min(l.get("deltaMin")),
                      MOTIVO_RIFIUTO.get(l.get("motivo") or "", l.get("motivo") or ""),
                      fmt_n(l.get("tentativi") or 1)) for l in linee[:14]]
            out.append(para('<span class="small">Le traslazioni di linea intera che il servizio suggeriva, e perché sono state scartate:</span>'))
            out.append(table(["Linea", "Spostamento", "Motivo", "Tentativi"], righe, numeric_from=1))

    mem = pr.get("memoria") if isinstance(pr.get("memoria"), dict) else None
    if mem and (mem.get("lezioniLette") or mem.get("giriLetti")):
        out.append(para(
            f'<b>La memoria.</b> Questo calcolo ha riletto {fmt_n(mem.get("lezioniLette"))} lezioni da '
            f'{fmt_n(mem.get("giriLetti"))} calcoli precedenti sullo stesso progetto e sulla stessa data: '
            f'{fmt_n(mem.get("ripresi"))} proposte che avevano funzionato sono state riprovate per prime, '
            f'{fmt_n(mem.get("rimandatiInCoda"))} che erano state bocciate sono finite in fondo alla coda. '
            "Mai per vietare: il piano cambia, e una proposta bocciata ieri può passare oggi."))
    elif mem:
        out.append(para('<span class="small">Nessuna lezione da calcoli precedenti: è il primo calcolo '
                        'su questo progetto e questa data.</span>'))
    return "".join(out)


def _attesa(x: dict) -> dict:
    """L'attesa di una relazione, comunque sia scritta.

    L'analisi delle coincidenze la porta come oggetto (`attesaMin`: min, max,
    mediana); qualche consumatore la vuole piatta. Si accettano entrambe, e
    quando manca si restituisce un oggetto vuoto invece di far esplodere il
    formattatore su una chiave assente."""
    a = x.get("attesaMin")
    if isinstance(a, dict):
        return a
    piatta = {"min": x.get("attesaMinMin", x.get("minWaitMin")),
              "max": x.get("attesaMaxMin", x.get("maxWaitMin")),
              "mediana": x.get("attesaMedianaMin", x.get("medianWaitMin"))}
    if isinstance(a, (int, float)) and piatta["min"] is None:
        piatta["min"] = a
    return piatta


def _minuti_da_ora(x) -> int | None:
    """I minuti dalla mezzanotte, comunque sia scritta l'ora.

    Il campo `passaggi` li porta gia' come numero; il vecchio `sample` aveva
    solo la stringa "08:12", e leggerla era l'unico modo perche' una relazione
    prodotta prima di questo cambiamento avesse comunque il suo diagramma."""
    if isinstance(x, (int, float)):
        return int(x)
    if isinstance(x, str) and ":" in x:
        try:
            pezzi = [int(v) for v in x.split(":")[:2]]
            return pezzi[0] * 60 + pezzi[1]
        except ValueError:
            return None
    return None


def render_nodi_coincidenza(esistenti: list) -> str:
    """8.1 — CHI SI INCONTRA, E DOVE.

    Un elenco di relazioni riga per riga non fa vedere la struttura. Chi
    conosce la rete la descrive per NODO — «la 1/4 e la 44 a Piazza Cavour e a
    Tavernelle», «la 2/6 con la 21/33 al Pinocchio» — perche' il nodo e' il
    posto dove uno cambia e le linee sono quello che ci trova. Questo quadro
    e' organizzato cosi'."""
    per_nodo: dict = {}
    for c in esistenti:
        nodo = str(c.get("node") or "").strip()
        a, b = str(c.get("fromRoute") or ""), str(c.get("toRoute") or "")
        if not nodo or not a or not b:
            continue
        v = per_nodo.setdefault(nodo, {"linee": set(), "relazioni": [], "incontri": 0})
        v["linee"].update((a, b))
        v["incontri"] += int(c.get("occurrences") or 0)
        v["relazioni"].append((a, b, int(c.get("occurrences") or 0), _attesa(c).get("mediana")))
    if not per_nodo:
        return ""
    out = ["<h3>8.1 Dove si cambia, e fra quali linee</h3>"]
    out.append(para(
        "Il nodo è il posto dove si cambia; le linee sono quello che ci si trova. Questo quadro "
        "tiene insieme le due cose: per ogni nodo, quali linee vi si incontrano e quante volte "
        "al giorno. È il modo in cui la rete si legge davvero — «la 1/4 e la 44 a Piazza Cavour», "
        "non «relazione numero sette»."))
    righe = []
    for nodo, v in sorted(per_nodo.items(), key=lambda kv: -kv[1]["incontri"]):
        linee = sorted(v["linee"], key=ordine_di_linea)
        rel = sorted(v["relazioni"], key=lambda r: -r[2])
        dett = ", ".join(f'{a}→{b} ({fmt_n(n)}×, attesa {fmt_n(m)}′)' for a, b, n, m in rel[:5])
        if len(rel) > 5:
            dett += f' … e altre {fmt_n(len(rel) - 5)}'
        righe.append((nodo, ", ".join(linee), fmt_n(len(linee)), fmt_n(v["incontri"]), dett))
    out.append(table(["Nodo", "Linee che si incontrano", "Quante", "Incontri al giorno", "Relazioni"],
                     righe, numeric_from=2))
    if len(per_nodo) > 1:
        out.append(rc.bar_h([(n, v["incontri"]) for n, v in
                             sorted(per_nodo.items(), key=lambda kv: -kv[1]["incontri"])[:14]],
                            "Incontri al giorno, nodo per nodo", unit="incontri"))
    return "".join(out)


GRIGLIA_RIGHE_MAX = 20
RITMI_MAX = 12


def ordine_di_linea(nome) -> tuple:
    """Come si ordinano i nomi delle linee.

    In ordine alfabetico «24» viene prima di «3» e «1/4» prima di tutto: per
    chi legge un quadro orario e' sbagliato. Si ordina per il primo numero che
    compare nel nome, e a parita' per il nome intero."""
    import re as _re
    t = str(nome or "")
    m = _re.search(r"\d+", t)
    return (int(m.group(0)) if m else 10 ** 6, t)


def linee_scelte(d: dict) -> list:
    """Le linee che l'operatore ha chiesto di vedere, se le ha chieste."""
    v = g(d, "analisi", "coincidenze", "lineeScelte", default=None)
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if str(x or "").strip()]


def filtra_per_linee(voci: list, scelte: list) -> list:
    """Le relazioni che riguardano le linee scelte.

    La regola e' una sola e va detta in chiaro nel documento: con due o piu'
    linee scelte si tengono le relazioni fra quelle linee — tutte e due i capi
    dentro la scelta — perche' chi ne indica cinque vuole vedere come si
    parlano fra loro, non le altre dodici. Con una linea sola si tengono tutte
    le sue relazioni, altrimenti il capitolo resterebbe vuoto."""
    if not scelte:
        return list(voci)
    s = {x for x in scelte}
    uno = len(s) == 1
    fuori = []
    for v in voci:
        a, b = str(v.get("fromRoute") or ""), str(v.get("toRoute") or "")
        if (uno and (a in s or b in s)) or (not uno and a in s and b in s):
            fuori.append(v)
    return fuori


def passaggi_di(c: dict) -> tuple:
    """I passaggi di una relazione, e da dove sono stati presi.

    Due produttori, due forme. `near_misses` emette `passaggi`: tutti gli
    incontri della giornata, col minuto in chiaro. `detect_coincidences` emette
    `sample`: tre campioni con l'ora come stringa. Il primo fa un disegno, il
    secondo fa tre punti — ma tre punti disegnati sono meglio di una figura che
    sparisce, e il documento deve dire quale dei due sta guardando.

    I passaggi escono normalizzati — `arrivoMin` e `attesaMin` sempre numerici —
    perche' chi disegna non deve sapere da quale dei due produttori arrivano:
    e' esattamente il malinteso che ha lasciato il capitolo senza figure.

    Ritorna (passaggi, completo): `completo` e' False quando sono campioni.
    """
    def _norm(p: dict) -> dict | None:
        m = _minuti_da_ora(p.get("arrivoMin"))
        if m is None:
            m = _minuti_da_ora(p.get("arrivo"))
        if m is None:
            return None
        att = _numero(p.get("attesaMin"))
        if att is None:
            part = _minuti_da_ora(p.get("partenzaMin"))
            if part is None:
                part = _minuti_da_ora(p.get("partenza"))
            att = (part - m) if part is not None else None
        return dict(p, arrivoMin=m, **({"attesaMin": att} if att is not None else {}))

    for chiave, completo in (("passaggi", True), ("sample", False)):
        voci = [_norm(p) for p in (c.get(chiave) or []) if isinstance(p, dict)]
        voci = [v for v in voci if v]
        if voci:
            return voci, completo
    return [], True


def _ore_dei_passaggi(c: dict) -> dict:
    """Quante coincidenze, ora per ora, in questa relazione."""
    ore: dict = {}
    for p in passaggi_di(c)[0]:
        m = _minuti_da_ora(p.get("arrivoMin"))
        if m is None:
            m = _minuti_da_ora(p.get("arrivo"))
        if m is None:
            continue
        ora = int(m) // 60
        ore[ora] = ore.get(ora, 0) + 1
    return ore


def _niente_disegno(titolo: str, quante: int, motivo: str) -> str:
    """Una figura che non si puo' fare lo dice, e dice perche'.

    E' gia' costato una volta: un capitolo senza disegni e nessun modo di
    sapere se mancava il dato, la chiave o il codice. Il silenzio e' il difetto,
    non la figura mancante."""
    return (f"<h3>{titolo}</h3>"
            + para(f'<i>Il disegno non è stato fatto: {esc(motivo)} '
                   f'({fmt_n(quante)} relazioni esaminate). Le relazioni restano '
                   f'nel quadro qui sotto, con i numeri e gli orari di campione.</i>'))


def _etichetta_relazione(c: dict) -> str:
    return f'{c.get("node") or "?"} · {c.get("fromRoute")} → {c.get("toRoute")}'


def render_coincidenze_quando(esistenti: list) -> str:
    """8.2 — QUANDO si può cambiare, e quando no.

    La domanda di un capo movimento non e' «dove si incontrano le linee» ma «a
    che ora». Una riga per relazione, una colonna per ora, la casella piena
    quanto sono le coincidenze di quell'ora: il buco a meta' pomeriggio si vede
    a occhio, e nessun elenco lo fa vedere."""
    righe = []
    for c in esistenti:
        ore = _ore_dei_passaggi(c)
        if not ore:
            continue
        # il totale e' quello dichiarato dalla relazione: coi soli campioni la
        # somma delle caselle direbbe «tre» dove gli incontri sono dodici
        totale = int(c.get("occurrences") or 0) or sum(ore.values())
        righe.append({"label": _etichetta_relazione(c), "ore": ore, "totale": totale})
    if not righe:
        return _niente_disegno("8.2 Quando si può cambiare", len(esistenti),
                               "nessuna relazione porta l'ora dell'incontro")
    righe.sort(key=lambda r: -r["totale"])
    tagliate = len(righe) - GRIGLIA_RIGHE_MAX
    su_campioni = sum(1 for c in esistenti if not passaggi_di(c)[1])
    avviso = ("" if su_campioni == 0 else
              f'Di {fmt_n(su_campioni)} relazioni il quadro porta solo il campione di tre '
              f'passaggi: la loro riga è parziale, il totale vero è nella colonna a destra. ')
    dis = rc.griglia_coincidenze(
        righe[:GRIGLIA_RIGHE_MAX], "Quando si può cambiare, ora per ora",
        subtitle="Una riga per relazione, una colonna per ora del giorno; la casella è tanto più "
                 "scura quante sono le coincidenze. Le caselle vuote sono le ore senza cambio.",
        note=avviso + (f'Le {fmt_n(GRIGLIA_RIGHE_MAX)} relazioni con più coincidenze; '
                       f'altre {fmt_n(tagliate)} restano nel libretto orario.' if tagliate > 0 else ""))
    if not dis:
        return _niente_disegno("8.2 Quando si può cambiare", len(esistenti),
                               "la griglia non ha prodotto nessuna casella")
    return ("<h3>8.2 Quando si può cambiare</h3>"
            + para("Il quadro precedente dice <i>dove</i> si cambia. Questo dice <i>quando</i>: "
                   "una relazione con trenta coincidenze distribuite su tutto il giorno vale un'altra cosa "
                   "rispetto a una che le ha tutte in due ore del mattino, e il totale da solo non "
                   "distingue le due.")
            + dis)


def render_coincidenze_ritmo(d: dict, esistenti: list) -> str:
    """8.3 — QUANTO è buono ogni cambio.

    In orizzontale l'ora, in verticale i minuti di attesa, la fascia chiara e'
    la finestra utile. Un disegno per relazione, affiancati: si confrontano a
    colpo d'occhio senza rileggere i numeri."""
    co = g(d, "analisi", "coincidenze", default={}) or {}
    lo = _numero(co.get("attesaMinimaMin"))
    hi = _numero(co.get("sogliaAttesaMin"))
    finestra = (lo if lo is not None else 2, hi if hi is not None else 5)
    con_orari = [c for c in esistenti if passaggi_di(c)[0]]
    con_orari.sort(key=lambda c: -int(c.get("occurrences") or 0))
    pezzi, su_campioni = [], 0
    for c in con_orari[:RITMI_MAX]:
        a = _attesa(c)
        pg, completo = passaggi_di(c)
        dis = rc.ritmo_relazione(
            pg, _etichetta_relazione(c),
            subtitle=f'{fmt_n(c.get("occurrences"))} volte al giorno · attesa mediana '
                     f'{fmt_n(a.get("mediana"))}′'
                     + ("" if completo else f' · disegnati {fmt_n(len(pg))} passaggi di campione'),
            finestra=finestra)
        if dis:
            pezzi.append(dis)
            su_campioni += 0 if completo else 1
    if not pezzi:
        return _niente_disegno("8.3 Quanto è buono ogni cambio", len(esistenti),
                               "i passaggi non portano né l'ora dell'incontro né l'attesa")
    return ("<h3>8.3 Quanto è buono ogni cambio</h3>"
            + para(f'Per ogni relazione, un passaggio è un punto: in orizzontale l\'ora in cui si arriva, '
                   f'in verticale i minuti che si aspettano. La fascia chiara è la finestra utile '
                   f'({fmt_n(finestra[0])}–{fmt_n(finestra[1])} minuti). I punti sopra la fascia sono attese '
                   f'lunghe, quelli sotto sono cambi da prendere di corsa. Sono le '
                   f'<b>{fmt_n(len(pezzi))} relazioni</b> con più coincidenze.'
                   + ("" if su_campioni == 0 else
                      f' Di {fmt_n(su_campioni)} il quadro porta solo il campione di tre '
                      f'passaggi: il disegno mostra quelli, non la giornata intera.'))
            + f'<div class="griglia-mappe">{"".join(pezzi)}</div>')


def render_libretto(esistenti: list) -> str:
    """Il libretto orario delle linee in coincidenza.

    Per ogni relazione, i passaggi uno per uno: chi arriva, chi riparte, quanto
    si aspetta. E' il documento che un capo movimento legge davvero."""
    con_orari = [c for c in esistenti if passaggi_di(c)[0]]
    if not con_orari:
        return _niente_disegno("8.7 Il libretto orario delle coincidenze", len(esistenti),
                               "le relazioni non portano gli orari dei passaggi")
    out = ["<h3>8.7 Il libretto orario delle coincidenze</h3>"]
    out.append(para(
        "Per ogni relazione riconosciuta, i passaggi uno per uno: la corsa che arriva, quella che "
        "riparte, e i minuti di attesa fra le due. \u00c8 quello che serve al banco per verificare "
        "una coincidenza senza rifare i conti."))
    for c in con_orari:
        pg, completo = passaggi_di(c)
        a = _attesa(c)
        out.append(f'<h4>{esc(c.get("node") or "")} \u00b7 {esc(str(c.get("fromRoute")))} '
                   f'\u2192 {esc(str(c.get("toRoute")))}</h4>')
        # Il numero vero e' `occurrences`: quando il libretto e' troncato dal
        # cap, o e' il campione di tre, scrivere len(pg) farebbe dire «60» a
        # 8.7 e «84» a 8.4 per la stessa relazione, nella stessa pagina.
        n_veri = int(c.get("occurrences") or 0)
        quanti = (f'{fmt_n(len(pg))} passaggi al giorno'
                  if completo and n_veri <= len(pg) else
                  f'{fmt_n(n_veri or len(pg))} passaggi al giorno, di cui '
                  f'{fmt_n(len(pg))} qui sotto')
        out.append(para(f'<span class="small">{quanti}, attesa da '
                        f'{fmt_n(a.get("min"))} a {fmt_n(a.get("max"))} minuti '
                        f'(mediana {fmt_n(a.get("mediana"))}).</span>'))
        out.append(table(["Arrivo", "Riparte", "Attesa"],
                         [(x.get("arrivo") or "", x.get("partenza") or "",
                           f'{fmt_n(x.get("attesaMin"))}\u2032') for x in pg],
                         numeric_from=2))
    return "".join(out)


def render_coincidenze(d: dict) -> str:
    """8 — LE COINCIDENZE: che servizio produce questo orario.

    Un piano si giudica anche da quante relazioni fra linee l'orario realizza:
    due linee che si incontrano a un nodo con un'attesa abbastanza corta da
    cambiare mezzo, e abbastanza lunga da fare in tempo a scendere e salire."""
    co = g(d, "analisi", "coincidenze", default=None)
    out = [section("coincidenze", "8. Coincidenze fra linee")]
    if not isinstance(co, dict) or co.get("errore"):
        out.append(para(f'<i>Mappa delle coincidenze non disponibile: {esc((co or {}).get("errore") or "dato assente nel dossier")}.</i>'))
        return "".join(out)
    out.append(para(
        "Una coincidenza è due linee che si incontrano a un nodo con un'attesa dentro una finestra utile: "
        f'fra {fmt_n(co.get("attesaMinimaMin") or 2)} e {fmt_n(co.get("sogliaAttesaMin") or 5)} minuti — '
        "abbastanza per scendere e salire, non tanta da rendere inutile il cambio. Non sono dichiarate a mano: "
        "il sistema le riconosce dall'orario, e conta come relazione solo ciò che si ripete almeno "
        f'{fmt_n(co.get("minOccorrenze") or 3)} volte al giorno. Il conto include anche i passaggi in transito: '
        "una linea che passa a un capolinea altrui senza fermarsi fa coincidenza come una che ci parte."))
    esistenti = [x for x in (co.get("esistenti") or []) if isinstance(x, dict)]
    mancate = [x for x in (co.get("mancatePerPoco") or []) if isinstance(x, dict)]
    opp = [x for x in (co.get("opportunita") or []) if isinstance(x, dict)]
    # Le linee scelte in fase di esportazione: la rete intera in un capitolo solo
    # non si legge, e chi chiede la relazione sa quali relazioni gli interessano.
    scelte = linee_scelte(d)
    if scelte:
        tutte_e, tutte_m = len(esistenti), len(mancate)
        esistenti = filtra_per_linee(esistenti, scelte)
        mancate = filtra_per_linee(mancate, scelte)
        regola = ("tutte le relazioni che la toccano" if len(set(scelte)) == 1
                  else "le relazioni con tutti e due i capi fra queste linee")
        out.append(para(
            f'<b>Questo capitolo è limitato alle linee scelte in fase di esportazione</b>: '
            f'{esc(", ".join(sorted(set(scelte), key=ordine_di_linea)))}. Si tengono {regola} — '
            f'{fmt_n(len(esistenti))} relazioni realizzate su {fmt_n(tutte_e)} e '
            f'{fmt_n(len(mancate))} mancate per poco su {fmt_n(tutte_m)}. '
            f'Il dossier conserva comunque tutta la rete: il taglio è del documento, non del dato.'))
    out.append(rc.kpi_row([
        ("Relazioni realizzate", fmt_n(len(esistenti)), "l'orario le produce davvero"),
        ("Mancate per poco", fmt_n(len(mancate)), "attesa appena fuori finestra"),
        ("Occasioni di traslazione", fmt_n(len(opp)), "saldo positivo fra create e rotte"),
        ("Corse esaminate", fmt_n(co.get("corse") or 0), f'{fmt_n(co.get("corseConPassaggi") or 0)} con i passaggi intermedi'),
    ]))
    if esistenti:
        out.append(render_nodi_coincidenza(esistenti))
        out.append(render_coincidenze_quando(esistenti))
        out.append(render_coincidenze_ritmo(d, esistenti))
        out.append("<h3>8.4 Le relazioni che l'orario realizza</h3>")
        righe = []
        for x in esistenti:
            a = _attesa(x)
            righe.append((x.get("node") or "", f'{x.get("fromRoute")} → {x.get("toRoute")}',
                          fmt_n(x.get("occurrences")),
                          f'{fmt_n(a.get("min"))}–{fmt_n(a.get("max"))}′',
                          ", ".join(f'{s_.get("arrivo")}→{s_.get("partenza")}'
                                    for s_ in (x.get("sample") or [])[:3])))
        out.append(table(["Nodo", "Da → a", "Volte al giorno", "Attesa", "Esempi di orario"], righe, numeric_from=2))
        out.append(para('<span class="small">Nessuno spostamento proposto dal sistema ha il diritto di rompere '
                        'queste relazioni: sono un vincolo del ciclo, non una preferenza.</span>'))
        out.append(render_libretto(esistenti))
    if mancate:
        out.append("<h3>8.5 Le occasioni mancate per poco</h3>")
        out.append(para("Due linee che si sfiorano a un nodo con un'attesa appena fuori dalla finestra utile. "
                        "Sono il valore che la rete produrrebbe quasi gratis, e che nessuno contava."))
        righe = []
        for x in mancate[:20]:
            a = _attesa(x)
            righe.append((x.get("node") or "", f'{x.get("fromRoute")} → {x.get("toRoute")}',
                          fmt_n(x.get("occorrenze") or x.get("occurrences")),
                          f'{fmt_n(a.get("min"))}–{fmt_n(a.get("max"))}′',
                          fmt_n(a.get("mediana")),
                          "sì" if x.get("giaInCoincidenza") else "no"))
        out.append(table(["Nodo", "Da → a", "Incontri", "Attesa", "Mediana", "Già in coincidenza"], righe, numeric_from=2))
        if len(mancate) > 20:
            out.append(para(f'<span class="small">… e altre {len(mancate) - 20} relazioni mancate per poco.</span>'))
    if opp:
        out.append("<h3>8.6 Che cosa si guadagnerebbe spostando una linea</h3>")
        out.append(para("Per ogni linea, la traslazione dell'intera giornata che guadagna più relazioni di quante "
                        "ne rompe: la cadenza resta identica e lo spostamento è difendibile davanti all'utenza. "
                        "Il conto delle relazioni rotte è sempre esposto, perché un guadagno che costa altrove "
                        "non è un guadagno. L'ultima colonna dice se le corse reggono quello spostamento secondo "
                        "la flessibilità dichiarata in pianificazione."))
        righe = []
        for x in opp[:16]:
            b = x.get("migliore") or {}
            righe.append((str(x.get("route")), fmt_n(x.get("corse")), segno_min(b.get("deltaMin")),
                          fmt_n(b.get("create")), fmt_n(b.get("rotte")),
                          fmt_n(x.get("flexDichiarataMin") or 0) + "′",
                          "sì" if b.get("dentroLaFlessibilita") else "no"))
        out.append(table(["Linea", "Corse", "Spostamento", "Relazioni create", "Rotte", "Flessibilità", "Dentro la flessibilità"],
                         righe, numeric_from=1))
    if co.get("nota"):
        out.append(para(f'<span class="small">{esc(co.get("nota"))}</span>'))
    return "".join(out)


def render_costs(d: dict) -> str:
    vm = g(d, "final", "vsp", "metrics", default={}) or {}
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    cs = g(d, "final", "crew", "summary", default={}) or {}
    costs = d.get("costs") or {}
    out = [section("costi", "9. Costi")]
    unit = costs.get("unit") or unit_cost_table(g(d, "final", "params", default={}) or {})
    if unit:
        out.append("<h3>9.1 Valori unitari in uso</h3>")
        out.append(table(["Voce", "Valore", "Unità", "Fonte"], [(u.get("label"), u.get("value"), u.get("unit") or "", u.get("source") or "") for u in unit], numeric_from=1))
    for n in costs.get("notes") or []:
        out.append(f'<div class="callout">{esc(n)}</div>')
    vcost = vehicle_cost_net(d)
    ccost = float(cs.get("totalDailyCost") or sum(float(x.get("costEuro") or 0) for x in ds) or 0)
    total = vcost + ccost
    out.append("<h3>9.2 Ripartizione del costo giornaliero</h3>")
    out.append(rc.kpi_row([("Totale giornaliero", fmt_eur(total), "vetture + guida"), ("Vetture", fmt_eur(vcost), f'{fmt_n(100 * vcost / total, 1) if total else 0} %'),
                           ("Guida", fmt_eur(ccost), f'{fmt_n(100 * ccost / total, 1) if total else 0} %'),
                           ("Per corsa", fmt_eur(total / max(1, vm.get("totalTrips") or 1), 2), "costo medio"),
                           ("Per ora di servizio", fmt_eur(total / max(1e-9, (vm.get("totalServiceMin") or 1) / 60), 2), "costo medio")]))
    comp = Counter()
    for x in ds:
        cb = x.get("costBreakdown") or {}
        for k, v in cb.items():
            if isinstance(v, (int, float)) and k != "total":
                comp[k] += float(v)
    if comp:
        items = [(COST_COMPONENT_LABEL.get(k, k), v) for k, v in sorted(comp.items(), key=lambda kv: -kv[1]) if abs(v) > 0.005]
        if items:
            out.append(rc.bar_h(items, "Costo guida per componente", unit="€", fmt=lambda v: fmt_eur(v),
                                subtitle="Somma sui turni delle voci del modello dei costi (le voci a zero sono omesse)."))
    by_type = defaultdict(float)
    cnt = Counter()
    for x in ds:
        by_type[x.get("type")] += float(x.get("costEuro") or 0)
        cnt[x.get("type")] += 1
    if by_type:
        rows = [(DUTY_TYPE_LABEL.get(k, k), cnt[k], fmt_eur(by_type[k]), fmt_eur(by_type[k] / cnt[k], 2)) for k in DUTY_TYPE_ORDER if cnt.get(k)]
        out.append("<h3>9.3 Costo guida per tipo di turno</h3>")
        out.append(table(["Tipo", "Turni", "Costo", "Costo medio"], rows, numeric_from=1, total=("Totale", sum(cnt.values()), fmt_eur(sum(by_type.values())), fmt_eur(sum(by_type.values()) / max(1, sum(cnt.values())), 2))))
    if vm:
        out.append("<h3>9.4 Costo vetture</h3>")
        rows = [("Vetture impiegate", fmt_n(vm.get("vehicles") or 0)), ("km di linea", fmt_n(vm.get("totalServiceKm") or 0, 1)), ("km fuorilinea", fmt_n(vm.get("totalDeadheadKm") or 0, 1)),
                ("Minuti fuorilinea", fmt_n(vm.get("totalDeadheadMin") or 0)), ("Costo vetture", fmt_eur(vcost, 2))]
        _ombra = shadow_eur(d)
        if _ombra > 0.005:
            rows.append(("di cui penalità d'arco tolte dal conto",
                         f'{fmt_eur(_ombra, 2)} — non sono spesa: le inventa il motore per orientare la ricerca'))
        if vm.get("greedyCostEur"):
            rows.append(("Costo della soluzione di partenza (greedy)", fmt_eur(vm.get("greedyCostEur"), 2)))
            rows.append(("Risparmio dell'ottimizzazione", f'{fmt_eur(vm.get("savingsEur"), 2)} ({fmt_n(vm.get("savingsPct"), 1)} %)'))
        out.append(table(["Voce", "Valore"], rows, numeric_from=1))
    out.append(para('<span class="small">Il costo annuo si ottiene moltiplicando il costo giornaliero per il numero di giorni del giorno-tipo nel calendario di esercizio; '
                    'la relazione non lo calcola finché i valori unitari non sono confermati.</span>'))
    return "".join(out)


def render_runs(d: dict) -> str:
    runs = d.get("runs") or []
    out = [section("scenari", "10. Scenari confrontati")]
    if not runs:
        out.append(para("<i>Nessuna campagna di scenari nel dossier.</i>"))
        return "".join(out)
    out.append(para(f"Campagna di {len(runs)} giri di ottimizzazione sullo stesso servizio, con manopole e correzioni del motore via via diverse. Lo scenario selezionato è evidenziato."))
    rows = []
    for r in runs:
        k = r.get("kpi") or {}
        bt = k.get("byType") or {}
        rows.append((("★ " if r.get("selected") else "") + (r.get("name") or "?"), (r.get("at") or "")[:16], fmt_n(k.get("vehicles")), fmt_n(k.get("duties")),
                     f'{bt.get("intero", "–")}/{bt.get("semiunico", "–")}/{bt.get("spezzato", "–")}', fmt_n(k.get("violations")),
                     fmt_eur(k.get("vehicleCostEur")), fmt_eur(k.get("crewCostEur")), fmt_eur(k.get("totalCostEur")), fmt_eur(k.get("selectionScoreEur"))))
    out.append(table(["Scenario", "Data", "Vetture", "Turni", "Int/Semi/Spez", "Viol.", "C. vetture", "C. guida", "Totale", "Punteggio"], rows, numeric_from=2))
    cats = [r.get("name") or "?" for r in runs]
    if any((r.get("kpi") or {}).get("byType") for r in runs):
        series = [(DUTY_TYPE_LABEL[k], [((r.get("kpi") or {}).get("byType") or {}).get(k, 0) for r in runs]) for k in ("intero", "semiunico", "spezzato")]
        out.append(rc.columns(cats, series, "Turni per tipo nei giri della campagna", unit="turni", stacked=True, height=300))
    tot = [float((r.get("kpi") or {}).get("totalCostEur") or 0) for r in runs]
    if any(tot):
        out.append(rc.lines(cats, [("costo totale", tot)], "Costo totale per giro", unit="€", fmt=lambda v: fmt_eur(v), height=240))
    return "".join(out)


TIPO_TURNO = {"intero": "Intero", "semiunico": "Semiunico", "spezzato": "Spezzato",
              "supplemento": "Supplemento", "invalido": "Invalido"}
MEZZO_BREVE = {"autosnodato": "Snodato", "filobus": "Filobus", "12m": "12 m",
               "10m": "10 m", "pollicino": "Pollicino"}
SOSTA_FOGLIO_MIN = 15


def _hhmm(m) -> str:
    """L'ora a due cifre. Sul foglio del conducente 7:58 e 07:58 non sono la
    stessa cosa: le colonne devono incolonnarsi."""
    if m is None:
        return "–"
    m = int(round(m))
    return f"{m // 60:02d}:{m % 60:02d}"


def _orario(testo, minuti) -> str:
    """L'orario scritto dal motore, altrimenti quello ricavato dai minuti."""
    t = str(testo or "").strip()
    return t[:5] if t else _hhmm(minuti)


def _data_it(iso) -> str:
    s = str(iso or "")
    return f"{s[8:10]}/{s[5:7]}/{s[0:4]}" if len(s) >= 10 and s[4] == "-" and s[7] == "-" else s


def _mezzo(vt) -> str:
    return MEZZO_BREVE.get(str(vt or ""), str(vt or ""))


def _cambi_del_pezzo(pc: dict, tutti: list, usati: set) -> list:
    """I cambi di vettura che toccano questo pezzo: chi lo prende all'inizio,
    chi lo lascia alla fine, i passaggi a metà. Uno stesso cambio non può
    finire su due pezzi, per questo gli usati si segnano."""
    s, e = piece_service_bounds(pc)
    vids = set(pc.get("vehicleIds") or [])
    presi = []
    for i, h in enumerate(tutti):
        if i in usati or (vids and h.get("vehicleId") not in vids):
            continue
        preso = int(h.get("takenMin") if h.get("takenMin") is not None else (h.get("atMin") or 0))
        a = int(h.get("atMin") or 0)
        if ((h.get("role") == "incoming" and abs(preso - s) <= 1)
                or (h.get("role") == "outgoing" and abs(a - e) <= 1)
                or (s <= a <= e)):
            usati.add(i)
            presi.append((h, a if h.get("role") == "outgoing" else preso))
    return presi


def righe_del_foglio(turno: dict, deposito: str, note: list,
                     sosta_min: int = SOSTA_FOGLIO_MIN) -> list:
    """Le righe di un foglio turno, in ordine di orologio: pre-turno,
    trasferimenti, fuorilinea, corse, soste, cambi di vettura, interruzioni.

    È la stessa scaletta del foglio che esce da «Fucina → turni guida →
    esporta → Fogli turno»: chi guida deve trovare in relazione lo stesso
    documento che si porta in servizio, non una seconda versione."""
    righe: list[dict] = []
    usati: set[int] = set()
    tutti_h = list(turno.get("handovers") or [])
    pezzi = list(turno.get("riprese") or [])

    def richiamo(testo: str) -> str:
        r = chr(65 + (len(note) % 26))
        note.append((r, testo))
        return r

    for i, pc in enumerate(pezzi):
        s, e = piece_service_bounds(pc)
        pt = int(pc.get("preTurnoMin") or 0)
        tr = int(pc.get("transferMin") or 0)
        tb = int(pc.get("transferBackMin") or 0)
        if i > 0:
            prec = pezzi[i - 1]
            fine_prec = piece_service_bounds(prec)[1] + int(prec.get("transferBackMin") or 0)
            inizio = s - tr - pt
            if inizio > fine_prec:
                righe.append({"t": "interruzione", "da": fine_prec, "a": inizio, "ord": fine_prec, "p": 1})
        vuoti = sorted((pc.get("deadheads") or []), key=lambda d: int(d.get("departureMin") or 0))
        uscita = next((d for d in vuoti if d.get("kind") in ("pullout", "depot_out")), None)
        in_auto = tr > 0
        if pt > 0:
            dove = (f"Deposito di {deposito}" if in_auto or not uscita
                    else (uscita.get("fromStop") or f"Deposito di {deposito}"))
            righe.append({"t": "riga", "lbl": "Pre-turno", "da": s - tr - pt, "a": s - tr,
                          "dove": dove, "min": pt, "ord": s - tr - pt, "p": 1})
        if in_auto:
            righe.append({"t": "riga", "lbl": "Trasferimento", "da": s - tr, "a": s,
                          "dove": f"Deposito di {deposito}",
                          "verso": pc.get("transferToStop") or pc.get("transferToCluster") or "nodo",
                          "min": tr, "ord": s - tr, "p": 1})
        for d in vuoti:
            dep, arr = int(d.get("departureMin") or 0), int(d.get("arrivalMin") or 0)
            righe.append({"t": "riga", "lbl": d.get("label") or "Fuorilinea", "da": dep, "a": arr,
                          "dove": d.get("fromStop") or "–", "verso": d.get("toStop") or "–",
                          "min": int(d.get("minutes") or max(0, arr - dep)), "ord": dep, "p": 1})
        for h, quando in _cambi_del_pezzo(pc, tutti_h, usati):
            testo = str(h.get("description") or h.get("label") or "")
            if testo[:6].count(":") == 1 and "·" in testo[:10]:
                testo = testo.split("·", 1)[1].strip()
            dett = f" {h.get('detail')}" if h.get("detail") else ""
            righe.append({"t": "cambio", "quando": quando, "testo": testo,
                          "rich": richiamo(f"{_hhmm(quando)} · {testo}{dett}"),
                          "ord": quando, "p": 3 if "lascia" in testo.lower() else 0})
        corse = sorted((pc.get("trips") or []), key=lambda t: int(t.get("departureMin") or 0))
        for k, t in enumerate(corse):
            if k > 0:
                buco = int(t.get("departureMin") or 0) - int(corse[k - 1].get("arrivalMin") or 0)
                if buco >= sosta_min:
                    righe.append({"t": "sosta", "min": buco,
                                  "ord": int(corse[k - 1].get("arrivalMin") or 0), "p": 1})
            righe.append({"t": "corsa", "corsa": t, "ord": int(t.get("departureMin") or 0), "p": 2})
        if tb > 0:
            righe.append({"t": "riga", "lbl": "Rientro", "da": e, "a": e + tb,
                          "dove": pc.get("lastStop") or "nodo", "verso": f"Deposito di {deposito}",
                          "min": tb, "ord": e, "p": 1})
    righe.sort(key=lambda r: (r["ord"], r["p"]))
    return righe


def _scheda_corsa(t: dict, passaggi: list, rich: str | None = None) -> str:
    """Una corsa come la vede chi guida: la linea nel bollino, gli orari grandi
    ai due capi, la durata nel mezzo, i punti orari sotto."""
    dep, arr = int(t.get("departureMin") or 0), int(t.get("arrivalMin") or 0)
    dur = max(0, arr - dep)
    passi = "".join(
        f'<span>{esc(p.get("fermata") or "")} <b>{esc(str(p.get("ora") or "")[:5])}</b></span>'
        for p in (passaggi or []) if p.get("ora"))
    mezzo = f' · {esc(_mezzo(t.get("vehicleType")))}' if t.get("vehicleType") else ""
    coda = ""
    if t.get("variantCode"):
        coda += f'<span class="chip">{esc(t.get("variantCode"))}</span>'
    if rich:
        coda += f'<span class="richiamo">{esc(rich)}</span>'
    return (
        '<div class="corsa"><div class="corsa-testa">'
        f'<div><span class="bollino">{esc(t.get("routeName") or "–")}</span>'
        f'<div class="tm">TM {esc(t.get("vehicleId") or "–")}{mezzo}</div></div>'
        f'<div class="part"><div class="big">{esc(_orario(t.get("departureTime"), dep))}</div>'
        f'<div class="dove">{esc(t.get("firstStopName") or "–")}</div></div>'
        '<div class="tratto"><span class="cerchio"></span><span class="filo"></span>'
        f'<span class="dur">{dur}′</span><span class="filo"></span><span class="punta"></span></div>'
        f'<div class="arrivo"><div class="big">{esc(_orario(t.get("arrivalTime"), arr))}</div>'
        f'<div class="dove">{esc(t.get("lastStopName") or "–")}</div></div>'
        f'<div class="coda">{coda}</div></div>'
        + (f'<div class="passaggi">{passi}</div>' if passi else "")
        + "</div>")


def _riga_foglio(r: dict, passaggi_per_corsa: dict) -> str:
    if r["t"] == "corsa":
        t = r["corsa"]
        return _scheda_corsa(t, (passaggi_per_corsa or {}).get(str(t.get("tripId") or "")))
    if r["t"] == "sosta":
        return f'<div class="stacco"><span>SOSTA {r["min"]}′</span></div>'
    if r["t"] == "interruzione":
        return (f'<div class="stacco forte"><span>INTERRUZIONE {_hhmm(r["da"])} – '
                f'{_hhmm(r["a"])} ({r["a"] - r["da"]}′)</span></div>')
    if r["t"] == "cambio":
        rich = f'<span class="richiamo">{esc(r["rich"])}</span>' if r.get("rich") else ""
        return ('<div class="riga cambio"><span class="lbl">Cambio</span>'
                f'<span class="t">{_hhmm(r["quando"])}</span>'
                f'<span class="txt">{esc(r["testo"])}</span>{rich}</div>')
    verso = f' <span class="freccia">→</span> {esc(r["verso"])}' if r.get("verso") else ""
    return ('<div class="riga"><span class="lbl">' + esc(r["lbl"]) + "</span>"
            f'<span class="t">{_hhmm(r["da"])}</span>'
            f'<span class="txt">{esc(r["dove"])}{verso}</span>'
            f'<span class="chip">{r["min"]}′</span>'
            f'<span class="t fine">{_hhmm(r["a"])}</span></div>')


def foglio_turno_guida(turno: dict, m: dict, passaggi_per_corsa: dict,
                       deposito_di_scorta: str = "") -> str:
    """Un turno guida su un foglio solo, nel formato della Fucina."""
    deposito = (str(turno.get("residenzaName") or deposito_di_scorta or "").strip() or "–")
    note: list = []
    righe = righe_del_foglio(turno, deposito, note)
    n_corse = sum(len(p.get("trips") or []) for p in (turno.get("riprese") or []))
    for v in (g(turno, "bdsValidation", "violations", default=[]) or []):
        note.append(("!", str(v.get("message") or v) if isinstance(v, dict) else str(v)))
    for h in (turno.get("vehicleHandoverLabels") or []):
        note.append(("·", str(h)))
    giorno = str(m.get("dayType") or "").split("(")[0].strip().upper()
    tipo = TIPO_TURNO.get(str(turno.get("type") or ""), str(turno.get("type") or "")).upper()
    programma = str(m.get("scenarioName") or "")
    vigore = _data_it(m.get("serviceDate"))
    interruzione = int(turno.get("interruptionMin") or 0)
    corpo = "".join(_riga_foglio(r, passaggi_per_corsa) for r in righe)
    note_html = ("".join(f'<div class="nota"><span class="richiamo">{esc(r)}</span>{esc(t)}</div>'
                         for r, t in note)
                 if note else '<div class="nota assenti">–</div>')
    return (
        '<section class="foglio">'
        '<div class="testa"><div><div class="matricola">' + esc(turno.get("driverId") or "–") + "</div>"
        f'<div class="sub"><span class="deposito">{esc(deposito.upper())}</span>'
        f'<span class="chip vuota">{esc(tipo)}</span>'
        + (f'<span class="chip verde">{esc(giorno)}</span>' if giorno else "")
        + "</div></div>"
        '<div class="destra">'
        f'<div><span class="k">Nastro</span><b>{esc(turno.get("nastroStart") or _hhmm(turno.get("nastroStartMin")))} '
        f'– {esc(turno.get("nastroEnd") or _hhmm(turno.get("nastroEndMin")))}</b></div>'
        f'<div><span class="k">Presentazione</span><b>{esc(turno.get("nastroStart") or _hhmm(turno.get("nastroStartMin")))}</b></div>'
        f'<div><span class="k">Corse</span><b>{n_corse}</b></div>'
        "</div></div>"
        f'<div class="programma"><span>{esc(programma)}</span>'
        + (f"<span>in vigore dal <b>{esc(vigore)}</b></span>" if vigore else "")
        + "</div>"
        f'<div class="corpo">{corpo}</div>'
        '<div class="piede"><div class="conti">'
        f'<span class="k">Competenze</span><span class="k">Nastro</span><b>{_hhmm(turno.get("nastroMin"))}</b>'
        f'<span class="k">Lavoro</span><b>{_hhmm(turno.get("workMin"))}</b>'
        + (f'<span class="k">Interruzione</span><b>{_hhmm(interruzione)}</b>' if interruzione else "")
        + "</div>"
        f'<div class="note"><span class="k">Note</span>{note_html}</div>'
        "</div></section>")


def foglio_turno_macchina(v: dict, m: dict) -> str:
    """Un turno macchina su un foglio solo: la stessa intestazione del foglio
    guida, poi il programma della vettura riga per riga."""
    corse = sorted((v.get("trips") or []), key=lambda t: int(t.get("departureMin") or 0))
    righe = []
    for t in corse:
        tipo = str(t.get("type") or "trip")
        leg = str(t.get("depotLeg") or "")
        etichetta = ({"out": "Uscita deposito", "in": "Rientro deposito"}.get(leg, "Fuorilinea")
                     if tipo != "trip" else (t.get("routeName") or "–"))
        righe.append((etichetta,
                      _orario(t.get("departureTime"), t.get("departureMin")),
                      t.get("firstStopName") or t.get("fromStop") or "–",
                      t.get("lastStopName") or t.get("toStop") or "–",
                      _orario(t.get("arrivalTime"), t.get("arrivalMin")),
                      fmt_n(t.get("deadheadKm"), 1) if t.get("deadheadKm") else ""))
    giorno = str(m.get("dayType") or "").split("(")[0].strip().upper()
    nastro = int(v.get("shiftDuration") or (int(v.get("endMin") or 0) - int(v.get("startMin") or 0)))
    deposito = str(v.get("residenzaName") or "").strip()
    return (
        '<section class="foglio">'
        '<div class="testa"><div><div class="matricola">' + esc(v.get("vehicleId") or "–") + "</div>"
        '<div class="sub">'
        + (f'<span class="deposito">{esc(deposito.upper())}</span>' if deposito else "")
        + f'<span class="chip vuota">{esc(_mezzo(v.get("vehicleType")) or "–")}</span>'
        + (f'<span class="chip verde">{esc(giorno)}</span>' if giorno else "")
        + "</div></div>"
        '<div class="destra">'
        f'<div><span class="k">Nastro</span><b>{_hhmm(v.get("startMin"))} – {_hhmm(v.get("endMin"))}</b></div>'
        f'<div><span class="k">Durata</span><b>{_hhmm(nastro)}</b></div>'
        f'<div><span class="k">Corse</span><b>{len([t for t in corse if str(t.get("type") or "trip") == "trip"])}</b></div>'
        "</div></div>"
        f'<div class="programma"><span>{esc(str(m.get("scenarioName") or ""))}</span>'
        f'<span>in vigore dal <b>{esc(_data_it(m.get("serviceDate")))}</b></span></div>'
        + table(["Linea / attività", "Partenza", "Da", "A", "Arrivo", "km vuoto"], righe, numeric_from=5)
        + '<div class="piede"><div class="conti">'
        f'<span class="k">Servizio</span><b>{_hhmm(v.get("totalServiceMin"))}</b>'
        f'<span class="k">km a vuoto</span><b>{fmt_n(v.get("totalDeadheadKm") or 0, 1)}</b>'
        f'<span class="k">Rientri in deposito</span><b>{fmt_n(v.get("depotReturns") or 0)}</b>'
        "</div></div></section>")


def render_appendix(d: dict) -> str:
    vs = g(d, "final", "vsp", "vehicleShifts", default=[]) or []
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    passaggi = g(d, "final", "crew", "passaggi", default={}) or {}
    m = d.get("meta") or {}
    deposito = ""
    for x in ds:
        if x.get("residenzaName"):
            deposito = str(x.get("residenzaName"))
            break
    out = [section("allegati", "11. Allegati")]
    if vs or ds:
        out.append(para(
            "Gli allegati sono i fogli turno veri e propri, nello stesso formato che esce "
            "da <b>Fucina → turni guida → esporta → Fogli turno</b>: un turno per "
            "pagina, con la linea nel bollino, gli orari ai due capi della corsa e le "
            "competenze in fondo. Si staccano e si consegnano così come sono."))
    if ds:
        out.append("<h3>A. Fogli turno guida</h3>")
        for x in sorted(ds, key=lambda t: (int(t.get("nastroStartMin") or 0), str(t.get("driverId") or ""))):
            out.append(foglio_turno_guida(x, m, passaggi, deposito))
    if vs:
        out.append("<h3>B. Fogli turno macchina</h3>")
        for v in sorted(vs, key=lambda x: (int(x.get("startMin") or 0), str(x.get("vehicleId") or ""))):
            out.append(foglio_turno_macchina(v, m))
    return "".join(out)


def _capitolo(render, dossier: dict, nome: str) -> str:
    """Un capitolo che si rompe non deve portarsi via la relazione.

    Il dossier arriva dal campo dove la forma dei dati cambia nel tempo: e'
    gia' successo che un campo diventasse un oggetto e che il formattatore si
    fermasse a meta' documento, lasciando l'operatore senza niente. Meglio un
    capitolo mancante, dichiarato in chiaro nel documento e registrato nei
    log, che nessun documento."""
    try:
        return render(dossier)
    except Exception as e:                                    # noqa: BLE001
        print(f"[report] capitolo «{nome}» non prodotto: {type(e).__name__}: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return para(f'<i>Il capitolo «{esc(nome)}» non e\u0027 stato prodotto: '
                    f'{esc(type(e).__name__)}. Il resto della relazione e\u0027 completo.</i>')


def build(dossier: dict) -> str:
    m = dossier.get("meta") or {}
    title = m.get("title") or "Relazione del piano di esercizio"
    capitoli = [(render_cover, "copertina"), (render_summary, "sintesi"), (render_network, "rete"),
                (render_planning, "pianificazione"), (render_method, "metodo"), (render_vehicles, "turni macchina"),
                (render_crew, "turni guida"), (render_ciclo, "ciclo integrato"), (render_coincidenze, "coincidenze"),
                (render_costs, "costi"), (render_runs, "scenari"), (render_appendix, "allegati")]
    body = "".join(_capitolo(r, dossier, nome) for r, nome in capitoli)
    return (f'<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{esc(title)}</title><style>{rc.CSS}</style></head><body><div class="page">{body}'
            f'<p class="meta">Relazione generata automaticamente da TransitIntel · {esc(m.get("generatedAt") or "")}</p></div></body></html>')


def summary_of(dossier: dict) -> dict:
    """Sintesi numerica della relazione (per la chat e per l'elenco relazioni)."""
    vm = g(dossier, "final", "vsp", "metrics", default={}) or {}
    ds = g(dossier, "final", "crew", "driverShifts", default=[]) or []
    cs = g(dossier, "final", "crew", "summary", default={}) or {}
    st = crew_stats(ds)
    vcost = vehicle_cost_net(dossier)
    ccost = float(cs.get("totalDailyCost") or st["cost"] or 0)
    return {
        "trips": vm.get("totalTrips"), "vehicles": vm.get("vehicles"), "duties": cs.get("totalDriverShifts") or len(ds),
        "byType": dict(st["byType"]), "violations": st["violations"], "warnings": st["warnings"],
        "vehicleCostEur": round(vcost, 2), "crewCostEur": round(ccost, 2), "totalCostEur": round(vcost + ccost, 2),
        "deadheadKm": vm.get("totalDeadheadKm"), "serviceKm": vm.get("totalServiceKm"),
        "companyCarsPeak": cs.get("companyCarsMaxSimultaneous"), "runs": len(dossier.get("runs") or []),
        "lines": len(g(dossier, "network", "lines", default=[]) or []),
        "planningEvents": len(g(dossier, "planning", "timeline", default=[]) or []),
        "isTest": bool(g(dossier, "meta", "isTest", default=False)),
        "sections": [t for _, t in TOC],
    }


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    raw = open(args[0], encoding="utf-8").read() if args and args[0] != "-" else sys.stdin.read()
    dossier = json.loads(raw)
    html_out = build(dossier)
    if as_json:
        sys.stdout.write(json.dumps({"html": html_out, "summary": summary_of(dossier)}, ensure_ascii=False))
    else:
        sys.stdout.write(html_out)


if __name__ == "__main__":
    main()
