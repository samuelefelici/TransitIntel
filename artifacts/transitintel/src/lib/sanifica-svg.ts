/* Sanificazione dell'SVG dei diagrammi Mermaid di Argos.
 *
 * Il codice ```mermaid arriva dalla risposta del modello: è contenuto non
 * fidato, e il suo SVG finisce nel DOM come HTML grezzo. Mermaid in
 * securityLevel "strict" pulisce già l'SVG, ma con una configurazione sua,
 * interna e non esportata, che per esempio lascia passare <img src> nelle
 * etichette (una richiesta automatica verso un URL scelto dal modello). Qui c'è
 * il nostro controllo, esplicito e testato, fatto subito prima dell'inserimento:
 *  - profilo SVG di DOMPurify (svg + filtri): niente script, handler on*, URL
 *    javascript:;
 *  - foreignObject ammesso perché Mermaid ci mette le etichette HTML, ma dentro
 *    solo testo: i tag di TAG_TESTO_ETICHETTE restano, ogni altro elemento HTML
 *    diventa il suo testo (l'etichetta si legge ancora), quelli senza testo da
 *    mostrare (script, style, iframe…) spariscono con il contenuto, e un SVG o
 *    MathML aperto dentro un'etichetta si toglie;
 *  - niente <image> e <feImage>: caricherebbero da soli un URL esterno;
 *  - senza un DOM vero DOMPurify restituirebbe l'input così com'è: qui invece
 *    ci si ferma con un errore (fallisce chiuso).
 * La funzione riceve la finestra: nel browser è `window`, nei test una finestra
 * jsdom (l'ambiente dei test è node, senza DOM globale). */
import createDOMPurify, { type Config, type UponSanitizeElementHook, type WindowLike } from "dompurify";

const NS_HTML = "http://www.w3.org/1999/xhtml";

/** I tag HTML ammessi nelle etichette: quelli che Mermaid usa (div, span, p,
 *  br, strong) e la formattazione di testo che un'etichetta può avere. */
export const TAG_TESTO_ETICHETTE: readonly string[] = ["div", "span", "p", "br", "b", "strong", "i", "em"];
const TAG_TESTO = new Set(TAG_TESTO_ETICHETTE);

/** Elementi HTML senza testo da mostrare: via con tutto il contenuto, invece di
 *  diventare testo (il sorgente di uno script nell'etichetta non serve a nessuno). */
const SENZA_TESTO = new Set(["script", "style", "template", "textarea", "title", "noscript", "noembed", "noframes", "xmp", "iframe", "object", "embed"]);

const CONFIGURAZIONE: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // foreignObject non è nel profilo SVG: senza, le etichette dei nodi sparirebbero
  ADD_TAGS: ["foreignobject", ...TAG_TESTO_ETICHETTE],
  // ruolo ARIA che Mermaid mette sull'<svg> per l'accessibilità
  ADD_ATTR: ["role"],
  FORBID_TAGS: ["image", "feimage"],
  // dentro foreignObject si torna all'HTML (come fa il parser del browser)
  HTML_INTEGRATION_POINTS: { foreignobject: true },
};

/** Il <body> in cui DOMPurify ha letto l'SVG: la radice del giro, non
 *  contenuto. Non basta `document.body`: DOMPurify lo stacca durante il giro.
 *  Il parser HTML non crea altri <body>, quindi nome e posizione bastano. */
function radice(el: Element): boolean {
  return el.namespaceURI === NS_HTML && el.localName === "body"
    && (el.parentNode === null || el.parentNode === el.ownerDocument.documentElement);
}

/** Fuori dall'SVG e dentro le etichette solo testo. Le liste di DOMPurify non
 *  distinguono i namespace: senza questo controllo, col profilo SVG
 *  passerebbero anche <a>, <style> e <svg> annidati in un foreignObject. */
const soloTestoNelleEtichette: UponSanitizeElementHook = (nodo, evento) => {
  if (nodo.nodeType !== 1) return; // il testo è sempre ammesso
  const el = nodo as Element;
  if (radice(el)) return;
  if (el.namespaceURI === NS_HTML) {
    if (TAG_TESTO.has(evento.tagName)) return;
    // Staccare il nodo in un hook è previsto da DOMPurify: lo conta come rimosso.
    if (SENZA_TESTO.has(evento.tagName)) el.remove();
    else el.replaceWith(el.ownerDocument.createTextNode(el.textContent ?? ""));
    return;
  }
  // SVG o MathML aperti dentro HTML (cioè dentro un'etichetta): via.
  const genitore = el.parentElement;
  if (genitore && !radice(genitore) && genitore.namespaceURI === NS_HTML) el.remove();
};

/** Crea la funzione che sanifica l'SVG di Mermaid per la finestra data.
 *  Un'istanza di DOMPurify tutta sua: gli hook non toccano quella che usa
 *  Mermaid al suo interno. Lancia un errore se la finestra non ha un DOM
 *  utilizzabile, invece di lasciar passare l'SVG non sanificato. */
export function creaSanificatoreSvg(finestra: WindowLike): (svg: string) => string {
  const purify = createDOMPurify(finestra);
  if (!purify.isSupported) throw new Error("Sanificazione SVG non disponibile: manca un DOM");
  purify.addHook("uponSanitizeElement", soloTestoNelleEtichette);
  return (svg) => purify.sanitize(svg, CONFIGURAZIONE);
}
