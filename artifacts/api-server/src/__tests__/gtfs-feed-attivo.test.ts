import { describe, it, expect } from "vitest";
import request from "supertest";
import router from "../routes/gtfs-upload";
import { appDiProva, utenteDiProva } from "./helpers/app-di-prova";

/* Il feed attivo vale per tutti (analisi, tariffe, AVM): lo cambia solo l'admin. */
describe("cambiare il feed GTFS attivo", () => {
  const analisi = appDiProva(router, utenteDiProva("10000000-0000-0000-0000-000000000002", ["analytics"]));
  const admin = appDiProva(router, utenteDiProva("10000000-0000-0000-0000-000000000001", [], "admin"));

  it("chi ha solo analytics riceve 403, su attiva e su disattiva tutti", async () => {
    expect((await request(analisi).post("/api/gtfs/feeds/00000000-0000-0000-0000-000000000001/activate")).status).toBe(403);
    expect((await request(analisi).post("/api/gtfs/feeds/deactivate-all")).status).toBe(403);
  });

  it("l'admin passa il controllo (un id storto si ferma dopo, con 400)", async () => {
    expect((await request(admin).post("/api/gtfs/feeds/non-un-uuid/activate")).status).toBe(400);
  });
});
