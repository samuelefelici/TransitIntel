/** Le variazioni decise in anticipo (tappa 4.10), senza React: si provano da sole. */

export interface Fascia { dalle: string; alle: string }
export interface VoceVariazione {
  id: number; giorno: string; tipo: "soppressione" | "sciopero";
  linee: string[]; numeri: string[]; dalle: string | null; alle: string | null; fasce: Fascia[] | null;
  causale: string; causaleDescrizione: string | null; nota: string | null;
  creataDa: string | null; creataIl: string; annullataDa: string | null; annullataIl: string | null;
  applicataIl: string | null; evento: number | null;
  stato: "in_attesa" | "applicata" | "annullata";
  corse: number | null; annullabile: boolean;
}

/** «1, 2/3 ,30» → ["1", "2/3", "30"]: le linee o i numeri, separati da virgole o spazi. */
export function elenco(testo: string): string[] {
  return [...new Set(testo.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean))];
}

const ORA = /^(\d{1,2})[:.](\d{2})$/;
const ora = (t: string) => {
  const m = ORA.exec(t.trim());
  return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : null;
};

/**
 * «6-9, 12:00-15:30» → le fasce garantite; null se una non si legge.
 * Un'ora senza minuti vale l'ora piena.
 */
export function leggiFasce(testo: string): Fascia[] | null {
  const parti = testo.split(/[,;]+/).map((x) => x.trim()).filter(Boolean);
  if (!parti.length) return null;
  const fasce: Fascia[] = [];
  for (const p of parti) {
    const m = /^(\d{1,2}(?:[:.]\d{2})?)\s*[-–]\s*(\d{1,2}(?:[:.]\d{2})?)$/.exec(p);
    if (!m) return null;
    const [dalle, alle] = [m[1]!, m[2]!].map((x) => ora(x.includes(":") || x.includes(".") ? x : `${x}:00`));
    if (!dalle || !alle) return null;
    fasce.push({ dalle, alle });
  }
  return fasce;
}

/** In poche parole, per l'elenco: cosa tocca. */
export function descrivi(v: Pick<VoceVariazione, "tipo" | "linee" | "numeri" | "dalle" | "alle" | "fasce">): string {
  const linee = v.linee.length ? `${v.linee.length === 1 ? "linea" : "linee"} ${v.linee.join(", ")}` : "tutte le linee";
  if (v.tipo === "sciopero") {
    return `Sciopero, ${linee}: garantite ${(v.fasce ?? []).map((f) => `${f.dalle}–${f.alle}`).join(" e ")}`;
  }
  const parti = [v.linee.length ? linee : null, v.numeri.length ? `${v.numeri.length === 1 ? "corsa" : "corse"} n. ${v.numeri.join(", ")}` : null]
    .filter(Boolean).join(", ");
  return `Soppressione: ${parti}${v.dalle && v.alle ? `, partenze ${v.dalle}–${v.alle}` : ", tutto il giorno"}`;
}
