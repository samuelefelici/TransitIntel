import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sceltaSeguente, sceltaValida, stileMappa, temaRisolto } from "./tema";
import { coloriDiTailwind, cssTemaChiaro, themeCssDiTailwind } from "../../scripts/genera-tema-chiaro.mjs";

describe("il tema scelto", () => {
  it("una scelta strana o assente resta sullo scuro di sempre", () => {
    expect(sceltaValida(null)).toBe("scuro");
    expect(sceltaValida("blu")).toBe("scuro");
    expect(sceltaValida("chiaro")).toBe("chiaro");
    expect(sceltaValida("sistema")).toBe("sistema");
  });

  it("«come il sistema» segue il sistema; le altre due no", () => {
    expect(temaRisolto("sistema", true)).toBe("chiaro");
    expect(temaRisolto("sistema", false)).toBe("scuro");
    expect(temaRisolto("scuro", true)).toBe("scuro");
    expect(temaRisolto("chiaro", false)).toBe("chiaro");
  });

  it("il pulsante del menu compresso gira fra le tre scelte", () => {
    expect(sceltaSeguente("scuro")).toBe("chiaro");
    expect(sceltaSeguente("chiaro")).toBe("sistema");
    expect(sceltaSeguente("sistema")).toBe("scuro");
  });

  it("la mappa di base: i fondi scuri hanno il gemello chiaro, gli altri restano", () => {
    expect(stileMappa("mapbox://styles/mapbox/dark-v11", "chiaro")).toBe("mapbox://styles/mapbox/light-v11");
    expect(stileMappa("mapbox://styles/mapbox/dark-v11", "scuro")).toBe("mapbox://styles/mapbox/dark-v11");
    expect(stileMappa("mapbox://styles/mapbox/navigation-night-v1", "chiaro")).toBe("mapbox://styles/mapbox/navigation-day-v1");
    expect(stileMappa("mapbox://styles/mapbox/light-v11", "scuro")).toBe("mapbox://styles/mapbox/dark-v11");
    expect(stileMappa("mapbox://styles/mapbox/satellite-streets-v12", "chiaro")).toBe("mapbox://styles/mapbox/satellite-streets-v12");
  });
});

describe("le scale di Tailwind nel tema chiaro", () => {
  const theme = themeCssDiTailwind();
  const css = cssTemaChiaro(theme);
  const veri = coloriDiTailwind(theme);

  it("il file generato è aggiornato (node scripts/genera-tema-chiaro.mjs > src/styles/tema-chiaro-scale.css)", () => {
    const suDisco = readFileSync(path.resolve(__dirname, "../styles/tema-chiaro-scale.css"), "utf8");
    expect(suDisco).toBe(css);
  });

  it("i grigi si rovesciano: il fondo scuro diventa chiaro e il testo chiaro diventa scuro", () => {
    expect(css).toContain(`--color-slate-900: ${veri.slate[100]};`);
    expect(css).toContain(`--color-slate-950: ${veri.slate[50]};`);
    expect(css).toContain(`--color-slate-400: ${veri.slate[600]};`);
    expect(css).toContain(`--color-zinc-200: ${veri.zinc[800]};`);
  });

  it("le tinte chiare del testo si scuriscono, quelle scure dei fondi si schiariscono, 500 e 600 restano", () => {
    expect(css).toContain(`--color-cyan-400: ${veri.cyan[700]};`);
    expect(css).toContain(`--color-cyan-300: ${veri.cyan[800]};`);
    expect(css).toContain(`--color-emerald-900: ${veri.emerald[100]};`);
    expect(css).not.toMatch(/html\.tema-chiaro \{[^}]*--color-cyan-500:/);
    expect(css).not.toMatch(/html\.tema-chiaro \{[^}]*--color-blue-600:/);
  });

  it("il bianco diventa scuro, ma resta bianco sui fondi pieni e nelle parti disegnate chiare", () => {
    expect(css).toContain(`--color-white: ${veri.slate[900]};`);
    expect(css).toMatch(/\.bg-primary,[\s\S]*\[class~="bg-blue-600"\][\s\S]*\) \{ --color-white: #ffffff; \}/);
    expect(css).toMatch(/\.colori-originali \{\n  --color-white: #fff;/);
    expect(css).toContain(`html.tema-chiaro [class*="text-cyan-700"] { --color-cyan-700: ${veri.cyan[700]}; }`);
  });
});
