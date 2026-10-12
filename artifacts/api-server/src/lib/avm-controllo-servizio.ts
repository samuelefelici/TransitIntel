/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL CONTROLLO SETTIMANALE DELL'AVM — calcolo e archivio automatico
 * ───────────────────────────────────────────────────────────────────────────
 * Mette insieme il diario, il parco dell'officina e gli interventi AVM di
 * FleetCare, calcola il controllo di una settimana e lo archivia.
 *
 * Il controllo «parte da solo» una volta a settimana senza una libreria di
 * cron: ogni ora il processo dell'API guarda se c'è una settimana chiusa
 * senza controllo archiviato e, se c'è, lo calcola. Il primo giro utile dopo
 * le 03:00 di lunedì (fine della giornata di esercizio della domenica)
 * archivia la settimana appena chiusa; un riavvio o un deploy al momento
 * sbagliato non fanno perdere niente, perché il giro dopo recupera. La stessa
 * cosa si può chiedere da fuori con POST /api/cron/avm-controllo-settimanale.
 *
 * Al primo avvio recupera anche le settimane passate che hanno dati nel
 * diario (fino a ARRETRATO_SETTIMANE), così l'archivio non parte vuoto.
 * Quelle istantanee portano lo stato dell'officina del giorno in cui sono
 * state calcolate, non di allora: è scritto nel controllo.
 *
 * Che cosa non si congela:
 *   · una settimana letta senza vetture, che nel diario ha righe: è una
 *     lettura fallita, non una settimana vuota, e si riprova al giro dopo;
 *   · una settimana calcolata senza FleetCare (parco o interventi non
 *     leggibili), per la settimana dopo la chiusura: si riprova ogni ora.
 *     Passata quella, si archivia lo stesso, e appena FleetCare torna
 *     leggibile l'istantanea incompleta si ricalcola e si sovrascrive;
 *   · un'istantanea calcolata con una VERSIONE_CONTROLLO più vecchia: si
 *     rifà al primo giro, anche senza FleetCare (un calcolo superato vale
 *     meno di uno incompleto, che poi si completa come sopra).
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { leggiDiario, settimaneConDati } from "./avm-diario-store.js";
import {
  calcolaControllo, inizioFinestra, spostaGiorni, ultimaSettimanaChiusa, VERSIONE_CONTROLLO,
  type ControlloSettimanale,
} from "./avm-controllo.js";
import {
  salvaControllo, settimaneArchiviate, settimaneIncomplete, settimaneVersioneVecchia,
} from "./avm-controllo-store.js";
import { leggiParcoOfficina, leggiInterventiAvm, parcoCredibile, type MezzoOfficina, type ParcoOfficina } from "./officina.js";
import { giornataOggi } from "./service-day.js";

/** Quante settimane all'indietro l'archivio recupera da sé. */
export const ARRETRATO_SETTIMANE = 12;

/** Giornate dopo la domenica in cui si aspetta FleetCare prima di archiviare senza. */
export const ATTESA_FLEETCARE_GIORNI = 7;

/** Ogni quanto si riprovano le istantanee archiviate senza FleetCare. */
const RIPROVA_INCOMPLETE_MS = 6 * 60 * 60 * 1000;
let ultimaRiprova = 0;

/** Il controllo ha letto sia il parco dell'officina sia gli interventi? */
export function controlloCompleto(c: ControlloSettimanale): boolean {
  return !!c.officina?.disponibile && !!c.fonteInterventi?.disponibile;
}

function mappaOfficina(parco: ParcoOfficina): Map<string, MezzoOfficina> | null {
  return parco.disponibile ? new Map(parco.mezzi.map(m => [m.matricola, m])) : null;
}

/** Il controllo della settimana che comincia il lunedì indicato, calcolato adesso. */
export async function calcolaControlloDellaSettimana(
  lunedi: string, now: Date = new Date(),
): Promise<ControlloSettimanale> {
  const oggi = giornataOggi(now);
  const inizio = inizioFinestra(lunedi);
  const righe = await leggiDiario(inizio, spostaGiorni(lunedi, 6));
  const parco = parcoCredibile(await leggiParcoOfficina(now.getTime()), righe.map(r => r.vehicleRef));
  const interventi = await leggiInterventiAvm(inizio, parco, now.getTime());
  const c = calcolaControllo({
    righe, lunedi, oggi,
    officina: mappaOfficina(parco),
    interventi: interventi.disponibile ? interventi.elenco : null,
    generatoIl: now.toISOString(),
  });
  return {
    ...c,
    officina: {
      disponibile: parco.disponibile, motivo: parco.motivo, tenant: parco.tenant,
      lettoAlle: parco.lettoAlle, mezzi: parco.mezzi.length,
    },
    fonteInterventi: { disponibile: interventi.disponibile, motivo: interventi.motivo },
  };
}

let inCorso: Promise<string[]> | null = null;
let ultimoEsito: { at: string; archiviate: string[]; errore: string | null } | null = null;

export function statoArchivioAutomatico() { return ultimoEsito; }

/**
 * Archivia le settimane chiuse che hanno dati nel diario e non hanno ancora
 * un controllo. Idempotente: il vincolo sulla settimana e ON CONFLICT DO
 * NOTHING tengono il primo calcolo anche con due processi. Restituisce i
 * lunedì archiviati in questo giro.
 */
export function assicuraArchivio(now: Date = new Date()): Promise<string[]> {
  if (inCorso) return inCorso;
  inCorso = (async () => {
    const archiviate: string[] = [];
    let errore: string | null = null;
    try {
      const oggi = giornataOggi(now);
      const ultima = ultimaSettimanaChiusa(oggi);
      const primo = spostaGiorni(ultima, -7 * (ARRETRATO_SETTIMANE - 1));
      const conDati = new Set(await settimaneConDati(primo));
      const fatte = await settimaneArchiviate(primo);
      const daFare = [...conDati].filter(l => l <= ultima && !fatte.has(l)).sort();
      for (const lunedi of daFare) {
        const c = await calcolaControlloDellaSettimana(lunedi, now);
        /* Righe nel diario ma nessuna vettura letta: la lettura è fallita. */
        if (c.vetture.length === 0) continue;
        /* Senza FleetCare si aspetta, finché la settimana è fresca. */
        const inAttesa = oggi <= spostaGiorni(lunedi, 6 + ATTESA_FLEETCARE_GIORNI);
        if (!controlloCompleto(c) && inAttesa) continue;
        if (await salvaControllo(c)) archiviate.push(lunedi);
      }

      /* Le istantanee archiviate senza FleetCare si rifanno quando FleetCare
       * torna leggibile, e solo se il nuovo calcolo è completo; quelle di un
       * calcolo più vecchio si rifanno comunque. */
      if (now.getTime() - ultimaRiprova >= RIPROVA_INCOMPLETE_MS) {
        ultimaRiprova = now.getTime();
        const vecchie = new Set(await settimaneVersioneVecchia(primo, VERSIONE_CONTROLLO));
        const daRifare = [...new Set([...await settimaneIncomplete(primo), ...vecchie])].sort();
        for (const lunedi of daRifare) {
          if (archiviate.includes(lunedi)) continue;
          const c = await calcolaControlloDellaSettimana(lunedi, now);
          if (c.vetture.length === 0) continue;
          if ((controlloCompleto(c) || vecchie.has(lunedi)) && await salvaControllo(c, true)) {
            archiviate.push(lunedi);
          }
        }
      }
      if (archiviate.length) {
        console.log(`[siri] controllo AVM archiviato per le settimane: ${archiviate.join(", ")}`);
      }
    } catch (e: any) {
      errore = e?.message ?? String(e);
      console.warn("[siri] archivio dei controlli AVM non aggiornato:", errore);
    }
    ultimoEsito = { at: now.toISOString(), archiviate, errore };
    return archiviate;
  })().finally(() => { inCorso = null; });
  return inCorso;
}
