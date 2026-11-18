/**
 * Il parco dell'azienda nel canale dell'AVM (tappa 6.21), per la pagina
 * Amministrazione › Azienda › AVM: i prefissi SIRI delle consorziate, le
 * eccezioni e l'anagrafica dei mezzi. Le regole che li usano stanno
 * nell'API (lib/parco-anagrafica.ts); qui il modulo, i controlli prima di
 * spedire e il testo delle domande. API: /api/admin/parco.
 */

export interface PrefissoConsorziata { prefisso: string; sigle: string[]; aProgressivo: boolean }
export interface EccezioneSiri { siriRef: string; codice: string; nota: string }

export interface StatoParco {
  vetture: number;
  importataIl: string | null;
  importataDa: string | null;
  consorziate: PrefissoConsorziata[];
  eccezioni: EccezioneSiri[];
  sigleSenzaPrefisso: string[];
}

/** Le righe del modulo, come testo: quello che si scrive nelle caselle. */
export interface RigaPrefisso { prefisso: string; sigle: string; aProgressivo: boolean }
export interface RigaEccezione { siriRef: string; codice: string; nota: string }
export interface ModuloConsorziate { consorziate: RigaPrefisso[]; eccezioni: RigaEccezione[] }

const SIGLA = /^[A-Z]{1,5}$/;
const CODICE = /^[A-Z0-9_.-]{1,20}$/;

/** «sa, BV» → ["SA", "BV"]: virgole o spazi, maiuscole, senza doppioni. */
export function sigleDa(testo: string): string[] {
  return [...new Set(testo.split(/[\s,;/]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export function moduloDa(s: Pick<StatoParco, "consorziate" | "eccezioni">): ModuloConsorziate {
  return {
    consorziate: s.consorziate.map((c) => ({ prefisso: c.prefisso, sigle: c.sigle.join(", "), aProgressivo: c.aProgressivo })),
    eccezioni: s.eccezioni.map((e) => ({ siriRef: e.siriRef, codice: e.codice, nota: e.nota })),
  };
}

/** Gli errori del modulo, uno per riga e campo (vuoto = si può salvare). Gli stessi controlli dell'API. */
export function erroriConsorziate(m: ModuloConsorziate): string[] {
  const e: string[] = [];
  const prefissi = new Set<string>();
  const sigle = new Map<string, string>();
  m.consorziate.forEach((c, i) => {
    const riga = `Prefissi, riga ${i + 1}`;
    const p = c.prefisso.trim();
    if (!/^[0-9]{2}$/.test(p)) e.push(`${riga}: il prefisso sono due cifre, come «11»`);
    else if (prefissi.has(p)) e.push(`${riga}: il prefisso ${p} c'è due volte`);
    prefissi.add(p);
    const s = sigleDa(c.sigle);
    if (!s.length) e.push(`${riga}: almeno una sigla, come «CJ»`);
    for (const x of s) {
      if (!SIGLA.test(x)) e.push(`${riga}: la sigla «${x}» non va (da 1 a 5 lettere)`);
      else if (sigle.has(x) && sigle.get(x) !== p) e.push(`${riga}: la sigla ${x} è già del prefisso ${sigle.get(x)}`);
      sigle.set(x, p);
    }
    if (s.length > 5) e.push(`${riga}: al più 5 sigle`);
  });
  const matricole = new Set<string>();
  m.eccezioni.forEach((x, i) => {
    const riga = `Eccezioni, riga ${i + 1}`;
    const ref = x.siriRef.trim();
    if (!/^[0-9]{1,10}$/.test(ref)) e.push(`${riga}: la matricola SIRI è fatta di cifre`);
    else if (matricole.has(ref)) e.push(`${riga}: la matricola ${ref} c'è due volte`);
    matricole.add(ref);
    if (!CODICE.test(x.codice.trim().toUpperCase())) e.push(`${riga}: il codice del mezzo è fatto di lettere, cifre e . _ -`);
    if (x.nota.length > 300) e.push(`${riga}: la nota è al più 300 caratteri`);
  });
  return e;
}

/** Il corpo del salvataggio: le righe vuote si tolgono, le sigle diventano un elenco. */
export function datiDaSalvare(m: ModuloConsorziate) {
  return {
    consorziate: m.consorziate
      .filter((c) => c.prefisso.trim() || c.sigle.trim())
      .map((c) => ({ prefisso: c.prefisso.trim(), sigle: sigleDa(c.sigle), aProgressivo: c.aProgressivo })),
    eccezioni: m.eccezioni
      .filter((x) => x.siriRef.trim() || x.codice.trim())
      .map((x) => ({ siriRef: x.siriRef.trim(), codice: x.codice.trim().toUpperCase(), nota: x.nota.trim() })),
  };
}

/** Come si legge una regola: «11096 → CJ096», o «solo con le eccezioni». */
export function esempioDellaRegola(c: RigaPrefisso): string {
  const s = sigleDa(c.sigle);
  const p = c.prefisso.trim();
  if (!/^[0-9]{2}$/.test(p) || !s.length) return "";
  if (!c.aProgressivo) return `${p}… solo con le eccezioni`;
  return s.map((x) => `${p}007 → ${x}007`).join(" o ");
}

export function moduloCambiato(a: ModuloConsorziate, b: ModuloConsorziate): boolean {
  return JSON.stringify(datiDaSalvare(a)) !== JSON.stringify(datiDaSalvare(b));
}
