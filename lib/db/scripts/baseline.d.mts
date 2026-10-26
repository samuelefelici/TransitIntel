export declare const ESCLUSE: string[];
export interface BloccoDump { nome: string; tipo: string; schema: string; sql: string }
export declare function blocchiDelDump(dump: string): BloccoDump[];
export declare function guardia(b: BloccoDump): string | null;
export declare function generaBaseline(dump: string, opzioni?: { fonte?: string }): string;
