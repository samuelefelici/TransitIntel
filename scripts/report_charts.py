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

import base64
import html
import math
import os
import sys
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


def _numero(v) -> float | None:
    """Il valore se e' un numero, altrimenti niente.

    I formattatori ricevono quello che c'e' nel dossier, e il dossier cambia
    forma nel tempo: un campo che ieri era un numero puo' diventare un oggetto
    (e' successo con l'ancora del ciclo e con l'attesa delle coincidenze). Una
    cella vuota e' un difetto da correggere; una relazione che non si genera
    e' un documento che non esiste. Qui si sceglie la cella vuota."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.replace(",", "."))
        except ValueError:
            return None
    return None


def fmt_eur(v: float | None, dec: int = 0) -> str:
    n = _numero(v)
    if n is None:
        return "–"
    s = f"{n:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"€ {s}"


def fmt_n(v: float | None, dec: int = 0) -> str:
    n = _numero(v)
    if n is None:
        return "–"
    return f"{n:,.{dec}f}".replace(",", "X").replace(".", ",").replace("X", ".")


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
# ═══════════════════════════════════════════════════════════════
#  SFONDO CARTOGRAFICO
#  Un tracciato su fondo bianco non dice dove passa. Lo sfondo e' una
#  immagine statica Mapbox: se manca la chiave o la rete, le mappe restano
#  come prima — il documento non deve dipendere da un servizio esterno.
# ═══════════════════════════════════════════════════════════════

MAPBOX_STYLE = "light-v11"
SFONDO_TIMEOUT = 8
NOTA_MAPPA = "Sfondo cartografico \u00a9 Mapbox \u00a9 OpenStreetMap. Proiezione Mercatore."
_sfondi: dict = {}


def _merc_y(lat: float) -> float:
    """Mercatore sferica: e' la proiezione che usano le mappe a tasselli.

    Serve proiettare i punti ESATTAMENTE come l'immagine di sfondo, o i
    tracciati scivolano rispetto alle strade."""
    lat = max(-85.05, min(85.05, lat))
    return math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


def _merc_lat(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(math.radians(y))) - math.pi / 2)


def riquadro_mercatore(pts: Sequence[tuple], width: int, height: int, margine: float = 0.08):
    """Il riquadro da chiedere allo sfondo, gia' nella forma del disegno.

    Mapbox adatta il riquadro all'immagine mantenendo le proporzioni: se
    glielo diamo con proporzioni diverse allarga per conto suo e
    l'allineamento salta. Qui lo si allarga prima, nella proiezione giusta."""
    xs = [p[1] for p in pts]
    ys = [_merc_y(p[0]) for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    dx, dy = max(1e-9, x1 - x0), max(1e-9, y1 - y0)
    x0 -= dx * margine; x1 += dx * margine
    y0 -= dy * margine; y1 += dy * margine
    dx, dy = x1 - x0, y1 - y0
    if dx / dy > width / height:
        manca = dx * height / width - dy
        y0 -= manca / 2; y1 += manca / 2
    else:
        manca = dy * width / height - dx
        x0 -= manca / 2; x1 += manca / 2
    return x0, y0, x1, y1


def proiettore(pts: Sequence[tuple], width: int, height: int, margine: float = 0.08):
    """Da (lat, lon) a (x, y) nel disegno, in Mercatore. Restituisce anche il
    riquadro, che serve a chiedere lo sfondo della stessa area."""
    x0, y0, x1, y1 = riquadro_mercatore(pts, width, height, margine)
    sx = width / max(1e-9, x1 - x0)
    sy = height / max(1e-9, y1 - y0)

    def P(lat, lon):
        return (lon - x0) * sx, (y1 - _merc_y(lat)) * sy

    return P, (x0, y0, x1, y1)


def sfondo_mappa(riquadro, width: int, height: int) -> str:
    """L'immagine di sfondo come data URI, o stringa vuota.

    Nessuna chiave, nessuna rete, un errore qualsiasi: si torna al fondo
    piatto. Una mappa senza strade e' meno bella; un documento che non si
    genera non esiste."""
    token = os.environ.get("MAPBOX_ACCESS_TOKEN", "")
    if not token:
        return ""
    x0, y0, x1, y1 = riquadro
    chiave = (round(x0, 5), round(y0, 5), round(x1, 5), round(y1, 5), width, height)
    if chiave in _sfondi:
        return _sfondi[chiave]
    bbox = f"[{x0:.6f},{_merc_lat(y0):.6f},{x1:.6f},{_merc_lat(y1):.6f}]"
    url = (f"https://api.mapbox.com/styles/v1/mapbox/{MAPBOX_STYLE}/static/{bbox}/"
           f"{width}x{height}?access_token={token}&attribution=false&logo=false")
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=SFONDO_TIMEOUT) as r:   # noqa: S310
            if r.status != 200:
                raise OSError(f"HTTP {r.status}")
            dati = r.read()
        uri = "data:image/png;base64," + base64.b64encode(dati).decode("ascii")
    except Exception as e:                                               # noqa: BLE001
        print(f"[report] sfondo cartografico non disponibile: {type(e).__name__}: {e}", file=sys.stderr)
        uri = ""
    _sfondi[chiave] = uri
    return uri


def _strato_sfondo(riquadro, width: int, height: int) -> str:
    """Lo sfondo piu' un velo chiaro, cosi' cio' che sta sopra resta leggibile."""
    uri = sfondo_mappa(riquadro, width, height)
    if not uri:
        return f'<rect x="0" y="0" width="{width}" height="{height}" fill="{SURFACE}"/>'
    return (f'<image href="{uri}" x="0" y="0" width="{width}" height="{height}" preserveAspectRatio="none"/>'
            f'<rect x="0" y="0" width="{width}" height="{height}" fill="{SURFACE}" opacity="0.26"/>')


def _etichetta(x: float, y: float, testo: str, dim: int = 10, peso: str = "400") -> str:
    """Testo leggibile anche sopra una mappa: alone chiaro sotto le lettere."""
    if not testo:
        return ""
    t = esc(testo)
    comune = f'x="{x:.1f}" y="{y:.1f}" font-size="{dim}" font-weight="{peso}" font-family=\'{FONT}\''
    return (f'<text {comune} stroke="#ffffff" stroke-width="3" stroke-linejoin="round" opacity="0.9">{t}</text>'
            f'<text {comune} fill="{INK}">{t}</text>')


def _path_geojson(geom: dict, P) -> str:
    """Un Polygon/MultiPolygon GeoJSON come path SVG (coordinate lon, lat)."""
    if not isinstance(geom, dict):
        return ""
    anelli = []
    if geom.get("type") == "Polygon":
        anelli = geom.get("coordinates") or []
    elif geom.get("type") == "MultiPolygon":
        for poly in (geom.get("coordinates") or []):
            anelli.extend(poly)
    d = []
    for anello in anelli:
        punti = [P(float(c[1]), float(c[0])) for c in anello if len(c) >= 2]
        if len(punti) >= 3:
            d.append(" ".join(f"{'M' if k == 0 else 'L'}{x:.1f},{y:.1f}" for k, (x, y) in enumerate(punti)) + " Z")
    return " ".join(d)


def punti_di_geojson(geom: dict) -> list:
    """I vertici (lat, lon) di una geometria, per farci stare il riquadro."""
    if not isinstance(geom, dict):
        return []
    anelli = []
    if geom.get("type") == "Polygon":
        anelli = geom.get("coordinates") or []
    elif geom.get("type") == "MultiPolygon":
        for poly in (geom.get("coordinates") or []):
            anelli.extend(poly)
    return [(float(c[1]), float(c[0])) for anello in anelli for c in anello if len(c) >= 2]


def network_map(polylines: Sequence[dict], stops: Sequence[dict], title: str, subtitle: str = "",
                width: int = 900, height: int = 620, note: str = "", max_series: int = 8,
                sfondo: bool = True, isocrone: Sequence[dict] = (), etichetta_fermate: bool = False) -> str:
    """polylines: [{name, points: [(lat, lon), ...], color?}]; stops: [{name, lat, lon, node?}].

    `isocrone`: [{minuti, geom}] disegnate SOTTO i tracciati, dalla piu' larga
    alla piu' stretta: e' la copertura a piedi di quel percorso.
    `color` sulla polilinea e' il colore proprio della linea, quello con cui
    l'azienda la pubblica: se c'e', vince sulla tavolozza."""
    pts = [p for pl in polylines for p in pl.get("points", [])] + [(s_["lat"], s_["lon"]) for s_ in stops]
    for iso in isocrone:
        pts.extend(punti_di_geojson(iso.get("geom") or {}))
    if not pts:
        return ""
    P, riquadro = proiettore(pts, width, height)
    out = [f'<svg class="chart map" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
           f'role="img" aria-label="{esc(title)}">',
           _strato_sfondo(riquadro, width, height) if sfondo
           else f'<rect x="0" y="0" width="{width}" height="{height}" fill="{SURFACE}"/>']

    names, cols = [], []
    for k, iso in enumerate(sorted(isocrone, key=lambda x: -(x.get("minuti") or 0))):
        d = _path_geojson(iso.get("geom") or {}, P)
        if not d:
            continue
        col = SERIES[(k + 2) % len(SERIES)]
        out.append(f'<path d="{d}" fill="{col}" fill-opacity="0.14" stroke="{col}" stroke-width="1.2" '
                   f'stroke-dasharray="4 3" fill-rule="evenodd">'
                   f'<title>{esc(str(iso.get("minuti") or ""))} minuti a piedi</title></path>')
        names.append(f'{iso.get("minuti")}\u2032 a piedi'); cols.append(col)

    for i_, pl in enumerate(polylines):
        col = pl.get("color") or (SERIES[i_ % 8] if i_ < max_series else DEEMPH)
        if i_ < max_series or pl.get("color"):
            names.append(pl.get("name", f"linea {i_ + 1}")); cols.append(col)
        d = " ".join(f"{'M' if j_ == 0 else 'L'}{P(*p)[0]:.1f},{P(*p)[1]:.1f}"
                     for j_, p in enumerate(pl.get("points", [])))
        if d:
            # alone bianco sotto il tracciato: sopra la mappa serve a staccarlo
            out.append(f'<path d="{d}" fill="none" stroke="#ffffff" stroke-width="5.5" '
                       f'stroke-linejoin="round" stroke-linecap="round" opacity="0.75"/>')
            out.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2.8" stroke-linejoin="round" '
                       f'stroke-linecap="round"><title>{esc(pl.get("name", ""))}</title></path>')

    for s_ in stops:
        x, y = P(s_["lat"], s_["lon"])
        if s_.get("node"):
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6.5" fill="#ffffff" stroke="{INK}" stroke-width="1.5"/>'
                       f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{INK}">'
                       f'<title>{esc(s_.get("name", ""))}</title></circle>')
            out.append(_etichetta(x + 9, y + 4, s_.get("name", ""), 11, "600"))
        else:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.8" fill="#ffffff" stroke="{INK}" stroke-width="1.2">'
                       f'<title>{esc(s_.get("name", ""))}</title></circle>')
            if etichetta_fermate:
                out.append(_etichetta(x + 5, y + 3, s_.get("name", ""), 8))
    out.append("</svg>")
    if len(polylines) > max_series and not any(pl.get("color") for pl in polylines):
        names.append("altre linee"); cols.append(DEEMPH)
    tbl = _table(["Linea", "Punti del tracciato"],
                 [(pl.get("name", ""), len(pl.get("points", []))) for pl in polylines],
                 caption="Tracciati disegnati")
    return figure(title, "".join(out), subtitle=subtitle, legend=_legend(names, cols), table=tbl,
                  note=note or NOTA_MAPPA)


def alleggerisci(points: Sequence, massimo: int = 160) -> list:
    """Meno punti, stessa forma.

    Un tracciato di linea puo' avere migliaia di vertici: disegnati in una
    mappa larga 900 pixel non si distinguono, ma pesano nel documento. Si
    tiene un punto ogni N, primo e ultimo sempre."""
    pts = list(points)
    if len(pts) <= massimo:
        return pts
    passo = len(pts) / float(massimo)
    fuori = [pts[int(i * passo)] for i in range(massimo)]
    if fuori[-1] != pts[-1]:
        fuori.append(pts[-1])
    return fuori


def _contorno(punti: Sequence[tuple]) -> list:
    """Il guscio convesso di un gruppo di punti (Andrew monotone chain)."""
    p = sorted(set(punti))
    if len(p) <= 2:
        return p

    def croce(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    sotto: list = []
    for q in p:
        while len(sotto) >= 2 and croce(sotto[-2], sotto[-1], q) <= 0:
            sotto.pop()
        sotto.append(q)
    sopra: list = []
    for q in reversed(p):
        while len(sopra) >= 2 and croce(sopra[-2], sopra[-1], q) <= 0:
            sopra.pop()
        sopra.append(q)
    return sotto[:-1] + sopra[:-1]


def cluster_map(clusters: Sequence[dict], title: str, subtitle: str = "",
                width: int = 900, height: int = 640, note: str = "") -> str:
    """clusters: [{name, stops: [{name, lat, lon}]}].

    Ogni nodo e' un cerchio colorato che contiene le sue fermate, ciascuna col
    proprio nome: e' cosi' che si vede che cosa vuol dire davvero «Piazza
    Cavour» quando un turno ci cambia vettura — non un punto, un gruppo di
    banchine fra cui il conducente passa a piedi."""
    gruppi = [c for c in clusters if c.get("stops")]
    pts = [(float(s_["lat"]), float(s_["lon"])) for c in gruppi for s_ in c["stops"]]
    if not pts:
        return ""
    P, riquadro = proiettore(pts, width, height, margine=0.12)
    out = [f'<svg class="chart map" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
           f'role="img" aria-label="{esc(title)}">',
           _strato_sfondo(riquadro, width, height)]
    names, cols = [], []
    for i_, c in enumerate(gruppi):
        col = SERIES[i_ % len(SERIES)]
        names.append(f'{c["name"]} ({len(c["stops"])})'); cols.append(col)
        xy = [P(float(s_["lat"]), float(s_["lon"])) for s_ in c["stops"]]
        cx = sum(x for x, _ in xy) / len(xy)
        cy = sum(y for _, y in xy) / len(xy)
        # il cerchio contiene tutte le fermate del nodo, con un po' d'aria
        r = max(16.0, max(math.hypot(x - cx, y - cy) for x, y in xy) + 13)
        out.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{col}" fill-opacity="0.18" '
                   f'stroke="{col}" stroke-width="2"><title>{esc(c["name"])}</title></circle>')
        for (x, y), s_ in zip(xy, c["stops"]):
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3.2" fill="{col}" stroke="#ffffff" stroke-width="1">'
                       f'<title>{esc(s_.get("name", ""))}</title></circle>')
            out.append(_etichetta(x + 5, y + 3, s_.get("name", ""), 8))
        out.append(_etichetta(cx - len(c["name"]) * 3.1, cy - r - 5, c["name"], 12, "700"))
    out.append("</svg>")
    tbl = _table(["Nodo", "Fermate", "Quali"],
                 [(c["name"], len(c["stops"]), ", ".join(s_.get("name", "") for s_ in c["stops"]))
                  for c in gruppi],
                 caption="Nodi di interscambio e fermate che raggruppano")
    return figure(title, "".join(out), subtitle=subtitle, legend=_legend(names, cols), table=tbl,
                  note=note or NOTA_MAPPA)


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
