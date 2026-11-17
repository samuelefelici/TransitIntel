/**
 * I depositi dell'azienda nella pagina Amministrazione › Azienda (tappa 6.4;
 * nell'API lib/depositi.ts, GET e scritture su /api/admin/depositi). Funzioni
 * pure, coi loro test.
 */

export type Gruppo = "A" | "B";
export type Cadenza = "settimanale" | "semimensile";

export interface DepositoConUso {
  codice: string; nome: string; gruppo: Gruppo; cadenzaTurni: Cadenza; alias: string[]; ordine: number;
  conducenti: number; cambiProgrammati: number; gruppiTurni: number; utenti: number;
}

/** Che cosa vuol dire il gruppo: se il deposito lavora la domenica e nei festivi. */
export const GRUPPI: Array<[Gruppo, string]> = [
  ["A", "Fermo la domenica e nei festivi"],
  ["B", "In servizio anche la domenica"],
];
export const CADENZE: Array<[Cadenza, string]> = [
  ["semimensile", "Due periodi al mese (1–15, 16–fine)"],
  ["settimanale", "Ogni settimana"],
];
export const nomeGruppo = (g: Gruppo) => GRUPPI.find(([k]) => k === g)?.[1] ?? g;
export const nomeCadenza = (c: Cadenza) => CADENZE.find(([k]) => k === c)?.[1] ?? c;
/** Le stesse cose in una parola o due, per la tabella (la colonna dice già di che si parla). */
export const gruppoInBreve = (g: Gruppo) => (g === "A" ? "Fermo" : "In servizio");
export const cadenzaInBreve = (c: Cadenza) => (c === "settimanale" ? "Ogni settimana" : "Due al mese");

/** Il codice che si propone per un nome: «Jesi Urbano» → «jesi-urbano» (come nell'API). */
export function codiceDaNome(nome: string): string {
  return nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

/** Gli altri nomi scritti in una casella, separati da virgola o a capo. */
export function aliasDaTesto(s: string): string[] {
  const visti = new Set<string>(); const out: string[] = [];
  for (const pezzo of s.split(/[,\n]/)) {
    const t = pezzo.trim(), k = t.toLowerCase();
    if (!t || visti.has(k)) continue;
    visti.add(k); out.push(t);
  }
  return out;
}

export interface ModuloDeposito { nome: string; codice: string; gruppo: Gruppo; cadenzaTurni: Cadenza; alias: string; ordine: string }
export const MODULO_DEPOSITO_VUOTO: ModuloDeposito = { nome: "", codice: "", gruppo: "B", cadenzaTurni: "semimensile", alias: "", ordine: "" };
export const moduloDepositoDa = (d: DepositoConUso): ModuloDeposito => ({
  nome: d.nome, codice: d.codice, gruppo: d.gruppo, cadenzaTurni: d.cadenzaTurni, alias: d.alias.join(", "), ordine: String(d.ordine),
});

const CODICE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Gli errori del modulo (vuoto = si può salvare): gli stessi limiti dell'API. In un deposito nuovo il codice può restare vuoto. */
export function erroriDeposito(m: ModuloDeposito, nuovo: boolean): string[] {
  const e: string[] = [];
  const nome = m.nome.trim();
  if (!nome) e.push("Il nome va scritto");
  else if (nome.length > 60) e.push("Nome: al più 60 caratteri");
  if (nuovo) {
    const codice = m.codice.trim() || codiceDaNome(nome);
    if (nome && !CODICE.test(codice)) e.push("Codice: lettere minuscole, cifre e trattini, come jesi-urbano");
    else if (codice.length > 40) e.push("Codice: al più 40 caratteri");
  }
  const alias = aliasDaTesto(m.alias);
  if (alias.length > 30) e.push("Al più 30 altri nomi");
  if (alias.some((a) => a.length > 60)) e.push("Un altro nome: al più 60 caratteri");
  if (m.ordine.trim() && !/^\d{1,4}$/.test(m.ordine.trim())) e.push("Ordine: un numero intero fra 0 e 9999");
  return e;
}

/** Il corpo per creare: il codice solo se è stato scritto, l'ordine solo se c'è. */
export function corpoNuovoDeposito(m: ModuloDeposito) {
  return {
    nome: m.nome.trim(), gruppo: m.gruppo, cadenzaTurni: m.cadenzaTurni, alias: aliasDaTesto(m.alias),
    ...(m.codice.trim() ? { codice: m.codice.trim() } : {}),
    ...(m.ordine.trim() ? { ordine: Number(m.ordine.trim()) } : {}),
  };
}

/** Il corpo per modificare: il codice non cambia. */
export function corpoModificaDeposito(m: ModuloDeposito) {
  return {
    nome: m.nome.trim(), gruppo: m.gruppo, cadenzaTurni: m.cadenzaTurni, alias: aliasDaTesto(m.alias),
    ...(m.ordine.trim() ? { ordine: Number(m.ordine.trim()) } : {}),
  };
}

const quanti = (n: number, uno: string, tanti: string) => `${n.toLocaleString("it-IT")} ${n === 1 ? uno : tanti}`;

/** Chi usa il deposito, in poche voci; vuoto se nessuno. */
export function usoDelDeposito(d: DepositoConUso): string[] {
  return [
    d.conducenti > 0 ? quanti(d.conducenti, "conducente", "conducenti") : null,
    d.cambiProgrammati > 0 ? quanti(d.cambiProgrammati, "cambio programmato", "cambi programmati") : null,
    d.gruppiTurni > 0 ? quanti(d.gruppiTurni, "gruppo turni", "gruppi turni") : null,
    d.utenti > 0 ? quanti(d.utenti, "utente", "utenti") : null,
  ].filter((x): x is string => x !== null);
}

/** Un deposito in uso non si toglie: prima si sposta chi lo usa. */
export const depositoInUso = (d: DepositoConUso) => usoDelDeposito(d).length > 0;
