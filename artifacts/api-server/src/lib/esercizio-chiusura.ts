/**
 * Chiusura e blocco del consuntivo (tappa 4.6; analisi, «Chiusura e blocco»,
 * PR 7; migrazione 0029).
 *
 * Decisioni del 16/11/2026:
 *   - le corse senza prove dell'AVM si chiudono con la presunzione di
 *     effettuazione salvo segnalazione: un esito a sé, «presunta»;
 *   - la giornata la chiude chi ha il ruolo Amministrazione (o
 *     l'amministratore: chiudeLeGiornate in @workspace/permessi); la riapre
 *     solo l'amministratore, con un motivo che resta nel giornale;
 *   - il mese lo chiude e lo riapre solo l'amministratore; un mese chiuso
 *     blocca la riapertura dei suoi giorni;
 *   - nessun blocco automatico a tempo: la pagina segnala le giornate aperte
 *     da più di tre giorni.
 *
 * Una giornata si chiude quando è finita (dopo le 03:00 del giorno dopo) e
 * non ha più corse da decidere, da verificare, o parziali senza i km fatti.
 * Alla chiusura il riepilogo (corse e km per esito, per linea, per causale)
 * si congela; da lì ogni scrittura risponde 409. Riaprirla e richiuderla
 * senza modifiche dà lo stesso riepilogo.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { inizioDi } from "./service-day";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const km = (x: unknown) => Math.round(Number(x ?? 0) * 10) / 10;
const MESE = /^(\d{4})-(\d{2})$/;

export class RifiutoChiusura extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

/** «AAAA-MM» valido, fra il 2000 e il 2099. */
export function meseValido(m: unknown): m is string {
  const x = typeof m === "string" ? MESE.exec(m) : null;
  return !!x && Number(x[2]) >= 1 && Number(x[2]) <= 12 && m! >= "2000-01" && m! <= "2099-12";
}
/** I giorni di un mese, AAAA-MM-GG. */
export function giorniDelMese(mese: string): string[] {
  const [a, m] = mese.split("-").map(Number);
  const n = new Date(Date.UTC(a!, m!, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${mese}-${String(i + 1).padStart(2, "0")}`);
}

/* ── Il riepilogo ────────────────────────────────────────────────────────── */

export interface Riepilogo {
  corse: { programmate: number; aggiunte: number; effettuate: number; presunte: number; parziali: number; soppresse: number };
  km: { programmati: number; effettivi: number; persi: number; aggiunti: number };
  perLinea: Array<{ linea: string | null; programmate: number; effettuate: number; presunte: number; parziali: number; soppresse: number; aggiunte: number; kmProgrammati: number; kmEffettivi: number }>;
  perCausale: Array<{ causale: string; descrizione: string | null; imputabile: boolean | null; corse: number; kmPersi: number }>;
}

/** Il riepilogo delle corse di un insieme di giornate (una giornata, o le chiuse di un mese). */
async function riepilogoDi(ex: any, dove: ReturnType<typeof sql>): Promise<Riepilogo> {
  const conta = sql`
    count(*) FILTER (WHERE c.origine = 'programmata')::int AS programmate,
    count(*) FILTER (WHERE c.origine = 'aggiunta')::int AS aggiunte,
    count(*) FILTER (WHERE c.esito = 'effettuata')::int AS effettuate,
    count(*) FILTER (WHERE c.esito = 'presunta')::int AS presunte,
    count(*) FILTER (WHERE c.esito = 'parziale')::int AS parziali,
    count(*) FILTER (WHERE c.esito = 'soppressa')::int AS soppresse,
    COALESCE(sum(c.km_prog) FILTER (WHERE c.origine = 'programmata'), 0) AS km_prog,
    COALESCE(sum(c.km_eff), 0) AS km_eff,
    COALESCE(sum(COALESCE(c.km_prog, 0) - COALESCE(c.km_eff, 0)) FILTER (WHERE c.esito IN ('soppressa', 'parziale') AND c.origine = 'programmata'), 0) AS km_persi,
    COALESCE(sum(c.km_eff) FILTER (WHERE c.origine = 'aggiunta'), 0) AS km_aggiunti`;
  const t = righe(await ex.execute(sql`SELECT ${conta} FROM esercizio_corse c WHERE ${dove}`))[0] ?? {};
  const perLinea = righe(await ex.execute(sql`SELECT c.linea, ${conta} FROM esercizio_corse c WHERE ${dove} GROUP BY c.linea ORDER BY c.linea NULLS LAST`));
  const perCausale = righe(await ex.execute(sql`
    SELECT c.causale, k.descrizione, k.imputabile_azienda, count(*)::int AS corse,
           COALESCE(sum(COALESCE(c.km_prog, 0) - COALESCE(c.km_eff, 0)), 0) AS km_persi
      FROM esercizio_corse c LEFT JOIN esercizio_causali k ON k.codice = c.causale
     WHERE ${dove} AND c.causale IS NOT NULL AND c.esito IN ('soppressa', 'parziale')
     GROUP BY c.causale, k.descrizione, k.imputabile_azienda ORDER BY count(*) DESC, c.causale`));
  return {
    corse: { programmate: t.programmate ?? 0, aggiunte: t.aggiunte ?? 0, effettuate: t.effettuate ?? 0, presunte: t.presunte ?? 0, parziali: t.parziali ?? 0, soppresse: t.soppresse ?? 0 },
    km: { programmati: km(t.km_prog), effettivi: km(t.km_eff), persi: km(t.km_persi), aggiunti: km(t.km_aggiunti) },
    perLinea: perLinea.map((l) => ({
      linea: l.linea ?? null, programmate: l.programmate, effettuate: l.effettuate, presunte: l.presunte, parziali: l.parziali,
      soppresse: l.soppresse, aggiunte: l.aggiunte, kmProgrammati: km(l.km_prog), kmEffettivi: km(l.km_eff),
    })),
    perCausale: perCausale.map((c) => ({
      causale: c.causale, descrizione: c.descrizione ?? null, imputabile: c.imputabile_azienda ?? null, corse: c.corse, kmPersi: km(c.km_persi),
    })),
  };
}

/** Che cosa manca per chiudere una giornata: corse da decidere, da verificare, parziali senza km. */
async function cosaManca(ex: any, giorno: string) {
  const r = righe(await ex.execute(sql`
    SELECT count(*) FILTER (WHERE esito IS NULL)::int AS da_decidere,
           count(*) FILTER (WHERE esito = 'da_verificare')::int AS da_verificare,
           count(*) FILTER (WHERE esito = 'parziale' AND km_eff IS NULL)::int AS parziali_senza_km,
           now() >= ${inizioDi(sql`${giorno}::date + 1`)} AS finita
      FROM esercizio_corse WHERE giorno = ${giorno}::date`))[0] ?? {};
  return { daDecidere: r.da_decidere ?? 0, daVerificare: r.da_verificare ?? 0, parzialiSenzaKm: r.parziali_senza_km ?? 0, finita: !!r.finita };
}

/** Che cosa manca per chiudere, in parole; null se si può chiudere. */
export function perchéNonSiChiude(m: { daDecidere: number; daVerificare: number; parzialiSenzaKm: number; finita: boolean }): string | null {
  if (!m.finita) return "La giornata non è ancora finita: si chiude dopo le 03:00 del giorno dopo";
  const parti = [
    m.daDecidere ? `${m.daDecidere} corse da decidere` : null,
    m.daVerificare ? `${m.daVerificare} corse da verificare` : null,
    m.parzialiSenzaKm ? `${m.parzialiSenzaKm} parziali senza i km fatti` : null,
  ].filter(Boolean);
  return parti.length ? `Non si chiude: ${parti.join(", ")}` : null;
}

const lucchettoGiornata = (ex: any, giorno: string) => ex.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cerbero:giornata:${giorno}`}))`);
const lucchettoMese = (ex: any, mese: string) => ex.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cerbero:mese:${mese}`}))`);

/* ── La giornata ─────────────────────────────────────────────────────────── */

/** Chiude una giornata e ne congela il riepilogo. Chi può, lo decide la rotta (chiudeLeGiornate). */
export async function chiudiGiornata(giorno: string, versione: number, autore: string | null) {
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await lucchettoGiornata(ex, giorno);
    const g = righe(await ex.execute(sql`SELECT stato, versione FROM esercizio_giornate WHERE giorno = ${giorno}::date FOR UPDATE`))[0];
    if (!g) throw new RifiutoChiusura(404, "Giornata non ancora preparata");
    if (g.stato === "chiusa") throw new RifiutoChiusura(409, "Giornata già chiusa");
    if (g.stato !== "congelata") throw new RifiutoChiusura(409, "La giornata non è ancora cominciata");
    if (Number(g.versione) !== versione) throw new RifiutoChiusura(409, "Nel frattempo la giornata è cambiata: ricaricala e riprova");
    const motivo = perchéNonSiChiude(await cosaManca(ex, giorno));
    if (motivo) throw new RifiutoChiusura(409, motivo);
    const riepilogo = await riepilogoDi(ex, sql`c.giorno = ${giorno}::date`);
    await ex.execute(sql`
      UPDATE esercizio_giornate SET stato = 'chiusa', chiusa_da = ${autore}::uuid, chiusa_il = now(),
             riepilogo = ${JSON.stringify(riepilogo)}::jsonb, versione = versione + 1
       WHERE giorno = ${giorno}::date`);
    await ex.execute(sql`
      INSERT INTO esercizio_eventi (giorno, tipo, dati, fonte, autore)
      VALUES (${giorno}::date, 'chiusura', ${JSON.stringify({ corse: riepilogo.corse, km: riepilogo.km })}::jsonb, 'movimento', ${autore}::uuid)`);
    return { stato: "chiusa" as const, versione: Number(g.versione) + 1, riepilogo };
  });
}

/** Riapre una giornata chiusa (solo l'amministratore, con un motivo); non se il suo mese è chiuso. */
export async function riapriGiornata(giorno: string, motivo: string, autore: string | null) {
  const m = motivo.trim();
  if (m.length < 5 || m.length > 500) throw new RifiutoChiusura(400, "Il motivo della riapertura: da 5 a 500 caratteri");
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await lucchettoMese(ex, giorno.slice(0, 7));
    await lucchettoGiornata(ex, giorno);
    const g = righe(await ex.execute(sql`SELECT stato FROM esercizio_giornate WHERE giorno = ${giorno}::date FOR UPDATE`))[0];
    if (!g) throw new RifiutoChiusura(404, "Giornata non ancora preparata");
    if (g.stato !== "chiusa") throw new RifiutoChiusura(409, "La giornata non è chiusa");
    const mese = righe(await ex.execute(sql`SELECT stato FROM esercizio_mesi WHERE mese = ${`${giorno.slice(0, 7)}-01`}::date`))[0];
    if (mese?.stato === "chiuso") throw new RifiutoChiusura(409, "Il mese è chiuso: riapri prima il mese");
    const v = righe(await ex.execute(sql`
      UPDATE esercizio_giornate SET stato = 'congelata', chiusa_da = NULL, chiusa_il = NULL, riepilogo = NULL, versione = versione + 1
       WHERE giorno = ${giorno}::date RETURNING versione`))[0];
    await ex.execute(sql`
      INSERT INTO esercizio_eventi (giorno, tipo, dati, fonte, autore)
      VALUES (${giorno}::date, 'riapertura', ${JSON.stringify({ nota: m })}::jsonb, 'movimento', ${autore}::uuid)`);
    return { stato: "congelata" as const, versione: Number(v.versione) };
  });
}

/** Che cosa manca per chiudere una giornata, per la pagina. */
export async function chiusuraDellaGiornata(giorno: string) {
  const g = righe(await db.execute(sql`
    SELECT g.stato, g.chiusa_il, g.riepilogo, COALESCE(u.full_name, u.email) AS chiusa_da
      FROM esercizio_giornate g LEFT JOIN users u ON u.id = g.chiusa_da WHERE g.giorno = ${giorno}::date`))[0];
  if (!g) return null;
  const manca = await cosaManca(db as any, giorno);
  const mese = righe(await db.execute(sql`SELECT stato FROM esercizio_mesi WHERE mese = ${`${giorno.slice(0, 7)}-01`}::date`))[0];
  return {
    chiusa: g.stato === "chiusa", chiusaIl: g.chiusa_il ? new Date(g.chiusa_il).toISOString() : null, chiusaDa: g.chiusa_da ?? null,
    riepilogo: g.riepilogo ?? null, manca, perché: g.stato === "congelata" ? perchéNonSiChiude(manca) : null, meseChiuso: mese?.stato === "chiuso",
  };
}

/* ── Il mese ─────────────────────────────────────────────────────────────── */

async function giornateDelMese(ex: any, mese: string) {
  return righe(await ex.execute(sql`
    SELECT giorno::text AS giorno, stato FROM esercizio_giornate
     WHERE giorno >= ${`${mese}-01`}::date AND giorno < ${`${mese}-01`}::date + interval '1 month' ORDER BY giorno`))
    .map((x) => ({ giorno: String(x.giorno).slice(0, 10), stato: String(x.stato) }));
}

/** Lo stato di un mese: le sue giornate, quelle che mancano, il riepilogo delle chiuse (o quello congelato). */
export async function statoDelMese(mese: string) {
  const giornate = await giornateDelMese(db, mese);
  const presenti = new Set(giornate.map((g) => g.giorno));
  const m = righe(await db.execute(sql`SELECT stato, riepilogo, chiuso_il, storia FROM esercizio_mesi WHERE mese = ${`${mese}-01`}::date`))[0];
  const storia: any[] = Array.isArray(m?.storia) ? m.storia : [];
  const autori = [...new Set(storia.map((s) => s.da).filter(Boolean))];
  const nomi = new Map<string, string>();
  if (autori.length) {
    for (const u of righe(await db.execute(sql`SELECT id::text, COALESCE(full_name, email) AS nome FROM users WHERE id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(autori)}::jsonb))`))) nomi.set(u.id, u.nome);
  }
  const chiuso = m?.stato === "chiuso";
  return {
    mese, stato: chiuso ? "chiuso" : "aperto", chiusoIl: m?.chiuso_il ? new Date(m.chiuso_il).toISOString() : null,
    giorni: giorniDelMese(mese).length,
    chiuse: giornate.filter((g) => g.stato === "chiusa").length,
    aperte: giornate.filter((g) => g.stato !== "chiusa").map((g) => g.giorno),
    mancanti: giorniDelMese(mese).filter((g) => !presenti.has(g)),
    riepilogo: chiuso ? m.riepilogo
      : await riepilogoDi(db, sql`c.giorno IN (SELECT giorno FROM esercizio_giornate WHERE stato = 'chiusa'
          AND giorno >= ${`${mese}-01`}::date AND giorno < ${`${mese}-01`}::date + interval '1 month')`),
    storia: storia.map((s) => ({ ...s, da: s.da ? nomi.get(s.da) ?? null : null })),
  };
}

/** Chiude un mese finito, con tutte le sue giornate chiuse (solo l'amministratore). */
export async function chiudiMese(mese: string, autore: string | null) {
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await lucchettoMese(ex, mese);
    const finito = righe(await ex.execute(sql`SELECT now() >= ${inizioDi(sql`(${`${mese}-01`}::date + interval '1 month')::date`)} AS si`))[0]?.si;
    if (!finito) throw new RifiutoChiusura(409, "Il mese non è ancora finito");
    const m = righe(await ex.execute(sql`SELECT stato FROM esercizio_mesi WHERE mese = ${`${mese}-01`}::date FOR UPDATE`))[0];
    if (m?.stato === "chiuso") throw new RifiutoChiusura(409, "Mese già chiuso");
    const giornate = await giornateDelMese(ex, mese);
    const aperte = giornate.filter((g) => g.stato !== "chiusa").map((g) => g.giorno);
    if (aperte.length) throw new RifiutoChiusura(409, `Non si chiude: ${aperte.length} giornate ancora aperte (${aperte.slice(0, 5).join(", ")}${aperte.length > 5 ? "…" : ""})`);
    if (!giornate.length) throw new RifiutoChiusura(409, "Nel mese non c'è nessuna giornata chiusa");
    const presenti = new Set(giornate.map((g) => g.giorno));
    const riepilogo = {
      ...(await riepilogoDi(ex, sql`c.giorno >= ${`${mese}-01`}::date AND c.giorno < ${`${mese}-01`}::date + interval '1 month'`)),
      giorni: { delMese: giorniDelMese(mese).length, chiusi: giornate.length, mancanti: giorniDelMese(mese).filter((g) => !presenti.has(g)) },
    };
    const voce = { azione: "chiusura", da: autore, il: new Date().toISOString() };
    await ex.execute(sql`
      INSERT INTO esercizio_mesi (mese, stato, riepilogo, chiuso_da, chiuso_il, storia)
      VALUES (${`${mese}-01`}::date, 'chiuso', ${JSON.stringify(riepilogo)}::jsonb, ${autore}::uuid, now(), ${JSON.stringify([voce])}::jsonb)
      ON CONFLICT (mese) DO UPDATE SET stato = 'chiuso', riepilogo = EXCLUDED.riepilogo, chiuso_da = EXCLUDED.chiuso_da,
        chiuso_il = EXCLUDED.chiuso_il, storia = esercizio_mesi.storia || EXCLUDED.storia`);
    return { stato: "chiuso" as const, riepilogo };
  });
}

/** Riapre un mese chiuso (solo l'amministratore, con un motivo): le sue giornate si possono di nuovo riaprire. */
export async function riapriMese(mese: string, motivo: string, autore: string | null) {
  const m = motivo.trim();
  if (m.length < 5 || m.length > 500) throw new RifiutoChiusura(400, "Il motivo della riapertura: da 5 a 500 caratteri");
  return db.transaction(async (tx) => {
    const ex = tx as any;
    await lucchettoMese(ex, mese);
    const r = righe(await ex.execute(sql`SELECT stato FROM esercizio_mesi WHERE mese = ${`${mese}-01`}::date FOR UPDATE`))[0];
    if (r?.stato !== "chiuso") throw new RifiutoChiusura(409, "Il mese non è chiuso");
    const voce = { azione: "riapertura", da: autore, il: new Date().toISOString(), motivo: m };
    await ex.execute(sql`
      UPDATE esercizio_mesi SET stato = 'aperto', riepilogo = NULL, chiuso_da = NULL, chiuso_il = NULL,
             storia = storia || ${JSON.stringify([voce])}::jsonb
       WHERE mese = ${`${mese}-01`}::date`);
    return { stato: "aperto" as const };
  });
}
