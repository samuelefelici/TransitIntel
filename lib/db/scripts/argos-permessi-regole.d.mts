export interface ClientMinimo { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface Relazione { schema: string; tabella: string; tipo: string }
export interface Voce extends Relazione {
  a_tutti: boolean; privilegio: string; con_opzione: boolean; dato_da: string | null; colonna: boolean; estensione: boolean;
}
export interface Effettivo extends Relazione { estensione: boolean; legge: boolean; scrive: boolean; opzione: boolean }
export interface StatoPermessi {
  ruolo: string;
  esiste: boolean;
  attributi?: { superutente: boolean; replica: boolean; bypassrls: boolean; crearuoli: boolean; login: boolean };
  voci?: Voce[];
  concessiDaLui?: { genere: "relazione" | "schema"; tipo: string | null; schema: string; tabella: string | null; a_chi: string }[];
  possiede?: { oggetto: string; schema: string | null; tabella: string | null }[];
  predefiniti?: { proprietario: string; schema: string | null; tipo: string; suo: boolean; a_tutti: boolean; gestibile: boolean }[];
  schemi?: {
    schema: string; uso: boolean; crea: boolean; con_opzione: boolean; tutti_creano: boolean;
    crea_eff: boolean; opzione_eff: boolean; possiede_via: string | null;
  }[];
  database?: { nome: string; possiede_via: string | null; crea_eff: boolean; connette: boolean; crea: boolean; tutti_creano: boolean } | null;
  effettivi?: Effettivo[];
  altrove?: string[];
  membroDi?: string[];
  esistenti?: string[];
}
export interface Azione { sql: string; perche: string; oggetto: string | null }
export interface Piano { assente: boolean; azioni: Azione[]; avvisi: string[]; errori: string[] }
export interface Contratto { nome: string; versione: number; elenco: readonly string[] }
export interface ContrattoSalvato { disponibile: boolean; motivo?: string; riga?: { versione: number; elenco: string[] } | null }
export interface ContrattoEffettivo {
  versione: number; elenco: string[]; fonte: "codice" | "database"; scrivi: boolean; nota: string | null; avvisi: string[]; errori: string[];
}
export interface Opzioni { ruolo?: string; codice?: Contratto; forza?: boolean }
export declare const SCHEMI: readonly string[];
export declare const FORMATO: RegExp;
export declare const CONTRATTO: Readonly<Contratto>;
export declare function leggiStato(client: ClientMinimo, ruolo?: string, elenco?: readonly string[]): Promise<StatoPermessi>;
export declare function piano(stato: StatoPermessi, elenco?: readonly string[]): Piano;
export declare function leggiContrattoSalvato(client: ClientMinimo, nome?: string): Promise<ContrattoSalvato>;
export declare function contrattoEffettivo(codice: Contratto, salvato: ContrattoSalvato, opzioni?: { forza?: boolean }): ContrattoEffettivo;
export declare function eseguiAzioni(client: ClientMinimo, azioni: Azione[]): Promise<(Azione & { motivo: string })[]>;
export declare function allinea(client: ClientMinimo, opzioni?: Opzioni):
  Promise<{ assente: boolean; contratto: ContrattoEffettivo; fatte: Azione[]; avvisi: string[]; errori: string[] }>;
export declare function verifica(client: ClientMinimo, opzioni?: Opzioni):
  Promise<{ assente: boolean; contratto: ContrattoEffettivo; daFare: Azione[]; avvisi: string[]; errori: string[] }>;
