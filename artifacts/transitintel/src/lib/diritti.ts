/* I diritti dell'utente nella web: area per area, lettura o scrittura.
 *
 * Li calcola l'API (ruoli aziendali, accesso di prima, capacità: il pacchetto
 * @workspace/permessi) e li manda con l'utente. Qui servono solo a decidere
 * che cosa mostrare: chi può davvero fare una cosa lo decide sempre l'API.
 *
 * L'utente tenuto in cache dal browser può essere di prima dei ruoli, senza
 * `diritti`: finché /me non risponde si ricavano dai suoi interruttori, che
 * allora volevano dire «può tutto» sul modulo. */
import {
  AREE, INTERRUTTORI_DI_PRIMA, NESSUN_DIRITTO, dirittiDi, puo,
  type Area, type Diritti, type Interruttore, type InterruttoreDiPrima, type Livello,
} from "@workspace/permessi";

export type { Area, Diritti, Livello };

export interface UtenteConDiritti {
  role?: string;
  diritti?: Partial<Record<string, unknown>> | null;
  permissions?: Partial<Record<Interruttore, unknown>> | null;
}

const LIVELLI = new Set<unknown>(["L", "S"]);

/** I diritti di un utente come arriva dall'API o dalla cache del browser. */
export function dirittiDellUtente(u: UtenteConDiritti | null | undefined): Diritti {
  if (!u) return NESSUN_DIRITTO;
  const admin = u.role === "admin";
  if (u.diritti && typeof u.diritti === "object") {
    const out = { ...NESSUN_DIRITTO } as Record<Area, Livello | null>;
    for (const a of AREE) out[a] = admin ? "S" : LIVELLI.has(u.diritti[a]) ? (u.diritti[a] as Livello) : null;
    return out;
  }
  /* utente in cache di prima dei ruoli: gli interruttori accesi come accesso di prima */
  const p = u.permissions ?? {};
  const accessoDiPrima = Object.fromEntries(INTERRUTTORI_DI_PRIMA.filter(i => p[i] === true).map(i => [i, true])) as Partial<Record<InterruttoreDiPrima, true>>;
  return dirittiDi({ admin, ruoli: [], accessoDiPrima, analisi: p.analytics === true, datiSanitari: false });
}

/** Ha almeno questo livello su una delle aree? Senza aree: sì (la pagina è di tutti). */
export function puoSuUnaDi(d: Diritti, aree: readonly Area[] | undefined, livello: Livello): boolean {
  if (!aree || aree.length === 0) return true;
  return aree.some(a => puo(d, a, livello));
}
