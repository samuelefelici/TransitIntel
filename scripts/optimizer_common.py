"""
optimizer_common.py — Tipi condivisi, I/O JSON, utilità geometriche e costanti CCNL
per i solver CP-SAT Turni Macchina (vehicle_scheduler_cpsat.py)
e Turni Guida (crew_scheduler_cpsat.py).
"""

from __future__ import annotations
import json
import math
import sys
from dataclasses import dataclass, field
from typing import Any

# ═══════════════════════════════════════════════════════════════
#  COSTANTI
# ═══════════════════════════════════════════════════════════════

VEHICLE_SIZE = {"autosnodato": 4, "12m": 3, "10m": 2, "pollicino": 1}
VEHICLE_TYPES = list(VEHICLE_SIZE.keys())

MAX_DOWNSIZE_LEVELS = 1

# Deadhead / idle
MAX_DEADHEAD_KM = 30
MAX_IDLE_AT_TERMINAL = 60      # min — oltre questo, rientro deposito
MIN_LAYOVER = 3                # min — sosta minima allo stesso capolinea
DEADHEAD_BUFFER = 5            # min — aggiunto a ogni deadhead stimato
DEADHEAD_SPEED = {"urbano": 20, "extraurbano": 40}   # km/h
ROAD_CIRCUITY = 1.3            # fattore rettilinea → stradale

# Costi (€)
COST_VEHICLE_FIXED_DAY = {"autosnodato": 55, "12m": 42, "10m": 32, "pollicino": 18}
COST_VEHICLE_PER_SERVICE_KM = {"autosnodato": 1.20, "12m": 0.95, "10m": 0.75, "pollicino": 0.45}
COST_VEHICLE_PER_DEADHEAD_KM = {"autosnodato": 1.00, "12m": 0.80, "10m": 0.65, "pollicino": 0.40}
AVG_SERVICE_SPEED = {"urbano": 18, "extraurbano": 32}  # km/h
COST_PER_DRIVING_HOUR = 28
COST_PER_DEPOT_RETURN = 15
COST_PER_IDLE_HOUR = 5


# ═══════════════════════════════════════════════════════════════
#  VEHICLE COST RATES — Tariffe turni macchina (MAIOR-inspired)
# ═══════════════════════════════════════════════════════════════

@dataclass
class VehicleCostRates:
    """
    Tariffe per il calcolo costi turni macchina.
    Tutti i valori sono in euro — configurabili dall'operatore.
    Ispirate al modello MAIOR VS.
    """

    # A. Costo fisso giornaliero per tipo veicolo (assicurazione, bollo, manutenzione)
    fixed_daily: dict = field(default_factory=lambda: {
        "autosnodato": 55.0, "12m": 42.0, "10m": 32.0, "pollicino": 18.0,
    })

    # B. Costo per km in servizio per tipo veicolo (carburante, gomme, usura)
    per_service_km: dict = field(default_factory=lambda: {
        "autosnodato": 1.20, "12m": 0.95, "10m": 0.75, "pollicino": 0.45,
    })

    # C. Costo per km fuori linea (deadhead) per tipo veicolo
    per_deadhead_km: dict = field(default_factory=lambda: {
        "autosnodato": 1.00, "12m": 0.80, "10m": 0.65, "pollicino": 0.40,
    })

    # Velocità media per stima km da ore (km/h)
    avg_service_speed: dict = field(default_factory=lambda: {
        "urbano": 18.0, "extraurbano": 32.0,
    })

    # D. Costo per minuto di sosta al capolinea (veicolo fermo, autista pagato)
    idle_per_min: float = 0.08          # ~€5/h

    # Costo per minuto di sosta LUNGA (>threshold) — penalità aggiuntiva
    long_idle_per_min: float = 0.15     # ~€9/h
    long_idle_threshold: int = 20       # minuti

    # E. Costo per rientro deposito
    per_depot_return: float = 15.0

    # F. Sbilanciamento durata turno (QUADRATICO, ispirato a MAIOR CostoLavoroQuadratico)
    target_shift_duration: int = 600    # 10h = target durata turno macchina (minuti)
    balance_quadratic_coeff: float = 0.0003
    # Esempio: turno 8h → delta=120min → 120²×0.0003 = €4.32
    #          turno 14h → delta=240min → 240²×0.0003 = €17.28

    # G. Gap nastro-lavoro (QUADRATICO, ispirato a MAIOR coeff_lav_nastro_quad)
    gap_quadratic_coeff: float = 0.0005
    # nastro=600min, lavoro=450min → gap=150 → 150²×0.0005 = €11.25

    # H. Downsize penalty
    downsize_peak_per_level_per_min: float = 0.10   # €/min/livello in ora di punta
    downsize_offpeak_per_level_per_min: float = 0.01  # quasi zero fuori punta

    # Sosta massima al capolinea prima del rientro deposito.
    # NOTA: questo valore controlla ANCHE l'ampiezza della finestra di
    # generazione archi: max_window = max_idle_at_terminal + 30. Valori bassi
    # tagliano fuori dal grafo le fusioni "con lunga sosta in deposito",
    # forzando il solver ad aprire più veicoli del necessario. Default alzato
    # a 240 (4h) per consentire al solver di esplorare riassorbimenti che a
    # occhio sono fattibili (es. una corsa serale isolata che riempie un buco
    # in una catena pomeridiana).
    max_idle_at_terminal: int = 240     # minuti (alzato da 90)

    # FIX-VSP-1: sosta massima al capolinea per generare un arco. Indipendente
    # da max_idle_at_terminal (che resta soglia per "depot_return"). Default
    # alto (10h) per non escludere a priori riassorbimenti che il solver
    # potrebbe accettare quando l'utente forza la minimizzazione veicoli.
    max_idle_for_arc_min: int = 600     # 10 ore

    # FIX-VSP-CLUSTER: raggio (in metri) entro cui due fermate terminale con
    # stop_id diversi vengono trattate come "stesso punto" — deadhead km=0,
    # tempo=0, nessun buffer. Riproduce la logica dei cluster MAIOR/BDS:
    # capolinea fisicamente coincidenti ma con codifica GTFS multipla
    # (es. "Stazione FS lato A/B/C", "Ugo Bassi sud/nord").
    # CRITICO per minimizzazione veicoli: senza questo, archi tight (corsa che
    # arriva alle 14:00 e parte un'altra alle 14:05 dallo stesso piazzale ma
    # con stop_id differente) vengono SCARTATI dal filtro
    # `arrival + max(dh_min, MIN_LAYOVER) > departure`.
    terminal_cluster_radius_m: int = 250    # metri (~2-3 isolati urbani)

    # Soglia sotto la quale il deadhead è trascurabile
    min_deadhead_km: float = 0.5

    @classmethod
    def from_config(cls, cfg: dict | None) -> "VehicleCostRates":
        """Crea VehicleCostRates da config operatore JSON (merge con default)."""
        r = cls()
        if not cfg:
            return r
        _map = {
            "maxIdleAtTerminal": "max_idle_at_terminal",
            "maxIdleForArcMin": "max_idle_for_arc_min",
            "terminalClusterRadiusM": "terminal_cluster_radius_m",
            "targetShiftDuration": "target_shift_duration",
            "balanceCoeff": "balance_quadratic_coeff",
            "gapCoeff": "gap_quadratic_coeff",
            "perDepotReturn": "per_depot_return",
            "idlePerMin": "idle_per_min",
            "longIdlePerMin": "long_idle_per_min",
            "longIdleThreshold": "long_idle_threshold",
            "downsizePeakPerLevelPerMin": "downsize_peak_per_level_per_min",
            "downsizeOffpeakPerLevelPerMin": "downsize_offpeak_per_level_per_min",
            "minDeadheadKm": "min_deadhead_km",
        }
        for js_key, py_attr in _map.items():
            if js_key in cfg:
                setattr(r, py_attr, type(getattr(r, py_attr))(cfg[js_key]))
        # Nested dicts
        for dict_key in ("fixedDaily", "perServiceKm", "perDeadheadKm", "avgServiceSpeed"):
            py_key = {
                "fixedDaily": "fixed_daily",
                "perServiceKm": "per_service_km",
                "perDeadheadKm": "per_deadhead_km",
                "avgServiceSpeed": "avg_service_speed",
            }[dict_key]
            if dict_key in cfg and isinstance(cfg[dict_key], dict):
                getattr(r, py_key).update(cfg[dict_key])
        return r


@dataclass
class VehicleShiftCost:
    """Costo in euro di un turno macchina, calcolabile a priori."""
    fixed_daily: float = 0.0
    service_km_cost: float = 0.0
    deadhead_km_cost: float = 0.0
    idle_cost: float = 0.0
    depot_return_cost: float = 0.0
    balance_penalty: float = 0.0
    gap_penalty: float = 0.0
    downsize_penalty: float = 0.0
    total: float = 0.0

    def compute(self) -> float:
        self.total = (
            self.fixed_daily + self.service_km_cost + self.deadhead_km_cost
            + self.idle_cost + self.depot_return_cost
            + self.balance_penalty + self.gap_penalty + self.downsize_penalty
        )
        return self.total

    def to_dict(self) -> dict:
        return {
            "fixedDaily": round(self.fixed_daily, 2),
            "serviceKmCost": round(self.service_km_cost, 2),
            "deadheadKmCost": round(self.deadhead_km_cost, 2),
            "idleCost": round(self.idle_cost, 2),
            "depotReturnCost": round(self.depot_return_cost, 2),
            "balancePenalty": round(self.balance_penalty, 2),
            "gapPenalty": round(self.gap_penalty, 2),
            "downsizePenalty": round(self.downsize_penalty, 2),
            "total": round(self.total, 2),
        }


# Turni guida — normativa CCNL
PRE_TURNO_MIN = 12
PRE_TURNO_AUTO_MIN = 5   # pre-turno ridotto quando si usa auto aziendale
TARGET_WORK_LOW = 390     # 6h30
TARGET_WORK_HIGH = 435    # 7h15
TARGET_WORK_MID = 408     # 6h48 media
COMPANY_CARS = 5

SHIFT_RULES = {
    "intero":      {"maxNastro": 435, "maxLavoro": 435, "intMin": 0,   "intMax": 0,   "maxPct": 100, "sostaMinCapolinea": 15},
    "semiunico":   {"maxNastro": 555, "maxLavoro": 480, "intMin": 75,  "intMax": 179, "maxPct": 12},
    "spezzato":    {"maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999, "maxPct": 13},
    "supplemento": {"maxNastro": 150, "maxLavoro": 150, "intMin": 0,   "intMax": 0,   "maxPct": 100},
}

DEPOT_TRANSFER_CENTRAL = 10
DEPOT_TRANSFER_OUTER = 15

# Pausa obbligatoria dopo guida continuativa
MAX_CONTINUOUS_DRIVING = 270   # 4h30 — oltre serve pausa ≥15 min
MIN_BREAK_AFTER_DRIVING = 15   # min


# ═══════════════════════════════════════════════════════════════
#  BDS NORMATIVA — Dataclass ispirate a MAIOR BDS v4
# ═══════════════════════════════════════════════════════════════

@dataclass
class PrePostRules:
    """Tempi accessori per turni guida, ispirato a BDS PrePostTipoLocalita.

    4 livelli: turno, ripresa, pezzo guida, mansione.
    Differenziati deposito vs cambio in linea.
    """
    # Pre/post TURNO (inizio e fine del turno guida completo)
    pre_turno_deposito: int = 12     # min — prima uscita dal deposito
    pre_turno_cambio: int = 5        # min — cambio in linea (prende vettura in servizio)
    post_turno_deposito: int = 0     # min — ultimo rientro al deposito (RD 131/1938: 0)
    post_turno_cambio: int = 0       # min — lascia vettura al capolinea (RD 131/1938: 0)

    # Pre/post RIPRESA (ogni ripresa, se turno a 2 riprese)
    pre_ripresa: int = 12            # min — ripresa dopo interruzione (RD 131/1938: come pre-turno)
    post_ripresa: int = 0            # min — prima dell'interruzione (RD 131/1938: 0)

    # Pre/post PEZZO (ogni pezzo guida dopo un cambio in linea)
    pre_pezzo_cambio: int = 3        # min — dopo cambio veicolo
    post_pezzo_cambio: int = 2       # min — prima di lasciare al cambio

    @classmethod
    def from_config(cls, cfg: dict | None) -> "PrePostRules":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "preTurnoDeposito": "pre_turno_deposito",
            "preTurnoCambio": "pre_turno_cambio",
            "postTurnoDeposito": "post_turno_deposito",
            "postTurnoCambio": "post_turno_cambio",
            "preRipresa": "pre_ripresa",
            "postRipresa": "post_ripresa",
            "prePezzoCambio": "pre_pezzo_cambio",
            "postPezzoCambio": "post_pezzo_cambio",
        }
        for js_key, py_attr in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, int(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "preTurnoDeposito": self.pre_turno_deposito,
            "preTurnoCambio": self.pre_turno_cambio,
            "postTurnoDeposito": self.post_turno_deposito,
            "postTurnoCambio": self.post_turno_cambio,
            "preRipresa": self.pre_ripresa,
            "postRipresa": self.post_ripresa,
            "prePezzoCambio": self.pre_pezzo_cambio,
            "postPezzoCambio": self.post_pezzo_cambio,
        }


@dataclass
class RD131Config:
    """Vincolo RD 131/1938 (TPL urbano): guida continuativa max 4h30,
    sosta minima 15 min al capolinea per spezzare la continuità,
    lavoro giornaliero max 7h15 (435 min)."""
    attivo: bool = True
    max_guida_continuativa: int = 270     # 4h30
    sosta_minima: int = 15                # min — sosta al capolinea che resetta il contatore
    max_lavoro_giornaliero: int = 435     # 7h15

    @classmethod
    def from_config(cls, cfg: dict | None) -> "RD131Config":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "attivo": ("attivo", bool),
            "maxGuidaContinuativa": ("max_guida_continuativa", int),
            "sostaMinima": ("sosta_minima", int),
            "maxLavoroGiornaliero": ("max_lavoro_giornaliero", int),
            # Retrocompat CE 561/2006
            "maxPeriodoContinuativo": ("max_guida_continuativa", int),
            "minSosta": ("sosta_minima", int),
        }
        for js_key, (py_attr, typ) in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, typ(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "attivo": self.attivo,
            "maxGuidaContinuativa": self.max_guida_continuativa,
            "sostaMinima": self.sosta_minima,
            "maxLavoroGiornaliero": self.max_lavoro_giornaliero,
        }

# Alias retrocompatibilità
CEE561Config = RD131Config


@dataclass
class IntervalloPastoConfig:
    """Vincolo intervallo pasto ispirato a BDS ACIntervalloPasto."""
    attivo: bool = True
    # Fascia pranzo
    pranzo_controllo_inizio: int = 720   # 12:00
    pranzo_controllo_fine: int = 840     # 14:00
    pranzo_sosta_inizio: int = 720       # 12:00
    pranzo_sosta_fine: int = 900         # 15:00
    pranzo_sosta_minima: int = 30        # min
    # Fascia cena
    cena_controllo_inizio: int = 1140    # 19:00
    cena_controllo_fine: int = 1260      # 21:00
    cena_sosta_inizio: int = 1140        # 19:00
    cena_sosta_fine: int = 1350          # 22:30
    cena_sosta_minima: int = 30          # min

    @classmethod
    def from_config(cls, cfg: dict | None) -> "IntervalloPastoConfig":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "attivo": ("attivo", bool),
            "pranzoControlloInizio": ("pranzo_controllo_inizio", int),
            "pranzoControlloFine": ("pranzo_controllo_fine", int),
            "pranzoSostaInizio": ("pranzo_sosta_inizio", int),
            "pranzoSostaFine": ("pranzo_sosta_fine", int),
            "pranzoSostaMinima": ("pranzo_sosta_minima", int),
            "cenaControlloInizio": ("cena_controllo_inizio", int),
            "cenaControlloFine": ("cena_controllo_fine", int),
            "cenaSostaInizio": ("cena_sosta_inizio", int),
            "cenaSostaFine": ("cena_sosta_fine", int),
            "cenaSostaMinima": ("cena_sosta_minima", int),
        }
        for js_key, (py_attr, typ) in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, typ(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "attivo": self.attivo,
            "pranzoControlloInizio": self.pranzo_controllo_inizio,
            "pranzoControlloFine": self.pranzo_controllo_fine,
            "pranzoSostaInizio": self.pranzo_sosta_inizio,
            "pranzoSostaFine": self.pranzo_sosta_fine,
            "pranzoSostaMinima": self.pranzo_sosta_minima,
            "cenaControlloInizio": self.cena_controllo_inizio,
            "cenaControlloFine": self.cena_controllo_fine,
            "cenaSostaInizio": self.cena_sosta_inizio,
            "cenaSostaFine": self.cena_sosta_fine,
            "cenaSostaMinima": self.cena_sosta_minima,
        }


@dataclass
class StaccoMinimo:
    """Stacco minimo ispirato a BDS STACCO_MINIMO_TRA_PEZZI_GUIDA_COSTANTE."""
    tra_pezzi_guida: int = 5           # min — cambio veicolo al cluster
    per_collegamento_vettura: int = 3   # min — collegamento su vettura come passeggero
    stesso_veicolo: int = 0             # min — continuità sullo stesso mezzo

    @classmethod
    def from_config(cls, cfg: dict | None) -> "StaccoMinimo":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "traPezziGuida": ("tra_pezzi_guida", int),
            "perCollegamentoVettura": ("per_collegamento_vettura", int),
            "stessoVeicolo": ("stesso_veicolo", int),
        }
        for js_key, (py_attr, typ) in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, typ(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "traPezziGuida": self.tra_pezzi_guida,
            "perCollegamentoVettura": self.per_collegamento_vettura,
            "stessoVeicolo": self.stesso_veicolo,
        }


@dataclass
class GestoreRiprese:
    """Configurazione riprese ispirata a BDS GestoreRipreseGenerale."""
    sosta_che_spezza: int = 75          # min — sosta ≥ questo valore → spezzatura
    comprendi_pre_post: bool = True     # nel calcolo durata sosta, includi pre/post
    max_riprese: int = 2                # max numero riprese per turno
    max_durata_ripresa: int = 480       # min — durata massima di ogni ripresa (8h)
    max_guida_per_ripresa: int = 270    # min — guida max per ripresa (4h30, poi pausa CEE)

    @classmethod
    def from_config(cls, cfg: dict | None) -> "GestoreRiprese":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "sostaCheSpezza": ("sosta_che_spezza", int),
            "comprendiPrePost": ("comprendi_pre_post", bool),
            "maxRiprese": ("max_riprese", int),
            "maxDurataRipresa": ("max_durata_ripresa", int),
            "maxGuidaPerRipresa": ("max_guida_per_ripresa", int),
        }
        for js_key, (py_attr, typ) in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, typ(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "sostaCheSpezza": self.sosta_che_spezza,
            "comprendiPrePost": self.comprendi_pre_post,
            "maxRiprese": self.max_riprese,
            "maxDurataRipresa": self.max_durata_ripresa,
            "maxGuidaPerRipresa": self.max_guida_per_ripresa,
        }


@dataclass
class CoperturaSosteConfig:
    """Configurazione copertura soste ispirata a BDS CoperturaSostePerTipoLinea."""
    min_sosta_cambio_urbano: int = 5       # min — soste > 5 min su cambio urbano → coperte
    min_sosta_cambio_extra: int = 10       # min — soste > 10 min su cambio extra → coperte
    min_sosta_deposito: int = 0            # min — soste in deposito → sempre punti di taglio
    modalita_default: str = "IN_TESTA"     # chi copre: IN_TESTA (chi lascia) | IN_CODA (chi prende)

    @classmethod
    def from_config(cls, cfg: dict | None) -> "CoperturaSosteConfig":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "minSostaCambioUrbano": ("min_sosta_cambio_urbano", int),
            "minSostaCambioExtra": ("min_sosta_cambio_extra", int),
            "minSostaDeposito": ("min_sosta_deposito", int),
            "modalitaDefault": ("modalita_default", str),
        }
        for js_key, (py_attr, typ) in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, typ(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "minSostaCambioUrbano": self.min_sosta_cambio_urbano,
            "minSostaCambioExtra": self.min_sosta_cambio_extra,
            "minSostaDeposito": self.min_sosta_deposito,
            "modalitaDefault": self.modalita_default,
        }


@dataclass
class CollegamentoConfig:
    """Configurazione collegamenti ispirata a BDS GESTORE_COLLEGAMENTI."""
    trasferimenti: str = "FORFE_E_VETTURA"      # VIETATI | SOLO_FORFETTIZZATI | SOLO_VETTURA | FORFE_E_VETTURA
    moltiplicatore_trasferimenti: float = 1.0    # retribuzione al 100%
    moltiplicatore_raggiungimenti: float = 0.7   # retribuzione al 70%
    cuscinetto_trasferimento_min: int = 3        # min aggiunti al forfettizzato per sicurezza
    durata_massima_raggiungimento: int = 60      # min max per raggiungimento
    durata_massima_trasferimento: int = 45       # min max per trasferimento
    ammetti_doppi: bool = True                   # forf + vettura in sequenza

    @classmethod
    def from_config(cls, cfg: dict | None) -> "CollegamentoConfig":
        if not cfg:
            return cls()
        r = cls()
        _MAP = {
            "trasferimenti": ("trasferimenti", str),
            "moltiplicatoreTrasferimenti": ("moltiplicatore_trasferimenti", float),
            "moltiplicatoreRaggiungimenti": ("moltiplicatore_raggiungimenti", float),
            "cuscinettoTrasferimentoMin": ("cuscinetto_trasferimento_min", int),
            "durataMassimaRaggiungimento": ("durata_massima_raggiungimento", int),
            "durataMassimaTrasferimento": ("durata_massima_trasferimento", int),
            "ammettiDoppi": ("ammetti_doppi", bool),
        }
        for js_key, (py_attr, typ) in _MAP.items():
            if js_key in cfg:
                setattr(r, py_attr, typ(cfg[js_key]))
        return r

    def to_dict(self) -> dict:
        return {
            "trasferimenti": self.trasferimenti,
            "moltiplicatoreTrasferimenti": self.moltiplicatore_trasferimenti,
            "moltiplicatoreRaggiungimenti": self.moltiplicatore_raggiungimenti,
            "cuscinettoTrasferimentoMin": self.cuscinetto_trasferimento_min,
            "durataMassimaRaggiungimento": self.durata_massima_raggiungimento,
            "durataMassimaTrasferimento": self.durata_massima_trasferimento,
            "ammettiDoppi": self.ammetti_doppi,
        }


@dataclass
class WorkCalculation:
    """Calcolo lavoro ispirato a BDS RegolaCalcoloLavoroSommaRiprese."""
    driving_min: int = 0
    idle_at_terminal_min: int = 0       # attese al capolinea tra corse
    pre_post_min: int = 0               # pre-turno + pre-ripresa + pre-pezzo
    transfer_min: int = 0               # trasferimenti
    # Soste fra riprese (semiunico/spezzato)
    soste_fra_riprese_ir_min: int = 0   # in residenza (deposito)
    soste_fra_riprese_fr_min: int = 0   # fuori residenza
    coeff_ir: float = 0.0               # retribuzione soste IR
    coeff_fr: float = 0.0               # retribuzione soste FR

    @property
    def lavoro_netto(self) -> int:
        """Guida + attese + pre/post + trasferimenti. Senza soste fra riprese."""
        return self.driving_min + self.idle_at_terminal_min + self.pre_post_min + self.transfer_min

    @property
    def lavoro_convenzionale(self) -> int:
        """Lavoro netto + soste fra riprese pesate con coefficienti."""
        extra_ir = int(self.soste_fra_riprese_ir_min * self.coeff_ir)
        extra_fr = int(self.soste_fra_riprese_fr_min * self.coeff_fr)
        return self.lavoro_netto + extra_ir + extra_fr

    def to_dict(self) -> dict:
        return {
            "lavoroNetto": self.lavoro_netto,
            "lavoroConvenzionale": self.lavoro_convenzionale,
            "driving": self.driving_min,
            "idleAtTerminal": self.idle_at_terminal_min,
            "prePost": self.pre_post_min,
            "transfer": self.transfer_min,
            "sosteFraRipreseIR": self.soste_fra_riprese_ir_min,
            "sosteFraRipreseFR": self.soste_fra_riprese_fr_min,
        }


@dataclass
class BDSValidation:
    """Risultato validazione BDS di un turno guida (RD 131/1938)."""
    classificazione_valida: bool = True
    rd131_ok: bool = True
    sosta_capolinea_ok: bool = True
    lavoro_ok: bool = True
    intervallo_pasto_ok: bool = True
    stacco_minimo_ok: bool = True
    nastro_ok: bool = True
    riprese_ok: bool = True
    violations: list[str] = field(default_factory=list)

    @property
    def cee561_ok(self) -> bool:
        """Alias retrocompatibilità."""
        return self.rd131_ok

    @property
    def valid(self) -> bool:
        return (self.classificazione_valida and self.rd131_ok
                and self.sosta_capolinea_ok and self.lavoro_ok
                and self.intervallo_pasto_ok and self.stacco_minimo_ok
                and self.nastro_ok and self.riprese_ok)

    def to_dict(self) -> dict:
        return {
            "valid": self.valid,
            "classificazioneValida": self.classificazione_valida,
            "rd131": self.rd131_ok,
            "sostaCapolinea": self.sosta_capolinea_ok,
            "lavoro": self.lavoro_ok,
            "cee561": self.rd131_ok,   # retrocompat
            "intervalloPasto": self.intervallo_pasto_ok,
            "staccoMinimo": self.stacco_minimo_ok,
            "nastro": self.nastro_ok,
            "riprese": self.riprese_ok,
            "violations": self.violations,
        }


# ═══════════════════════════════════════════════════════════════
#  CLUSTER DI CAMBIO IN LINEA
# ═══════════════════════════════════════════════════════════════

@dataclass
class ClusterStop:
    """Una fermata intermedia di una corsa che appartiene a un cluster."""
    stop_id: str
    stop_name: str
    stop_sequence: int
    cluster_id: str
    arrival_min: int = 0       # minuto arrivo alla fermata (dal backend)
    departure_min: int = 0     # minuto partenza dalla fermata


@dataclass
class Cluster:
    id: str
    name: str
    keywords: list[str]
    transfer_from_depot_min: int
    stop_ids: list[str] = field(default_factory=list)    # GTFS stop_id list (from DB)
    stop_names: list[str] = field(default_factory=list)  # corrispondenti stop_name
    stop_coords: list[tuple] = field(default_factory=list)  # (lat, lon) per ogni stop
    color: str = "#3b82f6"

DEFAULT_CLUSTERS = [
    Cluster("ugo_bassi",  "Piazza Ugo Bassi",   ["UGO BASSI", "U.BASSI"], 10),
    Cluster("stazione",   "Stazione FS",         ["STAZIONE F", "STAZIONE FS", "TRAIN STATION"], 10),
    Cluster("cavour",     "Piazza Cavour",       ["CAVOUR", "STAMIRA", "VECCHINI"], 10),
    Cluster("4_novembre", "Piazza IV Novembre",  ["IV NOVEMBRE", "4 NOVEMBRE"], 10),
    Cluster("tavernelle", "Tavernelle",          ["TAVERNELLE"], 10),
    Cluster("torrette",   "Ospedale Torrette",   ["OSPEDALE REGIONALE", "TORRETTE"], 15),
]


def match_cluster(stop_name: str | None, clusters: list[Cluster] | None = None,
                   stop_id: str | None = None) -> str | None:
    """Restituisce l'id del cluster. Prima cerca per stop_id, poi per keyword."""
    if not stop_name and not stop_id:
        return None
    for c in (clusters or DEFAULT_CLUSTERS):
        # Match per stop_id (prioritario — cluster dal DB)
        if stop_id and c.stop_ids and stop_id in c.stop_ids:
            return c.id
        # Match per stop_name nelle stop_names salvate dal DB
        if stop_name and c.stop_names:
            up = stop_name.upper()
            for sn in c.stop_names:
                if sn.upper() == up:
                    return c.id
    # Fallback: keyword matching (cluster hardcoded)
    if stop_name:
        up = stop_name.upper()
        for c in (clusters or DEFAULT_CLUSTERS):
            for kw in c.keywords:
                if kw in up:
                    return c.id
    return None


def cluster_by_id(cluster_id: str, clusters: list[Cluster] | None = None) -> Cluster | None:
    for c in (clusters or DEFAULT_CLUSTERS):
        if c.id == cluster_id:
            return c
    return None


def depot_transfer_min(stop_name: str | None, clusters: list[Cluster] | None = None) -> int:
    cid = match_cluster(stop_name, clusters)
    if cid:
        c = cluster_by_id(cid, clusters)
        return c.transfer_from_depot_min if c else DEPOT_TRANSFER_CENTRAL
    return DEPOT_TRANSFER_OUTER


def build_cluster_stop_lookup(clusters: list[Cluster]) -> dict[str, str]:
    """Costruisce una mappa O(1) stop_id → cluster_id per tutti i cluster."""
    lookup: dict[str, str] = {}
    for c in clusters:
        for sid in c.stop_ids:
            lookup[sid] = c.id
    return lookup


# ═══════════════════════════════════════════════════════════════
#  DATACLASS — TIPI CONDIVISI
# ═══════════════════════════════════════════════════════════════

@dataclass
class Trip:
    """Una corsa GTFS con coordinate fermate, tipo veicolo richiesto, ecc."""
    idx: int                      # indice progressivo nel vettore trips
    trip_id: str
    route_id: str
    route_name: str
    headsign: str | None
    direction_id: int
    departure_time: str
    arrival_time: str
    departure_min: int
    arrival_min: int
    first_stop_id: str
    last_stop_id: str
    first_stop_lat: float
    first_stop_lon: float
    last_stop_lat: float
    last_stop_lon: float
    first_stop_name: str
    last_stop_name: str
    stop_count: int
    required_vehicle: str         # tipo veicolo richiesto
    category: str                 # "urbano" | "extraurbano"
    forced: bool                  # solo tipo esatto
    duration_min: int = 0


@dataclass
class Arc:
    """Arco tra due corse: costo del deadhead per il sequenziamento."""
    i: int          # indice corsa origine
    j: int          # indice corsa destinazione
    dh_km: float
    dh_min: int
    gap_min: int    # departure(j) - arrival(i)
    depot_return: bool  # gap > MAX_IDLE_AT_TERMINAL


@dataclass
class VShiftTrip:
    """Una corsa dentro un turno macchina (formato output)."""
    type: str           # "trip" | "deadhead" | "depot"
    trip_id: str
    route_id: str
    route_name: str
    headsign: str | None
    departure_time: str
    arrival_time: str
    departure_min: int
    arrival_min: int
    first_stop_name: str = ""
    last_stop_name: str = ""
    stop_count: int = 0
    duration_min: int = 0
    direction_id: int = 0
    deadhead_km: float = 0
    deadhead_min: int = 0
    downsized: bool = False
    original_vehicle: str | None = None
    cluster_stops: list[ClusterStop] = field(default_factory=list)  # fermate intermedie in cluster


@dataclass
class VehicleShift:
    """Un turno macchina completo."""
    vehicle_id: str
    vehicle_type: str
    category: str
    trips: list[VShiftTrip] = field(default_factory=list)
    start_min: int = 0
    end_min: int = 0
    total_service_min: int = 0
    total_deadhead_min: int = 0
    total_deadhead_km: float = 0
    depot_returns: int = 0
    trip_count: int = 0
    fifo_order: int = 0
    first_out: int = 0
    last_in: int = 0
    shift_duration: int = 0
    downsized_trips: int = 0


@dataclass
class Task:
    """Un pezzo di lavoro atomico per i turni guida (sequenza di corse su un veicolo)."""
    idx: int
    vehicle_id: str
    vehicle_type: str
    trips: list[VShiftTrip]
    start_min: int
    end_min: int
    duration_min: int
    driving_min: int
    first_stop: str
    last_stop: str
    first_cluster: str | None
    last_cluster: str | None
    # ── Estensioni v2 ──
    granularity: str = "fine"          # "fine" | "medium" | "coarse"
    vehicle_shift_id: str | None = None  # id del turno macchina di origine
    first_lat: float = 0.0
    first_lon: float = 0.0
    last_lat: float = 0.0
    last_lon: float = 0.0


@dataclass
class CambioInfo:
    cluster: str
    cluster_name: str
    from_vehicle: str
    to_vehicle: str
    cut_type: str = "inter"         # "inter" (tra corse) | "intra" (dentro corsa)
    stop_id: str = ""               # GTFS stop_id del punto di cambio
    stop_sequence: int = 0          # stop_sequence dentro la corsa (solo per intra)
    trip_id: str = ""               # trip_id dove avviene il cambio (solo per intra)
    route_name: str = ""            # nome linea (solo per intra)


@dataclass
class DutyBlock:
    task: Task
    cambio: CambioInfo | None = None


@dataclass
class Ripresa:
    blocks: list[DutyBlock]
    start_min: int
    end_min: int
    pre_turno_min: int
    transfer_min: int
    transfer_type: str      # "auto" | "bus" | "piedi"
    work_min: int


@dataclass
class Duty:
    """Un turno guida candidato (feasible per CCNL)."""
    idx: int
    duty_type: str            # "intero" | "semiunico" | "spezzato" | "supplemento"
    riprese: list[Ripresa]
    nastro_start: int
    nastro_end: int
    nastro_min: int
    work_min: int
    interruption_min: int
    transfer_min: int
    pre_turno_min: int
    cambi_count: int
    task_indices: list[int]   # indici dei Task coperti da questo duty
    # ── Estensioni v2 (cost model) ──
    cost_euro: float = 0.0                     # costo totale in euro
    cost_breakdown: Any = None                 # DutyCostBreakdown (set dal cost_model)


# ═══════════════════════════════════════════════════════════════
#  UTILITÀ GEOMETRICHE
# ═══════════════════════════════════════════════════════════════

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    rlat1, rlon1 = math.radians(lat1), math.radians(lon1)
    rlat2, rlon2 = math.radians(lat2), math.radians(lon2)
    dlat = rlat2 - rlat1
    dlon = rlon2 - rlon1
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def estimate_deadhead(
    from_lat: float, from_lon: float,
    to_lat: float, to_lon: float,
    category: str = "urbano",
) -> tuple[float, int]:
    """Restituisce (km_stradali, minuti) per il deadhead."""
    straight = haversine_km(from_lat, from_lon, to_lat, to_lon)
    road_km = straight * ROAD_CIRCUITY
    speed = DEADHEAD_SPEED.get(category, 20)
    minutes = math.ceil((road_km / speed) * 60) + DEADHEAD_BUFFER
    return round(road_km, 1), minutes


def is_peak_hour(departure_min: int) -> bool:
    h = departure_min // 60
    return (7 <= h <= 9) or (17 <= h <= 19)


def can_vehicle_serve(vehicle_size: int, required_size: int) -> bool:
    if vehicle_size >= required_size:
        return True
    return (required_size - vehicle_size) <= MAX_DOWNSIZE_LEVELS


# ═══════════════════════════════════════════════════════════════
#  FORMATTAZIONE TEMPO
# ═══════════════════════════════════════════════════════════════

def min_to_time(m: int) -> str:
    h = m // 60
    mm = round(m % 60)
    return f"{h:02d}:{mm:02d}"


def fmt_dur(m: int) -> str:
    return f"{m // 60}h{round(m % 60):02d}"


# ═══════════════════════════════════════════════════════════════
#  I/O JSON
# ═══════════════════════════════════════════════════════════════

def load_input() -> dict[str, Any]:
    """Legge JSON da stdin."""
    return json.load(sys.stdin)


def write_output(data: dict[str, Any]) -> None:
    """Scrive JSON su stdout."""
    json.dump(data, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


def log(msg: str) -> None:
    """Scrive log su stderr (non inquina stdout)."""
    print(msg, file=sys.stderr, flush=True)


def report_progress(phase: str, percentage: float, detail: str, extra: dict | None = None) -> None:
    """
    Emette una riga di progresso su stderr nel formato:
      PROGRESS|phase|percentage|detail|extra_json
    Il JobManager backend parsifica queste righe e le inoltra via SSE.
    """
    pct = max(0.0, min(100.0, percentage))
    extra_str = json.dumps(extra, ensure_ascii=False) if extra else ""
    print(f"PROGRESS|{phase}|{pct:.1f}|{detail}|{extra_str}", file=sys.stderr, flush=True)


# ═══════════════════════════════════════════════════════════════
#  MERGE CONFIG OPERATORE
# ═══════════════════════════════════════════════════════════════

# Pesi default (scala 0-10, frontend li normalizza)
DEFAULT_OPERATOR_CONFIG: dict[str, Any] = {
    # shiftRules — sovrascrivibili dall'operatore
    "shiftRules": {
        "intero":      {"maxNastro": 435, "maxLavoro": 435, "intMin": 0,   "intMax": 0,   "maxPct": 100, "sostaMinCapolinea": 15},
        "semiunico":   {"maxNastro": 555, "maxLavoro": 480, "intMin": 75,  "intMax": 179, "maxPct": 12},
        "spezzato":    {"maxNastro": 630, "maxLavoro": 450, "intMin": 180, "intMax": 999, "maxPct": 13},
        "supplemento": {"maxNastro": 150, "maxLavoro": 150, "intMin": 0,   "intMax": 0,   "maxPct": 100},
    },
    # Pesi obiettivo (0-10)
    "weights": {
        "minDrivers": 8,          # quanto minimizzare il numero conducenti
        "workBalance": 6,         # quanto bilanciare le ore lavoro
        "minCambi": 5,            # quanto penalizzare i cambi in linea
        "preferIntero": 7,        # preferenza per turni intero
        "minSupplementi": 4,      # minimizzare turni supplemento
        "qualityTarget": 5,       # quanto avvicinarsi al target 6h30-6h42
    },
    # Intensità solver (1=veloce, 2=bilanciato, 3=aggressivo)
    "solverIntensity": 2,
    # Round iterativi max
    "maxRounds": 5,
    # Vincoli fissati dall'operatore
    "pinnedConstraints": {
        "lockedDuties": [],       # driverId da mantenere invariati
        "pinnedTasks": {},         # taskIdx -> driverId forzato
        "forbidCambi": [],        # coppie (taskA, taskB) vietate come cambio
        "forceCambi": [],         # coppie (taskA, taskB) forzate come cambio
        "maxCambiPerTurno": None, # null = nessun limite extra
    },
    # Max turni (null = nessun vincolo)
    "maxDuties": None,
    # ── v2: parametri avanzati ──
    "taskGranularity": "auto",          # "auto" | "fine" | "medium" | "coarse"
    "enableCrossCluster": True,         # trasferimenti cross-cluster
    "enableTaxiFallback": True,         # taxi se auto esaurite
    "costRates": {},                    # override tariffe (CostRates fields in camelCase)
}


def merge_config(user_config: dict | None) -> dict:
    """
    Fonde la configurazione operatore con i default.
    Valida e clamp i pesi a [0, 10].
    """
    if not user_config:
        return dict(DEFAULT_OPERATOR_CONFIG)

    merged: dict[str, Any] = {}

    # shiftRules: merge per tipo
    default_rules = DEFAULT_OPERATOR_CONFIG["shiftRules"]
    user_rules = user_config.get("shiftRules", {})
    merged_rules: dict[str, dict] = {}
    for typ, defaults in default_rules.items():
        ur = user_rules.get(typ, {})
        merged_rules[typ] = {k: ur.get(k, v) for k, v in defaults.items()}
    merged["shiftRules"] = merged_rules

    # weights: merge e clamp a [0, 10]
    default_weights = DEFAULT_OPERATOR_CONFIG["weights"]
    user_weights = user_config.get("weights", {})
    merged_w: dict[str, float] = {}
    for k, v in default_weights.items():
        raw = user_weights.get(k, v)
        merged_w[k] = max(0.0, min(10.0, float(raw)))
    merged["weights"] = merged_w

    # solverIntensity
    si = user_config.get("solverIntensity", DEFAULT_OPERATOR_CONFIG["solverIntensity"])
    merged["solverIntensity"] = max(1, min(3, int(si)))

    # maxRounds
    mr = user_config.get("maxRounds", DEFAULT_OPERATOR_CONFIG["maxRounds"])
    merged["maxRounds"] = max(1, min(10, int(mr)))

    # pinnedConstraints
    default_pinned = DEFAULT_OPERATOR_CONFIG["pinnedConstraints"]
    user_pinned = user_config.get("pinnedConstraints", {})
    merged["pinnedConstraints"] = {
        k: user_pinned.get(k, v)
        for k, v in default_pinned.items()
    }

    # maxDuties
    md = user_config.get("maxDuties")
    merged["maxDuties"] = int(md) if md is not None else None

    # timeLimit viene gestito a livello di main(), non qui
    if "timeLimit" in user_config:
        merged["timeLimit"] = user_config["timeLimit"]

    # ── v2: parametri avanzati ──
    merged["taskGranularity"] = user_config.get(
        "taskGranularity", DEFAULT_OPERATOR_CONFIG["taskGranularity"])
    merged["enableCrossCluster"] = user_config.get(
        "enableCrossCluster", DEFAULT_OPERATOR_CONFIG["enableCrossCluster"])
    merged["enableTaxiFallback"] = user_config.get(
        "enableTaxiFallback", DEFAULT_OPERATOR_CONFIG["enableTaxiFallback"])
    merged["costRates"] = user_config.get("costRates", {})

    # ── v3: restrizione cambi a cluster definiti ──
    merged["cutOnlyAtClusters"] = user_config.get("cutOnlyAtClusters", True)

    return merged


def weights_to_solver_params(weights: dict[str, float]) -> dict[str, int]:
    """
    Converte i pesi 0-10 dell'operatore in pesi CP-SAT interni.
    """
    return {
        "W_CREW":       int(50_000 + weights.get("minDrivers", 8) * 10_000),
        "W_WORK_DEV":   int(5 + weights.get("workBalance", 6) * 3),
        "W_CAMBI":      int(50 + weights.get("minCambi", 5) * 50),
        "W_SEMIUNICO":  int(20 + (10 - weights.get("preferIntero", 7)) * 15),
        "W_SPEZZATO":   int(40 + (10 - weights.get("preferIntero", 7)) * 20),
        "W_SUPPL":      int(2000 + weights.get("minSupplementi", 4) * 1000),
        "W_SINGLETON":  int(4000 + weights.get("minSupplementi", 4) * 1000),
        "W_QUALITY":    int(5 + weights.get("qualityTarget", 5) * 3),
    }


# ═══════════════════════════════════════════════════════════════
#  CONVERSIONE DICTS ↔ DATACLASS
# ═══════════════════════════════════════════════════════════════

def trip_from_dict(d: dict, idx: int) -> Trip:
    dep_min = d["departureMin"]
    arr_min = d["arrivalMin"]
    return Trip(
        idx=idx,
        trip_id=d["tripId"],
        route_id=d["routeId"],
        route_name=d.get("routeName", d["routeId"]),
        headsign=d.get("headsign"),
        direction_id=d.get("directionId", 0),
        departure_time=d.get("departureTime", min_to_time(dep_min)),
        arrival_time=d.get("arrivalTime", min_to_time(arr_min)),
        departure_min=dep_min,
        arrival_min=arr_min,
        first_stop_id=d.get("firstStopId", ""),
        last_stop_id=d.get("lastStopId", ""),
        first_stop_lat=d.get("firstStopLat", 43.6),
        first_stop_lon=d.get("firstStopLon", 13.5),
        last_stop_lat=d.get("lastStopLat", 43.6),
        last_stop_lon=d.get("lastStopLon", 13.5),
        first_stop_name=d.get("firstStopName", ""),
        last_stop_name=d.get("lastStopName", ""),
        stop_count=d.get("stopCount", 0),
        required_vehicle=d.get("requiredVehicle", "12m"),
        category=d.get("category", "urbano"),
        forced=d.get("forced", False),
        duration_min=max(1, arr_min - dep_min),
    )


def vshift_trip_to_dict(t: VShiftTrip) -> dict:
    d: dict[str, Any] = {
        "type": t.type,
        "tripId": t.trip_id,
        "routeId": t.route_id,
        "routeName": t.route_name,
        "headsign": t.headsign,
        "departureTime": t.departure_time,
        "arrivalTime": t.arrival_time,
        "departureMin": t.departure_min,
        "arrivalMin": t.arrival_min,
    }
    if t.type == "trip":
        d["firstStopName"] = t.first_stop_name
        d["lastStopName"] = t.last_stop_name
        d["stopCount"] = t.stop_count
        d["durationMin"] = t.duration_min
        d["directionId"] = t.direction_id
        if t.downsized:
            d["downsized"] = True
            d["originalVehicle"] = t.original_vehicle
    elif t.type == "deadhead":
        d["deadheadKm"] = t.deadhead_km
        d["deadheadMin"] = t.deadhead_min
    return d


def vehicle_shift_to_dict(vs: VehicleShift) -> dict:
    return {
        "vehicleId": vs.vehicle_id,
        "vehicleType": vs.vehicle_type,
        "category": vs.category,
        "trips": [vshift_trip_to_dict(t) for t in vs.trips],
        "startMin": vs.start_min,
        "endMin": vs.end_min,
        "totalServiceMin": vs.total_service_min,
        "totalDeadheadMin": vs.total_deadhead_min,
        "totalDeadheadKm": round(vs.total_deadhead_km, 1),
        "depotReturns": vs.depot_returns,
        "tripCount": vs.trip_count,
        "fifoOrder": vs.fifo_order,
        "firstOut": vs.first_out,
        "lastIn": vs.last_in,
        "shiftDuration": vs.shift_duration,
        "downsizedTrips": vs.downsized_trips,
    }


# ═══════════════════════════════════════════════════════════════
#  DATACLASS — V3 (Vehicle-Shift-First)
# ═══════════════════════════════════════════════════════════════

@dataclass
class CutCandidate:
    """Un potenziale punto di taglio tra corse o dentro una corsa in un turno macchina."""
    index: int                    # posizione nel vettore trips del VehicleBlock (taglio tra index e index+1, oppure dentro trips[index] se intra)
    gap_min: int                  # gap tra arrivo corsa[index] e partenza corsa[index+1] (0 per intra)
    time_min: int                 # minuto in cui avviene il taglio (arrivo corsa[index] o arrivo alla fermata intra)
    stop_name: str                # fermata dove avviene il taglio
    cluster_id: str | None        # id cluster se la fermata è in un cluster
    score: float                  # punteggio qualità del taglio (più alto = meglio)
    allows_cambio: bool           # True se il taglio avviene in un cluster (cambio in linea possibile)
    left_driving_min: int         # minuti guida nella metà sinistra
    left_work_min: int            # minuti lavoro (guida + attese) nella metà sinistra
    right_driving_min: int        # minuti guida nella metà destra
    right_work_min: int           # minuti lavoro nella metà destra
    transfer_cost_min: int        # minuti di trasferimento deposito<->punto taglio
    cut_type: str = "inter"       # "inter" (tra corse) | "intra" (dentro corsa, a fermata intermedia)
    stop_sequence: int = 0        # stop_sequence nella corsa (solo per intra)
    stop_id: str = ""             # GTFS stop_id (solo per intra)
    trip_id: str = ""             # trip_id della corsa (solo per intra)
    route_name: str = ""          # nome linea (solo per intra)


@dataclass
class Segment:
    """Una porzione di un turno macchina assegnata a un singolo conducente."""
    idx: int                      # indice globale segmento
    vehicle_id: str               # id turno macchina di provenienza
    vehicle_type: str
    trips: list[VShiftTrip]       # corse assegnate
    start_min: int
    end_min: int
    work_min: int                 # lavoro effettivo (guida + attese interne)
    driving_min: int              # solo guida
    first_stop: str
    last_stop: str
    first_cluster: str | None
    last_cluster: str | None
    half: str                     # "full" | "first" | "second" | "middle"
    cut_index: int | None         # indice del CutCandidate usato per produrre questo segmento


@dataclass
class VehicleBlock:
    """Un turno macchina parsato e analizzato per il crew scheduling v3."""
    vehicle_id: str
    vehicle_type: str
    category: str                 # "urbano" | "extraurbano"
    trips: list[VShiftTrip]       # solo type=="trip"
    start_min: int
    end_min: int
    nastro_min: int               # end_min - start_min
    driving_min: int              # somma durate corse
    work_min: int                 # driving + attese interne
    classification: str           # "CORTO" | "CORTO_BASSO" | "MEDIO" | "LUNGO"
    cut_candidates: list[CutCandidate] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)


@dataclass
class DriverDutyV3:
    """Un turno guida v3 — più semplice di Duty, orientato ai segmenti."""
    idx: int
    driver_id: str                # es. "D001"
    duty_type: str                # "intero" | "semiunico" | "spezzato" | "supplemento"
    segments: list[Segment]       # 1 per intero/supplemento, 2 per semiunico/spezzato
    nastro_start: int
    nastro_end: int
    nastro_min: int
    work_min: int
    driving_min: int
    interruption_min: int         # 0 per intero, gap tra le due riprese per semi/spezzato
    pre_turno_min: int
    transfer_min: int             # trasferimento deposito → primo cluster (andata)
    transfer_back_min: int = 0    # trasferimento ultimo cluster → deposito (rientro)
    cambi: list[CambioInfo] = field(default_factory=list)
    cost_euro: float = 0.0
    cost_breakdown: Any = None


# ═══════════════════════════════════════════════════════════════
#  UTILITÀ DI PARSING CLUSTER
# ═══════════════════════════════════════════════════════════════

def parse_clusters_from_config(config: dict) -> list[Cluster]:
    """Parsa cluster dal JSON di config, oppure usa i default."""
    raw = config.get("clusters")
    if not raw:
        return DEFAULT_CLUSTERS
    return [
        Cluster(
            id=c["id"],
            name=c["name"],
            keywords=c.get("keywords", []),
            transfer_from_depot_min=c.get("transferFromDepotMin", DEPOT_TRANSFER_CENTRAL),
            stop_ids=c.get("stopIds", []),
            stop_names=c.get("stopNames", []),
            stop_coords=[(lat, lon) for lat, lon in zip(c.get("stopLats", []), c.get("stopLons", []))],
            color=c.get("color", "#3b82f6"),
        )
        for c in raw
    ]
