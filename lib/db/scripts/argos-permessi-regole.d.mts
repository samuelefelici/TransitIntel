export interface ClientMinimo { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface StatoPermessi {
  ruolo: string;
  esiste: boolean;
  superutente?: boolean;
  relazioni?: { nome: string; tipo: string; privilegio: string; con_opzione: boolean; dato_da: string | null }[];
  colonne?: string[];
  concessiDaLui?: { nome: string; a_chi: string }[];
  possiede?: string[];
  aTutti?: string[];
  predefiniti?: { proprietario: string; schema: string | null; tipo: string; gestibile: boolean }[];
  schemi?: { schema: string; uso: boolean; crea: boolean; con_opzione: boolean; tutti_creano: boolean }[];
  membroDi?: string[];
  esistenti?: string[];
}
export interface Azione { sql: string; perche: string }
export interface Piano { assente: boolean; azioni: Azione[]; avvisi: string[]; errori: string[] }
export declare const SCHEMI: readonly string[];
export declare function leggiStato(client: ClientMinimo, ruolo?: string, contratto?: readonly string[]): Promise<StatoPermessi>;
export declare function piano(stato: StatoPermessi, contratto?: readonly string[]): Piano;
export declare function allinea(client: ClientMinimo, ruolo?: string, contratto?: readonly string[]):
  Promise<{ assente: boolean; fatte: Azione[]; avvisi: string[]; errori: string[] }>;
export declare function verifica(client: ClientMinimo, ruolo?: string, contratto?: readonly string[]):
  Promise<{ assente: boolean; daFare: Azione[]; avvisi: string[]; errori: string[] }>;
