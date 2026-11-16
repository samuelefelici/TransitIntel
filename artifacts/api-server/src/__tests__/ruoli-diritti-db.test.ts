/**
 * I diritti dei ruoli cambiati dall'app, su un database vero
 * (TEST_DATABASE_URL, migrato; in CI come cerbero_app). PR 2.18, migrazione 0015.
 *
 * Quattro utenti di prova: un Capo deposito, uno che è anche Ufficio turni,
 * uno dell'Officina, e un Capo deposito che è amministratore di sistema.
 * Cambiando che cosa dà il ruolo «Capo deposito»:
 * - la tabella tiene solo le celle diverse da quelle di partenza;
 * - chi ha il ruolo viene riallineato nella stessa transazione: la vista
 *   users.permissions (FleetCare, la regola della verifica in due passaggi,
 *   che il database ricalcola) e i dati sanitari;
 * - chi non ha il ruolo e l'amministratore di sistema non si toccano;
 * - i diritti di chi viene caricato dopo sono quelli nuovi.
 * Alla fine la tabella torna com'era e gli utenti di prova spariscono.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import adminRouter from "../routes/admin";
import { MATRICE, RUOLI, rigaDelRuolo } from "@workspace/permessi";
import { dimenticaMatrice, matriceFresca, matriceSottoLucchetto, salvaDirittiDelRuolo } from "../lib/matrice-ruoli";
import { matriceInVigore } from "../lib/matrice-in-vigore";
import { riallineaVistaPermessi, utenteDaRiga } from "../lib/auth";
import { dirittiEVista, permessiDopo, profiloDaRiga } from "../lib/permessi";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

const PREFISSO = "prova218-";
const ADMIN = "e1800000-0000-4000-8000-000000000001";
const admin = request(appDiProva(adminRouter, utenteDiProva(ADMIN, [], "admin")));
const CAPO = rigaDelRuolo(MATRICE, "capo_deposito");
const OFFICINA = rigaDelRuolo(MATRICE, "officina");
const righe = async (q: ReturnType<typeof sql>) => (await db.execute<any>(q)).rows;
const codice = async (q: ReturnType<typeof sql>) => {
  try { await db.execute(q); return null; } catch (e: any) { return String(e?.code ?? e?.cause?.code ?? e?.message); }
};
const celle = () => righe(sql`SELECT ruolo, area, livello, aggiornata_da::text AS da FROM ruoli_diritti ORDER BY ruolo, area`);

describe.runIf(!!process.env.TEST_DATABASE_URL)("i diritti dei ruoli cambiati dall'app (database vero)", () => {
  let prima: any[] = [];
  const id: Record<string, string> = {};
  const utente = async (nome: string) => (await righe(sql`
    SELECT id, email, role, ruoli, accesso_di_prima, dati_sanitari, analisi, permissions, mfa_obbligatoria, active FROM users WHERE id = ${id[nome]}::uuid`))[0];

  beforeAll(async () => {
    prima = await righe(sql`SELECT * FROM ruoli_diritti`);
    await db.execute(sql`DELETE FROM ruoli_diritti`);
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${PREFISSO + "%"}`);
    dimenticaMatrice();
    const crea = async (nome: string, ruoli: string[], extra: { role?: string; sanitari?: boolean } = {}) => {
      const vista = dirittiEVista(profiloDaRiga({ role: extra.role ?? "user", ruoli })).permissions;
      const r = await righe(sql`
        INSERT INTO users (email, password_hash, role, ruoli, dati_sanitari, permissions, active)
        VALUES (${`${PREFISSO}${nome}@prova.local`}, 'x', ${extra.role ?? "user"}, ${`{${ruoli.join(",")}}`}::text[],
                ${extra.sanitari === true}, ${JSON.stringify(vista)}::jsonb, true)
        RETURNING id`);
      id[nome] = r[0].id;
    };
    await crea("capo", ["capo_deposito"], { sanitari: true });
    await crea("capo-e-turni", ["capo_deposito", "ufficio_turni"], { sanitari: true });
    await crea("officina", ["officina"]);
    await crea("capo-admin", ["capo_deposito"], { role: "admin", sanitari: true });
  });
  afterAll(async () => {
    await db.execute(sql`DELETE FROM users WHERE email LIKE ${PREFISSO + "%"}`);
    await db.execute(sql`DELETE FROM ruoli_diritti`);
    for (const r of prima) {
      await db.execute(sql`
        INSERT INTO ruoli_diritti (ruolo, area, livello, aggiornata_il, aggiornata_da)
        VALUES (${r.ruolo}, ${r.area}, ${r.livello}, ${r.aggiornata_il}, ${r.aggiornata_da})`);
    }
    await pool.end();
  });

  it("tabella vuota: ogni ruolo ha i diritti di partenza, e la migrazione non ha cambiato l'accesso di nessuno", async () => {
    const r = await admin.get("/api/admin/ruoli");
    expect(r.status).toBe(200);
    for (const ruolo of r.body.ruoli) {
      expect(ruolo.diritti, ruolo.codice).toEqual(ruolo.diPartenza);
      expect(ruolo.diPartenza, ruolo.codice).toEqual(rigaDelRuolo(MATRICE, ruolo.codice));
    }
    expect(r.body.ruoli.map((x: any) => x.codice)).toEqual([...RUOLI]);
    // i due Capo deposito non amministratori; l'amministratore di sistema non conta
    expect(r.body.ruoli.find((x: any) => x.codice === "capo_deposito").utenti).toBeGreaterThanOrEqual(2);
    expect((await utente("capo")).mfa_obbligatoria).toBe(true); // il roster chiede la verifica in due passaggi
    expect((await utente("officina")).mfa_obbligatoria).toBe(false);
  });

  it("togliere Roster e Flotta al Capo deposito: le celle, gli utenti del ruolo, e nessun altro", async () => {
    const officinaPrima = await utente("officina");
    const adminPrima = await utente("capo-admin");
    const r = await admin.put("/api/admin/ruoli/capo_deposito").send({ diritti: { ...CAPO, roster: null, flotta: null } });
    expect(r.status).toBe(200);
    expect(r.body.esito).toMatchObject({ celle: 2, datiSanitariSpenti: 1 });
    expect(r.body.esito.utentiAggiornati).toBeGreaterThanOrEqual(2);
    expect(await celle()).toEqual([
      { ruolo: "capo_deposito", area: "flotta", livello: "N", da: ADMIN },
      { ruolo: "capo_deposito", area: "roster", livello: "N", da: ADMIN },
    ]);

    // il Capo deposito: fuori dal roster e da FleetCare, dati sanitari spenti, verifica non più obbligatoria
    const capo = await utente("capo");
    expect(capo.permissions).toMatchObject({ roster: false, fleetcare: false, network: true, scheduling: true });
    expect(capo.dati_sanitari).toBe(false);
    expect(capo.mfa_obbligatoria).toBe(false);
    // chi è anche Ufficio turni legge ancora il roster: dati sanitari e verifica restano
    const due = await utente("capo-e-turni");
    expect(due.permissions).toMatchObject({ roster: true, fleetcare: false });
    expect(due.dati_sanitari).toBe(true);
    expect(due.mfa_obbligatoria).toBe(true);
    // chi non ha il ruolo e l'amministratore di sistema: come prima
    expect(await utente("officina")).toEqual(officinaPrima);
    expect(await utente("capo-admin")).toEqual(adminPrima);

    // chi viene caricato da adesso ha i diritti nuovi (la matrice in memoria è già quella salvata)
    expect(utenteDaRiga(capo).diritti).toMatchObject({ roster: null, flotta: null, rete: "L", esercizio: "L" });
    expect(utenteDaRiga(due).diritti).toMatchObject({ roster: "L", flotta: null, turni: "S" });
    expect(Object.values(utenteDaRiga(await utente("capo-admin")).diritti).every(v => v === "S")).toBe(true);
    // e un processo appena partito legge lo stesso dalla tabella
    dimenticaMatrice();
    expect(matriceInVigore().capo_deposito.roster).toBe("S");
    expect(rigaDelRuolo(await matriceFresca(), "capo_deposito")).toEqual({ ...CAPO, roster: null, flotta: null });
    // il riallineamento dell'avvio non trova più niente da sistemare
    expect(await righe(sql`SELECT 1 FROM users WHERE email LIKE ${PREFISSO + "%"} AND role <> 'admin'`)).toHaveLength(3);
    const primaDelRiallineamento = await utente("capo");
    await riallineaVistaPermessi();
    expect(await utente("capo")).toEqual(primaDelRiallineamento);
  });

  it("dare il Roster in lettura all'Officina: la verifica in due passaggi diventa obbligatoria, e la risposta dice per quanti", async () => {
    const r = await admin.put("/api/admin/ruoli/officina").send({ diritti: { ...OFFICINA, roster: "L" } });
    expect(r.status).toBe(200);
    expect(r.body.esito.celle).toBe(1);
    expect(r.body.esito.daVerificare).toBeGreaterThanOrEqual(1);
    const officina = await utente("officina");
    expect(officina.permissions).toMatchObject({ roster: true, fleetcare: true });
    expect(officina.mfa_obbligatoria).toBe(true);
    // i due salvataggi convivono: le celle del Capo deposito sono ancora lì
    expect((await celle()).map(c => `${c.ruolo}.${c.area}=${c.livello}`)).toEqual(["capo_deposito.flotta=N", "capo_deposito.roster=N", "officina.roster=L"]);
  });

  it("due amministratori insieme su due ruoli: valgono tutte e due le modifiche", async () => {
    const [a, b] = await Promise.all([
      admin.put("/api/admin/ruoli/pianificatore").send({ diritti: { ...rigaDelRuolo(MATRICE, "pianificatore"), tariffe: null } }),
      admin.put("/api/admin/ruoli/centrale_operativa").send({ diritti: { ...rigaDelRuolo(MATRICE, "centrale_operativa"), flotta: null } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const tutte = (await celle()).map(c => `${c.ruolo}.${c.area}=${c.livello}`);
    expect(tutte).toEqual(expect.arrayContaining(["pianificatore.tariffe=N", "centrale_operativa.flotta=N", "officina.roster=L"]));
    const m = await matriceFresca();
    expect(m.pianificatore.tariffe).toBeUndefined();
    expect(m.centrale_operativa.flotta).toBeUndefined();
  });

  it("una modifica a un utente nello stesso istante di una modifica al ruolo: la sua vista è sempre quella giusta", async () => {
    /* Come PATCH /api/admin/users/:id: il lucchetto dei ruoli, poi la riga dell'utente, poi il
     * calcolo con la matrice riletta. Senza il lucchetto l'utente poteva restare con la vista
     * calcolata sulla matrice di prima; nell'ordine opposto i due si fermavano a vicenda. */
    const modificaUtente = (analisi: boolean) => db.transaction(async (tx) => {
      await matriceSottoLucchetto(tx as any);
      const [prima] = (await tx.execute<any>(sql`
        SELECT role, ruoli, accesso_di_prima, dati_sanitari, analisi, depositi FROM users WHERE id = ${id.capo}::uuid FOR UPDATE`)).rows;
      const dopo = permessiDopo(prima, { analisi });
      await tx.execute(sql`UPDATE users SET analisi = ${dopo.analisi}, permissions = ${JSON.stringify(dopo.permissions)}::jsonb WHERE id = ${id.capo}::uuid`);
    });
    for (let giro = 0; giro < 12; giro++) {
      const conTariffe = giro % 2 === 0, analisi = giro % 3 === 0;
      const insieme = [
        salvaDirittiDelRuolo("capo_deposito", { ...CAPO, roster: null, flotta: null, tariffe: conTariffe ? "L" : null }, ADMIN),
        modificaUtente(analisi),
      ];
      await Promise.all(giro % 4 < 2 ? insieme : insieme.reverse());
      const u = await utente("capo");
      expect(u.permissions, `giro ${giro}`).toMatchObject({ fares: conTariffe, analytics: analisi, roster: false, fleetcare: false });
      expect(u.permissions).toEqual(dirittiEVista(profiloDaRiga(u)).permissions);
    }
    // si rimette com'era prima di questo test
    await salvaDirittiDelRuolo("capo_deposito", { ...CAPO, roster: null, flotta: null }, ADMIN);
    await modificaUtente(false);
  });

  it("riportare tutto ai valori di partenza svuota la tabella e rimette gli utenti com'erano", async () => {
    for (const ruolo of RUOLI) {
      const r = await admin.put(`/api/admin/ruoli/${ruolo}`).send({ diritti: rigaDelRuolo(MATRICE, ruolo) });
      expect(r.status, ruolo).toBe(200);
    }
    expect(await celle()).toEqual([]);
    const capo = await utente("capo");
    expect(capo.permissions).toMatchObject({ roster: true, fleetcare: true });
    expect(capo.mfa_obbligatoria).toBe(true);
    // i dati sanitari spenti NON tornano da soli: li riaccende l'amministratore, utente per utente
    expect(capo.dati_sanitari).toBe(false);
    expect((await utente("officina")).permissions).toMatchObject({ roster: false, fleetcare: true });
    expect((await utente("officina")).mfa_obbligatoria).toBe(false);
  });

  it("i vincoli della tabella fermano chi scrive senza passare dall'API, e il registro la sorveglia", async () => {
    expect(await codice(sql`INSERT INTO ruoli_diritti (ruolo, area, livello) VALUES ('capo_deposito', 'flotta', 'X')`)).toBe("23514");
    expect(await codice(sql`INSERT INTO ruoli_diritti (ruolo, area, livello) VALUES ('Capo Deposito', 'flotta', 'N')`)).toBe("23514");
    expect(await codice(sql`INSERT INTO ruoli_diritti (ruolo, area, livello) VALUES ('capo_deposito', 'flotta;', 'N')`)).toBe("23514");
    expect(await codice(sql`INSERT INTO ruoli_diritti (ruolo, area, livello) VALUES ('capo_deposito', 'flotta', NULL)`)).toBe("23502");
    const [regola] = await righe(sql`SELECT chiave, con_valori, escluse FROM registro.sorvegliate WHERE tabella = 'public.ruoli_diritti'`);
    expect(regola.chiave).toEqual(["ruolo", "area"]);
    expect(regola.con_valori).toBe(true);
    // un nome che il codice non conosce passa i vincoli ma non vale: la matrice lo ignora
    await db.execute(sql`INSERT INTO ruoli_diritti (ruolo, area, livello) VALUES ('ruolo_di_domani', 'area_di_domani', 'S')`);
    dimenticaMatrice();
    const m = await matriceFresca();
    for (const r of RUOLI) expect(rigaDelRuolo(m, r), r).toEqual(rigaDelRuolo(MATRICE, r));
    await db.execute(sql`DELETE FROM ruoli_diritti WHERE ruolo = 'ruolo_di_domani'`);
  });
});
