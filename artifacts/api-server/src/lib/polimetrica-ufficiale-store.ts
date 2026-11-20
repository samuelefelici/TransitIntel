/**
 * La polimetrica della bigliettazione nel database (tappa 6.34, migrazione
 * 0055): caricarla, leggerne le linee, e tenere gli abbinamenti con le linee
 * dell'azienda. Le regole stanno in lib/polimetrica-ufficiale.ts.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { LineaAzienda, PuntoDaRitrovare, PuntoUfficiale, RigaUfficiale } from "./polimetrica-ufficiale";

/** Quando è stata caricata l'ultima volta, da chi e da quali file. */
export interface Caricamento {
  caricataIl: string; caricataDa: string | null;
  filePunti: string | null; fileRighe: string | null;
  punti: number; righe: number;
}

export async function caricamento(): Promise<Caricamento | null> {
  const r = await db.execute<any>(sql`
    SELECT c.caricata_il, coalesce(nullif(btrim(u.full_name), ''), u.email) AS caricata_da, c.file_punti, c.file_righe, c.punti, c.righe
      FROM polim_ufficiale_caricamento c LEFT JOIN users u ON u.id = c.caricata_da`);
  const x = r.rows?.[0];
  if (!x) return null;
  return {
    caricataIl: new Date(x.caricata_il).toISOString(), caricataDa: x.caricata_da ?? null,
    filePunti: x.file_punti ?? null, fileRighe: x.file_righe ?? null, punti: Number(x.punti), righe: Number(x.righe),
  };
}

/** Il nome di un file come si salva: senza cartelle né caratteri di controllo, al più 200 caratteri. */
const nomeFile = (v: string | null | undefined): string | null => {
  const t = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop()!.trim().slice(0, 200);
  return t || null;
};

const A_PEZZI = 1000;

/**
 * Sostituisce la polimetrica della bigliettazione con quella dei due file:
 * o tutta o niente. Gli abbinamenti delle linee restano.
 */
export async function caricaUfficiale(
  punti: readonly PuntoUfficiale[], righe: readonly RigaUfficiale[],
  da: { filePunti?: string | null; fileRighe?: string | null; utenteId: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM polim_ufficiale_punti`);
    await tx.execute(sql`DELETE FROM polim_ufficiale_righe`);
    for (let i = 0; i < punti.length; i += A_PEZZI) {
      await tx.execute(sql`
        INSERT INTO polim_ufficiale_punti (linea, percorso, direzione, ordine, codice, nome, nodo, km)
        VALUES ${sql.join(punti.slice(i, i + A_PEZZI).map((p) => sql`(${p.linea}, ${p.percorso}, ${p.direzione}, ${p.ordine}, ${p.codice}, ${p.nome}, ${p.nodo}, ${p.km})`), sql`, `)}`);
    }
    for (let i = 0; i < righe.length; i += A_PEZZI) {
      await tx.execute(sql`
        INSERT INTO polim_ufficiale_righe (linea, percorso, direzione, da, a, km, tariffario, fascia, forzata)
        VALUES ${sql.join(righe.slice(i, i + A_PEZZI).map((r) => sql`(${r.linea}, ${r.percorso}, ${r.direzione}, ${r.da}, ${r.a}, ${r.km}, ${r.tariffario}, ${r.fascia}, ${r.forzata})`), sql`, `)}`);
    }
    await tx.execute(sql`
      INSERT INTO polim_ufficiale_caricamento (unica, caricata_il, caricata_da, file_punti, file_righe, punti, righe)
      VALUES (true, now(), ${da.utenteId}::uuid, ${nomeFile(da.filePunti)}, ${nomeFile(da.fileRighe)}, ${punti.length}, ${righe.length})
      ON CONFLICT (unica) DO UPDATE SET
        caricata_il = EXCLUDED.caricata_il, caricata_da = EXCLUDED.caricata_da,
        file_punti = EXCLUDED.file_punti, file_righe = EXCLUDED.file_righe, punti = EXCLUDED.punti, righe = EXCLUDED.righe`);
  });
}

/** Toglie la polimetrica della bigliettazione. Gli abbinamenti restano: servono al prossimo caricamento. */
export async function eliminaUfficiale(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM polim_ufficiale_punti`);
    await tx.execute(sql`DELETE FROM polim_ufficiale_righe`);
    await tx.execute(sql`DELETE FROM polim_ufficiale_caricamento`);
  });
}

/** Una linea della bigliettazione, in breve, con la sua decisione. */
export interface LineaUfficiale {
  linea: string;
  /** percorsi e direzioni con i loro punti */
  percorsi: number;
  /** punti tariffari distinti */
  punti: number;
  /** il primo e l'ultimo punto del primo percorso */
  da: string | null; a: string | null;
  righe: number; forzate: number; tariffari: string[];
  /** la linea dell'azienda a cui è abbinata; null se non lo è */
  abbinata: string | null;
  /** esclusa dal confronto */
  esclusa: boolean;
}

/** Le linee della bigliettazione: quelle che hanno punti, righe o tutti e due. */
export async function lineeUfficiali(): Promise<LineaUfficiale[]> {
  const r = await db.execute<any>(sql`
    WITH p AS (
      SELECT linea, count(DISTINCT (percorso, direzione))::int AS percorsi, count(DISTINCT codice)::int AS punti
        FROM polim_ufficiale_punti GROUP BY linea
    ), capi AS (
      SELECT DISTINCT ON (linea) linea,
             first_value(coalesce(nome, codice)) OVER w AS da, last_value(coalesce(nome, codice)) OVER w AS a
        FROM polim_ufficiale_punti
      WINDOW w AS (PARTITION BY linea, percorso, direzione ORDER BY ordine ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
       ORDER BY linea, percorso, direzione
    ), r AS (
      SELECT linea, count(*)::int AS righe, (count(*) FILTER (WHERE forzata))::int AS forzate,
             coalesce(array_agg(DISTINCT tariffario ORDER BY tariffario) FILTER (WHERE tariffario IS NOT NULL), '{}') AS tariffari
        FROM polim_ufficiale_righe GROUP BY linea
    )
    SELECT l.linea, coalesce(p.percorsi, 0) AS percorsi, coalesce(p.punti, 0) AS punti, capi.da, capi.a,
           coalesce(r.righe, 0) AS righe, coalesce(r.forzate, 0) AS forzate, coalesce(r.tariffari, '{}') AS tariffari,
           ab.linea AS abbinata, coalesce(ab.esclusa, false) AS esclusa
      FROM (SELECT linea FROM p UNION SELECT linea FROM r) l
      LEFT JOIN p USING (linea) LEFT JOIN capi USING (linea) LEFT JOIN r USING (linea)
      LEFT JOIN polim_abbinamenti_linee ab ON ab.linea_ufficiale = l.linea
     ORDER BY l.linea`);
  return (r.rows ?? []).map((x: any) => ({
    linea: String(x.linea), percorsi: Number(x.percorsi), punti: Number(x.punti), da: x.da ?? null, a: x.a ?? null,
    righe: Number(x.righe), forzate: Number(x.forzate), tariffari: (x.tariffari ?? []) as string[],
    abbinata: x.abbinata ?? null, esclusa: x.esclusa === true,
  }));
}

/** I punti distinti di ogni linea della bigliettazione, per ritrovarli fra le fermate dell'azienda. */
export async function puntiPerLinea(): Promise<Map<string, PuntoDaRitrovare[]>> {
  const r = await db.execute<any>(sql`SELECT DISTINCT linea, codice, nome FROM polim_ufficiale_punti`);
  const per = new Map<string, PuntoDaRitrovare[]>();
  for (const x of r.rows ?? []) {
    const linea = String(x.linea);
    if (!per.has(linea)) per.set(linea, []);
    per.get(linea)!.push({ codice: String(x.codice), nome: x.nome ?? null });
  }
  return per;
}

/**
 * Le linee di un import della pagina Polimetriche con le loro fermate
 * (codice e nome), senza portare in memoria i percorsi interi. `null` se
 * l'import non c'è.
 */
export async function lineeDellImport(importId: string): Promise<LineaAzienda[] | null> {
  const c = await db.execute<any>(sql`SELECT 1 FROM polim_imports WHERE id = ${importId}::uuid`);
  if (!c.rows?.length) return null;
  const r = await db.execute<any>(sql`
    SELECT DISTINCT l.value->>'lineCode' AS codice, l.value->>'lineName' AS nome, s.value->>'stopId' AS fermata, s.value->>'stopName' AS fermata_nome
      FROM polim_imports i
      CROSS JOIN LATERAL jsonb_array_elements(i.payload->'lines') l
      CROSS JOIN LATERAL jsonb_array_elements(l.value->'percorsi') p
      CROSS JOIN LATERAL jsonb_array_elements(p.value->'stops') s
     WHERE i.id = ${importId}::uuid`);
  const per = new Map<string, { codice: string; nome: string; fermate: { codice: string; nome: string }[] }>();
  for (const x of r.rows ?? []) {
    const codice = String(x.codice ?? "");
    if (!codice) continue;
    if (!per.has(codice)) per.set(codice, { codice, nome: String(x.nome ?? ""), fermate: [] });
    if (x.fermata) per.get(codice)!.fermate.push({ codice: String(x.fermata), nome: String(x.fermata_nome ?? "") });
  }
  return [...per.values()].sort((a, b) => a.codice.localeCompare(b.codice, "it", { numeric: true }));
}

/** Una decisione su una linea della bigliettazione: abbinata a una linea, esclusa, o di nuovo da abbinare. */
export interface Decisione { lineaUfficiale: string; linea: string | null; esclusa: boolean }

/**
 * Salva le decisioni, tutte insieme. Una linea senza linea e non esclusa
 * torna «da abbinare» (la riga si toglie). Tocca solo le righe che cambiano:
 * nel registro resta quello che è cambiato davvero.
 */
export async function salvaAbbinamenti(decisioni: readonly Decisione[], utenteId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    for (const d of decisioni) {
      const ufficiale = d.lineaUfficiale.toUpperCase();
      if (!d.esclusa && d.linea == null) {
        await tx.execute(sql`DELETE FROM polim_abbinamenti_linee WHERE linea_ufficiale = ${ufficiale}`);
        continue;
      }
      const linea = d.esclusa ? null : d.linea;
      await tx.execute(sql`
        INSERT INTO polim_abbinamenti_linee (linea_ufficiale, linea, esclusa, deciso_il, deciso_da)
        VALUES (${ufficiale}, ${linea}, ${d.esclusa}, now(), ${utenteId}::uuid)
        ON CONFLICT (linea_ufficiale) DO UPDATE SET
          linea = EXCLUDED.linea, esclusa = EXCLUDED.esclusa, deciso_il = EXCLUDED.deciso_il, deciso_da = EXCLUDED.deciso_da
         WHERE polim_abbinamenti_linee.linea IS DISTINCT FROM EXCLUDED.linea OR polim_abbinamenti_linee.esclusa IS DISTINCT FROM EXCLUDED.esclusa`);
    }
  });
}

/* ── I punti tariffari sulle fermate (tappa 6.34b, migrazione 0056) ───────── */

/** Un percorso di una linea della bigliettazione, coi suoi punti nell'ordine. */
export interface PercorsoUfficiale { percorso: string; direzione: string; punti: PuntoUfficiale[] }

/** I percorsi di una linea della bigliettazione e le sue righe. Vuoti se la linea non è fra le caricate. */
export async function dettaglioLinea(linea: string): Promise<{ percorsi: PercorsoUfficiale[]; righe: RigaUfficiale[] }> {
  const [p, r] = await Promise.all([
    db.execute<any>(sql`
      SELECT percorso, direzione, ordine, codice, nome, nodo, km::float8 AS km
        FROM polim_ufficiale_punti WHERE linea = ${linea} ORDER BY percorso, direzione, ordine`),
    db.execute<any>(sql`
      SELECT percorso, direzione, da, a, km::float8 AS km, tariffario, fascia, forzata
        FROM polim_ufficiale_righe WHERE linea = ${linea} ORDER BY percorso, direzione, da, a`),
  ]);
  const percorsi: PercorsoUfficiale[] = [];
  for (const x of p.rows ?? []) {
    let ultimo = percorsi[percorsi.length - 1];
    if (!ultimo || ultimo.percorso !== x.percorso || ultimo.direzione !== x.direzione) {
      ultimo = { percorso: String(x.percorso), direzione: String(x.direzione), punti: [] };
      percorsi.push(ultimo);
    }
    ultimo.punti.push({ linea, percorso: ultimo.percorso, direzione: ultimo.direzione, ordine: Number(x.ordine), codice: String(x.codice), nome: x.nome ?? null, nodo: x.nodo ?? null, km: Number(x.km) });
  }
  const righe: RigaUfficiale[] = (r.rows ?? []).map((x: any) => ({
    linea, percorso: String(x.percorso), direzione: String(x.direzione), da: String(x.da), a: String(x.a),
    km: x.km == null ? null : Number(x.km), tariffario: x.tariffario ?? null, fascia: x.fascia == null ? null : Number(x.fascia), forzata: x.forzata === true,
  }));
  return { percorsi, righe };
}

/** La linea dell'azienda a cui è abbinata una linea della bigliettazione; null se non lo è (o è esclusa). */
export async function lineaAbbinata(lineaUfficiale: string): Promise<string | null> {
  const r = await db.execute<any>(sql`SELECT linea FROM polim_abbinamenti_linee WHERE linea_ufficiale = ${lineaUfficiale}`);
  return r.rows?.[0]?.linea ?? null;
}

/** Un percorso di una linea dell'import, con quello che serve per sceglierlo e le fermate nell'ordine. */
export interface PercorsoDellImport {
  routeId: string; variantId: string; direzione: number | null;
  da: string; a: string; corse: number; km: number;
  fermate: { stopId: string; nome: string; km: number }[];
}

/**
 * I percorsi di una linea di un import della pagina Polimetriche, senza le
 * geometrie. `null` se l'import non c'è; vuoto se la linea non è nell'import.
 */
export async function percorsiDellaLinea(importId: string, linea: string): Promise<PercorsoDellImport[] | null> {
  const c = await db.execute<any>(sql`SELECT 1 FROM polim_imports WHERE id = ${importId}::uuid`);
  if (!c.rows?.length) return null;
  const r = await db.execute<any>(sql`
    SELECT p.value - 'shape' AS percorso
      FROM polim_imports i
      CROSS JOIN LATERAL jsonb_array_elements(i.payload->'lines') l
      CROSS JOIN LATERAL jsonb_array_elements(l.value->'percorsi') p
     WHERE i.id = ${importId}::uuid AND l.value->>'lineCode' = ${linea}`);
  return (r.rows ?? []).map((x: any) => percorsoDalPayload(x.percorso));
}

/** Un percorso com'è nel payload di un import (senza la geometria), come lo usa il confronto. */
function percorsoDalPayload(grezzo: any): PercorsoDellImport {
  const p = grezzo ?? {};
  const fermate = (Array.isArray(p.stops) ? p.stops : []).map((s: any) => ({ stopId: String(s.stopId ?? ""), nome: String(s.stopName ?? ""), km: Number(s.km) || 0 }));
  return {
    routeId: String(p.routeId ?? ""), variantId: String(p.variantId ?? ""), direzione: p.directionId == null ? null : Number(p.directionId),
    da: String(p.firstStopName ?? fermate[0]?.nome ?? ""), a: String(p.lastStopName ?? fermate[fermate.length - 1]?.nome ?? ""),
    corse: Number(p.tripCount) || 0, km: Number(p.totalKm) || 0, fermate,
  };
}

/**
 * Tutti i percorsi di un import, per linea, senza le geometrie: una lettura
 * sola, per il riepilogo di tutte le linee. `null` se l'import non c'è.
 */
export async function percorsiDellImport(importId: string): Promise<Map<string, PercorsoDellImport[]> | null> {
  const c = await db.execute<any>(sql`SELECT 1 FROM polim_imports WHERE id = ${importId}::uuid`);
  if (!c.rows?.length) return null;
  const r = await db.execute<any>(sql`
    SELECT l.value->>'lineCode' AS linea, p.value - 'shape' AS percorso
      FROM polim_imports i
      CROSS JOIN LATERAL jsonb_array_elements(i.payload->'lines') l
      CROSS JOIN LATERAL jsonb_array_elements(l.value->'percorsi') p
     WHERE i.id = ${importId}::uuid`);
  const per = new Map<string, PercorsoDellImport[]>();
  for (const x of r.rows ?? []) {
    const linea = String(x.linea ?? "");
    if (!per.has(linea)) per.set(linea, []);
    per.get(linea)!.push(percorsoDalPayload(x.percorso));
  }
  return per;
}

/** La decisione su un percorso della bigliettazione: il percorso dell'azienda, il verso e la fermata di ogni punto. */
export interface DecisionePunti {
  percorso: string; direzione: string;
  routeId: string; variantId: string; verso: "AB" | "BA";
  /**
   * le fermate del percorso dell'azienda scelto, per codice e in ordine
   * (tappa 6.36): la decisione vale su ogni fotografia dove la linea ha un
   * percorso con queste fermate, anche se gli identificativi sono cambiati
   */
  fermate: string[] | null;
  punti: { ordine: number; fermata: string | null }[];
}

/** Le decisioni salvate per i percorsi di una linea della bigliettazione. */
export async function decisioniDeiPunti(lineaUfficiale: string): Promise<DecisionePunti[]> {
  const [p, q] = await Promise.all([
    db.execute<any>(sql`
      SELECT percorso, direzione, route_id, variant_id, verso, fermate FROM polim_abbinamenti_percorsi
       WHERE linea_ufficiale = ${lineaUfficiale} ORDER BY percorso, direzione`),
    db.execute<any>(sql`
      SELECT percorso, direzione, ordine, fermata FROM polim_abbinamenti_punti
       WHERE linea_ufficiale = ${lineaUfficiale} ORDER BY percorso, direzione, ordine`),
  ]);
  return (p.rows ?? []).map((x: any) => ({
    percorso: String(x.percorso), direzione: String(x.direzione), routeId: String(x.route_id), variantId: String(x.variant_id), verso: x.verso === "BA" ? "BA" : "AB",
    fermate: Array.isArray(x.fermate) ? x.fermate.map(String) : null,
    punti: (q.rows ?? []).filter((y: any) => y.percorso === x.percorso && y.direzione === x.direzione).map((y: any) => ({ ordine: Number(y.ordine), fermata: y.fermata ?? null })),
  }));
}

/** Salva la decisione su un percorso della bigliettazione, al posto di quella di prima. */
export async function salvaDecisionePunti(lineaUfficiale: string, d: DecisionePunti, utenteId: string | null): Promise<void> {
  /* le fermate in JSON: diventano un text[] nel database, nell'ordine (vuote: NULL) */
  const fermate = d.fermate?.length ? JSON.stringify(d.fermate) : null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO polim_abbinamenti_percorsi (linea_ufficiale, percorso, direzione, route_id, variant_id, verso, fermate, deciso_il, deciso_da)
      VALUES (${lineaUfficiale}, ${d.percorso}, ${d.direzione}, ${d.routeId}, ${d.variantId}, ${d.verso},
              (SELECT array_agg(f ORDER BY n) FROM jsonb_array_elements_text(${fermate}::jsonb) WITH ORDINALITY AS t(f, n)),
              now(), ${utenteId}::uuid)
      ON CONFLICT (linea_ufficiale, percorso, direzione) DO UPDATE SET
        route_id = EXCLUDED.route_id, variant_id = EXCLUDED.variant_id, verso = EXCLUDED.verso, fermate = EXCLUDED.fermate,
        deciso_il = EXCLUDED.deciso_il, deciso_da = EXCLUDED.deciso_da`);
    await tx.execute(sql`
      DELETE FROM polim_abbinamenti_punti
       WHERE linea_ufficiale = ${lineaUfficiale} AND percorso = ${d.percorso} AND direzione = ${d.direzione}`);
    if (d.punti.length) {
      await tx.execute(sql`
        INSERT INTO polim_abbinamenti_punti (linea_ufficiale, percorso, direzione, ordine, fermata)
        VALUES ${sql.join(d.punti.map((p) => sql`(${lineaUfficiale}, ${d.percorso}, ${d.direzione}, ${p.ordine}, ${p.fermata})`), sql`, `)}`);
    }
  });
}

/** Toglie la decisione su un percorso della bigliettazione: torna la proposta. */
export async function togliDecisionePunti(lineaUfficiale: string, percorso: string, direzione: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM polim_abbinamenti_percorsi
     WHERE linea_ufficiale = ${lineaUfficiale} AND percorso = ${percorso} AND direzione = ${direzione}`);
}

/* ── Il riepilogo di tutte le linee abbinate (tappa 6.34c) ────────────────── */

/** Una linea della bigliettazione abbinata, con tutto quello che serve a confrontarla. */
export interface LineaDaConfrontare {
  linea: string;
  /** la linea dell'azienda a cui è abbinata */
  abbinata: string;
  percorsi: PercorsoUfficiale[];
  righe: RigaUfficiale[];
  decise: DecisionePunti[];
}

/**
 * Le linee della bigliettazione abbinate a una linea dell'azienda, coi loro
 * punti, le loro righe e le decisioni salvate: cinque letture in tutto,
 * quante che siano le linee.
 */
export async function lineeDaConfrontare(): Promise<LineaDaConfrontare[]> {
  const [l, p, r, dp, dq] = await Promise.all([
    db.execute<any>(sql`SELECT linea_ufficiale, linea FROM polim_abbinamenti_linee WHERE linea IS NOT NULL ORDER BY linea_ufficiale`),
    db.execute<any>(sql`
      SELECT x.linea, x.percorso, x.direzione, x.ordine, x.codice, x.nome, x.nodo, x.km::float8 AS km
        FROM polim_ufficiale_punti x JOIN polim_abbinamenti_linee a ON a.linea_ufficiale = x.linea AND a.linea IS NOT NULL
       ORDER BY x.linea, x.percorso, x.direzione, x.ordine`),
    db.execute<any>(sql`
      SELECT x.linea, x.percorso, x.direzione, x.da, x.a, x.km::float8 AS km, x.tariffario, x.fascia, x.forzata
        FROM polim_ufficiale_righe x JOIN polim_abbinamenti_linee a ON a.linea_ufficiale = x.linea AND a.linea IS NOT NULL
       ORDER BY x.linea, x.percorso, x.direzione, x.da, x.a`),
    db.execute<any>(sql`SELECT linea_ufficiale, percorso, direzione, route_id, variant_id, verso, fermate FROM polim_abbinamenti_percorsi ORDER BY linea_ufficiale, percorso, direzione`),
    db.execute<any>(sql`SELECT linea_ufficiale, percorso, direzione, ordine, fermata FROM polim_abbinamenti_punti ORDER BY linea_ufficiale, percorso, direzione, ordine`),
  ]);
  const per = new Map<string, LineaDaConfrontare>();
  for (const x of l.rows ?? []) per.set(String(x.linea_ufficiale), { linea: String(x.linea_ufficiale), abbinata: String(x.linea), percorsi: [], righe: [], decise: [] });
  for (const x of p.rows ?? []) {
    const linea = per.get(String(x.linea));
    if (!linea) continue;
    let ultimo = linea.percorsi[linea.percorsi.length - 1];
    if (!ultimo || ultimo.percorso !== x.percorso || ultimo.direzione !== x.direzione) {
      ultimo = { percorso: String(x.percorso), direzione: String(x.direzione), punti: [] };
      linea.percorsi.push(ultimo);
    }
    ultimo.punti.push({ linea: linea.linea, percorso: ultimo.percorso, direzione: ultimo.direzione, ordine: Number(x.ordine), codice: String(x.codice), nome: x.nome ?? null, nodo: x.nodo ?? null, km: Number(x.km) });
  }
  for (const x of r.rows ?? []) {
    per.get(String(x.linea))?.righe.push({
      linea: String(x.linea), percorso: String(x.percorso), direzione: String(x.direzione), da: String(x.da), a: String(x.a),
      km: x.km == null ? null : Number(x.km), tariffario: x.tariffario ?? null, fascia: x.fascia == null ? null : Number(x.fascia), forzata: x.forzata === true,
    });
  }
  const punti = new Map<string, { ordine: number; fermata: string | null }[]>();
  for (const x of dq.rows ?? []) {
    const k = `${x.linea_ufficiale}\u0000${x.percorso}\u0000${x.direzione}`;
    if (!punti.has(k)) punti.set(k, []);
    punti.get(k)!.push({ ordine: Number(x.ordine), fermata: x.fermata ?? null });
  }
  for (const x of dp.rows ?? []) {
    per.get(String(x.linea_ufficiale))?.decise.push({
      percorso: String(x.percorso), direzione: String(x.direzione), routeId: String(x.route_id), variantId: String(x.variant_id), verso: x.verso === "BA" ? "BA" : "AB",
      fermate: Array.isArray(x.fermate) ? x.fermate.map(String) : null,
      punti: punti.get(`${x.linea_ufficiale}\u0000${x.percorso}\u0000${x.direzione}`) ?? [],
    });
  }
  /* le linee abbinate che nella polimetrica caricata non ci sono più restano fuori */
  return [...per.values()].filter((x) => x.percorsi.length > 0 || x.righe.length > 0);
}
