"""crew_assorbimento.py — Fase di ASSORBIMENTO dei turni guida.

Dopo l'ottimizzazione CP-SAT i turni guida sono già a norma, ma il modello
lavora su pochi tagli per turno macchina (quelli che sopravvivono al
collasso a 45′ e alla segmentazione scelta) e lascia spesso turni corti:
pezzi di un'ora a mezzogiorno, supplementi, interi da tre ore. Questa fase
li prova a far ASSORBIRE dagli altri turni.

Come lavora
-----------
1. ATOMI. Ogni pezzo della soluzione viene ritagliato in tutti i punti in
   cui l'autista può scendere fra una corsa e l'altra: un nodo di cambio
   (cluster) dove il bus arriva e riparte, oppure un rientro in deposito.
   Un atomo è un tratto di un solo bus fra due di questi punti. I tagli
   intra-corsa già scelti dal solver restano confini.
2. TURNI = ATOMI. Un turno è un elenco di atomi: atomi consecutivi dello
   stesso bus si saldano in un pezzo (il conducente resta sul mezzo), e un
   turno ha al massimo due pezzi, come nel modello CP-SAT.
3. RICERCA LOCALE (ricottura simulata, a tempo). Tre mosse:
   - SPOSTA: uno a tre atomi consecutivi passano da un turno a un altro;
   - SCAMBIA LE CODE: due turni si tagliano allo stesso istante e si
     scambiano il resto della giornata;
   - ELIMINA: uno dei turni più corti sparisce e ogni suo pezzo va, intero
     o diviso in due, al turno a cui costa meno.
   Un turno che resta senza atomi sparisce: è l'assorbimento.
4. STESSE REGOLE DEL SOLVER, nessuna copia: ogni turno nuovo si costruisce
   come in _extract_duties_from_solution (single_nastro_work,
   _feasible_pair, pair_nastro_work, classify_duty) e passa da
   validate_duty_bds; il costo è compute_duty_cost_v4 più il peso per
   turno di _score_solution. Un turno nuovo con violazioni non entra. Le
   auto aziendali si simulano a ogni mossa accettata con il pool di Cerbero
   (car_trips_of_duties + _simulate_car_pool): mai oltre il tetto, mai un
   ritiro senza auto in più. I tetti percentuali (semiunici, spezzati)
   scendono con il numero dei turni: nella ricerca sono una penalità forte,
   rigidi all'accettazione.
5. ACCETTAZIONE. La soluzione nuova sostituisce quella del solver solo se:
   lo score di _score_solution scende, le violazioni normative non
   aumentano, i tetti percentuali e i vincoli globali non peggiorano, il
   picco di auto resta entro il tetto e i trasferimenti senza auto non
   aumentano (compute_car_pool, come in _concludi). Se la migliore non
   passa si prova la precedente migliore; altrimenti resta la soluzione del
   solver: la fase non può peggiorare un risultato.

Gli orari non si toccano: la fase ricompone i turni guida sugli stessi turni
macchina. Gli spostamenti di orario restano alla sonda (vcsp_probe.py).

Per leggere il codice: assorbi() in fondo, poi _Assorbitore.valuta() (un
turno) e _Assorbitore.cerca() (la ricerca).
"""
from __future__ import annotations

import math
import random
import time
from collections import Counter
from typing import Any

# ── Parametri ────────────────────────────────────────────────────────────────
# Tempo: una quota del tempo del calcolo, con un massimo. Si sottrae
# all'ottimizzazione, quindi il tempo totale non cambia; sotto il minimo
# (calcoli brevi, di prova) la fase non parte.
QUOTA_DEL_TEMPO = 0.2
SECONDI_MIN = 1.0
SECONDI_MAX = 60.0
# La ricerca si ferma prima se per tante mosse di fila non migliora
MOSSE_SENZA_MIGLIORAMENTO = 400_000
# Soluzioni migliori tenute da parte: se la migliore non passa i controlli
# finali (es. un trasferimento resta senza auto) si prova la precedente
MAX_CANDIDATI = 30
# Mossa SPOSTA: quanti atomi consecutivi al massimo
MAX_ATOMI_PER_MOSSA = 3
# Spinta a svuotare i turni corti: un piccolo premio sul quadrato del lavoro
# (a parità di ore pagate preferisce turni pieni e turni vuoti a turni medi).
# Vale solo DENTRO la ricerca: l'accettazione usa lo score del solver.
SPINTA_QUADRATI = 0.27
# Un intero senza la sosta di 15′ al capolinea costa (solo nella ricerca)
# questa frazione di un turno: la sosta si cerca, come nel solver.
PESO_SOSTA_15 = 0.13
# Il NUMERO dei turni deve dominare le differenze di costo orario (come nel
# CP-SAT, che pesa ogni turno con WEIGHT_DUTY_COUNT): nella ricerca ogni turno
# costa questo multiplo del peso di un turno in più dello score.
PESO_TURNO_RICERCA = 2.0
# Un turno oltre i tetti percentuali, nella ricerca, costa come due turni
PESO_SFORO_TETTI = 2.0
# Mossa ELIMINA (un turno corto distribuito sugli altri): quanto spesso, e
# fra quanti dei turni più corti si sceglie
P_ELIMINA = 0.01
CANDIDATI_ELIMINA = 6
# Temperatura iniziale della ricottura, in frazione del peso di un turno
TEMPERATURA = 0.5
SEME = 7
EPS = 0.01


def secondi_della_fase(config: dict, rimasto: float) -> float:
    """Secondi riservati alla fase (0 = spenta). config["assorbimento"]:
    {"attivo": bool (default vero), "secondi": numero}. Mai più di metà del
    tempo che resta, perché il CP-SAT deve comunque trovare una soluzione."""
    cfg = (config or {}).get("assorbimento") or {}
    if cfg.get("attivo") is False:
        return 0.0
    if cfg.get("secondi") is not None:
        try:
            sec = float(cfg["secondi"])
        except (TypeError, ValueError):
            sec = 0.0
    else:
        sec = min(SECONDI_MAX, QUOTA_DEL_TEMPO * rimasto)
    sec = max(0.0, min(sec, rimasto / 2.0))
    return sec if sec >= SECONDI_MIN else 0.0


def turno_da_segmenti(v4: Any, segs: list, rules: dict, bds: Any, clusters: list) -> Any:
    """Un turno guida da 1 o 2 pezzi, costruito ESATTAMENTE come in
    _extract_duties_from_solution (stesse funzioni, stessi campi), poi
    riclassificato con classify_duty. None se i due pezzi non fanno coppia."""
    cl = clusters
    if len(segs) == 1:
        s = segs[0]
        t = v4.seg_transfer_out(s, cl)
        tb = v4.seg_transfer_back(s, cl)
        pt = v4.pre_turno_for(t)
        nastro, work = v4.single_nastro_work(s, bds, cl)
        dtype = "supplemento" if nastro <= v4.SUPPLEMENTO_NASTRO_MAX else "intero"
        d = v4.DriverDutyV3(idx=0, driver_id="ASS", duty_type=dtype, segments=[s],
                            nastro_start=s.start_min - pt - t, nastro_end=s.end_min + tb,
                            nastro_min=nastro, work_min=work, driving_min=s.driving_min,
                            interruption_min=0, pre_turno_min=pt, transfer_min=t, transfer_back_min=tb)
    elif len(segs) == 2:
        s1, s2 = segs
        if s1.start_min > s2.start_min:
            s1, s2 = s2, s1
        if s2.start_min < s1.end_min:
            return None
        ptype = v4._feasible_pair(s1, s2, rules, cl)
        if ptype is None:
            return None
        t = v4.seg_transfer_out(s1, cl)
        tb = v4.seg_transfer_back(s2, cl)
        pt = v4.pre_turno_for(t)
        nastro, work = v4.pair_nastro_work(s1, s2, bds, cl, ptype)
        d = v4.DriverDutyV3(idx=0, driver_id="ASS", duty_type=ptype, segments=[s1, s2],
                            nastro_start=s1.start_min - pt - t, nastro_end=s2.end_min + tb,
                            nastro_min=nastro, work_min=work, driving_min=s1.driving_min + s2.driving_min,
                            interruption_min=s2.start_min - s1.end_min, pre_turno_min=pt,
                            transfer_min=t, transfer_back_min=tb)
    else:
        return None
    d.duty_type = v4.classify_duty(d, bds, cl)
    return d


class _Atomo:
    __slots__ = ("id", "veh", "vtype", "trips", "seg", "pos")

    def __init__(self, id_: int, veh: str, vtype: str, trips: list, seg: Any, pos: int):
        self.id = id_
        self.veh = veh
        self.vtype = vtype
        self.trips = trips
        self.seg = seg      # Segment della soluzione da cui viene
        self.pos = pos      # posizione nel bus (0, 1, 2… in ordine di tempo)


class _Assorbitore:
    def __init__(self, v4: Any, duties: list, blocks: list, config: dict, clusters: list, bds: Any):
        self.v4 = v4
        import crew_scheduler_v3 as v3
        self.v3 = v3
        self.clusters = clusters
        self.bds = bds
        self.rules = config.get("shiftRules", v4.SHIFT_RULES)
        self.rates = v4.CostRates.from_config(config)
        self.peso_turno = max(v4.SCORE_PER_DUTY, self.rates.hourly_rate * (self.rates.target_work_min / 60.0))
        self.costo_minuto = self.rates.hourly_rate / 60.0
        self.target = max(60, int(self.rates.target_work_min or 390))
        self.blocks = {b.vehicle_id: b for b in blocks}
        self.min_pezzo = {"urbano": int(getattr(v4, "BDS5_LUNG_PEZZI_MIN", 0) or 0),
                          "extraurbano": int(getattr(v4, "BDS5_LUNG_PEZZI_MIN_EXTRA", 0) or 0)}
        self.atomi: list[_Atomo] = []
        self.saldabile: dict[tuple[str, int], bool] = {}   # (bus, pos) → l'atomo pos si salda col pos+1
        self.memo: dict[tuple, Any] = {}
        self.memo_seg: dict[tuple, Any] = {}
        self.originali: dict[tuple, Any] = {}
        self._costruisci_atomi(duties)

    # ── atomi ────────────────────────────────────────────────────────────────
    def _punto_di_cambio(self, block: Any, a: Any, b: Any) -> bool:
        """Fra le corse a e b (consecutive nel bus) il conducente può scendere?"""
        v4 = self.v4
        if b.departure_min < a.arrival_min:
            return False
        if v4._bds5_in_fascia_senza_cambi(a.arrival_min):
            return False
        if block is not None:
            leg = v4.block_leg_between(block, a, b)
            if leg is not None and leg.type == "depot":
                return True
        ca = v4.match_cluster(a.last_stop_name, self.clusters)
        return bool(ca) and ca == v4.match_cluster(b.first_stop_name, self.clusters)

    def _costruisci_atomi(self, duties: list) -> None:
        per_bus: dict[str, list[tuple[Any, list]]] = {}
        for d in duties:
            for s in d.segments:
                block = self.blocks.get(s.vehicle_id)
                tr = list(s.trips)
                pezzi, start = [], 0
                for k in range(1, len(tr)):
                    if self._punto_di_cambio(block, tr[k - 1], tr[k]):
                        pezzi.append(tr[start:k])
                        start = k
                pezzi.append(tr[start:])
                per_bus.setdefault(s.vehicle_id, []).extend((s, p) for p in pezzi if p)
        for veh, lista in per_bus.items():
            lista.sort(key=lambda x: (x[1][0].departure_min, x[1][-1].arrival_min))
            block = self.blocks.get(veh)
            for pos, (seg, trips) in enumerate(lista):
                self.atomi.append(_Atomo(len(self.atomi), veh, seg.vehicle_type, trips, seg, pos))
            for pos in range(len(lista) - 1):
                (s1, t1), (s2, t2) = lista[pos], lista[pos + 1]
                if s1 is s2:
                    ok = True     # taglio fatto qui: dentro lo stesso pezzo del solver
                else:
                    ok = (self._corse_intere_consecutive(block, t1[-1], t2[0])
                          or self._meta_della_stessa_corsa(block, t1[-1], t2[0]) is not None)
                self.saldabile[(veh, pos)] = ok
        # turni originali come elenchi di atomi
        da_seg: dict[int, list[int]] = {}
        for a in self.atomi:
            da_seg.setdefault(id(a.seg), []).append(a.id)
        self.iniziale: list[list[int]] = []
        for d in duties:
            ids = [i for s in d.segments for i in da_seg.get(id(s), [])]
            ids.sort(key=self._chiave_tempo)
            self.iniziale.append(ids)
            self.originali[tuple(ids)] = d

    def _corse_intere_consecutive(self, block: Any, a: Any, b: Any) -> bool:
        """Due pezzi diversi del solver si saldano solo se il confine è fra due
        corse INTERE consecutive del bus (non a metà di un taglio intra-corsa)
        e il bus non rientra in deposito fra le due: dopo un rientro il pezzo
        nuovo riparte dal deposito, è un altro pezzo."""
        if block is None:
            return False
        ia = self.v4.block_trip_index(block, a, edge="both")
        ib = self.v4.block_trip_index(block, b, edge="both")
        if ia < 0 or ib != ia + 1:
            return False
        leg = self.v4.block_leg_between(block, a, b)
        return not (leg is not None and leg.type == "depot")

    def _meta_della_stessa_corsa(self, block: Any, a: Any, b: Any) -> Any:
        """Se a e b sono le due metà di un taglio intra-corsa (stessa corsa del
        bus, a finisce alla fermata intermedia dove parte b) ritorna la corsa
        intera del bus: riunite, il conducente fa la corsa tutta."""
        if block is None or a.trip_id != b.trip_id:
            return None
        k = self.v4.block_trip_index(block, a, edge="start")
        if k < 0 or self.v4.block_trip_index(block, b, edge="end") != k:
            return None
        intera = block.trips[k]
        if a.arrival_min == intera.arrival_min or b.departure_min == intera.departure_min:
            return None
        return intera

    def _chiave_tempo(self, i: int) -> tuple:
        a = self.atomi[i]
        return (a.trips[0].departure_min, a.trips[-1].arrival_min, a.veh)

    # ── un turno ─────────────────────────────────────────────────────────────
    def _pezzi(self, ids: tuple) -> list[list[_Atomo]] | None:
        pezzi: list[list[_Atomo]] = []
        for i in ids:
            a = self.atomi[i]
            if pezzi:
                p = pezzi[-1][-1]
                if p.veh == a.veh and a.pos == p.pos + 1 and self.saldabile.get((p.veh, p.pos)):
                    pezzi[-1].append(a)
                    continue
            pezzi.append([a])
            if len(pezzi) > 2:
                return None
        return pezzi

    def _segmento(self, pezzo: list[_Atomo]) -> Any:
        """Il Segment del solver per un pezzo: quello originale se il pezzo è
        esattamente un pezzo del solver, altrimenti costruito con _make_segment
        (stesse regole di presa al capolinea, uscita e rientro dal deposito)."""
        key = (pezzo[0].veh, pezzo[0].pos, pezzo[-1].pos)
        seg = self.memo_seg.get(key)
        if seg is not None:
            return seg
        block = self.blocks.get(pezzo[0].veh)
        trips: list = []
        for a in pezzo:
            for t in a.trips:
                intera = self._meta_della_stessa_corsa(block, trips[-1], t) if trips else None
                if intera is not None:
                    trips[-1] = intera
                else:
                    trips.append(t)
        orig = pezzo[0].seg
        if all(a.seg is orig for a in pezzo) and len(trips) == len(orig.trips):
            seg = orig
        else:
            if block is not None and len(trips) == len(block.trips):
                half = "full"
            elif block is not None and self.v4.block_trip_index(block, trips[0], edge="start") == 0:
                half = "first"
            elif block is not None and self.v4.block_trip_index(block, trips[-1], edge="end") == len(block.trips) - 1:
                half = "second"
            else:
                half = "middle"
            seg = self.v4._make_segment(pezzo[0].veh, pezzo[0].vtype, trips, half, None, self.clusters, block=block)
        self.memo_seg[key] = seg
        return seg

    def valuta(self, ids: tuple) -> Any:
        """(turno, score del solver, valore nella ricerca, viaggi in auto) oppure None."""
        if ids in self.memo:
            return self.memo[ids]
        res = self._valuta(ids)
        self.memo[ids] = res
        return res

    def _valuta(self, ids: tuple) -> Any:
        v4 = self.v4
        bds, cl = self.bds, self.clusters
        originale = self.originali.get(ids)
        if originale is not None:
            # Un turno del solver resta il turno del solver, numeri compresi
            d = originale
        else:
            pezzi = self._pezzi(ids)
            if not pezzi:
                return None
            segs = [self._segmento(p) for p in pezzi]
            for s in segs:
                mp = self.min_pezzo.get(getattr(self.blocks.get(s.vehicle_id), "category", "urbano"), 0)
                if mp and s.work_min < mp:
                    return None
            d = turno_da_segmenti(v4, segs, self.rules, bds, cl)
            if d is None or d.duty_type == "invalido":
                return None
        val = v4.validate_duty_bds(d, bds, cl)
        if val.violations and originale is None:
            return None
        # I viaggi in auto aziendale di questo turno, con le regole del pool
        # (crew_scheduler_v3.car_trips_of_duties), e i loro orari di partenza:
        # la simulazione li sposta quando chi smonta aspetta l'auto.
        auto = [(ct, (ct.depart_min, ct.arrive_min)) for ct in self.v3.car_trips_of_duties([d], cl, None, True)]
        score = v4.compute_duty_cost_v4(d, self.rates, bds, cl).total + 50.0 * len(val.violations)
        if d.duty_type == "invalido":
            score += 500.0
        score += self.peso_turno * v4.WEIGHT_FACTORS["duty"]
        if d.duty_type in ("semiunico", "spezzato"):
            score += self.peso_turno * 0.5 * (v4.WEIGHT_FACTORS["spezz"] - 1.0)
        ricerca = score - SPINTA_QUADRATI * self.costo_minuto * d.work_min ** 2 / (2.0 * self.target)
        if d.duty_type == "intero" and not getattr(val, "sosta_capolinea_ok", True):
            ricerca += PESO_SOSTA_15 * self.peso_turno
        return (d, score, ricerca, auto)

    # ── soluzione intera ─────────────────────────────────────────────────────
    def auto(self, valutati: list) -> tuple[int, int]:
        """(auto fuori deposito nello stesso momento, ritiri senza auto al nodo)
        con la simulazione del pool di Cerbero, senza tetto."""
        trips = [ct for v in valutati for ct, _ in v[3]]
        orig = [o for v in valutati for _, o in v[3]]
        ris = self.v3._simulate_car_pool(trips, None, orig)
        return ris["peak"], len(ris["unpaired"])

    def sforo_tetti(self, valutati: list) -> int:
        """Turni oltre i tetti percentuali (semiunici, spezzati), con la stessa
        regola di pct_caps_status: floor(pct·N/100 + tolleranza)."""
        tipi = Counter(v[0].duty_type for v in valutati)
        totale = sum(n for k, n in tipi.items() if k != "supplemento")
        sforo = 0
        for kind in ("semiunico", "spezzato"):
            r = self.v4.SHIFT_RULES.get(kind, {})
            mx = r.get("maxPct") if isinstance(r, dict) else None
            allowed = self.v4.pct_cap_allowed(mx, totale)
            if allowed is not None:
                sforo += max(0, tipi.get(kind, 0) - allowed)
        return sforo

    def _ordina(self, ids: list[int]) -> list[int]:
        return sorted(ids, key=self._chiave_tempo)

    def elimina(self, sol: list[list[int]], val: list, a: int) -> tuple[list, list] | None:
        """Mossa ELIMINA: il turno a sparisce e i suoi pezzi vanno ad altri
        turni, ognuno intero in un turno o diviso in due (la testa a chi finisce
        lì, la coda a chi comincia lì). Per ogni pezzo sceglie la sistemazione
        che costa meno; se un pezzo non trova posto la mossa non si fa."""
        pezzi = self._pezzi(tuple(sol[a]))
        if not pezzi:
            return None
        cur = {k: (list(d), val[k]) for k, d in enumerate(sol) if k != a}

        def prova(k: int, ids: list[int]) -> tuple[float, list, Any] | None:
            d = self._ordina(cur[k][0] + ids)
            v = self.valuta(tuple(d))
            return None if v is None else (v[2] - cur[k][1][2], d, v)

        for p in pezzi:
            ids = [x.id for x in p]
            scelta = None   # (delta, [(k, d, v), ...])
            for k in cur:
                r = prova(k, ids)
                if r and (scelta is None or r[0] < scelta[0]):
                    scelta = (r[0], [(k, r[1], r[2])])
            for m in range(1, len(ids)):
                testa = [(k, r) for k in cur if (r := prova(k, ids[:m]))]
                coda = [(k, r) for k in cur if (r := prova(k, ids[m:]))]
                if not testa or not coda:
                    continue
                testa.sort(key=lambda x: x[1][0])
                coda.sort(key=lambda x: x[1][0])
                for kt, rt in testa[:3]:
                    kc, rc = next(((kc, rc) for kc, rc in coda if kc != kt), (None, None))
                    if kc is None:
                        continue
                    if scelta is None or rt[0] + rc[0] < scelta[0]:
                        scelta = (rt[0] + rc[0], [(kt, rt[1], rt[2]), (kc, rc[1], rc[2])])
            if scelta is None:
                return None
            for k, d, v in scelta[1]:
                cur[k] = (d, v)
        return [d for d, _ in cur.values()], [v for _, v in cur.values()]

    def cerca(self, scadenza: float, stop: Any = None, seme: int = SEME,
              max_iterazioni: int | None = None) -> tuple[list[list[list[int]]], dict]:
        """Ricottura simulata. Ritorna le soluzioni migliori trovate (la
        migliore per prima) come elenchi di atomi, e le statistiche."""
        rng = random.Random(seme)
        sol = [list(d) for d in self.iniziale]
        val = [self.valuta(tuple(d)) for d in sol]
        if any(v is None for v in val):
            return [], {"motivo": "soluzione del solver non ricostruibile"}
        # Auto aziendali: mai oltre il tetto (o oltre il picco di partenza, se
        # era già sopra) e mai più ritiri senza auto di quanti ce n'erano.
        tetto_auto = int(getattr(self.v4, "MAX_COMPANY_CARS", 0) or 0)
        picco0, senza0 = self.auto(val)
        limite_auto = max(tetto_auto, picco0) if tetto_auto > 0 else None

        def auto_ok(vs: list) -> bool:
            picco, senza = self.auto(vs)
            return senza <= senza0 and (limite_auto is None or picco <= limite_auto)
        # I tetti percentuali scendono insieme al numero dei turni (a 35 turni
        # 5 semiunici, a 34 solo 4): rigidi a ogni mossa, la ricerca non
        # potrebbe mai togliere un turno. Qui pesano più di un turno intero;
        # rigidi lo sono all'accettazione finale (validate_all_bds).
        peso_sforo = PESO_SFORO_TETTI * self.peso_turno

        peso_n = PESO_TURNO_RICERCA * self.peso_turno

        def costo_ricerca(vs: list) -> float:
            return sum(v[2] for v in vs) + peso_n * len(vs) + peso_sforo * self.sforo_tetti(vs)

        cur = costo_ricerca(val)
        best = (cur, [list(d) for d in sol])
        storia: list[list[list[int]]] = []   # i migliori via via, per l'accettazione finale
        t0 = time.monotonic()
        durata = max(0.001, scadenza - t0)
        T0 = TEMPERATURA * self.peso_turno
        it = acc = it_best = 0
        while True:
            if max_iterazioni is not None and it >= max_iterazioni:
                break
            if it - it_best > MOSSE_SENZA_MIGLIORAMENTO:
                break
            if (it & 63) == 0:
                if time.monotonic() >= scadenza or (stop is not None and stop.is_set()):
                    break
            it += 1
            if max_iterazioni is not None:
                frac = min(1.0, it / max_iterazioni)
            else:
                frac = min(1.0, (time.monotonic() - t0) / durata)
            temp = T0 * (1.0 - frac) + 1e-6
            n = len(sol)
            if n < 2:
                break
            if rng.random() < P_ELIMINA:
                # uno dei turni più corti prova a sparire
                corti = sorted(range(n), key=lambda k: val[k][0].work_min)[:CANDIDATI_ELIMINA]
                ris = self.elimina(sol, val, rng.choice(corti))
                if ris is None:
                    continue
                nuovo, nval = ris
                nc = costo_ricerca(nval)
                if nc > cur and rng.random() >= math.exp((cur - nc) / temp):
                    continue
                if not auto_ok(nval):
                    continue
                sol, val, cur = nuovo, nval, nc
                acc += 1
                if cur < best[0] - EPS:
                    best = (cur, [list(d) for d in sol])
                    storia.append(best[1])
                    it_best = it
                continue
            a = rng.randrange(n)
            b = rng.randrange(n)
            if a == b:
                continue
            A, B = sol[a], sol[b]
            if rng.random() < 0.5:
                i = rng.randrange(len(A))
                j = rng.randrange(i, min(len(A), i + MAX_ATOMI_PER_MOSSA))
                nA = A[:i] + A[j + 1:]
                nB = self._ordina(B + A[i:j + 1])
            else:
                i = rng.randrange(len(A) + 1)
                if i < len(A):
                    tcut = self.atomi[A[i]].trips[0].departure_min
                else:
                    tcut = self.atomi[A[-1]].trips[-1].arrival_min + 1
                j = 0
                while j < len(B) and self.atomi[B[j]].trips[0].departure_min < tcut:
                    j += 1
                nA = A[:i] + B[j:]
                nB = B[:j] + A[i:]
            vA = self.valuta(tuple(nA)) if nA else None
            vB = self.valuta(tuple(nB)) if nB else None
            if (nA and vA is None) or (nB and vB is None):
                continue
            nuovo = [d for k, d in enumerate(sol) if k not in (a, b)] + [d for d in (nA, nB) if d]
            nval = [v for k, v in enumerate(val) if k not in (a, b)] + [v for v in (vA, vB) if v]
            nc = costo_ricerca(nval)
            if nc > cur and rng.random() >= math.exp((cur - nc) / temp):
                continue
            if not auto_ok(nval):
                continue
            sol, val, cur = nuovo, nval, nc
            acc += 1
            if cur < best[0] - EPS:
                best = (cur, [list(d) for d in sol])
                storia.append(best[1])
                it_best = it
        # dal migliore indietro: l'accettazione finale prende il primo che passa tutto
        candidati = list(reversed(storia[-MAX_CANDIDATI:]))
        return candidati, {"iterazioni": it, "mosseAccettate": acc, "limiteAuto": limite_auto}


def assorbi(duties: list, blocks: list, config: dict, clusters: list, bds: Any,
            scadenza: float, stop: Any = None, seme: int = SEME,
            max_iterazioni: int | None = None) -> tuple[list, dict]:
    """Entry point. Ritorna (turni, resoconto). I turni sono quelli del solver
    se la fase non trova niente di meglio o se una regola peggiorerebbe."""
    import crew_scheduler_v4 as v4

    t_start = time.monotonic()
    info: dict[str, Any] = {"attiva": True, "turniPrima": len(duties)}
    if not duties or scadenza - t_start < 1.0:
        info.update(turniDopo=len(duties), accettata=False, motivo="tempo insufficiente")
        return duties, info
    ass = _Assorbitore(v4, duties, blocks, config, clusters, bds)
    info["atomi"] = len(ass.atomi)
    candidati_ids, stats = ass.cerca(scadenza, stop, seme, max_iterazioni)
    info.update(stats)
    score_prima = v4._score_solution(duties, ass.rates, bds, clusters)
    info.update(scorePrima=round(score_prima, 1))
    prima = _controlli(v4, duties, bds, clusters)
    motivi: list[str] = []
    scelta = None
    for k, ids in enumerate(candidati_ids):
        nuovi = [ass.valuta(tuple(d)) for d in ids]
        if not all(nuovi):
            continue
        cand = [v[0] for v in nuovi]
        score = v4._score_solution(cand, ass.rates, bds, clusters)
        if score >= score_prima - EPS:
            motivi.append("nessun miglioramento")
            continue
        motivo = _peggiora(_controlli(v4, cand, bds, clusters), prima)
        if motivo:
            motivi.append(motivo)
            continue
        scelta = (k, cand, score)
        break
    info.update(secondi=round(time.monotonic() - t_start, 1), candidatiProvati=len(motivi) + (1 if scelta else 0),
                autoPrima=prima["auto"], conflittiAutoPrima=prima["conflittiAuto"])
    if scelta is None:
        motivo = motivi[0] if motivi else "nessun miglioramento"
        info.update(turniDopo=len(duties), accettata=False, motivo=motivo, scoreDopo=None)
        v4.log(f"[ASSORBIMENTO] nessun cambio: {motivo} ({info.get('iterazioni', 0)} mosse provate)")
        return duties, info
    k, candidati, score_dopo = scelta
    dopo = _controlli(v4, candidati, bds, clusters)
    info.update(scoreDopo=round(score_dopo, 1), autoDopo=dopo["auto"], conflittiAutoDopo=dopo["conflittiAuto"],
                tettoAuto=int(getattr(v4, "MAX_COMPANY_CARS", 0) or 0), candidatoScelto=k)

    tipi_prima = Counter(d.duty_type for d in duties)
    tipi_dopo = Counter(d.duty_type for d in candidati)
    candidati.sort(key=lambda d: (d.nastro_start, d.nastro_end))
    for k, d in enumerate(candidati):
        d.idx = k
        d.driver_id = f"{v4.DUTY_CODE_PREFIX}{k + 1:03d}"
    info.update(turniDopo=len(candidati), accettata=True, motivo=None,
                tipiPrima=dict(tipi_prima), tipiDopo=dict(tipi_dopo))
    v4.log(f"[ASSORBIMENTO] {len(duties)} → {len(candidati)} turni "
           f"(score {score_prima:.0f} → {score_dopo:.0f}, {info.get('iterazioni', 0)} mosse, "
           f"{info['secondi']}s, {len(ass.atomi)} atomi)")
    return candidati, info


def _controlli(v4: Any, duties: list, bds: Any, clusters: list) -> dict:
    """Quello che la soluzione deve rispettare, contato come in _concludi."""
    val = v4.validate_all_bds(duties, bds, clusters)
    vg = v4.evaluate_vincoli_globali(duties) or []
    tetto = int(getattr(v4, "MAX_COMPANY_CARS", 0) or 0)
    if tetto > 0:
        import crew_scheduler_v3 as v3
        v3.COMPANY_CARS = tetto          # come _concludi: il pool col tetto dell'operatore
    pool = v4.compute_car_pool(duties, clusters)
    return {"violazioni": val["totalViolations"], "globali": len(val["globalViolations"]),
            "vincoli": sum(1 for r in vg if not r.get("soddisfatto", True)),
            "auto": v4._cars_out_demand_peak(pool), "tetto": tetto,
            "conflittiAuto": sum(1 for m in pool if m.car_id is None)}


def _peggiora(dopo: dict, prima: dict) -> str | None:
    """Il motivo per cui la soluzione nuova non si può prendere, o None."""
    if dopo["violazioni"] > prima["violazioni"]:
        return "più violazioni normative"
    if dopo["globali"] > prima["globali"]:
        return "tetti percentuali peggiorati"
    if dopo["vincoli"] > prima["vincoli"]:
        return "vincoli globali peggiorati"
    if dopo["tetto"] > 0 and dopo["auto"] > max(dopo["tetto"], prima["auto"]):
        return "tetto auto aziendali"
    if dopo["conflittiAuto"] > prima["conflittiAuto"]:
        return "trasferimenti senza auto"
    return None
