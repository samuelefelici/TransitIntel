/**
 * Mermaid — rende un blocco ```mermaid come diagramma SVG.
 * mermaid è pesante: viene caricato in modo LAZY (dynamic import) solo quando
 * una risposta contiene davvero un diagramma. Il codice arriva dall'LLM, quindi
 * non è fidato: mermaid lavora in securityLevel 'strict' e poi l'SVG passa da
 * lib/sanifica-svg (DOMPurify, profilo SVG, etichette solo testo) prima di
 * entrare nel DOM. Se la sanificazione non è disponibile, si mostra il sorgente.
 */
import React from "react";
import type { Mermaid as MermaidApi } from "mermaid";

interface Motore {
  mermaid: MermaidApi;
  sanifica: (svg: string) => string;
}

let _motore: Promise<Motore> | null = null;
let _counter = 0;

function caricaMotore(): Promise<Motore> {
  if (!_motore) {
    // Anche la sanificazione è lazy: DOMPurify arriva insieme a mermaid.
    _motore = Promise.all([import("mermaid"), import("@/lib/sanifica-svg")]).then(([mod, { creaSanificatoreSvg }]) => {
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return { mermaid, sanifica: creaSanificatoreSvg(window) };
    });
  }
  return _motore;
}

export default function Mermaid({ code }: { code: string }) {
  const [svgPulito, setSvgPulito] = React.useState<string>("");
  const [err, setErr] = React.useState(false);
  const idRef = React.useRef(`argos-mmd-${++_counter}`);

  React.useEffect(() => {
    let cancelled = false;
    setErr(false);
    caricaMotore()
      .then(async ({ mermaid, sanifica }) => sanifica((await mermaid.render(idRef.current, code.trim())).svg))
      .then((pulito) => {
        if (cancelled) return;
        if (pulito) setSvgPulito(pulito);
        else setErr(true); // non è rimasto niente da mostrare: meglio il sorgente
      })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, [code]);

  if (err) {
    // Diagramma non valido: mostro il sorgente come fallback leggibile.
    return <pre className="text-[10px] overflow-x-auto bg-black/40 rounded p-2 my-2">{code}</pre>;
  }
  if (!svgPulito) {
    return <div className="my-2 text-[11px] text-zinc-400">rendo il diagramma…</div>;
  }
  return (
    <div
      className="my-2 rounded-xl border border-violet-400/20 bg-white/5 p-2 overflow-x-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svgPulito }} // scan-ok: HTML ammesso perché sanificato con DOMPurify (lib/sanifica-svg.ts) subito dopo mermaid.render
    />
  );
}
