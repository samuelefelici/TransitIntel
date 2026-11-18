/**
 * I nodi di scambio della pagina Intermodale (stazioni, porti, aeroporti):
 * come si scrivono dove lo spazio è poco. Senza React: si prova da solo.
 */

/**
 * Il nome corto di un nodo, dal nome per esteso: «Stazione FS Rossi» →
 * «Rossi», «Stazione di Città Quartiere» → «Quartiere», «Porto di Città
 * (Terminal Passeggeri)» → «Porto Città», «Aeroporto Tal dei Tali (Luogo)» →
 * «Aeroporto». Un nome che non comincia così resta com'è.
 */
export function nomeCortoDelNodo(nome: string): string {
  const porto = /^Porto di (\S+)/.exec(nome);
  if (porto) return `Porto ${porto[1]}`;
  if (/^Aeroporto\b/.test(nome)) return "Aeroporto";
  return nome.replace(/^Stazione (?:FS |di (?:\S+ (?=\S))?)?/, "");
}
