/**
 * Il tema chiaro (tappa 7.32): le scale di colore di Tailwind rimappate.
 *
 * Le pagine sono scritte per il fondo scuro con le classi di Tailwind
 * (bg-slate-900, text-slate-400, text-cyan-300, bg-white/5, text-white…).
 * Riscriverle tutte vorrebbe dire migliaia di modifiche. Tailwind 4 scrive
 * ogni classe con una variabile (--color-slate-900…): nel tema chiaro qui le
 * variabili cambiano valore, e le pagine cambiano da sole.
 *
 * - Grigi (slate, gray, zinc, neutral, stone): scala rovesciata, 50 ↔ 950.
 * - Tinte: le chiare (100-400, testo sul fondo scuro) diventano scure, le
 *   scure (700-950, fondi tinti) diventano chiare; 500 e 600 restano.
 * - white e black si scambiano: il testo bianco diventa scuro, i veli
 *   bianchi (bg-white/5) diventano veli scuri.
 * - Il testo nelle tonalità scure di una tinta (text-cyan-700…) resta scuro.
 * - Sui fondi pieni e saturi (bg-blue-600, bg-primary, un colore di linea
 *   scritto nello stile) il testo bianco resta bianco.
 * - Le parti già disegnate chiare (la mappa orari pubblica, i QR) hanno la
 *   classe .colori-originali, che rimette i colori veri.
 *
 * Uso: node scripts/genera-tema-chiaro.mjs > src/styles/tema-chiaro-scale.css
 * Un test (src/lib/tema.test.ts) controlla che il file sia aggiornato.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const NEUTRI = ["slate", "gray", "zinc", "neutral", "stone"];
export const TINTE = ["red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"];
const ROVESCIA = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 600: 400, 700: 300, 800: 200, 900: 100, 950: 50 };
const TINTA = { 50: 950, 100: 900, 200: 800, 300: 800, 400: 700, 700: 200, 800: 100, 900: 100, 950: 50 };

/** Le variabili di colore del tema di Tailwind: { slate: { 50: "oklch(…)" … } … } */
export function coloriDiTailwind(themeCss) {
  const val = {};
  for (const m of themeCss.matchAll(/--color-([a-z]+)-(\d+):\s*([^;]+);/g)) (val[m[1]] ??= {})[m[2]] = m[3].trim();
  return val;
}

/** Il CSS del tema chiaro, dal theme.css di Tailwind. */
export function cssTemaChiaro(themeCss) {
  const val = coloriDiTailwind(themeCss);
  const righe = [];
  for (const n of NEUTRI) for (const [da, a] of Object.entries(ROVESCIA)) righe.push(`  --color-${n}-${da}: ${val[n][a]};`);
  for (const t of TINTE) for (const [da, a] of Object.entries(TINTA)) righe.push(`  --color-${t}-${da}: ${val[t][a]};`);
  let out = "/* Generato da scripts/genera-tema-chiaro.mjs: non modificare a mano. */\n";
  out += `html.tema-chiaro {\n  --color-white: ${val.slate[900]};\n  --color-black: #ffffff;\n${righe.join("\n")}\n}\n`;
  const testo = [];
  for (const t of TINTE) for (const s of [700, 800, 900, 950]) testo.push(`html.tema-chiaro [class*="text-${t}-${s}"] { --color-${t}-${s}: ${val[t][s]}; }`);
  out += `\n/* il testo nelle tonalità scure di una tinta resta scuro, leggibile sul chiaro */\n${testo.join("\n")}\n`;
  const pieni = [".bg-primary", ".bg-destructive", ".bg-accent", "[style*=\"background\"]:not([style*=\"gradient\"])"];
  for (const t of TINTE) for (const s of [500, 600]) {
    pieni.push(`[class~="bg-${t}-${s}"]`, `[class~="from-${t}-${s}"]`);
    for (const o of [70, 75, 80, 85, 90, 95]) pieni.push(`[class~="bg-${t}-${s}/${o}"]`);
  }
  out += `\n/* sui fondi pieni e saturi il testo bianco resta bianco */\nhtml.tema-chiaro :is(\n  ${pieni.join(",\n  ")}\n) { --color-white: #ffffff; }\n`;
  // le parti già disegnate chiare (la mappa orari pubblica, i QR, le anteprime
  // di stampa) tengono i colori veri: la classe .colori-originali li rimette
  const veri = [`  --color-white: #fff;`, `  --color-black: #000;`];
  for (const n of NEUTRI) for (const s of Object.keys(ROVESCIA)) veri.push(`  --color-${n}-${s}: ${val[n][s]};`);
  for (const t of TINTE) for (const s of Object.keys(TINTA)) veri.push(`  --color-${t}-${s}: ${val[t][s]};`);
  out += `\n/* le parti disegnate chiare di loro tengono i colori veri */\nhtml.tema-chiaro .colori-originali {\n${veri.join("\n")}\n}\n`;
  return out;
}

export function themeCssDiTailwind() {
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve("tailwindcss/theme.css"), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(cssTemaChiaro(themeCssDiTailwind()));
