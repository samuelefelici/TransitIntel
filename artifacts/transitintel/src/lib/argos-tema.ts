/**
 * Il tema della console di Argos (pagina /argos), chiaro o scuro, per chi sta
 * dentro la pagina e non vede il suo pulsante: lo studio a schermo intero.
 */
import { createContext } from "react";

export type TemaArgos = "chiaro" | "scuro";
export const TemaArgosContesto = createContext<{ tema: TemaArgos; cambia: () => void } | null>(null);
