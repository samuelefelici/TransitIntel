export type Catalogo = Record<string, Record<string, unknown>>;
export interface Differenza { dove: string; chiave: string; a: unknown; b: unknown }
export declare function leggiCatalogo(client: unknown): Promise<Catalogo>;
export declare function confronta(a: Catalogo, b: Catalogo): Differenza[];
