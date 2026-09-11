/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STORICO PER FERMATA E PER TRATTA — dove il verdetto si verifica
 * ───────────────────────────────────────────────────────────────────────────
 * "Questa corsa è troppo stretta nei feriali con scuole aperte" è un giudizio
 * sull'intera corsa. Serve, ma non si può agire su di esso: per allargare un
 * orario bisogna sapere DOVE mancano i minuti — su quale tratta si perdono e
 * a partire da quale fermata il ritardo non si recupera più.
 *
 * Questo modulo apre quel verdetto. Stessa classe di giornata, stessi criteri,
 * stesse soglie: cambia solo la scala, dalla corsa alla tratta.
 *
 * ── LA TRAPPOLA: non misurare la propria aritmetica ──
 *
 * Il completamento automatico (transit-completion.ts) riempie le fermate non
 * rilevate interpolando il ritardo IN PROPORZIONE al tempo programmato. È il
 * comportamento giusto per disegnare una corsa, ed è il peggiore possibile per
 * misurarla: una tratta ricostruita così ha, per costruzione, esattamente il
 * tempo che l'orario le concede. Mediarla insieme alle altre non aggiunge
 * un'osservazione — ne aggiunge una che dice sempre "l'orario è perfetto", e
 * con la nostra copertura di rilevamento sarebbero la maggioranza.
 *
 * Qui entrano quindi SOLO i transiti osservati, e ogni riga dichiara su quante
 * giornate è costruita. È la stessa regola del controllo tautologico sugli
 * agganci: quello che abbiamo calcolato noi non può essere la prova di sé
 * stesso.
 *
 * ── Le tratte sono quelle MISURATE, non quelle dell'orario ──
 *
 * Con una fermata rilevata su tre, gli archi fra fermate adiacenti sarebbero
 * quasi tutti vuoti e la pagina direbbe soltanto "nessun dato". Si aggregano
 * allora le tratte fra fermate CONSECUTIVAMENTE OSSERVATE, dichiarando quante
 * fermate ciascuna ne scavalca. Una tratta che salta tre fermate resta una
 * misura vera: è il tempo reale per andare da A a D, e l'orario dice quanto
 * dovrebbe essere. Fingere di conoscere i tre pezzi separati sarebbe inventare.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { delayFromSchedule } from "./siri-vm";
import { percentile, type Verdetto } from "./runtime-analysis";

/* Le stesse soglie del verdetto di corsa: se qui fossero diverse, la corsa e
 * le sue tratte potrebbero dare risposte opposte sugli stessi dati. */
const SOGLIA_SEC = 120;
const SOGLIA_QUOTA = 0.08;
/** Sotto questo numero di giornate una mediana è un aneddoto. */
export const GIORNATE_MINIME = 3;

/* ── Ingresso ─────────────────────────────────────────────────────────────── */

/** Una fermata della corsa come sta nell'orario. */
export interface FermataOrario {
  seq: number;
  stopId: string;
  stopName: string | null;
  /** orario programmato "HH:MM:SS" (può superare le 24) */
  scheduled: string | null;
}

/** Un transito OSSERVATO, non ricostruito. */
export interface TransitoOsservato {
  /** giornata di servizio "YYYY-MM-DD" */
  day: string;
  stopId: string;
  /** progressivo di fermata, quando il transito lo porta */
  seq: number | null;
  actualTs: Date;
}

/* ── Uscita ───────────────────────────────────────────────────────────────── */

export interface FermataStorica {
  seq: number;
  stopId: string;
  stopName: string | null;
  scheduled: string | null;
  /** giornate in cui la fermata è stata rilevata */
  giorni: number;
  /** scarto tipico dal programmato: positivo = ritardo */
  scartoMedianoSec: number | null;
  /** scarto che l'85% delle giornate non supera */
  scartoP85Sec: number | null;
  scartoMinSec: number | null;
  scartoMaxSec: number | null;
}

export interface TrattaStorica {
  daSeq: number;
  aSeq: number;
  daStopId: string;
  aStopId: string;
  daNome: string | null;
  aNome: string | null;
  /** fermate dell'orario scavalcate perché mai rilevate insieme agli estremi */
  fermateScavalcate: number;
  programmatoSec: number | null;
  giorni: number;
  medianaSec: number;
  p85Sec: number;
  minSec: number;
  maxSec: number;
  scartoMedianaSec: number | null;
  scartoP85Sec: number | null;
  verdetto: Verdetto;
  motivo: string;
}

export interface StoricoCorsa {
  /** classe di giornata su cui è costruito tutto ciò che segue */
  classe: string | null;
  classeLabel: string | null;
  giornate: number;
  fermate: FermataStorica[];
  tratte: TrattaStorica[];
  /** la tratta che pesa di più sul verdetto della corsa */
  trattaPeggiore: TrattaStorica | null;
  nota: string;
}

/* ── Calcolo ──────────────────────────────────────────────────────────────── */

function secondiOrario(scheduled: string | null): number | null {
  if (!scheduled) return null;
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?/.exec(scheduled.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : null;
}

/**
 * Lo storico di una corsa, fermata per fermata e tratta per tratta, su una
 * sola classe di giornata.
 *
 * `classifica` traduce una data nella sua classe e arriva da fuori, come per
 * il verdetto di corsa: dipende dal calendario aziendale, che qui non si
 * conosce. Passando `classe` si tiene solo quella; senza, si tiene la classe
 * con più giornate — perché mescolarle darebbe il numero di un giorno che non
 * esiste.
 */
export function storicoCorsa(
  fermate: FermataOrario[],
  transiti: TransitoOsservato[],
  classifica: (day: string) => { key: string; label: string },
  classe?: string | null,
  timeZone = "Europe/Rome",
): StoricoCorsa {
  const ordine = [...fermate].sort((a, b) => a.seq - b.seq);
  const perSeq = new Map(ordine.map(f => [f.seq, f]));
  const perStopId = new Map<string, FermataOrario>();
  for (const f of ordine) if (!perStopId.has(f.stopId)) perStopId.set(f.stopId, f);

  /* Il progressivo del transito è più affidabile del solo stop_id — una
   * fermata può ricorrere due volte sulla stessa corsa — ma non c'è sempre. */
  const risolviSeq = (t: TransitoOsservato): number | null => {
    if (t.seq != null && perSeq.has(t.seq)) return t.seq;
    return perStopId.get(t.stopId)?.seq ?? null;
  };

  /* Classi presenti, per scegliere quella su cui rispondere. */
  const giorniPerClasse = new Map<string, { label: string; giorni: Set<string> }>();
  for (const t of transiti) {
    const c = classifica(t.day);
    let g = giorniPerClasse.get(c.key);
    if (!g) { g = { label: c.label, giorni: new Set() }; giorniPerClasse.set(c.key, g); }
    g.giorni.add(t.day);
  }

  let classeScelta = classe ?? null;
  if (!classeScelta) {
    let max = 0;
    for (const [k, g] of giorniPerClasse) {
      if (g.giorni.size > max) { max = g.giorni.size; classeScelta = k; }
    }
  }
  const classeLabel = classeScelta ? giorniPerClasse.get(classeScelta)?.label ?? null : null;

  const inClasse = classeScelta
    ? transiti.filter(t => classifica(t.day).key === classeScelta)
    : [];

  if (inClasse.length === 0) {
    return {
      classe: classeScelta, classeLabel, giornate: 0, fermate: [], tratte: [],
      trattaPeggiore: null,
      nota: classeScelta
        ? "Nessun transito osservato per questa corsa nella classe di giornata scelta."
        : "Nessun transito osservato per questa corsa nel periodo richiesto.",
    };
  }

  /* Un transito per (giornata, fermata): con due letture ravvicinate al
   * capolinea si conterebbe due volte la stessa sosta. Vince la prima. */
  const perGiorno = new Map<string, Map<number, Date>>();
  for (const t of inClasse) {
    const seq = risolviSeq(t);
    if (seq == null) continue;
    let g = perGiorno.get(t.day);
    if (!g) { g = new Map(); perGiorno.set(t.day, g); }
    const gia = g.get(seq);
    if (!gia || t.actualTs < gia) g.set(seq, t.actualTs);
  }

  /* ── Per fermata: dove si accumula lo scarto ─────────────────────────── */
  const scartiPerSeq = new Map<number, number[]>();
  for (const [, g] of perGiorno) {
    for (const [seq, at] of g) {
      const f = perSeq.get(seq);
      if (!f?.scheduled) continue;
      const scarto = delayFromSchedule(f.scheduled, at, timeZone);
      if (scarto == null) continue;
      const arr = scartiPerSeq.get(seq) ?? [];
      arr.push(scarto);
      scartiPerSeq.set(seq, arr);
    }
  }

  const fermateOut: FermataStorica[] = ordine.map(f => {
    const s = scartiPerSeq.get(f.seq) ?? [];
    return {
      seq: f.seq, stopId: f.stopId, stopName: f.stopName, scheduled: f.scheduled,
      giorni: s.length,
      scartoMedianoSec: s.length ? Math.round(percentile(s, 0.5)) : null,
      scartoP85Sec: s.length ? Math.round(percentile(s, 0.85)) : null,
      scartoMinSec: s.length ? Math.min(...s) : null,
      scartoMaxSec: s.length ? Math.max(...s) : null,
    };
  });

  /* ── Per tratta: fra fermate CONSECUTIVAMENTE osservate ──────────────── */
  const tratte = new Map<string, { da: number; a: number; durate: number[]; giorni: Set<string> }>();
  for (const [day, g] of perGiorno) {
    const seqs = [...g.keys()].sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) {
      const da = seqs[i - 1], a = seqs[i];
      const durata = (g.get(a)!.getTime() - g.get(da)!.getTime()) / 1000;
      /* Una durata nulla o negativa è una lettura sporca, non una tratta
       * percorsa all'indietro; sopra le due ore non è più questa corsa. */
      if (durata <= 0 || durata > 2 * 3600) continue;
      const k = `${da}>${a}`;
      let tr = tratte.get(k);
      if (!tr) { tr = { da, a, durate: [], giorni: new Set() }; tratte.set(k, tr); }
      tr.durate.push(durata);
      tr.giorni.add(day);
    }
  }

  const tratteOut: TrattaStorica[] = [];
  for (const tr of tratte.values()) {
    const fDa = perSeq.get(tr.da)!, fA = perSeq.get(tr.a)!;
    const sDa = secondiOrario(fDa.scheduled), sA = secondiOrario(fA.scheduled);
    const programmato = sDa != null && sA != null && sA > sDa ? sA - sDa : null;

    const mediana = Math.round(percentile(tr.durate, 0.5));
    const p85 = Math.round(percentile(tr.durate, 0.85));
    const scartoMediana = programmato != null ? mediana - programmato : null;
    const scartoP85 = programmato != null ? p85 - programmato : null;
    const scavalcate = ordine.filter(f => f.seq > tr.da && f.seq < tr.a).length;

    const { verdetto, motivo } = giudicaTratta(
      tr.giorni.size, programmato, scartoMediana, scartoP85, scavalcate,
    );

    tratteOut.push({
      daSeq: tr.da, aSeq: tr.a,
      daStopId: fDa.stopId, aStopId: fA.stopId,
      daNome: fDa.stopName, aNome: fA.stopName,
      fermateScavalcate: scavalcate,
      programmatoSec: programmato,
      giorni: tr.giorni.size,
      medianaSec: mediana, p85Sec: p85,
      minSec: Math.round(Math.min(...tr.durate)),
      maxSec: Math.round(Math.max(...tr.durate)),
      scartoMedianaSec: scartoMediana,
      scartoP85Sec: scartoP85,
      verdetto, motivo,
    });
  }

  /* In ordine di percorso: è come la corsa viene letta, non come va ordinata
   * una classifica. La tratta peggiore si indica a parte. */
  tratteOut.sort((a, b) => a.daSeq - b.daSeq || a.aSeq - b.aSeq);

  const giudicabili = tratteOut.filter(t => t.verdetto === "stretto" || t.verdetto === "largo");
  const peggiore = giudicabili.length > 0
    ? giudicabili.reduce((w, t) =>
        Math.abs(t.scartoP85Sec ?? t.scartoMedianaSec ?? 0)
        > Math.abs(w.scartoP85Sec ?? w.scartoMedianaSec ?? 0) ? t : w)
    : null;

  return {
    classe: classeScelta, classeLabel, giornate: perGiorno.size,
    fermate: fermateOut, tratte: tratteOut, trattaPeggiore: peggiore,
    nota: riassumi(perGiorno.size, tratteOut, peggiore),
  };
}

function giudicaTratta(
  giorni: number, programmato: number | null,
  scartoMediana: number | null, scartoP85: number | null,
  scavalcate: number,
): { verdetto: Verdetto; motivo: string } {
  const suQuante = scavalcate > 0
    ? ` (la misura scavalca ${scavalcate} fermat${scavalcate === 1 ? "a" : "e"} mai rilevat${scavalcate === 1 ? "a" : "e"} insieme agli estremi)`
    : "";

  if (programmato == null) {
    return {
      verdetto: "insufficiente",
      motivo: "L'orario non dà i due estremi di questa tratta: non c'è un "
        + "termine di confronto.",
    };
  }
  if (giorni < GIORNATE_MINIME) {
    return {
      verdetto: "insufficiente",
      motivo: `Misurata in ${giorni} giornat${giorni === 1 ? "a" : "e"}: troppo poco `
        + `per dire qualcosa. Ne servono almeno ${GIORNATE_MINIME}.`,
    };
  }

  const soglia = Math.max(SOGLIA_SEC, programmato * SOGLIA_QUOTA);

  if (scartoP85 != null && scartoP85 > soglia) {
    return {
      verdetto: "stretto",
      motivo: `Su questa tratta l'85% delle corse impiega ${durata(scartoP85)} in più `
        + `del previsto${suQuante}. È qui che l'orario non regge.`,
    };
  }
  if (scartoMediana != null && scartoMediana < -soglia) {
    return {
      verdetto: "largo",
      motivo: `Su questa tratta di norma avanzano ${durata(-scartoMediana)}${suQuante}. `
        + "È il tempo che si può spostare dove serve.",
    };
  }
  return { verdetto: "adeguato", motivo: `Il tempo concesso corrisponde a quello impiegato${suQuante}.` };
}

function riassumi(
  giornate: number, tratte: TrattaStorica[], peggiore: TrattaStorica | null,
): string {
  const misurate = tratte.filter(t => t.verdetto !== "insufficiente").length;
  if (tratte.length === 0) {
    return `${giornate} giornate osservate, ma nessuna coppia di fermate è stata `
      + "rilevata due volte di fila: non si può misurare nessuna tratta.";
  }
  if (misurate === 0) {
    return `${tratte.length} tratte rilevate, nessuna su abbastanza giornate per `
      + `un giudizio (ne servono ${GIORNATE_MINIME}). I numeri ci sono, la loro `
      + "affidabilità no.";
  }
  if (!peggiore) {
    return `${misurate} tratte misurate su ${giornate} giornate: il tempo concesso `
      + "corrisponde a quello impiegato lungo tutto il percorso.";
  }
  const dove = `${peggiore.daNome ?? peggiore.daStopId} → ${peggiore.aNome ?? peggiore.aStopId}`;
  return peggiore.verdetto === "stretto"
    ? `Il punto critico è ${dove}: ${durata(peggiore.scartoP85Sec ?? 0)} in più del `
      + `previsto nell'85% delle corse, su ${peggiore.giorni} giornate.`
    : `Dove avanza più tempo è ${dove}: ${durata(-(peggiore.scartoMedianaSec ?? 0))} `
      + `di norma, su ${peggiore.giorni} giornate.`;
}

/** Secondi → "3′30″": un motivo che si legge senza fare i conti. */
function durata(sec: number): string {
  const a = Math.abs(Math.round(sec));
  const m = Math.floor(a / 60), s = a % 60;
  return m > 0 ? `${m}′${s > 0 ? `${String(s).padStart(2, "0")}″` : ""}` : `${s}″`;
}
