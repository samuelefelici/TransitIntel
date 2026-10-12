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
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { leggiDiario, settimaneConDati } from "./avm-diario-store.js";
import {
  calcolaControllo, inizioFinestra, spostaGiorni, ultimaSettimanaChiusa,
  type ControlloSettimanale,
} from "./avm-controllo.js";
import { salvaControllo, settimaneArchiviate } from "./avm-controllo-store.js";
import { leggiParcoOfficina, leggiInterventiAvm, parcoCredibile, type MezzoOfficina, type ParcoOfficina } from "./officina.js";
import { giornataOggi } from "./service-day.js";

/** Quante settimane all'indietro l'archivio recupera da sé. */
export const ARRETRATO_SETTIMANE = 12;

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
      const ultima = ultimaSettimanaChiusa(giornataOggi(now));
      const primo = spostaGiorni(ultima, -7 * (ARRETRATO_SETTIMANE - 1));
      const conDati = new Set(await settimaneConDati(primo));
      const fatte = await settimaneArchiviate(primo);
      const daFare = [...conDati].filter(l => l <= ultima && !fatte.has(l)).sort();
      for (const lunedi of daFare) {
        const c = await calcolaControlloDellaSettimana(lunedi, now);
        if (await salvaControllo(c)) archiviate.push(lunedi);
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
