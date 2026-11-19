/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Transcodifica delle paline — il codice dell'AVM ↔ lo stop_id del feed
 * ───────────────────────────────────────────────────────────────────────────
 * Le fermate hanno due numerazioni. L'AVM (e quindi il flusso SIRI) chiama
 * «1122» la fermata che il feed GTFS chiama «20045»; e le due numerazioni si
 * sovrappongono: nel feed esiste anche uno stop_id 200, ed è un'altra fermata
 * rispetto alla 200 dell'AVM. Agganciare per numero senza tabella non produce
 * assenze: produce fermate sbagliate.
 *
 * La tabella è un dato dell'azienda (tappa 6.20, lib/transcodifica-paline.ts):
 * la importa l'amministratore, nel formato
 *   mizar_ref,stop_id,nome
 * Le righe senza uno stop_id valido ("new_CT": palina non ancora codificata)
 * restano fra le paline senza fermata. Sopra la tabella valgono le
 * correzioni dell'operatore (lib/stop-alias-overrides.ts).
 *
 * Qui le regole, pure: si collaudano senza database.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { fornitoreAvm } from "./vetture-azienda";

export interface RigaTranscodifica {
  mizarRef: string;
  stopId: string;
  nome: string | null;
  /** da dove viene la riga: la tabella dell'azienda o una correzione dell'operatore */
  fonte?: "azienda" | "manuale";
  nota?: string | null;
  utente?: string | null;
}

/** Una palina della tabella senza un codice del feed ("new_CT"): esiste per
 *  l'AVM, non ancora per l'esportazione. */
export interface RigaScartata { mizarRef: string; nome: string | null; stopIdGrezzo: string; fonte?: "azienda" | "manuale"; nota?: string | null; utente?: string | null }

/**
 * La tabella effettiva: quella dell'azienda più le correzioni dell'operatore.
 * Una correzione sostituisce la riga con lo stesso codice, o ne aggiunge una
 * nuova; una correzione con stop_id vuoto toglie l'abbinamento e sposta la
 * palina fra quelle «senza fermata». Pura: si collauda senza database.
 */
export function applicaOverrides(
  valide: RigaTranscodifica[], scartate: RigaScartata[],
  overrides: Array<{ mizarRef: string; stopId: string | null; nome: string | null; nota: string | null; utente: string | null }>,
): { valide: RigaTranscodifica[]; scartate: RigaScartata[] } {
  if (!overrides.length) return { valide, scartate };
  const per = new Map(overrides.map(o => [o.mizarRef, o]));
  const outValide: RigaTranscodifica[] = [];
  const outScartate: RigaScartata[] = [];
  const viste = new Set<string>();
  const applica = (mizarRef: string, nomeTabella: string | null) => {
    const o = per.get(mizarRef)!;
    viste.add(mizarRef);
    if (o.stopId) outValide.push({ mizarRef, stopId: o.stopId, nome: o.nome ?? nomeTabella, fonte: "manuale", nota: o.nota, utente: o.utente });
    else outScartate.push({ mizarRef, nome: o.nome ?? nomeTabella, stopIdGrezzo: "", fonte: "manuale", nota: o.nota, utente: o.utente });
  };
  for (const r of valide) {
    if (per.has(r.mizarRef)) applica(r.mizarRef, r.nome);
    else outValide.push({ ...r, fonte: r.fonte ?? "azienda" });
  }
  for (const s of scartate) {
    if (per.has(s.mizarRef)) applica(s.mizarRef, s.nome);
    else outScartate.push({ ...s, fonte: s.fonte ?? "azienda" });
  }
  /* Correzioni su codici che la tabella non ha: paline nuove viste nel flusso. */
  for (const o of overrides) if (!viste.has(o.mizarRef)) applica(o.mizarRef, null);
  return { valide: outValide, scartate: outScartate };
}

/** Una riga CSV in campi: virgolette e virgolette raddoppiate tollerate. */
export function spezzaCsv(riga: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < riga.length; i++) {
    const c = riga[i];
    if (inQ) {
      if (c === '"' && riga[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* ── Il codice della tabella e la fermata del feed (tappa 6.20b) ──────────────
 * La tabella punta al codice della fermata nel GTFS dell'azienda («20045»).
 * In un feed caricato da file quel codice è lo stop_id. In un feed nato da
 * Planning Studio no: lo stop_id è l'identificativo interno della fermata nel
 * progetto, e il codice è il suo «codice» stabile (tappa 3.1). Lo stop_code
 * non serve: in un GTFS dell'azienda può essere il numero dell'AVM.
 * Prima si cercava solo lo stop_id, e con un feed di Planning Studio nessuna
 * palina trovava la sua fermata. */

/** Le fermate del feed che servono alla transcodifica. */
export interface FeedTranscodifica {
  stops: Set<string>;
  stopNames: Map<string, string>;
  /** feed di Planning Studio: codice stabile → stop_id, e il contrario; vuoti per un feed da file */
  stopByCodice?: Map<string, string>;
  codiceOfStop?: Map<string, string>;
}

/** La fermata del feed a cui porta un codice della tabella: lo stop_id stesso, o la fermata con quel codice stabile. */
export function fermataDelCodice(codice: string, feed: Pick<FeedTranscodifica, "stops" | "stopByCodice">): string | null {
  if (feed.stops.has(codice)) return codice;
  return feed.stopByCodice?.get(codice) ?? null;
}

/** Il codice con cui la tabella chiama una fermata del feed: il codice stabile, se il feed ne ha uno; altrimenti lo stop_id. */
export function codiceDellaFermata(stopId: string, feed: Pick<FeedTranscodifica, "codiceOfStop">): string {
  return feed.codiceOfStop?.get(stopId) ?? stopId;
}

/** codice palina → stop_id del feed, solo per le paline la cui fermata c'è in questo feed. */
export function aliasNelFeed(indice: Map<string, string>, feed: Pick<FeedTranscodifica, "stops" | "stopByCodice">): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ref, codice] of indice) {
    const s = fermataDelCodice(codice, feed);
    if (s) out.set(ref, s);
  }
  return out;
}

/** mizar_ref → stop_id. Il primo vince, come per i nomi. */
export function indiceTranscodifica(righe: RigaTranscodifica[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of righe) if (!m.has(r.mizarRef)) m.set(r.mizarRef, r.stopId);
  return m;
}

interface Transcodifica {
  righe: RigaTranscodifica[];
  scartate: RigaScartata[];
  indice: Map<string, string>;
  errore: string | null;
}

/* ── Gli abbinamenti, uno per uno ───────────────────────────────────────────
 * La verifica qui sopra conta. Questa elenca: ogni palina con il suo stato,
 * perché chi tiene la tabella possa correggerla riga per riga. Gli stati
 * sono esclusivi; la collisione è un'informazione in più, perché un
 * abbinamento giusto può comunque avere un numero che nel feed è un'altra
 * fermata. */

export type StatoAbbinamento =
  | "abbinata"          // fermata nel feed, nomi compatibili
  | "sospetta"          // fermata nel feed, ma il nome dice un'altra cosa
  | "fermata_assente"   // lo stop_id della tabella non esiste nel feed in uso
  | "senza_codice";     // palina di Mizar senza codice del feed ("new_CT")

export interface Abbinamento {
  mizarRef: string;
  stopId: string | null;
  nomeMizar: string | null;
  nomeFeed: string | null;
  stato: StatoAbbinamento;
  /** tabella dell'azienda, o correzione dell'operatore (con nota e autore) */
  fonte: "azienda" | "manuale";
  nota: string | null;
  utente: string | null;
  /** il codice Mizar coincide con lo stop_id di un'ALTRA fermata del feed */
  collisione: string | null;
  /** quante altre paline Mizar puntano alla stessa fermata */
  condivisaCon: number;
  /** vista nel flusso SIRI dell'ultimo giro */
  vistaNelFlusso: boolean;
}

export interface FermataSenzaCodice { stopId: string; nome: string | null }

export interface Abbinamenti {
  righe: Abbinamento[];
  /** fermate del feed che nessun codice Mizar raggiunge */
  feedSenzaCodice: FermataSenzaCodice[];
  /** codici visti nel flusso SIRI che la tabella non ha */
  flussoNonTrascodificato: string[];
  riepilogo: {
    paline: number;
    abbinate: number; sospette: number; fermateAssenti: number; senzaCodice: number;
    collisioni: number; feedSenzaCodice: number; flussoNonTrascodificato: number;
  };
  lettura: string[];
}

export function classificaAbbinamenti(
  righe: RigaTranscodifica[], scartate: RigaScartata[],
  feed: FeedTranscodifica,
  flusso: { refs: string[] } = { refs: [] },
  nomiCompatibili: (a: string | null, b: string | null) => boolean = (a, b) => !a || !b || a.trim().toUpperCase() === b.trim().toUpperCase(),
): Abbinamenti {
  /* le paline per fermata del feed (quella a cui porta il codice; se non c'è, il codice stesso) */
  const fermataDi = new Map(righe.map(r => [r.mizarRef, fermataDelCodice(r.stopId, feed)]));
  const chiave = (r: RigaTranscodifica) => fermataDi.get(r.mizarRef) ?? `codice:${r.stopId}`;
  const perStop = new Map<string, number>();
  for (const r of righe) perStop.set(chiave(r), (perStop.get(chiave(r)) ?? 0) + 1);
  const visti = new Set(flusso.refs.map(x => x.trim()));
  const trascodificati = new Set(righe.map(r => r.mizarRef));
  /* un codice dell'AVM uguale al codice di un'ALTRA fermata del feed: è la fermata che l'aggancio per numero prenderebbe */
  const omonima = (mizarRef: string, fermata: string | null) => {
    const o = fermataDelCodice(mizarRef, feed);
    return o && o !== fermata ? `${mizarRef} = ${feed.stopNames.get(o) ?? "?"}` : null;
  };

  const out: Abbinamento[] = righe.map(r => {
    const fermata = fermataDi.get(r.mizarRef) ?? null;
    const nomeFeed = fermata ? (feed.stopNames.get(fermata) ?? null) : null;
    const stato: StatoAbbinamento = !fermata ? "fermata_assente"
      : nomiCompatibili(r.nome, nomeFeed) ? "abbinata" : "sospetta";
    return {
      mizarRef: r.mizarRef, stopId: r.stopId, nomeMizar: r.nome, nomeFeed, stato, collisione: omonima(r.mizarRef, fermata),
      fonte: r.fonte ?? "azienda", nota: r.nota ?? null, utente: r.utente ?? null,
      condivisaCon: (perStop.get(chiave(r)) ?? 1) - 1,
      vistaNelFlusso: visti.has(r.mizarRef),
    };
  });
  for (const s of scartate) {
    out.push({
      mizarRef: s.mizarRef, stopId: null, nomeMizar: s.nome, nomeFeed: null, stato: "senza_codice",
      collisione: omonima(s.mizarRef, null),
      fonte: s.fonte ?? "azienda", nota: s.nota ?? null, utente: s.utente ?? null,
      condivisaCon: 0, vistaNelFlusso: visti.has(s.mizarRef),
    });
  }

  const feedSenzaCodice: FermataSenzaCodice[] = [...feed.stops]
    .filter(s => !perStop.has(s))
    .map(s => ({ stopId: codiceDellaFermata(s, feed), nome: feed.stopNames.get(s) ?? null }))
    .sort((a, b) => a.stopId.localeCompare(b.stopId));
  const flussoNonTrascodificato = [...visti].filter(x => x && !trascodificati.has(x)).sort();

  const conta = (st: StatoAbbinamento) => out.filter(x => x.stato === st).length;
  const riepilogo: Abbinamenti["riepilogo"] = {
    paline: out.length,
    abbinate: conta("abbinata"), sospette: conta("sospetta"),
    fermateAssenti: conta("fermata_assente"), senzaCodice: conta("senza_codice"),
    collisioni: out.filter(x => x.collisione).length,
    feedSenzaCodice: feedSenzaCodice.length,
    flussoNonTrascodificato: flussoNonTrascodificato.length,
  };

  const lettura: string[] = [];
  lettura.push(`${riepilogo.paline} paline nella tabella: ${riepilogo.abbinate} abbinate a una fermata del feed con lo stesso nome.`);
  if (riepilogo.sospette) lettura.push(`${riepilogo.sospette} sospette: la fermata esiste nel feed ma il nome è un altro; da controllare una per una.`);
  if (riepilogo.fermateAssenti) lettura.push(`${riepilogo.fermateAssenti} puntano a uno stop_id che il feed in uso non ha: paline nuove, o feed vecchio.`);
  if (riepilogo.senzaCodice) lettura.push(`${riepilogo.senzaCodice} paline senza codice del feed («new_CT»): da codificare nel software aziendale.`);
  if (riepilogo.feedSenzaCodice) lettura.push(`${riepilogo.feedSenzaCodice} fermate del feed non hanno nessun codice ${fornitoreAvm().breve}: da lì non arriverà mai un passaggio dichiarato dall'AVM.`);
  if (riepilogo.collisioni) lettura.push(`${riepilogo.collisioni} codici ${fornitoreAvm().breve} coincidono con lo stop_id di un'altra fermata: senza la tabella sarebbero fermate sbagliate.`);
  if (riepilogo.flussoNonTrascodificato) lettura.push(`${riepilogo.flussoNonTrascodificato} codici visti nel flusso SIRI dell'ultimo giro mancano dalla tabella.`);
  return { righe: out, feedSenzaCodice, flussoNonTrascodificato, riepilogo, lettura };
}

/**
 * La tabella effettiva: quella dell'azienda + le correzioni dal database. È
 * questa che l'indice del feed, il ciclo StopMonitoring e la scheda usano.
 */
export async function transcodificaEffettiva(force = false): Promise<Transcodifica & {
  correzioni: number; importataIl: string | null; importataDa: string | null;
}> {
  const { leggiBaseTranscodifica } = await import("./transcodifica-paline");
  const { leggiOverrides } = await import("./stop-alias-overrides");
  const base = await leggiBaseTranscodifica(force);
  const overrides = await leggiOverrides(force);
  const { valide, scartate } = applicaOverrides(base.righe, base.scartate, overrides);
  return {
    errore: base.errore, righe: valide, scartate, indice: indiceTranscodifica(valide), correzioni: overrides.length,
    importataIl: base.importataIl, importataDa: base.importataDa,
  };
}

/**
 * Candidati per nome nel feed, per una palina sospetta o senza fermata:
 * stesso nome normalizzato, poi contenimento. Al più cinque, i migliori
 * prima. Un suggerimento, non una decisione: la decide l'operatore.
 */
export function suggerimentiPerNome(
  nome: string | null, feed: { stops: Set<string>; stopNames: Map<string, string> }, escludi: string | null = null, max = 5,
): Array<{ stopId: string; nome: string | null; motivo: "stesso_nome" | "nome_contenuto" }> {
  if (!nome) return [];
  const norm = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const q = norm(nome);
  if (q.length < 4) return [];
  const esatti: Array<{ stopId: string; nome: string | null; motivo: "stesso_nome" | "nome_contenuto" }> = [];
  const parziali: typeof esatti = [];
  for (const stopId of feed.stops) {
    if (stopId === escludi) continue;
    const n = feed.stopNames.get(stopId);
    if (!n) continue;
    const nn = norm(n);
    if (!nn) continue;
    if (nn === q) esatti.push({ stopId, nome: n, motivo: "stesso_nome" });
    /* Contenimento in entrambi i versi, ma un nome del feed troppo corto
     * ("OSIMO") starebbe dentro a mezza provincia: non è un suggerimento. */
    else if (nn.includes(q) || (nn.length >= 8 && q.includes(nn))) parziali.push({ stopId, nome: n, motivo: "nome_contenuto" });
  }
  return [...esatti, ...parziali].slice(0, max);
}

/* ── Verifica contro il feed ─────────────────────────────────────────────── */

export interface VerificaTranscodifica {
  righe: number;
  /** stop_id della transcodifica presenti nel feed */
  nelFeed: number;
  /** stop_id che il feed non ha: paline nuove, o feed vecchio */
  nonNelFeed: string[];
  /** fermate del feed che nessun codice Mizar raggiunge */
  feedSenzaCodice: number;
  /** stessa fermata raggiunta da più codici Mizar (banchine unite?) */
  stopConPiuCodici: Array<{ stopId: string; mizarRefs: string[] }>;
  /** codici Mizar che coincidono con uno stop_id del feed DI UN'ALTRA fermata:
   *  gli agganci per numero che sarebbero stati sbagliati */
  collisioni: Array<{ mizarRef: string; stopIdGiusto: string; stopIdOmonimo: string }>;
}

export function verificaTranscodifica(
  righe: RigaTranscodifica[], feed: Pick<FeedTranscodifica, "stops" | "stopByCodice" | "codiceOfStop">,
): VerificaTranscodifica {
  const nonNelFeed: string[] = [];
  const perStop = new Map<string, string[]>();
  const collisioni: VerificaTranscodifica["collisioni"] = [];
  let nelFeed = 0;
  for (const r of righe) {
    const fermata = fermataDelCodice(r.stopId, feed);
    if (fermata) nelFeed++; else nonNelFeed.push(r.stopId);
    const k = fermata ?? `codice:${r.stopId}`;
    const arr = perStop.get(k) ?? [];
    arr.push(r.mizarRef); perStop.set(k, arr);
    const omonima = fermataDelCodice(r.mizarRef, feed);
    if (omonima && omonima !== fermata) {
      collisioni.push({ mizarRef: r.mizarRef, stopIdGiusto: r.stopId, stopIdOmonimo: codiceDellaFermata(omonima, feed) });
    }
  }
  return {
    righe: righe.length, nelFeed, nonNelFeed,
    feedSenzaCodice: [...feed.stops].filter(s => !perStop.has(s)).length,
    stopConPiuCodici: [...perStop.entries()].filter(([, v]) => v.length > 1)
      .map(([k, mizarRefs]) => ({ stopId: k.startsWith("codice:") ? k.slice(7) : codiceDellaFermata(k, feed), mizarRefs })),
    collisioni,
  };
}
