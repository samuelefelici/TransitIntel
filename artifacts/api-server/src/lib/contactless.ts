/**
 * Il pagamento con carta a bordo (tappa 6.38, migrazione 0058): le regole.
 *
 * Sugli autobus dove il sistema di bigliettazione lo permette si sale
 * avvicinando al validatore una carta bancaria contactless, o uno smartphone
 * o un orologio con un portafoglio digitale. Non è un titolo che si compra
 * prima: il sistema conta i tap e, a fine giornata, addebita il prezzo
 * secondo le regole di chi fissa le tariffe (la Regione per l'extraurbano, il
 * Comune per l'urbano):
 *   - per tipo di rete (urbano, extraurbano): il prezzo del primo viaggio,
 *     valido un certo numero di minuti; quello del secondo, dopo la validità;
 *     quello del terzo; un massimale nella finestra di ore dal primo tap;
 *   - un massimale unico se nella finestra si usano tutti e due i tipi;
 *   - le reti dove il sistema è attivo.
 *
 * Nel GTFS (lib/gtfs-tariffe.ts) entrano il prezzo del primo viaggio e la
 * validità: i viaggi dentro la validità non si pagano. Il secondo e il terzo
 * prezzo e i massimali nel GTFS non si possono scrivere.
 */
import { z } from "zod";

export const TIPI_CONTACTLESS = ["urbano", "extraurbano"] as const;
export type TipoContactless = (typeof TIPI_CONTACTLESS)[number];

export interface TariffaContactless {
  tipo: TipoContactless;
  primo: number;
  secondo: number;
  terzo: number;
  validitaMinuti: number;
  massimale: number;
}

export interface Contactless {
  /** il massimale se nella finestra si usano urbano ed extraurbano; null se non c'è */
  massimaleUnico: number | null;
  finestraOre: number;
  /** il supporto con cui si paga (supporti_catalogo): nel GTFS, il fare_media dei titoli */
  supporto: string | null;
  tariffe: TariffaContactless[];
  /** le reti dove si può pagare così */
  reti: string[];
}

export const CONTACTLESS_VUOTO: Contactless = Object.freeze({ massimaleUnico: null, finestraOre: 24, supporto: null, tariffe: [], reti: [] }) as Contactless;

/* gli stessi limiti dei vincoli delle tabelle */
export const MASSIMO_PREZZO = 999.99;
export const MASSIMO_VALIDITA = 1440;
export const MASSIMO_FINESTRA = 72;
export const MASSIMO_RETI = 200;

const decimali = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
const euro = (cosa: string, minimo: "positivo" | "zero") =>
  (minimo === "positivo" ? z.number().positive(`${cosa}: maggiore di zero`) : z.number().min(0, `${cosa}: da zero in su`))
    .max(MASSIMO_PREZZO, `${cosa}: al più ${MASSIMO_PREZZO.toLocaleString("it-IT")} €`)
    .refine(decimali, `${cosa}: al più due decimali`);

const Tariffa = z.object({
  tipo: z.enum(TIPI_CONTACTLESS, { message: "tipo: urbano o extraurbano" }),
  primo: euro("primo viaggio", "positivo"),
  secondo: euro("secondo viaggio", "zero"),
  terzo: euro("terzo viaggio", "zero"),
  validitaMinuti: z.number().int("validità: un numero intero di minuti").min(1, "validità: almeno un minuto").max(MASSIMO_VALIDITA, "validità: al più un giorno (1440 minuti)"),
  massimale: euro("massimale", "positivo"),
}).strict();

/** Quello che l'amministratore salva: tutto insieme. */
export const DatiContactless = z.object({
  massimaleUnico: euro("massimale unico", "positivo").nullable().default(null),
  finestraOre: z.number().int("finestra: un numero intero di ore").min(1, "finestra: almeno un'ora").max(MASSIMO_FINESTRA, `finestra: al più ${MASSIMO_FINESTRA} ore`),
  supporto: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "supporto: scegli un supporto dell'elenco").nullable().default(null),
  tariffe: z.array(Tariffa).max(TIPI_CONTACTLESS.length, "al più una tariffa per tipo di rete"),
  reti: z.array(z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, "reti: scegli le reti dell'elenco")).max(MASSIMO_RETI, `al più ${MASSIMO_RETI} reti`),
}).strict();

/** Il primo messaggio di ogni campo, in chiaro. */
export function erroreContactless(e: z.ZodError): string {
  const estranei = e.issues.filter((i) => i.code === "unrecognized_keys").flatMap((i: any) => (i.keys as string[]).map((k) => String(k).slice(0, 40)));
  if (estranei.length) return `Campo non previsto: ${estranei.slice(0, 5).join(", ")}`;
  const visti = new Set<string>();
  const messaggi = e.issues.filter((i) => {
    const campo = i.path.join(".");
    if (visti.has(campo)) return false;
    visti.add(campo);
    return true;
  }).slice(0, 4).map((i) => {
    const tariffa = i.path[0] === "tariffe" && typeof i.path[1] === "number" ? `tariffa n. ${i.path[1] + 1}: ` : "";
    return `${tariffa}${i.message}`;
  });
  return `Dati non validi: ${messaggi.join("; ")}`;
}

const NOME_TIPO: Record<TipoContactless, string> = { urbano: "urbana", extraurbano: "extraurbana" };
const soldi = (n: number) => `${n.toFixed(2).replace(".", ",")} €`;

/**
 * Quello che non torna fra le regole, o un elenco vuoto. `reteDi` dà il tipo
 * e il nome di una rete dell'azienda, o null se non c'è.
 */
export function erroriContactless(c: Contactless, reteDi: (rete: string) => { tipo: TipoContactless; nome: string } | null): string[] {
  const errori: string[] = [];
  const perTipo = new Map<TipoContactless, TariffaContactless>();
  for (const t of c.tariffe) {
    if (perTipo.has(t.tipo)) errori.push(`C'è due volte la tariffa ${NOME_TIPO[t.tipo]}`);
    perTipo.set(t.tipo, t);
    if (t.massimale < t.primo) errori.push(`Tariffa ${NOME_TIPO[t.tipo]}: il massimale (${soldi(t.massimale)}) è più basso del primo viaggio (${soldi(t.primo)})`);
  }
  if (c.massimaleUnico !== null && c.tariffe.length) {
    const alto = c.tariffe.reduce((m, t) => (t.massimale > m.massimale ? t : m));
    if (c.massimaleUnico < alto.massimale) {
      errori.push(`Il massimale unico (${soldi(c.massimaleUnico)}) è più basso del massimale della tariffa ${NOME_TIPO[alto.tipo]} (${soldi(alto.massimale)}): chi usa tutti e due i tipi pagherebbe meno di chi ne usa uno`);
    }
  }
  for (const r of c.reti) {
    const rete = reteDi(r);
    if (!rete) { errori.push(`La rete «${r}» non c'è più: ricarica la pagina`); continue; }
    if (!perTipo.has(rete.tipo)) errori.push(`La carta è attiva su «${rete.nome}», ma manca la tariffa ${NOME_TIPO[rete.tipo]}`);
  }
  return errori;
}

/** Le regole come si salvano: prezzi a due decimali, reti senza doppioni e in ordine, tariffe nell'ordine dei tipi. */
export function contactlessPulito(d: z.infer<typeof DatiContactless>): Contactless {
  const tondo = (n: number) => Math.round(n * 100) / 100;
  return {
    massimaleUnico: d.massimaleUnico === null ? null : tondo(d.massimaleUnico),
    finestraOre: d.finestraOre,
    supporto: d.supporto,
    tariffe: [...d.tariffe]
      .sort((a, b) => TIPI_CONTACTLESS.indexOf(a.tipo) - TIPI_CONTACTLESS.indexOf(b.tipo))
      .map((t) => ({ tipo: t.tipo, primo: tondo(t.primo), secondo: tondo(t.secondo), terzo: tondo(t.terzo), validitaMinuti: t.validitaMinuti, massimale: tondo(t.massimale) })),
    reti: [...new Set(d.reti)].sort(),
  };
}

/** Se il pagamento con carta vale da qualche parte. */
export const contactlessAttivo = (c: Contactless | null): c is Contactless => !!c && c.reti.length > 0 && c.tariffe.length > 0;
