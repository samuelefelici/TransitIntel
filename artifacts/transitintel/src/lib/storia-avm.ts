/**
 * L'andamento AVM nella pagina: i conti sul perimetro scelto (solo Conerobus,
 * senza fuori parco e dismesse). Stesse regole del server
 * (api-server/src/lib/avm-storia.ts: andamentoStoria, fraseAndamento), così
 * il grafico, la frase e il foglio Excel contano le stesse vetture.
 */

export type Azione =
  | "da_riparare" | "da_togliere_da_siri" | "da_aggiungere_a_siri" | "da_verificare_alienata"
  | "instabile" | "riparata" | "funziona" | "non_giudicabile" | "gia_tolta";

export const ORDINE_AZIONI: Azione[] = [
  "da_riparare", "da_togliere_da_siri", "da_aggiungere_a_siri", "da_verificare_alienata",
  "instabile", "riparata", "funziona", "non_giudicabile", "gia_tolta",
];

export interface SettimanaStoria { lunedi: string; domenica: string; giornateContate: number; chiusa: boolean }
export interface VetturaPerConti {
  vehicleRef: string;
  storia: string;
  primoGiorno: string | null;
  azione: Azione;
  esclusa: { motivo: string } | null;
  richiesta: { tipo: "togliere" | "aggiungere"; esito: "fatta" | "annullata" | null } | null;
}
export type SettimanaContata = SettimanaStoria & { F: number; P: number; M: number; A: number };

const GIORNATE_MINIME = 3;

export const eConerobus = (ref: string) => /^\d{1,4}$/.test(ref);

/** Il lunedì della settimana che contiene la giornata (date "YYYY-MM-DD" a mezzanotte UTC). */
export function lunediDi(giorno: string): string {
  const t = new Date(`${giorno}T00:00:00Z`);
  const dow = t.getUTCDay();
  return new Date(t.getTime() - ((dow + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

export function ddmm(g: string | null): string {
  if (!g) return "";
  const [, m, d] = g.split("-");
  return `${d}/${m}`;
}

/** Per settimana, quante vetture si localizzavano, parlavano, tacevano, mancavano: dalla loro prima comparsa. */
export function andamentoPerimetro(settimane: SettimanaStoria[], vetture: VetturaPerConti[]): SettimanaContata[] {
  return settimane.map((w, i) => {
    const n = { F: 0, P: 0, M: 0, A: 0 };
    for (const v of vetture) {
      if (!v.primoGiorno || lunediDi(v.primoGiorno) > w.lunedi) continue;
      const ch = v.storia[i];
      if (ch === "F" || ch === "P" || ch === "M" || ch === "A") n[ch]++;
    }
    return { ...w, ...n };
  });
}

/** La frase di sintesi: l'ultima settimana chiusa giudicabile, e la prima. */
export function fraseAndamento(a: SettimanaContata[]): string {
  const giudicabili = a.filter(w => w.chiusa && w.giornateContate >= GIORNATE_MINIME);
  const ultima = giudicabili.at(-1);
  if (!ultima) return "Nessuna settimana chiusa con abbastanza giornate contate: l'andamento non si può ancora dire.";
  const quota = (w: SettimanaContata) => {
    const tot = w.F + w.P + w.M + w.A;
    return { tot, pct: tot ? Math.round((100 * w.F) / tot) : 0 };
  };
  const u = quota(ultima);
  const pezzi = [`Nella settimana dal ${ddmm(ultima.lunedi)} al ${ddmm(ultima.domenica)} si sono localizzate `
    + `${ultima.F} vetture su ${u.tot} (${u.pct}%).`];
  const prima = giudicabili[0];
  if (prima && prima.lunedi !== ultima.lunedi) {
    const p = quota(prima);
    pezzi.push(`Nella prima settimana osservata, dal ${ddmm(prima.lunedi)}, erano ${prima.F} su ${p.tot} (${p.pct}%).`);
  }
  return pezzi.join(" ");
}

export function conteggiAzioni(vetture: Array<Pick<VetturaPerConti, "azione">>): Record<Azione, number> {
  const c = Object.fromEntries(ORDINE_AZIONI.map(a => [a, 0])) as Record<Azione, number>;
  for (const v of vetture) c[v.azione]++;
  return c;
}

/** Il tipo di richiesta a Mizar che l'azione chiede, se ne chiede una. */
export function tipoRichiesta(a: Azione): "togliere" | "aggiungere" | null {
  return a === "da_togliere_da_siri" ? "togliere" : a === "da_aggiungere_a_siri" ? "aggiungere" : null;
}

/** Si può segnare una richiesta per la vettura: l'azione la chiede e non ce n'è già una aperta dello stesso tipo. */
export function selezionabile(v: Pick<VetturaPerConti, "azione" | "richiesta">): boolean {
  const tipo = tipoRichiesta(v.azione);
  return tipo != null && !(v.richiesta && v.richiesta.esito == null && v.richiesta.tipo === tipo);
}

/** Il tipo comune a una selezione; null se è vuota o mescola i due tipi. */
export function tipoDellaSelezione(vetture: Array<Pick<VetturaPerConti, "azione">>): "togliere" | "aggiungere" | null {
  const tipi = new Set(vetture.map(v => tipoRichiesta(v.azione)));
  if (tipi.size !== 1) return null;
  return [...tipi][0];
}
