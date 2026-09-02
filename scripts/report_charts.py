#!/usr/bin/env python3
"""Grafici SVG per la relazione (solo libreria standard).

Metodo: la forma la sceglie il compito del dato (grandezza → barre, andamento →
linea, identità → serie categoriche in ordine FISSO, distribuzione → istogramma,
tempo-spazio → Gantt); il colore arriva per ultimo e viene dalla tavolozza di
riferimento validata (8 tinte categoriche in ordine fisso, sequenziale blu,
stato riservato). Segni sottili: barre ≤ 24px con estremità dati arrotondata,
linee 2px, marcatori ≥ 8px con anello di superficie, griglia a filo 1px piena,
etichette in inchiostro testo (mai nel colore della serie), legenda sempre
presente da 2 serie in su, tabella gemella per ogni grafico.
"""
from __future__ import annotations

import html
import math
from typing import Iterable, Sequence

# ── Tavolozza di riferimento (light: la relazione è un documento stampabile) ──
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
SEQ = {100: "#cde2fb", 200: "#9ec5f4", 300: "#6da7ec", 400: "#3987e5", 500: "#256abf", 600: "#184f95", 700: "#0d366b"}
STATUS = {"good": "#0ca30c", "warning": "#fab219", "serious": "#ec835a", "critical": "#d03b3b"}
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
DEEMPH = "#c3c2b7"      # serie di contesto (enfasi su una sola)
FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif'


def esc(s) -> str:
    return html.escape(str(s if s is not None else ""), quote=True)


def hm(m: float | int | None) -> str:
    if m is None:
        return "–"
    m = int(round(m))
    return f"{m // 60}:{m % 60:02d}"


def fmt_eur(v: float | None, dec: int = 0) -> str:
    if v is None:
        return "–"
    s = f"{v:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"€ {s}"


def fmt_n(v: float | None, dec: int = 0) -> str:
    if v is None:
        return "–"
    return f"{v:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _nice_step(span: float, target: int = 5) -> float:
    if span <= 0:
        return 1.0
    raw = span / target
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if raw <= m * mag:
            return m * mag
    return 10 * mag


def _rounded_bar_h(x: float, y: float, w: float, h: float, color: str, r: float = 4.0, title: str = "") -> str:
    """Barra orizzontale: base squadrata a sinistra, estremità dati arrotondata."""
    w = max(0.0, w)
    r = min(r, w / 2, h / 2)
    if w <= 0:
        return ""
    d = (f"M{x:.1f},{y:.1f} H{x + w - r:.1f} Q{x + w:.1f},{y:.1f} {x + w:.1f},{y + r:.1f} "
         f"V{y + h - r:.1f} Q{x + w:.1f},{y + h:.1f} {x + w - r:.1f},{y + h:.1f} H{x:.1f} Z")
    t = f"<title>{esc(title)}</title>" if title else ""
    return f'<path d="{d}" fill="{color}">{t}</path>'


def _rounded_col(x: float, y: float, w: float, h: float, color: str, r: float = 4.0, title: str = "") -> str:
    """Colonna: base squadrata, cima arrotondata."""
    h = max(0.0, h)
    r = min(r, w / 2, h / 2)
    if h <= 0:
        return ""
    d = (f"M{x:.1f},{y + h:.1f} V{y + r:.1f} Q{x:.1f},{y:.1f} {x + r:.1f},{y:.1f} "
         f"H{x + w - r:.1f} Q{x + w:.1f},{y:.1f} {x + w:.1f},{y + r:.1f} V{y + h:.1f} Z")
    t = f"<title>{esc(title)}</title>" if title else ""
    return f'<path d="{d}" fill="{color}">{t}</path>'


def _legend(names: Sequence[str], colors: Sequence[str]) -> str:
    if len(names) < 2:
        return ""
    items = "".join(
        f'<span class="lg"><i style="background:{c}"></i>{esc(n)}</span>' for n, c in zip(names, colors))
    return f'<div class="legend">{items}</div>'


def _table(headers: Sequence[str], rows: Iterable[Sequence], caption: str = "", numeric_from: int = 1) -> str:
    th = "".join(f"<th>{esc(h)}</th>" for h in headers)
    body = []
    for r in rows:
        cells = "".join(
            f'<td class="{"num" if i >= numeric_from else ""}">{esc(c)}</td>' for i, c in enumerate(r))
        body.append(f"<tr>{cells}</tr>")
    cap = f"<summary>{esc(caption or 'Tabella dei dati')}</summary>"
    return (f'<details class="tv">{cap}<table><thead><tr>{th}</tr></thead>'
            f'<tbody>{"".join(body)}</tbody></table></details>')


def figure(title: str, svg: str, subtitle: str = "", legend: str = "", table: str = "", note: str = "") -> str:
    sub = f'<p class="fig-sub">{esc(subtitle)}</p>' if subtitle else ""
    nt = f'<p class="fig-note">{esc(note)}</p>' if note else ""
    return (f'<figure class="viz"><figcaption><strong>{esc(title)}</strong>{sub}</figcaption>'
            f'{legend}{svg}{nt}{table}</figure>')


# ── Barre orizzontali (grandezza per categoria nominale: UNA tinta) ──
def bar_h(items: Sequence[tuple[str, float]], title: str, unit: str = "", subtitle: str = "",
          width: int = 720, label_w: int = 150, color: str = SERIES[0], fmt=None, note: str = "") -> str:
    fmt = fmt or (lambda v: fmt_n(v, 0))
    n = len(items)
    if n == 0:
        return ""
    bh, gap = 18, 8
    top, bottom = 8, 26
    height = top + n * (bh + gap) + bottom
    vmax = max((v for _, v in items), default=0) or 1
    plot_x, plot_w = label_w, width - label_w - 70
    step = _nice_step(vmax)
    out = [f'<svg class="chart" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
           f'role="img" aria-label="{esc(title)}">']
    # griglia verticale
    g = 0.0
    while g <= vmax + 1e-9:
        gx = plot_x + plot_w * g / vmax
        out.append(f'<line x1="{gx:.1f}" y1="{top}" x2="{gx:.1f}" y2="{height - bottom}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{gx:.1f}" y="{height - 8}" font-size="11" fill="{MUTED}" text-anchor="middle" font-family=\'{FONT}\'>{esc(fmt(g))}</text>')
        g += step
    for i, (name, v) in enumerate(items):
        y = top + i * (bh + gap)
        w = plot_w * v / vmax
        out.append(f'<text x="{plot_x - 8}" y="{y + bh - 4}" font-size="12" fill="{INK}" text-anchor="end" font-family=\'{FONT}\'>{esc(name)}</text>')
        out.append(_rounded_bar_h(plot_x, y, w, bh, color, title=f"{name}: {fmt(v)} {unit}".strip()))
        out.append(f'<text x="{plot_x + w + 6}" y="{y + bh - 4}" font-size="11" fill="{INK2}" font-family=\'{FONT}\'>{esc(fmt(v))}</text>')
    out.append(f'<line x1="{plot_x}" y1="{top}" x2="{plot_x}" y2="{height - bottom}" stroke="{AXIS}" stroke-width="1"/>')
    out.append("</svg>")
    tbl = _table(["Voce", unit or "Valore"], [(n_, fmt(v)) for n_, v in items], caption="Dati del grafico")
    return figure(title, "".join(out), subtitle=subtitle, table=tbl, note=note)


# ── Colonne raggruppate/impilate (serie categoriche in ordine fisso) ──
def columns(categories: Sequence[str], series: Sequence[tuple[str, Sequence[float]]], title: str,
            unit: str = "", subtitle: str = "", stacked: bool = False, width: int = 720, height: int = 300,
            fmt=None, note: str = "", colors: Sequence[str] | None = None) -> str:
    fmt = fmt or (lambda v: fmt_n(v, 0))
    colors = list(colors or SERIES)
    ncat, nser = len(categories), len(series)
    if ncat == 0 or nser == 0:
        return ""
    left, right, top, bottom = 56, 16, 12, 44
    pw, ph = width - left - right, height - top - bottom
    if stacked:
        vmax = max(sum(s[1][i] for s in series) for i in range(ncat)) or 1
    else:
        vmax = max(max(s[1]) for s in series) or 1
    step = _nice_step(vmax)
    vmax_axis = math.ceil(vmax / step) * step
    out = [f'<svg class="chart" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{esc(title)}">']
    g = 0.0
    while g <= vmax_axis + 1e-9:
        gy = top + ph - ph * g / vmax_axis
        out.append(f'<line x1="{left}" y1="{gy:.1f}" x2="{left + pw}" y2="{gy:.1f}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{left - 8}" y="{gy + 4:.1f}" font-size="11" fill="{MUTED}" text-anchor="end" font-family=\'{FONT}\'>{esc(fmt(g))}</text>')
        g += step
    band = pw / ncat
    bar_w = min(24, (band * 0.7) / (1 if stacked else nser))
    for ci, cat in enumerate(categories):
        cx = left + band * ci + band / 2
        if stacked:
            acc = 0.0
            for si, (sname, vals) in enumerate(series):
                v = vals[ci]
                h = ph * v / vmax_axis
                y = top + ph - ph * (acc + v) / vmax_axis
                # gap di superficie 2px fra i segmenti
                seg_h = max(0.0, h - (2 if si > 0 else 0))
                if seg_h > 0:
                    out.append(_rounded_col(cx - bar_w / 2, y, bar_w, seg_h, colors[si % 8],
                                            r=4 if si == nser - 1 else 0, title=f"{cat} · {sname}: {fmt(v)} {unit}".strip()))
                acc += v
            tot = sum(s[1][ci] for s in series)
            ty = top + ph - ph * tot / vmax_axis - 5
            out.append(f'<text x="{cx:.1f}" y="{ty:.1f}" font-size="11" fill="{INK2}" text-anchor="middle" font-family=\'{FONT}\'>{esc(fmt(tot))}</text>')
        else:
            gw = bar_w * nser + 2 * (nser - 1)
            for si, (sname, vals) in enumerate(series):
                v = vals[ci]
                h = ph * v / vmax_axis
                x = cx - gw / 2 + si * (bar_w + 2)
                out.append(_rounded_col(x, top + ph - h, bar_w, h, colors[si % 8], title=f"{cat} · {sname}: {fmt(v)} {unit}".strip()))
        out.append(f'<text x="{cx:.1f}" y="{height - 26}" font-size="11" fill="{INK}" text-anchor="middle" font-family=\'{FONT}\'>{esc(cat)}</text>')
    out.append(f'<line x1="{left}" y1="{top + ph}" x2="{left + pw}" y2="{top + ph}" stroke="{AXIS}" stroke-width="1"/>')
    if unit:
        out.append(f'<text x="{left}" y="{height - 8}" font-size="10" fill="{MUTED}" font-family=\'{FONT}\'>{esc(unit)}</text>')
    out.append("</svg>")
    legend = _legend([s[0] for s in series], colors)
    rows = [[cat] + [fmt(s[1][i]) for s in series] for i, cat in enumerate(categories)]
    tbl = _table(["Categoria"] + [s[0] for s in series], rows, caption="Dati del grafico")
    return figure(title, "".join(out), subtitle=subtitle, legend=legend, table=tbl, note=note)


# ── Linee (andamento nel tempo; enfasi su una serie con le altre in grigio) ──
def lines(x_labels: Sequence[str], series: Sequence[tuple[str, Sequence[float]]], title: str,
          unit: str = "", subtitle: str = "", width: int = 720, height: int = 280, emphasis: str | None = None,
          fmt=None, note: str = "", step_line: bool = False) -> str:
    fmt = fmt or (lambda v: fmt_n(v, 0))
    n = len(x_labels)
    if n == 0 or not series:
        return ""
    left, right, top, bottom = 48, 40, 12, 40
    pw, ph = width - left - right, height - top - bottom
    vmax = max(max(s[1]) for s in series) or 1
    step = _nice_step(vmax)
    vmax_axis = math.ceil(vmax / step) * step
    out = [f'<svg class="chart" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{esc(title)}">']
    g = 0.0
    while g <= vmax_axis + 1e-9:
        gy = top + ph - ph * g / vmax_axis
        out.append(f'<line x1="{left}" y1="{gy:.1f}" x2="{left + pw}" y2="{gy:.1f}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{left - 8}" y="{gy + 4:.1f}" font-size="11" fill="{MUTED}" text-anchor="end" font-family=\'{FONT}\'>{esc(fmt(g))}</text>')
        g += step
    xs = [left + pw * i / max(1, n - 1) for i in range(n)]
    every = max(1, n // 12)
    for i, lab in enumerate(x_labels):
        if i % every == 0 or i == n - 1:
            out.append(f'<text x="{xs[i]:.1f}" y="{height - 20}" font-size="11" fill="{INK}" text-anchor="middle" font-family=\'{FONT}\'>{esc(lab)}</text>')
    colors = []
    for si, (sname, vals) in enumerate(series):
        col = SERIES[si % 8] if (emphasis is None or sname == emphasis) else DEEMPH
        colors.append(col)
        pts = []
        for i, v in enumerate(vals):
            y = top + ph - ph * v / vmax_axis
            if step_line and i > 0:
                pts.append(f"{xs[i]:.1f},{top + ph - ph * vals[i - 1] / vmax_axis:.1f}")
            pts.append(f"{xs[i]:.1f},{y:.1f}")
        out.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><title>{esc(sname)}</title></polyline>')
        # marcatore finale con anello di superficie + etichetta all'estremo
        yl = top + ph - ph * vals[-1] / vmax_axis
        out.append(f'<circle cx="{xs[-1]:.1f}" cy="{yl:.1f}" r="6" fill="{SURFACE}"/><circle cx="{xs[-1]:.1f}" cy="{yl:.1f}" r="4" fill="{col}"/>')
        out.append(f'<text x="{xs[-1] + 8:.1f}" y="{yl + 4:.1f}" font-size="11" fill="{INK2}" font-family=\'{FONT}\'>{esc(fmt(vals[-1]))}</text>')
        # etichetta al massimo
        imax = max(range(len(vals)), key=lambda i: vals[i])
        ym = top + ph - ph * vals[imax] / vmax_axis
        if imax != len(vals) - 1:
            anchor = "start" if imax == 0 else "middle"
            out.append(f'<circle cx="{xs[imax]:.1f}" cy="{ym:.1f}" r="6" fill="{SURFACE}"/><circle cx="{xs[imax]:.1f}" cy="{ym:.1f}" r="4" fill="{col}"/>')
            out.append(f'<text x="{xs[imax] + (8 if imax == 0 else 0):.1f}" y="{ym - 8:.1f}" font-size="11" fill="{INK2}" text-anchor="{anchor}" font-family=\'{FONT}\'>{esc(fmt(vals[imax]))}</text>')
    out.append(f'<line x1="{left}" y1="{top + ph}" x2="{left + pw}" y2="{top + ph}" stroke="{AXIS}" stroke-width="1"/>')
    if unit:
        out.append(f'<text x="{left}" y="{height - 4}" font-size="10" fill="{MUTED}" font-family=\'{FONT}\'>{esc(unit)}</text>')
    out.append("</svg>")
    legend = _legend([s[0] for s in series], colors)
    rows = [[lab] + [fmt(s[1][i]) for s in series] for i, lab in enumerate(x_labels)]
    tbl = _table(["Ora"] + [s[0] for s in series], rows, caption="Dati del grafico")
    return figure(title, "".join(out), subtitle=subtitle, legend=legend, table=tbl, note=note)


# ── Istogramma (distribuzione di una grandezza: una tinta) ──
def histogram(values: Sequence[float], title: str, bin_min: float, bin_width: float, n_bins: int,
              subtitle: str = "", unit: str = "min", width: int = 720, height: int = 260,
              label=None, note: str = "", marker: float | None = None, marker_label: str = "") -> str:
    label = label or (lambda lo, hi: f"{fmt_n(lo)}–{fmt_n(hi)}")
    counts = [0] * n_bins
    for v in values:
        i = int((v - bin_min) // bin_width)
        if 0 <= i < n_bins:
            counts[i] += 1
        elif i >= n_bins:
            counts[-1] += 1
        else:
            counts[0] += 1
    cats = [label(bin_min + i * bin_width, bin_min + (i + 1) * bin_width) for i in range(n_bins)]
    fig = columns(cats, [("turni", counts)], title, unit="n. turni", subtitle=subtitle, width=width, height=height, note=note)
    if marker is not None and bin_width > 0:
        # linea di riferimento (es. limite normativo) disegnata come nota testuale: niente seconda scala
        fig = fig.replace("</figcaption>", f' <span class="fig-sub">Riferimento: {esc(marker_label)} = {esc(fmt_n(marker))} {esc(unit)}</span></figcaption>', 1)
    return fig


# ── Gantt tempo-spazio (turni macchina / turni guida) ──
GANTT_KIND_COLORS = {
    "trip": SERIES[0],          # corsa di linea
    "deadhead": SERIES[1],      # fuorilinea / trasferimento
    "pullout": SERIES[3],       # uscita/rientro deposito
    "layover": SEQ[200],        # sosta al capolinea
    "break": DEEMPH,            # interruzione (semiunico/spezzato)
    "car": SERIES[6],           # auto aziendale
}
GANTT_KIND_NAMES = {"trip": "corsa", "deadhead": "fuorilinea", "pullout": "deposito", "layover": "sosta", "break": "interruzione", "car": "auto aziendale"}


def gantt(rows: Sequence[dict], title: str, subtitle: str = "", width: int = 900, row_h: int = 16,
          t_min: int | None = None, t_max: int | None = None, note: str = "", label_w: int = 120,
          kinds: Sequence[str] = ("trip", "deadhead", "pullout", "layover", "break", "car")) -> str:
    """rows: [{label, sub, segments: [{start, end, kind, text}]}] (minuti dalla mezzanotte)."""
    if not rows:
        return ""
    all_s = [s for r in rows for s in r.get("segments", [])]
    if not all_s:
        return ""
    t0 = t_min if t_min is not None else (min(s["start"] for s in all_s) // 60) * 60
    t1 = t_max if t_max is not None else (max(s["end"] for s in all_s) // 60 + 1) * 60
    span = max(60, t1 - t0)
    top, bottom, gap = 22, 10, 6
    height = top + len(rows) * (row_h + gap) + bottom
    px, pw = label_w, width - label_w - 12
    out = [f'<svg class="chart" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{esc(title)}">']
    hstep = 60 if span <= 12 * 60 else 120
    t = t0
    while t <= t1:
        x = px + pw * (t - t0) / span
        out.append(f'<line x1="{x:.1f}" y1="{top - 4}" x2="{x:.1f}" y2="{height - bottom}" stroke="{GRID}" stroke-width="1"/>')
        out.append(f'<text x="{x:.1f}" y="{top - 8}" font-size="10" fill="{MUTED}" text-anchor="middle" font-family=\'{FONT}\'>{hm(t)}</text>')
        t += hstep
    for i, r in enumerate(rows):
        y = top + i * (row_h + gap)
        out.append(f'<text x="{px - 8}" y="{y + row_h - 4}" font-size="11" fill="{INK}" text-anchor="end" font-family=\'{FONT}\'>{esc(r.get("label", ""))}</text>')
        if r.get("sub"):
            out.append(f'<title>{esc(r["sub"])}</title>')
        for s in r.get("segments", []):
            x0 = px + pw * (s["start"] - t0) / span
            x1 = px + pw * (s["end"] - t0) / span
            w = max(0.0, x1 - x0 - 2)   # gap di superficie 2px fra segmenti contigui
            col = GANTT_KIND_COLORS.get(s.get("kind", "trip"), SERIES[0])
            txt = s.get("text") or f'{GANTT_KIND_NAMES.get(s.get("kind"), s.get("kind"))} {hm(s["start"])}–{hm(s["end"])}'
            if s.get("kind") == "break":
                out.append(f'<rect x="{x0:.1f}" y="{y + row_h / 2 - 1:.1f}" width="{max(0.0, x1 - x0):.1f}" height="2" fill="{col}"><title>{esc(txt)}</title></rect>')
            else:
                out.append(f'<rect x="{x0:.1f}" y="{y}" width="{w:.1f}" height="{row_h}" rx="2" fill="{col}"><title>{esc(txt)}</title></rect>')
                if s.get("label") and w > 26:
                    out.append(f'<text x="{x0 + w / 2:.1f}" y="{y + row_h - 4}" font-size="9" fill="#ffffff" text-anchor="middle" font-family=\'{FONT}\'>{esc(s["label"])}</text>')
    out.append("</svg>")
    legend = _legend([GANTT_KIND_NAMES[k] for k in kinds], [GANTT_KIND_COLORS[k] for k in kinds])
    trows = []
    for r in rows:
        for s in r.get("segments", []):
            trows.append((r.get("label", ""), GANTT_KIND_NAMES.get(s.get("kind"), s.get("kind")), hm(s["start"]), hm(s["end"]), s.get("text", "")))
    tbl = _table(["Riga", "Tipo", "Inizio", "Fine", "Dettaglio"], trows, caption="Segmenti del diagramma", numeric_from=2)
    return figure(title, "".join(out), subtitle=subtitle, legend=legend, table=tbl, note=note)


# ── Mappa di rete (proiezione equirettangolare, una tinta per linea in ordine fisso) ──
def network_map(polylines: Sequence[dict], stops: Sequence[dict], title: str, subtitle: str = "",
                width: int = 900, height: int = 620, note: str = "", max_series: int = 8) -> str:
    """polylines: [{name, points: [(lat, lon), ...]}]; stops: [{name, lat, lon, node: bool}]."""
    pts = [p for pl in polylines for p in pl.get("points", [])] + [(s["lat"], s["lon"]) for s in stops]
    if not pts:
        return ""
    lat0, lat1 = min(p[0] for p in pts), max(p[0] for p in pts)
    lon0, lon1 = min(p[1] for p in pts), max(p[1] for p in pts)
    pad = 24
    kx = math.cos(math.radians((lat0 + lat1) / 2))
    dx, dy = max(1e-6, (lon1 - lon0) * kx), max(1e-6, lat1 - lat0)
    scale = min((width - 2 * pad) / dx, (height - 2 * pad) / dy)
    def P(lat, lon):
        return pad + (lon - lon0) * kx * scale, pad + (lat1 - lat) * scale
    out = [f'<svg class="chart map" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="{esc(title)}">',
           f'<rect x="0" y="0" width="{width}" height="{height}" fill="{SURFACE}"/>']
    names, cols = [], []
    for i, pl in enumerate(polylines):
        col = SERIES[i % 8] if i < max_series else DEEMPH
        if i < max_series:
            names.append(pl.get("name", f"linea {i + 1}")); cols.append(col)
        d = " ".join(f"{'M' if j == 0 else 'L'}{P(*p)[0]:.1f},{P(*p)[1]:.1f}" for j, p in enumerate(pl.get("points", [])))
        if d:
            out.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"><title>{esc(pl.get("name", ""))}</title></path>')
    for s in stops:
        x, y = P(s["lat"], s["lon"])
        if s.get("node"):
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{SURFACE}"/><circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="{INK}"><title>{esc(s.get("name", ""))}</title></circle>')
            out.append(f'<text x="{x + 8:.1f}" y="{y + 4:.1f}" font-size="11" fill="{INK}" font-family=\'{FONT}\'>{esc(s.get("name", ""))}</text>')
        else:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.6" fill="{MUTED}"><title>{esc(s.get("name", ""))}</title></circle>')
    out.append("</svg>")
    if len(polylines) > max_series:
        names.append("altre linee"); cols.append(DEEMPH)
    legend = _legend(names, cols)
    tbl = _table(["Linea", "Punti del tracciato"], [(pl.get("name", ""), len(pl.get("points", []))) for pl in polylines], caption="Tracciati disegnati")
    return figure(title, "".join(out), subtitle=subtitle, legend=legend, table=tbl, note=note)


# ── Riquadri KPI (quando il dato è UN numero) ──
def kpi_row(tiles: Sequence[tuple[str, str, str]]) -> str:
    """tiles: [(label, value, hint)]"""
    cells = "".join(
        f'<div class="tile"><div class="tile-l">{esc(l)}</div><div class="tile-v">{esc(v)}</div>'
        f'<div class="tile-h">{esc(h)}</div></div>' for l, v, h in tiles)
    return f'<div class="kpis">{cells}</div>'


CSS = f"""
:root {{ color-scheme: light; --surface:{SURFACE}; --page:#f9f9f7; --ink:{INK}; --ink2:{INK2}; --muted:{MUTED}; --grid:{GRID}; --axis:{AXIS}; --accent:{SERIES[0]}; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:var(--page); color:var(--ink); font-family:{FONT}; font-size:14px; line-height:1.5; }}
.page {{ max-width: 980px; margin: 0 auto; padding: 32px 40px 80px; background: var(--surface); }}
h1 {{ font-size: 30px; line-height:1.15; margin: 0 0 6px; letter-spacing:-0.01em; }}
h2 {{ font-size: 21px; margin: 44px 0 10px; padding-top: 14px; border-top: 1px solid var(--grid); }}
h3 {{ font-size: 16px; margin: 26px 0 8px; }}
h4 {{ font-size: 14px; margin: 18px 0 6px; color: var(--ink2); }}
p {{ margin: 8px 0; }}
.lead {{ font-size: 16px; color: var(--ink2); }}
.meta {{ color: var(--muted); font-size: 12px; margin-bottom: 18px; }}
.banner {{ border:1px solid {STATUS['warning']}; background:#fff8e6; padding:10px 14px; border-radius:6px; margin:14px 0; font-size:13px; }}
.banner b {{ color:#7a4b00; }}
table {{ border-collapse: collapse; width: 100%; font-size: 12.5px; margin: 8px 0 14px; }}
th, td {{ padding: 5px 8px; border-bottom: 1px solid var(--grid); text-align: left; vertical-align: top; }}
th {{ color: var(--ink2); font-weight: 600; background: #f3f2ee; }}
td.num, th.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
tr.total td {{ font-weight: 600; border-top: 1px solid var(--axis); }}
.kpis {{ display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:10px; margin: 14px 0 6px; }}
.tile {{ border:1px solid var(--grid); border-radius:8px; padding:10px 12px; background:#fff; }}
.tile-l {{ font-size:12px; color:var(--ink2); }}
.tile-v {{ font-size:26px; font-weight:600; margin:2px 0; }}
.tile-h {{ font-size:11px; color:var(--muted); }}
figure.viz {{ margin: 18px 0 22px; padding: 12px 12px 6px; border: 1px solid var(--grid); border-radius: 8px; background: var(--surface); page-break-inside: avoid; }}
figure.viz figcaption {{ margin-bottom: 6px; }}
.fig-sub {{ margin: 2px 0 0; font-size: 12px; color: var(--ink2); }}
.fig-note {{ margin: 4px 0 0; font-size: 11.5px; color: var(--muted); }}
.chart {{ max-width: 100%; height: auto; display:block; }}
.legend {{ display:flex; flex-wrap:wrap; gap: 6px 16px; font-size: 12px; color: var(--ink2); margin: 4px 0 8px; }}
.legend i {{ display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }}
details.tv {{ margin-top: 4px; font-size: 12px; }}
details.tv summary {{ cursor: pointer; color: var(--muted); }}
details.tv table {{ margin-top: 6px; }}
.formula {{ font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif; font-size: 15px; padding: 8px 14px; margin: 8px 0; background: #f7f7f4; border-left: 3px solid var(--axis); overflow-x:auto; }}
.formula .w {{ font-family:{FONT}; font-size:12.5px; color:var(--ink2); display:block; margin-top:4px; }}
.callout {{ border-left: 3px solid var(--accent); padding: 6px 12px; margin: 10px 0; background: #f3f7fc; }}
.timeline {{ list-style:none; padding:0; margin: 8px 0; }}
.timeline li {{ padding: 6px 0 6px 18px; border-left: 2px solid var(--grid); position:relative; }}
.timeline li::before {{ content:""; position:absolute; left:-6px; top:12px; width:10px; height:10px; border-radius:50%; background:var(--accent); border:2px solid var(--surface); }}
.timeline .t {{ color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }}
.toc {{ columns: 2; font-size: 13px; }}
.toc a {{ color: var(--ink); text-decoration: none; }}
.grid2 {{ display:grid; grid-template-columns: 1fr 1fr; gap: 14px; }}
.small {{ font-size: 12px; color: var(--ink2); }}
.ok {{ color: #006300; }}
.warn {{ color: #7a4b00; }}
.bad {{ color: {STATUS['critical']}; }}
@media print {{
  body {{ background: #fff; }}
  .page {{ max-width: none; padding: 0; }}
  h2 {{ page-break-before: always; border-top: none; }}
  h2.first {{ page-break-before: auto; }}
  details.tv {{ display: none; }}
  figure.viz {{ border: none; }}
}}
"""
