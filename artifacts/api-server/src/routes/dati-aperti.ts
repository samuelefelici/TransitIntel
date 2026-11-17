/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DATI APERTI — il GTFS e il NeTEx a un indirizzo stabile (tappa 6.3)
 * ───────────────────────────────────────────────────────────────────────────
 * Gli indirizzi che si registrano al NAP: non cambiano, e non chiedono il
 * login (sono dati che l'azienda pubblica).
 *
 *   GET /api/dati-aperti                 che cosa c'è in linea (JSON)
 *   GET /api/dati-aperti/gtfs.zip        il GTFS della versione in esercizio
 *   GET /api/dati-aperti/netex.xml.gz    lo stesso programma in NeTEx,
 *                                        profilo italiano livello 1
 *
 * I file sono già pronti in tabella (lib/dati-aperti.ts): qui si consegnano i
 * byte. L'impronta del file è la sua ETag: chi lo ha già (If-None-Match, o
 * If-Modified-Since) riceve 304 senza che i byte si leggano. Con la
 * pubblicazione spenta, o senza un file in linea, 404.
 *
 * Auth: nessuna: il router è montato PRIMA di requireAuth, senza prefisso (le
 * rotte hanno il percorso intero, come le condivisioni). Un limite suo (30 richieste al minuto per indirizzo), più stretto di quello
 * generale: sono file da qualche megabyte, e chi li scarica lo fa una volta
 * al giorno.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { leggiAzienda } from "../lib/azienda";
import { contenutoInLinea, fileInLinea, FILE, TIPI, type FileInLinea, type TipoFile } from "../lib/dati-aperti";

const router: IRouter = Router();

const limite = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Troppe richieste, riprova tra un minuto." },
});

/* Sono rotte pubbliche: fuori un messaggio generico, i dettagli nel log. */
function guasto(req: Request, res: Response, e: unknown): void {
  req.log?.error?.({ err: (e as any)?.message }, "dati aperti: richiesta non riuscita");
  res.status(500).json({ error: "File temporaneamente non disponibile" });
}

const NON_PUBBLICATO = { error: "Nessun file pubblicato a questo indirizzo" };

/** L'ETag del file: la sua impronta SHA-256, forte. */
const etag = (f: FileInLinea) => `"${f.impronta}"`;

/** Chi chiede ha già questo file? Prima If-None-Match; senza, If-Modified-Since. */
export function giaCeLHa(f: FileInLinea, intestazioni: { "if-none-match"?: string; "if-modified-since"?: string }): boolean {
  const inm = intestazioni["if-none-match"];
  if (inm) {
    if (inm.trim() === "*") return true;
    return inm.split(",").some((v) => v.trim().replace(/^W\//, "") === etag(f));
  }
  const ims = intestazioni["if-modified-since"];
  if (!ims) return false;
  const da = Date.parse(ims);
  /* Last-Modified va al secondo: si confronta al secondo */
  return Number.isFinite(da) && Math.floor(f.preparatoIl.getTime() / 1000) * 1000 <= da;
}

function intestazioni(res: Response, tipo: TipoFile, f: FileInLinea): void {
  res.setHeader("ETag", etag(f));
  res.setHeader("Last-Modified", f.preparatoIl.toUTCString());
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Type", FILE[tipo].mime);
  res.setHeader("Content-Disposition", `attachment; filename="${FILE[tipo].nome}"`);
}

const consegna = (tipo: TipoFile) => async (req: Request, res: Response): Promise<void> => {
  try {
    const f = await fileInLinea(tipo);
    if (!f) { res.status(404).json(NON_PUBBLICATO); return; }
    intestazioni(res, tipo, f);
    if (giaCeLHa(f, req.headers as any)) { res.status(304).end(); return; }
    if (req.method === "HEAD") { res.setHeader("Content-Length", String(f.byte)); res.status(200).end(); return; }
    const byte = await contenutoInLinea(tipo, f.impronta);
    /* cambiato fra le due letture: chi scarica riprova e trova quello nuovo */
    if (!byte) { res.removeHeader("ETag"); res.removeHeader("Last-Modified"); res.setHeader("Retry-After", "5"); res.status(503).json({ error: "Il file è appena cambiato: riprova" }); return; }
    res.setHeader("Content-Length", String(byte.length));
    res.status(200).end(byte);
  } catch (e) { guasto(req, res, e); }
};

router.get("/dati-aperti/gtfs.zip", limite, consegna("gtfs"));
router.get("/dati-aperti/netex.xml.gz", limite, consegna("netex"));

/* GET /api/dati-aperti — che cosa c'è in linea: per chi registra gli indirizzi, o li controlla */
router.get("/dati-aperti", limite, async (req: Request, res: Response): Promise<void> => {
  try {
    const file = [];
    for (const tipo of TIPI) {
      const f = await fileInLinea(tipo);
      if (!f) continue;
      file.push({
        tipo, formato: FILE[tipo].formato, percorso: FILE[tipo].percorso,
        byte: f.byte, sha256: f.impronta,
        preparato_il: f.preparatoIl.toISOString(),
        in_esercizio_dal: f.inEsercizioDal ? f.inEsercizioDal.toISOString() : null,
      });
    }
    if (file.length === 0) { res.status(404).json(NON_PUBBLICATO); return; }
    const azienda = await leggiAzienda();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ azienda: azienda.ragioneSociale, file });
  } catch (e) { guasto(req, res, e); }
});

export default router;
