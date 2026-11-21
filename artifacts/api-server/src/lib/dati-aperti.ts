/**
 * I dati aperti a un indirizzo stabile (tappa 6.3, migrazione 0037).
 *
 * Il NAP non riceve file a mano: scarica ogni giorno da un indirizzo che non
 * cambia. Qui i due file che Cerbero pubblica — il GTFS consegnabile (PR 3.4)
 * e il NeTEx del profilo italiano (tappa 6.2) — si preparano UNA volta e si
 * tengono in tabella (dati_aperti): chi scarica riceve i byte già pronti.
 *
 *  - DA DOVE: solo dalla versione in esercizio (la copia congelata della
 *    PR 3.3 del feed acceso), mai da una bozza. Senza una versione in
 *    esercizio i file si tolgono: l'indirizzo non pubblica niente.
 *  - QUANDO: il lavoratore guarda ogni pochi minuti (lib/lavori/dati-aperti.ts)
 *    e rifà un file solo se è cambiata la sua «firma»: la versione in
 *    esercizio, i dati dell'azienda che finiscono nel file, o il formato. Un
 *    file che non cambia tiene la stessa impronta, e chi lo ha già riceve
 *    «non modificato».
 *  - SOLO SE VALIDO: un GTFS con errori, o un NeTEx che non passa lo schema
 *    (o che non si è potuto controllare), non va in linea: resta l'ultimo file
 *    buono, e accanto resta scritto perché quello nuovo non è uscito.
 *  - NASCE SPENTO: azienda.dati_aperti_attivi lo accende l'amministratore.
 *
 * Niente Express: lo usano le rotte (routes/dati-aperti.ts, routes/admin.ts) e
 * il lavoratore.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { dimenticaAzienda, leggiAzienda, type Azienda } from "./azienda";
import type { Gestore } from "./gestori";
import { gestoriDalDatabase } from "./gestori-store";
import { rigaDelProblema, verificaGtfs } from "./gtfs-verifica";
import { costruisciGtfs, netexDelGtfs, zipDelGtfs, SenzaCodiceNetex } from "./gtfs-consegnabile";
import { conLeTariffe, improntaDelleTariffe } from "./gtfs-tariffe";
import { validaNetex, type EsitoValidazione } from "./netex-validazione";

/** Il NeTEx in due file, un livello ciascuno, come al portale regionale (tappa 6.41). */
export const TIPI = ["gtfs", "netex", "netex_l3"] as const;
export type TipoFile = (typeof TIPI)[number];
export type EsitoFile = "pubblicato" | "gtfs_con_errori" | "non_valido" | "senza_xmllint" | "senza_codice" | "senza_versione" | "errore" | "senza_tariffe";

/** Cambia quando cambia il modo di costruire i file: fa rifare quelli in linea. */
export const FORMATO = 1;
/**
 * Come FORMATO, solo per il NeTEx: 2 dalla tappa 6.19c, quando negli
 * identificativi restano «/» e «.» e arrivano i prefissi della Regione; 3
 * dalla 6.42, quando arrivano le tratte col tracciato (ServiceLink); 4 dalla
 * 6.43, quando due paline vicine nell'ordine sbagliato non tolgono più le
 * tratte. Il GTFS non cambia e non si rifà.
 */
export const FORMATO_NETEX = 4;
/** Un tentativo andato male per un guasto (non per i dati) si riprova dopo un'ora. */
const RIPROVA_DOPO_MS = 60 * 60 * 1000;

/** I file: il nome con cui si scaricano, il tipo, l'indirizzo che non cambia. */
export const FILE: Record<TipoFile, { nome: string; mime: string; percorso: string; formato: string }> = {
  gtfs: { nome: "gtfs.zip", mime: "application/zip", percorso: "/api/dati-aperti/gtfs.zip", formato: "GTFS" },
  netex: { nome: "netex.xml.gz", mime: "application/gzip", percorso: "/api/dati-aperti/netex.xml.gz", formato: "NeTEx, profilo italiano livello 1 (EPIP)" },
  netex_l3: { nome: "netex-l3.xml.gz", mime: "application/gzip", percorso: "/api/dati-aperti/netex-l3.xml.gz", formato: "NeTEx, profilo italiano livello 3 (con le tariffe)" },
};

const righe = (r: any): any[] => r?.rows ?? [];
const sha256 = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : d ? new Date(String(d)).toISOString() : null);

/* ── le regole, senza database ─────────────────────────────────────────── */

/**
 * La firma di un file: da che cosa nasce. Cambia se cambia la versione in
 * esercizio, un dato dell'azienda che finisce nel file, o il formato. Il GTFS
 * porta anche le tariffe (tappa 6.37): `tariffe` è la loro impronta
 * (improntaDelleTariffe), e un prezzo o una polimetrica cambiati rifanno il file.
 */
export function firmaDi(tipo: TipoFile, v: { versioneId: string; feedId: string }, a: Azienda, gestori: readonly Gestore[] = [], tariffe: string | null = null): string {
  const diTutti = [FORMATO, tipo, v.versioneId, v.feedId, a.compilata, a.gtfsAgencyId, a.ragioneSociale, a.sito, a.telefono];
  const eNetex = tipo !== "gtfs";
  const delNetex = eNetex
    ? [a.nome, a.netexCodiceLocale, a.netexFornitore, FORMATO_NETEX, a.netexPrefisso, a.netexPrefissoCodici, a.netexCodiceRete] : [];
  /* i gestori finiscono in agency.txt e in routes.txt del GTFS (tappa 6.11) e sono gli operatori del NeTEx (6.12).
   * Senza gestori la firma è quella di prima: i file già pubblicati non si rifanno. */
  const deiGestori = gestori.length > 0
    ? [gestori.map((g) => [g.gestore, g.nome, g.sito, g.telefono, g.predefinito, ...(eNetex ? [g.email] : [])])] : [];
  /* le tariffe sono nel GTFS (tappa 6.37) e nel NeTEx di livello 3 (6.40); quello di livello 1 non le ha (6.41) */
  const delleTariffe = tariffe && tipo !== "netex" ? [tariffe] : [];
  return sha256(JSON.stringify([...diTutti, ...delNetex, ...deiGestori, ...delleTariffe]));
}

/**
 * Se un file va (ri)preparato. Con la stessa firma: quello pubblicato resta;
 * quello fermato dai dati (errori nel GTFS, schema, codice mancante) non si
 * riprova, perché darebbe lo stesso esito; quello fermato da un guasto si
 * riprova dopo un'ora.
 */
export function deveProvare(
  prima: { firma: string | null; esito: EsitoFile | null; provatoIl: Date | null } | undefined,
  firma: string, adesso: Date, forza = false,
): boolean {
  if (forza || !prima || prima.firma !== firma) return true;
  if (prima.esito === "errore" || prima.esito === "senza_xmllint") {
    return !prima.provatoIl || adesso.getTime() - prima.provatoIl.getTime() >= RIPROVA_DOPO_MS;
  }
  return false;
}

/* ── la versione in esercizio ──────────────────────────────────────────── */

export interface VersioneInEsercizio {
  versioneId: string;
  feedId: string;
  /** il nome del programma da cui viene */
  nome: string;
  dal: Date | null;
}

const SENZA_PROGRAMMA = "Nessun programma è in esercizio: i file si pubblicano quando ne metti uno in esercizio da Planning Studio";
const SENZA_VERSIONE = "Il programma in esercizio non ha una versione di Planning Studio (è un file caricato a mano, o è in esercizio da prima delle versioni): rimettilo in esercizio da Planning Studio";

/** La versione pubblicata del feed acceso, o il motivo per cui non c'è. */
export async function versioneInEsercizio(): Promise<VersioneInEsercizio | { senza: string }> {
  const r = righe(await db.execute(sql`
    SELECT f.id AS feed_id, v.id AS versione_id, COALESCE(p.name, v.name) AS nome, l.activated_at AS dal
      FROM gtfs_feeds f
      LEFT JOIN ps_projects v ON v.versione_del_feed = f.id
      LEFT JOIN ps_projects p ON p.id = v.versione_di
      LEFT JOIN ps_activation_log l ON l.feed_id = f.id AND l.deactivated_at IS NULL
     WHERE f.is_active
     ORDER BY f.uploaded_at DESC
     LIMIT 1`))[0];
  if (!r) return { senza: SENZA_PROGRAMMA };
  if (!r.versione_id) return { senza: SENZA_VERSIONE };
  return { versioneId: r.versione_id, feedId: r.feed_id, nome: String(r.nome ?? "Programma"), dal: r.dal ? new Date(r.dal) : null };
}

/* ── l'interruttore ────────────────────────────────────────────────────── */

export async function datiApertiAttivi(): Promise<boolean> {
  return righe(await db.execute(sql`SELECT dati_aperti_attivi AS attivi FROM azienda WHERE unica`))[0]?.attivi === true;
}

/** Accende o spegne. Senza i dati dell'azienda non si accende: il file porterebbe un nome inventato. */
export async function impostaAttivi(attivi: boolean): Promise<"fatto" | "senza_azienda"> {
  const r = righe(await db.execute(sql`UPDATE azienda SET dati_aperti_attivi = ${attivi} WHERE unica RETURNING 1 AS c`));
  return r.length > 0 ? "fatto" : "senza_azienda";
}

/* ── la preparazione ───────────────────────────────────────────────────── */

export type EsitoPreparazione =
  | { stato: "spenti" }
  | { stato: "occupato" }
  | { stato: "fatto"; file: Record<TipoFile, EsitoFile | "invariato"> };

export interface OpzioniPreparazione {
  /** rifà anche i file che hanno già la firma di adesso («Prepara adesso») */
  forza?: boolean;
  adesso?: Date;
  /** il controllo dello schema (nei test, uno finto) */
  valida?: (xml: string) => Promise<EsitoValidazione>;
  /** un guasto durante la costruzione: il dettaglio va nel log, non nella tabella */
  suGuasto?: (err: unknown, tipo: TipoFile) => void;
}

async function segna(tipo: TipoFile, firma: string | null, esito: EsitoFile, messaggio: string | null, dettagli: unknown, adesso: Date): Promise<void> {
  const d = dettagli == null ? null : JSON.stringify(dettagli);
  await db.execute(sql`
    INSERT INTO dati_aperti (tipo, firma, provato_il, esito, messaggio, dettagli)
    VALUES (${tipo}, ${firma}, ${adesso.toISOString()}::timestamptz, ${esito}, ${messaggio?.slice(0, 2000) ?? null}, ${d}::jsonb)
    ON CONFLICT (tipo) DO UPDATE
       SET firma = EXCLUDED.firma, provato_il = EXCLUDED.provato_il, esito = EXCLUDED.esito,
           messaggio = EXCLUDED.messaggio, dettagli = EXCLUDED.dettagli`);
}

async function togli(tipo: TipoFile, messaggio: string, adesso: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO dati_aperti (tipo, provato_il, esito, messaggio)
    VALUES (${tipo}, ${adesso.toISOString()}::timestamptz, 'senza_versione', ${messaggio})
    ON CONFLICT (tipo) DO UPDATE
       SET contenuto = NULL, impronta = NULL, byte = NULL, versione_id = NULL, in_esercizio_dal = NULL,
           preparato_il = NULL, conteggi = NULL, firma = NULL, dettagli = NULL,
           provato_il = EXCLUDED.provato_il, esito = EXCLUDED.esito, messaggio = EXCLUDED.messaggio`);
}

async function pubblica(tipo: TipoFile, firma: string, contenuto: Buffer, v: VersioneInEsercizio, conteggi: unknown, adesso: Date): Promise<void> {
  const quando = adesso.toISOString();
  await db.execute(sql`
    INSERT INTO dati_aperti (tipo, contenuto, impronta, byte, versione_id, in_esercizio_dal, preparato_il, conteggi,
                             firma, provato_il, esito, messaggio, dettagli)
    VALUES (${tipo}, ${contenuto}, ${sha256(contenuto)}, ${contenuto.length}, ${v.versioneId}::uuid,
            ${v.dal ? v.dal.toISOString() : null}::timestamptz, ${quando}::timestamptz, ${JSON.stringify(conteggi)}::jsonb,
            ${firma}, ${quando}::timestamptz, 'pubblicato', NULL, NULL)
    ON CONFLICT (tipo) DO UPDATE
       SET contenuto = EXCLUDED.contenuto, impronta = EXCLUDED.impronta, byte = EXCLUDED.byte,
           versione_id = EXCLUDED.versione_id, in_esercizio_dal = EXCLUDED.in_esercizio_dal,
           preparato_il = EXCLUDED.preparato_il, conteggi = EXCLUDED.conteggi, firma = EXCLUDED.firma,
           provato_il = EXCLUDED.provato_il, esito = EXCLUDED.esito, messaggio = NULL, dettagli = NULL`);
}

/** La data dei file dentro lo zip quando non si sa da quando la versione è in esercizio. */
const DATA_DEI_FILE = new Date("2000-01-01T00:00:00Z");

const GUASTO = "La preparazione non è riuscita per un guasto: si riprova da sola fra un'ora, oppure con «Prepara adesso»";

/**
 * Prepara i file che vanno preparati. Uno alla volta in tutta l'installazione
 * (un lucchetto di sessione su una connessione propria): se un altro sta già
 * preparando, «occupato».
 */
export async function preparaDatiAperti(o: OpzioniPreparazione = {}): Promise<EsitoPreparazione> {
  const adesso = o.adesso ?? new Date();
  const valida = o.valida ?? validaNetex;
  const lucchetto = await pool.connect();
  let preso = false;
  try {
    preso = (await lucchetto.query("SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext('cerbero:dati-aperti')) AS ok")).rows[0]?.ok === true;
    if (!preso) return { stato: "occupato" };
    if (!(await datiApertiAttivi())) return { stato: "spenti" };

    const prima = new Map<string, { firma: string | null; esito: EsitoFile | null; provatoIl: Date | null; inLinea: boolean; messaggio: string | null }>(
      righe(await db.execute(sql`SELECT tipo, firma, esito, provato_il, messaggio, impronta IS NOT NULL AS in_linea FROM dati_aperti`))
        .map((r) => [r.tipo, {
          firma: r.firma ?? null, esito: r.esito ?? null, provatoIl: r.provato_il ? new Date(r.provato_il) : null,
          inLinea: r.in_linea === true, messaggio: r.messaggio ?? null,
        }]));

    const v = await versioneInEsercizio();
    if ("senza" in v) {
      /* i file si tolgono; se è già scritto così, non si riscrive a ogni giro */
      for (const tipo of TIPI) {
        const p = prima.get(tipo);
        if (!p || p.inLinea || p.esito !== "senza_versione" || p.messaggio !== v.senza) await togli(tipo, v.senza, adesso);
      }
      return { stato: "fatto", file: { gtfs: "senza_versione", netex: "senza_versione", netex_l3: "senza_versione" } };
    }

    dimenticaAzienda();
    const azienda = await leggiAzienda();
    const gestori = await gestoriDalDatabase();
    const impronta = await improntaDelleTariffe();
    const firme = {
      gtfs: firmaDi("gtfs", v, azienda, gestori, impronta),
      netex: firmaDi("netex", v, azienda, gestori),
      netex_l3: firmaDi("netex_l3", v, azienda, gestori, impronta),
    };
    const daFare = TIPI.filter((t) => deveProvare(prima.get(t), firme[t], adesso, o.forza));
    const fatto: Record<TipoFile, EsitoFile | "invariato"> = { gtfs: "invariato", netex: "invariato", netex_l3: "invariato" };
    if (daFare.length === 0) return { stato: "fatto", file: fatto };

    const chiudi = async (tipo: TipoFile, esito: EsitoFile, messaggio: string | null, dettagli: unknown = null) => {
      await segna(tipo, firme[tipo], esito, messaggio, dettagli, adesso);
      fatto[tipo] = esito;
    };

    /* il GTFS si costruisce una volta: ne nascono tutti e due i file */
    let gtfs: Awaited<ReturnType<typeof costruisciGtfs>>;
    try {
      const versione = righe(await db.execute(sql`SELECT * FROM ps_projects WHERE id = ${v.versioneId}::uuid`))[0];
      if (!versione) throw new Error("la versione in esercizio non c'è più");
      gtfs = await costruisciGtfs(v.versioneId, versione, azienda, "esercizio", gestori);
    } catch (err) {
      for (const tipo of daFare) { o.suGuasto?.(err, tipo); await chiudi(tipo, "errore", GUASTO); }
      return { stato: "fatto", file: fatto };
    }
    /* le tariffe nel GTFS (tappa 6.37) e nel NeTEx di livello 3 (6.40). Un guasto delle tariffe non ferma gli
     * orari: tutti e due i file escono senza tariffe (il NeTEx di livello 1) */
    let avvisiTariffe: Awaited<ReturnType<typeof conLeTariffe>>["tariffe"]["avvisi"] = [];
    let gtfsConTariffe = gtfs;
    let perNetex: Awaited<ReturnType<typeof conLeTariffe>>["tariffe"]["perNetex"] | null = null;
    try {
      const t = await conLeTariffe(v.versioneId, gtfs);
      gtfsConTariffe = t.gtfs;
      avvisiTariffe = t.tariffe.avvisi;
      perNetex = t.tariffe.perNetex;
    } catch (err) { o.suGuasto?.(err, "gtfs"); }
    const verifica = verificaGtfs(gtfsConTariffe);
    verifica.avvisi.push(...avvisiTariffe);
    const conErrori = verifica.errori.length > 0;
    const messaggioErrori = conErrori
      ? `Il GTFS della versione in esercizio ha errori che chi lo riceve non accetterebbe: ${verifica.errori.slice(0, 3).map((e) => `${e.messaggio} (${e.quante})`).join("; ")}`
      : null;

    for (const tipo of daFare) {
      try {
        if (conErrori) { await chiudi(tipo, "gtfs_con_errori", messaggioErrori, { errori: verifica.errori.slice(0, 10) }); continue; }
        if (tipo === "gtfs") {
          const conteggi = {
            righe: Object.fromEntries(Object.entries(gtfsConTariffe).map(([f, x]) => [f, x.righe.length])),
            avvisi: verifica.avvisi.reduce((n, a) => n + a.quante, 0),
            avvisiElenco: verifica.avvisi.slice(0, 5).map((a) => rigaDelProblema(a)),
          };
          await pubblica("gtfs", firme.gtfs, zipDelGtfs(gtfsConTariffe, v.dal ?? DATA_DEI_FILE), v, conteggi, adesso);
          fatto.gtfs = "pubblicato";
          continue;
        }
        /* il NeTEx: di livello 1 dagli orari; di livello 3 con le tariffe, se si sono lette (altrimenti si riprova fra un'ora) */
        if (tipo === "netex_l3" && !perNetex) { await chiudi(tipo, "errore", GUASTO); continue; }
        const { xml, conteggi } = tipo === "netex_l3"
          ? netexDelGtfs(gtfsConTariffe, azienda, gestori, adesso, perNetex)
          : netexDelGtfs(gtfs, azienda, gestori, adesso);
        /* un livello 3 senza tariffe sarebbe un livello 1 con un altro nome: non si fa, e si dice perché */
        if (tipo === "netex_l3" && !conteggi.tariffe) {
          await chiudi(tipo, "senza_tariffe", "L'azienda non ha tariffe: il NeTEx di livello 3 non si fa (Amministrazione › Azienda: catalogo dei titoli e fasce chilometriche)");
          continue;
        }
        const esito = await valida(xml);
        if (esito.stato === "non_valido") {
          await chiudi(tipo, "non_valido", "Il NeTEx non passa lo schema del profilo italiano", { errori: esito.errori.slice(0, 20) });
        } else if (esito.stato === "senza_xmllint") {
          await chiudi(tipo, "senza_xmllint", "Su questo server manca il programma che controlla lo schema NeTEx (xmllint): senza controllo il file non si pubblica");
        } else {
          await pubblica(tipo, firme[tipo], gzipSync(Buffer.from(xml, "utf8")), v, conteggi, adesso);
          fatto[tipo] = "pubblicato";
        }
      } catch (err) {
        if (err instanceof SenzaCodiceNetex) { await chiudi(tipo, "senza_codice", err.message); continue; }
        o.suGuasto?.(err, tipo);
        await chiudi(tipo, "errore", GUASTO);
      }
    }
    return { stato: "fatto", file: fatto };
  } finally {
    if (preso) await lucchetto.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('cerbero:dati-aperti'))").catch(() => {});
    lucchetto.release();
  }
}

/* ── le letture ────────────────────────────────────────────────────────── */

export interface StatoFile {
  tipo: TipoFile;
  formato: string;
  percorso: string;
  /** il file che chi scarica riceve adesso; null se non ce n'è */
  inLinea: null | {
    impronta: string; byte: number; preparatoIl: string;
    inEsercizioDal: string | null;
    /** il file viene dalla versione in esercizio di adesso (false: da quella di prima, perché la nuova non è uscita) */
    dellaVersioneInEsercizio: boolean;
    conteggi: unknown;
  };
  /** l'ultimo tentativo di prepararlo */
  ultimoTentativo: null | { esito: EsitoFile; messaggio: string | null; provatoIl: string | null; dettagli: unknown };
}

export interface StatoDatiAperti {
  attivi: boolean;
  aziendaCompilata: boolean;
  /** il programma in esercizio da cui nascono i file, o perché non c'è */
  versione: { nome: string; dal: string | null } | null;
  senzaVersione: string | null;
  file: StatoFile[];
}

/** Lo stato per l'amministratore: l'interruttore, la versione, i due file (senza i byte). */
export async function statoDatiAperti(): Promise<StatoDatiAperti> {
  const azienda = righe(await db.execute(sql`SELECT dati_aperti_attivi AS attivi FROM azienda WHERE unica`))[0];
  const v = await versioneInEsercizio();
  const r = righe(await db.execute(sql`
    SELECT tipo, impronta, byte, versione_id, in_esercizio_dal, preparato_il, conteggi, provato_il, esito, messaggio, dettagli
      FROM dati_aperti`));
  const perTipo = new Map(r.map((x) => [x.tipo as string, x]));
  return {
    attivi: azienda?.attivi === true,
    aziendaCompilata: !!azienda,
    versione: "senza" in v ? null : { nome: v.nome, dal: iso(v.dal) },
    senzaVersione: "senza" in v ? v.senza : null,
    file: TIPI.map((tipo) => {
      const x = perTipo.get(tipo);
      return {
        tipo, formato: FILE[tipo].formato, percorso: FILE[tipo].percorso,
        inLinea: x?.impronta ? {
          impronta: x.impronta, byte: Number(x.byte), preparatoIl: iso(x.preparato_il)!,
          inEsercizioDal: iso(x.in_esercizio_dal),
          dellaVersioneInEsercizio: !("senza" in v) && x.versione_id === v.versioneId,
          conteggi: x.conteggi ?? null,
        } : null,
        ultimoTentativo: x?.esito ? { esito: x.esito, messaggio: x.messaggio ?? null, provatoIl: iso(x.provato_il), dettagli: x.dettagli ?? null } : null,
      };
    }),
  };
}

export interface FileInLinea { impronta: string; byte: number; preparatoIl: Date; inEsercizioDal: Date | null }

/** Il file in linea, senza i byte; null se la pubblicazione è spenta o il file non c'è. */
export async function fileInLinea(tipo: TipoFile): Promise<FileInLinea | null> {
  const r = righe(await db.execute(sql`
    SELECT d.impronta, d.byte, d.preparato_il, d.in_esercizio_dal
      FROM dati_aperti d
     WHERE d.tipo = ${tipo} AND d.contenuto IS NOT NULL
       AND EXISTS (SELECT 1 FROM azienda a WHERE a.unica AND a.dati_aperti_attivi)`))[0];
  if (!r) return null;
  return { impronta: r.impronta, byte: Number(r.byte), preparatoIl: new Date(r.preparato_il), inEsercizioDal: r.in_esercizio_dal ? new Date(r.in_esercizio_dal) : null };
}

/** I byte del file con quell'impronta (null se nel frattempo è cambiato o è stato tolto). */
export async function contenutoInLinea(tipo: TipoFile, impronta: string): Promise<Buffer | null> {
  const r = righe(await db.execute(sql`
    SELECT d.contenuto
      FROM dati_aperti d
     WHERE d.tipo = ${tipo} AND d.impronta = ${impronta}
       AND EXISTS (SELECT 1 FROM azienda a WHERE a.unica AND a.dati_aperti_attivi)`))[0];
  return r?.contenuto ? Buffer.from(r.contenuto) : null;
}
