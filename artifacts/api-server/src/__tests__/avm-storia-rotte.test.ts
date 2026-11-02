/* Le rotte dell'andamento AVM (routes/avm-storia.ts) con lo store e
 * FleetCare finti: la forma del JSON, le chiusure automatiche scritte,
 * FleetCare che manca, l'Excel senza nomi, la validazione delle richieste. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { inflateRawSync } from "node:zlib";

const stato = vi.hoisted(() => ({
  campioni: new Map<string, number>(),
  vetture: [] as Array<{ vehicleRef: string; giorni: string[]; esiti: string }>,
  richieste: [] as any[],
  verifiche: [] as Array<{ id: string; chiusaIl: string }>,
  create: [] as any[],
  chiuse: [] as any[],
  parco: null as any,
  errore: null as string | null,
}));

vi.mock("../lib/avm-storia-store", () => ({
  leggiStoriaDiario: vi.fn(async () => ({ campioni: stato.campioni, vetture: stato.vetture, errore: stato.errore })),
  leggiRichieste: vi.fn(async () => ({ richieste: stato.richieste, errore: null })),
  registraVerifiche: vi.fn(async (c: any[]) => { stato.verifiche.push(...c); return c.length; }),
  pulisciRichieste: vi.fn(async () => 0),
  creaRichieste: vi.fn(async (n: any) => { stato.create.push(n); return { create: n.matricole.slice(1), giaAperte: n.matricole.slice(0, 1) }; }),
  chiudiRichieste: vi.fn(async (ids: string[], esito: string, utenteId: string | null) => { stato.chiuse.push({ ids, esito, utenteId }); return ids; }),
}));
vi.mock("../lib/officina", async (importOriginal) => {
  const vero = await importOriginal<typeof import("../lib/officina")>();
  return {
    ...vero,
    leggiParcoOfficina: vi.fn(async () => stato.parco),
    leggiInterventiAvm: vi.fn(async () => ({ disponibile: true, motivo: null, elenco: [] })),
  };
});

import router from "../routes/avm-storia";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";
import { spostaGiorni } from "../lib/avm-controllo";

const U = utenteDiProva("10000000-0000-0000-0000-00000000000c", ["centrale"]);
const app = () => appDiProva(router, U);

/** Oggi è mercoledì 4/11/2026 alle 10 (giornata di esercizio 2026-11-04). */
const ORA = new Date("2026-11-04T09:00:00Z");

function giorniDa(da: string, a: string): string[] {
  const out: string[] = [];
  for (let g = da; g <= a; g = spostaGiorni(g, 1)) out.push(g);
  return out;
}

const mezzo = (matricola: string, extra: Record<string, unknown> = {}) => ({
  matricola, numeroDiParco: matricola.padStart(4, "0"), targa: `AA${matricola}`, stato: "in_servizio", deposito: "Ancona",
  modello: null, fermoDal: null, fermoMotivo: null, commessa: null, segnalazioneAvm: null, ...extra,
});

function voci(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const comp = buf.readUInt32LE(i + 18);
    const nomeLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nome = buf.subarray(i + 30, i + 30 + nomeLen).toString("utf8");
    const inizio = i + 30 + nomeLen + extraLen;
    out.set(nome, inflateRawSync(buf.subarray(inizio, inizio + comp)).toString("utf8"));
    i = inizio + comp;
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ORA);
  const giorni = giorniDa("2026-10-05", "2026-11-03");
  stato.campioni = new Map(giorni.map(g => [g, 720]));
  stato.vetture = [
    { vehicleRef: "10", giorni, esiti: "3".repeat(giorni.length) },            // funziona
    { vehicleRef: "11", giorni, esiti: "3".repeat(14) + "2".repeat(giorni.length - 14) }, // da riparare
    { vehicleRef: "12", giorni, esiti: "0".repeat(giorni.length) },            // fuori parco: da togliere
    { vehicleRef: "13", giorni: giorni.filter(g => g < "2026-10-30"), esiti: "3".repeat(25) }, // tolta dal 30/10
    /* il resto del flusso (consorziate, che non pesano sul confronto col parco): una vettura che manca è una vettura tolta, non una risposta parziale */
    ...Array.from({ length: 10 }, (_, i) => ({ vehicleRef: String(11100 + i), giorni, esiti: "3".repeat(giorni.length) })),
  ];
  stato.parco = { disponibile: true, motivo: null, tenant: "conerobus", lettoAlle: ORA.toISOString(),
    mezzi: [mezzo("10"), mezzo("11"), mezzo("13", { stato: "dismesso" }), mezzo("14")] };
  stato.richieste = [
    { id: "00000000-0000-4000-8000-000000000001", vehicleRef: "13", tipo: "togliere", richiestaIl: "2026-10-28", nota: null,
      creataIl: "2026-10-28T08:00:00Z", creataDa: "Mario Rossi", esito: null, chiusaIl: null, chiusaDa: null, automatica: false },
    { id: "00000000-0000-4000-8000-000000000002", vehicleRef: "14", tipo: "aggiungere", richiestaIl: "2026-10-28", nota: "chiesto per mail",
      creataIl: "2026-10-28T08:00:00Z", creataDa: "Mario Rossi", esito: null, chiusaIl: null, chiusaDa: null, automatica: false },
  ];
  stato.verifiche = []; stato.create = []; stato.chiuse = []; stato.errore = null;
});
afterEach(() => { vi.useRealTimers(); });

describe("GET /siri/parco/storia", () => {
  it("l'andamento, le azioni, i testi per Mizar; chiude da sola la richiesta che il diario dimostra", async () => {
    const r = await request(app()).get("/api/siri/parco/storia");
    expect(r.status).toBe(200);
    expect(r.body.oggi).toBe("2026-11-04");
    expect(r.body.ultimaChiusa).toBe("2026-10-26");
    expect(r.body.settimane[0].lunedi).toBe("2026-10-05");
    const azione = Object.fromEntries(r.body.vetture.map((v: any) => [v.vehicleRef, v.azione]));
    expect(azione).toMatchObject({
      "10": "funziona", "11": "da_riparare", "12": "da_togliere_da_siri", "13": "gia_tolta", "14": "da_aggiungere_a_siri",
    });
    /* la 13 è sparita dal 30/10: tre giornate contate di assenza → fatta il 30/10 */
    expect(stato.verifiche).toEqual([{ id: "00000000-0000-4000-8000-000000000001", chiusaIl: "2026-10-30" }]);
    const r13 = r.body.richieste.find((x: any) => x.vehicleRef === "13");
    expect(r13).toMatchObject({ esito: "fatta", chiusaIl: "2026-10-30", automatica: true });
    /* la 14 ha già una richiesta aperta: il testo per Mizar chiede solo la 12 da togliere, niente da aggiungere */
    expect(r.body.testiMizar.togliere.matricole).toEqual(["12"]);
    expect(r.body.testiMizar.aggiungere).toBeNull();
    expect(r.body.officina).toMatchObject({ disponibile: true, mezzi: 4 });
    expect(r.body.soglie.settimaneSilenzioAlienata).toBe(4);
    expect(JSON.stringify(r.body)).not.toContain("10000000-0000-0000-0000-00000000000c");
  });

  it("senza FleetCare: le liste dell'officina restano vuote e si dice perché", async () => {
    stato.parco = { disponibile: false, motivo: "FleetCare non espone ancora il parco.", tenant: null, lettoAlle: ORA.toISOString(), mezzi: [] };
    const r = await request(app()).get("/api/siri/parco/storia");
    expect(r.status).toBe(200);
    expect(r.body.officina).toMatchObject({ disponibile: false, motivo: "FleetCare non espone ancora il parco." });
    expect(r.body.conteggi.da_togliere_da_siri + r.body.conteggi.da_aggiungere_a_siri + r.body.conteggi.da_verificare_alienata).toBe(0);
  });

  it("diario non leggibile: 503, niente liste (il parco intero sembrerebbe da aggiungere)", async () => {
    stato.errore = "connessione chiusa";
    stato.vetture = []; stato.campioni = new Map();
    const r = await request(app()).get("/api/siri/parco/storia");
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/diario dell'AVM non si legge/);
    expect((await request(app()).get("/api/siri/parco/storia?formato=xlsx")).status).toBe(503);
    expect(stato.verifiche).toEqual([]);
  });

  it("diario senza vetture Conerobus: il parco non si confronta, niente da aggiungere", async () => {
    const giorni = giorniDa("2026-10-05", "2026-11-03");
    stato.vetture = [{ vehicleRef: "11096", giorni, esiti: "3".repeat(giorni.length) }];
    const r = await request(app()).get("/api/siri/parco/storia");
    expect(r.status).toBe(200);
    expect(r.body.officina.disponibile).toBe(false);
    expect(r.body.conteggi.da_aggiungere_a_siri).toBe(0);
    expect(r.body.testiMizar.aggiungere).toBeNull();
  });

  it("l'Excel con «solo parco officina» toglie le alienate solo dall'andamento, non dai fogli delle azioni", async () => {
    stato.richieste.push({ id: "00000000-0000-4000-8000-000000000003", vehicleRef: "12", tipo: "togliere", richiestaIl: "2026-11-02",
      nota: "chiesta il 2/11", creataIl: "2026-11-02T08:00:00Z", creataDa: null, esito: null, chiusaIl: null, chiusaDa: null, automatica: false });
    const r = await request(app()).get("/api/siri/parco/storia?formato=xlsx&perimetro=conerobus&officina=1")
      .buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", (c: Buffer) => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
    const v = voci(r.body as Buffer);
    const wb = v.get("xl/workbook.xml")!;
    const fogli = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
    const foglio = (nome: string) => v.get(`xl/worksheets/sheet${fogli.indexOf(nome) + 1}.xml`) ?? "";
    expect(foglio("Da togliere da SIRI")).toContain(">12<");
    expect(foglio("Richieste a Mizar")).toContain("chiesta il 2/11");
    expect(foglio("Riepilogo")).toContain("andamento senza fuori parco e dismesse");
  });

  it("l'Excel: i fogli delle azioni e delle richieste, senza i nomi di chi le ha segnate", async () => {
    const r = await request(app()).get("/api/siri/parco/storia?formato=xlsx&perimetro=conerobus&officina=1")
      .buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", (c: Buffer) => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/spreadsheetml/);
    const buf = r.body as Buffer;
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const v = voci(buf);
    const wb = v.get("xl/workbook.xml")!;
    for (const nome of ["Riepilogo", "Da riparare", "Da togliere da SIRI", "Da aggiungere a SIRI", "Da verificare", "Richieste a Mizar", "Tutte"]) {
      expect(wb).toContain(`name="${nome}"`);
    }
    const tutto = [...v.values()].join("\n");
    expect(tutto).not.toContain("Mario Rossi");
    expect(tutto).toContain("chiesto per mail");
  });
});

describe("POST /siri/parco/richieste", () => {
  const post = (body: unknown) => request(app()).post("/api/siri/parco/richieste").send(body as any);

  it("segna le richieste con l'utente e dice quali erano già aperte", async () => {
    const r = await post({ tipo: "togliere", matricole: ["12", "15", "15"], nota: "mail del 4/11" });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ create: ["15"], giaAperte: ["12"] });
    expect(stato.create[0]).toMatchObject({
      tipo: "togliere", matricole: ["12", "15"], richiestaIl: "2026-11-04", nota: "mail del 4/11", utenteId: U.id,
    });
  });

  it("rifiuta con un messaggio in italiano", async () => {
    const casi: Array<[unknown, RegExp]> = [
      [{ tipo: "rimuovere", matricole: ["12"] }, /«togliere» o «aggiungere»/],
      [{ tipo: "togliere", matricole: [] }, /almeno una matricola/],
      [{ tipo: "togliere", matricole: ["12a"] }, /numero di 1-5 cifre/],
      [{ tipo: "togliere", matricole: Array.from({ length: 301 }, (_, i) => String(i + 1)) }, /300 matricole/],
      [{ tipo: "togliere", matricole: ["12"], richiestaIl: "2026-11-05" }, /futuro/],
      [{ tipo: "togliere", matricole: ["12"], richiestaIl: "2026-07-01" }, /90 giorni/],
      [{ tipo: "togliere", matricole: ["12"], richiestaIl: "2026-02-30" }, /AAAA-MM-GG/],
      [{ tipo: "togliere", matricole: ["12"], nota: "x".repeat(501) }, /500 caratteri/],
      [{ tipo: "togliere", matricole: ["12"], altro: 1 }, /./],
    ];
    for (const [body, msg] of casi) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    expect(stato.create).toEqual([]);
  });

  it("vuole JSON", async () => {
    const r = await request(app()).post("/api/siri/parco/richieste").type("form").send("tipo=togliere");
    expect(r.status).toBe(415);
  });
});

describe("POST /siri/parco/richieste/chiudi", () => {
  it("annulla o segna fatta a mano, con l'utente", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    const r = await request(app()).post("/api/siri/parco/richieste/chiudi").send({ ids: [id], esito: "annullata" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chiuse: [id] });
    expect(stato.chiuse[0]).toEqual({ ids: [id], esito: "annullata", utenteId: U.id });
  });

  it("rifiuta id che non sono richieste e esiti sconosciuti", async () => {
    expect((await request(app()).post("/api/siri/parco/richieste/chiudi").send({ ids: ["1; DROP"], esito: "fatta" })).status).toBe(400);
    expect((await request(app()).post("/api/siri/parco/richieste/chiudi")
      .send({ ids: ["00000000-0000-4000-8000-000000000002"], esito: "riaperta" })).status).toBe(400);
    expect(stato.chiuse).toEqual([]);
  });
});
