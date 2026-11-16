/**
 * Il consuntivo delle giornate di esercizio (tappa 4.5): l'area «Consuntivo»
 * dei ruoli (lib/permessi-rotte.ts, prefisso /esercizio). Chi la legge vede
 * giornate, corse, proposte, esiti e giornale; chi la scrive registra gli
 * eventi e conferma gli esiti (lib/esercizio-giornale.ts).
 *
 * Gli esiti li decide una persona: i token di servizio (Argos) leggono ma
 * non scrivono.
 *
 *   GET  /api/esercizio/oggi                       la giornata in corso in breve e le giornate da chiudere (4.9, pagina Oggi)
 *   GET  /api/esercizio/giornate?dal=&al=          l'elenco (al più un anno; senza: gli ultimi 30 e domani)
 *   GET  /api/esercizio/giornate/:giorno           la giornata con corse, esiti, proposta, giornale, causali
 *   POST /api/esercizio/giornate/:giorno/eventi    un evento del giornale (esito, conferma, aggiunta, annullamento, nota)
 *   POST /api/esercizio/giornate/:giorno/proposta  ricalcola la proposta dall'AVM
 *   GET  /api/esercizio/causali                    il catalogo delle causali attive
 *   POST /api/esercizio/giornate/:giorno/chiusura  chiude la giornata (4.6: ruolo Amministrazione o amministratore)
 *   GET  /api/esercizio/mesi/:mese                 lo stato di un mese (AAAA-MM): giornate, mancanti, riepilogo
 *   GET  /api/esercizio/mesi/:mese/report          il report del mese (4.7): indicatori e ripartizioni
 *   GET  /api/esercizio/mesi/:mese/report.xlsx     lo stesso in XLSX
 *   GET  /api/esercizio/mesi/:mese/dettaglio.csv   il dettaglio corsa per corsa delle giornate chiuse
 *
 * Riaprire una giornata e chiudere o riaprire un mese: solo l'amministratore
 * (routes/admin.ts, /admin/esercizio/…).
 */
import { Router, type IRouter } from "express";
import { elencoGiornate, giornoValido, leggiGiornata } from "../lib/esercizio-giornate";
import { calcolaProposta, RifiutoProposta } from "../lib/esercizio-proposta";
import { elencoCausali, leggiGiornale, leggiRichiesta, registraEvento, RifiutoGiornale } from "../lib/esercizio-giornale";
import { chiudiGiornata, chiusuraDellaGiornata, meseValido, RifiutoChiusura, statoDelMese } from "../lib/esercizio-chiusura";
import { chiudeLeGiornate } from "@workspace/permessi";
import { dettaglioCsv, reportDelMese, reportXlsx } from "../lib/esercizio-report";
import { aziendaOppureNeutra } from "../lib/azienda";
import { esercizioInBreve } from "../lib/esercizio-oggi";
import { giornataOggi } from "../lib/service-day";

const router: IRouter = Router();

const oggiRoma = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const piuGiorni = (g: string, n: number) => {
  const d = new Date(`${g}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Gli esiti li decide una persona: un token di servizio legge e basta. */
const daUnServizio = (req: any) => typeof req.authVia === "string" && req.authVia.length > 0;

/* La giornata in corso in breve, per la pagina Oggi (4.9): solo conteggi, e le giornate da chiudere. */
router.get("/esercizio/oggi", async (req, res): Promise<void> => {
  try {
    res.json(await esercizioInBreve(giornataOggi()));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "consuntivo: giornata in breve non leggibile");
    res.status(500).json({ error: "Giornata non leggibile" });
  }
});

router.get("/esercizio/giornate", async (req, res): Promise<void> => {
  const oggi = oggiRoma();
  const dal = req.query.dal === undefined ? piuGiorni(oggi, -30) : String(req.query.dal);
  const al = req.query.al === undefined ? piuGiorni(oggi, 1) : String(req.query.al);
  if (!giornoValido(dal) || !giornoValido(al) || dal > al || Date.parse(al) - Date.parse(dal) > 366 * 86_400_000) {
    res.status(400).json({ error: "dal e al: date vere, AAAA-MM-GG, al più un anno" });
    return;
  }
  try {
    res.json({ dal, al, giornate: await elencoGiornate(dal, al) });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "consuntivo: giornate non leggibili");
    res.status(500).json({ error: "Giornate non leggibili" });
  }
});

router.get("/esercizio/giornate/:giorno", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  try {
    const g = await leggiGiornata(giorno);
    if (!g) { res.status(404).json({ error: "Giornata non ancora preparata" }); return; }
    res.json({ ...g, giornale: await leggiGiornale(giorno), causali: await elencoCausali(), chiusura: await chiusuraDellaGiornata(giorno) });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, giorno }, "consuntivo: giornata non leggibile");
    res.status(500).json({ error: "Giornata non leggibile" });
  }
});

router.post("/esercizio/giornate/:giorno/eventi", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  if (daUnServizio(req)) { res.status(403).json({ error: "Gli esiti li conferma una persona" }); return; }
  const l = leggiRichiesta(req.body);
  if ("errore" in l) { res.status(400).json({ error: l.errore }); return; }
  try {
    res.json(await registraEvento(giorno, l.richiesta, { id: (req as any).user?.id ?? null }));
  } catch (e: any) {
    if (e instanceof RifiutoGiornale) { res.status(e.status).json({ error: e.message }); return; }
    req.log?.error?.({ err: e?.message, giorno }, "consuntivo: evento non registrato");
    res.status(500).json({ error: "Evento non registrato" });
  }
});

router.post("/esercizio/giornate/:giorno/proposta", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  if (daUnServizio(req)) { res.status(403).json({ error: "La proposta la chiede una persona" }); return; }
  try {
    res.json(await calcolaProposta(giorno));
  } catch (e: any) {
    if (e instanceof RifiutoProposta) { res.status(e.status).json({ error: e.message }); return; }
    req.log?.error?.({ err: e?.message, giorno }, "consuntivo: proposta non riuscita");
    res.status(500).json({ error: "Proposta non riuscita" });
  }
});

router.post("/esercizio/giornate/:giorno/chiusura", async (req, res): Promise<void> => {
  const giorno = String(req.params.giorno);
  if (!giornoValido(giorno)) { res.status(400).json({ error: "giorno: una data vera, AAAA-MM-GG" }); return; }
  const u = (req as any).user;
  if (daUnServizio(req) || !u || !chiudeLeGiornate({ admin: u.role === "admin", ruoli: u.ruoli ?? [] })) {
    res.status(403).json({ error: "La giornata la chiude chi ha il ruolo Amministrazione" });
    return;
  }
  const versione = Number((req.body ?? {}).versione);
  if (!Number.isInteger(versione) || versione < 0) { res.status(400).json({ error: "versione: un intero" }); return; }
  try {
    res.json(await chiudiGiornata(giorno, versione, u.id ?? null));
  } catch (e: any) {
    if (e instanceof RifiutoChiusura) { res.status(e.status).json({ error: e.message }); return; }
    req.log?.error?.({ err: e?.message, giorno }, "consuntivo: chiusura non riuscita");
    res.status(500).json({ error: "Chiusura non riuscita" });
  }
});

router.get("/esercizio/mesi/:mese", async (req, res): Promise<void> => {
  const mese = String(req.params.mese);
  if (!meseValido(mese)) { res.status(400).json({ error: "mese: AAAA-MM" }); return; }
  try {
    res.json(await statoDelMese(mese));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, mese }, "consuntivo: mese non leggibile");
    res.status(500).json({ error: "Mese non leggibile" });
  }
});

router.get("/esercizio/mesi/:mese/report", async (req, res): Promise<void> => {
  const mese = String(req.params.mese);
  if (!meseValido(mese)) { res.status(400).json({ error: "mese: AAAA-MM" }); return; }
  try {
    res.json(await reportDelMese(mese));
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, mese }, "consuntivo: report non riuscito");
    res.status(500).json({ error: "Report non riuscito" });
  }
});

router.get("/esercizio/mesi/:mese/report.xlsx", async (req, res): Promise<void> => {
  const mese = String(req.params.mese);
  if (!meseValido(mese)) { res.status(400).json({ error: "mese: AAAA-MM" }); return; }
  try {
    const azienda = await aziendaOppureNeutra().catch(() => null);
    const file = reportXlsx(await reportDelMese(mese), azienda?.compilata ? azienda.nome : null);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="consuntivo-${mese}.xlsx"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(file);
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, mese }, "consuntivo: XLSX non riuscito");
    if (!res.headersSent) res.status(500).json({ error: "Report non riuscito" });
  }
});

router.get("/esercizio/mesi/:mese/dettaglio.csv", async (req, res): Promise<void> => {
  const mese = String(req.params.mese);
  if (!meseValido(mese)) { res.status(400).json({ error: "mese: AAAA-MM" }); return; }
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="consuntivo-${mese}-corse.csv"`);
    res.setHeader("Cache-Control", "no-store");
    await dettaglioCsv(mese, (pezzo) => { res.write(pezzo); });
    res.end();
  } catch (e: any) {
    req.log?.error?.({ err: e?.message, mese }, "consuntivo: CSV non riuscito");
    if (!res.headersSent) res.status(500).json({ error: "Dettaglio non riuscito" });
    else res.end();
  }
});

router.get("/esercizio/causali", async (req, res): Promise<void> => {
  try {
    res.json({ causali: await elencoCausali() });
  } catch (e: any) {
    req.log?.error?.({ err: e?.message }, "consuntivo: causali non leggibili");
    res.status(500).json({ error: "Causali non leggibili" });
  }
});

export default router;
