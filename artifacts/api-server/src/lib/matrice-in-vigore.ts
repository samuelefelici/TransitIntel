/**
 * La matrice dei ruoli in vigore, in memoria (PR 2.18).
 *
 * Chi calcola i diritti di un utente (lib/permessi.ts) la legge da qui, senza
 * aspettare e senza toccare il database. La tiene aggiornata
 * lib/matrice-ruoli.ts, che la legge da public.ruoli_diritti prima di caricare
 * qualunque utente. Finché nessuno l'ha letta vale quella di partenza: è il
 * caso dei test e degli script, mai di una richiesta (il caricamento
 * dell'utente si ferma se la matrice non si legge).
 *
 * Sta in un file suo, senza database, perché lib/permessi.ts resti fatto di
 * funzioni pure.
 */
import { MATRICE, type Matrice } from "@workspace/permessi";

let inVigore: Matrice = MATRICE;

export function matriceInVigore(): Matrice { return inVigore; }

/** Solo per lib/matrice-ruoli.ts (e per i test, che la rimettono a posto). */
export function mettiInVigore(m: Matrice): void { inVigore = m; }
