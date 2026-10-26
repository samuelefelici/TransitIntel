export declare const TRACCIAMENTO: Readonly<{ migrationsSchema: string; migrationsTable: string }>;
export declare const CHIAVE_LUCCHETTO: number;
export interface VoceDiario { idx: number; version: string; when: number; tag: string; breakpoints: boolean; impronta: string }
export interface RigaApplicata { hash: string; created_at: number | string }
export declare function leggiDiario(cartella: string): VoceDiario[];
export declare function controllaApplicate(diario: VoceDiario[], applicate: RigaApplicata[]): { errori: string[]; sconosciute: number[] };
export declare function daApplicare(diario: VoceDiario[], applicate: RigaApplicata[]): VoceDiario[];
export declare function ritentabile(err: unknown): boolean;
export declare function descriviErrore(err: unknown): { motivo: string; query: string };
