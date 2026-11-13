/**
 * Copia e cancellazione di un progetto di Planning Studio, per chi ne ha
 * bisogno fuori dalle rotte: la duplicazione chiesta dall'utente
 * (POST /planning-studio/projects/:id/duplicate), la versione pubblicata di un
 * programma che va in esercizio (lib/versioni-pubblicate.ts, PR 3.3), la
 * cancellazione di un progetto o di una versione che non serve più.
 */
import { sql } from "drizzle-orm";

type Esecutore = { execute: <T = any>(q: any) => Promise<any> };

/* POST /api/planning-studio/projects/:id/duplicate — copia profonda del progetto.
 *
 * Duplica un intero programma di esercizio in un progetto nuovo: fermate,
 * cluster, linee, percorsi, orari, calendari, corse, transiti, validità
 * (giorni + categorie), eccezioni, no-go, periodi, profilo calendario
 * aziendale, classificazione giorni (ps_day_calendar) e calendario categorie
 * per-progetto (ps_validity_category_calendar). NON copia il feed
 * materializzato (la copia nasce non operativa) né le UDP/scenari (artefatti
 * generati). Copia GENERICA e set-based: mappe id vecchio→nuovo + lista
 * colonne da information_schema (così prende anche le colonne aggiunte da una
 * migrazione). I codici stabili (PR 3.1) restano gli stessi.
 *
 * Le mappe NON sono tabelle temporanee (PR 2.16b: l'app non esegue DDL, nemmeno
 * `CREATE TEMP TABLE`). L'id nuovo di una riga si DERIVA da progetto nuovo + id
 * vecchio (idDellaCopia): ogni istruzione può quindi ricalcolare la stessa
 * mappa, come CTE MATERIALIZED — calcolata una volta per istruzione e poi usata
 * nelle join, come prima la tabella temporanea. Per lo stesso motivo da un id
 * del progetto si ricava l'id della stessa riga nella copia (lo usano i link
 * pubblici, PR 3.3).
 *
 * `versioneDelFeed`: la copia è la versione pubblicata di quel feed (PR 3.3):
 * senza proprietario (nessuno la vede fra i suoi progetti né la modifica),
 * con versione_di = il progetto copiato. */
export async function copiaProgetto(
  tx: Esecutore, src: string,
  o: { nome: string; proprietario: string | null; versioneDelFeed?: string | null },
): Promise<string> {
    // 1) progetto nuovo = riga sorgente clonata (id nuovo, owner utente,
    //    nome scelto, NON materializzato/operativo, non condiviso)
    const pr = await tx.execute<any>(sql`
      INSERT INTO ps_projects
        (owner_user_id, name, description, agency_name, agency_url, agency_timezone,
         default_lang, agency_settings, status, is_shared, versione_di, versione_del_feed)
      SELECT ${o.proprietario}::uuid, ${o.nome}, description, agency_name, agency_url, agency_timezone,
             default_lang, agency_settings, ${o.versioneDelFeed ? "versione" : "draft"}, false,
             ${o.versioneDelFeed ? src : null}::uuid, ${o.versioneDelFeed ?? null}::uuid
        FROM ps_projects WHERE id = ${src}::uuid
      RETURNING id`);
    if (!pr.rows?.length) throw new Error("progetto da copiare non trovato");
    const dst: string = pr.rows[0].id;

    // helper: definisce la mappa id vecchio→nuovo per una tabella (con scope)
    const mappe = new Map<string, any>();
    const mkMap = (nome: string, table: string, scope: any) => {
      mappe.set(nome, sql`${sql.raw(nome)} AS MATERIALIZED (
        SELECT s.id AS old_id, ${idDellaCopia(dst, "s.id")} AS new_id FROM ${sql.raw(table)} s WHERE ${scope})`);
    };
    // helper: il `WITH …` da mettere davanti all'istruzione che usa quelle mappe
    const con = (...nomi: Array<string | undefined>) => {
      const usate = [...new Set(nomi.filter((n): n is string => !!n))];
      if (!usate.length) return sql``;
      return sql`WITH ${sql.join(usate.map((n) => {
        const m = mappe.get(n);
        if (!m) throw new Error(`mappa ${n} non definita`);
        return m;
      }), sql`, `)} `;
    };
    // helper generico: copia una tabella rimappando id/project_id/FK.
    // idCol=null per tabelle senza id proprio (child con solo FK).
    const copy = async (table: string, opts: {
      idMap?: string;                    // mappa per l'id proprio
      genId?: boolean;                   // id proprio non referenziato → uuid nuovo
      projectCol?: string | null;        // colonna project_id da riscrivere (default 'project_id')
      fks?: Array<{ col: string; map: string }>;
      scope: any;                        // WHERE per selezionare le righe sorgente
    }) => {
      const projectCol = opts.projectCol === undefined ? "project_id" : opts.projectCol;
      const colsR = await tx.execute<any>(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`);
      const cols: string[] = colsR.rows.map((r: any) => r.column_name);
      const fkByCol = new Map((opts.fks ?? []).map(f => [f.col, f.map]));
      const exprs = cols.map((c) => {
        if (opts.idMap && c === "id") return `ms.new_id`;
        if (opts.genId && c === "id") return `gen_random_uuid()`;
        if (projectCol && c === projectCol) return `'${dst}'::uuid`;
        if (fkByCol.has(c)) return `f_${c}.new_id`;
        return `s.${c}`;
      });
      const joins: string[] = [];
      if (opts.idMap) joins.push(`JOIN ${opts.idMap} ms ON ms.old_id = s.id`);
      for (const f of opts.fks ?? []) joins.push(`LEFT JOIN ${f.map} f_${f.col} ON f_${f.col}.old_id = s.${f.col}`);
      await tx.execute(sql`
        ${con(opts.idMap, ...(opts.fks ?? []).map((f) => f.map))}INSERT INTO ${sql.raw(table)} (${sql.raw(cols.join(", "))})
        SELECT ${sql.raw(exprs.join(", "))}
          FROM ${sql.raw(table)} s ${sql.raw(joins.join(" "))}
         WHERE ${opts.scope}`);
    };

    const byProj = sql`s.project_id = ${src}::uuid`;
    const tripScope = sql`s.trip_id IN (SELECT id FROM ps_trips WHERE project_id = ${src}::uuid)`;

    // 2) mappe id per le entità con id proprio (scope = progetto sorgente)
    mkMap("m_clu", "ps_stop_clusters", sql`s.project_id = ${src}::uuid`);
    mkMap("m_stp", "ps_stops", sql`s.project_id = ${src}::uuid`);
    mkMap("m_rte", "ps_routes", sql`s.project_id = ${src}::uuid`);
    mkMap("m_var", "ps_route_variants", sql`s.project_id = ${src}::uuid`);
    mkMap("m_cal", "ps_calendars", sql`s.project_id = ${src}::uuid`);
    mkMap("m_trp", "ps_trips", sql`s.project_id = ${src}::uuid`);
    // day-type CUSTOM del progetto (i globali restano condivisi, non si copiano)
    mkMap("m_dt", "ps_day_types", sql`s.project_id = ${src}::uuid`);

    // 3) copia in ordine di dipendenza
    await copy("ps_stop_clusters", { idMap: "m_clu", scope: byProj });
    await copy("ps_stops", { idMap: "m_stp", fks: [{ col: "cluster_id", map: "m_clu" }, { col: "parent_station", map: "m_stp" }], scope: byProj });
    await copy("ps_routes", { idMap: "m_rte", scope: byProj });
    await copy("ps_route_variants", { idMap: "m_var", fks: [{ col: "route_id", map: "m_rte" }], scope: byProj });
    await copy("ps_variant_stops", { projectCol: null, fks: [{ col: "variant_id", map: "m_var" }, { col: "stop_id", map: "m_stp" }], scope: sql`s.variant_id IN (SELECT id FROM ps_route_variants WHERE project_id = ${src}::uuid)` });
    await copy("ps_shapes", { genId: true /* shapes.id non è referenziato */, fks: [{ col: "variant_id", map: "m_var" }], scope: byProj });
    await copy("ps_calendars", { idMap: "m_cal", scope: byProj });
    await copy("ps_calendar_dates", { projectCol: null, fks: [{ col: "calendar_id", map: "m_cal" }], scope: sql`s.calendar_id IN (SELECT id FROM ps_calendars WHERE project_id = ${src}::uuid)` });
    await copy("ps_day_types", { idMap: "m_dt", scope: byProj });
    await copy("ps_trips", { idMap: "m_trp", fks: [{ col: "route_id", map: "m_rte" }, { col: "variant_id", map: "m_var" }, { col: "calendar_id", map: "m_cal" }], scope: byProj });
    await copy("ps_stop_times", { projectCol: null, fks: [{ col: "trip_id", map: "m_trp" }, { col: "stop_id", map: "m_stp" }], scope: tripScope });
    // validità giorni: trip rimappato; day_type rimappato se custom, altrimenti globale (LEFT JOIN → resta l'originale se non in mappa)
    await copyDayValidity(tx, src, con("m_trp", "m_dt"));
    await copy("ps_trip_category_validity", { projectCol: null, fks: [{ col: "trip_id", map: "m_trp" }], scope: tripScope });
    await copy("ps_trip_exceptions", { projectCol: null, fks: [{ col: "trip_id", map: "m_trp" }], scope: tripScope });
    await copy("ps_no_go_zones", { genId: true, scope: byProj });
    await copy("ps_service_periods", { genId: true, scope: byProj });
    // profilo calendario aziendale (PK = project_id, niente id). Su uno
    // schema non ancora migrato la tabella può mancare: copiamo solo se
    // esiste, così la transazione non abortisce.
    const hasProfiles = await tx.execute<any>(sql`SELECT to_regclass('public.ps_calendar_profiles') AS t`);
    if (hasProfiles.rows[0]?.t) {
      await tx.execute(sql`
        INSERT INTO ps_calendar_profiles (project_id, closed_periods, summer_period, extra_holidays)
        SELECT ${dst}::uuid, closed_periods, summer_period, extra_holidays
          FROM ps_calendar_profiles WHERE project_id = ${src}::uuid`);
    }

    // CLASSIFICAZIONE GIORNI del progetto (stessa cautela dei profili):
    // senza queste due copie il clone perde i giorni classificati a mano e
    // il calendario categorie → le UDP del duplicato nascerebbero sbagliate.
    // ps_day_calendar: date→day-type per-progetto; day_type rimappato SOLO se
    // custom (i system restano condivisi, come in copyDayValidity).
    const hasDayCal = await tx.execute<any>(sql`SELECT to_regclass('public.ps_day_calendar') AS t`);
    if (hasDayCal.rows[0]?.t) {
      await tx.execute(sql`
        ${con("m_dt")}INSERT INTO ps_day_calendar (project_id, date, day_type_id, source, note)
        SELECT ${dst}::uuid, s.date, COALESCE(fd.new_id, s.day_type_id), s.source, s.note
          FROM ps_day_calendar s
          LEFT JOIN m_dt fd ON fd.old_id = s.day_type_id
         WHERE s.project_id = ${src}::uuid
        ON CONFLICT DO NOTHING`);
    }
    // ps_validity_category_calendar: date→categoria per-progetto (5B). Le
    // categorie sono un dizionario GLOBALE → nessuna rimappa. Su DB legacy la
    // colonna project_id può non esserci ancora → in quel caso non c'è nulla
    // di per-progetto da copiare.
    const hasVcc = await tx.execute<any>(sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='ps_validity_category_calendar'
         AND column_name='project_id'`);
    if (hasVcc.rows.length) {
      await tx.execute(sql`
        INSERT INTO ps_validity_category_calendar (project_id, date, category_id)
        SELECT ${dst}::uuid, s.date, s.category_id
          FROM ps_validity_category_calendar s
         WHERE s.project_id = ${src}::uuid
        ON CONFLICT DO NOTHING`);
    }


    return dst;
}

/**
 * L'id che una riga avrà nella copia di un progetto: derivato dal progetto
 * nuovo e dall'id vecchio (SHA-256, con i bit di versione e variante di un
 * UUID v4). Stesso ingresso, stesso id: le mappe della duplicazione non vanno
 * conservate da nessuna parte. Il progetto nuovo è un UUID casuale appena
 * generato dal database, quindi gli id derivati non si ripetono fra una copia
 * e l'altra; se mai coincidessero con una riga esistente, la chiave primaria
 * farebbe fallire la duplicazione intera.
 * `colonna` è un nome scritto nel codice, mai un valore dell'utente.
 */
export function idDellaCopia(progettoNuovo: string, colonna: string) {
  return sql`(overlay(overlay(substr(encode(sha256(convert_to(${progettoNuovo}::text || ':' || ${sql.raw(colonna)}::text, 'UTF8')), 'hex'), 1, 32) placing '4' from 13) placing '8' from 17))::uuid`;
}

/** ps_trip_day_validity: rimappa trip_id (sempre) e day_type_id SOLO se è un
 *  day-type custom del progetto (i globali restano condivisi).
 *  `mappe` è il `WITH m_trp …, m_dt …` della duplicazione. */
async function copyDayValidity(tx: Esecutore, src: string, mappe: any): Promise<void> {
  await tx.execute(sql`
    ${mappe}INSERT INTO ps_trip_day_validity (trip_id, day_type_id, is_valid)
    SELECT ft.new_id, COALESCE(fd.new_id, s.day_type_id), s.is_valid
      FROM ps_trip_day_validity s
      JOIN m_trp ft ON ft.old_id = s.trip_id
      LEFT JOIN m_dt fd ON fd.old_id = s.day_type_id
     WHERE s.trip_id IN (SELECT id FROM ps_trips WHERE project_id = ${src}::uuid)
    ON CONFLICT DO NOTHING`);
}


/**
 * Cancella un progetto con tutte le sue righe, in `tx`. La sola cascata da
 * ps_projects NON basta: tre FK sono ON DELETE RESTRICT (ps_variant_stops.stop_id,
 * ps_trips.variant_id, ps_stop_times.stop_id) e Postgres le verifica subito
 * durante la cascata. Cancellazione ORDINATA: prima chi blocca, poi il
 * progetto (che porta via il resto: linee, fermate, calendari, membri, log…).
 * Le righe con una chiave SET NULL verso il progetto restano (lo storico del
 * programma in esercizio, le versioni pubblicate).
 */
export async function cancellaProgetto(tx: Esecutore, id: string): Promise<void> {
    await tx.execute(sql`
      DELETE FROM ps_stop_times
       WHERE trip_id IN (SELECT id FROM ps_trips WHERE project_id = ${id}::uuid)
    `);
    await tx.execute(sql`DELETE FROM ps_trips WHERE project_id = ${id}::uuid`);
    await tx.execute(sql`
      DELETE FROM ps_variant_stops
       WHERE variant_id IN (SELECT id FROM ps_route_variants WHERE project_id = ${id}::uuid)
    `);
    await tx.execute(sql`DELETE FROM ps_route_variants WHERE project_id = ${id}::uuid`);
    // Passata DINAMICA: sui DB storici possono esistere tabelle figlie
    // fuori dal codice attuale. Trova ogni FK diretta verso ps_projects e
    // svuota le righe del progetto (2 passate per dipendenze tra figlie).
    const rFks = await tx.execute<any>(sql`
      SELECT c.conrelid::regclass::text AS child_table,
             a.attname AS child_col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'ps_projects'::regclass
         -- le righe che restano senza progetto (lo storico del programma in esercizio, 0019) non si cancellano
         AND c.confdeltype <> 'n'
    `);
    const fkRows: any[] = (rFks as any).rows ?? [];
    for (let pass = 0; pass < 2; pass++) {
      for (const fk of fkRows) {
        try {
          await tx.execute(sql.raw(
            `DELETE FROM ${fk.child_table} WHERE ${fk.child_col} = '${id}'`,
          ));
        } catch (e: any) {
          if ((e?.cause ?? e)?.code !== "23503" || pass === 1) throw e;
          // prima passata: una figlia con RESTRICT verso un'altra figlia — riprova dopo
        }
      }
    }
    await tx.execute(sql`DELETE FROM ps_projects WHERE id = ${id}::uuid`);
}
