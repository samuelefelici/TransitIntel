/**
 * Anagrafica del personale — tipi e funzioni pure lato pagina.
 * Speculare a api-server/src/lib/anagrafica-campi.ts: i nomi dei campi sono
 * quelli dell'API. Chi non ha il permesso «Personale» riceve i conducenti
 * senza i campi personali (le chiavi mancano proprio, non sono null).
 */

export type EsitoVisita = "idoneo" | "idoneo_prescrizioni" | "temp_non_idoneo" | "non_idoneo";
export type UnitaFerie = "giorni" | "ore";

export interface Conducente {
  id: string;
  name: string;
  badge: string | null;
  isFictitious: boolean;
  isActive: boolean;
  versione: number;
  updatedAt: string | null;
  matricola: string | null;
  cognome: string | null;
  nome: string | null;
  residenzaServizio: string | null;
  categoria: string | null;
  orarioSettimanaleMin: number | null;
  rotazioneRiposi: {
    id: string; nome: string; settimane: number; scaglione: number;
    settimanaCorrente: Array<string | null> | null;
  } | null;
  rotazioniRiposi: number;
  scaglioneFerie: string | null;
  rotazioneTurni: { gruppoId: string; gruppo: string; posizione: number | null } | null;
  abilitazioni: string[];
  photoUrl: string | null;
  patente: string | null;
  patenteValidita: string | null;
  cqcValidita: string | null;
  visitaFerrovieValidita: string | null;
  visitaMedicoCompetenteValidita: string | null;
  visitaFerrovieEsito: EsitoVisita | null;
  visitaMedicoCompetenteEsito: EsitoVisita | null;
  cellulare: string | null;
  dataFineServizio: string | null;
  /* solo con il permesso «Personale» */
  cf?: string | null;
  dataNascita?: string | null;
  dataAssunzione?: string | null;
  residenzaAnagrafica?: string | null;
  telefono?: string | null;
  inquadramento?: string | null;
  parametro?: number | null;
  ferieAnnue?: number | null;
  ferieResidue?: number | null;
  ferieResidueAl?: string | null;
  ferieUnita?: UnitaFerie;
  patenteNumero?: string | null;
  cqcNumero?: string | null;
  visitaFerrovieData?: string | null;
  visitaMedicoCompetenteData?: string | null;
  note?: string | null;
}

export interface Deposito {
  codice: string;
  nome: string;
  gruppo: "A" | "B";
  cadenzaTurni: "settimanale" | "semimensile";
  alias: string[];
  ordine: number;
}
export interface Categoria { codice: string; nome: string; alias: string[] }
export interface GruppoTurni { id: string; depositoCodice: string; nome: string; dataRiferimento: string | null; conducenti: number }
export interface Rotazione { id: string; name: string; weeks: number; pattern: Array<Array<string | null>> }

export interface RigaStorico {
  id: string; driverId: string; kind: string; value: string | null;
  eventDate: string | null; expiryDate: string | null; note: string | null; createdAt: string;
}

/** La risposta di una scrittura sulla scheda. */
export interface EsitoScrittura {
  conducente: Conducente | null;
  avvisi: string[];
  daRigenerare: string[];
}

export const PARAMETRI = [140, 158, 175, 183] as const;

export const ETICHETTE_ESITO: Record<EsitoVisita, string> = {
  idoneo: "Idoneo",
  idoneo_prescrizioni: "Idoneo con prescrizioni",
  temp_non_idoneo: "Temporaneamente non idoneo",
  non_idoneo: "Non idoneo",
};

export const ETICHETTE_STORICO: Record<string, string> = {
  deposito: "Deposito",
  categoria: "Categoria",
  orario_lavoro: "Orario settimanale",
  visita_ferrovie: "Visita ferrovie",
  visita_medico_competente: "Visita medico competente",
  patente: "Patente",
  cqc: "CQC",
};

export const GIORNI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

/* ── Orario ── */

export function formattaOrario(min: number | null | undefined): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return "";
  const h = Math.floor(min / 60);
  return `${h}:${String(Math.round(min - h * 60)).padStart(2, "0")}`;
}

/** «38:30», «38», «38,5» → minuti; null se vuoto; NaN se illeggibile. */
export function leggiOrarioInput(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  let m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (m) return +m[1] * 60 + +m[2];
  m = /^(\d{1,2})(?:\.(\d+))?$/.exec(t);
  if (m) return Math.round(Number(t) * 60);
  return NaN;
}

/* ── Date ── */

export const ddmmyyyy = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");

export function oggiRoma(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date());
}

/* ── Scadenziario (gemello di anagrafica-campi.ts) ── */

export type StatoScadenza = "non_idoneo" | "scaduta" | "entro_30" | "entro_60" | "entro_90" | "ok" | "mancante";
export const ORDINE_STATI: StatoScadenza[] = ["non_idoneo", "scaduta", "entro_30", "entro_60", "entro_90", "mancante", "ok"];
export const STATI: Record<StatoScadenza, { testo: string; colore: string; fondo: string }> = {
  non_idoneo: { testo: "Non idoneo", colore: "#fca5a5", fondo: "rgba(239,68,68,0.18)" },
  scaduta: { testo: "Scaduta", colore: "#f87171", fondo: "rgba(248,113,113,0.14)" },
  entro_30: { testo: "Entro 30 giorni", colore: "#fb923c", fondo: "rgba(251,146,60,0.14)" },
  entro_60: { testo: "Entro 60 giorni", colore: "#fbbf24", fondo: "rgba(251,191,36,0.12)" },
  entro_90: { testo: "Entro 90 giorni", colore: "#7dd3fc", fondo: "rgba(125,211,252,0.10)" },
  mancante: { testo: "Manca la data", colore: "#a1a1aa", fondo: "rgba(161,161,170,0.10)" },
  ok: { testo: "In regola", colore: "#34d399", fondo: "rgba(52,211,153,0.10)" },
};

export type Documento = "patente" | "cqc" | "visita_ferrovie" | "visita_medico_competente";
export const DOCUMENTI: Record<Documento, string> = {
  patente: "Patente",
  cqc: "CQC",
  visita_ferrovie: "Visita ferrovie",
  visita_medico_competente: "Visita medico competente",
};

export interface VoceScadenza { documento: Documento; scadenza: string | null; stato: StatoScadenza; giorni: number | null }

function giorniTra(da: string, a: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${da}T00:00:00Z`)) / 86_400_000);
}

export function statoScadenza(scadenza: string | null, oggi: string, esito?: EsitoVisita | null): { stato: StatoScadenza; giorni: number | null } {
  if (esito === "non_idoneo" || esito === "temp_non_idoneo") return { stato: "non_idoneo", giorni: scadenza ? giorniTra(oggi, scadenza) : null };
  if (!scadenza) return { stato: "mancante", giorni: null };
  const g = giorniTra(oggi, scadenza);
  return { stato: g < 0 ? "scaduta" : g <= 30 ? "entro_30" : g <= 60 ? "entro_60" : g <= 90 ? "entro_90" : "ok", giorni: g };
}

export function scadenzeDi(c: Conducente, oggi: string): VoceScadenza[] {
  const voci: Array<[Documento, string | null, EsitoVisita | null]> = [
    ["patente", c.patenteValidita, null],
    ["cqc", c.cqcValidita, null],
    ["visita_ferrovie", c.visitaFerrovieValidita, c.visitaFerrovieEsito],
    ["visita_medico_competente", c.visitaMedicoCompetenteValidita, c.visitaMedicoCompetenteEsito],
  ];
  return voci.map(([documento, scadenza, esito]) => ({ documento, scadenza, ...statoScadenza(scadenza, oggi, esito) }));
}

export function statoPeggiore(voci: VoceScadenza[]): StatoScadenza {
  let p: StatoScadenza = "ok";
  for (const v of voci) if (ORDINE_STATI.indexOf(v.stato) < ORDINE_STATI.indexOf(p)) p = v.stato;
  return p;
}

/* ── Nomi ── */

export const nominativo = (c: Pick<Conducente, "cognome" | "nome" | "name">) =>
  [c.cognome, c.nome].filter(Boolean).join(" ") || c.name;

/** Testo confrontabile, come chiaveTesto lato server. */
export const chiave = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function trovaDeposito(valore: string, catalogo: Deposito[]): Deposito | null {
  const k = chiave(valore);
  const codice = (x: string) => (/^\d+$/.test(chiave(x)) ? chiave(x).replace(/^0+/, "") || "0" : chiave(x));
  return catalogo.find(d => codice(d.nome) === codice(k) || codice(d.codice) === codice(k))
    ?? catalogo.find(d => d.alias.some(a => codice(a) === codice(k))) ?? null;
}

/* ── Import ── */

export interface ColonnaImport { indice: number; intestazione: string; campo: string | null; candidataChiave: boolean }
export interface RigaImport {
  n: number;
  valori: Record<string, unknown>;
  depositoGrezzo?: string;
  categoriaGrezza?: string;
  rotazioneRiposi?: { nome: string; scaglione: number };
  errori: string[];
  avvisi: string[];
}
export interface Statistica { righe: number; min: number; mediana: number; max: number }
export interface AnalisiImport {
  rigaIntestazioni: number;
  colonne: ColonnaImport[];
  righe: RigaImport[];
  depositi: Array<{ valore: string; righe: number }>;
  categorie: Array<{ valore: string; righe: number }>;
  scaglioniFerie: Array<{ valore: string; righe: number }>;
  statistiche: Partial<Record<"ferieAnnue" | "ferieResidue" | "orarioSettimanaleMin", Statistica>>;
  haDataResiduo: boolean;
}
export type StatoRiga = "nuovo" | "aggiorna" | "invariato" | "esclusa" | "errore" | "possibile" | "saltata" | "da_disattivare" | "disattivato";
export interface EsitoRigaImport {
  n: number; matricola: string | null; nominativo: string; stato: StatoRiga; campi: string[]; messaggi: string[];
  simile?: { id: string; nominativo: string; matricola: string | null };
}
export interface RapportoImport {
  conteggi: Record<StatoRiga, number>;
  righe: EsitoRigaImport[];
  daRigenerare: string[];
  applicato: boolean;
}
export const ESCLUDI = "__escludi__";

export const STATI_RIGA: Record<StatoRiga, { testo: string; singolare: string; colore: string }> = {
  nuovo: { testo: "Nuovi", singolare: "Nuovo", colore: "#34d399" },
  aggiorna: { testo: "Da aggiornare", singolare: "Da aggiornare", colore: "#7dd3fc" },
  invariato: { testo: "Invariati", singolare: "Invariato", colore: "#a1a1aa" },
  possibile: { testo: "Da decidere", singolare: "Da decidere", colore: "#fbbf24" },
  da_disattivare: { testo: "Cessati", singolare: "Cessato", colore: "#fb923c" },
  disattivato: { testo: "Messi fuori servizio", singolare: "Fuori servizio", colore: "#fb923c" },
  esclusa: { testo: "Esclusi", singolare: "Escluso", colore: "#71717a" },
  saltata: { testo: "Saltati", singolare: "Saltato", colore: "#71717a" },
  errore: { testo: "Errori", singolare: "Errore", colore: "#f87171" },
};

/** Le etichette dei campi come le mostra la pagina (anche nei rapporti dell'import). */
export const ETICHETTE_CAMPI: Record<string, string> = {
  matricola: "matricola", cognome: "cognome", nome: "nome", badge: "badge", cf: "codice fiscale",
  dataNascita: "data di nascita", dataAssunzione: "data di assunzione", dataFineServizio: "fine servizio",
  residenzaAnagrafica: "residenza", cellulare: "cellulare", telefono: "telefono", inquadramento: "inquadramento",
  parametro: "parametro", ferieAnnue: "ferie annue", ferieResidue: "ferie residue", ferieUnita: "unità ferie",
  scaglioneFerie: "scaglione ferie", patente: "categorie patente", patenteNumero: "numero patente", cqcNumero: "numero CQC",
  note: "note", photoUrl: "foto", abilitazioni: "abilitazioni", deposito: "deposito", categoria: "categoria",
  orarioSettimanaleMin: "orario", patenteValidita: "scadenza patente", cqcValidita: "scadenza CQC",
  visitaFerrovie: "visita ferrovie", visitaMedicoCompetente: "visita medico competente",
  rotazioneRiposi: "rotazione riposi", rotazioneTurni: "rotazione turni",
  residenzaServizio: "deposito", ferieResidueAl: "residuo ferie al",
  visitaFerrovieData: "data visita ferrovie", visitaFerrovieValidita: "scadenza visita ferrovie", visitaFerrovieEsito: "esito visita ferrovie",
  visitaMedicoCompetenteData: "data visita medico competente", visitaMedicoCompetenteValidita: "scadenza visita medico competente",
  visitaMedicoCompetenteEsito: "esito visita medico competente",
};
