/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA DEL PERSONALE — l'unico scrittore
 * ───────────────────────────────────────────────────────────────────────────
 * `applicaVariazioni` è la sola funzione che cambia un conducente: la usano
 * la scheda e l'import. Lavora in due tempi:
 *   1. piano: confronta ogni campo col valore corrente, decide quali righe di
 *      storico servono e raccoglie i conflitti;
 *   2. scrittura: solo se non ci sono conflitti.
 * Così una variazione in conflitto non lascia niente a metà, e nell'import
 * il conflitto di una riga si vede prima di scrivere.
 *
 * Le regole che contano:
 *   · una chiave assente non tocca niente; una chiave a null svuota il campo;
 *   · deposito, categoria, orario, visite e scadenze di patente/CQC non si
 *     scrivono sulla colonna: diventano una riga di storico con la sua
 *     decorrenza, e la colonna la riallinea sincronizzaCorrenti;
 *   · se lo storico ha già una riga PIÙ RECENTE della decorrenza, la
 *     variazione non vincerebbe mai: è un conflitto, non un salvataggio muto;
 *   · una visita viaggia con data, scadenza ed esito insieme: la parte che
 *     manca si prende dal corrente, e la stessa data è una correzione;
 *   · cambiare deposito toglie il gruppo turni (è del deposito); cambiare
 *     gruppo A/B toglie anche la rotazione riposi, con i riposi già generati.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from "drizzle-orm";
import {
  ABILITAZIONI, ESITI_VISITA, PARAMETRI, UNITA_FERIE, formattaOrario, matricolaCanonica,
  normalizzaScaglioneFerie, pulisciTesto, trovaDeposito, chiaveTesto,
  type Deposito, type EsitoVisita, type UnitaFerie,
} from "./anagrafica-campi";
import { nomeGruppo, righe, type Ex, type TipoStorico, type Categoria } from "./anagrafica-store";

export interface Visita { data?: string | null; scadenza?: string | null; esito?: EsitoVisita | null }

/** Una variazione già letta e validata. Chiave assente = non toccare; null = svuota. */
export interface Variazioni {
  matricola?: string | null;
  cognome?: string | null;
  nome?: string | null;
  badge?: string | null;
  cf?: string | null;
  dataNascita?: string | null;
  dataAssunzione?: string | null;
  dataFineServizio?: string | null;
  motivoCessazione?: string | null;
  residenzaAnagrafica?: string | null;
  cellulare?: string | null;
  telefono?: string | null;
  inquadramento?: string | null;
  parametro?: number | null;
  ferieAnnue?: number | null;
  /** residuo e data a cui vale viaggiano insieme */
  ferieResidue?: { valore: number | null; al: string | null };
  ferieUnita?: UnitaFerie;
  scaglioneFerie?: string | null;
  patente?: string | null;
  patenteNumero?: string | null;
  cqcNumero?: string | null;
  note?: string | null;
  photoUrl?: string | null;
  abilitazioni?: string[];
  /* con storico */
  deposito?: string | null;
  categoria?: string | null;
  orarioSettimanaleMin?: number | null;
  patenteValidita?: string | null;
  cqcValidita?: string | null;
  visitaFerrovie?: Visita;
  visitaMedicoCompetente?: Visita;
  /* relazioni */
  /** scaglione 1-based (il numero del gruppo) */
  rotazioneRiposi?: { id: string; scaglione: number } | null;
  rotazioneTurni?: { gruppo: string; posizione: number | null } | null;
}

export interface EsitoScrittura {
  cambiati: string[];
  avvisi: string[];
  conflitti: string[];
  tipi: Set<TipoStorico>;
  /** rotazioni riposi i cui riposi futuri vanno rigenerati */
  daRigenerare: Set<string>;
}

export interface OpzioniScrittura {
  oggi: string;
  /** data da cui valgono le variazioni con storico (default oggi) */
  decorrenza?: string;
  /** nota sulle righe di storico (es. «import file.xlsx») */
  nota?: string;
  depositi: Deposito[];
  categorie: Categoria[];
  /** riga grezza già letta e bloccata (import) */
  riga?: any;
  /** data più recente dello storico per tipo (import) */
  ultimeDate?: Map<string, string | null>;
  /**
   * può aggiungere voci ai cataloghi condivisi (categorie, gruppi della
   * rotazione turni)? No per chi ha solo «scheduling» e scrive un fittizio:
   * una categoria aggiunta da lì farebbe passare senza domande le righe
   * dell'import con quella categoria (default sì)
   */
  puoCreareCataloghi?: boolean;
}

const it = (iso: string) => iso.split("-").reverse().join("/");

async function ultimeDateDi(ex: Ex, driverId: string): Promise<Map<string, string | null>> {
  const r = await ex.execute(sql`
    SELECT kind, to_char(max(event_date), 'YYYY-MM-DD') AS ultima
      FROM roster_driver_history WHERE driver_id = ${driverId}::uuid GROUP BY kind`);
  return new Map(righe(r).map((x: any) => [x.kind, x.ultima]));
}

const testo = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const dataDi = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).slice(0, 10));
const numeroDi = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const uguali = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** Le voci di riposo già generate da una rotazione, da oggi in poi, per un conducente. */
async function cancellaRiposiFuturi(ex: Ex, driverId: string, rotazioneId: string, oggi: string): Promise<void> {
  await ex.execute(sql`
    DELETE FROM roster_entries
     WHERE driver_id = ${driverId}::uuid AND source = ${`rotazione:${rotazioneId}`} AND day >= ${oggi}::date`);
}

/**
 * Mette un conducente in una rotazione riposi (o in nessuna). Un conducente
 * sta in una rotazione sola: le altre si tolgono, coi loro riposi futuri.
 */
export async function assegnaRotazioneRiposi(
  ex: Ex, driverId: string, nuova: { id: string; weekIndex: number } | null, oggi: string,
): Promise<Set<string>> {
  const daRigenerare = new Set<string>();
  const ora = righe(await ex.execute(sql`
    SELECT rotazione_id, week_index FROM roster_rotazione_assegnazioni WHERE driver_id = ${driverId}::uuid`));
  for (const a of ora) {
    if (!nuova || a.rotazione_id !== nuova.id || Number(a.week_index) !== nuova.weekIndex) {
      await cancellaRiposiFuturi(ex, driverId, a.rotazione_id, oggi);
      daRigenerare.add(a.rotazione_id);
    }
  }
  if (nuova) {
    await ex.execute(sql`
      DELETE FROM roster_rotazione_assegnazioni
       WHERE driver_id = ${driverId}::uuid AND rotazione_id <> ${nuova.id}::uuid`);
    await ex.execute(sql`
      INSERT INTO roster_rotazione_assegnazioni (rotazione_id, week_index, driver_id)
      VALUES (${nuova.id}::uuid, ${nuova.weekIndex}, ${driverId}::uuid)
      ON CONFLICT (rotazione_id, driver_id) DO UPDATE SET week_index = EXCLUDED.week_index`);
    if (!ora.some(a => a.rotazione_id === nuova.id && Number(a.week_index) === nuova.weekIndex)) daRigenerare.add(nuova.id);
  } else {
    await ex.execute(sql`DELETE FROM roster_rotazione_assegnazioni WHERE driver_id = ${driverId}::uuid`);
  }
  return daRigenerare;
}

/** Il nome canonico di una categoria (catalogo o alias), o il testo pulito se è nuova. */
export function categoriaCanonica(v: string, categorie: Categoria[]): { nome: string; nuova: boolean } {
  const k = chiaveTesto(v);
  for (const c of categorie) {
    if (chiaveTesto(c.nome) === k || c.alias.some(a => chiaveTesto(a) === k)) return { nome: c.nome, nuova: false };
  }
  return { nome: pulisciTesto(v, 60) ?? v, nuova: true };
}

interface RigaStorico { kind: TipoStorico; value: string | null; eventDate: string; expiry: string | null }

/**
 * Applica una variazione a un conducente. Non scrive niente se trova
 * conflitti: li restituisce. La sincronizzazione delle colonne correnti la
 * fa chi chiama (sincronizzaCorrenti sui `tipi` toccati), così l'import la
 * fa una volta per tutti alla fine.
 */
export async function applicaVariazioni(
  ex: Ex, driverId: string, v: Variazioni, opz: OpzioniScrittura,
): Promise<EsitoScrittura> {
  const esito: EsitoScrittura = { cambiati: [], avvisi: [], conflitti: [], tipi: new Set(), daRigenerare: new Set() };
  const oggi = opz.oggi;
  const decorrenza = opz.decorrenza ?? oggi;
  const d = opz.riga ?? righe(await ex.execute(sql`SELECT * FROM roster_drivers WHERE id = ${driverId}::uuid FOR UPDATE`))[0];
  if (!d) { esito.conflitti.push("conducente non trovato"); return esito; }
  const ultime = opz.ultimeDate ?? await ultimeDateDi(ex, driverId);

  const sets: SQL[] = [];
  const set = (campo: string, col: string, valore: SQL) => { sets.push(sql`${sql.raw(col)} = ${valore}`); esito.cambiati.push(campo); };
  const nuoveRighe: RigaStorico[] = [];
  /** correzioni di una visita già registrata: per data, o (eventDate null) quella in vigore senza data */
  const correzioni: Array<{ kind: TipoStorico; eventDate: string | null; value: string | null; expiry: string | null }> = [];
  const dopo: Array<() => Promise<void>> = [];

  /* ── campi semplici ── */
  const semplici: Array<[keyof Variazioni, string, "testo" | "data"]> = [
    ["badge", "badge", "testo"], ["cf", "cf", "testo"],
    ["dataNascita", "data_nascita", "data"], ["dataAssunzione", "data_assunzione", "data"],
    ["dataFineServizio", "data_fine_servizio", "data"], ["motivoCessazione", "motivo_cessazione", "testo"],
    ["residenzaAnagrafica", "residenza_anagrafica", "testo"], ["cellulare", "cellulare", "testo"],
    ["telefono", "telefono", "testo"], ["inquadramento", "inquadramento", "testo"],
    ["patente", "patente", "testo"], ["patenteNumero", "patente_numero", "testo"],
    ["cqcNumero", "cqc_numero", "testo"], ["note", "note", "testo"], ["photoUrl", "photo_url", "testo"],
  ];
  for (const [campo, col, tipo] of semplici) {
    const nuovo = v[campo] as string | null | undefined;
    if (nuovo === undefined) continue;
    const corrente = tipo === "data" ? dataDi(d[col]) : testo(d[col]);
    if (!uguali(corrente, nuovo)) set(campo, col, sql`${nuovo}`);
  }

  if (v.matricola !== undefined) {
    const chiave = matricolaCanonica(v.matricola);
    if (!uguali(testo(d.matricola), v.matricola)) {
      if (chiave && chiave !== d.matricola_chiave && d.is_active && !d.is_fictitious) {
        /* finché l'indice unico non c'è (doppioni vecchi), due salvataggi
         * insieme della stessa matricola si mettono in fila qui */
        await ex.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`matricola:${chiave}`}))`);
        const altro = righe(await ex.execute(sql`
          SELECT cognome, nome, name FROM roster_drivers
           WHERE matricola_chiave = ${chiave} AND id <> ${driverId}::uuid
             AND is_active AND NOT is_fictitious LIMIT 1`))[0];
        if (altro) esito.conflitti.push(`la matricola ${v.matricola} è già di ${[altro.cognome, altro.nome].filter(Boolean).join(" ") || altro.name}`);
      }
      set("matricola", "matricola", sql`${v.matricola}`);
      sets.push(sql`matricola_chiave = ${chiave}`);
    }
  }

  if (v.cognome !== undefined || v.nome !== undefined) {
    const cognome = v.cognome !== undefined ? v.cognome : testo(d.cognome);
    const nome = v.nome !== undefined ? v.nome : testo(d.nome);
    if (v.cognome !== undefined && !uguali(testo(d.cognome), cognome)) set("cognome", "cognome", sql`${cognome}`);
    if (v.nome !== undefined && !uguali(testo(d.nome), nome)) set("nome", "nome", sql`${nome}`);
    const name = [cognome, nome].filter(Boolean).join(" ").trim();
    if (!name) esito.conflitti.push("servono cognome o nome");
    else if (name !== d.name) sets.push(sql`name = ${name}`);
  }

  if (v.parametro !== undefined) {
    if (v.parametro !== null && !(PARAMETRI as readonly number[]).includes(v.parametro)) {
      esito.conflitti.push(`parametro ${v.parametro} non ammesso (${PARAMETRI.join(", ")})`);
    } else if (!uguali(numeroDi(d.parametro), v.parametro)) set("parametro", "parametro", sql`${v.parametro}`);
  }
  if (v.ferieAnnue !== undefined && !uguali(numeroDi(d.ferie_annue), v.ferieAnnue)) {
    set("ferieAnnue", "ferie_annue", sql`${v.ferieAnnue}`);
  }
  if (v.ferieResidue !== undefined) {
    const { valore, al } = v.ferieResidue;
    if (valore !== null && !al) esito.conflitti.push("il residuo ferie va scritto con la data a cui vale");
    else if (!uguali(numeroDi(d.ferie_residue), valore) || !uguali(dataDi(d.ferie_residue_al), al)) {
      set("ferieResidue", "ferie_residue", sql`${valore}`);
      sets.push(sql`ferie_residue_al = ${valore === null ? null : al}::date`);
    }
  }
  if (v.ferieUnita !== undefined) {
    if (!(UNITA_FERIE as readonly string[]).includes(v.ferieUnita)) esito.conflitti.push("unità delle ferie non valida");
    else if (v.ferieUnita !== (d.ferie_unita ?? "giorni")) set("ferieUnita", "ferie_unita", sql`${v.ferieUnita}`);
  }
  if (v.scaglioneFerie !== undefined) {
    const s = v.scaglioneFerie === null ? null : normalizzaScaglioneFerie(v.scaglioneFerie);
    if (!uguali(testo(d.scaglione_ferie), s)) set("scaglioneFerie", "scaglione_ferie", sql`${s}`);
  }
  if (v.abilitazioni !== undefined) {
    const nuove = [...new Set(v.abilitazioni.filter(a => (ABILITAZIONI as readonly string[]).includes(a)))].sort();
    const correnti = (Array.isArray(d.abilitazioni) ? [...d.abilitazioni] : []).sort();
    if (nuove.join(",") !== correnti.join(",")) set("abilitazioni", "abilitazioni", sql`${`{${nuove.join(",")}}`}::text[]`);
  }

  /* ── campi con storico ── */
  const programmata = (tipo: string, quando: string) => {
    if (quando > oggi) esito.avvisi.push(`${tipo}: variazione programmata dal ${it(quando)}`);
  };
  const piuRecente = (kind: TipoStorico, quando: string): string | null => {
    const u = ultime.get(kind);
    return u && u > quando ? u : null;
  };
  /** Il valore di un tipo di storico in vigore a una data (la riga più recente fino a quella data). */
  const valoreAl = async (kind: TipoStorico, quando: string): Promise<{ value: string | null } | null> =>
    righe(await ex.execute(sql`
      SELECT value FROM roster_driver_history
       WHERE driver_id = ${driverId}::uuid AND kind = ${kind} AND (event_date IS NULL OR event_date <= ${quando}::date)
       ORDER BY event_date DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`))[0] ?? null;
  /** Con una decorrenza futura si confronta col valore che ci sarà allora, non con quello di oggi. */
  const diRiferimento = async (kind: TipoStorico, corrente: string | null): Promise<string | null> =>
    decorrenza > oggi ? ((await valoreAl(kind, decorrenza))?.value ?? null) : corrente;
  const storico = (campo: string, kind: TipoStorico, value: string | null, expiry: string | null, quando = decorrenza) => {
    const recente = piuRecente(kind, quando);
    if (recente) {
      esito.conflitti.push(`${campo}: lo storico ha già una variazione del ${it(recente)}, più recente del ${it(quando)}`);
      return;
    }
    nuoveRighe.push({ kind, value, eventDate: quando, expiry });
    esito.cambiati.push(campo);
    programmata(campo, quando);
  };

  let depositoNuovo: Deposito | null | undefined;
  if (v.deposito !== undefined) {
    const dep = v.deposito === null ? null : trovaDeposito(v.deposito, opz.depositi);
    if (v.deposito !== null && !dep) esito.conflitti.push(`deposito «${v.deposito}» non in elenco`);
    else if (!uguali(chiaveTesto(await diRiferimento("deposito", d.residenza_servizio ?? null) ?? ""), chiaveTesto(dep?.nome ?? ""))) {
      storico("deposito", "deposito", dep?.nome ?? null, null);
      if (decorrenza <= oggi) depositoNuovo = dep;
      else esito.avvisi.push("dal giorno del cambio di deposito ricordati di rivedere gruppo turni e rotazione riposi");
    }
  }
  if (v.categoria !== undefined) {
    const c = v.categoria === null ? null : categoriaCanonica(v.categoria, opz.categorie);
    if (!uguali(chiaveTesto(await diRiferimento("categoria", d.categoria ?? null) ?? ""), chiaveTesto(c?.nome ?? ""))) {
      if (c?.nuova && opz.puoCreareCataloghi === false) {
        esito.conflitti.push(`categoria «${c.nome}» non in elenco: la aggiunge chi ha il permesso «Personale»`);
      } else if (c?.nuova) {
        const codice = chiaveTesto(c.nome).replace(/ /g, "-") || "categoria";
        dopo.push(async () => {
          await ex.execute(sql`INSERT INTO roster_categorie (codice, nome) VALUES (${codice}, ${c.nome}) ON CONFLICT DO NOTHING`);
        });
        esito.avvisi.push(`nuova categoria «${c.nome}»`);
      }
      storico("categoria", "categoria", c?.nome ?? null, null);
    }
  }
  if (v.orarioSettimanaleMin !== undefined) {
    const nuovo = v.orarioSettimanaleMin === null ? null : formattaOrario(v.orarioSettimanaleMin);
    const prima = await diRiferimento("orario_lavoro", d.orario_settimanale_min === null || d.orario_settimanale_min === undefined
      ? null : formattaOrario(Number(d.orario_settimanale_min)));
    if (!uguali(prima, nuovo)) storico("orarioSettimanaleMin", "orario_lavoro", nuovo, null);
  }
  /* Le scadenze di patente e CQC valgono da oggi: la decorrenza della
   * scheda riguarda deposito, categoria e orario, e un rinnovo registrato
   * «da domani» resterebbe invisibile fino a domani. */
  if (v.patenteValidita !== undefined && !uguali(dataDi(d.patente_validita), v.patenteValidita)) {
    storico("patenteValidita", "patente", null, v.patenteValidita, oggi);
  }
  if (v.cqcValidita !== undefined && !uguali(dataDi(d.cqc_validita), v.cqcValidita)) {
    storico("cqcValidita", "cqc", null, v.cqcValidita, oggi);
  }
  const visite: Array<[keyof Variazioni, TipoStorico, string]> = [
    ["visitaFerrovie", "visita_ferrovie", "visita_ferrovie"],
    ["visitaMedicoCompetente", "visita_medico_competente", "visita_medico_competente"],
  ];
  for (const [campo, kind, col] of visite) {
    const nv = v[campo] as Visita | undefined;
    if (!nv) continue;
    const cor = { data: dataDi(d[`${col}_data`]), scadenza: dataDi(d[`${col}_validita`]), esito: (d[`${col}_esito`] ?? null) as EsitoVisita | null };
    const unita = {
      data: nv.data !== undefined ? nv.data : cor.data,
      scadenza: nv.scadenza !== undefined ? nv.scadenza : cor.scadenza,
      esito: nv.esito !== undefined ? nv.esito : cor.esito,
    };
    if (unita.esito !== null && !(ESITI_VISITA as readonly string[]).includes(unita.esito)) {
      esito.conflitti.push(`${campo}: esito non valido`);
      continue;
    }
    if (uguali(unita.data, cor.data) && uguali(unita.scadenza, cor.scadenza) && uguali(unita.esito, cor.esito)) continue;
    if (nv.data === null && cor.data) {
      esito.conflitti.push(`${campo}: la data della visita non si toglie; se è sbagliata, correggila`);
      continue;
    }
    if (unita.data && unita.scadenza && unita.scadenza <= unita.data) {
      esito.avvisi.push(`${campo}: la scadenza non è dopo la data della visita`);
    }
    if (!unita.data || unita.data === cor.data) {
      /* La stessa visita: si corregge la sua riga invece di aggiungerne
       * un'altra. Anche quando la data non si sa (le visite di prima non ce
       * l'hanno): inventarla con la data di oggi direbbe che c'è stata una
       * visita oggi, e poi la data vera verrebbe rifiutata come più vecchia. */
      correzioni.push({ kind, eventDate: unita.data, value: unita.esito, expiry: unita.scadenza });
      esito.cambiati.push(campo);
    } else {
      storico(campo, kind, unita.esito, unita.scadenza, unita.data);
    }
  }

  /* ── conseguenze del cambio di deposito ── */
  if (depositoNuovo !== undefined) {
    const vecchio = trovaDeposito(d.residenza_servizio, opz.depositi);
    if (d.rotazione_turni_gruppo_id && v.rotazioneTurni === undefined) {
      sets.push(sql`rotazione_turni_gruppo_id = NULL, rotazione_turni_posizione = NULL`);
      esito.cambiati.push("rotazioneTurni");
      esito.avvisi.push("gruppo della rotazione turni tolto: era del deposito di prima");
    }
    if ((vecchio?.gruppo ?? null) !== (depositoNuovo?.gruppo ?? null) && v.rotazioneRiposi === undefined) {
      const haRotazione = righe(await ex.execute(sql`
        SELECT 1 FROM roster_rotazione_assegnazioni WHERE driver_id = ${driverId}::uuid LIMIT 1`)).length > 0;
      if (haRotazione) {
        v = { ...v, rotazioneRiposi: null };
        esito.avvisi.push("rotazione riposi tolta: il nuovo deposito ha un'altra regola dei riposi (gruppo A/B)");
      }
    }
  }

  /* ── rotazione riposi ── */
  let rotazione: { id: string; weekIndex: number } | null | undefined;
  if (v.rotazioneRiposi !== undefined) {
    if (v.rotazioneRiposi === null) rotazione = null;
    else {
      const r = righe(await ex.execute(sql`
        SELECT weeks FROM roster_rotazioni_riposi WHERE id = ${v.rotazioneRiposi.id}::uuid`))[0];
      const s = v.rotazioneRiposi.scaglione;
      if (!r) esito.conflitti.push("rotazione riposi non trovata");
      else if (!Number.isInteger(s) || s < 1 || s > Number(r.weeks)) esito.conflitti.push(`scaglione ${s} fuori dalla rotazione (1–${r.weeks})`);
      else rotazione = { id: v.rotazioneRiposi.id, weekIndex: s - 1 };
    }
    /* già così: niente da fare (e niente versione nuova che fa fallire le schede aperte) */
    const ora = righe(await ex.execute(sql`
      SELECT rotazione_id, week_index FROM roster_rotazione_assegnazioni WHERE driver_id = ${driverId}::uuid`));
    if (rotazione === null && ora.length === 0) rotazione = undefined;
    if (rotazione && ora.length === 1 && ora[0].rotazione_id === rotazione.id && Number(ora[0].week_index) === rotazione.weekIndex) {
      rotazione = undefined;
    }
  }

  /* ── rotazione turni: gruppo del deposito + posizione ── */
  if (v.rotazioneTurni !== undefined) {
    if (v.rotazioneTurni === null) {
      if (d.rotazione_turni_gruppo_id || d.rotazione_turni_posizione !== null) {
        sets.push(sql`rotazione_turni_gruppo_id = NULL, rotazione_turni_posizione = NULL`);
        esito.cambiati.push("rotazioneTurni");
      }
    } else {
      const dep = depositoNuovo !== undefined ? depositoNuovo : trovaDeposito(d.residenza_servizio, opz.depositi);
      const nome = nomeGruppo(v.rotazioneTurni.gruppo);
      const pos = v.rotazioneTurni.posizione;
      if (!dep) esito.conflitti.push("per il gruppo della rotazione turni serve un deposito in elenco");
      else if (!nome) esito.conflitti.push("gruppo della rotazione turni vuoto");
      else if (pos !== null && (!Number.isInteger(pos) || pos < 1 || pos > 999)) esito.conflitti.push("posizione nella rotazione turni non valida");
      else {
        const g = righe(await ex.execute(sql`
          SELECT id FROM roster_gruppi_turni WHERE deposito_codice = ${dep.codice} AND nome = ${nome}`))[0];
        if (!g && opz.puoCreareCataloghi === false) {
          esito.conflitti.push(`gruppo turni «${nome}» non esiste: lo crea chi ha il permesso «Personale»`);
        } else if (!g || g.id !== d.rotazione_turni_gruppo_id || !uguali(numeroDi(d.rotazione_turni_posizione), pos)) {
          esito.cambiati.push("rotazioneTurni");
          if (pos !== null && g) {
            const doppio = righe(await ex.execute(sql`
              SELECT cognome, nome FROM roster_drivers
               WHERE rotazione_turni_gruppo_id = ${g.id}::uuid AND rotazione_turni_posizione = ${pos}
                 AND id <> ${driverId}::uuid AND is_active LIMIT 1`))[0];
            if (doppio) esito.avvisi.push(`la posizione ${pos} del gruppo ${nome} è anche di ${[doppio.cognome, doppio.nome].filter(Boolean).join(" ")}`);
          }
          dopo.push(async () => {
            const gid = g?.id ?? righe(await ex.execute(sql`
              INSERT INTO roster_gruppi_turni (deposito_codice, nome) VALUES (${dep.codice}, ${nome})
              ON CONFLICT (deposito_codice, nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`))[0].id;
            await ex.execute(sql`
              UPDATE roster_drivers SET rotazione_turni_gruppo_id = ${gid}::uuid, rotazione_turni_posizione = ${pos}
               WHERE id = ${driverId}::uuid`);
          });
        }
      }
    }
  }

  if (esito.conflitti.length) return esito;

  /* ── scrittura ── */
  for (const r of nuoveRighe) {
    await ex.execute(sql`
      INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note)
      VALUES (${driverId}::uuid, ${r.kind}, ${r.value}, ${r.eventDate}::date, ${r.expiry}::date, ${opz.nota ?? null})`);
    esito.tipi.add(r.kind);
  }
  for (const c of correzioni) {
    const quale = c.eventDate
      ? sql`event_date = ${c.eventDate}::date`
      : sql`(event_date IS NULL OR event_date <= ${oggi}::date)`;
    const fatte = righe(await ex.execute(sql`
      UPDATE roster_driver_history SET value = ${c.value}, expiry_date = ${c.expiry}::date,
             note = concat_ws(' · ', note, ${opz.nota ?? "corretta"}::text)
       WHERE id = (SELECT id FROM roster_driver_history
                    WHERE driver_id = ${driverId}::uuid AND kind = ${c.kind} AND ${quale}
                    ORDER BY event_date DESC NULLS LAST, created_at DESC, id DESC LIMIT 1)
       RETURNING id`));
    if (!fatte.length) {
      /* nessuna visita registrata: la prima, senza data */
      await ex.execute(sql`
        INSERT INTO roster_driver_history (driver_id, kind, value, event_date, expiry_date, note)
        VALUES (${driverId}::uuid, ${c.kind}, ${c.value}, ${c.eventDate}::date, ${c.expiry}::date, ${opz.nota ?? null})`);
    }
    esito.tipi.add(c.kind);
  }
  for (const f of dopo) await f();
  if (rotazione !== undefined) {
    for (const id of await assegnaRotazioneRiposi(ex, driverId, rotazione, oggi)) esito.daRigenerare.add(id);
    esito.cambiati.push("rotazioneRiposi");
  }
  if (sets.length || nuoveRighe.length || correzioni.length || dopo.length || rotazione !== undefined) {
    sets.push(sql`versione = versione + 1, updated_at = now()`);
    await ex.execute(sql`UPDATE roster_drivers SET ${sql.join(sets, sql`, `)} WHERE id = ${driverId}::uuid`);
  }
  esito.cambiati = [...new Set(esito.cambiati)];
  return esito;
}

/* ── Disattivazione e riattivazione ─────────────────────────────────────── */

/**
 * Un conducente che esce dal servizio: i turni assegnati da oggi in poi
 * tornano scoperti, i riposi generati dalle rotazioni si tolgono, e così le
 * sue rotazioni. Le voci manuali (malattie, ferie) restano: sono storia.
 */
export async function disattivaConducente(ex: Ex, driverId: string, oggi: string): Promise<{ turniLiberati: number }> {
  const t = await ex.execute(sql`
    DELETE FROM roster_assignments WHERE driver_id = ${driverId}::uuid AND day >= ${oggi}::date`);
  await ex.execute(sql`
    DELETE FROM roster_entries
     WHERE driver_id = ${driverId}::uuid AND source LIKE 'rotazione:%' AND day >= ${oggi}::date`);
  await ex.execute(sql`DELETE FROM roster_rotazione_assegnazioni WHERE driver_id = ${driverId}::uuid`);
  await ex.execute(sql`
    UPDATE roster_drivers SET is_active = false, rotazione_turni_gruppo_id = NULL, rotazione_turni_posizione = NULL,
           versione = versione + 1, updated_at = now()
     WHERE id = ${driverId}::uuid`);
  return { turniLiberati: t.rowCount ?? 0 };
}

export async function riattivaConducente(ex: Ex, driverId: string): Promise<string | null> {
  const d = righe(await ex.execute(sql`SELECT matricola_chiave, is_fictitious FROM roster_drivers WHERE id = ${driverId}::uuid FOR UPDATE`))[0];
  if (!d) return "conducente non trovato";
  if (d.matricola_chiave && !d.is_fictitious) {
    const altro = righe(await ex.execute(sql`
      SELECT cognome, nome FROM roster_drivers
       WHERE matricola_chiave = ${d.matricola_chiave} AND is_active AND NOT is_fictitious AND id <> ${driverId}::uuid LIMIT 1`))[0];
    if (altro) return `la stessa matricola è già di ${[altro.cognome, altro.nome].filter(Boolean).join(" ")}, attivo`;
  }
  await ex.execute(sql`
    UPDATE roster_drivers SET is_active = true, versione = versione + 1, updated_at = now() WHERE id = ${driverId}::uuid`);
  return null;
}
