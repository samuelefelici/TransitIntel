/**
 * La vestizione per deposito (tappa 5.2), senza React: si prova da sola.
 *
 * Dal tabellone del roster (GET /api/roster/board) di un giorno:
 *   - i turni pubblicati del deposito, in ordine di uscita, con chi li fa;
 *     quelli da coprire in cima: scoperti, e liberati da un'assenza (5.1);
 *   - i conducenti del deposito in cinque gruppi: in servizio, liberi, a
 *     disposizione (D1, D2), a riposo, assenti. Il motivo di un'assenza è
 *     quello che il server manda: chi non ha il permesso del roster riceve
 *     «ASS», mai malattia, infortunio o 104.
 * E l'ordine di servizio da stampare: turni, orari e conducenti. Per la
 * bacheca: dei turni da coprire non dice chi è assente.
 */
import { aDisposizione, aRiposo, liberaTurno } from "./voci-roster";

export interface TurnoTabellone {
  code: string; type: string | null; start: string | null; end: string | null;
  residenzaName?: string | null;
  /** il deposito del catalogo del turno, abbinato dal server (5.2) */
  depositoCodice?: string | null;
}
export interface ConducenteTabellone {
  id: string; name: string; cognome?: string | null; nome?: string | null; matricola?: string | null;
  isFictitious?: boolean; depositoCodice?: string | null;
}
export interface TabelloneVestizione {
  drivers: ConducenteTabellone[];
  assignments: Array<{ id: string; driverId: string; day: string; dutyCode: string; dssId: string; titolareId?: string | null }>;
  occupatiDaAltri?: Array<{ day: string; dutyCode: string; dssId: string }>;
  entries?: Array<{ driverId: string; day: string; category: string; code: string; liberaTurno?: boolean; aDisposizione?: boolean }>;
  pubblicati: Record<string, Array<{ dssId: string; udpNome: string | null }>>;
  dutiesByDss: Record<string, TurnoTabellone[]>;
}

export type StatoTurno = "scoperto" | "liberato" | "coperto" | "altro_deposito";
export interface Persona { id: string; nome: string; fittizio: boolean }
export interface TurnoDelGiorno {
  dssId: string; codice: string; tipo: string | null; inizio: string | null; fine: string | null; udp: string | null;
  stato: StatoTurno;
  /** chi lo fa (coperto) */
  conducente: Persona | null;
  /** liberato: chi è assente; coperto da un sostituto: chi è sostituito */
  titolare: Persona | null;
}
export type Gruppo = "in_servizio" | "liberi" | "disposizione" | "riposo" | "assenti";
export interface ConducenteDelGiorno extends Persona { matricola: string | null; turni: string[]; voce: string | null }
export interface Vestizione {
  turni: TurnoDelGiorno[];
  conducenti: Record<Gruppo, ConducenteDelGiorno[]>;
}

export const GRUPPI: Array<[Gruppo, string]> = [
  ["in_servizio", "In servizio"], ["liberi", "Liberi"], ["disposizione", "A disposizione"], ["riposo", "A riposo"], ["assenti", "Assenti"],
];

export const nomeDi = (c: ConducenteTabellone): string => [c.cognome, c.nome].filter(Boolean).join(" ") || c.name;
const persona = (c: ConducenteTabellone | undefined, id: string): Persona =>
  c ? { id: c.id, nome: nomeDi(c), fittizio: !!c.isFictitious } : { id, nome: "conducente di un altro deposito", fittizio: false };
const daCoprire = (s: StatoTurno) => s === "scoperto" || s === "liberato";
const minuti = (t: string | null) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.POSITIVE_INFINITY;
};

/** La vestizione del giorno per un deposito (codice del catalogo), o per tutti con `null`. */
export function vestizione(b: TabelloneVestizione, giorno: string, deposito: string | null): Vestizione {
  const conducenti = new Map(b.drivers.map((d) => [d.id, d]));
  const voci = (b.entries ?? []).filter((e) => e.day === giorno);
  const assenza = new Map<string, string>();
  const riposo = new Map<string, string>();
  const disposizione = new Map<string, string>();
  for (const v of voci) {
    /* le regole della voce nel catalogo (5.5): il riposo non libera il turno, le altre assenze sì */
    if (aRiposo(v)) riposo.set(v.driverId, v.code);
    else if (liberaTurno(v)) assenza.set(v.driverId, v.code);
    else if (aDisposizione(v)) disposizione.set(v.driverId, v.code);
  }
  const delGiorno = b.assignments.filter((a) => a.day === giorno);
  const perTurno = new Map(delGiorno.map((a) => [`${a.dssId}|${a.dutyCode}`, a]));
  const altri = new Set((b.occupatiDaAltri ?? []).filter((a) => a.day === giorno).map((a) => `${a.dssId}|${a.dutyCode}`));

  const turni: TurnoDelGiorno[] = [];
  for (const p of b.pubblicati[giorno] ?? []) {
    for (const d of b.dutiesByDss[p.dssId] ?? []) {
      if (deposito && d.depositoCodice !== deposito) continue;
      const k = `${p.dssId}|${d.code}`;
      const a = perTurno.get(k);
      const base = { dssId: p.dssId, codice: d.code, tipo: d.type ?? null, inizio: d.start ?? null, fine: d.end ?? null, udp: p.udpNome ?? null };
      if (a && assenza.has(a.driverId)) {
        turni.push({ ...base, stato: "liberato", conducente: null, titolare: persona(conducenti.get(a.driverId), a.driverId) });
      } else if (a) {
        turni.push({
          ...base, stato: "coperto", conducente: persona(conducenti.get(a.driverId), a.driverId),
          titolare: a.titolareId ? persona(conducenti.get(a.titolareId), a.titolareId) : null,
        });
      } else {
        turni.push({ ...base, stato: altri.has(k) ? "altro_deposito" : "scoperto", conducente: null, titolare: null });
      }
    }
  }
  turni.sort((x, y) => Number(daCoprire(y.stato)) - Number(daCoprire(x.stato)) || minuti(x.inizio) - minuti(y.inizio) || x.codice.localeCompare(y.codice));

  const gruppi: Record<Gruppo, ConducenteDelGiorno[]> = { in_servizio: [], liberi: [], disposizione: [], riposo: [], assenti: [] };
  const turniDi = new Map<string, string[]>();
  for (const a of delGiorno) {
    const l = turniDi.get(a.driverId); if (l) l.push(a.dutyCode); else turniDi.set(a.driverId, [a.dutyCode]);
  }
  for (const c of b.drivers) {
    /* i fittizi servono a provare il tabellone: non sono persone da vestire */
    if (c.isFictitious || (deposito && c.depositoCodice !== deposito)) continue;
    const turniSuoi = (turniDi.get(c.id) ?? []).sort();
    const x: ConducenteDelGiorno = { id: c.id, nome: nomeDi(c), fittizio: false, matricola: c.matricola ?? null, turni: turniSuoi, voce: null };
    if (assenza.has(c.id)) gruppi.assenti.push({ ...x, voce: assenza.get(c.id)! });
    else if (riposo.has(c.id)) gruppi.riposo.push({ ...x, voce: riposo.get(c.id)! });
    else if (turniSuoi.length) gruppi.in_servizio.push(x);
    else if (disposizione.has(c.id)) gruppi.disposizione.push({ ...x, voce: disposizione.get(c.id)! });
    else gruppi.liberi.push(x);
  }
  for (const g of Object.values(gruppi)) g.sort((x, y) => x.nome.localeCompare(y.nome, "it"));
  return { turni, conducenti: gruppi };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * L'ordine di servizio del giorno, da stampare: per la bacheca. I turni da
 * coprire dicono solo «da coprire», mai chi è assente; i conducenti a
 * disposizione sono le riserve.
 */
export function ordineDiServizio(v: Vestizione, meta: { giorno: string; deposito: string; azienda?: string | null; stampatoIl: string }): string {
  const data = new Date(`${meta.giorno}T12:00:00`).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const righe = v.turni.filter((t) => t.stato !== "altro_deposito").map((t) => `<tr${daCoprire(t.stato) ? ' class="scoperto"' : ""}>
  <td class="cod">${esc(t.codice)}</td><td>${esc(t.tipo ?? "")}</td><td class="ora">${esc(t.inizio ?? "")}</td><td class="ora">${esc(t.fine ?? "")}</td>
  <td>${t.conducente ? esc(t.conducente.nome) : "<strong>DA COPRIRE</strong>"}</td></tr>`).join("\n");
  const riserve = v.conducenti.disposizione.map((c) => esc(c.nome)).join(", ");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Ordine di servizio ${esc(meta.giorno)} · ${esc(meta.deposito)}</title>
<style>
  body { font: 12px/1.4 system-ui, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; } .meta { color: #555; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; } th, td { border-bottom: 1px solid #ccc; padding: 4px 6px; text-align: left; }
  th { background: #f2f2f2; } td.cod { font-weight: 700; } td.ora { font-variant-numeric: tabular-nums; }
  tr.scoperto td { background: #fff4e5; } .riserve { margin-top: 12px; } .piede { margin-top: 16px; color: #777; font-size: 10px; }
  @media print { body { margin: 0; } @page { margin: 12mm; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
<h1>Ordine di servizio · ${esc(meta.deposito)}</h1>
<div class="meta">${esc(data)}${meta.azienda ? ` · ${esc(meta.azienda)}` : ""}</div>
<table><thead><tr><th>Turno</th><th>Tipo</th><th>Inizio</th><th>Fine</th><th>Conducente</th></tr></thead><tbody>
${righe || '<tr><td colspan="5">Nessun turno pubblicato per il giorno.</td></tr>'}
</tbody></table>
${riserve ? `<p class="riserve"><strong>A disposizione:</strong> ${riserve}</p>` : ""}
<p class="piede">Stampato il ${esc(meta.stampatoIl)}</p>
</body></html>`;
}
