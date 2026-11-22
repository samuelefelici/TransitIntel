/**
 * Il crawler di Argos: dalla traccia del ragionamento alla «scena».
 *
 * Con `trace: true` Argos manda due pacchetti: il RETRIEVAL (le parole chiave
 * della domanda, i passaggi candidati con punteggio e stato, i ponti, i
 * concetti) e, a risposta finita, la VERIFICA (quale frase della risposta si
 * appoggia a quale fonte, con le parole in comune). Qui li si trasforma in ciò
 * che la scena mostra fase per fase. Funzioni pure, con i loro test.
 *
 * Il confronto fra parole è lo stesso di Argos (crawl_trace.word_key):
 * minuscole e senza accenti, via le vocali finali tenendo almeno 3 lettere,
 * primi 6 caratteri. Così «turno» e «turni», «linea» e «linee» coincidono.
 */

export type StatoCandidato = "kept" | "below" | "dup" | "dropped";

export interface Candidato {
  id: number;
  document_id: number | null;
  title: string | null;
  category: string | null;
  section: string | null;
  score: number;
  rerank: number | null;
  status: StatoCandidato;
  rank: number;
  final_rank: number | null;
  hits: Record<string, number>;
  snippet: string;
}

export interface Ponte {
  id: number;
  document_id: number | null;
  title: string | null;
  category: string | null;
  section: string | null;
  score: number;
  via: "concept" | "cosine";
  from_id: number | null;
  final_rank: number | null;
  snippet: string;
}

export interface Concetto { id: number; name: string; category: string | null; weight: number; chunk_ids: number[] }
export interface LegameConcetti { a: number; b: number; rel: string; w: number; from: number | null }

export interface TracciaRetrieval {
  kind: "retrieval";
  query: { text: string; terms: string[] };
  settings: { top_k: number; min_score: number; reranker: boolean; graph: boolean; deep: boolean; fast: boolean };
  timings_ms: Record<string, number>;
  pool: Candidato[];
  context: Array<number | null>;
  bridges: Ponte[];
  concepts: Concetto[];
  concept_edges: LegameConcetti[];
  memory: boolean;
  categories: string[];
  error?: string;
}

export interface Frase { text: string; source: number | null; overlap: number; words: string[]; traced: boolean; cited: boolean }
export interface TracciaVerifica { kind: "verify"; claims: Frase[]; traced: number; total: number; tools_used: string[] }

// ─── le parole ──────────────────────────────────────────────────────────────
export function piega(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function chiaveParola(parola: string): string {
  let w = piega(parola);
  if (/^\d+$/.test(w)) return w;
  while (w.length > 3 && "aeiou".includes(w[w.length - 1]!)) w = w.slice(0, -1);
  return w.slice(0, 6);
}

export interface Pezzo { testo: string; termine: string | null }

/**
 * Il testo spezzato in pezzi, con i termini della domanda riconosciuti (per
 * evidenziarli): «Le linee urbane» con il termine «linea» → «Le », «linee»
 * (termine «linea»), « urbane».
 */
export function evidenzia(testo: string, termini: readonly string[]): Pezzo[] {
  const chiavi = new Map<string, string>();
  for (const t of termini) chiavi.set(chiaveParola(t), t);
  const out: Pezzo[] = [];
  if (!testo) return out;
  const rx = /[\p{L}\p{N}]+/gu;
  let ultimo = 0;
  for (const m of testo.matchAll(rx)) {
    const k = chiaveParola(m[0]);
    const termine = m[0].length >= 3 || /^\d{2,}$/.test(m[0]) ? chiavi.get(k) ?? null : null;
    if (!termine) continue;
    const i = m.index ?? 0;
    if (i > ultimo) out.push({ testo: testo.slice(ultimo, i), termine: null });
    out.push({ testo: m[0], termine });
    ultimo = i + m[0].length;
  }
  if (ultimo < testo.length) out.push({ testo: testo.slice(ultimo), termine: null });
  return out;
}

// ─── la scena ───────────────────────────────────────────────────────────────
export interface Fonte {
  n: number;               // Fonte n (1-based, l'ordine dato al modello)
  id: number;
  title: string | null;
  section: string | null;
  category: string | null;
  snippet: string;
  daPonte: boolean;        // arrivata da un ponte, non dalla ricerca
}

export interface Scena {
  domanda: string;
  termini: string[];
  candidati: Candidato[];        // nell'ordine della ricerca
  tenuti: Candidato[];           // i candidati diventati fonte
  scartati: { sottoSoglia: number; doppioni: number; esclusi: number };
  ponti: Ponte[];
  fonti: Fonte[];                // nell'ordine dato al modello
  concetti: Concetto[];
  legami: LegameConcetti[];
  memoria: boolean;
  tempi: Record<string, number>;
  /** per ogni termine, i candidati che lo contengono */
  dove: Record<string, number[]>;
}

export function costruisciScena(t: TracciaRetrieval): Scena {
  const termini = (t.query?.terms ?? []).slice(0, 8);
  const candidati = [...(t.pool ?? [])].sort((a, b) => a.rank - b.rank);
  const perId = new Map<number, Candidato>(candidati.map(c => [c.id, c]));
  const pontiPerId = new Map<number, Ponte>((t.bridges ?? []).map(p => [p.id, p]));
  const fonti: Fonte[] = [];
  (t.context ?? []).forEach((id, i) => {
    if (id == null) return; // la memoria richiamata: non è un passaggio della biblioteca
    const c = perId.get(id);
    const p = pontiPerId.get(id);
    const base = c ?? p;
    if (!base) return;
    fonti.push({
      n: i + 1, id, title: base.title, section: base.section, category: base.category,
      snippet: base.snippet, daPonte: !c && !!p,
    });
  });
  const dove: Record<string, number[]> = {};
  for (const term of termini) {
    dove[term] = candidati.filter(c => (c.hits?.[term] ?? 0) > 0).map(c => c.id);
  }
  return {
    domanda: t.query?.text ?? "",
    termini,
    candidati,
    tenuti: candidati.filter(c => c.status === "kept"),
    scartati: {
      sottoSoglia: candidati.filter(c => c.status === "below").length,
      doppioni: candidati.filter(c => c.status === "dup").length,
      esclusi: candidati.filter(c => c.status === "dropped").length,
    },
    ponti: t.bridges ?? [],
    fonti,
    concetti: t.concepts ?? [],
    legami: t.concept_edges ?? [],
    memoria: !!t.memory,
    tempi: t.timings_ms ?? {},
    dove,
  };
}

/** Le fasi della scena, in ordine: ciascuna con la sua didascalia. */
export const FASI = [
  { chiave: "domanda", titolo: "La domanda", testo: "Argos stacca dalla domanda le parole che contano." },
  { chiave: "ricerca", titolo: "La ricerca", testo: "Le parole vanno in biblioteca: si accendono i passaggi che le contengono." },
  { chiave: "selezione", titolo: "La selezione", testo: "I più deboli escono, i doppioni si fondono, il riordino premia i più pertinenti." },
  { chiave: "legami", titolo: "I legami", testo: "Concetti e ponti collegano passaggi di documenti diversi." },
  { chiave: "fonti", titolo: "Le fonti", testo: "I passaggi scelti passano al modello, numerati." },
  { chiave: "risposta", titolo: "La risposta", testo: "Ogni frase della risposta si aggancia alla fonte da cui viene." },
] as const;
export type ChiaveFase = (typeof FASI)[number]["chiave"];

/** Quanto resta in scena ogni fase (ms), prima della successiva. */
export function durataFase(chiave: ChiaveFase, s: Scena): number {
  switch (chiave) {
    case "domanda": return 900 + s.termini.length * 220;
    case "ricerca": return 900 + Math.min(s.candidati.length, 14) * 120;
    case "selezione": return 1500;
    case "legami": return s.concetti.length || s.ponti.length ? 1600 : 400;
    case "fonti": return 900 + s.fonti.length * 160;
    default: return 0;
  }
}

/** I numeri per la didascalia finale. */
export function riepilogoScena(s: Scena, v: TracciaVerifica | null): { letti: number; tenuti: number; ponti: number; concetti: number; frasi: number; verificate: number } {
  return {
    letti: s.candidati.length,
    tenuti: s.fonti.length,
    ponti: s.ponti.length,
    concetti: s.concetti.length,
    frasi: v?.total ?? 0,
    verificate: v?.traced ?? 0,
  };
}

// ─── chi si vede e i fili ───────────────────────────────────────────────────
/**
 * I candidati da mettere in scena: tutti quelli tenuti più i primi altri,
 * fino a `max`. Prima della selezione nell'ordine della ricerca; dopo, i
 * tenuti in testa (nell'ordine finale), gli altri sotto.
 */
export function candidatiInScena(s: Scena, dopoSelezione: boolean, max = 12): Candidato[] {
  const tenuti = new Set(s.tenuti.map(c => c.id));
  const scelti: Candidato[] = [];
  const posti = Math.max(0, max - s.tenuti.length);
  let altri = 0;
  for (const c of s.candidati) {
    if (tenuti.has(c.id)) scelti.push(c);
    else if (altri < posti) { scelti.push(c); altri++; }
  }
  if (!dopoSelezione) return scelti;
  const fr = (c: Candidato) => c.final_rank ?? Number.MAX_SAFE_INTEGER;
  return [...scelti].sort((a, b) => {
    const ta = tenuti.has(a.id) ? 0 : 1, tb = tenuti.has(b.id) ? 0 : 1;
    return ta - tb || (ta === 0 ? fr(a) - fr(b) : a.rank - b.rank);
  });
}

/** La tinta di una parola della domanda (1–8, nell'ordine; 0 oltre l'ottava). */
export function tintaParola(termine: string, s: Pick<Scena, "termini">): number {
  const i = s.termini.indexOf(termine);
  return i >= 0 && i < 8 ? i + 1 : 0;
}

export type TipoFilo = "parola" | "concetto" | "ponte" | "frase";
export interface Filo { id: string; da: string; a: string; tipo: TipoFilo; termine?: string; etichetta?: string; debole?: boolean }

const MAX_FILI_PAROLE = 24;
const MAX_CONCETTI_IN_SCENA = 6;

/**
 * I fili da tendere in una fase: le «àncore» sono gli elementi della scena
 * (t:parola, k:concetto, c:passaggio, f:frase). Nella ricerca ogni parola va
 * ai passaggi che la contengono; nella selezione i fili verso gli scartati si
 * affievoliscono; nei legami i concetti vanno ai loro passaggi e i ponti al
 * passaggio da cui partono; nella risposta la frase scelta va alla sua fonte.
 */
export function filiDellaFase(
  s: Scena, fase: ChiaveFase, visibili: ReadonlySet<number>, frase?: { indice: number; fonte: number | null; parole: string[] } | null,
): Filo[] {
  const fili: Filo[] = [];
  const tenuti = new Set(s.tenuti.map(c => c.id));
  if (fase === "ricerca" || fase === "selezione") {
    for (const t of s.termini) {
      for (const id of s.dove[t] ?? []) {
        if (!visibili.has(id) || fili.length >= MAX_FILI_PAROLE) continue;
        fili.push({ id: `t:${t}>c:${id}`, da: `t:${t}`, a: `c:${id}`, tipo: "parola", termine: t, etichetta: t, debole: fase === "selezione" && !tenuti.has(id) });
      }
    }
  } else if (fase === "legami") {
    const inScena = new Set([...visibili, ...s.ponti.map(p => p.id)]);
    for (const k of s.concetti.slice(0, MAX_CONCETTI_IN_SCENA)) {
      for (const id of k.chunk_ids) {
        if (inScena.has(id)) fili.push({ id: `k:${k.id}>c:${id}`, da: `k:${k.id}`, a: `c:${id}`, tipo: "concetto", etichetta: k.name });
      }
    }
    for (const p of s.ponti) {
      if (p.from_id != null && inScena.has(p.from_id)) fili.push({ id: `c:${p.from_id}>c:${p.id}`, da: `c:${p.from_id}`, a: `c:${p.id}`, tipo: "ponte" });
    }
  } else if (fase === "risposta" && frase && frase.fonte != null) {
    const f = s.fonti.find(x => x.n === frase.fonte);
    if (f) fili.push({ id: `c:${f.id}>f:${frase.indice}`, da: `c:${f.id}`, a: `f:${frase.indice}`, tipo: "frase", etichetta: frase.parole.slice(0, 2).join(" · ") || `Fonte ${f.n}` });
  }
  return fili;
}

/** I concetti messi in scena (i più pesanti). */
export function concettiInScena(s: Scena): Concetto[] {
  return s.concetti.slice(0, MAX_CONCETTI_IN_SCENA);
}

/** Il motivo per cui un candidato è uscito, in parole. */
export function motivoScarto(stato: StatoCandidato): string | null {
  switch (stato) {
    case "below": return "sotto la soglia";
    case "dup": return "doppione";
    case "dropped": return "escluso dal riordino";
    default: return null;
  }
}

/** Da dove arriva un ponte, in parole. */
export function viaPonte(p: Pick<Ponte, "via">): string {
  return p.via === "concept" ? "da un concetto in comune" : "da un passaggio affine";
}
