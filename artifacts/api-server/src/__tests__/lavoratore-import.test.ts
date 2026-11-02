/* Il lavoratore (src/lavoratore.ts) non deve tirarsi dietro l'API: niente
 * app.ts, rotte, lib/auth.ts (che senza JWT_SECRET in produzione lancia
 * un'eccezione e all'import prepara gli utenti), lib/planning-studio.ts (che
 * all'import avvia dei timer). Lo si controlla sul grafo vero di esbuild. */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("il lavoratore non importa l'API", () => {
  it("nel suo grafo non ci sono app, rotte, auth né planning-studio", async () => {
    const r = await build({
      entryPoints: [path.join(API, "src/lavoratore.ts")],
      bundle: true, platform: "node", format: "cjs", write: false, metafile: true,
      packages: "external", logLevel: "silent",
    });
    const moduli = Object.keys(r.metafile!.inputs).map(m => m.replace(/\\/g, "/"));
    const vietati = moduli.filter(m =>
      /src\/app\.ts$/.test(m) || /src\/routes\//.test(m) || /src\/lib\/auth\.ts$/.test(m) ||
      /src\/lib\/planning-studio\.ts$/.test(m) || /src\/middlewares\//.test(m) || /src\/lib\/mfa-cifratura\.ts$/.test(m));
    expect(vietati).toEqual([]);
    // e c'è quello che serve
    expect(moduli.some(m => m.endsWith("src/lib/lavori/esecutore.ts"))).toBe(true);
    expect(moduli.some(m => m.endsWith("src/lib/guardia-schema.ts"))).toBe(true);
  });
});
