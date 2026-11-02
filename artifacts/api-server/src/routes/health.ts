import { Router, type IRouter } from "express";
import { GetHealthResponse } from "@workspace/api-zod";
import { cacheSize } from "../middlewares/cache";
import { attendiPrimoControllo, fuoriServizio, statoDelloSchema } from "../lib/guardia-schema";

const router: IRouter = Router();

/* Pubblica. Lo stato dello schema è quello dell'ultimo controllo
 * (lib/guardia-schema.ts); la prima sonda dopo l'avvio aspetta il primo
 * controllo, al massimo 3 s. 503 solo se lo schema è indietro e questo
 * container non è mai stato allineato: così, nel deploy a rotazione, Coolify
 * non manda traffico a un'API più nuova del suo database. Un container che
 * era in servizio non si toglie (lo dice il log). «sconosciuto» (database che
 * non risponde) resta 200, come prima. */
router.get("/healthz", async (_req, res) => {
  await attendiPrimoControllo(3_000);
  const schema = statoDelloSchema();
  const fuori = fuoriServizio();
  const data = GetHealthResponse.parse({ status: fuori ? "schema-indietro" : "ok", schema });
  res.status(fuori ? 503 : 200).json({ ...data, cacheEntries: cacheSize() });
});

export default router;
