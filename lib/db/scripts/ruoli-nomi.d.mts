export declare const PROPRIETARIO: "cerbero_owner";
export declare const APP: "cerbero_app";
export declare const REGISTRO: "cerbero_registro";
export declare const SCHEMA_REGISTRO: "registro";
export declare const ESCLUSE: readonly string[];
export declare const EVENTO_DDL: "cerbero_ddl_dell_app";
export declare const EVENTO_DDL_FINE: "cerbero_ddl_dell_app_fine";
export declare const FUNZIONE_EVENTO_DDL: "cerbero_migrazioni.ddl_dell_app()";
export declare function elencoDalCatalogo(catalogo: {
  tabelle?: Record<string, unknown>; viste?: Record<string, unknown>; sequenze?: Record<string, unknown>;
}): string[];
