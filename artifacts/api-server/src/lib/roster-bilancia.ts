/**
 * «Bilancia i carichi» (PR 7.7): in un periodo, i turni già assegnati si
 * spostano fra i conducenti dello stesso deposito perché le ore di lavoro
 * siano più vicine. Qui solo la scelta, senza database.
 *
 * Il carico di un conducente è la somma delle durate dei suoi turni nel
 * periodo (dall'inizio alla fine del turno). Due mosse:
 *   - «cede»: un turno del più carico passa a uno meno carico che quel giorno
 *     è libero (in servizio, senza voci né turni);
 *   - «scambio»: due turni dello stesso giorno si scambiano, il più lungo al
 *     meno carico.
 * Si sposta solo quello che si può spostare (non le sostituzioni di un
 * titolare assente, non i turni forzati, solo nei giorni da domani) e solo
 * se nessuno dei due ha violazioni di riposo o sovrapposizioni nuove. Ogni
 * mossa avvicina i due conducenti senza rovesciarli, quindi la somma dei
 * quadrati dei carichi scende sempre e la ricerca finisce.
 * È una proposta: si guarda e poi si applica, con i controlli dello scambio
 * a mano.
 */
import { violazioniDeiTurni, type TurnoNelTempo } from "./roster-normativa";

export interface ConducenteBilancio {
  id: string;
  nome: string;
  /** i giorni del periodo in cui può ricevere un turno senza darne uno (in servizio, senza voci) */
  liberi: Set<string>;
  /** i giorni in cui può scambiare (in servizio, senza assenze) */
  presente: Set<string>;
}

export interface TurnoBilancio {
  turno: TurnoNelTempo;
  /** si può spostare: non è una sostituzione, non è forzato, cade in un giorno che si può cambiare */
  spostabile: boolean;
}

export interface PezzoMossa { id: string; codice: string; dssId: string; minuti: number }
export interface Mossa {
  tipo: "cede" | "scambio";
  giorno: string;
  da: { id: string; nome: string };
  a: { id: string; nome: string };
  /** il turno che passa da «da» ad «a» */
  turno: PezzoMossa;
  /** nello scambio, il turno che torna da «a» a «da» */
  inCambio: PezzoMossa | null;
}

export interface Carico { id: string; nome: string; prima: number; dopo: number; turniPrima: number; turniDopo: number }

export interface Opzioni {
  /** sotto questa distanza (in minuti) fra due conducenti non si sposta niente */
  soglia?: number;
  /** al più queste mosse */
  massimo?: number;
}

const durata = (t: TurnoNelTempo) => Math.max(0, t.fine - t.inizio);
const pezzo = (t: TurnoNelTempo): PezzoMossa => ({ id: t.assegnazioneId ?? "", codice: t.codice, dssId: t.dssId, minuti: durata(t) });

/**
 * La scelta, per i conducenti di un deposito. `turni` sono i loro turni nel
 * periodo e nei giorni intorno (per i riposi); il carico conta solo quelli dei
 * giorni di `periodo`.
 */
export function bilancia(conducenti: ConducenteBilancio[], turni: TurnoBilancio[], periodo: Set<string>, opzioni: Opzioni = {}): { mosse: Mossa[]; carichi: Carico[] } {
  const soglia = opzioni.soglia ?? 30;
  const massimo = opzioni.massimo ?? 200;
  const perChiave = new Map(turni.map(t => [t.turno.chiave, t]));
  /* lo stato che cambia: i turni di ognuno, il carico e quanti turni */
  const suoi = new Map<string, Set<string>>(conducenti.map(c => [c.id, new Set<string>()]));
  const carico = new Map<string, number>(conducenti.map(c => [c.id, 0]));
  const quanti = new Map<string, number>(conducenti.map(c => [c.id, 0]));
  for (const t of turni) {
    const chi = t.turno.conducenteId;
    const insieme = suoi.get(chi);
    if (!insieme) continue;
    insieme.add(t.turno.chiave);
    if (!periodo.has(t.turno.giorno)) continue;
    carico.set(chi, carico.get(chi)! + durata(t.turno));
    quanti.set(chi, quanti.get(chi)! + 1);
  }
  const prima = new Map(carico), turniPrima = new Map(quanti);

  const turniDi = (id: string) => [...suoi.get(id)!].map(k => perChiave.get(k)!);
  const delGiorno = (id: string, giorno: string) => turniDi(id).filter(t => t.turno.giorno === giorno);

  /** nessuna violazione nuova, per i due conducenti, coi turni cambiati di mano */
  const senzaViolazioni = (cambi: Array<{ t: TurnoBilancio; a: string }>) => {
    const cambiate = new Set(cambi.map(c => c.t.turno.chiave));
    for (const id of new Set(cambi.map(c => c.a))) {
      const dopo = [
        ...turniDi(id).filter(t => !cambiate.has(t.turno.chiave)).map(t => t.turno),
        ...cambi.filter(c => c.a === id).map(c => ({ ...c.t.turno, conducenteId: id, coppieForzate: [] })),
      ];
      if (violazioniDeiTurni(dopo).some(v => v.turni.some(x => cambiate.has(x.chiave)))) return false;
    }
    return true;
  };

  const passa = (t: TurnoBilancio, da: string, a: string) => {
    suoi.get(da)!.delete(t.turno.chiave);
    suoi.get(a)!.add(t.turno.chiave);
    const x = durata(t.turno);
    carico.set(da, carico.get(da)! - x);
    carico.set(a, carico.get(a)! + x);
    quanti.set(da, quanti.get(da)! - 1);
    quanti.set(a, quanti.get(a)! + 1);
  };

  const mosse: Mossa[] = [];
  while (mosse.length < massimo) {
    const ordine = [...conducenti].sort((p, q) => carico.get(q.id)! - carico.get(p.id)! || p.nome.localeCompare(q.nome, "it"));
    let fatta = false;
    coppie: for (const h of ordine) {
      for (const l of [...ordine].reverse()) {
        if (l.id === h.id) break;
        const distanza = carico.get(h.id)! - carico.get(l.id)!;
        if (distanza <= soglia) break;
        /* le mosse possibili fra i due, prima quella che li lascia più vicini */
        const candidate: Array<{ resta: number; a: TurnoBilancio; b: TurnoBilancio | null }> = [];
        for (const a of turniDi(h.id)) {
          const g = a.turno.giorno;
          if (!a.spostabile || !periodo.has(g)) continue;
          const diL = delGiorno(l.id, g);
          let x = 0, b: TurnoBilancio | null = null;
          if (!diL.length && l.liberi.has(g)) {
            x = durata(a.turno);
          } else if (diL.length === 1 && diL[0]!.spostabile && l.presente.has(g) && h.presente.has(g) && delGiorno(h.id, g).length === 1) {
            b = diL[0]!;
            x = durata(a.turno) - durata(b.turno);
          } else continue;
          if (x > 0 && x < distanza) candidate.push({ resta: Math.abs(distanza - 2 * x), a, b });
        }
        candidate.sort((p, q) => p.resta - q.resta || p.a.turno.giorno.localeCompare(q.a.turno.giorno)
          || p.a.turno.codice.localeCompare(q.a.turno.codice, "it", { numeric: true }));
        for (const c of candidate) {
          const cambi = [{ t: c.a, a: l.id }, ...(c.b ? [{ t: c.b, a: h.id }] : [])];
          if (!senzaViolazioni(cambi)) continue;
          passa(c.a, h.id, l.id);
          if (c.b) passa(c.b, l.id, h.id);
          mosse.push({
            tipo: c.b ? "scambio" : "cede", giorno: c.a.turno.giorno,
            da: { id: h.id, nome: h.nome }, a: { id: l.id, nome: l.nome },
            turno: pezzo(c.a.turno), inCambio: c.b ? pezzo(c.b.turno) : null,
          });
          fatta = true;
          break coppie;
        }
      }
    }
    if (!fatta) break;
  }
  const carichi: Carico[] = conducenti.map(c => ({
    id: c.id, nome: c.nome,
    prima: prima.get(c.id)!, dopo: carico.get(c.id)!,
    turniPrima: turniPrima.get(c.id)!, turniDopo: quanti.get(c.id)!,
  })).sort((p, q) => q.prima - p.prima || p.nome.localeCompare(q.nome, "it"));
  return { mosse, carichi };
}

/** Lo scarto fra il più carico e il meno carico, in minuti. */
export function scarto(carichi: Carico[], quando: "prima" | "dopo"): number {
  if (!carichi.length) return 0;
  const v = carichi.map(c => c[quando]);
  return Math.max(...v) - Math.min(...v);
}
