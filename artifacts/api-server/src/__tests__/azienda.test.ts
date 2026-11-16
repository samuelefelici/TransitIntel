/* I dati dell'azienda (PR 2.17a, lib/azienda.ts e /api/admin/azienda). Il
 * database è finto: tiene una riga di public.azienda (o nessuna) e quello che
 * gli si chiede.
 * - tabella vuota = installazione nuova: valori neutri, mai quelli di un'altra azienda;
 * - la riga resta in memoria un minuto, e un salvataggio la fa rileggere;
 * - la scrive solo l'amministratore, con i soli campi previsti e validi;
 * - nome e città diventano parole vietate nelle password;
 * - il GTFS esce con i dati dell'azienda, e ogni campo è protetto nel CSV.
 * Sul database vero lo prova azienda-db.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";

const F = vi.hoisted(() => {
  const CONEROBUS = {
    ragione_sociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411",
    gtfs_agency_id: "conerobus", citta: "Ancona", regione: "Marche", centro_lat: 43.58, centro_lng: 13.45, zoom: 10,
    aggiornata_il: "2026-11-13T08:00:00.000Z", aggiornata_da: "Ada Admin",
  };
  const s = { riga: null as any, chieste: [] as Array<{ testo: string; valori: unknown[] }>, errore: null as any };
  const client = {
    async query(cfg: any, valori?: unknown[]) {
      const testo: string = (typeof cfg === "string" ? cfg : cfg.text).replace(/\s+/g, " ").toLowerCase();
      const v = (valori ?? cfg?.values ?? []) as unknown[];
      s.chieste.push({ testo, valori: v });
      if (s.errore) throw s.errore;
      if (testo.includes("insert into azienda")) {
        s.riga = {
          ragione_sociale: v[0], nome: v[1], sito: v[2], telefono: v[3], gtfs_agency_id: v[4], citta: v[5], regione: v[6],
          centro_lat: v[7], centro_lng: v[8], zoom: v[9], aggiornata_il: "2026-11-13T09:00:00.000Z", aggiornata_da: "Ada Admin",
        };
        return { rows: [], rowCount: 1, fields: [] };
      }
      const righe = testo.includes("from azienda") && s.riga ? [s.riga] : [];
      return { rows: righe, rowCount: righe.length, fields: [] };
    },
  };
  return { CONEROBUS, s, client };
});

vi.mock("@workspace/db", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  return { ...schema, db: drizzle(F.client as any, { schema }), pool: { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() } };
});

import adminRouter from "../routes/admin";
import {
  AZIENDA_DA_COMPILARE, DatiAzienda, aziendaOppureNeutra, dimenticaAzienda, erroriDiValidazione, leggiAzienda,
  paroleDellAzienda, paroleVietateDellAzienda,
} from "../lib/azienda";
import { gtfsDellAzienda } from "../routes/scenarios";
import { erroreNuovaPassword } from "../lib/password-regole";
import { decidi } from "../lib/permessi-rotte";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const admin = () => appDiProva(adminRouter, utenteDiProva("ada", [], "admin"));
const letture = () => F.s.chieste.filter(c => c.testo.includes("from azienda"));
const BUONI = {
  ragioneSociale: "Trasporti Esempio S.r.l.", nome: "Esempio", sito: "https://www.esempio.it", telefono: "+39 0721 000000",
  gtfsAgencyId: "esempio", citta: "Pesaro", regione: "Marche", centroLat: 43.91, centroLng: 12.91, zoom: 11,
};

beforeEach(() => { F.s.riga = { ...F.CONEROBUS }; F.s.chieste = []; F.s.errore = null; dimenticaAzienda(); });
afterEach(() => { vi.useRealTimers(); });

describe("leggiAzienda", () => {
  it("dà la riga della tabella, e la tiene in memoria per un minuto", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T10:00:00Z") });
    const a = await leggiAzienda();
    expect(a).toEqual({
      ragioneSociale: "Conerobus S.p.A.", nome: "Conerobus", sito: "https://www.conerobus.it", telefono: "+39 071 2837411",
      gtfsAgencyId: "conerobus", citta: "Ancona", regione: "Marche", centro: { lat: 43.58, lng: 13.45, zoom: 10 }, compilata: true,
    });
    await leggiAzienda(); await leggiAzienda();
    expect(letture()).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-13T10:01:01Z"));
    await leggiAzienda();
    expect(letture()).toHaveLength(2);
  });

  it("tabella vuota: i valori neutri di un'installazione nuova, non quelli di un'altra azienda", async () => {
    F.s.riga = null;
    const a = await leggiAzienda();
    expect(a).toEqual(AZIENDA_DA_COMPILARE);
    expect(a.compilata).toBe(false);
    expect(JSON.stringify(a).toLowerCase()).not.toMatch(/conerobus|ancona/);
  });

  it("se il database non risponde vale l'ultima lettura; senza, l'errore sale", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-13T10:00:00Z") });
    await leggiAzienda();
    vi.setSystemTime(new Date("2026-11-13T10:05:00Z"));
    F.s.errore = new Error("connessione persa");
    expect((await leggiAzienda()).nome).toBe("Conerobus");
    dimenticaAzienda();
    await expect(leggiAzienda()).rejects.toThrow();
    // le etichette e le regole delle password non fermano la richiesta
    expect(await aziendaOppureNeutra()).toEqual(AZIENDA_DA_COMPILARE);
    expect(await paroleVietateDellAzienda()).toEqual([]);
  });
});

describe("quello che l'amministratore può salvare", () => {
  it("i campi previsti, puliti: spazi tolti, i facoltativi vuoti diventano «nessuno»", () => {
    const p = DatiAzienda.parse({ ...BUONI, nome: "  Esempio  ", sito: "", telefono: "   ", regione: null });
    expect(p).toMatchObject({ nome: "Esempio", sito: null, telefono: null, regione: null, centroLat: 43.91 });
  });

  it("rifiuta quello che finirebbe male in un CSV, in un link o sulla mappa", () => {
    const no = (extra: Record<string, unknown>, cosa: RegExp) => {
      const r = DatiAzienda.safeParse({ ...BUONI, ...extra });
      expect(r.success, JSON.stringify(extra)).toBe(false);
      if (!r.success) expect(erroriDiValidazione(r.error)).toMatch(cosa);
    };
    no({ sito: "javascript:alert(1)" }, /^Sito:/);
    no({ sito: "https://esempio.it,altro" }, /^Sito:/);
    no({ sito: "https://esempio.it/a b" }, /^Sito:/);
    no({ sito: "ftp://esempio.it" }, /^Sito:/);
    no({ telefono: "0721 00 00 <script>" }, /^Telefono:/);
    no({ gtfsAgencyId: "esempio,1" }, /^Identificativo GTFS:/);
    no({ gtfsAgencyId: "" }, /^Identificativo GTFS:/);
    no({ nome: "   " }, /^Nome:/);
    no({ nome: "x".repeat(41) }, /^Nome:/);
    no({ ragioneSociale: "Esempio\nS.r.l." }, /^Ragione sociale:/);
    no({ citta: "" }, /^Città:/);
    no({ centroLat: 91 }, /^Latitudine:/);
    no({ centroLng: -181 }, /^Longitudine:/);
    no({ zoom: 2 }, /^Zoom:/);
    no({ zoom: "10" }, /^Zoom:/);
    no({ unica: false }, /Campo non previsto: unica/);
    no({ aggiornataDa: "qualcuno" }, /Campo non previsto: aggiornataDa/);
  });
});

describe("GET e PUT /api/admin/azienda", () => {
  it("solo l'amministratore", async () => {
    for (const utente of [null, utenteDiProva("ugo", ["network", "scheduling", "roster", "personale"]), utenteDiProva("pia", [], "user", { ruoli: ["amministrazione"] })]) {
      const app = appDiProva(adminRouter, utente);
      expect((await request(app).get("/api/admin/azienda")).status).toBe(utente ? 403 : 401);
      expect((await request(app).put("/api/admin/azienda").send(BUONI)).status).toBe(utente ? 403 : 401);
    }
    expect(F.s.chieste).toHaveLength(0);
    // e fuori da lì: per chi non è admin la voce è «Solo admin», non un percorso dimenticato
    const pia = utenteDiProva("pia", [], "user", { ruoli: ["amministrazione"] });
    expect(decidi({ admin: false, diritti: pia.diritti }, "PUT", "/admin/azienda")).toEqual({ passa: false, errore: "Solo admin" });
  });

  it("la lettura dà la riga, quando è stata salvata e da chi", async () => {
    const r = await request(admin()).get("/api/admin/azienda");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ azienda: { nome: "Conerobus", citta: "Ancona", compilata: true }, aggiornataIl: "2026-11-13T08:00:00.000Z", aggiornataDa: "Ada Admin" });
    F.s.riga = null;
    const vuota = await request(admin()).get("/api/admin/azienda");
    expect(vuota.body).toEqual({ azienda: { ...AZIENDA_DA_COMPILARE }, aggiornataIl: null, aggiornataDa: null });
  });

  it("il salvataggio scrive la riga con chi l'ha salvata, e la fa rileggere a tutti", async () => {
    expect((await leggiAzienda()).nome).toBe("Conerobus");
    const ada = utenteDiProva("a0000000-0000-4000-8000-0000000000a1", [], "admin");
    const r = await request(appDiProva(adminRouter, ada)).put("/api/admin/azienda").send(BUONI);
    expect(r.status).toBe(200);
    expect(r.body.azienda).toMatchObject({ ragioneSociale: "Trasporti Esempio S.r.l.", nome: "Esempio", citta: "Pesaro", centro: { lat: 43.91, lng: 12.91, zoom: 11 } });
    const scrittura = F.s.chieste.find(c => c.testo.includes("insert into azienda"))!;
    expect(scrittura.testo).toContain("on conflict (unica) do update");
    expect(scrittura.valori).toEqual(["Trasporti Esempio S.r.l.", "Esempio", "https://www.esempio.it", "+39 0721 000000", "esempio", "Pesaro", "Marche", 43.91, 12.91, 11, ada.id]);
    // senza aspettare il minuto: la prossima lettura è già quella nuova
    expect((await leggiAzienda()).nome).toBe("Esempio");
  });

  it("un valore che non va non arriva al database, e il messaggio dice quale campo", async () => {
    const r = await request(admin()).put("/api/admin/azienda").send({ ...BUONI, sito: "javascript:alert(1)", zoom: 40 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Sito: .*Zoom: /);
    expect((await request(admin()).put("/api/admin/azienda").send({ ...BUONI, ruolo: "admin" })).body.error).toBe("Campo non previsto: ruolo");
    expect((await request(admin()).put("/api/admin/azienda").send([])).status).toBe(400);
    expect(F.s.chieste.filter(c => c.testo.includes("insert into azienda"))).toHaveLength(0);
  });

  it("un vincolo della tabella che la validazione non ha fermato è un 400, non un errore del server", async () => {
    F.s.errore = Object.assign(new Error("violates check constraint"), { code: "23514" });
    const r = await request(admin()).put("/api/admin/azienda").send(BUONI);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Uno dei valori non è ammesso" });
  });
});

describe("le parole dell'azienda nelle password", () => {
  const conerobus = { nome: "Conerobus", ragioneSociale: "Conerobus S.p.A.", citta: "Ancona", compilata: true };

  it("nome, ragione sociale e città, parola per parola e attaccate; mai le sigle corte", () => {
    expect(paroleDellAzienda(conerobus)).toEqual(expect.arrayContaining(["conerobus", "ancona"]));
    expect(paroleDellAzienda(conerobus)).not.toContain("spa");
    const due = paroleDellAzienda({ nome: "TPL Reggio", ragioneSociale: "Trasporti Reggio Emilia S.r.l.", citta: "Reggio nell'Emilia", compilata: true });
    expect(due).toEqual(expect.arrayContaining(["reggio", "emilia", "trasporti", "tplreggio", "reggionellemilia"]));
    expect(due).not.toContain("tpl");
    expect(due).not.toContain("srl");
    // un'installazione ancora da compilare non vieta «azienda»
    expect(paroleDellAzienda({ ...AZIENDA_DA_COMPILARE })).toEqual([]);
  });

  it("la regola delle password le usa: quelle di questa azienda, non di un'altra", async () => {
    const parole = await paroleVietateDellAzienda();
    expect(erroreNuovaPassword("Conerobus2026!", {}, parole)).toMatch(/ovvia/);
    expect(erroreNuovaPassword("Ancona Ancona 1", {}, parole)).toMatch(/ovvia/);
    expect(erroreNuovaPassword("conerobus e la luna piena", {}, parole)).toBeNull();
    const altra = paroleDellAzienda({ nome: "Esempio", ragioneSociale: "Trasporti Esempio S.r.l.", citta: "Pesaro", compilata: true });
    expect(erroreNuovaPassword("Pesaro-2026!!", {}, altra)).toMatch(/ovvia/);
    expect(erroreNuovaPassword("Conerobus2026!", {}, altra)).toBeNull();
    // le parole ovvie valgono sempre
    expect(erroreNuovaPassword("Cerbero Cerbero 1", {}, altra)).toMatch(/ovvia/);
  });
});

describe("la sessione porta l'azienda", () => {
  /* La web la legge da due risposte: il login (chi entra in un browser che non
   * ha mai visto Cerbero) e /auth/me (chi ricarica). Se una delle due la perde,
   * la barra laterale e le mappe restano coi valori neutri fino al caricamento
   * dopo: è successo scrivendo questa PR, e l'ha trovato solo il browser. */
  it("sia nella risposta del login sia in /auth/me", () => {
    const auth = readFileSync(path.join(__dirname, "../lib/auth.ts"), "utf8");
    expect(auth.match(/azienda: aziendaPerLaWeb\(await aziendaOppureNeutra\(\)\)/g)).toHaveLength(2);
    const accesso = auth.slice(auth.indexOf("async function apriSessione("), auth.indexOf("router.post(\"/auth/login\""));
    expect(accesso).toContain("azienda: aziendaPerLaWeb(");
    const me = auth.slice(auth.indexOf("router.get(\"/auth/me\""));
    expect(me.slice(0, 900)).toContain("azienda: aziendaPerLaWeb(");
  });
});

describe("il GTFS con i dati dell'azienda", () => {
  it("agency e feed_info vengono dalla riga", async () => {
    expect(gtfsDellAzienda(await leggiAzienda())).toEqual({
      agencyId: "conerobus", agencyName: "Conerobus S.p.A.", agencyUrl: "https://www.conerobus.it",
      agencyTimezone: "Europe/Rome", agencyLang: "it", agencyPhone: "+39 071 2837411",
      feedPublisherName: "Conerobus S.p.A.", feedPublisherUrl: "https://www.conerobus.it", feedLang: "it",
    });
  });

  it("senza sito né telefono: l'indirizzo segnaposto (agency_url è obbligatorio) e il telefono vuoto", () => {
    expect(gtfsDellAzienda(AZIENDA_DA_COMPILARE)).toMatchObject({
      agencyId: "azienda", agencyName: "Azienda di trasporto", agencyUrl: "https://example.com", agencyPhone: "",
    });
  });
});
