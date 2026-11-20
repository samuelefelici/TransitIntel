/**
 * Che cosa ha scritto l'azienda, e che cosa le manca (tappa 6.18).
 *
 * Dalla Fase 6 tutto quello che prima era scritto nel codice per il primo
 * cliente è un dato dell'azienda, sparso in una dozzina di sezioni. Qui lo si
 * conta, voce per voce, e per ogni voce si dice dove si scrive e che cosa
 * succede se manca. Lo legge l'amministratore (GET /api/admin/installazione):
 * niente tabelle nuove, solo conteggi.
 */
import { fornitoreAvm } from "./vetture-azienda";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { leggiAzienda } from "./azienda";

/** I conteggi da cui si decide lo stato di ogni voce. */
export interface Conteggi {
  aziendaCompilata: boolean;
  provinciaIstat: boolean;
  netexCodiceLocale: boolean;
  avmRegola: boolean;
  retiUrbane: number;
  regoleLinee: number;
  gestori: number;
  fasce: number;
  titoli: number;
  categorie: number;
  supporti: number;
  /** le reti dove si paga con la carta a bordo (tappa 6.38) */
  retiCarta: number;
  comuni: number;
  luoghi: { punti_interesse: number; meteo: number; polo_lavoro: number; traffico: number; centro_urbano: number };
  nodiScambio: number;
  depositi: number;
  puntiDiCambio: number;
  puntiSenzaFermate: number;
  autoAziendali: number | null;
  /** le paline della transcodifica dell'AVM (tappa 6.20) */
  paline: number;
  /** l'anagrafica dei mezzi e i prefissi delle consorziate nel canale dell'AVM (tappa 6.21) */
  parcoVetture: number;
  consorziate: number;
}

export type StatoVoce = "compilata" | "da_compilare" | "facoltativa";

export interface Voce {
  voce: string;
  titolo: string;
  /** compilata; da_compilare: serve, e manca; facoltativa: manca, e va bene così se non serve */
  stato: StatoVoce;
  /** quello che c'è, in parole: «7 depositi» */
  dettaglio: string;
  /** che cosa succede finché manca */
  seManca: string;
  /** un avviso anche se la voce è compilata (per esempio un punto di cambio senza fermate) */
  avviso: string | null;
  /** dove si scrive: la pagina e, nella pagina Azienda, la sezione */
  dove: { pagina: string; sezione: string | null; etichetta: string };
}

const nr = (n: number, uno: string, tanti: string) => (n === 1 ? `1 ${uno}` : `${n.toLocaleString("it-IT")} ${tanti}`);
const AZIENDA = "/admin/azienda";
const inAzienda = (sezione: string, etichetta: string) => ({ pagina: AZIENDA, sezione, etichetta: `Azienda › ${etichetta}` });

/**
 * Le voci, nell'ordine in cui conviene compilarle. `necessaria`: senza, una
 * parte dell'applicazione lavora male (non solo con meno dettaglio).
 */
export function vociDellInstallazione(c: Conteggi): Voce[] {
  const voce = (v: Omit<Voce, "stato" | "avviso"> & { compilata: boolean; necessaria: boolean; avviso?: string | null }): Voce => ({
    voce: v.voce, titolo: v.titolo, dettaglio: v.dettaglio, seManca: v.seManca, dove: v.dove,
    stato: v.compilata ? "compilata" : v.necessaria ? "da_compilare" : "facoltativa",
    avviso: v.avviso ?? null,
  });
  return [
    voce({
      voce: "azienda", titolo: "Nome, città e centro delle mappe", compilata: c.aziendaCompilata, necessaria: true,
      dettaglio: c.aziendaCompilata ? "scritti" : "non scritti",
      seManca: "Pagine e stampe senza il nome dell'azienda, mappe aperte sull'Italia, GTFS con l'agenzia «azienda».",
      dove: inAzienda("azienda-identita", "Identità"),
    }),
    voce({
      voce: "reti", titolo: "Reti urbane e regole delle linee", compilata: c.retiUrbane > 0 || c.regoleLinee > 0, necessaria: true,
      dettaglio: `${nr(c.retiUrbane, "rete urbana", "reti urbane")}, ${nr(c.regoleLinee, "regola", "regole")}`,
      seManca: "Tutte le linee sono extraurbane: le tariffe urbane non si applicano e nel Roster il riposo fra due turni è quello dell'extraurbano. Va bene solo per un servizio tutto extraurbano.",
      dove: inAzienda("azienda-reti", "Reti e linee"),
    }),
    voce({
      voce: "gestori", titolo: "Gestori delle linee", compilata: c.gestori > 0, necessaria: false,
      dettaglio: nr(c.gestori, "gestore", "gestori"),
      seManca: "Nei GTFS e nel NeTEx l'agenzia di tutte le linee è l'azienda. Servono a chi programma per più aziende.",
      dove: inAzienda("azienda-gestori", "Gestori"),
    }),
    voce({
      voce: "depositi", titolo: "Depositi", compilata: c.depositi > 0, necessaria: true,
      dettaglio: nr(c.depositi, "deposito", "depositi"),
      seManca: "Anagrafica e Roster non hanno depositi a cui assegnare i conducenti.",
      dove: inAzienda("azienda-depositi", "Depositi"),
    }),
    voce({
      voce: "fasce", titolo: "Fasce chilometriche dell'extraurbano", compilata: c.fasce > 0, necessaria: true,
      dettaglio: nr(c.fasce, "fascia", "fasce"),
      seManca: "Le tariffe extraurbane non hanno prezzi.",
      dove: inAzienda("azienda-fasce", "Fasce chilometriche"),
    }),
    voce({
      voce: "titoli", titolo: "Catalogo dei titoli di viaggio", compilata: c.titoli > 0, necessaria: true,
      dettaglio: nr(c.titoli, "titolo", "titoli"),
      seManca: "Nelle Tariffe un feed nuovo non ha biglietti né abbonamenti da cui partire.",
      dove: inAzienda("azienda-titoli", "Catalogo dei titoli"),
    }),
    voce({
      voce: "elenchi", titolo: "Categorie di passeggero e supporti", compilata: c.categorie > 0 && c.supporti > 0, necessaria: true,
      dettaglio: `${nr(c.categorie, "categoria", "categorie")}, ${nr(c.supporti, "supporto", "supporti")}`,
      seManca: "Un feed nuovo delle tariffe parte senza categorie di passeggero o senza supporti.",
      dove: inAzienda("azienda-elenchi", "Tariffe: elenchi di partenza"),
    }),
    voce({
      voce: "carta", titolo: "Pagamento con carta a bordo", compilata: c.retiCarta > 0, necessaria: false,
      dettaglio: c.retiCarta > 0 ? `attivo su ${nr(c.retiCarta, "rete", "reti")}` : "non attivo",
      seManca: "Il GTFS non dice che si può salire pagando con la carta bancaria. Serve solo dove il sistema di bigliettazione lo permette.",
      dove: inAzienda("azienda-carta", "Pagamento con carta a bordo"),
    }),
    voce({
      voce: "provincia", titolo: "Provincia ISTAT", compilata: c.provinciaIstat, necessaria: true,
      dettaglio: c.provinciaIstat ? "scritta" : "non scritta",
      seManca: "L'import del pendolarismo ISTAT si ferma con un messaggio.",
      dove: inAzienda("azienda-luogo", "Territorio"),
    }),
    voce({
      voce: "comuni", titolo: "Comuni del territorio", compilata: c.comuni > 0, necessaria: true,
      dettaglio: nr(c.comuni, "comune", "comuni"),
      seManca: "L'import della popolazione non ha comuni da leggere, e l'analisi della rete scrive «Comune 042002» invece del nome.",
      dove: inAzienda("azienda-territorio", "Comuni"),
    }),
    voce({
      voce: "punti-interesse", titolo: "Dove cercare i punti d'interesse", compilata: c.luoghi.punti_interesse > 0, necessaria: true,
      dettaglio: nr(c.luoghi.punti_interesse, "luogo", "luoghi"),
      seManca: "La ricerca di scuole, ospedali e negozi si ferma prima di cominciare.",
      dove: inAzienda("azienda-territorio", "Luoghi di riferimento"),
    }),
    voce({
      voce: "meteo", titolo: "Punti del meteo", compilata: c.luoghi.meteo > 0, necessaria: false,
      dettaglio: nr(c.luoghi.meteo, "punto", "punti"),
      seManca: "Niente meteo, e niente confronto fra meteo e traffico.",
      dove: inAzienda("azienda-territorio", "Luoghi di riferimento"),
    }),
    voce({
      voce: "poli-lavoro", titolo: "Poli di lavoro e commercio", compilata: c.luoghi.polo_lavoro > 0, necessaria: false,
      dettaglio: nr(c.luoghi.polo_lavoro, "polo", "poli"),
      seManca: "L'analisi di uffici e zone industriali conta solo i punti d'interesse trovati sulle mappe.",
      dove: inAzienda("azienda-territorio", "Luoghi di riferimento"),
    }),
    voce({
      voce: "traffico", titolo: "Punti stradali del traffico", compilata: c.luoghi.traffico > 0, necessaria: false,
      dettaglio: nr(c.luoghi.traffico, "punto", "punti"),
      seManca: "Non si legge il traffico: la pagina Traffico mostra solo il modello teorico.",
      dove: inAzienda("azienda-territorio", "Luoghi di riferimento"),
    }),
    voce({
      voce: "centri-urbani", titolo: "Centri urbani del modello del traffico", compilata: c.luoghi.centro_urbano > 0, necessaria: false,
      dettaglio: nr(c.luoghi.centro_urbano, "centro", "centri"),
      seManca: "Il modello del traffico misura la distanza dal centro delle mappe.",
      dove: inAzienda("azienda-territorio", "Luoghi di riferimento"),
    }),
    voce({
      voce: "nodi-scambio", titolo: "Nodi di scambio", compilata: c.nodiScambio > 0, necessaria: false,
      dettaglio: nr(c.nodiScambio, "nodo", "nodi"),
      seManca: "L'analisi intermodale trova da sola solo le stazioni dai nomi delle fermate, e l'elenco dei nodi delle zone di coincidenza è vuoto.",
      dove: inAzienda("azienda-nodi", "Nodi di scambio"),
    }),
    voce({
      voce: "punti-cambio", titolo: "Punti di cambio dei turni guida", compilata: c.puntiDiCambio > 0, necessaria: true,
      dettaglio: nr(c.puntiDiCambio, "punto", "punti"),
      seManca: "I turni guida non danno il cambio in linea.",
      avviso: c.puntiSenzaFermate > 0
        ? `${nr(c.puntiSenzaFermate, "punto non ha", "punti non hanno")} fermate: nessuno dei due calcoli dei turni guida li riconosce.`
        : null,
      dove: { pagina: "/planning-studio", sezione: null, etichetta: "Planning Studio › editor della rete › Nodi di cambio" },
    }),
    voce({
      voce: "auto-aziendali", titolo: "Auto aziendali", compilata: c.autoAziendali != null, necessaria: false,
      dettaglio: c.autoAziendali != null ? nr(c.autoAziendali, "auto", "auto") : "non scritte",
      seManca: "I turni guida contano 5 auto per portare i conducenti fra deposito e punti di cambio.",
      dove: { pagina: "/admin/parametri", sezione: null, etichetta: "Parametri di esercizio" },
    }),
    voce({
      voce: "avm", titolo: "Le vetture dell'azienda nell'AVM", compilata: c.avmRegola, necessaria: false,
      dettaglio: c.avmRegola ? "regola scritta" : "nessuna regola",
      seManca: "Tutte le vetture del canale AVM contano come dell'azienda: va bene se il canale non porta vetture di altre aziende.",
      dove: inAzienda("azienda-avm", "AVM: le vetture dell'azienda"),
    }),
    voce({
      voce: "parco", titolo: "Anagrafica dei mezzi e consorziate nell'AVM", compilata: c.parcoVetture > 0, necessaria: false,
      dettaglio: `${nr(c.parcoVetture, "mezzo", "mezzi")}, ${nr(c.consorziate, "prefisso di consorziata", "prefissi di consorziate")}`,
      seManca: "Le matricole del canale AVM si vedono senza la descrizione del mezzo, e quelle delle consorziate non si attribuiscono a nessuna azienda.",
      dove: inAzienda("azienda-parco", "AVM: consorziate e mezzi"),
    }),
    voce({
      voce: "paline", titolo: "Transcodifica delle paline dell'AVM", compilata: c.paline > 0, necessaria: false,
      dettaglio: c.paline > 0 ? nr(c.paline, "palina", "paline") : "non importata",
      seManca: "Le fermate dell'AVM si agganciano al feed solo per codice o per nome: dove le due numerazioni si sovrappongono, la fermata è sbagliata. Va bene se l'AVM usa gli stessi codici del feed.",
      dove: { pagina: "/data", sezione: null, etichetta: `Dati & GTFS › Paline ${fornitoreAvm().breve}` },
    }),
    voce({
      voce: "netex", titolo: "Codice locale NeTEx", compilata: c.netexCodiceLocale, necessaria: false,
      dettaglio: c.netexCodiceLocale ? "scritto" : "non scritto",
      seManca: "Il NeTEx per il NAP non si esporta. Serve solo se la Regione lo chiede.",
      dove: inAzienda("azienda-netex", "NeTEx per il NAP"),
    }),
  ];
}

/** I conteggi dal database, in una lettura. */
export async function conteggiDellInstallazione(): Promise<Conteggi> {
  const azienda = await leggiAzienda();
  const r = (await db.execute<any>(sql`
    SELECT
      (SELECT count(*) FROM reti WHERE tipo = 'urbano')::int AS reti_urbane,
      (SELECT count(*) FROM reti_regole)::int AS regole,
      (SELECT count(*) FROM gestori)::int AS gestori,
      (SELECT count(*) FROM fasce_km)::int AS fasce,
      (SELECT count(*) FROM titoli_catalogo)::int AS titoli,
      (SELECT count(*) FROM categorie_catalogo)::int AS categorie,
      (SELECT count(*) FROM supporti_catalogo)::int AS supporti,
      (SELECT count(*) FROM contactless_reti)::int AS reti_carta,
      (SELECT count(*) FROM territorio_comuni)::int AS comuni,
      (SELECT coalesce(jsonb_object_agg(uso, n), '{}'::jsonb)
         FROM (SELECT uso, count(*)::int AS n FROM territorio_luoghi GROUP BY uso) l) AS luoghi,
      (SELECT count(*) FROM nodi_scambio)::int AS nodi,
      (SELECT count(*) FROM roster_depositi)::int AS depositi,
      (SELECT count(*) FROM stop_clusters)::int AS punti,
      (SELECT count(*) FROM stop_clusters c
        WHERE NOT EXISTS (SELECT 1 FROM stop_cluster_stops s WHERE s.cluster_id = c.id))::int AS punti_senza_fermate,
      (SELECT value FROM app_settings WHERE key = 'company_cars') AS auto,
      (SELECT count(*) FROM transcodifica_paline)::int AS paline,
      (SELECT count(*) FROM parco_vetture)::int AS parco_vetture,
      (SELECT count(*) FROM parco_consorziate)::int AS consorziate`)).rows[0] ?? {};
  const luoghi = (r.luoghi ?? {}) as Record<string, number>;
  const auto = r.auto == null ? null : Number(r.auto);
  return {
    aziendaCompilata: azienda.compilata,
    provinciaIstat: azienda.provinciaIstat != null,
    netexCodiceLocale: azienda.netexCodiceLocale != null,
    avmRegola: azienda.avmMatricolaCifre != null,
    retiUrbane: Number(r.reti_urbane ?? 0), regoleLinee: Number(r.regole ?? 0), gestori: Number(r.gestori ?? 0),
    fasce: Number(r.fasce ?? 0), titoli: Number(r.titoli ?? 0), categorie: Number(r.categorie ?? 0), supporti: Number(r.supporti ?? 0),
    retiCarta: Number(r.reti_carta ?? 0),
    comuni: Number(r.comuni ?? 0),
    luoghi: {
      punti_interesse: Number(luoghi.punti_interesse ?? 0), meteo: Number(luoghi.meteo ?? 0), polo_lavoro: Number(luoghi.polo_lavoro ?? 0),
      traffico: Number(luoghi.traffico ?? 0), centro_urbano: Number(luoghi.centro_urbano ?? 0),
    },
    nodiScambio: Number(r.nodi ?? 0), depositi: Number(r.depositi ?? 0),
    puntiDiCambio: Number(r.punti ?? 0), puntiSenzaFermate: Number(r.punti_senza_fermate ?? 0),
    autoAziendali: auto != null && Number.isFinite(auto) ? auto : null,
    paline: Number(r.paline ?? 0),
    parcoVetture: Number(r.parco_vetture ?? 0), consorziate: Number(r.consorziate ?? 0),
  };
}

/** Lo stato per la pagina dell'amministratore. */
export async function statoDellInstallazione(): Promise<{ voci: Voce[]; daCompilare: number; facoltativeVuote: number }> {
  const voci = vociDellInstallazione(await conteggiDellInstallazione());
  return {
    voci,
    daCompilare: voci.filter((v) => v.stato === "da_compilare").length,
    facoltativeVuote: voci.filter((v) => v.stato === "facoltativa").length,
  };
}
