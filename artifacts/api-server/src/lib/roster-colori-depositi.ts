/**
 * ═══════════════════════════════════════════════════════════════════════════
 * IL COLORE DI OGNI DEPOSITO DEL PERSONALE — lo stesso dei suoi turni
 * ───────────────────────────────────────────────────────────────────────────
 * Sul tabellone i turni guida hanno il colore del loro deposito: è il colore
 * del deposito di Planner Studio (tabella depots), che lo Scheduling Engine
 * copia nel turno (residenzaName/residenzaColor). I conducenti però stanno nel
 * catalogo del personale (roster_depositi), che ha nomi suoi: «Ancona» da una
 * parte, magari «Deposito di Ancona» dall'altra. Qui si accoppiano i due per
 * nome, codice o alias, così la righetta accanto al conducente ha lo stesso
 * colore dei turni del suo deposito.
 *
 * Da dove viene il colore, in quest'ordine:
 *   1. i turni sul tabellone (il colore che l'utente vede davvero nelle celle);
 *   2. i depositi di Planner Studio;
 *   3. una tavolozza fissa, per i depositi che non si ritrovano da nessuna parte.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { sql } from "drizzle-orm";
import { chiaveTesto, trovaDeposito, type Deposito } from "./anagrafica-campi";
import { righe, type Ex } from "./anagrafica-store";

export type FonteColore = "turni" | "planner" | "predefinito";

export interface ColoreDeposito {
  codice: string;
  nome: string;
  colore: string;
  da: FonteColore;
  /** il nome del deposito di Planner Studio (o dei turni) da cui viene il colore */
  depositoPlanner: string | null;
}

/** Un deposito con un colore, come arriva dai turni o da Planner Studio. */
export interface DepositoColorato { name: string; color: string }

/** Colori per i depositi che non si ritrovano: distinti fra loro e leggibili sul fondo scuro. */
export const TAVOLOZZA_DEPOSITI = [
  "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6",
  "#ef4444", "#14b8a6", "#84cc16", "#f97316", "#06b6d4",
];

const COLORE_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** La tinta (0–360°) di un colore #rgb o #rrggbb; null per i grigi, che non hanno tinta. */
function tinta(hex: string): number | null {
  const h = hex.replace("#", "");
  const pieno = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(pieno.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return null;
  const t = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (t * 60 + 360) % 360;
}

/** Due colori con tinte a meno di 22° l'uno dall'altro si confondono, sulla righetta. */
function tinteVicine(a: string, b: string): boolean {
  const ta = tinta(a), tb = tinta(b);
  if (ta === null || tb === null) return false;
  const d = Math.abs(ta - tb);
  return Math.min(d, 360 - d) < 22;
}

/* parole che accompagnano il nome di un deposito senza identificarlo */
const PAROLE_GENERICHE = new Set(["deposito", "depositi", "dep", "rimessa", "autorimessa", "sede", "di", "del", "della", "de"]);

/** Il nome di un deposito di Planner Studio senza «Deposito di», «Rimessa» e simili. */
export function nomeEssenziale(nome: string): string {
  return chiaveTesto(nome).split(" ").filter(p => p && !PAROLE_GENERICHE.has(p)).join(" ");
}

/**
 * Il deposito del personale che corrisponde a un deposito di Planner Studio.
 * Prima il confronto esatto (nome, codice, alias); poi un nome del catalogo
 * contenuto come parole intere («Jesi zona industriale» → Jesi). Se ce ne
 * sono più d'uno vince il più lungo, ma solo se contiene gli altri («Jesi
 * Urbano» contiene «Jesi»); due depositi diversi nello stesso nome («Osimo
 * Filottrano») non dicono quale: nessuno.
 */
export function depositoDelNome(nome: string, catalogo: Deposito[]): Deposito | null {
  const essenziale = nomeEssenziale(nome);
  if (!essenziale) return null;
  const esatto = trovaDeposito(essenziale, catalogo) ?? trovaDeposito(nome, catalogo);
  if (esatto) return esatto;
  const parole = ` ${essenziale} `;
  /* per ogni deposito il suo nome più lungo che compare fra le parole */
  const trovati: Array<{ dep: Deposito; nome: string }> = [];
  for (const dep of catalogo) {
    const nomi = [dep.nome, dep.codice, ...dep.alias].map(chiaveTesto).filter(n => n && parole.includes(` ${n} `));
    if (nomi.length) trovati.push({ dep, nome: nomi.reduce((a, b) => (b.length > a.length ? b : a)) });
  }
  if (trovati.length === 0) return null;
  const migliore = trovati.reduce((a, b) => (b.nome.length > a.nome.length ? b : a));
  const contiene = trovati.every(t => t.dep.codice === migliore.dep.codice || ` ${migliore.nome} `.includes(` ${t.nome} `));
  return contiene ? migliore.dep : null;
}

/**
 * Il colore di ogni deposito del catalogo. `fonti` in ordine di precedenza:
 * vince la prima che si accoppia al deposito. Funzione pura.
 */
export function abbinaColori(
  catalogo: Deposito[],
  fonti: Array<{ da: Exclude<FonteColore, "predefinito">; depositi: DepositoColorato[] }>,
): ColoreDeposito[] {
  const trovati = new Map<string, ColoreDeposito>();
  for (const fonte of fonti) {
    for (const d of fonte.depositi) {
      const colore = String(d.color ?? "").trim();
      if (!d.name || !COLORE_RE.test(colore)) continue;
      const dep = depositoDelNome(d.name, catalogo);
      if (!dep || trovati.has(dep.codice)) continue;
      trovati.set(dep.codice, { codice: dep.codice, nome: dep.nome, colore, da: fonte.da, depositoPlanner: d.name });
    }
  }
  /* la tavolozza: prima i colori lontani da quelli che i depositi hanno già
     (verde e smeraldo, uno accanto all'altro, sembrano lo stesso deposito) */
  const usati = [...trovati.values()].map(c => c.colore.toLowerCase());
  const liberi = TAVOLOZZA_DEPOSITI.filter(c => !usati.includes(c));
  const lontani = liberi.filter(c => usati.every(u => !tinteVicine(c, u)));
  const tavolozza = lontani.length ? lontani : liberi.length ? liberi : TAVOLOZZA_DEPOSITI;
  let i = 0;
  return catalogo.map(dep => trovati.get(dep.codice) ?? {
    codice: dep.codice, nome: dep.nome, colore: tavolozza[i++ % tavolozza.length]!, da: "predefinito" as const, depositoPlanner: null,
  });
}

/** I depositi di Planner Studio; se la tabella manca (installazione senza planner), nessuno. */
export async function depositiPlanner(ex: Ex): Promise<DepositoColorato[]> {
  try {
    const r = await ex.execute(sql`SELECT name, color FROM depots ORDER BY created_at NULLS LAST, name`);
    return righe(r).map(x => ({ name: String(x.name ?? ""), color: String(x.color ?? "") }));
  } catch { return []; }
}
