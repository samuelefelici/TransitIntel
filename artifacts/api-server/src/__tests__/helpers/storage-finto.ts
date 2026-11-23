/**
 * Uno storage S3 finto per i test della copia del database (tappa 7.23): un
 * server HTTP su 127.0.0.1, con gli indirizzi per percorso (/bucket/chiave).
 * Come uno vero, rifiuta una firma che non torna (403
 * SignatureDoesNotMatch) e un corpo il cui SHA-256 non è quello dichiarato
 * (400 XAmzContentSHA256Mismatch). Tiene gli oggetti in memoria.
 */
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { firma, type ConfigS3 } from "../../../../../lib/db/scripts/copia-cifrata.mjs";

export interface StorageFinto {
  config: ConfigS3;
  oggetti: Map<string, Buffer>;
  richieste: { metodo: string; percorso: string; firmaValida: boolean; hashValido: boolean | null }[];
  /** se impostata, la prossima GET restituisce questi byte al posto dell'oggetto (una copia rovinata nello storage) */
  rovinaProssimaLettura: Buffer | null;
  chiudi(): Promise<void>;
}

const BUCKET = "copie-di-prova";
const ACCESSO = "ACCESSO-DI-PROVA";
const SEGRETO = "segreto-di-prova-1234";

const errore = (res: http.ServerResponse, stato: number, codice: string) =>
  res.writeHead(stato, { "content-type": "application/xml" })
    .end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${codice}</Code><Message>prova</Message></Error>`);

export async function storageFinto(): Promise<StorageFinto> {
  const oggetti = new Map<string, Buffer>();
  const richieste: StorageFinto["richieste"] = [];
  const s: Partial<StorageFinto> = { oggetti, richieste, rovinaProssimaLettura: null };
  const server = http.createServer((req, res) => {
    const pezzi: Buffer[] = [];
    req.on("data", (p: Buffer) => pezzi.push(p));
    req.on("end", () => {
      const corpo = Buffer.concat(pezzi);
      const auth = String(req.headers.authorization ?? "");
      const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(auth);
      const amz = String(req.headers["x-amz-date"] ?? "");
      const hashDichiarato = String(req.headers["x-amz-content-sha256"] ?? "");
      let firmaValida = false;
      if (m && /^\d{8}T\d{6}Z$/.test(amz)) {
        const quando = new Date(`${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`);
        const intestazioni: Record<string, string> = {};
        for (const h of m[4].split(";")) {
          if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(h)) intestazioni[h] = String(req.headers[h] ?? "");
        }
        const attesa = firma({
          metodo: req.method!, url: `http://${req.headers.host}${req.url}`, intestazioni, hashCorpo: hashDichiarato,
          accesso: ACCESSO, segreto: SEGRETO, regione: "prova", quando,
        });
        firmaValida = m[1] === ACCESSO && m[3] === "prova" && attesa.firma === m[5];
      }
      const u = new URL(`http://x${req.url}`);
      const [, bucket, ...resto] = u.pathname.split("/");
      const chiave = resto.map(decodeURIComponent).join("/");
      const hashValido = req.method === "PUT" ? createHash("sha256").update(corpo).digest("hex") === hashDichiarato : null;
      richieste.push({ metodo: req.method!, percorso: u.pathname, firmaValida, hashValido });
      if (!firmaValida) return errore(res, 403, "SignatureDoesNotMatch");
      if (bucket !== BUCKET) return errore(res, 404, "NoSuchBucket");
      if (req.method === "PUT") {
        if (!hashValido) return errore(res, 400, "XAmzContentSHA256Mismatch");
        oggetti.set(chiave, corpo);
        return res.writeHead(200, { etag: '"x"' }).end();
      }
      if (req.method === "GET" && !chiave && u.searchParams.get("list-type") === "2") {
        const prefisso = u.searchParams.get("prefix") ?? "";
        const voci = [...oggetti.entries()].filter(([k]) => k.startsWith(prefisso))
          .map(([k, v]) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>2026-11-23T03:00:00.000Z</LastModified><Size>${v.length}</Size></Contents>`);
        return res.writeHead(200, { "content-type": "application/xml" })
          .end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${voci.join("")}</ListBucketResult>`);
      }
      if (req.method === "GET") {
        const o = oggetti.get(chiave);
        if (!o) return errore(res, 404, "NoSuchKey");
        const dati = s.rovinaProssimaLettura ?? o;
        s.rovinaProssimaLettura = null;
        return res.writeHead(200, { "content-length": String(dati.length) }).end(dati);
      }
      return errore(res, 405, "MethodNotAllowed");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const porta = (server.address() as AddressInfo).port;
  s.config = {
    endpoint: `http://127.0.0.1:${porta}`, regione: "prova", bucket: BUCKET, prefisso: "cerbero/", stile: "percorso",
    accesso: ACCESSO, segreto: SEGRETO,
  };
  s.chiudi = () => new Promise<void>((ok) => server.close(() => ok()));
  return s as StorageFinto;
}

/** Le variabili BACKUP_S3_* che puntano allo storage finto. */
export function ambienteS3(s: StorageFinto): Record<string, string> {
  return {
    BACKUP_S3_ENDPOINT: s.config.endpoint, BACKUP_S3_REGIONE: s.config.regione, BACKUP_S3_BUCKET: s.config.bucket,
    BACKUP_S3_ACCESS_KEY: ACCESSO, BACKUP_S3_SECRET_KEY: SEGRETO,
  };
}
