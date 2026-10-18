/**
 * Regole delle password e del primo amministratore. Funzioni pure, senza
 * database: le usano il bootstrap di auth.ts, le rotte di gestione utenti e
 * i test.
 *
 * Conta la lunghezza, non la composizione (NIST SP 800-63B): almeno 12
 * caratteri, nessun obbligo di maiuscole o simboli, nessuna scadenza. Si
 * rifiutano invece le password comuni, le sequenze banali e quelle che
 * contengono il nome o l'email della persona o il nome dell'azienda.
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/* le più usate fra quelle abbastanza lunghe da passare il minimo */
const COMUNI = new Set([
  "password1234", "password12345", "password123456", "passwordpassword", "passw0rd1234",
  "qwertyuiop12", "qwerty123456", "qwertyqwerty", "1q2w3e4r5t6y", "1qaz2wsx3edc",
  "iloveyou1234", "welcome12345", "letmein12345", "adminadmin12", "administrator",
  "administrator1", "changeme1234", "trustno11234", "football1234", "superman1234",
  "princess1234", "sunshine1234", "monkey123456", "dragon123456", "mustang12345",
  "juventus1234", "milanmilan12", "interinter12", "napoli123456", "romaroma1234",
  "ciaociao1234", "ciao12345678", "amoreamore12", "passwordnuova", "nuovapassword",
  "cambiami1234", "benvenuto123", "benvenuto1234", "autobus12345", "conducente12",
]);

/* parole che chi attacca un'azienda prova per prime */
const PAROLE_AZIENDA = ["cerbero", "conerobus", "transitintel", "ancona", "password", "autobus"];

const SEQUENZE = [
  "0123456789012345678901234567890123456789",
  "9876543210987654321098765432109876543210",
  "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
  "zyxwvutsrqponmlkjihgfedcbazyxwvutsrqponmlkjihgfedcba",
  "qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklzxcvbnm",
  "azertyuiopqsdfghjklmwxcvbnazertyuiopqsdfghjklmwxcvbn",
  "qazwsxedcrfvtgbyhnujmikolpqazwsxedcrfvtgbyhnujmikolp",
];

const compatta = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** I pezzi riconoscibili di nome ed email («mario.rossi@…» → mario, rossi). */
function pezziDellaPersona(email?: string | null, nome?: string | null): string[] {
  const locale = (email ?? "").split("@")[0] ?? "";
  return [...locale.split(/[._+-]/), ...(nome ?? "").split(/\s+/)]
    .map(compatta).filter(p => p.length >= 3);
}

/**
 * La password contiene la persona? Si guarda parola per parola, senza le
 * cifre: «Mario2026!» e «rossi mario» sì, «il camaleonte verde» per Leo no
 * (un nome corto dentro una parola qualsiasi non conta).
 */
function contieneLaPersona(p: string, pezzi: string[]): boolean {
  if (!pezzi.length) return false;
  const parole = p.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/).map(w => w.replace(/[0-9]/g, "")).filter(Boolean);
  const insieme = new Set(pezzi);
  /* le parole da sole, e attaccate fra loro («mariorossi») */
  if (parole.some(w => insieme.has(w))) return true;
  const tutto = parole.join("");
  return pezzi.some((a, i) => pezzi.some((b, j) => i !== j && (tutto === a + b || parole.some(w => w === a + b))));
}

/** Il motivo per cui una password nuova non va bene, o null se va bene. */
export function erroreNuovaPassword(p: unknown, persona: { email?: string | null; nome?: string | null } = {}): string | null {
  if (typeof p !== "string" || !p) return "La password è obbligatoria";
  if ([...p].length < PASSWORD_MIN) return `La password deve avere almeno ${PASSWORD_MIN} caratteri`;
  if ([...p].length > PASSWORD_MAX) return `La password può avere al massimo ${PASSWORD_MAX} caratteri`;
  const c = compatta(p);
  if (COMUNI.has(p.toLowerCase()) || COMUNI.has(c)) return "Password troppo comune: scegline un'altra";
  /* un pezzo ripetuto (aaaa…, abcabc…, «password password») o una sequenza della tastiera */
  if (/^(.+?)\1+$/.test(c)) return "Password troppo semplice: è un pezzo ripetuto";
  if (c.length >= 8 && SEQUENZE.some(s => s.includes(c))) return "Password troppo semplice: è una sequenza della tastiera";
  for (const w of PAROLE_AZIENDA) {
    /* tolte tutte le volte che compare: «Conerobus Conerobus 1» resta quasi vuota */
    if (c.includes(w) && c.split(w).join("").length < 8) return "Password troppo legata a una parola ovvia (nome dell'azienda o «password»)";
  }
  if (contieneLaPersona(p, pezziDellaPersona(persona.email, persona.nome))) {
    return "La password non deve contenere il nome o l'email della persona";
  }
  return null;
}

export type PrimoAdmin =
  | { tipo: "niente" }
  | { tipo: "crea"; email: string; password: string }
  | { tipo: "avviso"; messaggio: string };

/**
 * Che cosa fare a database vuoto. Nessun utente scritto nel codice: il
 * primo amministratore viene da CERBERO_ADMIN_EMAIL e CERBERO_ADMIN_PASSWORD
 * e, senza, non si crea nessuno (e lo si dice nel log).
 */
export function decidiPrimoAdmin(nUtenti: number, env: { CERBERO_ADMIN_EMAIL?: string; CERBERO_ADMIN_PASSWORD?: string }): PrimoAdmin {
  if (nUtenti > 0) return { tipo: "niente" };
  const email = (env.CERBERO_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = env.CERBERO_ADMIN_PASSWORD ?? "";
  if (!email || !password) {
    return { tipo: "avviso", messaggio: "nessun utente e CERBERO_ADMIN_EMAIL/CERBERO_ADMIN_PASSWORD non impostate: nessuno può entrare finché non le imposti e riavvii" };
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return { tipo: "avviso", messaggio: "CERBERO_ADMIN_EMAIL non è un'email: amministratore non creato" };
  const errore = erroreNuovaPassword(password, { email });
  if (errore) return { tipo: "avviso", messaggio: `CERBERO_ADMIN_PASSWORD non va bene (${errore}): amministratore non creato` };
  return { tipo: "crea", email, password };
}
