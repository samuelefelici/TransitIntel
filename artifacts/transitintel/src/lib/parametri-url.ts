/** I parametri di una lettura: quelli non dati (undefined) non vanno nell'indirizzo. */
export type Parametri = Record<string, string | number | boolean | null | undefined>;

/** `/percorso?chiave=valore`, con i valori codificati e senza i parametri non dati. */
export function conParametri(percorso: string, parametri?: Parametri): string {
  const q = new URLSearchParams();
  for (const [chiave, valore] of Object.entries(parametri ?? {})) {
    if (valore !== undefined) q.append(chiave, valore === null ? "null" : String(valore));
  }
  const s = q.toString();
  return s ? `${percorso}?${s}` : percorso;
}
