export declare const GIRI_SCRAM: 4096;
export declare function nuovaPassword(): string;
export declare function improntaScram(password: string, sale?: Buffer, giri?: number): string;
export declare function urlDellApp(urlDelMigratore: string, utente: string, password: string): string;
