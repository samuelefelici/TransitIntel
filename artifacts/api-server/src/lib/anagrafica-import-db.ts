/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANAGRAFICA — import: abbinamento, prova e applicazione
 * ───────────────────────────────────────────────────────────────────────────
 * L'anteprima e l'applicazione sono LA STESSA funzione: l'anteprima la fa
 * girare dentro una transazione che poi annulla. Così quello che mostra (chi
 * è nuovo, chi cambia e in quali campi, chi è in conflitto) è esattamente
 * quello che succederebbe, con lo stesso codice della scheda.
 *
 * L'applicazione è tutto o niente: una riga in errore o in conflitto ferma
 * tutto, e la risposta dice quali.
 *
 * Abbinamento per matricola (forma canonica), mai coi fittizi:
 *   · stessa matricola ma cognome E nome entrambi diversi (o codice fiscale
 *     diverso) → conflitto: due persone diverse, non un aggiornamento;
 *   · matricola nuova ma stesso cognome e nome di un conducente attivo →
 *     «possibile corrispondenza»: non si crea finché non si sceglie se
 *     collegarla a quel conducente o crearla comunque;
 *   · matricola di un conducente disattivato → conflitto (va riattivato prima);
 *   · fine servizio già passata: una riga nuova non si crea; un conducente
 *     attivo si disattiva solo se lo si chiede.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";
import { chiaveTesto, matricolaCanonica, trovaDeposito, type UnitaFerie } from "./anagrafica-campi";
import { leggiCorpoScheda } from "./anagrafica-scheda";
import { applicaVariazioni, categoriaCanonica, disattivaConducente, type Variazioni } from "./anagrafica-scritture";
import {
  leggiCategorie, leggiDepositi, registra, righe, sincronizzaCorrenti, TIPI_STORICO,
  type Ex, type TipoStorico,
} from "./anagrafica-store";
import type { RigaImport } from "./anagrafica-import";

export const ESCLUDI = "__escludi__";

export interface ScelteImport {
  /** valore del file → codice del deposito, o ESCLUDI */
  depositi: Record<string, string>;
  /** valore del file → nome della categoria (anche nuova), o ESCLUDI */
  categorie: Record<string, string>;
  creaNuovi: boolean;
  aggiornaEsistenti: boolean;
  disattivaCessati: boolean;
  /** numero di riga → id del conducente a cui collegarla (possibile corrispondenza) */
  collega: Record<string, string>;
  /** numeri di riga da creare anche se somigliano a un conducente esistente */
  creaComunque: number[];
  /** data a cui valgono le ferie residue, se il file non ha la colonna */
  ferieAl: string | null;
  ferieUnita: UnitaFerie;
  /** decorrenza delle variazioni con storico (deposito, categoria, orario…) */
  decorrenza: string;
  nomeFile: string;
}

export type StatoRiga =
  | "nuovo" | "aggiorna" | "invariato" | "esclusa" | "errore" | "possibile" | "saltata" | "da_disattivare" | "disattivato";

export interface EsitoRiga {
  n: number;
  matricola: string | null;
  nominativo: string;
  stato: StatoRiga;
  /** i NOMI dei campi che cambiano, mai i valori */
  campi: string[];
  messaggi: string[];
  /** per «possibile»: il conducente che somiglia */
  simile?: { id: string; nominativo: string; matricola: string | null };
}

export interface RapportoImport {
  conteggi: Record<StatoRiga, number>;
  righe: EsitoRiga[];
  daRigenerare: string[];
  applicato: boolean;
}

/** L'eccezione con cui la prova annulla la transazione portandosi dietro il rapporto. */
export class Annulla extends Error {
  constructor(public rapporto: RapportoImport) { super("annullato"); }
}

const nominativo = (cognome: unknown, nome: unknown) => [cognome, nome].filter(Boolean).join(" ");
const it = (iso: string) => iso.split("-").reverse().join("/");

export async function eseguiImport(
  ex: Ex, righeFile: RigaImport[], s: ScelteImport, opz: { oggi: string; userId: string | null; via?: string | null },
): Promise<RapportoImport> {
  const oggi = opz.oggi;
  const depositi = await leggiDepositi(ex);
  const categorie = await leggiCategorie(ex);
  const nota = `import ${s.nomeFile.slice(0, 120)}`;

  /* tutti i conducenti, bloccati: l'import è un'unica decisione su tutto l'insieme */
  const tutti = righe(await ex.execute(sql`SELECT * FROM roster_drivers ORDER BY id FOR UPDATE`));
  const ultime = new Map<string, Map<string, string | null>>();
  for (const x of righe(await ex.execute(sql`
    SELECT driver_id, kind, to_char(max(event_date), 'YYYY-MM-DD') AS ultima
      FROM roster_driver_history GROUP BY driver_id, kind`))) {
    if (!ultime.has(x.driver_id)) ultime.set(x.driver_id, new Map());
    ultime.get(x.driver_id)!.set(x.kind, x.ultima);
  }
  const rotazioni = righe(await ex.execute(sql`SELECT id, name, weeks FROM roster_rotazioni_riposi`));
  const perChiave = new Map<string, any[]>();
  const perNome = new Map<string, any[]>();
  for (const d of tutti) {
    if (d.is_fictitious) continue;
    if (d.matricola_chiave) perChiave.set(d.matricola_chiave, [...(perChiave.get(d.matricola_chiave) ?? []), d]);
    if (d.is_active) {
      const k = `${chiaveTesto(d.cognome ?? "")}|${chiaveTesto(d.nome ?? "")}`;
      perNome.set(k, [...(perNome.get(k) ?? []), d]);
    }
  }
  const perId = new Map(tutti.map(d => [d.id, d]));

  /* matricole ripetute nel file */
  const nelFile = new Map<string, number[]>();
  for (const r of righeFile) {
    const k = matricolaCanonica(r.valori.matricola);
    if (k) nelFile.set(k, [...(nelFile.get(k) ?? []), r.n]);
  }

  const rapporto: RapportoImport = {
    conteggi: { nuovo: 0, aggiorna: 0, invariato: 0, esclusa: 0, errore: 0, possibile: 0, saltata: 0, da_disattivare: 0, disattivato: 0 },
    righe: [], daRigenerare: [], applicato: false,
  };
  const toccati = new Map<TipoStorico, Set<string>>();
  const daRigenerare = new Set<string>();

  for (const r of righeFile) {
    const e: EsitoRiga = {
      n: r.n, matricola: (r.valori.matricola as string) ?? null,
      nominativo: nominativo(r.valori.cognome, r.valori.nome), stato: "errore", campi: [], messaggi: [...r.errori, ...r.avvisi],
    };
    rapporto.righe.push(e);
    const fine = (stato: StatoRiga) => { e.stato = stato; rapporto.conteggi[stato]++; };
    if (r.errori.length) { fine("errore"); continue; }
    const chiave = matricolaCanonica(r.valori.matricola);
    if (!chiave) { e.messaggi.push("manca la matricola"); fine("errore"); continue; }
    if ((nelFile.get(chiave)?.length ?? 0) > 1) {
      e.messaggi.push(`matricola ripetuta nel file (righe ${nelFile.get(chiave)!.join(", ")})`);
      fine("errore");
      continue;
    }

    /* deposito e categoria: dalle scelte, o dal catalogo se il valore lo dice da sé */
    const valori: Record<string, unknown> = { ...r.valori };
    if (r.depositoGrezzo) {
      const scelta = s.depositi[r.depositoGrezzo];
      if (scelta === ESCLUDI) { e.messaggi.push(`deposito «${r.depositoGrezzo}» escluso`); fine("esclusa"); continue; }
      const dep = scelta ? depositi.find(d => d.codice === scelta) : trovaDeposito(r.depositoGrezzo, depositi);
      if (!dep) { e.messaggi.push(`deposito «${r.depositoGrezzo}» da abbinare a uno dei depositi`); fine("errore"); continue; }
      valori.residenzaServizio = dep.nome;
    }
    if (r.categoriaGrezza) {
      const scelta = s.categorie[r.categoriaGrezza];
      if (scelta === ESCLUDI) { e.messaggi.push(`categoria «${r.categoriaGrezza}» esclusa`); fine("esclusa"); continue; }
      const c = scelta ? { nome: scelta } : categoriaCanonica(r.categoriaGrezza, categorie);
      if (!scelta && "nuova" in c && c.nuova) { e.messaggi.push(`categoria «${r.categoriaGrezza}» da abbinare (o da escludere)`); fine("errore"); continue; }
      valori.categoria = c.nome;
    }
    if (r.rotazioneRiposi) {
      const trovate = rotazioni.filter(x => chiaveTesto(x.name) === chiaveTesto(r.rotazioneRiposi!.nome));
      if (trovate.length !== 1) {
        e.messaggi.push(trovate.length ? `più rotazioni riposi si chiamano «${r.rotazioneRiposi.nome}»` : `rotazione riposi «${r.rotazioneRiposi.nome}» non trovata`);
        fine("errore");
        continue;
      }
      valori.rotazioneRiposi = { id: trovate[0].id, scaglione: r.rotazioneRiposi.scaglione };
    }
    if (valori.ferieResidue !== undefined && valori.ferieResidueAl === undefined) {
      if (!s.ferieAl) { e.messaggi.push("ferie residue senza la data a cui valgono"); fine("errore"); continue; }
      valori.ferieResidueAl = s.ferieAl;
    }
    if (valori.ferieAnnue !== undefined || valori.ferieResidue !== undefined) valori.ferieUnita = s.ferieUnita;

    /* rilettura sul server: le righe arrivano dal client */
    const corpo = leggiCorpoScheda(valori);
    if (Object.keys(corpo.errori).length) {
      e.messaggi.push(...Object.entries(corpo.errori).map(([k, m]) => `${k}: ${m}`));
      fine("errore");
      continue;
    }
    const v: Variazioni = corpo.variazioni;
    const cessato = typeof v.dataFineServizio === "string" && v.dataFineServizio < oggi;

    /* abbinamento */
    const stessi = perChiave.get(chiave) ?? [];
    const attivi = stessi.filter(x => x.is_active);
    let d: any = null;
    if (attivi.length > 1) { e.messaggi.push(`matricola presente su ${attivi.length} conducenti attivi`); fine("errore"); continue; }
    if (!attivi.length && stessi.length) {
      e.messaggi.push("matricola di un conducente disattivato: riattivalo prima dalla scheda");
      fine("errore");
      continue;
    }
    if (attivi.length === 1) {
      d = attivi[0];
      const cognomeDiverso = v.cognome && d.cognome && chiaveTesto(v.cognome) !== chiaveTesto(d.cognome);
      const nomeDiverso = v.nome && d.nome && chiaveTesto(v.nome) !== chiaveTesto(d.nome);
      const cfDiverso = v.cf && d.cf && v.cf !== d.cf;
      if ((cognomeDiverso && nomeDiverso) || cfDiverso) {
        e.messaggi.push(`la matricola ${r.valori.matricola} in anagrafica è di ${nominativo(d.cognome, d.nome) || d.name}: nel file è un'altra persona`);
        fine("errore");
        continue;
      }
    } else if (s.collega[String(r.n)]) {
      d = perId.get(s.collega[String(r.n)]);
      if (!d || !d.is_active || d.is_fictitious) { e.messaggi.push("il conducente da collegare non c'è più"); fine("errore"); continue; }
      if (d.matricola_chiave && d.matricola_chiave !== chiave) {
        e.messaggi.push(`il conducente da collegare ha già la matricola ${d.matricola}`);
        fine("errore");
        continue;
      }
    } else {
      const simili = perNome.get(`${chiaveTesto(v.cognome ?? "")}|${chiaveTesto(v.nome ?? "")}`) ?? [];
      if (simili.length && !s.creaComunque.includes(r.n)) {
        const x = simili[0];
        e.simile = { id: x.id, nominativo: nominativo(x.cognome, x.nome) || x.name, matricola: x.matricola ?? null };
        e.messaggi.push(`c'è già ${e.simile.nominativo}${x.matricola ? ` (matricola ${x.matricola})` : " senza matricola"}: è la stessa persona?`);
        fine("possibile");
        continue;
      }
    }

    if (!d) {
      if (cessato) { e.messaggi.push(`fine servizio il ${it(v.dataFineServizio as string)}: non si crea`); fine("esclusa"); continue; }
      if (!s.creaNuovi) { fine("saltata"); continue; }
      const nome = nominativo(v.cognome, v.nome);
      if (!nome) { e.messaggi.push("servono cognome o nome"); fine("errore"); continue; }
      const nuovo = righe(await ex.execute(sql`
        INSERT INTO roster_drivers (name, is_fictitious, versione, updated_at) VALUES (${nome}, false, 0, now())
        RETURNING *`))[0];
      const es = await applicaVariazioni(ex, nuovo.id, v, {
        oggi, decorrenza: s.decorrenza, nota, depositi, categorie, riga: nuovo, ultimeDate: new Map(),
      });
      if (es.conflitti.length) { e.messaggi.push(...es.conflitti); fine("errore"); continue; }
      e.messaggi.push(...es.avvisi);
      e.campi = es.cambiati;
      for (const t of es.tipi) toccati.set(t, (toccati.get(t) ?? new Set()).add(nuovo.id));
      es.daRigenerare.forEach(x => daRigenerare.add(x));
      await registra(ex, { userId: opz.userId, via: opz.via, driverId: nuovo.id, azione: "import-crea", campi: es.cambiati });
      fine("nuovo");
      continue;
    }

    if (!s.aggiornaEsistenti) { fine("saltata"); continue; }
    const es = await applicaVariazioni(ex, d.id, v, {
      oggi, decorrenza: s.decorrenza, nota, depositi, categorie, riga: d, ultimeDate: ultime.get(d.id) ?? new Map(),
    });
    if (es.conflitti.length) { e.messaggi.push(...es.conflitti); fine("errore"); continue; }
    e.messaggi.push(...es.avvisi);
    e.campi = es.cambiati;
    for (const t of es.tipi) toccati.set(t, (toccati.get(t) ?? new Set()).add(d.id));
    es.daRigenerare.forEach(x => daRigenerare.add(x));
    if (es.cambiati.length) {
      await registra(ex, { userId: opz.userId, via: opz.via, driverId: d.id, azione: "import-modifica", campi: es.cambiati });
    }
    if (cessato) {
      if (s.disattivaCessati) {
        await disattivaConducente(ex, d.id, oggi);
        await registra(ex, { userId: opz.userId, via: opz.via, driverId: d.id, azione: "import-disattiva" });
        fine("disattivato");
      } else {
        e.messaggi.push(`fine servizio il ${it(v.dataFineServizio as string)}: resta attivo finché non scegli di disattivare i cessati`);
        fine("da_disattivare");
      }
      continue;
    }
    fine(es.cambiati.length ? "aggiorna" : "invariato");
  }

  for (const tipo of TIPI_STORICO) {
    const ids = toccati.get(tipo);
    if (ids?.size) await sincronizzaCorrenti(ex, oggi, [tipo], [...ids]);
  }
  rapporto.daRigenerare = [...daRigenerare];
  await registra(ex, {
    userId: opz.userId, via: opz.via, azione: "import",
    dettaglio: { file: s.nomeFile.slice(0, 120), conteggi: rapporto.conteggi },
  });
  return rapporto;
}
