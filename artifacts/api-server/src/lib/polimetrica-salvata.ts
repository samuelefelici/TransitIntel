/**
 * Il salvataggio di una polimetrica dell'area di lavoro (tappa 6.35).
 *
 * La pagina manda il percorso con le sue fermate, i confini delle tratte, i
 * punti tariffari scelti e il nome di ogni nodo. Prima della 6.35 tutto si
 * scriveva com'era arrivato. Ora dal browser si prendono solo le decisioni:
 * - i confini delle tratte (una fermata è la prima di una tratta nuova);
 * - il punto tariffario scelto in una tratta (il segno `punto` sulla fermata);
 * - il nome del nodo, il numero, l'etichetta e il colore di ogni tratta;
 * - il nome della polimetrica.
 *
 * Tutto il resto lo dà l'import, che il server ha già: la linea, le fermate
 * coi loro nomi, coordinate e km, e quindi i km e le fermate di ogni tratta.
 * Le fermate mandate devono essere quelle del percorso, nello stesso ordine
 * (o al contrario, per il ritorno); se no il salvataggio si rifiuta.
 *
 * Le regole su tratte e punti sono quelle della pagina
 * (artifacts/transitintel/src/lib/polimetrica.ts: trattaDelleFermate,
 * puntiDelleTratte), qui scritte di nuovo perché l'API non usa la libreria
 * della web.
 */
import { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const èUuid = (x: unknown): x is string => typeof x === "string" && UUID.test(x);

/** Quanto si accetta. Sui dati veri un percorso ha al più 81 fermate. */
export const LIMITI = { fermate: 1000, testo: 200, nodo: 120, etichetta: 60, numero: 999 } as const;

const FermataInviata = z.object({
  stopId: z.string().min(1).max(LIMITI.testo),
  /* solo il segno: nome, coordinate, km e tratta li dà l'import */
  punto: z.boolean().optional(),
});

const TrattaInviata = z.object({
  index: z.number().int().min(0),
  number: z.number().int().min(1).max(LIMITI.numero).optional(),
  label: z.string().max(LIMITI.etichetta).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "colore non valido").optional(),
  nodeName: z.string().max(LIMITI.nodo).optional(),
});

/**
 * Il corpo di POST /api/fares/polimetriche/saved. Le chiavi che non sono qui
 * (linea, km, nomi delle fermate, campi calcolati delle tratte) si scartano:
 * li ricava il server.
 */
export const CorpoPolimetrica = z.object({
  importId: z.string().regex(UUID, "import non valido"),
  routeId: z.string().min(1).max(LIMITI.testo),
  variantId: z.string().min(1).max(LIMITI.testo),
  direction: z.enum(["AB", "BA"]).default("AB"),
  name: z.string().max(LIMITI.testo).nullish(),
  boundaries: z.array(z.number().int()).max(LIMITI.fermate),
  tratte: z.array(TrattaInviata).min(1).max(LIMITI.fermate),
  stops: z.array(FermataInviata).min(2).max(LIMITI.fermate),
});
export type CorpoPolimetrica = z.infer<typeof CorpoPolimetrica>;

const NOMI_DEI_CAMPI: Record<string, string> = {
  importId: "import", routeId: "percorso", variantId: "variante", direction: "verso", name: "nome",
  boundaries: "confini", tratte: "tratte", stops: "fermate",
  index: "indice", number: "numero", label: "etichetta", color: "colore", nodeName: "nome del nodo",
  stopId: "codice della fermata", punto: "punto tariffario",
};

/** Dove sta il problema: «nome», «tratte › n. 3 › nome del nodo», «confini › n. 2». */
function doveNelCorpo(path: readonly PropertyKey[]): string {
  const parti: string[] = [];
  for (const k of path) {
    if (typeof k === "number") parti.push(`n. ${k + 1}`);
    else parti.push(NOMI_DEI_CAMPI[String(k)] ?? String(k));
  }
  return parti.join(" › ") || "dati";
}

/** Il primo problema del corpo, in italiano, in una riga che si può mostrare. */
function erroreDelCorpo(e: z.ZodError): string {
  const p = e.issues[0] as (z.core.$ZodIssue & { origin?: string; maximum?: number | bigint; minimum?: number | bigint; input?: unknown }) | undefined;
  if (!p) return "Dati non validi";
  const unità = p.origin === "string" ? " caratteri" : p.origin === "array" ? " elementi" : "";
  let perché: string;
  switch (p.code) {
    case "too_big": perché = `al più ${String(p.maximum)}${unità}`; break;
    case "too_small": perché = p.origin === "string" && Number(p.minimum) === 1 ? "non può essere vuoto" : `almeno ${String(p.minimum)}${unità}`; break;
    case "invalid_type": perché = p.input === undefined ? "manca" : "tipo sbagliato"; break;
    case "invalid_value": perché = "valore non ammesso"; break;
    case "invalid_format": perché = p.message; break;
    default: perché = "non valido";
  }
  return `Dati non validi (${doveNelCorpo(p.path)}): ${perché}`;
}

/** Una fermata del percorso, com'è nell'import. */
export interface FermataImport { stopId: string; stopName: string; lat: number; lon: number; km: number; distPrev: number }

/** Il percorso dell'import a cui si riferisce la polimetrica. */
export interface PercorsoImport {
  routeId: string; variantId: string;
  lineCode: string | null; lineName: string | null;
  totalKm: number;
  stops: FermataImport[];
}

export interface FermataSalvata extends FermataImport { tratta: number; punto?: true }

export interface TrattaSalvata {
  index: number; number: number; label: string; color?: string; nodeName: string;
  fromStopIdx: number; toStopIdx: number; fromStopName: string; toStopName: string;
  fromKm: number; toKm: number; km: number; stopCount: number;
  puntoStopIdx: number; puntoStopName: string; puntoKm: number;
}

/** Quello che si scrive in polim_polimetriche. */
export interface PolimetricaDaSalvare {
  importId: string; routeId: string; variantId: string; direction: "AB" | "BA";
  lineCode: string | null; lineName: string | null; name: string | null;
  totalKm: number; boundaries: number[]; tratte: TrattaSalvata[]; stops: FermataSalvata[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Le fermate del percorso nel verso della polimetrica: AB com'è, BA al
 * contrario coi km contati dall'altro capo (come fa la pagina).
 */
export function fermateNelVerso(p: PercorsoImport, verso: "AB" | "BA"): FermataImport[] {
  const f = p.stops.map((s) => ({ stopId: String(s.stopId), stopName: String(s.stopName ?? ""), lat: Number(s.lat), lon: Number(s.lon), km: Number(s.km), distPrev: Number(s.distPrev) }));
  if (verso === "AB") return f;
  const rev = [...f].reverse();
  return rev.map((s, i) => ({ ...s, km: r3(p.totalKm - s.km), distPrev: i === 0 ? 0 : r3(rev[i - 1]!.km - s.km) }));
}

/**
 * Compone la polimetrica da salvare: controlla il corpo contro il percorso
 * dell'import e ricava dall'import tutto quello che non è una decisione.
 */
export function componiPolimetrica(c: CorpoPolimetrica, p: PercorsoImport):
  { ok: true; polimetrica: PolimetricaDaSalvare } | { ok: false; errore: string } {
  const fermate = fermateNelVerso(p, c.direction);
  const n = fermate.length;
  if (n < 2) return { ok: false, errore: "Il percorso dell'import non ha fermate" };
  if (c.stops.length !== n) {
    return { ok: false, errore: `Le fermate non sono quelle del percorso: ${c.stops.length} invece di ${n}` };
  }
  for (let i = 0; i < n; i++) {
    if (c.stops[i]!.stopId !== fermate[i]!.stopId) {
      return { ok: false, errore: `La fermata ${i + 1} non è quella del percorso${c.direction === "BA" ? " letto al contrario" : ""}` };
    }
  }

  /* i confini: la prima fermata di ogni tratta dopo la prima, dentro il percorso */
  const fuori = c.boundaries.find((b) => b <= 0 || b >= n);
  if (fuori !== undefined) return { ok: false, errore: `Il confine ${fuori} è fuori dal percorso (fermate da 1 a ${n - 1})` };
  const confini = [...new Set(c.boundaries)].sort((a, b) => a - b);
  if (c.tratte.length !== confini.length + 1) {
    return { ok: false, errore: `Le tratte non tornano coi confini: ${c.tratte.length} invece di ${confini.length + 1}` };
  }
  const inviate = [...c.tratte].sort((a, b) => a.index - b.index);
  if (inviate.some((t, k) => t.index !== k)) return { ok: false, errore: "Le tratte vanno numerate da 0, una per indice" };

  /* la tratta di ogni fermata: un confine è la prima fermata di una tratta nuova */
  const trattaDi: number[] = [];
  for (let i = 0, t = 0, prossimo = 0; i < n; i++) {
    if (prossimo < confini.length && i === confini[prossimo]) { t++; prossimo++; }
    trattaDi.push(t);
  }

  /* il punto tariffario: al più uno per tratta, altrimenti la prima fermata */
  const inizi = [0, ...confini];
  const punti = inizi.slice();
  const conPunto = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (c.stops[i]!.punto !== true) continue;
    const t = trattaDi[i]!;
    if (conPunto.has(t)) return { ok: false, errore: `Due punti tariffari nella stessa tratta (la ${t + 1})` };
    conPunto.add(t);
    punti[t] = i;
  }

  const stops: FermataSalvata[] = fermate.map((f, i) => ({
    ...f, tratta: trattaDi[i]!, ...(conPunto.has(trattaDi[i]!) && punti[trattaDi[i]!] === i ? { punto: true as const } : {}),
  }));

  const tratte: TrattaSalvata[] = inizi.map((da, k) => {
    const a = k + 1 < inizi.length ? inizi[k + 1]! : n - 1;
    const scelta = inviate[k]!;
    const numero = scelta.number ?? k + 1;
    const punto = punti[k]!;
    return {
      index: k, number: numero, label: scelta.label?.trim() || `Tratta ${numero}`,
      ...(scelta.color ? { color: scelta.color } : {}),
      nodeName: (scelta.nodeName ?? "").trim(),
      fromStopIdx: da, toStopIdx: a, fromStopName: fermate[da]!.stopName, toStopName: fermate[a]!.stopName,
      fromKm: fermate[da]!.km, toKm: fermate[a]!.km, km: r2(fermate[a]!.km - fermate[da]!.km), stopCount: a - da + 1,
      puntoStopIdx: punto, puntoStopName: fermate[punto]!.stopName, puntoKm: fermate[punto]!.km,
    };
  });

  const nome = (c.name ?? "").trim();
  return {
    ok: true,
    polimetrica: {
      importId: c.importId, routeId: p.routeId, variantId: p.variantId, direction: c.direction,
      lineCode: p.lineCode, lineName: p.lineName, name: nome || null,
      totalKm: fermate[n - 1]!.km, boundaries: confini, tratte, stops,
    },
  };
}

/**
 * Legge il corpo di un salvataggio: i campi che servono, coi loro tipi e
 * limiti, oppure il primo problema in italiano.
 */
export function leggiCorpo(grezzo: unknown): { ok: true; corpo: CorpoPolimetrica } | { ok: false; errore: string } {
  /* reportInput: per dire «manca» quando un campo non c'è, e «tipo sbagliato» quando c'è */
  const r = CorpoPolimetrica.safeParse(grezzo ?? {}, { reportInput: true });
  return r.success ? { ok: true, corpo: r.data } : { ok: false, errore: erroreDelCorpo(r.error) };
}
