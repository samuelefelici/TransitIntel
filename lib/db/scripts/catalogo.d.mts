export type Catalogo = Record<string, Record<string, unknown>>;
export interface Differenza { dove: string; chiave: string; a: unknown; b: unknown }
/** Una riga letta dal catalogo di sistema; `estensione`: la relazione (o la tabella dell'oggetto) è di un'estensione. */
export interface RigaLetta { schema: string; tabella: string; estensione?: boolean; [campo: string]: unknown }
export interface RigheLette { colonne?: RigaLetta[]; vincoli?: RigaLetta[]; indici?: RigaLetta[]; viste?: RigaLetta[]; sequenze?: RigaLetta[] }
export declare function leggiCatalogo(client: unknown): Promise<Catalogo>;
export declare function catalogoDalleRighe(righe: RigheLette): Catalogo;
export declare function confronta(a: Catalogo, b: Catalogo): Differenza[];
export declare function descriviDifferenza(d: Differenza): string;
