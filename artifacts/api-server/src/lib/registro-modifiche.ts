/**
 * Il registro delle modifiche, per la pagina dell'amministratore (PR 2.11).
 *
 * L'app non ha diritti sulle tabelle del registro: lo legge con
 * registro.leggi() e ne chiede lo stato con registro.stato() (migrazione
 * 0007), che girano come il proprietario del registro. La funzione ha i suoi
 * limiti (periodo, righe), non accetta filtri per persona e annota ogni
 * consultazione; qui si validano i parametri prima di chiamarla e si
 * aggiungono i nomi che servono a leggere le righe.
 *
 * Decisioni del 25/10 che valgono qui:
 * - lo legge solo l'admin (la rotta è sotto requireAdmin, chiusa ad Argos);
 * - niente viste per persona: nessun parametro filtra o ordina per chi ha
 *   fatto la modifica, e l'ambito si può fissare solo se non è una persona;
 * - i nomi dei conducenti non si risolvono (l'anagrafica non entra nel
 *   registro, nemmeno accanto), e gli id dei campioni non si risolvono mai.
 */
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gli ambiti che si possono fissare con il loro id: mai una persona. */
export const AMBITI_FILTRABILI = ["progetto_ps", "progetto_turni", "feed", "scenario", "corsa", "variante", "calendario"] as const;
/** Tutti i tipi di ambito del registro (gli ultimi due sono persone: solo come tipo, senza id). */
export const AMBITI = [...AMBITI_FILTRABILI, "utente", "conducente"] as const;
export const OPERAZIONI = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"] as const;
/** Righe per pagina: la funzione ne dà al più 200, e una in più serve a sapere se ce ne sono altre. */
export const LIMITE_MAX = 100;
const SALTO_MAX = 5000;

const Cursore = z.object({
  ts: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/),
  tx: z.string().regex(/^\d{1,20}$/),
  salta: z.number().int().min(0).max(SALTO_MAX),
}).strict();
export type Cursore = z.infer<typeof Cursore>;

const istante = z.string().datetime({ offset: true });

/** I parametri della pagina. Ogni chiave in più è un errore: in particolare niente per persona. */
export const Parametri = z.object({
  da: istante.optional(),
  a: istante.optional(),
  tabella: z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/).max(120).optional(),
  operazione: z.enum(OPERAZIONI).optional(),
  ambitoTipo: z.enum(AMBITI).optional(),
  ambitoId: z.string().regex(UUID).optional(),
  limite: z.coerce.number().int().min(1).max(LIMITE_MAX).default(50),
  cursore: z.string().max(400).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.ambitoId && !(AMBITI_FILTRABILI as readonly string[]).includes(p.ambitoTipo ?? "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ambitoId"], message: "l'ambito si può fissare solo se non è una persona" });
  }
});
export type Parametri = z.infer<typeof Parametri>;

export function codificaCursore(c: Cursore): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
export function leggiCursore(testo: string): Cursore | null {
  try {
    const p = Cursore.safeParse(JSON.parse(Buffer.from(testo, "base64url").toString("utf8")));
    return p.success ? p.data : null;
  } catch { return null; }
}

export interface StatoRegistro {
  attivo: boolean;
  attivatoIl: string | null;
  baseGiuridica: string;
  anonimizzaDopoMesi: number;
  conservazioneMesi: number;
  tabelle: Array<{ tabella: string; ambitoTipo: string | null; conValori: boolean; riepilogoSempre: boolean }>;
}

export interface RigaRegistro {
  ts: string;
  transazione: string;
  richiesta: string | null;
  /** chi l'ha fatto: null per un processo di sistema, o dopo l'anonimizzazione */
  attore: { id: string; nome: string | null; email: string | null } | null;
  via: string | null;
  origine: string | null;
  ruoloDb: string;
  tabella: string;
  operazione: string;
  chiave: Record<string, unknown> | null;
  ambito: { tipo: string; id: string | null; nome: string | null } | null;
  campi: string[] | null;
  prima: Record<string, unknown> | null;
  dopo: Record<string, unknown> | null;
  riepilogo: boolean;
  righe: number | null;
  campione: Array<Record<string, unknown>> | null;
  aCascata: boolean;
}

export async function statoRegistro(): Promise<StatoRegistro> {
  const r = await db.execute<any>(sql`SELECT registro.stato() AS s`);
  const s = (r as any).rows?.[0]?.s ?? {};
  return {
    attivo: s.attivo === true,
    attivatoIl: s.attivato_il ?? null,
    baseGiuridica: String(s.base_giuridica ?? ""),
    anonimizzaDopoMesi: Number(s.anonimizza_dopo_mesi ?? 12),
    conservazioneMesi: Number(s.conservazione_mesi ?? 60),
    tabelle: (Array.isArray(s.tabelle) ? s.tabelle : []).map((t: any) => ({
      tabella: String(t.tabella), ambitoTipo: t.ambito_tipo ?? null,
      conValori: t.con_valori === true, riepilogoSempre: t.riepilogo_sempre === true,
    })),
  };
}

/** Un elenco di uuid come letterale di array (sono già passati dal controllo: solo esadecimali e trattini). */
const elenco = (ids: string[]) => `{${ids.join(",")}}`;

/** I nomi degli ambiti, tipo per tipo. Il conducente no: l'anagrafica resta fuori dal registro. */
async function nomiDegliAmbiti(perTipo: Map<string, Set<string>>): Promise<Map<string, string>> {
  const nomi = new Map<string, string>();
  const metti = (tipo: string, righe: any[]) => { for (const x of righe) if (x.nome) nomi.set(`${tipo}:${x.id}`, String(x.nome)); };
  const di = (tipo: string) => [...(perTipo.get(tipo) ?? [])];
  const letture: Array<Promise<void>> = [];
  const leggi = (tipo: string, q: (ids: string) => ReturnType<typeof sql>) => {
    const ids = di(tipo);
    if (ids.length) letture.push(db.execute<any>(q(elenco(ids))).then((r) => metti(tipo, (r as any).rows ?? [])));
  };
  leggi("progetto_ps", (ids) => sql`SELECT id::text AS id, name AS nome FROM ps_projects WHERE id = ANY(${ids}::uuid[])`);
  leggi("progetto_turni", (ids) => sql`SELECT id::text AS id, name AS nome FROM scheduling_projects WHERE id = ANY(${ids}::uuid[])`);
  leggi("feed", (ids) => sql`SELECT id::text AS id, filename AS nome FROM gtfs_feeds WHERE id = ANY(${ids}::uuid[])`);
  leggi("scenario", (ids) => sql`SELECT id::text AS id, name AS nome FROM service_program_scenarios WHERE id = ANY(${ids}::uuid[])`);
  leggi("utente", (ids) => sql`SELECT id::text AS id, coalesce(nullif(full_name, ''), email) AS nome FROM users WHERE id = ANY(${ids}::uuid[])`);
  leggi("corsa", (ids) => sql`
    SELECT t.id::text AS id,
           concat_ws(' · ', 'linea ' || nullif(r.short_name, ''), coalesce(nullif(t.short_name, ''), nullif(t.headsign, ''))) AS nome
      FROM ps_trips t LEFT JOIN ps_routes r ON r.id = t.route_id
     WHERE t.id = ANY(${ids}::uuid[])`);
  leggi("variante", (ids) => sql`
    SELECT v.id::text AS id, concat_ws(' · ', 'linea ' || nullif(r.short_name, ''), nullif(v.name, '')) AS nome
      FROM ps_route_variants v LEFT JOIN ps_routes r ON r.id = v.route_id
     WHERE v.id = ANY(${ids}::uuid[])`);
  leggi("calendario", (ids) => sql`SELECT id::text AS id, coalesce(nullif(name, ''), code) AS nome FROM ps_calendars WHERE id = ANY(${ids}::uuid[])`);
  await Promise.all(letture);
  return nomi;
}

export interface PaginaRegistro {
  righe: RigaRegistro[];
  /** il cursore per la pagina dopo, se ce n'è una */
  successivo: string | null;
  /** una transazione con più righe di quante se ne possano scorrere: vanno stretti i filtri */
  troppeInUnaTransazione: boolean;
}

/**
 * Una pagina del registro, dal più recente. Chiama registro.leggi() (che
 * annota la consultazione col contesto della richiesta) e aggiunge i nomi di
 * chi ha fatto la modifica e degli ambiti.
 */
export async function leggiRegistro(p: Parametri): Promise<PaginaRegistro | { errore: string }> {
  const cursore = p.cursore ? leggiCursore(p.cursore) : null;
  if (p.cursore && !cursore) return { errore: "Il segnalibro della pagina non è valido: ricarica dall'inizio" };
  const filtri: Record<string, string> = {};
  if (p.da) filtri.da = p.da;
  if (p.a) filtri.a = p.a;
  if (p.tabella) filtri.tabella = p.tabella;
  if (p.operazione) filtri.operazione = p.operazione;
  if (p.ambitoTipo) filtri.ambito_tipo = p.ambitoTipo;
  if (p.ambitoId) filtri.ambito_id = p.ambitoId.toLowerCase();
  if (cursore) { filtri.cursore_ts = cursore.ts; filtri.cursore_transazione = cursore.tx; }

  const r = await db.execute<any>(sql`
    SELECT * FROM registro.leggi(${JSON.stringify(filtri)}::jsonb, ${p.limite + 1}, ${cursore?.salta ?? 0})`);
  const tutte: any[] = (r as any).rows ?? [];
  const lette = tutte.slice(0, p.limite);

  // il cursore della pagina dopo: l'ultima riga data, e quante della sua transazione sono già state date
  let successivo: string | null = null;
  let troppe = false;
  if (tutte.length > p.limite && lette.length) {
    const ultima = lette[lette.length - 1];
    const stessa = (x: any) => x.ts_esatto === ultima.ts_esatto && x.transazione === ultima.transazione;
    let salta = lette.filter(stessa).length;
    if (cursore && cursore.ts === ultima.ts_esatto && cursore.tx === ultima.transazione) salta += cursore.salta;
    if (salta > SALTO_MAX) troppe = true;
    else successivo = codificaCursore({ ts: ultima.ts_esatto, tx: ultima.transazione, salta });
  }

  // i nomi: chi (solo id che sono uuid), e gli ambiti tipo per tipo
  const attori = [...new Set(lette.map((x) => x.attore).filter((a): a is string => typeof a === "string" && UUID.test(a)))];
  const persone = new Map<string, { nome: string | null; email: string | null }>();
  if (attori.length) {
    const u = await db.execute<any>(sql`SELECT id::text AS id, full_name, email FROM users WHERE id = ANY(${elenco(attori)}::uuid[])`);
    for (const x of (u as any).rows ?? []) persone.set(String(x.id).toLowerCase(), { nome: x.full_name ?? null, email: x.email ?? null });
  }
  const perTipo = new Map<string, Set<string>>();
  for (const x of lette) {
    if (typeof x.ambito_tipo !== "string" || typeof x.ambito_id !== "string" || !UUID.test(x.ambito_id)) continue;
    if (x.ambito_tipo === "conducente") continue;
    if (!perTipo.has(x.ambito_tipo)) perTipo.set(x.ambito_tipo, new Set());
    perTipo.get(x.ambito_tipo)!.add(x.ambito_id.toLowerCase());
  }
  const nomi = await nomiDegliAmbiti(perTipo);

  const righe: RigaRegistro[] = lette.map((x) => ({
    ts: x.ts instanceof Date ? x.ts.toISOString() : String(x.ts),
    transazione: String(x.transazione),
    richiesta: x.richiesta ?? null,
    attore: typeof x.attore === "string" && x.attore
      ? { id: x.attore, ...(persone.get(x.attore.toLowerCase()) ?? { nome: null, email: null }) }
      : null,
    via: x.via ?? null,
    origine: x.origine ?? null,
    ruoloDb: String(x.ruolo_db),
    tabella: String(x.tabella),
    operazione: String(x.operazione),
    chiave: x.chiave ?? null,
    ambito: x.ambito_tipo
      ? { tipo: x.ambito_tipo, id: x.ambito_id ?? null, nome: x.ambito_id ? nomi.get(`${x.ambito_tipo}:${String(x.ambito_id).toLowerCase()}`) ?? null : null }
      : null,
    campi: x.campi ?? null,
    prima: x.prima ?? null,
    dopo: x.dopo ?? null,
    riepilogo: x.riepilogo === true,
    righe: x.righe == null ? null : Number(x.righe),
    campione: x.campione ?? null,
    aCascata: x.a_cascata === true,
  }));
  return { righe, successivo, troppeInUnaTransazione: troppe };
}
