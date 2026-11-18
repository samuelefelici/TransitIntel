/**
 * Le reti dell'azienda (tappa 6.7): l'extraurbana e le urbane, con le regole
 * che dal nome breve di una linea ricavano la rete. Sono dati dell'azienda:
 * arrivano con la sessione (etichette, sigle e colori delle pagine vengono
 * da qui) e l'amministratore li cambia dalla pagina Azienda.
 * API: la sessione (/api/auth/me) e /api/admin/reti. I conti stanno qui.
 */

export const RETE_EXTRAURBANA = "extraurbano";

/** Una rete come arriva con la sessione. */
export interface Rete {
  rete: string;
  tipo: "urbano" | "extraurbano";
  /** il nome per esteso, quello del GTFS: «Urbano di Ancona» */
  nome: string;
  /** solo delle urbane: «Ancona» */
  luogo: string | null;
  /** solo delle urbane: «AN» */
  sigla: string | null;
  /** solo delle urbane: il codice delle fermate servite solo da questa rete (da 2 a 9); con l'extraurbano, lo stesso più 10 */
  codice: number | null;
  colore: string;
}

/** Le reti di un'installazione che non ha ancora detto niente: il solo extraurbano. */
export const RETI_NEUTRE: readonly Rete[] = Object.freeze([
  Object.freeze({ rete: RETE_EXTRAURBANA, tipo: "extraurbano" as const, nome: "Extraurbano", luogo: null, sigla: null, codice: null, colore: "#f59e0b" }),
]);

const COLORE = /^#[0-9a-f]{6}$/i;
const testo = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

/** Le reti arrivate dal server, controllate una per una; se non sono un elenco con l'extraurbano, quelle neutre. */
export function retiValide(x: unknown): readonly Rete[] {
  if (!Array.isArray(x)) return RETI_NEUTRE;
  const reti: Rete[] = [];
  for (const v of x) {
    const d = v && typeof v === "object" ? v as Record<string, unknown> : null;
    const rete = testo(d?.rete, 40), nome = testo(d?.nome, 60);
    if (!d || !rete || !nome || !/^[a-z][a-z0-9_]*$/.test(rete)) continue;
    const tipo = d.tipo === "urbano" ? "urbano" : "extraurbano";
    reti.push({
      rete, tipo, nome,
      luogo: tipo === "urbano" ? testo(d.luogo, 40) : null,
      sigla: tipo === "urbano" ? testo(d.sigla, 4) : null,
      codice: tipo === "urbano" && typeof d.codice === "number" && Number.isInteger(d.codice) && d.codice >= 2 && d.codice <= 9 ? d.codice : null,
      colore: typeof d.colore === "string" && COLORE.test(d.colore) ? d.colore.toLowerCase() : "#64748b",
    });
  }
  return reti.some((r) => r.rete === RETE_EXTRAURBANA) ? reti : RETI_NEUTRE;
}

/* ── Le reti in vigore, per il codice che non è un componente ───────────────
 * (le esportazioni a stampa). I componenti usano useReti(). */
let inVigore: readonly Rete[] = RETI_NEUTRE;
export function impostaReti(reti: readonly Rete[]): void { inVigore = reti; }
export const retiInVigore = (): readonly Rete[] => inVigore;

/* ── Come si mostra una rete ───────────────────────────────────────────── */

/** L'etichetta corta nelle pagine: «Urbano Ancona», «Extraurbano». */
export const etichettaRete = (r: Pick<Rete, "tipo" | "luogo" | "nome">): string =>
  r.tipo === "urbano" ? `Urbano ${r.luogo ?? r.nome}` : "Extraurbano";

/** L'etichetta di una rete dal suo identificativo; se non è nell'elenco, l'identificativo com'è. */
export function etichettaDi(reti: readonly Rete[], rete: string | null | undefined): string {
  if (!rete) return "—";
  const r = reti.find((x) => x.rete === rete);
  return r ? etichettaRete(r) : rete;
}

/** Il colore di una rete; se non è nell'elenco, quello di riserva. */
export function coloreDi(reti: readonly Rete[], rete: string | null | undefined, riserva = "#64748b"): string {
  return reti.find((x) => x.rete === rete)?.colore ?? riserva;
}

/** La sigla nelle tabelle strette: «AN» per un'urbana, «Extra» per l'extraurbano; se non è nell'elenco, l'identificativo. */
export function siglaDi(reti: readonly Rete[], rete: string): string {
  const r = reti.find((x) => x.rete === rete);
  if (!r) return rete;
  return r.tipo === "urbano" ? r.sigla ?? r.rete : "Extra";
}

/** Le reti come voci di un menu a tendina. */
export const opzioniReti = (reti: readonly Rete[]): { value: string; label: string; color: string }[] =>
  reti.map((r) => ({ value: r.rete, label: etichettaRete(r), color: r.colore }));

/* ── Le categorie delle linee nell'analisi di un feed ──────────────────── */

/** Una categoria con cui l'analisi di un feed classifica le linee; il tipo decide il corrispettivo €/km. */
export interface CategoriaLinea { id: string; label: string; fareType: "urban" | "suburban" | "night" | null; color: string }

/**
 * Le categorie che l'analisi propone: una per rete dell'azienda, poi
 * «Notturno» e «Altro». L'identificativo è quello della rete.
 */
export function categorieDelleLinee(reti: readonly Rete[]): CategoriaLinea[] {
  return [
    ...reti.map((r): CategoriaLinea => ({ id: r.rete, label: etichettaRete(r), fareType: r.tipo === "urbano" ? "urban" : "suburban", color: r.colore })),
    { id: "notturno", label: "Notturno", fareType: "night", color: "#8b5cf6" },
    { id: "altro", label: "Altro", fareType: null, color: "#6b7280" },
  ];
}

/** La categoria salvata su una linea, o null se non è fra quelle di oggi (una rete tolta). */
export function categoriaDi(categorie: readonly CategoriaLinea[], id: string | null | undefined): CategoriaLinea | null {
  return (id && categorie.find((c) => c.id === id)) || null;
}

/* ── Le classi delle fermate ───────────────────────────────────────────── */

export type TipoClasse = "none" | "extra" | "urban" | "mixed" | "other";

/** Una classe di fermata: il codice, come si chiama e la sigla (le stesse che scrive l'API nelle fermate). */
export interface ClasseFermata { code: number; label: string; shortCode: string; kind: TipoClasse }

/**
 * Tutte le classi di fermata di questa azienda, in ordine: non servita (0),
 * extraurbano (1), una per rete urbana (il suo codice), la stessa con
 * l'extraurbano (il codice più 10), e «multi-rete» (99) per tutto il resto.
 */
export function classiFermate(reti: readonly Rete[]): ClasseFermata[] {
  const urbane = reti.filter((r): r is Rete & { codice: number } => r.tipo === "urbano" && r.codice !== null).sort((a, b) => a.codice - b.codice);
  const luogo = (r: Rete) => r.luogo ?? r.nome;
  const sigla = (r: Rete) => r.sigla ?? r.rete.toUpperCase();
  return [
    { code: 0, label: "Non servita", shortCode: "NONE", kind: "none" },
    { code: 1, label: "Extraurbano", shortCode: "EXTRA", kind: "extra" },
    ...urbane.map((r): ClasseFermata => ({ code: r.codice, label: `Urbano ${luogo(r)}`, shortCode: `URB_${sigla(r)}`, kind: "urban" })),
    ...urbane.map((r): ClasseFermata => ({ code: r.codice + 10, label: `Mista Extraurbano + Urbano ${luogo(r)}`, shortCode: `MIX_EX_${sigla(r)}`, kind: "mixed" })),
    { code: 99, label: "Multi-rete non prevista", shortCode: "OTHER", kind: "other" },
  ];
}

/* ── La pagina dell'amministratore ─────────────────────────────────────── */

export interface UsoRete { linee: number; titoli: number; catalogo: number; zone: number; regoleTariffarie: number; regole: number }

/** Una rete come la dà /api/admin/reti: con la zona, il codice e chi la usa. */
export interface ReteConUso extends Rete {
  zona: string | null;
  ordine: number;
  uso: UsoRete;
}

export const TIPI_REGOLA = ["inizia", "uguale", "inizia_poi_cifra", "inizia_con_cifra", "lettere_puntate"] as const;
export type TipoRegola = (typeof TIPI_REGOLA)[number];

export interface RegolaLinea { tipo: TipoRegola; valore: string | null; rete: string }
export interface ElencoReti { reti: ReteConUso[]; regole: RegolaLinea[]; massimoRetiUrbane: number; massimoRegole: number }

/** Come si chiama ogni tipo di regola nel menu: completa la frase «Se il nome breve…». Corti: stanno in una tendina stretta. */
export const NOME_TIPO: Record<TipoRegola, string> = {
  inizia: "comincia con",
  uguale: "è uguale a",
  inizia_poi_cifra: "comincia con… più una cifra",
  inizia_con_cifra: "comincia con una cifra",
  lettere_puntate: "è di due lettere puntate (C.D.)",
};
export const regolaVuoleValore = (tipo: TipoRegola): boolean => tipo === "inizia" || tipo === "uguale" || tipo === "inizia_poi_cifra";

/** Come si legge una regola: «comincia con JE». */
export function testoRegola(g: Pick<RegolaLinea, "tipo" | "valore">): string {
  switch (g.tipo) {
    case "inizia": return `comincia con ${g.valore ?? "…"}`;
    case "uguale": return `è ${g.valore ?? "…"}`;
    case "inizia_poi_cifra": return `comincia con ${g.valore ?? "…"} seguito da una cifra`;
    case "inizia_con_cifra": return "comincia con una cifra";
    case "lettere_puntate": return "sono due lettere puntate";
  }
}

/** Chi usa una rete e quindi impedisce di toglierla, a parole. Le regole delle linee non contano: se ne vanno con lei. */
export function usoDellaRete(u: UsoRete): string[] {
  const voce = (n: number, una: string, tante: string) => (n > 0 ? `${n.toLocaleString("it-IT")} ${n === 1 ? una : tante}` : "");
  return [
    voce(u.linee, "linea", "linee"), voce(u.titoli, "titolo di viaggio", "titoli di viaggio"),
    voce(u.catalogo, "titolo nel catalogo", "titoli nel catalogo"),
    voce(u.zone, "zona", "zone"), voce(u.regoleTariffarie, "regola tariffaria", "regole tariffarie"),
  ].filter(Boolean);
}
export const reteInUso = (u: UsoRete): boolean => usoDellaRete(u).length > 0;

/** La domanda prima di togliere una rete: dice che cosa se ne va con lei. */
export function domandaTogliRete(r: Pick<ReteConUso, "nome" | "uso">): string {
  const n = r.uso.regole;
  const regole = n === 0 ? "" : n === 1
    ? " Con lei tolgo la sua regola: le linee che la seguivano tornano extraurbane."
    : ` Con lei tolgo le sue ${n} regole: le linee che le seguivano tornano extraurbane.`;
  return `Tolgo la rete «${r.nome}»?${regole} Se servirà di nuovo va ricreata.`;
}

/* il modulo di una rete: tutto testo, come lo scrive chi compila */
export interface ModuloRete { luogo: string; nome: string; sigla: string; colore: string; ordine: string }
export const MODULO_RETE_VUOTO: ModuloRete = { luogo: "", nome: "", sigla: "", colore: "", ordine: "" };
export const moduloReteDa = (r: ReteConUso): ModuloRete => ({
  luogo: r.luogo ?? "", nome: r.nome, sigla: r.sigla ?? "", colore: r.colore, ordine: String(r.ordine),
});

/** La sigla che si propone per un luogo: le prime due lettere, «Pesaro» → «PE». */
export function siglaDaLuogo(luogo: string): string {
  return luogo.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2);
}

/* il nome e il luogo finiscono nei file del GTFS: solo lettere, cifre, spazi e pochi segni (come nell'API) */
const TESTO_PULITO = /^[\p{L}\p{N} .'’()\/-]+$/u;

/** Che cosa non va nel modulo, in parole; vuoto se si può salvare. `urbana`: l'extraurbano non ha luogo né sigla. */
export function erroriRete(m: ModuloRete, urbana: boolean, nuova: boolean): string[] {
  const e: string[] = [];
  if (urbana) {
    const luogo = m.luogo.trim();
    if (!luogo) e.push("Scrivi il luogo della rete, per esempio «Pesaro».");
    else if (luogo.length > 40) e.push("Il luogo è troppo lungo: al più 40 caratteri.");
    else if (!TESTO_PULITO.test(luogo)) e.push("Nel luogo vanno solo lettere, cifre, spazi e i segni . ' - / ( ).");
    else if (nuova && !/[a-z0-9]/i.test(luogo.normalize("NFD").replace(/\p{M}/gu, ""))) e.push("Nel luogo servono lettere o cifre.");
    if (!/^[A-Za-z0-9]{1,4}$/.test(m.sigla.trim())) e.push("La sigla ha da una a quattro lettere o cifre, per esempio «PS».");
  }
  const nome = m.nome.trim();
  if (!nome && !(urbana && nuova)) e.push("Scrivi il nome della rete.");
  if (nome.length > 60) e.push("Il nome è troppo lungo: al più 60 caratteri.");
  else if (nome && !TESTO_PULITO.test(nome)) e.push("Nel nome vanno solo lettere, cifre, spazi e i segni . ' - / ( ).");
  if (m.colore.trim() && !COLORE.test(m.colore.trim())) e.push("Il colore è di sei cifre esadecimali, per esempio «#3b82f6».");
  if (m.ordine.trim() && !/^\d{1,4}$/.test(m.ordine.trim())) e.push("L'ordine è un numero da 0 a 9999.");
  return e;
}

/** Il corpo di POST /api/admin/reti: i campi lasciati vuoti non partono, li decide il server. */
export function corpoNuovaRete(m: ModuloRete) {
  return {
    luogo: m.luogo.trim(),
    sigla: m.sigla.trim().toUpperCase(),
    ...(m.nome.trim() ? { nome: m.nome.trim() } : {}),
    ...(m.colore.trim() ? { colore: m.colore.trim().toLowerCase() } : {}),
    ...(m.ordine.trim() ? { ordine: Number(m.ordine.trim()) } : {}),
  };
}

/** Il corpo di PUT /api/admin/reti/:rete. */
export function corpoModificaRete(m: ModuloRete, urbana: boolean) {
  return {
    nome: m.nome.trim(),
    ...(urbana ? { luogo: m.luogo.trim(), sigla: m.sigla.trim().toUpperCase() } : {}),
    ...(m.colore.trim() ? { colore: m.colore.trim().toLowerCase() } : {}),
    ...(m.ordine.trim() ? { ordine: Number(m.ordine.trim()) } : {}),
  };
}

/* le regole in bozza: il valore resta testo finché non si salva */
export interface RegolaInBozza { tipo: TipoRegola; valore: string; rete: string }
export const bozzaDa = (regole: readonly RegolaLinea[]): RegolaInBozza[] => regole.map((g) => ({ tipo: g.tipo, valore: g.valore ?? "", rete: g.rete }));

/** Il valore come lo salverà il server: maiuscole, senza spazi ai lati; niente per i tipi che non ne hanno. */
const valorePulito = (g: RegolaInBozza): string | null => (regolaVuoleValore(g.tipo) ? g.valore.trim().toUpperCase() : null);

/** Il corpo di PUT /api/admin/reti/regole e dell'anteprima. */
export const corpoRegole = (bozza: readonly RegolaInBozza[]) => ({
  regole: bozza.map((g) => ({ tipo: g.tipo, valore: valorePulito(g), rete: g.rete })),
});

/** Che cosa non va nelle regole in bozza, una riga per problema; vuoto se si possono salvare. */
export function erroriRegole(bozza: readonly RegolaInBozza[], reti: readonly Pick<Rete, "rete">[], massimo: number): string[] {
  const e: string[] = [];
  if (bozza.length > massimo) e.push(`Le regole sono al più ${massimo}.`);
  const note = new Set(reti.map((r) => r.rete));
  const viste = new Map<string, number>();
  bozza.forEach((g, i) => {
    const n = i + 1;
    const valore = valorePulito(g);
    if (regolaVuoleValore(g.tipo)) {
      if (!valore) e.push(`Regola ${n}: manca il valore.`);
      else if (!/^[A-Z0-9./ -]{1,12}$/.test(valore)) e.push(`Regola ${n}: il valore ha al più 12 fra lettere, cifre, punto, barra, trattino e spazio.`);
    }
    if (!note.has(g.rete)) e.push(`Regola ${n}: scegli la rete.`);
    const chiave = `${g.tipo}|${valore ?? ""}`;
    const prima = viste.get(chiave);
    if (prima !== undefined && (valore || !regolaVuoleValore(g.tipo))) e.push(`Regola ${n}: è uguale alla ${prima}, e vale solo la prima.`);
    else viste.set(chiave, n);
  });
  return e;
}

/** Vero se la bozza è diversa dalle regole salvate. */
export function regoleCambiate(bozza: readonly RegolaInBozza[], salvate: readonly RegolaLinea[]): boolean {
  return JSON.stringify(corpoRegole(bozza).regole) !== JSON.stringify(salvate.map((g) => ({ tipo: g.tipo, valore: g.valore, rete: g.rete })));
}

/** Sposta una regola su o giù di un posto; fuori dai bordi non fa niente. */
export function spostaRegola<T>(regole: readonly T[], i: number, di: -1 | 1): T[] {
  const j = i + di;
  if (i < 0 || i >= regole.length || j < 0 || j >= regole.length) return [...regole];
  const copia = [...regole];
  [copia[i], copia[j]] = [copia[j]!, copia[i]!];
  return copia;
}

/* l'anteprima: che cosa cambierebbe salvando */
export interface LineaCheCambia { linea: string; da: string; a: string; cambiaServizio: boolean }
export interface AnteprimaRegole { fonte: "esercizio" | "planning"; linee: number; cambiano: LineaCheCambia[]; perRete: Record<string, number> }

/** L'anteprima in una frase: quante linee cambiano rete, e quante cambiano riposo nel Roster. */
export function riassuntoAnteprima(a: AnteprimaRegole): string {
  const dove = a.fonte === "esercizio" ? "del programma in esercizio" : "di Planning Studio";
  const linee = `${a.linee.toLocaleString("it-IT")} ${a.linee === 1 ? "linea" : "linee"} ${dove}`;
  if (a.linee === 0) return "Non ci sono linee su cui provare le regole.";
  if (a.cambiano.length === 0) return `Su ${linee} nessuna cambia rete.`;
  const servizio = a.cambiano.filter((c) => c.cambiaServizio).length;
  const cambia = a.cambiano.length === 1 ? "una cambia rete" : `${a.cambiano.length.toLocaleString("it-IT")} cambiano rete`;
  const quante = servizio === a.cambiano.length ? (servizio === 1 ? "Passa" : "Passano tutte")
    : servizio === 1 ? "Una passa" : `${servizio.toLocaleString("it-IT")} passano`;
  const riposo = servizio === 0 ? ""
    : ` ${quante} da ${servizio === 1 ? "urbana a extraurbana" : "urbane a extraurbane"} o viceversa: nel Roster cambia il riposo minimo fra due turni.`;
  return `Su ${linee}, ${cambia}.${riposo}`;
}
