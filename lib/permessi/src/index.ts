/**
 * ═══════════════════════════════════════════════════════════════════════════
 * I PERMESSI DI CERBERO: ruoli aziendali, aree, lettura e scrittura
 * ───────────────────────────────────────────────────────────────────────────
 * Un utente ha uno o più RUOLI AZIENDALI. Ogni ruolo dà, per ogni AREA del
 * menu, lettura (L), scrittura (S) o niente. Con più ruoli vale il diritto
 * più alto. È l'unica definizione: la leggono il controllo delle rotte
 * dell'API e il menu della web.
 *
 * Oltre ai ruoli ci sono:
 *   - l'ACCESSO DI PRIMA: gli interruttori per modulo che c'erano prima dei
 *     ruoli. Finché restano accesi valgono come scrittura sulla loro area,
 *     così il giorno del rilascio nessuno cambia accesso. L'amministratore
 *     li spegne quando ha assegnato i ruoli;
 *   - due capacità date utente per utente, fuori dai ruoli: i DATI SANITARI
 *     (i codici di malattia, infortunio e 104 nel roster) e l'ANALISI
 *     (territorio, traffico, domanda: spenta per chi non la chiede);
 *   - l'AMMINISTRATORE DI SISTEMA, che non è un ruolo di lavoro: gestisce
 *     utenti, azienda e integrazioni, e può tutto.
 *
 * Per aggiungere o cambiare un ruolo si cambia MATRICE qui sotto (e il
 * vincolo sulla colonna users.ruoli, con una migrazione).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/* ── Aree ─────────────────────────────────────────────────────────────────── */

export const AREE = [
  "rete", "turni", "pubblicazione_orari", "pubblicazione_turni", "personale",
  "roster", "esercizio", "consuntivo", "flotta", "tariffe", "analisi",
] as const;
export type Area = typeof AREE[number];

export const NOMI_AREE: Readonly<Record<Area, string>> = {
  rete: "Rete e orari",
  turni: "Turni",
  pubblicazione_orari: "Pubblicazione degli orari",
  pubblicazione_turni: "Pubblicazione dei turni",
  personale: "Personale (dati personali)",
  roster: "Roster",
  esercizio: "Esercizio",
  consuntivo: "Consuntivo",
  flotta: "Flotta",
  tariffe: "Tariffe",
  analisi: "Analisi",
};

/** Che cosa c'è dentro ogni area, per chi assegna i ruoli. */
export const DESCRIZIONI_AREE: Readonly<Record<Area, string>> = {
  rete: "Planning Studio, confronto fra programmi, zone di coincidenza, depositi e fuorilinea",
  turni: "Progetti di esercizio: turni macchina, turni guida, calcoli",
  pubblicazione_orari: "Stampa orari, quadri di palina, mappa orari e di rete",
  pubblicazione_turni: "Quali turni guida vanno al roster, per periodo",
  personale: "Anagrafica completa: contatti, residenza, paghe, ferie, visite",
  roster: "Tabellone, assegnazioni, assenze; dell'anagrafica solo i dati operativi",
  esercizio: "Mappa live, AVM, tempi osservati",
  consuntivo: "Giornate, esiti per corsa, km (non c'è ancora)",
  flotta: "FleetCare: mezzi, fermi, officina (il ruolo dentro FleetCare si sceglie a parte)",
  tariffe: "Tariffe, polimetriche, simulatore",
  analisi: "Territorio, traffico, domanda, dati GTFS",
};

/** L = lettura, S = scrittura (che comprende la lettura). */
export type Livello = "L" | "S";
export type Diritti = Readonly<Record<Area, Livello | null>>;

const PESO: Readonly<Record<Livello, number>> = { L: 1, S: 2 };

/** Il più alto fra due livelli. */
export function piuAlto(a: Livello | null | undefined, b: Livello | null | undefined): Livello | null {
  const pa = a ? PESO[a] : 0, pb = b ? PESO[b] : 0;
  return pa >= pb ? (a ?? null) : (b ?? null);
}

/* ── Ruoli aziendali ──────────────────────────────────────────────────────── */

export const RUOLI = [
  "pianificatore", "ufficio_turni", "capo_deposito", "centrale_operativa", "officina", "amministrazione",
] as const;
export type RuoloAziendale = typeof RUOLI[number];

export const NOMI_RUOLI: Readonly<Record<RuoloAziendale, string>> = {
  pianificatore: "Pianificatore",
  ufficio_turni: "Ufficio turni",
  capo_deposito: "Capo deposito",
  centrale_operativa: "Centrale operativa",
  officina: "Officina",
  amministrazione: "Amministrazione",
};

export const DESCRIZIONI_RUOLI: Readonly<Record<RuoloAziendale, string>> = {
  pianificatore: "Disegna la rete e gli orari e li pubblica; legge turni, esercizio e tariffe",
  ufficio_turni: "Costruisce i turni macchina e guida e li manda al roster; legge la rete e il tabellone",
  capo_deposito: "Tiene il tabellone del personale; legge il resto",
  centrale_operativa: "Segue il servizio del giorno; legge rete, turni e tabellone",
  officina: "Lavora in FleetCare; in Cerbero legge lo stato del parco",
  amministrazione: "Tiene l'anagrafica del personale e le tariffe; legge il resto",
};

/**
 * La matrice (analisi di ottobre 2026, § 3.5). Dove l'analisi mette una
 * condizione che il codice non sa ancora far valere, vale il livello pieno
 * e la condizione è scritta accanto:
 *
 *   capo_deposito.roster      «scrittura, sul suo deposito»: oggi il tabellone
 *                             non ha il filtro per deposito, quindi su tutti.
 *   capo_deposito.personale   «lettura dei soli dati operativi»: i dati
 *                             operativi dell'anagrafica vengono con il roster;
 *                             sui dati personali non ha niente.
 *   officina.esercizio        «lettura dello stato del parco»: oggi tutta l'area.
 *   centrale.consuntivo       «scrittura degli esiti, non la chiusura» e
 *   amministrazione.consuntivo «chiusura di giornata e mese»: il consuntivo
 *                             non c'è ancora; la chiusura sarà una capacità a parte.
 *   flotta                    apre FleetCare; che cosa si può fare lì dentro lo
 *                             dice il ruolo FleetCare dell'utente.
 */
export const MATRICE: Readonly<Record<RuoloAziendale, Readonly<Partial<Record<Area, Livello>>>>> = {
  pianificatore: {
    rete: "S", turni: "L", pubblicazione_orari: "S", pubblicazione_turni: "L",
    esercizio: "L", consuntivo: "L", tariffe: "L",
  },
  ufficio_turni: {
    rete: "L", turni: "S", pubblicazione_orari: "L", pubblicazione_turni: "S",
    roster: "L", esercizio: "L", consuntivo: "L",
  },
  capo_deposito: {
    rete: "L", turni: "L", pubblicazione_orari: "L", pubblicazione_turni: "L",
    roster: "S", esercizio: "L", consuntivo: "L", flotta: "L",
  },
  centrale_operativa: {
    rete: "L", turni: "L", pubblicazione_orari: "L", pubblicazione_turni: "L",
    roster: "L", esercizio: "S", consuntivo: "S", flotta: "L",
  },
  officina: {
    esercizio: "L", flotta: "S",
  },
  amministrazione: {
    rete: "L", turni: "L", pubblicazione_orari: "L", pubblicazione_turni: "L",
    personale: "S", roster: "L", esercizio: "L", consuntivo: "S", flotta: "L", tariffe: "S",
  },
};

/** Il ruolo dentro FleetCare che di solito va con un ruolo aziendale: un suggerimento, non una regola. */
export const RUOLO_FLEETCARE_SUGGERITO: Readonly<Partial<Record<RuoloAziendale, string>>> = {
  capo_deposito: "driver",
  centrale_operativa: "driver",
  officina: "workshop_manager",
  amministrazione: "admin_finance",
};

/* ── L'accesso di prima: gli interruttori per modulo ──────────────────────── */

/** Gli interruttori di prima dei ruoli. Restano i nomi con cui FleetCare e il
 *  registro leggono la colonna users.permissions. */
export const INTERRUTTORI = ["analytics", "fares", "scheduling", "network", "fleetcare", "centrale", "personale", "roster"] as const;
export type Interruttore = typeof INTERRUTTORI[number];

/** Le aree che ogni interruttore apriva. */
export const AREE_DELL_INTERRUTTORE: Readonly<Record<Interruttore, readonly Area[]>> = {
  network: ["rete", "pubblicazione_orari"],
  scheduling: ["turni", "pubblicazione_turni"],
  roster: ["roster"],
  personale: ["personale"],
  centrale: ["esercizio"],
  fares: ["tariffe"],
  fleetcare: ["flotta"],
  analytics: ["analisi"],
};

/** Gli interruttori che possono restare accesi come accesso di prima. L'Analisi
 *  non è fra questi: è diventata una capacità dell'utente. */
export const INTERRUTTORI_DI_PRIMA = INTERRUTTORI.filter((i): i is Exclude<Interruttore, "analytics"> => i !== "analytics");
export type InterruttoreDiPrima = typeof INTERRUTTORI_DI_PRIMA[number];
export type AccessoDiPrima = Readonly<Partial<Record<InterruttoreDiPrima, boolean>>>;

/* ── Il profilo di un utente e i suoi diritti ─────────────────────────────── */

export interface ProfiloPermessi {
  /** amministratore di sistema: può tutto */
  admin: boolean;
  ruoli: readonly RuoloAziendale[];
  accessoDiPrima: AccessoDiPrima;
  analisi: boolean;
  datiSanitari: boolean;
}

export const NESSUN_DIRITTO: Diritti = Object.freeze(Object.fromEntries(AREE.map(a => [a, null])) as Record<Area, Livello | null>);

/** I diritti per area: il più alto fra ruoli, accesso di prima e Analisi. */
export function dirittiDi(p: ProfiloPermessi): Diritti {
  const out = { ...NESSUN_DIRITTO } as Record<Area, Livello | null>;
  if (p.admin) {
    for (const a of AREE) out[a] = "S";
    return out;
  }
  for (const r of p.ruoli) {
    const riga = MATRICE[r];
    if (!riga) continue;
    for (const a of AREE) out[a] = piuAlto(out[a], riga[a]);
  }
  for (const i of INTERRUTTORI_DI_PRIMA) {
    if (p.accessoDiPrima[i] !== true) continue;
    for (const a of AREE_DELL_INTERRUTTORE[i]) out[a] = "S";
  }
  if (p.analisi) out.analisi = "S";
  return out;
}

/** Ha almeno questo livello sull'area? */
export function puo(d: Diritti, area: Area, livello: Livello): boolean {
  const ha = d[area];
  return !!ha && PESO[ha] >= PESO[livello];
}

/** Ha almeno questo livello su una delle aree? */
export function puoSuUna(d: Diritti, aree: readonly Area[], livello: Livello): boolean {
  return aree.some(a => puo(d, a, livello));
}

/** I codici sanitari del roster: la capacità, e mai senza poter aprire il roster. */
export function vedeDatiSanitari(p: ProfiloPermessi): boolean {
  if (p.admin) return true;
  return p.datiSanitari && puo(dirittiDi(p), "roster", "L");
}

/**
 * La colonna users.permissions com'è letta fuori da Cerbero (FleetCare, la
 * regola della verifica in due passaggi): un interruttore è acceso se l'utente
 * ha almeno la lettura su una delle sue aree.
 */
export function interruttoriCompatibili(d: Diritti): Record<Interruttore, boolean> {
  const out = {} as Record<Interruttore, boolean>;
  for (const i of INTERRUTTORI) out[i] = puoSuUna(d, AREE_DELL_INTERRUTTORE[i], "L");
  return out;
}

/* ── Pulizia di quello che arriva da fuori ────────────────────────────────── */

const SONO_RUOLI = new Set<string>(RUOLI);

/** I ruoli validi di un elenco qualunque: senza doppioni, nell'ordine di RUOLI. */
export function ruoliValidi(input: unknown): RuoloAziendale[] {
  if (!Array.isArray(input)) return [];
  const chiesti = new Set(input.filter((r): r is string => typeof r === "string" && SONO_RUOLI.has(r)));
  return RUOLI.filter(r => chiesti.has(r));
}

/** I nomi che in un elenco non sono ruoli (per dire all'amministratore quale è sbagliato). */
export function ruoliSconosciuti(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(r => (typeof r === "string" ? r : JSON.stringify(r))).filter(r => !SONO_RUOLI.has(r)))];
}

/** L'accesso di prima come si salva: solo gli interruttori accesi, solo `true`. */
export function accessoDiPrimaPulito(input: unknown): Partial<Record<InterruttoreDiPrima, true>> {
  const dato = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const out: Partial<Record<InterruttoreDiPrima, true>> = {};
  for (const i of INTERRUTTORI_DI_PRIMA) if (dato[i] === true) out[i] = true;
  return out;
}

/**
 * L'accesso di prima si può solo togliere: quello nuovo tiene gli interruttori
 * che erano accesi e che la richiesta non spegne. Non se ne accendono di nuovi,
 * perché i diritti nuovi si danno con i ruoli.
 */
export function accessoDiPrimaRidotto(attuale: AccessoDiPrima, richiesto: unknown): Partial<Record<InterruttoreDiPrima, true>> {
  const chiesto = accessoDiPrimaPulito(richiesto);
  const out: Partial<Record<InterruttoreDiPrima, true>> = {};
  for (const i of INTERRUTTORI_DI_PRIMA) if (attuale[i] === true && chiesto[i] === true) out[i] = true;
  return out;
}

/** C'è ancora qualche interruttore di prima acceso? */
export function haAccessoDiPrima(a: AccessoDiPrima): boolean {
  return INTERRUTTORI_DI_PRIMA.some(i => a[i] === true);
}

/* ── Letture e scritture ──────────────────────────────────────────────────── */

/** Il livello che serve per un metodo HTTP: leggere per GET e HEAD, scrivere per il resto. */
export function livelloDelMetodo(metodo: string): Livello {
  const m = metodo.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "L" : "S";
}

/* ── I depositi di una persona (PR 2.14c) ─────────────────────────────────── */

/**
 * La scrittura sul roster si può limitare ai conducenti di alcuni depositi: è
 * il caso del Capo deposito. Si scelgono utente per utente; **nessun deposito
 * scelto vuol dire nessun limite**, come prima che il limite esistesse.
 * Riguarda solo la scrittura sul roster: non quello che si legge, e non la
 * scrittura sui dati del personale.
 */
export const MAX_DEPOSITI_PER_UTENTE = 50;

/** I codici di deposito scritti bene: testo corto, senza doppi, al più MAX_DEPOSITI_PER_UTENTE. */
export function depositiPuliti(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const c = v.trim();
    if (!c || c.length > 60 || out.includes(c)) continue;
    out.push(c);
    if (out.length >= MAX_DEPOSITI_PER_UTENTE) break;
  }
  return out;
}

/** I depositi su cui una persona scrive il roster; `null` = tutti (l'amministratore, o chi non ha limiti). */
export function limiteDepositi(p: { admin: boolean; depositi?: readonly string[] | null }): readonly string[] | null {
  if (p.admin) return null;
  const d = depositiPuliti(p.depositi ?? []);
  return d.length ? d : null;
}

/**
 * Con quel limite, si scrive sul roster di un conducente di quel deposito?
 * Un conducente senza deposito lo scrive solo chi non ha limiti: altrimenti
 * basterebbe togliere il deposito a un conducente per renderlo di tutti.
 */
export function scriveSulDeposito(limite: readonly string[] | null, codice: string | null | undefined): boolean {
  if (limite === null) return true;
  return !!codice && limite.includes(codice);
}
