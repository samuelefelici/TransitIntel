/**
 * La pagina Amministrazione › Ruoli (PR 2.18): che cosa dà ogni ruolo
 * aziendale, area per area. API GET /api/admin/ruoli e PUT
 * /api/admin/ruoli/:ruolo; i nomi di ruoli e aree sono nel pacchetto
 * @workspace/permessi. Qui la logica della pagina, in funzioni pure.
 *
 * Chi può davvero fare una cosa lo decide l'API con la matrice in vigore:
 * questa pagina la mostra e chiede di cambiarla.
 */
import {
  AREE, MATRICE, NOMI_AREE, RUOLI, matriceConModifiche, puo,
  type Area, type Diritti, type Livello, type Matrice, type RuoloAziendale,
} from "@workspace/permessi";

export interface StatoRuolo {
  codice: RuoloAziendale;
  /** gli utenti attivi che hanno il ruolo, amministratori di sistema esclusi */
  utenti: number;
  diritti: Diritti;
  diPartenza: Diritti;
  aggiornataIl: string | null;
  aggiornataDa: string | null;
}

export interface EsitoSalvataggio { celle: number; utentiAggiornati: number; datiSanitariSpenti: number; daVerificare: number }
export interface RispostaRuoli { ruoli: StatoRuolo[]; esito?: EsitoSalvataggio }

export const NOMI_LIVELLI = { N: "Niente", L: "Lettura", S: "Scrittura" } as const;
export type Scelta = keyof typeof NOMI_LIVELLI;
export const SCELTE: readonly Scelta[] = ["N", "L", "S"];

export const sceltaDi = (l: Livello | null | undefined): Scelta => (l === "S" || l === "L" ? l : "N");
export const livelloDi = (s: Scelta): Livello | null => (s === "N" ? null : s);

/** Quello che arriva dal server, controllato: un ruolo o un'area che la web non conosce non si mostrano. */
export function ruoliValidi(x: unknown): StatoRuolo[] {
  const elenco = x && typeof x === "object" && Array.isArray((x as any).ruoli) ? (x as any).ruoli as unknown[] : [];
  const riga = (d: unknown): Diritti => {
    const dato = d && typeof d === "object" ? d as Record<string, unknown> : {};
    return Object.fromEntries(AREE.map(a => [a, dato[a] === "S" || dato[a] === "L" ? dato[a] : null])) as Diritti;
  };
  const visti = new Map<string, StatoRuolo>();
  for (const r of elenco) {
    if (!r || typeof r !== "object") continue;
    const d = r as Record<string, unknown>;
    if (!(RUOLI as readonly unknown[]).includes(d.codice)) continue;
    visti.set(String(d.codice), {
      codice: d.codice as RuoloAziendale,
      utenti: typeof d.utenti === "number" && d.utenti >= 0 ? Math.floor(d.utenti) : 0,
      diritti: riga(d.diritti), diPartenza: riga(d.diPartenza),
      aggiornataIl: typeof d.aggiornataIl === "string" ? d.aggiornataIl : null,
      aggiornataDa: typeof d.aggiornataDa === "string" ? d.aggiornataDa : null,
    });
  }
  return RUOLI.filter(r => visti.has(r)).map(r => visti.get(r)!);
}

/** La matrice in vigore, dai ruoli che ha dato il server (per l'anteprima in Utenti e accessi). */
export function matriceDaRuoli(ruoli: readonly StatoRuolo[]): Matrice {
  return matriceConModifiche(MATRICE, ruoli.flatMap(r => AREE.map(a => ({ ruolo: r.codice, area: a, livello: sceltaDi(r.diritti[a]) }))));
}

export interface Differenza { area: Area; da: Livello | null; a: Livello | null }

/** Le aree in cui due righe di diritti sono diverse, nell'ordine del menu. */
export function differenze(prima: Diritti, dopo: Diritti): Differenza[] {
  return AREE.filter(a => (prima[a] ?? null) !== (dopo[a] ?? null)).map(a => ({ area: a, da: prima[a] ?? null, a: dopo[a] ?? null }));
}

export const uguali = (a: Diritti, b: Diritti): boolean => differenze(a, b).length === 0;

/** «Rete e orari: Lettura → Niente» */
export function differenzaInParole(d: Differenza): string {
  return `${NOMI_AREE[d.area]}: ${NOMI_LIVELLI[sceltaDi(d.da)]} → ${NOMI_LIVELLI[sceltaDi(d.a)]}`;
}

/** «Scrive: Roster · Legge: Rete e orari, Turni», o «Non apre nessuna area». */
export function riassuntoDeiDiritti(d: Diritti): string {
  const scrive = AREE.filter(a => d[a] === "S").map(a => NOMI_AREE[a]);
  const legge = AREE.filter(a => d[a] === "L").map(a => NOMI_AREE[a]);
  if (!scrive.length && !legge.length) return "Non apre nessuna area";
  return [scrive.length ? `Scrive: ${scrive.join(", ")}` : "", legge.length ? `Legge: ${legge.join(", ")}` : ""].filter(Boolean).join(" · ");
}

export interface Avviso { tono: "attenzione" | "nota"; testo: string }

/**
 * Le conseguenze di un cambio che l'amministratore deve sapere prima di
 * salvare. Sono le stesse regole che applica l'API: la verifica in due
 * passaggi è obbligatoria per chi apre Roster o Personale (colonna
 * users.mfa_obbligatoria), FleetCare si apre con la Flotta, i dati sanitari
 * stanno accesi solo a chi può aprire il Roster.
 */
export function avvisiDelCambio(prima: Diritti, dopo: Diritti, utenti: number): Avviso[] {
  const out: Avviso[] = [];
  const chi = utenti === 1 ? "la persona che ha questo ruolo" : "chi ha questo ruolo";
  if (!puo(prima, "personale", "L") && puo(dopo, "personale", "L")) {
    out.push({ tono: "attenzione", testo: `Con il Personale ${chi} vede i dati personali di tutti i dipendenti: contatti, residenza, paghe, ferie, visite. È una scelta sul trattamento dei dati dei lavoratori: va decisa con chi ne risponde in azienda.` });
  } else if (prima.personale === "L" && dopo.personale === "S") {
    out.push({ tono: "attenzione", testo: `Con la scrittura sul Personale ${chi} può anche modificare i dati personali dei dipendenti.` });
  }
  const verificaPrima = puo(prima, "roster", "L") || puo(prima, "personale", "L");
  const verificaDopo = puo(dopo, "roster", "L") || puo(dopo, "personale", "L");
  if (!verificaPrima && verificaDopo) {
    out.push({ tono: "attenzione", testo: "Roster e Personale chiedono la verifica in due passaggi: chi ha questo ruolo e non l'ha ancora attivata dovrà farlo prima di continuare a lavorare, anche se è già dentro." });
  }
  if (puo(prima, "roster", "L") && !puo(dopo, "roster", "L")) {
    out.push({ tono: "attenzione", testo: "Senza il Roster si spengono i dati sanitari a chi li aveva e non lo apre con un altro ruolo. Se poi ridai il Roster non tornano da soli: si riaccendono utente per utente." });
  }
  if (puo(prima, "flotta", "L") && !puo(dopo, "flotta", "L")) {
    out.push({ tono: "nota", testo: "Senza la Flotta non si entra più in FleetCare, salvo averla con un altro ruolo." });
  } else if (!puo(prima, "flotta", "L") && puo(dopo, "flotta", "L")) {
    out.push({ tono: "nota", testo: "Con la Flotta si entra in FleetCare, con il ruolo FleetCare scelto per ogni utente (di solito «Autista»)." });
  }
  if (AREE.every(a => !dopo[a]) && AREE.some(a => prima[a])) {
    out.push({ tono: "attenzione", testo: "Così il ruolo non apre più nessuna area: chi ha solo questo ruolo entra e non vede niente." });
  }
  return out;
}

/** Il corpo della richiesta di salvataggio: tutte le aree, ognuna "S", "L" o null. */
export function corpoDelSalvataggio(d: Diritti): { diritti: Record<Area, Livello | null> } {
  return { diritti: Object.fromEntries(AREE.map(a => [a, d[a] ?? null])) as Record<Area, Livello | null> };
}

/** Che cosa è successo dopo un salvataggio, in una frase. */
export function esitoInParole(e: EsitoSalvataggio | undefined, utenti: number): string {
  if (!e) return "";
  const pezzi: string[] = [];
  if (utenti === 0) pezzi.push("Nessun utente ha questo ruolo, per ora.");
  else pezzi.push(`Vale da subito per ${utenti === 1 ? "la persona" : `le ${utenti} persone`} con questo ruolo.`);
  if (e.datiSanitariSpenti > 0) pezzi.push(`Dati sanitari spenti a ${e.datiSanitariSpenti === 1 ? "una persona" : `${e.datiSanitariSpenti} persone`}.`);
  if (e.daVerificare > 0) pezzi.push(`${e.daVerificare === 1 ? "Una persona deve" : `${e.daVerificare} persone devono`} attivare la verifica in due passaggi.`);
  return pezzi.join(" ");
}
