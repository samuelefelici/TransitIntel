/**
 * L'azienda che usa questa installazione (PR 2.17a, migrazione 0014).
 *
 * I dati dell'azienda erano scritti nel codice («Conerobus S.p.A.» nei GTFS,
 * «Ancona» nelle parole vietate delle password, il centro delle mappe). Ora
 * stanno in public.azienda, una riga sola, e li cambia l'amministratore da
 * Amministrazione › Azienda.
 *
 * - Una installazione, un'azienda: non è un elenco di aziende, e non c'è un
 *   «tenant» da filtrare.
 * - Tabella vuota = installazione nuova, ancora da compilare: valgono i valori
 *   neutri di AZIENDA_DA_COMPILARE, mai quelli di un'altra azienda.
 * - Chi legge passa da qui (leggiAzienda): la riga cambia di rado, quindi
 *   resta in memoria per un minuto. Chi salva la fa rileggere subito.
 * - Sono dati dell'azienda, non di persone: li legge chiunque sia entrato
 *   (arrivano con /api/auth/me), li scrive solo l'amministratore.
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface Azienda {
  /** il nome per esteso: «Conerobus S.p.A.» */
  ragioneSociale: string;
  /** il nome corto, quello che si dice: «Conerobus» */
  nome: string;
  sito: string | null;
  telefono: string | null;
  /** l'agency_id dei GTFS esportati */
  gtfsAgencyId: string;
  /** la città principale del servizio */
  citta: string | null;
  regione: string | null;
  /** dove si aprono le mappe di tutta la rete */
  centro: { lat: number; lng: number; zoom: number };
  /** false finché la tabella è vuota: l'amministratore non ha ancora compilato la pagina */
  compilata: boolean;
}

/** I valori di un'installazione nuova: neutri, e il centro sull'Italia. */
export const AZIENDA_DA_COMPILARE: Azienda = Object.freeze({
  ragioneSociale: "Azienda di trasporto",
  nome: "Azienda",
  sito: null,
  telefono: null,
  gtfsAgencyId: "azienda",
  citta: null,
  regione: null,
  centro: Object.freeze({ lat: 42.5, lng: 12.5, zoom: 5.5 }),
  compilata: false,
});

/* ── Quello che l'amministratore può salvare ──────────────────────────────── */

/** Un testo di una riga: senza caratteri di controllo, spazi ai lati tolti. */
const riga = (max: number) => z.string().transform(s => s.trim()).pipe(
  z.string().min(1, "non può essere vuoto").max(max, `al più ${max} caratteri`)
    .regex(/^[^\u0000-\u001f\u007f]*$/, "non può contenere caratteri di controllo"));

/** Un campo facoltativo: vuoto o assente vuol dire «nessuno». */
const facoltativo = <T extends z.ZodTypeAny>(tipo: T) =>
  z.preprocess(v => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? null : v), tipo.nullable());

/** Gli stessi limiti dei vincoli della tabella (migrazione 0014): qui si dice in chiaro quale campo non va. */
export const DatiAzienda = z.object({
  ragioneSociale: riga(120),
  nome: riga(40),
  /* solo http e https, senza spazi, virgole e virgolette: finisce in un CSV e in un link */
  sito: facoltativo(z.string().trim().regex(/^https?:\/\/[^\s",<>]{1,200}$/, "deve cominciare con http:// o https://, senza spazi né virgole")
    .refine(s => { try { return !!new URL(s).hostname; } catch { return false; } }, "non è un indirizzo valido")),
  telefono: facoltativo(z.string().trim().regex(/^[0-9+() ./-]{3,40}$/, "solo cifre, spazi e + ( ) . / -")),
  gtfsAgencyId: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,40}$/, "solo lettere, cifre e . _ - (al più 40)"),
  citta: riga(60),
  regione: facoltativo(riga(60)),
  centroLat: z.number().min(-90).max(90),
  centroLng: z.number().min(-180).max(180),
  zoom: z.number().min(3).max(18),
}).strict();
export type DatiAzienda = z.infer<typeof DatiAzienda>;

/** I messaggi di una validazione fallita, uno per campo, con il nome che si legge nella pagina. */
const NOMI_CAMPI: Readonly<Record<string, string>> = {
  ragioneSociale: "Ragione sociale", nome: "Nome", sito: "Sito", telefono: "Telefono", gtfsAgencyId: "Identificativo GTFS",
  citta: "Città", regione: "Regione", centroLat: "Latitudine", centroLng: "Longitudine", zoom: "Zoom",
};
export function erroriDiValidazione(e: z.ZodError): string {
  const estranei = e.issues.filter(i => i.code === "unrecognized_keys").flatMap((i: any) => (i.keys as string[]).map(k => String(k).slice(0, 40)));
  if (estranei.length) return `Campo non previsto: ${estranei.slice(0, 5).join(", ")}`;
  /* un messaggio per campo: il primo che dice che cosa non va */
  const visti = new Set<string>();
  return e.issues.filter(i => { const c = String(i.path[0] ?? ""); if (visti.has(c)) return false; visti.add(c); return true; })
    .slice(0, 6).map(i => `${NOMI_CAMPI[String(i.path[0])] ?? "Richiesta"}: ${i.message}`).join("; ");
}

/* ── Lettura, con la memoria di un minuto ─────────────────────────────────── */

const DURATA_MS = 60_000;
let inMemoria: { azienda: Azienda; lettaIl: number } | null = null;

function daRiga(r: any): Azienda {
  return {
    ragioneSociale: String(r.ragione_sociale),
    nome: String(r.nome),
    sito: r.sito ?? null,
    telefono: r.telefono ?? null,
    gtfsAgencyId: String(r.gtfs_agency_id),
    citta: r.citta ?? null,
    regione: r.regione ?? null,
    centro: { lat: Number(r.centro_lat), lng: Number(r.centro_lng), zoom: Number(r.zoom) },
    compilata: true,
  };
}

/**
 * I dati dell'azienda. Se il database non risponde e in memoria c'è una
 * lettura precedente vale quella; senza, l'errore sale a chi ha chiesto: un
 * GTFS non deve uscire con un nome inventato.
 */
export async function leggiAzienda(): Promise<Azienda> {
  if (inMemoria && Date.now() - inMemoria.lettaIl < DURATA_MS) return inMemoria.azienda;
  try {
    const r = await db.execute<any>(sql`
      SELECT ragione_sociale, nome, sito, telefono, gtfs_agency_id, citta, regione, centro_lat, centro_lng, zoom
        FROM azienda WHERE unica`);
    const riga = r.rows?.[0];
    inMemoria = { azienda: riga ? daRiga(riga) : AZIENDA_DA_COMPILARE, lettaIl: Date.now() };
    return inMemoria.azienda;
  } catch (e) {
    if (inMemoria) return inMemoria.azienda;
    throw e;
  }
}

/**
 * Per le etichette e per le regole che non devono fermare una richiesta: se
 * il database non risponde e non c'è niente in memoria, i valori neutri.
 */
export async function aziendaOppureNeutra(): Promise<Azienda> {
  try { return await leggiAzienda(); } catch { return AZIENDA_DA_COMPILARE; }
}

/** Fa rileggere la riga alla prossima richiesta (dopo un salvataggio, e nei test). */
export function dimenticaAzienda(): void { inMemoria = null; }

/* ── La pagina dell'amministratore ────────────────────────────────────────── */

export interface DettaglioAzienda { azienda: Azienda; aggiornataIl: string | null; aggiornataDa: string | null }

/** La riga com'è nel database, con quando è stata salvata e da chi (nome o email). */
export async function dettaglioAzienda(): Promise<DettaglioAzienda> {
  const r = await db.execute<any>(sql`
    SELECT a.ragione_sociale, a.nome, a.sito, a.telefono, a.gtfs_agency_id, a.citta, a.regione,
           a.centro_lat, a.centro_lng, a.zoom, a.aggiornata_il,
           coalesce(nullif(btrim(u.full_name), ''), u.email) AS aggiornata_da
      FROM azienda a LEFT JOIN users u ON u.id = a.aggiornata_da
     WHERE a.unica`);
  const riga = r.rows?.[0];
  if (!riga) return { azienda: AZIENDA_DA_COMPILARE, aggiornataIl: null, aggiornataDa: null };
  return {
    azienda: daRiga(riga),
    aggiornataIl: riga.aggiornata_il ? new Date(riga.aggiornata_il).toISOString() : null,
    aggiornataDa: riga.aggiornata_da ?? null,
  };
}

/** Salva la riga (la crea se la tabella è vuota) e la fa rileggere. */
export async function salvaAzienda(d: DatiAzienda, utenteId: string | null): Promise<DettaglioAzienda> {
  await db.execute(sql`
    INSERT INTO azienda (unica, ragione_sociale, nome, sito, telefono, gtfs_agency_id, citta, regione,
                         centro_lat, centro_lng, zoom, aggiornata_il, aggiornata_da)
    VALUES (true, ${d.ragioneSociale}, ${d.nome}, ${d.sito}, ${d.telefono}, ${d.gtfsAgencyId}, ${d.citta}, ${d.regione},
            ${d.centroLat}, ${d.centroLng}, ${d.zoom}, now(), ${utenteId}::uuid)
    ON CONFLICT (unica) DO UPDATE SET
      ragione_sociale = EXCLUDED.ragione_sociale, nome = EXCLUDED.nome, sito = EXCLUDED.sito,
      telefono = EXCLUDED.telefono, gtfs_agency_id = EXCLUDED.gtfs_agency_id, citta = EXCLUDED.citta,
      regione = EXCLUDED.regione, centro_lat = EXCLUDED.centro_lat, centro_lng = EXCLUDED.centro_lng,
      zoom = EXCLUDED.zoom, aggiornata_il = EXCLUDED.aggiornata_il, aggiornata_da = EXCLUDED.aggiornata_da`);
  dimenticaAzienda();
  return dettaglioAzienda();
}

/* ── Quello che ne ricavano gli altri pezzi ───────────────────────────────── */

const compatta = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/**
 * Le parole dell'azienda che una password non deve avere al centro: il nome,
 * la ragione sociale e la città, parola per parola e tutte attaccate
 * («Reggio Emilia» → reggio, emilia, reggioemilia). Solo da quattro lettere
 * in su: «spa» o «srl» fermerebbero password che non c'entrano.
 */
export function paroleDellAzienda(a: Pick<Azienda, "nome" | "ragioneSociale" | "citta" | "compilata">): string[] {
  if (!a.compilata) return [];
  const parole = new Set<string>();
  for (const testo of [a.nome, a.ragioneSociale, a.citta ?? ""]) {
    for (const p of testo.split(/[^\p{L}\p{N}]+/u).map(compatta)) if (p.length >= 4) parole.add(p);
    const intero = compatta(testo);
    if (intero.length >= 4 && intero.length <= 40) parole.add(intero);
  }
  return [...parole];
}

/** Le parole vietate di questa installazione, senza mai fermare la richiesta. */
export async function paroleVietateDellAzienda(): Promise<string[]> {
  return paroleDellAzienda(await aziendaOppureNeutra());
}

/** Quello che la web riceve con la sessione: niente che non si possa mostrare a chiunque sia entrato. */
export function aziendaPerLaWeb(a: Azienda): Azienda {
  return { ...a, centro: { ...a.centro } };
}
