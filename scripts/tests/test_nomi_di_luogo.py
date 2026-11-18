"""Gli script dei calcoli non nominano il primo cliente né i suoi luoghi
(tappa 6.18; per la web e per l'API ci sono gli stessi test). I punti di
cambio, le auto, i depositi arrivano dall'API come dati dell'azienda.

Qui si leggono gli script interi, commenti compresi: sono pochi e i nomi
non servono nemmeno negli esempi. I test (cartella tests/) restano liberi di
usare dati di prova presi da una rete vera."""
import os
import re

CARTELLA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NOMI = re.compile(
    r"ancona|conerobus|\bATMA\b|\bAtma\b|\bAdriabus\b|\bMarche\b"
    r"|\b(Jesi|Falconara|Senigallia|Castelfidardo|Sassoferrato|Osimo|Fabriano|Torrette|Tavernelle|Chiaravalle|Castelferretti|Posatora)\b",
    re.IGNORECASE,
)


def _script():
    for nome in sorted(os.listdir(CARTELLA)):
        if nome.endswith(".py"):
            yield nome


def test_nessun_nome_negli_script():
    trovati = []
    for nome in _script():
        with open(os.path.join(CARTELLA, nome), encoding="utf-8") as f:
            for n, riga in enumerate(f, start=1):
                if NOMI.search(riga):
                    trovati.append(f"{nome}:{n}: {riga.strip()[:120]}")
    assert trovati == []


def test_la_ricerca_trova_davvero():
    assert NOMI.search("# esempio: 43 Ancona→Varano")
    assert NOMI.search("Conerobus S.p.A.")
    assert not NOMI.search("heatmap, flatMap, marchetta")
    assert len(list(_script())) > 5
