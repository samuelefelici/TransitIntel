/* ═══════════════════════════════════════════════════════════════
 *  L'AMBITO DI UN CALCOLO DEI TURNI GUIDA
 *
 *  Tre scelte che valgono per un calcolo e non fanno parte del profilo
 *  di regole: su quali cluster di cambio si può tagliare, i vincoli
 *  globali di soluzione (BDSI cap. 14) e i costi avanzati (BDS5).
 *
 *  Qui c'è la sola regola che le unisce alla configurazione dell'operatore
 *  nella forma che l'API e il solver leggono:
 *    - selectedClusterIds        → l'API filtra i cluster passati al solver
 *    - bds.vincoliGlobali        → crew_scheduler_v4.apply_vincoli_globali_config
 *    - bds.costiAvanzati, bds.cuts → crew_scheduler_v4.apply_bds5_config
 *  Niente interfaccia: il pannello è in AmbitoDelCalcoloPanel.tsx.
 * ═══════════════════════════════════════════════════════════════ */
import type { OperatorConfig } from "@/hooks/use-crew-optimization";
import { bds5ToSolverConfig, EMPTY_BDS5, type Bds5Config } from "./bds5-config";
import type { VincoloGlobale } from "./types";

export interface AmbitoDelCalcolo {
  /** Gli id dei cluster di cambio scelti. `null` = nessuna scelta: tutti. */
  clusterScelti: string[] | null;
  vincoliGlobali: VincoloGlobale[];
  bds5: Bds5Config;
}

export const AMBITO_VUOTO: AmbitoDelCalcolo = {
  clusterScelti: null,
  vincoliGlobali: [],
  bds5: EMPTY_BDS5,
};

/** Un numero vero e non negativo: il solver scarta il resto. */
function limite(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Il solver accetta un vincolo solo se ha almeno una tipologia e almeno un
 * limite; gli altri li scarta in silenzio. Serve a dire all'operatore quanti
 * dei vincoli che ha scritto conteranno davvero.
 */
export function vincoloAttivo(v: VincoloGlobale): boolean {
  if (!Array.isArray(v.tipologie) || v.tipologie.length === 0) return false;
  if (v.tipo === "numerico") return limite(v.min) || limite(v.max);
  if (v.tipo === "percentuale") return limite(v.minPct) || limite(v.maxPct);
  if (v.tipo === "media") return !!v.misura && (limite(v.minMin) || limite(v.maxMin));
  return false;
}

/**
 * I cluster da mandare all'API. Per l'API un elenco vuoto vale «tutti»: qui
 * lo stesso caso non manda niente, così la richiesta dice quello che succede.
 */
export function clusterDaMandare(scelti: string[] | null): string[] | null {
  if (!scelti) return null;
  const unici = [...new Set(scelti.filter(id => typeof id === "string" && id.length > 0))];
  return unici.length > 0 ? unici : null;
}

/** Quante delle tre scelte sono in uso (per il numero accanto al pulsante). */
export function scelteAttive(ambito: AmbitoDelCalcolo): number {
  return (clusterDaMandare(ambito.clusterScelti) ? 1 : 0)
    + (ambito.vincoliGlobali.some(vincoloAttivo) ? 1 : 0)
    + (bds5ToSolverConfig(ambito.bds5) ? 1 : 0);
}

/**
 * La configurazione dell'operatore con dentro l'ambito del calcolo.
 * Senza scelte restituisce la configurazione di partenza così com'è: chi non
 * tocca il pannello manda al solver quello che mandava prima.
 */
export function configPerIlSolver(base: OperatorConfig, ambito: AmbitoDelCalcolo): OperatorConfig {
  const cluster = clusterDaMandare(ambito.clusterScelti);
  const b5 = bds5ToSolverConfig(ambito.bds5);
  const conVincoli = ambito.vincoliGlobali.length > 0;
  if (!cluster && !b5 && !conVincoli) return base;

  const config: OperatorConfig = { ...base };
  if (cluster) config.selectedClusterIds = cluster;
  if (conVincoli || b5) {
    const bds: NonNullable<OperatorConfig["bds"]> = { ...(base.bds ?? {}) };
    if (conVincoli) bds.vincoliGlobali = ambito.vincoliGlobali.map(v => ({ ...v }));
    if (b5?.costiAvanzati) bds.costiAvanzati = b5.costiAvanzati;
    /* i tagli dei costi avanzati si aggiungono a quelli del profilo di regole */
    if (b5?.cuts) bds.cuts = { ...(base.bds?.cuts ?? {}), ...b5.cuts };
    config.bds = bds;
  }
  return config;
}

/**
 * Le auto aziendali di partenza: il parametro dell'azienda (Amministrazione →
 * Parametri) al posto del 5 fisso, a meno che il profilo di regole salvato non
 * dica il suo numero. Un parametro che non è un numero fra 0 e 50 non cambia niente.
 */
export function conAutoAziendali(config: OperatorConfig, parametro: unknown, delProfilo?: unknown): OperatorConfig {
  if (typeof delProfilo === "number") return config;
  if (typeof parametro !== "number" || !Number.isInteger(parametro) || parametro < 0 || parametro > 50) return config;
  return {
    ...config,
    bds: { ...(config.bds ?? {}), optimizer: { ...(config.bds?.optimizer ?? {}), maxCompanyCars: parametro } },
  };
}
