import { afterEach, describe, it, expect, vi } from "vitest";
import {
  DIRETTA_VUOTA, FORMATI_ARGOS, MAX_ALLEGATO_MB, applica, autonomiaEffettiva, durata, estensioneDi, imparaAllegato, imparaDiPartenza, peso,
  perchéNonAllegabile,
  quandoFa, riepilogo, sintesiEvento, spezzaSSE, token,
  type EventoTraccia, type EventoStream,
} from "./argos-console";

const ev = (seq: number, tipo: EventoTraccia["tipo"], dati: Record<string, any> = {}): EventoTraccia =>
  ({ seq, tipo, dati, at: "2026-11-22T10:00:00Z" });

describe("lo stream SSE", () => {
  it("eventi completi, battito saltato, pezzo a metà tenuto per dopo", () => {
    const { eventi, resto } = spezzaSSE(': hb\n\ndata: {"run_id":7}\n\ndata: {"t":"Cia');
    expect(eventi).toEqual([{ run_id: 7 }]);
    expect(resto).toBe('data: {"t":"Cia');
    const poi = spezzaSSE(resto + 'o"}\n\n');
    expect(poi.eventi).toEqual([{ t: "Ciao" }]);
  });

  it("righe illeggibili e il padding iniziale non rompono niente", () => {
    const pad = ":" + " ".repeat(4096) + "\n\n";
    const { eventi } = spezzaSSE(pad + "data: {rotto\n\ndata: {\"done\":{\"run_id\":1}}\r\n\r\n");
    expect(eventi).toEqual([{ done: { run_id: 1 } }]);
  });
});

describe("la diretta", () => {
  const passi: EventoStream[] = [
    { run_id: 9 }, { note: "autonomia limitata" }, { t: "Guardo " }, { tool: { name: "ti_lines" } },
    { tool: { name: "ti_lines" } }, { tool_done: { name: "ti_lines", ok: true } }, { tool_done: { name: "ti_lines", ok: false } },
    { reset: true }, { t: "Fatto." },
    { done: { run_id: 9, status: "completed", tokens: 120, proposte: 1, ms: 3000 } },
  ];
  const d = passi.reduce(applica, DIRETTA_VUOTA);

  it("testo ripulito dal reset, note, esiti sulle chiamate giuste, fine", () => {
    expect(d.runId).toBe(9);
    expect(d.testo).toBe("Fatto.");
    expect(d.note).toEqual(["autonomia limitata"]);
    expect(d.strumenti).toEqual([{ nome: "ti_lines", ok: true }, { nome: "ti_lines", ok: false }]);
    expect(d.fine?.status).toBe("completed");
  });

  it("un esito senza chiamata aperta si aggiunge, l'errore resta", () => {
    const e = [{ tool_done: { name: "x", ok: true } }, { error: "Budget mensile esaurito" }].reduce(applica, DIRETTA_VUOTA);
    expect(e.strumenti).toEqual([{ nome: "x", ok: true }]);
    expect(e.errore).toBe("Budget mensile esaurito");
  });
});

describe("il riepilogo della traccia", () => {
  const traccia = [
    ev(1, "avvio", { agente: "pianificatore", modello: "m-deep", fascia: "profondo", strumenti: ["a", "b"] }),
    ev(2, "nota", { testo: "autonomia «applica» limitata a «propone» in questa fase" }),
    ev(3, "strumento", { nome: "ti_lines", modulo: "planning", effetto: "lettura" }),
    ev(4, "esito", { nome: "ti_lines", ok: true, ms: 400, caratteri: 900 }),
    ev(5, "rifiuto", { nome: "ti_shift_trip", motivo: "serve applica" }),
    ev(6, "strumento", { nome: "tpl_search_stops", modulo: "esercizio", effetto: "lettura" }),
    ev(7, "esito", { nome: "tpl_search_stops", ok: false, errore: "timeout", ms: 5000 }),
    ev(8, "fine", { status: "completed", tokens: 3400, proposte: 2, ms: 12000 }),
  ];
  const r = riepilogo(traccia);

  it("conta strumenti, falliti, rifiuti, proposte, token, durata e modello", () => {
    expect(r).toMatchObject({ strumenti: 2, falliti: 1, rifiuti: 1, proposte: 2, token: 3400, ms: 12000, modello: "m-deep", limitata: true });
    expect(r.perModulo).toEqual({ planning: 1, esercizio: 1 });
    expect(r.perStrumento[0]).toEqual({ nome: "tpl_search_stops", volte: 1, ms: 5000, falliti: 1 });
  });

  it("una traccia senza fine (interrotta) non inventa numeri", () => {
    expect(riepilogo(traccia.slice(0, 4))).toMatchObject({ ms: null, token: 0, proposte: 0 });
  });

  it("ogni tipo ha una riga leggibile", () => {
    expect(sintesiEvento(traccia[4]!)).toBe("ti_shift_trip: serve applica");
    expect(sintesiEvento(traccia[6]!)).toBe("tpl_search_stops: timeout");
    expect(sintesiEvento(traccia[2]!)).toBe("ti_lines · Planning Studio · lettura");
    expect(sintesiEvento(traccia[7]!)).toBe("Completata · 3.4k token · 12 s");
  });
});

describe("formati e regole", () => {
  it("durate, token, tempo trascorso", () => {
    expect(durata(450)).toBe("450 ms");
    expect(durata(4200)).toBe("4.2 s");
    expect(durata(125000)).toBe("2 min 5 s");
    expect(durata(null)).toBe("—");
    expect(token(950)).toBe("950");
    expect(token(12500)).toBe("13k");
    expect(token(2_500_000)).toBe("2.5 M");
    const ora = new Date("2026-11-22T12:00:00Z");
    expect(quandoFa("2026-11-22T11:59:30Z", ora)).toBe("adesso");
    expect(quandoFa("2026-11-22T11:00:00Z", ora)).toBe("1 h fa");
    expect(quandoFa("2026-11-21T10:00:00Z", ora)).toBe("ieri");
    expect(quandoFa("non una data", ora)).toBe("—");
  });

  it("in questa fase nessun agente lavora oltre «propone»", () => {
    expect(autonomiaEffettiva("applica")).toBe("propone");
    expect(autonomiaEffettiva("propone")).toBe("propone");
    expect(autonomiaEffettiva("osserva")).toBe("osserva");
  });
});

describe("gli allegati della chat", () => {
  it("l'estensione, senza maiuscole; un nome che comincia col punto non ne ha", () => {
    expect(estensioneDi("Quadro Orario.XLSX")).toBe(".xlsx");
    expect(estensioneDi("archivio.tar.gz")).toBe(".gz");
    expect(estensioneDi(".bashrc")).toBe("");
    expect(estensioneDi("senza")).toBe("");
  });

  it("si allegano i formati che Argos legge, entro la dimensione; il perché quando no", () => {
    for (const n of ["accordo.docx", "turni.xlsx", "slide.pptx", "km.ods", "fermate.csv", "palina.JPG", "norma.pdf"]) {
      expect(perchéNonAllegabile(n, 1000), n).toBeNull();
    }
    expect(perchéNonAllegabile("vecchio.doc", 1000)).toContain(".docx");
    expect(perchéNonAllegabile("vecchio.xls", 1000)).toContain(".xlsx");
    expect(perchéNonAllegabile("virus.exe", 1000)).toContain("non supportato");
    expect(perchéNonAllegabile("vuoto.txt", 0)).toContain("vuoto");
    expect(perchéNonAllegabile("grande.pdf", MAX_ALLEGATO_MB * 1024 * 1024 + 1)).toContain("MB");
    expect(FORMATI_ARGOS).toContain(".xlsx");
    expect(new Set(FORMATI_ARGOS).size).toBe(FORMATI_ARGOS.length);
  });

  it("📚 di partenza i documenti da tenere entrano nella Biblioteca; dati del giorno e immagini no", () => {
    for (const n of ["Accordo.PDF", "regolamento.docx", "slide.pptx", "norma.odt", "appunti.md", "guida.html", "libro.epub"]) {
      expect(imparaDiPartenza(n), n).toBe(true);
    }
    for (const n of ["turni.xlsx", "km.ods", "fermate.csv", "dati.json", "palina.jpg", "schermata.png", "senza"]) {
      expect(imparaDiPartenza(n), n).toBe(false);
    }
  });

  describe("📚 mettere un allegato nella Biblioteca", () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it("chiama la rotta giusta, con i cookie, e restituisce titolo e categoria", async () => {
      const f = vi.fn(async () => new Response(JSON.stringify({ titolo: "Accordo", categoria: "Caricati in chat" }), { status: 200 }));
      vi.stubGlobal("fetch", f);
      await expect(imparaAllegato("c/1", "a 2")).resolves.toEqual({ titolo: "Accordo", categoria: "Caricati in chat" });
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/\/conversazioni\/c%2F1\/allegati\/a%202\/impara$/);
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("include");
    });

    it("il perché del rifiuto arriva a chi ha caricato; senza scrittura un messaggio chiaro", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "contiene dati di persone" }), { status: 400 })));
      await expect(imparaAllegato("c", "a")).rejects.toThrow("dati di persone");
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })));
      await expect(imparaAllegato("c", "a")).rejects.toThrow("permesso di scrittura");
      vi.stubGlobal("fetch", vi.fn(async () => new Response("non json", { status: 502 })));
      await expect(imparaAllegato("c", "a")).rejects.toThrow("HTTP 502");
    });
  });

  it("il peso, all'italiana", () => {
    expect(peso(512)).toBe("512 B");
    expect(peso(1536)).toBe("1,5 kB");
    expect(peso(200 * 1024)).toBe("200 kB");
    expect(peso(3.2 * 1024 * 1024)).toBe("3,2 MB");
    expect(peso(24 * 1024 * 1024)).toBe("24 MB");
  });
});
