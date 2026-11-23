/* Sanificazione dell'SVG di Mermaid (lib/sanifica-svg.ts).
 *
 * L'ambiente dei test è node: il DOM lo dà una finestra jsdom creata qui, il
 * DOM che DOMPurify raccomanda fuori dal browser. Le fixture in fixture-mermaid/
 * sono SVG veri di mermaid 12.3.0, resi in Chromium con la configurazione di
 * components/argos/Mermaid.tsx (theme "dark", securityLevel "strict") e con
 * etichette inventate; attacco-strict.svg è quello che mermaid stesso produce
 * da un'etichetta con <img src=x onerror=…> e da link javascript:. Gli altri
 * attacchi sono SVG scritti a mano: simulano un Mermaid che un giorno lasci
 * passare qualcosa. */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { creaSanificatoreSvg, TAG_TESTO_ETICHETTE } from "./sanifica-svg";

const finestra = new JSDOM("").window;
const sanifica = creaSanificatoreSvg(finestra);
const fixture = (nome: string) => readFileSync(new URL(`./fixture-mermaid/${nome}`, import.meta.url), "utf8");

const NS_HTML = "http://www.w3.org/1999/xhtml";
const NS_SVG = "http://www.w3.org/2000/svg";
const MAI = new Set(["script", "img", "image", "feimage", "iframe", "object", "embed", "animate", "set", "use", "form", "input", "textarea", "link", "meta", "base"]);

/** Rilegge l'HTML come fa il browser con innerHTML (anche React passa da lì) e
 *  ne elenca i problemi: così si vede anche un HTML che cambia a ogni lettura
 *  (mXSS), non solo il testo prodotto. */
function problemi(html: string): string[] {
  const contenitore = finestra.document.createElement("div");
  contenitore.innerHTML = html; // scan-ok: finestra jsdom dei test, rilegge il risultato come il browser
  const trovati: string[] = [];
  for (const el of contenitore.querySelectorAll("*")) {
    const tag = el.localName.toLowerCase();
    if (MAI.has(tag)) trovati.push(`elemento <${tag}>`);
    if (tag === "style" && el.namespaceURI !== NS_SVG) trovati.push("<style> fuori dall'SVG");
    for (const attr of el.getAttributeNames()) {
      if (/^on/i.test(attr)) trovati.push(`handler ${attr} su <${tag}>`);
      const valore = (el.getAttribute(attr) ?? "").replace(/[\s\u0000-\u001f]/g, "");
      if (/javascript:|vbscript:|data:text\/html/i.test(valore)) trovati.push(`URL pericoloso in ${attr} su <${tag}>`);
    }
    const etichetta = el.parentElement?.closest("foreignObject, foreignobject");
    if (etichetta) {
      if (el.namespaceURI !== NS_HTML) trovati.push(`<${tag}> non HTML dentro un'etichetta`);
      else if (!TAG_TESTO_ETICHETTE.includes(tag)) trovati.push(`<${tag}> dentro un'etichetta`);
    }
  }
  return trovati;
}

/** Un nodo con un'etichetta HTML, come lo scrive Mermaid. */
const conEtichetta = (html: string) =>
  `<svg xmlns="${NS_SVG}" viewBox="0 0 120 40"><g class="node"><rect width="120" height="40"></rect>` +
  `<foreignObject width="120" height="24"><div xmlns="${NS_HTML}" style="display: table-cell;">` +
  `<span class="nodeLabel"><p>${html}</p></span></div></foreignObject></g></svg>`;

/** Il parser di jsdom (parse5) scrive <feDropShadow> tutto minuscolo, anche
 *  senza sanificare; quello del browser no. È l'unica differenza dalla
 *  fixture: si rimette il nome giusto e il resto deve restare identico. */
const comeNelBrowser = (html: string) => html.replaceAll("fedropshadow", "feDropShadow");

/** Il testo che si legge nel risultato. */
const testo = (html: string) => {
  const contenitore = finestra.document.createElement("div");
  contenitore.innerHTML = html; // scan-ok: finestra jsdom dei test, rilegge il risultato come il browser
  return contenitore.textContent ?? "";
};

describe("diagrammi normali: restano uguali", () => {
  it("flowchart con etichette HTML in foreignObject: identico, etichette comprese", () => {
    const svg = fixture("flowchart.svg");
    const pulito = sanifica(svg);
    expect(comeNelBrowser(pulito)).toBe(svg);
    expect(pulito.match(/<foreignObject/g)?.length).toBeGreaterThan(5);
    for (const etichetta of ["Deposito Nord", "uscita 05:10", "Linea 1", "Centro", "Scambio?", "Capolinea & ritorno", "Rete urbana"]) {
      expect(testo(pulito)).toContain(etichetta);
    }
    expect(pulito).toContain("<strong>Piazza</strong>");
    expect(problemi(pulito)).toEqual([]);
  });

  it("diagramma di sequenza (testo SVG, nessun foreignObject): identico", () => {
    const svg = fixture("sequenza.svg");
    const pulito = sanifica(svg);
    expect(comeNelBrowser(pulito)).toBe(svg);
    expect(testo(pulito)).toContain("Quanti turni domani?");
    expect(problemi(pulito)).toEqual([]);
  });

  it("la formattazione di testo ammessa nelle etichette resta com'è", () => {
    const svg = conEtichetta("<b>Linea</b> <strong>1</strong><br><i>feriale</i> <em>estivo</em>");
    expect(sanifica(svg)).toBe(svg);
  });
});

describe("attacchi nelle etichette: non arrivano al DOM", () => {
  it("quello che mermaid in strict lascia passare (<img> in un'etichetta) qui sparisce", () => {
    const svg = fixture("attacco-strict.svg");
    expect(svg).toMatch(/<img src="x"/); // la prova: mermaid da solo non basta
    const pulito = sanifica(svg);
    expect(pulito).not.toMatch(/<img/i);
    expect(pulito).not.toMatch(/onerror|javascript:/i);
    expect(testo(pulito)).toContain("clic");
    expect(testo(pulito)).toContain("ok");
    expect(problemi(pulito)).toEqual([]);
  });

  it("<img src=x onerror=…>: via l'immagine, il testo intorno resta", () => {
    const pulito = sanifica(conEtichetta("Deposito <img src=x onerror=alert(1)> Nord"));
    expect(pulito).not.toMatch(/<img|onerror|alert/i);
    expect(testo(pulito)).toContain("Deposito");
    expect(testo(pulito)).toContain("Nord");
    expect(problemi(pulito)).toEqual([]);
  });

  it("link javascript: (e ogni link) in un'etichetta diventa il suo testo", () => {
    const pulito = sanifica(conEtichetta('<a href="javascript:alert(1)">clic</a> e <a href="https://esempio.invalid/">sito</a>'));
    expect(pulito).not.toMatch(/<a\b|href|javascript:/i);
    expect(testo(pulito)).toContain("clic e sito");
    expect(problemi(pulito)).toEqual([]);
  });

  it("handler on* sui tag ammessi: il tag resta, l'handler no", () => {
    const pulito = sanifica(conEtichetta('<span onclick="alert(1)" onmouseover="alert(2)">Linea</span>'));
    expect(pulito).toContain("<span>Linea</span>");
    expect(pulito).not.toMatch(/onclick|onmouseover|alert/i);
  });

  it("tag non ammessi: diventano testo; script, style e iframe spariscono col contenuto", () => {
    const pulito = sanifica(conEtichetta(
      'H<sub>2</sub>O <script>alert(1)</script><style>*{display:none}</style>' +
      '<iframe srcdoc="<script>alert(2)</script>"></iframe><form action="javascript:alert(3)"><input autofocus onfocus=alert(4)></form>fine',
    ));
    expect(testo(pulito)).toContain("H2O");
    expect(testo(pulito)).toContain("fine");
    expect(pulito).not.toMatch(/<sub|<script|<style|<iframe|<form|<input|alert|display:none/i);
    expect(problemi(pulito)).toEqual([]);
  });

  it("un SVG annidato in un'etichetta si toglie", () => {
    const pulito = sanifica(conEtichetta('Linea<svg><a href="https://esempio.invalid/"><text>x</text></a></svg>'));
    expect(pulito.match(/<svg/g)).toHaveLength(1);
    expect(pulito).not.toContain("esempio.invalid");
    expect(problemi(pulito)).toEqual([]);
  });
});

describe("attacchi nell'SVG: non arrivano al DOM", () => {
  it("handler on* sugli elementi SVG", () => {
    const pulito = sanifica(`<svg xmlns="${NS_SVG}" onload="alert(1)"><rect onclick="alert(2)" width="10" height="10"></rect></svg>`);
    expect(pulito).toContain("<rect");
    expect(pulito).not.toMatch(/onload|onclick|alert/i);
  });

  it("link javascript: sugli <a> dell'SVG, anche mascherati", () => {
    const pulito = sanifica(
      `<svg xmlns="${NS_SVG}" xmlns:xlink="http://www.w3.org/1999/xlink">` +
      '<a href="javascript:alert(1)"><text>x</text></a>' +
      '<a xlink:href="JaVaScRiPt:alert(2)"><text>y</text></a>' +
      '<a href="java&#x09;script:alert(3)"><text>z</text></a></svg>',
    );
    expect(pulito).not.toMatch(/javascript|alert/i);
    expect(testo(pulito)).toBe("xyz");
    expect(problemi(pulito)).toEqual([]);
  });

  it("script, animate e set (che possono riscrivere un href) spariscono", () => {
    const pulito = sanifica(
      `<svg xmlns="${NS_SVG}"><script>alert(1)</script><script href="data:,alert(2)"></script>` +
      '<a><animate attributeName="href" to="javascript:alert(3)"></animate><set attributeName="onmouseover" to="alert(4)"></set><text>x</text></a></svg>',
    );
    expect(pulito).not.toMatch(/<script|<animate|<set|alert|javascript/i);
    expect(problemi(pulito)).toEqual([]);
  });

  it("image, feImage e use (caricherebbero un URL esterno da soli) spariscono", () => {
    const pulito = sanifica(
      `<svg xmlns="${NS_SVG}"><image href="https://esempio.invalid/p.png"></image>` +
      '<filter id="f"><feImage href="https://esempio.invalid/f.png"></feImage></filter>' +
      '<use href="https://esempio.invalid/s.svg#a"></use></svg>',
    );
    expect(pulito).not.toMatch(/<image|<feimage|<use|esempio\.invalid/i);
    expect(pulito).toContain("<filter");
  });

  it("payload mXSS noti: anche riletto, l'HTML non ha niente di eseguibile", () => {
    const payload = [
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
      "<svg><style><img src=x onerror=alert(2)></style></svg>",
      "<math><mtext><table><mglyph><style><img src=x onerror=alert(3)>",
      '<svg><foreignObject><math><mi><mglyph><svg><mtext><textarea><a title="</textarea><img src=x onerror=alert(4)>">',
      "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(5)>",
      '<svg><foreignObject><p><style><!--</style><img src=x onerror=alert(6)>--></p></foreignObject></svg>',
    ];
    for (const p of payload) {
      const pulito = sanifica(p);
      expect(pulito, p).not.toMatch(/<img|<script/i);
      expect(problemi(pulito), p).toEqual([]);
      expect(problemi(sanifica(pulito)), p).toEqual([]);
    }
  });
});

describe("fallisce chiuso", () => {
  it("senza un DOM non restituisce l'SVG non sanificato: si ferma con un errore", () => {
    expect(() => creaSanificatoreSvg({} as never)).toThrow(/manca un DOM/);
    expect(() => creaSanificatoreSvg(globalThis as never)).toThrow(/manca un DOM/);
  });
});
