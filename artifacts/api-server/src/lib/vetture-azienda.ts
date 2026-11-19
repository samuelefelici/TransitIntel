/**
 * Le vetture dell'azienda nel canale dell'AVM (tappa 6.5, migrazione 0039).
 *
 * Nel canale passano anche le vetture delle aziende consorziate. Le pagine
 * dell'AVM guardano di base solo quelle dell'azienda, e il confronto col parco
 * dell'officina vale solo per quelle. Fino alla 6.5 la regola per
 * riconoscerle («matricola di 1-4 cifre = vettura Conerobus») era scritta in
 * tredici punti, tre dei quali nella web e uno in una query.
 *
 * Ora è un dato dell'azienda (azienda.avm_matricola_cifre) e sta qui, una
 * volta sola:
 *   cifre   quante cifre ha al più la matricola di una vettura dell'azienda;
 *           null: tutte le vetture del canale sono sue;
 *   nome    come si chiama l'azienda nei testi («solo Conerobus», l'oggetto
 *           delle email al centro, il vettore nel report);
 *   sigla   il nome in minuscole e trattini, per i nomi dei file.
 *
 * Le funzioni dell'AVM sono pure e sincrone, e la regola la usano in
 * profondità (l'identità di una vettura, che cosa ne dice l'officina). Per
 * non passarla da ogni firma, la regola in vigore sta in memoria: la aggiorna
 * `leggiAzienda()` a ogni lettura della riga (lib/azienda.ts, al più ogni
 * minuto), e chi apre un punto d'ingresso — una richiesta, un timer, un giro
 * del lavoratore — legge l'azienda prima di cominciare. Finché nessuno l'ha
 * letta vale la regola neutra: tutte le vetture sono dell'azienda.
 *
 * Niente import: lo usano lib/azienda.ts e i moduli dell'AVM.
 */

export interface RegolaVetture {
  /** al più quante cifre ha la matricola di una vettura dell'azienda; null: tutte le vetture sono sue */
  cifre: number | null;
  /** il nome dell'azienda nei testi */
  nome: string;
}

/** La regola di un'installazione che non ha ancora detto niente: nessuna consorziata nel canale. */
export const REGOLA_NEUTRA: RegolaVetture = Object.freeze({ cifre: null, nome: "Azienda" });

let inVigore: RegolaVetture = REGOLA_NEUTRA;
let schema: RegExp | null = null;

const cifreValide = (n: unknown): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 9 ? n : null);

/** Mette in vigore la regola (la chiama `leggiAzienda()`; nei test, chi prova un'azienda con le consorziate). */
export function impostaRegolaVetture(r: { cifre: number | null; nome: string }): void {
  const cifre = cifreValide(r.cifre);
  inVigore = Object.freeze({ cifre, nome: r.nome.trim() || REGOLA_NEUTRA.nome });
  schema = cifre === null ? null : new RegExp(`^\\d{1,${cifre}}$`);
}

/** La regola in vigore in questo processo. */
export const regolaVetture = (): RegolaVetture => inVigore;

/** Il nome dell'azienda nei testi dell'AVM. */
export const nomeAzienda = (): string => inVigore.nome;

/** Il nome dell'azienda per un nome di file: minuscole, cifre e trattini («conerobus»). */
export function siglaAzienda(): string {
  return inVigore.nome.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "azienda";
}

/** Se la matricola (come la pubblica il canale dell'AVM) è di una vettura dell'azienda. */
export function eDellAzienda(ref: string | null | undefined): boolean {
  if (schema === null) return true;
  return schema.test(String(ref ?? "").trim());
}

/**
 * La stessa regola per una query: l'espressione regolare di Postgres, o null
 * se tutte le vetture sono dell'azienda. Va passata come parametro, e la
 * query scrive `(p IS NULL OR colonna ~ p)`.
 */
export function espressioneVetture(): string | null {
  return inVigore.cifre === null ? null : `^[0-9]{1,${inVigore.cifre}}$`;
}

/* ── Il fornitore dell'AVM nei testi (tappa 6.27) ───────────────────────── */

/** Le forme del nome del fornitore dell'AVM, per scriverlo dentro una frase. */
export interface FornitoreAvm {
  /** nelle etichette corte: «Mizar», o «AVM» («Paline AVM», «Codice AVM») */
  breve: string;
  /** dentro la frase: «Mizar», o «il fornitore dell'AVM» */
  nome: string;
  /** a inizio frase: «Mizar», o «Il fornitore dell'AVM» */
  Nome: string;
  /** «a Mizar», o «al fornitore dell'AVM» */
  a: string;
  /** «di Mizar», o «del fornitore dell'AVM» */
  di: string;
  /** «da Mizar», o «dal fornitore dell'AVM» */
  da: string;
}

/** Le forme per un nome; senza nome, quelle che non nominano nessuno. */
export function formeFornitoreAvm(nome: string | null | undefined): FornitoreAvm {
  const n = String(nome ?? "").trim();
  if (!n) {
    return Object.freeze({
      breve: "AVM", nome: "il fornitore dell'AVM", Nome: "Il fornitore dell'AVM",
      a: "al fornitore dell'AVM", di: "del fornitore dell'AVM", da: "dal fornitore dell'AVM",
    });
  }
  return Object.freeze({ breve: n, nome: n, Nome: n, a: `a ${n}`, di: `di ${n}`, da: `da ${n}` });
}

let fornitore: FornitoreAvm = formeFornitoreAvm(null);

/** Mette in vigore il nome del fornitore (la chiama `leggiAzienda()`; nei test, chi prova un'azienda col suo fornitore). */
export function impostaFornitoreAvm(nome: string | null | undefined): void {
  fornitore = formeFornitoreAvm(nome);
}

/** Le forme del nome del fornitore dell'AVM in vigore in questo processo. */
export const fornitoreAvm = (): FornitoreAvm => fornitore;

/** «solo le vetture dell'azienda»: il perimetro chiesto da una pagina o da un link. «conerobus» è il nome di prima, nei link già salvati. */
export const perimetroAzienda = (v: unknown): boolean => v === "azienda" || v === "conerobus";
