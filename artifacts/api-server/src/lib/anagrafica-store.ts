/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PERSONALE — tabelle, lettura, valore corrente dallo storico
 * ───────────────────────────────────────────────────────────────────────────
 * Le tabelle si creano da sé al primo bisogno, come il resto del roster. Il
 * bootstrap è una promessa memorizzata che si azzera se fallisce; le ALTER
 * girano solo per le colonne che mancano davvero (ALTER … IF NOT EXISTS
 * prende comunque un lock esclusivo sulla tabella, e dietro un import lungo
 * metterebbe in coda tutte le letture). I passi sui dati stanno in una
 * transazione con un lock consultivo, così due processi non li fanno insieme.
 *
 * Valore corrente e storico. Deposito, categoria, orario, visite e scadenze
 * di patente e CQC hanno uno storico (roster_driver_history): la colonna sul
 * conducente è la riga più recente GIÀ IN VIGORE (data ≤ oggi, o senza data
 * = stato iniziale). Una riga futura è una variazione programmata: diventa
 * corrente il giorno in cui scatta, con la risincronizzazione del mattino.
 * Quelle colonne le scrive solo `sincronizzaCorrenti`: un solo scrittore.
 *
 * Tutte le funzioni che scrivono prendono l'esecutore `ex` (la transazione):
 * dentro una transazione `db` è un'altra connessione, che non vede le righe
 * non ancora confermate e aspetta i loro lock.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import {
  DEPOSITI_INIZIALI, ESITI_VISITA, formattaOrario, leggiEsitoVisita, leggiOrario, matricolaCanonica, rigaRotazione, lunediDi,
  type Conducente, type EsitoVisita, type Deposito, type UnitaFerie,
} from "./anagrafica-campi";
import { inSistema } from "@workspace/db/contesto";

export type Ex = { execute(q: SQL): Promise<{ rows: any[]; rowCount?: number | null }> };
export const righe = (r: { rows?: any[] } | null | undefined): any[] => r?.rows ?? [];

/** La data di oggi a Roma (le scadenze e le decorrenze sono date di calendario). */
export function oggiRoma(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(now);
}

/* ── Colonne ────────────────────────────────────────────────────────────── */

/** Il predicato dell'unicità della matricola: identico nel controllo e nell'indice. */
const PREDICATO_UNICITA = "is_active AND NOT is_fictitious AND matricola_chiave IS NOT NULL";

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

let pronto: Promise<void> | null = null;
let ultimoErrore: string | null = null;
let avvisiBootstrap: string[] = [];
let avvisiMatricole: string[] = [];

export function statoAnagrafica() { return { errore: ultimoErrore, avvisi: [...avvisiBootstrap, ...avvisiMatricole] }; }

export function assicuraAnagrafica(): Promise<void> {
  if (!pronto) {
    pronto = inSistema("avvio:anagrafica", passiIniziali).then(() => { ultimoErrore = null; }).catch((e: any) => {
      pronto = null;
      ultimoErrore = e?.cause?.code ?? e?.code ?? "errore";
      console.error("[anagrafica] passi iniziali non riusciti:", e?.cause?.message ?? e?.message ?? e);
      throw e;
    });
  }
  return pronto;
}

/** I passi sui dati vecchi, una volta per processo. Le tabelle le creano le migrazioni. */
async function passiIniziali(): Promise<void> {
  avvisiBootstrap = [];
  try {
    await db.transaction(async (tx) => { await passiSuiDati(tx as unknown as Ex); });
  } catch (e: any) {
    /* un passo sui dati fallito non spegne l'anagrafica */
    avvisiBootstrap.push(`passi iniziali sui dati non completati (${e?.cause?.code ?? e?.code ?? "errore"})`);
    console.error("[anagrafica] passi iniziali sui dati:", e?.cause?.message ?? e?.message ?? e);
  }
}

/** Il lock consultivo dei passi iniziali: un numero qualsiasi, purché fisso. */
const LOCK_BOOTSTRAP = 7_331_015;

/** Un passo sui dati vecchi da fare una volta sola: dopo, resta segnato. */
async function unaVolta(ex: Ex, passo: string, fai: () => Promise<void>): Promise<void> {
  if (righe(await ex.execute(sql`SELECT 1 FROM roster_anagrafica_passi WHERE passo = ${passo}`)).length) return;
  await fai();
  await ex.execute(sql`INSERT INTO roster_anagrafica_passi (passo) VALUES (${passo}) ON CONFLICT DO NOTHING`);
}

async function passiSuiDati(ex: Ex): Promise<void> {
  await ex.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_BOOTSTRAP})`);
  const oggi = oggiRoma();

  /* cataloghi: non si sovrascrive quello che qualcuno ha già cambiato */
  for (const d of DEPOSITI_INIZIALI) {
    await ex.execute(sql`
      INSERT INTO roster_depositi (codice, nome, gruppo, cadenza_turni, alias, ordine)
      VALUES (${d.codice}, ${d.nome}, ${d.gruppo}, ${d.cadenzaTurni}, ${`{${d.alias.map(a => `"${a}"`).join(",")}}`}::text[], ${d.ordine})
      ON CONFLICT DO NOTHING`);
  }
  await ex.execute(sql`
    INSERT INTO roster_categorie (codice, nome)
    SELECT DISTINCT ON (lower(btrim(v))) regexp_replace(lower(btrim(v)), '[^a-z0-9]+', '-', 'g'), btrim(v)
      FROM (SELECT categoria AS v, 1 AS prio FROM roster_drivers WHERE categoria IS NOT NULL AND btrim(categoria) <> ''
            UNION ALL SELECT 'Autista', 0) x
     /* fra «autista» e «Autista» vince la forma col maiuscolo iniziale */
     ORDER BY lower(btrim(v)), prio, (btrim(v) = initcap(btrim(v))) DESC, btrim(v)
    ON CONFLICT DO NOTHING`);

  /* matricola canonica: la calcola lo stesso codice dell'import e della
   * scheda (un'espressione SQL «gemella» divergeva su spazi speciali e ß) */
  for (const d of righe(await ex.execute(sql`SELECT id, matricola, matricola_chiave FROM roster_drivers`))) {
    const k = matricolaCanonica(d.matricola);
    if (k !== (d.matricola_chiave ?? null)) {
      await ex.execute(sql`UPDATE roster_drivers SET matricola_chiave = ${k} WHERE id = ${d.id}::uuid`);
    }
  }

  /* orario: lo storico in un formato solo («hh:mm»), poi i minuti dove mancano */
  const storOrario = await ex.execute(sql`
    SELECT id, value FROM roster_driver_history
     WHERE kind = 'orario_lavoro' AND value IS NOT NULL AND value !~ '^[0-9]{1,3}:[0-9]{2}$'`);
  let illeggibili = 0;
  for (const h of righe(storOrario)) {
    const l = leggiOrario(h.value);
    if (l && l.ok === true) {
      await ex.execute(sql`
        UPDATE roster_driver_history SET value = ${formattaOrario(l.valore)},
               note = concat_ws(' · ', note, ${`era «${String(h.value).slice(0, 40)}»`}::text)
         WHERE id = ${h.id}::uuid`);
    } else illeggibili++;
  }
  if (illeggibili) {
    avvisiBootstrap.push(`${illeggibili === 1 ? "una riga" : `${illeggibili} righe`} di storico dell'orario `
      + `${illeggibili === 1 ? "non leggibile" : "non leggibili"} (es. «Part-time»): l'orario resta quello che c'era`);
  }
  await ex.execute(sql`
    UPDATE roster_drivers SET orario_settimanale_min =
           CASE WHEN ore_settimanali <= 80 THEN ore_settimanali * 60 ELSE ore_settimanali END
     WHERE orario_settimanale_min IS NULL AND ore_settimanali IS NOT NULL`);

  /* Una volta sola, sui dati di prima. */
  await unaVolta(ex, "2026-10 numero patente dal CQC", async () => {
    /* il numero della patente è quello del CQC (così in azienda) */
    await ex.execute(sql`
      UPDATE roster_drivers SET patente_numero = cqc_numero
       WHERE patente_numero IS NULL AND cqc_numero IS NOT NULL`);
  });
  await unaVolta(ex, "2026-10 esiti delle visite", async () => {
    /* prima l'esito era un testo libero: «Non idoneo», «Idonea con prescrizioni»… */
    const vecchie = righe(await ex.execute(sql.raw(`
      SELECT id, value FROM roster_driver_history
       WHERE kind IN ('visita_ferrovie', 'visita_medico_competente') AND value IS NOT NULL
         AND value NOT IN ${`(${ESITI_VISITA.map(e => `'${e}'`).join(", ")})`}`)));
    let nonLetti = 0;
    for (const h of vecchie) {
      const l = leggiEsitoVisita(h.value);
      if (l && l.ok === true) {
        await ex.execute(sql`
          UPDATE roster_driver_history SET value = ${l.valore},
                 note = concat_ws(' · ', note, ${`era «${String(h.value).slice(0, 40)}»`}::text)
           WHERE id = ${h.id}::uuid`);
      } else nonLetti++;
    }
    if (nonLetti) avvisiBootstrap.push(`${nonLetti === 1 ? "un esito" : `${nonLetti} esiti`} di visita scritti a mano non riconosciuti: controllali nello storico`);
  });
  await unaVolta(ex, "2026-10 scadenze di patente e CQC", async () => {
    /* Prima la scheda scriveva le scadenze di patente e CQC sulla colonna e lo
     * storico le scriveva di nuovo: le due possono non coincidere, e la
     * colonna è l'ultima scritta a mano. Una riga di storico di oggi la
     * mette davanti, così la prima sincronizzazione non la cancella. */
    for (const [kind, col] of [["patente", "patente_validita"], ["cqc", "cqc_validita"]] as const) {
      await ex.execute(sql.raw(`
        INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note)
        SELECT d.id, '${kind}', NULL, '${oggi}'::date, d.${col}, 'allineamento stato iniziale'
          FROM roster_drivers d
          JOIN LATERAL (SELECT h.expiry_date FROM roster_driver_history h
                         WHERE h.driver_id = d.id AND h.kind = '${kind}'
                           AND (h.event_date IS NULL OR h.event_date <= '${oggi}'::date)
                         ORDER BY h.event_date DESC NULLS LAST, h.created_at DESC, h.id DESC LIMIT 1) h ON true
         WHERE d.${col} IS NOT NULL AND h.expiry_date IS DISTINCT FROM d.${col}`));
    }
  });

  /* righe di base: ogni valore corrente che non ha storico ne riceve una
   * senza data, così cancellare per sbaglio l'ultima riga non lo azzera */
  const basi: Array<[string, string, string]> = [
    ["deposito", "residenza_servizio", "NULL"],
    ["categoria", "categoria", "NULL"],
    ["orario_lavoro", "orario_settimanale_min", "NULL"],
    ["visita_ferrovie", "visita_ferrovie_validita", "visita_ferrovie_validita"],
    ["visita_medico_competente", "visita_medico_competente_validita", "visita_medico_competente_validita"],
    ["patente", "patente_validita", "patente_validita"],
    ["cqc", "cqc_validita", "cqc_validita"],
  ];
  for (const [kind, col, scad] of basi) {
    const valore = kind === "orario_lavoro"
      ? `concat(orario_settimanale_min / 60, ':', lpad((orario_settimanale_min % 60)::text, 2, '0'))`
      : kind.startsWith("visita_") ? `${kind}_esito`
      : scad === "NULL" ? col : "NULL";
    await ex.execute(sql.raw(`
      INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note)
      SELECT d.id, '${kind}', ${valore}, ${kind.startsWith("visita_") ? `${kind}_data` : "NULL"}, ${scad}, 'stato iniziale'
        FROM roster_drivers d
       WHERE d.${col} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM roster_driver_history h WHERE h.driver_id = d.id AND h.kind = '${kind}')`));
  }

  await verificaUnicitaMatricole(ex);
}

/**
 * L'unicità della matricola fra i conducenti attivi veri. La garantisce
 * l'indice unico delle migrazioni, che però non nasce su un database dove in
 * quel momento c'erano matricole doppie: finché ci sono, o finché l'indice
 * manca, un avviso. Gira all'avvio e ogni mattina. L'indice non lo crea più
 * l'app (non cambia lo schema): l'avviso dice l'istruzione per chi amministra
 * il database.
 */
export async function verificaUnicitaMatricole(ex: Ex): Promise<void> {
  const doppie = righe(await ex.execute(sql.raw(`
    SELECT matricola_chiave FROM roster_drivers WHERE ${PREDICATO_UNICITA}
     GROUP BY matricola_chiave HAVING count(*) > 1 ORDER BY 1 LIMIT 10`)));
  if (doppie.length) {
    avvisiMatricole = [`matricole doppie fra i conducenti attivi: ${doppie.map((x: any) => x.matricola_chiave).join(", ")}. `
      + "Finché ci sono, il database non può garantire che la matricola sia unica"];
    return;
  }
  const indice = righe(await ex.execute(sql`SELECT to_regclass('uq_roster_drivers_matricola') IS NOT NULL AS presente`));
  avvisiMatricole = indice[0]?.presente ? [] : [
    "manca l'indice che garantisce l'unicità della matricola (quando è nato lo schema c'erano matricole doppie). "
    + "Ora i dati lo permettono: chi amministra il database lo crea con "
    + `CREATE UNIQUE INDEX uq_roster_drivers_matricola ON roster_drivers (matricola_chiave) WHERE ${PREDICATO_UNICITA}`];
}

/* ── Valore corrente dallo storico ──────────────────────────────────────── */

export const TIPI_STORICO = [
  "deposito", "categoria", "orario_lavoro", "visita_ferrovie", "visita_medico_competente", "patente", "cqc",
] as const;
export type TipoStorico = typeof TIPI_STORICO[number];

const ESITI_SQL = `(${ESITI_VISITA.map(e => `'${e}'`).join(", ")})`;
/* Un valore vecchio illeggibile («Part-time») non azzera l'orario: resta quello che c'è. */
const MINUTI_SQL = `CASE WHEN h.value ~ '^[0-9]{1,3}:[0-9]{2}$' THEN split_part(h.value, ':', 1)::int * 60 + split_part(h.value, ':', 2)::int
                         WHEN h.value IS NULL THEN NULL ELSE d.orario_settimanale_min END`;

/** Per ogni tipo di storico: le colonne del conducente e i valori presi dalla riga h. */
const CORRENTE: Record<TipoStorico, { colonne: string; valori: string }> = {
  deposito: {
    colonne: "residenza_servizio",
    valori: `coalesce((SELECT dp.nome FROM roster_depositi dp
                        WHERE lower(dp.nome) = lower(btrim(h.value)) OR lower(dp.codice) = lower(btrim(h.value))
                           OR lower(btrim(h.value)) = ANY (SELECT lower(a) FROM unnest(dp.alias) a)
                        ORDER BY dp.ordine LIMIT 1), h.value)`,
  },
  categoria: {
    colonne: "categoria",
    valori: `coalesce((SELECT c.nome FROM roster_categorie c
                        WHERE lower(c.nome) = lower(btrim(h.value))
                           OR lower(btrim(h.value)) = ANY (SELECT lower(a) FROM unnest(c.alias) a)
                        LIMIT 1), h.value)`,
  },
  orario_lavoro: {
    colonne: "orario_settimanale_min, ore_settimanali",
    valori: `${MINUTI_SQL}, round((${MINUTI_SQL}) / 60.0)::int`,
  },
  visita_ferrovie: {
    colonne: "visita_ferrovie_validita, visita_ferrovie_data, visita_ferrovie_esito",
    valori: `h.expiry_date, h.event_date, CASE WHEN h.value IN ${ESITI_SQL} THEN h.value END`,
  },
  visita_medico_competente: {
    colonne: "visita_medico_competente_validita, visita_medico_competente_data, visita_medico_competente_esito",
    valori: `h.expiry_date, h.event_date, CASE WHEN h.value IN ${ESITI_SQL} THEN h.value END`,
  },
  patente: { colonne: "patente_validita", valori: "h.expiry_date" },
  cqc: { colonne: "cqc_validita", valori: "h.expiry_date" },
};

/**
 * Riallinea le colonne correnti alla riga più recente già in vigore. Con
 * `driverIds` lavora solo su quei conducenti e azzera chi non ha più righe in
 * vigore di quel tipo; senza, passa tutti (la risincronizzazione del
 * mattino, che non azzera niente).
 */
export async function sincronizzaCorrenti(
  ex: Ex, oggi: string, tipi: readonly TipoStorico[] = TIPI_STORICO, driverIds?: string[],
): Promise<void> {
  const filtro = driverIds ? sql` AND driver_id = ANY(${`{${driverIds.join(",")}}`}::uuid[])` : sql``;
  if (driverIds && driverIds.length === 0) return;
  for (const tipo of tipi) {
    const { colonne, valori } = CORRENTE[tipo];
    const nCol = colonne.split(",").length;
    await ex.execute(sql`
      UPDATE roster_drivers d SET (${sql.raw(colonne)}) = ROW(${sql.raw(valori)})
        FROM (SELECT DISTINCT ON (driver_id) driver_id, value, event_date, expiry_date
                FROM roster_driver_history
               WHERE kind = ${tipo} AND (event_date IS NULL OR event_date <= ${oggi}::date)${filtro}
               ORDER BY driver_id, event_date DESC NULLS LAST, created_at DESC, id DESC) h
       WHERE d.id = h.driver_id AND ROW(${sql.raw(colonne.split(",").map(c => `d.${c.trim()}`).join(", "))}) IS DISTINCT FROM ROW(${sql.raw(valori)})`);
    if (driverIds) {
      await ex.execute(sql`
        UPDATE roster_drivers d SET (${sql.raw(colonne)}) = ROW(${sql.raw(Array(nCol).fill("NULL").join(", "))})
         WHERE d.id = ANY(${`{${driverIds.join(",")}}`}::uuid[])
           AND NOT EXISTS (SELECT 1 FROM roster_driver_history h
                            WHERE h.driver_id = d.id AND h.kind = ${tipo}
                              AND (h.event_date IS NULL OR h.event_date <= ${oggi}::date))`);
    }
  }
}

let ultimoGiornoSincronizzato: string | null = null;
let sincronizzazioneInCorso: Promise<void> | null = null;

/** Al primo passaggio di ogni giorno: le variazioni programmate per oggi entrano in vigore. */
export function sincronizzaSeNuovoGiorno(now: Date = new Date()): Promise<void> {
  const oggi = oggiRoma(now);
  if (ultimoGiornoSincronizzato === oggi) return Promise.resolve();
  if (!sincronizzazioneInCorso) {
    /* del sistema anche se la fa partire la prima richiesta del giorno (cerbero.via, PR 2.9) */
    sincronizzazioneInCorso = inSistema("anagrafica:giorno", () => db.transaction(async (tx) => {
      await sincronizzaCorrenti(tx as unknown as Ex, oggi);
      await verificaUnicitaMatricole(tx as unknown as Ex);
    })
      .then(() => { ultimoGiornoSincronizzato = oggi; })
      .catch((e: any) => { console.error("[anagrafica] risincronizzazione del giorno:", e?.cause?.message ?? e?.message ?? e); })
      .finally(() => { sincronizzazioneInCorso = null; }));
  }
  return sincronizzazioneInCorso;
}

/* ── Lettura ────────────────────────────────────────────────────────────── */

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const data = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const esito = (v: unknown): EsitoVisita | null => ((ESITI_VISITA as readonly string[]).includes(String(v)) ? (v as EsitoVisita) : null);

/** Una riga di roster_drivers (con le colonne delle LATERAL di leggiConducenti) → conducente completo. */
export function rigaAConducente(d: any, oggi: string): Conducente {
  let rotazioneRiposi: Conducente["rotazioneRiposi"] = null;
  if (d.rot_id) {
    const settimane = Number(d.rot_weeks);
    const weekIndex = Number(d.rot_week_index);
    const pattern: Array<Array<string | null>> = Array.isArray(d.rot_pattern) ? d.rot_pattern : [];
    const ancora = data(d.rot_anchor_date);
    rotazioneRiposi = {
      id: d.rot_id, nome: d.rot_nome, settimane, scaglione: weekIndex + 1,
      settimanaCorrente: ancora && settimane > 0 ? (pattern[rigaRotazione(weekIndex, settimane, ancora, oggi)] ?? null) : null,
    };
  }
  return {
    id: d.id, name: d.name, badge: d.badge ?? null,
    isFictitious: !!d.is_fictitious, isActive: d.is_active !== false,
    versione: Number(d.versione ?? 0),
    updatedAt: d.updated_at ? new Date(d.updated_at).toISOString() : null,
    matricola: d.matricola ?? null, cognome: d.cognome ?? null, nome: d.nome ?? null,
    residenzaServizio: d.residenza_servizio ?? null, categoria: d.categoria ?? null,
    orarioSettimanaleMin: num(d.orario_settimanale_min),
    rotazioneRiposi, rotazioniRiposi: Number(d.rot_n ?? 0),
    scaglioneFerie: d.scaglione_ferie ?? null,
    rotazioneTurni: d.gt_id ? { gruppoId: d.gt_id, gruppo: d.gt_nome, posizione: num(d.rotazione_turni_posizione) } : null,
    abilitazioni: Array.isArray(d.abilitazioni) ? d.abilitazioni : [],
    photoUrl: d.photo_url ?? null,
    patente: d.patente ?? null,
    patenteValidita: data(d.patente_validita), cqcValidita: data(d.cqc_validita),
    visitaFerrovieValidita: data(d.visita_ferrovie_validita),
    visitaMedicoCompetenteValidita: data(d.visita_medico_competente_validita),
    visitaFerrovieEsito: esito(d.visita_ferrovie_esito),
    visitaMedicoCompetenteEsito: esito(d.visita_medico_competente_esito),
    cellulare: d.cellulare ?? null,
    dataFineServizio: data(d.data_fine_servizio),
    motivoCessazione: d.motivo_cessazione ?? null,
    cf: d.cf ?? null, dataNascita: data(d.data_nascita), dataAssunzione: data(d.data_assunzione),
    residenzaAnagrafica: d.residenza_anagrafica ?? null, telefono: d.telefono ?? null,
    inquadramento: d.inquadramento ?? null, parametro: num(d.parametro),
    ferieAnnue: num(d.ferie_annue), ferieResidue: num(d.ferie_residue), ferieResidueAl: data(d.ferie_residue_al),
    ferieUnita: (d.ferie_unita === "ore" ? "ore" : "giorni") as UnitaFerie,
    patenteNumero: d.patente_numero ?? null, cqcNumero: d.cqc_numero ?? null,
    visitaFerrovieData: data(d.visita_ferrovie_data),
    visitaMedicoCompetenteData: data(d.visita_medico_competente_data),
    note: d.note ?? null,
  };
}

export interface FiltroConducenti {
  id?: string;
  ids?: string[];
  /** anche i disattivati (l'anagrafica li mostra a richiesta; il tabellone no) */
  ancheDisattivati?: boolean;
  /** con la foto (pesante: data-URI) */
  conFoto?: boolean;
  /** FOR UPDATE: nelle scritture */
  blocca?: boolean;
}

export async function leggiConducenti(ex: Ex, f: FiltroConducenti, oggi: string): Promise<Conducente[]> {
  const where: SQL[] = [];
  if (!f.ancheDisattivati) where.push(sql`d.is_active = true`);
  if (f.id) where.push(sql`d.id = ${f.id}::uuid`);
  if (f.ids) where.push(sql`d.id = ANY(${`{${f.ids.join(",")}}`}::uuid[])`);
  const condizione = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
  const r = await ex.execute(sql`
    SELECT d.*, ${f.conFoto === false ? sql`NULL AS photo_url,` : sql``}
           rr.rot_id, rr.rot_nome, rr.rot_weeks, rr.rot_week_index, rr.rot_pattern,
           to_char(rr.rot_anchor_date, 'YYYY-MM-DD') AS rot_anchor_date, rr.rot_n,
           gt.id AS gt_id, gt.nome AS gt_nome
      FROM roster_drivers d
      LEFT JOIN LATERAL (
        SELECT r.id AS rot_id, r.name AS rot_nome, r.weeks AS rot_weeks, a.week_index AS rot_week_index,
               r.pattern AS rot_pattern, r.anchor_date AS rot_anchor_date, count(*) OVER () AS rot_n
          FROM roster_rotazione_assegnazioni a
          JOIN roster_rotazioni_riposi r ON r.id = a.rotazione_id
         WHERE a.driver_id = d.id
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1) rr ON true
      LEFT JOIN roster_gruppi_turni gt ON gt.id = d.rotazione_turni_gruppo_id
      ${condizione}
     ORDER BY d.cognome NULLS LAST, d.nome NULLS LAST, d.name
     ${f.blocca ? sql`FOR UPDATE OF d` : sql``}`);
  return righe(r).map(x => rigaAConducente(x, oggi));
}

/* ── Cataloghi ──────────────────────────────────────────────────────────── */

export async function leggiDepositi(ex: Ex): Promise<Deposito[]> {
  const r = await ex.execute(sql`SELECT * FROM roster_depositi ORDER BY ordine, nome`);
  return righe(r).map(x => ({
    codice: x.codice, nome: x.nome, gruppo: x.gruppo, cadenzaTurni: x.cadenza_turni,
    alias: Array.isArray(x.alias) ? x.alias : [], ordine: Number(x.ordine),
  }));
}

export interface Categoria { codice: string; nome: string; alias: string[] }

export async function leggiCategorie(ex: Ex): Promise<Categoria[]> {
  const r = await ex.execute(sql`SELECT * FROM roster_categorie ORDER BY nome`);
  return righe(r).map(x => ({ codice: x.codice, nome: x.nome, alias: Array.isArray(x.alias) ? x.alias : [] }));
}

export interface GruppoTurni { id: string; depositoCodice: string; nome: string; dataRiferimento: string | null; conducenti: number }

export async function leggiGruppiTurni(ex: Ex): Promise<GruppoTurni[]> {
  const r = await ex.execute(sql`
    SELECT g.id, g.deposito_codice, g.nome, to_char(g.data_riferimento, 'YYYY-MM-DD') AS data_riferimento,
           (SELECT count(*) FROM roster_drivers d WHERE d.rotazione_turni_gruppo_id = g.id AND d.is_active) AS n
      FROM roster_gruppi_turni g ORDER BY g.deposito_codice, g.nome`);
  return righe(r).map(x => ({
    id: x.id, depositoCodice: x.deposito_codice, nome: x.nome, dataRiferimento: x.data_riferimento, conducenti: Number(x.n),
  }));
}

/** Il nome di un gruppo di rotazione turni, normalizzato: «an-e 1» → «AN-E 1». */
export function nomeGruppo(s: string): string {
  return s.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 40);
}

/* ── Registro ───────────────────────────────────────────────────────────── */

export interface VoceRegistro {
  userId: string | null;
  via?: string | null;
  driverId?: string | null;
  azione: string;
  campi?: string[];
  dettaglio?: Record<string, unknown>;
}

export async function registra(ex: Ex, v: VoceRegistro): Promise<void> {
  const dettaglio = { ...(v.dettaglio ?? {}), ...(v.via ? { via: v.via } : {}) };
  await ex.execute(sql`
    INSERT INTO roster_anagrafica_log (user_id, driver_id, azione, campi, dettaglio)
    VALUES (${v.userId}::uuid, ${v.driverId ?? null}::uuid, ${v.azione},
            ${`{${(v.campi ?? []).map(c => `"${c.replace(/"/g, "")}"`).join(",")}}`}::text[],
            ${Object.keys(dettaglio).length ? JSON.stringify(dettaglio) : null}::jsonb)`);
}

/* ── Utilità per le date della rotazione ────────────────────────────────── */
export { lunediDi };
