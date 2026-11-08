/* Con chi lavora il processo sul database (PR 2.8): come cerbero_app il
 * processo non parte se il ruolo non si applica, se manca l'event trigger che
 * ferma il DDL dell'app o se una relazione di Cerbero è ancora di un
 * superutente; da superutente o con relazioni di un altro ruolo, un avviso. */
import { describe, it, expect } from "vitest";
import { ERRORI_DI_ACCESSO, giudica } from "../lib/identita-db";
import { RELAZIONI_DEL_CATALOGO } from "../../../../lib/db/scripts/catalogo-incluso.mjs";

type Altrui = { nome: string; diSuperutente: boolean; delCatalogo: boolean };
const io = { sessione: "cerbero_app", corrente: "cerbero_owner", superutente: false, eventoAcceso: true, altrui: [] as Altrui[] };

describe("identità sul database", () => {
  it("cerbero_app come cerbero_owner, protetto, tutto suo: va bene", () => {
    expect(giudica(io)).toEqual({ esito: "ok", messaggio: "database: collegato come cerbero_app, lavora come cerbero_owner" });
  });
  it("cerbero_app senza il ruolo applicato: si ferma, con la cura", () => {
    const g = giudica({ ...io, corrente: "cerbero_app" });
    expect(g.esito).toBe("fatale");
    expect(g.messaggio).toMatch(/«role = cerbero_owner» del ruolo cerbero_app.*ruoli\.mjs/);
  });
  it("cerbero_app senza l'event trigger acceso: si ferma", () => {
    const g = giudica({ ...io, eventoAcceso: false });
    expect(g.esito).toBe("fatale");
    expect(g.messaggio).toMatch(/cerbero_ddl_dell_app e cerbero_ddl_dell_app_fine/);
  });
  it("cerbero_app con una relazione del catalogo ancora di un superutente: si ferma (il login darebbe permission denied)", () => {
    const g = giudica({ ...io, altrui: [
      { nome: "public.users", diSuperutente: true, delCatalogo: true },
      { nome: "caronte.stop_predictions", diSuperutente: false, delCatalogo: true },
      { nome: "public.users_backup", diSuperutente: true, delCatalogo: false },
    ] });
    expect(g.esito).toBe("fatale");
    expect(g.messaggio).toMatch(/una relazione di Cerbero è ancora di un superutente: public\.users\./);
  });
  it("una relazione di un superutente fuori dal catalogo (un backup a mano): solo un avviso, come ruoli.mjs", () => {
    const g = giudica({ ...io, altrui: [{ nome: "public.users_backup_20261108", diSuperutente: true, delCatalogo: false }] });
    expect(g.esito).toBe("avviso");
    expect(g.messaggio).toMatch(/^1 relazione di un superutente fuori dal catalogo di Cerbero: public\.users_backup_20261108\..*--verifica/);
  });
  it("il catalogo incluso nel bundle: le relazioni che il riallineamento sposta", () => {
    expect(RELAZIONI_DEL_CATALOGO).toContain("public.users");
    expect(RELAZIONI_DEL_CATALOGO).toContain("public.ps_variants");
    expect(RELAZIONI_DEL_CATALOGO).not.toContain("caronte.app_users");
  });
  it("ancora superutente (prima del cambio di DATABASE_URL): avviso", () => {
    const g = giudica({ sessione: "postgres", corrente: "postgres", superutente: true, eventoAcceso: false, altrui: [{ nome: "public.users", diSuperutente: true, delCatalogo: true }] });
    expect(g).toMatchObject({ esito: "avviso" });
    expect(g.messaggio).toMatch(/superutente.*cerbero_app/);
  });
  it("relazioni di un altro ruolo (non superutente): avviso con l'elenco (al più 10)", () => {
    const altrui = Array.from({ length: 12 }, (_, i) => ({ nome: `caronte.t${i}`, diSuperutente: false, delCatalogo: true }));
    const g = giudica({ ...io, altrui });
    expect(g).toMatchObject({ esito: "avviso" });
    expect(g.messaggio).toMatch(/^12 relazioni di Cerbero non sono di cerbero_owner: caronte\.t0, .*caronte\.t9 e altre 2/);
  });
  it("gli errori di accesso che fermano il processo: password, LOGIN, database", () => {
    expect([...ERRORI_DI_ACCESSO].sort()).toEqual(["28000", "28P01", "3D000"]);
  });
});
