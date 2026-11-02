/**
 * L'andamento dell'AVM e le richieste a Mizar (pagina AVM, scheda «Andamento»).
 *
 *   GET  /api/siri/parco/storia?settimane=4..52 &formato=xlsx &perimetro=conerobus &officina=1
 *   POST /api/siri/parco/richieste          { tipo, matricole[], richiestaIl?, nota? }
 *   POST /api/siri/parco/richieste/chiudi   { ids[], esito: "annullata" | "fatta" }
 *
 * Il permesso è quello di /siri/parco (centrale), per ogni metodo: lo dà
 * requirePermissionByPath. La GET chiude da sola le richieste che il diario
 * mostra già fatte (idempotente: tocca solo quelle ancora aperte).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { giornataOggi } from "../lib/service-day";
import { spostaGiorni, ultimaSettimanaChiusa } from "../lib/avm-controllo";
import {
  GIORNI_RICHIESTE_CHIUSE, MESI_CONSERVAZIONE_RICHIESTE, SETTIMANE_MASSIME, SOGLIE,
  calcolaStoria, giornateComplete, testiMizar, verificaRichieste, eConerobus,
} from "../lib/avm-storia";
import {
  chiudiRichieste, creaRichieste, leggiRichieste, leggiStoriaDiario, pulisciRichieste, registraVerifiche,
} from "../lib/avm-storia-store";
import { esportaStoriaXlsx } from "../lib/avm-storia-xlsx";
import { leggiInterventiAvm, leggiParcoOfficina, parcoCredibile } from "../lib/officina";
import { CAMPIONI_MINIMI_GIORNATA } from "../lib/avm-diario";

const router: IRouter = Router();

/* La pulizia delle richieste chiuse da più di 24 mesi: al massimo ogni 6 ore per processo. */
const PULIZIA_MS = 6 * 60 * 60 * 1000;
let ultimaPulizia = 0;

router.get("/siri/parco/storia", async (req, res): Promise<void> => {
  try {
    const n = Math.min(Math.max(Math.round(Number(req.query.settimane) || SETTIMANE_MASSIME), 4), SETTIMANE_MASSIME);
    const oggi = giornataOggi(new Date());
    const inizio = spostaGiorni(ultimaSettimanaChiusa(oggi), -7 * (n - 1));

    const diario = await leggiStoriaDiario(inizio, oggi);
    /* senza il diario non si dice niente: il parco intero risulterebbe «da aggiungere a SIRI» */
    if (diario.errore) {
      req.log.warn({ err: diario.errore }, "andamento AVM: diario non leggibile");
      res.status(503).json({ error: "Il diario dell'AVM non si legge in questo momento: riprova fra poco." });
      return;
    }
    /* il parco si confronta solo se il diario ha vetture Conerobus: con nessuna, parcoCredibile non ha
       niente da misurare e ogni mezzo sembrerebbe mai comparso nel flusso */
    const letto = await leggiParcoOfficina();
    const parco = diario.vetture.some(v => eConerobus(v.vehicleRef))
      ? parcoCredibile(letto, diario.vetture.map(v => v.vehicleRef))
      : { ...letto, disponibile: false, mezzi: [],
          motivo: "Il diario dell'AVM non ha vetture Conerobus nel periodo: il parco dell'officina non si può confrontare." };
    const interventi = await leggiInterventiAvm(inizio, parco);
    const chiuseDal = spostaGiorni(oggi, -GIORNI_RICHIESTE_CHIUSE);
    let { richieste, errore: erroreRichieste } = await leggiRichieste(chiuseDal);

    /* Le richieste che il diario mostra già fatte si chiudono adesso, con il giorno che il diario dice. */
    const contate = [...diario.campioni.entries()]
      .filter(([g, c]) => g < oggi && c >= CAMPIONI_MINIMI_GIORNATA)
      .map(([g]) => g)
      .sort();
    const presenze = new Map(diario.vetture.map(v => [v.vehicleRef, v.giorni]));
    /* per «togliere» contano solo le giornate in cui il flusso elenca quasi tutto il parco tipico */
    const chiusure = verificaRichieste(richieste, presenze, giornateComplete(contate, presenze), oggi);
    if (chiusure.length) {
      try {
        await registraVerifiche(chiusure);
        const giorno = new Map(chiusure.map(c => [c.id, c.chiusaIl]));
        richieste = richieste.map(r => giorno.has(r.id)
          ? { ...r, esito: "fatta" as const, chiusaIl: giorno.get(r.id)!, chiusaDa: null, automatica: true }
          : r);
      } catch (e: any) {
        req.log.warn({ err: e }, "richieste a Mizar: chiusura automatica non scritta");
      }
    }
    if (Date.now() - ultimaPulizia > PULIZIA_MS) {
      ultimaPulizia = Date.now();
      const limite = new Date(`${oggi}T00:00:00Z`);
      limite.setUTCMonth(limite.getUTCMonth() - MESI_CONSERVAZIONE_RICHIESTE);
      pulisciRichieste(limite.toISOString().slice(0, 10))
        .catch((e) => req.log.warn({ err: e }, "richieste a Mizar: pulizia non riuscita"));
    }

    const storia = calcolaStoria({
      oggi, inizio, campioni: diario.campioni, vetture: diario.vetture,
      parco, interventi: interventi.disponibile ? interventi.elenco : null, richieste,
    });
    const officina = {
      disponibile: parco.disponibile, motivo: parco.motivo, tenant: parco.tenant,
      lettoAlle: parco.lettoAlle, mezzi: parco.mezzi.length,
    };

    if (String(req.query.formato ?? "") === "xlsx") {
      /* come la pagina: «solo Conerobus» vale per tutto il foglio, «senza fuori parco e dismesse» solo per
         l'andamento (le vetture da togliere da SIRI sono proprio quelle) */
      const soloConerobus = String(req.query.perimetro ?? "") === "conerobus";
      const soloParco = req.query.officina === "1";
      const vetture = storia.vetture.filter(v => !soloConerobus || eConerobus(v.vehicleRef));
      const perAndamento = soloParco ? vetture.filter(v => !v.esclusa) : vetture;
      const perimetro = [soloConerobus ? "solo Conerobus" : null, soloParco ? "andamento senza fuori parco e dismesse" : null]
        .filter(Boolean).join(", ");
      const xlsx = esportaStoriaXlsx(storia, vetture, { perimetro, officina, andamento: perAndamento });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        `attachment; filename="Cerbero-andamento-AVM-${oggi}${soloConerobus ? "-conerobus" : ""}.xlsx"`);
      res.send(xlsx);
      return;
    }

    res.json({
      ...storia,
      testiMizar: testiMizar(storia),
      officina,
      fonteInterventi: { disponibile: interventi.disponibile, motivo: interventi.motivo },
      soglie: SOGLIE,
      errore: diario.errore ?? erroreRichieste,
    });
  } catch (e: any) {
    req.log.error({ err: e }, "andamento AVM non calcolato");
    res.status(500).json({ error: "Andamento AVM non calcolato: riprova fra poco." });
  }
});

/* ── Le richieste a Mizar ─────────────────────────────────────────────── */

const GIORNO = /^\d{4}-\d{2}-\d{2}$/;
const giornoValido = (g: string) =>
  GIORNO.test(g) && !Number.isNaN(new Date(`${g}T00:00:00Z`).getTime())
  && new Date(`${g}T00:00:00Z`).toISOString().slice(0, 10) === g;

const nuovaRichiesta = z.object({
  tipo: z.enum(["togliere", "aggiungere"], { message: "Il tipo è «togliere» o «aggiungere»." }),
  matricole: z.array(z.string().trim().regex(/^\d{1,5}$/, "Una matricola è un numero di 1-5 cifre."))
    .min(1, "Indica almeno una matricola.")
    .max(300, "Al massimo 300 matricole per volta."),
  richiestaIl: z.string().refine(giornoValido, "La data si scrive AAAA-MM-GG.").optional(),
  nota: z.string().trim().max(500, "La nota è lunga al massimo 500 caratteri.").optional(),
}).strict();

const chiusura = z.object({
  ids: z.array(z.string().uuid("Richiesta sconosciuta.")).min(1, "Indica almeno una richiesta.").max(300),
  esito: z.enum(["annullata", "fatta"], { message: "L'esito è «annullata» o «fatta»." }),
}).strict();

function primoErrore(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Richiesta non valida.";
}

router.post("/siri/parco/richieste", async (req, res): Promise<void> => {
  if (!req.is("application/json")) { res.status(415).json({ error: "Il corpo va mandato in JSON." }); return; }
  const p = nuovaRichiesta.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: primoErrore(p.error) }); return; }
  const oggi = giornataOggi(new Date());
  const richiestaIl = p.data.richiestaIl ?? oggi;
  if (richiestaIl > oggi) { res.status(400).json({ error: "La data della richiesta non può essere nel futuro." }); return; }
  if (richiestaIl < spostaGiorni(oggi, -90)) {
    res.status(400).json({ error: "La data della richiesta è di più di 90 giorni fa." });
    return;
  }
  const matricole = [...new Set(p.data.matricole.map(m => m.trim()))];
  try {
    const esito = await creaRichieste({
      tipo: p.data.tipo, matricole, richiestaIl, nota: p.data.nota || null, utenteId: req.user?.id ?? null,
    });
    res.status(201).json(esito);
  } catch (e: any) {
    req.log.error({ err: e }, "richieste a Mizar non salvate");
    res.status(500).json({ error: "Richieste non salvate: riprova fra poco." });
  }
});

router.post("/siri/parco/richieste/chiudi", async (req, res): Promise<void> => {
  if (!req.is("application/json")) { res.status(415).json({ error: "Il corpo va mandato in JSON." }); return; }
  const p = chiusura.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: primoErrore(p.error) }); return; }
  try {
    const chiuse = await chiudiRichieste([...new Set(p.data.ids)], p.data.esito, req.user?.id ?? null,
      giornataOggi(new Date()));
    res.json({ chiuse });
  } catch (e: any) {
    req.log.error({ err: e }, "richieste a Mizar non chiuse");
    res.status(500).json({ error: "Richieste non chiuse: riprova fra poco." });
  }
});

export default router;
