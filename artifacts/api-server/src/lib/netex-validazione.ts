/**
 * Il controllo di un NeTEx con lo schema del profilo italiano (tappa 6.2):
 * xmllint (libxml2-utils, nell'immagine dell'API e in CI), lanciato senza
 * shell, con il file in una cartella temporanea propria e un tempo massimo.
 * Senza xmllint il controllo non si fa, e lo si dice.
 *
 * Un file con le tariffe (FareFrame, livello 3, tappa 6.40) si controlla con
 * lo schema del livello 3, che comprende quelli del livello 1 (EPIP) e del 2;
 * gli altri con lo schema EPIP, come prima.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Lo schema EPIP pubblicato con il profilo italiano (assets/netex-epip). */
export const SCHEMA_EPIP = path.resolve(
  [process.cwd(), path.join(process.cwd(), "artifacts/api-server")]
    .map((d) => path.join(d, "assets/netex-epip/NeTEx_publication_EPIP.xsd"))
    .find((p) => existsSync(p)) ?? path.join(process.cwd(), "assets/netex-epip/NeTEx_publication_EPIP.xsd"),
);

/** Lo schema del livello 3, nella stessa cartella. */
export const SCHEMA_LIVELLO_3 = path.join(path.dirname(SCHEMA_EPIP), "NeTEx_publication_Lev3.xsd");

/** Lo schema con cui si controlla un file: il livello 3 se ha le tariffe. */
export const schemaPer = (xml: string): string => (xml.includes("<FareFrame ") ? SCHEMA_LIVELLO_3 : SCHEMA_EPIP);

export interface EsitoValidazione {
  stato: "valido" | "non_valido" | "senza_xmllint";
  /** al più 20 righe di xmllint, senza il percorso del file temporaneo */
  errori: string[];
}

const TEMPO_MS = 180_000;

export async function validaNetex(xml: string): Promise<EsitoValidazione> {
  const cartella = await mkdtemp(path.join(tmpdir(), "netex-"));
  const file = path.join(cartella, "netex.xml");
  try {
    await writeFile(file, xml, { encoding: "utf8", mode: 0o600 });
    return await new Promise<EsitoValidazione>((risolvi) => {
      execFile("xmllint", ["--noout", "--nonet", "--schema", schemaPer(xml), file],
        { timeout: TEMPO_MS, maxBuffer: 8 * 1024 * 1024 }, (err, _out, errOut) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") { risolvi({ stato: "senza_xmllint", errori: [] }); return; }
          const righe = String(errOut ?? "").split("\n").map((r) => r.replace(file, "netex.xml").trim())
            .filter((r) => r && !/ validates$/.test(r));
          if (!err) { risolvi({ stato: "valido", errori: [] }); return; }
          risolvi({ stato: "non_valido", errori: (righe.length ? righe : [String(err.message)]).slice(0, 20) });
        });
    });
  } finally {
    await rm(cartella, { recursive: true, force: true });
  }
}
