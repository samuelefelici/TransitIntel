/**
 * Chi fa la modifica, per le richieste HTTP (PR 2.9): il contesto che il pool
 * porta sulla connessione al database (lib/db/src/contesto.ts).
 *
 * - contestoRichiesta: ogni richiesta parte come «api», con il suo id
 *   (x-request-id, o quello generato da pino);
 * - requireAuth (lib/auth.ts) aggiunge l'utente e il canale del token;
 * - contestoCron: le rotte /cron/* (pubbliche, col segreto controllato da ogni
 *   rotta) scrivono come «cron:<nome>»;
 * - Caronte scrive come «caronte» (routes/caronte.ts).
 */
import { AsyncResource } from "node:async_hooks";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { conContesto, contestoDb } from "@workspace/db/contesto";

export function contestoRichiesta(req: Request, _res: Response, next: NextFunction): void {
  contestoDb.run({ via: "api", richiesta: String(req.id ?? "") }, next);
}

/**
 * Per i middleware che chiamano `next` da un evento del socket (multer, che
 * legge il file con busboy): lì il contesto async della richiesta si perde, e
 * le scritture dopo l'upload non saprebbero più chi è l'utente. `next` si lega
 * al contesto di quando il middleware parte. Ogni `upload.single/fields/…` va
 * avvolto (lo controlla contesto-http.test.ts).
 */
export function legaContesto(mw: RequestHandler): RequestHandler {
  return (req, res, next) => mw(req, res, AsyncResource.bind(next));
}

/** Da montare su "/cron": il nome è il primo pezzo del percorso (traffic, argos-watch, …). */
export function contestoCron(req: Request, _res: Response, next: NextFunction): void {
  const nome = (req.path.split("/").filter(Boolean)[0] ?? "").replace(/[^a-z0-9-]/gi, "").slice(0, 40);
  conContesto({ via: `cron:${nome}` }, next);
}
