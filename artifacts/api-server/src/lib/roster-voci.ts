/**
 * Le voci di assenza e presenza del roster, e chi vede i codici sanitari.
 *
 * Il catalogo sta nella tabella roster_voci (tappa 5.5, migrazione 0034), una
 * riga per codice con le sue regole:
 *   sanitaria       malattia, infortunio, 104: dati sulla salute (GDPR art. 9).
 *                   Li vede e li scrive chi ha il permesso «roster»
 *                   (vedeCodiciSanitari in lib/auth.ts), mai un token emesso
 *                   per Argos. Chi non li vede legge un'assenza generica, ASS:
 *                   sa che il conducente manca, non perché;
 *   liberaTurno     il conducente manca e il suo turno torna «da coprire»
 *                   (5.1). Spento per il riposo, R;
 *   aDisposizione   la presenza dice «a disposizione» (vestizione, sostituti);
 *   codicePaghe     il codice per le paghe (BDROP), per la tappa delle presenze;
 *   attiva          si offre nel roster; una voce spenta resta dove c'è già;
 *   diSistema       R e ASS: non si spengono, non si cancellano, le regole non
 *                   cambiano.
 *
 * Il catalogo lo cambia solo l'amministratore (GET, POST, PUT e DELETE
 * /api/admin/voci-roster). «Sanitaria» si accende e non si spegne: spegnerla
 * mostrerebbe le voci già scritte a chi non ha il permesso. Una voce usata non
 * si cancella (chiave esterna da roster_entries): si spegne.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { righe, type Ex } from "./anagrafica-store";

export type CategoriaVoce = "assenza" | "presenza";

export interface VoceCatalogo {
  codice: string;
  categoria: CategoriaVoce;
  nome: string;
  sanitaria: boolean;
  liberaTurno: boolean;
  aDisposizione: boolean;
  codicePaghe: string | null;
  attiva: boolean;
  ordine: number;
  diSistema: boolean;
}

export interface Catalogo { voci: VoceCatalogo[]; di: Map<string, VoceCatalogo> }

export const RIPOSO = "R";
export const ASSENZA_GENERICA = "ASS";

const voce = (codice: string, categoria: CategoriaVoce, nome: string, ordine: number, x: Partial<VoceCatalogo> = {}): VoceCatalogo => ({
  codice, categoria, nome, ordine, sanitaria: false, liberaTurno: false, aDisposizione: false,
  codicePaghe: null, attiva: true, diSistema: false, ...x,
});

/** Le voci con cui nasce il catalogo (le stesse della migrazione 0034): per i test senza database. */
export const VOCI_DI_PARTENZA: readonly VoceCatalogo[] = Object.freeze([
  voce("R", "assenza", "Riposo", 10, { diSistema: true }),
  voce("ASS", "assenza", "Assenza", 20, { liberaTurno: true, diSistema: true }),
  voce("MA3", "assenza", "Malattia primi 3 giorni", 30, { sanitaria: true, liberaTurno: true }),
  voce("MA", "assenza", "Malattia giorni successivi", 40, { sanitaria: true, liberaTurno: true }),
  voce("I", "assenza", "Infortunio", 50, { sanitaria: true, liberaTurno: true }),
  voce("PAD", "assenza", "Permesso 104", 60, { sanitaria: true, liberaTurno: true }),
  voce("STRA", "presenza", "Straordinario", 110),
  voce("D1", "presenza", "Disposizione mattinale", 120, { aDisposizione: true }),
  voce("D2", "presenza", "Disposizione pomeridiana", 130, { aDisposizione: true }),
  voce("DISP", "presenza", "Disposizione", 140),
  voce("DAM1", "presenza", "Controllerie mattinali", 150),
  voce("DAM2", "presenza", "Controllerie pomeridiane", 160),
]);

export function catalogoDa(voci: readonly VoceCatalogo[]): Catalogo {
  const ordinate = [...voci].sort((a, b) => a.ordine - b.ordine || a.codice.localeCompare(b.codice));
  return { voci: ordinate, di: new Map(ordinate.map((v) => [v.codice, v])) };
}

const daRiga = (r: any): VoceCatalogo => ({
  codice: String(r.codice), categoria: r.categoria === "presenza" ? "presenza" : "assenza", nome: String(r.nome),
  sanitaria: !!r.sanitaria, liberaTurno: !!r.libera_turno, aDisposizione: !!r.a_disposizione,
  codicePaghe: r.codice_paghe ?? null, attiva: !!r.attiva, ordine: Number(r.ordine ?? 0), diSistema: !!r.di_sistema,
});

/** Il catalogo dal database: una dozzina di righe, si legge a ogni richiesta che serve. */
export async function leggiCatalogo(ex: Ex = db as unknown as Ex): Promise<Catalogo> {
  return catalogoDa(righe(await ex.execute(sql`
    SELECT codice, categoria, nome, sanitaria, libera_turno, a_disposizione, codice_paghe, attiva, ordine, di_sistema
      FROM roster_voci`)).map(daRiga));
}

/* ── Le regole, pure ─────────────────────────────────────────────────────── */

const sanitaria = (cat: Catalogo, v: { category: string; code: string }) => v.category === "assenza" && !!cat.di.get(v.code)?.sanitaria;

/** Vero se la voce libera il turno del conducente quel giorno. Un codice fuori catalogo, come prima: un'assenza sì. */
export const liberaIlTurno = (v: { category: string; code: string }, cat: Catalogo) =>
  v.category === "assenza" && (cat.di.get(v.code)?.liberaTurno ?? v.code !== RIPOSO);

/** Vero se la presenza dice «a disposizione». */
export const aDisposizione = (v: { category: string; code: string }, cat: Catalogo) =>
  v.category === "presenza" && !!cat.di.get(v.code)?.aDisposizione;

/** La voce come la vede chi la legge: i codici sanitari diventano ASS. */
export function mascheraVoce<T extends { category: string; code: string }>(v: T, vede: boolean, cat: Catalogo): T {
  if (vede || !sanitaria(cat, v)) return v;
  return { ...v, code: ASSENZA_GENERICA };
}

export interface VoceOfferta { code: string; label: string; liberaTurno: boolean; aDisposizione: boolean }

/** Il catalogo per chi scrive nel roster: le voci attive; senza permesso, niente codici sanitari. */
export function catalogoPer(vede: boolean, cat: Catalogo): Record<CategoriaVoce, VoceOfferta[]> {
  const offerte = (c: CategoriaVoce) => cat.voci
    .filter((v) => v.categoria === c && v.attiva && (vede || !v.sanitaria))
    .map((v) => ({ code: v.codice, label: v.nome, liberaTurno: v.liberaTurno, aDisposizione: v.aDisposizione }));
  return { assenza: offerte("assenza"), presenza: offerte("presenza") };
}

/** Si può scrivere questa voce? Solo voci attive della categoria giusta; i codici sanitari solo a chi li vede. */
export function esitoScrittura(category: unknown, code: unknown, vede: boolean, cat: Catalogo): "ok" | "non-valido" | "spenta" | "riservato" {
  if (category !== "assenza" && category !== "presenza") return "non-valido";
  const v = cat.di.get(String(code));
  if (!v || v.categoria !== category) return "non-valido";
  if (v.sanitaria && !vede) return "riservato";
  if (!v.attiva) return "spenta";
  return "ok";
}

/**
 * I codici che una rotazione può scrivere: assenze attive e non sanitarie (la
 * rotazione scrive per tutti i conducenti assegnati; i codici sanitari passano
 * solo dalla voce del singolo). Restituisce il primo problema, o null.
 * `ancheSpente`: per rigenerare una rotazione già fatta, una voce spenta dopo
 * va ancora bene (resta dove c'è già); una diventata sanitaria no.
 */
export function problemaRotazione(codici: string[], cat: Catalogo, ancheSpente = false): string | null {
  for (const c of new Set(codici)) {
    const v = cat.di.get(c);
    if (!v || v.categoria !== "assenza") return `«${c}» non è un'assenza del catalogo delle voci`;
    if (v.sanitaria) return "Malattia, infortunio e 104 non si mettono in una rotazione: la rotazione è per i riposi";
    if (!v.attiva && !ancheSpente) return `«${c}» è una voce spenta: riaccendila nel catalogo o usane un'altra`;
  }
  return null;
}

/* ── L'amministratore ────────────────────────────────────────────────────── */

export class RifiutoVoci extends Error {
  constructor(public status: number, messaggio: string) { super(messaggio); }
}

const NOME = z.string().trim().min(1, "nome: almeno un carattere").max(80, "nome: al più 80 caratteri");
const PAGHE = z.string().trim().regex(/^[A-Za-z0-9._-]{1,20}$/, "codice per le paghe: lettere, cifre, punto, trattino, al più 20").nullable();
const ORDINE = z.number().int().min(0).max(9999);

export const NuovaVoce = z.object({
  codice: z.string().trim().regex(/^[A-Z0-9]{1,8}$/, "codice: lettere maiuscole e cifre, al più 8"),
  categoria: z.enum(["assenza", "presenza"]),
  nome: NOME,
  sanitaria: z.boolean().default(false),
  liberaTurno: z.boolean().optional(),
  aDisposizione: z.boolean().default(false),
  codicePaghe: PAGHE.default(null),
  ordine: ORDINE.default(500),
}).strict();

export const ModificaVoce = z.object({
  nome: NOME.optional(),
  sanitaria: z.boolean().optional(),
  liberaTurno: z.boolean().optional(),
  aDisposizione: z.boolean().optional(),
  codicePaghe: PAGHE.optional(),
  attiva: z.boolean().optional(),
  ordine: ORDINE.optional(),
}).strict();

export interface VoceConUso extends VoceCatalogo { voci: number; rotazioni: string[] }

/** Il catalogo intero per la pagina dell'amministratore, con quanto ogni voce è usata. */
export async function elencoVoci(): Promise<VoceConUso[]> {
  const ex = db as unknown as Ex;
  const cat = await leggiCatalogo(ex);
  const voci = new Map(righe(await ex.execute(sql`SELECT code, count(*)::int AS n FROM roster_entries GROUP BY code`))
    .map((r) => [String(r.code), Number(r.n)]));
  const rotazioni = new Map<string, string[]>();
  for (const r of righe(await ex.execute(sql`
    SELECT DISTINCT r.name, c
      FROM roster_rotazioni_riposi r,
           jsonb_array_elements(CASE WHEN jsonb_typeof(r.pattern) = 'array' THEN r.pattern ELSE '[]'::jsonb END) s,
           jsonb_array_elements_text(CASE WHEN jsonb_typeof(s) = 'array' THEN s ELSE '[]'::jsonb END) c
     WHERE c IS NOT NULL AND c <> ''
     ORDER BY 1`))) {
    const l = rotazioni.get(String(r.c)); if (l) l.push(String(r.name)); else rotazioni.set(String(r.c), [String(r.name)]);
  }
  return cat.voci.map((v) => ({ ...v, voci: voci.get(v.codice) ?? 0, rotazioni: rotazioni.get(v.codice) ?? [] }));
}

/** Le regole che valgono per categoria: fuori categoria si spengono, con un errore se chieste. */
function regolePer(categoria: CategoriaVoce, x: { sanitaria?: boolean; liberaTurno?: boolean; aDisposizione?: boolean }) {
  if (categoria === "presenza" && (x.sanitaria || x.liberaTurno)) throw new RifiutoVoci(400, "Una presenza non è un dato sanitario e non libera il turno");
  if (categoria === "assenza" && x.aDisposizione) throw new RifiutoVoci(400, "«A disposizione» vale solo per le presenze");
}

export async function creaVoce(dati: z.infer<typeof NuovaVoce>): Promise<VoceCatalogo> {
  regolePer(dati.categoria, dati);
  const liberaTurno = dati.categoria === "assenza" ? (dati.liberaTurno ?? true) : false;
  const r = righe(await db.execute(sql`
    INSERT INTO roster_voci (codice, categoria, nome, sanitaria, libera_turno, a_disposizione, codice_paghe, ordine)
    VALUES (${dati.codice}, ${dati.categoria}, ${dati.nome}, ${dati.sanitaria}, ${liberaTurno}, ${dati.aDisposizione},
            ${dati.codicePaghe}, ${dati.ordine})
    ON CONFLICT (codice) DO NOTHING
    RETURNING codice, categoria, nome, sanitaria, libera_turno, a_disposizione, codice_paghe, attiva, ordine, di_sistema`));
  if (!r.length) throw new RifiutoVoci(409, `Il codice «${dati.codice}» c'è già nel catalogo`);
  return daRiga(r[0]);
}

export async function modificaVoce(codice: string, m: z.infer<typeof ModificaVoce>): Promise<VoceCatalogo> {
  return db.transaction(async (tx) => {
    const ex = tx as unknown as Ex;
    const r = righe(await ex.execute(sql`
      SELECT codice, categoria, nome, sanitaria, libera_turno, a_disposizione, codice_paghe, attiva, ordine, di_sistema
        FROM roster_voci WHERE codice = ${codice} FOR UPDATE`))[0];
    if (!r) throw new RifiutoVoci(404, "Voce non trovata");
    const v = daRiga(r);
    regolePer(v.categoria, m);
    if (v.diSistema) {
      const cambia = (k: keyof typeof m) => m[k] !== undefined && m[k] !== (v as any)[k];
      if (cambia("attiva") || cambia("sanitaria") || cambia("liberaTurno")) {
        throw new RifiutoVoci(400, `«${v.codice}» è una voce di sistema: si cambiano solo nome, ordine e codice per le paghe`);
      }
    }
    if (v.sanitaria && m.sanitaria === false) {
      throw new RifiutoVoci(400, "«Dato sanitario» non si spegne dall'applicazione: le voci già scritte diventerebbero leggibili a chi non ha il permesso");
    }
    const n = { ...v, ...Object.fromEntries(Object.entries(m).filter(([, x]) => x !== undefined)) } as VoceCatalogo;
    const s = righe(await ex.execute(sql`
      UPDATE roster_voci SET nome = ${n.nome}, sanitaria = ${n.sanitaria}, libera_turno = ${n.liberaTurno},
             a_disposizione = ${n.aDisposizione}, codice_paghe = ${n.codicePaghe}, attiva = ${n.attiva}, ordine = ${n.ordine},
             aggiornata_il = now()
       WHERE codice = ${codice}
      RETURNING codice, categoria, nome, sanitaria, libera_turno, a_disposizione, codice_paghe, attiva, ordine, di_sistema`));
    return daRiga(s[0]);
  });
}

/** Cancella una voce mai usata: né nelle voci del roster né nelle rotazioni. Le altre si spengono. */
export async function cancellaVoce(codice: string): Promise<void> {
  const v = (await elencoVoci()).find((x) => x.codice === codice);
  if (!v) throw new RifiutoVoci(404, "Voce non trovata");
  if (v.diSistema) throw new RifiutoVoci(400, `«${codice}» è una voce di sistema: non si cancella`);
  if (v.voci > 0 || v.rotazioni.length) {
    throw new RifiutoVoci(409, `«${codice}» è usata (${v.voci} voci nel roster${v.rotazioni.length ? `, rotazioni: ${v.rotazioni.join(", ")}` : ""}): spegnila invece di cancellarla`);
  }
  try {
    await db.execute(sql`DELETE FROM roster_voci WHERE codice = ${codice} AND NOT di_sistema`);
  } catch (e: any) {
    /* 23503: nel frattempo qualcuno l'ha usata */
    if (String(e?.code ?? e?.cause?.code ?? "") === "23503") throw new RifiutoVoci(409, `«${codice}» è usata: spegnila invece di cancellarla`);
    throw e;
  }
}
