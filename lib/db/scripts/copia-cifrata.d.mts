import type { KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Transform } from "node:stream";

export declare const MAGIA: Buffer;
export declare const BIT_MINIMI: number;
export declare const HASH_VUOTO: string;
export declare const VARIABILI_S3: readonly string[];
export declare function chiavePubblica(testo: string | undefined): KeyObject;
export declare function chiavePrivata(testo: string, frase?: string): KeyObject;
export declare function impronta(chiave: KeyObject): Buffer;
export declare function cifratore(pubblica: KeyObject): Transform;
export declare function leggiIntestazione(primi: Buffer): { lunghezza: number; impronta: Buffer; busta: Buffer; iv: Buffer; testa: Buffer };
export declare function decifraFile(da: string, a: string, privata: KeyObject): Promise<void>;
export interface Conteggio { byte: number; sha256: string }
export declare function contatore(): Transform & { risultato(): Conteggio };
export declare function firma(o: {
  metodo: string; url: string; intestazioni?: Record<string, string>; hashCorpo: string;
  accesso: string; segreto: string; regione: string; servizio?: string; quando?: Date;
}): { percorso: string; intestazioni: Record<string, string>; canonica: string; firma: string };
export interface ConfigS3 {
  endpoint: string; regione: string; bucket: string; prefisso: string; stile: "percorso" | "virtuale";
  accesso: string; segreto: string;
}
export declare function configS3(env?: Record<string, string | undefined>): { mancano: string[]; errore?: string; config?: ConfigS3 };
export declare function urlOggetto(cfg: ConfigS3, chiave?: string, query?: string): string;
export declare function carica(cfg: ConfigS3, chiave: string, file: string, c: Conteggio): Promise<void>;
export declare function scarica(cfg: ConfigS3, chiave: string): Promise<IncomingMessage>;
export declare function scaricaInFile(cfg: ConfigS3, chiave: string, file: string): Promise<Conteggio>;
export declare function elenca(cfg: ConfigS3, prefisso?: string, massimo?: number): Promise<{ chiave: string; byte: number; data: string | null }[]>;
export declare function senzaSegreti(testo: unknown, segreti?: readonly (string | undefined)[]): string;
