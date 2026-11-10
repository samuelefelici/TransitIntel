import { describe, it, expect } from "vitest";
import {
  AMBITI_FILTRABILI, confronto, descrizione, istanti, mostraValore, nomeAttore, nomeOperazione, nomeTabella, nomeVia,
  periodoPredefinito, richiesta, type FiltriRegistro,
} from "./registro-modifiche";

const filtri = (extra: Partial<FiltriRegistro> = {}): FiltriRegistro => ({
  da: "2026-11-03", a: "2026-11-09", tabella: "", operazione: "", ambitoTipo: "", ambitoId: "", ...extra,
});

describe("il registro delle modifiche, in parole", () => {
  it("tabelle, operazioni, canali", () => {
    expect(nomeTabella("public.ps_stop_times")).toBe("Orari alle fermate");
    expect(nomeTabella("public.roster_entries")).toBe("Voci del roster");
    expect(nomeTabella("public.tabella_nuova")).toBe("tabella_nuova");
    expect(nomeOperazione("UPDATE")).toBe("modifica");
    expect(nomeVia("api")).toBe("dall'app");
    expect(nomeVia("argos")).toBe("Argos");
    expect(nomeVia("argos:mcp")).toBe("Argos (mcp)");
    expect(nomeVia("argos:mcp:coda:giro_agente")).toBe("Argos, calcolo in coda (giro_agente)");
    expect(nomeVia("argos:mcp:timer:attivazioni")).toBe("Argos, attivazione programmata");
    expect(nomeVia("timer:attivazioni")).toBe("attivazione programmata");
    expect(nomeVia("cron:traffic")).toBe("operazione pianificata (traffic)");
    expect(nomeVia("coda:ottimizza_veicoli")).toBe("calcolo in coda (ottimizza_veicoli)");
    expect(nomeVia(null)).toBe("—");
    expect(nomeVia("qualcosa:di:nuovo")).toBe("qualcosa:di:nuovo");
  });

  it("chi: il nome, o l'email, o un pezzo dell'id; senza attore il sistema o niente", () => {
    expect(nomeAttore({ attore: { id: "a0000000-0000-4000-8000-000000000001", nome: "Ada Admin", email: "ada@x.it" }, via: "api" })).toBe("Ada Admin");
    expect(nomeAttore({ attore: { id: "a0000000-0000-4000-8000-000000000001", nome: null, email: "ada@x.it" }, via: "api" })).toBe("ada@x.it");
    // un utente cancellato: resta l'id nel registro, senza nome
    expect(nomeAttore({ attore: { id: "a0000000-0000-4000-8000-000000000001", nome: null, email: null }, via: "api" })).toBe("utente a0000000");
    expect(nomeAttore({ attore: null, via: "timer:siri" })).toBe("sistema");
    // dopo 12 mesi il nome non c'è più: non si inventa niente
    expect(nomeAttore({ attore: null, via: "api" })).toBe("—");
  });

  it("i valori si mostrano come testo, anche se sembrano altro", () => {
    expect(mostraValore(null)).toBe("vuoto");
    expect(mostraValore("")).toBe("vuoto");
    expect(mostraValore(true)).toBe("sì");
    expect(mostraValore(12.5)).toBe("12.5");
    expect(mostraValore({ a: 1 })).toBe('{"a":1}');
    expect(mostraValore("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(mostraValore("x".repeat(500))).toHaveLength(241);
  });

  it("il confronto di una modifica: i campi cambiati, col valore dove il registro lo tiene", () => {
    expect(confronto({ operazione: "UPDATE", riepilogo: false, campi: ["name", "owner_user_id"], prima: { name: "A" }, dopo: { name: "B" } }))
      .toEqual([
        { campo: "name", prima: "A", dopo: "B", soloNome: false },
        { campo: "owner_user_id", prima: null, dopo: null, soloNome: true },
      ]);
    // utenti e roster: solo i nomi dei campi
    expect(confronto({ operazione: "UPDATE", riepilogo: false, campi: ["code"], prima: null, dopo: null }))
      .toEqual([{ campo: "code", prima: null, dopo: null, soloNome: true }]);
    // un valore tolto si vede come «vuoto», non come un campo senza valore
    expect(confronto({ operazione: "UPDATE", riepilogo: false, campi: ["notes"], prima: { notes: "x" }, dopo: { notes: null } }))
      .toEqual([{ campo: "notes", prima: "x", dopo: "vuoto", soloNome: false }]);
  });

  it("aggiunte e cancellazioni mostrano i valori che hanno; i riepiloghi niente", () => {
    expect(confronto({ operazione: "INSERT", riepilogo: false, campi: null, prima: null, dopo: { name: "N", is_shared: false } }))
      .toEqual([{ campo: "is_shared", prima: null, dopo: "no", soloNome: false }, { campo: "name", prima: null, dopo: "N", soloNome: false }]);
    expect(confronto({ operazione: "DELETE", riepilogo: false, campi: null, prima: { name: "N" }, dopo: null }))
      .toEqual([{ campo: "name", prima: "N", dopo: null, soloNome: false }]);
    expect(confronto({ operazione: "INSERT", riepilogo: false, campi: null, prima: null, dopo: null })).toEqual([]);
    expect(confronto({ operazione: "UPDATE", riepilogo: true, campi: ["arrival_time"], prima: null, dopo: null })).toEqual([]);
  });

  it("che cosa è successo, in una riga", () => {
    expect(descrizione({ operazione: "UPDATE", riepilogo: false, campi: ["name", "color"], righe: 1, aCascata: false })).toBe("name, color");
    expect(descrizione({ operazione: "INSERT", riepilogo: false, campi: null, righe: 1, aCascata: false })).toBe("riga aggiunta");
    expect(descrizione({ operazione: "DELETE", riepilogo: true, campi: null, righe: 60000, aCascata: true })).toBe("60.000 righe (di conseguenza)");
    expect(descrizione({ operazione: "UPDATE", riepilogo: true, campi: ["arrival_time"], righe: 1, aCascata: false })).toBe("1 riga: arrival_time");
    expect(descrizione({ operazione: "TRUNCATE", riepilogo: false, campi: null, righe: null, aCascata: false })).toBe("tabella svuotata");
  });
});

describe("il periodo e la richiesta", () => {
  it("si apre sugli ultimi 7 giorni, oggi compreso", () => {
    expect(periodoPredefinito(new Date(2026, 10, 9, 15, 30))).toEqual({ da: "2026-11-03", a: "2026-11-09" });
    expect(periodoPredefinito(new Date(2026, 0, 3))).toEqual({ da: "2025-12-28", a: "2026-01-03" });
  });

  it("dall'inizio del primo giorno alla fine dell'ultimo, 92 giorni al più", () => {
    const p = istanti("2026-11-03", "2026-11-09");
    if ("errore" in p) throw new Error(p.errore);
    expect(new Date(p.da).getTime()).toBe(new Date(2026, 10, 3).getTime());
    expect(new Date(p.a).getTime()).toBe(new Date(2026, 10, 9, 23, 59, 59, 999).getTime());
    expect(istanti("2026-11-09", "2026-11-09")).not.toHaveProperty("errore");
    expect(istanti("2026-11-10", "2026-11-09")).toEqual({ errore: "Il primo giorno viene dopo l'ultimo" });
    expect(istanti("2026-07-01", "2026-11-09")).toEqual({ errore: "Al più 92 giorni per volta" });
    expect(istanti("", "2026-11-09")).toHaveProperty("errore");
  });

  it("la richiesta porta solo periodo, tabella, operazione e ambito: niente per persona", () => {
    const r = richiesta(filtri({ tabella: "public.ps_trips", operazione: "UPDATE", ambitoTipo: "progetto_ps", ambitoId: " b0000000-0000-4000-8000-0000000000b1 " }), "abc");
    if ("errore" in r) throw new Error(r.errore);
    const q = new URL(r.percorso, "http://x").searchParams;
    expect([...q.keys()].sort()).toEqual(["a", "ambitoId", "ambitoTipo", "cursore", "da", "operazione", "tabella"]);
    expect(q.get("ambitoId")).toBe("b0000000-0000-4000-8000-0000000000b1");
    // l'ambito di una persona non si fissa: né l'utente né il conducente sono fra i filtrabili
    expect(AMBITI_FILTRABILI).not.toContain("utente");
    expect(AMBITI_FILTRABILI).not.toContain("conducente");
    expect(richiesta(filtri({ ambitoTipo: "conducente", ambitoId: "b0000000-0000-4000-8000-0000000000b1" }))).toHaveProperty("errore");
    expect(richiesta(filtri({ ambitoId: "b0000000-0000-4000-8000-0000000000b1" }))).toHaveProperty("errore");
    expect(richiesta(filtri({ ambitoTipo: "corsa", ambitoId: "non-un-id" }))).toEqual({ errore: "L'identificativo non è valido" });
    // tutte le persone insieme sì
    expect(richiesta(filtri({ ambitoTipo: "conducente" }))).toHaveProperty("percorso");
    expect(richiesta(filtri({ da: "2026-11-10" }))).toHaveProperty("errore");
  });
});
