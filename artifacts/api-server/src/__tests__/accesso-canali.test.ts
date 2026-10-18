import { describe, it, expect } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../app";
import { emettiSessione, mintShortLivedUserToken } from "../lib/auth";

const UTENTE = "00000000-0000-4000-8000-000000000001";

/* Un token dato ad Argos (via) vive dieci minuti e serve a leggere e scrivere
 * i dati di progetto per conto della persona: non deve poter diventare una
 * sessione, cambiare la verifica, entrare in FleetCare o amministrare. Il
 * rifiuto arriva prima di leggere l'utente, quindi si prova senza database. */
describe("i token di Argos non toccano l'accesso della persona", () => {
  const via = mintShortLivedUserToken(UTENTE, { sv: 1, mfa: true });
  const casi: Array<["get" | "post", string]> = [
    ["post", "/api/auth/sessioni/chiudi"], ["post", "/api/auth/password"], ["post", "/api/auth/mfa/attiva"],
    ["post", "/api/AUTH/mfa/conferma"], ["post", "/api/auth/mfa/reimposta"], ["get", "/api/auth/fleetcare-sso"],
    ["get", "/api/admin/users"], ["get", "/api/admin/accessi"],
  ];
  for (const [metodo, percorso] of casi) {
    it(`${metodo.toUpperCase()} ${percorso} → 403, e nessun cookie`, async () => {
      const r = await request(app)[metodo](percorso).set("Authorization", `Bearer ${via}`).send({});
      expect(r.status).toBe(403);
      expect(r.headers["set-cookie"]).toBeUndefined();
    });
  }
});

describe("la sessione", () => {
  it("scade 12 ore dopo la password, anche quando il cookie si riemette", () => {
    let valore = "";
    let opzioni: any = null;
    const res: any = { cookie: (_n: string, v: string, o: any) => { valore = v; opzioni = o; } };
    const at = Math.floor(Date.now() / 1000) - 11 * 3600;
    emettiSessione(res, UTENTE, { sv: 3, mfa: true, at, rec: true });
    const d = jwt.decode(valore) as any;
    expect(d).toMatchObject({ sub: UTENTE, sv: 3, at, mfa: true, rec: true, exp: at + 12 * 3600 });
    expect(opzioni.httpOnly).toBe(true);
    expect(opzioni.maxAge).toBeLessThanOrEqual(3600 * 1000);
    expect(opzioni.maxAge).toBeGreaterThan(3500 * 1000);
  });

  it("la password ridata segna pw, ma la scadenza resta quella dell'accesso", () => {
    let valore = "";
    const res: any = { cookie: (_n: string, v: string) => { valore = v; } };
    const ora = Math.floor(Date.now() / 1000);
    const at = ora - 11 * 3600;
    emettiSessione(res, UTENTE, { sv: 2, mfa: true, at, pw: ora });
    const d = jwt.decode(valore) as any;
    expect(d.exp).toBe(at + 12 * 3600);
    expect(d.pw).toBe(ora);
  });

  it("una sessione nuova parte da adesso, senza recupero se non c'è stato", () => {
    let valore = "";
    const res: any = { cookie: (_n: string, v: string) => { valore = v; } };
    emettiSessione(res, UTENTE, { sv: 1, mfa: false });
    const d = jwt.decode(valore) as any;
    expect(Math.abs(d.at - Date.now() / 1000)).toBeLessThan(5);
    expect(d.exp - d.at).toBe(12 * 3600);
    expect(d.pw).toBe(d.at);
    expect(d.mfa).toBeUndefined();
    expect(d.rec).toBeUndefined();
  });
});
