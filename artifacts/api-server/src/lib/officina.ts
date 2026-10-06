/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL PARCO DELL'OFFICINA — che cosa FleetCare sa delle vetture dell'AVM
 * ───────────────────────────────────────────────────────────────────────────
 * L'AVM vede le vetture col numero che le dà il centro Mizar e non sa
 * nient'altro. Una vettura che tace da due anni può essere un apparato
 * guasto o un mezzo venduto; una che tace da tre giorni può avere l'antenna
 * rotta o essere ferma in officina con la commessa aperta. L'officina lo sa,
 * e FleetCare lo tiene nello stesso database, nello schema `fleetcare`.
 *
 * Il collegamento è la funzione `fleetcare.parco_per_avm()` (migration 0073
 * di FleetCare): sola lettura, SECURITY DEFINER, il «contratto esplicito»
 * dell'ADR 0002 di FleetCare. Cerbero non legge le tabelle di FleetCare e
 * non ci scrive: chiama la funzione e basta.
 *
 * La chiave d'incrocio è il numero di parco: FleetCare scrive «0010», SIRI
 * pubblica «10». Le consorziate, se un giorno ci saranno, passano dalla
 * transcodifica di `parco-anagrafica.ts`.
 *
 * Se la funzione non c'è (FleetCare non aggiornato) o il ruolo non la può
 * chiamare, il parco risulta «non disponibile» con il motivo scritto: l'AVM
 * continua a funzionare come prima, senza i dati dell'officina.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { siriDaCodice } from "./parco-anagrafica.js";

/** Lo stato del mezzo per l'officina, nel vocabolario dell'AVM. */
export type StatoOfficina = "in_servizio" | "riserva" | "in_officina" | "dismesso";

export interface MezzoOfficina {
  /** la matricola come la pubblica SIRI */
  matricola: string;
  /** il numero di parco come lo scrive FleetCare («0010») */
  numeroDiParco: string;
  targa: string;
  stato: StatoOfficina;
  deposito: string | null;
  modello: string | null;
  /** da quando è fermo, se è fermo (ISO) */
  fermoDal: string | null;
  fermoMotivo: string | null;
  commessa: string | null;
  /** la prima segnalazione dell'apparato AVM ancora aperta, se c'è */
  segnalazioneAvm: { numero: string; fonte: string; dal: string | null } | null;
}

export interface ParcoOfficina {
  disponibile: boolean;
  /** perché non è disponibile, scritto per chi legge la pagina */
  motivo: string | null;
  tenant: string | null;
  lettoAlle: string;
  mezzi: MezzoOfficina[];
}

/** Una riga di `fleetcare.parco_per_avm()`. */
export interface RigaParcoAvm {
  tenant: string;
  fleet_number: string;
  plate: string;
  status: string;
  deposito: string | null;
  modello: string | null;
  fermo_dal: string | Date | null;
  fermo_motivo: string | null;
  commessa: string | null;
  segnalazione_avm: string | null;
  segnalazione_avm_fonte: string | null;
  segnalazione_avm_dal: string | Date | null;
}

const STATI: Record<string, StatoOfficina> = {
  in_service: "in_servizio",
  reserve: "riserva",
  maintenance: "in_officina",
  grounded: "in_officina",
  decommissioned: "dismesso",
};

export const ETICHETTE_STATO_OFFICINA: Record<StatoOfficina, string> = {
  in_servizio: "in servizio",
  riserva: "di riserva",
  in_officina: "ferma in officina",
  dismesso: "dismessa",
};

/**
 * Dal numero di parco di FleetCare alla matricola SIRI. «0010» → «10»,
 * «1372» → «1372»; un codice con le lettere passa dalla transcodifica
 * FlashNet («CJ096» → «11096»). `null` se non si può dire.
 */
export function matricolaDaNumeroDiParco(numero: string): string | null {
  const n = numero.trim().toUpperCase();
  if (!n) return null;
  if (/^\d+$/.test(n)) return n.replace(/^0+(?=\d)/, "");
  return siriDaCodice(n);
}

function iso(x: string | Date | null): string | null {
  if (x == null) return null;
  const d = x instanceof Date ? x : new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Il parco dalle righe della funzione: sceglie il tenant e traduce le righe.
 *
 * Il tenant: quello chiesto (`FLEETCARE_TENANT`), oppure l'unico che c'è.
 * Con più tenant e nessuna indicazione non si sceglie a caso: si dice
 * quale impostare.
 */
export function costruisciParco(
  righe: RigaParcoAvm[], tenantVoluto: string | null | undefined, lettoAlle: string,
): ParcoOfficina {
  const tenants = [...new Set(righe.map(r => r.tenant))].sort();
  const vuoto = (motivo: string, tenant: string | null = null): ParcoOfficina =>
    ({ disponibile: false, motivo, tenant, lettoAlle, mezzi: [] });

  if (tenants.length === 0) return vuoto("FleetCare non ha ancora nessun mezzo.");
  let tenant: string;
  if (tenantVoluto) {
    if (!tenants.includes(tenantVoluto)) {
      return vuoto(`FLEETCARE_TENANT vale «${tenantVoluto}», ma FleetCare ha solo: ${tenants.join(", ")}.`);
    }
    tenant = tenantVoluto;
  } else if (tenants.length === 1) {
    tenant = tenants[0];
  } else {
    return vuoto(`FleetCare ha più aziende (${tenants.join(", ")}): impostare FLEETCARE_TENANT `
      + "sull'API di Cerbero con quella giusta.");
  }

  const mezzi: MezzoOfficina[] = [];
  for (const r of righe) {
    if (r.tenant !== tenant) continue;
    const matricola = matricolaDaNumeroDiParco(r.fleet_number);
    if (!matricola) continue;
    mezzi.push({
      matricola,
      numeroDiParco: r.fleet_number,
      targa: r.plate,
      stato: STATI[r.status] ?? "in_servizio",
      deposito: r.deposito,
      modello: r.modello,
      fermoDal: iso(r.fermo_dal),
      fermoMotivo: r.fermo_motivo,
      commessa: r.commessa,
      segnalazioneAvm: r.segnalazione_avm
        ? { numero: r.segnalazione_avm, fonte: r.segnalazione_avm_fonte ?? "", dal: iso(r.segnalazione_avm_dal) }
        : null,
    });
  }
  return { disponibile: true, motivo: null, tenant, lettoAlle, mezzi };
}

/**
 * I mezzi dell'officina che l'AVM non ha mai visto: in servizio, di riserva
 * o fermi, ma senza una matricola nel flusso SIRI. Sono le vetture da far
 * censire o attrezzare a Mizar. I dismessi non contano.
 */
export function mezziSenzaAvm(parco: ParcoOfficina, matricoleSiri: Iterable<string>): MezzoOfficina[] {
  if (!parco.disponibile) return [];
  const viste = new Set(matricoleSiri);
  return parco.mezzi
    .filter(m => m.stato !== "dismesso" && !viste.has(m.matricola))
    .sort((a, b) => a.matricola.localeCompare(b.matricola, undefined, { numeric: true }));
}

/**
 * Quota minima delle matricole Conerobus di SIRI che il parco dell'officina
 * deve contenere per essere creduto. Sul confronto del 6/10/2026 era 228 su
 * 277, l'82%.
 */
export const QUOTA_PARCO_CREDIBILE = 0.5;

/**
 * Il parco dell'officina si usa solo se somiglia al parco che l'AVM vede.
 *
 * Il rischio è silenzioso: un tenant sbagliato, o un FleetCare con i dati di
 * prova, farebbe risultare «fuori parco» quasi tutte le vetture vere, e le
 * toglierebbe dalle segnalazioni senza che nessuno se ne accorga. Sotto
 * metà delle matricole Conerobus riconosciute, il parco risulta non
 * disponibile e la pagina dice perché.
 */
export function parcoCredibile(parco: ParcoOfficina, matricoleSiri: Iterable<string>): ParcoOfficina {
  if (!parco.disponibile) return parco;
  const conerobus = [...new Set(matricoleSiri)].filter(m => /^\d{1,4}$/.test(m));
  if (conerobus.length === 0) return parco;
  const nelParco = new Set(parco.mezzi.map(m => m.matricola));
  const trovate = conerobus.filter(m => nelParco.has(m)).length;
  if (trovate / conerobus.length >= QUOTA_PARCO_CREDIBILE) return parco;
  return {
    ...parco,
    disponibile: false,
    motivo: `Il parco FleetCare${parco.tenant ? ` («${parco.tenant}»)` : ""} contiene solo ${trovate} delle `
      + `${conerobus.length} matricole Conerobus che vede l'AVM: non sembra lo stesso parco. `
      + "Controllare FLEETCARE_TENANT o i mezzi caricati in FleetCare.",
    mezzi: [],
  };
}

/* ── Lettura, con una cache breve ─────────────────────────────────────────
 * Il parco dell'officina cambia nell'ordine delle ore; il diario si apre
 * qualche volta al giorno. Dieci minuti risparmiano la query a chi ricarica
 * la pagina senza far vedere un fermo chiuso stamattina come ancora aperto. */
const DURATA_CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; parco: ParcoOfficina } | null = null;

function motivoErrore(e: any): string {
  const codice = e?.code ?? e?.cause?.code;
  if (codice === "42883" || codice === "3F000") {
    return "FleetCare non espone ancora il parco per l'AVM: serve la sua migrazione "
      + "0073 (fleetcare.parco_per_avm), che si applica al prossimo avvio di FleetCare.";
  }
  if (codice === "42501") {
    return "Il ruolo del database di Cerbero non può chiamare fleetcare.parco_per_avm(): "
      + "la migrazione 0073 di FleetCare concede il permesso al proprietario di public.depots.";
  }
  return `Lettura del parco FleetCare fallita: ${e?.message ?? String(e)}`;
}

export async function leggiParcoOfficina(now = Date.now()): Promise<ParcoOfficina> {
  if (cache && now - cache.at < DURATA_CACHE_MS) return cache.parco;
  const lettoAlle = new Date(now).toISOString();
  let parco: ParcoOfficina;
  try {
    const r = await db.execute(sql`select * from fleetcare.parco_per_avm()`);
    const righe = ((r as any).rows ?? r) as RigaParcoAvm[];
    parco = costruisciParco(righe, process.env.FLEETCARE_TENANT?.trim() || null, lettoAlle);
  } catch (e) {
    parco = { disponibile: false, motivo: motivoErrore(e), tenant: null, lettoAlle, mezzi: [] };
  }
  cache = { at: now, parco };
  return parco;
}
