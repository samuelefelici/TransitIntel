/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Storico per fermata e per tratta — collaudo
 * ───────────────────────────────────────────────────────────────────────────
 * Questi numeri dicono a un pianificatore dove aggiungere o togliere minuti
 * dall'orario. Una tratta dichiarata "stretta" quando non lo è fa allargare
 * una corsa che andava bene, e quel tempo lo si toglie da qualcos'altro.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from "vitest";
import {
  storicoCorsa, GIORNATE_MINIME,
  type FermataOrario, type TransitoOsservato,
} from "../lib/segment-history";

const TZ = "Europe/Rome";

/** Quattro fermate, otto minuti l'una dall'altra per orario. */
const FERMATE: FermataOrario[] = [
  { seq: 1, stopId: "F1", stopName: "CAPOLINEA",      scheduled: "07:10:00" },
  { seq: 2, stopId: "F2", stopName: "VIA INTERMEDIA", scheduled: "07:18:00" },
  { seq: 3, stopId: "F3", stopName: "OSPEDALE",       scheduled: "07:26:00" },
  { seq: 4, stopId: "F4", stopName: "POSATORA",       scheduled: "07:34:00" },
];

/** Tutti i giorni sono feriali scolastici, salvo quelli elencati altrove. */
const FERIALE = () => ({ key: "scuole_aperte/-/Feriale", label: "Scuole Aperte · Feriale" });

const at = (day: string, hhmmss: string) => new Date(`${day}T${hhmmss}+02:00`);

/** Un transito osservato alla fermata `seq` in quella giornata. */
function tr(day: string, seq: number, hhmmss: string): TransitoOsservato {
  return { day, stopId: `F${seq}`, seq, actualTs: at(day, hhmmss) };
}

const GIORNI = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];

describe("scelta della classe di giornata", () => {
  /* Mediare un feriale scolastico con una domenica descrive un giorno che non
   * esiste: è la stessa regola del verdetto di corsa, alla scala della tratta. */
  it("tiene solo la classe richiesta e ignora le altre giornate", () => {
    const classifica = (d: string) => d === "2026-09-06"
      ? { key: "festivo", label: "Domenica" }
      : FERIALE();

    const transiti = [
      ...GIORNI.flatMap(g => [tr(g, 1, "07:10:00"), tr(g, 2, "07:18:00")]),
      /* La domenica la stessa tratta vola: se entrasse, abbasserebbe la mediana. */
      tr("2026-09-06", 1, "07:10:00"), tr("2026-09-06", 2, "07:13:00"),
    ];

    const s = storicoCorsa(FERMATE, transiti, classifica, "scuole_aperte/-/Feriale", TZ);
    expect(s.giornate).toBe(4);
    expect(s.tratte[0].medianaSec).toBe(480);
    expect(s.tratte[0].giorni).toBe(4);
  });

  it("senza classe indicata sceglie quella con più giornate, e la dichiara", () => {
    const classifica = (d: string) => d >= "2026-09-04"
      ? { key: "festivo", label: "Domenica" }
      : FERIALE();
    const transiti = GIORNI.flatMap(g => [tr(g, 1, "07:10:00"), tr(g, 2, "07:18:00")]);

    const s = storicoCorsa(FERMATE, transiti, classifica, null, TZ);
    expect(s.classe).toBe("scuole_aperte/-/Feriale");
    expect(s.classeLabel).toBe("Scuole Aperte · Feriale");
    expect(s.giornate).toBe(3);
  });
});

describe("verdetto di tratta", () => {
  /* Il caso che serve al pianificatore: la corsa nel complesso ritarda, ma il
   * ritardo nasce tutto su una tratta sola. Allargare le altre sarebbe
   * spostare tempo dove non serve. */
  it("indica la tratta su cui l'orario non regge, non l'intera corsa", () => {
    const transiti = GIORNI.flatMap(g => [
      tr(g, 1, "07:10:00"),
      tr(g, 2, "07:18:00"),   // 8′ come da orario
      tr(g, 3, "07:32:00"),   // 14′ invece di 8′: qui si perde tutto
      tr(g, 4, "07:40:00"),   // 8′ come da orario
    ]);

    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    const critica = s.tratte.find(t => t.daSeq === 2 && t.aSeq === 3)!;
    expect(critica.verdetto).toBe("stretto");
    expect(critica.scartoP85Sec).toBe(360);
    expect(s.tratte.find(t => t.daSeq === 1 && t.aSeq === 2)!.verdetto).toBe("adeguato");
    expect(s.trattaPeggiore?.aNome).toBe("OSPEDALE");
    expect(s.nota).toMatch(/VIA INTERMEDIA → OSPEDALE/);
  });

  it("riconosce il tempo che avanza e lo chiama col suo nome", () => {
    const transiti = GIORNI.flatMap(g => [
      tr(g, 1, "07:10:00"),
      tr(g, 2, "07:14:00"),   // 4′ invece di 8′
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte[0].verdetto).toBe("largo");
    expect(s.nota).toMatch(/avanza/i);
  });

  it("sotto le giornate minime non dà un verdetto, e dice quante ne servono", () => {
    const transiti = GIORNI.slice(0, 2).flatMap(g => [
      tr(g, 1, "07:10:00"), tr(g, 2, "07:30:00"),
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte[0].verdetto).toBe("insufficiente");
    expect(s.tratte[0].motivo).toContain(String(GIORNATE_MINIME));
    /* Il numero c'è comunque: è la sua affidabilità che manca. */
    expect(s.tratte[0].medianaSec).toBe(1200);
  });

  it("senza orario ai due estremi non inventa un termine di confronto", () => {
    const senzaOrari: FermataOrario[] = FERMATE.map(f =>
      f.seq === 2 ? { ...f, scheduled: null } : f);
    const transiti = GIORNI.flatMap(g => [tr(g, 1, "07:10:00"), tr(g, 2, "07:18:00")]);
    const s = storicoCorsa(senzaOrari, transiti, FERIALE, null, TZ);
    expect(s.tratte[0].programmatoSec).toBeNull();
    expect(s.tratte[0].verdetto).toBe("insufficiente");
  });
});

describe("tratte fra fermate non adiacenti", () => {
  /* Con una fermata rilevata su tre, pretendere gli archi adiacenti darebbe
   * una pagina vuota. La misura A→C è vera: va detto che ne scavalca una. */
  it("misura la tratta fra le fermate osservate e dichiara quante ne scavalca", () => {
    const transiti = GIORNI.flatMap(g => [
      tr(g, 1, "07:10:00"),
      tr(g, 3, "07:30:00"),   // F2 mai rilevata
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte).toHaveLength(1);
    expect(s.tratte[0].fermateScavalcate).toBe(1);
    expect(s.tratte[0].programmatoSec).toBe(960);   // 07:10 → 07:26
    expect(s.tratte[0].motivo).toMatch(/scavalca 1 fermata/);
  });

  it("le fermate mai rilevate restano in elenco, con zero giornate", () => {
    const transiti = GIORNI.flatMap(g => [tr(g, 1, "07:10:00"), tr(g, 3, "07:26:00")]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    const f2 = s.fermate.find(f => f.stopId === "F2")!;
    expect(f2.giorni).toBe(0);
    expect(f2.scartoMedianoSec).toBeNull();
    expect(s.fermate).toHaveLength(4);
  });
});

describe("scarto per fermata", () => {
  it("misura dove il ritardo si accumula, fermata per fermata", () => {
    const transiti = GIORNI.flatMap(g => [
      tr(g, 1, "07:10:00"),   // in orario
      tr(g, 2, "07:20:00"),   // +2′
      tr(g, 3, "07:32:00"),   // +6′
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.fermate.find(f => f.seq === 1)!.scartoMedianoSec).toBe(0);
    expect(s.fermate.find(f => f.seq === 2)!.scartoMedianoSec).toBe(120);
    expect(s.fermate.find(f => f.seq === 3)!.scartoMedianoSec).toBe(360);
  });

  it("riporta anche il caso peggiore, non solo quello tipico", () => {
    const transiti = [
      ...GIORNI.map(g => tr(g, 2, "07:18:00")),
      tr("2026-09-05", 2, "07:33:00"),   // una giornata storta
    ];
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    const f2 = s.fermate.find(f => f.seq === 2)!;
    expect(f2.scartoMedianoSec).toBe(0);
    expect(f2.scartoMaxSec).toBe(900);
  });
});

describe("letture sporche", () => {
  it("scarta una tratta percorsa all'indietro invece di dichiararla larghissima", () => {
    const transiti = GIORNI.flatMap(g => [
      tr(g, 2, "07:18:00"),
      { ...tr(g, 3, "07:17:00") },   // arriva prima di essere partito
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte).toHaveLength(0);
    expect(s.nota).toMatch(/nessuna coppia di fermate/i);
  });

  it("una seconda lettura allo stesso capolinea non conta come seconda sosta", () => {
    const transiti = GIORNI.flatMap(g => [
      tr(g, 1, "07:10:00"),
      tr(g, 1, "07:12:00"),   // il mezzo è ancora lì
      tr(g, 2, "07:18:00"),
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte).toHaveLength(1);
    expect(s.tratte[0].medianaSec).toBe(480);
  });

  it("un transito su una fermata che non appartiene alla corsa viene ignorato", () => {
    const transiti = [
      ...GIORNI.flatMap(g => [tr(g, 1, "07:10:00"), tr(g, 2, "07:18:00")]),
      { day: GIORNI[0], stopId: "ALTRA", seq: 99, actualTs: at(GIORNI[0], "07:15:00") },
    ];
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte).toHaveLength(1);
    expect(s.fermate).toHaveLength(4);
  });

  /* Il progressivo non c'è sempre: allora la fermata si riconosce dall'id. */
  it("aggancia la fermata dall'identificativo quando il progressivo manca", () => {
    const transiti = GIORNI.flatMap(g => [
      { day: g, stopId: "F1", seq: null, actualTs: at(g, "07:10:00") },
      { day: g, stopId: "F2", seq: null, actualTs: at(g, "07:18:00") },
    ]);
    const s = storicoCorsa(FERMATE, transiti, FERIALE, null, TZ);
    expect(s.tratte).toHaveLength(1);
    expect(s.tratte[0].daSeq).toBe(1);
  });
});

describe("elenco vuoto", () => {
  it("su una classe senza transiti lo dice invece di restituire zeri", () => {
    const s = storicoCorsa(FERMATE, [], FERIALE, null, TZ);
    expect(s.giornate).toBe(0);
    expect(s.tratte).toHaveLength(0);
    expect(s.nota).toMatch(/nessun transito/i);
  });

  it("chiedendo una classe mai osservata lo dice, senza fingere l'assenza di dati", () => {
    const transiti = GIORNI.map(g => tr(g, 1, "07:10:00"));
    const s = storicoCorsa(FERMATE, transiti, FERIALE, "festivo", TZ);
    expect(s.classe).toBe("festivo");
    expect(s.nota).toMatch(/classe di giornata scelta/i);
  });
});
