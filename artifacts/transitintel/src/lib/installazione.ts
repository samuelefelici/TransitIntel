/**
 * Che cosa ha scritto l'azienda e che cosa le manca (tappa 6.18): i tipi di
 * GET /api/admin/installazione e il modo di mostrarli nella pagina
 * Amministrazione › Azienda. Senza React: si prova da solo.
 */

export type StatoVoce = "compilata" | "da_compilare" | "facoltativa";

export interface Voce {
  voce: string;
  titolo: string;
  stato: StatoVoce;
  dettaglio: string;
  seManca: string;
  avviso: string | null;
  dove: { pagina: string; sezione: string | null; etichetta: string };
}

export interface StatoInstallazione { voci: Voce[]; daCompilare: number; facoltativeVuote: number }

export const ETICHETTE_STATO: Record<StatoVoce, string> = {
  compilata: "compilata", da_compilare: "da compilare", facoltativa: "facoltativa, vuota",
};

const PESO: Record<StatoVoce, number> = { da_compilare: 0, facoltativa: 1, compilata: 2 };

/** Prima quelle da compilare, poi le facoltative vuote, poi le compilate; dentro, l'ordine dell'API. */
export const vociInOrdine = (voci: readonly Voce[]): Voce[] =>
  voci.map((v, i) => ({ v, i })).sort((a, b) => PESO[a.v.stato] - PESO[b.v.stato] || a.i - b.i).map((x) => x.v);

/** La riga in cima: che cosa resta da fare. */
export function riassuntoInstallazione(s: Pick<StatoInstallazione, "daCompilare" | "facoltativeVuote" | "voci">): string {
  const avvisi = s.voci.filter((v) => v.avviso).length;
  const parti = [
    s.daCompilare === 0 ? "Le voci che servono sono tutte compilate" : s.daCompilare === 1 ? "1 voce da compilare" : `${s.daCompilare} voci da compilare`,
  ];
  if (s.facoltativeVuote > 0) parti.push(s.facoltativeVuote === 1 ? "1 facoltativa vuota" : `${s.facoltativeVuote} facoltative vuote`);
  if (avvisi > 0) parti.push(avvisi === 1 ? "1 avviso" : `${avvisi} avvisi`);
  return `${parti.join(", ")}.`;
}

/** Dove porta il collegamento di una voce: la sezione di questa pagina, o un'altra pagina. */
export function collegamento(v: Pick<Voce, "dove">, paginaAttuale: string): { tipo: "sezione"; id: string } | { tipo: "pagina"; href: string } {
  if (v.dove.sezione && v.dove.pagina === paginaAttuale) return { tipo: "sezione", id: v.dove.sezione };
  return { tipo: "pagina", href: v.dove.sezione ? `${v.dove.pagina}#${v.dove.sezione}` : v.dove.pagina };
}
