/**
 * Le cose comuni alle rotte delle tariffe (routes/fares.ts e
 * routes/fares-min-od.ts), scritte una volta:
 *   - le fasce chilometriche in vigore prima di ogni rotta delle tariffe;
 *   - come si risponde a un errore: 409 se mancano le fasce (lo dice il
 *     messaggio: le scrive l'amministratore), 500 per tutto il resto.
 */
import type { RequestHandler, Response } from "express";
import { SenzaFasce } from "../lib/fasce-km";
import { fasceLette } from "../lib/fasce-km-store";

/**
 * Prima di una rotta delle tariffe, le fasce lette almeno una volta
 * nell'ultimo minuto. Senza percorso di montaggio (l'inventario delle rotte
 * non li ammette): guarda da sé se la richiesta è delle tariffe. Non ferma
 * mai la richiesta.
 */
export const conLeFasce: RequestHandler = (req, _res, next) => {
  if (!req.path.startsWith("/fares")) { next(); return; }
  void fasceLette().then(() => next());
};

export function erroreTariffe(res: Response, e: any): void {
  res.status(e instanceof SenzaFasce ? 409 : 500).json({ error: e?.message ?? String(e) });
}
