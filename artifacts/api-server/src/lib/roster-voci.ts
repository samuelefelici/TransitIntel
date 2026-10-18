/**
 * Le voci di assenza e presenza del roster, e chi vede i codici sanitari.
 *
 * Malattia, infortunio e permesso 104 sono dati sulla salute (GDPR art. 9):
 * li vede e li scrive chi ha il permesso «roster» (vedeCodiciSanitari in
 * lib/auth.ts), mai un token emesso per Argos. Chi non li vede legge
 * un'assenza generica, ASS: sa che il conducente manca, non perché.
 */

export type CategoriaVoce = "assenza" | "presenza";

/** Catalogo voci Assenza/Presenza. Estendibile: aggiungi qui nuovi codici. */
export const VOCI_CATALOG: Record<CategoriaVoce, Array<{ code: string; label: string }>> = {
  assenza: [
    { code: "R",   label: "Riposo" },
    { code: "ASS", label: "Assenza" },
    { code: "MA3", label: "Malattia primi 3 giorni" },
    { code: "MA",  label: "Malattia giorni successivi" },
    { code: "I",   label: "Infortunio" },
    { code: "PAD", label: "Permesso 104" },
  ],
  presenza: [
    { code: "STRA", label: "Straordinario" },
    { code: "D1",   label: "Disposizione mattinale" },
    { code: "D2",   label: "Disposizione pomeridiana" },
    { code: "DISP", label: "Disposizione" },
    { code: "DAM1", label: "Controllerie mattinali" },
    { code: "DAM2", label: "Controllerie pomeridiane" },
  ],
};

export const VOCE_CODES: Record<CategoriaVoce, Set<string>> = {
  assenza: new Set(VOCI_CATALOG.assenza.map((v) => v.code)),
  presenza: new Set(VOCI_CATALOG.presenza.map((v) => v.code)),
};

/** I codici che dicono qualcosa sulla salute della persona. */
export const CODICI_SANITARI = new Set(["MA3", "MA", "I", "PAD"]);
export const ASSENZA_GENERICA = "ASS";

/** La voce come la vede chi la legge: i codici sanitari diventano ASS. */
export function mascheraVoce<T extends { category: string; code: string }>(v: T, vede: boolean): T {
  if (vede || v.category !== "assenza" || !CODICI_SANITARI.has(v.code)) return v;
  return { ...v, code: ASSENZA_GENERICA };
}

/** Il catalogo per chi lo chiede: senza permesso, niente codici sanitari. */
export function catalogoPer(vede: boolean): typeof VOCI_CATALOG {
  if (vede) return VOCI_CATALOG;
  return { ...VOCI_CATALOG, assenza: VOCI_CATALOG.assenza.filter(v => !CODICI_SANITARI.has(v.code)) };
}

/** Si può scrivere questa voce? I codici sanitari solo a chi li vede. */
export function esitoScrittura(category: unknown, code: unknown, vede: boolean): "ok" | "non-valido" | "riservato" {
  if (category !== "assenza" && category !== "presenza") return "non-valido";
  if (!VOCE_CODES[category].has(String(code))) return "non-valido";
  if (category === "assenza" && CODICI_SANITARI.has(String(code)) && !vede) return "riservato";
  return "ok";
}
