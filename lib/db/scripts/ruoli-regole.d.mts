export interface ClientMinimo { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export declare const PROPRIETARIO: "cerbero_owner";
export declare const APP: "cerbero_app";
export declare const SCHEMI_DATI: readonly string[];
export declare const ESCLUSE: readonly string[];
export declare const FUNZIONI_FLEETCARE: readonly string[];
export declare const DA_LEGGERE: readonly string[];
export declare const COMANDI_DELL_APP: readonly string[];
export declare const EVENTO_DDL: "cerbero_ddl_dell_app";
export declare const FUNZIONE_EVENTO_DDL: "cerbero_migrazioni.ddl_dell_app()";
export declare const CORPO_EVENTO_DDL: string;
export declare const LETTORI: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
export interface Ruolo {
  nome: string; login: boolean; superutente: boolean; bypassrls: boolean; crearuoli: boolean; creadb: boolean;
  replica: boolean; col_ruolo: boolean;
}
export interface Relazione {
  schema: string; nome: string; tipo: string; proprietario: string; di_superutente: boolean;
  estensione: boolean; legata: boolean; basi: { nome: string; proprietario: string }[];
}
export interface StatoRuoli {
  io: { utente: string; sessione: string; database: string; superutente: boolean };
  ruoli: Ruolo[];
  appartenenze: { ruolo: string; membro: string; admin: boolean; eredita: boolean; imposta: boolean }[];
  database: { connette: boolean | null; temporanee: boolean | null };
  schemi: { nome: string; esiste: boolean; uso: boolean | null; crea: boolean | null }[];
  lettura: { voce: string; esiste: boolean; legge: boolean | null }[];
  relazioni: Relazione[];
  fleetcare: { firma: string; esiste: boolean; chiama: boolean | null }[];
  lettori?: { ruolo: string; tabella: string; colonna: string; uso: boolean; legge: boolean }[];
  fughe?: { funzione: string; proprietario: string }[];
  evento?: {
    funzione: boolean; corpo: string | null; di_superutente: boolean | null; di_tutti: boolean | null;
    acceso: string | null; momento: string | null; sua: boolean | null;
  };
}
export interface AzioneRuoli { fase: 1 | 2 | 3; sql: string; perche: string; oggetto: string | null }
export interface PianoRuoli { azioni: AzioneRuoli[]; attese: string[]; avvisi: string[]; errori: string[] }
export declare function elencoDalCatalogo(catalogo: { tabelle?: object; viste?: object; sequenze?: object }): string[];
export declare function leggiStato(client: ClientMinimo, elenco: readonly string[]): Promise<StatoRuoli>;
export declare function piano(stato: StatoRuoli): PianoRuoli;
export declare function allinea(
  client: ClientMinimo, elenco: readonly string[],
  opzioni?: { tettoMs?: number; lockMs?: number; adesso?: () => number },
): Promise<{
  fatte: AzioneRuoli[]; occupate: AzioneRuoli[]; rimandate: AzioneRuoli[];
  avvisi: string[]; errori: string[]; daFare: AzioneRuoli[];
}>;
export declare function verifica(client: ClientMinimo, elenco: readonly string[]): Promise<{
  daFare: AzioneRuoli[]; attese: string[]; avvisi: string[]; errori: string[];
}>;
