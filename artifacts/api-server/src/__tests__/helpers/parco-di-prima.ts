/**
 * Il parco del primo cliente nel canale dell'AVM, com'era scritto nel codice
 * fino alla tappa 6.21: per i test che provano le regole su dati veri. Lo
 * stesso che la migrazione 0049 mette nelle tabelle per quell'azienda.
 */
import dati from "./parco-di-prima.json";
import type { ParcoAzienda } from "../../lib/parco-anagrafica";

export const PARCO_DI_PRIMA: ParcoAzienda = {
  consorziate: dati.consorziate,
  eccezioni: dati.eccezioni,
  vetture: dati.vetture,
};
