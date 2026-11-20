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
