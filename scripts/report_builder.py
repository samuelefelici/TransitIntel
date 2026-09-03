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
from collections import Counter, defaultdict
from typing import Any

import report_charts as rc
from report_charts import esc, hm, fmt_eur, fmt_n

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
                s, e = int(p.get("endMin") or 0), int(nxt.get("startMin") or 0)
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

TOC = [("sintesi", "1. Sintesi per la direzione"), ("rete", "2. Rete e contesto"),
       ("pianificazione", "3. Pianificazione del servizio"), ("metodo", "4. Metodo e modelli matematici"),
       ("macchina", "5. Turni macchina"), ("guida", "6. Turni guida"), ("costi", "7. Costi"),
       ("scenari", "8. Scenari confrontati"), ("allegati", "9. Allegati")]


def render_cover(d: dict) -> str:
    m = d.get("meta") or {}
    title = m.get("title") or f'Relazione del piano di esercizio · {m.get("udpName") or m.get("projectName") or ""}'
    sub = m.get("subtitle") or ""
    gen = m.get("generatedAt") or _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    bits = [b for b in (m.get("company"), m.get("projectName"), m.get("udpName"),
                        f'giorno di servizio {m.get("serviceDate")}' if m.get("serviceDate") else None,
                        f'giorno-tipo {m.get("dayType")}' if m.get("dayType") else None,
                        f'scenario «{m.get("scenarioName")}»' if m.get("scenarioName") else None,
                        f'generata il {gen}') if b]
    out = [f"<h1>{esc(title)}</h1>"]
    if sub:
        out.append(f'<p class="lead">{esc(sub)}</p>')
    out.append(f'<p class="meta">{esc(" · ".join(bits))}</p>')
    if m.get("isTest"):
        out.append(f'<div class="banner"><b>Versione di prova.</b> {esc(m.get("testNote") or "I costi unitari e i fuorilinea non sono ancora stati verificati: i valori economici sono indicativi.")}</div>')
    out.append('<div class="toc">' + "".join(f'<div><a href="#{i}">{esc(t)}</a></div>' for i, t in TOC) + "</div>")
    return "".join(out)


def render_summary(d: dict) -> str:
    vm = g(d, "final", "vsp", "metrics", default={}) or {}
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    cs = g(d, "final", "crew", "summary", default={}) or {}
    st = crew_stats(ds)
    n_duties = cs.get("totalDriverShifts") or len(ds)
    vehicles = vm.get("vehicles") or len(g(d, "final", "vsp", "vehicleShifts", default=[]) or [])
    vcost = float(vm.get("costEur") or 0)
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
    out = [section("sintesi", "1. Sintesi per la direzione", first=True), rc.kpi_row(tiles)]
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
    out.append(para(f'La rete del giorno-tipo comprende <b>{len(lines)} linee</b>' + (f' e {fmt_n(net["stopsCount"])} fermate' if net.get("stopsCount") else "") +
                    (f'; nodi di interscambio: {esc(", ".join(net["nodes"]))}.' if net.get("nodes") else ".")))
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
    if net.get("polylines"):
        out.append(rc.network_map(net["polylines"], net.get("stops") or [], "Disegno della rete",
                                  subtitle="Tracciati delle linee del giorno-tipo; i nodi di interscambio sono evidenziati.",
                                  note="Proiezione equirettangolare semplificata; le prime otto linee hanno una tinta propria, le altre sono in grigio."))
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
    if dh_rows:
        out.append(para(f'{len(dh_rows)} movimenti a vuoto per {fmt_n(sum(r[6] for r in dh_rows), 1)} km: ' +
                        ", ".join(f'{esc(k)} {fmt_n(v, 1)} km' for k, v in agg.most_common()) + "."))
        out.append(table(["Vettura", "Ora", "Da", "A", "Tratta", "min", "km"], dh_rows[:80], numeric_from=5))
        if len(dh_rows) > 80:
            out.append(para(f'<span class="small">… e altri {len(dh_rows) - 80} movimenti (elenco completo nell\'allegato).</span>'))
    else:
        out.append(para("Nessun fuorilinea fra corse: le vetture rientrano solo a fine servizio."))
    return "".join(out)


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
             ("Cambi in linea", fmt_n(st["cambi"]), "passaggi di vettura fra conducenti"),
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
        desc = " | ".join(f'{(pc.get("vehicleIds") or ["?"])[0]} {hm(pc.get("serviceStartMin", pc.get("startMin")))}–{hm(pc.get("serviceEndMin", pc.get("endMin")))} '
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


def render_costs(d: dict) -> str:
    vm = g(d, "final", "vsp", "metrics", default={}) or {}
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    cs = g(d, "final", "crew", "summary", default={}) or {}
    costs = d.get("costs") or {}
    out = [section("costi", "7. Costi")]
    unit = costs.get("unit") or unit_cost_table(g(d, "final", "params", default={}) or {})
    if unit:
        out.append("<h3>7.1 Valori unitari in uso</h3>")
        out.append(table(["Voce", "Valore", "Unità", "Fonte"], [(u.get("label"), u.get("value"), u.get("unit") or "", u.get("source") or "") for u in unit], numeric_from=1))
    for n in costs.get("notes") or []:
        out.append(f'<div class="callout">{esc(n)}</div>')
    vcost = float(vm.get("costEur") or 0)
    ccost = float(cs.get("totalDailyCost") or sum(float(x.get("costEuro") or 0) for x in ds) or 0)
    total = vcost + ccost
    out.append("<h3>7.2 Ripartizione del costo giornaliero</h3>")
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
        out.append("<h3>7.3 Costo guida per tipo di turno</h3>")
        out.append(table(["Tipo", "Turni", "Costo", "Costo medio"], rows, numeric_from=1, total=("Totale", sum(cnt.values()), fmt_eur(sum(by_type.values())), fmt_eur(sum(by_type.values()) / max(1, sum(cnt.values())), 2))))
    if vm:
        out.append("<h3>7.4 Costo vetture</h3>")
        rows = [("Vetture impiegate", fmt_n(vm.get("vehicles") or 0)), ("km di linea", fmt_n(vm.get("totalServiceKm") or 0, 1)), ("km fuorilinea", fmt_n(vm.get("totalDeadheadKm") or 0, 1)),
                ("Minuti fuorilinea", fmt_n(vm.get("totalDeadheadMin") or 0)), ("Costo vetture", fmt_eur(vcost, 2))]
        if vm.get("greedyCostEur"):
            rows.append(("Costo della soluzione di partenza (greedy)", fmt_eur(vm.get("greedyCostEur"), 2)))
            rows.append(("Risparmio dell'ottimizzazione", f'{fmt_eur(vm.get("savingsEur"), 2)} ({fmt_n(vm.get("savingsPct"), 1)} %)'))
        out.append(table(["Voce", "Valore"], rows, numeric_from=1))
    out.append(para('<span class="small">Il costo annuo si ottiene moltiplicando il costo giornaliero per il numero di giorni del giorno-tipo nel calendario di esercizio; '
                    'la relazione non lo calcola finché i valori unitari non sono confermati.</span>'))
    return "".join(out)


def render_runs(d: dict) -> str:
    runs = d.get("runs") or []
    out = [section("scenari", "8. Scenari confrontati")]
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


def render_appendix(d: dict) -> str:
    vs = g(d, "final", "vsp", "vehicleShifts", default=[]) or []
    ds = g(d, "final", "crew", "driverShifts", default=[]) or []
    out = [section("allegati", "9. Allegati")]
    if vs:
        out.append("<h3>A. Turni macchina, corsa per corsa</h3>")
        for v in vs:
            rows = []
            for t in v.get("trips", []):
                rows.append((t.get("type"), t.get("routeName") or "–", t.get("departureTime") or hm(t.get("departureMin")), t.get("arrivalTime") or hm(t.get("arrivalMin")),
                             t.get("firstStopName") or "–", t.get("lastStopName") or "–", fmt_n(t.get("deadheadKm"), 1) if t.get("deadheadKm") else ""))
            out.append(f'<h4>{esc(v.get("vehicleId"))} · {esc(v.get("vehicleType") or "")} · {hm(v.get("startMin"))}–{hm(v.get("endMin"))}</h4>')
            out.append(table(["Tipo", "Linea", "Partenza", "Arrivo", "Da", "A", "km vuoto"], rows, numeric_from=6))
    if ds:
        out.append("<h3>B. Turni guida, pezzo per pezzo</h3>")
        for x in ds:
            out.append(f'<h4>{esc(x.get("driverId"))} · {esc(x.get("type"))} · nastro {hm(x.get("nastroMin"))} · lavoro {hm(x.get("workMin"))}</h4>')
            rows = []
            for i, pc in enumerate(x.get("riprese") or [], 1):
                veh = (pc.get("vehicleIds") or ["?"])[0]
                svc_start = pc.get("serviceStartMin", pc.get("startMin"))
                svc_end = pc.get("serviceEndMin", pc.get("endMin"))
                pt, tr, tb = int(pc.get("preTurnoMin") or 0), int(pc.get("transferMin") or 0), int(pc.get("transferBackMin") or 0)
                # pre-turno e trasferimento in auto PRIMA della presa in carico del bus
                if pt and svc_start is not None:
                    kind = "presa bus in deposito (controlli)" if pc.get("preTurnoKind") == "bus" or tr == 0 else "auto aziendale"
                    rows.append((i, veh, f"Pre-turno · {kind}", hm(svc_start - tr - pt), hm(svc_start - tr), "Deposito", "–"))
                if tr and svc_start is not None:
                    rows.append((i, veh, "Trasferimento auto", hm(svc_start - tr), hm(svc_start), "Deposito", pc.get("transferToStop") or "–"))
                # corse e fuorilinea in ordine di tempo
                events = [("trip", t) for t in (pc.get("trips") or [])] + [("dh", d) for d in (pc.get("deadheads") or [])]
                events.sort(key=lambda e: int(e[1].get("departureMin") or 0))
                for kind, e in events:
                    if kind == "trip":
                        rows.append((i, veh, e.get("routeName") or "–", hm(e.get("departureMin")), hm(e.get("arrivalMin")), e.get("firstStopName") or "–", e.get("lastStopName") or "–"))
                    else:
                        km = f' · {e.get("km")} km' if e.get("km") is not None else ""
                        rows.append((i, veh, f'{e.get("label") or "Fuorilinea"}{km}', hm(e.get("departureMin")), hm(e.get("arrivalMin")), e.get("fromStop") or "–", e.get("toStop") or "–"))
                if tb and svc_end is not None:
                    rows.append((i, veh, "Rientro auto", hm(svc_end), hm(svc_end + tb), pc.get("lastStop") or "–", "Deposito"))
            out.append(table(["Pezzo", "Vettura", "Linea / attività", "Partenza", "Arrivo", "Da", "A"], rows, numeric_from=99))
            for h in x.get("vehicleHandoverLabels") or []:
                out.append(para(f'<span class="small">{esc(h)}</span>'))
    return "".join(out)


def build(dossier: dict) -> str:
    m = dossier.get("meta") or {}
    title = m.get("title") or "Relazione del piano di esercizio"
    body = "".join([render_cover(dossier), render_summary(dossier), render_network(dossier), render_planning(dossier),
                    render_method(dossier), render_vehicles(dossier), render_crew(dossier), render_costs(dossier),
                    render_runs(dossier), render_appendix(dossier)])
    return (f'<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{esc(title)}</title><style>{rc.CSS}</style></head><body><div class="page">{body}'
            f'<p class="meta">Relazione generata automaticamente da TransitIntel · {esc(m.get("generatedAt") or "")}</p></div></body></html>')


def summary_of(dossier: dict) -> dict:
    """Sintesi numerica della relazione (per la chat e per l'elenco relazioni)."""
    vm = g(dossier, "final", "vsp", "metrics", default={}) or {}
    ds = g(dossier, "final", "crew", "driverShifts", default=[]) or []
    cs = g(dossier, "final", "crew", "summary", default={}) or {}
    st = crew_stats(ds)
    vcost = float(vm.get("costEur") or 0)
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
