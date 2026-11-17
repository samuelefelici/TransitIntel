/**
 * Le reti e le regole di un'azienda di prova: quelle di Conerobus, le stesse
 * che la migrazione 0040 carica nella sua installazione (un test le confronta
 * riga per riga). Chi prova la classificazione delle linee le mette in vigore
 * con `conLeRetiDiProva()`; senza, vale l'elenco neutro: il solo extraurbano.
 */
import { impostaReti, RETI_NEUTRE, type RegolaLinea, type Rete, type RetiAzienda } from "../../lib/reti-linee";

const urbana = (luogo: string, sigla: string, codice: number, colore: string): Rete => {
  const chiave = luogo.toLowerCase();
  return {
    rete: `urbano_${chiave}`, tipo: "urbano", nome: `Urbano di ${luogo}`, luogo, sigla,
    zona: `${chiave}_urban`, codice, colore, ordine: codice - 1,
  };
};

export const RETI_DI_PROVA: RetiAzienda = {
  reti: [
    urbana("Ancona", "AN", 2, "#3b82f6"),
    urbana("Jesi", "JE", 3, "#8b5cf6"),
    urbana("Falconara", "FA", 4, "#06b6d4"),
    urbana("Senigallia", "SE", 5, "#10b981"),
    urbana("Castelfidardo", "CF", 6, "#f97316"),
    urbana("Sassoferrato", "SS", 7, "#ec4899"),
    { rete: "extraurbano", tipo: "extraurbano", nome: "Extraurbano Provincia di Ancona", luogo: null, sigla: null, zona: null, codice: null, colore: "#f59e0b", ordine: 7 },
  ],
  regole: [
    { tipo: "inizia", valore: "JE", rete: "urbano_jesi" },
    { tipo: "inizia", valore: "Y", rete: "urbano_falconara" },
    { tipo: "inizia_poi_cifra", valore: "BUS", rete: "urbano_senigallia" },
    { tipo: "inizia_poi_cifra", valore: "BUSS", rete: "urbano_senigallia" },
    { tipo: "uguale", valore: "CIRCA", rete: "urbano_castelfidardo" },
    { tipo: "uguale", valore: "CIRCB", rete: "urbano_castelfidardo" },
    { tipo: "inizia_con_cifra", valore: null, rete: "urbano_ancona" },
    { tipo: "lettere_puntate", valore: null, rete: "urbano_ancona" },
  ] satisfies RegolaLinea[],
};

/** Mette in vigore le reti di prova in questo processo. */
export function conLeRetiDiProva(): void { impostaReti(RETI_DI_PROVA); }

/** Rimette l'elenco neutro: il solo extraurbano, nessuna regola. */
export function senzaReti(): void { impostaReti(RETI_NEUTRE); }
