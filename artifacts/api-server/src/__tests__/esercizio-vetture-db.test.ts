/**
 * Le vetture sui turni macchina del giorno (tappa 5.4, migrazione 0033) su un
 * database vero (TEST_DATABASE_URL; in CI come cerbero_app): assegnare,
 * cambiare, togliere; la giornata chiusa non si tocca; il turno sparito
 * lascia l'assegnazione «da riassegnare»; il capo deposito scrive solo sui
 * suoi; alla conferma la corsa senza vettura dall'AVM prende quella del turno.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import rosterRouter from "../routes/roster";
import { registraEvento } from "../lib/esercizio-giornale";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const u = (n: number) => `e5400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [ADMIN, CAPO, VSS] = [u(1), u(2), u(3)];
const [G, CHIUSA, VUOTA] = ["2032-06-22", "2032-06-23", "2032-06-24"];
const admin = request(appDiProva(rosterRouter, utenteDiProva(ADMIN, [], "admin")));
const capo = request(appDiProva(rosterRouter, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["jesi"] })));
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;

const metti = (chi: typeof admin, turnoMacchina: string, vettura: string, giorno = G) =>
  chi.put("/api/roster/vetture").send({ giorno, vssId: VSS, turnoMacchina, vettura });
const togli = (chi: typeof admin, turnoMacchina: string, giorno = G) =>
  chi.delete(`/api/roster/vetture?giorno=${giorno}&vssId=${VSS}&turnoMacchina=${turnoMacchina}`);
const leggi = async (chi: typeof admin = admin, giorno = G) => {
  const r = await chi.get(`/api/roster/vetture?giorno=${giorno}`);
  expect(r.status).toBe(200);
  return r.body;
};

describe.runIf(!!process.env.TEST_DATABASE_URL)("le vetture sui turni macchina, sul database", () => {
  const pulisci = async () => {
    await db.execute(sql`DELETE FROM esercizio_vetture WHERE vss_id = ${VSS}::uuid`);
    await db.execute(sql`DELETE FROM esercizio_eventi WHERE giorno IN (${G}::date, ${CHIUSA}::date)`);
    await db.execute(sql`DELETE FROM esercizio_giornate WHERE giorno IN (${G}::date, ${CHIUSA}::date)`);
    await db.execute(sql`DELETE FROM users WHERE id IN (${ADMIN}::uuid, ${CAPO}::uuid)`);
  };
  beforeAll(async () => {
    await pulisci();
    await db.execute(sql`INSERT INTO users (id, email, password_hash, role, full_name) VALUES
      (${ADMIN}::uuid, 'vetture-admin@prova.local', 'x', 'admin', 'Amministrazione di prova'),
      (${CAPO}::uuid, 'vetture-capo@prova.local', 'x', 'user', 'Capo deposito di prova')`);
    await db.execute(sql`INSERT INTO esercizio_giornate (giorno, stato, corse, preparata_il, congelata_il, chiusa_il, riepilogo, turni) VALUES
      (${G}::date, 'congelata', 3, now(), now(), NULL, NULL, '{}'::jsonb),
      (${CHIUSA}::date, 'chiusa', 0, now(), now(), now(), '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`INSERT INTO esercizio_turni_macchina (giorno, vss_id, turno_macchina, deposito, tipo_mezzo, uscita, rientro, corse, corse_nel_giorno, km_vuoto_prog) VALUES
      (${G}::date, ${VSS}::uuid, 'M1', 'Deposito di Jesi', '12m', '05:00', '09:30', 2, 2, 1),
      (${G}::date, ${VSS}::uuid, 'M2', 'Ancona', '12m', '09:00', '13:00', 1, 1, 1),
      (${G}::date, ${VSS}::uuid, 'M3', 'Deposito di Jesi', '12m', '05:30', '08:00', 1, 1, 1),
      (${CHIUSA}::date, ${VSS}::uuid, 'M1', 'Deposito di Jesi', '12m', '05:00', '09:30', 0, 0, 1)`);
    await db.execute(sql`INSERT INTO esercizio_corse (giorno, chiave, numero, vss_id, turno_macchina, km_prog, proposta, prove) VALUES
      (${G}::date, 'v54-1', '1', ${VSS}::uuid, 'M1', 10, 'non_rilevata', '{"vetture": []}'::jsonb),
      (${G}::date, 'v54-2', '2', ${VSS}::uuid, 'M1', 10, 'effettuata_avm', '{"vetture": ["305"]}'::jsonb),
      (${G}::date, 'v54-3', '3', ${VSS}::uuid, 'M3', 8, 'non_rilevata', '{"vetture": []}'::jsonb),
      (${G}::date, 'v54-4', '4', ${VSS}::uuid, 'M2', 6, 'non_rilevata', '{"vetture": []}'::jsonb)`);
  });
  afterAll(pulisci);

  it("assegna, cambia e toglie; chi ha assegnato si vede; l'AVM che ha visto un'altra vettura dà un avviso", async () => {
    expect((await metti(admin, "M1", " 301 ")).body).toEqual({ vettura: "301" });
    let v = await leggi();
    expect(v.giornata).toEqual({ stato: "congelata" });
    const m1 = v.turni.find((t: any) => t.turnoMacchina === "M1");
    expect(m1).toMatchObject({ vettura: "301", depositoCodice: "jesi", assegnataDa: "Amministrazione di prova", vistaDallAvm: ["305"], uscita: "05:00", corse: 2 });
    expect(m1.avvisi).toEqual(["L'AVM ha visto un'altra vettura sulle corse del turno: 305"]);
    expect(v.turni.find((t: any) => t.turnoMacchina === "M2")).toMatchObject({ vettura: null, depositoCodice: "ancona", avvisi: [] });
    // cambiare è un upsert: una riga sola
    expect((await metti(admin, "M1", "305")).status).toBe(200);
    expect(await righe(sql`SELECT vettura FROM esercizio_vetture WHERE giorno = ${G}::date AND vss_id = ${VSS}::uuid`)).toEqual([{ vettura: "305" }]);
    expect((await leggi()).turni.find((t: any) => t.turnoMacchina === "M1").avvisi).toEqual([]);
    // la stessa vettura su due turni che si sovrappongono: avviso, non blocco
    expect((await metti(admin, "M3", "305")).status).toBe(200);
    v = await leggi();
    expect(v.turni.find((t: any) => t.turnoMacchina === "M3").avvisi).toEqual(["La vettura 305 è anche sul turno M1, che si sovrappone"]);
    expect((await togli(admin, "M3")).body).toEqual({ tolta: "305" });
    expect((await togli(admin, "M3")).status).toBe(404);
  });

  it("le richieste sbagliate: 400; turno o giornata che non c'è: 404; giornata chiusa: 409", async () => {
    expect((await metti(admin, "M1", "<b>")).status).toBe(400);
    expect((await metti(admin, "M1", "x".repeat(41))).status).toBe(400);
    expect((await admin.put("/api/roster/vetture").send({ giorno: G, vssId: "non-uuid", turnoMacchina: "M1", vettura: "1" })).status).toBe(400);
    expect((await metti(admin, "M1", "301", "2032-02-30")).status).toBe(400);
    expect((await admin.get("/api/roster/vetture?giorno=2032-02-30")).status).toBe(400);
    expect((await metti(admin, "M9", "301")).status).toBe(404);
    expect((await metti(admin, "M1", "301", VUOTA)).status).toBe(404);
    expect(await leggi(admin, VUOTA)).toMatchObject({ giornata: null, turni: [], daRiassegnare: [] });
    const chiusa = await metti(admin, "M1", "301", CHIUSA);
    expect(chiusa.status).toBe(409);
    expect(chiusa.body.error).toMatch(/chiusa/);
  });

  it("il capo deposito scrive solo sui turni del suo deposito, e vede quello che vede", async () => {
    expect((await metti(capo, "M3", "310")).status).toBe(200);
    const fuori = await metti(capo, "M2", "310");
    expect(fuori.status).toBe(403);
    expect(fuori.body).toMatchObject({ solaLettura: true });
    expect(fuori.body.error).toMatch(/Ancona/);
    expect((await togli(capo, "M2")).status).toBe(403);
    // vede tutti i depositi (nessun limite in lettura): anche M2
    expect((await leggi(capo)).turni.map((t: any) => t.turnoMacchina).sort()).toEqual(["M1", "M2", "M3"]);
    const limitato = request(appDiProva(rosterRouter, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["jesi"], depositiVisibili: ["jesi"] })));
    const v = await leggi(limitato);
    expect(v.turni.map((t: any) => t.turnoMacchina).sort()).toEqual(["M1", "M3"]);
  });

  it("alla conferma la corsa senza vettura dall'AVM prende quella del turno; quella vista dall'AVM resta", async () => {
    // M1 ha 305 (dal primo test), M3 ha 310 (dal capo), M2 niente
    const versione = Number((await righe(sql`SELECT versione FROM esercizio_giornate WHERE giorno = ${G}::date`))[0].versione);
    await registraEvento(G, { tipo: "conferma", versione, fonte: "movimento", proposte: ["effettuata_avm", "non_rilevata"] } as any, { id: ADMIN });
    expect(await righe(sql`SELECT chiave, esito, vettura FROM esercizio_corse WHERE giorno = ${G}::date ORDER BY chiave`)).toEqual([
      { chiave: "v54-1", esito: "presunta", vettura: "305" },
      { chiave: "v54-2", esito: "effettuata", vettura: "305" },
      { chiave: "v54-3", esito: "presunta", vettura: "310" },
      { chiave: "v54-4", esito: "presunta", vettura: null },
    ]);
  });

  it("il turno macchina sparito (nuova pubblicazione): l'assegnazione resta «da riassegnare» e si toglie", async () => {
    await db.execute(sql`DELETE FROM esercizio_turni_macchina WHERE giorno = ${G}::date AND turno_macchina = 'M3'`);
    const v = await leggi();
    expect(v.turni.map((t: any) => t.turnoMacchina).sort()).toEqual(["M1", "M2"]);
    expect(v.daRiassegnare).toEqual([{ vssId: VSS, turnoMacchina: "M3", vettura: "310" }]);
    // chi ha un limite non le vede (il deposito non si sa più) e non le toglie
    const limitato = request(appDiProva(rosterRouter, utenteDiProva(CAPO, [], "user", { ruoli: ["capo_deposito"], depositi: ["jesi"], depositiVisibili: ["jesi"] })));
    expect((await leggi(limitato)).daRiassegnare).toEqual([]);
    expect((await togli(capo, "M3")).status).toBe(403);
    expect((await metti(admin, "M3", "311")).status).toBe(404);
    expect((await togli(admin, "M3")).body).toEqual({ tolta: "310" });
    expect((await leggi()).daRiassegnare).toEqual([]);
  });

  it("nel registro delle modifiche, coi valori; chi ha assegnato solo come nome", async () => {
    const r = (await righe(sql`SELECT con_valori, solo_nome FROM registro.sorvegliate WHERE tabella = 'public.esercizio_vetture'`).catch(() => null));
    // l'app non legge le regole del registro: se le legge (come postgres), sono quelle della 0033
    if (r) {
      expect(r[0].con_valori).toBe(true);
      expect(r[0].solo_nome).toContain("assegnata_da");
    }
  });
});
