// Trasforma un `pg_dump --schema-only --no-owner -n public -n caronte` della
// produzione nella migrazione 0000_baseline.sql.
//
// Il baseline deve fare due cose opposte:
//  - su un database vuoto, far nascere lo stesso schema della produzione;
//  - sulla produzione, non fare niente e non prendere lock.
// Per questo ogni oggetto sta dentro un blocco DO che guarda prima il
// catalogo: `CREATE INDEX IF NOT EXISTS` da solo prenderebbe uno ShareLock
// sulla tabella prima di accorgersi che l'indice c'è già, e il migrator di
// drizzle esegue tutto in una transazione sola (scritture ferme su 80 tabelle
// fino al commit). `CREATE TABLE`, invece, dentro il DO non tocca la tabella
// se esiste.
//
// Esclusi: i GRANT e i permessi di default (i ruoli li decidono le migrazioni
// successive), i SET del dump, lo schema public (c'è sempre) e
// caronte.app_users, che non è di Cerbero.

/** Tabelle presenti in produzione che non sono di Cerbero: il baseline non le crea. */
export const ESCLUSE = ["caronte.app_users"];

const INTESTAZIONE = /^-- Name: (.*); Type: (.*); Schema: (.*); Owner: (.*)$/;

/** Divide il dump nei suoi blocchi: [{nome, tipo, schema, sql}]. */
export function blocchiDelDump(dump) {
  const righe = dump.replace(/\r\n/g, "\n").split("\n");
  const blocchi = [];
  let corrente = null;
  for (let i = 0; i < righe.length; i++) {
    const m = INTESTAZIONE.exec(righe[i]);
    if (m) {
      if (corrente) blocchi.push(corrente);
      corrente = { nome: m[1], tipo: m[2], schema: m[3], righe: [] };
      i++; // la riga "--" che chiude l'intestazione
      continue;
    }
    if (!corrente) continue;
    if (righe[i] === "--" && INTESTAZIONE.test(righe[i + 1] ?? "")) continue;
    if (righe[i].startsWith("-- PostgreSQL database dump complete")) break;
    if (righe[i] === "--" && (righe[i + 1] ?? "").startsWith("-- PostgreSQL database dump complete")) break;
    corrente.righe.push(righe[i]);
  }
  if (corrente) blocchi.push(corrente);
  return blocchi.map(({ righe: r, ...b }) => ({ ...b, sql: r.join("\n").trim() }));
}

const lit = s => `'${s.replace(/'/g, "''")}'`;

const rientra = (testo, spazi) => testo.replace(/^/gm, " ".repeat(spazi));

/**
 * `IF condizione THEN istruzione` in un blocco DO. Con `datiDipendenti`
 * l'istruzione che i dati non permettono (doppioni, righe orfane) diventa un
 * WARNING: sulla produzione non succede, ma un'installazione vecchia con dati
 * sporchi non deve fermare il deploy per un indice.
 */
function guardato(condizione, istruzione, datiDipendenti = false) {
  const corpo = datiDipendenti
    ? [
        "BEGIN",
        rientra(istruzione, 2),
        "EXCEPTION WHEN unique_violation OR foreign_key_violation THEN",
        `  RAISE WARNING 'baseline: % non creato: %', ${lit(nomeOggetto(istruzione))}, SQLERRM;`,
        "END;",
      ].join("\n")
    : istruzione;
  return ["DO $baseline$", "BEGIN", `  IF ${condizione} THEN`, rientra(corpo, 4), "  END IF;", "END", "$baseline$;"].join("\n");
}

function nomeOggetto(istruzione) {
  const m = /(?:INDEX|CONSTRAINT)\s+(\S+)/.exec(istruzione);
  return m ? m[1] : "oggetto";
}

const TABELLA_ALTER = /^ALTER TABLE(?: ONLY)? (\S+)/;

/** Una sola istruzione del dump → SQL guardato, oppure null se va esclusa. */
export function guardia(b) {
  const sql = b.sql;
  // Le guardie confrontano i nomi così come stanno nel dump: con nomi quotati
  // ("createdAt") o con ON ONLY (tabelle partizionate) non coinciderebbero
  // mai col catalogo e il DDL ripartirebbe sugli oggetti esistenti.
  const senzaLetterali = sql.replace(/'(?:[^']|'')*'/g, "''"); // i default jsonb hanno virgolette
  if (/"/.test(senzaLetterali) || /\bON ONLY\b/.test(senzaLetterali)) {
    throw new Error(`baseline: nomi quotati o ON ONLY non gestiti (${b.tipo} ${b.nome}): adatta il generatore`);
  }
  const tocca = ESCLUSE.some(t => new RegExp(`\\b${t.replace(".", "\\.")}\\b`).test(sql));
  if (tocca) return null;
  switch (b.tipo) {
    case "SCHEMA": {
      if (b.nome === "public") return null;
      return guardato(`NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${lit(b.nome)})`, sql);
    }
    case "COMMENT":
    case "ACL":
    case "DEFAULT ACL":
      return null;
    case "TABLE":
    case "VIEW": {
      const m = /^CREATE (?:TABLE|VIEW) (\S+)/.exec(sql);
      if (!m) throw new Error(`baseline: ${b.tipo} senza nome: ${sql.slice(0, 80)}`);
      return guardato(`to_regclass(${lit(m[1])}) IS NULL`, sql);
    }
    case "SEQUENCE": {
      const crea = /^CREATE SEQUENCE (\S+)/.exec(sql);
      if (crea) return guardato(`to_regclass(${lit(crea[1])}) IS NULL`, sql);
      const ident = /^ALTER TABLE (\S+) ALTER COLUMN (\S+) ADD GENERATED/.exec(sql);
      if (ident) {
        return guardato(
          `NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${lit(ident[1])}) AND attname = ${lit(ident[2])} AND attidentity <> '')`,
          sql,
        );
      }
      throw new Error(`baseline: SEQUENCE non riconosciuta: ${sql.slice(0, 80)}`);
    }
    case "SEQUENCE OWNED BY": {
      const m = /^ALTER SEQUENCE (\S+) OWNED BY (\S+)\.(\S+);$/.exec(sql);
      if (!m) throw new Error(`baseline: OWNED BY non riconosciuto: ${sql}`);
      return guardato(
        `NOT EXISTS (SELECT 1 FROM pg_depend WHERE objid = to_regclass(${lit(m[1])}) AND refobjid = to_regclass(${lit(m[2])}) AND deptype IN ('a', 'i'))`,
        sql,
      );
    }
    case "DEFAULT": {
      const m = /^ALTER TABLE ONLY (\S+) ALTER COLUMN (\S+) SET DEFAULT/.exec(sql);
      if (!m) throw new Error(`baseline: DEFAULT non riconosciuto: ${sql}`);
      return guardato(
        `NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(${lit(m[1])}) AND attname = ${lit(m[2])} AND atthasdef)`,
        sql,
      );
    }
    case "CONSTRAINT":
    case "FK CONSTRAINT": {
      const t = TABELLA_ALTER.exec(sql);
      const c = /ADD CONSTRAINT (\S+)/.exec(sql);
      if (!t || !c) throw new Error(`baseline: vincolo non riconosciuto: ${sql}`);
      const datiDipendenti = b.tipo === "FK CONSTRAINT" || /\bUNIQUE\b/.test(sql);
      return guardato(
        `NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass(${lit(t[1])}) AND conname = ${lit(c[1])})`,
        sql,
        datiDipendenti,
      );
    }
    case "INDEX": {
      const m = /^CREATE (UNIQUE )?INDEX (\S+) ON (\S+)/.exec(sql);
      if (!m) throw new Error(`baseline: indice non riconosciuto: ${sql}`);
      const schema = m[3].split(".")[0];
      return guardato(`to_regclass(${lit(`${schema}.${m[2]}`)}) IS NULL`, sql, Boolean(m[1]));
    }
    default:
      throw new Error(`baseline: tipo «${b.tipo}» non previsto (${b.nome})`);
  }
}

/** Il file 0000_baseline.sql completo, con i separatori di drizzle. */
export function generaBaseline(dump, { fonte = "lib/db/schema-produzione/2026-10-25.sql" } = {}) {
  const versione = /-- Dumped from database version (.*)/.exec(dump)?.[1] ?? "?";
  const parti = blocchiDelDump(dump).map(guardia).filter(Boolean);
  const testa = [
    "-- ═══════════════════════════════════════════════════════════════════════════",
    "-- 0000 · Baseline: lo schema della produzione al 25 ottobre 2026",
    "-- ───────────────────────────────────────────────────────────────────────────",
    `-- Generato da lib/db/scripts/genera-baseline.mjs a partire da ${fonte}`,
    `-- (pg_dump --schema-only --no-owner -n public -n caronte, PostgreSQL ${versione}).`,
    "-- NON si modifica a mano: si rigenera, e un test controlla che coincida.",
    "--",
    "-- Su un database vuoto crea tutto; sulla produzione non cambia niente: ogni",
    "-- oggetto si crea solo se il catalogo dice che manca, quindi nessun lock",
    "-- sulle tabelle che esistono. Indici unici e chiavi esterne che i dati non",
    "-- permettono si saltano con un WARNING invece di fermare il deploy.",
    `-- Esclusi: GRANT, permessi di default, ${ESCLUSE.join(", ")} (non è di Cerbero).`,
    "-- ═══════════════════════════════════════════════════════════════════════════",
  ].join("\n");
  return `${testa}\n\n${parti.join("\n--> statement-breakpoint\n")}\n`;
}
