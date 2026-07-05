"""
Rotazione Riposi — calcolatore CP-SAT.

Cerca il miglior pattern settimanale di riposi su una griglia N settimane × 7
giorni: ogni settimana è una riga del ciclo, ogni conducente parte da una riga
diversa e avanza di una settimana alla volta (ciclo che si chiude dopo N
settimane). Minimizza l'eccedenza di personale sui giorni, rispettando la
domanda feriale/domenicale, i riposi/anno target e i vincoli.

Adattato dal calcolatore fornito (streamlit + OR-Tools) in uno strumento
headless: JSON su stdin → JSON su stdout.

Input (stdin):
  {
    "domanda_feriali": 51, "domanda_domenica": 15,
    "mode": "forza" | "pct",
    "forza_feriale_reale": 66, "riserva_domenica_pct": 25.0,
    "riposi_anno_target": 54.0, "tol_riposi": 1.0,
    "max_consec": 6, "balance_weekday": true,
    "n_min": 11, "n_max": 56, "k_min": 1, "k_max": 4,
    "timeout_per_attempt": 4, "top_n": 12
  }
Output (stdout): { "results": [ {N,K,T,pattern,...} ], "count": n }
"""
import math
import sys
import json
from typing import Any, Dict, List, Optional, Tuple

from ortools.sat.python import cp_model

GIORNI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"]


def _domenica_effettiva(dom_feriali, dom_domenica, forza_feriale_reale, riserva_domenica_pct):
    dom_domenica_eff = dom_domenica
    riserva_factor = 1.0
    if forza_feriale_reale is not None and dom_feriali > 0:
        riserva_factor = forza_feriale_reale / dom_feriali
        dom_domenica_eff = math.ceil(dom_domenica * riserva_factor)
    elif riserva_domenica_pct is not None:
        riserva_factor = 1.0 + (riserva_domenica_pct / 100.0)
        dom_domenica_eff = math.ceil(dom_domenica * riserva_factor)
    return dom_domenica_eff, riserva_factor


def solve_single(N, K, riposi_anno_target, tol_riposi, dom_feriali, dom_domenica,
                 max_consec, forza_feriale_reale, riserva_domenica_pct,
                 balance_weekday, timeout) -> Optional[Dict[str, Any]]:
    m = cp_model.CpModel()
    x = {(w, d): m.NewBoolVar(f"x_{w}_{d}") for w in range(N) for d in range(7)}

    t_min = math.ceil((riposi_anno_target - tol_riposi) * N / 52)
    t_max = math.floor((riposi_anno_target + tol_riposi) * N / 52)
    if t_min > t_max:
        return None

    t = m.NewIntVar(t_min, t_max, "T")
    m.Add(t == sum(x.values()))

    r = [m.NewIntVar(0, N, f"r_{d}") for d in range(7)]
    for d in range(7):
        m.Add(r[d] == sum(x[w, d] for w in range(N)))

    dom_domenica_eff, riserva_factor = _domenica_effettiva(
        dom_feriali, dom_domenica, forza_feriale_reale, riserva_domenica_pct)

    demand = [dom_feriali] * 6 + [dom_domenica_eff]

    extra = [m.NewIntVar(0, K * N, f"e_{d}") for d in range(7)]
    for d in range(7):
        m.Add(K * (N - r[d]) - demand[d] == extra[d])

    if balance_weekday:
        for d in range(1, 6):
            m.Add(r[d] == r[0])

    length = N * 7
    flat = [x[w, d] for w in range(N) for d in range(7)]
    for s in range(length):
        m.Add(sum(flat[(s + k) % length] for k in range(max_consec + 1)) >= 1)

    max_extra = m.NewIntVar(0, K * N, "max_extra")
    m.AddMaxEquality(max_extra, extra)
    big = 10000
    m.Minimize(max_extra * big + sum(extra))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = timeout
    solver.parameters.num_search_workers = 8
    status = solver.Solve(m)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    pattern = [[int(solver.Value(x[w, d])) for d in range(7)] for w in range(N)]
    counts = [sum(row) for row in pattern]
    pivot = counts.index(max(counts))
    pattern = pattern[pivot:] + pattern[:pivot]

    t_val = int(solver.Value(t))
    r_vals = [int(solver.Value(r[d])) for d in range(7)]
    extra_vals = [int(solver.Value(extra[d])) for d in range(7)]
    al_lavoro = [K * (N - r_vals[d]) for d in range(7)]

    return {
        "N": N, "K": K, "T": t_val,
        "pattern": pattern,
        "riposi_anno": round(t_val * 52 / N, 3),
        "delta_riposi": round(t_val * 52 / N - riposi_anno_target, 3),
        "r_per_day": dict(zip(GIORNI, r_vals)),
        "demand": dict(zip(GIORNI, demand)),
        "al_lavoro": dict(zip(GIORNI, al_lavoro)),
        "extra": dict(zip(GIORNI, extra_vals)),
        "dom_domenica_base": dom_domenica,
        "dom_domenica_eff": dom_domenica_eff,
        "riserva_factor": round(riserva_factor, 4),
        "max_extra": max(extra_vals),
        "total_extra": sum(extra_vals),
        "tot_autisti": N * K,
        "status": "OTTIMO" if status == cp_model.OPTIMAL else "FEASIBLE",
    }


def run(data: Dict[str, Any]) -> Dict[str, Any]:
    dom_feriali = int(data.get("domanda_feriali", 51))
    dom_domenica = int(data.get("domanda_domenica", 15))
    mode = data.get("mode", "forza")
    forza = data.get("forza_feriale_reale", 66)
    pct = data.get("riserva_domenica_pct", None)
    if mode == "forza":
        forza_feriale_reale = int(forza) if forza is not None else None
        riserva_domenica_pct = None
    else:
        forza_feriale_reale = None
        riserva_domenica_pct = float(pct) if pct is not None else 0.0

    riposi_anno_target = float(data.get("riposi_anno_target", 54.0))
    tol_riposi = float(data.get("tol_riposi", 1.0))
    max_consec = int(data.get("max_consec", 6))
    balance_weekday = bool(data.get("balance_weekday", True))
    timeout = int(data.get("timeout_per_attempt", 4))
    top_n = int(data.get("top_n", 12))

    # Range con clamp difensivo per non far esplodere i tentativi.
    n_min = max(1, int(data.get("n_min", 11)))
    n_max = min(80, int(data.get("n_max", 56)))
    k_min = max(1, int(data.get("k_min", 1)))
    k_max = min(10, int(data.get("k_max", 4)))

    results: List[Dict[str, Any]] = []
    attempts = 0
    for k in range(k_min, k_max + 1):
        for n in range(n_min, n_max + 1):
            attempts += 1
            if attempts > 600:  # backstop
                break
            if k * n < dom_feriali:
                continue
            res = solve_single(
                N=n, K=k, riposi_anno_target=riposi_anno_target, tol_riposi=tol_riposi,
                dom_feriali=dom_feriali, dom_domenica=dom_domenica, max_consec=max_consec,
                forza_feriale_reale=forza_feriale_reale, riserva_domenica_pct=riserva_domenica_pct,
                balance_weekday=balance_weekday, timeout=timeout,
            )
            if res is not None:
                results.append(res)

    results.sort(key=lambda r: (
        r["max_extra"], r["total_extra"], abs(r["delta_riposi"]), r["tot_autisti"], r["N"]))

    return {"results": results[:top_n], "count": len(results), "giorni": GIORNI}


def main() -> None:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    print(json.dumps(run(data)))


if __name__ == "__main__":
    main()
