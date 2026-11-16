/**
 * Il report mensile del consuntivo (tappa 4.7; analisi, «Uscite» e PR 8).
 *
 * Decisioni del 16/11/2026, in attesa del modello dell'ente (decisione aperta
 * 11): un report standard del mese, sulle giornate CHIUSE, in XLSX (riepilogo,
 * indicatori, ripartizioni) e in CSV (il dettaglio corsa per corsa, per le
 * contestazioni: in un mese sono circa centomila righe).
 *
 * Indicatori (decisione aperta 12):
 *   - regolarità LORDA: corse effettuate (provate e presunte) sulle
 *     programmate; km effettivi delle programmate sui programmati;
 *   - regolarità NETTA: lo stesso, togliendo dal programmato le soppressioni
 *     e le parziali con causale non imputabile all'azienda;
 *   - quota provata: le effettuate con le prove dell'AVM sulle programmate;
 *   - puntualità solo sul campione visto dall'AVM (partenza dal capolinea
 *     osservata), sempre accanto alla sua copertura: in orario fra 1 minuto
 *     di anticipo e 5 di ritardo, come la Sala Operativa. Mai presentata come
 *     la puntualità dell'azienda. Niente penali.
 * Le corse aggiunte si contano a parte: non entrano nella regolarità.
 *
 * Ripartizioni: linea, tipo di servizio e contratto (dalle linee di Planning
 * Studio, dove impostati), comune (il ritaglio dei percorsi sui confini della
 * zonizzazione, lib/geo-zones.ts), causale, giorno, vettore (dalla vettura:
 * Conerobus o la consorziata, lib/parco-anagrafica.ts; decisione aperta 8:
 * nel report dell'azienda, con la ripartizione).
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { bboxIntersects, bboxOfCoords, bboxOfGeometry, lineKmInsidePolygon, type ZoneGeometry } from "./geo-zones";
import { lunghezzaDellaGeometria } from "./km-programmati";
import { aziendaDaSiri } from "./parco-anagrafica";
import { giorniDelMese } from "./esercizio-chiusura";
import { Stili, scriviXlsx, type Foglio, type Valore } from "./xlsx-mini";

const righe = (r: any): any[] => r?.rows ?? r ?? [];
const n = (x: unknown) => Number(x ?? 0) || 0;
const km = (x: unknown) => Math.round(n(x) * 10) / 10;
const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** In orario: da 1 minuto di anticipo a 5 di ritardo (come la Sala Operativa). */
export const PUNTUALITA = { anticipoS: -60, ritardoS: 300 } as const;

/* ── Gli indicatori (puri) ───────────────────────────────────────────────── */

export interface Conteggi {
  programmate: number; effettuate: number; presunte: number; parziali: number; soppresse: number; aggiunte: number;
  kmProgrammati: number; kmEffettiviProgrammate: number; kmEffettiviAggiunte: number; kmPersi: number;
  /** soppressioni e parziali con causale non imputabile all'azienda, e i loro km persi */
  soppresseNonImputabili: number; parzialiNonImputabili: number; kmProgrammatiNonImputabili: number; kmPersiNonImputabili: number;
  /** il campione dell'AVM per la puntualità */
  campione: number; inOrario: number;
}

export function indicatori(c: Conteggi) {
  const fatte = c.effettuate + c.presunte;
  const escluse = c.soppresseNonImputabili + c.parzialiNonImputabili;
  /* togliere una corsa non imputabile toglie i suoi km programmati, e con loro quello che ne è stato fatto */
  const kmEffNetti = c.kmEffettiviProgrammate - (c.kmProgrammatiNonImputabili - c.kmPersiNonImputabili);
  return {
    regolaritaCorse: { lorda: pct(fatte, c.programmate), netta: pct(fatte, c.programmate - escluse) },
    regolaritaKm: {
      lorda: pct(c.kmEffettiviProgrammate, c.kmProgrammati),
      netta: pct(kmEffNetti, c.kmProgrammati - c.kmProgrammatiNonImputabili),
    },
    quotaProvata: pct(c.effettuate, c.programmate),
    puntualita: { campione: c.campione, inOrario: c.inOrario, quota: pct(c.inOrario, c.campione), copertura: pct(c.campione, c.programmate) },
  };
}

/* ── Le aggregazioni ─────────────────────────────────────────────────────── */

const CONTA = sql`
  count(*) FILTER (WHERE c.origine = 'programmata')::int AS programmate,
  count(*) FILTER (WHERE c.esito = 'effettuata' AND c.origine = 'programmata')::int AS effettuate,
  count(*) FILTER (WHERE c.esito = 'presunta')::int AS presunte,
  count(*) FILTER (WHERE c.esito = 'parziale')::int AS parziali,
  count(*) FILTER (WHERE c.esito = 'soppressa')::int AS soppresse,
  count(*) FILTER (WHERE c.origine = 'aggiunta')::int AS aggiunte,
  COALESCE(sum(c.km_prog) FILTER (WHERE c.origine = 'programmata'), 0) AS km_prog,
  COALESCE(sum(c.km_eff) FILTER (WHERE c.origine = 'programmata'), 0) AS km_eff_prog,
  COALESCE(sum(c.km_eff) FILTER (WHERE c.origine = 'aggiunta'), 0) AS km_eff_agg,
  COALESCE(sum(COALESCE(c.km_prog, 0) - COALESCE(c.km_eff, 0)) FILTER (WHERE c.esito IN ('soppressa', 'parziale') AND c.origine = 'programmata'), 0) AS km_persi,
  count(*) FILTER (WHERE c.esito = 'soppressa' AND k.imputabile_azienda = false)::int AS soppresse_ni,
  count(*) FILTER (WHERE c.esito = 'parziale' AND k.imputabile_azienda = false)::int AS parziali_ni,
  COALESCE(sum(c.km_prog) FILTER (WHERE c.esito IN ('soppressa', 'parziale') AND k.imputabile_azienda = false AND c.origine = 'programmata'), 0) AS km_prog_ni,
  COALESCE(sum(COALESCE(c.km_prog, 0) - COALESCE(c.km_eff, 0)) FILTER (WHERE c.esito IN ('soppressa', 'parziale') AND k.imputabile_azienda = false AND c.origine = 'programmata'), 0) AS km_persi_ni,
  count(*) FILTER (WHERE c.origine = 'programmata' AND (c.prove->>'ritardoPartenza') ~ '^-?[0-9]+$')::int AS campione,
  count(*) FILTER (WHERE c.origine = 'programmata' AND (c.prove->>'ritardoPartenza') ~ '^-?[0-9]+$'
                    AND (c.prove->>'ritardoPartenza')::int BETWEEN ${PUNTUALITA.anticipoS} AND ${PUNTUALITA.ritardoS})::int AS in_orario`;

const conteggiDi = (r: any): Conteggi => ({
  programmate: n(r.programmate), effettuate: n(r.effettuate), presunte: n(r.presunte), parziali: n(r.parziali), soppresse: n(r.soppresse),
  aggiunte: n(r.aggiunte), kmProgrammati: n(r.km_prog), kmEffettiviProgrammate: n(r.km_eff_prog), kmEffettiviAggiunte: n(r.km_eff_agg),
  kmPersi: n(r.km_persi), soppresseNonImputabili: n(r.soppresse_ni), parzialiNonImputabili: n(r.parziali_ni),
  kmProgrammatiNonImputabili: n(r.km_prog_ni), kmPersiNonImputabili: n(r.km_persi_ni), campione: n(r.campione), inOrario: n(r.in_orario),
});

/** Una riga di ripartizione: i conteggi, i km arrotondati una volta sola, gli indicatori. */
function voce(chiave: Record<string, unknown>, r: any) {
  const c = conteggiDi(r);
  const i = indicatori(c);
  return {
    ...chiave,
    programmate: c.programmate, effettuate: c.effettuate, presunte: c.presunte, parziali: c.parziali, soppresse: c.soppresse, aggiunte: c.aggiunte,
    kmProgrammati: km(c.kmProgrammati), kmEffettivi: km(c.kmEffettiviProgrammate), kmAggiunti: km(c.kmEffettiviAggiunte), kmPersi: km(c.kmPersi),
    regolaritaCorse: i.regolaritaCorse.lorda, regolaritaCorseNetta: i.regolaritaCorse.netta,
    regolaritaKm: i.regolaritaKm.lorda, regolaritaKmNetta: i.regolaritaKm.netta,
  };
}

/** Le corse delle giornate chiuse del mese, con la causale e la linea di Planning Studio. */
const DA = (mese: string) => sql`
  FROM esercizio_corse c
  JOIN esercizio_giornate g ON g.giorno = c.giorno AND g.stato = 'chiusa'
  LEFT JOIN esercizio_causali k ON k.codice = c.causale
  LEFT JOIN ps_routes pr ON pr.id::text = c.route_id
 WHERE c.giorno >= ${`${mese}-01`}::date AND c.giorno < ${`${mese}-01`}::date + interval '1 month'`;

async function perComune(mese: string) {
  const zone = righe(await db.execute(sql`SELECT id::text, name, istat_code, geometry FROM zones`))
    .filter((z) => z.geometry && (z.geometry.type === "Polygon" || z.geometry.type === "MultiPolygon"))
    .map((z) => ({ id: String(z.id), nome: String(z.name ?? z.istat_code ?? z.id), istat: z.istat_code ?? null, geom: z.geometry as ZoneGeometry, bbox: bboxOfGeometry(z.geometry) }));
  if (!zone.length) return { comuni: [], nota: "Nessun confine comunale importato (Planning Studio › Zonizzazione): ripartizione per comune non disponibile." };
  /* i km per percorso, una volta: programmati e fatti */
  const percorsi = righe(await db.execute(sql`
    SELECT g.feed_id::text AS feed, c.shape_id,
           COALESCE(sum(c.km_prog) FILTER (WHERE c.origine = 'programmata'), 0) AS km_prog,
           COALESCE(sum(c.km_eff) FILTER (WHERE c.origine = 'programmata'), 0) AS km_eff
      FROM esercizio_corse c JOIN esercizio_giornate g ON g.giorno = c.giorno AND g.stato = 'chiusa'
     WHERE c.giorno >= ${`${mese}-01`}::date AND c.giorno < ${`${mese}-01`}::date + interval '1 month'
     GROUP BY g.feed_id, c.shape_id`));
  const perComune = new Map<string, { kmProg: number; kmEff: number }>();
  /* fuori: la parte dei percorsi fuori da ogni confine; senza: le corse senza un percorso da ritagliare.
     Con le due righe in più, la somma per comune torna con i km del mese. */
  let fuoriProg = 0, fuoriEff = 0, senzaProg = 0, senzaEff = 0;
  const perFeed = new Map<string, Set<string>>();
  for (const p of percorsi) {
    if (!p.feed || p.shape_id == null) continue;
    let s = perFeed.get(p.feed);
    if (!s) perFeed.set(p.feed, (s = new Set()));
    s.add(String(p.shape_id));
  }
  const geometrie = new Map<string, any>();
  for (const [feed, shapes] of perFeed) {
    for (const s of righe(await db.execute(sql`
      SELECT shape_id, geojson FROM gtfs_shapes WHERE feed_id = ${feed}::uuid AND shape_id IN (SELECT jsonb_array_elements_text(${JSON.stringify([...shapes])}::jsonb))`))) {
      geometrie.set(`${feed}|${s.shape_id}`, s.geojson);
    }
  }
  for (const p of percorsi) {
    const g = geometrie.get(`${p.feed}|${p.shape_id}`);
    const coords: [number, number][] = g?.type === "LineString" && Array.isArray(g.coordinates) ? g.coordinates : [];
    const totale = lunghezzaDellaGeometria(g) / 1000;
    if (coords.length < 2 || !(totale > 0)) { senzaProg += n(p.km_prog); senzaEff += n(p.km_eff); continue; }
    const bb = bboxOfCoords(coords);
    let dentro = 0;
    for (const z of zone) {
      if (!bboxIntersects(bb, z.bbox)) continue;
      const k = lineKmInsidePolygon(coords, z.geom);
      if (!(k > 0)) continue;
      const quota = Math.min(1, k / totale);
      dentro += quota;
      const x = perComune.get(z.id) ?? { kmProg: 0, kmEff: 0 };
      x.kmProg += n(p.km_prog) * quota;
      x.kmEff += n(p.km_eff) * quota;
      perComune.set(z.id, x);
    }
    const fuori = Math.max(0, 1 - dentro);
    fuoriProg += n(p.km_prog) * fuori;
    fuoriEff += n(p.km_eff) * fuori;
  }
  const comuni = zone.filter((z) => perComune.has(z.id)).map((z) => ({
    comune: z.nome, istat: z.istat, kmProgrammati: km(perComune.get(z.id)!.kmProg), kmEffettivi: km(perComune.get(z.id)!.kmEff),
    regolaritaKm: pct(perComune.get(z.id)!.kmEff, perComune.get(z.id)!.kmProg),
  })).sort((a, b) => b.kmProgrammati - a.kmProgrammati || a.comune.localeCompare(b.comune));
  if (fuoriProg > 0.05) comuni.push({ comune: "Fuori dai confini importati", istat: null, kmProgrammati: km(fuoriProg), kmEffettivi: km(fuoriEff), regolaritaKm: pct(fuoriEff, fuoriProg) });
  if (senzaProg > 0.05) comuni.push({ comune: "Corse senza percorso", istat: null, kmProgrammati: km(senzaProg), kmEffettivi: km(senzaEff), regolaritaKm: pct(senzaEff, senzaProg) });
  return { comuni, nota: null as string | null };
}

/** Il report del mese, sulle giornate chiuse. */
export async function reportDelMese(mese: string) {
  const giornate = righe(await db.execute(sql`
    SELECT giorno::text AS giorno, stato FROM esercizio_giornate
     WHERE giorno >= ${`${mese}-01`}::date AND giorno < ${`${mese}-01`}::date + interval '1 month' ORDER BY giorno`))
    .map((x) => ({ giorno: String(x.giorno).slice(0, 10), stato: String(x.stato) }));
  const stato = righe(await db.execute(sql`SELECT stato FROM esercizio_mesi WHERE mese = ${`${mese}-01`}::date`))[0]?.stato ?? "aperto";
  const presenti = new Set(giornate.map((g) => g.giorno));
  const totale = righe(await db.execute(sql`SELECT ${CONTA} ${DA(mese)}`))[0] ?? {};
  const raggruppa = async (colonna: ReturnType<typeof sql>, nome: string) =>
    righe(await db.execute(sql`SELECT ${colonna} AS chiave, ${CONTA} ${DA(mese)} GROUP BY 1 ORDER BY 1 NULLS LAST`)).map((r) => voce({ [nome]: r.chiave ?? null }, r));
  const perCausale = righe(await db.execute(sql`
    SELECT c.causale, k.descrizione, k.gruppo, k.imputabile_azienda, k.codice_ente,
           count(*) FILTER (WHERE c.esito = 'soppressa')::int AS soppresse, count(*) FILTER (WHERE c.esito = 'parziale')::int AS parziali,
           COALESCE(sum(COALESCE(c.km_prog, 0) - COALESCE(c.km_eff, 0)), 0) AS km_persi
      ${DA(mese)} AND c.causale IS NOT NULL AND c.esito IN ('soppressa', 'parziale')
     GROUP BY c.causale, k.descrizione, k.gruppo, k.imputabile_azienda, k.codice_ente ORDER BY count(*) DESC, c.causale`)).map((r) => ({
    causale: r.causale, descrizione: r.descrizione ?? null, gruppo: r.gruppo ?? null, imputabile: r.imputabile_azienda ?? null,
    codiceEnte: r.codice_ente ?? null, soppresse: n(r.soppresse), parziali: n(r.parziali), kmPersi: km(r.km_persi),
  }));
  /* il vettore dalla vettura: prima per vettura, poi si somma per vettore */
  const perVetturaRighe = righe(await db.execute(sql`SELECT c.vettura AS chiave, ${CONTA} ${DA(mese)} GROUP BY 1`));
  const perVettoreMappa = new Map<string, any>();
  for (const r of perVetturaRighe) {
    const vettore = r.chiave ? aziendaDaSiri(String(r.chiave)) ?? "Vettura non attribuita" : "Vettura non indicata";
    const s = perVettoreMappa.get(vettore) ?? {};
    for (const [k, v] of Object.entries(r)) if (k !== "chiave") s[k] = n(s[k]) + n(v);
    perVettoreMappa.set(vettore, s);
  }
  const perVettore = [...perVettoreMappa].map(([vettore, r]) => voce({ vettore }, r)).sort((a, b) => b.programmate + b.aggiunte - (a.programmate + a.aggiunte));
  const comuni = await perComune(mese);
  const c = conteggiDi(totale);
  return {
    mese, statoMese: stato,
    giornate: {
      delMese: giorniDelMese(mese).length, chiuse: giornate.filter((g) => g.stato === "chiusa").length,
      aperte: giornate.filter((g) => g.stato !== "chiusa").map((g) => g.giorno),
      mancanti: giorniDelMese(mese).filter((g) => !presenti.has(g)),
    },
    soglie: { puntualita: PUNTUALITA },
    totali: voce({}, totale),
    indicatori: indicatori(c),
    perLinea: await raggruppa(sql`c.linea`, "linea"),
    perServizio: await raggruppa(sql`to_jsonb(pr)->>'service_type'`, "servizio"),
    perContratto: await raggruppa(sql`to_jsonb(pr)->>'contract_id'`, "contratto"),
    perGiorno: await raggruppa(sql`c.giorno::text`, "giorno"),
    perCausale, perVettore,
    perComune: comuni.comuni, notaComuni: comuni.nota,
  };
}

/* ── L'XLSX e il CSV ─────────────────────────────────────────────────────── */

type Report = Awaited<ReturnType<typeof reportDelMese>>;
const COLONNE_VOCE: Array<[string, string]> = [
  ["programmate", "Programmate"], ["effettuate", "Effettuate (provate)"], ["presunte", "Presunte"], ["parziali", "Parziali"],
  ["soppresse", "Soppresse"], ["aggiunte", "Aggiunte"], ["kmProgrammati", "Km programmati"], ["kmEffettivi", "Km effettivi"],
  ["kmPersi", "Km persi"], ["kmAggiunti", "Km aggiunti"], ["regolaritaCorse", "Regolarità corse %"], ["regolaritaCorseNetta", "Regolarità corse netta %"],
  ["regolaritaKm", "Regolarità km %"], ["regolaritaKmNetta", "Regolarità km netta %"],
];

/** Il report in XLSX: riepilogo, indicatori e ripartizioni (il dettaglio è nel CSV). */
export function reportXlsx(r: Report, azienda: string | null): Buffer {
  const st = new Stili();
  const titolo = st.indice({ bold: true, size: 14 });
  const testa = st.indice({ bold: true, fill: "E8EEF5", border: true });
  const cella = st.indice({ border: true });
  const nota = st.indice({ italic: true, color: "666666" });
  const intestazione = (xs: string[]): Valore[] => xs.map((v) => ({ v, s: testa }));
  const riga = (xs: Valore[]): Valore[] => xs.map((v) => (v && typeof v === "object" ? v : { v: v ?? null, s: cella }));
  const tabella = (nome: string, prime: Array<[string, string]>, voci: any[]): Foglio => ({
    nome,
    righe: [intestazione([...prime.map((p) => p[1]), ...COLONNE_VOCE.map((p) => p[1])]),
      ...voci.map((v) => riga([...prime.map((p) => v[p[0]] ?? "—"), ...COLONNE_VOCE.map((p) => v[p[0]] ?? null)]))],
    larghezze: [...prime.map(() => 18), ...COLONNE_VOCE.map(() => 14)], blocca: { righe: 1, colonne: prime.length },
  });
  const i = r.indicatori;
  const riepilogo: Foglio = {
    nome: "Riepilogo",
    righe: [
      [{ v: `Consuntivo del mese ${r.mese}${azienda ? ` · ${azienda}` : ""}`, s: titolo }],
      [{ v: `Giornate chiuse ${r.giornate.chiuse} su ${r.giornate.delMese}; ${r.statoMese === "chiuso" ? "mese chiuso" : "mese aperto: report provvisorio"}. Si contano solo le giornate chiuse.`, s: nota }],
      [],
      intestazione(["Voce", "Valore"]),
      ...([
        ["Corse programmate", r.totali.programmate], ["Effettuate (provate dall'AVM)", r.totali.effettuate], ["Presunte (senza prove)", r.totali.presunte],
        ["Parziali", r.totali.parziali], ["Soppresse", r.totali.soppresse], ["Aggiunte (fuori dal programmato)", r.totali.aggiunte],
        ["Km programmati", r.totali.kmProgrammati], ["Km effettivi delle programmate", r.totali.kmEffettivi], ["Km persi", r.totali.kmPersi],
        ["Km delle aggiunte", r.totali.kmAggiunti],
        ["Regolarità corse lorda %", i.regolaritaCorse.lorda], ["Regolarità corse netta %", i.regolaritaCorse.netta],
        ["Regolarità km lorda %", i.regolaritaKm.lorda], ["Regolarità km netta %", i.regolaritaKm.netta],
        ["Quota provata dall'AVM %", i.quotaProvata],
        ["Puntualità sul campione AVM %", i.puntualita.quota], ["Campione AVM (corse con partenza osservata)", i.puntualita.campione],
        ["Copertura del campione %", i.puntualita.copertura],
      ] as Array<[string, Valore]>).map(([k, v]) => riga([k, v])),
      [],
      [{ v: "Regolarità netta: senza le soppressioni e le parziali con causale non imputabile all'azienda. Puntualità: in orario da 1' di anticipo a 5' di ritardo, solo sulle corse viste dall'AVM: non è la puntualità dell'azienda.", s: nota }],
      ...(r.giornate.aperte.length ? [[{ v: `Giornate ancora aperte, fuori dal report: ${r.giornate.aperte.join(", ")}`, s: nota }]] : []),
      ...(r.giornate.mancanti.length ? [[{ v: `Giorni senza giornata: ${r.giornate.mancanti.length} (${r.giornate.mancanti.slice(0, 10).join(", ")}${r.giornate.mancanti.length > 10 ? "…" : ""})`, s: nota }]] : []),
    ],
    larghezze: [48, 18],
  };
  const causali: Foglio = {
    nome: "Per causale",
    righe: [intestazione(["Causale", "Descrizione", "Gruppo", "Imputabile all'azienda", "Codice per l'ente", "Soppresse", "Parziali", "Km persi"]),
      ...r.perCausale.map((c) => riga([c.causale, c.descrizione, c.gruppo, c.imputabile == null ? "—" : c.imputabile ? "sì" : "no", c.codiceEnte ?? "", c.soppresse, c.parziali, c.kmPersi]))],
    larghezze: [22, 30, 12, 12, 14, 10, 10, 10], blocca: { righe: 1, colonne: 1 },
  };
  const comuni: Foglio = {
    nome: "Per comune",
    righe: r.perComune.length
      ? [intestazione(["Comune", "ISTAT", "Km programmati", "Km effettivi", "Regolarità km %"]),
        ...r.perComune.map((c) => riga([c.comune, c.istat ?? "", c.kmProgrammati, c.kmEffettivi, c.regolaritaKm]))]
      : [[{ v: r.notaComuni ?? "Nessun dato", s: nota }]],
    larghezze: [30, 10, 14, 14, 14], blocca: { righe: 1, colonne: 1 },
  };
  return scriviXlsx([
    riepilogo,
    tabella("Per linea", [["linea", "Linea"]], r.perLinea),
    tabella("Per servizio", [["servizio", "Tipo di servizio"]], r.perServizio),
    tabella("Per contratto", [["contratto", "Contratto"]], r.perContratto),
    comuni,
    causali,
    tabella("Per giorno", [["giorno", "Giorno"]], r.perGiorno),
    tabella("Per vettore", [["vettore", "Vettore"]], r.perVettore),
  ], st);
}

const INTESTAZIONE_CSV = [
  "giorno", "linea", "numero", "codice", "partenza", "arrivo", "da", "a", "origine", "tipo_aggiunta", "esito", "causale",
  "imputabile", "km_programmati", "km_effettivi", "vettura", "vettore", "turno_macchina", "turno_guida", "deposito",
  "proposta_avm", "ritardo_partenza_min", "nota",
];
const csv = (v: unknown) => {
  if (v == null) return "";
  const s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Il dettaglio corsa per corsa in CSV (separatore «;», virgola decimale, per
 * Excel in italiano), una giornata chiusa alla volta: `scrivi` riceve i pezzi.
 */
export async function dettaglioCsv(mese: string, scrivi: (pezzo: string) => void): Promise<number> {
  scrivi("﻿" + INTESTAZIONE_CSV.join(";") + "\r\n");
  const chiuse = righe(await db.execute(sql`
    SELECT giorno::text AS g FROM esercizio_giornate
     WHERE stato = 'chiusa' AND giorno >= ${`${mese}-01`}::date AND giorno < ${`${mese}-01`}::date + interval '1 month' ORDER BY giorno`));
  let totale = 0;
  for (const { g } of chiuse) {
    const rr = righe(await db.execute(sql`
      SELECT c.giorno::text AS giorno, c.linea, c.numero, c.codice, c.partenza, c.arrivo, c.fermata_da, c.fermata_a, c.origine, c.tipo_aggiunta,
             c.esito, c.causale, k.imputabile_azienda, c.km_prog::float AS km_prog, c.km_eff::float AS km_eff, c.vettura,
             c.turno_macchina, c.turno_guida, c.deposito, c.proposta, c.prove->>'ritardoPartenza' AS ritardo, c.nota
        FROM esercizio_corse c LEFT JOIN esercizio_causali k ON k.codice = c.causale
       WHERE c.giorno = ${g}::date ORDER BY c.partenza NULLS LAST, c.linea, c.numero`));
    let pezzo = "";
    for (const c of rr) {
      const rit = c.ritardo != null && /^-?\d+$/.test(String(c.ritardo)) ? Math.round(Number(c.ritardo) / 6) / 10 : null;
      pezzo += [
        String(c.giorno).slice(0, 10), c.linea, c.numero, c.codice, c.partenza, c.arrivo, c.fermata_da, c.fermata_a, c.origine, c.tipo_aggiunta,
        c.esito, c.causale, c.imputabile_azienda == null ? "" : c.imputabile_azienda ? "si" : "no",
        c.km_prog, c.km_eff, c.vettura, c.vettura ? aziendaDaSiri(String(c.vettura)) ?? "" : "", c.turno_macchina, c.turno_guida, c.deposito,
        c.proposta, rit, c.nota,
      ].map(csv).join(";") + "\r\n";
    }
    totale += rr.length;
    scrivi(pezzo);
  }
  return totale;
}
