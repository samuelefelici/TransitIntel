/**
 * Le regole delle voci del roster, come le manda il tabellone (tappa 5.5: il
 * catalogo sta nella tabella roster_voci, e ogni voce porta le sue regole).
 * Senza i campi (un'API di prima, durante un rilascio) valgono quelle di prima:
 * il riposo R non libera il turno, D1 e D2 dicono «a disposizione».
 */
export interface VoceConRegole { category: string; code: string; liberaTurno?: boolean; aDisposizione?: boolean }

/** Il conducente manca: il suo turno torna «da coprire». */
export const liberaTurno = (e: VoceConRegole) => e.category === "assenza" && (e.liberaTurno ?? e.code !== "R");
/** Un'assenza che non libera il turno: il riposo, o una voce del catalogo che funziona come il riposo. */
export const aRiposo = (e: VoceConRegole) => e.category === "assenza" && !liberaTurno(e);
/** Una presenza «a disposizione». */
export const aDisposizione = (e: VoceConRegole) => e.category === "presenza" && (e.aDisposizione ?? (e.code === "D1" || e.code === "D2"));

/* ── La pagina dell'amministratore (GET /api/admin/voci-roster) ─────────── */

export interface VoceDelCatalogo {
  codice: string;
  categoria: "assenza" | "presenza";
  nome: string;
  sanitaria: boolean;
  liberaTurno: boolean;
  aDisposizione: boolean;
  codicePaghe: string | null;
  attiva: boolean;
  ordine: number;
  diSistema: boolean;
  /** quante voci del roster la usano */
  voci: number;
  /** le rotazioni dei riposi che la usano */
  rotazioni: string[];
}

/** Un codice nuovo, come lo vuole l'API: maiuscole e cifre, al più 8. */
export const CODICE_NUOVO = /^[A-Z0-9]{1,8}$/;
/** Il codice per le paghe: lettere, cifre, punto, trattino, al più 20. */
export const CODICE_PAGHE = /^[A-Za-z0-9._-]{1,20}$/;

/** Le regole della voce, in parole. */
export function regoleDi(v: Pick<VoceDelCatalogo, "categoria" | "sanitaria" | "liberaTurno" | "aDisposizione">): string[] {
  const r: string[] = [];
  if (v.categoria === "assenza") r.push(v.liberaTurno ? "libera il turno" : "come il riposo: non libera il turno");
  if (v.sanitaria) r.push("dato sanitario");
  if (v.aDisposizione) r.push("a disposizione");
  return r;
}

/** Quanto è usata: per dire se si cancella o si spegne. */
export function usoDi(v: Pick<VoceDelCatalogo, "voci" | "rotazioni">): string {
  const p: string[] = [];
  if (v.voci) p.push(`${v.voci.toLocaleString("it-IT")} ${v.voci === 1 ? "voce" : "voci"} nel roster`);
  if (v.rotazioni.length) p.push(`${v.rotazioni.length === 1 ? "rotazione" : "rotazioni"}: ${v.rotazioni.join(", ")}`);
  return p.length ? p.join(" · ") : "mai usata";
}

export const siCancella = (v: Pick<VoceDelCatalogo, "voci" | "rotazioni" | "diSistema">) => !v.diSistema && v.voci === 0 && v.rotazioni.length === 0;
