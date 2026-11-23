/**
 * Lo sciame di Argos: la rete che legge, sceglie, collega e scrive, su canvas.
 *
 * È il crawler della vecchia pagina di Argos (frontend/crawler.html), portato
 * qui e guidato dagli eventi di un turno di conversazione:
 *   - il campo: una nebulosa di particelle per categoria, un ammasso per
 *     documento della biblioteca (la mappa dei documenti di Argos);
 *   - il nucleo con le zampe che si appoggiano alle particelle e l'alone di
 *     filamenti, che si sposta dove sta leggendo;
 *   - i tentacoli verso i passaggi letti, tenuti, scartati, i ponti fra
 *     documenti, i concetti, le parole che volano verso la risposta, e alla
 *     fine un tentacolo per ogni frase verso la fonte da cui viene.
 *
 * Niente è inventato: tutto viene dalla traccia di Argos (evento «trace»:
 * retrieval e verifica), dagli strumenti chiamati e dal testo. Senza traccia
 * (agenti, o traccia spenta sul server) lo sciame mostra la domanda, gli
 * strumenti e le parole; il percorso si ricostruisce dalle fonti finali.
 *
 * Le funzioni pure (termini, traccia normalizzata, citazioni, riepilogo) sono
 * esportate e provate in argos-sciame.test.ts; la classe Sciame è il disegno.
 */

// ─── tipi della traccia (argos/api/crawl_trace.py) ──────────────────────────
export type Id = number | string;

export interface Passaggio {
  id: Id;
  document_id: Id | null;
  title: string | null;
  category: string | null;
  section: string | null;
  score: number;
  rerank?: number | null;
  status?: string;
  rank?: number;
  final_rank: number | null;
  hits?: Record<string, number>;
  snippet?: string;
  /** solo per i ponti */
  via?: string;
  from_id?: Id | null;
  /** un candidato riportato nel contesto da un ponte */
  viaBridge?: boolean;
}
export interface ConcettoTraccia { id: Id; name: string; category: string | null; weight: number; chunk_ids?: Id[] }
export interface ArcoConcetti { a: Id; b: Id; rel: string; w: number; from: Id | null }
export interface TracciaRetrieval {
  kind: "retrieval";
  error?: string;
  synthetic?: boolean;
  query?: { text?: string; terms?: string[] };
  settings?: Record<string, unknown>;
  timings_ms?: Record<string, number>;
  pool?: Passaggio[];
  context?: Array<Id | null>;
  bridges?: Passaggio[];
  concepts?: ConcettoTraccia[];
  concept_edges?: ArcoConcetti[];
  memory?: boolean;
  categories?: string[];
}
export interface Affermazione { text: string; source: number | null; overlap?: number; words?: string[]; traced: boolean; cited?: boolean; unk?: boolean }
export interface TracciaVerifica { kind: "verify"; error?: string; claims?: Affermazione[]; traced?: number; total?: number; tools_used?: string[] }

/** Un documento della mappa (GET /mappa/documenti, lo stesso /graph di Argos). */
export interface DocumentoMappa { id: Id; title: string; category: string | null; chunks: number }
export interface Mappa { nodes: DocumentoMappa[]; categories?: string[] }

/** La traccia normalizzata: indici e liste usati dalla regia e dal riepilogo. */
export interface Ricerca {
  pool: Passaggio[];
  bridges: Passaggio[];
  byId: Map<Id, Passaggio>;
  brIds: Set<Id>;
  ctx: Array<Id | null>;
  terms: string[];
  concepts: ConcettoTraccia[];
  cedges: ArcoConcetti[];
  synthetic: boolean;
  memory: boolean;
  timings: Record<string, number>;
  categories: string[];
}

// ─── fasi, colori ───────────────────────────────────────────────────────────
export const FASI_SCIAME = [
  { k: "domanda", n: "DOMANDA", s: "cosa mi stai chiedendo?" },
  { k: "ricerca", n: "RICERCA", s: "dove se ne parla?" },
  { k: "rerank", n: "RERANK", s: "cosa è davvero pertinente?" },
  { k: "contesto", n: "CONTESTO", s: "cosa leggo per rispondere?" },
  { k: "ponti", n: "PONTI", s: "quali documenti si collegano?" },
  { k: "concetti", n: "CONCETTI", s: "quali idee entrano in gioco?" },
  { k: "risposta", n: "RISPOSTA", s: "scrivo la risposta" },
  { k: "verifica", n: "VERIFICA", s: "ogni affermazione ha una fonte?" },
] as const;

const TAU = Math.PI * 2;
const MONO = '"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace';
/** Colori per categoria: gli stessi della mappa di Argos, nell'ordine delle categorie. */
const PALETTE = ["#10B981", "#6366F1", "#F59E0B", "#22D3EE", "#F472B6", "#A3E635", "#EF4444", "#A855F7", "#FDE68A", "#93C5FD", "#86EFAC", "#FDBA74"];
export const SENZA_CATEGORIA = "Senza categoria";
const UNCAT_COL = "#9CA3AF";
const REL_COL: Record<string, string> = { prerequisito: "#FBBF24", generalizza: "#A78BFA", applica: "#34D399", contraddice: "#FB7185", correlato: "#96A5C8" };
const CERBERO_COL = "#FB7185";
const C = { teal: "#2DD4BF", pink: "#F472B6", hot: "#FF3D8B", lilac: "#A78BFA", violet: "#8B5CF6", amber: "#F59E0B", yellow: "#FBBF24", rose: "#FB7185" };
type StilePillola = "read" | "kept" | "ctx" | "dup" | "dim" | "flag" | "bridge" | "tool" | "term" | "unk";
const PILL: Record<StilePillola, { br: string; bg: string; tx: string; dash?: boolean }> = {
  read: { br: "rgba(226,232,240,.6)", bg: "rgba(6,6,9,.88)", tx: "#E5E7EB" },
  kept: { br: "rgba(45,212,191,.9)", bg: "rgba(3,22,20,.88)", tx: "#99F6E4" },
  ctx: { br: "rgba(45,212,191,.95)", bg: "rgba(9,44,41,.94)", tx: "#CCFBF1" },
  dup: { br: "rgba(245,158,11,.9)", bg: "rgba(26,15,2,.88)", tx: "#FCD34D" },
  dim: { br: "rgba(255,255,255,.16)", bg: "rgba(6,6,9,.86)", tx: "rgba(200,200,212,.55)" },
  flag: { br: "#F472B6", bg: "rgba(244,114,182,.9)", tx: "#2A0618" },
  bridge: { br: "rgba(251,191,36,.85)", bg: "rgba(22,16,4,.88)", tx: "#FDE68A" },
  tool: { br: "rgba(251,113,133,.95)", bg: "rgba(32,6,12,.88)", tx: "#FECDD3" },
  term: { br: "rgba(167,139,250,.9)", bg: "rgba(14,10,30,.88)", tx: "#DDD6FE" },
  unk: { br: "rgba(255,255,255,.3)", bg: "rgba(6,6,9,.86)", tx: "rgba(226,226,234,.72)", dash: true },
};
const TCOL: Record<string, string> = {
  read: "rgba(94,234,212,.55)", read2: "rgba(244,114,182,.5)", kept: "rgba(45,212,191,.85)", ctx: "rgba(45,212,191,.9)", dup: "rgba(245,158,11,.75)",
  dim: "rgba(160,160,175,.22)", flag: "rgba(244,114,182,.9)", tool: "rgba(251,113,133,.85)", term: "rgba(167,139,250,.75)", bridge: "rgba(251,191,36,.7)", unk: "rgba(200,200,210,.35)",
};

// ─── utilità pure ───────────────────────────────────────────────────────────
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); };
const easeIO = (t: number) => { t = clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export function hash32(s: unknown): number {
  const x = String(s);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * r()); }
export const corto = (s: unknown, n: number) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",") + "k" : String(n));
const fold = (w: string) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const hx = (h: string): [number, number, number] => { const x = (h || "").replace("#", ""); return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]; };
const withA = (c: string, a: number | string) => { const [r, g, b] = hx(c); return `rgba(${r},${g},${b},${a})`; };
const lighten = (c: string, t: number) => { const [r, g, b] = hx(c); return `rgb(${[r, g, b].map(v => Math.round(v + (255 - v) * t)).join(",")})`; };
const lightenA = (c: string, t: number, a: number) => { const [r, g, b] = hx(c); return `rgba(${[r, g, b].map(v => Math.round(v + (255 - v) * t)).join(",")},${a})`; };
function hslHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return "#" + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}
export const nomeCategoria = (c: string | null | undefined) => c || SENZA_CATEGORIA;

/** Parole vuote italiane: i termini della domanda lato client e le citazioni di riserva. */
const STOP = new Set((
  "a ad al allo alla ai agli alle all c ce ci col coi con contro cui d da dal dallo dalla dai dagli dalle dall de dei del dello della degli delle dell di e ed " +
  "fra gli i il in l la le lo ne negli nel nello nella nei nelle nell o od per sui sul sullo sulla sugli sulle sull su tra un una uno anche ancora allora altro altra altri altre " +
  "che chi come cosa cose dove dunque gia infatti inoltre invece mai meno mentre molto molta molti molte no non ogni oppure ora perche pero piu poco poi pure quale quali " +
  "qualche quando quanto quanta quanti quante quello quella quelli quelle questo questa questi queste se si sia sono stato stata essere ho hai ha abbiamo avete hanno e era " +
  "mi ti vi lui lei noi voi loro mio mia tuo tua suo sua nostro vostro tutto tutti tutte fa fare puo possono deve devono devo viene vengono dimmi spiegami parlami vorrei " +
  "sapere qual cos").split(/\s+/));

/** I termini di una domanda (al più 8), senza parole vuote: quando la traccia non li porta. */
export function terminiDomanda(q: string): string[] {
  const out: string[] = [];
  for (const w of String(q || "").toLowerCase().match(/[a-zà-ÿ0-9]+/g) || []) {
    const f = fold(w);
    if (f.length < 3 || STOP.has(f) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}
export const parole = (s: string): string[] => String(s || "").match(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9'’-]*/g) || [];

const numero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * La traccia del retrieval normalizzata. Un candidato che è anche un ponte
 * risulta «tenuto» solo perché il ponte lo riporta nel contesto: al rerank
 * il riranker non l'ha tenuto, lo riprende la fase dei ponti.
 */
export function preparaRicerca(tr: TracciaRetrieval, domanda: string): Ricerca {
  const bridges = (Array.isArray(tr.bridges) ? tr.bridges : []).filter(b => b && b.id != null);
  const brIds = new Set<Id>(bridges.map(b => b.id));
  const minS = numero(tr.settings?.min_score);
  const pool = (Array.isArray(tr.pool) ? tr.pool : []).filter(c => c && c.id != null).slice(0, 60)
    .map(c => (brIds.has(c.id) && c.status === "kept"
      ? { ...c, status: numero(c.score) < minS ? "below" : "dropped", final_rank: null, viaBridge: true }
      : c));
  const byId = new Map<Id, Passaggio>();
  pool.forEach(c => byId.set(c.id, c));
  bridges.forEach(b => { if (!byId.has(b.id)) byId.set(b.id, b); });
  const ctx = Array.isArray(tr.context)
    ? tr.context.slice(0, 40)
    : [...pool.filter(c => c.status === "kept").sort((a, b) => (a.final_rank || 99) - (b.final_rank || 99)).map(c => c.id), ...bridges.map(b => b.id)];
  const terms = tr.query && Array.isArray(tr.query.terms) && tr.query.terms.length ? tr.query.terms.slice(0, 8).map(String) : terminiDomanda(domanda);
  const concepts = (Array.isArray(tr.concepts) ? tr.concepts : []).filter(k => k && k.id != null).slice(0, 12);
  const cids = new Set<Id>(concepts.map(k => k.id));
  const cedges = (Array.isArray(tr.concept_edges) ? tr.concept_edges : []).filter(e => e && cids.has(e.a) && cids.has(e.b)).slice(0, 30);
  return {
    pool, bridges, byId, brIds, ctx, terms, concepts, cedges,
    synthetic: !!tr.synthetic, memory: !!tr.memory, timings: tr.timings_ms || {},
    categories: Array.isArray(tr.categories) ? tr.categories.map(String) : [],
  };
}

/** Senza traccia: un percorso ricostruito dalle fonti finali della risposta (done.sources). */
export function tracciaDalleFonti(fonti: unknown[], domanda: string, categoriaDi: (doc: Id | null) => string | null, categorie: string[] = []): TracciaRetrieval {
  const pool: Passaggio[] = [], bridges: Passaggio[] = [], context: Id[] = [];
  (Array.isArray(fonti) ? fonti : []).forEach((x, i) => {
    const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const id = "s" + i;
    const doc = (typeof s.document_id === "number" || typeof s.document_id === "string") ? s.document_id : null;
    const c: Passaggio = {
      id, document_id: doc, title: typeof s.document_title === "string" ? s.document_title : `Documento ${doc ?? i + 1}`,
      category: categoriaDi(doc), section: typeof s.section === "string" ? s.section : null, score: numero(s.score),
      rerank: null, status: "kept", rank: i + 1, final_rank: i + 1, hits: {}, snippet: "",
    };
    if (s.linked) bridges.push({ ...c, via: "cosine", from_id: null }); else pool.push(c);
    context.push(id);
  });
  return { kind: "retrieval", synthetic: true, query: { text: domanda, terms: terminiDomanda(domanda) }, pool, context, bridges, concepts: [], concept_edges: [], memory: false, categories: categorie };
}

/** Le citazioni esplicite «Fonte N» del testo: quando manca la verifica del server. */
export function citazioniEsplicite(md: string): Affermazione[] {
  const out: Affermazione[] = [];
  let fence = false;
  for (const line of String(md || "").split("\n")) {
    const tl = line.trim();
    if (tl.startsWith("```")) { fence = !fence; continue; }
    if (fence || !tl || /^#{1,6}\s/.test(tl) || /^\|?[\s:\-|]+\|?$/.test(tl)) continue;
    const plain = tl.replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/[*_`>#]/g, "");
    let prev: Affermazione | null = null;
    for (const s of plain.replace(/([.!?;])\s+/g, "$1\u0001").split("\u0001")) {
      const m = s.match(/\bFonte\s*(\d+)/i);
      if (parole(s).length < 6) {
        if (m && prev && !prev.cited) Object.assign(prev, { source: +m[1]!, traced: true, cited: true, unk: false });
        continue;
      }
      prev = m ? { text: corto(s, 220), source: +m[1]!, traced: true, cited: true, words: [] } : { text: corto(s, 220), source: null, traced: false, unk: true };
      out.push(prev);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

// ─── il riepilogo per la piccola dashboard ──────────────────────────────────
export interface RiepilogoSciame {
  candidati: number;
  tenuti: number;
  fonti: number;
  ponti: number;
  concetti: number;
  relazioni: number;
  strumenti: string[];
  affermazioni: number;
  tracciate: number;
  senzaFonte: number;
  nonVerificabili: number;
  verificaDisponibile: boolean;
  ricostruita: boolean;
  memoria: boolean;
  categorie: Array<{ nome: string; colore: string; candidati: number; tenuti: number }>;
  secondi: number | null;
  tokens: number | null;
}

/** Che cosa ha fatto la rete in un turno, dai dati del turno (puro: lo provano i test). */
export function riepilogoDi(
  R: Ricerca | null, verifica: TracciaVerifica | null, strumenti: readonly string[], colore: (cat: string) => string,
  extra: { secondi?: number | null; tokens?: number | null } = {},
): RiepilogoSciame {
  const visti = new Set<Id>();
  const perCat = new Map<string, { candidati: number; tenuti: number }>();
  const inCtx = new Set<Id>((R?.ctx ?? []).filter((x): x is Id => x != null));
  for (const c of R ? [...R.pool, ...R.bridges] : []) {
    if (visti.has(c.id)) continue;
    visti.add(c.id);
    const n = nomeCategoria(c.category);
    const s = perCat.get(n) ?? { candidati: 0, tenuti: 0 };
    s.candidati++;
    if (inCtx.has(c.id)) s.tenuti++;
    perCat.set(n, s);
  }
  const claims = verifica && Array.isArray(verifica.claims) ? verifica.claims : null;
  const tracciate = claims ? claims.filter(c => c.traced).length : 0;
  const nonVer = claims ? claims.filter(c => !c.traced && c.unk).length : 0;
  return {
    candidati: visti.size,
    tenuti: R ? R.pool.filter(c => c.status === "kept" && !R.brIds.has(c.id)).length : 0,
    fonti: inCtx.size + (R?.ctx.some(x => x == null) ? 1 : 0),
    ponti: R ? R.bridges.filter(b => inCtx.has(b.id)).length : 0,
    concetti: R ? R.concepts.length : 0,
    relazioni: R ? R.cedges.length : 0,
    strumenti: [...strumenti],
    affermazioni: claims ? claims.length : 0,
    tracciate,
    senzaFonte: claims ? claims.length - tracciate - nonVer : 0,
    nonVerificabili: nonVer,
    verificaDisponibile: !!claims,
    ricostruita: !!R?.synthetic,
    memoria: !!R?.memory,
    categorie: [...perCat.entries()].sort((a, b) => b[1].candidati - a[1].candidati).map(([nome, s]) => ({ nome, colore: colore(nome), ...s })),
    secondi: extra.secondi ?? null,
    tokens: extra.tokens ?? null,
  };
}

// ─── la scena ───────────────────────────────────────────────────────────────
export interface StatoSciame {
  /** fase 0..7 (FASI_SCIAME) */
  fase: number;
  /** il turno è finito e la scena ha raccontato tutto */
  finito: boolean;
  /** lo stream è ancora aperto */
  inCorso: boolean;
  /** righe brevi sotto il titolo: candidati, tenuti, ponti… */
  meta: string[];
  puoRivedere: boolean;
}

interface OpzioniSciame { onStato?: (s: StatoSciame) => void }

type EsitoCorsa = "running" | "done" | "error" | "aborted";
interface Corsa {
  q: string; answer: string; wordQ: string[]; tools: string[]; R: Ricerca | null; verify: TracciaVerifica | null;
  status: EsitoCorsa; err: string | null; t0: number; tEnd: number | null; answerDone: boolean; tokens: number | null; sources: unknown[];
}
interface StatoPassaggio { st: string; glow: number; fr?: number | null }
interface Bersaglio { chunk?: Id; cer?: number; rel?: [number, number] }
interface Tentacolo {
  tg: Bersaglio; text: string; style: StilePillola; born: number; die: number; seed: number; bend: number; key: string; alt: boolean; hide: boolean;
  vn?: number; vw?: string[]; vc?: boolean; vt?: number;
}
interface Arco { from: Id | null | undefined; to: Id; born: number; text: string; seed: number; fr: number | null; cut: boolean }
interface ConcettoScena { id: Id; name: string; cat: string; w: number; chunks: Id[]; born: number; ang: number; ring: number }
interface Parola { w: string; born: number; dur: number; x0: number; y0: number; bend: number }
interface StatScena {
  stage: number; terms: Array<{ w: string; born: number }>; termGen: number; termFade: number | null; chunk: Map<Id, StatoPassaggio>;
  tent: Tentacolo[]; arcs: Arco[]; concepts: ConcettoScena[]; cedges: ArcoConcetti[]; words: Parola[];
  cat: Map<string, { cand: number; read: number; kept: number }>; focusIds: Id[] | null; focusBias: Id | null; activeCat: string | null;
  ctxIds: Id[]; claims: number; traced: number; unk: number; noSrc: number; cerLit: number; tools: number; lastTool: string; finished: boolean;
  flowAcc: number; memory: boolean; verifyNA: boolean; vSrc: Map<number, Tentacolo>; vFlags: Tentacolo[]; vAgg: Tentacolo | null;
}
interface Ammasso { doc: DocumentoMappa; cl: Nebulosa; x: number; y: number; sig: number; s: number; e: number; big: boolean }
interface Nebulosa {
  name: string; cat: string; col: string; x: number; y: number; r: number; docs: Ammasso[]; ndocs: number; chunks: number; s: number; e: number;
  lx: number; ly: number; lw: number; sx?: number; sy?: number; la?: number;
}
interface Zampa {
  a: number; l1: number; l2: number; fx: number; fy: number; ox: number; oy: number; tx: number; ty: number; t: number; timer: number; grp: number; flash: number;
  kx: number; ky: number; hx: number; hy: number; dfx: number; dfy: number;
}
interface Filamento { a: number; len: number; f: number; ph: number; c: number; tx: number; ty: number; dot: boolean }
interface Rett { x: number; y: number; w: number; h: number }
interface Etichetta { x: number; y: number; t: string; font: string; col: string; align: CanvasTextAlign; halo?: boolean; ob?: number; kind?: string; skip?: boolean }
interface Pillola { key: string; x: number; y: number; text: string; style: StilePillola; alpha: number; dx: number; dy: number }

const VUOTI = { px: new Float32Array(0), py: new Float32Array(0) };

export class Sciame {
  private readonly cv: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onStato?: (s: StatoSciame) => void;
  private readonly ridotto: boolean;
  private CW = 1; private CH = 1; private DPR = 1;
  private STAGE = { x0: 0, y0: 0, x1: 1, y1: 1, w: 1, h: 1, cx: 0, cy: 0 };
  private TITLE: Rett = { x: 0, y: 0, w: 0, h: 0 };
  private AVOID: Rett[] = [];
  private mappa: Mappa | null = null;
  private readonly catColors = new Map<string, string>();
  // il campo
  private F = {
    n: 0, clusters: [] as Nebulosa[], docs: new Map<Id, Ammasso>(), cer: null as null | { x: number; y: number; r: number; s: number; e: number },
    groups: [] as Int32Array[], gcol: [] as string[], cerG: -1, mesh: new Int32Array(0), grid: [] as Array<number[] | undefined>, gw: 0, gh: 0, gx0: 0, gy0: 0, cell: 22,
    px: VUOTI.px, py: VUOTI.py, ps: new Float32Array(0), pa: new Float32Array(0), ph: new Float32Array(0), pf: new Float32Array(0), st: new Uint8Array(0),
    inA: new Uint8Array(0), aura: new Int32Array(0), chunkP: new Map<Id, number>(), layer: null as HTMLCanvasElement | null, layerW: 0, layerH: 0, M: 90,
    prev: null as HTMLCanvasElement | null, prevW: 0, prevH: 0, prevM: 90, fade: 1, placeholder: true,
  };
  // la regia
  private RUN: Corsa | null = null;
  private S: StatScena = Sciame.scenaVuota(0);
  private TL = { ev: [] as Array<{ t: number; fn: (a: boolean) => void }>, i: 0, clock: 0, live: false, hold: Infinity, start: Array<number | null>(8).fill(null), rispAt: null as number | null, verAt: null as number | null };
  private TKEY = 0;
  // il crawler
  private CR = { x: 0, y: 0, vx: 0, vy: 0, head: 0, rot: 0, R: 14, reach: 56, legs: [] as Zampa[], fil: [] as Filamento[], gait: 0, gg: 0, excite: 0.85, snap: true };
  private CAM = { ox: 0, oy: 0, z: 1 };
  private RT = 0;
  // il disegno
  private readonly PILLS: Pillola[] = [];
  private readonly PILLOFF = new Map<string, number>();
  private readonly LABELS: Etichetta[] = [];
  private readonly PILLR: Rett[] = [];
  private readonly OBST: Rett[] = [];
  private readonly TW = new Map<string, number>();
  private readonly SPR = new Map<string, HTMLCanvasElement>();
  private cpos = new Map<Id, { x: number; y: number }>();
  // il ciclo
  private raf = 0;
  private last = 0;
  private acc = 0;
  private fermo = false;
  private morto = false;
  private resizeT: ReturnType<typeof setTimeout> | undefined;
  private statoPrec = "";

  constructor(canvas: HTMLCanvasElement, o: OpzioniSciame = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2D non disponibile");
    this.cv = canvas;
    this.ctx = ctx;
    this.onStato = o.onStato;
    this.ridotto = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this.measure();
    this.buildField();
    this.CR.x = this.STAGE.cx; this.CR.y = this.STAGE.cy;
    this.initCrawler();
    this.CR.snap = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    this.notifica(true);
  }

  private static scenaVuota(termGen: number): StatScena {
    return {
      stage: 0, terms: [], termGen, termFade: null, chunk: new Map(), tent: [], arcs: [], concepts: [], cedges: [], words: [],
      cat: new Map(), focusIds: null, focusBias: null, activeCat: null, ctxIds: [], claims: 0, traced: 0, unk: 0, noSrc: 0, cerLit: 0, tools: 0,
      lastTool: "", finished: false, flowAcc: 0, memory: false, verifyNA: false, vSrc: new Map(), vFlags: [], vAgg: null,
    };
  }

  // ─── API ─────────────────────────────────────────────────────────────────
  /** La mappa dei documenti: le nebulose del campo. Si può dare in ogni momento. */
  impostaMappa(m: Mappa | null): void {
    this.mappa = m && Array.isArray(m.nodes) ? m : null;
    if (this.mappa?.categories) this.assignColors(this.mappa.categories.map(nomeCategoria));
    this.buildField();
  }

  /** Un turno parte: la domanda entra in scena. */
  avvia(domanda: string): void {
    this.RUN = { q: domanda, answer: "", wordQ: [], tools: [], R: null, verify: null, status: "running", err: null, t0: performance.now(), tEnd: null, answerDone: false, tokens: null, sources: [] };
    this.resetScene();
    this.tlReset(true);
    this.schedDomanda(0, terminiDomanda(domanda));
    this.notifica(true);
  }

  /** Un evento dello stream del turno (lo stesso JSON che legge la chat). */
  evento(obj: unknown): void {
    const RUN = this.RUN;
    if (!RUN || RUN.status !== "running" || !obj || typeof obj !== "object") return;
    const e = obj as Record<string, unknown>;
    if (typeof e.t === "string") this.onText(e.t);
    else if (e.reset) { RUN.answer = ""; RUN.wordQ.length = 0; }
    else if (e.tool && typeof e.tool === "object") {
      const n = String((e.tool as { name?: unknown }).name || "strumento");
      RUN.tools.push(n);
      this.toolHit(n, true);
    } else if (typeof e.error === "string") RUN.err = e.error;
    else if (e.trace && typeof e.trace === "object") {
      const tr = e.trace as { kind?: string; error?: string };
      if (tr.kind === "retrieval") this.onTrace(e.trace as TracciaRetrieval);
      else if (tr.kind === "verify" && !tr.error) RUN.verify = e.trace as TracciaVerifica;
    } else if (e.done) {
      const d = e.done;
      RUN.answerDone = true;
      const tok = typeof d === "object" && d ? (d as { tokens?: unknown }).tokens : e.tokens;
      if (typeof tok === "number") RUN.tokens = tok;
      if (Array.isArray(e.sources)) RUN.sources = e.sources;
      if (!RUN.R) this.daFonti();
    }
  }

  /** Lo stream è chiuso: «done», «error» (con il messaggio) o «aborted». */
  fine(status: "done" | "error" | "aborted", msg?: string | null): void {
    const RUN = this.RUN;
    if (!RUN || RUN.status !== "running") return;
    if (msg) RUN.err = msg;
    let st: EsitoCorsa = status;
    if (RUN.err && st !== "aborted") st = "error";
    RUN.status = st;
    RUN.tEnd = performance.now();
    const TL = this.TL, S = this.S;
    if (st === "done") { RUN.answerDone = true; if (!RUN.R) this.daFonti(); }
    else if (st === "error" && RUN.R && !RUN.R.synthetic && TL.rispAt != null && TL.clock < TL.rispAt) {
      // errore a metà risposta con la traccia intera: lo sciame finisce il recupero e si ferma su RISPOSTA
      TL.hold = TL.rispAt;
      this.ev(TL.rispAt, () => { S.finished = true; this.notifica(true); });
    } else { TL.hold = TL.clock; S.finished = true; }
    this.notifica(true);
  }

  /** Rifà la scena dell'ultimo turno, senza nuove richieste. */
  rivedi(): boolean {
    if (!this.puoRivedere()) return false;
    this.buildReplay();
    this.notifica(true);
    return true;
  }

  /** Il riepilogo dell'ultimo turno, per la dashboard. */
  riepilogo(): RiepilogoSciame | null {
    const RUN = this.RUN;
    if (!RUN) return null;
    const ms = RUN.tEnd != null ? RUN.tEnd - RUN.t0 : null;
    return riepilogoDi(RUN.R, RUN.verify, RUN.tools, c => this.catColor(c), { secondi: ms != null ? ms / 1000 : null, tokens: RUN.tokens });
  }

  /** Il palco ha cambiato misura (ResizeObserver): si ricostruisce, con calma. */
  ridimensiona(): void {
    clearTimeout(this.resizeT);
    this.resizeT = setTimeout(() => {
      if (this.morto) return;
      const r = this.cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (Math.abs(r.width - this.CW) < 2 && Math.abs(r.height - this.CH) < 2 && dpr === this.DPR) return;
      this.measure(); this.buildField(); this.initCrawler(); this.CR.snap = true;
    }, 160);
  }

  /** Ferma il disegno (palco chiuso) o lo riprende. */
  pausa(ferma: boolean): void {
    if (this.fermo === ferma || this.morto) return;
    this.fermo = ferma;
    if (!ferma) { this.last = performance.now(); cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.frame); }
  }

  distruggi(): void {
    this.morto = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.resizeT);
  }

  // ─── stato verso React ───────────────────────────────────────────────────
  private puoRivedere(): boolean { return !!this.RUN && !!this.RUN.R && this.RUN.status !== "running"; }

  private notifica(forza = false): void {
    if (!this.onStato) return;
    const S = this.S, RUN = this.RUN, R = RUN?.R ?? null;
    const meta: string[] = [];
    if (R && R.synthetic && !R.pool.length && !R.bridges.length) {
      // un agente che non ha cercato nei documenti: si dice quello, non una fila di zeri
      meta.push("nessuna ricerca nei documenti");
      if (RUN?.tools.length) meta.push(`${RUN.tools.length} strument${RUN.tools.length === 1 ? "o" : "i"} · ${corto(RUN.tools[RUN.tools.length - 1], 28)}`);
      if (RUN?.status === "error" && RUN.err && S.finished) meta.push("errore · " + corto(RUN.err, 70));
    } else if (R) {
      const kept = R.pool.filter(c => c.status === "kept" && !R.brIds.has(c.id)).length;
      meta.push(`${R.pool.length} candidati · ${kept} tenuti · ${R.bridges.length} ponti · ${R.concepts.length} concetti`);
      const t = R.timings;
      if (R.synthetic) meta.push("percorso ricostruito dalle fonti");
      else if (t && (t.embed || t.search || t.rerank)) meta.push(`embed ${t.embed | 0}ms · ricerca ${t.search | 0}ms · rerank ${t.rerank | 0}ms`);
      if (RUN?.status === "error" && RUN.err && S.finished) meta.push("errore · " + corto(RUN.err, 70));
      else if (S.verifyNA) meta.push("verifica non disponibile");
      else if (S.finished && S.claims - S.unk > 0) meta.push(`${S.traced}/${S.claims - S.unk} affermazioni con fonte`);
    } else if (RUN?.tools.length) meta.push(`${RUN.tools.length} strument${RUN.tools.length === 1 ? "o" : "i"} · ${corto(RUN.tools[RUN.tools.length - 1], 28)}`);
    const st: StatoSciame = { fase: clamp(S.stage, 0, 7), finito: S.finished, inCorso: RUN?.status === "running", meta, puoRivedere: this.puoRivedere() };
    const k = JSON.stringify(st);
    if (!forza && k === this.statoPrec) return;
    this.statoPrec = k;
    try { this.onStato(st); } catch (e) { console.warn("sciame: onStato", e); }
  }

  // ─── colori ──────────────────────────────────────────────────────────────
  private assignColors(list: readonly string[]): void {
    for (const c of list) {
      if (!c || c === SENZA_CATEGORIA || this.catColors.has(c)) continue;
      const i = this.catColors.size;
      this.catColors.set(c, i < PALETTE.length ? PALETTE[i]! : hslHex((i * 137.508) % 360, 68, 62));
    }
  }
  catColor(c: string | null | undefined): string {
    const n = nomeCategoria(c);
    if (n === SENZA_CATEGORIA) return UNCAT_COL;
    if (!this.catColors.has(n)) this.assignColors([n]);
    return this.catColors.get(n) ?? UNCAT_COL;
  }
  private spr(col: string): HTMLCanvasElement {
    const s = this.SPR.get(col);
    if (s) return s;
    const r = 32, c = document.createElement("canvas");
    c.width = c.height = r * 2;
    const g = c.getContext("2d");
    if (g) {
      const gr = g.createRadialGradient(r, r, 0, r, r, r);
      gr.addColorStop(0, withA(col, 1)); gr.addColorStop(0.22, withA(col, 0.5)); gr.addColorStop(1, withA(col, 0));
      g.fillStyle = gr; g.fillRect(0, 0, 2 * r, 2 * r);
    }
    this.SPR.set(col, c);
    return c;
  }

  // ─── misure ──────────────────────────────────────────────────────────────
  private mobile(): boolean { return this.CW <= 640; }
  /** scala del crawler: è il protagonista, più piccolo sui palchi stretti */
  private CS(): number { return this.CW < 420 ? 0.68 : this.CW < 760 ? 0.8 : 1; }
  private LBL() { const w = this.CW; return w < 420 ? { n: 9.5, s: 7.8, a: 10.5, lh: 21 } : w < 760 ? { n: 10.5, s: 8.5, a: 11.5, lh: 24 } : { n: 12, s: 9.5, a: 14, lh: 29 }; }

  private measure(): void {
    const r = this.cv.getBoundingClientRect();
    this.CW = Math.max(1, Math.round(r.width)); this.CH = Math.max(1, Math.round(r.height));
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = Math.round(this.CW * this.DPR); this.cv.height = Math.round(this.CH * this.DPR);
    const mob = this.mobile();
    // in alto il titolo della fase (React, in alto a sinistra), in basso la chat che riceve le parole
    const y0 = mob ? 54 : 70, y1 = this.CH - 14;
    Object.assign(this.STAGE, { x0: 0, y0, x1: this.CW, y1, w: this.CW, h: Math.max(120, y1 - y0), cx: this.CW / 2, cy: (y0 + y1) / 2 });
    // il titolo della fase con le sue righe (PalcoNeurale.tsx): le etichette non ci vanno sotto
    this.TITLE = { x: 4, y: 4, w: mob ? 230 : 330, h: mob ? 52 : 88 };
    this.AVOID = [this.TITLE];
  }

  // ─── il campo ────────────────────────────────────────────────────────────
  private fieldSpec(): { docs: DocumentoMappa[]; cats: string[] } {
    const docs = new Map<Id, DocumentoMappa>();
    if (this.mappa) for (const n of this.mappa.nodes) docs.set(n.id, { id: n.id, title: n.title, category: nomeCategoria(n.category), chunks: Math.max(1, +n.chunks || 1) });
    const R = this.RUN?.R;
    if (R) for (const c of [...R.pool, ...R.bridges]) {
      if (c.document_id == null || docs.has(c.document_id)) continue;
      docs.set(c.document_id, { id: c.document_id, title: c.title || "", category: nomeCategoria(c.category), chunks: 60 });
    }
    const order: string[] = [];
    const push = (c: string | null) => { const n = nomeCategoria(c); if (!order.includes(n)) order.push(n); };
    ((R && R.categories.length ? R.categories : null) || this.mappa?.categories || []).forEach(push);
    for (const d of docs.values()) push(d.category);
    const cats = order.filter(c => { for (const d of docs.values()) if (d.category === c) return true; return false; });
    // senza mappa e con poche categorie nella traccia: si aggiungono le categorie ufficiali, nebulose generiche
    if (!this.mappa && R && cats.length < 3) for (const c of order) {
      if (cats.length >= 3) break;
      if (cats.includes(c)) continue;
      cats.push(c);
      for (let j = 0; j < 5; j++) docs.set("ph:" + c + j, { id: "ph:" + c + j, title: "", category: c, chunks: 40 + j * 30 });
    }
    return { docs: [...docs.values()], cats };
  }

  private buildField(): void {
    const F = this.F, STAGE = this.STAGE, mob = this.mobile();
    const spec = this.fieldSpec();
    const PT = this.ridotto ? 1500 : mob ? 2200 : 3500;
    let cats = spec.cats;
    const docs = spec.docs;
    const ph = !cats.length;
    if (ph) {
      const r0 = rng(7);
      for (let i = 0; i < 5; i++) {
        const c = "\u0001" + i;
        cats.push(c);
        const nd = 6 + Math.floor(r0() * 8);
        for (let j = 0; j < nd; j++) docs.push({ id: "p" + i + "_" + j, category: c, chunks: 40 + Math.floor(r0() * 900), title: "" });
      }
    }
    const byCat = new Map<string, DocumentoMappa[]>(cats.map(c => [c, []]));
    for (const d of docs) byCat.get(d.category ?? SENZA_CATEGORIA)?.push(d);
    cats = cats.filter(c => (byCat.get(c) ?? []).length);
    const K = cats.length;
    const Wc = cats.map(c => Math.sqrt((byCat.get(c) ?? []).reduce((s, d) => s + d.chunks, 0)));
    const Wmax = Math.max(1, ...Wc), Wsum = Wc.reduce((a, b) => a + b, 0) || 1;
    const { cx, cy, w, h } = STAGE;
    const rx = K <= 1 ? 0 : w * (K <= 3 ? 0.25 : mob ? 0.3 : 0.33), ry = K <= 1 ? 0 : h * (K <= 3 ? 0.2 : 0.3);
    const Rmax = Math.min(w, h) * (K <= 1 ? 0.36 : K <= 3 ? 0.28 : K <= 6 ? 0.24 : 0.2), Rmin = Rmax * 0.45;
    const inX = (x: number, R: number) => clamp(x, STAGE.x0 + R * 0.72 + 6, STAGE.x1 - R * 0.72 - 6);
    const inY = (y: number, R: number) => clamp(y, STAGE.y0 + R * 0.55, STAGE.y1 - R * 0.6);
    const X: number[] = [], Y: number[] = [], SZ: number[] = [], AL: number[] = [], GR: number[] = [], PH: number[] = [], FQ: number[] = [], ST: number[] = [];
    const r = rng(hash32(cats.join("|") + K) || 1);
    // maglia di particelle bianche e grigie; il colore della categoria solo su pochi quadratini
    const addP = (x: number, y: number, g: number, af: number) => {
      X.push(x); Y.push(y);
      const tint = g >= 2, star = !tint && r() < 0.05;
      SZ.push(tint ? 2 + r() * 0.4 : star ? 1.9 : 0.85 + r() * 0.7);
      AL.push((tint ? 0.5 + r() * 0.45 : star ? 1 : 0.34 + r() * 0.62) * af);
      GR.push(g); ST.push(star ? 1 : 0); PH.push(r() * TAU); FQ.push(0.5 + r() * 2.2);
    };
    const clusters: Nebulosa[] = [], docMap = new Map<Id, Ammasso>();
    cats.forEach((c, i) => {
      const a = -Math.PI / 2 + 0.5 + (i / K) * TAU, R = Rmin + (Rmax - Rmin) * Math.sqrt(Wc[i]! / Wmax);
      const cl: Nebulosa = {
        name: ph ? "" : corto(c.toLowerCase(), 30), cat: c, col: ph ? PALETTE[i % PALETTE.length]! : this.catColor(c),
        x: inX(cx + Math.cos(a) * rx + (r() - 0.5) * R * 0.25, R), y: inY(cy + Math.sin(a) * ry + (r() - 0.5) * R * 0.2, R),
        r: R, docs: [], ndocs: 0, chunks: 0, s: X.length, e: 0, lx: 0, ly: 0, lw: 0,
      };
      const list = (byCat.get(c) ?? []).slice().sort((p, q) => q.chunks - p.chunks);
      cl.ndocs = list.filter(d => !String(d.id).startsWith("ph:")).length;
      cl.chunks = list.reduce((s, d) => s + d.chunks, 0);
      const np = Math.max(110, Math.round((PT * Wc[i]!) / Wsum)), halo = Math.round(np * 0.15);
      const maxC = list[0]!.chunks, sq = list.map(d => Math.sqrt(d.chunks)), sqs = sq.reduce((p, q) => p + q, 0) || 1;
      const tint = 2 + i;
      list.forEach((d, j) => {
        const u = (j + 0.5) / list.length, rad = R * 0.6 * Math.sqrt(u) * (0.75 + 0.5 * r()), th = j * 2.39996 + r() * 0.7;
        const b: Ammasso = { doc: d, cl, x: cl.x + Math.cos(th) * rad, y: cl.y + Math.sin(th) * rad * 0.86, sig: R * (0.06 + 0.16 * Math.sqrt(d.chunks / maxC)), s: X.length, e: 0, big: d.chunks >= maxC * 0.25 };
        const ang = r() * Math.PI, st = 1 + r() * 0.8, ca = Math.cos(ang), sa = Math.sin(ang), n = Math.max(5, Math.round(((np - halo) * sq[j]!) / sqs));
        for (let k = 0; k < n; k++) {
          const gx = gauss(r) * b.sig * st, gy = (gauss(r) * b.sig) / st, t = r();
          addP(b.x + gx * ca - gy * sa, b.y + gx * sa + gy * ca, t < 0.2 ? tint : t < 0.55 ? 1 : 0, 1);
        }
        b.e = X.length;
        cl.docs.push(b);
        docMap.set(d.id, b);
      });
      for (let k = 0; k < halo; k++) { const t = r(); addP(cl.x + gauss(r) * R * 0.48, cl.y + gauss(r) * R * 0.42, t < 0.14 ? tint : t < 0.6 ? 1 : 0, 0.62); }
      cl.e = X.length;
      clusters.push(cl);
    });
    // «dati reali · cerbero»: gli strumenti, particelle rosa in basso a sinistra
    const cerG = 2 + K;
    const cer = { x: STAGE.x0 + Math.max(mob ? 52 : 74, w * 0.085), y: STAGE.y1 - Math.max(mob ? 40 : 52, h * 0.13), r: mob ? 24 : 34, s: X.length, e: 0 };
    for (let k = 0; k < (mob ? 70 : 120); k++) {
      X.push(cer.x + gauss(r) * cer.r * 0.5); Y.push(cer.y + gauss(r) * cer.r * 0.42); SZ.push(1.5 + r() * 1.1); AL.push(0.45 + r() * 0.5);
      GR.push(cerG); ST.push(0); PH.push(r() * TAU); FQ.push(0.6 + r() * 1.6);
    }
    cer.e = X.length;
    const n = X.length;
    F.n = n; F.px = Float32Array.from(X); F.py = Float32Array.from(Y); F.ps = Float32Array.from(SZ); F.pa = Float32Array.from(AL);
    F.ph = Float32Array.from(PH); F.pf = Float32Array.from(FQ); F.st = Uint8Array.from(ST);
    F.inA = new Uint8Array(n); F.aura = new Int32Array(n);
    F.clusters = clusters; F.docs = docMap; F.cer = cer; F.cerG = cerG; F.placeholder = ph;
    F.gcol = ["#ECECF2", "#8C8C9A", ...clusters.map(cl => lighten(cl.col, 0.14)), CERBERO_COL];
    const groups: number[][] = F.gcol.map(() => []);
    for (let i = 0; i < n; i++) groups[GR[i]!]!.push(i);
    F.groups = groups.map(a => Int32Array.from(a));
    // griglia spaziale: le zampe si appoggiano alle particelle, la maglia lega le vicine
    const M = F.M, cell = F.cell;
    F.gx0 = -M; F.gy0 = -M; F.gw = Math.ceil((this.CW + 2 * M) / cell) + 1; F.gh = Math.ceil((this.CH + 2 * M) / cell) + 1;
    F.grid = new Array(F.gw * F.gh);
    const cellOf = (x: number, y: number) => clamp(Math.floor((y - F.gy0) / cell), 0, F.gh - 1) * F.gw + clamp(Math.floor((x - F.gx0) / cell), 0, F.gw - 1);
    for (let i = 0; i < n; i++) { const k = cellOf(F.px[i]!, F.py[i]!); (F.grid[k] ??= []).push(i); }
    const E: number[] = [], maxD2 = (mob ? 26 : 34) ** 2;
    for (let i = 0; i < n; i++) {
      if (GR[i] === cerG) continue;
      const x = F.px[i]!, y = F.py[i]!;
      let b1 = -1, d1 = maxD2, b2 = -1, d2 = maxD2;
      const gx = clamp(Math.floor((x - F.gx0) / cell), 0, F.gw - 1), gy = clamp(Math.floor((y - F.gy0) / cell), 0, F.gh - 1);
      for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= F.gw || yy >= F.gh) continue;
        const b = F.grid[yy * F.gw + xx];
        if (!b) continue;
        for (const j of b) {
          if (j <= i || GR[j] === cerG) continue;
          const dx = F.px[j]! - x, dy = F.py[j]! - y, d = dx * dx + dy * dy;
          if (d < d1) { b2 = b1; d2 = d1; b1 = j; d1 = d; } else if (d < d2) { b2 = j; d2 = d; }
        }
      }
      if (b1 >= 0) E.push(i, b1);
      if (b2 >= 0 && r() < 0.55) E.push(i, b2);
    }
    F.mesh = Int32Array.from(E);
    this.layoutLabels();
    this.renderLayer();
    this.assignChunks();
  }

  private layoutLabels(): void {
    const L = this.F.clusters.filter(cl => cl.name), T = this.LBL(), ctx = this.ctx, STAGE = this.STAGE;
    ctx.font = `500 ${T.n}px ${MONO}`;
    const sw = T.s * 0.62 * 24;
    for (const cl of L) {
      cl.lw = Math.max(ctx.measureText(cl.name).width * (T.a / T.n), sw) + 8;
      cl.lx = clamp(cl.x, STAGE.x0 + cl.lw / 2 + 4, STAGE.x1 - cl.lw / 2 - 4);
      cl.ly = clamp(cl.y - cl.r * 0.78 - 14, 22, this.CH - 34);
    }
    const LH = T.lh;
    const minX = (a: Nebulosa) => STAGE.x0 + a.lw / 2 + 4, maxX = (a: Nebulosa) => STAGE.x1 - a.lw / 2 - 4;
    const hit = (a: Nebulosa, b: Rett) => a.lx - a.lw / 2 < b.x + b.w && a.lx + a.lw / 2 > b.x && a.ly - 12 < b.y + b.h && a.ly + LH - 12 > b.y;
    for (let it = 0; it < 10; it++) {
      for (let i = 0; i < L.length; i++) {
        const a = L[i]!;
        for (let j = i + 1; j < L.length; j++) {
          const b = L[j]!, ox = (a.lw + b.lw) / 2 + 6 - Math.abs(a.lx - b.lx), oy = LH - Math.abs(a.ly - b.ly);
          if (ox <= 0 || oy <= 0) continue;
          if (oy > LH * 0.55 && ox < Math.max(a.lw, b.lw) * 0.6) {
            const d = ox / 2 + 1, s = a.lx <= b.lx ? -1 : 1;
            a.lx = clamp(a.lx + s * d, minX(a), maxX(a)); b.lx = clamp(b.lx - s * d, minX(b), maxX(b));
          } else { const d = oy / 2 + 1; if (a.ly <= b.ly) { a.ly -= d; b.ly += d; } else { a.ly += d; b.ly -= d; } }
        }
      }
      for (const a of L) {
        for (const b of this.AVOID) if (hit(a, b)) {
          const below = b.y + b.h + 13, right = b.x + b.w + a.lw / 2 + 4;
          if (b === this.TITLE && right < maxX(a) && Math.abs(right - a.lx) < below - a.ly + 60) a.lx = right; else a.ly = below;
        }
        a.ly = clamp(a.ly, 22, this.CH - 34);
      }
    }
  }

  /** Lo strato fermo (grana, velature, maglia, punti tenui): un drawImage per fotogramma. */
  private renderLayer(): void {
    const F = this.F, M = F.M, DPR = this.DPR;
    const L = document.createElement("canvas");
    L.width = Math.ceil((this.CW + 2 * M) * DPR); L.height = Math.ceil((this.CH + 2 * M) * DPR);
    const g = L.getContext("2d");
    if (!g) return;
    g.setTransform(DPR, 0, 0, DPR, M * DPR, M * DPR);
    const r = rng(99);
    g.fillStyle = "#ffffff";
    for (let i = 0; i < (this.mobile() ? 520 : 1300); i++) {
      g.globalAlpha = 0.025 + r() * 0.07;
      const s = r() < 0.1 ? 1.2 : 0.7;
      g.fillRect(-M + r() * (this.CW + 2 * M), -M + r() * (this.CH + 2 * M), s, s);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = "lighter";
    for (const cl of F.clusters) {
      const R = cl.r * 1.35, gr = g.createRadialGradient(cl.x, cl.y, 0, cl.x, cl.y, R);
      gr.addColorStop(0, withA(cl.col, 0.05)); gr.addColorStop(0.4, withA(cl.col, 0.022)); gr.addColorStop(1, withA(cl.col, 0));
      g.fillStyle = gr; g.fillRect(cl.x - R, cl.y - R, 2 * R, 2 * R);
      for (const b of cl.docs) {
        const rb = b.sig * (b.big ? 2.8 : 2.2), gb = g.createRadialGradient(b.x, b.y, 0, b.x, b.y, rb);
        gb.addColorStop(0, lightenA(cl.col, 0.35, b.big ? 0.03 : 0.02)); gb.addColorStop(0.5, withA(cl.col, b.big ? 0.012 : 0.008)); gb.addColorStop(1, withA(cl.col, 0));
        g.fillStyle = gb; g.fillRect(b.x - rb, b.y - rb, 2 * rb, 2 * rb);
      }
    }
    g.globalCompositeOperation = "source-over";
    const { px, py, mesh } = F;
    g.lineWidth = 0.55; g.strokeStyle = "rgba(206,210,230,0.14)"; g.beginPath();
    for (let k = 0; k < mesh.length; k += 2) { const a = mesh[k]!, b = mesh[k + 1]!; g.moveTo(px[a]!, py[a]!); g.lineTo(px[b]!, py[b]!); }
    g.stroke();
    for (let gi = 0; gi < F.groups.length; gi++) {
      g.fillStyle = F.gcol[gi]!;
      const idx = F.groups[gi]!, cer = gi === F.cerG;
      for (let k = 0; k < idx.length; k++) { const i = idx[k]!; g.globalAlpha = F.pa[i]! * (cer ? 0.22 : 0.62); const s = F.ps[i]!; g.fillRect(px[i]! - s / 2, py[i]! - s / 2, s, s); }
    }
    g.globalCompositeOperation = "lighter";
    const sp = this.spr("#E0E7FF"), idx0 = F.groups[0] ?? new Int32Array(0);
    for (let k = 0; k < idx0.length; k++) { const i = idx0[k]!; if (!F.st[i]) continue; g.globalAlpha = 0.3; g.drawImage(sp, px[i]! - 6, py[i]! - 6, 12, 12); }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    if (F.layer) { F.prev = F.layer; F.prevW = F.layerW; F.prevH = F.layerH; F.prevM = M; F.fade = 0; }
    F.layer = L; F.layerW = this.CW + 2 * M; F.layerH = this.CH + 2 * M;
  }

  /** Ogni passaggio candidato ha una particella stabile nell'ammasso del suo documento. */
  private assignChunks(): void {
    const F = this.F;
    F.chunkP = new Map();
    const R = this.RUN?.R;
    if (!R || !F.n) return;
    const used = new Set<number>();
    for (const c of [...R.pool, ...R.bridges]) {
      if (c.id == null || F.chunkP.has(c.id)) continue;
      let b = c.document_id != null ? F.docs.get(c.document_id) : undefined;
      if (!b) {
        const cl = F.clusters.find(k => k.cat === nomeCategoria(c.category)) || F.clusters[0];
        if (!cl || !cl.docs.length) continue;
        b = cl.docs[hash32(c.document_id) % cl.docs.length];
      }
      if (!b) continue;
      const n = b.e - b.s;
      if (n <= 0) continue;
      let j = hash32("c" + c.id) % n, tries = 0;
      while (used.has(b.s + j) && tries < n) { j = (j + 1) % n; tries++; }
      used.add(b.s + j);
      F.chunkP.set(c.id, b.s + j);
    }
  }
  private needsRebuild(R: Ricerca): boolean {
    if (this.F.placeholder) return true;
    for (const c of [...R.pool, ...R.bridges]) if (c.document_id != null && !this.F.docs.has(c.document_id)) return true;
    return false;
  }
  private nearP(x: number, y: number, rad: number): number {
    const F = this.F;
    if (!F.n || !F.cer) return -1;
    const cell = F.cell, gx = Math.floor((x - F.gx0) / cell), gy = Math.floor((y - F.gy0) / cell), R = Math.ceil(rad / cell);
    let best = -1, bd = rad * rad;
    for (let yy = gy - R; yy <= gy + R; yy++) for (let xx = gx - R; xx <= gx + R; xx++) {
      if (xx < 0 || yy < 0 || xx >= F.gw || yy >= F.gh) continue;
      const b = F.grid[yy * F.gw + xx];
      if (!b) continue;
      for (const j of b) { if (j >= F.cer.s) continue; const dx = F.px[j]! - x, dy = F.py[j]! - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = j; } }
    }
    return best;
  }
  private chunkXY(id: Id | null | undefined): { x: number; y: number } | null {
    if (id == null) return null;
    const j = this.F.chunkP.get(id);
    return j == null ? null : { x: this.F.px[j]!, y: this.F.py[j]! };
  }

  // ─── la regia: la traccia arriva in un evento, qui diventa una sequenza ─
  private resetScene(): void { this.S = Sciame.scenaVuota(this.S.termGen + 1); this.PILLOFF.clear(); }
  private tlReset(live: boolean): void {
    Object.assign(this.TL, { ev: [], i: 0, clock: 0, live, hold: Infinity, start: Array<number | null>(8).fill(null), rispAt: null, verAt: null });
  }
  private ev(t: number, fn: (a: boolean) => void): void {
    const TL = this.TL;
    let k = TL.ev.length;
    while (k > TL.i && TL.ev[k - 1]!.t > t) k--;
    TL.ev.splice(k, 0, { t, fn });
  }
  private tlTick(dt: number): void {
    const TL = this.TL;
    TL.clock += dt;
    const lim = Math.min(TL.clock, TL.hold);
    while (TL.i < TL.ev.length && TL.ev[TL.i]!.t <= lim) {
      const e = TL.ev[TL.i++]!;
      try { e.fn(true); } catch (err) { console.warn("sciame: evento", err); }
    }
  }
  private enterStage(k: number): void { this.S.stage = k; if (k === 1) this.S.termFade = this.TL.clock; this.notifica(); }

  private initCatStats(R: Ricerca): void {
    const S = this.S;
    S.cat = new Map();
    const seen = new Set<Id>();
    for (const c of [...R.pool, ...R.bridges]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const n = nomeCategoria(c.category);
      const s = S.cat.get(n) ?? { cand: 0, read: 0, kept: 0 };
      s.cand++;
      S.cat.set(n, s);
    }
  }

  private schedDomanda(t0: number, terms: string[]): void {
    this.TL.start[0] = t0;
    const gen = this.S.termGen;
    this.ev(t0, () => this.enterStage(0));
    terms.slice(0, 8).forEach((w, i) => this.ev(t0 + 180 + i * 110, a => { if (gen !== this.S.termGen) return; this.S.terms.push({ w, born: a ? this.TL.clock : -1e9 }); }));
  }

  /** Ricerca, rerank, contesto, ponti, concetti. Ritorna l'inizio di RISPOSTA. */
  private schedRetrieval(t: number): number {
    const R = this.RUN!.R!, pool = R.pool, N = pool.length, TL = this.TL;
    TL.start[1] = t; this.ev(t, () => this.enterStage(1));
    const d1 = N ? Math.min(120, 2800 / N) : 0;
    pool.forEach((c, i) => this.ev(t + 120 + i * d1, a => this.vSearch(c, i, a)));
    t += 120 + N * d1 + 260;
    TL.start[2] = t; this.ev(t, () => this.enterStage(2));
    const judged = pool.filter(c => c.status === "kept" || c.status === "dropped")
      .sort((a, b) => (a.final_rank ?? 999) - (b.final_rank ?? 999) || (b.rerank ?? -99) - (a.rerank ?? -99) || (b.score || 0) - (a.score || 0));
    const d2 = judged.length ? Math.min(130, 1150 / judged.length) : 0;
    judged.forEach((c, i) => this.ev(t + 150 + i * d2, a => this.vJudge(c, a)));
    t += 150 + Math.max(judged.length * d2, 300) + 260;
    TL.start[3] = t; this.ev(t, () => this.enterStage(3));
    const base = R.ctx.map((id, i) => [id, i] as const).filter(([id]) => id == null || !R.brIds.has(id));
    const d3 = base.length ? Math.min(140, 900 / base.length) : 0;
    base.forEach(([id, i], k) => this.ev(t + 120 + k * d3, a => this.vCtx(id, i, a)));
    t += 120 + Math.max(base.length * d3, 300) + 220;
    TL.start[4] = t; this.ev(t, () => this.enterStage(4));
    const br = R.bridges, d4 = br.length ? Math.min(380, 1000 / br.length) : 0;
    br.forEach((b, i) => this.ev(t + 150 + i * d4, a => this.vBridge(b, a)));
    t += 150 + Math.max(br.length * d4, 350) + 300;
    TL.start[5] = t; this.ev(t, () => this.enterStage(5));
    const cs = R.concepts, d5 = cs.length ? Math.min(150, 900 / cs.length) : 0;
    cs.forEach((k, i) => this.ev(t + 120 + i * d5, a => this.vConcept(k, i, a)));
    this.ev(t + 120 + cs.length * d5 + 80, () => { this.S.cedges = R.cedges.slice(); });
    t += 120 + Math.max(cs.length * d5, 350) + 320;
    TL.start[6] = t; this.ev(t, () => this.enterStage(6));
    return t;
  }

  private secLabel(c: Passaggio | undefined): string {
    return c && c.section ? (/^\s*§/.test(c.section) ? "" : "§ ") + corto(c.section, 18) : corto(c?.title || "—", 18);
  }
  private pillFor(c: Passaggio): string {
    let best: string | null = null, bn = 0;
    for (const [w, n] of Object.entries(c.hits || {})) if (n > bn) { bn = n; best = w; }
    return this.secLabel(c) + (best ? " · " + best : "");
  }
  private scoreOf(c: Passaggio): string { return (+c.score || 0).toFixed(2); }

  private vSearch(c: Passaggio, i: number, a: boolean): void {
    const S = this.S, n = nomeCategoria(c.category), cs = S.cat.get(n);
    if (cs) cs.read++;
    S.activeCat = n;
    S.chunk.set(c.id, { st: c.status === "dup" ? "dup" : c.status === "below" ? "below" : "seen", glow: a ? 1 : 0 });
    if (a) {
      if (c.status === "dup") this.tent({ chunk: c.id }, "doppio · " + this.secLabel(c), "dup", 1000);
      else if (c.status === "below") this.tent({ chunk: c.id }, "sotto soglia · " + this.scoreOf(c), "dim", 700);
      else this.tent({ chunk: c.id }, this.pillFor(c), "read", 1050);
    }
    S.focusIds = this.RUN!.R!.pool.slice(i, i + 8).map(x => x.id);
    S.focusBias = c.id;
  }
  private vJudge(c: Passaggio, a: boolean): void {
    const S = this.S, st = S.chunk.get(c.id) ?? { st: "seen", glow: 0 }, cs = S.cat.get(nomeCategoria(c.category));
    const sc = c.rerank != null ? (+c.rerank).toFixed(2) : this.scoreOf(c);
    if (c.status === "kept") {
      st.st = "kept"; if (a) st.glow = 1; if (cs) cs.kept++;
      if (a) this.tent({ chunk: c.id }, "tengo" + (c.final_rank ? " · F" + c.final_rank : "") + " · " + sc, "kept", 900);
    } else { st.st = "dropped"; if (a) this.tent({ chunk: c.id }, "scarto · " + sc, "dim", 520); }
    S.chunk.set(c.id, st);
    S.focusIds = this.RUN!.R!.pool.filter(x => x.status === "kept").map(x => x.id);
    S.focusBias = c.id;
    S.activeCat = nomeCategoria(c.category);
  }
  private vCtx(id: Id | null, idx: number, a: boolean): void {
    const S = this.S, n = idx + 1;
    if (id == null) {
      S.memory = true;
      if (a) this.tent({ rel: [-Math.PI / 2 + 0.5, 112 * this.CS()] }, "F" + n + " · memoria", "ctx", 1200);
      return;
    }
    const c = this.RUN!.R!.byId.get(id), st = S.chunk.get(id) ?? { st: "ctx", glow: 0 };
    st.st = "ctx"; st.fr = n; if (a) st.glow = 1;
    S.chunk.set(id, st);
    S.ctxIds.push(id);
    if (a) this.tent({ chunk: id }, "F" + n + " · " + this.secLabel(c), "ctx", 1200);
    S.focusIds = S.ctxIds.slice(); S.focusBias = id;
    if (c) S.activeCat = nomeCategoria(c.category);
  }
  private vBridge(b: Passaggio, a: boolean): void {
    const S = this.S, R = this.RUN!.R!;
    const n = R.ctx.indexOf(b.id) + 1 || null, cut = !n, again = S.chunk.has(b.id);
    const cs = S.cat.get(nomeCategoria(b.category));
    if (cs) { if (!again) cs.read++; if (!cut) cs.kept++; }
    S.chunk.set(b.id, { st: cut ? "dropped" : "bridge", fr: n, glow: a && !cut ? 1 : 0 });
    if (!cut) S.ctxIds.push(b.id);
    S.arcs.push({ from: b.from_id, to: b.id, born: a ? this.TL.clock : -1e9, text: (cut ? "ponte escluso · " : "ponte · ") + "«" + corto(b.title, 20) + "»", seed: Math.random(), fr: n, cut });
    if (b.from_id != null && this.F.chunkP.has(b.from_id)) { S.focusIds = [b.from_id]; S.focusBias = b.from_id; }
  }
  private vConcept(k: ConcettoTraccia, i: number, a: boolean): void {
    const cat = nomeCategoria(k.category), cl = this.F.clusters.find(x => x.cat === cat), CR = this.CR;
    let ang = cl ? Math.atan2(cl.y - CR.y, cl.x - CR.x) : i * 2.39996;
    if (cl && Math.hypot(cl.x - CR.x, cl.y - CR.y) < cl.r * 0.5) ang = i * 2.39996;
    this.S.concepts.push({ id: k.id, name: String(k.name || ""), cat, w: +k.weight || 1, chunks: (Array.isArray(k.chunk_ids) ? k.chunk_ids : []).slice(0, 4), born: a ? this.TL.clock : -1e9, ang, ring: i % 2 });
    const L = this.S.concepts.slice().sort((p, q) => p.ang - q.ang), n = L.length;
    if (n < 2) return;
    const gap = Math.min(0.5, (TAU / n) * 0.92);
    for (let it = 0; it < 8; it++) for (let j = 0; j < n; j++) {
      const p = L[j]!, q = L[(j + 1) % n]!;
      let d = q.ang - p.ang;
      if (j === n - 1) d += TAU;
      if (d < gap) { const m = (gap - d) / 2; p.ang -= m; q.ang += m; }
    }
  }
  private toolHit(name: string, a: boolean): void {
    const S = this.S, F = this.F;
    S.tools++; S.cerLit = 1; S.lastTool = String(name || "strumento");
    if (a && F.cer) { const j = F.cer.s + Math.floor(Math.random() * (F.cer.e - F.cer.s)); this.tent({ cer: j }, "strumento · " + corto(S.lastTool, 22), "tool", 2600); }
    this.notifica();
  }

  /** VERIFICA: per ogni frase un tentacolo verso la sua fonte, o una pillola «senza fonte». */
  private schedVerify(t: number): void {
    const TL = this.TL, RUN = this.RUN!;
    TL.verAt = t; TL.start[7] = t;
    this.ev(t, () => this.enterStage(7));
    const na = !(RUN.verify && Array.isArray(RUN.verify.claims));
    const claims = na ? citazioniEsplicite(RUN.answer).filter(c => c.cited) : RUN.verify!.claims!.slice(0, 40);
    // senza documenti non c'era niente da verificare: nessun avviso
    const senzaDocumenti = !!RUN.R && RUN.R.synthetic && !RUN.R.pool.length && !RUN.R.bridges.length;
    if (na && !senzaDocumenti) this.ev(t + 120, a => { this.S.verifyNA = true; if (a) this.tent({ rel: [-Math.PI / 2 - 0.5, this.mobile() ? 78 : 118] }, "verifica non disponibile", "unk", Infinity); });
    const d = claims.length > 20 ? 2800 / claims.length : 140;
    claims.forEach((cl, i) => this.ev(t + 260 + i * d, a => this.vClaim(cl, i, claims.length, a)));
    this.ev(t + 260 + claims.length * d + 260, () => { this.S.finished = true; this.notifica(true); });
  }
  private vClaim(cl: Affermazione, i: number, n: number, a: boolean): void {
    const S = this.S, R = this.RUN!.R!;
    S.claims++;
    const src = cl.source ? cl.source | 0 : 0, id = src > 0 ? R.ctx[src - 1] : undefined;
    const ws = (Array.isArray(cl.words) ? cl.words : []).map(w => corto(w, 14)).filter(Boolean);
    const mob = this.mobile(), ang = -Math.PI / 2 + i * (TAU / Math.max(6, n)) + 0.3, rr = (mob ? 64 : 100) + (i % 3) * (mob ? 10 : 16);
    if (cl.traced) {
      S.traced++;
      if (a) {
        let T = S.vSrc.get(src);
        if (!T) {
          T = this.tent(id != null && this.F.chunkP.has(id) ? { chunk: id } : { rel: [ang, rr] }, "", "kept", Infinity) ?? undefined;
          if (T) { T.vn = 0; T.vw = []; T.vc = false; S.vSrc.set(src, T); }
        }
        if (T) {
          T.vn = (T.vn ?? 0) + 1; T.vc = T.vc || !!cl.cited;
          const vw = T.vw ?? (T.vw = []);
          for (const w of ws) if (!vw.includes(w)) vw.push(w);
          T.vt = this.TL.clock;
          const f = src ? "F" + src : "fonte", w = vw.slice(0, T.vn > 1 ? 1 : 2).join(" · ");
          T.text = T.vn > 1 ? `${f} · ${T.vn} affermazioni` + (w ? " · " + w : "") : f + (w ? " · " + w : T.vc ? " · citata" : "");
        }
        this.vPills();
      }
      const st = id != null ? S.chunk.get(id) : undefined;
      if (st && a) st.glow = 1;
    } else if (cl.unk) {
      S.unk++;
      if (a) { const T = this.tent({ rel: [ang, rr] }, "non verificata", "unk", Infinity); if (T) { T.vt = this.TL.clock; S.vFlags.push(T); } this.vPills(); }
    } else {
      S.noSrc++;
      if (a) {
        const kw = parole(cl.text).filter(w => w.length > 3 && !STOP.has(fold(w.toLowerCase()))).slice(0, 1).map(w => corto(w.toLowerCase(), 14));
        const T = this.tent({ rel: [ang, rr] }, "senza fonte" + (kw.length ? " · " + kw[0] : ""), "flag", Infinity);
        if (T) { T.vt = this.TL.clock; S.vFlags.push(T); }
        this.vPills();
      }
    }
  }
  /** Le pillole della verifica: le più recenti per fonte, poche «senza fonte», il resto riassunto. */
  private vPills(): void {
    const S = this.S, mob = this.mobile(), maxT = mob ? 5 : 8, maxF = mob ? 1 : 3;
    [...S.vSrc.values()].sort((p, q) => (q.vt ?? 0) - (p.vt ?? 0)).forEach((T, i) => { T.hide = i >= maxT; });
    const fl = S.vFlags, extra = fl.length - maxF;
    fl.forEach((T, i) => { T.hide = i < extra; if (i < fl.length - 10 && T.die === Infinity) T.die = this.TL.clock + 300; });
    if (extra > 0) {
      if (!S.vAgg) S.vAgg = this.tent({ rel: [Math.PI * 0.8, mob ? 58 : 86] }, "", "flag", Infinity);
      if (S.vAgg) S.vAgg.text = `+${extra} senza fonte`;
    }
  }

  // ─── gli eventi del turno ────────────────────────────────────────────────
  private onText(t: string): void {
    const RUN = this.RUN!;
    // un agente non manda la traccia: col primo testo la scena va avanti lo stesso
    if (!RUN.R) this.daFonti();
    RUN.answer += t;
    for (const w of parole(t)) RUN.wordQ.push(w);
    if (RUN.wordQ.length > 240) RUN.wordQ.splice(0, RUN.wordQ.length - 240);
  }
  private onTrace(tr: TracciaRetrieval): void {
    const RUN = this.RUN!;
    if (RUN.R) return;
    if (tr.error) return; // la risposta prosegue: il percorso si ricostruirà dalle fonti finali
    RUN.R = preparaRicerca(tr, RUN.q);
    this.afterTrace();
  }
  private daFonti(): void {
    const RUN = this.RUN!;
    const cat = (doc: Id | null) => (doc == null ? null : this.mappa?.nodes.find(n => n.id === doc)?.category ?? null);
    RUN.R = preparaRicerca(tracciaDalleFonti(RUN.sources, RUN.q, cat, this.mappa?.categories ?? []), RUN.q);
    this.afterTrace();
  }
  private afterTrace(): void {
    const R = this.RUN!.R!, S = this.S, TL = this.TL;
    if (R.categories.length) this.assignColors(R.categories.map(nomeCategoria));
    if (this.needsRebuild(R)) this.buildField(); else this.assignChunks();
    this.initCatStats(R);
    S.termGen++;
    const old = new Set(S.terms.map(t => t.w));
    S.terms = R.terms.map(w => ({ w, born: old.has(w) ? -1e9 : TL.clock }));
    TL.rispAt = this.schedRetrieval(Math.max(TL.clock + 80, R.synthetic && !R.pool.length ? 600 : 1200));
    this.notifica();
  }
  /** La VERIFICA parte quando la risposta è finita e RISPOSTA è durata abbastanza. */
  private liveChecks(): void {
    const RUN = this.RUN, TL = this.TL;
    if (!RUN || !TL.live || TL.rispAt == null || TL.verAt != null || !RUN.answerDone || RUN.status === "error" || RUN.status === "aborted") return;
    if (TL.clock >= TL.rispAt + 1400 && (RUN.wordQ.length < 4 || TL.clock >= TL.rispAt + 4500)) this.schedVerify(TL.clock + 150);
  }
  private buildReplay(): void {
    const RUN = this.RUN!, R = RUN.R!;
    this.resetScene(); this.tlReset(false);
    this.initCatStats(R);
    this.schedDomanda(0, R.terms);
    const r = this.schedRetrieval(1200);
    const ws = parole(RUN.answer), rd = clamp((ws.length / 16) * 1000, 1600, 4200);
    RUN.tools.forEach((n, i) => this.ev(r + 250 + i * 450, a => this.toolHit(n, a)));
    this.ev(r, () => { RUN.wordQ = ws.slice(0, 220); });
    if (RUN.status === "done") this.schedVerify(r + rd);
    else this.ev(r + rd, () => { this.S.finished = true; this.notifica(true); });
    this.TL.rispAt = r;
  }

  // ─── la simulazione: crawler, tentacoli, camera ──────────────────────────
  private initCrawler(): void {
    const k = this.CS(), CR = this.CR;
    CR.R = Math.round(23 * k);
    const nl = this.ridotto ? 8 : k < 1 ? 12 : 16, L1 = 60 * k, L2 = 78 * k;
    CR.reach = (L1 + L2) * 0.7;
    const r = rng(42);
    CR.legs = [];
    for (let i = 0; i < nl; i++) {
      const a = (i / nl) * TAU + (r() - 0.5) * 0.22, fx = CR.x + Math.cos(a) * CR.reach, fy = CR.y + Math.sin(a) * CR.reach;
      CR.legs.push({ a, l1: L1 * (0.85 + r() * 0.3), l2: L2 * (0.85 + r() * 0.3), fx, fy, ox: fx, oy: fy, tx: fx, ty: fy, t: 1, timer: r() * 2.5, grp: i % 2, flash: 0, kx: fx, ky: fy, hx: fx, hy: fy, dfx: fx, dfy: fy });
    }
    const nf = this.ridotto ? 80 : k < 1 ? 150 : 240;
    CR.fil = [];
    for (let i = 0; i < nf; i++) {
      const lg = r() < 0.18;
      CR.fil.push({ a: (i / nf) * TAU + (r() - 0.5) * 0.08, len: (lg ? 44 : 14) * k + r() * (lg ? 52 : 40) * k, f: 0.7 + r() * 2.3, ph: r() * TAU, c: i % 4, tx: 0, ty: 0, dot: lg || r() < 0.35 });
    }
  }
  /** Dove va il crawler: la nebulosa con più passaggi in lettura. */
  private majorityPoint(ids: Id[] | null, bias: Id | null): { x: number; y: number } | null {
    if (!ids || !ids.length) return null;
    const by = new Map<string, { n: number; x: number; y: number }>(), R = this.RUN?.R;
    for (const id of ids) {
      const j = this.F.chunkP.get(id);
      if (j == null) continue;
      const k = nomeCategoria(R?.byId.get(id)?.category);
      const s = by.get(k) ?? { n: 0, x: 0, y: 0 };
      s.n++; s.x += this.F.px[j]!; s.y += this.F.py[j]!;
      by.set(k, s);
    }
    let best: { n: number; x: number; y: number } | null = null;
    for (const s of by.values()) if (!best || s.n > best.n) best = s;
    if (!best) return null;
    let x = best.x / best.n, y = best.y / best.n;
    const b = bias != null ? this.chunkXY(bias) : null;
    if (b) { x = lerp(x, b.x, 0.22); y = lerp(y, b.y, 0.22); }
    return { x, y };
  }
  /** Le parole vanno verso la chat, sotto il palco. */
  private answerPoint(): { x: number; y: number } { return this.s2w(this.STAGE.cx, this.CH + 6); }
  private crawlerTarget(): { x: number; y: number } {
    const S = this.S, STAGE = this.STAGE, CR = this.CR;
    let p: { x: number; y: number } | null = null;
    if (this.RUN?.R && S.stage >= 1) p = this.majorityPoint(S.stage >= 3 ? (S.ctxIds.length ? S.ctxIds : S.focusIds) : S.focusIds, S.focusBias);
    if (p && S.stage === 6) { const ap = this.answerPoint(); p = { x: lerp(p.x, ap.x, 0.28), y: lerp(p.y, ap.y, 0.28) }; }
    if (p && S.stage === 7) p = { x: lerp(p.x, STAGE.cx, 0.42), y: lerp(p.y, STAGE.cy, 0.42) };
    if (!p) p = { x: STAGE.cx, y: STAGE.cy };
    p = { x: p.x + Math.sin(this.RT * 0.23) * 14, y: p.y + Math.cos(this.RT * 0.31) * 10 };
    const mx = Math.min(STAGE.w * 0.3, CR.reach * 0.8 + 20), my = Math.min(STAGE.h * 0.3, CR.reach * 0.65 + 16);
    return { x: clamp(p.x, STAGE.x0 + mx, STAGE.x1 - mx), y: clamp(p.y, STAGE.y0 + my, STAGE.y1 - my) };
  }
  private simStep(dt: number): void {
    const CR = this.CR, S = this.S, RUN = this.RUN, F = this.F, STAGE = this.STAGE;
    const tg = this.crawlerTarget();
    if (CR.snap) {
      CR.x = tg.x; CR.y = tg.y; CR.vx = CR.vy = 0; CR.snap = false;
      for (const l of CR.legs) { l.fx = l.ox = l.tx = CR.x + Math.cos(l.a) * CR.reach; l.fy = l.oy = l.ty = CR.y + Math.sin(l.a) * CR.reach; l.t = 1; }
    }
    const k = this.ridotto ? 5 : 9, d = 2 * Math.sqrt(k);
    CR.vx += ((tg.x - CR.x) * k - CR.vx * d) * dt; CR.vy += ((tg.y - CR.y) * k - CR.vy * d) * dt;
    let sp = Math.hypot(CR.vx, CR.vy);
    const vmax = this.ridotto ? 240 : 560;
    if (sp > vmax) { CR.vx *= vmax / sp; CR.vy *= vmax / sp; sp = vmax; }
    CR.x += CR.vx * dt; CR.y += CR.vy * dt;
    if (sp > 8) { let dh = Math.atan2(CR.vy, CR.vx) - CR.head; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); CR.head += dh * Math.min(1, dt * 4); }
    CR.rot += dt * (this.ridotto ? 0.03 : 0.07);
    const busy = !!RUN && (RUN.status === "running" || (S.stage >= 1 && !S.finished));
    CR.excite = lerp(CR.excite, busy ? 1.12 : 0.86, dt * 1.5);
    this.legsStep(dt, sp);
    for (const st of S.chunk.values()) if (st.glow > 0) st.glow = Math.max(0, st.glow - dt * 0.85);
    S.cerLit = Math.max(S.tools ? 0.42 : 0, S.cerLit - dt * 0.35);
    // RISPOSTA: le parole fluiscono dal nucleo verso la chat
    if (RUN && S.stage >= 6 && RUN.wordQ.length) {
      const rate = clamp(RUN.wordQ.length / 1.2, this.ridotto ? 4 : 7, this.ridotto ? 12 : 30);
      S.flowAcc += dt * rate;
      while (S.flowAcc >= 1 && RUN.wordQ.length) {
        S.flowAcc -= 1;
        const w = RUN.wordQ.shift()!;
        if (S.words.length < 70) S.words.push({ w: corto(w, 14), born: this.RT, dur: 1.3 + Math.random() * 0.9, x0: CR.x + (Math.random() - 0.5) * 12, y0: CR.y + (Math.random() - 0.5) * 12, bend: (Math.random() - 0.5) * 170 });
      }
    }
    // la camera segue un poco il crawler e si avvicina durante la corsa
    const run = !!RUN && S.stage >= 1 && !this.ridotto, cf = this.mobile() ? 0.07 : 0.2;
    const tx = run ? (STAGE.cx - CR.x) * cf : Math.sin(this.RT * 0.07) * 6, ty = run ? (STAGE.cy - CR.y) * cf * 0.8 : Math.cos(this.RT * 0.05) * 4, tz = run ? (this.mobile() ? 1.02 : 1.05) : 1;
    const kk = Math.min(1, dt * 1.1);
    this.CAM.ox += (tx - this.CAM.ox) * kk; this.CAM.oy += (ty - this.CAM.oy) * kk; this.CAM.z += (tz - this.CAM.z) * kk * 0.5;
    if (F.fade < 1) F.fade = Math.min(1, F.fade + dt * 1.6);
  }
  private legsStep(dt: number, sp: number): void {
    const CR = this.CR, F = this.F;
    let stepping = 0;
    for (const l of CR.legs) if (l.t < 1) stepping++;
    const maxStep = Math.max(2, Math.ceil(CR.legs.length * 0.4)), lead = 0.16, dur = this.ridotto ? 0.32 : 0.15;
    CR.gait += dt;
    if (CR.gait > 0.17) { CR.gait = 0; CR.gg = 1 - CR.gg; }
    for (const l of CR.legs) {
      const a = l.a + CR.rot, ix = CR.x + Math.cos(a) * CR.reach + CR.vx * lead, iy = CR.y + Math.sin(a) * CR.reach + CR.vy * lead;
      if (l.t < 1) { l.t = Math.min(1, l.t + dt / dur); const e = easeIO(l.t); l.fx = lerp(l.ox, l.tx, e); l.fy = lerp(l.oy, l.ty, e); if (l.t >= 1) l.flash = 1; continue; }
      l.timer -= dt; l.flash = Math.max(0, l.flash - dt * 3);
      const far = Math.hypot(l.fx - ix, l.fy - iy) > CR.reach * 0.45;
      if (((far && (sp < 30 || l.grp === CR.gg)) || l.timer <= 0) && stepping < maxStep) {
        stepping++;
        const j = this.nearP(ix + (Math.random() - 0.5) * 18, iy + (Math.random() - 0.5) * 18, 24);
        l.ox = l.fx; l.oy = l.fy; l.tx = j >= 0 ? F.px[j]! : ix; l.ty = j >= 0 ? F.py[j]! : iy; l.t = 0; l.timer = 1.1 + Math.random() * 2.4;
      }
    }
  }
  private tent(tg: Bersaglio, text: string, style: StilePillola, life: number): Tentacolo | null {
    if (!this.F.n) return null;
    const TL = this.TL;
    const T: Tentacolo = {
      tg, text, style, born: TL.clock, die: life === Infinity ? Infinity : TL.clock + life, seed: Math.random() * TAU,
      bend: (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.6), key: "t" + ++this.TKEY, alt: Math.random() < 0.35, hide: false,
    };
    this.S.tent.push(T);
    let tr = 0;
    for (let i = this.S.tent.length - 1; i >= 0; i--) { const t = this.S.tent[i]!; if (t.die !== Infinity) { tr++; if (tr > 12 && t.die > TL.clock + 260) t.die = TL.clock + 260; } }
    return T;
  }
  private tentPos(T: Tentacolo): { x: number; y: number } | null {
    const g = T.tg, CR = this.CR;
    if (g.chunk != null) return this.chunkXY(g.chunk);
    if (g.cer != null) return g.cer < this.F.n ? { x: this.F.px[g.cer]!, y: this.F.py[g.cer]! } : null;
    if (g.rel) return { x: CR.x + Math.cos(g.rel[0] + CR.rot * 0.2) * g.rel[1], y: CR.y + Math.sin(g.rel[0] + CR.rot * 0.2) * g.rel[1] };
    return null;
  }
  private w2s(x: number, y: number) { const { STAGE, CAM } = this; return { x: (x - STAGE.cx) * CAM.z + STAGE.cx + CAM.ox, y: (y - STAGE.cy) * CAM.z + STAGE.cy + CAM.oy }; }
  private s2w(x: number, y: number) { const { STAGE, CAM } = this; return { x: (x - STAGE.cx - CAM.ox) / CAM.z + STAGE.cx, y: (y - STAGE.cy - CAM.oy) / CAM.z + STAGE.cy }; }

  // ─── il ciclo ────────────────────────────────────────────────────────────
  private readonly frame = (now: number): void => {
    if (this.morto || this.fermo) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) { this.last = now; return; }
    const dt = Math.min(100, now - this.last);
    this.last = now;
    this.RT += (dt / 1000) * (this.ridotto ? 0.6 : 1);
    try {
      // a risposta già arrivata la regia accelera fino alla risposta: niente attese inutili
      const RUN = this.RUN, presto = !!RUN && RUN.answerDone && this.TL.rispAt != null && this.TL.clock < this.TL.rispAt;
      this.tlTick(dt * (presto ? 1.8 : 1));
      this.liveChecks();
      this.acc += dt;
      const STEP = 1000 / 60;
      let n = 0;
      while (this.acc >= STEP && n < 4) { this.simStep(STEP / 1000); this.acc -= STEP; n++; }
      if (n === 4) this.acc = 0;
      this.render();
    } catch (e) {
      // un errore di disegno ferma la scena, non la pagina
      console.warn("sciame: fermo", e);
      this.distruggi();
    }
  };

  // ─── il disegno ──────────────────────────────────────────────────────────
  private tw(s: string, font: string): number {
    const k = font + "\u0001" + s;
    let w = this.TW.get(k);
    if (w == null) { w = this.ctx.measureText(s).width; if (this.TW.size > 4000) this.TW.clear(); this.TW.set(k, w); }
    return w;
  }
  private setWorld(): void {
    const z = this.CAM.z, DPR = this.DPR, STAGE = this.STAGE;
    this.ctx.setTransform(DPR * z, 0, 0, DPR * z, DPR * (STAGE.cx * (1 - z) + this.CAM.ox), DPR * (STAGE.cy * (1 - z) + this.CAM.oy));
  }
  private render(): void {
    const ctx = this.ctx, F = this.F;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#050507"; ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    if (!F.layer) return;
    this.setWorld();
    if (F.prev && F.fade < 1) { ctx.globalAlpha = 1 - F.fade; ctx.drawImage(F.prev, -F.prevM, -F.prevM, F.prevW, F.prevH); ctx.globalAlpha = F.fade; }
    ctx.drawImage(F.layer, -F.M, -F.M, F.layerW, F.layerH);
    ctx.globalAlpha = 1;
    this.PILLS.length = 0; this.LABELS.length = 0;
    this.drawField(); this.drawCerbero(); this.drawArcs(); this.drawConceptLinks(); this.drawChunks(); this.drawTentacles();
    this.drawLegs(); this.drawFil(); this.drawCore(); this.drawConcepts(); this.drawWords();
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0); ctx.globalAlpha = 1;
    this.drawClusterLabels(); this.drawLabels(); this.flushPills();
    // la chat sotto: le parole ci finiscono dentro, un velo le accoglie
    const g = ctx.createLinearGradient(0, this.CH - 46, 0, this.CH);
    g.addColorStop(0, "rgba(5,5,7,0)"); g.addColorStop(1, "rgba(5,5,7,0.85)");
    ctx.fillStyle = g; ctx.fillRect(0, this.CH - 46, this.CW, 46);
  }
  private drawField(): void {
    const ctx = this.ctx, F = this.F, CR = this.CR, RT = this.RT;
    const { px, py, ps, pa, ph, pf, inA, aura } = F, ax = CR.x, ay = CR.y;
    const AR = 215 * this.CS() * (0.94 + 0.06 * Math.sin(RT * 0.8)), AR2 = AR * AR;
    let na = 0;
    for (let gi = 0; gi < F.groups.length; gi++) {
      if (gi === F.cerG) continue;
      const idx = F.groups[gi]!;
      ctx.fillStyle = F.gcol[gi]!;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]!, x = px[i]!, y = py[i]!, dx = x - ax, dy = y - ay;
        if (dx * dx + dy * dy < AR2) { inA[i] = 1; aura[na++] = i; continue; }
        const a = pa[i]! * (0.42 + 0.58 * Math.sin(RT * pf[i]! + ph[i]!));
        if (a < 0.05) continue;
        ctx.globalAlpha = a;
        const s = ps[i]!;
        ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
      }
    }
    if (na) {
      const E = F.mesh;
      ctx.globalAlpha = 1; ctx.lineWidth = 0.6; ctx.strokeStyle = "rgba(167,139,250,0.26)"; ctx.beginPath();
      for (let k = 0; k < E.length; k += 2) { const a = E[k]!, b = E[k + 1]!; if (inA[a] && inA[b]) { ctx.moveTo(px[a]!, py[a]!); ctx.lineTo(px[b]!, py[b]!); } }
      ctx.stroke();
      for (let pass = 0; pass < 2; pass++) {
        ctx.fillStyle = pass ? "#EDE9FE" : "#A78BFA";
        for (let k = 0; k < na; k++) {
          const i = aura[k]!, dx = px[i]! - ax, dy = py[i]! - ay, d = Math.sqrt(dx * dx + dy * dy) / AR;
          if ((d < 0.42) !== !!pass) continue;
          const a = pa[i]! * (0.6 + 0.4 * Math.sin(RT * pf[i]! * 1.4 + ph[i]!)) * (1.15 - d * 0.6);
          if (a < 0.05) continue;
          ctx.globalAlpha = Math.min(1, a);
          const s = ps[i]! * 1.15;
          ctx.fillRect(px[i]! - s * 0.5, py[i]! - s * 0.5, s, s);
        }
      }
      for (let k = 0; k < na; k++) inA[aura[k]!] = 0;
    }
    ctx.globalAlpha = 1;
  }
  private drawCerbero(): void {
    const c = this.F.cer, ctx = this.ctx, F = this.F, S = this.S;
    if (!c) return;
    const lit = S.cerLit;
    if (lit > 0.02) {
      const idx = F.groups[F.cerG] ?? new Int32Array(0);
      ctx.fillStyle = CERBERO_COL;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]!, a = F.pa[i]! * lit * (0.55 + 0.45 * Math.sin(this.RT * F.pf[i]! * 1.6 + F.ph[i]!));
        if (a < 0.04) continue;
        ctx.globalAlpha = a;
        const s = F.ps[i]!;
        ctx.fillRect(F.px[i]! - s / 2, F.py[i]! - s / 2, s, s);
      }
      ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.22 * lit;
      ctx.drawImage(this.spr(CERBERO_COL), c.x - c.r * 1.6, c.y - c.r * 1.6, c.r * 3.2, c.r * 3.2);
      ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    }
    const p = this.w2s(c.x, c.y - c.r * 0.9 - 12), mob = this.mobile(), x = Math.max(8, p.x - (mob ? 56 : 66));
    this.LABELS.push({ x, y: p.y, t: "dati reali · cerbero", font: `500 ${Math.max(9, this.LBL().n - 1)}px ` + MONO, col: lit > 0.05 ? "#FECDD3" : "rgba(254,205,211,.45)", align: "left", halo: true, ob: 1 });
    this.LABELS.push({ x, y: p.y + 13, t: S.tools ? `${S.tools} chiamat${S.tools === 1 ? "a" : "e"} · ${corto(S.lastTool, 18)}` : "in attesa di strumenti", font: "400 9px " + MONO, col: "rgba(160,160,172,.6)", align: "left", halo: true, ob: 1 });
  }
  private quadPt(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number) { const u = 1 - t; return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 }; }
  private partialQuad(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, g: number): [number, number, number, number] {
    const ax = lerp(x0, cx, g), ay = lerp(y0, cy, g), bx = lerp(cx, x1, g), by = lerp(cy, y1, g);
    return [ax, ay, lerp(ax, bx, g), lerp(ay, by, g)];
  }
  /** I ponti: archi lunghi fra documenti, un impulso che viaggia e la pillola in punta. */
  private drawArcs(): void {
    const ctx = this.ctx, S = this.S, STAGE = this.STAGE;
    for (const A of S.arcs) {
      const p2 = this.chunkXY(A.to);
      if (!p2) continue;
      const p1 = (A.from != null && this.chunkXY(A.from)) || { x: this.CR.x, y: this.CR.y };
      const dx = p2.x - p1.x, dy = p2.y - p1.y, L = Math.hypot(dx, dy) || 1;
      let nx = -dy / L, ny = dx / L;
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
      if (nx * (mx - STAGE.cx) + ny * (my - STAGE.cy) < 0) { nx = -nx; ny = -ny; }
      const cx = mx + nx * L * 0.3, cy = my + ny * L * 0.3, g = ease((this.TL.clock - A.born) / 750), fade = (S.stage > 4 ? 0.55 : 1) * (A.cut ? 0.45 : 1);
      const [qx, qy, ex, ey] = this.partialQuad(p1.x, p1.y, cx, cy, p2.x, p2.y, g);
      if (A.cut) ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.1; ctx.strokeStyle = A.cut ? `rgba(160,160,175,${0.5 * fade})` : `rgba(251,191,36,${0.5 * fade})`;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.quadraticCurveTo(qx, qy, ex, ey); ctx.stroke();
      ctx.lineWidth = 0.5; ctx.strokeStyle = `rgba(255,250,235,${0.45 * fade})`; ctx.stroke(); ctx.setLineDash([]);
      const s = this.w2s(p2.x, p2.y);
      if (A.cut && g >= 1) { this.PILLS.push({ key: "arc" + A.to, x: s.x, y: s.y, text: A.text, style: "dim", alpha: 1, dx: dx / L, dy: dy / L }); continue; }
      if (g >= 1) {
        const u = (this.RT * 0.32 + A.seed) % 1, q = this.quadPt(p1.x, p1.y, cx, cy, p2.x, p2.y, u);
        ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.8 * fade; ctx.drawImage(this.spr(C.yellow), q.x - 6, q.y - 6, 12, 12);
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = `rgba(255,250,235,${0.4 * fade})`; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(p2.x, p2.y);
        ctx.quadraticCurveTo(p2.x + nx * 16 + (dx / L) * 8, p2.y + ny * 16 + (dy / L) * 8, p2.x + nx * 6 + (dx / L) * 20, p2.y + ny * 6 + (dy / L) * 20); ctx.stroke();
        this.PILLS.push({ key: "arc" + A.to, x: s.x, y: s.y, text: (A.fr ? "F" + A.fr + " · " : "") + A.text, style: "bridge", alpha: S.stage > 4 && S.stage !== 7 ? 0.75 : 1, dx: dx / L, dy: dy / L });
      }
    }
  }
  private conceptPos(k: ConcettoScena, i: number) {
    const s = this.CS(), r = (150 + k.ring * 26) * s, RT = this.RT, a = k.ang + 0.04 * Math.sin(RT * 0.6 + i);
    return { x: this.CR.x + Math.cos(a) * r * (1 + 0.03 * Math.sin(RT * 0.9 + i)), y: this.CR.y + Math.sin(a) * r * 0.86 };
  }
  private drawConceptLinks(): void {
    const S = this.S, ctx = this.ctx;
    if (!S.concepts.length) return;
    const pos = new Map<Id, { x: number; y: number }>();
    S.concepts.forEach((k, i) => pos.set(k.id, this.conceptPos(k, i)));
    const dim = S.stage > 5 ? 0.55 : 1;
    ctx.lineWidth = 0.5; ctx.strokeStyle = `rgba(196,181,253,${0.13 * dim})`; ctx.beginPath();
    for (const k of S.concepts) { const p = pos.get(k.id)!; for (const id of k.chunks) { const q = this.chunkXY(id); if (q) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); } } }
    ctx.stroke();
    for (const e of S.cedges) {
      const a = pos.get(e.a), b = pos.get(e.b);
      if (!a || !b) continue;
      const col = REL_COL[e.rel] ?? REL_COL.correlato!, [R, G, B] = hx(col);
      ctx.strokeStyle = `rgba(${R},${G},${B},${(0.35 + 0.5 * (+e.w || 0.5)) * dim})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (e.from != null && e.rel !== "correlato" && e.rel !== "contraddice") {
        const src = e.from === e.a ? a : b, dst = src === a ? b : a, ang = Math.atan2(dst.y - src.y, dst.x - src.x), tx = dst.x - Math.cos(ang) * 6, ty = dst.y - Math.sin(ang) * 6;
        ctx.fillStyle = `rgba(${R},${G},${B},${0.9 * dim})`; ctx.beginPath(); ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(ang - 0.45) * 5, ty - Math.sin(ang - 0.45) * 5); ctx.lineTo(tx - Math.cos(ang + 0.45) * 5, ty - Math.sin(ang + 0.45) * 5); ctx.closePath(); ctx.fill();
      }
    }
    this.cpos = pos;
  }
  private drawConcepts(): void {
    const S = this.S, ctx = this.ctx, TL = this.TL;
    if (!S.concepts.length) return;
    const dim = S.stage === 7 ? 0.42 : S.stage > 5 ? 0.7 : 1;
    S.concepts.forEach((k, i) => {
      const p = this.cpos.get(k.id) || this.conceptPos(k, i), g = ease((TL.clock - k.born) / 380);
      if (g <= 0) return;
      const col = this.catColor(k.cat), r = (2 + Math.min(3, k.w * 0.9)) * g;
      ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.55 * dim; ctx.drawImage(this.spr(col), p.x - r * 4, p.y - r * 4, r * 8, r * 8); ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = dim; ctx.fillStyle = lighten(col, 0.35); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
      const la = S.stage >= 6 ? 1 - clamp((TL.clock - (TL.start[6] ?? TL.clock)) / 500, 0, 1) : 1;
      if (la <= 0.02) return;
      const s = this.w2s(p.x, p.y), right = Math.cos(k.ang) >= 0;
      this.LABELS.push({ x: s.x + (right ? 8 : -8), y: s.y + 3, t: corto(k.name.toLowerCase(), 24), font: (this.CW < 420 ? "500 8.5px " : "500 9.5px ") + MONO, col: lightenA(col, 0.5, 0.92 * g * dim * la), align: right ? "left" : "right", halo: la > 0.5, kind: "k" });
    });
  }
  /** I passaggi: quadratini colorati per stato, che si accendono quando vengono letti. */
  private drawChunks(): void {
    const S = this.S, ctx = this.ctx, F = this.F, showF = S.stage === 3 || S.stage === 4 || S.stage >= 7, pilled = new Set<Id>();
    for (const T of S.tent) if (T.tg.chunk != null) pilled.add(T.tg.chunk);
    for (const [id, st] of S.chunk) {
      const j = F.chunkP.get(id);
      if (j == null) continue;
      const x = F.px[j]!, y = F.py[j]!;
      let col = "#F4F4F5", a = 0.95, s = 2.4;
      if (st.st === "kept" || st.st === "ctx") { col = C.teal; s = 2.8; }
      else if (st.st === "bridge") { col = C.yellow; s = 2.8; }
      else if (st.st === "dup") col = C.amber;
      else if (st.st === "dropped" || st.st === "below") { col = "#6B6B78"; a = 0.5; s = 2; }
      if (st.glow > 0.02) {
        ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = st.glow * 0.85;
        const g = 10 + st.glow * 12;
        ctx.drawImage(this.spr(col === "#F4F4F5" ? C.lilac : col), x - g, y - g, 2 * g, 2 * g);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fillRect(x - s / 2, y - s / 2, s, s);
      if (st.st === "ctx" || st.st === "bridge") { ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this.RT * 3 + j); ctx.strokeStyle = col; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(x, y, 4.2, 0, TAU); ctx.stroke(); }
      if (showF && st.fr && st.st !== "bridge" && !pilled.has(id)) {
        const p = this.w2s(x, y);
        this.LABELS.push({ x: p.x + 5, y: p.y - 5, t: "F" + st.fr, font: "600 8.5px " + MONO, col: "rgba(153,246,228,.9)", align: "left", halo: true });
      }
    }
    ctx.globalAlpha = 1;
  }
  private drawTentacles(): void {
    const S = this.S, ctx = this.ctx, CR = this.CR, now = this.TL.clock;
    // i termini della domanda: pillole attorno al nucleo, che poi sfumano
    if (S.terms.length) {
      const fa = S.termFade == null ? 1 : 1 - clamp((now - S.termFade) / 700, 0, 1);
      if (fa > 0) {
        const n = S.terms.length, r = 118 * this.CS();
        ctx.lineWidth = 0.8;
        S.terms.forEach((t, i) => {
          const g = ease((now - t.born) / 300);
          if (g <= 0) return;
          const a = -Math.PI / 2 + (i / n) * TAU + 0.2, x = CR.x + Math.cos(a) * r * g, y = CR.y + Math.sin(a) * r * 0.82 * g;
          ctx.globalAlpha = 0.7 * fa; ctx.strokeStyle = TCOL.term!; ctx.beginPath(); ctx.moveTo(CR.x, CR.y); ctx.lineTo(x, y); ctx.stroke(); ctx.globalAlpha = 1;
          const s = this.w2s(x, y);
          this.PILLS.push({ key: "q" + i, x: s.x, y: s.y, text: t.w, style: "term", alpha: g * fa, dx: Math.cos(a), dy: Math.sin(a) });
        });
      }
    }
    for (let i = S.tent.length - 1; i >= 0; i--) { const T = S.tent[i]!; if (T.die !== Infinity && now > T.die) S.tent.splice(i, 1); }
    for (const T of S.tent) {
      const p = this.tentPos(T);
      if (!p) continue;
      const g = ease((now - T.born) / 280);
      if (g <= 0) continue;
      let al = T.die !== Infinity ? clamp((T.die - now) / 300, 0, 1) : 1;
      const x0 = CR.x, y0 = CR.y, dx = p.x - x0, dy = p.y - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
      const bend = T.bend * Math.min(L, 260) * 0.22 + Math.sin(this.RT * 1.7 + T.seed) * 4, cx = (x0 + p.x) / 2 + nx * bend, cy = (y0 + p.y) / 2 + ny * bend;
      const [qx, qy, ex, ey] = this.partialQuad(x0, y0, cx, cy, p.x, p.y, g);
      if (T.hide) al *= 0.5;
      ctx.globalAlpha = al; ctx.strokeStyle = T.style === "read" && T.alt ? TCOL.read2! : TCOL[T.style] ?? TCOL.read!; ctx.lineWidth = T.style === "dim" || T.hide ? 0.6 : 1;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(qx, qy, ex, ey); ctx.stroke();
      if (g >= 1) {
        ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(p.x - 1.3, p.y - 1.3, 2.6, 2.6);
        if (!T.hide && (T.style === "flag" || T.style === "kept" || T.style === "tool")) {
          ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.5 * al;
          ctx.drawImage(this.spr(T.style === "kept" ? C.teal : T.style === "flag" ? C.pink : C.rose), p.x - 7, p.y - 7, 14, 14);
          ctx.globalCompositeOperation = "source-over";
        }
        if (T.text && !T.hide) { const s = this.w2s(p.x, p.y); this.PILLS.push({ key: T.key, x: s.x, y: s.y, text: T.text, style: T.style, alpha: al, dx: dx / L, dy: dy / L }); }
      }
    }
    ctx.globalAlpha = 1;
  }
  private drawLegs(): void {
    const ctx = this.ctx, CR = this.CR;
    ctx.lineCap = "round";
    for (const l of CR.legs) {
      const a = l.a + CR.rot, hx0 = CR.x + Math.cos(a) * CR.R * 0.85, hy0 = CR.y + Math.sin(a) * CR.R * 0.7;
      let dx = l.fx - hx0, dy = l.fy - hy0, d = Math.hypot(dx, dy) || 1, fx = l.fx, fy = l.fy;
      const maxD = (l.l1 + l.l2) * 0.985;
      if (d > maxD) { fx = hx0 + (dx / d) * maxD; fy = hy0 + (dy / d) * maxD; d = maxD; dx = fx - hx0; dy = fy - hy0; }
      const a0 = Math.atan2(dy, dx), al = Math.acos(clamp((l.l1 * l.l1 + d * d - l.l2 * l.l2) / (2 * l.l1 * d), -1, 1));
      const k1x = hx0 + Math.cos(a0 + al) * l.l1, k1y = hy0 + Math.sin(a0 + al) * l.l1, k2x = hx0 + Math.cos(a0 - al) * l.l1, k2y = hy0 + Math.sin(a0 - al) * l.l1;
      const far1 = (k1x - CR.x) ** 2 + (k1y - CR.y) ** 2, far2 = (k2x - CR.x) ** 2 + (k2y - CR.y) ** 2;
      l.hx = hx0; l.hy = hy0; l.kx = far1 >= far2 ? k1x : k2x; l.ky = far1 >= far2 ? k1y : k2y; l.dfx = fx; l.dfy = fy;
    }
    const s = this.CS();
    ctx.strokeStyle = "rgba(45,212,191,0.12)"; ctx.lineWidth = 3 * s; ctx.beginPath(); for (const l of CR.legs) { ctx.moveTo(l.hx, l.hy); ctx.lineTo(l.kx, l.ky); } ctx.stroke();
    ctx.strokeStyle = "rgba(204,251,241,0.5)"; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.strokeStyle = "rgba(167,139,250,0.12)"; ctx.lineWidth = 2.4 * s; ctx.beginPath(); for (const l of CR.legs) { ctx.moveTo(l.kx, l.ky); ctx.lineTo(l.dfx, l.dfy); } ctx.stroke();
    ctx.strokeStyle = "rgba(236,236,246,0.5)"; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.strokeStyle = "rgba(45,212,191,0.85)"; ctx.lineWidth = 0.8; ctx.beginPath(); for (const l of CR.legs) { ctx.moveTo(l.kx + 1.6, l.ky); ctx.arc(l.kx, l.ky, 1.6, 0, TAU); } ctx.stroke();
    ctx.fillStyle = "#F9A8D4";
    for (const l of CR.legs) {
      ctx.globalAlpha = l.t < 1 ? 0.5 : 0.85; ctx.fillRect(l.dfx - 1.3, l.dfy - 1.3, 2.6, 2.6);
      if (l.flash > 0.05) { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = l.flash * 0.8; ctx.drawImage(this.spr(C.pink), l.dfx - 8, l.dfy - 8, 16, 16); ctx.globalCompositeOperation = "source-over"; }
    }
    ctx.globalAlpha = 1;
  }
  /** L'alone di filamenti radiali, come un soffione. */
  private drawFil(): void {
    const ctx = this.ctx, CR = this.CR, ex = CR.excite, RT = this.RT;
    const cols = ["rgba(139,92,246,0.55)", "rgba(99,102,241,0.5)", "rgba(196,181,253,0.45)", "rgba(236,233,254,0.32)"];
    ctx.lineWidth = 0.65;
    for (let c = 0; c < 4; c++) {
      ctx.strokeStyle = cols[c]!; ctx.beginPath();
      for (const f of CR.fil) {
        if (f.c !== c) continue;
        const a = f.a + CR.rot * 0.6 + 0.05 * Math.sin(RT * f.f + f.ph), L = f.len * ex * (0.74 + 0.26 * Math.sin(RT * f.f * 1.35 + f.ph)), j = this.ridotto ? 0 : (Math.random() - 0.5) * 1.4;
        const ca = Math.cos(a), sa = Math.sin(a);
        f.tx = CR.x + ca * (CR.R + L) + j; f.ty = CR.y + sa * (CR.R + L) * 0.86 - j;
        ctx.moveTo(CR.x + ca * CR.R * 1.04, CR.y + sa * CR.R * 0.76); ctx.lineTo(f.tx, f.ty);
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#F5F3FF";
    for (const f of CR.fil) { if (!f.dot) continue; const s = Math.sin(RT * f.f * 2 + f.ph); ctx.globalAlpha = 0.35 + 0.6 * s * s; ctx.fillRect(f.tx - 0.9, f.ty - 0.9, 1.8, 1.8); }
    ctx.globalAlpha = 1;
  }
  private drawCore(): void {
    const ctx = this.ctx, CR = this.CR, x = CR.x, y = CR.y, R = CR.R, RT = this.RT, pulse = Math.sin(RT * 3.1);
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.42; ctx.drawImage(this.spr(C.teal), x - R * 3.8, y - R * 3.8, R * 7.6, R * 7.6);
    ctx.globalAlpha = 0.27; ctx.drawImage(this.spr(C.violet), x - R * 8, y - R * 8, R * 16, R * 16);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.save(); ctx.translate(x, y); ctx.rotate(CR.head); ctx.scale(1, 0.7 + 0.03 * pulse);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fillStyle = "rgba(9,62,57,0.86)"; ctx.fill();
    // carapace a rete, ritagliato nell'ellisse
    ctx.save(); ctx.clip(); ctx.strokeStyle = "rgba(45,212,191,0.55)"; ctx.lineWidth = 0.7; ctx.beginPath();
    const st = Math.max(3, R / 6);
    for (let k = -R; k <= R; k += st) { ctx.moveTo(k, -R); ctx.lineTo(k, R); ctx.moveTo(-R, k); ctx.lineTo(R, k); }
    ctx.stroke(); ctx.restore();
    ctx.lineWidth = 2; ctx.strokeStyle = C.teal; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.stroke();
    ctx.lineWidth = 0.8; ctx.strokeStyle = "rgba(45,212,191,0.4)"; ctx.beginPath(); ctx.arc(0, 0, R + 5, 0, TAU); ctx.stroke();
    ctx.rotate(RT * 0.6); ctx.setLineDash([2, 6]); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(153,246,228,0.35)"; ctx.beginPath(); ctx.arc(0, 0, R + 11, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    const hr = R * 0.36 + pulse * 1.2;
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.75; ctx.drawImage(this.spr(C.hot), x - hr * 3.2, y - hr * 3.2, hr * 6.4, hr * 6.4);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(x, y, 0, x, y, hr * 1.6);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.35, "rgba(255,61,139,0.98)"); g.addColorStop(1, "rgba(255,61,139,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, hr * 1.6, 0, TAU); ctx.fill();
  }
  /** Le parole della risposta volano dal nucleo verso la chat. */
  private drawWords(): void {
    const S = this.S, ctx = this.ctx;
    if (!S.words.length) return;
    const ap = this.answerPoint();
    ctx.font = "500 9px " + MONO; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (let i = S.words.length - 1; i >= 0; i--) {
      const w = S.words[i]!, u = (this.RT - w.born) / w.dur;
      if (u >= 1) { S.words.splice(i, 1); continue; }
      const e = easeIO(u), cx = (w.x0 + ap.x) / 2, cy = (w.y0 + ap.y) / 2 + w.bend, p = this.quadPt(w.x0, w.y0, cx, cy, ap.x, ap.y, e), al = Math.sin(u * Math.PI);
      ctx.globalAlpha = al * 0.55; ctx.fillStyle = "#C4B5FD"; ctx.fillText(w.w, p.x, p.y - 6);
      const q = this.quadPt(w.x0, w.y0, cx, cy, ap.x, ap.y, Math.max(0, e - 0.04));
      ctx.globalAlpha = al * 0.8; ctx.fillStyle = C.pink; ctx.fillRect(q.x - 1, q.y - 1, 2, 2);
    }
    ctx.globalAlpha = 1; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }
  /** I nomi delle nebulose, con quanti passaggi letti o tenuti; sbiaditi se coperti dall'alone. */
  private drawClusterLabels(): void {
    const run = !!this.RUN?.R, S = this.S, T = this.LBL(), CR = this.CR, mob = this.mobile();
    const cs = this.w2s(CR.x, CR.y), halo = 124 * this.CS() * this.CAM.z;
    for (const cl of this.F.clusters) {
      if (!cl.name) continue;
      const p = this.w2s(cl.lx, cl.ly);
      let x = clamp(p.x, cl.lw / 2 + 4, this.CW - cl.lw / 2 - 4), y = clamp(p.y, 16, this.CH - 22);
      for (const b of this.AVOID) if (x - cl.lw / 2 < b.x + b.w && x + cl.lw / 2 > b.x && y - T.n - 2 < b.y + b.h && y + T.n * 1.2 > b.y) y = b.y + b.h + T.n + 3;
      cl.sx = cl.sx == null ? x : lerp(cl.sx, x, 0.2); cl.sy = cl.sy == null ? y : lerp(cl.sy, y, 0.2);
      x = cl.sx; y = cl.sy;
      const s = run ? S.cat.get(cl.cat) : undefined;
      const sotto = Math.abs(x - cs.x) < halo * 0.8 + cl.lw / 2 && Math.abs(y - cs.y) < halo * 0.8;
      const ta = sotto ? 0.35 : 1;
      cl.la = cl.la == null ? ta : lerp(cl.la, ta, 0.12);
      const fa = cl.la;
      const act = run && S.activeCat === cl.cat && S.stage >= 1 && S.stage <= 3 && !S.finished;
      let sub: string;
      if (!run) sub = `${cl.ndocs} doc · ${fmtK(cl.chunks)} passaggi`;
      else if (!s || !s.cand) sub = `${cl.ndocs} doc · non coinvolta`;
      else if (S.stage <= 1) sub = `${s.read}/${s.cand} passaggi · ${act ? "in lettura" : s.read >= s.cand ? "fatto" : "in coda"}`;
      else sub = `${s.kept}/${s.cand} tenuti · ${act ? "in lettura" : "fatto"}`;
      const dim = run && (!s || !s.cand);
      this.LABELS.push({ x, y, t: cl.name, font: (act ? `600 ${T.a}px ` : `500 ${T.n}px `) + MONO, col: act ? withA("#C4B5FD", fa.toFixed(2)) : dim ? `rgba(232,232,236,${(0.5 * fa).toFixed(2)})` : `rgba(236,236,241,${fa.toFixed(2)})`, align: "center", halo: fa > 0.6, ob: fa > 0.6 ? 2 : 0 });
      if (!mob || !dim) this.LABELS.push({ x, y: y + Math.round(T.n * 1.15), t: sub, font: `400 ${T.s}px ` + MONO, col: act ? `rgba(196,181,253,${(0.8 * fa).toFixed(2)})` : `rgba(140,140,154,${(0.75 * fa).toFixed(2)})`, align: "center", halo: fa > 0.6, ob: fa > 0.6 ? 2 : 0 });
    }
  }
  private labelRect(l: Etichetta, font: string): Rett {
    const w = this.tw(l.t, font), fs = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "9") || 9;
    const x = l.align === "center" ? l.x - w / 2 : l.align === "right" ? l.x - w : l.x;
    return { x: x - 2, y: l.y - fs * 0.85 - 1, w: w + 4, h: fs * 1.15 + 2 };
  }
  private drawLabels(): void {
    const ctx = this.ctx, hitR = (a: Rett, b: Rett) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    ctx.textBaseline = "alphabetic";
    let font = "";
    const setF = (f: string) => { if (f !== font) { ctx.font = f; font = f; } };
    this.OBST.length = 0;
    const XR = this.CW;
    for (const l of this.LABELS) {
      if (l.align === "center") continue;
      setF(l.font);
      const w = this.tw(l.t, font);
      if (l.align === "right") l.x = clamp(l.x, w + 4, XR - 4); else l.x = clamp(l.x, 4, XR - w - 4);
    }
    // i nomi delle nebulose hanno la precedenza: un concetto che li copre si accorcia o si nasconde
    const clR: Rett[] = [];
    for (const l of this.LABELS) if (l.ob === 2) { setF(l.font); clR.push(this.labelRect(l, font)); }
    const kR: Rett[] = [];
    for (const l of this.LABELS) {
      if (l.kind !== "k") continue;
      setF(l.font);
      let r = this.labelRect(l, font);
      const bad = (q: Rett) => clR.some(x => hitR(q, x)) || kR.some(x => hitR(q, x));
      if (bad(r)) {
        const w0 = l.t.split(" ")[0] ?? l.t;
        if (w0 !== l.t) { l.t = corto(w0, 12); if (l.align === "right") { const w = this.tw(l.t, font); l.x = clamp(l.x, w + 4, XR - 4); } r = this.labelRect(l, font); }
        if (bad(r)) { l.skip = true; continue; }
      }
      kR.push(r);
    }
    for (const l of this.LABELS) {
      if (l.skip) continue;
      setF(l.font);
      ctx.textAlign = l.align || "left";
      if (l.ob || l.kind === "k") this.OBST.push(this.labelRect(l, font));
      if (l.halo) { ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(5,5,7,.82)"; ctx.strokeText(l.t, l.x, l.y); }
      ctx.fillStyle = l.col; ctx.fillText(l.t, l.x, l.y);
    }
    ctx.textAlign = "left";
  }
  private rrect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  /** Le pillole: dal lato del tentacolo, nel posto libero più vicino, senza coprirsi. */
  private flushPills(): void {
    const ctx = this.ctx, PILLS = this.PILLS, TITLE = this.TITLE;
    this.PILLR.length = 0;
    if (!PILLS.length) return;
    ctx.font = "500 9px " + MONO; ctx.textBaseline = "middle";
    const H = 13, maxXP = this.CW, maxY = this.CH - 8;
    const R = PILLS.map(p => {
      const w = Math.round(this.tw(p.text, "pill") + 9), right = p.dx >= 0, x = right ? p.x + 7 : p.x - 7 - w, y0 = p.y - H / 2 + (p.dy < -0.35 ? -5 : p.dy > 0.35 ? 5 : 0);
      return { p, x: clamp(Math.round(x), 4, maxXP - w - 4), y: y0, y0, w };
    });
    const OB = [...this.OBST, ...this.AVOID], placed: Array<{ x: number; y: number; w: number }> = [];
    const free = (a: { x: number; w: number }, y: number) => {
      if (y < 4 || y + H > maxY - 2) return false;
      for (const q of placed) if (a.x < q.x + q.w + 3 && q.x < a.x + a.w + 3 && y < q.y + H + 2 && q.y < y + H + 2) return false;
      for (const b of OB) if (a.x < b.x + b.w && b.x < a.x + a.w && y < b.y + b.h && b.y < y + H) return false;
      return true;
    };
    R.sort((a, b) => b.p.alpha - a.p.alpha || a.y0 - b.y0);
    for (const a of R) {
      let y: number | null = null;
      for (let k = 0; k <= 22 && y == null; k++) for (const sg of k ? [-1, 1] : [1]) { const yy = a.y0 + sg * k * 8; if (free(a, yy)) { y = yy; break; } }
      a.y = y == null ? a.y0 : y;
      placed.push({ x: a.x, y: a.y, w: a.w });
    }
    const seen = new Set<string>();
    for (const r of R) {
      const k = r.p.key;
      seen.add(k);
      const off = r.y - r.y0, prev = this.PILLOFF.get(k), so = prev == null ? off : lerp(prev, off, 0.22);
      this.PILLOFF.set(k, so);
      let y = clamp(Math.round(r.y0 + so) + 0.5, 4, maxY - H - 2);
      const x = r.x + 0.5, st = PILL[r.p.style] ?? PILL.read;
      if (x < TITLE.x + TITLE.w && x + r.w > TITLE.x && y < TITLE.y + TITLE.h && y + H > TITLE.y) y = TITLE.y + TITLE.h + 2;
      if (r.p.alpha > 0.3) this.PILLR.push({ x, y, w: r.w, h: H });
      ctx.globalAlpha = r.p.alpha;
      if (Math.abs(so) > 4) { ctx.strokeStyle = st.br; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(r.p.x, r.p.y); ctx.lineTo(r.p.dx >= 0 ? x : x + r.w, y + H / 2); ctx.stroke(); }
      this.rrect(x, y, r.w, H, 2); ctx.fillStyle = st.bg; ctx.fill();
      if (st.dash) ctx.setLineDash([2, 2]);
      ctx.strokeStyle = st.br; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = st.tx; ctx.fillText(r.p.text, x + 4.5, y + H / 2 + 0.5);
    }
    for (const k of [...this.PILLOFF.keys()]) if (!seen.has(k)) this.PILLOFF.delete(k);
    ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic";
  }
}
