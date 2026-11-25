/**
 * Import dei turni esistenti (tappa 7.38): le chiamate e i testi della
 * finestra «Importa turni esistenti» di Fucina. Il file si manda al server,
 * che lo legge e non lo conserva.
 */
import { apiFetch } from "@/lib/api";

export interface TipoDiGiorno {
  chiave: string;
  nomi: string[];
  date: string[];
  turniGuida: number;
  turniMacchina: number;
}

export interface Resoconto {
  turniGuida: number;
  turniMacchina: number;
  corseNelFile: number;
  riconosciutePerNumero: number;
  riconosciutePerOrario: number;
  nonTrovate: number;
  corseDelGtfsSenzaTurno: number;
  turniMacchinaVuoti: number;
  pezziSenzaCorsa: number;
}

export interface CorsaNonTrovata {
  linea: string | null;
  partenza: string;
  arrivo: string;
  da: string;
  a: string;
  turnoGuida: string;
  turnoMacchina: string | null;
}

export interface Anteprima {
  periodo: { dal: string | null; al: string | null };
  tipiDiGiorno: TipoDiGiorno[];
  data?: string;
  tipoDelGiorno?: string;
  gtfs?: { corseDelGiorno: number; serviziAttivi: number };
  resoconto?: Resoconto;
  nonTrovate?: CorsaNonTrovata[];
}

export interface EsitoImport {
  vehicleScenarioId: string;
  driverScenarioId: string;
  nome: string;
  resoconto: Resoconto;
}

function modulo(file: File, campi: Record<string, string | undefined>): FormData {
  const f = new FormData();
  f.append("file", file);
  for (const [k, v] of Object.entries(campi)) if (v) f.append(k, v);
  return f;
}

/* l'intestazione fa passare la richiesta dal controllo CORS: la vuole il server */
const INTESTAZIONI = { "X-Cerbero-Import": "1" };

export function anteprimaTurni(projectId: string, file: File, data?: string): Promise<Anteprima> {
  return apiFetch<Anteprima>(`/api/scheduling/projects/${projectId}/turni-esistenti/anteprima`, {
    method: "POST", body: modulo(file, { data }), headers: INTESTAZIONI,
  });
}

export function importaTurni(projectId: string, file: File, data: string, nome: string): Promise<EsitoImport> {
  return apiFetch<EsitoImport>(`/api/scheduling/projects/${projectId}/turni-esistenti`, {
    method: "POST", body: modulo(file, { data, nome: nome.trim() || undefined }), headers: INTESTAZIONI,
  });
}

const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

/** «2026-12-01» → «mar 01/12/2026». */
export function dataLeggibile(iso: string | null | undefined, conGiorno = true): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return "—";
  const [, a, me, g] = m;
  const d = new Date(Date.UTC(Number(a), Number(me) - 1, Number(g)));
  return `${conGiorno ? `${GIORNI[d.getUTCDay()]} ` : ""}${g}/${me}/${a}`;
}

/** Il nome del tipo di giorno: i nomi degli insiemi di turni del file, uniti. */
export function etichettaTipo(nomi: string[], max = 90): string {
  const t = nomi.join(" + ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** La prima data da oggi in poi; se sono tutte passate, la prima. */
export function primaDataUtile(date: string[], oggi: string): string | null {
  return date.find((d) => d >= oggi) ?? date[0] ?? null;
}

export function nomeProposto(data: string): string {
  return `Turni esistenti · ${dataLeggibile(data, false)}`;
}

export function riconosciute(r: Resoconto): number {
  return r.riconosciutePerNumero + r.riconosciutePerOrario;
}

export function percentuale(parte: number, totale: number): number {
  return totale > 0 ? Math.round((parte / totale) * 100) : 0;
}

/**
 * Quanto ci si può fidare dell'aggancio: quasi tutte le corse (≥ 95%) → bene;
 * la maggior parte (≥ 70%) → da guardare; meno → il GTFS è probabilmente di
 * un altro periodo.
 */
export function giudizio(r: Resoconto): "bene" | "attenzione" | "grave" {
  const p = percentuale(riconosciute(r), r.corseNelFile);
  return p >= 95 ? "bene" : p >= 70 ? "attenzione" : "grave";
}
