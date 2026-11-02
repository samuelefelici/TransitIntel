/**
 * Il segnale d'arresto del processo (SIGTERM al deploy). Chi tiene aperte
 * risposte lunghe (lo stream dei lavori) lo ascolta e chiude: il client
 * riprova e arriva al container nuovo.
 */
export const arresto = new AbortController();
