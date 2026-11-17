/**
 * Le reti dell'azienda e le regole delle linee (tappa 6.7, migrazione 0040).
 *
 * Le reti (l'extraurbana e le urbane) e le regole che dal nome breve di una
 * linea ricavano la rete erano scritte nel codice. Ora sono dati
 * dell'azienda: li crea e li cambia l'amministratore (GET, POST, PUT e
 * DELETE /api/admin/reti), e ogni modifica resta nel registro. Chi li usa li
 * legge da lib/reti-linee.ts, dove stanno in memoria; chi salva qui li
 * rimette subito in vigore in questo processo, e gli altri li rileggono
 * entro un minuto (lib/azienda.ts).
 *
 * Che cosa tiene insieme una rete urbana:
 *   rete     l'identificativo, «urbano_<luogo>»: non cambia. Lo portano le
 *            linee, i titoli di viaggio e le regole tariffarie;
 *   zona     la zona tariffaria, «<luogo>_urban»: non cambia;
 *   codice   il codice con cui si classificano le sue fermate (da 2 a 9, il
 *            primo libero): non cambia. Quindi le reti urbane sono al più otto;
 *   luogo, nome, sigla, colore, ordine   si cambiano.
 * L'extraurbana c'è sempre ed è una sola: non si crea e non si toglie.
 *
 * Una rete in uso (linee assegnate, titoli di viaggio, zone, regole
 * tariffarie) non si toglie: prima si sposta chi la usa. Con la rete se ne
 * vanno le sue regole delle linee: le linee che le seguivano tornano
 * extraurbane.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  CODICE_URBANO_MAX, CODICE_URBANO_MIN, regolaVuoleValore, RETE_EXTRAURBANA, reteDalleRegole, TIPI_REGOLA,
  type RegolaLinea, type Rete, type RetiAzienda,
} from "./reti-linee";
import { retiDalDatabase, rileggiReti } from "./reti-lettura";

export class RifiutoReti extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

/** Chi sa eseguire una query: il pool, oppure una transazione. */
type Ex = Pick<typeof db, "execute">;
const righe = <T = any>(r: { rows?: T[] } | T[]): T[] => (Array.isArray(r) ? r : r.rows ?? []);

/** I colori delle reti nuove, a giro: i primi sei sono quelli di sempre. */
export const COLORI_RETI = ["#3b82f6", "#8b5cf6", "#06b6d4", "#10b981", "#f97316", "#ec4899", "#84cc16", "#e11d48"] as const;
/** Quante regole al più. */
export const MASSIMO_REGOLE = 100;

/* Il nome e il luogo finiscono nei file del GTFS e nelle esportazioni, anche in CSV scritti a mano:
   solo lettere, cifre, spazi e pochi segni. Niente virgolette, virgole o segni di minore e maggiore. */
const TESTO_PULITO = /^[\p{L}\p{N} .'’()\/-]+$/u;
const SOLO_TESTO = "solo lettere, cifre, spazi e i segni . ' - / ( )";
const NOME = z.string().trim().min(1, "nome: almeno un carattere").max(60, "nome: al più 60 caratteri").regex(TESTO_PULITO, `nome: ${SOLO_TESTO}`);
const LUOGO = z.string().trim().min(1, "luogo: almeno un carattere").max(40, "luogo: al più 40 caratteri").regex(TESTO_PULITO, `luogo: ${SOLO_TESTO}`);
const SIGLA = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "sigla: da una a quattro lettere o cifre, come «AN»");
const COLORE = z.string().trim().toLowerCase().regex(/^#[0-9a-f]{6}$/, "colore: sei cifre esadecimali, come «#3b82f6»");
const ORDINE = z.number().int().min(0).max(9999);

export const NuovaRete = z.object({
  luogo: LUOGO,
  /** se manca: «Urbano di <luogo>» */
  nome: NOME.optional(),
  sigla: SIGLA,
  /** se manca: il prossimo di COLORI_RETI */
  colore: COLORE.optional(),
  ordine: ORDINE.optional(),
}).strict();

export const ModificaRete = z.object({
  nome: NOME.optional(),
  luogo: LUOGO.optional(),
  sigla: SIGLA.optional(),
  colore: COLORE.optional(),
  ordine: ORDINE.optional(),
}).strict();

const VALORE = z.string().trim().toUpperCase().regex(/^[A-Z0-9./ -]{1,12}$/, "valore: al più 12 fra lettere, cifre, punto, barra, trattino e spazio");

export const RegolaDaSalvare = z.object({
  tipo: z.enum(TIPI_REGOLA),
  valore: VALORE.nullish(),
  rete: z.string().trim().min(1).max(40),
}).strict();

export const Regole = z.object({
  regole: z.array(RegolaDaSalvare).max(MASSIMO_REGOLE, `al più ${MASSIMO_REGOLE} regole`),
}).strict();

/* ── le regole, senza database ─────────────────────────────────────────── */

/** La chiave di un luogo, da cui nascono l'identificativo e la zona: «Porto San Giorgio» → «porto_san_giorgio». */
export function chiaveLuogo(luogo: string): string {
  return luogo.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30).replace(/_+$/g, "");
}

export const idReteUrbana = (luogo: string): string => `urbano_${chiaveLuogo(luogo)}`;
export const zonaReteUrbana = (luogo: string): string => `${chiaveLuogo(luogo)}_urban`;

/** Il primo codice libero per una rete urbana nuova; null se le reti urbane sono già otto. */
export function primoCodiceLibero(reti: readonly Pick<Rete, "codice">[]): number | null {
  const presi = new Set(reti.map((r) => r.codice));
  for (let c = CODICE_URBANO_MIN; c <= CODICE_URBANO_MAX; c++) if (!presi.has(c)) return c;
  return null;
}

/** Il colore di una rete nuova: il primo di COLORI_RETI che nessuna rete ha; se li hanno tutti, a giro. */
export function coloreLibero(reti: readonly Pick<Rete, "colore">[]): string {
  const presi = new Set(reti.map((r) => r.colore));
  return COLORI_RETI.find((c) => !presi.has(c)) ?? COLORI_RETI[reti.length % COLORI_RETI.length]!;
}

/** Come si legge una regola: «comincia con JE». */
export function testoRegola(g: Pick<RegolaLinea, "tipo" | "valore">): string {
  switch (g.tipo) {
    case "inizia": return `comincia con ${g.valore}`;
    case "uguale": return `è ${g.valore}`;
    case "inizia_poi_cifra": return `comincia con ${g.valore} seguito da una cifra`;
    case "inizia_con_cifra": return "comincia con una cifra";
    case "lettere_puntate": return "sono due lettere puntate";
  }
}

/**
 * Le regole in forma: il valore c'è solo dove serve, in maiuscole; ognuna
 * verso una rete che esiste; nessuna ripetuta. Rende le regole pulite, o il
 * motivo del rifiuto.
 */
export function regolePulite(regole: readonly z.infer<typeof RegolaDaSalvare>[], reti: readonly Pick<Rete, "rete">[]): RegolaLinea[] | string {
  const note = new Set(reti.map((r) => r.rete));
  const viste = new Set<string>();
  const pulite: RegolaLinea[] = [];
  for (const [i, g] of regole.entries()) {
    const n = i + 1;
    const vuole = regolaVuoleValore(g.tipo);
    const valore = g.valore ? g.valore : null;
    if (vuole && !valore) return `regola ${n}: manca il valore`;
    if (!vuole && valore) return `regola ${n}: questo tipo di regola non ha un valore`;
    if (!note.has(g.rete)) return `regola ${n}: la rete «${g.rete}» non c'è`;
    const chiave = `${g.tipo}|${valore ?? ""}`;
    if (viste.has(chiave)) return `regola ${n}: è scritta due volte (${testoRegola({ tipo: g.tipo, valore })}); vale solo la prima`;
    viste.add(chiave);
    pulite.push({ tipo: g.tipo, valore, rete: g.rete });
  }
  return pulite;
}

/* ── l'elenco, con chi usa ogni rete ───────────────────────────────────── */

export interface UsoRete {
  /** le linee assegnate alla rete nella pagina Tariffe, in tutti i feed */
  linee: number;
  /** i titoli di viaggio della rete */
  titoli: number;
  /** le zone tariffarie della rete */
  zone: number;
  /** le regole tariffarie della rete */
  regoleTariffarie: number;
  /** le regole delle linee che portano a questa rete */
  regole: number;
}
export interface ReteConUso extends Rete { uso: UsoRete; aggiornatoIl: string | null }

/** Vero se qualcosa usa la rete e quindi non si può togliere (le regole delle linee non contano: se ne vanno con lei). */
export const reteInUso = (u: UsoRete): boolean => u.linee + u.titoli + u.zone + u.regoleTariffarie > 0;

export interface ElencoReti { reti: ReteConUso[]; regole: RegolaLinea[]; massimoRetiUrbane: number; massimoRegole: number }

export async function elencoReti(ex: Ex = db): Promise<ElencoReti> {
  const lette = await retiDalDatabase(ex);
  const uso = new Map(righe(await ex.execute(sql`
    SELECT r.rete, r.aggiornato_il,
           (SELECT count(*) FROM gtfs_route_networks x WHERE x.network_id = r.rete)::int AS linee,
           (SELECT count(*) FROM gtfs_fare_products x WHERE x.network_id = r.rete)::int AS titoli,
           (SELECT count(*) FROM gtfs_fare_areas x WHERE x.network_id = r.rete)::int AS zone,
           (SELECT count(*) FROM gtfs_fare_leg_rules x WHERE x.network_id = r.rete)::int AS regole_tariffarie,
           (SELECT count(*) FROM reti_regole x WHERE x.rete = r.rete)::int AS regole
      FROM reti r`)).map((x: any) => [String(x.rete), x]));
  return {
    reti: lette.reti.map((r) => {
      const u: any = uso.get(r.rete) ?? {};
      return {
        ...r,
        uso: {
          linee: Number(u.linee ?? 0), titoli: Number(u.titoli ?? 0), zone: Number(u.zone ?? 0),
          regoleTariffarie: Number(u.regole_tariffarie ?? 0), regole: Number(u.regole ?? 0),
        },
        aggiornatoIl: u.aggiornato_il ? new Date(u.aggiornato_il).toISOString() : null,
      };
    }),
    regole: [...lette.regole],
    massimoRetiUrbane: CODICE_URBANO_MAX - CODICE_URBANO_MIN + 1,
    massimoRegole: MASSIMO_REGOLE,
  };
}

/* ── le modifiche ──────────────────────────────────────────────────────── */

/** Una modifica alla volta: due amministratori non si pestano i piedi. */
async function blocca(ex: Ex): Promise<void> {
  await ex.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cerbero:reti'))`);
}

/** Dopo un salvataggio: le reti nuove in vigore subito in questo processo. Se non riesce, arrivano col giro del minuto. */
async function rimettiInVigore(): Promise<void> {
  try { await rileggiReti(); } catch { /* resta l'elenco di prima fino alla prossima lettura dell'azienda */ }
}

/** Crea una rete urbana. L'identificativo, la zona e il codice li ricava il programma. */
export async function creaRete(d: z.infer<typeof NuovaRete>): Promise<Rete> {
  const chiave = chiaveLuogo(d.luogo);
  if (!chiave) throw new RifiutoReti(400, "luogo: servono lettere o cifre, per ricavarne l'identificativo della rete");
  const rete = idReteUrbana(d.luogo);
  const zona = zonaReteUrbana(d.luogo);
  const creata = await db.transaction(async (tx) => {
    await blocca(tx);
    const { reti } = await retiDalDatabase(tx);
    if (reti.some((r) => r.rete === rete || r.zona === zona)) throw new RifiutoReti(409, `C'è già una rete urbana di ${d.luogo.trim()}`);
    const conSigla = reti.find((r) => r.sigla === d.sigla);
    if (conSigla) throw new RifiutoReti(409, `La sigla ${d.sigla} è già della rete «${conSigla.nome}»`);
    const codice = primoCodiceLibero(reti);
    if (codice === null) {
      throw new RifiutoReti(409, `Le reti urbane sono già ${CODICE_URBANO_MAX - CODICE_URBANO_MIN + 1}, il massimo: i codici con cui si classificano le fermate sono finiti`);
    }
    const nuova: Rete = {
      rete, tipo: "urbano", nome: d.nome ?? `Urbano di ${d.luogo}`, luogo: d.luogo, sigla: d.sigla, zona, codice,
      colore: d.colore ?? coloreLibero(reti),
      ordine: d.ordine ?? Math.min(9999, reti.reduce((m, r) => Math.max(m, r.ordine), 0) + 1),
    };
    await tx.execute(sql`
      INSERT INTO reti (rete, tipo, nome, luogo, sigla, zona, codice, colore, ordine)
      VALUES (${nuova.rete}, 'urbano', ${nuova.nome}, ${nuova.luogo}, ${nuova.sigla}, ${nuova.zona}, ${nuova.codice}, ${nuova.colore}, ${nuova.ordine})`);
    return nuova;
  });
  await rimettiInVigore();
  return creata;
}

/** Cambia nome, luogo, sigla, colore o ordine. Dell'extraurbana solo nome, colore e ordine. */
export async function modificaRete(rete: string, m: z.infer<typeof ModificaRete>): Promise<Rete> {
  const cambiata = await db.transaction(async (tx) => {
    await blocca(tx);
    const { reti } = await retiDalDatabase(tx);
    const prima = reti.find((r) => r.rete === rete);
    if (!prima) throw new RifiutoReti(404, "Rete non trovata");
    if (prima.tipo === "extraurbano" && (m.luogo !== undefined || m.sigla !== undefined)) {
      throw new RifiutoReti(400, "L'extraurbano non ha un luogo né una sigla: si cambiano il nome, il colore e l'ordine");
    }
    if (m.sigla !== undefined) {
      const conSigla = reti.find((r) => r.sigla === m.sigla && r.rete !== rete);
      if (conSigla) throw new RifiutoReti(409, `La sigla ${m.sigla} è già della rete «${conSigla.nome}»`);
    }
    const dopo: Rete = {
      ...prima,
      nome: m.nome ?? prima.nome, luogo: m.luogo ?? prima.luogo, sigla: m.sigla ?? prima.sigla,
      colore: m.colore ?? prima.colore, ordine: m.ordine ?? prima.ordine,
    };
    await tx.execute(sql`
      UPDATE reti SET nome = ${dopo.nome}, luogo = ${dopo.luogo}, sigla = ${dopo.sigla}, colore = ${dopo.colore}, ordine = ${dopo.ordine},
                      aggiornato_il = now()
       WHERE rete = ${rete}
         AND (nome, luogo, sigla, colore, ordine) IS DISTINCT FROM (${dopo.nome}, ${dopo.luogo}::text, ${dopo.sigla}::text, ${dopo.colore}, ${dopo.ordine}::smallint)`);
    return dopo;
  });
  await rimettiInVigore();
  return cambiata;
}

/** Toglie una rete urbana che nessuno usa. Le sue regole delle linee se ne vanno con lei. */
export async function cancellaRete(rete: string): Promise<{ regoleTolte: number }> {
  const esito = await db.transaction(async (tx) => {
    await blocca(tx);
    const elenco = await elencoReti(tx);
    const r = elenco.reti.find((x) => x.rete === rete);
    if (!r) throw new RifiutoReti(404, "Rete non trovata");
    if (r.rete === RETE_EXTRAURBANA) throw new RifiutoReti(409, "L'extraurbano c'è sempre: non si toglie");
    if (reteInUso(r.uso)) {
      const chi = [
        r.uso.linee ? `${r.uso.linee} ${r.uso.linee === 1 ? "linea assegnata" : "linee assegnate"}` : "",
        r.uso.titoli ? `${r.uso.titoli} ${r.uso.titoli === 1 ? "titolo di viaggio" : "titoli di viaggio"}` : "",
        r.uso.zone ? `${r.uso.zone} ${r.uso.zone === 1 ? "zona" : "zone"}` : "",
        r.uso.regoleTariffarie ? `${r.uso.regoleTariffarie} ${r.uso.regoleTariffarie === 1 ? "regola tariffaria" : "regole tariffarie"}` : "",
      ].filter(Boolean).join(", ");
      throw new RifiutoReti(409, `La rete «${r.nome}» è in uso (${chi}): prima sposta o togli chi la usa, dalla pagina Tariffe`);
    }
    /* la sua voce negli elenchi delle reti dei feed (networks.txt) è una copia di questa riga: se ne va con lei */
    await tx.execute(sql`DELETE FROM gtfs_fare_networks WHERE network_id = ${rete}`);
    await tx.execute(sql`DELETE FROM reti WHERE rete = ${rete}`);
    await rinumera(tx);
    return { regoleTolte: r.uso.regole };
  });
  await rimettiInVigore();
  return esito;
}

/** Le regole rimaste, di nuovo in fila da 1 senza buchi. */
async function rinumera(ex: Ex): Promise<void> {
  const { regole } = await retiDalDatabase(ex);
  await scriviRegole(ex, [...regole]);
}

/**
 * Scrive l'elenco delle regole così com'è, in ordine. Tocca solo le righe che
 * cambiano: nel registro resta quello che è cambiato davvero, non l'elenco
 * intero a ogni salvataggio.
 */
async function scriviRegole(ex: Ex, regole: RegolaLinea[]): Promise<void> {
  await ex.execute(sql`DELETE FROM reti_regole WHERE ordine > ${regole.length}`);
  for (const [i, g] of regole.entries()) {
    await ex.execute(sql`
      INSERT INTO reti_regole (ordine, tipo, valore, rete) VALUES (${i + 1}, ${g.tipo}, ${g.valore}, ${g.rete})
      ON CONFLICT (ordine) DO UPDATE SET tipo = excluded.tipo, valore = excluded.valore, rete = excluded.rete
       WHERE (reti_regole.tipo, reti_regole.valore, reti_regole.rete) IS DISTINCT FROM (excluded.tipo, excluded.valore, excluded.rete)`);
  }
}

/** Salva l'elenco intero delle regole, nell'ordine in cui arriva. */
export async function salvaRegole(d: z.infer<typeof Regole>): Promise<RegolaLinea[]> {
  const salvate = await db.transaction(async (tx) => {
    await blocca(tx);
    const { reti } = await retiDalDatabase(tx);
    const pulite = regolePulite(d.regole, reti);
    if (typeof pulite === "string") throw new RifiutoReti(400, pulite);
    await scriviRegole(tx, pulite);
    return pulite;
  });
  await rimettiInVigore();
  return salvate;
}

/* ── l'anteprima: che cosa cambierebbe ─────────────────────────────────── */

export interface LineaCheCambia {
  linea: string;
  /** la rete con le regole in vigore, e con quelle proposte */
  da: string;
  a: string;
  /** vero se passa da urbana a extraurbana o viceversa: cambia il riposo minimo nel Roster */
  cambiaServizio: boolean;
}
export interface AnteprimaRegole {
  /** da dove vengono le linee: il programma in esercizio, o tutte quelle di Planning Studio */
  fonte: "esercizio" | "planning";
  linee: number;
  cambiano: LineaCheCambia[];
  /** quante linee per rete, con le regole proposte */
  perRete: Record<string, number>;
}

/** I nomi brevi delle linee su cui provare le regole: quelle del programma in esercizio; se non c'è, tutte quelle di Planning Studio. */
async function lineeDaProvare(ex: Ex): Promise<{ fonte: AnteprimaRegole["fonte"]; nomi: string[] }> {
  const esercizio = righe(await ex.execute(sql`
    SELECT DISTINCT btrim(r.route_short_name) AS nome
      FROM gtfs_routes r
     WHERE r.feed_id = (SELECT f.id FROM gtfs_feeds f WHERE f.is_active ORDER BY f.uploaded_at DESC LIMIT 1)
       AND btrim(coalesce(r.route_short_name, '')) <> ''`)).map((x: any) => String(x.nome));
  if (esercizio.length > 0) return { fonte: "esercizio", nomi: esercizio };
  const planning = righe(await ex.execute(sql`
    SELECT DISTINCT btrim(r.short_name) AS nome FROM ps_routes r WHERE btrim(coalesce(r.short_name, '')) <> ''`)).map((x: any) => String(x.nome));
  return { fonte: "planning", nomi: planning };
}

/** Il confronto, senza database: quali linee cambiano rete passando dalle regole in vigore a quelle proposte. */
export function confrontaRegole(nomi: readonly string[], inVigore: RetiAzienda, proposte: readonly RegolaLinea[]): Pick<AnteprimaRegole, "linee" | "cambiano" | "perRete"> {
  const urbane = new Set(inVigore.reti.filter((r) => r.tipo === "urbano").map((r) => r.rete));
  const perRete: Record<string, number> = {};
  const cambiano: LineaCheCambia[] = [];
  const ordinati = [...new Set(nomi)].sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
  for (const linea of ordinati) {
    const da = reteDalleRegole(linea, inVigore.regole);
    const a = reteDalleRegole(linea, proposte);
    perRete[a] = (perRete[a] ?? 0) + 1;
    if (da !== a) cambiano.push({ linea, da, a, cambiaServizio: urbane.has(da) !== urbane.has(a) });
  }
  return { linee: ordinati.length, cambiano, perRete };
}

/** Che cosa cambierebbe salvando queste regole. Non scrive niente. */
export async function anteprimaRegole(d: z.infer<typeof Regole>): Promise<AnteprimaRegole> {
  const inVigore = await retiDalDatabase();
  const pulite = regolePulite(d.regole, inVigore.reti);
  if (typeof pulite === "string") throw new RifiutoReti(400, pulite);
  const { fonte, nomi } = await lineeDaProvare(db);
  return { fonte, ...confrontaRegole(nomi, inVigore, pulite) };
}
