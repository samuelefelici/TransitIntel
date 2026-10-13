/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONDUCENTI DI PROVA — per vedere il roster pieno senza dati di nessuno
 * ───────────────────────────────────────────────────────────────────────────
 * Crea conducenti FITTIZI completi: ritratto illustrato, deposito fra i
 * sette, comune di residenza vicino, orario, parametro coerente con
 * l'anzianità, ferie, scadenze di patente, CQC e visite (qualcuna scaduta o
 * vicina, per vedere lo scadenziario), qualcuno vicino alla pensione.
 *
 * Rotazioni dei riposi, miste come in azienda:
 *   · Gruppo B (Ancona, Marina, Osimo): la rotazione a 11 scaglioni
 *     (1 = lun+dom; 2–6 = dom; 7 = sab+dom; 8 = ven; 9 = gio; 10 = mer;
 *     11 = mar), gli scaglioni distribuiti fra i conducenti;
 *   · Gruppo A (Jesi, Jesi Urbano, Castelfidardo, Filottrano): riposo la
 *     domenica.
 * Le due rotazioni di prova si creano la prima volta (col nome che lo dice)
 * e si riusano dopo; quelle dell'azienda non si toccano. I riposi si
 * generano subito, così il tabellone li mostra.
 *
 * Niente matricola: i fittizi non si confondono con le persone vere.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";
import { DEPOSITI_INIZIALI, formattaOrario, lunediDi, rigaRotazione, type Deposito } from "./anagrafica-campi";
import { righe, sincronizzaCorrenti, TIPI_STORICO, type Ex } from "./anagrafica-store";
import { ritrattoDataUri } from "./ritratto-fittizio";

const COGNOMI = [
  "Rossi", "Bianchi", "Ferrari", "Romagnoli", "Marinelli", "Pieroni", "Mancini", "Santini", "Ceccarelli", "Pierini",
  "Giuliani", "Bartolini", "Pesaresi", "Carletti", "Cardinali", "Mazzieri", "Sabbatini", "Pigini", "Gabrielli", "Baldoni",
  "Palazzi", "Strappati", "Cingolani", "Polenta", "Mengarelli", "Pirani", "Gioacchini", "Orlandoni", "Lucesoli", "Bevilacqua",
  "Tittarelli", "Bellagamba", "Carbonari", "Montecchiani", "Rocchetti", "Fiordelmondo", "Baldassarri", "Serrani",
];
const NOMI_M = ["Marco", "Luca", "Andrea", "Francesco", "Alessandro", "Matteo", "Davide", "Stefano", "Simone", "Giuseppe",
  "Roberto", "Paolo", "Fabio", "Michele", "Riccardo", "Daniele", "Nicola", "Massimo", "Lorenzo", "Mauro", "Claudio", "Gianluca"];
const NOMI_F = ["Giulia", "Sara", "Martina", "Chiara", "Francesca", "Valentina", "Federica", "Elena", "Silvia", "Laura", "Monica", "Barbara"];
const VIE = ["Via Roma", "Via Garibaldi", "Via Mazzini", "Corso Matteotti", "Via XXV Aprile", "Via Leopardi", "Via Marconi",
  "Via della Repubblica", "Via Cavour", "Via Verdi", "Via San Francesco", "Via Gramsci"];

/** Comuni (con CAP) da cui si va a lavorare in ciascun deposito. */
const COMUNI: Record<string, Array<[string, string]>> = {
  ancona: [["Ancona", "60121"], ["Ancona", "60131"], ["Falconara Marittima", "60015"], ["Camerano", "60021"], ["Polverigi", "60020"]],
  marina: [["Montemarciano", "60018"], ["Senigallia", "60019"], ["Chiaravalle", "60033"], ["Ostra", "60010"]],
  osimo: [["Osimo", "60027"], ["Castelfidardo", "60022"], ["Offagna", "60020"]],
  jesi: [["Jesi", "60035"], ["Monsano", "60030"], ["Santa Maria Nuova", "60030"]],
  "jesi-urbano": [["Jesi", "60035"], ["Moie di Maiolati Spontini", "60030"]],
  castelfidardo: [["Castelfidardo", "60022"], ["Loreto", "60025"], ["Recanati", "62019"]],
  filottrano: [["Filottrano", "60024"], ["Cingoli", "62011"]],
};

/** Quanti conducenti per deposito, su 30: Ancona è il più grande. */
const PESI: Record<string, number> = { ancona: 8, marina: 4, osimo: 4, jesi: 4, "jesi-urbano": 4, castelfidardo: 3, filottrano: 3 };

/** La rotazione del Gruppo B, 11 scaglioni: lun..dom per ogni riga. */
export const ROTAZIONE_B: Array<Array<string | null>> = [
  ["R", null, null, null, null, null, "R"],
  [null, null, null, null, null, null, "R"],
  [null, null, null, null, null, null, "R"],
  [null, null, null, null, null, null, "R"],
  [null, null, null, null, null, null, "R"],
  [null, null, null, null, null, null, "R"],
  [null, null, null, null, null, "R", "R"],
  [null, null, null, null, "R", null, null],
  [null, null, null, "R", null, null, null],
  [null, null, "R", null, null, null, null],
  [null, "R", null, null, null, null, null],
];
export const ROTAZIONE_A: Array<Array<string | null>> = [[null, null, null, null, null, null, "R"]];
export const NOME_ROTAZIONE_B = "Gruppo B · 11 scaglioni (conducenti di prova)";
export const NOME_ROTAZIONE_A = "Gruppo A · riposo la domenica (conducenti di prova)";

const GIORNI_RIPOSI = 120;
const scegli = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const tra = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
const data = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(Math.min(d, 28))}`;
const piuGiorni = (iso: string, g: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + g * 86_400_000).toISOString().slice(0, 10);

/** Codice fiscale col formato giusto ma inventato (non passa il controllo del carattere finale). */
function cfFinto(cognome: string, nome: string, nascita: string, donna: boolean): string {
  const cons = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, "").replace(/[AEIOU]/g, "");
  const giorno = Number(nascita.slice(8, 10)) + (donna ? 40 : 0);
  return `${(cons(cognome) + "XXX").slice(0, 3)}${(cons(nome) + "XXX").slice(0, 3)}${nascita.slice(2, 4)}`
    + `${"ABCDEHLMPRST"[Number(nascita.slice(5, 7)) - 1]}${pad(giorno)}A${pad(tra(100, 999), 3)}X`;
}

/** La rotazione di prova col nome dato: si crea la prima volta, con l'ancora a questo lunedì. */
async function rotazioneDiProva(ex: Ex, nome: string, pattern: Array<Array<string | null>>, ancora: string): Promise<{ id: string; weeks: number; pattern: Array<Array<string | null>>; ancora: string }> {
  const c = righe(await ex.execute(sql`
    SELECT id, weeks, pattern, to_char(anchor_date, 'YYYY-MM-DD') AS ancora FROM roster_rotazioni_riposi
     WHERE name = ${nome} ORDER BY created_at LIMIT 1`))[0];
  if (c) {
    if (!c.ancora) await ex.execute(sql`UPDATE roster_rotazioni_riposi SET anchor_date = ${ancora}::date WHERE id = ${c.id}::uuid`);
    return { id: c.id, weeks: Number(c.weeks), pattern: c.pattern, ancora: c.ancora ?? ancora };
  }
  const n = righe(await ex.execute(sql`
    INSERT INTO roster_rotazioni_riposi (name, weeks, pattern, meta, anchor_date)
    VALUES (${nome}, ${pattern.length}, ${JSON.stringify(pattern)}::jsonb, ${JSON.stringify({ source: "conducenti di prova" })}::jsonb, ${ancora}::date)
    RETURNING id`))[0];
  return { id: n.id, weeks: pattern.length, pattern, ancora };
}

export interface EsitoProva { creati: number; rotazioni: string[]; riposi: number }

export async function creaConducentiDiProva(ex: Ex, quanti: number, oggi: string): Promise<EsitoProva> {
  const anno = Number(oggi.slice(0, 4));
  const lunedi = lunediDi(oggi);
  const depositi: Deposito[] = (righe(await ex.execute(sql`SELECT codice, nome, gruppo FROM roster_depositi ORDER BY ordine`)) as any[])
    .map(d => ({ codice: d.codice, nome: d.nome, gruppo: d.gruppo, cadenzaTurni: "semimensile", alias: [], ordine: 0 }));
  const elenco = depositi.length ? depositi : DEPOSITI_INIZIALI;
  /* la sequenza dei depositi rispetta i pesi, mescolata */
  const sequenza: Deposito[] = [];
  while (sequenza.length < quanti) {
    for (const d of elenco) for (let k = 0; k < (PESI[d.codice] ?? 2); k++) sequenza.push(d);
  }
  sequenza.length = quanti;
  sequenza.sort(() => Math.random() - 0.5);

  const rotB = await rotazioneDiProva(ex, NOME_ROTAZIONE_B, ROTAZIONE_B, lunedi);
  const rotA = await rotazioneDiProva(ex, NOME_ROTAZIONE_A, ROTAZIONE_A, lunedi);
  const usati = new Set(righe(await ex.execute(sql`SELECT badge FROM roster_drivers WHERE badge LIKE 'FIT-%'`)).map(x => x.badge));
  const nomiUsati = new Set<string>();
  const posizioni = new Map<string, number>();
  let scaglioneB = tra(0, 10);
  let progressivo = 1;
  const ids: string[] = [];
  let riposi = 0;

  for (let i = 0; i < quanti; i++) {
    let badge = "";
    do badge = `FIT-${pad(progressivo++, 3)}`; while (usati.has(badge));
    usati.add(badge);
    const donna = Math.random() < 0.22;
    let cognome = "", nome = "";
    do { cognome = scegli(COGNOMI); nome = donna ? scegli(NOMI_F) : scegli(NOMI_M); } while (nomiUsati.has(`${cognome} ${nome}`) && nomiUsati.size < 400);
    nomiUsati.add(`${cognome} ${nome}`);
    const dep = sequenza[i];
    const eta = tra(26, 63);
    const nascita = data(anno - eta, tra(1, 12), tra(1, 28));
    const assuntoAnno = Math.max(anno - eta + 21, anno - tra(1, 32));
    const assunzione = data(assuntoAnno, tra(1, 12), tra(1, 28));
    const anzianita = anno - assuntoAnno;
    const parametro = anzianita < 3 ? 140 : anzianita < 8 ? 158 : anzianita < 15 ? 175 : 183;
    const verificatore = i % 13 === 7;
    const categoria = verificatore ? "Verificatore" : "Autista";
    const minuti = scegli([39 * 60, 39 * 60, 39 * 60, 38 * 60 + 30, 36 * 60]);
    const [comune, cap] = scegli(COMUNI[dep.codice] ?? [["Ancona", "60121"]]);
    const abil = new Set(["autobus"]);
    if (Math.random() < 0.35) abil.add("autosnodato");
    if (dep.codice === "ancona" && Math.random() < 0.3) abil.add("filobus");
    if (verificatore) abil.add("verificatore");
    /* uscite: i più anziani vanno in pensione nei prossimi mesi, uno si dimette */
    const uscita = eta >= 61 ? piuGiorni(oggi, tra(40, 200)) : i === quanti - 2 ? piuGiorni(oggi, tra(20, 90)) : null;
    const motivo = uscita ? (eta >= 61 ? "pensione" : "dimissioni") : null;
    /* scadenze: per lo più in regola, qualcuna vicina o scaduta */
    const scadPatente = i % 11 === 3 ? piuGiorni(oggi, -tra(5, 40)) : piuGiorni(oggi, tra(60, 2200));
    const scadCqc = i % 7 === 2 ? piuGiorni(oggi, tra(5, 28)) : piuGiorni(oggi, tra(90, 1800));
    const visitaF = piuGiorni(oggi, -tra(30, 900));
    const scadF = i % 9 === 4 ? piuGiorni(oggi, tra(10, 55)) : piuGiorni(visitaF, tra(700, 1800));
    const visitaM = piuGiorni(oggi, -tra(20, 500));
    const scadM = piuGiorni(visitaM, 365 * tra(1, 2));
    const esitoM = i % 17 === 9 ? "temp_non_idoneo" : i % 5 === 0 ? "idoneo_prescrizioni" : "idoneo";
    const ultimoDelMese = piuGiorni(`${oggi.slice(0, 8)}01`, -1);
    const cellulare = `3${scegli(["33", "34", "38", "39", "47", "49"])}${tra(1000000, 9999999)}`;
    const foto = ritrattoDataUri({ seme: Date.now() % 100000 + i * 31, donna, eta });

    const id = righe(await ex.execute(sql`
      INSERT INTO roster_drivers (
        name, badge, is_fictitious, cognome, nome, cf, data_nascita, data_assunzione, data_fine_servizio, motivo_cessazione,
        residenza_anagrafica, cellulare, inquadramento, parametro, ferie_annue, ferie_residue, ferie_residue_al, ferie_unita,
        scaglione_ferie, patente, patente_numero, cqc_numero, abilitazioni, photo_url, versione, updated_at)
      VALUES (
        ${`${cognome} ${nome}`}, ${badge}, true, ${cognome}, ${nome}, ${cfFinto(cognome, nome, nascita, donna)},
        ${nascita}::date, ${assunzione}::date, ${uscita}::date, ${motivo},
        ${`${scegli(VIE)} ${tra(1, 120)}, ${cap} ${comune} (${cap.startsWith("62") ? "MC" : "AN"})`}, ${cellulare},
        ${"Operatore di esercizio"}, ${parametro}, 26, ${tra(4, 48) / 2}, ${ultimoDelMese}::date, 'giorni',
        ${String((i % 4) + 1)}, ${abil.has("autosnodato") ? "D, DE" : "D"}, ${`AN${tra(1000000, 9999999)}`}, NULL,
        ${`{${[...abil].join(",")}}`}::text[], ${foto}, 0, now())
      RETURNING id`))[0].id;
    await ex.execute(sql`UPDATE roster_drivers SET cqc_numero = patente_numero WHERE id = ${id}::uuid`);
    await ex.execute(sql`
      INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note) VALUES
        (${id}::uuid, 'deposito', ${dep.nome}, ${assunzione}::date, NULL, 'conducente di prova'),
        (${id}::uuid, 'categoria', ${categoria}, ${assunzione}::date, NULL, 'conducente di prova'),
        (${id}::uuid, 'orario_lavoro', ${formattaOrario(minuti)}, ${assunzione}::date, NULL, 'conducente di prova'),
        (${id}::uuid, 'patente', NULL, ${piuGiorni(scadPatente, -3650)}::date, ${scadPatente}::date, 'conducente di prova'),
        (${id}::uuid, 'cqc', NULL, ${piuGiorni(scadCqc, -1825)}::date, ${scadCqc}::date, 'conducente di prova'),
        (${id}::uuid, 'visita_ferrovie', 'idoneo', ${visitaF}::date, ${scadF}::date, 'conducente di prova'),
        (${id}::uuid, 'visita_medico_competente', ${esitoM}, ${visitaM}::date, ${scadM}::date, 'conducente di prova')`);

    /* rotazione riposi: Gruppo B a scaglioni misti, Gruppo A la domenica */
    const rot = dep.gruppo === "B" ? rotB : rotA;
    const weekIndex = dep.gruppo === "B" ? (scaglioneB++ % rotB.weeks) : 0;
    await ex.execute(sql`
      INSERT INTO roster_rotazione_assegnazioni (rotazione_id, week_index, driver_id)
      VALUES (${rot.id}::uuid, ${weekIndex}, ${id}::uuid)`);
    const voci: Array<{ giorno: string; codice: string }> = [];
    for (let g = 0; g < GIORNI_RIPOSI; g++) {
      const giorno = piuGiorni(lunedi, g);
      if (uscita && giorno > uscita) break;
      const dow = (new Date(`${giorno}T00:00:00Z`).getUTCDay() + 6) % 7;
      const codice = rot.pattern[rigaRotazione(weekIndex, rot.weeks, rot.ancora, giorno)]?.[dow];
      if (codice) voci.push({ giorno, codice });
    }
    if (voci.length) {
      const r = await ex.execute(sql`
        INSERT INTO roster_entries (driver_id, day, category, code, source)
        VALUES ${sql.join(voci.map(v => sql`(${id}::uuid, ${v.giorno}::date, 'assenza', ${v.codice}, ${`rotazione:${rot.id}`})`), sql`, `)}
        ON CONFLICT (driver_id, day, code) DO NOTHING`);
      riposi += r.rowCount ?? 0;
    }

    /* rotazione turni: un gruppo di prova per deposito, posizioni in fila dopo quelle già date */
    const gid = righe(await ex.execute(sql`
      INSERT INTO roster_gruppi_turni (deposito_codice, nome) VALUES (${dep.codice}, 'PROVA')
      ON CONFLICT (deposito_codice, nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`))[0].id;
    if (!posizioni.has(dep.codice)) {
      posizioni.set(dep.codice, Number(righe(await ex.execute(sql`
        SELECT coalesce(max(rotazione_turni_posizione), 0) AS m FROM roster_drivers WHERE rotazione_turni_gruppo_id = ${gid}::uuid`))[0].m));
    }
    const pos = posizioni.get(dep.codice)! + 1;
    posizioni.set(dep.codice, pos);
    await ex.execute(sql`
      UPDATE roster_drivers SET rotazione_turni_gruppo_id = ${gid}::uuid, rotazione_turni_posizione = ${pos} WHERE id = ${id}::uuid`);
    ids.push(id);
  }
  await sincronizzaCorrenti(ex, oggi, TIPI_STORICO, ids);
  return { creati: ids.length, rotazioni: [NOME_ROTAZIONE_B, NOME_ROTAZIONE_A], riposi };
}
