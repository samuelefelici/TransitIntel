/**
 * La maschera delle terre emerse per il globo della pagina di accesso
 * (src/lib/terra.ts): 1 grado, righe da nord a sud, strisce alternate mare e
 * terra in base 36. Si genera una volta sola, a mano, fuori dall'app:
 *   npm pack world-atlas@2.0.2 topojson-client@3.1.0 d3-geo@3.1.1 (in una cartella di lavoro)
 *   node genera-terra.mjs land-110m.json terra.txt
 * e il testo di terra.txt va in STRISCE. Natural Earth è di dominio pubblico.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";
import { geoContains } from "d3-geo";
const [ingresso, uscita] = process.argv.slice(2);
const topo = JSON.parse(readFileSync(ingresso, "utf8"));
const terra = feature(topo, topo.objects.land);
const righe = [];
let terreTot = 0;
for (let r = 0; r < 180; r++) {
  const nord = 89.5 - r;
  const corse = [];
  let stato = 0, lung = 0;
  for (let c = 0; c < 360; c++) {
    const est = -179.5 + c;
    const t = geoContains(terra, [est, nord]) ? 1 : 0;
    terreTot += t;
    if (t === stato) lung++;
    else { corse.push(lung); stato = t; lung = 1; }
  }
  corse.push(lung);
  righe.push(corse.map((n) => n.toString(36)).join("."));
}
writeFileSync(uscita, righe.join("|"));
console.log("celle di terra", terreTot, "lunghezza", righe.join("|").length);
