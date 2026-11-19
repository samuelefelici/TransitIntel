"""Una corsa senza le coordinate dei capolinea (tappa 6.32).

Prima il motore dei turni macchina la metteva in un punto del primo cliente
scritto nel codice (43,6 N 13,5 E). Ora va al centro delle altre corse, come
fa già l'API per una fermata senza coordinate; nessun luogo scritto a mano.
"""
import sys, os, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from optimizer_common import centro_delle_corse, trip_from_dict

BASE = {"tripId": "t1", "routeId": "R", "departureMin": 480, "arrivalMin": 510}


def test_il_centro_e_la_media_dei_capolinea_noti():
    corse = [
        {**BASE, "firstStopLat": 45.0, "firstStopLon": 10.0, "lastStopLat": 45.2, "lastStopLon": 10.4},
        {**BASE, "firstStopLat": 45.4, "firstStopLon": 10.2},          # arrivo senza coordinate
        {**BASE, "firstStopLat": None, "firstStopLon": 11.0},           # mezza: non conta
        {**BASE},
    ]
    lat, lon = centro_delle_corse(corse)
    assert abs(lat - (45.0 + 45.2 + 45.4) / 3) < 1e-9
    assert abs(lon - (10.0 + 10.4 + 10.2) / 3) < 1e-9
    assert centro_delle_corse([BASE, {**BASE, "firstStopLat": "45", "firstStopLon": True}]) is None
    assert centro_delle_corse([]) is None


def test_la_corsa_con_le_sue_coordinate_le_tiene():
    t = trip_from_dict({**BASE, "firstStopLat": 45.0, "firstStopLon": 10.0, "lastStopLat": 45.2, "lastStopLon": 10.4}, 0, (1.0, 2.0))
    assert (t.first_stop_lat, t.first_stop_lon, t.last_stop_lat, t.last_stop_lon) == (45.0, 10.0, 45.2, 10.4)


def test_senza_coordinate_va_al_centro_delle_altre():
    ripiego = (45.2, 10.2)
    t = trip_from_dict(BASE, 0, ripiego)
    assert (t.first_stop_lat, t.first_stop_lon) == ripiego
    assert (t.last_stop_lat, t.last_stop_lon) == ripiego
    # un capolinea a metà (una sola coordinata, o null) usa il ripiego per tutte e due
    t = trip_from_dict({**BASE, "firstStopLat": 45.0, "firstStopLon": None, "lastStopLat": 45.2, "lastStopLon": 10.4}, 0, ripiego)
    assert (t.first_stop_lat, t.first_stop_lon) == ripiego
    assert (t.last_stop_lat, t.last_stop_lon) == (45.2, 10.4)


def test_senza_nessun_riferimento_non_inventa_un_luogo():
    t = trip_from_dict(BASE, 0)
    assert (t.first_stop_lat, t.first_stop_lon, t.last_stop_lat, t.last_stop_lon) == (0.0, 0.0, 0.0, 0.0)


def test_nessuna_coordinata_scritta_a_mano_negli_script():
    """Fuori dai commenti e dai test, nessuna riga porta una latitudine e una
    longitudine come numeri: i luoghi arrivano dai dati."""
    qui = os.path.join(os.path.dirname(__file__), "..")
    # «lat», «lon», «lng» da soli o dopo un trattino basso (first_stop_lat), oppure
    # in coda a un nome a cammello (firstStopLat), seguiti a breve da un numero
    # decimale da 1 in su (0.001 è una tolleranza, non un luogo)
    numero = r"\W{0,12}-?[1-9]\d{0,2}\.\d+"
    coordinata = re.compile(
        r"(?<![A-Za-z])(lat|lon|lng|latitude|longitude)(?![A-Za-z])" + numero
        + r"|[a-z](Lat|Lon|Lng)(?![a-z])" + numero)
    trovate = []
    for nome in sorted(os.listdir(qui)):
        if not nome.endswith(".py"):
            continue
        for n, riga in enumerate(open(os.path.join(qui, nome), encoding="utf-8"), 1):
            codice = riga.split("#", 1)[0]
            if coordinata.search(codice):
                trovate.append(f"{nome}:{n}: {codice.strip()[:120]}")
    assert trovate == []
