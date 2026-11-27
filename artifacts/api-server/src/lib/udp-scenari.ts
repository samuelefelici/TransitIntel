/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GLI SCENARI DI UN'UDP — vederli tutti ed eliminarli in blocco: le regole
 * ───────────────────────────────────────────────────────────────────────────
 * Ogni giro dello scheduler lascia nella Fucina un turni macchina e i suoi
 * turni guida, dentro il progetto di esercizio dell'UDP. Dopo decine di giri
 * restano scenari vecchi, fatti su corse che non ci sono più.
 *
 *   · L'ANTEPRIMA elenca i turni macchina e i turni guida dell'UDP, chi è
 *     bloccato e perché, e quante relazioni se ne andrebbero.
 *   · L'ELIMINAZIONE prende gli id dell'anteprima, mai «tutto quello che
 *     c'è»: uno scenario nato dopo l'anteprima resta. Un turni macchina si
 *     porta via i suoi turni guida, quindi vanno elencati anche loro: se ne
 *     manca uno (nato dopo) non si cancella niente.
 *   · Tutto o niente: se uno scenario è bloccato non si cancella nulla.
 *     Bloccati: IN ESERCIZIO (la soluzione ufficiale del Quadro d'esercizio),
 *     nel ROSTER (assegnati o pubblicati, anche nel passato), nelle GIORNATE
 *     DI ESERCIZIO (il programmato li usa). Lo storico resta leggibile.
 *   · Il progetto di esercizio resta, vuoto: il prossimo giro lo riusa. Lo
 *     storico dei giri dello scheduler resta.
 *
 * Funzioni pure: lettura, scrittura e rotte stanno in udp-scenari-db.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const MAX_ID_PER_RICHIESTA = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Blocco = "in_esercizio" | "roster" | "giornate_esercizio";

export const TESTO_BLOCCO: Record<Blocco, string> = {
  in_esercizio: "in esercizio: è la soluzione ufficiale del Quadro d'esercizio (togli prima lo stato operativo)",
  roster: "usato dal roster (turni assegnati o pubblicati, anche passati)",
  giornate_esercizio: "usato nelle giornate di esercizio (il programmato lo legge)",
};

export interface TurniMacchina {
  id: string;
  nome: string;
  data: string | null;
  creato: string | null;
  progettoId: string;
  inEsercizio: boolean;
  vetture: number | null;
}

export interface TurniGuida {
  id: string;
  nome: string;
  /** il turni macchina da cui viene (null: un misto agganciato al solo progetto) */
  turniMacchinaId: string | null;
  creato: string | null;
  progettoId: string | null;
  inEsercizio: boolean;
  turni: number | null;
}

/** Gli usi esterni di ogni scenario, per id: chi li ha non si cancella. */
export interface Usi {
  roster: Set<string>;
  giornateEsercizio: Set<string>;
}

export const usiVuoti = (): Usi => ({ roster: new Set(), giornateEsercizio: new Set() });

/** Perché uno scenario non si può eliminare (vuoto: si può). */
export function blocchiDi(s: { id: string; inEsercizio: boolean }, usi: Usi): Blocco[] {
  const out: Blocco[] = [];
  if (s.inEsercizio) out.push("in_esercizio");
  if (usi.roster.has(s.id)) out.push("roster");
  if (usi.giornateEsercizio.has(s.id)) out.push("giornate_esercizio");
  return out;
}

/**
 * Il corpo della richiesta di eliminazione: due elenchi di id, senza doppi.
 * Fail closed: un id che non è un uuid, un elenco che non è un elenco, troppi
 * id o nessuno → errore, e non si legge oltre.
 */
export function leggiRichiesta(body: unknown):
  { ok: true; turniMacchina: string[]; turniGuida: string[] } | { ok: false; errore: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const elenco = (x: unknown, nome: string): string[] | string => {
    if (x === undefined || x === null) return [];
    if (!Array.isArray(x)) return `${nome} deve essere un elenco di id`;
    const ids = x.map(v => String(v ?? "").trim().toLowerCase());
    const brutto = ids.find(v => !UUID.test(v));
    if (brutto !== undefined) return `${nome}: id non valido «${brutto.slice(0, 40)}»`;
    return [...new Set(ids)];
  };
  const tm = elenco(b.turniMacchina, "turniMacchina");
  if (typeof tm === "string") return { ok: false, errore: tm };
  const tg = elenco(b.turniGuida, "turniGuida");
  if (typeof tg === "string") return { ok: false, errore: tg };
  if (tm.length + tg.length === 0) return { ok: false, errore: "nessuno scenario indicato: passa gli id dell'anteprima" };
  if (tm.length + tg.length > MAX_ID_PER_RICHIESTA) {
    return { ok: false, errore: `al massimo ${MAX_ID_PER_RICHIESTA} scenari per richiesta` };
  }
  return { ok: true, turniMacchina: tm, turniGuida: tg };
}

export type EsitoSelezione =
  | { ok: true; turniMacchina: string[]; turniGuida: string[] }
  | { ok: false; stato: 400 | 409; errore: string; ids: string[] };

/**
 * La selezione da eliminare, confrontata con quello che l'UDP ha davvero:
 *  · un id che non è dell'UDP → 400 (non si cancella niente fuori dall'UDP);
 *  · un turni guida di un turni macchina scelto, che non è in elenco → 409
 *    (è nato dopo l'anteprima, o l'anteprima era parziale: la si rifà);
 *  · uno scenario bloccato → 409, con il motivo.
 */
export function controllaSelezione(
  richiesta: { turniMacchina: string[]; turniGuida: string[] },
  tm: TurniMacchina[], tg: TurniGuida[], usi: Usi,
): EsitoSelezione {
  const tmDi = new Map(tm.map(s => [s.id, s]));
  const tgDi = new Map(tg.map(s => [s.id, s]));
  const estranei = [
    ...richiesta.turniMacchina.filter(id => !tmDi.has(id)),
    ...richiesta.turniGuida.filter(id => !tgDi.has(id)),
  ];
  if (estranei.length) {
    return { ok: false, stato: 400, errore: `${estranei.length} scenari non sono di questa UDP: non si cancella niente`, ids: estranei };
  }
  const scelti = new Set(richiesta.turniMacchina);
  const guida = new Set(richiesta.turniGuida);
  const figliFuori = tg.filter(g => g.turniMacchinaId && scelti.has(g.turniMacchinaId) && !guida.has(g.id)).map(g => g.id);
  if (figliFuori.length) {
    return {
      ok: false, stato: 409, ids: figliFuori,
      errore: `${figliFuori.length} turni guida dei turni macchina scelti non sono in elenco (nati dopo l'anteprima?): rifai l'anteprima`,
    };
  }
  const bloccati: string[] = [];
  const motivi = new Set<Blocco>();
  for (const s of [...richiesta.turniMacchina.map(id => tmDi.get(id)!), ...richiesta.turniGuida.map(id => tgDi.get(id)!)]) {
    const b = blocchiDi(s, usi);
    if (b.length) { bloccati.push(s.id); b.forEach(x => motivi.add(x)); }
  }
  if (bloccati.length) {
    return {
      ok: false, stato: 409, ids: bloccati,
      errore: `${bloccati.length} scenari non si possono eliminare (${[...motivi].map(m => TESTO_BLOCCO[m]).join("; ")}): non si cancella niente`,
    };
  }
  return { ok: true, turniMacchina: [...scelti], turniGuida: [...guida] };
}

export interface Anteprima {
  turniMacchina: (TurniMacchina & { turniGuida: number; blocchi: Blocco[] })[];
  turniGuida: (TurniGuida & { blocchi: Blocco[] })[];
  eliminabili: { turniMacchina: string[]; turniGuida: string[] };
  bloccati: number;
}

/**
 * Ciò che l'anteprima propone di eliminare: i turni guida senza blocchi, e un
 * turni macchina senza blocchi solo se lo sono anche tutti i suoi turni guida
 * (se ne resta uno bloccato, il padre resta con lui).
 */
export function anteprima(tm: TurniMacchina[], tg: TurniGuida[], usi: Usi): Anteprima {
  const righeTg = tg.map(g => ({ ...g, blocchi: blocchiDi(g, usi) }));
  const figli = new Map<string, typeof righeTg>();
  for (const g of righeTg) if (g.turniMacchinaId) figli.set(g.turniMacchinaId, [...(figli.get(g.turniMacchinaId) ?? []), g]);
  const righeTm = tm.map(s => ({ ...s, turniGuida: figli.get(s.id)?.length ?? 0, blocchi: blocchiDi(s, usi) }));
  const tmOk = righeTm.filter(s => s.blocchi.length === 0 && (figli.get(s.id) ?? []).every(g => g.blocchi.length === 0));
  // un turni guida senza blocchi si elimina anche da solo: il padre bloccato resta
  const tgOk = righeTg.filter(g => g.blocchi.length === 0);
  const bloccati = righeTm.filter(s => s.blocchi.length).length + righeTg.filter(g => g.blocchi.length).length;
  return {
    turniMacchina: righeTm,
    turniGuida: righeTg,
    eliminabili: { turniMacchina: tmOk.map(s => s.id), turniGuida: tgOk.map(g => g.id) },
    bloccati,
  };
}
