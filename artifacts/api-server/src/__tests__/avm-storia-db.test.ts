/**
 * L'andamento dell'AVM su un database vero (TEST_DATABASE_URL, migrato: in CI
 * il job migrazioni-postgres): il diario aggregato in SQL dice le stesse cose
 * delle righe intere, le richieste a Mizar non si duplicano, si chiudono una
 * volta sola, i vincoli della tabella reggono.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  leggiStoriaDiario, leggiRichieste, creaRichieste, chiudiRichieste, registraVerifiche, pulisciRichieste,
} from "../lib/avm-storia-store";
import { leggiDiario } from "../lib/avm-diario-store";
import { calcolaStoria } from "../lib/avm-storia";
import { calcolaControllo, spostaGiorni } from "../lib/avm-controllo";

const OGGI = "2026-11-04";
const ULTIMA = "2026-10-26";
const INIZIO = "2026-09-07";
const EMAIL = "avm-storia-db@prova.local";

/** (giorno, vettura, letture, fresche, posizione): un andamento noto per sei vetture. */
function semina(): Array<[string, string, number, number, number]> {
  const righe: Array<[string, string, number, number, number]> = [];
  for (let g = INIZIO; g < OGGI; g = spostaGiorni(g, 1)) {
    const campioni = g === "2026-10-07" ? 200 : 720; // una giornata a metà raccolta
    if (g === "2026-10-21") continue;                // connettore fermo: nessuna riga
    const k = Math.floor((new Date(`${g}T00:00:00Z`).getTime() - new Date(`${INIZIO}T00:00:00Z`).getTime()) / (7 * 86_400_000));
    righe.push([g, "10", campioni, 9, 9]);                                  // funziona
    righe.push([g, "11", campioni, 9, k < 5 ? 9 : 0]);                      // parla soltanto dalla sesta settimana
    righe.push([g, "12", campioni, 0, 0]);                                  // muta
    if (k % 2 === 1) righe.push([g, "13", campioni, 9, 9]);                 // a settimane alterne, c'è nell'ultima chiusa
    if (g < "2026-10-15") righe.push([g, "14", campioni, 9, 9]);            // sparita dal 15/10
    if (k >= 6) righe.push([g, "11096", campioni, 9, k >= 7 ? 9 : 0]);      // consorziata nuova
  }
  return righe;
}

describe.runIf(!!process.env.TEST_DATABASE_URL)("l'andamento AVM, sul database", () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM caronte.avm_richieste_mizar");
    await pool.query("DELETE FROM caronte.avm_diario WHERE day >= $1", [INIZIO]);
    const righe = semina();
    await pool.query(
      `INSERT INTO caronte.avm_diario (day, vehicle_ref, letture, letture_fresche, letture_posizione)
       SELECT * FROM unnest($1::date[], $2::text[], $3::int[], $4::int[], $5::int[])`,
      [righe.map(r => r[0]), righe.map(r => r[1]), righe.map(r => r[2]), righe.map(r => r[3]), righe.map(r => r[4])]);
    await pool.query("DELETE FROM users WHERE email = $1", [EMAIL]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM caronte.avm_richieste_mizar");
    await pool.query("DELETE FROM caronte.avm_diario WHERE day >= $1", [INIZIO]);
    await pool.query("DELETE FROM users WHERE email = $1", [EMAIL]);
  });

  it("il diario aggregato dice le stesse settimane delle righe intere (parità col controllo)", async () => {
    const aggregato = await leggiStoriaDiario(INIZIO, OGGI);
    expect(aggregato.errore).toBeNull();
    expect(aggregato.campioni.get("2026-10-07")).toBe(200);
    expect(aggregato.campioni.has("2026-10-21")).toBe(false);
    const storia = calcolaStoria({
      oggi: OGGI, inizio: INIZIO, campioni: aggregato.campioni, vetture: aggregato.vetture,
      parco: null, interventi: null, richieste: [],
    });
    const controllo = calcolaControllo({ righe: await leggiDiario(INIZIO, spostaGiorni(ULTIMA, 6)), lunedi: ULTIMA, oggi: OGGI });
    const i0 = storia.settimane.findIndex(w => w.lunedi === controllo.settimane[0].lunedi);
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(controllo.vetture.length).toBe(6);
    for (const v of controllo.vetture) {
      expect(storia.vetture.find(x => x.vehicleRef === v.vehicleRef)!.storia.slice(i0, i0 + 8), v.vehicleRef).toBe(v.storia);
    }
    const azione = Object.fromEntries(storia.vetture.map(v => [v.vehicleRef, v.azione]));
    expect(azione).toMatchObject({ "10": "funziona", "11": "da_riparare", "12": "da_riparare", "13": "instabile" });
  });

  it("le richieste: niente doppioni aperti, chiusura una volta sola, nomi da users", async () => {
    const u = await pool.query(
      "INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'Anna Bianchi') RETURNING id", [EMAIL]);
    const utente = String(u.rows[0].id);
    expect(await creaRichieste({ tipo: "togliere", matricole: ["14", "12"], richiestaIl: "2026-10-14", nota: "mail", utenteId: utente }))
      .toEqual({ create: ["14", "12"], giaAperte: [] });
    expect(await creaRichieste({ tipo: "togliere", matricole: ["14", "15"], richiestaIl: "2026-10-20", nota: null, utenteId: utente }))
      .toEqual({ create: ["15"], giaAperte: ["14"] });
    /* lo stesso numero con un altro tipo è un'altra richiesta */
    expect((await creaRichieste({ tipo: "aggiungere", matricole: ["14"], richiestaIl: "2026-10-20", nota: null, utenteId: null })).create)
      .toEqual(["14"]);

    let { richieste } = await leggiRichieste("2026-08-01");
    expect(richieste).toHaveLength(4);
    const t14 = richieste.find(r => r.vehicleRef === "14" && r.tipo === "togliere")!;
    expect(t14).toMatchObject({ creataDa: "Anna Bianchi", esito: null, richiestaIl: "2026-10-14", nota: "mail" });

    expect(await registraVerifiche([{ id: t14.id, chiusaIl: "2026-10-15" }])).toBe(1);
    expect(await registraVerifiche([{ id: t14.id, chiusaIl: "2026-10-20" }])).toBe(0); // già chiusa: niente
    const a14 = richieste.find(r => r.vehicleRef === "14" && r.tipo === "aggiungere")!;
    expect(await chiudiRichieste([a14.id], "annullata", utente, OGGI)).toEqual([a14.id]);
    expect(await chiudiRichieste([a14.id], "fatta", utente, OGGI)).toEqual([]);

    ({ richieste } = await leggiRichieste("2026-08-01"));
    expect(richieste.find(r => r.id === t14.id)).toMatchObject({ esito: "fatta", chiusaIl: "2026-10-15", chiusaDa: null, automatica: true });
    expect(richieste.find(r => r.id === a14.id)).toMatchObject({ esito: "annullata", chiusaDa: "Anna Bianchi", automatica: false });
    /* chiusa, la stessa vettura si può richiedere di nuovo */
    expect((await creaRichieste({ tipo: "togliere", matricole: ["14"], richiestaIl: OGGI, nota: null, utenteId: null })).create).toEqual(["14"]);

    /* un utente cancellato lascia il nome vuoto, la richiesta resta */
    await pool.query("DELETE FROM users WHERE id = $1", [utente]);
    ({ richieste } = await leggiRichieste("2026-08-01"));
    expect(richieste.find(r => r.vehicleRef === "12")).toMatchObject({ creataDa: null });
    expect(richieste.find(r => r.id === a14.id)).toMatchObject({ chiusaDa: "utente rimosso" });
  });

  it("i vincoli: tipo, chiusura coerente, nota lunga", async () => {
    await expect(pool.query("INSERT INTO caronte.avm_richieste_mizar (vehicle_ref, tipo, richiesta_il) VALUES ('1', 'rimuovere', '2026-10-01')"))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("INSERT INTO caronte.avm_richieste_mizar (vehicle_ref, tipo, richiesta_il, esito) VALUES ('1', 'togliere', '2026-10-01', 'fatta')"))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("INSERT INTO caronte.avm_richieste_mizar (vehicle_ref, tipo, richiesta_il, esito, chiusa_il) VALUES ('1', 'togliere', '2026-10-05', 'fatta', '2026-10-01')"))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("INSERT INTO caronte.avm_richieste_mizar (vehicle_ref, tipo, richiesta_il, nota) VALUES ('1', 'togliere', '2026-10-01', repeat('x', 501))"))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("la conservazione: via le chiuse prima del limite, le aperte restano", async () => {
    await creaRichieste({ tipo: "togliere", matricole: ["1", "2"], richiestaIl: "2024-01-10", nota: null, utenteId: null });
    const { richieste } = await leggiRichieste("2000-01-01");
    await chiudiRichieste([richieste.find(r => r.vehicleRef === "1")!.id], "annullata", null, "2024-02-01");
    expect(await pulisciRichieste("2024-11-04")).toBe(1);
    expect((await leggiRichieste("2000-01-01")).richieste.map(r => r.vehicleRef)).toEqual(["2"]);
  });
});
