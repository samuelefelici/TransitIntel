import { Router, type IRouter } from "express";
import { GetHealthResponse } from "@workspace/api-zod";
import { cacheSize } from "../middlewares/cache";
import { statoDelloSchema } from "../lib/guardia-schema";

const router: IRouter = Router();

/* Pubblica e senza toccare il database: lo stato dello schema è quello
 * dell'ultimo controllo (lib/guardia-schema.ts). 503 solo se il database è
 * indietro rispetto al codice: così l'HEALTHCHECK dell'immagine segna il
 * container come non sano e Coolify, nel deploy a rotazione, non gli manda
 * traffico. «sconosciuto» (database che non risponde, o primo controllo non
 * ancora fatto) resta 200, come prima. */
router.get("/healthz", (_req, res) => {
  const schema = statoDelloSchema();
  const indietro = schema === "indietro";
  const data = GetHealthResponse.parse({ status: indietro ? "schema-indietro" : "ok", schema });
  res.status(indietro ? 503 : 200).json({ ...data, cacheEntries: cacheSize() });
});

export default router;
