/* Con chi lavora il processo sul database (PR 2.8): se cerbero_app non lavora
 * come cerbero_owner il processo non parte; da superutente o con relazioni di
 * un altro ruolo, un avviso. */
import { describe, it, expect } from "vitest";
import { giudica } from "../lib/identita-db";

const io = { sessione: "cerbero_app", corrente: "cerbero_owner", superutente: false, altrui: [] as string[] };

describe("identità sul database", () => {
  it("cerbero_app come cerbero_owner, tutto suo: va bene", () => {
    expect(giudica(io)).toEqual({ esito: "ok", messaggio: "database: collegato come cerbero_app, lavora come cerbero_owner" });
  });
  it("cerbero_app senza il ruolo applicato: si ferma, con la cura", () => {
    const g = giudica({ ...io, corrente: "cerbero_app" });
    expect(g.esito).toBe("fatale");
    expect(g.messaggio).toMatch(/«role = cerbero_owner» del ruolo cerbero_app.*ruoli\.mjs/);
  });
  it("ancora superutente (prima del cambio di DATABASE_URL): avviso", () => {
    const g = giudica({ sessione: "postgres", corrente: "postgres", superutente: true, altrui: ["public.users"] });
    expect(g).toMatchObject({ esito: "avviso" });
    expect(g.messaggio).toMatch(/superutente.*cerbero_app/);
  });
  it("relazioni di un altro ruolo: avviso con l'elenco (al più 10)", () => {
    const altrui = Array.from({ length: 12 }, (_, i) => `public.t${i}`);
    const g = giudica({ ...io, altrui });
    expect(g).toMatchObject({ esito: "avviso" });
    expect(g.messaggio).toMatch(/^12 relazioni di Cerbero non sono di cerbero_owner: public\.t0, .*public\.t9 e altre 2/);
  });
});
