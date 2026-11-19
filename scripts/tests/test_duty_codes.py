"""Codifica aziendale dei turni guida: lettera del deposito + 001-099
mattinali, 100-199 pomeridiani, in ordine di inizio nastro."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import crew_scheduler_v4 as v4  # noqa: E402
from optimizer_common import DriverDutyV3, Segment  # noqa: E402


def _seg(vid, start, end):
    return Segment(idx=v4._next_seg_idx(), vehicle_id=vid, vehicle_type="12m", trips=[], start_min=start, end_min=end,
                   work_min=end - start, driving_min=end - start, first_stop="A", last_stop="B",
                   first_cluster=None, last_cluster=None, half="full", cut_index=None)


def _duty(idx, vid, start, end):
    return DriverDutyV3(idx=idx, driver_id="X", duty_type="intero", segments=[_seg(vid, start, end)],
                        nastro_start=start, nastro_end=end, nastro_min=end - start, work_min=end - start,
                        driving_min=end - start, interruption_min=0, pre_turno_min=12, transfer_min=0)


def test_codes_by_depot_and_half_day(monkeypatch):
    monkeypatch.setattr(v4, "RESIDENZA_BY_VEHICLE", {"U001": {"name": "Ancona"}, "U002": {"name": "Ancona"}, "U003": {"name": "Jesi"}})
    duties = [
        _duty(0, "U001", 14 * 60, 21 * 60),      # pomeriggio, secondo
        _duty(1, "U002", 5 * 60 + 50, 12 * 60),  # mattina, primo
        _duty(2, "U001", 13 * 60, 20 * 60),      # pomeriggio, primo
        _duty(3, "U002", 6 * 60 + 30, 13 * 60),  # mattina, secondo
        _duty(4, "U003", 7 * 60, 14 * 60),       # Jesi, mattina
    ]
    v4.assign_duty_codes(duties)
    codes = {d.idx: d.driver_id for d in duties}
    assert codes == {1: "A001", 3: "A002", 2: "A100", 0: "A101", 4: "J001"}


def test_codes_fallback_to_service_letter(monkeypatch):
    monkeypatch.setattr(v4, "RESIDENZA_BY_VEHICLE", {})
    monkeypatch.setattr(v4, "DUTY_CODE_PREFIX", "U")
    duties = [_duty(0, "V1", 6 * 60, 13 * 60), _duty(1, "V1", 15 * 60, 22 * 60)]
    v4.assign_duty_codes(duties)
    assert [d.driver_id for d in duties] == ["U001", "U100"]


# ── Tappa 6.25: la codifica è un dato dell'azienda (config.codiciTurni) ──

def test_sigla_del_deposito_scritta_vince_sull_iniziale(monkeypatch):
    monkeypatch.setattr(v4, "RESIDENZA_BY_VEHICLE", {"V1": {"id": "d1", "name": "Nord"}, "V2": {"id": "d2", "name": "Nuovo"}})
    v4.imposta_codifica_turni({"sigle": {"d1": "N", "d2": "NV"}, "pomeriggioDaMin": 720})
    try:
        duties = [_duty(0, "V1", 6 * 60, 13 * 60), _duty(1, "V2", 6 * 60, 13 * 60), _duty(2, "V2", 14 * 60, 21 * 60)]
        v4.assign_duty_codes(duties)
        # due depositi con la stessa iniziale non si dividono più la lettera
        assert [d.driver_id for d in duties] == ["N001", "NV001", "NV100"]
    finally:
        v4.imposta_codifica_turni(None)


def test_ora_del_pomeriggio_e_numerazione_unica(monkeypatch):
    monkeypatch.setattr(v4, "RESIDENZA_BY_VEHICLE", {"V1": {"id": "d1", "name": "Ovest"}})
    duties = lambda: [_duty(0, "V1", 6 * 60, 13 * 60), _duty(1, "V1", 13 * 60 + 30, 20 * 60), _duty(2, "V1", 14 * 60, 21 * 60)]
    try:
        v4.imposta_codifica_turni({"pomeriggioDaMin": 14 * 60})
        ds = duties(); v4.assign_duty_codes(ds)
        assert [d.driver_id for d in ds] == ["O001", "O002", "O100"]
        # None: una sola numerazione, in ordine di inizio nastro
        v4.imposta_codifica_turni({"pomeriggioDaMin": None})
        ds = duties(); v4.assign_duty_codes(ds)
        assert [d.driver_id for d in ds] == ["O001", "O002", "O003"]
    finally:
        v4.imposta_codifica_turni(None)


def test_senza_codifica_vale_quella_di_sempre():
    v4.imposta_codifica_turni(None)
    assert v4.DUTY_CODE_AFTERNOON == 12 * 60 and v4.SIGLE_DEPOSITI == {}
    # sigle che non vanno (minuscole, troppo lunghe) si ignorano; un'ora fuori dalla giornata vale «nessuna»
    v4.imposta_codifica_turni({"sigle": {"a": "ab", "b": "ABCD", "c": "C1"}, "pomeriggioDaMin": 9999})
    try:
        assert v4.SIGLE_DEPOSITI == {"c": "C1"} and v4.DUTY_CODE_AFTERNOON is None
    finally:
        v4.imposta_codifica_turni(None)
