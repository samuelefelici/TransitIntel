/**
 * Le risposte grandi dell'API, compresse (tappa 6.19b).
 *
 * L'API non comprimeva niente: la mappa delle linee della dashboard, su un
 * feed vero, è un JSON di 18 MB; compresso con brotli è meno di 1 MB. Qui si
 * comprime con lo zlib di Node (nessuna dipendenza nuova):
 *  - solo i testi (JSON, CSV, XML, testo) sopra SOGLIA_BYTE: sotto non conviene;
 *  - brotli se il client lo accetta, altrimenti gzip, altrimenti niente;
 *  - mai le risposte di /api/auth: un segreto e un testo scelto da chi chiede
 *    nella stessa risposta compressa fanno trapelare il segreto dalla
 *    lunghezza (BREACH);
 *  - mai ciò che passa per res.write o per uno stream (gli eventi della chat,
 *    i file): si tocca solo res.send, dove passano res.json e la cache.
 *
 * Sotto SINCRONO_BYTE si comprime subito, come prima si mandava; sopra la
 * compressione gira nei thread di libuv e la risposta parte quando è pronta,
 * così 18 MB non fermano le altre richieste per un decimo di secondo.
 */
import zlib from "node:zlib";
import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export const SOGLIA_BYTE = 16 * 1024;
export const SINCRONO_BYTE = 1024 * 1024;

/** I tipi che si comprimono: testo, JSON e XML (anche i «+json» e «+xml»). */
const COMPRIMIBILI = /^(?:text\/(?:plain|csv|xml|html|css|javascript)|application\/(?:json|xml|javascript|x-ndjson|[a-z0-9.+-]*\+(?:json|xml)))(?:\s*;|$)/i;

export function comprimibile(tipo: string | number | string[] | undefined): boolean {
  return typeof tipo === "string" && COMPRIMIBILI.test(tipo.trim());
}

type Codifica = "br" | "gzip";

const OPZIONI_BR: zlib.BrotliOptions = {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT },
};
const OPZIONI_GZIP: zlib.ZlibOptions = { level: 4 };

function comprimiSubito(dati: Buffer, c: Codifica): Buffer {
  return c === "br" ? zlib.brotliCompressSync(dati, OPZIONI_BR) : zlib.gzipSync(dati, OPZIONI_GZIP);
}

function comprimiDopo(dati: Buffer, c: Codifica, fatto: (err: Error | null, out?: Buffer) => void): void {
  if (c === "br") zlib.brotliCompress(dati, OPZIONI_BR, fatto);
  else zlib.gzip(dati, OPZIONI_GZIP, fatto);
}

export function comprimiRisposte(req: Request, res: Response, next: NextFunction): void {
  /* login, sessione, MFA: niente compressione (BREACH) */
  if (req.path.startsWith("/api/auth")) { next(); return; }

  const invia = res.send.bind(res);
  res.send = function inviaCompresso(body?: unknown): Response {
    /* un oggetto: Express lo passa a res.json, che torna qui con il testo */
    if (typeof body !== "string" && !Buffer.isBuffer(body)) return invia(body);
    const dati = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    if (
      dati.length < SOGLIA_BYTE
      || req.method === "HEAD"
      || res.statusCode === 204 || res.statusCode === 304
      || res.getHeader("Content-Encoding")
      || /\bno-transform\b/i.test(String(res.getHeader("Cache-Control") ?? ""))
      || !comprimibile(res.getHeader("Content-Type"))
    ) return invia(body);

    /* la risposta dipende da Accept-Encoding: chi tiene copie lo deve sapere */
    res.vary("Accept-Encoding");
    /* brotli quando è accettato (comprime il doppio di gzip, nello stesso tempo),
     * anche se il browser elenca prima gzip; un q=0 vale come rifiuto */
    const c: Codifica | null = req.acceptsEncodings("br") === "br" ? "br"
      : req.acceptsEncodings("gzip") === "gzip" ? "gzip" : null;
    if (!c) return invia(body);

    /* Express al testo aggiunge charset=utf-8; a un Buffer no: lo si mette qui */
    if (typeof body === "string") {
      const tipo = String(res.getHeader("Content-Type"));
      if (!/;\s*charset=/i.test(tipo)) res.setHeader("Content-Type", `${tipo}; charset=utf-8`);
    }
    const pronta = (out: Buffer) => {
      res.setHeader("Content-Encoding", c);
      res.removeHeader("Content-Length");
      return invia(out);
    };

    if (dati.length < SINCRONO_BYTE) {
      let out: Buffer;
      try { out = comprimiSubito(dati, c); } catch { return invia(body); }
      return pronta(out);
    }

    comprimiDopo(dati, c, (err, out) => {
      /* nel frattempo qualcuno ha già risposto (un errore, un secondo invio):
       * questa risposta non parte più */
      if (res.headersSent || res.writableEnded) {
        logger.warn({ url: req.originalUrl }, "risposta compressa scartata: era già partita un'altra risposta");
        return;
      }
      try {
        if (err || !out) invia(body);
        else pronta(out);
      } catch (e) {
        logger.error({ err: e, url: req.originalUrl }, "invio della risposta compressa non riuscito");
      }
    });
    return res;
  } as Response["send"];
  next();
}
